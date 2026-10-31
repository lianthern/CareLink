import { ApiError, assert } from "./errors.mjs";
import { inspectMedia } from "./media.mjs";
import { id, json, parseJson, secret, sha256, stableJson } from "./util.mjs";
import { object } from "./schemas.mjs";
import { ticketUploadInfo, uploadWithClaim } from "./ports/media/upload-claim.mjs";

const panoramaUploadConfig = Object.freeze({ table: "panorama_upload_sessions", credentialDomain: "panorama-upload-ticket-v1",
  unavailableCode: "panorama_upload_unavailable", mismatchCode: "panorama_object_mismatch", hardLimitBytes: 32 * 1024 * 1024 });

export class PanoramaService {
  constructor(core, mediaStore, jobs, spaceService, decoderRunner) {
    this.core = core;
    this.db = core.db;
    this.mediaStore = mediaStore;
    this.jobs = jobs;
    this.spaceService = spaceService;
    this.decoderRunner = decoderRunner;
  }

  create(ctx, accountCtx, spaceId) {
    const body = object(ctx.body, ["declaredMime", "declaredBytes", "clientAssetId", "noticeAcknowledgement"],
      ["declaredMime", "declaredBytes", "clientAssetId"]);
    assert(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"].includes(body.declaredMime) &&
      Number.isSafeInteger(Number(body.declaredBytes)) && body.declaredBytes > 0 && body.declaredBytes <= 32 * 1024 * 1024,
    "panorama_media_policy_invalid", 422);
    return this.core.mutation(ctx, { endpoint: `/v1/spaces/${spaceId}/panorama-candidates`, scope: accountCtx.session.id,
      replayClass: "secret_once_envelope",
      reauthorize: () => this.core.accountSpace(this.core.account(ctx.accountSession), spaceId, { scope: "canManageScene" }) }, () => {
      const access = this.core.accountSpace(accountCtx, spaceId, { scope: "canManageScene" });
      this.core.requireIfMatch(ctx, access.space);
      this.spaceService.requireNotice(ctx, "panorama_upload");
      const candidateId = id("pano_c");
      const assetId = id("asset");
      const uploadSessionId = id("pano_u");
      const objectKey = `private/${spaceId}/panorama/${candidateId}/${assetId}`;
      const raw = secret();
      const ticket = this.core.keyring.credential("panorama-upload-ticket-v1", raw);
      const expiresAt = new Date(this.core.nowMs() + 15 * 60_000).toISOString();
      this.db.prepare("INSERT INTO assets(id,space_id,kind,private_object_key,validation_state,version) VALUES(?,?,'panorama',?,'pending',1)")
        .run(assetId, spaceId, objectKey);
      this.db.prepare(`INSERT INTO panorama_candidates(
        id,space_id,asset_id,status,created_by,expires_at,version
      ) VALUES(?,?,?,'created',?,?,1)`).run(candidateId, spaceId, assetId, access.authorizationId, expiresAt);
      this.db.prepare(`INSERT INTO panorama_upload_sessions(
        id,space_id,candidate_id,asset_id,exact_private_object_key,ticket_mac,ticket_key_id,declared_metadata_json,request_hash,expires_at,status,version
      ) VALUES(?,?,?,?,?,?,?,?,?,?,'issued',1)`).run(uploadSessionId, spaceId, candidateId, assetId, objectKey,
      ticket.mac, ticket.keyId, json({ mime: body.declaredMime, bytes: Number(body.declaredBytes) }), sha256(stableJson(body)), expiresAt);
      this.db.prepare("UPDATE panorama_candidates SET current_upload_session_id=? WHERE id=? AND version=1")
        .run(uploadSessionId, candidateId);
      return { candidateId, assetId, uploadSessionId, exactPrivateObjectKey: objectKey,
        exactPrivateUploadTicketOnce: raw, oneTimeSecret: raw, expiresAt, status: "created", version: 1 };
    });
  }

