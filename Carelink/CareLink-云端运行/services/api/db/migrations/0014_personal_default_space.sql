-- v3.1 personal default space (MaxNotes UNSEEN-UI规划v3, 3.1): each account
-- may have at most one lazily-created personal space ("我的空间") used as the
-- direct upload target for owner-to-self uploads. This column stays 0 for
-- every existing space; it is only ever set at lazy-creation time (see
-- SpaceService#ensurePersonal in space-service.mjs), never retrofitted onto
-- a space the account already owns. The partial unique index is the
-- durable, cross-process guarantee behind "at most one personal space per
-- account" — the service layer also re-checks inside a serialized
-- transaction, but the index is what makes that guarantee unconditional.
ALTER TABLE spaces ADD COLUMN is_personal_default INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX ux_spaces_owner_personal_default ON spaces(owner_account_id) WHERE is_personal_default=1;
