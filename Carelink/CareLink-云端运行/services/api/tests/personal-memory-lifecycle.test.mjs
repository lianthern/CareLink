import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalApi } from "../src/api.mjs";
import { LocalKeyring } from "../src/crypto.mjs";
import { FilesystemMediaStore } from "../src/ports/media/filesystem-media-store.mjs";
import { dispatchOne } from "../../jobs/dispatch/index.mjs";
import { createAccountUpload, fixture } from "./fixture-factory.mjs";

function persistent(directory, keyring) {
  const messages = [];
  const api = new LocalApi({ autoApproveRegistrations: true, database: path.join(directory, "db.sqlite"), keyring,
    mediaStore: new FilesystemMediaStore(path.join(directory, "media")), otpSink: message => messages.push(message) });
  const call = (method, url, body = {}, headers = {}) => api.handle({ method, path: url, body,
    headers: { "idempotency-key": randomUUID(), ...headers } });
  const login = async (email = "rotation@example.test") => {
    const challenge = await call("POST", "/v1/auth/email-otp-challenges", { email, purpose: "login" });
    assert.equal(challenge.status, 200);
    const otp = messages.findLast(message => message.challengeId === challenge.body.challengeId).code;
    const verified = await call("POST", "/v1/auth/email-otp-verifications", { challengeId: challenge.body.challengeId, otp, purpose: "login" });
    assert.equal(verified.status, 200);
    return { authorization: `Bearer ${verified.body.accountSessionSecret}` };
  };
  return { api, call, login };
}

