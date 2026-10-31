PRAGMA defer_foreign_keys=ON;

CREATE UNIQUE INDEX spaces_id_owner_unique ON spaces(id,owner_account_id);
CREATE UNIQUE INDEX account_sessions_id_account_unique ON account_sessions(id,account_id);
CREATE UNIQUE INDEX memberships_id_account_space_unique ON space_memberships(id,account_id,space_id);
CREATE UNIQUE INDEX campaigns_id_space_unique ON external_invitation_campaigns(id,space_id);
CREATE UNIQUE INDEX grants_id_campaign_space_unique ON external_invitation_grants(id,campaign_id,space_id);
CREATE UNIQUE INDEX viewer_principals_full_composite_unique
  ON viewer_principals(id,campaign_id,grant_id,space_id);
CREATE UNIQUE INDEX viewer_sessions_full_composite_unique
  ON viewer_sessions(id,viewer_principal_id,campaign_id,grant_id,space_id);
CREATE UNIQUE INDEX contribution_items_id_batch_space_unique
  ON contribution_batch_items(id,batch_id,space_id);
CREATE UNIQUE INDEX batch_receipts_id_batch_space_unique
  ON batch_receipts(id,batch_id,space_id);
CREATE UNIQUE INDEX receipt_sessions_full_composite_unique
  ON receipt_sessions(id,batch_receipt_id,batch_id,space_id);
CREATE UNIQUE INDEX photos_id_space_unique ON photos(id,space_id);
CREATE UNIQUE INDEX case_access_id_case_unique ON case_access_sessions(id,case_id);

CREATE TABLE content_cases_v3 (
  id TEXT PRIMARY KEY,
  space_id TEXT REFERENCES spaces(id),
  case_type TEXT NOT NULL CHECK(case_type IN ('report','appeal','support')),
  parent_case_id TEXT REFERENCES content_cases_v3(id) DEFERRABLE INITIALLY DEFERRED,
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
  actor_parent_case_id TEXT REFERENCES content_cases_v3(id) DEFERRABLE INITIALLY DEFERRED,
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

INSERT INTO content_cases_v3 SELECT * FROM content_cases;
DROP TABLE content_cases;
ALTER TABLE content_cases_v3 RENAME TO content_cases;
