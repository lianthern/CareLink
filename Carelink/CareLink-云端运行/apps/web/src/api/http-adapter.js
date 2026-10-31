import { actionApi } from "../generated/contracts.js";
import { ApiError } from "./client.js";
import { actionTransportMetadata, buildActionBody, reauthPurpose } from "./action-request-registry.js";

const HTTP_METHODS = new Set(["GET", "POST", "PATCH", "DELETE"]);
const MUTATION_METHODS = new Set(["POST", "PATCH", "DELETE"]);
const pathPattern = /\{(\w+)\}/g;
const canonicalErrorAliases = Object.freeze({ recovery_unavailable: "receipt_recovery_unavailable" });
const canonicalErrorCopy = Object.freeze({
  receipt_recovery_unavailable: "这份上传记录现在无法恢复，请重新确认绑定账号或联系支持。",
  recovery_window_closed: "这份上传记录的恢复窗口已关闭。",
  otp_verification_required: "请先完成人机验证。",
  otp_verification_failed: "人机验证未通过，请重新验证。",
  otp_verification_unavailable: "人机验证服务暂时不可用，请稍后重试。"
});

export const actionPathParams = Object.freeze({
  "SPACE.OPEN": { spaceId: "spaceId" },
  "VIEW.OPEN_ALBUM": { sid: "spaceId" },
  "VIEW.OPEN_SCENE": { sid: "spaceId" },
  "PHOTO.OPEN_DETAIL": { sid: "spaceId", pid: "photoId" },
  "PHOTO.RETURN_TO_SCENE": { sid: "spaceId", pid: "photoId" },
  "UPLOAD.OPEN": { spaceId: "spaceId" },
  "UPLOAD.SELECT_FILES": { sid: "spaceId" },
  "UPLOAD.REMOVE_ITEM": { bid: "batchId", iid: "itemId" },
  "UPLOAD.RETRY_ITEM": { bid: "batchId", iid: "itemId" },
  "UPLOAD.FINALIZE_BATCH": { bid: "batchId" },
  "BATCH.OPEN_ITEM": { itemId: "itemId" },
  "BATCH.DELETE_ITEM": { pid: "photoId" },
  "PLACEMENT.RETRY": { pid: "photoId" },
  "PLACEMENT.CONFIRM": { pid: "photoId" },
  "PLACEMENT.OPEN_EDITOR": { pid: "photoId" },
  "PLACEMENT.SAVE": { pid: "photoId" },
  "PLACEMENT.UNDO": { pid: "photoId" },
  "PLACEMENT.MARK_OUTSIDE": { pid: "photoId" },
  "PLACEMENT.REOPEN_FOR_CONTRIBUTOR": { rid: "receiptId", iid: "itemId" },
  "NOTE.OPT_IN": { iid: "itemId" },
  "NOTE.CONFIRM": { iid: "itemId" },
  "NOTE.WITHDRAW": { iid: "itemId" },
  "MANAGE.OPEN": { sid: "spaceId" },
  "MANAGE.OPEN_NEXT": { sid: "spaceId" },
  "CONTENT.APPROVE": { pid: "photoId" },
  "CONTENT.HIDE": { pid: "photoId" },
  "CONTENT.REJECT": { pid: "photoId" },
  "CONTENT.RESTORE": { pid: "photoId" },
  "CONTENT.REOPEN": { pid: "photoId" },
  "PANORAMA.SWITCH_CANDIDATE": { sid: "spaceId" },
  "PANORAMA.ROLLBACK": { sid: "spaceId" },
  "EXTERNAL_INVITATION.CREATE": { sid: "spaceId" },
  "EXTERNAL_INVITATION.REVOKE": { cid: "campaignId" },
  "MEMBER_INVITATION.CREATE": { sid: "spaceId" },
  "MEMBER_INVITATION.REVOKE": { iid: "invitationId" },
  "MEMBERSHIP.UPDATE": { sid: "spaceId", mid: "membershipId" },
  "MEMBERSHIP.REVOKE": { sid: "spaceId", mid: "membershipId" },
  "COLLECTION.PAUSE": { sid: "spaceId" },
  "COLLECTION.RESUME": { sid: "spaceId" },
  "SHARING.ENABLE": { sid: "spaceId" },
  "SHARING.DISABLE": { sid: "spaceId" },
  "SPACE.ARCHIVE": { sid: "spaceId" },
  "SPACE.RESTORE": { sid: "spaceId" },
  "SPACE.DELETE_REQUEST": { sid: "spaceId" },
  "OWNER_TRANSFER.CREATE": { sid: "spaceId" },
  "OWNER_TRANSFER.REVOKE": { tid: "transferId" },
  "EXPORT.OPEN_STATUS": { eid: "exportId" },
  "EXPORT.DOWNLOAD": { eid: "exportId" },
  "DELETION.OPEN_STATUS": { did: "deletionId" },
  "REPORT.OPEN_STATUS": { caseId: "caseId" },
  "APPEAL.OPEN_STATUS": { caseId: "caseId" },
  "SUPPORT.OPEN_STATUS": { caseId: "caseId" }
});

