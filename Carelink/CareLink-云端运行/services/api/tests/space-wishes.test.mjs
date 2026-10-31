import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixture-factory.mjs";

test("owner replaces the wish list, and it surfaces in management and upload-context", async () => {
  const f = fixture();
  try {
    const owner = await f.login("wish-owner@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const updated = await f.ok("PATCH", `/v1/spaces/${space.spaceId}/wishes`,
      { wishes: ["新娘母亲落泪的瞬间", "全场大合影"] }, { ...owner.headers, "if-match": String(space.version) });
    assert.deepEqual(updated.wishes, ["新娘母亲落泪的瞬间", "全场大合影"]);
    assert.equal(updated.version, space.version + 1);

    const stored = f.db.prepare("SELECT wishes_json FROM spaces WHERE id=?").get(space.spaceId);
    assert.deepEqual(JSON.parse(stored.wishes_json), ["新娘母亲落泪的瞬间", "全场大合影"]);

    const management = await f.ok("GET", `/v1/spaces/${space.spaceId}/management`, {}, owner.headers);
    assert.deepEqual(management.wishes, ["新娘母亲落泪的瞬间", "全场大合影"]);
    assert.equal(management.version, updated.version);

    const uploadContext = await f.ok("GET", `/v1/spaces/${space.spaceId}/upload-context`, {}, owner.headers);
    assert.deepEqual(uploadContext.wishes, ["新娘母亲落泪的瞬间", "全场大合影"]);
  } finally { f.close(); }
});

test("wish list defaults to empty and clearing it back to empty is allowed", async () => {
  const f = fixture();
  try {
    const owner = await f.login("wish-empty@example.test");
    const space = await f.createSpace(owner);
    const management = await f.ok("GET", `/v1/spaces/${space.spaceId}/management`, {}, owner.headers);
    assert.deepEqual(management.wishes, []);

    const filled = await f.ok("PATCH", `/v1/spaces/${space.spaceId}/wishes`,
      { wishes: ["一条心愿"] }, { ...owner.headers, "if-match": String(space.version) });
    const cleared = await f.ok("PATCH", `/v1/spaces/${space.spaceId}/wishes`,
      { wishes: [] }, { ...owner.headers, "if-match": String(filled.version) });
    assert.deepEqual(cleared.wishes, []);
  } finally { f.close(); }
});

test("wish list enforces the 6-item cap, per-item 40-char cap (codepoint-aware), and rejects non-array/empty items", async () => {
  const f = fixture();
  try {
    const owner = await f.login("wish-limits@example.test");
    const space = await f.createSpace(owner);

    const sevenWishes = Array.from({ length: 7 }, (_, index) => `心愿${index}`);
    const tooMany = await f.call("PATCH", `/v1/spaces/${space.spaceId}/wishes`,
      { wishes: sevenWishes }, { ...owner.headers, "if-match": String(space.version) });
    assert.equal(tooMany.status, 400);
    assert.equal(tooMany.body.error.code, "validation_failed");

    const sixWishes = Array.from({ length: 6 }, (_, index) => `心愿${index}`);
    const exactlySix = await f.ok("PATCH", `/v1/spaces/${space.spaceId}/wishes`,
      { wishes: sixWishes }, { ...owner.headers, "if-match": String(space.version) });
    assert.equal(exactlySix.wishes.length, 6);

    const exactly40 = "望".repeat(40);
    const at40 = await f.ok("PATCH", `/v1/spaces/${space.spaceId}/wishes`,
      { wishes: [exactly40] }, { ...owner.headers, "if-match": String(exactlySix.version) });
    assert.equal(at40.wishes[0], exactly40);

    const over40 = "望".repeat(41);
    const rejected = await f.call("PATCH", `/v1/spaces/${space.spaceId}/wishes`,
      { wishes: [over40] }, { ...owner.headers, "if-match": String(at40.version) });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, "validation_failed");

    const emptyItem = await f.call("PATCH", `/v1/spaces/${space.spaceId}/wishes`,
      { wishes: ["   "] }, { ...owner.headers, "if-match": String(at40.version) });
    assert.equal(emptyItem.status, 400);

    const notArray = await f.call("PATCH", `/v1/spaces/${space.spaceId}/wishes`,
      { wishes: "not-an-array" }, { ...owner.headers, "if-match": String(at40.version) });
    assert.equal(notArray.status, 400);
  } finally { f.close(); }
});

test("only the owner can update wishes, and a stale If-Match is a version conflict", async () => {
  const f = fixture();
  try {
    const owner = await f.login("wish-owner-2@example.test");
    const stranger = await f.login("wish-stranger@example.test");
    const space = await f.createSpace(owner);

    const forbidden = await f.call("PATCH", `/v1/spaces/${space.spaceId}/wishes`,
      { wishes: ["不该成功"] }, { ...stranger.headers, "if-match": String(space.version) });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, "owner_required");

    const stale = await f.call("PATCH", `/v1/spaces/${space.spaceId}/wishes`,
      { wishes: ["心愿"] }, { ...owner.headers, "if-match": String(space.version + 1) });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "version_conflict");

    const management = await f.ok("GET", `/v1/spaces/${space.spaceId}/management`, {}, owner.headers);
    assert.deepEqual(management.wishes, [], "neither rejected write should have changed persisted state");
  } finally { f.close(); }
});
