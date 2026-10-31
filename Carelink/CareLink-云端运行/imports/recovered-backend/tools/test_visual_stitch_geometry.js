#!/usr/bin/env node
"use strict";

const path = require("path");
const ROOT = path.dirname(__dirname);
const P = require(path.join(ROOT, "miniapp/utils/pano-core.js"));
const S = require("./pano_synthetic.js");

const failures = [];

function ok(condition, label, detail) {
  console.log(`${condition ? "✅" : "❌"} ${label}${detail ? "  " + detail : ""}`);
  if (!condition) failures.push(label);
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function cloneFrame(frame, overrides = {}) {
  return Object.assign({
    width: frame.width,
    height: frame.height,
    pixels: new Uint8ClampedArray(frame.pixels),
    basis: P.copyBasis(frame.basis),
    fovXDeg: frame.fovXDeg
  }, overrides);
}

function nearestReference(accepted, frame) {
  let best = accepted[0];
  let bestAngle = Infinity;
  for (const candidate of accepted) {
    const angle = P.angleDeg(candidate.correctedBasis.F, frame.basis.F);
    if (angle < bestAngle) {
      best = candidate;
      bestAngle = angle;
    }
  }
  return best;
}

console.log("\n【1】从同一张 2:1 真值全景生成 28 张透视照片");
const panoWidth = 480;
const panoHeight = 240;
const frameWidth = 84;
const frameHeight = 112;
const truth = S.createTruthPanorama(panoWidth, panoHeight);
const targets = P.createTargets();
const cleanFrames = [];
const capturedFrames = [];
const injectedPoseErrors = [];
const injectedFovErrors = [];

for (let index = 0; index < targets.length; index += 1) {
  const trueBasis = P.orthonormalBasis(targets[index].dir, [0, 0, 1]);
  const trueFov = index === 0 ? 65 :
    65 + 2.8 * Math.sin(index * 1.71) + 0.7 * Math.cos(index * 0.37);
  const clean = S.renderPerspective(
    P,
    truth,
    frameWidth,
    frameHeight,
    trueBasis,
    trueFov
  );
  clean.trueBasis = trueBasis;
  clean.trueFovXDeg = trueFov;
  cleanFrames.push(clean);

  const yawError = index === 0 ? 0 :
    2.7 * Math.sin(index * 1.13) + 0.45 * Math.cos(index * 0.31);
  const pitchError = index === 0 ? 0 :
    2.2 * Math.cos(index * 0.91) - 0.35 * Math.sin(index * 0.43);
  const rollError = index === 0 ? 0 :
    1.6 * Math.sin(index * 0.67);
  const imuBasis = P.rotateBasisLocal(trueBasis, yawError, pitchError, rollError);
  const exposureGain = index === 0 ? 1 : 0.82 + 0.34 * ((Math.sin(index * 0.73) + 1) / 2);
  const exposureBias = index === 0 ? 0 : 9 * Math.cos(index * 0.47);
  const blurRadius = index > 0 && index % 7 === 0 ? 1 : 0;
  const captured = S.perturbPixels(clean, {
    gain: exposureGain,
    bias: exposureBias,
    noise: 1.5,
    blurRadius,
    seed: 1000 + index
  });
  captured.basis = imuBasis;
  captured.fovXDeg = 65;
  captured.trueBasis = trueBasis;
  captured.trueFovXDeg = trueFov;
  captured.exposureGain = exposureGain;
  captured.exposureBias = exposureBias;
  captured.blurRadius = blurRadius;
  capturedFrames.push(captured);
  injectedPoseErrors.push(P.basisRotationErrorDeg(imuBasis, trueBasis));
  injectedFovErrors.push(Math.abs(65 - trueFov));
}

ok(cleanFrames.length === 28, "生成 28 张来自同一真值球面的 3:4 透视帧");
ok(Math.max(...injectedPoseErrors) > 3 && mean(injectedPoseErrors) > 2,
  "注入可测的 IMU 姿态误差",
  `mean=${round(mean(injectedPoseErrors))}°, max=${round(Math.max(...injectedPoseErrors))}°`);
ok(Math.max(...injectedFovErrors) > 3 && capturedFrames.some((frame) => frame.blurRadius === 1) &&
   capturedFrames.some((frame) => Math.abs(frame.exposureGain - 1) > 0.12),
  "同时注入 FOV、曝光、轻微模糊扰动",
  `FOV mean=${round(mean(injectedFovErrors))}°`);

const cleanForStitch = cleanFrames.map((frame) => cloneFrame(frame, {
  correctedBasis: P.copyBasis(frame.trueBasis),
  correctedFovXDeg: frame.trueFovXDeg
}));
const cleanStitch = P.stitchFrames2D(cleanForStitch, panoWidth, panoHeight, {
  feather: 0.2,
  releaseAfterProject: false
});
const cleanMetrics = S.maskedMetrics(cleanStitch.raster, truth, cleanStitch.raster.weights);
ok(cleanStitch.stats.coverage >= 0.995,
  "28 张真值帧在球面上形成完整覆盖",
  `${round(cleanStitch.stats.coverage * 100, 2)}%`);
ok(cleanMetrics.ssim > 0.72 && cleanMetrics.mae < 28,
  "无扰动基线不仅非黑，而且能重建真值结构",
  `SSIM=${round(cleanMetrics.ssim)}, MAE=${round(cleanMetrics.mae)}`);

console.log("\n【2】IMU 只作初值：相邻重叠帧做多尺度光度纠偏");
const correctedFrames = [];
const alignments = [];
for (let index = 0; index < capturedFrames.length; index += 1) {
  const frame = capturedFrames[index];
  if (index === 0) {
    frame.correctedBasis = P.copyBasis(frame.trueBasis);
    frame.correctedFovXDeg = frame.trueFovXDeg;
    frame.gain = 1;
    frame.bias = 0;
    frame.accepted = true;
    correctedFrames.push(frame);
    continue;
  }
  const alignment = P.refineFramePoseFromReferences(correctedFrames, frame, {
    maxCorrectionDeg: 6,
    maxRollDeg: 4,
    maxFovCorrectionDeg: 6,
    minOverlapRatio: 0.08,
    minScore: 0.67,
    targetSamples: 720,
    maxReferences: 6,
    maxReferenceAngleDeg: 76,
    imuPriorWeight: 0.035
  });
  const reference = correctedFrames[alignment.referenceIndex] ||
    nearestReference(correctedFrames, frame);
  alignment.frameIndex = index;
  alignments.push(alignment);
  frame.correctedBasis = alignment.correctedBasis;
  frame.correctedFovXDeg = alignment.correctedFovXDeg;
  frame.gain = Math.max(0.45, Math.min(2.2, alignment.gain * reference.gain));
  frame.bias = alignment.bias * reference.gain + reference.bias;
  frame.accepted = alignment.accepted;
  frame.alignment = alignment;
  if (alignment.accepted) correctedFrames.push(frame);
}

const acceptedAlignments = alignments.filter((alignment) => alignment.accepted);
const rejectedAlignmentSummary = alignments
  .filter((alignment) => !alignment.accepted)
  .map((alignment) => ({
    index: alignment.frameIndex,
    reason: alignment.rejectReason,
    score: round(alignment.score),
    overlap: round(alignment.overlapRatio),
    correction: alignment.correction
  }));
const initialPoseMean = mean(capturedFrames.map((frame) =>
  P.basisRotationErrorDeg(frame.basis, frame.trueBasis)));
const correctedPoseMean = mean(correctedFrames.map((frame) =>
  P.basisRotationErrorDeg(frame.correctedBasis, frame.trueBasis)));
const initialFovMean = mean(capturedFrames.map((frame) =>
  Math.abs(frame.fovXDeg - frame.trueFovXDeg)));
const correctedFovMean = mean(correctedFrames.map((frame) =>
  Math.abs(frame.correctedFovXDeg - frame.trueFovXDeg)));
const meanScore = mean(acceptedAlignments.map((alignment) => alignment.score));

ok(correctedFrames.length >= 27 &&
   rejectedAlignmentSummary.every((item) => item.reason === "CORRECTION_LIMIT"),
  "可靠帧被接收，传播后超出小旋转边界的帧明确要求重拍",
  `${correctedFrames.length}/28` +
  (rejectedAlignmentSummary.length ? ` rejected=${JSON.stringify(rejectedAlignmentSummary)}` : ""));
ok(correctedPoseMean < 1.5 && correctedPoseMean < initialPoseMean * 0.58,
  "视觉纠偏显著降低姿态误差",
  `${round(initialPoseMean)}° → ${round(correctedPoseMean)}°`);
ok(correctedFovMean < 1.35 && correctedFovMean < initialFovMean * 0.72,
  "视觉重叠同时校正固定 FOV 假设",
  `${round(initialFovMean)}° → ${round(correctedFovMean)}°`);
ok(meanScore > 0.78,
  "曝光变化和轻微模糊下仍保持高重叠相关度",
  `mean ZNCC=${round(meanScore)}`);

console.log("\n【3】坏帧必须拒绝，不能靠 feather 假装成功");
const badPixels = S.randomNoiseFrame(frameWidth, frameHeight, 7781);
const badProbe = {
  width: frameWidth,
  height: frameHeight,
  pixels: badPixels.pixels,
  basis: P.copyBasis(capturedFrames[8].basis),
  fovXDeg: 65
};
const badReference = nearestReference(correctedFrames.slice(0, 8), badProbe);
const badAlignment = P.refineFramePose(badReference, badProbe, {
  maxCorrectionDeg: 6,
  maxRollDeg: 4,
  maxFovCorrectionDeg: 6,
  minOverlapRatio: 0.08,
  minScore: 0.67,
  targetSamples: 720
});
ok(!badAlignment.accepted &&
   ["LOW_ALIGNMENT_CONFIDENCE", "CORRECTION_LIMIT"].includes(badAlignment.rejectReason),
  "高纹理随机坏帧被几何置信度拒绝",
  `reason=${badAlignment.rejectReason}, ZNCC=${round(badAlignment.score)}`);
const flat = {
  width: frameWidth,
  height: frameHeight,
  pixels: new Uint8ClampedArray(frameWidth * frameHeight * 4).fill(127),
  basis: P.copyBasis(capturedFrames[8].basis),
  fovXDeg: 65
};
for (let i = 3; i < flat.pixels.length; i += 4) flat.pixels[i] = 255;
const flatAlignment = P.refineFramePose(badReference, flat, {
  minScore: 0.67,
  targetSamples: 720
});
ok(!flatAlignment.accepted && flatAlignment.rejectReason === "LOW_TEXTURE",
  "纯色/严重失焦帧在搜索前就被质量门拒绝",
  `reason=${flatAlignment.rejectReason}`);

console.log("\n【4】纠偏后全景误差、360°闭环和内存释放");
const rawFrames = capturedFrames.map((frame) => cloneFrame(frame, {
  basis: P.copyBasis(frame.basis),
  fovXDeg: 65,
  gain: 1,
  bias: 0,
  accepted: true
}));
const correctedForStitch = correctedFrames.map((frame) => cloneFrame(frame, {
  correctedBasis: P.copyBasis(frame.correctedBasis),
  correctedFovXDeg: frame.correctedFovXDeg,
  gain: frame.gain,
  bias: frame.bias,
  accepted: true
}));
const rawStitch = P.stitchFrames2D(rawFrames, panoWidth, panoHeight, {
  feather: 0.2,
  releaseAfterProject: false
});
const correctedStitch = P.stitchFrames2D(correctedForStitch, panoWidth, panoHeight, {
  feather: 0.2,
  releaseAfterProject: false
});
const rawMetrics = S.maskedMetrics(rawStitch.raster, truth, rawStitch.raster.weights);
const correctedMetrics = S.maskedMetrics(
  correctedStitch.raster,
  truth,
  correctedStitch.raster.weights
);
const rawSeam = S.seamError(rawStitch.raster, truth);
const correctedSeam = S.seamError(correctedStitch.raster, truth);
const equatorClosureError = P.basisRotationErrorDeg(
  capturedFrames[11].correctedBasis,
  capturedFrames[11].trueBasis
);

ok(correctedMetrics.ssim > rawMetrics.ssim + 0.08 &&
   correctedMetrics.mae < rawMetrics.mae * 0.78,
  "真实几何指标证明纠偏优于只按 IMU 羽化",
  `SSIM ${round(rawMetrics.ssim)} → ${round(correctedMetrics.ssim)}, ` +
  `MAE ${round(rawMetrics.mae)} → ${round(correctedMetrics.mae)}`);
ok(equatorClosureError < 1.25 &&
   Math.abs(correctedSeam.excess) < Math.abs(rawSeam.excess),
  "水平首尾重叠区的局部闭合误差受控",
  `pose=${round(equatorClosureError)}°, seam excess ` +
  `${round(rawSeam.excess)} → ${round(correctedSeam.excess)}`);

let closeCalls = 0;
const releaseProbe = cloneFrame(cleanFrames[0], {
  bitmap: { close() { closeCalls += 1; } },
  accepted: true
});
const releaseResult = P.stitchFrames2D([releaseProbe], 96, 48);
ok(releaseResult.acceptedCount === 1 && releaseProbe.pixels === null &&
   releaseProbe.bitmap === null && closeCalls === 1,
  "新 2D 管线逐帧投影后默认释放 RGBA 和 ImageBitmap");

console.log("\n【5】高置信边驱动的轻量 360°序列闭环");
const ringFrames = cleanFrames.slice(0, 12);
const driftedBases = ringFrames.map((frame, index) =>
  P.rotateBasisLocal(frame.trueBasis, 3 * index / 11, 0, 0));
const sequenceFrames = ringFrames.map((frame, index) => ({
  basis: P.copyBasis(driftedBases[index]),
  correctedBasis: P.copyBasis(driftedBases[index])
}));
const sequenceEdges = [];
for (let index = 1; index < 12; index += 1) {
  sequenceEdges.push({
    from: index - 1,
    to: index,
    accepted: true,
    confidence: 0.9,
    correctedBasis: P.copyBasis(driftedBases[index])
  });
}
const closureReference = cloneFrame(ringFrames[11], {
  basis: P.copyBasis(driftedBases[11]),
  correctedBasis: P.copyBasis(driftedBases[11]),
  correctedFovXDeg: ringFrames[11].trueFovXDeg
});
const closureCurrent = cloneFrame(ringFrames[0], {
  basis: P.copyBasis(ringFrames[0].trueBasis),
  fovXDeg: ringFrames[0].trueFovXDeg
});
const closureAlignment = P.refineFramePose(closureReference, closureCurrent, {
  maxCorrectionDeg: 6,
  maxRollDeg: 3,
  maxFovCorrectionDeg: 6,
  minOverlapRatio: 0.08,
  minScore: 0.67,
  targetSamples: 720
});
sequenceEdges.push({
  from: 11,
  to: 0,
  isClosure: true,
  accepted: closureAlignment.accepted,
  confidence: closureAlignment.confidence,
  result: closureAlignment,
  predictedStartBasis: closureAlignment.correctedBasis
});
// 恶意低置信边即使携带大旋转，也不允许污染序列。
sequenceEdges.push({
  from: 0,
  to: 5,
  accepted: true,
  confidence: 0.1,
  correctedBasis: P.rotateBasisLocal(driftedBases[5], 15, 0, 0)
});
const sequenceResult = P.optimizeFrameSequence(sequenceFrames, sequenceEdges, {
  rings: [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]],
  minEdgeConfidence: 0.45,
  imuPriorWeight: 0.1,
  loopStrength: 0.9
});
const brokenPathEdges = sequenceEdges.map((edge) => Object.assign({}, edge));
const brokenPathIndex = brokenPathEdges.findIndex((edge) =>
  edge.from === 5 && edge.to === 6 && !edge.isClosure);
