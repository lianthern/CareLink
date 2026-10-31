import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LocalApi } from "../src/api.mjs";
import { loadLocalKeyring } from "../src/crypto.mjs";
import { createLocalHttpServer, listenLocalHttpServer } from "../src/http-server.mjs";
import { FilesystemMediaStore } from "../src/ports/media/filesystem-media-store.mjs";
import { loadPrivateAiWorkerTokenHash, PRIVATE_AI_IMAGE_LIMIT,
  PRIVATE_AI_CONTEXT_RETENTION_MS, PRIVATE_AI_PROTOCOL } from "../src/private-ai-job-queue.mjs";
import { sha256 } from "../src/util.mjs";
import { dispatchOne } from "../../jobs/dispatch/index.mjs";
import { createAccountUpload, fixture, png, TestClock } from "./fixture-factory.mjs";

const PROMPT_HASH = sha256("private-ai-photo-prompt-v1");
const POLICY_HASH = sha256("private-ai-visible-facts-policy-v1");
const MODEL = "test-image-model";
const MODEL_VERSION = "test-image-model-2026-08-15";

function tokenFile(directory, token) {
  const file = path.join(directory, "worker-token.sha256");
  writeFileSync(file, `${sha256(token)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

function privateAiOptions(file, overrides = {}) {
  return { tokenHashFile: file, promptHash: PROMPT_HASH, policyHash: POLICY_HASH,
    model: MODEL, modelVersion: MODEL_VERSION, ...overrides };
}

function persistentOptions(directory, clock, file, overrides = {}) {
  const database = path.join(directory, "core.sqlite");
  const keyset = path.join(directory, "core.keyset.json");
  const mediaRoot = path.join(directory, "media");
  return { database, keyring: loadLocalKeyring(keyset, { allowCreate: !existsSync(database) }),
    mediaStore: new FilesystemMediaStore(mediaRoot), clock, featureFlags: { privateAiWorker: true },
    privateAi: privateAiOptions(file, overrides) };
}

async function activatePanorama(f, owner, space) {
  const bytes = png(1600, 800);
  const current = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(space.spaceId);
  const candidate = await f.ok("POST", `/v1/spaces/${space.spaceId}/panorama-candidates`, {
    declaredMime: "image/png", declaredBytes: bytes.length, clientAssetId: "private-ai-panorama"
  }, { ...owner.headers, "if-match": String(current.version),
    "notice-acknowledgement": JSON.stringify({ purpose: "panorama_upload", version: 1,
      contentHash: "local-panorama_upload-v1" }) });
  const put = await f.api.putMedia({ ticket: candidate.exactPrivateUploadTicketOnce,
    bytes, contentType: "image/png", kind: "panorama" });
  const committed = await f.ok("POST", `/v1/panorama-upload-sessions/${candidate.uploadSessionId}/commits`,
    { clientRequestId: "private-ai-panorama-commit" },
    { ...owner.headers, "if-match": String(put.body.uploadSessionVersion) });
  const ready = dispatchOne(f.db, committed.jobId, { now: f.api.core.now() });
  const scene = f.db.prepare("SELECT * FROM scenes WHERE space_id=?").get(space.spaceId);
  const before = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(space.spaceId);
  await f.ok("POST", `/v1/spaces/${space.spaceId}/panorama-switches`, {
    mode: "switch", candidateRevisionId: ready.panoramaRevisionId, sceneIfMatchVersion: scene.version
  }, { ...owner.headers, "if-match": String(before.version) });
  return { ...space, version: f.db.prepare("SELECT version FROM spaces WHERE id=?").get(space.spaceId).version };
}

async function readyPhoto(f) {
  const owner = await f.login("private-ai-owner@example.test");
  let space = await f.createSpace(owner);
  space = await f.openSpace(owner, space);
  space = await activatePanorama(f, owner, space);
  const flow = await createAccountUpload(f, owner, space, png(96, 64, "#315477"));
  const photo = f.db.prepare("SELECT * FROM photos WHERE id=?").get(flow.committed.photoId);
  const item = f.db.prepare("SELECT * FROM contribution_batch_items WHERE id=?").get(photo.batch_item_id);
  f.db.prepare("UPDATE photos SET captured_at='2026-08-15T00:00:00.000Z' WHERE id=?").run(photo.id);
  const placed = await f.ok("POST", `/v1/photos/${photo.id}/placement-revisions`, {
    mode: "manual", confirmationMode: "manual", yawDeg: 42, pitchDeg: 3, regionId: "main",
    reason: "private-ai-test"
  }, { ...owner.headers, "if-match": String(photo.version), "x-item-version": String(item.version),
    "x-placement-authorization-version": String(item.placement_authorization_version) });
  // A: f.createSpace() now defaults auto_approve_uploads on, so the photo may already
  // be 'visible' — only approve if it still actually needs it.
  const approvalState = f.db.prepare("SELECT photo_content_state,version FROM photos WHERE id=?").get(photo.id);
  if (approvalState.photo_content_state === "pending") {
    await f.ok("POST", `/v1/photos/${photo.id}/content-transitions`, {
      to: "visible", transitionReasonCode: "manual_approved", decisionReasonCode: null
    }, { ...owner.headers, "if-match": String(approvalState.version) });
  }
  const source = f.api.currentBookLabPhoto(photo.id);
  const stored = await f.api.mediaStore.get(source.row.render_object_key);
  return { photoId: photo.id, mediaAssetId: source.row.render_asset_id,
    mediaObjectKey: source.row.render_object_key, mediaBytes: Buffer.from(stored.body) };
}

function result(question = "这张照片背后最想留下的故事是什么？") {
  return { modelVisibleFacts: ["蓝色背景前摆着一件浅色物品"], question, questionIntent: "photo_context",
    model: MODEL, modelVersion: MODEL_VERSION, latencyMs: 1234 };
}

function processorRequest(label, overrides = {}) {
  return { jobId: `book-question-${label}`, jobVersion: 1, kind: "initial_question",
    inputHash: sha256(`book-question-input-${label}`), attempt: 1, ...overrides };
}

function authorizeAndEnqueue(api, input) {
  api.authorizePrivateAiPhoto({ photoId: input.photoId,
    authorizationSnapshotHash: input.authorizationSnapshotHash });
  return api.enqueuePrivateAiPhoto(input);
}

function expectCode(operation, code) {
  return assert.rejects(operation, (error) => error?.code === code);
}

test("migration 0018 preserves active legacy jobs for job/1 leasing and redacts terminal history", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE private_ai_jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      composition_request_json TEXT NOT NULL
    );
    INSERT INTO private_ai_jobs VALUES
      ('active-followup','queued','{"kind":"followup_question"}'),
      ('terminal-followup','completed','{"kind":"followup_question"}');`);
    db.exec(readFileSync(new URL("../db/migrations/0018_private_ai_question_context.sql", import.meta.url), "utf8"));
    const active = db.prepare("SELECT question_context_json FROM private_ai_jobs WHERE id='active-followup'").get();
    const terminal = db.prepare("SELECT question_context_json FROM private_ai_jobs WHERE id='terminal-followup'").get();
    assert.equal(active.question_context_json, null);
    assert.deepEqual(JSON.parse(terminal.question_context_json), { kind: "redacted" });
    assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
  } finally { db.close(); }
});

