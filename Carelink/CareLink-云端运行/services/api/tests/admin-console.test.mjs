import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fixture } from "./fixture-factory.mjs";
import { createPasswordAccount } from "../src/password-account-service.mjs";
import { LocalKeyring } from "../src/crypto.mjs";
import { FilesystemMediaStore } from "../src/ports/media/filesystem-media-store.mjs";
import {
  createLocalHttpServer,
  listenLocalHttpServer,
} from "../src/http-server.mjs";
const password = "test-password-2026";
async function login(f, username) {
  const a = await f.ok("POST", "/v1/auth/password-login", {
    username,
    password,
  });
  return {
    ...a,
    headers: {
      authorization: `Bearer ${a.accountSessionSecret}`,
      "x-unseen-expected-account-id": a.accountId,
    },
  };
}
async function seed(f, username, admin = false) {
  const a = await createPasswordAccount(f.api.core, { username, password });
  if (admin)
    f.db
      .prepare(
        "INSERT INTO account_administration(account_id,is_admin,admin_role) VALUES(?,1,'super_admin')",
      )
      .run(a.accountId);
  return login(f, username);
}
const moment = {
  id: "moment-1",
  title: "冻结原话",
  createdAt: "2026-09-06T00:00:00Z",
  updatedAt: "2026-09-06T00:00:00Z",
  status: "active",
  photos: [],
  messages: [
    {
      id: "msg",
      role: "user",
      text: "仅在主动投稿后可见",
      createdAt: "2026-09-06T00:00:00Z",
    },
  ],
};
test("registration, server roles, versioned decisions, session invalidation, OTP admission and safe metadata", async () => {
  const f = fixture();
  try {
    const admin = await seed(f, "operator", true),
      user = await seed(f, "ordinary");
    assert.equal((await f.call("GET", "/v1/admin/overview")).status, 401);
    assert.equal(
      (await f.call("GET", "/v1/admin/overview", {}, user.headers)).status,
      403,
    );
    const body = { username: "new-user", password, displayName: "新申请" },
      key = randomUUID();
    const reg = await f.ok("POST", "/v1/auth/register", body, {
      "idempotency-key": key,
    });
    assert.deepEqual(
      (
        await f.ok("POST", "/v1/auth/register", body, {
          "idempotency-key": key,
        })
      ).registration,
      reg.registration,
    );
    assert.equal(reg.registration.status, 'active');
    const immediate = await login(f, 'new-user');
    assert.equal(immediate.user.isAdmin, false);
    // A legacy hold still blocks login; normal registrations no longer enter it.
    f.db.prepare("UPDATE account_administration SET status='pending' WHERE account_id=?").run(reg.registration.accountId);
    assert.equal(
      (
        await f.call("POST", "/v1/auth/password-login", {
          username: "new-user",
          password,
        })
      ).body.error.code,
      "account_pending",
    );
    let a = (
      await f.ok(
        "GET",
        `/v1/admin/accounts/${reg.registration.accountId}`,
        {},
        admin.headers,
      )
    ).account;
    const status = (id, status, version, headers = admin.headers) =>
      f.ok(
        "POST",
        `/v1/admin/accounts/${id}/status`,
        { status, reason: "测试审核", expectedVersion: version },
        headers,
      );
    a = (await status(a.id, "rejected", a.version)).account;
    assert.equal(
      (
        await f.call("POST", "/v1/auth/password-login", {
          username: "new-user",
          password,
        })
      ).body.error.code,
      "account_rejected",
    );
    a = (await status(a.id, "active", a.version)).account;
    const session = await login(f, "new-user");
    a = (await status(a.id, "disabled", a.version)).account;
    assert.equal(
      (await f.call("GET", "/v1/profile", {}, session.headers)).status,
      401,
    );
    assert.equal(
      (
        await f.call("POST", "/v1/auth/password-login", {
          username: "new-user",
          password,
        })
      ).body.error.code,
      "account_disabled",
    );
    await status(a.id, "active", a.version);
    assert.equal(
      (await f.call("GET", "/v1/profile", {}, session.headers)).status,
      401,
    );
    const self = (
      await f.ok(
        "GET",
        `/v1/admin/accounts/${admin.accountId}`,
        {},
        admin.headers,
      )
    ).account;
    assert.equal(
      (
        await f.call(
          "POST",
          `/v1/admin/accounts/${self.id}/status`,
          { status: "disabled", reason: "oops", expectedVersion: self.version },
          admin.headers,
        )
      ).body.error.code,
      "cannot_disable_self",
    );
    const otp = await f.ok("POST", "/v1/auth/email-otp-challenges", {
      email: "fresh@example.test",
      purpose: "login",
    });
    const verified = await f.ok("POST", "/v1/auth/email-otp-verifications", {
      challengeId: otp.challengeId,
      otp: f.otp.at(-1).code,
      purpose: "login",
    });
    assert.ok(verified.accountSessionSecret);
    const fresh = verified.accountId;
    const oldOtp = await f.login("fresh@example.test");
    assert.equal(oldOtp.accountId, fresh);
    await status(fresh, "disabled", 1);
    assert.equal(
      (await f.call("GET", "/v1/profile", {}, oldOtp.headers)).status,
      401,
    );
    const otp2 = await f.ok("POST", "/v1/auth/email-otp-challenges", {
      email: "fresh@example.test",
      purpose: "login",
    });
    assert.equal(
      (
        await f.call("POST", "/v1/auth/email-otp-verifications", {
          challengeId: otp2.challengeId,
          otp: f.otp.at(-1).code,
          purpose: "login",
        })
      ).body.error.code,
      "account_disabled",
    );
    const list = await f.ok(
      "GET",
      "/v1/admin/accounts?q=new-user&pageSize=1",
      {},
      admin.headers,
    );
    assert.equal(list.total, 1);
    assert.equal(list.accounts[0].displayName, "新申请");
    assert.ok(!JSON.stringify(list).includes("password_hash"));
    assert.ok(
      !JSON.stringify(
        await f.ok("GET", "/v1/admin/audit", {}, admin.headers),
      ).includes(password),
    );
  } finally {
    f.close();
  }
});
test("frozen submitted media, private edits, approval/reject/unpublish/withdraw and owner isolation persist after restart", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "admin-console-")),
    database = path.join(dir, "db.sqlite"),
    keyring = new LocalKeyring({ persistent: true });
  const options = {
    database,
    keyring,
    mediaStore: new FilesystemMediaStore(path.join(dir, "media")),
  };
  let f = fixture(options);
  try {
    const admin = await seed(f, "operator", true),
      user = await seed(f, "ordinary"),
      other = await seed(f, "other");
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3m8AAAAASUVORK5CYII=",
      "base64",
    );
    await f.ok(
      "PUT",
      "/v1/moment-media/photo",
      {
        kind: "photo",
        name: "photo.png",
        mimeType: "image/png",
        dataBase64: bytes.toString("base64"),
      },
      user.headers,
    );
    await f.ok(
      "PUT",
      "/v1/moment-media/unsubmitted",
      {
        kind: "photo",
        name: "secret.png",
        mimeType: "image/png",
        dataBase64: bytes.toString("base64"),
      },
      user.headers,
    );
    await f.ok(
      "PUT",
      "/v1/moment-media/__proto__",
      {
        kind: "photo",
        name: "prototype.png",
        mimeType: "image/png",
        dataBase64: bytes.toString("base64"),
      },
      user.headers,
    );
    const doc = {
      ...moment,
      photos: [
        { id: "p1", mediaId: "photo", url: "/v1/moment-media/photo" },
        { id: "p2", mediaId: "__proto__", url: "/v1/moment-media/__proto__" },
      ],
    };
    await f.ok(
      "PUT",
      "/v1/moments/moment-1",
      { moment: doc, expectedVersion: 0 },
      user.headers,
    );
    assert.equal(
      (await f.call("GET", "/v1/moments/moment-1", {}, admin.headers)).status,
      404,
    );
    assert.equal(
      (
        await f.call(
          "POST",
          "/v1/moments/moment-1/submissions",
          { expectedVersion: 1, consent: true },
          other.headers,
        )
      ).status,
      404,
    );
    const body = { expectedVersion: 1, consent: true },
      key = randomUUID();
    let sub = (
      await f.ok("POST", "/v1/moments/moment-1/submissions", body, {
        ...user.headers,
        "idempotency-key": key,
      })
    ).submission;
    assert.equal(
      (
        await f.ok("POST", "/v1/moments/moment-1/submissions", body, {
          ...user.headers,
          "idempotency-key": key,
        })
      ).submission.id,
      sub.id,
    );
    const publicPath = `/v1/public/moments/${sub.id}`,
      adminPath = `/v1/admin/submissions/${sub.id}`;
    assert.equal((await f.call("GET", publicPath)).status, 404);
    assert.equal(
      (await f.call("GET", publicPath + "/media/photo")).status,
      404,
    );
    assert.equal(
      (await f.call("GET", adminPath, {}, user.headers)).status,
      403,
    );
    assert.deepEqual(
      (await f.call("GET", adminPath + "/media/photo", {}, admin.headers)).body,
      bytes,
    );
    assert.equal(
      (await f.call("GET", adminPath + "/media/unsubmitted", {}, admin.headers))
        .status,
      404,
    );
    assert.deepEqual(
      (await f.call("GET", adminPath + "/media/__proto__", {}, admin.headers))
        .body,
      bytes,
    );
    const snapshot = f.db
      .prepare("SELECT snapshot_id FROM moment_submissions WHERE id=?")
      .get(sub.id).snapshot_id;
    assert.equal(
      (
        await f.call(
          "POST",
          `/v1/me/memories/${snapshot}`,
          { document: { hacked: true }, consent: true },
          { ...user.headers, "if-match": "1" },
        )
      ).status,
      403,
    );
    await f.ok(
      "PUT",
      "/v1/moments/moment-1",
      { moment: { ...doc, title: "私下后来修改" }, expectedVersion: 1 },
      user.headers,
    );
    const review = (decision, expectedVersion, key = randomUUID()) =>
      f.ok(
        "POST",
        adminPath + "/review",
        { decision, reason: "审核理由", expectedVersion },
        { ...admin.headers, "idempotency-key": key },
      );
    const approveKey = randomUUID();
    sub = (await review("approve", 1, approveKey)).submission;
    await review("approve", 1, approveKey);
    assert.equal(
      (
        await f.call(
          "POST",
          adminPath + "/review",
          { decision: "reject", reason: "stale", expectedVersion: 1 },
          admin.headers,
        )
      ).status,
      409,
    );
    assert.equal(sub.publicUrl, `/app#public/${sub.id}`);
    assert.equal((await f.ok("GET", publicPath)).moment.title, "冻结原话");
    assert.deepEqual(
      (await f.call("GET", publicPath + "/media/photo")).body,
      bytes,
    );
    assert.equal((await f.ok("GET", "/v1/public/moments")).moments.length, 1);
    f.close();
    f = fixture(options);
    assert.equal(sub.publicUrl, `/app#public/${sub.id}`);
    assert.equal((await f.ok("GET", publicPath)).moment.title, "冻结原话");
    assert.equal(
      (await f.ok("GET", "/v1/profile", {}, admin.headers)).user.isAdmin,
      true,
    );
    let a = (
      await f.ok(
        "GET",
        `/v1/admin/accounts/${user.accountId}`,
        {},
        admin.headers,
      )
    ).account;
    a = (
      await f.ok(
        "POST",
        `/v1/admin/accounts/${a.id}/status`,
        { status: "disabled", reason: "禁用", expectedVersion: a.version },
        admin.headers,
      )
    ).account;
    assert.equal(
      (await f.call("GET", publicPath + "/media/photo")).status,
      404,
    );
    assert.equal((await f.ok("GET", "/v1/public/moments")).moments.length, 0);
    await f.ok(
      "POST",
      `/v1/admin/accounts/${a.id}/status`,
      { status: "active", reason: "恢复", expectedVersion: a.version },
      admin.headers,
    );
    const restored = await login(f, "ordinary");
    assert.equal((await f.call("GET", publicPath)).status, 200);
    sub = (await review("unpublish", sub.version)).submission;
    assert.equal(
      (await f.call("GET", publicPath + "/media/photo")).status,
      404,
    );
    sub = (
      await f.ok(
        "POST",
        "/v1/moments/moment-1/submissions",
        { expectedVersion: 2, consent: true },
        restored.headers,
      )
    ).submission;
    sub = (
      await f.ok(
        "POST",
        `/v1/admin/submissions/${sub.id}/review`,
        { decision: "reject", reason: "不适合公开", expectedVersion: 1 },
        admin.headers,
      )
    ).submission;
    sub = (
      await f.ok(
        "POST",
        "/v1/moments/moment-1/submissions",
        { expectedVersion: 2, consent: true },
        restored.headers,
      )
    ).submission;
    assert.equal(
      (
        await f.call(
          "POST",
          `/v1/me/submissions/${sub.id}/withdraw`,
          { expectedVersion: 1 },
          other.headers,
        )
      ).status,
      404,
    );
    await f.ok(
      "POST",
      `/v1/me/submissions/${sub.id}/withdraw`,
      { expectedVersion: 1 },
      restored.headers,
    );
    assert.equal(
      (await f.ok("GET", "/v1/me/submissions", {}, restored.headers))
        .submissions[0].status,
      "withdrawn",
    );
    const cli = spawnSync(
      process.execPath,
      [
        new URL("../scripts/grant-admin.mjs", import.meta.url).pathname,
        other.accountId,
      ],
      { env: { ...process.env, UNSEEN_API_DB: database }, encoding: "utf8" },
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(
      (await f.call("GET", "/v1/profile", {}, other.headers)).status,
      401,
    );
    assert.equal(
      (await f.ok("GET", "/v1/profile", {}, (await login(f, "other")).headers))
        .user.isAdmin,
      true,
    );
    assert.equal(
      spawnSync(
        process.execPath,
        [
          new URL("../scripts/grant-admin.mjs", import.meta.url).pathname,
          "operator",
        ],
        { env: { ...process.env, UNSEEN_API_DB: database } },
      ).status,
      1,
    );
  } finally {
    f.close();
  }
});
test("HTTP registration never sets a login cookie; cookies and origin protect administrator mutations", async () => {
  const f = fixture(),
    admin = await seed(f, "operator", true),
    server = createLocalHttpServer({ api: f.api });
  const { origin } = await listenLocalHttpServer(server, {
    host: "127.0.0.1",
    port: 0,
  });
  f.api.campaigns.publicOrigin = origin;
  const req = async (method, p, body, headers = {}) => {
    const r = await fetch(origin + p, {
      method,
      headers: {
        "content-type": "application/json",
        origin,
        "sec-fetch-site": "same-origin",
        "idempotency-key": randomUUID(),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, headers: r.headers, body: await r.json() };
  };
  try {
    const reg = await req("POST", "/v1/auth/register", {
      username: "visitor",
      password,
      displayName: "访客",
    });
    assert.equal(reg.status, 200);
    assert.equal(reg.headers.get("set-cookie"), null);
    const signed = await req("POST", "/v1/auth/password-login", {
      username: "operator",
      password,
    });
    const cookie = signed.headers.get("set-cookie").split(";")[0];
    assert.equal(signed.body.accountSessionSecret, undefined);
    assert.equal(
      (await req("GET", "/v1/admin/overview", null, { cookie })).status,
      200,
    );
    assert.equal(
      (
        await req(
          "POST",
          `/v1/admin/accounts/${reg.body.registration.accountId}/status`,
          { status: "active", reason: "yes", expectedVersion: 1 },
          { cookie, origin: "https://foreign.example" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await req(
          "POST",
          "/v1/auth/register",
          { username: "foreign", password, displayName: "跨站" },
          { origin: "https://foreign.example" },
        )
      ).status,
      403,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    f.close();
  }
});

test("last administrator cannot erase the only administrative identity through account deletion", async () => {
  const f = fixture();
  try {
    const a = await f.login("only-admin@example.test");
    f.db
      .prepare(
        "UPDATE account_administration SET is_admin=1,admin_role='super_admin' WHERE account_id=?",
      )
      .run(a.accountId);
    const grant = await f.reauth(
      a,
      "ACCOUNT.DELETE_REQUEST",
      "account_delete",
      "account",
      a.accountId,
    );
    const result = await f.call(
      "POST",
      "/v1/me/deletion-requests",
      { confirmation: true, reauthGrant: grant.reauthGrantSecret },
      { ...a.headers, "if-match": "1" },
    );
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.error.code, "last_super_admin_required");
  } finally {
    f.close();
  }
});

test("administrator account labels use authorized complete current OTP emails and are searchable", async () => {
  const f = fixture();
  try {
    const admin = await seed(f, "operator", true);
    const email = "recognizable-person@example.test";
    const otp = await f.login(email);
    const mask = f.db
      .prepare(
        `SELECT a.display_mask FROM account_verified_identifiers v
      JOIN account_verified_identifier_aliases a ON a.identifier_equivalence_id=v.identifier_equivalence_id
      WHERE v.account_id=? AND v.status='active' AND a.status='current'`,
      )
      .get(otp.accountId).display_mask;
    assert.notEqual(mask, email);
    const detail = await f.ok(
      "GET",
      `/v1/admin/accounts/${otp.accountId}`,
      {},
      admin.headers,
    );
    assert.equal(detail.account.username, null);
    assert.equal(detail.account.loginLabel, email);
    assert.equal(detail.account.email, email);
    assert.equal(detail.account.emailUnavailable, false);
    assert.equal(detail.account.emails[0].email, email);
    const found = await f.ok(
      "GET",
      `/v1/admin/accounts?q=${encodeURIComponent(email)}`,
      {},
      admin.headers,
    );
    assert.equal(found.total, 1);
    assert.equal(found.accounts[0].id, otp.accountId);
    assert.equal(found.accounts[0].email, email);
    assert.equal(
      (
        await f.ok(
          "GET",
          `/v1/admin/accounts/${admin.accountId}`,
          {},
          admin.headers,
        )
      ).account.loginLabel,
      "operator",
    );
    f.db
      .prepare(
        "UPDATE account_verified_identifier_aliases SET status='previous' WHERE display_mask=?",
      )
      .run(mask);
    assert.equal(
      (
        await f.ok(
          "GET",
          `/v1/admin/accounts/${otp.accountId}`,
          {},
          admin.headers,
        )
      ).account.loginLabel,
      otp.accountId,
    );
  } finally {
    f.close();
  }
});
