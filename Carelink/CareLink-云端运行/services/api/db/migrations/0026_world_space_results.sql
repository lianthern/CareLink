CREATE TABLE scene_world_results (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  scene_id TEXT NOT NULL REFERENCES scenes(id),
  request_id TEXT NOT NULL,
  world_id TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  world_json TEXT NOT NULL,
  source_space_version INTEGER NOT NULL,
  source_scene_version INTEGER NOT NULL,
  activated_at TEXT NOT NULL,
  retired_at TEXT,
  UNIQUE(account_id,request_id)
);
ALTER TABLE spaces ADD COLUMN current_world_result_id TEXT REFERENCES scene_world_results(id);
CREATE TABLE world_result_assets (
  world_result_id TEXT NOT NULL REFERENCES scene_world_results(id),
  kind TEXT NOT NULL,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  PRIMARY KEY(world_result_id,kind)
);
