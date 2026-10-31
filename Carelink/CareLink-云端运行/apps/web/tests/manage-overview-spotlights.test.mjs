import test from "node:test";
import assert from "node:assert/strict";
import { managePage, wishList } from "../src/ui/templates.js";
import { FixtureApiAdapter } from "../src/api/fixture-adapter.js";

// host-panel worktree ("把旧站主办方面板里两个最好的概念搬进管理页"): priority 1
// ("待你确认" 聚合视图) and priority 2 ("缺口"方向格), both rendered at the top of
// the manage page's overview tab. See overviewTab()/needsConfirmationSection()/
// directionGapSection() in ../src/ui/templates.js.

function withStubbedDocument(run) {
  const priorDocument = globalThis.document;
  globalThis.document = { title: "" };
  try { return run(); }
  finally { globalThis.document = priorDocument; }
}

const state = { account: { id: "a" }, capabilities: {}, spaces: [], currentSpaceId: "space-1", debug: false };

const baseManagement = (overrides = {}) => ({
  isOwner: true,
  scopes: ["canReview", "canEditPlacement", "canPublish"],
  space: { id: "space-1", name: "测试空间", collectionState: "open", sharingState: "shared", ifMatch: '"7"' },
  reviewQueue: [],
  placementQueue: [],
  confirmedPlacementCount: 0,
  missingDirections: [],
  wishes: [],
  ...overrides
});

const needsConfirmationPhoto = (overrides = {}) => ({
  id: "photo-1", title: "回头的一刻", asset: "/a.jpg", uploader: "夏宁", placementState: "needs_confirmation", ...overrides
});

test("待你确认: an empty needs_confirmation queue shows the exact host.html empty-state copy", () => {
  withStubbedDocument(() => {
    const html = managePage(state, baseManagement({ placementQueue: [] }), "overview");
    assert.match(html, /机器都处理好了/);
    assert.doesNotMatch(html, /机器这次一张也没敢替你拍板/);
    assert.doesNotMatch(html, /打开位置编辑器/);
  });
});

test("待你确认: a non-empty queue with zero confirmed placements shows the exact host.html 'zero confidence' copy", () => {
  withStubbedDocument(() => {
    const management = baseManagement({ placementQueue: [needsConfirmationPhoto()], confirmedPlacementCount: 0 });
    const html = managePage(state, management, "overview");
    assert.match(html, /机器这次一张也没敢替你拍板，判断权全在你手上/);
    assert.doesNotMatch(html, /机器都处理好了/);
  });
});

test("待你确认: a non-empty queue with some confirmed placements shows the drafted guidance line instead", () => {
  withStubbedDocument(() => {
    const management = baseManagement({ placementQueue: [needsConfirmationPhoto()], confirmedPlacementCount: 3 });
    const html = managePage(state, management, "overview");
    assert.match(html, /宾客传上来以后，只有机器拿不准的才会摆到这里等你/);
    assert.doesNotMatch(html, /机器这次一张也没敢替你拍板/);
    assert.doesNotMatch(html, /机器都处理好了/);
  });
});

test("待你确认: only needs_confirmation photos are aggregated, not the wider stale/failed 疑似待复核 set", () => {
  withStubbedDocument(() => {
    const management = baseManagement({
      placementQueue: [
        needsConfirmationPhoto({ id: "photo-nc", title: "needs confirmation" }),
        { id: "photo-stale", title: "stale one", asset: "/b.jpg", uploader: "x", placementState: "stale" },
        { id: "photo-failed", title: "failed one", asset: "/c.jpg", uploader: "x", placementState: "failed" }
      ],
      confirmedPlacementCount: 1
    });
    const html = managePage(state, management, "overview");
    assert.match(html, /data-queue-item="photo-nc"/);
    assert.doesNotMatch(html, /data-queue-item="photo-stale"/);
    assert.doesNotMatch(html, /data-queue-item="photo-failed"/);
  });
});

test("待你确认: each card links straight into the existing placement editor, no new editor route", () => {
  withStubbedDocument(() => {
    const management = baseManagement({ placementQueue: [needsConfirmationPhoto({ id: "photo-42" })], confirmedPlacementCount: 1 });
    const html = managePage(state, management, "overview");
    assert.match(html, /href="\/placements\/photo-42\/edit"/);
  });
});

test("待你确认: photo title/uploader/asset are HTML-escaped before reaching the page", () => {
  withStubbedDocument(() => {
    const payload = '<img src=x onerror=alert(1)>';
    const management = baseManagement({
      placementQueue: [needsConfirmationPhoto({ title: payload, uploader: payload, asset: payload })],
      confirmedPlacementCount: 1
    });
    const html = managePage(state, management, "overview");
    assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });
});

