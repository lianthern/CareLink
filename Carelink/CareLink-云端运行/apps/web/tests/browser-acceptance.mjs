import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STAGE_TIMEOUT = 15_000;
const GLOBAL_TIMEOUT = 170_000;

class Cdp {
  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.socket = new WebSocket(url);
    this.ready = timed(new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = reject;
    }), "CDP connection");
    this.socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
      } else for (const listener of this.listeners.get(message.method) || []) listener(message.params);
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, STAGE_TIMEOUT);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, listener) {
    this.listeners.set(method, [...(this.listeners.get(method) || []), listener]);
  }
  once(method) {
    return new Promise((resolve) => {
      const listener = (params) => {
        this.listeners.set(method, (this.listeners.get(method) || []).filter((item) => item !== listener));
        resolve(params);
      };
      this.on(method, listener);
    });
  }
  close() { this.socket.close(); }
}

const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const evidenceRoot = resolve(appRoot, "evidence");
const screenshots = resolve(evidenceRoot, "screenshots");
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const viewerRepo = resolve(appRoot, "../../../4-viewer");
const viewerCommit = "5e068e3d04263adc2f480ac9db5a3bc1f18157d7";
const viewerExport = await mkdtemp(join(tmpdir(), "unseen-track2-viewer-"));
const viewerRoot = resolve(viewerExport, "packages/viewer");
const appPort = 4482;
const baseUrl = `http://127.0.0.1:${appPort}`;
const profile = await mkdtemp(join(tmpdir(), "unseen-track2-chrome-"));
await mkdir(screenshots, { recursive: true });

let server;
let chrome;
let cdp;
const networkUrls = new Map();
const report = {
  generatedAt: new Date().toISOString(),
  mode: { apiAdapter: "HttpApiAdapter", viewerAdapter: "ProductionViewerAdapter", fixture: false, debugChrome: false, apiHarness: "deterministic local canonical HTTP", localLocatorDisclosure: "确定性本地定位样本 / 非真实定位质量", viewerPublicEntry: "packages/viewer/src/public/index.js", viewerCommit, productionWebglPolicy: "not overridden; host does not force fallback", evidenceBoundary: "Track 2 verifies the clean real Track 4 public entry, effective scene-context/session-auth media/identity wiring, honest render fallback and retry/return seams. Deterministic local locator outputs are visibly disclosed and do not claim real locator quality. This run does not claim a complete visible-browser 360/yaw interaction certification; Track 4 clean evidence and Track 5 on a GPU-capable visible browser own that gate." },
  consoleErrors: [], exceptions: [], httpErrors: [], expectedHttpErrors: [], unexpectedExternalRequests: [], failedRequests: [],
  geometry: [], primaryCtas: [], routeReads: [], screenshots: [], steps: [], legalRoutes: [],
  accessibility: { keyboard: [], undersizedTargets: [], unnamedControls: [], imagesMissingAlt: [], zoom200: null, reducedMotion: null, liveRegions: null, axUnnamed: [] },
  cleanup: { profile, chromeProcessGroup: null, serverProcessGroup: null, orphanCount: null }
};

try {
  await timed(run(), "global browser acceptance", GLOBAL_TIMEOUT);
} catch (error) {
  report.failure = error.stack || String(error);
  throw error;
} finally {
  cdp?.close();
  await terminateGroup(chrome);
  await terminateGroup(server);
  const orphans = ownProfileProcesses(profile);
  for (const pid of orphans) { try { process.kill(pid, "SIGTERM"); } catch {} }
  await new Promise((resolve) => setTimeout(resolve, 200));
  report.cleanup.orphanCount = ownProfileProcesses(profile).length;
  await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  await rm(viewerExport, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  report.cleanup.profileRemoved = true;
  report.cleanup.viewerExportRemoved = true;
  if (report.summary) report.summary.cleanupOrphanCount = report.cleanup.orphanCount;
  await writeFile(resolve(evidenceRoot, "browser-acceptance.json"), JSON.stringify(report, null, 2));
  if (report.cleanup.orphanCount) throw new Error(`Browser cleanup left ${report.cleanup.orphanCount} owned Chrome processes`);
}

async function run() {
  const archive = resolve(viewerExport, "viewer.tar");
  execFileSync("git", ["-C", viewerRepo, "archive", "--format=tar", `--output=${archive}`, viewerCommit, "packages/viewer"]);
  execFileSync("tar", ["-xf", archive, "-C", viewerExport]);
  server = spawn(process.execPath, ["server.mjs"], { cwd: appRoot, detached: true, env: { ...process.env, UNSEEN_WEB_PORT: String(appPort), UNSEEN_WEB_TEST: "1", UNSEEN_WEB_LOCAL_DETERMINISTIC_LOCATOR: "1", UNSEEN_VIEWER_ROOT: viewerRoot }, stdio: ["ignore", "pipe", "pipe"] });
  report.cleanup.serverProcessGroup = server.pid;
  await waitForOutput(server.stdout, "UNSEEN Web");
  chrome = spawn(chromePath, [
    "--headless=new", "--disable-background-networking", "--disable-component-update", "--disable-default-apps", "--disable-sync", "--metrics-recording-only", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"
  ], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  report.cleanup.chromeProcessGroup = chrome.pid;
  const [debugPort] = (await waitForFile(join(profile, "DevToolsActivePort"))).trim().split("\n");
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const target = targets.find((item) => item.type === "page");
  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.ready;
  await Promise.all([cdp.send("Page.enable"), cdp.send("Runtime.enable"), cdp.send("Network.enable"), cdp.send("Log.enable"), cdp.send("DOM.enable"), cdp.send("Accessibility.enable")]);
  installObservers();

  await externalViewAndReturnFlow();
  await mediaNoticeRouteEvidence();
  const batch = await uploadAndPlacementFlow();
  await ownerFlow(batch);
  await dialogKeyboardEvidence();
  await representativePageChecks(batch);
  await destructiveFocusEvidence();
  await viewportEvidence();
  await accessibilityEvidence();
  await mediaBoundaryEvidence();
  await tamperedPhotoEvidence();
  await exceptionEvidence();
  await transportEvidence();
  await finalViewerScreenshot();

  report.summary = {
    consoleErrorCount: report.consoleErrors.length,
    exceptionCount: report.exceptions.length,
    unexpectedHttpErrorCount: report.httpErrors.length,
    unexpectedExternalRequestCount: report.unexpectedExternalRequests.length,
    failedRequestCount: report.failedRequests.length,
    horizontalOverflowCount: report.geometry.filter((item) => item.overflow).length,
    undersizedTouchTargetCount: report.accessibility.undersizedTargets.length,
    unnamedControlCount: report.accessibility.unnamedControls.length + report.accessibility.axUnnamed.length,
    imageMissingAltCount: report.accessibility.imagesMissingAlt.length,
    keyboardFailureCount: report.accessibility.keyboard.filter((item) => !item.pass).length,
    primaryCtaFailureCount: report.primaryCtas.filter((item) => item.count > 1).length,
    cleanupOrphanCount: 0
  };
  const failures = Object.entries(report.summary).filter(([, value]) => value !== 0);
  if (failures.length) throw new Error(`Browser acceptance failed: ${JSON.stringify(Object.fromEntries(failures))}`);
  process.stdout.write(`${JSON.stringify(report.summary)}\n`);
}

async function mediaNoticeRouteEvidence() {
  report.activeStage = "media-notice-v2";
  await reset({ external: true });
  await go("/s/space-gongguang/upload");
  const readsBefore = (await (await fetch(`${baseUrl}/__test/requests`)).json()).items.filter((item) => item.method === "GET" && item.path === "/v1/spaces/space-gongguang/upload-context").length;
  await clickText("查看完整说明");
  await waitPath("/notices/media");
  const current = await evaluate(`({search:location.search,text:document.body.innerText,version:document.querySelector('.eyebrow')?.textContent})`);
  const readsAfter = await waitForRequestCount("GET", "/v1/spaces/space-gongguang/upload-context", readsBefore + 1);
  const required = ["上传照片前请确认", "请只上传你有权分享的照片。系统会逐张检查，并尝试将照片定位到空间中。", "系统只会在原图包含带时区且可信的原始拍摄时间时保留该时间；缺少时区、时间无效或相互冲突时不会保存。", "保留的拍摄时间仅用于照片时间、记忆来源和经你明确授权的成书来源，不作其他用途。", "精确 GPS 和设备序列号不会保存；用于展示的照片副本会移除这些敏感信息。", "删除照片时，保存的拍摄时间也会一并清除；照片原有的位置调整与删除控制不因此改变。", "同意并继续上传表示你已阅读本页当前版本。"];
  assert(current.search === "?spaceId=space-gongguang" && current.version.includes("第 2 版") && required.every((copy) => current.text.includes(copy)) && readsAfter > readsBefore, `current media notice route was not exact: ${JSON.stringify({ current, readsBefore, readsAfter })}`);
  await shot("mobile-390-media-notice-v2.png");

  const rejected = [];
  const consentBefore = (await (await fetch(`${baseUrl}/__test/requests`)).json()).items.filter((item) => item.method === "POST" && item.path === "/v1/consent-events").length;
  for (const variant of ["old", "old-hash", "wrong-hash", "wrong-policy", "wrong-consent", "top-level", "malformed", "cross-space"]) {
    await fetch(`${baseUrl}/__test/media-notice`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ variant }) });
    await go("/notices/media?spaceId=space-gongguang");
    const value = await evaluate(`({stable:Boolean(document.querySelector('[data-phase="stable_error"]')),text:document.body.innerText,html:document.querySelector('#app').innerHTML})`);
    value.pass = value.stable && !value.text.includes("上传照片前请确认") && !value.html.includes("<script>bad()");
    assert(value.pass, `${variant} media notice was presented as current: ${JSON.stringify(value)}`);
    await go("/s/space-gongguang/upload");
    const upload = await evaluate(`({stable:Boolean(document.querySelector('[data-phase="stable_error"]')),consent:Boolean(document.querySelector('[data-action="UPLOAD.ACCEPT_NOTICE"],[data-notice-check]'))})`);
    assert(upload.stable && !upload.consent, `${variant} upload context rendered a consent action: ${JSON.stringify(upload)}`);
    rejected.push({ variant, stable: value.stable, uploadStable: upload.stable, consentRendered: upload.consent, pass: value.pass });
  }
  await go("/notices/media");
  const missingState = await evaluate(`Boolean(document.querySelector('[data-phase="stable_error"]'))`);
  assert(missingState, "media notice without exact spaceId did not fail closed");
  const consentAfter = (await (await fetch(`${baseUrl}/__test/requests`)).json()).items.filter((item) => item.method === "POST" && item.path === "/v1/consent-events").length;
  assert(consentAfter === consentBefore, "rejected media notice state emitted consent");
  report.mediaNotice = { currentVersion: 2, currentHashBoundByServer: true, exactSpaceQuery: current.search, freshRead: readsAfter > readsBefore, rejected, missingState, rejectedConsentCount: consentAfter - consentBefore, legalApproval: "external formal-release blocker", pass: true };
  report.steps.push("照片处理说明：query spaceId 独立重取 exact v2/fe33；旧 80c、同版错 hash、恶意 policy、跨空间稳定拒绝且 0 consent");
  await reset({ external: true });
}