export const readApi = Object.freeze({
  state: "/v1/me",
  mySpaces: "/v1/me/spaces",
  ownerTransfers: "/v1/me/owner-transfers",
  campaignPreview: "/v1/external-invitation-campaigns/{token}/preview",
  viewerSpace: "/v1/viewer/spaces/{sid}",
  viewerPhotoDetail: "/v1/viewer/spaces/{sid}/photos/{pid}",
  viewerSceneContext: "/v1/viewer/spaces/{sid}/photos/{pid}/scene-context",
  uploadContext: "/v1/spaces/{sid}/upload-context",
  batchResult: "/v1/contribution-batches/{bid}/result",
  batchReceipt: "/v1/batch-receipt",
  batchReceiptItem: "/v1/batch-receipt/items/{iid}",
  batchItemPlacementEdit: "/v1/batch-receipt/items/{iid}/placement-edit",
  placementEdit: "/v1/photos/{pid}/placement-edit",
  managementView: "/v1/spaces/{sid}/management",
  publicListing: "/v1/spaces/{sid}/public-listing",
  discoverSpaces: "/v1/discover/spaces",
  accountBatchBindings: "/v1/me/batch-receipt-bindings",
  exportStatus: "/v1/exports/{eid}",
  deletionStatus: "/v1/deletion-requests/{did}",
  reportStatus: "/v1/reports/{caseId}",
  appealStatus: "/v1/appeals/{caseId}",
  supportStatus: "/v1/support-cases/{caseId}",
  jobStatus: "/v1/jobs/{jid}"
});

export const readPathParams = Object.freeze({
  campaignPreview: { token: "token" },
  viewerSpace: { sid: "spaceId" },
  viewerPhotoDetail: { sid: "spaceId", pid: "photoId" },
  viewerSceneContext: { sid: "spaceId", pid: "photoId" },
  uploadContext: { sid: "spaceId" },
  batchResult: { bid: "batchId" },
  batchReceiptItem: { iid: "itemId" },
  batchItemPlacementEdit: { iid: "itemId" },
  placementEdit: { pid: "photoId" },
  managementView: { sid: "spaceId" },
  publicListing: { sid: "spaceId" },
  exportStatus: { eid: "exportId" },
  deletionStatus: { did: "deletionId" },
  reportStatus: { caseId: "caseId" },
  appealStatus: { caseId: "caseId" },
  supportStatus: { caseId: "caseId" },
  jobStatus: { jid: "jobId" }
});

const externalExchangeContract = Object.freeze({ method: "POST", endpoint: "/v1/external-invitation-exchanges" });
function assertMappings() {
  for (const [actionId, contract] of Object.entries(actionApi)) assertPlaceholderMap(actionId, contract.endpoint, actionPathParams[actionId]);
  for (const [resource, endpoint] of Object.entries(readApi)) assertPlaceholderMap(resource, endpoint, readPathParams[resource]);
}

function assertPlaceholderMap(label, endpoint, mapping = {}) {
  const placeholders = [...endpoint.matchAll(pathPattern)].map((match) => match[1]);
  if (placeholders.some((placeholder) => !mapping[placeholder])) throw new Error(`Missing path parameter mapping for ${label}: ${endpoint}`);
  if (Object.keys(mapping).some((placeholder) => !placeholders.includes(placeholder))) throw new Error(`Unexpected path parameter mapping for ${label}: ${placeholder}`);
}

function resolveEndpoint(endpoint, mapping = {}, values = {}, label = "request") {
  const resolved = endpoint.replace(pathPattern, (_, placeholder) => {
    const alias = mapping[placeholder];
    const value = values[alias];
    if (value === undefined || value === null || String(value).trim() === "") throw new ApiError("request_path_parameter_missing", `${label} 缺少路径参数 ${alias || placeholder}。`, 500);
    return encodeURIComponent(String(value));
  });
  if (/\{\w+\}/.test(resolved) || /(^|[^:])\/{2,}/.test(resolved)) throw new ApiError("request_path_invalid", `${label} 生成了无效路径。`, 500);
  return resolved;
}

