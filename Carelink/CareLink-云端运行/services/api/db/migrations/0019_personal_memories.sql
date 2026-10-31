CREATE TABLE personal_memories (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  document_ciphertext TEXT NOT NULL,
  envelope_key_id TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY(account_id,id)
);
