import test from "node:test";
import assert from "node:assert/strict";
import { dispatchOne } from "../../jobs/dispatch/index.mjs";
import { dispatchDeletion } from "../../jobs/dispatch/deletion-worker.mjs";
import { createAccountUpload, exchangeReceipt, fixture } from "./fixture-factory.mjs";

test("export job produces a local artifact and download authorization rotates on replay", async () => {
  const f = fixture();
  try {
    const owner = await f.login("export@example.test");
    const space = await f.createSpace(owner);
    const created = await f.ok("POST", "/v1/exports", { scope: "space", spaceId: space.spaceId, format: "json" }, owner.headers);
    assert.equal(created.status, "queued");
    const dispatched = dispatchOne(f.db, created.jobId, { now: f.clock.iso() });
    assert.equal(dispatched.status, "succeeded");
    const status = await f.ok("GET", `/v1/exports/${created.exportId}`, {}, owner.headers);
    assert.equal(status.status, "ready");
    const headers = { ...owner.headers, "idempotency-key": "download-replay-abcdefgh" };
    const first = await f.call("POST", `/v1/exports/${created.exportId}/download-authorizations`, { clientNonce: "nonce" }, headers);
    const replay = await f.call("POST", `/v1/exports/${created.exportId}/download-authorizations`, { clientNonce: "nonce" }, headers);
    assert.equal(first.status, 200);
    assert.equal(replay.status, 200);
    assert.notEqual(first.body.authorizationSecret, replay.body.authorizationSecret);
    assert.equal(replay.body.replayed, true);
    const stale = await f.call("GET", first.body.downloadUrl, {},
      { ...owner.headers, "x-export-download": first.body.authorizationSecret });
    assert.equal(stale.status, 404);
    const download = await f.call("GET", replay.body.downloadUrl, {},
      { ...owner.headers, "x-export-download": replay.body.authorizationSecret });
    assert.equal(download.status, 200);
    assert.ok(Buffer.isBuffer(download.body));
    assert.equal(JSON.parse(download.body.toString()).schema, "unseen-export-v1");
    const repeated = await f.call("GET", replay.body.downloadUrl, {},
      { ...owner.headers, "x-export-download": replay.body.authorizationSecret });
    assert.equal(repeated.status, 404);
    const stored = f.db.prepare("SELECT response_ref FROM idempotency_records WHERE canonical_endpoint=?")
      .get(`/v1/exports/${created.exportId}/download-authorizations`);
    assert.equal(stored.response_ref.includes("authorizationSecret"), false);
  } finally { f.close(); }
});

