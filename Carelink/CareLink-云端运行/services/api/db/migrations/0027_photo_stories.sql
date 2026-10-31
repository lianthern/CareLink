-- Only metadata is plaintext. Selected words and audio are immutable encrypted
-- snapshots in the existing personal-memory lifecycle, never live chat pointers.
CREATE TABLE photo_stories (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  photo_id TEXT NOT NULL REFERENCES photos(id),
  source_moment_id TEXT NOT NULL,
  source_photo_id TEXT NOT NULL,
  selection_hash TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK(visibility IN ('visible','hidden','withdrawn')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(account_id,memory_id) REFERENCES personal_memories(account_id,id) ON DELETE CASCADE
);
CREATE INDEX photo_stories_space ON photo_stories(space_id,visibility,created_at);
CREATE INDEX photo_stories_author ON photo_stories(account_id,created_at);
CREATE UNIQUE INDEX photo_stories_active_selection ON photo_stories(account_id,photo_id,selection_hash)
  WHERE visibility!='withdrawn';
