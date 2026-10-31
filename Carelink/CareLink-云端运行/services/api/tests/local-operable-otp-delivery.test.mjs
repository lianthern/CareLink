import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const entrypoint = path.join(repositoryRoot, "infra/integration/local-operable.mjs");

function selfSignedCertificate(directory) {
  const keyFile = path.join(directory, "smtp-test.key");
  const certFile = path.join(directory, "smtp-test.crt");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", keyFile, "-out", certFile],
  { stdio: "ignore" });
  return { certFile, key: readFileSync(keyFile), cert: readFileSync(certFile) };
}

async function fakeImplicitTlsSmtpServer(credentials) {
  const server = tls.createServer(credentials, (socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    let inData = false;
    socket.write("220 smtp.test ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\r\n")) {
        const end = buffer.indexOf("\r\n");
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (inData) {
          if (line === ".") { inData = false; socket.write("250 accepted\r\n"); }
          continue;
        }
        const verb = line.split(" ", 1)[0].toUpperCase();
        if (verb === "EHLO") socket.write("250-smtp.test\r\n250 AUTH PLAIN LOGIN\r\n");
        else if (verb === "AUTH") socket.write("235 authenticated\r\n");
        else if (verb === "MAIL") socket.write("250 sender ok\r\n");
        else if (verb === "RCPT") socket.write("250 recipient ok\r\n");
        else if (verb === "DATA") { inData = true; socket.write("354 continue\r\n"); }
        else if (verb === "QUIT") socket.end("221 bye\r\n");
        else socket.write("500 invalid\r\n");
      }
    });
  });
  server.on("tlsClientError", () => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function boot(t, extraEnv, { expectReady = true, timeoutMs = 10_000 } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "unseen-local-operable-otp-data-"));
  const evidenceDir = mkdtempSync(path.join(tmpdir(), "unseen-local-operable-otp-evidence-"));
  t.after(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(evidenceDir, { recursive: true, force: true });
  });
  const preferredPort = 20_000 + Math.floor(Math.random() * 40_000);
  const env = { ...process.env, UNSEEN_LOCAL_PORT: String(preferredPort), UNSEEN_LOCAL_DATA_DIR: dataDir,
    UNSEEN_LOCAL_EVIDENCE_DIR: evidenceDir, ...extraEnv };
  const runtime = spawn(process.execPath, [entrypoint], { cwd: repositoryRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => {
    if (runtime.exitCode !== null) return;
    const exited = new Promise((resolve) => runtime.once("exit", resolve));
    runtime.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (runtime.exitCode === null) runtime.kill("SIGKILL");
  });
  let stdout = "";
  let stderr = "";
  runtime.stdout.on("data", (bytes) => { stdout += bytes; });
  runtime.stderr.on("data", (bytes) => { stderr += bytes; });
  const outcome = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`local_operable_boot_timeout:${stdout}${stderr}`)), timeoutMs);
    const settle = (value) => { clearTimeout(timer); resolve(value); };
    runtime.stdout.on("data", () => {
      const line = stdout.split("\n").find((entry) => entry.includes("LOCAL_OPERABLE_READY"));
      if (line) settle({ ready: JSON.parse(line) });
    });
    runtime.once("exit", (code) => {
      if (!stdout.includes("LOCAL_OPERABLE_READY")) settle({ exitCode: code, stderr });
    });
  });
  if (expectReady) assert.ok(outcome.ready, `expected LOCAL_OPERABLE_READY, got exit ${outcome.exitCode}: ${stderr}`);
  else assert.ok(!outcome.ready, `expected startup failure, got ready line: ${JSON.stringify(outcome.ready)}`);
  return outcome;
}

test("provider unset boots with the local sink, matching current behavior", async (t) => {
  const { ready } = await boot(t, {});
  assert.equal(ready.otpDelivery, "local_sink");
});

test("provider explicitly disabled boots with the local sink", async (t) => {
  const { ready } = await boot(t, { UNSEEN_OTP_DELIVERY_PROVIDER: "disabled" });
  assert.equal(ready.otpDelivery, "local_sink");
});

test("provider smtp with an incomplete environment fails closed instead of falling back to the sink", async (t) => {
  const { exitCode, stderr } = await boot(t, { UNSEEN_OTP_DELIVERY_PROVIDER: "smtp" }, { expectReady: false });
  assert.notEqual(exitCode, 0);
  assert.match(stderr, /smtp_delivery_configuration_invalid/);
});

test("an unsupported provider value fails closed with a clear startup error", async (t) => {
  const { exitCode, stderr } = await boot(t, { UNSEEN_OTP_DELIVERY_PROVIDER: "ses" }, { expectReady: false });
  assert.notEqual(exitCode, 0);
  assert.match(stderr, /local_operable_invalid:otp_delivery_provider/);
});

test("provider tencent_ses_api with an incomplete environment fails closed instead of falling back to the sink", async (t) => {
  const { exitCode, stderr } = await boot(t, { UNSEEN_OTP_DELIVERY_PROVIDER: "tencent_ses_api" },
    { expectReady: false });
  assert.notEqual(exitCode, 0);
  assert.match(stderr, /tencent_ses_configuration_invalid/);
});

test("provider tencent_ses_api with a complete environment boots wired to the Tencent SES port " +
  "without making any network call", async (t) => {
  const { ready } = await boot(t, {
    UNSEEN_OTP_DELIVERY_PROVIDER: "tencent_ses_api",
    UNSEEN_TENCENT_SES_SECRET_ID: "AKIDtestSecretIdExampleValue0000",
    UNSEEN_TENCENT_SES_SECRET_KEY: "testSecretKeyExampleValueDoNotUse0000",
    UNSEEN_TENCENT_SES_TEMPLATE_ID: "100001"
  });
  assert.equal(ready.otpDelivery, "tencent_ses_api");
});

test("provider smtp with a complete environment boots wired to the SMTP port", async (t) => {
  const certDirectory = mkdtempSync(path.join(tmpdir(), "unseen-local-operable-otp-cert-"));
  t.after(() => rmSync(certDirectory, { recursive: true, force: true }));
  const credentials = selfSignedCertificate(certDirectory);
  const fake = await fakeImplicitTlsSmtpServer(credentials);
  t.after(fake.close);
  const secretDirectory = mkdtempSync(path.join(tmpdir(), "unseen-local-operable-otp-secret-"));
  t.after(() => rmSync(secretDirectory, { recursive: true, force: true }));
  const secretFile = path.join(secretDirectory, "smtp-password");
  writeFileSync(secretFile, "test-smtp-password\n", { mode: 0o600 });
  const { ready } = await boot(t, {
    UNSEEN_OTP_DELIVERY_PROVIDER: "smtp",
    UNSEEN_SMTP_HOST: "127.0.0.1",
    UNSEEN_SMTP_PORT: String(fake.port),
    UNSEEN_SMTP_SECURITY: "implicit_tls",
    UNSEEN_SMTP_USERNAME: "sender@example.test",
    UNSEEN_SMTP_FROM: "sender@example.test",
    UNSEEN_OTP_PROVIDER_SECRET_FILE: secretFile,
    NODE_EXTRA_CA_CERTS: credentials.certFile
  });
  assert.equal(ready.otpDelivery, "smtp_tls");
});
