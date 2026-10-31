import { createServer, request as proxyRequest } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const JSON_LIMIT = 1024 * 1024;
const UI_ROUTE = /^(?:\/labs\/memories\/(?:photos\/[^/]+|[^/]+)|\/labs\/books\/[^/]+\/contributions\/[^/]+|\/manage\/[^/]+\/book-lab(?:\/[^/]+\/draft)?)(?:\/)?$/u;
const VERSION_ROUTE = /^\/s\/([^/]+)\/books\/([^/]+)\/versions\/([^/]+)\/?$/u;
const STATIC = new Map([
  ["/__book-lab/app.mjs", ["infra/integration/book-lab/integrated-app.mjs", "text/javascript; charset=utf-8"]],
  ["/__book-lab/catalog.json", ["packages/contracts/generated/book-lab/string-catalog.zh-CN.json", "application/json"]],
  ["/packages/book-lab-web/src/integrated-shell.mjs", ["packages/book-lab-web/src/integrated-shell.mjs", "text/javascript; charset=utf-8"]],
  ["/packages/book-lab-web/src/integrated-controller.mjs", ["packages/book-lab-web/src/integrated-controller.mjs", "text/javascript; charset=utf-8"]],
  ["/packages/book-lab-web/src/integrated-transport.mjs", ["packages/book-lab-web/src/integrated-transport.mjs", "text/javascript; charset=utf-8"]],
  ["/packages/book-lab-web/src/routes.mjs", ["packages/book-lab-web/src/routes.mjs", "text/javascript; charset=utf-8"]],
  ["/packages/book-lab-web/src/styles.css", ["packages/book-lab-web/src/styles.css", "text/css; charset=utf-8"]]
]);


// Keep the production-package adapter compatible with the canonical local-operable
// browser namespace. Reuse only the existing explicit public asset allowlist.
for (const [url, asset] of [...STATIC]) {
  if (url.startsWith("/packages/book-lab-web/src/")) {
    STATIC.set(url.replace("/packages/book-lab-web/", "/__book_lab_web__/"), asset);
  }
}
STATIC.set("/__book_lab_web__/catalog.json", STATIC.get("/__book-lab/catalog.json"));

function cookieJar(value = "") {
  return Object.fromEntries(value.split(";").map((part) => part.trim().split("=")).filter((part) => part.length === 2));
}