test("default-off private AI path reads neither token nor media", async () => {
  let tokenReads = 0;
  let mediaReads = 0;
  const api = new LocalApi({ featureFlags: { privateAiWorker: false }, privateAi: {
    tokenHashFile: "/does/not/exist", tokenHashLoader() { tokenReads += 1; throw new Error("must_not_read"); }
  } });
  const originalGet = api.mediaStore.get.bind(api.mediaStore);
  api.mediaStore.get = (...args) => { mediaReads += 1; return originalGet(...args); };
  try {
    assert.deepEqual(api.privateAi.health(), { enabled: false, configured: false,
      taskType: "photo_visible_facts_question_v1", deployed: false, releaseClaim: "NO_GO_DEFAULT_OFF" });
    assert.throws(() => api.privateAi.enqueuePhoto({ photoId: "photo", authorizationSnapshotHash: "0".repeat(64) }),
      (error) => error.code === "private_ai_worker_disabled");
    await expectCode(api.privateAi.image("paij_" + "0".repeat(32), "pail_" + "0".repeat(32)),
      "private_ai_worker_disabled");
    assert.equal(tokenReads, 0);
    assert.equal(mediaReads, 0);
  } finally { api.close(); }
});

test("worker token hash file rejects unsafe paths, metadata, and contents", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-private-ai-token-"));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const token = `worker-${crypto.randomUUID()}`;
  const safe = tokenFile(directory, token);
  assert.deepEqual(loadPrivateAiWorkerTokenHash(safe), Buffer.from(sha256(token), "hex"));
  assert.throws(() => loadPrivateAiWorkerTokenHash(path.basename(safe)),
    (error) => error.code === "private_ai_worker_configuration_invalid");
  chmodSync(safe, 0o644);
  assert.throws(() => loadPrivateAiWorkerTokenHash(safe),
    (error) => error.code === "private_ai_worker_configuration_invalid");
  chmodSync(safe, 0o600);
  writeFileSync(safe, "not-a-sha256\n", { mode: 0o600 });
  chmodSync(safe, 0o400);
  assert.throws(() => loadPrivateAiWorkerTokenHash(safe),
    (error) => error.code === "private_ai_worker_configuration_invalid");
  chmodSync(safe, 0o600);
  writeFileSync(safe, `${sha256(token)}\n`, { mode: 0o600 });
  chmodSync(safe, 0o400);
  const link = path.join(directory, "worker-token-link.sha256");
  symlinkSync(safe, link);
  assert.throws(() => loadPrivateAiWorkerTokenHash(link),
    (error) => error.code === "private_ai_worker_configuration_invalid");
});

test("an active pre-0018 follow-up row leases as job/1 instead of becoming stuck", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-private-ai-legacy-context-"));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = tokenFile(directory, `worker-${crypto.randomUUID()}`);
  const clock = new TestClock("2026-08-15T00:00:00.000Z");
  const f = fixture(persistentOptions(directory, clock, file));
  try {
    const photo = await readyPhoto(f);
    const authorizationSnapshotHash = sha256("authorization-legacy-followup");
    const queued = authorizeAndEnqueue(f.api, { photoId: photo.photoId, authorizationSnapshotHash,
      questionProcessorRequest: processorRequest("legacy-followup", { kind: "followup_question" }),
      questionContext: { kind: "followup_question", followupOrdinal: 1, followupLimit: 3,
        priorVisibleFacts: ["桌边放着一张浅色卡片"], priorQuestion: "这张卡片让你想到什么？",
        userAnswerText: "它是出发前留下的。" } });
    f.db.prepare("UPDATE private_ai_jobs SET question_context_json=NULL WHERE id=?").run(queued.jobId);
    const leased = f.api.privateAi.lease().job;
    assert.equal(leased.schema, "unseen-private-ai-job/1");
    assert.equal(Object.hasOwn(leased, "questionContext"), false);
    assert.equal(leased.jobId, queued.jobId);
    assert.deepEqual(f.api.privateAi.complete(leased.jobId, { schema: "unseen-private-ai-complete-request/1",
      leaseId: leased.leaseId, inputHash: leased.inputHash, result: result() }), {
      schema: "unseen-private-ai-terminal-response/1", status: "completed", replayed: false,
      retryAfterMs: null
    });
  } finally { f.close(); }
});

