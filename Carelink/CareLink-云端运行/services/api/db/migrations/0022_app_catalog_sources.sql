-- Operator-maintained source records for explicitly reviewed public catalog versions.
-- This is not an account scan or an automatic publication endpoint.
CREATE TABLE app_catalog_sources (
  publication_id TEXT PRIMARY KEY,
  maintainer_account_id TEXT NOT NULL REFERENCES accounts(id),
  catalog_sha256 TEXT NOT NULL,
  catalog_json TEXT NOT NULL,
  asset_manifest_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
