import { exportPersonalMemories } from "../../api/src/personal-memory-service.mjs";
import { exportRecoveryRequests } from "../../api/src/password-recovery-service.mjs";
import { id, json, parseJson, sha256, stableJson } from "../../api/src/util.mjs";
import { assert } from "../../api/src/errors.mjs";
import { transaction } from "../../api/src/database.mjs";
import { disabledLocatorFixture } from "../../api/src/ports/locator/deterministic-locator-fixture.mjs";
export { dispatchDeletion } from "./deletion-worker.mjs";

function complete(db, job, { status, stableError = null, result = null }, now) {
  const updated = db.prepare(`UPDATE jobs SET status=?,stable_error=?,result_json=?,attempts=attempts+1,updated_at=?,version=version+1
    WHERE id=? AND version=?`).run(status, stableError, result ? json(result) : null, now, job.id, job.version);
  assert(updated.changes === 1, "concurrent_change", 409);
}

function panorama(db, job, refs, now) {
  const candidate = db.prepare("SELECT * FROM panorama_candidates WHERE id=? AND validation_job_id=?").get(refs.candidateId, job.id);
  const asset = candidate ? db.prepare("SELECT * FROM assets WHERE id=?").get(candidate.asset_id) : null;
  assert(candidate && candidate.status === "validating" && candidate.version === refs.candidateVersion &&
    asset && asset.version === refs.assetVersion, "job_input_unavailable", 409);
  if (asset.validation_state !== "valid") {
    db.prepare("UPDATE panorama_candidates SET status='failed',validation_code='decoder_failure',failed_at=?,version=version+1 WHERE id=? AND version=?")
      .run(now, candidate.id, candidate.version);
    complete(db, job, { status: "failed", stableError: "decoder_failure" }, now);
    return { status: "failed", stableError: "decoder_failure" };
  }
  const revisionId = id("pano_r");
  db.prepare(`INSERT INTO panorama_revisions(
    id,space_id,candidate_id,asset_id,validation_report_json,created_by,ready_at,version
  ) VALUES(?,?,?,?,?,?,?,1)`).run(revisionId, candidate.space_id, candidate.id, candidate.asset_id,
  json({ sha256: asset.raw_sha256, mime: asset.observed_mime, bytes: asset.observed_bytes,
    width: asset.width, height: asset.height, ratio: 2 }), candidate.created_by, now);
  db.prepare(`UPDATE panorama_candidates SET panorama_revision_id=?,status='ready',ready_at=?,validation_code=NULL,
    version=version+1 WHERE id=? AND version=?`).run(revisionId, now, candidate.id, candidate.version);
  complete(db, job, { status: "succeeded", result: { panoramaRevisionId: revisionId } }, now);
  return { status: "succeeded", panoramaRevisionId: revisionId };
}

