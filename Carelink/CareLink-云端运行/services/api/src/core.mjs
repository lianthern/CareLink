import { requireAccountAdmission } from './admin-service.mjs';
import { assert, unavailable } from "./errors.mjs";
import { all, one, transaction } from "./database.mjs";
import { id, json, nowIso, parseJson, redact, secret, sha256, stableJson } from "./util.mjs";

const taskSet = (value) => new Set(parseJson(value, []));

export class Core {
  constructor({ db, keyring, clock = Date }) {
    this.db = db;
    this.keyring = keyring;
    this.clock = clock;
  }

  now() { return nowIso(this.clock); }
  nowMs() { return this.clock.now(); }

  credentialRow(table, domain, raw, columns = "*") {
    if (!raw) return null;
    for (const { keyId, mac } of this.keyring.credentialCandidates(domain, raw)) {
      const row = one(this.db, `SELECT ${columns} FROM ${table} WHERE credential_key_id=? AND credential_mac=?`, keyId, mac);
      if (row) return row;
    }
    return null;
  }

  account(raw) {
    const row = this.credentialRow("account_sessions", "account-session-v1", raw,
      "id,account_id,family_id,issued_session_epoch,version,expires_at,revoked_at");
    assert(row, "session_unavailable", 401);
    const family = one(this.db, "SELECT * FROM account_session_families WHERE id=?", row.family_id);
    const account = one(this.db, "SELECT * FROM accounts WHERE id=?", row.account_id);
    assert(account && family && account.status === "active" && !row.revoked_at && !family.revoked_at &&
      Date.parse(row.expires_at) > this.nowMs() && row.issued_session_epoch === account.session_epoch &&
      family.issued_session_epoch === account.session_epoch, "session_unavailable", 401);
    requireAccountAdmission(this, account.id);
    return { authKind: "account", authorizationId: row.id, accountId: account.id, session: row, family, account };
  }

  accountOptional(raw) {
    if (!raw) return null;
    return this.account(raw);
  }

  viewer(raw) {
    const session = this.credentialRow("viewer_sessions", "viewer-session-v1", raw);
    assert(session, "session_unavailable", 401);
    const principal = one(this.db, "SELECT * FROM viewer_principals WHERE id=?", session.viewer_principal_id);
    const grant = one(this.db, "SELECT * FROM external_invitation_grants WHERE id=?", session.grant_id);
    const campaign = one(this.db, "SELECT * FROM external_invitation_campaigns WHERE id=?", session.campaign_id);
    const space = one(this.db, "SELECT * FROM spaces WHERE id=?", session.space_id);
    const live = session && principal && grant && campaign && space && !session.revoked_at && !principal.revoked_at &&
      !grant.revoked_at && !campaign.revoked_at && Date.parse(session.access_expires_at) > this.nowMs() &&
      Date.parse(grant.access_expires_at) > this.nowMs() && Date.parse(campaign.expires_at) > this.nowMs() &&
      space.space_lifecycle === "active" && space.sharing_state === "shared" &&
      ["active", "exhausted"].includes(campaign.campaign_status) &&
      session.campaign_use_ordinal === principal.campaign_use_ordinal && principal.campaign_use_ordinal === grant.campaign_use_ordinal &&
      taskSet(session.tasks_json).has("view") && taskSet(grant.tasks_json).has("view");
    assert(live, "session_unavailable", 401);
    return { authKind: "viewer", authorizationId: session.id, session, principal, grant, campaign, space };
  }

