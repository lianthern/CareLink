import test from "node:test";
import assert from "node:assert/strict";
import { dispatchOne } from "../../jobs/dispatch/index.mjs";
import { createAccountUpload, exchangeReceipt, fixture, png } from "./fixture-factory.mjs";

// A v2 修复验证："疑似待复核"(needs_confirmation/failed)照片打开位置编辑器时，360 场景预览
// 必须可用 —— 这正是编辑器存在的意义。此前 viewer-media-service.mjs 的 sceneContext() 经
// photoState() 强制要求目标照片 placement_state='confirmed'，而 editView()/receiptItem() 又从
// 不把 sceneContext 编进自己的响应，app.js 只能落回对目标照片直接调用确认专用的
// /v1/viewer/spaces/{sid}/photos/{pid}/scene-context，未确认照片必然 404，编辑器整页退化成
// "现场资源不可用或已过期"。修复：ViewerMediaService#editorSceneContext() 放宽确认要求，但只
// 从 PlacementService#editView()/UploadService#receiptItem() 内部调用 —— 两者都已经用
// managerOrReceipt() 做过身份核验(manager 需 canEditPlacement scope；uploader 需
// uploader_placement_write_enabled=1)。公开的、仅供已确认照片使用的 viewer 路由本身保持不变。

async function activatePanorama(f, owner, space) {
  const bytes = png(1600, 800);
  const current = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(space.spaceId);
  const candidate = await f.ok("POST", `/v1/spaces/${space.spaceId}/panorama-candidates`, {
    declaredMime: "image/png", declaredBytes: bytes.length, clientAssetId: "editor-scene-fix-panorama"
  }, { ...owner.headers, "if-match": String(current.version),
    "notice-acknowledgement": JSON.stringify({ purpose: "panorama_upload", version: 1,
      contentHash: "local-panorama_upload-v1" }) });
  const put = await f.api.putMedia({ ticket: candidate.exactPrivateUploadTicketOnce,
    bytes, contentType: "image/png", kind: "panorama" });
  const committed = await f.ok("POST", `/v1/panorama-upload-sessions/${candidate.uploadSessionId}/commits`,
    { clientRequestId: "editor-scene-fix-panorama-commit" },
    { ...owner.headers, "if-match": String(put.body.uploadSessionVersion) });
  const ready = dispatchOne(f.db, committed.jobId, { now: f.clock.iso() });
  const scene = f.db.prepare("SELECT * FROM scenes WHERE space_id=?").get(space.spaceId);
  const before = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(space.spaceId);
  await f.ok("POST", `/v1/spaces/${space.spaceId}/panorama-switches`, {
    mode: "switch", candidateRevisionId: ready.panoramaRevisionId, sceneIfMatchVersion: scene.version
  }, { ...owner.headers, "if-match": String(before.version) });
  return { ...space, version: f.db.prepare("SELECT version FROM spaces WHERE id=?").get(space.spaceId).version };
}

async function needsConfirmationPhoto(f, owner, space, outcome = { classification: "uncertain" }) {
  const flow = await createAccountUpload(f, owner, space);
  const validation = dispatchOne(f.db, flow.committed.jobId, { now: f.clock.iso() });
  const placement = dispatchOne(f.db, validation.placementJobId, { now: f.clock.iso(), outcome });
  return { flow, placement };
}

