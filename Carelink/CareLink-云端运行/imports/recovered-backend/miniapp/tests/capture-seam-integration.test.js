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

function patterned(width, height, phase) {
  var pixels = new Uint8ClampedArray(width * height * 4);
  for (var y = 0; y < height; y += 1) {
    for (var x = 0; x < width; x += 1) {
      var offset = (y * width + x) * 4;
      pixels[offset] = (x * 5 + phase * 17) % 256;
      pixels[offset + 1] = (y * 7 + phase * 11) % 256;
      pixels[offset + 2] = ((x + y) * 3 + phase * 13) % 256;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

async function run() {
  assert.ok(definition, "capture Page definition should load");
  assert.strictEqual(typeof P.projectPatchSeamAware, "function",
    "shared core should expose the seam-aware projector");

  var fovs = [64.8, 65, 65.1, 65.2, 64.9, 71];
  var frames = fovs.map(function (fov, index) {
    var yaw = index * 30 * Math.PI / 180;
    return {
      path: "frame-" + index,
      basis: P.orthonormalBasis(
        [Math.sin(yaw), Math.cos(yaw), 0],
        [0, 0, 1]
      ),
      correctedBasis: P.orthonormalBasis(
        [Math.sin(yaw), Math.cos(yaw), 0],
        [0, 0, 1]
      ),
      fovXDeg: fov,
      correctedFovXDeg: fov,
      gain: 1,
      bias: 0,
      visual: {
        accepted: true,
        confidence: index === 1 ? 0.63 : 0.9,
        score: 0.94
      }
    };
  });
  var page = Object.assign({}, definition, {
    data: Object.assign({}, definition.data),
    pageAlive: true,
    pageVisible: true,
    lifecycleToken: 7,
    frames: frames,
    registrationFrames: [],
    sessionFovXDeg: 65,
    sessionFovSummary: null,
    setData: function (patch, callback) {
      Object.assign(this.data, patch);
      if (callback) callback();
    },
    loadImageData: async function (framePath) {
      var index = Number(String(framePath).split("-")[1]) || 0;
      return {
        data: patterned(72, 96, index),
        width: 72,
        height: 96
      };
    }
  });

  var fovSummary = page.finalizeSessionFov();
  assert.strictEqual(fovSummary.method, "visual-confidence-weighted-median");
  assert.ok(Math.abs(fovSummary.fovXDeg - 65) <= 0.2,
    "one visual FOV outlier should not change the session lens");
  assert.ok(page.frames.every(function (frame) {
    return frame.correctedFovXDeg === fovSummary.fovXDeg;
  }), "all final frames should share one FOV");

  var originalProjector = P.projectPatchSeamAware;
  var calls = [];
  P.projectPatchSeamAware = function (
    raster,
    pixels,
    width,
    height,
    basis,
    options
  ) {
    calls.push(Object.assign({}, options));
    return originalProjector(
      raster,
      pixels,
      width,
      height,
      basis,
      options
    );
  };

  var built;
  try {
    built = await page.buildResultRaster(160, 96, 7);
  } finally {
    P.projectPatchSeamAware = originalProjector;
  }
  assert.strictEqual(calls.length, frames.length,
    "final stitch should call the seam-aware projector once per decoded frame");
  calls.forEach(function (options, index) {
    assert.strictEqual(options.frameIndex, index);
    assert.strictEqual(options.bilinear, true);
    assert.strictEqual(options.fovXDeg, fovSummary.fovXDeg);
    assert.ok(Math.abs(
      options.sourceConfidence - frames[index].visual.confidence
    ) < 1e-9, "source confidence should come from visual registration");
  });
  assert.ok(built.stats.nonBlackPixels > 0);
  assert.strictEqual(built.stats.seam.frames, frames.length);
  assert.ok(built.stats.seam.hardSelectedPixels >= 0);
  assert.ok(built.stats.seam.conflictPixels >= 0);

  assert.ok(/P\.projectPatch\(\s*rebuilt,/.test(definition.onUndo.toString()),
    "undo rebuild should retain the low-cost projector");
  assert.ok(/P\.projectPatch\(this\.coarse,/.test(source),
    "capture-time coarse preview should retain the low-cost projector");
  var finishSource = definition.finishCapture.toString();
  assert.ok(
    finishSource.indexOf("this.finalizeSessionFov()") >= 0 &&
      finishSource.indexOf("this.finalizeSessionFov()") <
        finishSource.indexOf("this.optimizeCapturedSequence()"),
    "session FOV should be locked before final pose optimization"
  );
  var releaseSource = source.slice(
    source.indexOf("function releaseRaster("),
    source.indexOf("function weightedMedian(")
  );
  ["priorities", "owners", "lastSeamStats", "seamSummary"].forEach(function (key) {
    assert.ok(new RegExp("raster\\." + key + "\\s*=\\s*null").test(releaseSource),
      "releaseRaster should release " + key);
  });

  // Explicitly shorten the local test lifetime just as the page does after
  // putImageData has copied the result.
  built.raster.pixels = null;
  built.raster.weights = null;
  built.raster.priorities = null;
  built.raster.owners = null;

  console.log("✅ 小程序最终 seam-aware、统一 FOV、置信权重与内存释放集成测试通过");
}

run().catch(function (error) {
  console.error(error);
  process.exit(1);
});
