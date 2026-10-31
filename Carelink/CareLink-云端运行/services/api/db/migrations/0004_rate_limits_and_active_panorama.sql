ALTER TABLE email_otp_challenges ADD COLUMN rate_limit_mac BLOB;
ALTER TABLE email_otp_challenges ADD COLUMN rate_limit_key_id TEXT;
ALTER TABLE email_otp_challenges ADD COLUMN risk_limit_mac BLOB;
ALTER TABLE email_otp_challenges ADD COLUMN risk_limit_key_id TEXT;

CREATE TRIGGER email_otp_rate_binding_required
BEFORE INSERT ON email_otp_challenges
WHEN NEW.rate_limit_mac IS NULL OR NEW.rate_limit_key_id IS NULL OR
     NEW.risk_limit_mac IS NULL OR NEW.risk_limit_key_id IS NULL
BEGIN
  SELECT RAISE(ABORT,'email otp rate binding required');
END;

CREATE TABLE otp_issuance_rate_counters (
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('equivalence','server_risk')),
  scope_mac BLOB NOT NULL,
  scope_key_id TEXT NOT NULL,
  bucket_start TEXT NOT NULL,
  purpose TEXT NOT NULL,
  count INTEGER NOT NULL CHECK(count >= 0),
  blocked_until TEXT,
  expires_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(scope_kind,scope_key_id,scope_mac,bucket_start,purpose)
);

ALTER TABLE external_campaign_admission_challenges ADD COLUMN abuse_policy_version TEXT;

UPDATE panorama_revisions
SET retired_at=COALESCE(retired_at,activated_at,ready_at),version=version+1
WHERE activated_at IS NOT NULL AND retired_at IS NULL
  AND id NOT IN (
    SELECT current_panorama_revision_id FROM spaces WHERE current_panorama_revision_id IS NOT NULL
  );

CREATE UNIQUE INDEX panorama_revision_one_active_per_space
ON panorama_revisions(space_id)
WHERE activated_at IS NOT NULL AND retired_at IS NULL;