  async uploadByTicket(rawTicket, bytes, contentType) {
    return uploadWithClaim(this.core, this.mediaStore, rawTicket, bytes, contentType, panoramaUploadConfig);
  }

  ticketInfo(rawTicket) {
    return ticketUploadInfo(this.core, rawTicket, panoramaUploadConfig);
  }

  async commit(ctx, accountCtx, uploadSessionId) {
    object(ctx.body, ["clientRequestId"], ["clientRequestId"]);
    const session = this.core.one("SELECT * FROM panorama_upload_sessions WHERE id=?", uploadSessionId);
    assert(session, "panorama_upload_unavailable", 404);
    this.core.accountSpace(accountCtx, session.space_id, { scope: "canManageScene" });
    const operation = this.core.beginAsyncMutation(ctx, { endpoint: `/v1/panorama-upload-sessions/${uploadSessionId}/commits`,
      scope: accountCtx.session.id, replayClass: "completed_state",
      reauthorize: () => this.core.accountSpace(this.core.account(ctx.accountSession), session.space_id, { scope: "canManageScene" })
    }, () => {
      const currentSession = this.core.one("SELECT * FROM panorama_upload_sessions WHERE id=?", uploadSessionId);
      const candidate = this.core.one("SELECT * FROM panorama_candidates WHERE id=?", currentSession?.candidate_id);
      this.core.requireIfMatch(ctx, currentSession);
      assert(candidate && ["created", "uploading"].includes(candidate.status) &&
        candidate.current_upload_session_id === currentSession.id && currentSession.status === "uploaded" &&
        Date.parse(currentSession.expires_at) > this.core.nowMs(), "panorama_upload_unavailable", 404);
      const operationId = id("pano_commit_op");
      const operationExpiresAt = new Date(this.core.nowMs() + 30_000).toISOString();
      const sessionUpdated = this.db.prepare(`UPDATE panorama_upload_sessions SET status='validating',commit_operation_id=?,
        commit_operation_expires_at=?,version=version+1 WHERE id=? AND version=? AND status='uploaded'`)
        .run(operationId, operationExpiresAt, currentSession.id, currentSession.version);
      const candidateUpdated = this.db.prepare(`UPDATE panorama_candidates SET status='validating',version=version+1
        WHERE id=? AND version=? AND status IN ('created','uploading') AND current_upload_session_id=?`)
        .run(candidate.id, candidate.version, currentSession.id);
      this.db.prepare(`UPDATE panorama_upload_sessions SET status='revoked',ticket_mac=NULL,version=version+1
        WHERE candidate_id=? AND id<>? AND status IN ('issued','committing','uploaded')`).run(candidate.id, currentSession.id);
      assert(sessionUpdated.changes === 1 && candidateUpdated.changes === 1, "concurrent_change", 409);
      return { operationId, sessionId: currentSession.id, sessionVersion: currentSession.version + 1,
        candidateId: candidate.id, candidateVersion: candidate.version + 1, assetId: candidate.asset_id,
        spaceId: candidate.space_id, objectKey: currentSession.exact_private_object_key,
        declared: parseJson(currentSession.declared_metadata_json) };
    });
    if (operation.replayed) {
      if (operation.result._error) throw new ApiError(operation.result._error, operation.result._status);
      return operation.result;
    }

    let outcome;
    try {
      const objectValue = await this.mediaStore.get(operation.claim.objectKey, { maxBytes: 32 * 1024 * 1024 });
      const media = await inspectMedia(objectValue.body, { kind: "panorama", declaredMime: operation.claim.declared.mime,
        declaredBytes: operation.claim.declared.bytes, decoderRunner: this.decoderRunner });
      outcome = { media };
    } catch (error) {
      outcome = { errorCode: error.code ?? "panorama_decode_rejected", errorStatus: error.status ?? 422 };
      await this.mediaStore.delete(operation.claim.objectKey).catch(() => {});
    }
    const result = this.core.finishAsyncMutation(operation, (claim) => {
      const candidate = this.core.one("SELECT * FROM panorama_candidates WHERE id=?", claim.candidateId);
      const currentSession = this.core.one("SELECT * FROM panorama_upload_sessions WHERE id=?", claim.sessionId);
      this.core.accountSpace(this.core.account(ctx.accountSession), claim.spaceId, { scope: "canManageScene" });
      assert(candidate?.status === "validating" && candidate.current_upload_session_id === currentSession?.id &&
        candidate.version === claim.candidateVersion && currentSession.status === "validating" &&
        currentSession.commit_operation_id === claim.operationId && currentSession.version === claim.sessionVersion,
      "concurrent_change", 409);
      if (outcome.errorCode) {
        this.db.prepare(`UPDATE panorama_candidates SET status='failed',validation_code=?,failed_at=?,version=version+1
          WHERE id=? AND version=? AND status='validating'`).run(outcome.errorCode, this.core.now(), candidate.id, candidate.version);
        this.db.prepare("UPDATE assets SET validation_state='failed',validation_code=?,version=version+1 WHERE id=?")
          .run(outcome.errorCode, claim.assetId);
        this.db.prepare(`UPDATE panorama_upload_sessions SET status='committed',committed_at=?,commit_operation_id=NULL,
          commit_operation_expires_at=NULL,version=version+1 WHERE id=? AND version=? AND commit_operation_id=?`)
          .run(this.core.now(), currentSession.id, currentSession.version, claim.operationId);
        return { _error: outcome.errorCode, _status: outcome.errorStatus };
      }
      const media = outcome.media;
      const job = this.jobs.enqueue("panorama_validation", candidate.space_id,
        { candidateId: candidate.id, candidateVersion: candidate.version + 1, assetId: candidate.asset_id, assetVersion: 2 });
      this.db.prepare(`UPDATE panorama_upload_sessions SET status='committed',committed_at=?,commit_operation_id=NULL,
        commit_operation_expires_at=NULL,version=version+1 WHERE id=? AND version=? AND commit_operation_id=?`)
        .run(this.core.now(), currentSession.id, currentSession.version, claim.operationId);
      this.db.prepare(`UPDATE assets SET raw_sha256=?,observed_bytes=?,observed_mime=?,width=?,height=?,frame_count=?,
        orientation=?,color_profile=?,metadata_policy_result=?,validation_state='valid',version=version+1 WHERE id=?`)
        .run(media.sha256, media.bytes, media.mime, media.width, media.height, media.frames, media.orientation,
        media.colorProfile, media.metadataPolicyResult, candidate.asset_id);
      this.db.prepare(`UPDATE panorama_candidates SET validation_job_id=?,committed_at=?,validation_code=NULL,version=version+1
        WHERE id=? AND version=? AND status='validating' AND validation_job_id IS NULL`)
        .run(job.jobId, this.core.now(), candidate.id, candidate.version);
      return { candidateId: candidate.id, status: "validating", jobId: job.jobId, panoramaRevisionId: null,
        version: candidate.version + 1 };
    });
    if (result._error) throw new ApiError(result._error, result._status);
    return result;
  }

