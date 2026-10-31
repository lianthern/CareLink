import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixture-factory.mjs";

const originHeaders = { origin: "http://127.0.0.1:8787", host: "127.0.0.1:8787",
  "sec-fetch-site": "same-origin", "x-public-origin": "http://127.0.0.1:8787", "x-public-host": "127.0.0.1:8787" };

async function admit(f, campaign, visitor) {
  const nonce = `visitor-${visitor}-nonce-1234567890`;
  const challenge = await f.ok("POST", "/v1/external-campaign-admission-challenges",
    { publicCampaignId: campaign.publicCampaignId, clientNonce: nonce }, { ...originHeaders, "x-risk-scope": visitor });
  const admission = await f.ok("POST", "/v1/external-campaign-admissions",
    { publicCampaignId: campaign.publicCampaignId, clientNonce: nonce },
    { ...originHeaders, "x-risk-scope": visitor, "x-campaign-challenge": challenge.challengeCookieSecret });
  return { challenge, admission };
}

test("account session secret is stored only as a keyed MAC", async () => {
  const f = fixture();
  try {
    const account = await f.login("hash-check@example.test");
    const row = f.db.prepare("SELECT credential_mac,credential_key_id FROM account_sessions WHERE id=?")
      .get(account.accountSessionId);
    assert.ok(ArrayBuffer.isView(row.credential_mac));
    assert.ok(row.credential_key_id);
    assert.notEqual(row.credential_mac.toString("utf8"), account.token);
    assert.equal(JSON.stringify(f.db.prepare("SELECT * FROM account_sessions WHERE id=?").get(account.accountSessionId))
      .includes(account.token), false);
  } finally { f.close(); }
});

test("member invitation is verified-account bound and wrong account fails closed", async () => {
  const f = fixture();
  try {
    const owner = await f.login("owner@example.test");
    const target = await f.login("member@example.test");
    const wrong = await f.login("wrong@example.test");
    const space = await f.createSpace(owner);
    const invitation = await f.ok("POST", `/v1/spaces/${space.spaceId}/member-invitations`, {
      verifiedIdentifier: "member@example.test", tasks: ["view"], managementScopes: [],
      expiresAt: "2026-08-14T00:00:00.000Z"
    }, { ...owner.headers, "if-match": String(space.version) });
    const wrongResult = await f.call("POST", "/v1/member-invitation-acceptances",
      { secretFromClearedInviteBootstrap: invitation.oneTimeSecret }, wrong.headers);
    assert.equal(wrongResult.status, 404);
    assert.equal(wrongResult.body.error.code, "member_invite_unavailable");
    const accepted = await f.ok("POST", "/v1/member-invitation-acceptances",
      { secretFromClearedInviteBootstrap: invitation.oneTimeSecret }, target.headers);
    assert.equal(accepted.accountId, target.accountId);
    assert.equal(accepted.spaceId, space.spaceId);
  } finally { f.close(); }
});

test("campaign URL is a locator; each visitor gets a distinct one-time grant and isolated principal", async () => {
  const f = fixture();
  try {
    const owner = await f.login("campaign-owner@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const campaign = await f.ok("POST", `/v1/spaces/${space.spaceId}/external-invitation-campaigns`, {
      taskMode: "combo", entryTask: "view", expiresAt: "2026-08-14T00:00:00.000Z", maxSuccessfulUses: 2
    }, { ...owner.headers, "if-match": String(space.version) });
    campaign.publicCampaignId = new URL(campaign.publicCampaignUrl).pathname.split("/").at(-1);
    assert.equal(campaign.publicCampaignUrl.includes("#invite="), false);
    assert.equal(campaign.qrPayload, campaign.publicCampaignUrl);

    const first = await admit(f, campaign, "visitor-a");
    const second = await admit(f, campaign, "visitor-b");
    assert.notEqual(first.admission.oneTimeSecret, second.admission.oneTimeSecret);
    const [exchangeA, exchangeB] = await Promise.all([
      f.call("POST", "/v1/external-invitation-exchanges", { secretFromClearedInviteBootstrap: first.admission.oneTimeSecret }),
      f.call("POST", "/v1/external-invitation-exchanges", { secretFromClearedInviteBootstrap: second.admission.oneTimeSecret })
    ]);
    assert.equal(exchangeA.status, 200);
    assert.equal(exchangeB.status, 200);
    assert.deepEqual([exchangeA.body.campaignUseOrdinal, exchangeB.body.campaignUseOrdinal].sort(), [1, 2]);
    assert.notEqual(exchangeA.body.viewerPrincipalId, exchangeB.body.viewerPrincipalId);
    assert.notEqual(exchangeA.body.contributorPrincipalId, exchangeB.body.contributorPrincipalId);
    assert.equal(f.db.prepare("SELECT successful_use_count FROM external_invitation_campaigns WHERE id=?")
      .get(campaign.campaignId).successful_use_count, 2);
  } finally { f.close(); }
});

