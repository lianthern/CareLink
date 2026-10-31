import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { stableJson } from "../src/util.mjs";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fixture, png } from "./fixture-factory.mjs";
import { createPasswordAccount } from "../src/password-account-service.mjs";
import { LocalApi } from "../src/api.mjs";
import { LocalKeyring } from "../src/crypto.mjs";
import { FilesystemMediaStore } from "../src/ports/media/filesystem-media-store.mjs";
import { createLocalHttpServer, listenLocalHttpServer } from "../src/http-server.mjs";

const password = "test-passphrase-2026";
const audio = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt "), Buffer.alloc(60)]);
const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3m8AAAAASUVORK5CYII=", "base64");
async function account(f, username = "unseen") {
  await createPasswordAccount(f.api.core, { username, password });
  return login(f, username);
}
async function login(f, username = "unseen", suppliedPassword = password, headers = {}) {
  const result = await f.ok("POST", "/v1/auth/password-login", { username, password: suppliedPassword }, headers);
  return { ...result, headers: { authorization: `Bearer ${result.accountSessionSecret}`,
    "x-unseen-expected-account-id": result.accountId } };
}
const moment = (id = "memory-1") => ({ id, title: "属于我们的下午", createdAt: "2026-09-05T00:00:00Z",
  updatedAt: "2026-09-05T00:00:00Z", status: "active", photos: [], messages: [], context: {}, preferences: { photoMode: "reveal" } });
const upload = (f, a, id, kind = "photo", bytes = tinyPng, extra = {}) => f.ok("PUT", `/v1/moment-media/${id}`,
  { kind, name: kind === "photo" ? "照片.png" : "我的原声.wav", mimeType: kind === "photo" ? "image/png" : "audio/wav",
    dataBase64: bytes.toString("base64"), ...extra }, a.headers);

test("empty password account coexists with OTP, rotates sessions, persists profile and revokes all devices after password change", async () => {
  const f = fixture();
  try {
    const a = await account(f);
    assert.equal(a.user.username, "unseen");
    assert.deepEqual((await f.ok("GET", "/v1/moments", {}, a.headers)).moments, []);
    assert.equal((await f.ok("GET", "/v1/me", {}, a.headers)).accountId, a.accountId);
    const b = await login(f, " UNSEEN ");
    assert.equal(b.accountId, a.accountId);
    assert.notEqual(b.accountSessionSecret, a.accountSessionSecret);
    await f.ok("PATCH", "/v1/profile", { displayName: "回忆主人", preferences: { photoMode: "clear" } }, a.headers);
    const profile = await f.ok("GET", "/v1/profile", {}, b.headers);
    assert.equal(profile.user.displayName, "回忆主人");
    assert.equal(profile.user.preferences.photoMode, "clear");
    assert.equal(profile.version, 1);
    const stale = await f.call("PATCH", "/v1/profile", { displayName: "旧设备写入", expectedVersion: 0 }, b.headers);
    assert.equal(stale.status, 409);
    const pkey = randomUUID(), patch = { displayName: "第一次写入", expectedVersion: 1 };
    assert.equal((await f.ok("PATCH", "/v1/profile", patch, { ...a.headers, "idempotency-key": pkey })).version, 2);
    assert.equal((await f.ok("PATCH", "/v1/profile", patch, { ...a.headers, "idempotency-key": pkey })).replayed, true);
    const rotated = await login(f, "unseen", password, a.headers);
    assert.equal((await f.call("GET", "/v1/me", {}, a.headers)).status, 401);
    assert.equal((await f.call("GET", "/v1/me", {}, b.headers)).status, 200);
    const nextPassword = randomUUID();
    const changed = await f.ok("POST", "/v1/auth/password-change", { currentPassword: password, newPassword: nextPassword }, rotated.headers);
    for (const device of [b, rotated]) assert.equal((await f.call("GET", "/v1/me", {}, device.headers)).status, 401);
    assert.equal((await f.call("GET", "/v1/me", {}, { authorization: `Bearer ${changed.accountSessionSecret}` })).status, 200);
    assert.equal((await f.call("POST", "/v1/auth/password-login", { username: "unseen", password })).status, 401);
    const newLogin = await login(f, "unseen", nextPassword);
    assert.equal(newLogin.accountId, a.accountId);
    const otp = await f.login("otp-still-works@example.test");
    assert.equal((await f.ok("GET", "/v1/profile", {}, otp.headers)).user.username, null);
    assert.equal((await f.ok("GET", "/v1/me", {}, otp.headers)).accountId, otp.accountId);
    const stored = f.db.prepare("SELECT password_hash FROM account_password_credentials").get().password_hash;
    assert.match(stored, /^scrypt-v1\$/);
    assert.ok(!stored.includes(password));
    const idempotency = f.db.prepare("SELECT response_ref FROM idempotency_records").all();
    assert.ok(!JSON.stringify(idempotency).includes("回忆主人"));
    assert.ok(!JSON.stringify(idempotency).includes(nextPassword));
  } finally { f.close(); }
});

