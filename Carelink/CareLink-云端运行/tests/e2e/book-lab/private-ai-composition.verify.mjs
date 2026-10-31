import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPrivateAiComposition } from "../../../infra/integration/book-lab/private-ai-composition.mjs";
import { registerBookLabExtension } from "../../../services/api/src/extensions/book-lab.mjs";
import { sha256 } from "../../../services/api/src/util.mjs";
import { dispatchOne } from "../../../services/jobs/dispatch/index.mjs";
import { createAccountUpload, fixture, png } from "../../../services/api/tests/fixture-factory.mjs";
import { BookLabError, COLLECTION_NOTICE_CONTEXT_DISCLOSURE } from
  "../../../services/book-lab/src/index.mjs";

const authorization = Object.freeze({ photoId: "photo-1", authorizationSnapshotHash: "a".repeat(64) });
const request = Object.freeze({ jobId: "question-job-1", jobVersion: 1, kind: "initial_question",
  inputHash: "b".repeat(64), attempt: 1 });

function ports({ event = null, ingest, unavailable } = {}) {
  const calls = [];
  const api = {
    reconcilePrivateAiPhotoAuthorizations() {
      calls.push("api:reconcile");
      return { revokedCount: 1, revocations: [authorization] };
    },
    revokePrivateAiPhotoAuthorization(value) { calls.push(["api:revoke", value]); },
    authorizePrivateAiPhoto(value) { calls.push(["api:authorize", value]); },
    enqueuePrivateAiPhoto(value) { calls.push(["api:enqueue", value]); },
    claimPrivateAiCompositionEvent() { calls.push("api:claim"); return event; },
    markPrivateAiCompositionEventDelivered(value) { calls.push(["api:mark", value]); },
    retryPrivateAiCompositionEvent(value) { calls.push(["api:retry", value]); }
  };
  const bookRuntime = {
    revokePrivateQuestionSources(value) { calls.push(["book:revoke", value]); return { revokedCount: value.length }; },
    reconcilePrivateQuestionSources() {
      calls.push("book:reconcile");
      return { revokedCount: 1, revocations: [{ ...authorization, authorizationSnapshotHash: "c".repeat(64) }] };
    },
    privateAiCompositionIntents() {
      calls.push("book:intents");
      return { revoke: [{ ...authorization, authorizationSnapshotHash: "d".repeat(64) }],
        authorize: [{ ...authorization, questionProcessorRequest: request }] };
    },
    ingestPrivateQuestionResult(value, dto) {
      calls.push(["book:ingest", value, dto]);
      return ingest ? ingest(value, dto) : { status: "ready" };
    },
    recordQuestionProviderUnavailable(value) {
      calls.push(["book:unavailable", value]);
      return unavailable ? unavailable(value) : null;
    }
  };
  return { api, bookRuntime, calls };
}

test("composition reconciles before enqueue and delivers a completed event exactly once", async () => {
  const event = { eventId: "event-1", eventType: "completed", deliveryLeaseId: "lease-1",
    questionProcessorRequest: request, completionDto: { question: "可见问题？" } };
  const p = ports({ event });
  const composition = createPrivateAiComposition(p);
  const result = await composition.runOnce();
  assert.deepEqual(result, { reconciledCoreCount: 1, reconciledBookCount: 1, revokedIntentCount: 1,
    enqueuedCount: 1, staleCount: 0, deliveredCount: 1, retriedCount: 0 });
  assert.deepEqual(p.calls, [
    "api:reconcile",
    ["book:revoke", [authorization]],
    "book:reconcile",
    ["api:revoke", { ...authorization, authorizationSnapshotHash: "c".repeat(64) }],
    "book:intents",
    ["api:revoke", { ...authorization, authorizationSnapshotHash: "d".repeat(64) }],
    ["api:authorize", authorization],
    ["api:enqueue", { ...authorization, questionProcessorRequest: request }],
    "api:claim",
    ["book:ingest", request, event.completionDto],
    ["api:mark", { eventId: "event-1", deliveryLeaseId: "lease-1" }]
  ]);
  await composition.close();
});

