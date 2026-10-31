import { ApiError, assert } from "./errors.mjs";
import { createViewerSafeDerivative, inspectMedia } from "./media.mjs";
import { createPlayableVideoDerivative, inspectVideo, VIDEO_HARD_LIMIT_BYTES, VIDEO_MAX_DISPLAY_LONG_EDGE,
  VIDEO_MAX_DISPLAY_SHORT_EDGE, VIDEO_MAX_DURATION_MS, VIDEO_MIME_TYPES } from "./video.mjs";
import { id, json, parseJson, redact, secret, sha256, stableJson } from "./util.mjs";
import { transaction } from "./database.mjs";
import { object } from "./schemas.mjs";
import { ticketUploadInfo, uploadWithClaim } from "./ports/media/upload-claim.mjs";
import { assertUploadAuthorization } from "./ports/media/upload-authorization-port.mjs";
import { MEDIA_NOTICE_V2_NOTICE } from "./media-notice.mjs";

const PHOTO_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
const ALL_UPLOAD_MIME_TYPES = [...PHOTO_MIME_TYPES, ...VIDEO_MIME_TYPES];
const PHOTO_HARD_LIMIT_BYTES = 20 * 1024 * 1024;
const isVideoMime = (mime) => VIDEO_MIME_TYPES.includes(mime);
const hardLimitFor = (mime) => (isVideoMime(mime) ? VIDEO_HARD_LIMIT_BYTES : PHOTO_HARD_LIMIT_BYTES);

// hardLimitBytes is a function of the declared MIME (see ports/media/upload-claim.mjs) so photo
// and video uploads can share this one upload_sessions-backed pipeline/table while enforcing
// different byte caps: 20MB for a photo, 100MB for a video (the brief's hard, server-enforced
// ceiling -- see video.mjs for the matching duration/resolution ceilings).
const photoUploadConfig = Object.freeze({ table: "upload_sessions", credentialDomain: "media-upload-ticket-v1",
  unavailableCode: "upload_session_unavailable", mismatchCode: "object_mismatch", hardLimitBytes: hardLimitFor });

export class UploadService {
  constructor(core, mediaStore, jobs, decoderRunner, uploadAuthorization, viewerMedia, videoDecoderRunner) {
    this.core = core;
    this.db = core.db;
    this.mediaStore = mediaStore;
    this.jobs = jobs;
    this.decoderRunner = decoderRunner;
    this.uploadAuthorization = uploadAuthorization;
    this.viewerMedia = viewerMedia;
    this.videoDecoderRunner = videoDecoderRunner;
  }

  actor(ctx, spaceId, { requireConsent = false } = {}) {
    if (ctx.accountSession) {
      const account = this.core.account(ctx.accountSession);
      const access = this.core.accountSpace(account, spaceId, { task: "upload" });
      assert(access.space.collection_state === "open", "upload_unavailable", 403);
      return { kind: "account", id: account.accountId, authorizationId: account.session.id, space: access.space, account };
    }
    const contributor = this.core.contributor(ctx.contributorSession);
    assert(contributor.space.id === spaceId, "upload_unavailable", 403);
    return { kind: "contributor", id: contributor.principal.id, authorizationId: contributor.session.id,
      contributorPrincipalId: contributor.principal.id, space: contributor.space, contributor };
  }

  assertBatchActor(ctx, batch, { requireOpen = false } = {}) {
    const actor = this.actor(ctx, batch.space_id);
    assert(actor.kind === batch.actor_kind && actor.id === batch.actor_id, "batch_unavailable", 404);
    if (requireOpen) assert(batch.status === "open", "batch_state_conflict", 409);
    return actor;
  }

  uploadContext(ctx, spaceId) {
    const actor = this.actor(ctx, spaceId);
    const notice = this.core.one("SELECT * FROM media_notices WHERE locale='zh-CN' ORDER BY version DESC LIMIT 1");
    assert(notice?.id === MEDIA_NOTICE_V2_NOTICE.id && notice.version === MEDIA_NOTICE_V2_NOTICE.version &&
      notice.content_hash === MEDIA_NOTICE_V2_NOTICE.contentHash, "notice_unavailable", 503);
    const consent = this.core.one(`SELECT * FROM consent_events
      WHERE authorization_id=? AND notice_id=? AND notice_version=? AND notice_hash=?
      ORDER BY accepted_at DESC LIMIT 1`, actor.authorizationId, notice.id, notice.version, notice.content_hash);
    return { spaceId, spaceVersion: actor.space.version, name: actor.space.name, collectionState: actor.space.collection_state, limits: { batchItems: 50, photoBytes: PHOTO_HARD_LIMIT_BYTES, videoBytes: VIDEO_HARD_LIMIT_BYTES,
        videoMaxDurationSeconds: VIDEO_MAX_DURATION_MS / 1000, videoMaxLongEdge: VIDEO_MAX_DISPLAY_LONG_EDGE,
        videoMaxShortEdge: VIDEO_MAX_DISPLAY_SHORT_EDGE },
      formats: ALL_UPLOAD_MIME_TYPES, photoFormats: PHOTO_MIME_TYPES, videoFormats: VIDEO_MIME_TYPES,
      mediaNotice: { id: notice.id, version: notice.version, hash: notice.content_hash, policy: parseJson(notice.policy_json) },
      currentConsent: consent ? { consentEventId: consent.id, acceptedAt: consent.accepted_at } : null,
      canCreateBatch: Boolean(consent), wishes: parseJson(actor.space.wishes_json, []) };
  }

  consent(ctx) {
    const body = object(ctx.body, ["purpose", "noticeVersion", "noticeHash", "mediaPolicyVersion", "choices"],
      ["purpose", "noticeVersion", "noticeHash"]);
    assert(body.purpose === "photo_upload", "consent_required", 409);
    const actor = ctx.accountSession ? this.core.account(ctx.accountSession) : this.core.contributor(ctx.contributorSession);
    const spaceId = ctx.spaceId ?? actor.space?.id;
    const notice = this.core.one("SELECT * FROM media_notices WHERE locale='zh-CN' ORDER BY version DESC LIMIT 1");
    assert(notice?.id === MEDIA_NOTICE_V2_NOTICE.id && notice.version === MEDIA_NOTICE_V2_NOTICE.version &&
      notice.content_hash === MEDIA_NOTICE_V2_NOTICE.contentHash && notice.version === Number(body.noticeVersion) &&
      notice.content_hash === body.noticeHash, "notice_version_stale", 409);
    return this.core.mutation(ctx, { endpoint: "/v1/consent-events", scope: actor.authorizationId,
      reauthorize: () => spaceId ? this.actor(ctx, spaceId) :
        (ctx.accountSession ? this.core.account(ctx.accountSession) : this.core.contributor(ctx.contributorSession)) }, () => {
      if (spaceId) this.actor(ctx, spaceId);
      const consentId = id("consent");
      this.db.prepare(`INSERT INTO consent_events(
        id,space_id,actor_auth_kind,authorization_id,notice_id,notice_version,notice_hash,notice_purpose,accepted_at
      ) VALUES(?,?,?,?,?,?,?,?,?)`).run(consentId, spaceId ?? null, actor.authKind, actor.authorizationId,
      notice.id, notice.version, notice.content_hash, "photo_upload", this.core.now());
      return { consentEventId: consentId, purpose: "photo_upload", noticeVersion: notice.version, acceptedAt: this.core.now() };
    });
  }

