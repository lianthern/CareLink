#!/usr/bin/env node
"use strict";

/*
 * Deterministic regression for the horizontal video-sweep core.
 *
 * The fixture renders a perspective video stream from a cylindrical ground
 * truth, adds frame-to-frame exposure changes and a finite-depth foreground
 * marker, and feeds frames in both directions. It intentionally tests the
 * capture gates separately so a rendering metric cannot hide a UX regression.
 */

const path = require("path");
const ROOT = path.dirname(__dirname);
const Sweep = require(path.join(ROOT, "miniapp/utils/pano-sweep-core.js"));

const failures = [];

function check(condition, label, detail) {
  process.stdout.write(
    `${condition ? "✅" : "❌"} ${label}${detail ? "  " + detail : ""}\n`
  );
  if (!condition) failures.push(label);
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function median(values) {
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  const middle = values.length >> 1;
  return values.length % 2
    ? values[middle]
    : (values[middle - 1] + values[middle]) * 0.5;
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  return values[Math.floor((values.length - 1) * fraction)];
}

function shortestDelta(from, to) {
  return ((to - from) % 360 + 540) % 360 - 180;
}

function basisFromPose(yawDeg, pitchDeg, rollDeg) {
  const yaw = yawDeg * Math.PI / 180;
  const pitch = pitchDeg * Math.PI / 180;
  const roll = rollDeg * Math.PI / 180;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const forward = [Math.sin(yaw) * cp, Math.cos(yaw) * cp, sp];
  const right0 = [Math.cos(yaw), -Math.sin(yaw), 0];
  const up0 = [-Math.sin(yaw) * sp, -Math.cos(yaw) * sp, cp];
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  return {
    F: forward,
    R: [
      right0[0] * cr - up0[0] * sr,
      right0[1] * cr - up0[1] * sr,
      right0[2] * cr - up0[2] * sr
    ],
    U: [
      up0[0] * cr + right0[0] * sr,
      up0[1] * cr + right0[1] * sr,
      up0[2] * cr + right0[2] * sr
    ]
  };
}

function normalise(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function sceneColour(worldYawDeg, vertical, cameraYawDeg, movingOffsetDeg) {
  const yaw = ((worldYawDeg % 360) + 360) % 360;
  const broad = 0.5 + 0.5 * Math.sin(yaw * Math.PI / 45);
  const fine = 0.5 + 0.5 * Math.sin(yaw * Math.PI / 6.5);
  const verticalTone = 0.5 + 0.5 * Math.cos(vertical * 9);
  let r = 42 + broad * 72 + verticalTone * 34;
  let g = 58 + fine * 58 + verticalTone * 45;
  let b = 75 + broad * 38 + fine * 31;

  // Fixed distant landmarks exercise geometric alignment.
  for (const marker of [12, 34, 57]) {
    if (Math.abs(shortestDelta(marker, worldYawDeg)) < 0.8) {
      r = 242;
      g = 232;
      b = 52;
    }
  }
  // Asymmetric end markers catch an RTL result that is geometrically valid
  // but horizontally mirrored.
  if (Math.abs(shortestDelta(-72, worldYawDeg)) < 2.4) {
    r = 244;
    g = 38;
    b = 28;
  }
  if (Math.abs(shortestDelta(72, worldYawDeg)) < 2.4) {
    r = 22;
    g = 72;
    b = 244;
  }

  /*
   * A finite-depth magenta post. Its apparent longitude moves slightly with
   * camera centre, and a second cyan object moves independently. Both remain
   * high-frequency single-source content; exposure correction must not average
   * their colours into the background.
   */
  const parallaxLongitude = 27 + (cameraYawDeg - 27) * 0.10;
  if (Math.abs(shortestDelta(parallaxLongitude, worldYawDeg)) < 0.75 &&
      Math.abs(vertical) < 0.45) {
    r = 246;
    g = 30;
    b = 218;
  }
  const movingLongitude = 46 + movingOffsetDeg;
  if (Math.abs(shortestDelta(movingLongitude, worldYawDeg)) < 0.55 &&
      vertical > -0.35 && vertical < 0.1) {
    r = 18;
    g = 224;
    b = 238;
  }
  return [r, g, b];
}

function renderFrame({
  yawDeg,
  pitchDeg = 0,
  rollDeg = 0,
  exposure = 1,
  movingOffsetDeg = 0,
  width = 176,
  height = 132,
  fovXDeg = 65
}) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const basis = basisFromPose(yawDeg, pitchDeg, rollDeg);
  const tanX = Math.tan(fovXDeg * Math.PI / 360);
  const tanY = tanX / (width / height);
  for (let y = 0; y < height; y += 1) {
    const ny = 1 - (y + 0.5) / height * 2;
    for (let x = 0; x < width; x += 1) {
      const nx = (x + 0.5) / width * 2 - 1;
      const direction = normalise([
        basis.F[0] + basis.R[0] * nx * tanX + basis.U[0] * ny * tanY,
        basis.F[1] + basis.R[1] * nx * tanX + basis.U[1] * ny * tanY,
        basis.F[2] + basis.R[2] * nx * tanX + basis.U[2] * ny * tanY
      ]);
      const worldYaw = Math.atan2(direction[0], direction[1]) * 180 / Math.PI;
      const horizontal = Math.hypot(direction[0], direction[1]) || 1;
      const vertical = direction[2] / horizontal;
      const colour = sceneColour(
        worldYaw,
        vertical,
        yawDeg,
        movingOffsetDeg
      );
      const vignette = 1 - 0.07 * (nx * nx + ny * ny);
      const offset = (y * width + x) * 4;
      pixels[offset] = clamp(Math.round(colour[0] * exposure * vignette), 0, 255);
      pixels[offset + 1] = clamp(
        Math.round(colour[1] * exposure * vignette),
        0,
        255
      );
      pixels[offset + 2] = clamp(
        Math.round(colour[2] * exposure * vignette),
        0,
        255
      );
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

function runSweep(direction, initialFovXDeg) {
  const fovXDeg = 65;
  const session = Sweep.createSweepSession({
    targetSpanDeg: 60,
    minSpanDeg: 45,
    maxSpanDeg: 180,
    fovXDeg: initialFovXDeg || fovXDeg,
    outputHeight: 256,
    maxOutputWidth: 1200,
    keyframeStepDeg: 6,
    ownerMap: true
  });
  const decisions = [];
  const stepDeg = 3;
  const frameIntervalMs = 250; // 12 degrees/second
  for (let progress = 0; progress <= 60; progress += stepDeg) {
    const yawDeg = direction * progress;
    const pitchDeg = Math.sin(progress * Math.PI / 22) * 2.6;
    const rollDeg = Math.sin(progress * Math.PI / 17) * 3.8;
    const exposure = 0.84 + 0.22 * (0.5 + 0.5 *
      Math.sin(progress * Math.PI / 19));
    const pixels = renderFrame({
      yawDeg,
      pitchDeg,
      rollDeg,
      exposure,
      movingOffsetDeg: Math.sin(progress * Math.PI / 13) * 0.45,
      fovXDeg
    });
    decisions.push(Sweep.ingestFrame(session, {
      rgba: pixels,
      width: 176,
      height: 132,
      timeMs: progress / stepDeg * frameIntervalMs,
      yawDeg,
      pitchDeg,
      rollDeg,
      visualDx: -direction *
        Math.tan(stepDeg * Math.PI / 180) /
        (2 * Math.tan(fovXDeg * Math.PI / 360)) * 64,
      visualDy: 0,
      confidence: 0.88
    }));
  }
  const result = Sweep.finalizeSweep(session);
  return { session, result, decisions };
}

function testFovCalibration() {
  const { session, result } = runSweep(1, 50);
  const estimated = result.diagnostics.estimatedFovXDeg;
  const seam = seamBrightnessP95(result);
  check(estimated >= 62 && estimated <= 68,
    "session calibrates a wrong initial FOV from IMU + flow",
    `initial=50, estimated=${estimated.toFixed(2)}`);
  check(seam.p95 < 12,
    "FOV calibration keeps wrong-initial-FOV seams controlled",
    `p95=${seam.p95.toFixed(3)}`);
  Sweep.releaseSweepSession(session);
}

function testVisualPitchFlow() {
  const width = 176;
  const height = 132;
  const first = renderFrame({
    yawDeg: 0,
    pitchDeg: 0,
    width,
    height,
    fovXDeg: 65
  });
  const second = renderFrame({
    yawDeg: 4,
    pitchDeg: 2,
    width,
    height,
    fovXDeg: 65
  });
  const firstThumb = Sweep.makeLumaThumbnail(first, width, height, {
    width: 96
  });
  const secondThumb = Sweep.makeLumaThumbnail(second, width, height, {
    width: 96
  });
  const flow = Sweep.estimateGridFlow(firstThumb, secondThumb, {
    gridX: 8,
    gridY: 5,
    searchRadius: 12,
    patchRadius: 3
  });
  check(flow.centralDy > 1,
    "visual flow has the same sign as positive camera pitch",
    `centralDy=${flow.centralDy.toFixed(3)}, confidence=${flow.confidence.toFixed(3)}`);
}

function columnMedianLuma(result, x) {
  const values = [];
  for (let y = 4; y < result.height - 4; y += 3) {
    const offset = (y * result.width + x) * 4;
    if (!result.pixels[offset + 3]) continue;
    values.push(
      result.pixels[offset] * 0.299 +
      result.pixels[offset + 1] * 0.587 +
      result.pixels[offset + 2] * 0.114
    );
  }
  return median(values);
}

function seamBrightnessP95(result) {
  const jumps = [];
  let previousOwner = result.ownerMap[
    Math.floor(result.height / 2) * result.width
  ];
  for (let x = 1; x < result.width; x += 1) {
    const owner = result.ownerMap[
      Math.floor(result.height / 2) * result.width + x
    ];
    if (owner !== previousOwner && owner >= 0 && previousOwner >= 0) {
      const left = median([
        columnMedianLuma(result, Math.max(0, x - 3)),
        columnMedianLuma(result, Math.max(0, x - 2)),
        columnMedianLuma(result, x - 1)
      ]);
      const right = median([
        columnMedianLuma(result, x),
        columnMedianLuma(result, Math.min(result.width - 1, x + 1)),
        columnMedianLuma(result, Math.min(result.width - 1, x + 2))
      ]);
      jumps.push(Math.abs(right - left));
    }
    previousOwner = owner;
  }
  return { p95: percentile(jumps, 0.95), jumps };
}

function countMagentaComponents(result) {
  const mask = new Uint8Array(result.width * result.height);
  for (let index = 0; index < mask.length; index += 1) {
    const offset = index * 4;
    const r = result.pixels[offset];
    const g = result.pixels[offset + 1];
    const b = result.pixels[offset + 2];
    if (r > 185 && b > 155 && g < 105) mask[index] = 1;
  }
  const visited = new Uint8Array(mask.length);
  const components = [];
  const queue = [];
  for (let y = 1; y < result.height - 1; y += 1) {
    for (let x = 1; x < result.width - 1; x += 1) {
      const start = y * result.width + x;
      if (!mask[start] || visited[start]) continue;
      visited[start] = 1;
      queue.length = 0;
      queue.push(start);
      let count = 0;
      while (queue.length) {
        const index = queue.pop();
        count += 1;
        const xx = index % result.width;
        const yy = Math.floor(index / result.width);
        const neighbours = [
          index - 1,
          index + 1,
          index - result.width,
          index + result.width
        ];
        for (const neighbour of neighbours) {
          const nx = neighbour % result.width;
          const ny = Math.floor(neighbour / result.width);
          if (nx < 0 || nx >= result.width || ny < 0 || ny >= result.height) {
            continue;
          }
          if (Math.abs(nx - xx) + Math.abs(ny - yy) !== 1) continue;
          if (mask[neighbour] && !visited[neighbour]) {
            visited[neighbour] = 1;
            queue.push(neighbour);
          }
        }
      }
      if (count >= 12) components.push(count);
    }
  }
  return components;
}

function colourCentroidX(result, predicate) {
  let weightedX = 0;
  let count = 0;
  for (let y = 0; y < result.height; y += 2) {
    for (let x = 0; x < result.width; x += 1) {
      const offset = (y * result.width + x) * 4;
      if (!predicate(
        result.pixels[offset],
        result.pixels[offset + 1],
        result.pixels[offset + 2]
      )) continue;
      weightedX += x;
      count += 1;
    }
  }
  return count ? weightedX / count : -1;
}

function testGridFlow() {
  const width = 96;
  const height = 64;
  const previous = new Uint8ClampedArray(width * height * 4);
  const current = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = (x * 17 + y * 29 + ((x >> 3) ^ (y >> 2)) * 37) & 255;
      const offset = (y * width + x) * 4;
      previous[offset] = value;
      previous[offset + 1] = (value * 3) & 255;
      previous[offset + 2] = (value * 7) & 255;
      previous[offset + 3] = 255;
    }
  }
  const dx = 3;
  const dy = -2;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceX = x - dx;
      const sourceY = y - dy;
      const target = (y * width + x) * 4;
      if (sourceX >= 0 && sourceX < width &&
          sourceY >= 0 && sourceY < height) {
        const source = (sourceY * width + sourceX) * 4;
        current.set(previous.subarray(source, source + 4), target);
      }
    }
  }
  const a = Sweep.makeLumaThumbnail(previous, width, height, {
    width,
    height
  });
  const b = Sweep.makeLumaThumbnail(current, width, height, {
    width,
    height
  });
  const flow = Sweep.estimateGridFlow(a, b, {
    searchRadius: 5,
    patchRadius: 2
  });
  check(Math.abs(flow.dx - dx) < 0.05 && Math.abs(flow.dy - dy) < 0.05,
    "grid flow recovers known shift",
    `dx=${flow.dx}, dy=${flow.dy}, confidence=${flow.confidence.toFixed(3)}`);
  check(flow.confidence >= 0.55, "grid flow confidence is usable",
    `confidence=${flow.confidence.toFixed(3)}`);
}

