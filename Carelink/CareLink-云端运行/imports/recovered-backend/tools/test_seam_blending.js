#!/usr/bin/env node
"use strict";

/*
 * Fixed-seed regression for parallax ghosting in a two-frame overlap.
 *
 * The background is an infinite spherical panorama. A bright, finite-depth
 * pole is rendered from camera centres 6 cm apart, so its two projections
 * disagree even though the background and camera rotations are exact.
 *
 * A whole-overlap feather produces intermediate colours at both pole
 * positions. A seam-aware compositor should select one source almost
 * everywhere and mix only in a narrow seam band.
 */

const path = require("path");
const ROOT = path.dirname(__dirname);
const P = require(path.join(ROOT, "miniapp/utils/pano-core.js"));
const S = require("./pano_synthetic.js");

const FIXTURE_SEED = 0x51ea2026;
const PANO_WIDTH = 512;
const PANO_HEIGHT = 256;
const FRAME_WIDTH = 192;
const FRAME_HEIGHT = 256;
const FOV_X_DEG = 65;
const FEATHER = 0.2;
const CONFLICT_RGB_DISTANCE = 30;
const MIX_LOW = 0.15;
const MIX_HIGH = 0.85;
const POLE_LONGITUDE_DEG = 15;
const FOREGROUND_DEPTH_METRES = 0.8;
const POLE_HALF_WIDTH_METRES = 0.012;
const POLE_HALF_HEIGHT_METRES = 0.34;
const CAMERA_OFFSETS_METRES = [-0.03, 0.03];
const COMPLETE_PIXEL_RECALL = 0.9;
const COMPLETE_ROW_RECALL = 0.95;
const MAX_MISSING_ROW_RUN = 1;
const MAX_SECONDARY_POLE_RATIO = 0.12;

const failures = [];

