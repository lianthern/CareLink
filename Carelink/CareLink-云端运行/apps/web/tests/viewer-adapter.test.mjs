import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { canonicalViewerScene, computeApproachPose, fetchVerifiedViewerMedia, normalizeYawDeg, planFocusTransition, ProductionViewerAdapter, rotationOnlyViewerContext } from "../src/adapters/viewer/index.js";

const raw = new TextEncoder().encode("effective-viewer-media");
const hash = createHash("sha256").update(raw).digest("hex");
const context = {
  photoId: "photo-1",
  photoAssetId: "raw-asset-1",
  photoAssetVersion: 3,
  photoRawSha256: hash,
  sceneReadiness: "ready",
  sceneMode: "rotation360",
  scene: { sceneId: "scene-1", panoramaRevisionId: "panorama-2" },
  panorama: {
    url: "/v1/viewer/spaces/space-1/panorama-revisions/panorama-2/media",
    revisionId: "panorama-2",
    assetId: "panorama-asset-2",
    assetVersion: 2,
    sha256: hash,
    bytes: raw.byteLength,
    contentType: "image/jpeg"
  },
  photoMedia: {
    url: "/v1/viewer/spaces/space-1/photos/photo-1/media",
    assetId: "viewer-safe-asset-1",
    assetVersion: 4,
    sha256: hash,
    bytes: raw.byteLength,
    contentType: "image/jpeg"
  },
  placement: {
    revisionId: "placement-4",
    status: "confirmed",
    confirmationMode: "manual",
    yawDeg: 47,
    pitchDeg: -3,
    fovDeg: 72,
    placementSeq: 5,
    photoVersion: 9
  }
};

class FakeElement extends EventTarget {
  constructor(tagName = "div") {
    super();
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = { setProperty: (key, value) => { this.style[key] = value; } };
  }
  setAttribute(key, value) { this[key] = value; }
  replaceChildren(...children) { this.children = children; }
}

function detailEvent(type, detail, cancelable = false) {
  const event = new Event(type, { cancelable });
  Object.defineProperty(event, "detail", { value: detail });
  return event;
}

async function waitFor(predicate, timeout = 1000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("test wait timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("effective scene context maps byte-exactly to the Track 4 public DTO", () => {
  const result = canonicalViewerScene(context, { origin: "http://app.test" });
  assert.deepEqual(result.scene, {
    sceneId: "scene-1",
    nodeId: "scene-1",
    sceneReadiness: "ready",
    sceneMode: "rotation360",
    panorama: { url: context.panorama.url, revisionId: "panorama-2", sha256: hash },
    depthArtifact: null
  });
  assert.equal(result.media.depthMap, null);
  assert.equal(Object.hasOwn(result.scene, "placements"), false);
  assert.deepEqual(result.focusPose, {
    nodeId: "scene-1",
    yawDeg: 47,
    pitchDeg: -3,
    fovDeg: 72,
    photoId: "photo-1",
    photoAssetId: "raw-asset-1",
    photoAssetVersion: 3,
    photoRawSha256: hash,
    placementRevisionId: "placement-4",
    panoramaRevisionId: "panorama-2"
  });
  assert.deepEqual(result.placements.map((item) => item.photoId), ["photo-1"]);
  assert.deepEqual(result.media.photo, context.photoMedia);
});

test("scene context accepts only the effective same-origin session-auth shape", () => {
  assert.throws(() => canonicalViewerScene({ ...context, nodeId: "old-node" }), /node_id_forbidden/);
  assert.throws(() => canonicalViewerScene({ ...context, placements: [], placement: undefined }), /placement_status/);
  assert.throws(() => canonicalViewerScene({ ...context, placement: { ...context.placement, status: "needs_confirmation" } }), /placement_status/);
  assert.throws(() => canonicalViewerScene({ ...context, placement: { ...context.placement, version: 2 } }), /placement_version_forbidden/);
  assert.throws(() => canonicalViewerScene({ ...context, panorama: { ...context.panorama, authorizationHeader: "X-Media-Capability" } }), /authorizationHeader/);
  assert.throws(() => canonicalViewerScene({ ...context, panorama: { ...context.panorama, oneTime: true } }), /oneTime/);
  assert.throws(() => canonicalViewerScene({ ...context, panorama: { ...context.panorama, url: `https://media.invalid${context.panorama.url}` } }, { origin: "http://app.test" }), /panorama_url/);
  assert.throws(() => canonicalViewerScene({ ...context, photoMedia: { ...context.photoMedia, url: `${context.photoMedia.url}?signed=1` } }), /photo_url/);
  assert.throws(() => canonicalViewerScene({ ...context, panorama: { ...context.panorama, bytes: 33_554_433 } }), /panorama_bytes/);
  assert.throws(() => canonicalViewerScene({ ...context, scene: { ...context.scene, panoramaRevisionId: "panorama-3" } }), /panorama_revision_id/);
});

