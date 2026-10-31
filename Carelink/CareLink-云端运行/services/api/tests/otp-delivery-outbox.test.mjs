import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalApi } from "../src/api.mjs";
import { LocalKeyring } from "../src/crypto.mjs";
import { FilesystemMediaStore } from "../src/ports/media/filesystem-media-store.mjs";
import { TestClock } from "./fixture-factory.mjs";

function request(api, body, idempotencyKey = "otp-delivery-test-abcdefgh") {
  return api.handle({ method: "POST", path: "/v1/auth/email-otp-challenges", body,
    headers: { "idempotency-key": idempotencyKey }, observedRiskScope: "otp-delivery-test-risk" });
}

test("OTP outbox calls the provider only after commit and idempotent replay never enqueues twice", async () => {
  const clock = new TestClock();
  const delivered = [];
  let api;
  api = new LocalApi({ autoApproveRegistrations: true, clock, otpDelivery: { name: "test_provider", deliver(message) {
    assert.equal(api.db.isTransaction, false);
    delivered.push(message);
  } } });
  try {
    const first = await request(api, { email: "  Person@Example.TEST ", purpose: "login" });
    assert.equal(first.status, 200);
    assert.equal(delivered.length, 1);
    assert.deepEqual(delivered[0], {
      deliveryId: delivered[0].deliveryId,
      challengeId: first.body.challengeId,
      normalizedEmail: "person@example.test",
      code: delivered[0].code,
      purpose: "login",
      expiresAt: "2026-08-13T00:10:00.000Z"
    });
    assert.match(delivered[0].code, /^\d{6}$/);

    const replay = await request(api, { email: "  Person@Example.TEST ", purpose: "login" });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.challengeId, first.body.challengeId);
    assert.equal(delivered.length, 1);
    const rows = api.db.prepare("SELECT * FROM otp_delivery_outbox").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "delivered");
    assert.equal(rows[0].attempts, 1);
    assert.equal(rows[0].payload_ciphertext, null);
  } finally { api.close(); }
});

test("reauth decrypts the verified identity envelope and delivers the exact bound challenge", async () => {
  const clock = new TestClock();
  const delivered = [];
  const api = new LocalApi({ autoApproveRegistrations: true, clock, otpDelivery: { name: "test_provider",
    deliver: (message) => delivered.push(message) } });
  let sequence = 0;
  const call = (path, body, authorization = null) => api.handle({ method: "POST", path, body,
    headers: { "idempotency-key": `reauth-delivery-${++sequence}-abcdefgh`,
      ...(authorization ? { authorization: `Bearer ${authorization}` } : {}) },
    observedRiskScope: "reauth-delivery-risk" });
  try {
    const challenge = await call("/v1/auth/email-otp-challenges",
      { email: "ReAuth.Person@Example.test", purpose: "login" });
    const loginMessage = delivered.at(-1);
    const login = await call("/v1/auth/email-otp-verifications",
      { challengeId: challenge.body.challengeId, otp: loginMessage.code, purpose: "login" });
    const reauth = await call("/v1/auth/reauth-challenges",
      { actionId: "AUTH.LOGOUT_ALL", purpose: "logout_all" }, login.body.accountSessionSecret);
    const message = delivered.at(-1);
    assert.equal(message.challengeId, reauth.body.challengeId);
    assert.equal(message.normalizedEmail, "reauth.person@example.test");
    assert.equal(message.purpose, "logout_all");
    assert.equal(message.expiresAt, "2026-08-13T00:10:00.000Z");
    assert.equal(api.db.prepare("SELECT COUNT(*) count FROM otp_delivery_outbox").get().count, 2);
  } finally { api.close(); }
});

