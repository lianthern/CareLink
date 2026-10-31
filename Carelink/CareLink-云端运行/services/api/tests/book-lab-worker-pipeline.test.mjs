// Exercises the real services/api/src/extensions/book-lab.mjs wiring (not a stub) end to end, at two
// UNSEEN_PRIVATE_AI_WORKER_ENABLED settings, to answer: what actually happens with the private-AI worker
// off vs. on, and how far "create book -> generate preview -> freeze -> PDF" gets without touching
// book-lab.mjs itself. There is no shipped process anywhere in this repository (checked local-operable.mjs,
// infra/integration/book-lab/deployment-entrypoint.mjs, and every non-test .mjs file) that ever calls
// api.dispatchInternalJob("internal:book-lab-render-processor", ...) or leases/completes a real
// PrivateAiJobQueue job — that plumbing is deliberately reproduced here (reading the book-lab sqlite file
// directly, exactly like an external job runner would) rather than invented as new production code.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fixture, createAccountUpload, png } from "./fixture-factory.mjs";
import { createPrivateAiComposition } from "../../../infra/integration/book-lab/private-ai-composition.mjs";
import { findLocalBrowser } from "../../../packages/book-renderer/src/pdf.mjs";
import { COLLECTION_NOTICE_CONTEXT_DISCLOSURE } from "../../book-lab/src/index.mjs";
import { sha256 } from "../src/util.mjs";

function writeBrowserArgumentRecorder(directory) {
  const argsPath = path.join(directory, "chrome-args.txt");
  const browserPath = path.join(directory, "chrome-argument-recorder.sh");
  const source = `#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(argsPath)}
exec ${JSON.stringify(findLocalBrowser())} "$@"
`;
  writeFileSync(browserPath, source, { mode: 0o700 });
  chmodSync(browserPath, 0o700);
  return { argsPath, browserPath };
}

