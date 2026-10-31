import assert from "node:assert/strict";
import test from "node:test";
import { ClipSidecarClient, ClipSidecarError } from "../src/clip-sidecar-client.mjs";

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

test("构造函数拒绝非回环地址的 baseUrl", () => {
  assert.throws(() => new ClipSidecarClient({ baseUrl: "http://example.com:8791" }), ClipSidecarError);
  assert.doesNotThrow(() => new ClipSidecarClient({ baseUrl: "http://127.0.0.1:8791" }));
  assert.doesNotThrow(() => new ClipSidecarClient({ baseUrl: "http://localhost:8791" }));
});

test("embedPhoto 成功路径：把图片字节编码成 base64 发出去，拿到 embedding 数组", async () => {
  let capturedBody;
  const fetchImpl = async (url, init) => {
    assert.equal(url, "http://127.0.0.1:8791/v1/embed/photo");
    capturedBody = JSON.parse(init.body);
    return jsonResponse(200, { embedding: [0.1, 0.2, 0.3], dim: 3, ms: 12.3 });
  };
  const client = new ClipSidecarClient({ fetchImpl });
  const result = await client.embedPhoto(Buffer.from("fake-jpeg-bytes"));
  assert.deepEqual(result.embedding, [0.1, 0.2, 0.3]);
  assert.equal(capturedBody.imageBase64, Buffer.from("fake-jpeg-bytes").toString("base64"));
});

test("embedPhoto 对畸形响应(缺 embedding 字段)抛 clip_sidecar_response_invalid", async () => {
  const fetchImpl = async () => jsonResponse(200, { dim: 3 });
  const client = new ClipSidecarClient({ fetchImpl });
  await assert.rejects(client.embedPhoto(Buffer.from("x")), { code: "clip_sidecar_response_invalid" });
});

test("非 2xx 响应包装成 clip_sidecar_request_failed，带上 sidecar 的错误信息", async () => {
  const fetchImpl = async () => jsonResponse(500, { error: "sidecar_internal_error", message: "boom" });
  const client = new ClipSidecarClient({ fetchImpl });
  await assert.rejects(client.embedPhoto(Buffer.from("x")), (error) => {
    assert.equal(error.code, "clip_sidecar_request_failed");
    assert.match(error.message, /boom/);
    return true;
  });
});

test("网络层异常(fetch 直接抛)包装成 clip_sidecar_unreachable", async () => {
  const fetchImpl = async () => { throw new Error("ECONNREFUSED"); };
  const client = new ClipSidecarClient({ fetchImpl });
  await assert.rejects(client.embedPhoto(Buffer.from("x")), { code: "clip_sidecar_unreachable" });
});

test("超时会被 AbortController 打断，包装成 clip_sidecar_timeout", async () => {
  const fetchImpl = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    });
  });
  const client = new ClipSidecarClient({ fetchImpl, timeoutMs: 5 });
  await assert.rejects(client.embedPhoto(Buffer.from("x")), { code: "clip_sidecar_timeout" });
});

test("embedPanoCrops 把 yaws/fov/pitch/裁切尺寸原样带上，缺 embeddings/yaws 时报错", async () => {
  let capturedBody;
  const fetchImpl = async (url, init) => {
    assert.equal(url, "http://127.0.0.1:8791/v1/embed/pano-crops");
    capturedBody = JSON.parse(init.body);
    return jsonResponse(200, { embeddings: [[0, 1]], yaws: [0], dim: 2 });
  };
  const client = new ClipSidecarClient({ fetchImpl });
  const result = await client.embedPanoCrops(Buffer.from("pano"), { yaws: [0, 30], fov: 70, pitch: 0 });
  assert.equal(capturedBody.yaws.length, 2);
  assert.equal(capturedBody.fov, 70);
  assert.deepEqual(result.yaws, [0]);

  const badFetch = async () => jsonResponse(200, { dim: 2 });
  const badClient = new ClipSidecarClient({ fetchImpl: badFetch });
  await assert.rejects(badClient.embedPanoCrops(Buffer.from("pano")), { code: "clip_sidecar_response_invalid" });
});

test("healthz 包装非 2xx 为 clip_sidecar_unhealthy", async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const client = new ClipSidecarClient({ fetchImpl });
  await assert.rejects(client.healthz(), { code: "clip_sidecar_unhealthy" });
});
