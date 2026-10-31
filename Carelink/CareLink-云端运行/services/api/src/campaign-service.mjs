import { ApiError, assert } from "./errors.mjs";
import { transaction } from "./database.mjs";
import { id, json, parseJson, secret } from "./util.mjs";
import { object, string } from "./schemas.mjs";

const taskMap = {
  view: ["view"],
  upload: ["upload"],
  combo: ["view", "upload"]
};

export class CampaignService {
  constructor(core, { publicOrigin = "http://127.0.0.1:8787" } = {}) {
    this.core = core;
    this.db = core.db;
    this.publicOrigin = publicOrigin.replace(/\/$/, "");
  }

  assertCampaignSpace(campaign, space, { newAdmission = true } = {}) {
    const tasks = parseJson(campaign.tasks_json, []);
    const liveStatus = newAdmission ? campaign.campaign_status === "active" : ["active", "exhausted"].includes(campaign.campaign_status);
    assert(liveStatus && !campaign.revoked_at && Date.parse(campaign.expires_at) > this.core.nowMs() &&
      space?.space_lifecycle === "active" && (!tasks.includes("view") || space.sharing_state === "shared") &&
      (!tasks.includes("upload") || space.collection_state === "open"), "campaign_unavailable", 404);
    return tasks;
  }

  create(ctx, accountCtx, spaceId) {
    const body = object(ctx.body, ["taskMode", "entryTask", "expiresAt", "maxSuccessfulUses"],
      ["taskMode", "expiresAt", "maxSuccessfulUses"]);
    const tasks = taskMap[body.taskMode];
    assert(tasks, "campaign_policy_invalid");
    const entryTask = body.entryTask ?? (body.taskMode === "combo" ? "view" : body.taskMode);
    assert(tasks.includes(entryTask), "campaign_policy_invalid");
    const expiresAt = new Date(body.expiresAt).toISOString();
    const maxUses = Number(body.maxSuccessfulUses);
    assert(Date.parse(expiresAt) > this.core.nowMs() && Number.isSafeInteger(maxUses) && maxUses > 0 && maxUses <= 100_000,
      "campaign_policy_invalid");
    return this.core.mutation(ctx, { endpoint: `/v1/spaces/${spaceId}/external-invitation-campaigns`, scope: accountCtx.session.id,
      reauthorize: () => this.core.accountSpace(this.core.account(ctx.accountSession), spaceId, { scope: "canInvite" }) }, () => {
      const access = this.core.accountSpace(accountCtx, spaceId, { scope: "canInvite" });
      this.core.requireIfMatch(ctx, access.space);
      assert((!tasks.includes("view") || access.space.sharing_state === "shared") &&
        (!tasks.includes("upload") || access.space.collection_state === "open"), "space_state_conflict", 409);
      const campaignId = id("campaign");
      const publicCampaignId = secret();
      const policy = { maxPending: Math.min(100, maxUses), rate: "local-rate-v1", abuse: "local-abuse-v1" };
      this.db.prepare(`INSERT INTO external_invitation_campaigns(
        id,space_id,public_campaign_id,task_mode,tasks_json,entry_task,campaign_status,expires_at,
        max_successful_uses,successful_use_count,pending_admission_count,max_pending_admissions,
        rate_policy_version,abuse_policy_version,created_by,version
      ) VALUES(?,?,?,?,?,?,'active',?, ?,0,0,?,?,?, ?,1)`).run(campaignId, spaceId, publicCampaignId,
      body.taskMode, json(tasks), entryTask, expiresAt, maxUses, policy.maxPending, policy.rate, policy.abuse, accountCtx.accountId);
      this.db.prepare(`INSERT INTO external_campaign_audit_events(
        id,space_id,campaign_id,event_type,subject_kind,subject_id,policy_version,actor_auth_kind,authorization_id,request_id,created_at
      ) VALUES(?,?,?,'created','campaign',?,?,?,?,?,?)`).run(id("cae"), spaceId, campaignId, campaignId,
      policy.abuse, access.authKind, access.authorizationId, ctx.requestId, this.core.now());
      return this.shareRow(this.core.one("SELECT * FROM external_invitation_campaigns WHERE id=?", campaignId));
    });
  }

