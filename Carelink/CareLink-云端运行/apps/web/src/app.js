import { UnseenApiClient, ApiError } from "./api/client.js";
import { FixtureApiAdapter } from "./api/fixture-adapter.js";
import { HttpApiAdapter } from "./api/http-adapter.js";
import { solveVerificationChallenge } from "./otp-captcha/client.js";
import { PanoramaUploadWorkflowClient, pollPanoramaCandidate, UploadWorkflowClient } from "./api/upload-workflow.js";
import { canonicalViewerScene, fetchVerifiedViewerMedia, FixtureViewerAdapter, ProductionViewerAdapter, rotationOnlyViewerContext } from "./adapters/viewer/index.js";
import { actionRegistry, strings } from "./generated/contracts.js";
import { renderQr } from "./vendor/qrcode-renderer.js";
import { exactManagementSpaceIfMatch, requireAction } from "./action-runtime.js";
import { createWebExtensionHost, loadWebExtensionHost } from "./extensions/index.js";
import { hasTemporaryAccess } from "./temporary-access.js";
import { needsAccountHydration } from "./account-hydration.js";
import {
  actionCopy,
  accountPage,
  accountUploadsPage,
  albumPage,
  batchItemPage,
  batchResultPage,
  bookPreviewPage,
  createSpacePage,
  dialogTemplate,
  discoverPage,
  esc,
  genericStatusPage,
  homePage,
  isUploadFlowSkeletonAction,
  legalPage,
  loginPage,
  managePage,
  mediaNoticePage,
  requireCurrentMediaNotice,
  notFoundPage,
  openCampaignPage,
  openSpacePage,
  photoPage,
  placementEditorPage,
  scenePage,
  sceneHudText,
  sceneManagementContent,
  sceneStaticFallback,
  shell,
  spacesPage,
  startUploadPage,
  statePanel,
  supportPage,
  uploadFlowSkeleton,
  uploadPage,
  wishList,
  wishWallCopy,
  zinePage
} from "./ui/templates.js";

const app = document.querySelector("#app");
const announcer = document.querySelector("#announcer");
let temporaryAccess = false;
void hasTemporaryAccess().then((enabled) => { temporaryAccess = enabled; mountTemporaryAccessBanner(); });
const startupQuery = new URLSearchParams(location.search);
const uiProductizationFixture = globalThis.__UNSEEN_CONFIG__?.uiProductizationFixture === true;
const fixtureMode = uiProductizationFixture || startupQuery.get("fixture") === "1" || globalThis.__UNSEEN_TEST_BOOTSTRAP__?.adapter === "fixture";
const debugMode = fixtureMode && startupQuery.get("debug") === "1";
// local-operable.mjs already injects its own server-rendered disclosure banner into the
// static HTML (see infra/integration/local-operable.mjs `fixtureBanner`), so the client
// template must not render a second one when localOperable is set — otherwise the page
// stacks two banners disclosing the same "not a real locator" fact.
const localOperable = globalThis.__UNSEEN_CONFIG__?.localOperable === true;
const localDeterministicLocator = !fixtureMode && !localOperable && globalThis.__UNSEEN_CONFIG__?.localDeterministicLocator === true;
const adapter = fixtureMode ? new FixtureApiAdapter() : new HttpApiAdapter({ baseUrl: globalThis.__UNSEEN_CONFIG__?.apiBaseUrl || "" });
const api = new UnseenApiClient(adapter);
const featureFlags = Object.freeze({ bookLab: globalThis.__UNSEEN_CONFIG__?.featureFlags?.bookLab === true });
const extensions = createWebExtensionHost({ apiClient: api, featureFlags });
// Never let a broken/missing optional extension (e.g. book-lab.js 404ing, or throwing inside its own
// register function) take down the rest of this module's top-level await chain — that previously meant the
// whole SPA went white (no routing, no render(), no event listeners) with nothing in the console to explain
// why. See extensions/index.js's loadWebExtensionHost for the degrade-not-crash contract.
await loadWebExtensionHost(extensions);
const uploadWorkflow = fixtureMode ? null : new UploadWorkflowClient({ apiAdapter: adapter });
const panoramaWorkflow = fixtureMode ? null : new PanoramaUploadWorkflowClient({ apiAdapter: adapter });
let noticeAccepted = false;
let consentEventId = "";
let loginChallengeSent = false;
let loginEmail = "";

// Fetches a fresh human-verification challenge, shows the local image puzzle, solves its PoW off the
// main thread, and only then submits AUTH.REQUEST_CODE. Shared by
// both /login call sites (initial submit and "重新发送验证码") so the same button-state contract
// applies to each: disabled + "正在验证…" immediately, an extra "（请稍候）" once solving has run
// past 1.5s (most real solves finish well under that -- see the PoW-parameter calibration in the
// task's own delivery report), and the original label restored once the network round trip
// settles either way. Only the *disabled* state is left for the caller's own catch block to
// clear -- a successful resend intentionally stays disabled, matching this button's pre-existing
// behavior; a successful *first* request gets replaced by the follow-up render() anyway.
async function requestLoginCode(payload, button) {
  const originalLabel = button?.textContent ?? "";
  if (button) { button.disabled = true; button.textContent = "正在验证…"; }
  try {
    const challenge = await api.requestOtpVerificationChallenge();
    const proof = await solveVerificationChallenge(challenge, {
      onProgress: ({ elapsedMs }) => { if (button && elapsedMs >= 1500) button.textContent = "正在验证…（请稍候）"; }
    });
    return await api.act("AUTH.REQUEST_CODE", { ...payload, ...proof });
  } catch (error) {
    if (button) button.disabled = false;
    throw error;
  } finally {
    if (button) button.textContent = originalLabel;
  }
}
let state = await safeReadState(false);
let lastFocus = null;
let currentViewer = null;
let zineApp = null;
let viewerStatusObserver = null;
let activeCameraStream = null;
let routeModel = {};
let currentUploadBatch = null;
let activePanoramaOperation = null;
// B11: last-seen scroll offset for a given space's album, captured whenever
// navigate() leaves that route (see navigate() below). Consumed by the photo
// detail page's "返回相册" link (data-restore-album-scroll) so returning to
// the album restores where you were instead of landing back at the top —
// independent of real browser back/forward, which already restores scroll
// from history.state via the popstate handler further down this file.
let albumScrollMemory = { spaceId: "", scrollY: 0 };
const verifiedPhotoUrls = new Map();
const verifiedVideoUrls = new Map();
const reauthActions = new Set(["AUTH.LOGOUT_ALL", "BATCH.DELETE_ITEM", "SPACE.ARCHIVE", "SPACE.RESTORE", "SPACE.DELETE_REQUEST", "ACCOUNT.DELETE_REQUEST", "OWNER_TRANSFER.CREATE", "OWNER_TRANSFER.ACCEPT"]);

history.scrollRestoration = "manual";

globalThis.__UNSEEN_TEST__ = fixtureMode ? {
  state: () => structuredClone(adapter.state),
  offline(value) { adapter.setScenario({ offline: value }); },
  failNext(code) { adapter.setScenario({ nextError: code }); },
  reset() { adapter.reset(); return navigate(location.pathname + location.search, { replace: true }); }
} : undefined;

function demoState() {
  return adapter.state || { mode: fixtureMode ? "fixture" : "production", account: null, capabilities: { view: false, upload: false, manage: false }, currentSpaceId: "", spaces: [], memberships: [], pendingOwnerTransfers: [], incomingOwnerTransfers: [], localDeterministicLocator, uiProductizationFixture };
}

// hydrationMode is one of needsAccountHydration()'s three outcomes: "required" (throw
// on failure — the route is unusable without an account, e.g. /manage/:id),
// "optional" (hydrate when possible but never fail the render — a route like
// /start-upload that must stay usable for an anonymous visitor even when GET /v1/me
// 401s), or false (no hydration attempted at all). Only "required" rethrows; both
// "optional" and false fall back to the anonymous projection silently, so an optional
// route's 401 never reaches render()'s catch and never shows the error panel.
async function safeReadState(hydrationMode = false) {
  const hydrateAccount = hydrationMode === "required" || hydrationMode === "optional";
  try { return { ...await api.read("state", { hydrateAccount }), debug: debugMode, loginEmail, localDeterministicLocator, uiProductizationFixture }; }
  catch (error) {
    if (hydrationMode === "required") throw error;
    return { ...demoState(), debug: debugMode, loginEmail, uiProductizationFixture };
  }
}

function parseLocation() {
  return { path: location.pathname.replace(/\/$/, "") || "/", query: new URLSearchParams(location.search) };
}

async function render({ preserveFocus = false } = {}) {
  currentViewer?.destroy();
  currentViewer = null;
  zineApp?.destroy();
  zineApp = null;
  viewerStatusObserver?.disconnect();
  viewerStatusObserver = null;
  const { path, query } = parseLocation();
  routeModel = {};
  let html;
  try {
    const loadingActionId = actionForPath(path);
    app.innerHTML = shell(`<div class="page">${isUploadFlowSkeletonAction(loadingActionId) ? uploadFlowSkeleton(loadingActionId) : statePanel(loadingActionId, "loading", { onRetry: false })}</div>`, { state, path, bottom: false, title: "正在打开 · UNSEEN" });
    state = await safeReadState(needsAccountHydration(path));
    state.loginEmail = loginEmail;
    html = await route(path, query);
  } catch (error) {
    if (error instanceof ApiError && [401, 403].includes(error.status)) state = { ...demoState(), debug: debugMode, loginEmail };
    const phase = error instanceof ApiError && error.status === 404 ? "empty" : error instanceof ApiError && [401, 403].includes(error.status) ? "session_or_permission_loss" : "stable_error";
    html = shell(`<div class="page">${statePanel(error.actionId || actionForPath(path), phase, { onRetry: phase !== "empty" })}</div>`, { state, path, bottom: false, title: "暂时无法打开 · UNSEEN" });
  }
  app.innerHTML = html;
  // Block 4 (B15): the scene page's bottom glass operate-bar overlays the
  // full viewport height, which collides with the sitewide toast-region's
  // fixed bottom-right slot — this class lets styles.css lift toasts clear
  // of the bar instead of letting them sit on top of it.
  document.body.classList.toggle("scene-immersive-active", Boolean(app.querySelector(".scene-immersive")));
  mountTemporaryAccessBanner();
  if (!preserveFocus && !query.get("focus")) document.querySelector("#main")?.focus({ preventScroll: true });
  await bindPostRender(path, query);
}

function mountTemporaryAccessBanner() {
  if (!temporaryAccess || app.querySelector(".temporary-access-banner")) return;
  const template = document.querySelector("#temporary-access-template");
  const header = app.querySelector(".site-header");
  if (template?.content && header) header.after(template.content.cloneNode(true));
}

function actionForPath(path) {
  if (path === "/notices/media") return "MEDIA_NOTICE.OPEN";
  if (path.includes("/photos/")) return "PHOTO.OPEN_DETAIL";
  if (path.endsWith("/scene")) return "VIEW.OPEN_SCENE";
  if (path.endsWith("/album")) return "VIEW.OPEN_ALBUM";
  if (path.endsWith("/upload")) return "UPLOAD.OPEN";
  if (path.startsWith("/uploads/") && path.includes("/items/")) return "BATCH.OPEN_ITEM";
  if (path.startsWith("/uploads/")) return "BATCH.OPEN_RESULT";
  if (path.startsWith("/placements/")) return "PLACEMENT.OPEN_EDITOR";
  if (path.startsWith("/manage/")) return "MANAGE.OPEN";
  if (path.startsWith("/account/uploads")) return "BATCH.OPEN_ACCOUNT_UPLOADS";
  if (path.startsWith("/account")) return "ACCOUNT.OPEN";
  return "SPACE.OPEN";
}

