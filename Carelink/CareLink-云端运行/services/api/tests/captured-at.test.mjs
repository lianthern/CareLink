import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { FfmpegDecoderRunner } from "../src/ports/media/ffmpeg-decoder-runner.mjs";
import { capturedAtFromProbe } from "../src/media.mjs";
import { createAccountUpload, fixture, png } from "./fixture-factory.mjs";
import { sha256, stableJson } from "../src/util.mjs";
import { MEDIA_NOTICE_V2_NOTICE } from "../src/media-notice.mjs";

const require = createRequire(import.meta.url);
const coverage = require("../../../packages/contracts/generated/book-lab/action-api-coverage.json");

function successful(stdout) {
  return { status: 0, signal: null, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), error: null };
}

function captureRunner(bytes, tags) {
  const derivativeRunner = new FfmpegDecoderRunner();
  return {
    probe: async () => successful(JSON.stringify({ streams: [{ width: 32, height: 16, tags }] })),
    decode: async () => successful("0, 0, 0, 1, 1, 1, 0, 0123456789abcdef0123456789abcdef\n"),
    deriveViewerSafe: async () => derivativeRunner.deriveViewerSafe(bytes)
  };
}

function registerAll(input) {
  for (const action of coverage.actions) input.registerRoutes({ method: action.method,
    template: action.endpoint, handler: () => ({ status: 503, body: {} }) });
  // The extension also mounts read/assembly routes outside action coverage.
  for (const [method, template] of [
    ['GET', '/v2-labs/memories/{memoryId}'],
    ['GET', '/v2-labs/live/spaces/{spaceId}/books/{bookId}/versions/{versionId}/html'],
    ['GET', '/v2-labs/owner/spaces/{spaceId}/books/{bookId}/draft/sources'],
    ['POST', '/v2-labs/owner/spaces/{spaceId}/books/{bookId}/draft/assembly']
  ]) input.registerRoutes({ method, template, handler: () => ({ status: 503, body: {} }) });
  for (const operation of coverage.internalOperationCoverage) input.registerInternalJobs({
    endpoint: operation.endpoint, handler: () => ({})
  });
}

function probe(...tagSets) {
  return { streams: [{ width: 32, height: 16, tags: tagSets[0] }],
    frames: tagSets.slice(1).map((tags) => ({ tags })), format: {} };
}

test("capture-time probe argv is bounded to one video packet and selected tags", async () => {
  let argv;
  const spawnImpl = (_executable, args) => {
    argv = args;
    const child = new EventEmitter();
    child.pid = 123;
    child.stdin = { on() {}, end() { queueMicrotask(() => child.emit("close", 0, null)); } };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    return child;
  };
  const runner = new FfmpegDecoderRunner({ spawnImpl });
  await runner.probe(Buffer.from("x"));
  assert.deepEqual(argv.slice(0, 6), ["-v", "error", "-select_streams", "v:0", "-read_intervals", "%+#1"]);
  assert.ok(argv.includes("-show_entries"));
  assert.ok(argv.join(" ").includes("DateTimeOriginal"));
  assert.ok(argv.join(" ").includes("OffsetTimeOriginal"));
  assert.ok(argv.includes("-show_streams"));
  assert.ok(argv.includes("-show_frames"));
  assert.ok(argv.includes("-show_format"));
});

test("capture time requires trusted timezone and normalizes to RFC3339", () => {
  assert.equal(capturedAtFromProbe(probe({ DateTimeOriginal: "2026:08:13 12:34:56",
    OffsetTimeOriginal: "+08:00" })), "2026-08-13T04:34:56.000Z");
  assert.equal(capturedAtFromProbe(probe({}, { DateTimeOriginal: "2026:08:13 12:34:56",
    "0x9011": "-04:30" })), "2026-08-13T17:04:56.000Z");
  assert.equal(capturedAtFromProbe(probe({ creation_time: "2026-08-13T12:34:56+08:00" })),
    "2026-08-13T04:34:56.000Z");
});

test("capture time fails closed on unzoned, invalid, or same-priority conflict", () => {
  assert.equal(capturedAtFromProbe(probe({ DateTimeOriginal: "2026:08:13 12:34:56" },
    { creation_time: "2026-08-13T12:34:56Z" })), null);
  assert.equal(capturedAtFromProbe(probe({ creation_time: "2026-08-13T12:34:56" })), null);
  assert.equal(capturedAtFromProbe(probe({ DateTimeOriginal: "2026:02:31 12:34:56",
    OffsetTimeOriginal: "+08:00" })), null);
  assert.equal(capturedAtFromProbe(probe({ creation_time: "2026-08-13T12:34:56Z" },
    { creation_time: "2026-08-14T12:34:56Z" })), null);
});

