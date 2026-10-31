-- Capture uploads are independent from album clips. No production SceneWorker queue is created.
CREATE TABLE scene_captures (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  scene_id TEXT NOT NULL REFERENCES scenes(id),
  scene_revision_id TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL UNIQUE,
  input_mode TEXT NOT NULL CHECK(input_mode IN ('perspective_video','equirectangular_video','equirectangular_images')),
  title TEXT NOT NULL,
  source_space_version INTEGER NOT NULL,
  source_scene_version INTEGER NOT NULL,
  declared_bytes INTEGER NOT NULL CHECK(declared_bytes>0),
  chunk_bytes INTEGER NOT NULL CHECK(chunk_bytes>0),
  status TEXT NOT NULL CHECK(status IN ('uploading','uploaded','cancelled')),
  manifest_json TEXT,
  manifest_sha256 TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  cancelled_at TEXT,
  purged_at TEXT
);
CREATE INDEX scene_capture_account ON scene_captures(account_id,created_at);
CREATE INDEX scene_capture_space ON scene_captures(space_id,created_at);
CREATE TABLE scene_capture_files (
  id TEXT PRIMARY KEY,
  capture_id TEXT NOT NULL REFERENCES scene_captures(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  client_file_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  declared_bytes INTEGER NOT NULL CHECK(declared_bytes>0),
  raw_sha256 TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  duration_seconds REAL,
  chunk_count INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('uploading','uploaded')),
  UNIQUE(capture_id,client_file_id),
  UNIQUE(capture_id,ordinal)
);
CREATE TABLE scene_capture_chunks (
  file_id TEXT NOT NULL REFERENCES scene_capture_files(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK(chunk_index>=0),
  bytes INTEGER NOT NULL CHECK(bytes>0),
  sha256 TEXT NOT NULL,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  status TEXT NOT NULL CHECK(status IN ('reserved','stored','purged')),
  PRIMARY KEY(file_id,chunk_index)
);
