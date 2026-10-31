import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import tls from "node:tls";
import { createBookLabDeployment } from "../../../infra/integration/book-lab/deployment-entrypoint.mjs";
import { LocalApi } from "../src/api.mjs";
import { LocalKeyring } from "../src/crypto.mjs";
import { DEFAULT_OTP_DELIVERY_LEASE_MS } from "../src/otp-delivery-outbox.mjs";
import { FilesystemMediaStore } from "../src/ports/media/filesystem-media-store.mjs";
import { MAX_SMTP_DELIVERY_TIMEOUT_MS, SMTP_DELIVERY_LEASE_GRACE_MS,
  createSmtpOtpDeliveryPort, smtpOtpDeliveryFromEnv } from
  "../src/ports/otp/smtp-otp-delivery-port.mjs";
import { TestClock } from "./fixture-factory.mjs";

function certificate(directory) {
  const key = path.join(directory, "smtp-test.key");
  const cert = path.join(directory, "smtp-test.crt");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert],
  { stdio: "ignore" });
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

function smtpProtocol(socket, state, behavior = {}, greeting = true) {
  socket.setEncoding("utf8");
  let buffer = "";
  let data = false;
  let message = [];
  const respond = (value) => behavior.delayMs ? setTimeout(() => socket.write(value), behavior.delayMs) :
    socket.write(value);
  if (greeting && !behavior.hangGreeting) respond("220 smtp.test ESMTP\r\n");
  socket.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\r\n")) {
      const end = buffer.indexOf("\r\n");
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (data) {
        if (line === ".") {
          state.messages.push(message.join("\r\n"));
          message = [];
          data = false;
          respond("250 accepted\r\n");
        } else {
          message.push(line);
        }
        continue;
      }
      const verb = line.split(" ", 1)[0].toUpperCase();
      state.commands.push(verb);
      if (verb === "EHLO") respond("250-smtp.test\r\n250 AUTH PLAIN LOGIN\r\n");
      else if (verb === "AUTH") {
        if (behavior.rejectAuth) respond("535 rejected\r\n");
        else respond("235 authenticated\r\n");
      } else if (verb === "MAIL") respond("250 sender ok\r\n");
      else if (verb === "RCPT" && behavior.disconnectRcpt) socket.destroy();
      else if (verb === "RCPT" && behavior.rejectRcpt) respond("550 rejected\r\n");
      else if (verb === "RCPT") respond("250 recipient ok\r\n");
      else if (verb === "DATA") { data = true; respond("354 continue\r\n"); }
      else if (verb === "QUIT") { socket.end("221 bye\r\n"); }
      else respond("500 invalid\r\n");
    }
  });
}

async function implicitServer(credentials, behavior = {}) {
  const state = { commands: [], messages: [], connections: 0, closed: 0, behavior };
  const server = tls.createServer(credentials, (socket) => {
    state.connections += 1;
    socket.once("close", () => { state.closed += 1; });
    smtpProtocol(socket, state, behavior);
  });
  server.on("tlsClientError", () => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, state, port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)) };
}

async function startTlsServer(credentials) {
  const state = { commands: [], messages: [] };
  const secureContext = tls.createSecureContext(credentials);
  const server = net.createServer((plain) => {
    plain.setEncoding("utf8");
    plain.write("220 smtp.test ESMTP\r\n");
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk;
      while (buffer.includes("\r\n")) {
        const end = buffer.indexOf("\r\n");
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const verb = line.split(" ", 1)[0].toUpperCase();
        state.commands.push(verb);
        if (verb === "EHLO") plain.write("250-smtp.test\r\n250 STARTTLS\r\n");
        else if (verb === "STARTTLS") plain.write("220 begin tls\r\n", () => {
          plain.off("data", onData);
          const secure = new tls.TLSSocket(plain, { isServer: true, secureContext });
          secure.once("secure", () => smtpProtocol(secure, state, {}, false));
          secure.on("error", () => {});
        });
      }
    };
    plain.on("data", onData);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, state, port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)) };
}

function secretFile(directory, contents = "test-smtp-password") {
  const file = path.join(directory, "smtp-password");
  writeFileSync(file, `${contents}\n`, { mode: 0o600 });
  return file;
}

