import test from "node:test";
import assert from "node:assert/strict";

import {
  audioEnvelope,
  depthProxyAt,
  flowVector,
  hash01,
  particleBudget,
  particleSeed,
  timelineState
} from "../public/spatial-lab-core.js";

test("particle layout and flow stay deterministic and finite", () => {
  const first = particleSeed(42, 0.4, 0.6, 0.7);
  const second = particleSeed(42, 0.4, 0.6, 0.7);
  assert.deepEqual(first, second);
  assert.ok(Object.values(first).every(Number.isFinite));
  assert.equal(hash01(1234), hash01(1234));
  assert.deepEqual(flowVector(0.4, -0.2, 3.1, 0.8), flowVector(0.4, -0.2, 3.1, 0.8));
  assert.ok(Object.values(flowVector(1, 2, 3, 4)).every(Number.isFinite));
});

test("the prototype depth proxy separates likely foreground from distant sky", () => {
  const foreground = depthProxyAt({ red: 210, green: 118, blue: 68, edge: 0.24 }, 0.5, 0.75);
  const sky = depthProxyAt({ red: 230, green: 220, blue: 205, edge: 0.01 }, 0.78, 0.08);
  assert.ok(foreground > sky + 0.35);
});

test("particles remain alive after the photo has gathered", () => {
  const start = timelineState(0);
  const middle = timelineState(0.62);
  const final = timelineState(1);
  assert.ok(start.particleOpacity > 0);
  assert.ok(middle.surfaceOpacity > 0);
  assert.equal(final.settle, 1);
  assert.equal(final.particleOpacity, 1);
  assert.equal(final.interaction, 1);
  assert.equal(final.fieldStrength, 1);
});

test("audio envelope attacks quickly, releases gently, and never leaves its range", () => {
  const attacked = audioEnvelope(0, 1);
  const released = audioEnvelope(attacked, 0);
  assert.ok(attacked > 0.2);
  assert.ok(released > 0);
  assert.ok(released < attacked);
  assert.equal(audioEnvelope(0.9, 9), 0.928);
});

test("particle budgets preserve a dense field while respecting small and reduced-motion screens", () => {
  assert.equal(particleBudget(360), 15000);
  assert.equal(particleBudget(768), 23000);
  assert.equal(particleBudget(1280), 36000);
  assert.equal(particleBudget(1280, true), 9000);
});
