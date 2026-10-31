import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BookLabMemoryApi, FixtureCorePort, sha256 } from "../src/index.mjs";
import { MINIMAX_QUESTION_SYSTEM_PROMPT, MINIMAX_VISION_SYSTEM_PROMPT, MiniMaxProviderError,
  createMiniMaxQuestionProvider } from "../src/providers/minimax-question-provider.mjs";

const FAKE_KEY = "sk-test-not-a-real-minimax-key-0123456789";
const ETAG_SECRET = "test-secret-minimax-provider-etag-not-production-01";
const WORKER_SECRET = "test-secret-minimax-provider-worker-not-production-02";
const CLEANUP_SECRET = "test-secret-minimax-provider-cleanup-not-production-03";

function baseInput(overrides = {}) {
  const controller = new AbortController();
  return {
    jobId: "job-1", attempt: 1, inputHash: sha256("input-hash"), idempotencyKey: sha256("idempotency"),
    kind: "initial_question", visibleFacts: ["舞台旁边摆着一束白色花"], userText: "",
    sourcePhotoId: "photo-1", photoContentHash: sha256("photo-1"), placementRevisionId: "placement-1",
    placementSnapshotHash: sha256("placement-1"), model: "unseen-minimax-question-v1",
    modelVersion: "2026-08-16", promptHash: sha256("prompt"), policyHash: sha256("policy"),
    signal: controller.signal, ...overrides
  };
}

function jsonResponse(body, { status = 200, ok = status >= 200 && status < 300 } = {}) {
  return { ok, status, json: async () => body };
}

function fetchReturning(content, options) {
  return async () => jsonResponse({ choices: [{ message: { content } }] }, options);
}

