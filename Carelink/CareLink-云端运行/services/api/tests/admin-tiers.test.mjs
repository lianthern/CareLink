import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fixture, png } from "./fixture-factory.mjs";
import { openDatabase } from "../src/database.mjs";
import { hashAccountPassword } from "../src/password-account-service.mjs";
async function seed(f, email, role) {
  const a = await f.login(email);
  if (role)
    f.db
      .prepare(
        "UPDATE account_administration SET is_admin=1,admin_role=? WHERE account_id=?",
      )
      .run(role, a.accountId);
  return a;
}
test("assistant administrators keep full-email operations and publication review while all private and recovery paths fail closed", async () => {
  const f = fixture();
  try {
    const highest = await seed(f, "highest@example.test", "super_admin"),
      helper = await seed(f, "helper@example.test", "admin"),
      user = await seed(f, "member@example.test"),
      peer = await seed(f, "peer@example.test", "admin");
    const base = `/v1/admin/accounts/${user.accountId}`,
      key = randomUUID(),
      image = png();
    await f.ok(
      "PUT",
      "/v1/moment-media/photo",
      {
        kind: "photo",
        name: "private.png",
        mimeType: "image/png",
        dataBase64: image.toString("base64"),
      },
      user.headers,
    );
    await f.ok(
      "PATCH",
      "/v1/profile",
      {
        displayName: "Visible nickname",
        preferences: { photoMode: "clear", readReplies: false },
        avatar: "/v1/moment-media/photo",
      },
      user.headers,
    );
    const m = {
      id: "private-moment",
      title: "PRIVATE-TITLE",
      status: "active",
      createdAt: f.clock.iso(),
      updatedAt: f.clock.iso(),
      photos: [{ id: "p", mediaId: "photo", url: "/v1/moment-media/photo" }],
      messages: [
        {
          id: "message",
          role: "user",
          text: "PRIVATE-CONVERSATION",
          createdAt: f.clock.iso(),
        },
      ],
    };
    await f.ok(
      "PUT",
      "/v1/moments/private-moment",
      { moment: m, expectedVersion: 0 },
      user.headers,
    );
    const auth = await f.ok("GET", "/v1/profile", {}, helper.headers);
    assert.equal(auth.user.isAdmin, true);
    assert.equal(auth.user.adminRole, "admin");
    assert.equal(auth.user.capabilities.canInspectPrivateData, false);
    assert.equal(auth.user.capabilities.canViewFullEmails, true);
    assert.equal(auth.user.capabilities.canManageRecovery, false);
    const detail = (await f.ok("GET", base, {}, helper.headers)).account;
    assert.equal(detail.email, "member@example.test");
    assert.equal(detail.displayName, "Visible nickname");
    assert.equal(detail.details, undefined);
    assert.equal(detail.momentCount, null);
    assert.equal(detail.storageBytes, null);
    assert.equal(detail.allowedActions.canManageStatus, true);
    assert.equal(detail.allowedActions.canInspectPrivateData, false);
    assert.equal(
      (
        await f.ok(
          "GET",
          "/v1/admin/accounts?q=member@example.test",
          {},
          helper.headers,
        )
      ).total,
      1,
    );
    const highestDto = (
      await f.ok(
        "GET",
        `/v1/admin/accounts/${highest.accountId}`,
        {},
        helper.headers,
      )
    ).account;
    assert.equal(highestDto.allowedActions.canManageStatus, false);
    const routes = [
      base + "/moments",
      base + "/moments/private-moment",
      base + "/moments/private-moment/media/photo",
      base + "/avatar",
      base + "/avatar/preview",
      base + "/sessions",
      base + "/spaces",
      base + "/spaces/unknown",
      base + "/spaces/unknown/media/panorama",
      base + "/spaces/unknown/photos",
      base + "/spaces/unknown/photos/id/media",
      base + "/spaces/unknown/photos/id/video",
      "/v1/admin/recovery-requests",
    ];
    for (const route of routes) {
      const r = await f.call("GET", route, {}, helper.headers);
      assert.equal(r.status, 403, route);
      assert.equal(r.body.error.code, "super_admin_required", route);
    }
    assert.equal(
      (
        await f.call(
          "POST",
          "/v1/admin/recovery-requests/unknown/review",
          {},
          helper.headers,
        )
      ).status,
      403,
    );
    assert.equal(
      (await f.ok("GET", base + "/moments/private-moment", {}, highest.headers))
        .moment.messages[0].text,
      "PRIVATE-CONVERSATION",
    );
    // Safe overview must not even traverse private moment payloads.
    const old = f.api.adminConsole.operations.metrics.bind(
      f.api.adminConsole.operations,
    );
    f.api.adminConsole.operations.metrics = (privateData) => {
      assert.equal(privateData, false);
      return old(privateData);
    };
    const overview = await f.ok(
      "GET",
      "/v1/admin/overview",
      {},
      helper.headers,
    );
    assert.equal(overview.counts.privateMoments, null);
    assert.ok(!JSON.stringify(overview).includes("PRIVATE-"));
    f.api.adminConsole.operations.metrics = old;
    f.db
      .prepare("INSERT INTO administration_audit VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(
        "private-audit",
        highest.accountId,
        "PRIVATE-ACTOR",
        "admin_private_moment_read",
        "account_moment",
        `${user.accountId}/PRIVATE-TARGET`,
        null,
        null,
        "PRIVATE-AUDIT",
        f.clock.iso(),
      );
    f.db
      .prepare("INSERT INTO administration_audit VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(
        "safe-audit",
        highest.accountId,
        "PRIVATE-ACTOR",
        "account_status",
        "account",
        user.accountId,
        "active",
        "disabled",
        "PRIVATE-REASON",
        f.clock.iso(),
      );
    const audit = await f.ok(
      "GET",
      "/v1/admin/audit?pageSize=100",
      {},
      helper.headers,
    );
    assert.ok(!JSON.stringify(audit).includes("PRIVATE-"));
    assert.equal(
      (
        await f.ok(
          "GET",
          "/v1/admin/audit?action=admin_private_moment_read",
          {},
          helper.headers,
        )
      ).total,
      0,
    );
    const submission = (
      await f.ok(
        "POST",
        "/v1/moments/private-moment/submissions",
        { expectedVersion: 1, consent: true },
        user.headers,
      )
    ).submission;
    assert.equal(
      (
        await f.ok(
          "GET",
          `/v1/admin/submissions/${submission.id}`,
          {},
          helper.headers,
        )
      ).moment.title,
      "PRIVATE-TITLE",
    ); // Explicitly submitted frozen copy, not live private storage.
    await f.ok(
      "POST",
      `/v1/admin/submissions/${submission.id}/review`,
      { decision: "approve", reason: "同意主动投稿", expectedVersion: 1 },
      helper.headers,
    );
    const status = await f.ok(
      "POST",
      base + "/status",
      { status: "disabled", reason: "日常管理", expectedVersion: 1 },
      { ...helper.headers, "idempotency-key": key },
    );
    assert.equal(status.account.details, undefined);
    assert.equal(status.account.momentCount, null);
    for (const target of [highest, peer])
      for (const [suffix, body] of [
        ["/status", { status: "disabled" }],
        ["/sessions/revoke", {}],
      ])
        assert.equal(
          (
            await f.call(
              "POST",
              `/v1/admin/accounts/${target.accountId}` + suffix,
              { ...body, expectedVersion: 1, reason: "不得操作管理账号" },
              helper.headers,
            )
          ).status,
          403,
        );
    assert.equal(
      (
        await f.call(
          "POST",
          base + "/role",
          { isAdmin: true, expectedVersion: 2, reason: "越权" },
          helper.headers,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.call(
          "POST",
          base + "/role",
          {
            adminRole: "super_admin",
            expectedVersion: 2,
            reason: "不允许最高",
          },
          highest.headers,
        )
      ).body.error.code,
      "role_not_assignable",
    );
    await f.ok(
      "POST",
      base + "/status",
      { status: "active", expectedVersion: 2, reason: "恢复" },
      helper.headers,
    );
    const promote = await f.ok(
      "POST",
      base + "/role",
      { isAdmin: true, expectedVersion: 3, reason: "协助管理" },
      highest.headers,
    );
    assert.equal(promote.account.adminRole, "admin");
    assert.equal(promote.account.capabilities.canInspectPrivateData, false);
    const helperVersion = (
      await f.ok(
        "GET",
        `/v1/admin/accounts/${helper.accountId}`,
        {},
        highest.headers,
      )
    ).account.version;
    await f.ok(
      "POST",
      `/v1/admin/accounts/${helper.accountId}/role`,
      { adminRole: "user", expectedVersion: helperVersion, reason: "撤销协助" },
      highest.headers,
    );
    assert.equal(
      (await f.call("GET", "/v1/admin/submissions", {}, helper.headers)).status,
      401,
    );
    assert.equal(
      (
        await f.call(
          "POST",
          base + "/status",
          { status: "disabled", reason: "日常管理", expectedVersion: 1 },
          { ...helper.headers, "idempotency-key": key },
        )
      ).status,
      401,
    );
  } finally {
    f.close();
  }
});
test("0030 migrates old administrators to assistant and exact-ID bootstrap grants one highest administrator without username rules", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "admin-tiers-migration-")),
    migrations = path.join(dir, "migrations");
  mkdirSync(migrations);
  const source = new URL("../db/migrations/", import.meta.url).pathname;
  for (const file of readdirSync(source).filter(
    (f) => f.endsWith(".sql") && f < "0030",
  ))
    copyFileSync(path.join(source, file), path.join(migrations, file));
  const database = path.join(dir, "db.sqlite");
  let db = openDatabase(database, migrations);
  const now = new Date().toISOString();
  for (const id of ["acct_verified", "acct_assistant"]) {
    db.prepare(
      "INSERT INTO accounts(id,locale,status,session_epoch,version,created_at) VALUES(?,'zh-CN','active',1,1,?)",
    ).run(id, now);
    db.prepare(
      "INSERT INTO account_administration(account_id,is_admin) VALUES(?,1)",
    ).run(id);
    db.prepare(
      "INSERT INTO account_password_credentials(account_id,username,password_hash,created_at,updated_at) VALUES(?,?,?,?,?)",
    ).run(id, id, await hashAccountPassword("fixture-password"), now, now);
  }
  db.close();
  db = openDatabase(database);
  assert.deepEqual(
    db
      .prepare("SELECT admin_role FROM account_administration")
      .all()
      .map((x) => x.admin_role),
    ["admin", "admin"],
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM account_administration WHERE admin_role='super_admin'",
      )
      .get().n,
    0,
  );
  db.close();
  const cli = new URL("../scripts/bootstrap-super-admin.mjs", import.meta.url)
    .pathname;
  const run = (id) =>
    spawnSync(process.execPath, [cli, id], {
      env: { ...process.env, UNSEEN_API_DB: database },
      encoding: "utf8",
    });
  assert.equal(run("unseen").status, 1);
  assert.equal(run("acct_verified").status, 0);
  assert.equal(run("acct_verified").status, 0);
  assert.equal(run("acct_assistant").status, 1);
  db = openDatabase(database);
  assert.equal(
    db
      .prepare(
        "SELECT admin_role FROM account_administration WHERE account_id=?",
      )
      .get("acct_verified").admin_role,
    "super_admin",
  );
  assert.equal(
    db.prepare("SELECT version FROM accounts WHERE id=?").get("acct_verified")
      .version,
    3,
  );
  db.close();
});

