#!/usr/bin/env node
"use strict";

/*
 * Fixed-seed moving-subject regression for the shared Web/miniapp stitcher.
 *
 * Two adjacent photos observe:
 *   - the same infinitely distant spherical background;
 *   - camera centres translated by 6 cm;
 *   - one nearby person who moves across the expected source boundary.
 *
 * A centre-priority seam is tempted to retain the old person on the old
 * frame's side and the new person on the new frame's side.  "Non-black" and
 * low mixed-colour scores both pass in that broken result, so this fixture
 * explicitly measures duplicated people, silhouette completeness and
 * row-to-row outline wobble.
 */

const path = require("path");
const ROOT = path.dirname(__dirname);
const P = require(path.join(ROOT, "miniapp/utils/pano-core.js"));
const S = require("./pano_synthetic.js");

const PANO_WIDTH = 512;
const PANO_HEIGHT = 256;
const FRAME_WIDTH = 192;
const FRAME_HEIGHT = 256;
const FOV_X_DEG = 65;
const FRAME_YAWS_DEG = [0, 30];
const CAMERA_OFFSETS_METRES = [-0.03, 0.03];
const SUBJECT_LONGITUDES_DEG = [7, 23];
const SUBJECT_DEPTH_METRES = 1.35;
const SUBJECT_HALF_HEIGHT_METRES = 0.48;
const SUBJECT_TORSO_HALF_WIDTH_METRES = 0.105;
const SUBJECT_SEED = 0xd17a2026;

const failures = [];
const knownLimitations = [];

function check(condition, label, detail) {
  process.stdout.write(
    `${condition ? "✅" : "❌"} ${label}${detail ? "  " + detail : ""}\n`
  );
  if (!condition) failures.push(label);
}

function knownLimitation(condition, label, detail) {
  process.stdout.write(
    `${condition ? "✅" : "🟥"} ${label}${detail ? "  " + detail : ""}\n`
  );
  if (!condition) knownLimitations.push(label);
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

function renderDynamicFrame(
  truth,
  cameraYawDeg,
  cameraOffsetMetres,
  subjectLongitudeDeg,
  seed
) {
  const basis = P.orthonormalBasis(
    P.directionFromYawPitch(cameraYawDeg, 0),
    P.WORLD_UP
  );
  const frame = S.renderPerspective(
    P,
    truth,
    FRAME_WIDTH,
    FRAME_HEIGHT,
    basis,
    FOV_X_DEG
  );
  const planeNormal = P.directionFromYawPitch(subjectLongitudeDeg, 0);
  const tangent = P.normalize([
    Math.cos(subjectLongitudeDeg * Math.PI / 180),
    -Math.sin(subjectLongitudeDeg * Math.PI / 180),
    0
  ]);
  const cameraOrigin = scale(tangent, cameraOffsetMetres);
  const subjectCentre = scale(planeNormal, SUBJECT_DEPTH_METRES);
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
        subtract(subjectCentre, cameraOrigin),
        planeNormal
      ) / denominator;
      if (distance <= 0) continue;
      const hit = add(cameraOrigin, scale(direction, distance));
      const relative = subtract(hit, subjectCentre);
      const localX = P.dot(relative, tangent);
      const localY = relative[2];

      // A deterministic human-like silhouette: head, torso, arms and legs.
      const head = localX * localX +
        (localY - 0.37) * (localY - 0.37) <= 0.078 * 0.078;
      const torso = Math.abs(localX) <= SUBJECT_TORSO_HALF_WIDTH_METRES &&
        localY >= -0.16 && localY <= 0.30;
      const arms = Math.abs(localX) <= 0.19 &&
        localY >= 0.03 && localY <= 0.11;
      const leftLeg = localX >= -0.10 && localX <= -0.018 &&
        localY >= -SUBJECT_HALF_HEIGHT_METRES && localY < -0.16;
      const rightLeg = localX >= 0.018 && localX <= 0.10 &&
        localY >= -SUBJECT_HALF_HEIGHT_METRES && localY < -0.16;
      if (!(head || torso || arms || leftLeg || rightLeg)) continue;

      const pixel = (y * FRAME_WIDTH + x) * 4;
      // Deliberately uncommon chroma makes foreground integrity measurable
      // independently of the synthetic background.
      frame.pixels[pixel] = 250;
      frame.pixels[pixel + 1] = 18;
      frame.pixels[pixel + 2] = 244;
      frame.pixels[pixel + 3] = 255;
    }
  }

  const noisy = S.perturbPixels(frame, {
    seed,
    noise: 0.55
  });
  noisy.basis = basis;
  noisy.fovXDeg = FOV_X_DEG;
  return noisy;
}