  shareRow(campaign) {
    const publicCampaignUrl = `${this.publicOrigin}/open/${campaign.public_campaign_id}`;
    return {
      campaignId: campaign.id,
      publicCampaignUrl,
      qrPayload: publicCampaignUrl,
      taskMode: campaign.task_mode,
      tasks: parseJson(campaign.tasks_json),
      entryTask: campaign.entry_task,
      campaignStatus: campaign.campaign_status,
      expiresAt: campaign.expires_at,
      successfulUseCount: campaign.successful_use_count,
      pendingAdmissionCount: campaign.pending_admission_count,
      maxSuccessfulUses: campaign.max_successful_uses,
      version: campaign.version
    };
  }

  // Public, read-only preview for the /open/{token} admission page: the page has to show
  // *something* honest before the visitor clicks "继续打开" (which is the only moment the real
  // exchange flow runs), but it must never mint a challenge/grant or touch admission counters.
  // It resolves the same way admission() would (assertCampaignSpace) so a live campaign always
  // yields a name, then applies its own rate-limit family so preview traffic can never drain the
  // admission-challenge budget. Every failure path (unknown token, dead campaign, rate limit)
  // throws the exact same error so an invalid token cannot be distinguished from a throttled one.
  preview(ctx, token) {
    const campaign = this.core.one("SELECT * FROM external_invitation_campaigns WHERE public_campaign_id=?", token);
    const space = campaign ? this.core.one("SELECT * FROM spaces WHERE id=?", campaign.space_id) : null;
    try { this.assertCampaignSpace(campaign, space); } catch { throw new ApiError("campaign_preview_unavailable", 404); }
    const riskMac = this.core.keyring.mac("campaign-preview-risk-v1", `${campaign.id}\0${ctx.riskScope}`);
    const bucketMs = Math.floor(this.core.nowMs() / 3_600_000) * 3_600_000;
    const bucket = new Date(bucketMs).toISOString();
    const policyVersion = "local-preview-rate-v1";
    return transaction(this.db, () => {
      const counter = this.core.one(`SELECT * FROM external_campaign_rate_counters WHERE campaign_id=? AND risk_key_id=?
        AND risk_key_mac=? AND bucket_start=? AND policy_version=?`, campaign.id, this.core.keyring.keyId,
      riskMac, bucket, policyVersion);
      if (counter?.count >= 20) throw new ApiError("campaign_preview_unavailable", 404);
      if (counter) this.db.prepare("UPDATE external_campaign_rate_counters SET count=count+1,version=version+1 WHERE campaign_id=? AND risk_key_id=? AND risk_key_mac=? AND bucket_start=? AND policy_version=? AND version=?")
        .run(campaign.id, this.core.keyring.keyId, riskMac, bucket, policyVersion, counter.version);
      else this.db.prepare(`INSERT INTO external_campaign_rate_counters(
        campaign_id,risk_key_mac,risk_key_id,bucket_start,policy_version,count,expires_at,version
      ) VALUES(?,?,?,?,?,1,?,1)`).run(campaign.id, riskMac, this.core.keyring.keyId, bucket, policyVersion,
      new Date(bucketMs + 2 * 3_600_000).toISOString());
      return { displayName: space.name };
    });
  }

  get(accountCtx, spaceId, campaignId) {
    this.core.accountSpace(accountCtx, spaceId, { scope: "canInvite" });
    const campaign = this.core.one("SELECT * FROM external_invitation_campaigns WHERE id=? AND space_id=?", campaignId, spaceId);
    assert(campaign, "campaign_management_unavailable", 404);
    const audit = this.core.all(`SELECT event_type eventType,reason_class reasonClass,COUNT(*) count
      FROM external_campaign_audit_events WHERE campaign_id=? GROUP BY event_type,reason_class`, campaignId);
    return { ...this.shareRow(campaign), auditSummary: audit };
  }

