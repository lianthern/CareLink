#!/usr/bin/env node
"use strict";

var assert = require("assert");
var P = require("../utils/pano-core.js");
var Pose = require("../utils/capture-pose.js");
var Quality = require("../utils/capture-quality.js");
var VK = require("../utils/visionkit-capture.js");
var Registration = require("../utils/mini-visual-registration.js");

function close(actual, expected, epsilon, label) {
  assert.ok(Math.abs(actual - expected) <= epsilon,
    label + ": expected " + expected + ", got " + actual);
}

function yawBasis(degrees) {
  var radians = degrees * Math.PI / 180;
  return P.orthonormalBasis(
    [Math.sin(radians), Math.cos(radians), 0],
    [0, 0, 1]
  );
}

function patternedPixels(width, height) {
  var pixels = new Uint8ClampedArray(width * height * 4);
  for (var y = 0; y < height; y += 1) {
    for (var x = 0; x < width; x += 1) {
      var value = ((x >> 2) + (y >> 2)) % 2 ? 210 : 40;
      var index = (y * width + x) * 4;
      pixels[index] = value;
      pixels[index + 1] = value;
      pixels[index + 2] = value;
      pixels[index + 3] = 255;
    }
  }
  return pixels;
}

function fakeGl() {
  var id = 0;
  return {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    STATIC_DRAW: 6,
    FLOAT: 7,
    DEPTH_TEST: 8,
    TEXTURE0: 10,
    TEXTURE1: 11,
    TEXTURE_2D: 12,
    TRIANGLE_STRIP: 13,
    createShader: function () { return { id: ++id }; },
    shaderSource: function () {},
    compileShader: function () {},
    getShaderParameter: function () { return true; },
    getShaderInfoLog: function () { return ""; },
    deleteShader: function () {},
    createProgram: function () { return { id: ++id }; },
    attachShader: function () {},
    linkProgram: function () {},
    getProgramParameter: function () { return true; },
    getProgramInfoLog: function () { return ""; },
    createBuffer: function () { return { id: ++id }; },
    bindBuffer: function () {},
    bufferData: function () {},
    getAttribLocation: function (_program, name) { return name === "a_position" ? 0 : 1; },
    getUniformLocation: function (_program, name) { return { name: name }; },
    viewport: function () {},
    disable: function () {},
    useProgram: function () {},
    vertexAttribPointer: function () {},
    enableVertexAttribArray: function () {},
    uniformMatrix3fv: function () {},
    uniform1i: function () {},
    activeTexture: function () {},
    bindTexture: function () {},
    drawArrays: function () {},
    deleteBuffer: function () {},
    deleteProgram: function () {}
  };
}