  status(accountCtx, spaceId, candidateId) {
    this.core.accountSpace(accountCtx, spaceId, { scope: "canManageScene" });
    const candidate = this.core.one("SELECT * FROM panorama_candidates WHERE id=? AND space_id=?", candidateId, spaceId);
    assert(candidate, "panorama_candidate_unavailable", 404);
    const job = candidate.validation_job_id ? this.jobs.get(candidate.validation_job_id) : null;
    return { candidateId, status: candidate.status, validationCode: candidate.validation_code,
      jobStatus: job?.status, panoramaRevisionId: candidate.panorama_revision_id, version: candidate.version };
  }

  reissue(ctx, accountCtx, spaceId, candidateId) {
    object(ctx.body, ["clientRequestId"], ["clientRequestId"]);
    return this.core.mutation(ctx, { endpoint: `/v1/spaces/${spaceId}/panorama-candidates/${candidateId}/upload-sessions`,
      scope: accountCtx.session.id, replayClass: "secret_once_envelope",
      reauthorize: () => this.core.accountSpace(this.core.account(ctx.accountSession), spaceId, { scope: "canManageScene" }) }, () => {
      this.core.accountSpace(accountCtx, spaceId, { scope: "canManageScene" });
      const candidate = this.core.one("SELECT * FROM panorama_candidates WHERE id=? AND space_id=?", candidateId, spaceId);
      assert(candidate && ["created", "uploading"].includes(candidate.status), "panorama_retry_not_allowed", 409);
      this.core.requireIfMatch(ctx, candidate);
      const raw = secret();
      const ticket = this.core.keyring.credential("panorama-upload-ticket-v1", raw);
      const sessionId = id("pano_u");
      let previousSession = this.core.one("SELECT * FROM panorama_upload_sessions WHERE id=? AND candidate_id=?",
        candidate.current_upload_session_id, candidate.id);
      assert(previousSession, "panorama_retry_not_allowed", 409);
      if (["issued", "committing", "uploaded"].includes(previousSession.status) && Date.parse(previousSession.expires_at) <= this.core.nowMs()) {
        this.db.prepare(`UPDATE panorama_upload_sessions SET status='expired',ticket_mac=NULL,upload_claim_id=NULL,
          upload_claim_expires_at=NULL,version=version+1 WHERE id=? AND version=?`).run(previousSession.id, previousSession.version);
        previousSession = { ...previousSession, status: "expired", version: previousSession.version + 1 };
      }
      assert(["expired", "revoked"].includes(previousSession.status), "panorama_retry_not_allowed", 409);
      const objectKey = `private/${spaceId}/panorama/${candidate.id}/${candidate.asset_id}/${sessionId}`;
      const expiresAt = new Date(this.core.nowMs() + 15 * 60_000).toISOString();
      this.db.prepare(`INSERT INTO panorama_upload_sessions(
        id,space_id,candidate_id,asset_id,exact_private_object_key,ticket_mac,ticket_key_id,declared_metadata_json,request_hash,expires_at,status,version
      ) VALUES(?,?,?,?,?,?,?,?,?,?,'issued',1)`).run(sessionId, spaceId, candidate.id, candidate.asset_id, objectKey,
      ticket.mac, ticket.keyId, previousSession.declared_metadata_json, sha256(stableJson(ctx.body)), expiresAt);
      this.db.prepare(`UPDATE panorama_candidates SET status='uploading',current_upload_session_id=?,version=version+1
        WHERE id=? AND version=? AND current_upload_session_id=?`).run(sessionId, candidate.id, candidate.version, previousSession.id);
      return { uploadSessionId: sessionId, exactPrivateObjectKey: objectKey, exactPrivateUploadTicketOnce: raw,
        oneTimeSecret: raw, expiresAt, candidateVersion: candidate.version + 1 };
    });
  }