// A v2 (待复核编辑器的 360 预览缺口修复): a needs_confirmation/failed photo has no confirmed
// placement of its own — services/api/src/viewer-media-service.mjs's editorSceneContext() sends
// `placement: null` for exactly that case — so the placement editor's viewer mount needs a way
// to still get a scene + a starting focus pose without a confirmed placement. placementRoute()
// in app.js attaches `draftPose` (the AI's top candidate direction, or centered) to the scene
// context object precisely for this; these tests lock in canonicalViewerScene()'s handling of
// that new, opt-in shape without weakening the existing confirmed-only contract above.
test("draftPose stands in for a missing placement: focus pose set, but excluded from the located-photo sidebar", () => {
  const draftContext = { ...context, placement: null, draftPose: { yawDeg: 128, pitchDeg: -6 } };
  const result = canonicalViewerScene(draftContext, { origin: "http://app.test" });
  assert.deepEqual(result.focusPose, {
    nodeId: "scene-1",
    yawDeg: 128,
    pitchDeg: -6,
    fovDeg: 75,
    photoId: "photo-1",
    photoAssetId: "raw-asset-1",
    photoAssetVersion: 3,
    photoRawSha256: hash,
    // "draft" (not null/a real id): packages/viewer's frozen focusPose() hard-requires a
    // non-empty string here (focus_identity_invalid otherwise) — see canonicalViewerScene()'s
    // own comment on the draft branch for why this sentinel is safe.
    placementRevisionId: "draft",
    panoramaRevisionId: "panorama-2"
  });
  assert.deepEqual(result.placements, [], "an unconfirmed draft pose must never appear as an '已定位' marker");
  assert.deepEqual(result.media.photo, context.photoMedia, "the target photo's own media still resolves normally");
});

test("draftPose defaults pitch to 0 and fov to 75 when the candidate carries no pitch", () => {
  const result = canonicalViewerScene({ ...context, placement: undefined, draftPose: { yawDeg: 0 } });
  assert.equal(result.focusPose.pitchDeg, 0);
  assert.equal(result.focusPose.fovDeg, 75);
});

test("draftPose never substitutes for a placement object with the wrong status (defense in depth)", () => {
  // editorSceneContext() only ever emits a full confirmed placement or an absent one — never a
  // present-but-wrong-status object — but the validator still must not treat draftPose as a
  // rescue for a malformed placement, only for a genuinely missing one.
  assert.throws(() => canonicalViewerScene({ ...context,
    placement: { ...context.placement, status: "needs_confirmation" }, draftPose: { yawDeg: 10 } }), /placement_status/);
});

test("a non-object draftPose is rejected the same as no placement at all", () => {
  assert.throws(() => canonicalViewerScene({ ...context, placement: null, draftPose: "not-an-object" }), /placement_status/);
  assert.throws(() => canonicalViewerScene({ ...context, placement: null, draftPose: null }), /placement_status/);
});

// A v2: the target photo's own media, in a draft (unconfirmed) editor session, is served by
// PlacementService#editorMedia()'s own route (/v1/photos/{id}/placement-edit/media) rather than
// the confirmed-only general viewer route — see viewer-media-service.mjs's editorSceneContext()
// comment for why. canonicalMedia()/sessionMediaUrl() must accept that shape too, alongside the
// pre-existing confirmed-only shape (still exercised by the top-level `context` fixture, which
// uses .../viewer/spaces/.../photos/.../media throughout this file).
test("photoMedia accepts the placement-edit/media route shape used for a not-yet-confirmed photo", () => {
  const draftContext = { ...context, placement: null, draftPose: { yawDeg: 12 },
    photoMedia: { ...context.photoMedia, url: "/v1/photos/photo-1/placement-edit/media" } };
  const result = canonicalViewerScene(draftContext, { origin: "http://app.test" });
  assert.equal(result.media.photo.url, "/v1/photos/photo-1/placement-edit/media");
});