test("committed model_unavailable is delivered while other consumer errors retry", async () => {
  const event = { eventId: "event-2", eventType: "provider_unavailable", deliveryLeaseId: "lease-2",
    questionProcessorRequest: request, completionDto: null };
  const committed = ports({ event, unavailable() { throw new BookLabError("model_unavailable", 503); } });
  const first = createPrivateAiComposition(committed);
  assert.equal((await first.runOnce()).deliveredCount, 1);
  assert.ok(committed.calls.some((entry) => Array.isArray(entry) && entry[0] === "api:mark"));
  assert.ok(!committed.calls.some((entry) => Array.isArray(entry) && entry[0] === "api:retry"));
  await first.close();

  const failed = ports({ event, unavailable() { throw new BookLabError("question_input_changed", 409); } });
  const second = createPrivateAiComposition(failed);
  assert.equal((await second.runOnce()).retriedCount, 1);
  assert.ok(failed.calls.some((entry) => Array.isArray(entry) && entry[0] === "api:retry" &&
    entry[1].failureCode === "consumer_conflict"));
  await second.close();
});

test("runOnce is single-flight and close rejects future work", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const p = ports();
  p.bookRuntime.reconcilePrivateQuestionSources = async () => {
    p.calls.push("book:reconcile");
    await gate;
    return { revokedCount: 0, revocations: [] };
  };
  const composition = createPrivateAiComposition(p);
  const first = composition.runOnce();
  const second = composition.runOnce();
  assert.equal(first, second);
  release();
  await first;
  await composition.close();
  await assert.rejects(composition.runOnce(), /private_ai_composition_closed/u);
});

async function activatePanorama(f, owner, space) {
  const bytes = png(1600, 800);
  const current = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(space.spaceId);
  const candidate = await f.ok("POST", `/v1/spaces/${space.spaceId}/panorama-candidates`, {
    declaredMime: "image/png", declaredBytes: bytes.length, clientAssetId: "composition-panorama"
  }, { ...owner.headers, "if-match": String(current.version),
    "notice-acknowledgement": JSON.stringify({ purpose: "panorama_upload", version: 1,
      contentHash: "local-panorama_upload-v1" }) });
  const put = await f.api.putMedia({ ticket: candidate.exactPrivateUploadTicketOnce,
    bytes, contentType: "image/png", kind: "panorama" });
  const committed = await f.ok("POST", `/v1/panorama-upload-sessions/${candidate.uploadSessionId}/commits`,
    { clientRequestId: "composition-panorama-commit" },
    { ...owner.headers, "if-match": String(put.body.uploadSessionVersion) });
  const ready = dispatchOne(f.db, committed.jobId, { now: f.clock.iso() });
  const scene = f.db.prepare("SELECT * FROM scenes WHERE space_id=?").get(space.spaceId);
  const before = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(space.spaceId);
  await f.ok("POST", `/v1/spaces/${space.spaceId}/panorama-switches`, {
    mode: "switch", candidateRevisionId: ready.panoramaRevisionId, sceneIfMatchVersion: scene.version
  }, { ...owner.headers, "if-match": String(before.version) });
  return { ...space, version: f.db.prepare("SELECT version FROM spaces WHERE id=?").get(space.spaceId).version };
}