function testDirectionAndQuality(direction) {
  const label = direction > 0 ? "LTR" : "RTL";
  const { session, result, decisions } = runSweep(direction);
  const seam = seamBrightnessP95(result);
  const magentaComponents = countMagentaComponents(result);
  check(result.ok, `${label} sweep completes`, `reason=${result.reason}`);
  check(result.direction === (direction > 0 ? "ltr" : "rtl"),
    `${label} direction lock is correct`, `direction=${result.direction}`);
  check(result.width > result.height, `${label} output is horizontal`,
    `${result.width}x${result.height}`);
  check(result.width <= 2048 && result.height <= 768,
    `${label} output respects mobile bounds`, `${result.width}x${result.height}`);
  check(result.height <= Math.floor(132 * 0.70) + 1,
    `${label} never upscales the effective source height`,
    `height=${result.height}, cap=${Math.floor(132 * 0.70)}`);
  check(result.coverage >= 0.98, `${label} coverage >= 0.98`,
    `coverage=${result.coverage.toFixed(4)}`);
  check(result.internalBlackColumns === 0, `${label} has no internal black column`,
    `internalBlackColumns=${result.internalBlackColumns}`);
  check(seam.p95 < 12, `${label} seam brightness jump p95 < 12`,
    `p95=${seam.p95.toFixed(3)}, seams=${seam.jumps.length}`);
  check(result.diagnostics.ownedSeamLumaP95 < 45,
    `${label} rendered owner seam p95 < 45`,
    `p50=${result.diagnostics.ownedSeamLumaP50.toFixed(3)}, ` +
      `p95=${result.diagnostics.ownedSeamLumaP95.toFixed(3)}`);
  check(magentaComponents.length === 1,
    `${label} near marker has no duplicate`,
    `components=${magentaComponents.length} [${magentaComponents.join(",")}]`);
  const endpointCentroid = direction > 0
    ? colourCentroidX(result, (r, g, b) => b > 180 && r < 90 && g < 125)
    : colourCentroidX(result, (r, g, b) => r > 180 && g < 100 && b < 90);
  check(
    endpointCentroid >= 0 && (
      direction > 0
        ? endpointCentroid > result.width * 0.62
        : endpointCentroid < result.width * 0.38
    ),
    `${label} output keeps natural left-to-right scene order`,
    `centroidX=${endpointCentroid.toFixed(1)}, width=${result.width}`
  );
  check(result.diagnostics.maxRetainedFrames <= 2,
    `${label} retains at most two full RGBA frames`,
    `max=${result.diagnostics.maxRetainedFrames}`);
  check(decisions.some(item => item.reason === "target_reached"),
    `${label} reports target reached`);
  const released = Sweep.releaseSweepSession(session);
  check(released.retainedFrames === 0 && session.retainedFrames === 0,
    `${label} release drops every full frame`);
}