async function route(path, query) {
  const scopedSpace = path.match(/^\/(?:s|manage)\/([^/]+)/)?.[1];
  if (scopedSpace) { state.currentSpaceId = scopedSpace; api.selectSpace(scopedSpace); }
  if (path === "/") return homePage(state);
  if (path === "/discover") {
    const discovered = await api.read("discoverSpaces").catch(() => null);
    return discoverPage(state, discovered?.spaces);
  }
  if (path === "/book-preview") return bookPreviewPage(state, featureFlags);
  if (path === "/zine") return zinePage(state);
  if (path === "/start-upload") return startUploadPage(state);
  if (path.startsWith("/open/")) {
    const token = path.split("/")[2];
    // Best-effort only: an unknown token, a rate limit, or being offline must never turn this
    // into an error page — openCampaignPage() falls back to neutral copy when displayName is "".
    const preview = await api.read("campaignPreview", { token }).catch(() => null);
    return openCampaignPage(state, token, preview?.displayName || "");
  }
  if (path === "/open") return globalThis.__UNSEEN_BOOTSTRAP__ ? bootstrapStatus("INVITATION.EXCHANGE") : openSpacePage(state);
  if (path === "/login") return loginPage(state, loginChallengeSent);
  if (path === "/spaces") return spacesPage(state, query.get("filter") === "archived");
  if (path === "/spaces/new") return guard("account", () => createSpacePage(state));
  if (path === "/account") return guard("account", async () => {
    routeModel.ownerTransfers = await api.read("ownerTransfers");
    projectOwnerTransfers(routeModel.ownerTransfers);
    return accountPage(state);
  });
  if (path === "/account/uploads") return guard("account", async () => {
    routeModel.accountUploads = await api.read("accountBatchBindings");
    return accountUploadsPage(state, routeModel.accountUploads);
  });
  if (path === "/support") return supportPage(state);
  if (path === "/notices/media") {
    const spaceIds = query.getAll("spaceId");
    if (spaceIds.length !== 1 || !spaceIds[0]) throw new ApiError("media_notice_unavailable", "照片处理说明暂时无法加载。", 503);
    const spaceId = spaceIds[0];
    state.currentSpaceId = spaceId;
    api.selectSpace(spaceId);
    routeModel.uploadContext = await api.read("uploadContext", { spaceId });
    routeModel.mediaNotice = await requireCurrentMediaNotice(routeModel.uploadContext, spaceId);
    return mediaNoticePage(state, spaceId);
  }
  if (path === "/privacy" || path === "/terms") return legalPage(state, path.slice(1));
  if (path.startsWith("/s/") && path.split("/").length === 3) return projectSpace(path.split("/")[2]);
  if (/^\/s\/[^/]+\/album$/.test(path)) {
    routeModel.viewer = await api.read("viewerSpace", { spaceId: path.split("/")[2] });
    await verifyViewerAssets(routeModel.viewer, path.split("/")[2]);
    projectViewer(routeModel.viewer);
    return albumPage(state, routeModel.viewer, featureFlags);
  }
  if (/^\/s\/[^/]+\/scene$/.test(path)) {
    const spaceId = path.split("/")[2];
    routeModel.viewer = await api.read("viewerSpace", { spaceId });
    projectViewer(routeModel.viewer);
    const photoId = query.get("photo") || routeModel.viewer.photos?.find((photo) => photo.placementState === "confirmed")?.id;
    routeModel.sceneContext = photoId ? await api.read("viewerSceneContext", { spaceId, photoId }) : routeModel.viewer.sceneContext || null;
    return scenePage(state, routeModel.viewer, routeModel.sceneContext);
  }
  if (/^\/s\/[^/]+\/upload$/.test(path)) {
    const spaceId = path.split("/")[2];
    routeModel.uploadContext = await api.read("uploadContext", { spaceId });
    routeModel.mediaNotice = await requireCurrentMediaNotice(routeModel.uploadContext, spaceId);
    state.capabilities.upload = Boolean(routeModel.uploadContext.effectiveCanUpload ?? true);
    state.uploadContext = routeModel.uploadContext;
    if (!state.capabilities.upload) return guard("upload", () => "");
    if (routeModel.uploadContext.activeBatchId) currentUploadBatch = await api.read("batchResult", { batchId: routeModel.uploadContext.activeBatchId });
    const activeBatch = currentUploadBatch || routeModel.uploadContext.activeBatch || await api.read("activeBatch");
    noticeAccepted = Boolean(routeModel.mediaNotice.consentEventId);
    consentEventId = routeModel.mediaNotice.consentEventId;
    return uploadPage(state, activeBatch, noticeAccepted);
  }
  const photoMatch = path.match(/^\/s\/[^/]+\/photos\/([^/]+)$/);
  if (photoMatch) {
    const spaceId = path.split("/")[2];
    const photoId = photoMatch[1];
    routeModel.photo = await api.read("viewerPhotoDetail", { spaceId, photoId });
    if (!fixtureMode) {
      routeModel.photo.asset = await verifiedPhotoUrl(routeModel.photo);
      if (routeModel.photo.mediaType === "video") routeModel.photo.videoAsset = await verifiedVideoUrl(routeModel.photo);
    }
    state.capabilities.view = true;
    // B17: the title row needs the space name plus this photo's position among
    // the space's visible photos ("第 x 张") — neither field is on the
    // photo-detail read model itself, so pull the same ordered list the album
    // grid renders from and derive both there. projectViewer keeps
    // state.spaces/capabilities in sync the same way the album/scene routes
    // already do. Best-effort: a failure here just means the heading falls
    // back to the space name alone, not a broken page.
    try {
      const viewer = await api.read("viewerSpace", { spaceId });
      projectViewer(viewer);
      const index = (viewer.photos || []).findIndex((item) => item.id === photoId);
      if (index >= 0) routeModel.photo.orderIndex = index + 1;
    } catch {}
    return photoPage(state, routeModel.photo, {
      afterPlacementSecondary: extensions.renderSecondarySlot("photoDetail.afterPlacementSecondary", { state, photo: routeModel.photo, apiClient: api, featureFlags })
    });
  }
  const batchMatch = path.match(/^\/uploads\/([^/]+)$/);
  if (batchMatch) {
    routeModel.batchResult = await api.read("batchResult", { batchId: batchMatch[1] });
    await verifyBatchAssets(routeModel.batchResult);
    routeModel.batchReceipt = routeModel.batchResult?.status === "finalized" ? await api.read("batchReceipt") : null;
    return batchResultPage(state, routeModel.batchReceipt || routeModel.batchResult);
  }
  const batchItemMatch = path.match(/^\/uploads\/([^/]+)\/items\/([^/]+)$/);
  if (batchItemMatch) {
    routeModel.batchItem = await api.read("batchReceiptItem", { itemId: batchItemMatch[2] });
    if (!fixtureMode && routeModel.batchItem) routeModel.batchItem.asset = await verifiedPhotoUrl(routeModel.batchItem);
    return batchItemPage(state, { id: routeModel.batchItem?.batchId || batchItemMatch[1] }, routeModel.batchItem);
  }
  if (path === "/uploads/open" && globalThis.__UNSEEN_BOOTSTRAP__) return bootstrapStatus("BATCH_RECEIPT.EXCHANGE");
  const placementMatch = path.match(/^\/placements\/([^/]+)\/edit$/);
  if (placementMatch) return placementRoute(placementMatch[1], query);
  const manageMatch = path.match(/^\/manage\/([^/]+)$/);
  if (manageMatch) {
    routeModel.management = await api.read("managementView", { spaceId: manageMatch[1] });
    await verifyManagementAssets(routeModel.management);
    state.capabilities.manage = true;
    state.capabilities.view = Boolean(routeModel.management.effectiveCanView ?? true);
    state.capabilities.upload = Boolean(routeModel.management.effectiveCanUpload ?? true);
    state.memberships = routeModel.management.memberships || [];
    if (routeModel.management.isOwner) {
      routeModel.management.publicListing = await api.read("publicListing", { spaceId: manageMatch[1] }).catch(() => null);
    }
    return managePage(state, routeModel.management, query.get("tab") || "overview", {
      overviewSecondary: extensions.renderSecondarySlot("manageOverview.secondary", { state, management: routeModel.management, apiClient: api, featureFlags })
    });
  }
  const statusMatch = path.match(/^\/(exports|deletions|reports|appeals)\/([^/]+)$/);
  if (statusMatch) {
    const resource = { exports: "exportStatus", deletions: "deletionStatus", reports: "reportStatus", appeals: "appealStatus" }[statusMatch[1]];
    const param = statusMatch[1] === "exports" ? { exportId: statusMatch[2] } : statusMatch[1] === "deletions" ? { deletionId: statusMatch[2] } : { caseId: statusMatch[2] };
    routeModel.status = await api.read(resource, param);
    return genericStatusPage(state, statusMatch[1], routeModel.status);
  }
  const supportStatusMatch = path.match(/^\/support\/cases\/([^/]+)$/);
  if (supportStatusMatch) {
    routeModel.status = await api.read("supportStatus", { caseId: supportStatusMatch[1] });
    return genericStatusPage(state, "support", routeModel.status);
  }
  const jobStatusMatch = path.match(/^\/jobs\/([^/]+)$/);
  if (jobStatusMatch) {
    routeModel.status = await api.read("jobStatus", { jobId: jobStatusMatch[1] });
    return genericStatusPage(state, "job", routeModel.status);
  }
  if (path === "/member-invitations/accept" && globalThis.__UNSEEN_BOOTSTRAP__) return bootstrapStatus("MEMBER_INVITATION.ACCEPT");
  const extensionRoute = await extensions.route(path, { state, query, apiClient: api, featureFlags });
  return extensionRoute || notFoundPage(state);
}

function projectViewer(viewer) {
  state.capabilities.view = Boolean(viewer.effectiveCanView ?? true);
  state.capabilities.upload = Boolean(viewer.effectiveCanUpload);
  state.capabilities.manage = Boolean(viewer.effectiveCanManage);
  const summary = { id: state.currentSpaceId, name: viewer.name, dateLabel: viewer.dateLabel, scene: viewer.scene };
  state.spaces = [summary, ...(state.spaces || []).filter((space) => space.id !== summary.id)];
}