function renderLargeTextureFrame(truth, cameraYawDeg, phase) {
  const basis = P.orthonormalBasis(
    P.directionFromYawPitch(cameraYawDeg, 0),
    P.WORLD_UP
  );
  const frame = S.renderPerspective(
    P,
    truth,
    FRAME_WIDTH,
    FRAME_HEIGHT,
    basis,
    FOV_X_DEG
  );
  for (let y = 0; y < FRAME_HEIGHT; y += 1) {
    for (let x = 0; x < FRAME_WIDTH; x += 1) {
      const checker = (
        Math.floor(x / 12) +
        Math.floor(y / 12) +
        phase
      ) % 2;
      const offset = (y * FRAME_WIDTH + x) * 4;
      frame.pixels[offset] = checker ? 238 : 28;
      frame.pixels[offset + 1] = checker ? 42 : 224;
      frame.pixels[offset + 2] = checker ? 32 : 232;
      frame.pixels[offset + 3] = 255;
    }
  }
  frame.basis = basis;
  frame.fovXDeg = FOV_X_DEG;
  return frame;
}

function renderWebDynamicFrame(index) {
  const width = 240;
  const height = 320;
  const trueBasis = P.orthonormalBasis(
    P.directionFromYawPitch(index * 30, 0),
    P.WORLD_UP
  );
  const pixels = new Uint8ClampedArray(width * height * 4);
  const aspect = width / height;
  const subjectLongitudeDeg = index === 0 ? 7 : 23;
  const subjectDirection = P.directionFromYawPitch(subjectLongitudeDeg, 0);
  const subjectLongitudeRad = subjectLongitudeDeg * Math.PI / 180;
  const subjectTangent = [
    Math.cos(subjectLongitudeRad),
    -Math.sin(subjectLongitudeRad),
    0
  ];
  const cameraOffset = index === 0 ? -0.03 : 0.03;
  const cameraOrigin = [
    subjectTangent[0] * cameraOffset,
    subjectTangent[1] * cameraOffset,
    0
  ];
  const subjectCentre = scale(subjectDirection, SUBJECT_DEPTH_METRES);
  for (let y = 0; y < height; y += 1) {
    const ny = 1 - (y + 0.5) / height * 2;
    for (let x = 0; x < width; x += 1) {
      const nx = (x + 0.5) / width * 2 - 1;
      const direction = P.directionFromImagePoint(
        nx,
        ny,
        trueBasis,
        FOV_X_DEG,
        aspect
      );
      let longitude = Math.atan2(direction[0], direction[1]);
      if (longitude < 0) longitude += Math.PI * 2;
      const latitude = Math.asin(P.clamp(direction[2], -1, 1));
      const lon01 = longitude / (Math.PI * 2);
      const lat01 = latitude / Math.PI + 0.5;
      const checker =
        (Math.floor(lon01 * 36) + Math.floor(lat01 * 18)) % 2;
      const lonGrid = Math.abs((lon01 * 12) % 1 - 0.5) > 0.455;
      const latGrid = Math.abs((lat01 * 9) % 1 - 0.5) > 0.455;
      const waveA =
        0.5 + 0.5 * Math.sin(longitude * 3 + latitude * 2.3);
      const waveB =
        0.5 + 0.5 * Math.cos(longitude * 5 - latitude * 3.1);
      const offset = (y * width + x) * 4;
      if (lonGrid || latGrid) {
        pixels[offset] = 238;
        pixels[offset + 1] = 242;
        pixels[offset + 2] = 232;
      } else {
        pixels[offset] = Math.round(
          36 + 150 * waveA + checker * 24
        );
        pixels[offset + 1] = Math.round(
          40 + 142 * waveB + (1 - checker) * 30
        );
        pixels[offset + 2] = Math.round(
          48 + 120 *
            (0.5 + 0.5 * Math.sin(longitude - latitude * 4)) +
            checker * 18
        );
      }
      const denominator = P.dot(direction, subjectDirection);
      if (denominator > 1e-6) {
        const distance = P.dot(
          subtract(subjectCentre, cameraOrigin),
          subjectDirection
        ) / denominator;
        if (distance > 0) {
          const hit = add(cameraOrigin, scale(direction, distance));
          const relative = subtract(hit, subjectCentre);
          const localX = P.dot(relative, subjectTangent);
          const localY = relative[2];
          const head = localX * localX +
            (localY - 0.37) * (localY - 0.37) <= 0.078 * 0.078;
          const torso = Math.abs(localX) <= 0.105 &&
            localY >= -0.16 && localY <= 0.30;
          const arms = Math.abs(localX) <= 0.19 &&
            localY >= 0.03 && localY <= 0.11;
          const leftLeg = localX >= -0.10 && localX <= -0.018 &&
            localY >= -0.48 && localY < -0.16;
          const rightLeg = localX >= 0.018 && localX <= 0.10 &&
            localY >= -0.48 && localY < -0.16;
          if (head || torso || arms || leftLeg || rightLeg) {
            pixels[offset] = 250;
            pixels[offset + 1] = 18;
            pixels[offset + 2] = 244;
          }
        }
      }
      pixels[offset + 3] = 255;
    }
  }
  return {
    width,
    height,
    pixels,
    basis: trueBasis,
    fovXDeg: FOV_X_DEG
  };
}

