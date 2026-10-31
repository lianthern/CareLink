import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { JELLY_PRESETS, fitPhoto, releaseEnergy, stepSpring } from "../public/jelly-core.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("jelly demo is isolated behind its own route", async () => {
  const server = await read("../server.mjs");
  assert.match(server, /pathname === "\/jelly"/u);
  assert.match(server, /publicPath = "\/jelly\.html"/u);
  assert.match(server, /pathname === "\/"[^\n]+publicPath = "\/spatial-lab\.html"/u);
});

test("jelly demo exposes the local photo, feel and sound controls", async () => {
  const html = await read("../public/jelly.html");
  assert.match(html, /id="jelly-canvas"/u);
  assert.match(html, /accept="image\/jpeg,image\/png,image\/webp"/u);
  assert.match(html, /data-preset="soft"/u);
  assert.match(html, /data-preset="bounce"/u);
  assert.match(html, /data-preset="sticky"/u);
  assert.match(html, /id="sound-toggle"/u);
  assert.match(html, /照片只留在本机/u);
  assert.match(html, /不会上传原图/u);
});

test("jelly interaction uses a deformed photo mesh and local procedural audio", async () => {
  const source = await read("../public/jelly.js");
  assert.match(source, /new THREE\.PlaneGeometry/u);
  assert.match(source, /uGrabOrigin/u);
  assert.match(source, /stepSpring/u);
  assert.match(source, /setPointerCapture/u);
  assert.match(source, /window\.AudioContext/u);
  assert.match(source, /createOscillator/u);
  assert.match(source, /createBufferSource/u);
  assert.match(source, /URL\.createObjectURL/u);
  assert.doesNotMatch(source, /fetch\(/u);
});

test("jelly has real 3D thickness, lighting and perspective instead of a flat card", async () => {
  const source = await read("../public/jelly.js");
  assert.match(source, /new THREE\.PerspectiveCamera/u);
  assert.match(source, /new THREE\.ExtrudeGeometry/u);
  assert.match(source, /new THREE\.MeshPhysicalMaterial/u);
  assert.match(source, /new THREE\.HemisphereLight/u);
  assert.match(source, /new THREE\.DirectionalLight/u);
  assert.match(source, /jellyGroup\.rotation\.y/u);
  assert.match(source, /SHELL_DEPTH/u);
});

test("jelly presets have distinct, stable physical responses", () => {
  assert.ok(JELLY_PRESETS.bounce.stiffness > JELLY_PRESETS.soft.stiffness);
  assert.ok(JELLY_PRESETS.sticky.damping > JELLY_PRESETS.bounce.damping);
  assert.ok(JELLY_PRESETS.sticky.radius > JELLY_PRESETS.bounce.radius);

  let position = 0;
  let velocity = 0;
  for (let index = 0; index < 240; index += 1) {
    const next = stepSpring(position, velocity, 0, JELLY_PRESETS.bounce, 1 / 60);
    position = next.position;
    velocity = next.velocity;
  }
  assert.ok(Math.abs(position) < 0.001);
  assert.ok(Math.abs(velocity) < 0.001);
});

test("jelly geometry stays inside its stage and release energy is bounded", () => {
  const landscape = fitPhoto(1.8, 5, 6);
  assert.ok(landscape.width <= 5 * 0.84 + Number.EPSILON);
  assert.ok(landscape.height <= 6 * 0.7 + Number.EPSILON);
  assert.equal(releaseEnergy(20, 20, 500, 500), 1);
  assert.equal(releaseEnergy(0, 0, 0, 0), 0.08);
});