brokenPathEdges[brokenPathIndex].confidence = 0.1;
const brokenPathResult = P.optimizeFrameSequence(sequenceFrames, brokenPathEdges, {
  rings: [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]],
  minEdgeConfidence: 0.45,
  imuPriorWeight: 0.1,
  loopStrength: 0.9
});
const closureBefore = P.basisRotationErrorDeg(
  driftedBases[11],
  ringFrames[11].trueBasis
);
const closureAfter = P.basisRotationErrorDeg(
  sequenceResult.bases[11],
  ringFrames[11].trueBasis
);
const driftedRingForStitch = ringFrames.map((frame, index) => cloneFrame(frame, {
  correctedBasis: P.copyBasis(driftedBases[index]),
  correctedFovXDeg: frame.trueFovXDeg
}));
const optimizedRingForStitch = ringFrames.map((frame, index) => cloneFrame(frame, {
  correctedBasis: P.copyBasis(sequenceResult.bases[index]),
  correctedFovXDeg: frame.trueFovXDeg
}));
const driftedRingStitch = P.stitchFrames2D(
  driftedRingForStitch,
  panoWidth,
  panoHeight,
  { feather: 0.2, releaseAfterProject: false }
);
const optimizedRingStitch = P.stitchFrames2D(
  optimizedRingForStitch,
  panoWidth,
  panoHeight,
  { feather: 0.2, releaseAfterProject: false }
);
const driftedRingMetrics = S.maskedMetrics(
  driftedRingStitch.raster,
  truth,
  driftedRingStitch.raster.weights
);
const optimizedRingMetrics = S.maskedMetrics(
  optimizedRingStitch.raster,
  truth,
  optimizedRingStitch.raster.weights
);
ok(closureAlignment.accepted && sequenceResult.loops.length === 1,
  "首尾照片的真实光度重叠形成一条高置信闭环边",
  `ZNCC=${round(closureAlignment.score)}, residual=` +
  `${round(sequenceResult.loops[0].residualBeforeDeg)}°`);
