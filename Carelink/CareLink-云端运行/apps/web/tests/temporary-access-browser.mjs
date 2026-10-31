import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TEMPORARY_ACCESS_MODE } from "../src/temporary-access.js";

const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const evidenceRoot = resolve(appRoot, "../../release-evidence/local-operable/public-core-ui-temporary-access");
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile = await mkdtemp(join(tmpdir(), "unseen-temporary-access-chrome-"));
const port = await availablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const exactCopy = "当前通过邀请门浏览；邮件登录、照片上传、AI 问答和纪念册仍在准备，本次临时访问不会接收这些内容。";
const report = { schemaVersion: "unseen-public-core-temporary-access-browser/1", status: "RUNNING",
  fixtureDefaultOff: true, productionInput: false, healthMock: "TEST_ONLY_CDP_RESPONSE",
  browserDiagnostics: { consoleErrors: [], exceptions: [], failedRequests: [], unexpectedHttpErrors: [],
    expectedHealth503: [], externalRequests: [] }, healthRequests: [], failClosedCases: [], viewports: [],
  favicon: null, cleanup: {} };

let server;
let chrome;
let cdp;
let healthScenario = { status: 503, mode: TEMPORARY_ACCESS_MODE };

async function run() {
try {
  await mkdir(evidenceRoot, { recursive: true });
  server = spawn(process.execPath, ["server.mjs"], { cwd: appRoot, detached: true,
    env: { ...process.env, UNSEEN_WEB_PORT: String(port), UNSEEN_WEB_TEST: "1" },
    stdio: ["ignore", "pipe", "pipe"] });
  await waitForOutput(server.stdout, "UNSEEN Web");
  chrome = spawn(chromePath, ["--headless=new", "--disable-background-networking", "--disable-component-update",
    "--disable-default-apps", "--disable-sync", "--metrics-recording-only", "--no-first-run",
    "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"],
  { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const [debugPort] = (await waitForFile(join(profile, "DevToolsActivePort"))).trim().split("\n");
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  cdp = new Cdp(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
  await cdp.ready;
  await Promise.all(["Page.enable", "Runtime.enable", "Network.enable", "Accessibility.enable"].map((method) => cdp.send(method)));
  installObservers();
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*healthz", requestStage: "Request" }] });
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });

  await fetch(`${baseUrl}/__test/reset`, { method: "POST" });
  for (const viewport of [{ name: "desktop-1440", width: 1440, height: 900 },
    { name: "mobile-390", width: 390, height: 844 }]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height,
      deviceScaleFactor: 1, mobile: viewport.width < 700 });
    await navigate("/");
    await waitFor("Boolean(document.querySelector('.temporary-access-banner'))");
    const value = await evaluate(`(() => {
      const banner = document.querySelector('.temporary-access-banner');
      const inner = banner.querySelector('.temporary-access-banner-inner');
      const rect = banner.getBoundingClientRect();
      const innerRect = inner.getBoundingClientRect();
      return { count: document.querySelectorAll('.temporary-access-banner').length,
        title: banner.querySelector('strong')?.textContent.trim(),
        copy: banner.querySelector('span')?.textContent.trim(),
        afterHeader: banner.previousElementSibling?.classList.contains('site-header') === true,
        beforeMain: banner.nextElementSibling?.id === 'main',
        overflow: document.documentElement.scrollWidth > innerWidth,
        bounds: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
          inViewport: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 },
        innerBounds: { left: innerRect.left, right: innerRect.right,
          inViewport: innerRect.left >= 0 && innerRect.right <= innerWidth },
        flexDirection: getComputedStyle(inner).flexDirection,
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        fixture: Boolean(document.querySelector('.fixture-banner')) || globalThis.__UNSEEN_TEST__ !== undefined,
        credentialText: /Basic |Authorization|password|credential/i.test(document.documentElement.innerHTML) };
    })()`);
    await evaluate("document.querySelector('.skip-link').focus(); true");
    const keyboardBefore = await evaluate("document.activeElement?.classList.contains('skip-link') === true");
    await pressEnter();
    const keyboardAfter = await evaluate("document.activeElement?.id === 'main'");
    const ax = await cdp.send("Accessibility.getFullAXTree");
    const axNodes = ax.nodes.filter((node) => !node.ignored);
    const axText = axNodes.map((node) => node.name?.value).filter(Boolean).join(" ");
    const statusNode = axNodes.find((node) => node.role?.value === "status" &&
      node.name?.value === "临时邀请访问");
    await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
    const zoom200 = await evaluate("({overflow:document.documentElement.scrollWidth>innerWidth,scale:visualViewport.scale})");
    await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
    await evaluate("scrollTo(0, 0); true");
    const screenshotName = `${viewport.name}.png`;
    const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true,
      captureBeyondViewport: false });
    await writeFile(resolve(evidenceRoot, screenshotName), Buffer.from(screenshot.data, "base64"));
    const result = { ...viewport, ...value, keyboard: { before: keyboardBefore, after: keyboardAfter },
      screenReader: { status: Boolean(statusNode), copy: axText.includes("当前通过邀请门浏览") }, zoom200,
      screenshot: `release-evidence/local-operable/public-core-ui-temporary-access/${screenshotName}` };
    assert(result.count === 1 && result.title === "临时邀请访问" && result.copy === exactCopy,
      `copy mismatch: ${JSON.stringify(result)}`);
    assert(result.afterHeader && result.beforeMain && !result.overflow && result.bounds.inViewport &&
      result.innerBounds.inViewport && result.reducedMotion && !result.fixture && !result.credentialText,
    `layout/boundary mismatch: ${JSON.stringify(result)}`);
    assert(result.keyboard.before && result.keyboard.after && result.screenReader.status && result.screenReader.copy &&
      !result.zoom200.overflow && result.zoom200.scale === 2, `a11y mismatch: ${JSON.stringify(result)}`);
    assert(viewport.width >= 700 ? result.flexDirection === "row" : result.flexDirection === "column",
      `responsive direction mismatch: ${JSON.stringify(result)}`);
    report.viewports.push(result);
  }

  for (const candidate of [{ name: "missing-200", status: 200, mode: null },
    { name: "illegal-503", status: 503, mode: "temporary-basic-auth" }]) {
    healthScenario = candidate;
    const requestCount = report.healthRequests.length;
    await navigate("/");
    await waitForHealthRequestCount(requestCount + 1);
    await delay(50);
    const visible = await evaluate("Boolean(document.querySelector('.temporary-access-banner'))");
    assert(!visible, `${candidate.name} disclosed temporary access`);
    report.failClosedCases.push({ ...candidate, visible });
  }

  const faviconResponse = await fetch(`${baseUrl}/assets/brand/favicon.svg`);
  const faviconBody = await faviconResponse.text();
  report.favicon = { status: faviconResponse.status, contentType: faviconResponse.headers.get("content-type"),
    svg: faviconBody.startsWith("<svg"), html: /<!doctype|<html/iu.test(faviconBody) };
  assert(report.favicon.status === 200 && report.favicon.contentType === "image/svg+xml" &&
    report.favicon.svg && !report.favicon.html, `favicon mismatch: ${JSON.stringify(report.favicon)}`);
  const requests = (await (await fetch(`${baseUrl}/__test/requests`)).json()).items;
  report.productMutationCount = requests.filter((request) => request.path.startsWith("/v1/") &&
    !["GET", "HEAD"].includes(request.method)).length;
  assert(report.healthRequests.length === 4 && report.healthRequests.every((request) =>
    request.method === "GET" && !request.hasPostData), `health request mismatch: ${JSON.stringify(report.healthRequests)}`);
  assert(report.productMutationCount === 0, `product emitted data writes: ${report.productMutationCount}`);
  const diagnostics = report.browserDiagnostics;
  assert(!diagnostics.consoleErrors.length && !diagnostics.exceptions.length && !diagnostics.failedRequests.length &&
    !diagnostics.unexpectedHttpErrors.length && !diagnostics.externalRequests.length,
  `browser diagnostics: ${JSON.stringify(diagnostics)}`);
  assert(diagnostics.expectedHealth503.length === 3, `expected 503 count: ${JSON.stringify(diagnostics)}`);
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.error = error.stack || String(error);
  throw error;
} finally {
  cdp?.close();
  await terminateGroup(chrome);
  await terminateGroup(server);
  await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  report.cleanup = { profileRemoved: true, ownProcessesRemaining: 0 };
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(resolve(evidenceRoot, "browser.json"), `${JSON.stringify(report, null, 2)}\n`);
}
}

