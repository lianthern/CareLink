ALTER TABLE upload_sessions RENAME TO upload_sessions_v1;

CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  batch_id TEXT NOT NULL REFERENCES contribution_batches(id),
  item_id TEXT NOT NULL REFERENCES contribution_batch_items(id),
  actor_id TEXT NOT NULL,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  exact_private_object_key TEXT NOT NULL UNIQUE,
  ticket_mac BLOB,
  ticket_key_id TEXT NOT NULL,
  declared_metadata_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('issued','committing','uploaded','validating','committed','expired','revoked')),
  upload_claim_id TEXT,
  upload_claim_expires_at TEXT,
  observed_upload_sha256 TEXT,
  observed_upload_bytes INTEGER,
  observed_upload_mime TEXT,
  observed_upload_etag TEXT,
  commit_operation_id TEXT,
  commit_operation_expires_at TEXT,
  request_hash TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(ticket_key_id,ticket_mac),
  CHECK((status='committing') = (upload_claim_id IS NOT NULL)),
  CHECK((upload_claim_id IS NULL) = (upload_claim_expires_at IS NULL)),
  CHECK((status='validating') = (commit_operation_id IS NOT NULL)),
  CHECK((commit_operation_id IS NULL) = (commit_operation_expires_at IS NULL))
);

INSERT INTO upload_sessions(
  id,space_id,batch_id,item_id,actor_id,asset_id,exact_private_object_key,ticket_mac,ticket_key_id,
  declared_metadata_json,expires_at,status,request_hash,version
)
SELECT id,space_id,batch_id,item_id,actor_id,asset_id,exact_private_object_key,
  CASE WHEN length(ticket_mac)=0 THEN NULL ELSE ticket_mac END,ticket_key_id,
  declared_metadata_json,expires_at,status,request_hash,version
FROM upload_sessions_v1;

DROP TABLE upload_sessions_v1;

ALTER TABLE panorama_upload_sessions RENAME TO panorama_upload_sessions_v1;

CREATE TABLE panorama_upload_sessions (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  candidate_id TEXT NOT NULL REFERENCES panorama_candidates(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  exact_private_object_key TEXT NOT NULL UNIQUE,
  ticket_mac BLOB,
  ticket_key_id TEXT NOT NULL,
  declared_metadata_json TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  committed_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('issued','committing','uploaded','validating','committed','expired','revoked')),
  upload_claim_id TEXT,
  upload_claim_expires_at TEXT,
  observed_upload_sha256 TEXT,
  observed_upload_bytes INTEGER,
  observed_upload_mime TEXT,
  observed_upload_etag TEXT,
  commit_operation_id TEXT,
  commit_operation_expires_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(ticket_key_id,ticket_mac),
  CHECK((status='committing') = (upload_claim_id IS NOT NULL)),
  CHECK((upload_claim_id IS NULL) = (upload_claim_expires_at IS NULL)),
  CHECK((status='validating') = (commit_operation_id IS NOT NULL)),
  CHECK((commit_operation_id IS NULL) = (commit_operation_expires_at IS NULL))
);

INSERT INTO panorama_upload_sessions(
  id,space_id,candidate_id,asset_id,exact_private_object_key,ticket_mac,ticket_key_id,
  declared_metadata_json,request_hash,expires_at,committed_at,status,version
)
SELECT id,space_id,candidate_id,asset_id,exact_private_object_key,
  CASE WHEN length(ticket_mac)=0 THEN NULL ELSE ticket_mac END,ticket_key_id,
  declared_metadata_json,request_hash,expires_at,committed_at,status,version
FROM panorama_upload_sessions_v1;

DROP TABLE panorama_upload_sessions_v1;

ALTER TABLE panorama_candidates
  ADD COLUMN current_upload_session_id TEXT REFERENCES panorama_upload_sessions(id);

UPDATE panorama_candidates
SET current_upload_session_id=(
  SELECT id FROM panorama_upload_sessions
  WHERE panorama_upload_sessions.candidate_id=panorama_candidates.id
  ORDER BY rowid DESC LIMIT 1
);

CREATE UNIQUE INDEX panorama_active_upload_session_unique
  ON panorama_upload_sessions(candidate_id)
  WHERE status IN ('issued','committing','uploaded','validating');

CREATE UNIQUE INDEX panorama_candidate_revision_unique
  ON panorama_revisions(candidate_id);

CREATE UNIQUE INDEX panorama_candidate_validation_job_unique
  ON panorama_candidates(validation_job_id)
  WHERE validation_job_id IS NOT NULL;

