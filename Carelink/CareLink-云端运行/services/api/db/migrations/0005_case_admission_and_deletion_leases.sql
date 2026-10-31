PRAGMA defer_foreign_keys=ON;

CREATE TABLE case_admission_counters (
  key_id TEXT NOT NULL,
  authorization_mac BLOB NOT NULL,
  bucket_start TEXT NOT NULL,
  count INTEGER NOT NULL CHECK(count BETWEEN 1 AND 20),
  expires_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  PRIMARY KEY(key_id,authorization_mac,bucket_start)
);

CREATE TABLE case_admission_dedupes (
  key_id TEXT NOT NULL,
  dedupe_mac BLOB NOT NULL,
  bucket_start TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(key_id,dedupe_mac,bucket_start)
);

ALTER TABLE deletion_requests ADD COLUMN claim_owner TEXT;
ALTER TABLE deletion_requests ADD COLUMN claim_expires_at TEXT;

CREATE TRIGGER deletion_claim_pair_insert
BEFORE INSERT ON deletion_requests
WHEN (NEW.claim_owner IS NULL) <> (NEW.claim_expires_at IS NULL)
BEGIN
  SELECT RAISE(ABORT,'deletion claim pair required');
END;

CREATE TRIGGER deletion_claim_pair_update
BEFORE UPDATE ON deletion_requests
WHEN (NEW.claim_owner IS NULL) <> (NEW.claim_expires_at IS NULL)
BEGIN
  SELECT RAISE(ABORT,'deletion claim pair required');
END;

CREATE INDEX deletion_claim_expiry ON deletion_requests(status,claim_expires_at);

CREATE TABLE account_deletion_relation_snapshots (
  id TEXT PRIMARY KEY,
  deletion_request_id TEXT NOT NULL REFERENCES deletion_requests(id),
  relation_kind TEXT NOT NULL CHECK(relation_kind IN ('membership','receipt_binding','owner_transfer')),
  relation_hash TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(deletion_request_id,relation_kind,relation_hash)
);

CREATE TRIGGER account_deletion_relation_snapshots_immutable_update
BEFORE UPDATE ON account_deletion_relation_snapshots
BEGIN
  SELECT RAISE(ABORT,'account_deletion_relation_snapshots are immutable');
END;

CREATE TRIGGER account_deletion_relation_snapshots_immutable_delete
BEFORE DELETE ON account_deletion_relation_snapshots
BEGIN
  SELECT RAISE(ABORT,'account_deletion_relation_snapshots are immutable');
END;

CREATE TABLE content_cases_v5 (
  id TEXT PRIMARY KEY,
  space_id TEXT REFERENCES spaces(id),
  case_type TEXT NOT NULL CHECK(case_type IN ('report','appeal','support')),
  parent_case_id TEXT REFERENCES content_cases_v5(id) DEFERRABLE INITIALLY DEFERRED,
  target_type TEXT NOT NULL CHECK(target_type IN ('none','photo','space','account')),
  target_photo_id TEXT,
  target_space_id TEXT REFERENCES spaces(id),
  target_account_id TEXT REFERENCES accounts(id),
  target_version INTEGER,
  actor_relation_kind TEXT NOT NULL CHECK(actor_relation_kind IN ('account','viewer','receipt','case_access','deleted_account')),
  actor_deleted_account_hash TEXT,
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
  actor_parent_case_id TEXT REFERENCES content_cases_v5(id) DEFERRABLE INITIALLY DEFERRED,
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
  CHECK((actor_relation_kind='deleted_account') = (actor_deleted_account_hash IS NOT NULL)),
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

INSERT INTO content_cases_v5(
  id,space_id,case_type,parent_case_id,target_type,target_photo_id,target_space_id,target_account_id,target_version,
  actor_relation_kind,actor_account_id,actor_account_session_id,actor_account_membership_id,actor_owner_space_id,
  actor_account_session_version,actor_account_session_epoch,actor_membership_version,actor_owner_space_version,
  actor_viewer_session_id,actor_viewer_principal_id,actor_external_campaign_id,actor_external_grant_id,actor_viewer_space_id,
  actor_viewer_session_version,actor_viewer_principal_version,actor_external_campaign_version,actor_external_grant_version,
  actor_viewer_space_version,actor_receipt_session_id,actor_batch_receipt_id,actor_receipt_contribution_batch_id,
  actor_receipt_item_id,actor_receipt_space_id,actor_receipt_session_version,actor_batch_receipt_version,
  actor_receipt_item_version,actor_receipt_space_version,actor_case_access_session_id,actor_parent_case_id,
  actor_case_access_session_version,actor_parent_case_version,category,description,decision_reason_code,status,created_at,version
)
SELECT
  id,space_id,case_type,parent_case_id,target_type,target_photo_id,target_space_id,target_account_id,target_version,
  actor_relation_kind,actor_account_id,actor_account_session_id,actor_account_membership_id,actor_owner_space_id,
  actor_account_session_version,actor_account_session_epoch,actor_membership_version,actor_owner_space_version,
  actor_viewer_session_id,actor_viewer_principal_id,actor_external_campaign_id,actor_external_grant_id,actor_viewer_space_id,
  actor_viewer_session_version,actor_viewer_principal_version,actor_external_campaign_version,actor_external_grant_version,
  actor_viewer_space_version,actor_receipt_session_id,actor_batch_receipt_id,actor_receipt_contribution_batch_id,
  actor_receipt_item_id,actor_receipt_space_id,actor_receipt_session_version,actor_batch_receipt_version,
  actor_receipt_item_version,actor_receipt_space_version,actor_case_access_session_id,actor_parent_case_id,
  actor_case_access_session_version,actor_parent_case_version,category,description,decision_reason_code,status,created_at,version
FROM content_cases;

DROP TABLE content_cases;
ALTER TABLE content_cases_v5 RENAME TO content_cases;