test("manager: needs_confirmation 照片的编辑器现在能拿到可用的 360 场景预览", async () => {
  const f = fixture();
  try {
    const owner = await f.login("scene-fix-manager@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    space = await activatePanorama(f, owner, space);
    const { flow, placement } = await needsConfirmationPhoto(f, owner, space);
    assert.equal(placement.placementState, "needs_confirmation");

    const edit = await f.ok("GET", `/v1/photos/${flow.committed.photoId}/placement-edit`, {}, owner.headers);
    assert.equal(edit.placementState, "needs_confirmation");
    assert.ok(edit.sceneContext, "editView() 必须把 sceneContext 编进自己的响应，编辑器才有 360 预览");
    assert.equal(edit.sceneContext.photoId, flow.committed.photoId);
    assert.equal(edit.sceneContext.sceneReadiness, "ready");
    assert.equal(edit.sceneContext.placement, null, "未确认照片没有真实的已确认 placement");
    assert.ok(edit.sceneContext.panorama?.url, "全景媒体描述符必须存在，前端才能拉取全景图");
    assert.ok(edit.sceneContext.photoMedia?.url, "目标照片自己的媒体描述符也必须存在");
    assert.equal(edit.sceneContext.photoMedia.url, `/v1/photos/${flow.committed.photoId}/placement-edit/media`,
      "未确认照片的媒体必须走 editorMedia() 专用路由，而不是要求已确认的通用 viewer 路由");

    // 这个 URL 真的能取到字节，不只是字符串存在
    const media = await f.call("GET", edit.sceneContext.photoMedia.url, {}, owner.headers);
    assert.equal(media.status, 200);
    assert.equal(media.headers?.["content-type"] ?? media.headers?.["Content-Type"], edit.sceneContext.photoMedia.contentType);

    // 陌生账号拿不到同一张照片的编辑用媒体字节
    const stranger = await f.login("scene-fix-media-stranger@example.test");
    const strangerMedia = await f.call("GET", edit.sceneContext.photoMedia.url, {}, stranger.headers);
    assert.ok([403, 404].includes(strangerMedia.status));
  } finally { f.close(); }
});

test("failed 照片同样能拿到 sceneContext；outside_scene 照片的 placement 仍是 null", async () => {
  const f = fixture();
  try {
    const owner = await f.login("scene-fix-failed@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    space = await activatePanorama(f, owner, space);
    const { flow } = await needsConfirmationPhoto(f, owner, space, { classification: "decoder_failure" });
    const photo = f.db.prepare("SELECT placement_state FROM photos WHERE id=?").get(flow.committed.photoId);
    assert.equal(photo.placement_state, "failed");

    const edit = await f.ok("GET", `/v1/photos/${flow.committed.photoId}/placement-edit`, {}, owner.headers);
    assert.ok(edit.sceneContext, "failed 照片打开编辑器同样需要 360 预览才能重新手动定位");
    assert.equal(edit.sceneContext.placement, null);
  } finally { f.close(); }
});

test("manager 重新编辑一张已确认的照片：editorSceneContext 带回真实的已确认 placement", async () => {
  const f = fixture();
  try {
    const owner = await f.login("scene-fix-confirmed@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    space = await activatePanorama(f, owner, space);
    const flow = await createAccountUpload(f, owner, space);
    const validation = dispatchOne(f.db, flow.committed.jobId, { now: f.clock.iso() });
    dispatchOne(f.db, validation.placementJobId, { now: f.clock.iso() });
    const photo = f.db.prepare("SELECT * FROM photos WHERE id=?").get(flow.committed.photoId);
    const item = f.db.prepare("SELECT * FROM contribution_batch_items WHERE id=?").get(flow.item.itemId);
    const manual = await f.ok("POST", `/v1/photos/${photo.id}/placement-revisions`, {
      mode: "manual", confirmationMode: "manual", yawDeg: 12, pitchDeg: 3, reason: "owner_confirmed"
    }, { ...owner.headers, "if-match": String(photo.version), "x-item-version": String(item.version),
      "x-placement-authorization-version": String(item.placement_authorization_version) });
    assert.equal(manual.placementState, "confirmed");

    const edit = await f.ok("GET", `/v1/photos/${photo.id}/placement-edit`, {}, owner.headers);
    assert.ok(edit.sceneContext);
    assert.ok(edit.sceneContext.placement, "重新编辑已确认照片时，真实 placement(而非 null)必须原样带回");
    assert.equal(edit.sceneContext.placement.status, "confirmed");
    assert.equal(edit.sceneContext.placement.yawDeg, 12);
    assert.equal(edit.sceneContext.placement.pitchDeg, 3);
  } finally { f.close(); }
});

test("uploader: 有位置编辑权限的上传者也能从回执路径拿到 sceneContext；权限被收回后不再返回", async () => {
  const f = fixture();
  try {
    const owner = await f.login("scene-fix-uploader@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    space = await activatePanorama(f, owner, space);
    const { flow } = await needsConfirmationPhoto(f, owner, space);
    const receiptExchange = await exchangeReceipt(f, flow.finalized);
    assert.equal(receiptExchange.status, 200);
    const receiptHeaders = { "x-receipt-session": receiptExchange.body.receiptSessionSecret };

    const receiptEdit = await f.ok("GET", `/v1/batch-receipt/items/${flow.item.itemId}/placement-edit`, {}, receiptHeaders);
    assert.equal(receiptEdit.canEditPlacement, true);
    assert.ok(receiptEdit.sceneContext, "被授权再调整的上传者打开编辑器同样需要 360 预览");
    assert.equal(receiptEdit.sceneContext.placement, null);

    // 上传者自己的回执会话也能凭这个 URL 真的取到照片字节(editorMedia() 同样认 receipt session)
    const receiptMedia = await f.call("GET", receiptEdit.sceneContext.photoMedia.url, {}, receiptHeaders);
    assert.equal(receiptMedia.status, 200);

    // managerLock() only ever locks the uploader out when a *manager* writes a placement (see
    // placement-service.mjs — `if (!auth.manager) return;`), never when the uploader saves their
    // own draft. So to observe uploader_placement_write_enabled flip to 0, it's the owner
    // (account session) who has to save here, exactly like a manager stepping in.
    const photo = f.db.prepare("SELECT * FROM photos WHERE id=?").get(flow.committed.photoId);
    const item = f.db.prepare("SELECT * FROM contribution_batch_items WHERE id=?").get(flow.item.itemId);
    await f.ok("POST", `/v1/photos/${photo.id}/placement-revisions`, {
      mode: "manual", confirmationMode: "manual", yawDeg: 5, pitchDeg: 0, reason: "manager_saved"
    }, { ...owner.headers, "if-match": String(photo.version), "x-item-version": String(item.version),
      "x-placement-authorization-version": String(item.placement_authorization_version) });
    const locked = f.db.prepare("SELECT * FROM contribution_batch_items WHERE id=?").get(item.id);
    assert.equal(locked.uploader_placement_write_enabled, 0);

    const afterLock = await f.ok("GET", `/v1/batch-receipt/items/${flow.item.itemId}/placement-edit`, {}, receiptHeaders);
    assert.equal(afterLock.canEditPlacement, false);
    assert.equal(afterLock.sceneContext, undefined,
      "写权限已被收回的上传者不应该继续拿到编辑用的 sceneContext");
  } finally { f.close(); }
});

test("安全边界：公开的、仅供已确认照片使用的 viewer scene-context 路由完全不受影响", async () => {
  const f = fixture();
  try {
    const owner = await f.login("scene-fix-boundary@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    space = await activatePanorama(f, owner, space);
    const { flow } = await needsConfirmationPhoto(f, owner, space);

    // 即使是空间主人本人，走"纯 viewer" 路由(而不是位置编辑器的授权路由)去拿同一张未确认
    // 照片的场景数据，仍然必须 404 —— editorSceneContext() 从未挂到这条公开路由上。
    const viewerAttempt = await f.call("GET",
      `/v1/viewer/spaces/${space.spaceId}/photos/${flow.committed.photoId}/scene-context`, {}, owner.headers);
    assert.equal(viewerAttempt.status, 404);
    assert.equal(viewerAttempt.body.error.code, "photo_scene_unavailable");

    // 无权限的陌生账号连编辑器本身都进不去 —— managerOrReceipt() 的授权检查在
    // editorSceneContext() 被调用之前就已经把请求挡下来了。
    const stranger = await f.login("scene-fix-stranger@example.test");
    const strangerAttempt = await f.call("GET", `/v1/photos/${flow.committed.photoId}/placement-edit`, {}, stranger.headers);
    assert.ok([403, 404].includes(strangerAttempt.status), `陌生账号应该被拒绝，实际拿到 ${strangerAttempt.status}`);
  } finally { f.close(); }
});

test("空间还没有就绪的全景时，editView() 优雅地省略 sceneContext 而不是报错", async () => {
  const f = fixture();
  try {
    const owner = await f.login("scene-fix-no-panorama@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space); // 故意不调用 activatePanorama()
    const { flow } = await needsConfirmationPhoto(f, owner, space);

    const edit = await f.ok("GET", `/v1/photos/${flow.committed.photoId}/placement-edit`, {}, owner.headers);
    assert.equal(edit.sceneContext, undefined,
      "没有可用全景时应该优雅缺省(不出现 sceneContext 字段)，而不是让整个编辑器读取报错");
  } finally { f.close(); }
});
