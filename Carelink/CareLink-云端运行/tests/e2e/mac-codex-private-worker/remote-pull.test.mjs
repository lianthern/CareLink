import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ExactHttpsClient } from "../../../infra/integration/mac-codex-private-worker/https-transport.mjs";
import { PRIVATE_AI_BASE, PRIVATE_AI_PROTOCOL, PrivateAiPullProtocol, RemotePrivateAiPullWorker,
  runPullLoop } from "../../../infra/integration/mac-codex-private-worker/remote-pull.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const projectPhoto = path.resolve(here, "../../../apps/web/assets/photos/photo-1.jpg");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const PROMPT_HASH = hash("photo_visible_facts_question_v1/prompt");
const POLICY_HASH = hash("photo_visible_facts_question_v1/policy");
const MODEL = "gpt-test";
const MODEL_VERSION = "codex-cli-test/gpt-test";
const TOKEN = "test_private_worker_token_0123456789abcdef";
const HEADERS = { "content-type": "application/json", "cache-control": "no-store, private",
  "x-unseen-protocol": PRIVATE_AI_PROTOCOL };

function result() {
  return { modelVisibleFacts: ["桌面上放着一张手写卡片"], question: "拍下这张照片时，卡片是谁放在这里的？",
    questionIntent: "photo_context", model: MODEL, modelVersion: MODEL_VERSION, latencyMs: 123 };
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "unseen-remote-pull-test-"));
  await chmod(directory, 0o700);
  const key = path.join(directory, "server.key.pem");
  const cert = path.join(directory, "server.cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
    "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
  const tokenPath = path.join(directory, "worker.token");
  await writeFile(tokenPath, TOKEN, { mode: 0o600 });
  const image = await readFile(projectPhoto);
  const state = { mode: "valid", jobs: [], terminalBodies: [], imageGets: 0 };
  const makeJob = (overrides = {}) => ({ schema: "unseen-private-ai-job/1",
    jobId: "paij_0123456789abcdef0123456789abcdef", leaseId: "pail_fedcba9876543210fedcba9876543210",
    taskType: "photo_visible_facts_question_v1", attempt: 1, maxAttempts: 3,
    leaseExpiresAt: new Date(Date.now() + 180_000).toISOString(), inputHash: hash("input"),
    mediaSha256: hash(image), mediaBytes: image.length, mediaMime: "image/jpeg",
    promptHash: PROMPT_HASH, policyHash: POLICY_HASH,
    imagePath: `${PRIVATE_AI_BASE}/jobs/paij_0123456789abcdef0123456789abcdef/image`, ...overrides });
  state.jobs.push(makeJob());
  const server = https.createServer({ key: await readFile(key), cert: await readFile(cert) },
    async (request, response) => {
      const send = (status, body, headers = {}) => response.writeHead(status, { ...HEADERS, ...headers })
        .end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
      if (request.headers.authorization !== `Bearer ${TOKEN}` ||
        request.headers["x-unseen-protocol"] !== PRIVATE_AI_PROTOCOL) return send(401, {});
      const body = await new Promise((resolve) => {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });
      if (request.url === `${PRIVATE_AI_BASE}/jobs/lease`) {
        if (state.mode === "disconnect-lease") return request.socket.destroy();
        const parsed = JSON.parse(body);
        assert.deepEqual(parsed, { schema: "unseen-private-ai-lease-request/1" });
        const job = state.jobs.length > 0 ? state.jobs[0] : null;
        return send(200, { schema: "unseen-private-ai-lease-response/1", job, retryAfterMs: 1_000 },
          state.mode === "bad-protocol" ? { "x-unseen-protocol": "wrong/1" } : {});
      }
      if (request.url?.endsWith("/image")) {
        state.imageGets += 1;
        if (state.mode === "disconnect-image") return request.socket.destroy();
        assert.equal(request.headers["x-unseen-ai-lease"], state.jobs[0].leaseId);
        const bytes = state.mode === "bad-image" ? Buffer.alloc(image.length, 1) : image;
        return send(200, bytes, { "content-type": state.jobs[0].mediaMime,
          "content-length": String(bytes.length), etag: `"${state.jobs[0].mediaSha256}"`,
          "x-unseen-content-sha256": state.mode === "bad-hash" ? hash("tamper") : state.jobs[0].mediaSha256 });
      }
      if (request.url?.endsWith("/complete") || request.url?.endsWith("/fail")) {
        const parsed = JSON.parse(body);
        state.terminalBodies.push(parsed);
        const isFail = request.url.endsWith("/fail");
        return send(200, { schema: "unseen-private-ai-terminal-response/1",
          status: isFail && ["model_unavailable", "model_quota_exhausted", "model_timeout", "worker_aborted",
            "worker_internal_failure"].includes(parsed.failureCode) ? "retry" : isFail ? "failed" : "completed",
          replayed: state.terminalBodies.length > 1,
          retryAfterMs: isFail && ["model_unavailable", "model_quota_exhausted", "model_timeout", "worker_aborted",
            "worker_internal_failure"].includes(parsed.failureCode) ? 1_000 : null });
      }
      return send(404, {});
    });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "localhost", resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const client = new ExactHttpsClient({ origin: `https://localhost:${server.address().port}`,
    expectedHostname: "localhost", tokenPath, tokenUid: process.getuid(), timeoutMs: 2_000,
    tlsPolicy: { mode: "ca-file", caFile: cert } });
  const protocol = new PrivateAiPullProtocol({ client, promptHash: PROMPT_HASH, policyHash: POLICY_HASH,
    model: MODEL, modelVersion: MODEL_VERSION });
  return { directory, image, state, makeJob, protocol };
}

