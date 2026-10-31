ALTER TABLE account_administration ADD COLUMN admin_role TEXT NOT NULL DEFAULT 'user'
 CHECK(admin_role IN ('user','admin','super_admin'));
UPDATE account_administration SET admin_role='admin' WHERE is_admin=1;
-- Make the narrowing of all old administrator grants effective on every device.
UPDATE accounts SET session_epoch=session_epoch+1,version=version+1
 WHERE id IN (SELECT account_id FROM account_administration WHERE is_admin=1);
UPDATE account_sessions SET revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),version=version+1
 WHERE account_id IN (SELECT account_id FROM account_administration WHERE is_admin=1) AND revoked_at IS NULL;
UPDATE account_session_families SET revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),version=version+1
 WHERE account_id IN (SELECT account_id FROM account_administration WHERE is_admin=1) AND revoked_at IS NULL;
