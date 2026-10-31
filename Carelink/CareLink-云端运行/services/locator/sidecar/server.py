#!/usr/bin/env python3
"""
services/locator/sidecar/server.py -- CLIP 定位推理 sidecar：loopback-only 的 HTTP JSON 服务，
只做一件事：给图片算 CLIP embedding。equirect->perspective 切图、余弦相似度、网格峰值、阈值判定
一律留在 Node 侧 (services/locator/src/*.mjs)，这里不掺业务逻辑，方便独立测/独立重启/独立换模型。

移植来源：/Users/max/code/spatial-memory (黑客松仓库) 的 tools/slice.py + server/space.py。
算法与模型选型对齐旧仓库：
  - 模型 clip-ViT-B-32 (sentence-transformers 包装的 openai/clip-vit-base-patch32 权重)
  - equirect->perspective 投影函数与旧仓库 tools/slice.py::equirect_to_perspective 逐行一致
  - 切图参数 FOV=70°、输出 800x600、yaw 每 30° 一张（12 张/节点），与旧仓库同款

⚠️ 模型权重不进 git：下载目录由 HF_HOME / SENTENCE_TRANSFORMERS_HOME 环境变量控制，
   本机约定放在 ~/code/unseen-assets/models/（见启动脚本），不要让它落进默认的
   ~/.cache 或者仓库目录。

⚠️ 单线程 serial 处理：CLIP 编码在 CPU 上跑，2C2G 的生产机只有 2 个核心，并发对它没有增益，
   反而会把内存和 CPU 都挤爆。用标准库 http.server.HTTPServer（非 Threading 版）天然串行，
   不需要额外加锁 —— 这点思路和旧仓库 server/space.py 的 clip_encode() 加锁串行是同一个理由
   (MPS/CPU 后端在高并发下都不值得冒险)。

用法：
    .venv/bin/python server.py --port 8791 --host 127.0.0.1

依赖 (requirements.txt)：torch(cpu) + sentence-transformers + pillow + numpy，装在独立 venv 里，
不碰系统 Python。
"""
import argparse
import base64
import io
import json
import math
import sys
import time
import traceback
from http.server import BaseHTTPRequestHandler, HTTPServer

import numpy as np
from PIL import Image

MODEL_ID = "clip-ViT-B-32"
MAX_BODY_BYTES = 32 * 1024 * 1024  # 单张全景直传上限对齐 space.py 的 PANO_MAX_SIZE

_model = None
_model_load_seconds = None


def log(payload):
    sys.stderr.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stderr.flush()


def load_model():
    """懒加载，只加载一次；显式 device='cpu'，不管这台机器有没有 MPS/CUDA 都强制走 CPU 路径 --
    这是为了让本机实测的耗时/内存数字能诚实地代表 2C2G 生产机（没有 GPU）。"""
    global _model, _model_load_seconds
    if _model is not None:
        return _model
    import torch
    torch.set_num_threads(max(1, int(__import__("os").environ.get("UNSEEN_CLIP_TORCH_THREADS", "2"))))
    from sentence_transformers import SentenceTransformer
    t0 = time.time()
    _model = SentenceTransformer(MODEL_ID, device="cpu")
    _model_load_seconds = time.time() - t0
    log({"event": "model_loaded", "modelId": MODEL_ID, "seconds": round(_model_load_seconds, 2)})
    return _model


# ---------------------------------------------------------------- 投影数学（与旧仓库逐行一致）
def equirect_to_perspective(equirect_np, fov_deg, yaw_deg, pitch_deg, out_w, out_h):
    eh, ew = equirect_np.shape[:2]
    fov = math.radians(fov_deg)
    theta = math.radians(yaw_deg)
    phi = math.radians(pitch_deg)

    aspect = out_h / out_w
    w_len = math.tan(fov / 2.0)
    h_len = w_len * aspect

    xs = (2 * (np.arange(out_w) + 0.5) / out_w - 1) * w_len
    ys = (1 - 2 * (np.arange(out_h) + 0.5) / out_h) * h_len
    xv, yv = np.meshgrid(xs, ys)
    zv = np.ones_like(xv)

    norm = np.sqrt(xv ** 2 + yv ** 2 + zv ** 2)
    xv, yv, zv = xv / norm, yv / norm, zv / norm

    y1 = yv * math.cos(phi) + zv * math.sin(phi)
    z1 = -yv * math.sin(phi) + zv * math.cos(phi)
    x1 = xv

    x2 = x1 * math.cos(theta) + z1 * math.sin(theta)
    z2 = -x1 * math.sin(theta) + z1 * math.cos(theta)
    y2 = y1

    lon = np.arctan2(x2, z2)
    lat = np.arcsin(np.clip(y2, -1.0, 1.0))

    src_x = (lon / (2 * math.pi)) * ew
    src_y = (0.5 - lat / math.pi) * eh

    src_x = np.mod(src_x, ew).astype(np.int32)
    src_y = np.clip(src_y, 0, eh - 1).astype(np.int32)

    return equirect_np[src_y, src_x]


