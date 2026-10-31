import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixture-factory.mjs";

// GET /v1/external-invitation-campaigns/{token}/preview backs the /open/{token} admission page:
// it lets the page show the real space name *before* the visitor clicks "继续打开" (the only moment
// the real challenge/admission/exchange flow runs). It must never mint a challenge or grant, never
// touch admission counters, and must answer an unknown/dead token exactly like a rate-limited one so
// a visitor (or scanner) can never learn whether a given token exists.

const originHeaders = { origin: "http://127.0.0.1:8787", host: "127.0.0.1:8787",
  "sec-fetch-site": "same-origin", "x-public-origin": "http://127.0.0.1:8787", "x-public-host": "127.0.0.1:8787" };

async function createCampaign(f, { name = "夏日聚会 · 模板空间", taskMode = "combo" } = {}) {
  const owner = await f.login(`preview-owner-${Math.random()}@example.test`);
  let space = await f.createSpace(owner, name);
  space = await f.openSpace(owner, space);
  const campaign = await f.ok("POST", `/v1/spaces/${space.spaceId}/external-invitation-campaigns`, {
    taskMode, expiresAt: "2026-08-14T00:00:00.000Z", maxSuccessfulUses: 100
  }, { ...owner.headers, "if-match": String(space.version) });
  const token = new URL(campaign.publicCampaignUrl).pathname.split("/").at(-1);
  return { owner, space, campaign, token };
}

function previewRequest(f, token, riskScope = "preview-test-adapter") {
  return f.api.handle({ method: "GET", path: `/v1/external-invitation-campaigns/${token}/preview`,
    headers: originHeaders, observedRiskScope: riskScope });
}

test("preview returns the live campaign's real space name and produces zero admission side effects", async () => {
  const f = fixture();
  try {
    const { space, campaign, token } = await createCampaign(f);
    const before = f.db.prepare("SELECT pending_admission_count,successful_use_count,version FROM external_invitation_campaigns WHERE id=?").get(campaign.campaignId);

    const result = await f.call("GET", `/v1/external-invitation-campaigns/${token}/preview`, {}, originHeaders);

    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { displayName: space.name });
    assert.notEqual(space.name, "向晚婚礼", "the fixture must prove a non-demo name round-trips, not just the familiar fixture value");
    assert.equal(result.headers["cache-control"], "no-store");

    const after = f.db.prepare("SELECT pending_admission_count,successful_use_count,version FROM external_invitation_campaigns WHERE id=?").get(campaign.campaignId);
    assert.deepEqual(after, before, "preview must not touch the campaign row at all");
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM external_invitation_grants WHERE campaign_id=?").get(campaign.campaignId).n, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM external_campaign_admission_challenges WHERE campaign_id=?").get(campaign.campaignId).n, 0);
  } finally { f.close(); }
});

test("an unknown token and a revoked campaign return the identical unavailable shape — token existence never leaks", async () => {
  const f = fixture();
  try {
    const { campaign, token } = await createCampaign(f);

    const unknown = await f.call("GET", "/v1/external-invitation-campaigns/does-not-exist-at-all/preview", {}, originHeaders);
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, "campaign_preview_unavailable");

    f.db.prepare("UPDATE external_invitation_campaigns SET campaign_status='revoked',revoked_at=?,version=version+1 WHERE id=?")
      .run(f.clock.iso(), campaign.campaignId);
    const revoked = await f.call("GET", `/v1/external-invitation-campaigns/${token}/preview`, {}, originHeaders);

    assert.equal(revoked.status, unknown.status);
    assert.equal(revoked.body.error.code, "campaign_preview_unavailable");
    assert.equal(revoked.body.error.code, unknown.body.error.code);
    assert.deepEqual(Object.keys(revoked.body.error).sort(), Object.keys(unknown.body.error).sort(),
      "response shape for unknown vs. revoked tokens must be structurally identical (only requestId may differ)");
  } finally { f.close(); }
});

test("preview enforces the same view/sharing gate as the real admission flow", async () => {
  const f = fixture();
  try {
    const owner = await f.login("preview-private-space@example.test");
    let space = await f.createSpace(owner, "私密空间");
    space = await f.openSpace(owner, space);
    const campaign = await f.ok("POST", `/v1/spaces/${space.spaceId}/external-invitation-campaigns`, {
      taskMode: "view", expiresAt: "2026-08-14T00:00:00.000Z", maxSuccessfulUses: 10
    }, { ...owner.headers, "if-match": String(space.version) });
    const token = new URL(campaign.publicCampaignUrl).pathname.split("/").at(-1);

    // A "view" campaign requires sharing_state='shared'; flip it back to private after minting.
    await f.transition(owner, space.spaceId, "sharing", "private", space.version);

    const result = await f.call("GET", `/v1/external-invitation-campaigns/${token}/preview`, {}, originHeaders);
    assert.equal(result.status, 404);
    assert.equal(result.body.error.code, "campaign_preview_unavailable");
  } finally { f.close(); }
});

test("preview is rate-limited per risk scope and cannot drain the admission-challenge budget", async () => {
  const f = fixture();
  try {
    const { token } = await createCampaign(f);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await previewRequest(f, token, "shared-visitor");
      assert.equal(result.status, 200, `preview attempt ${attempt + 1} of 20 should still be within budget`);
    }
    const throttled = await previewRequest(f, token, "shared-visitor");
    assert.equal(throttled.status, 404);
    assert.equal(throttled.body.error.code, "campaign_preview_unavailable");

    // A different risk scope is a fresh bucket.
    const otherVisitor = await previewRequest(f, token, "another-visitor");
    assert.equal(otherVisitor.status, 200);

    // Exhausting preview's budget must not touch the separate admission-challenge counter: the
    // real "继续打开" flow for the same visitor still works.
    const challenge = await f.api.handle({ method: "POST", path: "/v1/external-campaign-admission-challenges",
      body: { publicCampaignId: token, clientNonce: "shared-visitor-nonce-1234567890" },
      headers: { ...originHeaders, "idempotency-key": "preview-rate-idem-abcdefgh" }, observedRiskScope: "shared-visitor" });
    assert.equal(challenge.status, 200);
  } finally { f.close(); }
});
