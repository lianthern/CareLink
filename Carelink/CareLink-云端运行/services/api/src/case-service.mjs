import { ApiError, assert } from "./errors.mjs";
import { id, json, secret } from "./util.mjs";
import { object, string } from "./schemas.mjs";

const forbiddenMedia = new Set(["attachmentId", "assetId", "uploadSessionId", "multipart"]);

export class CaseService {
  constructor(core) {
    this.core = core;
    this.db = core.db;
  }

  rejectMedia(body) {
    assert(!Object.keys(body ?? {}).some((field) => forbiddenMedia.has(field)), "unsupported_field", 400);
  }

  notice(ctx, purpose) {
    const notice = this.core.one("SELECT * FROM consent_notices WHERE purpose=? AND locale='zh-CN' AND retired_at IS NULL ORDER BY version DESC LIMIT 1", purpose);
    assert(notice && ctx.notice?.purpose === purpose && Number(ctx.notice.version) === notice.version &&
      ctx.notice.contentHash === notice.content_hash, "notice_acknowledgement_required", 409);
    return notice;
  }

  insertCase(fields) {
    const columns = Object.keys(fields);
    const values = Object.values(fields);
    this.db.prepare(`INSERT INTO content_cases(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`)
      .run(...values);
  }

  claimAdmission({ authorizationKind, authorizationId, target, category }) {
    const bucketMs = Math.floor(this.core.nowMs() / (60 * 60_000)) * 60 * 60_000;
    const bucket = new Date(bucketMs).toISOString();
    const expiresAt = new Date(bucketMs + 2 * 60 * 60_000).toISOString();
    const authorizationMac = this.core.keyring.mac("case-admission-authorization-v1",
      `${authorizationKind}\0${authorizationId}`);
    const dedupeMac = this.core.keyring.mac("case-admission-dedupe-v1",
      `${authorizationKind}\0${authorizationId}\0${target}\0${category}\0${bucket}`);
    const duplicate = this.core.one(`SELECT 1 FROM case_admission_dedupes
      WHERE key_id=? AND dedupe_mac=? AND bucket_start=?`, this.core.keyring.keyId, dedupeMac, bucket);
    if (duplicate) throw new ApiError("rate_limited", 429);
    const counter = this.core.one(`SELECT * FROM case_admission_counters
      WHERE key_id=? AND authorization_mac=? AND bucket_start=?`,
    this.core.keyring.keyId, authorizationMac, bucket);
    if (counter?.count >= 20) throw new ApiError("rate_limited", 429);
    if (counter) {
      const updated = this.db.prepare(`UPDATE case_admission_counters SET count=count+1,version=version+1
        WHERE key_id=? AND authorization_mac=? AND bucket_start=? AND version=?`).run(
      this.core.keyring.keyId, authorizationMac, bucket, counter.version);
      assert(updated.changes === 1, "concurrent_change", 409);
    } else {
      this.db.prepare(`INSERT INTO case_admission_counters(
        key_id,authorization_mac,bucket_start,count,expires_at,version
      ) VALUES(?,?,?,1,?,1)`).run(this.core.keyring.keyId, authorizationMac, bucket, expiresAt);
    }
    this.db.prepare(`INSERT INTO case_admission_dedupes(
      key_id,dedupe_mac,bucket_start,expires_at,created_at
    ) VALUES(?,?,?,?,?)`).run(this.core.keyring.keyId, dedupeMac, bucket, expiresAt, this.core.now());
  }

