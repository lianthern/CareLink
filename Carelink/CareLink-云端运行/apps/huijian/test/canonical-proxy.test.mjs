import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { isCanonicalPath } from "../lib/canonical-proxy.mjs";
const cwd = fileURLToPath(new URL("..", import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(t, handler, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "unseen-canonical-proxy-"));
  const requests = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks) });
    handler(req, res);
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), STATE_DIRECTORY: directory,
      MINIMAX_API_KEY: "not-a-real-local-canonical-test", WORLDLABS_API_KEY: "not-a-real-local-canonical-test",
      MINIMAX_BASE_URL: "http://127.0.0.1:1", WORLDLABS_BASE_URL: "http://127.0.0.1:1",
      CANONICAL_UPSTREAM: upstreamUrl, CANONICAL_PUBLIC_ORIGIN: options.publicOrigin || upstreamUrl }
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) throw new Error(`server exited: ${output}`);
    try { if ((await fetch(`${url}/api/health`)).ok) return { url, port, requests, upstreamUrl }; } catch { /* wait for listen */ }
    await delay(20);
  }
  throw new Error(`server failed to start: ${output}`);
}

test("canonical proxy exposes only frozen API, media and Book Lab source prefixes", () => {
  for (const path of ["/v1/auth/session", "/v2-labs/books", "/__local/media/photo.jpg", "/__local-operable/private-media/photo.jpg", "/__book_lab_web__/src/editor.mjs", "/__book_lab_web__/catalog.json"]) assert.equal(isCanonicalPath(path), true, path);
  for (const path of ["/", "/api/health", "/private", "/__local/secrets", "/__book_lab_web__/index.html", "/__book_lab_web__/src/secrets.json", "https://foreign.example/v1/me"]) assert.equal(isCanonicalPath(path), false, path);
});

test("server entry rejects malicious Origin and cross-site marker before canonical proxy", async (t) => {
  const f = await fixture(t, (_req, res) => res.end("must not be contacted"));
  for (const headers of [{ origin: "https://malicious.example" }, { "sec-fetch-site": "cross-site" }]) {
    const response = await fetch(`${f.url}/v1/auth/session`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
    assert.equal(response.status, 403);
  }
  assert.equal(f.requests.length, 0);
});

test("canonical session cookies and private media byte stream survive the real HTTP proxy", async (t) => {
  const bytes = Buffer.from([0, 255, 1, 128, 13, 10, 45]);
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "public, max-age=3600", "set-cookie": ["session=secret-test; Path=/; HttpOnly; SameSite=Lax", "csrf=local-test; Path=/; SameSite=Lax"] });
    res.write(bytes.subarray(0, 3));
    res.end(bytes.subarray(3));
  });
  const response = await fetch(`${f.url}/__local-operable/private-media/own-photo.jpg?version=2`, { headers: { cookie: "session=local-test", authorization: "Bearer local-test-token" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.getSetCookie().length, 2);
  assert.match(response.headers.getSetCookie()[0], /session=secret-test; Path=\/; HttpOnly/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(f.requests[0].headers.cookie, "session=local-test");
  assert.equal(f.requests[0].headers.authorization, "Bearer local-test-token");
  assert.equal(f.requests[0].url, "/__local-operable/private-media/own-photo.jpg?version=2");
});

test("canonical proxy forwards authorized JSON body and rewrites only trusted origin/host", async (t) => {
  const f = await fixture(t, (_req, res) => { res.writeHead(201, { "content-type": "application/json" }); res.end('{"created":true}'); }, { publicOrigin: "https://canonical.example" });
  const body = JSON.stringify({ title: "本地活动测试", private: true });
  const response = await fetch(`${f.url}/v1/spaces`, {
    method: "POST", headers: { "content-type": "application/json", origin: f.url,
      "x-forwarded-host": "malicious.example", "x-forwarded-for": "198.51.100.222", "x-forwarded-proto": "ftp" }, body
  });
  assert.equal(response.status, 201);
  assert.equal(f.requests[0].body.toString("utf8"), body);
  assert.equal(f.requests[0].headers.host, "canonical.example");
  assert.equal(f.requests[0].headers.origin, "https://canonical.example");
  for (const key of ["x-forwarded-host", "x-forwarded-proto", "x-huijian-visitor"]) assert.equal(f.requests[0].headers[key], undefined);
  assert.equal(f.requests[0].headers['x-forwarded-for'], '127.0.0.1');
});

test("canonical risk identity keeps different trusted visitors separate and rejects ambiguous headers", async (t) => {
  const f = await fixture(t, (_req, res) => res.end('{}'));
  for (const visitor of ['198.51.100.10', '198.51.100.11', '2001:db8::12', '198.51.100.10, 198.51.100.11', 'invalid']) {
    const response = await fetch(`${f.url}/v1/auth/session`, { headers: {
      'x-huijian-visitor': visitor, 'x-forwarded-for': '203.0.113.99'
    } });
    await response.text();
  }
  assert.deepEqual(f.requests.map(entry => entry.headers['x-forwarded-for']),
    ['198.51.100.10', '198.51.100.11', '2001:db8::12', '127.0.0.1', '127.0.0.1']);
  assert.ok(f.requests.every(entry => entry.headers['x-huijian-visitor'] === undefined));
});

test("unlisted and normalized traversal paths cannot turn the server into an arbitrary proxy", async (t) => {
  const f = await fixture(t, (_req, res) => res.end("must not be contacted"));
  for (const path of ["/private-administration", "/__local/secrets", "/v1/%2e%2e/private-administration", "/__book_lab_web__/src/../../private-administration"]) {
    const response = await fetch(`${f.url}${path}`);
    assert.equal(response.status, 404);
  }
  const foreignAbsoluteStatus = await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: f.port, path: "http://untrusted.invalid/v1/session" }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject); req.end();
  });
  assert.ok(foreignAbsoluteStatus >= 400);
  assert.equal(f.requests.length, 0);
  assert.equal((await fetch(`${f.url}/api/health`)).status, 200);
});