function photoValidation(db, job, refs, now, locatorFixture) {
  const asset = db.prepare("SELECT * FROM assets WHERE id=?").get(refs.assetId);
  const viewerSafeAsset = db.prepare("SELECT * FROM assets WHERE id=?").get(refs.viewerSafeAssetId);
  const item = db.prepare("SELECT * FROM contribution_batch_items WHERE id=?").get(refs.itemId);
  const uploadSession = db.prepare("SELECT * FROM upload_sessions WHERE id=?").get(refs.uploadSessionId);
  assert(asset?.version === refs.assetVersion && viewerSafeAsset?.version === refs.viewerSafeAssetVersion &&
    viewerSafeAsset.kind === "photo_viewer_safe" && viewerSafeAsset.validation_state === "valid" &&
    viewerSafeAsset.metadata_policy_result === "exif_gps_stripped" && item?.version === refs.itemVersion &&
    uploadSession?.version === refs.uploadSessionVersion && uploadSession.status === "committed", "job_input_unavailable", 409);
  if (asset.validation_state !== "valid") {
    db.prepare("UPDATE contribution_batch_items SET status='failed',failure_code='media_decode_rejected',version=version+1 WHERE id=? AND version=?")
      .run(item.id, item.version);
    complete(db, job, { status: "failed", stableError: "media_decode_rejected" }, now);
    return { status: "failed", stableError: "media_decode_rejected" };
  }
  const photo = db.prepare("SELECT * FROM photos WHERE batch_item_id=? AND asset_id=? AND deleted_at IS NULL").get(item.id, asset.id);
  assert(photo?.viewer_safe_asset_id === viewerSafeAsset.id, "job_input_unavailable", 409);
  const placementJobId = id("job");
  const space = db.prepare("SELECT * FROM spaces WHERE id=?").get(photo.space_id);
  const scene = db.prepare("SELECT * FROM scenes WHERE id=? AND space_id=?").get(space?.scene_id, photo.space_id);
  assert(space && scene && job.space_id === space.id && asset.raw_sha256, "job_input_unavailable", 409);
  let placementRefs = { spaceId: space.id, sceneId: scene.id, mediaSha256: asset.raw_sha256,
    photoId: photo.id, photoVersion: photo.version, itemId: item.id, itemVersion: item.version,
    placementAuthorizationVersion: item.placement_authorization_version,
    panoramaRevisionId: space.current_panorama_revision_id, policyReleaseId: null, policyVersion: null,
    sourceValidationJobId: job.id };
  placementRefs = locatorFixture.decorate(db, placementRefs, now);
  assert(/^[a-f0-9]{64}$/.test(placementRefs.mediaSha256) &&
    ((placementRefs.policyReleaseId == null && placementRefs.policyVersion == null) ||
      (typeof placementRefs.policyReleaseId === "string" && Number.isSafeInteger(placementRefs.policyVersion))),
  "job_input_unavailable", 409);
  db.prepare(`INSERT INTO jobs(
    id,space_id,type,input_refs_json,input_hash,status,attempts,algorithm_release_id,created_at,updated_at,version
  ) VALUES(?,?,'photo_placement',?,?,'queued',0,?,?,?,1)`).run(placementJobId, space.id,
  json(placementRefs), sha256(stableJson(placementRefs)), placementRefs.policyReleaseId, now, now);
  complete(db, job, { status: "succeeded", result: { assetId: asset.id, itemId: item.id, placementJobId } }, now);
  return { status: "succeeded", assetId: asset.id, placementJobId };
}