test("photoMedia still rejects an unrelated path even when draftPose is present", () => {
  assert.throws(() => canonicalViewerScene({ ...context, placement: null, draftPose: { yawDeg: 12 },
    photoMedia: { ...context.photoMedia, url: "/v1/photos/photo-1/some-other-route" } }), /photo_url/);
});

const safetyEnvelope = {
  schemaVersion: "unseen-polar-safety-envelope/1",
  absoluteMaxRadiusMeters: 0.42,
  directions: Array.from({ length: 8 }, (_, index) => ({ yawDeg: index * 45, allowedRadiusMeters: 0.3 }))
};
const depthContext = {
  ...context,
  sceneMode: "depth_limited_parallax",
  depthArtifact: {
    schemaVersion: "unseen-depth-artifact/1",
    artifactId: "depth-artifact-1",
    sourcePanoramaRevisionId: "panorama-2",
    depthMap: {
      url: "/v1/viewer/spaces/space-1/panorama-revisions/panorama-2/depth-map",
      assetId: "depth-asset-1",
      assetVersion: 1,
      sha256: hash,
      bytes: raw.byteLength,
      contentType: "image/png",
      width: 1024,
      height: 512,
      encoding: "linear-red-v1",
      nearMeters: 0.5,
      farMeters: 20
    },
    quality: { validFraction: 0.99 },
    safetyEnvelope
  }
};

test("web rotation-only policy removes depth translation without mutating the API context", () => {
  const result = rotationOnlyViewerContext(depthContext);
  assert.equal(result.sceneMode, "rotation360");
  assert.equal(result.depthArtifact, null);
  assert.equal(depthContext.sceneMode, "depth_limited_parallax");
  assert.equal(rotationOnlyViewerContext(context), context);
  assert.equal(canonicalViewerScene(result).media.depthMap, null);
});

test("depth_limited_parallax scenes carry a session-scoped, revision-bound depth artifact", () => {
  const result = canonicalViewerScene(depthContext, { origin: "http://app.test" });
  assert.equal(result.scene.sceneMode, "depth_limited_parallax");
  assert.deepEqual(result.scene.depthArtifact, {
    schemaVersion: "unseen-depth-artifact/1",
    artifactId: "depth-artifact-1",
    sourcePanoramaRevisionId: "panorama-2",
    depthMap: { url: depthContext.depthArtifact.depthMap.url, sha256: hash, width: 1024, height: 512,
      encoding: "linear-red-v1", nearMeters: 0.5, farMeters: 20 },
    quality: { validFraction: 0.99 },
    safetyEnvelope
  });
  assert.deepEqual(result.media.depthMap, {
    url: depthContext.depthArtifact.depthMap.url, assetId: "depth-asset-1", assetVersion: 1,
    sha256: hash, bytes: raw.byteLength, contentType: "image/png"
  });
});

test("depth artifact is rejected outside the session-scoped media/schema/revision contract", () => {
  assert.throws(() => canonicalViewerScene({ ...context, sceneMode: "walkable3d" }), /scene_mode/);
  assert.throws(() => canonicalViewerScene({ ...context, depthArtifact: depthContext.depthArtifact }), /depth_artifact_unexpected/);
  assert.throws(() => canonicalViewerScene({ ...depthContext, depthArtifact: null }), /depth_artifact/);
  assert.throws(() => canonicalViewerScene({ ...depthContext,
    depthArtifact: { ...depthContext.depthArtifact, schemaVersion: "unseen-depth-artifact/0" } }), /depth_artifact_schema/);
  assert.throws(() => canonicalViewerScene({ ...depthContext,
    depthArtifact: { ...depthContext.depthArtifact, sourcePanoramaRevisionId: "panorama-9" } }), /depth_artifact_revision/);
  assert.throws(() => canonicalViewerScene({ ...depthContext,
    depthArtifact: { ...depthContext.depthArtifact, depthMap: { ...depthContext.depthArtifact.depthMap, bytes: 8_388_609 } } }),
    /depthMap_bytes/);
  assert.throws(() => canonicalViewerScene({ ...depthContext,
    depthArtifact: { ...depthContext.depthArtifact,
      depthMap: { ...depthContext.depthArtifact.depthMap, url: `${depthContext.depthArtifact.depthMap.url}?x=1` } } },
    { origin: "http://app.test" }), /depthMap_url/);
  assert.throws(() => canonicalViewerScene({ ...depthContext,
    depthArtifact: { ...depthContext.depthArtifact,
      depthMap: { ...depthContext.depthArtifact.depthMap, url: "/v1/viewer/spaces/space-1/panorama-revisions/panorama-9/depth-map" } } },
    { origin: "http://app.test" }), /depthMap_url/);
  assert.throws(() => canonicalViewerScene({ ...depthContext,
    depthArtifact: { ...depthContext.depthArtifact, authorizationHeader: "X-Media-Capability" } }), /authorizationHeader/);
});

