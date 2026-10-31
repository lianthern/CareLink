// services/locator/src/clip-sidecar-client.mjs
//
// Node 侧到 Python CLIP sidecar (services/locator/sidecar/server.py) 的瘦客户端：只做
// HTTP 往返 + 超时 + 把 sidecar 的错误包装成携带 code 的 Error，不掺任何业务判定。
// sidecar 只监听回环地址，见 server.py 的 --host 限制。

export class ClipSidecarError extends Error {
  constructor(code, message, cause) {
    super(message ?? code);
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

export class ClipSidecarClient {
  constructor({ baseUrl = "http://127.0.0.1:8791", timeoutMs = 10_000, fetchImpl = fetch } = {}) {
    if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(baseUrl)) {
      throw new ClipSidecarError("clip_sidecar_base_url_invalid", `sidecar base URL 必须是回环地址: ${baseUrl}`);
    }
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async _postJson(path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (error) {
      if (error?.name === "AbortError") throw new ClipSidecarError("clip_sidecar_timeout", `sidecar 超时(${this.timeoutMs}ms): ${path}`, error);
      throw new ClipSidecarError("clip_sidecar_unreachable", `sidecar 连不上: ${path}`, error);
    } finally {
      clearTimeout(timer);
    }
    let parsed;
    const text = await response.text();
    try { parsed = text ? JSON.parse(text) : {}; }
    catch (error) { throw new ClipSidecarError("clip_sidecar_response_invalid", `sidecar 返回不是合法 JSON: ${path}`, error); }
    if (!response.ok) {
      throw new ClipSidecarError("clip_sidecar_request_failed",
        `sidecar 返回 ${response.status}: ${parsed?.message ?? parsed?.error ?? text}`);
    }
    return parsed;
  }

  async healthz() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/healthz`, { signal: controller.signal });
      if (!response.ok) throw new ClipSidecarError("clip_sidecar_unhealthy", `healthz 返回 ${response.status}`);
      return await response.json();
    } catch (error) {
      if (error instanceof ClipSidecarError) throw error;
      throw new ClipSidecarError("clip_sidecar_unreachable", "healthz 连不上", error);
    } finally {
      clearTimeout(timer);
    }
  }

  /** imageBytes: Buffer/Uint8Array。返回 { embedding: number[512] } */
  async embedPhoto(imageBytes) {
    const imageBase64 = Buffer.from(imageBytes).toString("base64");
    const result = await this._postJson("/v1/embed/photo", { imageBase64 });
    if (!Array.isArray(result.embedding) || result.embedding.length === 0) {
      throw new ClipSidecarError("clip_sidecar_response_invalid", "embed/photo 缺少 embedding 字段");
    }
    return result;
  }

  /** panoramaBytes: Buffer/Uint8Array。返回 { embeddings: number[][], yaws: number[] } */
  async embedPanoCrops(panoramaBytes, { yaws, fov = 70, pitch = 0, cropWidth = 800, cropHeight = 600 } = {}) {
    const imageBase64 = Buffer.from(panoramaBytes).toString("base64");
    const result = await this._postJson("/v1/embed/pano-crops",
      { imageBase64, yaws: yaws ?? Array.from({ length: 12 }, (_, i) => i * 30), fov, pitch, cropWidth, cropHeight });
    if (!Array.isArray(result.embeddings) || result.embeddings.length === 0 || !Array.isArray(result.yaws)) {
      throw new ClipSidecarError("clip_sidecar_response_invalid", "embed/pano-crops 缺少 embeddings/yaws 字段");
    }
    return result;
  }
}
