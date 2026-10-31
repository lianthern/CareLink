import { assert } from "./errors.mjs";
import { id, json, parseJson } from "./util.mjs";
import { object, SCOPES } from "./schemas.mjs";

const transitions = {
  manual_approved: { from: ["pending"], to: "visible", decisions: [] },
  manual_hidden: { from: ["pending", "visible"], to: "hidden", decisions: ["safety_hold", "privacy_request", "rights_concern", "quality_or_duplicate", "abusive_or_illegal", "rights_violation", "other"] },
  manual_rejected: { from: ["pending", "visible", "hidden"], to: "rejected", decisions: ["abusive_or_illegal", "rights_violation", "unrelated_content", "repeated_violation", "rights_concern", "quality_or_duplicate", "other"] },
  manual_restored: { from: ["hidden"], to: "visible", decisions: ["appeal_upheld", "review_corrected", "issue_resolved", "new_evidence", "other"] },
  manual_reopened: { from: ["rejected"], to: "pending", decisions: ["uploader_appeal", "reviewer_correction", "new_evidence", "other"] }
};

export class PlacementService {
  constructor(core, jobs, viewerMedia) {
    this.core = core;
    this.db = core.db;
    this.jobs = jobs;
    this.viewerMedia = viewerMedia;
  }

  managerOrReceipt(ctx, photo, scope = "canEditPlacement") {
    const item = this.core.one("SELECT * FROM contribution_batch_items WHERE id=? AND batch_id=? AND space_id=?",
      photo.batch_item_id, photo.batch_id, photo.space_id);
    assert(item && !item.revoked_at && !item.deleted_at, "placement_action_unavailable", 404);
    if (ctx.receiptSession) {
      const receipt = this.core.receipt(ctx.receiptSession);
      assert(receipt.batch.id === item.batch_id && receipt.space.id === item.space_id && item.uploader_placement_write_enabled === 1,
        "placement_write_locked", 423);
      return { actor: receipt, item, manager: false, authKind: "receipt_session", authorizationId: receipt.session.id };
    }
    const account = this.core.account(ctx.accountSession);
    const access = this.core.accountSpace(account, photo.space_id, { scope });
    return { actor: account, item, manager: true, authKind: access.authKind, authorizationId: access.authorizationId, access };
  }

  getPhoto(photoId) {
    const photo = this.core.one("SELECT * FROM photos WHERE id=? AND deleted_at IS NULL", photoId);
    assert(photo, "placement_action_unavailable", 404);
    return photo;
  }

  editView(ctx, photoId) {
    const photo = this.getPhoto(photoId);
    const auth = this.managerOrReceipt(ctx, photo);
    const space = this.core.one("SELECT * FROM spaces WHERE id=?", photo.space_id);
    const scene = this.core.one("SELECT * FROM scenes WHERE space_id=?", photo.space_id);
    // A v2 ("疑似待复核"编辑器的 360 预览缺口修复): managerOrReceipt() above already gated this
    // whole call to a manager with canEditPlacement, or an uploader whose item still has
    // uploader_placement_write_enabled — exactly the two principals editorSceneContext() expects
    // (see its own comment). Unlike sceneContext()/photoState(), it doesn't require the photo's
    // own placement to be confirmed, so a needs_confirmation/failed photo — the entire reason this
    // editor exists — now gets a real scene preview instead of "现场资源不可用或已过期".
    let sceneContext = null;
    try { sceneContext = this.viewerMedia.editorSceneContext(photo.space_id, photoId); } catch { sceneContext = null; }
    return { photoId, placementState: photo.placement_state, confirmationMode: photo.confirmation_mode,
      photoVersion: photo.version, itemVersion: auth.item.version, placementAuthorizationVersion: auth.item.placement_authorization_version,
      currentPanoramaRevisionId: space.current_panorama_revision_id, sceneReadiness: scene.scene_readiness,
      canEditPlacement: !auth.manager ? Boolean(auth.item.uploader_placement_write_enabled) : true,
      ...(sceneContext ? { sceneContext } : {}),
      ...this.suggestionView(photo, space) };
  }

