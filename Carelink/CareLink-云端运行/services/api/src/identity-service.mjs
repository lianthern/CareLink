import { requireAccountAdmission } from './admin-service.mjs';
import { randomInt } from "node:crypto";
import { ApiError, assert } from "./errors.mjs";
import { IDENTITY_ENVELOPE_FORMAT, identityEnvelopeAad, maskEmail, normalizeEmail } from "./crypto.mjs";
import { id, json, logStructured, parseJson, secret } from "./util.mjs";
import { object, REAUTH_PURPOSES, string } from "./schemas.mjs";

export class IdentityService {
  constructor(core, { otpOutbox, otpCaptcha } = {}) {
    this.core = core;
    this.db = core.db;
    this.keyring = core.keyring;
    this.otpOutbox = otpOutbox;
    this.otpCaptcha = otpCaptcha;
  }

  otpRateBinding(kind, value) {
    const domains = { equivalence: "otp-rate-equivalence-v1", server_risk: "otp-rate-server-risk-v1" };
    return { kind, mac: this.keyring.mac(domains[kind], value), limit: kind === "equivalence" ? 5 : 20 };
  }

  claimOtpCounter(binding, purpose) {
    const bucketMs = Math.floor(this.core.nowMs() / (10 * 60_000)) * 10 * 60_000;
    const bucket = new Date(bucketMs).toISOString();
    const expiresAt = new Date(bucketMs + 20 * 60_000).toISOString();
    const row = this.core.one(`SELECT * FROM otp_issuance_rate_counters
      WHERE scope_kind=? AND scope_key_id=? AND scope_mac=? AND bucket_start=? AND purpose=?`,
    binding.kind, this.keyring.keyId, binding.mac, bucket, purpose);
    if (row?.count >= binding.limit || (row?.blocked_until && Date.parse(row.blocked_until) > this.core.nowMs())) {
      logStructured("otp_rate_limited", { scopeKind: binding.kind, purpose, count: row?.count ?? 0, limit: binding.limit });
      return { allowed: false, mac: binding.mac };
    }
    if (row) {
      const updated = this.db.prepare(`UPDATE otp_issuance_rate_counters SET count=count+1,version=version+1
        WHERE scope_kind=? AND scope_key_id=? AND scope_mac=? AND bucket_start=? AND purpose=? AND version=?`)
        .run(binding.kind, this.keyring.keyId, binding.mac, bucket, purpose, row.version);
      assert(updated.changes === 1, "concurrent_change", 409);
    } else {
      this.db.prepare(`INSERT INTO otp_issuance_rate_counters(
        scope_kind,scope_mac,scope_key_id,bucket_start,purpose,count,blocked_until,expires_at,version
        ) VALUES(?,?,?,?,?,1,NULL,?,1)`).run(binding.kind, binding.mac, this.keyring.keyId, bucket, purpose, expiresAt);
    }
    return { allowed: true, mac: binding.mac };
  }

  claimOtpServerRisk(purpose, riskScope) {
    return this.claimOtpCounter(this.otpRateBinding("server_risk", riskScope), purpose);
  }

  claimOtpEquivalence(equivalenceId, purpose) {
    return this.claimOtpCounter(this.otpRateBinding("equivalence", equivalenceId), purpose);
  }

