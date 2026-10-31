-- Wish wall: the space owner can list up to 6 short prompts ("what we'd love
-- to capture today") that guests see on the /s/{sid}/upload page. Stored as a
-- JSON array directly on spaces, the same pattern already used elsewhere for
-- small owner-controlled lists (space_memberships.tasks_json,
-- member_invitations.management_scopes_json) -- no new table needed for a
-- capped, single-owner-editable list.
ALTER TABLE spaces ADD COLUMN wishes_json TEXT NOT NULL DEFAULT '[]';