function projectOne(frame, frameIndex) {
  const raster = P.createRaster(PANO_WIDTH, PANO_HEIGHT);
  P.projectPatch(
    raster,
    frame.pixels,
    frame.width,
    frame.height,
    frame.basis,
    {
      fovXDeg: frame.fovXDeg,
      feather: 0.2,
      frameIndex,
      alignmentConfidence: frameIndex ? 0.98 : 1
    }
  );
  return raster;
}

function projectPair(projector, frames, options) {
  const raster = P.createRaster(PANO_WIDTH, PANO_HEIGHT);
  frames.forEach((frame, frameIndex) => {
    projector(
      raster,
      frame.pixels,
      frame.width,
      frame.height,
      frame.basis,
      Object.assign({
        fovXDeg: frame.fovXDeg,
        feather: 0.2,
        frameIndex,
        alignmentConfidence: frameIndex ? 0.98 : 1
      }, options || {})
    );
  });
  return raster;
}

function projectPreparedPair(frames) {
  const raster = P.createRaster(PANO_WIDTH, PANO_HEIGHT);
  frames.forEach((frame, frameIndex) => {
    P.projectPatchSeamAware(
      raster,
      frame.pixels,
      frame.width,
      frame.height,
      frame.correctedBasis || frame.basis,
      {
        fovXDeg: FOV_X_DEG,
        feather: 0.2,
        gain: frame.gain == null ? 1 : frame.gain,
        bias: frame.bias == null ? 0 : frame.bias,
        frameIndex,
        sourceConfidence: frame.sourceConfidence == null
          ? 1
          : frame.sourceConfidence,
        agreeThreshold: 12,
        autoExposure: true
      }
    );
  });
  return raster;
}

function resizeFrameNearest(frame, width, height, basis) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(
      frame.height - 1,
      Math.floor((y + 0.5) / height * frame.height)
    );
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(
        frame.width - 1,
        Math.floor((x + 0.5) / width * frame.width)
      );
      const source = (sourceY * frame.width + sourceX) * 4;
      const target = (y * width + x) * 4;
      pixels[target] = frame.pixels[source];
      pixels[target + 1] = frame.pixels[source + 1];
      pixels[target + 2] = frame.pixels[source + 2];
      pixels[target + 3] = 255;
    }
  }
  return {
    width,
    height,
    pixels,
    basis: P.copyBasis(basis),
    correctedBasis: P.copyBasis(basis),
    fovXDeg: FOV_X_DEG,
    correctedFovXDeg: FOV_X_DEG,
    gain: 1,
    bias: 0,
    accepted: true
  };
}

function productionVisualPoseWeight(alignment) {
  const minimumScore = 0.7;
  const confidence = P.clamp(
    Number(alignment && alignment.confidence) || 0,
    0,
    1
  );
  const score = Number(alignment && alignment.score);
  const scoreEvidence = Number.isFinite(score)
    ? P.clamp(
      (score - minimumScore) / Math.max(0.01, 1 - minimumScore),
      0,
      1
    )
    : 0;
  return P.clamp(
    0.12 + Math.min(confidence, scoreEvidence) * 0.72,
    0.12,
    0.84
  );
}

function isSubjectPixel(pixels, pixelIndex) {
  const offset = pixelIndex * 4;
  return pixels[offset] >= 215 &&
    pixels[offset + 1] <= 75 &&
    pixels[offset + 2] >= 205;
}