async function activatePanorama(f, owner, space, label) {
  const bytes = png(1600, 800);
  const current = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(space.spaceId);
  const candidate = await f.ok("POST", `/v1/spaces/${space.spaceId}/panorama-candidates`, {
    declaredMime: "image/png", declaredBytes: bytes.length, clientAssetId: `${label}-panorama`
  }, { ...owner.headers, "if-match": String(current.version),
    "notice-acknowledgement": JSON.stringify({ purpose: "panorama_upload", version: 1,
      contentHash: "local-panorama_upload-v1" }) });
  const put = await f.api.putMedia({ ticket: candidate.exactPrivateUploadTicketOnce,
    bytes, contentType: "image/png", kind: "panorama" });
  const committed = await f.ok("POST", `/v1/panorama-upload-sessions/${candidate.uploadSessionId}/commits`,
    { clientRequestId: `${label}-panorama-commit` },
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

async function readyVisiblePhoto(f, owner, space, label) {
  const flow = await createAccountUpload(f, owner, space);
  const photo = f.db.prepare("SELECT * FROM photos WHERE id=?").get(flow.committed.photoId);
  const item = f.db.prepare("SELECT * FROM contribution_batch_items WHERE id=?").get(photo.batch_item_id);
  f.db.prepare("UPDATE photos SET captured_at='2026-08-13T04:34:56.000Z' WHERE id=?").run(photo.id);
  const placed = await f.ok("POST", `/v1/photos/${photo.id}/placement-revisions`, {
    mode: "manual", confirmationMode: "manual", yawDeg: 42, pitchDeg: 3, regionId: "main", reason: `${label}-placement`
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
  return f.db.prepare("SELECT * FROM photos WHERE id=?").get(photo.id);
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

function bookLabModuleLoader(env, capture) {
  return async () => {
    const module = await import("../src/extensions/book-lab.mjs");
    return { registerBookLabExtension: (input) => {
      const runtime = module.registerBookLabExtension(input, { env });
      if (capture) capture(runtime);
      return runtime;
    } };
  };
}

test("privateAiWorker off: book creation still works, but the contributor Q&A pipeline is fully dead — " +
  "not just question-jobs, even skip is blocked, because l3Enabled is wired to featureFlags.privateAiWorker", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "unseen-book-lab-degrade-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bookLabEnv = bookLabTestEnv(dir);
  const f = fixture({ featureFlags: { bookLab: true, privateAiWorker: false },
    extensionModuleLoader: bookLabModuleLoader(bookLabEnv) });
  t.after(() => f.close());
  await f.api.ready;

  const owner = await f.login("book-degrade-owner@example.test");
  let space = await f.createSpace(owner, "退化测试");
  space = await f.openSpace(owner, space);
  space = await activatePanorama(f, owner, space, "degrade");
  const photo = await readyVisiblePhoto(f, owner, space, "degrade");

  const created = await f.call("POST", `/v2-labs/owner/spaces/${space.spaceId}/books`,
    { bookId: "degrade-book", title: "退化测试书", eventId: space.spaceId }, { ...owner.headers, "if-none-match": "*" });
  assert.equal(created.status, 200, "owner can still create an (empty) book with no private AI worker");

  const opened = await f.call("GET", `/v2-labs/memories/photos/${photo.id}`, {}, owner.headers);
  assert.equal(opened.status, 200);
  assert.equal(opened.body.eligibility, "disabled");
  assert.equal(opened.headers["x-unseen-question-provider"], "unavailable");

  const started = await f.call("POST", `/v2-labs/memories/photos/${photo.id}/question-jobs`, {
    noticeVersion: opened.body.collectionNotice.version, noticeHash: opened.body.collectionNotice.hash,
    photoContentHash: opened.body.provenance.photoContentHash, placementSnapshotHash: opened.body.provenance.placementSnapshotHash
  }, { ...owner.headers, "if-none-match": opened.body.interviewPrecondition.ifNoneMatch });
  assert.equal(started.status, 503);
  assert.equal(started.body.error.code, "model_unavailable");

  // Even the no-AI fallback (skip the photo without answering) is blocked, because assertPhotoReady()
  // requires l3Enabled === true, and l3Enabled is hard-wired to featureFlags.privateAiWorker in api.mjs's
  // bookLabPhotoDto(). So with the worker off there is no way to attach real page content to a book at all.
  const skip = await f.call("POST", `/v2-labs/memories/photos/${photo.id}/skip`, {}, owner.headers);
  assert.equal(skip.status, 409);
  assert.equal(skip.body.error.code, "photo_not_ready");
});

test("privateAiWorker on: a simulated external worker completes a real question end to end — " +
  "question-jobs -> PrivateAiJobQueue lease/image/complete -> composition ingest -> answer -> confirm -> grant", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "unseen-book-lab-happy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const PRIVATE_AI_MODEL = "test-model";
  const PRIVATE_AI_MODEL_VERSION = "test-model-v1";
  const PRIVATE_AI_PROMPT_HASH = sha256("test-prompt");
  const PRIVATE_AI_POLICY_HASH = sha256("test-policy");
  const browserRecorder = writeBrowserArgumentRecorder(dir);
  const bookLabEnv = bookLabTestEnv(dir, {
    UNSEEN_PRIVATE_AI_WORKER_ENABLED: "true",
    UNSEEN_PRIVATE_AI_MODEL: PRIVATE_AI_MODEL,
    UNSEEN_PRIVATE_AI_MODEL_VERSION: PRIVATE_AI_MODEL_VERSION,
    UNSEEN_PRIVATE_AI_PROMPT_HASH: PRIVATE_AI_PROMPT_HASH,
    UNSEEN_PRIVATE_AI_POLICY_HASH: PRIVATE_AI_POLICY_HASH,
    UNSEEN_CHROMIUM_PATH: browserRecorder.browserPath
  });
  const workerToken = randomBytes(32).toString("hex");
  const tokenHashFile = path.join(dir, "worker.token.sha256");
  writeFileSync(tokenHashFile, createHash("sha256").update(workerToken).digest("hex"), { mode: 0o600 });
  chmodSync(tokenHashFile, 0o600);

  let bookRuntime = null;
  const f = fixture({
    featureFlags: { bookLab: true, privateAiWorker: true },
    privateAi: { tokenHashFile, promptHash: PRIVATE_AI_PROMPT_HASH, policyHash: PRIVATE_AI_POLICY_HASH,
      model: PRIVATE_AI_MODEL, modelVersion: PRIVATE_AI_MODEL_VERSION },
    extensionModuleLoader: bookLabModuleLoader(bookLabEnv, (runtime) => { bookRuntime = runtime; })
  });
  t.after(async () => { if (bookRuntime) await bookRuntime.close(); f.close(); });
  await f.api.ready;
  assert.ok(bookRuntime, "the real book-lab extension mounted");

  const owner = await f.login("book-happy-owner@example.test");
  let space = await f.createSpace(owner, "现场回忆测试");
  space = await f.openSpace(owner, space);
  space = await activatePanorama(f, owner, space, "happy");
  const photo = await readyVisiblePhoto(f, owner, space, "happy");

  const bookId = "happy-book";
  const created = await f.call("POST", `/v2-labs/owner/spaces/${space.spaceId}/books`,
    { bookId, title: "现场回忆", eventId: space.spaceId }, { ...owner.headers, "if-none-match": "*" });
  assert.equal(created.status, 200);

  const opened = await f.call("GET", `/v2-labs/memories/photos/${photo.id}`, {}, owner.headers);
  assert.equal(opened.body.eligibility, "eligible");
  const started = await f.call("POST", `/v2-labs/memories/photos/${photo.id}/question-jobs`, {
    noticeVersion: opened.body.collectionNotice.version, noticeHash: opened.body.collectionNotice.hash,
    photoContentHash: opened.body.provenance.photoContentHash, placementSnapshotHash: opened.body.provenance.placementSnapshotHash
  }, { ...owner.headers, "if-none-match": opened.body.interviewPrecondition.ifNoneMatch });
  assert.equal(started.status, 200);
  assert.equal(started.body.status, "queued");

  // Drive the composition bridge (services/api mounts this the same way local-operable.mjs now does when
  // UNSEEN_PRIVATE_AI_WORKER_ENABLED=true) to authorize + enqueue the photo on the real PrivateAiJobQueue.
  const composition = createPrivateAiComposition({ api: f.api, bookRuntime });
  const cycle1 = await composition.runOnce();
  assert.equal(cycle1.enqueuedCount, 1);

  // Act as the external worker over the *real* pull protocol (lease -> fetch image -> complete). Nothing in
  // this repository implements a real model call for this protocol (see the final report for what does).
  const lease = f.api.privateAi.lease();
  assert.ok(lease.job, "a job was queued for lease");
  const image = await f.api.privateAi.image(lease.job.jobId, lease.job.leaseId);
  assert.ok(image.body.length > 0);
  const result = { latencyMs: 500, model: PRIVATE_AI_MODEL, modelVersion: PRIVATE_AI_MODEL_VERSION,
    modelVisibleFacts: ["桌上放着一朵蓝色的花", "旁边摆着一本笔记本"], question: "桌上的花是什么颜色？",
    questionIntent: "photo_context" };
  const completion = f.api.privateAi.complete(lease.job.jobId, { schema: "unseen-private-ai-complete-request/1",
    leaseId: lease.job.leaseId, inputHash: lease.job.inputHash, result });
  assert.equal(completion.status, "completed");

  const cycle2 = await composition.runOnce();
  assert.equal(cycle2.deliveredCount, 1, "the composed question was ingested into the book-lab question job");

  const detail = await f.call("GET", `/v2-labs/memories/${started.body.personalMemoryId}`, {}, owner.headers);
  assert.equal(detail.status, 200, "the integrated memory-detail route must be mounted by the real extension");
  assert.equal((await f.call("GET", `/v2-labs/memories/${started.body.personalMemoryId}`)).status, 404);
  const outsider = await f.login("book-memory-outsider@example.test");
  assert.equal((await f.call("GET", `/v2-labs/memories/${started.body.personalMemoryId}`, {}, outsider.headers)).status, 404);
  assert.equal(detail.body.memory.status, "question_ready");
  const readyJob = detail.body.recoverableQuestionJobs.find((job) => job.status === "ready");
  assert.ok(readyJob, `expected a ready question job, got ${JSON.stringify(detail.body.recoverableQuestionJobs)}`);

  const answerText = "这是用户确认的原话，描述了当时的场景。";
  const saved = await f.call("PUT", `/v2-labs/memories/${started.body.personalMemoryId}/answer-submissions`, {
    clientSubmissionId: "answer-1", userText: answerText, previousSubmissionId: null,
    interviewIfMatchVersion: detail.body.memory.interviewVersion
  }, { ...owner.headers, "if-match": detail.headers["x-unseen-memory-etag"] });
  assert.equal(saved.status, 200);

  const confirmed = await f.call("POST", `/v2-labs/memories/${started.body.personalMemoryId}/confirmations`, {
    submissionId: "answer-1", submissionHash: sha256(answerText),
    interviewIfMatchVersion: saved.body.memory.interviewVersion
  }, { ...owner.headers, "if-match": saved.headers["x-unseen-memory-etag"] });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.memory.status, "confirmed");

  const detail2 = await f.call("GET", `/v2-labs/memories/photos/${photo.id}`, {}, owner.headers);
  const bookToken = JSON.parse(detail2.headers["x-unseen-book-authorization-etags"])[bookId];
  const grant = await f.call("POST", `/v2-labs/books/${bookId}/contribution-grants/${started.body.personalMemoryId}`, {
    personalMemoryId: started.body.personalMemoryId, memoryRevisionId: confirmed.body.memory.memoryRevisionId,
    confirmedSubmissionHash: confirmed.body.memory.confirmedSubmissionHash, creditLabel: "贡献者",
    audienceScope: "current_live_space_viewers", noticeVersion: bookLabEnv.UNSEEN_BOOK_LAB_GRANT_NOTICE_VERSION,
    noticeHash: bookLabEnv.UNSEEN_BOOK_LAB_GRANT_NOTICE_HASH
  }, { ...owner.headers, "if-match": bookToken, "if-none-match": "*" });
  assert.equal(grant.status, 200, "a real, AI-question-derived memory can be granted into the book");

  // Assemble real independently authorized sources through the owner API, never SQL-filled pages.
  const sourceGrantIds = [grant.body.grantId], sourceMemoryIds = [started.body.personalMemoryId];
  for (let n = 1; n <= 5; n += 1) {
    const nextPhoto = await readyVisiblePhoto(f, owner, space, `assembly-source-${n}`);
    const workspace = await f.ok("GET", `/v2-labs/memories/photos/${nextPhoto.id}`, {}, owner.headers);
    const question = await f.ok("POST", `/v2-labs/memories/photos/${nextPhoto.id}/question-jobs`, {
      noticeVersion: workspace.collectionNotice.version, noticeHash: workspace.collectionNotice.hash,
      photoContentHash: workspace.provenance.photoContentHash, placementSnapshotHash: workspace.provenance.placementSnapshotHash
    }, { ...owner.headers, "if-none-match": "*" });
    await composition.runOnce();
    const work = f.api.privateAi.lease().job;
    f.api.privateAi.complete(work.jobId, { schema: "unseen-private-ai-complete-request/1", leaseId: work.leaseId,
      inputHash: work.inputHash, result: { ...result, question: `本地模拟第 ${n} 张：桌上的花是什么颜色？` } });
    for (let cycle=0;cycle<10;cycle+=1) await composition.runOnce();
    const detail = await f.call("GET", `/v2-labs/memories/${question.personalMemoryId}`, {}, owner.headers);
    assert.equal(detail.body.memory.status, "question_ready", JSON.stringify({detail:detail.body, work, nextPhoto:nextPhoto.id}));
    const text = `明确测试来源 ${n} 的独立原话。`;
    const submissionId = `assembly-submission-${n}`;
    const answer = await f.call("PUT", `/v2-labs/memories/${question.personalMemoryId}/answer-submissions`, {
      clientSubmissionId: submissionId, userText: text, previousSubmissionId: null,
      interviewIfMatchVersion: detail.body.memory.interviewVersion
    }, { ...owner.headers, "if-match": detail.headers["x-unseen-memory-etag"] });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    const confirmation = await f.call("POST", `/v2-labs/memories/${question.personalMemoryId}/confirmations`, {
      submissionId, submissionHash: sha256(text), interviewIfMatchVersion: answer.body.memory.interviewVersion
    }, { ...owner.headers, "if-match": answer.headers["x-unseen-memory-etag"] });
    const authorizedView = await f.call("GET", `/v2-labs/memories/${question.personalMemoryId}`, {}, owner.headers);
    const consent = await f.ok("POST", `/v2-labs/books/${bookId}/contribution-grants/${question.personalMemoryId}`, {
      personalMemoryId: question.personalMemoryId, memoryRevisionId: confirmation.body.memory.memoryRevisionId,
      confirmedSubmissionHash: confirmation.body.memory.confirmedSubmissionHash, creditLabel: `测试贡献 ${n}`,
      audienceScope: "current_live_space_viewers", noticeVersion: bookLabEnv.UNSEEN_BOOK_LAB_GRANT_NOTICE_VERSION,
      noticeHash: bookLabEnv.UNSEEN_BOOK_LAB_GRANT_NOTICE_HASH
    }, { ...owner.headers, "if-match": JSON.parse(authorizedView.headers["x-unseen-book-authorization-etags"])[bookId], "if-none-match": "*" });
    sourceGrantIds.push(consent.grantId); sourceMemoryIds.push(question.personalMemoryId);
  }
  const selectedGrantIds = sourceGrantIds.slice(0, 5);
  const assemblyPath = `/v2-labs/owner/spaces/${space.spaceId}/books/${bookId}/draft/assembly`;
  const sourcePath = `/v2-labs/owner/spaces/${space.spaceId}/books/${bookId}/draft/sources`;
  const sourceList = await f.call("GET", sourcePath, {}, owner.headers);
  assert.equal(sourceList.status, 200);
  assert.equal(sourceList.body.sources.length, 6);
  assert.equal((await f.call("GET", sourcePath, {}, outsider.headers)).status, 409);
  const beforeAssembly = await f.call("GET", `/v2-labs/owner/spaces/${space.spaceId}/books/${bookId}/draft`, {}, owner.headers);
  const assemblyHeaders = { ...owner.headers, "if-match": beforeAssembly.headers["x-unseen-book-etag"] };
  assert.equal((await f.call("POST", assemblyPath, { grantIds: selectedGrantIds.slice(0, 1) }, assemblyHeaders)).body.error.code, "book_sources_insufficient");
  assert.equal((await f.call("POST", assemblyPath, { grantIds: selectedGrantIds }, { ...assemblyHeaders, "if-match": '"stale"' })).status, 409);
  assert.equal((await f.call("POST", assemblyPath, { grantIds: selectedGrantIds }, outsider.headers)).status, 409);
  const unchanged = await f.ok("GET", `/v2-labs/owner/spaces/${space.spaceId}/books/${bookId}/draft`, {}, owner.headers);
  assert.equal(unchanged.draftVersionId, beforeAssembly.body.draftVersionId);
  const successfulAssemblyHeaders = { ...assemblyHeaders, "idempotency-key": "assembly-replay-revocation-regression" };
  const assembled = await f.ok("POST", assemblyPath, { grantIds: selectedGrantIds }, successfulAssemblyHeaders);
  assert.deepEqual(await f.ok("POST", assemblyPath, { grantIds: selectedGrantIds }, successfulAssemblyHeaders), assembled);
  assert.equal(assembled.pages.length, 12);
  assert.equal(new Set(assembled.pages.filter(page => page.sourcePhotoId).map(page => page.sourcePhotoId)).size, 5);
  assert.equal(new Set(assembled.pages.map(page => page.authorizedMemoryTextId).filter(Boolean)).size, 5, "photo/quote spread must not inflate distinct quotations");
  assert.equal(assembled.pages[0].kind, "cover");
  assert.equal(assembled.pages.at(-1).kind, "closing");
  assert.equal((await f.call("POST", assemblyPath, { grantIds: selectedGrantIds }, assemblyHeaders)).status, 409);

  const current = await f.call("GET", `/v2-labs/owner/spaces/${space.spaceId}/books/${bookId}/draft`, {}, owner.headers);
  const queued = await f.call("POST", `/v2-labs/owner/spaces/${space.spaceId}/books/${bookId}/render-jobs`, {
    renderJobId: "preview-obsolete", draftVersionId: current.body.draftVersionId, grantSetHash: current.body.grantSetHash,
    layoutProfile: "book-lab-v1"
  }, { ...owner.headers, "if-match": current.headers["x-unseen-book-etag"], "if-none-match": "*" });
  assert.equal(queued.status, 200);
  const withdrawalView = await f.call("GET", `/v2-labs/memories/${started.body.personalMemoryId}`, {}, owner.headers);
  const withdrawalTag = JSON.parse(withdrawalView.headers["x-unseen-book-withdrawal-etags"])[bookId].etag;
  await f.ok("POST", `/v2-labs/books/${bookId}/contribution-grants/${started.body.personalMemoryId}/withdrawals`,
    { reason: "local fixture revocation check" }, { ...owner.headers, "if-match": withdrawalTag });
  const replayAfterWithdrawal = await f.call("POST", assemblyPath, { grantIds: selectedGrantIds }, successfulAssemblyHeaders);
  assert.equal(replayAfterWithdrawal.status, 409, "withdrawal must block old successful assembly before cleanup");
  assert.deepEqual(replayAfterWithdrawal.body.error.code, "book_source_authorization_changed");
  assert.equal(replayAfterWithdrawal.body.pages, undefined);
  await bookRuntime.processPendingGrantCleanup();
  const replayAfterCleanup = await f.call("POST", assemblyPath, { grantIds: selectedGrantIds }, successfulAssemblyHeaders);
  assert.equal(replayAfterCleanup.status, 409);
  assert.equal(replayAfterCleanup.body.pages, undefined);
  assert.equal(replayAfterCleanup.body.error.code, "book_source_authorization_changed");
  const collisionAfterPurge = await f.call("POST", assemblyPath, { grantIds: sourceGrantIds.slice(1) }, successfulAssemblyHeaders);
  assert.equal(collisionAfterPurge.body.error.code, "idempotency_key_reused", "purge retains original key/body binding");
  const receiptDb = new DatabaseSync(bookLabEnv.UNSEEN_BOOK_LAB_DB);
  assert.equal(receiptDb.prepare("SELECT COUNT(*) count FROM idempotency_receipts WHERE action_id='BOOK.ASSEMBLE' AND response_json LIKE ?").get(`%${grant.body.grantId}%`).count, 0, "cleanup removes all reconstructable assembly source provenance");
  receiptDb.close();
  const queuedDraft = await f.call("GET", `/v2-labs/owner/spaces/${space.spaceId}/books/${bookId}/draft`, {}, owner.headers);
  assert.equal(queuedDraft.body.status, "stale");
  const remainingSources = await f.ok("GET", sourcePath, {}, owner.headers);
  assert.equal(remainingSources.sources.length, 5);
  assert.ok(remainingSources.sources.every(source => source.grantId !== grant.body.grantId));
  const deniedAssembly = await f.call("POST", assemblyPath, { grantIds: selectedGrantIds },
    { ...owner.headers, "if-match": queuedDraft.headers["x-unseen-book-etag"] });
  assert.equal(deniedAssembly.status, 409);
  const reassembled = await f.call("POST", assemblyPath, { grantIds: sourceGrantIds.slice(1) },
    { ...owner.headers, "if-match": queuedDraft.headers["x-unseen-book-etag"] });
  assert.equal(reassembled.status, 200);
  const cancelledDb = new DatabaseSync(bookLabEnv.UNSEEN_BOOK_LAB_DB);
  assert.equal(cancelledDb.prepare("SELECT status FROM book_render_jobs WHERE id='preview-obsolete'").get().status, "cancelled");
  cancelledDb.close();
  await f.ok("POST", `/v2-labs/owner/spaces/${space.spaceId}/books/${bookId}/render-jobs`, {
    renderJobId: "preview", draftVersionId: reassembled.body.draftVersionId, grantSetHash: reassembled.body.grantSetHash,
    layoutProfile: "book-lab-v1"
  }, { ...owner.headers, "if-match": reassembled.headers["x-unseen-book-etag"], "if-none-match": "*" });


  // Read persisted outcomes for assertions; execution uses the opt-in local worker loop below.
  function readPendingRenderRequest(dbPath, where) {
    const db = new DatabaseSync(dbPath);
    const row = db.prepare(`SELECT * FROM book_render_jobs WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT 1`).get();
    db.close();
    if (!row) return null;
    return { row, request: { renderJobId: row.id, jobVersion: row.version, draftVersionId: row.draft_version_id,
      manifestHash: row.manifest_hash, grantSetHash: row.grant_set_hash, sourceSnapshotHash: row.source_snapshot_hash,
      authorizedMemoryTextSnapshotHash: row.authorized_text_snapshot_hash, assetSnapshotHash: row.asset_snapshot_hash,
      accessControlVersion: row.access_control_version, inputHash: row.input_hash, attempt: row.attempt + 1 } };
  }

  const pending = readPendingRenderRequest(bookLabEnv.UNSEEN_BOOK_LAB_DB, "id='preview'");
  const { createLocalBookRenderWorker } = await import("../../../infra/integration/book-lab/local-render-worker.mjs");
  const rendererLoop = createLocalBookRenderWorker({ api: f.api, bookRuntime });
  t.after(() => rendererLoop.close());
  const [previewOutcome] = await rendererLoop.drain();
  assert.equal(previewOutcome.status, "ready", `preview render did not become ready: ${JSON.stringify(previewOutcome)}`);
  assert.ok(previewOutcome.htmlHash);
  assert.equal(pending.request ? JSON.parse(pending.row.input_json).manifest.templateVersion : null, "book-lab-v1");

  // --- Freeze into a version and render the PDF for real (real headless Chrome via sandbox-exec) ---
  const previewRow = readPendingRenderRequest(bookLabEnv.UNSEEN_BOOK_LAB_DB, "id='preview'").row;
  const beforeFreeze = await f.call("GET", `/v2-labs/owner/spaces/${space.spaceId}/books/${bookId}/draft`, {}, owner.headers);
  const freezeResponse = await f.call("POST", `/v2-labs/owner/spaces/${space.spaceId}/books/${bookId}/versions`, {
    draftVersionId: beforeFreeze.body.draftVersionId, previewHash: previewRow.preview_hash,
    grantSetHash: beforeFreeze.body.grantSetHash, authorizationSnapshotHash: beforeFreeze.body.grantSetHash
  }, { ...owner.headers, "if-match": beforeFreeze.headers["x-unseen-book-etag"] });
  assert.equal(freezeResponse.status, 200, `freeze failed: ${JSON.stringify(freezeResponse.body)}`);
  assert.equal(freezeResponse.body.pageCount, 12);

  const frozenPending = readPendingRenderRequest(bookLabEnv.UNSEEN_BOOK_LAB_DB, "book_version_id IS NOT NULL");
  const [frozenOutcome] = await rendererLoop.drain();
  assert.equal(frozenOutcome.status, "ready", `frozen render did not become ready: ${JSON.stringify(frozenOutcome)}`);
  assert.ok(frozenOutcome.pdfHash);
  const completedList = await f.ok("GET", `/v2-labs/owner/spaces/${space.spaceId}/book-lab`, {}, owner.headers);
  const completedVersion = completedList.books.find(book => book.bookId === bookId).completedVersions[0];
  assert.equal(completedVersion.versionId, freezeResponse.body.versionId);
  assert.equal(completedVersion.pageCount, 12);
  assert.equal(completedVersion.readerPath, `/s/${space.spaceId}/books/${bookId}/versions/${freezeResponse.body.versionId}`);
  assert.equal((await f.call("GET", completedVersion.metadataPath, {}, owner.headers)).status, 200);
  assert.equal((await f.call("GET", `/v2-labs/owner/spaces/${space.spaceId}/book-lab`, {}, outsider.headers)).status, 409);
  const completedDraft = await f.ok("GET", `/v2-labs/owner/spaces/${space.spaceId}/books/${bookId}/draft`, {}, owner.headers);
  assert.deepEqual(completedDraft.completedVersions, [completedVersion]);
  const browserArgs = readFileSync(browserRecorder.argsPath, "utf8").trimEnd().split("\n");
  const profileArgument = browserArgs.find((value) => value.startsWith("--user-data-dir="));
  assert.ok(profileArgument, "the real frozen-PDF path must isolate Chrome from every other test and user profile");
  const browserProfile = profileArgument.slice("--user-data-dir=".length);
  assert.ok(browserProfile.startsWith(path.join(dir, "book-render-tmp", "job-")));
  assert.equal(existsSync(browserProfile), false, "the frozen-PDF path must clean its private Chrome profile");

  const livePath = `/v2-labs/live/spaces/${space.spaceId}/books/${bookId}/versions/${freezeResponse.body.versionId}`;
  assert.equal((await f.call("GET", livePath, {}, owner.headers)).status, 200, "a live owner capability must revalidate through the owner guard");
  assert.equal((await f.call("GET", livePath, {}, outsider.headers)).status, 404);
  assert.equal((await f.call("GET", `${livePath}/html`, {}, owner.headers)).status, 200);
  assert.equal((await f.call("GET", `${livePath}/html`, {}, outsider.headers)).status, 404);
  const downloaded = await f.call("GET", `${livePath}/pdf`, {}, owner.headers);
  assert.equal(downloaded.status, 200);
  assert.equal(Buffer.from(downloaded.body).subarray(0, 5).toString(), "%PDF-");
  assert.equal((await f.call("GET", `${livePath}/pdf`, {}, outsider.headers)).status, 404);
  // Independently verify persisted real PDF bytes and their exact hash.
  const artifactDb = new DatabaseSync(bookLabEnv.UNSEEN_BOOK_LAB_DB);
  const pdfArtifact = artifactDb.prepare("SELECT * FROM render_artifacts WHERE format='pdf' ORDER BY rowid DESC LIMIT 1").get();
  const versionRow = artifactDb.prepare("SELECT * FROM book_versions WHERE id=?").get(freezeResponse.body.versionId);
  artifactDb.close();
  assert.equal(pdfArtifact.status, "available");
  assert.equal(pdfArtifact.page_count, 12);
  assert.equal(sha256(Buffer.from(pdfArtifact.content_blob)), pdfArtifact.content_hash);
  assert.equal(Buffer.from(pdfArtifact.content_blob).subarray(0, 5).toString(), "%PDF-");
  assert.equal(versionRow.status, "available");
  const finalWithdrawalView = await f.call("GET", `/v2-labs/memories/${sourceMemoryIds[1]}`, {}, owner.headers);
  const finalWithdrawalTag = JSON.parse(finalWithdrawalView.headers["x-unseen-book-withdrawal-etags"])[bookId].etag;
  const withdrawnVersion = await f.ok("POST", `/v2-labs/books/${bookId}/contribution-grants/${sourceMemoryIds[1]}/withdrawals`,
    { reason: "revoke a source used in the completed local fixture book" }, { ...owner.headers, "if-match": finalWithdrawalTag });
  assert.ok(withdrawnVersion.affectedBookVersionIds.includes(freezeResponse.body.versionId));
  const deniedList = await f.ok("GET", `/v2-labs/owner/spaces/${space.spaceId}/book-lab`, {}, owner.headers);
  assert.deepEqual(deniedList.books.find(book => book.bookId === bookId).completedVersions, []);
  const deniedDraft = await f.ok("GET", `/v2-labs/owner/spaces/${space.spaceId}/books/${bookId}/draft`, {}, owner.headers);
  assert.deepEqual(deniedDraft.completedVersions, []);
  for (const suffix of ["", "/html", "/pdf"]) assert.equal((await f.call("GET", `${livePath}${suffix}`, {}, owner.headers)).status, 404);
  await rendererLoop.drain();
  for (const suffix of ["", "/html", "/pdf"]) assert.equal((await f.call("GET", `${livePath}${suffix}`, {}, owner.headers)).status, 404);


});
