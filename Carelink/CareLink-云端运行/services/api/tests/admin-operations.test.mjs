import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, png, mp4, createAccountUpload } from "./fixture-factory.mjs";
async function admin(f, email) {
  const a = await f.login(email);
  f.db
    .prepare("UPDATE account_administration SET is_admin=1,admin_role='super_admin' WHERE account_id=?")
    .run(a.accountId);
  return a;
}
test("role mutations and session revocation are versioned, replay-safe and revoke effective grants immediately", async () => {
  const f = fixture();
  try {
    const a = await admin(f, "admin@example.test"),
      u = await f.login("member@example.test"),
      base = `/v1/admin/accounts/${u.accountId}`;
    const initialAdmins = await f.ok("GET", "/v1/admin/accounts?role=administrators", {}, a.headers);
    assert.deepEqual(initialAdmins.accounts.map((x) => x.id), [a.accountId]);
    const req = { isAdmin: true, expectedVersion: 1, reason: "授权管理" },
      key = randomUUID();
    assert.equal((await f.call("POST", base + "/role", req)).status, 401);
    assert.equal(
      (await f.call("POST", base + "/role", req, u.headers)).status,
      403,
    );
    let granted = await f.ok("POST", base + "/role", req, {
      ...a.headers,
      "idempotency-key": key,
    });
    assert.equal(granted.account.isAdmin, true);
    assert.equal(granted.account.version, 2);
    const allAdmins = await f.ok("GET", "/v1/admin/accounts?role=administrators", {}, a.headers);
    assert.equal(allAdmins.total, 2);
    assert.deepEqual(new Set(allAdmins.accounts.map((x) => x.id)), new Set([a.accountId, u.accountId]));
    const adminPage = await f.ok("GET", "/v1/admin/accounts?role=administrators&pageSize=1&page=2", {}, a.headers);
    assert.equal(adminPage.total, 2);
    assert.equal(adminPage.accounts.length, 1);
    assert.equal(
      (await f.call("GET", "/v1/admin/overview", {}, u.headers)).status,
      401,
    );
    const replay = await f.ok("POST", base + "/role", req, {
      ...a.headers,
      "idempotency-key": key,
    });
    assert.equal(replay.account.version, 2);
    assert.equal(replay.replayed, true);
    const renewed = await f.login("member@example.test");
    assert.equal(
      (await f.call("GET", "/v1/admin/overview", {}, renewed.headers)).status,
      200,
    );
    assert.equal(
      (
        await f.call(
          "POST",
          `/v1/admin/accounts/${a.accountId}/role`,
          { ...req, isAdmin: false },
          a.headers,
        )
      ).body.error.code,
      "cannot_change_own_role",
    );
    assert.equal(
      (
        await f.call(
          "POST",
          base + "/role",
          { ...req, isAdmin: false },
          a.headers,
        )
      ).status,
      409,
    );
    const downgraded = await f.ok(
      "POST",
      base + "/role",
      { isAdmin: false, expectedVersion: 2, reason: "交接完成" },
      a.headers,
    );
    assert.equal(downgraded.account.version, 3);
    assert.equal(
      (await f.call("GET", "/v1/admin/overview", {}, renewed.headers)).status,
      401,
    );
    const active = await f.login("member@example.test");
    const sessions = await f.ok("GET", base + "/sessions", {}, a.headers);
    assert.equal(sessions.sessions.filter((s) => s.active).length, 1);
    assert.ok(sessions.sessions.every((s) => s.createdAt && s.expiresAt));
    assert.ok(!JSON.stringify(sessions).includes("credential"));
    assert.ok(!JSON.stringify(sessions).includes(active.token));
    const revokeKey = randomUUID(),
      revokeBody = { expectedVersion: 3, reason: "安全退出" };
    await f.ok("POST", base + "/sessions/revoke", revokeBody, {
      ...a.headers,
      "idempotency-key": revokeKey,
    });
    await f.ok("POST", base + "/sessions/revoke", revokeBody, {
      ...a.headers,
      "idempotency-key": revokeKey,
    });
    assert.equal(
      (await f.call("GET", "/v1/profile", {}, active.headers)).status,
      401,
    );
    assert.equal(
      (
        await f.call(
          "POST",
          base + "/sessions/revoke",
          { expectedVersion: 4, reason: "无会话" },
          a.headers,
        )
      ).body.error.code,
      "active_session_required",
    );
    assert.equal(
      (
        await f.call(
          "POST",
          `/v1/admin/accounts/${a.accountId}/sessions/revoke`,
          { expectedVersion: 1, reason: "自己" },
          a.headers,
        )
      ).body.error.code,
      "cannot_revoke_own_sessions",
    );
    await f.ok(
      "POST",
      base + "/status",
      { status: "disabled", expectedVersion: 4, reason: "暂停" },
      a.headers,
    );
    assert.equal(
      (
        await f.call(
          "POST",
          base + "/role",
          { isAdmin: true, expectedVersion: 5, reason: "禁止提升" },
          a.headers,
        )
      ).body.error.code,
      "account_not_active",
    );
    const changes = await f.ok(
      "GET",
      `/v1/admin/audit?accountId=${u.accountId}&category=mutation`,
      {},
      a.headers,
    );
    assert.equal(
      changes.actions.filter((x) => x.action === "account_role").length,
      2,
    );
    assert.equal(
      changes.actions.filter((x) => x.action === "account_sessions_revoked")
        .length,
      1,
    );
    assert.ok(changes.actions.every((x) => !x.action.startsWith("admin_")));
    const actorFiltered = await f.ok(
      "GET",
      `/v1/admin/audit?actorId=${a.accountId}&action=account_role&dateFrom=2026-08-13&dateTo=2026-08-13`,
      {},
      a.headers,
    );
    assert.equal(actorFiltered.total, 2);
    assert.equal(
      (
        await f.ok(
          "GET",
          "/v1/admin/accounts?role=super_admin&source=email-otp",
          {},
          a.headers,
        )
      ).total,
      1,
    );
    const detail = (await f.ok("GET", base, {}, a.headers)).account.details;
    assert.equal(detail.password.isSet, false);
    assert.equal(detail.password.credentialUpdatedAt, null);
    assert.equal(detail.emailRelationships[0].email, "member@example.test");
    assert.equal(detail.storage.limits.records, 1000);
    assert.equal(detail.profile.hasAvatar, false);
    assert.equal(detail.profile.hasStoredProfile, false);
    const overview = await f.ok("GET", "/v1/admin/overview", {}, a.headers);
    assert.equal(overview.counts.admins, 1);
    assert.equal(overview.counts.registrationsLast7Days, 2);
    assert.equal(overview.counts.lastLoginCollected, 2);
    assert.equal(
      (await f.ok("GET", base + "/submissions", {}, a.headers)).total,
      0,
    );
  } finally {
    f.close();
  }
});
test("owned spatial inspection serves exact import bytes and fails closed if admin or owner changes during async read", async () => {
  const f = fixture();
  try {
    const a = await admin(f, "admin@example.test"),
      owner = await f.login("owner@example.test"),
      other = await f.login("other@example.test");
    const pano = png(1600, 800),
      depth = png(32, 16),
      input = {
        consent: true,
        title: "私有空间",
        panorama: {
          name: "pano.png",
          mimeType: "image/png",
          dataBase64: pano.toString("base64"),
        },
        depth: {
          name: "depth.png",
          mimeType: "image/png",
          dataBase64: depth.toString("base64"),
        },
        metadata: {
          model: "DAP",
          convention: "near_small",
          min: 0.01,
          max: 0.19,
          width: 32,
          height: 16,
          source_image: "pano.png",
          source_resolution: [1600, 800],
        },
      };
    const saved = await f.ok("PUT", "/v1/app-spaces/client-space", input, {
      ...owner.headers,
      "x-unseen-expected-account-id": owner.accountId,
    });
    const sid = saved.space.spaceId,
      base = `/v1/admin/accounts/${owner.accountId}/spaces`,
      route = base + "/" + sid;
    for (const p of [base, route, route + "/media/panorama"]) {
      assert.equal((await f.call("GET", p)).status, 401);
      assert.equal((await f.call("GET", p, {}, owner.headers)).status, 403);
    }
    assert.equal(
      (await f.ok("GET", base, {}, a.headers)).spaces[0].clientId,
      "client-space",
    );
    const dto = await f.ok("GET", route, {}, a.headers);
    assert.equal(dto.space.panorama.available, true);
    assert.equal(dto.space.depth.available, true);
    assert.ok(!JSON.stringify(dto).includes("private_object_key"));
    assert.ok(!JSON.stringify(dto).includes("input_refs"));
    assert.deepEqual(
      (await f.call("GET", route + "/media/panorama", {}, a.headers)).body,
      pano,
    );
    assert.deepEqual(
      (await f.call("GET", route + "/media/depth", {}, a.headers)).body,
      depth,
    );
    assert.equal(
      (
        await f.call(
          "GET",
          `/v1/admin/accounts/${other.accountId}/spaces/${sid}`,
          {},
          a.headers,
        )
      ).status,
      404,
    );
    const original = f.api.mediaStore.get.bind(f.api.mediaStore);
    f.api.mediaStore.get = async (...args) => {
      const value = await original(...args);
      f.db
        .prepare(
          "UPDATE account_administration SET is_admin=0 WHERE account_id=?",
        )
        .run(a.accountId);
      return value;
    };
    assert.equal(
      (await f.call("GET", route + "/media/panorama", {}, a.headers)).status,
      403,
    );
    f.db
      .prepare(
        "UPDATE account_administration SET is_admin=1,admin_role='super_admin' WHERE account_id=?",
      )
      .run(a.accountId);
    f.api.mediaStore.get = async (...args) => {
      const value = await original(...args);
      f.db
        .prepare("UPDATE spaces SET owner_account_id=? WHERE id=?")
        .run(other.accountId, sid);
      return value;
    };
    assert.equal(
      (await f.call("GET", route + "/media/depth", {}, a.headers)).status,
      404,
    );
    f.api.mediaStore.get = original;
    f.db
      .prepare("UPDATE spaces SET owner_account_id=? WHERE id=?")
      .run(owner.accountId, sid);
    await f.ok(
      "POST",
      `/v1/admin/accounts/${owner.accountId}/status`,
      { status: "disabled", expectedVersion: 1, reason: "暂停账号" },
      a.headers,
    );
    assert.equal(
      (await f.call("GET", route + "/media/panorama", {}, a.headers)).status,
      200,
    );
    f.db
      .prepare("UPDATE spaces SET space_lifecycle='archived' WHERE id=?")
      .run(sid);
    assert.equal(
      (await f.ok("GET", route, {}, a.headers)).space.panorama.available,
      false,
    );
    assert.equal(
      (await f.call("GET", route + "/media/panorama", {}, a.headers)).status,
      404,
    );
    // Isolated fixture now exercises canonical space rows without App registration.
    f.db
      .prepare("UPDATE spaces SET space_lifecycle='active' WHERE id=?")
      .run(sid);
    const importRow = f.db
      .prepare("SELECT * FROM app_spatial_imports WHERE space_id=?")
      .get(sid);
    const spaceRow = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(sid);
    f.db.prepare("DELETE FROM app_spatial_imports WHERE space_id=?").run(sid);
    assert.equal(
      (await f.ok("GET", route, {}, a.headers)).space.source,
      "canonical",
    );
    assert.deepEqual(
      (await f.call("GET", route + "/media/panorama", {}, a.headers)).body,
      pano,
    );
    f.db
      .prepare(
        "INSERT INTO scene_depth_artifacts(id,space_id,scene_id,panorama_revision_id,depth_asset_id,artifact_id,near_meters,far_meters,valid_fraction,safety_envelope_json,created_at,updated_at) VALUES('test-depth',?,?,?,?, 'fixture',1,10,1,'{}',?,?) ON CONFLICT(space_id,panorama_revision_id) DO NOTHING",
      )
      .run(
        sid,
        spaceRow.scene_id,
        spaceRow.current_panorama_revision_id,
        importRow.depth_asset_id,
        f.clock.iso(),
        f.clock.iso(),
      );
    assert.deepEqual(
      (await f.call("GET", route + "/media/depth", {}, a.headers)).body,
      depth,
    );
    f.db
      .prepare(
        "INSERT INTO jobs(id,space_id,type,input_refs_json,input_hash,status,stable_error,result_json,created_at,updated_at) VALUES('job-secret',?,'fixture','{\"secret\":\"never-render\"}','hash','failed','provider private error','{\"private\":1}',?,?)",
      )
      .run(sid, f.clock.iso(), f.clock.iso());
    const jobView = await f.ok("GET", route, {}, a.headers);
    assert.equal(jobView.jobs[0].errorCode, "unclassified_error");
    assert.ok(!JSON.stringify(jobView).includes("never-render"));
    assert.ok(!JSON.stringify(jobView).includes("provider private error"));
    assert.equal((await f.ok("GET", "/v1/public/moments")).moments.length, 0);
  } finally {
    f.close();
  }
});