function foregroundMask(raster) {
  const mask = new Uint8Array(raster.weights.length);
  for (let index = 0; index < mask.length; index += 1) {
    if (raster.weights[index] > 0.001 &&
        isSubjectPixel(raster.pixels, index)) {
      mask[index] = 1;
    }
  }
  return mask;
}

function connectedComponents(mask, width, height) {
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const components = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    let head = 0;
    let tail = 1;
    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;
    const pixels = [];
    queue[0] = start;
    visited[start] = 1;
    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = Math.floor(index / width);
      pixels.push(index);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      const neighbors = [
        x > 0 ? index - 1 : -1,
        x + 1 < width ? index + 1 : -1,
        y > 0 ? index - width : -1,
        y + 1 < height ? index + width : -1
      ];
      for (const neighbor of neighbors) {
        if (neighbor < 0 || visited[neighbor] || !mask[neighbor]) continue;
        visited[neighbor] = 1;
        queue[tail++] = neighbor;
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
      height: maxY - minY + 1
    });
  }
  components.sort((a, b) => b.area - a.area);
  return components;
}

function maskIntersectionCount(a, b) {
  let count = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] && b[i]) count += 1;
  }
  return count;
}

function maskCount(mask) {
  let count = 0;
  for (const value of mask) count += value ? 1 : 0;
  return count;
}

function maskBounds(mask) {
  let minX = PANO_WIDTH;
  let maxX = -1;
  let minY = PANO_HEIGHT;
  let maxY = -1;
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    const x = index % PANO_WIDTH;
    const y = Math.floor(index / PANO_WIDTH);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return maxX >= 0 ? {
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    centerX: (minX + maxX) / 2
  } : null;
}

function maxMissingRowRun(outputMask, referenceMask) {
  let current = 0;
  let maximum = 0;
  for (let y = 0; y < PANO_HEIGHT; y += 1) {
    let referenceHas = false;
    let outputHas = false;
    for (let x = 0; x < PANO_WIDTH; x += 1) {
      const index = y * PANO_WIDTH + x;
      if (referenceMask[index]) referenceHas = true;
      if (referenceMask[index] && outputMask[index]) outputHas = true;
    }
    if (!referenceHas) continue;
    if (outputHas) current = 0;
    else {
      current += 1;
      maximum = Math.max(maximum, current);
    }
  }
  return maximum;
}

function outlineWobbleP95(mask) {
  const centers = [];
  for (let y = 0; y < PANO_HEIGHT; y += 1) {
    let minX = PANO_WIDTH;
    let maxX = -1;
    for (let x = 0; x < PANO_WIDTH; x += 1) {
      if (!mask[y * PANO_WIDTH + x]) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    }
    if (maxX >= 0) centers.push({ y, center: (minX + maxX) / 2 });
  }
  const jumps = [];
  for (let i = 1; i < centers.length; i += 1) {
    if (centers[i].y !== centers[i - 1].y + 1) continue;
    jumps.push(Math.abs(centers[i].center - centers[i - 1].center));
  }
  jumps.sort((a, b) => a - b);
  return jumps.length ? jumps[Math.floor((jumps.length - 1) * 0.95)] : Infinity;
}

