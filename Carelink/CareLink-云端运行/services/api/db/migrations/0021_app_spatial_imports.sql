-- Explicit private App imports use canonical spaces, revisions and asset storage.
CREATE TABLE app_spatial_imports (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  client_id TEXT NOT NULL,
  space_id TEXT NOT NULL UNIQUE REFERENCES spaces(id),
  request_hash TEXT NOT NULL,
  depth_asset_id TEXT REFERENCES assets(id),
  depth_metadata_json TEXT,
  panorama_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(account_id,client_id)
);