test("authorization tombstones cannot be revived by enqueue and serialize with a second dispatcher", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-private-ai-authorization-"));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = tokenFile(directory, `worker-${crypto.randomUUID()}`);
  const clock = new TestClock("2026-08-15T00:00:00.000Z");
  const f = fixture(persistentOptions(directory, clock, file));
  let second;
  try {
    const photo = await readyPhoto(f);
    const tombstoneHash = sha256("authorization-tombstone-first");
    assert.deepEqual(f.api.revokePrivateAiPhotoAuthorization({ photoId: photo.photoId,
      authorizationSnapshotHash: tombstoneHash }), { revoked: false, tombstoned: true });
    assert.throws(() => f.api.enqueuePrivateAiPhoto({ photoId: photo.photoId,
      authorizationSnapshotHash: tombstoneHash, questionProcessorRequest: processorRequest("tombstone") }),
    (error) => error.code === "private_ai_source_stale");
    assert.deepEqual({ ...f.db.prepare(`SELECT photo_id,active,source_binding_hash
      FROM private_ai_authorizations WHERE snapshot_hash=?`).get(tombstoneHash) },
    { photo_id: photo.photoId, active: 0, source_binding_hash: null });
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM private_ai_jobs").get().count, 0);

    const raceHash = sha256("authorization-dispatcher-race");
    f.api.authorizePrivateAiPhoto({ photoId: photo.photoId, authorizationSnapshotHash: raceHash });
    second = new LocalApi(persistentOptions(directory, clock, file));
    const later = (operation) => new Promise((resolve) => setImmediate(() => {
      try { resolve({ value: operation() }); } catch (error) { resolve({ error }); }
    }));
    const [enqueued, revoked] = await Promise.all([
      later(() => f.api.enqueuePrivateAiPhoto({ photoId: photo.photoId, authorizationSnapshotHash: raceHash,
        questionProcessorRequest: processorRequest("race") })),
      later(() => second.revokePrivateAiPhotoAuthorization({ photoId: photo.photoId,
        authorizationSnapshotHash: raceHash }))
    ]);
    assert.equal(revoked.error, undefined);
    assert.equal(f.db.prepare("SELECT active FROM private_ai_authorizations WHERE snapshot_hash=?")
      .get(raceHash).active, 0);
    if (enqueued.value) {
      assert.deepEqual({ ...f.db.prepare("SELECT status,stable_error FROM private_ai_jobs WHERE id=?")
        .get(enqueued.value.jobId) }, { status: "failed", stable_error: "authorization_withdrawn" });
    } else assert.equal(enqueued.error?.code, "private_ai_source_stale");
    assert.equal(f.api.privateAi.lease().job, null);
    assert.equal(f.api.mediaStore.networkRequests + second.mediaStore.networkRequests, 0);
  } finally {
    if (second) second.close();
    f.close();
  }
});

test("authorization replay is write-free and reconciliation tombstones drifted completed work", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-private-ai-reconcile-"));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = tokenFile(directory, `worker-${crypto.randomUUID()}`);
  const clock = new TestClock("2026-08-15T00:00:00.000Z");
  const f = fixture(persistentOptions(directory, clock, file));
  try {
    const photo = await readyPhoto(f);
    const authorizationSnapshotHash = sha256("authorization-reconcile");
    const first = f.api.authorizePrivateAiPhoto({ photoId: photo.photoId, authorizationSnapshotHash });
    const authorizedAt = f.db.prepare(`SELECT updated_at FROM private_ai_authorizations
      WHERE snapshot_hash=?`).get(authorizationSnapshotHash).updated_at;
    clock.advance(5_000);
    assert.deepEqual(f.api.authorizePrivateAiPhoto({ photoId: photo.photoId, authorizationSnapshotHash }), first);
    assert.equal(f.db.prepare(`SELECT updated_at FROM private_ai_authorizations
      WHERE snapshot_hash=?`).get(authorizationSnapshotHash).updated_at, authorizedAt);

    const queued = f.api.enqueuePrivateAiPhoto({ photoId: photo.photoId, authorizationSnapshotHash,
      questionProcessorRequest: processorRequest("reconcile") });
    const lease = f.api.privateAi.lease().job;
    f.api.privateAi.complete(queued.jobId, { schema: "unseen-private-ai-complete-request/1",
      leaseId: lease.leaseId, inputHash: lease.inputHash, result: result() });
    f.db.prepare("UPDATE photos SET version=version+1 WHERE id=?").run(photo.photoId);
    const reconciled = f.api.reconcilePrivateAiPhotoAuthorizations();
    assert.deepEqual(reconciled, { scannedCount: 1, revokedCount: 1, failedJobCount: 0,
      cancelledEventCount: 1, revocations: [{ photoId: photo.photoId, authorizationSnapshotHash }] });
    assert.deepEqual({ ...f.db.prepare(`SELECT active,source_binding_hash FROM private_ai_authorizations
      WHERE snapshot_hash=?`).get(authorizationSnapshotHash) }, { active: 0, source_binding_hash: null });
    assert.equal(f.api.claimPrivateAiCompositionEvent(), null);

    const tombstoneAt = f.db.prepare(`SELECT updated_at FROM private_ai_authorizations
      WHERE snapshot_hash=?`).get(authorizationSnapshotHash).updated_at;
    clock.advance(5_000);
    assert.deepEqual(f.api.revokePrivateAiPhotoAuthorization({ photoId: photo.photoId,
      authorizationSnapshotHash }), { revoked: false, tombstoned: true });
    assert.equal(f.db.prepare(`SELECT updated_at FROM private_ai_authorizations
      WHERE snapshot_hash=?`).get(authorizationSnapshotHash).updated_at, tombstoneAt);
    assert.deepEqual(f.api.reconcilePrivateAiPhotoAuthorizations(), { scannedCount: 0, revokedCount: 0,
      failedJobCount: 0, cancelledEventCount: 0, revocations: [] });
  } finally { f.close(); }
});