  retry(ctx, accountCtx, spaceId, candidateId) {
    object(ctx.body, ["clientRequestId"], ["clientRequestId"]);
    return this.core.mutation(ctx, { endpoint: `/v1/spaces/${spaceId}/panorama-candidates/${candidateId}/retries`, scope: accountCtx.session.id,
      reauthorize: () => this.core.accountSpace(this.core.account(ctx.accountSession), spaceId, { scope: "canManageScene" }) }, () => {
      this.core.accountSpace(accountCtx, spaceId, { scope: "canManageScene" });
      const candidate = this.core.one("SELECT * FROM panorama_candidates WHERE id=? AND space_id=?", candidateId, spaceId);
      assert(candidate && candidate.status === "failed" && ["timeout", "storage_unavailable"].includes(candidate.validation_code), "panorama_retry_not_allowed", 409);
      this.core.requireIfMatch(ctx, candidate);
      const asset = this.core.one("SELECT * FROM assets WHERE id=? AND space_id=?", candidate.asset_id, spaceId);
      assert(asset, "panorama_retry_not_allowed", 409);
      const job = this.jobs.enqueue("panorama_validation", spaceId, { candidateId,
        candidateVersion: candidate.version + 1, assetId: candidate.asset_id, assetVersion: asset.version, retry: true });
      this.db.prepare("UPDATE panorama_candidates SET status='validating',validation_job_id=?,validation_code=NULL,version=version+1 WHERE id=? AND version=?")
        .run(job.jobId, candidate.id, candidate.version);
      return { candidateId, status: "validating", jobId: job.jobId, version: candidate.version + 1 };
    });
  }