  ensureIdentity(email) {
    const normalized = normalizeEmail(email);
    const collision = this.keyring.equivalentEmail(normalized);
    let equivalence = null;
    for (const candidate of this.keyring.equivalentEmailCandidates(normalized)) {
      equivalence = this.core.one("SELECT * FROM identifier_equivalences WHERE identity_type='email_v1' AND normalized_collision_key=? AND status='active'", candidate.mac);
      if (equivalence) break;
    }
    if (!equivalence) {
      equivalence = { id: id("eq"), version: 1 };
      const envelope = this.keyring.sealIdentity(normalized,
        identityEnvelopeAad(equivalence.id, "email_v1", IDENTITY_ENVELOPE_FORMAT));
      this.db.prepare(`INSERT INTO identifier_equivalences(
        id,identity_type,normalized_collision_key,collision_key_epoch,status,version,created_at,
        normalized_identifier_ciphertext,normalized_identifier_envelope_key_id,normalized_identifier_envelope_format
      ) VALUES(?,?,?,?, 'active',1,?,?,?,?)`).run(equivalence.id, "email_v1", collision, this.keyring.keyId,
      this.core.now(), envelope, this.keyring.keyId, IDENTITY_ENVELOPE_FORMAT);
      equivalence = { ...equivalence, collision_key_epoch: this.keyring.keyId,
        normalized_identifier_ciphertext: envelope,
        normalized_identifier_envelope_key_id: this.keyring.keyId,
        normalized_identifier_envelope_format: IDENTITY_ENVELOPE_FORMAT };
    }
    const identifierMac = this.keyring.identifier(normalized);
    let alias = null;
    for (const candidate of this.keyring.identifierCandidates(normalized)) {
      alias = this.core.one("SELECT * FROM account_verified_identifier_aliases WHERE identifier_key_id=? AND identifier_mac=?",
        candidate.keyId, candidate.mac);
      if (alias) break;
    }
    if (alias && alias.identifier_key_id !== this.keyring.keyId) {
      this.db.prepare("UPDATE account_verified_identifier_aliases SET status='previous',grace_expires_at=?,version=version+1 WHERE id=?")
        .run(new Date(this.core.nowMs() + 30 * 24 * 60 * 60_000).toISOString(), alias.id);
      alias = null;
    }
    if (!alias) {
      alias = { id: id("alias"), version: 1 };
      this.db.prepare(`INSERT INTO account_verified_identifier_aliases(
        id,identifier_equivalence_id,identifier_mac,identifier_key_id,display_mask,status,version,created_at
      ) VALUES(?,?,?,?,?,'current',1,?)`).run(alias.id, equivalence.id, identifierMac, this.keyring.keyId, maskEmail(normalized), this.core.now());
    }
    const pendingEnvelope = equivalence.normalized_identifier_ciphertext ? null : {
      ciphertext: this.keyring.sealIdentity(normalized,
        identityEnvelopeAad(equivalence.id, equivalence.identity_type, IDENTITY_ENVELOPE_FORMAT)),
      keyId: this.keyring.keyId,
      format: IDENTITY_ENVELOPE_FORMAT
    };
    return { normalized, equivalenceId: equivalence.id, aliasId: alias.id, mask: maskEmail(normalized), pendingEnvelope };
  }

  // Unauthenticated, provider-agnostic front door for the human-verification gate in front of
  // requestOtp() below: any /login visitor may mint one of these before ever supplying an email
  // address. The response shape is mode-tagged ({mode:"pow"|"tencent_captcha"|"disabled", ...})
  // so the frontend can render the right widget -- today only "pow" has a client implementation
  // (apps/web/src/otp-pow/), see ports/captcha/tencent-captcha-port.mjs's header for what's left
  // to wire up the other mode.
  requestVerificationChallenge(ctx) {
    object(ctx.body ?? {}, []);
    return this.otpCaptcha.issue(ctx);
  }

