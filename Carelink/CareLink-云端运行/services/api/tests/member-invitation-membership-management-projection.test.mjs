import { approveFixtureRegistrations } from './approve-fixture-registrations.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Regression test for infra/integration/local-operable.mjs managementProjection() hardcoding
// `memberships: []` and `memberInvitations: []` instead of reading real rows. Consequence:
// the "/manage/{sid}" members tab (apps/web/src/ui/templates.js membersTab) always rendered
// empty, and MEMBER_INVITATION.REVOKE (apps/web/src/app.js: `management?.memberInvitations
// ?.find(...)?.ifMatch`) could never find an ifMatch token, so revocation always failed.
// This spawns the real local-operable runtime end to end (HTTP only, matching the sibling
// member-invitation-invite-url-projection.test.mjs pattern) to prove the GET management read
// model now surfaces a masked-email invitation with a working If-Match token, and that the
// REVOKE action built from that projection actually succeeds against the real API.

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

async function loginViaOtp(origin, email) {
  const challenge = await jsonRequest(origin, "POST", "/v1/auth/email-otp-challenges", {
    body: { email, purpose: "login", locale: "zh-CN" },
    headers: { "idempotency-key": `test-otp-challenge-${crypto.randomUUID()}` }
  });
  assert.equal(challenge.status, 200, JSON.stringify(challenge.body));
  return challenge.body.challengeId;
}

test("local-operable projects real memberships/memberInvitations with masked email and working ifMatch", async () => {
  const runtime = await startLocalOperable();
  try {
    const ownerEmail = `owner-members-projection-${Date.now()}@example.test`;
    const memberEmail = `invitee-members-projection-${Date.now()}@example.test`;

    const challengeId = await loginViaOtp(runtime.origin, ownerEmail);
    const mailboxPath = path.join(runtime.dataRoot, ".otp-mailbox.json");
    const mailbox = await poll(async () => {
      const value = JSON.parse(await readFile(mailboxPath, "utf8"));
      return value.challengeId === challengeId ? value : null;
    }, "otp mailbox");

    const verified = await jsonRequest(runtime.origin, "POST", "/v1/auth/email-otp-verifications", {
      body: { challengeId, otp: mailbox.code, purpose: "login" },
      headers: { "idempotency-key": `test-otp-verify-${crypto.randomUUID()}` }
    });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    const accountSecret = extractCookie(verified, "__Host-unseen_account");
    assert.ok(accountSecret, "expected __Host-unseen_account session cookie");
    const cookie = `__Host-unseen_account=${accountSecret}`;
    const sameOriginHeaders = { origin: runtime.origin, "sec-fetch-site": "same-origin" };

    const space = await jsonRequest(runtime.origin, "POST", "/v1/spaces", {
      body: { name: "Members Projection Space" },
      headers: { "idempotency-key": `test-space-${crypto.randomUUID()}`, cookie, ...sameOriginHeaders }
    });
    assert.equal(space.status, 200, JSON.stringify(space.body));
    const spaceId = space.body.spaceId;

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const invitation = await jsonRequest(runtime.origin, "POST", `/v1/spaces/${spaceId}/member-invitations`, {
      body: { verifiedIdentifier: memberEmail, tasks: ["view"], managementScopes: [], expiresAt },
      headers: { "idempotency-key": `test-member-invitation-${crypto.randomUUID()}`, cookie,
        "if-match": String(space.body.version), ...sameOriginHeaders }
    });
    assert.equal(invitation.status, 200, JSON.stringify(invitation.body));
    const invitationId = invitation.body.invitationId;

    // This is the exact read model apps/web/src/ui/templates.js membersTab() and
    // apps/web/src/app.js confirmDialogAction() consume for the "/manage/{sid}" members tab.
    const management = await jsonRequest(runtime.origin, "GET", `/v1/spaces/${spaceId}/management`, {
      headers: { cookie }
    });
    assert.equal(management.status, 200, JSON.stringify(management.body));
    assert.ok(Array.isArray(management.body.memberInvitations), "expected memberInvitations array");
    assert.ok(management.body.memberInvitations.length > 0, "expected a non-empty memberInvitations array");
    assert.ok(Array.isArray(management.body.memberships), "expected memberships array");

    const projectedInvitation = management.body.memberInvitations.find((entry) => entry.id === invitationId);
    assert.ok(projectedInvitation, "expected the created invitation to appear in the management projection");
    assert.equal(projectedInvitation.status, "pending");
    assert.equal(typeof projectedInvitation.ifMatch, "string");
    assert.ok(projectedInvitation.ifMatch.length > 0, "expected a non-empty ifMatch token");

    // Privacy: never project the plaintext email, only the masked display form.
    assert.equal(typeof projectedInvitation.emailMask, "string");
    assert.ok(projectedInvitation.emailMask.length > 0, "expected a non-empty emailMask");
    assert.notEqual(projectedInvitation.emailMask, memberEmail);
    assert.ok(!projectedInvitation.emailMask.includes(memberEmail), "emailMask must not embed the plaintext address");
    assert.match(projectedInvitation.emailMask, /\*/, "emailMask should be masked, not the plain address");
    assert.equal(JSON.stringify(management.body).includes(memberEmail), false,
      "the plaintext invitee email must never appear anywhere in the management projection");

    // The revoke action (apps/web/src/app.js MEMBER_INVITATION.REVOKE) sends this exact
    // ifMatch value straight through as the If-Match header (apps/web/src/api/http-adapter.js).
    const revoke = await jsonRequest(runtime.origin, "POST", `/v1/member-invitations/${invitationId}/revocations`, {
      body: { reason: "owner_revoked" },
      headers: { "idempotency-key": `test-member-invitation-revoke-${crypto.randomUUID()}`, cookie,
        "if-match": projectedInvitation.ifMatch, ...sameOriginHeaders }
    });
    assert.equal(revoke.status, 200, JSON.stringify(revoke.body));

    const afterRevoke = await jsonRequest(runtime.origin, "GET", `/v1/spaces/${spaceId}/management`, { headers: { cookie } });
    const revokedInvitation = afterRevoke.body.memberInvitations.find((entry) => entry.id === invitationId);
    assert.ok(revokedInvitation, "expected the revoked invitation to still be listed (for history)");
    assert.equal(revokedInvitation.status, "revoked");
  } finally {
    await runtime.stop();
  }
});

