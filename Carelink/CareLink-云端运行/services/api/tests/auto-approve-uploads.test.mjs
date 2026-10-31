import test from "node:test";
import assert from "node:assert/strict";
import { createAccountUpload, fixture, png } from "./fixture-factory.mjs";
import { dispatchOne } from "../../jobs/dispatch/index.mjs";
import { DeterministicLocatorFixture } from "../src/ports/locator/deterministic-locator-fixture.mjs";

// Shared with tests/runtime-refreeze.test.mjs's own activatePanorama(): commits a
// panorama candidate and switches the scene to it, so a photo_placement job has an
// active policy/panorama revision to classify "same_scene_high" against.
async function activatePanorama(f, owner, space) {
  const bytes = png(1600, 800);
  const current = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(space.spaceId);
  const candidate = await f.ok("POST", `/v1/spaces/${space.spaceId}/panorama-candidates`, {
    declaredMime: "image/png", declaredBytes: bytes.length, clientAssetId: "auto-approve-fixture-panorama"
  }, { ...owner.headers, "if-match": String(current.version),
    "notice-acknowledgement": JSON.stringify({ purpose: "panorama_upload", version: 1,
      contentHash: "local-panorama_upload-v1" }) });
  const put = await f.api.putMedia({ ticket: candidate.exactPrivateUploadTicketOnce,
    bytes, contentType: "image/png", kind: "panorama" });
  const committed = await f.ok("POST", `/v1/panorama-upload-sessions/${candidate.uploadSessionId}/commits`,
    { clientRequestId: "auto-approve-fixture-panorama-commit" },
    { ...owner.headers, "if-match": String(put.body.uploadSessionVersion) });
  const ready = dispatchOne(f.db, committed.jobId, { now: f.clock.iso() });
  const scene = f.db.prepare("SELECT * FROM scenes WHERE space_id=?").get(space.spaceId);
  const before = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(space.spaceId);
  await f.ok("POST", `/v1/spaces/${space.spaceId}/panorama-switches`, {
    mode: "switch", candidateRevisionId: ready.panoramaRevisionId, sceneIfMatchVersion: scene.version
  }, { ...owner.headers, "if-match": String(before.version) });
  return { ...space, version: f.db.prepare("SELECT version FROM spaces WHERE id=?").get(space.spaceId).version };
}

// A ("照片自动审核" 空间级开关, 2026-08-17 施工批次): spaces get a per-space
// auto_approve_uploads switch (migration 0015). New spaces — both the
// explicit POST /v1/spaces flow and the lazily-created personal default
// space — default it on; a space that predates the migration (simulated
// here with a direct INSERT that omits the column) keeps the column's
// DEFAULT 0. Turning it on only changes how *future* uploads land
// (upload-service.mjs's commit()): the photo goes straight to
// photo_content_state='visible' instead of 'pending', but placement/CLIP
// auto-location is untouched either way — photoValidation()/placement() in
// services/jobs/dispatch/index.mjs never read photo_content_state.

test("a newly created space defaults auto-approve-uploads to on", async () => {
  const f = fixture();
  try {
    const owner = await f.login("aa-create@example.test");
    const space = await f.createSpace(owner);
    const management = await f.ok("GET", `/v1/spaces/${space.spaceId}/management`, {}, owner.headers);
    assert.equal(management.autoApproveUploads, true);
    const row = f.db.prepare("SELECT auto_approve_uploads FROM spaces WHERE id=?").get(space.spaceId);
    assert.equal(row.auto_approve_uploads, 1);
  } finally { f.close(); }
});

test("a lazily-created personal default space also defaults auto-approve-uploads to on", async () => {
  const f = fixture();
  try {
    const owner = await f.login("aa-personal@example.test");
    const created = await f.ok("POST", "/v1/me/personal-space", {}, owner.headers);
    const management = await f.ok("GET", `/v1/spaces/${created.spaceId}/management`, {}, owner.headers);
    assert.equal(management.autoApproveUploads, true);
  } finally { f.close(); }
});

test("a space that predates the auto_approve_uploads column keeps the migration's off default", async () => {
  const f = fixture();
  try {
    const owner = await f.login("aa-legacy@example.test");
    const now = f.clock.iso();
    // Simulate a pre-migration space row: every real space-creation path
    // (SpaceService#insertSpaceRow) now sets the column explicitly, so the
    // only way to observe migration 0015's own DEFAULT 0 is to insert a row
    // the same way the pre-migration schema would have, omitting the column.
    f.db.prepare(`INSERT INTO spaces(
      id,name,owner_account_id,space_lifecycle,collection_state,sharing_state,scene_id,version,created_at,updated_at
    ) VALUES(?,?,?,'active','open','private',?,1,?,?)`).run("space-legacy-1", "存量空间", owner.accountId, "scene-legacy-1", now, now);
    f.db.prepare(`INSERT INTO scenes(id,space_id,scene_readiness,scene_mode,version,created_at,updated_at)
      VALUES(?,?,'unavailable','rotation360',1,?,?)`).run("scene-legacy-1", "space-legacy-1", now, now);
    const row = f.db.prepare("SELECT auto_approve_uploads FROM spaces WHERE id=?").get("space-legacy-1");
    assert.equal(row.auto_approve_uploads, 0);
    const management = await f.ok("GET", "/v1/spaces/space-legacy-1/management", {}, owner.headers);
    assert.equal(management.autoApproveUploads, false);
  } finally { f.close(); }
});