  requestOtp(ctx, { endpoint = "/v1/auth/email-otp-challenges", scopePrefix = "otp-request", requirePow = true,
    purposeOverride = null, resolveBinding = null } = {}) {
    const body = object(ctx.body, ["email", "purpose", "locale", "noticeVersion",
      "verificationChallengeId", "verificationNonce", "verificationSelection"], ["email", "purpose"]);
    const purpose = string(body.purpose, { max: 64 });
    assert(purposeOverride ? purpose === purposeOverride : ["login", "receipt_account_binding"].includes(purpose), "validation_failed", 400);
    this.otpOutbox.requireAvailable();
    const challengeId = id("otp");
    const expiresAt = new Date(this.core.nowMs() + 10 * 60_000).toISOString();
    let risk = null;
    return this.core.mutation(ctx, {
      endpoint,
      scope: `${scopePrefix}:${this.keyring.identifier(normalizeEmail(body.email)).toString("hex")}`,
      beforeCreate: () => {
        // requirePow is a server-controlled call-site flag (true for the direct /login route,
        // false only for binding-service.mjs's internal delegation), never the client-supplied
        // `purpose` string -- so a direct POST to /v1/auth/email-otp-challenges can't dodge the
        // gate by simply claiming purpose:"receipt_account_binding". A valid proof is consumed
        // here (inside beforeCreate, which core.mutation() skips entirely on an idempotent
        // replay) so a solved challenge is burned exactly once per fresh attempt, regardless of
        // what the risk/equivalence counters below decide afterwards.
        if (requirePow) this.otpCaptcha.consume(ctx, { challengeId: body.verificationChallengeId,
          nonce: body.verificationNonce, selection: body.verificationSelection });
        risk = this.claimOtpServerRisk(purpose, ctx.riskScope);
        return risk.allowed ? null : { _shortCircuit: { accepted: true, challengeId, expiresAt } };
      }
    }, () => {
      const identity = this.ensureIdentity(body.email);
      const rate = this.claimOtpEquivalence(identity.equivalenceId, purpose);
      if (!rate.allowed) return { accepted: true, challengeId, expiresAt };
      const binding = resolveBinding?.(identity);
      if (resolveBinding && !binding) return { accepted: true, challengeId, expiresAt };
      // Site-wide send budget: the last gate before this actually costs an SES send. Checked
      // (and, on success, incremented) only once both the per-email and per-risk-scope counters
      // above already allowed this attempt, so it only ever counts genuine near-sends.
      const budget = this.otpOutbox.claimSendBudget(ctx);
      if (!budget.allowed) return { accepted: true, challengeId, expiresAt };
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      this.db.prepare(`INSERT INTO email_otp_challenges(
        id,purpose,identifier_equivalence_id,identifier_alias_id,otp_mac,otp_key_id,attempts,expires_at,
        rate_limit_mac,rate_limit_key_id,risk_limit_mac,risk_limit_key_id,pending_identifier_ciphertext,
        pending_identifier_envelope_key_id,pending_identifier_envelope_format,bound_account_id,bound_action_id,bound_target_type,bound_target_id,version,created_at
      ) VALUES(?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`).run(challengeId, purpose, identity.equivalenceId, identity.aliasId,
      this.keyring.otp(challengeId, identity.equivalenceId, purpose, code), this.keyring.keyId, expiresAt,
      rate.mac, this.keyring.keyId, risk.mac, this.keyring.keyId, identity.pendingEnvelope?.ciphertext ?? null,
      identity.pendingEnvelope?.keyId ?? null, identity.pendingEnvelope?.format ?? null,
      binding?.accountId ?? null, binding?.actionId ?? null, binding?.targetType ?? null, binding?.targetId ?? null, this.core.now());
      this.otpOutbox.enqueue({ challengeId, code, normalizedEmail: identity.normalized, purpose, expiresAt });
      return { accepted: true, challengeId, expiresAt };
    });
  }

  verifyChallenge(challengeId, otp, predicate = () => true) {
    const challenge = this.core.one("SELECT * FROM email_otp_challenges WHERE id=?", challengeId);
    const expectedOtp = challenge ? this.keyring.otpCandidates(challenge.id, challenge.identifier_equivalence_id,
      challenge.purpose, otp).find((candidate) => candidate.keyId === challenge.otp_key_id)?.mac : null;
    const valid = challenge && !challenge.consumed_at && !challenge.revoked_at && challenge.attempts < 5 &&
      Date.parse(challenge.expires_at) > this.core.nowMs() && predicate(challenge) &&
      this.keyring.equal(challenge.otp_mac, expectedOtp);
    if (!valid && challenge && !challenge.consumed_at && !challenge.revoked_at && challenge.attempts < 5) {
      const attempts = challenge.attempts + 1;
      const updated = this.db.prepare(`UPDATE email_otp_challenges SET attempts=?,
        revoked_at=CASE WHEN ?>=5 THEN ? ELSE revoked_at END,version=version+1
        WHERE id=? AND version=? AND consumed_at IS NULL AND revoked_at IS NULL`).run(
      attempts, attempts, this.core.now(), challenge.id, challenge.version);
      assert(updated.changes === 1, "concurrent_change", 409);
    }
    return valid ? challenge : null;
  }

