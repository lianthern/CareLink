import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixture-factory.mjs";
import { approveListing, hideListing, isAllowedOpenUrl, listListings } from "../../../tools/public-space-listings.mjs";

test("owner can request public listing; repeat requests are idempotent", async () => {
  const f = fixture();
  try {
    const account = await f.login();
    const space = await f.createSpace(account);
    const initialStatus = await f.ok("GET", `/v1/spaces/${space.spaceId}/public-listing`, {}, account.headers);
    assert.equal(initialStatus.status, "unlisted");

    const first = await f.ok("POST", `/v1/spaces/${space.spaceId}/public-listing-requests`, {}, account.headers);
    assert.equal(first.status, "requested");
    assert.ok(first.requestedAt);

    const second = await f.ok("POST", `/v1/spaces/${space.spaceId}/public-listing-requests`, {}, account.headers);
    assert.equal(second.status, "requested");
    assert.equal(second.requestedAt, first.requestedAt, "repeat request must not bump requestedAt");
    assert.equal(second.version, first.version, "repeat request while already pending must be a no-op");

    const rows = f.db.prepare("SELECT COUNT(*) count FROM public_space_listings WHERE space_id=?").get(space.spaceId);
    assert.equal(rows.count, 1, "repeat requests must never duplicate the row");
  } finally { f.close(); }
});

test("non-owner cannot request or read public-listing status", async () => {
  const f = fixture();
  try {
    const owner = await f.login("owner@example.test");
    const space = await f.createSpace(owner);
    const stranger = await f.login("stranger@example.test");
    const statusResult = await f.call("GET", `/v1/spaces/${space.spaceId}/public-listing`, {}, stranger.headers);
    assert.equal(statusResult.status, 403);
    assert.equal(statusResult.body.error.code, "owner_required");
    const requestResult = await f.call("POST", `/v1/spaces/${space.spaceId}/public-listing-requests`, {}, stranger.headers);
    assert.equal(requestResult.status, 403);
    assert.equal(requestResult.body.error.code, "owner_required");
  } finally { f.close(); }
});

test("requesting again after an ops hide re-opens the listing for review, without auto-listing it", async () => {
  const f = fixture();
  try {
    const account = await f.login();
    const space = await f.createSpace(account);
    await f.ok("POST", `/v1/spaces/${space.spaceId}/public-listing-requests`, {}, account.headers);
    approveListing(f.db, space.spaceId, { openUrl: "/open/fixture-token", title: "自定义标题", description: "自定义描述" });
    hideListing(f.db, space.spaceId);

    const afterHide = await f.ok("GET", `/v1/spaces/${space.spaceId}/public-listing`, {}, account.headers);
    assert.equal(afterHide.status, "hidden");

    const reRequested = await f.ok("POST", `/v1/spaces/${space.spaceId}/public-listing-requests`, {}, account.headers);
    assert.equal(reRequested.status, "requested");
    // Curated copy from the last approval must survive the hide -> re-request cycle.
    assert.equal(reRequested.title, "自定义标题");
    assert.equal(reRequested.openUrl, "/open/fixture-token");
  } finally { f.close(); }
});

test("requesting again once already listed does not regress the status", async () => {
  const f = fixture();
  try {
    const account = await f.login();
    const space = await f.createSpace(account);
    await f.ok("POST", `/v1/spaces/${space.spaceId}/public-listing-requests`, {}, account.headers);
    approveListing(f.db, space.spaceId, { openUrl: "/open/fixture-token" });
    const replay = await f.ok("POST", `/v1/spaces/${space.spaceId}/public-listing-requests`, {}, account.headers);
    assert.equal(replay.status, "listed");
  } finally { f.close(); }
});

test("GET /v1/discover/spaces returns only listed entries, whitelisted to title/description/url", async () => {
  const f = fixture();
  try {
    const account = await f.login();
    const requestedSpace = await f.createSpace(account, "还在审核");
    const listedSpace = await f.createSpace(account, "私密真实名字 · 不应该出现");
    const hiddenSpace = await f.createSpace(account, "已下架");
    await f.ok("POST", `/v1/spaces/${requestedSpace.spaceId}/public-listing-requests`, {}, account.headers);
    approveListing(f.db, listedSpace.spaceId, { openUrl: "/open/curated-token", title: "策展标题", description: "策展描述" });
    approveListing(f.db, hiddenSpace.spaceId, { openUrl: "/open/hidden-token" });
    hideListing(f.db, hiddenSpace.spaceId);

    const discovered = await f.ok("GET", "/v1/discover/spaces");
    assert.equal(discovered.spaces.length, 1);
    const [entry] = discovered.spaces;
    assert.deepEqual(Object.keys(entry).sort(), ["description", "title", "url"]);
    assert.equal(entry.title, "策展标题");
    assert.equal(entry.description, "策展描述");
    assert.equal(entry.url, "/open/curated-token");
    assert.doesNotMatch(JSON.stringify(discovered), /私密真实名字/, "the real space name must never leak through discover");
  } finally { f.close(); }
});

test("discover reads need no session and get a permissive cache header", async () => {
  const f = fixture();
  try {
    const result = await f.call("GET", "/v1/discover/spaces");
    assert.equal(result.status, 200);
    assert.equal(result.headers["cache-control"], "public, max-age=60");
    assert.deepEqual(result.body, { spaces: [] });
  } finally { f.close(); }
});

test("approveListing rejects an open_url outside isAllowedFeaturedSpaceUrl's allow-list", async () => {
  const f = fixture();
  try {
    const account = await f.login();
    const space = await f.createSpace(account);
    assert.equal(isAllowedOpenUrl("https://evil.example.com/x"), false);
    assert.equal(isAllowedOpenUrl("/open/relative-token"), true);
    assert.throws(() => approveListing(f.db, space.spaceId, { openUrl: "https://evil.example.com/x" }), /not allowed/);
  } finally { f.close(); }
});

test("ops CLI list filters by status", async () => {
  const f = fixture();
  try {
    const account = await f.login();
    const space = await f.createSpace(account);
    approveListing(f.db, space.spaceId, { openUrl: "/open/token-a" });
    assert.equal(listListings(f.db, { status: "listed" }).length, 1);
    assert.equal(listListings(f.db, { status: "requested" }).length, 0);
    assert.equal(listListings(f.db, { status: "all" }).length, 1);
  } finally { f.close(); }
});
