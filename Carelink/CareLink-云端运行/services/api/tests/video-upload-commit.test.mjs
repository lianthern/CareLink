import test from "node:test";
import assert from "node:assert/strict";
import { dispatchOne } from "../../jobs/dispatch/index.mjs";
import { createAccountUpload, fixture, mp4, png } from "./fixture-factory.mjs";

// Video upload v0, end to end through the real HTTP surface (LocalApi#handle), the real
// FfmpegVideoRunner (no stubbed decoder), and the real jobs dispatch pipeline. Mirrors the shape
// of jobs-placement-panorama.test.mjs's photo test, but for a video-backed photo, to prove the
// existing placement/locator pipeline needed zero changes (see migration 0017's header comment
// and upload-service.mjs's commit() for why).

test("a video upload commits as a video-kind asset, a poster viewer-safe asset, and a video-safe asset; placement pipeline is unaffected", async () => {
  const f = fixture();
  try {
    const owner = await f.login("video-upload@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const bytes = mp4(640, 360, 2, 10);
    const flow = await createAccountUpload(f, owner, space, bytes, "video/mp4");
    assert.equal(flow.committed.status, "validating");

    const photo = f.db.prepare("SELECT * FROM photos WHERE id=?").get(flow.committed.photoId);
    assert.equal(photo.media_type, "video");
    assert.ok(photo.video_asset_id);
    assert.ok(photo.viewer_safe_asset_id);
    assert.notEqual(photo.video_asset_id, photo.viewer_safe_asset_id);
    assert.equal(photo.photo_content_state, "visible", "f.createSpace() enables auto_approve_uploads");

    const rawAsset = f.db.prepare("SELECT * FROM assets WHERE id=?").get(photo.asset_id);
    assert.equal(rawAsset.kind, "video");
    assert.equal(rawAsset.validation_state, "valid");
    assert.equal(rawAsset.observed_mime, "video/mp4");
    assert.equal(rawAsset.observed_bytes, bytes.length);
    assert.ok(rawAsset.duration_ms > 0 && rawAsset.duration_ms <= 2200);
    assert.equal(rawAsset.width, 640);
    assert.equal(rawAsset.height, 360);

    const posterAsset = f.db.prepare("SELECT * FROM assets WHERE id=?").get(photo.viewer_safe_asset_id);
    assert.equal(posterAsset.kind, "photo_viewer_safe", "poster must share the exact kind a photo derivative uses");
    assert.equal(posterAsset.observed_mime, "image/png");
    assert.equal(posterAsset.metadata_policy_result, "exif_gps_stripped");
    assert.equal(posterAsset.validation_state, "valid");

    const videoSafeAsset = f.db.prepare("SELECT * FROM assets WHERE id=?").get(photo.video_asset_id);
    assert.equal(videoSafeAsset.kind, "video_viewer_safe");
    assert.equal(videoSafeAsset.observed_mime, "video/mp4");
    assert.equal(videoSafeAsset.metadata_policy_result, "exif_gps_stripped");
    assert.ok(videoSafeAsset.duration_ms > 0 && videoSafeAsset.duration_ms <= 2200);

    // The photo_validation -> photo_placement job chain reads photos.viewer_safe_asset_id and
    // filters assets on kind='photo_viewer_safe' -- both satisfied unmodified by the poster row
    // above, so this dispatch is byte-for-byte the same call the photo test makes.
    const validation = dispatchOne(f.db, flow.committed.jobId, { now: f.clock.iso() });
    assert.equal(validation.status, "succeeded");
    const placement = dispatchOne(f.db, validation.placementJobId, { now: f.clock.iso() });
    assert.equal(placement.placementState, "needs_confirmation");

    const item = f.db.prepare("SELECT * FROM contribution_batch_items WHERE id=?").get(flow.item.itemId);
    const photoAfterPlacement = f.db.prepare("SELECT * FROM photos WHERE id=?").get(flow.committed.photoId);
    const manual = await f.ok("POST", `/v1/photos/${photo.id}/placement-revisions`, {
      mode: "manual", confirmationMode: "manual", yawDeg: 12, pitchDeg: 0, reason: "owner_confirmed"
    }, { ...owner.headers, "if-match": String(photoAfterPlacement.version), "x-item-version": String(item.version),
      "x-placement-authorization-version": String(item.placement_authorization_version) });
    assert.equal(manual.placementState, "confirmed");

    // Album/photo-detail read model: mediaType + a video descriptor pointing at the new route.
    const detail = await f.ok("GET", `/v1/viewer/spaces/${space.spaceId}/photos/${photo.id}`, {}, owner.headers);
    assert.equal(detail.mediaType, "video");
    assert.equal(detail.video.url, `/v1/viewer/spaces/${space.spaceId}/photos/${photo.id}/video`);
    assert.equal(detail.video.contentType, "video/mp4");
    assert.equal(detail.video.sha256, videoSafeAsset.raw_sha256);
    // photoMedia must still resolve to the poster, not the video -- this is what keeps the
    // in-scene marker/thumbnail (packages/viewer, frozen) working without any changes.
    assert.equal(detail.photoMedia.contentType, "image/png");
    assert.equal(detail.photoMedia.sha256, posterAsset.raw_sha256);

    // Actual byte serving, with Range support (what a <video> element needs for scrubbing).
    const full = await f.call("GET", `/v1/viewer/spaces/${space.spaceId}/photos/${photo.id}/video`, {}, owner.headers);
    assert.equal(full.status, 200);
    assert.equal(full.headers["content-type"], "video/mp4");
    assert.equal(full.headers.etag, `"${videoSafeAsset.raw_sha256}"`);
    assert.equal(Number(full.headers["content-length"]), videoSafeAsset.observed_bytes);
    const ranged = await f.call("GET", `/v1/viewer/spaces/${space.spaceId}/photos/${photo.id}/video`, {},
      { ...owner.headers, range: "bytes=0-9" });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers["content-range"], `bytes 0-9/${videoSafeAsset.observed_bytes}`);
  } finally { f.close(); }
});

