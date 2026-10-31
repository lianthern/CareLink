import { transaction } from "../../api/src/database.mjs";
import { assert } from "../../api/src/errors.mjs";
import { id, json, parseJson, sha256 } from "../../api/src/util.mjs";

function assetsFor(db, request) {
  if (request.scope_type === "photo") return db.prepare(`SELECT DISTINCT a.id,a.private_object_key
    FROM photos p JOIN assets a ON a.id IN (p.asset_id,p.viewer_safe_asset_id) WHERE p.id=?`).all(request.scope_id);
  if (request.scope_type === "space") return db.prepare(
    "SELECT id,private_object_key FROM assets WHERE space_id=? ORDER BY id").all(request.scope_id);
  if (request.scope_type === "account") return db.prepare(`SELECT DISTINCT a.id,a.private_object_key
    FROM contribution_batches b JOIN contribution_batch_items i ON i.batch_id=b.id
    LEFT JOIN photos p ON p.id=i.photo_id JOIN assets a ON a.id IN (i.asset_id,p.viewer_safe_asset_id)
    WHERE (b.actor_kind='account' AND b.actor_id=?) OR b.id IN (
      SELECT r.batch_id FROM receipt_account_bindings rb JOIN batch_receipts r ON r.id=rb.batch_receipt_id
      WHERE rb.account_id=?
    ) UNION SELECT a.id,a.private_object_key FROM scene_captures c
      JOIN scene_capture_files f ON f.capture_id=c.id JOIN scene_capture_chunks ch ON ch.file_id=f.id
      JOIN assets a ON a.id=ch.asset_id WHERE c.account_id=? ORDER BY a.id`).all(request.scope_id, request.scope_id, request.scope_id);
  return [];
}

function appendStatus(db, deletionId, status, now, stableError = null) {
  const previous = db.prepare(`SELECT id,seq FROM deletion_status_events
    WHERE deletion_request_id=? ORDER BY seq DESC LIMIT 1`).get(deletionId);
  db.prepare(`INSERT INTO deletion_status_events(
    id,deletion_request_id,seq,previous_event_id,status,stable_error_code,completed_at
  ) VALUES(?,?,?,?,?,?,?)`).run(id("dse"), deletionId, (previous?.seq ?? 0) + 1, previous?.id ?? null,
  status, stableError, ["completed", "failed"].includes(status) ? now : null);
}

