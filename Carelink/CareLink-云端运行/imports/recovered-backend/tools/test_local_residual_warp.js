#!/usr/bin/env node
"use strict";

/*
 * Deterministic regression for the conservative projected residual mesh.
 * The fixture starts after spherical projection so it can independently mix
 * EIS scale, rolling-shutter shear and small finite-depth parallax without
 * hiding the expected geometry behind the same projector under test.
 */

const assert = require("assert");
const crypto = require("crypto");
const P = require("../miniapp/utils/pano-core.js");

const WIDTH = 384;
const HEIGHT = 192;
const OLD = { x0: 44, x1: 255, y0: 20, y1: 171 };
const CURRENT = { x0: 140, x1: 310, y0: 20, y1: 171 };

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function wrapX(value) {
  return ((value % WIDTH) + WIDTH) % WIDTH;
}

function hashNoise(x, y) {
  const raw = Math.sin(x * 12.9898 + y * 78.233 + 0.731) * 43758.5453;
  return raw - Math.floor(raw);
}

function truthRgb(x, y, mode) {
  x = wrapX(x);
  y = clamp(y, 0, HEIGHT - 1);
  if (mode === "flat") return [118, 123, 129];
  if (mode === "repeat") {
    const checker = (Math.floor(x / 4) + Math.floor(y / 4)) % 2;
    return checker ? [224, 47, 196] : [31, 211, 64];
  }
  if (mode === "periodic") {
    const angle = x / WIDTH * Math.PI * 2;
    let red = 122 + 55 * Math.sin(angle * 7 + y * 0.071) +
      24 * Math.cos(angle * 13 - y * 0.031);
    let green = 119 + 49 * Math.cos(angle * 9 + y * 0.053) -
      21 * Math.sin(angle * 17 + y * 0.019);
    let blue = 126 + 46 * Math.sin(angle * 11 - y * 0.047) +
      19 * Math.cos(angle * 5 + y * 0.083);
    if (Math.abs(Math.sin(angle * 19 + y * 0.037)) < 0.11) {
      red = 240;
      green = 236;
      blue = 226;
    }
    if (Math.abs(Math.sin(angle * 29 - y * 0.021 + 0.4)) < 0.09) {
      red = 22;
      green = 30;
      blue = 41;
    }
    return [
      clamp(red, 0, 255),
      clamp(green, 0, 255),
      clamp(blue, 0, 255)
    ];
  }
  const cellX = Math.floor(x / 17);
  const cellY = Math.floor(y / 13);
  const noise = hashNoise(cellX, cellY) - 0.5;
  let red = 116 + 47 * Math.sin(x * 0.113 + y * 0.019) + 37 * noise;
  let green = 121 + 43 * Math.sin(x * 0.067 - y * 0.103 + 0.8) - 29 * noise;
  let blue = 128 + 41 * Math.cos(x * 0.089 + y * 0.071) + 21 * noise;
  if (Math.abs((x % 31) - 15) < 1.1 ||
      Math.abs((y % 29) - 14) < 1.1) {
    red = 238;
    green = 235;
    blue = 227;
  }
  if (Math.abs(((x + y * 0.43) % 53) - 26) < 1.2) {
    red = 24;
    green = 31;
    blue = 40;
  }
  return [
    clamp(red, 0, 255),
    clamp(green, 0, 255),
    clamp(blue, 0, 255)
  ];
}

function bilinearTruth(x, y, mode) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const a = truthRgb(x0, y0, mode);
  const b = truthRgb(x0 + 1, y0, mode);
  const c = truthRgb(x0, y0 + 1, mode);
  const d = truthRgb(x0 + 1, y0 + 1, mode);
  return a.map(function (_, channel) {
    return (a[channel] * (1 - tx) + b[channel] * tx) * (1 - ty) +
      (c[channel] * (1 - tx) + d[channel] * tx) * ty;
  });
}

function inWrappedBounds(x, y, bounds) {
  if (y < bounds.y0 || y > bounds.y1) return false;
  if (bounds.x0 <= bounds.x1) return x >= bounds.x0 && x <= bounds.x1;
  return x >= bounds.x0 || x <= bounds.x1;
}

function wrappedDelta(x, centre) {
  let delta = x - centre;
  while (delta < -WIDTH / 2) delta += WIDTH;
  while (delta >= WIDTH / 2) delta -= WIDTH;
  return delta;
}