test("cross-origin canonical redirect is not exposed as a navigation out of the new App", async (t) => {
  const f = await fixture(t, (_req, res) => { res.writeHead(302, { location: "https://untrusted.example/full-old-ui" }); res.end(); });
  const response = await fetch(`${f.url}/v1/redirect`, { redirect: "manual" });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), null);
});

test("private media client disconnect closes the unfinished upstream stream", { timeout: 10_000 }, async (t) => {
  let signalClosed;
  const closed = new Promise((resolve) => { signalClosed = resolve; });
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { "content-type": "image/jpeg" });
    res.write(Buffer.from([1, 2, 3]));
    res.once("close", signalClosed);
  });
  const controller = new AbortController();
  const response = await fetch(`${f.url}/__local-operable/private-media/slow.jpg`, { signal: controller.signal });
  const reader = response.body.getReader();
  assert.deepEqual((await reader.read()).value, Uint8Array.from([1, 2, 3]));
  controller.abort();
  await closed;
  assert.equal(f.requests.length, 1);
});

test("malformed upstream Location cannot exit the App server", async (t) => {
  const f = await fixture(t, (_req, res) => { res.writeHead(302, { location: "http://[" }); res.end(); });
  const response = await fetch(`${f.url}/v1/broken-redirect`);
  assert.equal(response.status, 502);
  assert.equal((await fetch(`${f.url}/api/health`)).status, 200);
});

test("truncated private upstream media fails the stream without terminating the App server", { timeout: 10_000 }, async (t) => {
  let truncate;
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { "content-type": "image/jpeg", "content-length": "1000" });
    res.write(Buffer.from([1, 2, 3]));
    truncate = () => res.destroy();
  });
  const response = await fetch(`${f.url}/__local-operable/private-media/truncated.jpg`, { signal: AbortSignal.timeout(2000) });
  const reading = assert.rejects(response.arrayBuffer(), (error) => {
    assert.ok(!["AbortError", "TimeoutError"].includes(error.name), "upstream truncation must close the downstream; the client deadline must not be what ends it");
    return true;
  });
  truncate();
  await reading;
  assert.equal((await fetch(`${f.url}/api/health`)).status, 200);
});