  issueAccountSession(account) {
    assert(account?.status === "active", "authentication_failed", 401);
    requireAccountAdmission(this.core, account.id);
    this.db.prepare("INSERT INTO account_administration(account_id,last_login_at) VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET last_login_at=excluded.last_login_at").run(account.id,this.core.now());
    const issued = this.core.issue("account_sessions", "account-session-v1", {}, 30 * 24 * 60 * 60_000, "as");
    const familyId = id("af");
    this.db.prepare(`INSERT INTO account_session_families(
      id,account_id,issued_session_epoch,version,created_at
    ) VALUES(?,?,?,1,?)`).run(familyId, account.id, account.session_epoch, this.core.now());
    this.db.prepare(`INSERT INTO account_sessions(
      id,account_id,family_id,issued_session_epoch,credential_mac,credential_key_id,version,expires_at
    ) VALUES(?,?,?,?,?,?,1,?)`).run(issued.sessionId, account.id, familyId, account.session_epoch,
    issued.credential.mac, issued.credential.keyId, issued.expiresAt);
    return { accountId: account.id, accountSessionId: issued.sessionId, sessionEpoch: account.session_epoch,
      expiresAt: issued.expiresAt, accountSessionSecret: issued.raw };
  }

  reissueAccountSession(completed) {
    if (completed.registration) return completed;
    const account = this.core.one("SELECT * FROM accounts WHERE id=?", completed.accountId);
    this.db.prepare("UPDATE account_sessions SET revoked_at=COALESCE(revoked_at,?),version=version+1 WHERE id=? AND account_id=?")
      .run(this.core.now(), completed.accountSessionId, completed.accountId);
    return this.issueAccountSession(account);
  }

  verifyOtp(ctx) {
    const body = object(ctx.body, ["challengeId", "otp", "purpose"], ["challengeId", "otp", "purpose"]);
    assert(["login", "receipt_account_binding"].includes(body.purpose), "validation_failed", 400);
    const result = this.core.mutation(ctx, {
      endpoint: "/v1/auth/email-otp-verifications",
      scope: `otp-verify:${body.challengeId}`,
      replayClass: "credential_reissue",
      reissue: (completed) => this.reissueAccountSession(completed)
    }, () => {
      const challenge = this.verifyChallenge(body.challengeId, body.otp,
        (row) => row.purpose === body.purpose);
      if (!challenge) return { _error: "authentication_failed" };
      this.backfillIdentityEnvelope(challenge);
      let verified = this.core.one("SELECT * FROM account_verified_identifiers WHERE identifier_equivalence_id=? AND status='active'", challenge.identifier_equivalence_id);
      let account;
      if (verified) account = this.core.one("SELECT * FROM accounts WHERE id=?", verified.account_id);
      if (!account) {
        account = { id: id("acct"), status: "active", version: 1, session_epoch: 1 };
        this.db.prepare("INSERT INTO accounts(id,locale,status,session_epoch,version,created_at) VALUES(?,?,'active',1,1,?)")
          .run(account.id, "zh-CN", this.core.now());
        this.db.prepare("INSERT INTO account_administration(account_id,status) VALUES(?,'active')").run(account.id);
        verified = { id: id("vid"), account_id: account.id, version: 1 };
        this.db.prepare(`INSERT INTO account_verified_identifiers(
          id,account_id,identifier_equivalence_id,status,version,verified_at
        ) VALUES(?,?,?,'active',1,?)`).run(verified.id, account.id, challenge.identifier_equivalence_id, this.core.now());
      }
      this.db.prepare("UPDATE email_otp_challenges SET consumed_at=?,version=version+1 WHERE id=?")
        .run(this.core.now(), challenge.id);
      const admission=this.core.one('SELECT status FROM account_administration WHERE account_id=?',account.id);
      if(admission?.status==='pending') return {registration:{accountId:account.id,username:null,status:'pending'}};
      return this.issueAccountSession(account);
    });
    if (result._error) throw new ApiError(result._error, 401);
    return result;
  }

