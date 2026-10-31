#!/usr/bin/env node
"use strict";

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var vm = require("vm");

var ROOT = path.resolve(__dirname, "..", "..");
var CAPTURE_DIR = path.join(ROOT, "miniapp/pages/capture");
var P = require(path.join(ROOT, "miniapp/utils/pano-core.js"));
var definition = null;
var source = fs.readFileSync(path.join(CAPTURE_DIR, "capture.js"), "utf8");

vm.runInNewContext(source, {
  require: function (request) {
    return require(path.resolve(CAPTURE_DIR, request));
  },
  Page: function (value) { definition = value; },
  wx: {},
  getApp: function () { return { globalData: {} }; },
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  Promise: Promise,
  Date: Date,
  Math: Math,
  Uint8Array: Uint8Array,
  Uint8ClampedArray: Uint8ClampedArray,
  Float32Array: Float32Array
});

function patterned(width, height) {
  var pixels = new Uint8ClampedArray(width * height * 4);
  for (var y = 0; y < height; y += 1) {
    for (var x = 0; x < width; x += 1) {
      var value = ((x >> 3) + (y >> 3)) % 2 ? 205 : 45;
      var index = (y * width + x) * 4;
      pixels[index] = value;
      pixels[index + 1] = 255 - value;
      pixels[index + 2] = 80 + ((x * 3 + y * 5) % 120);
      pixels[index + 3] = 255;
    }
  }
  return pixels;
}

async function run() {
  assert.ok(definition, "capture Page definition should load");
  var page = Object.assign({}, definition, {
    data: Object.assign({}, definition.data),
    pageAlive: true,
    pageVisible: true,
    lifecycleToken: 1,
    testMode: false,
    frames: [],
    registrationFrames: [],
    visualEdges: [],
    registrationBytes: 0,
    registrationReleased: false,
    setData: function (patch, callback) {
      Object.assign(this.data, patch);
      if (callback) callback();
    }
  });
  var decoded = {
    data: patterned(180, 240),
    width: 180,
    height: 240
  };
  var basis = P.orthonormalBasis([0, 1, 0], [0, 0, 1]);
  var raw = { basis: basis, fovXDeg: 65, targetIndex: 0 };
  var first = await page.refineCapturedFrame(decoded, raw, 1);
  assert.strictEqual(first.result.method, "visual-anchor");
  page.frames.push({
    basis: basis,
    correctedBasis: first.result.correctedBasis,
    fovXDeg: 65,
    correctedFovXDeg: first.result.correctedFovXDeg,
    gain: 1,
    bias: 0,
    targetIndex: 0
  });
  page.commitVisualRegistration(first.registration, first.result, 0);

  var second = await page.refineCapturedFrame(decoded, raw, 1);
  assert.strictEqual(second.result.accepted, true);
  assert.ok(second.result.confidence > 0.4);
  assert.strictEqual(second.result.referenceIndex, 0);
  assert.strictEqual(second.result.triedReferences, 1,
    "a confident nearest reference should avoid a second synchronous search");
  page.frames.push({
    basis: basis,
    correctedBasis: second.result.correctedBasis,
    fovXDeg: 65,
    correctedFovXDeg: second.result.correctedFovXDeg,
    gain: second.result.gain,
    bias: second.result.bias,
    targetIndex: 1
  });
  page.commitVisualRegistration(second.registration, second.result, 1);
  assert.strictEqual(page.visualEdges.length, 1);
  assert.ok(page.registrationBytes > 0 && page.registrationBytes < 5 * 1024 * 1024);

  var originalMobileRefine = page.refineFramePoseMobile;
  var reference = page.registrationFrames[0];
  reference.gain = 0.8;
  reference.bias = 10;
  page.refineFramePoseMobile = async function () {
    return {
      accepted: true,
      correctedBasis: P.copyBasis(basis),
      correctedFovXDeg: 65,
      gain: 1.2,
      bias: 5,
      confidence: 0.9,
      score: 0.9,
      overlapRatio: 0.5,
      correction: { yawDeg: 0, pitchDeg: 0, rollDeg: 0, fovDeg: 0 },
      referenceIndex: 0,
      method: "test-local-photometric"
    };
  };
  var chained = await page.refineCapturedFrame(decoded, raw, 1);
  page.refineFramePoseMobile = originalMobileRefine;
  assert.ok(Math.abs(chained.result.gain - 0.96) < 1e-9,
    "local gain must compose with reference gain");
  assert.ok(Math.abs(chained.result.bias - 14) < 1e-9,
    "local bias must compose into global panorama exposure");

  var resumePage = Object.assign({}, definition, {
    data: Object.assign({}, definition.data, {
      orientationReady: true,
      cameraReady: true,
      phase: "capture"
    }),
    pageAlive: true,
    pageVisible: true,
    captureBackend: "visionkit",
    headingOffsetDeg: null,
    resumeHeadingDeg: 40,
    trackingPose: P.orthonormalBasis([0, 1, 0], [0, 0, 1]),
    displayPose: P.orthonormalBasis([0, 1, 0], [0, 0, 1]),
    lastTrackingPose: null,
    lastTrackingAt: 0,
    poseHistory: [],
    rawAngularSpeed: Infinity,
    activeShutterWindow: null,
    currentFovXDeg: 65,
    updateTarget: function () {},
    scheduleWorldPreview: function () {},
    setData: function (patch, callback) {
      Object.assign(this.data, patch);
      if (callback) callback();
    }
  });
  var rawYaw = 10 * Math.PI / 180;
  var rawResumeBasis = P.orthonormalBasis(
    [Math.sin(rawYaw), Math.cos(rawYaw), 0],
    [0, 0, 1]
  );
  resumePage.acceptTrackingPose(rawResumeBasis, 1000, {
    source: "visionkit",
    timestampNs: 1000000000,
    fovXDeg: 65
  });
  assert.ok(Math.abs(P.headingDeg(resumePage.trackingPose) - 40) < 1e-7,
    "new VKSession origin must rebase onto the previous panorama heading");

  var optimized = page.optimizeCapturedSequence();
  assert.strictEqual(optimized.bases.length, 2);
  assert.ok(page.frames[1].optimizedBasis);
  var released = page.releaseRegistrationFrames();
  assert.ok(released > 0);
  assert.strictEqual(page.registrationBytes, 0);
  assert.ok(page.registrationFrames.every(function (frame) { return frame.pixels === null; }));

  console.log("✅ 小程序捕获页视觉锚点、相邻校正、优化与缩略图释放集成测试通过");
}

run().catch(function (error) {
  console.error(error);
  process.exit(1);
});