ok(closureAfter < closureBefore * 0.2,
  "3°累积漂移按路径置信度分摊后显著收敛",
  `${round(closureBefore)}° → ${round(closureAfter)}°`);
ok(sequenceResult.ignoredEdges.includes(sequenceEdges.length - 1) &&
   P.basisRotationErrorDeg(sequenceResult.bases[5], ringFrames[5].trueBasis) < 2,
  "低置信恶意边被忽略，不能传播 15°错误");
ok(brokenPathResult.ignoredEdges.includes(brokenPathIndex) &&
   P.basisRotationErrorDeg(
     brokenPathResult.bases[11],
     driftedBases[11]
   ) < 1e-5,
  "连续路径中出现低置信边时，闭环修正不会跨段传播");
ok(optimizedRingMetrics.ssim > driftedRingMetrics.ssim + 0.035,
  "闭环不仅改善姿态数字，也提升重投影图像结构",
  `SSIM ${round(driftedRingMetrics.ssim)} → ${round(optimizedRingMetrics.ssim)}`);

console.log("\n【6】三圈必须由跨圈相对边做真正的全局联合收敛");
const sphereTrueBases = targets.map((target) =>
  P.orthonormalBasis(target.dir, [0, 0, 1]));
const sphereDriftedBases = sphereTrueBases.map((basis, index) => {
  if (index < 12) return P.copyBasis(basis);
  return P.rotateBasisZ(basis, index < 20 ? 4 : -3);
});
const sphereGraphFrames = sphereDriftedBases.map((basis) => ({
  basis: P.copyBasis(basis),
  correctedBasis: P.copyBasis(basis)
}));
const ringOnlyEdges = [];
const sphereRings = [
  Array.from({ length: 12 }, (_, index) => index),
  Array.from({ length: 8 }, (_, index) => index + 12),
  Array.from({ length: 8 }, (_, index) => index + 20)
];
for (const ring of sphereRings) {
  for (let position = 1; position < ring.length; position += 1) {
    ringOnlyEdges.push({
      from: ring[position - 1],
      to: ring[position],
      accepted: true,
      confidence: 0.94,
      correctedBasis: P.copyBasis(sphereDriftedBases[ring[position]])
    });
  }
  ringOnlyEdges.push({
    from: ring[ring.length - 1],
    to: ring[0],
    isClosure: true,
    accepted: true,
    confidence: 0.94,
    correctedBasis: P.copyBasis(sphereDriftedBases[ring[0]])
  });
}
const crossRingEdges = [
  { from: 1, to: 12, correctedBasis: sphereTrueBases[12] },
  { from: 5, to: 15, correctedBasis: sphereTrueBases[15] },
  { from: 9, to: 18, correctedBasis: sphereTrueBases[18] },
  { from: 1, to: 20, correctedBasis: sphereTrueBases[20] },
  { from: 5, to: 23, correctedBasis: sphereTrueBases[23] },
  { from: 9, to: 26, correctedBasis: sphereTrueBases[26] }
].map((edge) => Object.assign({
  accepted: true,
  confidence: 0.97,
  isCrossRing: true
}, edge, {
  correctedBasis: P.copyBasis(edge.correctedBasis)
}));
const maliciousCrossEdge = {
  from: 0,
  to: 16,
  accepted: true,
  confidence: 0.99,
  isCrossRing: true,
  correctedBasis: P.rotateBasisZ(sphereTrueBases[16], 16)
};
const ringOnlyResult = P.optimizeFrameSequence(
  sphereGraphFrames,
  ringOnlyEdges,
  { imuPriorWeight: 0.08 }
);
const fullSphereEdges = ringOnlyEdges
  .concat(crossRingEdges)
  .concat([maliciousCrossEdge]);