function ok(condition, label, detail) {
  process.stdout.write(
    `${condition ? "✅" : "❌"} ${label}${detail ? "  " + detail : ""}\n`
  );
  if (!condition) failures.push(label);
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale(v, amount) {
  return [v[0] * amount, v[1] * amount, v[2] * amount];
}

function renderParallaxFrame(truth, yawDeg, cameraOffsetMetres, noiseSeed) {
  const basis = P.orthonormalBasis(
    P.directionFromYawPitch(yawDeg, 0),
    P.WORLD_UP
  );
  const background = S.renderPerspective(
    P,
    truth,
    FRAME_WIDTH,
    FRAME_HEIGHT,
    basis,
    FOV_X_DEG
  );

  const planeNormal = P.directionFromYawPitch(POLE_LONGITUDE_DEG, 0);
  const tangent = P.normalize([
    Math.cos(POLE_LONGITUDE_DEG * Math.PI / 180),
    -Math.sin(POLE_LONGITUDE_DEG * Math.PI / 180),
    0
  ]);
  const cameraOrigin = scale(tangent, cameraOffsetMetres);
  const planeCentre = scale(planeNormal, FOREGROUND_DEPTH_METRES);
  const aspect = FRAME_WIDTH / FRAME_HEIGHT;

  for (let y = 0; y < FRAME_HEIGHT; y += 1) {
    const ny = 1 - (y + 0.5) / FRAME_HEIGHT * 2;
    for (let x = 0; x < FRAME_WIDTH; x += 1) {
      const nx = (x + 0.5) / FRAME_WIDTH * 2 - 1;
      const direction = P.directionFromImagePoint(
        nx,
        ny,
        basis,
        FOV_X_DEG,
        aspect
      );
      const denominator = P.dot(direction, planeNormal);
      if (denominator <= 1e-6) continue;
      const distance = P.dot(
        subtract(planeCentre, cameraOrigin),
        planeNormal
      ) / denominator;
      if (distance <= 0) continue;
      const hit = add(cameraOrigin, scale(direction, distance));
      const relative = subtract(hit, planeCentre);
      const localX = P.dot(relative, tangent);
      const localY = relative[2];
      if (Math.abs(localX) > POLE_HALF_WIDTH_METRES ||
          Math.abs(localY) > POLE_HALF_HEIGHT_METRES) {
        continue;
      }

      const pixel = (y * FRAME_WIDTH + x) * 4;
      const stripe = Math.floor(
        (localY + POLE_HALF_HEIGHT_METRES) / 0.055
      ) % 2;
      background.pixels[pixel] = stripe ? 252 : 236;
      background.pixels[pixel + 1] = stripe ? 246 : 224;
      background.pixels[pixel + 2] = stripe ? 42 : 24;
      background.pixels[pixel + 3] = 255;
    }
  }

  const noisy = S.perturbPixels(background, {
    seed: noiseSeed,
    noise: 0.65
  });
  noisy.basis = basis;
  noisy.fovXDeg = FOV_X_DEG;
  return noisy;
}

function projectOne(frame) {
  const raster = P.createRaster(PANO_WIDTH, PANO_HEIGHT);
  P.projectPatch(
    raster,
    frame.pixels,
    frame.width,
    frame.height,
    frame.basis,
    {
      fovXDeg: frame.fovXDeg,
      feather: FEATHER,
      frameIndex: frame.frameIndex,
      alignmentConfidence: frame.alignmentConfidence
    }
  );
  return raster;
}

function projectPair(projector, frames) {
  const raster = P.createRaster(PANO_WIDTH, PANO_HEIGHT);
  for (const frame of frames) {
    projector(
      raster,
      frame.pixels,
      frame.width,
      frame.height,
      frame.basis,
      {
        fovXDeg: frame.fovXDeg,
        feather: FEATHER,
        frameIndex: frame.frameIndex,
        alignmentConfidence: frame.alignmentConfidence
      }
    );
  }
  return raster;
}

function mixedConflictMetrics(output, sourceA, sourceB) {
  let conflictPixels = 0;
  let mixedPixels = 0;
  let entropySum = 0;
  let nearestSourceDistanceSum = 0;
  let offModelPixels = 0;

  for (let pixelIndex = 0; pixelIndex < output.weights.length; pixelIndex += 1) {
    if (sourceA.weights[pixelIndex] <= 0.001 ||
        sourceB.weights[pixelIndex] <= 0.001 ||
        output.weights[pixelIndex] <= 0.001) {
      continue;
    }
    const offset = pixelIndex * 4;
    const ar = sourceA.pixels[offset];
    const ag = sourceA.pixels[offset + 1];
    const ab = sourceA.pixels[offset + 2];
    const br = sourceB.pixels[offset];
    const bg = sourceB.pixels[offset + 1];
    const bb = sourceB.pixels[offset + 2];
    const dr = ar - br;
    const dg = ag - bg;
    const db = ab - bb;
    const denominator = dr * dr + dg * dg + db * db;
    if (denominator < CONFLICT_RGB_DISTANCE * CONFLICT_RGB_DISTANCE) continue;

    const or = output.pixels[offset];
    const og = output.pixels[offset + 1];
    const ob = output.pixels[offset + 2];
    const rawAlpha = (
      (or - br) * dr +
      (og - bg) * dg +
      (ob - bb) * db
    ) / denominator;
    const alpha = Math.max(0, Math.min(1, rawAlpha));
    const reconstructedR = br + alpha * dr;
    const reconstructedG = bg + alpha * dg;
    const reconstructedB = bb + alpha * db;
    const lineResidual = Math.sqrt(
      (or - reconstructedR) ** 2 +
      (og - reconstructedG) ** 2 +
      (ob - reconstructedB) ** 2
    );
    const distanceA = Math.sqrt(
      (or - ar) ** 2 + (og - ag) ** 2 + (ob - ab) ** 2
    );
    const distanceB = Math.sqrt(
      (or - br) ** 2 + (og - bg) ** 2 + (ob - bb) ** 2
    );

    conflictPixels += 1;
    if (alpha > MIX_LOW && alpha < MIX_HIGH) mixedPixels += 1;
    entropySum += 4 * alpha * (1 - alpha);
    nearestSourceDistanceSum += Math.min(distanceA, distanceB);
    if (lineResidual > 12) offModelPixels += 1;
  }

  return {
    conflictPixels,
    mixedPixels,
    mixedConflictRatio: conflictPixels ? mixedPixels / conflictPixels : Infinity,
    mixEntropy: conflictPixels ? entropySum / conflictPixels : Infinity,
    nearestSourceRgbDistance: conflictPixels
      ? nearestSourceDistanceSum / conflictPixels
      : Infinity,
    offModelRatio: conflictPixels ? offModelPixels / conflictPixels : Infinity
  };
}

function coverage(raster) {
  return P.rasterStats(raster).coverage;
}

function isPolePixel(pixels, pixelIndex) {
  const offset = pixelIndex * 4;
  const red = pixels[offset];
  const green = pixels[offset + 1];
  const blue = pixels[offset + 2];
  return red >= 190 && green >= 175 && blue <= 90 &&
    Math.abs(red - green) <= 52 && Math.min(red, green) - blue >= 105;
}

function connectedComponents(mask, width, height) {
  const visited = new Uint8Array(mask.length);
  const components = [];
  const neighborOffsets = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0],             [1, 0],
    [-1, 1],  [0, 1],   [1, 1]
  ];

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    const queue = [start];
    const pixels = [];
    const occupiedRows = new Uint8Array(height);
    let queueIndex = 0;
    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;
    let rowCount = 0;

    visited[start] = 1;
    while (queueIndex < queue.length) {
      const index = queue[queueIndex++];
      const x = index % width;
      const y = Math.floor(index / width);
      pixels.push(index);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      if (!occupiedRows[y]) {
        occupiedRows[y] = 1;
        rowCount += 1;
      }

      for (const [dx, dy] of neighborOffsets) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const neighbor = ny * width + nx;
        if (!mask[neighbor] || visited[neighbor]) continue;
        visited[neighbor] = 1;
        queue.push(neighbor);
      }
    }

    components.push({
      pixels,
      area: pixels.length,
      minX,
      maxX,
      minY,
      maxY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
      rowCount,
      rowCoverage: rowCount / Math.max(1, maxY - minY + 1)
    });
  }

  components.sort((a, b) => b.area - a.area);
  return components;
}