// ffprobe 6.1.1 (production, at time of writing) emits bare tag keys like
// "DateTimeOriginal" / "0x9011". ffprobe 9.x namespaces the same tags under
// the IFD they came from -- "ExifIFD/DateTimeOriginal" / "ExifIFD/0x9011".
// The old normalization stripped all non-alphanumeric characters without
// splitting on "/" first, so a namespaced key collapsed into
// "exififddatetimeoriginal", which never matched "datetimeoriginal" and
// silently dropped capture-time extraction the moment ffprobe was upgraded.
test("capture time extraction is unaffected by an ffprobe namespace prefix on the tag key (6.1.1 vs 9.x key shapes)", () => {
  const bare = capturedAtFromProbe(probe({ DateTimeOriginal: "2026:08:13 12:34:56", "0x9011": "+08:00" }));
  const namespaced = capturedAtFromProbe(probe({ "ExifIFD/DateTimeOriginal": "2026:08:13 12:34:56",
    "ExifIFD/0x9011": "+08:00" }));
  assert.equal(bare, "2026-08-13T04:34:56.000Z");
  assert.equal(namespaced, bare);

  // Namespaced OffsetTimeOriginal form, and a mix of namespaced original with
  // bare offset (matching happens per-tag, not per-probe-shape).
  assert.equal(capturedAtFromProbe(probe({ "ExifIFD/DateTimeOriginal": "2026:08:13 12:34:56",
    "ExifIFD/OffsetTimeOriginal": "+08:00" })), "2026-08-13T04:34:56.000Z");
  assert.equal(capturedAtFromProbe(probe({ "ExifIFD/DateTimeOriginal": "2026:08:13 12:34:56",
    OffsetTimeOriginal: "+08:00" })), "2026-08-13T04:34:56.000Z");

  // Same semantics still hold with a namespace prefix: offset required, and
  // multiple conflicting candidate values still fail closed.
  assert.equal(capturedAtFromProbe(probe({ "ExifIFD/DateTimeOriginal": "2026:08:13 12:34:56" })), null);
  assert.equal(capturedAtFromProbe(probe({ "QuickTime/CreationDate": "2026-08-13T12:34:56+08:00" })), null);
  assert.equal(capturedAtFromProbe(probe({ "Track/creation_time": "2026-08-13T12:34:56+08:00" })),
    "2026-08-13T04:34:56.000Z");
});

test("capture time persists only from decoder metadata; legacy rows stay null and clients cannot submit it", async () => {
  const legacy = new DatabaseSync(":memory:");
  legacy.exec("CREATE TABLE photos(id TEXT PRIMARY KEY,deleted_at TEXT,version INTEGER); INSERT INTO photos VALUES('old',NULL,1)");
  legacy.exec(readFileSync(new URL("../db/migrations/0009_photo_capture_time.sql", import.meta.url), "utf8"));
  assert.equal(legacy.prepare("SELECT captured_at FROM photos WHERE id='old'").get().captured_at, null);
  legacy.close();

  const bytes = png();
  const f = fixture({ decoderRunner: captureRunner(bytes, { DateTimeOriginal: "2026:08:13 12:34:56",
    OffsetTimeOriginal: "+08:00" }) });
  try {
    const owner = await f.login("capture-persist@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const consent = await f.ok("POST", "/v1/consent-events", f.mediaConsentBody(), owner.headers);
    const batch = await f.ok("POST", `/v1/spaces/${space.spaceId}/contribution-batches`,
      { clientBatchId: "capture-client-boundary", consentEventId: consent.consentEventId, declaredItemCount: 1 }, owner.headers);
    const rejected = await f.call("POST", `/v1/contribution-batches/${batch.batchId}/items`, {
      clientItemId: "item-bad", declaredMime: "image/png", declaredBytes: bytes.length,
      fileNameHash: "not-a-name", capturedAt: "2026-08-13T04:34:56.000Z"
    }, { ...owner.headers, "if-match": String(batch.version), "x-space-version": String(space.version) });
    assert.equal(rejected.status, 400);
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM contribution_batch_items WHERE batch_id=?")
      .get(batch.batchId).count, 0);

    const flow = await createAccountUpload(f, owner, space, bytes);
    assert.equal(f.db.prepare("SELECT captured_at FROM photos WHERE id=?").get(flow.committed.photoId).captured_at,
      "2026-08-13T04:34:56.000Z");
  } finally { f.close(); }
});

