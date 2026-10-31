import { ApiError, assert } from './errors.mjs';
import { transaction } from './database.mjs';
import { normalizeUsername, hashAccountPassword } from './password-account-service.mjs';
import { IDENTITY_ENVELOPE_FORMAT, identityEnvelopeAad } from './crypto.mjs';
import { id } from './util.mjs';
import { object, string } from './schemas.mjs';

const RESET = 'password_reset';
const CONTACT = 'password_recovery_contact';
const approvalMs = 24 * 60 * 60_000;
const fingerprint = row => `${row.credential_version}:${row.session_epoch}`;
const validOtp = value => typeof value === 'string' && /^\d{6}$/.test(value);

// Reuses canonical email identities, OTP challenges, captcha, persistent budgets,
// delivery outbox, password derivation and session revocation. A manual request is
// evidence for a human administrator; it never grants reset authority by itself.
export class PasswordRecoveryService {
  constructor(api) {
    this.api = api; this.core = api.core; this.db = api.db;
    this.identity = api.identity; this.passwords = api.passwordAccounts; this.admin = api.adminConsole;
  }
  anonymous(ctx) { return { ...ctx, accountSession: null, selectedPrincipalKind: null }; }
  credential(accountId) {
    return this.core.one(`SELECT a.id,a.session_epoch,c.version credential_version,c.username
      FROM accounts a JOIN account_password_credentials c ON c.account_id=a.id
      LEFT JOIN account_administration m ON m.account_id=a.id
      WHERE a.id=? AND a.status='active' AND COALESCE(m.status,'active')='active'`, accountId);
  }
  emailOwner(equivalenceId) {
    return this.core.one("SELECT account_id FROM account_verified_identifiers WHERE identifier_equivalence_id=? AND status='active'", equivalenceId)?.account_id;
  }
  noBoundEmail(accountId) {
    return !this.core.one("SELECT 1 FROM account_verified_identifiers WHERE account_id=? AND status='active'", accountId);
  }
  approvalCurrent(row, credential) {
    return row?.status === 'approved' && Date.parse(row.approval_expires_at) > this.core.nowMs() && credential &&
      row.credential_version === credential.credential_version && row.account_epoch === credential.session_epoch &&
      this.noBoundEmail(row.account_id) && !this.emailOwner(row.identifier_equivalence_id);
  }
  resetBinding(identity) {
    const owner = this.emailOwner(identity.equivalenceId);
    if (owner) {
      const credential = this.credential(owner);
      return credential ? { accountId: owner, targetType: RESET, targetId: fingerprint(credential) } : null;
    }
    const candidates = this.core.all("SELECT * FROM password_recovery_requests WHERE identifier_equivalence_id=? AND status='approved' ORDER BY reviewed_at DESC,id", identity.equivalenceId);
    for (const row of candidates) {
      const credential = this.credential(row.account_id);
      if (this.approvalCurrent(row, credential)) return { accountId: row.account_id, actionId: row.id,
        targetType: RESET, targetId: fingerprint(credential) };
    }
    return null;
  }
  requestChallenge(ctx, contact = false) {
    object(ctx.body, ['email','verificationChallengeId','verificationNonce','verificationSelection'], ['email']);
    const purpose = contact ? CONTACT : RESET;
    return this.identity.requestOtp({ ...this.anonymous(ctx), body: { ...ctx.body, purpose } }, {
      endpoint: contact ? '/v1/auth/recovery-contact-challenges' : '/v1/auth/password-reset-challenges',
      scopePrefix: purpose, purposeOverride: purpose,
      resolveBinding: identity => contact ? { targetType: CONTACT } : this.resetBinding(identity)
    });
  }
  currentReset(challenge) {
    const credential = this.credential(challenge?.bound_account_id);
    if (!credential || challenge.purpose !== RESET || challenge.bound_target_type !== RESET ||
      challenge.bound_target_id !== fingerprint(credential)) return null;
    if (!challenge.bound_action_id) return this.emailOwner(challenge.identifier_equivalence_id) === credential.id ? credential : null;
    const approval = this.core.one('SELECT * FROM password_recovery_requests WHERE id=? AND account_id=? AND identifier_equivalence_id=?',
      challenge.bound_action_id, credential.id, challenge.identifier_equivalence_id);
    return this.approvalCurrent(approval, credential) ? credential : null;
  }
  async complete(ctx) {
    const body = object(ctx.body, ['challengeId','otp','newPassword']);
    assert(typeof body.challengeId === 'string' && body.challengeId.length <= 100 && validOtp(body.otp), 'authentication_failed', 401);
    assert(typeof body.newPassword === 'string' && Buffer.byteLength(body.newPassword) >= 10 && Buffer.byteLength(body.newPassword) <= 256, 'password_invalid');
    assert(this.passwords.claimRate(body.challengeId,ctx.riskScope,'password-reset'), 'authentication_rate_limited',429);
    // Commit wrong-code attempts before returning an error. Do not roll them back.
    const challenge = transaction(this.db, () => this.identity.verifyChallenge(body.challengeId, body.otp, row => Boolean(this.currentReset(row))));
    assert(challenge, 'authentication_failed',401);
    const passwordHash = await hashAccountPassword(body.newPassword);
    const result = this.core.mutation(this.passwords.privateRequest(this.anonymous(ctx)), {
      endpoint:'/v1/auth/password-reset-completions', scope:`password-reset:${challenge.id}`, reauthorize:()=>{}
    }, () => {
      const current = this.identity.verifyChallenge(body.challengeId, body.otp, row => Boolean(this.currentReset(row)));
      if (!current) return { _error:'authentication_failed' };
      const credential = this.currentReset(current);
      const changed = this.db.prepare('UPDATE account_password_credentials SET password_hash=?,version=version+1,updated_at=? WHERE account_id=? AND version=?')
        .run(passwordHash,this.core.now(),credential.id,credential.credential_version);
      assert(changed.changes === 1,'version_conflict',409);
      this.identity.backfillIdentityEnvelope(current);
      if (current.bound_action_id) {
        this.db.prepare("INSERT INTO account_verified_identifiers(id,account_id,identifier_equivalence_id,status,version,verified_at) VALUES(?,?,?,'active',1,?)")
          .run(id('vid'),credential.id,current.identifier_equivalence_id,this.core.now());
        this.db.prepare("UPDATE password_recovery_requests SET status='completed',version=version+1 WHERE id=?").run(current.bound_action_id);
      }
      this.db.prepare('UPDATE email_otp_challenges SET consumed_at=?,version=version+1 WHERE id=?').run(this.core.now(),current.id);
      this.db.prepare("UPDATE email_otp_challenges SET revoked_at=?,version=version+1 WHERE bound_account_id=? AND purpose=? AND consumed_at IS NULL AND revoked_at IS NULL")
        .run(this.core.now(),credential.id,RESET);
      this.admin.operations.revoke(credential.id);
      this.admin.audit({accountId:credential.id},'password_recovery_completed','account',credential.id,null,'completed','已验证邮箱完成密码恢复，全部旧会话失效');
      return { changed:true, _clearAccountSessionCookie:true };
    });
    if (result._error) throw new ApiError(result._error,401);
    return result;
  }
  submit(ctx) {
    const body = object(ctx.body,['username','challengeId','otp','statement']);
    const username = normalizeUsername(body.username), statement = string(body.statement,{min:10,max:2000});
    assert(typeof body.challengeId === 'string' && body.challengeId.length <= 100 && validOtp(body.otp),'authentication_failed',401);
    assert(this.passwords.claimRate(username,ctx.riskScope,'recovery-request'),'authentication_rate_limited',429);
    const result = this.core.mutation(this.passwords.privateRequest(this.anonymous(ctx)),{
      endpoint:'/v1/auth/recovery-requests',scope:`recovery-request:${body.challengeId}`,reauthorize:()=>{}
    },()=>{
      const challenge = this.identity.verifyChallenge(body.challengeId,body.otp,row=>row.purpose===CONTACT && row.bound_target_type===CONTACT);
      if (!challenge) return {_error:'authentication_failed'};
      this.identity.backfillIdentityEnvelope(challenge);
      this.db.prepare('UPDATE email_otp_challenges SET consumed_at=?,version=version+1 WHERE id=?').run(this.core.now(),challenge.id);
      const requestId = id('recovery'), accountId = this.core.one('SELECT account_id FROM account_password_credentials WHERE username=?',username)?.account_id;
      const credential = accountId ? this.credential(accountId) : null;
      // Same receipt for unknown, ineligible and eligible usernames. The browser
      // learns only that its contact mailbox was verified, never account existence.
      if (credential && this.noBoundEmail(accountId) && !this.emailOwner(challenge.identifier_equivalence_id)) {
        // A fresh mailbox proof gets an independent receipt for every username.
        // Reusing an old receipt only for eligible accounts would enumerate them.
        // Exact network retries are already deduplicated by core.mutation.
          this.db.prepare(`INSERT INTO password_recovery_requests(id,account_id,identifier_equivalence_id,contact_challenge_id,credential_version,account_epoch,statement_ciphertext,envelope_key_id,created_at)
            VALUES(?,?,?,?,?,?,?,?,?)`).run(requestId,accountId,challenge.identifier_equivalence_id,challenge.id,credential.credential_version,credential.session_epoch,
              this.core.keyring.seal(statement,`password-recovery-v1:${requestId}`),this.core.keyring.keyId,this.core.now());
          this.db.prepare('INSERT INTO administration_audit VALUES(?,?,?,?,?,?,?,?,?,?)').run(id('audit'),'verified_recovery_contact','已验证联系邮箱申请者',
            'password_recovery_requested','account',accountId,null,'pending',`申请 ${requestId}：联系邮箱已验证，账号身份待独立核实`,this.core.now());
      }
      return {accepted:true,requestId};
    });
    if (result._error) throw new ApiError(result._error,401);
    return result;
  }
  dto(row) {
    const identity = this.core.one('SELECT * FROM identifier_equivalences WHERE id=?',row.identifier_equivalence_id);
    const email = this.core.keyring.openIdentity(identity.normalized_identifier_ciphertext,
      identityEnvelopeAad(identity.id,'email_v1',IDENTITY_ENVELOPE_FORMAT),identity.normalized_identifier_envelope_key_id);
    return {id:row.id,accountId:row.account_id,username:this.core.one('SELECT username FROM account_password_credentials WHERE account_id=?',row.account_id)?.username,
      contactEmail:email,contactVerifiedAt:this.core.one('SELECT consumed_at FROM email_otp_challenges WHERE id=?',row.contact_challenge_id)?.consumed_at,
      statement:this.core.keyring.open(row.statement_ciphertext,`password-recovery-v1:${row.id}`,row.envelope_key_id),
      status:row.status,version:row.version,createdAt:row.created_at,reviewedAt:row.reviewed_at,
      approvalExpiresAt:row.approval_expires_at,approvalExpired:row.status==='approved'&&Date.parse(row.approval_expires_at)<=this.core.nowMs(),reviewReason:row.review_reason};
  }
  list(ctx) {
    const actor=this.admin.superAdmin(ctx), page=this.admin.page(ctx.query);
    this.admin.inspectionAudit(actor,'admin_recovery_requests_read','recovery_requests','all');
    const rows=this.core.all('SELECT * FROM password_recovery_requests ORDER BY created_at DESC,id LIMIT ? OFFSET ?',page.pageSize,(page.page-1)*page.pageSize);
    return {requests:rows.map(row=>this.dto(row)),total:this.core.one('SELECT count(*) n FROM password_recovery_requests').n,...page};
  }
  review(ctx,requestId) {
    const actor=this.admin.superAdmin(ctx);
    object(ctx.body,['decision','expectedVersion','reason','identityVerified']);
    const reason=string(ctx.body.reason,{min:20,max:1000});
    assert(['approve','reject'].includes(ctx.body.decision),'recovery_decision_invalid');
    assert(ctx.body.decision!=='approve'||ctx.body.identityVerified===true,'identity_verification_required');
    this.admin.write(ctx,actor,`/v1/admin/recovery-requests/${requestId}/review`,()=>{
      const row=this.core.one('SELECT * FROM password_recovery_requests WHERE id=?',requestId);
      assert(row,'recovery_unavailable',404);
      assert(row.status==='pending'&&row.version===ctx.body.expectedVersion,'version_conflict',409);
      assert(row.account_id!==actor.accountId,'cannot_review_own_recovery',409);
      if(ctx.body.decision==='approve') {
        const credential=this.credential(row.account_id);
        assert(credential&&credential.credential_version===row.credential_version&&credential.session_epoch===row.account_epoch&&
          this.noBoundEmail(row.account_id)&&!this.emailOwner(row.identifier_equivalence_id),'recovery_target_changed',409);
        assert(!this.core.one("SELECT 1 FROM password_recovery_requests WHERE identifier_equivalence_id=? AND status='approved' AND approval_expires_at>?",row.identifier_equivalence_id,this.core.now()),'recovery_already_approved',409);
      }
      const status=ctx.body.decision==='approve'?'approved':'rejected';
      const expiresAt=status==='approved'?new Date(this.core.nowMs()+approvalMs).toISOString():null;
      this.db.prepare('UPDATE password_recovery_requests SET status=?,reviewed_at=?,approval_expires_at=?,review_reason=?,version=version+1 WHERE id=?')
        .run(status,this.core.now(),expiresAt,reason,requestId);
      this.admin.audit(actor,'password_recovery_reviewed','account',row.account_id,'pending',status,reason);
      return {reviewed:true};
    });
    return {request:this.dto(this.core.one('SELECT * FROM password_recovery_requests WHERE id=?',requestId))};
  }
}

