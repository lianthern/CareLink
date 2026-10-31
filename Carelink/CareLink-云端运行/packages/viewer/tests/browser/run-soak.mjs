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
const evidencePath = process.env.UNSEEN_VIEWER_SOAK_REPORT || path.join(evidenceRoot, "soak-report.json");
const acceptanceDurationMs = 30 * 60 * 1_000;
const requestedDurationMs = Math.max(1_000, Number(process.env.UNSEEN_VIEWER_SOAK_DURATION_MS) || acceptanceDurationMs);
const operationTimeoutMs = Math.max(5_000, Number(process.env.UNSEEN_VIEWER_SOAK_OPERATION_TIMEOUT_MS) || 15_000);
const globalTimeoutMs = Math.max(
  requestedDurationMs + 60_000,
  Number(process.env.UNSEEN_VIEWER_SOAK_GLOBAL_TIMEOUT_MS) || requestedDurationMs + 180_000,
);
const runId = process.env.UNSEEN_VIEWER_RUN_ID || `soak-${crypto.randomUUID()}`;
fs.mkdirSync(screenshotRoot, { recursive: true });

const resources = {
  server: null,
  port: null,
  origin: null,
  chrome: null,
  chromeExited: false,
  chromeExit: null,
  profile: null,
  client: null,
};
const stages = [];
const assertions = [];
const consoleErrors = [];
const exceptions = [];
const networkFailures = [];
const networkHttpErrors = [];
const externalRequests = [];
const samples = [];
let chromeStderr = "";
let cleanupPromise = null;
let failure = null;
let evidence = null;

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

async function stage(name, task, milliseconds = operationTimeoutMs) {
  marker("STAGE_START", name, { timeoutMs: milliseconds });
  try {
    const result = await withTimeout(task(), milliseconds, `stage:${name}`);
    marker("STAGE_PASS", name);
    return result;
  } catch (error) {
    marker("STAGE_FAIL", name, { code: error.code || error.name, message: error.message });
    throw error;
  }
}

function assertPass(condition, name, detail = null) {
  if (!condition) {
    const error = new Error(`${name}: ${JSON.stringify(detail)}`);
    error.code = "SOAK_ASSERTION_FAILED";
    marker("ASSERT_FAIL", name, detail);
    throw error;
  }
  assertions.push({ name, status: "PASS", detail });
  marker("ASSERT_PASS", name, detail);
}

function processCountForProfile(profile) {
  if (!profile) return 0;
  const output = spawnSync("ps", ["-axo", "command="], { encoding: "utf8" }).stdout || "";
  return output.split("\n").filter((line) => line.includes(profile)).length;
}

async function closeServer(server) {
  if (!server?.listening) return true;
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  return true;
}

async function waitForChildExit(child, milliseconds) {
  if (!child || resources.chromeExited) return true;
  return withTimeout(new Promise((resolve) => child.once("exit", () => resolve(true))), milliseconds, "chrome-exit")
    .catch(() => false);
}

