import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { concreteRoute } from "../src/routes.mjs";
import { fixtureBundle } from "../../book-renderer/fixtures/frozen-book-fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const evidenceRoot = resolve(here, "evidence");
const offlineEvidenceRoot = resolve(repoRoot, "release-evidence/local-operable/bl01-provider-offline");
const privateAiEvidenceRoot = resolve(repoRoot, "release-evidence/local-operable/private-ai-queued-offline");
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const appPort = 4343;
const debugPort = 9343;
const origin = `http://127.0.0.1:${appPort}`;
const profile = await mkdtemp(resolve(tmpdir(), "unseen-book-audit-chrome-"));

const server = spawn(process.execPath, ["packages/book-lab-web/scripts/dev-server.mjs"], {
  cwd: repoRoot,
  env: { ...process.env, UNSEEN_BOOK_LAB_PORT: String(appPort) },
  stdio: ["ignore", "pipe", "pipe"]
});
const browser = spawn(chrome, [
  "--headless=new", "--disable-background-networking", "--disable-component-update", "--disable-default-apps", "--disable-sync", "--no-first-run",
  `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "about:blank"
], { stdio: ["ignore", "pipe", "pipe"] });

async function waitFor(url) {
  for (let count = 0; count < 120; count += 1) {
    try { const response = await fetch(url); if (response.ok) return response; } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  }
  throw new Error(`wait_timeout:${url}`);
}

function cdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  let nextId = 1;
  const pending = new Map();
  const eventWaiters = new Map();
  const eventListeners = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const callback = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) callback.reject(new Error(message.error.message)); else callback.resolve(message.result);
      return;
    }
    const waiters = eventWaiters.get(message.method) ?? [];
    eventWaiters.delete(message.method);
    for (const resolveEvent of waiters) resolveEvent(message.params);
    for (const listener of eventListeners.get(message.method) ?? []) listener(message.params);
  });
  return {
    ready: new Promise((resolveReady, rejectReady) => {
      socket.addEventListener("open", resolveReady, { once: true });
      socket.addEventListener("error", rejectReady, { once: true });
    }),
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolveCommand, rejectCommand) => {
        pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    once(method) {
      return new Promise((resolveEvent) => eventWaiters.set(method, [...(eventWaiters.get(method) ?? []), resolveEvent]));
    },
    on(method, listener) {
      eventListeners.set(method, [...(eventListeners.get(method) ?? []), listener]);
    },
    close() { socket.close(); }
  };
}

const cases = [
  ...[320, 390, 1247, 1248, 1440].map((width) => ({ entry: "BL05", width, height: 1000, mode: "required_viewport" })),
  ...["BL01", "BL02", "BL03", "BL04", "BL06"].flatMap((entry) => [320, 390, 1440].map((width) => ({ entry, width, height: 1000, mode: "route_mobile_desktop" }))),
  { entry: "BL03", width: 624, height: 1000, mode: "1248_at_200_percent_effective_css_viewport" },
  { entry: "BL05", width: 624, height: 1000, mode: "1248_at_200_percent_effective_css_viewport" },
  { entry: "BL06", width: 624, height: 1000, mode: "1248_at_200_percent_effective_css_viewport" }
];

const keyContentRequirements = {
  BL01: [[".task-card h2", "你拍下入口灯串时"], [".button.primary", "看看这张照片想问什么"]],
  BL02: [[".answer-field textarea", "我们刚把最后一盒相片搬进来"], [".button.primary", "确认这个回答版本"]],
  BL03: [[".quote-proof blockquote", "我们刚把最后一盒相片搬进来"], [".explicit-consent span", "以后可以撤回"], [".button.primary", "同意把这段回忆收入这本纪念册"]],
  BL04: [[".book-cover-mini strong", "共光以后"], [".material-summary > p:not(.kicker)", "未授权的草稿"], [".button.primary", "创建一本纪念册"]],
  BL05: [[".page-header > p:last-child", "来源照片、原话和授权"], [".cover-draft strong", "共光以后"], [".button.primary", "确认成书"]],
  BL06: [[".page-header > p:last-child", "纪念册文件与印刷版来自同一份定稿"], [".cover-draft strong", "共光以后"], [".button.primary", "下载纪念册"], [".receipt-link", "查看版本校验记录"]]
};

const auditExpression = `(() => {
  const label = (element) => (element.getAttribute('aria-label') || element.getAttribute('title') || element.labels?.[0]?.textContent || element.closest('label')?.textContent || element.textContent || element.getAttribute('alt') || '').trim();
  const requirements = ${JSON.stringify(keyContentRequirements)};
  const horizontalBounds = (element, selector, expected) => {
    const rect = element.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(element);
    const textRects = [...range.getClientRects()].filter((item) => item.width > 0 && item.height > 0);
    const clipAncestors = [];
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (!['hidden', 'clip', 'scroll', 'auto'].includes(style.overflowX)) continue;
      const ancestorRect = ancestor.getBoundingClientRect();
      if (rect.left < ancestorRect.left - .5 || rect.right > ancestorRect.right + .5) {
        clipAncestors.push(ancestor.className || ancestor.tagName);
      }
    }
    const value = element.matches('input, textarea, select') ? element.value : element.textContent;
    const style = getComputedStyle(element);
    return {
      selector,
      expected,
      value: String(value || '').trim().replace(/\\s+/g, ' '),
      left: rect.left,
      right: rect.right,
      inViewport: rect.left >= -.5 && rect.right <= innerWidth + .5 && textRects.every((item) => item.left >= -.5 && item.right <= innerWidth + .5),
      selfClipped: ['hidden', 'clip'].includes(style.overflowX) && element.scrollWidth > element.clientWidth + 1,
      clipAncestors
    };
  };
  const controls = [...document.querySelectorAll('button,a[href],input,textarea,select,summary')].filter((element) => element.getClientRects().length > 0);
  const images = [...document.images];
  const externalResources = performance.getEntriesByType('resource').map((entry) => entry.name).filter((url) => {
    try { const parsed = new URL(url); return parsed.protocol !== 'data:' && parsed.origin !== location.origin; } catch { return true; }
  });
  return {
    entry: document.body.dataset.entry,
    fixtureLabelVisible: document.body.innerText.includes('确定性本地样本'),
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    keyContent: [
      ['.fixture-badge', '确定性本地样本 · 非真实 AI 问题质量'],
      ...(requirements[document.body.dataset.entry] || [])
    ].map(([selector, expected]) => {
      const element = document.querySelector(selector);
      return element ? horizontalBounds(element, selector, expected) : { selector, expected, missing: true };
    }),
    enabledPrimaryActions: [...document.querySelectorAll('.button.primary:not([disabled])')].map((element) => element.textContent.trim()),
    unnamedControls: controls.filter((element) => !label(element)).map((element) => element.outerHTML.slice(0, 160)),
    missingImageAlt: images.filter((image) => !image.alt.trim()).length,
    externalResources,
    focusRulePresent: [...document.styleSheets].some((sheet) => [...sheet.cssRules].some((rule) => rule.cssText.includes(':focus-visible'))),
    reducedMotionMatches: matchMedia('(prefers-reduced-motion: reduce)').matches,
    contentLength: document.querySelector('main')?.innerText.length ?? 0
  };
})()`;

try {
  await waitFor(`${origin}/__fixture`);
  const version = await waitFor(`http://127.0.0.1:${debugPort}/json/version`);
  const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const page = pages.find((target) => target.type === "page");
  if (!page) throw new Error("page_target_not_found");
  const client = cdp(page.webSocketDebuggerUrl ?? (await version.json()).webSocketDebuggerUrl);
  await client.ready;
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("Accessibility.enable");
  await client.send("Network.enable");
  const browserDiagnostics = { consoleErrors: [], exceptions: [], failedRequests: [], httpErrors: [] };
  client.on("Runtime.consoleAPICalled", (event) => {
    if (["assert", "error", "warning"].includes(event.type)) browserDiagnostics.consoleErrors.push(event.type);
  });
  client.on("Runtime.exceptionThrown", (event) => browserDiagnostics.exceptions.push(event.exceptionDetails?.text ?? "exception"));
  client.on("Network.loadingFailed", (event) => browserDiagnostics.failedRequests.push(event.errorText ?? "failed"));
  client.on("Network.responseReceived", (event) => {
    if (event.response.status >= 400) browserDiagnostics.httpErrors.push(event.response.status);
  });
  const results = [];
  for (const item of cases) {
    await client.send("Emulation.setDeviceMetricsOverride", { width: item.width, height: item.height, deviceScaleFactor: 1, mobile: item.width < 700 });
    await client.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    const loaded = client.once("Page.loadEventFired");
    await client.send("Page.navigate", { url: `${origin}${concreteRoute(item.entry, fixtureBundle)}` });
    await loaded;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const ready = await client.send("Runtime.evaluate", { expression: `document.body.dataset.entry === ${JSON.stringify(item.entry)} && (document.querySelector('main')?.innerText.length ?? 0) >= 100`, returnByValue: true });
      if (ready.result.value) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    await client.send("Runtime.evaluate", { expression: "document.activeElement?.blur()" });
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab" });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab" });
    const keyboard = await client.send("Runtime.evaluate", { expression: "({tag: document.activeElement?.tagName, text: (document.activeElement?.textContent || document.activeElement?.getAttribute('aria-label') || '').trim()})", returnByValue: true });
  const axTree = await client.send("Accessibility.getFullAXTree");
    const evaluated = await client.send("Runtime.evaluate", { expression: auditExpression, returnByValue: true });
    const axNodes = axTree.nodes.filter((node) => !node.ignored);
    const result = {
      ...item,
      ...evaluated.result.value,
      keyboardFirstFocus: keyboard.result.value,
      axLandmarks: [...new Set(axNodes.map((node) => node.role?.value).filter((role) => ["main", "navigation", "banner"].includes(role)))],
      axUnnamedButtons: axNodes.filter((node) => node.role?.value === "button" && !node.name?.value?.trim()).length
    };
    if (result.entry !== item.entry) throw new Error(`route_entry_mismatch:${item.entry}`);
    if (!result.fixtureLabelVisible) throw new Error(`fixture_label_missing:${item.entry}:${item.width}`);
    if (result.horizontalOverflow) throw new Error(`horizontal_overflow:${item.entry}:${item.width}:${result.documentWidth}`);
    if (result.enabledPrimaryActions.length > 1) throw new Error(`multiple_primary_actions:${item.entry}:${item.width}`);
    if (result.unnamedControls.length) throw new Error(`unnamed_controls:${item.entry}:${item.width}:${JSON.stringify(result.unnamedControls)}`);
    if (result.missingImageAlt) throw new Error(`missing_image_alt:${item.entry}:${item.width}`);
    if (result.externalResources.length) throw new Error(`external_resources:${item.entry}:${item.width}`);
    if (!result.focusRulePresent || !result.reducedMotionMatches) throw new Error(`a11y_media_missing:${item.entry}:${item.width}`);
    if (!result.keyboardFirstFocus?.text || result.keyboardFirstFocus.tag !== "A") throw new Error(`keyboard_focus_missing:${item.entry}:${item.width}`);
    if (!result.axLandmarks.includes("main") || !result.axLandmarks.includes("navigation") || result.axUnnamedButtons) throw new Error(`accessibility_tree_invalid:${item.entry}:${item.width}`);
    if (result.contentLength < 100) throw new Error(`empty_page:${item.entry}:${item.width}`);
    if ([320, 390].includes(item.width)) {
      const invalidContent = result.keyContent.filter((content) => content.missing || !content.value.includes(content.expected) || !content.inViewport || content.selfClipped || content.clipAncestors.length);
      if (invalidContent.length) throw new Error(`mobile_content_clipped:${item.entry}:${item.width}:${JSON.stringify(invalidContent)}`);
      const badge = result.keyContent.find((content) => content.selector === ".fixture-badge");
      if (badge.value !== "确定性本地样本 · 非真实 AI 问题质量") throw new Error(`fixture_label_incomplete:${item.entry}:${item.width}`);
    }
    results.push(result);
  }

  const policyAuditResult = await client.send("Runtime.evaluate", {
    expression: `(async () => {
      const { BookLabIntegratedTransport } = await import('/packages/book-lab-web/src/integrated-transport.mjs');
      let fetchCalls = 0;
      const transport = new BookLabIntegratedTransport({ origin: location.origin, fetchImpl: async () => { fetchCalls += 1; } });
      const parameters = { photoId: 'photo-01', memoryId: 'memory-01', personalMemoryId: 'memory-01', bookId: 'book-01', spaceId: 'space-01', versionId: 'version-01', pageId: 'page-01' };
      const invalid = [
        ['BOOK.CREATE', { ifMatch: '"wrong"' }],
        ['BOOK.EDIT_TITLE', { ifMatch: '"etag"', ifNoneMatch: '*' }],
        ['BOOK_MEMORY.AUTHORIZE', { ifMatch: '"etag"' }],
        ['MEMORY.START_QUESTION', {}],
        ['MEMORY.START_QUESTION', { ifMatch: '"etag"', ifNoneMatch: '*' }],
        ['MEMORY.START_QUESTION', { ifNoneMatch: '"wrong"' }],
        ['MEMORY.SKIP', {}],
        ['MEMORY.SKIP', { ifMatch: '"etag"', ifNoneMatch: '*' }],
        ['MEMORY.SKIP', { ifNoneMatch: '"wrong"' }]
      ];
      const errors = [];
      for (const [actionId, conditionals] of invalid) {
        try {
          await transport.requestAction(actionId, { parameters, body: {}, idempotencyKey: actionId, ...conditionals });
          errors.push(null);
        } catch (error) {
          errors.push(error.code ?? error.name);
        }
      }
      return { fetchCalls, errors };
    })()`,
    awaitPromise: true,
    returnByValue: true
  });
  const integratedPolicy = policyAuditResult.result.value;
  if (integratedPolicy.fetchCalls !== 0 || integratedPolicy.errors.some((code) => code !== "invalid_precondition_shape")) {
    throw new Error(`integrated_precondition_browser_escape:${JSON.stringify(integratedPolicy)}`);
  }

  const shellAuditResult = await client.send("Runtime.evaluate", {
    expression: `(async () => {
      const [{ renderIntegratedBookLabPage }, { ACTION_REQUESTS }] = await Promise.all([
        import('/packages/book-lab-web/src/integrated-shell.mjs'),
        import('/packages/book-lab-web/src/integrated-transport.mjs')
      ]);
      const catalog = { actions: Object.fromEntries(Object.keys(ACTION_REQUESTS).map((id) => [id, { initial: id }])) };
      const hostile = '<img src=x onerror="globalThis.pwned=1">';
      const html = renderIntegratedBookLabPage({ entry: 'BL02', route: { parameters: { memoryId: 'memory-01' } }, response: {
        ok: true, status: 200, etag: '"memory-1"', unseenHeaders: {}, body: {
          memory: { personalMemoryId: 'memory-01', status: 'draft', interviewVersion: 1, headSubmissionId: 'submission-01' },
          submissions: [{ submissionId: 'submission-01', submissionHash: 'a'.repeat(64), userText: hostile }],
          recoverableQuestionJobs: [{ question: '发生了什么？' }]
        }
      } }, catalog);
      const template = document.createElement('template');
      template.innerHTML = html;
      const memoryView = (eligibility, provider, worker, jobs = []) => ({ entry: 'BL01',
        route: { parameters: { photoId: 'photo-01' } }, response: {
          ok: true, status: 200, etag: null,
          unseenHeaders: { ...(provider ? { 'x-unseen-question-provider': provider } : {}),
            ...(worker ? { 'x-unseen-private-ai-worker': worker } : {}) },
          body: { photoId: 'photo-01', eligibility,
            provenance: { placementRevisionId: 'placement-01' },
            collectionNotice: { plainLanguageCopy: '只依据可见事实' }, recoverableQuestionJobs: jobs }
        } });
      const state = (eligibility, provider, worker, jobs) => {
        const candidate = document.createElement('template');
        candidate.innerHTML = renderIntegratedBookLabPage(memoryView(eligibility, provider, worker, jobs), catalog);
        return {
          copy: candidate.content.querySelector('.integrated-warning')?.textContent.trim() ?? null,
          role: candidate.content.querySelector('.integrated-warning')?.getAttribute('role') ?? null,
          question: candidate.content.querySelector('.question-sheet h2')?.textContent.trim() ?? null,
          startDisabled: candidate.content.querySelector('[data-book-action="MEMORY.START_QUESTION"]')?.disabled,
          skipDisabled: candidate.content.querySelector('[data-book-action="MEMORY.SKIP"]')?.disabled
        };
      };
      return {
        imageCount: template.content.querySelectorAll('img').length,
        eventAttributeCount: template.content.querySelectorAll('[onerror]').length,
        nativeButtons: [...template.content.querySelectorAll('[data-book-action]')].every((node) => node.tagName === 'BUTTON' && node.type === 'button'),
        textareaText: template.content.querySelector('textarea')?.textContent,
        actionCount: template.content.querySelectorAll('[data-book-action]').length,
        unavailable: state('disabled', 'unavailable'),
        notReady: state('not_ready', 'configured', 'online'),
        configured: state('eligible', 'configured', 'online'),
        missingCapability: state('eligible', 'configured'),
        workerDisabled: state('eligible', 'configured', 'disabled'),
        invalidHeartbeatWithOldError: state('eligible', 'configured', 'unknown', [{ status: 'queued', question: null,
          recovery: { nextPollAfterMs: 1000, lastStableError: 'model_unavailable' } }]),
        noneligibleOffline: state('not_ready', 'configured', 'offline'),
        queuedOnline: state('eligible', 'configured', 'online', [{ status: 'queued', question: null,
          recovery: { nextPollAfterMs: 250, lastStableError: null } }]),
        queuedOffline: state('eligible', 'configured', 'offline', [{ status: 'queued', question: null,
          recovery: { nextPollAfterMs: 1000, lastStableError: 'model_unavailable' } }]),
        offlineAdmission: state('eligible', 'configured', 'offline'),
        readyOnline: state('eligible', 'configured', 'online', [{ status: 'ready',
          question: '照片里的灯是什么时候点亮的？', recovery: { nextPollAfterMs: null, lastStableError: null } }])
      };
    })()`,
    awaitPromise: true,
    returnByValue: true
  });
  const integratedShell = shellAuditResult.result.value;
  if (integratedShell.imageCount || integratedShell.eventAttributeCount || !integratedShell.nativeButtons ||
      integratedShell.textareaText !== '<img src=x onerror="globalThis.pwned=1">' || integratedShell.actionCount !== 4 ||
      integratedShell.unavailable.copy !== "AI 暂时离线，照片已保存，稍后再问" ||
      integratedShell.unavailable.role !== "status" || !integratedShell.unavailable.startDisabled ||
      integratedShell.unavailable.skipDisabled || integratedShell.notReady.copy !==
        "暂时不能为这张照片生成问题；你仍可以跳过，照片不会受影响" ||
      !integratedShell.notReady.startDisabled || integratedShell.notReady.skipDisabled ||
      integratedShell.configured.copy !== null || integratedShell.configured.startDisabled ||
      integratedShell.configured.skipDisabled || !integratedShell.missingCapability.startDisabled ||
      integratedShell.missingCapability.copy !== "暂时不能为这张照片生成问题；你仍可以跳过，照片不会受影响" ||
      !integratedShell.workerDisabled.startDisabled || integratedShell.workerDisabled.copy !==
        "暂时不能为这张照片生成问题；你仍可以跳过，照片不会受影响" ||
      integratedShell.invalidHeartbeatWithOldError.copy !==
        "暂时不能为这张照片生成问题；你仍可以跳过，照片不会受影响" ||
      integratedShell.invalidHeartbeatWithOldError.copy.includes("AI 暂时离线") ||
      integratedShell.noneligibleOffline.copy !==
        "暂时不能为这张照片生成问题；你仍可以跳过，照片不会受影响" ||
      integratedShell.queuedOnline.copy !== "AI 正在准备问题，照片已保存；稍后会自动出现。" ||
      !integratedShell.queuedOnline.startDisabled || integratedShell.queuedOnline.skipDisabled ||
      integratedShell.queuedOffline.copy !== "AI 暂时离线，照片已保存，稍后再问" ||
      !integratedShell.queuedOffline.startDisabled || integratedShell.queuedOffline.skipDisabled ||
      integratedShell.offlineAdmission.startDisabled || integratedShell.offlineAdmission.copy !==
        "AI 暂时离线，照片已保存，稍后再问" ||
      integratedShell.readyOnline.question !== "照片里的灯是什么时候点亮的？" ||
      integratedShell.readyOnline.copy !== null) {
    throw new Error(`integrated_shell_browser_escape:${JSON.stringify(integratedShell)}`);
  }

  await mkdir(offlineEvidenceRoot, { recursive: true });
  const offlineBrowser = [];
  for (const viewport of [{ width: 1440, height: 900, name: "desktop-1440" },
    { width: 390, height: 844, name: "mobile-390" }]) {
    await client.send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height,
      deviceScaleFactor: 1, mobile: viewport.width < 700 });
    const rendered = await client.send("Runtime.evaluate", {
      expression: `(async () => {
        const [{ renderIntegratedBookLabPage }, catalog] = await Promise.all([
          import('/packages/book-lab-web/src/integrated-shell.mjs'),
          fetch('/__catalog').then((response) => response.json())
        ]);
        const view = { entry: 'BL01', route: { parameters: { photoId: 'photo-01' } }, response: {
          ok: true, status: 200, etag: null,
          unseenHeaders: { 'x-unseen-question-provider': 'unavailable' },
          body: { photoId: 'photo-01', eligibility: 'disabled',
            provenance: { placementRevisionId: 'placement-01' },
            collectionNotice: { plainLanguageCopy: '你的照片已经安全保存；问题功能恢复后可以再回来。' },
            recoverableQuestionJobs: [] }
        } };
        document.body.dataset.entry = 'BL01';
        document.querySelector('main').innerHTML = renderIntegratedBookLabPage(view, catalog);
        const start = document.querySelector('[data-book-action="MEMORY.START_QUESTION"]');
        const skip = document.querySelector('[data-book-action="MEMORY.SKIP"]');
        const open = document.querySelector('[data-book-action="MEMORY.OPEN"]');
        open.focus();
        const bounds = (element) => { const rect = element.getBoundingClientRect(); return {
          left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
          inViewport: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0
        }; };
        return { copy: document.querySelector('.integrated-warning')?.textContent.trim(),
          startDisabled: start.disabled, skipDisabled: skip.disabled, focusBeforeTab: document.activeElement?.dataset.bookAction,
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
          warningBounds: bounds(document.querySelector('.integrated-warning')),
          startBounds: bounds(start), skipBounds: bounds(skip),
          fixtureBannerVisible: document.querySelector('.fixture-badge')?.getBoundingClientRect().width > 0,
          externalResources: performance.getEntriesByType('resource').map((entry) => entry.name)
            .filter((url) => new URL(url).origin !== location.origin) };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });
    if (rendered.exceptionDetails) throw new Error(`offline_render_exception:${JSON.stringify(rendered.exceptionDetails)}`);
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab" });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab" });
    const focus = await client.send("Runtime.evaluate", {
      expression: "document.activeElement?.dataset.bookAction ?? null", returnByValue: true });
    const statusObject = await client.send("Runtime.evaluate", {
      expression: "document.querySelector('.integrated-warning')" });
    const statusTree = await client.send("Accessibility.getPartialAXTree", {
      objectId: statusObject.result.objectId, fetchRelatives: true });
    const axTree = await client.send("Accessibility.getFullAXTree");
    const axNodes = axTree.nodes.filter((node) => !node.ignored);
    const statusNodes = statusTree.nodes.filter((node) => !node.ignored);
    const statusNode = statusNodes.find((node) => node.role?.value === "status");
    const byId = new Map(statusNodes.map((node) => [node.nodeId, node]));
    const descendantNames = (root) => {
      const names = [];
      const pending = [...(root?.childIds ?? [])];
      while (pending.length) {
        const node = byId.get(pending.shift());
        if (!node) continue;
        if (node.name?.value) names.push(node.name.value);
        pending.push(...(node.childIds ?? []));
      }
      return names;
    };
    const statusText = [statusNode?.name?.value, ...descendantNames(statusNode)].filter(Boolean).join(" ");
    const startNode = axNodes.find((node) => node.role?.value === "button" &&
      node.name?.value === "看看这张照片想问什么");
    const skipNode = axNodes.find((node) => node.role?.value === "button" && node.name?.value === "先跳过这张");
    const startAxDisabled = startNode?.properties?.some((property) =>
      property.name === "disabled" && property.value?.value === true) ?? false;
    const screenshotPath = resolve(offlineEvidenceRoot, `${viewport.name}.png`);
    const screenshot = await client.send("Page.captureScreenshot", {
      format: "png", fromSurface: true, captureBeyondViewport: false });
    await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
    const result = { ...viewport, ...rendered.result.value, focusAfterTab: focus.result.value,
      screenReader: { status: Boolean(statusNode) && statusText.includes("AI 暂时离线，照片已保存，稍后再问"),
        statusText, startDisabled: startAxDisabled, skip: Boolean(skipNode) },
      screenshot: `release-evidence/local-operable/bl01-provider-offline/${viewport.name}.png` };
    if (result.copy !== "AI 暂时离线，照片已保存，稍后再问" || !result.startDisabled ||
      result.skipDisabled || result.focusBeforeTab !== "MEMORY.OPEN" || result.focusAfterTab !== "MEMORY.SKIP" ||
      result.horizontalOverflow || !result.warningBounds.inViewport || !result.startBounds.inViewport ||
      !result.skipBounds.inViewport || !result.fixtureBannerVisible || result.externalResources.length ||
      !result.screenReader.status || !result.screenReader.startDisabled || !result.screenReader.skip) {
      throw new Error(`offline_browser_invalid:${JSON.stringify(result)}`);
    }
    offlineBrowser.push(result);
  }

  await mkdir(privateAiEvidenceRoot, { recursive: true });
  const privateAiBrowser = [];
  for (const state of [
    { name: "queued-online", worker: "online", error: null,
      copy: "AI 正在准备问题，照片已保存；稍后会自动出现。" },
    { name: "queued-offline", worker: "offline", error: "model_unavailable",
      copy: "AI 暂时离线，照片已保存，稍后再问" }
  ]) {
    for (const viewport of [{ width: 1440, height: 900, name: "desktop-1440" },
      { width: 390, height: 844, name: "mobile-390" }]) {
      await client.send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height,
        deviceScaleFactor: 1, mobile: viewport.width < 700 });
      const rendered = await client.send("Runtime.evaluate", {
        expression: `(async () => {
          const [{ renderIntegratedBookLabPage }, catalog] = await Promise.all([
            import('/packages/book-lab-web/src/integrated-shell.mjs'),
            fetch('/__catalog').then((response) => response.json())
          ]);
          const view = { entry: 'BL01', route: { parameters: { photoId: 'photo-01' } }, response: {
            ok: true, status: 200, etag: null,
            unseenHeaders: { 'x-unseen-question-provider': 'configured',
              'x-unseen-private-ai-worker': ${JSON.stringify(state.worker)} },
            body: { photoId: 'photo-01', eligibility: 'eligible',
              provenance: { placementRevisionId: 'placement-01' },
              collectionNotice: { plainLanguageCopy: '照片已安全保存，问题完成后会在这里出现。' },
              recoverableQuestionJobs: [{ status: 'queued', question: null,
                recovery: { nextPollAfterMs: 1000, lastStableError: ${JSON.stringify(state.error)} } }] }
          } };
          document.body.dataset.entry = 'BL01';
          document.querySelector('main').innerHTML = renderIntegratedBookLabPage(view, catalog);
          const warning = document.querySelector('.integrated-warning');
          const start = document.querySelector('[data-book-action="MEMORY.START_QUESTION"]');
          const skip = document.querySelector('[data-book-action="MEMORY.SKIP"]');
          document.querySelector('[data-book-action="MEMORY.OPEN"]').focus();
          const bounds = (element) => { const rect = element.getBoundingClientRect(); return {
            left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
            inViewport: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0
          }; };
          return { copy: warning?.textContent.trim(), startDisabled: start.disabled,
            skipDisabled: skip.disabled, horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
            warningBounds: bounds(warning), startBounds: bounds(start), skipBounds: bounds(skip),
            reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
            externalResources: performance.getEntriesByType('resource').map((entry) => entry.name)
              .filter((url) => new URL(url).origin !== location.origin) };
        })()`,
        awaitPromise: true,
        returnByValue: true
      });
      if (rendered.exceptionDetails) throw new Error(`private_ai_render_exception:${JSON.stringify(rendered.exceptionDetails)}`);
      await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab" });
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab" });
      const focus = await client.send("Runtime.evaluate", {
        expression: "document.activeElement?.dataset.bookAction ?? null", returnByValue: true });
      const statusObject = await client.send("Runtime.evaluate", {
        expression: "document.querySelector('.integrated-warning')" });
      const statusTree = await client.send("Accessibility.getPartialAXTree", {
        objectId: statusObject.result.objectId, fetchRelatives: true });
      const statusNodes = statusTree.nodes.filter((node) => !node.ignored);
      const statusNode = statusNodes.find((node) => node.role?.value === "status");
      const byId = new Map(statusNodes.map((node) => [node.nodeId, node]));
      const pending = [...(statusNode?.childIds ?? [])];
      const names = [statusNode?.name?.value].filter(Boolean);
      while (pending.length) {
        const node = byId.get(pending.shift());
        if (!node) continue;
        if (node.name?.value) names.push(node.name.value);
        pending.push(...(node.childIds ?? []));
      }
      const axTree = await client.send("Accessibility.getFullAXTree");
      const axNodes = axTree.nodes.filter((node) => !node.ignored);
      const startNode = axNodes.find((node) => node.role?.value === "button" &&
        node.name?.value === "看看这张照片想问什么");
      const skipNode = axNodes.find((node) => node.role?.value === "button" && node.name?.value === "先跳过这张");
      const startAxDisabled = startNode?.properties?.some((property) =>
        property.name === "disabled" && property.value?.value === true) ?? false;
      const screenshotName = `${state.name}-${viewport.name}.png`;
      const screenshot = await client.send("Page.captureScreenshot", {
        format: "png", fromSurface: true, captureBeyondViewport: false });
      await writeFile(resolve(privateAiEvidenceRoot, screenshotName), Buffer.from(screenshot.data, "base64"));
      const result = { state: state.name, ...viewport, ...rendered.result.value,
        focusAfterTab: focus.result.value,
        screenReader: { status: Boolean(statusNode) && names.join(" ").includes(state.copy),
          statusText: names.join(" "), startDisabled: startAxDisabled, skip: Boolean(skipNode) },
        screenshot: `release-evidence/local-operable/private-ai-queued-offline/${screenshotName}` };
      if (result.copy !== state.copy || !result.startDisabled || result.skipDisabled ||
        result.focusAfterTab !== "MEMORY.SKIP" || result.horizontalOverflow || !result.warningBounds.inViewport ||
        !result.startBounds.inViewport || !result.skipBounds.inViewport || !result.reducedMotion ||
        result.externalResources.length || !result.screenReader.status || !result.screenReader.startDisabled ||
        !result.screenReader.skip) {
        throw new Error(`private_ai_browser_invalid:${JSON.stringify(result)}`);
      }
      privateAiBrowser.push(result);
    }
  }

  const privateAiPollingAuditResult = await client.send("Runtime.evaluate", {
    expression: `(async () => {
      const [{ BookLabIntegratedVisualShell }, catalog] = await Promise.all([
        import('/packages/book-lab-web/src/integrated-shell.mjs'),
        fetch('/__catalog').then((response) => response.json())
      ]);
      const makeView = (status, delay, question = null) => ({ entry: 'BL01',
        route: { entry: 'BL01', pathname: '/labs/memories/photos/photo-01', parameters: { photoId: 'photo-01' } },
        response: { ok: true, status: 200, etag: null,
          unseenHeaders: { 'x-unseen-question-provider': 'configured', 'x-unseen-private-ai-worker': 'online' },
          body: { photoId: 'photo-01', eligibility: 'eligible', provenance: { placementRevisionId: 'placement-01' },
            collectionNotice: { plainLanguageCopy: '照片已安全保存。' }, recoverableQuestionJobs: [{ status, question,
              recovery: { nextPollAfterMs: delay, lastStableError: null } }] } } });
      let current = makeView('queued', 250);
      const scheduled = [];
      const cleared = [];
      const root = document.createElement('div');
      document.body.append(root);
      const shell = new BookLabIntegratedVisualShell({ catalog,
        controller: { async readRoute() { return current; }, async rereadRoute() { return current; } },
        setTimeoutImpl(callback, delay) { const handle = { callback, delay }; scheduled.push(handle); return handle; },
        clearTimeoutImpl(handle) { cleared.push(handle); } });
      await shell.mount(root, '/labs/memories/photos/photo-01');
      const firstDelay = scheduled[0]?.delay;
      current = makeView('ready', null, '照片里的灯是什么时候点亮的？');
      await scheduled[0].callback();
      const result = { firstDelay, scheduledCount: scheduled.length,
        question: root.querySelector('.question-sheet h2')?.textContent.trim(),
        startDisabled: root.querySelector('[data-book-action="MEMORY.START_QUESTION"]')?.disabled,
        clearedCountBeforeDestroy: cleared.length };
      shell.destroy();
      result.clearedCountAfterDestroy = cleared.length;
      root.remove();
      return result;
    })()`,
    awaitPromise: true,
    returnByValue: true
  });
  const privateAiPolling = privateAiPollingAuditResult.result.value ?? null;
  if (privateAiPollingAuditResult.exceptionDetails || privateAiPolling?.firstDelay !== 1_000 ||
      privateAiPolling?.scheduledCount !== 1 || privateAiPolling?.question !== "照片里的灯是什么时候点亮的？") {
    throw new Error(`private_ai_polling_invalid:${JSON.stringify(privateAiPolling)}`);
  }

  const bookCreateAuditResult = await client.send("Runtime.evaluate", {
    expression: `(async () => {
      const [{ BookLabIntegratedVisualShell, buildIntegratedActionRequest }, { ACTION_REQUESTS }] = await Promise.all([
        import('/packages/book-lab-web/src/integrated-shell.mjs'),
        import('/packages/book-lab-web/src/integrated-transport.mjs')
      ]);
      const catalog = { actions: Object.fromEntries(Object.keys(ACTION_REQUESTS).map((id) => [id, { initial: id }])) };
      const makeView = ({ routeSpaceId = 'space-01', bodySpaceId = 'space-01', bookSpaceId = 'space-01' } = {}) => ({
        entry: 'BL04', route: { entry: 'BL04', pathname: '/manage/space-01/book-lab',
          parameters: routeSpaceId === null ? {} : { spaceId: routeSpaceId } },
        response: { ok: true, status: 200, etag: '"lab-1"', unseenHeaders: {}, body: {
          spaceId: bodySpaceId,
          books: [{ bookId: 'book-01', spaceId: bookSpaceId, title: '共光以后', status: 'editing', pages: [] }]
        } }
      });
      const setCreateFields = (root) => {
        root.querySelector('[data-book-field="newBookId"]').value = 'book-new';
        root.querySelector('[data-book-field="title"]').value = '我们的故事';
        for (const [name, value] of [['eventId', 'attacker-event'], ['spaceId', 'attacker-space']]) {
          const input = document.createElement('input');
          input.type = 'hidden';
          input.dataset.bookField = name;
          input.value = value;
          root.append(input);
        }
      };
      const waitIdle = async (root) => {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          if (!root.hasAttribute('aria-busy')) return;
          await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        }
        throw new Error('book_create_click_timeout');
      };

      const valid = makeView();
      const calls = [];
      const root = document.createElement('div');
      document.body.append(root);
      const shell = new BookLabIntegratedVisualShell({ catalog, randomId: () => 'create-browser-key', controller: {
        async readRoute() { return valid; },
        async readAction() { throw new Error('unexpected_read'); },
        async mutate(actionId, request) { calls.push({ actionId, request });
          return { ok: true, status: 200, etag: '"created"', unseenHeaders: {}, body: {} }; },
        async rereadRoute() { return valid; }
      } });
      await shell.mount(root, valid.route.pathname);
      const label = root.querySelector('.material-summary .microcopy')?.textContent.trim();
      const nativeEventField = Boolean(root.querySelector('[data-book-field="eventId"]'));
      setCreateFields(root);
      const trigger = root.querySelector('[data-book-action="BOOK.CREATE"]');
      trigger.click();
      await waitIdle(root);
      const staleConnected = trigger.isConnected;
      trigger.click();
      await new Promise((resolveWait) => setTimeout(resolveWait, 0));
      const staleMutationCount = calls.length;
      shell.destroy();
      root.remove();

      const invalid = [];
      for (const [name, candidate] of [
        ['missing_route', makeView({ routeSpaceId: null })],
        ['wrong_route_entry', { ...makeView(), route: { ...makeView().route, entry: 'BL05' } }],
        ['wrong_body_space', makeView({ bodySpaceId: 'space-02' })],
        ['wrong_book_space', makeView({ bookSpaceId: 'space-02' })]
      ]) {
        let directError = null;
        try { buildIntegratedActionRequest('BOOK.CREATE', candidate,
          { newBookId: 'book-new', title: '我们的故事', eventId: 'attacker-event' }, () => 'unused'); }
        catch (error) { directError = error.code ?? error.name; }
        let fetchCalls = 0;
        const invalidRoot = document.createElement('div');
        document.body.append(invalidRoot);
        const invalidShell = new BookLabIntegratedVisualShell({ catalog, randomId: () => 'unused', controller: {
          async readRoute() { return candidate; },
          async readAction() { throw new Error('unexpected_read'); },
          async mutate() { fetchCalls += 1; throw new Error('mutation_must_not_run'); },
          async rereadRoute() { throw new Error('reread_must_not_run'); }
        } });
        await invalidShell.mount(invalidRoot, candidate.route.pathname);
        setCreateFields(invalidRoot);
        invalidRoot.querySelector('[data-book-action="BOOK.CREATE"]').click();
        await waitIdle(invalidRoot);
        invalid.push({ name, directError, fetchCalls, clickError: invalidShell.view.response.body?.error?.code });
        invalidShell.destroy();
        invalidRoot.remove();
      }
      return { label, nativeEventField, calls, staleConnected, staleMutationCount, invalid };
    })()`,
    awaitPromise: true,
    returnByValue: true
  });
  if (bookCreateAuditResult.exceptionDetails) {
    throw new Error(`integrated_book_create_runtime_exception:${JSON.stringify(bookCreateAuditResult.exceptionDetails)}`);
  }
  const integratedBookCreate = bookCreateAuditResult.result.value;
  const expectedBookCreateCall = [{ actionId: "BOOK.CREATE", request: {
    parameters: { spaceId: "space-01", bookId: "book-new" }, idempotencyKey: "create-browser-key",
    dto: { bookId: "book-new", title: "我们的故事", eventId: "space-01" }, ifNoneMatch: "*"
  } }];
  if (integratedBookCreate.label !== "事件：当前记忆空间" || integratedBookCreate.nativeEventField ||
      JSON.stringify(integratedBookCreate.calls) !== JSON.stringify(expectedBookCreateCall) ||
      integratedBookCreate.staleConnected || integratedBookCreate.staleMutationCount !== 1 ||
      integratedBookCreate.invalid.some((item) => item.directError !== "integrated_input_unavailable" ||
        item.fetchCalls !== 0 || item.clickError !== "integrated_input_unavailable")) {
    throw new Error(`integrated_book_create_escape:${JSON.stringify(integratedBookCreate)}`);
  }

  const startNewVersionAuditResult = await client.send("Runtime.evaluate", {
    expression: `(async () => {
      const [{ BookLabIntegratedVisualShell, buildIntegratedActionRequest }, { ACTION_REQUESTS }] = await Promise.all([
        import('/packages/book-lab-web/src/integrated-shell.mjs'),
        import('/packages/book-lab-web/src/integrated-transport.mjs')
      ]);
      const catalog = { actions: Object.fromEntries(Object.keys(ACTION_REQUESTS).map((id) => [id, { initial: id }])) };
      const baseRoute = { entry: 'BL05', pathname: '/manage/space-01/book-lab/book-01/draft',
        parameters: { spaceId: 'space-01', bookId: 'book-01' } };
      const makeView = (accessControlStatus, { route = baseRoute, bodyBookId = 'book-01', headerName = 'x-unseen-book-owner-preconditions',
        accessControlVersion = 2, fromVersionId = \`version-\${accessControlStatus}\` } = {}) => ({
        entry: 'BL05', route, response: { ok: true, status: 200, etag: \`"\${accessControlStatus}-etag"\`,
          unseenHeaders: { [headerName]: JSON.stringify({ startNewVersion: {
            ...(fromVersionId === null ? {} : { fromVersionId }),
            ...(accessControlVersion === null ? {} : { accessControlVersion }),
            ...(accessControlStatus === undefined ? {} : { accessControlStatus })
          } }) }, body: { bookId: bodyBookId, spaceId: 'space-01', title: '共光以后', status: 'frozen',
            draftVersionId: 'draft-01', pages: [] } }
      });
      const views = Object.fromEntries(['active', 'affected', 'revoked'].map((status) => [status, makeView(status)]));
      const calls = [];
      const rereads = [];
      const rereadStatuses = ['revoked', 'active', 'active'];
      const controller = {
        async readRoute() { return views.affected; },
        async readAction() { throw new Error('unexpected_read'); },
        async mutate(actionId, request) { calls.push({ actionId, request });
          return { ok: true, status: 200, etag: '"mutation"', unseenHeaders: {}, body: {} }; },
        async rereadRoute() { const status = rereadStatuses[rereads.length]; rereads.push(status); return views[status]; }
      };
      let id = 0;
      const root = document.createElement('div');
      document.body.append(root);
      const shell = new BookLabIntegratedVisualShell({ controller, catalog, randomId: () => \`browser-\${++id}\` });
      await shell.mount(root, baseRoute.pathname);
      const state = () => {
        const button = root.querySelector('[data-book-action="BOOK.START_NEW_VERSION"]');
        const header = JSON.parse(shell.view.response.unseenHeaders['x-unseen-book-owner-preconditions']);
        return { status: header.startNewVersion.accessControlStatus, enabled: !button.disabled, button };
      };
      const waitForMutation = async (count) => {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          if (calls.length === count && !root.hasAttribute('aria-busy')) return;
          await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        }
        throw new Error(\`start_new_version_click_timeout:\${count}\`);
      };
      const transitions = [];
      const affected = state();
      const staleAffectedButton = affected.button;
      transitions.push({ status: affected.status, enabled: affected.enabled });
      staleAffectedButton.click();
      await waitForMutation(1);
      const revoked = state();
      transitions.push({ status: revoked.status, enabled: revoked.enabled });
      staleAffectedButton.click();
      await new Promise((resolveWait) => setTimeout(resolveWait, 0));
      const staleNode = { connected: staleAffectedButton.isConnected, mutationCount: calls.length };
      revoked.button.click();
      await waitForMutation(2);
      const active = state();
      transitions.push({ status: active.status, enabled: active.enabled });
      active.button.click();
      await waitForMutation(3);
      shell.destroy();
      root.remove();

      const invalidViews = [
        ['other_status', makeView('Affected')],
        ['missing_status', makeView(undefined)],
        ['missing_version', makeView('active', { accessControlVersion: null })],
        ['string_version', makeView('active', { accessControlVersion: '2' })],
        ['zero_version', makeView('active', { accessControlVersion: 0 })],
        ['nan_version', makeView('active', { accessControlVersion: Number.NaN })],
        ['missing_source', makeView('active', { fromVersionId: null })],
        ['wrong_header', makeView('active', { headerName: 'X-Unseen-Book-Owner-Preconditions' })],
        ['wrong_body_book', makeView('active', { bodyBookId: 'book-02' })],
        ['wrong_route_book', makeView('active', { route: { ...baseRoute,
          parameters: { spaceId: 'space-01', bookId: 'book-02' } } })]
      ];
      const invalid = [];
      for (const [name, candidate] of invalidViews) {
        let directError = null;
        try { buildIntegratedActionRequest('BOOK.START_NEW_VERSION', candidate, {}, () => 'unused'); }
        catch (error) { directError = error.code ?? error.name; }
        let fetchCalls = 0;
        const invalidRoot = document.createElement('div');
        document.body.append(invalidRoot);
        const invalidShell = new BookLabIntegratedVisualShell({ catalog, randomId: () => 'unused', controller: {
          async readRoute() { return candidate; },
          async readAction() { throw new Error('unexpected_read'); },
          async mutate() { fetchCalls += 1; throw new Error('mutation_must_not_run'); },
          async rereadRoute() { throw new Error('reread_must_not_run'); }
        } });
        await invalidShell.mount(invalidRoot, candidate.route.pathname);
        const trigger = invalidRoot.querySelector('[data-book-action="BOOK.START_NEW_VERSION"]');
        const disabled = trigger.disabled;
        await invalidShell.handleClick({ target: { closest: (selector) => selector === '[data-book-action]' ? trigger : null } });
        invalid.push({ name, directError, disabled, fetchCalls,
          fakeClickError: invalidShell.view.response.body?.error?.code });
        invalidShell.destroy();
        invalidRoot.remove();
      }
      return { transitions, rereads, calls, staleNode, invalid };
    })()`,
    awaitPromise: true,
    returnByValue: true
  });
  const integratedStartNewVersion = startNewVersionAuditResult.result.value;
  const expectedStatuses = ["affected", "revoked", "active"];
  const expectedCalls = expectedStatuses.map((status, index) => ({ actionId: "BOOK.START_NEW_VERSION", request: {
    parameters: { spaceId: "space-01", bookId: "book-01" }, idempotencyKey: `browser-${index * 2 + 1}`,
    dto: { draftVersionId: `browser-${index * 2 + 2}`, fromVersionId: `version-${status}`, excludeWithdrawn: true },
    etag: `"${status}-etag"`, ifNoneMatch: "*"
  } }));
  if (JSON.stringify(integratedStartNewVersion.transitions) !== JSON.stringify(expectedStatuses.map((status) => ({ status, enabled: true }))) ||
      JSON.stringify(integratedStartNewVersion.rereads) !== JSON.stringify(["revoked", "active", "active"]) ||
      JSON.stringify(integratedStartNewVersion.calls) !== JSON.stringify(expectedCalls) ||
      integratedStartNewVersion.staleNode.connected || integratedStartNewVersion.staleNode.mutationCount !== 1 ||
      integratedStartNewVersion.invalid.some((item) => !item.disabled || item.directError !== "integrated_input_unavailable" ||
        item.fetchCalls !== 0 || item.fakeClickError !== "integrated_input_unavailable")) {
    throw new Error(`integrated_start_new_version_escape:${JSON.stringify(integratedStartNewVersion)}`);
  }

  const editedTitle = "灯熄以后，我们还在";
  let loaded = client.once("Page.loadEventFired");
  await client.send("Page.navigate", { url: `${origin}${concreteRoute("BL05", fixtureBundle)}` });
  await loaded;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ready = await client.send("Runtime.evaluate", { expression: "document.body.dataset.entry === 'BL05' && Boolean(document.querySelector('[data-title]'))", returnByValue: true });
    if (ready.result.value) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  await client.send("Runtime.evaluate", { expression: `(() => {
    const input = document.querySelector('[data-title]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(editedTitle)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-action="BOOK.EDIT_TITLE"]').click();
    document.querySelector('[data-page-index="1"]').click();
    window.confirm = () => true;
    document.querySelector('[data-action="BOOK.REMOVE_PAGE"]').click();
    document.querySelector('[data-action="BOOK.GENERATE_PREVIEW"]').click();
  })()` });
  for (let attempt = 0; attempt < 480; attempt += 1) {
    const ready = await client.send("Runtime.evaluate", { expression: "Boolean(document.querySelector('[data-action=\"BOOK.FREEZE\"]'))", returnByValue: true });
    if (ready.result.value) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  const previewState = await client.send("Runtime.evaluate", { expression: "({ freezeReady: Boolean(document.querySelector('[data-action=\"BOOK.FREEZE\"]')), status: document.querySelector('#status')?.textContent, primaryAction: document.querySelector('.primary-dock [data-action]')?.dataset.action })", returnByValue: true });
  if (!previewState.result.value.freezeReady) throw new Error(`edited_preview_not_ready:${JSON.stringify(previewState.result.value)}`);
  const freezeClick = await client.send("Runtime.evaluate", { expression: `(() => {
    const button = document.querySelector('[data-action="BOOK.FREEZE"]');
    button.click();
    return { clicked: true, disabled: button.disabled, status: document.querySelector('#status')?.textContent };
  })()`, returnByValue: true, userGesture: true });
  if (freezeClick.exceptionDetails || !freezeClick.result.value.clicked) throw new Error(`edited_freeze_click_failed:${JSON.stringify(freezeClick.exceptionDetails ?? freezeClick.result.value)}`);
  for (let attempt = 0; attempt < 480; attempt += 1) {
    const ready = await client.send("Runtime.evaluate", { expression: "({ done: document.body.dataset.entry === 'BL06', failed: document.querySelector('#status')?.textContent.includes('失败') })", returnByValue: true });
    if (ready.result.value.failed) throw new Error("edited_freeze_request_failed");
    if (ready.result.value.done) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  const frozenUi = await client.send("Runtime.evaluate", { expression: `(() => ({
    entry: document.body.dataset.entry,
    title: document.querySelector('main h1')?.textContent.trim(),
    pageCounter: document.querySelector('.reader-nav span')?.textContent.trim(),
    status: document.querySelector('#status')?.textContent,
    htmlUrl: document.querySelector('a[href*="book.html"]')?.getAttribute('href'),
    receiptUrl: document.querySelector('a[href*="render-receipt.json"]')?.getAttribute('href')
  }))()`, returnByValue: true });
  const editedFreeze = frozenUi.result.value;
  if (editedFreeze.entry !== "BL06" || editedFreeze.title !== editedTitle || editedFreeze.pageCounter !== "1 / 15") throw new Error(`edited_freeze_ui_mismatch:${JSON.stringify(editedFreeze)}`);
  const frozenReceipt = await (await fetch(`${origin}${editedFreeze.receiptUrl}`)).json();
  const frozenHtml = await (await fetch(`${origin}${editedFreeze.htmlUrl}`)).text();
  const frozenPdf = Buffer.from(await (await fetch(`${origin}${editedFreeze.htmlUrl.replace("book.html", "book.pdf")}`)).arrayBuffer());
  if (frozenReceipt.equality.title !== editedTitle || frozenReceipt.equality.pageCount !== 15) throw new Error("edited_freeze_receipt_mismatch");
  if (!editedFreeze.receiptUrl.includes(frozenReceipt.equality.manifestHash)) throw new Error("edited_freeze_manifest_url_mismatch");
  if (!frozenHtml.includes(`<h1>${editedTitle}</h1>`) || frozenHtml.includes("<h1>共光以后</h1>")) throw new Error("edited_freeze_html_title_mismatch");
  if (frozenPdf.subarray(0, 5).toString() !== "%PDF-") throw new Error("edited_freeze_pdf_invalid");
  editedFreeze.manifestHash = frozenReceipt.equality.manifestHash;
  editedFreeze.pdfBytes = frozenPdf.length;
  const browserDiagnosticCounts = Object.fromEntries(Object.entries(browserDiagnostics)
    .map(([name, entries]) => [name, entries.length]));
  if (Object.values(browserDiagnosticCounts).some(Boolean)) {
    throw new Error(`browser_diagnostics_invalid:${JSON.stringify(browserDiagnosticCounts)}`);
  }
  client.close();
  const report = {
    schemaVersion: "unseen-book-ui-browser-audit/1",
    fixtureOnly: true,
    status: "PASS",
    caveat: "The 200% checks use the 624 CSS-pixel reflow equivalent of a 1248-pixel viewport; no Core or real API is present.",
    cases: results,
    integratedPolicy,
    integratedShell,
    offlineBrowser,
    privateAiBrowser,
    privateAiPolling,
    browserDiagnosticCounts,
    integratedBookCreate,
    integratedStartNewVersion,
    editedFreeze
  };
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(resolve(evidenceRoot, "browser-audit.json"), `${JSON.stringify(report, null, 2)}\n`);
  const providerEvidenceState = ({ copy, role, startDisabled, skipDisabled }) =>
    ({ copy, role, startDisabled, skipDisabled });
  await writeFile(resolve(offlineEvidenceRoot, "verification.json"), `${JSON.stringify({
    schemaVersion: "unseen-bl01-provider-offline-browser/1",
    base: "c76ee298e7a9566506252e291e3dfe050c4a3a9f",
    status: "PASS",
    productFixtureAdded: false,
    productionInput: false,
    capabilitySource: "x-unseen-question-provider",
    exactOfflineCopy: "AI 暂时离线，照片已保存，稍后再问",
    states: { unavailable: providerEvidenceState(integratedShell.unavailable),
      notReady: providerEvidenceState(integratedShell.notReady),
      configured: providerEvidenceState(integratedShell.configured),
      missingCapability: providerEvidenceState(integratedShell.missingCapability) },
    browserDiagnosticCounts,
    cases: offlineBrowser
  }, null, 2)}\n`);
  await writeFile(resolve(privateAiEvidenceRoot, "verification.json"), `${JSON.stringify({
    schemaVersion: "unseen-private-ai-queued-offline-browser/1",
    base: "95d1151e7be72d5a487384b0fb915c5d90fbfde3",
    status: "PASS",
    productFixtureAdded: false,
    productionInput: false,
    providerCapabilitySource: "x-unseen-question-provider",
    workerCapabilitySource: "x-unseen-private-ai-worker",
    exactCopies: {
      queued: "AI 正在准备问题，照片已保存；稍后会自动出现。",
      offline: "AI 暂时离线，照片已保存，稍后再问"
    },
    states: {
      queuedOnline: integratedShell.queuedOnline,
      queuedOffline: integratedShell.queuedOffline,
      offlineAdmission: integratedShell.offlineAdmission,
      disabled: integratedShell.workerDisabled,
      missingCapability: integratedShell.missingCapability,
      readyOnline: integratedShell.readyOnline
    },
    pollBoundsMs: { minimum: 1_000, maximum: 30_000 },
    polling: privateAiPolling,
    browserDiagnosticCounts,
    cases: privateAiBrowser
  }, null, 2)}\n`);
  console.log(JSON.stringify({ status: "BOOK_UI_BROWSER_AUDIT_OK", cases: results.length, report: resolve(evidenceRoot, "browser-audit.json") }, null, 2));
} finally {
  server.kill("SIGTERM");
  browser.kill("SIGTERM");
  await Promise.all([
    Promise.race([once(server, "exit"), new Promise((resolveWait) => setTimeout(resolveWait, 1_000))]),
    Promise.race([once(browser, "exit"), new Promise((resolveWait) => setTimeout(resolveWait, 1_000))])
  ]);
}