test("known-facts path calls the text model, preserves facts byte-for-byte, and never leaks the key", async () => {
  let seenUrl;
  let seenHeaders;
  let seenBody;
  const provider = createMiniMaxQuestionProvider({
    apiKey: FAKE_KEY,
    fetchImpl: async (url, init) => {
      seenUrl = url;
      seenHeaders = init.headers;
      seenBody = JSON.parse(init.body);
      return jsonResponse({ choices: [{ message: { content: '{"question":"这束白花是特意为今天准备的吗？"}' } }] });
    }
  });
  const input = baseInput();
  const outcome = await provider(input);
  assert.equal(seenUrl, "https://api.minimaxi.com/v1/chat/completions");
  assert.equal(seenHeaders.authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(seenBody.model, "MiniMax-M2");
  assert.equal(seenBody.messages[0].role, "system");
  assert.equal(seenBody.messages[0].content, MINIMAX_QUESTION_SYSTEM_PROMPT);
  assert.deepEqual(outcome, {
    modelVisibleFacts: ["舞台旁边摆着一束白色花"],
    question: "这束白花是特意为今天准备的吗？",
    questionIntent: "photo_context",
    model: "unseen-minimax-question-v1",
    modelVersion: "2026-08-16",
    latencyMs: outcome.latencyMs
  });
  assert.ok(Number.isSafeInteger(outcome.latencyMs) && outcome.latencyMs >= 0);
  assert.equal(JSON.stringify(outcome).includes(FAKE_KEY), false);
});

test("follow-up path threads the previous answer into the user message", async () => {
  let seenBody;
  const provider = createMiniMaxQuestionProvider({
    apiKey: FAKE_KEY,
    fetchImpl: async (_url, init) => {
      seenBody = JSON.parse(init.body);
      return jsonResponse({ choices: [{ message: { content: '{"question":"后来这束花被带回家了吗？"}' } }] });
    }
  });
  const outcome = await provider(baseInput({ kind: "followup_question", userText: "这是台上表演结束后大家送的" }));
  assert.match(seenBody.messages[1].content, /这是台上表演结束后大家送的/);
  assert.match(seenBody.messages[1].content, /追问/);
  assert.equal(outcome.question, "后来这束花被带回家了吗？");
});

test("model/modelVersion in the outcome always echo the configured input, not the MiniMax model string", async () => {
  const provider = createMiniMaxQuestionProvider({ apiKey: FAKE_KEY, textModel: "MiniMax-M2.5",
    fetchImpl: fetchReturning('{"question":"这是当天准备的吗？"}') });
  const outcome = await provider(baseInput({ model: "book-lab-minimax-question-v1", modelVersion: "v7" }));
  assert.equal(outcome.model, "book-lab-minimax-question-v1");
  assert.equal(outcome.modelVersion, "v7");
});

test("vision path is used only when there are no known facts and a resolver is supplied", async () => {
  let seenBody;
  const provider = createMiniMaxQuestionProvider({
    apiKey: FAKE_KEY,
    resolveImage: async (input) => (input.sourcePhotoId === "photo-1" ? { base64: "Zm9v", mimeType: "image/jpeg" } : null),
    fetchImpl: async (_url, init) => {
      seenBody = JSON.parse(init.body);
      return jsonResponse({ choices: [{ message: { content:
        '{"modelVisibleFacts":["桌上摆着一张手写贺卡"],"question":"这张贺卡是谁写的呀？"}' } }] });
    }
  });
  const outcome = await provider(baseInput({ visibleFacts: [] }));
  assert.equal(seenBody.model, "MiniMax-M3");
  assert.equal(seenBody.messages[0].content, MINIMAX_VISION_SYSTEM_PROMPT);
  const imagePart = seenBody.messages[1].content.find((part) => part.type === "image_url");
  assert.equal(imagePart.image_url.url, "data:image/jpeg;base64,Zm9v");
  assert.deepEqual(outcome.modelVisibleFacts, ["桌上摆着一张手写贺卡"]);
  assert.equal(outcome.question, "这张贺卡是谁写的呀？");
});

test("vision path abstains (throws) instead of fabricating facts when the model returns nothing usable", async () => {
  const provider = createMiniMaxQuestionProvider({
    apiKey: FAKE_KEY, resolveImage: async () => ({ base64: "Zm9v" }),
    fetchImpl: fetchReturning('{"modelVisibleFacts":[],"question":""}')
  });
  await assert.rejects(provider(baseInput({ visibleFacts: [] })), (error) => {
    assert.ok(error instanceof MiniMaxProviderError);
    assert.equal(error.code, "minimax_vision_abstained");
    return true;
  });
});

test("no known facts and no resolver abstains without ever calling MiniMax", async () => {
  let called = false;
  const provider = createMiniMaxQuestionProvider({ apiKey: FAKE_KEY,
    fetchImpl: async () => { called = true; return jsonResponse({}); } });
  await assert.rejects(provider(baseInput({ visibleFacts: [] })), /minimax_no_visible_source/);
  assert.equal(called, false);
});

test("resolver returning null falls through to abstain", async () => {
  const provider = createMiniMaxQuestionProvider({ apiKey: FAKE_KEY, resolveImage: async () => null,
    fetchImpl: async () => jsonResponse({}) });
  await assert.rejects(provider(baseInput({ visibleFacts: [] })), /minimax_no_visible_source/);
});

test("network failure surfaces a plain, retryable error and never leaks the key", async () => {
  const provider = createMiniMaxQuestionProvider({ apiKey: FAKE_KEY,
    fetchImpl: async () => { throw new Error(`ECONNRESET talking to host with key ${FAKE_KEY.slice(0, 4)}...never-full`); } });
  await assert.rejects(provider(baseInput()), (error) => {
    assert.ok(error instanceof MiniMaxProviderError);
    assert.equal(error.code, "minimax_request_failed");
    assert.equal(error.message.includes(FAKE_KEY), false);
    return true;
  });
});

test("HTTP 401/403 map to a stable non-2xx error code, key never in the thrown error", async () => {
  const provider = createMiniMaxQuestionProvider({ apiKey: FAKE_KEY,
    fetchImpl: async () => jsonResponse({ base_resp: { status_code: 1004, status_msg: "auth failed" } }, { status: 401 }) });
  await assert.rejects(provider(baseInput()), (error) => {
    assert.equal(error.code, "minimax_http_401");
    assert.equal(String(error).includes(FAKE_KEY), false);
    return true;
  });
});

test("HTTP 500 maps to a stable non-2xx error code", async () => {
  const provider = createMiniMaxQuestionProvider({ apiKey: FAKE_KEY,
    fetchImpl: async () => jsonResponse({}, { status: 500 }) });
  await assert.rejects(provider(baseInput()), /minimax_http_500/);
});

test("empty content is treated as a failure, not an empty question", async () => {
  const provider = createMiniMaxQuestionProvider({ apiKey: FAKE_KEY, fetchImpl: fetchReturning("") });
  await assert.rejects(provider(baseInput()), /minimax_response_empty/);
});

test("malformed JSON / missing question field fails closed rather than passing through garbage", async () => {
  const notJson = createMiniMaxQuestionProvider({ apiKey: FAKE_KEY, fetchImpl: fetchReturning("sure, here is your answer!") });
  await assert.rejects(notJson(baseInput()), /minimax_question_invalid/);

  const noMark = createMiniMaxQuestionProvider({ apiKey: FAKE_KEY,
    fetchImpl: fetchReturning('{"question":"这束白花是特意为今天准备的"}') });
  await assert.rejects(noMark(baseInput()), /minimax_question_invalid/);

  const twoMarks = createMiniMaxQuestionProvider({ apiKey: FAKE_KEY,
    fetchImpl: fetchReturning('{"question":"真的吗？这束白花是特意为今天准备的吗？"}') });
  await assert.rejects(twoMarks(baseInput()), /minimax_question_invalid/);
});

test("request timeout aborts the fetch and fails closed within the configured budget", async () => {
  let observedSignal;
  const provider = createMiniMaxQuestionProvider({ apiKey: FAKE_KEY, requestTimeoutMs: 20,
    fetchImpl: (_url, init) => {
      observedSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    } });
  const started = Date.now();
  await assert.rejects(provider(baseInput()), /minimax_request_failed/);
  assert.ok(Date.now() - started < 2_000, "timeout must fail well under the test harness default timeout");
  assert.equal(observedSignal.aborted, true);
});

test("the caller's own AbortSignal also aborts the MiniMax request", async () => {
  const controller = new AbortController();
  let observedSignal;
  const provider = createMiniMaxQuestionProvider({ apiKey: FAKE_KEY,
    fetchImpl: (_url, init) => {
      observedSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    } });
  const pending = provider(baseInput({ signal: controller.signal }));
  controller.abort();
  await assert.rejects(pending, /minimax_request_failed/);
  assert.equal(observedSignal.aborted, true);
});

test("constructor rejects a missing/blank API key up front instead of failing per-request", () => {
  assert.throws(() => createMiniMaxQuestionProvider({ apiKey: "" }), /minimax_api_key_required/);
  assert.throws(() => createMiniMaxQuestionProvider({}), /minimax_api_key_required/);
});

test("the module source never calls a logging function (defense in depth against key leakage)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(here, "../src/providers/minimax-question-provider.mjs"), "utf8");
  assert.equal(/console\s*\.\s*(log|info|warn|error|debug)/u.test(source), false,
    "provider must never log; failures propagate as thrown errors only");
});