function smtpEnv(file, port, security = "implicit_tls") {
  return {
    UNSEEN_OTP_DELIVERY_PROVIDER: "smtp",
    UNSEEN_SMTP_HOST: "127.0.0.1",
    UNSEEN_SMTP_PORT: String(port),
    UNSEEN_SMTP_SECURITY: security,
    UNSEEN_SMTP_USERNAME: "sender@example.test",
    UNSEEN_SMTP_FROM: "sender@example.test",
    UNSEEN_OTP_PROVIDER_SECRET_FILE: file,
    UNSEEN_SMTP_CONNECT_TIMEOUT_MS: "250",
    UNSEEN_SMTP_SEND_TIMEOUT_MS: "250",
    UNSEEN_SMTP_TOTAL_TIMEOUT_MS: "1000"
  };
}

function message() {
  return { deliveryId: "otp_delivery_test_abcdefgh", challengeId: "otp_challenge_test_abcdefgh",
    normalizedEmail: "friend@example.test", code: "246801", purpose: "login",
    expiresAt: "2026-08-15T01:10:00.000Z" };
}

async function until(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("test_condition_timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("SMTP stays default-off without reading a secret or opening a network adapter", () => {
  assert.equal(smtpOtpDeliveryFromEnv({ UNSEEN_OTP_PROVIDER_SECRET_FILE: "/does/not/exist" }), null);
  assert.equal(smtpOtpDeliveryFromEnv({ UNSEEN_OTP_DELIVERY_PROVIDER: "disabled",
    UNSEEN_OTP_PROVIDER_SECRET_FILE: "/does/not/exist", UNSEEN_SMTP_HOST: "203.0.113.1" }), null);
});

test("invalid configuration and excessive total deadline fail before secret read or network", () => {
  const absentPath = "/does/not/exist";
  assert.throws(() => smtpOtpDeliveryFromEnv({ ...smtpEnv(absentPath, 465),
    UNSEEN_SMTP_TOTAL_TIMEOUT_MS: String(MAX_SMTP_DELIVERY_TIMEOUT_MS + 1) }),
  (error) => error.code === "smtp_delivery_configuration_invalid");
  assert.throws(() => smtpOtpDeliveryFromEnv({ ...smtpEnv(absentPath, 465), UNSEEN_SMTP_HOST: "" }),
    (error) => error.code === "smtp_delivery_configuration_invalid");
});

test("SMTP password file must be absolute, regular, owned, non-symlink and mode 0400/0600", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-smtp-secret-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = secretFile(directory);
  assert.equal(smtpOtpDeliveryFromEnv(smtpEnv(file, 465)).name, "smtp_tls");
  chmodSync(file, 0o400);
  assert.equal(smtpOtpDeliveryFromEnv(smtpEnv(file, 465)).name, "smtp_tls");
  chmodSync(file, 0o644);
  assert.throws(() => smtpOtpDeliveryFromEnv(smtpEnv(file, 465)),
    (error) => error.code === "smtp_secret_unavailable");
  const link = path.join(directory, "smtp-password-link");
  symlinkSync(file, link);
  assert.throws(() => smtpOtpDeliveryFromEnv(smtpEnv(link, 465)),
    (error) => error.code === "smtp_secret_unavailable");
  assert.throws(() => smtpOtpDeliveryFromEnv(smtpEnv("relative-secret", 465)),
    (error) => error.code === "smtp_secret_unavailable");
});

test("implicit TLS sends one minimal OTP message with a stable opaque Message-ID", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-smtp-tls-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const credentials = certificate(directory);
  const fake = await implicitServer(credentials);
  t.after(fake.close);
  const port = smtpOtpDeliveryFromEnv(smtpEnv(secretFile(directory), fake.port), { ca: credentials.cert });
  await port.deliver(message());
  await port.deliver(message());
  assert.equal(fake.state.messages.length, 2);
  const [first, second] = fake.state.messages;
  const firstId = first.match(/^Message-ID: (.+)$/mu)?.[1];
  assert.equal(second.match(/^Message-ID: (.+)$/mu)?.[1], firstId);
  assert.match(first, /^To: friend@example\.test$/mu);
  assert.doesNotMatch(first, /otp_delivery_test|otp_challenge_test|\blogin\b|246801/u);
  const encoded = first.split("\r\n\r\n", 2)[1].replaceAll("\r\n", "");
  assert.match(Buffer.from(encoded, "base64").toString("utf8"), /246801/u);
});

