import { createViewer } from "../src/public/index.js";

const activeObjectUrls = new Set();
const activeAnimationFrames = new Set();
const activeWebglContexts = new Set();
const listenerEntries = [];
const resourceStats = {
  objectUrlsCreated: 0,
  objectUrlsRevoked: 0,
  peakObjectUrls: 0,
  animationFramesRequested: 0,
  peakAnimationFrames: 0,
  observersCreated: 0,
  activeObservers: 0,
  peakObservers: 0,
  webglContextsCreated: 0,
  peakWebglContexts: 0,
  listenersAdded: 0,
  activeListeners: 0,
  peakListeners: 0,
};
const nativeAddEventListener = EventTarget.prototype.addEventListener;
const nativeRemoveEventListener = EventTarget.prototype.removeEventListener;
function captureOption(options) {
  return typeof options === "boolean" ? options : Boolean(options?.capture);
}
EventTarget.prototype.addEventListener = function addEventListener(type, callback, options) {
  nativeAddEventListener.call(this, type, callback, options);
  if (!callback) return;
  const capture = captureOption(options);
  if (listenerEntries.some((entry) => entry.active && entry.target === this &&
      entry.type === type && entry.callback === callback && entry.capture === capture)) return;
  const entry = { target: this, type, callback, capture, active: true };
  listenerEntries.push(entry);
  resourceStats.listenersAdded += 1;
  resourceStats.activeListeners += 1;
  resourceStats.peakListeners = Math.max(resourceStats.peakListeners, resourceStats.activeListeners);
  const signal = typeof options === "object" ? options?.signal : null;
  if (signal) {
    nativeAddEventListener.call(signal, "abort", () => {
      if (!entry.active) return;
      entry.active = false;
      resourceStats.activeListeners -= 1;
    }, { once: true });
  }
};
EventTarget.prototype.removeEventListener = function removeEventListener(type, callback, options) {
  nativeRemoveEventListener.call(this, type, callback, options);
  const capture = captureOption(options);
  const entry = listenerEntries.find((candidate) => candidate.active && candidate.target === this &&
    candidate.type === type && candidate.callback === callback && candidate.capture === capture);
  if (entry) {
    entry.active = false;
    resourceStats.activeListeners -= 1;
  }
};
const nativeCreateObjectURL = URL.createObjectURL.bind(URL);
const nativeRevokeObjectURL = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = (blob) => {
  const value = nativeCreateObjectURL(blob);
  activeObjectUrls.add(value);
  resourceStats.objectUrlsCreated += 1;
  resourceStats.peakObjectUrls = Math.max(resourceStats.peakObjectUrls, activeObjectUrls.size);
  return value;
};
URL.revokeObjectURL = (value) => {
  if (activeObjectUrls.delete(value)) resourceStats.objectUrlsRevoked += 1;
  return nativeRevokeObjectURL(value);
};
const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
const nativeCancelAnimationFrame = window.cancelAnimationFrame.bind(window);
window.requestAnimationFrame = (callback) => {
  let id;
  id = nativeRequestAnimationFrame((time) => {
    activeAnimationFrames.delete(id);
    callback(time);
  });
  activeAnimationFrames.add(id);
  resourceStats.animationFramesRequested += 1;
  resourceStats.peakAnimationFrames = Math.max(resourceStats.peakAnimationFrames, activeAnimationFrames.size);
  return id;
};
window.cancelAnimationFrame = (id) => {
  activeAnimationFrames.delete(id);
  return nativeCancelAnimationFrame(id);
};
const NativeResizeObserver = window.ResizeObserver;
window.ResizeObserver = class TrackedResizeObserver {
  constructor(callback) {
    this.inner = new NativeResizeObserver(callback);
    this.active = true;
    resourceStats.observersCreated += 1;
    resourceStats.activeObservers += 1;
    resourceStats.peakObservers = Math.max(resourceStats.peakObservers, resourceStats.activeObservers);
  }
  observe(...args) { return this.inner.observe(...args); }
  unobserve(...args) { return this.inner.unobserve(...args); }
  disconnect() {
    if (this.active) {
      this.active = false;
      resourceStats.activeObservers -= 1;
    }
    return this.inner.disconnect();
  }
};
window.__viewerResourceSnapshot = () => ({
  ...resourceStats,
  activeObjectUrls: activeObjectUrls.size,
  activeAnimationFrames: activeAnimationFrames.size,
  activeWebglContexts: activeWebglContexts.size,
  domNodes: document.querySelectorAll("*").length,
  canvases: document.querySelectorAll("canvas").length,
});