// --- End-to-end: wired into the real BookLabMemoryApi engine, exactly like production would call it. ---

function e2eCore() {
  const provenance = { spaceId: "space-1", photoId: "photo-1", sceneId: "scene-1", panoramaRevisionId: "pano-1",
    placementRevisionId: "placement-1", nodeId: null, sourcePhotosVersion: 1, yawDegrees: 10,
    capturedAt: "2026-05-19T09:00:00.000Z", authorId: "contributor-a", photoContentHash: sha256("photo-1"),
    placementSnapshotHash: sha256("placement-photo-1") };
  return new FixtureCorePort({
    photos: { "photo-1": { photoId: "photo-1", contributorId: "contributor-a", completed: true, deleted: false,
      withdrawn: false, l3Enabled: true, visibleAnchor: "舞台旁边摆着一束白色花", provenance } },
    accountSessions: { "account-session-a": { sessionId: "session-a", contributorId: "contributor-a", active: true,
      revalidated: true, issuedSessionEpoch: 1, accountSessionEpoch: 1 } }
  });
}

function e2eApi({ fetchImpl, resolveImage } = {}) {
  const core = e2eCore();
  const questionProvider = createMiniMaxQuestionProvider({ apiKey: FAKE_KEY, resolveImage,
    fetchImpl: fetchImpl ?? fetchReturning('{"question":"这束白花是特意为今天准备的吗？"}') });
  return new BookLabMemoryApi({ core, etagSecret: ETAG_SECRET, workerSecret: WORKER_SECRET,
    cleanupSecret: CLEANUP_SECRET, providerModel: "unseen-minimax-question-v1", modelVersion: "2026-08-16",
    questionProvider });
}