test("STARTTLS upgrades before authentication and message transfer", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-smtp-starttls-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const credentials = certificate(directory);
  const fake = await startTlsServer(credentials);
  t.after(fake.close);
  const port = smtpOtpDeliveryFromEnv(smtpEnv(secretFile(directory), fake.port, "starttls"),
    { ca: credentials.cert });
  await port.deliver(message());
  assert.deepEqual(fake.state.commands.slice(0, 3), ["EHLO", "STARTTLS", "EHLO"]);
  assert.equal(fake.state.messages.length, 1);
});

test("bad certificate, timeout, rejection and disconnect fail with stable redacted codes", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-smtp-failure-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const credentials = certificate(directory);
  const secret = secretFile(directory);

  const badCertificate = await implicitServer(credentials);
  await assert.rejects(smtpOtpDeliveryFromEnv(smtpEnv(secret, badCertificate.port)).deliver(message()),
    (error) => error.code === "smtp_delivery_tls_failed");
  await badCertificate.close();

  for (const [behavior, code] of [
    [{ hangGreeting: true }, "smtp_delivery_timeout"],
    [{ rejectAuth: true }, "smtp_delivery_auth_failed"],
    [{ rejectRcpt: true }, "smtp_delivery_rejected"],
    [{ disconnectRcpt: true }, "smtp_delivery_connection_failed"]
  ]) {
    const fake = await implicitServer(credentials, behavior);
    await assert.rejects(smtpOtpDeliveryFromEnv(smtpEnv(secret, fake.port), { ca: credentials.cert }).deliver(message()),
      (error) => error.code === code && !error.message.includes("friend@example.test") &&
        !error.message.includes("246801"));
    await fake.close();
  }
});

test("adapter concurrency is one and excess work fails closed", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-smtp-busy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const credentials = certificate(directory);
  const fake = await implicitServer(credentials, { hangGreeting: true });
  t.after(fake.close);
  const port = createSmtpOtpDeliveryPort({ host: "127.0.0.1", port: fake.port, security: "implicit_tls",
    username: "sender@example.test", from: "sender@example.test", password: "test-smtp-password",
    connectTimeoutMs: 150, sendTimeoutMs: 150, totalTimeoutMs: 150 }, { ca: credentials.cert });
  const first = port.deliver(message());
  await new Promise((resolve) => setTimeout(resolve, 25));
  await assert.rejects(port.deliver(message()), (error) => error.code === "smtp_delivery_busy");
  await assert.rejects(first, (error) => error.code === "smtp_delivery_timeout");
});

test("one absolute deadline bounds a provider whose individual phases stay within their limits", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-smtp-deadline-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const credentials = certificate(directory);
  const fake = await implicitServer(credentials, { delayMs: 40 });
  t.after(fake.close);
  const port = createSmtpOtpDeliveryPort({ host: "127.0.0.1", port: fake.port, security: "implicit_tls",
    username: "sender@example.test", from: "sender@example.test", password: "test-smtp-password",
    connectTimeoutMs: 100, sendTimeoutMs: 100, totalTimeoutMs: 180 }, { ca: credentials.cert });
  const startedAt = Date.now();
  await assert.rejects(port.deliver(message()), (error) => error.code === "smtp_delivery_timeout");
  assert.ok(Date.now() - startedAt < 280);
  await until(() => fake.state.closed === 1);
  assert.equal(fake.state.messages.length, 0);
});