function installObservers() {
  cdp.on("Runtime.consoleAPICalled", (params) => { if (["error", "assert"].includes(params.type)) report.consoleErrors.push(params.args.map((arg) => arg.value || arg.description).join(" ")); });
  cdp.on("Runtime.exceptionThrown", (params) => report.exceptions.push(params.exceptionDetails.exception?.description || params.exceptionDetails.text));
  cdp.on("Network.responseReceived", ({ response }) => {
    if (response.status >= 400) {
      const value = { status: response.status, url: redact(response.url) };
      if (response.url.includes("/__expected_failure__")) report.expectedHttpErrors.push(value); else report.httpErrors.push(value);
    }
    const url = new URL(response.url);
    if (url.protocol.startsWith("http") && !["127.0.0.1", "localhost"].includes(url.hostname)) report.unexpectedExternalRequests.push(redact(response.url));
  });
  cdp.on("Network.requestWillBeSent", ({ requestId, request }) => networkUrls.set(requestId, request.url));
  cdp.on("Network.loadingFailed", (params) => { if (!params.canceled && params.errorText !== "net::ERR_ABORTED") report.failedRequests.push({ stage: report.activeStage, url: redact(networkUrls.get(params.requestId) || "unknown"), errorText: params.errorText, type: params.type }); });
}

