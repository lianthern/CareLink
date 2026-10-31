CREATE TABLE private_ai_authorizations (
  snapshot_hash TEXT PRIMARY KEY,
  photo_id TEXT NOT NULL REFERENCES photos(id),
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  source_binding_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(length(snapshot_hash)=64 AND snapshot_hash NOT GLOB '*[^a-f0-9]*'),
  CHECK((active=1 AND length(source_binding_hash)=64 AND source_binding_hash NOT GLOB '*[^a-f0-9]*')
    OR (active=0 AND source_binding_hash IS NULL))
);

CREATE TABLE private_ai_worker_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  last_seen_at TEXT NOT NULL
);

CREATE TABLE private_ai_jobs (
  id TEXT PRIMARY KEY,
  task_type TEXT NOT NULL CHECK(task_type='photo_visible_facts_question_v1'),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  photo_id TEXT NOT NULL REFERENCES photos(id),
  photo_content_hash TEXT NOT NULL,
  media_asset_id TEXT NOT NULL REFERENCES assets(id),
  media_asset_version INTEGER NOT NULL CHECK(media_asset_version > 0),
  media_sha256 TEXT NOT NULL,
  media_bytes INTEGER NOT NULL CHECK(media_bytes > 0 AND media_bytes <= 20971520),
  media_mime TEXT NOT NULL CHECK(media_mime IN ('image/jpeg','image/png','image/webp')),
  media_width INTEGER NOT NULL CHECK(media_width > 0),
  media_height INTEGER NOT NULL CHECK(media_height > 0),
  photo_version INTEGER NOT NULL CHECK(photo_version > 0),
  placement_revision_id TEXT NOT NULL REFERENCES placement_revisions(id),
  placement_revision_seq INTEGER NOT NULL CHECK(placement_revision_seq > 0),
  placement_snapshot_hash TEXT NOT NULL,
  authorization_snapshot_hash TEXT NOT NULL REFERENCES private_ai_authorizations(snapshot_hash),
  prompt_hash TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  expected_model TEXT NOT NULL,
  expected_model_version TEXT NOT NULL,
  composition_request_json TEXT NOT NULL,
  composition_request_hash TEXT NOT NULL,
  input_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('queued','leased','completed','retry','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  max_attempts INTEGER NOT NULL CHECK(max_attempts >= 1 AND max_attempts <= 10),
  available_at TEXT NOT NULL,
  lease_id TEXT,
  lease_expires_at TEXT,
  result_json TEXT,
  result_hash TEXT,
  stable_error TEXT,
  last_callback_lease_id TEXT,
  last_callback_hash TEXT,
  last_callback_status TEXT CHECK(last_callback_status IN ('completed','retry','failed') OR last_callback_status IS NULL),
  last_callback_retry_after_ms INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  CHECK(length(photo_content_hash)=64 AND photo_content_hash NOT GLOB '*[^a-f0-9]*'),
  CHECK(length(media_sha256)=64 AND media_sha256 NOT GLOB '*[^a-f0-9]*'),
  CHECK(length(placement_snapshot_hash)=64 AND placement_snapshot_hash NOT GLOB '*[^a-f0-9]*'),
  CHECK(length(authorization_snapshot_hash)=64 AND authorization_snapshot_hash NOT GLOB '*[^a-f0-9]*'),
  CHECK(length(prompt_hash)=64 AND prompt_hash NOT GLOB '*[^a-f0-9]*'),
  CHECK(length(policy_hash)=64 AND policy_hash NOT GLOB '*[^a-f0-9]*'),
  CHECK(length(composition_request_hash)=64 AND composition_request_hash NOT GLOB '*[^a-f0-9]*'),
  CHECK(length(input_hash)=64 AND input_hash NOT GLOB '*[^a-f0-9]*'),
  CHECK(json_valid(composition_request_json)),
  CHECK(result_json IS NULL OR json_valid(result_json)),
  CHECK((status='leased' AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL) OR status<>'leased'),
  CHECK((status='completed' AND result_json IS NOT NULL AND result_hash IS NOT NULL AND completed_at IS NOT NULL)
    OR status<>'completed')
);

CREATE UNIQUE INDEX private_ai_active_lease_unique ON private_ai_jobs(lease_id) WHERE lease_id IS NOT NULL;
CREATE INDEX private_ai_dispatch_order ON private_ai_jobs(status,available_at,created_at,id);
CREATE INDEX private_ai_photo_currentness ON private_ai_jobs(photo_id,task_type,status);

CREATE TABLE private_ai_composition_outbox (
  id TEXT PRIMARY KEY,
  ai_job_id TEXT NOT NULL REFERENCES private_ai_jobs(id),
  event_type TEXT NOT NULL CHECK(event_type IN ('completed','provider_unavailable')),
  event_hash TEXT NOT NULL UNIQUE,
  job_attempt INTEGER NOT NULL CHECK(job_attempt > 0),
  composition_request_json TEXT NOT NULL,
  completion_result_json TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','leased','retry','delivered','cancelled','quarantined')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  available_at TEXT NOT NULL,
  lease_id TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  delivered_at TEXT,
  delivered_lease_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  CHECK(length(event_hash)=64 AND event_hash NOT GLOB '*[^a-f0-9]*'),
  CHECK(json_valid(composition_request_json)),
  CHECK((event_type='completed' AND completion_result_json IS NOT NULL)
    OR (event_type='provider_unavailable' AND completion_result_json IS NULL)),
  CHECK(completion_result_json IS NULL OR json_valid(completion_result_json)),
  CHECK((status='leased' AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL) OR status<>'leased'),
  CHECK((status='delivered' AND delivered_at IS NOT NULL AND delivered_lease_id IS NOT NULL)
    OR status<>'delivered')
);

CREATE UNIQUE INDEX private_ai_composition_active_lease ON private_ai_composition_outbox(lease_id)
  WHERE lease_id IS NOT NULL;
CREATE INDEX private_ai_composition_dispatch ON private_ai_composition_outbox(status,available_at,created_at,id);