  backfillIdentityEnvelope(challenge) {
    if (!challenge.pending_identifier_ciphertext) return;
    const equivalence = this.core.one("SELECT * FROM identifier_equivalences WHERE id=? AND status='active'",
      challenge.identifier_equivalence_id);
    assert(equivalence, "authentication_failed", 401);
    if (equivalence.normalized_identifier_ciphertext) return;
    const normalized = normalizeEmail(this.keyring.openIdentity(challenge.pending_identifier_ciphertext,
      identityEnvelopeAad(equivalence.id, equivalence.identity_type, challenge.pending_identifier_envelope_format),
      challenge.pending_identifier_envelope_key_id));
    const expected = this.keyring.equivalentEmailForKey(normalized, equivalence.collision_key_epoch);
    assert(this.keyring.equal(expected, equivalence.normalized_collision_key), "identity_rekey_decrypt_failed", 409);
    const updated = this.db.prepare(`UPDATE identifier_equivalences SET normalized_identifier_ciphertext=?,
      normalized_identifier_envelope_key_id=?,normalized_identifier_envelope_format=?,version=version+1
      WHERE id=? AND version=? AND normalized_identifier_ciphertext IS NULL`).run(
    challenge.pending_identifier_ciphertext, challenge.pending_identifier_envelope_key_id,
    challenge.pending_identifier_envelope_format, equivalence.id, equivalence.version);
    assert(updated.changes === 1, "concurrent_change", 409);
  }

  me(accountCtx) {
    const identifiers = this.core.all(`SELECT a.display_mask,a.status,v.version
      FROM account_verified_identifiers v JOIN account_verified_identifier_aliases a
      ON a.identifier_equivalence_id=v.identifier_equivalence_id
      WHERE v.account_id=? AND v.status='active' AND a.status='current'`, accountCtx.accountId);
    const sessions = this.core.all("SELECT id,version,expires_at,revoked_at FROM account_sessions WHERE account_id=?", accountCtx.accountId);
    // v3.1: surfaces whether the account already has a lazily-created personal
    // default space, so the web client can link straight to its upload page
    // instead of round-tripping through POST /v1/me/personal-space every time.
    const personalSpace = this.core.one("SELECT id FROM spaces WHERE owner_account_id=? AND is_personal_default=1", accountCtx.accountId);
    return { accountId: accountCtx.accountId, locale: accountCtx.account.locale, version: accountCtx.account.version,
      sessionEpoch: accountCtx.account.session_epoch, identifiers, sessions, personalSpaceId: personalSpace?.id ?? null };
  }

  logout(ctx, accountCtx) {
    return this.core.mutation(ctx, { endpoint: "/v1/auth/logout", scope: accountCtx.session.id, replayClass: "completed_state" }, () => {
      this.db.prepare("UPDATE account_sessions SET revoked_at=?,version=version+1 WHERE id=? AND revoked_at IS NULL")
        .run(this.core.now(), accountCtx.session.id);
      return { revoked: true, sessionId: accountCtx.session.id, _clearAccountSessionCookie: true };
    });
  }