function wrappedPixelDistance(a, b, width) {
  const direct = Math.abs(a - b);
  return Math.min(direct, width - direct);
}

function referencePole(raster, cameraOffsetMetres) {
  const apparentLongitudeDeg = POLE_LONGITUDE_DEG -
    Math.atan2(cameraOffsetMetres, FOREGROUND_DEPTH_METRES) * 180 / Math.PI;
  const expectedX = (
    (apparentLongitudeDeg % 360 + 360) % 360
  ) / 360 * raster.width;
  const horizontalHalfAngleDeg = Math.atan2(
    POLE_HALF_WIDTH_METRES,
    FOREGROUND_DEPTH_METRES
  ) * 180 / Math.PI;
  const verticalHalfAngleDeg = Math.atan2(
    POLE_HALF_HEIGHT_METRES,
    FOREGROUND_DEPTH_METRES
  ) * 180 / Math.PI;
  const xRadius = Math.max(
    3,
    Math.ceil((horizontalHalfAngleDeg + 1.5) / 360 * raster.width)
  );
  const yRadius = Math.max(
    4,
    Math.ceil((verticalHalfAngleDeg + 3) / 180 * raster.height)
  );
  const candidates = new Uint8Array(raster.weights.length);

  for (let y = 0; y < raster.height; y += 1) {
    if (Math.abs(y + 0.5 - raster.height / 2) > yRadius) continue;
    for (let x = 0; x < raster.width; x += 1) {
      if (wrappedPixelDistance(x + 0.5, expectedX, raster.width) > xRadius) {
        continue;
      }
      const index = y * raster.width + x;
      if (raster.weights[index] > 0.001 &&
          isPolePixel(raster.pixels, index)) {
        candidates[index] = 1;
      }
    }
  }

  const components = connectedComponents(
    candidates,
    raster.width,
    raster.height
  );
  const component = components[0] || null;
  const mask = new Uint8Array(raster.weights.length);
  if (component) {
    for (const index of component.pixels) mask[index] = 1;
  }
  return {
    cameraOffsetMetres,
    apparentLongitudeDeg,
    expectedX,
    mask,
    area: component ? component.area : 0,
    height: component ? component.height : 0,
    rowCount: component ? component.rowCount : 0,
    component
  };
}

