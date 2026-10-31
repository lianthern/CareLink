import test from "node:test";
import assert from "node:assert/strict";
import { managePage } from "../src/ui/templates.js";
import { HttpApiAdapter, readApi } from "../src/api/http-adapter.js";
import { FixtureApiAdapter } from "../src/api/fixture-adapter.js";

// A ("照片自动审核" 空间级开关): apps/web-side rendering/wiring for the settings-tab
// toggle and the widened review queue (auto-approved-but-unreviewed photos still
// need to surface for hide/reject — see space-service.mjs's management()).

function withStubbedDocument(run) {
  const priorDocument = globalThis.document;
  globalThis.document = { title: "" };
  try { return run(); }
  finally { globalThis.document = priorDocument; }
}

const state = { account: { id: "a" }, capabilities: {}, spaces: [], currentSpaceId: "space-1", debug: false };

const baseManagement = (overrides = {}) => ({
  isOwner: true,
  scopes: ["canReview", "canPublish"],
  space: { id: "space-1", name: "测试空间", collectionState: "open", sharingState: "shared", autoApproveUploads: false, ifMatch: '"3"' },
  reviewQueue: [],
  placementQueue: [],
  publicListing: null,
  wishes: [],
  ...overrides
});

// A v2: same column/endpoint/toggle plumbing as before, reframed as "全自动链路" —
// the master switch for the whole upload -> visible -> CLIP-placement pipeline, not
// merely a content-approval bypass (Max's in-person correction over the v1 framing).
test("settings tab: full-auto-pipeline row shows off state, the on-toggle button, and the space's If-Match", () => {
  withStubbedDocument(() => {
    const html = managePage(state, baseManagement(), "settings");
    assert.match(html, /全自动链路/);
    assert.match(html, /已关闭/);
    assert.match(html, /data-toggle-auto-approve data-space-id="space-1" data-to="on" data-if-match="&quot;3&quot;"/);
    assert.match(html, /开启全自动链路/);
  });
});

test("settings tab: full-auto-pipeline row shows on state and the off-toggle button", () => {
  withStubbedDocument(() => {
    const management = baseManagement({ space: { id: "space-1", name: "测试空间", collectionState: "open", sharingState: "shared", autoApproveUploads: true, ifMatch: '"4"' } });
    const html = managePage(state, management, "settings");
    assert.match(html, /已开启/);
    assert.match(html, /data-toggle-auto-approve data-space-id="space-1" data-to="off"/);
    assert.match(html, /关闭全自动链路/);
  });
});

test("settings tab hides the full-auto-pipeline row entirely for non-owners", () => {
  withStubbedDocument(() => {
    const html = managePage(state, baseManagement({ isOwner: false }), "settings");
    assert.doesNotMatch(html, /全自动链路/);
    assert.doesNotMatch(html, /data-toggle-auto-approve/);
  });
});

test("review tab: an auto-approved-but-unreviewed photo (contentState visible) shows an '已自动通过' chip with hide/reject only", () => {
  withStubbedDocument(() => {
    const management = baseManagement({
      reviewQueue: [{ id: "photo-1", title: "照片 1", asset: "/a.jpg", uploader: "参与者", contentState: "visible", ifMatch: "1" }]
    });
    const html = managePage(state, management, "review");
    assert.match(html, /已自动通过/);
    assert.match(html, /data-content-dialog="CONTENT.HIDE" data-photo-id="photo-1"/);
    assert.match(html, /data-content-dialog="CONTENT.REJECT" data-photo-id="photo-1"/);
    // Must not offer APPROVE (already visible) or REOPEN (that transition only accepts 'rejected').
    assert.doesNotMatch(html, /data-action="CONTENT.APPROVE"/);
    assert.doesNotMatch(html, /data-content-dialog="CONTENT.REOPEN"/);
  });
});

test("review tab: pending/hidden/rejected still render their original chip and actions unchanged", () => {
  withStubbedDocument(() => {
    const pending = managePage(state, baseManagement({ reviewQueue: [{ id: "p1", title: "t", asset: "a", uploader: "u", contentState: "pending", ifMatch: "1" }] }), "review");
    assert.match(pending, /待审核/);
    assert.match(pending, /data-action="CONTENT.APPROVE" data-photo-id="p1"/);

    const hidden = managePage(state, baseManagement({ reviewQueue: [{ id: "p2", title: "t", asset: "a", uploader: "u", contentState: "hidden", ifMatch: "1" }] }), "review");
    assert.match(hidden, /已隐藏/);
    assert.match(hidden, /data-content-dialog="CONTENT.RESTORE" data-photo-id="p2"/);

    const rejected = managePage(state, baseManagement({ reviewQueue: [{ id: "p3", title: "t", asset: "a", uploader: "u", contentState: "rejected", ifMatch: "1" }] }), "review");
    assert.match(rejected, /未通过/);
    assert.match(rejected, /data-content-dialog="CONTENT.REOPEN" data-photo-id="p3"/);
  });
});

test("HttpApiAdapter.updateAutoApproveUploads POSTs to the exact endpoint with If-Match", async () => {
  const captures = [];
  const adapter = new HttpApiAdapter({ transport: async (url, init) => { captures.push({ url, init }); return new Response('{"spaceId":"space / 1","autoApproveUploads":true,"version":5}', { status: 200, headers: { "Content-Type": "application/json" } }); } });
  const result = await adapter.updateAutoApproveUploads("space / 1", "on", "4");
  assert.equal(result.autoApproveUploads, true);
  const sent = captures.at(-1);
  assert.equal(sent.url, "/v1/spaces/space%20%2F%201/auto-approve-uploads-transitions");
  assert.equal(sent.init.method, "POST");
  assert.equal(sent.init.body, '{"to":"on"}');
  assert.equal(sent.init.headers["If-Match"], "4");
});

test("FixtureApiAdapter models the same auto-approve-uploads toggle contract as the real backend", async () => {
  const memoryStorage = () => { let value; return { getItem: () => value, setItem: (_, next) => { value = next; } }; };
  const adapter = new FixtureApiAdapter({ storage: memoryStorage() });
  const spaceId = "space-gongguang";
  const before = await adapter.read("managementView");
  assert.equal(before.space.autoApproveUploads, false, "fixture's default space starts off, same as a real pre-migration space");

  const off = await adapter.updateAutoApproveUploads(spaceId, "off");
  assert.equal(off.autoApproveUploads, false);
  const on = await adapter.updateAutoApproveUploads(spaceId, "on");
  assert.equal(on.autoApproveUploads, true);
  assert.equal(on.version, off.version + 1);

  const after = await adapter.read("managementView");
  assert.equal(after.space.autoApproveUploads, true);

  await assert.rejects(adapter.updateAutoApproveUploads(spaceId, "sideways"), (error) => error.code === "validation_failed");
});

test("readApi carries no path for this endpoint — it's a bespoke owner mutation outside the frozen action registry, same as wishes/public-listing", () => {
  assert.ok(!("autoApproveUploads" in readApi), "must not accidentally become a generated-contract read resource");
});