test("worker heartbeat, authorization withdrawal, and max attempts fail closed", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-private-ai-observation-"));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = tokenFile(directory, `worker-${crypto.randomUUID()}`);
  const clock = new TestClock("2026-08-15T00:00:00.000Z");
  const f = fixture(persistentOptions(directory, clock, file));
  try {
    const photo = await readyPhoto(f);
    const authorizationSnapshotHash = sha256("authorization-observation");
    assert.throws(() => f.api.enqueuePrivateAiPhoto({ photoId: photo.photoId, authorizationSnapshotHash,
      questionProcessorRequest: { ...processorRequest("bad"), kind: "worker_chosen_kind" } }),
    (error) => error.code === "private_ai_request_invalid");
    f.api.authorizePrivateAiPhoto({ photoId: photo.photoId, authorizationSnapshotHash });
    const queued = f.api.enqueuePrivateAiPhoto({ photoId: photo.photoId, authorizationSnapshotHash,
      questionProcessorRequest: processorRequest("observation") });
    assert.deepEqual(f.api.privateAiObservation(), { enabled: true, workerOnline: false, lastSeenAt: null,
      queuedRetryCount: 1, leasedCount: 0, failedCount: 0, completedCount: 0, oldestQueuedRetryAgeMs: 0 });
    clock.advance(31_000);
    assert.equal(f.api.privateAiObservation().oldestQueuedRetryAgeMs, 31_000);
    const lease = f.api.privateAi.lease().job;
    assert.equal(lease.jobId, queued.jobId);
    assert.deepEqual(f.api.privateAiObservation(), { enabled: true, workerOnline: true,
      lastSeenAt: "2026-08-15T00:00:31.000Z", queuedRetryCount: 0, leasedCount: 1, failedCount: 0,
      completedCount: 0, oldestQueuedRetryAgeMs: null });
    clock.advance(30_001);
    assert.equal(f.api.privateAiObservation().workerOnline, false);
    assert.deepEqual(f.api.revokePrivateAiPhotoAuthorization({ photoId: photo.photoId,
      authorizationSnapshotHash }), { revoked: true, tombstoned: true });
    await expectCode(f.api.privateAi.image(lease.jobId, lease.leaseId), "private_ai_lease_unavailable");
    const withdrawn = f.db.prepare(`SELECT status,stable_error,question_context_json
      FROM private_ai_jobs WHERE id=?`).get(lease.jobId);
    assert.equal(withdrawn.stable_error, "authorization_withdrawn");
    assert.deepEqual(JSON.parse(withdrawn.question_context_json), { kind: "redacted" });

    const exhausted = authorizeAndEnqueue(f.api, { photoId: photo.photoId,
      authorizationSnapshotHash: sha256("authorization-attempts"),
      questionProcessorRequest: processorRequest("attempts") });
    f.db.prepare("UPDATE private_ai_jobs SET attempts=max_attempts-1 WHERE id=?").run(exhausted.jobId);
    const finalLease = f.api.privateAi.lease().job;
    assert.equal(finalLease.attempt, finalLease.maxAttempts);
    const failed = f.api.privateAi.fail(finalLease.jobId, { schema: "unseen-private-ai-fail-request/1",
      leaseId: finalLease.leaseId, inputHash: finalLease.inputHash, failureCode: "model_timeout" });
    assert.deepEqual(failed, { schema: "unseen-private-ai-terminal-response/1", status: "failed",
      replayed: false, retryAfterMs: null });
    assert.deepEqual(JSON.parse(f.db.prepare(`SELECT question_context_json FROM private_ai_jobs WHERE id=?`)
      .get(finalLease.jobId).question_context_json), { kind: "redacted" });
  } finally { f.close(); }
});

test("queued follow-up context expires, redacts, and reports provider unavailability without a worker", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-private-ai-context-expiry-"));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = tokenFile(directory, `worker-${crypto.randomUUID()}`);
  const clock = new TestClock("2026-08-15T00:00:00.000Z");
  const f = fixture(persistentOptions(directory, clock, file));
  try {
    const photo = await readyPhoto(f);
    const authorizationSnapshotHash = sha256("authorization-context-expiry");
    const queued = authorizeAndEnqueue(f.api, { photoId: photo.photoId, authorizationSnapshotHash,
      questionProcessorRequest: processorRequest("context-expiry", { kind: "followup_question" }),
      questionContext: { kind: "followup_question", followupOrdinal: 1, followupLimit: 3,
        priorVisibleFacts: ["桌边放着一张浅色卡片"], priorQuestion: "这张卡片让你想到什么？",
        userAnswerText: "这段原话不应无限期停留在离线队列里。" } });
    clock.advance(PRIVATE_AI_CONTEXT_RETENTION_MS + 1);
    f.api.reconcilePrivateAiPhotoAuthorizations();
    const expired = f.db.prepare(`SELECT status,stable_error,question_context_json FROM private_ai_jobs
      WHERE id=?`).get(queued.jobId);
    assert.equal(expired.status, "failed");
    assert.equal(expired.stable_error, "context_expired");
    assert.deepEqual(JSON.parse(expired.question_context_json), { kind: "redacted" });
    assert.doesNotMatch(JSON.stringify(expired), /无限期|原话/u);
    const event = f.api.claimPrivateAiCompositionEvent({ leaseMs: 60_000 });
    assert.equal(event.eventType, "provider_unavailable");
    assert.equal(event.questionProcessorRequest.jobId, "book-question-context-expiry");
    assert.doesNotMatch(JSON.stringify(event), /无限期|原话/u);
  } finally { f.close(); }
});