function worker(protocol, overrides = {}) {
  return new RemotePrivateAiPullWorker({ protocol, minimumLeaseRemainingMs: 30_000, cleanupBudgetMs: 2_000,
    preflight: async () => {}, analyze: async () => result(), ...overrides });
}

test("valid TLS pull runs preflight before image, completes strict DTO and removes the temporary photo", async (t) => {
  const { protocol, state } = await fixture(t);
  const order = [];
  let downloadedPath;
  const diagnostics = [];
  const current = worker(protocol, { preflight: async () => order.push("preflight"), analyze: async ({ imagePath }) => {
    order.push("image");
    downloadedPath = imagePath;
    assert.ok((await readFile(imagePath)).length > 0);
    return result();
  }, onDiagnostic: (event) => diagnostics.push(event) });
  assert.deepEqual(await current.runOnce(), { status: "completed", retryAfterMs: null });
  assert.deepEqual(order, ["preflight", "image"]);
  await assert.rejects(access(downloadedPath));
  assert.deepEqual(state.terminalBodies, [{ schema: "unseen-private-ai-complete-request/1",
    leaseId: state.jobs[0].leaseId, inputHash: state.jobs[0].inputHash, result: result() }]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /手写卡片|test_private_worker_token/u);
});

test("bad bytes and unsupported MIME fail closed while keeping analysis uncalled", async (t) => {
  const { protocol, state, makeJob } = await fixture(t);
  let calls = 0;
  state.mode = "bad-image";
  let current = worker(protocol, { analyze: async () => { calls += 1; return result(); } });
  assert.equal((await current.runOnce()).status, "failed");
  assert.equal(state.terminalBodies.at(-1).failureCode, "image_invalid");
  assert.equal(calls, 0);
  state.mode = "valid";
  state.jobs[0] = makeJob({ mediaMime: "image/webp" });
  current = worker(protocol, { analyze: async () => { calls += 1; return result(); } });
  assert.equal((await current.runOnce()).status, "failed");
  assert.equal(state.terminalBodies.at(-1).failureCode, "image_unsupported");
  assert.equal(calls, 0);
});

test("lease budget, timeout, quota and invalid model result map to the exact server failure allowlist", async (t) => {
  const { protocol, state, makeJob } = await fixture(t);
  const cases = [["model_timeout", "model_timeout"], ["model_quota_exhausted", "model_quota_exhausted"],
    ["codex_unavailable", "model_unavailable"], ["anything_else", "worker_internal_failure"]];
  for (const [source, expected] of cases) {
    state.jobs[0] = makeJob();
    const current = worker(protocol, { analyze: async () => { const error = new Error(source); error.code = source;
      throw error; } });
    assert.equal((await current.runOnce()).status, "retry");
    assert.equal(state.terminalBodies.at(-1).failureCode, expected);
  }
  state.jobs[0] = makeJob({ leaseExpiresAt: new Date(Date.now() + 1_000).toISOString() });
  assert.equal((await worker(protocol).runOnce()).status, "retry");
  assert.equal(state.terminalBodies.at(-1).failureCode, "worker_aborted");
  state.jobs[0] = makeJob();
  const invalid = { ...result(), question: "不是问题" };
  assert.equal((await worker(protocol, { analyze: async () => invalid }).runOnce()).status, "failed");
  assert.equal(state.terminalBodies.at(-1).failureCode, "result_policy_rejected");
});

test("disconnect leaves the leased job untouched for server expiry; duplicate terminal replay stays idempotent", async (t) => {
  const { protocol, state, makeJob } = await fixture(t);
  state.mode = "disconnect-image";
  assert.deepEqual(await worker(protocol).runOnce(),
    { status: "offline", retryAfterMs: 5_000, errorCode: "transport_unavailable" });
  assert.equal(state.terminalBodies.length, 0);
  state.mode = "valid";
  state.jobs[0] = makeJob({ attempt: 2, leaseId: "pail_33333333333333333333333333333333" });
  assert.equal((await worker(protocol).runOnce()).status, "completed");
  assert.equal((await worker(protocol).runOnce()).status, "completed");
  assert.equal(state.terminalBodies.length, 2);
});

