import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixture-factory.mjs";

test("explicit account snapshots preserve full content across sessions, isolate accounts and recover trash", async () => {
  const f = fixture();
  try {
    const a = await f.login("memory@example.test");
    const b = await f.login("other@example.test");
    const document = { id: "local_1", title: "原话", photos: [{ src: "data:image/png;base64,AQID", date: "2020-01-01" }], turns: [{ answer: "我的经历" }], collection: "家庭" };
    const path = "/v1/me/memories/local_1";
    const headers = { ...a.headers, "if-match": "0", "idempotency-key": "memory-create-unique" };
    assert.equal((await f.call("POST", path, { document }, headers)).status, 400);
    const saved = await f.ok("POST", path, { consent: true, document }, headers);
    assert.equal(saved.version, 1);
    assert.equal((await f.ok("POST", path, { consent: true, document }, headers)).replayed, true);
    assert.equal((await f.call("POST", path, { consent: true, document }, { ...a.headers, "if-match": "0" })).status, 409);
    assert.equal((await f.call("GET", path, {}, b.headers)).status, 404);
    assert.equal((await f.call("GET", path)).status, 401);
    assert.deepEqual((await f.ok("GET", "/v1/me/memories", {}, b.headers)).memories, []);
    const second = await f.login("memory@example.test");
    assert.deepEqual((await f.ok("GET", path, {}, second.headers)).document, document);
    const stored = f.db.prepare("SELECT * FROM personal_memories").get();
    assert.ok(!stored.document_ciphertext.includes("我的经历"));
    const list = await f.ok("GET", "/v1/me/memories", {}, a.headers);
    assert.equal(list.memories.length, 1);
    assert.equal(list.memories[0].document, undefined);
    const trash = await f.ok("POST", `${path}/trash`, {}, { ...a.headers, "if-match": "1" });
    assert.ok(trash.deletedAt);
    assert.equal((await f.call("POST", path, { document, consent: true }, { ...a.headers, "if-match": "2" })).status, 409);
    const restored = await f.ok("POST", `${path}/restore`, {}, { ...second.headers, "if-match": "2" });
    assert.equal(restored.deletedAt, null);
    assert.deepEqual((await f.ok("GET", path, {}, second.headers)).document, document);
    await f.ok("POST", "/v1/auth/logout", {}, second.headers);
    assert.equal((await f.call("GET", path, {}, second.headers)).status, 401);
  } finally { f.close(); }
});

test("snapshot storage admits a bounded record and rejects malformed IDs and account quota overflow", async () => {
  const f = fixture();
  try {
    const a = await f.login();
    assert.equal((await f.call("POST", "/v1/me/memories/bad%20id", { consent: true, document: {} }, { ...a.headers, "if-match": "0" })).status, 400);
    const created = await f.ok("POST", "/v1/me/memories/a", { consent: true, document: { title: "x" } }, { ...a.headers, "if-match": "0" });
    assert.equal(created.version, 1);
    f.db.prepare("UPDATE personal_memories SET byte_length=?").run(128 * 1024 * 1024);
    assert.equal((await f.call("POST", "/v1/me/memories/b", { consent: true, document: { title: "y" } }, { ...a.headers, "if-match": "0" })).status, 413);
  } finally { f.close(); }
});

