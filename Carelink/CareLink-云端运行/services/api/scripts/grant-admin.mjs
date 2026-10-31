import { existsSync } from "node:fs";
import { openDatabase, transaction } from "../src/database.mjs";
import { randomUUID } from "node:crypto";
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
    const a = db
      .prepare("SELECT status FROM accounts WHERE id=?")
      .get(accountId);
    if (a?.status !== "active") throw new Error("account_unavailable");
    const state = db
      .prepare("SELECT * FROM account_administration WHERE account_id=?")
      .get(accountId);
    if (state && state.status !== "active")
      throw new Error("account_not_active");
    if (state?.is_admin === 1) return;
    db.prepare(
      "INSERT INTO account_administration(account_id,is_admin,admin_role) VALUES(?,1,'admin') ON CONFLICT(account_id) DO UPDATE SET is_admin=1,admin_role='admin'",
    ).run(accountId);
    db.prepare(
      "UPDATE accounts SET version=version+1,session_epoch=session_epoch+1 WHERE id=?",
    ).run(accountId);
    const now = new Date().toISOString();
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
      "admin_granted",
      "account",
      accountId,
      "user",
      "admin",
      "通过明确 accountId 授予",
      new Date().toISOString(),
    );
  });
  process.stdout.write(JSON.stringify({ accountId, isAdmin: true }) + "\n");
} catch {
  process.stderr.write(
    "Admin grant failed. Usage: UNSEEN_API_DB=/existing/database node services/api/scripts/grant-admin.mjs acct_ID (active account ID only).\n",
  );
  process.exitCode = 1;
} finally {
  db?.close();
}