function templateRetention(outputMask, reference) {
  let retainedPixels = 0;
  const referenceRows = new Uint8Array(PANO_HEIGHT);
  const retainedRows = new Uint8Array(PANO_HEIGHT);

  for (let index = 0; index < reference.mask.length; index += 1) {
    if (!reference.mask[index]) continue;
    const row = Math.floor(index / PANO_WIDTH);
    referenceRows[row] = 1;
    if (outputMask[index]) {
      retainedPixels += 1;
      retainedRows[row] = 1;
    }
  }

  let referenceRowCount = 0;
  let retainedRowCount = 0;
  let currentMissingRun = 0;
  let maxMissingRowRun = 0;
  for (let row = 0; row < PANO_HEIGHT; row += 1) {
    if (!referenceRows[row]) continue;
    referenceRowCount += 1;
    if (retainedRows[row]) {
      retainedRowCount += 1;
      currentMissingRun = 0;
    } else {
      currentMissingRun += 1;
      maxMissingRowRun = Math.max(maxMissingRowRun, currentMissingRun);
    }
  }

  const pixelRecall = reference.area
    ? retainedPixels / reference.area
    : 0;
  const rowRecall = referenceRowCount
    ? retainedRowCount / referenceRowCount
    : 0;
  return {
    retainedPixels,
    pixelRecall,
    retainedRows: retainedRowCount,
    referenceRows: referenceRowCount,
    rowRecall,
    maxMissingRowRun,
    complete: pixelRecall >= COMPLETE_PIXEL_RECALL &&
      rowRecall >= COMPLETE_ROW_RECALL &&
      maxMissingRowRun <= MAX_MISSING_ROW_RUN
  };
}