  // Backs the photoMedia URL editorSceneContext() puts in the sceneContext it returns above
  // (and the one UploadService#receiptItem() returns for the uploader path) — see that method's
  // comment for why the target photo's own bytes can't be served through the general-purpose,
  // confirmed-only /v1/viewer/.../photos/{pid}/media route. Authorized identically to editView()
  // itself (managerOrReceipt()); byte-serving mechanics (range/etag/hash) are unchanged, just
  // delegated to ViewerMediaService#serve(), which never cared about placement confirmation.
  editorMedia(ctx, photoId) {
    const photo = this.getPhoto(photoId);
    const auth = this.managerOrReceipt(ctx, photo);
    const asset = this.core.one(`SELECT * FROM assets WHERE id=? AND space_id=?
      AND kind='photo_viewer_safe' AND validation_state='valid' AND metadata_policy_result='exif_gps_stripped'`,
    photo.viewer_safe_asset_id, photo.space_id);
    assert(asset, "media_unavailable", 404);
    return this.viewerMedia.serve(ctx, { photo: photo.version, item: auth.item.version, asset: asset.version }, asset, () => {
      this.managerOrReceipt(ctx, this.getPhoto(photoId));
      const current = this.core.one("SELECT viewer_safe_asset_id FROM photos WHERE id=? AND deleted_at IS NULL", photoId);
      assert(current?.viewer_safe_asset_id === asset.id, "media_unavailable", 404);
    });
  }

  /** 低置信转人工时，dispatch/index.mjs 的 placement() 会落一条 placement_suggestions
   * (见该文件注释)；这里把它读出来投影给编辑页当"AI 候选方向"。没有候选、或候选是给
   * 另一个全景版本算的(现场换过)，都老实回空对象 —— 页面就按现状渲染，不出候选区。 */
  suggestionView(photo, space) {
    const suggestion = this.core.one(`SELECT * FROM placement_suggestions
      WHERE photo_id=? AND invalidated_at IS NULL ORDER BY rowid DESC LIMIT 1`, photo.id);
    if (!suggestion || suggestion.panorama_revision_id !== space.current_panorama_revision_id) return {};
    const candidates = parseJson(suggestion.candidates_json, [])
      .filter((candidate) => Number.isFinite(Number(candidate.yaw)) && Number.isFinite(Number(candidate.confidence)))
      .map((candidate) => ({ candidateId: candidate.candidateId, yaw: Number(candidate.yaw),
        pitch: candidate.pitch == null ? null : Number(candidate.pitch), confidence: Number(candidate.confidence) }));
    if (!candidates.length) return {};
    return { suggestionId: suggestion.id, candidates };
  }