function projectOwnerTransfers(model = {}) {
  const fallback = Array.isArray(model) ? model : model.items || model.transfers || [];
  state.incomingOwnerTransfers = model.incoming || model.incomingOwnerTransfers || fallback;
  state.pendingOwnerTransfers = model.pending || model.pendingOwnerTransfers || [];
  state.memberships = model.eligibleMemberships || model.memberships || [];
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function verifiedPhotoUrl(photo) {
  const media = photo?.photoMedia || photo?.media || {};
  const source = photo?.photoUrl || photo?.assetUrl || photo?.asset || media.url;
  const identity = [photo?.photoAssetId, photo?.photoAssetVersion, photo?.photoRawSha256].join(":");
  if (!source || !photo?.photoAssetId || !photo?.photoAssetVersion || !/^[a-f0-9]{64}$/i.test(photo?.photoRawSha256 || "")) return "";
  if (verifiedPhotoUrls.has(identity)) return verifiedPhotoUrls.get(identity);
  if (media.url && media.assetId && media.assetVersion && media.sha256 && media.bytes && media.contentType) {
    const verified = await fetchVerifiedViewerMedia(media).catch(() => null);
    if (!verified) return "";
    verifiedPhotoUrls.set(identity, verified.url);
    return verified.url;
  }
  const response = await fetch(source, { credentials: "include", cache: "no-store" });
  if (!response.ok) return "";
  const bytes = await response.arrayBuffer();
  if (await sha256Hex(bytes) !== photo.photoRawSha256.toLowerCase()) return "";
  const url = URL.createObjectURL(new Blob([bytes], { type: response.headers.get("content-type") || "application/octet-stream" }));
  verifiedPhotoUrls.set(identity, url);
  return url;
}

// Video upload v0: mirrors verifiedPhotoUrl() above but for photo.video (present only when
// photoDetail() returns mediaType==='video' -- see services/api/src/viewer-media-service.mjs).
// Reuses the exact same fetchVerifiedViewerMedia() sha256/etag/length verification path as every
// other viewer media fetch; the only difference is which descriptor field it reads.
async function verifiedVideoUrl(photo) {
  const media = photo?.video;
  const identity = [photo?.photoAssetId, media?.assetId, media?.assetVersion, media?.sha256].join(":");
  if (!media?.url || !media?.assetId || !media?.assetVersion || !media?.sha256 || !media?.bytes || !media?.contentType) return "";
  if (verifiedVideoUrls.has(identity)) return verifiedVideoUrls.get(identity);
  const verified = await fetchVerifiedViewerMedia(media).catch(() => null);
  if (!verified) return "";
  verifiedVideoUrls.set(identity, verified.url);
  return verified.url;
}

async function verifyViewerAssets(viewer, spaceId) {
  if (fixtureMode) return;
  await Promise.all((viewer.photos || []).map(async (photo) => {
    let url = await verifiedPhotoUrl(photo);
    if (!url) {
      const fresh = await api.read("viewerPhotoDetail", { spaceId, photoId: photo.id }).catch(() => null);
      if (fresh) url = await verifiedPhotoUrl(fresh);
    }
    photo.asset = url;
    photo.assetVerified = Boolean(url);
  }));
}

async function verifyBatchAssets(batch) {
  if (fixtureMode || !batch) return;
  for (const item of batch.items || []) item.asset = await verifiedPhotoUrl(item);
}

async function verifyManagementAssets(management) {
  if (fixtureMode || !management) return;
  const photos = [...(management.reviewQueue || []), ...(management.placementQueue || [])];
  for (const photo of photos) photo.asset = await verifiedPhotoUrl(photo);
}

function bootstrapStatus(actionId) {
  const bootstrap = globalThis.__UNSEEN_BOOTSTRAP__;
  return shell(`<div class="page">${statePanel(actionId, bootstrap.invalid ? "stable_error" : "loading", { onRetry: false })}</div>`, { state, path: location.pathname, bottom: false });
}

function guard(capability, callback) {
  const allowed = capability === "account" ? Boolean(state.account) : Boolean(state.capabilities[capability]);
  if (!allowed) return shell(`<div class="page">${statePanel(capability === "account" ? "MY_SPACES.OPEN" : "SPACE.OPEN", "session_or_permission_loss", { onRetry: false })}</div>`, { state, path: location.pathname, bottom: false });
  return callback();
}

async function projectSpace(spaceId) {
  state.currentSpaceId = spaceId;
  api.selectSpace(spaceId);
  try {
    const viewer = await api.read("viewerSpace", { spaceId });
    if (viewer.effectiveCanView !== false) return navigate(`/s/${spaceId}/album`, { replace: true, renderNow: false });
  } catch (error) { if (![401, 403, 404].includes(error.status)) throw error; }
  try {
    const upload = await api.read("uploadContext", { spaceId });
    if (upload.effectiveCanUpload) return navigate(`/s/${spaceId}/upload`, { replace: true, renderNow: false });
  } catch (error) { if (![401, 403, 404].includes(error.status)) throw error; }
  try {
    const management = await api.read("managementView", { spaceId });
    if (management) return navigate(`/manage/${spaceId}`, { replace: true, renderNow: false });
  } catch (error) { if (![401, 403, 404].includes(error.status)) throw error; }
  return navigate(state.account ? "/spaces" : "/", { replace: true, renderNow: false });
}

async function placementRoute(photoId, query) {
  const batchId = query.get("batch");
  const itemId = query.get("item");
  routeModel.placement = itemId ? await api.read("batchItemPlacementEdit", { itemId }) : await api.read("placementEdit", { photoId });
  const target = routeModel.placement;
  const spaceId = target?.spaceId || state.currentSpaceId;
  if (spaceId) { state.currentSpaceId = spaceId; api.selectSpace(spaceId); }
  routeModel.sceneContext = target?.sceneContext || (spaceId ? await api.read("viewerSceneContext", { spaceId, photoId }).catch(() => null) : null);
  if (routeModel.sceneContext && !routeModel.sceneContext.placement) {
    // A v2 (待复核编辑器初始视角): the target photo has no confirmed placement of its own yet —
    // that's exactly why it's open in this editor (editorSceneContext() on the server always
    // returns `placement: null` for a needs_confirmation/failed/outside_scene photo, see its own
    // comment in viewer-media-service.mjs). Point the camera at the AI's top candidate direction
    // when the locator produced one (PlacementService#suggestionView()'s `candidates`, already
    // ranked with the top pick first), otherwise center it — canonicalViewerScene() turns this
    // draftPose into the viewer's initial focus without ever treating it as a real placement.
    const candidate = Array.isArray(target?.candidates) ? target.candidates[0] : null;
    const candidateYaw = Number(candidate?.yaw);
    const candidatePitch = Number(candidate?.pitch);
    routeModel.sceneContext = { ...routeModel.sceneContext, draftPose: {
      yawDeg: Number.isFinite(candidateYaw) ? candidateYaw : 0,
      pitchDeg: Number.isFinite(candidatePitch) ? candidatePitch : 0
    } };
  }
  if (!fixtureMode && target) target.asset = await verifiedPhotoUrl(target);
  return placementEditorPage(state, target, {
    batchId,
    itemId,
    receiptId: target?.receiptId,
    photoId: target?.photoId || photoId,
    // A v2 ("复核+定位二合一"): whether this editor session can also take the photo down
    // (通过/隐藏/拒绝, alongside the existing position controls) rides on which of the two
    // read endpoints served `target` above — batchItemPlacementEdit (itemId present) is the
    // uploader's own receipt-session view, placementEdit (no itemId) is the manager's
    // account-session view reached from placementTab's "打开位置编辑器" link. (This replaces
    // a prior `Boolean(target?.actor?.isOwner || target?.actor?.canEditPlacement)` check
    // that always evaluated false — neither editView() nor receiptItem() ever returns an
    // `actor` field — so "允许上传者再次调整" was dormant for every real manager; this fixes
    // that dormant gap as a side effect.)
    manager: !itemId,
    sceneContext: routeModel.sceneContext,
    returnTo: batchId && itemId ? `/uploads/${batchId}/items/${itemId}` : `/manage/${state.currentSpaceId}?tab=placement`
  });
}

async function bindPostRender(path, query) {
  const viewerRoot = document.querySelector("[data-viewer-root]");
  if (viewerRoot && routeModel.sceneContext) {
    if (fixtureMode && debugMode) {
      const markers = (routeModel.sceneContext.placements || []).filter((placement) => placement.placementState === "confirmed" || placement.status === "confirmed").map((placement) => ({ photoId: placement.photoId, label: placement.label || "照片" }));
      currentViewer = new FixtureViewerAdapter({ panoramaUrl: routeModel.sceneContext.panoramaUrl });
      currentViewer.mount(viewerRoot, { markers, initialYaw: Number(routeModel.sceneContext.focusPose?.yawDeg || 0) });
    } else {
      currentViewer = new ProductionViewerAdapter({
        loadViewer: () => import("@unseen/viewer"),
        focusOptions: viewerRoot.hasAttribute("data-placement-preview") ? { animate: false, focusOnComplete: true } : { focusOnComplete: true },
        refreshSceneContext: async () => {
          const photoId = query.get("photo") || routeModel.sceneContext.photoId;
          routeModel.sceneContext = await api.read("viewerSceneContext", { spaceId: state.currentSpaceId, photoId });
          return rotationOnlyViewerContext(routeModel.sceneContext);
        },
        onReturnRequest: (identity) => queueMicrotask(() => { void navigate(`/s/${state.currentSpaceId}/album?focus=${encodeURIComponent(identity.photoId)}`); }),
        onPoseChange: updatePose,
        onUnavailable: (error) => {
          // This was previously swallowed with no trace anywhere: a real mount failure just showed
          // the generic message below with nothing in the console to say why. Log it so a failed
          // "进入现场"/"回到现场" attempt is diagnosable from a user's own devtools or reported logs.
          console.error("[unseen] viewer mount failed", error?.message || error);
          // Block 7 (RELEASE-READINESS-CONTRACT.md §8 2D fallback requirement): the scene view
          // (not the placement editor's inline preview, which has its own flat_fallback render
          // mode handled inside the viewer package) also gets a static direction list here so a
          // WebGL failure doesn't leave the visitor with nothing but a retry button.
          const staticFallback = viewerRoot.hasAttribute("data-placement-preview") ? "" : sceneStaticFallback(routeModel.viewer?.photos);
          viewerRoot.innerHTML = `<div class="viewer-unavailable"><p>现场预览暂时不可用。</p><button class="button" type="button" data-retry>重新加载</button>${staticFallback}</div>`;
          announce("现场预览暂时不可用。");
        }
      });
      const mountedViewer = currentViewer;
      await mountedViewer.mount(viewerRoot, rotationOnlyViewerContext(routeModel.sceneContext)).catch(() => {});
      if (currentViewer !== mountedViewer) return;
    }
    const selected = query.get("photo");
    if (selected && currentViewer) await currentViewer.focusPhoto(selected);
    watchViewerStatusToast(viewerRoot);
  }
  const debugYaw = document.querySelector("[data-debug-yaw]");
  if (debugYaw) debugYaw.addEventListener("input", (event) => updatePose({ yawDeg: Number(event.target.value), pitchDeg: Number(document.querySelector('input[name="pitchDeg"]')?.value || 0) }));
  const focusPhoto = query.get("focus");
  if (path.endsWith("/album") && focusPhoto) restorePhotoFocus(focusPhoto);
  if (path === "/zine") {
    const zineMount = document.querySelector("[data-zine-mount]");
    if (zineMount) {
      const zineModule = await import("./zine/zine-app.js");
      zineApp = zineModule.mountZineApp(zineMount);
    }
  }
  handleBootstrap();
}

function updatePose(detail) {
  const yaw = Number(detail.yawDeg);
  const pitch = Number(detail.pitchDeg ?? 0);
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return;
  const yawInput = document.querySelector('input[name="yaw"]');
  const pitchInput = document.querySelector('input[name="pitchDeg"]');
  if (yawInput) yawInput.value = String(yaw);
  if (pitchInput) pitchInput.value = String(pitch);
  const form = document.querySelector("[data-placement-form]");
  if (form) {
    form.dataset.poseReady = "true";
    form.querySelector('[type="submit"]')?.removeAttribute("disabled");
  }
  const yawOutput = document.querySelector("[data-yaw-output]");
  const pitchOutput = document.querySelector("[data-pitch-output]");
  if (yawOutput) yawOutput.textContent = `${Math.round(yaw)}°`;
  if (pitchOutput) pitchOutput.textContent = `${Math.round(pitch)}°`;
  // Block 4 (B15): keep the scene page's "面向东南 · 附近 n 张照片" HUD line in
  // sync as the visitor drags/nudges the 360 view — the located-photo count
  // was already fixed at render time (data-located-count), only the compass
  // direction needs to move with yaw.
  const hud = document.querySelector("[data-viewer-hud]");
  if (hud) hud.textContent = sceneHudText(yaw, Number(hud.dataset.locatedCount || 0));
}

// Block 4 (B14): the compass button replaces the always-visible "前/左/后/右"
// row with a single toggle. This never touches Track 4's own direction/
// translation-control DOM (packages/viewer) — it only flips a class on the
// app-owned ancestor that styles.css uses to show/hide that group, so
// Track 4's own keyboard equivalence (arrow keys bound on the canvas itself)
// is completely unaffected either way.
function toggleViewerCompass(button) {
  const host = button.closest("[data-viewer-compass-host]");
  if (!host) return;
  const next = button.getAttribute("aria-expanded") !== "true";
  button.setAttribute("aria-expanded", String(next));
  host.classList.toggle("compass-open", next);
  if (next) host.querySelector(".unseen-viewer__bottom button")?.focus();
}

// Block 4 (B15 — reproduced: Track 4's own on-canvas status pill,
// .unseen-viewer__status, sets its text straight to "已回到照片所在位置。"
// after every successful focusPose animation (packages/viewer/src/viewer.js)
// and then never clears it again on its own — it sits there indefinitely,
// obstructing the immersive canvas. That element and its aria-live=polite
// wiring are Track 4's, not ours, so this only ever adds a *visual* fade via
// a CSS class (never touches textContent) — the polite announcement itself,
// and every later announcement, is untouched. prefers-reduced-motion already
// zeroes the opacity transition sitewide, so the 3s auto-fade degrades to an
// instant one, not a lingering pill either way.
function watchViewerStatusToast(root) {
  viewerStatusObserver?.disconnect();
  const status = root.querySelector(".unseen-viewer__status");
  if (!status) return;
  let timer;
  const schedule = () => {
    status.classList.remove("is-quiet");
    clearTimeout(timer);
    timer = setTimeout(() => status.classList.add("is-quiet"), 3000);
  };
  schedule();
  viewerStatusObserver = new MutationObserver(schedule);
  viewerStatusObserver.observe(status, { characterData: true, childList: true, subtree: true });
}

function restorePhotoFocus(photoId) {
  const card = document.querySelector(`[data-photo-card="${CSS.escape(photoId)}"]`);
  const link = card?.querySelector("a");
  card?.scrollIntoView({ block: "center" });
  link?.focus({ preventScroll: true });
}

async function handleBootstrap() {
  const bootstrap = globalThis.__UNSEEN_BOOTSTRAP__;
  if (!bootstrap || bootstrap.handled || bootstrap.invalid) return;
  const actionId = bootstrap.key === "receipt" ? "BATCH_RECEIPT.EXCHANGE" : bootstrap.path === "/member-invitations/accept" ? "MEMBER_INVITATION.ACCEPT" : "INVITATION.EXCHANGE";
  if (actionId === "MEMBER_INVITATION.ACCEPT" && !state.account) {
    if (location.pathname !== "/login") await navigate("/login");
    return;
  }
  bootstrap.handled = true;
  try {
    const result = await api.act(actionId, { [bootstrap.key === "receipt" ? "receiptSecret" : "inviteSecret"]: bootstrap.value });
    delete bootstrap.value;
    announce(actionCopy(actionId, "success"));
    await navigate(result.destinationRoute || (actionId === "MEMBER_INVITATION.ACCEPT" ? "/spaces" : "/"), { replace: true });
  } catch (error) {
    delete bootstrap.value;
    toast(actionCopy(actionId, "stable_error"), "error");
  }
}

async function navigate(href, { replace = false, renderNow = true, restoreScroll = false } = {}) {
  cancelPanoramaOperation();
  const target = new URL(href, location.origin);
  const currentAlbumSpaceId = location.pathname.match(/^\/s\/([^/]+)\/album$/)?.[1];
  if (currentAlbumSpaceId) albumScrollMemory = { spaceId: currentAlbumSpaceId, scrollY };
  const restoreTargetSpaceId = restoreScroll ? target.pathname.match(/^\/s\/([^/]+)\/album$/)?.[1] : undefined;
  const canRestore = Boolean(restoreTargetSpaceId) && albumScrollMemory.spaceId === restoreTargetSpaceId;
  const focusPhotoId = document.activeElement?.closest?.("[data-photo-card]")?.dataset.photoCard || "";
  history.replaceState({ ...(history.state || {}), scrollY: scrollY, focusId: document.activeElement?.id || "", focusPhotoId }, "", location.href);
  const nextState = { scrollY: canRestore ? albumScrollMemory.scrollY : 0, focusId: "" };
  if (replace) history.replaceState(nextState, "", target.pathname + target.search + target.hash);
  else history.pushState(nextState, "", target.pathname + target.search + target.hash);
  if (!target.searchParams.get("focus") && !canRestore) scrollTo({ top: 0, left: 0, behavior: "instant" });
  const complete = async () => {
    await render();
    if (canRestore) { scrollTo({ top: albumScrollMemory.scrollY, left: 0, behavior: "instant" }); return; }
    if (!target.searchParams.get("focus")) {
      scrollTo({ top: 0, left: 0, behavior: "instant" });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      scrollTo({ top: 0, left: 0, behavior: "instant" });
    }
  };
  if (renderNow) await complete();
  else queueMicrotask(complete);
}

document.addEventListener("click", async (event) => {
  // Block 4: a real in-page "#id" href (the scene skip-link, spec §8 item 1)
  // is new territory for this SPA — every other internal link is [data-nav]
  // and never touches the browser's own navigation. A same-document fragment
  // jump still fires a real `popstate`, and this app's popstate handler does
  // a full render() (rebuilding the DOM, remounting the WebGL viewer) on
  // every history change — which would tear down and replace the very
  // target the browser was mid-scroll to, so the native jump never lands.
  // Handling it entirely in JS (no real navigation, no popstate) sidesteps
  // that without touching the shared popstate handler other pages rely on.
  const skip = event.target.closest(".skip-link[href^='#']");
  if (skip) { event.preventDefault(); document.getElementById(skip.getAttribute("href").slice(1))?.focus(); return; }
  const nav = event.target.closest("[data-nav]");
  if (nav) {
    event.preventDefault();
    if (nav.closest("[role=dialog]")) closeDialog();
    await navigate(nav.getAttribute("href"), { restoreScroll: nav.hasAttribute("data-restore-album-scroll") });
    return;
  }
  const compassToggle = event.target.closest("[data-compass-toggle]");
  if (compassToggle) { toggleViewerCompass(compassToggle); return; }
  const reset = event.target.closest("[data-fixture-reset]");
  if (reset) { api.reset(); noticeAccepted = false; loginChallengeSent = false; await navigate("/", { replace: true }); return; }
  const retry = event.target.closest("[data-retry]");
  if (retry) { await render(); return; }
  const aiCandidate = event.target.closest("[data-ai-candidate]");
  if (aiCandidate) {
    // 只把 AI 候选方向填进现有的位置输入控件（跟调试滑杆走同一条 updatePose 路径），
    // 审核者再微调后仍然是走既有的手动保存流程，不引入新的保存分支。
    updatePose({ yawDeg: Number(aiCandidate.dataset.yaw), pitchDeg: Number(aiCandidate.dataset.pitch || 0) });
    document.querySelectorAll("[data-ai-candidate]").forEach((chip) => chip.setAttribute("aria-pressed", String(chip === aiCandidate)));
    return;
  }
  const openSpace = event.target.closest("[data-open-space]");
  if (openSpace) { await navigate("/open"); return; }
  const scanAgain = event.target.closest("[data-scan-again]");
  if (scanAgain) { await startQrScanner(); return; }
  const admission = event.target.closest("[data-admit-campaign]");
  if (admission) { await admitCampaign(admission); return; }
  const requestListing = event.target.closest("[data-request-public-listing]");
  if (requestListing) { await requestPublicListing(requestListing); return; }
  const autoApproveToggle = event.target.closest("[data-toggle-auto-approve]");
  if (autoApproveToggle) { await toggleAutoApproveUploads(autoApproveToggle); return; }
  const publishGapWishTrigger = event.target.closest("[data-publish-gap-wish]");
  if (publishGapWishTrigger) { await publishGapWish(publishGapWishTrigger); return; }
  const personalSpace = event.target.closest("[data-open-personal-space]");
  if (personalSpace) { await openPersonalSpace(personalSpace); return; }
  const check = event.target.closest("[data-notice-check]");
  if (check) { document.querySelector('[data-action="UPLOAD.ACCEPT_NOTICE"]').disabled = !check.checked; return; }
  const fixtureUpload = event.target.closest("[data-fixture-upload]");
  if (fixtureUpload && debugMode) { await perform("UPLOAD.SELECT_FILES", { files: ["仪式.jpg", "窗边.jpg", "过大的照片.png"], consentEventId }); return; }
  const fixturePanorama = event.target.closest("[data-fixture-panorama]");
  if (fixturePanorama && debugMode) { await perform("PANORAMA.UPLOAD_CANDIDATE", { fileName: "新的现场.jpg" }); return; }
  const confirm = event.target.closest("[data-confirm-action]");
  if (confirm) { openConfirm(confirm); return; }
  const dialogConfirm = event.target.closest("[data-dialog-confirm]");
  if (dialogConfirm) { await confirmDialogAction(dialogConfirm); return; }
  const close = event.target.closest("[data-close-dialog]");
  if (close) { closeDialog(); return; }
  const contentDialog = event.target.closest("[data-content-dialog]");
  if (contentDialog) { openContentDialog(contentDialog.dataset.contentDialog, contentDialog.dataset.photoId, contentDialog.dataset.ifMatch); return; }
  const campaign = event.target.closest("[data-open-campaign]");
  if (campaign) { openCampaignDialog(); return; }
  const copyCampaign = event.target.closest("[data-copy-campaign]");
  if (copyCampaign) { await copyCampaignUrl(copyCampaign.dataset.url); return; }
  const copyMember = event.target.closest("[data-copy-member]");
  if (copyMember) { await copyMemberUrl(copyMember.dataset.url); return; }
  const copyReceipt = event.target.closest("[data-copy-receipt]");
  if (copyReceipt) { await copyReceiptCode(copyReceipt.dataset.value); return; }
  const qr = event.target.closest("[data-show-qr]");
  if (qr) { openQrDialog(qr.dataset.url); return; }
  const memberInvite = event.target.closest("[data-open-member-invite]");
  if (memberInvite) { openMemberInviteDialog(); return; }
  const editMember = event.target.closest("[data-edit-member]");
  if (editMember) { openMemberDialog(editMember.dataset.memberId); return; }
  const binding = event.target.closest("[data-open-binding]");
  if (binding) { openBindingDialog(binding.dataset.batchId); return; }
  const resendLogin = event.target.closest("[data-resend-login-code]");
  if (resendLogin) {
    try {
      await requestLoginCode({ email: loginEmail }, resendLogin);
      toast("验证码已重新发送。", "success");
      document.querySelector("#code")?.focus();
    } catch (error) {
      resendLogin.disabled = false;
      toast(error.message || "验证码发送失败，请重试。", "error");
      resendLogin.focus();
    }
    return;
  }
  const report = event.target.closest("[data-open-report]");
  if (report) { openReportDialog(report.dataset.photoId); return; }
  const photoMenu = event.target.closest("[data-open-photo-menu]");
  if (photoMenu) { openPhotoMenuDialog(photoMenu.dataset.photoId); return; }
  const appeal = event.target.closest("[data-open-appeal]");
  if (appeal) { openAppealDialog(appeal.dataset.batchId, appeal.dataset.itemId); return; }
  const transfer = event.target.closest("[data-open-owner-transfer]");
  if (transfer) { openOwnerTransferDialog(); return; }
  const action = event.target.closest("[data-action]");
  const fromViewer = event.composedPath().some((node) => node?.dataset?.viewerRoot !== undefined);
  if (action && !fromViewer) {
    let payload = datasetPayload(action);
    if (action.dataset.action === "UPLOAD.ACCEPT_NOTICE") payload = {
      noticeVersion: routeModel.mediaNotice?.noticeVersion,
      noticeHash: routeModel.mediaNotice?.noticeHash,
      mediaPolicyVersion: routeModel.mediaNotice?.mediaPolicyVersion,
      choices: routeModel.mediaNotice?.choices
    };
    await perform(action.dataset.action, payload);
  }
});

app.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  if (!form.reportValidity()) { focusFirstInvalid(form); return; }
  const values = Object.fromEntries(new FormData(form));
  if (form.matches("[data-login-form]")) {
    if (!loginChallengeSent) {
      loginEmail = values.email;
      try {
        await requestLoginCode(values, form.querySelector('button[type="submit"]'));
      } catch (error) {
        toast(error.message || "验证码发送失败，请重试。", "error");
        return;
      }
      loginChallengeSent = true;
      toast(actionCopy("AUTH.REQUEST_CODE", "success"), "success");
      await render();
    } else {
      try {
        const result = await api.act("AUTH.VERIFY_CODE", values);
        loginChallengeSent = false;
        if (result.registration?.status === "pending") {
          const message = "账号申请已提交，正在等待管理员审核。审核通过后请重新登录。";
          app.innerHTML = loginPage(state, false, message);
          bindPostRender("/login", new URLSearchParams());
          announce(message);
          return;
        }
        announce(actionCopy("AUTH.VERIFY_CODE", "success"));
        await navigate(safeReturnTarget(new URLSearchParams(location.search).get("returnTo"), "/spaces"));
      }
      catch (error) { app.innerHTML = loginPage(state, true, error.message); bindPostRender("/login", new URLSearchParams()); document.querySelector("#code")?.focus(); }
    }
    return;
  }
  if (form.matches("[data-open-space-form]")) {
    const url = new URL(values.link, location.origin);
    if (url.origin !== location.origin || !/^\/open\/[A-Za-z0-9_-]+$/.test(url.pathname) || url.search || url.hash) {
      app.innerHTML = openSpacePage(state, "请输入同源、无参数的活动链接。");
      bindPostRender("/open", new URLSearchParams());
      document.querySelector("#campaign-link")?.focus();
      return;
    }
    await navigate(url.pathname);
    return;
  }
  if (form.matches("[data-create-space-form]")) { const result = await perform("SPACE.CREATE", values, { navigateResult: false }); if (result) await navigate(result.destinationRoute); return; }
  if (form.matches("[data-placement-form]")) {
    const manager = Boolean(routeModel.placement?.actor?.isOwner || routeModel.placement?.actor?.canEditPlacement);
    const yaw = Number(values.yaw), pitchDeg = Number(values.pitchDeg);
    let panoramaRevisionId = "";
    try { panoramaRevisionId = canonicalViewerScene(routeModel.sceneContext).scene.panorama.revisionId; } catch {}
    if (form.dataset.poseReady !== "true" || values.yaw === "" || values.pitchDeg === "" || !Number.isFinite(yaw) || !Number.isFinite(pitchDeg) || values.panoramaRevisionId !== panoramaRevisionId) {
      toast("现场位置已过期，请刷新后重试。", "error");
      return;
    }
    await perform(form.dataset.placementAction, { ...values, yaw, pitchDeg, batchId: form.dataset.batchId, itemId: form.dataset.itemId, photoId: form.dataset.photoId, ifMatch: form.dataset.ifMatch, manager });
    return;
  }
  if (form.matches("[data-support-form]")) { const result = await perform("SUPPORT.SUBMIT_SAFETY_LEAD", values, { navigateResult: false }); if (result) await navigate(`/support/cases/${result.id}`); }
  if (form.matches("[data-wish-form]")) {
    const spaceId = form.dataset.spaceId;
    const wishes = Object.keys(values).filter((key) => key.startsWith("wish-"))
      .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
      .map((key) => String(values[key] || "").trim()).filter(Boolean);
    const status = form.querySelector("[data-wish-status]");
    try {
      await api.updateSpaceWishes(spaceId, wishes, form.dataset.ifMatch);
      if (status) status.textContent = wishWallCopy.manage.savedStatus;
      toast(wishWallCopy.manage.savedStatus, "success");
      await render({ preserveFocus: true });
    } catch (error) {
      if (status) status.textContent = error.message || "保存失败，请重试。";
      toast(error.message || "保存失败，请重试。", "error");
    }
    return;
  }
});

