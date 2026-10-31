const clamp = (value, minimum = 0, maximum = 1) => Math.min(maximum, Math.max(minimum, value));

function smoothstep(edge0, edge1, value) {
  const t = clamp((value - edge0) / Math.max(0.00001, edge1 - edge0));
  return t * t * (3 - 2 * t);
}

// Stable integer hash: the same photo always produces the same living field.
function hash01(value) {
  let state = value | 0;
  state = Math.imul(state ^ (state >>> 16), 0x45d9f3b);
  state = Math.imul(state ^ (state >>> 16), 0x45d9f3b);
  state ^= state >>> 16;
  return (state >>> 0) / 4294967295;
}

function depthProxyAt({ red, green, blue, edge = 0 }, u, v) {
  const warmth = smoothstep(0.015, 0.42, (red - blue) / 255);
  const lowerForeground = smoothstep(0.22, 0.96, v);
  const centerSubject = Math.exp(-(
    Math.pow((u - 0.5) / 0.43, 2) +
    Math.pow((v - 0.61) / 0.46, 2)
  ) * 1.35);
  const topDistance = 1 - smoothstep(0.05, 0.38, v);
  const detail = smoothstep(0.03, 0.34, edge);

  return clamp(
    0.07 +
    lowerForeground * 0.25 +
    centerSubject * 0.19 +
    warmth * 0.28 +
    detail * 0.19 -
    topDistance * 0.12,
    0.035,
    0.93
  );
}

function timelineState(progress) {
  const value = clamp(progress);
  return {
    progress: value,
    settle: smoothstep(0.04, 0.84, value),
    particleOpacity: 0.16 + smoothstep(0.01, 0.2, value) * 0.84,
    surfaceOpacity: smoothstep(0.34, 0.9, value) * 0.82,
    interaction: smoothstep(0.46, 0.86, value),
    fieldStrength: 0.18 + smoothstep(0.18, 0.72, value) * 0.82
  };
}

function particleSeed(index, u, v, depth) {
  const angle = hash01(index * 17 + 19) * Math.PI * 2;
  const radius = 1.15 + hash01(index * 31 + 7) * 2.85;
  const jitterX = hash01(index * 47 + 11) - 0.5;
  const jitterY = hash01(index * 53 + 13) - 0.5;
  return {
    startX: Math.cos(angle) * radius + jitterX * 0.64,
    startY: Math.sin(angle) * radius * 0.78 + jitterY * 0.46,
    startZ: (hash01(index * 59 + 23) - 0.5) * 2.4,
    delay: hash01(index * 71 + 29) * 0.24,
    size: 0.52 + depth * 0.64 + hash01(index * 89 + 37) * 0.74,
    seed: hash01(index * 101 + 41) + u * 0.17 + v * 0.11
  };
}

function flowVector(x, y, time, seed = 0) {
  const phase = seed * Math.PI * 2;
  const angle =
    Math.sin(x * 1.42 + time * 0.19 + phase) * 1.7 +
    Math.cos(y * 1.84 - time * 0.16 - phase * 0.37) * 1.18 +
    Math.sin((x + y) * 0.74 + time * 0.08) * 0.72;
  return {
    x: Math.cos(angle),
    y: Math.sin(angle),
    z: Math.sin(x * 1.3 - y * 1.1 + time * 0.42 + phase) * 0.38
  };
}

function audioEnvelope(previous, sample, attack = 0.28, release = 0.075) {
  const target = clamp(sample);
  const rate = target > previous ? attack : release;
  return clamp(previous + (target - previous) * rate);
}

function particleBudget(viewportWidth, reducedMotion = false) {
  if (reducedMotion) return 9000;
  if (viewportWidth < 520) return 15000;
  if (viewportWidth < 900) return 23000;
  return 36000;
}

export {
  audioEnvelope,
  clamp,
  depthProxyAt,
  flowVector,
  hash01,
  particleBudget,
  particleSeed,
  smoothstep,
  timelineState
};
