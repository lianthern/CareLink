import assert from "node:assert/strict";
import test from "node:test";

import {
  createSpatialPhoto,
  createSpatialResultField
} from "../public/spatial-photo.js";

function createFakeField() {
  const calls = [];
  const field = {
    start(options) { calls.push(["start", options]); return true; },
    replay() { calls.push(["replay"]); return true; },
    resize() { calls.push(["resize"]); return true; },
    stop(options) { calls.push(["stop", options]); },
    reset() { calls.push(["reset"]); },
    setPointer(...args) { calls.push(["pointer", ...args]); },
    clearPointer() { calls.push(["clear-pointer"]); },
    setListening(active) { calls.push(["listening", active]); },
    setAudioLevel(level) { calls.push(["audio", level]); },
    isSupported() { return true; },
    destroy() { calls.push(["destroy"]); }
  };
  let options;
  return {
    calls,
    field,
    factory(nextOptions) { options = nextOptions; return field; },
    get options() { return options; }
  };
}

function createStage(dataset = {}) {
  const classes = new Set();
  const listeners = new Map();
  return {
    stage: {
      dataset,
      classList: {
        toggle(name, active) { active ? classes.add(name) : classes.delete(name); }
      },
      addEventListener: (name, listener) => listeners.set(name, listener),
      removeEventListener() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 })
    },
    classes,
    listeners
  };
}

function installBrowserEnvironment({ screen = "chat" } = {}) {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const windowListeners = new Map();
  const documentListeners = new Map();
  const motionListeners = [];
  const motion = {
    matches: false,
    addEventListener(name, listener) { if (name === "change") motionListeners.push(listener); },
    removeEventListener() {}
  };
  globalThis.window = {
    WebGLRenderingContext: class {},
    matchMedia: () => motion,
    addEventListener: (name, listener) => windowListeners.set(name, listener),
    removeEventListener() {}
  };
  globalThis.document = {
    hidden: false,
    body: { dataset: { screen } },
    addEventListener: (name, listener) => documentListeners.set(name, listener),
    removeEventListener() {}
  };
  return {
    documentListeners,
    motion,
    motionListeners,
    restore() {
      globalThis.window = originalWindow;
      globalThis.document = originalDocument;
    },
    windowListeners
  };
}

test("chat uses one Demo-derived field for photo, particles, pointer and voice", () => {
  const environment = installBrowserEnvironment();
  const { stage, classes, listeners } = createStage();
  const host = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }) };
  const canvas = { parentElement: host };
  const imageListeners = new Map();
  const image = {
    complete: true,
    currentSrc: "photo-a.jpg",
    src: "photo-a.jpg",
    addEventListener: (name, listener) => imageListeners.set(name, listener)
  };
  const fake = createFakeField();
  const statuses = [];

  try {
    const spatial = createSpatialPhoto({
      stage,
      image,
      canvas,
      createField: fake.factory,
      onStatus: (message) => statuses.push(message)
    });
    assert.equal(fake.options.host, host);
    assert.equal(spatial.setEnabled(true), true);
    assert.ok(classes.has("is-spatial"));
    assert.ok(classes.has("has-memory-field"));
    assert.deepEqual(fake.calls.at(-1), ["start", { forceRebuild: false }]);

    listeners.get("pointermove")({ clientX: 400, clientY: 0, pointerType: "mouse" });
    assert.deepEqual(fake.calls.at(-1), ["pointer", 400, 0, true]);
    spatial.setListening(true);
    assert.deepEqual(fake.calls.at(-1), ["listening", true]);
    spatial.setAudioLevel(.64);
    assert.deepEqual(fake.calls.at(-1), ["audio", .64]);
    spatial.setAudioLevel(9);
    assert.deepEqual(fake.calls.at(-1), ["audio", 1]);

    environment.windowListeners.get("scroll")();
    assert.deepEqual(fake.calls.at(-1), ["clear-pointer"]);
    assert.equal(spatial.replay(), true);
    assert.deepEqual(fake.calls.at(-1), ["replay"]);

    environment.windowListeners.get("blur")();
    assert.ok(!classes.has("has-memory-field"));
    assert.deepEqual(fake.calls.at(-1), ["stop", { keepWanted: true }]);
    environment.windowListeners.get("focus")();
    assert.ok(classes.has("has-memory-field"));

    imageListeners.get("load")();
    assert.deepEqual(fake.calls.at(-1), ["start", { forceRebuild: true }]);
    environment.motion.matches = true;
    environment.motionListeners[0]();
    assert.ok(!classes.has("has-memory-field"));
    assert.match(statuses.at(-1), /聚拢|原始照片/u);
    spatial.setEnabled(false);
    assert.ok(!classes.has("is-spatial"));
  } finally {
    environment.restore();
  }
});

test("result uses the same single field only while the spatial result is visible", () => {
  const environment = installBrowserEnvironment({ screen: "result" });
  const originalObserver = globalThis.MutationObserver;
  let observerCallback = null;
  globalThis.MutationObserver = class {
    constructor(callback) { observerCallback = callback; }
    observe() {}
    disconnect() {}
  };
  const { stage, classes, listeners } = createStage({ shape: "spatial" });
  const host = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }) };
  const canvas = { parentElement: host };
  const imageListeners = new Map();
  const image = {
    addEventListener: (name, listener) => imageListeners.set(name, listener),
    removeEventListener() {}
  };
  const fake = createFakeField();

  try {
    const resultField = createSpatialResultField({ stage, image, canvas, createField: fake.factory });
    assert.equal(fake.options.host, host);
    assert.ok(classes.has("has-memory-field"));
    assert.equal(fake.calls[0][0], "start");

    listeners.get("pointermove")({ clientX: 400, clientY: 0, pointerType: "mouse" });
    assert.deepEqual(fake.calls.at(-1), ["pointer", 400, 0, true]);
    environment.windowListeners.get("scroll")();
    assert.deepEqual(fake.calls.at(-1), ["clear-pointer"]);
    imageListeners.get("load")();
    assert.deepEqual(fake.calls.at(-1), ["start", { forceRebuild: true }]);

    globalThis.document.body.dataset.screen = "chat";
    observerCallback();
    assert.ok(!classes.has("has-memory-field"));
    assert.equal(fake.calls.at(-1)[0], "stop");
    globalThis.document.body.dataset.screen = "result";
    observerCallback();
    assert.ok(classes.has("has-memory-field"));

    resultField.resetSession();
    assert.ok(!classes.has("has-memory-field"));
    assert.ok(fake.calls.some(([name]) => name === "reset"));
    resultField.destroy();
    assert.deepEqual(fake.calls.at(-1), ["destroy"]);
  } finally {
    globalThis.MutationObserver = originalObserver;
    environment.restore();
  }
});