test("media notice v1 is immutable and v2 binds the exact copy hash independently of machine policy", () => {
  const f = fixture();
  try {
    const notices = f.db.prepare("SELECT * FROM media_notices ORDER BY version").all();
    assert.equal(notices.length, 2);
    assert.equal(notices[0].version, 1);
    assert.equal(notices[0].content_hash, "local-photo-upload-v1");
    assert.deepEqual(JSON.parse(notices[0].policy_json), {
      acceptedFormats: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"],
      maxBytes: 20 * 1024 * 1024, metadataPolicy: "strip-sensitive"
    });
    const currentPolicy = JSON.parse(notices[1].policy_json);
    assert.equal(notices[1].version, 2);
    assert.equal(notices[1].content_hash, MEDIA_NOTICE_V2_NOTICE.contentHash);
    assert.notEqual(notices[1].content_hash, sha256(stableJson(currentPolicy)));
    assert.deepEqual(currentPolicy.discardedMetadata, ["gps", "device_serial"]);
    assert.deepEqual(currentPolicy.retainedPurposes, ["photo_time", "memory_provenance", "book_provenance"]);
    assert.deepEqual(currentPolicy.releaseBlockers, ["legal_approval_capture_time_retention"]);
  } finally { f.close(); }
});

test("media notice v2 rejects the policy hash, persists the copy hash, and rechecks current consent", async () => {
  const f = fixture();
  try {
    const owner = await f.login("notice-copy-hash@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const oldHash = MEDIA_NOTICE_V2_NOTICE.legacyPolicyHash;
    const old = await f.call("POST", "/v1/consent-events", {
      purpose: "photo_upload", noticeVersion: 2, noticeHash: oldHash
    }, owner.headers);
    assert.equal(old.status, 409);
    assert.equal(old.body.error.code, "notice_version_stale");
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM consent_events").get().count, 0);

    const body = { purpose: "photo_upload", noticeVersion: 2, noticeHash: MEDIA_NOTICE_V2_NOTICE.contentHash };
    const headers = { ...owner.headers, "idempotency-key": "notice-v2-copy-hash-replay" };
    const accepted = await f.call("POST", "/v1/consent-events", body, headers);
    const replay = await f.call("POST", "/v1/consent-events", body, headers);
    assert.equal(accepted.status, 200);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    const ledger = f.db.prepare("SELECT * FROM consent_events WHERE id=?").get(accepted.body.consentEventId);
    assert.equal(ledger.notice_version, 2);
    assert.equal(ledger.notice_hash, MEDIA_NOTICE_V2_NOTICE.contentHash);
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM consent_events").get().count, 1);
    f.db.prepare(`INSERT INTO consent_events(
      id,space_id,actor_auth_kind,authorization_id,notice_id,notice_version,notice_hash,notice_purpose,accepted_at
    ) VALUES('consent_old_policy_hash',?,?,?,?,?,?,?,?)`).run(space.spaceId, ledger.actor_auth_kind,
      ledger.authorization_id, ledger.notice_id, 2, oldHash, "photo_upload", "2026-08-13T00:00:01.000Z");
    const context = await f.ok("GET", `/v1/spaces/${space.spaceId}/upload-context`, {}, owner.headers);
    assert.equal(context.mediaNotice.hash, MEDIA_NOTICE_V2_NOTICE.contentHash);
    assert.equal(context.currentConsent.consentEventId, accepted.body.consentEventId);
    assert.equal(context.canCreateBatch, true);
    const staleBatch = await f.call("POST", `/v1/spaces/${space.spaceId}/contribution-batches`, {
      clientBatchId: "stale-notice", consentEventId: "consent_old_policy_hash", declaredItemCount: 1
    }, owner.headers);
    assert.equal(staleBatch.status, 409);
    assert.equal(staleBatch.body.error.code, "consent_required");

    f.db.prepare("UPDATE media_notices SET content_hash=? WHERE id=?")
      .run(oldHash, MEDIA_NOTICE_V2_NOTICE.id);
    const drifted = await f.call("GET", `/v1/spaces/${space.spaceId}/upload-context`, {}, owner.headers);
    assert.equal(drifted.status, 503);
    assert.equal(drifted.body.error.code, "notice_unavailable");
    assert.doesNotThrow(() => f.api.seedNotices());
    assert.equal(f.db.prepare("SELECT content_hash FROM media_notices WHERE id=?")
      .get(MEDIA_NOTICE_V2_NOTICE.id).content_hash, MEDIA_NOTICE_V2_NOTICE.contentHash);
    f.db.prepare("UPDATE media_notices SET content_hash=? WHERE id=?")
      .run("1".repeat(64), MEDIA_NOTICE_V2_NOTICE.id);
    assert.throws(() => f.api.seedNotices(), (error) => error.code === "notice_seed_conflict");
  } finally { f.close(); }
});

test("Core Book provenance is exact, BOLA/currentness protected, read-only, and deletion clears capture time", async () => {
  let extension;
  const bytes = png();
  const f = fixture({ decoderRunner: captureRunner(bytes, { creation_time: "2026-08-13T12:34:56+08:00" }),
    featureFlags: { bookLab: true }, extensionModuleLoader: async () => ({
      registerBookLabExtension: (input) => { extension = input; registerAll(input); return { enabled: true }; }
    }) });
  try {
    await f.api.ready;
    const owner = await f.login("capture-book-owner@example.test");
    const stranger = await f.login("capture-book-stranger@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const flow = await createAccountUpload(f, owner, space, bytes);
    const photo = f.db.prepare("SELECT * FROM photos WHERE id=?").get(flow.committed.photoId);
    const item = f.db.prepare("SELECT * FROM contribution_batch_items WHERE id=?").get(photo.batch_item_id);
    f.db.prepare("UPDATE spaces SET current_panorama_revision_id='panorama-current' WHERE id=?").run(space.spaceId);
    f.db.prepare("UPDATE scenes SET scene_readiness='ready' WHERE space_id=?").run(space.spaceId);
    const placed = await f.ok("POST", `/v1/photos/${photo.id}/placement-revisions`, {
      mode: "manual", confirmationMode: "manual", yawDeg: 42, pitchDeg: 3, regionId: "main", reason: "capture-test"
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

    assert.throws(() => extension.readCorePhotoContext({ accountSession: stranger.token }, photo.id),
      (error) => error.code === "photo_unavailable");
    const before = f.db.prepare("SELECT total_changes() count").get().count;
    const provenance = extension.readCorePhotoContext({ accountSession: owner.token }, photo.id);
    assert.deepEqual(Object.keys(provenance), ["spaceId", "photoId", "sceneId", "panoramaRevisionId",
      "placementRevisionId", "nodeId", "sourcePhotosVersion", "yawDegrees", "capturedAt", "authorId",
      "photoContentHash", "placementSnapshotHash"]);
    assert.equal(provenance.capturedAt, "2026-08-13T04:34:56.000Z");
    assert.equal(provenance.photoId, photo.id);
    assert.equal(provenance.panoramaRevisionId, "panorama-current");
    assert.equal(provenance.placementRevisionId, placed.revisionId);
    assert.equal(provenance.nodeId, null);
    assert.equal(provenance.yawDegrees, 42);
    assert.equal(provenance.authorId, owner.accountId);
    assert.match(provenance.photoContentHash, /^[a-f0-9]{64}$/);
    assert.match(provenance.placementSnapshotHash, /^[a-f0-9]{64}$/);
    assert.equal(f.db.prepare("SELECT total_changes() count").get().count, before);

    f.db.prepare("UPDATE spaces SET current_panorama_revision_id='panorama-drift' WHERE id=?").run(space.spaceId);
    assert.throws(() => extension.readCorePhotoContext({ accountSession: owner.token }, photo.id),
      (error) => error.code === "photo_unavailable");
    f.db.prepare("UPDATE spaces SET current_panorama_revision_id='panorama-current' WHERE id=?").run(space.spaceId);
    f.db.prepare("UPDATE photos SET captured_at=NULL WHERE id=?").run(photo.id);
    assert.throws(() => extension.readCorePhotoContext({ accountSession: owner.token }, photo.id),
      (error) => error.code === "photo_unavailable");
    f.db.prepare("UPDATE photos SET captured_at='2026-08-13T04:34:56.000Z' WHERE id=?").run(photo.id);
    const current = f.db.prepare("SELECT version FROM photos WHERE id=?").get(photo.id);
    const grant = await f.reauth(owner, "BATCH.DELETE_ITEM", "photo_delete", "photo", photo.id);
    await f.ok("POST", `/v1/photos/${photo.id}/deletion-requests`, {
      reason: "owner_delete", reauthGrant: grant.reauthGrantSecret
    },
      { ...owner.headers, "if-match": String(current.version) });
    assert.equal(f.db.prepare("SELECT captured_at FROM photos WHERE id=?").get(photo.id).captured_at, null);
  } finally { f.close(); }
});