test("login rate limits persist failed attempts, do not enumerate accounts, and seed never overwrites", async () => {
  const f = fixture();
  try {
    await account(f);
    await assert.rejects(createPasswordAccount(f.api.core, { username: "unseen", password: "overwrite-attempt" }), e => e.code === "username_already_exists");
    assert.equal((await f.call("POST", "/v1/auth/password-login", { username: "unknown", password: "incorrect" })).status, 401);
    for (let n = 0; n < 9; n++) assert.equal((await f.call("POST", "/v1/auth/password-login", { username: "unseen", password: "incorrect" },
      { "idempotency-key": "fixed-failure-attempt" })).status, 401);
    assert.equal((await f.call("POST", "/v1/auth/password-login", { username: "unseen", password })).status, 429);
    f.clock.advance(600001);
    assert.equal((await login(f)).user.username, "unseen");
  } finally { f.close(); }
});

test("moments preserve long raw history and original media, isolate accounts, normalize private URLs and reject stale versions", async () => {
  const f = fixture();
  try {
    const a = await account(f), b = await account(f, "other-user");
    const key = randomUUID();
    const photoBody = { kind: "photo", name: "照片.png", mimeType: "image/png", dataBase64: tinyPng.toString("base64") };
    const photo = await f.ok("PUT", "/v1/moment-media/p1", photoBody, { ...a.headers, "idempotency-key": key });
    assert.equal(photo.media.url, "/v1/moment-media/p1");
    assert.deepEqual((await f.ok("PUT", "/v1/moment-media/p1", photoBody, { ...a.headers, "idempotency-key": key })).media, photo.media);
    assert.deepEqual((await f.ok("PUT", "/v1/moment-media/p1", photoBody, a.headers)).media, photo.media);
    const speech = await upload(f, a, "voice-1", "audio", audio);
    const value = moment();
    value.photos = [{ id: "p1", name: "照片.png", mediaId: "p1", url: "https://untrusted.example/a.png", originalMediaId: "p1" }];
    value.messages = Array.from({ length: 600 }, (_, n) => ({ id: `message-${n}`, role: n % 2 ? "assistant" : "user",
      text: `${n}:完整原话不裁剪。` + "生活里的细节".repeat(80), photoId: "p1", createdAt: value.createdAt }));
    value.messages[0].audio = { mediaId: "voice-1", url: speech.media.url, duration: 2.4, waveform: [0,0.4,1,0.1] };
    value.context = { summary: "历史摘要与完整历史并存", throughMessageId: "message-400", model: "replaceable" };
    const saved = await f.ok("PUT", "/v1/moments/memory-1", { expectedVersion: 0, moment: value }, a.headers);
    assert.equal(saved.version, 1);
    assert.equal(saved.moment.messages.length, 600);
    assert.equal(saved.moment.photos[0].url, photo.media.url);
    assert.equal(saved.moment.photos[0].originalUrl, photo.media.url);
    const second = await login(f);
    assert.deepEqual((await f.ok("GET", "/v1/moments/memory-1", {}, second.headers)).moment, saved.moment);
    assert.equal((await f.call("GET", "/v1/moments/memory-1", {}, b.headers)).status, 404);
    assert.equal((await f.call("GET", "/v1/moment-media/voice-1", {}, b.headers)).status, 404);
    assert.equal((await f.call("GET", "/v1/moment-media/voice-1")).status, 401);
    assert.deepEqual((await f.call("GET", "/v1/moment-media/voice-1", {}, a.headers)).body, audio);
    const range = await f.call("GET", "/v1/moment-media/voice-1", {}, { ...a.headers, range: "bytes=4-9" });
    assert.equal(range.status, 206); assert.deepEqual(range.body, audio.subarray(4,10));
    assert.equal(range.headers["content-range"], `bytes 4-9/${audio.length}`);
    assert.equal((await f.call("GET", "/v1/moment-media/voice-1", {}, { ...a.headers, range: "bytes=999999-" })).status, 416);
    const otherMoment = { ...saved.moment, id: "other" };
    assert.equal((await f.call("PUT", "/v1/moments/other", { expectedVersion: 0, moment: otherMoment }, b.headers)).status, 404);
    assert.equal((await f.call("PUT", "/v1/moments/memory-1", { expectedVersion: 0, moment: value }, a.headers)).status, 409);
    const updates = await Promise.all([a,second].map(device => f.call("PUT", "/v1/moments/memory-1", {
      expectedVersion: 1, moment: { ...saved.moment, status: "complete" } }, device.headers)));
    assert.deepEqual(updates.map(x => x.status).sort(), [200,409]);
    const list = await f.ok("GET", "/v1/moments", {}, second.headers);
    assert.equal(list.moments[0].messageCount, 600);
    assert.ok(JSON.stringify(list).length < 1000);
    assert.deepEqual((await f.ok("GET", "/v1/me/memories", {}, a.headers)).memories, []);
    const dbDump = JSON.stringify(f.db.prepare("SELECT * FROM personal_memories").all());
    assert.ok(!dbDump.includes("完整原话") && !dbDump.includes(audio.toString("base64")));
    const idemDump = JSON.stringify(f.db.prepare("SELECT response_ref FROM idempotency_records").all());
    assert.ok(!idemDump.includes("完整原话") && !idemDump.includes(audio.toString("base64")));
    assert.equal((await f.call("PUT", "/v1/moments/wrong", { expectedVersion: 0, moment: moment("wrong") },
      { ...b.headers, "x-unseen-expected-account-id": a.accountId })).status, 409);
    assert.deepEqual((await f.ok("GET", "/v1/moments", {}, b.headers)).moments, []);
    assert.equal((await f.call("PUT", "/v1/moment-media/bad", { ...photoBody, dataBase64: Buffer.from("<script>bad</script>").toString("base64") }, a.headers)).status, 415);
    assert.equal((await f.call("PUT", "/v1/moment-media/big", { ...photoBody, dataBase64: "A".repeat(16 * 1024 * 1024 + 4) }, a.headers)).status, 413);
  } finally { f.close(); }
});

