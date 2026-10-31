import test from "node:test";
import assert from "node:assert/strict";
import { managePage, placementEditorPage } from "../src/ui/templates.js";

// A v2 point 3 ("人工队列改造为「复核+定位」二合一"): the placement editor now carries
// content takedown actions (通过/隐藏/拒绝/恢复显示/重新审核) alongside its existing
// position controls, gated to context.manager (the account-session/owner path — see
// app.js's placementRoute()'s `manager: !itemId`, fixed alongside this). The placement
// queue's row label is also "疑似待复核" for needs_confirmation/failed now, distinct from
// the contributor-facing placementLabel() text shown elsewhere (batchItemPage).

function withStubbedDocument(run) {
  const priorDocument = globalThis.document;
  const priorLocation = globalThis.location;
  globalThis.document = { title: "" };
  globalThis.location = { pathname: "/placements/photo-1/edit", search: "" };
  try { return run(); }
  finally { globalThis.document = priorDocument; globalThis.location = priorLocation; }
}

const baseState = { account: null, capabilities: {}, currentSpaceId: "space-1", debug: false };
const baseContext = { sceneContext: { scene: { panoramaRevisionId: "pano-1" } }, batchId: "", itemId: "", photoId: "photo-1", manager: true };

test("manager editor context: contentState visible shows only 隐藏/拒绝, no 通过", () => {
  withStubbedDocument(() => {
    const target = { id: "photo-1", placementState: "needs_confirmation", canEdit: true, contentState: "visible", ifMatch: '"photo:2"' };
    const html = placementEditorPage(baseState, target, baseContext);
    assert.match(html, /照片状态/);
    assert.match(html, /已自动通过/);
    assert.match(html, /data-content-dialog="CONTENT.HIDE" data-photo-id="photo-1" data-if-match="&quot;photo:2&quot;"/);
    assert.match(html, /data-content-dialog="CONTENT.REJECT" data-photo-id="photo-1"/);
    assert.doesNotMatch(html, /data-action="CONTENT.APPROVE"/);
    assert.doesNotMatch(html, /data-content-dialog="CONTENT.REOPEN"/);
  });
});

test("manager editor context: contentState pending shows 通过/隐藏/拒绝", () => {
  withStubbedDocument(() => {
    const target = { id: "photo-1", placementState: "needs_confirmation", canEdit: true, contentState: "pending", ifMatch: '"photo:1"' };
    const html = placementEditorPage(baseState, target, baseContext);
    assert.match(html, /待审核/);
    assert.match(html, /data-action="CONTENT.APPROVE" data-photo-id="photo-1"/);
    assert.match(html, /data-content-dialog="CONTENT.HIDE" data-photo-id="photo-1"/);
    assert.match(html, /data-content-dialog="CONTENT.REJECT" data-photo-id="photo-1"/);
  });
});

test("manager editor context: contentState hidden shows only 恢复显示", () => {
  withStubbedDocument(() => {
    const target = { id: "photo-1", placementState: "needs_confirmation", canEdit: true, contentState: "hidden", ifMatch: '"photo:3"' };
    const html = placementEditorPage(baseState, target, baseContext);
    assert.match(html, /已隐藏/);
    assert.match(html, /data-content-dialog="CONTENT.RESTORE" data-photo-id="photo-1"/);
    assert.doesNotMatch(html, /data-content-dialog="CONTENT.HIDE"/);
  });
});

test("manager editor context: contentState rejected shows only 重新审核", () => {
  withStubbedDocument(() => {
    const target = { id: "photo-1", placementState: "failed", canEdit: true, contentState: "rejected", ifMatch: '"photo:4"' };
    const html = placementEditorPage(baseState, target, baseContext);
    assert.match(html, /未通过/);
    assert.match(html, /data-content-dialog="CONTENT.REOPEN" data-photo-id="photo-1"/);
  });
});

test("non-manager (uploader/receipt-session) editor context never renders content takedown actions", () => {
  withStubbedDocument(() => {
    const target = { id: "photo-1", placementState: "needs_confirmation", canEdit: true, contentState: "visible", ifMatch: '"photo:2"' };
    const html = placementEditorPage(baseState, target, { ...baseContext, manager: false });
    assert.doesNotMatch(html, /照片状态/);
    assert.doesNotMatch(html, /data-content-dialog="CONTENT/);
    assert.doesNotMatch(html, /data-action="CONTENT.APPROVE"/);
  });
});

const baseManagement = (overrides = {}) => ({
  isOwner: true,
  scopes: ["canReview", "canEditPlacement"],
  space: { id: "space-1", name: "测试空间", collectionState: "open", sharingState: "shared", autoApproveUploads: true },
  reviewQueue: [],
  placementQueue: [],
  publicListing: null,
  wishes: [],
  ...overrides
});

test("placement tab: needs_confirmation/failed render as 疑似待复核 (not the contributor-facing 需要确认位置/定位失败 copy), primary action opens the editor", () => {
  withStubbedDocument(() => {
    const html = managePage({ account: { id: "a" }, capabilities: {}, spaces: [], currentSpaceId: "space-1", debug: false },
      baseManagement({ placementQueue: [
        { id: "p1", title: "t1", asset: "a1", uploader: "u1", placementState: "needs_confirmation" },
        { id: "p2", title: "t2", asset: "a2", uploader: "u2", placementState: "failed" }
      ] }), "placement");
    assert.match(html, /疑似待复核/g);
    assert.doesNotMatch(html, /需要确认位置/);
    assert.doesNotMatch(html, /定位失败/);
    assert.match(html, /href="\/placements\/p1\/edit"[^>]*>打开位置编辑器/);
  });
});

test("placement tab: confirmed/outside_scene keep their original placementLabel copy (only needs_confirmation/failed get the 疑似待复核 relabel)", () => {
  withStubbedDocument(() => {
    const html = managePage({ account: { id: "a" }, capabilities: {}, spaces: [], currentSpaceId: "space-1", debug: false },
      baseManagement({ placementQueue: [{ id: "p3", title: "t3", asset: "a3", uploader: "u3", placementState: "stale" }] }), "placement");
    assert.match(html, /位置需要更新/);
    assert.doesNotMatch(html, /疑似待复核/);
  });
});
