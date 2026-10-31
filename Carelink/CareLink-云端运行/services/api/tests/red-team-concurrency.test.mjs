import test from "node:test";
import assert from "node:assert/strict";
import { dispatchOne } from "../../jobs/dispatch/index.mjs";
import { createAccountUpload, fixture, png } from "./fixture-factory.mjs";
import { sha256 } from "../src/util.mjs";
import { FfmpegDecoderRunner } from "../src/ports/media/ffmpeg-decoder-runner.mjs";

async function prepared(f, email = "concurrency@example.test") {
  const account = await f.login(email);
  let space = await f.createSpace(account);
  space = await f.openSpace(account, space);
  const consent = await f.ok("POST", "/v1/consent-events", {
    ...f.mediaConsentBody()
  }, account.headers);
  return { account, space, consent };
}

async function ticket(f, account, space, consent, bytes, suffix) {
  const batch = await f.ok("POST", `/v1/spaces/${space.spaceId}/contribution-batches`, {
    clientBatchId: `batch-${suffix}`, consentEventId: consent.consentEventId, declaredItemCount: 1
  }, account.headers);
  const item = await f.ok("POST", `/v1/contribution-batches/${batch.batchId}/items`, {
    clientItemId: `item-${suffix}`, declaredMime: "image/png", declaredBytes: bytes.length, fileNameHash: "opaque"
  }, { ...account.headers, "if-match": String(batch.version), "x-space-version": String(space.version) });
  const upload = await f.ok("POST", `/v1/contribution-batches/${batch.batchId}/items/${item.itemId}/upload-sessions`, {
    declaredMime: "image/png", declaredBytes: bytes.length, clientUploadId: `upload-${suffix}`
  }, { ...account.headers, "if-match": String(item.version) });
  return { batch, item, upload };
}

