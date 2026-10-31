import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const evidenceRoot = path.join(packageRoot, "tests/evidence");
const screenshotRoot = path.join(evidenceRoot, "screenshots");
const runId = process.env.UNSEEN_VIEWER_RUN_ID || crypto.randomUUID();
const stageTimeoutMs = Number(process.env.UNSEEN_VIEWER_STAGE_TIMEOUT_MS) || 12_000;
const globalTimeoutMs = Number(process.env.UNSEEN_VIEWER_GLOBAL_TIMEOUT_MS) || 180_000;
const injectedTimeoutStage = process.env.UNSEEN_VIEWER_TEST_TIMEOUT_STAGE || "";
const cleanupReportPath = process.env.UNSEEN_VIEWER_CLEANUP_REPORT || path.join(evidenceRoot, "runner-cleanup-report.json");
const failureReportPath = process.env.UNSEEN_VIEWER_FAILURE_REPORT || path.join(evidenceRoot, "browser-failure.json");
fs.mkdirSync(screenshotRoot, { recursive: true });
fs.rmSync(failureReportPath, { force: true });

const resources = {
  server: null,
  pagePort: null,
  pageOrigin: null,
  chrome: null,
  chromeExited: false,
  chromeExit: null,
  profile: null,
  client: null,
};
const stages = [];
const assertions = [];
const consoleErrors = [];
const browserLogErrors = [];
const exceptions = [];
const networkFailures = [];
const networkHttpErrors = [];
const externalRequests = [];
const requests = [];
let chromeStderr = "";
let cleanupPromise = null;
let suiteFailure = null;

function marker(kind, name, detail = null) {
  const record = { kind, name, at: new Date().toISOString(), detail };
  stages.push(record);
  process.stdout.write(`${kind} ${name}${detail ? ` ${JSON.stringify(detail)}` : ""}\n`);
}

function timeoutError(name, milliseconds) {
  const error = new Error(`${name} exceeded ${milliseconds}ms`);
  error.code = "RUNNER_TIMEOUT";
  return error;
}

function withTimeout(promise, milliseconds, name) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(timeoutError(name, milliseconds)), milliseconds);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

async function stage(name, task, timeoutMs = stageTimeoutMs) {
  const effectiveTimeoutMs = injectedTimeoutStage === name ? stageTimeoutMs : timeoutMs;
  marker("STAGE_START", name, { timeoutMs: effectiveTimeoutMs });
  try {
    const result = await withTimeout(
      injectedTimeoutStage === name ? new Promise(() => {}) : task(),
      effectiveTimeoutMs,
      `stage:${name}`,
    );
    marker("STAGE_PASS", name);
    return result;
  } catch (error) {
    marker("STAGE_FAIL", name, { code: error.code || error.name, message: error.message });
    throw error;
  }
}

function pass(name, detail = null) {
  assertions.push({ name, status: "PASS", detail });
  marker("ASSERT_PASS", name, detail);
}

function circularDeltaDegrees(a, b) {
  return Math.abs(((a - b + 540) % 360) - 180);
}

function processCountForProfile(profile) {
  if (!profile) return 0;
  const output = spawnSync("ps", ["-axo", "command="], { encoding: "utf8" }).stdout || "";
  return output.split("\n").filter((line) => line.includes(profile)).length;
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve(true);
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve(true)));
}

function waitForChildExit(child, timeoutMs) {
  if (!child || resources.chromeExited) return Promise.resolve(true);
  return withTimeout(new Promise((resolve) => child.once("exit", () => resolve(true))), timeoutMs, "chrome-exit")
    .catch(() => false);
}

async function cleanup(reason) {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    marker("CLEANUP_START", reason);
    resources.client?.close();
    resources.client = null;

    let serverClosed = false;
    try {
      serverClosed = await withTimeout(closeServer(resources.server), 2_000, "server-close");
    } catch {}

    let usedSigkill = false;
    if (resources.chrome && !resources.chromeExited) {
      try { process.kill(-resources.chrome.pid, "SIGTERM"); } catch {}
      if (!await waitForChildExit(resources.chrome, 2_000)) {
        usedSigkill = true;
        try { process.kill(-resources.chrome.pid, "SIGKILL"); } catch {}
        await waitForChildExit(resources.chrome, 2_000);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 120));
    const orphanProcessCount = processCountForProfile(resources.profile);
    let profileRemoved = false;
    try {
      if (resources.profile) fs.rmSync(resources.profile, { recursive: true, force: true });
      profileRemoved = !resources.profile || !fs.existsSync(resources.profile);
    } catch {}
    const report = {
      schemaVersion: "unseen-viewer-runner-cleanup/1",
      runId,
      reason,
      injectedTimeoutStage: injectedTimeoutStage || null,
      failure: suiteFailure ? { code: suiteFailure.code || suiteFailure.name, message: suiteFailure.message } : null,
      serverPort: resources.pagePort,
      serverClosed,
      chromePid: resources.chrome?.pid || null,
      chromeExited: resources.chromeExited,
      chromeExit: resources.chromeExit,
      usedSigkill,
      profile: resources.profile,
      profileRemoved,
      orphanProcessCount,
      stages,
    };
    const cleanupOk = serverClosed && resources.chromeExited && orphanProcessCount === 0 && profileRemoved;
    marker(cleanupOk ? "CLEANUP_PASS" : "CLEANUP_FAIL", reason, { serverClosed, chromeExited: resources.chromeExited, orphanProcessCount, profileRemoved });
    fs.writeFileSync(cleanupReportPath, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  })();
  return cleanupPromise;
}

let signalCleanupStarted = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    // Keep handling repeated terminal signals while async cleanup owns exit;
    // otherwise a second signal can restore the default immediate termination
    // and orphan the detached browser group.
    if (signalCleanupStarted) return;
    signalCleanupStarted = true;
    suiteFailure = Object.assign(new Error(`runner received ${signal}`), { code: signal });
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    cleanup(signal).finally(() => process.exit(process.exitCode));
  });
}

const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".json", "application/json"],
]);

function createServer() {
  return http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://local").pathname);
    if (pathname === "/favicon.ico") {
      response.writeHead(204, { "cache-control": "no-store" }).end();
      return;
    }
    const relative = pathname === "/" ? "harness/index.html" : pathname.replace(/^\/+/, "");
    const filename = path.resolve(packageRoot, relative);
    if (!filename.startsWith(`${packageRoot}${path.sep}`) || !fs.existsSync(filename) || fs.statSync(filename).isDirectory()) {
      response.writeHead(404).end("not found");
      return;
    }
    response.writeHead(200, {
      "content-type": mime.get(path.extname(filename)) || "application/octet-stream",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    });
    fs.createReadStream(filename).pipe(response);
  });
}

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

function chromeExecutable() {
  const candidates = [
    process.env.UNSEEN_CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async open() {
    await withTimeout(new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    }), 8_000, "cdp-open");
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result || {});
        return;
      }
      for (const listener of this.listeners.get(message.method) || []) listener(message.params || {});
    });
    this.socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`CDP closed during ${pending.method}`));
      }
      this.pending.clear();
    });
  }

  send(method, params = {}, timeoutMs = 8_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(timeoutError(`cdp:${method}`, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  close() {
    try { this.socket.close(); } catch {}
  }
}

async function waitForChrome() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${resources.debugPort}/json/version`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Chrome DevTools did not start:\n${chromeStderr}`);
}