async function externalViewAndReturnFlow() {
  report.activeStage = "external-home";
  await reset({ external: false, owner: false });
  await setViewport(390, 844);
  await go("/");
  await shot("mobile-390-home-production.png");
  const productText = await evaluate(`document.body.innerText`);
  assert(!/验收|fixture|调试验证码|重置验收/.test(productText), "default product DOM contains debug chrome");
  assert(productText.includes("确定性本地定位样本") && productText.includes("非真实定位质量"), "production local locator disclosure is missing");
  assert(await evaluate(`globalThis.__UNSEEN_TEST__===undefined&&!document.querySelector('.fixture-banner')`), "local locator disclosure switched to fixture adapter/chrome");
  await clickText("打开空间");
  await setValue("#campaign-link", `${baseUrl}/open/gongguang-2026`);
  await submit("[data-open-space-form]");
  await waitPath("/open/gongguang-2026");
  await clickText("继续打开");
  await waitPath("/s/space-gongguang/album", 12_000);
  await shot("mobile-390-album-production.png");
  report.steps.push("production HttpAdapter：首页→活动 admission/exchange→相册");

  await clickText("现场");
  await waitPath("/s/space-gongguang/scene");
  await waitFor(`document.querySelector('[data-viewer-root] canvas,.unseen-viewer__fallback')`);
  const viewer = await evaluate(`({canvas:Boolean(document.querySelector('[data-viewer-root] canvas')),flat:Boolean(document.querySelector('.unseen-viewer__fallback:not([hidden])')),roleImg:Boolean(document.querySelector('[data-viewer-root][role="img"]')),viewerControls:document.querySelectorAll('.unseen-viewer button').length})`);
  assert(!viewer.roleImg && (viewer.canvas || viewer.flat), "production scene did not mount real Track 4 output");
  const photoList = await evaluate(`({fakeOverlayCount:document.querySelectorAll('.viewer-photo-overlay,.scene-marker,[style*="--marker-x"],[style*="--marker-y"]').length,ids:[...document.querySelectorAll('.viewer-photo-list .viewer-photo-button')].map(button=>button.dataset.photoId),labels:[...document.querySelectorAll('.viewer-photo-list .viewer-photo-button')].map(button=>button.textContent.trim())})`);
  assert(photoList.fakeOverlayCount === 0, `production canvas contains pseudo-position dots: ${JSON.stringify(photoList)}`);
  assert(JSON.stringify(photoList.ids) === JSON.stringify(["photo-1"]) && photoList.labels.every((label) => label.startsWith("已定位 · ")), `effective scene photo list was not honest: ${JSON.stringify(photoList)}`);
  report.viewerPhotoList = { ...photoList, strictIdentityCalls: "every confirmed list button covered by production-adapter public API spy; real Track 4 initial focus/return covered in this run", pass: true };
  report.viewer = viewer;
  report.activeStage = "scene-to-photo-spa";
  await clickText("查看相册");
  await waitPath("/s/space-gongguang/album");
  await clickSelector('[data-photo-card="photo-1"] a');
  await waitPath("/s/space-gongguang/photos/photo-1");
  await evaluate(`scrollTo(0,document.documentElement.scrollHeight)`);
  await clickText("回到现场");
  await waitPath("/s/space-gongguang/scene");
  await waitFor(`document.querySelector('[data-viewer-root] canvas,.unseen-viewer__fallback')`);
  await waitFor(`scrollY===0`);
  const forward = await evaluate(`({scrollY,h1Top:document.querySelector('h1').getBoundingClientRect().top,headerBottom:document.querySelector('header').getBoundingClientRect().bottom})`);
  assert(forward.scrollY === 0 && forward.h1Top >= forward.headerBottom, `scene forward scroll failed: ${JSON.stringify(forward)}`);
  await delay(500);
  const canReturn = await evaluate(`document.activeElement?.tagName==='CANVAS' || Boolean(document.querySelector('[data-action="return"]:not([hidden])'))`);
  if (canReturn) {
    await clickSelector('[data-action="return"]:not([hidden])');
    await waitPath("/s/space-gongguang/album");
    const returned = await evaluate(`({focused:document.activeElement?.closest('[data-photo-card]')?.dataset.photoCard,visible:Boolean(document.activeElement?.closest('[data-photo-card]') && document.activeElement.getBoundingClientRect().bottom>64 && document.activeElement.getBoundingClientRect().top<innerHeight)})`);
    assert(returned.focused === "photo-1" && returned.visible, `returnrequest did not restore card: ${JSON.stringify(returned)}`);
    report.viewer.returnRequestBrowser = "verified";
  } else {
    await clickText("查看相册");
    await waitPath("/s/space-gongguang/album");
    report.viewer.returnRequestBrowser = "headless render did not expose spherical focus; strict public-API adapter test covers revision-bound returnrequest";
  }

  await setViewport(390, 600);
  const savedScroll = await evaluate(`(() => { const top=Math.min(500,document.documentElement.scrollHeight-innerHeight); scrollTo({top,left:0,behavior:'instant'}); const a=document.querySelector('[data-photo-card="photo-3"] a'); a.focus(); a.click(); return top; })()`);
  await waitPath("/s/space-gongguang/photos/photo-3");
  await evaluate(`history.back()`);
  await waitPath("/s/space-gongguang/album");
  const back = await evaluate(`({scrollY,focused:document.activeElement?.closest('[data-photo-card]')?.dataset.photoCard})`);
  report.accessibility.keyboard.push({ check: "history-scroll-and-focus", savedScroll, ...back, pass: savedScroll > 0 && back.scrollY === savedScroll && back.focused === "photo-3" });
  await setViewport(390, 844);
  report.steps.push("real Viewer：照片 hash→focusPose→scene 顶部→returnrequest 卡片/焦点；history 恢复");
  report.activeStage = "external-complete";
}

async function uploadAndPlacementFlow() {
  report.activeStage = "upload-and-placement";
  await go("/s/space-gongguang/upload");
  await clickSelector("[data-notice-check]");
  await clickText("同意并继续");
  await setFile("#photo-files", resolve(appRoot, "assets/photos/photo-2.jpg"));
  await waitFor(`document.querySelector('[data-action="UPLOAD.FINALIZE_BATCH"]')`);
  const batchId = await evaluate(`document.querySelector('[data-action="UPLOAD.FINALIZE_BATCH"]').dataset.batchId`);
  await clickText("完成本次上传");
  await waitPath(`/uploads/${batchId}`);
  await shot("mobile-390-batch-receipt-production.png");
  await clickText("绑定恢复邮箱");
  assert((await evaluate(`document.querySelector('#binding-code')`)) === null, "binding OTP was requested before challenge creation");
  await setValue("#binding-email", "guest@example.com");
  await clickText("获取验证码");
  await waitFor(`document.querySelector('#binding-code')`);
  assert((await evaluate(`document.querySelector('#binding-code').value`)) === "", "production binding OTP was prefilled");
  await setValue("#binding-code", "246810");
  await clickSelector("[data-dialog-confirm]");
  await waitFor(`!document.querySelector('[role=dialog]')`);
  await clickSelector('a[href*="/items/"]');
  await clickText("调整位置");
  await waitPathPrefix("/placements/");
  try {
    await waitFor(`document.querySelector('[data-placement-form]')?.dataset.poseReady==='true'||document.querySelector('.unseen-viewer')?.dataset.renderMode==='flat_fallback'||document.querySelector('.viewer-unavailable')`);
  } catch (error) {
    const diagnostic = await evaluate(`({path:location.pathname,form:Boolean(document.querySelector('[data-placement-form]')),root:document.querySelector('[data-viewer-root]')?.innerHTML,body:document.body.innerText.slice(-800)})`);
    throw new Error(`placement viewer readiness failed: ${JSON.stringify(diagnostic)}`, { cause: error });
  }
  const thumb = await evaluate(`({shown:Boolean(document.querySelector('.placement-target img')),source:document.querySelector('.placement-target img')?.src.startsWith('blob:')})`);
  assert(thumb.shown && thumb.source, "placement editor did not render verified target bytes");
  await shot("mobile-390-placement-real-viewer.png");
  const placementRuntime = await evaluate(`({poseReady:document.querySelector('[data-placement-form]')?.dataset.poseReady==='true',renderMode:document.querySelector('.unseen-viewer')?.dataset.renderMode,saveDisabled:document.querySelector('[data-placement-form] [type=submit]')?.disabled,unavailable:Boolean(document.querySelector('.viewer-unavailable'))})`);
  if (placementRuntime.poseReady) {
    await submit("[data-placement-form]");
    await waitFor(`document.querySelector('[data-placement-form]')`);
  } else {
    assert(placementRuntime.renderMode === "flat_fallback" && placementRuntime.saveDisabled, `flat fallback allowed placement save: ${JSON.stringify(placementRuntime)}`);
  }
  report.placementEditor = [{ actor: "contributor", ...placementRuntime, honestFallback: !placementRuntime.poseReady }];
  await clickText("返回照片");
  await waitPathPrefix(`/uploads/${batchId}/items/`);
  assert((await evaluate(`document.body.innerText.includes('已由主人确认') || document.body.innerText.includes('系统已定位')`)), "placement mutation was not re-read");
  report.steps.push(`production upload：真实 File bytes→ticket PUT→commit→batch/receipt/item→Viewer ${placementRuntime.poseReady ? "位置保存" : "flat fallback 禁止猜值提交"}→route re-read`);
  return batchId;
}

