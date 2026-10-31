import { ApiError, assert } from "./errors.mjs";
import { transaction } from "./database.mjs";
import { normalizeEmail } from "./crypto.mjs";
import { id, logStructured, parseJson } from "./util.mjs";

const PAYLOAD_FORMAT = "otp-delivery-aes256gcm-v1";
export const DEFAULT_OTP_DELIVERY_LEASE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_IP_HOURLY_LIMIT = 30;
const DEFAULT_IP_DAILY_LIMIT = 100;
const DEFAULT_DAILY_SEND_BUDGET = 200;
const GLOBAL_BUDGET_SCOPE = "global";

function aad(row) {
  return `otp-delivery-v1\0${row.id}\0${row.challenge_id}\0${PAYLOAD_FORMAT}`;
}

function bucket(nowMs, widthMs) {
  const startMs = Math.floor(nowMs / widthMs) * widthMs;
  return { start: new Date(startMs).toISOString(), expiresAt: new Date(startMs + 2 * widthMs).toISOString() };
}

export class OtpDeliveryOutbox {
  constructor(core, port = null, { ipHourlyLimit = DEFAULT_IP_HOURLY_LIMIT, ipDailyLimit = DEFAULT_IP_DAILY_LIMIT,
    dailyBudget = DEFAULT_DAILY_SEND_BUDGET } = {}) {
    assert([ipHourlyLimit, ipDailyLimit, dailyBudget].every((value) => Number.isSafeInteger(value) && value >= 1),
      "otp_rate_limit_configuration_invalid", 500);
    this.core = core;
    this.db = core.db;
    this.port = port;
    this.ipHourlyLimit = ipHourlyLimit;
    this.ipDailyLimit = ipDailyLimit;
    this.dailyBudget = dailyBudget;
  }

  get configured() { return Boolean(this.port); }

  get keyring() { return this.core.keyring; }

  requireAvailable() {
    assert(this.configured, "otp_delivery_unavailable", 503);
  }

  // Send-time (not challenge-issuance-time) budget: claimed once, right before a challenge row +
  // outbox entry are actually written, so it only ever counts OTPs that are genuinely about to
  // cost an SES send. Must run inside an already-open transaction (identity-service.mjs calls
  // this from inside core.mutation()'s run callback). On block, every layer that could be hit
  // (per-IP hour, per-IP day, site-wide day) is logged -- but nothing is incremented past the
  // first blocking layer, and the caller (requestOtp/requestReauth) must still respond
  // `{accepted:true}` without creating a challenge row, matching the pre-existing per-email/
  // per-risk-scope counters' anti-enumeration stance (see identity-service.mjs claimOtpCounter).
  claimSendBudget(ctx) {
    assert(this.db.isTransaction, "otp_send_budget_transaction_required", 500);
    const nowMs = this.core.nowMs();
    const hour = bucket(nowMs, HOUR_MS);
    const day = bucket(nowMs, DAY_MS);
    const riskMac = this.keyring.mac("otp-send-risk-v1", ctx.riskScope ?? "");
    const globalMac = this.keyring.mac("otp-send-global-v1", GLOBAL_BUDGET_SCOPE);
    const checks = [
      { kind: "risk_hourly", mac: riskMac, bucket: hour, limit: this.ipHourlyLimit },
      { kind: "risk_daily", mac: riskMac, bucket: day, limit: this.ipDailyLimit },
      { kind: "global_daily", mac: globalMac, bucket: day, limit: this.dailyBudget }
    ].map((check) => ({ ...check, row: this.core.one(`SELECT * FROM otp_abuse_counters
      WHERE counter_kind=? AND scope_key_id=? AND scope_mac=? AND bucket_start=?`,
    check.kind, this.keyring.keyId, check.mac, check.bucket.start) }));
    const blocked = checks.find((check) => (check.row?.count ?? 0) >= check.limit);
    if (blocked) {
      const globalCheck = checks.find((check) => check.kind === "global_daily");
      logStructured("otp_send_budget_exceeded", { counterKind: blocked.kind,
        count: blocked.row?.count ?? 0, limit: blocked.limit,
        budgetRemaining: Math.max(0, this.dailyBudget - (globalCheck.row?.count ?? 0)) });
      return { allowed: false, exceeded: blocked.kind };
    }
    for (const check of checks) {
      if (check.row) {
        const updated = this.db.prepare(`UPDATE otp_abuse_counters SET count=count+1,version=version+1
          WHERE counter_kind=? AND scope_key_id=? AND scope_mac=? AND bucket_start=? AND version=?`)
          .run(check.kind, this.keyring.keyId, check.mac, check.bucket.start, check.row.version);
        assert(updated.changes === 1, "concurrent_change", 409);
      } else {
        this.db.prepare(`INSERT INTO otp_abuse_counters(
          counter_kind,scope_mac,scope_key_id,bucket_start,count,expires_at,version
        ) VALUES(?,?,?,?,1,?,1)`).run(check.kind, check.mac, this.keyring.keyId, check.bucket.start,
        check.bucket.expiresAt);
      }
    }
    const globalRow = checks.find((check) => check.kind === "global_daily").row;
    return { allowed: true, remaining: Math.max(0, this.dailyBudget - ((globalRow?.count ?? 0) + 1)) };
  }