const originalGetContext = HTMLCanvasElement.prototype.getContext;
window.__forceWebGLFailure = false;
HTMLCanvasElement.prototype.getContext = function getContext(type, ...args) {
  if (window.__forceWebGLFailure && /^webgl/.test(type)) return null;
  const context = originalGetContext.call(this, type, ...args);
  if (context && /^webgl/.test(type) && !activeWebglContexts.has(context)) {
    activeWebglContexts.add(context);
    resourceStats.webglContextsCreated += 1;
    resourceStats.peakWebglContexts = Math.max(resourceStats.peakWebglContexts, activeWebglContexts.size);
    const nativeGetExtension = context.getExtension.bind(context);
    context.getExtension = (name) => {
      const extension = nativeGetExtension(name);
      if (name !== "WEBGL_lose_context" || !extension) return extension;
      return {
        loseContext() {
          activeWebglContexts.delete(context);
          return extension.loseContext();
        },
        restoreContext() {
          activeWebglContexts.add(context);
          return extension.restoreContext();
        },
      };
    };
  }
  return context;
};

const baseScene = {
  sceneId: "harness-scene",
  nodeId: "node-a",
  sceneReadiness: "ready",
  panorama: {
    revisionId: "pano-revision-a",
    sha256: "f9657801b86b30646efd238187892fb805ecf3714c3ee1c675cea1ac73c1f16a",
    url: "../tests/fixtures/panorama.png",
    alt: "测试用 2:1 全景",
  },
  initialPose: { yawDeg: 15, pitchDeg: -4, fovDeg: 72 },
};

const directions = [
  [0, 0.34], [45, 0.22], [90, 0.14], [135, 0.2],
  [180, 0.28], [225, 0.18], [270, 0.12], [315, 0.24],
].map(([yawDeg, allowedRadiusMeters]) => ({ yawDeg, allowedRadiusMeters }));

const depthScene = {
  ...baseScene,
  sceneMode: "depth_limited_parallax",
  depthArtifact: {
    schemaVersion: "unseen-depth-artifact/1",
    artifactId: "depth-artifact-a",
    sourcePanoramaRevisionId: "pano-revision-a",
    depthMap: {
      url: "../tests/fixtures/depth.png",
      sha256: "5b9698b45775de51ffc8b02c4f94a68dffbc8206cd623aac6f1731d23e4c19fe",
      width: 1024,
      height: 512,
      encoding: "linear-red-v1",
      nearMeters: 0.5,
      farMeters: 12,
    },
    quality: { validFraction: 1 },
    safetyEnvelope: {
      schemaVersion: "unseen-polar-safety-envelope/1",
      absoluteMaxRadiusMeters: 0.4,
      directions,
    },
  },
};

const lookScene = { ...baseScene, sceneMode: "rotation360" };
const yawMarkerScene = {
  ...lookScene,
  sceneId: "yaw-marker-scene",
  panorama: {
    ...lookScene.panorama,
    revisionId: "yaw-marker-revision",
    url: "../tests/fixtures/yaw-markers.png",
    sha256: "d3db7a205d9e789e8f5f4f2a5390897076e4bd2357d5e7057e00a9016fe30e20",
  },
};
const badPanoramaHashScene = {
  ...lookScene,
  panorama: { ...lookScene.panorama, sha256: "0".repeat(64) },
};
const unsupportedRasterScene = {
  ...lookScene,
  panorama: {
    ...lookScene.panorama,
    url: "../tests/fixtures/unsupported.svg",
    sha256: "5e69307e00e2dae8b4562c9358827a4bf126fd1222c014d8b7d39cf284e8b60d",
  },
};
const badDepthScene = {
  ...depthScene,
  depthArtifact: {
    ...depthScene.depthArtifact,
    depthMap: { ...depthScene.depthArtifact.depthMap, sha256: "0".repeat(64) },
  },
};
const invalidDepthScene = {
  ...depthScene,
  depthArtifact: {
    ...depthScene.depthArtifact,
    quality: { validFraction: 0.5 },
  },
};
const viewer = createViewer();
const container = document.querySelector("#viewer");
const summary = document.querySelector("#summary");
const returnRequests = [];
const errors = [];