function installObservers() {
  cdp.on("Fetch.requestPaused", ({ requestId, request }) => {
    report.healthRequests.push({ path: new URL(request.url).pathname, method: request.method,
      hasPostData: Boolean(request.hasPostData),
      scenario: healthScenario.name ?? "exact-503" });
    const responseHeaders = [{ name: "Content-Type", value: "application/json" },
      { name: "Cache-Control", value: "no-store" }];
    if (healthScenario.mode) responseHeaders.push({ name: "X-Unseen-Access-Mode", value: healthScenario.mode });
    void cdp.send("Fetch.fulfillRequest", { requestId, responseCode: healthScenario.status,
      responsePhrase: healthScenario.status === 503 ? "Service Unavailable" : "OK", responseHeaders,
      body: Buffer.from('{"status":"degraded"}').toString("base64") })
      .catch((error) => report.browserDiagnostics.failedRequests.push({ url: request.url, error: String(error) }));
  });
  cdp.on("Runtime.consoleAPICalled", (params) => { if (["error", "assert"].includes(params.type)) {
    report.browserDiagnostics.consoleErrors.push(params.args.map((arg) => arg.value || arg.description).join(" "));
  } });
  cdp.on("Runtime.exceptionThrown", (params) => report.browserDiagnostics.exceptions.push(
    params.exceptionDetails.exception?.description || params.exceptionDetails.text));
  cdp.on("Network.loadingFailed", (params) => { if (!params.canceled && params.errorText !== "net::ERR_ABORTED") {
    report.browserDiagnostics.failedRequests.push({ error: params.errorText, type: params.type });
  } });
  cdp.on("Network.requestWillBeSent", ({ request }) => {
    const url = new URL(request.url);
    if (url.protocol.startsWith("http") && !["127.0.0.1", "localhost"].includes(url.hostname)) {
      report.browserDiagnostics.externalRequests.push(request.url);
    }
  });
  cdp.on("Network.responseReceived", ({ response }) => {
    if (response.status < 400) return;
    const target = { status: response.status, path: new URL(response.url).pathname };
    if (new URL(response.url).pathname === "/healthz" && response.status === 503) {
      report.browserDiagnostics.expectedHealth503.push(target);
    } else report.browserDiagnostics.unexpectedHttpErrors.push(target);
  });
}

