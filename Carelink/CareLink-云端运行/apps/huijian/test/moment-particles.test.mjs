import test from "node:test";
import assert from "node:assert/strict";
import { mountMomentParticles, photoCoverRect } from "../public/moment-particles.js";

function environment({ reduced = false } = {}) {
  const images = [];
  const frames = new Map();
  const listeners = new Map();
  const contexts = [];
  let frameId = 0;
  let resize;
  let disconnected = false;
  function context() {
    const calls = [];
    const ctx = { calls, globalAlpha: 1,
      setTransform(...values) { calls.push(["transform", ...values]); },
      drawImage(...values) { calls.push(["image", this.globalAlpha, ...values]); },
      fillRect(...values) { calls.push(["rect", ...values]); },
      clearRect() { calls.push(["clear"]); },
      beginPath() {}, arc(...values) { calls.push(["arc", this.globalAlpha, this.fillStyle, ...values]); }, fill() {},
      getImageData() { return { data: new Uint8ClampedArray(Array(64 * 64).fill([31, 104, 168, 255]).flat()) }; }
    };
    contexts.push(ctx);
    return ctx;
  }
  function canvas() {
    const ctx = context();
    return { width: 400, height: 300, getContext: () => ctx, getBoundingClientRect: () => ({ width: 400, height: 300 }), ctx };
  }
  const main = canvas();
  const page = {
    hidden: false,
    createElement: () => canvas(),
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name)
  };
  const motion = { matches: reduced, addEventListener() {}, removeEventListener() {} };
  class Image {
    constructor() { this.naturalWidth = 1200; this.naturalHeight = 800; images.push(this); }
  }
  class ResizeObserver {
    constructor(callback) { resize = callback; }
    observe() {}
    disconnect() { disconnected = true; }
  }
  const field = mountMomentParticles({
    canvas: main, src: "blob:my-original-photo", document: page,
    window: { devicePixelRatio: 3, matchMedia: () => motion, addEventListener() {}, removeEventListener() {} },
    Image, ResizeObserver,
    requestAnimationFrame(fn) { const id = ++frameId; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    now: () => 0
  });
  return { field, images, page, listeners, frames, main, contexts, resize: () => resize(), get disconnected() { return disconnected; },
    frame(time) {
      const next = frames.entries().next().value;
      if (next) { frames.delete(next[0]); next[1](time); }
    }
  };
}

test("cover geometry crops consistently without changing photo aspect ratio", () => {
  assert.deepEqual(photoCoverRect(1200, 800, 400, 400), { x: -100, y: 0, width: 600, height: 400 });
  assert.deepEqual(photoCoverRect(800, 1200, 400, 300), { x: 0, y: -150, width: 400, height: 600 });
});

test("photo loads once, samples its colors, and clear mode paints it fully with particles remaining", async () => {
  const h = environment();
  h.resize();
  assert.equal(h.main.ctx.calls.length, 0, "resize before decoding must not draw an unloaded image");
  h.images[0].onload();
  assert.equal(await h.field.ready, true);
  assert.equal(h.main.width, 800, "device pixel ratio is capped at two");
  assert.equal(h.images[0].src, "blob:my-original-photo");
  assert.ok(h.main.ctx.calls.some((call) => call[0] === "arc" && call[2] === "rgb(31,104,168)"));
  h.main.ctx.calls.length = 0;
  h.field.setMode("clear");
  const photoPaints = h.main.ctx.calls.filter((call) => call[0] === "image");
  assert.equal(photoPaints.at(-1)[1], 1, "clear mode paints an opaque, legible photo");
  assert.ok(h.main.ctx.calls.some((call) => call[0] === "arc"), "particles remain in clear mode");
  h.field.destroy();
});

test("reveal progresses to the full photo while hidden pages stop requesting animation frames", async () => {
  const h = environment();
  h.images[0].onload();
  await h.field.ready;
  assert.equal(h.main.ctx.calls.filter((call) => call[0] === "image").at(-1)[1], .12);
  assert.equal(h.frames.size, 1);
  h.field.setProgress(1);
  for (let index = 0; index < 100; index += 1) h.frame(index * 40);
  assert.ok(h.main.ctx.calls.filter((call) => call[0] === "image").at(-1)[1] > .99);
  h.page.hidden = true;
  h.listeners.get("visibilitychange")();
  assert.equal(h.frames.size, 0);
  h.page.hidden = false;
  h.listeners.get("visibilitychange")();
  assert.equal(h.frames.size, 1);
  h.field.destroy();
  assert.equal(h.frames.size, 0);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.disconnected, true);
});

test("reduced motion retains a static particle photo without a perpetual render loop", async () => {
  const h = environment({ reduced: true });
  h.images[0].onload();
  await h.field.ready;
  assert.equal(h.frames.size, 0);
  assert.ok(h.main.ctx.calls.some((call) => call[0] === "arc"));
  h.field.setProgress(1);
  assert.equal(h.main.ctx.calls.filter((call) => call[0] === "image").at(-1)[1], 1);
  h.field.setLevel(1);
  assert.equal(h.frames.size, 0);
  h.field.destroy();
});

test("destroy before image decode resolves readiness and cannot leave a delayed field alive", async () => {
  const h = environment();
  h.field.destroy();
  assert.equal(await h.field.ready, false);
  assert.equal(h.images[0].onload, null);
  assert.equal(h.images[0].src, "");
  assert.equal(h.frames.size, 0);
});