test("real Core queue and Book seam complete once then purge the ready question on version drift", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-private-ai-composition-real-"));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const model = "test-private-image-model";
  const modelVersion = "test-private-image-model-v1";
  const promptHash = sha256("composition-real-prompt");
  const policyHash = sha256("composition-real-policy");
  const tokenHashFile = path.join(directory, "worker-token.sha256");
  writeFileSync(tokenHashFile, `${sha256("composition-real-worker-token")}\n`, { mode: 0o600 });
  chmodSync(tokenHashFile, 0o600);
  let runtime;
  const testSecret = (purpose) => `test-${purpose}-${"x".repeat(40)}`;
  const collectionNoticeCopy =
    `私有 AI 内测：照片保存后可稍后生成一个可跳过的问题。${COLLECTION_NOTICE_CONTEXT_DISCLOSURE}`;
  const bookOptions = {
    database: path.join(directory, "book.sqlite"), renderTemporaryRoot: path.join(directory, "render-tmp"),
    etagSecret: testSecret("etag"),
    workerSecret: testSecret("worker"),
    cleanupSecret: testSecret("cleanup"),
    renderWorkerSecret: testSecret("render"),
    collectionNoticeVersion: "composition-notice-v1",
    collectionNoticeHash: sha256(collectionNoticeCopy),
    collectionNoticeCopy,
    grantNoticeVersion: "composition-grant-v1", grantNoticeHash: sha256("composition-grant-v1"),
    privateAiEnabled: true, privateAiModel: model, privateAiModelVersion: modelVersion,
    privateAiPromptHash: promptHash, privateAiPolicyHash: policyHash
  };
  const f = fixture({ featureFlags: { bookLab: true, privateAiWorker: true },
    privateAi: { tokenHashFile, model, modelVersion, promptHash, policyHash },
    extensionModuleLoader: async () => ({ registerBookLabExtension(input) {
      runtime = registerBookLabExtension(input, bookOptions);
      return runtime;
    } }) });
  let composition;
  try {
    await f.api.ready;
    const owner = await f.login("composition-owner@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    space = await activatePanorama(f, owner, space);
    const flow = await createAccountUpload(f, owner, space, png(96, 64, "#315477"));
    const photo = f.db.prepare("SELECT * FROM photos WHERE id=?").get(flow.committed.photoId);
    const item = f.db.prepare("SELECT * FROM contribution_batch_items WHERE id=?").get(photo.batch_item_id);
    f.db.prepare("UPDATE photos SET captured_at='2026-08-15T00:00:00.000Z' WHERE id=?").run(photo.id);
    const placed = await f.ok("POST", `/v1/photos/${photo.id}/placement-revisions`, {
      mode: "manual", confirmationMode: "manual", yawDeg: 42, pitchDeg: 3, regionId: "main",
      reason: "composition-real-test"
    }, { ...owner.headers, "if-match": String(photo.version), "x-item-version": String(item.version),
      "x-placement-authorization-version": String(item.placement_authorization_version) });
    await f.ok("POST", `/v1/photos/${photo.id}/content-transitions`, {
      to: "visible", transitionReasonCode: "manual_approved", decisionReasonCode: null
    }, { ...owner.headers, "if-match": String(placed.version) });

    const open = await f.api.handle({ method: "GET", path: `/v2-labs/memories/photos/${photo.id}`,
      headers: owner.headers, body: {} });
    assert.equal(open.status, 200);
    assert.equal(open.body.eligibility, "eligible");
    const started = await f.api.handle({ method: "POST",
      path: `/v2-labs/memories/photos/${photo.id}/question-jobs`, headers: { ...owner.headers,
        "if-none-match": "*", "idempotency-key": "composition-real-start-abcdefgh" }, body: {
        noticeVersion: open.body.collectionNotice.version, noticeHash: open.body.collectionNotice.hash,
        photoContentHash: open.body.provenance.photoContentHash,
        placementSnapshotHash: open.body.provenance.placementSnapshotHash
      } });
    assert.equal(started.status, 200);
    assert.equal(typeof started.body.personalMemoryId, "string", JSON.stringify(started.body));

    composition = createPrivateAiComposition({ api: f.api, bookRuntime: runtime });
    assert.equal((await composition.runOnce()).enqueuedCount, 1);
    const lease = f.api.privateAi.lease().job;
    assert.ok(lease);
    const question = "蓝色背景前摆着一件浅色物品，你记得当时正在做什么？";
    f.api.privateAi.complete(lease.jobId, { schema: "unseen-private-ai-complete-request/1",
      leaseId: lease.leaseId, inputHash: lease.inputHash, result: {
        modelVisibleFacts: ["蓝色背景前摆着一件浅色物品"], question, questionIntent: "photo_context",
        model, modelVersion, latencyMs: 321
      } });
    assert.equal((await composition.runOnce()).deliveredCount, 1);
    let detail = await f.api.handle({ method: "GET", path: `/v2-labs/memories/photos/${photo.id}`,
      headers: owner.headers, body: {} });
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.recoverableQuestionJobs[0].question, question);

    f.db.prepare("UPDATE photos SET version=version+1 WHERE id=?").run(photo.id);
    const drift = await composition.runOnce();
    assert.equal(drift.reconciledCoreCount, 1);
    assert.equal(drift.reconciledBookCount, 0);
    detail = await f.api.handle({ method: "GET", path: `/v2-labs/memories/photos/${photo.id}`,
      headers: owner.headers, body: {} });
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.memory.status, "question_failed");
    assert.equal(detail.body.recoverableQuestionJobs[0].question, null);
    assert.equal(detail.body.recoverableQuestionJobs[0].recovery.lastStableError, "question_source_revoked");
    assert.equal(f.db.prepare("SELECT active FROM private_ai_authorizations").get().active, 0);
    assert.equal(runtime.privateAiCompositionIntents().authorize.length, 0);
  } finally {
    if (composition) await composition.close();
    runtime?.close();
    f.close();
  }
});
