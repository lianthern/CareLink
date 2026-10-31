ALTER TABLE photos ADD COLUMN captured_at TEXT;

CREATE TRIGGER deleted_photo_clears_capture_time
AFTER UPDATE OF deleted_at ON photos
WHEN NEW.deleted_at IS NOT NULL AND NEW.captured_at IS NOT NULL
BEGIN
  UPDATE photos SET captured_at=NULL WHERE id=NEW.id;
END;