  enqueue({ challengeId, normalizedEmail, code, purpose, expiresAt }) {
    this.requireAvailable();
    assert(this.db.isTransaction, "otp_delivery_transaction_required", 500);
    const row = { id: id("otp_delivery"), challenge_id: challengeId };
    const payload = JSON.stringify({ deliveryId: row.id, challengeId, normalizedEmail, code, purpose, expiresAt });
    const ciphertext = this.keyring.seal(payload, aad(row));
    const now = this.core.now();
    this.db.prepare(`INSERT INTO otp_delivery_outbox(
      id,challenge_id,payload_ciphertext,payload_key_id,payload_format,status,attempts,available_at,
      created_at,updated_at,version
    ) VALUES(?,?,?,?,?,'queued',0,?,?,?,1)`).run(row.id, challengeId, ciphertext, this.keyring.keyId,
    PAYLOAD_FORMAT, now, now, now);
    return row.id;
  }

  health() {
    const pending = this.db.prepare(`SELECT
      SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) queued,
      SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) running
      FROM otp_delivery_outbox`).get();
    return { configured: this.configured, ready: this.configured,
      provider: this.port?.name ?? "unconfigured", queued: Number(pending.queued ?? 0),
      running: Number(pending.running ?? 0) };
  }

  claim({ leaseOwner, leaseMs }) {
    const now = this.core.now();
    const leaseExpiresAt = new Date(this.core.nowMs() + leaseMs).toISOString();
    return transaction(this.db, () => {
      const row = this.db.prepare(`SELECT o.*,c.expires_at challenge_expires_at,c.purpose challenge_purpose,
        c.identifier_equivalence_id,c.otp_mac,c.otp_key_id,c.consumed_at,c.revoked_at,
        e.normalized_collision_key,e.collision_key_epoch
        FROM otp_delivery_outbox o JOIN email_otp_challenges c ON c.id=o.challenge_id
        JOIN identifier_equivalences e ON e.id=c.identifier_equivalence_id
        WHERE (o.status='queued' AND o.available_at<=?) OR
          (o.status='running' AND o.lease_expires_at<=?)
        ORDER BY o.created_at,o.id LIMIT 1`).get(now, now);
      if (!row) return null;
      if (row.consumed_at || row.revoked_at || Date.parse(row.challenge_expires_at) <= this.core.nowMs()) {
        const discarded = this.db.prepare(`UPDATE otp_delivery_outbox SET status='discarded',
          payload_ciphertext=NULL,payload_key_id=NULL,payload_format=NULL,lease_owner=NULL,lease_expires_at=NULL,
          last_error_code='challenge_unavailable',updated_at=?,version=version+1 WHERE id=? AND version=?`)
          .run(now, row.id, row.version);
        assert(discarded.changes === 1, "concurrent_change", 409);
        return { discarded: true };
      }
      const claimed = this.db.prepare(`UPDATE otp_delivery_outbox SET status='running',attempts=attempts+1,
        lease_owner=?,lease_expires_at=?,last_error_code=NULL,updated_at=?,version=version+1
        WHERE id=? AND version=? AND ((status='queued' AND available_at<=?) OR
          (status='running' AND lease_expires_at<=?))`).run(
      leaseOwner, leaseExpiresAt, now, row.id, row.version, now, now);
      assert(claimed.changes === 1, "concurrent_change", 409);
      return { ...row, status: "running", attempts: row.attempts + 1, lease_owner: leaseOwner,
        lease_expires_at: leaseExpiresAt, version: row.version + 1 };
    });
  }