function poleIntegrityMetrics(output, references) {
  const outputMask = new Uint8Array(output.weights.length);
  let outputPolePixels = 0;
  for (let index = 0; index < outputMask.length; index += 1) {
    if (!(references[0].mask[index] || references[1].mask[index])) continue;
    if (output.weights[index] <= 0.001 ||
        !isPolePixel(output.pixels, index)) {
      continue;
    }
    outputMask[index] = 1;
    outputPolePixels += 1;
  }

  const retentions = references.map((reference) =>
    templateRetention(outputMask, reference));
  const completePoleCount = retentions.filter((item) => item.complete).length;
  const bestReferenceIndex = retentions[1].pixelRecall >
    retentions[0].pixelRecall ? 1 : 0;
  const bestReference = references[bestReferenceIndex];
  const bestRetention = retentions[bestReferenceIndex];
  let secondaryPixels = 0;
  for (let index = 0; index < outputMask.length; index += 1) {
    if (outputMask[index] && !bestReference.mask[index]) secondaryPixels += 1;
  }
  const secondaryPoleRatio = secondaryPixels /
    Math.max(1, bestReference.area);
  const components = connectedComponents(outputMask, output.width, output.height);
  const minimumReferenceArea = Math.max(
    1,
    Math.min(references[0].area, references[1].area)
  );
  const minimumReferenceHeight = Math.max(
    1,
    Math.min(references[0].height, references[1].height)
  );
  const significantComponents = components.filter((component) =>
    component.area >= minimumReferenceArea * 0.18 &&
    component.height >= minimumReferenceHeight * 0.3);
  const exactlyOneCompletePole = completePoleCount === 1 &&
    significantComponents.length === 1 &&
    secondaryPoleRatio <= MAX_SECONDARY_POLE_RATIO;
  let status = "partial-or-source-switched";
  if (outputPolePixels < minimumReferenceArea * 0.12) status = "missing";
  else if (completePoleCount >= 2) status = "double";
  else if (exactlyOneCompletePole) status = "exactly-one-complete";
  else if (significantComponents.length > 1) status = "fragmented-or-duplicated";

  return {
    status,
    exactlyOneCompletePole,
    completePoleCount,
    outputPolePixels,
    significantComponentCount: significantComponents.length,
    componentCount: components.length,
    components: components.map((component) => ({
      area: component.area,
      width: component.width,
      height: component.height,
      rowCoverage: component.rowCoverage,
      bounds: [
        component.minX,
        component.minY,
        component.maxX,
        component.maxY
      ]
    })),
    bestReferenceIndex,
    bestPixelRecall: bestRetention.pixelRecall,
    bestRowRecall: bestRetention.rowRecall,
    bestMaxMissingRowRun: bestRetention.maxMissingRowRun,
    secondaryPixels,
    secondaryPoleRatio,
    retentions
  };
}

const truth = S.createTruthPanorama(1024, 512);
const frames = [
  renderParallaxFrame(truth, 0, CAMERA_OFFSETS_METRES[0], FIXTURE_SEED),
  renderParallaxFrame(truth, 30, CAMERA_OFFSETS_METRES[1], FIXTURE_SEED + 1)
];
frames.forEach((frame, index) => {
  frame.frameIndex = index;
  frame.alignmentConfidence = index === 0 ? 1 : 0.98;
});

const sourceA = projectOne(frames[0]);
const sourceB = projectOne(frames[1]);
const referencePoles = [
  referencePole(sourceA, CAMERA_OFFSETS_METRES[0]),
  referencePole(sourceB, CAMERA_OFFSETS_METRES[1])
];
const baselineRaster = projectPair(P.projectPatch, frames);
const baselineMetrics = mixedConflictMetrics(
  baselineRaster,
  sourceA,
  sourceB
);
const baselineCoverage = coverage(baselineRaster);

ok(
  baselineMetrics.conflictPixels >= 120,
  "固定夹具生成了足够的双帧视差冲突像素",
  `conflict=${baselineMetrics.conflictPixels}`
);
ok(
  baselineMetrics.mixedConflictRatio >= 0.45 &&
    baselineMetrics.mixEntropy >= 0.45,
  "当前全重叠 feather 明显产生大面积中间色",
  `mixed=${round(baselineMetrics.mixedConflictRatio)}, ` +
    `entropy=${round(baselineMetrics.mixEntropy)}`
);

let seamAwareRaster = null;
let seamAwareMetrics = null;
let seamAwarePoleIntegrity = null;
let seamAwareCoverage = 0;
let coverageRatio = 0;
const seamAwareAvailable = typeof P.projectPatchSeamAware === "function";

