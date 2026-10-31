ALTER TABLE public_space_listings ADD COLUMN community_submission_id TEXT;
ALTER TABLE public_space_listings ADD COLUMN featured INTEGER NOT NULL DEFAULT 0 CHECK(featured IN (0,1));
ALTER TABLE public_space_listings ADD COLUMN rank INTEGER NOT NULL DEFAULT 0;
CREATE TABLE community_space_submissions (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), space_id TEXT NOT NULL REFERENCES spaces(id),
 snapshot_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','published','rejected','unpublished','withdrawn')),
 version INTEGER NOT NULL DEFAULT 1, reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 published_at TEXT, FOREIGN KEY(account_id,snapshot_id) REFERENCES personal_memories(account_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX community_space_single_active ON community_space_submissions(space_id) WHERE status IN ('pending','published','unpublished');
CREATE INDEX community_space_status ON community_space_submissions(status,created_at);
CREATE TRIGGER community_space_delete_listing BEFORE DELETE ON community_space_submissions BEGIN
 UPDATE public_space_listings SET status='hidden',community_submission_id=NULL,open_url='',version=version+1 WHERE community_submission_id=OLD.id;
END;