  createBatch(ctx, spaceId) {
    const body = object(ctx.body, ["clientBatchId", "consentEventId", "declaredItemCount"],
      ["clientBatchId", "consentEventId", "declaredItemCount"]);
    assert(Number.isSafeInteger(Number(body.declaredItemCount)) && body.declaredItemCount > 0 && body.declaredItemCount <= 50, "media_limit_exceeded", 413);
    const actor = this.actor(ctx, spaceId);
    return this.core.mutation(ctx, { endpoint: `/v1/spaces/${spaceId}/contribution-batches`, scope: actor.authorizationId,
      reauthorize: () => this.actor(ctx, spaceId) }, () => {
      const consent = this.core.one("SELECT * FROM consent_events WHERE id=? AND authorization_id=? AND notice_purpose='photo_upload'",
        body.consentEventId, actor.authorizationId);
      const notice = this.core.one("SELECT * FROM media_notices WHERE locale='zh-CN' ORDER BY version DESC LIMIT 1");
      assert(consent && notice?.id === MEDIA_NOTICE_V2_NOTICE.id && notice.version === MEDIA_NOTICE_V2_NOTICE.version &&
        notice.content_hash === MEDIA_NOTICE_V2_NOTICE.contentHash && consent.notice_id === notice.id &&
        consent.notice_version === notice.version && consent.notice_hash === notice.content_hash,
      "consent_required", 409);
      const batchId = id("batch");
      this.db.prepare(`INSERT INTO contribution_batches(
        id,space_id,actor_kind,actor_id,contributor_principal_id,status,item_count,committed_count,failed_count,version,created_at
      ) VALUES(?,?,?,?,?,'open',0,0,0,1,?)`).run(batchId, spaceId, actor.kind, actor.id,
      actor.contributorPrincipalId ?? null, this.core.now());
      return { batchId, spaceId, status: "open", declaredItemCount: body.declaredItemCount, version: 1 };
    });
  }

  addItem(ctx, batchId) {
    const body = object(ctx.body, ["clientItemId", "declaredMime", "declaredBytes", "fileNameHash"],
      ["clientItemId", "declaredMime", "declaredBytes", "fileNameHash"]);
    assert(ALL_UPLOAD_MIME_TYPES.includes(body.declaredMime) &&
      Number.isSafeInteger(Number(body.declaredBytes)) && body.declaredBytes > 0 &&
      body.declaredBytes <= hardLimitFor(body.declaredMime),
    "media_declaration_invalid", 422);
    const initialBatch = this.core.one("SELECT * FROM contribution_batches WHERE id=?", batchId);
    assert(initialBatch, "batch_unavailable", 404);
    const initialActor = this.assertBatchActor(ctx, initialBatch, { requireOpen: true });
    return this.core.mutation(ctx, { endpoint: `/v1/contribution-batches/${batchId}/items`, scope: initialActor.authorizationId,
      reauthorize: () => this.assertBatchActor(ctx,
        this.core.one("SELECT * FROM contribution_batches WHERE id=?", batchId), { requireOpen: true }) }, () => {
      const batch = this.core.one("SELECT * FROM contribution_batches WHERE id=?", batchId);
      const actor = this.assertBatchActor(ctx, batch, { requireOpen: true });
      this.core.requireIfMatch(ctx, batch);
      this.core.requireVersion(ctx.spaceVersion, actor.space);
      assert(batch.item_count < 50, "media_limit_exceeded", 413);
      const itemId = id("item");
      this.db.prepare(`INSERT INTO contribution_batch_items(
        id,space_id,batch_id,contributor_principal_id,status,uploader_placement_write_enabled,placement_authorization_version,version
      ) VALUES(?,?,?,?, 'selected',1,1,1)`).run(itemId, batch.space_id, batch.id, batch.contributor_principal_id);
      this.db.prepare("UPDATE contribution_batches SET item_count=item_count+1,version=version+1 WHERE id=? AND version=?")
        .run(batch.id, batch.version);
      return { itemId, batchId, status: "selected", version: 1, batchVersion: batch.version + 1 };
    });
  }

