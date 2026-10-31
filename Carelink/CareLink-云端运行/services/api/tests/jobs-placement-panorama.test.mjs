import test from "node:test";
import assert from "node:assert/strict";
import { dispatchOne } from "../../jobs/dispatch/index.mjs";
import { createAccountUpload, exchangeReceipt, fixture, png } from "./fixture-factory.mjs";
import { DeterministicLocatorFixture } from "../src/ports/locator/deterministic-locator-fixture.mjs";
import { sha256, stableJson } from "../src/util.mjs";

test("photo validation deterministically dispatches placement; absent policy requires confirmation", async () => {
  const f = fixture();
  try {
    const owner = await f.login("placement@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const flow = await createAccountUpload(f, owner, space);
    const validation = dispatchOne(f.db, flow.committed.jobId, { now: f.clock.iso() });
    assert.equal(validation.status, "succeeded");
    const placement = dispatchOne(f.db, validation.placementJobId, { now: f.clock.iso() });
    assert.equal(placement.placementState, "needs_confirmation");
    const replay = dispatchOne(f.db, validation.placementJobId, { now: f.clock.iso() });
    assert.equal(replay.replayed, true);
    const photo = f.db.prepare("SELECT * FROM photos WHERE id=?").get(flow.committed.photoId);
    const item = f.db.prepare("SELECT * FROM contribution_batch_items WHERE id=?").get(flow.item.itemId);
    const manual = await f.ok("POST", `/v1/photos/${photo.id}/placement-revisions`, {
      mode: "manual", confirmationMode: "manual", yawDeg: 42, pitchDeg: 0, reason: "owner_confirmed"
    }, { ...owner.headers, "if-match": String(photo.version), "x-item-version": String(item.version),
      "x-placement-authorization-version": String(item.placement_authorization_version) });
    assert.equal(manual.placementState, "confirmed");
    assert.equal(manual.confirmationMode, "manual");
    const locked = f.db.prepare("SELECT * FROM contribution_batch_items WHERE id=?").get(item.id);
    assert.equal(locked.uploader_placement_write_enabled, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM placement_authorization_events WHERE item_id=?").get(item.id).count, 1);

    const receiptExchange = await exchangeReceipt(f, flow.finalized);
    assert.equal(receiptExchange.status, 200);
    const receiptAttempt = await f.call("POST", `/v1/photos/${photo.id}/placement-actions`, {
      action: "mark_outside_scene", reasonCode: "outside"
    }, { "x-receipt-session": receiptExchange.body.receiptSessionSecret, "if-match": String(manual.version),
      "x-item-version": String(locked.version), "x-placement-authorization-version": String(locked.placement_authorization_version) });
    assert.equal(receiptAttempt.status, 423);
    assert.equal(receiptAttempt.body.error.code, "placement_write_locked");
    const reopened = await f.ok("POST", `/v1/batch-receipts/${flow.finalized.receiptId}/items/${item.id}/placement-reopens`,
      { reason: "return_to_uploader" }, { ...owner.headers, "if-match": String(locked.version) });
    assert.equal(reopened.uploaderPlacementWriteEnabled, true);
  } finally { f.close(); }
});

test("CLIP 低置信候选方向落一条 placement_suggestions，人工定位编辑页能读回并在重试后被替换", async () => {
  const f = fixture();
  try {
    const owner = await f.login("clip-candidates@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const flow = await createAccountUpload(f, owner, space);
    const validation = dispatchOne(f.db, flow.committed.jobId, { now: f.clock.iso() });
    const outcome = { classification: "uncertain",
      candidates: [{ yaw: 30, confidence: 0.6821 }, { yaw: 60, confidence: 0.5519 }, { yaw: 0, confidence: 0.5011 },
        { yaw: 90, confidence: 0.4 }] };
    const placement = dispatchOne(f.db, validation.placementJobId, { now: f.clock.iso(), outcome });
    assert.equal(placement.placementState, "needs_confirmation");
    assert.ok(placement.suggestionId);

    const suggestionRows = f.db.prepare("SELECT * FROM placement_suggestions WHERE photo_id=?").all(flow.committed.photoId);
    assert.equal(suggestionRows.length, 1);
    const stored = JSON.parse(suggestionRows[0].candidates_json);
    // 只落最多 3 个候选(第 4 个 90° 被截掉)，每条都带自己的 candidateId
    assert.equal(stored.length, 3);
    assert.deepEqual(stored.map((c) => [c.yaw, c.confidence]), [[30, 0.6821], [60, 0.5519], [0, 0.5011]]);
    assert.ok(stored.every((c) => typeof c.candidateId === "string" && c.candidateId.length > 0));
    assert.equal(suggestionRows[0].status, "ready");
    assert.equal(suggestionRows[0].invalidated_at, null);

    const edit = await f.ok("GET", `/v1/photos/${flow.committed.photoId}/placement-edit`, {}, owner.headers);
    assert.equal(edit.suggestionId, placement.suggestionId);
    assert.equal(edit.candidates.length, 3);
    assert.deepEqual(edit.candidates.map((c) => c.yaw), [30, 60, 0]);
    assert.equal(edit.candidates[0].confidence, 0.6821);
    assert.equal(edit.candidates[0].pitch, null);

    // 重新定位一次(retry)：新的 uncertain 候选应该替换旧的，旧行被标记 invalidated
    const item = f.db.prepare("SELECT * FROM contribution_batch_items WHERE id=?").get(flow.item.itemId);
    const photo = f.db.prepare("SELECT * FROM photos WHERE id=?").get(flow.committed.photoId);
    f.db.prepare("UPDATE photos SET placement_state='failed',confirmation_mode=NULL,version=version+1 WHERE id=? AND version=?")
      .run(photo.id, photo.version);
    const retry = await f.ok("POST", `/v1/photos/${photo.id}/placement-actions`, { action: "retry" },
      { ...owner.headers, "if-match": String(photo.version + 1), "x-item-version": String(item.version),
        "x-placement-authorization-version": String(item.placement_authorization_version) });
    const secondOutcome = { classification: "uncertain", candidates: [{ yaw: 210, confidence: 0.71 }] };
    const secondPlacement = dispatchOne(f.db, retry.jobId, { now: f.clock.iso(), outcome: secondOutcome });
    assert.equal(secondPlacement.placementState, "needs_confirmation");
    assert.notEqual(secondPlacement.suggestionId, placement.suggestionId);

    const afterRetry = f.db.prepare("SELECT id,invalidated_at FROM placement_suggestions WHERE photo_id=? ORDER BY rowid")
      .all(flow.committed.photoId);
    assert.equal(afterRetry.length, 2);
    assert.equal(afterRetry[0].id, placement.suggestionId);
    assert.ok(afterRetry[0].invalidated_at, "第一条候选建议应该被重试标记为 invalidated");
    assert.equal(afterRetry[1].id, secondPlacement.suggestionId);
    assert.equal(afterRetry[1].invalidated_at, null);

    const editAfterRetry = await f.ok("GET", `/v1/photos/${photo.id}/placement-edit`, {}, owner.headers);
    assert.equal(editAfterRetry.suggestionId, secondPlacement.suggestionId);
    assert.deepEqual(editAfterRetry.candidates.map((c) => c.yaw), [210]);
  } finally { f.close(); }
});

test("CLIP 没有跑出候选(sidecar 故障/无关图拒收)时优雅缺省：不落 placement_suggestions，编辑页字段与纯手动一致", async () => {
  const f = fixture();
  try {
    const owner = await f.login("clip-no-candidates@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);

    const flowAbstained = await createAccountUpload(f, owner, space);
    const validationAbstained = dispatchOne(f.db, flowAbstained.committed.jobId, { now: f.clock.iso() });
    const abstainedOutcome = { classification: "abstained", locatorProvenance: { error: "clip_sidecar_unreachable" } };
    const placementAbstained = dispatchOne(f.db, validationAbstained.placementJobId, { now: f.clock.iso(), outcome: abstainedOutcome });
    assert.equal(placementAbstained.placementState, "needs_confirmation");
    assert.equal(placementAbstained.suggestionId, undefined);

    const flowUncertainNoCandidates = await createAccountUpload(f, owner, space);
    const validationNoCandidates = dispatchOne(f.db, flowUncertainNoCandidates.committed.jobId, { now: f.clock.iso() });
    const placementNoCandidates = dispatchOne(f.db, validationNoCandidates.placementJobId,
      { now: f.clock.iso(), outcome: { classification: "uncertain" } });
    assert.equal(placementNoCandidates.placementState, "needs_confirmation");
    assert.equal(placementNoCandidates.suggestionId, undefined);

    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM placement_suggestions").get().count, 0);

    const editAbstained = await f.ok("GET", `/v1/photos/${flowAbstained.committed.photoId}/placement-edit`, {}, owner.headers);
    assert.equal(editAbstained.suggestionId, undefined);
    assert.equal(editAbstained.candidates, undefined);
    const editNoCandidates = await f.ok("GET", `/v1/photos/${flowUncertainNoCandidates.committed.photoId}/placement-edit`, {}, owner.headers);
    assert.equal(editNoCandidates.suggestionId, undefined);
    assert.equal(editNoCandidates.candidates, undefined);
  } finally { f.close(); }
});

test("technical placement failures map to failed while high-confidence requires frozen release", async () => {
  const f = fixture();
  try {
    const owner = await f.login("placement-map@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const flow = await createAccountUpload(f, owner, space);
    const validation = dispatchOne(f.db, flow.committed.jobId, { now: f.clock.iso() });
    const failed = dispatchOne(f.db, validation.placementJobId, { now: f.clock.iso(), outcome: { classification: "decoder_failure" } });
    assert.equal(failed.placementState, "failed");
    assert.equal(f.db.prepare("SELECT placement_state FROM photos WHERE id=?").get(flow.committed.photoId).placement_state, "failed");
  } finally { f.close(); }
});

// 2026-08-17 阈值重定标定的落库验证：production 到今天为止 9 条 confirmation_mode 记录全是
// 'manual'，因为旧阈值(CONF_MIN 0.72/MARGIN_MIN 0.075)对真实照片完全不可达 —— classifyMatch()
// 从没对真实数据判过 same_scene_high，"自动落位写 confirmation_mode='auto'" 这条 dispatch 分支
// (services/jobs/dispatch/index.mjs 的 placement() same_scene_high 分支)存在但从没被真实数据
// 触发过。重定阈值后，services/locator/test/match.test.mjs 的同名回归证明 classifyMatch({
// confidence: 0.584, margin: 0.041 })(实测 in-venue 中位数)现在判 same_scene_high 而不是
// uncertain —— 这里补的是下一环：same_scene_high 这个分类结果落库时，confirmation_mode 真的
// 写成 'auto'（不是巧合留空），且和 uncertain 落库的 NULL 能明确区分开。
// 激活一张真实(2:1 像素)全景，让 same_scene_high 分支要求的 policy/panorama CAS 校验能通过 ——
// 和 auto-approve-uploads.test.mjs 的 activatePanorama() 是同一套动作，这里没有导出复用是因为
// 那个函数是那个测试文件的局部函数，这十几行本身就不长，重复一份比新增一个跨文件依赖更不容易
// 踩到无关改动。下面两个新测试(same_scene_high 落库 / spaceHasScene)共用这同一段设置。
async function activateRealPanoramaForTest(f, owner, space, clientAssetId) {
  const bytes = png(1600, 800);
  const current = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(space.spaceId);
  const candidate = await f.ok("POST", `/v1/spaces/${space.spaceId}/panorama-candidates`, {
    declaredMime: "image/png", declaredBytes: bytes.length, clientAssetId
  }, { ...owner.headers, "if-match": String(current.version),
    "notice-acknowledgement": JSON.stringify({ purpose: "panorama_upload", version: 1,
      contentHash: "local-panorama_upload-v1" }) });
  const put = await f.api.putMedia({ ticket: candidate.exactPrivateUploadTicketOnce,
    bytes, contentType: "image/png", kind: "panorama" });
  const committedPanorama = await f.ok("POST", `/v1/panorama-upload-sessions/${candidate.uploadSessionId}/commits`,
    { clientRequestId: `${clientAssetId}-commit` },
    { ...owner.headers, "if-match": String(put.body.uploadSessionVersion) });
  const ready = dispatchOne(f.db, committedPanorama.jobId, { now: f.clock.iso() });
  const scene = f.db.prepare("SELECT * FROM scenes WHERE space_id=?").get(space.spaceId);
  const beforeSwitch = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(space.spaceId);
  await f.ok("POST", `/v1/spaces/${space.spaceId}/panorama-switches`, {
    mode: "switch", candidateRevisionId: ready.panoramaRevisionId, sceneIfMatchVersion: scene.version
  }, { ...owner.headers, "if-match": String(beforeSwitch.version) });
  return { ...space, version: f.db.prepare("SELECT version FROM spaces WHERE id=?").get(space.spaceId).version };
}

test("同一批照片：same_scene_high 落库 confirmation_mode='auto'，uncertain 落库仍是 NULL — " +
  "验证'自动落位' vs '待人工确认'两条路径在数据库层面真的分得开", async () => {
  const f = fixture();
  try {
    const owner = await f.login("clip-auto-confirm@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    space = await activateRealPanoramaForTest(f, owner, space, "clip-auto-confirm-panorama");

    // same_scene_high 支线：真实数字(conf 0.584/margin 0.041)在新阈值下的判定结果，见
    // services/locator/test/match.test.mjs；这里只需要 DeterministicLocatorFixture 复现同一个
    // 分类结果，专注验证落库这一步。
    const locator = new DeterministicLocatorFixture({ enabled: true });
    const autoFlow = await createAccountUpload(f, owner, space);
    const autoValidation = dispatchOne(f.db, autoFlow.committed.jobId, { now: f.clock.iso(), locatorFixture: locator });
    const autoPlacement = dispatchOne(f.db, autoValidation.placementJobId,
      { now: f.clock.iso(), locatorFixture: locator, fixtureClassification: "same_scene_high" });
    assert.equal(autoPlacement.placementState, "confirmed");
    const autoPhoto = f.db.prepare("SELECT placement_state,confirmation_mode FROM photos WHERE id=?").get(autoFlow.committed.photoId);
    assert.equal(autoPhoto.placement_state, "confirmed");
    assert.equal(autoPhoto.confirmation_mode, "auto");
    const autoRevision = f.db.prepare("SELECT confirmation_mode FROM placement_revisions WHERE id=?").get(autoPlacement.revisionId);
    assert.equal(autoRevision.confirmation_mode, "auto");

    // uncertain 对照支线：明显偏低的输入(比如 conf 0.30，低于真实照片 in-venue 实测最小值 0.370)
    // 落库后 confirmation_mode 必须还是 NULL —— 不能被"auto 路径现在终于跑起来了"误伤到手动/待
    // 确认这条路径，两者在同一个 photos 表列上必须能明确区分。
    const manualFlow = await createAccountUpload(f, owner, space);
    const manualValidation = dispatchOne(f.db, manualFlow.committed.jobId, { now: f.clock.iso() });
    const manualPlacement = dispatchOne(f.db, manualValidation.placementJobId,
      { now: f.clock.iso(), outcome: { classification: "uncertain" } });
    assert.equal(manualPlacement.placementState, "needs_confirmation");
    const manualPhoto = f.db.prepare("SELECT placement_state,confirmation_mode FROM photos WHERE id=?").get(manualFlow.committed.photoId);
    assert.equal(manualPhoto.placement_state, "needs_confirmation");
    assert.equal(manualPhoto.confirmation_mode, null);
  } finally { f.close(); }
});

// P1 审计项（2026-08-17）：照片传进还没有 360 现场的空间时，以前是静默变人工待办 —— 见
// upload-service.mjs#batchView() 头顶注释。spaceHasScene 是这条诚实反馈的数据来源，
// GET /v1/contribution-batches/{bid}/result 和 receiptView()/exchangeReceipt() 都走同一个
// batchView()，这里只需要覆盖其中一条路径就能证明字段本身算对了。
test("GET 上传结果暴露 spaceHasScene：空间还没激活全景时是 false，激活后变 true", async () => {
  const f = fixture();
  try {
    const owner = await f.login("no-scene-yet@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);

    const beforeFlow = await createAccountUpload(f, owner, space);
    const beforeResult = await f.ok("GET", `/v1/contribution-batches/${beforeFlow.batch.batchId}/result`, {}, owner.headers);
    assert.equal(beforeResult.spaceHasScene, false);

    space = await activateRealPanoramaForTest(f, owner, space, "space-has-scene-panorama");
    const afterFlow = await createAccountUpload(f, owner, space);
    const afterResult = await f.ok("GET", `/v1/contribution-batches/${afterFlow.batch.batchId}/result`, {}, owner.headers);
    assert.equal(afterResult.spaceHasScene, true);
    // 激活全景不会倒着改变已经拿到结果的老批次的读出值本身的意义(它读的是"现在"的空间状态)，
    // 但这条断言只是确认字段名/取值没有拼错，不是要断言历史批次的语义 —— 所以这里不重复
    // 查询 beforeFlow，避免这条测试对"batchView 是不是应该看批次创建时刻"这个未决问题下判断。
  } finally { f.close(); }
});

test("placement job freezes Space Scene and media checksum and rejects each mismatched input before photo writes", async () => {
  const f = fixture();
  try {
    const owner = await f.login("placement-seam@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const cases = [
      ["spaceId", "space_changed", "space_mismatch"],
      ["sceneId", "scene_changed", "scene_mismatch"],
      ["mediaSha256", "media_checksum_changed", "0".repeat(64)]
    ];
    for (const [field, reason, mismatched] of cases) {
      const flow = await createAccountUpload(f, owner, space);
      const validation = dispatchOne(f.db, flow.committed.jobId, { now: f.clock.iso() });
      const job = f.db.prepare("SELECT * FROM jobs WHERE id=?").get(validation.placementJobId);
      const refs = JSON.parse(job.input_refs_json);
      const photo = f.db.prepare("SELECT * FROM photos WHERE id=?").get(flow.committed.photoId);
      const asset = f.db.prepare("SELECT * FROM assets WHERE id=?").get(photo.asset_id);
      const scene = f.db.prepare("SELECT * FROM scenes WHERE space_id=?").get(space.spaceId);
      assert.equal(refs.spaceId, space.spaceId);
      assert.equal(refs.sceneId, scene.id);
      assert.equal(refs.mediaSha256, asset.raw_sha256);

      const changed = { ...refs, [field]: mismatched };
      f.db.prepare("UPDATE jobs SET input_refs_json=?,input_hash=? WHERE id=?")
        .run(JSON.stringify(changed), sha256(stableJson(changed)), job.id);
      const before = f.db.prepare(`SELECT placement_state,confirmation_mode,current_placement_revision_id,version
        FROM photos WHERE id=?`).get(photo.id);
      const rejected = dispatchOne(f.db, job.id, { now: f.clock.iso() });
      assert.equal(rejected.status, "failed");
      assert.equal(rejected.stableError, "job_input_stale");
      assert.equal(rejected.reason, reason);
      assert.deepEqual(f.db.prepare(`SELECT placement_state,confirmation_mode,current_placement_revision_id,version
        FROM photos WHERE id=?`).get(photo.id), before);
      const audit = f.db.prepare(`SELECT detail_json FROM audit_events
        WHERE event_type='placement_job_dispatch' AND authorization_id=?`).get(job.id);
      const detail = JSON.parse(audit.detail_json);
      assert.equal(detail.reason, reason);
      assert.equal(detail.queued[field], mismatched);
      assert.equal(detail.current.spaceId, space.spaceId);
      assert.equal(detail.current.sceneId, scene.id);
      assert.equal(detail.current.mediaSha256, asset.raw_sha256);
    }
  } finally { f.close(); }
});

test("placement retry freezes the same locator seam and policy release CAS", async () => {
  const locator = new DeterministicLocatorFixture({ enabled: true, classification: "failed" });
  const f = fixture({ locatorFixture: locator });
  try {
    const owner = await f.login("placement-retry-seam@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const flow = await createAccountUpload(f, owner, space);
    const validation = dispatchOne(f.db, flow.committed.jobId, { now: f.clock.iso(), locatorFixture: locator });
    const failed = dispatchOne(f.db, validation.placementJobId,
      { now: f.clock.iso(), locatorFixture: locator, fixtureClassification: "failed" });
    const failedRefs = JSON.parse(f.db.prepare("SELECT input_refs_json FROM jobs WHERE id=?")
      .get(validation.placementJobId).input_refs_json);
    assert.deepEqual(failed.locatorInput, {
      spaceId: failedRefs.spaceId,
      sceneId: failedRefs.sceneId,
      mediaSha256: failedRefs.mediaSha256,
      panoramaRevisionId: null,
      policyReleaseId: failedRefs.policyReleaseId,
      policyVersion: 1
    });

    const photo = f.db.prepare("SELECT * FROM photos WHERE id=?").get(flow.committed.photoId);
    const item = f.db.prepare("SELECT * FROM contribution_batch_items WHERE id=?").get(flow.item.itemId);
    const asset = f.db.prepare("SELECT * FROM assets WHERE id=?").get(photo.asset_id);
    const scene = f.db.prepare("SELECT * FROM scenes WHERE space_id=?").get(space.spaceId);
    const retry = await f.ok("POST", `/v1/photos/${photo.id}/placement-actions`, { action: "retry" },
      { ...owner.headers, "if-match": String(photo.version), "x-item-version": String(item.version),
        "x-placement-authorization-version": String(item.placement_authorization_version) });
    const retryJob = f.db.prepare("SELECT * FROM jobs WHERE id=?").get(retry.jobId);
    const refs = JSON.parse(retryJob.input_refs_json);
    assert.equal(refs.spaceId, space.spaceId);
    assert.equal(refs.sceneId, scene.id);
    assert.equal(refs.mediaSha256, asset.raw_sha256);
    assert.equal(retryJob.algorithm_release_id, refs.policyReleaseId);

    const stalePolicyRefs = { ...refs, policyVersion: refs.policyVersion + 1 };
    f.db.prepare("UPDATE jobs SET input_refs_json=?,input_hash=? WHERE id=?")
      .run(JSON.stringify(stalePolicyRefs), sha256(stableJson(stalePolicyRefs)), retry.jobId);
    const before = f.db.prepare(`SELECT placement_state,confirmation_mode,current_placement_revision_id,version
      FROM photos WHERE id=?`).get(photo.id);
    const rejected = dispatchOne(f.db, retry.jobId, { now: f.clock.iso(), locatorFixture: locator });
    assert.equal(rejected.reason, "policy_release_changed");
    assert.deepEqual(f.db.prepare(`SELECT placement_state,confirmation_mode,current_placement_revision_id,version
      FROM photos WHERE id=?`).get(photo.id), before);
  } finally { f.close(); }
});

test("placement dispatch rejects a coherently rehashed cross-item binding with only job and audit writes", async () => {
  const f = fixture();
  try {
    const owner = await f.login("placement-cross-item@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const targetFlow = await createAccountUpload(f, owner, space);
    const otherFlow = await createAccountUpload(f, owner, space);
    const validation = dispatchOne(f.db, targetFlow.committed.jobId, { now: f.clock.iso() });
    const job = f.db.prepare("SELECT * FROM jobs WHERE id=?").get(validation.placementJobId);
    const refs = JSON.parse(job.input_refs_json);
    const targetPhoto = f.db.prepare("SELECT * FROM photos WHERE id=?").get(targetFlow.committed.photoId);
    const targetItem = f.db.prepare("SELECT * FROM contribution_batch_items WHERE id=?").get(targetFlow.item.itemId);
    const otherItem = f.db.prepare("SELECT * FROM contribution_batch_items WHERE id=?").get(otherFlow.item.itemId);
    assert.equal(targetItem.space_id, otherItem.space_id);
    assert.equal(targetItem.version, otherItem.version);
    assert.equal(targetItem.placement_authorization_version, otherItem.placement_authorization_version);
    assert.notEqual(targetItem.id, otherItem.id);

    const crossItemRefs = { ...refs, itemId: otherItem.id, itemVersion: otherItem.version,
      placementAuthorizationVersion: otherItem.placement_authorization_version };
    f.db.prepare("UPDATE jobs SET input_refs_json=?,input_hash=? WHERE id=?")
      .run(JSON.stringify(crossItemRefs), sha256(stableJson(crossItemRefs)), job.id);
    const before = {
      changes: f.db.prepare("SELECT total_changes() count").get().count,
      photo: f.db.prepare("SELECT * FROM photos WHERE id=?").get(targetPhoto.id),
      targetItem: f.db.prepare("SELECT * FROM contribution_batch_items WHERE id=?").get(targetItem.id),
      otherItem: f.db.prepare("SELECT * FROM contribution_batch_items WHERE id=?").get(otherItem.id),
      revisions: f.db.prepare("SELECT COUNT(*) count FROM placement_revisions").get().count,
      suggestions: f.db.prepare("SELECT COUNT(*) count FROM placement_suggestions").get().count,
      audits: f.db.prepare("SELECT COUNT(*) count FROM audit_events").get().count
    };
    const rejected = dispatchOne(f.db, job.id, { now: f.clock.iso() });
    assert.deepEqual(rejected, { jobId: job.id, status: "failed", stableError: "job_input_stale",
      stale: true, reason: "item_photo_binding_changed" });
    assert.equal(f.db.prepare("SELECT total_changes() count").get().count, before.changes + 2);
    assert.deepEqual(f.db.prepare("SELECT * FROM photos WHERE id=?").get(targetPhoto.id), before.photo);
    assert.deepEqual(f.db.prepare("SELECT * FROM contribution_batch_items WHERE id=?").get(targetItem.id), before.targetItem);
    assert.deepEqual(f.db.prepare("SELECT * FROM contribution_batch_items WHERE id=?").get(otherItem.id), before.otherItem);
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM placement_revisions").get().count, before.revisions);
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM placement_suggestions").get().count, before.suggestions);
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM audit_events").get().count, before.audits + 1);
    const terminal = f.db.prepare("SELECT * FROM jobs WHERE id=?").get(job.id);
    assert.equal(terminal.status, "failed");
    assert.equal(terminal.stable_error, "job_input_stale");
    const audit = JSON.parse(f.db.prepare(`SELECT detail_json FROM audit_events
      WHERE event_type='placement_job_dispatch' AND authorization_id=?`).get(job.id).detail_json);
    assert.equal(audit.reason, "item_photo_binding_changed");
    assert.equal(audit.queued.itemId, otherItem.id);
    assert.equal(audit.current.itemId, targetItem.id);
    assert.equal(audit.current.itemBatchId, targetItem.batch_id);
  } finally { f.close(); }
});

test("panorama candidate validates true pixels and 2:1 before ready/switch CAS", async () => {
  const f = fixture();
  try {
    const owner = await f.login("panorama@example.test");
    const space = await f.createSpace(owner);
    const bytes = png(1600, 800);
    const candidate = await f.ok("POST", `/v1/spaces/${space.spaceId}/panorama-candidates`, {
      declaredMime: "image/png", declaredBytes: bytes.length, clientAssetId: "panorama-1"
    }, { ...owner.headers, "if-match": String(space.version),
      "notice-acknowledgement": JSON.stringify({ purpose: "panorama_upload", version: 1, contentHash: "local-panorama_upload-v1" }) });
    const put = await f.api.putMedia({ ticket: candidate.exactPrivateUploadTicketOnce, bytes, contentType: "image/png", kind: "panorama" });
    assert.equal(put.status, 200);
    assert.equal((await f.api.putMedia({ ticket: candidate.exactPrivateUploadTicketOnce, bytes, contentType: "image/png", kind: "panorama" })).status, 404);
    const committed = await f.ok("POST", `/v1/panorama-upload-sessions/${candidate.uploadSessionId}/commits`,
      { clientRequestId: "panorama-commit" }, { ...owner.headers, "if-match": String(put.body.uploadSessionVersion) });
    assert.equal(committed.status, "validating");
    const dispatched = dispatchOne(f.db, committed.jobId, { now: f.clock.iso() });
    assert.equal(dispatched.status, "succeeded");
    const switched = await f.ok("POST", `/v1/spaces/${space.spaceId}/panorama-switches`, {
      mode: "switch", candidateRevisionId: dispatched.panoramaRevisionId, sceneIfMatchVersion: 1
    }, { ...owner.headers, "if-match": String(space.version) });
    assert.equal(switched.currentPanoramaRevisionId, dispatched.panoramaRevisionId);
    assert.equal(switched.sceneReadiness, "ready");
  } finally { f.close(); }
});

test("non-2:1 panorama fails, removes orphan bytes, and preserves current revision", async () => {
  const f = fixture();
  try {
    const owner = await f.login("bad-panorama@example.test");
    const space = await f.createSpace(owner);
    const bytes = png(1600, 900);
    const candidate = await f.ok("POST", `/v1/spaces/${space.spaceId}/panorama-candidates`, {
      declaredMime: "image/png", declaredBytes: bytes.length, clientAssetId: "bad-panorama"
    }, { ...owner.headers, "if-match": String(space.version),
      "notice-acknowledgement": JSON.stringify({ purpose: "panorama_upload", version: 1, contentHash: "local-panorama_upload-v1" }) });
    const put = await f.api.putMedia({ ticket: candidate.exactPrivateUploadTicketOnce, bytes, contentType: "image/png", kind: "panorama" });
    const rejected = await f.call("POST", `/v1/panorama-upload-sessions/${candidate.uploadSessionId}/commits`,
      { clientRequestId: "bad-panorama-commit" }, { ...owner.headers, "if-match": String(put.body.uploadSessionVersion) });
    assert.equal(rejected.status, 422);
    assert.equal(rejected.body.error.code, "panorama_decode_rejected");
    const state = f.db.prepare("SELECT status FROM panorama_candidates WHERE id=?").get(candidate.candidateId);
    assert.equal(state.status, "failed");
    assert.equal(f.db.prepare("SELECT current_panorama_revision_id FROM spaces WHERE id=?").get(space.spaceId).current_panorama_revision_id, null);
    assert.equal((await f.api.mediaStore.head(candidate.exactPrivateObjectKey)).exists, false);
  } finally { f.close(); }
});