test("private asynchronous reads recheck highest tier even when generic isAdmin remains true", async () => {
  const f = fixture();
  try {
    const highest = await seed(f, "highest-async@example.test", "super_admin"),
      owner = await seed(f, "owner-async@example.test");
    const bytes = png(1600, 800);
    const saved = await f.ok(
      "PUT",
      "/v1/app-spaces/tier-read",
      {
        consent: true,
        title: "private-space",
        panorama: {
          name: "panorama.png",
          mimeType: "image/png",
          dataBase64: bytes.toString("base64"),
        },
      },
      { ...owner.headers, "x-unseen-expected-account-id": owner.accountId },
    );
    const original = f.api.mediaStore.get.bind(f.api.mediaStore);
    f.api.mediaStore.get = async (...args) => {
      const value = await original(...args);
      f.db
        .prepare(
          "UPDATE account_administration SET admin_role='admin' WHERE account_id=?",
        )
        .run(highest.accountId);
      return value;
    };
    const result = await f.call(
      "GET",
      `/v1/admin/accounts/${owner.accountId}/spaces/${saved.space.spaceId}/media/panorama`,
      {},
      highest.headers,
    );
    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, "super_admin_required");
    assert.equal(
      f.db
        .prepare(
          "SELECT is_admin FROM account_administration WHERE account_id=?",
        )
        .get(highest.accountId).is_admin,
      1,
    );
  } finally {
    f.close();
  }
});