viewer.addEventListener("statechange", (event) => {
  const state = event.detail;
  summary.textContent = `${state.phase} · ${state.renderMode} · ${state.pose.yawDeg.toFixed(1)}° · x${state.pose.x.toFixed(3)} z${state.pose.z.toFixed(3)}`;
});
viewer.addEventListener("returnrequest", (event) => returnRequests.push(event.detail));
viewer.addEventListener("error", (event) => errors.push(event.detail));

await viewer.mount(container);
try {
  await viewer.updateScene(depthScene);
} catch (error) {
  window.__viewerHarnessBootError = {
    name: error.name,
    code: error.code,
    message: error.message,
    stack: error.stack,
    cause: error.cause && {
      name: error.cause.name,
      code: error.cause.code,
      message: error.cause.message,
      stack: error.cause.stack,
    },
  };
}

document.querySelector("#depth").addEventListener("click", () => viewer.updateScene(depthScene));
document.querySelector("#look").addEventListener("click", () => viewer.updateScene(lookScene));
document.querySelector("#fallback").addEventListener("click", async () => {
  window.__forceWebGLFailure = true;
  await viewer.updateScene(lookScene);
});
document.querySelector("#retry").addEventListener("click", async () => {
  window.__forceWebGLFailure = false;
  await viewer.retry();
});

