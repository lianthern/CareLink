import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { canClearWorldPendingAfterError } from "../public/unseen-app-world.js";
const cwd = fileURLToPath(new URL("..", import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const requestId = "first-visit-world-request-0001";
const requestBody = JSON.stringify({
  mode: "single", image: `data:image/jpeg;base64,${Buffer.alloc(300, 9).toString("base64")}`,
  publicConsent: true, clientRequestId: requestId
});
const operation = { operation_id: "first-visit-operation-0001", done: false, metadata: { progress: { status: "PROCESSING" } } };

// Crucially this fixture does NOT call GET /jobs, seed a cookie or manufacture an owner.
// Boot only waits for health. The test must exercise the user's first HTTP interaction itself.
async function fixture(t, handler) {
  const directory = await mkdtemp(join(tmpdir(), "world-first-visit-http-"));
  const upstreamCalls = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamCalls.push({ path: req.url, method: req.method, body: Buffer.concat(chunks).toString("utf8") });
    res.setHeader("content-type", "application/json");
    if (handler) return handler(req, res);
    res.end(JSON.stringify(operation));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const children = [];
  t.after(async () => {
    for (const child of children) await child.stop();
    upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  async function boot() {
    const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
    const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
    const processChild = spawn(process.execPath, ["server.mjs"], {
      cwd, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PORT: String(port), STATE_DIRECTORY: directory,
        MINIMAX_API_KEY: "not-a-real-local-first-visit-fixture", WORLDLABS_API_KEY: "not-a-real-local-first-visit-fixture",
        MINIMAX_BASE_URL: "http://127.0.0.1:1", WORLDLABS_BASE_URL: base,
        WORLDLABS_DAILY_LIMIT: "10", WORLDLABS_VISITOR_DAILY_LIMIT: "10" }
    });
    let output = "";
    processChild.stdout.on("data", (chunk) => { output += chunk; });
    processChild.stderr.on("data", (chunk) => { output += chunk; });
    const session = {
      url: `http://127.0.0.1:${port}`,
      async stop() {
        if (processChild.exitCode === null && processChild.signalCode === null) { processChild.kill("SIGTERM"); await once(processChild, "exit"); }
      },
      post(cookie, signal) {
        return fetch(`${this.url}/api/worldlabs/generate`, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: requestBody, signal });
      },
      get(path, cookie) { return fetch(`${this.url}${path}`, { headers: cookie ? { cookie } : {} }); }
    };
    children.push(session);
    for (let i = 0; i < 100; i += 1) {
      if (processChild.exitCode !== null) throw new Error(`server exited: ${output}`);
      try { if ((await session.get("/api/health")).ok) return session; } catch { /* waiting for startup */ }
      await delay(20);
    }
    throw new Error(`server failed to listen: ${output}`);
  }
  return { boot, directory, upstreamCalls, generations: () => upstreamCalls.filter((call) => call.path === "/worlds:generate").length };
}
function bootstrapCookie(response) {
  const header = response.headers.getSetCookie().find((value) => value.startsWith("unseen_world_owner="));
  assert.ok(header, "server must establish an owner before admitting any generation");
  assert.match(header, /^unseen_world_owner=[a-f0-9]{64};/);
  assert.match(header, /HttpOnly/); assert.match(header, /SameSite=Strict/);
  return header.split(";")[0];
}

for (const cookie of [undefined, "unrelated=value", "unseen_world_owner=invalid"]) {
  test(`first paid POST without a valid owner (${cookie ?? "no cookie at all"}) bootstraps with 428 and zero upstream`, async (t) => {
    const f = await fixture(t);
    const session = await f.boot();
    const response = await session.post(cookie);
    assert.equal(response.status, 428);
    assert.deepEqual(await response.json(), { error: "world_session_required" });
    const established = bootstrapCookie(response);
    assert.equal(f.generations(), 0);
    assert.equal(f.upstreamCalls.length, 0);
    await assert.rejects(readFile(join(f.directory, "world-jobs.json")), { code: "ENOENT" });
    await assert.rejects(readFile(join(f.directory, "worldlabs-usage.json")), { code: "ENOENT" });
    const jobs = await (await session.get("/api/worldlabs/jobs", established)).json();
    assert.deepEqual(jobs.jobs, []);
    assert.equal((await (await session.get("/api/worldlabs/config", established)).json()).quota.remainingToday, 10);
  });
}

test("a browser that does not retain bootstrap cookies cannot accidentally incur paid generations", async (t) => {
  const f = await fixture(t);
  const session = await f.boot();
  const bootstrap = await session.get("/api/worldlabs/jobs");
  assert.equal(bootstrap.status, 200);
  bootstrapCookie(bootstrap); // Deliberately discarded: this models cookies being disabled.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await session.post();
    assert.equal(response.status, 428);
    assert.equal((await response.json()).error, "world_session_required");
  }
  assert.equal(f.generations(), 0);
  assert.equal((await (await session.get("/api/worldlabs/config")).json()).quota.remainingToday, 10);
});

test("true first visit GET bootstrap → POST accepted upstream → client abort → refresh and restart recover same owner/job", { timeout: 15_000 }, async (t) => {
  let markReceived;
  let completeUpstream;
  const received = new Promise((resolve) => { markReceived = resolve; });
  const f = await fixture(t, (req, res) => {
    if (req.url !== "/worlds:generate") return res.end(JSON.stringify(operation));
    // Keep the paid POST response pending: the browser must abort before it receives a response.
    completeUpstream = () => res.end(JSON.stringify(operation));
    markReceived();
  });
  const session = await f.boot();
  const bootstrap = await session.get("/api/worldlabs/jobs");
  assert.equal(bootstrap.status, 200);
  assert.deepEqual(await bootstrap.json(), { jobs: [] });
  const cookie = bootstrapCookie(bootstrap);
  assert.equal(f.upstreamCalls.length, 0);
  const controller = new AbortController();
  const aborted = assert.rejects(session.post(cookie, controller.signal), { name: "AbortError" });
  await received;
  assert.equal(f.generations(), 1);
  controller.abort();
  await aborted;
  completeUpstream();
  let recovered;
  for (let i = 0; i < 100; i += 1) {
    const result = await (await session.get("/api/worldlabs/jobs", cookie)).json();
    recovered = result.jobs.find((job) => job.id === requestId);
    if (recovered?.status === "processing") break;
    await delay(10);
  }
  assert.equal(recovered?.status, "processing");
  assert.equal(recovered.operation.id, operation.operation_id);
  assert.equal(f.generations(), 1);
  assert.equal((await (await session.get("/api/worldlabs/config", cookie)).json()).quota.remainingToday, 9);
  await session.stop();
  const restarted = await f.boot();
  const afterRestart = await (await restarted.get(`/api/worldlabs/jobs/${requestId}`, cookie)).json();
  assert.equal(afterRestart.job.id, requestId);
  assert.equal(afterRestart.job.operation.id, operation.operation_id);
  const replay = await restarted.post(cookie);
  assert.equal(replay.status, 202);
  assert.equal((await replay.json()).operation.id, operation.operation_id);
  assert.equal(f.generations(), 1, "same request recovery must not generate a second paid World");
  const outsider = await restarted.get(`/api/worldlabs/jobs/${requestId}`);
  assert.equal(outsider.status, 404);
});

test("only exact same-request 428 world_session_required can clear a pre-admission pending marker", () => {
  const error = { status: 428, data: { error: "world_session_required" } };
  assert.equal(canClearWorldPendingAfterError(requestId, error, requestId), true);
  assert.equal(canClearWorldPendingAfterError(requestId, error, "other-request-0001"), false);
  assert.equal(canClearWorldPendingAfterError(requestId, { status: 428, data: { error: "world_result_pending_reconciliation" } }, requestId), false);
  assert.equal(canClearWorldPendingAfterError(requestId, { status: 428, data: { error: "unknown" } }, requestId), false);
  assert.equal(canClearWorldPendingAfterError(requestId, { status: 503, data: { error: "world_session_required" } }, requestId), false);
});

test("an immediately failed accepted operation is stored as failed, consumes quota and never polls or resubmits", async (t) => {
  const failed = { operation_id: "accepted-immediate-failure-0001", done: true, error: { code: 13, message: "Generation failed after acceptance" } };
  const f = await fixture(t, (_req, res) => res.end(JSON.stringify(failed)));
  const session = await f.boot();
  const cookie = bootstrapCookie(await session.get("/api/worldlabs/jobs"));
  const generated = await session.post(cookie);
  assert.equal(generated.status, 202);
  const accepted = await generated.json();
  assert.equal(accepted.operation.done, true);
  assert.deepEqual(accepted.operation.error, failed.error);
  const listed = await (await session.get("/api/worldlabs/jobs", cookie)).json();
  assert.equal(listed.jobs.length, 1);
  assert.equal(listed.jobs[0].status, "failed");
  assert.equal(listed.jobs[0].operation.id, failed.operation_id);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const refresh = await session.get(`/api/worldlabs/jobs/${requestId}`, cookie);
    assert.equal(refresh.status, 200);
    assert.equal((await refresh.json()).job.status, "failed");
    const replay = await session.post(cookie);
    assert.equal(replay.status, 202);
    assert.equal((await replay.json()).job.status, "failed");
  }
  assert.equal(f.generations(), 1);
  assert.equal(f.upstreamCalls.length, 1, "terminal failed jobs must not poll or submit again");
  assert.equal((await (await session.get("/api/worldlabs/config", cookie)).json()).quota.remainingToday, 9,
    "accepted generation failures do not refund admission quota");
});
