import { assert } from "./errors.mjs";
import { transaction } from "./database.mjs";
import { id, json, secret, sha256 } from "./util.mjs";
import { object } from "./schemas.mjs";

export class LifecycleService {
  constructor(core, identity, spaceService, jobs) {
    this.core = core;
    this.db = core.db;
    this.identity = identity;
    this.spaceService = spaceService;
    this.jobs = jobs;
  }

  createExport(ctx, accountCtx) {
    const body = object(ctx.body, ["scope", "spaceId", "format", "reauthGrant"], ["scope", "format"]);
    assert(["account", "space"].includes(body.scope), "export_unavailable", 400);
    if (body.scope === "space") this.core.accountSpace(accountCtx, body.spaceId, { ownerOnly: true, allowArchived: true });
    return this.core.mutation(ctx, { endpoint: "/v1/exports", scope: accountCtx.session.id,
      reauthorize: () => body.scope === "space" ? this.core.accountSpace(this.core.account(ctx.accountSession),
        body.spaceId, { ownerOnly: true, allowArchived: true }) : this.core.account(ctx.accountSession) }, () => {
      const exportId = id("export");
      const expiresAt = new Date(this.core.nowMs() + 7 * 24 * 60 * 60_000).toISOString();
      this.db.prepare(`INSERT INTO export_jobs(
        id,account_id,space_id,scope,status,expires_at,created_at,version
      ) VALUES(?,?,?,?, 'queued',?,?,1)`).run(exportId, accountCtx.accountId, body.spaceId ?? null, body.scope, expiresAt, this.core.now());
      const job = this.jobs.enqueue("export_generation", body.spaceId ?? `account:${accountCtx.accountId}`,
        { exportId, accountId: accountCtx.accountId, scope: body.scope, spaceId: body.spaceId ?? null, format: body.format });
      return { exportId, jobId: job.jobId, scope: body.scope, status: "queued", expiresAt, version: 1 };
    });
  }

  exportStatus(accountCtx, exportId) {
    const job = this.core.one("SELECT * FROM export_jobs WHERE id=? AND account_id=?", exportId, accountCtx.accountId);
    assert(job, "export_unavailable", 404);
    if (job.space_id) this.core.accountSpace(accountCtx, job.space_id, { ownerOnly: true, allowArchived: true });
    return { exportId, status: job.status, expiresAt: job.expires_at, version: job.version };
  }

  download(ctx, accountCtx, exportId) {
    const body = object(ctx.body, ["clientNonce"], ["clientNonce"]);
    return this.core.mutation(ctx, { endpoint: `/v1/exports/${exportId}/download-authorizations`, scope: accountCtx.session.id,
      replayClass: "credential_reissue", reissue: (completed) => this.issueDownload(accountCtx, exportId, completed.authorizationId) }, () => {
      const job = this.core.one("SELECT * FROM export_jobs WHERE id=? AND account_id=?", exportId, accountCtx.accountId);
      assert(job && job.status === "ready" && Date.parse(job.expires_at) > this.core.nowMs(), job ? "export_not_ready" : "export_unavailable", 409);
      if (job.space_id) this.core.accountSpace(accountCtx, job.space_id, { ownerOnly: true, allowArchived: true });
      return this.issueDownload(accountCtx, exportId);
    });
  }