  requestReauth(ctx, accountCtx) {
    const body = object(ctx.body, ["actionId", "purpose", "targetType", "targetId", "locale"], ["actionId", "purpose"]);
    assert(REAUTH_PURPOSES.get(body.actionId) === body.purpose, "reauth_challenge_unavailable", 400);
    this.otpOutbox.requireAvailable();
    const challengeId = id("otp");
    const expiresAt = new Date(this.core.nowMs() + 10 * 60_000).toISOString();
    let risk = null;
    return this.core.mutation(ctx, { endpoint: "/v1/auth/reauth-challenges", scope: accountCtx.session.id,
      beforeCreate: () => {
        risk = this.claimOtpServerRisk(body.purpose, ctx.riskScope);
        return risk.allowed ? null : { _shortCircuit: { accepted: true, challengeId, expiresAt } };
      } }, () => {
      const verified = this.core.one(`SELECT v.*,a.id alias_id FROM account_verified_identifiers v
        JOIN account_verified_identifier_aliases a ON a.identifier_equivalence_id=v.identifier_equivalence_id AND a.status='current'
        WHERE v.account_id=? AND v.status='active'`, accountCtx.accountId);
      assert(verified, "reauth_challenge_unavailable", 404);
      const equivalence = this.core.one("SELECT * FROM identifier_equivalences WHERE id=? AND status='active'",
        verified.identifier_equivalence_id);
      assert(equivalence?.normalized_identifier_ciphertext && equivalence.normalized_identifier_envelope_key_id &&
        equivalence.normalized_identifier_envelope_format === IDENTITY_ENVELOPE_FORMAT,
      "identity_rekey_envelope_unavailable", 503);
      const normalizedEmail = normalizeEmail(this.keyring.openIdentity(equivalence.normalized_identifier_ciphertext,
        identityEnvelopeAad(equivalence.id, equivalence.identity_type,
          equivalence.normalized_identifier_envelope_format),
        equivalence.normalized_identifier_envelope_key_id));
      assert(this.keyring.equal(this.keyring.equivalentEmailForKey(normalizedEmail, equivalence.collision_key_epoch),
        equivalence.normalized_collision_key), "identity_rekey_decrypt_failed", 409);
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      const rate = this.claimOtpEquivalence(verified.identifier_equivalence_id, body.purpose);
      if (!rate.allowed) return { accepted: true, challengeId, expiresAt };
      this.db.prepare(`INSERT INTO email_otp_challenges(
        id,purpose,identifier_equivalence_id,identifier_alias_id,otp_mac,otp_key_id,attempts,expires_at,
        bound_account_id,bound_action_id,bound_target_type,bound_target_id,rate_limit_mac,rate_limit_key_id,
        risk_limit_mac,risk_limit_key_id,version,created_at
      ) VALUES(?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,1,?)`).run(challengeId, body.purpose, verified.identifier_equivalence_id,
      verified.alias_id, this.keyring.otp(challengeId, verified.identifier_equivalence_id, body.purpose, code), this.keyring.keyId,
      expiresAt, accountCtx.accountId, body.actionId, body.targetType ?? null, body.targetId ?? null,
      rate.mac, this.keyring.keyId, risk.mac, this.keyring.keyId, this.core.now());
      this.otpOutbox.enqueue({ challengeId, code, normalizedEmail, purpose: body.purpose, expiresAt });
      return { accepted: true, challengeId, expiresAt };
    });
  }

  verifyReauth(ctx, accountCtx) {
    const body = object(ctx.body, ["challengeId", "otp", "actionId", "purpose", "targetType", "targetId"],
      ["challengeId", "otp", "actionId", "purpose"]);
    const result = this.core.mutation(ctx, {
      endpoint: "/v1/auth/reauth-verifications", scope: accountCtx.session.id, replayClass: "credential_reissue",
      reauthorize: () => this.core.account(ctx.accountSession),
      reissue: (completed) => this.reissueReauth(accountCtx, completed)
    }, () => {
      const challenge = this.verifyChallenge(body.challengeId, body.otp, (row) =>
        REAUTH_PURPOSES.get(body.actionId) === body.purpose && row.bound_account_id === accountCtx.accountId &&
        row.bound_action_id === body.actionId && row.purpose === body.purpose &&
        (row.bound_target_type ?? null) === (body.targetType ?? null) &&
        (row.bound_target_id ?? null) === (body.targetId ?? null));
      if (!challenge) return { _error: "authentication_failed" };
      this.db.prepare("UPDATE email_otp_challenges SET consumed_at=?,version=version+1 WHERE id=?")
        .run(this.core.now(), challenge.id);
      const raw = secret();
      const credential = this.keyring.credential("reauth-grant-v1", raw);
      const grantId = id("reauth");
      const expiresAt = new Date(this.core.nowMs() + 5 * 60_000).toISOString();
      this.db.prepare(`INSERT INTO reauth_grants(
        id,account_id,purpose,issued_session_epoch,credential_mac,credential_key_id,bound_action_id,
        bound_target_type,bound_target_id,version,expires_at
      ) VALUES(?,?,?,?,?,?,?,?,?,1,?)`).run(grantId, accountCtx.accountId, body.purpose, accountCtx.account.session_epoch,
      credential.mac, credential.keyId, body.actionId, body.targetType ?? null, body.targetId ?? null, expiresAt);
      return { reauthGrantId: grantId, reauthGrantSecret: raw, purpose: body.purpose, expiresAt };
    });
    if (result._error) throw new ApiError(result._error, 401);
    return result;
  }

