import { actionApi } from "../generated/contracts.js";
import { ApiError } from "./client.js";

const MUTATION_METHODS = new Set(["POST", "PATCH", "DELETE"]);

const field = (name, options = {}) => ({ name, source: options.source || name, ...options });
const body = (fields = [], options = {}) => ({ fields, ...options });
const id = () => crypto.randomUUID();
const number = (value) => Number(value);
const boolean = (value) => value === true || value === "true";
const targetRef = (payload) => payload.targetRef || (payload.photoId ? { type: "photo", id: payload.photoId } : undefined);

// The order below is the wire order used by JSON.stringify. Every field is an
// allowlisted server field from ACTION-API-COVERAGE; UI-only values are never
// copied through to the request body.
export const serverActionRequests = Object.freeze({
  // verificationChallengeId/verificationNonce/verificationSelection carry the solved local proof (see
  // app.js's requestLoginCode()) -- optional, not required, because a "disabled" captcha
  // provider response (see api/client.js's requestOtpVerificationChallenge()) resolves with no
  // proof fields at all, and the server ignores them entirely for a gate it isn't running.
  "AUTH.REQUEST_CODE": body([field("email", { required: true }), field("purpose", { value: "login" }), field("locale", { value: "zh-CN" }), field("noticeVersion"), field("verificationChallengeId"), field("verificationNonce", { map: number }), field("verificationSelection")]),
  "AUTH.VERIFY_CODE": body([field("challengeId", { context: true, required: true }), field("otp", { source: "code", required: true }), field("purpose", { value: "login" })]),
  "AUTH.LOGOUT": body([field("sessionId", { value: "current" })]),
  "AUTH.LOGOUT_ALL": body([field("reauthGrant", { grant: true, required: true }), field("confirmation", { value: true })]),
  "AUTH.REAUTH_REQUEST_CODE": body([field("actionId", { required: true }), field("purpose", { context: true, required: true }), field("targetType"), field("targetId"), field("locale", { value: "zh-CN" })]),
  "AUTH.REAUTHENTICATE": body([field("challengeId", { context: true, required: true }), field("otp", { source: "code", required: true }), field("actionId", { required: true }), field("purpose", { context: true, required: true }), field("targetType"), field("targetId")]),
  "SPACE.CREATE": body([field("name", { required: true })]),
  "UPLOAD.ACCEPT_NOTICE": body([field("purpose", { value: "photo_upload" }), field("noticeVersion", { required: true }), field("noticeHash", { required: true }), field("mediaPolicyVersion", { required: true }), field("choices", { required: true })]),
  "UPLOAD.SELECT_FILES": body([field("clientBatchId", { default: id }), field("consentEventId", { required: true }), field("declaredItemCount", { required: true, map: number })]),
  "UPLOAD.REMOVE_ITEM": body([field("reason", { value: "client_removed" })], { cas: true }),
  "UPLOAD.RETRY_ITEM": body([field("failureVersion", { required: true, map: number })]),
  "UPLOAD.FINALIZE_BATCH": body([field("itemsDigest", { required: true }), field("clientRequestId", { default: id })], { cas: true }),
  "BATCH_RECEIPT.EXCHANGE": body([field("receiptSecretFromClearedBootstrap", { source: "receiptSecret", required: true }), field("clientNonce", { default: id })]),
  "BATCH_BINDING.REQUEST_CODE": body([field("email", { required: true }), field("locale", { value: "zh-CN" })]),
  "BATCH_BINDING.CONFIRM": body([field("challengeId", { context: true, required: true }), field("otp", { source: "code", required: true })], { notice: true }),
  "BATCH.RECOVER_FROM_ACCOUNT": body([field("bindingId", { required: true })]),
  "BATCH_RECEIPT.REVOKE": body([field("confirmation", { value: true }), field("reason")], { cas: true }),
  "BATCH.DELETE_ITEM": body([field("reason", { default: "user_requested" }), field("reauthGrant", { grant: true, required: true })], { cas: true }),
  "PLACEMENT.RETRY": body([field("action", { value: "retry" }), field("failedVersion", { required: true, map: number })]),
  "PLACEMENT.CONFIRM": body([field("mode", { value: "candidate" }), field("suggestionId", { required: true }), field("candidateId", { required: true }), field("confirmationMode", { value: "manual" })], { cas: true }),
  "PLACEMENT.SAVE": body([field("mode", { value: "manual" }), field("yawDeg", { source: "yaw", required: true, map: number }), field("pitchDeg", { map: number }), field("regionId"), field("reason", { required: true })], { cas: true }),
  "PLACEMENT.UNDO": body([field("action", { value: "restore" }), field("targetRevisionId", { required: true }), field("reason", { required: true })], { cas: true }),
  "PLACEMENT.MARK_OUTSIDE": body([field("action", { value: "mark_outside_scene" }), field("reasonCode", { value: "marked_outside_scene" }), field("note")], { cas: true }),
  "PLACEMENT.REOPEN_FOR_CONTRIBUTOR": body([field("reason", { required: true })], { cas: true }),
  "NOTE.OPT_IN": body([field("consentVersion", { required: true }), field("consentHash", { required: true }), field("photoContentHash", { required: true })]),
  "NOTE.CONFIRM": body([field("jobId", { required: true }), field("draftVersion", { required: true, map: number }), field("editedText")], { cas: true }),
  "NOTE.WITHDRAW": body([field("reason")], { cas: true }),
  "CONTENT.APPROVE": body([field("to", { value: "visible" }), field("transitionReasonCode", { value: "manual_approved" }), field("decisionReasonCode", { value: null }), field("note")], { cas: true }),
  "CONTENT.HIDE": body([field("to", { value: "hidden" }), field("transitionReasonCode", { value: "manual_hidden" }), field("decisionReasonCode", { required: true }), field("note")], { cas: true }),
  "CONTENT.REJECT": body([field("to", { value: "rejected" }), field("transitionReasonCode", { value: "manual_rejected" }), field("decisionReasonCode", { required: true }), field("note")], { cas: true }),
  "CONTENT.RESTORE": body([field("to", { value: "visible" }), field("transitionReasonCode", { value: "manual_restored" }), field("decisionReasonCode", { required: true }), field("note")], { cas: true }),
  "CONTENT.REOPEN": body([field("to", { value: "pending" }), field("transitionReasonCode", { value: "manual_reopened" }), field("decisionReasonCode", { required: true }), field("note")], { cas: true }),
  "PANORAMA.SWITCH_CANDIDATE": body([field("mode", { value: "switch" }), field("candidateRevisionId", { required: true }), field("sceneIfMatchVersion", { required: true, map: number })], { cas: true }),
  "PANORAMA.ROLLBACK": body([field("mode", { value: "rollback" }), field("targetPanoramaRevisionId", { required: true }), field("sceneIfMatchVersion", { required: true, map: number })], { cas: true }),
  "EXTERNAL_INVITATION.CREATE": body([field("taskMode", { required: true }), field("entryTask", { required: true }), field("expiresAt", { required: true }), field("maxSuccessfulUses", { required: true, map: number })], { cas: true }),
  "EXTERNAL_INVITATION.REVOKE": body([field("reasonClass", { required: true }), field("clientRequestId", { default: id })], { cas: true }),
  "MEMBER_INVITATION.CREATE": body([field("verifiedIdentifier", { source: "email", required: true }), field("tasks", { required: true }), field("managementScopes", { required: true }), field("expiresAt", { required: true })], { cas: true }),
  "MEMBER_INVITATION.ACCEPT": body([field("secretFromClearedInviteBootstrap", { source: "inviteSecret", required: true }), field("clientNonce", { default: id })]),
  "MEMBER_INVITATION.REVOKE": body([field("reason", { required: true })], { cas: true }),
  "MEMBERSHIP.UPDATE": body([field("tasks", { required: true }), field("managementScopes", { required: true })], { cas: true }),
  "MEMBERSHIP.REVOKE": body([field("reason", { required: true })], { cas: true }),
  "COLLECTION.PAUSE": body([field("to", { value: "paused" })], { cas: true }),
  "COLLECTION.RESUME": body([field("to", { value: "open" })], { cas: true }),
  "SHARING.ENABLE": body([field("to", { value: "shared" })], { cas: true }),
  "SHARING.DISABLE": body([field("to", { value: "private" })], { cas: true }),
  "SPACE.ARCHIVE": body([field("reauthGrant", { grant: true, required: true }), field("reason", { required: true })], { cas: true }),
  "SPACE.RESTORE": body([field("reauthGrant", { grant: true, required: true }), field("sharingState", { value: "private" }), field("collectionState", { value: "paused" })], { cas: true }),
  "SPACE.EXPORT": body([field("scope", { value: "space" }), field("spaceId", { required: true }), field("format", { required: true }), field("reauthGrant", { grant: true })], { optionalGrant: true }),
  "SPACE.DELETE_REQUEST": body([field("reauthGrant", { grant: true, required: true }), field("reason", { required: true }), field("confirmation", { value: true })], { cas: true }),
  "ACCOUNT.EXPORT": body([field("scope", { value: "account" }), field("format", { required: true })]),
  "ACCOUNT.DELETE_REQUEST": body([field("reauthGrant", { grant: true, required: true }), field("confirmation", { value: true })], { cas: true }),
  "OWNER_TRANSFER.CREATE": body([field("targetMembershipId", { required: true }), field("reauthGrant", { grant: true, required: true }), field("ifMatchVersion", { required: true, map: number })]),
  "OWNER_TRANSFER.ACCEPT": body([field("transferId", { required: true }), field("reauthGrant", { grant: true, required: true }), field("ifMatchVersion", { required: true, map: number })]),
  "OWNER_TRANSFER.REVOKE": body([field("ifMatchVersion", { required: true, map: number }), field("reason")]),
  "EXPORT.DOWNLOAD": body([field("clientNonce", { default: id })]),
  "REPORT.SUBMIT": body([field("targetRef", { derive: targetRef, required: true }), field("category", { required: true }), field("description", { required: true }), field("clientRequestId", { default: id })], { notice: true }),
  "APPEAL.SUBMIT": body([field("targetCaseId", { required: true }), field("category", { required: true }), field("statement"), field("clientRequestId", { default: id })], { notice: true }),
  "SUPPORT.SUBMIT_SAFETY_LEAD": body([field("category", { required: true }), field("description", { required: true }), field("contact")])
});