  issueDownload(accountCtx, exportId, authorizationId = null) {
    const job = this.core.one("SELECT * FROM export_jobs WHERE id=? AND account_id=?", exportId, accountCtx.accountId);
    assert(job && job.status === "ready" && Date.parse(job.expires_at) > this.core.nowMs(), job ? "export_not_ready" : "export_unavailable", 409);
    if (job.space_id) this.core.accountSpace(accountCtx, job.space_id, { ownerOnly: true, allowArchived: true });
    const raw = secret();
    const credential = this.core.keyring.credential("export-download-v1", raw);
    const expiresAt = new Date(this.core.nowMs() + 5 * 60_000).toISOString();
    const idValue = authorizationId ?? id("download");
    if (authorizationId) {
      const existing = this.core.one("SELECT * FROM export_download_authorizations WHERE id=? AND export_id=? AND account_id=?",
        authorizationId, exportId, accountCtx.accountId);
      assert(existing, "export_unavailable", 404);
      this.db.prepare(`UPDATE export_download_authorizations SET account_session_id=?,credential_mac=?,credential_key_id=?,
        expires_at=?,consumed_at=NULL,revoked_at=NULL,version=version+1 WHERE id=? AND version=?`).run(accountCtx.session.id,
      credential.mac, credential.keyId, expiresAt, existing.id, existing.version);
    } else {
      this.db.prepare(`INSERT INTO export_download_authorizations(
        id,export_id,account_id,account_session_id,credential_mac,credential_key_id,expires_at,version
      ) VALUES(?,?,?,?,?,?,?,1)`).run(idValue, exportId, accountCtx.accountId, accountCtx.session.id,
      credential.mac, credential.keyId, expiresAt);
    }
    const updated = this.db.prepare("UPDATE export_jobs SET version=version+1 WHERE id=? AND version=?").run(job.id, job.version);
    assert(updated.changes === 1, "concurrent_change", 409);
    return { exportId, authorizationId: idValue, downloadUrl: `/v1/exports/${exportId}/downloads`,
      authorizationHeader: "X-Export-Download", authorizationSecret: raw,
      expiresAt, oneTime: true, version: job.version + 1 };
  }

  downloadArtifact(ctx, accountCtx, exportId, raw) {
    assert(typeof raw === "string" && raw.length > 0, "download_expired", 404);
    return transaction(this.db, () => {
      const authorization = this.core.credentialRow("export_download_authorizations", "export-download-v1", raw);
      assert(authorization && !authorization.consumed_at && !authorization.revoked_at &&
        authorization.export_id === exportId && authorization.account_id === accountCtx.accountId &&
        authorization.account_session_id === accountCtx.session.id &&
        Date.parse(authorization.expires_at) > this.core.nowMs(), "download_expired", 404);
      const job = this.core.one("SELECT * FROM export_jobs WHERE id=? AND account_id=? AND status='ready'", exportId, accountCtx.accountId);
      assert(job && Date.parse(job.expires_at) > this.core.nowMs(), "export_unavailable", 404);
      if (job.space_id) this.core.accountSpace(accountCtx, job.space_id, { ownerOnly: true, allowArchived: true });
      const artifact = this.core.one("SELECT * FROM export_artifacts WHERE export_id=?", exportId);
      assert(artifact, "export_not_ready", 409);
      const consumed = this.db.prepare("UPDATE export_download_authorizations SET consumed_at=?,version=version+1 WHERE id=? AND version=? AND consumed_at IS NULL")
        .run(this.core.now(), authorization.id, authorization.version);
      assert(consumed.changes === 1, "download_expired", 404);
      return { _raw: Buffer.from(artifact.content), contentType: artifact.content_type, fileName: `${exportId}.json` };
    });
  }

  issueDeletionStatusSession(deletionId, createdByIdempotencyRecordId) {
    const raw = secret();
    const credential = this.core.keyring.credential("deletion-status-session-v1", raw);
    const sessionId = id("deletion_status");
    const accessExpiresAt = new Date(this.core.nowMs() + 90 * 24 * 60 * 60_000).toISOString();
    this.db.prepare(`INSERT INTO deletion_status_sessions(
      id,deletion_request_id,created_by_idempotency_record_id,credential_mac,credential_key_id,
      access_expires_at,created_at,version
    ) VALUES(?,?,?,?,?,?,?,1)`).run(sessionId, deletionId, createdByIdempotencyRecordId,
    credential.mac, credential.keyId, accessExpiresAt, this.core.now());
    return { deletionStatusSessionId: sessionId, deletionStatusSessionSecret: raw, accessExpiresAt };
  }