async function ownerFlow(batchId) {
  report.activeStage = "owner-flow";
  await go("/login");
  await setValue("#email", "max@example.com");
  await submit("[data-login-form]");
  await waitFor(`document.querySelector('[data-local-captcha]')`);
  await clickSelector('[data-local-captcha-tile="1"]');
  await clickSelector('[data-local-captcha-tile="5"]');
  await clickSelector("[data-local-captcha-confirm]");
  await waitFor(`document.querySelector('#code')`);
  assert((await evaluate(`document.querySelector('#code').value`)) === "", "production OTP was prefilled");
  await setValue("#code", "246810");
  await submit("[data-login-form]");
  await waitPath("/spaces");
  await waitFor(`document.querySelector('a[href^="/s/"]')`);
  await clickText("进入空间");
  await waitPath("/s/space-gongguang/album");
  await waitFor(`document.querySelector('a[href="/manage/space-gongguang"]')`);
  await clickText("管理");
  await waitPath("/manage/space-gongguang");
  await clickText("审核");
  const beforeQueue = await evaluate(`document.querySelectorAll('[data-queue-item]').length`);
  await clickText("通过");
  await waitFor(`document.querySelectorAll('[data-queue-item]').length<${beforeQueue}`);
  const nextFocus = await evaluate(`({remaining:document.querySelectorAll('[data-queue-item]').length,inside:Boolean(document.activeElement?.closest('[data-queue-item]')),tag:document.activeElement?.tagName})`);
  report.accessibility.keyboard.push({ check: "review-next-focus", ...nextFocus, pass: nextFocus.remaining === 0 || nextFocus.inside });
  while (await evaluate(`document.querySelectorAll('[data-queue-item]').length`)) {
    const count = await evaluate(`document.querySelectorAll('[data-queue-item]').length`);
    await clickText("通过");
    await waitFor(`document.querySelectorAll('[data-queue-item]').length<${count}`);
  }
  await waitFor(`document.body.innerText.includes('现在没有待审核照片')`);
  await waitFor(`document.activeElement?.tagName==='H2'`);
  const focus = await evaluate(`({tag:document.activeElement?.tagName,text:document.activeElement?.textContent?.trim()})`);
  report.accessibility.keyboard.push({ check: "review-remove-focus", ...focus, pass: focus.tag === "H2" && focus.text.includes("没有待审核") });
  await go(`/placements/uploaded-${batchId}-item-1/edit`);
  await waitFor(`document.querySelector('[data-placement-form]')?.dataset.poseReady==='true'||document.querySelector('.unseen-viewer')?.dataset.renderMode==='flat_fallback'`);
  const ownerPlacementRuntime = await evaluate(`({poseReady:document.querySelector('[data-placement-form]')?.dataset.poseReady==='true',renderMode:document.querySelector('.unseen-viewer')?.dataset.renderMode,saveDisabled:document.querySelector('[data-placement-form] [type=submit]')?.disabled})`);
  if (ownerPlacementRuntime.poseReady) {
    await submit("[data-placement-form]");
    await waitFor(`document.querySelector('[data-placement-form]')?.dataset.poseReady==='true'`);
    await clickText("撤回这次修改");
  } else {
    assert(ownerPlacementRuntime.renderMode === "flat_fallback" && ownerPlacementRuntime.saveDisabled, `owner flat fallback allowed placement save: ${JSON.stringify(ownerPlacementRuntime)}`);
  }
  report.placementEditor.push({ actor: "owner", ...ownerPlacementRuntime, honestFallback: !ownerPlacementRuntime.poseReady });
  await go("/manage/space-gongguang?tab=scene");
  await setFile("[data-panorama-file]", resolve(appRoot, "assets/panorama/pano.jpg"));
  await waitFor(`Boolean(document.querySelector('[data-action="PANORAMA.SWITCH_CANDIDATE"]'))`);
  const panoramaPolling = await evaluate(`({ready:document.body.innerText.includes('现场文件检查通过，可以切换到这个现场'),button:document.querySelector('[data-action="PANORAMA.SWITCH_CANDIDATE"]')?.textContent.trim(),route:location.pathname+location.search})`);
  assert(panoramaPolling.ready && panoramaPolling.button === "使用这个现场" && panoramaPolling.route === "/manage/space-gongguang?tab=scene", `panorama polling did not project ready candidate without refresh: ${JSON.stringify(panoramaPolling)}`);
  report.panoramaPolling = { ...panoramaPolling, pass: true };
  await go("/account");
  await clickText("发起主人转移");
  assert((await evaluate(`document.querySelector('#transfer-member option')?.value`)) === "member-1", "account owner-transfer route did not render eligibleMemberships DTO");
  await clickSelector("[data-close-dialog]");
  await clickText("退出所有设备");
  assert((await evaluate(`document.querySelector('#reauth-code')`)) === null, "reauth OTP appeared before challenge request");
  await clickSelector("[data-dialog-confirm]");
  await waitFor(`document.querySelector('#reauth-code')`);
  assert((await evaluate(`document.querySelector('#reauth-code').value`)) === "", "production reauth OTP was prefilled");
  await setValue("#reauth-code", "246810");
  await clickSelector("[data-dialog-confirm]");
  await waitPath("/");
  report.steps.push(`production owner：OTP challenge/verify→我的空间→审核移除焦点→${ownerPlacementRuntime.poseReady ? "位置移动/撤回" : "flat fallback 禁止猜值提交"}→现场 validating/ready 自动投影→purpose-bound reauth→退出所有设备`);
}

async function dialogKeyboardEvidence() {
  report.activeStage = "dialog-keyboard-evidence";
  await setSession({ owner: true, external: true });
  await go("/manage/space-gongguang?tab=invitations");
  const campaignRequestPath = "/v1/spaces/space-gongguang/external-invitation-campaigns";
  const campaignRequestsBefore = (await (await fetch(`${baseUrl}/__test/requests`)).json()).items.filter((item) => item.method === "POST" && item.path === campaignRequestPath).length;
  await tabTo("[data-open-campaign]");
  await pressKey("Enter");
  await waitFor(`document.querySelector('[role=dialog]')`);
  const campaignOpen = await dialogState("[data-close-dialog]");
  assert(campaignOpen.pass, `campaign dialog portal/focus failed: ${JSON.stringify(campaignOpen)}`);
  await pressKey("Tab", true);
  assert(await evaluate(`document.activeElement?.matches('[data-dialog-confirm]')`), "Shift+Tab did not wrap to campaign confirm");
  await pressKey("Space");
  await waitFor(`!document.querySelector('[role=dialog]')`);
  const campaignRequestCount = await waitForRequestCount("POST", campaignRequestPath, campaignRequestsBefore + 1);
  const campaignDone = await evaluate(`({rootCount:document.querySelectorAll('[data-dialog-root]').length,appInert:document.querySelector('#app').inert})`);
  campaignDone.requestCount = campaignRequestCount;
  campaignDone.pass = campaignDone.rootCount === 1 && !campaignDone.appInert && campaignDone.requestCount === campaignRequestsBefore + 1;
  assert(campaignDone.pass, `campaign dialog keyboard confirmation/rerender failed: ${JSON.stringify(campaignDone)}`);

  await go("/account");
  await tabTo("[data-open-owner-transfer]");
  await pressKey("Space");
  await waitFor(`document.querySelector('[role=dialog]')`);
  const ownerOpen = await dialogState("[data-close-dialog]");
  assert(ownerOpen.pass, `owner-transfer dialog portal/focus failed: ${JSON.stringify(ownerOpen)}`);
  await pressKey("Tab", true);
  assert(await evaluate(`document.activeElement?.matches('[data-dialog-confirm]')`), "Shift+Tab did not wrap to owner-transfer confirm");
  await pressKey("Tab");
  assert(await evaluate(`document.activeElement?.matches('[data-close-dialog]')`), "Tab did not wrap to first dialog control");
  await pressKey("Escape");
  await waitFor(`!document.querySelector('[role=dialog]')`);
  const ownerClosed = await evaluate(`({returned:document.activeElement?.matches('[data-open-owner-transfer]'),rootCount:document.querySelectorAll('[data-dialog-root]').length,appInert:document.querySelector('#app').inert})`);
  ownerClosed.pass = ownerClosed.returned && ownerClosed.rootCount === 1 && !ownerClosed.appInert;
  assert(ownerClosed.pass, `owner-transfer Escape/focus return failed: ${JSON.stringify(ownerClosed)}`);

  report.accessibility.keyboard.push(
    { check: "campaign-dialog-enter-space-portal-rerender", campaignOpen, campaignDone, pass: true },
    { check: "owner-transfer-dialog-space-tab-trap-escape-return", ownerOpen, ownerClosed, pass: true }
  );
  report.steps.push("production dialog：键盘 Enter/Space 打开与确认；双向 Tab trap；Escape 焦点返回；portal 跨 rerender 保持唯一");
}

