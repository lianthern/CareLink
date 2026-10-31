import test from "node:test";
import assert from "node:assert/strict";
import { discoverPage, managePage } from "../src/ui/templates.js";
import { featuredSpaces } from "../src/config/featured-spaces.js";
import { HttpApiAdapter, readApi, readPathParams, resolveReadPath } from "../src/api/http-adapter.js";
import { FixtureApiAdapter } from "../src/api/fixture-adapter.js";

function withStubbedDocument(run) {
  const priorDocument = globalThis.document;
  globalThis.document = { title: "" };
  try { return run(); }
  finally { globalThis.document = priorDocument; }
}

const loggedOutState = { account: null, capabilities: {}, spaces: [], currentSpaceId: "", debug: false };

const baseManagement = () => ({
  isOwner: true,
  scopes: ["canPublish"],
  space: { id: "space-1", name: "测试空间", collectionState: "open", sharingState: "shared" },
  reviewQueue: [],
  placementQueue: [],
  publicListing: null
});

test("discoverPage falls back to the static featured-space catalog when the live payload is missing or empty", () => {
  withStubbedDocument(() => {
    assert.equal(featuredSpaces.length, 1, "sanity check: v0 fallback catalog still has exactly one entry");
    const missingArg = discoverPage(loggedOutState);
    assert.match(missingArg, /夏日聚会/);
    const emptyArray = discoverPage(loggedOutState, []);
    assert.match(emptyArray, /夏日聚会/);
    const nullPayload = discoverPage(loggedOutState, null);
    assert.match(nullPayload, /夏日聚会/);
  });
});

test("discoverPage renders live listed spaces from GET /v1/discover/spaces when present, not the static fallback", () => {
  withStubbedDocument(() => {
    const live = [{ title: "真实的公开空间", description: "来自 /v1/discover/spaces 的策展文案", url: "/open/live-token" }];
    const html = discoverPage(loggedOutState, live);
    assert.match(html, /真实的公开空间/);
    assert.match(html, /href="\/open\/live-token"/);
    assert.doesNotMatch(html, /夏日聚会/, "live data must replace, not append to, the static catalog");
  });
});

test("discoverPage attaches lightweight panorama covers to known live spaces", () => {
  withStubbedDocument(() => {
    const live = [
      { title: "AdventureX 2026 现场", description: "现场", url: "https://unseen.maxxam.xyz/open/0iM0Lj48vhMz5gAPm4h-a9pV7BANC41TiZJH1aNUyWI" },
      { title: "夏日聚会", description: "花园", url: "https://unseen.maxxam.xyz/open/YciUvosxbNRSuxDCqNEBmk5u0hiQuEpIoIADW6davHw" }
    ];
    const html = discoverPage(loggedOutState, live);
    assert.match(html, /src="\/assets\/brand\/adventurex-cover\.jpg"/);
    assert.match(html, /src="\/assets\/brand\/summer-gathering-cover\.jpg"/);
  });
});

test("discoverPage still drops a live entry with a disallowed open_url", () => {
  withStubbedDocument(() => {
    const live = [{ title: "不该出现", description: "跨站", url: "https://evil.example.com/x" }];
    const html = discoverPage(loggedOutState, live);
    assert.doesNotMatch(html, /不该出现/);
    assert.doesNotMatch(html, /evil\.example\.com/);
  });
});

test("manage settings tab: unlisted space shows the request button", () => {
  withStubbedDocument(() => {
    const html = managePage({ account: { id: "a" }, capabilities: {}, spaces: [], currentSpaceId: "space-1", debug: false }, baseManagement(), "settings");
    assert.match(html, /公开到「逛逛空间」/);
    assert.match(html, /data-request-public-listing data-space-id="space-1"/);
    assert.match(html, /申请公开这个空间/);
  });
});

