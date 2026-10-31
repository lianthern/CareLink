import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { ApiError, errorBody } from "./errors.mjs";
import { PRIVATE_AI_PROTOCOL } from "./private-ai-job-queue.mjs";

const JSON_LIMIT = 1024 * 1024;
const PRIVATE_AI_JSON_LIMIT = 32 * 1024;
const PRIVATE_AI_BASE = "/__internal/private-ai/v1";
const CLEAR_ACCOUNT_COOKIE = "__Host-unseen_account=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0";
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function normalizeIp(address) {
  const unmapped = address.slice(0, 7).toLowerCase() === "::ffff:" ? address.slice(7) : address;
  return net.isIP(unmapped) === 4 ? unmapped : address;
}

export function deriveRiskScope(remoteAddress, forwardedFor) {
  let address = typeof remoteAddress === "string" ? normalizeIp(remoteAddress) : remoteAddress;
  if (LOOPBACK_ADDRESSES.has(remoteAddress) && typeof forwardedFor === "string") {
    const entries = forwardedFor.split(",").map((entry) => entry.trim()).filter(Boolean);
    const candidate = entries.length ? normalizeIp(entries.at(-1)) : null;
    if (candidate && net.isIP(candidate)) address = candidate;
  }
  const family = net.isIP(address);
  return `${family === 4 ? "ipv4" : family === 6 ? "ipv6" : "unknown"}:${address ?? "unknown"}`;
}

function cookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => part.trim().split("=")).filter((parts) => parts.length === 2));
}

function bootstrap(type) {
  const nonce = randomBytes(18).toString("base64url");
  const key = type === "receipt" ? "receipt" : "invite";
  const html = `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><script nonce="${nonce}">(()=>{const h=location.hash;const m=h.match(/^#${key}=([A-Za-z0-9_-]{43})$/);let s=m?m[1]:null;history.replaceState(null,"",location.pathname+location.search);Object.defineProperty(window,"__unseenBootstrap",{value:()=>{const v=s;s=null;return v},configurable:false})})()</script>`;
  return { nonce, html };
}

function setSessionCookies(body) {
  const result = { ...body };
  const values = [];
  const deletionResponse = Boolean(result.deletionStatusSessionSecret || result._clearAccountSessionCookie);
  const mapping = [
    ["accountSessionSecret", "__Host-unseen_account"],
    ["challengeCookieSecret", "__Host-unseen_campaign_challenge"],
    ["viewerSessionSecret", "__Host-unseen_viewer"],
    ["contributorSessionSecret", "__Host-unseen_contributor"],
    ["receiptSessionSecret", "__Host-unseen_receipt"],
    ["caseAccessSessionSecret", "__Host-unseen_case"],
    ["deletionStatusSessionSecret", "__Host-unseen_deletion_status"]
  ];
  for (const [field, name] of mapping) {
    if (!result[field]) continue;
    values.push(`${name}=${result[field]}; Path=/; HttpOnly; Secure; SameSite=Strict`);
    delete result[field];
  }
  if (result._clearAccountSessionCookie) {
    values.push(CLEAR_ACCOUNT_COOKIE);
    delete result._clearAccountSessionCookie;
  }
  if (deletionResponse) {
    delete result.deletionStatusSessionId;
    delete result.accessExpiresAt;
  }
  return { body: result, cookies: values };
}

function staleAccountCookie(result, jar, { principalKind }) {
  // Only the selected account principal can invalidate an account cookie. A query hint alone grants no such scope.
  return principalKind === "accountSession" && result.status === 401 && result.body?.error?.code === "session_unavailable" &&
    Object.hasOwn(jar, "__Host-unseen_account");
}