test("local-operable projects an accepted membership with masked email and a working MEMBERSHIP.REVOKE ifMatch", async () => {
  const runtime = await startLocalOperable();
  try {
    const ownerEmail = `owner-membership-projection-${Date.now()}@example.test`;
    const memberEmail = `member-membership-projection-${Date.now()}@example.test`;

    const ownerChallengeId = await loginViaOtp(runtime.origin, ownerEmail);
    const mailboxPath = path.join(runtime.dataRoot, ".otp-mailbox.json");
    const ownerMailbox = await poll(async () => {
      const value = JSON.parse(await readFile(mailboxPath, "utf8"));
      return value.challengeId === ownerChallengeId ? value : null;
    }, "owner otp mailbox");
    const ownerVerified = await jsonRequest(runtime.origin, "POST", "/v1/auth/email-otp-verifications", {
      body: { challengeId: ownerChallengeId, otp: ownerMailbox.code, purpose: "login" },
      headers: { "idempotency-key": `test-otp-verify-owner-${crypto.randomUUID()}` }
    });
    assert.equal(ownerVerified.status, 200, JSON.stringify(ownerVerified.body));
    const ownerCookie = `__Host-unseen_account=${extractCookie(ownerVerified, "__Host-unseen_account")}`;
    const sameOriginHeaders = { origin: runtime.origin, "sec-fetch-site": "same-origin" };

    const space = await jsonRequest(runtime.origin, "POST", "/v1/spaces", {
      body: { name: "Membership Projection Space" },
      headers: { "idempotency-key": `test-space-${crypto.randomUUID()}`, cookie: ownerCookie, ...sameOriginHeaders }
    });
    assert.equal(space.status, 200, JSON.stringify(space.body));
    const spaceId = space.body.spaceId;

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const invitation = await jsonRequest(runtime.origin, "POST", `/v1/spaces/${spaceId}/member-invitations`, {
      body: { verifiedIdentifier: memberEmail, tasks: ["view"], managementScopes: ["canReview"], expiresAt },
      headers: { "idempotency-key": `test-member-invitation-${crypto.randomUUID()}`, cookie: ownerCookie,
        "if-match": String(space.body.version), ...sameOriginHeaders }
    });
    assert.equal(invitation.status, 200, JSON.stringify(invitation.body));

    // Log in as the invitee and accept the invitation so a real space_memberships row exists.
    const memberChallengeId = await loginViaOtp(runtime.origin, memberEmail);
    const memberMailbox = await poll(async () => {
      const value = JSON.parse(await readFile(mailboxPath, "utf8"));
      return value.challengeId === memberChallengeId ? value : null;
    }, "member otp mailbox");
    const memberVerified = await jsonRequest(runtime.origin, "POST", "/v1/auth/email-otp-verifications", {
      body: { challengeId: memberChallengeId, otp: memberMailbox.code, purpose: "login" },
      headers: { "idempotency-key": `test-otp-verify-member-${crypto.randomUUID()}` }
    });
    assert.equal(memberVerified.status, 200, JSON.stringify(memberVerified.body));
    const memberCookie = `__Host-unseen_account=${extractCookie(memberVerified, "__Host-unseen_account")}`;

    const accept = await jsonRequest(runtime.origin, "POST", "/v1/member-invitation-acceptances", {
      body: { secretFromClearedInviteBootstrap: invitation.body.inviteUrl.split("invite=")[1], clientNonce: crypto.randomUUID() },
      headers: { "idempotency-key": `test-member-invitation-accept-${crypto.randomUUID()}`, cookie: memberCookie, ...sameOriginHeaders }
    });
    assert.equal(accept.status, 200, JSON.stringify(accept.body));
    const membershipId = accept.body.membershipId;

    const management = await jsonRequest(runtime.origin, "GET", `/v1/spaces/${spaceId}/management`, { headers: { cookie: ownerCookie } });
    assert.equal(management.status, 200, JSON.stringify(management.body));
    const projectedMembership = management.body.memberships.find((entry) => entry.id === membershipId);
    assert.ok(projectedMembership, "expected the accepted membership to appear in the management projection");
    assert.equal(projectedMembership.status, "active");
    assert.deepEqual(projectedMembership.tasks, ["view"]);
    assert.deepEqual(projectedMembership.managementScopes, ["canReview"]);
    assert.equal(typeof projectedMembership.ifMatch, "string");
    assert.ok(projectedMembership.ifMatch.length > 0, "expected a non-empty ifMatch token");

    // Privacy: only the masked email should ever be projected.
    assert.equal(typeof projectedMembership.emailMask, "string");
    assert.ok(projectedMembership.emailMask.length > 0);
    assert.notEqual(projectedMembership.emailMask, memberEmail);
    assert.equal(JSON.stringify(management.body).includes(memberEmail), false,
      "the plaintext member email must never appear anywhere in the management projection");

    // MEMBERSHIP.REVOKE (apps/web/src/app.js) forwards this ifMatch straight through as If-Match.
    const revoke = await jsonRequest(runtime.origin, "DELETE", `/v1/spaces/${spaceId}/memberships/${membershipId}`, {
      body: { reason: "owner_revoked" },
      headers: { "idempotency-key": `test-membership-revoke-${crypto.randomUUID()}`, cookie: ownerCookie,
        "if-match": projectedMembership.ifMatch, ...sameOriginHeaders }
    });
    assert.equal(revoke.status, 200, JSON.stringify(revoke.body));

    const afterRevoke = await jsonRequest(runtime.origin, "GET", `/v1/spaces/${spaceId}/management`, { headers: { cookie: ownerCookie } });
    const revokedMembership = afterRevoke.body.memberships.find((entry) => entry.id === membershipId);
    assert.ok(revokedMembership, "expected the revoked membership to still be listed (for history)");
    assert.equal(revokedMembership.status, "revoked");
  } finally {
    await runtime.stop();
  }
});