async function dialogState(expectedFocus) {
  return evaluate(`(() => {
    const dialog=document.querySelector('[role=dialog]'),root=document.querySelector('[data-dialog-root]'),app=document.querySelector('#app');
    const rect=dialog?.getBoundingClientRect(),center=rect&&document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
    const value={rootCount:document.querySelectorAll('[data-dialog-root]').length,rootIsBodyChild:root?.parentElement===document.body,rootFollowsApp:root?.previousElementSibling===app,backgroundInert:app?.inert===true,dialogInInert:Boolean(dialog?.closest('[inert]')),activeMatches:document.activeElement?.matches(${JSON.stringify(expectedFocus)}),centerInDialog:Boolean(center?.closest('[role=dialog]'))};
    value.pass=value.rootCount===1&&value.rootIsBodyChild&&value.rootFollowsApp&&value.backgroundInert&&!value.dialogInInert&&value.activeMatches&&value.centerInDialog;
    return value;
  })()`);
}

async function representativePageChecks(batchId) {
  report.activeStage = "representative-pages";
  await setSession({ owner: true, external: true });
  const routes = [
    ["P01", "/"], ["LEGAL-privacy", "/privacy"], ["LEGAL-terms", "/terms"], ["P02", "/open"], ["P03", "/open/gongguang-2026"], ["P04", "/manage/space-gongguang?tab=setup"], ["P05", "/s/space-gongguang/album"], ["P06", "/s/space-gongguang/scene"], ["P07", "/s/space-gongguang/upload"], ["P08", `/uploads/${batchId}`], ["P09", `/uploads/${batchId}/items/${batchId}-item-1`], ["P10", `/placements/uploaded-${batchId}-item-1/edit?batch=${batchId}&item=${batchId}-item-1`], ["P11", "/manage/space-gongguang"], ["P12", "/manage/space-gongguang?tab=review"], ["P13", "/manage/space-gongguang?tab=placement"], ["P14", "/manage/space-gongguang?tab=scene"], ["P15", "/manage/space-gongguang?tab=invitations"], ["P16", "/manage/space-gongguang?tab=members"], ["P17", "/manage/space-gongguang?tab=settings"], ["P18", "/account"], ["P18-uploads", "/account/uploads"], ["P18-export", "/exports/export-1"], ["P18-delete", "/deletions/delete-1"], ["P18-report", "/reports/report-1"], ["P18-appeal", "/appeals/appeal-1"], ["P18-support", "/support/cases/support-1"], ["P18-job", "/jobs/job-1"]
  ];
  for (const [page, route] of routes) {
    await go(route);
    await waitFor(`!document.querySelector('[data-phase="loading"]')`);
    if (route === "/privacy" || route === "/terms") {
      const legal = await evaluate(`({text:document.body.innerText,title:document.querySelector('h1')?.textContent,status:document.querySelector('[data-phase="stable_error"] h2')?.textContent})`);
      legal.pass = !/本机|验收|候选|发布前|审批/.test(legal.text) && Boolean(legal.title) && /暂时无法加载/.test(legal.status || "");
      report.legalRoutes.push({ route, ...legal });
      assert(legal.pass, `${route} exposed construction or unapproved policy copy: ${JSON.stringify(legal)}`);
    }
    const count = await evaluate(`[...document.querySelectorAll('.button-primary')].filter(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&!el.closest('[inert]')}).length`);
    report.primaryCtas.push({ page, route, scope: "page", count });
    assert(count <= 1, `${page} has ${count} primary CTAs`);
    const value = await geometry(route, 390);
    report.geometry.push({ ...value, pageId: page });
    report.accessibility.undersizedTargets.push(...value.undersizedTargets.map((item) => ({ page, width: 390, route, ...item })));
    report.accessibility.unnamedControls.push(...value.unnamedControls.map((item) => ({ page, width: 390, route, ...item })));
    report.accessibility.imagesMissingAlt.push(...value.imagesMissingAlt.map((item) => ({ page, width: 390, route, ...item })));
    const ax = await cdp.send("Accessibility.getFullAXTree");
    report.accessibility.axUnnamed.push(...ax.nodes.filter((node) => ["button", "link", "textbox", "combobox", "checkbox", "radio"].includes(node.role?.value) && !node.ignored && !node.name?.value).map((node) => ({ page, route, role: node.role.value, backendDOMNodeId: node.backendDOMNodeId })));
  }
}

async function destructiveFocusEvidence() {
  report.activeStage = "destructive-focus-evidence";
  await reset({ owner: true, external: true });
  await fetch(`${baseUrl}/__test/focus-fixtures`, { method: "POST" });

  await go("/s/space-gongguang/upload");
  await clickText("移出本次上传");
  await clickSelector("[data-dialog-confirm]");
  await waitFor(`!document.querySelector('[data-confirm-action="UPLOAD.REMOVE_ITEM"]')`);
  const removed = await evaluate(`({tag:document.activeElement?.tagName,text:document.activeElement?.textContent?.trim(),body:document.activeElement===document.body})`);
  removed.pass = !removed.body && removed.tag === "H2" && removed.text.includes("本次上传");
  report.accessibility.keyboard.push({ check: "upload-remove-focus", ...removed });
  assert(removed.pass, `upload remove focus failed: ${JSON.stringify(removed)}`);

  await go("/uploads/batch-delete/items/batch-delete-item-1");
  await clickText("删除这张照片");
  await clickSelector("[data-dialog-confirm]");
  await waitFor(`document.querySelector('#reauth-code')`);
  await setValue("#reauth-code", "246810");
  await clickSelector("[data-dialog-confirm]");
  await waitFor(`!document.querySelector('[data-confirm-action="BATCH.DELETE_ITEM"]')`);
  const deleted = await evaluate(`({tag:document.activeElement?.tagName,text:document.activeElement?.textContent?.trim(),body:document.activeElement===document.body})`);
  deleted.pass = !deleted.body && deleted.tag === "H1" && deleted.text.includes("待删除照片");
  report.accessibility.keyboard.push({ check: "batch-delete-focus", ...deleted });
  assert(deleted.pass, `batch delete focus failed: ${JSON.stringify(deleted)}`);

  await go("/manage/space-gongguang?tab=members");
  await clickText("移除成员");
  await clickSelector("[data-dialog-confirm]");
  await waitFor(`!document.querySelector('[data-confirm-action="MEMBERSHIP.REVOKE"]')`);
  const revoked = await evaluate(`({tag:document.activeElement?.tagName,text:document.activeElement?.textContent?.trim(),body:document.activeElement===document.body})`);
  revoked.pass = !revoked.body && revoked.tag === "H2" && revoked.text.includes("账号成员");
  report.accessibility.keyboard.push({ check: "membership-revoke-focus", ...revoked });
  assert(revoked.pass, `membership revoke focus failed: ${JSON.stringify(revoked)}`);
  report.steps.push("production removal focus：上传移除→照片删除 reauth→成员撤销，触发器移除后均不落 BODY");
}

