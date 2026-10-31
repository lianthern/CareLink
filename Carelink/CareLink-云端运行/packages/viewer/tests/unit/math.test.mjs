import test from "node:test";
import assert from "node:assert/strict";
import {
  allowedRadiusForHeading,
  clampPitch,
  constrainMovement,
  localMovementDelta,
  normalizePose,
  normalizeYaw,
  shortestYawDelta,
  validateSafetyEnvelope,
} from "../../src/public/index.js";

const envelope = {
  schemaVersion: "unseen-polar-safety-envelope/1",
  absoluteMaxRadiusMeters: 0.4,
  directions: [
    [0, 0.34], [45, 0.22], [90, 0.14], [135, 0.2],
    [180, 0.28], [225, 0.18], [270, 0.12], [315, 0.24],
  ].map(([yawDeg, allowedRadiusMeters]) => ({ yawDeg, allowedRadiusMeters })),
};

test("yaw/pitch normalization is stable across seams and invalid values", () => {
  assert.equal(normalizeYaw(-1), 359);
  assert.equal(normalizeYaw(721), 1);
  assert.equal(normalizeYaw(Number.NaN), 0);
  assert.equal(clampPitch(120), 89);
  assert.equal(clampPitch(-120), -89);
  assert.deepEqual(normalizePose({ nodeId: "n1", yawDeg: -45, pitchDeg: 91, fovDeg: 200 }), {
    nodeId: "n1",
    yawDeg: 315,
    pitchDeg: 89,
    fovDeg: 100,
  });
  assert.equal(shortestYawDelta(359, 1), 2);
  assert.equal(shortestYawDelta(1, 359), -2);
});

test("three headings expose different direction-dependent radii", () => {
  assert.equal(allowedRadiusForHeading(envelope, 0), 0.34);
  assert.equal(allowedRadiusForHeading(envelope, 90), 0.14);
  assert.equal(allowedRadiusForHeading(envelope, 270), 0.12);
  assert.equal(allowedRadiusForHeading(envelope, 22.5), 0.22, "between samples uses conservative neighbor minimum");
});

test("movement clamps at the directional boundary without non-finite drift", () => {
  const north = constrainMovement({ x: 0, z: 0 }, { x: 0, z: 1 }, envelope);
  assert.equal(north.blocked, true);
  assert.ok(Math.abs(north.z - 0.34) < 1e-12);
  const east = constrainMovement({ x: 0, z: 0 }, { x: 1, z: 0 }, envelope);
  assert.ok(Math.abs(east.x - 0.14) < 1e-12);
  const west = constrainMovement({ x: 0, z: 0 }, { x: -1, z: 0 }, envelope);
  assert.ok(Math.abs(west.x + 0.12) < 1e-12);
  const small = constrainMovement({ x: 0, z: 0 }, { x: 0, z: 0.05 }, envelope);
  assert.deepEqual({ x: small.x, z: small.z, blocked: small.blocked }, { x: 0, z: 0.05, blocked: false });
  assert.deepEqual(localMovementDelta(90, 0, 0.1), { x: 0.1, z: 6.123233995736766e-18 });
  const directional = [north, east, west];
  assert.ok(directional.every(({ x, z }) => Math.hypot(x, z) <= 0.42));
  assert.equal(new Set(directional.map(({ x, z }) => Math.hypot(x, z))).size, 3);
});

test("the frozen 0.42m ceiling accepts its edge and clamps any excess", () => {
  const ceilingEnvelope = {
    ...envelope,
    absoluteMaxRadiusMeters: 0.42,
    directions: envelope.directions.map(({ yawDeg }) => ({ yawDeg, allowedRadiusMeters: 0.42 })),
  };
  assert.equal(validateSafetyEnvelope(ceilingEnvelope).ok, true);
  assert.equal(validateSafetyEnvelope({ ...ceilingEnvelope, absoluteMaxRadiusMeters: 0.420001 }).ok, false);
  const edge = constrainMovement({ x: 0, z: 0 }, { x: 0, z: 0.42 }, ceilingEnvelope);
  assert.equal(edge.blocked, false);
  assert.equal(Math.hypot(edge.x, edge.z), 0.42);
  const excess = constrainMovement({ x: 0, z: 0 }, { x: 0.420001, z: 0 }, ceilingEnvelope);
  assert.equal(excess.blocked, true);
  assert.ok(Math.hypot(excess.x, excess.z) <= 0.42);
});

test("bad safety data fails closed", () => {
  const gap = { ...envelope, directions: envelope.directions.slice(0, 6) };
  assert.equal(validateSafetyEnvelope(gap).ok, false);
  assert.equal(validateSafetyEnvelope({ ...envelope, absoluteMaxRadiusMeters: "0.4" }).ok, false);
  assert.equal(allowedRadiusForHeading(gap, 0), 0);
  const result = constrainMovement({ x: 0.01, z: 0.02 }, { x: 0.1, z: 0.1 }, gap);
  assert.deepEqual(result, {
    x: 0.01,
    z: 0.02,
    blocked: true,
    allowedRadiusMeters: 0,
    reason: "unsafe_or_invalid_depth",
  });
  assert.deepEqual(constrainMovement({ x: 0, z: 0 }, { x: 0, z: 0 }, gap), {
    x: 0,
    z: 0,
    blocked: true,
    allowedRadiusMeters: 0,
    reason: "unsafe_or_invalid_depth",
  });
});