const fullSphereResult = P.optimizeFrameSequence(
  sphereGraphFrames,
  fullSphereEdges,
  {
    imuPriorWeight: 0.08,
    maxInitialEdgeResidualDeg: 8,
    maxFinalEdgeResidualDeg: 4.5
  }
);
const disconnectedSphereResult = P.optimizeFrameSequence(
  sphereGraphFrames,
  ringOnlyEdges.concat(crossRingEdges.slice(0, 3)),
  { imuPriorWeight: 0.08 }
);
function ringPoseError(bases, start, end) {
  return mean(bases.slice(start, end).map((basis, offset) =>
    P.basisRotationErrorDeg(basis, sphereTrueBases[start + offset])));
}
const noCrossUpperError = ringPoseError(ringOnlyResult.bases, 12, 20);
const noCrossLowerError = ringPoseError(ringOnlyResult.bases, 20, 28);
const globalUpperError = ringPoseError(fullSphereResult.bases, 12, 20);
const globalLowerError = ringPoseError(fullSphereResult.bases, 20, 28);
const globalEquatorError = ringPoseError(fullSphereResult.bases, 0, 12);
const disconnectedLowerError = ringPoseError(
  disconnectedSphereResult.bases,
  20,
  28
);
const maliciousEdgeIndex = fullSphereEdges.length - 1;