test("persistent queue leases once, reclaims after restart, rejects drift, and commits once", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-private-ai-queue-"));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const token = `worker-${crypto.randomUUID()}`;
  const file = tokenFile(directory, token);
  const clock = new TestClock("2026-08-15T00:00:00.000Z");
  const options = persistentOptions(directory, clock, file);
  const f = fixture(options);
  let second;
  let restarted;
  let fClosed = false;
  try {
    const photo = await readyPhoto(f);
    const questionContext = {
      kind: "followup_question",
      followupOrdinal: 1,
      followupLimit: 3,
      priorVisibleFacts: ["桌边放着一张浅色卡片"],
      priorQuestion: "这张浅色卡片让你想到什么？",
      userAnswerText: "这是外婆在出发前留给我的一句话。"
    };
    const first = authorizeAndEnqueue(f.api, { photoId: photo.photoId,
      authorizationSnapshotHash: sha256("authorization-one"),
      questionProcessorRequest: processorRequest("one", { kind: "followup_question" }),
      questionContext });
    const duplicate = f.api.enqueuePrivateAiPhoto({ photoId: photo.photoId,
      authorizationSnapshotHash: sha256("authorization-one"),
      questionProcessorRequest: processorRequest("one", { kind: "followup_question" }),
      questionContext });
    assert.equal(duplicate.jobId, first.jobId);
    assert.equal(duplicate.replayed, true);
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM private_ai_jobs").get().count, 1);

    second = new LocalApi(persistentOptions(directory, clock, file));
    const [leased, competing] = await Promise.all([f.api.privateAi.lease(), second.privateAi.lease()]);
    assert.equal(leased.job.jobId, first.jobId);
    assert.equal(leased.job.attempt, 1);
    assert.equal(leased.job.maxAttempts, 5);
    assert.equal(competing.job, null);
    assert.deepEqual(Object.keys(leased.job).sort(), ["attempt", "imagePath", "inputHash", "jobId", "leaseExpiresAt",
      "leaseId", "maxAttempts", "mediaBytes", "mediaMime", "mediaSha256", "policyHash", "promptHash", "schema",
      "taskType", "questionContext"].sort());
    assert.equal(leased.job.schema, "unseen-private-ai-job/2");
    assert.deepEqual(leased.job.questionContext, questionContext);
    await expectCode(f.api.privateAi.image(leased.job.jobId, "pail_" + "f".repeat(32)),
      "private_ai_lease_unavailable");
    const image = await f.api.privateAi.image(leased.job.jobId, leased.job.leaseId);
    assert.equal(sha256(image.body), leased.job.mediaSha256);
    assert.deepEqual(image.body, photo.mediaBytes);

    const completion = { schema: "unseen-private-ai-complete-request/1", leaseId: leased.job.leaseId,
      inputHash: leased.job.inputHash, result: result() };
    assert.throws(() => f.api.privateAi.complete(leased.job.jobId, { ...completion,
      result: { ...result(), modelVisibleFacts: ["事实一", "事实二", "事实三"] } }),
    (error) => error.code === "private_ai_result_invalid");
    assert.throws(() => f.api.privateAi.complete(leased.job.jobId, { ...completion,
      result: { ...result(), question: "包含换行\n的问题？" } }),
    (error) => error.code === "private_ai_result_invalid");
    assert.deepEqual(f.api.privateAi.complete(leased.job.jobId, completion), {
      schema: "unseen-private-ai-terminal-response/1", status: "completed", replayed: false, retryAfterMs: null });
    assert.equal(f.api.privateAi.complete(leased.job.jobId, completion).replayed, true);
    assert.throws(() => f.api.privateAi.complete(leased.job.jobId,
      { ...completion, result: result("换一个问题可以吗？") }), (error) => error.code === "private_ai_input_changed");
    const completed = f.db.prepare(`SELECT status,result_json,result_hash,question_context_json
      FROM private_ai_jobs WHERE id=?`).get(first.jobId);
    assert.equal(completed.status, "completed");
    assert.deepEqual(JSON.parse(completed.result_json), result());
    assert.deepEqual(JSON.parse(completed.question_context_json), { kind: "redacted" });
    assert.doesNotMatch(JSON.stringify(completed), /外婆|出发前/u);

    const retryJob = authorizeAndEnqueue(f.api, { photoId: photo.photoId,
      authorizationSnapshotHash: sha256("authorization-two"),
      questionProcessorRequest: processorRequest("two") });
    const retryLease = f.api.privateAi.lease().job;
    const failure = { schema: "unseen-private-ai-fail-request/1", leaseId: retryLease.leaseId,
      inputHash: retryLease.inputHash, failureCode: "model_timeout" };
    const failed = f.api.privateAi.fail(retryJob.jobId, failure);
    assert.deepEqual(failed, { schema: "unseen-private-ai-terminal-response/1", status: "retry",
      replayed: false, retryAfterMs: 5000 });
    assert.equal(f.api.privateAi.fail(retryJob.jobId, failure).replayed, true);
    assert.equal(f.api.privateAi.lease().job, null);
    clock.advance(5000);
    const retryLease2 = f.api.privateAi.lease().job;
    assert.equal(retryLease2.jobId, retryJob.jobId);
    assert.equal(retryLease2.attempt, 2);
    f.db.prepare("UPDATE photos SET version=version+1 WHERE id=?").run(photo.photoId);
    assert.throws(() => f.api.privateAi.complete(retryJob.jobId, {
      schema: "unseen-private-ai-complete-request/1", leaseId: retryLease2.leaseId,
      inputHash: retryLease2.inputHash, result: result()
    }), (error) => error.code === "private_ai_source_stale");
    assert.equal(f.db.prepare("SELECT status FROM private_ai_jobs WHERE id=?").get(retryJob.jobId).status, "failed");

    const restartJob = authorizeAndEnqueue(f.api, { photoId: photo.photoId,
      authorizationSnapshotHash: sha256("authorization-restart"),
      questionProcessorRequest: processorRequest("restart") });
    const restartLease = f.api.privateAi.lease().job;
    assert.equal(restartLease.jobId, restartJob.jobId);
    second.close();
    second = null;
    f.close();
    fClosed = true;
    clock.advance(180_001);
    restarted = new LocalApi(persistentOptions(directory, clock, file));
    assert.equal(restarted.privateAi.lease().job, null);
    clock.advance(5000);
    const reclaimed = restarted.privateAi.lease().job;
    assert.equal(reclaimed.jobId, restartJob.jobId);
    assert.equal(reclaimed.attempt, 2);
    await expectCode(restarted.privateAi.image(restartLease.jobId, restartLease.leaseId),
      "private_ai_lease_unavailable");
    assert.equal(restarted.db.prepare("PRAGMA quick_check").get().quick_check, "ok");
    assert.equal(restarted.mediaStore.networkRequests, 0);

    restarted.db.prepare("UPDATE assets SET observed_mime='application/octet-stream' WHERE id=?")
      .run(photo.mediaAssetId);
    await expectCode(restarted.privateAi.image(reclaimed.jobId, reclaimed.leaseId),
      "private_ai_image_type_unsupported");
    restarted.db.prepare("UPDATE assets SET observed_mime='image/png',observed_bytes=? WHERE id=?")
      .run(PRIVATE_AI_IMAGE_LIMIT + 1, photo.mediaAssetId);
    await expectCode(restarted.privateAi.image(reclaimed.jobId, reclaimed.leaseId),
      "private_ai_image_too_large");
    restarted.db.prepare("UPDATE assets SET observed_bytes=? WHERE id=?").run(photo.mediaBytes.length, photo.mediaAssetId);
    const mediaFile = restarted.mediaStore.fileFor(photo.mediaObjectKey);
    const originalObject = readFileSync(mediaFile);
    const tampered = Buffer.from(originalObject);
    tampered[tampered.length - 1] ^= 0xff;
    writeFileSync(mediaFile, tampered, { mode: 0o600 });
    await expectCode(restarted.privateAi.image(reclaimed.jobId, reclaimed.leaseId), "private_ai_source_stale");
  } finally {
    if (second) second.close();
    if (restarted) restarted.close();
    if (!fClosed) f.close();
  }
});

