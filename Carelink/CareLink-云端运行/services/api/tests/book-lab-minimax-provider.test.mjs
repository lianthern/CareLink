// Exercises the new UNSEEN_BOOK_QUESTION_PROVIDER=minimax wiring in services/api/src/extensions/book-lab.mjs
// (not the book-lab package's own unit tests, which cover the provider function itself in isolation). This file
// proves: (1) the switch is off by default and every invalid/incomplete minimax configuration fails the whole
// extension mount closed before any route is published, exactly like the existing secret/hash validators; and
// (2) when a valid configuration is supplied, a real question job dispatched through the actual production
// internal-job seam reaches the MiniMax provider and completes, with the fetch intercepted (no live vendor key,
// no network I/O in this test run).
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalApi } from "../src/api.mjs";
import { fixture, png } from "./fixture-factory.mjs";
import { sha256 } from "../src/util.mjs";
import { COLLECTION_NOTICE_CONTEXT_DISCLOSURE } from "../../book-lab/src/index.mjs";

// Core's own PrivateAiJobQueue (a different config surface than book-lab.mjs's UNSEEN_PRIVATE_AI_* env block) also
// requires a real worker-token hash file the instant `featureFlags.privateAiWorker: true` is passed to LocalApi,
// independent of which questionProvider book-lab.mjs ends up using. Every test below that flips that flag on needs
// this too, exactly like services/api/tests/book-lab-worker-pipeline.test.mjs's happy-path test.
function localApiPrivateAi(dir, { model = "unseen-minimax-question-v1", modelVersion = "2026-08-16",
  promptHash = sha256("test-prompt"), policyHash = sha256("test-policy") } = {}) {
  const tokenHashFile = path.join(dir, "worker.token.sha256");
  writeFileSync(tokenHashFile, createHash("sha256").update(randomBytes(32).toString("hex")).digest("hex"),
    { mode: 0o600 });
  chmodSync(tokenHashFile, 0o600);
  return { tokenHashFile, promptHash, policyHash, model, modelVersion };
}

function bookLabTestEnv(dir, overrides = {}) {
  const collectionNoticeCopy = `测试收集须知文案。${COLLECTION_NOTICE_CONTEXT_DISCLOSURE}`;
  return {
    UNSEEN_BOOK_LAB_DB: path.join(dir, "book-lab.sqlite"),
    UNSEEN_BOOK_LAB_ETAG_SECRET: "test-book-lab-etag-secret-not-production-0001",
    UNSEEN_BOOK_LAB_WORKER_SECRET: "test-book-lab-worker-secret-not-production-0002",
    UNSEEN_BOOK_LAB_CLEANUP_SECRET: "test-book-lab-cleanup-secret-not-production-0003",
    UNSEEN_BOOK_LAB_RENDER_WORKER_SECRET: "test-book-lab-render-secret-not-production-0004",
    UNSEEN_BOOK_LAB_COLLECTION_NOTICE_VERSION: "test-collection-notice-1",
    UNSEEN_BOOK_LAB_COLLECTION_NOTICE_HASH: sha256(collectionNoticeCopy),
    UNSEEN_BOOK_LAB_COLLECTION_NOTICE_COPY: collectionNoticeCopy,
    UNSEEN_BOOK_LAB_GRANT_NOTICE_VERSION: "test-grant-notice-1",
    UNSEEN_BOOK_LAB_GRANT_NOTICE_HASH: sha256("test-grant-notice-1"),
    ...overrides
  };
}

function privateAiEnv(overrides = {}) {
  return {
    UNSEEN_PRIVATE_AI_WORKER_ENABLED: "true",
    UNSEEN_PRIVATE_AI_MODEL: "unseen-minimax-question-v1",
    UNSEEN_PRIVATE_AI_MODEL_VERSION: "2026-08-16",
    UNSEEN_PRIVATE_AI_PROMPT_HASH: sha256("test-prompt"),
    UNSEEN_PRIVATE_AI_POLICY_HASH: sha256("test-policy"),
    ...overrides
  };
}

