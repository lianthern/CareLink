import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { actionApi } from "../src/generated/contracts.js";
import { actionPathParams, HttpApiAdapter, readApi, resolveActionRequest, resolveReadPath } from "../src/api/http-adapter.js";
import { serverActionRequests } from "../src/api/action-request-registry.js";

const expectedBodyKeys = {
  "AUTH.REQUEST_CODE":"email,purpose,locale,noticeVersion,verificationSelection","AUTH.VERIFY_CODE":"challengeId,otp,purpose","AUTH.LOGOUT":"sessionId","AUTH.LOGOUT_ALL":"reauthGrant,confirmation","AUTH.REAUTH_REQUEST_CODE":"actionId,purpose,targetType,targetId,locale","AUTH.REAUTHENTICATE":"challengeId,otp,actionId,purpose,targetType,targetId","SPACE.CREATE":"name","UPLOAD.ACCEPT_NOTICE":"purpose,noticeVersion,noticeHash,mediaPolicyVersion,choices","UPLOAD.SELECT_FILES":"clientBatchId,consentEventId,declaredItemCount","UPLOAD.REMOVE_ITEM":"reason","UPLOAD.RETRY_ITEM":"failureVersion","UPLOAD.FINALIZE_BATCH":"itemsDigest,clientRequestId","BATCH_RECEIPT.EXCHANGE":"receiptSecretFromClearedBootstrap,clientNonce","BATCH_BINDING.REQUEST_CODE":"email,locale","BATCH_BINDING.CONFIRM":"challengeId,otp","BATCH.RECOVER_FROM_ACCOUNT":"bindingId","BATCH_RECEIPT.REVOKE":"confirmation,reason","BATCH.DELETE_ITEM":"reason,reauthGrant","PLACEMENT.RETRY":"action,failedVersion","PLACEMENT.CONFIRM":"mode,suggestionId,candidateId,confirmationMode","PLACEMENT.SAVE":"mode,yawDeg,pitchDeg,regionId,reason","PLACEMENT.UNDO":"action,targetRevisionId,reason","PLACEMENT.MARK_OUTSIDE":"action,reasonCode,note","PLACEMENT.REOPEN_FOR_CONTRIBUTOR":"reason","NOTE.OPT_IN":"consentVersion,consentHash,photoContentHash","NOTE.CONFIRM":"jobId,draftVersion,editedText","NOTE.WITHDRAW":"reason","CONTENT.APPROVE":"to,transitionReasonCode,decisionReasonCode,note","CONTENT.HIDE":"to,transitionReasonCode,decisionReasonCode,note","CONTENT.REJECT":"to,transitionReasonCode,decisionReasonCode,note","CONTENT.RESTORE":"to,transitionReasonCode,decisionReasonCode,note","CONTENT.REOPEN":"to,transitionReasonCode,decisionReasonCode,note","PANORAMA.SWITCH_CANDIDATE":"mode,candidateRevisionId,sceneIfMatchVersion","PANORAMA.ROLLBACK":"mode,targetPanoramaRevisionId,sceneIfMatchVersion","EXTERNAL_INVITATION.CREATE":"taskMode,entryTask,expiresAt,maxSuccessfulUses","EXTERNAL_INVITATION.REVOKE":"reasonClass,clientRequestId","MEMBER_INVITATION.CREATE":"verifiedIdentifier,tasks,managementScopes,expiresAt","MEMBER_INVITATION.ACCEPT":"secretFromClearedInviteBootstrap,clientNonce","MEMBER_INVITATION.REVOKE":"reason","MEMBERSHIP.UPDATE":"tasks,managementScopes","MEMBERSHIP.REVOKE":"reason","COLLECTION.PAUSE":"to","COLLECTION.RESUME":"to","SHARING.ENABLE":"to","SHARING.DISABLE":"to","SPACE.ARCHIVE":"reauthGrant,reason","SPACE.RESTORE":"reauthGrant,sharingState,collectionState","SPACE.EXPORT":"scope,spaceId,format,reauthGrant","SPACE.DELETE_REQUEST":"reauthGrant,reason,confirmation","ACCOUNT.EXPORT":"scope,format","ACCOUNT.DELETE_REQUEST":"reauthGrant,confirmation","OWNER_TRANSFER.CREATE":"targetMembershipId,reauthGrant,ifMatchVersion","OWNER_TRANSFER.ACCEPT":"transferId,reauthGrant,ifMatchVersion","OWNER_TRANSFER.REVOKE":"ifMatchVersion,reason","EXPORT.DOWNLOAD":"clientNonce","REPORT.SUBMIT":"targetRef,category,description,clientRequestId","APPEAL.SUBMIT":"targetCaseId,category,statement,clientRequestId","SUPPORT.SUBMIT_SAFETY_LEAD":"category,description,contact"
};

