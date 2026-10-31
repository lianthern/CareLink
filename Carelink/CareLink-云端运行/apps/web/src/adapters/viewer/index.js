const SHA256 = /^[a-f0-9]{64}$/;
const MAX_PANORAMA_BYTES = 33_554_432;
// Matches packages/viewer/src/viewer.js's MAX_DEPTH_BYTES exactly — enforced here too so an
// oversized depth map fails closed at the adapter boundary instead of only inside the viewer.
const MAX_DEPTH_BYTES = 8 * 1024 * 1024;
const DEPTH_ARTIFACT_SCHEMA = "unseen-depth-artifact/1";
const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const FORBIDDEN_MEDIA_FIELDS = [
  "authorizationHeader",
  "authorizationSecret",
  "capabilityId",
  "customAuthorizationHeader",
  "expiresAt",
  "oneTime",
  "privateObjectKey",
  "secret"
];

function fail(label) {
  throw new Error(`viewer_scene_invalid:${label}`);
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value) fail(label);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) fail(label);
  return value;
}

function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(label);
  return value;
}

function sha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) fail(label);
  return value;
}

function originForValidation(origin) {
  return origin || globalThis.location?.origin || "http://unseen.local";
}

function sessionMediaUrl(value, kind, identity, origin) {
  const raw = requiredString(value, `${kind}_url`);
  let url;
  try { url = new URL(raw, originForValidation(origin)); }
  catch { fail(`${kind}_url`); }
  if (url.origin !== originForValidation(origin) || url.search || url.hash) fail(`${kind}_url`);
  const escaped = String(identity).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const suffix = kind === "panorama"
    ? new RegExp(`/v1/viewer/spaces/[^/]+/panorama-revisions/${escaped}/media$`)
    : kind === "depthMap"
    ? new RegExp(`/v1/viewer/spaces/[^/]+/panorama-revisions/${escaped}/depth-map$`)
    // A v2 (待复核编辑器的 360 预览缺口修复): the target photo's own media can come from either
    // the general-purpose, confirmed-only viewer route (an already-placed photo being
    // re-edited) or PlacementService#editorMedia()'s own route (a needs_confirmation/failed
    // photo — see viewer-media-service.mjs's editorSceneContext() for why that one needs a
    // separate, non-viewer-authorized endpoint). Both are same-origin, session-authorized, and
    // scoped to this exact photoId, so accepting either here doesn't widen what a caller can
    // reach — it only reflects that editorSceneContext() legitimately points at a different URL.
    : new RegExp(`/v1/(?:viewer/spaces/[^/]+/photos/${escaped}/media|photos/${escaped}/placement-edit/media)$`);
  if (!suffix.test(url.pathname)) fail(`${kind}_url`);
  return raw;
}

function assertNoForbiddenFields(value, label) {
  if (!value || typeof value !== "object") return;
  for (const field of FORBIDDEN_MEDIA_FIELDS) {
    if (Object.hasOwn(value, field)) fail(`${label}_${field}`);
  }
}