function horizontalHalfWidth(bounds) {
  return bounds.x0 <= bounds.x1 ?
    (bounds.x1 - bounds.x0) / 2 :
    (WIDTH - bounds.x0 + bounds.x1) / 2;
}

function boundsCentreX(bounds) {
  return wrapX(bounds.x0 + horizontalHalfWidth(bounds));
}

function edgeWeight(x, y, bounds) {
  const centreX = boundsCentreX(bounds);
  const halfX = horizontalHalfWidth(bounds);
  const centreY = (bounds.y0 + bounds.y1) / 2;
  const halfY = (bounds.y1 - bounds.y0) / 2;
  const nx = Math.abs(wrappedDelta(x, centreX)) / Math.max(1, halfX);
  const ny = Math.abs(y - centreY) / Math.max(1, halfY);
  const edge = Math.min(1 - nx, 1 - ny);
  const t = clamp(edge / 0.08, 0, 1);
  return t * t * (3 - 2 * t);
}

function centrePriority(x, y, bounds) {
  const centreX = boundsCentreX(bounds);
  const halfX = horizontalHalfWidth(bounds);
  const centreY = (bounds.y0 + bounds.y1) / 2;
  const halfY = (bounds.y1 - bounds.y0) / 2;
  const px = Math.max(0.001, 1 - Math.abs(wrappedDelta(x, centreX)) / halfX);
  const py = Math.max(0.001, 1 - Math.abs(y - centreY) / halfY);
  return px * px * py * py;
}

function flowAt(x, y, params, bounds) {
  const centreX = boundsCentreX(bounds);
  const centreY = (bounds.y0 + bounds.y1) / 2;
  const localX = wrappedDelta(x, centreX);
  const row = (y - centreY) / Math.max(1, bounds.y1 - bounds.y0);
  let dx = params.dx + params.scaleX * localX + params.rollingX * row;
  let dy = params.dy + params.scaleY * (y - centreY) + params.rollingY * row;
  if (params.worsenBand && Math.abs(localX - params.worsenBand.centre) <=
      params.worsenBand.halfWidth) {
    dx = params.worsenBand.dx;
    dy = params.worsenBand.dy;
  }
  return { dx: dx, dy: dy };
}

function makeContainer() {
  const container = P.createRaster(WIDTH, HEIGHT);
  container.priorities = new Float32Array(WIDTH * HEIGHT);
  container.owners = new Uint8Array(WIDTH * HEIGHT);
  return container;
}

function setPixel(container, index, rgb, weight, priority, owner) {
  const offset = index * 4;
  container.pixels[offset] = rgb[0];
  container.pixels[offset + 1] = rgb[1];
  container.pixels[offset + 2] = rgb[2];
  container.pixels[offset + 3] = 255;
  container.weights[index] = weight;
  container.priorities[index] = priority;
  if (owner) container.owners[index] = owner;
}

function fixture(params) {
  const oldBounds = params.oldBounds || OLD;
  const currentBounds = params.currentBounds || CURRENT;
  const old = makeContainer();
  const current = makeContainer();
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const index = y * WIDTH + x;
      if (inWrappedBounds(x, y, oldBounds)) {
        const weight = edgeWeight(x, y, oldBounds);
        if (weight > 0.001) {
          setPixel(
            old,
            index,
            truthRgb(x, y, params.mode),
            weight,
            centrePriority(x, y, oldBounds),
            1
          );
        }
      }
      if (inWrappedBounds(x, y, currentBounds)) {
        const weight = edgeWeight(x, y, currentBounds);
        if (weight > 0.001) {
          let sourceX = x;
          let sourceY = y;
          if (params.dominantForeground) {
            const moving = x >= 145 && x <= 270 && y >= 30 && y <= 162;
            let foregroundShiftX = params.dominantForeground.shiftX;
            if (params.dominantForeground.segmented) {
              foregroundShiftX = x < 185 ? 2 : (x < 230 ? 3 : 4);
            }
            sourceX = moving ? x - foregroundShiftX : x;
          } else {
            // Invert the smooth current->truth map to mimic a locally
            // distorted projected camera frame.
            for (let iteration = 0; iteration < 4; iteration += 1) {
              const flow = flowAt(sourceX, sourceY, params, currentBounds);
              sourceX = x - flow.dx;
              sourceY = y - flow.dy;
            }
          }
          const rgb = bilinearTruth(sourceX, sourceY, params.mode);
          setPixel(
            current,
            index,
            rgb,
            weight,
            centrePriority(x, y, currentBounds),
            0
          );
        }
      }
    }
  }
  return {
    old: old,
    current: current,
    oldBounds: oldBounds,
    currentBounds: currentBounds,
    mode: params.mode
  };
}

