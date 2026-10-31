PRAGMA defer_foreign_keys=ON;

ALTER TABLE identifier_equivalences ADD COLUMN normalized_identifier_ciphertext TEXT;
ALTER TABLE identifier_equivalences ADD COLUMN normalized_identifier_envelope_key_id TEXT;
ALTER TABLE identifier_equivalences ADD COLUMN normalized_identifier_envelope_format TEXT;

CREATE TRIGGER identifier_equivalence_envelope_pair_insert
BEFORE INSERT ON identifier_equivalences
WHEN ((NEW.normalized_identifier_ciphertext IS NULL) +
      (NEW.normalized_identifier_envelope_key_id IS NULL) +
      (NEW.normalized_identifier_envelope_format IS NULL)) NOT IN (0,3)
BEGIN
  SELECT RAISE(ABORT,'identifier envelope fields must be all present or all absent');
END;

CREATE TRIGGER identifier_equivalence_envelope_pair_update
BEFORE UPDATE ON identifier_equivalences
WHEN ((NEW.normalized_identifier_ciphertext IS NULL) +
      (NEW.normalized_identifier_envelope_key_id IS NULL) +
      (NEW.normalized_identifier_envelope_format IS NULL)) NOT IN (0,3)
BEGIN
  SELECT RAISE(ABORT,'identifier envelope fields must be all present or all absent');
END;

ALTER TABLE email_otp_challenges ADD COLUMN pending_identifier_ciphertext TEXT;
ALTER TABLE email_otp_challenges ADD COLUMN pending_identifier_envelope_key_id TEXT;
ALTER TABLE email_otp_challenges ADD COLUMN pending_identifier_envelope_format TEXT;

ALTER TABLE photos ADD COLUMN viewer_safe_asset_id TEXT REFERENCES assets(id);
ALTER TABLE placement_revisions ADD COLUMN fov REAL;
CREATE UNIQUE INDEX photo_viewer_safe_asset_unique ON photos(viewer_safe_asset_id)
  WHERE viewer_safe_asset_id IS NOT NULL;

CREATE TRIGGER visible_photo_requires_viewer_safe_asset_insert
BEFORE INSERT ON photos
WHEN NEW.photo_content_state='visible' AND NEW.viewer_safe_asset_id IS NULL
BEGIN
  SELECT RAISE(ABORT,'visible photo requires viewer safe asset');
END;

CREATE TRIGGER visible_photo_requires_viewer_safe_asset_update
BEFORE UPDATE ON photos
WHEN NEW.photo_content_state='visible' AND NEW.viewer_safe_asset_id IS NULL
BEGIN
  SELECT RAISE(ABORT,'visible photo requires viewer safe asset');
END;

CREATE TABLE deletion_status_sessions (
  id TEXT PRIMARY KEY,
  deletion_request_id TEXT NOT NULL UNIQUE REFERENCES deletion_requests(id),
  created_by_idempotency_record_id TEXT NOT NULL UNIQUE REFERENCES idempotency_records(id),
  credential_mac BLOB NOT NULL,
  credential_key_id TEXT NOT NULL,
  access_expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  UNIQUE(credential_key_id,credential_mac)
);

CREATE TABLE identity_namespace_leases (
  namespace TEXT PRIMARY KEY CHECK(namespace='email_v1'),
  lease_id TEXT NOT NULL,
  owner_identity TEXT NOT NULL CHECK(owner_identity='identity_rekey_service'),
  expires_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1)
);

CREATE TABLE identity_rekey_operations (
  id TEXT PRIMARY KEY,
  from_collision_key_epoch TEXT NOT NULL,
  to_collision_key_epoch TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('in_progress','completed')),
  row_count INTEGER,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  UNIQUE(from_collision_key_epoch,to_collision_key_epoch,lease_id)
);

