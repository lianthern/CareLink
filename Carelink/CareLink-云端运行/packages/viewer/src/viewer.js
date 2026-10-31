import {
  clampPitch,
  constrainMovement,
  localMovementDelta,
  normalizePose,
  normalizeYaw,
  shortestYawDelta,
} from "./math.js";
import { sha256Hex, validateDepthArtifact } from "./depth.js";
import { VIEWER_STYLES } from "./styles.js";

const MAX_COLOR_BYTES = 32 * 1024 * 1024;
const MAX_DEPTH_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 64 * 1024 * 1024;
const MAX_TEXTURE_EDGE = 4096;
const MAX_TEXTURE_PIXELS = 4096 * 2048;
const DEFAULT_ASSET_LOAD_TIMEOUT_MS = 15_000;
const MIN_ASSET_LOAD_TIMEOUT_MS = 100;
const MAX_ASSET_LOAD_TIMEOUT_MS = 30_000;
const sha256Pattern = /^[a-f0-9]{64}$/;

const VERTEX_SHADER = `
attribute vec2 aPosition;
void main(){gl_Position=vec4(aPosition,0.0,1.0);}
`;

const FRAGMENT_SHADER = `
precision highp float;
uniform sampler2D uColor;
uniform sampler2D uDepth;
uniform vec2 uResolution;
uniform vec2 uTurn;
uniform vec2 uCameraXZ;
uniform float uTanHalfFov;
uniform float uUseDepth;
uniform float uDepthNear;
uniform float uDepthFar;
const float PI=3.141592653589793;
vec2 panoUv(vec3 ray){
  ray=normalize(ray);
  return vec2(fract(atan(ray.x,ray.z)/(2.0*PI)),0.5-asin(clamp(ray.y,-1.0,1.0))/PI);
}
float depthAt(vec3 ray){
  float encoded=texture2D(uDepth,panoUv(ray)).r;
  return mix(uDepthNear,uDepthFar,clamp(encoded,0.0,1.0));
}
void main(){
  vec2 q=(gl_FragCoord.xy/uResolution)*2.0-1.0;
  float aspect=uResolution.x/uResolution.y;
  vec3 ray=normalize(vec3(q.x*aspect*uTanHalfFov,q.y*uTanHalfFov,1.0));
  float cp=cos(uTurn.y),sp=sin(uTurn.y);
  ray=vec3(ray.x,ray.y*cp+ray.z*sp,-ray.y*sp+ray.z*cp);
  float cy=cos(uTurn.x),sy=sin(uTurn.x);
  ray=vec3(ray.x*cy+ray.z*sy,ray.y,-ray.x*sy+ray.z*cy);
  vec3 sampleRay=ray;
  if(uUseDepth>0.5){
    vec3 origin=vec3(uCameraXZ.x,0.0,uCameraXZ.y);
    float along=depthAt(sampleRay);
    for(int index=0;index<4;index++){
      float sceneDepth=depthAt(sampleRay);
      float projected=dot(origin,ray);
      float discriminant=max(0.0,projected*projected-dot(origin,origin)+sceneDepth*sceneDepth);
      along=max(0.001,-projected+sqrt(discriminant));
      sampleRay=normalize(origin+ray*along);
    }
  }
  gl_FragColor=texture2D(uColor,panoUv(sampleRay));
}
`;

class ViewerError extends Error {
  constructor(code, message, retryable = true, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "ViewerError";
    this.code = code;
    this.retryable = retryable;
  }
}

const clone = (value) => typeof structuredClone === "function"
  ? structuredClone(value)
  : JSON.parse(JSON.stringify(value));

function errorDto(error) {
  return {
    code: error?.code || "viewer_unexpected_error",
    message: error?.message || "现场暂时无法显示。",
    retryable: error?.retryable !== false,
  };
}

function validateScene(scene) {
  if (!scene || typeof scene !== "object") {
    throw new ViewerError("scene_invalid", "现场数据无效。", false);
  }
  if (scene.sceneReadiness !== "ready") {
    throw new ViewerError("scene_not_ready", "现场尚未准备好。", true);
  }
  if (!["rotation360", "depth_limited_parallax", "walkable3d"].includes(scene.sceneMode)) {
    throw new ViewerError("scene_mode_invalid", "现场模式无法识别。", false);
  }
  const panorama = scene.panorama;
  if (!panorama || typeof panorama.url !== "string" || !panorama.url ||
      typeof panorama.revisionId !== "string" || !panorama.revisionId ||
      !sha256Pattern.test(panorama.sha256 || "")) {
    throw new ViewerError("panorama_invalid", "全景资源无效。", false);
  }
  return {
    sceneId: typeof scene.sceneId === "string" ? scene.sceneId : null,
    nodeId: typeof scene.nodeId === "string" ? scene.nodeId : null,
    sceneReadiness: scene.sceneReadiness,
    sceneMode: scene.sceneMode,
    panorama: {
      url: panorama.url,
      revisionId: panorama.revisionId,
      sha256: panorama.sha256,
      alt: typeof panorama.alt === "string" ? panorama.alt : "360°现场全景",
    },
    initialPose: normalizePose({ ...scene.initialPose, nodeId: scene.nodeId }),
    depthArtifact: scene.depthArtifact ? clone(scene.depthArtifact) : null,
  };
}

function abortError(signal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}

function raceWithSignal(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", aborted);
      callback(value);
    };
    const aborted = () => finish(reject, abortError(signal));
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

function cancelReader(reader) {
  try {
    const pending = reader.cancel();
    pending?.catch?.(() => {});
  } catch {}
}

async function readResponseBounded(response, maxBytes, signal) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ViewerError("asset_too_large", "现场资源超过浏览器读取上限。", false);
  }
  if (!response.body?.getReader) {
    const bytes = await raceWithSignal(response.arrayBuffer(), signal);
    if (bytes.byteLength > maxBytes) throw new ViewerError("asset_too_large", "现场资源超过浏览器读取上限。", false);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await raceWithSignal(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        cancelReader(reader);
        throw new ViewerError("asset_too_large", "现场资源超过浏览器读取上限。", false);
      }
      chunks.push(value);
    }
  } finally {
    if (signal.aborted) cancelReader(reader);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined.buffer;
}

