import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const origin = String(process.env.UNSEEN_STAGE_RC_ORIGIN ?? process.argv[2] ?? "http://127.0.0.1:4298")
  .replace(/\/$/u, "");
const dataRoot = path.resolve(process.env.UNSEEN_STAGE_RC_DATA_DIR ?? process.argv[3] ?? ".local-operable/data");
const mailbox = path.join(dataRoot, ".otp-mailbox.json");

class CookieJar {
  constructor() { this.values = new Map(); }
  capture(headers) {
    const values = typeof headers.getSetCookie === "function" ? headers.getSetCookie() :
      (headers.get("set-cookie") ? headers.get("set-cookie").split(/,\s*(?=__Host-)/u) : []);
    for (const value of values) {
      const [pair] = value.split(";", 1);
      const index = pair.indexOf("=");
      if (index > 0) this.values.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }
  header() { return [...this.values].map(([name, value]) => `${name}=${value}`).join("; "); }
}

async function request(jar, method, pathname, body, headers = {}) {
  const mutation = !["GET", "HEAD"].includes(method);
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: {
      accept: "application/json",
      ...(mutation ? { "content-type": "application/json", "idempotency-key": crypto.randomUUID(),
        origin, "sec-fetch-site": "same-origin" } : {}),
      ...(jar?.values.size ? { cookie: jar.header() } : {}),
      ...headers
    },
    body: mutation ? JSON.stringify(body ?? {}) : undefined
  });
  jar?.capture(response.headers);
  const value = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok, value };
}

async function ok(jar, method, pathname, body, headers) {
  const result = await request(jar, method, pathname, body, headers);
  assert.equal(result.ok, true, `${method} ${pathname}: ${result.status} ${JSON.stringify(result.value)}`);
  return result.value;
}

async function poll(run, label) {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    const result = await run().catch(() => null);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`five_actor_preflight_timeout:${label}`);
}

async function login(email) {
  const jar = new CookieJar();
  const challenge = await ok(jar, "POST", "/v1/auth/email-otp-challenges",
    { email, purpose: "login", locale: "zh-CN" });
  const otp = await poll(async () => {
    const value = JSON.parse(await readFile(mailbox, "utf8"));
    return value.challengeId === challenge.challengeId ? value.code : null;
  }, `otp:${email}`);
  const session = await ok(jar, "POST", "/v1/auth/email-otp-verifications",
    { challengeId: challenge.challengeId, otp, purpose: "login" });
  return { jar, session };
}