CREATE TABLE identity_equivalence_rekey_stage (
  operation_id TEXT NOT NULL REFERENCES identity_rekey_operations(id) ON DELETE CASCADE,
  equivalence_id TEXT NOT NULL REFERENCES identifier_equivalences(id),
  new_collision_key BLOB NOT NULL,
  new_collision_key_epoch TEXT NOT NULL,
  new_identifier_ciphertext TEXT NOT NULL,
  new_identifier_envelope_key_id TEXT NOT NULL,
  new_identifier_envelope_format TEXT NOT NULL,
  PRIMARY KEY(operation_id,equivalence_id),
  UNIQUE(operation_id,new_collision_key)
);

DROP TABLE media_capabilities;

-- 0005 briefly admitted a private deleted_account actor shape. Rebuild to the
-- canonical four-way actor relation. A legacy deleted_account row fails this
-- migration atomically because its provenance cannot be reconstructed.
CREATE TABLE content_cases_v6 (
  id TEXT PRIMARY KEY,
  space_id TEXT REFERENCES spaces(id),
  case_type TEXT NOT NULL CHECK(case_type IN ('report','appeal','support')),
  parent_case_id TEXT REFERENCES content_cases_v6(id) DEFERRABLE INITIALLY DEFERRED,
  target_type TEXT NOT NULL CHECK(target_type IN ('none','photo','space','account')),
  target_photo_id TEXT,
  target_space_id TEXT REFERENCES spaces(id),
  target_account_id TEXT REFERENCES accounts(id),
  target_version INTEGER,
  actor_relation_kind TEXT NOT NULL CHECK(actor_relation_kind IN ('account','viewer','receipt','case_access')),
  actor_account_id TEXT REFERENCES accounts(id),
  actor_account_session_id TEXT,
  actor_account_membership_id TEXT,
  actor_owner_space_id TEXT,
  actor_account_session_version INTEGER,
  actor_account_session_epoch INTEGER,
  actor_membership_version INTEGER,
  actor_owner_space_version INTEGER,
  actor_viewer_session_id TEXT,
  actor_viewer_principal_id TEXT,
  actor_external_campaign_id TEXT,
  actor_external_grant_id TEXT,
  actor_viewer_space_id TEXT REFERENCES spaces(id),
  actor_viewer_session_version INTEGER,
  actor_viewer_principal_version INTEGER,
  actor_external_campaign_version INTEGER,
  actor_external_grant_version INTEGER,
  actor_viewer_space_version INTEGER,
  actor_receipt_session_id TEXT,
  actor_batch_receipt_id TEXT,
  actor_receipt_contribution_batch_id TEXT,
  actor_receipt_item_id TEXT,
  actor_receipt_space_id TEXT REFERENCES spaces(id),
  actor_receipt_session_version INTEGER,
  actor_batch_receipt_version INTEGER,
  actor_receipt_item_version INTEGER,
  actor_receipt_space_version INTEGER,
  actor_case_access_session_id TEXT,
  actor_parent_case_id TEXT REFERENCES content_cases_v6(id) DEFERRABLE INITIALLY DEFERRED,
  actor_case_access_session_version INTEGER,
  actor_parent_case_version INTEGER,
  category TEXT NOT NULL,
  description TEXT,
  decision_reason_code TEXT,
  status TEXT NOT NULL CHECK(status IN ('open','in_review','resolved','rejected')),
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,

  FOREIGN KEY(target_photo_id,space_id) REFERENCES photos(id,space_id),
  FOREIGN KEY(actor_account_session_id,actor_account_id) REFERENCES account_sessions(id,account_id),
  FOREIGN KEY(actor_account_membership_id,actor_account_id,space_id)
    REFERENCES space_memberships(id,account_id,space_id),
  FOREIGN KEY(actor_owner_space_id,actor_account_id) REFERENCES spaces(id,owner_account_id),
  FOREIGN KEY(actor_viewer_session_id,actor_viewer_principal_id,actor_external_campaign_id,
    actor_external_grant_id,actor_viewer_space_id)
    REFERENCES viewer_sessions(id,viewer_principal_id,campaign_id,grant_id,space_id),
  FOREIGN KEY(actor_viewer_principal_id,actor_external_campaign_id,actor_external_grant_id,actor_viewer_space_id)
    REFERENCES viewer_principals(id,campaign_id,grant_id,space_id),
  FOREIGN KEY(actor_external_grant_id,actor_external_campaign_id,actor_viewer_space_id)
    REFERENCES external_invitation_grants(id,campaign_id,space_id),
  FOREIGN KEY(actor_external_campaign_id,actor_viewer_space_id)
    REFERENCES external_invitation_campaigns(id,space_id),
  FOREIGN KEY(actor_receipt_session_id,actor_batch_receipt_id,actor_receipt_contribution_batch_id,actor_receipt_space_id)
    REFERENCES receipt_sessions(id,batch_receipt_id,batch_id,space_id),
  FOREIGN KEY(actor_batch_receipt_id,actor_receipt_contribution_batch_id,actor_receipt_space_id)
    REFERENCES batch_receipts(id,batch_id,space_id),
  FOREIGN KEY(actor_receipt_item_id,actor_receipt_contribution_batch_id,actor_receipt_space_id)
    REFERENCES contribution_batch_items(id,batch_id,space_id),
  FOREIGN KEY(actor_case_access_session_id,actor_parent_case_id)
    REFERENCES case_access_sessions(id,case_id) DEFERRABLE INITIALLY DEFERRED,

  CHECK(
    (target_type='none' AND target_photo_id IS NULL AND target_space_id IS NULL AND target_account_id IS NULL AND target_version IS NULL) OR
    (target_type='photo' AND target_photo_id IS NOT NULL AND target_space_id IS NULL AND target_account_id IS NULL AND target_version IS NOT NULL) OR
    (target_type='space' AND target_photo_id IS NULL AND target_space_id IS NOT NULL AND target_account_id IS NULL AND
      target_version IS NOT NULL AND target_space_id=space_id) OR
    (target_type='account' AND target_photo_id IS NULL AND target_space_id IS NULL AND target_account_id IS NOT NULL AND target_version IS NOT NULL)
  ),
  CHECK((actor_relation_kind='account') = (actor_account_id IS NOT NULL)),
  CHECK((actor_account_id IS NULL) = (actor_account_session_id IS NULL)),
  CHECK((actor_account_id IS NULL) = (actor_account_session_version IS NULL)),
  CHECK((actor_account_id IS NULL) = (actor_account_session_epoch IS NULL)),
  CHECK(actor_account_id IS NULL OR (space_id IS NULL AND actor_account_membership_id IS NULL AND actor_owner_space_id IS NULL) OR
    ((actor_account_membership_id IS NOT NULL) <> (actor_owner_space_id IS NOT NULL))),
  CHECK(actor_owner_space_id IS NULL OR actor_owner_space_id=space_id),
  CHECK((actor_account_membership_id IS NULL) = (actor_membership_version IS NULL)),
  CHECK((actor_owner_space_id IS NULL) = (actor_owner_space_version IS NULL)),
  CHECK((actor_relation_kind='viewer') = (actor_viewer_session_id IS NOT NULL)),
  CHECK((actor_viewer_session_id IS NULL) = (actor_viewer_principal_id IS NULL)),
  CHECK((actor_viewer_session_id IS NULL) = (actor_external_campaign_id IS NULL)),
  CHECK((actor_viewer_session_id IS NULL) = (actor_external_grant_id IS NULL)),
  CHECK((actor_viewer_session_id IS NULL) = (actor_viewer_space_id IS NULL)),
  CHECK((actor_viewer_session_id IS NULL) = (actor_viewer_session_version IS NULL)),
  CHECK((actor_viewer_session_id IS NULL) = (actor_viewer_principal_version IS NULL)),
  CHECK((actor_viewer_session_id IS NULL) = (actor_external_campaign_version IS NULL)),
  CHECK((actor_viewer_session_id IS NULL) = (actor_external_grant_version IS NULL)),
  CHECK((actor_viewer_session_id IS NULL) = (actor_viewer_space_version IS NULL)),
  CHECK((actor_relation_kind='receipt') = (actor_receipt_session_id IS NOT NULL)),
  CHECK((actor_receipt_session_id IS NULL) = (actor_batch_receipt_id IS NULL)),
  CHECK((actor_receipt_session_id IS NULL) = (actor_receipt_contribution_batch_id IS NULL)),
  CHECK((actor_receipt_session_id IS NULL) = (actor_receipt_item_id IS NULL)),
  CHECK((actor_receipt_session_id IS NULL) = (actor_receipt_space_id IS NULL)),
  CHECK((actor_receipt_session_id IS NULL) = (actor_receipt_session_version IS NULL)),
  CHECK((actor_receipt_session_id IS NULL) = (actor_batch_receipt_version IS NULL)),
  CHECK((actor_receipt_session_id IS NULL) = (actor_receipt_item_version IS NULL)),
  CHECK((actor_receipt_session_id IS NULL) = (actor_receipt_space_version IS NULL)),
  CHECK((actor_relation_kind='case_access') = (actor_case_access_session_id IS NOT NULL)),
  CHECK((actor_case_access_session_id IS NULL) = (actor_parent_case_id IS NULL)),
  CHECK((actor_case_access_session_id IS NULL) = (actor_case_access_session_version IS NULL)),
  CHECK((actor_case_access_session_id IS NULL) = (actor_parent_case_version IS NULL))
);