export function rasterMetadata(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const invalid = () => { throw new ViewerError("asset_metadata_invalid", "现场图片无效。", false); };
  const animated = () => { throw new ViewerError("asset_animation_unsupported", "现场图片格式暂不支持。", false); };
  const chunkType = (offset) => String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  if (bytes.length >= 24 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    let offset = 8;
    let width = 0;
    let height = 0;
    let sawHeader = false;
    let sawImageData = false;
    let sawEnd = false;
    while (offset < bytes.length) {
      if (offset + 12 > bytes.length) invalid();
      const length = view.getUint32(offset);
      const type = chunkType(offset + 4);
      const dataOffset = offset + 8;
      const dataEnd = dataOffset + length;
      const nextOffset = dataEnd + 4;
      if (dataEnd < dataOffset || nextOffset > bytes.length) invalid();
      if (!sawHeader) {
        if (type !== "IHDR" || length !== 13) invalid();
        width = view.getUint32(dataOffset);
        height = view.getUint32(dataOffset + 4);
        sawHeader = true;
      } else if (type === "IHDR") {
        invalid();
      }
      if (type === "acTL") animated();
      if (type === "IDAT") sawImageData = true;
      if (type === "IEND") {
        if (length !== 0) invalid();
        sawEnd = true;
        offset = nextOffset;
        break;
      }
      offset = nextOffset;
    }
    if (!sawHeader || !sawImageData || !sawEnd || offset !== bytes.length) invalid();
    return { format: "png", mime: "image/png", width, height };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      while (bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) invalid();
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) invalid();
      if (sofMarkers.has(marker)) {
        if (length < 7) invalid();
        return { format: "jpeg", mime: "image/jpeg", width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
      }
      offset += length;
    }
    invalid();
  }
  if (bytes.length >= 12 && chunkType(0) === "RIFF" && chunkType(8) === "WEBP") {
    const declaredEnd = view.getUint32(4, true) + 8;
    if (declaredEnd !== bytes.length) invalid();
    let offset = 12;
    let metadata = null;
    let sawExtendedHeader = false;
    let sawImageData = false;
    while (offset < declaredEnd) {
      if (offset + 8 > declaredEnd) invalid();
      const type = chunkType(offset);
      const length = view.getUint32(offset + 4, true);
      const dataOffset = offset + 8;
      const dataEnd = dataOffset + length;
      const nextOffset = dataEnd + (length & 1);
      if (dataEnd < dataOffset || nextOffset > declaredEnd) invalid();
      if (type === "ANIM" || type === "ANMF") animated();
      if (type === "VP8X") {
        if (offset !== 12 || sawExtendedHeader || length !== 10) invalid();
        sawExtendedHeader = true;
        if (bytes[dataOffset] & 0x02) animated();
        metadata = {
          format: "webp",
          mime: "image/webp",
          width: 1 + bytes[dataOffset + 4] + bytes[dataOffset + 5] * 256 + bytes[dataOffset + 6] * 65536,
          height: 1 + bytes[dataOffset + 7] + bytes[dataOffset + 8] * 256 + bytes[dataOffset + 9] * 65536,
        };
      } else if (type === "VP8L") {
        if (sawImageData || length < 5 || bytes[dataOffset] !== 0x2f) invalid();
        sawImageData = true;
        metadata ||= {
          format: "webp",
          mime: "image/webp",
          width: 1 + bytes[dataOffset + 1] + ((bytes[dataOffset + 2] & 0x3f) << 8),
          height: 1 + (bytes[dataOffset + 2] >> 6) + (bytes[dataOffset + 3] << 2) + ((bytes[dataOffset + 4] & 0x0f) << 10),
        };
      } else if (type === "VP8 ") {
        if (sawImageData || length < 10 || bytes[dataOffset + 3] !== 0x9d ||
            bytes[dataOffset + 4] !== 0x01 || bytes[dataOffset + 5] !== 0x2a) invalid();
        sawImageData = true;
        metadata ||= {
          format: "webp",
          mime: "image/webp",
          width: view.getUint16(dataOffset + 6, true) & 0x3fff,
          height: view.getUint16(dataOffset + 8, true) & 0x3fff,
        };
      }
      offset = nextOffset;
    }
    if (offset !== declaredEnd || !metadata || !sawImageData) invalid();
    return metadata;
  }
  throw new ViewerError("asset_format_unsupported", "现场图片格式暂不支持。", false);
}

function validateRasterMetadata(metadata, { expectedWidth, expectedHeight, panorama }) {
  const { width, height } = metadata;
  if (!width || !height || width * height > MAX_SOURCE_PIXELS || width > 16384 || height > 8192) {
    throw new ViewerError("asset_dimensions_invalid", "现场图片尺寸无效。", false);
  }
  if (panorama && Math.abs(width / height - 2) > 0.02) {
    throw new ViewerError("panorama_ratio_invalid", "现场图片比例无效。", false);
  }
  if (expectedWidth && expectedHeight && (width !== expectedWidth || height !== expectedHeight)) {
    throw new ViewerError("depth_dimensions_mismatch", "暂时只能环视现场。", false);
  }
}

async function imageElementFromBlob(blobUrl, signal) {
  const image = new Image();
  image.decoding = "async";
  image.src = blobUrl;
  const aborted = () => { image.src = ""; };
  signal.addEventListener("abort", aborted, { once: true });
  try {
    await raceWithSignal(image.decode(), signal);
  } catch (cause) {
    if (signal.aborted) throw abortError(signal);
    throw new ViewerError("asset_decode_failed", "现场图片无法解码。", true, cause);
  } finally {
    signal.removeEventListener("abort", aborted);
  }
  return image;
}

async function decodeRaster(url, {
  maxBytes,
  expectedSha256,
  hashMismatchCode,
  hashMismatchMessage,
  expectedWidth,
  expectedHeight,
  panorama = false,
}, loadSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const relayAbort = () => controller.abort(loadSignal.reason);
  if (loadSignal.aborted) relayAbort();
  else loadSignal.addEventListener("abort", relayAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new ViewerError("asset_timeout", "现场加载超时，请重试。", true));
  }, timeoutMs);
  const signal = controller.signal;
  let objectUrl = null;
  let close = () => {};
  try {
    let response;
    try {
      const fetchPromise = fetch(url, { signal, cache: "no-store", credentials: "same-origin" });
      fetchPromise.then((lateResponse) => {
        if (!signal.aborted) return;
        try { lateResponse.body?.cancel()?.catch?.(() => {}); } catch {}
      }, () => {});
      response = await raceWithSignal(fetchPromise, signal);
    } catch (cause) {
      if (signal.aborted) throw abortError(signal);
      throw new ViewerError("asset_fetch_failed", "现场资源读取失败。", true, cause);
    }
    if (!response.ok) throw new ViewerError("asset_fetch_failed", "现场暂时无法打开，请重试。", true);
    const bytes = await readResponseBounded(response, maxBytes, signal);
    const digest = await sha256Hex(bytes);
    if (signal.aborted) throw abortError(signal);
    if (digest !== expectedSha256) {
      throw new ViewerError(hashMismatchCode, hashMismatchMessage, true);
    }
    const metadata = rasterMetadata(bytes);
    validateRasterMetadata(metadata, { expectedWidth, expectedHeight, panorama });
    const blob = new Blob([bytes], { type: metadata.mime });
    objectUrl = URL.createObjectURL(blob);
    let source;
    let width;
    let height;
    if (typeof createImageBitmap === "function" && blob.type !== "image/svg+xml") {
      const bitmapPromise = Promise.resolve().then(() => createImageBitmap(blob, { imageOrientation: "from-image" }));
      bitmapPromise.then((lateBitmap) => {
        if (signal.aborted) lateBitmap.close?.();
      }, () => {});
      const decoded = await raceWithSignal(bitmapPromise, signal);
      width = decoded.width;
      height = decoded.height;
      source = decoded;
      close = () => decoded.close();
    } else {
      source = await imageElementFromBlob(objectUrl, signal);
      width = source.naturalWidth;
      height = source.naturalHeight;
    }
    if (width !== metadata.width || height !== metadata.height) {
      throw new ViewerError("asset_dimensions_mismatch", "现场图片无效。", false);
    }

    const scale = Math.min(1, MAX_TEXTURE_EDGE / width, MAX_TEXTURE_EDGE / height, Math.sqrt(MAX_TEXTURE_PIXELS / (width * height)));
    if (scale < 1) {
      const resizedWidth = Math.max(2, Math.floor(width * scale));
      const resizedHeight = Math.max(2, Math.floor(height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = resizedWidth;
      canvas.height = resizedHeight;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new ViewerError("asset_resize_failed", "现场图片暂时无法打开。", true);
      context.drawImage(source, 0, 0, resizedWidth, resizedHeight);
      close();
      source = canvas;
      close = () => { canvas.width = 1; canvas.height = 1; };
    }
    return { bytes, blob, objectUrl, source, width, height, close };
  } catch (error) {
    close();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    if (timedOut) throw new ViewerError("asset_timeout", "现场加载超时，请重试。", true, error);
    if (loadSignal.aborted) throw new DOMException("Aborted", "AbortError");
    throw error;
  } finally {
    clearTimeout(timer);
    loadSignal.removeEventListener("abort", relayAbort);
  }
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new ViewerError("webgl_resource_failed", "当前设备无法环视，已显示平面图。", true);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const detail = gl.getShaderInfoLog(shader) || "shader compile failed";
    gl.deleteShader(shader);
    throw new ViewerError("webgl_shader_failed", "当前设备无法环视，已显示平面图。", true, new Error(detail));
  }
  return shader;
}