function placement(db, job, refs, now, outcome) {
  const photo = db.prepare("SELECT * FROM photos WHERE id=?").get(refs.photoId);
  assert(photo, "job_input_unavailable", 409);
  const item = db.prepare(`SELECT i.* FROM contribution_batch_items i JOIN photos p
    ON p.batch_item_id=i.id AND p.batch_id=i.batch_id AND p.space_id=i.space_id
    WHERE p.id=? AND i.id=? AND i.space_id=?`).get(photo.id, refs.itemId, photo.space_id);
  const currentItem = item ?? db.prepare(`SELECT i.* FROM contribution_batch_items i JOIN photos p
    ON p.batch_item_id=i.id AND p.batch_id=i.batch_id AND p.space_id=i.space_id
    WHERE p.id=?`).get(photo.id);
  const space = db.prepare("SELECT * FROM spaces WHERE id=?").get(photo.space_id);
  const scene = db.prepare("SELECT * FROM scenes WHERE space_id=?").get(photo.space_id);
  const asset = db.prepare("SELECT * FROM assets WHERE id=? AND space_id=?").get(photo.asset_id, photo.space_id);
  const release = refs.policyReleaseId ? db.prepare("SELECT * FROM algorithm_releases WHERE id=?")
    .get(refs.policyReleaseId) : null;
  const superseding = db.prepare(`SELECT 1 FROM jobs WHERE type='photo_placement' AND rowid>(SELECT rowid FROM jobs WHERE id=?)
    AND json_extract(input_refs_json,'$.photoId')=? LIMIT 1`).get(job.id, photo.id);
  const inputHashMatches = job.input_hash === sha256(stableJson(refs));
  const spaceMatches = job.space_id === refs.spaceId && photo.space_id === refs.spaceId && space?.id === refs.spaceId;
  const sceneMatches = scene?.id === refs.sceneId && space?.scene_id === refs.sceneId;
  const mediaMatches = asset?.raw_sha256 === refs.mediaSha256;
  const itemBindingMatches = Boolean(item);
  const policyMatches = refs.policyReleaseId == null ? refs.policyVersion == null && job.algorithm_release_id == null :
    release?.version === refs.policyVersion && job.algorithm_release_id === refs.policyReleaseId;
  const stale = !inputHashMatches || !spaceMatches || !sceneMatches || !mediaMatches || !itemBindingMatches ||
    photo.version !== refs.photoVersion || !item || item.version !== refs.itemVersion ||
    item.placement_authorization_version !== refs.placementAuthorizationVersion ||
    (space?.current_panorama_revision_id ?? null) !== (refs.panoramaRevisionId ?? null) || !policyMatches || superseding;
  if (stale) {
    const reason = !inputHashMatches ? "input_hash_changed" : !spaceMatches ? "space_changed" :
      !sceneMatches ? "scene_changed" : !mediaMatches ? "media_checksum_changed" :
        !itemBindingMatches ? "item_photo_binding_changed" : photo.version !== refs.photoVersion ? "photo_version_changed" :
          !item || item.version !== refs.itemVersion ? "item_version_changed" :
            item.placement_authorization_version !== refs.placementAuthorizationVersion ? "authorization_version_changed" :
              (space?.current_panorama_revision_id ?? null) !== (refs.panoramaRevisionId ?? null) ?
                "panorama_revision_changed" : !policyMatches ? "policy_release_changed" : "superseding_job";
    db.prepare(`INSERT INTO audit_events(
      id,space_id,aggregate_type,aggregate_id,event_type,actor_kind,authorization_id,detail_json,request_id,created_at
    ) VALUES(?,?,?,?,?,'service_job',?,?,?,?)`).run(id("aud"), photo.space_id, "photo", photo.id,
    "placement_job_dispatch", job.id, json({ decision: "stale_rejected", reason, inputHash: job.input_hash,
      queued: { spaceId: refs.spaceId ?? null, sceneId: refs.sceneId ?? null,
        mediaSha256: refs.mediaSha256 ?? null, photoVersion: refs.photoVersion, itemId: refs.itemId ?? null,
        itemVersion: refs.itemVersion,
        placementAuthorizationVersion: refs.placementAuthorizationVersion,
        panoramaRevisionId: refs.panoramaRevisionId ?? null, policyReleaseId: refs.policyReleaseId ?? null,
        policyVersion: refs.policyVersion ?? null },
      current: { spaceId: photo.space_id, sceneId: scene?.id ?? null, spaceSceneId: space?.scene_id ?? null,
        mediaSha256: asset?.raw_sha256 ?? null, photoVersion: photo.version,
        itemId: currentItem?.id ?? null, itemBatchId: currentItem?.batch_id ?? null,
        itemVersion: currentItem?.version ?? null,
        placementAuthorizationVersion: currentItem?.placement_authorization_version ?? null,
        panoramaRevisionId: space?.current_panorama_revision_id ?? null,
        policyReleaseId: release?.id ?? null, policyVersion: release?.version ?? null } }), job.id, now);
    complete(db, job, { status: "failed", stableError: "job_input_stale",
      result: { stale: true, reason, photoVersion: photo.version,
        panoramaRevisionId: space?.current_panorama_revision_id ?? null } }, now);
    return { status: "failed", stableError: "job_input_stale", stale: true, reason };
  }
  const locatorInput = { spaceId: refs.spaceId, sceneId: refs.sceneId, mediaSha256: refs.mediaSha256,
    panoramaRevisionId: refs.panoramaRevisionId ?? null, policyReleaseId: refs.policyReleaseId ?? null,
    policyVersion: refs.policyVersion ?? null };
  const classification = outcome?.classification ?? "no_active_policy";
  if (["job_failed", "timed_out", "decoder_failure", "retry_exhausted"].includes(classification)) {
    db.prepare("UPDATE photos SET placement_state='failed',confirmation_mode=NULL,version=version+1 WHERE id=? AND version=?")
      .run(photo.id, photo.version);
    const result = { placementState: "failed", locatorInput, ...(outcome?.locatorProvenance ?
      { locatorProvenance: outcome.locatorProvenance } : {}) };
    complete(db, job, { status: classification === "timed_out" ? "timed_out" : "failed",
      stableError: classification, result }, now);
    return { status: "failed", ...result };
  }
  if (classification === "same_scene_high") {
    assert(outcome?.algorithmReleaseId && outcome?.panoramaRevisionId && Number.isFinite(outcome?.yaw), "active_policy_unavailable", 409);
    const release = db.prepare("SELECT * FROM algorithm_releases WHERE id=?").get(outcome.algorithmReleaseId);
    const panoramaRevision = db.prepare(`SELECT r.id FROM panorama_revisions r JOIN panorama_candidates c ON c.id=r.candidate_id
      WHERE r.id=? AND r.space_id=? AND c.status='ready'`).get(outcome.panoramaRevisionId, photo.space_id);
    assert(release && release.id === refs.policyReleaseId && release.version === refs.policyVersion &&
      outcome.panoramaRevisionId === refs.panoramaRevisionId && panoramaRevision, "active_policy_unavailable", 409);
    const revisionId = id("pr");
    const seq = (db.prepare("SELECT MAX(seq) max FROM placement_revisions WHERE photo_id=?").get(photo.id)?.max ?? 0) + 1;
    db.prepare(`INSERT INTO placement_revisions(
      id,space_id,photo_id,panorama_revision_id,seq,parent_revision_id,placement_state,confirmation_mode,yaw,fov,
      algorithm_release_id,auth_kind,authorization_id,auth_snapshot_json,reason_code,request_id,created_at
    ) VALUES(?,?,?,?,?,?,'confirmed','auto',?,75,?,'service_job',?,?,?,?,?)`).run(revisionId, photo.space_id, photo.id,
    outcome.panoramaRevisionId, seq, photo.current_placement_revision_id, outcome.yaw, outcome.algorithmReleaseId, job.id,
    json({ authKind: "service_job", authorizationId: job.id, actorAccountId: null,
      actorContributorPrincipalId: null, actorServiceJobId: job.id, spaceVersion: space.version,
      membershipVersionSnapshot: null, tasksSnapshot: [], managementScopesSnapshot: [], batchReceiptId: null,
      itemId: photo.batch_item_id, receiptVersionSnapshot: null, receiptSessionVersionSnapshot: null,
      itemVersionSnapshot: item.version,
      placementAuthorizationVersion: item.placement_authorization_version,
      jobVersion: job.version, algorithmReleaseId: outcome.algorithmReleaseId, locatorInput }), "same_scene_high", job.id, now);
    db.prepare("UPDATE photos SET placement_state='confirmed',confirmation_mode='auto',current_placement_revision_id=?,version=version+1 WHERE id=? AND version=?")
      .run(revisionId, photo.id, photo.version);
    const result = { placementState: "confirmed", revisionId, locatorInput, ...(outcome?.locatorProvenance ?
      { locatorProvenance: outcome.locatorProvenance } : {}) };
    complete(db, job, { status: "succeeded", result }, now);
    return { status: "succeeded", ...result };
  }
  assert(["uncertain", "ood", "ambiguous", "abstained", "no_active_policy"].includes(classification), "job_result_invalid", 409);
  db.prepare("UPDATE photos SET placement_state='needs_confirmation',confirmation_mode=NULL,version=version+1 WHERE id=? AND version=?")
    .run(photo.id, photo.version);
  // CLIP 判定成 "uncertain"(区别于 abstained/no_active_policy 那种没有真实比对结果的情况)
  // 且 worker 附带了候选方向时，落一条 placement_suggestions，供人工队列渲染"AI 候选方向"。
  // sidecar 故障/没有全景可比对 -> outcome.candidates 不存在 -> 这里什么也不写，页面照旧走
  // 纯手动路径，就是要的"优雅缺省"。旧的 DeterministicLocatorFixture 走的 outcome 从不带
  // candidates 字段，这条分支对它是天然的 no-op，不影响任何既有夹具测试。
  let suggestionId = null;
  if (classification === "uncertain" && Array.isArray(outcome?.candidates) && outcome.candidates.length > 0) {
    db.prepare(`UPDATE placement_suggestions SET invalidated_at=COALESCE(invalidated_at,?),version=version+1
      WHERE photo_id=? AND invalidated_at IS NULL`).run(now, photo.id);
    suggestionId = id("psug");
    const candidates = outcome.candidates.slice(0, 3).map((candidate, index) => ({
      candidateId: `${suggestionId}_c${index + 1}`,
      yaw: Number(candidate.yaw),
      pitch: candidate.pitch == null ? null : Number(candidate.pitch),
      confidence: Number(candidate.confidence)
    }));
    db.prepare(`INSERT INTO placement_suggestions(
      id,space_id,photo_id,panorama_revision_id,job_id,algorithm_release_id,status,candidates_json,version
    ) VALUES(?,?,?,?,?,?,'ready',?,1)`).run(suggestionId, photo.space_id, photo.id,
    refs.panoramaRevisionId ?? null, job.id, refs.policyReleaseId ?? null, json(candidates));
  }
  const result = { placementState: "needs_confirmation", classification, locatorInput, ...(outcome?.locatorProvenance ?
    { locatorProvenance: outcome.locatorProvenance } : {}), ...(suggestionId ? { suggestionId } : {}) };
  complete(db, job, { status: "succeeded", result }, now);
  return { status: "succeeded", ...result };
}

