#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = path.dirname(__dirname);
const P = require(path.join(ROOT, "miniapp/utils/pano-core.js"));
const failures = [];

function ok(condition, label, detail) {
  console.log(`${condition ? "✅" : "❌"} ${label}${detail ? "  " + detail : ""}`);
  if (!condition) failures.push(label);
}

function near(a, b, epsilon = 1e-5) {
  return Math.abs(a - b) <= epsilon;
}

console.log("\n【1】两端统一的 +Y 前 / +Z 上坐标");
const portrait = P.basisFromDeviceOrientation(0, 90, 0, 0);
ok(near(portrait.F[0], 0) && near(portrait.F[1], 1) && near(portrait.F[2], 0),
  "竖直前摄姿态的后摄光轴 = +Y", JSON.stringify(portrait.F));
ok(near(portrait.U[2], 1) && near(portrait.R[0], 1),
  "画面上方 = +Z，画面右方 = +X");
const west = P.basisFromDeviceOrientation(90, 90, 0, 0);
ok(P.angleDeg(west.F, [-1, 0, 0]) < 1e-5,
  "W3C 黄金姿态 alpha=90° 时后摄朝向 = -X");
const wxPortrait = P.basisFromDeviceMotionRadians(0, Math.PI / 2, 0, 0);
ok(P.angleDeg(wxPortrait.F, portrait.F) < 1e-5 &&
   P.angleDeg(wxPortrait.U, portrait.U) < 1e-5,
  "微信弧度姿态适配后与网页 90° 姿态完全一致");
const landscapeCrop = P.centerCropRect(640, 480, 3 / 4);
const tallCrop = P.centerCropRect(1080, 1920, 3 / 4);
ok(near(landscapeCrop.x, 140) && near(landscapeCrop.width, 360) &&
   near(landscapeCrop.height, 480) && near(tallCrop.y, 240) &&
   near(tallCrop.width / tallCrop.height, 3 / 4),
  "横向或超长传感器帧都中心裁成与取景窗一致的 3:4");

const tilted = P.basisFromDeviceOrientation(137, 78, 19, 0);
ok(Math.abs(P.dot(tilted.F, tilted.U)) < 1e-5 &&
   Math.abs(P.dot(tilted.F, tilted.R)) < 1e-5 &&
   Math.abs(P.dot(tilted.U, tilted.R)) < 1e-5,
  "alpha/beta/gamma 组合姿态仍输出正交 F/U/R");
const rebased = P.rebaseHeading(tilted);
ok(Math.abs(P.yawPitchFromDirection(rebased.F).yawDeg) < 1e-4 ||
   Math.abs(P.yawPitchFromDirection(rebased.F).yawDeg - 360) < 1e-4,
  "启动时只归零 heading");
ok(near(rebased.F[2], tilted.F[2], 1e-5),
  "归零 heading 不伪造 pitch");

console.log("\n【2】Capture 与 Stitch 消费同一份相机基");
const target = P.directionFromYawPitch(90, 0);
const basis = P.orthonormalBasis(target, [0, 0, 1]);
const projected = P.projectDirection(target, basis, 65, 4 / 3);
ok(projected.visible && Math.abs(projected.nx) < 1e-6 && Math.abs(projected.ny) < 1e-6,
  "目标方向在拍摄基中投到取景中心");
const behind = P.projectDirection([0, -1, 0], P.orthonormalBasis([0, 1, 0], [0, 0, 1]), 65, 3 / 4);
ok(!behind.visible && behind.behind &&
   near(Math.max(Math.abs(behind.guideNx), Math.abs(behind.guideNy)), 1),
  "背后目标仍返回唯一的屏幕边缘引导方向");

const sourceW = 64;
const sourceH = 48;
const pixels = new Uint8ClampedArray(sourceW * sourceH * 4);
for (let i = 0; i < sourceW * sourceH; i += 1) {
  pixels[i * 4] = 230;
  pixels[i * 4 + 1] = 70;
  pixels[i * 4 + 2] = 40;
  pixels[i * 4 + 3] = 255;
}
const coarse = P.createRaster(256, 128);
const finalRaster = P.createRaster(512, 256);
P.projectPatch(coarse, pixels, sourceW, sourceH, basis, { fovXDeg: 65 });
P.projectPatch(finalRaster, pixels, sourceW, sourceH, basis, { fovXDeg: 65 });
const coarseStats = P.rasterStats(coarse);
const finalStats = P.rasterStats(finalRaster);
ok(coarseStats.nonBlackPixels > 0 && finalStats.nonBlackPixels > 0,
  "渐进粗球与最终 2D 都得到非黑真实像素");
const coarseCenter = (64 * coarse.width + 64) * 4; // yaw=90° => x=1/4 width, pitch=0 => y=1/2 height
const finalCenter = (128 * finalRaster.width + 128) * 4;
ok(coarse.pixels[coarseCenter] > 200 && finalRaster.pixels[finalCenter] > 200,
  "同一帧在粗球与最终结果落到同一经纬位置");