export class UnseenViewer extends EventTarget {
  constructor(options = {}) {
    super();
    const requestedTimeout = Number(options.assetLoadTimeoutMs);
    this.options = {
      assetLoadTimeoutMs: Number.isFinite(requestedTimeout)
        ? Math.max(MIN_ASSET_LOAD_TIMEOUT_MS, Math.min(MAX_ASSET_LOAD_TIMEOUT_MS, requestedTimeout))
        : DEFAULT_ASSET_LOAD_TIMEOUT_MS,
    };
    this._container = null;
    this._style = null;
    this._root = null;
    this._canvas = null;
    this._fallback = null;
    this._status = null;
    this._returnButton = null;
    this._joystick = null;
    this._mountAbort = null;
    this._canvasAbort = null;
    this._loadAbort = null;
    this._retryRequestedFocus = false;
    this._sceneGeneration = 0;
    this._resizeObserver = null;
    this._gl = null;
    this._gpu = null;
    this._assets = [];
    this._scene = null;
    this._initialPose = normalizePose();
    this._focus = null;
    this._animation = 0;
    this._animationResolve = null;
    this._animationReject = null;
    this._movementFrame = 0;
    this._movementKeys = new Set();
    this._joystickVector = { x: 0, y: 0 };
    this._lastMovementAt = 0;
    this._pointerState = new Map();
    this._pinchDistance = 0;
    this._safetyEnvelope = null;
    this._state = {
      schemaVersion: "unseen-viewer-state/1",
      phase: "idle",
      renderMode: "flat_fallback",
      requestedSceneMode: null,
      sceneId: null,
      panoramaRevisionId: null,
      capability: this._capability(false, false),
      pose: { ...this._initialPose, x: 0, z: 0 },
      focus: null,
      failure: null,
      metrics: { firstFrameMs: null, textureWidth: null, textureHeight: null },
    };
  }

  _capability(webgl, depth) {
    return {
      webgl: Boolean(webgl),
      sphericalView: Boolean(webgl),
      depthArtifact: Boolean(depth),
      translation: Boolean(depth),
      keyboard: Boolean(webgl),
      touch: Boolean(webgl && typeof PointerEvent !== "undefined"),
      fullscreen: typeof document !== "undefined" && typeof Element !== "undefined" &&
        Boolean(document.fullscreenEnabled) && typeof Element.prototype.requestFullscreen === "function" &&
        typeof document.exitFullscreen === "function",
    };
  }