  rotateDeletionStatusSession(completed, replay) {
    const deletion = this.core.one("SELECT * FROM deletion_requests WHERE id=?", completed.deletionId);
    const session = this.core.one("SELECT * FROM deletion_status_sessions WHERE id=? AND deletion_request_id=?",
      completed.deletionStatusSessionId, completed.deletionId);
    if (!(deletion && deletion.scope_type === "account" && session &&
      session.created_by_idempotency_record_id === replay.record.id && !session.revoked_at &&
      Date.parse(session.access_expires_at) > this.core.nowMs())) {
      return { deletionId: completed.deletionId, status: deletion?.status ?? "completed",
        requestedAt: deletion?.requested_at ?? completed.requestedAt, credentialUnavailable: true,
        _clearAccountSessionCookie: true };
    }
    const raw = secret();
    const credential = this.core.keyring.credential("deletion-status-session-v1", raw);
    const updated = this.db.prepare(`UPDATE deletion_status_sessions SET credential_mac=?,credential_key_id=?,
      version=version+1 WHERE id=? AND version=? AND revoked_at IS NULL`).run(
    credential.mac, credential.keyId, session.id, session.version);
    assert(updated.changes === 1, "concurrent_change", 409);
    return { deletionId: deletion.id, status: deletion.status, requestedAt: deletion.requested_at,
      deletionStatusSessionId: session.id, deletionStatusSessionSecret: raw,
      accessExpiresAt: session.access_expires_at, _clearAccountSessionCookie: true };
  }

  recordDeletion(ctx, { scopeType, scopeId, requester, mutate = () => {}, createdByIdempotencyRecordId = null }) {
    const deletionId = id("deletion");
    const now = this.core.now();
    mutate(now);
    this.db.prepare(`INSERT INTO deletion_requests(
      id,scope_type,scope_id,requester_json,status,ledger_id,requested_at,version
    ) VALUES(?,?,?,?, 'queued',?,?,1)`).run(deletionId, scopeType, scopeId, json(requester), `ledger_${deletionId}`, now);
    const attemptId = id("dae");
    this.db.prepare(`INSERT INTO deletion_attempt_events(
      id,deletion_request_id,seq,resource_type,resource_hash,attempt_no,action,started_at,request_idempotency_id
    ) VALUES(?,?,1,?,?,1,'revoke_first',?,?)`).run(attemptId, deletionId, scopeType, sha256(scopeId), now, ctx.idempotencyKey);
    this.db.prepare(`INSERT INTO deletion_status_events(
      id,deletion_request_id,seq,previous_event_id,status
    ) VALUES(?,?,1,NULL,'queued')`).run(id("dse"), deletionId);
    const job = this.jobs.enqueue("deletion_execution", scopeType === "space" ? scopeId : `${scopeType}:${scopeId}`,
      { deletionId, scopeType, scopeId, requestVersion: 1 });
    const statusSession = scopeType === "account" ?
      this.issueDeletionStatusSession(deletionId, createdByIdempotencyRecordId) : null;
    return { deletionId, jobId: job.jobId, scopeType, status: "queued", requestedAt: now, version: 1,
      ...(statusSession ?? {}) };
  }

  revokePhotoAccess(photo, now) {
    this.db.prepare(`UPDATE upload_sessions SET status='revoked',ticket_mac=NULL,upload_claim_id=NULL,
      upload_claim_expires_at=NULL,commit_operation_id=NULL,commit_operation_expires_at=NULL,version=version+1
      WHERE item_id=? AND status IN ('issued','committing','uploaded','validating')`).run(photo.batch_item_id);
    this.db.prepare("UPDATE placement_suggestions SET invalidated_at=COALESCE(invalidated_at,?),version=version+1 WHERE photo_id=?")
      .run(now, photo.id);
    this.db.prepare(`UPDATE jobs SET status='failed',stable_error='scope_deleted',updated_at=?,version=version+1
      WHERE status IN ('queued','running') AND type<>'deletion_execution' AND
      (json_extract(input_refs_json,'$.photoId')=? OR json_extract(input_refs_json,'$.itemId')=?)`)
      .run(now, photo.id, photo.batch_item_id);
  }

