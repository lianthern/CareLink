import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const serverPath = fileURLToPath(new URL("../server.mjs", import.meta.url));
const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

async function startServer(t) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: "0",
      MINIMAX_API_KEY: "not-a-real-cache-contract-test",
      WORLDLABS_API_KEY: "not-a-real-cache-contract-test"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`server startup timed out: ${stderr}`));
    }, 5_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited before startup (${code}): ${stderr}`));
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = /http:\/\/127\.0\.0\.1:(\d+)/u.exec(stdout);
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    });
  });

  t.after(() => {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGTERM");
  });
  return `http://127.0.0.1:${port}`;
}

test("versioned public assets are immutable and honor If-None-Match", { timeout: 10_000 }, async (t) => {
  const origin = await startServer(t);
  for (const path of [
    "/unseen-dap/v1/assets/ballroom-depth.json",
    "/official-gallery/v1/media/world-multi-thumb.webp",
    "/unseen-demo.css?v=20260905-gallery1",
    "/unseen-demo.js?v=20260905-gallery1",
    "/icon.svg?v=icon1"
  ]) {
    const url = `${origin}${path}`;
    const first = await fetch(url);

    assert.equal(first.status, 200, path);
    assert.equal(first.headers.get("cache-control"), "public, max-age=31536000, immutable", path);
    const etag = first.headers.get("etag");
    assert.ok(etag, `${path} must include an ETag`);
    await first.arrayBuffer();

    const revalidated = await fetch(url, { headers: { "if-none-match": etag } });
    assert.equal(revalidated.status, 304, path);
    assert.equal(revalidated.headers.get("etag"), etag, path);
    assert.equal(revalidated.headers.get("cache-control"), "public, max-age=31536000, immutable", path);
    assert.equal((await revalidated.arrayBuffer()).byteLength, 0, path);
  }
});

test("HTML and APIs remain no-store", { timeout: 10_000 }, async (t) => {
  const origin = await startServer(t);
  const paths = [
    ["/unseen-dap", 200],
    ["/api/health?v=release1", 200],
    ["/unseen-demo.html?v=release1", 200],
    ["/unseen-demo.css", 200],
    ["/unseen-demo.css?v=", 200],
    ["/unseen-demo.css?v=release1&extra=1", 200],
    [`/unseen-demo.css?v=${"a".repeat(65)}`, 200],
    ["/official-gallery/v1/missing.webp", 404]
  ];
  for (const [path, expectedStatus] of paths) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, expectedStatus, path);
    assert.equal(response.headers.get("cache-control"), "no-store", path);
    await response.arrayBuffer();
  }
});

test("version paths and strict query tokens share the immutable server and proxy contract", async () => {
  const [server, caddy, viewer] = await Promise.all([
    read("../server.mjs"),
    read("../deploy/Caddyfile.huijian"),
    read("../public/unseen-dap.html")
  ]);

  assert.match(server, /"\/official-gallery\/v1\/"/u);
  assert.match(server, /"\/unseen-dap\/v1\/"/u);
  assert.match(server, /STATIC_VERSION_QUERY = \/\^v=/u);
  assert.match(server, /extension === "\.html"/u);
  assert.match(server, /public, max-age=31536000, immutable/u);
  assert.match(caddy, /header \?Cache-Control "no-store"/u);
  assert.doesNotMatch(caddy, /^\s*Cache-Control\s|header\s+(?:@\S+\s+)?Cache-Control\s/mu);
  assert.doesNotMatch(caddy, /\bmatch\s*\{/u);

  assert.match(viewer, /src="\/unseen-dap\/v1\/vendor\/three\.min\.js"/u);
  assert.match(viewer, /"\/unseen-dap\/v1\/assets\/" \+ scene\.slug/u);
  assert.doesNotMatch(viewer, /\/unseen-dap\/(?:assets|vendor)\//u);
  assert.doesNotMatch(viewer, /fetch\(url, \{ cache: "no-store" \}\)/u);
});
