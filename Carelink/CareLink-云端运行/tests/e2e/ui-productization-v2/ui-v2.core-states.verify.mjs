import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.TEST_ONLY_FIXTURE_FAULTS !== "1") {
  throw new Error("ui_v2_core_states_requires_TEST_ONLY_FIXTURE_FAULTS_1");
}

process.umask(0o077);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const evidenceRoot = resolve(root, "release-evidence/local-operable/ui-v2-core-states");
const screenshotRoot = resolve(evidenceRoot, "screenshots");
const chromePath = process.env.UNSEEN_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile = await mkdtemp(resolve(tmpdir(), "unseen-ui-v2-core-states-"));
await mkdir(screenshotRoot, { recursive: true, mode: 0o700 });

const delay = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
const invariant = (value, message) => { if (!value) throw new Error(message); };

async function dynamicPorts(count) {
  const reservations = [];
  while (reservations.length < count) {
    const server = createServer();
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const port = server.address().port;
    if (port === 4282 || reservations.some((entry) => entry.port === port)) {
      await new Promise((resolveClose) => server.close(resolveClose));
    } else reservations.push({ server, port });
  }
  const ports = reservations.map((entry) => entry.port);
  await Promise.all(reservations.map(({ server }) => new Promise((resolveClose) => server.close(resolveClose))));
  return ports;
}

async function poll(operation, label, timeout = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { const value = await operation(); if (value) return value; } catch {}
    await delay(50);
  }
  throw new Error(`ui_v2_core_states_timeout:${label}`);
}

async function waitForOutput(stream, expected, timeout = 20_000) {
  let output = "";
  return poll(async () => {
    output += stream.read()?.toString() || "";
    return output.includes(expected) ? output : null;
  }, `output:${expected}`, timeout);
}

async function waitForFile(filename, timeout = 20_000) {
  return poll(async () => readFile(filename, "utf8"), filename, timeout);
}

function cdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  let sequence = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const callback = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) callback.reject(new Error(message.error.message)); else callback.resolve(message.result);
      return;
    }
    for (const listener of listeners.get(message.method) || []) listener(message.params);
  });
  return {
    ready: new Promise((resolveReady, rejectReady) => {
      socket.addEventListener("open", resolveReady, { once: true });
      socket.addEventListener("error", rejectReady, { once: true });
    }),
    send(method, params = {}) {
      const id = ++sequence;
      return new Promise((resolveCommand, rejectCommand) => {
        pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method, listener) { listeners.set(method, [...(listeners.get(method) || []), listener]); },
    close() { socket.close(); }
  };
}

async function terminate(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) return;
  try { process.kill(-processHandle.pid, "SIGTERM"); } catch {}
  await Promise.race([once(processHandle, "exit"), delay(3_000)]).catch(() => {});
  if (processHandle.exitCode === null) {
    try { process.kill(-processHandle.pid, "SIGKILL"); } catch {}
    await Promise.race([once(processHandle, "exit"), delay(2_000)]).catch(() => {});
  }
}

const report = {
  schema: "unseen-ui-v2-core-states/1",
  status: "FAIL",
  marker: "TEST_ONLY_FIXTURE_FAULTS",
  testOnly: true,
  productBytesChanged: false,
  productionInput: false,
  productionFaultClaim: false,
  candidateCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  viewports: [],
  cases: [],
  diagnostics: { consoleIssues: [], exceptions: [], failedRequests: [], httpFailures: [], externalRequests: [] },
  cleanup: {}
};

let uiServer;
let chrome;
let client;
let origin;
let ports = [];
let failure;