  challenge(ctx) {
    const body = object(ctx.body, ["publicCampaignId", "clientNonce"], ["publicCampaignId", "clientNonce"]);
    assert(ctx.sameOrigin === true, "request_origin_invalid", 403);
    string(body.clientNonce, { min: 16, max: 200 });
    const scopedRisk = this.core.keyring.mac("campaign-risk-scope-v1", ctx.riskScope).toString("hex");
    const result = this.core.mutation(ctx, { endpoint: "/v1/external-campaign-admission-challenges",
      scope: `campaign-locator:${body.publicCampaignId}:${scopedRisk}`, replayClass: "credential_reissue",
      reissue: (completed) => this.reissueChallenge(completed) }, () => {
      const campaign = this.core.one("SELECT * FROM external_invitation_campaigns WHERE public_campaign_id=?", body.publicCampaignId);
      const space = campaign ? this.core.one("SELECT * FROM spaces WHERE id=?", campaign.space_id) : null;
      try { this.assertCampaignSpace(campaign, space); } catch { return { _error: "campaign_unavailable" }; }
      assert(campaign.successful_use_count < campaign.max_successful_uses &&
        campaign.pending_admission_count < campaign.max_pending_admissions, "campaign_unavailable", 404);
      const riskMac = this.core.keyring.mac("campaign-risk-v1", `${campaign.id}\0${ctx.riskScope}`);
      const bucketMs = Math.floor(this.core.nowMs() / 3_600_000) * 3_600_000;
      const bucket = new Date(bucketMs).toISOString();
      const counter = this.core.one(`SELECT * FROM external_campaign_rate_counters WHERE campaign_id=? AND risk_key_id=?
        AND risk_key_mac=? AND bucket_start=? AND policy_version=?`, campaign.id, this.core.keyring.keyId,
      riskMac, bucket, campaign.rate_policy_version);
      if (counter?.count >= 20) return { _error: "campaign_unavailable" };
      if (counter) this.db.prepare("UPDATE external_campaign_rate_counters SET count=count+1,version=version+1 WHERE campaign_id=? AND risk_key_id=? AND risk_key_mac=? AND bucket_start=? AND policy_version=? AND version=?")
        .run(campaign.id, this.core.keyring.keyId, riskMac, bucket, campaign.rate_policy_version, counter.version);
      else this.db.prepare(`INSERT INTO external_campaign_rate_counters(
        campaign_id,risk_key_mac,risk_key_id,bucket_start,policy_version,count,expires_at,version
      ) VALUES(?,?,?,?,?,1,?,1)`).run(campaign.id, riskMac, this.core.keyring.keyId, bucket,
      campaign.rate_policy_version, new Date(bucketMs + 2 * 3_600_000).toISOString());
      const raw = secret();
      const credential = this.core.keyring.credential("campaign-challenge-v1", raw);
      const nonceMac = this.core.keyring.mac("campaign-client-nonce-v1", `${campaign.id}\0${body.clientNonce}`);
      const challengeId = id("challenge");
      const expiresAt = new Date(this.core.nowMs() + 5 * 60_000).toISOString();
      this.db.prepare(`INSERT INTO external_campaign_admission_challenges(
        id,campaign_id,client_nonce_mac,client_nonce_key_id,credential_mac,credential_key_id,risk_key_mac,risk_key_id,
        policy_version,expires_at,abuse_policy_version,version
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,1)`).run(challengeId, campaign.id, nonceMac, this.core.keyring.keyId,
      credential.mac, credential.keyId, riskMac, this.core.keyring.keyId, campaign.rate_policy_version, expiresAt,
      campaign.abuse_policy_version);
      this.db.prepare(`INSERT INTO external_campaign_audit_events(
        id,space_id,campaign_id,event_type,subject_kind,subject_id,policy_version,request_id,created_at
      ) VALUES(?,?,?,'challenge_issued','challenge',?,?,?,?)`).run(id("cae"), campaign.space_id, campaign.id,
      challengeId, campaign.rate_policy_version, ctx.requestId, this.core.now());
      return { accepted: true, challengeId, challengeCookieSecret: raw, expiresAt };
    });
    if (result._error) throw new ApiError("campaign_unavailable", 404);
    return result;
  }