test("composition outbox replays completion after crash and durably reports provider outage", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-private-ai-outbox-"));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = tokenFile(directory, `worker-${crypto.randomUUID()}`);
  const clock = new TestClock("2026-08-15T00:00:00.000Z");
  const options = persistentOptions(directory, clock, file);
  let f = fixture(options);
  try {
    const photo = await readyPhoto(f);
    const bookRequest = processorRequest("outbox-complete");
    const queued = authorizeAndEnqueue(f.api, { photoId: photo.photoId,
      authorizationSnapshotHash: sha256("authorization-outbox-complete"),
      questionProcessorRequest: bookRequest });
    const lease = f.api.privateAi.lease().job;
    f.api.privateAi.complete(queued.jobId, { schema: "unseen-private-ai-complete-request/1",
      leaseId: lease.leaseId, inputHash: lease.inputHash, result: result() });
    const firstDelivery = f.api.claimPrivateAiCompositionEvent({ leaseMs: 5_000 });
    assert.equal(firstDelivery.eventType, "completed");
    assert.deepEqual(firstDelivery.questionProcessorRequest, bookRequest);
    assert.deepEqual(firstDelivery.completionDto, result());
    assert.doesNotMatch(JSON.stringify(firstDelivery), new RegExp(photo.photoId, "u"));

    const bookApplied = new Set();
    let bookMutations = 0;
    const simulateIdempotentBookCommit = (event) => {
      if (!bookApplied.has(event.eventHash)) { bookApplied.add(event.eventHash); bookMutations += 1; }
    };
    simulateIdempotentBookCommit(firstDelivery);
    f.close();
    f = null;
    clock.advance(5_001);
    f = fixture(persistentOptions(directory, clock, file));
    assert.equal(f.api.claimPrivateAiCompositionEvent({ leaseMs: 5_000 }), null);
    clock.advance(5_000);
    const replayDelivery = f.api.claimPrivateAiCompositionEvent({ leaseMs: 5_000 });
    assert.equal(replayDelivery.eventId, firstDelivery.eventId);
    assert.equal(replayDelivery.eventHash, firstDelivery.eventHash);
    assert.notEqual(replayDelivery.deliveryLeaseId, firstDelivery.deliveryLeaseId);
    assert.deepEqual(replayDelivery.completionDto, firstDelivery.completionDto);
    simulateIdempotentBookCommit(replayDelivery);
    assert.equal(bookMutations, 1, "Book's idempotent commit absorbs crash replay");
    assert.deepEqual(f.api.markPrivateAiCompositionEventDelivered({ eventId: replayDelivery.eventId,
      deliveryLeaseId: replayDelivery.deliveryLeaseId }), { delivered: true, replayed: false });
    assert.deepEqual(f.api.markPrivateAiCompositionEventDelivered({ eventId: replayDelivery.eventId,
      deliveryLeaseId: replayDelivery.deliveryLeaseId }), { delivered: true, replayed: true });

    const outage = authorizeAndEnqueue(f.api, { photoId: photo.photoId,
      authorizationSnapshotHash: sha256("authorization-outbox-outage"),
      questionProcessorRequest: processorRequest("outbox-outage") });
    const outageLease = f.api.privateAi.lease().job;
    const failure = { schema: "unseen-private-ai-fail-request/1", leaseId: outageLease.leaseId,
      inputHash: outageLease.inputHash, failureCode: "model_quota_exhausted" };
    assert.equal(f.api.privateAi.fail(outage.jobId, failure).status, "retry");
    assert.equal(f.api.privateAi.fail(outage.jobId, failure).replayed, true);
    assert.equal(f.db.prepare(`SELECT COUNT(*) count FROM private_ai_composition_outbox
      WHERE ai_job_id=? AND event_type='provider_unavailable'`).get(outage.jobId).count, 1);
    const unavailable = f.api.claimPrivateAiCompositionEvent({ leaseMs: 10_000 });
    assert.equal(unavailable.eventType, "provider_unavailable");
    assert.equal(unavailable.completionDto, null);
    clock.advance(5_000);
    assert.equal(f.api.privateAi.lease().job, null,
      "a leased outage event serializes against retrying its old Book request");
    assert.deepEqual(f.api.retryPrivateAiCompositionEvent({ eventId: unavailable.eventId,
      deliveryLeaseId: unavailable.deliveryLeaseId, failureCode: "consumer_unavailable" }),
    { status: "retry", retryAfterMs: 5_000 });
    assert.equal(f.api.claimPrivateAiCompositionEvent({ leaseMs: 5_000 }), null);
    clock.advance(5_000);
    const unavailableRetry = f.api.claimPrivateAiCompositionEvent({ leaseMs: 5_000 });
    assert.equal(unavailableRetry.eventHash, unavailable.eventHash);
    f.api.markPrivateAiCompositionEventDelivered({ eventId: unavailableRetry.eventId,
      deliveryLeaseId: unavailableRetry.deliveryLeaseId });
    assert.deepEqual({ ...f.db.prepare("SELECT status,stable_error FROM private_ai_jobs WHERE id=?")
      .get(outage.jobId) }, { status: "failed", stable_error: "composition_requeued" });
    assert.equal(f.api.claimPrivateAiCompositionEvent(), null);
    assert.equal(f.db.prepare("PRAGMA quick_check").get().quick_check, "ok");
  } finally { if (f) f.close(); }
});

