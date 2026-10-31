import test from "node:test";
import assert from "node:assert/strict";
import { dispatchCampaignSweep } from "../dispatch/campaign-sweeper.mjs";
import { dispatchOne } from "../dispatch/index.mjs";
import { fixture } from "../../api/tests/fixture-factory.mjs";

const originHeaders = { origin: "http://127.0.0.1:8787", host: "127.0.0.1:8787",
  "sec-fetch-site": "same-origin", "x-public-origin": "http://127.0.0.1:8787", "x-public-host": "127.0.0.1:8787" };

test("campaign sweeper releases pending capacity once and appends terminal audit once", async () => {
  const f = fixture();
  try {
    const owner = await f.login("sweeper@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const campaign = await f.ok("POST", `/v1/spaces/${space.spaceId}/external-invitation-campaigns`, {
      taskMode: "combo", expiresAt: "2026-08-13T02:00:00.000Z", maxSuccessfulUses: 5
    }, { ...owner.headers, "if-match": String(space.version) });
    const locator = new URL(campaign.publicCampaignUrl).pathname.split("/").at(-1);
    const nonce = "sweep-grant-nonce-123456789";
    const challenge = await f.ok("POST", "/v1/external-campaign-admission-challenges",
      { publicCampaignId: locator, clientNonce: nonce }, { ...originHeaders, "x-risk-scope": "sweep-a" });
    await f.ok("POST", "/v1/external-campaign-admissions",
      { publicCampaignId: locator, clientNonce: nonce }, { ...originHeaders, "x-risk-scope": "sweep-a",
        "x-campaign-challenge": challenge.challengeCookieSecret });
    await f.ok("POST", "/v1/external-campaign-admission-challenges",
      { publicCampaignId: locator, clientNonce: "unconsumed-challenge-123456" }, { ...originHeaders, "x-risk-scope": "sweep-b" });
    assert.equal(f.db.prepare("SELECT pending_admission_count FROM external_invitation_campaigns WHERE id=?")
      .get(campaign.campaignId).pending_admission_count, 1);
    f.clock.advance(3 * 60 * 60_000);
    const first = dispatchCampaignSweep(f.api.campaigns,
      { cutoffAt: f.clock.iso(), batchLimit: 100, leaseId: "lease-1" });
    assert.equal(first.campaignsExpired, 1);
    assert.equal(first.challengesExpired, 1);
    assert.equal(first.grantsExpired, 1);
    assert.equal(first.pendingReleased, 1);
    assert.equal(f.db.prepare("SELECT pending_admission_count FROM external_invitation_campaigns WHERE id=?")
      .get(campaign.campaignId).pending_admission_count, 0);
    const auditCount = f.db.prepare("SELECT COUNT(*) count FROM external_campaign_audit_events WHERE campaign_id=?")
      .get(campaign.campaignId).count;
    const replay = dispatchCampaignSweep(f.api.campaigns,
      { cutoffAt: f.clock.iso(), batchLimit: 100, leaseId: "lease-2" });
    assert.deepEqual(replay, { campaignsExpired: 0, challengesExpired: 0, grantsExpired: 0,
      pendingReleased: 0, auditEventsAppended: 0 });
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM external_campaign_audit_events WHERE campaign_id=?")
      .get(campaign.campaignId).count, auditCount);
  } finally { f.close(); }
});

test("unknown job type fails explicitly and replay is deterministic", () => {
  const f = fixture();
  try {
    const now = f.clock.iso();
    f.db.prepare(`INSERT INTO jobs(id,space_id,type,input_refs_json,input_hash,status,attempts,created_at,updated_at,version)
      VALUES('job_unknown','space_none','not_implemented','{}','hash','queued',0,?,?,1)`).run(now, now);
    const first = dispatchOne(f.db, "job_unknown", { now });
    assert.equal(first.status, "failed");
    assert.equal(first.stableError, "job_type_unavailable");
    const replay = dispatchOne(f.db, "job_unknown", { now });
    assert.equal(replay.replayed, true);
    assert.equal(replay.status, "failed");
  } finally { f.close(); }
});
