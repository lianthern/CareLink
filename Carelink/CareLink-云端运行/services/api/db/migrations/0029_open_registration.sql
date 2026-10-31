-- Registration is now immediately usable; publication still requires review.
-- Only unfinished ordinary registrations are released. Preserve every ban,
-- rejection, deleted account, administrator role and existing content decision.
INSERT INTO administration_audit (
 id, actor_id, actor_name, action, target_type, target_id,
 before_status, after_status, reason, created_at
)
SELECT 'registration_open_' || m.account_id, 'system:open-registration',
 '注册规则更新', 'registration_opened', 'account', m.account_id,
 'pending', 'active', '取消注册审批，待审普通账号现可登录；公开内容仍需审核',
 strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM account_administration m JOIN accounts a ON a.id=m.account_id
WHERE m.status='pending' AND m.is_admin=0 AND a.status='active';

UPDATE accounts SET version=version+1
WHERE status='active' AND id IN (
 SELECT account_id FROM account_administration WHERE status='pending' AND is_admin=0
);

UPDATE account_administration SET status='active'
WHERE status='pending' AND is_admin=0 AND account_id IN (
 SELECT id FROM accounts WHERE status='active'
);