function exportGeneration(db, job, refs, now, keyring) {
  const exportJob = db.prepare("SELECT * FROM export_jobs WHERE id=? AND account_id=?").get(refs.exportId, refs.accountId);
  assert(exportJob && exportJob.status === "queued", "job_input_unavailable", 409);
  const account = db.prepare("SELECT id,locale,status,version,created_at FROM accounts WHERE id=?").get(refs.accountId);
  assert(account, "job_input_unavailable", 409);
  const spaces = refs.scope === "space" ? db.prepare(`SELECT id,name,owner_account_id,space_lifecycle,collection_state,
    sharing_state,current_panorama_revision_id,current_world_result_id,version,created_at,updated_at FROM spaces WHERE id=? AND owner_account_id=?`)
    .all(refs.spaceId, refs.accountId) : db.prepare(`SELECT DISTINCT s.id,s.name,s.owner_account_id,s.space_lifecycle,
    s.collection_state,s.sharing_state,s.current_panorama_revision_id,s.current_world_result_id,s.version,s.created_at,s.updated_at FROM spaces s
    WHERE s.owner_account_id=? OR s.id IN (SELECT space_id FROM space_memberships WHERE account_id=?)
      OR s.id IN (SELECT space_id FROM receipt_account_bindings WHERE account_id=?)
      OR s.id IN (SELECT space_id FROM contribution_batches WHERE actor_kind='account' AND actor_id=?) ORDER BY s.id`)
    .all(refs.accountId, refs.accountId, refs.accountId, refs.accountId);
  assert(refs.scope !== "space" || spaces.length === 1, "job_input_unavailable", 409);
  const privacy = refs.scope === "account" ? {
    sceneCaptures: db.prepare(`SELECT id,space_id,scene_revision_id,job_id,input_mode,title,source_space_version,source_scene_version,
      declared_bytes,status,manifest_json,manifest_sha256,created_at,expires_at,cancelled_at,purged_at FROM scene_captures WHERE account_id=? ORDER BY id`)
      .all(refs.accountId).map(capture => ({ ...capture, files: db.prepare(`SELECT id,client_file_id,name,mime_type,declared_bytes,
        raw_sha256,width,height,duration_seconds,status FROM scene_capture_files WHERE capture_id=? ORDER BY ordinal`).all(capture.id) })),
    worldResults: db.prepare(`SELECT id,space_id,scene_id,request_id,world_id,result_hash,world_json,source_space_version,
      source_scene_version,activated_at,retired_at FROM scene_world_results WHERE account_id=? ORDER BY id`).all(refs.accountId),
    personalMemories: exportPersonalMemories(db, keyring, refs.accountId),
    passwordRecoveryRequests: exportRecoveryRequests(db,keyring,refs.accountId),
    submissions: db.prepare("SELECT id,moment_id momentId,status,reason,created_at createdAt,reviewed_at reviewedAt,version FROM moment_submissions WHERE account_id=?").all(refs.accountId),
    accountAdministration: db.prepare("SELECT status,is_admin isAdmin,display_name displayName,last_login_at lastLoginAt FROM account_administration WHERE account_id=?").get(refs.accountId) ?? null,
    identifiers: db.prepare(`SELECT a.display_mask,a.status,a.created_at,a.grace_expires_at
      FROM account_verified_identifiers v JOIN account_verified_identifier_aliases a
      ON a.identifier_equivalence_id=v.identifier_equivalence_id WHERE v.account_id=? ORDER BY a.created_at,a.id`).all(refs.accountId),
    memberships: db.prepare(`SELECT id,space_id,tasks_json,management_scopes_json,status,accepted_at,revoked_at,version
      FROM space_memberships WHERE account_id=? ORDER BY id`).all(refs.accountId),
    receiptBindings: db.prepare(`SELECT rb.id,rb.space_id,rb.batch_receipt_id,r.batch_id,rb.bound_at,rb.revoked_at,rb.version
      FROM receipt_account_bindings rb JOIN batch_receipts r ON r.id=rb.batch_receipt_id
      WHERE rb.account_id=? ORDER BY rb.id`).all(refs.accountId),
    contributionBatches: db.prepare(`SELECT DISTINCT b.id,b.space_id,b.actor_kind,b.status,b.item_count,b.committed_count,
      b.failed_count,b.version,b.created_at,b.finalized_at FROM contribution_batches b
      WHERE (b.actor_kind='account' AND b.actor_id=?) OR b.id IN (
        SELECT r.batch_id FROM receipt_account_bindings rb JOIN batch_receipts r ON r.id=rb.batch_receipt_id
        WHERE rb.account_id=?) ORDER BY b.id`).all(refs.accountId, refs.accountId),
    contributionItems: db.prepare(`SELECT i.id,i.space_id,i.batch_id,i.photo_id,i.status,i.failure_code,
      i.uploader_placement_write_enabled,i.placement_authorization_version,i.revoked_at,i.deleted_at,i.version
      FROM contribution_batch_items i JOIN contribution_batches b ON b.id=i.batch_id
      WHERE (b.actor_kind='account' AND b.actor_id=?) OR b.id IN (
        SELECT r.batch_id FROM receipt_account_bindings rb JOIN batch_receipts r ON r.id=rb.batch_receipt_id
        WHERE rb.account_id=?) ORDER BY i.id`).all(refs.accountId, refs.accountId),
    photos: db.prepare(`SELECT p.id,p.space_id,p.batch_id,p.batch_item_id,p.photo_content_state,p.placement_state,
      p.confirmation_mode,p.version,p.deleted_at FROM photos p JOIN contribution_batches b ON b.id=p.batch_id
      WHERE (b.actor_kind='account' AND b.actor_id=?) OR b.id IN (
        SELECT r.batch_id FROM receipt_account_bindings rb JOIN batch_receipts r ON r.id=rb.batch_receipt_id
        WHERE rb.account_id=?) ORDER BY p.id`).all(refs.accountId, refs.accountId),
    cases: db.prepare(`SELECT DISTINCT c.id,c.space_id,c.case_type,c.parent_case_id,c.target_type,c.target_photo_id,
      c.target_space_id,c.target_account_id,c.category,c.description,c.decision_reason_code,c.status,c.created_at,c.version
      FROM content_cases c WHERE c.actor_account_id=? OR c.target_account_id=? OR c.actor_receipt_item_id IN (
        SELECT i.id FROM contribution_batch_items i JOIN batch_receipts r ON r.batch_id=i.batch_id
        JOIN receipt_account_bindings rb ON rb.batch_receipt_id=r.id WHERE rb.account_id=?) ORDER BY c.id`)
      .all(refs.accountId, refs.accountId, refs.accountId),
    consents: db.prepare(`SELECT ce.id,ce.space_id,ce.actor_auth_kind,ce.notice_id,ce.notice_version,ce.notice_hash,
      ce.notice_purpose,ce.accepted_at FROM consent_events ce WHERE
      (ce.actor_auth_kind='account' AND ce.authorization_id IN (SELECT id FROM account_sessions WHERE account_id=?)) OR
      (ce.actor_auth_kind='receipt_session' AND ce.authorization_id IN (
        SELECT rs.id FROM receipt_sessions rs JOIN receipt_account_bindings rb
        ON rb.batch_receipt_id=rs.batch_receipt_id WHERE rb.account_id=?)) ORDER BY ce.id`).all(refs.accountId, refs.accountId)
  } : {
    photos: spaces.flatMap((space) => db.prepare(`SELECT id,space_id,batch_id,batch_item_id,photo_content_state,
      placement_state,confirmation_mode,version,deleted_at FROM photos WHERE space_id=? ORDER BY id`).all(space.id))
  };
  const artifactObject = { schema: "unseen-export-v1", generatedAt: now, scope: refs.scope,
    account, spaces, ...privacy };
  const content = Buffer.from(stableJson(artifactObject));
  const digest = sha256(content);
  db.prepare(`INSERT INTO export_artifacts(export_id,content,content_type,sha256,created_at)
    VALUES(?,?,'application/json',?,?)`).run(exportJob.id, content, digest, now);
  const updated = db.prepare("UPDATE export_jobs SET status='ready',object_key=?,version=version+1 WHERE id=? AND version=?")
    .run(`export/${exportJob.id}/${digest}`, exportJob.id, exportJob.version);
  assert(updated.changes === 1, "concurrent_change", 409);
  complete(db, job, { status: "succeeded", result: { exportId: exportJob.id, sha256: digest } }, now);
  return { status: "succeeded", exportId: exportJob.id, sha256: digest };
}