  revision(ctx, photoId) {
    const body = object(ctx.body, ["mode", "suggestionId", "candidateId", "confirmationMode", "yawDeg", "pitchDeg", "regionId", "reason", "panoramaRevisionId"],
      ["mode", "confirmationMode"]);
    assert(["manual", "candidate"].includes(body.mode) && body.confirmationMode === "manual", "placement_action_unavailable", 409);
    const photo = this.getPhoto(photoId);
    const auth = this.managerOrReceipt(ctx, photo);
    return this.core.mutation(ctx, { endpoint: `/v1/photos/${photoId}/placement-revisions`, scope: auth.authorizationId,
      reauthorize: () => this.managerOrReceipt(ctx, this.getPhoto(photoId)) }, () => {
      this.core.requireIfMatch(ctx, photo);
      if (Object.hasOwn(body, "panoramaRevisionId")) {
        const current = this.core.one("SELECT current_panorama_revision_id FROM spaces WHERE id=?", photo.space_id);
        assert(typeof body.panoramaRevisionId === "string" && body.panoramaRevisionId &&
          body.panoramaRevisionId === current?.current_panorama_revision_id, "stale_revision", 409);
      }
      assert(Number(ctx.itemVersion) === auth.item.version && Number(ctx.placementAuthorizationVersion) === auth.item.placement_authorization_version,
        "version_conflict", 409);
      if (body.mode === "candidate") {
        const suggestion = this.core.one("SELECT * FROM placement_suggestions WHERE id=? AND photo_id=? AND invalidated_at IS NULL", body.suggestionId, photo.id);
        assert(suggestion && body.candidateId, "stale_revision", 409);
        assert(body.yawDeg == null && body.pitchDeg == null && body.regionId == null, "placement_action_unavailable", 400);
        const candidate = parseJson(suggestion.candidates_json, []).find((entry) => entry.candidateId === body.candidateId);
        const currentPanoramaRevisionId = this.core.one("SELECT current_panorama_revision_id FROM spaces WHERE id=?", photo.space_id)?.current_panorama_revision_id;
        assert(candidate && suggestion.panorama_revision_id === currentPanoramaRevisionId && Number.isFinite(Number(candidate.yaw)),
          "stale_revision", 409);
        body.yawDeg = Number(candidate.yaw);
        body.pitchDeg = candidate.pitch == null ? null : Number(candidate.pitch);
        body.regionId = candidate.region ?? null;
      } else assert(Number.isFinite(Number(body.yawDeg)), "placement_action_unavailable", 400);
      return this.appendPlacement(ctx, photo, auth, {
        placementState: "confirmed", confirmationMode: "manual", panoramaRevisionId: this.core.one("SELECT current_panorama_revision_id FROM spaces WHERE id=?", photo.space_id)?.current_panorama_revision_id,
        yaw: body.yawDeg ?? null, pitch: body.pitchDeg ?? null, fov: 75, region: body.regionId ?? null,
        suggestionId: body.mode === "candidate" ? body.suggestionId : null, reasonCode: body.reason ?? "manual_saved"
      });
    });
  }

  action(ctx, photoId) {
    const body = object(ctx.body, ["action", "failedVersion", "targetRevisionId", "reason", "reasonCode", "note"], ["action"]);
    const photo = this.getPhoto(photoId);
    const auth = this.managerOrReceipt(ctx, photo);
    return this.core.mutation(ctx, { endpoint: `/v1/photos/${photoId}/placement-actions`, scope: auth.authorizationId,
      reauthorize: () => this.managerOrReceipt(ctx, this.getPhoto(photoId)) }, () => {
      this.core.requireIfMatch(ctx, photo);
      assert(Number(ctx.itemVersion) === auth.item.version && Number(ctx.placementAuthorizationVersion) === auth.item.placement_authorization_version,
        "version_conflict", 409);
      if (body.action === "retry") {
        assert(photo.placement_state === "failed", "placement_action_unavailable", 409);
        const space = this.core.one("SELECT * FROM spaces WHERE id=?", photo.space_id);
        const scene = this.core.one("SELECT * FROM scenes WHERE id=? AND space_id=?", space?.scene_id, photo.space_id);
        const asset = this.core.one("SELECT * FROM assets WHERE id=? AND space_id=?", photo.asset_id, photo.space_id);
        assert(space && scene && asset?.raw_sha256, "placement_action_unavailable", 409);
        const job = this.jobs.enqueue("photo_placement", photo.space_id, {
          spaceId: space.id, sceneId: scene.id, mediaSha256: asset.raw_sha256,
          photoId, photoVersion: photo.version + 1,
          itemId: auth.item.id, itemVersion: auth.item.version + (auth.manager ? 1 : 0),
          placementAuthorizationVersion: auth.item.placement_authorization_version + (auth.manager ? 1 : 0),
          panoramaRevisionId: space.current_panorama_revision_id, policyReleaseId: null, policyVersion: null });
        this.db.prepare("UPDATE photos SET placement_state='processing',confirmation_mode=NULL,version=version+1 WHERE id=? AND version=?")
          .run(photo.id, photo.version);
        this.managerLock(ctx, auth, photo, "manager_retry");
        return { photoId, placementState: "processing", jobId: job.jobId, version: photo.version + 1 };
      }
      if (body.action === "restore") {
        const target = this.core.one("SELECT * FROM placement_revisions WHERE id=? AND photo_id=?", body.targetRevisionId, photo.id);
        assert(target, "stale_revision", 409);
        return this.appendPlacement(ctx, photo, auth, { placementState: target.placement_state,
          confirmationMode: target.confirmation_mode, panoramaRevisionId: target.panorama_revision_id,
          yaw: target.yaw, pitch: target.pitch, fov: target.fov, region: target.region, suggestionId: target.suggestion_id,
          restoredFrom: target.id, reasonCode: body.reason ?? "restored" });
      }
      assert(body.action === "mark_outside_scene", "placement_action_unavailable", 409);
      return this.appendPlacement(ctx, photo, auth, { placementState: "outside_scene", confirmationMode: null,
        panoramaRevisionId: null, yaw: null, pitch: null, fov: null, region: null, suggestionId: null,
        reasonCode: body.reasonCode ?? "marked_outside_scene" });
    });
  }