function appendAttempt(db, deletionId, { resourceType, resourceId, attemptNo, action, now, requestId }) {
  const previous = db.prepare(`SELECT id,seq FROM deletion_attempt_events
    WHERE deletion_request_id=? ORDER BY seq DESC LIMIT 1`).get(deletionId);
  db.prepare(`INSERT INTO deletion_attempt_events(
    id,deletion_request_id,seq,previous_event_id,resource_type,resource_hash,attempt_no,action,started_at,request_idempotency_id
  ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id("dae"), deletionId, (previous?.seq ?? 0) + 1, previous?.id ?? null,
  resourceType, sha256(resourceId), attemptNo, action, now, requestId);
}

function revokeScope(db, request, now) {
  if (['space', 'account'].includes(request.scope_type)) {
    const field = request.scope_type === 'space' ? 'space_id' : 'account_id';
    db.prepare(`UPDATE scene_captures SET status='cancelled',cancelled_at=COALESCE(cancelled_at,?),
      manifest_json=NULL,manifest_sha256=NULL WHERE ${field}=?`).run(now, request.scope_id);
  }
  if (request.scope_type === "photo") {
    const photo = db.prepare("SELECT * FROM photos WHERE id=?").get(request.scope_id);
    if (!photo) return;
    db.prepare(`UPDATE upload_sessions SET status='revoked',ticket_mac=NULL,upload_claim_id=NULL,
      upload_claim_expires_at=NULL,commit_operation_id=NULL,commit_operation_expires_at=NULL,version=version+1
      WHERE item_id=? AND status IN ('issued','committing','uploaded','validating')`).run(photo.batch_item_id);
    return;
  }
  if (request.scope_type === "space") {
    db.prepare("UPDATE space_memberships SET status='revoked',revoked_at=COALESCE(revoked_at,?),version=version+1 WHERE space_id=? AND status='active'")
      .run(now, request.scope_id);
    db.prepare("UPDATE member_invitations SET revoked_at=COALESCE(revoked_at,?),credential_mac=NULL,version=version+1 WHERE space_id=? AND revoked_at IS NULL AND accepted_at IS NULL")
      .run(now, request.scope_id);
    for (const [table, expiryColumn] of [["viewer_sessions", "access_expires_at"], ["contributor_sessions", "access_expires_at"],
      ["receipt_sessions", "access_expires_at"]]) {
      void expiryColumn;
      db.prepare(`UPDATE ${table} SET revoked_at=COALESCE(revoked_at,?),version=version+1 WHERE space_id=?`).run(now, request.scope_id);
    }
    db.prepare(`UPDATE upload_sessions SET status='revoked',ticket_mac=NULL,upload_claim_id=NULL,
      upload_claim_expires_at=NULL,commit_operation_id=NULL,commit_operation_expires_at=NULL,version=version+1
      WHERE space_id=? AND status IN ('issued','committing','uploaded','validating')`).run(request.scope_id);
    db.prepare(`UPDATE panorama_upload_sessions SET status='revoked',ticket_mac=NULL,upload_claim_id=NULL,
      upload_claim_expires_at=NULL,commit_operation_id=NULL,commit_operation_expires_at=NULL,version=version+1
      WHERE space_id=? AND status IN ('issued','committing','uploaded','validating')`).run(request.scope_id);
    db.prepare("UPDATE external_invitation_campaigns SET campaign_status='revoked',revoked_at=COALESCE(revoked_at,?),version=version+1 WHERE space_id=? AND revoked_at IS NULL")
      .run(now, request.scope_id);
    db.prepare("UPDATE receipt_account_bindings SET revoked_at=COALESCE(revoked_at,?),version=version+1 WHERE space_id=? AND revoked_at IS NULL")
      .run(now, request.scope_id);
    return;
  }
  if (request.scope_type === "account") {
    db.prepare("UPDATE account_session_families SET revoked_at=?,version=version+1 WHERE account_id=? AND revoked_at IS NULL")
      .run(now, request.scope_id);
    db.prepare("UPDATE account_sessions SET revoked_at=?,version=version+1 WHERE account_id=? AND revoked_at IS NULL")
      .run(now, request.scope_id);
    db.prepare("UPDATE reauth_grants SET revoked_at=?,version=version+1 WHERE account_id=? AND revoked_at IS NULL")
      .run(now, request.scope_id);
    db.prepare("UPDATE export_download_authorizations SET revoked_at=?,version=version+1 WHERE account_id=? AND revoked_at IS NULL")
      .run(now, request.scope_id);
    db.prepare("UPDATE space_memberships SET status='revoked',revoked_at=COALESCE(revoked_at,?),version=version+1 WHERE account_id=? AND status='active'")
      .run(now, request.scope_id);
    db.prepare("UPDATE receipt_account_bindings SET revoked_at=COALESCE(revoked_at,?),version=version+1 WHERE account_id=? AND revoked_at IS NULL")
      .run(now, request.scope_id);
    db.prepare(`UPDATE member_invitations SET revoked_at=COALESCE(revoked_at,?),credential_mac=NULL,version=version+1
      WHERE accepted_at IS NULL AND revoked_at IS NULL AND target_identifier_equivalence_id IN
      (SELECT identifier_equivalence_id FROM account_verified_identifiers WHERE account_id=?)`).run(now, request.scope_id);
  }
}

function snapshotRelation(db, request, kind, relationId, context, now) {
  db.prepare(`INSERT OR IGNORE INTO account_deletion_relation_snapshots(
    id,deletion_request_id,relation_kind,relation_hash,context_hash,created_at
  ) VALUES(?,?,?,?,?,?)`).run(id("adrs"), request.id, kind,
  sha256(`${request.id}\0${kind}\0${relationId}`), sha256(`${request.id}\0${json(context)}`), now);
}

function purgeAccountRelations(db, request, now) {
  const memberships = db.prepare("SELECT id,space_id,status,version FROM space_memberships WHERE account_id=? ORDER BY id")
    .all(request.scope_id);
  const bindings = db.prepare(`SELECT id,space_id,batch_receipt_id,version FROM receipt_account_bindings
    WHERE account_id=? ORDER BY id`).all(request.scope_id);
  const membershipIds = new Set(memberships.map((row) => row.id));
  const transfers = db.prepare(`SELECT id,space_id,target_membership_id,status,version FROM owner_transfers
    WHERE from_owner_account_id=? OR target_account_id=? ORDER BY id`).all(request.scope_id, request.scope_id)
    .filter((row) => membershipIds.has(row.target_membership_id) || row.status !== "accepted");
  for (const row of memberships) snapshotRelation(db, request, "membership", row.id,
    { spaceHash: sha256(row.space_id), status: row.status, version: row.version }, now);
  for (const row of bindings) snapshotRelation(db, request, "receipt_binding", row.id,
    { spaceHash: sha256(row.space_id), receiptHash: sha256(row.batch_receipt_id), version: row.version }, now);
  for (const row of transfers) snapshotRelation(db, request, "owner_transfer", row.id,
    { spaceHash: sha256(row.space_id), status: row.status, version: row.version }, now);

  db.prepare(`UPDATE content_cases SET space_id=NULL,actor_account_membership_id=NULL,actor_owner_space_id=NULL,
    actor_membership_version=NULL,actor_owner_space_version=NULL,version=version+1
    WHERE actor_account_id=? AND (actor_account_membership_id IS NOT NULL OR actor_owner_space_id IS NOT NULL)`)
    .run(request.scope_id);
  if (transfers.length) {
    const placeholders = transfers.map(() => "?").join(",");
    db.prepare(`DELETE FROM owner_transfers WHERE id IN (${placeholders})`).run(...transfers.map((row) => row.id));
  }
  db.prepare("DELETE FROM receipt_account_bindings WHERE account_id=?").run(request.scope_id);
  db.prepare("DELETE FROM space_memberships WHERE account_id=?").run(request.scope_id);
}

function finishDomain(db, request, assetIds, now) {
  for (const assetId of assetIds) {
    db.prepare("UPDATE assets SET validation_state='failed',validation_code='deleted',version=version+1 WHERE id=?")
      .run(assetId);
  }
  if (['space', 'account'].includes(request.scope_type)) {
    const field = request.scope_type === 'space' ? 'space_id' : 'account_id';
    db.prepare(`UPDATE scene_capture_chunks SET status='purged' WHERE file_id IN
      (SELECT f.id FROM scene_capture_files f JOIN scene_captures c ON c.id=f.capture_id WHERE c.${field}=?)`).run(request.scope_id);
    db.prepare(`UPDATE scene_capture_files SET name='deleted',client_file_id=id WHERE capture_id IN
      (SELECT id FROM scene_captures WHERE ${field}=?)`).run(request.scope_id);
    db.prepare(`UPDATE scene_captures SET title='deleted',purged_at=COALESCE(purged_at,?),
      manifest_json=NULL,manifest_sha256=NULL WHERE ${field}=?`).run(now, request.scope_id);
  }
  if (request.scope_type === "photo") {
    const photo = db.prepare("SELECT * FROM photos WHERE id=?").get(request.scope_id);
    if (photo) {
      db.prepare("UPDATE photos SET deleted_at=COALESCE(deleted_at,?),version=version+1 WHERE id=?").run(now, photo.id);
      db.prepare(`UPDATE contribution_batch_items SET status='deleted',revoked_at=COALESCE(revoked_at,?),
        deleted_at=COALESCE(deleted_at,?),version=version+1 WHERE id=?`).run(now, now, photo.batch_item_id);
      db.prepare("DELETE FROM placement_suggestions WHERE photo_id=?").run(photo.id);
      db.prepare(`UPDATE jobs SET status='failed',stable_error='scope_deleted',updated_at=?,version=version+1
        WHERE status IN ('queued','running') AND type<>'deletion_execution' AND
        (json_extract(input_refs_json,'$.photoId')=? OR json_extract(input_refs_json,'$.itemId')=?)`)
        .run(now, photo.id, photo.batch_item_id);
    }
  } else if (request.scope_type === "space") {
    db.prepare("UPDATE photos SET deleted_at=COALESCE(deleted_at,?),version=version+1 WHERE space_id=?")
      .run(now, request.scope_id);
    db.prepare(`UPDATE contribution_batch_items SET status='deleted',revoked_at=COALESCE(revoked_at,?),
      deleted_at=COALESCE(deleted_at,?),version=version+1 WHERE space_id=? AND status<>'deleted'`).run(now, now, request.scope_id);
    db.prepare("UPDATE jobs SET status='failed',stable_error='scope_deleted',attempts=attempts+1,updated_at=?,version=version+1 WHERE space_id=? AND status IN ('queued','running') AND type<>'deletion_execution'")
      .run(now, request.scope_id);
    db.prepare("DELETE FROM placement_suggestions WHERE space_id=?").run(request.scope_id);
  } else if (request.scope_type === "account") {
    const items = db.prepare(`SELECT i.id,i.photo_id FROM contribution_batches b JOIN contribution_batch_items i ON i.batch_id=b.id
      WHERE (b.actor_kind='account' AND b.actor_id=?) OR b.id IN (
        SELECT r.batch_id FROM receipt_account_bindings rb JOIN batch_receipts r ON r.id=rb.batch_receipt_id
        WHERE rb.account_id=?
      )`).all(request.scope_id, request.scope_id);
    for (const item of items) {
      if (item.photo_id) {
        db.prepare("UPDATE photos SET deleted_at=COALESCE(deleted_at,?),version=version+1 WHERE id=?").run(now, item.photo_id);
        db.prepare("DELETE FROM placement_suggestions WHERE photo_id=?").run(item.photo_id);
      }
      db.prepare(`UPDATE contribution_batch_items SET status='deleted',revoked_at=COALESCE(revoked_at,?),
        deleted_at=COALESCE(deleted_at,?),version=version+1 WHERE id=?`).run(now, now, item.id);
      db.prepare(`UPDATE jobs SET status='failed',stable_error='scope_deleted',updated_at=?,version=version+1
        WHERE status IN ('queued','running') AND type<>'deletion_execution' AND
        (json_extract(input_refs_json,'$.photoId')=? OR json_extract(input_refs_json,'$.itemId')=?)`)
        .run(now, item.photo_id, item.id);
    }
    db.prepare("UPDATE account_verified_identifiers SET status='revoked',revoked_at=COALESCE(revoked_at,?),version=version+1 WHERE account_id=? AND status='active'")
      .run(now, request.scope_id);
    db.prepare(`UPDATE account_verified_identifier_aliases SET display_mask='deleted',status='retired',version=version+1
      WHERE identifier_equivalence_id IN (
        SELECT identifier_equivalence_id FROM account_verified_identifiers WHERE account_id=?
      ) AND status<>'retired'`).run(request.scope_id);
    db.prepare("DELETE FROM export_artifacts WHERE export_id IN (SELECT id FROM export_jobs WHERE account_id=?)")
      .run(request.scope_id);
    db.prepare("UPDATE export_jobs SET status='failed',object_key=NULL,version=version+1 WHERE account_id=? AND status<>'failed'")
      .run(request.scope_id);
    purgeAccountRelations(db, request, now);
    db.prepare("UPDATE accounts SET status='deleted',deleted_at=?,version=version+1 WHERE id=? AND status='deleting'")
      .run(now, request.scope_id);
  }
}

export async function dispatchDeletion(db, mediaStore, jobId, { now = new Date().toISOString(),
  leaseOwner = id("deletion-lease"), leaseMs = 60_000, afterClaim = null, afterObject = null } = {}) {
  assert(mediaStore && typeof mediaStore.delete === "function" && typeof mediaStore.head === "function",
    "media_store_unavailable", 503);
  const nowMs = Date.parse(now);
  assert(Number.isFinite(nowMs) && Number.isSafeInteger(leaseMs) && leaseMs >= 1_000,
    "job_input_unavailable", 409);
  const claimExpiresAt = new Date(nowMs + leaseMs).toISOString();
  const claim = transaction(db, () => {
    const job = db.prepare("SELECT * FROM jobs WHERE id=?").get(jobId);
    assert(job && job.type === "deletion_execution", "job_unavailable", 404);
    if (job.status === "succeeded") return { replayed: true, job };
    const refs = parseJson(job.input_refs_json, {});
    const request = db.prepare("SELECT * FROM deletion_requests WHERE id=?").get(refs.deletionId);
    const fresh = job.status === "queued" && request?.status === "queued" && !request.claim_owner;
    const stale = job.status === "running" && request?.status === "running" && request.claim_owner &&
      Date.parse(request.claim_expires_at) <= nowMs;
    assert(fresh || stale, job.status === "running" ? "job_state_conflict" : "job_input_unavailable", 409);
    const updated = fresh ? db.prepare(`UPDATE deletion_requests
      SET status='running',claim_owner=?,claim_expires_at=?,version=version+1
      WHERE id=? AND version=? AND status='queued' AND claim_owner IS NULL`).run(
    leaseOwner, claimExpiresAt, request.id, request.version) : db.prepare(`UPDATE deletion_requests
      SET claim_owner=?,claim_expires_at=?,version=version+1
      WHERE id=? AND version=? AND status='running' AND claim_owner=? AND claim_expires_at=?`).run(
    leaseOwner, claimExpiresAt, request.id, request.version, request.claim_owner, request.claim_expires_at);
    assert(updated.changes === 1, "concurrent_change", 409);
    const claimedJob = db.prepare(`UPDATE jobs SET status='running',attempts=attempts+1,stable_error=NULL,updated_at=?,version=version+1
      WHERE id=? AND version=? AND status=?`).run(now, job.id, job.version, job.status);
    assert(claimedJob.changes === 1, "concurrent_change", 409);
    appendStatus(db, request.id, "running", now);
    appendAttempt(db, request.id, { resourceType: request.scope_type, resourceId: request.scope_id,
      attemptNo: job.attempts + 1, action: stale ? "lease_reclaim" : "lease_claim", now, requestId: `job:${job.id}` });
    revokeScope(db, request, now);
    return { replayed: false, leaseOwner,
      request: { ...request, status: "running", claim_owner: leaseOwner, claim_expires_at: claimExpiresAt,
        version: request.version + 1 },
      job: { ...job, status: "running", attempts: job.attempts + 1, version: job.version + 1 },
      assets: assetsFor(db, request) };
  });
  if (claim.replayed) return { jobId, status: claim.job.status, replayed: true, result: parseJson(claim.job.result_json) };
  afterClaim?.(claim);

  const outcomes = [];
  for (let index = 0; index < claim.assets.length; index += 1) {
    const asset = claim.assets[index];
    try {
      await mediaStore.delete(asset.private_object_key);
      outcomes.push({ asset, deleted: !(await mediaStore.head(asset.private_object_key)).exists });
    }
    catch { outcomes.push({ asset, deleted: false }); }
    afterObject?.({ claim, index, outcome: outcomes.at(-1) });
  }
  const failure = outcomes.some((outcome) => !outcome.deleted) ? "media_delete_failed" : null;

  return transaction(db, () => {
    const request = db.prepare("SELECT * FROM deletion_requests WHERE id=?").get(claim.request.id);
    const job = db.prepare("SELECT * FROM jobs WHERE id=?").get(jobId);
    assert(request?.status === "running" && request.version === claim.request.version &&
      request.claim_owner === claim.leaseOwner &&
      job?.status === "running" && job.version === claim.job.version, "concurrent_change", 409);
    let seq = db.prepare("SELECT COALESCE(MAX(seq),0) seq FROM deletion_attempt_events WHERE deletion_request_id=?")
      .get(request.id).seq;
    let previousAttempt = db.prepare(`SELECT id FROM deletion_attempt_events WHERE deletion_request_id=?
      ORDER BY seq DESC LIMIT 1`).get(request.id)?.id ?? null;
    for (const outcome of outcomes) {
      seq += 1;
      db.prepare(`INSERT INTO deletion_attempt_events(
        id,deletion_request_id,seq,previous_event_id,resource_type,resource_hash,attempt_no,action,started_at,request_idempotency_id
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id("dae"), request.id, seq, previousAttempt, "asset",
      sha256(outcome.asset.id), job.attempts, outcome.deleted ? "delete_media" : "delete_media_failed", now, `job:${job.id}`);
      previousAttempt = db.prepare(`SELECT id FROM deletion_attempt_events WHERE deletion_request_id=? AND seq=?`)
        .get(request.id, seq).id;
    }
    if (failure) {
      db.prepare(`UPDATE deletion_requests SET status='queued',claim_owner=NULL,claim_expires_at=NULL,version=version+1
        WHERE id=? AND version=? AND claim_owner=?`).run(request.id, request.version, claim.leaseOwner);
      db.prepare("UPDATE jobs SET status='queued',stable_error=?,result_json=?,updated_at=?,version=version+1 WHERE id=? AND version=?")
        .run(failure, json({ deletionId: request.id }), now, job.id, job.version);
      appendStatus(db, request.id, "retryable", now, failure);
      return { jobId, deletionId: request.id, status: "retryable", stableError: failure };
    }
    finishDomain(db, request, claim.assets.map((asset) => asset.id), now);
    db.prepare(`UPDATE deletion_requests SET status='completed',completed_at=?,claim_owner=NULL,claim_expires_at=NULL,
      version=version+1 WHERE id=? AND version=? AND claim_owner=?`).run(now, request.id, request.version, claim.leaseOwner);
    db.prepare("UPDATE jobs SET status='succeeded',result_json=?,updated_at=?,version=version+1 WHERE id=? AND version=?")
      .run(json({ deletionId: request.id, deletedAssets: claim.assets.length }), now, job.id, job.version);
    appendStatus(db, request.id, "completed", now);
    return { jobId, deletionId: request.id, status: "succeeded", deletedAssets: claim.assets.length };
  });
}
