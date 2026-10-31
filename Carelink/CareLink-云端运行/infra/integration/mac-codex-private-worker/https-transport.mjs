import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdtemp, open, readFile, rm } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { checkServerIdentity } from "node:tls";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{32,256}$/u;

export class PrivateWorkerTransportError extends Error {
  constructor(code, { retryable = false, status = null } = {}) {
    super(code);
    this.name = "PrivateWorkerTransportError";
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

function digest(bytes, encoding = "hex") {
  return createHash("sha256").update(bytes).digest(encoding);
}

function exactUrl(origin, expectedHostname, endpoint) {
  if (typeof endpoint !== "string" || !endpoint.startsWith("/") || endpoint.startsWith("//") ||
    endpoint.includes("#")) throw new PrivateWorkerTransportError("transport_endpoint_invalid");
  const url = new URL(endpoint, origin);
  if (url.origin !== origin || url.protocol !== "https:" || url.hostname !== expectedHostname ||
    url.username || url.password || url.hash) {
    throw new PrivateWorkerTransportError("transport_origin_rejected");
  }
  return url;
}

async function checkedFile(filePath, { maximumBytes, expectedUid, allowedModes, integrityOnly = false }) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath) || path.resolve(filePath) !== filePath) {
    throw new PrivateWorkerTransportError("private_file_invalid");
  }
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    const mode = before.mode & 0o777;
    if (!before.isFile() || before.size < 1 || before.size > maximumBytes ||
      integrityOnly && ![0, expectedUid].includes(before.uid) ||
      !integrityOnly && before.uid !== expectedUid ||
      !allowedModes.includes(mode)) throw new PrivateWorkerTransportError("private_file_invalid");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new PrivateWorkerTransportError("private_file_changed");
    }
    return bytes;
  } catch (error) {
    if (error instanceof PrivateWorkerTransportError) throw error;
    throw new PrivateWorkerTransportError("private_file_invalid");
  } finally { await handle?.close(); }
}

export async function loadPrivateWorkerToken(tokenPath, expectedUid = process.getuid?.()) {
  if (!Number.isSafeInteger(expectedUid) || expectedUid < 0) {
    throw new PrivateWorkerTransportError("private_token_configuration_invalid");
  }
  const bytes = await checkedFile(tokenPath, { maximumBytes: 256, expectedUid, allowedModes: [0o400, 0o600] });
  const token = bytes.toString("utf8");
  bytes.fill(0);
  if (!TOKEN_PATTERN.test(token)) throw new PrivateWorkerTransportError("private_token_invalid");
  return token;
}

function imageDimensions(bytes, maximumPixels) {
  let mime;
  let width;
  let height;
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE) && bytes.subarray(12, 16).toString("ascii") === "IHDR") {
    mime = "image/png";
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    mime = "image/jpeg";
    for (let offset = 2; offset + 8 < bytes.length;) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      if (marker === 0xd8 || marker === 0xd9 || marker >= 0xd0 && marker <= 0xd7) {
        offset += 2;
        continue;
      }
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + length + 2 > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        height = bytes.readUInt16BE(offset + 5);
        width = bytes.readUInt16BE(offset + 7);
        break;
      }
      if (marker === 0xda) break;
      offset += length + 2;
    }
  }
  if (!mime || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
    width > 65_535 || height > 65_535 || width * height > maximumPixels) {
    throw new PrivateWorkerTransportError("transport_image_invalid");
  }
  return { mime, width, height };
}

async function eraseTemporaryFile(filePath) {
  let handle;
  try {
    handle = await open(filePath, constants.O_WRONLY | constants.O_NOFOLLOW);
    await handle.truncate(0);
    await handle.sync();
  } catch { /* deletion still runs */ }
  finally { await handle?.close(); }
}

