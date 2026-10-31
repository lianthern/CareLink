CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  locale TEXT NOT NULL DEFAULT 'zh-CN',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deleting','deleted')),
  session_epoch INTEGER NOT NULL DEFAULT 1 CHECK(session_epoch >= 1),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE identifier_equivalences (
  id TEXT PRIMARY KEY,
  identity_type TEXT NOT NULL DEFAULT 'email_v1' CHECK(identity_type='email_v1'),
  normalized_collision_key BLOB NOT NULL,
  collision_key_epoch TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','merged','retired')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX identifier_equivalence_active_unique
  ON identifier_equivalences(identity_type,normalized_collision_key) WHERE status='active';

CREATE TABLE account_verified_identifiers (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  identifier_equivalence_id TEXT NOT NULL REFERENCES identifier_equivalences(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
  version INTEGER NOT NULL DEFAULT 1,
  verified_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE UNIQUE INDEX account_identifier_active_unique
  ON account_verified_identifiers(identifier_equivalence_id) WHERE status='active';

CREATE TABLE account_verified_identifier_aliases (
  id TEXT PRIMARY KEY,
  identifier_equivalence_id TEXT NOT NULL REFERENCES identifier_equivalences(id),
  identifier_mac BLOB NOT NULL,
  identifier_key_id TEXT NOT NULL,
  display_mask TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'current' CHECK(status IN ('current','previous','retired')),
  grace_expires_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(identifier_key_id,identifier_mac)
);

CREATE TABLE email_otp_challenges (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  identifier_equivalence_id TEXT NOT NULL REFERENCES identifier_equivalences(id),
  identifier_alias_id TEXT NOT NULL REFERENCES account_verified_identifier_aliases(id),
  otp_mac BLOB NOT NULL,
  otp_key_id TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT,
  bound_account_id TEXT REFERENCES accounts(id),
  bound_action_id TEXT,
  bound_target_type TEXT,
  bound_target_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE account_session_families (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  issued_session_epoch INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  last_reauthenticated_at TEXT
);
CREATE TABLE account_sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  family_id TEXT NOT NULL REFERENCES account_session_families(id),
  issued_session_epoch INTEGER NOT NULL,
  credential_mac BLOB NOT NULL,
  credential_key_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT NOT NULL,
  rotated_from TEXT,
  revoked_at TEXT,
  UNIQUE(credential_key_id,credential_mac)
);
CREATE TABLE reauth_grants (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  purpose TEXT NOT NULL,
  issued_session_epoch INTEGER NOT NULL,
  credential_mac BLOB NOT NULL,
  credential_key_id TEXT NOT NULL,
  bound_action_id TEXT NOT NULL,
  bound_target_type TEXT,
  bound_target_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT,
  UNIQUE(credential_key_id,credential_mac)
);

CREATE TABLE idempotency_records (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  method TEXT NOT NULL,
  canonical_endpoint TEXT NOT NULL,
  idempotency_key_mac BLOB NOT NULL,
  idempotency_key_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  replay_class TEXT NOT NULL CHECK(replay_class IN ('ordinary_dto','credential_reissue','secret_once_envelope','completed_state')),
  state TEXT NOT NULL CHECK(state IN ('in_progress','completed','failed')),
  response_ref TEXT,
  envelope_ciphertext TEXT,
  envelope_key_id TEXT,
  envelope_expires_at TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(scope,method,canonical_endpoint,idempotency_key_mac)
);

CREATE TABLE spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_account_id TEXT NOT NULL REFERENCES accounts(id),
  space_lifecycle TEXT NOT NULL CHECK(space_lifecycle IN ('active','archived')),
  collection_state TEXT NOT NULL CHECK(collection_state IN ('open','paused')),
  sharing_state TEXT NOT NULL CHECK(sharing_state IN ('private','shared')),
  current_panorama_revision_id TEXT,
  scene_id TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE scenes (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL UNIQUE REFERENCES spaces(id) DEFERRABLE INITIALLY DEFERRED,
  scene_readiness TEXT NOT NULL CHECK(scene_readiness IN ('unavailable','processing','ready','failed')),
  scene_mode TEXT NOT NULL CHECK(scene_mode IN ('rotation360','depth_limited_parallax','walkable3d')),
  current_derived_asset_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE space_memberships (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  tasks_json TEXT NOT NULL,
  management_scopes_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','revoked')),
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES accounts(id),
  accepted_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE(space_id,account_id)
);
CREATE TABLE member_invitations (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  target_identifier_equivalence_id TEXT NOT NULL REFERENCES identifier_equivalences(id),
  tasks_json TEXT NOT NULL,
  management_scopes_json TEXT NOT NULL,
  credential_mac BLOB,
  credential_key_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  created_by TEXT NOT NULL REFERENCES accounts(id),
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(credential_key_id,credential_mac)
);

CREATE TABLE owner_transfers (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  from_owner_account_id TEXT NOT NULL REFERENCES accounts(id),
  target_account_id TEXT NOT NULL REFERENCES accounts(id),
  target_membership_id TEXT NOT NULL REFERENCES space_memberships(id),
  status TEXT NOT NULL CHECK(status IN ('pending','accepted','revoked','expired')),
  space_version_at_create INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX owner_transfer_pending_unique ON owner_transfers(space_id) WHERE status='pending';

CREATE TABLE external_invitation_campaigns (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  public_campaign_id TEXT NOT NULL UNIQUE,
  task_mode TEXT NOT NULL CHECK(task_mode IN ('view','upload','combo')),
  tasks_json TEXT NOT NULL,
  entry_task TEXT NOT NULL CHECK(entry_task IN ('view','upload')),
  campaign_status TEXT NOT NULL CHECK(campaign_status IN ('active','paused','revoked','expired','exhausted')),
  expires_at TEXT NOT NULL,
  expired_at TEXT,
  max_successful_uses INTEGER NOT NULL CHECK(max_successful_uses > 0),
  successful_use_count INTEGER NOT NULL DEFAULT 0 CHECK(successful_use_count >= 0),
  pending_admission_count INTEGER NOT NULL DEFAULT 0 CHECK(pending_admission_count >= 0),
  max_pending_admissions INTEGER NOT NULL CHECK(max_pending_admissions > 0),
  rate_policy_version TEXT NOT NULL,
  abuse_policy_version TEXT NOT NULL,
  created_by TEXT NOT NULL,
  revoked_at TEXT,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE external_campaign_admission_challenges (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES external_invitation_campaigns(id),
  client_nonce_mac BLOB NOT NULL,
  client_nonce_key_id TEXT NOT NULL,
  credential_mac BLOB NOT NULL,
  credential_key_id TEXT NOT NULL,
  risk_key_mac BLOB NOT NULL,
  risk_key_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  expiry_processed_at TEXT,
  consumed_at TEXT,
  revoked_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(credential_key_id,credential_mac)
);
CREATE TABLE external_campaign_rate_counters (
  campaign_id TEXT NOT NULL REFERENCES external_invitation_campaigns(id),
  risk_key_mac BLOB NOT NULL,
  risk_key_id TEXT NOT NULL,
  bucket_start TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(campaign_id,risk_key_id,risk_key_mac,bucket_start,policy_version)
);
CREATE TABLE external_invitation_grants (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  campaign_id TEXT NOT NULL REFERENCES external_invitation_campaigns(id),
  admission_challenge_id TEXT NOT NULL REFERENCES external_campaign_admission_challenges(id),
  credential_mac BLOB,
  credential_key_id TEXT NOT NULL,
  display_mask TEXT NOT NULL,
  tasks_json TEXT NOT NULL,
  entry_task TEXT NOT NULL,
  campaign_use_ordinal INTEGER,
  bootstrap_expires_at TEXT NOT NULL,
  bootstrap_expired_at TEXT,
  access_expires_at TEXT NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 1 CHECK(max_uses=1),
  consumed_at TEXT,
  revoked_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(credential_key_id,credential_mac)
);
CREATE UNIQUE INDEX external_grant_ordinal_unique
  ON external_invitation_grants(campaign_id,campaign_use_ordinal) WHERE campaign_use_ordinal IS NOT NULL;

CREATE TABLE viewer_principals (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  campaign_id TEXT NOT NULL REFERENCES external_invitation_campaigns(id),
  grant_id TEXT NOT NULL REFERENCES external_invitation_grants(id),
  campaign_use_ordinal INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(campaign_id,campaign_use_ordinal)
);
CREATE TABLE viewer_sessions (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  campaign_id TEXT NOT NULL REFERENCES external_invitation_campaigns(id),
  grant_id TEXT NOT NULL REFERENCES external_invitation_grants(id),
  viewer_principal_id TEXT NOT NULL REFERENCES viewer_principals(id),
  campaign_use_ordinal INTEGER NOT NULL,
  credential_mac BLOB NOT NULL,
  credential_key_id TEXT NOT NULL,
  tasks_json TEXT NOT NULL,
  space_version_at_issue INTEGER NOT NULL,
  campaign_version_at_issue INTEGER NOT NULL,
  grant_version_at_issue INTEGER NOT NULL,
  access_expires_at TEXT NOT NULL,
  revoked_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(credential_key_id,credential_mac)
);
CREATE TABLE contributor_principals (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  campaign_id TEXT NOT NULL REFERENCES external_invitation_campaigns(id),
  source_grant_id TEXT NOT NULL REFERENCES external_invitation_grants(id),
  campaign_use_ordinal INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(campaign_id,campaign_use_ordinal)
);
CREATE TABLE contributor_sessions (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  campaign_id TEXT NOT NULL REFERENCES external_invitation_campaigns(id),
  contributor_principal_id TEXT NOT NULL REFERENCES contributor_principals(id),
  source_grant_id TEXT NOT NULL REFERENCES external_invitation_grants(id),
  campaign_use_ordinal INTEGER NOT NULL,
  credential_mac BLOB NOT NULL,
  credential_key_id TEXT NOT NULL,
  tasks_json TEXT NOT NULL,
  space_version_at_issue INTEGER NOT NULL,
  campaign_version_at_issue INTEGER NOT NULL,
  grant_version_at_issue INTEGER NOT NULL,
  access_expires_at TEXT NOT NULL,
  revoked_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(credential_key_id,credential_mac)
);

CREATE TABLE external_campaign_audit_events (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  subject_kind TEXT,
  subject_id TEXT,
  campaign_use_ordinal INTEGER,
  reason_class TEXT,
  policy_version TEXT,
  actor_auth_kind TEXT,
  authorization_id TEXT,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX campaign_terminal_audit_unique ON external_campaign_audit_events(
  campaign_id,event_type,subject_kind,subject_id
) WHERE event_type IN ('expired','challenge_expired','grant_bootstrap_expired','pending_released');

CREATE TABLE contribution_batches (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('account','contributor')),
  actor_id TEXT NOT NULL,
  contributor_principal_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('open','finalizing','finalized','abandoned')),
  item_count INTEGER NOT NULL DEFAULT 0,
  committed_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  finalized_at TEXT
);
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  kind TEXT NOT NULL,
  private_object_key TEXT NOT NULL UNIQUE,
  raw_sha256 TEXT,
  observed_bytes INTEGER,
  observed_mime TEXT,
  width INTEGER,
  height INTEGER,
  frame_count INTEGER,
  orientation INTEGER,
  color_profile TEXT,
  metadata_policy_result TEXT,
  validation_state TEXT NOT NULL DEFAULT 'pending',
  validation_code TEXT,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE contribution_batch_items (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  batch_id TEXT NOT NULL REFERENCES contribution_batches(id),
  contributor_principal_id TEXT,
  asset_id TEXT REFERENCES assets(id),
  photo_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('selected','uploading','validating','committed','failed','removed','deleted')),
  failure_code TEXT,
  uploader_placement_write_enabled INTEGER NOT NULL DEFAULT 1 CHECK(uploader_placement_write_enabled IN (0,1)),
  placement_authorization_version INTEGER NOT NULL DEFAULT 1,
  revoked_at TEXT,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(space_id,batch_id,id)
);
CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  batch_id TEXT NOT NULL REFERENCES contribution_batches(id),
  item_id TEXT NOT NULL REFERENCES contribution_batch_items(id),
  actor_id TEXT NOT NULL,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  exact_private_object_key TEXT NOT NULL UNIQUE,
  ticket_mac BLOB NOT NULL,
  ticket_key_id TEXT NOT NULL,
  declared_metadata_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('issued','uploaded','committed','expired','revoked')),
  request_hash TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  type TEXT NOT NULL,
  input_refs_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','timed_out')),
  attempts INTEGER NOT NULL DEFAULT 0,
  algorithm_release_id TEXT,
  stable_error TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE algorithm_releases (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  model_hash TEXT NOT NULL,
  weights_hash TEXT NOT NULL,
  preprocess_hash TEXT NOT NULL,
  calibrator_hash TEXT NOT NULL,
  dataset_hash TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  license_status TEXT NOT NULL,
  frozen_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE photos (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  batch_id TEXT NOT NULL REFERENCES contribution_batches(id),
  batch_item_id TEXT NOT NULL REFERENCES contribution_batch_items(id),
  contributor_principal_id TEXT,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  photo_content_state TEXT NOT NULL CHECK(photo_content_state IN ('pending','visible','hidden','rejected')),
  placement_state TEXT NOT NULL CHECK(placement_state IN ('unavailable','processing','needs_confirmation','confirmed','outside_scene','stale','failed')),
  confirmation_mode TEXT CHECK(confirmation_mode IN ('auto','manual') OR confirmation_mode IS NULL),
  current_placement_revision_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  CHECK((placement_state='confirmed' AND confirmation_mode IS NOT NULL) OR
    (placement_state<>'confirmed' AND confirmation_mode IS NULL))
);
CREATE TABLE placement_revisions (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  photo_id TEXT NOT NULL REFERENCES photos(id),
  panorama_revision_id TEXT,
  seq INTEGER NOT NULL,
  parent_revision_id TEXT,
  placement_state TEXT NOT NULL,
  confirmation_mode TEXT CHECK(confirmation_mode IN ('auto','manual') OR confirmation_mode IS NULL),
  yaw REAL,
  pitch REAL,
  region TEXT,
  suggestion_id TEXT,
  algorithm_release_id TEXT REFERENCES algorithm_releases(id),
  auth_kind TEXT NOT NULL CHECK(auth_kind IN ('service_job','membership','receipt_session','space_owner')),
  authorization_id TEXT NOT NULL,
  auth_snapshot_json TEXT NOT NULL,
  restored_from TEXT,
  reason_code TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(photo_id,seq),
  CHECK((placement_state='confirmed' AND confirmation_mode IS NOT NULL) OR
    (placement_state<>'confirmed' AND confirmation_mode IS NULL))
);
CREATE TABLE placement_suggestions (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  photo_id TEXT NOT NULL REFERENCES photos(id),
  panorama_revision_id TEXT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  algorithm_release_id TEXT,
  status TEXT NOT NULL,
  candidates_json TEXT NOT NULL,
  invalidated_at TEXT,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE placement_authorization_events (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  photo_id TEXT NOT NULL,
  before_enabled INTEGER NOT NULL,
  after_enabled INTEGER NOT NULL,
  before_authorization_version INTEGER NOT NULL,
  after_authorization_version INTEGER NOT NULL,
  actor_json TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  note TEXT,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE photo_content_events (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  photo_id TEXT NOT NULL,
  before_state TEXT NOT NULL,
  after_state TEXT NOT NULL,
  transition_reason_code TEXT NOT NULL,
  decision_reason_code TEXT,
  note TEXT,
  actor_json TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE batch_receipts (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  batch_id TEXT NOT NULL UNIQUE REFERENCES contribution_batches(id),
  actor_id TEXT NOT NULL,
  credential_mac BLOB,
  credential_key_id TEXT NOT NULL,
  consumed_at TEXT,
  access_expires_at TEXT NOT NULL,
  recovery_until TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(credential_key_id,credential_mac)
);
CREATE TABLE receipt_sessions (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  batch_receipt_id TEXT NOT NULL REFERENCES batch_receipts(id),
  batch_id TEXT NOT NULL REFERENCES contribution_batches(id),
  actor_id TEXT NOT NULL,
  credential_mac BLOB NOT NULL,
  credential_key_id TEXT NOT NULL,
  receipt_version_at_issue INTEGER NOT NULL,
  access_expires_at TEXT NOT NULL,
  revoked_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(credential_key_id,credential_mac)
);
CREATE TABLE receipt_account_bindings (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  batch_receipt_id TEXT NOT NULL REFERENCES batch_receipts(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  verified_identifier_id TEXT NOT NULL REFERENCES account_verified_identifiers(id),
  verified_by_otp_challenge_id TEXT NOT NULL REFERENCES email_otp_challenges(id),
  bound_at TEXT NOT NULL,
  revoked_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(batch_receipt_id,account_id)
);

CREATE TABLE panorama_candidates (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  panorama_revision_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('created','uploading','validating','ready','failed','expired')),
  validation_job_id TEXT REFERENCES jobs(id),
  validation_code TEXT,
  created_by TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  committed_at TEXT,
  ready_at TEXT,
  failed_at TEXT,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE panorama_upload_sessions (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  candidate_id TEXT NOT NULL REFERENCES panorama_candidates(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  exact_private_object_key TEXT NOT NULL UNIQUE,
  ticket_mac BLOB NOT NULL,
  ticket_key_id TEXT NOT NULL,
  declared_metadata_json TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  committed_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('issued','uploaded','committed','expired','revoked')),
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE panorama_revisions (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  candidate_id TEXT NOT NULL REFERENCES panorama_candidates(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  validation_report_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  ready_at TEXT NOT NULL,
  activated_at TEXT,
  retired_at TEXT,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE consent_notices (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  locale TEXT NOT NULL,
  version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  retired_at TEXT,
  UNIQUE(purpose,locale,version)
);
CREATE TABLE media_notices (
  id TEXT PRIMARY KEY,
  locale TEXT NOT NULL,
  version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  UNIQUE(locale,version)
);
CREATE TABLE consent_events (
  id TEXT PRIMARY KEY,
  space_id TEXT,
  actor_auth_kind TEXT NOT NULL,
  authorization_id TEXT NOT NULL,
  notice_id TEXT NOT NULL,
  notice_version INTEGER NOT NULL,
  notice_hash TEXT NOT NULL,
  notice_purpose TEXT NOT NULL,
  accepted_at TEXT NOT NULL
);
CREATE TABLE notice_ack_events (
  id TEXT PRIMARY KEY,
  space_id TEXT,
  actor_auth_kind TEXT NOT NULL,
  authorization_id TEXT NOT NULL,
  notice_id TEXT NOT NULL,
  notice_version INTEGER NOT NULL,
  notice_hash TEXT NOT NULL,
  notice_purpose TEXT NOT NULL,
  target_mutation_id TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL
);

CREATE TABLE content_cases (
  id TEXT PRIMARY KEY,
  space_id TEXT,
  case_type TEXT NOT NULL CHECK(case_type IN ('report','appeal','support')),
  parent_case_id TEXT REFERENCES content_cases(id),
  target_type TEXT NOT NULL CHECK(target_type IN ('none','photo','space','account')),
  target_photo_id TEXT REFERENCES photos(id),
  target_space_id TEXT REFERENCES spaces(id),
  target_account_id TEXT REFERENCES accounts(id),
  target_version INTEGER,
  actor_relation_kind TEXT NOT NULL CHECK(actor_relation_kind IN ('account','viewer','receipt','case_access')),
  actor_account_id TEXT REFERENCES accounts(id),
  actor_account_session_id TEXT REFERENCES account_sessions(id),
  actor_account_membership_id TEXT REFERENCES space_memberships(id),
  actor_owner_space_id TEXT REFERENCES spaces(id),
  actor_account_session_version INTEGER,
  actor_account_session_epoch INTEGER,
  actor_membership_version INTEGER,
  actor_owner_space_version INTEGER,
  actor_viewer_session_id TEXT REFERENCES viewer_sessions(id),
  actor_viewer_principal_id TEXT REFERENCES viewer_principals(id),
  actor_external_campaign_id TEXT REFERENCES external_invitation_campaigns(id),
  actor_external_grant_id TEXT REFERENCES external_invitation_grants(id),
  actor_viewer_space_id TEXT REFERENCES spaces(id),
  actor_viewer_session_version INTEGER,
  actor_viewer_principal_version INTEGER,
  actor_external_campaign_version INTEGER,
  actor_external_grant_version INTEGER,
  actor_viewer_space_version INTEGER,
  actor_receipt_session_id TEXT REFERENCES receipt_sessions(id),
  actor_batch_receipt_id TEXT REFERENCES batch_receipts(id),
  actor_receipt_contribution_batch_id TEXT REFERENCES contribution_batches(id),
  actor_receipt_item_id TEXT REFERENCES contribution_batch_items(id),
  actor_receipt_space_id TEXT REFERENCES spaces(id),
  actor_receipt_session_version INTEGER,
  actor_batch_receipt_version INTEGER,
  actor_receipt_item_version INTEGER,
  actor_receipt_space_version INTEGER,
  actor_case_access_session_id TEXT REFERENCES case_access_sessions(id) DEFERRABLE INITIALLY DEFERRED,
  actor_parent_case_id TEXT REFERENCES content_cases(id) DEFERRABLE INITIALLY DEFERRED,
  actor_case_access_session_version INTEGER,
  actor_parent_case_version INTEGER,
  category TEXT NOT NULL,
  description TEXT,
  decision_reason_code TEXT,
  status TEXT NOT NULL CHECK(status IN ('open','in_review','resolved','rejected')),
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  CHECK(
    (target_type='none' AND target_photo_id IS NULL AND target_space_id IS NULL AND target_account_id IS NULL AND target_version IS NULL) OR
    (target_type='photo' AND target_photo_id IS NOT NULL AND target_space_id IS NULL AND target_account_id IS NULL AND target_version IS NOT NULL) OR
    (target_type='space' AND target_photo_id IS NULL AND target_space_id IS NOT NULL AND target_account_id IS NULL AND target_version IS NOT NULL) OR
    (target_type='account' AND target_photo_id IS NULL AND target_space_id IS NULL AND target_account_id IS NOT NULL AND target_version IS NOT NULL)
  ),
  CHECK((actor_relation_kind='account') = (actor_account_id IS NOT NULL)),
  CHECK((actor_account_id IS NULL) = (actor_account_session_id IS NULL)),
  CHECK((actor_account_id IS NULL) = (actor_account_session_version IS NULL)),
  CHECK((actor_account_id IS NULL) = (actor_account_session_epoch IS NULL)),
  CHECK(actor_account_id IS NULL OR (space_id IS NULL AND actor_account_membership_id IS NULL AND actor_owner_space_id IS NULL) OR
    ((actor_account_membership_id IS NOT NULL) <> (actor_owner_space_id IS NOT NULL))),
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
CREATE TABLE case_access_sessions (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES content_cases(id) DEFERRABLE INITIALLY DEFERRED,
  account_id TEXT REFERENCES accounts(id),
  credential_mac BLOB NOT NULL,
  credential_key_id TEXT NOT NULL,
  relation_kind TEXT NOT NULL CHECK(relation_kind IN ('reporter','appellant','support_requester')),
  relation_version INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(credential_key_id,credential_mac)
);
CREATE TABLE case_decision_events (
  id TEXT PRIMARY KEY,
  space_id TEXT,
  case_id TEXT NOT NULL REFERENCES content_cases(id),
  before_status TEXT NOT NULL,
  after_status TEXT NOT NULL,
  decision_reason_code TEXT NOT NULL,
  note TEXT,
  case_actor_relation_kind TEXT NOT NULL,
  exact_authorization_snapshot TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE deletion_requests (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  requester_json TEXT NOT NULL,
  status TEXT NOT NULL,
  ledger_id TEXT NOT NULL UNIQUE,
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE deletion_attempt_events (
  id TEXT PRIMARY KEY,
  deletion_request_id TEXT NOT NULL REFERENCES deletion_requests(id),
  seq INTEGER NOT NULL,
  previous_event_id TEXT,
  resource_type TEXT NOT NULL,
  resource_hash TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  action TEXT NOT NULL,
  started_at TEXT NOT NULL,
  request_idempotency_id TEXT NOT NULL,
  UNIQUE(deletion_request_id,seq)
);
CREATE TABLE deletion_status_events (
  id TEXT PRIMARY KEY,
  deletion_request_id TEXT NOT NULL REFERENCES deletion_requests(id),
  seq INTEGER NOT NULL,
  previous_event_id TEXT,
  status TEXT NOT NULL,
  stable_error_code TEXT,
  completed_at TEXT,
  UNIQUE(deletion_request_id,seq)
);
CREATE TABLE export_jobs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  space_id TEXT REFERENCES spaces(id),
  scope TEXT NOT NULL CHECK(scope IN ('account','space')),
  status TEXT NOT NULL,
  object_key TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE export_artifacts (
  export_id TEXT PRIMARY KEY REFERENCES export_jobs(id),
  content BLOB NOT NULL,
  content_type TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE export_download_authorizations (
  id TEXT PRIMARY KEY,
  export_id TEXT NOT NULL REFERENCES export_jobs(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  account_session_id TEXT NOT NULL REFERENCES account_sessions(id),
  credential_mac BLOB NOT NULL,
  credential_key_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(credential_key_id,credential_mac)
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  space_id TEXT,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  authorization_id TEXT,
  detail_json TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TRIGGER audit_events_immutable_update BEFORE UPDATE ON audit_events BEGIN
  SELECT RAISE(ABORT,'audit_events are immutable');
END;
CREATE TRIGGER audit_events_immutable_delete BEFORE DELETE ON audit_events BEGIN
  SELECT RAISE(ABORT,'audit_events are immutable');
END;
CREATE TRIGGER placement_revisions_immutable_update BEFORE UPDATE ON placement_revisions BEGIN
  SELECT RAISE(ABORT,'placement_revisions are immutable');
END;
CREATE TRIGGER placement_revisions_immutable_delete BEFORE DELETE ON placement_revisions BEGIN
  SELECT RAISE(ABORT,'placement_revisions are immutable');
END;
CREATE TRIGGER photo_content_events_immutable_update BEFORE UPDATE ON photo_content_events BEGIN
  SELECT RAISE(ABORT,'photo_content_events are immutable');
END;
CREATE TRIGGER photo_content_events_immutable_delete BEFORE DELETE ON photo_content_events BEGIN
  SELECT RAISE(ABORT,'photo_content_events are immutable');
END;
CREATE TRIGGER placement_authorization_events_immutable_update BEFORE UPDATE ON placement_authorization_events BEGIN
  SELECT RAISE(ABORT,'placement_authorization_events are immutable');
END;
CREATE TRIGGER placement_authorization_events_immutable_delete BEFORE DELETE ON placement_authorization_events BEGIN
  SELECT RAISE(ABORT,'placement_authorization_events are immutable');
END;
CREATE TRIGGER external_campaign_audit_events_immutable_update BEFORE UPDATE ON external_campaign_audit_events BEGIN
  SELECT RAISE(ABORT,'external_campaign_audit_events are immutable');
END;
CREATE TRIGGER external_campaign_audit_events_immutable_delete BEFORE DELETE ON external_campaign_audit_events BEGIN
  SELECT RAISE(ABORT,'external_campaign_audit_events are immutable');
END;
CREATE TRIGGER case_decision_events_immutable_update BEFORE UPDATE ON case_decision_events BEGIN
  SELECT RAISE(ABORT,'case_decision_events are immutable');
END;
CREATE TRIGGER case_decision_events_immutable_delete BEFORE DELETE ON case_decision_events BEGIN
  SELECT RAISE(ABORT,'case_decision_events are immutable');
END;
CREATE TRIGGER deletion_attempt_events_immutable_update BEFORE UPDATE ON deletion_attempt_events BEGIN
  SELECT RAISE(ABORT,'deletion_attempt_events are immutable');
END;
CREATE TRIGGER deletion_attempt_events_immutable_delete BEFORE DELETE ON deletion_attempt_events BEGIN
  SELECT RAISE(ABORT,'deletion_attempt_events are immutable');
END;
CREATE TRIGGER deletion_status_events_immutable_update BEFORE UPDATE ON deletion_status_events BEGIN
  SELECT RAISE(ABORT,'deletion_status_events are immutable');
END;
CREATE TRIGGER deletion_status_events_immutable_delete BEFORE DELETE ON deletion_status_events BEGIN
  SELECT RAISE(ABORT,'deletion_status_events are immutable');
END;
CREATE TRIGGER algorithm_releases_immutable_update BEFORE UPDATE ON algorithm_releases BEGIN
  SELECT RAISE(ABORT,'algorithm_releases are immutable');
END;
CREATE TRIGGER algorithm_releases_immutable_delete BEFORE DELETE ON algorithm_releases BEGIN
  SELECT RAISE(ABORT,'algorithm_releases are immutable');
END;
