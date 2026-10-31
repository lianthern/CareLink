import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

process.umask(0o077);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const origin = process.env.UNSEEN_UI_ORIGIN || "http://127.0.0.1:4286";
const chrome = process.env.UNSEEN_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const debugPort = Number(process.env.UNSEEN_UI_CHROME_DEBUG_PORT || 9386);
const evidenceRoot = resolve(root, "release-evidence/local-operable/ui-v2-copy-action-matrix");
const screenshotRoot = resolve(evidenceRoot, "screenshots");
const profile = await mkdtemp(resolve(tmpdir(), "unseen-ui-v2-chrome-"));
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
  throw new Error(`ui_v2_timeout:${label}`);
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
    const response = await fetch(`${origin}/__ui-v2/healthz`, { signal: AbortSignal.timeout(500) });
    return response.ok ? response.json() : null;
  }, "staging health");
  invariant(health.listener === "loopback_only" && health.fixture === true && health.externalExposure === false,
    `ui_v2_health_invalid:${JSON.stringify(health)}`);
  invariant(health.samples?.core === "向晚婚礼" && health.samples?.book === "AdventureX 2026" && health.samples?.continuousData === false,
    `ui_v2_sample_boundary_invalid:${JSON.stringify(health.samples)}`);
  await poll(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`).catch(() => null);
    return response?.ok;
  }, "chrome debug");
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const target = targets.find((item) => item.type === "page");
  invariant(target, "ui_v2_page_target_missing");
  const client = cdp(target.webSocketDebuggerUrl);
  await client.ready;
  await Promise.all([client.send("Page.enable"), client.send("Runtime.enable"), client.send("Network.enable"), client.send("Accessibility.enable")]);
  const consoleIssues = [];
  const httpFailures = [];
  const externalRequests = [];
  const pdfResponses = [];
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
    if (response.url.startsWith(origin) && new URL(response.url).pathname.endsWith("/book.pdf")) {
      pdfResponses.push({ url: response.url, status: response.status, mimeType: response.mimeType, headers: response.headers });
    }
  });

  async function evaluate(expression) {
    const result = await client.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`ui_v2_evaluate:${result.exceptionDetails.text}`);
    return result.result.value;
  }
  async function navigate(pathname) {
    await client.send("Page.navigate", { url: `${origin}${pathname}` });
    await poll(async () => await evaluate(`location.pathname===${JSON.stringify(pathname)}&&document.readyState==='complete'`), `navigate:${pathname}`);
    await poll(async () => (await evaluate("document.querySelector('main')?.innerText.length||0")) > 80, `content:${pathname}`);
  }
  async function click(selector, expectedPath) {
    const present = await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
    invariant(present, `ui_v2_click_target_missing:${selector}`);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    if (expectedPath) {
      await poll(async () => await evaluate(`location.pathname===${JSON.stringify(expectedPath)}&&document.readyState==='complete'`), `click:${selector}`,
        expectedPath.includes("versions") ? 30_000 : 15_000);
      await poll(async () => (await evaluate("document.querySelector('main')?.innerText.length||0")) > 20, `click-content:${selector}`);
    }
  }
  async function setValue(selector, value) {
    const changed = await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)return false;const descriptor=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node),'value');descriptor.set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
    invariant(changed, `ui_v2_input_target_missing:${selector}`);
  }
  async function acceptConfirm() {
    await evaluate("window.confirm=()=>true");
  }
  async function clickNewTarget(selector, expectedPath) {
    const before = new Set((await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).map((item) => item.id));
    const result = await client.send("Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(selector)}).click()`, userGesture: true, returnByValue: true
    });
    invariant(!result.exceptionDetails, `ui_v2_new_target_click_failed:${selector}`);
    const opened = await poll(async () => {
      const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      return pages.find((item) => item.type === "page" && !before.has(item.id) && new URL(item.url).pathname === expectedPath);
    }, `new-target:${expectedPath}`);
    await client.send("Target.closeTarget", { targetId: opened.id });
    return opened.url;
  }
  async function key(key, code = key) {
    const windowsVirtualKeyCode = { Enter: 13, Tab: 9, Space: 32 }[code];
    const text = code === "Enter" ? "\r" : code === "Space" ? " " : undefined;
    await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, text, unmodifiedText: text, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode });
  }
  async function focusByTab(selector, limit = 24) {
    for (let index = 0; index < limit; index += 1) {
      await key("Tab");
      if (await evaluate(`document.activeElement?.matches(${JSON.stringify(selector)})`)) return;
    }
    throw new Error(`ui_v2_keyboard_target_unreachable:${selector}`);
  }
  async function viewport(width, height, mobile = false) {
    await client.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
    await client.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  }
  async function audit(name, selectors, screenshot = false) {
    const result = await evaluate(`(()=>{const selectors=${JSON.stringify(selectors)};const controls=[...document.querySelectorAll('button,a[href],input,textarea,select,summary')].filter(node=>node.getClientRects().length);const label=node=>(node.getAttribute('aria-label')||node.labels?.[0]?.textContent||node.textContent||node.value||'').trim();const text=document.body.innerText;const nav=[...document.querySelectorAll('.fixture-nav a')].map(node=>{const rect=node.getBoundingClientRect();return{text:node.innerText.trim(),left:rect.left,right:rect.right,width:rect.width,inViewport:rect.left>=-.5&&rect.right<=innerWidth+.5}});return{
      name:${JSON.stringify(name)},path:location.pathname,title:document.title,viewport:{width:innerWidth,height:innerHeight},fixtureNotice:text.includes('本地确定性样本')&&text.includes('非真实 AI')&&text.includes('不代表正式发布'),reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1,developerTerms:[...text.matchAll(/BL0[1-6]|Manifest|HTML|PDF|打开打印|同源对账/g)].map(match=>match[0]),sampleBoundary:text.includes('向晚婚礼')&&text.includes('AdventureX 2026')&&text.includes('不是同一组数据'),fixtureNav:nav,unnamedControls:controls.filter(node=>!label(node)).map(node=>node.outerHTML.slice(0,120)),externalResources:performance.getEntriesByType('resource').map(entry=>entry.name).filter(value=>{try{const url=new URL(value);return !['data:','blob:'].includes(url.protocol)&&url.origin!==location.origin}catch{return true}}),boxes:selectors.map(selector=>{const node=document.querySelector(selector);if(!node)return{selector,missing:true};const rect=node.getBoundingClientRect();return{selector,text:label(node).replace(/\s+/g,' ').slice(0,160),x:rect.x,y:rect.y,width:rect.width,height:rect.height,inViewport:rect.left>=-.5&&rect.right<=innerWidth+.5&&rect.bottom>0}})}})()`);
    invariant(result.fixtureNotice, `ui_v2_fixture_notice_missing:${name}`);
    invariant(result.reducedMotion && !result.horizontalOverflow, `ui_v2_layout_or_motion:${name}:${JSON.stringify(result)}`);
    invariant(result.developerTerms.length === 0, `ui_v2_developer_copy_visible:${name}:${JSON.stringify(result.developerTerms)}`);
    if (result.fixtureNav.length) invariant(result.fixtureNav.length === 6 && result.fixtureNav.every((item) => item.text && item.inViewport && item.width >= 40),
      `ui_v2_fixture_nav_bounds:${name}:${JSON.stringify(result.fixtureNav)}`);
    invariant(!result.unnamedControls.length && !result.externalResources.length, `ui_v2_control_or_external:${name}:${JSON.stringify(result)}`);
    invariant(result.boxes.every((box) => !box.missing && box.text && box.width >= 40 && box.height >= 20 && box.inViewport),
      `ui_v2_copy_or_cta_bounds:${name}:${JSON.stringify(result.boxes)}`);
    if (screenshot) {
      const image = await client.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: true });
      await writeFile(resolve(screenshotRoot, `${name}.png`), Buffer.from(image.data, "base64"), { mode: 0o600 });
    }
    return result;
  }

  const results = [];
  const actionMatrix = { controls: [] };
  const record = (route, copy, type, action, expected, observed) => actionMatrix.controls.push({ route, copy, type, action, expected, observed });

  await viewport(1440, 1000);
  await navigate("/labs/memories/photos/photo-01");
  await click('[data-action="MEMORY.START_QUESTION"]');
  await click("[data-question-retry]", "/labs/memories/memory-01");
  await click('[data-action="MEMORY.REQUEST_FOLLOWUP"]');
  const followupVisible = await evaluate("[...document.querySelectorAll('.question-sheet .ai-label')].some(node=>node.textContent.includes('追问'))");
  invariant(followupVisible, "ui_v2_followup_not_visible");
  record("BL02", "请再问我一个问题", "button", "MEMORY.REQUEST_FOLLOWUP", "show one deterministic follow-up", { followupVisible });
  await setValue("textarea", "这段临时草稿必须在撤回后消失。");
  await click('[data-action="MEMORY.SAVE_ANSWER_DRAFT"]');
  const savedStatus = await evaluate("document.querySelector('#status')?.textContent");
  invariant(savedStatus === "新的回答版本已保存，只有你能看到", `ui_v2_draft_save_failed:${savedStatus}`);
  record("BL02", "保存这段回答", "button", "MEMORY.SAVE_ANSWER_DRAFT", "save current local draft", { savedStatus });
  await acceptConfirm();
  await click(".danger-zone summary");
  await click('.danger-zone [data-action="MEMORY.WITHDRAW"]');
  actionMatrix.memoryWithdraw = await evaluate(`({
    emptyText:document.querySelector('[data-memory-empty]')?.innerText.trim()||'',
    answerPresent:Boolean(document.querySelector('textarea')),
    followupPresent:[...document.querySelectorAll('.question-sheet .ai-label')].some(node=>node.textContent.includes('追问')),
    draftValue:document.querySelector('textarea')?.value||'',
    recoverHref:document.querySelector('[data-memory-empty] a')?.getAttribute('href')||''
  })`);
  invariant(actionMatrix.memoryWithdraw.emptyText.includes("这段回忆已经撤回") &&
    !actionMatrix.memoryWithdraw.answerPresent && !actionMatrix.memoryWithdraw.followupPresent &&
    !actionMatrix.memoryWithdraw.draftValue && actionMatrix.memoryWithdraw.recoverHref === "/labs/memories/photos/photo-01",
  `ui_v2_memory_withdraw_not_closed:${JSON.stringify(actionMatrix.memoryWithdraw)}`);
  record("BL02", "撤回这段回忆", "button+confirm", "MEMORY.WITHDRAW", "clear answer/follow-up/draft and show recoverable empty state", actionMatrix.memoryWithdraw);

  await navigate("/labs/memories/photos/photo-01");
  await click('[data-action="MEMORY.START_QUESTION"]');
  await click("[data-question-retry]", "/labs/memories/memory-01");
  await click('[data-action="MEMORY.CONFIRM"]', "/labs/books/book-adventurex-night/contributions/memory-01");
  await click(".explicit-consent input");
  await click('[data-action="BOOK_MEMORY.AUTHORIZE"]');
  await acceptConfirm();
  await click('[data-action="BOOK_MEMORY.WITHDRAW"]');
  await click('[data-entry="BL04"]', "/manage/space-adventurex-2026/book-lab");
  const bl04Withdrawal = await evaluate(`({
    activeCount:document.querySelector('[data-active-memory-count]')?.textContent.trim()||'',
    excluded:document.body.innerText.includes('已排除 1 段撤回内容')
  })`);
  await click('[data-action="BOOK.OPEN_DRAFT"]', "/manage/space-adventurex-2026/book-lab/book-adventurex-night/draft");
  record("BL04", "打开书稿", "button", "BOOK.OPEN_DRAFT", "open editable draft", { path: "/manage/space-adventurex-2026/book-lab/book-adventurex-night/draft" });
  const bl05Withdrawal = await evaluate(`({
    pagePresent:Boolean(document.querySelector('[data-page-id="page-memory-01"]')),
    sourcePresent:document.body.innerText.includes('memory-01'),
    excluded:document.body.innerText.includes('已排除 1 段撤回内容')
  })`);
  actionMatrix.contributionWithdraw = { bl04: bl04Withdrawal, bl05: bl05Withdrawal };
  invariant(bl04Withdrawal.activeCount === "13" && bl04Withdrawal.excluded && !bl05Withdrawal.pagePresent &&
    !bl05Withdrawal.sourcePresent && bl05Withdrawal.excluded,
  `ui_v2_contribution_withdraw_not_closed:${JSON.stringify(actionMatrix.contributionWithdraw)}`);
  record("BL03→BL04/05", "不再让这段回忆出现在这本纪念册", "button+confirm", "BOOK_MEMORY.WITHDRAW",
    "remove withdrawn contribution from material count and draft", actionMatrix.contributionWithdraw);

  const beforeVersion = await evaluate("document.querySelector('[data-local-version-id]')?.dataset.localVersionId||''");
  await click('[data-action="BOOK.START_NEW_VERSION"]', "/manage/space-adventurex-2026/book-lab/book-adventurex-night/draft");
  actionMatrix.startNewVersion = await evaluate(`({
    before:${JSON.stringify(beforeVersion)},
    after:document.querySelector('[data-local-version-id]')?.dataset.localVersionId||'',
    revision:document.querySelector('[data-local-version-id]')?.dataset.localVersionRevision||'',
    editable:Boolean(document.querySelector('[data-title]:not([disabled])')),
    previewReset:Boolean(document.querySelector('[data-action="BOOK.GENERATE_PREVIEW"]')),
    stalePagePresent:Boolean(document.querySelector('[data-page-id="page-memory-01"]'))
  })`);
  invariant(actionMatrix.startNewVersion.before && actionMatrix.startNewVersion.after &&
    actionMatrix.startNewVersion.before !== actionMatrix.startNewVersion.after && actionMatrix.startNewVersion.revision === "3" &&
    actionMatrix.startNewVersion.editable && actionMatrix.startNewVersion.previewReset && !actionMatrix.startNewVersion.stalePagePresent,
  `ui_v2_start_new_version_not_closed:${JSON.stringify(actionMatrix.startNewVersion)}`);
  record("BL05", "制作新版", "button", "BOOK.START_NEW_VERSION", "new editable local revision with stale contribution excluded",
    actionMatrix.startNewVersion);

  await click('[data-action="BOOK.GENERATE_PREVIEW"]');
  await poll(async () => await evaluate('Boolean(document.querySelector(\'[data-action="BOOK.FREEZE"]\'))'), "new-version-preview");
  await click('[data-action="BOOK.FREEZE"]', "/s/space-adventurex-2026/books/book-adventurex-night/versions/book-version-02");
  const withdrawnReceiptPath = await evaluate("document.querySelector('.receipt-link')?.getAttribute('href')");
  const withdrawnReceipt = await (await fetch(`${origin}${withdrawnReceiptPath}`)).json();
  const withdrawnSourceIds = withdrawnReceipt.equality.orderedSourceIds.filter(Boolean);
  invariant(withdrawnReceipt.equality.pageCount === 15 && !withdrawnSourceIds.includes("photo-01"),
    `ui_v2_withdrawn_source_reused:${JSON.stringify(withdrawnReceipt.equality)}`);
  actionMatrix.contributionWithdraw.artifact = { pageCount: withdrawnReceipt.equality.pageCount, withdrawnSourceAbsent: true };
  const beforeReturnVersion = actionMatrix.startNewVersion.after;
  await click('[data-action="BOOK.START_NEW_VERSION"]', "/manage/space-adventurex-2026/book-lab/book-adventurex-night/draft");
  actionMatrix.returnEditNewVersion = await evaluate(`({
    before:${JSON.stringify(beforeReturnVersion)},
    after:document.querySelector('[data-local-version-id]')?.dataset.localVersionId||'',
    revision:document.querySelector('[data-local-version-id]')?.dataset.localVersionRevision||'',
    editable:Boolean(document.querySelector('[data-title]:not([disabled])')),
    previewReset:Boolean(document.querySelector('[data-action="BOOK.GENERATE_PREVIEW"]')),
    stalePagePresent:Boolean(document.querySelector('[data-page-id="page-memory-01"]'))
  })`);
  invariant(actionMatrix.returnEditNewVersion.after !== actionMatrix.returnEditNewVersion.before &&
    actionMatrix.returnEditNewVersion.revision === "4" && actionMatrix.returnEditNewVersion.editable &&
    actionMatrix.returnEditNewVersion.previewReset && !actionMatrix.returnEditNewVersion.stalePagePresent,
  `ui_v2_return_edit_new_version_not_closed:${JSON.stringify(actionMatrix.returnEditNewVersion)}`);
  record("BL06", "返回编辑新版", "button", "BOOK.START_NEW_VERSION", "create and open another editable local revision",
    actionMatrix.returnEditNewVersion);

  await navigate("/");
  await click('.product-header-link[href$="/album"]', "/s/space-gongguang/album");
  record("shared Core", "空间", "link", "navigation", "open accepted fixture album", { path: "/s/space-gongguang/album" });
  await click('.brand[href="/"]', "/");
  record("shared Core", "UNSEEN 首页", "link", "navigation", "return home", { path: "/" });
  await click('.product-header-link[href^="/labs/memories"]', "/labs/memories/photos/photo-01");
  record("shared Core", "照片记忆", "link", "navigation", "open disclosed Book fixture", { path: "/labs/memories/photos/photo-01" });
  await click('.book-journey a[href="/"]', "/");
  record("Book breadcrumb", "首页", "link", "navigation", "return Core home", { path: "/" });
  await navigate("/labs/memories/photos/photo-01");
  await click('.book-journey a[href*="/photos/"]', "/s/space-gongguang/photos/photo-1");
  record("Book breadcrumb", "向晚照片样本", "link", "navigation", "return disclosed independent Core photo", { path: "/s/space-gongguang/photos/photo-1" });
  await navigate("/");
  await click('.home-actions .text-link[href^="/labs/memories"]', "/labs/memories/photos/photo-01");
  record("home", "直接体验照片记忆", "link", "navigation", "open disclosed Book fixture", { path: "/labs/memories/photos/photo-01" });
  await click(".return-to-space", "/s/space-gongguang/album");
  record("shared Book", "返回空间", "link", "navigation", "return Core album", { path: "/s/space-gongguang/album" });
  await click('.product-journey a[href^="/manage/"]', "/manage/space-gongguang/book-lab");
  record("album journey", "纪念册", "link", "navigation", "open Book overview", { path: "/manage/space-gongguang/book-lab" });

  const stepRoutes = [
    ["BL01", "回答照片", "/labs/memories/photos/photo-01"],
    ["BL02", "写下回忆", "/labs/memories/memory-01"],
    ["BL03", "同意入书", "/labs/books/book-adventurex-night/contributions/memory-01"],
    ["BL04", "查看纪念册", "/manage/space-adventurex-2026/book-lab"],
    ["BL05", "编辑纪念册", "/manage/space-adventurex-2026/book-lab/book-adventurex-night/draft"],
    ["BL06", "阅读定稿", "/s/space-adventurex-2026/books/book-adventurex-night/versions/book-version-02"]
  ];
  await navigate(stepRoutes[0][2]);
  for (const [entry, label, path] of stepRoutes) {
    await click(`[data-entry="${entry}"]`, path);
    record("Book step navigation", label, "link", "navigation", `open ${path}`, { path });
  }

  await navigate("/labs/memories/photos/photo-01");
  await click(".evidence-panel summary");
  const samplePanel = await evaluate(`(()=>{const phase=document.querySelector('[data-evidence-phase]');phase.value='stable_error';phase.dispatchEvent(new Event('change',{bubbles:true}));return{
    path:location.pathname,copy:document.querySelector('.evidence-copy')?.textContent.trim(),
    liveFailure:Boolean(document.querySelector('[data-question-state="failed"]')),liveRetry:Boolean(document.querySelector('[data-question-retry]'))
  }})()`);
  invariant(samplePanel.path === "/labs/memories/photos/photo-01" && samplePanel.copy && !samplePanel.liveFailure && !samplePanel.liveRetry,
    `ui_v2_sample_panel_misclassified:${JSON.stringify(samplePanel)}`);
  actionMatrix.samplePhaseSelectors = { classification: "DISPLAY_ONLY_NOT_PRODUCT_ACTION", ...samplePanel };

  await viewport(1440, 1000);
  await navigate("/");
  results.push(await audit("desktop-1440-home", [".home-copy h1", ".home-actions .button-primary", ".fixture-banner"], true));
  await key("Tab");
  const keyboard = await evaluate("({tag:document.activeElement?.tagName,text:(document.activeElement?.innerText||document.activeElement?.getAttribute('aria-label')||'').trim(),outline:getComputedStyle(document.activeElement).outlineStyle})");
  invariant(keyboard.tag === "A" && keyboard.text && keyboard.outline !== "none", `ui_v2_keyboard_focus:${JSON.stringify(keyboard)}`);
  await click(".home-actions .button-primary", "/s/space-gongguang/album");
  record("home", "进入「向晚婚礼」", "link", "navigation", "open album", { path: "/s/space-gongguang/album" });
  results.push(await audit("desktop-1440-space", [".space-title-row h1", ".photo-card a", ".product-journey"], true));
  await click('.view-tabs a[href$="/scene"]', "/s/space-gongguang/scene");
  record("album", "现场", "link", "VIEW.OPEN_SCENE", "open scene", { path: "/s/space-gongguang/scene" });
  await click('.view-tabs a[href$="/album"]', "/s/space-gongguang/album");
  record("scene", "相册", "link", "VIEW.OPEN_ALBUM", "return album", { path: "/s/space-gongguang/album" });
  await click(".photo-card a", "/s/space-gongguang/photos/photo-1");
  record("album", "查看烛光亮起时", "link", "PHOTO.OPEN_DETAIL", "open photo detail", { path: "/s/space-gongguang/photos/photo-1" });
  const desktopPhoto = await audit("desktop-1440-photo", [".photo-detail-panel h1", ".memory-bridge a", ".memory-bridge"], true);
  invariant(desktopPhoto.sampleBoundary, `ui_v2_sample_disclosure_missing:${JSON.stringify(desktopPhoto)}`);
  results.push(desktopPhoto);
  await click('.photo-detail-panel .button-primary[href*="/scene"]', "/s/space-gongguang/scene");
  record("photo", "回到现场", "link", "PHOTO.RETURN_TO_SCENE", "open scene at photo", { path: "/s/space-gongguang/scene" });
  await navigate("/s/space-gongguang/photos/photo-1");
  await click('a.text-link[href$="/album"]', "/s/space-gongguang/album");
  record("photo", "返回原来的相册位置", "link", "navigation", "return album", { path: "/s/space-gongguang/album" });
  await click(".photo-card a", "/s/space-gongguang/photos/photo-1");
  await click(".memory-bridge a", "/labs/memories/photos/photo-01");
  record("photo", "进入 AdventureX 记忆样本", "link", "navigation", "open explicitly independent Book fixture", { path: "/labs/memories/photos/photo-01" });
  results.push(await audit("desktop-1440-memory", [".task-card h2", '[data-action="MEMORY.START_QUESTION"]', ".fixture-context"], true));
  invariant(!await evaluate("Boolean(document.querySelector('[data-question-state=failed]'))"), "ui_v2_memory_should_start_ready");
  await client.send("Page.bringToFront");
  await focusByTab('[data-action="MEMORY.START_QUESTION"]');
  await key(" ", "Space");
  await poll(async () => await evaluate("Boolean(document.querySelector('[data-question-state=failed]'))"), "desktop failure state");
  record("BL01", "看看这张照片想问什么", "button+keyboard", "MEMORY.START_QUESTION", "show deterministic fail-closed recovery", { failedOnSameRoute: true });
  invariant(await evaluate("location.pathname==='/labs/memories/photos/photo-01'"), "ui_v2_memory_failure_changed_route");
  const recoveryFocus = await evaluate("({action:document.activeElement?.dataset?.action,text:document.activeElement?.innerText?.trim(),matches:document.activeElement?.matches('[data-question-retry]:focus'),outline:getComputedStyle(document.activeElement).outlineStyle,outlineWidth:getComputedStyle(document.activeElement).outlineWidth})");
  invariant(recoveryFocus.action === "MEMORY.START_QUESTION" && recoveryFocus.outline !== "none", `ui_v2_memory_recovery_focus:${JSON.stringify(recoveryFocus)}`);
  results.push(await audit("desktop-1440-memory-failure", ["[data-question-state=failed]", "[data-question-retry]", '[data-question-state="failed"] [data-action="MEMORY.SKIP"]', ".fixture-context"], true));
  await key(" ", "Space");
  await poll(async () => await evaluate("location.pathname==='/labs/memories/memory-01'"), "keyboard retry");
  record("BL01", "再想一个问题", "button+keyboard", "MEMORY.START_QUESTION", "recover to answer route", { path: "/labs/memories/memory-01" });
  await click('[data-action="MEMORY.CONFIRM"]', "/labs/books/book-adventurex-night/contributions/memory-01");
  record("BL02", "确认这个回答版本", "button", "MEMORY.CONFIRM", "open per-book consent", { path: "/labs/books/book-adventurex-night/contributions/memory-01" });
  await click(".explicit-consent input");
  await click('[data-action="BOOK_MEMORY.AUTHORIZE"]');
  record("BL03", "同意把这段回忆收入这本纪念册", "checkbox+button", "BOOK_MEMORY.AUTHORIZE", "show active per-book withdrawal control", { authorized: true });
  await click('[data-entry="BL04"]', "/manage/space-adventurex-2026/book-lab");
  await click('[data-action="BOOK.CREATE"]', "/manage/space-adventurex-2026/book-lab/book-adventurex-night/draft");
  record("BL04", "创建一本纪念册", "button", "BOOK.CREATE", "open new editable draft", { path: "/manage/space-adventurex-2026/book-lab/book-adventurex-night/draft" });
  await click('[data-action="BOOK.FREEZE"]', "/s/space-adventurex-2026/books/book-adventurex-night/versions/book-version-02");
  results.push(await audit("desktop-1440-book", [".reader-shell h1", '[data-action="BOOK.DOWNLOAD_PDF"]', ".reader-frame .draft-page"], true));

  await navigate("/labs/memories/photos/photo-01");
  await click('[data-action="MEMORY.START_QUESTION"]');
  await poll(async () => await evaluate("Boolean(document.querySelector('[data-question-state=failed]'))"), "desktop skip failure state");
  await key("Tab");
  invariant(await evaluate("document.activeElement?.dataset?.action==='MEMORY.SKIP'"), "ui_v2_memory_skip_not_keyboard_focused");
  await key(" ", "Space");
  await poll(async () => await evaluate("document.querySelector('#status')?.textContent==='已跳过，之后仍可回来'"), "keyboard skip success");
  record("BL01", "先跳过这张", "button+keyboard", "MEMORY.SKIP", "dismiss failure and keep photo available", { status: "已跳过，之后仍可回来" });
  invariant(!await evaluate("Boolean(document.querySelector('[data-question-state=failed]'))"), "ui_v2_memory_skip_did_not_recover");
  results.push(await audit("desktop-1440-memory-skipped", [".task-card h2", '[data-action="MEMORY.START_QUESTION"]', ".privacy-note", ".fixture-context"], true));

  await navigate("/manage/space-adventurex-2026/book-lab/book-adventurex-night/draft");
  await setValue("[data-title]", "灯熄以后，我们还在");
  await click('[data-action="BOOK.EDIT_TITLE"]');
  const titleEdit = await evaluate(`({title:document.querySelector('h1')?.textContent.trim(),previewReset:Boolean(document.querySelector('[data-action="BOOK.GENERATE_PREVIEW"]'))})`);
  invariant(titleEdit.title === "灯熄以后，我们还在" && titleEdit.previewReset, `ui_v2_title_edit_failed:${JSON.stringify(titleEdit)}`);
  record("BL05", "修改纪念册标题", "button", "BOOK.EDIT_TITLE", "save title and invalidate preview", titleEdit);

  await click('[data-page-index="1"]');
  record("BL05", "第 2 页", "page thumbnail button", "local draft navigation", "select one editable content page", { page: 2 });
  const beforePhoto = await evaluate("document.querySelector('.page-stage img')?.getAttribute('src')||''");
  const removedPageId = await evaluate("document.querySelector('.page-thumb.active')?.dataset.pageId||''");
  await click('[data-action="BOOK.REPLACE_PAGE_PHOTO"]');
  const afterPhoto = await evaluate("document.querySelector('.page-stage img')?.getAttribute('src')||''");
  invariant(beforePhoto && afterPhoto && beforePhoto !== afterPhoto, "ui_v2_replace_photo_failed");
  record("BL05", "更换这一页的照片", "button", "BOOK.REPLACE_PAGE_PHOTO", "change display photo without changing source", { changed: true });

  await acceptConfirm();
  await click('[data-action="BOOK.REMOVE_PAGE"]');
  const removedPage = await evaluate(`({count:document.querySelectorAll('[data-page-id]').length,removed:Boolean(document.querySelector('[data-page-id="${removedPageId}"]'))})`);
  invariant(removedPage.count === 15 && !removedPage.removed, `ui_v2_remove_page_failed:${JSON.stringify(removedPage)}`);
  record("BL05", "从书稿中移除这一页", "button+confirm", "BOOK.REMOVE_PAGE", "remove only the selected draft page", removedPage);

  await click('[data-action="BOOK.GENERATE_PREVIEW"]');
  await poll(async () => await evaluate('Boolean(document.querySelector(\'[data-action="BOOK.FREEZE"]\'))'), "edited-preview");
  const preview = await evaluate("({status:document.querySelector('#status')?.textContent,freezeReady:Boolean(document.querySelector('[data-action=\"BOOK.FREEZE\"]'))})");
  invariant(preview.freezeReady && preview.status === "预览已生成", `ui_v2_generate_preview_failed:${JSON.stringify(preview)}`);
  record("BL05", "生成成书预览", "button", "BOOK.GENERATE_PREVIEW", "render current edited 15-page draft", preview);

  await click('[data-action="BOOK.FREEZE"]', "/s/space-adventurex-2026/books/book-adventurex-night/versions/book-version-02");
  const frozen = await evaluate("({title:document.querySelector('h1')?.textContent.trim(),counter:document.querySelector('.reader-nav span')?.textContent.trim()})");
  invariant(frozen.title === "灯熄以后，我们还在" && frozen.counter === "1 / 15", `ui_v2_freeze_failed:${JSON.stringify(frozen)}`);
  record("BL05", "确认成书", "button", "BOOK.FREEZE", "open immutable reader for edited draft", frozen);
  results.push(await audit("desktop-1440-action-matrix-book", [".reader-shell h1", '[data-action="BOOK.DOWNLOAD_PDF"]', 'a[href*="book.html"]', ".receipt-link"], true));

  await click('[data-page-step="1"]');
  const nextPage = await evaluate("document.querySelector('.reader-nav span')?.textContent.trim()");
  await click('[data-page-step="-1"]');
  const previousPage = await evaluate("document.querySelector('.reader-nav span')?.textContent.trim()");
  invariant(nextPage === "2 / 15" && previousPage === "1 / 15", `ui_v2_reader_paging_failed:${nextPage}:${previousPage}`);
  record("BL06", "上一页 / 下一页", "buttons", "local reader navigation", "move one page and return", { nextPage, previousPage });

  const htmlPath = await evaluate("new URL(document.querySelector('a[href*=\"book.html\"]').href).pathname");
  const receiptPath = await evaluate("new URL(document.querySelector('.receipt-link').href).pathname");
  const htmlTarget = await clickNewTarget('a[href*="book.html"]', htmlPath);
  const receiptTarget = await clickNewTarget(".receipt-link", receiptPath);
  const htmlResponse = await fetch(htmlTarget);
  const htmlText = await htmlResponse.text();
  const receiptResponse = await fetch(receiptTarget);
  const receipt = await receiptResponse.json();
  invariant(htmlResponse.ok && htmlText.includes("灯熄以后，我们还在") && receiptResponse.ok &&
    receipt.equality.title === "灯熄以后，我们还在" && receipt.equality.pageCount === 15,
  `ui_v2_html_receipt_failed:${JSON.stringify({ html: htmlResponse.status, receipt: receiptResponse.status, equality: receipt.equality })}`);
  record("BL06", "查看印刷版", "new-tab link", "artifact HTML", "open canonical HTML from current manifest", { path: htmlPath, title: receipt.equality.title });
  record("BL06", "查看版本校验记录", "new-tab link", "artifact receipt", "open receipt matching current manifest", { path: receiptPath, pageCount: receipt.equality.pageCount });

  const pdfCount = pdfResponses.length;
  await click('[data-action="BOOK.DOWNLOAD_PDF"]');
  await poll(async () => pdfResponses.length > pdfCount, "pdf-download-response", 30_000);
  const pdfNetwork = pdfResponses.at(-1);
  const pdfResponse = await fetch(pdfNetwork.url);
  const pdf = Buffer.from(await pdfResponse.arrayBuffer());
  invariant(pdfNetwork.status === 200 && pdfResponse.ok && pdf.subarray(0, 5).toString() === "%PDF-" &&
    /^attachment;/iu.test(pdfResponse.headers.get("content-disposition") || ""),
  `ui_v2_pdf_download_failed:${JSON.stringify({ network: pdfNetwork, status: pdfResponse.status, prefix: pdf.subarray(0, 5).toString() })}`);
  record("BL06", "下载纪念册", "button", "BOOK.DOWNLOAD_PDF", "download current manifest PDF", {
    status: pdfNetwork.status, mimeType: pdfNetwork.mimeType, bytes: pdf.length, contentDisposition: pdfResponse.headers.get("content-disposition")
  });

  await viewport(390, 844, true);
  await navigate("/");
  results.push(await audit("mobile-390-home", [".home-copy h1", ".home-actions .button-primary", ".fixture-banner"], true));
  await navigate("/s/space-gongguang/album");
  results.push(await audit("mobile-390-space", [".space-title-row h1", ".photo-card a", ".product-journey"], true));
  await navigate("/s/space-gongguang/photos/photo-1");
  const mobilePhoto = await audit("mobile-390-photo", [".photo-detail-panel h1", ".memory-bridge a", ".memory-bridge"], true);
  invariant(mobilePhoto.sampleBoundary, `ui_v2_mobile_sample_disclosure_missing:${JSON.stringify(mobilePhoto)}`);
  results.push(mobilePhoto);
  await navigate("/labs/memories/photos/photo-01");
  results.push(await audit("mobile-390-memory", [".task-card h2", '[data-action="MEMORY.START_QUESTION"]', ".fixture-context"], true));
  await click('[data-action="MEMORY.START_QUESTION"]');
  await poll(async () => await evaluate("Boolean(document.querySelector('[data-question-state=failed]'))"), "mobile failure state");
  results.push(await audit("mobile-390-memory-failure", ["[data-question-state=failed]", "[data-question-retry]", '[data-question-state="failed"] [data-action="MEMORY.SKIP"]', ".task-card"], true));
  await click("[data-question-retry]", "/labs/memories/memory-01");
  await navigate("/labs/memories/photos/photo-01");
  await click('[data-action="MEMORY.START_QUESTION"]');
  await poll(async () => await evaluate("Boolean(document.querySelector('[data-question-state=failed]'))"), "mobile skip failure state");
  await click('[data-question-state="failed"] [data-action="MEMORY.SKIP"]');
  await poll(async () => await evaluate("document.querySelector('#status')?.textContent==='已跳过，之后仍可回来'"), "mobile skip success");
  invariant(!await evaluate("Boolean(document.querySelector('[data-question-state=failed]'))"), "ui_v2_mobile_skip_did_not_recover");
  results.push(await audit("mobile-390-memory-skipped", [".task-card h2", '[data-action="MEMORY.START_QUESTION"]', ".privacy-note", ".task-card"], true));
  await navigate("/s/space-adventurex-2026/books/book-adventurex-night/versions/book-version-02");
  results.push(await audit("mobile-390-book", [".reader-shell h1", '[data-action="BOOK.DOWNLOAD_PDF"]', ".reader-frame .draft-page"], true));

  await navigate("/labs/memories/memory-01");
  await click(".danger-zone summary");
  results.push(await audit("mobile-390-memory-withdraw", [".danger-zone summary", '.danger-zone [data-action="MEMORY.WITHDRAW"]', ".fixture-context"], true));
  await acceptConfirm();
  await click('.danger-zone [data-action="MEMORY.WITHDRAW"]');
  const mobileMemoryWithdraw = await evaluate("({empty:Boolean(document.querySelector('[data-memory-empty]')),answer:Boolean(document.querySelector('textarea'))})");
  invariant(mobileMemoryWithdraw.empty && !mobileMemoryWithdraw.answer, `ui_v2_mobile_memory_withdraw_failed:${JSON.stringify(mobileMemoryWithdraw)}`);

  await navigate("/labs/books/book-adventurex-night/contributions/memory-01");
  await click(".explicit-consent input");
  await click('[data-action="BOOK_MEMORY.AUTHORIZE"]');
  await acceptConfirm();
  await click('[data-action="BOOK_MEMORY.WITHDRAW"]');
  await click('[data-entry="BL04"]', "/manage/space-adventurex-2026/book-lab");
  const mobileContributionWithdraw = await evaluate("({count:document.querySelector('[data-active-memory-count]')?.textContent.trim(),excluded:document.body.innerText.includes('已排除 1 段撤回内容')})");
  invariant(mobileContributionWithdraw.count === "13" && mobileContributionWithdraw.excluded,
    `ui_v2_mobile_contribution_withdraw_failed:${JSON.stringify(mobileContributionWithdraw)}`);

  await click('[data-action="BOOK.OPEN_DRAFT"]', "/manage/space-adventurex-2026/book-lab/book-adventurex-night/draft");
  await click('[data-action="BOOK.START_NEW_VERSION"]', "/manage/space-adventurex-2026/book-lab/book-adventurex-night/draft");
  const mobileStartVersion = await evaluate("({revision:document.querySelector('[data-local-version-id]')?.dataset.localVersionRevision,editable:Boolean(document.querySelector('[data-title]:not([disabled])')),stale:Boolean(document.querySelector('[data-page-id=\"page-memory-01\"]'))})");
  invariant(mobileStartVersion.revision === "3" && mobileStartVersion.editable && !mobileStartVersion.stale,
    `ui_v2_mobile_start_version_failed:${JSON.stringify(mobileStartVersion)}`);
  results.push(await audit("mobile-390-new-version", ["[data-local-version-id]", "[data-title]", '[data-action="BOOK.GENERATE_PREVIEW"]'], true));

  await navigate("/s/space-adventurex-2026/books/book-adventurex-night/versions/book-version-02");
  results.push(await audit("mobile-390-return-edit-new", ['[data-action="BOOK.START_NEW_VERSION"]', '[data-action="BOOK.DOWNLOAD_PDF"]', ".fixture-context"], true));
  await click('[data-action="BOOK.START_NEW_VERSION"]', "/manage/space-adventurex-2026/book-lab/book-adventurex-night/draft");
  const mobileReturnVersion = await evaluate("({revision:document.querySelector('[data-local-version-id]')?.dataset.localVersionRevision,editable:Boolean(document.querySelector('[data-title]:not([disabled])'))})");
  invariant(mobileReturnVersion.revision === "3" && mobileReturnVersion.editable,
    `ui_v2_mobile_return_version_failed:${JSON.stringify(mobileReturnVersion)}`);
  actionMatrix.mobile390 = {
    memoryWithdraw: mobileMemoryWithdraw, contributionWithdraw: mobileContributionWithdraw,
    startNewVersion: mobileStartVersion, returnEditNewVersion: mobileReturnVersion
  };

  await viewport(720, 900);
  await navigate("/");
  const zoomEquivalent = await audit("desktop-1440-at-200-percent", [".home-copy h1", ".home-actions .button-primary", ".fixture-banner"]);
  invariant(zoomEquivalent.viewport.width === 720, "ui_v2_200_percent_equivalent_invalid");
  results.push(zoomEquivalent);
  await navigate("/s/space-adventurex-2026/books/book-adventurex-night/versions/book-version-02");
  results.push(await audit("book-at-200-percent", [".reader-shell h1", '[data-action="BOOK.DOWNLOAD_PDF"]', ".fixture-nav"], true));

  invariant(consoleIssues.length === 0, `ui_v2_console_issues:${JSON.stringify(consoleIssues)}`);
  invariant(httpFailures.length === 0, `ui_v2_http_failures:${JSON.stringify(httpFailures)}`);
  invariant(externalRequests.length === 0, `ui_v2_external_requests:${JSON.stringify(externalRequests)}`);
  actionMatrix.coreBranchBoundary = {
    status: "NOT_EXERCISED",
    reason: "The existing UI-v2 harness exposes no supported Core empty/error state injection; production code was not changed to manufacture one."
  };
  const evidence = {
    schema: "unseen-ui-v2-copy-action-matrix/1", status: "PASS", origin, browser: "Google Chrome headless",
    commit: (await (await import("node:child_process")).execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })).trim(),
    baseCandidate: "4028310f02feb3e0d992c8ea56403cf4764d86c8",
    candidateBound: true,
    fixture: true, fixtureNotice: health.fixtureNotice, samples: health.samples, productPath: health.productPath, flow: ["home", "space", "photo", "BL01", "BL02", "BL03", "BL04", "BL05", "BL06"],
    keyboardFocus: keyboard, recoveryFocus, actionClosure: {
      normalToFailure: true, retryViaKeyboard: true, skipViaKeyboard: true, mobileRetry: true, mobileSkip: true,
      memoryWithdraw: true, contributionWithdraw: true, startNewVersion: true, returnEditNewVersion: true
    },
    actionMatrix,
    fileInputBoundary: "not exercised in this slice; DataTransfer automation remains the declared browser boundary",
    diagnostics: { consoleIssues, httpFailures, externalRequests, externalResources: 0 }, results
  };
  await writeFile(resolve(evidenceRoot, "CHROME-DESKTOP-MOBILE.json"), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ status: "UI_V2_COPY_ACTION_MATRIX_CHROME_OK", evidence: resolve(evidenceRoot, "CHROME-DESKTOP-MOBILE.json"), controls: actionMatrix.controls.length, screenshots: results.filter((item) => item.name.startsWith("desktop-") || item.name.startsWith("mobile-")).length, paths: evidence.flow }, null, 2)}\n`);
  client.close();
} finally {
  if (browser.exitCode === null) browser.kill("SIGTERM");
  await Promise.race([once(browser, "exit"), delay(2_000)]).catch(() => {});
  await rm(profile, { recursive: true, force: true });
}
