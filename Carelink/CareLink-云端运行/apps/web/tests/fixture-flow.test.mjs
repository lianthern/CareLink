import test from "node:test";
import assert from "node:assert/strict";
import { FixtureApiAdapter } from "../src/api/fixture-adapter.js";

const memoryStorage = () => {
  let value;
  return { getItem: () => value, setItem: (_, next) => { value = next; } };
};

test("guest view → partial upload → retry → finalize → own placement", async () => {
  const api = new FixtureApiAdapter({ storage: memoryStorage() });
  const exchange = await api.act("INVITATION.EXCHANGE", { entryTask: "view" });
  assert.equal(exchange.destinationRoute, "/s/space-gongguang/album");
  assert.deepEqual(api.state.capabilities, { view: true, upload: true, manage: false });

  const consent = await api.act("UPLOAD.ACCEPT_NOTICE", { noticeVersion: 2, noticeHash: "fe33ba9d5e927dffa281706d6e826d4dd06b26d3ccfca19b3eaba97f340287b0", mediaPolicyVersion: "2", choices: { display: true, placement: true } });
  const batch = await api.act("UPLOAD.SELECT_FILES", { files: ["一.jpg", "二.jpg", "三.png"], consentEventId: consent.consentEventId });
  assert.deepEqual(batch.items.map((item) => item.status), ["committed", "committed", "failed"]);
  await api.act("UPLOAD.RETRY_ITEM", { batchId: batch.id, itemId: batch.items[2].id });
  const finalized = await api.act("UPLOAD.FINALIZE_BATCH", { batchId: batch.id });
  assert.equal(finalized.status, "finalized");
  assert.match(finalized.receiptUrl, /^\/uploads\/open#receipt=/);

  const uncertain = finalized.items[0];
  await api.act("PLACEMENT.CONFIRM", { batchId: batch.id, itemId: uncertain.id, yaw: 41, manager: false });
  const saved = api.state.batches[0].items[0];
  assert.equal(saved.placementState, "confirmed");
  assert.equal(saved.confirmationMode, "manual");
  assert.equal(saved.uploaderCanEdit, true);
  assert.equal(saved.placementAuthorizationVersion, 1);
});

test("campaign preview resolves the real space name for a live token and rejects unknown/inactive tokens uniformly", async () => {
  const api = new FixtureApiAdapter({ storage: memoryStorage() });
  const preview = await api.read("campaignPreview", { token: "gongguang-2026" });
  assert.deepEqual(preview, { displayName: "向晚婚礼" });

  await assert.rejects(() => api.read("campaignPreview", { token: "unknown-token" }),
    (error) => error.code === "campaign_preview_unavailable" && error.status === 404);

  api.state.campaigns[0].campaignStatus = "revoked";
  await assert.rejects(() => api.read("campaignPreview", { token: "gongguang-2026" }),
    (error) => error.code === "campaign_preview_unavailable" && error.status === 404);
});

test("campaign admission remains separate from one-time exchange", async () => {
  const api = new FixtureApiAdapter({ storage: memoryStorage() });
  const admission = await api.admitCampaign("gongguang-2026");
  assert.match(admission.bootstrapUrl, /^\/open#invite=/);
  assert.deepEqual(api.state.capabilities, { view: false, upload: false, manage: false });
  await api.act("INVITATION.EXCHANGE", { inviteSecret: admission.bootstrapUrl.split("=")[1] });
  assert.deepEqual(api.state.capabilities, { view: true, upload: true, manage: false });
});

test("receipt exchange, status resources and invitation revocation are recoverable", async () => {
  const api = new FixtureApiAdapter({ storage: memoryStorage() });
  await api.act("INVITATION.EXCHANGE", { entryTask: "upload" });
  const consent = await api.act("UPLOAD.ACCEPT_NOTICE", { noticeVersion: 2, noticeHash: "fe33ba9d5e927dffa281706d6e826d4dd06b26d3ccfca19b3eaba97f340287b0", mediaPolicyVersion: "2", choices: { display: true, placement: true } });
  const batch = await api.act("UPLOAD.SELECT_FILES", { files: ["一.jpg"], consentEventId: consent.consentEventId });
  const finalized = await api.act("UPLOAD.FINALIZE_BATCH", { batchId: batch.id });
  const receipt = await api.act("BATCH_RECEIPT.EXCHANGE", { receiptSecret: finalized.receiptUrl.split("=")[1] });
  assert.equal(receipt.destinationRoute, `/uploads/${batch.id}`);

  await api.act("AUTH.VERIFY_CODE", { code: "246810" });
  const invitation = await api.act("MEMBER_INVITATION.CREATE", { email: "friend@example.com", tasks: ["view"] });
  await api.act("MEMBER_INVITATION.REVOKE", { invitationId: invitation.invitationId });
  assert.equal(api.state.memberInvitations[0].status, "revoked");
  const exported = await api.act("ACCOUNT.EXPORT");
  const deleted = await api.act("ACCOUNT.DELETE_REQUEST");
  const reported = await api.act("REPORT.SUBMIT", { category: "privacy" });
  const appealed = await api.act("APPEAL.SUBMIT", { description: "请复核" });
  const acceptedTransfer = await api.act("OWNER_TRANSFER.ACCEPT", { transferId: "transfer-incoming" });
  assert.equal(api.state.exports.find((entry) => entry.id === exported.id).status, "ready");
  assert.equal(api.state.deletions.find((entry) => entry.id === deleted.id).status, "requested");
  assert.equal(api.state.reports.find((entry) => entry.id === reported.id).status, "open");
  assert.equal(api.state.appeals.find((entry) => entry.id === appealed.id).status, "open");
  assert.equal(acceptedTransfer.transfer.status, "accepted");
});

test("manager locks one item, sibling remains writable, owner reopens exact item", async () => {
  const api = new FixtureApiAdapter({ storage: memoryStorage() });
  await api.act("INVITATION.EXCHANGE", { entryTask: "upload" });
  const consent = await api.act("UPLOAD.ACCEPT_NOTICE", { noticeVersion: 2, noticeHash: "fe33ba9d5e927dffa281706d6e826d4dd06b26d3ccfca19b3eaba97f340287b0", mediaPolicyVersion: "2", choices: { display: true, placement: true } });
  const batch = await api.act("UPLOAD.SELECT_FILES", { files: ["一.jpg", "二.jpg"], consentEventId: consent.consentEventId });
  const [first, second] = batch.items;

  await api.act("AUTH.VERIFY_CODE", { code: "246810" });
  await api.act("PLACEMENT.SAVE", { batchId: batch.id, itemId: first.id, yaw: 10, manager: true });
  const [lockedFirst, writableSecond] = api.state.batches[0].items;
  assert.equal(lockedFirst.uploaderCanEdit, false);
  assert.equal(lockedFirst.placementAuthorizationVersion, 2);
  assert.equal(writableSecond.uploaderCanEdit, true);
  await assert.rejects(() => api.act("PLACEMENT.SAVE", { batchId: batch.id, itemId: first.id, yaw: 11, manager: false }), (error) => error.code === "placement_write_locked");
  await api.act("PLACEMENT.SAVE", { batchId: batch.id, itemId: second.id, yaw: 32, manager: false });
  await api.act("PLACEMENT.REOPEN_FOR_CONTRIBUTOR", { batchId: batch.id, itemId: first.id });
  assert.equal(api.state.batches[0].items[0].uploaderCanEdit, true);
  assert.equal(api.state.batches[0].items[0].placementAuthorizationVersion, 3);
});

test("content transitions and fixture errors are deterministic", async () => {
  const api = new FixtureApiAdapter({ storage: memoryStorage() });
  await api.act("AUTH.VERIFY_CODE", { code: "246810" });
  await assert.rejects(() => api.act("CONTENT.REJECT", { photoId: "photo-4", decisionReasonCode: "other", note: "" }), (error) => error.code === "decision_note_required");
  const rejected = await api.act("CONTENT.REJECT", { photoId: "photo-4", decisionReasonCode: "unrelated_content" });
  assert.equal(rejected.photo.contentState, "rejected");
  await api.act("CONTENT.REOPEN", { photoId: "photo-4", decisionReasonCode: "reviewer_correction" });
  assert.equal(api.state.photos.find((photo) => photo.id === "photo-4").contentState, "pending");
  await api.act("CONTENT.APPROVE", { photoId: "photo-4" });
  assert.equal(api.state.photos.find((photo) => photo.id === "photo-4").contentState, "visible");

  api.setScenario({ offline: true });
  await assert.rejects(() => api.read("viewerSpace"), (error) => error.code === "network_unavailable" && error.status === 503);
  api.setScenario({ offline: false, nextError: "session_unavailable" });
  await assert.rejects(() => api.read("viewerSpace"), (error) => error.code === "session_unavailable" && error.status === 401);
  assert.equal((await api.read("viewerSpace")).name, "向晚婚礼");
});

test("ensurePersonalSpace lazily creates one personal space and is idempotent on repeat calls", async () => {
  const api = new FixtureApiAdapter({ storage: memoryStorage() });
  await api.act("AUTH.VERIFY_CODE", { code: "246810" });
  assert.equal(api.state.account.personalSpaceId, undefined, "no personal space until the flow is actually used");

  const created = await api.ensurePersonalSpace();
  assert.ok(created.spaceId);
  assert.equal(created.destinationRoute, `/s/${created.spaceId}/upload`);
  assert.equal(api.state.account.personalSpaceId, created.spaceId);
  assert.equal(api.state.currentSpaceId, created.spaceId);
  const personalSpace = api.state.spaces.find((space) => space.id === created.spaceId);
  assert.equal(personalSpace.isPersonalDefault, true);
  assert.equal(personalSpace.collectionState, "open");

  const repeat = await api.ensurePersonalSpace();
  assert.equal(repeat.spaceId, created.spaceId);
  assert.equal(api.state.spaces.filter((space) => space.isPersonalDefault).length, 1);
});

test("ready artifact gates scene upgrade honestly", async () => {
  const api = new FixtureApiAdapter({ storage: memoryStorage() });
  await api.act("AUTH.VERIFY_CODE", { code: "246810" });
  await assert.rejects(() => api.act("PANORAMA.SWITCH_CANDIDATE"), (error) => error.code === "panorama_not_ready");
  const candidate = await api.act("PANORAMA.UPLOAD_CANDIDATE", { fileName: "现场.jpg" });
  assert.equal(candidate.status, "ready");
  const switched = await api.act("PANORAMA.SWITCH_CANDIDATE");
  assert.equal(switched.scene.artifactReady, true);
  assert.equal(switched.scene.mode, "rotation360");
});