  async authorizeUpload(ctx, batchId, itemId, replayClass = "secret_once_envelope",
    endpoint = `/v1/contribution-batches/${batchId}/items/${itemId}/upload-sessions`) {
    const body = object(ctx.body, ["declaredMime", "declaredBytes", "clientUploadId"],
      ["declaredMime", "declaredBytes", "clientUploadId"]);
    assert(ALL_UPLOAD_MIME_TYPES.includes(body.declaredMime) &&
      Number.isSafeInteger(Number(body.declaredBytes)) && Number(body.declaredBytes) > 0 &&
      Number(body.declaredBytes) <= hardLimitFor(body.declaredMime),
    "upload_policy_unavailable", 422);
    const initialBatch = this.core.one("SELECT * FROM contribution_batches WHERE id=?", batchId);
    assert(initialBatch, "item_unavailable", 404);
    const initialActor = this.assertBatchActor(ctx, initialBatch, { requireOpen: true });
    const result = this.core.mutation(ctx, { endpoint,
      scope: initialActor.authorizationId, replayClass, reauthorize: () => {
        const currentBatch = this.core.one("SELECT * FROM contribution_batches WHERE id=?", batchId);
        const currentItem = this.core.one("SELECT * FROM contribution_batch_items WHERE id=? AND batch_id=?", itemId, batchId);
        assert(currentItem && !currentItem.revoked_at && !currentItem.deleted_at, "item_unavailable", 404);
        return this.assertBatchActor(ctx, currentBatch, { requireOpen: true });
      } }, () => {
      const batch = this.core.one("SELECT * FROM contribution_batches WHERE id=?", batchId);
      let item = this.core.one("SELECT * FROM contribution_batch_items WHERE id=? AND batch_id=?", itemId, batchId);
      assert(batch && item, "item_unavailable", 404);
      const actor = this.assertBatchActor(ctx, batch, { requireOpen: true });
      this.core.requireIfMatch(ctx, item);
      let previousSession = item.status === "uploading" ? this.core.one(`SELECT * FROM upload_sessions
        WHERE item_id=? AND status IN ('issued','committing','uploaded','validating') ORDER BY rowid DESC LIMIT 1`, item.id) : null;
      if (previousSession?.status === "validating" &&
        Date.parse(previousSession.commit_operation_expires_at) <= this.core.nowMs()) {
        item = this.finishExpiredCommitRows(previousSession, item);
        previousSession = { ...previousSession, status: "revoked" };
      }
      const previousAuthorization = previousSession ? this.core.one(`SELECT envelope_ciphertext,envelope_expires_at
        FROM idempotency_records WHERE replay_class='secret_once_envelope'
          AND json_extract(response_ref,'$.uploadSessionId')=? ORDER BY rowid DESC LIMIT 1`, previousSession.id) : null;
      const replacing = previousSession && previousSession.status !== "validating" &&
        (Date.parse(previousSession.expires_at) <= this.core.nowMs() ||
          !previousAuthorization || !previousAuthorization.envelope_ciphertext ||
          Date.parse(previousAuthorization.envelope_expires_at) <= this.core.nowMs());
      assert((["selected", "failed"].includes(item.status) || replacing) && !item.revoked_at && !item.deleted_at,
        "item_state_conflict", 409);
      if (item.status === "failed" || replacing) {
        this.db.prepare(`UPDATE upload_sessions SET status='revoked',ticket_mac=NULL,upload_claim_id=NULL,
          upload_claim_expires_at=NULL,commit_operation_id=NULL,commit_operation_expires_at=NULL,version=version+1
          WHERE item_id=? AND status IN ('issued','committing','uploaded','validating')`).run(item.id);
        if (previousSession) {
          this.db.prepare(`UPDATE assets SET validation_state='failed',validation_code='upload_replaced',version=version+1
            WHERE id=? AND validation_state='pending'`).run(previousSession.asset_id);
        }
      }
      const assetId = id("asset");
      const uploadSessionId = id("upload");
      const key = `private/${batch.space_id}/batches/${batch.id}/items/${item.id}/${assetId}`;
      const raw = secret();
      const ticket = this.core.keyring.credential("media-upload-ticket-v1", raw);
      const expiresAt = new Date(this.core.nowMs() + 15 * 60_000).toISOString();
      this.db.prepare("INSERT INTO assets(id,space_id,kind,private_object_key,validation_state,version) VALUES(?,?,?,?,'pending',1)")
        .run(assetId, batch.space_id, isVideoMime(body.declaredMime) ? "video" : "photo", key);
      const itemUpdated = this.db.prepare("UPDATE contribution_batch_items SET asset_id=?,status='uploading',version=version+1 WHERE id=? AND version=?")
        .run(assetId, item.id, item.version);
      assert(itemUpdated.changes === 1, "concurrent_change", 409);
      this.db.prepare(`INSERT INTO upload_sessions(
        id,space_id,batch_id,item_id,actor_id,asset_id,exact_private_object_key,ticket_mac,ticket_key_id,declared_metadata_json,
        expires_at,status,request_hash,version
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'issued',?,1)`).run(uploadSessionId, batch.space_id, batch.id, item.id,
      actor.id, assetId, key, ticket.mac, ticket.keyId, json({ mime: body.declaredMime, bytes: Number(body.declaredBytes) }),
      expiresAt, sha256(stableJson(body)));
      const base = { uploadSessionId, uploadSessionVersion: 1, assetId, itemId, exactPrivateObjectKey: key,
        oneTimeSecret: raw, expiresAt, itemVersion: item.version + 1,
        commitIfMatch: `"upload:1;item:${item.version + 1}"` };
      const binding = { rawTicket: raw, uploadSessionId, uploadSessionVersion: 1, itemId, assetId,
        exactPrivateObjectKey: key, declaredMime: body.declaredMime, declaredBytes: Number(body.declaredBytes),
        expiresAt };
      return { ...base, oneTimeUploadTicket: assertUploadAuthorization(
        this.uploadAuthorization.authorize(binding), binding) };
    });
    if (!result.oneTimeSecret) return result;
    const declared = { mime: body.declaredMime, bytes: Number(body.declaredBytes) };
    const binding = {
      rawTicket: result.oneTimeSecret, uploadSessionId: result.uploadSessionId,
      uploadSessionVersion: result.uploadSessionVersion, itemId: result.itemId, assetId: result.assetId,
      exactPrivateObjectKey: result.exactPrivateObjectKey, declaredMime: declared.mime,
      declaredBytes: declared.bytes, expiresAt: result.expiresAt
    };
    const response = { ...result, oneTimeUploadTicket: result.oneTimeUploadTicket ?? assertUploadAuthorization(
      this.uploadAuthorization.authorize(binding), binding) };
    delete response.oneTimeSecret;
    await this.cleanupReplacedObject(result.itemId, result.assetId);
    return response;
  }

  async cleanupReplacedObject(itemId, currentAssetId) {
    const replaced = this.core.all(`SELECT exact_private_object_key FROM upload_sessions
      WHERE item_id=? AND asset_id<>? AND status='revoked'`, itemId, currentAssetId);
    await Promise.all(replaced.map(async ({ exact_private_object_key: key }) => {
      await this.mediaStore.delete(key);
      assert(!(await this.mediaStore.head(key)).exists, "media_store_unavailable", 503);
    }));
  }

  async retryItem(ctx, batchId, itemId) {
    const body = object(ctx.body, ["failureVersion"], ["failureVersion"]);
    const item = this.core.one("SELECT * FROM contribution_batch_items WHERE id=? AND batch_id=?", itemId, batchId);
    assert(item && item.version === Number(body.failureVersion), "version_conflict", 409);
    const previous = this.core.one(`SELECT declared_metadata_json FROM upload_sessions
      WHERE batch_id=? AND item_id=? ORDER BY rowid DESC LIMIT 1`, batchId, itemId);
    assert(previous, "item_state_conflict", 409);
    const declared = parseJson(previous.declared_metadata_json);
    ctx = { ...ctx, body: { declaredMime: declared.mime, declaredBytes: declared.bytes,
      clientUploadId: `server-retry-${sha256(`${batchId}\0${itemId}\0${ctx.idempotencyKey}`).slice(0, 24)}` },
    ifMatch: item.version };
    return this.authorizeUpload(ctx, batchId, itemId, "secret_once_envelope",
      `/v1/contribution-batches/${batchId}/items/${itemId}/retries`);
  }

  async uploadByTicket(rawTicket, bytes, contentType) {
    return uploadWithClaim(this.core, this.mediaStore, rawTicket, bytes, contentType, photoUploadConfig);
  }

  ticketInfo(rawTicket) {
    return ticketUploadInfo(this.core, rawTicket, photoUploadConfig);
  }

