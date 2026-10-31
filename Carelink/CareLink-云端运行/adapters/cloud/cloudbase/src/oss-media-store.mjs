import { createHash, createHmac } from "node:crypto";
import { ApiError, assert } from "../../../../services/api/src/errors.mjs";

const PRECONDITION = Symbol("oss_precondition");
const SHA256 = /^[a-f0-9]{64}$/;
const OSS_REQUEST_ID = /^[A-F0-9]{16,64}$/;

function safeKey(key) {
  assert(typeof key === "string" && key.length > 0 && key.length <= 1024 &&
    key.split("/").every((part) => /^[A-Za-z0-9._-]+$/.test(part) && part !== "." && part !== ".."),
  "media_object_key_invalid", 500);
  return key;
}

function safeContentType(value) {
  assert(typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\r\n]/.test(value),
    "media_store_unavailable", 503);
  return value;
}

function encodeKey(key) {
  return safeKey(key).split("/").map(encodeURIComponent).join("/");
}

export function canonicalOssHeaders(headers) {
  return Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), String(value).trim().replace(/\s+/g, " ")])
    .filter(([name]) => name.startsWith("x-oss-"))
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, value]) => `${name}:${value}\n`)
    .join("");
}

function validatedMaxBytes(value) {
  assert(Number.isSafeInteger(value) && value > 0, "object_too_large", 413);
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function responseDetails(response) {
  const requestId = response.headers.get("x-oss-request-id") ?? "";
  return {
    status: response.status,
    ...(OSS_REQUEST_ID.test(requestId) ? { requestId } : {})
  };
}

export class OssMediaStore {
  constructor({ endpoint, bucket, accessKeyId, accessKeySecret, securityToken = "", fetchImpl = globalThis.fetch,
    maxRetries = 2, retryDelayMs = 25, sleep = (milliseconds) => new Promise((resolve) =>
      setTimeout(resolve, milliseconds)), clock = () => new Date() } = {}) {
    let parsed;
    try { parsed = new URL(endpoint); } catch { /* rejected below */ }
    assert(parsed?.protocol === "https:" && parsed.username === "" && parsed.password === "" &&
      parsed.pathname === "/" && parsed.search === "" && parsed.hash === "", "media_store_unavailable", 503);
    assert(typeof bucket === "string" && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket),
      "media_store_unavailable", 503);
    assert(typeof accessKeyId === "string" && accessKeyId.length > 0 &&
      typeof accessKeySecret === "string" && accessKeySecret.length > 0 &&
      typeof securityToken === "string" && typeof fetchImpl === "function" && typeof sleep === "function" &&
      typeof clock === "function" && Number.isSafeInteger(maxRetries) && maxRetries >= 0 && maxRetries <= 5 &&
      Number.isSafeInteger(retryDelayMs) && retryDelayMs >= 0 && retryDelayMs <= 5_000,
    "media_store_unavailable", 503);
    this.bucket = bucket;
    this.origin = `https://${bucket}.${parsed.host}`;
    this.accessKeyId = accessKeyId;
    this.accessKeySecret = accessKeySecret;
    this.securityToken = securityToken;
    this.fetchImpl = fetchImpl;
    this.maxRetries = maxRetries;
    this.retryDelayMs = retryDelayMs;
    this.sleep = sleep;
    this.clock = clock;
    this.networkRequests = 0;
    this.durable = true;
  }

  urlFor(key) {
    return `${this.origin}/${encodeKey(key)}`;
  }

  authorization(method, key, headers) {
    const resource = `/${this.bucket}/${safeKey(key)}`;
    const stringToSign = [method, headers["content-md5"] ?? "", headers["content-type"] ?? "",
      headers.date, `${canonicalOssHeaders(headers)}${resource}`].join("\n");
    const signature = createHmac("sha1", this.accessKeySecret).update(stringToSign).digest("base64");
    return `OSS ${this.accessKeyId}:${signature}`;
  }

  async request(method, key, { body, headers: inputHeaders = {}, allow404 = false,
    allowPrecondition = false } = {}) {
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const now = this.clock();
      assert(now instanceof Date && Number.isFinite(now.valueOf()), "media_store_unavailable", 503);
      const headers = { ...inputHeaders, date: now.toUTCString() };
      if (this.securityToken) headers["x-oss-security-token"] = this.securityToken;
      headers.authorization = this.authorization(method, key, headers);
      let response;
      const requestedUrl = this.urlFor(key);
      try {
        this.networkRequests += 1;
        response = await this.fetchImpl(requestedUrl, { method, headers, body, redirect: "manual" });
      } catch {
        if (attempt < this.maxRetries) {
          await this.sleep(this.retryDelayMs * (2 ** attempt));
          continue;
        }
        throw new ApiError("media_store_unavailable", 503);
      }
      assert(response?.redirected === false && response.url === requestedUrl,
        "media_store_unavailable", 503);
      assert(response.status < 300 || response.status >= 400, "media_store_unavailable", 503);
      if (response?.ok) return response;
      assert(response && Number.isSafeInteger(response.status), "media_store_unavailable", 503);
      if (allow404 && response.status === 404) return null;
      if (allowPrecondition && [409, 412].includes(response.status)) return PRECONDITION;
      if (response.status >= 500 && response.status <= 599 && attempt < this.maxRetries) {
        await this.sleep(this.retryDelayMs * (2 ** attempt));
        continue;
      }
      throw new ApiError("media_store_unavailable", 503, responseDetails(response));
    }
    throw new ApiError("media_store_unavailable", 503);
  }

  metadata(response) {
    const contentLength = response.headers.get("content-length") ?? "";
    const storedBytes = response.headers.get("x-oss-meta-unseen-bytes") ?? "";
    const contentHash = response.headers.get("x-oss-meta-unseen-sha256") ?? "";
    const contentType = response.headers.get("content-type") ?? "";
    assert(/^(0|[1-9]\d*)$/.test(contentLength) && /^(0|[1-9]\d*)$/.test(storedBytes) &&
      Number(contentLength) === Number(storedBytes) && SHA256.test(contentHash) &&
      typeof contentType === "string" && contentType.length > 0 && contentType.length <= 200 &&
      !/[\r\n]/.test(contentType), "media_object_corrupt", 503);
    return { exists: true, bytes: Number(contentLength), contentType, etag: contentHash,
      updatedAt: response.headers.get("last-modified") ?? undefined };
  }

  async putIfAbsent(key, bytes, { contentType = "application/octet-stream", maxBytes } = {}) {
    const body = Buffer.from(bytes);
    if (maxBytes !== undefined) maxBytes = validatedMaxBytes(maxBytes);
    assert(maxBytes === undefined || body.length <= maxBytes, "object_too_large", 413);
    safeKey(key);
    safeContentType(contentType);
    const digest = sha256(body);
    const response = await this.request("PUT", key, {
      body,
      allowPrecondition: true,
      headers: {
        "content-md5": createHash("md5").update(body).digest("base64"),
        "content-type": contentType,
        "x-oss-forbid-overwrite": "true",
        "x-oss-object-acl": "private",
        "x-oss-meta-unseen-bytes": String(body.length),
        "x-oss-meta-unseen-sha256": digest
      }
    });
    const stored = await this.head(key);
    assert(stored.exists, "media_store_unavailable", 503);
    if (response === PRECONDITION) return { created: false, ...stored };
    assert(stored.bytes === body.length && stored.contentType === contentType && stored.etag === digest,
      "media_object_corrupt", 503);
    return { created: true, ...stored };
  }

  async head(key) {
    const response = await this.request("HEAD", key, { allow404: true });
    return response ? this.metadata(response) : { exists: false };
  }

  async get(key, { maxBytes } = {}) {
    if (maxBytes !== undefined) maxBytes = validatedMaxBytes(maxBytes);
    const response = await this.request("GET", key, { allow404: true });
    if (!response) throw new ApiError("object_missing", 409);
    const metadata = this.metadata(response);
    assert(maxBytes === undefined || metadata.bytes <= maxBytes, "object_too_large", 413);
    let body;
    try { body = Buffer.from(await response.arrayBuffer()); }
    catch { throw new ApiError("media_store_unavailable", 503); }
    assert(body.length === metadata.bytes && sha256(body) === metadata.etag, "media_object_corrupt", 503);
    return { body, contentType: metadata.contentType, etag: metadata.etag, updatedAt: metadata.updatedAt };
  }

  async delete(key) {
    await this.request("DELETE", key, { allow404: true });
  }
}