function canonicalMedia(value, { kind, identity, origin }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${kind}_media`);
  assertNoForbiddenFields(value, kind);
  const bytes = positiveInteger(value.bytes, `${kind}_bytes`);
  if (kind === "panorama" && bytes > MAX_PANORAMA_BYTES) fail("panorama_bytes");
  if (kind === "depthMap" && bytes > MAX_DEPTH_BYTES) fail("depthMap_bytes");
  const contentType = requiredString(value.contentType, `${kind}_content_type`);
  if (!/^image\/[a-z0-9.+-]+$/i.test(contentType)) fail(`${kind}_content_type`);
  return Object.freeze({
    url: sessionMediaUrl(value.url, kind, identity, origin),
    assetId: requiredString(value.assetId, `${kind}_asset_id`),
    assetVersion: positiveInteger(value.assetVersion, `${kind}_asset_version`),
    sha256: sha256(value.sha256, `${kind}_sha256`),
    bytes,
    contentType
  });
}

// Validates the wire-level depthArtifact object sceneContext() emits and returns the exact
// unseen-depth-artifact/1 shape packages/viewer/src/depth.js's validateDepthArtifact() expects,
// with the depthMap's media descriptor split out for the same pre-fetch-and-verify treatment as
// panorama/photo. Numeric bound-checking (near/far/width/height/safetyEnvelope structure) is
// intentionally left to depth.js at render time — this layer's job is the *session-scoped media
// contract* (same-origin URL, no forbidden fields, no exfiltration), not re-deriving depth.js's
// domain validation.
function canonicalDepthArtifact(value, { panoramaRevisionId, origin }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("depth_artifact");
  assertNoForbiddenFields(value, "depth_artifact");
  if (value.schemaVersion !== DEPTH_ARTIFACT_SCHEMA) fail("depth_artifact_schema");
  const artifactId = requiredString(value.artifactId, "depth_artifact_id");
  if (value.sourcePanoramaRevisionId !== panoramaRevisionId) fail("depth_artifact_revision");
  const map = value.depthMap;
  if (!map || typeof map !== "object" || Array.isArray(map)) fail("depth_map");
  const media = canonicalMedia(map, { kind: "depthMap", identity: panoramaRevisionId, origin });
  const width = positiveInteger(map.width, "depth_map_width");
  const height = positiveInteger(map.height, "depth_map_height");
  const encoding = requiredString(map.encoding, "depth_map_encoding");
  const nearMeters = finite(map.nearMeters, "depth_map_near");
  const farMeters = finite(map.farMeters, "depth_map_far");
  const quality = value.quality;
  if (!quality || typeof quality !== "object" || Array.isArray(quality)) fail("depth_quality");
  const validFraction = finite(quality.validFraction, "depth_quality_valid_fraction");
  const safetyEnvelope = value.safetyEnvelope;
  if (!safetyEnvelope || typeof safetyEnvelope !== "object" || Array.isArray(safetyEnvelope)) fail("depth_safety_envelope");
  return {
    media,
    artifact: Object.freeze({
      schemaVersion: DEPTH_ARTIFACT_SCHEMA,
      artifactId,
      sourcePanoramaRevisionId: panoramaRevisionId,
      depthMap: Object.freeze({ url: media.url, sha256: media.sha256, width, height, encoding, nearMeters, farMeters }),
      quality: Object.freeze({ validFraction }),
      safetyEnvelope
    })
  };
}

function focusPoseDto(placement) {
  return {
    nodeId: placement.nodeId,
    yawDeg: placement.yawDeg,
    pitchDeg: placement.pitchDeg,
    fovDeg: placement.fovDeg,
    photoId: placement.photoId,
    photoAssetId: placement.photoAssetId,
    photoAssetVersion: placement.photoAssetVersion,
    photoRawSha256: placement.photoRawSha256,
    placementRevisionId: placement.placementRevisionId,
    panoramaRevisionId: placement.panoramaRevisionId
  };
}

function identitySnapshot(canonical) {
  const pose = canonical.focusPose;
  return JSON.stringify({
    photoId: pose.photoId,
    photoAssetId: pose.photoAssetId,
    photoAssetVersion: pose.photoAssetVersion,
    photoRawSha256: pose.photoRawSha256,
    placementRevisionId: pose.placementRevisionId,
    panoramaRevisionId: pose.panoramaRevisionId,
    panorama: canonical.media.panorama,
    photoMedia: canonical.media.photo,
    depthArtifactId: canonical.scene.depthArtifact?.artifactId ?? null,
    depthMapSha256: canonical.scene.depthArtifact?.depthMap.sha256 ?? null
  });
}

function sameFocusIdentity(left, right) {
  const fields = ["photoId", "photoAssetId", "photoAssetVersion", "photoRawSha256", "placementRevisionId", "panoramaRevisionId"];
  return Boolean(left && right && fields.every((field) => left[field] === right[field]));
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/** Fetch a frozen same-origin media locator and verify its response before decode/use. */
export async function fetchVerifiedViewerMedia(media, {
  fetcher = globalThis.fetch,
  origin,
  createObjectURL = (blob) => URL.createObjectURL(blob),
  revokeObjectURL = (url) => URL.revokeObjectURL(url)
} = {}) {
  if (typeof fetcher !== "function") throw new Error("viewer_media_fetch_unavailable");
  const absolute = new URL(media.url, originForValidation(origin));
  if (absolute.origin !== originForValidation(origin) || absolute.search || absolute.hash) throw new Error("viewer_media_url_invalid");
  const response = await fetcher(media.url, { credentials: "include", cache: "no-store" });
  if (!response?.ok) throw new Error(`viewer_media_unavailable:${response?.status || 0}`);
  if (response.headers.get("etag") !== media.sha256) throw new Error("viewer_media_etag_mismatch");
  if ((response.headers.get("content-type") || "").toLowerCase() !== media.contentType.toLowerCase()) throw new Error("viewer_media_content_type_mismatch");
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) !== media.bytes) throw new Error("viewer_media_length_mismatch");
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== media.bytes) throw new Error("viewer_media_length_mismatch");
  if (await sha256Hex(bytes) !== media.sha256) throw new Error("viewer_media_hash_mismatch");
  const objectUrl = createObjectURL(new Blob([bytes], { type: media.contentType }));
  return {
    url: objectUrl,
    assetId: media.assetId,
    assetVersion: media.assetVersion,
    sha256: media.sha256,
    bytes: media.bytes,
    contentType: media.contentType,
    revoke() { revokeObjectURL(objectUrl); }
  };
}

// The current depth reprojection can stretch the panorama at the edges when
// visitors press the translation arrows. Keep the server capability intact,
// but make the web experience rotation-only until that rendering path is fit
// to expose again.
export function rotationOnlyViewerContext(context) {
  if (context?.sceneMode !== "depth_limited_parallax") return context;
  return { ...context, sceneMode: "rotation360", depthArtifact: null };
}

/** Convert the effective ViewerPhotoSceneContextDTO into Track 4's only public DTO. */
export function canonicalViewerScene(context, { origin } = {}) {
  if (!context || typeof context !== "object" || Array.isArray(context)) fail("context");
  assertNoForbiddenFields(context, "context");
  if (Object.hasOwn(context, "nodeId")) fail("node_id_forbidden");
  if (context.sceneReadiness !== "ready") fail("scene_not_ready");
  if (!["rotation360", "depth_limited_parallax"].includes(context.sceneMode)) fail("scene_mode");
  const scene = context.scene;
  if (!scene || typeof scene !== "object" || Array.isArray(scene)) fail("scene");
  if (Object.hasOwn(scene, "nodeId")) fail("node_id_forbidden");
  const sceneId = requiredString(scene.sceneId, "scene_id");
  const panoramaRevisionId = requiredString(scene.panoramaRevisionId, "panorama_revision_id");
  if (context.panorama?.revisionId !== panoramaRevisionId) fail("panorama_revision_id");
  const photoId = requiredString(context.photoId, "photo_id");
  const photoAssetId = requiredString(context.photoAssetId, "photo_asset_id");
  const photoAssetVersion = positiveInteger(context.photoAssetVersion, "photo_asset_version");
  const photoRawSha256 = sha256(context.photoRawSha256, "photo_raw_sha256");
  const panorama = canonicalMedia(context.panorama, { kind: "panorama", identity: panoramaRevisionId, origin });
  const photoMedia = canonicalMedia(context.photoMedia, { kind: "photo", identity: photoId, origin });
  const value = context.placement;
  const draft = context.draftPose;
  let placement;
  let confirmed = true;
  if (value && typeof value === "object" && !Array.isArray(value) && value.status === "confirmed") {
    if (Object.hasOwn(value, "version")) fail("placement_version_forbidden");
    placement = Object.freeze({
      nodeId: sceneId,
      photoId,
      photoAssetId,
      photoAssetVersion,
      photoRawSha256,
      placementRevisionId: requiredString(value.revisionId, "placement_revision_id"),
      panoramaRevisionId,
      placementState: "confirmed",
      confirmationMode: requiredString(value.confirmationMode, "confirmation_mode"),
      yawDeg: finite(value.yawDeg, "yaw"),
      pitchDeg: finite(value.pitchDeg, "pitch"),
      fovDeg: finite(value.fovDeg, "fov"),
      placementSeq: positiveInteger(value.placementSeq, "placement_seq"),
      photoVersion: positiveInteger(value.photoVersion, "photo_version")
    });
  } else if ((value === null || value === undefined) && draft && typeof draft === "object" && !Array.isArray(draft)) {
    // A v2 (待复核编辑器初始视角): a photo with no confirmed placement of its own — exactly why
    // it's open in the placement editor — has no real focus pose to show yet. draftPose (set by
    // placementRoute() in app.js: the AI's top candidate direction when the locator produced
    // one, otherwise centered) stands in as a *starting point* for the human to drag from; it's
    // never mistaken for an actual placement — placementState stays "draft", never "confirmed",
    // and is excluded from `placements` below so no phantom "already located" marker shows up in
    // the sidebar for a photo nobody has placed yet.
    confirmed = false;
    placement = Object.freeze({
      nodeId: sceneId,
      photoId,
      photoAssetId,
      photoAssetVersion,
      photoRawSha256,
      // packages/viewer's own focusPose() (frozen — never edited here) hard-requires
      // placementRevisionId to be a non-empty string ("照片位置缺少不可变身份" —
      // focus_identity_invalid otherwise), even though nothing in apps/web ever reads this
      // field back out as a real placement-revision id (identitySnapshot()/sameFocusIdentity()
      // only use it locally to detect "did the focus target change"). "draft" is a stable,
      // unambiguous sentinel — never collides with a real id() (see util.mjs's id(), which is
      // always prefix_hex) — that satisfies the frozen package's validation without pretending
      // this unconfirmed photo has a real placement_revisions row.
      placementRevisionId: "draft",
      panoramaRevisionId,
      placementState: "draft",
      confirmationMode: null,
      yawDeg: finite(draft.yawDeg, "draft_yaw"),
      pitchDeg: finite(draft.pitchDeg ?? 0, "draft_pitch"),
      fovDeg: finite(draft.fovDeg ?? 75, "draft_fov"),
      placementSeq: 0,
      photoVersion: null
    });
  } else fail("placement_status");
  let depthArtifact = null;
  let depthMedia = null;
  if (context.sceneMode === "depth_limited_parallax") {
    const canonicalDepth = canonicalDepthArtifact(context.depthArtifact, { panoramaRevisionId, origin });
    depthArtifact = canonicalDepth.artifact;
    depthMedia = canonicalDepth.media;
  } else if (context.depthArtifact != null) {
    fail("depth_artifact_unexpected");
  }
  return Object.freeze({
    scene: Object.freeze({
      sceneId,
      nodeId: sceneId,
      sceneReadiness: "ready",
      sceneMode: context.sceneMode,
      panorama: Object.freeze({ url: panorama.url, revisionId: panoramaRevisionId, sha256: panorama.sha256 }),
      depthArtifact
    }),
    placements: Object.freeze(confirmed ? [placement] : []),
    focusPose: Object.freeze(focusPoseDto(placement)),
    media: Object.freeze({ panorama, photo: photoMedia, depthMap: depthMedia })
  });
}

function bounded(promise, milliseconds, code) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), milliseconds); })
  ]).finally(() => clearTimeout(timer));
}

// B ("回到拍摄视角" entry/switch transition): Track 4's own focusPose()
// (packages/viewer/src/viewer.js, frozen — never edited here) already tweens
// with an eased RAF loop from whatever the *current* pose is to the target
// whenever given a nonzero durationMs. What production was actually missing
// was a deliberate, visibly-off starting point: focusPose() gets called
// right after mount() resets the camera to a generic default pose, and by
// default that "from" pose reads as an arbitrary jump-cut rather than a
// camera turning to face the photo. planFocusTransition() computes a
// starting pose offset from the target by a fixed yaw amount and the two
// focusPose() call options #focus() below needs: an instant (animate:false)
// snap to that approach pose, then an eased (animate:true) tween from there
// to the real target — "偏移一点角度，再转过来对准". Kept pure/DOM-free/timer-
// free so the angle math is unit-testable without mounting a viewer; #focus()
// is the only caller and owns sequencing, bounding, and error handling.
const APPROACH_OFFSET_DEG = 36;
const TRANSITION_DURATION_MS = 720;

/** Normalize a yaw in degrees to (-180, 180]. */
export function normalizeYawDeg(yawDeg) {
  let value = yawDeg % 360;
  if (value > 180) value -= 360;
  else if (value <= -180) value += 360;
  return value === 0 ? 0 : value; // canonicalize -0 to 0 (e.g. normalizeYawDeg(-360))
}

/** The pose focusPose() should snap to first: same identity as targetPose, yaw offset by offsetDeg. */
export function computeApproachPose(targetPose, { offsetDeg = APPROACH_OFFSET_DEG } = {}) {
  return { ...targetPose, yawDeg: normalizeYawDeg(targetPose.yawDeg - offsetDeg) };
}

// prefers-reduced-motion (or an explicit `reducedMotion: true`) skips the approach
// snap entirely and asks focusPose() for an instant, single-step placement —
// "跳过转场直接落位". Otherwise: snap to the approach pose, then animate the eased
// swivel to target over durationMs (clamped to [600,900] by viewer.js itself, see
// its own Math.min(1000,...) — 720 sits in the middle of that requested range).
export function planFocusTransition(targetPose, { reducedMotion = false, offsetDeg = APPROACH_OFFSET_DEG,
  durationMs = TRANSITION_DURATION_MS } = {}) {
  if (reducedMotion) return { approachPose: null, focusOptions: { animate: false, focusOnComplete: true } };
  return { approachPose: computeApproachPose(targetPose, { offsetDeg }),
    focusOptions: { animate: true, durationMs, focusOnComplete: true } };
}

export class ViewerAdapter {
  mount() { throw new Error("ViewerAdapter.mount must be implemented"); }
  focusPhoto() { throw new Error("ViewerAdapter.focusPhoto must be implemented"); }
  destroy() {}
}

export class ProductionViewerAdapter extends ViewerAdapter {
  constructor({ loadViewer = () => import("@unseen/viewer"), viewerOptions, focusOptions = { focusOnComplete: true }, refreshSceneContext, fetchMedia = fetchVerifiedViewerMedia, onReturnRequest, onPoseChange, onUnavailable = () => {} } = {}) {
    super();
    this.loadViewer = loadViewer;
    this.viewerOptions = viewerOptions;
    this.focusOptions = focusOptions;
    this.refreshSceneContext = refreshSceneContext;
    this.fetchMedia = fetchMedia;
    this.onReturnRequest = onReturnRequest;
    this.onPoseChange = onPoseChange;
    this.onUnavailable = onUnavailable;
    // B: which photo (if any) #focus() has already completed a transition onto in
    // this mounted instance — lets a redundant #focus() call for the same photo
    // (bindPostRender() in app.js calls focusPhoto() once more right after mount()
    // already focused the same target) resolve as a no-op instead of replaying the
    // approach-snap-then-swivel a second time right after the first one finishes.
    this.focusedPhotoId = null;
  }

  async #prepare(context) {
    const canonical = canonicalViewerScene(context);
    const panorama = await this.fetchMedia(canonical.media.panorama);
    try {
      const photo = await this.fetchMedia(canonical.media.photo);
      try {
        const depthMap = canonical.media.depthMap ? await this.fetchMedia(canonical.media.depthMap) : null;
        return { canonical, panorama, photo, depthMap, identity: identitySnapshot(canonical) };
      } catch (error) {
        photo.revoke();
        throw error;
      }
    } catch (error) {
      panorama.revoke();
      throw error;
    }
  }

  #scene(prepared) {
    const scene = {
      ...prepared.canonical.scene,
      panorama: { ...prepared.canonical.scene.panorama, url: prepared.panorama.url }
    };
    if (prepared.canonical.scene.depthArtifact && prepared.depthMap) {
      scene.depthArtifact = {
        ...prepared.canonical.scene.depthArtifact,
        depthMap: { ...prepared.canonical.scene.depthArtifact.depthMap, url: prepared.depthMap.url }
      };
    }
    return scene;
  }

  #release(prepared = this.prepared) {
    prepared?.panorama?.revoke?.();
    prepared?.photo?.revoke?.();
    prepared?.depthMap?.revoke?.();
  }

  async mount(container, context) {
    this.destroy();
    this.container = container;
    try {
      const prepared = await this.#prepare(context);
      this.prepared = prepared;
      this.context = context;
      const publicApi = await this.loadViewer();
      if (typeof publicApi?.createViewer !== "function") throw new Error("viewer_public_api_unavailable");
      const viewer = publicApi.createViewer(this.viewerOptions);
      const required = ["mount", "updateScene", "focusPose", "getState", "addEventListener", "removeEventListener", "dispose"];
      if (!viewer || required.some((method) => typeof viewer[method] !== "function")) throw new Error("viewer_public_api_invalid");
      this.viewer = viewer;
      this.host = document.createElement("div");
      this.host.className = "viewer-render-host";
      this.list = document.createElement("div");
      this.list.className = "viewer-photo-list";
      this.list.setAttribute("aria-label", "已定位照片");
      container.replaceChildren(this.host, this.list);
      this.retryListener = (event) => { void this.#retry(event); };
      this.returnListener = (event) => { void this.#return(event); };
      this.poseListener = (event) => this.onPoseChange?.(event.detail || {});
      viewer.addEventListener("retryrequest", this.retryListener);
      viewer.addEventListener("returnrequest", this.returnListener);
      viewer.addEventListener("posechange", this.poseListener);
      try {
        await bounded(viewer.mount(this.host, this.#scene(prepared)), 6000, "viewer_mount_timeout");
      } catch (error) {
        if (error.message !== "viewer_mount_timeout" || viewer.getState().phase !== "ready") throw error;
      }
      this.#renderPhotoList(prepared.canonical.placements);
      await this.#focus(prepared.canonical.focusPose);
      return viewer;
    } catch (error) {
      this.destroy();
      this.onUnavailable(error);
      throw error;
    }
  }

  #renderPhotoList(placements) {
    if (!this.list) return;
    this.list.replaceChildren(...placements.map((placement) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "button viewer-photo-button";
      button.dataset.photoId = placement.photoId;
      button.setAttribute("aria-label", "查看这张已定位照片");
      button.textContent = "已定位 · 当前照片";
      button.addEventListener("click", () => { void this.focusPhoto(placement.photoId); });
      return button;
    }));
  }

  // B: "转场结束后...脉冲一次『已定位·当前照片』标记高亮" — marks which of the
  // #renderPhotoList buttons above matches the photo #focus() just finished
  // transitioning to (is-current, sticky) and replays a one-shot CSS pulse on
  // it (is-focus-pulse — styles.css). The class is removed and re-added on
  // every call (even for the same button) so re-focusing the same photo still
  // replays the pulse instead of relying on an animation that has already run.
  #pulseFocused(photoId) {
    if (!this.list) return;
    for (const button of this.list.querySelectorAll(".viewer-photo-button")) {
      const isTarget = button.dataset.photoId === photoId;
      button.classList.toggle("is-current", isTarget);
      button.classList.remove("is-focus-pulse");
    }
    if (!photoId) return;
    const target = this.list.querySelector(`.viewer-photo-button[data-photo-id="${CSS.escape(photoId)}"]`);
    if (!target) return;
    void target.offsetWidth;
    target.classList.add("is-focus-pulse");
  }

  // B: focusOptions.animate === false (the placement-editor's inline preview — see
  // app.js's bindPostRender(), viewerRoot[data-placement-preview]) is an explicit
  // opt-out that predates this feature and must keep behaving exactly as before:
  // one direct, instant focusPose() call, no approach swivel. Every other caller
  // (the immersive scene page) gets the transition, unless the same photo is
  // already focused (see this.focusedPhotoId above) or the visitor prefers
  // reduced motion, in which case planFocusTransition() itself collapses to a
  // single instant placement — "跳过转场直接落位".
  async #focus(pose) {
    if (!this.viewer || !this.prepared || !sameFocusIdentity(pose, this.prepared.canonical.focusPose)) return false;
    if (this.focusOptions?.animate === false) {
      try {
        await bounded(this.viewer.focusPose(focusPoseDto(pose), this.focusOptions), 1800, "viewer_focus_timeout");
        this.focusedPhotoId = pose.photoId;
        return true;
      } catch {
        return false;
      }
    }
    if (this.focusedPhotoId === pose.photoId) return true;
    const reducedMotion = Boolean(globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
    const plan = planFocusTransition(pose, { reducedMotion });
    try {
      if (plan.approachPose) {
        await bounded(this.viewer.focusPose(focusPoseDto(plan.approachPose), { animate: false }), 1800, "viewer_focus_timeout");
      }
      await bounded(this.viewer.focusPose(focusPoseDto(pose), { ...plan.focusOptions, ...this.focusOptions }), 1800, "viewer_focus_timeout");
      this.focusedPhotoId = pose.photoId;
      this.#pulseFocused(pose.photoId);
      return true;
    } catch {
      return false;
    }
  }

  async #retry(event) {
    event.preventDefault?.();
    if (!this.refreshSceneContext || this.retrying || !this.viewer || !this.prepared) return;
    this.retrying = true;
    let nextPrepared;
    try {
      const nextContext = await this.refreshSceneContext({
        failure: event.detail?.failure || null,
        sceneId: event.detail?.sceneId || null,
        panoramaRevisionId: event.detail?.panoramaRevisionId || null
      });
      nextPrepared = await this.#prepare(nextContext);
      if (nextPrepared.identity !== this.prepared.identity) throw new Error("viewer_media_identity_drift");
      await this.viewer.updateScene(this.#scene(nextPrepared));
      const previous = this.prepared;
      this.prepared = nextPrepared;
      nextPrepared = null;
      this.context = nextContext;
      this.#release(previous);
      this.#renderPhotoList(this.prepared.canonical.placements);
      await this.#focus(this.prepared.canonical.focusPose);
    } catch (error) {
      this.#release(nextPrepared);
      this.destroy();
      this.onUnavailable(error);
    } finally {
      this.retrying = false;
    }
  }

  async focusPhoto(photoId) {
    const pose = this.prepared?.canonical.placements.find((item) => item.photoId === photoId);
    return pose ? this.#focus(pose) : false;
  }

  async #return(event) {
    const detail = event.detail || {};
    const expected = this.prepared?.canonical.focusPose;
    if (!sameFocusIdentity(detail, expected)) return;
    this.onReturnRequest?.({ ...expected, returnTarget: detail.returnTarget || null });
  }

  destroy() {
    const viewer = this.viewer;
    const prepared = this.prepared;
    if (this.viewer) {
      this.viewer.removeEventListener("retryrequest", this.retryListener);
      this.viewer.removeEventListener("returnrequest", this.returnListener);
      this.viewer.removeEventListener("posechange", this.poseListener);
      this.viewer.dispose();
    }
    this.viewer = null;
    this.context = null;
    this.host = null;
    this.list = null;
    this.prepared = null;
    this.focusedPhotoId = null;
    if (viewer) setTimeout(() => this.#release(prepared), 0);
    else this.#release(prepared);
    if (this.container) this.container.replaceChildren();
    this.container = null;
  }
}

// This renderer exists only for explicit ?fixture=1&debug=1 browser harnesses.
export class FixtureViewerAdapter extends ViewerAdapter {
  constructor({ panoramaUrl }) { super(); this.panoramaUrl = panoramaUrl; }
  mount(container, { markers = [] } = {}) {
    container.classList.add("viewer-fixture");
    container.style.setProperty("--viewer-image", `url("${this.panoramaUrl}")`);
    container.innerHTML = `<div class="viewer-stage" aria-label="本地调试现场"></div><div class="viewer-photo-list" aria-label="已定位照片">${markers.map((marker) => `<button class="button viewer-photo-button" data-photo-id="${escapeHtml(marker.photoId)}" aria-label="查看已定位照片：${escapeHtml(marker.label)}">已定位 · ${escapeHtml(marker.label)}</button>`).join("")}</div>`;
    this.container = container;
  }
  focusPhoto(photoId) { this.container?.querySelector(`[data-photo-id="${photoId}"]`)?.focus(); }
  destroy() { if (this.container) this.container.innerHTML = ""; }
}
