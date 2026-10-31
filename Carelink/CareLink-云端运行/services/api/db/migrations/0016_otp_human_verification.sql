-- OTP human-verification + send-budget hardening (2026-08-17 施工批次: PoW 挑战 + 限流收紧).
-- Threat model: the public "获取验证码" surface (identity-service.mjs requestOtp(), reached from
-- the unauthenticated /login page) now triggers a real outbound email (Tencent SES). Without a
-- human-verification gate, a script can burn the SES quota / spam arbitrary inboxes for free.
--
-- otp_pow_challenges: one-time proof-of-work tickets minted by the default "pow" captcha provider
-- (see services/api/src/ports/captcha/pow-captcha-port.mjs). challenge issuance is cheap and
-- unauthenticated, so rows are pruned purely by TTL (expires_at) rather than a rate counter --
-- the actual scarce resource (an outbound email) is protected by otp_abuse_counters below and by
-- the per-email/per-risk-scope counters already in otp_issuance_rate_counters.
CREATE TABLE otp_pow_challenges (
  id TEXT PRIMARY KEY,
  algorithm TEXT NOT NULL,
  salt TEXT NOT NULL,
  difficulty_bits INTEGER NOT NULL CHECK(difficulty_bits >= 0 AND difficulty_bits <= 64),
  risk_key_mac BLOB NOT NULL,
  risk_key_id TEXT NOT NULL,
  consumed_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX otp_pow_challenges_expires_at ON otp_pow_challenges(expires_at);

-- otp_abuse_counters: send-time (not challenge/issuance-time) budget counters, claimed right
-- before OtpDeliveryOutbox#enqueue() -- i.e. only for OTPs that are actually about to be mailed.
-- Deliberately a separate table from otp_issuance_rate_counters (which gates challenge creation
-- on a fixed 10-minute bucket keyed by email-equivalence/server-risk): these counters need
-- variable bucket widths (hour/day) and a third "global" scope the existing table's CHECK
-- constraint doesn't have room for, and otp_issuance_rate_counters already has call sites and
-- tests baked around its exact two-kind shape -- adding a third axis here is the smaller, more
-- reviewable change.
--
-- counter_kind='global_daily' rows use a MAC of a fixed constant (not a real risk scope) as
-- scope_mac, keeping the same "keyed MAC, never a raw value" column shape as every other
-- rate/risk table in this schema (see contract-coverage.test.mjs's credential-table check) even
-- though the site-wide budget itself isn't tied to any one visitor.
CREATE TABLE otp_abuse_counters (
  counter_kind TEXT NOT NULL CHECK(counter_kind IN ('risk_hourly','risk_daily','global_daily')),
  scope_mac BLOB NOT NULL,
  scope_key_id TEXT NOT NULL,
  bucket_start TEXT NOT NULL,
  count INTEGER NOT NULL CHECK(count >= 0),
  expires_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(counter_kind,scope_key_id,scope_mac,bucket_start)
);