  async observeUpload(session, observedETag) {
    const declared = parseJson(session.declared_metadata_json);
    assert(Date.parse(session.expires_at) > this.core.nowMs(), "upload_session_unavailable", 404);
    const head = await this.mediaStore.head(session.exact_private_object_key);
    assert(head.exists, "object_missing", 409);
    const etag = String(head.etag ?? "").replace(/^W\//, "").replace(/^\"|\"$/g, "");
    const clientETag = observedETag == null ? null : String(observedETag).replace(/^W\//, "").replace(/^\"|\"$/g, "");
    assert(head.bytes === Number(declared.bytes) && head.contentType === declared.mime && etag &&
      (clientETag === null || clientETag === etag), "object_mismatch", 409);
    const objectValue = await this.mediaStore.get(session.exact_private_object_key,
      { maxBytes: hardLimitFor(declared.mime) });
    const body = Buffer.from(objectValue.body);
    const digest = sha256(body);
    const getETag = String(objectValue.etag ?? etag).replace(/^W\//, "").replace(/^\"|\"$/g, "");
    assert(body.length === head.bytes && objectValue.contentType === head.contentType && getETag === etag,
      "object_mismatch", 409);
    return { body, sha256: digest, bytes: body.length, mime: head.contentType, etag,
      sessionVersion: session.version, itemId: session.item_id, assetId: session.asset_id,
      objectKey: session.exact_private_object_key };
  }

  requireCommitVersions(ctx, session, item) {
    const composite = String(ctx.ifMatch ?? "").match(/^upload:(\d+);item:(\d+)$/);
    if (composite) {
      assert(session.version === Number(composite[1]) && item.version === Number(composite[2]),
        "version_conflict", 409);
      return;
    }
    this.core.requireIfMatch(ctx, session);
    this.core.requireVersion(ctx.itemVersion, item);
  }

  finishCommitFailureRows(record, session, item, code, status) {
    assert(record?.state === "in_progress" && session?.status === "validating" && session.commit_operation_id,
      "concurrent_change", 409);
    const sessionUpdate = this.db.prepare(`UPDATE upload_sessions SET status='revoked',ticket_mac=NULL,
      commit_operation_id=NULL,commit_operation_expires_at=NULL,version=version+1
      WHERE id=? AND version=? AND commit_operation_id=?`).run(session.id, session.version, session.commit_operation_id);
    assert(sessionUpdate.changes === 1, "concurrent_change", 409);
    let currentItem = item;
    if (item?.status === "uploading") {
      const itemUpdate = this.db.prepare(`UPDATE contribution_batch_items SET status='failed',failure_code=?,version=version+1
        WHERE id=? AND version=?`).run(code, item.id, item.version);
      assert(itemUpdate.changes === 1, "concurrent_change", 409);
      currentItem = { ...item, status: "failed", failure_code: code, version: item.version + 1 };
    }
    this.db.prepare(`UPDATE assets SET validation_state='failed',validation_code=?,version=version+1
      WHERE id=? AND validation_state='pending'`).run(code, session.asset_id);
    const result = { _error: code, _status: status };
    const recordUpdate = this.db.prepare(`UPDATE idempotency_records SET state='completed',response_ref=?,version=version+1
      WHERE id=? AND version=? AND state='in_progress'`).run(json(redact(result)), record.id, record.version);
    assert(recordUpdate.changes === 1, "concurrent_change", 409);
    return currentItem;
  }

  failCommit(operation, code, status) {
    return transaction(this.db, () => {
      const record = this.core.one("SELECT * FROM idempotency_records WHERE id=?", operation.recordId);
      const session = this.core.one("SELECT * FROM upload_sessions WHERE id=?", operation.claim.sessionId);
      const item = this.core.one("SELECT * FROM contribution_batch_items WHERE id=?", operation.claim.itemId);
      if (!record || record.state !== "in_progress" || session?.status !== "validating" ||
        session.commit_operation_id !== operation.claim.operationId) return;
      this.finishCommitFailureRows(record, session, item, code, status);
    });
  }

  finishExpiredCommitRows(session, item) {
    assert(session.status === "validating" && Date.parse(session.commit_operation_expires_at) <= this.core.nowMs(),
      "concurrent_change", 409);
    const endpoint = `/v1/upload-sessions/${session.id}/commits`;
    const record = this.core.one(`SELECT * FROM idempotency_records
      WHERE method='POST' AND canonical_endpoint=? AND state='in_progress' ORDER BY rowid DESC LIMIT 1`, endpoint);
    return this.finishCommitFailureRows(record, session, item, "concurrent_change", 409);
  }

  reclaimExpiredCommit(session, item) {
    if (session.status !== "validating" || Date.parse(session.commit_operation_expires_at) > this.core.nowMs()) return false;
    return transaction(this.db, () => {
      const currentSession = this.core.one("SELECT * FROM upload_sessions WHERE id=?", session.id);
      const currentItem = this.core.one("SELECT * FROM contribution_batch_items WHERE id=?", item.id);
      this.finishExpiredCommitRows(currentSession, currentItem);
      return true;
    });
  }

  async commit(ctx, uploadSessionId) {
    const body = object(ctx.body, ["clientCommitId", "observedETag"], ["clientCommitId"]);
    const session = this.core.one("SELECT * FROM upload_sessions WHERE id=?", uploadSessionId);
    assert(session, "upload_session_unavailable", 404);
    const batch = this.core.one("SELECT * FROM contribution_batches WHERE id=?", session.batch_id);
    const item = this.core.one("SELECT * FROM contribution_batch_items WHERE id=?", session.item_id);
    assert(batch && item, "upload_session_unavailable", 404);
    const actor = this.assertBatchActor(ctx, batch, { requireOpen: true });
    this.reclaimExpiredCommit(session, item);
    const observed = ["issued", "uploaded"].includes(session.status) ?
      await this.observeUpload(session, body.observedETag) : null;
    const operation = this.core.beginAsyncMutation(ctx, { endpoint: `/v1/upload-sessions/${uploadSessionId}/commits`,
      scope: actor.authorizationId, replayClass: "completed_state",
      reauthorize: () => this.assertBatchActor(ctx, this.core.one("SELECT * FROM contribution_batches WHERE id=?", session.batch_id), { requireOpen: true })
    }, () => {
      const currentBatch = this.core.one("SELECT * FROM contribution_batches WHERE id=?", session.batch_id);
      const currentActor = this.assertBatchActor(ctx, currentBatch, { requireOpen: true });
      const currentSession = this.core.one("SELECT * FROM upload_sessions WHERE id=?", uploadSessionId);
      const currentItem = this.core.one("SELECT * FROM contribution_batch_items WHERE id=?", session.item_id);
      assert(currentSession && currentItem, "upload_session_unavailable", 404);
      this.requireCommitVersions(ctx, currentSession, currentItem);
      assert(observed && currentItem.status === "uploading" && !currentItem.revoked_at && !currentItem.deleted_at &&
        currentItem.batch_id === currentBatch.id && currentItem.space_id === currentBatch.space_id &&
        currentItem.asset_id === currentSession.asset_id && currentSession.batch_id === currentBatch.id &&
        currentSession.space_id === currentBatch.space_id && currentSession.actor_id === currentActor.id &&
        currentSession.item_id === currentItem.id && ["issued", "uploaded"].includes(currentSession.status) &&
        currentSession.version === observed.sessionVersion && currentSession.item_id === observed.itemId &&
        currentSession.asset_id === observed.assetId && currentSession.exact_private_object_key === observed.objectKey &&
        Date.parse(currentSession.expires_at) > this.core.nowMs(),
        "upload_session_unavailable", 404);
      const operationId = id("commit_op");
      const operationExpiresAt = new Date(this.core.nowMs() + 30_000).toISOString();
      const updated = this.db.prepare(`UPDATE upload_sessions SET status='validating',ticket_mac=NULL,
        observed_upload_sha256=?,observed_upload_bytes=?,observed_upload_mime=?,observed_upload_etag=?,
        commit_operation_id=?,commit_operation_expires_at=?,version=version+1
        WHERE id=? AND version=? AND status IN ('issued','uploaded')`)
        .run(observed.sha256, observed.bytes, observed.mime, observed.etag, operationId, operationExpiresAt,
          currentSession.id, currentSession.version);
      assert(updated.changes === 1, "concurrent_change", 409);
      return { operationId, sessionId: currentSession.id, sessionVersion: currentSession.version + 1,
        itemId: currentItem.id, itemVersion: currentItem.version, batchId: currentSession.batch_id,
        assetId: currentSession.asset_id, objectKey: currentSession.exact_private_object_key,
        declared: parseJson(currentSession.declared_metadata_json), observed };
    });
    if (operation.replayed) {
      if (operation.result._error) throw new ApiError(operation.result._error, operation.result._status);
      return operation.result;
    }

    const isVideo = isVideoMime(operation.claim.declared.mime);
    let outcome;
    let derivativeObjectKey = null;
    let videoDerivativeObjectKey = null;
    try {
      if (isVideo) {
        const media = await inspectVideo(operation.claim.observed.body, { declaredMime: operation.claim.declared.mime,
          declaredBytes: operation.claim.declared.bytes, decoderRunner: this.videoDecoderRunner });
        const posterAssetId = id("asset");
        derivativeObjectKey = `private/${session.space_id}/viewer-safe/${posterAssetId}`;
        const storedPoster = await this.mediaStore.putIfAbsent(derivativeObjectKey, media.poster.body,
          { contentType: media.poster.mime, maxBytes: 20 * 1024 * 1024 });
        assert(storedPoster.created && storedPoster.bytes === media.poster.bytes && storedPoster.etag === media.poster.sha256,
          "media_store_unavailable", 503);
        const videoDerivative = await createPlayableVideoDerivative(operation.claim.observed.body, this.videoDecoderRunner);
        const videoAssetId = id("asset");
        videoDerivativeObjectKey = `private/${session.space_id}/video-safe/${videoAssetId}`;
        const storedVideo = await this.mediaStore.putIfAbsent(videoDerivativeObjectKey, videoDerivative.body,
          { contentType: videoDerivative.mime, maxBytes: 100 * 1024 * 1024 });
        assert(storedVideo.created && storedVideo.bytes === videoDerivative.bytes && storedVideo.etag === videoDerivative.sha256,
          "media_store_unavailable", 503);
        outcome = { media, derivative: { ...media.poster, body: undefined, assetId: posterAssetId, objectKey: derivativeObjectKey },
          videoDerivative: { ...videoDerivative, body: undefined, assetId: videoAssetId, objectKey: videoDerivativeObjectKey,
            durationMs: media.durationMs } };
      } else {
        const media = await inspectMedia(operation.claim.observed.body, { kind: "photo", declaredMime: operation.claim.declared.mime,
          declaredBytes: operation.claim.declared.bytes, decoderRunner: this.decoderRunner });
        const derivative = await createViewerSafeDerivative(operation.claim.observed.body, this.decoderRunner);
        const derivativeAssetId = id("asset");
        derivativeObjectKey = `private/${session.space_id}/viewer-safe/${derivativeAssetId}`;
        const stored = await this.mediaStore.putIfAbsent(derivativeObjectKey, derivative.body,
          { contentType: derivative.mime, maxBytes: 20 * 1024 * 1024 });
        assert(stored.created && stored.bytes === derivative.bytes && stored.etag === derivative.sha256,
          "media_store_unavailable", 503);
        outcome = { media, derivative: { ...derivative, body: undefined, assetId: derivativeAssetId,
          objectKey: derivativeObjectKey } };
      }
    } catch (error) {
      if (derivativeObjectKey) await this.mediaStore.delete(derivativeObjectKey).catch(() => {});
      if (videoDerivativeObjectKey) await this.mediaStore.delete(videoDerivativeObjectKey).catch(() => {});
      derivativeObjectKey = null;
      videoDerivativeObjectKey = null;
      outcome = { errorCode: error.code ?? "media_decode_rejected", errorStatus: error.status ?? 422 };
    }
    let result;
    try {
      result = this.core.finishAsyncMutation(operation, (claim) => {
      const currentSession = this.core.one("SELECT * FROM upload_sessions WHERE id=?", claim.sessionId);
      const currentItem = this.core.one("SELECT * FROM contribution_batch_items WHERE id=?", claim.itemId);
      const currentBatch = this.core.one("SELECT * FROM contribution_batches WHERE id=?", claim.batchId);
      const currentActor = this.assertBatchActor(ctx, currentBatch, { requireOpen: true });
      assert(currentSession?.status === "validating" && currentSession.commit_operation_id === claim.operationId &&
        currentSession.version === claim.sessionVersion && currentSession.batch_id === currentBatch.id &&
        currentSession.space_id === currentBatch.space_id && currentSession.actor_id === currentActor.id &&
        currentSession.item_id === currentItem?.id && currentSession.asset_id === currentItem?.asset_id &&
        currentItem?.status === "uploading" && !currentItem.revoked_at && !currentItem.deleted_at &&
        currentItem.batch_id === currentBatch.id && currentItem.space_id === currentBatch.space_id &&
        currentItem.version === claim.itemVersion,
      "concurrent_change", 409);
      if (outcome.errorCode) {
        this.db.prepare("UPDATE contribution_batch_items SET status='failed',failure_code=?,version=version+1 WHERE id=? AND version=?")
          .run(outcome.errorCode, currentItem.id, currentItem.version);
        this.db.prepare("UPDATE assets SET validation_state='failed',validation_code=?,version=version+1 WHERE id=?")
          .run(outcome.errorCode, claim.assetId);
        this.db.prepare(`UPDATE upload_sessions SET status='committed',commit_operation_id=NULL,
          commit_operation_expires_at=NULL,version=version+1 WHERE id=? AND version=? AND commit_operation_id=?`)
          .run(currentSession.id, currentSession.version, claim.operationId);
        return { _error: outcome.errorCode, _status: outcome.errorStatus };
      }
      const media = outcome.media;
      const derivative = outcome.derivative;
      // Poster derivative -- the only asset row every downstream reader (dispatch/index.mjs's
      // photoValidation(), viewer-media-service.mjs's sceneContext()/photoState()/photoDetail(),
      // placement-service.mjs's editorMedia(), local-clip-locator-worker.mjs) ever looks at via
      // photos.viewer_safe_asset_id. Its kind stays 'photo_viewer_safe' for a video exactly like
      // a photo's own derivative, which is what lets all of those keep working unmodified -- see
      // migration 0017's header comment.
      this.db.prepare(`INSERT INTO assets(
        id,space_id,kind,private_object_key,raw_sha256,observed_bytes,observed_mime,width,height,frame_count,
        orientation,color_profile,metadata_policy_result,validation_state,version
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'valid',1)`).run(derivative.assetId, currentBatch.space_id,
      "photo_viewer_safe", derivative.objectKey, derivative.sha256, derivative.bytes, derivative.mime,
      derivative.width ?? media.width, derivative.height ?? media.height, 1, 0, "unspecified", derivative.metadataPolicyResult);
      let videoAssetInsert = null;
      if (outcome.videoDerivative) {
        const videoDerivative = outcome.videoDerivative;
        this.db.prepare(`INSERT INTO assets(
          id,space_id,kind,private_object_key,raw_sha256,observed_bytes,observed_mime,width,height,frame_count,
          orientation,color_profile,metadata_policy_result,duration_ms,validation_state,version
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'valid',1)`).run(videoDerivative.assetId, currentBatch.space_id,
        "video_viewer_safe", videoDerivative.objectKey, videoDerivative.sha256, videoDerivative.bytes, videoDerivative.mime,
        media.width, media.height, null, media.orientation, "unspecified", videoDerivative.metadataPolicyResult,
        videoDerivative.durationMs);
        videoAssetInsert = videoDerivative;
      }
      const job = this.jobs.enqueue("photo_validation", currentBatch.space_id,
        { uploadSessionId, uploadSessionVersion: currentSession.version + 1, assetId: claim.assetId,
          assetVersion: 2, viewerSafeAssetId: derivative.assetId, viewerSafeAssetVersion: 1,
          itemId: currentItem.id, itemVersion: currentItem.version + 1 });
      this.db.prepare(`UPDATE upload_sessions SET status='committed',commit_operation_id=NULL,
        commit_operation_expires_at=NULL,version=version+1 WHERE id=? AND version=? AND commit_operation_id=?`)
        .run(currentSession.id, currentSession.version, claim.operationId);
      this.db.prepare(`UPDATE assets SET raw_sha256=?,observed_bytes=?,observed_mime=?,width=?,height=?,frame_count=?,
        orientation=?,color_profile=?,metadata_policy_result=?,duration_ms=?,validation_state='valid',version=version+1 WHERE id=?`)
        .run(media.sha256, media.bytes, media.mime, media.width, media.height, media.frames, media.orientation,
        media.colorProfile, media.metadataPolicyResult, media.durationMs ?? null, claim.assetId);
      const photoId = id("photo");
      // A: spaces with auto_approve_uploads=1 skip the manual content-review
      // gate entirely — the photo lands 'visible' the moment its upload
      // commits, same as a manually-approved photo, and flows into CLIP
      // auto-placement exactly the same way (photoValidation()/placement() in
      // services/jobs/dispatch/index.mjs never look at photo_content_state).
      // It still surfaces in the owner's review queue as an unreviewed item
      // until they act on it — see SpaceService#management() above.
      const initialContentState = currentActor.space.auto_approve_uploads ? "visible" : "pending";
      this.db.prepare(`INSERT INTO photos(
        id,space_id,batch_id,batch_item_id,contributor_principal_id,asset_id,viewer_safe_asset_id,
        captured_at,photo_content_state,placement_state,media_type,video_asset_id,version
      ) VALUES(?,?,?,?,?,?,?,?,?,'processing',?,?,1)`).run(photoId, currentBatch.space_id, currentBatch.id, currentItem.id,
      currentBatch.contributor_principal_id, claim.assetId, derivative.assetId, media.capturedAt, initialContentState,
      videoAssetInsert ? "video" : "photo", videoAssetInsert ? videoAssetInsert.assetId : null);
      this.db.prepare('UPDATE photos SET uploaded_at=? WHERE id=?').run(this.core.now(),photoId);
      this.db.prepare("UPDATE contribution_batch_items SET photo_id=?,status='committed',failure_code=NULL,version=version+1 WHERE id=? AND version=?")
        .run(photoId, currentItem.id, currentItem.version);
      return { itemId: currentItem.id, assetId: claim.assetId, photoId, status: "validating", jobId: job.jobId,
        uploadSessionVersion: currentSession.version + 1, itemVersion: currentItem.version + 1 };
      });
    } catch (error) {
      if (derivativeObjectKey) await this.mediaStore.delete(derivativeObjectKey).catch(() => {});
      if (videoDerivativeObjectKey) await this.mediaStore.delete(videoDerivativeObjectKey).catch(() => {});
      this.failCommit(operation, error.code ?? "concurrent_change", error.status ?? 409);
      throw error;
    }
    if (result._error) throw new ApiError(result._error, result._status);
    return result;
  }

  removeItem(ctx, batchId, itemId) {
    const body = object(ctx.body, ["reason"], ["reason"]);
    assert(body.reason === "client_removed", "validation_failed");
    const initialBatch = this.core.one("SELECT * FROM contribution_batches WHERE id=?", batchId);
    assert(initialBatch, "item_unavailable", 404);
    const initialActor = this.assertBatchActor(ctx, initialBatch, { requireOpen: true });
    return this.core.mutation(ctx, { endpoint: `/v1/contribution-batches/${batchId}/items/${itemId}`, method: "DELETE",
      scope: initialActor.authorizationId, reauthorize: () => this.assertBatchActor(ctx,
        this.core.one("SELECT * FROM contribution_batches WHERE id=?", batchId), { requireOpen: true }) }, () => {
      const batch = this.core.one("SELECT * FROM contribution_batches WHERE id=?", batchId);
      const item = this.core.one("SELECT * FROM contribution_batch_items WHERE id=? AND batch_id=?", itemId, batchId);
      assert(batch && item, "item_unavailable", 404);
      this.assertBatchActor(ctx, batch, { requireOpen: true });
      this.core.requireIfMatch(ctx, item);
      this.core.requireVersion(ctx.batchVersion, batch);
      const space = this.core.one("SELECT * FROM spaces WHERE id=?", batch.space_id);
      this.core.requireVersion(ctx.spaceVersion, space);
      assert(item.status === "failed", "item_state_conflict", 409);
      this.db.prepare("UPDATE contribution_batch_items SET status='removed',version=version+1 WHERE id=? AND version=?")
        .run(item.id, item.version);
      this.db.prepare("UPDATE contribution_batches SET version=version+1 WHERE id=? AND version=?").run(batch.id, batch.version);
      return { batchId, itemId, status: "removed", itemVersion: item.version + 1, batchVersion: batch.version + 1 };
    });
  }

  finalize(ctx, batchId) {
    object(ctx.body, ["itemsDigest", "clientRequestId"], ["itemsDigest", "clientRequestId"]);
    const initialBatch = this.core.one("SELECT * FROM contribution_batches WHERE id=?", batchId);
    assert(initialBatch, "batch_unavailable", 404);
    const initialActor = this.assertBatchActor(ctx, initialBatch, { requireOpen: true });
    return this.core.mutation(ctx, { endpoint: `/v1/contribution-batches/${batchId}/finalizations`, scope: initialActor.authorizationId,
      replayClass: "secret_once_envelope", reauthorize: () => this.assertBatchActor(ctx,
        this.core.one("SELECT * FROM contribution_batches WHERE id=?", batchId)) }, () => {
      const batch = this.core.one("SELECT * FROM contribution_batches WHERE id=?", batchId);
      assert(batch, "batch_unavailable", 404);
      this.assertBatchActor(ctx, batch, { requireOpen: true });
      this.core.requireIfMatch(ctx, batch);
      const items = this.core.all("SELECT * FROM contribution_batch_items WHERE batch_id=? ORDER BY rowid", batch.id);
      assert(items.length > 0 && items.every((item) => ["committed", "failed", "removed"].includes(item.status)), "no_terminal_items", 409);
      const digest = sha256(stableJson(items.map(({ id: itemId, status, version, failure_code: failureCode }) => ({ itemId, status, version, failureCode }))));
      assert(ctx.body.itemsDigest === digest, "items_changed", 409);
      const committed = items.filter((item) => item.status === "committed").length;
      const failed = items.filter((item) => item.status === "failed").length;
      const receiptId = id("receipt");
      const raw = secret();
      const credential = this.core.keyring.credential("batch-receipt-v1", raw);
      const accessExpiresAt = new Date(this.core.nowMs() + 30 * 24 * 60 * 60_000).toISOString();
      const recoveryUntil = new Date(this.core.nowMs() + 90 * 24 * 60 * 60_000).toISOString();
      this.db.prepare(`UPDATE contribution_batches SET status='finalized',committed_count=?,failed_count=?,
        version=version+1,finalized_at=? WHERE id=? AND version=?`).run(committed, failed, this.core.now(), batch.id, batch.version);
      this.db.prepare(`INSERT INTO batch_receipts(
        id,space_id,batch_id,actor_id,credential_mac,credential_key_id,access_expires_at,recovery_until,created_at,version
      ) VALUES(?,?,?,?,?,?,?,?,?,1)`).run(receiptId, batch.space_id, batch.id, batch.actor_id,
      credential.mac, credential.keyId, accessExpiresAt, recoveryUntil, this.core.now());
      return { batchResult: { batchId, status: "finalized", committedCount: committed, failedCount: failed,
        items: items.map((item) => ({ itemId: item.id, status: item.status, failureCode: item.failure_code, photoId: item.photo_id })) },
      receiptId, receiptBootstrapUrlOnce: `/uploads/open#receipt=${raw}`, oneTimeSecret: raw, accessExpiresAt, recoveryUntil };
    });
  }

  result(ctx, batchId) {
    const batch = this.core.one("SELECT * FROM contribution_batches WHERE id=?", batchId);
    assert(batch, "batch_unavailable", 404);
    if (ctx.receiptSession) {
      const receipt = this.core.receipt(ctx.receiptSession);
      assert(receipt.batch.id === batch.id, "batch_unavailable", 404);
    } else this.assertBatchActor(ctx, batch);
    return this.batchView(batch);
  }

  batchView(batch) {
    const items = this.core.all(`SELECT i.id itemId,i.status,i.failure_code failureCode,i.photo_id photoId,i.version itemVersion,
      i.uploader_placement_write_enabled uploaderPlacementWriteEnabled,p.photo_content_state photoContentState,
      p.placement_state placementState,p.version photoVersion,
      u.id uploadSessionId,u.version uploadSessionVersion,u.status uploadSessionStatus
      FROM contribution_batch_items i LEFT JOIN photos p ON p.id=i.photo_id
      LEFT JOIN upload_sessions u ON u.id=(SELECT current.id FROM upload_sessions current
        WHERE current.item_id=i.id AND current.asset_id=i.asset_id AND current.batch_id=i.batch_id AND current.space_id=i.space_id
        ORDER BY current.rowid DESC LIMIT 1)
      WHERE i.batch_id=? ORDER BY i.rowid`, batch.id);
    // P1 审计项（2026-08-17）："这个空间还没有 360 现场" 曾经是静默变人工待办：照片传进一个
    // 还没激活全景的空间时，services/jobs/dispatch/index.mjs 的 photoValidation() 把
    // panoramaRevisionId 记成 null，infra/integration/local-clip-locator-worker.mjs 的
    // computePlacementOutcome() 因为 `!refs.panoramaRevisionId` 直接判 "no_active_policy"，
    // 落地到和"CLIP 拿不准"一模一样的 needs_confirmation —— 上传的人完全看不出这批照片是在
    // 排队等真人复核，还是单纯这个空间还没资格自动定位。spaceHasScene 就是这一条判据本身
    // (镜像 computePlacementOutcome 里同一个 `!refs.panoramaRevisionId` 检查)，交给回执页
    // (batchResultPage) 判断要不要展示"还没有 360 现场"的提示，不新增分类/落库字段。
    const space = this.core.one("SELECT current_panorama_revision_id FROM spaces WHERE id=?", batch.space_id);
    return { batchId: batch.id, spaceId: batch.space_id, status: batch.status, itemCount: batch.item_count,
      committedCount: batch.committed_count, failedCount: batch.failed_count, version: batch.version, items,
      spaceHasScene: Boolean(space?.current_panorama_revision_id) };
  }

  exchangeReceipt(ctx) {
    const body = object(ctx.body, ["receiptSecretFromClearedBootstrap", "clientNonce"], ["receiptSecretFromClearedBootstrap"]);
    const presented = this.core.keyring.credential("batch-receipt-v1", body.receiptSecretFromClearedBootstrap);
    const receipt = this.core.one("SELECT * FROM batch_receipts WHERE credential_key_id=? AND credential_mac=?", presented.keyId, presented.mac);
    const scope = receipt ? `batch-receipt:${receipt.id}` : `batch-receipt:invalid:${presented.mac.toString("hex")}`;
    const result = this.core.mutation(ctx, { endpoint: "/v1/batch-receipt-exchanges", scope, replayClass: "credential_reissue",
      reissue: (completed) => this.issueReceiptSession(completed.receiptId) }, () => {
      const fresh = receipt ? this.core.one("SELECT * FROM batch_receipts WHERE id=?", receipt.id) : null;
      const space = fresh ? this.core.one("SELECT * FROM spaces WHERE id=?", fresh.space_id) : null;
      if (fresh && space?.space_lifecycle === "archived") return { _error: "batch_access_unavailable" };
      if (!fresh || !space || fresh.consumed_at || fresh.revoked_at || Date.parse(fresh.access_expires_at) <= this.core.nowMs()) return { _error: "receipt_unavailable" };
      this.db.prepare("UPDATE batch_receipts SET consumed_at=?,version=version+1 WHERE id=? AND version=? AND consumed_at IS NULL")
        .run(this.core.now(), fresh.id, fresh.version);
      return this.issueReceiptSession(fresh.id);
    });
    if (result._error) throw new ApiError(result._error, result._error === "batch_access_unavailable" ? 404 : 404);
    return result;
  }

  issueReceiptSession(receiptId) {
    const fresh = this.core.one("SELECT * FROM batch_receipts WHERE id=?", receiptId);
    const space = fresh ? this.core.one("SELECT * FROM spaces WHERE id=?", fresh.space_id) : null;
    assert(fresh && space?.space_lifecycle === "active" && !fresh.revoked_at &&
      Date.parse(fresh.access_expires_at) > this.core.nowMs(), "receipt_unavailable", 404);
    const issued = this.core.issue("receipt_sessions", "receipt-session-v1", {},
      Date.parse(fresh.access_expires_at) - this.core.nowMs(), "rs");
    this.db.prepare("UPDATE receipt_sessions SET revoked_at=COALESCE(revoked_at,?),version=version+1 WHERE batch_receipt_id=?")
      .run(this.core.now(), fresh.id);
    this.db.prepare(`INSERT INTO receipt_sessions(
      id,space_id,batch_receipt_id,batch_id,actor_id,credential_mac,credential_key_id,receipt_version_at_issue,access_expires_at,version
    ) VALUES(?,?,?,?,?,?,?,?,?,1)`).run(issued.sessionId, fresh.space_id, fresh.id, fresh.batch_id, fresh.actor_id,
    issued.credential.mac, issued.credential.keyId, fresh.version, fresh.access_expires_at);
    const batch = this.core.one("SELECT * FROM contribution_batches WHERE id=?", fresh.batch_id);
    return { receiptId: fresh.id, receiptSessionId: issued.sessionId, receiptSessionSecret: issued.raw,
      httpOnlySessionExpiresAt: fresh.access_expires_at, batchReceiptView: this.batchView(batch) };
  }

  receiptView(ctx) {
    const receipt = this.core.receipt(ctx.receiptSession);
    return { ...this.batchView(receipt.batch), accessExpiresAt: receipt.receipt.access_expires_at,
      recoveryUntil: receipt.receipt.recovery_until, receiptVersion: receipt.receipt.version };
  }

  receiptItem(ctx, itemId) {
    const receipt = this.core.receipt(ctx.receiptSession);
    const item = this.core.one(`SELECT i.*,p.photo_content_state,p.placement_state,p.confirmation_mode,p.version photo_version
      FROM contribution_batch_items i LEFT JOIN photos p ON p.id=i.photo_id WHERE i.id=? AND i.batch_id=? AND i.space_id=?`,
    itemId, receipt.batch.id, receipt.space.id);
    assert(item, "batch_item_unavailable", 404);
    // A v2: only feed the placement editor's 360 preview to an uploader who can actually act on
    // it right now (uploader_placement_write_enabled) — a receipt session whose write access has
    // already been locked (e.g. a manager saved over it) still gets this same read for its status
    // fields, just without scene data it has no use for. See ViewerMediaService#editorSceneContext()
    // for why this is safe to call with an unconfirmed/failed photo at all.
    let sceneContext = null;
    if (item.photo_id && item.uploader_placement_write_enabled && !item.revoked_at && !item.deleted_at) {
      try { sceneContext = this.viewerMedia.editorSceneContext(receipt.space.id, item.photo_id); } catch { sceneContext = null; }
    }
    return { itemId: item.id, status: item.status, failureCode: item.failure_code, photoId: item.photo_id,
      photoContentState: item.photo_content_state, placementState: item.placement_state, confirmationMode: item.confirmation_mode,
      canEditPlacement: Boolean(item.uploader_placement_write_enabled && !item.revoked_at && !item.deleted_at),
      itemVersion: item.version, placementAuthorizationVersion: item.placement_authorization_version, photoVersion: item.photo_version,
      ...(sceneContext ? { sceneContext } : {}) };
  }

  revokeReceipt(ctx) {
    object(ctx.body, ["confirmation", "reason"], ["confirmation"]);
    assert(ctx.body.confirmation === true, "validation_failed");
    const receiptCtx = this.core.receipt(ctx.receiptSession);
    return this.core.mutation(ctx, { endpoint: "/v1/batch-receipt/revocations", scope: receiptCtx.session.id,
      replayClass: "completed_state", reauthorize: () => this.core.receipt(ctx.receiptSession) }, () => {
      this.core.requireIfMatch(ctx, receiptCtx.receipt);
      this.core.requireVersion(ctx.spaceVersion, receiptCtx.space);
      const now = this.core.now();
      this.db.prepare("UPDATE batch_receipts SET revoked_at=?,version=version+1 WHERE id=? AND version=?")
        .run(now, receiptCtx.receipt.id, receiptCtx.receipt.version);
      this.db.prepare("UPDATE receipt_sessions SET revoked_at=COALESCE(revoked_at,?),version=version+1 WHERE batch_receipt_id=?")
        .run(now, receiptCtx.receipt.id);
      this.db.prepare("UPDATE receipt_account_bindings SET revoked_at=COALESCE(revoked_at,?),version=version+1 WHERE batch_receipt_id=?")
        .run(now, receiptCtx.receipt.id);
      return { receiptId: receiptCtx.receipt.id, revokedAt: now, version: receiptCtx.receipt.version + 1 };
    });
  }

  revokeItem(ctx, itemId) {
    object(ctx.body, ["reasonCode", "clientRequestId"], ["reasonCode", "clientRequestId"]);
    const receiptCtx = ctx.receiptSession ? this.core.receipt(ctx.receiptSession) : null;
    const item = this.core.one("SELECT * FROM contribution_batch_items WHERE id=?", itemId);
    assert(item, "item_unavailable", 404);
    if (receiptCtx) assert(receiptCtx.batch.id === item.batch_id, "item_unavailable", 404);
    else this.core.accountSpace(this.core.account(ctx.accountSession), item.space_id, { ownerOnly: true });
    const account = receiptCtx ? null : this.core.account(ctx.accountSession);
    const scope = receiptCtx?.session.id ?? account.session.id;
    return this.core.mutation(ctx, { endpoint: `/v1/batch-receipt/items/${itemId}/revocations`, scope,
      replayClass: "completed_state", reauthorize: () => receiptCtx ? this.core.receipt(ctx.receiptSession) :
        this.core.accountSpace(this.core.account(ctx.accountSession), item.space_id, { ownerOnly: true }) }, () => {
      this.core.requireIfMatch(ctx, item);
      this.db.prepare("UPDATE contribution_batch_items SET revoked_at=?,version=version+1 WHERE id=? AND version=?")
        .run(this.core.now(), item.id, item.version);
      if (item.photo_id) this.db.prepare("UPDATE photos SET deleted_at=COALESCE(deleted_at,?),captured_at=NULL,version=version+1 WHERE id=?")
        .run(this.core.now(), item.photo_id);
      return { itemId, revokedAt: this.core.now(), version: item.version + 1 };
    });
  }
}
