#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.dirname(__dirname);
const source = fs.readFileSync(path.join(ROOT, "web/pano-capture.js"), "utf8");
const failures = [];

function ok(condition, label, detail) {
  console.log(`${condition ? "✅" : "❌"} ${label}${detail ? "  " + detail : ""}`);
  if (!condition) failures.push(label);
}

console.log("\n【1】整组照片只允许一个最终 FOV");
ok(/maxFovCorrectionDeg:\s*6\b/.test(source) &&
   !/maxFovCorrectionDeg:\s*18\b/.test(source),
  "单对视觉 FOV 搜索从 ±18° 收紧到 ±6°");
ok((source.match(/fovXDeg:\s*session\.sessionFovXDeg/g) || []).length >= 3,
  "渐进粗拼、撤销重建和最终拼接都读取 session-wide FOV");
ok(/session\.frames\[i\]\.correctedFovXDeg\s*=\s*selected/.test(source) &&
   /session\.alignmentFrames\[i\]\.correctedFovXDeg\s*=\s*selected/.test(source),
  "完成前把帧和视觉缩略帧统一到同一个 FOV");

const helperStart = source.indexOf("  function visualPoseWeight(");
const helperEnd = source.indexOf("  function prepareVisualFrame(", helperStart);
const helperSource = source.slice(helperStart, helperEnd);
const sandbox = {
  Math,
  Number,
  CAPTURE_FOV_DEG: 65,
  VISUAL_ALIGNMENT_OPTIONS: { minScore: 0.7 },
  SESSION_FOV_MIN_CONFIDENCE: 0.5,
  SESSION_FOV_MIN_SCORE: 0.78,
  SESSION_FOV_MIN_SAMPLES: 4,
  SESSION_FOV_MIN_DEG: 59,
  SESSION_FOV_MAX_DEG: 71,
  P: {
    clamp(value, min, max) {
      return Math.max(min, Math.min(max, value));
    }
  },
  session: {
    frames: [],
    alignmentFrames: [],
    sessionFovXDeg: 65,
    sessionFovSummary: null
  }
};
vm.runInNewContext(
  `${helperSource}\nthis.helpers = { visualPoseWeight, weightedMedian, finalizeSessionFov };`,
  sandbox
);

const normalFovs = [64.8, 65, 65.1, 65.2, 64.9, 71];
sandbox.session.frames = normalFovs.map((fov) => ({
  visualAlignment: {
    accepted: true,
    confidence: 0.82,
    score: 0.93,
    correctedFovXDeg: fov
  }
}));
sandbox.session.alignmentFrames = normalFovs.map(() => ({
  fovXDeg: 65,
  correctedFovXDeg: 65
}));
const fovSummary = sandbox.helpers.finalizeSessionFov();
ok(fovSummary.method === "confidence-weighted-median" &&
   fovSummary.inlierCount === 5 &&
   Math.abs(fovSummary.fovXDeg - 65) <= 0.2,
  "稳健中位数剔除单个边界离群 FOV",
  JSON.stringify(fovSummary));
ok(sandbox.session.frames.every((frame) =>
  frame.correctedFovXDeg === fovSummary.fovXDeg) &&
  sandbox.session.alignmentFrames.every((frame) =>
    frame.correctedFovXDeg === fovSummary.fovXDeg),
  "估计完成后没有残留逐帧缩放");

console.log("\n【2】视觉姿态保留 IMU 先验");
const lowWeight = sandbox.helpers.visualPoseWeight({
  confidence: 0.12,
  score: 0.72
});
const highWeight = sandbox.helpers.visualPoseWeight({
  confidence: 0.95,
  score: 0.96
});
ok(lowWeight < 0.2 && highWeight > lowWeight && highWeight <= 0.84,
  "低置信只作小修正，高置信也不会 100% 覆盖 IMU",
  `low=${lowWeight.toFixed(3)}, high=${highWeight.toFixed(3)}`);
ok(/P\.blendBasis\s*\?\s*P\.blendBasis\(basis,\s*alignment\.correctedBasis,\s*appliedPoseWeight\)/.test(source),
  "实际入帧姿态使用置信度阻尼后的视觉结果");

console.log("\n【3】局部边与闭环采用保守门限");
ok(/minEdgeConfidence:\s*SEQUENCE_MIN_CONFIDENCE/.test(source) &&
   /var SEQUENCE_MIN_CONFIDENCE\s*=\s*0\.52/.test(source),
  "序列优化只接收 ≥0.52 的视觉边");
ok(/loopStrength:\s*0\.25/.test(source) &&
   /LOOP_MAX_RESIDUAL_DEG\s*=\s*2\.5/.test(source),
  "闭环只分配 25% 残差并限制最大残差");
ok(/if \(optimized\.acceptedEdges\.length\)/.test(source) &&
   !/if \(optimized\.loops\.length\)/.test(source),
  "没有闭环时可靠局部边仍会应用");
ok(/function crossRingDefinitions\(frameCount\)/.test(source) &&
   /isCrossRing:\s*true/.test(source) &&
   /acceptedCrossRingEdges/.test(source) &&
   /visualExpectedCrossRingEdges/.test(source),
  "上圈和下圈通过真实视觉重叠连接到赤道圈，不再三圈各自漂移");

console.log(failures.length
  ? `\n❌ 不通过 ${failures.length} 条：\n  - ${failures.join("\n  - ")}`
  : "\n✅ Web 几何稳定回归全部通过");
process.exit(failures.length ? 1 : 0);
