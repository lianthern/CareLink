#!/usr/bin/env node
"use strict";

/*
 * Repeatable desktop/JIT-less proxy benchmark for the synchronous work that
 * follows one WeChat panorama shot. Run both:
 *
 *   node tools/benchmark_mini_capture_hotspots.js
 *   node --jitless tools/benchmark_mini_capture_hotspots.js
 *
 * JIT-less is not a phone emulator, but it is a useful conservative signal for
 * catching accidental O(screenPixels) work on the mini-program main thread.
 */

var fs = require("fs");
var path = require("path");
var vm = require("vm");

var ROOT = path.resolve(__dirname, "..");
var CAPTURE_DIR = path.join(ROOT, "miniapp/pages/capture");
var P = require(path.join(ROOT, "miniapp/utils/pano-core.js"));
var Registration = require(path.join(ROOT, "miniapp/utils/mini-visual-registration.js"));
var definition = null;

vm.runInNewContext(
  fs.readFileSync(path.join(CAPTURE_DIR, "capture.js"), "utf8"),
  {
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
  }
);

function median(values) {
  var sorted = values.slice().sort(function (left, right) { return left - right; });
  return sorted[Math.floor(sorted.length / 2)];
}

function measure(callback, count) {
  var values = [];
  for (var index = 0; index < (count || 7); index += 1) {
    var started = process.hrtime.bigint();
    callback();
    values.push(Number(process.hrtime.bigint() - started) / 1000000);
  }
  return Number(median(values.slice(1)).toFixed(2));
}

function patterned(width, height) {
  var pixels = new Uint8ClampedArray(width * height * 4);
  for (var y = 0; y < height; y += 1) {
    for (var x = 0; x < width; x += 1) {
      var offset = (y * width + x) * 4;
      pixels[offset] = (x * 7 + y * 3) % 256;
      pixels[offset + 1] = (x * 2 + y * 11) % 256;
      pixels[offset + 2] = (x * 5 + y * 5) % 256;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

var sourceWidth = 480;
var sourceHeight = 640;
var pixels = patterned(sourceWidth, sourceHeight);
var basis = P.orthonormalBasis([0, 1, 0], [0, 0, 1]);
var raster = P.createRaster(512, 256);
var projectMs = measure(function () {
  P.projectPatch(raster, pixels, sourceWidth, sourceHeight, basis, {
    fovXDeg: 65,
    feather: 0.2
  });
});

var thumbnailMs = measure(function () {
  Registration.createThumbnail({
    data: pixels,
    width: sourceWidth,
    height: sourceHeight
  });
});

for (var rasterIndex = 0; rasterIndex < raster.weights.length; rasterIndex += 1) {
  raster.weights[rasterIndex] = 1;
  var pixelIndex = rasterIndex * 4;
  raster.pixels[pixelIndex] = 90;
  raster.pixels[pixelIndex + 1] = 130;
  raster.pixels[pixelIndex + 2] = 170;
  raster.pixels[pixelIndex + 3] = 255;
}
var worldWidth = 117;
var worldHeight = 253;
var page = Object.assign({}, definition, {
  data: Object.assign({}, definition.data, { phase: "capture", busy: false }),
  pageAlive: true,
  pageVisible: true,
  captureBackend: "visionkit",
  frames: [{}],
  coarse: raster,
  trackingPose: basis,
  displayPose: basis,
  basis: basis,
  currentFovXDeg: 65,
  worldCssWidth: 390,
  worldCssHeight: 844,
  worldCanvasNode: { width: worldWidth, height: worldHeight },
  worldCtx: {
    createImageData: function (width, height) {
      return { data: new Uint8ClampedArray(width * height * 4) };
    },
    putImageData: function () {}
  },
  liveViewport: {
    left: 55,
    top: 227,
    width: 280,
    height: 373,
    centerX: 195,
    centerY: 422
  }
});
var previewMs = measure(function () { page.drawWorldPreview(); });

var thumbnail = Registration.createThumbnail({
  data: pixels,
  width: sourceWidth,
  height: sourceHeight
});
var reference = {
  pixels: thumbnail.pixels,
  width: thumbnail.width,
  height: thumbnail.height,
  basis: basis,
  correctedBasis: basis,
  fovXDeg: 65,
  correctedFovXDeg: 65,
  gain: 1,
  bias: 0
};
var current = {
  pixels: thumbnail.pixels,
  width: thumbnail.width,
  height: thumbnail.height,
  basis: basis,
  fovXDeg: 65
};
var refineOptions = {
  maxReferences: 2,
  maxReferenceAngleDeg: 78,
  maxCorrectionDeg: 6,
  maxRollDeg: 4,
  maxFovCorrectionDeg: 6,
  levels: 2,
  minOverlapRatio: 0.08,
  minScore: 0.72,
  imuPriorWeight: 0.04,
  targetSamples: 420
};
var refineOneMs = measure(function () {
  P.refineFramePoseFromReferences([reference], current, refineOptions);
}, 4);
var refineTwoMs = measure(function () {
  P.refineFramePoseFromReferences([reference, reference], current, {
    maxReferences: 2,
    maxReferenceAngleDeg: 78,
    maxCorrectionDeg: 6,
    maxRollDeg: 4,
    maxFovCorrectionDeg: 6,
    levels: 2,
    minOverlapRatio: 0.08,
    minScore: 0.72,
    imuPriorWeight: 0.04,
    targetSamples: 420
  });
}, 4);

console.log(JSON.stringify({
  runtime: process.execArgv.indexOf("--jitless") >= 0 ? "jitless" : "node",
  rgbaFrame: sourceWidth + "x" + sourceHeight,
  coarseRaster: "512x256",
  worldPreview: worldWidth + "x" + worldHeight,
  medianMs: {
    thumbnail216: thumbnailMs,
    projectPatch512: projectMs,
    worldPreview: previewMs,
    refineOneReference: refineOneMs,
    refineTwoReferencesWorstCase: refineTwoMs
  },
  approximateSynchronousShotWorkMs: Number(
    (thumbnailMs + projectMs + refineOneMs).toFixed(2)
  )
}, null, 2));