app.addEventListener("change", async (event) => {
  if (event.target.matches("[data-retry-upload]") && event.target.files?.[0]) {
    const payload = datasetPayload(event.target);
    if (fixtureMode) await perform("UPLOAD.RETRY_ITEM", payload);
    else {
      try {
        announce("正在重新上传这张照片…");
        const result = await uploadWorkflow.retryItem({ ...payload, failureVersion: Number(payload.failureVersion), file: event.target.files[0] });
        currentUploadBatch = result.batchResult;
        await render({ preserveFocus: true });
      } catch (error) { toast(error.message || "照片重新上传失败。", "error"); }
    }
    return;
  }
  if (event.target.matches("#photo-files") && event.target.files?.length) {
    const files = [...event.target.files];
    if (fixtureMode) await perform("UPLOAD.SELECT_FILES", { files, consentEventId });
    else {
      try {
        announce("正在上传照片…");
        const result = await uploadWorkflow.uploadFiles({ spaceId: state.currentSpaceId, files, consentEventId, batchIfMatch: routeModel.uploadContext?.ifMatch });
        currentUploadBatch = result.batchResult;
        announce("照片已逐张上传。");
        await render({ preserveFocus: true });
      } catch (error) { toast(error.message || "照片上传失败，请重试。", "error"); }
    }
  }
  if (event.target.matches("[data-panorama-file]") && event.target.files?.[0]) {
    if (fixtureMode) await perform("PANORAMA.UPLOAD_CANDIDATE", { fileName: event.target.files[0].name });
    else {
      const operation = beginPanoramaOperation(state.currentSpaceId);
      try {
        showPanoramaStatus("正在上传并检查现场文件…");
        const candidate = await panoramaWorkflow.uploadCandidate({ spaceId: operation.spaceId, file: event.target.files[0], noticeAcknowledgement: routeModel.management?.panoramaNoticeAcknowledgement, ifMatch: routeModel.management?.space?.ifMatch });
        if (!isCurrentPanoramaOperation(operation)) return;
        showPanoramaStatus("现场文件已上传，正在检查尺寸、格式与比例…");
        void watchPanoramaCandidate(operation, candidate);
      } catch (error) {
        if (!isCurrentPanoramaOperation(operation)) return;
        activePanoramaOperation = null;
        showPanoramaStatus(error.message || "现场文件上传失败，请重新选择文件上传。", "error");
        toast(error.message || "现场文件上传失败，请重试。", "error");
      }
    }
  }
});

