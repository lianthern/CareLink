import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalContractApi } from "./mock-api.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.UNSEEN_WEB_PORT || 4173);
const localApi = process.env.UNSEEN_WEB_LOCAL_API === "0" ? null : await createLocalContractApi(root, { test: process.env.UNSEEN_WEB_TEST === "1" });
const localDeterministicLocator = process.env.UNSEEN_WEB_LOCAL_DETERMINISTIC_LOCATOR === "1";
const uiProductizationFixture = process.env.UNSEEN_WEB_UI_PRODUCTIZATION_FIXTURE === "1";
// Dev-only mirror of the real UNSEEN_BOOK_LAB_ENABLED switch (see infra/integration/local-operable.mjs and
// services/api/src/index.mjs): lets `npm run dev` preview the Book Lab entry points without a real backend.
const bookLabEnabled = process.env.UNSEEN_WEB_BOOK_LAB_ENABLED === "1";
const viewerPackageRoot = process.env.UNSEEN_VIEWER_ROOT ? resolve(process.env.UNSEEN_VIEWER_ROOT) : resolve(root, "../../packages/viewer");
// Mirrors the /__viewer__/ static bridge above for the book-lab-web package, which apps/web/src/extensions/book-lab.js
// imports at runtime via the index.html import map. Only reachable when a real Book Lab route is visited with the
// flag on; unrelated to whether the flag is set (the static files are harmless to serve either way).
const bookLabWebRoot = process.env.UNSEEN_BOOK_LAB_WEB_ROOT ? resolve(process.env.UNSEEN_BOOK_LAB_WEB_ROOT) : resolve(root, "../../packages/book-lab-web");
const bookLabCatalogPath = process.env.UNSEEN_BOOK_LAB_CATALOG_PATH ? resolve(process.env.UNSEEN_BOOK_LAB_CATALOG_PATH) : resolve(root, "../../packages/contracts/generated/book-lab/string-catalog.zh-CN.json");
const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp"
};

function headers(type, nonce = "") {
  return {
    "Cache-Control": "no-store",
    // worker-src 'self': the /login "获取验证码" PoW solver runs in a same-origin Web Worker
    // (src/otp-pow/worker.js) so it never blocks the main thread.
    "Content-Security-Policy": `default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'${nonce ? ` 'nonce-${nonce}'` : ""}; connect-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; worker-src 'self'; manifest-src 'none'`,
    "Content-Type": type,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff"
  };
}

createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
  if (localApi && (url.pathname.startsWith("/v1/") || url.pathname.startsWith("/__uploads/") || url.pathname.startsWith("/__panorama_uploads/") || url.pathname.startsWith("/__media/") || url.pathname.startsWith("/__test/"))) {
    await localApi.handle(request, response, url);
    return;
  }
  if (url.pathname === "/__book_lab_web__/catalog.json") {
    try {
      const body = await readFile(bookLabCatalogPath);
      response.writeHead(200, headers("application/json; charset=utf-8"));
      response.end(body);
    } catch {
      response.writeHead(404, headers("text/plain; charset=utf-8"));
      response.end("Not found");
    }
    return;
  }
  if (url.pathname.startsWith("/__book_lab_web__/")) {
    const requested = resolve(bookLabWebRoot, `.${url.pathname.slice("/__book_lab_web__".length)}`);
    if (requested !== bookLabWebRoot && !requested.startsWith(`${bookLabWebRoot}${sep}`)) {
      response.writeHead(404, headers("text/plain; charset=utf-8"));
      response.end("Not found");
      return;
    }
    try {
      const body = await readFile(requested);
      response.writeHead(200, headers(types[extname(requested)] || "application/octet-stream"));
      response.end(body);
    } catch {
      response.writeHead(404, headers("text/plain; charset=utf-8"));
      response.end("Not found");
    }
    return;
  }
  if (url.pathname.startsWith("/__viewer__/")) {
    if (!viewerPackageRoot) {
      response.writeHead(404, headers("text/plain; charset=utf-8"));
      response.end("Viewer package is not configured");
      return;
    }
    const requested = resolve(viewerPackageRoot, `.${url.pathname.slice("/__viewer__".length)}`);
    if (requested !== viewerPackageRoot && !requested.startsWith(`${viewerPackageRoot}${sep}`)) {
      response.writeHead(404, headers("text/plain; charset=utf-8"));
      response.end("Not found");
      return;
    }
    try {
      const body = await readFile(requested);
      response.writeHead(200, headers(types[extname(requested)] || "application/octet-stream"));
      response.end(body);
    } catch {
      response.writeHead(404, headers("text/plain; charset=utf-8"));
      response.end("Not found");
    }
    return;
  }
  const decoded = decodeURIComponent(url.pathname);
  const safePath = normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, "");
  let path = join(root, safePath === "/" ? "index.html" : safePath);

  try {
    if (!(await stat(path)).isFile()) throw new Error("not-file");
  } catch {
    path = join(root, "index.html");
  }

  try {
    let body = await readFile(path);
    const nonce = extname(path) === ".html" ? randomBytes(18).toString("base64") : "";
    if (nonce) {
      let html = body.toString("utf8").replaceAll("{{NONCE}}", nonce);
      const localConfig = [
        localDeterministicLocator ? "localDeterministicLocator:true" : "",
        uiProductizationFixture ? "uiProductizationFixture:true" : "",
        bookLabEnabled ? "featureFlags:{bookLab:true}" : ""
      ].filter(Boolean).join(",");
      if (localConfig) html = html.replace("</head>", `<script nonce="${nonce}">globalThis.__UNSEEN_CONFIG__={...(globalThis.__UNSEEN_CONFIG__||{}),${localConfig}};</script></head>`);
      body = Buffer.from(html);
    }
    response.writeHead(200, headers(types[extname(path)] || "application/octet-stream", nonce));
    response.end(body);
  } catch {
    response.writeHead(500, headers("text/plain; charset=utf-8"));
    response.end("UNSEEN 暂时无法打开");
  }
}).listen(port, "127.0.0.1", () => {
  process.stdout.write(`UNSEEN Web http://127.0.0.1:${port}/\n`);
});
