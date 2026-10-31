import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

process.umask(0o077);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const origin = process.env.UNSEEN_UI_ORIGIN || "http://127.0.0.1:4283";
const chrome = process.env.UNSEEN_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const debugPort = Number(process.env.UNSEEN_UI_CHROME_DEBUG_PORT || 9383);
const evidenceRoot = resolve(root, "release-evidence/local-operable/ui-v1");
const screenshotRoot = resolve(evidenceRoot, "screenshots");
const profile = await mkdtemp(resolve(tmpdir(), "unseen-ui-v1-chrome-"));
await mkdir(screenshotRoot, { recursive: true, mode: 0o700 });

const browser = spawn(chrome, [
  "--headless=new", "--hide-scrollbars", "--disable-background-networking", "--disable-component-update",
  "--disable-default-apps", "--disable-sync", "--no-first-run", `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profile}`, "about:blank"
], { stdio: ["ignore", "pipe", "pipe"] });

const delay = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
async function poll(operation, label, timeout = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { const value = await operation(); if (value) return value; } catch {}
    await delay(50);
  }
  throw new Error(`ui_v1_timeout:${label}`);
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

function invariant(value, message) { if (!value) throw new Error(message); }

try {
  const health = await poll(async () => {
    const response = await fetch(`${origin}/__ui-v1/healthz`, { signal: AbortSignal.timeout(500) });
    return response.ok ? response.json() : null;
  }, "staging health");
  invariant(health.listener === "loopback_only" && health.fixture === true && health.externalExposure === false,
    `ui_v1_health_invalid:${JSON.stringify(health)}`);
  await poll(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`).catch(() => null);
    return response?.ok;
  }, "chrome debug");
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const target = targets.find((item) => item.type === "page");
  invariant(target, "ui_v1_page_target_missing");
  const client = cdp(target.webSocketDebuggerUrl);
  await client.ready;
  await Promise.all([client.send("Page.enable"), client.send("Runtime.enable"), client.send("Network.enable"), client.send("Accessibility.enable")]);
  const consoleIssues = [];
  const httpFailures = [];
  const externalRequests = [];
  client.on("Runtime.exceptionThrown", ({ exceptionDetails }) => consoleIssues.push(exceptionDetails.text || "exception"));
  client.on("Runtime.consoleAPICalled", ({ type, args }) => {
    if (["error", "warning"].includes(type)) consoleIssues.push(args.map((arg) => arg.value || arg.description || "").join(" "));
  });
  client.on("Network.requestWillBeSent", ({ request }) => {
    const url = new URL(request.url);
    if (!["data:", "blob:"].includes(url.protocol) && url.origin !== origin) externalRequests.push(request.url);
  });
  client.on("Network.responseReceived", ({ response }) => {
    if (response.url.startsWith(origin) && response.status >= 400) httpFailures.push({ status: response.status, url: response.url });
  });

  async function evaluate(expression) {
    const result = await client.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`ui_v1_evaluate:${result.exceptionDetails.text}`);
    return result.result.value;
  }
  async function navigate(pathname) {
    await client.send("Page.navigate", { url: `${origin}${pathname}` });
    await poll(async () => await evaluate(`location.pathname===${JSON.stringify(pathname)}&&document.readyState==='complete'`), `navigate:${pathname}`);
    await poll(async () => (await evaluate("document.querySelector('main')?.innerText.length||0")) > 80, `content:${pathname}`);
  }
  async function click(selector, expectedPath) {
    const present = await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
    invariant(present, `ui_v1_click_target_missing:${selector}`);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    if (expectedPath) await poll(async () => await evaluate(`location.pathname===${JSON.stringify(expectedPath)}`), `click:${selector}`,
      expectedPath.includes("versions") ? 30_000 : 15_000);
  }
  async function viewport(width, height, mobile = false) {
    await client.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
    await client.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  }
  async function audit(name, selectors, screenshot = false) {
    const result = await evaluate(`(()=>{const selectors=${JSON.stringify(selectors)};const controls=[...document.querySelectorAll('button,a[href],input,textarea,select,summary')].filter(node=>node.getClientRects().length);const label=node=>(node.getAttribute('aria-label')||node.labels?.[0]?.textContent||node.textContent||node.value||'').trim();return{
      name:${JSON.stringify(name)},path:location.pathname,title:document.title,viewport:{width:innerWidth,height:innerHeight},fixtureNotice:document.body.innerText.includes('本地确定性样本')&&document.body.innerText.includes('非真实 AI')&&document.body.innerText.includes('不代表正式发布'),reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1,unnamedControls:controls.filter(node=>!label(node)).map(node=>node.outerHTML.slice(0,120)),externalResources:performance.getEntriesByType('resource').map(entry=>entry.name).filter(value=>{try{const url=new URL(value);return !['data:','blob:'].includes(url.protocol)&&url.origin!==location.origin}catch{return true}}),boxes:selectors.map(selector=>{const node=document.querySelector(selector);if(!node)return{selector,missing:true};const rect=node.getBoundingClientRect();return{selector,text:label(node).replace(/\s+/g,' ').slice(0,160),x:rect.x,y:rect.y,width:rect.width,height:rect.height,inViewport:rect.left>=-.5&&rect.right<=innerWidth+.5&&rect.bottom>0}})}})()`);
    invariant(result.fixtureNotice, `ui_v1_fixture_notice_missing:${name}`);
    invariant(result.reducedMotion && !result.horizontalOverflow, `ui_v1_layout_or_motion:${name}:${JSON.stringify(result)}`);
    invariant(!result.unnamedControls.length && !result.externalResources.length, `ui_v1_control_or_external:${name}:${JSON.stringify(result)}`);
    invariant(result.boxes.every((box) => !box.missing && box.text && box.width >= 40 && box.height >= 20 && box.inViewport),
      `ui_v1_copy_or_cta_bounds:${name}:${JSON.stringify(result.boxes)}`);
    if (screenshot) {
      const image = await client.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: true });
      await writeFile(resolve(screenshotRoot, `${name}.png`), Buffer.from(image.data, "base64"), { mode: 0o600 });
    }
    return result;
  }

  const results = [];
  await viewport(1440, 1000);
  await navigate("/");
  results.push(await audit("desktop-1440-home", [".home-copy h1", ".home-actions .button-primary", ".fixture-banner"], true));
  await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab" });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab" });
  const keyboard = await evaluate("({tag:document.activeElement?.tagName,text:(document.activeElement?.innerText||document.activeElement?.getAttribute('aria-label')||'').trim(),outline:getComputedStyle(document.activeElement).outlineStyle})");
  invariant(keyboard.tag === "A" && keyboard.text && keyboard.outline !== "none", `ui_v1_keyboard_focus:${JSON.stringify(keyboard)}`);
  await click(".home-actions .button-primary", "/s/space-gongguang/album");
  results.push(await audit("desktop-1440-space", [".space-title-row h1", ".photo-card a", ".product-journey"], true));
  await click(".photo-card a", "/s/space-gongguang/photos/photo-1");
  results.push(await audit("desktop-1440-photo", [".photo-detail-panel h1", ".memory-bridge a", ".memory-bridge"], true));
  await click(".memory-bridge a", "/labs/memories/photos/photo-01");
  results.push(await audit("desktop-1440-memory", [".task-card h2", '[data-action="MEMORY.START_QUESTION"]', ".fixture-context"], true));
  await click('[data-action="MEMORY.START_QUESTION"]', "/labs/memories/memory-01");
  await click('[data-action="MEMORY.CONFIRM"]', "/labs/books/book-adventurex-night/contributions/memory-01");
  await click(".explicit-consent input");
  await click('[data-action="BOOK_MEMORY.AUTHORIZE"]');
  await click('[data-entry="BL04"]', "/manage/space-adventurex-2026/book-lab");
  await click('[data-action="BOOK.CREATE"]', "/manage/space-adventurex-2026/book-lab/book-adventurex-night/draft");
  await click('[data-action="BOOK.FREEZE"]', "/s/space-adventurex-2026/books/book-adventurex-night/versions/book-version-02");
  results.push(await audit("desktop-1440-book", [".reader-shell h1", '[data-action="BOOK.DOWNLOAD_PDF"]', ".reader-frame .draft-page"], true));

  await viewport(390, 844, true);
  await navigate("/");
  results.push(await audit("mobile-390-home", [".home-copy h1", ".home-actions .button-primary", ".fixture-banner"], true));
  await navigate("/s/space-gongguang/album");
  results.push(await audit("mobile-390-space", [".space-title-row h1", ".photo-card a", ".product-journey"], true));
  await navigate("/s/space-gongguang/photos/photo-1");
  results.push(await audit("mobile-390-photo", [".photo-detail-panel h1", ".memory-bridge a", ".memory-bridge"], true));
  await navigate("/labs/memories/photos/photo-01");
  results.push(await audit("mobile-390-memory", [".task-card h2", '[data-action="MEMORY.START_QUESTION"]', ".fixture-context"], true));
  await navigate("/s/space-adventurex-2026/books/book-adventurex-night/versions/book-version-02");
  results.push(await audit("mobile-390-book", [".reader-shell h1", '[data-action="BOOK.DOWNLOAD_PDF"]', ".reader-frame .draft-page"], true));

  await viewport(720, 900);
  await navigate("/");
  const zoomEquivalent = await audit("desktop-1440-at-200-percent", [".home-copy h1", ".home-actions .button-primary", ".fixture-banner"]);
  invariant(zoomEquivalent.viewport.width === 720, "ui_v1_200_percent_equivalent_invalid");
  results.push(zoomEquivalent);

  invariant(consoleIssues.length === 0, `ui_v1_console_issues:${JSON.stringify(consoleIssues)}`);
  invariant(httpFailures.length === 0, `ui_v1_http_failures:${JSON.stringify(httpFailures)}`);
  invariant(externalRequests.length === 0, `ui_v1_external_requests:${JSON.stringify(externalRequests)}`);
  const evidence = {
    schema: "unseen-ui-productization-v1/1", status: "PASS", origin, browser: "Google Chrome headless",
    commit: (await (await import("node:child_process")).execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })).trim(),
    fixture: true, fixtureNotice: health.fixtureNotice, productPath: health.productPath, flow: ["home", "space", "photo", "BL01", "BL02", "BL03", "BL04", "BL05", "BL06"],
    keyboardFocus: keyboard, fileInputBoundary: "not exercised in this slice; DataTransfer automation remains the declared browser boundary",
    consoleIssues, httpFailures, externalRequests, results
  };
  await writeFile(resolve(evidenceRoot, "CHROME-DESKTOP-MOBILE.json"), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ status: "UI_PRODUCTIZATION_V1_CHROME_OK", evidence: resolve(evidenceRoot, "CHROME-DESKTOP-MOBILE.json"), screenshots: results.filter((item) => item.name.startsWith("desktop-") || item.name.startsWith("mobile-")).length, paths: evidence.flow }, null, 2)}\n`);
  client.close();
} finally {
  if (browser.exitCode === null) browser.kill("SIGTERM");
  await Promise.race([once(browser, "exit"), delay(2_000)]).catch(() => {});
  await rm(profile, { recursive: true, force: true });
}