window.addEventListener("popstate", async (event) => {
  cancelPanoramaOperation();
  await render({ preserveFocus: true });
  scrollTo({ top: Number(event.state?.scrollY || 0), left: 0, behavior: "instant" });
  if (event.state?.focusPhotoId) restorePhotoFocus(event.state.focusPhotoId);
  else if (event.state?.focusId) document.getElementById(event.state.focusId)?.focus({ preventScroll: true });
});
window.addEventListener("pagehide", cancelPanoramaOperation);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.querySelector("[data-dialog-scrim]")) closeDialog();
  else if (event.key === "Escape") closeViewerCompassIfFocused();
  if (event.key === "Tab") trapDialogFocus(event);
});

// Standard disclosure-widget Escape handling for the compass panel: only
// fires when focus is actually inside the open direction-control group, so
// it never competes with Track 4's own canvas-level Escape ("return to
// photo" — packages/viewer/src/viewer.js's own keydown handler, unrelated
// to this button and unaffected by it).
function closeViewerCompassIfFocused() {
  const host = document.querySelector("[data-viewer-compass-host].compass-open");
  const panel = host?.querySelector(".unseen-viewer__bottom");
  if (!host || !panel?.contains(document.activeElement)) return;
  const toggle = host.querySelector("[data-compass-toggle]");
  host.classList.remove("compass-open");
  toggle?.setAttribute("aria-expanded", "false");
  toggle?.focus();
}

async function perform(actionId, payload = {}, { navigateResult = true, rerender = true } = {}) {
  requireAction(actionId);
  const trigger = document.activeElement;
  payload = prepareActionPayload(actionId, payload);
  const queueItemId = trigger?.closest?.("[data-queue-item]")?.dataset.queueItem;
  const label = actionCopy(actionId, "loading");
  if (trigger instanceof HTMLButtonElement) { trigger.disabled = true; trigger.dataset.originalText = trigger.textContent; trigger.textContent = label || "处理中…"; }
  announce(label);
  try {
    const result = await api.act(actionId, payload);
    if (actionId === "UPLOAD.ACCEPT_NOTICE") { noticeAccepted = true; consentEventId = result.consentEventId || result.id || consentEventId; }
    announce(actionCopy(actionId, "success"));
    toast(actionCopy(actionId, "success") || "已完成", "success");
    if (navigateResult && result.destinationRoute) await navigate(result.destinationRoute);
    else if (actionId === "UPLOAD.FINALIZE_BATCH") await navigate(`/uploads/${payload.batchId}`);
    else if (actionId === "AUTH.LOGOUT" || actionId === "AUTH.LOGOUT_ALL") await navigate("/");
    else if (actionId === "SPACE.ARCHIVE") await navigate("/spaces?filter=archived");
    else if (actionId === "SPACE.EXPORT" || actionId === "ACCOUNT.EXPORT") await navigate(`/exports/${result.id}`);
    else if (actionId === "SPACE.DELETE_REQUEST" || actionId === "ACCOUNT.DELETE_REQUEST") await navigate(`/deletions/${result.id}`);
    else if (actionId === "EXPORT.DOWNLOAD") await downloadExport(result, payload.exportId);
    else if (actionId === "MANAGE.OPEN_NEXT" && result.outcome === "target") await navigate(`/manage/${state.currentSpaceId}?tab=${result.target.contentState && result.target.contentState !== "visible" ? "review" : "placement"}`);
    else if (rerender) {
      await render({ preserveFocus: true });
      focusMutationReturn(actionId, queueItemId);
    }
    return result;
  } catch (error) {
    const phase = error.status === 401 || error.status === 403 ? "session_or_permission_loss" : "stable_error";
    toast(error.message || actionCopy(actionId, phase), "error");
    announce(error.message || actionCopy(actionId, phase));
    if (trigger instanceof HTMLButtonElement) { trigger.disabled = false; trigger.textContent = trigger.dataset.originalText || actionCopy(actionId); trigger.focus(); }
    return null;
  }
}

