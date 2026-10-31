-- An import request stays immutable; one space can retain multiple scene revisions.
CREATE TABLE app_spatial_imports_v2 (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  client_id TEXT NOT NULL,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  request_hash TEXT NOT NULL,
  depth_asset_id TEXT REFERENCES assets(id),
  depth_metadata_json TEXT,
  panorama_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  panorama_revision_id TEXT REFERENCES panorama_revisions(id),
  PRIMARY KEY(account_id,client_id)
);
INSERT INTO app_spatial_imports_v2 SELECT i.*, COALESCE(
  json_extract(i.depth_metadata_json,'$.sourcePanoramaRevisionId'),s.current_panorama_revision_id)
  FROM app_spatial_imports i JOIN spaces s ON s.id=i.space_id;
DROP TABLE app_spatial_imports;
ALTER TABLE app_spatial_imports_v2 RENAME TO app_spatial_imports;
CREATE INDEX idx_app_spatial_import_revision ON app_spatial_imports(space_id,panorama_revision_id);