test("a still image upload keeps producing a media_type='photo' row with no video_asset_id, and no video route", async () => {
  const f = fixture();
  try {
    const owner = await f.login("photo-still-baseline@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const flow = await createAccountUpload(f, owner, space, png(), "image/png");
    const photo = f.db.prepare("SELECT * FROM photos WHERE id=?").get(flow.committed.photoId);
    assert.equal(photo.media_type, "photo");
    assert.equal(photo.video_asset_id, null);
    const detail = await f.ok("GET", `/v1/viewer/spaces/${space.spaceId}/photos/${photo.id}`, {}, owner.headers);
    assert.equal(detail.mediaType, "photo");
    assert.equal(detail.video, undefined);
    const videoRoute = await f.call("GET", `/v1/viewer/spaces/${space.spaceId}/photos/${photo.id}/video`, {}, owner.headers);
    assert.equal(videoRoute.status, 404);
  } finally { f.close(); }
});

test("addItem/authorizeUpload enforce the 100MB video hard limit server-side, independent of the 20MB photo limit", async () => {
  const f = fixture();
  try {
    const owner = await f.login("video-size-limit@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const consent = await f.ok("POST", "/v1/consent-events", { ...f.mediaConsentBody() }, owner.headers);
    const batch = await f.ok("POST", `/v1/spaces/${space.spaceId}/contribution-batches`,
      { clientBatchId: "client-1", consentEventId: consent.consentEventId, declaredItemCount: 1 }, owner.headers);
    const oversizedVideo = await f.call("POST", `/v1/contribution-batches/${batch.batchId}/items`,
      { clientItemId: "item-1", declaredMime: "video/mp4", declaredBytes: 100 * 1024 * 1024 + 1, fileNameHash: "x" },
      { ...owner.headers, "if-match": String(batch.version), "x-space-version": String(space.version) });
    assert.equal(oversizedVideo.status, 422);
    assert.equal(oversizedVideo.body.error.code, "media_declaration_invalid");

    // Exactly the byte count a 20MB-capped photo would be rejected at is fine for video.
    const okVideoItem = await f.ok("POST", `/v1/contribution-batches/${batch.batchId}/items`,
      { clientItemId: "item-2", declaredMime: "video/mp4", declaredBytes: 21 * 1024 * 1024, fileNameHash: "y" },
      { ...owner.headers, "if-match": String(batch.version), "x-space-version": String(space.version) });
    assert.equal(okVideoItem.status, "selected");
  } finally { f.close(); }
});

// Unlike a photo/video that merely fails *decoding* deep inside a background job (see the
// "photo validation deterministically dispatches..." test in jobs-placement-panorama.test.mjs),
// a video that fails inspectVideo()'s own hard-limit assertions (duration/resolution) is rejected
// synchronously inside commit() itself -- the same request that uploaded the bytes gets the 422
// back, with the specific reason in the body. So this test drives the raw upload flow itself
// (rather than createAccountUpload(), which asserts the commit call succeeds) to observe that
// response directly.
async function uploadAndCommit(f, owner, space, bytes, mime) {
  const consent = await f.ok("POST", "/v1/consent-events", { ...f.mediaConsentBody() }, owner.headers);
  const batch = await f.ok("POST", `/v1/spaces/${space.spaceId}/contribution-batches`,
    { clientBatchId: `client-${Date.now()}`, consentEventId: consent.consentEventId, declaredItemCount: 1 }, owner.headers);
  const item = await f.ok("POST", `/v1/contribution-batches/${batch.batchId}/items`,
    { clientItemId: "item-1", declaredMime: mime, declaredBytes: bytes.length, fileNameHash: "not-a-name" },
    { ...owner.headers, "if-match": String(batch.version), "x-space-version": String(space.version) });
  const upload = await f.ok("POST", `/v1/contribution-batches/${batch.batchId}/items/${item.itemId}/upload-sessions`,
    { declaredMime: mime, declaredBytes: bytes.length, clientUploadId: "upload-1" },
    { ...owner.headers, "if-match": String(item.version) });
  const put = await f.api.putMedia({ ticket: upload.oneTimeUploadTicket, bytes, contentType: mime });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const committed = await f.call("POST", `/v1/upload-sessions/${upload.uploadSessionId}/commits`,
    { clientCommitId: "commit-1" }, { ...owner.headers, "if-match": String(put.body.uploadSessionVersion),
      "x-item-version": String(upload.itemVersion) });
  return { item, committed };
}

test("a video longer than 60 seconds fails the commit itself, synchronously, as video_duration_exceeded", async () => {
  const f = fixture();
  try {
    const owner = await f.login("video-hard-constraint-duration@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const tooLong = mp4(320, 240, 61, 5);
    const { item, committed } = await uploadAndCommit(f, owner, space, tooLong, "video/mp4");
    assert.equal(committed.status, 422);
    assert.equal(committed.body.error.code, "video_duration_exceeded");
    const itemRow = f.db.prepare("SELECT * FROM contribution_batch_items WHERE id=?").get(item.itemId);
    assert.equal(itemRow.status, "failed");
    assert.equal(itemRow.failure_code, "video_duration_exceeded");
    const asset = f.db.prepare("SELECT * FROM assets WHERE id=?").get(itemRow.asset_id);
    assert.equal(asset.validation_state, "failed");
    assert.equal(asset.validation_code, "video_duration_exceeded");
  } finally { f.close(); }
});

test("a video wider than 1080p fails the commit itself, synchronously, as video_resolution_exceeded", async () => {
  const f = fixture();
  try {
    const owner = await f.login("video-hard-constraint-resolution@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const tooWide = mp4(1920, 1200, 1, 5);
    const { item, committed } = await uploadAndCommit(f, owner, space, tooWide, "video/mp4");
    assert.equal(committed.status, 422);
    assert.equal(committed.body.error.code, "video_resolution_exceeded");
    const itemRow = f.db.prepare("SELECT * FROM contribution_batch_items WHERE id=?").get(item.itemId);
    assert.equal(itemRow.status, "failed");
    assert.equal(itemRow.failure_code, "video_resolution_exceeded");
  } finally { f.close(); }
});