export const reauthPurpose = Object.freeze({
  "AUTH.LOGOUT_ALL": "logout_all",
  "SPACE.ARCHIVE": "space_archive",
  "SPACE.RESTORE": "space_restore",
  "SPACE.DELETE_REQUEST": "space_delete",
  "ACCOUNT.DELETE_REQUEST": "account_delete",
  "OWNER_TRANSFER.CREATE": "owner_transfer_create",
  "OWNER_TRANSFER.ACCEPT": "owner_transfer_accept",
  "BATCH.DELETE_ITEM": "photo_delete"
});

export function buildActionBody(actionId, payload = {}, context = {}) {
  const definition = serverActionRequests[actionId];
  if (!definition) throw new ApiError("request_builder_unavailable", `No request builder for ${actionId}.`, 500);
  const result = {};
  for (const item of definition.fields) {
    let value;
    if (Object.hasOwn(item, "value")) value = item.value;
    else if (item.grant) value = context.reauthGrant;
    else if (item.context) value = context[item.source];
    else if (item.derive) value = item.derive(payload, context);
    else value = payload[item.source];
    if ((value === undefined || value === "") && item.default !== undefined) value = typeof item.default === "function" ? item.default() : item.default;
    if ((value === undefined || value === "") && item.required) throw new ApiError("request_field_missing", `${actionId} 缺少 ${item.name}。`, 400);
    if (value !== undefined) result[item.name] = item.map ? item.map(value) : value;
  }
  return result;
}

export function actionTransportMetadata(actionId, payload = {}, context = {}) {
  const definition = serverActionRequests[actionId];
  if (!definition) throw new ApiError("request_builder_unavailable", `No request builder for ${actionId}.`, 500);
  if (definition.cas && !payload.ifMatch) throw new ApiError("request_if_match_missing", `${actionId} 缺少 read model 的 If-Match 标签。`, 409);
  if (definition.notice && !payload.noticeAcknowledgement) throw new ApiError("notice_acknowledgement_required", `${actionId} 缺少 notice acknowledgement。`, 400);
  return {
    ifMatch: definition.cas ? payload.ifMatch : undefined,
    noticeAcknowledgement: definition.notice ? payload.noticeAcknowledgement : undefined,
    reauthGrant: context.reauthGrant
  };
}

export function assertServerActionRegistry() {
  const frozen = Object.entries(actionApi).filter(([, contract]) => MUTATION_METHODS.has(contract.method)).map(([actionId]) => actionId).sort();
  const builders = Object.keys(serverActionRequests).sort();
  if (JSON.stringify(frozen) !== JSON.stringify(builders)) throw new Error(`Server request registry mismatch. Frozen=${frozen.join(",")} builders=${builders.join(",")}`);
}

assertServerActionRegistry();
