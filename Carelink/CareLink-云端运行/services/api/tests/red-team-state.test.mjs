import test from "node:test";
import assert from "node:assert/strict";
import { dispatchOne } from "../../jobs/dispatch/index.mjs";
import { dispatchDeletion } from "../../jobs/dispatch/deletion-worker.mjs";
import { createAccountUpload, exchangeReceipt, fixture, png } from "./fixture-factory.mjs";

async function readyPanorama(f, owner, spaceId, suffix) {
  const bytes = png(1600, 800, suffix === "a" ? "#335577" : "#773355");
  const space = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(spaceId);
  const candidate = await f.ok("POST", `/v1/spaces/${spaceId}/panorama-candidates`, {
    declaredMime: "image/png", declaredBytes: bytes.length, clientAssetId: `active-${suffix}`
  }, { ...owner.headers, "if-match": String(space.version),
    "notice-acknowledgement": JSON.stringify({ purpose: "panorama_upload", version: 1,
      contentHash: "local-panorama_upload-v1" }) });
  const put = await f.api.putMedia({ ticket: candidate.exactPrivateUploadTicketOnce,
    bytes, contentType: "image/png", kind: "panorama" });
  const committed = await f.ok("POST", `/v1/panorama-upload-sessions/${candidate.uploadSessionId}/commits`, {
    clientRequestId: `active-${suffix}`
  }, { ...owner.headers, "if-match": String(put.body.uploadSessionVersion) });
  return dispatchOne(f.db, committed.jobId, { now: f.clock.iso() }).panoramaRevisionId;
}

test("OTP purpose, expiry, failures, and lockout are counted and cannot be guessed indefinitely", async () => {
  const f = fixture();
  try {
    const account = await f.login("otp-lock@example.test");
    const requested = await f.ok("POST", "/v1/auth/reauth-challenges", {
      actionId: "AUTH.LOGOUT_ALL", purpose: "logout_all"
    }, account.headers);
    const correct = f.otp.findLast((entry) => entry.challengeId === requested.challengeId).code;
    const wrongPurpose = await f.call("POST", "/v1/auth/reauth-verifications", {
      challengeId: requested.challengeId, otp: correct, actionId: "AUTH.LOGOUT_ALL", purpose: "space_restore"
    }, account.headers);
    assert.equal(wrongPurpose.status, 401);
    assert.equal(f.db.prepare("SELECT attempts FROM email_otp_challenges WHERE id=?").get(requested.challengeId).attempts, 1);
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      const rejected = await f.call("POST", "/v1/auth/reauth-verifications", {
        challengeId: requested.challengeId, otp: "000000", actionId: "AUTH.LOGOUT_ALL", purpose: "logout_all"
      }, account.headers);
      assert.equal(rejected.status, 401);
    }
    const locked = f.db.prepare("SELECT * FROM email_otp_challenges WHERE id=?").get(requested.challengeId);
    assert.equal(locked.attempts, 5);
    assert.ok(locked.revoked_at);
    assert.equal((await f.call("POST", "/v1/auth/reauth-verifications", {
      challengeId: requested.challengeId, otp: correct, actionId: "AUTH.LOGOUT_ALL", purpose: "logout_all"
    }, account.headers)).status, 401);

    const expiredRequest = await f.ok("POST", "/v1/auth/reauth-challenges", {
      actionId: "AUTH.LOGOUT_ALL", purpose: "logout_all"
    }, account.headers);
    const expiredCode = f.otp.findLast((entry) => entry.challengeId === expiredRequest.challengeId).code;
    f.clock.advance(11 * 60_000);
    assert.equal((await f.call("POST", "/v1/auth/reauth-verifications", {
      challengeId: expiredRequest.challengeId, otp: expiredCode,
      actionId: "AUTH.LOGOUT_ALL", purpose: "logout_all"
    }, account.headers)).status, 401);
    assert.equal(f.db.prepare("SELECT attempts FROM email_otp_challenges WHERE id=?").get(expiredRequest.challengeId).attempts, 1);
  } finally { f.close(); }
});