function prepareActionPayload(actionId, payload) {
  const management = routeModel.management;
  const batchItem = routeModel.batchItem;
  const placement = routeModel.placement;
  const currentSpace = management?.space || state.spaces?.find((space) => space.id === state.currentSpaceId);
  const defaults = {
    "UPLOAD.FINALIZE_BATCH": { itemsDigest: currentUploadBatch?.itemsDigest, ifMatch: currentUploadBatch?.ifMatch },
    "BATCH_RECEIPT.REVOKE": { ifMatch: routeModel.batchReceipt?.ifMatch || routeModel.batchResult?.ifMatch, reason: "user_revoked" },
    "BATCH.DELETE_ITEM": { photoId: batchItem?.photoId, ifMatch: batchItem?.ifMatch, reason: "user_requested" },
    "PLACEMENT.RETRY": { photoId: batchItem?.photoId || placement?.photoId, failedVersion: batchItem?.failureVersion || placement?.failedVersion },
    "PLACEMENT.CONFIRM": { suggestionId: placement?.suggestionId, candidateId: placement?.candidateId, ifMatch: placement?.ifMatch },
    "PLACEMENT.SAVE": { reason: "manual_adjustment", ifMatch: placement?.ifMatch },
    "PLACEMENT.UNDO": { targetRevisionId: placement?.currentPlacementRevisionId, reason: "user_undo", ifMatch: placement?.ifMatch },
    "PLACEMENT.MARK_OUTSIDE": { ifMatch: placement?.ifMatch },
    "PLACEMENT.REOPEN_FOR_CONTRIBUTOR": { receiptId: placement?.receiptId, itemId: placement?.itemId, reason: "owner_reopened", ifMatch: placement?.itemIfMatch || placement?.ifMatch },
    "NOTE.OPT_IN": { consentVersion: batchItem?.noteConsentVersion, consentHash: batchItem?.noteConsentHash, photoContentHash: batchItem?.photoRawSha256 },
    "NOTE.CONFIRM": { jobId: batchItem?.noteJobId, draftVersion: batchItem?.noteDraftVersion, ifMatch: batchItem?.noteJobIfMatch },
    "NOTE.WITHDRAW": { reason: "user_withdrew", ifMatch: batchItem?.noteIfMatch },
    "EXTERNAL_INVITATION.CREATE": { ifMatch: exactManagementSpaceIfMatch(management, location.pathname, state.currentSpaceId) },
    "EXTERNAL_INVITATION.REVOKE": { reasonClass: "owner_revoked", ifMatch: management?.campaigns?.find((item) => item.id === payload.campaignId)?.ifMatch },
    "MEMBER_INVITATION.REVOKE": { reason: "owner_revoked", ifMatch: management?.memberInvitations?.find((item) => item.id === payload.invitationId)?.ifMatch },
    "MEMBERSHIP.UPDATE": { ifMatch: management?.memberships?.find((item) => item.id === payload.membershipId)?.ifMatch },
    "MEMBERSHIP.REVOKE": { reason: "owner_revoked", ifMatch: management?.memberships?.find((item) => item.id === payload.membershipId)?.ifMatch },
    "COLLECTION.PAUSE": { ifMatch: currentSpace?.ifMatch },
    "COLLECTION.RESUME": { ifMatch: currentSpace?.ifMatch },
    "SHARING.ENABLE": { ifMatch: currentSpace?.ifMatch },
    "SHARING.DISABLE": { ifMatch: currentSpace?.ifMatch },
    "SPACE.ARCHIVE": { spaceId: state.currentSpaceId, reason: "owner_archived", ifMatch: currentSpace?.ifMatch },
    "SPACE.RESTORE": { reason: "owner_restored", ifMatch: currentSpace?.ifMatch },
    "SPACE.EXPORT": { spaceId: state.currentSpaceId, format: "json" },
    "SPACE.DELETE_REQUEST": { reason: "owner_requested", ifMatch: currentSpace?.ifMatch },
    "ACCOUNT.EXPORT": { format: "json" },
    "ACCOUNT.DELETE_REQUEST": { ifMatch: state.account?.ifMatch },
    "OWNER_TRANSFER.CREATE": { spaceId: state.currentSpaceId, ifMatchVersion: currentSpace?.version },
    "OWNER_TRANSFER.ACCEPT": { ifMatchVersion: state.incomingOwnerTransfers?.find((item) => item.id === payload.transferId)?.version },
    "OWNER_TRANSFER.REVOKE": { ifMatchVersion: state.pendingOwnerTransfers?.find((item) => item.id === payload.transferId)?.version },
    "APPEAL.SUBMIT": { targetCaseId: batchItem?.contentCaseId }
  }[actionId] || {};
  return { ...defaults, ...payload };
}

function focusMutationReturn(actionId, removedQueueItemId) {
  if (["CONTENT.APPROVE", "CONTENT.HIDE", "CONTENT.REJECT", "CONTENT.RESTORE", "CONTENT.REOPEN", "UPLOAD.REMOVE_ITEM", "BATCH.DELETE_ITEM", "BATCH_RECEIPT.REVOKE", "EXTERNAL_INVITATION.REVOKE", "MEMBER_INVITATION.REVOKE", "MEMBERSHIP.REVOKE", "OWNER_TRANSFER.REVOKE"].includes(actionId)) {
    const next = document.querySelector("[data-queue-item] button, [data-queue-item] a, [data-queue-item] h3") || document.querySelector("[data-mutation-return-target]") || document.querySelector(".empty-state h2") || document.querySelector("[data-phase] h2") || document.querySelector("#main h1, #main h2");
    if (next) {
      if (!next.matches("button,a")) next.tabIndex = -1;
      const restore = () => { if (next.isConnected) next.focus({ preventScroll: true }); };
      restore();
      requestAnimationFrame(restore);
    }
    return;
  }
  const original = removedQueueItemId ? document.querySelector(`[data-queue-item="${CSS.escape(removedQueueItemId)}"] button, [data-queue-item="${CSS.escape(removedQueueItemId)}"] a`) : null;
  original?.focus({ preventScroll: true });
}

// v3.1 "传到我的空间" (MaxNotes UNSEEN-UI规划v3, 3.1): the card only renders this
// button when the account is known (see templates.js personalSpaceCard()) but
// has no personalSpaceId yet, so this always needs the lazy create-or-find
// round trip before it can navigate. Reuses UPLOAD.OPEN's existing loading/
// error copy rather than adding new frozen-contract strings for one button.
async function openPersonalSpace(trigger) {
  trigger.disabled = true;
  // innerHTML, not textContent: this button's content is the nav-card
  // icon+title+subtitle structure (see templates.js personalSpaceCard()), and
  // textContent would flatten and permanently lose that structure on the
  // error-recovery path below.
  const originalHtml = trigger.innerHTML;
  const label = actionCopy("UPLOAD.OPEN", "loading") || "正在打开我的空间…";
  trigger.textContent = label;
  announce(label);
  try {
    const result = await api.ensurePersonalSpace();
    if (!result?.spaceId) throw new Error("personal_space_unavailable");
    await navigate(`/s/${encodeURIComponent(result.spaceId)}/upload`);
  } catch (error) {
    trigger.disabled = false;
    trigger.innerHTML = originalHtml;
    toast(error.message || actionCopy("UPLOAD.OPEN", "stable_error") || "我的空间暂时无法打开，请重试。", "error");
    trigger.focus();
  }
}

async function admitCampaign(trigger) {
  trigger.disabled = true;
  const original = trigger.textContent;
  trigger.textContent = actionCopy("INVITATION.EXCHANGE", "loading") || "正在打开…";
  announce(trigger.textContent);
  try {
    const result = await api.admitCampaign(trigger.dataset.campaignId);
    if (result.destinationRoute) { await navigate(result.destinationRoute); return; }
    const target = new URL(result.bootstrapUrl, location.origin);
    if (target.origin !== location.origin || target.pathname !== "/open" || !/^#invite=[A-Za-z0-9_-]+$/.test(target.hash)) throw new Error("invalid_bootstrap_route");
    location.assign(target.pathname + target.hash);
  } catch {
    trigger.disabled = false;
    trigger.textContent = original;
    toast(actionCopy("INVITATION.EXCHANGE", "stable_error"), "error");
  }
}

// "申请公开这个空间" (manage → settings). Backend is idempotent (see public-listing-service.mjs), so
// a slow double-click just replays the same no-op — no client-side de-dupe needed beyond disabling
// the button while the request is in flight.
async function requestPublicListing(trigger) {
  trigger.disabled = true;
  try {
    await api.requestPublicListing(trigger.dataset.spaceId);
    toast("已提交公开申请，等待人工审核。", "success");
    await render({ preserveFocus: true });
  } catch (error) {
    trigger.disabled = false;
    toast(error.message || "申请失败，请重试。", "error");
  }
}

// A: "上传自动通过" owner toggle (manage → settings). Same idempotent-transition
// shape as COLLECTION.PAUSE/RESUME and SHARING.ENABLE/DISABLE, but the endpoint
// sits outside the frozen action registry (see templates.js's
// autoApproveUploadsSetting()), so it goes through this bespoke handler +
// HttpApiAdapter#updateAutoApproveUploads() instead of perform()/api.act().
async function toggleAutoApproveUploads(trigger) {
  trigger.disabled = true;
  try {
    await api.updateAutoApproveUploads(trigger.dataset.spaceId, trigger.dataset.to, trigger.dataset.ifMatch);
    toast(trigger.dataset.to === "on" ? "已开启上传自动通过。" : "已关闭上传自动通过。", "success");
    await render({ preserveFocus: true });
  } catch (error) {
    trigger.disabled = false;
    toast(error.message || "设置失败，请重试。", "error");
  }
}

// 缺口一键发布心愿 (host-panel worktree, priority 4): zero schema change — the wish
// wall is still just spaces.wishes_json's string array, so a gap button click drafts
// one direction-aware wish string and appends it through the exact same
// updateSpaceWishes()/PATCH-wishes mutation the wishEditor() form in templates.js
// already uses (same ifMatch concurrency guard, same bespoke-outside-the-action-
// registry precedent as toggleAutoApproveUploads/requestPublicListing above). A full
// wish wall (6/6) has no slot left to draft into, so this just reports that instead
// of silently dropping the newest direction off the end.
async function publishGapWish(trigger) {
  trigger.disabled = true;
  const spaceId = trigger.dataset.spaceId;
  const degrees = trigger.dataset.degrees;
  const existing = wishList(routeModel.management?.wishes);
  if (existing.length >= wishWallCopy.maxWishes) {
    trigger.disabled = false;
    toast("心愿墙已经满了，先在心愿墙里清出一个位置。", "error");
    return;
  }
  const wish = `求一张朝 ${degrees}° 方向拍的照片`.slice(0, wishWallCopy.maxWishLength);
  try {
    await api.updateSpaceWishes(spaceId, [...existing, wish], trigger.dataset.ifMatch);
    toast("已经发布成心愿，宾客上传时会看到。", "success");
    await render({ preserveFocus: true });
  } catch (error) {
    trigger.disabled = false;
    toast(error.message || "发布失败，请重试。", "error");
  }
}

// Only a same-origin, query-free, single-leading-slash relative path is accepted;
// anything else (protocol-relative "//host", absolute URLs, unexpected shapes)
// falls back to `fallback` so /login?returnTo=... can never become an open redirect.
function safeReturnTarget(value, fallback) {
  return value && /^\/[A-Za-z0-9_\-\/]*$/.test(value) ? value : fallback;
}

function datasetPayload(element) {
  return Object.fromEntries(Object.entries(element.dataset).filter(([key]) => !["action", "actionId", "confirmAction", "needsReauth", "reauthRequested"].includes(key)).map(([key, value]) => [key, value]));
}

function datasetAttributes(payload = {}) {
  return Object.entries(payload).filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => `data-${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}="${esc(value)}"`).join(" ");
}

