CREATE TABLE otp_delivery_outbox (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL UNIQUE REFERENCES email_otp_challenges(id),
  payload_ciphertext TEXT,
  payload_key_id TEXT,
  payload_format TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','running','delivered','discarded')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  delivered_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  CHECK(
    (status='queued' AND payload_ciphertext IS NOT NULL AND payload_key_id IS NOT NULL AND
      payload_format='otp-delivery-aes256gcm-v1' AND lease_owner IS NULL AND lease_expires_at IS NULL AND
      delivered_at IS NULL) OR
    (status='running' AND payload_ciphertext IS NOT NULL AND payload_key_id IS NOT NULL AND
      payload_format='otp-delivery-aes256gcm-v1' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND
      delivered_at IS NULL) OR
    (status='delivered' AND payload_ciphertext IS NULL AND payload_key_id IS NULL AND payload_format IS NULL AND
      lease_owner IS NULL AND lease_expires_at IS NULL AND delivered_at IS NOT NULL) OR
    (status='discarded' AND payload_ciphertext IS NULL AND payload_key_id IS NULL AND payload_format IS NULL AND
      lease_owner IS NULL AND lease_expires_at IS NULL AND delivered_at IS NULL)
  )
);

CREATE INDEX otp_delivery_outbox_dispatch
  ON otp_delivery_outbox(status,available_at,lease_expires_at,created_at);
