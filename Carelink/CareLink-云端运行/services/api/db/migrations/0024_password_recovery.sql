CREATE TABLE password_recovery_requests (
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 identifier_equivalence_id TEXT NOT NULL REFERENCES identifier_equivalences(id),
 contact_challenge_id TEXT NOT NULL UNIQUE REFERENCES email_otp_challenges(id),
 credential_version INTEGER NOT NULL,
 account_epoch INTEGER NOT NULL,
 statement_ciphertext TEXT NOT NULL,
 envelope_key_id TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','completed')),
 created_at TEXT NOT NULL,
 reviewed_at TEXT,
 approval_expires_at TEXT,
 review_reason TEXT,
 version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX password_recovery_queue ON password_recovery_requests(status,created_at);
