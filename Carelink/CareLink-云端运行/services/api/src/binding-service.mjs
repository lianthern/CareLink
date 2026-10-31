import { ApiError, assert } from "./errors.mjs";
import { id, secret } from "./util.mjs";
import { object } from "./schemas.mjs";

export class BindingService {
  constructor(core, identity, spaceService) {
    this.core = core;
    this.db = core.db;
    this.identity = identity;
    this.spaceService = spaceService;
  }

  request(ctx) {
    const body = object(ctx.body, ["email", "locale"], ["email"]);
    const receipt = this.core.receipt(ctx.receiptSession);
    assert(Date.parse(receipt.receipt.recovery_until) > this.core.nowMs(), "recovery_window_closed", 409);
    const delegated = { ...ctx, body: { email: body.email, purpose: "receipt_account_binding", locale: body.locale },
      idempotencyKey: ctx.idempotencyKey, authorizationId: receipt.session.id };
    return this.identity.requestOtp(delegated, {
      endpoint: "/v1/batch-receipt/account-binding-otp-challenges",
      scopePrefix: `receipt-binding:${receipt.session.id}`,
      // The human-verification gate targets the *public, unauthenticated* /login entry point
      // (identity-service.mjs's requestOtp() default requirePow:true, wired to the direct
      // /v1/auth/email-otp-challenges route below). This call site already requires a live
      // receipt session (asserted above), so it isn't the open abuse surface the PoW gate exists
      // for -- and requirePow is this trusted internal caller's own flag, not the client-supplied
      // `purpose` string, so it can't be spoofed by posting straight to the /login endpoint.
      requirePow: false
    });
  }