  switch(ctx, accountCtx, spaceId) {
    const body = object(ctx.body, ["mode", "candidateRevisionId", "targetPanoramaRevisionId", "sceneIfMatchVersion"],
      ["mode", "sceneIfMatchVersion"]);
    assert(["switch", "rollback"].includes(body.mode), "panorama_revision_unavailable", 404);
    const revisionId = body.mode === "switch" ? body.candidateRevisionId : body.targetPanoramaRevisionId;
    return this.core.mutation(ctx, { endpoint: `/v1/spaces/${spaceId}/panorama-switches`, scope: accountCtx.session.id,
      reauthorize: () => this.core.accountSpace(this.core.account(ctx.accountSession), spaceId, { scope: "canManageScene" }) }, () => {
      return this.activate(ctx, accountCtx, spaceId, revisionId, body.sceneIfMatchVersion);
    });
  }

  // Runs inside the caller's mutation transaction. App imports share exactly the
  // same scene/version checks and placement invalidation as canonical switches.
  activate(ctx, accountCtx, spaceId, revisionId, sceneIfMatchVersion) {
    const access = this.core.accountSpace(accountCtx, spaceId, { scope: "canManageScene" });
    const scene = this.core.one("SELECT * FROM scenes WHERE space_id=?", spaceId);
    const revision = this.core.one("SELECT * FROM panorama_revisions WHERE id=? AND space_id=?", revisionId, spaceId);
    this.core.requireIfMatch(ctx, access.space);
    assert(scene && scene.version === Number(sceneIfMatchVersion), "scene_version_conflict", 409);
    assert(revision, "panorama_revision_unavailable", 404);
    const candidate = this.core.one("SELECT * FROM panorama_candidates WHERE id=?", revision.candidate_id);
    assert(candidate?.status === "ready", "panorama_not_ready", 409);
    const previous = access.space.current_panorama_revision_id;
    if (previous === revision.id) return { spaceVersion: access.space.version, sceneVersion: scene.version,
      sceneReadiness: scene.scene_readiness, sceneMode: scene.scene_mode,
      currentPanoramaRevisionId: revision.id, unchanged: true };
    const now = this.core.now();
    if (previous) {
      const retired = this.db.prepare(`UPDATE panorama_revisions SET retired_at=?,version=version+1
        WHERE id=? AND space_id=? AND activated_at IS NOT NULL AND retired_at IS NULL`).run(now, previous, spaceId);
      assert(retired.changes === 1, "concurrent_change", 409);
    }
    const activated = this.db.prepare(`UPDATE panorama_revisions SET activated_at=?,retired_at=NULL,version=version+1
      WHERE id=? AND space_id=? AND version=?`).run(now, revision.id, spaceId, revision.version);
    assert(activated.changes === 1, "concurrent_change", 409);
    this.db.prepare("UPDATE spaces SET current_panorama_revision_id=?,current_world_result_id=NULL,version=version+1,updated_at=? WHERE id=? AND version=?")
      .run(revision.id, now, spaceId, access.space.version);
    this.db.prepare(`UPDATE scenes SET scene_readiness='ready',scene_mode='rotation360',current_derived_asset_id=?,
      version=version+1,updated_at=? WHERE id=? AND version=?`).run(revision.asset_id, now, scene.id, scene.version);
    if (previous && previous !== revision.id) this.invalidatePlacements(ctx, accountCtx, access, scene, previous);
    if (access.space.current_world_result_id) this.db.prepare("UPDATE scene_world_results SET retired_at=? WHERE id=? AND retired_at IS NULL")
      .run(now, access.space.current_world_result_id);
    return { spaceVersion: access.space.version + 1, sceneVersion: scene.version + 1, sceneReadiness: "ready",
      sceneMode: "rotation360", currentPanoramaRevisionId: revision.id };
  }

