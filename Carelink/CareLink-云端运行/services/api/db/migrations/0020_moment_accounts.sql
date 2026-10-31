-- Private moments, media, and profiles share the established encrypted record
-- lifecycle (backup, account export/deletion, key rotation), but not legacy lists.
ALTER TABLE personal_memories ADD COLUMN record_kind TEXT NOT NULL DEFAULT 'snapshot'
  CHECK(record_kind IN ('snapshot','moment','moment-media','profile'));
CREATE INDEX personal_memory_kind ON personal_memories(account_id,record_kind,updated_at);

CREATE TABLE account_password_credentials (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE password_rate_counters (
  scope TEXT NOT NULL,
  bucket_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY(scope,bucket_start)
);