test("OTP issuance is atomically bounded by equivalence and server risk while responses stay accepted", async () => {
  const f = fixture();
  try {
    const email = "otp-issuance-limit@example.test";
    const responses = [];
    for (let attempt = 0; attempt < 25; attempt += 1) {
      responses.push(await f.call("POST", "/v1/auth/email-otp-challenges", { email, purpose: "login" },
        { "idempotency-key": `otp-issuance-${attempt}-abcdefgh` }));
    }
    assert.ok(responses.every((response) => response.status === 200 && response.body.accepted === true));
    const equivalence = f.db.prepare("SELECT id FROM identifier_equivalences").get();
    const challenges = f.db.prepare("SELECT * FROM email_otp_challenges WHERE identifier_equivalence_id=?")
      .all(equivalence.id);
    assert.equal(challenges.length, 5);
    assert.equal(f.otp.length, 5);
    assert.ok(challenges.every((row) => row.rate_limit_mac && row.rate_limit_key_id &&
      row.risk_limit_mac && row.risk_limit_key_id));
    const counter = f.db.prepare(`SELECT count,blocked_until FROM otp_issuance_rate_counters
      WHERE scope_kind='equivalence'`).get();
    assert.equal(counter.count, 5);
    assert.equal(counter.blocked_until, null);
  } finally { f.close(); }
});

test("credential idempotency replay rotates a usable account session instead of returning a secretless 200", async () => {
  const f = fixture();
  try {
    const challenge = await f.ok("POST", "/v1/auth/email-otp-challenges",
      { email: "login-replay@example.test", purpose: "login" });
    const otp = f.otp.findLast((entry) => entry.challengeId === challenge.challengeId).code;
    const headers = { "idempotency-key": "login-verify-replay-abcdefgh" };
    const body = { challengeId: challenge.challengeId, otp, purpose: "login" };
    const first = await f.call("POST", "/v1/auth/email-otp-verifications", body, headers);
    const replay = await f.call("POST", "/v1/auth/email-otp-verifications", body, headers);
    assert.equal(first.status, 200);
    assert.equal(replay.status, 200);
    assert.notEqual(first.body.accountSessionSecret, replay.body.accountSessionSecret);
    assert.equal(replay.body.replayed, true);
    assert.equal((await f.call("GET", "/v1/me", {},
      { authorization: `Bearer ${first.body.accountSessionSecret}` })).status, 401);
    assert.equal((await f.call("GET", "/v1/me", {},
      { authorization: `Bearer ${replay.body.accountSessionSecret}` })).status, 200);
  } finally { f.close(); }
});

test("multi-resource CAS requires every declared snapshot, not any coincident version", async () => {
  const f = fixture();
  try {
    const owner = await f.login("multi-cas@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const consent = await f.ok("POST", "/v1/consent-events", {
      ...f.mediaConsentBody()
    }, owner.headers);
    const batch = await f.ok("POST", `/v1/spaces/${space.spaceId}/contribution-batches`, {
      clientBatchId: "multi-cas", consentEventId: consent.consentEventId, declaredItemCount: 1
    }, owner.headers);
    const body = { clientItemId: "multi", declaredMime: "image/png", declaredBytes: 100, fileNameHash: "opaque" };
    assert.equal((await f.call("POST", `/v1/contribution-batches/${batch.batchId}/items`, body,
      { ...owner.headers, "if-match": String(batch.version) })).status, 409);
    assert.equal((await f.call("POST", `/v1/contribution-batches/${batch.batchId}/items`, body,
      { ...owner.headers, "if-match": String(batch.version), "x-space-version": "1" })).status, 409);
    const accepted = await f.call("POST", `/v1/contribution-batches/${batch.batchId}/items`, body,
      { ...owner.headers, "if-match": String(batch.version), "x-space-version": String(space.version) });
    assert.equal(accepted.status, 200);
  } finally { f.close(); }
});