async function external(campaign, label) {
  const jar = new CookieJar();
  const publicCampaignId = new URL(campaign.publicCampaignUrl, origin).pathname.split("/").at(-1);
  const clientNonce = `${label}-${crypto.randomUUID()}`;
  await ok(jar, "POST", "/v1/external-campaign-admission-challenges", { publicCampaignId, clientNonce });
  const admission = await ok(jar, "POST", "/v1/external-campaign-admissions", { publicCampaignId, clientNonce });
  const secret = admission.oneTimeSecret ?? new URL(admission.bootstrapUrl, origin).hash.replace(/^#invite=/u, "");
  const exchange = await ok(jar, "POST", "/v1/external-invitation-exchanges",
    { secretFromClearedInviteBootstrap: secret, clientNonce });
  return { jar, exchange };
}

const health = await fetch(`${origin}/healthz`);
assert.equal(health.ok, true);
assert.equal(health.headers.get("x-unseen-runtime-id"), "unseen-stage-l-local-operable-v1");

const A = await login("stage-rc-owner@example.test");
const E = await login("stage-rc-member@example.test");
const space = await ok(A.jar, "POST", "/v1/spaces", { name: "Stage RC five actor preflight" });
await ok(A.jar, "POST", `/v1/spaces/${space.spaceId}/collection-transitions`, { to: "open" },
  { "if-match": '"space:1"' });
await ok(A.jar, "POST", `/v1/spaces/${space.spaceId}/sharing-transitions`, { to: "shared" },
  { "if-match": '"space:2"' });
const combo = await ok(A.jar, "POST", `/v1/spaces/${space.spaceId}/external-invitation-campaigns`, {
  taskMode: "combo", entryTask: "view", expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  maxSuccessfulUses: 10
}, { "if-match": '"space:3"' });
const viewOnly = await ok(A.jar, "POST", `/v1/spaces/${space.spaceId}/external-invitation-campaigns`, {
  taskMode: "view", entryTask: "view", expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  maxSuccessfulUses: 10
}, { "if-match": '"space:3"' });
const invitation = await ok(A.jar, "POST", `/v1/spaces/${space.spaceId}/member-invitations`, {
  verifiedIdentifier: "stage-rc-member@example.test", tasks: ["view"], managementScopes: [],
  expiresAt: new Date(Date.now() + 86_400_000).toISOString()
}, { "if-match": '"space:3"' });
await ok(E.jar, "POST", "/v1/member-invitation-acceptances",
  { secretFromClearedInviteBootstrap: invitation.oneTimeSecret });

const [B, D, C] = await Promise.all([
  external(combo, "actor-b"), external(combo, "actor-d"), external(viewOnly, "actor-c")
]);
assert.notEqual(B.exchange.campaignUseOrdinal, D.exchange.campaignUseOrdinal);
assert.notEqual(B.exchange.viewerPrincipalId, D.exchange.viewerPrincipalId);
assert.notEqual(B.exchange.contributorPrincipalId, D.exchange.contributorPrincipalId);

for (const actor of [B, C, D, E]) {
  assert.equal((await request(actor.jar, "GET", `/v1/viewer/spaces/${space.spaceId}`)).status, 200);
}
for (const actor of [B, D]) {
  assert.equal((await request(actor.jar, "GET", `/v1/spaces/${space.spaceId}/upload-context`)).status, 200);
}
assert.ok([401, 403, 404].includes((await request(C.jar, "GET", `/v1/spaces/${space.spaceId}/upload-context`)).status));
assert.ok([401, 403, 404].includes((await request(E.jar, "GET", `/v1/spaces/${space.spaceId}/management`)).status));

const uploadContext = await ok(B.jar, "GET", `/v1/spaces/${space.spaceId}/upload-context`);
const consent = await ok(B.jar, "POST", "/v1/consent-events", {
  purpose: "photo_upload", noticeVersion: uploadContext.noticeVersion, noticeHash: uploadContext.noticeHash,
  mediaPolicyVersion: uploadContext.mediaPolicyVersion, choices: uploadContext.choices
});
const batch = await ok(B.jar, "POST", `/v1/spaces/${space.spaceId}/contribution-batches`, {
  clientBatchId: `stage-rc-${crypto.randomUUID()}`, consentEventId: consent.consentEventId, declaredItemCount: 1
}, { "if-match": uploadContext.ifMatch });
assert.ok([401, 403, 404].includes((await request(D.jar, "GET", `/v1/contribution-batches/${batch.batchId}/result`)).status));
assert.equal((await request(B.jar, "GET", `/v1/contribution-batches/${batch.batchId}/result`)).status, 200);

process.stdout.write(`${JSON.stringify({
  schema: "unseen-stage-rc-five-actor-local-preflight/1",
  status: "PASS",
  releaseMeaning: "local_http_preflight_not_sandbox_integration_or_fixed_core_rc",
  actors: { A: "owner", B: "combo_contributor_viewer", C: "view_only", D: "second_combo_contributor_viewer",
    E: "scoped_member_view_only" },
  assertions: { isolatedComboOrdinals: true, isolatedComboPrincipals: true, viewOnlyCannotUpload: true,
    scopedMemberCannotManage: true, crossVisitorBatchBola: true, runtimeHttp: true, cloudWrites: 0 }
})}\n`);