const sample = {
  spaceId:"space / 1", batchId:"batch / 1", itemId:"item / 1", photoId:"photo / 1", receiptId:"receipt / 1", campaignId:"campaign / 1", invitationId:"invite / 1", membershipId:"member / 1", transferId:"transfer / 1", exportId:"export / 1", deletionId:"deletion / 1", caseId:"case / 1",
  failedVersion:4,
  actionId:"SPACE.ARCHIVE", name:"向晚婚礼", email:"person@example.com", code:"123456", noticeVersion:1, verificationSelection:[1,4], noticeHash:"notice-hash", mediaPolicyVersion:"media-v1", choices:{display:true}, clientBatchId:"client-batch", consentEventId:"consent-1", declaredItemCount:2, failureVersion:4, itemsDigest:"digest-1", clientRequestId:"request-1", receiptSecret:["receipt", "secret"].join("-"), inviteSecret:["invite", "secret"].join("-"), bindingId:"binding-1", reason:"contract-reason", yaw:"47", pitchDeg:"3", regionId:"region-1", suggestionId:"suggestion-1", candidateId:"candidate-1", targetRevisionId:"placement-1", note:"note", consentVersion:1, consentHash:"consent-hash", photoContentHash:"photo-hash", jobId:"job-1", draftVersion:2, editedText:"edited", decisionReasonCode:"other", candidateRevisionId:"pano-2", targetPanoramaRevisionId:"pano-1", sceneIfMatchVersion:2, taskMode:"combo", entryTask:"view", expiresAt:"2026-09-13T00:00:00Z", maxSuccessfulUses:"100", reasonClass:"owner_revoked", tasks:["view"], managementScopes:["canReview"], targetMembershipId:"member-1", ifMatchVersion:"7", format:"json", clientNonce:"nonce-1", targetRef:{type:"photo",id:"photo-1"}, category:"other", description:"description", targetCaseId:"case-1", statement:"statement", contact:"contact@example.com", targetType:"space", targetId:"space / 1", ifMatch:'"snapshot-v1"', noticeAcknowledgement:"notice:v1:hash"
};
const context = { spaceId:sample.spaceId, challengeId:"challenge-1", purpose:"space_archive", reauthGrant:"grant-1" };