function openConfirm(element) {
  const actionId = element.dataset.confirmAction;
  const message = actionCopy(actionId, "destructive_confirm") || "请确认是否继续。";
  const title = actionCopy(actionId, "initial");
  const needsReauth = reauthActions.has(actionId);
  openDialog(dialogTemplate({ title, body: `<form class="stack" data-dialog-form><p>${esc(message)}</p>${needsReauth ? '<p class="fine">继续后，我们会向你的验证邮箱发送一次性验证码。</p>' : ""}</form>`, actionId, confirmLabel: title, danger: true, attributes: `${needsReauth ? 'data-needs-reauth="1"' : ""} ${datasetAttributes(datasetPayload(element))}` }));
}

async function confirmDialogAction(element) {
  const actionId = element.dataset.actionId;
  const root = document.querySelector("[data-dialog-root]");
  let payload = datasetPayload(element);
  const form = root.querySelector("form");
  if (form) {
    if (!form.reportValidity()) { focusFirstInvalid(form); return; }
    const values = new FormData(form);
    payload = { ...payload, ...Object.fromEntries(values), tasks: values.getAll("tasks"), managementScopes: values.getAll("managementScopes") };
  }
  if (actionId === "BATCH_BINDING.REQUEST_CODE") {
    const requested = await perform(actionId, payload, { navigateResult: false, rerender: false });
    if (!requested) return;
    replaceDialog(bindingConfirmDialog(payload.batchId, payload.email));
    return;
  }
  if (element.dataset.needsReauth === "1" && element.dataset.reauthRequested !== "1") {
    const target = reauthTarget(actionId, payload);
    const request = await perform("AUTH.REAUTH_REQUEST_CODE", { actionId, ...target }, { navigateResult: false, rerender: false });
    if (!request) return;
    replaceDialog(reauthCodeDialog(actionId, payload));
    return;
  }
  if (element.dataset.needsReauth === "1") {
    const target = reauthTarget(actionId, payload);
    const verified = await perform("AUTH.REAUTHENTICATE", { actionId, code: payload.reauthCode, ...target }, { navigateResult: false, rerender: false });
    if (!verified) return;
    delete payload.reauthCode;
  }
  closeDialog();
  const result = await perform(actionId, payload, { navigateResult: false });
  if (!result) return;
  if (actionId === "EXTERNAL_INVITATION.CREATE") {
    toast("活动邀请已创建，可复制或显示二维码。", "success");
    const campaignPath = result.publicCampaignUrl || result.qrPayload;
    if (campaignPath) await openQrDialog(campaignPath);
  }
  if (actionId === "MEMBER_INVITATION.CREATE") {
    const url = result.inviteUrl;
    openDialog(dialogTemplate({ title: "成员邀请已创建", body: `<p>这条一次性链接只显示这一次。请直接交给指定成员。</p><p class="campaign-link fine">${esc(location.origin + url)}</p><button class="button" type="button" data-copy-member data-url="${esc(url)}">复制成员邀请链接</button>` }));
  }
  if (actionId === "REPORT.SUBMIT") await navigate(`/reports/${result.id}`);
  if (actionId === "APPEAL.SUBMIT") await navigate(`/appeals/${result.id}`);
}

function reauthTarget(actionId, payload) {
  if (actionId === "OWNER_TRANSFER.ACCEPT") return { targetType: "owner_transfer", targetId: payload.transferId };
  if (["SPACE.ARCHIVE", "SPACE.RESTORE", "SPACE.DELETE_REQUEST", "OWNER_TRANSFER.CREATE"].includes(actionId)) return { targetType: "space", targetId: payload.spaceId || state.currentSpaceId, spaceId: payload.spaceId || state.currentSpaceId };
  if (actionId === "BATCH.DELETE_ITEM") {
    const photoId = payload.photoId || routeModel.batchItem?.photoId;
    return { targetType: "photo", targetId: photoId, photoId, spaceId: state.currentSpaceId };
  }
  return { targetType: "account", targetId: state.account?.id || "current" };
}

function openContentDialog(actionId, photoId, ifMatch) {
  const allowed = actionRegistry.contentTransitionContracts[actionId].allowedDecisionReasonCodes;
  const options = allowed.map((reason) => `<option value="${esc(reason)}">${esc(strings.decisionReasonLabels[`decisionReason.${reason}`])}</option>`).join("");
  openDialog(dialogTemplate({ title: actionCopy(actionId), body: `<form class="stack" data-dialog-form><div class="field"><label for="decision">处理原因</label><select id="decision" name="decisionReasonCode" required><option value="">请选择</option>${options}</select></div><div class="field"><label for="decision-note">补充说明</label><textarea id="decision-note" name="note" maxlength="1000"></textarea><span class="fine">选择“其他”时必须填写。</span></div></form>`, actionId, confirmLabel: actionCopy(actionId), danger: actionId === "CONTENT.REJECT", attributes: `data-photo-id="${esc(photoId)}" data-if-match="${esc(ifMatch || "")}"` }));
}

function openCampaignDialog() {
  openDialog(dialogTemplate({ title: "创建活动邀请", body: `<form class="stack" data-dialog-form><div class="field"><label for="task-mode">允许做什么</label><select id="task-mode" name="taskMode"><option value="combo">查看与上传</option><option value="view">查看照片</option><option value="upload">上传照片</option></select></div><div class="field"><label for="entry-task">打开后先去哪里</label><select id="entry-task" name="entryTask"><option value="view">先看照片</option><option value="upload">先上传照片</option></select></div><div class="field"><label for="campaign-cap">最多成功进入次数</label><input id="campaign-cap" name="maxSuccessfulUses" type="number" min="1" max="1000" value="100" required></div><div class="field"><label for="campaign-expiry">到期日期</label><input id="campaign-expiry" name="expiresAt" type="date" value="2026-09-13" required></div></form>`, actionId: "EXTERNAL_INVITATION.CREATE", confirmLabel: "创建活动邀请" }));
}

function openMemberInviteDialog() {
  openDialog(dialogTemplate({ title: "创建成员邀请", body: `<form class="stack" data-dialog-form><div class="field"><label for="member-email">对方已验证的邮箱</label><input id="member-email" name="email" type="email" required></div><fieldset class="field"><legend class="field-label">任务</legend><label class="check-row"><input type="checkbox" name="tasks" value="view" checked><span>查看空间</span></label><label class="check-row"><input type="checkbox" name="tasks" value="upload"><span>上传照片</span></label></fieldset><fieldset class="field"><legend class="field-label">管理权限</legend><label class="check-row"><input type="checkbox" name="managementScopes" value="canReview"><span>审核照片</span></label><label class="check-row"><input type="checkbox" name="managementScopes" value="canEditPlacement"><span>调整位置</span></label></fieldset></form>`, actionId: "MEMBER_INVITATION.CREATE", confirmLabel: "创建成员邀请" }));
}

function openMemberDialog(memberId) {
  const member = state.memberships.find((entry) => entry.id === memberId);
  openDialog(dialogTemplate({ title: `编辑${member.name}的权限`, body: `<form class="stack" data-dialog-form><fieldset class="field"><legend class="field-label">任务</legend>${["view", "upload"].map((task) => `<label class="check-row"><input type="checkbox" name="tasks" value="${task}" ${member.tasks.includes(task) ? "checked" : ""}><span>${task === "view" ? "查看空间" : "上传照片"}</span></label>`).join("")}</fieldset><fieldset class="field"><legend class="field-label">管理权限</legend>${[["canReview","审核照片"],["canEditPlacement","调整位置"],["canManageScene","管理现场"],["canInvite","活动邀请"],["canPublish","受邀查看开关"]].map(([scope,label]) => `<label class="check-row"><input type="checkbox" name="managementScopes" value="${scope}" ${member.managementScopes.includes(scope) ? "checked" : ""}><span>${label}</span></label>`).join("")}</fieldset></form>`, actionId: "MEMBERSHIP.UPDATE", confirmLabel: "保存成员权限", attributes: `data-membership-id="${esc(memberId)}"` }));
}

function openBindingDialog(batchId) {
  openDialog(dialogTemplate({ title: "绑定恢复邮箱", body: `<form class="stack" data-dialog-form><div class="field"><label for="binding-email">验证邮箱</label><input id="binding-email" name="email" type="email" value="${debugMode ? "max@example.com" : ""}" autocomplete="email" required></div><p class="fine">我们会先发送验证码。完成验证后，才会绑定这批照片。</p></form>`, actionId: "BATCH_BINDING.REQUEST_CODE", confirmLabel: "获取验证码", attributes: `data-batch-id="${esc(batchId)}"` }));
}

function bindingConfirmDialog(batchId, email) {
  return dialogTemplate({ title: "输入验证码", body: `<form class="stack" data-dialog-form><p class="fine">验证码已发送至 ${esc(email)}。验证码过期时，请取消后重新发送。</p><div class="field"><label for="binding-code">验证码</label><input id="binding-code" name="code" inputmode="numeric" autocomplete="one-time-code" ${debugMode ? 'value="246810"' : ""} pattern="[0-9]{6}" maxlength="6" required><span class="fine">${debugMode ? "调试验证码：246810" : "请输入邮件中的 6 位验证码。"}</span></div><input type="hidden" name="noticeAcknowledgement" value="${esc(routeModel.batchReceipt?.bindingNoticeAcknowledgement || "")}"></form>`, actionId: "BATCH_BINDING.CONFIRM", confirmLabel: "绑定恢复邮箱", attributes: datasetAttributes({ batchId, email }) });
}

function reauthCodeDialog(actionId, payload) {
  const title = actionCopy(actionId, "initial");
  return dialogTemplate({ title: "再次验证身份", body: `<form class="stack" data-dialog-form><p class="fine">验证码已发送到你的验证邮箱，仅用于“${esc(title)}”。</p><div class="field"><label for="reauth-code">验证码</label><input id="reauth-code" name="reauthCode" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6"${debugMode ? ' value="246810"' : ""} required><span class="fine">${debugMode ? "调试验证码：246810" : "请输入邮件中的 6 位验证码。"}</span></div></form>`, actionId, confirmLabel: title, danger: true, attributes: `data-needs-reauth="1" data-reauth-requested="1" ${datasetAttributes(payload)}` });
}

// B19 (UI v4 audit): 举报 now lives behind the photo page's "⋯" overflow menu
// (openPhotoMenuDialog below) instead of sitting directly under the primary
// CTA. This dialog itself — fields, action id REPORT.SUBMIT, confirm flow —
// is unchanged; only how you get to it changed. When it's opened from inside
// the still-open overflow menu, swap the dialog root's content in place
// (replaceDialog) instead of reopening it (openDialog) so focus returns to
// the original "⋯" trigger on close, the same chaining idiom already used
// for e.g. the binding-email → binding-code dialog handoff.
function openReportDialog(photoId) {
  const html = dialogTemplate({ title: "举报这张照片", body: `<form class="stack" data-dialog-form><div class="field"><label for="report-category">问题类型</label><select id="report-category" name="category" required><option value="">请选择</option><option value="privacy">隐私问题</option><option value="rights">权利问题</option><option value="safety">安全问题</option><option value="other">其他</option></select></div><div class="field"><label for="report-description">情况说明</label><textarea id="report-description" name="description" maxlength="2000" required></textarea></div><p class="fine">举报不接受附件，提交后会得到一个独立案件编号。</p></form>`, actionId: "REPORT.SUBMIT", confirmLabel: "提交举报", attributes: `data-photo-id="${esc(photoId)}"` });
  if (document.querySelector("[data-dialog-root] [role=dialog]")) replaceDialog(html);
  else openDialog(html);
}

