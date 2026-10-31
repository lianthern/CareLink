-- Direct words use the same encrypted snapshot and lifecycle as selected stories.
-- Guest snapshots belong to the space owner's storage; authorship remains separate.
ALTER TABLE photo_stories ADD COLUMN author_actor_kind TEXT CHECK(author_actor_kind IN ('account','contributor'));
ALTER TABLE photo_stories ADD COLUMN author_actor_id TEXT;
CREATE INDEX photo_stories_actor ON photo_stories(author_actor_kind,author_actor_id,photo_id);
ALTER TABLE photos ADD COLUMN uploaded_at TEXT;