async function viewportEvidence() {
  report.activeStage = "viewport-evidence";
  const widths = [320, 390, 430, 768, 959, 960, 1247, 1248, 1280, 1440];
  const desktopRects = [];
  for (const width of widths) {
    await reset({ owner: true, external: true });
    await setViewport(width, width < 1248 ? 900 : 1000);
    await go("/manage/space-gongguang?tab=review");
    const value = await geometry("/manage/space-gongguang?tab=review", width);
    report.geometry.push(value);
    report.accessibility.undersizedTargets.push(...value.undersizedTargets.map((item) => ({ width, route: value.route, ...item })));
    report.accessibility.unnamedControls.push(...value.unnamedControls.map((item) => ({ width, route: value.route, ...item })));
    report.accessibility.imagesMissingAlt.push(...value.imagesMissingAlt.map((item) => ({ width, route: value.route, ...item })));
    if (width >= 1248) desktopRects.push({ width, page: value.page, heading: value.heading, card: value.card, lineHash: value.lineHash });
    await shot(`breakpoint-${width}-owner-review.png`);
  }
  const [base, ...rest] = desktopRects;
  for (const item of rest) {
    assert(item.page.width === base.page.width && item.heading.width === base.heading.width && item.card.width === base.card.width && item.lineHash === base.lineHash, `desktop geometry drift: ${JSON.stringify({ base, item })}`);
  }
  report.desktopStability = desktopRects;
}

async function accessibilityEvidence() {
  report.activeStage = "accessibility-evidence";
  await reset({ owner: true, external: true });
  await setViewport(390, 844);
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
  await go("/s/space-gongguang/album");
  const zoom = await evaluate(`({overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,main:Boolean(document.querySelector('main')),nav:Boolean(document.querySelector('nav[aria-label="空间功能"]'))})`);
  report.accessibility.zoom200 = { ...zoom, pass: !zoom.overflow && zoom.main && zoom.nav };
  assert(report.accessibility.zoom200.pass, "200% zoom acceptance failed");
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const reduced = await evaluate(`(() => { const e=document.querySelector('.interactive-card,.photo-card'); const s=getComputedStyle(e); return {transitionDuration:s.transitionDuration,animationDuration:s.animationDuration}; })()`);
  reduced.pass = Number.parseFloat(reduced.transitionDuration) <= 0.001 && Number.parseFloat(reduced.animationDuration) <= 0.001;
  report.accessibility.reducedMotion = reduced;
  assert(reduced.pass, "reduced motion was not active");
  await cdp.send("Emulation.setEmulatedMedia", { features: [] });
  const live = await evaluate(`({announcer:document.querySelector('#announcer')?.getAttribute('aria-live'),viewer:document.querySelector('[data-direction-live]')?.getAttribute('aria-live')||null,mainName:document.querySelector('main')?.getAttribute('aria-label')||document.querySelector('h1')?.textContent})`);
  report.accessibility.liveRegions = { ...live, pass: live.announcer === "polite" && Boolean(live.mainName) };
  const ax = await cdp.send("Accessibility.getFullAXTree");
  report.accessibility.axUnnamed.push(...ax.nodes.filter((node) => ["button", "link", "textbox", "combobox", "checkbox", "radio"].includes(node.role?.value) && !node.ignored && !node.name?.value).map((node) => ({ route: "/s/space-gongguang/album", role: node.role.value, backendDOMNodeId: node.backendDOMNodeId })));
  assert(report.accessibility.axUnnamed.length === 0, "accessibility tree has unnamed controls");
  await go("/account");
  await clickText("发起主人转移");
  const modal = await evaluate(`({backgroundInert:document.querySelector('#app').inert,count:[...document.querySelectorAll('[role=dialog] .button-primary')].filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0}).length})`);
  report.primaryCtas.push({ page: "P18-owner-transfer-dialog", route: "/account", scope: "dialog", count: modal.count });
  assert(modal.backgroundInert && modal.count <= 1, `modal scope failed: ${JSON.stringify(modal)}`);
  await clickSelector("[data-close-dialog]");
}

async function exceptionEvidence() {
  report.activeStage = "exception-evidence";
  await reset({ owner: true, external: true });
  await fetch(`${baseUrl}/__test/fail-next`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: 503, code: "network_unavailable" }) });
  const before = report.httpErrors.length;
  await go("/s/space-gongguang/album?__expected_failure__=1");
  await waitFor(`document.querySelector('[data-phase="stable_error"]')`);
  const induced = report.httpErrors.splice(before);
  report.expectedHttpErrors.push(...induced);
  await clickText("重新加载");
  await waitFor(`document.querySelector('.gallery')`);
  report.steps.push("production route：503 稳定错误→同 route 重试→read model 恢复");
}

async function tamperedPhotoEvidence() {
  report.activeStage = "tampered-photo-evidence";
  await reset({ owner: true, external: true });
  await fetch(`${baseUrl}/__test/tamper-photo`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ photoId: "photo-5" }) });
  await setViewport(390, 844);
  await go("/s/space-gongguang/album");
  const album = await evaluate(`({image:Boolean(document.querySelector('[data-photo-card="photo-5"] img')),stopped:document.querySelector('[data-photo-card="photo-5"]')?.innerText.includes('校验未通过')})`);
  assert(!album.image && album.stopped, "tampered photo bytes were rendered in album");
  await go("/s/space-gongguang/scene?photo=photo-5");
  await waitFor(`document.querySelector('.viewer-unavailable')`);
  const focus = await evaluate(`({returnVisible:Boolean(document.querySelector('[data-action="return"]:not([hidden])')),listed:Boolean(document.querySelector('.viewer-photo-button[data-photo-id="photo-5"]')),viewerOutput:Boolean(document.querySelector('[data-viewer-root] canvas,.unseen-viewer__fallback')),fakeOverlayCount:document.querySelectorAll('.viewer-photo-overlay,.scene-marker,[style*="--marker-x"],[style*="--marker-y"]').length})`);
  assert(!focus.returnVisible, "tampered photo identity was focused/returnable");
  assert(!focus.listed && !focus.viewerOutput, "tampered photo bytes reached Viewer output");
  assert(focus.fakeOverlayCount === 0, "tampered scene rendered pseudo-position dots");
  report.tamperedPhoto = { photoId: "photo-5", album, focus, pass: true };
}

