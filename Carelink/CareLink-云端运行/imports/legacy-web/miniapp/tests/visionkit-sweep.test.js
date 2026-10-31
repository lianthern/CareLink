#!/usr/bin/env node
"use strict";

var assert = require("assert");
var VK = require("../utils/visionkit-capture.js");

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
    getAttribLocation: function (_program, name) {
      return name === "a_position" ? 0 : 1;
    },
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
  var scheduled = [];
  var currentIndex = 0;
  var rgbaCalls = [];
  var jpegCalls = 0;
  var sharedBuffer = new Uint8Array(352 * 480 * 4).buffer;
  var identityView = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1
  ]);
  var deliveredFrames = [];

  function makeFrame(index) {
    var scale = 1 + index / 1000;
    var transform = new Float32Array([
      scale, 0, 0,
      0, scale, 0,
      0, 0, 1
    ]);
    var frame = {
      timestamp: 1000000000 + index * 33333333,
      camera: {
        viewMatrix: identityView,
        getProjectionMatrix: function () {
          return new Float32Array([
            1.4, 0, 0, 0,
            0, 1.8, 0, 0,
            0, 0, -1, -1,
            0, 0, -0.02, 0
          ]);
        }
      },
      getCameraTexture: function () {
        return { yTexture: {}, uvTexture: {} };
      },
      getDisplayTransform: function () { return transform; },
      getCameraBuffer: function (width, height) {
        rgbaCalls.push([width, height, index]);
        return sharedBuffer;
      },
      getCameraJpgBuffer: function () {
        jpegCalls += 1;
        return new Uint8Array(128).buffer;
      }
    };
    deliveredFrames.push({ index: index, transform: Array.from(transform) });
    return frame;
  }

  var session = {
    version: "v1-sweep-test",
    start: function (callback) { callback(null); },
    getVKFrame: function () {
      var frame = makeFrame(currentIndex);
      currentIndex += 1;
      return frame;
    },
    requestAnimationFrame: function (callback) {
      scheduled.push(callback);
      return scheduled.length;
    },
    cancelAnimationFrame: function () {},
    stop: function () {},
    destroy: function () {}
  };
  var adapter = VK.createAdapter({
    wxApi: { createVKSession: function () { return session; } },
    canvas: {
      getContext: function () { return fakeGl(); },
      width: 1,
      height: 1
    },
    cssWidth: 270,
    cssHeight: 360,
    pixelRatio: 1
  });
  await adapter.start();

  for (var i = 0; i < 120; i += 1) {
    var capture = adapter.captureNextFrame({ preferRgba: true, timeoutMs: 250 });
    await assert.rejects(
      adapter.captureNextFrame({ preferRgba: true, timeoutMs: 250 }),
      /已有一张照片正在取帧/,
      "preferRgba capture must never re-enter"
    );
    assert.strictEqual(adapter.pendingCapture.preferRgba, true);
    assert.strictEqual(adapter.pendingCapture.rgbaWidth, 352);
    assert.strictEqual(adapter.pendingCapture.rgbaHeight, 480);
    var callback = scheduled.shift();
    assert.strictEqual(typeof callback, "function");
    callback();
    var payload = await capture;
    assert.strictEqual(payload.kind, "rgba");
    assert.strictEqual(payload.buffer, sharedBuffer,
      "standalone camera ArrayBuffer must not be cloned");
    assert.strictEqual(payload.width, 352);
    assert.strictEqual(payload.height, 480);
    assert.strictEqual(
      payload.snapshot.timestampNs,
      deliveredFrames[i].index * 33333333 + 1000000000
    );
    assert.deepStrictEqual(
      payload.snapshot.displayTransform,
      deliveredFrames[i].transform,
      "snapshot displayTransform must come from the captured VKFrame"
    );
    assert.strictEqual(adapter.pendingCapture, null);
  }

  assert.strictEqual(rgbaCalls.length, 120);
  rgbaCalls.forEach(function (call) {
    assert.deepStrictEqual(call.slice(0, 2), [352, 480]);
  });
  assert.strictEqual(jpegCalls, 0,
    "preferRgba must not probe JPEG before a valid RGBA buffer");

  var alignedCapture = adapter.captureNextFrame({
    preferRgba: true,
    rgbaOnly: true,
    rgbaWidth: 360,
    rgbaHeight: 480,
    timeoutMs: 250
  });
  assert.strictEqual(adapter.pendingCapture.rgbaWidth, 352,
    "an invalid 360px CameraBuffer request must align down to 16 pixels");
  scheduled.shift()();
  var alignedPayload = await alignedCapture;
  assert.deepStrictEqual(
    [alignedPayload.width, alignedPayload.height],
    [352, 480]
  );

  var legacyCapture = adapter.captureNextFrame();
  scheduled.shift()();
  var legacyPayload = await legacyCapture;
  assert.strictEqual(legacyPayload.kind, "jpeg",
    "captureNextFrame() without options must preserve JPEG-first behavior");
  assert.strictEqual(jpegCalls, 1);

  var rgbaOnlyScheduled = scheduled.shift();
  var noRgbaFrame = makeFrame(999);
  delete noRgbaFrame.getCameraBuffer;
  session.getVKFrame = function () { return noRgbaFrame; };
  // Use the callback currently scheduled by the previous handleFrame.
  var rgbaOnly = adapter.captureNextFrame({ rgbaOnly: true, timeoutMs: 250 });
  rgbaOnlyScheduled();
  await assert.rejects(rgbaOnly, function (error) {
    return error && error.code === "VK_CAPTURE_UNSUPPORTED";
  });
  assert.strictEqual(jpegCalls, 1,
    "rgbaOnly must never silently fall back to JPEG");

  adapter.stop();
  console.log("✅ VisionKit 横向扫拍 120 帧：RGBA 优先、无重入、零克隆、同帧 transform 通过");
}

run().catch(function (error) {
  console.error(error);
  process.exit(1);
});