  contributor(raw) {
    const session = this.credentialRow("contributor_sessions", "contributor-session-v1", raw);
    assert(session, "upload_unavailable", 401);
    const principal = one(this.db, "SELECT * FROM contributor_principals WHERE id=?", session.contributor_principal_id);
    const grant = one(this.db, "SELECT * FROM external_invitation_grants WHERE id=?", session.source_grant_id);
    const campaign = one(this.db, "SELECT * FROM external_invitation_campaigns WHERE id=?", session.campaign_id);
    const space = one(this.db, "SELECT * FROM spaces WHERE id=?", session.space_id);
    const live = principal && grant && campaign && space && !session.revoked_at && !principal.revoked_at && !grant.revoked_at &&
      Date.parse(session.access_expires_at) > this.nowMs() && Date.parse(grant.access_expires_at) > this.nowMs() &&
      Date.parse(campaign.expires_at) > this.nowMs() && space.space_lifecycle === "active" && space.collection_state === "open" &&
      ["active", "exhausted"].includes(campaign.campaign_status) && !campaign.revoked_at &&
      session.campaign_use_ordinal === principal.campaign_use_ordinal && principal.campaign_use_ordinal === grant.campaign_use_ordinal &&
      taskSet(session.tasks_json).has("upload") && taskSet(grant.tasks_json).has("upload");
    assert(live, "upload_unavailable", 401);
    return { authKind: "contributor", authorizationId: session.id, session, principal, grant, campaign, space };
  }

  receipt(raw, { activeSpace = true } = {}) {
    const session = this.credentialRow("receipt_sessions", "receipt-session-v1", raw);
    assert(session && !session.revoked_at && Date.parse(session.access_expires_at) > this.nowMs(), "receipt_session_unavailable", 401);
    const receipt = one(this.db, "SELECT * FROM batch_receipts WHERE id=?", session.batch_receipt_id);
    const batch = one(this.db, "SELECT * FROM contribution_batches WHERE id=?", session.batch_id);
    const space = one(this.db, "SELECT * FROM spaces WHERE id=?", session.space_id);
    assert(receipt && batch && space && receipt.batch_id === batch.id && batch.space_id === space.id &&
      !receipt.revoked_at && Date.parse(receipt.access_expires_at) > this.nowMs(), "receipt_session_unavailable", 401);
    if (activeSpace) assert(space.space_lifecycle === "active", "batch_access_unavailable", 404);
    return { authKind: "receipt_session", authorizationId: session.id, session, receipt, batch, space };
  }

  caseAccess(raw) {
    const session = this.credentialRow("case_access_sessions", "case-access-session-v1", raw);
    assert(session && !session.revoked_at && Date.parse(session.expires_at) > this.nowMs(), "case_unavailable", 404);
    return { authKind: "case_access", authorizationId: session.id, session };
  }

  deletionStatus(raw) {
    const session = this.credentialRow("deletion_status_sessions", "deletion-status-session-v1", raw);
    assert(session && !session.revoked_at && Date.parse(session.access_expires_at) > this.nowMs(),
      "deletion_request_unavailable", 404);
    return { authKind: "deletion_status", authorizationId: session.id, session };
  }

  accountSpace(accountCtx, spaceId, { task, scope, ownerOnly = false, allowArchived = false } = {}) {
    assert(accountCtx?.authKind === "account", "session_unavailable", 401);
    const space = one(this.db, "SELECT * FROM spaces WHERE id=?", spaceId);
    assert(space && (allowArchived || space.space_lifecycle === "active"), "resource_unavailable", 404);
    const owner = space.owner_account_id === accountCtx.accountId;
    const membership = owner ? null : one(this.db,
      "SELECT * FROM space_memberships WHERE space_id=? AND account_id=? AND status='active'", spaceId, accountCtx.accountId);
    if (ownerOnly) assert(owner, "owner_required", 403);
    else assert(owner || membership, "resource_unavailable", 404);
    if (task) assert(owner || taskSet(membership.tasks_json).has(task), task === "upload" ? "upload_unavailable" : "resource_unavailable", 403);
    if (scope) assert(owner || taskSet(membership.management_scopes_json).has(scope), "authorization_changed", 403);
    return { space, owner, membership, authKind: owner ? "space_owner" : "membership", authorizationId: owner ? space.id : membership.id };
  }

  anyManagement(accountCtx, spaceId) {
    const access = this.accountSpace(accountCtx, spaceId);
    assert(access.owner || taskSet(access.membership.management_scopes_json).size > 0, "resource_unavailable", 404);
    return access;
  }

  requireIfMatch(ctx, ...rows) {
    const supplied = Number(ctx.ifMatch);
    assert(Number.isSafeInteger(supplied), "version_conflict", 409);
    assert(rows.length > 0 && rows.every((row) => row && row.version === supplied), "version_conflict", 409);
  }