export function dispatchOne(db, jobId, { now = new Date().toISOString(), outcome = null,
  locatorFixture = disabledLocatorFixture, fixtureClassification = null, keyring = null } = {}) {
  return transaction(db, () => {
    const job = db.prepare("SELECT * FROM jobs WHERE id=?").get(jobId);
    assert(job, "job_unavailable", 404);
    if (["succeeded", "failed", "timed_out"].includes(job.status)) {
      return { jobId, status: job.status, replayed: true, result: parseJson(job.result_json) };
    }
    assert(["queued", "running"].includes(job.status), "job_state_conflict", 409);
    const refs = parseJson(job.input_refs_json, {});
    assert(job.type !== "deletion_execution", "async_dispatch_required", 409);
    if (job.type === "panorama_validation") return { jobId, ...panorama(db, job, refs, now) };
    if (job.type === "photo_validation") return { jobId, ...photoValidation(db, job, refs, now, locatorFixture) };
    if (job.type === "photo_placement") return { jobId, ...placement(db, job, refs, now,
      locatorFixture.enabled ? locatorFixture.outcome(refs, fixtureClassification ?? locatorFixture.classification) : outcome) };
    if (job.type === "export_generation") return { jobId, ...exportGeneration(db, job, refs, now, keyring) };
    complete(db, job, { status: "failed", stableError: "job_type_unavailable" }, now);
    return { jobId, status: "failed", stableError: "job_type_unavailable" };
  });
}

export function dispatchAvailable(db, { limit = 100, now = new Date().toISOString(), outcomes = new Map(),
  locatorFixture = disabledLocatorFixture, keyring = null } = {}) {
  const jobs = db.prepare("SELECT id FROM jobs WHERE status='queued' ORDER BY created_at,id LIMIT ?").all(limit);
  return jobs.map(({ id: jobId }) => dispatchOne(db, jobId,
    { now, outcome: outcomes.get(jobId), locatorFixture, keyring }));
}
