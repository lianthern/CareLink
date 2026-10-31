import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createVisualChallenge, POW_ALGORITHM } from "../../services/api/src/ports/captcha/pow-captcha-port.mjs";

const jsonHeaders = { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" };
const json = (response, status, value, extraHeaders = {}) => { response.writeHead(status, { ...jsonHeaders, ...extraHeaders }); response.end(JSON.stringify(value)); };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
// host-panel worktree ("缺口"方向格): same 12 x 30° yaw-bucket math as
// SpaceService#missingDirectionBuckets() (services/api/src/space-service.mjs) and
// its apps/web/src/api/fixture-adapter.js mirror — this file is this dev server's
// own separate local contract API (see server.mjs), so it gets its own copy too.
const missingDirectionBuckets = (yaws) => {
  const covered = new Set(yaws.filter((yaw) => typeof yaw === "number" && Number.isFinite(yaw))
    .map((yaw) => Math.floor((((yaw % 360) + 360) % 360) / 30)));
  return Array.from({ length: 12 }, (_, bucket) => bucket).filter((bucket) => !covered.has(bucket));
};
const activeSessionCookie = "unseen_session=active; Path=/; HttpOnly; SameSite=Strict";
const clearedSessionCookie = "unseen_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0";
const mediaNoticeHash = "fe33ba9d5e927dffa281706d6e826d4dd06b26d3ccfca19b3eaba97f340287b0";
const mediaNoticePolicy = Object.freeze({ acceptedFormats: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"], maxBytes: 20 * 1024 * 1024, metadataPolicy: "strip-sensitive-retain-trusted-capture-time", retainedMetadata: ["timezone-qualified-original-capture-time"], retainedPurposes: ["photo_time", "memory_provenance", "book_provenance"], discardedMetadata: ["gps", "device_serial"], releaseBlockers: ["legal_approval_capture_time_retention"] });
const body = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  return bytes.length ? JSON.parse(bytes.toString("utf8")) : {};
};

function testVisualChallenge() {
  const star = "M50 12 60 37 87 38 66 55 73 82 50 67 27 82 34 55 13 38 40 37Z";
  const square = "M18 18H82V82H18Z";
  const answer = [1, 5];
  const tiles = Array.from({ length: 9 }, (_, index) => ({
    path: answer.includes(index) ? star : square,
    fill: index % 2 ? "#426f8d" : "#b94f72",
    rotate: index - 4,
    dots: [[12 + index, 18, 2], [78, 71 - index, 1]]
  }));
  return { prompt: "请选择所有星形", tiles, answer };
}

export async function createLocalContractApi(root, { test = false } = {}) {
  const photoPaths = Array.from({ length: 6 }, (_, index) => join(root, `assets/photos/photo-${index + 1}.jpg`));
  const photoBytes = await Promise.all(photoPaths.map((path) => readFile(path)));
  const photoHashes = photoBytes.map(hash);
  const panoramaBytes = await readFile(join(root, "assets/panorama/pano.jpg"));
  const panoramaHash = hash(panoramaBytes);
  let state;
  const allRequests = [];
  const reset = () => {
    state = {
      loggedIn: false,
      external: false,
      loginChallenge: null,
      loginVerification: null,
      bindingChallenge: null,
      reauthChallenges: new Map(),
      reauthGrants: new Map(),
      uploads: new Map(),
      panoramaUploads: new Map(),
      panoramaCandidates: new Map(),
      batches: new Map(),
      receiptBatchId: null,
      consentAcceptedAt: null,
      reviewVisible: false,
      memberships: [{ id: "member-1", name: "周宁", emailMask: "z***@example.com", tasks: ["view"], managementScopes: ["canReview"], status: "active", version: 1, ifMatch: '"member-v1"' }],
      memberInvitations: [],
      pendingOwnerTransfers: [],
      requests: [],
      nextFailure: null,
      tamperedPhotos: new Set(),
      mediaEtagMismatch: null,
      sceneIdentityDrift: false,
      mediaNoticeVariant: "current",
      photos: Array.from({ length: 6 }, (_, index) => ({
        id: `photo-${index + 1}`,
        spaceId: "space-gongguang",
        title: ["烛光亮起时", "窗边的朋友", "大家都在笑", "回头的一刻", "厅里的灯光", "不在本次现场"][index],
        asset: `/__media/photo-${index + 1}`,
        assetUrl: `/__media/photo-${index + 1}`,
        photoUrl: `/__media/photo-${index + 1}`,
        photoAssetId: `asset-photo-${index + 1}`,
        photoAssetVersion: 1,
        photoRawSha256: photoHashes[index],
        contentState: index === 3 ? "pending" : "visible",
        placementState: index === 3 ? "needs_confirmation" : index === 5 ? "outside_scene" : "confirmed",
        confirmationMode: index === 1 || index === 4 ? "manual" : "auto",
        yawDeg: [-58, -18, 24, 62, 92, 0][index],
        pitchDeg: 0,
        uploader: ["林野", "林野", "沈舟", "夏宁", "夏宁", "陆遥"][index],
        uploaderCanEdit: true,
        canEdit: true,
        version: 2,
        ifMatch: `"photo-${index + 1}-v2"`,
        placementRevisionId: `placement-photo-${index + 1}-v2`
      }))
    };
  };
  reset();

  const scene = () => ({ readiness: "ready", mode: "rotation360", artifactReady: true, version: 2, panoramaRevisionId: "pano-revision-2" });
  const space = () => ({ id: "space-gongguang", name: "向晚婚礼", dateLabel: "2026 年 7 月 25 日", ownerAccountId: "account-max", spaceLifecycle: "active", collectionState: "open", sharingState: "shared", autoApproveUploads: false, scene: scene(), version: 7, ifMatch: '"space-gongguang-v7"', photoCount: 6, effectiveCanView: true, effectiveCanUpload: true, isOwner: state.loggedIn });
  const mediaBytesForPhoto = (photo) => photo?.uploadSessionId
    ? state.uploads.get(photo.uploadSessionId)?.bytes
    : photoBytes[Number(photo?.id?.split("-").at(-1)) - 1];
  const sceneContext = (photoId) => {
    const target = state.photos.find((photo) => photo.id === photoId);
    if (!target || target.contentState !== "visible" || target.placementState !== "confirmed") return null;
    return {
      photoId: target.id,
      photoAssetId: target.photoAssetId,
      photoAssetVersion: target.photoAssetVersion + (state.sceneIdentityDrift ? 1 : 0),
      photoRawSha256: target.photoRawSha256,
      sceneReadiness: "ready",
      sceneMode: "rotation360",
      scene: { sceneId: "scene-gongguang", panoramaRevisionId: "pano-revision-2" },
      panorama: { url: "/v1/viewer/spaces/space-gongguang/panorama-revisions/pano-revision-2/media", revisionId: "pano-revision-2", assetId: "asset-pano-2", assetVersion: 2, sha256: panoramaHash, bytes: panoramaBytes.length, contentType: "image/jpeg" },
      photoMedia: { url: `/v1/viewer/spaces/space-gongguang/photos/${target.id}/media`, assetId: `viewer-safe-${target.id}`, assetVersion: 1, sha256: target.photoRawSha256, bytes: mediaBytesForPhoto(target)?.length || 1, contentType: "image/jpeg" },
      placement: { revisionId: target.placementRevisionId, status: "confirmed", confirmationMode: target.confirmationMode, yawDeg: target.yawDeg, pitchDeg: target.pitchDeg, fovDeg: 75, placementSeq: 2, photoVersion: target.version }
    };
  };
  const viewerSpace = () => ({ ...space(), effectiveCanManage: state.loggedIn, photos: state.photos.filter((photo) => photo.contentState === "visible"), sceneContext: sceneContext("photo-1") });
  const batchDto = (batch) => ({ ...batch, items: batch.items, itemsDigest: `digest-${batch.id}-v${batch.version}`, ifMatch: `"space:7;batch:${batch.version};items:${batch.items.map((item) => `${item.id}:${item.version}`).join("|")}"` });
  const management = () => {
    const confirmedPhotos = state.photos.filter((photo) => photo.placementState === "confirmed");
    return { space: space(), isOwner: true, effectiveCanView: true, effectiveCanUpload: true, scopes: ["canReview", "canEditPlacement", "canManageScene", "canInvite", "canPublish"], reviewQueue: state.photos.filter((photo) => ["pending", "hidden", "rejected"].includes(photo.contentState)), placementQueue: state.photos.filter((photo) => ["needs_confirmation", "stale", "failed"].includes(photo.placementState)),
      // host-panel worktree ("待你确认" + "缺口"方向格): mirrors the additive fields
      // SpaceService#management() now returns — see missingDirectionBuckets() above.
      confirmedPlacementCount: confirmedPhotos.length, missingDirections: missingDirectionBuckets(confirmedPhotos.map((photo) => photo.yawDeg)),
      campaigns: [{ id: "campaign-gongguang", publicCampaignId: "gongguang-2026", publicCampaignUrl: "/open/gongguang-2026", qrPayload: "/open/gongguang-2026", taskMode: "combo", entryTask: "view", campaignStatus: "active", successfulUseCount: 8, maxSuccessfulUses: 120, version: 2, ifMatch: '"campaign-v2"' }], memberships: state.memberships, memberInvitations: state.memberInvitations, panoramaCandidates: [...state.panoramaCandidates.values()].filter((candidate) => candidate.status === "ready"), panoramaNoticeAcknowledgement: "panorama:v1:approved", audit: [] };
  };
  const uploadContext = () => {
    // Browser-only destructive-focus harness; production API shape has no activeBatchId.
    const activeBatchId = test ? [...state.batches.values()].find((batch) => batch.status === "open")?.id : null;
    const current = { spaceId: "space-gongguang", effectiveCanUpload: true, limits: { batchItems: 50, photoBytes: 20 * 1024 * 1024 }, formats: [...mediaNoticePolicy.acceptedFormats], mediaNotice: { id: "media_photo_upload_v2", version: 2, hash: mediaNoticeHash, policy: structuredClone(mediaNoticePolicy) }, currentConsent: state.consentEventId ? { consentEventId: state.consentEventId, acceptedAt: state.consentAcceptedAt } : null, canCreateBatch: Boolean(state.consentEventId), ...(activeBatchId ? { activeBatchId } : {}) };
    if (state.mediaNoticeVariant === "old") return { ...current, mediaNotice: { ...current.mediaNotice, version: 1 } };
    if (state.mediaNoticeVariant === "old-hash") return { ...current, mediaNotice: { ...current.mediaNotice, hash: "80c532299ff366d3f79d8a418249080afd157aa5c1418a40be9ebdee760d0ef1" } };
    if (state.mediaNoticeVariant === "wrong-hash") return { ...current, mediaNotice: { ...current.mediaNotice, hash: "0".repeat(64) } };
    if (state.mediaNoticeVariant === "wrong-policy") return { ...current, mediaNotice: { ...current.mediaNotice, policy: { ...current.mediaNotice.policy, metadataPolicy: "keep-all" } } };
    if (state.mediaNoticeVariant === "wrong-consent") return { ...current, currentConsent: { consentEventId: "", acceptedAt: "not-a-time" }, canCreateBatch: true };
    if (state.mediaNoticeVariant === "top-level") return { spaceId: current.spaceId, noticeVersion: 2, noticeHash: mediaNoticeHash, mediaPolicyVersion: "2", consentEventId: null, effectiveCanUpload: true };
    if (state.mediaNoticeVariant === "malformed") return { ...current, mediaNotice: { ...current.mediaNotice, policy: '2"><script>bad()</script>' } };
    if (state.mediaNoticeVariant === "cross-space") return { ...current, spaceId: "space-other" };
    return current;
  };

  async function handle(request, response, url) {
    const path = url.pathname;
    if (test && path === "/__test/reset" && request.method === "POST") { reset(); return json(response, 200, { ok: true }, { "Set-Cookie": clearedSessionCookie }); }
    if (test && path === "/__test/session" && request.method === "POST") { const value = await body(request); state.loggedIn = Boolean(value.owner); state.external = Boolean(value.external); return json(response, 200, { ok: true, owner: state.loggedIn, external: state.external }, { "Set-Cookie": state.loggedIn || state.external ? activeSessionCookie : clearedSessionCookie }); }
    if (test && path === "/__test/requests" && request.method === "GET") return json(response, 200, { items: allRequests });
    if (test && path === "/__test/fail-next" && request.method === "POST") { const value = await body(request); state.nextFailure = { status: Number(value.status || 503), code: value.code || "network_unavailable" }; return json(response, 200, { ok: true }); }
    if (test && path === "/__test/tamper-photo" && request.method === "POST") { const value = await body(request); state.tamperedPhotos.add(value.photoId); return json(response, 200, { ok: true }); }
    if (test && path === "/__test/media-etag-mismatch" && request.method === "POST") { const value = await body(request); state.mediaEtagMismatch = value.kind || null; return json(response, 200, { ok: true }); }
    if (test && path === "/__test/scene-identity-drift" && request.method === "POST") { const value = await body(request); state.sceneIdentityDrift = Boolean(value.enabled); return json(response, 200, { ok: true }); }
    if (test && path === "/__test/media-notice" && request.method === "POST") { const value = await body(request); state.mediaNoticeVariant = value.variant || "current"; return json(response, 200, { ok: true }); }
    if (test && path === "/__test/focus-fixtures" && request.method === "POST") {
      state.loggedIn = true;
      state.external = true;
      state.consentEventId = "consent-focus-fixture";
      state.consentAcceptedAt = "2026-08-13T10:00:00+10:00";
      state.memberships = [{ id: "member-focus", name: "方遥", emailMask: "f***@example.com", tasks: ["view"], managementScopes: [], status: "active", version: 1, ifMatch: '"member-focus-v1"' }];
      const failedBatch = { id: "batch-focus", batchId: "batch-focus", status: "open", version: 1, items: [{ id: "batch-focus-item-1", itemId: "batch-focus-item-1", fileName: "待移除照片.jpg", status: "failed", failureCode: "file_too_large", failureVersion: 1, version: 1, ifMatch: '"batch-focus-item-1-v1"' }] };
      const deleteItem = { id: "batch-delete-item-1", itemId: "batch-delete-item-1", batchId: "batch-delete", fileName: "待删除照片.jpg", status: "committed", photoId: "photo-2", asset: "/__media/photo-2", assetUrl: "/__media/photo-2", photoUrl: "/__media/photo-2", photoAssetId: "asset-photo-2", photoAssetVersion: 1, photoRawSha256: photoHashes[1], placementRevisionId: "placement-photo-2-v2", yawDeg: -18, pitchDeg: 0, placementState: "confirmed", contentState: "visible", uploaderCanEdit: true, version: 2, ifMatch: '"batch-delete-item-1-v2"' };
      state.batches.set(failedBatch.id, failedBatch);
      state.batches.set("batch-delete", { id: "batch-delete", batchId: "batch-delete", status: "finalized", version: 2, items: [deleteItem] });
      state.receiptBatchId = "batch-delete";
      return json(response, 200, { ok: true }, { "Set-Cookie": activeSessionCookie });
    }
    if (!path.startsWith("/v1/") && !path.startsWith("/__uploads/") && !path.startsWith("/__panorama_uploads/") && !path.startsWith("/__media/")) return false;
    if (state.nextFailure) { const failure = state.nextFailure; state.nextFailure = null; return json(response, failure.status, { code: failure.code }); }
    const requestRecord = { method: request.method, path, headers: Object.fromEntries(Object.entries(request.headers).filter(([name]) => ["content-type", "idempotency-key", "if-match", "notice-acknowledgement", "x-upload-ticket"].includes(name))), cookiePresent: Boolean(request.headers.cookie?.includes("unseen_session=active")) };
    state.requests.push(requestRecord);
    allRequests.push(requestRecord);
    if (path.startsWith("/__uploads/") && request.method === "PUT") {
      const id = path.split("/").at(-1);
      if (request.headers["x-upload-ticket"] !== `ticket-${id}` || !state.uploads.has(id)) return json(response, 403, { code: "upload_ticket_invalid" });
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      state.uploads.get(id).bytes = Buffer.concat(chunks);
      requestRecord.bytes = state.uploads.get(id).bytes.length;
      requestRecord.sha256 = hash(state.uploads.get(id).bytes);
      response.writeHead(200, { ETag: `"etag-${id}"` }); response.end(); return true;
    }
    if (path.startsWith("/__panorama_uploads/") && request.method === "PUT") {
      const id = path.split("/").at(-1);
      if (request.headers["x-panorama-ticket"] !== `ticket-${id}` || !state.panoramaUploads.has(id)) return json(response, 403, { code: "upload_ticket_invalid" });
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      state.panoramaUploads.get(id).bytes = Buffer.concat(chunks);
      response.writeHead(200, { ETag: `"etag-${id}"` }); response.end(); return true;
    }
    if (path.startsWith("/__uploads/") && request.method === "GET") {
      const id = path.split("/").at(-1);
      const upload = state.uploads.get(id);
      if (!upload?.bytes) return json(response, 404, { code: "media_unavailable" });
      const photo = state.photos.find((item) => item.uploadSessionId === id);
      const value = photo && state.tamperedPhotos.has(photo.id) ? Buffer.from("tampered-photo-bytes") : upload.bytes;
      response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "image/jpeg", "Content-Length": String(value.length) }); response.end(value); return true;
    }
    if (path.startsWith("/__media/photo-") && request.method === "GET") {
      const photoId = path.split("/").at(-1);
      const index = Number(photoId.split("-").at(-1)) - 1;
      if (!photoBytes[index]) return json(response, 404, { code: "media_unavailable" });
      const value = state.tamperedPhotos.has(photoId) ? Buffer.from("tampered-photo-bytes") : photoBytes[index];
      response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "image/jpeg", "Content-Length": String(value.length) }); response.end(value); return true;
    }

    const hasSession = Boolean((state.loggedIn || state.external) && request.headers.cookie?.includes("unseen_session=active"));
    const panoramaMediaMatch = path.match(/^\/v1\/viewer\/spaces\/space-gongguang\/panorama-revisions\/([^/]+)\/media$/);
    if (request.method === "GET" && panoramaMediaMatch) {
      if (!hasSession || panoramaMediaMatch[1] !== "pano-revision-2") return json(response, 401, { code: "session_unavailable" });
      response.writeHead(200, {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store",
        "Content-Length": String(panoramaBytes.length),
        "Content-Type": "image/jpeg",
        "Cross-Origin-Resource-Policy": "same-origin",
        ETag: state.mediaEtagMismatch === "panorama" ? "f".repeat(64) : panoramaHash,
        "X-Content-Type-Options": "nosniff"
      });
      response.end(panoramaBytes);
      return true;
    }
    const photoMediaMatch = path.match(/^\/v1\/viewer\/spaces\/space-gongguang\/photos\/([^/]+)\/media$/);
    if (request.method === "GET" && photoMediaMatch) {
      const photo = state.photos.find((item) => item.id === photoMediaMatch[1]);
      if (!hasSession) return json(response, 401, { code: "session_unavailable" });
      if (!photo || photo.contentState !== "visible" || photo.placementState !== "confirmed") return json(response, 404, { code: "photo_scene_unavailable" });
      const original = mediaBytesForPhoto(photo);
      if (!original) return json(response, 404, { code: "media_unavailable" });
      const value = state.tamperedPhotos.has(photo.id) ? Buffer.from("tampered-photo-bytes") : original;
      response.writeHead(200, {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store",
        "Content-Length": String(value.length),
        "Content-Type": "image/jpeg",
        "Cross-Origin-Resource-Policy": "same-origin",
        ETag: state.mediaEtagMismatch === "photo" ? "e".repeat(64) : photo.photoRawSha256,
        "X-Content-Type-Options": "nosniff"
      });
      response.end(value);
      return true;
    }

    if (request.method === "GET" && path === "/v1/me") return state.loggedIn ? json(response, 200, { account: { id: "account-max", name: "Max", emailMask: "m***@example.com", version: 3, ifMatch: '"account-v3"' } }) : json(response, 401, { code: "session_unavailable" });
    if (request.method === "GET" && path === "/v1/me/spaces") return state.loggedIn ? json(response, 200, { spaces: [space()] }) : json(response, 401, { code: "session_unavailable" });
    if (request.method === "GET" && path === "/v1/me/owner-transfers") return state.loggedIn ? json(response, 200, { incoming: [{ id: "transfer-incoming", spaceName: "海边晚餐", status: "pending", version: 1 }], pending: state.pendingOwnerTransfers, eligibleMemberships: state.memberships }) : json(response, 401, { code: "session_unavailable" });
    if (request.method === "GET" && path === "/v1/me/batch-receipt-bindings") return json(response, 200, { items: [], selectionRequired: true, recoverAction: "BATCH.RECOVER_FROM_ACCOUNT" });
    if (request.method === "GET" && path === "/v1/viewer/spaces/space-gongguang") return hasSession ? json(response, 200, viewerSpace()) : json(response, 401, { code: "session_unavailable" });
    const campaignPreviewMatch = path.match(/^\/v1\/external-invitation-campaigns\/([^/]+)\/preview$/);
    if (request.method === "GET" && campaignPreviewMatch) return campaignPreviewMatch[1] === "gongguang-2026" ? json(response, 200, { displayName: space().name }) : json(response, 404, { code: "campaign_preview_unavailable" });
    const photoMatch = path.match(/^\/v1\/viewer\/spaces\/space-gongguang\/photos\/([^/]+)$/);
    if (request.method === "GET" && photoMatch) return json(response, state.photos.some((photo) => photo.id === photoMatch[1]) ? 200 : 404, state.photos.find((photo) => photo.id === photoMatch[1]) || { code: "photo_unavailable" });
    const sceneMatch = path.match(/^\/v1\/viewer\/spaces\/space-gongguang\/photos\/([^/]+)\/scene-context$/);
    if (request.method === "GET" && sceneMatch) {
      const value = hasSession ? sceneContext(sceneMatch[1]) : null;
      return json(response, value ? 200 : hasSession ? 404 : 401, value || { code: hasSession ? "photo_scene_unavailable" : "session_unavailable" });
    }
    if (request.method === "GET" && path === "/v1/spaces/space-gongguang/upload-context") return json(response, 200, uploadContext());
    const batchResultMatch = path.match(/^\/v1\/contribution-batches\/([^/]+)\/result$/);
    if (request.method === "GET" && batchResultMatch) { const found = state.batches.get(batchResultMatch[1]); return json(response, found ? 200 : 404, found ? batchDto(found) : { code: "batch_unavailable" }); }
    if (request.method === "GET" && path === "/v1/batch-receipt") { const found = state.batches.get(state.receiptBatchId); return json(response, found ? 200 : 404, found ? { ...batchDto(found), receiptId: `receipt-${found.id}`, bindingNoticeAcknowledgement: "binding:v1:approved" } : { code: "receipt_session_unavailable" }); }
    const receiptItemMatch = path.match(/^\/v1\/batch-receipt\/items\/([^/]+)$/);
    if (request.method === "GET" && receiptItemMatch) { const found = [...state.batches.values()].flatMap((batch) => batch.items.map((item) => ({ ...item, batchId: batch.id, receiptId: `receipt-${batch.id}` }))).find((item) => item.id === receiptItemMatch[1]); return json(response, found ? 200 : 404, found || { code: "batch_item_unavailable" }); }
    const receiptPlacementMatch = path.match(/^\/v1\/batch-receipt\/items\/([^/]+)\/placement-edit$/);
    if (request.method === "GET" && receiptPlacementMatch) { const found = [...state.batches.values()].flatMap((batch) => batch.items.map((item) => ({ ...item, batchId: batch.id, receiptId: `receipt-${batch.id}` }))).find((item) => item.id === receiptPlacementMatch[1]); return json(response, found ? 200 : 404, found ? { ...found, canEdit: true, spaceId: "space-gongguang", suggestionId: `suggestion-${found.id}`, candidateId: `candidate-${found.id}`, sceneContext: sceneContext(found.photoId) } : { code: "placement_unavailable" }); }
    const placementMatch = path.match(/^\/v1\/photos\/([^/]+)\/placement-edit$/);
    if (request.method === "GET" && placementMatch) { const found = state.photos.find((photo) => photo.id === placementMatch[1]); return json(response, found ? 200 : 404, found ? { ...found, canEdit: true, actor: { isOwner: true }, suggestionId: `suggestion-${found.id}`, candidateId: `candidate-${found.id}`, currentPlacementRevisionId: found.placementRevisionId, sceneContext: sceneContext(found.id) } : { code: "placement_unavailable" }); }
    const panoramaStatusMatch = path.match(/^\/v1\/spaces\/space-gongguang\/panorama-candidates\/([^/]+)$/);
    if (request.method === "GET" && panoramaStatusMatch) {
      const candidate = state.panoramaCandidates.get(panoramaStatusMatch[1]);
      if (!candidate) return json(response, 404, { code: "panorama_candidate_unavailable" });
      candidate.polls += 1;
      if (candidate.polls >= 2) Object.assign(candidate, { status: "ready", panoramaRevisionId: `panorama-${candidate.candidateId}`, version: 3 });
      return json(response, 200, candidate);
    }
    if (request.method === "GET" && path === "/v1/spaces/space-gongguang/management") return state.loggedIn ? json(response, 200, management()) : json(response, 401, { code: "session_unavailable" });
    const statusRead = path.match(/^\/v1\/(exports|deletion-requests|reports|appeals|support-cases|jobs)\/([^/]+)$/);
    if (request.method === "GET" && statusRead) return json(response, 200, { id: statusRead[2], status: "completed", updatedAt: "2026-08-13T12:00:00+10:00", version: 1 });

    const payload = request.method === "GET" ? {} : await body(request);
    if (request.method !== "GET") requestRecord.body = payload;
    if (request.method === "POST" && path === "/v1/external-campaign-admission-challenges") return json(response, 200, { accepted: true, expiresAt: "2026-08-13T18:00:00+10:00" });
    if (request.method === "POST" && path === "/v1/external-campaign-admissions") return json(response, 200, { bootstrapUrl: "/open#invite=production-mock-invite-000001" });
    if (request.method === "POST" && path === "/v1/external-invitation-exchanges") { state.external = true; return json(response, 200, { campaignId: "campaign-gongguang", campaignUseOrdinal: 9, tasks: ["view", "upload"], entryTask: "view", spaceId: "space-gongguang", spaceName: "向晚婚礼", destinationRoute: "/s/space-gongguang/album" }, { "Set-Cookie": activeSessionCookie }); }
    if (request.method === "POST" && path === "/v1/auth/otp-verification-challenges") {
      const challenge = test ? testVisualChallenge() : createVisualChallenge();
      state.loginVerification = { challengeId: `powc_${randomUUID().replaceAll("-", "")}`,
        answer: challenge.answer };
      return json(response, 200, { mode: "pow", challengeId: state.loginVerification.challengeId,
        salt: randomUUID().replaceAll("-", ""), algorithm: POW_ALGORITHM, difficultyBits: 0,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        visual: { prompt: challenge.prompt, tiles: challenge.tiles } });
    }
    if (request.method === "POST" && path === "/v1/auth/email-otp-challenges") {
      const verification = state.loginVerification;
      const selected = payload.verificationSelection;
      const expectedKeys = ["email", "purpose", "locale", "verificationChallengeId",
        "verificationNonce", "verificationSelection"];
      const verified = verification && payload.verificationChallengeId === verification.challengeId &&
        payload.verificationNonce === 0 && Array.isArray(selected) &&
        selected.length === verification.answer.length &&
        selected.every((value, index) => value === verification.answer[index]);
      if (JSON.stringify(Object.keys(payload)) !== JSON.stringify(expectedKeys) || payload.purpose !== "login" ||
        payload.locale !== "zh-CN" || !payload.email || !verified) {
        return json(response, verified ? 400 : 403,
          { code: verified ? "validation_failed" : "otp_verification_failed" });
      }
      state.loginVerification = null;
      state.loginChallenge = `login-${randomUUID()}`;
      return json(response, 200, { challengeId: state.loginChallenge, expiresInSeconds: 600 });
    }
    if (request.method === "POST" && path === "/v1/auth/email-otp-verifications") { if (payload.challengeId !== state.loginChallenge || payload.otp !== "246810" || payload.purpose !== "login") return json(response, 401, { code: "authentication_failed" }); state.loggedIn = true; return json(response, 200, { account: { id: "account-max", name: "Max" }, destinationRoute: "/spaces" }, { "Set-Cookie": activeSessionCookie }); }
    if (request.method === "POST" && path === "/v1/batch-receipt/account-binding-otp-challenges") {
      if (JSON.stringify(Object.keys(payload)) !== JSON.stringify(["email", "locale"]) || payload.locale !== "zh-CN" || !payload.email) return json(response, 400, { code: "binding_challenge_unavailable" });
      state.bindingChallenge = { challengeId: `binding-${randomUUID()}`, email: payload.email };
      return json(response, 200, { challengeId: state.bindingChallenge.challengeId, expiresInSeconds: 600 });
    }
    if (request.method === "POST" && path === "/v1/batch-receipt/account-bindings") {
      if (JSON.stringify(Object.keys(payload)) !== JSON.stringify(["challengeId", "otp"]) || payload.challengeId !== state.bindingChallenge?.challengeId || payload.otp !== "246810" || request.headers["notice-acknowledgement"] !== "binding:v1:approved") return json(response, 401, { code: "verification_failed" });
      const email = state.bindingChallenge.email;
      state.bindingChallenge = null;
      return json(response, 200, { bindingId: `binding-${randomUUID()}`, emailMask: email.replace(/^(.).+(@.+)$/, "$1***$2") });
    }
    if (request.method === "POST" && path === "/v1/auth/reauth-challenges") {
      const allowed = { "AUTH.LOGOUT_ALL": "logout_all", "SPACE.ARCHIVE": "space_archive", "SPACE.RESTORE": "space_restore", "SPACE.DELETE_REQUEST": "space_delete", "ACCOUNT.DELETE_REQUEST": "account_delete", "OWNER_TRANSFER.CREATE": "owner_transfer_create", "OWNER_TRANSFER.ACCEPT": "owner_transfer_accept", "BATCH.DELETE_ITEM": "photo_delete" };
      if (!allowed[payload.actionId] || payload.purpose !== allowed[payload.actionId] || !payload.targetType || !payload.targetId) return json(response, 400, { code: "reauth_challenge_unavailable" });
      const challenge = { challengeId: `reauth-${randomUUID()}`, purpose: payload.purpose, targetType: payload.targetType, targetId: payload.targetId };
      state.reauthChallenges.set(payload.actionId, challenge);
      return json(response, 200, { challengeId: challenge.challengeId });
    }
    if (request.method === "POST" && path === "/v1/auth/reauth-verifications") {
      const challenge = state.reauthChallenges.get(payload.actionId);
      if (!challenge || payload.challengeId !== challenge.challengeId || payload.purpose !== challenge.purpose || payload.targetType !== challenge.targetType || payload.targetId !== challenge.targetId || payload.otp !== "246810") return json(response, 401, { code: "reauth_failed" });
      const reauthGrant = `grant-${payload.actionId}-${randomUUID()}`;
      state.reauthChallenges.delete(payload.actionId);
      state.reauthGrants.set(payload.actionId, reauthGrant);
      return json(response, 200, { reauthGrant });
    }
    if (request.method === "POST" && path === "/v1/auth/logout-all") {
      if (payload.reauthGrant !== state.reauthGrants.get("AUTH.LOGOUT_ALL") || payload.confirmation !== true) return json(response, 403, { code: "reauth_required" });
      state.reauthGrants.delete("AUTH.LOGOUT_ALL");
      state.loggedIn = false;
      return json(response, 200, { loggedOut: true });
    }
    if (request.method === "POST" && path === "/v1/consent-events") {
      if (payload.purpose !== "photo_upload" || payload.noticeVersion !== 2 || payload.noticeHash !== mediaNoticeHash || payload.mediaPolicyVersion !== "2" || payload.choices?.display !== true || payload.choices?.placement !== true) return json(response, 409, { code: "notice_version_stale" });
      state.consentEventId = `consent-${randomUUID()}`;
      state.consentAcceptedAt = new Date().toISOString();
      return json(response, 200, { id: state.consentEventId, consentEventId: state.consentEventId, purpose: "photo_upload", noticeVersion: 2, acceptedAt: state.consentAcceptedAt });
    }
    if (request.method === "POST" && path === "/v1/spaces/space-gongguang/panorama-candidates") {
      const candidateId = `panorama-candidate-${state.panoramaCandidates.size + 1}`;
      const uploadSessionId = `panorama-upload-${randomUUID()}`;
      state.panoramaCandidates.set(candidateId, { candidateId, status: "created", fileName: "新的现场.jpg", version: 1, polls: 0 });
      state.panoramaUploads.set(uploadSessionId, { candidateId, bytes: null });
      return json(response, 200, { candidateId, uploadSessionId, exactPrivateObjectKey: `/__panorama_uploads/${uploadSessionId}`, exactPrivateUploadTicketOnce: { url: `/__panorama_uploads/${uploadSessionId}`, headers: { "X-Panorama-Ticket": `ticket-${uploadSessionId}` } }, uploadSessionIfMatch: `"${uploadSessionId}-v1"` });
    }
    const panoramaCommitMatch = path.match(/^\/v1\/panorama-upload-sessions\/([^/]+)\/commits$/);
    if (request.method === "POST" && panoramaCommitMatch) {
      const upload = state.panoramaUploads.get(panoramaCommitMatch[1]);
      if (!upload?.bytes) return json(response, 409, { code: "object_missing" });
      const candidate = state.panoramaCandidates.get(upload.candidateId);
      Object.assign(candidate, { status: "validating", version: 2 });
      return json(response, 200, { candidateId: candidate.candidateId, status: candidate.status, jobId: `job-${candidate.candidateId}` });
    }
    if (request.method === "POST" && path === "/v1/spaces/space-gongguang/contribution-batches") { const id = `batch-${state.batches.size + 1}`; const batch = { id, batchId: id, status: "open", items: [], version: 1 }; state.batches.set(id, batch); return json(response, 200, { batchId: id, ifMatch: `"space:7;batch:1"` }); }
    const createItemMatch = path.match(/^\/v1\/contribution-batches\/([^/]+)\/items$/);
    if (request.method === "POST" && createItemMatch) { const batch = state.batches.get(createItemMatch[1]); const id = `${batch.id}-item-${batch.items.length + 1}`; const item = { id, itemId: id, fileName: `照片 ${batch.items.length + 1}`, status: "selected", placementState: "processing", contentState: "pending", uploaderCanEdit: true, version: 1, ifMatch: `"${id}-v1"` }; batch.items.push(item); batch.version += 1; return json(response, 200, item); }
    const authorizeMatch = path.match(/^\/v1\/contribution-batches\/([^/]+)\/items\/([^/]+)\/upload-sessions$/);
    if (request.method === "POST" && authorizeMatch) { const id = `upload-${randomUUID()}`; state.uploads.set(id, { batchId: authorizeMatch[1], itemId: authorizeMatch[2], bytes: null }); return json(response, 200, { uploadSessionId: id, exactPrivateObjectKey: `/__uploads/${id}`, oneTimeUploadTicket: { url: `/__uploads/${id}`, headers: { "X-Upload-Ticket": `ticket-${id}` } }, commitIfMatch: `"${id}-v1"` }); }
    const commitMatch = path.match(/^\/v1\/upload-sessions\/([^/]+)\/commits$/);
    if (request.method === "POST" && commitMatch) { const upload = state.uploads.get(commitMatch[1]); if (!upload?.bytes) return json(response, 409, { code: "object_missing" }); const batch = state.batches.get(upload.batchId); const item = batch.items.find((entry) => entry.id === upload.itemId); item.status = "committed"; item.photoId = `uploaded-${item.id}`; item.asset = `/__uploads/${commitMatch[1]}`; item.assetUrl = item.asset; item.photoUrl = item.asset; item.photoAssetId = `asset-${item.photoId}`; item.photoAssetVersion = 1; item.photoRawSha256 = hash(upload.bytes); item.placementRevisionId = `placement-${item.photoId}-v1`; item.yawDeg = 18; item.pitchDeg = 0; item.placementState = "confirmed"; item.confirmationMode = "auto"; item.contentState = "visible"; item.version += 1; item.ifMatch = `"${item.id}-v${item.version}"`; state.photos.push({ ...item, id: item.photoId, spaceId: "space-gongguang", title: item.fileName, uploader: "本次上传者", uploaderCanEdit: true, canEdit: true, uploadSessionId: commitMatch[1] }); return json(response, 200, { itemId: item.id, photoId: item.photoId, status: "validating", jobId: `job-${item.id}` }); }
    const finalizeMatch = path.match(/^\/v1\/contribution-batches\/([^/]+)\/finalizations$/);
    if (request.method === "POST" && finalizeMatch) { const batch = state.batches.get(finalizeMatch[1]); batch.status = "finalized"; batch.version += 1; state.receiptBatchId = batch.id; return json(response, 200, { id: batch.id, destinationRoute: `/uploads/${batch.id}` }); }
    const removeUploadItemMatch = path.match(/^\/v1\/contribution-batches\/([^/]+)\/items\/([^/]+)$/);
    if (request.method === "DELETE" && removeUploadItemMatch) {
      const batch = state.batches.get(removeUploadItemMatch[1]);
      if (!batch) return json(response, 404, { code: "batch_unavailable" });
      batch.items = batch.items.filter((item) => item.id !== removeUploadItemMatch[2]);
      batch.version += 1;
      return json(response, 200, batchDto(batch));
    }
    const deletePhotoMatch = path.match(/^\/v1\/photos\/([^/]+)\/deletion-requests$/);
    if (request.method === "POST" && deletePhotoMatch) {
      if (payload.reauthGrant !== state.reauthGrants.get("BATCH.DELETE_ITEM")) return json(response, 403, { code: "reauth_required" });
      state.reauthGrants.delete("BATCH.DELETE_ITEM");
      for (const batch of state.batches.values()) {
        const item = batch.items.find((entry) => entry.photoId === deletePhotoMatch[1]);
        if (item) { item.status = "deleted"; item.version += 1; item.ifMatch = `"${item.id}-v${item.version}"`; }
      }
      return json(response, 200, { id: `delete-${deletePhotoMatch[1]}`, status: "completed" });
    }
    const revokeMembershipMatch = path.match(/^\/v1\/spaces\/space-gongguang\/memberships\/([^/]+)$/);
    if (request.method === "DELETE" && revokeMembershipMatch) {
      state.memberships = state.memberships.filter((item) => item.id !== revokeMembershipMatch[1]);
      return json(response, 200, { membershipId: revokeMembershipMatch[1], status: "revoked" });
    }
    const contentMatch = path.match(/^\/v1\/photos\/([^/]+)\/content-transitions$/);
    if (request.method === "POST" && contentMatch) { const photo = state.photos.find((entry) => entry.id === contentMatch[1]); photo.contentState = payload.to; photo.version += 1; photo.ifMatch = `"${photo.id}-v${photo.version}"`; return json(response, 200, { photo }); }
    const placementWrite = path.match(/^\/v1\/photos\/([^/]+)\/(placement-revisions|placement-actions)$/);
    if (request.method === "POST" && placementWrite) { const photo = state.photos.find((entry) => entry.id === placementWrite[1]); if (photo) { photo.yawDeg = Number(payload.yawDeg ?? photo.yawDeg); photo.pitchDeg = Number(payload.pitchDeg ?? photo.pitchDeg); photo.placementState = payload.action === "mark_outside_scene" ? "outside_scene" : "confirmed"; photo.placementRevisionId = `placement-${photo.id}-v${photo.version + 1}`; photo.version += 1; for (const batch of state.batches.values()) { const item = batch.items.find((entry) => entry.photoId === photo.id); if (item) Object.assign(item, { yawDeg: photo.yawDeg, pitchDeg: photo.pitchDeg, placementState: photo.placementState, placementRevisionId: photo.placementRevisionId, version: item.version + 1 }); } } return json(response, 200, { photo }); }
    if (["POST", "PATCH", "DELETE"].includes(request.method)) return json(response, 200, { id: `result-${randomUUID()}`, status: "completed" });
    return json(response, 404, { code: "resource_unavailable" });
  }

  return { handle, reset };
}
