import { spawn } from "node:child_process";
import { createServer, request as proxyRequest } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const port = Number(process.env.UNSEEN_UI_PORT || 4286);
const webPort = Number(process.env.UNSEEN_UI_WEB_PORT || 4287);
const bookPort = Number(process.env.UNSEEN_UI_BOOK_PORT || 4288);
if (![port, webPort, bookPort].every((value) => Number.isSafeInteger(value) && value > 1024 && value < 65536) || new Set([port, webPort, bookPort]).size !== 3) {
  throw new Error("ui_productization_v2_ports_invalid");
}

const children = [
  spawn(process.execPath, ["apps/web/server.mjs"], {
    cwd: root,
    env: { ...process.env, UNSEEN_WEB_PORT: String(webPort), UNSEEN_WEB_UI_PRODUCTIZATION_FIXTURE: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  }),
  spawn(process.execPath, ["packages/book-lab-web/scripts/dev-server.mjs"], {
    cwd: root,
    env: { ...process.env, UNSEEN_BOOK_LAB_PORT: String(bookPort) },
    stdio: ["ignore", "pipe", "pipe"]
  })
];

for (const child of children) child.stderr.on("data", (chunk) => process.stderr.write(chunk));

function bookRoute(pathname) {
  return /^\/labs\/(?:memories|books)\//u.test(pathname) || /^\/manage\/[^/]+\/book-lab(?:\/|$)/u.test(pathname) ||
    /^\/s\/[^/]+\/books\/[^/]+\/versions\/[^/]+\/?$/u.test(pathname) || pathname.startsWith("/packages/book-lab-web/") ||
    ["/__fixture", "/__catalog", "/__artifacts/render", "/__artifacts/book.html", "/__artifacts/book.pdf", "/__artifacts/render-receipt.json"].includes(pathname) ||
    /^\/__artifacts\/[a-f0-9]{64}\/(?:book\.html|book\.pdf|render-receipt\.json)$/u.test(pathname);
}

async function ready(url) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(500) }); if (response.ok) return; } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`ui_productization_v2_child_unavailable:${url}`);
}

await Promise.all([ready(`http://127.0.0.1:${webPort}/`), ready(`http://127.0.0.1:${bookPort}/healthz`)]);

const server = createServer((incoming, outgoing) => {
  const origin = `http://127.0.0.1:${port}`;
  const pathname = new URL(incoming.url, origin).pathname;
  if (incoming.method === "GET" && pathname === "/__ui-v2/healthz") {
    const body = JSON.stringify({
      status: "ok", origin, listener: "loopback_only", productPath: ["home", "space", "photo", "memory", "book"],
      fixture: true, fixtureNotice: "本地确定性样本 / 非真实 AI / 不代表正式发布", samples: {
        core: "向晚婚礼", book: "AdventureX 2026", continuousData: false
      }, externalExposure: false, cloudWrites: 0, productionReady: false
    });
    outgoing.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": String(Buffer.byteLength(body)) });
    outgoing.end(body);
    return;
  }
  const targetPort = bookRoute(pathname) ? bookPort : webPort;
  const proxied = proxyRequest({ hostname: "127.0.0.1", port: targetPort, method: incoming.method, path: incoming.url,
    headers: { ...incoming.headers, host: `127.0.0.1:${port}` } }, (response) => {
    outgoing.writeHead(response.statusCode, response.headers);
    response.pipe(outgoing);
  });
  proxied.once("error", () => {
    if (!outgoing.headersSent) outgoing.writeHead(503, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    outgoing.end("UNSEEN UI 暂时无法打开");
  });
  incoming.pipe(proxied);
});

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop);
for (const child of children) child.once("exit", (code) => {
  if (stopping) return;
  process.exitCode = code || 1;
  stop();
});

server.listen(port, "127.0.0.1", () => process.stdout.write(`UNSEEN_UI_PRODUCTIZATION_V2_READY http://127.0.0.1:${port}/\n`));