test("provider failure stays encrypted and retryable, then a restart drains it", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "unseen-otp-outbox-"));
  const database = path.join(directory, "api.sqlite");
  const mediaRoot = path.join(directory, "media");
  const keyring = new LocalKeyring({ persistent: true });
  const clock = new TestClock();
  let attempted;
  let api = new LocalApi({ autoApproveRegistrations: true, database, keyring, clock, mediaStore: new FilesystemMediaStore(mediaRoot),
    otpDelivery: { name: "failing_provider", deliver(message) {
      attempted = message;
      throw new Error(`must-not-persist:${message.normalizedEmail}:${message.code}`);
    } } });
  try {
    const response = await request(api, { email: "Private.Person@Example.test", purpose: "login" });
    assert.equal(response.status, 200);
    const row = api.db.prepare("SELECT * FROM otp_delivery_outbox").get();
    assert.equal(row.status, "queued");
    assert.equal(row.attempts, 1);
    assert.equal(row.last_error_code, "provider_failed");
    assert.ok(row.payload_ciphertext);
    const stored = JSON.stringify({ outbox: row,
      challenge: api.db.prepare("SELECT * FROM email_otp_challenges").get(),
      equivalence: api.db.prepare("SELECT * FROM identifier_equivalences").get() },
    (_, value) => Buffer.isBuffer(value) ? value.toString("base64") : value);
    assert.equal(stored.includes(attempted.normalizedEmail), false);
    assert.equal(stored.includes(attempted.code), false);
    api.close();
    api = null;

    for (const suffix of ["", "-wal", "-shm"]) {
      const filename = `${database}${suffix}`;
      if (existsSync(filename)) assert.equal(readFileSync(filename).includes(Buffer.from(attempted.normalizedEmail)), false);
    }

    clock.advance(5_001);
    const recovered = [];
    api = new LocalApi({ autoApproveRegistrations: true, database, keyring, clock, mediaStore: new FilesystemMediaStore(mediaRoot),
      otpDelivery: { name: "recovered_provider", deliver: (message) => recovered.push(message) } });
    const drained = await api.dispatchOtpDeliveries();
    assert.deepEqual(drained, { configured: true, delivered: 1, failed: 0 });
    assert.deepEqual(recovered, [attempted]);
    const completed = api.db.prepare("SELECT * FROM otp_delivery_outbox").get();
    assert.equal(completed.status, "delivered");
    assert.equal(completed.attempts, 2);
    assert.equal(completed.payload_ciphertext, null);
  } finally {
    api?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an abandoned delivery lease is reclaimed after expiry", async () => {
  const clock = new TestClock();
  const delivered = [];
  const api = new LocalApi({ autoApproveRegistrations: true, clock, otpDelivery: { name: "test_provider",
    deliver: (message) => delivered.push(message) } });
  try {
    api.identity.requestOtp({ body: { email: "lease@example.test", purpose: "login" },
      idempotencyKey: "lease-request-abcdefgh", riskScope: "lease-risk" });
    await assert.rejects(api.dispatchOtpDeliveries({ leaseOwner: "crashed-worker", afterClaim() {
      throw new Error("simulated process crash");
    } }), /simulated process crash/);
    let row = api.db.prepare("SELECT * FROM otp_delivery_outbox").get();
    assert.equal(row.status, "running");
    assert.equal(row.attempts, 1);
    assert.equal(delivered.length, 0);
    assert.deepEqual(await api.dispatchOtpDeliveries({ leaseOwner: "early-worker" }),
      { configured: true, delivered: 0, failed: 0 });

    clock.advance(60_001);
    assert.deepEqual(await api.dispatchOtpDeliveries({ leaseOwner: "recovery-worker" }),
      { configured: true, delivered: 1, failed: 0 });
    row = api.db.prepare("SELECT * FROM otp_delivery_outbox").get();
    assert.equal(row.status, "delivered");
    assert.equal(row.attempts, 2);
    assert.equal(delivered.length, 1);
  } finally { api.close(); }
});

test("crash after provider success retries the same deliveryId for provider-side dedupe", async () => {
  const clock = new TestClock();
  const delivered = [];
  const api = new LocalApi({ autoApproveRegistrations: true, clock, otpDelivery: { name: "idempotent_test_provider",
    deliver: (message) => delivered.push(message) } });
  try {
    api.identity.requestOtp({ body: { email: "dedupe@example.test", purpose: "login" },
      idempotencyKey: "dedupe-request-abcdefgh", riskScope: "dedupe-risk" });
    const row = api.otpOutbox.claim({ leaseOwner: "crashed-after-send", leaseMs: 60_000 });
    const first = api.otpOutbox.payload(row);
    await api.otpOutbox.port.deliver(first);
    assert.equal(delivered.length, 1);
    assert.equal(api.db.prepare("SELECT status FROM otp_delivery_outbox").get().status, "running");

    clock.advance(60_001);
    assert.deepEqual(await api.dispatchOtpDeliveries({ leaseOwner: "recovery-worker" }),
      { configured: true, delivered: 1, failed: 0 });
    assert.equal(delivered.length, 2);
    assert.equal(delivered[1].deliveryId, delivered[0].deliveryId);
    assert.deepEqual(delivered[1], delivered[0]);
  } finally { api.close(); }
});

test("invalid sealed payload is discarded without provider I/O or infinite retry", async () => {
  const clock = new TestClock();
  let calls = 0;
  const api = new LocalApi({ autoApproveRegistrations: true, clock, otpDelivery: { name: "must_not_run", deliver() { calls += 1; } } });
  try {
    api.identity.requestOtp({ body: { email: "corrupt@example.test", purpose: "login" },
      idempotencyKey: "corrupt-request-abcdefgh", riskScope: "corrupt-risk" });
    api.db.prepare("UPDATE otp_delivery_outbox SET payload_ciphertext='corrupt'").run();
    assert.deepEqual(await api.dispatchOtpDeliveries(), { configured: true, delivered: 0, failed: 1 });
    const row = api.db.prepare("SELECT * FROM otp_delivery_outbox").get();
    assert.equal(row.status, "discarded");
    assert.equal(row.last_error_code, "payload_invalid");
    assert.equal(row.payload_ciphertext, null);
    assert.equal(calls, 0);
    assert.deepEqual(await api.dispatchOtpDeliveries(), { configured: true, delivered: 0, failed: 0 });
  } finally { api.close(); }
});

test("persistent API without an OTP provider is explicitly degraded and cannot issue a challenge", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "unseen-otp-unconfigured-"));
  const api = new LocalApi({ autoApproveRegistrations: true, database: path.join(directory, "api.sqlite"),
    keyring: new LocalKeyring({ persistent: true }),
    mediaStore: new FilesystemMediaStore(path.join(directory, "media")) });
  try {
    assert.deepEqual((await api.health()).otpDelivery, { configured: false, ready: false,
      provider: "unconfigured", queued: 0, running: 0 });
    // Still "degraded", not "down": no OTP provider means email login can't send, but the rest
    // of the site (DB writable, disk fine, no CLIP sidecar configured) is genuinely servable --
    // see health-checks.mjs's status contract comment for why this must not become a 503.
    assert.equal((await api.health()).status, "degraded");
    const response = await request(api, { email: "blocked@example.test", purpose: "login" });
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, "otp_delivery_unavailable");
    assert.equal(api.db.prepare("SELECT COUNT(*) count FROM email_otp_challenges").get().count, 0);
    assert.equal(api.db.prepare("SELECT COUNT(*) count FROM otp_delivery_outbox").get().count, 0);
  } finally {
    api.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