test("方向覆盖: zero missing directions omits the section entirely", () => {
  withStubbedDocument(() => {
    const html = managePage(state, baseManagement({ missingDirections: [] }), "overview");
    assert.doesNotMatch(html, /现场覆盖/);
    assert.doesNotMatch(html, /没人拍过的方向/);
  });
});

test("方向覆盖: production-verified case (9 missing) lists all 9 buckets with degree labels", () => {
  withStubbedDocument(() => {
    const management = baseManagement({ missingDirections: [0, 1, 2, 3, 4, 6, 7, 9, 10] });
    const html = managePage(state, management, "overview");
    assert.match(html, /9 个方向没人拍过/);
    assert.match(html, /已经覆盖 3\/12 个方向/);
    assert.match(html, /0°–30°/);
    assert.match(html, /300°–330°/); // bucket 10
    assert.doesNotMatch(html, /150°–180°/); // bucket 5, covered
    assert.doesNotMatch(html, /240°–270°/); // bucket 8, covered
  });
});

test("方向覆盖: all 12 buckets missing (zero confirmed photos) lists every bucket", () => {
  withStubbedDocument(() => {
    const management = baseManagement({ missingDirections: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] });
    const html = managePage(state, management, "overview");
    assert.match(html, /12 个方向没人拍过/);
    assert.match(html, /已经覆盖 0\/12 个方向/);
    assert.match(html, /330°–360°/);
  });
});

test("方向覆盖: owner sees a 许愿这个方向 button carrying space id/degrees/ifMatch", () => {
  withStubbedDocument(() => {
    const management = baseManagement({ missingDirections: [3], isOwner: true });
    const html = managePage(state, management, "overview");
    assert.match(html, /data-publish-gap-wish data-space-id="space-1" data-degrees="105" data-if-match="&quot;7&quot;"/);
  });
});

test("方向覆盖: a non-owner manager sees the gap but not the wish-publish button (updateWishes is owner-only)", () => {
  withStubbedDocument(() => {
    const management = baseManagement({ missingDirections: [3], isOwner: false, scopes: ["canEditPlacement"] });
    const html = managePage(state, management, "overview");
    assert.match(html, /90°–120°/);
    assert.doesNotMatch(html, /data-publish-gap-wish/);
  });
});

test("both spotlights are hidden entirely for a manager without canEditPlacement/ownership", () => {
  withStubbedDocument(() => {
    const management = baseManagement({
      isOwner: false, scopes: ["canReview"],
      placementQueue: [needsConfirmationPhoto()], missingDirections: [1, 2, 3]
    });
    const html = managePage(state, management, "overview");
    assert.doesNotMatch(html, /待你确认/);
    assert.doesNotMatch(html, /现场覆盖/);
  });
});

test("wishList (exported) filters blanks/whitespace and caps at 6, matching wishEditor()'s own rule", () => {
  assert.deepEqual(wishList(["a", "  ", "", "b", "c", "d", "e", "f", "g"]), ["a", "b", "c", "d", "e", "f"]);
  assert.deepEqual(wishList(undefined), []);
  assert.deepEqual(wishList(null), []);
});

function memoryStorage() {
  let value;
  return { getItem: () => value, setItem: (_, next) => { value = next; } };
}

// FixtureApiAdapter parity with SpaceService#management()'s new fields (services/api/src/space-service.mjs):
// the fixture's default space has 4 confirmed photos (yaw -58/-18/24/92, see fixture-adapter.js) and one
// needs_confirmation photo (yaw 62, uninvolved in coverage since it never confirmed).
test("FixtureApiAdapter's default space computes confirmedPlacementCount and missingDirections the same way the real backend does", async () => {
  const adapter = new FixtureApiAdapter({ storage: memoryStorage() });
  const management = await adapter.read("managementView");
  assert.equal(management.confirmedPlacementCount, 4);
  // -58->bucket10, -18->bucket11, 24->bucket0, 92->bucket3 covered; everything else missing.
  assert.deepEqual(management.missingDirections, [1, 2, 4, 5, 6, 7, 8, 9]);
});

test("FixtureApiAdapter.updateSpaceWishes (the mutation publishGapWish in app.js drives) appends a wish and bumps space version", async () => {
  const adapter = new FixtureApiAdapter({ storage: memoryStorage() });
  const before = await adapter.read("managementView");
  assert.deepEqual(before.wishes, []);
  const result = await adapter.updateSpaceWishes("space-gongguang", ["求一张朝 45° 方向拍的照片"]);
  assert.deepEqual(result.wishes, ["求一张朝 45° 方向拍的照片"]);
  assert.equal(result.version, before.space.version + 1);
  const after = await adapter.read("managementView");
  assert.deepEqual(after.wishes, ["求一张朝 45° 方向拍的照片"]);
});