  admission(ctx) {
    const body = object(ctx.body, ["publicCampaignId", "clientNonce"], ["publicCampaignId", "clientNonce"]);
    assert(ctx.sameOrigin === true, "request_origin_invalid", 403);
    const challenge = this.core.credentialRow("external_campaign_admission_challenges", "campaign-challenge-v1", ctx.challengeSecret);
    const invalidRisk = this.core.keyring.mac("campaign-risk-scope-v1", ctx.riskScope).toString("hex");
    const scope = challenge ? `campaign-challenge:${challenge.id}` : `campaign-challenge:invalid:${invalidRisk}`;
    const result = this.core.mutation(ctx, {
      endpoint: "/v1/external-campaign-admissions", scope, replayClass: "secret_once_envelope"
    }, () => {
      const campaign = challenge ? this.core.one("SELECT * FROM external_invitation_campaigns WHERE id=?", challenge.campaign_id) : null;
      const space = campaign ? this.core.one("SELECT * FROM spaces WHERE id=?", campaign.space_id) : null;
      const expectedNonce = campaign ? this.core.keyring.mac("campaign-client-nonce-v1", `${campaign.id}\0${body.clientNonce}`) : Buffer.alloc(32);
      const expectedRisk = campaign ? this.core.keyring.mac("campaign-risk-v1", `${campaign.id}\0${ctx.riskScope}`) : Buffer.alloc(32);
      const bucketMs = Math.floor(this.core.nowMs() / 3_600_000) * 3_600_000;
      const counter = campaign ? this.core.one(`SELECT * FROM external_campaign_rate_counters WHERE campaign_id=?
        AND risk_key_id=? AND risk_key_mac=? AND bucket_start=? AND policy_version=?`, campaign.id,
      this.core.keyring.keyId, expectedRisk, new Date(bucketMs).toISOString(), campaign.rate_policy_version) : null;
      const valid = challenge && campaign && space && campaign.public_campaign_id === body.publicCampaignId &&
        this.core.keyring.equal(challenge.client_nonce_mac, expectedNonce) && !challenge.consumed_at && !challenge.revoked_at &&
        !challenge.expiry_processed_at && Date.parse(challenge.expires_at) > this.core.nowMs() &&
        challenge.risk_key_id === this.core.keyring.keyId && this.core.keyring.equal(challenge.risk_key_mac, expectedRisk) &&
        challenge.policy_version === campaign.rate_policy_version &&
        challenge.abuse_policy_version === campaign.abuse_policy_version && counter && counter.count < 20 &&
        Date.parse(counter.expires_at) > this.core.nowMs();
      if (!valid) return { _error: "campaign_unavailable" };
      try { this.assertCampaignSpace(campaign, space); } catch { return { _error: "campaign_unavailable" }; }
      if (campaign.successful_use_count >= campaign.max_successful_uses ||
        campaign.pending_admission_count >= campaign.max_pending_admissions) return { _error: "campaign_unavailable" };
      const raw = secret();
      const credential = this.core.keyring.credential("external-invitation-v1", raw);
      const grantId = id("grant");
      const bootstrapExpiresAt = new Date(Math.min(this.core.nowMs() + 10 * 60_000, Date.parse(campaign.expires_at))).toISOString();
      const accessExpiresAt = new Date(Math.min(this.core.nowMs() + 24 * 60 * 60_000, Date.parse(campaign.expires_at))).toISOString();
      this.db.prepare(`INSERT INTO external_invitation_grants(
        id,space_id,campaign_id,admission_challenge_id,credential_mac,credential_key_id,display_mask,tasks_json,entry_task,
        bootstrap_expires_at,access_expires_at,max_uses,version
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,1)`).run(grantId, space.id, campaign.id, challenge.id,
      credential.mac, credential.keyId, "访客", campaign.tasks_json, campaign.entry_task, bootstrapExpiresAt, accessExpiresAt);
      this.db.prepare("UPDATE external_campaign_admission_challenges SET consumed_at=?,version=version+1 WHERE id=? AND version=?")
        .run(this.core.now(), challenge.id, challenge.version);
      this.db.prepare("UPDATE external_invitation_campaigns SET pending_admission_count=pending_admission_count+1,version=version+1 WHERE id=? AND version=?")
        .run(campaign.id, campaign.version);
      this.db.prepare(`INSERT INTO external_campaign_audit_events(
        id,space_id,campaign_id,event_type,subject_kind,subject_id,policy_version,request_id,created_at
      ) VALUES(?,?,?,'admission_allowed','grant',?,?,?,?)`).run(id("cae"), space.id, campaign.id, grantId,
      campaign.abuse_policy_version, ctx.requestId, this.core.now());
      return { grantId, invitationBootstrapUrlOnce: `/open#invite=${raw}`, oneTimeSecret: raw, bootstrapExpiresAt };
    });
    if (result._error) throw new ApiError("campaign_unavailable", 404);
    return result;
  }