test("account privacy export includes participant-only memberships, bindings, contributions, cases, and consents", async () => {
  const f = fixture();
  try {
    const owner = await f.login("privacy-export-owner@example.test");
    const participant = await f.login("privacy-export-participant@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    f.db.prepare(`INSERT INTO space_memberships(
      id,space_id,account_id,tasks_json,management_scopes_json,status,version,created_by,accepted_at
    ) VALUES('privacy_membership',?,?,'["upload","view"]','[]','active',1,?,?)`).run(space.spaceId,
    participant.accountId, owner.accountId, f.clock.iso());
    const flow = await createAccountUpload(f, participant, space);
    const receipt = await exchangeReceipt(f, flow.finalized, "privacy-export-receipt-abcdefgh");
    const receiptHeaders = { "x-receipt-session": receipt.body.receiptSessionSecret };
    const challenge = await f.ok("POST", "/v1/batch-receipt/account-binding-otp-challenges",
      { email: "privacy-export-participant@example.test" }, receiptHeaders);
    const otp = f.otp.findLast((entry) => entry.challengeId === challenge.challengeId).code;
    const binding = await f.ok("POST", "/v1/batch-receipt/account-bindings", {
      challengeId: challenge.challengeId, otp
    }, { ...receiptHeaders, "notice-acknowledgement": JSON.stringify({ purpose: "receipt_account_binding", version: 1,
      contentHash: "local-receipt_account_binding-v1" }) });
    const report = await f.ok("POST", "/v1/reports", {
      targetRef: { photoId: flow.committed.photoId }, category: "privacy", description: "my participant case",
      clientRequestId: "privacy-export-case"
    }, { ...participant.headers, "notice-acknowledgement": JSON.stringify({ purpose: "object_report", version: 1,
      contentHash: "local-object_report-v1" }) });
    const created = await f.ok("POST", "/v1/exports", { scope: "account", format: "json" }, participant.headers);
    assert.equal(dispatchOne(f.db, created.jobId, { now: f.clock.iso() }).status, "succeeded");
    const artifact = f.db.prepare("SELECT content FROM export_artifacts WHERE export_id=?").get(created.exportId);
    const document = JSON.parse(Buffer.from(artifact.content).toString("utf8"));
    assert.ok(document.spaces.some((row) => row.id === space.spaceId));
    assert.ok(document.memberships.some((row) => row.id === "privacy_membership"));
    assert.ok(document.receiptBindings.some((row) => row.id === binding.bindingId));
    assert.ok(document.contributionBatches.some((row) => row.id === flow.batch.batchId));
    assert.ok(document.contributionItems.some((row) => row.id === flow.item.itemId));
    assert.ok(document.photos.some((row) => row.id === flow.committed.photoId));
    assert.ok(document.cases.some((row) => row.id === report.caseId));
    assert.ok(document.consents.some((row) => row.notice_purpose === "photo_upload"));
    assert.equal(JSON.stringify(document).includes(flow.upload.exactPrivateObjectKey), false);
    const reauth = await f.reauth(participant, "ACCOUNT.DELETE_REQUEST", "account_delete", "account",
      participant.accountId);
    const accountRow = f.db.prepare("SELECT * FROM accounts WHERE id=?").get(participant.accountId);
    const deletion = await f.ok("POST", "/v1/me/deletion-requests", {
      reauthGrant: reauth.reauthGrantSecret, confirmation: true
    }, { ...participant.headers, "if-match": String(accountRow.version) });
    assert.equal(f.db.prepare("SELECT status FROM space_memberships WHERE id='privacy_membership'").get().status, "revoked");
    assert.ok(f.db.prepare("SELECT revoked_at FROM receipt_account_bindings WHERE id=?").get(binding.bindingId).revoked_at);
    const deletionJobId = f.db.prepare(`SELECT id FROM jobs WHERE type='deletion_execution'
      AND json_extract(input_refs_json,'$.deletionId')=?`).get(deletion.deletionId).id;
    assert.equal((await dispatchDeletion(f.db, f.api.mediaStore, deletionJobId, { now: f.clock.iso() })).status,
      "succeeded");
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM space_memberships WHERE account_id=?")
      .get(participant.accountId).count, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM receipt_account_bindings WHERE account_id=?")
      .get(participant.accountId).count, 0);
    const retainedCase = f.db.prepare("SELECT * FROM content_cases WHERE id=?").get(report.caseId);
    assert.equal(retainedCase.actor_relation_kind, "account");
    assert.equal(retainedCase.space_id, null);
    assert.equal(retainedCase.actor_account_membership_id, null);
    assert.equal((await f.api.mediaStore.head(flow.upload.exactPrivateObjectKey)).exists, false);
    assert.ok(f.db.prepare("SELECT deleted_at FROM photos WHERE id=?").get(flow.committed.photoId).deleted_at);
  } finally { f.close(); }
});

test("space deletion revoke-first and deletion event chain are one transaction", async () => {
  const f = fixture();
  try {
    const owner = await f.login("delete@example.test");
    const space = await f.createSpace(owner);
    const grant = await f.reauth(owner, "SPACE.DELETE_REQUEST", "space_delete", "space", space.spaceId);
    const deleted = await f.ok("POST", `/v1/spaces/${space.spaceId}/deletion-requests`, {
      reauthGrant: grant.reauthGrantSecret, reason: "requested", confirmation: true
    }, { ...owner.headers, "if-match": String(space.version) });
    const state = f.db.prepare("SELECT * FROM spaces WHERE id=?").get(space.spaceId);
    assert.equal(state.space_lifecycle, "archived");
    assert.equal(state.collection_state, "paused");
    assert.equal(state.sharing_state, "private");
    const attempts = f.db.prepare("SELECT * FROM deletion_attempt_events WHERE deletion_request_id=? ORDER BY seq").all(deleted.deletionId);
    const statuses = f.db.prepare("SELECT * FROM deletion_status_events WHERE deletion_request_id=? ORDER BY seq").all(deleted.deletionId);
    assert.equal(attempts.length, 1);
    assert.equal(statuses.length, 1);
    assert.equal(attempts[0].seq, 1);
    assert.equal(attempts[0].previous_event_id, null);
    assert.equal(statuses[0].seq, 1);
    assert.equal(statuses[0].previous_event_id, null);
    const status = await f.ok("GET", `/v1/deletion-requests/${deleted.deletionId}`, {}, owner.headers);
    assert.equal(status.status, "queued");
  } finally { f.close(); }
});

test("receipt report stores exact FK/version branch and independent case access survives receipt revocation", async () => {
  const f = fixture();
  try {
    const owner = await f.login("case-owner@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    const flow = await createAccountUpload(f, owner, space);
    const exchanged = await exchangeReceipt(f, flow.finalized);
    assert.equal(exchanged.status, 200);
    const receiptSecret = exchanged.body.receiptSessionSecret;
    const report = await f.ok("POST", "/v1/reports", {
      targetRef: { photoId: flow.committed.photoId }, category: "privacy", description: "please review", clientRequestId: "report-1"
    }, { "x-receipt-session": receiptSecret,
      "notice-acknowledgement": JSON.stringify({ purpose: "object_report", version: 1, contentHash: "local-object_report-v1" }) });
    const row = f.db.prepare("SELECT * FROM content_cases WHERE id=?").get(report.caseId);
    assert.equal(row.actor_relation_kind, "receipt");
    assert.ok(row.actor_receipt_session_id);
    assert.ok(row.actor_receipt_item_id);
    assert.equal(row.actor_account_id, null);
    assert.equal(row.actor_viewer_session_id, null);
    assert.equal(row.actor_case_access_session_id, null);

    const receipt = f.db.prepare("SELECT * FROM batch_receipts WHERE id=?").get(flow.finalized.receiptId);
    await f.ok("POST", "/v1/batch-receipt/revocations", { confirmation: true, reason: "test" },
      { "x-receipt-session": receiptSecret, "if-match": String(receipt.version),
        "x-space-version": String(f.db.prepare("SELECT version FROM spaces WHERE id=?").get(space.spaceId).version) });
    const oldAccess = await f.call("GET", `/v1/reports/${report.caseId}`, {}, { "x-receipt-session": receiptSecret });
    assert.equal(oldAccess.status, 401);
    const caseAccessHeaders = { "x-case-access-session": report.caseAccessSessionSecret };
    const retained = await f.ok("GET", `/v1/reports/${report.caseId}`, {}, caseAccessHeaders);
    assert.equal(retained.caseId, report.caseId);
    const appeal = await f.ok("POST", "/v1/appeals", {
      targetCaseId: report.caseId, category: "context_missing", statement: "context", clientRequestId: "appeal-1"
    }, { ...caseAccessHeaders,
      "notice-acknowledgement": JSON.stringify({ purpose: "appeal", version: 1, contentHash: "local-appeal-v1" }) });
    assert.equal(f.db.prepare("SELECT actor_relation_kind FROM content_cases WHERE id=?").get(appeal.caseId).actor_relation_kind, "case_access");
  } finally { f.close(); }
});

test("content moderation transition enforces the frozen reason state machine and audit", async () => {
  const f = fixture();
  try {
    const owner = await f.login("review@example.test");
    let space = await f.createSpace(owner);
    space = await f.openSpace(owner, space);
    // A: this test's whole point is the manual pending->visible transition, so keep
    // auto_approve_uploads off (f.createSpace() now defaults it on) rather than let the
    // upload skip straight to 'visible'.
    space = await f.transition(owner, space.spaceId, "auto-approve-uploads", "off", space.version);
    const flow = await createAccountUpload(f, owner, space);
    const photo = f.db.prepare("SELECT * FROM photos WHERE id=?").get(flow.committed.photoId);
    const invalid = await f.call("POST", `/v1/photos/${photo.id}/content-transitions`, {
      to: "hidden", transitionReasonCode: "manual_hidden", decisionReasonCode: null
    }, { ...owner.headers, "if-match": String(photo.version) });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, "decision_reason_required");
    const approved = await f.ok("POST", `/v1/photos/${photo.id}/content-transitions`, {
      to: "visible", transitionReasonCode: "manual_approved", decisionReasonCode: null
    }, { ...owner.headers, "if-match": String(photo.version) });
    const hidden = await f.ok("POST", `/v1/photos/${photo.id}/content-transitions`, {
      to: "hidden", transitionReasonCode: "manual_hidden", decisionReasonCode: "privacy_request"
    }, { ...owner.headers, "if-match": String(approved.version) });
    assert.equal(hidden.after, "hidden");
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM photo_content_events WHERE photo_id=?").get(photo.id).count, 2);
  } finally { f.close(); }
});

test("enumerated case IDs do not cross principals", async () => {
  const f = fixture();
  try {
    const first = await f.login("case-first@example.test");
    const other = await f.login("case-other@example.test");
    let space = await f.createSpace(first);
    space = await f.openSpace(first, space);
    const flow = await createAccountUpload(f, first, space);
    const report = await f.ok("POST", "/v1/reports", {
      targetRef: { photoId: flow.committed.photoId }, category: "safety", description: "review", clientRequestId: "account-report"
    }, { ...first.headers,
      "notice-acknowledgement": JSON.stringify({ purpose: "object_report", version: 1, contentHash: "local-object_report-v1" }) });
    const enumerated = await f.call("GET", `/v1/reports/${report.caseId}`, {}, other.headers);
    assert.equal(enumerated.status, 404);
    assert.equal(enumerated.body.error.code, "case_unavailable");
  } finally { f.close(); }
});