function integrityMetrics(output, references) {
  const outputMask = foregroundMask(output);
  const referenceBounds = references.map(maskBounds);
  const envelope = {
    minX: Math.max(0, Math.min(...referenceBounds.map((item) => item.minX)) - 16),
    maxX: Math.min(
      PANO_WIDTH - 1,
      Math.max(...referenceBounds.map((item) => item.maxX)) + 16
    ),
    minY: Math.max(0, Math.min(...referenceBounds.map((item) => item.minY)) - 8),
    maxY: Math.min(
      PANO_HEIGHT - 1,
      Math.max(...referenceBounds.map((item) => item.maxY)) + 8
    )
  };
  // The synthetic truth can contain a coincidentally magenta pixel in the
  // other side of the 360° raster.  Metrics are deliberately scoped to the
  // union of the two known subject projections, not to unrelated background.
  for (let index = 0; index < outputMask.length; index += 1) {
    const x = index % PANO_WIDTH;
    const y = Math.floor(index / PANO_WIDTH);
    if (x < envelope.minX || x > envelope.maxX ||
        y < envelope.minY || y > envelope.maxY) {
      outputMask[index] = 0;
    }
  }
  const outputArea = maskCount(outputMask);
  const outputBounds = maskBounds(outputMask);
  const referenceAreas = references.map(maskCount);
  const retentions = references.map((reference, index) => ({
    index,
    retained: maskIntersectionCount(outputMask, reference),
    recall: maskIntersectionCount(outputMask, reference) /
      Math.max(1, referenceAreas[index]),
    missingRowRun: maxMissingRowRun(outputMask, reference)
  }));
  retentions.sort((a, b) => b.recall - a.recall);
  const best = retentions[0];
  let secondary = 0;
  for (let i = 0; i < outputMask.length; i += 1) {
    if (outputMask[i] && !references[best.index][i]) secondary += 1;
  }
  const components = connectedComponents(outputMask, PANO_WIDTH, PANO_HEIGHT)
    .filter((component) =>
      component.area >= Math.min(...referenceAreas) * 0.16 &&
      component.height >= 18);
  return {
    outputMask,
    outputArea,
    referenceAreas,
    bestReferenceIndex: best.index,
    bestRecall: best.recall,
    bestMissingRowRun: best.missingRowRun,
    secondaryPixels: secondary,
    secondaryRatio: secondary / Math.max(1, referenceAreas[best.index]),
    significantComponents: components.length,
    outputBounds,
    referenceBounds,
    widthInflation: components.length
      ? components[0].width /
        Math.max(1, referenceBounds[best.index].width)
      : 0,
    componentBounds: components.map((component) => [
      component.minX,
      component.minY,
      component.maxX,
      component.maxY
    ]),
    outlineWobbleP95: outlineWobbleP95(outputMask)
  };
}

const truth = S.createTruthPanorama(1024, 512);
const frames = FRAME_YAWS_DEG.map((yawDeg, index) =>
  renderDynamicFrame(
    truth,
    yawDeg,
    CAMERA_OFFSETS_METRES[index],
    SUBJECT_LONGITUDES_DEG[index],
    SUBJECT_SEED + index
  )
);
const sources = frames.map(projectOne);
const sourceMasks = sources.map(foregroundMask);
const sourceComponents = sourceMasks.map((mask) =>
  connectedComponents(mask, PANO_WIDTH, PANO_HEIGHT)[0]);

check(
  sourceComponents.every((component) => component && component.area >= 180),
  "两帧都包含可测的完整人物",
  `areas=${sourceComponents.map((component) => component && component.area).join("/")}`
);
check(
  Math.abs(
    (sourceComponents[1].minX + sourceComponents[1].maxX) / 2 -
    (sourceComponents[0].minX + sourceComponents[0].maxX) / 2
  ) >= 16,
  "人物移动与 6 cm 相机横移产生两个明显错位投影",
  `centreDelta=${round(Math.abs(
    (sourceComponents[1].minX + sourceComponents[1].maxX) / 2 -
    (sourceComponents[0].minX + sourceComponents[0].maxX) / 2
  ))}px`
);

const feather = projectPair(P.projectPatch, frames);
const legacySeamAware = projectPair(P.projectPatchSeamAware, frames, {
  seamMotionBridgeMaxCells: 0
});
const seamAware = projectPair(P.projectPatchSeamAware, frames, {
  seamProtectRadius: process.env.DYNAMIC_SEAM_PROTECT_RADIUS == null
    ? undefined
    : Number(process.env.DYNAMIC_SEAM_PROTECT_RADIUS)
});
const featherMetrics = integrityMetrics(feather, sourceMasks);
const legacySeamMetrics = integrityMetrics(legacySeamAware, sourceMasks);
const seamMetrics = integrityMetrics(seamAware, sourceMasks);

/*
 * Joint Web addFrame fixture: frame one is the visual anchor; frame two uses
 * the exact deterministic noisy-IMU formula from web/pano-capture.js, then
 * refineFramePoseFromReferences + production visualPoseWeight before stitch.
 */
const productionAlignmentOptions = {
  maxCorrectionDeg: 5,
  maxRollDeg: 3,
  maxFovCorrectionDeg: 6,
  minOverlapRatio: 0.08,
  minScore: 0.7,
  targetSamples: 420,
  maxReferences: 6,
  maxReferenceAngleDeg: 78,
  imuPriorWeight: 0.06
};
const webSyntheticFrames = [
  renderWebDynamicFrame(0),
  renderWebDynamicFrame(1)
];
const webSourceMasks = webSyntheticFrames
  .map((frame, index) => foregroundMask(projectOne(frame, index)));