if (seamAwareAvailable) {
  seamAwareRaster = projectPair(P.projectPatchSeamAware, frames);
  seamAwareMetrics = mixedConflictMetrics(
    seamAwareRaster,
    sourceA,
    sourceB
  );
  seamAwareCoverage = coverage(seamAwareRaster);
  seamAwarePoleIntegrity = poleIntegrityMetrics(
    seamAwareRaster,
    referencePoles
  );
  coverageRatio = baselineCoverage > 0
    ? seamAwareCoverage / baselineCoverage
    : 0;
  ok(
    seamAwareMetrics.mixedConflictRatio <= 0.12,
    "seam-aware 将冲突区混色限制在窄带",
    `mixed=${round(seamAwareMetrics.mixedConflictRatio)}`
  );
  ok(
    seamAwareMetrics.mixEntropy <= 0.15,
    "seam-aware 输出主要选择单一来源",
    `entropy=${round(seamAwareMetrics.mixEntropy)}`
  );
  ok(
    coverageRatio >= 0.995,
    "seam-aware 没有靠丢弃第二帧规避重影",
    `coverageRatio=${round(coverageRatio)}`
  );
  ok(
    seamAwarePoleIntegrity.exactlyOneCompletePole,
    "seam-aware 必须保留恰好一根完整前景杆，不能漏杆、双杆或断杆",
    `status=${seamAwarePoleIntegrity.status}, ` +
      `complete=${seamAwarePoleIntegrity.completePoleCount}, ` +
      `components=${seamAwarePoleIntegrity.significantComponentCount}, ` +
      `bestPixelRecall=${round(seamAwarePoleIntegrity.bestPixelRecall)}, ` +
      `bestRowRecall=${round(seamAwarePoleIntegrity.bestRowRecall)}, ` +
      `missingRun=${seamAwarePoleIntegrity.bestMaxMissingRowRun}, ` +
      `secondaryRatio=${round(seamAwarePoleIntegrity.secondaryPoleRatio)}`
  );
} else {
  ok(
    false,
    "P.projectPatchSeamAware API 已实现",
    "expected signature: (raster, pixels, width, height, basis, options)"
  );
}

const summary = {
  ok: failures.length === 0,
  seed: FIXTURE_SEED,
  fixture: {
    panorama: [PANO_WIDTH, PANO_HEIGHT],
    frame: [FRAME_WIDTH, FRAME_HEIGHT],
    fovXDeg: FOV_X_DEG,
    yawDeg: [0, 30],
    cameraOffsetMetres: CAMERA_OFFSETS_METRES,
    foregroundDepthMetres: FOREGROUND_DEPTH_METRES,
    expectedParallaxDeg: round(
      2 * Math.atan(
        Math.abs(CAMERA_OFFSETS_METRES[0]) / FOREGROUND_DEPTH_METRES
      ) * 180 / Math.PI,
      3
    ),
    referencePoles: referencePoles.map((reference) => ({
      cameraOffsetMetres: reference.cameraOffsetMetres,
      apparentLongitudeDeg: round(reference.apparentLongitudeDeg, 3),
      expectedX: round(reference.expectedX, 3),
      pixels: reference.area,
      height: reference.height,
      rows: reference.rowCount
    }))
  },
  thresholds: {
    conflictRgbDistance: CONFLICT_RGB_DISTANCE,
    baselineMixedMinimum: 0.45,
    baselineEntropyMinimum: 0.45,
    seamAwareMixedMaximum: 0.12,
    seamAwareEntropyMaximum: 0.15,
    seamAwareCoverageRatioMinimum: 0.995,
    completePolePixelRecallMinimum: COMPLETE_PIXEL_RECALL,
    completePoleRowRecallMinimum: COMPLETE_ROW_RECALL,
    completePoleMaximumMissingRowRun: MAX_MISSING_ROW_RUN,
    maximumSecondaryPoleRatio: MAX_SECONDARY_POLE_RATIO
  },
  baseline: Object.assign({}, baselineMetrics, {
    coverage: baselineCoverage
  }),
  seamAware: seamAwareMetrics && Object.assign({}, seamAwareMetrics, {
    coverage: seamAwareCoverage,
    coverageRatio,
    poleIntegrity: seamAwarePoleIntegrity
  }),
  seamAwareApiAvailable: seamAwareAvailable,
  failures
};

process.stdout.write("\n【JSON 摘要】\n");
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exitCode = failures.length ? 1 : 0;