test("persistent snapshots block premature key retirement and survive verified identity rekey plus full restart", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "unseen-memory-key-lifecycle-"));
  const old = new LocalKeyring({ persistent: true, keyId: "memory-old-v1" });
  const next = new LocalKeyring({ persistent: true, keyId: "memory-next-v1" });
  const both = new LocalKeyring({ current: next.current, previous: [old.current], persistent: true });
  const retired = new LocalKeyring({ current: next.current, previous: [], persistent: true });
  let f;
  try {
    f = persistent(directory, old);
    const headers = await f.login();
    const document = { title: "旧密钥下的照片和原话", photos: [{ src: "data:image/png;base64,AQID", date: "2020-01-01" }], turns: [{ answer: "必须完整保留" }] };
    await f.call("POST", "/v1/me/memories/kept", { document, consent: true }, { ...headers, "if-match": "0" });
    await f.call("POST", "/v1/me/memories/kept/trash", {}, { ...headers, "if-match": "1" });
    const before = (await f.call("GET", "/v1/me/memories/kept", {}, headers)).body;
    f.api.close(); f = null;
    assert.throws(() => persistent(directory, retired), error => error.code === "personal_memory_key_retirement_incomplete" && error.status === 503);
    f = persistent(directory, both);
    const rekey = f.api.identityRekey.run({ fromCollisionKeyEpoch: old.keyId, toCollisionKeyEpoch: next.keyId, leaseId: "memory-key-lifecycle-lease" });
    assert.equal(rekey.switched, 1);
    const row = f.api.db.prepare("SELECT envelope_key_id,version FROM personal_memories").get();
    assert.equal(row.envelope_key_id, next.keyId);
    assert.equal(row.version, before.version);
    f.api.close(); f = null;
    f = persistent(directory, retired);
    const afterLogin = await f.login();
    const after = await f.call("GET", "/v1/me/memories/kept", {}, afterLogin);
    assert.equal(after.status, 200);
    assert.deepEqual(after.body, before);
    assert.equal((await f.call("GET", "/v1/me/memories", {}, afterLogin)).body.memories.length, 1);
  } finally { f?.api.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("rekey replay migrates snapshots left by an older completed identity operation; corruption rolls back", async () => {
  const old = new LocalKeyring({ keyId: "old-memory-key" });
  const next = new LocalKeyring({ keyId: "next-memory-key" });
  const both = new LocalKeyring({ current: next.current, previous: [old.current] });
  const f = fixture({ keyring: old });
  try {
    const owner = await f.login();
    await f.ok("POST", "/v1/me/memories/replay", { document: { text: "原话" }, consent: true }, { ...owner.headers, "if-match": "0" });
    const original = f.db.prepare("SELECT * FROM personal_memories").get();
    f.api.core.keyring = both;
    const args = { fromCollisionKeyEpoch: old.keyId, toCollisionKeyEpoch: next.keyId, leaseId: "replay-legacy-operation" };
    f.db.prepare("UPDATE personal_memories SET document_ciphertext='corrupted'").run();
    assert.throws(() => f.api.identityRekey.run(args));
    assert.equal(f.db.prepare("SELECT collision_key_epoch FROM identifier_equivalences").get().collision_key_epoch, old.keyId);
    f.db.prepare("UPDATE personal_memories SET document_ciphertext=?").run(original.document_ciphertext);
    f.api.identityRekey.run(args);
    // Recreate the precise state left by an older identity-only completed operation.
    f.db.prepare("UPDATE personal_memories SET document_ciphertext=?,envelope_key_id=?").run(original.document_ciphertext, old.keyId);
    f.api.identityRekey.run(args);
    assert.equal(f.db.prepare("SELECT envelope_key_id FROM personal_memories").get().envelope_key_id, next.keyId);
  } finally { f.close(); }
});

test("account export contains activity data and complete private snapshots including trash, but never another account's", async () => {
  const f = fixture();
  try {
    const a = await f.login("export-memory-a@example.test");
    const b = await f.login("export-memory-b@example.test");
    const space = await f.openSpace(a, await f.createSpace(a, "原有活动"));
    const flow = await createAccountUpload(f, a, space);
    const document = { title: "新云记忆", photos: [{ src: "data:image/png;base64,AQID" }], turns: [{ answer: "我的原话" }] };
    await f.ok("POST", "/v1/me/memories/shared_id", { document, consent: true }, { ...a.headers, "if-match": "0" });
    const trash = await f.ok("POST", "/v1/me/memories/shared_id/trash", {}, { ...a.headers, "if-match": "1" });
    await f.ok("POST", "/v1/me/memories/shared_id", { document: { private: "B only" }, consent: true }, { ...b.headers, "if-match": "0" });
    const created = await f.ok("POST", "/v1/exports", { scope: "account", format: "json" }, a.headers);
    assert.throws(() => dispatchOne(f.db, created.jobId, { now: f.clock.iso() }), error => error.code === "personal_memory_export_key_required");
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM export_artifacts WHERE export_id=?").get(created.exportId).count, 0);
    assert.equal(dispatchOne(f.db, created.jobId, { now: f.clock.iso(), keyring: f.api.keyring }).status, "succeeded");
    const bytes = f.db.prepare("SELECT content FROM export_artifacts WHERE export_id=?").get(created.exportId).content;
    const result = JSON.parse(Buffer.from(bytes).toString());
    assert.ok(result.spaces.some(s => s.id === space.spaceId));
    assert.ok(result.photos.some(p => p.id === flow.committed.photoId));
    assert.equal(result.personalMemories.length, 1);
    assert.deepEqual(result.personalMemories[0].document, document);
    assert.equal(result.personalMemories[0].version, trash.version);
    assert.equal(result.personalMemories[0].deletedAt, trash.deletedAt);
    assert.ok(!JSON.stringify(result).includes("B only"));
    assert.ok(!JSON.stringify(result).includes("document_ciphertext"));
  } finally { f.close(); }
});

test("the canonical runtime worker supplies its configured keyring to account exports", async () => {
  const { createLocalFixtureWorker } = await import("../../../infra/integration/local-locator-fixture.mjs");
  const f = fixture();
  let worker;
  try {
    const owner = await f.login();
    await f.ok("POST", "/v1/me/memories/runtime", { consent: true, document: { answer: "完整运行链" } }, { ...owner.headers, "if-match": "0" });
    const job = await f.ok("POST", "/v1/exports", { scope: "account", format: "json" }, owner.headers);
    worker = createLocalFixtureWorker({ api: f.api, config: { fixture: { assets: [] } }, locatorFixture: { enabled: false } });
    await worker.drain();
    const status = await f.ok("GET", `/v1/exports/${job.exportId}`, {}, owner.headers);
    assert.equal(status.status, "ready");
    const content = f.db.prepare("SELECT content FROM export_artifacts WHERE export_id=?").get(job.exportId).content;
    assert.equal(JSON.parse(Buffer.from(content)).personalMemories[0].document.answer, "完整运行链");
  } finally { worker?.stop(); f.close(); }
});


test("the actual CLIP runtime exports snapshots and keeps draining later account jobs", async () => {
  const { createClipLocatorWorker } = await import("../../../infra/integration/local-clip-locator-worker.mjs");
  const f = fixture();
  const errors = [];
  let worker;
  try {
    const owner = await f.login("clip-export-owner@example.test");
    const other = await f.login("clip-export-other@example.test");
    const document = { title: "CLIP worker account export", photos: [{ src: "data:image/png;base64,AQID" }], answer: "原话保留" };
    await f.ok("POST", "/v1/me/memories/clip-runtime", { consent: true, document }, { ...owner.headers, "if-match": "0" });
    const trashed = await f.ok("POST", "/v1/me/memories/clip-runtime/trash", {}, { ...owner.headers, "if-match": "1" });
    const first = await f.ok("POST", "/v1/exports", { scope: "account", format: "json" }, owner.headers);
    worker = createClipLocatorWorker({ api: f.api, locatorPort: { enabled: false },
      sidecarClient: { embedPhoto() { assert.fail("export must not invoke AI"); } }, onError: error => errors.push(error) });
    const records = await worker.drain();
    assert.equal(records.length, 1);
    assert.equal(records[0].status, "succeeded");
    const readExport = job => JSON.parse(Buffer.from(f.db.prepare("SELECT content FROM export_artifacts WHERE export_id=?").get(job.exportId).content));
    assert.deepEqual(readExport(first).personalMemories[0].document, document);
    assert.equal(readExport(first).personalMemories[0].deletedAt, trashed.deletedAt);
    assert.equal(readExport(first).personalMemories[0].version, trashed.version);
    assert.equal((await f.ok("GET", `/v1/exports/${first.exportId}`, {}, owner.headers)).status, "ready");
    // A later drain must execute unrelated account work, not silently remain stopped.
    const second = await f.ok("POST", "/v1/exports", { scope: "account", format: "json" }, other.headers);
    const later = await worker.drain();
    assert.equal(later.length, 1);
    assert.equal(later[0].jobId, second.jobId);
    assert.equal(later[0].status, "succeeded");
    assert.deepEqual(readExport(second).personalMemories, []);
    assert.ok(!JSON.stringify(readExport(second)).includes("原话保留"));
    assert.equal((await f.ok("GET", `/v1/exports/${second.exportId}`, {}, other.headers)).status, "ready");
    assert.deepEqual(errors, []);
  } finally { await worker?.stop(); f.close(); }
});