CREATE TABLE media_capabilities (
  id TEXT PRIMARY KEY,
  credential_mac BLOB NOT NULL,
  credential_key_id TEXT NOT NULL,
  authorization_kind TEXT NOT NULL CHECK(authorization_kind IN ('account_session','viewer_session')),
  authorization_id TEXT NOT NULL,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  photo_id TEXT REFERENCES photos(id),
  panorama_revision_id TEXT REFERENCES panorama_revisions(id),
  media_kind TEXT NOT NULL CHECK(media_kind IN ('photo','panorama')),
  asset_sha256 TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(credential_key_id,credential_mac),
  CHECK((media_kind='photo' AND photo_id IS NOT NULL AND panorama_revision_id IS NULL) OR
        (media_kind='panorama' AND photo_id IS NULL AND panorama_revision_id IS NOT NULL))
);

CREATE TABLE consent_withdrawal_events (
  id TEXT PRIMARY KEY,
  consent_event_id TEXT NOT NULL REFERENCES consent_events(id),
  actor_auth_kind TEXT NOT NULL,
  authorization_id TEXT NOT NULL,
  withdrawn_at TEXT NOT NULL,
  request_id TEXT NOT NULL,
  UNIQUE(consent_event_id,request_id)
);

CREATE TRIGGER consent_events_immutable_update BEFORE UPDATE ON consent_events BEGIN
  SELECT RAISE(ABORT,'consent_events are immutable');
END;
CREATE TRIGGER consent_events_immutable_delete BEFORE DELETE ON consent_events BEGIN
  SELECT RAISE(ABORT,'consent_events are immutable');
END;
CREATE TRIGGER consent_withdrawal_events_immutable_update BEFORE UPDATE ON consent_withdrawal_events BEGIN
  SELECT RAISE(ABORT,'consent_withdrawal_events are immutable');
END;
CREATE TRIGGER consent_withdrawal_events_immutable_delete BEFORE DELETE ON consent_withdrawal_events BEGIN
  SELECT RAISE(ABORT,'consent_withdrawal_events are immutable');
END;

CREATE TRIGGER contribution_item_composite_insert BEFORE INSERT ON contribution_batch_items
WHEN NOT EXISTS(SELECT 1 FROM contribution_batches b WHERE b.id=NEW.batch_id AND b.space_id=NEW.space_id)
BEGIN SELECT RAISE(ABORT,'contribution item composite mismatch'); END;
CREATE TRIGGER contribution_item_composite_update BEFORE UPDATE OF space_id,batch_id ON contribution_batch_items
WHEN NOT EXISTS(SELECT 1 FROM contribution_batches b WHERE b.id=NEW.batch_id AND b.space_id=NEW.space_id)
BEGIN SELECT RAISE(ABORT,'contribution item composite mismatch'); END;

CREATE TRIGGER upload_session_composite_insert BEFORE INSERT ON upload_sessions
WHEN NOT EXISTS(
  SELECT 1 FROM contribution_batches b JOIN contribution_batch_items i ON i.batch_id=b.id
  JOIN assets a ON a.id=NEW.asset_id
  WHERE b.id=NEW.batch_id AND i.id=NEW.item_id AND b.space_id=NEW.space_id AND i.space_id=NEW.space_id
    AND a.space_id=NEW.space_id AND i.asset_id=NEW.asset_id
)
BEGIN SELECT RAISE(ABORT,'upload session composite mismatch'); END;
CREATE TRIGGER upload_session_composite_update BEFORE UPDATE OF space_id,batch_id,item_id,asset_id ON upload_sessions
WHEN NOT EXISTS(
  SELECT 1 FROM contribution_batches b JOIN contribution_batch_items i ON i.batch_id=b.id
  JOIN assets a ON a.id=NEW.asset_id
  WHERE b.id=NEW.batch_id AND i.id=NEW.item_id AND b.space_id=NEW.space_id AND i.space_id=NEW.space_id
    AND a.space_id=NEW.space_id AND i.asset_id=NEW.asset_id
)
BEGIN SELECT RAISE(ABORT,'upload session composite mismatch'); END;

CREATE TRIGGER photo_composite_insert BEFORE INSERT ON photos
WHEN NOT EXISTS(
  SELECT 1 FROM contribution_batches b JOIN contribution_batch_items i ON i.batch_id=b.id
  JOIN assets a ON a.id=NEW.asset_id
  WHERE b.id=NEW.batch_id AND i.id=NEW.batch_item_id AND b.space_id=NEW.space_id AND i.space_id=NEW.space_id
    AND a.space_id=NEW.space_id AND i.asset_id=NEW.asset_id
)
BEGIN SELECT RAISE(ABORT,'photo composite mismatch'); END;

