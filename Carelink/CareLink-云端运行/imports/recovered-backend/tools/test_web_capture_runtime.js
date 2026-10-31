#!/usr/bin/env node
"use strict";

const path = require("path");
const fs = require("fs");
const ROOT = path.dirname(__dirname);
const P = require(path.join(ROOT, "miniapp/utils/pano-core.js"));
const R = require(path.join(ROOT, "web/pano-capture-runtime.js"));
const failures = [];

function ok(condition, label, detail) {
  console.log(`${condition ? "✅" : "❌"} ${label}${detail ? "  " + detail : ""}`);
  if (!condition) failures.push(label);
}

function near(value, expected, epsilon = 1e-5) {
  return Math.abs(value - expected) <= epsilon;
}

async function run() {
  console.log("\n【1】四元数插值不改变 +Y 前 / +Z 上坐标");
  const front = P.orthonormalBasis([0, 1, 0], [0, 0, 1]);
  const right = P.orthonormalBasis([1, 0, 0], [0, 0, 1]);
  const tilted = P.basisFromDeviceOrientation(137, 78, 19, 0);
  [front, right, tilted].forEach((basis, index) => {
    const roundTrip = R.basisFromQuaternion(R.quaternionFromBasis(basis));
    ok(P.angleDeg(roundTrip.F, basis.F) < 1e-5 &&
       P.angleDeg(roundTrip.U, basis.U) < 1e-5,
    `姿态 ${index + 1} basis → quaternion → basis 无漂移`);
  });
  const halfway = R.interpolateBasis(front, right, 0.5);
  ok(near(P.angleDeg(front.F, halfway.F), 45, 1e-4) &&
     near(P.angleDeg(halfway.F, right.F), 45, 1e-4),
  "90° 转向的中点是 45°，不会走欧拉角长路径");

  console.log("\n【2】tracking / display / capture 时间职责分离");
  const timeline = new R.PoseTimeline({ maxAgeMs: 3000, maxSamples: 120 });
  timeline.push(1000, front, "test");
  timeline.push(1500, right, "test");
  const mapped = timeline.at(1250, 400);
  ok(mapped && near(P.angleDeg(front.F, mapped.basis.F), 45, 1e-4),
    "捕获帧 1250ms 映射到传感器时间环的插值姿态");

  const slowFilter = new R.DisplayPoseFilter({ timeConstantMs: 50 });
  slowFilter.update(front, 1000);
  let highRateDisplay = null;
  for (let time = 1010; time <= 1100; time += 10) {
    highRateDisplay = slowFilter.update(right, time);
  }
  const sparseFilter = new R.DisplayPoseFilter({ timeConstantMs: 50 });
  sparseFilter.update(front, 1000);
  const sparseDisplay = sparseFilter.update(right, 1100);
  ok(R.quaternionAngleDeg(
    R.quaternionFromBasis(highRateDisplay),
    R.quaternionFromBasis(sparseDisplay)
  ) < 1e-4,
  "显示平滑由 dt 决定，不随传感器回调频率改变");

  console.log("\n【3】稳定门读取未滞后的原始姿态");
  const stableTimeline = new R.PoseTimeline({ maxAgeMs: 3000 });
  for (let time = 0; time <= 500; time += 50) {
    stableTimeline.push(time, front, "stable");
  }
  const stableStats = stableTimeline.motionStats(500, 520);
  ok(stableStats.ready && stableStats.durationMs >= 400 &&
     stableStats.instantaneousDegS <= 3 &&
     stableStats.maxDegS <= 6 &&
     stableStats.robustDegS <= 6 &&
     stableStats.dispersionDeg <= 1,
  "静止 400ms 以上满足保守 raw gate");

  const movingTimeline = new R.PoseTimeline({ maxAgeMs: 3000 });
  for (let step = 0; step <= 10; step += 1) {
    const direction = P.directionFromYawPitch(step * 0.6, 0);
    movingTimeline.push(step * 50, P.orthonormalBasis(direction, [0, 0, 1]), "moving");
  }
  const movingStats = movingTimeline.motionStats(500, 520);
  ok(movingStats.maxDegS > 6 && movingStats.dispersionDeg > 1,
    "仍在转动时 raw gate 会拒绝，不会被显示平滑伪装成静止",
    JSON.stringify({
      maxDegS: Math.round(movingStats.maxDegS * 10) / 10,
      dispersionDeg: Math.round(movingStats.dispersionDeg * 10) / 10
    }));

  const noisyTimeline = new R.PoseTimeline({ maxAgeMs: 3000 });
  for (let step = 0; step <= 18; step += 1) {
    let yawNoise = Math.sin(step * 1.71) * 0.055;
    const pitchNoise = Math.cos(step * 1.17) * 0.04;
    if (step === 8) yawNoise += 0.22;
    noisyTimeline.push(
      step * 20,
      P.rotateBasisLocal(front, yawNoise, pitchNoise, 0),
      "quantized-jitter"
    );
  }
  const noisyStats = noisyTimeline.motionStats(360, 360);
  ok(noisyStats.maxDegS > noisyStats.robustDegS &&
     noisyStats.robustDegS <= 12 &&
     noisyStats.dispersionDeg <= 1.6,
  "量化抖动与单个速度尖峰使用 robust speed，不再永久封锁快门",
  JSON.stringify({
    maxDegS: Math.round(noisyStats.maxDegS * 10) / 10,
    robustDegS: Math.round(noisyStats.robustDegS * 10) / 10,
    dispersionDeg: Math.round(noisyStats.dispersionDeg * 100) / 100
  }));

  const android5HzTimeline = new R.PoseTimeline({ maxAgeMs: 3000 });
  android5HzTimeline.push(0, front, "android-5hz");
  android5HzTimeline.push(
    200,
    P.rotateBasisLocal(front, 0.05, 0, 0),
    "android-5hz"
  );
  android5HzTimeline.push(400, front, "android-5hz");
  const android5HzStats = android5HzTimeline.motionStats(400, 520);
  ok(android5HzStats.ready &&
     android5HzStats.durationMs === 400 &&
     android5HzStats.robustDegS <= 18 &&
     android5HzStats.dispersionDeg <= 1.8,
  "Android 5Hz 的三次静止样本可形成完整稳定窗口");

  console.log("\n【4】requestVideoFrameCallback 时间元数据优先级");
  let frameCallback = null;
  let cancelled = 0;
  const fakeVideo = {
    videoWidth: 960,
    videoHeight: 1280,
    requestVideoFrameCallback(callback) {
      frameCallback = callback;
      return 17;
    },
    cancelVideoFrameCallback(id) {
      if (id === 17) cancelled += 1;
    }
  };
  const clock = new R.VideoFrameClock(fakeVideo);
  clock.start();
  const waiting = clock.waitForNext(0, 200);
  frameCallback(2000, {
    captureTime: 1982,
    presentationTime: 1998,
    mediaTime: 2.5,
    presentedFrames: 9,
    width: 960,
    height: 1280
  });
  const frame = await waiting;
  ok(frame.sequence === 1 && frame.poseTimeMs === 1982 &&
     frame.timeSource === "captureTime",
  "同一帧优先使用 captureTime，缺失时才退到 presentationTime");
  clock.stop();
  ok(cancelled === 1, "停止相机时取消逐帧回调，不留下后台循环");

  const presentationOnly = R.framePoseTime(3000, { presentationTime: 2997 });
  const fallback = R.framePoseTime(4000, { captureTime: 1700000000000 });
  ok(presentationOnly.timeMs === 2997 &&
     presentationOnly.source === "presentationTime" &&
     fallback.timeMs === 4000 &&
     fallback.source === "callbackNow",
  "异常时钟值被拒绝并回退到单调本地时间");

  console.log("\n【5】网页集成与发布清单");
  const webSource = fs.readFileSync(path.join(ROOT, "web/pano-capture.js"), "utf8");
  const htmlSource = fs.readFileSync(path.join(ROOT, "web/pano-capture.html"), "utf8");
  const publicFiles = fs.readFileSync(path.join(ROOT, "deploy/public-files.txt"), "utf8")
    .split(/\r?\n/);
  ok(!/session\.(basis|filteredBasis|lastForward|lastMotionAt)\b/.test(webSource) &&
     !/P\.smoothBasis\(/.test(webSource),
  "网页不再让旧的平滑 basis 同时承担追踪与快门职责");
  ok(/waitForNext\(previousFrameSequence,\s*220\)/.test(webSource) &&
     /FRAME_POSE_MATCH_TOLERANCE_MS/.test(webSource) &&
     /poseTimeline\.at\([\s\S]{0,100}FRAME_POSE_MATCH_TOLERANCE_MS/.test(webSource) &&
     /basis = P\.copyBasis\(mappedPose\.basis\)/.test(webSource),
  "captureCurrent 等待呈现帧并使用帧时间映射出的 captureBasis");
  ok(/function quietHoldFramePose\(/.test(webSource) &&
     /entry-quiet-hold/.test(webSource) &&
     /QUIET_HOLD_FRAME_POSE_MAX_AGE_MS/.test(webSource) &&
     /QUIET_HOLD_ENTRY_TO_DRAW_MAX_MS/.test(webSource) &&
     /QUIET_HOLD_FRAME_BASIS_DRIFT_DEG/.test(webSource),
  "Android 静止停更时，帧姿态映射有有界 quiet-hold 兜底并校验入门后漂移");
  ok(/!session\.captureSessionStarted/.test(webSource) &&
     /captureCurrent\("manual"\)/.test(webSource) &&
     /captureCurrent\("auto"\)/.test(webSource),
  "第一张只允许显式手动确认，后续自动路径独立");
  ok(/function autoCaptureEligible\(\)/.test(webSource) &&
     !/var autoEligible\s*=\s*[\s\S]{0,160}videoFrameCallback/.test(webSource) &&
     /manualCaptureAllowed\(entryGate\)/.test(webSource),
  "Tier B 后续允许自动拍摄，首张手动确认不再复用完整稳态门");
  ok(/PHOTO_ENCODE_TIMEOUT/.test(webSource) &&
     /effectiveScreenAngle\(reported,\s*portrait\)/.test(webSource),
  "照片编码有 watchdog，竖屏 WebView 的矛盾 90° 方向值会归一化");
  ok(/var requestedTestScene\s*=\s*testMode\s*\?/.test(webSource) &&
     /requestedTestScene === "handheld"/.test(webSource) &&
     /HANDHELD_TEST_SEED\s*=\s*0x[0-9a-f]+/i.test(webSource) &&
     /function handheldFiniteSceneDirection\(/.test(webSource) &&
     /rollingYawDeg[\s\S]{0,240}rollingPitchDeg/.test(webSource),
  "手持畸变夹具只在隐藏 test scene 中启用，并固定 seed 注入 EIS/rolling shutter/平移");
  ok(/localWarpAttempted:\s*localWarpSummary\.localWarpAttempted/.test(webSource) &&
     /localWarpApplied:\s*localWarpSummary\.localWarpApplied/.test(webSource) &&
     /localWarpFallbacks:\s*localWarpSummary\.localWarpFallbacks/.test(webSource) &&
     /localWarpLastAppliedDiagnostics/.test(webSource) &&
     /localWarp:\s*handheldTestMode/.test(webSource) &&
     !/localWarp:\s*true/.test(webSource) &&
     /localWarpSummary\.localWarpApplied === 0 \|\|/.test(webSource) &&
     /flowMeanMagnitudeLimit/.test(webSource) &&
     /localWarpHealthy/.test(webSource),
  "普通 H5 禁用二帧局部网格；隐藏手持夹具若启用则硬断言完整安全诊断");
  ok(/var robustVisualTestMode = handheldTestMode \|\| dynamicTestMode/.test(webSource) &&
     /var visualEdgesHealthy = !!visualSummary && \(robustVisualTestMode/.test(webSource) &&
     /residualAfterMeanDeg <[\s\S]{0,100}residualBeforeMeanDeg/.test(webSource) &&
     /Math\.floor\(visualExpectedEdges \* 0\.7\)/.test(webSource),
  "隐藏手持/动态夹具允许稳健拒绝少数坏边，但必须让全局残差下降");
  ok(htmlSource.indexOf("pano-capture-runtime.js") <
     htmlSource.indexOf("pano-capture.js") &&
     /pano-capture\.js\?v=20260801-\d+/.test(htmlSource) &&
     publicFiles.includes("web/pano-capture-runtime.js"),
  "运行时脚本先于页面逻辑加载，并进入公开发布清单");

  console.log(failures.length
    ? `\n❌ 不通过 ${failures.length} 条：\n  - ${failures.join("\n  - ")}`
    : "\n✅ Web 捕获时间与姿态运行时全部通过");
  process.exitCode = failures.length ? 1 : 0;
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
