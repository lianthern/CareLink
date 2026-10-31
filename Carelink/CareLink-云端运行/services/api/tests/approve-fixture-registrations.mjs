import { DatabaseSync } from "node:sqlite";
import path from "node:path";
// Only called for a freshly created, isolated test runtime. Simulates the
// administrator approving every fixture identity; production has no such trigger.
export function approveFixtureRegistrations(dataRoot) {
  const db = new DatabaseSync(path.join(dataRoot, "unseen.sqlite"));
  try {
    db.exec(
      "CREATE TRIGGER fixture_approve_registration AFTER INSERT ON account_administration WHEN NEW.status='pending' BEGIN UPDATE account_administration SET status='active' WHERE account_id=NEW.account_id; END;",
    );
  } finally {
    db.close();
  }
}