async function readLimited(request, maxBytes) {
  const declared = request.headers["content-length"] == null ? null : Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) throw new ApiError("object_too_large", 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new ApiError("object_too_large", 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function writeJson(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store, private", ...headers });
  response.end(JSON.stringify(body));
}

function assertCookieCsrf(request, origin) {
  if (!request.headers.cookie || !["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return;
  const valid = request.headers.origin === origin && request.headers.host === new URL(origin).host &&
    request.headers["sec-fetch-site"] === "same-origin";
  if (!valid) throw new ApiError("request_origin_invalid", 403);
}

async function privateAiJson(request) {
  if (request.headers["content-type"] !== "application/json") {
    throw new ApiError("private_ai_request_invalid", 400);
  }
  let bytes;
  try { bytes = await readLimited(request, PRIVATE_AI_JSON_LIMIT); }
  catch { throw new ApiError("private_ai_request_invalid", 400); }
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new ApiError("private_ai_request_invalid", 400); }
}

async function handlePrivateAi({ api, request, response, url }) {
  api.privateAi.authorize({ authorization: request.headers.authorization,
    forwardedProto: request.headers["x-forwarded-proto"], remoteAddress: request.socket.remoteAddress });
  if (request.headers["x-unseen-protocol"] !== PRIVATE_AI_PROTOCOL || url.search) {
    throw new ApiError("private_ai_request_invalid", 400);
  }
  const headers = { "x-unseen-protocol": PRIVATE_AI_PROTOCOL };
  if (request.method === "POST" && url.pathname === `${PRIVATE_AI_BASE}/jobs/lease`) {
    const body = await privateAiJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).join("\0") !== "schema" ||
      body.schema !== "unseen-private-ai-lease-request/1") throw new ApiError("private_ai_request_invalid", 400);
    writeJson(response, 200, api.privateAi.lease(), headers);
    return;
  }
  const image = url.pathname.match(/^\/__internal\/private-ai\/v1\/jobs\/(paij_[a-f0-9]{32})\/image$/u);
  if (request.method === "GET" && image) {
    const result = await api.privateAi.image(image[1], request.headers["x-unseen-ai-lease"]);
    response.writeHead(200, { "content-type": result.contentType, "content-length": String(result.body.length),
      "cache-control": "no-store, private", "cross-origin-resource-policy": "same-origin",
      "x-content-type-options": "nosniff", etag: `"${result.sha256}"`,
      "x-unseen-content-sha256": result.sha256, ...headers });
    response.end(result.body);
    return;
  }
  const terminal = url.pathname.match(/^\/__internal\/private-ai\/v1\/jobs\/(paij_[a-f0-9]{32})\/(complete|fail)$/u);
  if (request.method === "POST" && terminal) {
    const body = await privateAiJson(request);
    const result = terminal[2] === "complete" ? api.privateAi.complete(terminal[1], body) :
      api.privateAi.fail(terminal[1], body);
    writeJson(response, 200, result, headers);
    return;
  }
  throw new ApiError("private_ai_job_unavailable", 404);
}

export function createLocalHttpServer({ api }) {
  return createServer(async (request, response) => {
    const expectedOrigin = api.campaigns.publicOrigin;
    const privateAiRequest = String(request.url ?? "").startsWith(PRIVATE_AI_BASE);
    const requestScope = { principalKind: null };
    try {
      const expected = new URL(expectedOrigin);
      if (request.headers.host !== expected.host) throw new ApiError("request_host_invalid", 400);
      const url = new URL(request.url, expected);
      if (url.origin !== expected.origin || !String(request.url).startsWith("/")) {
        throw new ApiError("request_target_invalid", 400);
      }
      if (url.pathname.startsWith(PRIVATE_AI_BASE)) {
        await handlePrivateAi({ api, request, response, url });
        return;
      }
      if (request.method === "GET" && url.pathname === "/healthz") {
        // "down" is the only status that yields a non-200 here -- "ok" and "degraded" both mean
        // the site is servable (see health-checks.mjs's status contract comment for why).
        const health = await api.health();
        writeJson(response, health.status === "down" ? 503 : 200, health);
        return;
      }
      if (request.method === "GET" && ["/open", "/member-invitations/accept", "/uploads/open"].includes(url.pathname)) {
        const type = url.pathname === "/uploads/open" ? "receipt" : "invite";
        const page = bootstrap(type);
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8", "cache-control": "no-store, private", "referrer-policy": "no-referrer",
          "content-security-policy": `default-src 'none'; script-src 'nonce-${page.nonce}'; connect-src 'self'; style-src 'none'; img-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; worker-src 'none'; manifest-src 'none'; require-trusted-types-for 'script'`,
          "service-worker-allowed": "none", "x-content-type-options": "nosniff"
        });
        response.end(page.html);
        return;
      }
      if (request.method === "GET" && /^\/open\/[A-Za-z0-9_-]{22,64}$/.test(url.pathname)) {
        writeJson(response, 200, { locator: url.pathname.slice(6), grantsAuthority: false,
          next: "/v1/external-campaign-admission-challenges" }, { "referrer-policy": "no-referrer" });
        return;
      }
      assertCookieCsrf(request, expectedOrigin);
      // Prevent login CSRF even before the visitor has their first account cookie.
      if (request.method === "POST" && (["/v1/auth/password-login", "/v1/auth/register", "/v1/auth/recovery-contact-challenges", "/v1/auth/recovery-requests"].includes(url.pathname) || url.pathname.startsWith('/v1/auth/password-reset-')) &&
        (request.headers.origin || request.headers["sec-fetch-site"])) {
        if (request.headers.origin !== expectedOrigin || request.headers["sec-fetch-site"] !== "same-origin") {
          throw new ApiError("request_origin_invalid", 403);
        }
      }
      const jar = cookies(request.headers.cookie);
      const viewerMediaRoute = request.method === "GET" &&
        /^\/v1\/viewer\/spaces\/[^/]+\/(?:panorama-revisions\/[^/]+\/media|photos\/[^/]+\/(?:media|video))$/.test(url.pathname);
      // 无浏览器 cookie 的客户端(微信小程序)其宿主会改写 sec-fetch-site —— 实测
      // 微信把请求头里的 same-origin 覆写成 same-site,而 campaign challenge/admission
      // 的 sameOrigin 门硬要求 sec-fetch-site==='same-origin'(见 api.mjs 的 ctx.sameOrigin
      // 计算 + campaign-service.mjs),导致这两步在小程序里永远 403。
      // 放宽是安全的,与本文件 assertCookieCsrf 对「无 cookie 请求直接放行」同哲学:
      // sameOrigin 门本质是配合 cookie 会话的 CSRF 防护,而 CSRF 的威胁模型是「受害者
      // 浏览器自动携带 cookie」。无 cookie ⇒ 无此威胁。且 admission 只发一次性 challenge,
      // 没有 invite secret 无法 exchange,伪造 origin 也拿不到任何 campaign 本就未公开的东西。
      // 因此:请求不带浏览器 cookie 且 origin 已声明为本站时,把 sec-fetch-site 规范为
      // same-origin。host 与 origin 仍由 sameOrigin 独立真实校验,这里只放宽 sec-fetch-site 一维。
      const noBrowserCookie = !request.headers.cookie;
      const secFetchSite = (noBrowserCookie && request.headers.origin === expectedOrigin)
        ? "same-origin" : request.headers["sec-fetch-site"];
      const headers = {
        ...request.headers,
        "sec-fetch-site": secFetchSite,
        authorization: viewerMediaRoute ? (jar["__Host-unseen_account"] ? `Bearer ${jar["__Host-unseen_account"]}` : undefined) :
          (request.headers.authorization ?? (jar["__Host-unseen_account"] ? `Bearer ${jar["__Host-unseen_account"]}` : undefined)),
        "x-campaign-challenge": request.headers["x-campaign-challenge"] ?? jar["__Host-unseen_campaign_challenge"],
        "x-viewer-session": viewerMediaRoute ? jar["__Host-unseen_viewer"] :
          (request.headers["x-viewer-session"] ?? jar["__Host-unseen_viewer"]),
        "x-contributor-session": request.headers["x-contributor-session"] ?? jar["__Host-unseen_contributor"],
        "x-receipt-session": request.headers["x-receipt-session"] ?? jar["__Host-unseen_receipt"],
        "x-case-access-session": request.headers["x-case-access-session"] ?? jar["__Host-unseen_case"],
        "x-deletion-status-session": request.headers["x-deletion-status-session"] ?? jar["__Host-unseen_deletion_status"],
        "x-public-origin": expectedOrigin, "x-public-host": new URL(expectedOrigin).host
      };
      // Resolve the same registered-route policy used by LocalApi.handle before any pre-body authentication can throw.
      requestScope.principalKind = api.requestPrincipalKind({ method: request.method, path: request.url, headers });

      if (request.method === "PUT" && url.pathname.startsWith("/__local/media/direct/")) {
        const ticket = request.headers["x-upload-ticket"];
        const info = api.mediaTicketInfo({ ticket, kind: "photo" });
        const contentLength = request.headers["content-length"] == null ? null : Number(request.headers["content-length"]);
        if (Number.isFinite(contentLength)) {
          if (contentLength > info.hardLimitBytes) throw new ApiError("object_too_large", 413);
          if (contentLength !== Number(info.declared.bytes) || request.headers["content-type"] !== info.declared.mime) {
            throw new ApiError(info.mismatchCode, 409);
          }
        }
        let exactPrivateObjectKey;
        try { exactPrivateObjectKey = decodeURIComponent(url.pathname.slice("/__local/media/direct/".length)); }
        catch { throw new ApiError("object_mismatch", 409); }
        const bytes = await readLimited(request, info.hardLimitBytes);
        const result = await api.putDirectMedia({ ticket, exactPrivateObjectKey, bytes,
          contentType: request.headers["content-type"], headers: request.headers });
        writeJson(response, result.status, result.body, result.headers);
        return;
      }

      if (request.method === "PUT" && url.pathname === "/__local/media") {
        const kind = request.headers["x-media-kind"] ?? "photo";
        const ticket = request.headers["x-upload-ticket"];
        const info = api.mediaTicketInfo({ ticket, kind });
        const contentLength = request.headers["content-length"] == null ? null : Number(request.headers["content-length"]);
        if (Number.isFinite(contentLength)) {
          if (contentLength > info.hardLimitBytes) throw new ApiError("object_too_large", 413);
          if (contentLength !== Number(info.declared.bytes) || request.headers["content-type"] !== info.declared.mime) {
            throw new ApiError(info.mismatchCode, 409);
          }
        }
        const bytes = await readLimited(request, info.hardLimitBytes);
        const result = await api.putMedia({ ticket, bytes, contentType: request.headers["content-type"], kind });
        writeJson(response, result.status, result.body);
        return;
      }

      // Authenticate before admitting a larger explicitly opted-in memory snapshot.
      const personalMemoryWrite = request.method === "POST" && /^\/v1\/me\/memories\/(?:[A-Za-z0-9_:-]|%3[aA]){1,128}$/.test(url.pathname);
      const momentWrite = request.method === "PUT" && /^\/v1\/moments\/[A-Za-z0-9_-]{1,96}$/.test(url.pathname);
      const momentMediaWrite = request.method === "PUT" && /^\/v1\/moment-media\/[A-Za-z0-9_-]{1,96}$/.test(url.pathname);
      const spatialWrite = request.method === "PUT" && /^\/v1\/app-spaces\/[A-Za-z0-9_-]{1,96}$/.test(url.pathname);
      const noteWrite = request.method === 'POST' && url.pathname.match(/^\/v1\/spaces\/([A-Za-z0-9_-]+)\/photos\/([A-Za-z0-9_-]+)\/notes$/);
      if (noteWrite) api.spacePhotoNotes.target({headers,accountSession:url.searchParams.get('access')==='invitation'?null:headers.authorization?.replace(/^Bearer /,''),contributorSession:url.searchParams.get('access')==='invitation'?headers['x-contributor-session']:null},noteWrite[1],noteWrite[2]);
      if (personalMemoryWrite || momentWrite || momentMediaWrite || spatialWrite) api.core.account(headers.authorization?.replace(/^Bearer /, ""));
      const bytes = await readLimited(request, spatialWrite ? 34 * 1024 * 1024 : personalMemoryWrite ? 25 * 1024 * 1024 :
        momentMediaWrite ? 17 * 1024 * 1024 : momentWrite || noteWrite ? 9 * 1024 * 1024 : JSON_LIMIT);
      let body = {};
      try { if (bytes.length) body = JSON.parse(bytes.toString("utf8")); }
      catch { throw new ApiError("validation_failed", 400); }
      const result = await api.handle({ method: request.method, path: request.url, headers, body,
        observedRiskScope: deriveRiskScope(request.socket.remoteAddress, request.headers["x-forwarded-for"]) });
      if (Buffer.isBuffer(result.body)) {
        response.writeHead(result.status, result.headers);
        response.end(result.body);
        return;
      }
      const safe = setSessionCookies(result.body);
      if (staleAccountCookie(result, jar, requestScope)) safe.cookies.push(CLEAR_ACCOUNT_COOKIE);
      if (safe.cookies.length) result.headers["set-cookie"] = safe.cookies;
      response.writeHead(result.status, result.headers);
      response.end(JSON.stringify(safe.body));
    } catch (error) {
      const result = errorBody(error, randomBytes(12).toString("hex"));
      writeJson(response, result.status, result.body,
        { ...(privateAiRequest ? { "x-unseen-protocol": PRIVATE_AI_PROTOCOL } : {}),
          ...(staleAccountCookie(result, cookies(request.headers.cookie), requestScope) ? { "set-cookie": CLEAR_ACCOUNT_COOKIE } : {}) });
    }
  });
}

export function listenLocalHttpServer(server, { host = "127.0.0.1", port = 8787 } = {}) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      resolve({ origin: `http://${address.address}:${address.port}`, address });
    });
  });
}