async function cleanup(reason) {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    marker("CLEANUP_START", reason);
    resources.client?.close();
    resources.client = null;
    let serverClosed = false;
    try { serverClosed = await withTimeout(closeServer(resources.server), 2_000, "server-close"); } catch {}
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
    const result = {
      reason,
      serverClosed,
      chromeExited: resources.chromeExited,
      chromeExit: resources.chromeExit,
      usedSigkill,
      profileRemoved,
      orphanProcessCount,
    };
    marker(serverClosed && resources.chromeExited && profileRemoved && orphanProcessCount === 0 ? "CLEANUP_PASS" : "CLEANUP_FAIL", reason, result);
    return result;
  })();
  return cleanupPromise;
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
    });
    fs.createReadStream(filename).pipe(response);
  });
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function chromeExecutable() {
  return [
    process.env.UNSEEN_CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean).find((candidate) => fs.existsSync(candidate));
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

  send(method, params = {}, milliseconds = operationTimeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(timeoutError(`cdp:${method}`, milliseconds));
      }, milliseconds);
      this.pending.set(id, { resolve, reject, method, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  on(method, listener) {
    this.listeners.set(method, [...(this.listeners.get(method) || []), listener]);
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

async function evaluate(expression, milliseconds = operationTimeoutMs) {
  const result = await resources.client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, milliseconds);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Runtime evaluation failed");
  return result.result?.value;
}

async function waitFor(expression, milliseconds = operationTimeoutMs) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await evaluate(expression, Math.min(2_000, milliseconds))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

async function sample() {
  return evaluate(`(() => ({
    ...window.__viewerHarness.resourceSnapshot(),
    heapBytes:performance.memory?.usedJSHeapSize ?? null,
  }))()`);
}

function updatePeak(peak, value) {
  for (const [key, current] of Object.entries(value)) {
    if (typeof current === "number" && Number.isFinite(current)) peak[key] = Math.max(peak[key] ?? current, current);
  }
}

function metric(baseline, peak, steadyFinal, postDispose, baselineKey, peakKey = baselineKey) {
  return {
    baseline: baseline[baselineKey],
    peak: peak[peakKey],
    steadyFinal: steadyFinal[baselineKey],
    final: postDispose[baselineKey],
  };
}

async function runSoak() {
  let browser;
  let processPeak = 0;
  await stage("server-start", async () => {
    resources.server = createServer();
    await new Promise((resolve) => resources.server.listen(0, "127.0.0.1", resolve));
    resources.port = resources.server.address().port;
    resources.origin = `http://127.0.0.1:${resources.port}`;
  });

  await stage("browser-launch", async () => {
    const executable = chromeExecutable();
    if (!executable) throw new Error("Chrome/Chromium not found; set UNSEEN_CHROME");
    resources.debugPort = await freePort();
    resources.profile = fs.mkdtempSync(path.join(os.tmpdir(), `unseen-viewer-soak-${runId}-`));
    resources.chrome = spawn(executable, [
      "--headless=new",
      `--remote-debugging-port=${resources.debugPort}`,
      `--user-data-dir=${resources.profile}`,
      "--window-size=1280,800",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--enable-precise-memory-info",
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
    browser = await waitForChrome();
    const targetResponse = await fetch(`http://127.0.0.1:${resources.debugPort}/json/new?${encodeURIComponent(`${resources.origin}/harness/index.html?soak=1`)}`, { method: "PUT" });
    const target = await targetResponse.json();
    resources.client = new Cdp(target.webSocketDebuggerUrl);
    await resources.client.open();
    resources.client.on("Runtime.consoleAPICalled", (event) => {
      if (event.type === "error" || event.type === "assert") consoleErrors.push(event);
    });
    resources.client.on("Runtime.exceptionThrown", (event) => exceptions.push(event));
    resources.client.on("Network.loadingFailed", (event) => { if (!event.canceled) networkFailures.push(event); });
    resources.client.on("Network.responseReceived", (event) => {
      if (event.response.status >= 400) networkHttpErrors.push({ url: event.response.url, status: event.response.status });
    });
    resources.client.on("Network.requestWillBeSent", (event) => {
      const url = event.request.url;
      if (!url.startsWith(resources.origin) && !url.startsWith("data:") && !url.startsWith("blob:")) externalRequests.push(url);
    });
    await Promise.all([
      resources.client.send("Page.enable"),
      resources.client.send("Runtime.enable"),
      resources.client.send("Network.enable"),
      resources.client.send("HeapProfiler.enable"),
    ]);
  }, 25_000);

  let baseline;
  let peak;
  let steadyFinal;
  let postDispose;
  let cycles = 0;
  let elapsedMs = 0;
  let startedAtIso;
  let completedAtIso;
  await stage("scene-ready", async () => {
    await resources.client.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: 1280,
      screenHeight: 800,
      screenOrientation: { type: "landscapePrimary", angle: 0 },
    });
    await resources.client.send("Page.navigate", { url: `${resources.origin}/harness/index.html?soak=1` });
    await waitFor("window.__viewerHarnessReady === true && window.__viewerHarness.state().renderMode === 'depth_limited_parallax'", 20_000);
    await resources.client.send("HeapProfiler.collectGarbage");
    baseline = await sample();
    peak = { ...baseline };
    processPeak = processCountForProfile(resources.profile);
    samples.push({ elapsedMs: 0, cycle: 0, resources: baseline, ownedProcesses: processPeak });
  }, 25_000);

  await stage("parameterized-interaction-loop", async () => {
    const startedAt = Date.now();
    startedAtIso = new Date(startedAt).toISOString();
    let nextProgressAt = 30_000;
    while ((elapsedMs = Date.now() - startedAt) < requestedDurationMs) {
      const state = await evaluate(`window.__viewerHarness.soakStep(${cycles})`, operationTimeoutMs);
      if (state.phase !== "ready" || state.renderMode !== "depth_limited_parallax") {
        const error = new Error(`cycle ${cycles} ended ${state.phase}/${state.renderMode}`);
        error.code = "SOAK_STATE_INVALID";
        throw error;
      }
      cycles += 1;
      const current = await sample();
      updatePeak(peak, current);
      elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= nextProgressAt) {
        const ownedProcesses = processCountForProfile(resources.profile);
        processPeak = Math.max(processPeak, ownedProcesses);
        samples.push({ elapsedMs, cycle: cycles, resources: current, ownedProcesses });
        marker("SOAK_PROGRESS", `${Math.floor(elapsedMs / 1000)}s`, { cycles, heapBytes: current.heapBytes, activeObjectUrls: current.activeObjectUrls });
        nextProgressAt += 30_000;
      }
    }
    elapsedMs = Date.now() - startedAt;
    completedAtIso = new Date().toISOString();
  }, requestedDurationMs + 60_000);

  await stage("finalize-and-dispose", async () => {
    await evaluate("window.__viewerHarness.soakFinalize()", operationTimeoutMs);
    await resources.client.send("HeapProfiler.collectGarbage");
    steadyFinal = await sample();
    updatePeak(peak, steadyFinal);
    const screenshot = await resources.client.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    fs.writeFileSync(path.join(screenshotRoot, "viewer-soak-final.png"), Buffer.from(screenshot.data, "base64"));
    await evaluate("window.__viewerHarness.viewer.dispose()");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await resources.client.send("HeapProfiler.collectGarbage");
    postDispose = await sample();
  }, 25_000);

  const metrics = {
    heapBytes: metric(baseline, peak, steadyFinal, postDispose, "heapBytes"),
    domNodes: metric(baseline, peak, steadyFinal, postDispose, "domNodes"),
    canvases: metric(baseline, peak, steadyFinal, postDispose, "canvases"),
    webglContexts: metric(baseline, peak, steadyFinal, postDispose, "activeWebglContexts", "peakWebglContexts"),
    objectUrls: metric(baseline, peak, steadyFinal, postDispose, "activeObjectUrls", "peakObjectUrls"),
    animationFrames: metric(baseline, peak, steadyFinal, postDispose, "activeAnimationFrames", "peakAnimationFrames"),
    listeners: metric(baseline, peak, steadyFinal, postDispose, "activeListeners", "peakListeners"),
    resizeObservers: metric(baseline, peak, steadyFinal, postDispose, "activeObservers", "peakObservers"),
  };
  const boundedChecks = {
    durationReached: elapsedMs >= requestedDurationMs,
    officialDurationReached: elapsedMs >= acceptanceDurationMs,
    heapPeakBounded: metrics.heapBytes.peak <= metrics.heapBytes.baseline + 128 * 1024 * 1024,
    heapFinalBounded: metrics.heapBytes.final <= metrics.heapBytes.baseline + 32 * 1024 * 1024,
    domBounded: metrics.domNodes.peak <= metrics.domNodes.baseline + 20 && metrics.domNodes.final <= metrics.domNodes.baseline,
    canvasBounded: metrics.canvases.peak <= metrics.canvases.baseline + 1 && metrics.canvases.final === 0,
    webglBounded: metrics.webglContexts.peak <= 1 && metrics.webglContexts.final === 0,
    objectUrlsBounded: metrics.objectUrls.peak <= metrics.objectUrls.baseline + 4 && metrics.objectUrls.final === 0,
    animationFramesBounded: metrics.animationFrames.peak <= 3 && metrics.animationFrames.final === 0,
    listenersBounded: metrics.listeners.peak <= metrics.listeners.baseline + 12 && metrics.listeners.final <= metrics.listeners.baseline,
    observersBounded: metrics.resizeObservers.peak <= 1 && metrics.resizeObservers.final === 0,
    consoleAndNetworkClean: consoleErrors.length === 0 && exceptions.length === 0 && networkFailures.length === 0 && networkHttpErrors.length === 0 && externalRequests.length === 0,
  };
  for (const [name, value] of Object.entries(boundedChecks)) {
    if (name === "officialDurationReached" && requestedDurationMs < acceptanceDurationMs) {
      assertPass(!value, "short-run-is-not-acceptance-evidence", { requestedDurationMs, elapsedMs, acceptanceDurationMs });
      continue;
    }
    assertPass(value, name, name.toLowerCase().includes("duration") ? { requestedDurationMs, elapsedMs, acceptanceDurationMs } : metrics);
  }
  assertPass(cycles > 0, "cycles-completed", { cycles });

  const countMultiples = (divisor) => cycles === 0 ? 0 : Math.floor((cycles - 1) / divisor) + 1;
  evidence = {
    schemaVersion: "unseen-viewer-soak-evidence/1",
    runId,
    qualification: requestedDurationMs >= acceptanceDurationMs ? "acceptance" : "ci_only",
    acceptanceEligible: requestedDurationMs >= acceptanceDurationMs && elapsedMs >= acceptanceDurationMs,
    requestedDurationMs,
    acceptanceDurationMs,
    elapsedMs,
    startedAt: startedAtIso,
    completedAt: completedAtIso,
    cycles,
    coverage: {
      orbitMoveResize: cycles,
      sceneReloadPairs: countMultiples(11),
      contextLossDefaultRetries: countMultiples(23),
      disposeMountUpdate: countMultiples(37),
      disposeMountWithScene: countMultiples(53),
    },
    browser: browser?.Browser || "Chrome DevTools",
    metrics,
    resourceCounters: {
      baseline,
      peak,
      steadyFinal,
      postDispose,
    },
    ownedProcesses: { baseline: samples[0].ownedProcesses, peak: processPeak, final: null },
    ownedServices: { loopbackServer: { baseline: 1, peak: 1, final: null } },
    boundedChecks,
    assertions,
    samples,
    consoleErrors: consoleErrors.length,
    runtimeExceptions: exceptions.length,
    networkFailures: networkFailures.length,
    networkHttpErrors,
    externalRequests,
    screenshot: "screenshots/viewer-soak-final.png",
    stages,
  };
}

let signalCleanupStarted = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (signalCleanupStarted) return;
    signalCleanupStarted = true;
    failure = Object.assign(new Error(`soak runner received ${signal}`), { code: signal });
    cleanup(signal).then(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}

try {
  await withTimeout(runSoak(), globalTimeoutMs, "global-soak-suite");
} catch (error) {
  failure = error;
  process.exitCode = 1;
  marker("SOAK_FAIL", error.code || error.name, { message: error.message });
} finally {
  const cleaned = await cleanup(failure ? "failure" : "success");
  if (!cleaned.serverClosed || !cleaned.chromeExited || !cleaned.profileRemoved || cleaned.orphanProcessCount !== 0) {
    process.exitCode = 1;
    failure ||= Object.assign(new Error("soak cleanup left owned resources"), { code: "SOAK_CLEANUP_FAILED" });
  }
  const report = {
    ...(evidence || {
      schemaVersion: "unseen-viewer-soak-evidence/1",
      runId,
      qualification: requestedDurationMs >= acceptanceDurationMs ? "acceptance" : "ci_only",
      acceptanceEligible: false,
      requestedDurationMs,
      acceptanceDurationMs,
      stages,
      assertions,
      samples,
    }),
    pass: !failure && cleaned.serverClosed && cleaned.chromeExited && cleaned.profileRemoved && cleaned.orphanProcessCount === 0,
    failure: failure ? { code: failure.code || failure.name, message: failure.message, stack: failure.stack } : null,
    cleanup: cleaned,
  };
  if (report.ownedProcesses) report.ownedProcesses.final = cleaned.orphanProcessCount;
  if (report.ownedServices) report.ownedServices.loopbackServer.final = cleaned.serverClosed ? 0 : 1;
  fs.writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
  marker(report.pass ? "SOAK_PASS" : "SOAK_RESULT_FAIL", report.qualification, {
    elapsedMs: report.elapsedMs || null,
    cycles: report.cycles || 0,
    orphanProcessCount: cleaned.orphanProcessCount,
  });
}
