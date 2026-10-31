// services/locator/src/crop-bank-cache.mjs
//
// 每个 panorama revision 的 12 张裁切 embedding 只用算一次（全景不会变，变了就是新 revision /
// 新 id）。内存缓存 + 落盘缓存两层，重启 worker 不用重新调 sidecar 切一遍全景。
// 落盘格式故意用 JSON（12 x 512 float ≈ 25KB，体积小，没必要上 npz 那套二进制格式）。

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export class CropBankCache {
  constructor({ sidecarClient, cacheDir, yaws, fov = 70, pitch = 0, cropWidth = 800, cropHeight = 600 }) {
    this.sidecarClient = sidecarClient;
    this.cacheDir = cacheDir;
    this.yaws = yaws ?? Array.from({ length: 12 }, (_, i) => i * 30);
    this.fov = fov;
    this.pitch = pitch;
    this.cropWidth = cropWidth;
    this.cropHeight = cropHeight;
    this.memory = new Map(); // panoramaRevisionId -> { embeddings, yaws }
  }

  _diskPath(panoramaRevisionId) {
    const digest = createHash("sha256").update(panoramaRevisionId).digest("hex");
    return path.join(this.cacheDir, `${digest}.json`);
  }

  /** panoramaBytes 只在缓存未命中时才会被用到（调用方可以传一个惰性 getter 避免白读大文件）。 */
  async get(panoramaRevisionId, getPanoramaBytes) {
    const hit = this.memory.get(panoramaRevisionId);
    if (hit) return hit;

    const diskFile = this._diskPath(panoramaRevisionId);
    try {
      const raw = JSON.parse(await readFile(diskFile, "utf8"));
      if (raw?.panoramaRevisionId === panoramaRevisionId && Array.isArray(raw.embeddings) &&
        Array.isArray(raw.yaws) && raw.embeddings.length === raw.yaws.length) {
        this.memory.set(panoramaRevisionId, { embeddings: raw.embeddings, yaws: raw.yaws });
        return this.memory.get(panoramaRevisionId);
      }
    } catch { /* 没有缓存或缓存损坏，都走下面重新算 */ }

    const panoramaBytes = await getPanoramaBytes();
    const result = await this.sidecarClient.embedPanoCrops(panoramaBytes, {
      yaws: this.yaws, fov: this.fov, pitch: this.pitch, cropWidth: this.cropWidth, cropHeight: this.cropHeight
    });
    const bank = { embeddings: result.embeddings, yaws: result.yaws };
    this.memory.set(panoramaRevisionId, bank);
    await this._persist(panoramaRevisionId, bank);
    return bank;
  }

  async _persist(panoramaRevisionId, bank) {
    try {
      await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
      const file = this._diskPath(panoramaRevisionId);
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify({ panoramaRevisionId, ...bank }), { mode: 0o600 });
      await rename(temp, file);
    } catch {
      // 落盘失败不致命：内存缓存还在，这个进程活着的时候照样能用，只是重启会重新算一次。
    }
  }

  drop(panoramaRevisionId) {
    this.memory.delete(panoramaRevisionId);
  }
}