ok(noCrossUpperError > 3.9 && noCrossLowerError > 2.9,
  "各圈内部即使完全闭合，也不能自行发现整圈绝对漂移",
  `upper=${round(noCrossUpperError)}°, lower=${round(noCrossLowerError)}°`);
ok(globalUpperError < 0.75 && globalLowerError < 0.75 &&
   globalEquatorError < 0.5,
  "跨圈相对边把三圈放进同一个全局 SO(3) 图并共同收敛",
  `equator=${round(globalEquatorError)}°, upper=${round(globalUpperError)}°, ` +
  `lower=${round(globalLowerError)}°`);
ok(fullSphereResult.method === "robust-global-so3-relative-pose-graph" &&
   fullSphereResult.residualAfterMeanDeg <
     fullSphereResult.residualBeforeMeanDeg * 0.3,
  "优化消费 from→to 相对旋转并显著降低全图残差",
  `${round(fullSphereResult.residualBeforeMeanDeg)}° → ` +
  `${round(fullSphereResult.residualAfterMeanDeg)}°`);
ok(fullSphereResult.ignoredEdges.includes(maliciousEdgeIndex) &&
   fullSphereResult.rejectedEdges.some((edge) =>
     edge.index === maliciousEdgeIndex &&
     edge.reason === "INITIAL_RESIDUAL_OUTLIER"),
  "高置信但 cycle-inconsistent 的恶意跨圈边也会被拒绝");