test("composition outbox quarantines malformed and hash-drifted predecessors without blocking healthy work",
  async (t) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-private-ai-poison-"));
    chmodSync(directory, 0o700);
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const file = tokenFile(directory, `worker-${crypto.randomUUID()}`);
    const clock = new TestClock("2026-08-15T00:00:00.000Z");
    const f = fixture(persistentOptions(directory, clock, file));
    try {
      const photo = await readyPhoto(f);
      const completeOne = (label) => {
        const queued = authorizeAndEnqueue(f.api, { photoId: photo.photoId,
          authorizationSnapshotHash: sha256(`authorization-poison-${label}`),
          questionProcessorRequest: processorRequest(`poison-${label}`) });
        const lease = f.api.privateAi.lease().job;
        f.api.privateAi.complete(queued.jobId, { schema: "unseen-private-ai-complete-request/1",
          leaseId: lease.leaseId, inputHash: lease.inputHash, result: result(`关于${label}最想补充什么？`) });
        const event = f.db.prepare("SELECT id FROM private_ai_composition_outbox WHERE ai_job_id=?")
          .get(queued.jobId);
        clock.advance(1);
        return { jobId: queued.jobId, eventId: event.id };
      };
      const malformed = completeOne("旧照片");
      const requestHashDrift = completeOne("第二张照片");
      const eventHashDrift = completeOne("第三张照片");
      const resultDtoDrift = completeOne("第四张照片");
      const healthy = completeOne("健康照片");

      f.db.exec("PRAGMA ignore_check_constraints=ON");
      f.db.prepare("UPDATE private_ai_composition_outbox SET composition_request_json='{' WHERE id=?")
        .run(malformed.eventId);
      f.db.exec("PRAGMA ignore_check_constraints=OFF");
      f.db.prepare("UPDATE private_ai_jobs SET composition_request_hash=? WHERE id=?")
        .run("0".repeat(64), requestHashDrift.jobId);
      f.db.prepare("UPDATE private_ai_composition_outbox SET event_hash=? WHERE id=?")
        .run("1".repeat(64), eventHashDrift.eventId);
      f.db.prepare("UPDATE private_ai_composition_outbox SET completion_result_json=? WHERE id=?")
        .run(JSON.stringify({ question: "缺少其余严格字段？" }), resultDtoDrift.eventId);

      const claimed = f.api.claimPrivateAiCompositionEvent();
      assert.equal(claimed.eventId, healthy.eventId);
      assert.deepEqual(claimed.completionDto, result("关于健康照片最想补充什么？"));
      const poison = f.db.prepare(`SELECT status,last_error FROM private_ai_composition_outbox
        WHERE id IN (?,?,?,?) ORDER BY created_at,id`).all(
        malformed.eventId, requestHashDrift.eventId, eventHashDrift.eventId, resultDtoDrift.eventId);
      assert.equal(poison.length, 4);
      for (const row of poison) assert.deepEqual({ ...row },
        { status: "quarantined", last_error: "composition_payload_invalid" });
      f.api.markPrivateAiCompositionEventDelivered({ eventId: claimed.eventId,
        deliveryLeaseId: claimed.deliveryLeaseId });
      assert.equal(f.api.claimPrivateAiCompositionEvent(), null);
      assert.equal(f.api.mediaStore.networkRequests, 0);
      assert.equal(f.db.prepare("PRAGMA quick_check").get().quick_check, "ok");
    } finally { f.close(); }
  });