test("receipt recovery derives a fresh access window bounded by recoveryUntil and replay rotates it", async () => {
  const f = fixture();
  try {
    const owner = await f.login("binding-owner@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const flow = await createAccountUpload(f, owner, space);
    const exchanged = await exchangeReceipt(f, flow.finalized);
    assert.equal(exchanged.status, 200);
    const receiptHeader = { "x-receipt-session": exchanged.body.receiptSessionSecret };
    const challenge = await f.ok("POST", "/v1/batch-receipt/account-binding-otp-challenges",
      { email: "bound-recovery@example.test" }, receiptHeader);
    const otp = f.otp.findLast((entry) => entry.challengeId === challenge.challengeId).code;
    const binding = await f.ok("POST", "/v1/batch-receipt/account-bindings",
      { challengeId: challenge.challengeId, otp }, { ...receiptHeader,
        "notice-acknowledgement": JSON.stringify({ purpose: "receipt_account_binding", version: 1,
          contentHash: "local-receipt_account_binding-v1" }) });
    const receipt = f.db.prepare("SELECT * FROM batch_receipts WHERE id=?").get(flow.finalized.receiptId);
    f.clock.advance(31 * 24 * 60 * 60_000);
    f.db.prepare("UPDATE batch_receipts SET access_expires_at=? WHERE id=?")
      .run(new Date(f.clock.now() - 1).toISOString(), receipt.id);
    const bound = await f.login("bound-recovery@example.test");
    const headers = { ...bound.headers, "idempotency-key": "receipt-recovery-replay-abcdefgh" };
    const first = await f.call("POST", "/v1/me/batch-receipt-recoveries", { bindingId: binding.bindingId }, headers);
    const replay = await f.call("POST", "/v1/me/batch-receipt-recoveries", { bindingId: binding.bindingId }, headers);
    assert.equal(first.status, 200);
    assert.equal(replay.status, 200);
    assert.notEqual(first.body.receiptSessionSecret, replay.body.receiptSessionSecret);
    assert.ok(Date.parse(replay.body.accessExpiresAt) > f.clock.now());
    assert.ok(Date.parse(replay.body.accessExpiresAt) <= Date.parse(replay.body.recoveryUntil));
    assert.equal((await f.call("GET", "/v1/batch-receipt", {},
      { "x-receipt-session": first.body.receiptSessionSecret })).status, 401);
    assert.equal((await f.call("GET", "/v1/batch-receipt", {},
      { "x-receipt-session": replay.body.receiptSessionSecret })).status, 200);
  } finally { f.close(); }
});

test("account receipt recovery uses one canonical unavailable error with zero state change", async () => {
  const f = fixture();
  try {
    const account = await f.login("recovery-unavailable@example.test");
    const before = {
      receipts: f.db.prepare("SELECT COUNT(*) count FROM batch_receipts").get().count,
      sessions: f.db.prepare("SELECT COUNT(*) count FROM receipt_sessions").get().count,
      bindings: f.db.prepare("SELECT COUNT(*) count FROM receipt_account_bindings").get().count
    };
    const missing = await f.call("POST", "/v1/me/batch-receipt-recoveries", { bindingId: "binding_missing" },
      account.headers);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, "receipt_recovery_unavailable");
    assert.deepEqual({
      receipts: f.db.prepare("SELECT COUNT(*) count FROM batch_receipts").get().count,
      sessions: f.db.prepare("SELECT COUNT(*) count FROM receipt_sessions").get().count,
      bindings: f.db.prepare("SELECT COUNT(*) count FROM receipt_account_bindings").get().count
    }, before);
  } finally { f.close(); }
});