export function reencryptRecoveryRequests(db,keyring,fromKeyId,toKeyId) {
  assert(db.isTransaction,'recovery_rekey_transaction_required',500);
  for(const row of db.prepare('SELECT * FROM password_recovery_requests WHERE envelope_key_id=?').all(fromKeyId)) {
    const aad=`password-recovery-v1:${row.id}`,plain=keyring.open(row.statement_ciphertext,aad,fromKeyId),sealed=keyring.seal(plain,aad,toKeyId);
    assert(keyring.open(sealed,aad,toKeyId)===plain,'recovery_rekey_verification_failed',503);
    db.prepare('UPDATE password_recovery_requests SET statement_ciphertext=?,envelope_key_id=? WHERE id=? AND envelope_key_id=?').run(sealed,toKeyId,row.id,fromKeyId);
  }
}
export function exportRecoveryRequests(db,keyring,accountId) {
  return db.prepare('SELECT * FROM password_recovery_requests WHERE account_id=? ORDER BY created_at,id').all(accountId).map(row=>({
    id:row.id,status:row.status,createdAt:row.created_at,reviewedAt:row.reviewed_at,reviewReason:row.review_reason,
    statement:keyring.open(row.statement_ciphertext,`password-recovery-v1:${row.id}`,row.envelope_key_id)
  }));
}