async function mediaBoundaryEvidence() {
  report.activeStage = "media-boundary-evidence";
  await reset({ owner: true, external: true });
  await fetch(`${baseUrl}/__test/media-etag-mismatch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "panorama" }) });
  await go("/s/space-gongguang/scene?photo=photo-1");
  await waitFor(`document.querySelector('.viewer-unavailable')`);
  const blocked = await evaluate(`({unavailable:document.body.innerText.includes('现场预览暂时不可用'),viewerOutput:Boolean(document.querySelector('[data-viewer-root] canvas,.unseen-viewer__fallback')),fixture:Boolean(document.querySelector('.viewer-fixture'))})`);
  assert(blocked.unavailable && !blocked.viewerOutput && !blocked.fixture, `ETag mismatch reached Viewer: ${JSON.stringify(blocked)}`);
  await fetch(`${baseUrl}/__test/media-etag-mismatch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: null }) });
  await go("/s/space-gongguang/scene?photo=photo-1");
  await waitFor(`document.querySelector('[data-viewer-root] canvas,.unseen-viewer__fallback')`);
  const recovered = await evaluate(`({viewerOutput:Boolean(document.querySelector('[data-viewer-root] canvas,.unseen-viewer__fallback')),fixture:Boolean(document.querySelector('.viewer-fixture'))})`);
  assert(recovered.viewerOutput && !recovered.fixture, `verified media retry did not recover: ${JSON.stringify(recovered)}`);

  await go("/v2-labs/books");
  const bookOff = await evaluate(`({notFound:document.body.innerText.includes('这个页面不存在'),dom:[...document.querySelectorAll('*')].some(el=>/记忆成书|回答这张照片的问题/.test(el.textContent||'')),bundle:performance.getEntriesByType('resource').some(entry=>entry.name.includes('book-lab.js'))})`);
  assert(bookOff.notFound && !bookOff.dom && !bookOff.bundle, `Book flag-off was not inert: ${JSON.stringify(bookOff)}`);
  report.mediaBoundary = { etagMismatch: blocked, recovered, bookFlagOff: bookOff, pass: true };
}

async function transportEvidence() {
  report.activeStage = "transport-evidence";
  const requests = (await (await fetch(`${baseUrl}/__test/requests`)).json()).items;
  report.routeReads = requests.filter((item) => item.method === "GET").map((item) => item.path);
  assert(requests.every((item) => !/[{}]|(^|[^:])\/{2,}/.test(item.path)), "transport emitted placeholder or double slash");
  const requiredReads = ["/v1/viewer/spaces/space-gongguang", "/v1/viewer/spaces/space-gongguang/photos/photo-1/scene-context", "/v1/viewer/spaces/space-gongguang/panorama-revisions/pano-revision-2/media", "/v1/viewer/spaces/space-gongguang/photos/photo-1/media", "/v1/spaces/space-gongguang/upload-context", "/v1/contribution-batches/batch-1/result", "/v1/batch-receipt", "/v1/batch-receipt/items/batch-1-item-1", "/v1/batch-receipt/items/batch-1-item-1/placement-edit", "/v1/spaces/space-gongguang/management", "/v1/me/batch-receipt-bindings", "/v1/exports/export-1", "/v1/deletion-requests/delete-1", "/v1/reports/report-1", "/v1/appeals/appeal-1", "/v1/support-cases/support-1", "/v1/jobs/job-1"];
  for (const path of requiredReads) assert(report.routeReads.includes(path), `missing production route read ${path}`);
  const mediaReads = requests.filter((item) => item.method === "GET" && item.path.endsWith("/media"));
  assert(mediaReads.length >= 2 && mediaReads.every((item) => item.cookiePresent && Object.keys(item.headers).length === 0), "viewer media GET did not use cookie-only session auth");
  assert(!requests.some((item) => item.path.startsWith("/v2-labs/")), "Book API mounted while flag was off");
  const put = requests.find((item) => item.method === "PUT");
  assert(put?.bytes > 0 && /^[a-f0-9]{64}$/.test(put.sha256) && put.headers["x-upload-ticket"], "real upload bytes/ticket were not observed");
  const consent = requests.find((item) => item.path === "/v1/consent-events");
  assert(consent?.body?.noticeVersion === 2 && consent.body.noticeHash === "fe33ba9d5e927dffa281706d6e826d4dd06b26d3ccfca19b3eaba97f340287b0" && consent.body.mediaPolicyVersion === "2" && consent.body.choices?.display === true && consent.body.choices?.placement === true, "media notice consent did not return the exact current v2/hash/policy projection");
  report.mediaNotice.consentHashReturned = consent.body.noticeHash;
  const mutations = requests.filter((item) => ["POST", "PATCH", "DELETE"].includes(item.method) && item.path.startsWith("/v1/"));
  assert(mutations.every((item) => item.headers["idempotency-key"] && item.headers["content-type"] === "application/json"), "mutation transport metadata missing");
  const bindingRequest = requests.find((item) => item.path === "/v1/batch-receipt/account-binding-otp-challenges");
  const bindingConfirm = requests.find((item) => item.path === "/v1/batch-receipt/account-bindings");
  assert(JSON.stringify(bindingRequest?.body) === JSON.stringify({ email: "guest@example.com", locale: "zh-CN" }), "binding challenge request was not exact");
  assert(Object.keys(bindingConfirm?.body || {}).join(",") === "challengeId,otp" && bindingConfirm.body.otp === "246810" && bindingConfirm.headers["notice-acknowledgement"] === "binding:v1:approved", "binding confirmation did not preserve the exact challenge/notice contract");
  const loginRequest = requests.find((item) => item.path === "/v1/auth/email-otp-challenges");
  const loginVerify = requests.find((item) => item.path === "/v1/auth/email-otp-verifications");
  assert(loginRequest?.body?.purpose === "login" && loginVerify?.body?.purpose === "login" && loginVerify.body.challengeId, "login OTP challenge identity/purpose was not preserved");
  const reauthRequest = requests.find((item) => item.path === "/v1/auth/reauth-challenges" && item.body?.actionId === "AUTH.LOGOUT_ALL");
  const reauthVerify = requests.find((item) => item.path === "/v1/auth/reauth-verifications" && item.body?.actionId === "AUTH.LOGOUT_ALL");
  const logoutAll = requests.find((item) => item.path === "/v1/auth/logout-all");
  assert(reauthRequest?.body?.purpose === "logout_all" && reauthVerify?.body?.challengeId && reauthVerify.body.purpose === "logout_all" && logoutAll?.body?.reauthGrant, "purpose-bound reauth chain was not exact");
  const deleteReauthRequest = requests.find((item) => item.path === "/v1/auth/reauth-challenges" && item.body?.actionId === "BATCH.DELETE_ITEM");
  const deleteReauthVerify = requests.find((item) => item.path === "/v1/auth/reauth-verifications" && item.body?.actionId === "BATCH.DELETE_ITEM");
  const deletePhoto = requests.find((item) => item.path === "/v1/photos/photo-2/deletion-requests");
  assert(deleteReauthRequest?.body?.purpose === "photo_delete" && deleteReauthRequest.body.targetType === "photo" && deleteReauthRequest.body.targetId === "photo-2", "photo deletion reauth request was not target-bound");
  assert(deleteReauthVerify?.body?.challengeId && deleteReauthVerify.body.purpose === "photo_delete" && deleteReauthVerify.body.targetId === "photo-2" && deletePhoto?.body?.reauthGrant, "photo deletion verify/grant chain was not exact");
  report.transport = { requestCount: requests.length, uploadPut: put, mutationCount: mutations.length, mediaReadCount: mediaReads.length, cookieOnlyMediaReads: true, bookApiMountCount: 0, placeholderCount: 0, doubleSlashPathCount: 0 };
}

