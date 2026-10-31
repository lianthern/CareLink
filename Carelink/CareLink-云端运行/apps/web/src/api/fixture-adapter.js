import { actionRegistry } from "../generated/contracts.js";
import { ApiError } from "./client.js";

const STORAGE_KEY = "unseen-track2-fixture-v1";
const clone = (value) => structuredClone(value);

// host-panel worktree ("缺口"方向格): JS mirror of SpaceService#missingDirectionBuckets()
// (services/api/src/space-service.mjs) — same 12 x 30° yaw-bucket math, same
// `((yaw % 360) + 360) % 360 / 30` normalization for negative yaw, same guard
// against a null yaw silently "covering" a bucket.
function missingDirectionBuckets(yaws) {
  const covered = new Set(yaws.filter((yaw) => typeof yaw === "number" && Number.isFinite(yaw))
    .map((yaw) => Math.floor((((yaw % 360) + 360) % 360) / 30)));
  return Array.from({ length: 12 }, (_, bucket) => bucket).filter((bucket) => !covered.has(bucket));
}
const now = "2026-08-13T10:00:00+10:00";
const mediaNoticeHash = "fe33ba9d5e927dffa281706d6e826d4dd06b26d3ccfca19b3eaba97f340287b0";
const mediaNoticePolicy = Object.freeze({ acceptedFormats: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"], maxBytes: 20 * 1024 * 1024, metadataPolicy: "strip-sensitive-retain-trusted-capture-time", retainedMetadata: ["timezone-qualified-original-capture-time"], retainedPurposes: ["photo_time", "memory_provenance", "book_provenance"], discardedMetadata: ["gps", "device_serial"], releaseBlockers: ["legal_approval_capture_time_retention"] });

export const fixturePhotoAssets = [
  "/assets/photos/photo-1.jpg",
  "/assets/photos/photo-2.jpg",
  "/assets/photos/photo-3.jpg",
  "/assets/photos/photo-4.jpg",
  "/assets/photos/photo-5.jpg",
  "/assets/photos/photo-6.jpg"
];

export function createFixtureState() {
  return {
    mode: "fixture",
    offline: false,
    nextError: null,
    account: null,
    capabilities: { view: false, upload: false, manage: false },
    externalSession: null,
    mediaConsent: null,
    currentSpaceId: "space-gongguang",
    spaces: [{
      id: "space-gongguang",
      name: "向晚婚礼",
      dateLabel: "2026 年 7 月 25 日",
      ownerAccountId: "account-max",
      spaceLifecycle: "active",
      collectionState: "open",
      sharingState: "shared",
      scene: { readiness: "ready", mode: "rotation360", artifactReady: true, version: 2, panoramaRevisionId: "pano-revision-2" },
      version: 7,
      photoCount: 6,
      pendingReviewCount: 1,
      pendingPlacementCount: 1,
      autoApproveUploads: false,
      publicListing: null,
      wishes: []
    }],
    photos: [
      { id: "photo-1", spaceId: "space-gongguang", title: "烛光亮起时", asset: fixturePhotoAssets[0], contentState: "visible", placementState: "confirmed", confirmationMode: "auto", yaw: -58, uploader: "林野", uploaderCanEdit: true, version: 3, history: [] },
      { id: "photo-2", spaceId: "space-gongguang", title: "窗边的朋友", asset: fixturePhotoAssets[1], contentState: "visible", placementState: "confirmed", confirmationMode: "manual", yaw: -18, uploader: "林野", uploaderCanEdit: true, version: 4, history: [] },
      { id: "photo-3", spaceId: "space-gongguang", title: "大家都在笑", asset: fixturePhotoAssets[2], contentState: "visible", placementState: "confirmed", confirmationMode: "auto", yaw: 24, uploader: "沈舟", uploaderCanEdit: true, version: 2, history: [] },
      { id: "photo-4", spaceId: "space-gongguang", title: "回头的一刻", asset: fixturePhotoAssets[3], contentState: "pending", placementState: "needs_confirmation", confirmationMode: null, yaw: 62, uploader: "夏宁", uploaderCanEdit: true, version: 2, history: [] },
      { id: "photo-5", spaceId: "space-gongguang", title: "厅里的灯光", asset: fixturePhotoAssets[4], contentState: "visible", placementState: "confirmed", confirmationMode: "manual", yaw: 92, uploader: "夏宁", uploaderCanEdit: true, version: 2, history: [] },
      { id: "photo-6", spaceId: "space-gongguang", title: "不在本次现场", asset: fixturePhotoAssets[5], contentState: "visible", placementState: "outside_scene", confirmationMode: null, yaw: null, uploader: "陆遥", uploaderCanEdit: true, version: 2, history: [] }
    ],
    batches: [],
    campaigns: [{
      id: "campaign-gongguang",
      publicCampaignId: "gongguang-2026",
      publicCampaignUrl: "/open/gongguang-2026",
      qrPayload: "/open/gongguang-2026",
      taskMode: "combo",
      entryTask: "view",
      campaignStatus: "active",
      expiresAt: "2026-09-13T10:00:00+10:00",
      successfulUseCount: 8,
      maxSuccessfulUses: 120,
      version: 2
    }],
    memberships: [{ id: "member-1", name: "周宁", emailMask: "z***@example.com", tasks: ["view"], managementScopes: ["canReview"], status: "active", version: 1 }],
    memberInvitations: [],
    pendingOwnerTransfers: [],
    incomingOwnerTransfers: [{ id: "transfer-incoming", spaceName: "海边晚餐", status: "pending", version: 1 }],
    cases: [],
    reports: [],
    appeals: [],
    exports: [],
    deletions: [],
    panoramaCandidates: [],
    audit: [{ at: now, label: "验收数据已重置" }]
  };
}

export class FixtureApiAdapter {
  constructor({ storage = globalThis.sessionStorage } = {}) {
    this.kind = "fixture";
    this.storage = storage;
    this.state = this.#load();
  }

  #load() {
    try {
      const saved = this.storage?.getItem(STORAGE_KEY);
      return saved ? { ...createFixtureState(), ...JSON.parse(saved) } : createFixtureState();
    } catch {
      return createFixtureState();
    }
  }

  #save() {
    this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.state));
  }

  #space() {
    return this.state.spaces.find((space) => space.id === this.state.currentSpaceId);
  }

  #assertAvailable() {
    if (this.state.offline) throw new ApiError("network_unavailable", "当前网络不可用，请检查连接后重试。", 503);
    if (this.state.nextError) {
      const code = this.state.nextError;
      this.state.nextError = null;
      this.#save();
      throw new ApiError(code, code === "session_unavailable" ? "当前访问已失效。" : "这项操作暂时无法完成。", code === "session_unavailable" ? 401 : 409);
    }
  }

  async read(resource, params = {}) {
    this.#assertAvailable();
    await Promise.resolve();
    switch (resource) {
      case "state": return clone(this.state);
      case "ownerTransfers": return clone({ incoming: this.state.incomingOwnerTransfers || [], pending: this.state.pendingOwnerTransfers || [], eligibleMemberships: this.state.memberships || [] });
      case "homeConfig": return { primaryAction: "HOME.OPEN_SPACE", loginAction: "AUTH.OPEN_LOGIN" };
      case "viewerSpace": return this.#viewerSpace();
      case "campaignPreview": return this.#previewCampaign(params.token);
      case "viewerPhotoDetail": return clone(this.state.photos.find((photo) => photo.id === params.photoId));
      case "viewerSceneContext": return this.#sceneContext(params.photoId);
      case "uploadContext": return { spaceId: params.spaceId, effectiveCanUpload: this.state.capabilities.upload, limits: { batchItems: 50, photoBytes: 20 * 1024 * 1024 }, formats: [...mediaNoticePolicy.acceptedFormats], mediaNotice: { id: "media_photo_upload_v2", version: 2, hash: mediaNoticeHash, policy: clone(mediaNoticePolicy) }, currentConsent: clone(this.state.mediaConsent), canCreateBatch: Boolean(this.state.mediaConsent), wishes: clone(this.#space()?.wishes || []) };
      case "activeBatch": return clone(this.state.batches.find((batch) => batch.status === "open") || null);
      case "batchResult": return clone(this.state.batches.find((batch) => batch.id === params.batchId));
      case "batchReceipt": return clone(this.state.batches.find((batch) => batch.status === "finalized" && !batch.receiptRevoked));
      case "batchReceiptItem": {
        const batch = this.state.batches.find((entry) => entry.items.some((item) => item.id === params.itemId));
        const item = batch?.items.find((entry) => entry.id === params.itemId);
        return item ? clone({ ...item, batchId: batch.id, receiptId: batch.receiptId }) : null;
      }
      case "batchItemPlacementEdit": {
        const batch = this.state.batches.find((entry) => entry.items.some((item) => item.id === params.itemId));
        const item = batch?.items.find((entry) => entry.id === params.itemId);
        return item ? clone({ ...this.#placementEdit(item.photoId || item.id), sceneContext: this.#sceneContext(item.photoId || item.id) }) : null;
      }
      case "placementEdit": return this.#placementEdit(params.photoId);
      case "managementView": return this.#managementView();
      case "publicListing": return this.#publicListing(params.spaceId);
      case "discoverSpaces": return this.#discoverSpaces();
      case "accountBatchBindings": return clone(this.state.batches.filter((batch) => batch.status === "finalized" && !batch.receiptRevoked));
      case "exportStatus": return clone(this.state.exports.find((entry) => entry.id === params.exportId));
      case "deletionStatus": return clone(this.state.deletions.find((entry) => entry.id === params.deletionId));
      case "reportStatus": return clone(this.state.reports.find((entry) => entry.id === params.caseId));
      case "appealStatus": return clone(this.state.appeals.find((entry) => entry.id === params.caseId));
      case "supportStatus": return clone(this.state.cases.find((entry) => entry.id === params.caseId));
      case "jobStatus": return clone(this.state.jobs?.find((entry) => entry.id === params.jobId) || null);
      default: return clone(this.state);
    }
  }

  #previewCampaign(token) {
    const campaign = this.state.campaigns.find((entry) => entry.publicCampaignId === token);
    if (!campaign || campaign.campaignStatus !== "active") throw new ApiError("campaign_preview_unavailable", "这条活动邀请暂时不可用。", 404);
    return clone({ displayName: this.#space().name });
  }

  #viewerSpace() {
    const space = this.#space();
    return clone({
      ...space,
      photos: this.state.photos.filter((photo) => photo.spaceId === space.id && photo.contentState === "visible"),
      sceneContext: this.#sceneContext(),
      effectiveCanUpload: this.state.capabilities.upload
    });
  }

  #sceneContext(photoId) {
    const placements = this.state.photos.filter((photo) => photo.contentState === "visible" && photo.placementState === "confirmed").map((photo) => ({ photoId: photo.id, yawDeg: photo.yaw, pitchDeg: photo.pitch || 0, placementRevisionId: `placement-${photo.id}-v${photo.version}`, label: photo.title }));
    return clone({
      panoramaUrl: "/assets/panorama/pano.jpg",
      panoramaSha256: "7d1b8cd9c6f5c66d36239362f8288b963a69db0b23bc40cf4630c83bca70dffe",
      panoramaRevisionId: this.#space().scene.panoramaRevisionId,
      expiresAt: "2026-08-13T11:00:00+10:00",
      placements,
      focusPose: placements.find((placement) => placement.photoId === photoId) || null
    });
  }

  #placementEdit(photoId) {
    const photo = this.state.photos.find((entry) => entry.id === photoId);
    if (photo) return clone({ ...photo, photoId: photo.id, suggestionId: `suggestion-${photo.id}`, candidateId: `candidate-${photo.id}`, panoramaRevisionId: this.#space().scene.panoramaRevisionId });
    for (const batch of this.state.batches) {
      const item = batch.items.find((entry) => entry.photoId === photoId || entry.id === photoId);
      if (item) return clone({ ...item, batchId: batch.id, itemId: item.id, receiptId: batch.receiptId, suggestionId: `suggestion-${item.id}`, candidateId: `candidate-${item.id}`, panoramaRevisionId: this.#space().scene.panoramaRevisionId });
    }
    return null;
  }

  #managementView() {
    const isOwner = this.state.account?.id === this.#space().ownerAccountId;
    const spacePhotos = this.state.photos.filter((photo) => photo.spaceId === this.#space().id);
    const confirmedPhotos = spacePhotos.filter((photo) => photo.placementState === "confirmed");
    return clone({
      space: this.#space(),
      isOwner,
      scopes: isOwner ? ["canReview", "canEditPlacement", "canManageScene", "canInvite", "canPublish"] : (this.state.account?.managementScopes || []),
      reviewQueue: spacePhotos.filter((photo) => ["pending", "hidden", "rejected"].includes(photo.contentState)),
      placementQueue: spacePhotos.filter((photo) => ["needs_confirmation", "stale", "failed"].includes(photo.placementState)),
      // host-panel worktree ("待你确认" + "缺口"方向格): mirrors the additive fields
      // SpaceService#management() now returns (services/api/src/space-service.mjs) —
      // see missingDirectionBuckets() above for the shared bucket math.
      confirmedPlacementCount: confirmedPhotos.length,
      missingDirections: missingDirectionBuckets(confirmedPhotos.map((photo) => photo.yaw)),
      campaigns: this.state.campaigns,
      memberships: this.state.memberships,
      memberInvitations: this.state.memberInvitations,
      panoramaCandidates: this.state.panoramaCandidates,
      audit: this.state.audit,
      wishes: this.#space().wishes || []
    });
  }

  #publicListing(spaceId) {
    const space = this.state.spaces.find((entry) => entry.id === spaceId) || this.#space();
    return space?.publicListing || { spaceId: space?.id ?? spaceId ?? "", status: "unlisted", title: "",
      description: "", openUrl: "", requestedAt: null, listedAt: null, hiddenAt: null, version: 0 };
  }

  #discoverSpaces() {
    return { spaces: this.state.spaces.filter((space) => space.publicListing?.status === "listed")
      .map((space) => ({ title: space.publicListing.title || space.name, description: space.publicListing.description || "",
        url: space.publicListing.openUrl || "" })) };
  }

  async act(actionId, payload = {}) {
    this.#assertAvailable();
    if (!actionRegistry.actions.some((action) => action.id === actionId)) throw new ApiError("action_unavailable", `未知动作 ${actionId}`, 404);
    await Promise.resolve();
    const result = this.#act(actionId, payload);
    this.state.audit.unshift({ at: now, label: actionId });
    this.#save();
    return clone({ actionId, ...result });
  }

  // Fixture parity for http-adapter.js's requestOtpVerificationChallenge(): no real captcha
  // gate exists in fixture mode (nothing here ever leaves the browser), so this just reports
  // "disabled" -- otp-pow/client.js's solveVerificationChallenge() treats any non-"pow" mode as
  // "nothing to solve" and resolves immediately with no proof fields.
  async requestOtpVerificationChallenge() {
    this.#assertAvailable();
    await Promise.resolve();
    return { mode: "disabled" };
  }

  async admitCampaign(publicCampaignId) {
    this.#assertAvailable();
    const campaign = this.state.campaigns.find((entry) => entry.publicCampaignId === publicCampaignId);
    if (!campaign || campaign.campaignStatus !== "active") throw new ApiError("campaign_unavailable", "这条活动邀请暂时不可用。", 404);
    if (this.state.externalSession?.campaignId === campaign.id) return { destinationRoute: campaign.entryTask === "upload" ? `/s/${this.#space().id}/upload` : `/s/${this.#space().id}/album` };
    return { bootstrapUrl: "/open#invite=fixture-memory-only-admission" };
  }

  async updateSpaceWishes(spaceId, wishes) {
    this.#assertAvailable();
    await Promise.resolve();
    const space = this.state.spaces.find((entry) => entry.id === spaceId);
    if (!space) throw new ApiError("resource_unavailable", "空间不存在。", 404);
    if (!Array.isArray(wishes) || wishes.length > 6 || wishes.some((wish) => typeof wish !== "string" || !wish.trim() || Array.from(wish.trim()).length > 40)) {
      throw new ApiError("validation_failed", "心愿最多 6 条，每条不超过 40 字。", 400);
    }
    space.wishes = wishes.map((wish) => wish.trim());
    space.version += 1;
    this.state.audit.unshift({ at: now, label: "SPACE.WISHES.UPDATE" });
    this.#save();
    return clone({ spaceId, wishes: space.wishes, version: space.version });
  }

  async updateAutoApproveUploads(spaceId, to) {
    this.#assertAvailable();
    await Promise.resolve();
    const space = this.state.spaces.find((entry) => entry.id === spaceId);
    if (!space) throw new ApiError("resource_unavailable", "空间不存在。", 404);
    if (!["on", "off"].includes(to)) throw new ApiError("validation_failed", "无效的开关状态。", 400);
    space.autoApproveUploads = to === "on";
    space.version += 1;
    this.state.audit.unshift({ at: now, label: "SPACE.AUTO_APPROVE_UPLOADS.UPDATE" });
    this.#save();
    return clone({ spaceId, autoApproveUploads: space.autoApproveUploads, version: space.version });
  }

  selectSpace(spaceId) {
    if (!this.state.spaces.some((space) => space.id === spaceId)) return;
    this.state.currentSpaceId = spaceId;
    this.#save();
  }

  // Idempotent, matching services/api's public-listing-service.mjs: a repeat request while already
  // 'requested' or 'listed' is a no-op; requesting again after 'hidden' re-opens it for review.
  async requestPublicListing(spaceId) {
    this.#assertAvailable();
    await Promise.resolve();
    const space = this.state.spaces.find((entry) => entry.id === spaceId) || this.#space();
    if (!space) throw new ApiError("resource_unavailable", "空间不存在。", 404);
    if (!space.publicListing || space.publicListing.status === "hidden") {
      space.publicListing = { spaceId: space.id, status: "requested", title: space.publicListing?.title || "",
        description: space.publicListing?.description || "", openUrl: space.publicListing?.openUrl || "",
        requestedAt: now, listedAt: space.publicListing?.listedAt || null, hiddenAt: null,
        version: (space.publicListing?.version || 0) + 1 };
    }
    this.#save();
    return clone(space.publicListing);
  }

  // v3.1 "传到我的空间" fixture parity for http-adapter.js's ensurePersonalSpace():
  // lazily finds-or-creates one "我的空间" per fixture account, mirroring the
  // server's is_personal_default marker + open collection state.
  async ensurePersonalSpace() {
    this.#assertAvailable();
    await Promise.resolve();
    let space = this.state.spaces.find((entry) => entry.isPersonalDefault && entry.ownerAccountId === this.state.account?.id);
    if (!space) {
      space = { id: `space-personal-${this.state.spaces.length + 1}`, name: "我的空间", ownerAccountId: this.state.account?.id,
        spaceLifecycle: "active", collectionState: "open", sharingState: "private", isPersonalDefault: true,
        scene: { readiness: "unavailable", mode: "rotation360", artifactReady: false, version: 1 },
        version: 1, photoCount: 0, pendingReviewCount: 0, pendingPlacementCount: 0, autoApproveUploads: true };
      this.state.spaces.push(space);
      if (this.state.account) this.state.account = { ...this.state.account, personalSpaceId: space.id };
      this.#save();
    }
    this.state.currentSpaceId = space.id;
    this.#save();
    return clone({ spaceId: space.id, destinationRoute: `/s/${space.id}/upload` });
  }

  #act(actionId, payload) {
    const space = this.#space();
    switch (actionId) {
      case "INVITATION.EXCHANGE":
        this.state.externalSession = { campaignId: "campaign-gongguang", useOrdinal: 9, entryTask: payload.entryTask || "view" };
        this.state.capabilities = { view: true, upload: true, manage: false };
        return { destinationRoute: payload.entryTask === "upload" ? `/s/${space.id}/upload` : `/s/${space.id}/album` };
      case "AUTH.REQUEST_CODE": return { challengeId: "fixture-login", expiresInSeconds: 600 };
      case "AUTH.VERIFY_CODE":
        if (payload.code !== "246810") throw new ApiError("authentication_failed", "验证码不正确或已过期，请重新获取。", 401);
        this.state.account = { id: "account-max", name: "Max", emailMask: "m***@example.com", role: "owner", tasks: ["view", "upload"], managementScopes: ["canReview", "canEditPlacement", "canManageScene", "canInvite", "canPublish"] };
        this.state.capabilities = { view: true, upload: true, manage: true };
        return { destinationRoute: "/spaces" };
      case "AUTH.LOGOUT":
      case "AUTH.LOGOUT_ALL":
        this.state.account = null;
        this.state.capabilities = this.state.externalSession ? { view: true, upload: true, manage: false } : { view: false, upload: false, manage: false };
        return { destinationRoute: "/" };
      case "SPACE.CREATE": {
        const id = `space-${this.state.spaces.length + 1}`;
        this.state.spaces.push({ id, name: payload.name, ownerAccountId: "account-max", spaceLifecycle: "active", collectionState: "paused", sharingState: "private", scene: { readiness: "unavailable", mode: "rotation360", artifactReady: false, version: 1 }, version: 1, photoCount: 0, pendingReviewCount: 0, pendingPlacementCount: 0, autoApproveUploads: true });
        this.state.currentSpaceId = id;
        return { spaceId: id, destinationRoute: `/manage/${id}?tab=setup` };
      }
      case "UPLOAD.ACCEPT_NOTICE": {
        if (payload.noticeVersion !== 2 || payload.noticeHash !== mediaNoticeHash || payload.mediaPolicyVersion !== "2" || payload.choices?.display !== true || payload.choices?.placement !== true) throw new ApiError("notice_version_stale", "照片处理说明已更新。", 409);
        this.state.mediaConsent = { consentEventId: "consent-fixture-1", acceptedAt: now };
        return { consentEventId: this.state.mediaConsent.consentEventId, purpose: "photo_upload", noticeVersion: 2, acceptedAt: now };
      }
      case "UPLOAD.SELECT_FILES":
        if (payload.consentEventId !== this.state.mediaConsent?.consentEventId) throw new ApiError("consent_required", "请先确认当前照片处理说明。", 409);
        return this.#createBatch(payload.files);
      case "UPLOAD.RETRY_ITEM": return this.#retryItem(payload);
      case "UPLOAD.REMOVE_ITEM": return this.#removeItem(payload);
      case "UPLOAD.FINALIZE_BATCH": return this.#finalizeBatch(payload);
      case "BATCH_BINDING.REQUEST_CODE": return { challengeId: "fixture-binding", expiresInSeconds: 600 };
      case "BATCH_BINDING.CONFIRM": return { bindingId: "binding-fixture", emailMask: payload.email || "m***@example.com" };
      case "BATCH.RECOVER_FROM_ACCOUNT": return { destinationRoute: `/uploads/${payload.batchId}` };
      case "BATCH_RECEIPT.EXCHANGE": {
        const batchId = payload.receiptSecret?.match(/(batch-\d+)$/)?.[1];
        const batch = this.state.batches.find((entry) => entry.id === batchId && entry.receiptActive && !entry.receiptRevoked);
        if (!batch) throw new ApiError("receipt_unavailable", "这份上传回执已经不可用。", 404);
        return { destinationRoute: `/uploads/${batch.id}` };
      }
      case "BATCH_RECEIPT.REVOKE": return this.#updateBatch(payload.batchId, (batch) => { batch.receiptRevoked = true; });
      case "BATCH.DELETE_ITEM": return this.#updateItem(payload, (item) => { item.status = "deleted"; item.asset = null; item.placementState = "unavailable"; });
      case "PLACEMENT.RETRY": return this.#updateItem(payload, (item) => { item.placementState = "needs_confirmation"; });
      case "PLACEMENT.CONFIRM":
      case "PLACEMENT.SAVE": return this.#savePlacement(payload, Boolean(payload.manager));
      case "PLACEMENT.UNDO": return this.#undoPlacement(payload);
      case "PLACEMENT.MARK_OUTSIDE": return this.#markOutside(payload);
      case "PLACEMENT.REOPEN_FOR_CONTRIBUTOR": return this.#reopen(payload);
      case "CONTENT.APPROVE": return this.#content(payload, "visible");
      case "CONTENT.HIDE": return this.#content(payload, "hidden");
      case "CONTENT.REJECT": return this.#content(payload, "rejected");
      case "CONTENT.RESTORE": return this.#content(payload, "visible");
      case "CONTENT.REOPEN": return this.#content(payload, "pending");
      case "PANORAMA.UPLOAD_CANDIDATE": {
        const candidate = { id: `candidate-${this.state.panoramaCandidates.length + 1}`, status: "ready", fileName: payload.fileName || "新的现场.jpg", version: 2 };
        this.state.panoramaCandidates.push(candidate);
        return candidate;
      }
      case "PANORAMA.SWITCH_CANDIDATE":
        if (!this.state.panoramaCandidates.some((candidate) => candidate.status === "ready")) throw new ApiError("panorama_not_ready", "没有已准备好的新现场。", 409);
        space.scene = { ...space.scene, readiness: "ready", mode: "rotation360", artifactReady: true, version: space.scene.version + 1 };
        this.state.photos.filter((photo) => photo.placementState === "confirmed").forEach((photo) => { photo.placementState = "stale"; photo.version += 1; });
        return { scene: space.scene };
      case "PANORAMA.ROLLBACK": return { scene: space.scene, restored: true };
      case "EXTERNAL_INVITATION.CREATE": {
        const campaign = { id: `campaign-${this.state.campaigns.length + 1}`, publicCampaignId: `shared-${this.state.campaigns.length + 1}`, publicCampaignUrl: `/open/shared-${this.state.campaigns.length + 1}`, qrPayload: `/open/shared-${this.state.campaigns.length + 1}`, taskMode: payload.taskMode || "view", entryTask: payload.entryTask || "view", campaignStatus: "active", expiresAt: payload.expiresAt || "2026-09-13T10:00:00+10:00", successfulUseCount: 0, maxSuccessfulUses: Number(payload.maxSuccessfulUses || 100), version: 1 };
        this.state.campaigns.push(campaign);
        return campaign;
      }
      case "EXTERNAL_INVITATION.REVOKE": return this.#campaign(payload, "revoked");
      case "MEMBER_INVITATION.CREATE": {
        const invitation = { id: `member-invite-${this.state.memberInvitations.length + 1}`, emailMask: payload.email?.replace(/(^.).*(@.*$)/, "$1***$2") || "m***@example.com", tasks: payload.tasks || [], managementScopes: payload.managementScopes || [], status: "pending" };
        this.state.memberInvitations.push(invitation);
        return { invitationId: invitation.id, inviteUrl: "/member-invitations/accept#invite=fixture-memory-only" };
      }
      case "MEMBER_INVITATION.ACCEPT": return { destinationRoute: "/spaces" };
      case "MEMBER_INVITATION.REVOKE": {
        const invitation = this.state.memberInvitations.find((entry) => entry.id === payload.invitationId);
        if (!invitation) throw new ApiError("member_invitation_unavailable", "这条成员邀请已经不可用。", 404);
        invitation.status = "revoked";
        return { revoked: true, invitation };
      }
      case "MEMBERSHIP.UPDATE": return this.#membership(payload, false);
      case "MEMBERSHIP.REVOKE": return this.#membership(payload, true);
      case "COLLECTION.PAUSE": space.collectionState = "paused"; space.version += 1; return { space };
      case "COLLECTION.RESUME": space.collectionState = "open"; space.version += 1; return { space };
      case "SHARING.ENABLE": space.sharingState = "shared"; space.version += 1; return { space };
      case "SHARING.DISABLE": space.sharingState = "private"; space.version += 1; return { space };
      case "SPACE.ARCHIVE": space.spaceLifecycle = "archived"; space.version += 1; return { space };
      case "SPACE.RESTORE": space.spaceLifecycle = "active"; space.version += 1; return { space };
      case "OWNER_TRANSFER.CREATE": {
        const transfer = { id: "transfer-fixture", spaceId: space.id, targetMembershipId: payload.targetMembershipId, status: "pending" };
        this.state.pendingOwnerTransfers.push(transfer);
        return transfer;
      }
      case "OWNER_TRANSFER.ACCEPT": {
        const transfer = this.state.incomingOwnerTransfers.find((entry) => entry.id === payload.transferId);
        if (!transfer || transfer.status !== "pending") throw new ApiError("owner_transfer_unavailable", "这次主人转移已经不可用。", 404);
        transfer.status = "accepted";
        transfer.version += 1;
        return { accepted: true, transfer };
      }
      case "OWNER_TRANSFER.REVOKE": this.state.pendingOwnerTransfers = []; return { revoked: true };
      case "SPACE.EXPORT":
      case "ACCOUNT.EXPORT": {
        const job = { id: `export-${this.state.exports.length + 1}`, status: "ready", scope: actionId.startsWith("SPACE") ? "space" : "account" };
        this.state.exports.push(job);
        return job;
      }
      case "SPACE.DELETE_REQUEST":
      case "ACCOUNT.DELETE_REQUEST": {
        const deletion = { id: `deletion-${this.state.deletions.length + 1}`, status: "requested" };
        this.state.deletions.push(deletion);
        return deletion;
      }
      case "REPORT.SUBMIT": {
        const entry = { id: `report-${this.state.reports.length + 1}`, type: "report", status: "open", category: payload.category || "other" };
        this.state.reports.push(entry);
        return entry;
      }
      case "APPEAL.SUBMIT": {
        const entry = { id: `appeal-${this.state.appeals.length + 1}`, type: "appeal", status: "open", category: payload.category || "review_result" };
        this.state.appeals.push(entry);
        return entry;
      }
      case "SUPPORT.SUBMIT_SAFETY_LEAD": {
        const entry = { id: `case-${this.state.cases.length + 1}`, type: "support", status: "open", category: payload.category || "other" };
        this.state.cases.push(entry);
        return entry;
      }
      case "NOTE.OPT_IN": return { status: "processing", releaseLane: "L2" };
      case "NOTE.CONFIRM": return { status: "confirmed", visibility: "contributor_only", releaseLane: "L2" };
      case "NOTE.WITHDRAW": return { status: "withdrawn", releaseLane: "L2" };
      case "MANAGE.OPEN_NEXT": {
        const target = this.#managementView().reviewQueue[0] || this.#managementView().placementQueue[0] || null;
        return target ? { outcome: "target", target } : { outcome: "empty" };
      }
      default: return { ok: true };
    }
  }

  #createBatch(files = []) {
    const batchId = `batch-${this.state.batches.length + 1}`;
    const source = files.length ? files : ["仪式.jpg", "窗边.jpg", "过大的照片.png"];
    const items = source.map((file, index) => ({
      id: `${batchId}-item-${index + 1}`,
      fileName: typeof file === "string" ? file : file.name,
      status: index === 2 ? "failed" : "committed",
      failureCode: index === 2 ? "file_too_large" : null,
      asset: fixturePhotoAssets[(index + 3) % fixturePhotoAssets.length],
      photoId: index === 2 ? null : `uploaded-photo-${index + 1}`,
      contentState: index === 0 ? "pending" : "visible",
      placementState: index === 0 ? "needs_confirmation" : (index === 1 ? "confirmed" : "unavailable"),
      confirmationMode: index === 1 ? "auto" : null,
      yaw: index === 1 ? 34 : null,
      uploaderCanEdit: true,
      placementAuthorizationVersion: 1,
      version: 1,
      history: []
    }));
    // space-gongguang (this fixture's demo space) already has an active scene/panorama, so
    // spaceHasScene defaults true here — matches http-adapter's upload-service.mjs#batchView(),
    // which derives it from spaces.current_panorama_revision_id (see that method's own comment).
    const batch = { id: batchId, status: "open", items, version: 1, createdAt: now, accessExpiresAt: "2026-09-13T10:00:00+10:00", recoveryUntil: "2026-10-13T10:00:00+10:00", spaceHasScene: true };
    this.state.batches.unshift(batch);
    return batch;
  }

  #retryItem({ batchId, itemId }) {
    return this.#updateItem({ batchId, itemId }, (item) => { item.status = "committed"; item.failureCode = null; item.photoId = item.photoId || `uploaded-${item.id}`; item.placementState = "needs_confirmation"; item.version += 1; });
  }

  #removeItem({ batchId, itemId }) {
    return this.#updateItem({ batchId, itemId }, (item, batch) => {
      if (batch.status !== "open" || item.status !== "failed") throw new ApiError("item_state_conflict", "只有尚未完成的失败照片可以移出本次上传。", 409);
      item.status = "removed";
      item.version += 1;
    });
  }

  #finalizeBatch({ batchId }) {
    return this.#updateBatch(batchId, (batch) => {
      if (batch.status === "finalized") return;
      if (!batch.items.some((item) => ["committed", "failed", "removed"].includes(item.status))) throw new ApiError("no_terminal_items", "本次上传还没有可完成的照片。", 409);
      batch.status = "finalized";
      batch.version += 1;
      batch.receiptActive = true;
      batch.receiptId = `receipt-${batch.id}`;
      batch.receiptUrl = `/uploads/open#receipt=fixture-memory-only-${batch.id}`;
    });
  }

  #updateBatch(batchId, update) {
    const batch = this.state.batches.find((entry) => entry.id === batchId);
    if (!batch) throw new ApiError("batch_unavailable", "本次上传无法打开。", 404);
    update(batch);
    return batch;
  }

  #updateItem({ batchId, itemId, photoId }, update) {
    const batch = this.state.batches.find((entry) => entry.id === batchId);
    const item = batch?.items.find((entry) => entry.id === itemId || entry.photoId === photoId);
    if (!item) throw new ApiError("batch_item_unavailable", "这张照片的结果无法打开。", 404);
    update(item, batch);
    return { batch, item };
  }

  #savePlacement(payload, manager) {
    if (payload.batchId) return this.#updateItem(payload, (item) => {
      if (!item.uploaderCanEdit && !manager) throw new ApiError("placement_write_locked", "空间主人已调整这张照片的位置。", 423);
      item.history.push({ yaw: item.yaw, placementState: item.placementState, confirmationMode: item.confirmationMode });
      item.yaw = Number(payload.yawDeg ?? payload.yaw ?? 0);
      item.placementState = "confirmed";
      item.confirmationMode = "manual";
      item.version += 1;
      if (manager) { item.uploaderCanEdit = false; item.placementAuthorizationVersion += 1; }
    });
    const photo = this.state.photos.find((entry) => entry.id === payload.photoId);
    if (!photo) throw new ApiError("placement_action_unavailable", "当前没有可编辑的位置。", 404);
    photo.history ||= [];
    photo.history.push({ yaw: photo.yaw, placementState: photo.placementState, confirmationMode: photo.confirmationMode });
    photo.yaw = Number(payload.yawDeg ?? payload.yaw ?? 0); photo.placementState = "confirmed"; photo.confirmationMode = "manual"; photo.version += 1;
    if (manager) photo.uploaderCanEdit = false;
    return { photo };
  }

  #undoPlacement(payload) {
    if (payload.batchId) return this.#updateItem(payload, (item) => {
      const previous = item.history.pop();
      if (!previous) throw new ApiError("placement_action_unavailable", "没有可撤回的位置修改。", 409);
      Object.assign(item, previous); item.version += 1;
    });
    const photo = this.state.photos.find((entry) => entry.id === payload.photoId);
    const previous = photo?.history?.pop();
    if (!previous) throw new ApiError("placement_action_unavailable", "没有可撤回的位置修改。", 409);
    Object.assign(photo, previous); photo.version += 1;
    return { photo };
  }

  #markOutside(payload) {
    if (payload.batchId) return this.#updateItem(payload, (item) => { item.history.push({ yaw: item.yaw, placementState: item.placementState, confirmationMode: item.confirmationMode }); item.yaw = null; item.placementState = "outside_scene"; item.confirmationMode = null; item.version += 1; });
    const photo = this.state.photos.find((entry) => entry.id === payload.photoId); photo.history ||= []; photo.history.push({ yaw: photo.yaw, placementState: photo.placementState, confirmationMode: photo.confirmationMode }); photo.yaw = null; photo.placementState = "outside_scene"; photo.confirmationMode = null; photo.version += 1; return { photo };
  }

  #reopen(payload) {
    if (payload.batchId) return this.#updateItem(payload, (item) => { item.uploaderCanEdit = true; item.placementAuthorizationVersion += 1; item.version += 1; });
    const photo = this.state.photos.find((entry) => entry.id === payload.photoId);
    if (!photo) throw new ApiError("placement_action_unavailable", "当前没有可重新开放的位置。", 404);
    photo.uploaderCanEdit = true;
    photo.version += 1;
    return { photo };
  }

  #content({ photoId, decisionReasonCode, note }, contentState) {
    const photo = this.state.photos.find((entry) => entry.id === photoId);
    if (!photo) throw new ApiError("transition_not_allowed", "这张照片现在不能这样处理。", 409);
    if (decisionReasonCode === "other" && !note?.trim()) throw new ApiError("decision_note_required", "选择“其他”时，请填写说明。", 400);
    photo.contentState = contentState;
    photo.version += 1;
    return { photo };
  }

  #campaign({ campaignId }, status) {
    const campaign = this.state.campaigns.find((entry) => entry.id === campaignId);
    campaign.campaignStatus = status; campaign.version += 1; return { campaign };
  }

  #membership(payload, revoke) {
    const member = this.state.memberships.find((entry) => entry.id === payload.membershipId);
    if (!member) throw new ApiError("membership_unavailable", "这个成员已不可用。", 404);
    if (revoke) member.status = "revoked";
    else { member.tasks = payload.tasks || member.tasks; member.managementScopes = payload.managementScopes || member.managementScopes; }
    member.version += 1;
    return { member };
  }

  setScenario({ offline, nextError } = {}) {
    if (typeof offline === "boolean") this.state.offline = offline;
    if (nextError !== undefined) this.state.nextError = nextError;
    this.#save();
  }

  reset() {
    this.state = createFixtureState();
    this.#save();
    return clone(this.state);
  }
}
