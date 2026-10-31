import test from "node:test";
import assert from "node:assert/strict";
import { albumPage, batchResultPage, photoPage } from "../src/ui/templates.js";

// 2026-08-17 "AI 定位·可修正"产品语义：CLIP 阈值重定之后，classifyMatch() 对真实照片终于会
// 真的判出 same_scene_high，dispatch/index.mjs 会把 confirmation_mode 落成 'auto'（区别于主人
// 手动确认的 'manual'）。这批测试盯的是 UI 层对这个区分的呈现：达标自动落位的照片要在相册/照片
// 详情页标出"这是机器判的，你能改"，manual 确认的照片不受影响、措辞不变。

function withStubbedGlobals(pathname, run) {
  const priorDocument = globalThis.document;
  const priorLocation = globalThis.location;
  globalThis.document = { title: "" };
  globalThis.location = { pathname, search: "" };
  try { return run(); }
  finally { globalThis.document = priorDocument; globalThis.location = priorLocation; }
}

const baseState = { account: null, capabilities: {}, spaces: [], currentSpaceId: "space-1", debug: false, uiProductizationFixture: false };

test("photoPage: confirmationMode='auto' 的已定位照片标注「AI 定位 · 可修正」，标注本身是直达位置编辑器的链接", () => {
  withStubbedGlobals("/s/space-1/photos/photo-1", () => {
    const photo = { id: "photo-1", title: "照片一", asset: "/a.jpg", uploader: "林野",
      contentState: "visible", placementState: "confirmed", confirmationMode: "auto" };
    const html = photoPage(baseState, photo);
    assert.match(html, /AI 定位 · 可修正/);
    // 标注本身是 <a>，href 直达 PLACEMENT.OPEN_EDITOR 的路由(/placements/{id}/edit)，
    // 不是一个纯装饰的 <span> —— 点它就是"一键纠正"，不用先找"更多操作"菜单。
    assert.match(html, /<a class="status-pill status-info" href="\/placements\/photo-1\/edit" data-nav>AI 定位 · 可修正<\/a>/);
  });
});

test("photoPage: AI 定位标注的 href 对恶意 photo.id 也全程 esc()，不会被拼出属性逃逸", () => {
  withStubbedGlobals("/s/space-1/photos/malicious", () => {
    const photo = { id: `photo-1" onmouseover="alert(1)`, title: "照片", asset: "/a.jpg",
      contentState: "visible", placementState: "confirmed", confirmationMode: "auto" };
    const html = photoPage(baseState, photo);
    assert.doesNotMatch(html, /onmouseover="alert\(1\)"/, "photo.id 拼进 href 时必须被 esc() 转义，不能变成可执行属性");
    assert.match(html, /href="\/placements\/photo-1&quot; onmouseover=&quot;alert\(1\)\/edit"/);
  });
});

test("photoPage: confirmationMode='manual' 的已定位照片措辞不变，仍是「已回到现场」且不是链接", () => {
  withStubbedGlobals("/s/space-1/photos/photo-2", () => {
    const photo = { id: "photo-2", title: "照片二", asset: "/b.jpg", uploader: "沈舟",
      contentState: "visible", placementState: "confirmed", confirmationMode: "manual" };
    const html = photoPage(baseState, photo);
    assert.match(html, /已回到现场/);
    assert.doesNotMatch(html, /AI 定位/);
    assert.match(html, /<span class="status-pill status-success">已回到现场<\/span>/);
  });
});

test("photoPage: needs_confirmation/待定位照片不受这次改动影响", () => {
  withStubbedGlobals("/s/space-1/photos/photo-3", () => {
    const photo = { id: "photo-3", title: "照片三", asset: "/c.jpg", contentState: "visible",
      placementState: "needs_confirmation", confirmationMode: null };
    const html = photoPage(baseState, photo);
    assert.match(html, /待定位/);
    assert.doesNotMatch(html, /AI 定位/);
  });
});

test("albumPage: 相册网格里 auto 落位的照片圆点 aria-label 也读「AI 定位 · 可修正」(info 色调)，manual 的仍是「已回到现场」", () => {
  const priorDocument = globalThis.document;
  globalThis.document = { title: "" };
  try {
    const viewer = { name: "Test Space", effectiveCanUpload: true, photos: [
      { id: "p-auto", title: "自动落位", asset: "/auto.jpg", placementState: "confirmed", confirmationMode: "auto" },
      { id: "p-manual", title: "手动确认", asset: "/manual.jpg", placementState: "confirmed", confirmationMode: "manual" }
    ] };
    const html = albumPage(baseState, viewer);
    assert.match(html, /aria-label="AI 定位 · 可修正"/);
    assert.match(html, /badge-dot-info/);
    assert.match(html, /aria-label="已回到现场"/);
  } finally { globalThis.document = priorDocument; }
});