async function bytes(request, limit = JSON_LIMIT) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw Object.assign(new Error("object_too_large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

function write(response, status, headers, body) {
  const value = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  response.writeHead(status, { "content-length": String(value.length), ...headers });
  response.end(value);
}

function requestHeaders(request, origin) {
  const jar = cookieJar(request.headers.cookie);
  return {
    ...request.headers,
    authorization: request.headers.authorization ??
      (jar["__Host-unseen_account"] ? `Bearer ${jar["__Host-unseen_account"]}` : undefined),
    "x-viewer-session": request.headers["x-viewer-session"] ?? jar["__Host-unseen_viewer"],
    "x-receipt-session": request.headers["x-receipt-session"] ?? jar["__Host-unseen_receipt"],
    "x-public-origin": origin,
    "x-public-host": new URL(origin).host
  };
}

function assertMutationOrigin(request, origin) {
  if (!request.headers.cookie || !["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return;
  if (request.headers.origin !== origin || request.headers.host !== new URL(origin).host ||
    request.headers["sec-fetch-site"] !== "same-origin") {
    throw Object.assign(new Error("request_origin_invalid"), { status: 403 });
  }
}

function privateAiWorkerStatus(api) {
  try {
    const observation = api.privateAiObservation();
    return observation.enabled ? observation.workerOnline ? "online" : "offline" : "disabled";
  } catch { return "offline"; }
}

function shell(workerStatus) {
  const workerCopy = workerStatus === "online" ? "私有 AI 测试适配器 · 当前在线" : workerStatus === "offline"
    ? "私有 AI 测试适配器 · 本机离线时安全排队" : "真实 Core 接缝 · AI 未启用时问题功能安全停用";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>UNSEEN · 记忆成书</title><link rel="stylesheet" href="/packages/book-lab-web/src/styles.css"></head><body><a class="skip-link" href="#main">跳到主要内容</a><header class="site-header"><div class="header-inner"><span class="brand"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><b>♥</b></span><span>UNSEEN</span></span><p class="fixture-badge">${workerCopy}</p></div></header><p id="book-lab-status" class="sr-only" role="status" aria-live="polite"></p><main id="main" tabindex="-1"></main><script type="module" src="/__book-lab/app.mjs"></script></body></html>`;
}

function proxy(request, response, origin) {
  const target = new URL(origin);
  return new Promise((resolve, reject) => {
    const forwarded = proxyRequest({ hostname: target.hostname, port: target.port, method: request.method,
      path: request.url, headers: request.headers }, (upstream) => {
      response.writeHead(upstream.statusCode, upstream.headers);
      upstream.pipe(response);
      upstream.once("end", resolve);
    });
    forwarded.once("error", reject);
    request.pipe(forwarded);
  });
}

export function createBookLabSameOriginServer({ api, runtime, publicOrigin = null, coreOrigin = null }) {
  if (!api || typeof api.handle !== "function" || !runtime || typeof runtime.readCanonicalHtmlForUi !== "function") {
    throw new Error("book_lab_same_origin_configuration_invalid");
  }
  if (publicOrigin !== null) {
    const value = new URL(publicOrigin);
    if (!new Set(["http:", "https:"]).has(value.protocol) || value.username || value.password ||
      value.pathname !== "/" || value.search || value.hash) throw new Error("book_lab_public_origin_invalid");
    publicOrigin = value.origin;
  }
  if (coreOrigin !== null) {
    const value = new URL(coreOrigin);
    if (value.protocol !== "http:" || value.hostname !== "127.0.0.1" || value.pathname !== "/" ||
      value.search || value.hash) throw new Error("book_lab_core_origin_invalid");
    coreOrigin = value.origin;
  }
  return createServer(async (request, response) => {
    const address = request.socket.address();
    const origin = publicOrigin ?? `http://127.0.0.1:${address.port}`;
    try {
      if (request.headers.host !== new URL(origin).host) throw Object.assign(new Error("request_host_invalid"), { status: 400 });
      const url = new URL(request.url, origin);
      const workerStatus = privateAiWorkerStatus(api);
      if (url.origin !== origin || !request.url.startsWith("/") || url.search || url.hash) {
        throw Object.assign(new Error("request_target_invalid"), { status: 400 });
      }
      if (request.method === "GET" && url.pathname === "/__book-lab/healthz") {
        write(response, 200, { "content-type": "application/json", "cache-control": "no-store" }, {
          status: "ok", sameOrigin: true, fixtureFallback: false, providerConfigured: workerStatus !== "disabled",
          privateAiWorker: workerStatus,
          eventSourceConfigured: true, rendererConfigured: true, productionReady: false
        });
        return;
      }
      const staticFile = request.method === "GET" ? STATIC.get(url.pathname) : null;
      if (staticFile) {
        write(response, 200, { "content-type": staticFile[1], "cache-control": "no-store",
          "x-content-type-options": "nosniff" }, await readFile(path.join(root, staticFile[0])));
        return;
      }
      const version = request.method === "GET" ? url.pathname.match(VERSION_ROUTE) : null;
      if (version) {
        const headers = requestHeaders(request, origin);
        const ctx = api.context({ headers, body: {} }, url);
        const result = await runtime.readCanonicalHtmlForUi(ctx, {
          spaceId: decodeURIComponent(version[1]), bookId: decodeURIComponent(version[2]),
          versionId: decodeURIComponent(version[3])
        });
        write(response, 200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store, private",
          etag: `"${result.contentHash}"`, "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; object-src 'none'; script-src 'none'"
        }, result.bytes);
        return;
      }
      if (request.method === "GET" && UI_ROUTE.test(url.pathname)) {
        write(response, 200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store, private",
          "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
          "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"
        }, shell(workerStatus));
        return;
      }
      if (url.pathname.startsWith("/v2-labs/")) {
        assertMutationOrigin(request, origin);
        const raw = await bytes(request);
        let body = {};
        try { if (raw.length) body = JSON.parse(raw.toString("utf8")); }
        catch { throw Object.assign(new Error("validation_failed"), { status: 400 }); }
        const result = await api.handle({ method: request.method, path: url.pathname,
          headers: requestHeaders(request, origin), body, observedRiskScope: "loopback-book-lab" });
        write(response, result.status, { ...result.headers, "x-unseen-private-ai-worker": workerStatus }, result.body);
        return;
      }
      if (coreOrigin) {
        await proxy(request, response, coreOrigin);
        return;
      }
      write(response, 404, { "content-type": "application/json", "cache-control": "no-store" },
        { error: { code: "route_unavailable" } });
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const status = Number.isSafeInteger(error?.status) ? error.status :
        ["book_version_unavailable", "memory_unavailable"].includes(error?.code) ? 404 : 500;
      const code = status === 500 ? "book_lab_unavailable" : error?.code ?? error?.message ?? "book_lab_unavailable";
      write(response, status, { "content-type": "application/json", "cache-control": "no-store, private" },
        { error: { code } });
    }
  });
}

export function listenBookLabSameOriginServer(server, { host = "127.0.0.1", port = 0 } = {}) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      resolve({ origin: `http://${address.address}:${address.port}`, address });
    });
  });
}