  reportActor(ctx, targetRef) {
    if (ctx.accountSession) {
      const account = this.core.account(ctx.accountSession);
      const photo = this.core.one("SELECT * FROM photos WHERE id=? AND deleted_at IS NULL", targetRef.photoId);
      assert(photo, "object_context_unavailable", 404);
      const access = this.core.accountSpace(account, photo.space_id, { task: "view" });
      return { relation: "account", auth: account, photo, space: access.space, snapshot: {
        actor_account_id: account.accountId, actor_account_session_id: account.session.id,
        actor_account_session_version: account.session.version, actor_account_session_epoch: account.account.session_epoch,
        ...(access.owner ? { actor_owner_space_id: access.space.id, actor_owner_space_version: access.space.version } :
          { actor_account_membership_id: access.membership.id, actor_membership_version: access.membership.version }) } };
    }
    if (ctx.viewerSession) {
      const viewer = this.core.viewer(ctx.viewerSession);
      const photo = this.core.one("SELECT * FROM photos WHERE id=? AND space_id=? AND photo_content_state='visible' AND deleted_at IS NULL",
        targetRef.photoId, viewer.space.id);
      assert(photo, "object_context_unavailable", 404);
      return { relation: "viewer", auth: viewer, photo, space: viewer.space, snapshot: {
        actor_viewer_session_id: viewer.session.id, actor_viewer_session_version: viewer.session.version,
        actor_viewer_principal_id: viewer.principal.id, actor_viewer_principal_version: viewer.principal.version,
        actor_external_campaign_id: viewer.campaign.id, actor_external_campaign_version: viewer.campaign.version,
        actor_external_grant_id: viewer.grant.id, actor_external_grant_version: viewer.grant.version,
        actor_viewer_space_id: viewer.space.id, actor_viewer_space_version: viewer.space.version } };
    }
    const receipt = this.core.receipt(ctx.receiptSession);
    const photo = this.core.one("SELECT * FROM photos WHERE id=? AND batch_id=? AND space_id=? AND deleted_at IS NULL",
      targetRef.photoId, receipt.batch.id, receipt.space.id);
    assert(photo, "object_context_unavailable", 404);
    const item = this.core.one("SELECT * FROM contribution_batch_items WHERE id=?", photo.batch_item_id);
    return { relation: "receipt", auth: receipt, photo, space: receipt.space, snapshot: {
      actor_receipt_session_id: receipt.session.id, actor_receipt_session_version: receipt.session.version,
      actor_batch_receipt_id: receipt.receipt.id, actor_batch_receipt_version: receipt.receipt.version,
      actor_receipt_contribution_batch_id: receipt.batch.id, actor_receipt_item_id: item.id,
      actor_receipt_item_version: item.version, actor_receipt_space_id: receipt.space.id,
      actor_receipt_space_version: receipt.space.version } };
  }

  issueCaseAccess(caseId, relationKind, accountId = null) {
    const raw = secret();
    const credential = this.core.keyring.credential("case-access-session-v1", raw);
    const sessionId = id("cas");
    const expiresAt = new Date(this.core.nowMs() + 90 * 24 * 60 * 60_000).toISOString();
    this.db.prepare(`INSERT INTO case_access_sessions(
      id,case_id,account_id,credential_mac,credential_key_id,relation_kind,relation_version,expires_at,version
    ) VALUES(?,?,?,?,?,?,1,?,1)`).run(sessionId, caseId, accountId, credential.mac, credential.keyId, relationKind, expiresAt);
    return { caseAccessSessionId: sessionId, caseAccessSessionSecret: raw, expiresAt };
  }

  reissueCaseAccess(completed) {
    const row = this.core.one("SELECT * FROM content_cases WHERE id=?", completed.caseId);
    assert(row, "case_unavailable", 404);
    if (row.actor_relation_kind === "account") return completed;
    const relationKind = row.case_type === "report" ? "reporter" :
      row.case_type === "appeal" ? "appellant" : "support_requester";
    this.db.prepare("UPDATE case_access_sessions SET revoked_at=COALESCE(revoked_at,?),version=version+1 WHERE case_id=?")
      .run(this.core.now(), row.id);
    return { ...completed, ...this.issueCaseAccess(row.id, relationKind) };
  }

