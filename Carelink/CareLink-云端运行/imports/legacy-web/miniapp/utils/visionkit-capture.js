/*
 * VisionKit capture adapter.
 *
 * One VKFrame supplies the preview texture, timestamp, viewMatrix, intrinsics
 * and camera pixels. This removes the unsynchronised <camera> + DeviceMotion +
 * takePhoto chain from the reliable mini-program path.
 */
"use strict";

var Pose = require("./capture-pose.js");

function compareVersion(left, right) {
  var a = String(left || "0").split(".");
  var b = String(right || "0").split(".");
  var count = Math.max(a.length, b.length);
  for (var i = 0; i < count; i += 1) {
    var av = parseInt(a[i] || "0", 10) || 0;
    var bv = parseInt(b[i] || "0", 10) || 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
}

function getRuntimeInfo(wxApi) {
  try {
    if (wxApi.getAppBaseInfo) return wxApi.getAppBaseInfo() || {};
  } catch (ignored) {}
  try {
    if (wxApi.getSystemInfoSync) return wxApi.getSystemInfoSync() || {};
  } catch (ignored2) {}
  return {};
}

function detectSupport(wxApi) {
  var info = getRuntimeInfo(wxApi || {});
  var sdkVersion = info.SDKVersion || "0.0.0";
  if (!wxApi || typeof wxApi.createVKSession !== "function") {
    return {
      supported: false,
      code: "NO_VISIONKIT",
      sdkVersion: sdkVersion,
      message: "当前微信内核没有 VisionKit"
    };
  }
  if (compareVersion(sdkVersion, "2.32.1") < 0) {
    return {
      supported: false,
      code: "SDK_TOO_OLD",
      sdkVersion: sdkVersion,
      message: "微信基础库低于 2.32.1，不能使用稳定的三自由度相机姿态"
    };
  }
  return {
    supported: true,
    code: "VISIONKIT_CANDIDATE",
    sdkVersion: sdkVersion,
    message: "将使用 VisionKit 同帧姿态与图像"
  };
}

function compileShader(gl, type, source) {
  var shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    var message = gl.getShaderInfoLog(shader) || "VisionKit shader compile failed";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function copyArray(value) {
  return value && typeof value.length === "number"
    ? Array.prototype.slice.call(value)
    : null;
}

function makeError(message, code, cause) {
  var error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function alignCameraBufferWidth(value) {
  var width = Math.max(16, Math.round(Number(value) || 352));
  return Math.max(16, Math.floor(width / 16) * 16);
}

/*
 * VKFrame normally returns a standalone ArrayBuffer. Keep that buffer instead
 * of cloning a megapixel image again. ArrayBuffer views are narrowed once only
 * when their backing buffer contains bytes outside the view.
 */
function normalizeArrayBuffer(value) {
  if (!value || typeof value.byteLength !== "number") return null;
  if (!value.buffer || typeof value.buffer.byteLength !== "number") return value;
  if ((Number(value.byteOffset) || 0) === 0 &&
      value.byteLength === value.buffer.byteLength) {
    return value.buffer;
  }
  if (typeof value.buffer.slice === "function") {
    var start = Number(value.byteOffset) || 0;
    return value.buffer.slice(start, start + value.byteLength);
  }
  var source = new Uint8Array(
    value.buffer,
    Number(value.byteOffset) || 0,
    value.byteLength
  );
  var copy = new Uint8Array(source.length);
  copy.set(source);
  return copy.buffer;
}

function validProjectionFov(projection) {
  if (!projection || projection.length < 6) return null;
  var scaleX = Math.abs(Number(projection[0]));
  if (!isFinite(scaleX) || scaleX < 0.01) return null;
  var fov = 2 * Math.atan(1 / scaleX) * 180 / Math.PI;
  return isFinite(fov) && fov >= 25 && fov <= 125 ? fov : null;
}

function validIntrinsicsFov(intrinsics, width) {
  if (!intrinsics || intrinsics.length < 5) return null;
  var fx = Math.abs(Number(intrinsics[0]));
  if (!isFinite(fx) || fx < 1) return null;
  var imageWidth = Math.max(1, Number(width) || 1);
  var fov = 2 * Math.atan(imageWidth / (2 * fx)) * 180 / Math.PI;
  return isFinite(fov) && fov >= 25 && fov <= 125 ? fov : null;
}

function createAdapter(options) {
  options = options || {};
  var wxApi = options.wxApi;
  var adapter = {
    wxApi: wxApi,
    canvas: options.canvas,
    cssWidth: Math.max(1, Number(options.cssWidth) || 1),
    cssHeight: Math.max(1, Number(options.cssHeight) || 1),
    pixelRatio: Math.max(1, Number(options.pixelRatio) || 1),
    onFrame: typeof options.onFrame === "function" ? options.onFrame : function () {},
    onReady: typeof options.onReady === "function" ? options.onReady : function () {},
    onFatal: typeof options.onFatal === "function" ? options.onFatal : function () {},
    session: null,
    running: false,
    requestId: null,
    pendingCapture: null,
    startPending: null,
    startGeneration: 0,
    latestSnapshot: null,
    gl: null,
    resources: null,
    frameHandler: null,
    sessionVersion: null,
    // VisionKit's redraw callback can run faster than the camera's 30 fps
    // stream. A repeated non-zero VKFrame timestamp is the same camera frame,
    // not a new shutter sample.
    lastFrameTimestampNs: 0,
    lastFramePollRafMs: null,
    minFramePollIntervalMs: 1000 / 30,
    sessionStartTimeoutMs: Math.max(
      20,
      Number(options.sessionStartTimeoutMs) || 3000
    )
  };
  var releasedSessions = [];

  function cleanupSession(session, requestId) {
    if (!session || releasedSessions.indexOf(session) >= 0) return;
    releasedSessions.push(session);
    try {
      if (requestId != null && typeof session.cancelAnimationFrame === "function") {
        session.cancelAnimationFrame(requestId);
      }
    } catch (ignored) {}
    try {
      if (typeof session.stop === "function") session.stop();
    } catch (ignored2) {}
    try {
      if (typeof session.destroy === "function") session.destroy();
    } catch (ignored3) {}
  }

  function releaseGl() {
    var gl = adapter.gl;
    var resources = adapter.resources;
    if (gl && resources) {
      try {
        if (resources.positionBuffer) gl.deleteBuffer(resources.positionBuffer);
        if (resources.texcoordBuffer) gl.deleteBuffer(resources.texcoordBuffer);
        if (resources.program) gl.deleteProgram(resources.program);
        if (resources.vertex) gl.deleteShader(resources.vertex);
        if (resources.fragment) gl.deleteShader(resources.fragment);
      } catch (ignored) {}
    }
    adapter.gl = null;
    adapter.resources = null;
  }

  adapter.initGl = function () {
    var canvas = adapter.canvas;
    if (!canvas || !canvas.getContext) throw new Error("VisionKit 预览画布不可用");
    canvas.width = Math.max(2, Math.round(adapter.cssWidth * adapter.pixelRatio));
    canvas.height = Math.max(2, Math.round(adapter.cssHeight * adapter.pixelRatio));
    var gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: false
    });
    if (!gl) throw new Error("VisionKit WebGL 上下文不可用");
    adapter.gl = gl;

    var vertex = compileShader(gl, gl.VERTEX_SHADER, [
      "attribute vec2 a_position;",
      "attribute vec2 a_texCoord;",
      "uniform mat3 displayTransform;",
      "varying vec2 v_texCoord;",
      "void main(){",
      "vec3 p=displayTransform*vec3(a_position,0.0);",
      "gl_Position=vec4(p,1.0);",
      "v_texCoord=a_texCoord;",
      "}"
    ].join(""));
    var fragment = compileShader(gl, gl.FRAGMENT_SHADER, [
      "precision highp float;",
      "uniform sampler2D y_texture;",
      "uniform sampler2D uv_texture;",
      "varying vec2 v_texCoord;",
      "void main(){",
      "float Y=texture2D(y_texture,v_texCoord).r;",
      "vec4 uv=texture2D(uv_texture,v_texCoord);",
      "float U=uv.r-0.5;",
      "float V=uv.a-0.5;",
      "gl_FragColor=vec4(Y+1.402*V,Y-0.344*U-0.714*V,Y+1.772*U,1.0);",
      "}"
    ].join(""));
    var program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || "VisionKit shader link failed");
    }

    var positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([1, 1, -1, 1, 1, -1, -1, -1]),
      gl.STATIC_DRAW
    );
    var texcoordBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, texcoordBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([1, 1, 0, 1, 1, 0, 0, 0]),
      gl.STATIC_DRAW
    );
    adapter.resources = {
      vertex: vertex,
      fragment: fragment,
      program: program,
      positionBuffer: positionBuffer,
      texcoordBuffer: texcoordBuffer,
      position: gl.getAttribLocation(program, "a_position"),
      texcoord: gl.getAttribLocation(program, "a_texCoord"),
      displayTransform: gl.getUniformLocation(program, "displayTransform"),
      yTexture: gl.getUniformLocation(program, "y_texture"),
      uvTexture: gl.getUniformLocation(program, "uv_texture")
    };
  };

  adapter.renderFrame = function (frame) {
    var gl = adapter.gl;
    var resources = adapter.resources;
    if (!gl || !resources) {
      throw makeError("VisionKit 预览 WebGL 尚未初始化", "VK_PREVIEW_GL_UNAVAILABLE");
    }
    if (!frame || typeof frame.getCameraTexture !== "function") {
      throw makeError(
        "当前 VKFrame 不支持 getCameraTexture",
        "VK_CAMERA_TEXTURE_METHOD_MISSING"
      );
    }
    if (typeof frame.getDisplayTransform !== "function") {
      throw makeError(
        "当前 VKFrame 不支持 getDisplayTransform",
        "VK_DISPLAY_TRANSFORM_METHOD_MISSING"
      );
    }
    var textures;
    var transform;
    try {
      textures = frame.getCameraTexture(gl, "yuv");
    } catch (textureError) {
      throw makeError(
        "VisionKit 获取相机纹理失败",
        "VK_CAMERA_TEXTURE_FAILED",
        textureError
      );
    }
    if (!textures || !textures.yTexture || !textures.uvTexture) {
      throw makeError(
        "VisionKit 返回了无效的 YUV 相机纹理",
        "VK_CAMERA_TEXTURE_INVALID"
      );
    }
    try {
      transform = frame.getDisplayTransform();
    } catch (transformError) {
      throw makeError(
        "VisionKit 获取显示变换失败",
        "VK_DISPLAY_TRANSFORM_FAILED",
        transformError
      );
    }
    if (!transform || typeof transform.length !== "number" || transform.length < 9) {
      throw makeError(
        "VisionKit 返回了无效的显示变换",
        "VK_DISPLAY_TRANSFORM_INVALID"
      );
    }
    gl.viewport(0, 0, adapter.canvas.width, adapter.canvas.height);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(resources.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, resources.positionBuffer);
    gl.vertexAttribPointer(resources.position, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(resources.position);
    gl.bindBuffer(gl.ARRAY_BUFFER, resources.texcoordBuffer);
    gl.vertexAttribPointer(resources.texcoord, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(resources.texcoord);
    gl.uniformMatrix3fv(resources.displayTransform, false, transform);
    gl.uniform1i(resources.yTexture, 0);
    gl.uniform1i(resources.uvTexture, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, textures.yTexture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, textures.uvTexture);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // Return the transform read from this exact VKFrame. handleFrame passes it
    // into snapshotFrame so sweep capture can prove that preview geometry,
    // camera pixels and pose all belong to one frame.
    return transform;
  };

  adapter.snapshotFrame = function (frame, sameFrameDisplayTransform) {
    var camera = frame && frame.camera;
    if (!camera || !camera.viewMatrix) return null;
    var viewMatrix = copyArray(camera.viewMatrix);
    var intrinsics = copyArray(camera.intrinsics);
    var displayTransform = copyArray(sameFrameDisplayTransform);
    if (!displayTransform && frame && typeof frame.getDisplayTransform === "function") {
      try {
        displayTransform = copyArray(frame.getDisplayTransform());
      } catch (ignoredDisplayTransform) {}
    }
    var projection = null;
    try {
      if (typeof camera.getProjectionMatrix === "function") {
        projection = copyArray(camera.getProjectionMatrix(0.01, 1000));
      }
    } catch (ignored) {}
    var basis = Pose.basisFromVisionKitViewMatrix(viewMatrix);
    if (!basis) return null;
    var projectionFovXDeg = validProjectionFov(projection);
    var intrinsicsFovXDeg = validIntrinsicsFov(intrinsics, adapter.canvas.width);
    var fovXDeg = projectionFovXDeg != null
      ? projectionFovXDeg
      : (intrinsicsFovXDeg != null ? intrinsicsFovXDeg : 65);
    var fovMismatchDeg = projectionFovXDeg != null && intrinsicsFovXDeg != null
      ? Math.abs(projectionFovXDeg - intrinsicsFovXDeg)
      : 0;
    var diagnostics = fovMismatchDeg > 5 ? {
      projectionFovXDeg: projectionFovXDeg,
      intrinsicsFovXDeg: intrinsicsFovXDeg,
      fovMismatchDeg: fovMismatchDeg
    } : null;
    return {
      backend: "visionkit",
      timestampNs: Number(frame.timestamp) || 0,
      receivedAtMs: Date.now(),
      basis: basis,
      viewMatrix: viewMatrix,
      intrinsics: intrinsics,
      projectionMatrix: projection,
      displayTransform: displayTransform,
      fovXDeg: fovXDeg,
      diagnostics: diagnostics,
      width: adapter.canvas.width,
      height: adapter.canvas.height,
      hasJpegCapture: typeof frame.getCameraJpgBuffer === "function",
      hasRgbaCapture: typeof frame.getCameraBuffer === "function"
    };
  };

  adapter.acquirePendingCapture = function (frame, snapshot) {
    var pending = adapter.pendingCapture;
    if (!pending) return;
    adapter.pendingCapture = null;
    clearTimeout(pending.timer);
    var errors = [];

    function acquireRgba() {
      if (typeof frame.getCameraBuffer !== "function") return null;
      try {
        var rgba = normalizeArrayBuffer(frame.getCameraBuffer(
          pending.rgbaWidth,
          pending.rgbaHeight
        ));
        if (rgba &&
            rgba.byteLength >= pending.rgbaWidth * pending.rgbaHeight * 4) {
          return {
            kind: "rgba",
            buffer: rgba,
            width: pending.rgbaWidth,
            height: pending.rgbaHeight,
            snapshot: snapshot,
            acquiredAtMs: Date.now()
          };
        }
      } catch (rgbaError) {
        errors.push(rgbaError);
      }
      return null;
    }

    function acquireJpeg() {
      if (typeof frame.getCameraJpgBuffer !== "function") return null;
      try {
        var jpg = normalizeArrayBuffer(frame.getCameraJpgBuffer(
          pending.width,
          pending.height,
          pending.quality
        ));
        if (jpg && jpg.byteLength > 64) {
          return {
            kind: "jpeg",
            buffer: jpg,
            width: pending.width,
            height: pending.height,
            snapshot: snapshot,
            acquiredAtMs: Date.now()
          };
        }
      } catch (jpgError) {
        errors.push(jpgError);
      }
      return null;
    }

    var payload = null;
    if (pending.preferRgba || pending.rgbaOnly) {
      payload = acquireRgba();
      if (!payload && !pending.rgbaOnly) payload = acquireJpeg();
    } else {
      payload = acquireJpeg();
      if (!payload) payload = acquireRgba();
    }
    if (payload) {
      pending.resolve(payload);
      return;
    }

    var error = errors[errors.length - 1] || new Error("VisionKit 当前帧不能导出 JPG 或 RGBA");
    error.code = "VK_CAPTURE_UNSUPPORTED";
    pending.reject(error);
  };

  adapter.handleFrame = function (rafTimestampMs) {
    if (!adapter.running || !adapter.session) return;
    var redrawTimeMs = Number(rafTimestampMs);
    if (isFinite(redrawTimeMs)) {
      var previousPollMs = adapter.lastFramePollRafMs;
      if (previousPollMs != null &&
          redrawTimeMs >= previousPollMs &&
          redrawTimeMs - previousPollMs < adapter.minFramePollIntervalMs) {
        adapter.requestId = adapter.session.requestAnimationFrame(adapter.frameHandler);
        return;
      }
      adapter.lastFramePollRafMs = redrawTimeMs;
    }
    try {
      var frame = adapter.session.getVKFrame(adapter.canvas.width, adapter.canvas.height);
      if (frame) {
        var frameTimestampNs = Number(frame.timestamp) || 0;
        if (frameTimestampNs > 0 &&
            frameTimestampNs === adapter.lastFrameTimestampNs) {
          if (adapter.running && adapter.session) {
            adapter.requestId = adapter.session.requestAnimationFrame(adapter.frameHandler);
          }
          return;
        }
        var displayTransform = adapter.renderFrame(frame);
        var snapshot = adapter.snapshotFrame(frame, displayTransform);
        if (snapshot) {
          if (frameTimestampNs > 0) {
            adapter.lastFrameTimestampNs = frameTimestampNs;
          }
          adapter.latestSnapshot = snapshot;
          // Fulfil only requests that existed before this VKFrame callback.
          // onFrame may trigger auto-capture; acquiring first guarantees that
          // such a request waits for the next frame, so the shutter window
          // receives at least two distinct pose samples instead of accepting
          // the same frame that created the request.
          adapter.acquirePendingCapture(frame, snapshot);
          adapter.onFrame(snapshot);
        }
      }
    } catch (error) {
      adapter.onFatal(error);
      adapter.stop();
      return;
    }
    if (adapter.running && adapter.session) {
      adapter.requestId = adapter.session.requestAnimationFrame(adapter.frameHandler);
    }
  };

  adapter.start = function () {
    if (adapter.running) return Promise.resolve();
    if (adapter.startPending) return adapter.startPending.promise;

    var generation = adapter.startGeneration + 1;
    adapter.startGeneration = generation;
    var pending = {
      generation: generation,
      settled: false,
      attemptTimer: null,
      resolve: null,
      reject: null,
      promise: null
    };
    pending.promise = new Promise(function (resolve, reject) {
      pending.resolve = resolve;
      pending.reject = reject;
    });
    adapter.startPending = pending;

    function isCurrent() {
      return !pending.settled &&
        adapter.startPending === pending &&
        adapter.startGeneration === generation;
    }

    function settleSuccess() {
      if (!isCurrent()) return;
      if (pending.attemptTimer) clearTimeout(pending.attemptTimer);
      pending.attemptTimer = null;
      pending.settled = true;
      adapter.startPending = null;
      pending.resolve();
    }

    function settleFailure(error) {
      if (pending.settled) return;
      if (pending.attemptTimer) clearTimeout(pending.attemptTimer);
      pending.attemptTimer = null;
      pending.settled = true;
      if (adapter.startPending === pending) adapter.startPending = null;
      adapter.running = false;
      adapter.session = null;
      adapter.sessionVersion = null;
      releaseGl();
      pending.reject(error);
    }

    var versions = ["v1", "v2"];
    adapter.frameHandler = function (timestampMs) {
      adapter.handleFrame(timestampMs);
    };

    function attempt(index, previousError) {
      if (!isCurrent()) return;
      if (index >= versions.length) {
        var finalError = makeError(
          "VisionKit v1 与 v2 三自由度会话均启动失败",
          "VK_SESSION_START_FAILED",
          previousError
        );
        settleFailure(finalError);
        return;
      }

      var attemptedVersion = versions[index];
      var localSession = null;
      try {
        localSession = wxApi.createVKSession({
          version: attemptedVersion,
          track: { plane: { mode: 1 }, threeDof: true },
          gl: adapter.gl
        });
        if (!localSession ||
            typeof localSession.start !== "function" ||
            typeof localSession.getVKFrame !== "function" ||
            typeof localSession.requestAnimationFrame !== "function") {
          throw makeError(
            "VisionKit " + attemptedVersion + " 会话接口不完整",
            "VK_SESSION_INCOMPLETE"
          );
        }
      } catch (createError) {
        cleanupSession(localSession, null);
        attempt(index + 1, createError);
        return;
      }

      adapter.session = localSession;
      var callbackHandled = false;
      pending.attemptTimer = setTimeout(function () {
        if (callbackHandled) return;
        callbackHandled = true;
        pending.attemptTimer = null;
        if (!isCurrent() || adapter.session !== localSession) {
          cleanupSession(localSession, null);
          return;
        }
        cleanupSession(localSession, null);
        if (adapter.session === localSession) adapter.session = null;
        var timeoutError = makeError(
          "VisionKit " + attemptedVersion + " 会话启动超时",
          "VK_SESSION_START_TIMEOUT"
        );
        attempt(index + 1, timeoutError);
      }, adapter.sessionStartTimeoutMs);
      try {
        localSession.start(function (startError) {
          if (callbackHandled) return;
          callbackHandled = true;
          if (pending.attemptTimer) clearTimeout(pending.attemptTimer);
          pending.attemptTimer = null;
          if (!isCurrent() || adapter.session !== localSession) {
            cleanupSession(localSession, null);
            return;
          }
          if (startError) {
            cleanupSession(localSession, null);
            if (adapter.session === localSession) adapter.session = null;
            attempt(index + 1, startError);
            return;
          }

          try {
            adapter.running = true;
            adapter.sessionVersion = localSession.version || attemptedVersion;
            adapter.requestId = localSession.requestAnimationFrame(adapter.frameHandler);
            adapter.onReady({
              backend: "visionkit",
              version: adapter.sessionVersion
            });
            settleSuccess();
          } catch (readyError) {
            adapter.running = false;
            cleanupSession(localSession, adapter.requestId);
            adapter.requestId = null;
            if (adapter.session === localSession) adapter.session = null;
            attempt(index + 1, readyError);
          }
        });
      } catch (startThrown) {
        if (callbackHandled) return;
        callbackHandled = true;
        if (pending.attemptTimer) clearTimeout(pending.attemptTimer);
        pending.attemptTimer = null;
        cleanupSession(localSession, null);
        if (adapter.session === localSession) adapter.session = null;
        attempt(index + 1, startThrown);
      }
    }

    try {
      if (!wxApi || typeof wxApi.createVKSession !== "function") {
        throw makeError(
          "当前微信内核没有 createVKSession",
          "VK_CREATE_SESSION_UNAVAILABLE"
        );
      }
      adapter.initGl();
      attempt(0, null);
    } catch (error) {
      settleFailure(error);
    }
    return pending.promise;
  };

  adapter.captureNextFrame = function (options) {
    options = options || {};
    if (!adapter.running || !adapter.session) {
      return Promise.reject(new Error("VisionKit 尚未开始取帧"));
    }
    if (adapter.pendingCapture) {
      return Promise.reject(new Error("已有一张照片正在取帧"));
    }
    return new Promise(function (resolve, reject) {
      var timeoutMs = Math.max(250, Number(options.timeoutMs) || 1500);
      var preferRgba = options.preferRgba === true || options.rgbaOnly === true;
      var pending = {
        width: Math.max(2, Math.round(Number(options.width) || 720)),
        height: Math.max(2, Math.round(Number(options.height) || 960)),
        // Sweep mode samples frequent low-resolution frames. Use 360x480 by
        // default there; preserve the historic 480x640 fallback dimensions
        // when captureNextFrame() is called without an RGBA preference.
        rgbaWidth: alignCameraBufferWidth(
          Number(options.rgbaWidth) || (preferRgba ? 352 : 480)
        ),
        rgbaHeight: Math.max(2, Math.round(
          Number(options.rgbaHeight) || (preferRgba ? 480 : 640)
        )),
        quality: Math.max(1, Math.min(100, Math.round(Number(options.quality) || 88))),
        preferRgba: preferRgba,
        rgbaOnly: options.rgbaOnly === true,
        resolve: resolve,
        reject: reject,
        timer: null
      };
      pending.timer = setTimeout(function () {
        if (adapter.pendingCapture !== pending) return;
        adapter.pendingCapture = null;
        var error = new Error("VisionKit 等待同帧照片超时");
        error.code = "VK_CAPTURE_TIMEOUT";
        reject(error);
      }, timeoutMs);
      adapter.pendingCapture = pending;
    });
  };

  adapter.stop = function () {
    adapter.startGeneration += 1;
    adapter.running = false;
    if (adapter.startPending) {
      var startPending = adapter.startPending;
      adapter.startPending = null;
      if (startPending.attemptTimer) clearTimeout(startPending.attemptTimer);
      startPending.attemptTimer = null;
      if (!startPending.settled) {
        startPending.settled = true;
        startPending.reject(makeError(
          "VisionKit 启动已取消",
          "VK_START_CANCELLED"
        ));
      }
    }
    if (adapter.pendingCapture) {
      var capturePending = adapter.pendingCapture;
      adapter.pendingCapture = null;
      clearTimeout(capturePending.timer);
      capturePending.reject(makeError(
        "VisionKit 拍摄已取消",
        "VK_CAPTURE_CANCELLED"
      ));
    }
    var session = adapter.session;
    var requestId = adapter.requestId;
    adapter.requestId = null;
    adapter.session = null;
    adapter.sessionVersion = null;
    cleanupSession(session, requestId);
    releaseGl();
    adapter.latestSnapshot = null;
    adapter.lastFrameTimestampNs = 0;
    adapter.lastFramePollRafMs = null;
    adapter.frameHandler = null;
  };

  return adapter;
}

module.exports = {
  compareVersion: compareVersion,
  createAdapter: createAdapter,
  detectSupport: detectSupport
};