test("administrator avatar follows current profile reference; canonical safe photo/video readers stay scoped and recheck after read", async () => {
  const f = fixture();
  try {
    const a = await admin(f, "admin-media@example.test"),
      owner = await f.login("owner-media@example.test"),
      other = await f.login("other-media@example.test"),
      image = png();
    await f.ok(
      "PUT",
      "/v1/moment-media/avatar",
      {
        kind: "photo",
        name: "avatar.png",
        mimeType: "image/png",
        dataBase64: image.toString("base64"),
        createPreview: true,
      },
      owner.headers,
    );
    await f.ok(
      "PATCH",
      "/v1/profile",
      { avatar: "/v1/moment-media/avatar/preview" },
      owner.headers,
    );
    const accountPath = `/v1/admin/accounts/${owner.accountId}`;
    const profile = (await f.ok("GET", accountPath, {}, a.headers)).account
      .details.profile;
    assert.equal(profile.avatarUrl, accountPath + "/avatar/preview");
    assert.equal(profile.avatarAvailable, true);
    assert.equal((await f.call("GET", profile.avatarUrl)).status, 401);
    assert.equal(
      (await f.call("GET", profile.avatarUrl, {}, owner.headers)).status,
      403,
    );
    assert.deepEqual(
      (await f.call("GET", profile.avatarUrl, {}, a.headers)).body,
      (
        await f.call(
          "GET",
          "/v1/moment-media/avatar/preview",
          {},
          owner.headers,
        )
      ).body,
    );
    assert.equal(
      (await f.call("GET", accountPath + "/avatar", {}, a.headers)).status,
      404,
    );
    await f.ok("PATCH", "/v1/profile", { avatar: null }, owner.headers);
    assert.equal(
      (await f.call("GET", profile.avatarUrl, {}, a.headers)).status,
      404,
    );
    const space = await f.openSpace(
      owner,
      await f.createSpace(owner, "Canonical media"),
    );
    const uploaded = await createAccountUpload(f, owner, space, image);
    const videoUpload = await createAccountUpload(
      f,
      owner,
      space,
      mp4(),
      "video/mp4",
    );
    const base = `${accountPath}/spaces/${space.spaceId}/photos`;
    const list = await f.ok("GET", base, {}, a.headers);
    assert.equal(list.total, 2);
    assert.ok(
      list.photos.every((p) => p.preview.available && p.createdAt === null),
    );
    const video = list.photos.find((p) => p.mediaType === "video"),
      photo = list.photos.find((p) => p.mediaType === "photo");
    assert.ok(video.video.available);
    assert.equal(photo.video.available, false);
    const playable = await f.call(
      "GET",
      video.video.url,
      {},
      { ...a.headers, range: "bytes=0-7" },
    );
    assert.equal(playable.status, 206);
    assert.equal(playable.body.length, 8);
    assert.equal(
      (await f.call("GET", photo.preview.url, {}, owner.headers)).status,
      403,
    );
    assert.equal(
      (
        await f.call(
          "GET",
          photo.preview.url.replace(owner.accountId, other.accountId),
          {},
          a.headers,
        )
      ).status,
      404,
    );
    const oldGet = f.api.mediaStore.get.bind(f.api.mediaStore);
    f.api.mediaStore.get = async (...args) => {
      const value = await oldGet(...args);
      f.db
        .prepare("UPDATE photos SET deleted_at=? WHERE id=?")
        .run(f.clock.iso(), photo.id);
      return value;
    };
    assert.equal(
      (await f.call("GET", photo.preview.url, {}, a.headers)).status,
      404,
    );
    f.api.mediaStore.get = oldGet;
    assert.equal((await f.ok("GET", base, {}, a.headers)).total, 1);
  } finally {
    f.close();
  }
});