CREATE TRIGGER receipt_session_composite_insert BEFORE INSERT ON receipt_sessions
WHEN NOT EXISTS(
  SELECT 1 FROM batch_receipts r JOIN contribution_batches b ON b.id=r.batch_id
  WHERE r.id=NEW.batch_receipt_id AND b.id=NEW.batch_id AND r.space_id=NEW.space_id AND b.space_id=NEW.space_id
    AND r.actor_id=NEW.actor_id
)
BEGIN SELECT RAISE(ABORT,'receipt session composite mismatch'); END;
CREATE TRIGGER receipt_binding_composite_insert BEFORE INSERT ON receipt_account_bindings
WHEN NOT EXISTS(SELECT 1 FROM batch_receipts r JOIN contribution_batches b ON b.id=r.batch_id
  WHERE r.id=NEW.batch_receipt_id AND r.space_id=NEW.space_id AND b.space_id=NEW.space_id)
BEGIN SELECT RAISE(ABORT,'receipt binding composite mismatch'); END;

CREATE TRIGGER panorama_candidate_composite_insert BEFORE INSERT ON panorama_candidates
WHEN NOT EXISTS(SELECT 1 FROM assets a WHERE a.id=NEW.asset_id AND a.space_id=NEW.space_id AND a.kind='panorama')
BEGIN SELECT RAISE(ABORT,'panorama candidate composite mismatch'); END;
CREATE TRIGGER panorama_upload_composite_insert BEFORE INSERT ON panorama_upload_sessions
WHEN NOT EXISTS(SELECT 1 FROM panorama_candidates c JOIN assets a ON a.id=c.asset_id
  WHERE c.id=NEW.candidate_id AND c.space_id=NEW.space_id AND a.id=NEW.asset_id AND a.space_id=NEW.space_id)
BEGIN SELECT RAISE(ABORT,'panorama upload composite mismatch'); END;
CREATE TRIGGER panorama_revision_composite_insert BEFORE INSERT ON panorama_revisions
WHEN NOT EXISTS(SELECT 1 FROM panorama_candidates c JOIN assets a ON a.id=c.asset_id
  WHERE c.id=NEW.candidate_id AND c.space_id=NEW.space_id AND a.id=NEW.asset_id AND a.space_id=NEW.space_id)
BEGIN SELECT RAISE(ABORT,'panorama revision composite mismatch'); END;

CREATE TRIGGER content_case_composite_insert BEFORE INSERT ON content_cases
WHEN
  (NEW.target_type='photo' AND NOT EXISTS(SELECT 1 FROM photos p WHERE p.id=NEW.target_photo_id AND p.space_id=NEW.space_id)) OR
  (NEW.target_type='space' AND (NEW.target_space_id<>NEW.space_id OR NOT EXISTS(SELECT 1 FROM spaces s WHERE s.id=NEW.target_space_id))) OR
  (NEW.actor_relation_kind='viewer' AND NOT EXISTS(
    SELECT 1 FROM viewer_sessions vs JOIN viewer_principals vp ON vp.id=vs.viewer_principal_id
    JOIN external_invitation_grants g ON g.id=vs.grant_id
    JOIN external_invitation_campaigns c ON c.id=vs.campaign_id
    WHERE vs.id=NEW.actor_viewer_session_id AND vp.id=NEW.actor_viewer_principal_id
      AND g.id=NEW.actor_external_grant_id AND c.id=NEW.actor_external_campaign_id
      AND vs.space_id=NEW.actor_viewer_space_id AND vp.space_id=NEW.actor_viewer_space_id
      AND g.space_id=NEW.actor_viewer_space_id AND c.space_id=NEW.actor_viewer_space_id
  )) OR
  (NEW.actor_relation_kind='receipt' AND NOT EXISTS(
    SELECT 1 FROM receipt_sessions rs JOIN batch_receipts r ON r.id=rs.batch_receipt_id
    JOIN contribution_batch_items i ON i.batch_id=rs.batch_id
    WHERE rs.id=NEW.actor_receipt_session_id AND r.id=NEW.actor_batch_receipt_id
      AND i.id=NEW.actor_receipt_item_id AND rs.batch_id=NEW.actor_receipt_contribution_batch_id
      AND r.batch_id=NEW.actor_receipt_contribution_batch_id AND rs.space_id=NEW.actor_receipt_space_id
      AND r.space_id=NEW.actor_receipt_space_id AND i.space_id=NEW.actor_receipt_space_id
  )) OR
  (NEW.actor_relation_kind='case_access' AND NOT EXISTS(
    SELECT 1 FROM case_access_sessions cs WHERE cs.id=NEW.actor_case_access_session_id AND cs.case_id=NEW.actor_parent_case_id
  ))
BEGIN SELECT RAISE(ABORT,'content case composite mismatch'); END;