test("bounded canonical decoder creates an authenticated JPEG preview without replacing the uploaded original", async () => {
  const f = fixture();
  try {
    const a = await account(f), bytes = png(48, 32);
    const uploaded = await upload(f, a, "with-preview", "photo", bytes, { createPreview: true });
    assert.equal(uploaded.media.previewUrl, "/v1/moment-media/with-preview/preview");
    assert.equal(uploaded.media.width, 48);
    assert.deepEqual((await f.call("GET", uploaded.media.url, {}, a.headers)).body, bytes);
    const preview = await f.call("GET", uploaded.media.previewUrl, {}, a.headers);
    assert.equal(preview.headers["content-type"], "image/jpeg");
    assert.equal(preview.body[0], 255); assert.equal(preview.body[1], 216);
    assert.equal((await f.call("GET", uploaded.media.previewUrl)).status, 401);
    const value = moment(); value.photos.push({ id: "p", mediaId: uploaded.media.id, url: uploaded.media.previewUrl });
    const saved = await f.ok("PUT", "/v1/moments/memory-1", { expectedVersion: 0, moment: value }, a.headers);
    assert.equal(saved.moment.photos[0].url, uploaded.media.previewUrl);
  } finally { f.close(); }
});

test("HTTP password cookies never expose secrets and protect login/profile/media from CSRF", async () => {
  const f = fixture();
  await createPasswordAccount(f.api.core, { username: "unseen", password });
  const server = createLocalHttpServer({ api: f.api });
  const { origin } = await listenLocalHttpServer(server, { host: "127.0.0.1", port: 0 });
  f.api.campaigns.publicOrigin = origin;
  const request = async (method, route, body, headers = {}) => {
    const result = await fetch(origin + route, { method, headers: { "content-type": "application/json",
      origin, "sec-fetch-site": "same-origin", "idempotency-key": randomUUID(), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: result.status, headers: result.headers, body: await result.json() };
  };
  try {
    const rejected = await request("POST", "/v1/auth/password-login", { username: "unseen", password },
      { origin: "https://foreign.test", "sec-fetch-site": "cross-site" });
    assert.equal(rejected.status, 403);
    const signed = await request("POST", "/v1/auth/password-login", { username: "unseen", password });
    const setCookie = signed.headers.get("set-cookie"), cookie = setCookie.split(";")[0];
    assert.match(setCookie, /HttpOnly; Secure; SameSite=Strict/);
    assert.equal(signed.body.accountSessionSecret, undefined);
    assert.equal((await request("GET", "/v1/profile", null, { cookie })).body.user.username, "unseen");
    assert.equal((await request("PATCH", "/v1/profile", { displayName: "坏来源" }, { cookie, origin: "https://foreign.test" })).status, 403);
    const value = moment();
    value.messages = [{ id: "large-message", role: "user", text: "原话".repeat(190000), createdAt: value.createdAt }];
    const saved = await request("PUT", "/v1/moments/memory-1", { expectedVersion: 0, moment: value }, { cookie });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal((await request("PUT", "/v1/moments/unauth", { expectedVersion: 0, moment: moment("unauth") })).status, 401);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.close(); }
});

test("password, preferences, moments and raw media survive full persistent restart and key rotation", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "unseen-moment-restart-"));
  const old = new LocalKeyring({ persistent: true, keyId: "moment-old-key" });
  const next = new LocalKeyring({ persistent: true, keyId: "moment-next-key" });
  let api;
  const open = keyring => {
    api = new LocalApi({ database: path.join(directory, "db.sqlite"), keyring,
      mediaStore: new FilesystemMediaStore(path.join(directory, "media")) });
    const call = (method, route, body = {}, headers = {}) => api.handle({ method, path: route, body,
      headers: { "idempotency-key": randomUUID(), ...headers } });
    const ok = async (...args) => { const result = await call(...args); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; };
    return { api, call, ok };
  };
  try {
    let f = open(old); const a = await account(f);
    await upload(f, a, "kept-voice", "audio", audio);
    await f.ok("PATCH", "/v1/profile", { displayName: "重启仍在" }, a.headers);
    await f.ok("PUT", "/v1/moments/memory-1", { expectedVersion: 0, moment: moment() }, a.headers);
    api.close(); api = null;
    f = open(new LocalKeyring({ current: next.current, previous: [old.current], persistent: true }));
    f.api.identityRekey.run({ fromCollisionKeyEpoch: old.keyId, toCollisionKeyEpoch: next.keyId, leaseId: "moment-rekey-test" });
    api.close(); api = null;
    f = open(next); const b = await login(f);
    assert.equal(b.accountId, a.accountId);
    assert.equal((await f.ok("GET", "/v1/profile", {}, b.headers)).user.displayName, "重启仍在");
    assert.equal((await f.ok("GET", "/v1/moments", {}, b.headers)).moments.length, 1);
    assert.deepEqual((await f.call("GET", "/v1/moment-media/kept-voice", {}, b.headers)).body, audio);
  } finally { api?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("seed CLI writes a private credential file, never prints a password or overwrites an existing account", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "unseen-seed-test-"));
  const database = path.join(directory, "db.sqlite"), credentials = path.join(directory, "credentials.json");
  const env = { ...process.env, UNSEEN_API_DB: database, UNSEEN_API_KEYSET: path.join(directory, "key.json"),
    UNSEEN_SEED_CREDENTIALS_FILE: credentials, UNSEEN_SEED_PASSWORD: password };
  try {
    const run = () => spawnSync(process.execPath, [new URL("../scripts/create-password-account.mjs", import.meta.url).pathname], { env, encoding: "utf8" });
    const created = run(); assert.equal(created.status, 0, created.stderr);
    assert.ok(!created.stdout.includes(password) && !created.stderr.includes(password));
    assert.equal(statSync(credentials).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(credentials)).password, password);
    const previous = readFileSync(credentials, "utf8");
    const duplicate = run(); assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /username_already_exists/);
    assert.equal(readFileSync(credentials, "utf8"), previous);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test("password login retries reissue a session without fast password digests; username changes require current proof", async () => {
  const f = fixture();
  try {
    await createPasswordAccount(f.api.core, { username: "unseen", password });
    const key = randomUUID(), body = { username: "unseen", password };
    const first = await f.ok("POST", "/v1/auth/password-login", body, { "idempotency-key": key });
    const retry = await f.ok("POST", "/v1/auth/password-login", body, { "idempotency-key": key });
    assert.equal(retry.replayed, true);
    assert.notEqual(retry.accountSessionSecret, first.accountSessionSecret);
    assert.equal((await f.call("GET", "/v1/me", {}, { authorization: `Bearer ${first.accountSessionSecret}` })).status, 401);
    const headers = { authorization: `Bearer ${retry.accountSessionSecret}` };
    const record = f.db.prepare("SELECT request_hash,response_ref FROM idempotency_records WHERE canonical_endpoint='/v1/auth/password-login'").get();
    const fastDigest = createHash("sha256").update(stableJson({ body, ifMatch: null, notice: null })).digest("hex");
    assert.notEqual(record.request_hash, fastDigest);
    assert.ok(!record.response_ref.includes(retry.accountSessionSecret));
    assert.equal((await f.call("PATCH", "/v1/profile", { username: "new-name" }, headers)).status, 401);
    const changed = await f.ok("PATCH", "/v1/profile", { username: "new-name", currentPassword: password }, headers);
    assert.equal(changed.user.username, "new-name");
    assert.equal((await f.call("POST", "/v1/auth/password-login", body)).status, 401);
    assert.equal((await login(f, "new-name")).accountId, first.accountId);
    const other = await account(f, "different");
    assert.equal((await f.call("PATCH", "/v1/profile", { username: "new-name", currentPassword: password }, other.headers)).status, 409);
    assert.equal((await f.ok("GET", "/v1/profile", {}, other.headers)).user.username, "different");
  } finally { f.close(); }
});


