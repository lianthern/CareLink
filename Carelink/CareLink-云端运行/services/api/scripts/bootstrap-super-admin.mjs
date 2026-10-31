import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { openDatabase, transaction } from "../src/database.mjs";
const accountId = process.argv[2],
  database = process.env.UNSEEN_API_DB;
let db;
try {
  if (
    !database ||
    database === ":memory:" ||
    !existsSync(database) ||
    !/^acct_[A-Za-z0-9_-]+$/.test(accountId ?? "") ||
    process.argv.length !== 3
  )
    throw new Error("usage");
  db = openDatabase(database);
  transaction(db, () => {
    const account = db
      .prepare(
        "SELECT a.id,a.status,m.status admission,m.is_admin,m.admin_role FROM accounts a JOIN account_administration m ON m.account_id=a.id WHERE a.id=?",
      )
      .get(accountId);
    if (
      account?.status !== "active" ||
      account.admission !== "active" ||
      account.is_admin !== 1
    )
      throw new Error("active_administrator_required");
    if (
      !db
        .prepare(
          "SELECT 1 FROM account_password_credentials WHERE account_id=? UNION ALL SELECT 1 FROM account_verified_identifiers WHERE account_id=? AND status='active'",
        )
        .get(accountId, accountId)
    )
      throw new Error("verified_identity_required");
    if (account.admin_role === "super_admin") return;
    if (
      db
        .prepare(
          "SELECT 1 FROM account_administration m JOIN accounts a ON a.id=m.account_id WHERE m.admin_role='super_admin' AND m.is_admin=1 AND m.status='active' AND a.status='active'",
        )
        .get()
    )
      throw new Error("super_administrator_already_exists");
    const now = new Date().toISOString();
    db.prepare(
      "UPDATE account_administration SET admin_role='super_admin',is_admin=1 WHERE account_id=?",
    ).run(accountId);
    db.prepare(
      "UPDATE accounts SET version=version+1,session_epoch=session_epoch+1 WHERE id=?",
    ).run(accountId);
    db.prepare(
      "UPDATE account_sessions SET revoked_at=?,version=version+1 WHERE account_id=? AND revoked_at IS NULL",
    ).run(now, accountId);
    db.prepare(
      "UPDATE account_session_families SET revoked_at=?,version=version+1 WHERE account_id=? AND revoked_at IS NULL",
    ).run(now, accountId);
    db.prepare(
      "INSERT INTO administration_audit VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      "operator-cli",
      "本机运维",
      "super_admin_bootstrapped",
      "account",
      accountId,
      "admin",
      "super_admin",
      "明确账号ID引导最高管理员",
      now,
    );
  });
  process.stdout.write(
    JSON.stringify({ accountId, adminRole: "super_admin", isAdmin: true }) +
      "\n",
  );
} catch {
  process.stderr.write(
    "Bootstrap failed. Specify one existing verified active administrator account ID: UNSEEN_API_DB=/existing/db node services/api/scripts/bootstrap-super-admin.mjs acct_ID\n",
  );
  process.exitCode = 1;
} finally {
  db?.close();
}