  confirm(ctx) {
    const body = object(ctx.body, ["challengeId", "otp"], ["challengeId", "otp"]);
    const receipt = this.core.receipt(ctx.receiptSession);
    assert(Date.parse(receipt.receipt.recovery_until) > this.core.nowMs(), "recovery_window_closed", 409);
    const result = this.core.mutation(ctx, { endpoint: "/v1/batch-receipt/account-bindings", scope: receipt.session.id }, () => {
      const notice = this.spaceService.requireNotice(ctx, "receipt_account_binding");
      const challenge = this.identity.verifyChallenge(body.challengeId, body.otp,
        (row) => row.purpose === "receipt_account_binding");
      if (!challenge) return { _error: "verification_failed" };
      let verified = this.core.one("SELECT * FROM account_verified_identifiers WHERE identifier_equivalence_id=? AND status='active'", challenge.identifier_equivalence_id);
      let account = verified ? this.core.one("SELECT * FROM accounts WHERE id=?", verified.account_id) : null;
      if (!account) {
        const accountId = id("acct");
        this.db.prepare("INSERT INTO accounts(id,locale,status,session_epoch,version,created_at) VALUES(?,'zh-CN','active',1,1,?)")
          .run(accountId, this.core.now());
        verified = { id: id("vid"), account_id: accountId };
        this.db.prepare(`INSERT INTO account_verified_identifiers(
          id,account_id,identifier_equivalence_id,status,version,verified_at
        ) VALUES(?,?,?,'active',1,?)`).run(verified.id, accountId, challenge.identifier_equivalence_id, this.core.now());
        account = this.core.one("SELECT * FROM accounts WHERE id=?", accountId);
      }
      this.db.prepare("UPDATE email_otp_challenges SET consumed_at=?,version=version+1 WHERE id=?")
        .run(this.core.now(), challenge.id);
      const bindingId = id("binding");
      this.db.prepare(`INSERT INTO receipt_account_bindings(
        id,space_id,batch_receipt_id,account_id,verified_identifier_id,verified_by_otp_challenge_id,bound_at,version
      ) VALUES(?,?,?,?,?,?,?,1)`).run(bindingId, receipt.space.id, receipt.receipt.id, account.id, verified.id, challenge.id, this.core.now());
      this.db.prepare(`INSERT INTO notice_ack_events(
        id,space_id,actor_auth_kind,authorization_id,notice_id,notice_version,notice_hash,notice_purpose,target_mutation_id,acknowledged_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id("ack"), receipt.space.id, "receipt_session", receipt.session.id,
      notice.id, notice.version, notice.content_hash, "receipt_account_binding", bindingId, this.core.now());
      return { bindingId, accountId: account.id, recoveryUntil: receipt.receipt.recovery_until, version: 1 };
    });
    if (result._error) throw new ApiError("verification_failed", 401);
    return result;
  }

  list(accountCtx) {
    const rows = this.core.all(`SELECT b.id bindingId,r.batch_id batchId,cb.item_count itemCount,cb.created_at createdAt,
      r.recovery_until recoveryUntil FROM receipt_account_bindings b JOIN batch_receipts r ON r.id=b.batch_receipt_id
      JOIN contribution_batches cb ON cb.id=r.batch_id JOIN spaces s ON s.id=b.space_id
      WHERE b.account_id=? AND b.revoked_at IS NULL AND r.revoked_at IS NULL AND r.recovery_until>? AND s.space_lifecycle='active'`,
    accountCtx.accountId, this.core.now());
    return { items: rows.map((row) => ({ ...row, canRecover: true })), selectionRequired: true, recoverAction: "BATCH.RECOVER_FROM_ACCOUNT" };
  }

  recover(ctx, accountCtx) {
    const body = object(ctx.body, ["bindingId"], ["bindingId"]);
    const result = this.core.mutation(ctx, { endpoint: "/v1/me/batch-receipt-recoveries", scope: accountCtx.session.id,
      replayClass: "credential_reissue", reauthorize: () => this.core.account(ctx.accountSession),
      reissue: (completed) => this.issueRecovery(accountCtx, completed.bindingId) }, () =>
      this.issueRecovery(accountCtx, body.bindingId));
    if (result._error) throw new ApiError(result._error, 404);
    return result;
  }

  issueRecovery(accountCtx, bindingId) {
    const binding = this.core.one("SELECT * FROM receipt_account_bindings WHERE id=? AND account_id=? AND revoked_at IS NULL",
      bindingId, accountCtx.accountId);
    const receipt = binding ? this.core.one("SELECT * FROM batch_receipts WHERE id=?", binding.batch_receipt_id) : null;
    const space = binding ? this.core.one("SELECT * FROM spaces WHERE id=?", binding.space_id) : null;
    if (space?.space_lifecycle === "archived") return { _error: "batch_access_unavailable" };
    if (!binding || !receipt || !space || receipt.revoked_at || Date.parse(receipt.recovery_until) <= this.core.nowMs()) {
      return { _error: "receipt_recovery_unavailable" };
    }
    const accessMs = Math.min(this.core.nowMs() + 30 * 24 * 60 * 60_000, Date.parse(receipt.recovery_until));
    assert(accessMs > this.core.nowMs(), "receipt_recovery_unavailable", 404);
    const accessExpiresAt = new Date(accessMs).toISOString();
    const raw = secret();
    const credential = this.core.keyring.credential("receipt-session-v1", raw);
    const sessionId = id("rs");
    this.db.prepare("UPDATE receipt_sessions SET revoked_at=COALESCE(revoked_at,?),version=version+1 WHERE batch_receipt_id=?")
      .run(this.core.now(), receipt.id);
    const updatedReceipt = this.db.prepare(`UPDATE batch_receipts SET access_expires_at=?,version=version+1
      WHERE id=? AND version=? AND revoked_at IS NULL`).run(accessExpiresAt, receipt.id, receipt.version);
    assert(updatedReceipt.changes === 1, "concurrent_change", 409);
    const updatedBinding = this.db.prepare("UPDATE receipt_account_bindings SET version=version+1 WHERE id=? AND version=?")
      .run(binding.id, binding.version);
    assert(updatedBinding.changes === 1, "concurrent_change", 409);
    this.db.prepare(`INSERT INTO receipt_sessions(
      id,space_id,batch_receipt_id,batch_id,actor_id,credential_mac,credential_key_id,receipt_version_at_issue,access_expires_at,version
    ) VALUES(?,?,?,?,?,?,?,?,?,1)`).run(sessionId, space.id, receipt.id, receipt.batch_id, receipt.actor_id,
    credential.mac, credential.keyId, receipt.version + 1, accessExpiresAt);
    return { bindingId: binding.id, receiptSessionId: sessionId, receiptSessionSecret: raw,
      batchId: receipt.batch_id, accessExpiresAt, recoveryUntil: receipt.recovery_until };
  }
}