// 误导文案修复(2026-08-19): viewer-media-service.mjs 的 photoState() 按设计只把媒体发给
// placement_state='confirmed' 的照片——一张 needs_confirmation(还没定位)的照片走到相册
// 贴片时同样拿不到 photo.asset，之前落到跟"sha256 对不上/资产 invalid"共用的同一句
// "照片校验未通过"，让完全正常、只是还没定位的照片看着像文件坏了。这两个测试锁住:
// needs_confirmation 显示新文案，真校验失败(asset 缺失但 placementState 已是
// confirmed，即已经过placement_state 门槛却仍拿不到字节)仍显示原文案。
test("albumPage: 没有 asset 且 placementState='needs_confirmation' 的照片显示「待定位」文案，不是「照片校验未通过」", () => {
  const priorDocument = globalThis.document;
  globalThis.document = { title: "" };
  try {
    const viewer = { name: "Test Space", effectiveCanUpload: true, photos: [
      { id: "p-pending", title: "还没定位的照片", asset: "", placementState: "needs_confirmation", confirmationMode: null }
    ] };
    const html = albumPage(baseState, viewer);
    assert.match(html, /<span class="photo-pending">待定位 · 确认位置后可查看<\/span>/);
    assert.doesNotMatch(html, /照片校验未通过/);
  } finally { globalThis.document = priorDocument; }
});

test("albumPage: 没有 asset 但 placementState 不是 needs_confirmation(真校验失败)的照片仍显示「照片校验未通过」", () => {
  const priorDocument = globalThis.document;
  globalThis.document = { title: "" };
  try {
    const viewer = { name: "Test Space", effectiveCanUpload: true, photos: [
      { id: "p-broken", title: "sha256 对不上的照片", asset: "", placementState: "confirmed", confirmationMode: "manual" }
    ] };
    const html = albumPage(baseState, viewer);
    assert.match(html, /<span class="photo-unavailable">照片校验未通过<\/span>/);
    assert.doesNotMatch(html, /待定位 · 确认位置后可查看/);
  } finally { globalThis.document = priorDocument; }
});

test("batchResultPage: 空间还没有 360 现场且有照片在等定位时，回执页显示诚实提示", () => {
  const priorDocument = globalThis.document;
  const priorLocation = globalThis.location;
  globalThis.document = { title: "" };
  globalThis.location = { pathname: "/uploads/batch-1", search: "" };
  try {
    const batch = { id: "batch-1", status: "finalized", receiptRevoked: false, spaceHasScene: false, items: [
      { itemId: "item-1", id: "item-1", status: "committed", photoId: "photo-1", placementState: "needs_confirmation", fileName: "a.jpg" }
    ] };
    const html = batchResultPage(baseState, batch);
    assert.match(html, /这个空间还没有 360 现场，照片先收着，等主人上传全景后会自动归位。/);
  } finally { globalThis.document = priorDocument; globalThis.location = priorLocation; }
});

test("batchResultPage: 空间已经有 360 现场时不显示这条提示", () => {
  const priorDocument = globalThis.document;
  const priorLocation = globalThis.location;
  globalThis.document = { title: "" };
  globalThis.location = { pathname: "/uploads/batch-1", search: "" };
  try {
    const batch = { id: "batch-2", status: "finalized", receiptRevoked: false, spaceHasScene: true, items: [
      { itemId: "item-1", id: "item-1", status: "committed", photoId: "photo-1", placementState: "needs_confirmation", fileName: "a.jpg" }
    ] };
    const html = batchResultPage(baseState, batch);
    assert.doesNotMatch(html, /还没有 360 现场/);
  } finally { globalThis.document = priorDocument; globalThis.location = priorLocation; }
});

test("batchResultPage: 空间没有 360 现场，但这一批没有照片在等定位(全部失败/已定位)时也不显示 —— 提示只在真的相关时出现", () => {
  const priorDocument = globalThis.document;
  const priorLocation = globalThis.location;
  globalThis.document = { title: "" };
  globalThis.location = { pathname: "/uploads/batch-1", search: "" };
  try {
    const batch = { id: "batch-3", status: "finalized", receiptRevoked: false, spaceHasScene: false, items: [
      { itemId: "item-1", id: "item-1", status: "failed", photoId: null, placementState: null, failureCode: "file_too_large", fileName: "a.jpg" }
    ] };
    const html = batchResultPage(baseState, batch);
    assert.doesNotMatch(html, /还没有 360 现场/);
  } finally { globalThis.document = priorDocument; globalThis.location = priorLocation; }
});