async function run() {
  assert.strictEqual(VK.compareVersion("3.2.5", "2.32.1"), 1);
  assert.strictEqual(VK.compareVersion("2.32.1", "2.32.1"), 0);
  assert.strictEqual(VK.detectSupport({
    createVKSession: function () {},
    getAppBaseInfo: function () { return { SDKVersion: "3.2.5" }; }
  }).supported, true);
  assert.strictEqual(VK.detectSupport({
    createVKSession: function () {},
    getAppBaseInfo: function () { return { SDKVersion: "2.32.0" }; }
  }).code, "SDK_TOO_OLD");
  assert.strictEqual(VK.detectSupport({
    createVKSession: function () {},
    getAppBaseInfo: function () { return { SDKVersion: "2.32.1" }; }
  }).supported, true);
  assert.strictEqual(VK.detectSupport({
    getAppBaseInfo: function () { return { SDKVersion: "3.2.5" }; }
  }).code, "NO_VISIONKIT");

  var identityView = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1
  ]);
  var identityBasis = Pose.basisFromVisionKitViewMatrix(identityView);
  assert.ok(P.angleDeg(identityBasis.F, [0, 1, 0]) < 1e-6);
  assert.ok(P.angleDeg(identityBasis.U, [0, 0, 1]) < 1e-6);
  assert.ok(P.angleDeg(identityBasis.R, [1, 0, 0]) < 1e-6);

  var target = yawBasis(90);
  var at20 = yawBasis(0);
  var at60 = yawBasis(0);
  for (var i = 0; i < 20; i += 1) {
    at20 = Pose.smoothBasisDt(at20, target, 50, 90);
  }
  for (var j = 0; j < 60; j += 1) {
    at60 = Pose.smoothBasisDt(at60, target, 1000 / 60, 90);
  }
  assert.ok(Pose.basisRotationErrorDeg(at20, at60) < 0.03,
    "dt smoothing must be frame-rate independent");
  close(Pose.fovFromIntrinsics([600, 0, 0, 0, 600, 0, 0, 0, 1], 720, 65),
    61.9275, 0.01, "intrinsics fov");

  var flat = new Uint8ClampedArray(96 * 96 * 4).fill(120);
  var sharp = Quality.analyzeImage(patternedPixels(96, 96), 96, 96);
  var blurred = Quality.analyzeImage(flat, 96, 96);
  assert.ok(sharp.sharpness > blurred.sharpness + 100);
  assert.strictEqual(Quality.classifyFrame({
    maxRawSpeedDegS: 7,
    poseSpanDeg: 0.2,
    targetAngleDeg: 1,
    rollDeg: 1,
    shutterWindowMs: 40,
    sharpness: sharp.sharpness,
    lumaMean: sharp.lumaMean,
    clippedRatio: sharp.clippedRatio
  }).accepted, false);
  assert.strictEqual(Quality.classifyFrame({
    maxRawSpeedDegS: 2,
    poseSpanDeg: 0.4,
    targetAngleDeg: 1,
    rollDeg: 1,
    shutterWindowMs: 40,
    sharpness: sharp.sharpness,
    lumaMean: sharp.lumaMean,
    clippedRatio: sharp.clippedRatio
  }).accepted, true);

  var sourceWidth = 300;
  var sourceHeight = 400;
  var thumbnail = Registration.createThumbnail({
    data: patternedPixels(sourceWidth, sourceHeight),
    width: sourceWidth,
    height: sourceHeight
  });
  assert.strictEqual(Math.max(thumbnail.width, thumbnail.height), 216);
  assert.ok(thumbnail.byteLength * 28 < Registration.MAX_TOTAL_BYTES,
    "28 registration thumbnails must remain below 5 MiB");
  assert.deepStrictEqual(Registration.completeRings(11), []);
  assert.strictEqual(Registration.completeRings(12).length, 1);
  assert.strictEqual(Registration.completeRings(20).length, 2);
  assert.strictEqual(Registration.completeRings(28).length, 3);

  var gl = fakeGl();
  var scheduled = null;
  var frameCount = 0;
  var jpegArgs = null;
  var readyInfo = null;
  var jpg = new Uint8Array(96);
  jpg[0] = 0xff;
  jpg[1] = 0xd8;
  var frame = {
    timestamp: 1234567000,
    camera: {
      viewMatrix: identityView,
      intrinsics: new Float32Array([600, 0, 0, 0, 600, 0, 0, 0, 1]),
      getProjectionMatrix: function () {
        return new Float32Array([1.4, 0, 0, 0, 0, 1.8, 0, 0, 0, 0, -1, -1, 0, 0, -0.02, 0]);
      }
    },
    getCameraTexture: function () { return { yTexture: {}, uvTexture: {} }; },
    getDisplayTransform: function () {
      return new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    },
    getCameraJpgBuffer: function (width, height, quality) {
      jpegArgs = [width, height, quality];
      return jpg.buffer;
    }
  };
  var session = {
    version: "v1-runtime",
    start: function (callback) { callback(null); },
    getVKFrame: function () { frameCount += 1; return frame; },
    requestAnimationFrame: function (callback) { scheduled = callback; return frameCount + 1; },
    cancelAnimationFrame: function () {},
    stop: function () {},
    destroy: function () {}
  };
  var adapter = VK.createAdapter({
    wxApi: {
      createVKSession: function (config) {
        assert.strictEqual(config.version, "v1");
        assert.strictEqual(config.track.threeDof, true);
        return session;
      }
    },
    canvas: {
      getContext: function () { return gl; },
      width: 1,
      height: 1
    },
    cssWidth: 270,
    cssHeight: 360,
    pixelRatio: 2,
    onReady: function (info) { readyInfo = info; }
  });
  await adapter.start();
  assert.strictEqual(readyInfo.version, "v1-runtime",
    "onReady must report the session's actual version");
  assert.throws(function () {
    adapter.renderFrame({});
  }, function (error) {
    return error.code === "VK_CAMERA_TEXTURE_METHOD_MISSING";
  });
  assert.throws(function () {
    adapter.renderFrame({
      getCameraTexture: function () { return { yTexture: {}, uvTexture: {} }; }
    });
  }, function (error) {
    return error.code === "VK_DISPLAY_TRANSFORM_METHOD_MISSING";
  });

  var capture = adapter.captureNextFrame({ quality: 90 });
  scheduled();
  var payload = await capture;
  assert.strictEqual(payload.kind, "jpeg");
  assert.deepStrictEqual(jpegArgs, [720, 960, 90]);
  assert.strictEqual(payload.width, 720);
  assert.strictEqual(payload.height, 960);
  assert.strictEqual(payload.buffer, jpg.buffer,
    "standalone frame buffers must not be cloned");
  assert.strictEqual(payload.snapshot.timestampNs, frame.timestamp);
  assert.ok(P.angleDeg(payload.snapshot.basis.F, [0, 1, 0]) < 1e-6);
  var expectedProjectionFov = Pose.fovFromProjectionMatrix(
    frame.camera.getProjectionMatrix(),
    65
  );
  close(payload.snapshot.fovXDeg, expectedProjectionFov, 1e-8,
    "projection FOV must take precedence");
  assert.ok(payload.snapshot.diagnostics);
  close(payload.snapshot.diagnostics.projectionFovXDeg,
    expectedProjectionFov, 1e-8, "projection diagnostic");
  assert.ok(payload.snapshot.diagnostics.fovMismatchDeg > 5);

  var intrinsicsOnly = adapter.snapshotFrame({
    timestamp: 1,
    camera: {
      viewMatrix: identityView,
      intrinsics: new Float32Array([600, 0, 0, 0, 600, 0, 0, 0, 1])
    }
  });
  close(intrinsicsOnly.fovXDeg,
    Pose.fovFromIntrinsics(intrinsicsOnly.intrinsics, 540, 65),
    1e-8, "intrinsics FOV fallback");
  var invalidProjection = adapter.snapshotFrame({
    timestamp: 2,
    camera: {
      viewMatrix: identityView,
      intrinsics: new Float32Array([600, 0, 0, 0, 600, 0, 0, 0, 1]),
      getProjectionMatrix: function () {
        return new Float32Array([0.02, 0, 0, 0, 0, 1.8, 0, 0, 0, 0, -1, -1, 0, 0, -0.02, 0]);
      }
    }
  });
  close(invalidProjection.fovXDeg,
    Pose.fovFromIntrinsics(invalidProjection.intrinsics, 540, 65),
    1e-8, "invalid projection must fall back to intrinsics");
  adapter.stop();

  var fallbackVersions = [];
  var failedV1StopCount = 0;
  var failedV1DestroyCount = 0;
  var rgbaArgs = null;
  var fallbackScheduled = null;
  var rgbaWidth = 48;
  var rgbaHeight = 64;
  var rgbaBuffer = new Uint8Array(rgbaWidth * rgbaHeight * 4).buffer;
  var rgbaFrame = {
    timestamp: 222,
    camera: {
      viewMatrix: identityView,
      getProjectionMatrix: function () {
        return new Float32Array([1.4, 0, 0, 0, 0, 1.8, 0, 0, 0, 0, -1, -1, 0, 0, -0.02, 0]);
      }
    },
    getCameraTexture: frame.getCameraTexture,
    getDisplayTransform: frame.getDisplayTransform,
    getCameraJpgBuffer: function (width, height) {
      assert.deepStrictEqual([width, height], [720, 960]);
      return new ArrayBuffer(0);
    },
    getCameraBuffer: function (width, height) {
      rgbaArgs = [width, height];
      return rgbaBuffer;
    }
  };
  var failedV1 = {
    start: function (callback) {
      var error = new Error("v1 unavailable");
      error.code = "MOCK_V1_START_FAILED";
      callback(error);
    },
    getVKFrame: function () { return null; },
    requestAnimationFrame: function () { return 1; },
    stop: function () { failedV1StopCount += 1; },
    destroy: function () { failedV1DestroyCount += 1; }
  };
  var fallbackV2 = {
    version: "v2-runtime",
    start: function (callback) { callback(null); },
    getVKFrame: function () { return rgbaFrame; },
    requestAnimationFrame: function (callback) {
      fallbackScheduled = callback;
      return 2;
    },
    cancelAnimationFrame: function () {},
    stop: function () {},
    destroy: function () {}
  };
  var fallbackReady = null;
  var fallbackAdapter = VK.createAdapter({
    wxApi: {
      createVKSession: function (config) {
        fallbackVersions.push(config.version);
        return config.version === "v1" ? failedV1 : fallbackV2;
      }
    },
    canvas: {
      getContext: function () { return fakeGl(); },
      width: 1,
      height: 1
    },
    cssWidth: 270,
    cssHeight: 360,
    pixelRatio: 2,
    onReady: function (info) { fallbackReady = info; }
  });
  await fallbackAdapter.start();
  assert.deepStrictEqual(fallbackVersions, ["v1", "v2"]);
  assert.strictEqual(failedV1StopCount, 1);
  assert.strictEqual(failedV1DestroyCount, 1);
  assert.strictEqual(fallbackReady.version, "v2-runtime");
  var rgbaCapture = fallbackAdapter.captureNextFrame({
    rgbaWidth: rgbaWidth,
    rgbaHeight: rgbaHeight
  });
  fallbackScheduled();
  var rgbaPayload = await rgbaCapture;
  assert.strictEqual(rgbaPayload.kind, "rgba");
  assert.deepStrictEqual(rgbaArgs, [rgbaWidth, rgbaHeight]);
  assert.strictEqual(rgbaPayload.width, rgbaWidth);
  assert.strictEqual(rgbaPayload.height, rgbaHeight);
  assert.strictEqual(rgbaPayload.buffer, rgbaBuffer);

  var cancelledCapture = fallbackAdapter.captureNextFrame();
  fallbackAdapter.stop();
  await assert.rejects(cancelledCapture, function (error) {
    return error.code === "VK_CAPTURE_CANCELLED";
  });
  assert.strictEqual(fallbackAdapter.pendingCapture, null);

  var timeoutVersions = [];
  var timedOutV1Stops = 0;
  var timedOutV1Destroys = 0;
  var silentV1 = {
    start: function () {},
    getVKFrame: function () { return null; },
    requestAnimationFrame: function () { return 1; },
    stop: function () { timedOutV1Stops += 1; },
    destroy: function () { timedOutV1Destroys += 1; }
  };
  var timeoutV2 = {
    version: "v2-after-timeout",
    start: function (callback) { callback(null); },
    getVKFrame: function () { return frame; },
    requestAnimationFrame: function () { return 2; },
    cancelAnimationFrame: function () {},
    stop: function () {},
    destroy: function () {}
  };
  var timeoutReady = null;
  var timeoutAdapter = VK.createAdapter({
    wxApi: {
      createVKSession: function (config) {
        timeoutVersions.push(config.version);
        return config.version === "v1" ? silentV1 : timeoutV2;
      }
    },
    canvas: {
      getContext: function () { return fakeGl(); },
      width: 1,
      height: 1
    },
    cssWidth: 270,
    cssHeight: 360,
    pixelRatio: 2,
    sessionStartTimeoutMs: 20,
    onReady: function (info) { timeoutReady = info; }
  });
  await timeoutAdapter.start();
  assert.deepStrictEqual(timeoutVersions, ["v1", "v2"],
    "a silent v1 start must time out and try v2");
  assert.strictEqual(timedOutV1Stops, 1);
  assert.strictEqual(timedOutV1Destroys, 1);
  assert.strictEqual(timeoutReady.version, "v2-after-timeout");
  timeoutAdapter.stop();

  var autoScheduled = [];
  var autoFrameCount = 0;
  var autoFrameReadCount = 0;
  var autoCapturePromise = null;
  var autoAdapter = null;
  var autoT0 = 7000000000;
  var autoT1 = autoT0 + 33333333;
  var autoTimestamps = [autoT0, autoT0, autoT1];
  var autoSession = {
    version: "v1-auto-order",
    start: function (callback) { callback(null); },
    getVKFrame: function () {
      var index = Math.min(autoFrameReadCount, autoTimestamps.length - 1);
      autoFrameReadCount += 1;
      frame.timestamp = autoTimestamps[index];
      return frame;
    },
    requestAnimationFrame: function (callback) {
      autoScheduled.push(callback);
      return autoScheduled.length;
    },
    cancelAnimationFrame: function () {},
    stop: function () {},
    destroy: function () {}
  };
  autoAdapter = VK.createAdapter({
    wxApi: {
      createVKSession: function () { return autoSession; }
    },
    canvas: {
      getContext: function () { return fakeGl(); },
      width: 1,
      height: 1
    },
    cssWidth: 270,
    cssHeight: 360,
    pixelRatio: 2,
    onFrame: function () {
      autoFrameCount += 1;
      if (autoFrameCount === 1) {
        autoCapturePromise = autoAdapter.captureNextFrame({ timeoutMs: 200 });
      }
    }
  });
  await autoAdapter.start();
  autoScheduled.shift()(0);
  var autoSettledOnSameFrame = false;
  autoCapturePromise.then(function () { autoSettledOnSameFrame = true; });
  await Promise.resolve();
  assert.strictEqual(autoSettledOnSameFrame, false,
    "an auto-capture requested inside onFrame must not consume that same frame");
  autoScheduled.shift()(16);
  await Promise.resolve();
  assert.strictEqual(autoFrameReadCount, 1,
    "getVKFrame must be throttled to at most 30 fps when RAF supplies a clock");
  assert.strictEqual(autoSettledOnSameFrame, false,
    "a throttled redraw must leave the pending shutter untouched");
  autoScheduled.shift()(34);
  await Promise.resolve();
  assert.strictEqual(autoFrameReadCount, 2);
  assert.strictEqual(autoFrameCount, 1,
    "a repeated non-zero VKFrame timestamp must not call onFrame");
  assert.strictEqual(autoSettledOnSameFrame, false,
    "a repeated non-zero VKFrame timestamp must not settle the pending shutter");
  assert.ok(autoAdapter.pendingCapture,
    "the pending shutter must wait for a genuinely newer camera frame");
  autoScheduled.shift()(68);
  var autoPayload = await autoCapturePromise;
  assert.strictEqual(autoPayload.kind, "jpeg");
  assert.strictEqual(autoPayload.snapshot.timestampNs, autoT1,
    "the pending shutter must resolve with the next distinct VKFrame timestamp");
  assert.strictEqual(autoFrameCount, 2,
    "the next distinct VKFrame must update pose before capture continuation");
  assert.strictEqual(autoAdapter.lastFrameTimestampNs, autoT1);
  assert.strictEqual(autoAdapter.lastFramePollRafMs, 68);
  autoTimestamps[2] = 0;
  autoScheduled.shift()(102);
  autoScheduled.shift()(136);
  assert.strictEqual(autoFrameCount, 4,
    "zero timestamps are unavailable metadata and must not be de-duplicated");
  assert.strictEqual(autoAdapter.lastFrameTimestampNs, autoT1,
    "zero timestamps must not replace the last reliable camera timestamp");
  autoAdapter.stop();
  assert.strictEqual(autoAdapter.lastFrameTimestampNs, 0,
    "stop must clear timestamp de-duplication state");
  assert.strictEqual(autoAdapter.lastFramePollRafMs, null,
    "stop must clear 30 fps throttling state");

  var stoppedTimeoutVersions = [];
  var stoppedSilentSession = {
    start: function () {},
    getVKFrame: function () { return frame; },
    requestAnimationFrame: function () { return 1; },
    stop: function () {},
    destroy: function () {}
  };
  var stoppedTimeoutAdapter = VK.createAdapter({
    wxApi: {
      createVKSession: function (config) {
        stoppedTimeoutVersions.push(config.version);
        return stoppedSilentSession;
      }
    },
    canvas: {
      getContext: function () { return fakeGl(); },
      width: 1,
      height: 1
    },
    cssWidth: 270,
    cssHeight: 360,
    pixelRatio: 2,
    sessionStartTimeoutMs: 20
  });
  var stoppedTimeoutStart = stoppedTimeoutAdapter.start();
  stoppedTimeoutAdapter.stop();
  await assert.rejects(stoppedTimeoutStart, function (error) {
    return error.code === "VK_START_CANCELLED";
  });
  await new Promise(function (resolve) { setTimeout(resolve, 45); });
  assert.deepStrictEqual(stoppedTimeoutVersions, ["v1"],
    "stop must cancel the version timer and never create v2 later");

  var delayedStartCallback = null;
  var lateRafCount = 0;
  var delayedSession = {
    start: function (callback) { delayedStartCallback = callback; },
    getVKFrame: function () { return frame; },
    requestAnimationFrame: function () {
      lateRafCount += 1;
      return 9;
    },
    stop: function () {},
    destroy: function () {}
  };
  var delayedAdapter = VK.createAdapter({
    wxApi: {
      createVKSession: function (config) {
        assert.strictEqual(config.version, "v1");
        return delayedSession;
      }
    },
    canvas: {
      getContext: function () { return fakeGl(); },
      width: 1,
      height: 1
    },
    cssWidth: 270,
    cssHeight: 360,
    pixelRatio: 2
  });
  var delayedStart = delayedAdapter.start();
  delayedAdapter.stop();
  delayedStartCallback(null);
  await assert.rejects(delayedStart, function (error) {
    return error.code === "VK_START_CANCELLED";
  });
  assert.strictEqual(delayedAdapter.running, false);
  assert.strictEqual(delayedAdapter.session, null);
  assert.strictEqual(delayedAdapter.startPending, null);
  assert.strictEqual(lateRafCount, 0,
    "a late start callback must never revive or schedule the destroyed session");

  console.log("✅ VisionKit 能力门、v1/v2 回退、同帧尺寸、FOV 与启动竞态测试通过");
}

run().catch(function (error) {
  console.error(error);
  process.exit(1);
});