  payload(row) {
    try {
      const value = parseJson(this.keyring.open(row.payload_ciphertext, aad(row), row.payload_key_id));
      assert(value?.deliveryId === row.id && value.challengeId === row.challenge_id &&
        normalizeEmail(value.normalizedEmail) === value.normalizedEmail && /^\d{6}$/.test(value.code) &&
        value.purpose === row.challenge_purpose && value.expiresAt === row.challenge_expires_at &&
        this.keyring.equal(this.keyring.otpCandidates(row.challenge_id, row.identifier_equivalence_id,
          row.challenge_purpose, value.code).find((candidate) => candidate.keyId === row.otp_key_id)?.mac,
        row.otp_mac) &&
        this.keyring.equal(this.keyring.equivalentEmailForKey(value.normalizedEmail, row.collision_key_epoch),
          row.normalized_collision_key),
      "otp_delivery_payload_invalid", 503);
      return value;
    } catch (error) {
      if (error instanceof ApiError && error.code === "otp_delivery_payload_invalid") throw error;
      throw new ApiError("otp_delivery_payload_invalid", 503);
    }
  }

  finalize(row, outcome, retryDelayMs) {
    return transaction(this.db, () => {
      const now = this.core.now();
      const statement = outcome === "delivered" ? this.db.prepare(`UPDATE otp_delivery_outbox SET status='delivered',
        payload_ciphertext=NULL,payload_key_id=NULL,payload_format=NULL,lease_owner=NULL,lease_expires_at=NULL,
        delivered_at=?,last_error_code=NULL,updated_at=?,version=version+1
        WHERE id=? AND version=? AND status='running' AND lease_owner=?`) : outcome === "discarded" ?
        this.db.prepare(`UPDATE otp_delivery_outbox SET status='discarded',payload_ciphertext=NULL,
          payload_key_id=NULL,payload_format=NULL,lease_owner=NULL,lease_expires_at=NULL,
          last_error_code='payload_invalid',updated_at=?,version=version+1
          WHERE id=? AND version=? AND status='running' AND lease_owner=?`) :
        this.db.prepare(`UPDATE otp_delivery_outbox SET status='queued',available_at=?,lease_owner=NULL,
          lease_expires_at=NULL,last_error_code='provider_failed',updated_at=?,version=version+1
          WHERE id=? AND version=? AND status='running' AND lease_owner=?`);
      const result = outcome === "delivered" ? statement.run(now, now, row.id, row.version, row.lease_owner) :
        outcome === "discarded" ? statement.run(now, row.id, row.version, row.lease_owner) :
        statement.run(new Date(this.core.nowMs() + retryDelayMs).toISOString(), now,
          row.id, row.version, row.lease_owner);
      assert(result.changes === 1, "otp_delivery_lease_lost", 409);
    });
  }

  async dispatchAvailable({ limit = 10, leaseOwner = id("otp_delivery_lease"),
    leaseMs = DEFAULT_OTP_DELIVERY_LEASE_MS,
    retryDelayMs = 5_000, afterClaim = null } = {}) {
    if (!this.configured) return { configured: false, delivered: 0, failed: 0 };
    assert(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 && Number.isSafeInteger(leaseMs) &&
      leaseMs >= 1_000 && Number.isSafeInteger(retryDelayMs) && retryDelayMs >= 0,
    "otp_delivery_dispatch_invalid", 500);
    let delivered = 0;
    let failed = 0;
    for (let count = 0; count < limit; count += 1) {
      const row = this.claim({ leaseOwner, leaseMs });
      if (!row) break;
      if (row.discarded) continue;
      afterClaim?.(row);
      let payload;
      try { payload = this.payload(row); }
      catch {
        this.finalize(row, "discarded", retryDelayMs);
        failed += 1;
        continue;
      }
      try {
        assert(!this.db.isTransaction, "otp_delivery_transaction_open", 500);
        await this.port.deliver(payload);
        this.finalize(row, "delivered", retryDelayMs);
        delivered += 1;
      } catch {
        this.finalize(row, "retry", retryDelayMs);
        failed += 1;
      }
    }
    return { configured: true, delivered, failed };
  }
}
