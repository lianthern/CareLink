import { approveFixtureRegistrations } from './approve-fixture-registrations.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Regression test for the "成员邀请已创建" dialog showing `undefined`: apps/web/src/app.js
// reads `result.inviteUrl` for MEMBER_INVITATION.CREATE, but the real API
// (services/api/src/space-service.mjs createMemberInvitation) returns the one-time link
// under `invitationBootstrapUrlOnce`. The fix lives in the local-operable read-model
// projection (infra/integration/local-operable.mjs adaptJsonBody), which is only reachable
// over real HTTP, so this test spawns the actual local-operable runtime and drives it end to end.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function poll(run, label, timeoutMs = 20_000) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await run();
      if (result) return result;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timeout:${label}:${lastError?.message ?? lastError ?? ""}`);
}

async function startLocalOperable() {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "unseen-local-operable-test-"));
  const dataRoot = path.join(temporaryRoot, "data");
  const evidenceRoot = path.join(temporaryRoot, "evidence");
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["infra/integration/local-operable.mjs"], {
    cwd: repoRoot,
    env: { ...process.env, UNSEEN_LOCAL_PORT: String(port), UNSEEN_LOCAL_DATA_DIR: dataRoot,
      UNSEEN_LOCAL_EVIDENCE_DIR: evidenceRoot,
      // This test drives /v1/auth/email-otp-challenges directly over HTTP without solving a PoW
      // challenge first; local-operable.mjs defaults UNSEEN_OTP_CAPTCHA_PROVIDER to "pow" for a
      // real boot, so this login flow needs to opt out explicitly.
      UNSEEN_OTP_CAPTCHA_PROVIDER: "disabled" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderrOutput = "";
  child.stdout.on("data", () => {});
  child.stderr.on("data", (bytes) => { stderrOutput += bytes; });
  const startup = await poll(async () => JSON.parse(await readFile(path.join(evidenceRoot, "LOCAL-STARTUP.json"), "utf8")),
    "startup").catch((error) => { throw new Error(`${error.message}\nstderr:${stderrOutput}`); });
  await poll(async () => (await fetch(`${startup.origin}/healthz`)).ok, "health");
  approveFixtureRegistrations(dataRoot);
  return {
    origin: startup.origin,
    dataRoot,
    async stop() {
      if (child.exitCode !== null) { await rm(temporaryRoot, { recursive: true, force: true }); return; }
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  };
}

function extractCookie(response, name) {
  const values = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  for (const value of values) {
    const pair = value.split(";", 1)[0];
    const index = pair.indexOf("=");
    if (index > 0 && pair.slice(0, index) === name) return pair.slice(index + 1);
  }
  return null;
}

async function jsonRequest(origin, method, pathname, { body, headers = {} } = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const value = await response.json().catch(() => ({}));
  return { status: response.status, headers: response.headers, body: value };
}

test("local-operable projects member-invitation creation with the inviteUrl field app.js reads", async () => {
  const runtime = await startLocalOperable();
  try {
    const email = `owner-invite-url-fix-${Date.now()}@example.test`;
    const challenge = await jsonRequest(runtime.origin, "POST", "/v1/auth/email-otp-challenges", {
      body: { email, purpose: "login", locale: "zh-CN" },
      headers: { "idempotency-key": `test-otp-challenge-${crypto.randomUUID()}` }
    });
    assert.equal(challenge.status, 200, JSON.stringify(challenge.body));

    const mailboxPath = path.join(runtime.dataRoot, ".otp-mailbox.json");
    const mailbox = await poll(async () => {
      const value = JSON.parse(await readFile(mailboxPath, "utf8"));
      return value.challengeId === challenge.body.challengeId ? value : null;
    }, "otp mailbox");

    const verified = await jsonRequest(runtime.origin, "POST", "/v1/auth/email-otp-verifications", {
      body: { challengeId: challenge.body.challengeId, otp: mailbox.code, purpose: "login" },
      headers: { "idempotency-key": `test-otp-verify-${crypto.randomUUID()}` }
    });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    const accountSecret = extractCookie(verified, "__Host-unseen_account");
    assert.ok(accountSecret, "expected __Host-unseen_account session cookie");
    const cookie = `__Host-unseen_account=${accountSecret}`;

    // Cookie-bearing mutations go through the http-server's same-origin CSRF guard
    // (assertCookieCsrf), so origin/sec-fetch-site must match the runtime's own origin.
    const sameOriginHeaders = { origin: runtime.origin, "sec-fetch-site": "same-origin" };

    const space = await jsonRequest(runtime.origin, "POST", "/v1/spaces", {
      body: { name: "Invite URL Fix Space" },
      headers: { "idempotency-key": `test-space-${crypto.randomUUID()}`, cookie, ...sameOriginHeaders }
    });
    assert.equal(space.status, 200, JSON.stringify(space.body));

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const invitation = await jsonRequest(runtime.origin, "POST",
      `/v1/spaces/${space.body.spaceId}/member-invitations`, {
        body: { verifiedIdentifier: `member-invite-url-fix-${Date.now()}@example.test`,
          tasks: ["view"], managementScopes: [], expiresAt },
        headers: { "idempotency-key": `test-member-invitation-${crypto.randomUUID()}`, cookie,
          "if-match": String(space.body.version), ...sameOriginHeaders }
      });
    assert.equal(invitation.status, 200, JSON.stringify(invitation.body));

    // This is the exact contract apps/web/src/app.js relies on (confirmDialogAction ->
    // `const url = result.inviteUrl;`), and what copyMemberUrl's regex requires.
    assert.equal(typeof invitation.body.inviteUrl, "string");
    assert.match(invitation.body.inviteUrl, /^\/member-invitations\/accept#invite=[A-Za-z0-9_-]+$/);
    assert.equal(invitation.body.inviteUrl, invitation.body.invitationBootstrapUrlOnce);
    // The one-time secret must not leak as a separate field once it is embedded in the URL.
    assert.equal(invitation.body.oneTimeSecret, undefined);
  } finally {
    await runtime.stop();
  }
});