class GatedDecoder {
  constructor() {
    this.waiters = [];
    this.entered = [];
    this.derivativeRunner = new FfmpegDecoderRunner();
  }
  probe(bytes) {
    this.lastBytes = Buffer.from(bytes);
    let release;
    const entered = new Promise((resolve) => { this.entered.push(resolve); });
    const result = new Promise((resolve) => { release = resolve; });
    this.waiters.push({ bytes, release });
    this.entered.shift()?.();
    void entered;
    return result;
  }
  decode() {
    return Promise.resolve({ status: 0, signal: null, error: null,
      stdout: Buffer.from("0,          0,          0,        1,      1, deadbeef\n"), stderr: Buffer.alloc(0) });
  }
  deriveViewerSafe() {
    return this.derivativeRunner.deriveViewerSafe(this.lastBytes);
  }
  waitUntilEntered() {
    if (this.waiters.length) return Promise.resolve();
    return new Promise((resolve) => this.entered.push(resolve));
  }
  succeed(width, height) {
    const waiter = this.waiters.shift();
    waiter.release({ status: 0, signal: null, error: null,
      stdout: Buffer.from(JSON.stringify({ streams: [{ width, height }] })), stderr: Buffer.alloc(0) });
  }
  fail() {
    const waiter = this.waiters.shift();
    waiter.release({ status: 1, signal: null, error: Object.assign(new Error("decode failed"), { code: "EIO" }),
      stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  }
}

test("same upload ticket with different bytes has exactly one winner and cannot overwrite winner bytes", async () => {
  const f = fixture();
  try {
    const { account, space, consent } = await prepared(f, "upload-race@example.test");
    const a = Buffer.alloc(4096, 0x41);
    const b = Buffer.alloc(4096, 0x42);
    const issued = await ticket(f, account, space, consent, a, "race");
    const [left, right] = await Promise.all([
      f.api.putMedia({ ticket: issued.upload.oneTimeUploadTicket, bytes: a, contentType: "image/png" }),
      f.api.putMedia({ ticket: issued.upload.oneTimeUploadTicket, bytes: b, contentType: "image/png" })
    ]);
    assert.deepEqual([left.status, right.status].sort((x, y) => x - y), [200, 404]);
    const winner = left.status === 200 ? a : b;
    const stored = await f.api.mediaStore.get(issued.upload.exactPrivateObjectKey);
    assert.deepEqual(stored.body, winner);
    const row = f.db.prepare("SELECT * FROM upload_sessions WHERE id=?").get(issued.upload.uploadSessionId);
    assert.equal(row.observed_upload_sha256, sha256(winner));
    assert.equal(row.ticket_mac, null);
  } finally { f.close(); }
});

test("hanging decoder holds no SQLite transaction; unrelated mutation and media PUT commit independently", async () => {
  const decoder = new GatedDecoder();
  const f = fixture({ decoderRunner: decoder });
  try {
    const { account, space, consent } = await prepared(f, "decoder-isolation@example.test");
    const firstBytes = png(32, 16);
    const secondBytes = Buffer.alloc(2048, 0x5a);
    const first = await ticket(f, account, space, consent, firstBytes, "decode-first");
    const second = await ticket(f, account, space, consent, secondBytes, "decode-second");
    const firstPut = await f.api.putMedia({ ticket: first.upload.oneTimeUploadTicket,
      bytes: firstBytes, contentType: "image/png" });
    const commitPromise = f.call("POST", `/v1/upload-sessions/${first.upload.uploadSessionId}/commits`, {
      clientCommitId: "gated-commit"
    }, { ...account.headers, "if-match": String(firstPut.body.uploadSessionVersion),
      "x-item-version": String(first.upload.itemVersion) });
    await decoder.waitUntilEntered();

    const unrelated = await f.createSpace(account, "Committed during decode");
    const concurrentPut = await f.api.putMedia({ ticket: second.upload.oneTimeUploadTicket,
      bytes: secondBytes, contentType: "image/png" });
    assert.equal(concurrentPut.status, 200);
    assert.ok(f.db.prepare("SELECT id FROM spaces WHERE id=?").get(unrelated.spaceId));
    assert.equal(f.db.prepare("SELECT status FROM upload_sessions WHERE id=?").get(second.upload.uploadSessionId).status,
      "uploaded");

    decoder.succeed(32, 16);
    const committed = await commitPromise;
    assert.equal(committed.status, 200);
    assert.ok(committed.body.photoId);
  } finally { f.close(); }
});

test("decode failure finalizes only its claim and cannot roll back an unrelated committed request", async () => {
  const decoder = new GatedDecoder();
  const f = fixture({ decoderRunner: decoder });
  try {
    const { account, space, consent } = await prepared(f, "decoder-failure-isolation@example.test");
    const bytes = png(32, 16);
    const first = await ticket(f, account, space, consent, bytes, "decode-fail");
    const put = await f.api.putMedia({ ticket: first.upload.oneTimeUploadTicket, bytes, contentType: "image/png" });
    const commitPromise = f.call("POST", `/v1/upload-sessions/${first.upload.uploadSessionId}/commits`, {
      clientCommitId: "gated-failure"
    }, { ...account.headers, "if-match": String(put.body.uploadSessionVersion),
      "x-item-version": String(first.upload.itemVersion) });
    await decoder.waitUntilEntered();
    const unrelated = await f.createSpace(account, "Survives decoder failure");
    decoder.fail();
    const rejected = await commitPromise;
    assert.equal(rejected.status, 422);
    assert.equal(f.db.prepare("SELECT status FROM contribution_batch_items WHERE id=?").get(first.item.itemId).status,
      "failed");
    assert.ok(f.db.prepare("SELECT id FROM spaces WHERE id=?").get(unrelated.spaceId));
  } finally { f.close(); }
});

test("upload commit reauthorizes after object observation before creating a durable claim", async () => {
  const f = fixture();
  try {
    const { account, space, consent } = await prepared(f, "commit-preclaim-auth@example.test");
    const bytes = png(32, 16);
    const flow = await ticket(f, account, space, consent, bytes, "commit-preclaim-auth");
    const put = await f.api.putMedia({ ticket: flow.upload.oneTimeUploadTicket, bytes, contentType: "image/png" });
    const originalHead = f.api.mediaStore.head.bind(f.api.mediaStore);
    let changed = false;
    f.api.mediaStore.head = async (key) => {
      const result = await originalHead(key);
      if (!changed && key === flow.upload.exactPrivateObjectKey) {
        changed = true;
        f.db.prepare("UPDATE spaces SET collection_state='paused',version=version+1 WHERE id=?").run(space.spaceId);
      }
      return result;
    };
    const before = f.db.prepare("SELECT COUNT(*) count FROM idempotency_records").get().count;
    const rejected = await f.call("POST", `/v1/upload-sessions/${flow.upload.uploadSessionId}/commits`, {
      clientCommitId: "commit-preclaim-auth"
    }, { ...account.headers, "if-match": String(put.body.uploadSessionVersion),
      "x-item-version": String(flow.upload.itemVersion), "idempotency-key": "commit-preclaim-auth-abcdefgh" });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.body.error.code, "upload_unavailable");
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM idempotency_records").get().count, before);
    const unchanged = f.db.prepare("SELECT status,version FROM upload_sessions WHERE id=?")
      .get(flow.upload.uploadSessionId);
    assert.equal(unchanged.status, "uploaded");
    assert.equal(unchanged.version, put.body.uploadSessionVersion);
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM photos WHERE batch_item_id=?").get(flow.item.itemId).count, 0);
  } finally { f.close(); }
});

test("authorization drift after commit claim finalizes failure and leaves the item retryable", async () => {
  const decoder = new GatedDecoder();
  const f = fixture({ decoderRunner: decoder });
  try {
    const { account, space, consent } = await prepared(f, "commit-finish-auth@example.test");
    const bytes = png(32, 16);
    const flow = await ticket(f, account, space, consent, bytes, "commit-finish-auth");
    const put = await f.api.putMedia({ ticket: flow.upload.oneTimeUploadTicket, bytes, contentType: "image/png" });
    const commit = f.call("POST", `/v1/upload-sessions/${flow.upload.uploadSessionId}/commits`, {
      clientCommitId: "commit-finish-auth"
    }, { ...account.headers, "if-match": String(put.body.uploadSessionVersion),
      "x-item-version": String(flow.upload.itemVersion), "idempotency-key": "commit-finish-auth-abcdefgh" });
    await decoder.waitUntilEntered();
    f.db.prepare("UPDATE spaces SET collection_state='paused',version=version+1 WHERE id=?").run(space.spaceId);
    decoder.succeed(32, 16);
    const rejected = await commit;
    assert.equal(rejected.status, 403);
    assert.equal(rejected.body.error.code, "upload_unavailable");
    assert.equal(f.db.prepare("SELECT status FROM upload_sessions WHERE id=?").get(flow.upload.uploadSessionId).status,
      "revoked");
    const failed = f.db.prepare("SELECT status,version FROM contribution_batch_items WHERE id=?").get(flow.item.itemId);
    assert.equal(failed.status, "failed");
    assert.equal(f.db.prepare(`SELECT COUNT(*) count FROM idempotency_records
      WHERE canonical_endpoint=? AND state='in_progress'`).get(
      `/v1/upload-sessions/${flow.upload.uploadSessionId}/commits`).count, 0);
    f.db.prepare("UPDATE spaces SET collection_state='open',version=version+1 WHERE id=?").run(space.spaceId);
    const retry = await f.call("POST", `/v1/contribution-batches/${flow.batch.batchId}/items/${flow.item.itemId}/retries`, {
      failureVersion: failed.version
    }, { ...account.headers, "idempotency-key": "commit-finish-auth-retry-abcdefgh" });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal((await f.api.mediaStore.head(flow.upload.exactPrivateObjectKey)).exists, false);
  } finally { f.close(); }
});

test("expired upload commit lease is reclaimed by the same request and one explicit retry", async () => {
  const decoder = new GatedDecoder();
  const f = fixture({ decoderRunner: decoder });
  try {
    const { account, space, consent } = await prepared(f, "commit-lease@example.test");
    const bytes = png(32, 16);
    const flow = await ticket(f, account, space, consent, bytes, "commit-lease");
    const put = await f.api.putMedia({ ticket: flow.upload.oneTimeUploadTicket, bytes, contentType: "image/png" });
    const commitBody = { clientCommitId: "commit-lease" };
    const commitHeaders = { ...account.headers, "if-match": String(put.body.uploadSessionVersion),
      "x-item-version": String(flow.upload.itemVersion), "idempotency-key": "commit-lease-abcdefgh" };
    const original = f.call("POST", `/v1/upload-sessions/${flow.upload.uploadSessionId}/commits`,
      commitBody, commitHeaders);
    await decoder.waitUntilEntered();
    f.clock.advance(30_001);
    const reclaimed = await f.call("POST", `/v1/upload-sessions/${flow.upload.uploadSessionId}/commits`,
      commitBody, commitHeaders);
    assert.equal(reclaimed.status, 409);
    assert.equal(reclaimed.body.error.code, "concurrent_change");
    const failed = f.db.prepare("SELECT status,version FROM contribution_batch_items WHERE id=?").get(flow.item.itemId);
    assert.equal(failed.status, "failed");
    const retry = await f.call("POST", `/v1/contribution-batches/${flow.batch.batchId}/items/${flow.item.itemId}/retries`, {
      failureVersion: failed.version
    }, { ...account.headers, "idempotency-key": "commit-lease-retry-abcdefgh" });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    decoder.succeed(32, 16);
    const superseded = await original;
    assert.equal(superseded.status, 409);
    assert.equal(superseded.body.error.code, "concurrent_change");
    assert.equal(f.db.prepare(`SELECT COUNT(*) count FROM upload_sessions
      WHERE item_id=? AND status IN ('issued','committing','uploaded','validating')`).get(flow.item.itemId).count, 1);
    assert.equal(f.db.prepare(`SELECT COUNT(*) count FROM idempotency_records
      WHERE canonical_endpoint=? AND state='in_progress'`).get(
      `/v1/upload-sessions/${flow.upload.uploadSessionId}/commits`).count, 0);
    assert.equal((await f.api.mediaStore.head(flow.upload.exactPrivateObjectKey)).exists, false);
  } finally { f.close(); }
});

test("explicit retry directly reclaims an expired upload commit lease", async () => {
  const decoder = new GatedDecoder();
  const f = fixture({ decoderRunner: decoder });
  try {
    const { account, space, consent } = await prepared(f, "commit-lease-retry@example.test");
    const bytes = png(32, 16);
    const flow = await ticket(f, account, space, consent, bytes, "commit-lease-retry");
    const put = await f.api.putMedia({ ticket: flow.upload.oneTimeUploadTicket, bytes, contentType: "image/png" });
    const original = f.call("POST", `/v1/upload-sessions/${flow.upload.uploadSessionId}/commits`, {
      clientCommitId: "commit-lease-retry"
    }, { ...account.headers, "if-match": String(put.body.uploadSessionVersion),
      "x-item-version": String(flow.upload.itemVersion), "idempotency-key": "commit-lease-retry-abcdefgh" });
    await decoder.waitUntilEntered();
    f.clock.advance(30_001);
    const uploading = f.db.prepare("SELECT status,version FROM contribution_batch_items WHERE id=?")
      .get(flow.item.itemId);
    assert.equal(uploading.status, "uploading");
    const retry = await f.call("POST", `/v1/contribution-batches/${flow.batch.batchId}/items/${flow.item.itemId}/retries`, {
      failureVersion: uploading.version
    }, { ...account.headers, "idempotency-key": "commit-lease-direct-retry-abcdefgh" });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(f.db.prepare("SELECT status FROM upload_sessions WHERE id=?").get(flow.upload.uploadSessionId).status,
      "revoked");
    decoder.succeed(32, 16);
    const superseded = await original;
    assert.equal(superseded.status, 409);
    assert.equal(superseded.body.error.code, "concurrent_change");
    assert.equal(f.db.prepare(`SELECT COUNT(*) count FROM upload_sessions
      WHERE item_id=? AND status IN ('issued','committing','uploaded','validating')`).get(flow.item.itemId).count, 1);
    assert.equal(f.db.prepare(`SELECT COUNT(*) count FROM idempotency_records
      WHERE canonical_endpoint=? AND state='in_progress'`).get(
      `/v1/upload-sessions/${flow.upload.uploadSessionId}/commits`).count, 0);
    assert.equal((await f.api.mediaStore.head(flow.upload.exactPrivateObjectKey)).exists, false);
  } finally { f.close(); }
});

test("delayed placement job cannot overwrite owner manual confirmation or a panorama switch", async () => {
  const f = fixture();
  try {
    const owner = await f.login("stale-placement@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const manualFlow = await createAccountUpload(f, owner, space);
    const validation = dispatchOne(f.db, manualFlow.committed.jobId, { now: f.clock.iso() });
    const photo = f.db.prepare("SELECT * FROM photos WHERE id=?").get(manualFlow.committed.photoId);
    const item = f.db.prepare("SELECT * FROM contribution_batch_items WHERE id=?").get(manualFlow.item.itemId);
    const manual = await f.ok("POST", `/v1/photos/${photo.id}/placement-revisions`, {
      mode: "manual", confirmationMode: "manual", yawDeg: 27, pitchDeg: 0, reason: "owner_confirmed"
    }, { ...owner.headers, "if-match": String(photo.version), "x-item-version": String(item.version),
      "x-placement-authorization-version": String(item.placement_authorization_version) });
    const beforeDelayed = f.db.prepare("SELECT * FROM photos WHERE id=?").get(photo.id);
    const staleManual = dispatchOne(f.db, validation.placementJobId, { now: f.clock.iso(),
      outcome: { classification: "same_scene_high", yaw: 99 } });
    assert.equal(staleManual.stableError, "job_input_stale");
    const afterDelayed = f.db.prepare("SELECT * FROM photos WHERE id=?").get(photo.id);
    assert.equal(afterDelayed.current_placement_revision_id, manual.revisionId);
    assert.equal(afterDelayed.version, beforeDelayed.version);

    const switchFlow = await createAccountUpload(f, owner, space, png(40, 20));
    const switchValidation = dispatchOne(f.db, switchFlow.committed.jobId, { now: f.clock.iso() });
    const panoBytes = png(1600, 800);
    const currentSpace = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(space.spaceId);
    const candidate = await f.ok("POST", `/v1/spaces/${space.spaceId}/panorama-candidates`, {
      declaredMime: "image/png", declaredBytes: panoBytes.length, clientAssetId: "stale-job-pano"
    }, { ...owner.headers, "if-match": String(currentSpace.version),
      "notice-acknowledgement": JSON.stringify({ purpose: "panorama_upload", version: 1,
        contentHash: "local-panorama_upload-v1" }) });
    const panoPut = await f.api.putMedia({ ticket: candidate.exactPrivateUploadTicketOnce,
      bytes: panoBytes, contentType: "image/png", kind: "panorama" });
    const panoCommit = await f.ok("POST", `/v1/panorama-upload-sessions/${candidate.uploadSessionId}/commits`, {
      clientRequestId: "stale-job-pano-commit"
    }, { ...owner.headers, "if-match": String(panoPut.body.uploadSessionVersion) });
    const ready = dispatchOne(f.db, panoCommit.jobId, { now: f.clock.iso() });
    const scene = f.db.prepare("SELECT * FROM scenes WHERE space_id=?").get(space.spaceId);
    const spaceBeforeSwitch = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(space.spaceId);
    await f.ok("POST", `/v1/spaces/${space.spaceId}/panorama-switches`, {
      mode: "switch", candidateRevisionId: ready.panoramaRevisionId, sceneIfMatchVersion: scene.version
    }, { ...owner.headers, "if-match": String(spaceBeforeSwitch.version) });
    const beforeStalePano = f.db.prepare("SELECT * FROM photos WHERE id=?").get(switchFlow.committed.photoId);
    const stalePano = dispatchOne(f.db, switchValidation.placementJobId, { now: f.clock.iso() });
    assert.equal(stalePano.stableError, "job_input_stale");
    const afterStalePano = f.db.prepare("SELECT placement_state,version FROM photos WHERE id=?")
      .get(switchFlow.committed.photoId);
    assert.equal(afterStalePano.placement_state, beforeStalePano.placement_state);
    assert.equal(afterStalePano.version, beforeStalePano.version);
    const audit = f.db.prepare(`SELECT * FROM audit_events WHERE aggregate_id=?
      AND event_type='placement_job_dispatch' AND authorization_id=?`).get(
    switchFlow.committed.photoId, switchValidation.placementJobId);
    assert.ok(audit);
    assert.equal(audit.actor_kind, "service_job");
    const detail = JSON.parse(audit.detail_json);
    assert.equal(detail.decision, "stale_rejected");
    assert.equal(detail.reason, "panorama_revision_changed");
    assert.equal(JSON.stringify(detail).includes("private/"), false);
    assert.throws(() => f.db.prepare("UPDATE audit_events SET event_type='changed' WHERE id=?").run(audit.id),
      /immutable/);
  } finally { f.close(); }
});

test("panorama has one current upload session and ready cannot regress through old tickets or commits", async () => {
  const f = fixture();
  try {
    const owner = await f.login("panorama-race@example.test");
    const space = await f.createSpace(owner);
    const bytes = png(1600, 800);
    const first = await f.ok("POST", `/v1/spaces/${space.spaceId}/panorama-candidates`, {
      declaredMime: "image/png", declaredBytes: bytes.length, clientAssetId: "pano-race"
    }, { ...owner.headers, "if-match": String(space.version),
      "notice-acknowledgement": JSON.stringify({ purpose: "panorama_upload", version: 1,
        contentHash: "local-panorama_upload-v1" }) });
    f.clock.advance(16 * 60_000);
    const headers = { ...owner.headers, "if-match": String(first.version) };
    const [a, b] = await Promise.all([
      f.call("POST", `/v1/spaces/${space.spaceId}/panorama-candidates/${first.candidateId}/upload-sessions`,
        { clientRequestId: "reissue-a" }, headers),
      f.call("POST", `/v1/spaces/${space.spaceId}/panorama-candidates/${first.candidateId}/upload-sessions`,
        { clientRequestId: "reissue-b" }, headers)
    ]);
    assert.deepEqual([a.status, b.status].sort((x, y) => x - y), [200, 409]);
    const second = a.status === 200 ? a.body : b.body;
    assert.equal((await f.api.putMedia({ ticket: first.exactPrivateUploadTicketOnce,
      bytes, contentType: "image/png", kind: "panorama" })).status, 404);
    const put = await f.api.putMedia({ ticket: second.exactPrivateUploadTicketOnce,
      bytes, contentType: "image/png", kind: "panorama" });
    const commit = await f.ok("POST", `/v1/panorama-upload-sessions/${second.uploadSessionId}/commits`, {
      clientRequestId: "current-commit"
    }, { ...owner.headers, "if-match": String(put.body.uploadSessionVersion) });
    const readyResult = dispatchOne(f.db, commit.jobId, { now: f.clock.iso() });
    const ready = f.db.prepare("SELECT * FROM panorama_candidates WHERE id=?").get(first.candidateId);
    assert.equal(ready.status, "ready");
    const scene = f.db.prepare("SELECT * FROM scenes WHERE space_id=?").get(space.spaceId);
    const beforeSwitch = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(space.spaceId);
    await f.ok("POST", `/v1/spaces/${space.spaceId}/panorama-switches`, {
      mode: "switch", candidateRevisionId: readyResult.panoramaRevisionId, sceneIfMatchVersion: scene.version
    }, { ...owner.headers, "if-match": String(beforeSwitch.version) });
    const afterSwitchSpace = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(space.spaceId);
    const afterSwitchScene = f.db.prepare("SELECT * FROM scenes WHERE space_id=?").get(space.spaceId);
    const noOp = await f.call("POST", `/v1/spaces/${space.spaceId}/panorama-switches`, {
      mode: "switch", candidateRevisionId: readyResult.panoramaRevisionId,
      sceneIfMatchVersion: afterSwitchScene.version
    }, { ...owner.headers, "if-match": String(afterSwitchSpace.version) });
    assert.equal(noOp.status, 200);
    assert.equal(noOp.body.unchanged, true);
    const oldSession = f.db.prepare("SELECT version FROM panorama_upload_sessions WHERE id=?").get(first.uploadSessionId);
    const replayOld = await f.call("POST", `/v1/panorama-upload-sessions/${first.uploadSessionId}/commits`, {
      clientRequestId: "old-commit"
    }, { ...owner.headers, "if-match": String(oldSession.version) });
    assert.equal(replayOld.status, 404);
    const repeatCurrent = await f.call("POST", `/v1/panorama-upload-sessions/${second.uploadSessionId}/commits`, {
      clientRequestId: "second-current-commit"
    }, { ...owner.headers, "if-match": String(put.body.uploadSessionVersion + 2) });
    assert.equal(repeatCurrent.status, 404);
    assert.equal(f.db.prepare("SELECT status FROM panorama_candidates WHERE id=?").get(first.candidateId).status, "ready");
    assert.equal(f.db.prepare(`SELECT COUNT(*) count FROM panorama_upload_sessions
      WHERE candidate_id=? AND status IN ('issued','committing','uploaded','validating')`).get(first.candidateId).count, 0);
  } finally { f.close(); }
});