export function resolveActionRequest(actionId, payload = {}, context = {}) {
  const contract = actionId === "INVITATION.EXCHANGE" ? externalExchangeContract : actionApi[actionId];
  if (!contract || !HTTP_METHODS.has(contract.method)) return null;
  const mapping = actionPathParams[actionId] || {};
  const values = { ...context, ...payload };
  const path = resolveEndpoint(contract.endpoint, mapping, values, actionId);
  if (contract.method === "GET") return { method: contract.method, path };
  if (actionId === "INVITATION.EXCHANGE") {
    if (!payload.inviteSecret) throw new ApiError("request_field_missing", "INVITATION.EXCHANGE 缺少已清理的邀请凭据。", 400);
    return { method: "POST", path, body: { secretFromClearedInviteBootstrap: payload.inviteSecret, clientNonce: payload.clientNonce || crypto.randomUUID() } };
  }
  const metadata = actionTransportMetadata(actionId, payload, context);
  return { method: contract.method, path, body: buildActionBody(actionId, payload, context), ...metadata };
}

export function resolveReadPath(resource, params = {}) {
  const endpoint = readApi[resource];
  if (!endpoint) throw new ApiError("read_boundary_unavailable", `Unknown canonical read: ${resource}`, 500);
  return resolveEndpoint(endpoint, readPathParams[resource], params, resource);
}

assertMappings();