test("voice preferences retain false across devices and partial preference updates", async () => {
  const f = fixture();
  try {
    const a = await account(f), b = await login(f);
    assert.deepEqual(a.user.preferences, { photoMode: "reveal", readReplies: true, continuous: true });
    await f.ok("PATCH", "/v1/profile", { preferences: { photoMode: "clear", readReplies: false, continuous: false } }, a.headers);
    assert.deepEqual((await f.ok("GET", "/v1/profile", {}, b.headers)).user.preferences,
      { photoMode: "clear", readReplies: false, continuous: false });
    await f.ok("PATCH", "/v1/profile", { preferences: { continuous: true } }, b.headers);
    assert.deepEqual((await f.ok("GET", "/v1/profile", {}, a.headers)).user.preferences,
      { photoMode: "clear", readReplies: false, continuous: true });
    assert.equal((await f.call("PATCH", "/v1/profile", { preferences: { readReplies: "false" } }, a.headers)).status, 400);
    assert.equal((await f.call("PATCH", "/v1/profile", { preferences: { unknown: true } }, a.headers)).status, 400);
    const value = moment(); value.preferences = { photoMode: "reveal", readReplies: false, continuous: false };
    const saved = await f.ok("PUT", "/v1/moments/memory-1", { expectedVersion: 0, moment: value }, a.headers);
    assert.deepEqual(saved.moment.preferences, value.preferences);
    const invalid = { ...value, preferences: { ...value.preferences, readReplies: "true" } };
    assert.equal((await f.call("PUT", "/v1/moments/memory-1", { expectedVersion: 1, moment: invalid }, a.headers)).status, 400);
  } finally { f.close(); }
});