test("media GET uses only session credentials and verifies ETag, metadata and SHA before object URL use", async () => {
  const calls = [];
  let objectUrlCalls = 0;
  const media = canonicalViewerScene(context).media.photo;
  const verified = await fetchVerifiedViewerMedia(media, {
    origin: "http://app.test",
    fetcher: async (url, options) => {
      calls.push({ url, options });
      return new Response(raw, { status: 200, headers: { ETag: hash, "Content-Type": "image/jpeg", "Content-Length": String(raw.byteLength) } });
    },
    createObjectURL: () => { objectUrlCalls += 1; return "blob:verified-photo"; },
    revokeObjectURL: (url) => calls.push({ revoked: url })
  });
  assert.deepEqual(calls[0], { url: context.photoMedia.url, options: { credentials: "include", cache: "no-store" } });
  assert.equal(Object.hasOwn(calls[0].options, "headers"), false);
  assert.equal(verified.url, "blob:verified-photo");
  assert.equal(objectUrlCalls, 1);
  verified.revoke();
  assert.deepEqual(calls.at(-1), { revoked: "blob:verified-photo" });

  let bodyRead = false;
  await assert.rejects(fetchVerifiedViewerMedia(media, {
    origin: "http://app.test",
    fetcher: async () => ({ ok: true, headers: new Headers({ ETag: "0".repeat(64), "Content-Type": "image/jpeg", "Content-Length": String(raw.byteLength) }), arrayBuffer: async () => { bodyRead = true; return raw.buffer; } }),
    createObjectURL: () => { throw new Error("must not decode"); }
  }), /etag_mismatch/);
  assert.equal(bodyRead, false, "ETag mismatch must fail before reading/decoding media");

  const changed = new TextEncoder().encode("effective-viewer-mediA");
  await assert.rejects(fetchVerifiedViewerMedia(media, {
    origin: "http://app.test",
    fetcher: async () => new Response(changed, { status: 200, headers: { ETag: hash, "Content-Type": "image/jpeg", "Content-Length": String(changed.byteLength) } }),
    createObjectURL: () => { throw new Error("must not decode"); }
  }), /hash_mismatch/);
  await assert.rejects(fetchVerifiedViewerMedia(media, {
    origin: "http://app.test",
    fetcher: async () => new Response(raw, { status: 401, headers: { "Content-Type": "application/json" } })
  }), /unavailable:401/);
});