test("end-to-end: a real MiniMax-shaped completion reaches ready with the composed Chinese question", async (t) => {
  const api = e2eApi();
  t.after(() => api.close());
  const started = api.handle({ method: "POST", path: "/v2-labs/memories/photos/photo-1/question-jobs",
    body: { noticeVersion: api.currentNotice.version, noticeHash: api.currentNotice.hash,
      photoContentHash: sha256("photo-1"), placementSnapshotHash: sha256("placement-photo-1") },
    headers: { authorization: "Bearer account-session-a", "if-none-match": "*", "idempotency-key": "start-key-1" } });
  const startedResult = await started;
  assert.equal(startedResult.status, 200);
  const work = api.pendingQuestionJobs(WORKER_SECRET)[0];
  const result = await api.processQuestion(work, WORKER_SECRET);
  assert.equal(result.status, "ready");
  assert.equal(result.question, "这束白花是特意为今天准备的吗？");
  assert.equal(result.modelVersion, "2026-08-16");
});

test("end-to-end: a MiniMax failure keeps the interview queued and skippable, never blocking the book chain", async (t) => {
  const api = e2eApi({ fetchImpl: async () => jsonResponse({}, { status: 500 }) });
  t.after(() => api.close());
  const started = await api.handle({ method: "POST", path: "/v2-labs/memories/photos/photo-1/question-jobs",
    body: { noticeVersion: api.currentNotice.version, noticeHash: api.currentNotice.hash,
      photoContentHash: sha256("photo-1"), placementSnapshotHash: sha256("placement-photo-1") },
    headers: { authorization: "Bearer account-session-a", "if-none-match": "*", "idempotency-key": "start-key-2" } });
  assert.equal(started.status, 200);
  const work = api.pendingQuestionJobs(WORKER_SECRET)[0];
  await assert.rejects(api.processQuestion(work, WORKER_SECRET), /model_unavailable/);
  const job = api.db.prepare("SELECT status,last_stable_error stableError FROM memory_question_jobs WHERE id=?")
    .get(work.jobId);
  assert.deepEqual({ ...job }, { status: "queued", stableError: "model_unavailable" });
  const workspace = await api.handle({ method: "GET", path: "/v2-labs/memories/photos/photo-1",
    headers: { authorization: "Bearer account-session-a" } });
  assert.equal(workspace.body.memory.status, "question_queued");
  const skip = await api.handle({ method: "POST", path: "/v2-labs/memories/photos/photo-1/skip", body: {},
    headers: { authorization: "Bearer account-session-a", "idempotency-key": "skip-key-1",
      "if-match": workspace.body.interviewPrecondition.ifMatch } });
  assert.equal(skip.status, 200, `skip must remain available while AI is unavailable: ${JSON.stringify(skip.body)}`);
});