async function finalViewerScreenshot() {
  report.activeStage = "final-real-viewer-screenshot";
  await reset({ owner: true, external: true });
  await setViewport(390, 844);
  await go("/s/space-gongguang/scene?photo=photo-1");
  await waitFor(`document.querySelector('[data-viewer-root] canvas,.unseen-viewer__fallback')`);
  await shot("mobile-390-scene-real-viewer.png");
}

async function geometry(route, width) {
  return evaluate(`(() => {
    const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el),closed=el.closest('details:not([open])');return !el.matches('.sr-only')&&!(closed&&!el.matches('summary'))&&r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&!el.closest('[inert]')};
    const controls=[...document.querySelectorAll('button,a[href],input:not([type=hidden]):not([type=checkbox]):not([type=radio]),select,textarea,summary')].filter(visible);
    const description=el=>{const r=el.getBoundingClientRect();return {tag:el.tagName,name:(el.getAttribute('aria-label')||el.innerText||el.labels?.[0]?.innerText||'').trim().slice(0,60),width:Math.round(r.width*10)/10,height:Math.round(r.height*10)/10}};
    const rect=el=>{const r=el?.getBoundingClientRect();return r?{left:Math.round(r.left),top:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)}:null};
    const text=document.querySelector('.review-card .card-body')?.innerText||'';
    const offenders=[...document.querySelectorAll('*')].filter(el=>{const r=el.getBoundingClientRect();return r.right>innerWidth+1||r.left< -1}).slice(0,12).map(el=>({tag:el.tagName,className:String(el.className||''),text:(el.innerText||'').trim().slice(0,40),...rect(el)}));
    return {route:${JSON.stringify(route)},width:${width},overflow:document.documentElement.scrollWidth>innerWidth,scrollWidth:document.documentElement.scrollWidth,offenders,page:rect(document.querySelector('.page')),heading:rect(document.querySelector('.page-heading')),card:rect(document.querySelector('.review-card')),lineHash:[...text].reduce((n,c)=>(n*31+c.charCodeAt(0))>>>0,7)+':'+document.querySelector('.review-card .card-body')?.getClientRects().length,undersizedTargets:controls.filter(el=>{const r=el.getBoundingClientRect();return r.width<43.5||r.height<43.5}).map(description),unnamedControls:controls.filter(el=>!(el.getAttribute('aria-label')||el.innerText||el.labels?.length||el.getAttribute('title'))).map(description),imagesMissingAlt:[...document.images].filter(el=>visible(el)&&!el.hasAttribute('alt')).map(description)};
  })()`);
}

async function reset({ owner = false, external = false } = {}) {
  await fetch(`${baseUrl}/__test/reset`, { method: "POST" });
  await setSession({ owner, external });
}

async function setSession({ owner = false, external = false } = {}) {
  await fetch(`${baseUrl}/__test/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ owner, external }) });
}

async function go(path) {
  const url = path.startsWith("http") ? path : `${baseUrl}${path}`;
  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url });
  await timed(loaded, `load ${path}`);
  await waitFor(`document.querySelector('#main') && !document.querySelector('[data-phase="loading"]')`);
}

async function evaluate(expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

async function clickText(text) {
  const value = JSON.stringify(text);
  const clicked = await evaluate(`(() => { const el=[...document.querySelectorAll('button,a,summary,label')].find(node=>node.innerText?.trim().includes(${value})&&!node.disabled); if(!el)return false; el.focus(); el.click(); return true; })()`);
  assert(clicked, `could not click ${text}`);
  await delay(100);
}

async function clickSelector(selector) {
  const clicked = await evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el)return false; el.focus(); el.click(); return true; })()`);
  assert(clicked, `could not click ${selector}`);
  await delay(100);
}

async function tabTo(selector, limit = 80) {
  for (let index = 0; index < limit; index += 1) {
    if (await evaluate(`document.activeElement?.matches(${JSON.stringify(selector)})`)) return;
    await pressKey("Tab");
  }
  throw new Error(`could not reach ${selector} with keyboard Tab`);
}

async function submit(selector) {
  const submitted = await evaluate(`(() => { const form=document.querySelector(${JSON.stringify(selector)}); if(!form)return false; form.requestSubmit(); return true; })()`);
  assert(submitted, `could not submit ${selector}`);
  await delay(120);
}

async function setValue(selector, value) {
  const ok = await evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el)return false; const set=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value')?.set; set?set.call(el,${JSON.stringify(value)}):el.value=${JSON.stringify(value)}; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
  assert(ok, `could not set ${selector}`);
}

async function setFile(selector, path) {
  const result = await cdp.send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(selector)})` });
  assert(result.result.objectId, `file input missing ${selector}`);
  await cdp.send("DOM.setFileInputFiles", { files: [path], objectId: result.result.objectId });
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change',{bubbles:true}))`);
}

async function pressKey(name, shift = false) {
  const value = { Tab: { key: "Tab", code: "Tab", keyCode: 9 }, Escape: { key: "Escape", code: "Escape", keyCode: 27 }, Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" }, Space: { key: " ", code: "Space", keyCode: 32, text: " " } }[name];
  assert(value, `unsupported key ${name}`);
  const modifiers = shift ? 8 : 0;
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: value.key, code: value.code, windowsVirtualKeyCode: value.keyCode, nativeVirtualKeyCode: value.keyCode, modifiers, text: value.text, unmodifiedText: value.text });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: value.key, code: value.code, windowsVirtualKeyCode: value.keyCode, nativeVirtualKeyCode: value.keyCode, modifiers });
  await delay(80);
}

async function setViewport(width, height) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height });
}

async function waitPath(path, timeout = STAGE_TIMEOUT) { return waitFor(`location.pathname===${JSON.stringify(path)}`, timeout); }
async function waitPathPrefix(path, timeout = STAGE_TIMEOUT) { return waitFor(`location.pathname.startsWith(${JSON.stringify(path)})`, timeout); }
async function waitFor(expression, timeout = STAGE_TIMEOUT) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(expression)) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${expression}`);
}

async function waitForRequestCount(method, path, expected, timeout = STAGE_TIMEOUT) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const count = (await (await fetch(`${baseUrl}/__test/requests`)).json()).items.filter((item) => item.method === method && item.path === path).length;
    if (count >= expected) return count;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${method} ${path}`);
}

async function shot(name) {
  const result = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
  await writeFile(resolve(screenshots, name), Buffer.from(result.data, "base64"));
  report.screenshots.push(`evidence/screenshots/${name}`);
}

function assert(value, message) { if (!value) throw new Error(message); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function redact(url) { return url.replace(/#(?:invite|receipt)=[^&]+/, "#redacted"); }
function timed(promise, label, timeout = STAGE_TIMEOUT) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeout); })]).finally(() => clearTimeout(timer));
}
function waitForOutput(stream, value) {
  return timed(new Promise((resolve, reject) => {
    stream.on("data", (chunk) => { if (chunk.toString().includes(value)) resolve(); });
    stream.on("error", reject);
  }), `server output ${value}`);
}
async function waitForFile(path) {
  for (let index = 0; index < 200; index += 1) { try { return await readFile(path, "utf8"); } catch { await delay(50); } }
  throw new Error(`Timed out waiting for ${path}`);
}
async function terminateGroup(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(1200)]);
  if (child.exitCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
}
function ownProfileProcesses(path) {
  try {
    return execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n").filter((line) => line.includes(`--user-data-dir=${path}`)).map((line) => Number(line.trim().split(/\s+/, 1)[0])).filter(Number.isFinite);
  } catch { return []; }
}