test("a second dispatcher cannot reclaim while the bounded first delivery still owns its lease", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-smtp-lease-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const credentials = certificate(directory);
  const behavior = { hangGreeting: true };
  const fake = await implicitServer(credentials, behavior);
  t.after(fake.close);
  const env = { ...smtpEnv(secretFile(directory), fake.port), UNSEEN_SMTP_CONNECT_TIMEOUT_MS: "1000",
    UNSEEN_SMTP_SEND_TIMEOUT_MS: "1000", UNSEEN_SMTP_TOTAL_TIMEOUT_MS: "150" };
  const keyring = new LocalKeyring({ persistent: true });
  const database = path.join(directory, "core.sqlite");
  const mediaRoot = path.join(directory, "media");
  const clock = new TestClock();
  const firstApi = new LocalApi({ database, keyring, clock, mediaStore: new FilesystemMediaStore(mediaRoot),
    otpDelivery: smtpOtpDeliveryFromEnv(env, { ca: credentials.cert }) });
  const secondApi = new LocalApi({ database, keyring, clock, mediaStore: new FilesystemMediaStore(mediaRoot),
    otpDelivery: smtpOtpDeliveryFromEnv(env, { ca: credentials.cert }) });
  t.after(() => { firstApi.close(); secondApi.close(); });
  firstApi.identity.requestOtp({ body: { email: "friend@example.test", purpose: "login" },
    idempotencyKey: "cross-dispatcher-abcdefgh", riskScope: "cross-dispatcher-risk" });

  const first = firstApi.dispatchOtpDeliveries({ limit: 1, leaseOwner: "first-process",
    leaseMs: DEFAULT_OTP_DELIVERY_LEASE_MS,
    retryDelayMs: 0 });
  await until(() => fake.state.connections === 1);
  clock.advance(DEFAULT_OTP_DELIVERY_LEASE_MS - 1_000);
  assert.deepEqual(await secondApi.dispatchOtpDeliveries({ limit: 1, leaseOwner: "second-process",
    leaseMs: DEFAULT_OTP_DELIVERY_LEASE_MS,
    retryDelayMs: 0 }), { configured: true, delivered: 0, failed: 0 });
  assert.equal(fake.state.connections, 1);
  assert.deepEqual(await first, { configured: true, delivered: 0, failed: 1 });
  await until(() => fake.state.closed === 1);

  behavior.hangGreeting = false;
  assert.deepEqual(await secondApi.dispatchOtpDeliveries({ limit: 1, leaseOwner: "second-process",
    leaseMs: DEFAULT_OTP_DELIVERY_LEASE_MS,
    retryDelayMs: 0 }), { configured: true, delivered: 1, failed: 0 });
  assert.equal(fake.state.messages.length, 1);
  assert.equal(firstApi.db.prepare("SELECT attempts FROM otp_delivery_outbox").get().attempts, 2);
});

test("deployment composition delivers once for an idempotent challenge replay", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "unseen-smtp-deployment-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const credentials = certificate(directory);
  const fake = await implicitServer(credentials);
  t.after(fake.close);
  const env = {
    ...smtpEnv(secretFile(directory), fake.port),
    UNSEEN_API_HOST: "127.0.0.1",
    UNSEEN_API_PORT: "0",
    UNSEEN_API_DB: path.join(directory, "core.sqlite"),
    UNSEEN_API_KEYSET: path.join(directory, "core.keyset.json"),
    UNSEEN_API_MEDIA_ROOT: path.join(directory, "media"),
    UNSEEN_BOOK_LAB_ENABLED: "false",
    UNSEEN_BOOK_LAB_LOCK: path.join(directory, "deployment.lock")
  };
  const deployment = await createBookLabDeployment({ env, smtpOptions: { ca: credentials.cert } });
  t.after(() => deployment.close());
  const request = { method: "POST", path: "/v1/auth/email-otp-challenges",
    headers: { "idempotency-key": "smtp-deployment-abcdefgh" }, observedRiskScope: "smtp-deployment-risk",
    body: { email: "friend@example.test", purpose: "login" } };
  const first = await deployment.api.handle(request);
  const replay = await deployment.api.handle(request);
  assert.equal(first.status, 200);
  assert.equal(replay.body.challengeId, first.body.challengeId);
  assert.equal(fake.state.messages.length, 1);
  assert.equal((await deployment.api.health()).status, "ok");
  assert.ok(deployment.api.otpOutbox.port.deliveryTimeoutMs + SMTP_DELIVERY_LEASE_GRACE_MS <
    DEFAULT_OTP_DELIVERY_LEASE_MS);
});