  appendPlacement(ctx, photo, auth, next) {
    const current = this.core.one("SELECT * FROM placement_revisions WHERE id=?", photo.current_placement_revision_id);
    const seq = (this.core.one("SELECT MAX(seq) max FROM placement_revisions WHERE photo_id=?", photo.id)?.max ?? 0) + 1;
    const revisionId = id("pr");
    const snapshot = this.authSnapshot(auth);
    this.db.prepare(`INSERT INTO placement_revisions(
      id,space_id,photo_id,panorama_revision_id,seq,parent_revision_id,placement_state,confirmation_mode,yaw,pitch,fov,region,
      suggestion_id,algorithm_release_id,auth_kind,authorization_id,auth_snapshot_json,restored_from,reason_code,request_id,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(revisionId, photo.space_id, photo.id, next.panoramaRevisionId, seq,
    current?.id ?? null, next.placementState, next.confirmationMode, next.yaw, next.pitch, next.fov ?? null, next.region, next.suggestionId,
    next.algorithmReleaseId ?? null, auth.authKind, auth.authorizationId, json(snapshot), next.restoredFrom ?? null,
    next.reasonCode, ctx.requestId, this.core.now());
    this.db.prepare(`UPDATE photos SET placement_state=?,confirmation_mode=?,current_placement_revision_id=?,version=version+1
      WHERE id=? AND version=?`).run(next.placementState, next.confirmationMode, revisionId, photo.id, photo.version);
    this.managerLock(ctx, auth, photo, "manager_placement_write");
    this.core.audit({ spaceId: photo.space_id, aggregateType: "photo", aggregateId: photo.id, eventType: "placement_changed",
      actorKind: auth.authKind, authorizationId: auth.authorizationId, detail: { revisionId, placementState: next.placementState }, requestId: ctx.requestId });
    return { revisionId, photoId: photo.id, placementState: next.placementState, confirmationMode: next.confirmationMode,
      panoramaRevisionId: next.panoramaRevisionId, suggestionId: next.suggestionId, version: photo.version + 1,
      itemVersion: auth.item.version + (auth.manager ? 1 : 0), placementAuthorizationVersion: auth.item.placement_authorization_version + (auth.manager ? 1 : 0) };
  }

  authSnapshot(auth) {
    if (!auth.manager) return {
      authKind: "receipt_session", authorizationId: auth.authorizationId,
      actorAccountId: auth.actor.batch.actor_kind === "account" ? auth.actor.batch.actor_id : null,
      actorContributorPrincipalId: auth.actor.batch.actor_kind === "contributor" ? auth.actor.batch.actor_id : null,
      actorServiceJobId: null, spaceVersion: auth.actor.space.version, membershipVersionSnapshot: null,
      tasksSnapshot: ["upload"], managementScopesSnapshot: [], batchReceiptId: auth.actor.receipt.id,
      itemId: auth.item.id, receiptVersionSnapshot: auth.actor.receipt.version,
      receiptSessionVersionSnapshot: auth.actor.session.version, itemVersionSnapshot: auth.item.version,
      placementAuthorizationVersion: auth.item.placement_authorization_version
    };
    const membership = auth.access.membership;
    return {
      authKind: auth.authKind, authorizationId: auth.authorizationId, actorAccountId: auth.actor.accountId,
      actorContributorPrincipalId: null, actorServiceJobId: null, spaceVersion: auth.access.space.version,
      membershipVersionSnapshot: membership?.version ?? null,
      tasksSnapshot: membership ? parseJson(membership.tasks_json, []) : ["upload", "view"],
      managementScopesSnapshot: membership ? parseJson(membership.management_scopes_json, []) : [...SCOPES].sort(),
      batchReceiptId: null, itemId: auth.item.id, receiptVersionSnapshot: null,
      receiptSessionVersionSnapshot: null, itemVersionSnapshot: auth.item.version,
      placementAuthorizationVersion: auth.item.placement_authorization_version
    };
  }

  managerLock(ctx, auth, photo, reasonCode) {
    if (!auth.manager) return;
    this.db.prepare(`UPDATE contribution_batch_items SET uploader_placement_write_enabled=0,
      placement_authorization_version=placement_authorization_version+1,version=version+1 WHERE id=? AND version=?`)
      .run(auth.item.id, auth.item.version);
    this.db.prepare(`INSERT INTO placement_authorization_events(
      id,space_id,batch_id,item_id,photo_id,before_enabled,after_enabled,before_authorization_version,
      after_authorization_version,actor_json,reason_code,request_id,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id("pae"), photo.space_id, photo.batch_id, auth.item.id, photo.id,
    auth.item.uploader_placement_write_enabled, 0, auth.item.placement_authorization_version,
    auth.item.placement_authorization_version + 1, json(this.authSnapshot(auth)),
    reasonCode, ctx.requestId, this.core.now());
  }

  reopen(ctx, accountCtx, receiptId, itemId) {
    const body = object(ctx.body, ["reason"], ["reason"]);
    const receipt = this.core.one("SELECT * FROM batch_receipts WHERE id=?", receiptId);
    const item = this.core.one("SELECT * FROM contribution_batch_items WHERE id=? AND batch_id=?", itemId, receipt?.batch_id);
    assert(receipt && item && item.photo_id, "item_unavailable", 404);
    const access = this.core.accountSpace(accountCtx, item.space_id, { ownerOnly: true });
    return this.core.mutation(ctx, { endpoint: `/v1/batch-receipts/${receiptId}/items/${itemId}/placement-reopens`,
      scope: accountCtx.session.id, reauthorize: () => this.core.accountSpace(this.core.account(ctx.accountSession),
        item.space_id, { ownerOnly: true }) }, () => {
      this.core.requireIfMatch(ctx, item);
      assert(item.uploader_placement_write_enabled === 0, "item_unavailable", 409);
      this.db.prepare(`UPDATE contribution_batch_items SET uploader_placement_write_enabled=1,
        placement_authorization_version=placement_authorization_version+1,version=version+1 WHERE id=? AND version=?`).run(item.id, item.version);
      this.db.prepare(`INSERT INTO placement_authorization_events(
        id,space_id,batch_id,item_id,photo_id,before_enabled,after_enabled,before_authorization_version,after_authorization_version,
        actor_json,reason_code,request_id,created_at
      ) VALUES(?,?,?,?,?,0,1,?,?,?,?,?,?)`).run(id("pae"), item.space_id, item.batch_id, item.id, item.photo_id,
      item.placement_authorization_version, item.placement_authorization_version + 1, json({
        authKind: "space_owner", authorizationId: item.space_id, actorAccountId: accountCtx.accountId,
        actorContributorPrincipalId: null, actorServiceJobId: null, spaceVersion: access.space.version,
        membershipVersionSnapshot: null, tasksSnapshot: ["upload", "view"],
        managementScopesSnapshot: [...SCOPES].sort(), batchReceiptId: null, itemId: item.id,
        receiptVersionSnapshot: null, receiptSessionVersionSnapshot: null, itemVersionSnapshot: item.version,
        placementAuthorizationVersion: item.placement_authorization_version
      }),
      body.reason, ctx.requestId, this.core.now());
      return { itemId, uploaderPlacementWriteEnabled: true, version: item.version + 1,
        placementAuthorizationVersion: item.placement_authorization_version + 1 };
    });
  }

  content(ctx, accountCtx, photoId) {
    const body = object(ctx.body, ["to", "transitionReasonCode", "decisionReasonCode", "note"], ["to", "transitionReasonCode", "decisionReasonCode"]);
    const contract = transitions[body.transitionReasonCode];
    assert(contract, "transition_not_allowed", 409);
    const photo = this.getPhoto(photoId);
    const access = this.core.accountSpace(accountCtx, photo.space_id, { scope: "canReview" });
    return this.core.mutation(ctx, { endpoint: `/v1/photos/${photoId}/content-transitions`, scope: accountCtx.session.id,
      reauthorize: () => this.core.accountSpace(this.core.account(ctx.accountSession), photo.space_id,
        { scope: "canReview" }) }, () => {
      this.core.requireIfMatch(ctx, photo);
      assert(contract.from.includes(photo.photo_content_state) && contract.to === body.to, "transition_not_allowed", 409);
      if (contract.decisions.length === 0) assert(body.decisionReasonCode === null, "decision_reason_not_allowed", 400);
      else {
        assert(typeof body.decisionReasonCode === "string", "decision_reason_required", 400);
        assert(contract.decisions.includes(body.decisionReasonCode), "decision_reason_not_allowed", 400);
        if (body.decisionReasonCode === "other") assert(typeof body.note === "string" && body.note.trim(), "decision_note_required", 400);
      }
      this.db.prepare("UPDATE photos SET photo_content_state=?,version=version+1 WHERE id=? AND version=?")
        .run(body.to, photo.id, photo.version);
      this.db.prepare(`INSERT INTO photo_content_events(
        id,space_id,photo_id,before_state,after_state,transition_reason_code,decision_reason_code,note,actor_json,request_id,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id("pce"), photo.space_id, photo.id, photo.photo_content_state, body.to,
      body.transitionReasonCode, body.decisionReasonCode, body.note ?? null, json({ authKind: access.authKind,
        authorizationId: access.authorizationId, actorAccountId: accountCtx.accountId, spaceVersion: access.space.version,
        membershipVersionSnapshot: access.membership?.version ?? null,
        tasksSnapshot: access.membership ? parseJson(access.membership.tasks_json, []) : ["upload", "view"],
        managementScopesSnapshot: access.membership ? parseJson(access.membership.management_scopes_json, []) : [...SCOPES].sort() }),
      ctx.requestId, this.core.now());
      return { photoId, before: photo.photo_content_state, after: body.to, transitionReasonCode: body.transitionReasonCode,
        decisionReasonCode: body.decisionReasonCode, version: photo.version + 1 };
    });
  }

  history(ctx, photoId) {
    const photo = this.getPhoto(photoId);
    this.managerOrReceipt(ctx, photo);
    return { photoId, revisions: this.core.all("SELECT * FROM placement_revisions WHERE photo_id=? ORDER BY seq", photoId)
      .map((row) => ({ revisionId: row.id, seq: row.seq, placementState: row.placement_state,
        confirmationMode: row.confirmation_mode, panoramaRevisionId: row.panorama_revision_id, reasonCode: row.reason_code, createdAt: row.created_at })) };
  }
}