async function runtimeTimeoutCounterexample(mode = "decoder") {
  const testContainer = document.createElement("div");
  testContainer.style.cssText = "position:fixed;left:0;top:0;width:640px;height:320px;opacity:.01";
  document.body.append(testContainer);
  const timeoutViewer = createViewer();
  const originalFetch = window.fetch;
  const originalCreateImageBitmap = window.createImageBitmap;
  const originalSetTimeout = window.setTimeout.bind(window);
  const originalClearTimeout = window.clearTimeout.bind(window);
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const activeTimers = new Set();
  const activeUrls = new Set();
  let lateBitmapClosed = 0;
  let resolveBitmap;
  let readerCancelCalls = 0;
  let decoderCalls = 0;
  let thrown = null;
  let failureState;
  let recoveredState;
  let failureFocus;
  let recoveryFocus;
  let failureElapsedMs;
  let decoderCallsAtFailure;
  const depthMode = mode === "depth-decoder";
  const fixtureUrl = depthMode ? "../tests/fixtures/depth.png" : "../tests/fixtures/panorama.png";
  const fixtureBytes = await (await originalFetch.call(window, fixtureUrl)).arrayBuffer();
  const fixtureSha = depthMode
    ? "5b9698b45775de51ffc8b02c4f94a68dffbc8206cd623aac6f1731d23e4c19fe"
    : "f9657801b86b30646efd238187892fb805ecf3714c3ee1c675cea1ac73c1f16a";
  const startedAt = performance.now();
  try {
    await timeoutViewer.mount(testContainer, lookScene);
    testContainer.querySelector(".unseen-viewer__canvas").focus();
    timeoutViewer.options.assetLoadTimeoutMs = 2_000;
    window.setTimeout = (callback, milliseconds, ...args) => {
      let id;
      id = originalSetTimeout(() => {
        activeTimers.delete(id);
        callback(...args);
      }, milliseconds);
      activeTimers.add(id);
      return id;
    };
    window.clearTimeout = (id) => {
      activeTimers.delete(id);
      return originalClearTimeout(id);
    };
    URL.createObjectURL = (blob) => {
      const value = originalCreateObjectURL.call(URL, blob);
      activeUrls.add(value);
      return value;
    };
    URL.revokeObjectURL = (value) => {
      activeUrls.delete(value);
      return originalRevokeObjectURL.call(URL, value);
    };
    window.fetch = (input, init) => {
      if (!String(input).includes("__hung_asset__.png")) return originalFetch.call(window, input, init);
      if (mode === "fetch") return new Promise(() => {});
      if (mode === "body") {
        const body = new ReadableStream({
          pull: () => new Promise(() => {}),
          cancel: () => { readerCancelCalls += 1; },
        });
        return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "image/png" } }));
      }
      return Promise.resolve(new Response(fixtureBytes.slice(0), { status: 200, headers: { "content-type": "image/png" } }));
    };
    const hangAtDecoderCall = depthMode ? 2 : 1;
    const injectDecoderHang = mode === "decoder" || depthMode;
    window.createImageBitmap = (blob, options) => {
      decoderCalls += 1;
      if (!injectDecoderHang || decoderCalls !== hangAtDecoderCall) {
        return originalCreateImageBitmap.call(window, blob, options);
      }
      return new Promise((resolve) => {
        resolveBitmap = () => resolve({
          width: 1024,
          height: 512,
          close: () => { lateBitmapClosed += 1; },
        });
      });
    };
    const timeoutScene = depthMode
      ? {
          ...depthScene,
          sceneId: "timeout-depth-scene",
          depthArtifact: {
            ...depthScene.depthArtifact,
            depthMap: {
              ...depthScene.depthArtifact.depthMap,
              url: "/__hung_asset__.png",
              sha256: fixtureSha,
            },
          },
        }
      : {
          ...lookScene,
          sceneId: `timeout-${mode}-scene`,
          panorama: { ...lookScene.panorama, sha256: fixtureSha, url: "/__hung_asset__.png" },
        };
    const failureStartedAt = performance.now();
    try {
      await timeoutViewer.updateScene(timeoutScene);
    } catch (error) {
      thrown = { code: error.code, message: error.message };
    }
    failureElapsedMs = performance.now() - failureStartedAt;
    decoderCallsAtFailure = decoderCalls;
    failureState = timeoutViewer.getState();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    failureFocus = activeTarget(testContainer);
    resolveBitmap?.();
    await Promise.resolve();
    await Promise.resolve();
    let hostRecovery;
    const onRetryRequest = (event) => {
      timeoutViewer.removeEventListener("retryrequest", onRetryRequest);
      event.preventDefault();
      hostRecovery = timeoutViewer.updateScene(depthMode ? depthScene : lookScene);
    };
    timeoutViewer.addEventListener("retryrequest", onRetryRequest);
    testContainer.querySelector("[data-action=retry]").click();
    recoveredState = await hostRecovery;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    recoveryFocus = activeTarget(testContainer);
    timeoutViewer.dispose();
    await new Promise((resolve) => originalSetTimeout(resolve, 0));
    return {
      elapsedMs: performance.now() - startedAt,
      failureElapsedMs,
      thrown,
      phase: failureState.phase,
      renderMode: failureState.renderMode,
      failure: failureState.failure,
      retryVisible: failureFocus === "retry",
      failureFocus,
      recoveredRenderMode: recoveredState.renderMode,
      recoveryFocus,
      activeTimers: activeTimers.size,
      activeObjectUrls: activeUrls.size,
      readerCancelCalls,
      decoderCalls,
      decoderCallsAtFailure,
      lateBitmapClosed,
      roots: testContainer.querySelectorAll(".unseen-viewer").length,
      canvases: testContainer.querySelectorAll("canvas").length,
      gpu: Boolean(timeoutViewer._gl || timeoutViewer._gpu),
      retainedAssets: timeoutViewer._assets.length,
    };
  } finally {
    timeoutViewer.dispose();
    for (const id of activeTimers) originalClearTimeout(id);
    for (const url of activeUrls) originalRevokeObjectURL.call(URL, url);
    window.fetch = originalFetch;
    window.createImageBitmap = originalCreateImageBitmap;
    window.setTimeout = originalSetTimeout;
    window.clearTimeout = originalClearTimeout;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    testContainer.remove();
  }
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function activeTarget(root) {
  const active = document.activeElement;
  if (active === root.querySelector(".unseen-viewer__canvas")) return "canvas";
  if (active === root.querySelector("[data-action=retry]")) return "retry";
  if (active === root.querySelector("[role=status]")) return "status";
  return active?.id || active?.tagName?.toLowerCase() || null;
}

