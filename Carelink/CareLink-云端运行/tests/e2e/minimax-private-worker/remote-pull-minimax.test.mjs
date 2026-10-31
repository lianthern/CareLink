import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ExactHttpsClient } from "../../../infra/integration/mac-codex-private-worker/https-transport.mjs";
import { PRIVATE_AI_BASE, PRIVATE_AI_PROTOCOL, PrivateAiPullProtocol, RemotePrivateAiPullWorker } from
  "../../../infra/integration/mac-codex-private-worker/remote-pull.mjs";
import { createMiniMaxPhotoAnalyzer, MINIMAX_WORKER_VISION_POLICY_HASH, MINIMAX_WORKER_VISION_PROMPT_HASH } from
  "../../../infra/integration/minimax-private-worker/minimax-vision-analyzer.mjs";
import { runWorkerLoop } from "../../../infra/integration/minimax-private-worker/worker.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const projectPhoto = path.resolve(here, "../../../apps/web/assets/photos/photo-1.jpg");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const MODEL = "MiniMax-M3";
const MODEL_VERSION = "minimax-private-worker/1/MiniMax-M3";
const TOKEN = "test_minimax_private_worker_token_0123456789abcdef";
const HEADERS = { "content-type": "application/json", "cache-control": "no-store, private",
  "x-unseen-protocol": PRIVATE_AI_PROTOCOL };

function minimaxFetch(replies) {
  let call = 0;
  return async () => {
    const reply = replies[Math.min(call, replies.length - 1)];
    call += 1;
    if (typeof reply === "function") return reply();
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: reply } }] }) };
  };
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "unseen-minimax-remote-pull-test-"));
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
    promptHash: MINIMAX_WORKER_VISION_PROMPT_HASH, policyHash: MINIMAX_WORKER_VISION_POLICY_HASH,
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
        const job = state.jobs.length > 0 ? state.jobs[0] : null;
        return send(200, { schema: "unseen-private-ai-lease-response/1", job, retryAfterMs: 1_000 });
      }
      if (request.url?.endsWith("/image")) {
        state.imageGets += 1;
        assert.equal(request.headers["x-unseen-ai-lease"], state.jobs[0].leaseId);
        return send(200, image, { "content-type": state.jobs[0].mediaMime, "content-length": String(image.length),
          etag: `"${state.jobs[0].mediaSha256}"`, "x-unseen-content-sha256": state.jobs[0].mediaSha256 });
      }
      if (request.url?.endsWith("/complete") || request.url?.endsWith("/fail")) {
        const parsed = JSON.parse(body);
        state.terminalBodies.push(parsed);
        const isFail = request.url.endsWith("/fail");
        const retryable = ["model_unavailable", "model_quota_exhausted", "model_timeout", "worker_aborted",
          "worker_internal_failure"].includes(parsed.failureCode);
        return send(200, { schema: "unseen-private-ai-terminal-response/1",
          status: isFail && retryable ? "retry" : isFail ? "failed" : "completed",
          replayed: state.terminalBodies.length > 1, retryAfterMs: isFail && retryable ? 1_000 : null });
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
  const protocol = new PrivateAiPullProtocol({ client, promptHash: MINIMAX_WORKER_VISION_PROMPT_HASH,
    policyHash: MINIMAX_WORKER_VISION_POLICY_HASH, model: MODEL, modelVersion: MODEL_VERSION });
  return { directory, image, state, makeJob, protocol };
}

function worker(protocol, { fetchReplies, resolveJobContext, overrides = {} } = {}) {
  const analyze = fetchReplies ? createMiniMaxPhotoAnalyzer({ apiKey: "test-minimax-key-not-production", model: MODEL,
    modelVersion: MODEL_VERSION, fetchImpl: minimaxFetch(fetchReplies), resolveJobContext }) :
    async () => { throw new Error("analyze should not be called in this test"); };
  return new RemotePrivateAiPullWorker({ protocol, minimumLeaseRemainingMs: 30_000, cleanupBudgetMs: 2_000,
    preflight: async () => {}, analyze, ...overrides });
}

test("end to end: lease -> download real photo bytes -> MiniMax vision call -> compliant complete()", async (t) => {
  const { protocol, state } = await fixture(t);
  const current = worker(protocol, { fetchReplies:
    ['{"modelVisibleFacts":["桌上放着一个野餐篮"],"question":"这个野餐篮是准备去哪里用的呀？"}'] });
  assert.deepEqual(await current.runOnce(), { status: "completed", retryAfterMs: null });
  assert.equal(state.imageGets, 1);
  assert.deepEqual(state.terminalBodies, [{ schema: "unseen-private-ai-complete-request/1",
    leaseId: state.jobs[0].leaseId, inputHash: state.jobs[0].inputHash,
    result: { modelVisibleFacts: ["桌上放着一个野餐篮"], question: "这个野餐篮是准备去哪里用的呀？",
      questionIntent: "photo_context", model: MODEL, modelVersion: MODEL_VERSION,
      latencyMs: state.terminalBodies[0].result.latencyMs } }]);
});

test("end to end: an honest MiniMax abstain retries the job (model_unavailable), never completes with a fabricated fact", async (t) => {
  const { protocol, state } = await fixture(t);
  const current = worker(protocol, { fetchReplies: ['{"modelVisibleFacts":[],"question":""}'] });
  assert.equal((await current.runOnce()).status, "retry");
  assert.equal(state.terminalBodies.at(-1).failureCode, "model_unavailable");
});

