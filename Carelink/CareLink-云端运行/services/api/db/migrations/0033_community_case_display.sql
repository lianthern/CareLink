CREATE TABLE community_case_display (
 id TEXT PRIMARY KEY,
 source TEXT NOT NULL CHECK(source IN ('catalog','example')),
 source_id TEXT NOT NULL,
 public_definition TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'visible' CHECK(status IN ('visible','hidden')),
 featured INTEGER NOT NULL DEFAULT 0 CHECK(featured IN (0,1)),
 sort_rank INTEGER NOT NULL DEFAULT 0,
 version INTEGER NOT NULL DEFAULT 1,
 reason TEXT NOT NULL DEFAULT '',
 updated_at TEXT NOT NULL,
 UNIQUE(source,source_id)
);