  report(ctx) {
    this.rejectMedia(ctx.body);
    const body = object(ctx.body, ["targetRef", "category", "description", "clientRequestId"],
      ["targetRef", "category", "description", "clientRequestId"]);
    assert(body.targetRef && typeof body.targetRef.photoId === "string", "object_context_unavailable", 400);
    const category = string(body.category, { max: 64, code: "case_submission_unavailable" });
    const description = string(body.description, { max: 2000 });
    const actor = this.reportActor(ctx, body.targetRef);
    const notice = this.notice(ctx, "object_report");
    const scope = actor.relation === "account" ? `report-account:${actor.auth.accountId}` :
      actor.relation === "viewer" ? `report-viewer:${actor.auth.principal.id}` :
        `report-receipt:${actor.auth.receipt.id}`;
    return this.core.mutation(ctx, { endpoint: "/v1/reports", scope, replayClass: "credential_reissue",
      beforeCreate: () => this.claimAdmission({ authorizationKind: actor.relation,
        authorizationId: actor.auth.authorizationId, target: `photo:${actor.photo.id}`, category }),
      reissue: (completed) => this.reissueCaseAccess(completed) }, () => {
      const caseId = id("case");
      this.insertCase({ id: caseId, space_id: actor.space.id, case_type: "report", target_type: "photo",
        target_photo_id: actor.photo.id, target_version: actor.photo.version, actor_relation_kind: actor.relation,
        ...actor.snapshot, category, description, status: "open", created_at: this.core.now(), version: 1 });
      this.db.prepare(`INSERT INTO notice_ack_events(
        id,space_id,actor_auth_kind,authorization_id,notice_id,notice_version,notice_hash,notice_purpose,target_mutation_id,acknowledged_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id("ack"), actor.space.id, actor.relation, actor.auth.authorizationId,
      notice.id, notice.version, notice.content_hash, "object_report", caseId, this.core.now());
      const access = actor.relation === "account" ? null : this.issueCaseAccess(caseId, "reporter");
      return { caseId, status: "open", actorRelationKind: actor.relation, ...(access ?? {}) };
    });
  }

  caseActor(ctx, caseRow) {
    if (ctx.accountSession) {
      const account = this.core.account(ctx.accountSession);
      assert(caseRow.actor_relation_kind === "account" && caseRow.actor_account_id === account.accountId,
        "case_unavailable", 404);
      return { kind: "account", auth: account, snapshot: {
        actor_account_id: account.accountId, actor_account_session_id: account.session.id,
        actor_account_session_version: account.session.version, actor_account_session_epoch: account.account.session_epoch,
        ...(caseRow.actor_account_membership_id ? {
          actor_account_membership_id: caseRow.actor_account_membership_id,
          actor_membership_version: this.core.one("SELECT version FROM space_memberships WHERE id=?", caseRow.actor_account_membership_id)?.version ?? caseRow.actor_membership_version
        } : caseRow.actor_owner_space_id ? {
          actor_owner_space_id: caseRow.actor_owner_space_id,
          actor_owner_space_version: this.core.one("SELECT version FROM spaces WHERE id=?", caseRow.actor_owner_space_id)?.version ?? caseRow.actor_owner_space_version
        } : {}) } };
    }
    if (ctx.caseAccessSession) {
      const access = this.core.caseAccess(ctx.caseAccessSession);
      assert(access.session.case_id === caseRow.id, "case_unavailable", 404);
      return { kind: "case_access", auth: access, snapshot: {
        actor_case_access_session_id: access.session.id, actor_parent_case_id: caseRow.id,
        actor_case_access_session_version: access.session.version, actor_parent_case_version: caseRow.version } };
    }
    if (ctx.receiptSession) {
      const receipt = this.core.receipt(ctx.receiptSession);
      assert(caseRow.actor_relation_kind === "receipt" && caseRow.actor_receipt_session_id === receipt.session.id &&
        caseRow.actor_batch_receipt_id === receipt.receipt.id, "case_unavailable", 404);
      const item = this.core.one("SELECT * FROM contribution_batch_items WHERE id=? AND batch_id=? AND space_id=?",
        caseRow.actor_receipt_item_id, receipt.batch.id, receipt.space.id);
      assert(item, "case_unavailable", 404);
      return { kind: "receipt", auth: receipt, snapshot: {
        actor_receipt_session_id: receipt.session.id, actor_receipt_session_version: receipt.session.version,
        actor_batch_receipt_id: receipt.receipt.id, actor_batch_receipt_version: receipt.receipt.version,
        actor_receipt_contribution_batch_id: receipt.batch.id, actor_receipt_item_id: item.id,
        actor_receipt_item_version: item.version, actor_receipt_space_id: receipt.space.id,
        actor_receipt_space_version: receipt.space.version } };
    }
    if (ctx.viewerSession) {
      const viewer = this.core.viewer(ctx.viewerSession);
      assert(caseRow.actor_relation_kind === "viewer" && caseRow.actor_viewer_session_id === viewer.session.id &&
        caseRow.actor_external_grant_id === viewer.grant.id, "case_unavailable", 404);
      return { kind: "viewer", auth: viewer, snapshot: {
        actor_viewer_session_id: viewer.session.id, actor_viewer_session_version: viewer.session.version,
        actor_viewer_principal_id: viewer.principal.id, actor_viewer_principal_version: viewer.principal.version,
        actor_external_campaign_id: viewer.campaign.id, actor_external_campaign_version: viewer.campaign.version,
        actor_external_grant_id: viewer.grant.id, actor_external_grant_version: viewer.grant.version,
        actor_viewer_space_id: viewer.space.id, actor_viewer_space_version: viewer.space.version } };
    }
    throw new ApiError("case_unavailable", 404);
  }

  status(ctx, caseId, type) {
    const row = this.core.one("SELECT * FROM content_cases WHERE id=? AND case_type=?", caseId, type);
    assert(row, "case_unavailable", 404);
    this.caseActor(ctx, row);
    return { caseId, status: row.status, decision: row.decision_reason_code,
      appealDeadline: new Date(Date.parse(row.created_at) + 30 * 24 * 60 * 60_000).toISOString() };
  }

  appeal(ctx) {
    this.rejectMedia(ctx.body);
    const body = object(ctx.body, ["targetCaseId", "category", "statement", "clientRequestId"],
      ["targetCaseId", "category", "clientRequestId"]);
    assert(["decision_error", "context_missing", "ownership_or_consent", "privacy_or_safety", "other"].includes(body.category),
      "appeal_submission_unavailable", 400);
    const category = body.category;
    if (body.statement != null) string(body.statement, { max: 2000 });
    if (body.category === "other") string(body.statement, { max: 2000 });
    const parent = this.core.one("SELECT * FROM content_cases WHERE id=? AND case_type='report'", body.targetCaseId);
    assert(parent, "case_unavailable", 404);
    const actor = this.caseActor(ctx, parent);
    assert(actor.kind !== "viewer", "appeal_submission_unavailable", 403);
    const notice = this.notice(ctx, "appeal");
    const scope = actor.kind === "account" ? `appeal-account:${actor.auth.accountId}:${parent.id}` :
      actor.kind === "receipt" ? `appeal-receipt:${actor.auth.receipt.id}:${parent.id}` :
        `appeal-case:${parent.id}`;
    return this.core.mutation(ctx, { endpoint: "/v1/appeals", scope, replayClass: "credential_reissue",
      beforeCreate: () => this.claimAdmission({ authorizationKind: actor.kind,
        authorizationId: actor.auth.authorizationId, target: `case:${parent.id}`, category }),
      reissue: (completed) => this.reissueCaseAccess(completed) }, () => {
      const caseId = id("case");
      this.insertCase({ id: caseId, space_id: parent.space_id, case_type: "appeal", parent_case_id: parent.id,
        target_type: parent.target_type, target_photo_id: parent.target_photo_id, target_space_id: parent.target_space_id,
        target_account_id: parent.target_account_id, target_version: parent.target_version,
        actor_relation_kind: actor.kind, ...actor.snapshot, category,
        description: body.statement ?? null, status: "open", created_at: this.core.now(), version: 1 });
      const access = actor.kind === "account" ? null : this.issueCaseAccess(caseId, "appellant");
      this.db.prepare(`INSERT INTO notice_ack_events(
        id,space_id,actor_auth_kind,authorization_id,notice_id,notice_version,notice_hash,notice_purpose,target_mutation_id,acknowledged_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id("ack"), parent.space_id, actor.kind, actor.auth.authorizationId,
      notice.id, notice.version, notice.content_hash, "appeal", caseId, this.core.now());
      return { caseId, status: "open", actorRelationKind: actor.kind, ...(access ?? {}) };
    });
  }

  support(ctx) {
    const body = ctx.body ?? {};
    assert(body && typeof body === "object" && !Array.isArray(body), "support_submission_unavailable", 400);
    const allowed = new Set(["category", "description"]);
    assert(Object.keys(body).every((field) => allowed.has(field)), "unsupported_field", 400);
    object(body, ["category", "description"], ["category", "description"]);
    const category = string(body.category, { max: 64, code: "support_submission_unavailable" });
    const description = string(body.description, { max: 2000 });
    const account = ctx.accountSession ? this.core.account(ctx.accountSession) : null;
    const riskMac = this.core.keyring.mac("support-risk-scope-v1", ctx.riskScope).toString("hex");
    const scope = account?.session.id ?? `anonymous-support:${riskMac}`;
    return this.core.mutation(ctx, { endpoint: "/v1/support-cases", scope, replayClass: "credential_reissue",
      beforeCreate: () => this.claimAdmission({ authorizationKind: account ? "account" : "anonymous_risk",
        authorizationId: account?.authorizationId ?? riskMac, target: "none", category }),
      reissue: (completed) => this.reissueCaseAccess(completed) }, () => {
      const caseId = id("case");
      const relation = account ? "account" : "case_access";
      if (!account) {
        // The FK is deferred below by inserting the session and case in the same transaction.
        const access = this.issueCaseAccess(caseId, "support_requester");
        this.insertCase({ id: caseId, case_type: "support", target_type: "none", actor_relation_kind: "case_access",
          actor_case_access_session_id: access.caseAccessSessionId, actor_parent_case_id: caseId,
          actor_case_access_session_version: 1, actor_parent_case_version: 1,
          category, description, status: "open", created_at: this.core.now(), version: 1 });
        return { caseId, status: "open", ...access };
      }
      this.insertCase({ id: caseId, case_type: "support", target_type: "none", actor_relation_kind: relation,
        actor_account_id: account.accountId, actor_account_session_id: account.session.id,
        actor_account_session_version: account.session.version, actor_account_session_epoch: account.account.session_epoch,
        category, description, status: "open", created_at: this.core.now(), version: 1 });
      const access = null;
      return { caseId, status: "open", ...(access ?? {}) };
    });
  }

  transition(ctx, accountCtx, spaceId, caseId) {
    const body = object(ctx.body, ["nextStatus", "decisionReasonCode", "note", "clientRequestId"],
      ["nextStatus", "decisionReasonCode", "clientRequestId"]);
    assert(["in_review", "resolved", "rejected"].includes(body.nextStatus), "case_transition_not_allowed", 409);
    const access = this.core.accountSpace(accountCtx, spaceId, { scope: "canReview" });
    return this.core.mutation(ctx, { endpoint: `/v1/spaces/${spaceId}/content-cases/${caseId}/transitions`,
      scope: accountCtx.session.id, reauthorize: () => this.core.accountSpace(this.core.account(ctx.accountSession),
        spaceId, { scope: "canReview" }) }, () => {
      const row = this.core.one("SELECT * FROM content_cases WHERE id=? AND space_id=?", caseId, spaceId);
      assert(row, "case_unavailable", 404);
      this.core.requireIfMatch(ctx, row);
      assert(row.status !== body.nextStatus, "case_transition_not_allowed", 409);
      this.db.prepare("UPDATE content_cases SET status=?,decision_reason_code=?,version=version+1 WHERE id=? AND version=?")
        .run(body.nextStatus, body.decisionReasonCode, row.id, row.version);
      this.db.prepare(`INSERT INTO case_decision_events(
        id,space_id,case_id,before_status,after_status,decision_reason_code,note,case_actor_relation_kind,
        exact_authorization_snapshot,request_id,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id("cde"), spaceId, caseId, row.status, body.nextStatus,
      body.decisionReasonCode, body.note ?? null, access.authKind, json({ authorizationId: access.authorizationId,
        version: access.owner ? access.space.version : access.membership.version }), ctx.requestId, this.core.now());
      return { caseId, status: body.nextStatus, decisionReasonCode: body.decisionReasonCode, version: row.version + 1,
        originalActorRelationKind: row.actor_relation_kind };
    });
  }
}