def decode_image(image_base64):
    raw = base64.b64decode(image_base64, validate=True)
    if len(raw) > MAX_BODY_BYTES:
        raise ValueError("image_too_large")
    return Image.open(io.BytesIO(raw)).convert("RGB")


def embed_photo(model, image_base64):
    img = decode_image(image_base64)
    t0 = time.time()
    emb = model.encode([img], convert_to_numpy=True, normalize_embeddings=True, device="cpu")[0]
    return {"embedding": emb.tolist(), "dim": int(emb.shape[0]), "ms": round((time.time() - t0) * 1000, 1)}


def embed_pano_crops(model, image_base64, yaws, fov, pitch, crop_w, crop_h):
    img = decode_image(image_base64)
    pano_np = np.asarray(img)
    t0 = time.time()
    crops = [
        Image.fromarray(equirect_to_perspective(pano_np, fov_deg=fov, yaw_deg=yaw, pitch_deg=pitch,
                                                 out_w=crop_w, out_h=crop_h))
        for yaw in yaws
    ]
    slice_ms = (time.time() - t0) * 1000
    t0 = time.time()
    # batch_size 故意不用 len(crops)：12 张一次性入模型在 2C2G 机器上会把峰值内存推到
    # ~850MB(本机实测)，全景重建不常发生(每个 panorama revision 只算一次、算完缓存),
    # 用更小的 batch 换取更低的内存峰值划算。
    embs = model.encode(crops, batch_size=4, convert_to_numpy=True,
                         normalize_embeddings=True, device="cpu")
    embed_ms = (time.time() - t0) * 1000
    return {"embeddings": embs.tolist(), "yaws": list(yaws), "dim": int(embs.shape[1]),
            "sliceMs": round(slice_ms, 1), "embedMs": round(embed_ms, 1)}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "unseen-clip-sidecar/1"

    def log_message(self, fmt, *args):
        pass  # 访问日志交给 Node 侧的 job worker 记；这里保持安静，避免刷屏

    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_BODY_BYTES * 2:
            raise ValueError("content_length_invalid")
        raw = self.rfile.read(length)
        return json.loads(raw)

    def do_GET(self):
        if self.path == "/healthz":
            self._send_json(200, {"ok": True, "modelId": MODEL_ID, "modelLoaded": _model is not None,
                                   "modelLoadSeconds": _model_load_seconds, "device": "cpu"})
            return
        self._send_json(404, {"error": "not_found"})

    def do_POST(self):
        try:
            if self.path == "/v1/embed/photo":
                body = self._read_json_body()
                model = load_model()
                result = embed_photo(model, body["imageBase64"])
                self._send_json(200, result)
                return
            if self.path == "/v1/embed/pano-crops":
                body = self._read_json_body()
                model = load_model()
                result = embed_pano_crops(
                    model, body["imageBase64"], body.get("yaws") or list(range(0, 360, 30)),
                    float(body.get("fov", 70)), float(body.get("pitch", 0)),
                    int(body.get("cropWidth", 800)), int(body.get("cropHeight", 600)),
                )
                self._send_json(200, result)
                return
            self._send_json(404, {"error": "not_found"})
        except (KeyError, ValueError, json.JSONDecodeError) as error:
            self._send_json(400, {"error": "bad_request", "message": str(error)})
        except Exception as error:  # noqa: BLE001 -- sidecar 必须把任何炸掉的原因如实回给调用方
            log({"event": "request_failed", "path": self.path, "error": str(error),
                 "traceback": traceback.format_exc()})
            self._send_json(500, {"error": "sidecar_internal_error", "message": str(error)})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8791)
    parser.add_argument("--preload", action="store_true", help="启动时就加载模型，不等第一个请求")
    args = parser.parse_args()

    if args.host not in ("127.0.0.1", "localhost"):
        raise SystemExit("sidecar 只允许绑定回环地址 (127.0.0.1/localhost)，不对外监听")

    if args.preload:
        load_model()

    server = HTTPServer((args.host, args.port), Handler)
    log({"event": "sidecar_ready", "host": args.host, "port": args.port, "modelId": MODEL_ID})
    print(json.dumps({"status": "UNSEEN_CLIP_SIDECAR_READY", "host": args.host, "port": args.port}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