export class HttpApiAdapter {
  constructor({ baseUrl = "", transport = globalThis.fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.transport = (...args) => transport(...args);
    this.kind = "production";
    this.cache = { activeBatch: null };
    this.challenges = new Map();
    this.reauthGrants = new Map();
    this.sessionProjection = { mode: "production", account: null, capabilities: { view: false, upload: false, manage: false }, currentSpaceId: "", spaces: [], memberships: [], campaigns: [], batches: [], photos: [], pendingOwnerTransfers: [], incomingOwnerTransfers: [], reports: [], appeals: [], cases: [], exports: [], deletions: [] };
  }

  async read(resource, params = {}) {
    if (resource === "state") return this.#readState(params);
    if (resource === "activeBatch") return structuredClone(this.cache.activeBatch);
    return this.send({ method: "GET", path: resolveReadPath(resource, params) });
  }

  async act(actionId, payload = {}) {
    const targetActionId = actionId === "AUTH.REAUTH_REQUEST_CODE" || actionId === "AUTH.REAUTHENTICATE" ? payload.actionId : actionId;
    const purpose = reauthPurpose[targetActionId];
    const challengeKey = this.#challengeKey(targetActionId, payload);
    const grantKey = challengeKey;
    const context = {
      spaceId: this.sessionProjection.currentSpaceId,
      purpose,
      challengeId: this.challenges.get(actionId === "AUTH.VERIFY_CODE" ? "login" : actionId === "BATCH_BINDING.CONFIRM" ? "binding" : challengeKey),
      reauthGrant: this.reauthGrants.get(grantKey)
    };
    const request = resolveActionRequest(actionId, payload, context);
    if (!request) {
      if (actionApi[actionId]?.method === "WORKFLOW") throw new ApiError("workflow_unavailable", `${actionId} 需要专用工作流。`, 501);
      return { actionId, clientOnly: true };
    }
    const result = await this.send(request);
    if (actionId === "AUTH.REQUEST_CODE") this.challenges.set("login", result.challengeId);
    if (actionId === "BATCH_BINDING.REQUEST_CODE") this.challenges.set("binding", result.challengeId);
    if (actionId === "AUTH.REAUTH_REQUEST_CODE") this.challenges.set(challengeKey, result.challengeId);
    if (actionId === "AUTH.REAUTHENTICATE") {
      const grant = result.reauthGrant || result.grant;
      if (!grant) throw new ApiError("reauth_grant_missing", "再次验证未返回可用授权。", 502);
      this.reauthGrants.set(challengeKey, grant);
    }
    if (reauthPurpose[actionId] && result) this.reauthGrants.delete(grantKey);
    this.#projectAction(actionId, result);
    return result;
  }

  selectSpace(spaceId) {
    this.sessionProjection.currentSpaceId = spaceId;
  }

  async admitCampaign(publicCampaignId) {
    const clientNonce = crypto.randomUUID();
    await this.send({ method: "POST", path: "/v1/external-campaign-admission-challenges", body: { publicCampaignId, clientNonce } });
    return this.send({ method: "POST", path: "/v1/external-campaign-admissions", body: { publicCampaignId, clientNonce } });
  }

  // Human-verification descriptor for the /login "获取验证码" flow (see app.js's
  // requestLoginCode()). It is outside the frozen action registry and goes straight through
  // send() like admitCampaign() below; provider-issued proofs are consumed by AUTH.REQUEST_CODE.
  requestOtpVerificationChallenge() {
    return this.send({ method: "POST", path: "/v1/auth/otp-verification-challenges", body: {} });
  }

  // "申请公开这个空间" — a one-off owner mutation outside the frozen action registry (see
  // ui/templates.js's publicListingSetting / app.js's data-request-public-listing handler), so it
  // goes straight through send() the same way admitCampaign() above does.
  requestPublicListing(spaceId) {
    return this.send({ method: "POST", path: `/v1/spaces/${encodeURIComponent(spaceId)}/public-listing-requests`, body: {} });
  }

  async updateSpaceWishes(spaceId, wishes, ifMatch) {
    if (typeof spaceId !== "string" || spaceId === "") throw new ApiError("request_path_parameter_missing", "缺少空间编号。", 500);
    return this.send({ method: "PATCH", path: `/v1/spaces/${encodeURIComponent(spaceId)}/wishes`, body: { wishes }, ifMatch });
  }

  // A: "上传自动通过" owner toggle — same one-off-outside-the-action-registry
  // shape as updateSpaceWishes/requestPublicListing above (see
  // services/api/src/space-service.mjs transitionAutoApproveUploads()).
  async updateAutoApproveUploads(spaceId, to, ifMatch) {
    if (typeof spaceId !== "string" || spaceId === "") throw new ApiError("request_path_parameter_missing", "缺少空间编号。", 500);
    return this.send({ method: "POST", path: `/v1/spaces/${encodeURIComponent(spaceId)}/auto-approve-uploads-transitions`, body: { to }, ifMatch });
  }

  // v3.1 "传到我的空间": POST /v1/me/personal-space is idempotent server-side
  // (services/api/src/space-service.mjs ensurePersonal()), so no client-side
  // dedupe is needed here beyond what send() already does for every mutation.
  async ensurePersonalSpace() {
    const result = await this.send({ method: "POST", path: "/v1/me/personal-space", body: {} });
    if (result.spaceId) this.sessionProjection = { ...this.sessionProjection, currentSpaceId: result.spaceId,
      account: this.sessionProjection.account ? { ...this.sessionProjection.account, personalSpaceId: result.spaceId } : this.sessionProjection.account,
      // Without this, spaceHead() falls back to the generic "空间" label until
      // the next full state hydration repopulates spaces[] from the server —
      // the same gap SPACE.CREATE's own #projectAction() below leaves open.
      spaces: this.sessionProjection.spaces.some((space) => space.id === result.spaceId) ? this.sessionProjection.spaces :
        [...this.sessionProjection.spaces, { id: result.spaceId, name: result.name || "我的空间" }] };
    return result;
  }

  async send({ method, path, body, ifMatch, noticeAcknowledgement, headers = {}, idempotencyKey, signal }) {
    if (/\{\w+\}/.test(path) || /(^|[^:])\/{2,}/.test(path)) throw new ApiError("request_path_invalid", "请求路径未完全解析。", 500);
    const mutation = MUTATION_METHODS.has(method);
    const response = await this.transport(`${this.baseUrl}${path}`, {
      method,
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(mutation ? { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey || crypto.randomUUID() } : {}),
        ...(ifMatch ? { "If-Match": String(ifMatch) } : {}),
        ...(noticeAcknowledgement ? { "Notice-Acknowledgement": String(noticeAcknowledgement) } : {}),
        ...headers
      },
      body: mutation ? JSON.stringify(body || {}) : undefined,
      signal
    });
    return this.#parse(response);
  }

