-- Video upload v0 (2026-08-18). Adds just enough schema to let a photos row represent an
-- uploaded video without touching a single line of the existing placement/locator pipeline:
--
-- - assets.duration_ms: only meaningful for video assets (raw 'video' kind and its transcoded
--   'video_viewer_safe' derivative); NULL for every existing photo/panorama asset row.
-- - photos.media_type: explicit 'photo' | 'video' discriminator so the API/UI never has to
--   infer media kind from column presence. Defaults to 'photo' so every existing row is
--   unaffected without a backfill.
-- - photos.video_asset_id: the transcoded, metadata-stripped, browser-playable mp4 derivative
--   (asset kind 'video_viewer_safe') that apps/web plays in the album/photo-detail page. NULL
--   for photos.
--
-- Deliberately NOT touched: photos.viewer_safe_asset_id. For a video, that column keeps
-- pointing at a plain PNG derived from the video's first frame (asset kind stays the existing
-- 'photo_viewer_safe', metadata_policy_result stays 'exif_gps_stripped') -- i.e. structurally
-- indistinguishable from a photo's own viewer-safe derivative. That is what lets
-- services/jobs/dispatch/index.mjs, viewer-media-service.mjs's sceneContext()/photoState()/
-- photoDetail(), placement-service.mjs's editorMedia(), and
-- infra/integration/local-clip-locator-worker.mjs's computePlacementOutcome() keep working for
-- video photos with zero code changes: every one of them reads photos.viewer_safe_asset_id and
-- filters on kind='photo_viewer_safe', and a video's poster satisfies that exactly. Only the new
-- video-playback route (ViewerMediaService#video()) and photoDetail()'s optional `video` field
-- read the new video_asset_id column.
ALTER TABLE assets ADD COLUMN duration_ms INTEGER;

ALTER TABLE photos ADD COLUMN media_type TEXT NOT NULL DEFAULT 'photo' CHECK(media_type IN ('photo','video'));
ALTER TABLE photos ADD COLUMN video_asset_id TEXT REFERENCES assets(id);

CREATE UNIQUE INDEX photo_video_asset_unique ON photos(video_asset_id)
  WHERE video_asset_id IS NOT NULL;

CREATE TRIGGER video_photo_requires_video_asset_insert
BEFORE INSERT ON photos
WHEN NEW.media_type='video' AND NEW.video_asset_id IS NULL
BEGIN
  SELECT RAISE(ABORT,'video photo requires video asset');
END;

CREATE TRIGGER photo_media_type_requires_null_video_asset_insert
BEFORE INSERT ON photos
WHEN NEW.media_type='photo' AND NEW.video_asset_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'photo media_type must not carry a video asset');
END;