test("all 58 frozen server mutations have byte-stable request builders and exact URLs", async () => {
  assert.equal(Object.keys(serverActionRequests).length, 58);
  assert.deepEqual(Object.keys(serverActionRequests).sort(), Object.keys(expectedBodyKeys).sort());
  const captures = [];
  const adapter = new HttpApiAdapter({ transport: async (url, init) => { captures.push({ url, init }); return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }); } });
  for (const [actionId, definition] of Object.entries(serverActionRequests)) {
    const request = resolveActionRequest(actionId, sample, context);
    assert.equal(request.method, actionApi[actionId].method, actionId);
    assert.ok(request.path.startsWith("/v1/") || request.path.startsWith("/v2-experiments/"), actionId);
    assert.doesNotMatch(request.path, /\{|\}|(^|[^:])\/{2,}/, actionId);
    assert.deepEqual(Object.keys(request.body), expectedBodyKeys[actionId].split(","), actionId);
    assert.equal(JSON.stringify(request.body), JSON.stringify(Object.fromEntries(expectedBodyKeys[actionId].split(",").map((key) => [key, request.body[key]]))), `${actionId} byte order`);
    assert.equal(Object.hasOwn(request.body, "manager"), false, actionId);
    assert.equal(Object.hasOwn(request.body, "files"), false, actionId);
    await adapter.send({ ...request, idempotencyKey: `idem-${actionId}` });
    const sent = captures.at(-1);
    assert.equal(sent.url, request.path, actionId);
    assert.equal(sent.init.method, request.method, actionId);
    assert.equal(sent.init.body, JSON.stringify(request.body), actionId);
    assert.equal(sent.init.headers["Idempotency-Key"], `idem-${actionId}`, actionId);
    assert.equal(sent.init.headers["If-Match"], definition.cas ? sample.ifMatch : undefined, actionId);
    assert.equal(sent.init.headers["Notice-Acknowledgement"], definition.notice ? sample.noticeAcknowledgement : undefined, actionId);
  }
  assert.equal(resolveActionRequest("UPLOAD.SELECT_FILES", sample, context).path, "/v1/spaces/space%20%2F%201/contribution-batches");
  assert.equal(resolveActionRequest("UPLOAD.FINALIZE_BATCH", sample, context).path, "/v1/contribution-batches/batch%20%2F%201/finalizations");
  assert.equal(resolveActionRequest("CONTENT.APPROVE", sample, context).path, "/v1/photos/photo%20%2F%201/content-transitions");
  assert.equal(resolveActionRequest("MEMBERSHIP.UPDATE", sample, context).path, "/v1/spaces/space%20%2F%201/memberships/member%20%2F%201");
});

test("P0 canonical bodies are exact and CAS is fail-closed", () => {
  assert.deepEqual(resolveActionRequest("CONTENT.APPROVE", sample, context).body, { to:"visible", transitionReasonCode:"manual_approved", decisionReasonCode:null, note:"note" });
  assert.deepEqual(resolveActionRequest("COLLECTION.PAUSE", sample, context).body, { to:"paused" });
  assert.deepEqual(resolveActionRequest("UPLOAD.FINALIZE_BATCH", sample, context).body, { itemsDigest:"digest-1", clientRequestId:"request-1" });
  assert.throws(() => resolveActionRequest("UPLOAD.FINALIZE_BATCH", { ...sample, ifMatch:"" }, context), /If-Match/);
  assert.throws(() => resolveActionRequest("UPLOAD.FINALIZE_BATCH", { ...sample, batchId:"" }, context), /batchId/);
});

test("all canonical reads resolve exact encoded paths", () => {
  const params = { spaceId:"space / 1", photoId:"photo / 1", batchId:"batch / 1", itemId:"item / 1", exportId:"export / 1", deletionId:"delete / 1", caseId:"case / 1", jobId:"job / 1", token:"token / 1" };
  for (const resource of Object.keys(readApi)) {
    const path = resolveReadPath(resource, params);
    assert.doesNotMatch(path, /\{|\}|(^|[^:])\/{2,}/, resource);
    assert.ok(path.startsWith("/v1/"), resource);
  }
  assert.equal(resolveReadPath("viewerPhotoDetail", params), "/v1/viewer/spaces/space%20%2F%201/photos/photo%20%2F%201");
  assert.equal(resolveReadPath("batchItemPlacementEdit", params), "/v1/batch-receipt/items/item%20%2F%201/placement-edit");
  assert.equal(resolveReadPath("campaignPreview", params), "/v1/external-invitation-campaigns/token%20%2F%201/preview");
});