test("owner can toggle auto-approve-uploads off then back on, idempotently and with If-Match", async () => {
  const f = fixture();
  try {
    const owner = await f.login("aa-toggle@example.test");
    const space = await f.createSpace(owner);

    const off = await f.transition(owner, space.spaceId, "auto-approve-uploads", "off", space.version);
    assert.equal(off.autoApproveUploads, false);
    assert.equal(off.version, space.version + 1);

    const repeatOff = await f.call("POST", `/v1/spaces/${space.spaceId}/auto-approve-uploads-transitions`,
      { to: "off" }, { ...owner.headers, "if-match": String(off.version) });
    assert.equal(repeatOff.status, 409);
    assert.equal(repeatOff.body.error.code, "transition_not_allowed");

    const on = await f.transition(owner, space.spaceId, "auto-approve-uploads", "on", off.version);
    assert.equal(on.autoApproveUploads, true);

    const stale = await f.call("POST", `/v1/spaces/${space.spaceId}/auto-approve-uploads-transitions`,
      { to: "off" }, { ...owner.headers, "if-match": String(off.version) });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "version_conflict");
  } finally { f.close(); }
});

test("only the owner can toggle auto-approve-uploads", async () => {
  const f = fixture();
  try {
    const owner = await f.login("aa-owner-only@example.test");
    const stranger = await f.login("aa-stranger@example.test");
    const space = await f.createSpace(owner);
    const forbidden = await f.call("POST", `/v1/spaces/${space.spaceId}/auto-approve-uploads-transitions`,
      { to: "off" }, { ...stranger.headers, "if-match": String(space.version) });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, "owner_required");
  } finally { f.close(); }
});

test("a photo uploaded to an auto-approve-uploads space lands visible immediately and still gets a placement job", async () => {
  const f = fixture();
  try {
    const owner = await f.login("aa-upload-on@example.test");
    const created = await f.ok("POST", "/v1/me/personal-space", {}, owner.headers); // defaults on
    const space = { spaceId: created.spaceId, version: created.version };
    const flow = await createAccountUpload(f, owner, space);
    assert.ok(flow.committed.photoId);

    const photo = f.db.prepare("SELECT photo_content_state,placement_state FROM photos WHERE id=?").get(flow.committed.photoId);
    assert.equal(photo.photo_content_state, "visible");
    assert.equal(photo.placement_state, "processing");

    // CLIP auto-placement is dispatched exactly the same way regardless of content
    // state — a photo_validation job (which queues the follow-on photo_placement
    // job once dispatched) was still created for this commit.
    const job = f.db.prepare("SELECT type FROM jobs WHERE id=?").get(flow.committed.jobId);
    assert.equal(job.type, "photo_validation");

    // No manual CONTENT.APPROVE needed: the viewer-facing read already serves it.
    const readable = f.db.prepare(`SELECT id FROM photos WHERE space_id=? AND photo_content_state='visible'
      AND deleted_at IS NULL`).all(space.spaceId);
    assert.ok(readable.some((row) => row.id === flow.committed.photoId));
  } finally { f.close(); }
});

test("a photo uploaded to a default (auto-approve-off) space still starts pending", async () => {
  const f = fixture();
  try {
    const owner = await f.login("aa-upload-off@example.test");
    let space = await f.createSpace(owner); // explicit create() also defaults on...
    space = await f.transition(owner, space.spaceId, "auto-approve-uploads", "off", space.version); // ...so turn it off explicitly
    space = await f.openSpace(owner, { spaceId: space.spaceId, version: space.version });
    const flow = await createAccountUpload(f, owner, space);
    const photo = f.db.prepare("SELECT photo_content_state FROM photos WHERE id=?").get(flow.committed.photoId);
    assert.equal(photo.photo_content_state, "pending");
  } finally { f.close(); }
});