function cloneContainer(source) {
  const clone = P.createRaster(source.width, source.height);
  clone.pixels.set(source.pixels);
  clone.weights.set(source.weights);
  clone.priorities = new Float32Array(source.priorities);
  clone.owners = new Uint8Array(source.owners || source.weights.length);
  return clone;
}

function compose(sourceFixture, localWarp, frameIndex) {
  const destination = cloneContainer(sourceFixture.old);
  const layer = cloneContainer(sourceFixture.current);
  const stats = P.compositeProjectedLayerSeamAware(destination, layer, {
    autoExposure: false,
    frameIndex: frameIndex == null ? 1 : frameIndex,
    agreeThreshold: 12,
    seamGridWidth: 192,
    seamGridHeight: 96,
    localWarp: localWarp,
    warpGridCols: 8,
    warpGridRows: 6
  });
  return { raster: destination, stats: stats };
}

function bytes(view) {
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}

function assertVisualStateExactlyEqual(actual, expected, label) {
  ["pixels", "weights", "priorities", "owners"].forEach(function (key) {
    assert.strictEqual(
      Buffer.compare(bytes(actual[key]), bytes(expected[key])),
      0,
      label + ": " + key + " must be byte-identical"
    );
  });
}

function rgbDistanceAt(raster, x, y, mode) {
  const index = y * WIDTH + x;
  const offset = index * 4;
  const truth = truthRgb(x, y, mode || "structure");
  const dr = raster.pixels[offset] - truth[0];
  const dg = raster.pixels[offset + 1] - truth[1];
  const db = raster.pixels[offset + 2] - truth[2];
  return Math.sqrt((dr * dr + dg * dg + db * db) / 3);
}

function percentile(values, q) {
  const sorted = values.slice().sort(function (a, b) { return a - b; });
  if (!sorted.length) return Infinity;
  return sorted[Math.floor((sorted.length - 1) * q)];
}

function seamBandTruthP90(result, sourceFixture) {
  const errors = [];
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const index = y * WIDTH + x;
      if (sourceFixture.old.weights[index] <= 0.05 ||
          sourceFixture.current.weights[index] <= 0.05) continue;
      const ratio = Math.log(
        (sourceFixture.current.priorities[index] + 1e-4) /
        (sourceFixture.old.priorities[index] + 1e-4)
      );
      if (Math.abs(ratio) > 0.32) continue;
      errors.push(rgbDistanceAt(result.raster, x, y, sourceFixture.mode));
    }
  }
  return { samples: errors.length, p90: percentile(errors, 0.9) };
}

function boundaryGradientP90(result, sourceFixture) {
  const excess = [];
  for (let y = 1; y < HEIGHT - 1; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const nextX = (x + 1) % WIDTH;
      const index = y * WIDTH + x;
      const nextIndex = y * WIDTH + nextX;
      const oldHere = sourceFixture.old.weights[index] > 0.001;
      const oldNext = sourceFixture.old.weights[nextIndex] > 0.001;
      if (oldHere === oldNext ||
          sourceFixture.current.weights[index] <= 0.05 ||
          sourceFixture.current.weights[nextIndex] <= 0.05) continue;
      const aOffset = index * 4;
      const bOffset = nextIndex * 4;
      const dr = result.raster.pixels[aOffset] - result.raster.pixels[bOffset];
      const dg = result.raster.pixels[aOffset + 1] - result.raster.pixels[bOffset + 1];
      const db = result.raster.pixels[aOffset + 2] - result.raster.pixels[bOffset + 2];
      const rendered = Math.sqrt((dr * dr + dg * dg + db * db) / 3);
      const truthA = truthRgb(x, y, "structure");
      const truthB = truthRgb(nextX, y, "structure");
      const tr = truthA[0] - truthB[0];
      const tg = truthA[1] - truthB[1];
      const tb = truthA[2] - truthB[2];
      const natural = Math.sqrt((tr * tr + tg * tg + tb * tb) / 3);
      excess.push(Math.max(0, rendered - natural));
    }
  }
  return { samples: excess.length, p90: percentile(excess, 0.9) };
}