async function evaluate(expression, timeoutMs = 8_000) {
  const result = await resources.client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, timeoutMs);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Runtime evaluation failed");
  return result.result?.value;
}

async function waitFor(expression, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression, Math.min(2_000, timeoutMs))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  let bootError = null;
  try { bootError = await evaluate("window.__viewerHarnessBootError || null", 1_000); } catch {}
  throw new Error(`Timed out waiting for ${expression}; bootError=${JSON.stringify(bootError)}`);
}

async function screenshot(filename) {
  const result = await resources.client.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  fs.writeFileSync(path.join(screenshotRoot, filename), Buffer.from(result.data, "base64"));
}

async function setViewport(width, height, mobile, touch, deviceScaleFactor = 1) {
  await resources.client.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor,
    mobile,
    screenWidth: width,
    screenHeight: height,
    screenOrientation: { type: height >= width ? "portraitPrimary" : "landscapePrimary", angle: 0 },
  });
  await resources.client.send("Emulation.setTouchEmulationEnabled", { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
}


async function suite() {
  await stage("server-start", async () => {
    resources.server = createServer();
    await new Promise((resolve) => resources.server.listen(0, "127.0.0.1", resolve));
    resources.pagePort = resources.server.address().port;
    resources.pageOrigin = `http://127.0.0.1:${resources.pagePort}`;
  });

  let browserVersion;
  let target;
  await stage("browser-launch", async () => {
    const executable = chromeExecutable();
    if (!executable) throw new Error("Chrome/Chromium not found; set UNSEEN_CHROME");
    resources.debugPort = await freePort();
    resources.profile = fs.mkdtempSync(path.join(os.tmpdir(), `unseen-viewer-browser-${runId}-`));
    resources.chrome = spawn(executable, [
      "--headless=new",
      `--remote-debugging-port=${resources.debugPort}`,
      `--user-data-dir=${resources.profile}`,
      "--window-size=1280,800",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-renderer-backgrounding",
      "--disable-sync",
      "--disable-features=OptimizationHints,MediaRouter,DialMediaRouteProvider",
      "--metrics-recording-only",
      "--no-default-browser-check",
      "--no-first-run",
      "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"], detached: true });
    resources.chrome.stderr.on("data", (chunk) => { chromeStderr += chunk.toString(); });
    resources.chrome.once("exit", (code, signal) => {
      resources.chromeExited = true;
      resources.chromeExit = { code, signal };
    });
    browserVersion = await waitForChrome();
    const targetResponse = await fetch(`http://127.0.0.1:${resources.debugPort}/json/new?${encodeURIComponent(`${resources.pageOrigin}/harness/index.html`)}`, { method: "PUT" });
    target = await targetResponse.json();
    resources.client = new Cdp(target.webSocketDebuggerUrl);
    await resources.client.open();
    resources.client.on("Runtime.consoleAPICalled", (event) => {
      if (event.type === "error" || event.type === "assert") consoleErrors.push(event);
    });
    resources.client.on("Runtime.exceptionThrown", (event) => exceptions.push(event));
    resources.client.on("Log.entryAdded", (event) => {
      if (["error", "severe"].includes(event.entry?.level)) browserLogErrors.push(event.entry);
    });
    resources.client.on("Network.loadingFailed", (event) => { if (!event.canceled) networkFailures.push(event); });
    resources.client.on("Network.responseReceived", (event) => {
      if (event.response.status >= 400) networkHttpErrors.push({ url: event.response.url, status: event.response.status });
    });
    resources.client.on("Network.requestWillBeSent", (event) => {
      const url = event.request.url;
      requests.push(url);
      if (!url.startsWith(resources.pageOrigin) && !url.startsWith("data:") && !url.startsWith("blob:")) externalRequests.push(url);
    });
    await Promise.all([
      resources.client.send("Page.enable"),
      resources.client.send("Runtime.enable"),
      resources.client.send("Network.enable"),
      resources.client.send("Log.enable"),
    ]);
  }, 20_000);

  await stage("initial-scene-ready", async () => {
    await setViewport(1280, 800, false, false);
    await resources.client.send("Page.navigate", { url: `${resources.pageOrigin}/harness/index.html` });
    await waitFor("window.__viewerHarnessReady === true && window.__viewerHarness.state().phase === 'ready'", 15_000);
    const state = await evaluate("window.__viewerHarness.state()");
    assert.equal(state.renderMode, "depth_limited_parallax");
    assert.equal(state.capability.translation, true);
    assert.ok(state.metrics.firstFrameMs >= 0);
    pass("depth artifact produces a real depth-ready first frame", state.metrics);
  }, 20_000);

  await stage("panorama-integrity", async () => {
    const beforeDecode = await evaluate("window.__viewerHarness.hashBeforeDecodeCounterexample()", 12_000);
    assert.equal(beforeDecode.code, "panorama_hash_mismatch");
    assert.equal(beforeDecode.decoderCalls, 0);
    const failed = await evaluate(`(async () => {
      try { await window.__viewerHarness.badPanoramaHash(); }
      catch (error) {
        return {
          code:error.code,
          state:window.__viewerHarness.state(),
          canvasHidden:document.querySelector('.unseen-viewer__canvas').hidden,
          retryVisible:!document.querySelector('[data-action=retry]').hidden,
        };
      }
      throw new Error('bad panorama hash unexpectedly rendered');
    })()`);
    assert.equal(failed.code, "panorama_hash_mismatch");
    assert.equal(failed.state.phase, "error");
    assert.equal(failed.state.panoramaRevisionId, "pano-revision-a");
    assert.equal(failed.canvasHidden, true);
    assert.equal(failed.retryVisible, true);
    const unsupported = await evaluate(`(async () => {
      try { await window.__viewerHarness.unsupportedRaster(); }
      catch (error) { return {code:error.code,state:window.__viewerHarness.state()}; }
      throw new Error('SVG unexpectedly accepted');
    })()`);
    assert.equal(unsupported.code, "asset_format_unsupported");
    assert.equal(unsupported.state.phase, "error");
    const recovered = await evaluate("window.__viewerHarness.depth()", 12_000);
    assert.equal(recovered.renderMode, "depth_limited_parallax");
    pass("SHA-256 is checked before decoder and only static PNG/JPEG/WebP raster magic may render", { beforeDecode, failed, unsupported });
  }, 20_000);

  await stage("static-raster-animation-policy", async () => {
    const result = await evaluate(`(async () => {
      const originalCreateImageBitmap = window.createImageBitmap;
      let decoderCalls = 0;
      window.createImageBitmap = (...args) => {
        decoderCalls += 1;
        return originalCreateImageBitmap.apply(window, args);
      };
      const run = async (url, sha256) => {
        const scene = {
          ...window.__viewerHarness.lookScene,
          panorama: {...window.__viewerHarness.lookScene.panorama, url, sha256},
        };
        try {
          return {result:'resolved', state:await window.__viewerHarness.viewer.updateScene(scene)};
        } catch (error) {
          return {
            result:'rejected',
            code:error.code,
            retryable:error.retryable,
            state:window.__viewerHarness.state(),
            retryVisible:!document.querySelector('[data-action=retry]').hidden,
          };
        }
      };
      try {
        const staticWebp = await run('../tests/fixtures/static-panorama.webp', 'd1190d475ccce46f8b37639e123195e9df2ad4cbe06d8e275cf12e6b9ab972f3');
        const callsAfterStatic = decoderCalls;
        const apng = await run('../tests/fixtures/animated.apng', 'a8822535065b9dadbd395cfdac588aeeb9f70fca9dc9310a1c9cfb1ea39dcae3');
        const animatedWebp = await run('../tests/fixtures/animated.webp', 'a969cc63f3904971f882728e4266ab30180638e1f284e034d9fe409b8477c6fd');
        return {staticWebp, apng, animatedWebp, decoderCalls, animationDecoderCalls:decoderCalls-callsAfterStatic};
      } finally {
        window.createImageBitmap = originalCreateImageBitmap;
      }
    })()`, 15_000);
    assert.equal(result.staticWebp.result, "resolved");
    assert.equal(result.staticWebp.state.renderMode, "rotation360");
    assert.ok(result.decoderCalls >= 1, JSON.stringify(result));
    for (const rejected of [result.apng, result.animatedWebp]) {
      assert.equal(rejected.result, "rejected");
      assert.equal(rejected.code, "asset_animation_unsupported");
      assert.equal(rejected.retryable, false);
      assert.equal(rejected.state.phase, "error");
      assert.equal(rejected.retryVisible, false);
    }
    assert.equal(result.animationDecoderCalls, 0);
    const recovered = await evaluate("window.__viewerHarness.depth()", 12_000);
    assert.equal(recovered.renderMode, "depth_limited_parallax");
    pass("real APNG and animated WebP bytes are rejected before browser decode while static WebP remains supported", result);
  }, 20_000);

  await stage("canonical-yaw-to-equirectangular-seam", async () => {
    const targets = [359.9, 0, 90, 180, 270];
    const initial = [];
    const focused = [];
    for (const yaw of targets) {
      const value = await evaluate(`window.__viewerHarness.yawMarkerAt(${yaw},'initial')`, 12_000);
      assert.ok(circularDeltaDegrees(value.state.pose.yawDeg, yaw) <= 0.5, JSON.stringify(value));
      assert.ok(circularDeltaDegrees(value.marker.yawDeg, yaw) <= 0.5, JSON.stringify(value));
      initial.push({ target: yaw, ...value });
    }
    for (const yaw of targets) {
      const value = await evaluate(`window.__viewerHarness.yawMarkerAt(${yaw},'focus')`, 12_000);
      assert.ok(circularDeltaDegrees(value.state.pose.yawDeg, yaw) <= 0.5, JSON.stringify(value));
      assert.ok(circularDeltaDegrees(value.marker.yawDeg, yaw) <= 0.5, JSON.stringify(value));
      focused.push({ target: yaw, ...value });
    }
    const rect = await evaluate(`(() => { const r=document.querySelector('.unseen-viewer__canvas').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()`);
    const drag = async (deltaX) => {
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      await resources.client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
      await resources.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + deltaX, y, button: "left", buttons: 1 });
      await resources.client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + deltaX, y, button: "left", buttons: 0, clickCount: 1 });
      return evaluate(`({state:window.__viewerHarness.state(),marker:window.__viewerHarness.readCenterMarkerYaw()})`);
    };
    await evaluate(`window.__viewerHarness.yawMarkerAt(0,'focus')`);
    const draggedRight = await drag(80);
    assert.ok(draggedRight.state.pose.yawDeg > 340, JSON.stringify(draggedRight));
    assert.ok(circularDeltaDegrees(draggedRight.marker.yawDeg, draggedRight.state.pose.yawDeg) <= 0.5, JSON.stringify(draggedRight));
    const draggedLeft = await drag(-160);
    assert.ok(draggedLeft.state.pose.yawDeg > 0 && draggedLeft.state.pose.yawDeg < 30, JSON.stringify(draggedLeft));
    assert.ok(circularDeltaDegrees(draggedLeft.marker.yawDeg, draggedLeft.state.pose.yawDeg) <= 0.5, JSON.stringify(draggedLeft));
    await evaluate("window.__viewerHarness.depth()", 12_000);
    pass("canonical yaw 0 is the equirectangular seam and initial/focus/drag center pixels add at most 0.5 degrees", { initial, focused, draggedRight, draggedLeft });
  }, 120_000);

  await stage("focus-and-return", async () => {
    await evaluate(`window.__viewerHarness.focus({nodeId:'node-a',photoId:'photo-7',photoAssetId:'photo-asset-7',photoAssetVersion:3,photoRawSha256:'${"1".repeat(64)}',placementRevisionId:'placement-7',panoramaRevisionId:'pano-revision-a',returnTarget:'/photos/photo-7',yawDeg:359,pitchDeg:21,fovDeg:64},{animate:false})`);
    const state = await evaluate("window.__viewerHarness.state()");
    assert.equal(state.pose.yawDeg, 359);
    assert.equal(state.pose.pitchDeg, 21);
    assert.equal(state.focus.photoId, "photo-7");
    assert.deepEqual({
      photoAssetId: state.focus.photoAssetId,
      photoAssetVersion: state.focus.photoAssetVersion,
      photoRawSha256: state.focus.photoRawSha256,
    }, {
      photoAssetId: "photo-asset-7",
      photoAssetVersion: 3,
      photoRawSha256: "1".repeat(64),
    });
    await evaluate("document.querySelector('[data-action=return]').click()");
    const request = await evaluate("window.__viewerHarness.returnRequests.at(-1)");
    assert.equal(request.returnTarget, "/photos/photo-7");
    assert.equal(request.photoAssetId, "photo-asset-7");
    assert.equal(request.photoAssetVersion, 3);
    assert.equal(request.photoRawSha256, "1".repeat(64));
    assert.equal(request.placementRevisionId, "placement-7");
    assert.equal(request.panoramaRevisionId, "pano-revision-a");
    pass("photo focus lands exactly and emits the original return target");
  });

  await stage("focus-input-and-revision-validation", async () => {
    const result = await evaluate(`(async () => {
      const base={nodeId:'node-a',photoId:'photo-focus-validation',photoAssetId:'photo-asset-focus-validation',photoAssetVersion:1,photoRawSha256:'${"2".repeat(64)}',placementRevisionId:'placement-focus-validation',panoramaRevisionId:'pano-revision-a'};
      const valid=await window.__viewerHarness.focus({...base,yawDeg:0},{animate:false});
      const capture=async (pose) => { try { await window.__viewerHarness.focus(pose,{animate:false}); return null; } catch(error) { return error.code; } };
      return {
        validYaw:valid.pose.yawDeg,
        missing:await capture(base),
        nan:await capture({...base,yawDeg:NaN}),
        infinity:await capture({...base,yawDeg:Infinity}),
        pitchNan:await capture({...base,yawDeg:0,pitchDeg:NaN}),
        fovInfinity:await capture({...base,yawDeg:0,fovDeg:Infinity}),
        assetVersionInvalid:await capture({...base,photoAssetVersion:1.5,yawDeg:0}),
        assetHashInvalid:await capture({...base,photoRawSha256:'ABC',yawDeg:0}),
        nodeMismatch:await capture({...base,nodeId:'node-stale',yawDeg:0}),
        revisionMismatch:await capture({...base,panoramaRevisionId:'pano-revision-stale',yawDeg:0}),
        finalPose:window.__viewerHarness.state().pose,
      };
    })()`);
    assert.equal(result.validYaw, 0);
    assert.deepEqual(
      [result.missing, result.nan, result.infinity, result.pitchNan, result.fovInfinity],
      Array(5).fill("focus_pose_invalid"),
    );
    assert.equal(result.nodeMismatch, "focus_node_mismatch");
    assert.equal(result.revisionMismatch, "focus_revision_mismatch");
    assert.deepEqual([result.assetVersionInvalid, result.assetHashInvalid], ["focus_identity_invalid", "focus_identity_invalid"]);
    assert.equal(result.finalPose.yawDeg, 0);
    pass("focus accepts exact 0 degrees but rejects missing/non-finite poses, stale nodes, and stale panorama placements", result);
  });

  await stage("pointer-drag", async () => {
    const before = await evaluate("window.__viewerHarness.state().pose.yawDeg");
    const rect = await evaluate(`(() => { const r=document.querySelector('.unseen-viewer__canvas').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()`);
    const x = rect.x + rect.width * 0.5;
    const y = rect.y + rect.height * 0.5;
    await resources.client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await resources.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + 140, y: y + 35, button: "left", buttons: 1 });
    await resources.client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + 140, y: y + 35, button: "left", buttons: 0, clickCount: 1 });
    const after = await evaluate("window.__viewerHarness.state().pose.yawDeg");
    assert.notEqual(after, before);
    pass("real pointer drag changes spherical yaw/pitch", { before, after });
  });

  await stage("keyboard-movement", async () => {
    await evaluate("document.querySelector('.unseen-viewer__canvas').focus()");
    await resources.client.send("Page.bringToFront");
    const before = await evaluate("window.__viewerHarness.state().pose");
    await resources.client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "w", code: "KeyW", text: "w", unmodifiedText: "w", windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 });
    await waitFor("window.__viewerHarness.viewer._movementKeys.has('w') === true", 2_000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await resources.client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "w", code: "KeyW", windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 });
    const after = await evaluate("window.__viewerHarness.state().pose");
    marker("STAGE_OBSERVATION", "keyboard-movement", { before, after });
    assert.ok(Math.hypot(after.x, after.z) > Math.hypot(before.x, before.z));
    const focused = await evaluate(`window.__viewerHarness.focus({nodeId:'node-a',photoId:'photo-after-move',photoAssetId:'photo-asset-after-move',photoAssetVersion:1,photoRawSha256:'${"3".repeat(64)}',placementRevisionId:'placement-after-move',panoramaRevisionId:'pano-revision-a',returnTarget:'/photos/photo-after-move',yawDeg:47,pitchDeg:6},{animate:false})`);
    assert.deepEqual({ yawDeg: focused.pose.yawDeg, pitchDeg: focused.pose.pitchDeg, x: focused.pose.x, z: focused.pose.z }, { yawDeg: 47, pitchDeg: 6, x: 0, z: 0 });
    pass("desktop WASD changes camera x/z and photo focus restores the capture origin", { before, after, focused: focused.pose });
  });

  await stage("assistive-four-direction-translation", async () => {
    const result = await evaluate(`(() => {
      const group=document.querySelector('.unseen-viewer__translation-controls');
      const buttons=[...group.querySelectorAll('button')];
      const semantics={role:group.getAttribute('role'),label:group.getAttribute('aria-label'),buttons:buttons.map((button)=>{
        const rect=button.getBoundingClientRect();
        return {direction:button.dataset.translation,name:button.getAttribute('aria-label'),width:rect.width,height:rect.height,display:getComputedStyle(button).display};
      })};
      const positions={};
      for(const direction of ['forward','right','left']){
        window.__viewerHarness.reset();
        const button=group.querySelector('[data-translation='+direction+']');
        for(let index=0;index<30;index+=1) button.click();
        positions[direction]=window.__viewerHarness.state().pose;
      }
      return {semantics,positions,live:document.querySelector('[data-direction-live]').textContent};
    })()`);
    assert.equal(result.semantics.role, "group");
    assert.equal(result.semantics.label, "现场四向平移控制");
    assert.deepEqual(result.semantics.buttons.map(({ direction }) => direction).sort(), ["backward", "forward", "left", "right"]);
    assert.ok(result.semantics.buttons.every(({ name, width, height, display }) => name && width >= 44 && height >= 44 && display !== "none"), JSON.stringify(result));
    const radii = Object.values(result.positions).map(({ x, z }) => Math.hypot(x, z));
    assert.ok(radii.every((radius) => radius <= 0.42 + 1e-12), JSON.stringify(result));
    assert.equal(new Set(radii.map((radius) => radius.toFixed(6))).size, 3, JSON.stringify(result));
    assert.match(result.live, /安全边界/);
    await evaluate("window.__viewerHarness.reset()");
    pass("named 44px four-direction controls move real x/z to three unequal bounded envelopes and announce the boundary", result);
  });

  await stage("reset", async () => {
    await evaluate("document.querySelector('[data-action=reset]').click()");
    const state = await evaluate("window.__viewerHarness.state()");
    assert.deepEqual({ yawDeg: state.pose.yawDeg, pitchDeg: state.pose.pitchDeg, x: state.pose.x, z: state.pose.z }, { yawDeg: 15, pitchDeg: -4, x: 0, z: 0 });
    assert.equal(state.focus, null);
    pass("the reset control restores saved pose and origin");
  });

  await stage("accessibility-controls", async () => {
    await resources.client.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    const result = await evaluate(`(async () => {
      const startedAt = performance.now();
      await window.__viewerHarness.focus({nodeId:'node-a',photoId:'photo-a11y',photoAssetId:'photo-asset-a11y',photoAssetVersion:1,photoRawSha256:'${"4".repeat(64)}',placementRevisionId:'placement-a11y',panoramaRevisionId:'pano-revision-a',returnTarget:'/photos/photo-a11y',yawDeg:205,pitchDeg:8},{animate:true,durationMs:1000});
      const elapsedMs = performance.now() - startedAt;
      const root = document.querySelector('.unseen-viewer');
      const canvas = root.querySelector('.unseen-viewer__canvas');
      const overlay = root.querySelector('.unseen-viewer__hud');
      const controls = root.querySelector('.unseen-viewer__controls');
      const status = root.querySelector('[role=status]');
      const visibleButtonSizes = [...root.querySelectorAll('button')]
        .filter((button) => getComputedStyle(button).display !== 'none' && !button.hidden)
        .map((button) => { const rect=button.getBoundingClientRect(); return {action:button.dataset.action||button.className,width:rect.width,height:rect.height}; });
      return {
        elapsedMs,
        reducedMotion:getComputedStyle(root).scrollBehavior === 'auto' || matchMedia('(prefers-reduced-motion: reduce)').matches,
        canvasRole:canvas.getAttribute('role'),
        canvasTabIndex:canvas.tabIndex,
        overlayPointerEvents:getComputedStyle(overlay).pointerEvents,
        controlsPointerEvents:getComputedStyle(controls).pointerEvents,
        ariaLive:status.getAttribute('aria-live'),
        visibleButtonSizes,
      };
    })()`);
    await resources.client.send("Emulation.setEmulatedMedia", { features: [] });
    assert.equal(result.reducedMotion, true);
    assert.ok(result.elapsedMs < 150, `reduced-motion focus took ${result.elapsedMs}ms`);
    assert.equal(result.canvasRole, "application");
    assert.equal(result.canvasTabIndex, 0);
    assert.equal(result.overlayPointerEvents, "none");
    assert.equal(result.controlsPointerEvents, "auto");
    assert.equal(result.ariaLive, "polite");
    assert.ok(result.visibleButtonSizes.length >= 3);
    assert.ok(result.visibleButtonSizes.every(({ width, height }) => width >= 44 && height >= 44), JSON.stringify(result.visibleButtonSizes));
    pass("keyboard surface, live status, 44px controls, pass-through overlay, and reduced motion are enforced", result);
  });

  await stage("photo-cta-keyboard-return-focus-loop", async () => {
    const result = await evaluate(`(async () => {
      const origin=document.querySelector('#depth');
      origin.focus();
      const onReturn=(event) => { window.__viewerHarness.viewer.removeEventListener('returnrequest',onReturn); origin.focus(); };
      window.__viewerHarness.viewer.addEventListener('returnrequest',onReturn);
      const focused=await window.__viewerHarness.focus({nodeId:'node-a',photoId:'cta-photo',photoAssetId:'cta-asset',photoAssetVersion:2,photoRawSha256:'${"7".repeat(64)}',placementRevisionId:'cta-placement',panoramaRevisionId:'pano-revision-a',returnTarget:'/photos/cta-photo',yawDeg:90},{animate:false,focusOnComplete:true});
      const activeAfterFocus=document.activeElement===document.querySelector('.unseen-viewer__canvas');
      document.querySelector('.unseen-viewer__canvas').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
      const yawAfterKey=window.__viewerHarness.state().pose.yawDeg;
      document.querySelector('[data-action=return]').click();
      return {activeAfterFocus,yawAfterKey,activeAfterReturn:document.activeElement.id,focusedYaw:focused.pose.yawDeg};
    })()`);
    assert.equal(result.activeAfterFocus, true);
    assert.equal(result.focusedYaw, 90);
    assert.equal(result.yawAfterKey, 95);
    assert.equal(result.activeAfterReturn, "depth");
    pass("photo CTA focusOnComplete enters canvas keyboard orbit and returnrequest restores the originating photo control", result);
  });

  await stage("focus-animation-interruptions", async () => {
    let nonce = 0;
    const startFocus = async () => {
      nonce += 1;
      await evaluate(`(() => {
        const pose={nodeId:'node-a',photoId:'interrupt-${nonce}',photoAssetId:'interrupt-asset-${nonce}',photoAssetVersion:1,photoRawSha256:'${"8".repeat(64)}',placementRevisionId:'interrupt-placement-${nonce}',panoramaRevisionId:'pano-revision-a',yawDeg:270,pitchDeg:12};
        window.__focusInterruptionResult=window.__viewerHarness.focus(pose,{animate:true,durationMs:1000}).then(()=>({result:'resolved'}),error=>({result:'rejected',code:error.code}));
        return true;
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 40));
    };
    const finish = async (name) => {
      const result = await evaluate("window.__focusInterruptionResult");
      assert.deepEqual(result, { result: "rejected", code: "focus_cancelled" }, name);
      const state = await evaluate("window.__viewerHarness.state()");
      assert.equal(state.focus, null, name);
      assert.equal(await evaluate("document.querySelector('[data-action=return]')?.hidden ?? true"), true, name);
      assert.doesNotMatch(await evaluate("document.querySelector('[role=status]')?.textContent || ''"), /已回到照片所在位置/, name);
      return result;
    };
    const outcomes = {};
    await evaluate("window.__viewerHarness.depth()", 12_000);
    let rect = await evaluate(`(() => { const r=document.querySelector('.unseen-viewer__canvas').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()`);
    await startFocus();
    await resources.client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, button: "left", buttons: 1, clickCount: 1 });
    await resources.client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, button: "left", buttons: 0, clickCount: 1 });
    outcomes.pointer = await finish("pointer");
    await startFocus();
    await resources.client.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, deltaX: 0, deltaY: 120 });
    outcomes.wheel = await finish("wheel");
    await evaluate("document.querySelector('.unseen-viewer__canvas').focus()");
    await startFocus();
    await resources.client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 });
    await resources.client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 });
    outcomes.key = await finish("key");
    await startFocus();
    await evaluate("window.__viewerHarness.reset()");
    outcomes.reset = await finish("reset");
    await startFocus();
    await evaluate("window.__viewerHarness.depth()", 12_000);
    outcomes.updateScene = await finish("updateScene");
    await startFocus();
    await evaluate("window.__viewerHarness.viewer.dispose()");
    outcomes.dispose = await finish("dispose");
    await evaluate("window.__viewerHarness.viewer.mount(document.querySelector('#viewer'),window.__viewerHarness.depthScene)", 12_000);
    pass("pointer, wheel, key, reset, updateScene, and dispose reject interrupted focus instead of resolving false success", outcomes);
  }, 60_000);

  await stage("fullscreen-resize", async () => {
    assert.equal(await evaluate("window.__viewerHarness.state().capability.fullscreen"), true);
    let rect = await evaluate(`(() => { const r=document.querySelector('[data-action=fullscreen]').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()`);
    await resources.client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, button: "left", buttons: 1, clickCount: 1 });
    await resources.client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, button: "left", buttons: 0, clickCount: 1 });
    await waitFor("document.fullscreenElement?.classList.contains('unseen-viewer') === true", 4_000);
    const entered = await evaluate(`(() => { const root=document.querySelector('.unseen-viewer'); const canvas=root.querySelector('canvas'); const r=root.getBoundingClientRect(); return {button:root.querySelector('[data-action=fullscreen]').textContent,rootWidth:r.width,rootHeight:r.height,canvasWidth:canvas.width,canvasHeight:canvas.height,dpr:devicePixelRatio}; })()`);
    assert.equal(entered.button, "退出全屏");
    assert.equal(entered.canvasWidth, Math.round(entered.rootWidth * entered.dpr));
    assert.equal(entered.canvasHeight, Math.round(entered.rootHeight * entered.dpr));
    rect = await evaluate(`(() => { const r=document.querySelector('[data-action=fullscreen]').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()`);
    await resources.client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, button: "left", buttons: 1, clickCount: 1 });
    await resources.client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, button: "left", buttons: 0, clickCount: 1 });
    await waitFor("document.fullscreenElement === null && document.querySelector('[data-action=fullscreen]').textContent === '全屏'", 4_000);
    assert.equal(await evaluate("document.querySelector('[data-action=fullscreen]').textContent"), "全屏");
    pass("the real fullscreen control enters, resizes at DPR, and exits cleanly", entered);
  });

  await stage("product-runtime-timeout", async () => {
    const results = {};
    for (const mode of ['fetch','body','decoder','depth-decoder']) {
      try {
        results[mode] = await evaluate(`window.__viewerHarness.runtimeTimeoutCounterexample('${mode}').catch((error) => ({
          internalError: { name: error.name, code: error.code, message: error.message, stack: error.stack }
        }))`, 10_000);
      } catch (error) {
        throw new Error(`${mode}: ${error.message}`, { cause: error });
      }
    }
    for (const [mode, result] of Object.entries(results)) {
      assert.equal(result.internalError, undefined, `${mode}: ${JSON.stringify(result.internalError)}`);
      assert.ok(result.failureElapsedMs >= 1_500 && result.failureElapsedMs < 3_000, `${mode}: ${JSON.stringify(result)}`);
      assert.equal(result.failure?.code, "asset_timeout");
      assert.equal(result.retryVisible, true);
      assert.equal(result.failureFocus, "retry");
      assert.equal(result.recoveryFocus, "canvas");
      assert.equal(result.activeTimers, 0);
      assert.equal(result.activeObjectUrls, 0);
      assert.deepEqual(
        { roots: result.roots, canvases: result.canvases, gpu: result.gpu, retainedAssets: result.retainedAssets },
        { roots: 0, canvases: 0, gpu: false, retainedAssets: 0 },
      );
    }
    assert.equal(results.fetch.decoderCallsAtFailure, 0);
    assert.equal(results.body.decoderCallsAtFailure, 0);
    assert.ok(results.body.readerCancelCalls >= 1);
    assert.equal(results.decoder.decoderCallsAtFailure, 1);
    assert.equal(results.decoder.lateBitmapClosed, 1);
    assert.equal(results['depth-decoder'].decoderCallsAtFailure, 2);
    assert.equal(results['depth-decoder'].phase, "ready");
    assert.equal(results['depth-decoder'].renderMode, "rotation360");
    assert.equal(results['depth-decoder'].lateBitmapClosed, 1);
    pass("hung fetch, body reader, color decoder, and depth decoder all time out, clean up, focus retry, and recover with a new deadline", results);
  }, 35_000);

  await stage("partial-gpu-allocation-cleanup", async () => {
    const link = await evaluate("window.__viewerHarness.gpuFailureCounterexample('link')", 20_000);
    const secondTexture = await evaluate("window.__viewerHarness.gpuFailureCounterexample('second-texture')", 20_000);
    assert.equal(link.failure.code, "webgl_link_failed");
    assert.equal(secondTexture.failure.code, "texture_upload_failed");
    for (const result of [link, secondTexture]) {
      assert.equal(result.renderMode, "flat_fallback");
      assert.equal(result.recovered, "depth_limited_parallax");
      for (const [kind, counts] of Object.entries(result.counts)) {
        assert.equal(counts.deleted, counts.created, `${result.mode}/${kind}: ${JSON.stringify(result)}`);
      }
    }
    assert.equal(secondTexture.counts.texture.created, 2);
    pass("link and second-texture failures delete every incremental GPU object even without WEBGL_lose_context, then retry succeeds", { link, secondTexture });
  }, 45_000);

  await stage("focus-recovery-failures", async () => {
    const result = await evaluate("window.__viewerHarness.retryFocusCounterexample()", 15_000);
    assert.equal(result.firstFailure, "panorama_hash_mismatch");
    assert.equal(result.afterProgrammaticFailure, "retry", JSON.stringify(result));
    assert.equal(result.secondFailure, "panorama_ratio_invalid");
    assert.equal(result.retryHidden, true);
    assert.equal(result.afterNonRetryableFailure, "status");
    pass("focused canvas moves to retry on programmatic failure and retryable-to-nonretryable failure moves focus to status", result);
  }, 20_000);

  await stage("focus-recovery-cancellation", async () => {
    const result = await evaluate("window.__viewerHarness.focusCancellationCounterexample()", 20_000);
    assert.deepEqual(result, {
      afterDispose: "focus-cancellation-sentinel",
      duringSupersede: "focus-cancellation-sentinel",
      afterSupersede: "focus-cancellation-sentinel",
    });
    pass("dispose and a superseding scene invalidate queued focus recovery without stealing external focus", result);
  }, 25_000);

  await stage("signed-url-retry-request", async () => {
    const result = await evaluate("window.__viewerHarness.signedUrlRetryCounterexample()", 15_000);
    assert.equal(result.initialFailure, "asset_fetch_failed");
    assert.equal(result.defaultPrevented, true);
    assert.equal(result.expiredFetches, 1);
    assert.equal(result.eventDetail.failure.code, "asset_fetch_failed");
    assert.equal(result.eventDetail.sceneId, "signed-scene");
    assert.equal(result.eventDetail.panoramaRevisionId, "pano-revision-a");
    assert.equal(result.renderMode, "rotation360");
    assert.equal(result.activeAfterRecovery, "canvas");
    pass("cancelable retryrequest lets the host replace an expired signed URL without replaying it", result);
  }, 20_000);

  await stage("programmatic-update-preserves-external-focus", async () => {
    const result = await evaluate(`(async () => {
      const control=document.querySelector('#depth');
      control.focus();
      const before=document.activeElement.id;
      await window.__viewerHarness.depth();
      return {before,after:document.activeElement.id};
    })()`, 12_000);
    assert.deepEqual(result, { before: "depth", after: "depth" });
    pass("successful programmatic updateScene does not steal focus outside the viewer", result);
  }, 20_000);

  await stage("fallback-retry", async () => {
    let state = await evaluate("window.__viewerHarness.fallback()");
    assert.equal(state.renderMode, "flat_fallback");
    assert.equal(state.failure.code, "webgl_unavailable");
    const flatFocus = await evaluate(`(async () => {
      try {
        await window.__viewerHarness.focus({nodeId:'node-a',photoId:'flat-photo',photoAssetId:'flat-asset',photoAssetVersion:1,photoRawSha256:'${"6".repeat(64)}',placementRevisionId:'flat-placement',panoramaRevisionId:'pano-revision-a',yawDeg:90},{animate:false});
      } catch(error) {
        return {code:error.code,state:window.__viewerHarness.state(),status:document.querySelector('[role=status]').textContent,returnHidden:document.querySelector('[data-action=return]').hidden};
      }
    })()`);
    assert.equal(flatFocus.code, "spherical_view_unavailable");
    assert.equal(flatFocus.state.focus, null);
    assert.equal(flatFocus.returnHidden, true);
    assert.doesNotMatch(flatFocus.status, /已回到照片所在位置/);
    state = await evaluate(`(async () => {
      window.__forceWebGLFailure=false;
      document.querySelector('[data-action=retry]').click();
      const deadline=performance.now()+10000;
      while(performance.now()<deadline){
        const state=window.__viewerHarness.state();
        if(state.phase==='ready' && state.renderMode==='rotation360') return state;
        await new Promise((resolve)=>setTimeout(resolve,25));
      }
      throw new Error('retry control did not recover');
    })()`, 12_000);
    assert.equal(state.renderMode, "rotation360");
    pass("flat fallback exposes a working retry control");
  }, 20_000);

  await stage("focus-render-failure-settles", async () => {
    const result = await evaluate("window.__viewerHarness.focusRenderFailureCounterexample()", 8_000);
    assert.deepEqual(result.animated, { result: "rejected", code: "spherical_view_unavailable" });
    assert.ok(result.animatedElapsedMs < 1_500, JSON.stringify(result));
    assert.deepEqual(result.flat, { result: "rejected", code: "spherical_view_unavailable" });
    assert.ok(result.flatElapsedMs < 500, JSON.stringify(result));
    assert.equal(result.fallbackState.renderMode, "flat_fallback");
    assert.equal(result.fallbackState.capability.sphericalView, false);
    assert.equal(result.fallbackState.focus, null);
    assert.equal(result.returnHidden, true);
    assert.equal(result.active, "retry");
    assert.doesNotMatch(result.status, /已回到照片所在位置/);
    pass("animated render failure and an existing flat fallback both reject public focusPose within a hard bound", result);
  }, 12_000);

  await stage("depth-integrity-degrade", async () => {
    let deterministic = await evaluate("window.__viewerHarness.invalidDepth()");
    assert.equal(deterministic.renderMode, "rotation360");
    assert.equal(deterministic.failure.code, "depth_quality_invalid");
    assert.equal(deterministic.failure.retryable, false);
    assert.equal(await evaluate("document.querySelector('[data-action=retry]').hidden"), true);
    deterministic = await evaluate("window.__viewerHarness.depth()");
    assert.equal(deterministic.renderMode, "depth_limited_parallax");
    let state = await evaluate("window.__viewerHarness.badDepth()");
    assert.equal(state.renderMode, "rotation360");
    assert.equal(state.capability.translation, false);
    assert.equal(state.failure.code, "depth_hash_mismatch");
    state = await evaluate("window.__viewerHarness.depth()");
    assert.equal(state.renderMode, "depth_limited_parallax");
    pass("deterministic invalid depth has no dead-end retry, while host refresh and retryable hash failure can restore bounded translation");
  }, 20_000);

  await stage("context-loss-recovery", async () => {
    await evaluate(`(() => {
      document.querySelector('.unseen-viewer__canvas').focus();
      window.__contextLossFocus=window.__viewerHarness.focus({nodeId:'node-a',photoId:'context-loss-photo',photoAssetId:'context-loss-asset',photoAssetVersion:1,photoRawSha256:'${"9".repeat(64)}',placementRevisionId:'context-loss-placement',panoramaRevisionId:'pano-revision-a',yawDeg:250,pitchDeg:10},{animate:true,durationMs:1000}).then(()=>({result:'resolved'}),error=>({result:'rejected',code:error.code}));
      return true;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await evaluate("window.__viewerHarness.loseContext()"), true);
    await waitFor("window.__viewerHarness.state().renderMode === 'flat_fallback' && window.__viewerHarness.state().failure.code === 'webgl_context_lost'", 4_000);
    await waitFor("document.activeElement === document.querySelector('[data-action=retry]')", 4_000);
    const cancelled = await evaluate("window.__contextLossFocus");
    assert.deepEqual(cancelled, { result: "rejected", code: "focus_cancelled" });
    assert.equal(await evaluate("window.__viewerHarness.state().focus"), null);
    assert.equal(await evaluate("window.__viewerHarness.viewer._animation"), 0);
    assert.doesNotMatch(await evaluate("document.querySelector('[role=status]').textContent"), /已回到照片所在位置/);
    let recovered = await evaluate(`(async () => {
      document.querySelector('[data-action=retry]').click();
      const deadline=performance.now()+10000;
      while(performance.now()<deadline){
        const state=window.__viewerHarness.state();
        if(state.phase==='ready' && state.renderMode==='depth_limited_parallax' && document.activeElement===document.querySelector('.unseen-viewer__canvas')) return state;
        await new Promise((resolve)=>setTimeout(resolve,25));
      }
      throw new Error('default retry did not restore canvas focus');
    })()`, 12_000);
    assert.equal(recovered.renderMode, "depth_limited_parallax");
    await evaluate("document.querySelector('.unseen-viewer__canvas').focus()");
    await resources.client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "w", code: "KeyW", text: "w", unmodifiedText: "w", windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 });
    await waitFor("window.__viewerHarness.viewer._movementFrame !== 0 && window.__viewerHarness.viewer._movementKeys.has('w')", 2_000);
    assert.equal(await evaluate("window.__viewerHarness.loseContext()"), true);
    await waitFor("window.__viewerHarness.state().failure?.code === 'webgl_context_lost'", 4_000);
    assert.deepEqual(await evaluate(`({frame:window.__viewerHarness.viewer._movementFrame,keys:window.__viewerHarness.viewer._movementKeys.size,failure:window.__viewerHarness.state().failure.code,status:document.querySelector('[role=status]').textContent})`), {
      frame: 0,
      keys: 0,
      failure: "webgl_context_lost",
      status: "当前设备暂时无法环视，已显示平面图。 可使用“重试”再次尝试。",
    });
    recovered = await evaluate(`(async () => {
      document.querySelector('[data-action=retry]').click();
      const deadline=performance.now()+10000;
      while(performance.now()<deadline){
        const state=window.__viewerHarness.state();
        if(state.phase==='ready' && state.renderMode==='depth_limited_parallax') return state;
        await new Promise((resolve)=>setTimeout(resolve,25));
      }
      throw new Error('movement context-loss retry did not recover');
    })()`, 12_000);
    assert.equal(recovered.renderMode, "depth_limited_parallax");
    pass("context loss atomically cancels focus and held WASD before fallback, then default retry recovers without a stale success frame", { cancelled, recovered });
  }, 20_000);

  await stage("dispose-remount", async () => {
    for (let index = 0; index < 4; index += 1) await evaluate("window.__viewerHarness.remount()", 12_000);
    const nodes = await evaluate(`({roots:document.querySelectorAll('.unseen-viewer').length,canvases:document.querySelectorAll('.unseen-viewer__canvas').length,children:document.querySelector('#viewer').children.length})`);
    assert.deepEqual(nodes, { roots: 1, canvases: 1, children: 2 });
    pass("four dispose/remount cycles leave one root and one canvas", nodes);
  }, 55_000);

  await stage("desktop-layout", async () => {
    await setViewport(1280, 800, false, false);
    await evaluate("window.__viewerHarness.depth()", 12_000);
    const layout = await evaluate(`({overflow:document.documentElement.scrollWidth>innerWidth,joystick:getComputedStyle(document.querySelector('.unseen-viewer__joystick')).display,width:innerWidth})`);
    assert.equal(layout.overflow, false);
    assert.equal(layout.joystick, "none");
    await screenshot("viewer-1280.png");
    pass("1280 desktop has no horizontal overflow or spare joystick", layout);
  }, 20_000);

  await stage("mobile-touch-layout", async () => {
    await setViewport(390, 844, true, true, 2);
    // Reload after changing the emulated device so coarse-pointer media queries
    // and WebGL are initialized under the final mobile environment.
    await resources.client.send("Page.navigate", { url: `${resources.pageOrigin}/harness/index.html?mobile=1` });
    await waitFor("window.__viewerHarnessReady === true && window.__viewerHarness.state().phase === 'ready'", 15_000);
    let layout = await evaluate(`({overflow:document.documentElement.scrollWidth>innerWidth,joystick:getComputedStyle(document.querySelector('.unseen-viewer__joystick')).display,width:innerWidth,canvasWidth:document.querySelector('.unseen-viewer__canvas').width,canvasCssWidth:document.querySelector('.unseen-viewer__canvas').getBoundingClientRect().width})`);
    assert.equal(layout.overflow, false);
    assert.equal(layout.joystick, "block");
    assert.equal(layout.canvasWidth, Math.round(layout.canvasCssWidth * 2));
    await setViewport(844, 390, true, true, 2);
    await waitFor("document.querySelector('.unseen-viewer__canvas').width === Math.round(document.querySelector('.unseen-viewer__canvas').getBoundingClientRect().width * 2)", 3_000);
    assert.equal(await evaluate("document.documentElement.scrollWidth > innerWidth"), false);
    await setViewport(390, 844, true, true, 2);
    await waitFor("document.querySelector('.unseen-viewer__canvas').width === Math.round(document.querySelector('.unseen-viewer__canvas').getBoundingClientRect().width * 2)", 3_000);
    layout = await evaluate(`({overflow:document.documentElement.scrollWidth>innerWidth,joystick:getComputedStyle(document.querySelector('.unseen-viewer__joystick')).display,width:innerWidth,canvasWidth:document.querySelector('.unseen-viewer__canvas').width,canvasCssWidth:document.querySelector('.unseen-viewer__canvas').getBoundingClientRect().width})`);

    const rect = await evaluate(`(() => { const r=document.querySelector('.unseen-viewer__canvas').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()`);
    const yawBefore = await evaluate("window.__viewerHarness.state().pose.yawDeg");
    const x = rect.x + rect.width * 0.55;
    const y = rect.y + rect.height * 0.4;
    await resources.client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, radiusX: 5, radiusY: 5, force: 1, id: 1 }] });
    await resources.client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - 90, y: y + 25, radiusX: 5, radiusY: 5, force: 1, id: 1 }] });
    await resources.client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const yawAfter = await evaluate("window.__viewerHarness.state().pose.yawDeg");
    assert.notEqual(yawAfter, yawBefore);

    const fovBefore = await evaluate("window.__viewerHarness.state().pose.fovDeg");
    const pinchY = rect.y + rect.height * 0.55;
    await resources.client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [
      { x: rect.x + rect.width * 0.38, y: pinchY, radiusX: 5, radiusY: 5, force: 1, id: 3 },
      { x: rect.x + rect.width * 0.62, y: pinchY, radiusX: 5, radiusY: 5, force: 1, id: 4 },
    ] });
    await resources.client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [
      { x: rect.x + rect.width * 0.25, y: pinchY, radiusX: 5, radiusY: 5, force: 1, id: 3 },
      { x: rect.x + rect.width * 0.75, y: pinchY, radiusX: 5, radiusY: 5, force: 1, id: 4 },
    ] });
    await resources.client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const fovAfter = await evaluate("window.__viewerHarness.state().pose.fovDeg");
    assert.notEqual(fovAfter, fovBefore);

    const joystick = await evaluate(`(() => { const r=document.querySelector('.unseen-viewer__joystick').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()`);
    const before = await evaluate("window.__viewerHarness.state().pose");
    const joyX = joystick.x + joystick.width / 2;
    const joyY = joystick.y + joystick.height / 2;
    await resources.client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: joyX, y: joyY - 30, radiusX: 5, radiusY: 5, force: 1, id: 2 }] });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await resources.client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const after = await evaluate("window.__viewerHarness.state().pose");
    assert.ok(Math.hypot(after.x - before.x, after.z - before.z) > 0.01);
    await evaluate("window.__viewerHarness.reset()");
    await screenshot("viewer-390.png");
    pass("390 touch layout supports real drag, pinch, and a visible working joystick", { layout, yawBefore, yawAfter, fovBefore, fovAfter, before, after });
  }, 25_000);

  await stage("customer-message-technical-blacklist", async () => {
    const snapshots = await evaluate(`(async () => {
      const values=[];
      const capture=(code)=>values.push({code,text:document.querySelector('.unseen-viewer').innerText});
      await window.__viewerHarness.invalidDepth(); capture(window.__viewerHarness.state().failure.code);
      await window.__viewerHarness.viewer.updateScene({...window.__viewerHarness.lookScene,sceneMode:'walkable3d'}); capture(window.__viewerHarness.state().failure.code);
      window.__forceWebGLFailure=true; await window.__viewerHarness.look(); capture(window.__viewerHarness.state().failure.code);
      window.__forceWebGLFailure=false; await window.__viewerHarness.depth();
      return values;
    })()`, 20_000);
    for (const snapshot of snapshots) assert.doesNotMatch(snapshot.text, /artifact|webgl|着色器|纹理|完整\s*3d/i, JSON.stringify(snapshot));
    pass("visible HUD messages keep stable technical codes out of customer-facing text", snapshots);
  }, 25_000);

  await stage("console-network-zero", async () => {
    assert.equal(consoleErrors.length, 0);
    assert.equal(browserLogErrors.length, 0);
    assert.equal(exceptions.length, 0);
    assert.equal(networkFailures.length, 0);
    assert.equal(networkHttpErrors.length, 0);
    assert.equal(externalRequests.length, 0);
    pass("console and network errors are zero", { requests: requests.length });
  });

  const finalState = await evaluate("window.__viewerHarness.state()");
  const report = {
    schemaVersion: "unseen-viewer-browser-evidence/1",
    runId,
    browser: browserVersion.Browser || target.browser || "Chrome DevTools",
    viewportCoverage: [1280, 390],
    assertions,
    stages,
    finalState,
    consoleErrors: consoleErrors.length,
    browserLogErrors: browserLogErrors.length,
    runtimeExceptions: exceptions.length,
    networkFailures: networkFailures.length,
    networkHttpErrors,
    externalRequests,
    requestedUrls: [...new Set(requests)],
    screenshots: ["screenshots/viewer-1280.png", "screenshots/viewer-390.png"],
  };
  fs.writeFileSync(path.join(evidenceRoot, "browser-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  marker("BROWSER_PASS", `${assertions.length}-assertions`);
}

try {
  await withTimeout(suite(), globalTimeoutMs, "global-browser-suite");
} catch (error) {
  suiteFailure = error;
  process.exitCode = 1;
  marker("BROWSER_FAIL", error.code || error.name, { message: error.message });
  fs.writeFileSync(failureReportPath, `${JSON.stringify({
    schemaVersion: "unseen-viewer-browser-failure/1",
    runId,
    failure: { code: error.code || error.name, message: error.message, stack: error.stack },
    stages,
    assertions,
    consoleErrors,
    browserLogErrors,
    exceptions,
    networkFailures,
    networkHttpErrors,
    externalRequests,
  }, null, 2)}\n`);
} finally {
  const cleanupReport = await cleanup(suiteFailure ? "failure" : "success");
  if (!cleanupReport.serverClosed || !cleanupReport.chromeExited || cleanupReport.orphanProcessCount !== 0 || !cleanupReport.profileRemoved) {
    process.exitCode = 1;
    marker("RUNNER_CLEANUP_FAIL", "owned-resources-remain", cleanupReport);
  }
}