const webPoseErrors = {
  yaw: Math.sin(1.73) * 0.8,
  pitch: Math.cos(1.11) * 0.45,
  roll: Math.sin(0.77) * 0.3
};
const webNoisyImuBasis = P.rotateBasisLocal(
  webSyntheticFrames[1].basis,
  webPoseErrors.yaw,
  webPoseErrors.pitch,
  webPoseErrors.roll
);
const webAnchor = resizeFrameNearest(
  webSyntheticFrames[0],
  180,
  240,
  webSyntheticFrames[0].basis
);
webAnchor.frameIndex = 0;
const webSecond = resizeFrameNearest(
  webSyntheticFrames[1],
  180,
  240,
  webNoisyImuBasis
);
webSecond.frameIndex = 1;
const webAlignment = P.refineFramePoseFromReferences(
  [webAnchor],
  webSecond,
  productionAlignmentOptions
);
const webAppliedPoseWeight = webAlignment.accepted
  ? productionVisualPoseWeight(webAlignment)
  : 0;
const webCorrectedBasis = webAlignment.accepted
  ? P.blendBasis(
    webNoisyImuBasis,
    webAlignment.correctedBasis,
    webAppliedPoseWeight
  )
  : P.copyBasis(webNoisyImuBasis);
const webPreparedFrames = [
  Object.assign({}, webSyntheticFrames[0], {
    correctedBasis: P.copyBasis(webSyntheticFrames[0].basis),
    gain: 1,
    bias: 0,
    sourceConfidence: 1
  }),
  Object.assign({}, webSyntheticFrames[1], {
    basis: webNoisyImuBasis,
    correctedBasis: webCorrectedBasis,
    gain: webAlignment.accepted ? webAlignment.gain : 1,
    bias: webAlignment.accepted ? webAlignment.bias : 0,
    sourceConfidence: webAlignment.accepted
      ? webAlignment.confidence
      : 0.2
  })
];
const webJointRaster = projectPreparedPair(webPreparedFrames);
const webJointMetrics = integrityMetrics(webJointRaster, webSourceMasks);

check(
  featherMetrics.outputArea <= Math.min(...featherMetrics.referenceAreas) * 0.2 ||
    featherMetrics.secondaryRatio > 0.35,
  "传统全重叠 feather 会把动态人物混淡或形成双影",
  `recognisable=${featherMetrics.outputArea}px, ` +
    `secondary=${round(featherMetrics.secondaryRatio)}`
);
check(
  legacySeamMetrics.secondaryRatio >= 0.8 &&
    legacySeamMetrics.widthInflation >= 1.7,
  "旧 centre-priority seam 的确定性红灯被保留",
  `secondary=${round(legacySeamMetrics.secondaryRatio)}, ` +
    `widthInflation=${round(legacySeamMetrics.widthInflation)}`
);
check(
  webAlignment.accepted,
  "联合夹具消费 production robust block pose，而非退回 IMU",
  `score=${round(webAlignment.score)}, ` +
    `confidence=${round(webAlignment.confidence)}, ` +
    `weight=${round(webAppliedPoseWeight)}`
);
check(
  webJointMetrics.bestRecall >= 0.88 &&
    webJointMetrics.secondaryRatio <= 0.15 &&
    webJointMetrics.significantComponents === 1 &&
    webJointMetrics.widthInflation <= 1.25 &&
    webJointRaster.lastSeamStats.motionSeamBridges >= 1,
  "Web addFrame 联合链路只保留一个完整人物时刻",
  `recall=${round(webJointMetrics.bestRecall)}, ` +
    `secondary=${round(webJointMetrics.secondaryRatio)}, ` +
    `components=${webJointMetrics.significantComponents}, ` +
    `width=${round(webJointMetrics.widthInflation)}, ` +
    `bridges=${webJointRaster.lastSeamStats.motionSeamBridges}`
);
check(
  seamMetrics.bestRecall >= 0.88,
  "动态场景保留一份完整人物",
  `recall=${round(seamMetrics.bestRecall)}, missingRun=${seamMetrics.bestMissingRowRun}`
);
check(
  seamMetrics.secondaryRatio <= 0.15 &&
    seamMetrics.significantComponents === 1 &&
    seamMetrics.widthInflation <= 1.25,
  "动态场景不能同时保留人物的两个时刻",
  `secondary=${round(seamMetrics.secondaryRatio)}, ` +
    `components=${seamMetrics.significantComponents}, ` +
    `widthInflation=${round(seamMetrics.widthInflation)}`
);
check(
  seamMetrics.outlineWobbleP95 <= 2.5,
  "人物轮廓逐行连续，没有来源切换造成的接缝跳变",
  `p95=${round(seamMetrics.outlineWobbleP95)}px`
);