async function retryFocusCounterexample() {
  const testContainer = document.createElement("div");
  testContainer.style.cssText = "position:fixed;left:0;top:0;width:640px;height:320px;opacity:.01";
  document.body.append(testContainer);
  const focusViewer = createViewer();
  try {
    await focusViewer.mount(testContainer, lookScene);
    testContainer.querySelector(".unseen-viewer__canvas").focus();
    const beforeFailure = activeTarget(testContainer);
    let firstFailure;
    try {
      await focusViewer.updateScene(badPanoramaHashScene);
    } catch (error) {
      firstFailure = error.code;
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const afterProgrammaticFailure = activeTarget(testContainer);
    const onRetryRequest = (event) => {
      focusViewer.removeEventListener("retryrequest", onRetryRequest);
      event.preventDefault();
      focusViewer.updateScene({
        ...lookScene,
        panorama: {
          ...lookScene.panorama,
          url: "../tests/fixtures/square.png",
          sha256: "2e1ddc6e696f2528a6eae10c4331d3eea4252fb946415c8787a9a622ec1d836b",
        },
      }).catch(() => {});
    };
    focusViewer.addEventListener("retryrequest", onRetryRequest);
    testContainer.querySelector("[data-action=retry]").click();
    const deadline = performance.now() + 4_000;
    while (focusViewer.getState().failure?.code !== "panorama_ratio_invalid" && performance.now() < deadline) await wait(10);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      firstFailure,
      beforeFailure,
      afterProgrammaticFailure,
      secondFailure: focusViewer.getState().failure?.code,
      retryHidden: testContainer.querySelector("[data-action=retry]").hidden,
      afterNonRetryableFailure: activeTarget(testContainer),
    };
  } finally {
    focusViewer.dispose();
    testContainer.remove();
  }
}

async function signedUrlRetryCounterexample() {
  const testContainer = document.createElement("div");
  testContainer.style.cssText = "position:fixed;left:0;top:0;width:640px;height:320px;opacity:.01";
  document.body.append(testContainer);
  const signedViewer = createViewer();
  const originalFetch = window.fetch;
  let expiredFetches = 0;
  let eventDetail = null;
  let defaultPrevented = false;
  let hostUpdate = null;
  const expiredScene = {
    ...lookScene,
    sceneId: "signed-scene",
    panorama: { ...lookScene.panorama, url: "/__expired_signed_panorama__.svg" },
  };
  const refreshedScene = {
    ...expiredScene,
    panorama: { ...expiredScene.panorama, url: "../tests/fixtures/panorama.png" },
  };
  try {
    window.fetch = (input, init) => {
      if (String(input).includes("__expired_signed_panorama__")) {
        expiredFetches += 1;
        return Promise.resolve(new Response("expired", { status: 403 }));
      }
      return originalFetch.call(window, input, init);
    };
    await signedViewer.mount(testContainer);
    let initialFailure;
    try {
      await signedViewer.updateScene(expiredScene);
    } catch (error) {
      initialFailure = error.code;
    }
    const onRetryRequest = (event) => {
      signedViewer.removeEventListener("retryrequest", onRetryRequest);
      eventDetail = event.detail;
      event.preventDefault();
      defaultPrevented = event.defaultPrevented;
      hostUpdate = signedViewer.updateScene(refreshedScene);
    };
    signedViewer.addEventListener("retryrequest", onRetryRequest);
    const retryButton = testContainer.querySelector("[data-action=retry]");
    retryButton.focus();
    retryButton.click();
    const recovered = await hostUpdate;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      initialFailure,
      eventDetail,
      defaultPrevented,
      expiredFetches,
      renderMode: recovered.renderMode,
      panoramaRevisionId: recovered.panoramaRevisionId,
      activeAfterRecovery: activeTarget(testContainer),
    };
  } finally {
    window.fetch = originalFetch;
    signedViewer.dispose();
    testContainer.remove();
  }
}

