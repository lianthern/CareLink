import test from "node:test";
import assert from "node:assert/strict";
import { fixture, png as makePng } from "./fixture-factory.mjs";
import { createPasswordAccount } from "../src/password-account-service.mjs";
const password = "inspection-test-password";
async function seed(f, username, admin = false) {
  const a = await createPasswordAccount(f.api.core, { username, password });
  if (admin)
    f.db
      .prepare(
        "INSERT INTO account_administration(account_id,is_admin,admin_role) VALUES(?,1,'super_admin')",
      )
      .run(a.accountId);
  const session = await f.ok("POST", "/v1/auth/password-login", {
    username,
    password,
  });
  return {
    ...session,
    headers: { authorization: `Bearer ${session.accountSessionSecret}` },
  };
}
const png = makePng(32, 16);
const wav = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4),
  Buffer.from("WAVEfmt "),
  Buffer.alloc(60),
]);
async function save(f, user, title) {
  for (const [id, kind, bytes, mimeType] of [
    ["photo", "photo", png, "image/png"],
    ["original", "photo", png, "image/png"],
    ["voice", "audio", wav, "audio/wav"],
    ["unrelated", "photo", png, "image/png"],
  ])
    await f.ok(
      "PUT",
      `/v1/moment-media/${id}`,
      {
        kind,
        name: id,
        mimeType,
        dataBase64: bytes.toString("base64"),
        ...(id === "photo" ? { createPreview: true } : {}),
      },
      user.headers,
    );
  const moment = {
    id: "same-id",
    title,
    status: "active",
    createdAt: "2026-09-07T00:00:00Z",
    updatedAt: "2026-09-07T00:00:00Z",
    photos: [
      {
        id: "p",
        mediaId: "photo",
        originalMediaId: "original",
        url: "/v1/moment-media/photo",
      },
    ],
    messages: [
      {
        id: "msg",
        role: "user",
        text: `private-conversation-${title}`,
        createdAt: "2026-09-07T00:00:00Z",
        audio: {
          mediaId: "voice",
          url: "/v1/moment-media/voice",
          duration: 1,
          waveform: [0.1],
        },
      },
    ],
  };
  await f.ok(
    "PUT",
    "/v1/moments/same-id",
    { expectedVersion: 0, moment },
    user.headers,
  );
}
test("administrator emails recover only verified current envelopes, null versus unavailable is explicit, and mutations do not cache plaintext emails", async () => {
  const f = fixture();
  try {
    const admin = await seed(f, "operator", true),
      none = await seed(f, "no-email"),
      email = "complete-identity@example.test",
      otp = await f.login(email);
    const path = `/v1/admin/accounts/${otp.accountId}`;
    assert.equal((await f.call("GET", path)).status, 401);
    assert.equal((await f.call("GET", path, {}, none.headers)).status, 403);
    const value = (await f.ok("GET", path, {}, admin.headers)).account;
    assert.equal(value.email, email);
    assert.equal(value.loginLabel, email);
    assert.equal(value.emails[0].verifiedAt, f.clock.iso());
    assert.equal(value.emailUnavailable, false);
    const noEmail = (
      await f.ok(
        "GET",
        `/v1/admin/accounts/${none.accountId}`,
        {},
        admin.headers,
      )
    ).account;
    assert.equal(noEmail.email, null);
    assert.deepEqual(noEmail.emails, []);
    assert.equal(noEmail.emailUnavailable, false);
    assert.equal(
      (await f.ok("GET", `/v1/admin/accounts?q=${email}`, {}, admin.headers))
        .total,
      1,
    );
    const changed = await f.ok(
      "POST",
      path + "/status",
      {
        status: "disabled",
        reason: "审核期间暂停",
        expectedVersion: value.version,
      },
      admin.headers,
    );
    assert.equal(changed.account.email, email);
    assert.ok(
      !JSON.stringify(
        f.db.prepare("SELECT response_ref FROM idempotency_records").all(),
      ).includes(email),
    );
    assert.ok(
      !JSON.stringify(
        f.db.prepare("SELECT * FROM administration_audit").all(),
      ).includes(email),
    );
    const eq = f.db
      .prepare(
        "SELECT identifier_equivalence_id id FROM account_verified_identifiers WHERE account_id=?",
      )
      .get(otp.accountId).id;
    f.db
      .prepare(
        "UPDATE identifier_equivalences SET normalized_identifier_ciphertext=? WHERE id=?",
      )
      .run("unrecoverable", eq);
    const unavailable = (await f.ok("GET", path, {}, admin.headers)).account;
    assert.equal(unavailable.email, null);
    assert.equal(unavailable.emailUnavailable, true);
    assert.deepEqual(unavailable.emails, []);
    assert.equal(unavailable.loginLabel, otp.accountId);
    f.db
      .prepare(
        "UPDATE account_verified_identifiers SET status='revoked' WHERE account_id=?",
      )
      .run(otp.accountId);
    assert.equal(
      (await f.ok("GET", path, {}, admin.headers)).account.emailUnavailable,
      false,
    );
  } finally {
    f.close();
  }
});
test("private inspection scopes owner, moment and media; audits reads without publishing or modifying; revocation closes every route", async () => {
  const f = fixture();
  try {
    const admin = await seed(f, "operator", true),
      second = await seed(f, "second-admin", true),
      owner = await seed(f, "owner"),
      other = await seed(f, "other");
    await save(f, owner, "owner-title");
    await save(f, other, "other-title");
    const base = `/v1/admin/accounts/${owner.accountId}/moments`,
      detail = base + "/same-id",
      photo = detail + "/media/photo",
      voice = detail + "/media/voice";
    const before = f.db
      .prepare("SELECT * FROM personal_memories ORDER BY account_id,id")
      .all();
    for (const route of [base, detail, photo]) {
      assert.equal((await f.call("GET", route)).status, 401);
      assert.equal((await f.call("GET", route, {}, owner.headers)).status, 403);
    }
    const list = await f.call(
      "GET",
      base + "?page=1&pageSize=1",
      {},
      admin.headers,
    );
    assert.equal(list.headers["cache-control"], "no-store, private");
    assert.equal(list.body.total, 1);
    assert.equal(list.body.moments[0].hasAudio, true);
    assert.equal(list.body.moments[0].messageCount, 1);
    assert.equal(list.body.moments[0].photoCount, 1);
    const result = await f.ok("GET", detail, {}, admin.headers);
    assert.equal(result.targetAccountId, owner.accountId);
    assert.equal(result.accountId, undefined);
    assert.equal(result.moment.title, "owner-title");
    assert.equal(result.moment.photos[0].url, photo);
    assert.equal(
      result.moment.photos[0].originalUrl,
      detail + "/media/original",
    );
    assert.equal(result.moment.messages[0].audio.url, voice);
    assert.equal(
      (
        await f.ok(
          "GET",
          `/v1/admin/accounts/${other.accountId}/moments/same-id`,
          {},
          admin.headers,
        )
      ).moment.title,
      "other-title",
    );
    assert.deepEqual((await f.call("GET", photo, {}, admin.headers)).body, png);
    assert.deepEqual(
      (await f.call("GET", detail + "/media/original", {}, admin.headers)).body,
      png,
    );
    const preview = await f.call("GET", photo + "/preview", {}, admin.headers);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers["content-type"], "image/jpeg");
    assert.deepEqual(
      preview.body,
      (await f.call("GET", "/v1/moment-media/photo/preview", {}, owner.headers))
        .body,
    );
    const ranged = await f.call(
      "GET",
      voice,
      {},
      { ...admin.headers, range: "bytes=0-7" },
    );
    assert.equal(ranged.status, 206);
    assert.deepEqual(ranged.body, wav.subarray(0, 8));
    assert.equal(ranged.headers["cache-control"], "no-store, private");
    for (const route of [
      base + "/missing/media/photo",
      detail + "/media/unrelated",
      detail + "/media/absent",
    ])
      assert.equal((await f.call("GET", route, {}, admin.headers)).status, 404);
    assert.deepEqual(
      f.db
        .prepare("SELECT * FROM personal_memories ORDER BY account_id,id")
        .all(),
      before,
    );
    assert.equal(
      f.db.prepare("SELECT COUNT(*) n FROM moment_submissions").get().n,
      0,
    );
    assert.deepEqual((await f.ok("GET", "/v1/public/moments")).moments, []);
    const audit = f.db
      .prepare(
        "SELECT * FROM administration_audit WHERE action LIKE 'admin_private_%'",
      )
      .all();
    assert.ok(
      audit.some(
        (a) =>
          a.action === "admin_private_media_read" &&
          a.target_id === `${owner.accountId}/same-id/voice`,
      ),
    );
    assert.ok(
      audit.every(
        (a) =>
          a.actor_id === admin.accountId &&
          a.created_at &&
          a.reason === "管理员授权查阅",
      ),
    );
    assert.ok(!JSON.stringify(audit).includes("private-conversation"));
    assert.ok(!JSON.stringify(audit).includes("owner-title"));
    assert.ok(!JSON.stringify(audit).includes(password));
    await f.ok(
      "POST",
      `/v1/admin/accounts/${owner.accountId}/status`,
      { status: "disabled", reason: "暂停", expectedVersion: 1 },
      admin.headers,
    );
    assert.equal((await f.call("GET", detail, {}, admin.headers)).status, 200);
    f.db
      .prepare(
        "UPDATE personal_memories SET deleted_at=? WHERE account_id=? AND id='moment-media:photo'",
      )
      .run(f.clock.iso(), owner.accountId);
    assert.equal((await f.call("GET", photo, {}, admin.headers)).status, 404);
    f.db
      .prepare(
        "UPDATE personal_memories SET deleted_at=? WHERE account_id=? AND id='moment:same-id'",
      )
      .run(f.clock.iso(), owner.accountId);
    assert.equal((await f.call("GET", detail, {}, admin.headers)).status, 404);
    assert.equal((await f.ok("GET", base, {}, admin.headers)).total, 0);
    f.db
      .prepare("UPDATE accounts SET status='deleting' WHERE id=?")
      .run(owner.accountId);
    assert.equal((await f.call("GET", base, {}, admin.headers)).status, 404);
    f.db.prepare("UPDATE account_administration SET admin_role='admin' WHERE account_id=?").run(admin.accountId);
    await f.ok(
      "POST",
      `/v1/admin/accounts/${admin.accountId}/status`,
      { status: "disabled", reason: "撤销审阅权限", expectedVersion: 1 },
      second.headers,
    );
    for (const route of [base, detail, voice])
      assert.equal((await f.call("GET", route, {}, admin.headers)).status, 401);
    f.db
      .prepare("UPDATE accounts SET status='deleted' WHERE id=?")
      .run(second.accountId);
    assert.equal(
      (
        await f.call(
          "GET",
          `/v1/admin/accounts/${other.accountId}/moments`,
          {},
          second.headers,
        )
      ).status,
      401,
    );
  } finally {
    f.close();
  }
});