function makeGateFrame(yawDeg, timeMs, overrides = {}) {
  const width = 80;
  const height = 60;
  return {
    rgba: renderFrame({
      yawDeg,
      pitchDeg: overrides.pitchDeg || 0,
      rollDeg: overrides.rollDeg || 0,
      exposure: 1,
      width,
      height
    }),
    width,
    height,
    timeMs,
    yawDeg,
    pitchDeg: overrides.pitchDeg || 0,
    rollDeg: overrides.rollDeg || 0,
    visualDx: overrides.visualDx === undefined
      ? -(overrides.deltaDeg || 0) / 65 * 64
      : overrides.visualDx,
    visualDy: 0,
    confidence: 0.8
  };
}

function testCaptureGates() {
  let session = Sweep.createSweepSession({ targetSpanDeg: 60, outputHeight: 120 });
  Sweep.ingestFrame(session, makeGateFrame(0, 0));
  const fast = Sweep.ingestFrame(
    session,
    makeGateFrame(5, 100, { deltaDeg: 5 })
  );
  check(fast.reason === "too_fast", "speed above 24 deg/s is rejected",
    `reason=${fast.reason}`);
  Sweep.releaseSweepSession(session);

  session = Sweep.createSweepSession({ targetSpanDeg: 60, outputHeight: 120 });
  Sweep.ingestFrame(session, makeGateFrame(0, 0));
  Sweep.ingestFrame(session, makeGateFrame(5, 300, { deltaDeg: 5 }));
  Sweep.ingestFrame(session, makeGateFrame(12, 700, { deltaDeg: 7 }));
  const reverse = Sweep.ingestFrame(
    session,
    makeGateFrame(8, 1100, { deltaDeg: -4 })
  );
  check(reverse.reason === "reverse", "reverse movement above 2 deg is rejected",
    `reason=${reverse.reason}`);
  const pitch = Sweep.ingestFrame(
    session,
    makeGateFrame(14, 1500, { deltaDeg: 6, pitchDeg: 8.5 })
  );
  check(pitch.reason === "pitch_drift", "pitch drift above 8 deg is rejected",
    `reason=${pitch.reason}`);
  const roll = Sweep.ingestFrame(
    session,
    makeGateFrame(14, 1900, { deltaDeg: 6, rollDeg: 12.5 })
  );
  check(roll.reason === "roll", "roll above 12 deg is rejected",
    `reason=${roll.reason}`);
  Sweep.releaseSweepSession(session);

  session = Sweep.createSweepSession({
    targetSpanDeg: 60,
    minSpanDeg: 45,
    outputHeight: 120
  });
  for (let progress = 0; progress <= 30; progress += 5) {
    Sweep.ingestFrame(
      session,
      makeGateFrame(progress, progress * 100, { deltaDeg: 5 })
    );
  }
  const short = Sweep.finalizeSweep(session);
  check(!short.ok && short.reason === "too_short",
    "sweep below 45 deg stops as too short",
    `progress=${short.progressDeg}, reason=${short.reason}`);
  Sweep.releaseSweepSession(session);
}

testGridFlow();
testVisualPitchFlow();
testFovCalibration();
testDirectionAndQuality(1);
testDirectionAndQuality(-1);
testCaptureGates();

if (failures.length) {
  process.stderr.write(`\n${failures.length} failure(s): ${failures.join(", ")}\n`);
  process.exit(1);
}
process.stdout.write("\nAll horizontal sweep core regressions passed.\n");