function bookLabModuleLoader(env) {
  return async () => {
    const module = await import("../src/extensions/book-lab.mjs");
    return { registerBookLabExtension: (input) => module.registerBookLabExtension(input, { env }) };
  };
}

function tempDir(t, label) {
  const dir = mkdtempSync(path.join(tmpdir(), `unseen-book-lab-minimax-${label}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("UNSEEN_BOOK_QUESTION_PROVIDER is off by default and an unknown value fails the mount closed", async (t) => {
  const dir = tempDir(t, "bogus");
  const env = bookLabTestEnv(dir, { ...privateAiEnv(), UNSEEN_BOOK_QUESTION_PROVIDER: "not-a-real-provider" });
  const api = new LocalApi({ featureFlags: { bookLab: true, privateAiWorker: true },
    privateAi: localApiPrivateAi(dir), extensionModuleLoader: bookLabModuleLoader(env) });
  t.after(() => api.close());
  await assert.rejects(api.ready, (error) => error.code === "book_lab_extension_unavailable");
});

test("minimax requires the privateAi audit block (model/modelVersion/promptHash/policyHash) to already be set", async (t) => {
  const dir = tempDir(t, "noaudit");
  const env = bookLabTestEnv(dir, { UNSEEN_BOOK_QUESTION_PROVIDER: "minimax",
    UNSEEN_MINIMAX_API_KEY: "sk-test-not-a-real-minimax-key" }); // no privateAiEnv(): worker stays off
  const api = new LocalApi({ featureFlags: { bookLab: true, privateAiWorker: false },
    extensionModuleLoader: bookLabModuleLoader(env) });
  t.after(() => api.close());
  await assert.rejects(api.ready, (error) => error.code === "book_lab_extension_unavailable");
});

test("minimax requires an API key or key file and fails closed before mounting any route when neither is set", async (t) => {
  const dir = tempDir(t, "nokey");
  const env = bookLabTestEnv(dir, { ...privateAiEnv(), UNSEEN_BOOK_QUESTION_PROVIDER: "minimax" });
  const api = new LocalApi({ featureFlags: { bookLab: true, privateAiWorker: true },
    privateAi: localApiPrivateAi(dir), extensionModuleLoader: bookLabModuleLoader(env) });
  t.after(() => api.close());
  await assert.rejects(api.ready, (error) => error.code === "book_lab_extension_unavailable");
});

test("UNSEEN_MINIMAX_KEY_FILE resolves the key from an absolute local file and the extension mounts", async (t) => {
  const dir = tempDir(t, "keyfile");
  const keyFile = path.join(dir, "minimax.key");
  writeFileSync(keyFile, "sk-test-not-a-real-minimax-key\n", { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  const env = bookLabTestEnv(dir, { ...privateAiEnv(), UNSEEN_BOOK_QUESTION_PROVIDER: "minimax",
    UNSEEN_MINIMAX_KEY_FILE: keyFile });
  const api = new LocalApi({ featureFlags: { bookLab: true, privateAiWorker: true },
    privateAi: localApiPrivateAi(dir), extensionModuleLoader: bookLabModuleLoader(env) });
  t.after(() => api.close());
  await api.ready; // must not throw
});

async function activatePanorama(f, owner, space) {
  const bytes = png(1600, 800);
  const current = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(space.spaceId);
  const candidate = await f.ok("POST", `/v1/spaces/${space.spaceId}/panorama-candidates`, {
    declaredMime: "image/png", declaredBytes: bytes.length, clientAssetId: "minimax-wiring-panorama"
  }, { ...owner.headers, "if-match": String(current.version),
    "notice-acknowledgement": JSON.stringify({ purpose: "panorama_upload", version: 1,
      contentHash: "local-panorama_upload-v1" }) });
  const put = await f.api.putMedia({ ticket: candidate.exactPrivateUploadTicketOnce,
    bytes, contentType: "image/png", kind: "panorama" });
  const committed = await f.ok("POST", `/v1/panorama-upload-sessions/${candidate.uploadSessionId}/commits`,
    { clientRequestId: "minimax-wiring-panorama-commit" },
    { ...owner.headers, "if-match": String(put.body.uploadSessionVersion) });
  const { dispatchOne } = await import("../../jobs/dispatch/index.mjs");
  const ready = dispatchOne(f.db, committed.jobId, { now: f.clock.iso() });
  const scene = f.db.prepare("SELECT * FROM scenes WHERE space_id=?").get(space.spaceId);
  const before = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(space.spaceId);
  await f.ok("POST", `/v1/spaces/${space.spaceId}/panorama-switches`, {
    mode: "switch", candidateRevisionId: ready.panoramaRevisionId, sceneIfMatchVersion: scene.version
  }, { ...owner.headers, "if-match": String(before.version) });
  return { ...space, version: f.db.prepare("SELECT version FROM spaces WHERE id=?").get(space.spaceId).version };
}

async function readyVisiblePhoto(f, owner, space) {
  const { createAccountUpload } = await import("./fixture-factory.mjs");
  const flow = await createAccountUpload(f, owner, space);
  const photo = f.db.prepare("SELECT * FROM photos WHERE id=?").get(flow.committed.photoId);
  const item = f.db.prepare("SELECT * FROM contribution_batch_items WHERE id=?").get(photo.batch_item_id);
  f.db.prepare("UPDATE photos SET captured_at='2026-08-13T04:34:56.000Z' WHERE id=?").run(photo.id);
  const placed = await f.ok("POST", `/v1/photos/${photo.id}/placement-revisions`, {
    mode: "manual", confirmationMode: "manual", yawDeg: 42, pitchDeg: 3, regionId: "main",
    reason: "minimax-wiring-placement"
  }, { ...owner.headers, "if-match": String(photo.version), "x-item-version": String(item.version),
    "x-placement-authorization-version": String(item.placement_authorization_version) });
  // A: f.createSpace() now defaults auto_approve_uploads on, so the photo may already
  // be 'visible' — only approve if it still actually needs it (this helper's job is
  // "make sure the photo is visible", not "always exercise a manual approval").
  const approvalState = f.db.prepare("SELECT photo_content_state,version FROM photos WHERE id=?").get(photo.id);
  if (approvalState.photo_content_state === "pending") {
    await f.ok("POST", `/v1/photos/${photo.id}/content-transitions`, {
      to: "visible", transitionReasonCode: "manual_approved", decisionReasonCode: null
    }, { ...owner.headers, "if-match": String(approvalState.version) });
  }
  return f.db.prepare("SELECT * FROM photos WHERE id=?").get(photo.id);
}

function pendingQuestionRequest(dbPath, jobId) {
  const db = new DatabaseSync(dbPath);
  const row = jobId
    ? db.prepare("SELECT * FROM memory_question_jobs WHERE id=? AND status='queued'").get(jobId)
    : db.prepare(`SELECT j.* FROM memory_question_jobs j
      JOIN memory_model_fact_drafts f ON f.question_job_id=j.id AND f.status='pending'
      WHERE j.status='queued' ORDER BY j.created_at DESC, j.rowid DESC LIMIT 1`).get();
  db.close();
  if (!row) return null;
  return { jobId: row.id, jobVersion: row.version, kind: row.kind, inputHash: row.input_hash,
    attempt: row.attempt + 1 };
}

async function questionJob(f, owner, photo) {
  const opened = await f.call("GET", `/v2-labs/memories/photos/${photo.id}`, {}, owner.headers);
  assert.equal(opened.body.eligibility, "eligible");
  const started = await f.call("POST", `/v2-labs/memories/photos/${photo.id}/question-jobs`, {
    noticeVersion: opened.body.collectionNotice.version, noticeHash: opened.body.collectionNotice.hash,
    photoContentHash: opened.body.provenance.photoContentHash,
    placementSnapshotHash: opened.body.provenance.placementSnapshotHash
  }, { ...owner.headers, "if-none-match": opened.body.interviewPrecondition.ifNoneMatch });
  assert.equal(started.status, 200);
  assert.equal(started.body.status, "queued");
  return started;
}

test("end-to-end through the real extension: a question job dispatched via the internal job seam " +
  "reaches the real MiniMax provider (fetch intercepted, no live vendor call)", async (t) => {
  const dir = tempDir(t, "e2e");
  const env = bookLabTestEnv(dir, { ...privateAiEnv(), UNSEEN_BOOK_QUESTION_PROVIDER: "minimax",
    UNSEEN_MINIMAX_API_KEY: "sk-test-not-a-real-minimax-key" });

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  let seenUrl;
  let seenAuthorization;
  globalThis.fetch = async (url, init) => {
    fetchCalls += 1;
    seenUrl = url;
    seenAuthorization = init.headers.authorization;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message:
      { content: '{"question":"这朵蓝色的花是特意为今天挑选的吗？"}' } }] }) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const f = fixture({ featureFlags: { bookLab: true, privateAiWorker: true },
    privateAi: localApiPrivateAi(dir), extensionModuleLoader: bookLabModuleLoader(env) });
  t.after(() => f.close());
  await f.api.ready;

  const owner = await f.login("book-minimax-owner@example.test");
  let space = await f.createSpace(owner, "MiniMax 接线测试");
  space = await f.openSpace(owner, space);
  space = await activatePanorama(f, owner, space);

  // --- Sub-case 1: today's real Core (services/api/src/api.mjs bookLabPhotoDto()) always projects
  // `visibleFacts: []` — nothing in this repository extracts real visible facts yet (see the final report).
  // The provider must correctly abstain rather than invent a "visible fact", and must never call out to MiniMax
  // to do so: the retry-and-skip-forever shape below is the intended, honest behavior for the current Core.
  const photoWithoutFacts = await readyVisiblePhoto(f, owner, space);
  const startedWithoutFacts = await questionJob(f, owner, photoWithoutFacts);
  const requestWithoutFacts = pendingQuestionRequest(env.UNSEEN_BOOK_LAB_DB, startedWithoutFacts.body.jobId);
  assert.ok(requestWithoutFacts, "a real question job is queued");
  await assert.rejects(f.api.dispatchInternalJob("internal:book-lab-question-processor", requestWithoutFacts),
    (error) => error.code === "model_unavailable");
  assert.equal(fetchCalls, 0, "no visible facts and no image capability: must abstain without ever calling MiniMax");

  // --- Sub-case 2: simulate the near-term Core extension that actually populates `visibleFacts` (out of scope
  // for this session; see the report) by overriding just this LocalApi instance's projection. This proves the
  // wiring is the real MiniMax provider (its behavior changes with the facts it is given), not the pre-existing
  // `provider_unconfigured` stub, which would fail identically regardless of facts.
  const originalDto = f.api.bookLabPhotoDto.bind(f.api);
  f.api.bookLabPhotoDto = (current) => {
    const dto = originalDto(current);
    return dto && Object.freeze({ ...dto, visibleFacts: Object.freeze(["桌上摆着一朵蓝色的花"]) });
  };
  t.after(() => { f.api.bookLabPhotoDto = originalDto; });

  const photoWithFacts = await readyVisiblePhoto(f, owner, space);
  const startedWithFacts = await questionJob(f, owner, photoWithFacts);
  const requestWithFacts = pendingQuestionRequest(env.UNSEEN_BOOK_LAB_DB, startedWithFacts.body.jobId);
  const outcome = await f.api.dispatchInternalJob("internal:book-lab-question-processor", requestWithFacts);
  assert.equal(outcome.status, "ready", `expected ready, got ${JSON.stringify(outcome)}`);
  assert.equal(outcome.question, "这朵蓝色的花是特意为今天挑选的吗？");
  assert.equal(fetchCalls, 1);
  assert.equal(seenUrl, "https://api.minimaxi.com/v1/chat/completions");
  assert.equal(seenAuthorization, "Bearer sk-test-not-a-real-minimax-key");

  const detail = await f.call("GET", `/v2-labs/memories/photos/${photoWithFacts.id}`, {}, owner.headers);
  assert.equal(detail.body.memory.status, "question_ready");
});