async function focusCancellationCounterexample() {
  const testContainer = document.createElement("div");
  testContainer.style.cssText = "position:fixed;left:0;top:0;width:640px;height:320px;opacity:.01";
  const sentinel = document.createElement("button");
  sentinel.id = "focus-cancellation-sentinel";
  sentinel.textContent = "sentinel";
  document.body.append(testContainer, sentinel);
  const cancellationViewer = createViewer();
  try {
    await cancellationViewer.mount(testContainer, lookScene);
    testContainer.querySelector(".unseen-viewer__canvas").focus();
    try { await cancellationViewer.updateScene(badPanoramaHashScene); } catch {}
    cancellationViewer.dispose();
    sentinel.focus();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const afterDispose = document.activeElement.id;

    await cancellationViewer.mount(testContainer, lookScene);
    testContainer.querySelector(".unseen-viewer__canvas").focus();
    try { await cancellationViewer.updateScene(badPanoramaHashScene); } catch {}
    sentinel.focus();
    const superseding = cancellationViewer.updateScene(lookScene);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const duringSupersede = document.activeElement.id;
    await superseding;
    const afterSupersede = document.activeElement.id;
    return { afterDispose, duringSupersede, afterSupersede };
  } finally {
    cancellationViewer.dispose();
    testContainer.remove();
    sentinel.remove();
  }
}

async function hashBeforeDecodeCounterexample() {
  const testContainer = document.createElement("div");
  testContainer.style.cssText = "position:fixed;left:-10000px;top:0;width:640px;height:320px";
  document.body.append(testContainer);
  const testViewer = createViewer();
  const originalCreateImageBitmap = window.createImageBitmap;
  let decoderCalls = 0;
  try {
    window.createImageBitmap = (...args) => {
      decoderCalls += 1;
      return originalCreateImageBitmap.apply(window, args);
    };
    await testViewer.mount(testContainer);
    let code;
    try { await testViewer.updateScene(badPanoramaHashScene); }
    catch (error) { code = error.code; }
    return { code, decoderCalls, state: testViewer.getState() };
  } finally {
    window.createImageBitmap = originalCreateImageBitmap;
    testViewer.dispose();
    testContainer.remove();
  }
}