  revokeSpaceAccess(spaceId, now) {
    this.db.prepare("UPDATE space_memberships SET status='revoked',revoked_at=COALESCE(revoked_at,?),version=version+1 WHERE space_id=? AND status='active'")
      .run(now, spaceId);
    this.db.prepare("UPDATE member_invitations SET revoked_at=COALESCE(revoked_at,?),credential_mac=NULL,version=version+1 WHERE space_id=? AND revoked_at IS NULL AND accepted_at IS NULL")
      .run(now, spaceId);
    this.db.prepare("UPDATE owner_transfers SET status='revoked',revoked_at=COALESCE(revoked_at,?),version=version+1 WHERE space_id=? AND status='pending'")
      .run(now, spaceId);
    for (const table of ["viewer_sessions", "contributor_sessions", "receipt_sessions"]) {
      this.db.prepare(`UPDATE ${table} SET revoked_at=COALESCE(revoked_at,?),version=version+1 WHERE space_id=? AND revoked_at IS NULL`)
        .run(now, spaceId);
    }
    for (const table of ["viewer_principals", "contributor_principals"]) {
      this.db.prepare(`UPDATE ${table} SET revoked_at=COALESCE(revoked_at,?),version=version+1 WHERE space_id=? AND revoked_at IS NULL`)
        .run(now, spaceId);
    }
    this.db.prepare("UPDATE batch_receipts SET revoked_at=COALESCE(revoked_at,?),credential_mac=NULL,version=version+1 WHERE space_id=? AND revoked_at IS NULL")
      .run(now, spaceId);
    this.db.prepare("UPDATE receipt_account_bindings SET revoked_at=COALESCE(revoked_at,?),version=version+1 WHERE space_id=? AND revoked_at IS NULL")
      .run(now, spaceId);
    this.db.prepare("UPDATE external_invitation_campaigns SET campaign_status='revoked',revoked_at=COALESCE(revoked_at,?),version=version+1 WHERE space_id=? AND revoked_at IS NULL")
      .run(now, spaceId);
    this.db.prepare(`UPDATE upload_sessions SET status='revoked',ticket_mac=NULL,upload_claim_id=NULL,
      upload_claim_expires_at=NULL,commit_operation_id=NULL,commit_operation_expires_at=NULL,version=version+1
      WHERE space_id=? AND status IN ('issued','committing','uploaded','validating')`).run(spaceId);
    this.db.prepare(`UPDATE panorama_upload_sessions SET status='revoked',ticket_mac=NULL,upload_claim_id=NULL,
      upload_claim_expires_at=NULL,commit_operation_id=NULL,commit_operation_expires_at=NULL,version=version+1
      WHERE space_id=? AND status IN ('issued','committing','uploaded','validating')`).run(spaceId);
    this.db.prepare(`UPDATE case_access_sessions SET revoked_at=COALESCE(revoked_at,?),version=version+1
      WHERE case_id IN (SELECT id FROM content_cases WHERE space_id=?) AND revoked_at IS NULL`).run(now, spaceId);
  }

  revokeAccountAccess(accountId, now) {
    this.db.prepare("UPDATE account_session_families SET revoked_at=COALESCE(revoked_at,?),version=version+1 WHERE account_id=?")
      .run(now, accountId);
    this.db.prepare("UPDATE account_sessions SET revoked_at=COALESCE(revoked_at,?),version=version+1 WHERE account_id=?")
      .run(now, accountId);
    this.db.prepare("UPDATE reauth_grants SET revoked_at=COALESCE(revoked_at,?),version=version+1 WHERE account_id=?")
      .run(now, accountId);
    this.db.prepare("UPDATE export_download_authorizations SET revoked_at=COALESCE(revoked_at,?),version=version+1 WHERE account_id=?")
      .run(now, accountId);
    this.db.prepare("UPDATE space_memberships SET status='revoked',revoked_at=COALESCE(revoked_at,?),version=version+1 WHERE account_id=? AND status='active'")
      .run(now, accountId);
    this.db.prepare("UPDATE receipt_account_bindings SET revoked_at=COALESCE(revoked_at,?),version=version+1 WHERE account_id=? AND revoked_at IS NULL")
      .run(now, accountId);
    this.db.prepare(`UPDATE member_invitations SET revoked_at=COALESCE(revoked_at,?),credential_mac=NULL,version=version+1
      WHERE accepted_at IS NULL AND revoked_at IS NULL AND target_identifier_equivalence_id IN
      (SELECT identifier_equivalence_id FROM account_verified_identifiers WHERE account_id=?)`).run(now, accountId);
    this.db.prepare("UPDATE case_access_sessions SET revoked_at=COALESCE(revoked_at,?),version=version+1 WHERE account_id=? AND revoked_at IS NULL")
      .run(now, accountId);
  }

