ALTER TABLE private_ai_jobs
ADD COLUMN question_context_json TEXT
CHECK(question_context_json IS NULL OR json_valid(question_context_json));

-- Rows created before this migration did not bind conversational context into input_hash. Keep active legacy
-- rows NULL so the dispatcher leases them with the compatible job/1 shape; all newly enqueued rows write an
-- exact context object and therefore use job/2. Terminal legacy rows cannot need their absent context again.
UPDATE private_ai_jobs SET question_context_json='{"kind":"redacted"}'
WHERE status IN ('completed','failed');