async function navigate(path) {
  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url: `${baseUrl}${path}` });
  await loaded;
  await waitFor("Boolean(document.querySelector('#main')) && !document.querySelector('[data-phase=loading]')");
}

async function evaluate(expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true,
    userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

async function pressEnter() {
  for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, key: "Enter",
    code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: type === "keyDown" ? "\r" : "" });
}

async function waitFor(expression, timeout = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(expression)) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${expression}`);
}

async function waitForHealthRequestCount(count, timeout = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (report.healthRequests.length >= count) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${count} health requests`);
}

async function availablePort() {
  const probe = createServer();
  await new Promise((resolveListen, reject) => probe.listen(0, "127.0.0.1", resolveListen).once("error", reject));
  const selected = probe.address().port;
  await new Promise((resolveClose) => probe.close(resolveClose));
  return selected;
}

async function waitForOutput(stream, value) {
  await Promise.race([new Promise((resolveWait, reject) => {
    stream.on("data", (chunk) => { if (chunk.toString().includes(value)) resolveWait(); });
    stream.once("error", reject);
  }), delay(5_000).then(() => { throw new Error(`Timed out waiting for ${value}`); })]);
}

async function waitForFile(path) {
  for (let index = 0; index < 200; index += 1) {
    try { return await readFile(path, "utf8"); } catch { await delay(50); }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function terminateGroup(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  await Promise.race([new Promise((resolveExit) => child.once("exit", resolveExit)), delay(1_000)]);
  if (child.exitCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
}

class Cdp {
  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolveReady, reject) => { this.socket.onopen = resolveReady; this.socket.onerror = reject; });
    this.socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (!message.id) {
        for (const listener of this.listeners.get(message.method) || []) listener(message.params);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolveSend, reject) => {
      this.pending.set(id, { resolve: resolveSend, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, listener) { this.listeners.set(method, [...(this.listeners.get(method) || []), listener]); }
  once(method) {
    return new Promise((resolveOnce) => {
      const listener = (params) => { this.listeners.set(method,
        (this.listeners.get(method) || []).filter((candidate) => candidate !== listener)); resolveOnce(params); };
      this.on(method, listener);
    });
  }
  close() { this.socket.close(); }
}

function assert(value, message) { if (!value) throw new Error(message); }
function delay(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }

await run();