test("production adapter pre-verifies both media resources, uses the exact Viewer API, and refreshes without identity drift", async (t) => {
  const priorDocument = globalThis.document;
  globalThis.document = { createElement: (name) => new FakeElement(name) };
  t.after(() => { globalThis.document = priorDocument; });
  const calls = [];
  let mediaOrdinal = 0;
  let returned = null;
  let unavailable = null;
  class StrictViewer extends EventTarget {
    mount(...args) { calls.push(["mount", ...args]); return Promise.resolve({ phase: "ready" }); }
    updateScene(...args) { calls.push(["updateScene", ...args]); return Promise.resolve({ phase: "ready" }); }
    focusPose(...args) { calls.push(["focusPose", ...args]); return Promise.resolve({ phase: "ready" }); }
    getState() { return { phase: "ready", focus: { photoId: "photo-1" } }; }
    dispose() { calls.push(["dispose"]); }
  }
  const adapter = new ProductionViewerAdapter({
    loadViewer: async () => ({ createViewer: (options) => { calls.push(["createViewer", options]); return new StrictViewer(); } }),
    viewerOptions: { assetLoadTimeoutMs: 8000 },
    fetchMedia: async (media) => {
      const ordinal = ++mediaOrdinal;
      calls.push(["fetchMedia", media]);
      return { ...media, url: `blob:verified-${ordinal}`, revoke: () => calls.push(["revoke", ordinal]) };
    },
    refreshSceneContext: async () => context,
    onReturnRequest: (value) => { returned = value; },
    onUnavailable: (error) => { unavailable = error; }
  });
  const container = new FakeElement();
  await adapter.mount(container, context);
  assert.deepEqual(calls.slice(0, 3).map((call) => call[0]), ["fetchMedia", "fetchMedia", "createViewer"]);
  const mount = calls.find((call) => call[0] === "mount");
  assert.equal(mount.length, 3);
  assert.equal(mount[1], container.children[0]);
  assert.equal(mount[2].panorama.url, "blob:verified-1");
  assert.equal(mount[2].panorama.sha256, hash);
  // B: mount()'s initial focus is now a two-step transition (see #focus() in
  // src/adapters/viewer/index.js) — an instant snap to an approach pose offset from the
  // target, then an eased animate:true tween to the real target — instead of one direct
  // focusPose() call. planFocusTransition() is the same pure function #focus() itself
  // calls, so this asserts against the real expected values rather than duplicating the
  // angle/duration math here.
  const targetFocusPose = canonicalViewerScene(context).focusPose;
  const plan = planFocusTransition(targetFocusPose, { reducedMotion: false });
  const focusPoseCalls = calls.filter((call) => call[0] === "focusPose");
  assert.equal(focusPoseCalls.length, 2);
  assert.deepEqual(focusPoseCalls[0], ["focusPose", plan.approachPose, { animate: false }]);
  assert.deepEqual(focusPoseCalls[1], ["focusPose", targetFocusPose, plan.focusOptions]);
  assert.deepEqual(container.children[1].children.map((button) => button.dataset.photoId), ["photo-1"]);
  assert.equal(container.children[1].children[0].style["--marker-x"], undefined);

  adapter.viewer.dispatchEvent(detailEvent("returnrequest", { ...canonicalViewerScene(context).focusPose }));
  await waitFor(() => returned);
  assert.equal(returned.photoId, "photo-1");

  const retry = detailEvent("retryrequest", { failure: { code: "asset_timeout", retryable: true }, sceneId: "scene-1", panoramaRevisionId: "panorama-2" }, true);
  adapter.viewer.dispatchEvent(retry);
  await waitFor(() => calls.some((call) => call[0] === "updateScene"));
  assert.equal(retry.defaultPrevented, true);
  assert.equal(calls.find((call) => call[0] === "updateScene")[1].panorama.url, "blob:verified-3");
  assert.deepEqual(calls.filter((call) => call[0] === "revoke").map((call) => call[1]), [1, 2]);
  assert.equal(unavailable, null);
  adapter.destroy();
  await waitFor(() => calls.filter((call) => call[0] === "revoke").length === 4);
  assert.deepEqual(calls.filter((call) => call[0] === "revoke").map((call) => call[1]), [1, 2, 3, 4]);
  assert.deepEqual(calls.filter((call) => call[0] === "dispose").at(-1), ["dispose"]);
});

test("production adapter also pre-verifies and swaps the depth map, and revokes it alongside panorama/photo", async (t) => {
  const priorDocument = globalThis.document;
  globalThis.document = { createElement: (name) => new FakeElement(name) };
  t.after(() => { globalThis.document = priorDocument; });
  const calls = [];
  let mediaOrdinal = 0;
  class StrictViewer extends EventTarget {
    mount(...args) { calls.push(["mount", ...args]); return Promise.resolve({ phase: "ready" }); }
    updateScene(...args) { calls.push(["updateScene", ...args]); return Promise.resolve({ phase: "ready" }); }
    focusPose(...args) { calls.push(["focusPose", ...args]); return Promise.resolve({ phase: "ready" }); }
    getState() { return { phase: "ready", focus: { photoId: "photo-1" } }; }
    dispose() { calls.push(["dispose"]); }
  }
  const adapter = new ProductionViewerAdapter({
    loadViewer: async () => ({ createViewer: () => new StrictViewer() }),
    fetchMedia: async (media) => {
      const ordinal = ++mediaOrdinal;
      calls.push(["fetchMedia", media]);
      return { ...media, url: `blob:verified-${ordinal}`, revoke: () => calls.push(["revoke", ordinal]) };
    },
    onUnavailable: (error) => { throw error; }
  });
  const container = new FakeElement();
  await adapter.mount(container, depthContext);
  assert.deepEqual(calls.filter((call) => call[0] === "fetchMedia").map((call) => call[1].assetId ?? call[1].sha256),
    ["panorama-asset-2", "viewer-safe-asset-1", "depth-asset-1"]);
  const mount = calls.find((call) => call[0] === "mount");
  assert.equal(mount[2].sceneMode, "depth_limited_parallax");
  assert.equal(mount[2].depthArtifact.depthMap.url, "blob:verified-3");
  assert.equal(mount[2].depthArtifact.depthMap.sha256, hash);
  adapter.destroy();
  await waitFor(() => calls.filter((call) => call[0] === "revoke").length === 3);
  assert.deepEqual(calls.filter((call) => call[0] === "revoke").map((call) => call[1]), [1, 2, 3]);
});