test("real HTTP cookie sessions sync a >1MiB document and reject cookie CSRF", async () => {
  const { createLocalHttpServer, listenLocalHttpServer } = await import("../src/http-server.mjs");
  const f = fixture();
  const server = createLocalHttpServer({ api: f.api });
  const { origin } = await listenLocalHttpServer(server, { host: "127.0.0.1", port: 0 });
  f.api.campaigns.publicOrigin = origin;
  const call = async (path, body, cookie = "", extra = {}) => {
    const response = await fetch(origin + path, { method: body ? "POST" : "GET", headers: {
      "content-type": "application/json", "idempotency-key": crypto.randomUUID(),
      ...(cookie ? { cookie } : {}), origin, "sec-fetch-site": "same-origin", ...extra
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, cookie: response.headers.get("set-cookie")?.split(";")[0], body: await response.json() };
  };
  const login = async (email = "http-memory@example.test") => {
    const challenge = await call("/v1/auth/email-otp-challenges", { email, purpose: "login" });
    const otp = f.otp.findLast(x => x.challengeId === challenge.body.challengeId).code;
    return call("/v1/auth/email-otp-verifications", { challengeId: challenge.body.challengeId, otp, purpose: "login" });
  };
  try {
    const a = await login(); const b = await login();
    assert.ok(a.cookie.startsWith("__Host-unseen_account="));
    const memoryId = "memory:550e8400-e29b-41d4-a716-446655440000";
    const path = `/v1/me/memories/${encodeURIComponent(memoryId)}`;
    const document = { title: "账号 A 的真实标题", photos: [{ src: "data:image/jpeg;base64," + "A".repeat(1024 * 1024 + 40) }], turns: [{ answer: "保留我的原话" }] };
    const saved = await call(path, { consent: true, document }, a.cookie, { "if-match": "0" });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const accountA = (await call("/v1/me", null, a.cookie)).body.accountId;
    const other = await login("http-memory-other@example.test");
    const accountB = (await call("/v1/me", null, other.cookie)).body.accountId;
    assert.notEqual(accountA, accountB);
    const expectedA = { "if-match": "0", "x-unseen-expected-account-id": accountA };
    const rejected = await call(path, { consent: true, document }, other.cookie, expectedA);
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error.code, "account_changed");
    assert.deepEqual((await call("/v1/me/memories", null, other.cookie)).body.memories, []);
    const correctB = await call(path, { consent: true, document: { title: "B's own record" } }, other.cookie,
      { "if-match": "0", "x-unseen-expected-account-id": accountB });
    assert.equal(correctB.status, 200);
    const updateRejected = await call(path, { consent: true, document }, other.cookie,
      { "if-match": "1", "x-unseen-expected-account-id": accountA });
    assert.equal(updateRejected.body.error.code, "account_changed");
    const trashRejected = await call(path + "/trash", {}, other.cookie,
      { "if-match": "1", "x-unseen-expected-account-id": accountA });
    assert.equal(trashRejected.body.error.code, "account_changed");
    const otherRead = await call(path, null, other.cookie);
    assert.equal(otherRead.body.document.title, "B's own record");
    assert.equal(otherRead.body.accountId, accountB);
    const listA = (await call("/v1/me/memories", null, a.cookie)).body;
    const listB = (await call("/v1/me/memories", null, other.cookie)).body;
    assert.equal(listA.memories[0].title, document.title);
    assert.equal(listA.memories[0].photoCount, 1);
    assert.ok(listA.memories[0].createdAt);
    assert.equal(listB.memories[0].title, "B's own record");
    assert.equal(listB.memories[0].photoCount, 0);
    assert.ok(JSON.stringify(listA).length < 1000);
    assert.ok(!JSON.stringify(listA).includes("data:image") && !JSON.stringify(listA).includes("保留我的原话"));
    assert.equal(listA.memories[0].document, undefined);
    const encryptedA = f.db.prepare("SELECT * FROM personal_memories WHERE account_id=? AND id=?").get(accountA, memoryId);
    assert.ok(!JSON.stringify(encryptedA).includes(document.title));
    assert.ok(!Object.hasOwn(encryptedA, "title"));

    assert.equal((await call(path, { consent: true, document }, "", expectedA)).status, 401,
      "expected account is never an identity credential");
    const restored = await call(path, null, b.cookie);
    assert.deepEqual(restored.body.document, document);
    assert.equal(restored.body.accountId, accountA);
    assert.equal(restored.body.id, memoryId);
    const updated = await call(path, { consent: true, document: { ...document, title: "Colon ID preserved" } }, a.cookie,
      { "if-match": "1", "x-unseen-expected-account-id": accountA });
    assert.equal(updated.status, 200); assert.equal(updated.body.id, memoryId);
    const trashed = await call(path + "/trash", {}, a.cookie,
      { "if-match": "2", "x-unseen-expected-account-id": accountA });
    assert.equal(trashed.status, 200); assert.equal(trashed.body.id, memoryId);
    const recovered = await call(path + "/restore", {}, a.cookie,
      { "if-match": "3", "x-unseen-expected-account-id": accountA });
    assert.equal(recovered.status, 200); assert.equal(recovered.body.id, memoryId);
    assert.equal((await call(path, null, b.cookie)).body.document.title, "Colon ID preserved");
    const legacyId = "legacy:photo_1";
    assert.equal((await call(`/v1/me/memories/${encodeURIComponent(legacyId)}`,
      { consent: true, document: { id: legacyId } }, a.cookie, { "if-match": "0" })).body.id, legacyId);
    assert.equal((await call(path + "/trash", {}, a.cookie, { origin: "https://foreign.test", "if-match": "1" })).status, 403);
    assert.equal((await call(path, { consent: true, document: {} }, "", { "if-match": "0" })).status, 401);
    await call("/v1/auth/logout", {}, b.cookie);
    assert.equal((await call(path, null, b.cookie)).status, 401);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.close(); }
});