test("wrong protocol version is rejected before image acceptance", async (t) => {
  const { protocol, state } = await fixture(t);
  state.mode = "bad-protocol";
  assert.deepEqual(await worker(protocol).runOnce(),
    { status: "offline", retryAfterMs: 5_000, errorCode: "protocol_header_rejected" });
  assert.equal(state.imageGets, 0);
});

test("v1 attempt and maxAttempts above ten are rejected before image or analysis", async (t) => {
  const { protocol, state, makeJob } = await fixture(t);
  let analysisCalls = 0;
  for (const overrides of [{ attempt: 11, maxAttempts: 11 }, { attempt: 1, maxAttempts: 11 }]) {
    state.jobs[0] = makeJob(overrides);
    assert.deepEqual(await worker(protocol, { analyze: async () => { analysisCalls += 1; return result(); } }).runOnce(),
      { status: "offline", retryAfterMs: 5_000, errorCode: "lease_job_rejected" });
  }
  assert.equal(state.imageGets, 0);
  assert.equal(analysisCalls, 0);
  assert.equal(state.terminalBodies.length, 0);
});

test("preflight failure cannot lease or download; concurrency is one; loop applies bounded jitter", async (t) => {
  const { protocol, state } = await fixture(t);
  const unavailable = worker(protocol, { preflight: async () => { const error = new Error("unavailable");
    error.code = "codex_unavailable"; throw error; } });
  assert.equal((await unavailable.runOnce()).status, "offline");
  assert.equal(state.imageGets, 0);

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const current = worker(protocol, { analyze: async () => { await gate; return result(); } });
  const first = current.runOnce();
  while (state.imageGets === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(await current.runOnce(), { status: "busy", retryAfterMs: 1_000 });
  release();
  assert.equal((await first).status, "completed");

  const controller = new AbortController();
  const sleeps = [];
  state.jobs.length = 0;
  await runPullLoop(worker(protocol), { signal: controller.signal, random: () => 0,
    sleep: async (ms) => { sleeps.push(ms); controller.abort(); } });
  assert.deepEqual(sleeps, [1_000]);

  const offlineController = new AbortController();
  const offlineSleeps = [];
  state.mode = "disconnect-lease";
  await runPullLoop(worker(protocol), { signal: offlineController.signal, random: () => 0.5,
    sleep: async (ms) => {
      offlineSleeps.push(ms);
      if (offlineSleeps.length === 2) offlineController.abort();
    } });
  assert.deepEqual(offlineSleeps, [5_000, 10_000]);
});

// Every test above (including the "loop applies bounded jitter" one right before this) always injects its own
// `sleep` option, so none of them ever exercise runPullLoop's actual default idle-sleep branch — the raw
// `setTimeout` this file's own `daemon.mjs` relies on with no injected sleep at all. That branch is exactly
// where the unref bug lived (fixed 2026-08-17: a bare `setTimeout(...).unref()` with no other ref'd handle in
// the process made the daemon exit near-instantly and silently between polls). A same-process test can't catch
// a regression here — the test runner itself has plenty of other ref'd handles keeping the event loop alive
// regardless of whether this one timer is ref'd — so this spawns a real, otherwise-idle child process (see
// remote-pull-idle-timer-helper.mjs) and proves it survives multiple real idle sleeps before exiting cleanly.
test("runPullLoop's default idle-sleep timer (no injected sleep) keeps an otherwise-idle process alive across real sleeps", () => {
  const helper = path.resolve(here, "remote-pull-idle-timer-helper.mjs");
  const started = Date.now();
  const child = spawnSync(process.execPath, [helper], { encoding: "utf8", timeout: 15_000 });
  const elapsedMs = Date.now() - started;
  assert.equal(child.status, 0, `helper exited abnormally: status=${child.status} signal=${child.signal} stderr=${child.stderr}`);
  const leaseLines = child.stdout.trim().split("\n").filter((line) => line.startsWith("lease "));
  assert.equal(leaseLines.length, 3, `expected 3 lease calls, got:\n${child.stdout}`);
  // The regression this guards against is a near-0ms exit (Node saw an empty event loop and left before the
  // first idle sleep even finished). Two real ~1s idle sleeps must have elapsed between the 1st and 3rd lease
  // call for this to be a genuine pass; a generous floor avoids flaking on a loaded CI box.
  assert.ok(elapsedMs >= 1_500, `helper exited too fast (${elapsedMs}ms) — idle timer is likely unref'd again`);
});