// Negative control: a large, repetitive, frame-wide disagreement is not a
// bounded moving foreground.  It must stay out of the temporal bridge path;
// otherwise a false positive could overwrite a large part of the panorama.
const largeTextureFrames = FRAME_YAWS_DEG.map((yawDeg, index) =>
  renderLargeTextureFrame(truth, yawDeg, index)
);
const largeTextureResult = projectPair(
  P.projectPatchSeamAware,
  largeTextureFrames
);
check(
  largeTextureResult.lastSeamStats.motionSeamBridges === 0,
  "大面积重复纹理负控不会被误判为移动人物",
  `bridges=${largeTextureResult.lastSeamStats.motionSeamBridges}, ` +
    `conflicts=${largeTextureResult.lastSeamStats.conflictPixels}`
);

// Ten deterministic motion/hand-translation combinations prevent the single
// showcase fixture from overfitting one displacement.
const motionSweepInputs = [
  [4, 0.00],
  [6, 0.02],
  [8, 0.04],
  [10, 0.06],
  [12, 0.02],
  [14, 0.04],
  [16, 0.06],
  [18, 0.08],
  [20, 0.04],
  [22, 0.08]
];
const motionSweep = motionSweepInputs.map(([subjectMotionDeg, translation]) => {
  const sweepYawsDeg = [30, 60];
  const longitudes = [
    45 - subjectMotionDeg / 2,
    45 + subjectMotionDeg / 2
  ];
  const offsets = [-translation / 2, translation / 2];
  const sweepFrames = sweepYawsDeg.map((yawDeg, index) =>
    renderDynamicFrame(
      truth,
      yawDeg,
      offsets[index],
      longitudes[index],
      SUBJECT_SEED + 100 + index +
        Math.round(subjectMotionDeg * 13 + translation * 1000)
    )
  );
  const sweepSourceMasks = sweepFrames.map((frame, index) =>
    foregroundMask(projectOne(frame, index))
  );
  const result = projectPair(P.projectPatchSeamAware, sweepFrames);
  const metrics = integrityMetrics(result, sweepSourceMasks);
  return {
    subjectMotionDeg,
    cameraTranslationMetres: translation,
    bestRecall: metrics.bestRecall,
    secondaryRatio: metrics.secondaryRatio,
    widthInflation: metrics.widthInflation,
    outlineWobbleP95: metrics.outlineWobbleP95,
    bridges: result.lastSeamStats.motionSeamBridges,
    passed: metrics.bestRecall >= 0.84 &&
      metrics.secondaryRatio <= 0.18 &&
      metrics.widthInflation <= 1.3 &&
      metrics.outlineWobbleP95 <= 2.5
  };
});
check(
  motionSweep.every((item) => item.passed),
  "10 组人物移动与手持平移扫参均只保留一个连续时刻",
  motionSweep.map((item) =>
    `${item.subjectMotionDeg}°/${Math.round(
      item.cameraTranslationMetres * 100
    )}cm:${item.passed ? "ok" : "fail"}`).join(", ")
);

// Moving foreground must not drag visual pose away from the static far-field.
const poseTruth = P.copyBasis(frames[1].basis);
const poseProbeBasis = P.rotateBasisLocal(poseTruth, 2.4, -1.2, 0.7);
const poseReference = {
  width: frames[0].width,
  height: frames[0].height,
  pixels: frames[0].pixels,
  basis: P.copyBasis(frames[0].basis),
  correctedBasis: P.copyBasis(frames[0].basis),
  fovXDeg: FOV_X_DEG,
  correctedFovXDeg: FOV_X_DEG,
  gain: 1,
  bias: 0
};
const poseProbe = {
  width: frames[1].width,
  height: frames[1].height,
  pixels: frames[1].pixels,
  basis: poseProbeBasis,
  correctedBasis: poseProbeBasis,
  fovXDeg: FOV_X_DEG,
  correctedFovXDeg: FOV_X_DEG,
  gain: 1,
  bias: 0
};
const poseBeforeError = P.basisRotationErrorDeg(
  poseProbeBasis,
  poseTruth
);
const movingForegroundAlignment = P.refineFramePose(
  poseReference,
  poseProbe,
  {
    maxCorrectionDeg: 6,
    maxRollDeg: 4,
    maxFovCorrectionDeg: 3,
    minOverlapRatio: 0.08,
    minScore: 0.67,
    targetSamples: 900,
    imuPriorWeight: 0.035
  }
);
const poseAfterError = P.basisRotationErrorDeg(
  movingForegroundAlignment.correctedBasis,
  poseTruth
);
knownLimitation(
  movingForegroundAlignment.accepted &&
    poseAfterError <= 1 &&
    poseAfterError < poseBeforeError * 0.45,
  "移动人物不会把静态远景主导的视觉姿态拖偏",
  `accepted=${movingForegroundAlignment.accepted}, ` +
    `score=${round(movingForegroundAlignment.score)}, ` +
    `${round(poseBeforeError)}°→${round(poseAfterError)}°`
);