test("end to end: non-compliant twice abstains terminally with result_policy_rejected (no third MiniMax call)", async (t) => {
  const { protocol, state } = await fixture(t);
  let calls = 0;
  const current = worker(protocol, { fetchReplies: [
    () => { calls += 1; return { ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: '{"modelVisibleFacts":["桌上放着一个野餐篮"],"question":"今天天气怎么样？"}' } }] }) }; },
    () => { calls += 1; return { ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: '{"modelVisibleFacts":["桌上放着一个野餐篮"],"question":"心情如何？"}' } }] }) }; }
  ] });
  assert.equal((await current.runOnce()).status, "failed");
  assert.equal(state.terminalBodies.at(-1).failureCode, "result_policy_rejected");
  assert.equal(calls, 2);
});

test("end to end: MiniMax network failure backs off and retries via the reused server-driven retryAfterMs", async (t) => {
  const { protocol, state } = await fixture(t);
  const current = worker(protocol, { fetchReplies: [() => { throw new Error("ECONNRESET"); }] });
  assert.equal((await current.runOnce()).status, "retry");
  assert.equal(state.terminalBodies.at(-1).failureCode, "model_unavailable");
  assert.equal(state.terminalBodies.at(-1).schema ?? "unseen-private-ai-fail-request/1",
    "unseen-private-ai-fail-request/1");
});

test("follow-up context flows through the v2 lease into the real MiniMax prompt", async (t) => {
  const { protocol, state, makeJob } = await fixture(t);
  state.jobs[0] = makeJob({ schema: "unseen-private-ai-job/2", questionContext: {
    kind: "followup_question", followupOrdinal: 1, followupLimit: 3,
    priorVisibleFacts: ["桌上放着一个野餐篮"], priorQuestion: "这个野餐篮是准备去哪里用的呀？",
    userAnswerText: "是去公园野餐用的"
  } });
  const current = worker(protocol, {
    fetchReplies: ['{"modelVisibleFacts":["野餐篮旁边有一条格纹毯子"],"question":"这条格纹毯子是特意挑选的吗？"}']
  });
  assert.deepEqual(await current.runOnce(), { status: "completed", retryAfterMs: null });
  assert.equal(state.terminalBodies.at(-1).result.question, "这条格纹毯子是特意挑选的吗？");
});

test("a follow-up round past its configured limit abstains as result_policy_rejected without an image re-download or MiniMax call", async (t) => {
  const { protocol, state } = await fixture(t);
  let minimaxCalled = false;
  const analyze = createMiniMaxPhotoAnalyzer({ apiKey: "k", model: MODEL, modelVersion: MODEL_VERSION,
    fetchImpl: async () => { minimaxCalled = true; return { ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: "{}" } }] }) }; },
    resolveJobContext: async () => ({ kind: "followup_question", followupOrdinal: 2, followupLimit: 1 }) });
  const current = new RemotePrivateAiPullWorker({ protocol, minimumLeaseRemainingMs: 30_000, cleanupBudgetMs: 2_000,
    preflight: async () => {}, analyze });
  assert.equal((await current.runOnce()).status, "failed");
  assert.equal(state.terminalBodies.at(-1).failureCode, "result_policy_rejected");
  assert.equal(minimaxCalled, false);
});

test("runWorkerLoop finishes an in-flight lease (its own complete/fail call lands) before honoring a stop signal", async (t) => {
  const { protocol, state } = await fixture(t);
  let releaseMiniMax;
  const gate = new Promise((resolve) => { releaseMiniMax = resolve; });
  const current = worker(protocol, { fetchReplies: [async () => {
    await gate;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message:
      { content: '{"modelVisibleFacts":["桌上放着一个野餐篮"],"question":"这个野餐篮是准备去哪里用的呀？"}' } }] }) };
  }] });
  const controller = new AbortController();
  const loopDone = runWorkerLoop(current, { stopSignal: controller.signal,
    sleep: async () => { throw new Error("must not sleep: loop should stop right after the in-flight cycle"); } });
  // Give the loop a tick to actually enter runOnce() and reach the gated MiniMax call before we signal stop.
  while (state.imageGets === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  assert.equal(state.terminalBodies.length, 0, "the in-flight cycle must not be cut short by the stop signal");
  releaseMiniMax();
  await loopDone;
  assert.equal(state.terminalBodies.length, 1, "the in-flight cycle must reach its own complete() call before exit");
  assert.equal(state.terminalBodies[0].schema, "unseen-private-ai-complete-request/1");
});

test("runWorkerLoop wakes an idle poll sleep immediately on stop instead of waiting out the jittered backoff", async (t) => {
  const { protocol, state } = await fixture(t);
  state.jobs.length = 0; // idle: lease() returns job:null every time
  const controller = new AbortController();
  let sleepStarted = false;
  const loopDone = runWorkerLoop(worker(protocol, { fetchReplies: [] }), { stopSignal: controller.signal,
    sleep: async (_ms, stopSignal) => { sleepStarted = true;
      await new Promise((resolve) => stopSignal.addEventListener("abort", resolve, { once: true })); } });
  while (!sleepStarted) await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await loopDone;
});
