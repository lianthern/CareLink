#!/usr/bin/env node
"use strict";

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var Sweep = require("../utils/pano-sweep-core.js");

var root = path.resolve(__dirname, "..");
var pagePath = path.join(root, "pages/sweep/sweep.js");
var wxmlPath = path.join(root, "pages/sweep/sweep.wxml");
var pageConfigPath = path.join(root, "pages/sweep/sweep.json");
var appPath = path.join(root, "app.json");
var demoPath = path.join(root, "pages/demo/demo.js");
var source = fs.readFileSync(pagePath, "utf8");
var wxml = fs.readFileSync(wxmlPath, "utf8");
var pageConfig = JSON.parse(fs.readFileSync(pageConfigPath, "utf8"));
var app = JSON.parse(fs.readFileSync(appPath, "utf8"));
var demoSource = fs.readFileSync(demoPath, "utf8");

assert.ok(app.pages.indexOf("pages/sweep/sweep") >= 0,
  "sweep experiment must be packaged for the isolated demo center");
assert.ok(/pages\/sweep\/sweep\?source=demo/.test(demoSource),
  "sweep experiment must be entered through the demo center");
assert.ok(/createSweepSession/.test(source));
assert.ok(/ingestFrame/.test(source));
assert.ok(/finalizeSweep/.test(source));
assert.ok(/releaseSweepSession/.test(source));
assert.ok(/preferRgba:\s*true/.test(source));
assert.ok(/rgbaOnly:\s*true/.test(source));
assert.ok(/MIN_SPAN_DEG\s*=\s*45/.test(source));
assert.ok(/DEFAULT_SPAN_DEG\s*=\s*120/.test(source));
assert.ok(/MAX_SPAN_DEG\s*=\s*180/.test(source));
assert.ok(!/createTargets|projectPatch|stitchFrames2D/.test(source),
  "horizontal sweep must not depend on spherical target/project code");
assert.ok(!/uploadFile|upload\.js/.test(source + wxml),
  "horizontal sweep must never upload");
assert.ok(/type="2d"\s+id="sweepResultCanvas"/.test(wxml),
  "the final result must use an ordinary 2D canvas");
assert.ok(!/viewerCanvas|onToggleViewer|360° 查看/.test(source + wxml),
  "the result path must not depend on a WebGL panorama viewer");
assert.ok(/direction === 'left'/.test(wxml) && /direction === 'right'/.test(wxml),
  "preview must show left/right direction guidance");
assert.ok(/levelText/.test(wxml) && /speedText/.test(wxml),
  "preview must show level and speed guidance");
assert.strictEqual(pageConfig.pageOrientation, "portrait",
  "horizontal panorama output must still use a portrait capture UI");
var rgbaWidthMatch = source.match(/var RGBA_WIDTH = (\d+);/);
assert.ok(rgbaWidthMatch && Number(rgbaWidthMatch[1]) % 16 === 0,
  "VKFrame CameraBuffer width must be aligned to 16 pixels");

var capturedPage = null;
global.Page = function (definition) { capturedPage = definition; };
global.getApp = function () {
  return {
    globalData: {
      statusBarHeight: 20,
      nav: { barTop: 20, barHeight: 44 }
    }
  };
};
global.wx = {
  createVKSession: function () {},
  getAppBaseInfo: function () { return { SDKVersion: "3.2.5" }; },
  nextTick: function (callback) { callback(); }
};
delete require.cache[require.resolve(pagePath)];
var helpers = require(pagePath);
assert.ok(capturedPage, "page definition must load");
assert.ok(/aspect-fill/.test(source),
  "getCameraBuffer must use its documented aspect-fill output directly");
assert.ok(!/VK_SWEEP_TRANSFORM_ROTATION_UNPROVEN/.test(source),
  "displayTransform is a preview-texture transform and must not block RGBA sweep");

function pageInstance() {
  var page = {};
  Object.keys(capturedPage).forEach(function (key) { page[key] = capturedPage[key]; });
  page.data = JSON.parse(JSON.stringify(capturedPage.data));
  page.setData = function (update, callback) {
    Object.keys(update || {}).forEach(function (key) { page.data[key] = update[key]; });
    if (callback) callback();
  };
  return page;
}

var page = pageInstance();
page.onLoad({ degrees: "999" });
assert.strictEqual(page.data.targetSpanDeg, 180);

var permissionPage = pageInstance();
permissionPage.onLoad({ degrees: "120" });
var permissionStopCount = 0;
var permissionResumeCount = 0;
permissionPage.visionKit = {
  stop: function () { permissionStopCount += 1; }
};
permissionPage.cameraStartInFlight = true;
permissionPage.data.cameraOn = true;
permissionPage.data.cameraReady = false;
permissionPage.data.busy = true;
permissionPage.startVisionKit = function () { permissionResumeCount += 1; };
permissionPage.onHide();
assert.strictEqual(permissionStopCount, 1,
  "permission roundtrip must release the stale VisionKit start");