  deletion(ctx, accountCtx, { scopeType, scopeId, endpoint, reauth, actionId, purpose, ifMatchRow, mutate }) {
    return this.core.mutation(ctx, { endpoint, scope: accountCtx.session.id, reauthorize: () => {
      const current = this.core.account(ctx.accountSession);
      return scopeType === "space" ? this.core.accountSpace(current, scopeId, { ownerOnly: true, allowArchived: true }) : current;
    } }, () => {
      if (reauth) this.identity.consumeReauth(reauth, accountCtx, { actionId, purpose,
        targetType: scopeType, targetId: scopeId });
      if (ifMatchRow) this.core.requireIfMatch(ctx, ifMatchRow);
      return this.recordDeletion(ctx, { scopeType, scopeId, requester: { accountId: accountCtx.accountId }, mutate });
    });
  }

  deleteSpace(ctx, accountCtx, spaceId) {
    const body = object(ctx.body, ["reauthGrant", "reason", "confirmation"], ["reauthGrant", "confirmation"]);
    assert(body.confirmation === true, "deletion_not_allowed", 409);
    const access = this.core.accountSpace(accountCtx, spaceId, { ownerOnly: true, allowArchived: true });
    const result = this.deletion(ctx, accountCtx, { scopeType: "space", scopeId: spaceId,
      endpoint: `/v1/spaces/${spaceId}/deletion-requests`, reauth: body.reauthGrant,
      actionId: "SPACE.DELETE_REQUEST", purpose: "space_delete", ifMatchRow: access.space,
      mutate: (now) => {
        this.db.prepare("UPDATE spaces SET space_lifecycle='archived',collection_state='paused',sharing_state='private',version=version+1 WHERE id=? AND version=?")
          .run(spaceId, access.space.version);
        this.revokeSpaceAccess(spaceId, now);
      } });
    return result;
  }

  deleteAccount(ctx) {
    const body = object(ctx.body, ["reauthGrant", "confirmation"], ["reauthGrant", "confirmation"]);
    assert(body.confirmation === true, "deletion_not_allowed", 409);
    const presentedGrant = this.identity.reauthGrant(body.reauthGrant);
    assert(presentedGrant && presentedGrant.bound_action_id === "ACCOUNT.DELETE_REQUEST" &&
      presentedGrant.purpose === "account_delete", "reauth_required", 403);
    return this.core.mutation(ctx, { endpoint: "/v1/me/deletion-requests",
      scope: `reauth-grant:${presentedGrant.id}`, replayClass: "credential_reissue", reauthorize: () => {},
      reissue: (completed, replay) => this.rotateDeletionStatusSession(completed, replay) }, ({ recordId }) => {
      const accountCtx = this.core.account(ctx.accountSession);
      assert(presentedGrant.account_id === accountCtx.accountId &&
        presentedGrant.issued_session_epoch === accountCtx.account.session_epoch &&
        !presentedGrant.consumed_at && !presentedGrant.revoked_at &&
        Date.parse(presentedGrant.expires_at) > this.core.nowMs() &&
        (presentedGrant.bound_target_type ?? null) === "account" &&
        presentedGrant.bound_target_id === accountCtx.accountId, "reauth_required", 403);
      assert(!this.core.one("SELECT 1 FROM spaces WHERE owner_account_id=?", accountCtx.accountId),
        "owner_disposition_required", 409);
      if(this.core.one("SELECT admin_role FROM account_administration WHERE account_id=?",accountCtx.accountId)?.admin_role==='super_admin') {
        assert(this.core.one("SELECT COUNT(*) n FROM account_administration m JOIN accounts a ON a.id=m.account_id WHERE m.is_admin=1 AND m.admin_role='super_admin' AND m.status='active' AND a.status='active'").n>1,"last_super_admin_required",409);
      }
      if (this.core.one("SELECT is_admin FROM account_administration WHERE account_id=?",accountCtx.accountId)?.is_admin === 1) {
        assert(this.core.one("SELECT COUNT(*) n FROM account_administration m JOIN accounts a ON a.id=m.account_id WHERE m.is_admin=1 AND m.status='active' AND a.status='active'").n > 1, "last_admin_required", 409);
      }
      this.core.requireIfMatch(ctx, accountCtx.account);
      this.identity.consumeReauth(body.reauthGrant, accountCtx, { actionId: "ACCOUNT.DELETE_REQUEST",
        purpose: "account_delete", targetType: "account", targetId: accountCtx.accountId });
      const result = this.recordDeletion(ctx, { scopeType: "account", scopeId: accountCtx.accountId,
        requester: { accountId: accountCtx.accountId }, createdByIdempotencyRecordId: recordId, mutate: (now) => {
          this.db.prepare(`UPDATE accounts SET status='deleting',session_epoch=session_epoch+1,version=version+1
            WHERE id=? AND version=?`).run(accountCtx.accountId, accountCtx.account.version);
          this.revokeAccountAccess(accountCtx.accountId, now);
          this.db.prepare("DELETE FROM personal_memories WHERE account_id=?").run(accountCtx.accountId);
          this.db.prepare("DELETE FROM password_recovery_requests WHERE account_id=?").run(accountCtx.accountId);
          this.db.prepare("DELETE FROM moment_submissions WHERE account_id=?").run(accountCtx.accountId);
          this.db.prepare("DELETE FROM account_administration WHERE account_id=?").run(accountCtx.accountId);
          this.db.prepare("DELETE FROM account_password_credentials WHERE account_id=?").run(accountCtx.accountId);
        } });
      return { deletionId: result.deletionId, status: result.status, requestedAt: result.requestedAt,
        deletionStatusSessionId: result.deletionStatusSessionId,
        deletionStatusSessionSecret: result.deletionStatusSessionSecret,
        accessExpiresAt: result.accessExpiresAt, _clearAccountSessionCookie: true };
    });
  }

