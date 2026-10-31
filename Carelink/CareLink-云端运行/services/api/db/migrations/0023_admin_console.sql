CREATE TABLE account_administration (
 account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','pending','rejected','disabled')),
 is_admin INTEGER NOT NULL DEFAULT 0 CHECK(is_admin IN (0,1)),
 display_name TEXT, last_login_at TEXT
);
INSERT INTO account_administration(account_id) SELECT id FROM accounts;
CREATE TABLE moment_submissions (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 moment_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, title TEXT NOT NULL, author_name TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','published','rejected','unpublished','withdrawn')),
 cover_media_id TEXT, cover_preview INTEGER NOT NULL DEFAULT 0, reason TEXT, created_at TEXT NOT NULL, reviewed_at TEXT, version INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX moment_submission_live ON moment_submissions(account_id,moment_id) WHERE status IN ('pending','published');
CREATE TABLE administration_audit (
 id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, action TEXT NOT NULL,
 target_type TEXT NOT NULL, target_id TEXT NOT NULL, before_status TEXT, after_status TEXT,
 reason TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX administration_audit_date ON administration_audit(created_at);