// B19: the overflow menu itself reuses the same dialogTemplate/openDialog
// machinery as every other menu-shaped surface in this app (there is no
// separate anchored-dropdown component) — that's what gives it Tab-trapped
// focus and Escape-to-close for free via the existing keydown/trapDialogFocus
// handlers, with no bespoke menu widget to build or test. Plain buttons
// (not role="menu"/"menuitem") on purpose: this app doesn't implement the
// arrow-key navigation that ARIA menu semantics would promise.
function openPhotoMenuDialog(photoId) {
  openDialog(dialogTemplate({ title: "更多操作", body: `<div class="menu-list"><button class="menu-item" type="button" data-open-report data-photo-id="${esc(photoId)}">举报这张照片</button></div>` }));
}

function openAppealDialog(batchId, itemId) {
  openDialog(dialogTemplate({ title: "提交审核异议", body: `<form class="stack" data-dialog-form><div class="field"><label for="appeal-description">请说明你认为需要复核的原因</label><textarea id="appeal-description" name="description" maxlength="2000" required></textarea></div><p class="fine">提交后会生成独立进度编号，不会自动改变当前审核结果。</p></form>`, actionId: "APPEAL.SUBMIT", confirmLabel: "提交异议", attributes: `data-batch-id="${esc(batchId)}" data-item-id="${esc(itemId)}"` }));
}

async function downloadExport(result, exportId) {
  if (result.downloadUrl) {
    const url = new URL(result.downloadUrl, location.origin);
    if (url.origin !== location.origin) throw new Error("导出地址必须与当前站点同源。");
    location.assign(url.href);
    return;
  }
  if (!fixtureMode) return;
  const blob = new Blob([JSON.stringify({ exportId, generatedAt: new Date().toISOString(), fixture: true }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${exportId || "unseen-export"}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function openOwnerTransferDialog() {
  openDialog(dialogTemplate({ title: "发起主人转移", body: `<form class="stack" data-dialog-form><div class="field"><label for="transfer-member">选择现有成员</label><select id="transfer-member" name="targetMembershipId" required>${state.memberships.filter((member) => member.status === "active").map((member) => `<option value="${esc(member.id)}">${esc(member.name)}</option>`).join("")}</select></div><p>转移不会生成链接。对方只能在指定账号的“我的空间”中接受。继续后需要再次验证身份。</p></form>`, actionId: "OWNER_TRANSFER.CREATE", confirmLabel: "继续验证", attributes: 'data-needs-reauth="1"' }));
}

async function copyCampaignUrl(path) {
  const url = new URL(path, location.origin);
  if (url.search || url.hash || !url.pathname.startsWith("/open/")) { toast("活动链接不可用。", "error"); return; }
  try { await navigator.clipboard.writeText(url.href); await api.act("INVITATION.COPY_LINK", { caller: "activity" }); toast(strings.callerStrings["INVITATION.COPY_LINK"].activity.success, "success"); }
  catch { toast(strings.callerStrings["INVITATION.COPY_LINK"].activity.stable_error, "error"); }
}

async function copyMemberUrl(path) {
  if (!/^\/member-invitations\/accept#invite=[A-Za-z0-9_-]+$/.test(path)) { toast(strings.callerStrings["INVITATION.COPY_LINK"].member.empty, "error"); return; }
  try {
    await navigator.clipboard.writeText(new URL(path, location.origin).href);
    await api.act("INVITATION.COPY_LINK", { caller: "member" });
    toast(strings.callerStrings["INVITATION.COPY_LINK"].member.success, "success");
  } catch {
    toast(strings.callerStrings["INVITATION.COPY_LINK"].member.stable_error, "error");
  }
}

// Block 5 (UI v4 spec "块5"): "恢复凭据区独立卡...配「复制」按钮——只做
// clipboard 写入，无新 action 语义". Unlike copyCampaignUrl/copyMemberUrl
// above, this deliberately does NOT call api.act(...) — CLIPBOARD_WRITE only
// exists in the action registry as INVITATION.COPY_LINK's own transport
// method, and that action's authorization is exact to activity/member
// invitation links, not a batch receipt code. Reusing it here would claim
// semantics that don't apply, so this stays a plain client-side clipboard
// write with no action ID attached.
async function copyReceiptCode(value) {
  if (!value) { toast("回执编号不可用。", "error"); return; }
  try { await navigator.clipboard.writeText(value); toast("回执编号已复制。", "success"); }
  catch { toast("复制失败，请手动选择文字复制。", "error"); }
}

async function startQrScanner() {
  await api.act("INVITATION.SCAN_AGAIN", {}).catch(() => {});
  openDialog(dialogTemplate({ title: "扫描活动二维码", body: `<div class="stack"><video class="qr-video" data-qr-video autoplay muted playsinline aria-label="二维码取景框"></video><p class="fine" data-scan-status>将活动二维码放入取景框。</p>${debugMode ? '<a class="button" href="/open/gongguang-2026?fixture=1&debug=1" data-nav>识别本地验收邀请</a>' : ""}</div>` }));
  if (!navigator.mediaDevices?.getUserMedia || !("BarcodeDetector" in globalThis)) {
    document.querySelector("[data-scan-status]").textContent = "这个浏览器暂时不能扫描二维码，请粘贴活动链接。";
    return;
  }
  try {
    activeCameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    const video = document.querySelector("[data-qr-video]");
    video.srcObject = activeCameraStream;
    const detector = new BarcodeDetector({ formats: ["qr_code"] });
    const scan = async () => {
      if (!activeCameraStream || !video.isConnected) return;
      if (video.readyState >= 2) {
        const codes = await detector.detect(video).catch(() => []);
        const value = codes[0]?.rawValue;
        if (value) {
          const found = new URL(value, location.origin);
          if (found.origin === location.origin && /^\/open\/[A-Za-z0-9_-]+$/.test(found.pathname) && !found.search && !found.hash) {
            closeDialog();
            await navigate(found.pathname);
            return;
          }
        }
      }
      requestAnimationFrame(scan);
    };
    requestAnimationFrame(scan);
  } catch {
    document.querySelector("[data-scan-status]").textContent = actionCopy("INVITATION.SCAN_AGAIN", "stable_error");
  }
}

async function openQrDialog(path) {
  const url = new URL(path, location.origin);
  if (url.search || url.hash || !url.pathname.startsWith("/open/")) { toast(actionCopy("INVITATION.SHOW_QR", "stable_error"), "error"); return; }
  openDialog(dialogTemplate({ title: "活动二维码", body: `<div class="qr-wrap"><canvas class="qr-canvas" width="320" height="320" data-qr-canvas aria-label="活动邀请二维码"></canvas></div><p class="campaign-link fine">${esc(url.href)}</p><div class="cluster"><button class="button" type="button" data-copy-campaign data-url="${esc(url.pathname)}">复制活动链接</button></div><p class="fine">二维码只包含可分享的活动链接，不包含任何一次性访问凭据。</p>` }));
  try { await api.act("INVITATION.SHOW_QR", { qrPayload: url.pathname }); renderQr(document.querySelector("[data-qr-canvas]"), url.href); announce(actionCopy("INVITATION.SHOW_QR", "success")); }
  catch { closeDialog(); toast(actionCopy("INVITATION.SHOW_QR", "stable_error"), "error"); }
}

function openDialog(html) {
  lastFocus = document.activeElement;
  const root = document.querySelector("[data-dialog-root]");
  app.inert = true;
  root.innerHTML = html;
  root.querySelector("button, input, select, textarea")?.focus();
}

function replaceDialog(html) {
  const root = document.querySelector("[data-dialog-root]");
  root.innerHTML = html;
  root.querySelector("input, select, textarea, button")?.focus();
}

function closeDialog() {
  activeCameraStream?.getTracks().forEach((track) => track.stop());
  activeCameraStream = null;
  const root = document.querySelector("[data-dialog-root]");
  if (root) root.innerHTML = "";
  app.inert = false;
  lastFocus?.focus?.();
  lastFocus = null;
}

function trapDialogFocus(event) {
  const dialog = document.querySelector("[role=dialog]");
  if (!dialog) return;
  const focusable = [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]')];
  if (!focusable.length) return;
  const first = focusable[0], last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

function focusFirstInvalid(form) {
  const invalid = form.querySelector(":invalid");
  invalid?.setAttribute("aria-invalid", "true");
  invalid?.focus();
  announce("请检查标出的内容。");
}

function announce(message) {
  announcer.textContent = "";
  requestAnimationFrame(() => { announcer.textContent = message || ""; });
}

function beginPanoramaOperation(spaceId) {
  cancelPanoramaOperation();
  const operation = { spaceId, route: location.pathname + location.search, controller: new AbortController() };
  activePanoramaOperation = operation;
  return operation;
}

function cancelPanoramaOperation() {
  activePanoramaOperation?.controller.abort();
  activePanoramaOperation = null;
}

function isCurrentPanoramaOperation(operation) {
  return activePanoramaOperation === operation && !operation.controller.signal.aborted && state.currentSpaceId === operation.spaceId && location.pathname + location.search === operation.route;
}

async function watchPanoramaCandidate(operation, uploaded) {
  try {
    const result = await pollPanoramaCandidate({
      spaceId: operation.spaceId,
      candidateId: uploaded.candidateId,
      signal: operation.controller.signal,
      isCurrent: () => isCurrentPanoramaOperation(operation),
      readStatus: async ({ spaceId, candidateId, signal }) => {
        const candidate = await panoramaWorkflow.status({ spaceId, candidateId, signal });
        if (candidate.status !== "ready") return candidate;
        const management = await api.read("managementView", { spaceId });
        const projected = (management.panoramaCandidates || []).find((item) => (item.candidateId || item.id) === candidateId && item.status === "ready");
        return projected ? { ...candidate, management } : { ...candidate, status: "validating" };
      }
    });
    if (!isCurrentPanoramaOperation(operation) || result.outcome === "cancelled") return;
    activePanoramaOperation = null;
    if (result.outcome === "ready") {
      routeModel.management = result.candidate.management;
      const content = document.querySelector(".manage-content");
      if (content) content.innerHTML = sceneManagementContent(state, routeModel.management);
      showPanoramaStatus("现场文件检查通过，可以切换到这个现场。", "success");
      announce("现场文件检查通过，可以切换了。");
      toast("现场文件检查通过，可以切换了。", "success");
    } else if (result.outcome === "failed") {
      showPanoramaStatus("现场文件检查未通过。请重新选择文件上传，或刷新页面查看详情。", "error");
      announce("现场文件检查未通过，请重新选择文件上传。");
    } else {
      showPanoramaStatus("现场文件仍在检查中。请稍后刷新本页，或重新上传。", "warning");
      announce("现场文件仍在检查中，请稍后刷新本页。");
    }
  } catch (error) {
    if (!isCurrentPanoramaOperation(operation)) return;
    activePanoramaOperation = null;
    showPanoramaStatus(error.message || "无法继续读取现场文件状态。请刷新页面后重试。", "error");
    announce("无法继续读取现场文件状态，请刷新页面后重试。");
  }
}

function showPanoramaStatus(message, status = "progress") {
  const field = document.querySelector("[data-panorama-file]")?.closest(".field");
  if (!field) return;
  let output = field.querySelector("[data-panorama-status]");
  if (!output) {
    output = document.createElement("p");
    output.dataset.panoramaStatus = "";
    output.className = "fine";
    output.setAttribute("role", "status");
    field.append(output);
  }
  output.dataset.status = status;
  output.textContent = message;
}

function toast(message, type = "success") {
  if (!message) return;
  const region = document.querySelector("[data-toast-region]");
  if (!region) return;
  const item = document.createElement("div");
  item.className = `toast toast-${type}`;
  item.textContent = message;
  region.replaceChildren(item);
  setTimeout(() => item.remove(), 4200);
}

await render();