  deletePhoto(ctx, accountCtx, photo, reauthGrant = null) {
    const item = this.core.one("SELECT * FROM contribution_batch_items WHERE id=?", photo.batch_item_id);
    if (accountCtx) {
      this.core.accountSpace(accountCtx, photo.space_id, { ownerOnly: true });
      this.identity.consumeReauth(reauthGrant, accountCtx, { actionId: "BATCH.DELETE_ITEM", purpose: "photo_delete",
        targetType: "photo", targetId: photo.id });
    }
    this.db.prepare("UPDATE contribution_batch_items SET revoked_at=?,deleted_at=?,version=version+1 WHERE id=?")
      .run(this.core.now(), this.core.now(), item.id);
    this.db.prepare("UPDATE photos SET deleted_at=?,captured_at=NULL,version=version+1 WHERE id=?")
      .run(this.core.now(), photo.id);
    this.revokePhotoAccess(photo, this.core.now());
  }

  deletionStatus(ctx, deletionId) {
    const row = this.core.one("SELECT * FROM deletion_requests WHERE id=?", deletionId);
    assert(row, "deletion_request_unavailable", 404);
    const requester = JSON.parse(row.requester_json);
    if (row.scope_type === "account") {
      const status = this.core.deletionStatus(ctx.deletionStatusSession);
      assert(status.session.deletion_request_id === row.id, "deletion_request_unavailable", 404);
    } else if (ctx.accountSession) {
      const accountCtx = this.core.account(ctx.accountSession);
      assert(requester.accountId === accountCtx.accountId, "deletion_request_unavailable", 404);
      if (row.scope_type === "space") this.core.accountSpace(accountCtx, row.scope_id,
        { ownerOnly: true, allowArchived: true });
    } else {
      const receipt = this.core.receipt(ctx.receiptSession);
      assert(requester.receiptSessionId === receipt.session.id && row.scope_type === "photo",
        "deletion_request_unavailable", 404);
      const photo = this.core.one("SELECT * FROM photos WHERE id=? AND batch_id=? AND space_id=?",
        row.scope_id, receipt.batch.id, receipt.space.id);
      assert(photo, "deletion_request_unavailable", 404);
    }
    return { deletionId, scopeType: row.scope_type, status: row.status, version: row.version,
      events: this.core.all("SELECT seq,status,stable_error_code stableErrorCode,completed_at completedAt FROM deletion_status_events WHERE deletion_request_id=? ORDER BY seq", row.id) };
  }
}