test("campaign admission enforces same origin, capacity, and archived/private state", async () => {
  const f = fixture();
  try {
    const owner = await f.login("campaign-state@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const campaign = await f.ok("POST", `/v1/spaces/${space.spaceId}/external-invitation-campaigns`, {
      taskMode: "view", expiresAt: "2026-08-14T00:00:00.000Z", maxSuccessfulUses: 1
    }, { ...owner.headers, "if-match": String(space.version) });
    campaign.publicCampaignId = new URL(campaign.publicCampaignUrl).pathname.split("/").at(-1);
    const crossOrigin = await f.call("POST", "/v1/external-campaign-admission-challenges",
      { publicCampaignId: campaign.publicCampaignId, clientNonce: "nonce-1234567890123456" },
      { origin: "https://evil.test", host: "127.0.0.1:8787", "sec-fetch-site": "cross-site" });
    assert.equal(crossOrigin.status, 403);
    const first = await admit(f, campaign, "capacity-a");
    const secondChallenge = await f.call("POST", "/v1/external-campaign-admission-challenges",
      { publicCampaignId: campaign.publicCampaignId, clientNonce: "capacity-b-nonce-123456" }, { ...originHeaders, "x-risk-scope": "capacity-b" });
    assert.equal(secondChallenge.status, 404);
    await f.ok("POST", "/v1/external-invitation-exchanges",
      { secretFromClearedInviteBootstrap: first.admission.oneTimeSecret });
    const exhausted = await f.call("POST", "/v1/external-campaign-admission-challenges",
      { publicCampaignId: campaign.publicCampaignId, clientNonce: "capacity-c-nonce-123456" }, { ...originHeaders, "x-risk-scope": "capacity-c" });
    assert.equal(exhausted.status, 404);
  } finally { f.close(); }
});

test("campaign admission rechecks the current server risk binding and exhausted rate bucket", async () => {
  const f = fixture();
  try {
    const owner = await f.login("campaign-admission-risk@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const campaign = await f.ok("POST", `/v1/spaces/${space.spaceId}/external-invitation-campaigns`, {
      taskMode: "view", expiresAt: "2026-08-14T00:00:00.000Z", maxSuccessfulUses: 100
    }, { ...owner.headers, "if-match": String(space.version) });
    const locator = new URL(campaign.publicCampaignUrl).pathname.split("/").at(-1);
    async function rawRisk(path, body, risk, challengeSecret = null) {
      return f.api.handle({ method: "POST", path, body, observedRiskScope: risk, headers: {
        "idempotency-key": `risk-${crypto.randomUUID()}-abcdefgh`, ...originHeaders,
        ...(challengeSecret ? { "x-campaign-challenge": challengeSecret } : {})
      } });
    }
    const nonce = "risk-bound-nonce-123456789";
    const challenge = await rawRisk("/v1/external-campaign-admission-challenges",
      { publicCampaignId: locator, clientNonce: nonce }, "risk-a");
    assert.equal(challenge.status, 200);
    const wrongRisk = await rawRisk("/v1/external-campaign-admissions",
      { publicCampaignId: locator, clientNonce: nonce }, "risk-b", challenge.body.challengeCookieSecret);
    assert.equal(wrongRisk.status, 404);
    assert.equal(wrongRisk.body.error.code, "campaign_unavailable");
    const challengeRow = f.db.prepare("SELECT * FROM external_campaign_admission_challenges WHERE id=?")
      .get(challenge.body.challengeId);
    f.db.prepare(`UPDATE external_campaign_rate_counters SET count=20 WHERE campaign_id=?
      AND risk_key_id=? AND risk_key_mac=? AND policy_version=?`).run(campaign.campaignId,
    challengeRow.risk_key_id, challengeRow.risk_key_mac, challengeRow.policy_version);
    const exhausted = await rawRisk("/v1/external-campaign-admissions",
      { publicCampaignId: locator, clientNonce: nonce }, "risk-a", challenge.body.challengeCookieSecret);
    assert.equal(exhausted.status, 404);
    assert.equal(exhausted.body.error.code, "campaign_unavailable");
    assert.equal(f.db.prepare("SELECT consumed_at FROM external_campaign_admission_challenges WHERE id=?")
      .get(challenge.body.challengeId).consumed_at, null);
  } finally { f.close(); }
});

test("ordinary idempotent replay reauthorizes current owner relationship", async () => {
  const f = fixture();
  try {
    const owner = await f.login("replay-owner@example.test");
    const replacement = await f.login("replacement-owner@example.test");
    const space = await f.createSpace(owner);
    const headers = { ...owner.headers, "if-match": String(space.version), "idempotency-key": "fixed-replay-key-abcdefgh" };
    const first = await f.call("POST", `/v1/spaces/${space.spaceId}/collection-transitions`, { to: "open" }, headers);
    assert.equal(first.status, 200);
    f.db.prepare("UPDATE spaces SET owner_account_id=?,version=version+1 WHERE id=?").run(replacement.accountId, space.spaceId);
    const replay = await f.call("POST", `/v1/spaces/${space.spaceId}/collection-transitions`, { to: "open" }, headers);
    assert.equal(replay.status, 403);
    assert.equal(replay.body.error.code, "owner_required");
  } finally { f.close(); }
});