test("manage settings tab: requested/listed/hidden statuses render the right pill and hide/show the button", () => {
  withStubbedDocument(() => {
    const state = { account: { id: "a" }, capabilities: {}, spaces: [], currentSpaceId: "space-1", debug: false };
    const requested = managePage(state, { ...baseManagement(), publicListing: { status: "requested" } }, "settings");
    assert.match(requested, /已提交申请，等待审核/);
    assert.doesNotMatch(requested, /data-request-public-listing/);

    const listed = managePage(state, { ...baseManagement(), publicListing: { status: "listed", openUrl: "/open/tok" } }, "settings");
    assert.match(listed, /已收录进「逛逛空间」/);
    assert.doesNotMatch(listed, /data-request-public-listing/);

    const hidden = managePage(state, { ...baseManagement(), publicListing: { status: "hidden" } }, "settings");
    assert.match(hidden, /已从「逛逛空间」下架/);
    assert.match(hidden, /data-request-public-listing data-space-id="space-1"/);
    assert.match(hidden, /重新申请公开/);
  });
});

test("manage settings tab hides the public-listing section entirely for non-owners", () => {
  withStubbedDocument(() => {
    const state = { account: { id: "a" }, capabilities: {}, spaces: [], currentSpaceId: "space-1", debug: false };
    const html = managePage(state, { ...baseManagement(), isOwner: false }, "settings");
    assert.doesNotMatch(html, /公开到「逛逛空间」/);
    assert.doesNotMatch(html, /data-request-public-listing/);
  });
});

test("readApi resolves the new discover/public-listing reads to exact encoded paths", () => {
  assert.equal(readApi.discoverSpaces, "/v1/discover/spaces");
  assert.equal(readApi.publicListing, "/v1/spaces/{sid}/public-listing");
  assert.deepEqual(readPathParams.publicListing, { sid: "spaceId" });
  assert.equal(resolveReadPath("discoverSpaces", {}), "/v1/discover/spaces");
  assert.equal(resolveReadPath("publicListing", { spaceId: "space / 1" }), "/v1/spaces/space%20%2F%201/public-listing");
});

test("HttpApiAdapter.requestPublicListing POSTs to the exact encoded endpoint with an idempotency key", async () => {
  const captures = [];
  const adapter = new HttpApiAdapter({ transport: async (url, init) => { captures.push({ url, init }); return new Response("{\"status\":\"requested\"}", { status: 200, headers: { "Content-Type": "application/json" } }); } });
  const result = await adapter.requestPublicListing("space / 1");
  assert.equal(result.status, "requested");
  const sent = captures.at(-1);
  assert.equal(sent.url, "/v1/spaces/space%20%2F%201/public-listing-requests");
  assert.equal(sent.init.method, "POST");
  assert.equal(sent.init.body, "{}");
  assert.ok(sent.init.headers["Idempotency-Key"]);
});

test("FixtureApiAdapter models the same request/discover contract as the real backend", async () => {
  const memoryStorage = () => { let value; return { getItem: () => value, setItem: (_, next) => { value = next; } }; };
  const adapter = new FixtureApiAdapter({ storage: memoryStorage() });
  const spaceId = "space-gongguang";

  const unlisted = await adapter.read("publicListing", { spaceId });
  assert.equal(unlisted.status, "unlisted");
  assert.deepEqual((await adapter.read("discoverSpaces")).spaces, []);

  const first = await adapter.requestPublicListing(spaceId);
  assert.equal(first.status, "requested");
  const second = await adapter.requestPublicListing(spaceId);
  assert.equal(second.status, "requested");
  assert.equal(second.requestedAt, first.requestedAt, "repeat request while pending must be a no-op");
  assert.equal(second.version, first.version);

  // Ops approval is DB-side in production; the fixture models it by writing the listing directly,
  // which is the same shape requestPublicListing() itself writes.
  adapter.state.spaces[0].publicListing = { ...adapter.state.spaces[0].publicListing, status: "listed",
    title: "策展标题", description: "策展描述", openUrl: "/open/curated-token" };
  const discovered = await adapter.read("discoverSpaces");
  assert.deepEqual(discovered.spaces, [{ title: "策展标题", description: "策展描述", url: "/open/curated-token" }]);
});