ok(disconnectedLowerError > 2.9 &&
   ringPoseError(disconnectedSphereResult.bases, 12, 20) < 1.5,
  "缺少下圈跨圈边时只修正已连接上圈，不跨断边扭曲下圈",
  `upper=${round(ringPoseError(disconnectedSphereResult.bases, 12, 20))}°, ` +
  `lower=${round(disconnectedLowerError)}°`);

console.log("\n【定量摘要】");
console.log(JSON.stringify({
  clean: {
    coverage: round(cleanStitch.stats.coverage, 4),
    ssim: round(cleanMetrics.ssim, 4),
    mae: round(cleanMetrics.mae, 3)
  },
  imuOnly: {
    poseErrorDeg: round(initialPoseMean, 3),
    fovErrorDeg: round(initialFovMean, 3),
    ssim: round(rawMetrics.ssim, 4),
    mae: round(rawMetrics.mae, 3),
    seamExcess: round(rawSeam.excess, 3)
  },
  visuallyCorrected: {
    accepted: correctedFrames.length,
    poseErrorDeg: round(correctedPoseMean, 3),
    fovErrorDeg: round(correctedFovMean, 3),
    meanZncc: round(meanScore, 4),
    ssim: round(correctedMetrics.ssim, 4),
    mae: round(correctedMetrics.mae, 3),
    seamExcess: round(correctedSeam.excess, 3)
  },
  rejectedBadFrame: {
    reason: badAlignment.rejectReason,
    zncc: round(badAlignment.score, 4)
  },
  loopClosure: {
    residualBeforeDeg: round(closureBefore, 3),
    residualAfterDeg: round(closureAfter, 3),
    ssimBefore: round(driftedRingMetrics.ssim, 4),
    ssimAfter: round(optimizedRingMetrics.ssim, 4),
    ignoredLowConfidenceEdges: sequenceResult.ignoredEdges.length
  },
  globalPoseGraph: {
    ringOnlyUpperErrorDeg: round(noCrossUpperError, 3),
    ringOnlyLowerErrorDeg: round(noCrossLowerError, 3),
    optimizedEquatorErrorDeg: round(globalEquatorError, 3),
    optimizedUpperErrorDeg: round(globalUpperError, 3),
    optimizedLowerErrorDeg: round(globalLowerError, 3),
    disconnectedLowerErrorDeg: round(disconnectedLowerError, 3),
    residualBeforeMeanDeg: round(fullSphereResult.residualBeforeMeanDeg, 3),
    residualAfterMeanDeg: round(fullSphereResult.residualAfterMeanDeg, 3),
    rejectedEdges: fullSphereResult.rejectedEdges
  }
}, null, 2));

console.log(failures.length
  ? `\n❌ 不通过 ${failures.length} 条：\n  - ${failures.join("\n  - ")}`
  : "\n✅ 视觉几何与坏帧拒绝回归全部通过");
process.exit(failures.length ? 1 : 0);