try {
  ports = await dynamicPorts(3);
  const [port, webPort, bookPort] = ports;
  origin = `http://127.0.0.1:${port}`;
  const parsedOrigin = new URL(origin);
  invariant(parsedOrigin.hostname === "127.0.0.1" && parsedOrigin.port !== "4282", "ui_v2_core_states_origin_not_isolated");

  uiServer = spawn(process.execPath, ["infra/integration/ui-productization-v2/server.mjs"], {
    cwd: root,
    detached: true,
    env: { ...process.env, UNSEEN_UI_PORT: String(port), UNSEEN_UI_WEB_PORT: String(webPort), UNSEEN_UI_BOOK_PORT: String(bookPort) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitForOutput(uiServer.stdout, "UNSEEN_UI_PRODUCTIZATION_V2_READY");
  const health = await poll(async () => {
    const response = await fetch(`${origin}/__ui-v2/healthz`, { signal: AbortSignal.timeout(500) });
    return response.ok ? response.json() : null;
  }, "fixture health");
  invariant(health.origin === origin && health.listener === "loopback_only" && health.fixture === true &&
    health.externalExposure === false && health.cloudWrites === 0 && health.productionReady === false,
  `ui_v2_core_states_health_invalid:${JSON.stringify(health)}`);
  report.origin = origin;
  report.health = health;

  chrome = spawn(chromePath, [
    "--headless=new", "--hide-scrollbars", "--disable-background-networking", "--disable-component-update",
    "--disable-default-apps", "--disable-sync", "--metrics-recording-only", "--no-first-run",
    "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"
  ], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const [debugPort] = (await waitForFile(resolve(profile, "DevToolsActivePort"))).trim().split("\n");
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const target = targets.find((item) => item.type === "page");
  invariant(target, "ui_v2_core_states_page_target_missing");
  client = cdp(target.webSocketDebuggerUrl);
  await client.ready;
  await Promise.all([client.send("Page.enable"), client.send("Runtime.enable"), client.send("Network.enable"), client.send("Accessibility.enable")]);

  const diagnostics = report.diagnostics;
  const requestUrls = new Map();
  client.on("Runtime.exceptionThrown", ({ exceptionDetails }) => diagnostics.exceptions.push(exceptionDetails.text || "exception"));
  client.on("Runtime.consoleAPICalled", ({ type, args }) => {
    if (["error", "warning"].includes(type)) diagnostics.consoleIssues.push(args.map((arg) => arg.value || arg.description || "").join(" "));
  });
  client.on("Network.requestWillBeSent", ({ requestId, request }) => {
    requestUrls.set(requestId, request.url);
    const url = new URL(request.url);
    if (!["data:", "blob:"].includes(url.protocol) && url.origin !== origin) diagnostics.externalRequests.push(request.url);
  });
  client.on("Network.loadingFailed", ({ requestId, canceled, errorText }) => {
    if (!canceled && errorText !== "net::ERR_ABORTED") diagnostics.failedRequests.push({ url: requestUrls.get(requestId) || "unknown", errorText });
  });
  client.on("Network.responseReceived", ({ response }) => {
    if (response.url.startsWith(origin) && response.status >= 400) diagnostics.httpFailures.push({ status: response.status, url: response.url });
  });

  async function evaluate(expression) {
    const result = await client.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`ui_v2_core_states_evaluate:${result.exceptionDetails.text}`);
    return result.result.value;
  }

  async function navigate(pathname) {
    await client.send("Page.navigate", { url: `${origin}${pathname}` });
    await poll(async () => await evaluate(`location.pathname===${JSON.stringify(pathname)}&&document.readyState==='complete'`), `navigate:${pathname}`);
    await poll(async () => (await evaluate("document.querySelector('main')?.innerText.length||0")) > 0, `content:${pathname}`);
  }

  async function key(keyValue, code = keyValue) {
    const virtual = { Enter: 13, Tab: 9, Space: 32 }[code];
    const text = code === "Enter" ? "\r" : code === "Space" ? " " : undefined;
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: keyValue, code, text, unmodifiedText: text, windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: keyValue, code, windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual });
    await delay(80);
  }

  async function focusByTab(selector, limit = 30) {
    for (let index = 0; index < limit; index += 1) {
      await key("Tab");
      if (await evaluate(`document.activeElement?.matches(${JSON.stringify(selector)})`)) return;
    }
    throw new Error(`ui_v2_core_states_keyboard_target_unreachable:${selector}`);
  }

  async function viewport(width, height, mobile = false) {
    await client.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
    await client.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  }

  async function shot(name) {
    const image = await client.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: true });
    await writeFile(resolve(screenshotRoot, `${name}.png`), Buffer.from(image.data, "base64"), { mode: 0o600 });
  }

  async function inspect(name, selectors = []) {
    const value = await evaluate(`(()=>{const selectors=${JSON.stringify(selectors)};const text=document.body.innerText;return{
      name:${JSON.stringify(name)},path:location.pathname,fixtureBanner:Boolean(document.querySelector('.fixture-banner'))&&text.includes('本地确定性样本')&&text.includes('非真实 AI')&&text.includes('不代表正式发布'),
      reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1,
      boxes:selectors.map(selector=>{const node=document.querySelector(selector);if(!node)return{selector,missing:true};const rect=node.getBoundingClientRect();return{selector,text:(node.getAttribute('aria-label')||node.textContent||'').trim().replace(/\s+/g,' '),interactive:node.matches('button,a[href],input,textarea,select,summary'),width:rect.width,height:rect.height,left:rect.left,right:rect.right,inViewport:rect.left>=-.5&&rect.right<=innerWidth+.5}})
    }})()`);
    invariant(value.fixtureBanner && value.reducedMotion && !value.horizontalOverflow,
      `ui_v2_core_states_page_contract:${JSON.stringify(value)}`);
    invariant(value.boxes.every((box) => !box.missing && box.text && box.width > 0 && box.height >= (box.interactive ? 40 : 20) && box.inViewport),
      `ui_v2_core_states_bounds:${JSON.stringify(value.boxes)}`);
    await shot(name);
    return value;
  }

  await navigate("/");
  invariant(await evaluate("Boolean(globalThis.__UNSEEN_TEST__)"), "ui_v2_core_states_fixture_control_missing");
  await evaluate("globalThis.__UNSEEN_TEST__.offline(false)");
  const discovery = await evaluate(`(()=>{const matches=[];for(let index=0;index<sessionStorage.length;index+=1){const key=sessionStorage.key(index);try{const value=JSON.parse(sessionStorage.getItem(key));if(value?.mode==='fixture'&&value?.currentSpaceId&&Array.isArray(value?.spaces)&&Array.isArray(value?.photos))matches.push({key,value})}catch{}}return matches})()`);
  invariant(discovery.length === 1, `ui_v2_core_states_fixture_storage_not_unique:${JSON.stringify(discovery.map((item) => item.key))}`);
  const fixtureStorageKey = discovery[0].key;
  const baseline = discovery[0].value;
  invariant(baseline.mode === "fixture" && !baseline.TEST_ONLY_FIXTURE_FAULTS, "ui_v2_core_states_baseline_invalid");
  report.fixtureStorage = { dynamicallyDiscovered: true, unique: true, keySha256Recorded: false };

  async function install(state, scenario) {
    const value = structuredClone(state);
    if (scenario) value.TEST_ONLY_FIXTURE_FAULTS = { schema: "unseen-test-only-fixture-faults/1", marker: "TEST_ONLY_FIXTURE_FAULTS", scenario };
    else delete value.TEST_ONLY_FIXTURE_FAULTS;
    await evaluate(`(()=>{sessionStorage.setItem(${JSON.stringify(fixtureStorageKey)},${JSON.stringify(JSON.stringify(value))});location.reload();return true})()`);
    await poll(async () => await evaluate("document.readyState==='complete'&&Boolean(document.querySelector('main'))"), `install:${scenario || "baseline"}`);
    if (scenario) {
      const marker = await evaluate("globalThis.__UNSEEN_TEST__?.state()?.TEST_ONLY_FIXTURE_FAULTS");
      invariant(marker?.schema === "unseen-test-only-fixture-faults/1" && marker?.marker === "TEST_ONLY_FIXTURE_FAULTS" && marker?.scenario === scenario,
        `ui_v2_core_states_marker_invalid:${JSON.stringify(marker)}`);
    }
  }

  const viewportCases = [
    { label: "desktop-1440", width: 1440, height: 1000, mobile: false },
    { label: "mobile-390", width: 390, height: 844, mobile: true },
    { label: "desktop-200-percent", width: 720, height: 900, mobile: false }
  ];

  for (const dimensions of viewportCases) {
    await viewport(dimensions.width, dimensions.height, dimensions.mobile);
    const viewportResult = { ...dimensions, cases: [] };

    await install(baseline, null);
    const emptyAlbum = structuredClone(baseline);
    emptyAlbum.photos = [];
    emptyAlbum.capabilities = { ...emptyAlbum.capabilities, view: true, upload: true };
    emptyAlbum.spaces = emptyAlbum.spaces.map((space) => space.id === emptyAlbum.currentSpaceId ? { ...space, photoCount: 0 } : space);
    await install(emptyAlbum, "empty_album");
    await navigate("/s/space-gongguang/album");
    const emptyValue = await evaluate(`({heading:document.querySelector('.empty-state h2')?.textContent.trim(),cta:document.querySelector('.empty-state a')?.textContent.trim(),href:document.querySelector('.empty-state a')?.getAttribute('href')})`);
    invariant(emptyValue.heading === "这个空间还没有可查看的照片。" && emptyValue.cta === "上传第一张照片" && emptyValue.href === "/s/space-gongguang/upload",
      `ui_v2_core_states_empty_album:${JSON.stringify(emptyValue)}`);
    const emptyAudit = await inspect(`${dimensions.label}-empty-album`, [".empty-state h2", '.empty-state a[href="/s/space-gongguang/upload"]']);
    await focusByTab('.empty-state a[href="/s/space-gongguang/upload"]');
    await key("Enter");
    await poll(async () => await evaluate("location.pathname==='/s/space-gongguang/upload'&&document.body.innerText.includes('选择你拍到的照片')"), "empty album upload CTA");
    viewportResult.cases.push({ scenario: "empty_album", ...emptyValue, keyboardActivated: true, destination: "/s/space-gongguang/upload", audit: emptyAudit });

    await install(baseline, null);
    const emptyScene = structuredClone(baseline);
    emptyScene.spaces = emptyScene.spaces.map((space) => space.id === emptyScene.currentSpaceId ? {
      ...space, scene: { ...space.scene, readiness: "unavailable", artifactReady: false }
    } : space);
    await install(emptyScene, "scene_unavailable");
    await navigate("/s/space-gongguang/scene");
    const sceneValue = await evaluate(`({heading:document.querySelector('.state-panel h2')?.textContent.trim(),cta:document.querySelector('.state-panel a')?.textContent.trim(),href:document.querySelector('.state-panel a')?.getAttribute('href')})`);
    invariant(sceneValue.heading === "这个空间暂时没有现场" && sceneValue.cta === "查看相册" && sceneValue.href === "/s/space-gongguang/album",
      `ui_v2_core_states_empty_scene:${JSON.stringify(sceneValue)}`);
    const sceneAudit = await inspect(`${dimensions.label}-scene-unavailable`, [".state-panel h2", '.state-panel a[href="/s/space-gongguang/album"]']);
    await focusByTab('.state-panel a[href="/s/space-gongguang/album"]');
    await key("Enter");
    await poll(async () => await evaluate("location.pathname==='/s/space-gongguang/album'&&Boolean(document.querySelector('.gallery'))"), "scene album CTA");
    viewportResult.cases.push({ scenario: "scene_unavailable", ...sceneValue, keyboardActivated: true, destination: "/s/space-gongguang/album", audit: sceneAudit });

    await install(baseline, null);
    await navigate("/s/space-gongguang/album");
    invariant(await evaluate("Boolean(document.querySelector('.gallery'))"), "ui_v2_core_states_baseline_gallery_missing");
    await evaluate("globalThis.__UNSEEN_TEST__.offline(true);document.querySelector('.view-tabs a[aria-current=\"page\"]').click()");
    await poll(async () => await evaluate("location.pathname==='/s/space-gongguang/album'&&Boolean(document.querySelector('[data-phase=\"stable_error\"]'))"), "stable error");
    const errorValue = await evaluate(`({heading:document.querySelector('[data-phase="stable_error"] h2')?.textContent.trim(),retry:document.querySelector('[data-retry]')?.textContent.trim(),path:location.pathname})`);
    invariant(errorValue.heading === "照片暂时无法加载。" && errorValue.retry === "重新加载" && errorValue.path === "/s/space-gongguang/album",
      `ui_v2_core_states_stable_error:${JSON.stringify(errorValue)}`);
    const errorAudit = await inspect(`${dimensions.label}-stable-error`, ['[data-phase="stable_error"] h2', "[data-retry]"]);
    await evaluate("globalThis.__UNSEEN_TEST__.offline(false)");
    await focusByTab("[data-retry]");
    await evaluate("globalThis.__UNSEEN_RETRY_KEY_CLICKS__=0;document.querySelector('[data-retry]').addEventListener('click',()=>{globalThis.__UNSEEN_RETRY_KEY_CLICKS__+=1},{once:true})");
    await key("Enter");
    try {
      await poll(async () => await evaluate("location.pathname==='/s/space-gongguang/album'&&Boolean(document.querySelector('.gallery'))&&!document.querySelector('[data-phase=\"stable_error\"]')"), "stable error recovery");
    } catch (error) {
      const diagnostic = await evaluate("({path:location.pathname,focus:document.activeElement?.outerHTML,clicks:globalThis.__UNSEEN_RETRY_KEY_CLICKS__,offline:globalThis.__UNSEEN_TEST__?.state()?.offline,phase:document.querySelector('[data-phase]')?.dataset.phase,text:document.querySelector('main')?.innerText})");
      throw new Error(`ui_v2_core_states_retry_diagnostic:${JSON.stringify(diagnostic)}`, { cause: error });
    }
    const retryKeyClicks = await evaluate("globalThis.__UNSEEN_RETRY_KEY_CLICKS__");
    invariant(retryKeyClicks === 1, `ui_v2_core_states_retry_not_keyboard_activated:${retryKeyClicks}`);
    viewportResult.cases.push({ scenario: "offline_stable_error", ...errorValue, keyboardActivated: true, retryKeyClicks, recoveredSameRoute: true, audit: errorAudit });

    await install(baseline, null);
    await navigate("/s/space-gongguang/photos/photo-missing");
    const missingValue = await evaluate(`({heading:document.querySelector('[data-phase="empty"] h2')?.textContent.trim(),retry:Boolean(document.querySelector('[data-retry]')),media:Boolean(document.querySelector('.photo-detail-media,img,video')),report:Boolean(document.querySelector('[data-open-report]')),path:location.pathname})`);
    invariant(missingValue.heading === "这张照片已不可查看。" && !missingValue.retry && !missingValue.media && !missingValue.report &&
      missingValue.path === "/s/space-gongguang/photos/photo-missing",
    `ui_v2_core_states_missing_photo:${JSON.stringify(missingValue)}`);
    const missingAudit = await inspect(`${dimensions.label}-missing-photo`, ['[data-phase="empty"] h2']);
    viewportResult.cases.push({ scenario: "missing_photo", ...missingValue, audit: missingAudit });

    report.viewports.push(viewportResult);
  }

  await install(baseline, null);
  report.cases = report.viewports.flatMap((entry) => entry.cases.map((item) => ({ viewport: entry.label, ...item })));
  invariant(diagnostics.consoleIssues.length === 0 && diagnostics.exceptions.length === 0 && diagnostics.failedRequests.length === 0 &&
    diagnostics.httpFailures.length === 0 && diagnostics.externalRequests.length === 0,
  `ui_v2_core_states_diagnostics:${JSON.stringify(diagnostics)}`);
  report.boundary = "These branches are deterministic UI fixture evidence only. They replace the prior NOT_EXERCISED gap for this fixture surface and make no production fault-injection, provider, API, or release-readiness claim.";
  report.status = "PASS";
} catch (error) {
  failure = error;
  report.failure = error.stack || String(error);
} finally {
  client?.close();
  await terminate(chrome);
  await terminate(uiServer);
  const closed = await Promise.all(ports.map(async (port) => {
    try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(250) }); return false; } catch { return true; }
  }));
  report.cleanup = { ownUiServerStopped: !uiServer || uiServer.exitCode !== null, ownChromeStopped: !chrome || chrome.exitCode !== null,
    loopbackPortsClosed: closed.every(Boolean), freshProfileRemoved: false };
  await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  report.cleanup.freshProfileRemoved = true;
  if (!report.cleanup.ownUiServerStopped || !report.cleanup.ownChromeStopped || !report.cleanup.loopbackPortsClosed) {
    failure ||= new Error(`ui_v2_core_states_cleanup_failed:${JSON.stringify(report.cleanup)}`);
    report.status = "FAIL";
  }
  await writeFile(resolve(evidenceRoot, "CHROME-CORE-STATES.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

if (failure) throw failure;
process.stdout.write(`${JSON.stringify({ status: "UI_V2_CORE_STATES_OK", candidateCommit: report.candidateCommit,
  cases: report.cases.length, screenshots: report.cases.length, diagnostics: report.diagnostics, cleanup: report.cleanup }, null, 2)}\n`);
