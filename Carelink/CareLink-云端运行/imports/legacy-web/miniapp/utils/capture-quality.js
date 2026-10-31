/*
 * Cheap, deterministic on-device rejection gates. These are deliberately
 * conservative: they reject gross motion/blur/exposure failures, while the
 * later visual stitcher remains responsible for fine alignment.
 */
"use strict";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function analyzeImage(pixels, width, height) {
  var w = Math.max(1, width | 0);
  var h = Math.max(1, height | 0);
  if (!pixels || pixels.length < w * h * 4) {
    return {
      sampleCount: 0,
      lumaMean: 0,
      clippedRatio: 1,
      sharpness: 0
    };
  }
  var step = Math.max(2, Math.floor(Math.min(w, h) / 96));
  var count = 0;
  var sum = 0;
  var clipped = 0;
  var lapSum = 0;
  var lapSquareSum = 0;
  var lapCount = 0;

  function lumaAt(x, y) {
    var index = (y * w + x) * 4;
    return pixels[index] * 0.299 + pixels[index + 1] * 0.587 + pixels[index + 2] * 0.114;
  }

  for (var y = step; y < h - step; y += step) {
    for (var x = step; x < w - step; x += step) {
      var center = lumaAt(x, y);
      sum += center;
      count += 1;
      if (center <= 8 || center >= 247) clipped += 1;
      var laplacian = 4 * center -
        lumaAt(x - step, y) - lumaAt(x + step, y) -
        lumaAt(x, y - step) - lumaAt(x, y + step);
      lapSum += laplacian;
      lapSquareSum += laplacian * laplacian;
      lapCount += 1;
    }
  }
  var lapMean = lapCount ? lapSum / lapCount : 0;
  return {
    sampleCount: count,
    lumaMean: count ? sum / count : 0,
    clippedRatio: count ? clipped / count : 1,
    sharpness: lapCount
      ? Math.max(0, lapSquareSum / lapCount - lapMean * lapMean)
      : 0
  };
}

function classifyFrame(input) {
  var metrics = input || {};
  var reasons = [];
  var maxSpeed = Number(metrics.maxRawSpeedDegS);
  var poseSpan = Number(metrics.poseSpanDeg);
  var angle = Number(metrics.targetAngleDeg);
  var roll = Math.abs(Number(metrics.rollDeg));
  var shutterMs = Number(metrics.shutterWindowMs);
  var sharpness = Number(metrics.sharpness);
  var lumaMean = Number(metrics.lumaMean);
  var clippedRatio = Number(metrics.clippedRatio);

  if (!isFinite(maxSpeed) || maxSpeed > 6) reasons.push("快门期间手机仍在转动");
  if (!isFinite(poseSpan) || poseSpan > 1) reasons.push("快门期间方向漂移过大");
  if (!isFinite(angle) || angle > 6) reasons.push("白点没有保持在中央");
  if (!isFinite(roll) || roll > 25) reasons.push("手机侧倾过大");
  if (!isFinite(shutterMs) || shutterMs > 700) reasons.push("相机取帧延迟过高");
  if (!isFinite(sharpness) || sharpness < 12) reasons.push("照片过于模糊");
  if (!isFinite(lumaMean) || lumaMean < 14 || lumaMean > 242) reasons.push("照片曝光异常");
  if (!isFinite(clippedRatio) || clippedRatio > 0.78) reasons.push("照片大面积过曝或欠曝");

  return {
    accepted: reasons.length === 0,
    reasons: reasons,
    maxRawSpeedDegS: isFinite(maxSpeed) ? maxSpeed : Infinity,
    poseSpanDeg: isFinite(poseSpan) ? poseSpan : Infinity,
    targetAngleDeg: isFinite(angle) ? angle : Infinity,
    rollDeg: isFinite(roll) ? roll : Infinity,
    shutterWindowMs: isFinite(shutterMs) ? shutterMs : Infinity,
    sharpness: isFinite(sharpness) ? sharpness : 0,
    lumaMean: isFinite(lumaMean) ? lumaMean : 0,
    clippedRatio: isFinite(clippedRatio) ? clamp(clippedRatio, 0, 1) : 1
  };
}

module.exports = {
  analyzeImage: analyzeImage,
  classifyFrame: classifyFrame
};