async function httpRequest(origin, token, pathname, { method = "POST", body, headers = {} } = {}) {
  const requestHeaders = { "x-unseen-protocol": PRIVATE_AI_PROTOCOL, "x-forwarded-proto": "https",
    authorization: `Bearer ${token}`, ...headers };
  const init = { method, headers: requestHeaders };
  if (body !== undefined) {
    requestHeaders["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${origin}${pathname}`, init);
  const bytes = Buffer.from(await response.arrayBuffer());
  const value = response.headers.get("content-type")?.startsWith("application/json") ?
    JSON.parse(bytes.toString("utf8")) : bytes;
  return { response, body: value };
}

test("internal HTTPS adapter authenticates, rate-limits, and emits the exact minimal protocol", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-private-ai-http-"));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const token = `worker-${crypto.randomUUID()}`;
  const file = tokenFile(directory, token);
  const clock = new TestClock("2026-08-15T00:00:00.000Z");
  const f = fixture(persistentOptions(directory, clock, file, { maxRequestsPerMinute: 20 }));
  const photo = await readyPhoto(f);
  authorizeAndEnqueue(f.api, { photoId: photo.photoId, authorizationSnapshotHash: sha256("http-authorization"),
    questionProcessorRequest: processorRequest("http") });
  const server = createLocalHttpServer({ api: f.api });
  const listening = await listenLocalHttpServer(server, { host: "127.0.0.1", port: 0 });
  f.api.campaigns.publicOrigin = listening.origin;
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); f.close(); });

  const missingTls = await httpRequest(listening.origin, token, "/__internal/private-ai/v1/jobs/lease", {
    headers: { "x-forwarded-proto": "http" }, body: { schema: "unseen-private-ai-lease-request/1" }
  });
  assert.equal(missingTls.response.status, 426);
  assert.equal(missingTls.body.error.code, "private_ai_https_required");
  const wrongToken = await httpRequest(listening.origin, `${token}-wrong`, "/__internal/private-ai/v1/jobs/lease", {
    body: { schema: "unseen-private-ai-lease-request/1" }
  });
  assert.equal(wrongToken.response.status, 401);
  assert.equal(wrongToken.body.error.code, "private_ai_worker_unauthorized");
  const missingProtocol = await fetch(`${listening.origin}/__internal/private-ai/v1/jobs/lease`, { method: "POST",
    headers: { "x-forwarded-proto": "https", authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ schema: "unseen-private-ai-lease-request/1" }) });
  assert.equal(missingProtocol.status, 400);

  const lease = await httpRequest(listening.origin, token, "/__internal/private-ai/v1/jobs/lease", {
    body: { schema: "unseen-private-ai-lease-request/1" }
  });
  assert.equal(lease.response.status, 200);
  assert.equal(lease.response.headers.get("x-unseen-protocol"), PRIVATE_AI_PROTOCOL);
  assert.deepEqual(Object.keys(lease.body).sort(), ["job", "retryAfterMs", "schema"]);
  assert.equal(lease.body.job.imagePath,
    `/__internal/private-ai/v1/jobs/${encodeURIComponent(lease.body.job.jobId)}/image`);
  assert.doesNotMatch(JSON.stringify(lease.body), new RegExp(`${photo.photoId}|placement|authorization`, "u"));

  const wrongLease = await httpRequest(listening.origin, token, lease.body.job.imagePath, { method: "GET",
    headers: { "x-unseen-ai-lease": "pail_" + "f".repeat(32) } });
  assert.equal(wrongLease.response.status, 409);
  const image = await httpRequest(listening.origin, token, lease.body.job.imagePath, { method: "GET",
    headers: { "x-unseen-ai-lease": lease.body.job.leaseId } });
  assert.equal(image.response.status, 200);
  assert.equal(image.response.headers.get("content-length"), String(lease.body.job.mediaBytes));
  assert.equal(image.response.headers.get("content-type"), lease.body.job.mediaMime);
  assert.equal(image.response.headers.get("x-unseen-content-sha256"), lease.body.job.mediaSha256);
  assert.equal(sha256(image.body), lease.body.job.mediaSha256);

  const completeBody = { schema: "unseen-private-ai-complete-request/1", leaseId: lease.body.job.leaseId,
    inputHash: lease.body.job.inputHash, result: result() };
  const complete = await httpRequest(listening.origin, token,
    `/__internal/private-ai/v1/jobs/${lease.body.job.jobId}/complete`, { body: completeBody });
  assert.equal(complete.response.status, 200);
  assert.deepEqual(complete.body, { schema: "unseen-private-ai-terminal-response/1", status: "completed",
    replayed: false, retryAfterMs: null });
  const replay = await httpRequest(listening.origin, token,
    `/__internal/private-ai/v1/jobs/${lease.body.job.jobId}/complete`, { body: completeBody });
  assert.equal(replay.body.replayed, true);

  let limited = null;
  for (let index = 0; index < 20; index += 1) {
    const response = await httpRequest(listening.origin, token, "/__internal/private-ai/v1/jobs/lease", {
      body: { schema: "unseen-private-ai-lease-request/1" }
    });
    if (response.response.status === 429) { limited = response; break; }
  }
  assert.equal(limited?.body.error.code, "private_ai_rate_limited");
  assert.equal(f.api.mediaStore.networkRequests, 0);
  for (const source of ["../src/private-ai-job-queue.mjs", "../src/http-server.mjs"]) {
    assert.doesNotMatch(readFileSync(new URL(source, import.meta.url), "utf8"), /console\.|process\.(?:stdout|stderr)/u);
  }
});