// A v2 ("全自动链路" — Max's in-person correction over the v1 review-queue-widening
// design above): a confidently auto-placed photo must take zero manual touches — it
// must not appear in *any* queue just because nobody has "acknowledged" it yet.
test("full-auto pipeline, CLIP confident (same_scene_high): visible + confirmed placement, appears in neither queue — zero manual touches", async () => {
  const f = fixture();
  try {
    const owner = await f.login("aa-zero-touch@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    space = await activatePanorama(f, owner, space);
    const flow = await createAccountUpload(f, owner, space);

    const locator = new DeterministicLocatorFixture({ enabled: true });
    const validation = dispatchOne(f.db, flow.committed.jobId, { now: f.clock.iso(), locatorFixture: locator });
    const placement = dispatchOne(f.db, validation.placementJobId,
      { now: f.clock.iso(), locatorFixture: locator, fixtureClassification: "same_scene_high" });
    assert.equal(placement.placementState, "confirmed");

    const photo = f.db.prepare("SELECT photo_content_state,placement_state FROM photos WHERE id=?").get(flow.committed.photoId);
    assert.equal(photo.photo_content_state, "visible");
    assert.equal(photo.placement_state, "confirmed");

    const management = await f.ok("GET", `/v1/spaces/${space.spaceId}/management`, {}, owner.headers);
    assert.ok(!management.queues.review.some((item) => item.id === flow.committed.photoId),
      "a confidently auto-placed photo must not appear in the review queue");
    assert.ok(!management.queues.placement.some((item) => item.id === flow.committed.photoId),
      "a confidently auto-placed photo must not appear in the placement queue either — that is the whole point of zero manual touches");
  } finally { f.close(); }
});

// A v2 point 2: CLIP low-confidence/unrelated/sidecar-failure routes to the merged
// "疑似待复核" queue (queues.placement) — never queues.review, since under full-auto the
// content side already resolved itself (visible) the instant it was uploaded.
test("full-auto pipeline, CLIP not confident (needs_confirmation): stays visible, surfaces only in the placement queue as 疑似待复核", async () => {
  const f = fixture();
  try {
    const owner = await f.login("aa-needs-review@example.test");
    const created = await f.ok("POST", "/v1/me/personal-space", {}, owner.headers); // defaults on
    const space = { spaceId: created.spaceId, version: created.version };
    const flow = await createAccountUpload(f, owner, space);

    const validation = dispatchOne(f.db, flow.committed.jobId, { now: f.clock.iso() });
    const placement = dispatchOne(f.db, validation.placementJobId, { now: f.clock.iso() }); // no active policy -> needs_confirmation
    assert.equal(placement.placementState, "needs_confirmation");

    const photo = f.db.prepare("SELECT photo_content_state,placement_state FROM photos WHERE id=?").get(flow.committed.photoId);
    assert.equal(photo.photo_content_state, "visible", "content is already resolved by the full-auto switch, regardless of placement confidence");
    assert.equal(photo.placement_state, "needs_confirmation");

    const management = await f.ok("GET", `/v1/spaces/${space.spaceId}/management`, {}, owner.headers);
    assert.ok(!management.queues.review.some((item) => item.id === flow.committed.photoId),
      "must not also show up in the content review queue — that would split the 复核 workflow across two tabs again");
    assert.ok(management.queues.placement.some((item) => item.id === flow.committed.photoId),
      "must surface in the placement queue so the owner can open the editor and confirm/drag/save or take it down");
  } finally { f.close(); }
});

// A v2 point 3: opening the merged queue's editor lets the owner take the photo down
// (通过/隐藏/拒绝) without a separate trip to a review tab — placement-service.mjs's
// content-transitions accepts this from 'visible' exactly as it always has (manual_hidden/
// manual_rejected's `from` already includes 'visible', see the `transitions` table at the
// top of placement-service.mjs); this test locks in that the merged-queue photo really is
// reachable and actionable this way end to end.
test("a photo sitting in the merged 疑似待复核 queue can still be hidden directly (the editor's takedown action)", async () => {
  const f = fixture();
  try {
    const owner = await f.login("aa-queue-takedown@example.test");
    const created = await f.ok("POST", "/v1/me/personal-space", {}, owner.headers);
    const space = { spaceId: created.spaceId, version: created.version };
    const flow = await createAccountUpload(f, owner, space);
    const validation = dispatchOne(f.db, flow.committed.jobId, { now: f.clock.iso() });
    dispatchOne(f.db, validation.placementJobId, { now: f.clock.iso() });

    const editView = await f.ok("GET", `/v1/photos/${flow.committed.photoId}/placement-edit`, {}, owner.headers);
    assert.equal(editView.placementState, "needs_confirmation");

    const photo = f.db.prepare("SELECT version FROM photos WHERE id=?").get(flow.committed.photoId);
    const hidden = await f.ok("POST", `/v1/photos/${flow.committed.photoId}/content-transitions`,
      { to: "hidden", transitionReasonCode: "manual_hidden", decisionReasonCode: "quality_or_duplicate" },
      { ...owner.headers, "if-match": String(photo.version) });
    assert.equal(hidden.after, "hidden");

    const management = await f.ok("GET", `/v1/spaces/${space.spaceId}/management`, {}, owner.headers);
    assert.ok(management.queues.review.some((item) => item.id === flow.committed.photoId && item.photo_content_state === "hidden"),
      "a taken-down photo still needs eventual owner attention, so it correctly re-enters the ordinary content-review queue");
  } finally { f.close(); }
});