// B ("回到拍摄视角" entry/switch transition) — pure functions only, no DOM/timers.
test("normalizeYawDeg wraps any input into (-180, 180]", () => {
  assert.equal(normalizeYawDeg(0), 0);
  assert.equal(normalizeYawDeg(180), 180);
  assert.equal(normalizeYawDeg(-180), 180);
  assert.equal(normalizeYawDeg(181), -179);
  assert.equal(normalizeYawDeg(-181), 179);
  assert.equal(normalizeYawDeg(360), 0);
  assert.equal(normalizeYawDeg(-360), 0);
  assert.equal(normalizeYawDeg(719), -1);
  assert.equal(normalizeYawDeg(-719), 1);
});

test("computeApproachPose offsets only yawDeg, normalized, keeping every other field (including pitch) identical", () => {
  const target = { nodeId: "scene-1", yawDeg: 47, pitchDeg: -3, fovDeg: 72, photoId: "photo-1" };
  const approach = computeApproachPose(target, { offsetDeg: 36 });
  assert.deepEqual(approach, { ...target, yawDeg: 11 });

  // Wraps correctly when the target sits near the +/-180 seam.
  const nearSeam = { ...target, yawDeg: -170 };
  assert.equal(computeApproachPose(nearSeam, { offsetDeg: 36 }).yawDeg, 154);

  // Default offset (no options passed) is the same 36deg the adapter itself relies on.
  assert.equal(computeApproachPose(target).yawDeg, 11);
});

test("planFocusTransition: reduced motion collapses to a single instant placement, no approach pose", () => {
  const target = { nodeId: "scene-1", yawDeg: 47, pitchDeg: -3 };
  const plan = planFocusTransition(target, { reducedMotion: true });
  assert.equal(plan.approachPose, null);
  assert.deepEqual(plan.focusOptions, { animate: false, focusOnComplete: true });
});

test("planFocusTransition: normal motion returns an offset approach pose and an eased animate plan within the requested 600-900ms range", () => {
  const target = { nodeId: "scene-1", yawDeg: 47, pitchDeg: -3 };
  const plan = planFocusTransition(target, { reducedMotion: false });
  assert.notEqual(plan.approachPose.yawDeg, target.yawDeg);
  assert.equal(plan.approachPose.pitchDeg, target.pitchDeg);
  assert.equal(plan.focusOptions.animate, true);
  assert.equal(plan.focusOptions.focusOnComplete, true);
  assert.ok(plan.focusOptions.durationMs >= 600 && plan.focusOptions.durationMs <= 900,
    `durationMs ${plan.focusOptions.durationMs} must sit in the spec'd 600-900ms window`);
});

test("planFocusTransition honors an explicit offsetDeg/durationMs override", () => {
  const target = { nodeId: "scene-1", yawDeg: 0 };
  const plan = planFocusTransition(target, { reducedMotion: false, offsetDeg: 30, durationMs: 650 });
  assert.equal(plan.approachPose.yawDeg, -30);
  assert.equal(plan.focusOptions.durationMs, 650);
});