  requireVersion(suppliedValue, row) {
    const supplied = Number(suppliedValue);
    assert(row && Number.isSafeInteger(supplied) && row.version === supplied, "version_conflict", 409);
  }

  issue(table, domain, data, ttlMs, prefix) {
    const raw = secret();
    const credential = this.keyring.credential(domain, raw);
    const sessionId = id(prefix);
    return { raw, credential, sessionId, expiresAt: new Date(this.nowMs() + ttlMs).toISOString(), data };
  }

  audit({ spaceId = null, aggregateType, aggregateId, eventType, actorKind, authorizationId = null, detail = {}, requestId }) {
    const safe = redact(detail);
    this.db.prepare(`INSERT INTO audit_events(
      id,space_id,aggregate_type,aggregate_id,event_type,actor_kind,authorization_id,detail_json,request_id,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id("aud"), spaceId, aggregateType, aggregateId, eventType,
      actorKind, authorizationId, json(safe), requestId, this.now());
  }

  reauthorizeReplay(ctx) {
    if (ctx.selectedPrincipalKind === "viewerSession") return this.viewer(ctx.viewerSession);
    if (ctx.selectedPrincipalKind === "contributorSession") return this.contributor(ctx.contributorSession);
    if (ctx.selectedPrincipalKind === "receiptSession") return this.receipt(ctx.receiptSession);
    if (ctx.selectedPrincipalKind === "caseAccessSession") return this.caseAccess(ctx.caseAccessSession);
    if (ctx.selectedPrincipalKind === "deletionStatusSession") return this.deletionStatus(ctx.deletionStatusSession);
    if (ctx.selectedPrincipalKind === "accountSession") return this.account(ctx.accountSession);
    return null;
  }

  mutation(ctx, { endpoint, method = "POST", scope, replayClass = "ordinary_dto", envelopeTtlMs = 120_000,
    reissue = null, reauthorize = null, beforeCreate = null }, run) {
    assert(typeof ctx.idempotencyKey === "string" && ctx.idempotencyKey.length >= 8 && ctx.idempotencyKey.length <= 200,
      "idempotency_key_required", 400);
    const requestHash = sha256(stableJson({ body: ctx.body ?? {}, ifMatch: ctx.ifMatch ?? null, notice: ctx.notice ?? null }));
    const key = this.keyring.credential("idempotency-key-v1", ctx.idempotencyKey);
    const recordScope = scope ?? ctx.scope ?? ctx.authorizationId ?? "anonymous";
    return transaction(this.db, () => {
      const existing = one(this.db, `SELECT * FROM idempotency_records
        WHERE scope=? AND method=? AND canonical_endpoint=? AND idempotency_key_id=? AND idempotency_key_mac=?`,
      recordScope, method, endpoint, key.keyId, key.mac);
      if (existing) {
        (reauthorize ?? (() => this.reauthorizeReplay(ctx)))();
        assert(existing.request_hash === requestHash, "idempotency_conflict", 409);
        assert(existing.state === "completed", "concurrent_change", 409);
        const response = parseJson(existing.response_ref, { completed: true });
        if (existing.replay_class === "credential_reissue" && reissue) {
          return { ...reissue(response, { record: existing, requestHash, recordScope }), replayed: true };
        }
        if (existing.replay_class === "secret_once_envelope" && existing.envelope_ciphertext &&
          Date.parse(existing.envelope_expires_at) > this.nowMs()) {
          const aad = `${existing.id}\0${existing.scope}\0${existing.request_hash}\0${existing.envelope_expires_at}`;
          return { ...response, oneTimeSecret: this.keyring.open(existing.envelope_ciphertext, aad, existing.envelope_key_id), replayed: true };
        }
        return { ...response, replayed: true, ...(existing.replay_class === "secret_once_envelope" ? { secretUnavailable: true } : {}) };
      }
      const admission = beforeCreate?.();
      if (admission?._shortCircuit !== undefined) return admission._shortCircuit;
      const recordId = id("idem");
      const expiresAt = new Date(this.nowMs() + 24 * 60 * 60 * 1000).toISOString();
      this.db.prepare(`INSERT INTO idempotency_records(
        id,scope,method,canonical_endpoint,idempotency_key_mac,idempotency_key_id,request_hash,replay_class,state,created_at,expires_at,version
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,1)`).run(recordId, recordScope, method, endpoint, key.mac, key.keyId,
      requestHash, replayClass, "in_progress", this.now(), expiresAt);
      const result = run({ recordId, requestHash, recordScope });
      const safe = redact(result);
      let envelope = null;
      let envelopeExpiresAt = null;
      if (replayClass === "secret_once_envelope" && result.oneTimeSecret) {
        envelopeExpiresAt = new Date(this.nowMs() + envelopeTtlMs).toISOString();
        const aad = `${recordId}\0${recordScope}\0${requestHash}\0${envelopeExpiresAt}`;
        envelope = this.keyring.seal(result.oneTimeSecret, aad);
      }
      this.db.prepare(`UPDATE idempotency_records SET state='completed',response_ref=?,envelope_ciphertext=?,
        envelope_key_id=?,envelope_expires_at=?,version=version+1 WHERE id=?`).run(json(safe), envelope,
      envelope ? this.keyring.keyId : null, envelopeExpiresAt, recordId);
      return result;
    });
  }

  beginAsyncMutation(ctx, { endpoint, method = "POST", scope, replayClass = "completed_state", reauthorize = null }, prepare) {
    assert(typeof ctx.idempotencyKey === "string" && ctx.idempotencyKey.length >= 8 && ctx.idempotencyKey.length <= 200,
      "idempotency_key_required", 400);
    const requestHash = sha256(stableJson({ body: ctx.body ?? {}, ifMatch: ctx.ifMatch ?? null, notice: ctx.notice ?? null }));
    const key = this.keyring.credential("idempotency-key-v1", ctx.idempotencyKey);
    const recordScope = scope ?? ctx.scope ?? ctx.authorizationId ?? "anonymous";
    return transaction(this.db, () => {
      const existing = one(this.db, `SELECT * FROM idempotency_records
        WHERE scope=? AND method=? AND canonical_endpoint=? AND idempotency_key_id=? AND idempotency_key_mac=?`,
      recordScope, method, endpoint, key.keyId, key.mac);
      if (existing) {
        (reauthorize ?? (() => this.reauthorizeReplay(ctx)))();
        assert(existing.request_hash === requestHash, "idempotency_conflict", 409);
        assert(existing.state === "completed", "concurrent_change", 409);
        const response = parseJson(existing.response_ref, { completed: true });
        return { replayed: true, result: { ...response, replayed: true } };
      }
      const recordId = id("idem");
      this.db.prepare(`INSERT INTO idempotency_records(
        id,scope,method,canonical_endpoint,idempotency_key_mac,idempotency_key_id,request_hash,replay_class,state,created_at,expires_at,version
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,1)`).run(recordId, recordScope, method, endpoint, key.mac, key.keyId,
      requestHash, replayClass, "in_progress", this.now(), new Date(this.nowMs() + 24 * 60 * 60_000).toISOString());
      return { replayed: false, recordId, requestHash, recordScope, endpoint, claim: prepare() };
    });
  }

  finishAsyncMutation(operation, finalize) {
    assert(operation && !operation.replayed && operation.recordId, "concurrent_change", 409);
    return transaction(this.db, () => {
      const record = one(this.db, "SELECT * FROM idempotency_records WHERE id=?", operation.recordId);
      assert(record && record.state === "in_progress" && record.request_hash === operation.requestHash,
        "concurrent_change", 409);
      const result = finalize(operation.claim);
      const updated = this.db.prepare(`UPDATE idempotency_records SET state='completed',response_ref=?,version=version+1
        WHERE id=? AND version=? AND state='in_progress'`).run(json(redact(result)), record.id, record.version);
      assert(updated.changes === 1, "concurrent_change", 409);
      return result;
    });
  }

  unavailable(name) {
    unavailable(`${name}_unavailable`);
  }

  all(sql, ...params) { return all(this.db, sql, ...params); }
  one(sql, ...params) { return one(this.db, sql, ...params); }
}