export async function withPrivateDownloadedImage({ bytes, contentType, expectedSha256, maximumBytes,
  maximumPixels }, operation) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12 || bytes.length > maximumBytes ||
    !["image/jpeg", "image/png"].includes(contentType) ||
    typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(expectedSha256) ||
    digest(bytes) !== expectedSha256 || typeof operation !== "function") {
    throw new PrivateWorkerTransportError("transport_image_invalid");
  }
  const dimensions = imageDimensions(bytes, maximumPixels);
  if (dimensions.mime !== contentType) throw new PrivateWorkerTransportError("transport_image_invalid");
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "unseen-private-pull-"));
  await chmod(temporaryRoot, 0o700);
  const imagePath = path.join(temporaryRoot, contentType === "image/png" ? "source.png" : "source.jpg");
  let handle;
  try {
    handle = await open(imagePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY |
      constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(imagePath, 0o600);
    return await operation(Object.freeze({ imagePath, ...dimensions, sha256: expectedSha256 }));
  } finally {
    await handle?.close();
    await eraseTemporaryFile(imagePath);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export class ExactHttpsClient {
  constructor({ origin, expectedHostname, tokenPath, tokenUid = process.getuid?.(), timeoutMs = 15_000,
    maximumJsonBytes = 128 * 1024, tlsPolicy = { mode: "system-ca" } } = {}) {
    let parsed;
    try { parsed = new URL(origin); } catch { throw new PrivateWorkerTransportError("transport_configuration_invalid"); }
    const tlsKeys = tlsPolicy && typeof tlsPolicy === "object" && !Array.isArray(tlsPolicy) ?
      Object.keys(tlsPolicy).sort().join("\0") : "";
    const allowedTlsKeys = tlsPolicy?.mode === "ca-file" ?
      (tlsPolicy?.spkiSha256 ? "caFile\0mode\0spkiSha256" : "caFile\0mode") :
      (tlsPolicy?.spkiSha256 ? "mode\0spkiSha256" : "mode");
    if (parsed.protocol !== "https:" || parsed.origin !== origin || parsed.pathname !== "/" || parsed.search ||
      parsed.hash || parsed.username || parsed.password || parsed.hostname !== expectedHostname ||
      typeof tokenPath !== "string" || !path.isAbsolute(tokenPath) || !Number.isSafeInteger(tokenUid) || tokenUid < 0 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000 ||
      !Number.isSafeInteger(maximumJsonBytes) || maximumJsonBytes < 1 || maximumJsonBytes > 1024 * 1024 ||
      !["system-ca", "ca-file"].includes(tlsPolicy?.mode) || tlsKeys !== allowedTlsKeys ||
      tlsPolicy.mode === "ca-file" && (typeof tlsPolicy.caFile !== "string" || !path.isAbsolute(tlsPolicy.caFile)) ||
      tlsPolicy.spkiSha256 && !/^[A-Za-z0-9+/]{43}=$/u.test(tlsPolicy.spkiSha256)) {
      throw new PrivateWorkerTransportError("transport_configuration_invalid");
    }
    this.origin = origin;
    this.expectedHostname = expectedHostname;
    this.tokenPath = tokenPath;
    this.tokenUid = tokenUid;
    this.timeoutMs = timeoutMs;
    this.maximumJsonBytes = maximumJsonBytes;
    this.tlsPolicy = Object.freeze({ ...tlsPolicy });
  }

  async request(endpoint, { method = "GET", body, idempotencyKey, signal = new AbortController().signal,
    maximumBytes = this.maximumJsonBytes, accept = "application/json", headers: extraHeaders = {} } = {}) {
    const extraKeys = extraHeaders && typeof extraHeaders === "object" && !Array.isArray(extraHeaders) ?
      Object.keys(extraHeaders).sort() : [];
    if (!new Set(["GET", "POST"]).has(method) || body !== undefined && method !== "POST" ||
      idempotencyKey !== undefined && (typeof idempotencyKey !== "string" ||
        !/^[A-Za-z0-9._~-]{16,256}$/u.test(idempotencyKey)) ||
      !signal || typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function" ||
      !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 20 * 1024 * 1024 ||
      !["application/json", "image/jpeg, image/png"].includes(accept) ||
      extraKeys.some((key) => !["x-unseen-ai-lease", "x-unseen-protocol"].includes(key)) ||
      extraKeys.some((key) => typeof extraHeaders[key] !== "string" || extraHeaders[key].length < 1 ||
        extraHeaders[key].length > 128 || /[\r\n]/u.test(extraHeaders[key]))) {
      throw new PrivateWorkerTransportError("transport_request_invalid");
    }
    const url = exactUrl(this.origin, this.expectedHostname, endpoint);
    const [token, ca] = await Promise.all([
      loadPrivateWorkerToken(this.tokenPath, this.tokenUid),
      this.tlsPolicy.mode === "ca-file" ? checkedFile(this.tlsPolicy.caFile,
        { maximumBytes: 256 * 1024, expectedUid: this.tokenUid, allowedModes: [0o400, 0o444, 0o600, 0o644],
          integrityOnly: true }) : null
    ]);
    const requestBody = body === undefined ? null : Buffer.from(JSON.stringify(body));
    if (requestBody?.length > this.maximumJsonBytes) {
      throw new PrivateWorkerTransportError("transport_request_too_large");
    }
    const headers = { accept, authorization: `Bearer ${token}`, "cache-control": "no-store",
      "user-agent": "UNSEEN-private-codex-worker/1", ...extraHeaders };
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    if (requestBody) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(requestBody.length);
    }
    const options = { method, headers, agent: false, servername: this.expectedHostname, rejectUnauthorized: true,
      ca: ca ?? undefined,
      checkServerIdentity: (host, certificate) => {
        const defaultError = checkServerIdentity(host, certificate);
        if (defaultError) return defaultError;
        if (this.tlsPolicy.spkiSha256 && (!Buffer.isBuffer(certificate.pubkey) ||
          digest(certificate.pubkey, "base64") !== this.tlsPolicy.spkiSha256)) {
          return new Error("transport_tls_pin_rejected");
        }
        return undefined;
      } };
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        error ? reject(error) : resolve(value);
      };
      const request = https.request(url, options, (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.resume();
          finish(new PrivateWorkerTransportError("transport_redirect_rejected"));
          return;
        }
        if (status === 401 || status === 403) {
          response.resume();
          finish(new PrivateWorkerTransportError("transport_auth_rejected", { status }));
          return;
        }
        if (status === 409) {
          response.resume();
          finish(new PrivateWorkerTransportError("transport_lease_conflict", { status }));
          return;
        }
        if (status === 413) {
          response.resume();
          finish(new PrivateWorkerTransportError("transport_payload_rejected", { status }));
          return;
        }
        if (status === 408 || status === 425 || status === 429 || status >= 500) {
          response.resume();
          finish(new PrivateWorkerTransportError("transport_unavailable", { retryable: true, status }));
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          finish(new PrivateWorkerTransportError("transport_protocol_rejected", { status }));
          return;
        }
        const declared = Number(response.headers["content-length"] ?? 0);
        if (declared && (!Number.isSafeInteger(declared) || declared > maximumBytes)) {
          response.destroy();
          finish(new PrivateWorkerTransportError("transport_response_too_large"));
          return;
        }
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > maximumBytes) {
            finish(new PrivateWorkerTransportError("transport_response_too_large"));
            response.destroy();
          }
          else chunks.push(chunk);
        });
        response.once("end", () => finish(null, Object.freeze({ status, headers: response.headers,
          bytes: Buffer.concat(chunks) })));
        response.once("error", (error) => finish(new PrivateWorkerTransportError(
          error.message === "response_too_large" ? "transport_response_too_large" : "transport_unavailable",
          { retryable: error.message !== "response_too_large" })));
      });
      const abort = () => request.destroy(new Error("request_aborted"));
      signal.addEventListener("abort", abort, { once: true });
      request.setTimeout(this.timeoutMs, () => request.destroy(new Error("request_timeout")));
      request.once("error", (error) => finish(new PrivateWorkerTransportError(
        error.message === "request_aborted" ? "transport_aborted" : "transport_unavailable",
        { retryable: error.message !== "request_aborted" })));
      if (signal.aborted) abort();
      if (requestBody) request.end(requestBody);
      else request.end();
    });
  }

  async requestJson(endpoint, options = {}) {
    const response = await this.request(endpoint, { ...options, accept: "application/json" });
    const contentType = String(response.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json") throw new PrivateWorkerTransportError("transport_content_type_rejected");
    let value;
    try { value = JSON.parse(response.bytes.toString("utf8")); }
    catch { throw new PrivateWorkerTransportError("transport_json_invalid"); }
    return Object.freeze({ status: response.status, headers: response.headers, value });
  }
}