async function gpuFailureCounterexample(mode) {
  const testContainer = document.createElement("div");
  testContainer.style.cssText = "position:fixed;left:-10000px;top:0;width:640px;height:320px";
  document.body.append(testContainer);
  const testViewer = createViewer();
  const trackedGetContext = HTMLCanvasElement.prototype.getContext;
  const created = { shader: new Set(), program: new Set(), buffer: new Set(), texture: new Set() };
  const deleted = { shader: new Set(), program: new Set(), buffer: new Set(), texture: new Set() };
  let rawGl;
  let textureUploads = 0;
  let injectedTextureError = false;
  try {
    HTMLCanvasElement.prototype.getContext = function getInjectedContext(type, ...args) {
      const context = trackedGetContext.call(this, type, ...args);
      if (!context || !/^webgl/.test(type)) return context;
      rawGl = context;
      return new Proxy(context, {
        get(target, property) {
          if (property === "getExtension") return () => null;
          if (property === "createShader") return (...values) => { const value=target.createShader(...values); if(value) created.shader.add(value); return value; };
          if (property === "createProgram") return (...values) => { const value=target.createProgram(...values); if(value) created.program.add(value); return value; };
          if (property === "createBuffer") return (...values) => { const value=target.createBuffer(...values); if(value) created.buffer.add(value); return value; };
          if (property === "createTexture") return (...values) => { const value=target.createTexture(...values); if(value) created.texture.add(value); return value; };
          if (property === "deleteShader") return (value) => { deleted.shader.add(value); return target.deleteShader(value); };
          if (property === "deleteProgram") return (value) => { deleted.program.add(value); return target.deleteProgram(value); };
          if (property === "deleteBuffer") return (value) => { deleted.buffer.add(value); return target.deleteBuffer(value); };
          if (property === "deleteTexture") return (value) => { deleted.texture.add(value); return target.deleteTexture(value); };
          if (property === "getProgramParameter" && mode === "link") return (program, name) => name === target.LINK_STATUS ? false : target.getProgramParameter(program, name);
          if (property === "texImage2D" && mode === "second-texture") return (...values) => {
            textureUploads += 1;
            target.texImage2D(...values);
            if (textureUploads === 2) injectedTextureError = true;
          };
          if (property === "getError" && mode === "second-texture") return () => {
            if (injectedTextureError) { injectedTextureError = false; return target.INVALID_OPERATION; }
            return target.getError();
          };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    await testViewer.mount(testContainer);
    const failed = await testViewer.updateScene(depthScene);
    const counts = Object.fromEntries(Object.keys(created).map((kind) => [kind, { created: created[kind].size, deleted: deleted[kind].size }]));
    HTMLCanvasElement.prototype.getContext = trackedGetContext;
    if (rawGl) activeWebglContexts.delete(rawGl);
    const recovered = await testViewer.retry();
    return { mode, failure: failed.failure, renderMode: failed.renderMode, counts, recovered: recovered.renderMode };
  } finally {
    HTMLCanvasElement.prototype.getContext = trackedGetContext;
    if (rawGl) activeWebglContexts.delete(rawGl);
    testViewer.dispose();
    testContainer.remove();
  }
}

function readCenterMarkerYaw() {
  const gl = viewer._gl;
  viewer._render();
  const pixel = new Uint8Array(4);
  gl.readPixels(Math.floor(viewer._canvas.width / 2), Math.floor(viewer._canvas.height / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  const x = pixel[0] * 256 + pixel[1];
  return { yawDeg: x / 4, rgba: [...pixel] };
}

async function yawMarkerAt(yawDeg, mode = "focus") {
  if (mode === "initial") {
    await viewer.updateScene({ ...yawMarkerScene, initialPose: { yawDeg, pitchDeg: 0, fovDeg: 72 } });
  } else {
    if (viewer.getState().sceneId !== yawMarkerScene.sceneId) await viewer.updateScene(yawMarkerScene);
    await viewer.focusPose({
      nodeId: "node-a",
      photoId: `yaw-photo-${yawDeg}`,
      photoAssetId: `yaw-photo-asset-${yawDeg}`,
      photoAssetVersion: 1,
      photoRawSha256: "5".repeat(64),
      placementRevisionId: `yaw-placement-${yawDeg}`,
      panoramaRevisionId: "yaw-marker-revision",
      yawDeg,
      pitchDeg: 0,
    }, { animate: false });
  }
  return { state: viewer.getState(), marker: readCenterMarkerYaw() };
}

async function focusRenderFailureCounterexample() {
  const testContainer = document.createElement("div");
  testContainer.style.cssText = "position:fixed;left:-10000px;top:0;width:640px;height:320px";
  document.body.append(testContainer);
  const testViewer = createViewer();
  let rawGl = null;
  const settleWithin = (promise, milliseconds) => Promise.race([
    promise.then(
      () => ({ result: "resolved" }),
      (error) => ({ result: "rejected", code: error.code }),
    ),
    wait(milliseconds).then(() => ({ result: "timeout" })),
  ]);
  try {
    await testViewer.mount(testContainer, lookScene);
    testContainer.querySelector(".unseen-viewer__canvas").focus();
    rawGl = testViewer._gl;
    let injectRenderError = true;
    testViewer._gl = new Proxy(rawGl, {
      get(target, property) {
        if (property === "getError") return () => {
          if (injectRenderError) {
            injectRenderError = false;
            return target.INVALID_OPERATION;
          }
          return target.getError();
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const startedAt = performance.now();
    const animated = await settleWithin(testViewer.focusPose({
      nodeId: "node-a",
      photoId: "render-failure-photo",
      photoAssetId: "render-failure-asset",
      photoAssetVersion: 1,
      photoRawSha256: "7".repeat(64),
      placementRevisionId: "render-failure-placement",
      panoramaRevisionId: "pano-revision-a",
      yawDeg: 210,
      pitchDeg: 7,
    }, { animate: true, durationMs: 1_000 }), 1_500);
    const animatedElapsedMs = performance.now() - startedAt;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const fallbackState = testViewer.getState();
    const flatStartedAt = performance.now();
    const flat = await settleWithin(testViewer.focusPose({
      nodeId: "node-a",
      photoId: "flat-photo",
      photoAssetId: "flat-asset",
      photoAssetVersion: 1,
      photoRawSha256: "8".repeat(64),
      placementRevisionId: "flat-placement",
      panoramaRevisionId: "pano-revision-a",
      yawDeg: 0,
    }), 500);
    return {
      animated,
      animatedElapsedMs,
      flat,
      flatElapsedMs: performance.now() - flatStartedAt,
      fallbackState,
      active: activeTarget(testContainer),
      returnHidden: testContainer.querySelector("[data-action=return]").hidden,
      status: testContainer.querySelector("[role=status]").textContent,
    };
  } finally {
    if (rawGl && activeWebglContexts.has(rawGl)) rawGl.getExtension("WEBGL_lose_context")?.loseContext();
    testViewer.dispose();
    testContainer.remove();
  }
}

async function soakStep(index) {
  if (viewer.getState().phase !== "ready") await viewer.updateScene(depthScene);
  await viewer.focusPose({
    nodeId: "node-a",
    photoId: `soak-photo-${index}`,
    photoAssetId: `soak-photo-asset-${index}`,
    photoAssetVersion: 1,
    photoRawSha256: "1".repeat(64),
    placementRevisionId: `soak-placement-${index}`,
    panoramaRevisionId: "pano-revision-a",
    yawDeg: (index * 17) % 360,
    pitchDeg: (index % 11) - 5,
    fovDeg: 68 + index % 9,
  }, { animate: false });
  const canvas = container.querySelector(".unseen-viewer__canvas");
  canvas?.dispatchEvent(new KeyboardEvent("keydown", { key: "w", bubbles: true }));
  await wait(35);
  canvas?.dispatchEvent(new KeyboardEvent("keyup", { key: "w", bubbles: true }));
  container.style.width = index % 2 ? "99%" : "100%";
  window.dispatchEvent(new Event("resize"));
  if (index % 11 === 0) {
    await viewer.updateScene(lookScene);
    await viewer.updateScene(depthScene);
  }
  if (index % 23 === 0) {
    const extension = viewer._gl?.getExtension("WEBGL_lose_context");
    extension?.loseContext();
    const deadline = performance.now() + 2_000;
    while (viewer.getState().renderMode !== "flat_fallback" && performance.now() < deadline) await wait(10);
    await viewer.retry();
  }
  if (index % 37 === 0) {
    viewer.dispose();
    await viewer.mount(container);
    await viewer.updateScene(depthScene);
  }
  if (index % 53 === 0) {
    viewer.dispose();
    await viewer.mount(container, depthScene);
  }
  await wait(40);
  return viewer.getState();
}

async function soakFinalize() {
  container.style.width = "100%";
  window.dispatchEvent(new Event("resize"));
  if (viewer.getState().phase !== "ready" || viewer.getState().renderMode !== "depth_limited_parallax") {
    await viewer.updateScene(depthScene);
  }
  viewer.reset();
  await wait(100);
  return viewer.getState();
}

window.__viewerHarness = {
  viewer,
  depthScene,
  lookScene,
  badDepthScene,
  invalidDepthScene,
  yawMarkerScene,
  badPanoramaHashScene,
  unsupportedRasterScene,
  errors,
  returnRequests,
  state: () => viewer.getState(),
  focus: (pose, options = { animate: false }) => viewer.focusPose(pose, options),
  reset: () => viewer.reset(),
  depth: () => viewer.updateScene(depthScene),
  badDepth: () => viewer.updateScene(badDepthScene),
  invalidDepth: () => viewer.updateScene(invalidDepthScene),
  badPanoramaHash: () => viewer.updateScene(badPanoramaHashScene),
  unsupportedRaster: () => viewer.updateScene(unsupportedRasterScene),
  look: () => viewer.updateScene(lookScene),
  fallback: async () => {
    window.__forceWebGLFailure = true;
    return viewer.updateScene(lookScene);
  },
  retry: async () => {
    window.__forceWebGLFailure = false;
    return viewer.retry();
  },
  loseContext: () => {
    const extension = viewer._gl?.getExtension("WEBGL_lose_context");
    if (!extension) return false;
    extension.loseContext();
    return true;
  },
  remount: async () => {
    viewer.dispose();
    await viewer.mount(container);
    return viewer.updateScene(depthScene);
  },
  runtimeTimeoutCounterexample,
  retryFocusCounterexample,
  signedUrlRetryCounterexample,
  focusCancellationCounterexample,
  hashBeforeDecodeCounterexample,
  gpuFailureCounterexample,
  focusRenderFailureCounterexample,
  yawMarkerAt,
  readCenterMarkerYaw,
  soakStep,
  soakFinalize,
  resourceSnapshot: () => window.__viewerResourceSnapshot(),
};
window.__viewerHarnessReady = true;
