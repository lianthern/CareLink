-- Track N (depth_limited_parallax): at most one depth-map derived asset per
-- (space, panorama_revision). scenes.scene_mode itself is deliberately left
-- alone here — panorama-service.mjs's switch() always writes 'rotation360'
-- and viewer-media-service.mjs's currentScene() hard-filters on
-- scene_mode='rotation360', so flipping that column would 404 every viewer
-- read for the space. The wire-level sceneMode the viewer actually sees is
-- computed in sceneContext() from the presence of a matching, valid row
-- here instead; scenes.scene_mode stays the DB-level baseline capability.
CREATE TABLE scene_depth_artifacts (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  scene_id TEXT NOT NULL REFERENCES scenes(id),
  panorama_revision_id TEXT NOT NULL REFERENCES panorama_revisions(id),
  depth_asset_id TEXT NOT NULL REFERENCES assets(id),
  artifact_id TEXT NOT NULL,
  near_meters REAL NOT NULL,
  far_meters REAL NOT NULL,
  valid_fraction REAL NOT NULL,
  safety_envelope_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(space_id,panorama_revision_id)
);
CREATE INDEX idx_scene_depth_artifacts_revision ON scene_depth_artifacts(panorama_revision_id);
