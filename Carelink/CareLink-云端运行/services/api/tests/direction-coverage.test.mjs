import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixture-factory.mjs";

// C ("缺口"方向格, host-panel worktree): SpaceService#management() now also returns
// missingDirections (the 12 x 30° yaw-coverage gap list) and confirmedPlacementCount
// (how many photos in the space are placement_state='confirmed'), both gated behind
// the same canEditPlacement scope as queues.placement — see the #missingDirectionBuckets()
// comment in space-service.mjs for the exact query and why it adds `r.yaw IS NOT NULL`
// on top of the hand-verified production query.
//
// These tests seed confirmed photos by inserting directly into
// assets/contribution_batches/contribution_batch_items/photos/placement_revisions —
// the real upload -> CLIP-placement pipeline (services/jobs/dispatch) never lets a
// caller choose an exact yaw, so a direct insert is the only way to pin down the
// bucket boundaries this SQL is actually being tested against.
function insertConfirmedPhoto(f, { spaceId, ownerId, yaw }) {
  const now = f.clock.iso();
  const suffix = `${spaceId}-${Math.random().toString(36).slice(2, 10)}`;
  const assetId = `asset-${suffix}`, batchId = `batch-${suffix}`, itemId = `item-${suffix}`,
    photoId = `photo-${suffix}`, revisionId = `placement-${suffix}`;
  f.db.prepare(`INSERT INTO assets(id,space_id,kind,private_object_key,validation_state,version)
    VALUES(?,?,'photo',?,'validated',1)`).run(assetId, spaceId, `key-${suffix}`);
  f.db.prepare(`INSERT INTO contribution_batches(id,space_id,actor_kind,actor_id,status,item_count,committed_count,version,created_at)
    VALUES(?,?,'account',?,'finalized',1,1,1,?)`).run(batchId, spaceId, ownerId, now);
  f.db.prepare(`INSERT INTO contribution_batch_items(id,space_id,batch_id,asset_id,photo_id,status,version)
    VALUES(?,?,?,?,?,'committed',1)`).run(itemId, spaceId, batchId, assetId, photoId);
  f.db.prepare(`INSERT INTO photos(id,space_id,batch_id,batch_item_id,asset_id,viewer_safe_asset_id,photo_content_state,placement_state,confirmation_mode,current_placement_revision_id,version)
    VALUES(?,?,?,?,?,?,'visible','confirmed','auto',?,1)`).run(photoId, spaceId, batchId, itemId, assetId, assetId, revisionId);
  f.db.prepare(`INSERT INTO placement_revisions(id,space_id,photo_id,seq,placement_state,confirmation_mode,yaw,pitch,auth_kind,authorization_id,auth_snapshot_json,reason_code,request_id,created_at)
    VALUES(?,?,?,1,'confirmed','auto',?,0,'space_owner',?,'{}','manual_confirm',?,?)`)
    .run(revisionId, spaceId, photoId, yaw, spaceId, `req-${suffix}`, now);
  return photoId;
}

test("zero confirmed photos: all 12 direction buckets are missing", async () => {
  const f = fixture();
  try {
    const owner = await f.login("gap-empty@example.test");
    const space = await f.createSpace(owner);
    const management = await f.ok("GET", `/v1/spaces/${space.spaceId}/management`, {}, owner.headers);
    assert.equal(management.confirmedPlacementCount, 0);
    assert.deepEqual(management.missingDirections, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  } finally { f.close(); }
});

test("all 12 buckets covered (one confirmed photo per 30° slice): zero missing directions", async () => {
  const f = fixture();
  try {
    const owner = await f.login("gap-full@example.test");
    const space = await f.createSpace(owner);
    for (let bucket = 0; bucket < 12; bucket += 1) {
      insertConfirmedPhoto(f, { spaceId: space.spaceId, ownerId: owner.accountId, yaw: bucket * 30 + 15 });
    }
    const management = await f.ok("GET", `/v1/spaces/${space.spaceId}/management`, {}, owner.headers);
    assert.equal(management.confirmedPlacementCount, 12);
    assert.deepEqual(management.missingDirections, []);
  } finally { f.close(); }
});

// The exact scenario the task brief hand-verified against production data: covered
// directions 150°/240°/330° (buckets 5/8/11) -> 9 gaps.
test("production-verified case: covered 150/240/330 leaves exactly 9 gaps, excluding buckets 5/8/11", async () => {
  const f = fixture();
  try {
    const owner = await f.login("gap-prod@example.test");
    const space = await f.createSpace(owner);
    for (const yaw of [150, 240, 330]) insertConfirmedPhoto(f, { spaceId: space.spaceId, ownerId: owner.accountId, yaw });
    const management = await f.ok("GET", `/v1/spaces/${space.spaceId}/management`, {}, owner.headers);
    assert.equal(management.missingDirections.length, 9);
    assert.deepEqual(management.missingDirections, [0, 1, 2, 3, 4, 6, 7, 9, 10]);
  } finally { f.close(); }
});

test("negative yaw wraps into the correct bucket (yaw=-30 covers the 330°-360° bucket, index 11)", async () => {
  const f = fixture();
  try {
    const owner = await f.login("gap-negative@example.test");
    const space = await f.createSpace(owner);
    insertConfirmedPhoto(f, { spaceId: space.spaceId, ownerId: owner.accountId, yaw: -30 });
    const management = await f.ok("GET", `/v1/spaces/${space.spaceId}/management`, {}, owner.headers);
    assert.ok(!management.missingDirections.includes(11), "yaw=-30 normalizes to 330, which is bucket 11 — must count as covered");
    assert.equal(management.missingDirections.length, 11);
  } finally { f.close(); }
});

// Guards the `r.yaw IS NOT NULL` addition documented on #missingDirectionBuckets():
// a confirmed placement with a null yaw must not poison every bucket into looking
// "covered" via SQL's NOT IN + NULL three-valued-logic trap.
test("a confirmed photo with a null yaw does not silently mark every bucket covered", async () => {
  const f = fixture();
  try {
    const owner = await f.login("gap-null-yaw@example.test");
    const space = await f.createSpace(owner);
    insertConfirmedPhoto(f, { spaceId: space.spaceId, ownerId: owner.accountId, yaw: null });
    const management = await f.ok("GET", `/v1/spaces/${space.spaceId}/management`, {}, owner.headers);
    assert.equal(management.confirmedPlacementCount, 1, "the null-yaw photo still counts toward confirmedPlacementCount");
    assert.deepEqual(management.missingDirections, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      "a null yaw must not be treated as covering any bucket");
  } finally { f.close(); }
});

test("a member without canEditPlacement does not receive missingDirections or confirmedPlacementCount", async () => {
  const f = fixture();
  try {
    const owner = await f.login("gap-scope-owner@example.test");
    const member = await f.login("gap-scope-member@example.test");
    const space = await f.createSpace(owner);
    const now = f.clock.iso();
    f.db.prepare(`INSERT INTO space_memberships(id,space_id,account_id,tasks_json,management_scopes_json,status,version,created_by,accepted_at)
      VALUES('member-1',?,?,'["view"]','["canReview"]','active',1,?,?)`)
      .run(space.spaceId, member.accountId, owner.accountId, now);
    const management = await f.ok("GET", `/v1/spaces/${space.spaceId}/management`, {}, member.headers);
    assert.equal(management.missingDirections, undefined);
    assert.equal(management.confirmedPlacementCount, undefined);
  } finally { f.close(); }
});