  reissueReauth(accountCtx, completed) {
    const previous = this.core.one("SELECT * FROM reauth_grants WHERE id=? AND account_id=?", completed.reauthGrantId,
      accountCtx.accountId);
    assert(previous && previous.issued_session_epoch === accountCtx.account.session_epoch &&
      Date.parse(previous.expires_at) > this.core.nowMs(), "reauth_required", 403);
    this.db.prepare("UPDATE reauth_grants SET revoked_at=COALESCE(revoked_at,?),version=version+1 WHERE id=?")
      .run(this.core.now(), previous.id);
    const raw = secret();
    const credential = this.keyring.credential("reauth-grant-v1", raw);
    const grantId = id("reauth");
    const expiresAt = new Date(this.core.nowMs() + 5 * 60_000).toISOString();
    this.db.prepare(`INSERT INTO reauth_grants(
      id,account_id,purpose,issued_session_epoch,credential_mac,credential_key_id,bound_action_id,
      bound_target_type,bound_target_id,version,expires_at
    ) VALUES(?,?,?,?,?,?,?,?,?,1,?)`).run(grantId, accountCtx.accountId, previous.purpose,
    accountCtx.account.session_epoch, credential.mac, credential.keyId, previous.bound_action_id,
    previous.bound_target_type, previous.bound_target_id, expiresAt);
    return { reauthGrantId: grantId, reauthGrantSecret: raw, purpose: previous.purpose, expiresAt };
  }

  consumeReauth(raw, accountCtx, { actionId, purpose, targetType = null, targetId = null }) {
    const grant = this.core.credentialRow("reauth_grants", "reauth-grant-v1", raw);
    assert(grant && grant.account_id === accountCtx.accountId && grant.issued_session_epoch === accountCtx.account.session_epoch &&
      grant.bound_action_id === actionId && grant.purpose === purpose && (grant.bound_target_type ?? null) === targetType &&
      (grant.bound_target_id ?? null) === targetId && !grant.consumed_at && !grant.revoked_at &&
      Date.parse(grant.expires_at) > this.core.nowMs(), "reauth_required", 403);
    this.db.prepare("UPDATE reauth_grants SET consumed_at=?,version=version+1 WHERE id=? AND version=? AND consumed_at IS NULL")
      .run(this.core.now(), grant.id, grant.version);
    return grant;
  }

  reauthGrant(raw) {
    return this.core.credentialRow("reauth_grants", "reauth-grant-v1", raw);
  }

  logoutAll(ctx, accountCtx) {
    const body = object(ctx.body, ["reauthGrant", "confirmation"], ["reauthGrant", "confirmation"]);
    assert(body.confirmation === true, "validation_failed");
    return this.core.mutation(ctx, { endpoint: "/v1/auth/logout-all", scope: accountCtx.session.id, replayClass: "completed_state" }, () => {
      this.consumeReauth(body.reauthGrant, accountCtx, { actionId: "AUTH.LOGOUT_ALL", purpose: "logout_all" });
      const epoch = accountCtx.account.session_epoch + 1;
      this.db.prepare("UPDATE accounts SET session_epoch=?,version=version+1 WHERE id=? AND version=?")
        .run(epoch, accountCtx.accountId, accountCtx.account.version);
      this.db.prepare("UPDATE account_session_families SET revoked_at=COALESCE(revoked_at,?),version=version+1 WHERE account_id=?")
        .run(this.core.now(), accountCtx.accountId);
      this.db.prepare("UPDATE account_sessions SET revoked_at=COALESCE(revoked_at,?),version=version+1 WHERE account_id=?")
        .run(this.core.now(), accountCtx.accountId);
      return { revokedAt: this.core.now(), sessionEpoch: epoch, _clearAccountSessionCookie: true };
    });
  }
}