  invalidatePlacements(ctx, accountCtx, access, scene, previous) {
    const spaceId = access.space.id, now = this.core.now();
    const photos = this.core.all("SELECT * FROM photos WHERE space_id=? AND placement_state='confirmed' AND deleted_at IS NULL", spaceId);
    for (const photo of photos) {
      const current = this.core.one("SELECT * FROM placement_revisions WHERE id=? AND panorama_revision_id=?", photo.current_placement_revision_id, previous);
      if (!current) continue;
      const seq = (this.core.one("SELECT MAX(seq) max FROM placement_revisions WHERE photo_id=?", photo.id)?.max ?? 0) + 1;
      const staleId = id("pr");
      this.db.prepare(`INSERT INTO placement_revisions(
        id,space_id,photo_id,panorama_revision_id,seq,parent_revision_id,placement_state,confirmation_mode,
        auth_kind,authorization_id,auth_snapshot_json,reason_code,request_id,created_at
      ) VALUES(?,?,?,?,?,?,'stale',NULL,?,?,?,'panorama_switched',?,?)`).run(staleId,
      spaceId, photo.id, previous, seq, current.id, access.authKind, access.authorizationId,
      json({ authKind: access.authKind, authorizationId: access.authorizationId,
        actorAccountId: accountCtx.accountId, actorContributorPrincipalId: null, actorServiceJobId: null,
        spaceVersion: access.space.version, membershipVersionSnapshot: access.membership?.version ?? null,
        tasksSnapshot: access.membership ? parseJson(access.membership.tasks_json, []) : ["upload", "view"],
        managementScopesSnapshot: access.membership ? parseJson(access.membership.management_scopes_json, []) : ["canEditPlacement","canInvite","canManageScene","canPublish","canReview"],
        batchReceiptId: null, itemId: photo.batch_item_id, receiptVersionSnapshot: null,
        receiptSessionVersionSnapshot: null,
        itemVersionSnapshot: this.core.one("SELECT version FROM contribution_batch_items WHERE id=?", photo.batch_item_id)?.version,
        placementAuthorizationVersion: this.core.one("SELECT placement_authorization_version FROM contribution_batch_items WHERE id=?", photo.batch_item_id)?.placement_authorization_version,
        sceneVersion: scene.version }), ctx.requestId, this.core.now());
      this.db.prepare("UPDATE photos SET placement_state='stale',confirmation_mode=NULL,current_placement_revision_id=?,version=version+1 WHERE id=? AND version=?")
        .run(staleId, photo.id, photo.version);
    }
    this.db.prepare("UPDATE placement_suggestions SET invalidated_at=?,version=version+1 WHERE space_id=? AND invalidated_at IS NULL")
      .run(now, spaceId);
  }

  history(accountCtx, spaceId) {
    this.core.accountSpace(accountCtx, spaceId, { scope: "canManageScene" });
    const space = this.core.one("SELECT * FROM spaces WHERE id=?", spaceId);
    return { currentPanoramaRevisionId: space.current_panorama_revision_id,
      revisions: this.core.all("SELECT id,ready_at,activated_at,retired_at,version FROM panorama_revisions WHERE space_id=? ORDER BY ready_at", spaceId),
      candidates: this.core.all("SELECT id,status,validation_code,version FROM panorama_candidates WHERE space_id=? ORDER BY rowid") };
  }
}