const summary = {
  ok: failures.length === 0,
  fixture: {
    panorama: [PANO_WIDTH, PANO_HEIGHT],
    frame: [FRAME_WIDTH, FRAME_HEIGHT],
    frameYawsDeg: FRAME_YAWS_DEG,
    cameraOffsetsMetres: CAMERA_OFFSETS_METRES,
    cameraTranslationMetres:
      CAMERA_OFFSETS_METRES[1] - CAMERA_OFFSETS_METRES[0],
    subjectLongitudesDeg: SUBJECT_LONGITUDES_DEG,
    subjectMotionDeg:
      SUBJECT_LONGITUDES_DEG[1] - SUBJECT_LONGITUDES_DEG[0],
    subjectDepthMetres: SUBJECT_DEPTH_METRES,
    sourceBounds: sourceComponents.map((component) => [
      component.minX,
      component.minY,
      component.maxX,
      component.maxY
    ])
  },
  thresholds: {
    bestRecallMinimum: 0.88,
    secondaryRatioMaximum: 0.15,
    significantComponentsMaximum: 1,
    widthInflationMaximum: 1.25,
    outlineWobbleP95MaximumPx: 2.5
  },
  feather: Object.assign({}, featherMetrics, { outputMask: undefined }),
  legacySeamAware: Object.assign({}, legacySeamMetrics, {
    outputMask: undefined
  }),
  seamAware: Object.assign({}, seamMetrics, { outputMask: undefined }),
  webAddFrameJoint: {
    alignment: {
      accepted: webAlignment.accepted,
      score: webAlignment.score,
      confidence: webAlignment.confidence,
      correction: webAlignment.correction,
      appliedPoseWeight: webAppliedPoseWeight,
      robustBlockCount: webAlignment.robustBlockCount,
      rejectedBlockCount: webAlignment.rejectedBlockCount
    },
    correctedPoseErrorDeg: P.basisRotationErrorDeg(
      webCorrectedBasis,
      webSyntheticFrames[1].basis
    ),
    metrics: Object.assign({}, webJointMetrics, {
      outputMask: undefined
    }),
    seamStats: webJointRaster.lastSeamStats
  },
  seamSummary: seamAware.seamSummary,
  lastSeamStats: seamAware.lastSeamStats,
  largeTextureNegativeControl: {
    motionSeamBridges:
      largeTextureResult.lastSeamStats.motionSeamBridges,
    motionSeamCoreCells:
      largeTextureResult.lastSeamStats.motionSeamCoreCells,
    diagnostics:
      largeTextureResult.lastSeamStats.motionSeamBridgeDiagnostics,
    conflictPixels: largeTextureResult.lastSeamStats.conflictPixels,
    coverage: P.rasterStats(largeTextureResult).coverage
  },
  motionSweep,
  movingForegroundPose: {
    accepted: movingForegroundAlignment.accepted,
    rejectReason: movingForegroundAlignment.rejectReason,
    score: movingForegroundAlignment.score,
    globalScore: movingForegroundAlignment.globalScore,
    correction: movingForegroundAlignment.correction,
    robustBlockCount: movingForegroundAlignment.robustBlockCount,
    rejectedBlockCount: movingForegroundAlignment.rejectedBlockCount,
    overlapRatio: movingForegroundAlignment.overlapRatio,
    beforeErrorDeg: poseBeforeError,
    afterErrorDeg: poseAfterError
  },
  knownLimitations,
  failures
};

process.stdout.write("\n【JSON 摘要】\n");
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exitCode = failures.length ? 1 : 0;