test("OTP, binding and reauth preserve challenge identity and consume exact grant once", async () => {
  const sent = [];
  const transport = async (url, init) => {
    sent.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const response = url.endsWith("email-otp-challenges") ? { challengeId:"login-challenge" }
      : url.endsWith("email-otp-verifications") ? { account:{ id:"account-1" } }
      : url.endsWith("account-binding-otp-challenges") ? { challengeId:"binding-challenge" }
      : url.endsWith("account-bindings") ? { bindingId:"binding-1" }
      : url.endsWith("reauth-challenges") ? { challengeId:"reauth-challenge" }
      : url.endsWith("reauth-verifications") ? { reauthGrant:"grant-once" }
      : { archived:true };
    return new Response(JSON.stringify(response), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  const adapter = new HttpApiAdapter({ transport });
  adapter.selectSpace("space-1");
  await adapter.act("AUTH.REQUEST_CODE", { email:"person@example.com" });
  await adapter.act("AUTH.VERIFY_CODE", { code:"123456" });
  assert.deepEqual(sent.at(-1).body, { challengeId:"login-challenge", otp:"123456", purpose:"login" });
  await adapter.act("BATCH_BINDING.REQUEST_CODE", { email:"person@example.com" });
  await adapter.act("BATCH_BINDING.CONFIRM", { code:"123456", noticeAcknowledgement:"binding:v1:hash" });
  assert.deepEqual(sent.at(-1).body, { challengeId:"binding-challenge", otp:"123456" });
  assert.equal(sent.at(-1).init.headers["Notice-Acknowledgement"], "binding:v1:hash");
  await adapter.act("AUTH.REAUTH_REQUEST_CODE", { actionId:"SPACE.ARCHIVE", spaceId:"space-1", targetType:"space", targetId:"space-1" });
  await adapter.act("AUTH.REAUTHENTICATE", { actionId:"SPACE.ARCHIVE", code:"123456", spaceId:"space-1", targetType:"space", targetId:"space-1" });
  await adapter.act("SPACE.ARCHIVE", { spaceId:"space-1", ifMatch:'"space-v1"', reason:"owner_archived" });
  assert.deepEqual(sent.at(-1).body, { reauthGrant:"grant-once", reason:"owner_archived" });
  await assert.rejects(adapter.act("SPACE.ARCHIVE", { spaceId:"space-1", ifMatch:'"space-v2"', reason:"owner_archived" }), /reauthGrant/);
});

test("receipt recovery exposes one canonical error while OTP keeps recovery_window_closed", async () => {
  const adapter = new HttpApiAdapter({ transport: async (url) => new Response(JSON.stringify({ code: url.endsWith("account-binding-otp-challenges") ? "recovery_window_closed" : "recovery_unavailable" }), { status:409, headers:{ "Content-Type":"application/json" } }) });
  await assert.rejects(adapter.act("BATCH.RECOVER_FROM_ACCOUNT", { bindingId:"binding-1" }), (error) => error.code === "receipt_recovery_unavailable" && error.message.includes("无法恢复"));
  await assert.rejects(adapter.act("BATCH_BINDING.REQUEST_CODE", { email:"person@example.com" }), (error) => error.code === "recovery_window_closed" && error.message.includes("窗口已关闭"));
});

test("one-time reauth grants are purpose and target bound for sensitive photo deletion", async () => {
  const sent = [];
  const transport = async (url, init) => {
    const request = { url, body: init.body ? JSON.parse(init.body) : null };
    sent.push(request);
    const response = url.endsWith("reauth-challenges") ? { challengeId:`challenge-${request.body.targetId}` }
      : url.endsWith("reauth-verifications") ? { reauthGrant:`grant-${request.body.targetId}` }
      : { deleted:true };
    return new Response(JSON.stringify(response), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  const adapter = new HttpApiAdapter({ transport });
  adapter.selectSpace("space-1");
  const target = (photoId) => ({ actionId:"BATCH.DELETE_ITEM", spaceId:"space-1", photoId, targetType:"photo", targetId:photoId });
  await adapter.act("AUTH.REAUTH_REQUEST_CODE", target("photo-1"));
  await adapter.act("AUTH.REAUTHENTICATE", { ...target("photo-1"), code:"123456" });
  await adapter.act("AUTH.REAUTH_REQUEST_CODE", target("photo-2"));
  await adapter.act("AUTH.REAUTHENTICATE", { ...target("photo-2"), code:"123456" });
  assert.deepEqual(sent.at(-1).body, { challengeId:"challenge-photo-2", otp:"123456", actionId:"BATCH.DELETE_ITEM", purpose:"photo_delete", targetType:"photo", targetId:"photo-2" });
  await adapter.act("BATCH.DELETE_ITEM", { photoId:"photo-2", ifMatch:'"photo-v1"', reason:"user_requested" });
  assert.deepEqual(sent.at(-1).body, { reason:"user_requested", reauthGrant:"grant-photo-2" });
  await adapter.act("BATCH.DELETE_ITEM", { photoId:"photo-1", ifMatch:'"photo-v1"', reason:"user_requested" });
  assert.deepEqual(sent.at(-1).body, { reason:"user_requested", reauthGrant:"grant-photo-1" });
  await assert.rejects(adapter.act("BATCH.DELETE_ITEM", { photoId:"photo-2", ifMatch:'"photo-v2"', reason:"user_requested" }), /reauthGrant/);
});


test("pending OTP registration never projects an authenticated account", async () => {
  let response = { registration: { accountId: "pending-account", status: "pending" } };
  const adapter = new HttpApiAdapter({ transport: async url => new Response(JSON.stringify(url.endsWith("email-otp-challenges") ? {challengeId:"challenge"} : response), {status:200,headers:{"Content-Type":"application/json"}}) });
  await adapter.act("AUTH.REQUEST_CODE", {email:"pending@example.test"});
  const pending = await adapter.act("AUTH.VERIFY_CODE", { challengeId: "challenge", code: "123456" });
  assert.equal(pending.registration.status, "pending");
  assert.equal(adapter.sessionProjection.account, null);
  assert.deepEqual(adapter.sessionProjection.capabilities, { view: false, upload: false, manage: false });
  response = { accountId: "approved-account" };
  await adapter.act("AUTH.VERIFY_CODE", { challengeId: "approved-challenge", code: "123456" });
  assert.equal(adapter.sessionProjection.account.authenticated, true);
});

test("actual login form branch stays on pending message and navigates only after normal verification", async () => {
  const source = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  const start = source.indexOf('  if (form.matches("[data-login-form]")) {', source.indexOf('app.addEventListener("submit"'));
  const end = source.indexOf('  if (form.matches("[data-open-space-form]")) {', start);
  assert.ok(start > 0 && end > start);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction("form", "values", "api", "app", "state", "loginPage", "bindPostRender", "announce", "navigate", "safeReturnTarget", "location", "actionCopy",
    `let loginChallengeSent = true; ${source.slice(start, end)}`);
  for (const pending of [true, false]) {
    const notices = [], destinations = [], app = { innerHTML: "" };
    await run({ matches: () => true }, {}, { act: async () => pending ? { registration: { status: "pending" } } : { accountId: "approved" } }, app, {},
      (_state, sent, message) => { assert.equal(sent, false); return message; }, () => {}, text => notices.push(text), async to => destinations.push(to), (_to, fallback) => fallback, { search: "" }, () => "登录成功");
    if (pending) {
      assert.match(app.innerHTML, /等待管理员审核/);
      assert.deepEqual(destinations, []);
      assert.ok(notices.every(text => !text.includes("登录成功")));
    } else {
      assert.deepEqual(destinations, ["/spaces"]);
      assert.deepEqual(notices, ["登录成功"]);
    }
  }
});
