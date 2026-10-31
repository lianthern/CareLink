import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const body = JSON.stringify({ photo: { dataUrl: "data:image/jpeg;base64,YWJj" }, round: 0 });
const success = JSON.stringify({ choices: [{ message: { content: JSON.stringify({
  question: "这张照片之外，还有什么是你想留下的？", focus: null, modelVisibleFacts: ["桌上有杯子"]
}) } }] });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(t, { env = {}, upstreamHandler } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "unseen-server-reliability-"));
  let calls = 0;
  const upstream = createServer(async (req, res) => {
    calls += 1;
    for await (const _chunk of req) { /* consume the real request body */ }
    if (upstreamHandler) return upstreamHandler(req, res);
    res.setHeader("content-type", "application/json");
    res.end(success);
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const processes = [];
  t.after(async () => {
    for (const process of processes) await process.stop();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  async function boot() {
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const child = spawn(process.execPath, ["server.mjs"], {
      cwd, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PORT: String(port), STATE_DIRECTORY: directory,
        MINIMAX_API_KEY: "not-a-real-local-fixture-key", WORLDLABS_API_KEY: "not-a-real-local-fixture-key",
        MINIMAX_BASE_URL: upstreamUrl, MINIMAX_TTS_BASE_URL: upstreamUrl, WORLDLABS_BASE_URL: upstreamUrl,
        PHOTO_AI_DAILY_REQUEST_LIMIT: "100", PHOTO_AI_VISITOR_REQUEST_LIMIT: "50",
        PHOTO_AI_GLOBAL_REQUEST_LIMIT: "100", PHOTO_AI_CONCURRENCY_LIMIT: "4", ...env }
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const session = {
      url: `http://127.0.0.1:${port}`, port, child,
      async stop() {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          await once(child, "exit");
        }
      },
      post(path = "/api/memory-dialogue", options = {}) {
        return fetch(`${this.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body, ...options });
      }
    };
    processes.push(session);
    for (let i = 0; i < 100; i += 1) {
      if (child.exitCode !== null) throw new Error(`server exited during boot: ${output}`);
      try { if ((await fetch(`${session.url}/api/health`)).ok) return session; } catch { /* awaiting listen */ }
      await delay(20);
    }
    throw new Error(`server did not start: ${output}`);
  }
  return { boot, directory, calls: () => calls };
}

for (const path of ["/api/memory-dialogue", "/api/question"]) {
  test(`${path} rejects simple cross-site requests before contacting upstream`, async (t) => {
    const f = await fixture(t);
    const server = await f.boot();
    const plain = await server.post(path, { headers: { "content-type": "text/plain", origin: "https://untrusted.example" } });
    assert.ok([403, 415].includes(plain.status));
    const json = await server.post(path, { headers: { "content-type": "application/json", origin: "https://untrusted.example" } });
    assert.equal(json.status, 403);
    assert.equal(f.calls(), 0);
  });
}

test("12 real simultaneous HTTP calls hit shared concurrency cap before upstream", { timeout: 10_000 }, async (t) => {
  const pending = [];
  let twoUpstreamsReady;
  let tenRejectionsReady;
  const upstreamBarrier = new Promise((resolve) => { twoUpstreamsReady = resolve; });
  const rejectedBarrier = new Promise((resolve) => { tenRejectionsReady = resolve; });
  const f = await fixture(t, { env: { PHOTO_AI_CONCURRENCY_LIMIT: "2" }, upstreamHandler: (_req, res) => {
    pending.push(res);
    if (pending.length === 2) twoUpstreamsReady();
  } });
  const server = await f.boot();
  const replies = [];
  const requests = Array.from({ length: 12 }, (_, i) => server.post(i % 2 ? "/api/question" : "/api/memory-dialogue")
    .then((res) => {
      replies.push(res.status);
      if (replies.length === 10) tenRejectionsReady();
      return res;
    }));
  // A reservation can reject other clients before its own fetch reaches the upstream under load.
  // Wait for both observed events; do not infer network arrival from a fixed elapsed interval.
  await Promise.all([upstreamBarrier, rejectedBarrier]);
  assert.equal(replies.length, 10);
  assert.deepEqual(new Set(replies), new Set([429]));
  assert.equal(f.calls(), 2);
  for (const res of pending) res.end(success);
  await Promise.all(requests);
  assert.equal(replies.filter((status) => status === 200).length, 2);
});

test("both photo routes share visitor limits and rejected request does not consume upstream", async (t) => {
  const f = await fixture(t, { env: { PHOTO_AI_VISITOR_REQUEST_LIMIT: "1" } });
  const server = await f.boot();
  assert.equal((await server.post()).status, 200);
  assert.equal((await server.post("/api/question")).status, 429);
  assert.equal(f.calls(), 1);
});

test("both photo routes share the persistent daily cap across server process restart", async (t) => {
  const f = await fixture(t, { env: { PHOTO_AI_DAILY_REQUEST_LIMIT: "1" } });
  const first = await f.boot();
  assert.equal((await first.post()).status, 200);
  await first.stop();
  const second = await f.boot();
  assert.equal((await second.post("/api/question")).status, 429);
  assert.equal(f.calls(), 1);
});

for (const status of [401, 429]) {
  test(`question HTTP ${status} does not retry the upstream`, async (t) => {
    const f = await fixture(t, { upstreamHandler: (_req, res) => { res.writeHead(status); res.end("{}"); } });
    const server = await f.boot();
    await server.post("/api/question");
    assert.equal(f.calls(), 1);
  });
}

test("aborting question disconnects the upstream and does not retry", async (t) => {
  let closed = false;
  const f = await fixture(t, { upstreamHandler: (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write(" ");
    res.on("close", () => { closed = true; });
  } });
  const server = await f.boot();
  const controller = new AbortController();
  const result = server.post("/api/question", { signal: controller.signal }).catch(() => null);
  for (let i = 0; i < 100 && f.calls() === 0; i += 1) await delay(10);
  assert.equal(f.calls(), 1);
  controller.abort();
  await result;
  for (let i = 0; i < 100 && !closed; i += 1) await delay(10);
  assert.equal(closed, true);
  await delay(100);
  assert.equal(f.calls(), 1);
  assert.equal((await fetch(`${server.url}/api/health`)).status, 200);
});

test("malformed URI and Host are controlled 400s; subsequent health still responds", async (t) => {
  const f = await fixture(t);
  const server = await f.boot();
  assert.equal((await fetch(`${server.url}/api/worldlabs/operations/%FF`)).status, 400);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: server.port, path: "/api/health", headers: { host: "%" } }, (res) => {
      res.resume(); res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject); req.end();
  });
  assert.equal(hostStatus, 400);
  assert.equal((await fetch(`${server.url}/api/health`)).status, 200);
  assert.equal(server.child.exitCode, null);
});

test("corrupt persistent photo budget fails closed but service stays responsive", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.directory, "photo-ai-usage.json"), "{broken");
  const server = await f.boot();
  assert.equal((await server.post()).status, 503);
  assert.equal(f.calls(), 0);
  assert.equal((await fetch(`${server.url}/api/health`)).status, 200);
});

for (const path of ["/api/question", "/api/memory-dialogue"]) {
  test(`${path} total deadline bounds slow response bodies and reports timeout`, async (t) => {
    const f = await fixture(t, { env: { PHOTO_AI_TIMEOUT_MS: "100" }, upstreamHandler: (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" }); res.write(" ");
    } });
    const server = await f.boot();
    const start = performance.now();
    const response = await server.post(path);
    const outcome = await response.json();
    assert.equal(outcome.degraded, true);
    assert.match(outcome.reason, /timeout/);
    assert.ok(performance.now() - start < 1500);
    assert.equal(f.calls(), 1);
  });
}

test("different visitors share a global window before any extra upstream call", async (t) => {
  const f = await fixture(t, { env: { PHOTO_AI_GLOBAL_REQUEST_LIMIT: "1" } });
  const server = await f.boot();
  assert.equal((await server.post("/api/question", { headers: { "content-type": "application/json", "x-huijian-visitor": "198.51.100.1" } })).status, 200);
  assert.equal((await server.post("/api/memory-dialogue", { headers: { "content-type": "application/json", "x-huijian-visitor": "198.51.100.2" } })).status, 429);
  assert.equal(f.calls(), 1);
});