INSERT INTO content_cases_v6(
  id,space_id,case_type,parent_case_id,target_type,target_photo_id,target_space_id,target_account_id,target_version,
  actor_relation_kind,actor_account_id,actor_account_session_id,actor_account_membership_id,actor_owner_space_id,actor_account_session_version,actor_account_session_epoch,actor_membership_version,actor_owner_space_version,
  actor_viewer_session_id,actor_viewer_principal_id,actor_external_campaign_id,actor_external_grant_id,actor_viewer_space_id,actor_viewer_session_version,actor_viewer_principal_version,actor_external_campaign_version,actor_external_grant_version,
  actor_viewer_space_version,actor_receipt_session_id,actor_batch_receipt_id,actor_receipt_contribution_batch_id,actor_receipt_item_id,actor_receipt_space_id,actor_receipt_session_version,actor_batch_receipt_version,actor_receipt_item_version,
  actor_receipt_space_version,actor_case_access_session_id,actor_parent_case_id,actor_case_access_session_version,actor_parent_case_version,category,description,decision_reason_code,status,
  created_at,version
) SELECT
  id,space_id,case_type,parent_case_id,target_type,target_photo_id,target_space_id,target_account_id,target_version,
  actor_relation_kind,actor_account_id,actor_account_session_id,actor_account_membership_id,actor_owner_space_id,actor_account_session_version,actor_account_session_epoch,actor_membership_version,actor_owner_space_version,
  actor_viewer_session_id,actor_viewer_principal_id,actor_external_campaign_id,actor_external_grant_id,actor_viewer_space_id,actor_viewer_session_version,actor_viewer_principal_version,actor_external_campaign_version,actor_external_grant_version,
  actor_viewer_space_version,actor_receipt_session_id,actor_batch_receipt_id,actor_receipt_contribution_batch_id,actor_receipt_item_id,actor_receipt_space_id,actor_receipt_session_version,actor_batch_receipt_version,actor_receipt_item_version,
  actor_receipt_space_version,actor_case_access_session_id,actor_parent_case_id,actor_case_access_session_version,actor_parent_case_version,category,description,decision_reason_code,status,
  created_at,version
FROM content_cases;
DROP TABLE content_cases;
ALTER TABLE content_cases_v6 RENAME TO content_cases;

CREATE TRIGGER panorama_revisions_stable_fields_immutable
BEFORE UPDATE ON panorama_revisions
WHEN NEW.id<>OLD.id OR NEW.space_id<>OLD.space_id OR NEW.candidate_id<>OLD.candidate_id OR
  NEW.asset_id<>OLD.asset_id OR NEW.validation_report_json<>OLD.validation_report_json OR
  NEW.created_by<>OLD.created_by OR NEW.ready_at<>OLD.ready_at
BEGIN
  SELECT RAISE(ABORT,'panorama revision stable fields are immutable');
END;

CREATE TRIGGER panorama_revisions_immutable_delete
BEFORE DELETE ON panorama_revisions
BEGIN
  SELECT RAISE(ABORT,'panorama revisions are immutable');
END;