function visualDigest(result) {
  const diagnostic = result.stats.localWarp;
  const digest = crypto.createHash("sha256");
  ["pixels", "weights", "priorities", "owners"].forEach(function (key) {
    digest.update(bytes(result.raster[key]));
  });
  digest.update(JSON.stringify({
    attempted: diagnostic.attempted,
    applied: diagnostic.applied,
    reason: diagnostic.reason,
    holdoutBefore: diagnostic.holdoutBefore,
    holdoutAfter: diagnostic.holdoutAfter,
    seamP90Before: diagnostic.seamP90Before,
    seamP90After: diagnostic.seamP90After,
    maxDisplacement: diagnostic.maxDisplacement,
    grid: diagnostic.grid,
    extraBytes: diagnostic.extraBytes
  }));
  return digest.digest("hex");
}

const positiveParams = {
  mode: "structure",
  dx: 0.75,
  dy: 0.6,
  scaleX: 0.018,
  scaleY: 0.01,
  rollingX: 3.4,
  rollingY: 1.4
};

function run() {
  const report = { checks: [], diagnostics: {} };
  function check(name, callback) {
    callback();
    report.checks.push(name);
    console.log("✅ " + name);
  }

  const positiveFixture = fixture(positiveParams);
  const disabled = compose(positiveFixture, false);
  const enabled = compose(positiveFixture, true);
  const diagnostic = enabled.stats.localWarp;
  const disabledBand = seamBandTruthP90(disabled, positiveFixture);
  const enabledBand = seamBandTruthP90(enabled, positiveFixture);
  report.diagnostics.positive = diagnostic;
  report.diagnostics.seamBand = {
    disabled: disabledBand,
    enabled: enabledBand
  };
  const disabledBoundary = boundaryGradientP90(disabled, positiveFixture);
  const enabledBoundary = boundaryGradientP90(enabled, positiveFixture);
  report.diagnostics.supportBoundary = {
    disabled: disabledBoundary,
    enabled: enabledBoundary
  };

  check("高纹理手持残差通过双重门控并启用局部网格", function () {
    assert.strictEqual(diagnostic.attempted, true);
    assert.strictEqual(diagnostic.applied, true);
    assert.strictEqual(diagnostic.reason, "ACCEPTED");
    assert.strictEqual(diagnostic.holdoutField, "training-only");
    assert(diagnostic.validationMatches >= 4);
    assert(diagnostic.holdoutAfter < diagnostic.holdoutBefore);
    assert(diagnostic.seamP90After < diagnostic.seamP90Before);
    assert(diagnostic.maxDisplacement > 0.5);
    assert(diagnostic.maxDisplacement <= diagnostic.maxDisplacementLimit + 1e-6);
  });

  check("局部网格改善真实接缝带且不减少覆盖", function () {
    assert(disabledBand.samples >= 40);
    assert(enabledBand.p90 <= disabledBand.p90 * 0.96,
      enabledBand.p90 + " !<= " + disabledBand.p90 + " * 0.96");
    const disabledCoverage = disabled.raster.weights.reduce(function (sum, value) {
      return sum + (value > 0.001 ? 1 : 0);
    }, 0);
    const enabledCoverage = enabled.raster.weights.reduce(function (sum, value) {
      return sum + (value > 0.001 ? 1 : 0);
    }, 0);
    assert.strictEqual(enabledCoverage, disabledCoverage);
  });

  check("warped/raw 支持边界连续，不制造第二条硬接缝", function () {
    assert(enabledBoundary.samples >= 40);
    assert(enabledBoundary.p90 <= Math.max(8, disabledBoundary.p90 * 1.5),
      enabledBoundary.p90 + " vs disabled " + disabledBoundary.p90);
  });

  check("网格只使用节点级小内存，不分配第二张全景", function () {
    const nodes = (diagnostic.grid[0] + 1) * (diagnostic.grid[1] + 1);
    assert(Number.isFinite(diagnostic.extraBytes));
    assert(diagnostic.extraBytes <= nodes * 512 + 8192);
    assert(diagnostic.extraBytes < WIDTH * HEIGHT * 4);
  });

  const firstFrame = makeContainer();
  const firstLayer = cloneContainer(positiveFixture.current);
  const firstEnabled = P.compositeProjectedLayerSeamAware(firstFrame, firstLayer, {
    autoExposure: false,
    frameIndex: 0,
    localWarp: true
  });
  const firstDisabledRaster = makeContainer();
  P.compositeProjectedLayerSeamAware(
    firstDisabledRaster,
    cloneContainer(positiveFixture.current),
    { autoExposure: false, frameIndex: 0, localWarp: false }
  );
  check("首帧没有 overlap 时零影响回退", function () {
    assert.strictEqual(firstEnabled.localWarp.applied, false);
    assert.notStrictEqual(firstEnabled.localWarp.reason, "ACCEPTED");
    assertVisualStateExactlyEqual(firstFrame, firstDisabledRaster, "first-frame");
  });

  const omittedDefault = compose(positiveFixture, undefined);
  check("未显式 opt-in 时默认输出与 localWarp:false 完全一致", function () {
    assert.strictEqual(omittedDefault.stats.localWarp.attempted, false);
    assert.strictEqual(omittedDefault.stats.localWarp.applied, false);
    assert.strictEqual(omittedDefault.stats.localWarp.reason, "DISABLED");
    assertVisualStateExactlyEqual(
      omittedDefault.raster,
      disabled.raster,
      "omitted-default"
    );
  });

  [
    { name: "低纹理", params: Object.assign({}, positiveParams, { mode: "flat" }) },
    { name: "重复纹理", params: Object.assign({}, positiveParams, {
      mode: "repeat", dx: 4, dy: 0, scaleX: 0, scaleY: 0,
      rollingX: 0, rollingY: 0
    }) }
  ].forEach(function (negative) {
    const negativeFixture = fixture(negative.params);
    const negativeEnabled = compose(negativeFixture, true);
    const negativeDisabled = compose(negativeFixture, false);
    check(negative.name + "不会误启用且逐字节回退", function () {
      assert.strictEqual(negativeEnabled.stats.localWarp.applied, false);
      assert.notStrictEqual(negativeEnabled.stats.localWarp.reason, "ACCEPTED");
      assertVisualStateExactlyEqual(
        negativeEnabled.raster,
        negativeDisabled.raster,
        negative.name
      );
    });
  });

  // This mild sub-pixel case is intentionally deceptive: the candidate field
  // looks much better on held-out feature patches but creates a larger P90 in
  // the actual centre-priority seam strip. It guards the second acceptance
  // gate that the one-off prototype proved necessary.
  const worseningFixture = fixture({
    mode: "structure",
    dx: 0.6,
    dy: 0.15,
    scaleX: 0.0009,
    scaleY: 0.00048,
    rollingX: 0,
    rollingY: 0
  });
  const worseningEnabled = compose(worseningFixture, true);
  const worseningDisabled = compose(worseningFixture, false);
  const worseningDiagnostic = worseningEnabled.stats.localWarp;
  report.diagnostics.worseningCandidate = worseningDiagnostic;
  check("留出集变好但接缝带变差的候选必须零影响回退", function () {
    assert(worseningDiagnostic.holdoutAfter < worseningDiagnostic.holdoutBefore);
    assert(worseningDiagnostic.seamP90After >= worseningDiagnostic.seamP90Before);
    assert.strictEqual(worseningDiagnostic.applied, false);
    assert.strictEqual(worseningDiagnostic.reason, "SEAM_BAND_DID_NOT_IMPROVE");
    assertVisualStateExactlyEqual(
      worseningEnabled.raster,
      worseningDisabled.raster,
      "worsening-candidate"
    );
  });

  const dynamicFixture = fixture({
    mode: "structure",
    dx: 0,
    dy: 0,
    scaleX: 0,
    scaleY: 0,
    rollingX: 0,
    rollingY: 0,
    dominantForeground: { shiftX: 5 }
  });
  const dynamicEnabled = compose(dynamicFixture, true);
  const dynamicDisabled = compose(dynamicFixture, false);
  report.diagnostics.dominantForeground = dynamicEnabled.stats.localWarp;
  check("dominant 移动物平面不能被误当相机局部网格", function () {
    assert.strictEqual(dynamicEnabled.stats.localWarp.applied, false);
    assert.notStrictEqual(dynamicEnabled.stats.localWarp.reason, "ACCEPTED");
    assertVisualStateExactlyEqual(
      dynamicEnabled.raster,
      dynamicDisabled.raster,
      "dominant-foreground"
    );
  });

  const segmentedDynamicFixture = fixture({
    mode: "structure",
    dx: 0,
    dy: 0,
    scaleX: 0,
    scaleY: 0,
    rollingX: 0,
    rollingY: 0,
    dominantForeground: { segmented: true }
  });
  const segmentedDynamicEnabled = compose(segmentedDynamicFixture, true);
  const segmentedDynamicDisabled = compose(segmentedDynamicFixture, false);
  report.diagnostics.segmentedDominantForeground =
    segmentedDynamicEnabled.stats.localWarp;
  check("分段 2/3/4px dominant 前景不能伪装成相机差分残差", function () {
    assert.strictEqual(segmentedDynamicEnabled.stats.localWarp.applied, false);
    assert.strictEqual(
      segmentedDynamicEnabled.stats.localWarp.reason,
      "NON_ZERO_MEAN_RESIDUAL"
    );
    assertVisualStateExactlyEqual(
      segmentedDynamicEnabled.raster,
      segmentedDynamicDisabled.raster,
      "segmented-dominant-foreground"
    );
  });

  const wrapFixture = fixture(Object.assign({}, positiveParams, {
    mode: "periodic",
    dx: 1.2,
    dy: 0.5,
    scaleX: 0.018,
    scaleY: 0.008,
    rollingX: 1.8,
    rollingY: 0.9,
    oldBounds: { x0: 286, x1: 101, y0: 20, y1: 171 },
    currentBounds: { x0: 334, x1: 120, y0: 20, y1: 171 }
  }));
  const wrapEnabled = compose(wrapFixture, true, 3);
  const wrapDisabled = compose(wrapFixture, false, 3);
  const wrapBandEnabled = seamBandTruthP90(wrapEnabled, wrapFixture);
  const wrapBandDisabled = seamBandTruthP90(wrapDisabled, wrapFixture);
  check("经度 0/360 边界的匹配和逆采样正确环绕", function () {
    assert.strictEqual(wrapEnabled.stats.localWarp.applied, true,
      JSON.stringify(wrapEnabled.stats.localWarp));
    let leftOverlap = 0;
    let rightOverlap = 0;
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) {
        const index = y * WIDTH + x;
        if (wrapFixture.old.weights[index] <= 0.05 ||
            wrapFixture.current.weights[index] <= 0.05) continue;
        if (x < 16) leftOverlap += 1;
        if (x >= WIDTH - 16) rightOverlap += 1;
      }
    }
    assert(leftOverlap > 0 && rightOverlap > 0);
    assert(wrapBandEnabled.p90 < wrapBandDisabled.p90,
      JSON.stringify({
        enabled: wrapBandEnabled,
        disabled: wrapBandDisabled,
        diagnostic: wrapEnabled.stats.localWarp
      }));
  });

  const unsafeWrapFixture = fixture({
    mode: "structure",
    dx: 1.5,
    dy: 0.5,
    scaleX: 0.018,
    scaleY: 0.008,
    rollingX: 1.8,
    rollingY: 0.9,
    oldBounds: { x0: 286, x1: 101, y0: 20, y1: 171 },
    currentBounds: { x0: 334, x1: 120, y0: 20, y1: 171 }
  });
  const unsafeWrapEnabled = compose(unsafeWrapFixture, true, 3);
  const unsafeWrapDisabled = compose(unsafeWrapFixture, false, 3);
  check("绝对接缝残差仍过高时即使相对改善也必须回退", function () {
    assert.strictEqual(unsafeWrapEnabled.stats.localWarp.applied, false);
    assert.strictEqual(
      unsafeWrapEnabled.stats.localWarp.reason,
      "SEAM_RESIDUAL_TOO_HIGH"
    );
    assertVisualStateExactlyEqual(
      unsafeWrapEnabled.raster,
      unsafeWrapDisabled.raster,
      "unsafe-wrap-residual"
    );
  });

  check("同一手持夹具连续 10 次结果完全确定", function () {
    const digests = [];
    for (let iteration = 0; iteration < 10; iteration += 1) {
      digests.push(visualDigest(compose(positiveFixture, true)));
    }
    assert.strictEqual(new Set(digests).size, 1, digests.join("\n"));
    report.diagnostics.deterministicDigest = digests[0];
  });

  console.log("\n【JSON 摘要】");
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) run();

module.exports = {
  fixture: fixture,
  compose: compose,
  positiveParams: positiveParams,
  assertVisualStateExactlyEqual: assertVisualStateExactlyEqual
};
