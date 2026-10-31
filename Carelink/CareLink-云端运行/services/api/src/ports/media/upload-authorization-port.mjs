import { assert } from "../../errors.mjs";

export function assertUploadAuthorizationPort(port) {
  assert(port && typeof port.authorize === "function", "upload_policy_unavailable", 503);
  return port;
}

export function assertUploadAuthorization(value, binding) {
  assert(value && typeof value === "object" && !Array.isArray(value) &&
    typeof value.url === "string" && value.url.length > 0 && value.url.length <= 4096 &&
    value.headers && typeof value.headers === "object" && !Array.isArray(value.headers),
  "upload_policy_unavailable", 503);
  const objectPath = binding.exactPrivateObjectKey.split("/").map(encodeURIComponent).join("/");
  const localPath = `/__local/media/direct/${objectPath}`;
  const relative = value.url.startsWith("/") && !value.url.startsWith("//");
  let target;
  try { target = new URL(value.url, "http://local.invalid"); }
  catch { assert(false, "upload_policy_unavailable", 503); }
  let path;
  try { path = decodeURIComponent(target.pathname); }
  catch { assert(false, "upload_policy_unavailable", 503); }
  assert(!target.username && !target.password && !target.search && !target.hash &&
    !value.url.includes(binding.rawTicket) &&
    (relative ? value.url === localPath : target.protocol === "https:" &&
      (path === `/${binding.exactPrivateObjectKey}` || path.endsWith(`/${binding.exactPrivateObjectKey}`))),
  "upload_policy_unavailable", 503);
  assert(Object.values(value.headers).every((item) => typeof item === "string"),
    "upload_policy_unavailable", 503);
  const names = Object.keys(value.headers);
  assert(new Set(names.map((name) => name.toLowerCase())).size === names.length,
    "upload_policy_unavailable", 503);
  let canonical;
  try { canonical = new Headers(value.headers); }
  catch { assert(false, "upload_policy_unavailable", 503); }
  const headers = Object.fromEntries(canonical.entries());
  const forbidden = ["accept-charset", "accept-encoding", "access-control-request-headers",
    "access-control-request-method", "connection", "content-length", "cookie", "cookie2", "date", "dnt",
    "expect", "host", "keep-alive", "origin", "permissions-policy", "referer", "set-cookie", "te", "trailer",
    "transfer-encoding", "upgrade", "via", "x-http-method", "x-http-method-override", "x-method-override"];
  assert(forbidden.every((name) => !canonical.has(name)) &&
    [...canonical.keys()].every((name) => !/^(proxy-|sec-)/.test(name)) &&
    headers["content-type"] === binding.declaredMime &&
    headers["if-none-match"] === "*" && headers["x-unseen-upload-session"] === binding.uploadSessionId &&
    headers["x-unseen-upload-session-version"] === String(binding.uploadSessionVersion) &&
    headers["x-unseen-upload-item"] === binding.itemId && headers["x-unseen-upload-asset"] === binding.assetId &&
    headers["x-unseen-upload-bytes"] === String(binding.declaredBytes) &&
    headers["x-unseen-upload-expires-at"] === binding.expiresAt,
  "upload_policy_unavailable", 503);
  return Object.freeze({ url: value.url, headers: Object.freeze({ ...value.headers }) });
}

export class LocalUploadAuthorizationPort {
  authorize({ rawTicket, uploadSessionId, uploadSessionVersion, itemId, assetId, exactPrivateObjectKey,
    declaredMime, declaredBytes, expiresAt }) {
    assert(typeof rawTicket === "string" && rawTicket.length > 0 && typeof uploadSessionId === "string" &&
      Number.isSafeInteger(uploadSessionVersion) && typeof itemId === "string" && typeof assetId === "string" &&
      typeof exactPrivateObjectKey === "string" && exactPrivateObjectKey.length > 0 &&
      typeof declaredMime === "string" && Number.isSafeInteger(declaredBytes) && declaredBytes > 0 &&
      Number.isFinite(Date.parse(expiresAt)), "upload_policy_unavailable", 503);
    const objectPath = exactPrivateObjectKey.split("/").map(encodeURIComponent).join("/");
    return Object.freeze({
      url: `/__local/media/direct/${objectPath}`,
      headers: Object.freeze({
        "Content-Type": declaredMime,
        "If-None-Match": "*",
        "X-Upload-Ticket": rawTicket,
        "X-Unseen-Upload-Session": uploadSessionId,
        "X-Unseen-Upload-Session-Version": String(uploadSessionVersion),
        "X-Unseen-Upload-Item": itemId,
        "X-Unseen-Upload-Asset": assetId,
        "X-Unseen-Upload-Bytes": String(declaredBytes),
        "X-Unseen-Upload-Expires-At": expiresAt
      })
    });
  }
}