console.log("\n【3】目标序列与低内存契约");
const targets = P.createTargets();
ok(targets.length === 28, "目标共 28 个");
ok(targets.slice(0, 12).every((t) => t.pitchDeg === 0) &&
   targets.slice(12, 20).every((t) => t.pitchDeg === 50) &&
   targets.slice(20).every((t) => t.pitchDeg === -50),
  "顺序为水平 12 → 上圈 8 → 下圈 8");
const portraitW = 48;
const portraitH = 64;
const portraitPixels = new Uint8ClampedArray(portraitW * portraitH * 4).fill(255);
const portraitCoverage = P.createRaster(360, 180);
targets.forEach((item) => {
  P.projectPatch(
    portraitCoverage,
    portraitPixels,
    portraitW,
    portraitH,
    P.orthonormalBasis(item.dir, [0, 0, 1]),
    { fovXDeg: 65, feather: 0.2 }
  );
});
ok(P.rasterStats(portraitCoverage).coverage >= 0.99,
  "3:4 竖屏照片完成 28 个目标后覆盖完整球面",
  `${Math.round(P.rasterStats(portraitCoverage).coverage * 1000) / 10}%`);

const webSource = fs.readFileSync(path.join(ROOT, "web/pano-capture.js"), "utf8");
const miniSource = fs.readFileSync(path.join(ROOT, "miniapp/pages/capture/capture.js"), "utf8");
const miniWxml = fs.readFileSync(path.join(ROOT, "miniapp/pages/capture/capture.wxml"), "utf8");
const miniWxss = fs.readFileSync(path.join(ROOT, "miniapp/pages/capture/capture.wxss"), "utf8");
const miniIndexSource = fs.readFileSync(path.join(ROOT, "miniapp/pages/index/index.js"), "utf8");
const miniIndexWxml = fs.readFileSync(path.join(ROOT, "miniapp/pages/index/index.wxml"), "utf8");
ok(/basisFromDeviceMotionRadians\(event\.alpha,\s*event\.beta,\s*event\.gamma/.test(miniSource),
  "小程序适配层不会把弧度误当成度数");
ok(/bitmap\.close\(\)/.test(webSource), "网页逐张解码后立即 close ImageBitmap");
ok(!/frames\.push\(\s*\{[^}]*pixels/s.test(webSource) &&
   !/frames\.push\(\s*\{[^}]*pixels/s.test(miniSource),
  "两端 frame 清单不常驻 RGBA 像素数组");
ok(!/\bfetch\s*\(|XMLHttpRequest|wx\.uploadFile/.test(webSource),
  "隐藏网页模拟器所在页面没有上传调用");
ok(miniSource.indexOf("var shutterBasis = P.copyBasis(this.basis)") <
   miniSource.indexOf("var path = await this.takePhoto()"),
  "小程序在调用快门前冻结姿态");

let captureDefinition = null;
const motionListeners = [];
const wxMotionMock = {
  startDeviceMotionListening(options) { options.success(); },
  stopDeviceMotionListening() {},
  onDeviceMotionChange(handler) { motionListeners.push(handler); },
  offDeviceMotionChange(handler) {
    const index = motionListeners.indexOf(handler);
    if (index >= 0) motionListeners.splice(index, 1);
  }
};
vm.runInNewContext(miniSource, {
  require: () => P,
  Page: (definition) => { captureDefinition = definition; },
  wx: wxMotionMock,
  getApp: () => ({ globalData: { nav: {}, statusBarHeight: 20 } }),
  console,
  setTimeout,
  clearTimeout,
  Promise,
  Date,
  Math,
  Uint8ClampedArray,
  Float32Array
});
const motionPage = Object.assign({}, captureDefinition, {
  data: Object.assign({}, captureDefinition.data),
  pageAlive: true,
  pageVisible: true,
  lifecycleToken: 1,
  motionStarting: false,
  motionActive: false,
  motionGeneration: 0,
  motionHandler: null,
  setData(patch) { Object.assign(this.data, patch); }
});
motionPage.startMotion();
motionPage.startMotion();
ok(motionListeners.length === 1, "小程序重复启动只注册一个方向监听");
motionPage.stopMotion();
ok(motionListeners.length === 0, "停止方向监听后没有残留 handler");

let autoCaptures = 0;
const helpGatePage = Object.assign({}, captureDefinition, {
  data: Object.assign({}, captureDefinition.data, {
    phase: "capture",
    cameraReady: true,
    orientationReady: true,
    busy: false,
    helpVisible: true
  }),
  targets: [{ dir: [0, 1, 0] }],
  targetIndex: 0,
  basis: P.orthonormalBasis([0, 1, 0], [0, 0, 1]),
  angularSpeed: 0,
  stableSince: Date.now() - 1000,
  worldCssWidth: 375,
  worldCssHeight: 667,
  motionActive: true,
  pageVisible: true,
  capturing: false,
  lastTargetUiAt: 0,
  captureCurrent() { autoCaptures += 1; },
  setData(patch) { Object.assign(this.data, patch); }
});
helpGatePage.updateTarget();
ok(autoCaptures === 0, "帮助弹层打开时不会在背后自动拍摄");

const explicitStartPage = Object.assign({}, helpGatePage, {
  data: Object.assign({}, helpGatePage.data, {
    helpVisible: false,
    captureSessionStarted: false
  }),
  stableSince: Date.now() - 1000,
  captureCurrent() { autoCaptures += 1; }
});
explicitStartPage.updateTarget();
ok(autoCaptures === 0, "第一张必须由用户点“开始拍摄”，不会进页自动触发");
ok(/TAKE_PHOTO_TIMEOUT/.test(miniSource) &&
   /IMAGE_DECODE_TIMEOUT/.test(miniSource) &&
   /attemptId !== this\.captureAttemptId/.test(miniSource),
  "快门与真机图片解码都有 watchdog，迟到回调受 attempt 隔离");

const panoSource = fs.readFileSync(path.join(ROOT, "miniapp/pages/pano/pano.js"), "utf8");
ok(/res\.alpha\s*\*\s*RAD_TO_DEG/.test(panoSource) &&
   /res\.beta\s*\*\s*RAD_TO_DEG/.test(panoSource),
  "小程序全景浏览同样把微信弧度转换为度数");
ok(/deleteTexture/.test(webSource) && /deleteTexture/.test(miniSource),
  "两端关闭 360° 查看时都会释放 WebGL 资源");

console.log("\n【4】2D 默认与 WebGL 回退结构");
const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, "miniapp/app.json"), "utf8"));
const portal = fs.readFileSync(path.join(ROOT, "portal.html"), "utf8");
const publicFiles = fs.readFileSync(path.join(ROOT, "deploy/public-files.txt"), "utf8");
ok(/wx\.createOffscreenCanvas\(\{\s*type:\s*"2d"/.test(miniSource),
  "小程序默认用真正离屏 Canvas 解码照片");
ok(miniWxml.includes("phase === 'capture' && worldCanvasMounted") &&
   miniWxml.includes('wx:if="{{resultCanvasMounted}}"') &&
   miniWxml.includes('wx:if="{{viewerCanvasMounted}}"'),
  "三个原生 Canvas 都按阶段懒挂载");
ok(miniWxml.includes('wx:if="{{resultImagePath}}"') &&
   miniWxml.includes('src="{{resultImagePath}}"'),
  "导出后常驻结果是普通 image，不依赖原生 Canvas");
ok(!miniSource.includes("画布渲染失败，请重进页面") &&
   !/position:\s*fixed[^}]*left:\s*-3000px/.test(miniWxss),
  "不再把隐藏画布同层失败误报成整页致命错误");
ok(miniWxml.includes('bindwebglcontextlost="onWebGLContextLost"') &&
   /fallbackTo2D/.test(miniSource),
  "小程序 WebGL context lost 自动回 2D");
ok(appJson.pages.includes("pages/capture/capture"), "小程序注册拍摄页");
ok(/class="primary-cta"\s+href="pano-capture\/"/.test(portal) &&
   !/href="(?:web\/)?pano-sweep(?:\.html|\/)"/.test(portal),
  "网页主页主入口固定进入球面 Demo，横向实验不在正常首页暴露");
ok(/url:\s*"\/pages\/capture\/capture"/.test(miniIndexSource) &&
   !/url:\s*"\/pages\/sweep\/sweep/.test(miniIndexSource) &&
   miniIndexWxml.includes("拍摄 720° 球面全景 Demo"),
  "小程序主页主入口固定进入球面 Demo");
ok(/getCurrentPages\(\)\.length > 1/.test(miniSource) &&
   /wx\.reLaunch\(\{\s*url:\s*"\/pages\/index\/index"/.test(miniSource),
  "球面页从普通入口或二维码直达都能返回首页");
ok(/\/pano-capture/.test(portal),
  "球面拍摄干净路径已保留");
ok(!/href="[^"]*__pano_test/.test(portal), "正常入口不暴露隐藏模拟器参数");
ok(["miniapp/utils/pano-core.js", "pano-capture/index.html", "web/pano-capture.css",
    "web/pano-capture.html", "web/pano-capture.js"].every((file) => publicFiles.split("\n").includes(file)),
  "拍摄页与共享内核全部进入公开站精确清单");

console.log(failures.length
  ? `\n❌ 不通过 ${failures.length} 条：\n  - ${failures.join("\n  - ")}`
  : "\n✅ 全景拍摄契约全部通过");
process.exit(failures.length ? 1 : 0);