  getState() {
    return clone(this._state);
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail: clone(detail) }));
  }

  _emitCancelable(type, detail) {
    return this.dispatchEvent(new CustomEvent(type, {
      detail: clone(detail),
      cancelable: true,
    }));
  }

  _setState(patch, announce) {
    this._state = { ...this._state, ...patch };
    if (this._root) {
      this._root.dataset.renderMode = this._state.renderMode;
      this._root.dataset.depthReady = String(this._state.capability.translation);
    }
    if (announce && this._status) this._status.textContent = announce;
    this._emit("statechange", this._state);
  }

  mount(container, scene) {
    if (!(container instanceof Element)) throw new TypeError("mount(container) requires a DOM Element");
    if (this._root) this.dispose();
    this._container = container;
    this._mountAbort = new AbortController();
    container.replaceChildren();
    const style = document.createElement("style");
    style.textContent = VIEWER_STYLES;
    const root = document.createElement("section");
    root.className = "unseen-viewer";
    root.dataset.renderMode = "flat_fallback";
    root.dataset.depthReady = "false";
    root.innerHTML = `
      <div class="unseen-viewer__stage">
        <img class="unseen-viewer__fallback" alt="" draggable="false">
      </div>
      <div class="unseen-viewer__hud">
        <div class="unseen-viewer__top">
          <div class="unseen-viewer__status" role="status" aria-live="polite" tabindex="-1">现场尚未加载</div>
          <div class="unseen-viewer__controls">
            <button type="button" data-action="return" hidden>返回照片</button>
            <button type="button" data-action="retry" hidden>重试</button>
            <button type="button" data-action="reset">重置</button>
            <button type="button" data-action="fullscreen">全屏</button>
          </div>
        </div>
        <div class="unseen-viewer__bottom">
          <div class="unseen-viewer__directions" aria-label="现场方向控制">
            <button type="button" data-direction="up" aria-label="视角向上">↑</button>
            <button type="button" data-direction="left" aria-label="视角向左">←</button>
            <button type="button" data-direction="down" aria-label="视角向下">↓</button>
            <button type="button" data-direction="right" aria-label="视角向右">→</button>
          </div>
          <div class="unseen-viewer__translation-controls" role="group" aria-label="现场四向平移控制">
            <button type="button" data-translation="forward" aria-label="向前平移">前</button>
            <button type="button" data-translation="left" aria-label="向左平移">左</button>
            <button type="button" data-translation="backward" aria-label="向后平移">后</button>
            <button type="button" data-translation="right" aria-label="向右平移">右</button>
          </div>
        </div>
      </div>
      <div class="unseen-viewer__joystick" aria-hidden="true"></div>
      <p class="unseen-viewer__sr" data-direction-live aria-live="polite"></p>
    `;
    container.append(style, root);
    this._style = style;
    this._root = root;
    this._fallback = root.querySelector("img");
    this._status = root.querySelector("[role=status]");
    this._returnButton = root.querySelector("[data-action=return]");
    this._joystick = root.querySelector(".unseen-viewer__joystick");
    root.querySelector("[data-action=fullscreen]").hidden = !this._capability(false, false).fullscreen;
    this._bindMountEvents();
    this._resizeObserver = new ResizeObserver(() => this._resizeAndRender());
    this._resizeObserver.observe(root);
    this._initialPose = normalizePose();
    this._focus = null;
    this._setState({
      phase: "idle",
      renderMode: "flat_fallback",
      requestedSceneMode: null,
      sceneId: null,
      panoramaRevisionId: null,
      capability: this._capability(false, false),
      pose: { ...this._initialPose, x: 0, z: 0 },
      focus: null,
      failure: null,
      metrics: { firstFrameMs: null, textureWidth: null, textureHeight: null },
    }, "现场尚未加载");
    return scene ? this.updateScene(scene) : Promise.resolve(this.getState());
  }

  _bindMountEvents() {
    const signal = this._mountAbort.signal;
    this._root.addEventListener("click", (event) => {
      const action = event.target.closest("button")?.dataset.action;
      if (action === "reset") this.reset();
      // updateScene already emits a typed error/state; catch here only prevents
      // a button-initiated retry failure from becoming an unhandled rejection.
      if (action === "retry") {
        this._retryRequestedFocus = true;
        const useDefaultRetry = this._state.failure ? this._emitCancelable("retryrequest", {
          failure: this._state.failure,
          sceneId: this._state.sceneId,
          panoramaRevisionId: this._state.panoramaRevisionId,
        }) : true;
        if (useDefaultRetry) this.retry().catch(() => {});
      }
      if (action === "return") this._requestReturn();
      if (action === "fullscreen") this._toggleFullscreen();
      const direction = event.target.closest("button")?.dataset.direction;
      if (direction) this._nudgeDirection(direction);
      const translation = event.target.closest("button")?.dataset.translation;
      if (translation && this._state.capability.translation) {
        this._cancelAnimation();
        const [strafe, forward, label] = {
          forward: [0, 0.04, "向前"],
          backward: [0, -0.04, "向后"],
          left: [-0.04, 0, "向左"],
          right: [0.04, 0, "向右"],
        }[translation];
        this._move(strafe, forward, label);
      }
    }, { signal });
    document.addEventListener("fullscreenchange", () => {
      const button = this._root?.querySelector("[data-action=fullscreen]");
      if (button) button.textContent = document.fullscreenElement === this._root ? "退出全屏" : "全屏";
      this._resizeAndRender();
    }, { signal });
    window.addEventListener("resize", () => this._resizeAndRender(), { signal });
    window.addEventListener("orientationchange", () => this._resizeAndRender(), { signal });
    this._bindJoystick(signal);
  }

  _bindJoystick(signal) {
    const update = (event) => {
      const rect = this._joystick.getBoundingClientRect();
      const x = (event.clientX - (rect.left + rect.width / 2)) / (rect.width / 2);
      const y = (event.clientY - (rect.top + rect.height / 2)) / (rect.height / 2);
      const length = Math.max(1, Math.hypot(x, y));
      this._joystickVector = { x: x / length, y: y / length };
      this._joystick.style.setProperty("--stick-x", `${this._joystickVector.x * 30}px`);
      this._joystick.style.setProperty("--stick-y", `${this._joystickVector.y * 30}px`);
      this._startMovementLoop();
    };
    const stop = () => {
      this._joystickVector = { x: 0, y: 0 };
      this._joystick.style.setProperty("--stick-x", "0px");
      this._joystick.style.setProperty("--stick-y", "0px");
    };
    this._joystick.addEventListener("pointerdown", (event) => {
      if (!this._state.capability.translation) return;
      event.preventDefault();
      this._cancelAnimation();
      this._joystick.setPointerCapture(event.pointerId);
      update(event);
    }, { signal });
    this._joystick.addEventListener("pointermove", (event) => {
      if (this._joystick.hasPointerCapture(event.pointerId)) update(event);
    }, { signal });
    this._joystick.addEventListener("pointerup", stop, { signal });
    this._joystick.addEventListener("pointercancel", stop, { signal });
    this._joystick.addEventListener("lostpointercapture", stop, { signal });
  }

  async updateScene(scene) {
    if (!this._root) throw new ViewerError("viewer_not_mounted", "Viewer 尚未 mount。", false);
    const sceneGeneration = ++this._sceneGeneration;
    const focusWasInViewer = Boolean(this._root.contains(document.activeElement));
    const normalized = validateScene(scene);
    this._cancelAnimation(false);
    this._stopMovementLoop();
    this._loadAbort?.abort();
    this._loadAbort = new AbortController();
    const signal = this._loadAbort.signal;
    this._cleanupGpu();
    this._cleanupAssets();
    this._scene = normalized;
    this._initialPose = normalized.initialPose;
    this._focus = null;
    this._safetyEnvelope = null;
    this._returnButton.hidden = true;
    this._root.querySelector("[data-action=retry]").hidden = true;
    this._fallback.hidden = false;
    this._fallback.removeAttribute("src");
    const startedAt = performance.now();
    this._setState({
      phase: "loading",
      requestedSceneMode: normalized.sceneMode,
      sceneId: normalized.sceneId,
      panoramaRevisionId: normalized.panorama.revisionId,
      renderMode: "flat_fallback",
      capability: this._capability(false, false),
      pose: { ...normalized.initialPose, x: 0, z: 0 },
      focus: null,
      failure: null,
      metrics: { firstFrameMs: null, textureWidth: null, textureHeight: null },
    }, "正在加载现场…");

    try {
      const color = await decodeRaster(normalized.panorama.url, {
        maxBytes: MAX_COLOR_BYTES,
        expectedSha256: normalized.panorama.sha256,
        hashMismatchCode: "panorama_hash_mismatch",
        hashMismatchMessage: "现场图片校验失败，请重试。",
        panorama: true,
      }, signal, this.options.assetLoadTimeoutMs);
      this._assets.push(color);
      this._fallback.src = color.objectUrl;
      this._fallback.alt = normalized.panorama.alt;

      let depth = null;
      let depthFailure = null;
      if (normalized.sceneMode === "depth_limited_parallax") {
        const validation = validateDepthArtifact(normalized.depthArtifact, normalized.panorama.revisionId);
        if (!validation.ok) {
          depthFailure = new ViewerError(validation.code, "暂时只能环视现场。", false);
        } else {
          try {
            depth = await decodeRaster(validation.value.depthMap.url, {
              maxBytes: MAX_DEPTH_BYTES,
              expectedSha256: validation.value.depthMap.sha256,
              hashMismatchCode: "depth_hash_mismatch",
              hashMismatchMessage: "暂时只能环视现场。",
              expectedWidth: validation.value.depthMap.width,
              expectedHeight: validation.value.depthMap.height,
            }, signal, this.options.assetLoadTimeoutMs);
            depth.meta = validation.value;
            this._assets.push(depth);
            this._safetyEnvelope = validation.value.safetyEnvelope;
          } catch (error) {
            depth?.close();
            if (depth?.objectUrl) URL.revokeObjectURL(depth.objectUrl);
            if (error?.name === "AbortError") throw error;
            depth = null;
            depthFailure = error instanceof ViewerError
              ? error
              : new ViewerError("depth_load_failed", "暂时只能环视现场。", true, error);
          }
        }
      } else if (normalized.sceneMode === "walkable3d") {
        depthFailure = new ViewerError("walkable3d_not_supported", "暂时只能环视现场。", false);
      }

      try {
        this._initializeWebGl(color, depth);
      } catch (error) {
        this._activateFallback(error instanceof ViewerError
          ? error
          : new ViewerError("webgl_unavailable", "当前设备无法环视，已显示平面图。", true, error), focusWasInViewer);
        return this.getState();
      }

      const depthReady = Boolean(depth && this._safetyEnvelope);
      const renderMode = depthReady ? "depth_limited_parallax" : "rotation360";
      this._canvas.setAttribute("aria-label", depthReady
        ? "360°现场。拖动环视；方向键调整视角；有限视差模式可用 WASD 或方向按钮在安全范围内移动。按 Escape 返回照片。"
        : "360°现场。拖动环视；方向键调整视角。按 Escape 返回照片。");
      this._state.renderMode = renderMode;
      this._state.capability = this._capability(true, depthReady);
      this._state.failure = depthFailure ? errorDto(depthFailure) : null;
      this._state.metrics = {
        firstFrameMs: Math.round((performance.now() - startedAt) * 10) / 10,
        textureWidth: color.source.width || color.source.videoWidth || color.width,
        textureHeight: color.source.height || color.source.videoHeight || color.height,
      };
      this._state.phase = "ready";
      this._render();
      this._fallback.hidden = true;
      this._canvas.hidden = false;
      const announcement = depthReady
        ? "有限视差现场已加载。可环视并在安全范围内移动。"
        : depthFailure?.message || "360°现场已加载。可拖动或使用方向键环视。";
      this._setState({}, announcement);
      if (depthFailure) {
        this._root.querySelector("[data-action=retry]").hidden = !depthFailure.retryable;
        this._emit("error", errorDto(depthFailure));
      }
      this._emit("firstframe", { ...this._state.metrics, renderMode });
      this._announcePose();
      if (depthFailure && (this._retryRequestedFocus || focusWasInViewer)) {
        this._retryRequestedFocus = false;
        requestAnimationFrame(() => {
          if (sceneGeneration !== this._sceneGeneration) return;
          const retryButton = this._root?.querySelector("[data-action=retry]:not([hidden])");
          (retryButton || this._status)?.focus({ preventScroll: true });
        });
      } else if (this._retryRequestedFocus) {
        this._retryRequestedFocus = false;
        requestAnimationFrame(() => {
          if (sceneGeneration === this._sceneGeneration) this._canvas?.focus({ preventScroll: true });
        });
      }
      return this.getState();
    } catch (error) {
      if (error?.name === "AbortError") return this.getState();
      const normalizedError = error instanceof ViewerError
        ? error
        : new ViewerError("viewer_unexpected_error", "现场暂时无法显示。", true, error);
      if (this._canvas) this._canvas.hidden = true;
      if (this._fallback) this._fallback.hidden = false;
      this._setState({ phase: "error", failure: errorDto(normalizedError) }, normalizedError.message);
      this._root.querySelector("[data-action=retry]").hidden = !normalizedError.retryable;
      this._emit("error", errorDto(normalizedError));
      if (this._retryRequestedFocus || focusWasInViewer) {
        this._retryRequestedFocus = false;
        requestAnimationFrame(() => {
          if (sceneGeneration !== this._sceneGeneration) return;
          const target = this._root?.querySelector("[data-action=retry]:not([hidden])") || this._status;
          target?.focus({ preventScroll: true });
        });
      }
      throw normalizedError;
    }
  }

  _createCanvas() {
    this._canvasAbort?.abort();
    this._canvas?.remove();
    this._pointerState.clear();
    this._pinchDistance = 0;
    const canvas = document.createElement("canvas");
    canvas.className = "unseen-viewer__canvas";
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "application");
    canvas.setAttribute("aria-label", "360°现场。拖动环视；方向键调整视角。按 Escape 返回照片。");
    this._root.querySelector(".unseen-viewer__stage").append(canvas);
    this._canvas = canvas;
    this._canvasAbort = new AbortController();
    this._bindCanvasEvents(this._canvasAbort.signal);
    return canvas;
  }

  _initializeWebGl(color, depth) {
    const canvas = this._createCanvas();
    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: "low-power",
    });
    if (!gl) throw new ViewerError("webgl_unavailable", "当前设备无法环视，已显示平面图。", true);
    this._gl = gl;
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    const gpu = {
      program: null,
      vertexShader: null,
      fragmentShader: null,
      buffer: null,
      colorTexture: null,
      depthTexture: null,
      locations: null,
      depthMeta: depth?.meta || null,
    };
    this._gpu = gpu;
    const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (color.source.width > maxTexture || color.source.height > maxTexture ||
        (depth && (depth.source.width > maxTexture || depth.source.height > maxTexture))) {
      throw new ViewerError("texture_limit_exceeded", "当前设备无法环视，已显示平面图。", false);
    }
    gpu.vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    gpu.fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    gpu.program = gl.createProgram();
    if (!gpu.program) throw new ViewerError("webgl_resource_failed", "当前设备无法环视，已显示平面图。", true);
    gl.attachShader(gpu.program, gpu.vertexShader);
    gl.attachShader(gpu.program, gpu.fragmentShader);
    gl.linkProgram(gpu.program);
    if (!gl.getProgramParameter(gpu.program, gl.LINK_STATUS)) {
      throw new ViewerError("webgl_link_failed", "当前设备无法环视，已显示平面图。", true,
        new Error(gl.getProgramInfoLog(gpu.program) || "program link failed"));
    }
    gl.useProgram(gpu.program);
    gpu.buffer = gl.createBuffer();
    if (!gpu.buffer) throw new ViewerError("webgl_resource_failed", "当前设备无法环视，已显示平面图。", true);
    gl.bindBuffer(gl.ARRAY_BUFFER, gpu.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(gpu.program, "aPosition");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gpu.colorTexture = this._uploadTexture(color.source, 0);
    gpu.depthTexture = depth ? this._uploadTexture(depth.source, 1) : null;
    gl.uniform1i(gl.getUniformLocation(gpu.program, "uColor"), 0);
    gl.uniform1i(gl.getUniformLocation(gpu.program, "uDepth"), 1);
    gpu.locations = {
      resolution: gl.getUniformLocation(gpu.program, "uResolution"),
      turn: gl.getUniformLocation(gpu.program, "uTurn"),
      camera: gl.getUniformLocation(gpu.program, "uCameraXZ"),
      tanHalfFov: gl.getUniformLocation(gpu.program, "uTanHalfFov"),
      useDepth: gl.getUniformLocation(gpu.program, "uUseDepth"),
      depthNear: gl.getUniformLocation(gpu.program, "uDepthNear"),
      depthFar: gl.getUniformLocation(gpu.program, "uDepthFar"),
    };
    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this._activateFallback(new ViewerError("webgl_context_lost", "当前设备暂时无法环视，已显示平面图。", true));
    }, { once: true, signal: this._canvasAbort.signal });
    this._resizeAndRender();
    this._render();
    if (gl.isContextLost() || gl.getError() !== gl.NO_ERROR) {
      throw new ViewerError("webgl_first_frame_failed", "当前设备无法环视，已显示平面图。", true);
    }
  }

  _uploadTexture(source, unit) {
    const gl = this._gl;
    const texture = gl.createTexture();
    if (!texture) throw new ViewerError("webgl_resource_failed", "当前设备无法环视，已显示平面图。", true);
    try {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      if (gl.getError() !== gl.NO_ERROR) {
        throw new ViewerError("texture_upload_failed", "当前设备无法环视，已显示平面图。", true);
      }
      return texture;
    } catch (error) {
      gl.deleteTexture(texture);
      throw error instanceof ViewerError
        ? error
        : new ViewerError("texture_upload_failed", "当前设备无法环视，已显示平面图。", true, error);
    }
  }

  _bindCanvasEvents(signal) {
    const canvas = this._canvas;
    canvas.addEventListener("pointerdown", (event) => {
      this._cancelAnimation();
      canvas.setPointerCapture(event.pointerId);
      this._pointerState.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this._pointerState.size === 2) this._pinchDistance = this._pointerDistance();
      canvas.focus({ preventScroll: true });
    }, { signal });
    canvas.addEventListener("pointermove", (event) => {
      const previous = this._pointerState.get(event.pointerId);
      if (!previous) return;
      event.preventDefault();
      this._pointerState.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this._pointerState.size === 1) {
        this._changePose({
          yawDeg: this._state.pose.yawDeg - (event.clientX - previous.x) * 0.16,
          pitchDeg: this._state.pose.pitchDeg + (event.clientY - previous.y) * 0.12,
        });
      } else if (this._pointerState.size === 2) {
        const distance = this._pointerDistance();
        if (this._pinchDistance > 0) {
          this._changePose({ fovDeg: this._state.pose.fovDeg * this._pinchDistance / Math.max(1, distance) });
        }
        this._pinchDistance = distance;
      }
    }, { signal, passive: false });
    const endPointer = (event) => {
      this._pointerState.delete(event.pointerId);
      this._pinchDistance = this._pointerState.size === 2 ? this._pointerDistance() : 0;
    };
    canvas.addEventListener("pointerup", endPointer, { signal });
    canvas.addEventListener("pointercancel", endPointer, { signal });
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      this._changePose({ fovDeg: this._state.pose.fovDeg + Math.sign(event.deltaY) * 4 });
    }, { signal, passive: false });
    canvas.addEventListener("keydown", (event) => this._onKeyDown(event), { signal });
    canvas.addEventListener("keyup", (event) => this._onKeyUp(event), { signal });
    canvas.addEventListener("blur", () => {
      this._movementKeys.clear();
      this._stopMovementLoop();
    }, { signal });
  }

  _pointerDistance() {
    const [a, b] = [...this._pointerState.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  _onKeyDown(event) {
    const key = event.key.toLowerCase();
    if (["arrowleft", "arrowright", "arrowup", "arrowdown", "w", "a", "s", "d", "escape"].includes(key)) {
      event.preventDefault();
      this._cancelAnimation();
    }
    if (key === "arrowleft") this._changePose({ yawDeg: this._state.pose.yawDeg - 5 });
    if (key === "arrowright") this._changePose({ yawDeg: this._state.pose.yawDeg + 5 });
    if (key === "arrowup") this._changePose({ pitchDeg: this._state.pose.pitchDeg + 4 });
    if (key === "arrowdown") this._changePose({ pitchDeg: this._state.pose.pitchDeg - 4 });
    if (key === "escape" && this._focus) this._requestReturn();
    if (this._state.capability.translation && ["w", "a", "s", "d"].includes(key)) {
      this._movementKeys.add(key);
      this._startMovementLoop();
    }
  }

  _onKeyUp(event) {
    this._movementKeys.delete(event.key.toLowerCase());
  }

  _startMovementLoop() {
    if (this._movementFrame || !this._state.capability.translation) return;
    this._lastMovementAt = performance.now();
    const tick = (now) => {
      this._movementFrame = 0;
      if (!this._state.capability.translation) return;
      const elapsed = Math.min(0.05, Math.max(0, (now - this._lastMovementAt) / 1000));
      this._lastMovementAt = now;
      const strafe = (Number(this._movementKeys.has("d")) - Number(this._movementKeys.has("a")) + this._joystickVector.x) * elapsed * 0.6;
      const forward = (Number(this._movementKeys.has("w")) - Number(this._movementKeys.has("s")) - this._joystickVector.y) * elapsed * 0.6;
      if (Math.abs(strafe) + Math.abs(forward) > 1e-7) this._move(strafe, forward);
      if (this._movementKeys.size || Math.abs(this._joystickVector.x) + Math.abs(this._joystickVector.y) > 0.01) {
        this._movementFrame = requestAnimationFrame(tick);
      }
    };
    this._movementFrame = requestAnimationFrame(tick);
  }

  _stopMovementLoop() {
    if (this._movementFrame) cancelAnimationFrame(this._movementFrame);
    this._movementFrame = 0;
    this._movementKeys.clear();
    this._joystickVector = { x: 0, y: 0 };
    this._joystick?.style.setProperty("--stick-x", "0px");
    this._joystick?.style.setProperty("--stick-y", "0px");
  }

  _move(strafe, forward, label = "") {
    const delta = localMovementDelta(this._state.pose.yawDeg, strafe, forward);
    const next = constrainMovement(this._state.pose, delta, this._safetyEnvelope);
    this._state.pose = { ...this._state.pose, x: next.x, z: next.z };
    this._render();
    this._emit("posechange", this._state.pose);
    const live = this._root?.querySelector("[data-direction-live]");
    const announcement = next.blocked ? "已到达这个方向的安全边界。" : label ? `${label}平移。` : "位置已移动。";
    if (next.blocked) this._status.textContent = announcement;
    if (live) live.textContent = announcement;
  }

  _nudgeDirection(direction) {
    if (direction === "left") this._changePose({ yawDeg: this._state.pose.yawDeg - 10 });
    if (direction === "right") this._changePose({ yawDeg: this._state.pose.yawDeg + 10 });
    if (direction === "up") this._changePose({ pitchDeg: this._state.pose.pitchDeg + 8 });
    if (direction === "down") this._changePose({ pitchDeg: this._state.pose.pitchDeg - 8 });
    this._canvas?.focus({ preventScroll: true });
  }

  _changePose(patch) {
    this._cancelAnimation();
    this._state.pose = {
      ...this._state.pose,
      yawDeg: patch.yawDeg === undefined ? this._state.pose.yawDeg : normalizeYaw(patch.yawDeg),
      pitchDeg: patch.pitchDeg === undefined ? this._state.pose.pitchDeg : clampPitch(patch.pitchDeg),
      fovDeg: patch.fovDeg === undefined
        ? this._state.pose.fovDeg
        : normalizePose({ fovDeg: patch.fovDeg }).fovDeg,
    };
    this._render();
    this._announcePose();
    this._emit("posechange", this._state.pose);
  }

  _announcePose() {
    const text = `方位 ${Math.round(this._state.pose.yawDeg)} 度，俯仰 ${Math.round(this._state.pose.pitchDeg)} 度`;
    const live = this._root?.querySelector("[data-direction-live]");
    if (live) live.textContent = text;
  }

  _resizeAndRender() {
    if (!this._canvas || !this._gl || !this._gpu) return;
    const rect = this._root.getBoundingClientRect();
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const width = Math.max(2, Math.min(4096, Math.round(rect.width * dpr)));
    const height = Math.max(2, Math.min(4096, Math.round(rect.height * dpr)));
    if (this._canvas.width !== width || this._canvas.height !== height) {
      this._canvas.width = width;
      this._canvas.height = height;
      this._gl.viewport(0, 0, width, height);
    }
    this._render();
  }

  _render(focusFailure = null) {
    const gl = this._gl;
    const gpu = this._gpu;
    if (!gl || !gpu || gl.isContextLost()) {
      if (focusFailure) {
        this._activateFallback(
          new ViewerError("webgl_context_lost", "当前设备暂时无法环视，已显示平面图。", true),
          false,
        );
      }
      return false;
    }
    gl.useProgram(gpu.program);
    const pose = this._state.pose;
    gl.uniform2f(gpu.locations.resolution, this._canvas.width, this._canvas.height);
    gl.uniform2f(gpu.locations.turn, pose.yawDeg * Math.PI / 180, pose.pitchDeg * Math.PI / 180);
    gl.uniform2f(gpu.locations.camera, pose.x, pose.z);
    gl.uniform1f(gpu.locations.tanHalfFov, Math.tan(pose.fovDeg * Math.PI / 360));
    gl.uniform1f(gpu.locations.useDepth, this._state.capability.translation ? 1 : 0);
    gl.uniform1f(gpu.locations.depthNear, gpu.depthMeta?.depthMap.nearMeters || 0.1);
    gl.uniform1f(gpu.locations.depthFar, gpu.depthMeta?.depthMap.farMeters || 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (gl.getError() !== gl.NO_ERROR) {
      this._activateFallback(
        new ViewerError("webgl_render_failed", "当前设备暂时无法环视，已显示平面图。", true),
        false,
        focusFailure,
      );
      return false;
    }
    return true;
  }

  async focusPose(pose, options = {}) {
    if (!this._scene) {
      throw new ViewerError("scene_not_ready", "现场尚未准备好。", true);
    }
    if (!this._state.capability.sphericalView ||
        !["rotation360", "depth_limited_parallax"].includes(this._state.renderMode)) {
      throw new ViewerError("spherical_view_unavailable", "当前设备无法环视，已显示平面图。", true);
    }
    if (this._state.phase !== "ready") {
      throw new ViewerError("scene_not_ready", "现场尚未准备好。", true);
    }
    if (!pose || typeof pose.nodeId !== "string" || !pose.nodeId ||
        typeof pose.yawDeg !== "number" || !Number.isFinite(pose.yawDeg) ||
        (pose.pitchDeg !== undefined && (typeof pose.pitchDeg !== "number" || !Number.isFinite(pose.pitchDeg))) ||
        (pose.fovDeg !== undefined && (typeof pose.fovDeg !== "number" || !Number.isFinite(pose.fovDeg)))) {
      throw new ViewerError("focus_pose_invalid", "照片位置缺少有效的节点或视角。", false);
    }
    if (pose.nodeId !== this._scene.nodeId) {
      throw new ViewerError("focus_node_mismatch", "照片位置不属于当前现场节点。", false);
    }
    if (typeof pose?.photoId !== "string" || !pose.photoId ||
        typeof pose?.photoAssetId !== "string" || !pose.photoAssetId ||
        !Number.isInteger(pose?.photoAssetVersion) || pose.photoAssetVersion < 1 ||
        !sha256Pattern.test(pose?.photoRawSha256 || "") ||
        typeof pose?.placementRevisionId !== "string" || !pose.placementRevisionId ||
        typeof pose?.panoramaRevisionId !== "string" || !pose.panoramaRevisionId) {
      throw new ViewerError("focus_identity_invalid", "照片位置缺少不可变身份。", false);
    }
    if (pose.panoramaRevisionId !== this._scene.panorama.revisionId) {
      throw new ViewerError("focus_revision_mismatch", "照片位置属于旧全景版本，无法在当前现场打开。", false);
    }
    const target = { ...normalizePose({ ...pose, nodeId: this._scene.nodeId }), x: 0, z: 0 };
    this._cancelAnimation(false);
    this._focus = {
      photoId: pose.photoId,
      photoAssetId: pose.photoAssetId,
      photoAssetVersion: pose.photoAssetVersion,
      photoRawSha256: pose.photoRawSha256,
      placementRevisionId: pose.placementRevisionId,
      panoramaRevisionId: pose.panoramaRevisionId,
      returnTarget: typeof pose?.returnTarget === "string" ? pose.returnTarget : null,
      pose: { ...target, panoramaRevisionId: pose.panoramaRevisionId },
    };
    this._state.focus = clone(this._focus);
    this._returnButton.hidden = !this._focus.photoId && !this._focus.returnTarget;
    this._setState({}, "正在回到照片所在位置…");
    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const duration = options.animate === false || reduceMotion ? 0 : Math.max(0, Math.min(1000, Number(options.durationMs) || 320));
    if (!duration) {
      this._state.pose = { ...this._state.pose, ...target };
      if (!this._render()) {
        throw new ViewerError("spherical_view_unavailable", "当前设备无法环视，已显示平面图。", true);
      }
      this._announcePose();
      this._emit("posechange", this._state.pose);
      this._status.textContent = "已回到照片所在位置。";
      if (options.focusOnComplete === true) this._canvas?.focus({ preventScroll: true });
      return this.getState();
    }
    const from = { ...this._state.pose };
    const yawDelta = shortestYawDelta(from.yawDeg, target.yawDeg);
    const started = performance.now();
    return new Promise((resolve, reject) => {
      this._animationResolve = resolve;
      this._animationReject = reject;
      const frame = (now) => {
        const progress = Math.min(1, (now - started) / duration);
        const eased = 1 - (1 - progress) ** 3;
        this._state.pose = {
          ...this._state.pose,
          yawDeg: normalizeYaw(from.yawDeg + yawDelta * eased),
          pitchDeg: from.pitchDeg + (target.pitchDeg - from.pitchDeg) * eased,
          fovDeg: from.fovDeg + (target.fovDeg - from.fovDeg) * eased,
          x: from.x + (target.x - from.x) * eased,
          z: from.z + (target.z - from.z) * eased,
        };
        if (progress === 1) this._state.pose = { ...this._state.pose, ...target };
        const focusFailure = new ViewerError(
          "spherical_view_unavailable",
          "当前设备无法环视，已显示平面图。",
          true,
        );
        if (!this._render(focusFailure)) {
          // _render atomically activates fallback and rejects this animation
          // with focusFailure. Never leave the public Promise pending.
          return;
        }
        if (progress < 1) {
          this._animation = requestAnimationFrame(frame);
        } else {
          this._animation = 0;
          this._animationResolve = null;
          this._animationReject = null;
          this._announcePose();
          this._emit("posechange", this._state.pose);
          this._status.textContent = "已回到照片所在位置。";
          if (options.focusOnComplete === true) this._canvas?.focus({ preventScroll: true });
          resolve(this.getState());
        }
      };
      this._animation = requestAnimationFrame(frame);
    });
  }

  _cancelAnimation(announce = true, cancellationError = null) {
    const reject = this._animationReject;
    if (this._animation) cancelAnimationFrame(this._animation);
    this._animation = 0;
    this._animationResolve = null;
    this._animationReject = null;
    if (reject) {
      this._focus = null;
      this._state.focus = null;
      if (this._returnButton) this._returnButton.hidden = true;
      if (announce && this._root) this._setState({}, "照片定位已取消。");
      reject(cancellationError || new ViewerError("focus_cancelled", "照片定位已取消。", true));
    }
  }

  reset() {
    this._cancelAnimation(false);
    this._stopMovementLoop();
    this._focus = null;
    this._state.focus = null;
    if (this._returnButton) this._returnButton.hidden = true;
    this._state.pose = { ...this._initialPose, x: 0, z: 0 };
    this._render();
    this._setState({}, "视角和位置已重置。");
    this._announcePose();
    this._emit("posechange", this._state.pose);
    return this.getState();
  }

  retry() {
    if (!this._scene) return Promise.reject(new ViewerError("scene_missing", "没有可重试的现场。", false));
    return this.updateScene(this._scene);
  }

  _requestReturn() {
    if (!this._focus) return;
    this._emit("returnrequest", {
      photoId: this._focus.photoId,
      photoAssetId: this._focus.photoAssetId,
      photoAssetVersion: this._focus.photoAssetVersion,
      photoRawSha256: this._focus.photoRawSha256,
      placementRevisionId: this._focus.placementRevisionId,
      panoramaRevisionId: this._focus.panoramaRevisionId,
      returnTarget: this._focus.returnTarget,
      pose: this._focus.pose,
    });
    this._status.textContent = "正在返回照片。";
  }

  async _toggleFullscreen() {
    try {
      if (document.fullscreenElement === this._root) await document.exitFullscreen();
      else await this._root.requestFullscreen();
    } catch (cause) {
      const error = new ViewerError("fullscreen_unavailable", "此环境无法进入全屏。", true, cause);
      this._emit("error", errorDto(error));
      this._status.textContent = error.message;
    }
  }

  _activateFallback(error, forceMoveFocus = false, focusFailure = null) {
    const dto = errorDto(error);
    const sceneGeneration = this._sceneGeneration;
    const shouldMoveFocus = forceMoveFocus || this._retryRequestedFocus || Boolean(this._root?.contains(document.activeElement));
    this._retryRequestedFocus = false;
    this._cancelAnimation(false, focusFailure);
    this._stopMovementLoop();
    this._focus = null;
    this._state.focus = null;
    if (this._returnButton) this._returnButton.hidden = true;
    this._cleanupGpu();
    if (this._canvas) this._canvas.hidden = true;
    if (this._fallback) this._fallback.hidden = false;
    const retryButton = this._root?.querySelector("[data-action=retry]");
    if (retryButton) retryButton.hidden = !dto.retryable;
    this._setState({
      phase: this._fallback?.src ? "ready" : "error",
      renderMode: "flat_fallback",
      capability: this._capability(false, false),
      failure: dto,
    }, dto.retryable ? `${dto.message} 可使用“重试”再次尝试。` : dto.message);
    this._emit("error", dto);
    if (shouldMoveFocus) {
      requestAnimationFrame(() => {
        if (sceneGeneration !== this._sceneGeneration) return;
        const target = dto.retryable && !retryButton?.hidden ? retryButton : this._status;
        target?.focus({ preventScroll: true });
      });
    }
  }

  _cleanupGpu() {
    this._canvasAbort?.abort();
    this._canvasAbort = null;
    const gl = this._gl;
    const gpu = this._gpu;
    if (gl && !gl.isContextLost()) {
      if (gpu?.colorTexture) gl.deleteTexture(gpu.colorTexture);
      if (gpu?.depthTexture) gl.deleteTexture(gpu.depthTexture);
      if (gpu?.buffer) gl.deleteBuffer(gpu.buffer);
      if (gpu?.program) gl.deleteProgram(gpu.program);
      if (gpu?.vertexShader) gl.deleteShader(gpu.vertexShader);
      if (gpu?.fragmentShader) gl.deleteShader(gpu.fragmentShader);
      // Each mount owns its context. Explicitly release it so repeated route
      // mount/unmount cannot accumulate browser context slots. This also
      // releases allocations made before _gpu could be fully assembled.
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    this._gpu = null;
    this._gl = null;
  }

  _cleanupAssets() {
    for (const asset of this._assets) {
      asset.close?.();
      if (asset.objectUrl) URL.revokeObjectURL(asset.objectUrl);
    }
    this._assets = [];
  }

  dispose() {
    this._sceneGeneration += 1;
    this._loadAbort?.abort();
    this._loadAbort = null;
    this._retryRequestedFocus = false;
    this._cancelAnimation(false);
    this._stopMovementLoop();
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this._mountAbort?.abort();
    this._mountAbort = null;
    this._cleanupGpu();
    this._cleanupAssets();
    this._canvas?.remove();
    this._canvas = null;
    this._root?.remove();
    this._style?.remove();
    this._style = null;
    this._root = null;
    this._container = null;
    this._fallback = null;
    this._status = null;
    this._returnButton = null;
    this._joystick = null;
    this._scene = null;
    this._focus = null;
    this._safetyEnvelope = null;
    this._state = {
      ...this._state,
      phase: "disposed",
      renderMode: "flat_fallback",
      requestedSceneMode: null,
      capability: this._capability(false, false),
      focus: null,
    };
    this._emit("statechange", this._state);
  }
}