  exchange(ctx) {
    const body = object(ctx.body, ["secretFromClearedInviteBootstrap", "clientNonce"], ["secretFromClearedInviteBootstrap"]);
    const presented = this.core.keyring.credential("external-invitation-v1", body.secretFromClearedInviteBootstrap);
    const grant = this.core.credentialRow("external_invitation_grants", "external-invitation-v1",
      body.secretFromClearedInviteBootstrap);
    const scope = grant ? `external-grant:${grant.id}` :
      `external-grant-invalid:${presented.keyId}:${presented.mac.toString("hex")}`;
    const result = this.core.mutation(ctx, { endpoint: "/v1/external-invitation-exchanges", scope,
      replayClass: "credential_reissue", reissue: (completed) => this.reissueExchange(completed) }, () => {
      const fresh = grant ? this.core.one("SELECT * FROM external_invitation_grants WHERE id=?", grant.id) : null;
      const campaign = fresh ? this.core.one("SELECT * FROM external_invitation_campaigns WHERE id=?", fresh.campaign_id) : null;
      const space = campaign ? this.core.one("SELECT * FROM spaces WHERE id=?", campaign.space_id) : null;
      const valid = fresh && campaign && space && !fresh.consumed_at && !fresh.revoked_at && !fresh.bootstrap_expired_at &&
        Date.parse(fresh.bootstrap_expires_at) > this.core.nowMs() && fresh.campaign_use_ordinal === null;
      if (!valid) return { _error: "invite_unavailable" };
      try { this.assertCampaignSpace(campaign, space); } catch { return { _error: "invite_unavailable" }; }
      if (campaign.successful_use_count >= campaign.max_successful_uses || campaign.pending_admission_count <= 0) return { _error: "invite_unavailable" };
      const ordinal = campaign.successful_use_count + 1;
      const tasks = parseJson(fresh.tasks_json, []);
      const response = { campaignId: campaign.id, campaignUseOrdinal: ordinal, taskMode: campaign.task_mode,
        tasks, entryTask: fresh.entry_task, destinationRoute: fresh.entry_task === "view" ? `/s/${space.id}/album` : `/s/${space.id}/upload` };
      if (tasks.includes("view")) {
        const principalId = id("vp");
        const issued = this.core.issue("viewer_sessions", "viewer-session-v1", {}, Date.parse(fresh.access_expires_at) - this.core.nowMs(), "vs");
        this.db.prepare(`INSERT INTO viewer_principals(id,space_id,campaign_id,grant_id,campaign_use_ordinal,created_at,version)
          VALUES(?,?,?,?,?,?,1)`).run(principalId, space.id, campaign.id, fresh.id, ordinal, this.core.now());
        this.db.prepare(`INSERT INTO viewer_sessions(
          id,space_id,campaign_id,grant_id,viewer_principal_id,campaign_use_ordinal,credential_mac,credential_key_id,tasks_json,
          space_version_at_issue,campaign_version_at_issue,grant_version_at_issue,access_expires_at,version
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(issued.sessionId, space.id, campaign.id, fresh.id, principalId, ordinal,
        issued.credential.mac, issued.credential.keyId, json(["view"]), space.version, campaign.version + 1,
        fresh.version + 1, fresh.access_expires_at);
        response.viewerPrincipalId = principalId;
        response.viewerSessionId = issued.sessionId;
        response.viewerSessionSecret = issued.raw;
      }
      if (tasks.includes("upload")) {
        const principalId = id("cp");
        const issued = this.core.issue("contributor_sessions", "contributor-session-v1", {}, Date.parse(fresh.access_expires_at) - this.core.nowMs(), "cs");
        this.db.prepare(`INSERT INTO contributor_principals(id,space_id,campaign_id,source_grant_id,campaign_use_ordinal,created_at,version)
          VALUES(?,?,?,?,?,?,1)`).run(principalId, space.id, campaign.id, fresh.id, ordinal, this.core.now());
        this.db.prepare(`INSERT INTO contributor_sessions(
          id,space_id,campaign_id,contributor_principal_id,source_grant_id,campaign_use_ordinal,credential_mac,credential_key_id,tasks_json,
          space_version_at_issue,campaign_version_at_issue,grant_version_at_issue,access_expires_at,version
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(issued.sessionId, space.id, campaign.id, principalId, fresh.id, ordinal,
        issued.credential.mac, issued.credential.keyId, json(["upload"]), space.version, campaign.version + 1,
        fresh.version + 1, fresh.access_expires_at);
        response.contributorPrincipalId = principalId;
        response.contributorSessionId = issued.sessionId;
        response.contributorSessionSecret = issued.raw;
      }
      const nextStatus = ordinal >= campaign.max_successful_uses ? "exhausted" : campaign.campaign_status;
      this.db.prepare(`UPDATE external_invitation_grants SET campaign_use_ordinal=?,consumed_at=?,version=version+1
        WHERE id=? AND version=? AND consumed_at IS NULL`).run(ordinal, this.core.now(), fresh.id, fresh.version);
      this.db.prepare(`UPDATE external_invitation_campaigns SET successful_use_count=successful_use_count+1,
        pending_admission_count=pending_admission_count-1,campaign_status=?,version=version+1 WHERE id=? AND version=? AND pending_admission_count>0`)
        .run(nextStatus, campaign.id, campaign.version);
      this.db.prepare(`INSERT INTO external_campaign_audit_events(
        id,space_id,campaign_id,event_type,subject_kind,subject_id,campaign_use_ordinal,policy_version,request_id,created_at
      ) VALUES(?,?,?,'exchanged','grant',?,?,?,?,?)`).run(id("cae"), space.id, campaign.id, fresh.id, ordinal,
      campaign.abuse_policy_version, ctx.requestId, this.core.now());
      return response;
    });
    if (result._error) throw new ApiError("invite_unavailable", 404);
    return result;
  }

  reissueChallenge(completed) {
    const challenge = this.core.one("SELECT * FROM external_campaign_admission_challenges WHERE id=?", completed.challengeId);
    const campaign = challenge ? this.core.one("SELECT * FROM external_invitation_campaigns WHERE id=?", challenge.campaign_id) : null;
    const space = campaign ? this.core.one("SELECT * FROM spaces WHERE id=?", campaign.space_id) : null;
    assert(challenge && campaign && space && !challenge.consumed_at && !challenge.revoked_at &&
      Date.parse(challenge.expires_at) > this.core.nowMs(),
      "campaign_unavailable", 404);
    this.assertCampaignSpace(campaign, space);
    const raw = secret();
    const credential = this.core.keyring.credential("campaign-challenge-v1", raw);
    const updated = this.db.prepare(`UPDATE external_campaign_admission_challenges SET credential_mac=?,credential_key_id=?,version=version+1
      WHERE id=? AND version=? AND revoked_at IS NULL`).run(credential.mac, credential.keyId, challenge.id, challenge.version);
    assert(updated.changes === 1, "campaign_unavailable", 404);
    return { ...completed, challengeCookieSecret: raw, expiresAt: challenge.expires_at };
  }

  reissueExchange(completed) {
    const campaign = this.core.one("SELECT * FROM external_invitation_campaigns WHERE id=?", completed.campaignId);
    const space = campaign ? this.core.one("SELECT * FROM spaces WHERE id=?", campaign.space_id) : null;
    const grant = campaign ? this.core.one(`SELECT * FROM external_invitation_grants
      WHERE campaign_id=? AND campaign_use_ordinal=? AND consumed_at IS NOT NULL`, campaign.id, completed.campaignUseOrdinal) : null;
    assert(campaign && space && grant && !grant.revoked_at && Date.parse(grant.access_expires_at) > this.core.nowMs(),
      "invite_unavailable", 404);
    this.assertCampaignSpace(campaign, space, { newAdmission: false });
    const response = { ...completed };
    if (completed.viewerPrincipalId) {
      const principal = this.core.one("SELECT * FROM viewer_principals WHERE id=? AND grant_id=?", completed.viewerPrincipalId, grant.id);
      const current = this.core.one(`SELECT * FROM viewer_sessions WHERE viewer_principal_id=? AND grant_id=? AND revoked_at IS NULL
        ORDER BY rowid DESC LIMIT 1`, principal?.id, grant.id);
      assert(principal && current && !principal.revoked_at, "invite_unavailable", 404);
      const issued = this.core.issue("viewer_sessions", "viewer-session-v1", {}, Date.parse(grant.access_expires_at) - this.core.nowMs(), "vs");
      this.db.prepare("UPDATE viewer_sessions SET revoked_at=?,version=version+1 WHERE id=? AND version=?")
        .run(this.core.now(), current.id, current.version);
      this.db.prepare(`INSERT INTO viewer_sessions(
        id,space_id,campaign_id,grant_id,viewer_principal_id,campaign_use_ordinal,credential_mac,credential_key_id,tasks_json,
        space_version_at_issue,campaign_version_at_issue,grant_version_at_issue,access_expires_at,version
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(issued.sessionId, space.id, campaign.id, grant.id, principal.id,
      grant.campaign_use_ordinal, issued.credential.mac, issued.credential.keyId, json(["view"]), space.version,
      campaign.version, grant.version, grant.access_expires_at);
      response.viewerSessionId = issued.sessionId;
      response.viewerSessionSecret = issued.raw;
    }
    if (completed.contributorPrincipalId) {
      const principal = this.core.one("SELECT * FROM contributor_principals WHERE id=? AND source_grant_id=?", completed.contributorPrincipalId, grant.id);
      const current = this.core.one(`SELECT * FROM contributor_sessions WHERE contributor_principal_id=? AND source_grant_id=?
        AND revoked_at IS NULL ORDER BY rowid DESC LIMIT 1`, principal?.id, grant.id);
      assert(principal && current && !principal.revoked_at, "invite_unavailable", 404);
      const issued = this.core.issue("contributor_sessions", "contributor-session-v1", {}, Date.parse(grant.access_expires_at) - this.core.nowMs(), "cs");
      this.db.prepare("UPDATE contributor_sessions SET revoked_at=?,version=version+1 WHERE id=? AND version=?")
        .run(this.core.now(), current.id, current.version);
      this.db.prepare(`INSERT INTO contributor_sessions(
        id,space_id,campaign_id,contributor_principal_id,source_grant_id,campaign_use_ordinal,credential_mac,credential_key_id,tasks_json,
        space_version_at_issue,campaign_version_at_issue,grant_version_at_issue,access_expires_at,version
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(issued.sessionId, space.id, campaign.id, principal.id, grant.id,
      grant.campaign_use_ordinal, issued.credential.mac, issued.credential.keyId, json(["upload"]), space.version,
      campaign.version, grant.version, grant.access_expires_at);
      response.contributorSessionId = issued.sessionId;
      response.contributorSessionSecret = issued.raw;
    }
    return response;
  }

  revoke(ctx, accountCtx, campaignId) {
    const body = object(ctx.body, ["reasonClass", "clientRequestId"], ["reasonClass"]);
    return this.core.mutation(ctx, { endpoint: `/v1/external-invitation-campaigns/${campaignId}/revocations`, scope: accountCtx.session.id,
      replayClass: "completed_state", reauthorize: () => {
        const current = this.core.one("SELECT space_id FROM external_invitation_campaigns WHERE id=?", campaignId);
        assert(current, "campaign_management_unavailable", 404);
        return this.core.accountSpace(this.core.account(ctx.accountSession), current.space_id, { scope: "canInvite" });
      } }, () => {
      const campaign = this.core.one("SELECT * FROM external_invitation_campaigns WHERE id=?", campaignId);
      assert(campaign, "campaign_management_unavailable", 404);
      const access = this.core.accountSpace(accountCtx, campaign.space_id, { scope: "canInvite" });
      this.core.requireIfMatch(ctx, campaign);
      assert(!campaign.revoked_at, "campaign_management_unavailable", 404);
      this.db.prepare("UPDATE external_invitation_campaigns SET campaign_status='revoked',revoked_at=?,version=version+1 WHERE id=? AND version=?")
        .run(this.core.now(), campaign.id, campaign.version);
      this.db.prepare(`INSERT INTO external_campaign_audit_events(
        id,space_id,campaign_id,event_type,subject_kind,subject_id,reason_class,policy_version,actor_auth_kind,authorization_id,request_id,created_at
      ) VALUES(?,?,?,'revoked','campaign',?,?,?,?,?,?,?)`).run(id("cae"), campaign.space_id, campaign.id, campaign.id,
      body.reasonClass, campaign.abuse_policy_version, access.authKind, access.authorizationId, ctx.requestId, this.core.now());
      return { campaignId, campaignStatus: "revoked", revokedAt: this.core.now(), version: campaign.version + 1 };
    });
  }

  sweep({ cutoffAt, batchLimit = 100, leaseId }) {
    const cutoff = new Date(cutoffAt).toISOString();
    assert(typeof leaseId === "string" && leaseId.length > 0, "campaign_sweep_lease_lost", 409);
    return transaction(this.db, () => {
    const result = { campaignsExpired: 0, challengesExpired: 0, grantsExpired: 0, pendingReleased: 0, auditEventsAppended: 0 };
    const campaigns = this.core.all(`SELECT * FROM external_invitation_campaigns WHERE expires_at<=? AND expired_at IS NULL
      AND revoked_at IS NULL AND campaign_status IN ('active','paused','exhausted') ORDER BY expires_at,id LIMIT ?`, cutoff, batchLimit);
    for (const campaign of campaigns) {
      const updated = this.db.prepare("UPDATE external_invitation_campaigns SET campaign_status='expired',expired_at=?,version=version+1 WHERE id=? AND version=?")
        .run(cutoff, campaign.id, campaign.version);
      assert(updated.changes === 1, "concurrent_change", 409);
      this.appendTerminalAudit(campaign, "expired", "campaign", campaign.id, cutoff, leaseId);
      result.campaignsExpired += 1; result.auditEventsAppended += 1;
    }
    const challenges = this.core.all(`SELECT ch.*,c.space_id,c.abuse_policy_version FROM external_campaign_admission_challenges ch
      JOIN external_invitation_campaigns c ON c.id=ch.campaign_id WHERE ch.expires_at<=? AND ch.consumed_at IS NULL
      AND ch.revoked_at IS NULL AND ch.expiry_processed_at IS NULL ORDER BY ch.expires_at,ch.id LIMIT ?`, cutoff, batchLimit);
    for (const challenge of challenges) {
      const updated = this.db.prepare("UPDATE external_campaign_admission_challenges SET expiry_processed_at=?,version=version+1 WHERE id=? AND version=?")
        .run(cutoff, challenge.id, challenge.version);
      assert(updated.changes === 1, "concurrent_change", 409);
      this.appendTerminalAudit(challenge, "challenge_expired", "challenge", challenge.id, cutoff, leaseId);
      result.challengesExpired += 1; result.auditEventsAppended += 1;
    }
    const grants = this.core.all(`SELECT g.*,c.pending_admission_count,c.version campaign_version,c.abuse_policy_version
      FROM external_invitation_grants g JOIN external_invitation_campaigns c ON c.id=g.campaign_id
      WHERE g.bootstrap_expires_at<=? AND g.consumed_at IS NULL AND g.revoked_at IS NULL AND g.bootstrap_expired_at IS NULL
      ORDER BY g.bootstrap_expires_at,g.id LIMIT ?`, cutoff, batchLimit);
    for (const grant of grants) {
      assert(grant.pending_admission_count > 0, "campaign_pending_invariant", 500);
      const grantUpdated = this.db.prepare("UPDATE external_invitation_grants SET bootstrap_expired_at=?,credential_mac=NULL,version=version+1 WHERE id=? AND version=?")
        .run(cutoff, grant.id, grant.version);
      const campaignUpdated = this.db.prepare("UPDATE external_invitation_campaigns SET pending_admission_count=pending_admission_count-1,version=version+1 WHERE id=? AND version=? AND pending_admission_count>0")
        .run(grant.campaign_id, grant.campaign_version);
      assert(grantUpdated.changes === 1 && campaignUpdated.changes === 1, "concurrent_change", 409);
      this.appendTerminalAudit(grant, "grant_bootstrap_expired", "grant", grant.id, cutoff, leaseId);
      this.appendTerminalAudit(grant, "pending_released", "grant", grant.id, cutoff, leaseId);
      result.grantsExpired += 1; result.pendingReleased += 1; result.auditEventsAppended += 2;
    }
    return result;
    });
  }

  appendTerminalAudit(row, eventType, subjectKind, subjectId, createdAt, requestId) {
    this.db.prepare(`INSERT OR IGNORE INTO external_campaign_audit_events(
      id,space_id,campaign_id,event_type,subject_kind,subject_id,policy_version,request_id,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).run(id("cae"), row.space_id, row.campaign_id ?? row.id, eventType,
    subjectKind, subjectId, row.abuse_policy_version ?? "local-abuse-v1", requestId, createdAt);
  }
}