assert.strictEqual(permissionPage.data.guideTitle, "相机授权返回后继续");
assert.notStrictEqual(permissionPage.data.guideTitle, "扫拍已取消",
  "a camera permission sheet must not be reported as user cancellation");
assert.strictEqual(permissionPage.resumeCameraOnShow, true);
permissionPage.onShow();
assert.strictEqual(permissionResumeCount, 1,
  "returning from camera permission must restart VisionKit once");
assert.strictEqual(permissionPage.resumeCameraOnShow, false);

var stopCount = 0;
var session = Sweep.createSweepSession({
  targetSpanDeg: 120,
  minSpanDeg: 45,
  maxSpanDeg: 180
});
page.sweepSession = session;
page.visionKit = { stop: function () { stopCount += 1; } };
page.pendingFrame = Promise.resolve();
page.activeRgbaFrame = { buffer: new ArrayBuffer(16) };
page.data.scanning = true;
page.onHide();
assert.strictEqual(stopCount, 1, "backgrounding must stop VisionKit");
assert.strictEqual(page.pendingFrame, null, "backgrounding must clear pending capture");
assert.strictEqual(page.activeRgbaFrame, null, "backgrounding must release caller frame");
assert.strictEqual(page.sweepSession, null, "backgrounding must release sweep session");
assert.strictEqual(session.released, true);
assert.strictEqual(page.data.scanning, false);
assert.strictEqual(page.data.cameraOn, false);

var noRgbaPage = pageInstance();
noRgbaPage.onLoad({ degrees: "120" });
var noRgbaStopCount = 0;
noRgbaPage.visionKit = { stop: function () { noRgbaStopCount += 1; } };
noRgbaPage.onVisionFrame({
  basis: { F: [0, 1, 0], U: [0, 0, 1], R: [1, 0, 0], rollDeg: 0 },
  hasRgbaCapture: false,
  timestampNs: 1
}, noRgbaPage.lifecycleToken);
assert.strictEqual(noRgbaStopCount, 1);
assert.strictEqual(noRgbaPage.data.diagnosticText,
  "VK_RGBA_CAPTURE_UNAVAILABLE");
assert.strictEqual(noRgbaPage.data.cameraReady, false,
  "devices without CameraBuffer must never display a false ready state");

function syntheticFrame(width, height, yawDeg) {
  var rgba = new Uint8ClampedArray(width * height * 4);
  var shift = Math.round(yawDeg * 0.7);
  for (var y = 0; y < height; y += 1) {
    for (var x = 0; x < width; x += 1) {
      var index = (y * width + x) * 4;
      var worldX = x + shift;
      rgba[index] = (worldX * 7 + y * 3) & 255;
      rgba[index + 1] = (worldX * 3 + y * 11) & 255;
      rgba[index + 2] = ((worldX >> 2) * 29 + (y >> 2) * 17) & 255;
      rgba[index + 3] = 255;
    }
  }
  return rgba;
}

var simulated = Sweep.createSweepSession({
  targetSpanDeg: 120,
  minSpanDeg: 45,
  maxSpanDeg: 180,
  fovXDeg: 65,
  outputHeight: 160,
  maxOutputWidth: 1024
});
var maxRetained = 0;
var lastDecision = null;
for (var i = 0; i <= 120; i += 1) {
  lastDecision = Sweep.ingestFrame(simulated, {
    rgba: syntheticFrame(96, 128, i),
    width: 96,
    height: 128,
    timeMs: i * 80,
    yawDeg: i,
    pitchDeg: 0,
    rollDeg: 0,
    visualDx: i
      ? -Math.tan(Math.PI / 180) /
        (2 * Math.tan(65 * Math.PI / 360)) * 64
      : 0,
    visualDy: 0,
    confidence: 1
  });
  maxRetained = Math.max(maxRetained, lastDecision.retainedFrames || 0);
}
assert.ok(lastDecision && lastDecision.progressDeg >= 119,
  "last decision: " + JSON.stringify(lastDecision));
var result = Sweep.finalizeSweep(simulated);
assert.strictEqual(result.ok, true);
assert.strictEqual(result.internalBlackColumns, 0);
assert.ok(result.coverage >= 0.90);
assert.ok(maxRetained <= 2, "sweep must never retain more than two full frames");
assert.ok(result.width > result.height, "output must be a normal horizontal panorama");
result.pixels = null;
Sweep.releaseSweepSession(simulated);

delete global.Page;
delete global.getApp;
delete global.wx;
console.log("✅ 小程序横向扫拍独立路径、后台释放、120 帧 Node 模拟与 2D 零上传契约通过");