test("mount()'s initial focus does the two-step transition; a redundant focusPhoto() call for the same photo right after is a no-op (no extra focusPose calls)", async (t) => {
  const priorDocument = globalThis.document;
  globalThis.document = { createElement: (name) => new FakeElement(name) };
  t.after(() => { globalThis.document = priorDocument; });
  const calls = [];
  class StrictViewer extends EventTarget {
    mount() { return Promise.resolve({ phase: "ready" }); }
    updateScene() { return Promise.resolve({ phase: "ready" }); }
    focusPose(...args) { calls.push(["focusPose", ...args]); return Promise.resolve({ phase: "ready" }); }
    getState() { return { phase: "ready" }; }
    dispose() {}
  }
  const adapter = new ProductionViewerAdapter({
    loadViewer: async () => ({ createViewer: () => new StrictViewer() }),
    fetchMedia: async (media) => ({ ...media, url: `blob:${media.assetId}`, revoke: () => {} })
  });
  await adapter.mount(new FakeElement(), context);
  assert.equal(calls.length, 2, "mount() itself already does the approach-snap + animate pair");

  // app.js's bindPostRender() always calls focusPhoto(selected) once more right after
  // mount() for the same photo — see app.js's comment on that call. That must not
  // replay the transition a second time back-to-back.
  const focused = await adapter.focusPhoto("photo-1");
  assert.equal(focused, true);
  assert.equal(calls.length, 2, "re-focusing the already-focused photo must not call focusPose again");
});

test("retry fails closed and disposes verified media when any immutable identity drifts", async (t) => {
  const priorDocument = globalThis.document;
  globalThis.document = { createElement: (name) => new FakeElement(name) };
  t.after(() => { globalThis.document = priorDocument; });
  const calls = [];
  let unavailable = null;
  class StrictViewer extends EventTarget {
    mount() { return Promise.resolve({ phase: "ready" }); }
    updateScene() { calls.push("updateScene"); return Promise.resolve({ phase: "ready" }); }
    focusPose() { return Promise.resolve({ phase: "ready" }); }
    getState() { return { phase: "ready" }; }
    dispose() { calls.push("dispose"); }
  }
  const adapter = new ProductionViewerAdapter({
    loadViewer: async () => ({ createViewer: () => new StrictViewer() }),
    fetchMedia: async (media) => ({ ...media, url: `blob:${media.assetId}`, revoke: () => calls.push(`revoke:${media.assetId}`) }),
    refreshSceneContext: async () => ({ ...context, photoAssetVersion: context.photoAssetVersion + 1 }),
    onUnavailable: (error) => { unavailable = error; }
  });
  await adapter.mount(new FakeElement(), context);
  adapter.viewer.dispatchEvent(detailEvent("retryrequest", { failure: { code: "asset_fetch_failed" } }, true));
  await waitFor(() => unavailable);
  await waitFor(() => calls.filter((value) => String(value).startsWith("revoke:")).length === 4);
  assert.match(unavailable.message, /identity_drift/);
  assert.equal(calls.includes("updateScene"), false);
  assert.equal(calls.includes("dispose"), true);
  assert.equal(calls.filter((value) => String(value).startsWith("revoke:")).length, 4);
});

test("Track 2 runs against the pinned Track 4 only-public entry", async (t) => {
  const viewerRoot = new URL("../../../../4-viewer/", import.meta.url);
  const entry = new URL("packages/viewer/src/public/index.js", viewerRoot);
  const declaration = new URL("packages/viewer/src/public/index.d.ts", viewerRoot);
  try { await access(entry); } catch { t.skip("Track 4 worktree is not mounted"); return; }
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: viewerRoot, encoding: "utf8" }).trim(), "5e068e3d04263adc2f480ac9db5a3bc1f18157d7");
  const api = await import(entry.href);
  const viewer = api.createViewer({ assetLoadTimeoutMs: 8000 });
  assert.ok(viewer instanceof EventTarget);
  for (const method of ["mount", "updateScene", "focusPose", "addEventListener", "removeEventListener", "dispose"]) assert.equal(typeof viewer[method], "function", method);
  viewer.dispose();
  const types = await readFile(declaration, "utf8");
  assert.match(types, /createViewer\(options\?: ViewerOptions\): UnseenViewer/);
  assert.match(types, /mount\(container: Element, scene\?: ViewerSceneDTO\): Promise/);
  assert.match(types, /updateScene\(scene: ViewerSceneDTO\): Promise/);
  assert.match(types, /focusPose\(pose: FocusPoseDTO, options\?:/);
  assert.match(types, /dispose\(\): void/);
});

test("customer sources contain no injected test Viewer API", async () => {
  const sources = await Promise.all(["../index.html", "../server.mjs", "../src/app.js"].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  for (const source of sources) assert.doesNotMatch(source, /TEST_VIEWER|__UNSEEN_VIEWER_PUBLIC_API__|__UNSEEN_VIEWER_CALLS__/);
});
