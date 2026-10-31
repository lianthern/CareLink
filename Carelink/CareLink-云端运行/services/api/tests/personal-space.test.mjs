import test from "node:test";
import assert from "node:assert/strict";
import { createAccountUpload, fixture } from "./fixture-factory.mjs";

// v3.1 "传到我的空间" (MaxNotes UNSEEN-UI规划v3, 3.1): POST /v1/me/personal-space
// lazily finds-or-creates the caller's one personal default space. These
// tests cover the two things the feature promises: (1) at most one personal
// space ever exists per account, even under concurrent/repeated calls, and
// (2) the space it hands back is immediately uploadable by its owner — the
// investigated blocker (spaces default to collection_state='paused', which
// upload-service.mjs actor() requires to be 'open' for every actor kind,
// account included) is why a personal space must open collection at
// creation instead of leaving the normal explicit-create default in place.

test("first call lazily creates a personal space; repeat calls are idempotent", async () => {
  const f = fixture();
  try {
    const account = await f.login("solo@example.test");
    const created = await f.ok("POST", "/v1/me/personal-space", {}, account.headers);
    assert.ok(created.spaceId);
    assert.equal(created.created, true);
    assert.equal(created.name, "我的空间");
    assert.equal(created.collectionState, "open");
    assert.equal(created.sharingState, "private");
    assert.equal(created.destinationRoute, `/s/${created.spaceId}/upload`);

    const repeat = await f.ok("POST", "/v1/me/personal-space", {}, account.headers);
    assert.equal(repeat.spaceId, created.spaceId);
    assert.equal(repeat.created, false);

    const ownerAccountId = f.db.prepare("SELECT owner_account_id FROM spaces WHERE id=?").get(created.spaceId).owner_account_id;
    const rows = f.db.prepare("SELECT COUNT(*) c FROM spaces WHERE owner_account_id=? AND is_personal_default=1").get(ownerAccountId);
    assert.equal(rows.c, 1);
  } finally { f.close(); }
});

test("concurrent calls for the same account only ever create one personal space", async () => {
  const f = fixture();
  try {
    const account = await f.login("concurrent-owner@example.test");
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      f.ok("POST", "/v1/me/personal-space", {}, account.headers)));
    const spaceIds = new Set(results.map((result) => result.spaceId));
    assert.equal(spaceIds.size, 1);
    assert.equal(results.filter((result) => result.created).length, 1);
    const ownerAccountId = f.db.prepare("SELECT owner_account_id FROM spaces WHERE id=?").get([...spaceIds][0]).owner_account_id;
    const rows = f.db.prepare("SELECT COUNT(*) c FROM spaces WHERE owner_account_id=? AND is_personal_default=1").get(ownerAccountId);
    assert.equal(rows.c, 1);
  } finally { f.close(); }
});

test("GET /v1/me and GET /v1/me/spaces reflect the personal space once it exists", async () => {
  const f = fixture();
  try {
    const account = await f.login("visible-owner@example.test");
    const before = await f.ok("GET", "/v1/me", {}, account.headers);
    assert.equal(before.personalSpaceId, null);

    const created = await f.ok("POST", "/v1/me/personal-space", {}, account.headers);
    const after = await f.ok("GET", "/v1/me", {}, account.headers);
    assert.equal(after.personalSpaceId, created.spaceId);

    const spaces = await f.ok("GET", "/v1/me/spaces", {}, account.headers);
    const listed = spaces.spaces.find((space) => space.spaceId === created.spaceId);
    assert.ok(listed, "personal space must appear in the normal /v1/me/spaces list");
    assert.equal(listed.owner, true);
    assert.equal(listed.effectiveCanUpload, true);
  } finally { f.close(); }
});

test("two different accounts each get their own separate personal space", async () => {
  const f = fixture();
  try {
    const accountA = await f.login("owner-a@example.test");
    const accountB = await f.login("owner-b@example.test");
    const createdA = await f.ok("POST", "/v1/me/personal-space", {}, accountA.headers);
    const createdB = await f.ok("POST", "/v1/me/personal-space", {}, accountB.headers);
    assert.notEqual(createdA.spaceId, createdB.spaceId);
    const meA = await f.ok("GET", "/v1/me", {}, accountA.headers);
    const meB = await f.ok("GET", "/v1/me", {}, accountB.headers);
    assert.equal(meA.personalSpaceId, createdA.spaceId);
    assert.equal(meB.personalSpaceId, createdB.spaceId);
  } finally { f.close(); }
});

test("the owner can upload straight into a freshly lazy-created personal space (no manual collection-open step)", async () => {
  const f = fixture();
  try {
    const account = await f.login("self-uploader@example.test");
    const created = await f.ok("POST", "/v1/me/personal-space", {}, account.headers);

    // Deliberately skip f.openSpace() here — a personal space must already be
    // upload-ready the moment it is lazily created, unlike an explicitly
    // created space (which stays collection_state='paused' until the owner
    // opens it from management).
    const space = { spaceId: created.spaceId, version: 1 };
    const flow = await createAccountUpload(f, account, space);
    assert.ok(flow.committed.photoId);
    assert.equal(flow.finalized.batchResult.status, "finalized");

    const photo = f.db.prepare("SELECT space_id,photo_content_state FROM photos WHERE id=?").get(flow.committed.photoId);
    assert.equal(photo.space_id, created.spaceId);
  } finally { f.close(); }
});