test("deletion worker deletes stored media, revokes capability state, and completes the receipt ledger", async () => {
  const f = fixture();
  try {
    const owner = await f.login("deletion-worker@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const flow = await createAccountUpload(f, owner, space);
    const grant = await f.reauth(owner, "BATCH.DELETE_ITEM", "photo_delete", "photo", flow.committed.photoId);
    const photo = f.db.prepare("SELECT * FROM photos WHERE id=?").get(flow.committed.photoId);
    const deletion = await f.ok("POST", `/v1/photos/${photo.id}/deletion-requests`, {
      reason: "requested", reauthGrant: grant.reauthGrantSecret
    }, { ...owner.headers, "if-match": String(photo.version) });
    assert.equal((await f.api.mediaStore.head(flow.upload.exactPrivateObjectKey)).exists, true);
    const completed = await dispatchDeletion(f.db, f.api.mediaStore, deletion.jobId, { now: f.clock.iso() });
    assert.equal(completed.status, "succeeded");
    assert.equal((await f.api.mediaStore.head(flow.upload.exactPrivateObjectKey)).exists, false);
    const status = await f.ok("GET", `/v1/deletion-requests/${deletion.deletionId}`, {}, owner.headers);
    assert.equal(status.status, "completed");
    assert.deepEqual(status.events.map((entry) => entry.status), ["queued", "running", "completed"]);
    assert.throws(() => f.db.prepare("UPDATE deletion_status_events SET status='queued' WHERE deletion_request_id=?")
      .run(deletion.deletionId), /immutable/);
  } finally { f.close(); }
});

test("space deletion revokes members, invitations, external principals, and sessions in the request transaction", async () => {
  const f = fixture();
  try {
    const owner = await f.login("space-revoke-owner@example.test");
    const member = await f.login("space-revoke-member@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    f.db.prepare(`INSERT INTO space_memberships(
      id,space_id,account_id,tasks_json,management_scopes_json,status,version,created_by,accepted_at
    ) VALUES('delete_membership',?,?,'["view"]','[]','active',1,?,?)`).run(space.spaceId,
    member.accountId, owner.accountId, f.clock.iso());
    const invitation = await f.ok("POST", `/v1/spaces/${space.spaceId}/member-invitations`, {
      verifiedIdentifier: "space-revoke-member@example.test", tasks: ["view"], managementScopes: [],
      expiresAt: "2026-08-14T00:00:00.000Z"
    }, { ...owner.headers, "if-match": String(space.version) });
    const campaign = await f.ok("POST", `/v1/spaces/${space.spaceId}/external-invitation-campaigns`, {
      taskMode: "combo", expiresAt: "2026-08-14T00:00:00.000Z", maxSuccessfulUses: 5
    }, { ...owner.headers, "if-match": String(space.version) });
    const locator = new URL(campaign.publicCampaignUrl).pathname.split("/").at(-1);
    const publicHeaders = { origin: "http://127.0.0.1:8787", host: "127.0.0.1:8787",
      "sec-fetch-site": "same-origin", "x-public-origin": "http://127.0.0.1:8787",
      "x-public-host": "127.0.0.1:8787" };
    const challenge = await f.ok("POST", "/v1/external-campaign-admission-challenges",
      { publicCampaignId: locator, clientNonce: "delete-space-nonce-123456" }, publicHeaders);
    const admission = await f.ok("POST", "/v1/external-campaign-admissions",
      { publicCampaignId: locator, clientNonce: "delete-space-nonce-123456" },
      { ...publicHeaders, "x-campaign-challenge": challenge.challengeCookieSecret });
    const external = await f.ok("POST", "/v1/external-invitation-exchanges",
      { secretFromClearedInviteBootstrap: admission.oneTimeSecret });
    const current = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(space.spaceId);
    const grant = await f.reauth(owner, "SPACE.DELETE_REQUEST", "space_delete", "space", space.spaceId);
    const requested = await f.ok("POST", `/v1/spaces/${space.spaceId}/deletion-requests`, {
      reauthGrant: grant.reauthGrantSecret, confirmation: true
    }, { ...owner.headers, "if-match": String(current.version) });
    assert.equal(requested.status, "queued");
    assert.equal(f.db.prepare("SELECT status FROM space_memberships WHERE id='delete_membership'").get().status, "revoked");
    assert.ok(f.db.prepare("SELECT revoked_at FROM member_invitations WHERE id=?").get(invitation.invitationId).revoked_at);
    assert.ok(f.db.prepare("SELECT revoked_at FROM viewer_sessions WHERE id=?").get(external.viewerSessionId).revoked_at);
    assert.ok(f.db.prepare("SELECT revoked_at FROM contributor_sessions WHERE id=?")
      .get(external.contributorSessionId).revoked_at);
    assert.equal(f.db.prepare("SELECT campaign_status FROM external_invitation_campaigns WHERE id=?")
      .get(campaign.campaignId).campaign_status, "revoked");
  } finally { f.close(); }
});

test("deletion media errors stay retryable, continue per resource, and append immutable attempt history", async () => {
  const f = fixture();
  try {
    const owner = await f.login("deletion-retry@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const flow = await createAccountUpload(f, owner, space);
    const photo = f.db.prepare("SELECT * FROM photos WHERE id=?").get(flow.committed.photoId);
    const grant = await f.reauth(owner, "BATCH.DELETE_ITEM", "photo_delete", "photo", photo.id);
    const deletion = await f.ok("POST", `/v1/photos/${photo.id}/deletion-requests`, {
      reason: "retry", reauthGrant: grant.reauthGrantSecret
    }, { ...owner.headers, "if-match": String(photo.version) });
    let failures = 1;
    const flaky = { delete: async (key) => {
      if (failures-- > 0) throw new Error("synthetic storage outage");
      return f.api.mediaStore.delete(key);
    }, head: (key) => f.api.mediaStore.head(key) };
    const first = await dispatchDeletion(f.db, flaky, deletion.jobId, { now: f.clock.iso() });
    assert.equal(first.status, "retryable");
    assert.equal(f.db.prepare("SELECT status FROM deletion_requests WHERE id=?").get(deletion.deletionId).status, "queued");
    assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(deletion.jobId).status, "queued");
    f.clock.advance(1000);
    const second = await dispatchDeletion(f.db, flaky, deletion.jobId, { now: f.clock.iso() });
    assert.equal(second.status, "succeeded");
    assert.deepEqual(f.db.prepare("SELECT action FROM deletion_attempt_events WHERE deletion_request_id=? ORDER BY seq")
      .all(deletion.deletionId).map((row) => row.action), ["revoke_first", "lease_claim", "delete_media_failed",
        "delete_media", "lease_claim", "delete_media", "delete_media"]);
    assert.deepEqual(f.db.prepare("SELECT status FROM deletion_status_events WHERE deletion_request_id=? ORDER BY seq")
      .all(deletion.deletionId).map((row) => row.status), ["queued", "running", "retryable", "running", "completed"]);
  } finally { f.close(); }
});

test("candidate placement rejects client yaw and expired owner transfers sweep into a consistent read model", async () => {
  const f = fixture();
  try {
    const owner = await f.login("state-owner@example.test");
    const target = await f.login("state-target@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const flow = await createAccountUpload(f, owner, space);
    const validation = dispatchOne(f.db, flow.committed.jobId, { now: f.clock.iso() });
    const photo = f.db.prepare("SELECT * FROM photos WHERE id=?").get(flow.committed.photoId);
    const item = f.db.prepare("SELECT * FROM contribution_batch_items WHERE id=?").get(flow.item.itemId);
    f.db.prepare(`INSERT INTO placement_suggestions(
      id,space_id,photo_id,panorama_revision_id,job_id,status,candidates_json,version
    ) VALUES('suggestion_client_yaw',?,?,NULL,?,'ready',?,1)`).run(space.spaceId, photo.id,
    validation.placementJobId, JSON.stringify([{ candidateId: "server-candidate", yaw: 15 }]));
    const rejected = await f.call("POST", `/v1/photos/${photo.id}/placement-revisions`, {
      mode: "candidate", suggestionId: "suggestion_client_yaw", candidateId: "server-candidate",
      confirmationMode: "manual", yawDeg: 180
    }, { ...owner.headers, "if-match": String(photo.version), "x-item-version": String(item.version),
      "x-placement-authorization-version": String(item.placement_authorization_version) });
    assert.equal(rejected.status, 400);

    f.db.prepare(`INSERT INTO space_memberships(
      id,space_id,account_id,tasks_json,management_scopes_json,status,version,created_by,accepted_at
    ) VALUES('membership_transfer',?,?, '["view"]','[]','active',1,?,?)`).run(space.spaceId,
    target.accountId, owner.accountId, f.clock.iso());
    const grant = await f.reauth(owner, "OWNER_TRANSFER.CREATE", "owner_transfer_create", "space", space.spaceId);
    const transfer = await f.ok("POST", `/v1/spaces/${space.spaceId}/owner-transfers`, {
      targetMembershipId: "membership_transfer", reauthGrant: grant.reauthGrantSecret, ifMatchVersion: space.version
    }, owner.headers);
    f.clock.advance(25 * 60 * 60_000);
    const listed = await f.ok("GET", "/v1/me/owner-transfers", {}, target.headers);
    assert.equal(listed.transfers.find((entry) => entry.transferId === transfer.transferId).status, "expired");
    assert.equal(f.db.prepare("SELECT status FROM owner_transfers WHERE id=?").get(transfer.transferId).status, "expired");
  } finally { f.close(); }
});

test("panorama switch keeps exactly one active revision across A to B to A and same-current is zero-write", async () => {
  const f = fixture();
  try {
    const owner = await f.login("panorama-active@example.test");
    const created = await f.createSpace(owner);
    const revisionA = await readyPanorama(f, owner, created.spaceId, "a");
    async function switchTo(revisionId, mode = "switch") {
      const space = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(created.spaceId);
      const scene = f.db.prepare("SELECT * FROM scenes WHERE space_id=?").get(created.spaceId);
      return f.call("POST", `/v1/spaces/${created.spaceId}/panorama-switches`, {
        mode, ...(mode === "switch" ? { candidateRevisionId: revisionId } : { targetPanoramaRevisionId: revisionId }),
        sceneIfMatchVersion: scene.version
      }, { ...owner.headers, "if-match": String(space.version) });
    }
    assert.equal((await switchTo(revisionA)).status, 200);
    const revisionB = await readyPanorama(f, owner, created.spaceId, "b");
    assert.equal((await switchTo(revisionB)).status, 200);
    let rows = f.db.prepare("SELECT id,activated_at,retired_at,version FROM panorama_revisions ORDER BY id").all();
    assert.equal(rows.filter((row) => row.activated_at && !row.retired_at).length, 1);
    assert.equal(rows.find((row) => row.id === revisionA).retired_at != null, true);
    assert.equal((await switchTo(revisionA, "rollback")).status, 200);
    rows = f.db.prepare("SELECT id,activated_at,retired_at,version FROM panorama_revisions ORDER BY id").all();
    assert.equal(rows.filter((row) => row.activated_at && !row.retired_at).length, 1);
    assert.equal(rows.find((row) => row.id === revisionA).retired_at, null);
    assert.ok(rows.find((row) => row.id === revisionB).retired_at);
    const before = JSON.stringify({
      space: f.db.prepare("SELECT version FROM spaces WHERE id=?").get(created.spaceId),
      scene: f.db.prepare("SELECT version FROM scenes WHERE space_id=?").get(created.spaceId), rows
    });
    const noOp = await switchTo(revisionA);
    assert.equal(noOp.status, 200);
    assert.equal(noOp.body.currentPanoramaRevisionId, revisionA);
    assert.equal(noOp.body.unchanged, true);
    const after = JSON.stringify({
      space: f.db.prepare("SELECT version FROM spaces WHERE id=?").get(created.spaceId),
      scene: f.db.prepare("SELECT version FROM scenes WHERE space_id=?").get(created.spaceId),
      rows: f.db.prepare("SELECT id,activated_at,retired_at,version FROM panorama_revisions ORDER BY id").all()
    });
    assert.equal(after, before);
  } finally { f.close(); }
});

test("consent withdrawal is append-only and content case actor relations expose real composite foreign keys", () => {
  const f = fixture();
  try {
    const foreignKeys = f.db.prepare("PRAGMA foreign_key_list(content_cases)").all();
    assert.ok(foreignKeys.filter((row) => row.table === "viewer_sessions").length >= 5);
    assert.ok(foreignKeys.filter((row) => row.table === "receipt_sessions").length >= 4);
    f.db.prepare(`INSERT INTO consent_events(
      id,space_id,actor_auth_kind,authorization_id,notice_id,notice_version,notice_hash,notice_purpose,accepted_at
    ) VALUES('consent_append_only',NULL,'account','account','media_photo_upload',1,'hash','photo_upload',
      '2026-08-13T00:00:00.000Z')`).run();
    f.db.prepare(`INSERT INTO consent_withdrawal_events(
      id,consent_event_id,actor_auth_kind,authorization_id,withdrawn_at,request_id
    ) VALUES('withdrawal_fk_test','consent_append_only','account','account','2026-08-13T00:00:00.000Z','request')`).run();
    assert.throws(() => f.db.prepare("UPDATE consent_withdrawal_events SET authorization_id='changed'").run(),
      /immutable/);
  } finally { f.close(); }
});

test("upload retry rejects client-observed metadata and derives the new ticket declaration from server state", async () => {
  const f = fixture();
  try {
    const owner = await f.login("retry-metadata@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const consent = await f.ok("POST", "/v1/consent-events", {
      ...f.mediaConsentBody()
    }, owner.headers);
    const batch = await f.ok("POST", `/v1/spaces/${space.spaceId}/contribution-batches`, {
      clientBatchId: "retry-metadata", consentEventId: consent.consentEventId, declaredItemCount: 1
    }, owner.headers);
    const item = await f.ok("POST", `/v1/contribution-batches/${batch.batchId}/items`, {
      clientItemId: "retry-item", declaredMime: "image/png", declaredBytes: 1234, fileNameHash: "opaque"
    }, { ...owner.headers, "if-match": String(batch.version), "x-space-version": String(space.version) });
    await f.ok("POST", `/v1/contribution-batches/${batch.batchId}/items/${item.itemId}/upload-sessions`, {
      declaredMime: "image/png", declaredBytes: 1234, clientUploadId: "original-upload"
    }, { ...owner.headers, "if-match": String(item.version) });
    f.db.prepare("UPDATE contribution_batch_items SET status='failed',failure_code='decoder_failure',version=version+1 WHERE id=?")
      .run(item.itemId);
    const failed = f.db.prepare("SELECT * FROM contribution_batch_items WHERE id=?").get(item.itemId);
    const before = f.db.prepare("SELECT COUNT(*) count FROM upload_sessions WHERE item_id=?").get(item.itemId).count;
    const forged = await f.call("POST", `/v1/contribution-batches/${batch.batchId}/items/${item.itemId}/retries`, {
      failureVersion: failed.version, clientUploadId: "forged", observedETag: "forged", declaredBytes: 1
    }, owner.headers);
    assert.equal(forged.status, 400);
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM upload_sessions WHERE item_id=?").get(item.itemId).count, before);
    const retried = await f.ok("POST", `/v1/contribution-batches/${batch.batchId}/items/${item.itemId}/retries`, {
      failureVersion: failed.version
    }, owner.headers);
    const declaration = JSON.parse(f.db.prepare("SELECT declared_metadata_json FROM upload_sessions WHERE id=?")
      .get(retried.uploadSessionId).declared_metadata_json);
    assert.deepEqual(declaration, { mime: "image/png", bytes: 1234 });
  } finally { f.close(); }
});

test("account deletion is synchronously blocked while the account still owns a space", async () => {
  const f = fixture();
  try {
    const owner = await f.login("owner-delete-block@example.test");
    await f.createSpace(owner);
    const grant = await f.reauth(owner, "ACCOUNT.DELETE_REQUEST", "account_delete", "account", owner.accountId);
    const rejected = await f.call("POST", "/v1/me/deletion-requests", {
      reauthGrant: grant.reauthGrantSecret, confirmation: true
    }, { ...owner.headers, "if-match": "1" });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error.code, "owner_disposition_required");
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM deletion_requests").get().count, 0);
  } finally { f.close(); }
});

test("photo deletion receipt is queryable only by the exact original receipt session", async () => {
  const f = fixture();
  try {
    const owner = await f.login("receipt-deletion-status@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const flow = await createAccountUpload(f, owner, space);
    const exchanged = await exchangeReceipt(f, flow.finalized);
    const receipt = exchanged.body.receiptSessionSecret;
    const photo = f.db.prepare("SELECT * FROM photos WHERE id=?").get(flow.committed.photoId);
    const requested = await f.ok("POST", `/v1/photos/${photo.id}/deletion-requests`, {
      reason: "receipt_requested"
    }, { "x-receipt-session": receipt, "if-match": String(photo.version) });
    const exact = await f.call("GET", `/v1/deletion-requests/${requested.deletionId}`, {},
      { "x-receipt-session": receipt });
    assert.equal(exact.status, 200);
    const otherFlow = await createAccountUpload(f, owner, space);
    const otherExchange = await exchangeReceipt(f, otherFlow.finalized, "other-deletion-receipt-abcdefgh");
    const wrong = await f.call("GET", `/v1/deletion-requests/${requested.deletionId}`, {},
      { "x-receipt-session": otherExchange.body.receiptSessionSecret });
    assert.equal(wrong.status, 404);
  } finally { f.close(); }
});

test("account deletion without owned spaces reaches deleted and revokes every account credential", async () => {
  const f = fixture();
  try {
    const account = await f.login("account-worker-delete@example.test");
    const grant = await f.reauth(account, "ACCOUNT.DELETE_REQUEST", "account_delete", "account", account.accountId);
    const row = f.db.prepare("SELECT * FROM accounts WHERE id=?").get(account.accountId);
    const requested = await f.ok("POST", "/v1/me/deletion-requests", {
      reauthGrant: grant.reauthGrantSecret, confirmation: true
    }, { ...account.headers, "if-match": String(row.version) });
    const jobId = f.db.prepare("SELECT id FROM jobs WHERE type='deletion_execution' AND json_extract(input_refs_json,'$.deletionId')=?")
      .get(requested.deletionId).id;
    const completed = await dispatchDeletion(f.db, f.api.mediaStore, jobId, { now: f.clock.iso() });
    assert.equal(completed.status, "succeeded");
    assert.equal(f.db.prepare("SELECT status FROM accounts WHERE id=?").get(account.accountId).status, "deleted");
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM account_sessions WHERE account_id=? AND revoked_at IS NULL")
      .get(account.accountId).count, 0);
    assert.equal(f.db.prepare("SELECT status FROM deletion_requests WHERE id=?").get(requested.deletionId).status,
      "completed");
  } finally { f.close(); }
});
