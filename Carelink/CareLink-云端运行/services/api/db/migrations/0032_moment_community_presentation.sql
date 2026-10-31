ALTER TABLE moment_submissions ADD COLUMN featured INTEGER NOT NULL DEFAULT 0 CHECK(featured IN (0,1));
ALTER TABLE moment_submissions ADD COLUMN sort_rank INTEGER NOT NULL DEFAULT 0;
CREATE INDEX moment_submission_presentation ON moment_submissions(status,featured DESC,sort_rank,created_at DESC);