  async #parse(response) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const receivedCode = body.code || "resource_unavailable";
      const code = canonicalErrorAliases[receivedCode] || receivedCode;
      throw new ApiError(code, body.message || canonicalErrorCopy[code], response.status);
    }
    return body;
  }

  async #readState({ hydrateAccount = false } = {}) {
    if (!hydrateAccount) return structuredClone(this.sessionProjection);
    const [meResponse, spacesResponse, transfersResponse] = await Promise.all([
      this.send({ method: "GET", path: readApi.state }),
      this.send({ method: "GET", path: readApi.mySpaces }),
      this.send({ method: "GET", path: readApi.ownerTransfers })
    ]);
    const [me, spacesBody, transfersBody] = [meResponse, spacesResponse, transfersResponse];
    const spacesValue = spacesBody.spaces || spacesBody.items || spacesBody;
    const transfersValue = transfersBody.incoming || transfersBody.incomingOwnerTransfers || transfersBody.transfers || transfersBody.items || transfersBody;
    const spaces = Array.isArray(spacesValue) ? spacesValue : [];
    const incomingOwnerTransfers = Array.isArray(transfersValue) ? transfersValue : [];
    const pendingOwnerTransfers = transfersBody.pending || transfersBody.pendingOwnerTransfers || [];
    const memberships = transfersBody.eligibleMemberships || transfersBody.memberships || [];
    const currentSpaceId = this.sessionProjection.currentSpaceId || spaces[0]?.id || "";
    const selected = spaces.find((space) => space.id === currentSpaceId);
    this.sessionProjection = {
      ...this.sessionProjection,
      account: me.accountSettingsView || me.account || me,
      spaces,
      incomingOwnerTransfers,
      pendingOwnerTransfers,
      memberships,
      currentSpaceId,
      capabilities: selected ? {
        view: Boolean(selected.effectiveCanView || selected.isOwner),
        upload: Boolean(selected.effectiveCanUpload || selected.isOwner),
        manage: Boolean(selected.isOwner || selected.managementScopes?.length)
      } : { view: false, upload: false, manage: false }
    };
    return structuredClone(this.sessionProjection);
  }

  #challengeKey(actionId, payload = {}) {
    let targetId = payload.targetId;
    if (!targetId && ["AUTH.LOGOUT_ALL", "ACCOUNT.DELETE_REQUEST"].includes(actionId)) targetId = this.sessionProjection.account?.id || "current";
    if (!targetId && ["SPACE.ARCHIVE", "SPACE.RESTORE", "SPACE.DELETE_REQUEST", "OWNER_TRANSFER.CREATE"].includes(actionId)) targetId = payload.spaceId || this.sessionProjection.currentSpaceId;
    if (!targetId && actionId === "OWNER_TRANSFER.ACCEPT") targetId = payload.transferId;
    if (!targetId && actionId === "BATCH.DELETE_ITEM") targetId = payload.photoId;
    targetId ||= payload.spaceId || payload.photoId || payload.transferId || this.sessionProjection.currentSpaceId || "account";
    return `${actionId || "unknown"}:${targetId}`;
  }

  #projectAction(actionId, result) {
    if (actionId === "INVITATION.EXCHANGE") {
      const spaceId = result.spaceId || result.destinationRoute?.split("/")[2] || "";
      const tasks = result.tasks || [];
      this.sessionProjection = { ...this.sessionProjection, currentSpaceId: spaceId, spaces: this.sessionProjection.spaces.some((space) => space.id === spaceId) ? this.sessionProjection.spaces : [...this.sessionProjection.spaces, { id: spaceId, name: result.spaceName || "共同空间" }], capabilities: { view: tasks.includes("view"), upload: tasks.includes("upload"), manage: false } };
    }
    if (actionId === "AUTH.VERIFY_CODE") {
      if (result.registration?.status === "pending") {
        this.sessionProjection.account = null;
        this.sessionProjection.capabilities = { view: false, upload: false, manage: false };
      } else this.sessionProjection.account = result.account || { authenticated: true };
    }
    if (["AUTH.LOGOUT", "AUTH.LOGOUT_ALL"].includes(actionId)) this.sessionProjection = { ...this.sessionProjection, account: null, capabilities: { view: false, upload: false, manage: false } };
    if (actionId === "SPACE.CREATE" && result.spaceId) this.sessionProjection.currentSpaceId = result.spaceId;
    if (["UPLOAD.SELECT_FILES", "UPLOAD.RETRY_ITEM", "UPLOAD.REMOVE_ITEM"].includes(actionId)) this.cache.activeBatch = result.batchResult || result.batch || result;
    if (actionId === "UPLOAD.FINALIZE_BATCH") this.cache.activeBatch = null;
  }
}
