import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

process.umask(0o077);

const exec = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const productCandidateCommit = process.env.UNSEEN_PRODUCT_CANDIDATE_COMMIT ??
  "09076727051411eeb9274a26663f6ccd168378c3";
const evidenceRoot = path.resolve(process.env.UNSEEN_BROWSER_A11Y_EVIDENCE_ROOT ??
  path.join(repositoryRoot, "release-evidence/local-operable/stage-rc"));
const evidencePath = path.join(evidenceRoot, "FIREFOX-MACOS.json");
const screenshotPaths = Object.fromEntries(["spaces", "upload-result", "owner-review", "viewer-reopen"]
  .map((name) => [name, path.join(evidenceRoot, `screenshots/firefox-macos-${name}.png`)]));
const expected = {
  firefoxVersion: "153.0.4",
  geckodriverVersion: "0.37.1",
  bookCommit: "7d3590d3329252f4226adb2a751ffe9a2384d390",
  firefoxSource: "https://archive.mozilla.org/pub/firefox/releases/153.0.4/mac/en-US/Firefox%20153.0.4.dmg",
  geckodriverSource: "https://github.com/mozilla/geckodriver/releases/download/v0.37.1/geckodriver-v0.37.1-macos-aarch64.tar.gz"
};

function invariant(value, message) {
  if (!value) throw new Error(message);
}

function requiredEnvironment(name) {
  const value = process.env[name];
  invariant(value, `firefox_matrix_environment_required:${name}`);
  return value;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function poll(operation, label, timeout = 20_000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeout) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(75);
  }
  throw new Error(`firefox_matrix_poll_timeout:${label}`, { cause: lastError });
}

async function digest(file, algorithm) {
  const hash = createHash(algorithm);
  await new Promise((resolve, reject) => createReadStream(file).on("data", (chunk) => hash.update(chunk))
    .once("error", reject).once("end", resolve));
  return hash.digest("hex");
}

async function command(file, args, options = {}) {
  try {
    return await exec(file, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, ...options });
  } catch (error) {
    throw new Error(`firefox_matrix_command_failed:${file}:${args.join(" ")}`, { cause: error });
  }
}

async function claimPort(excluded = new Set()) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await new Promise((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const selected = server.address().port;
        server.close((error) => error ? reject(error) : resolve(selected));
      });
    });
    if (!excluded.has(port)) return port;
  }
  throw new Error("firefox_matrix_distinct_port_unavailable");
}

async function processClosed(child, timeout = 3_000) {
  if (!child || child.exitCode !== null) return true;
  return Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    delay(timeout).then(() => false)
  ]);
}

async function terminateProcessGroup(child) {
  if (!child?.pid || child.pid <= 1 || child.exitCode !== null) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  if (!await processClosed(child)) {
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    invariant(await processClosed(child), `firefox_matrix_process_group_survived:${child.pid}`);
  }
}

async function portAcceptsConnections(port) {
  return new Promise((resolve) => {
    const socket = new Socket();
    socket.setTimeout(300);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(false));
    socket.connect(port, "127.0.0.1");
  });
}

class Bidi {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.sequence = 0;
    this.pending = new Map();
    this.events = [];
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("firefox_matrix_bidi_open_failed")), { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.type === "error") reject(new Error(`firefox_matrix_bidi_error:${message.error}:${message.message}`));
        else resolve(message.result);
      } else if (message.type === "event") this.events.push(message);
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = ++this.sequence;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  close() {
    if (this.socket.readyState < WebSocket.CLOSING) this.socket.close();
  }
}

async function webdriver(port, method, route, body) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  });
  const payload = await response.json();
  if (!response.ok || payload.value?.error) {
    throw new Error(`firefox_matrix_webdriver_error:${method}:${route}:${response.status}:${payload.value?.error ?? "unknown"}`);
  }
  return payload.value;
}

async function element(port, sessionId, selector) {
  return poll(async () => {
    try {
      return await webdriver(port, "POST", `/session/${sessionId}/element`,
        { using: "css selector", value: selector });
    } catch { return null; }
  }, `element:${selector}`);
}

async function click(port, sessionId, selector) {
  const selected = await element(port, sessionId, selector);
  await webdriver(port, "POST", `/session/${sessionId}/element/${selected["element-6066-11e4-a52e-4f735466cecf"]}/click`, {});
}

async function type(port, sessionId, selector, value) {
  const selected = await element(port, sessionId, selector);
  await webdriver(port, "POST", `/session/${sessionId}/element/${selected["element-6066-11e4-a52e-4f735466cecf"]}/value`,
    { text: value, value: [...value] });
}

async function pressKey(port, sessionId, value, { shift = false } = {}) {
  const actions = shift
    ? [{ type: "keyDown", value: "\uE008" }, { type: "keyDown", value },
      { type: "keyUp", value }, { type: "keyUp", value: "\uE008" }]
    : [{ type: "keyDown", value }, { type: "keyUp", value }];
  await webdriver(port, "POST", `/session/${sessionId}/actions`, {
    actions: [{ type: "key", id: "keyboard", actions }]
  });
}

async function tabTo(port, sessionId, selector, limit = 80) {
  for (let index = 0; index < limit; index += 1) {
    if (await evaluate(port, sessionId,
      `return document.activeElement?.matches(${JSON.stringify(selector)})===true`)) return index;
    await pressKey(port, sessionId, "\uE004");
  }
  throw new Error(`firefox_matrix_keyboard_target_unreachable:${selector}`);
}

async function confirmCampaignWithKeyboard(port, sessionId, openerSelector, taskMode = "combo") {
  const selector = '[data-dialog-confirm][data-action-id="EXTERNAL_INVITATION.CREATE"]';
  const state = () => evaluate(port, sessionId, `return (()=>{const selector=${JSON.stringify(selector)},control=document.querySelector(selector),dialog=control?.closest('[role=dialog]'),active=document.activeElement;
    const describe=element=>element?{tag:element.tagName,text:(element.getAttribute('aria-label')||element.innerText||element.value||'').trim().slice(0,80),matchesConfirm:element.matches(selector),className:String(element.className||'')}:null;
    if(!control)return {control:null};const rect=control.getBoundingClientRect(),style=getComputedStyle(control),center=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
    return {control:{rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},display:style.display,visibility:style.visibility,pointerEvents:style.pointerEvents,disabled:control.disabled,tabIndex:control.tabIndex,insideInert:Boolean(control.closest('[inert]'))},elementFromPoint:describe(center),activeElement:describe(active),dialog:{rect:(()=>{const r=dialog.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})(),display:getComputedStyle(dialog).display,visibility:getComputedStyle(dialog).visibility,ariaModal:dialog.getAttribute('aria-modal')},appInert:document.querySelector('#app')?.inert===true,rootIsBodyChild:dialog?.closest('[data-dialog-root]')?.parentElement===document.body};})()`);
  const initial = await state();
  invariant(initial.control && initial.control.rect.width > 0 && initial.control.rect.height > 0 &&
    initial.control.display !== "none" && initial.control.visibility !== "hidden" &&
    initial.control.pointerEvents !== "none" && !initial.control.insideInert && initial.appInert &&
    initial.rootIsBodyChild && initial.activeElement?.text === "关闭",
  `firefox_matrix_dialog_control_state:${JSON.stringify(initial)}`);
  await pressKey(port, sessionId, "\uE004", { shift: true });
  const shiftTabWrapped = await state();
  invariant(shiftTabWrapped.activeElement?.matchesConfirm,
    `firefox_matrix_dialog_shift_tab_trap:${JSON.stringify(shiftTabWrapped)}`);
  await pressKey(port, sessionId, "\uE004");
  const tabWrapped = await state();
  invariant(tabWrapped.activeElement?.text === "关闭",
    `firefox_matrix_dialog_tab_trap:${JSON.stringify(tabWrapped)}`);
  await pressKey(port, sessionId, "\uE00C");
  await waitForCondition(port, sessionId,
    `return !document.querySelector('[role=dialog]')&&document.activeElement?.matches(${JSON.stringify(openerSelector)})`,
    "dialog Escape return focus");
  await pressKey(port, sessionId, "\uE007");
  await element(port, sessionId, selector);
  const reopened = await state();
  invariant(reopened.activeElement?.text === "关闭" && reopened.appInert && !reopened.control.insideInert,
    `firefox_matrix_dialog_keyboard_reopen:${JSON.stringify(reopened)}`);
  if (taskMode === "view") {
    await type(port, sessionId, "#task-mode", "查看照片");
    invariant(await evaluate(port, sessionId, "return document.querySelector('#task-mode')?.value==='view'"),
      "firefox_matrix_view_campaign_select_failed");
    await pressKey(port, sessionId, "\uE004", { shift: true });
  }
  await pressKey(port, sessionId, "\uE004", { shift: true });
  const confirmFocused = await state();
  invariant(confirmFocused.activeElement?.matchesConfirm,
    `firefox_matrix_dialog_confirm_focus:${JSON.stringify(confirmFocused)}`);
  if (taskMode === "view") invariant(await evaluate(port, sessionId,
    "return document.querySelector('#task-mode')?.value==='view'"), "firefox_matrix_view_campaign_select_drifted");
  await pressKey(port, sessionId, " ");
  return { initial, shiftTabWrapped: shiftTabWrapped.activeElement, tabWrapped: tabWrapped.activeElement,
    escapeReturnedToOpener: true, reopened: reopened.activeElement, confirmFocused: confirmFocused.activeElement,
    openKey: "Enter", activationKey: "Space", directWebDriverClickUsed: false,
    javascriptClickUsed: false, browserFetchShortcutUsed: false };
}

function requestHeader(request, name) {
  const headers = request?.headers;
  if (Array.isArray(headers)) {
    const header = headers.find((item) => String(item.name).toLowerCase() === name.toLowerCase());
    return typeof header?.value === "string" ? header.value : header?.value?.value;
  }
  const match = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return typeof match?.[1] === "string" ? match[1] : match?.[1]?.value;
}

async function requestLogEntries(filename) {
  try {
    return (await readFile(filename, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function injectFileInput(port, sessionId, selector, sourcePath, filename) {
  const result = await evaluateAsync(port, sessionId, `const done=arguments[arguments.length-1];
    const [selector,sourcePath,filename]=arguments;
    (async()=>{const input=document.querySelector(selector);if(!input)return done({ok:false,phase:'input'});
      const response=await fetch(sourcePath,{cache:'no-store'});if(!response.ok)return done({ok:false,phase:'source',status:response.status});
      const blob=await response.blob();const transfer=new DataTransfer();
      transfer.items.add(new File([blob],filename,{type:blob.type,lastModified:0}));input.files=transfer.files;
      input.dispatchEvent(new Event('change',{bubbles:true}));done({ok:true,fileCount:input.files.length,bytes:blob.size,type:blob.type});
    })().catch(error=>done({ok:false,phase:'exception',message:error.message}));`,
  [selector, sourcePath, filename]);
  invariant(result.ok && result.fileCount === 1 && result.bytes > 0, `firefox_matrix_file_input_injection:${JSON.stringify(result)}`);
  return result;
}

async function evaluate(port, sessionId, script, args = []) {
  return webdriver(port, "POST", `/session/${sessionId}/execute/sync`, { script, args });
}

async function evaluateAsync(port, sessionId, script, args = []) {
  return webdriver(port, "POST", `/session/${sessionId}/execute/async`, { script, args });
}

async function waitForUrl(port, sessionId, suffix) {
  return poll(async () => {
    const value = await webdriver(port, "GET", `/session/${sessionId}/url`);
    return value.endsWith(suffix) ? value : null;
  }, `url:${suffix}`);
}

async function navigate(port, sessionId, url) {
  await webdriver(port, "POST", `/session/${sessionId}/url`, { url });
  return poll(async () => {
    const ready = await evaluate(port, sessionId,
      "return document.readyState==='complete'&&Boolean(document.querySelector('#main'))&&!document.querySelector('[data-phase=loading]')");
    return ready ? webdriver(port, "GET", `/session/${sessionId}/url`) : null;
  }, `navigate:${new URL(url).pathname}`);
}

async function waitForCondition(port, sessionId, script, label, timeout = 30_000) {
  return poll(async () => await evaluate(port, sessionId, script) || null, label, timeout);
}

async function waitForText(port, sessionId, value) {
  return waitForCondition(port, sessionId, `return document.body.innerText.includes(${JSON.stringify(value)})`,
    `text:${value}`);
}

async function attribute(port, sessionId, selector, name) {
  return evaluate(port, sessionId, `return document.querySelector(${JSON.stringify(selector)})?.getAttribute(${JSON.stringify(name)})??null`);
}

async function browserCookies(port, sessionId) {
  return webdriver(port, "GET", `/session/${sessionId}/cookie`);
}

async function browserCookie(port, sessionId, name) {
  try { return await webdriver(port, "GET", `/session/${sessionId}/cookie/${name}`); }
  catch { return null; }
}

async function restoreCookie(port, sessionId, cookie) {
  await webdriver(port, "POST", `/session/${sessionId}/cookie`, { cookie: {
    name: cookie.name, value: cookie.value, path: "/", secure: true, httpOnly: true, sameSite: "Strict"
  } });
}

async function clearBrowserSiteData(port, sessionId) {
  await evaluateAsync(port, sessionId, `const done=arguments[arguments.length-1];
    Promise.all([caches.keys().then(keys=>Promise.all(keys.map(key=>caches.delete(key))))])
      .then(()=>{localStorage.clear();sessionStorage.clear();done(true)},()=>done(false));`);
  await webdriver(port, "DELETE", `/session/${sessionId}/cookie`);
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(`firefox_matrix_staging_timeout:${stderr.slice(-2000)}`)), 30_000);
    child.stdout.on("data", (bytes) => {
      stdout += bytes;
      const lines = stdout.split("\n");
      stdout = lines.pop();
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.status === "LOCAL_STAGING_READY") {
            clearTimeout(timeout);
            resolve(event);
          }
        } catch {}
      }
    });
    child.stderr.on("data", (bytes) => { stderr = `${stderr}${bytes}`.slice(-8_000); });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`firefox_matrix_staging_exited:${code}:${stderr.slice(-2000)}`));
    });
  });
}

async function loginOwner(port, id, origin, mailboxPath) {
  let previousChallengeId = "";
  try { previousChallengeId = JSON.parse(await readFile(mailboxPath, "utf8")).challengeId ?? ""; } catch {}
  await navigate(port, id, `${origin}/login`);
  await type(port, id, "#email", "firefox-matrix-owner@example.test");
  await click(port, id, '[data-login-form] button[type="submit"]');
  await element(port, id, "#code");
  const otp = await poll(async () => {
    try {
      const value = JSON.parse(await readFile(mailboxPath, "utf8"));
      return value.challengeId !== previousChallengeId && /^\d{6}$/u.test(value.code) ? value.code : null;
    } catch { return null; }
  }, "local OTP mailbox");
  await type(port, id, "#code", otp);
  await click(port, id, '[data-login-form] button[type="submit"]');
  await waitForUrl(port, id, "/spaces");
  await waitForText(port, id, "我的空间");
}

const firefoxApp = path.resolve(requiredEnvironment("UNSEEN_FIREFOX_APP"));
const firefoxBinary = path.join(firefoxApp, "Contents/MacOS/firefox");
const firefoxDmg = path.resolve(requiredEnvironment("UNSEEN_FIREFOX_DMG"));
const firefoxSha512 = requiredEnvironment("UNSEEN_FIREFOX_SHA512").toLowerCase();
const firefoxSource = requiredEnvironment("UNSEEN_FIREFOX_SOURCE_URL");
const geckodriver = path.resolve(requiredEnvironment("UNSEEN_GECKODRIVER"));
const geckodriverArchive = path.resolve(requiredEnvironment("UNSEEN_GECKODRIVER_ARCHIVE"));
const geckodriverSha256 = requiredEnvironment("UNSEEN_GECKODRIVER_SHA256").toLowerCase();
const geckodriverSource = requiredEnvironment("UNSEEN_GECKODRIVER_SOURCE_URL");
const bookWorktree = path.resolve(requiredEnvironment("UNSEEN_BOOK_WORKTREE"));

invariant(firefoxSource === expected.firefoxSource, "firefox_matrix_firefox_source_not_exact_official_release");
invariant(geckodriverSource === expected.geckodriverSource, "firefox_matrix_geckodriver_source_not_exact_official_release");
invariant(await digest(firefoxDmg, "sha512") === firefoxSha512, "firefox_matrix_firefox_sha512_mismatch");
invariant(await digest(geckodriverArchive, "sha256") === geckodriverSha256,
  "firefox_matrix_geckodriver_sha256_mismatch");

const firefoxVersion = (await command("/usr/libexec/PlistBuddy",
  ["-c", "Print :CFBundleShortVersionString", path.join(firefoxApp, "Contents/Info.plist")])).stdout.trim();
const firefoxBundleVersion = (await command("/usr/libexec/PlistBuddy",
  ["-c", "Print :CFBundleVersion", path.join(firefoxApp, "Contents/Info.plist")])).stdout.trim();
invariant(firefoxVersion === expected.firefoxVersion, "firefox_matrix_firefox_version_mismatch");
await command("codesign", ["--verify", "--deep", "--strict", firefoxApp]);
const firefoxSigning = await command("codesign", ["-dv", "--verbose=4", firefoxApp]);
invariant(firefoxSigning.stderr.includes("TeamIdentifier=43AQ936H96"), "firefox_matrix_firefox_team_invalid");
await command("spctl", ["--assess", "--type", "execute", "--verbose=4", firefoxApp]);

const geckodriverVersionOutput = (await command(geckodriver, ["--version"])).stdout.trim();
invariant(geckodriverVersionOutput.startsWith(`geckodriver ${expected.geckodriverVersion} `),
  "firefox_matrix_geckodriver_version_mismatch");
await command("codesign", ["--verify", "--strict", geckodriver]);
const geckodriverSigning = await command("codesign", ["-dv", "--verbose=4", geckodriver]);
invariant(geckodriverSigning.stderr.includes("TeamIdentifier=43AQ936H96"),
  "firefox_matrix_geckodriver_team_invalid");

const head = (await command("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })).stdout.trim();
await command("git", ["merge-base", "--is-ancestor", productCandidateCommit, head], { cwd: repositoryRoot });
const productPaths = ["apps/web", "infra/integration/local-staging.mjs", "infra/integration/local-operable.mjs",
  "config/rc/local-staging.json", "services/api", "packages/viewer"];
await command("git", ["diff", "--quiet", productCandidateCommit, "--", ...productPaths], { cwd: repositoryRoot });
const bookHead = (await command("git", ["rev-parse", "HEAD"], { cwd: bookWorktree })).stdout.trim();
const bookStatus = (await command("git", ["status", "--porcelain"], { cwd: bookWorktree })).stdout.trim();
invariant(bookHead === expected.bookCommit && !bookStatus, "firefox_matrix_book_input_invalid");

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "unseen-firefox-stage-rc-"));
const runtimeRoot = path.join(temporaryRoot, "candidate-runtime");
const stagingDataRoot = path.join(temporaryRoot, "data");
const stagingRuntimeEvidenceRoot = path.join(temporaryRoot, "runtime-evidence");
const bookOutputRoot = path.join(temporaryRoot, "book-output");
const profileRoot = path.join(temporaryRoot, "profiles");
await Promise.all([stagingDataRoot, stagingRuntimeEvidenceRoot, bookOutputRoot, profileRoot]
  .map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
await command("git", ["clone", "--quiet", "--no-checkout", repositoryRoot, runtimeRoot]);
await command("git", ["checkout", "--quiet", "--detach", productCandidateCommit], { cwd: runtimeRoot });
const runtimeConfigPath = path.join(runtimeRoot, "config/rc/local-staging.json");
const runtimeConfig = JSON.parse(await readFile(runtimeConfigPath, "utf8"));
runtimeConfig.inputs.coreLocal = productCandidateCommit;
await writeFile(runtimeConfigPath, `${JSON.stringify(runtimeConfig, null, 2)}\n`, { mode: 0o600 });

const forwardedEnvironment = {
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  TMPDIR: process.env.TMPDIR,
  LANG: process.env.LANG ?? "en_US.UTF-8",
  UNSEEN_STAGING_MODE: "local",
  UNSEEN_STAGING_HOST: "127.0.0.1",
  UNSEEN_STAGING_PORT: "0",
  UNSEEN_STAGING_DATA_DIR: stagingDataRoot,
  UNSEEN_STAGING_RUNTIME_EVIDENCE_DIR: stagingRuntimeEvidenceRoot,
  UNSEEN_BOOK_WORKTREE: bookWorktree,
  UNSEEN_BOOK_OUTPUT_DIR: bookOutputRoot,
  UNSEEN_STAGING_EXPECT_REPOSITORY_STATE: "allow_dirty"
};
const webdriverPort = await claimPort();
const bidiPort = await claimPort(new Set([webdriverPort]));
let staging;
let driver;
let bidi;
let sessionId;
let stagingReady;
let browserCapabilities;
const bidiHistory = [];
const screenshots = new Map();
let runEvidence;
let cleanupComplete = false;

const preferences = {
  "app.update.auto": false,
  "app.update.enabled": false,
  "browser.safebrowsing.downloads.enabled": false,
  "browser.safebrowsing.malware.enabled": false,
  "datareporting.policy.dataSubmissionEnabled": false,
  "datareporting.healthreport.uploadEnabled": false,
  "toolkit.telemetry.enabled": false,
  "toolkit.telemetry.unified": false,
  "network.captive-portal-service.enabled": false,
  "network.connectivity-service.enabled": false,
  "browser.newtabpage.activity-stream.feeds.telemetry": false,
  "browser.newtabpage.activity-stream.telemetry": false,
  "browser.discovery.enabled": false,
  "browser.search.update": false,
  "browser.region.network.url": "",
  "services.settings.server": "",
  "network.trr.mode": 5,
  "network.proxy.type": 1,
  "network.proxy.http": "127.0.0.1",
  "network.proxy.http_port": 9,
  "network.proxy.ssl": "127.0.0.1",
  "network.proxy.ssl_port": 9,
  "network.proxy.no_proxies_on": "localhost, 127.0.0.1"
};

async function startBrowserSession() {
  const session = await webdriver(webdriverPort, "POST", "/session", { capabilities: { alwaysMatch: {
    browserName: "firefox", webSocketUrl: true,
    "moz:firefoxOptions": { binary: firefoxBinary, args: ["-headless"], prefs: preferences }
  } } });
  sessionId = session.sessionId;
  invariant(session.capabilities.browserVersion === expected.firefoxVersion &&
    session.capabilities["moz:geckodriverVersion"] === expected.geckodriverVersion &&
    session.capabilities["moz:headless"] === true, "firefox_matrix_capabilities_invalid");
  browserCapabilities ??= session.capabilities;
  bidi = new Bidi(session.capabilities.webSocketUrl);
  await bidi.send("session.subscribe", { events: ["log.entryAdded", "network.beforeRequestSent",
    "network.responseCompleted", "network.fetchError"] });
}

async function stopBrowserSession() {
  if (!sessionId) return;
  await delay(200);
  bidiHistory.push(...(bidi?.events ?? []));
  bidi?.close();
  await webdriver(webdriverPort, "DELETE", `/session/${sessionId}`).catch(() => undefined);
  sessionId = undefined;
  bidi = undefined;
}

function browserEvents() {
  return [...bidiHistory, ...(bidi?.events ?? [])];
}

try {
  staging = spawn(process.execPath, ["infra/integration/local-staging.mjs"], {
    cwd: runtimeRoot, env: forwardedEnvironment, detached: true, stdio: ["ignore", "pipe", "pipe"]
  });
  stagingReady = await waitForReady(staging);
  const origin = stagingReady.origin;
  invariant(/^http:\/\/127\.0\.0\.1:\d+$/u.test(origin) && !origin.endsWith(":4282"),
    "firefox_matrix_isolated_origin_invalid");

  let driverStderr = "";
  driver = spawn(geckodriver,
    ["--host", "127.0.0.1", "--port", String(webdriverPort), "--websocket-port", String(bidiPort),
      "--profile-root", profileRoot, "--log", "info"],
    { env: { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: "en_US.UTF-8" },
      detached: true, stdio: ["ignore", "pipe", "pipe"] });
  driver.stderr.on("data", (bytes) => { driverStderr = `${driverStderr}${bytes}`.slice(-12_000); });
  await poll(async () => await portAcceptsConnections(webdriverPort), "geckodriver");

  await startBrowserSession();

  await navigate(webdriverPort, sessionId, `${origin}/`);
  await element(webdriverPort, sessionId, 'a[href="/login"]');
  const homeText = await evaluate(webdriverPort, sessionId, "return document.body.innerText");
  invariant(homeText.includes("测试版") && homeText.includes("照片方位由人工确认，非真实定位"),
  "firefox_matrix_fixture_disclosure_missing");
  const otpMailbox = path.join(stagingDataRoot, ".otp-mailbox.json");
  await loginOwner(webdriverPort, sessionId, origin, otpMailbox);
  const spaces = await evaluate(webdriverPort, sessionId,
    "return { title: document.title, text: document.body.innerText, readyState: document.readyState }");
  const serviceWorkers = await evaluateAsync(webdriverPort, sessionId,
    "const done=arguments[arguments.length-1]; navigator.serviceWorker.getRegistrations().then(v=>done(v.length),()=>done(-1));");
  invariant(serviceWorkers === 0, "firefox_matrix_service_worker_present");
  screenshots.set("spaces", Buffer.from(await webdriver(webdriverPort, "GET", `/session/${sessionId}/screenshot`), "base64"));

  await click(webdriverPort, sessionId, 'a[href="/spaces/new"]');
  await waitForUrl(webdriverPort, sessionId, "/spaces/new");
  await type(webdriverPort, sessionId, "#space-name", "Firefox 主链现场");
  await click(webdriverPort, sessionId, '[data-create-space-form] button[type="submit"]');
  const manageUrl = await poll(async () => {
    const value = await webdriver(webdriverPort, "GET", `/session/${sessionId}/url`);
    return /\/manage\/[^/?]+\?tab=setup$/u.test(value) ? value : null;
  }, "owner space created");
  const spaceId = new URL(manageUrl).pathname.split("/").at(-1);
  invariant(/^[A-Za-z0-9_-]+$/u.test(spaceId), "firefox_matrix_space_id_invalid");

  await click(webdriverPort, sessionId, `a[href="/manage/${spaceId}?tab=settings"]`);
  await waitForUrl(webdriverPort, sessionId, `/manage/${spaceId}?tab=settings`);
  await click(webdriverPort, sessionId, '[data-action="COLLECTION.RESUME"]');
  await waitForCondition(webdriverPort, sessionId,
    "return Boolean(document.querySelector('[data-action=\"COLLECTION.PAUSE\"]'))", "collection opened");
  await click(webdriverPort, sessionId, '[data-action="SHARING.ENABLE"]');
  await waitForCondition(webdriverPort, sessionId,
    "return Boolean(document.querySelector('[data-action=\"SHARING.DISABLE\"]'))", "sharing enabled");

  await click(webdriverPort, sessionId, `a[href="/manage/${spaceId}?tab=scene"]`);
  await waitForUrl(webdriverPort, sessionId, `/manage/${spaceId}?tab=scene`);
  await injectFileInput(webdriverPort, sessionId, "#panorama-file", "/assets/panorama/pano.jpg", "pano.jpg");
  try {
    await waitForCondition(webdriverPort, sessionId,
      "return Boolean(document.querySelector('[data-action=\"PANORAMA.SWITCH_CANDIDATE\"]'))",
      "panorama candidate ready without route reload", 30_000);
  } catch (error) {
    const state = await evaluate(webdriverPort, sessionId,
      "return {text:document.body.innerText.slice(-2000),fileCount:document.querySelector('#panorama-file')?.files?.length??-1,toast:document.querySelector('.toast')?.innerText??null}");
    throw new Error(`${error.message}:dom=${JSON.stringify(state)}`);
  }
  await click(webdriverPort, sessionId, '[data-action="PANORAMA.SWITCH_CANDIDATE"]');
  await waitForText(webdriverPort, sessionId, "可环视 · 已准备好");

  await click(webdriverPort, sessionId, `a[href="/manage/${spaceId}?tab=invitations"]`);
  await waitForUrl(webdriverPort, sessionId, `/manage/${spaceId}?tab=invitations`);
  const campaignPathname = `/v1/spaces/${spaceId}/external-invitation-campaigns`;
  const requestLogPath = path.join(stagingRuntimeEvidenceRoot, "REQUESTS.ndjson");
  const campaignOpener = "[data-open-campaign]";
  async function createCampaign(taskMode) {
    const requestLogBefore = (await requestLogEntries(requestLogPath)).filter((entry) =>
      entry.method === "POST" && entry.route === "/v1/spaces/:id/:id").length;
    const campaignCardsBefore = await evaluate(webdriverPort, sessionId,
      "return document.querySelectorAll('.campaign-card [data-copy-campaign]').length");
    const networkBefore = bidi.events.filter((event) => event.method === "network.beforeRequestSent" &&
      event.params.request.method === "POST" && new URL(event.params.request.url).pathname === campaignPathname).length;
    const database = new DatabaseSync(path.join(stagingDataRoot, "unseen.sqlite"), { readOnly: true });
    const spaceVersion = database.prepare("SELECT version FROM spaces WHERE id=?").get(spaceId)?.version;
    database.close();
    invariant(Number.isSafeInteger(spaceVersion), "firefox_matrix_campaign_space_version_missing");
    const expectedIfMatch = `"space:${spaceVersion}"`;
    const openerTabCount = await tabTo(webdriverPort, sessionId, campaignOpener);
    await pressKey(webdriverPort, sessionId, "\uE007");
    await element(webdriverPort, sessionId, '[data-dialog-confirm][data-action-id="EXTERNAL_INVITATION.CREATE"]');
    const keyboard = await confirmCampaignWithKeyboard(webdriverPort, sessionId, campaignOpener, taskMode);
    const campaignCardsAfter = await poll(async () => {
      const count = await evaluate(webdriverPort, sessionId,
        "return document.querySelectorAll('.campaign-card [data-copy-campaign]').length");
      return count === campaignCardsBefore + 1 ? count : null;
    }, `${taskMode} campaign card`);
    const requestLogAfter = await poll(async () => {
      const entries = (await requestLogEntries(requestLogPath)).filter((entry) =>
        entry.method === "POST" && entry.route === "/v1/spaces/:id/:id");
      return entries.length === requestLogBefore + 1 && entries.at(-1)?.status === 200 ? entries.length : null;
    }, `${taskMode} campaign POST request log`);
    const campaignRequest = await poll(async () => {
      const events = bidi.events.filter((event) => event.method === "network.beforeRequestSent" &&
        event.params.request.method === "POST" && new URL(event.params.request.url).pathname === campaignPathname);
      return events.length === networkBefore + 1 ? events.at(-1).params.request : null;
    }, `${taskMode} campaign POST network request`);
    const observedIfMatch = requestHeader(campaignRequest, "if-match");
    invariant(observedIfMatch === expectedIfMatch,
      `firefox_matrix_campaign_if_match_not_exact:${JSON.stringify({ expectedIfMatch, observedIfMatch })}`);
    const card = await evaluate(webdriverPort, sessionId, `return [...document.querySelectorAll('.campaign-card')]
      .map(node=>({label:node.querySelector('strong')?.innerText,path:node.querySelector('[data-copy-campaign]')?.dataset.url}))
      .find(item=>item.label===${JSON.stringify(taskMode === "view" ? "查看照片" : "查看与上传")})`);
    invariant(/^\/open\/[A-Za-z0-9_-]+$/u.test(card?.path ?? ""), "firefox_matrix_campaign_path_invalid");
    return { path: card.path, taskMode, keyboard: { ...keyboard, openerTabCount,
      requestLogCountBefore: requestLogBefore, requestLogCountAfter: requestLogAfter,
      campaignCardsBefore, campaignCardsAfter, networkRequestCountBefore: networkBefore,
      networkRequestCountAfter: networkBefore + 1, expectedIfMatch, observedIfMatch, casExact: true } };
  }
  const comboCampaign = await createCampaign("combo");
  const viewCampaign = await createCampaign("view");
  const campaignPath = comboCampaign.path;

  const ownerAccountCookie = await browserCookie(webdriverPort, sessionId, "__Host-unseen_account");
  invariant(ownerAccountCookie?.value, "firefox_matrix_owner_account_cookie_missing");
  const logoutNetworkBefore = bidi.events.filter((event) => event.method === "network.responseCompleted" &&
    event.params.request.method === "POST" && new URL(event.params.request.url).pathname === "/v1/auth/logout").length;
  await click(webdriverPort, sessionId, 'a[href="/account"]');
  await waitForUrl(webdriverPort, sessionId, "/account");
  await click(webdriverPort, sessionId, '[data-action="AUTH.LOGOUT"]');
  await waitForUrl(webdriverPort, sessionId, "/");
  const logoutResponse = await poll(async () => {
    const events = bidi.events.filter((event) => event.method === "network.responseCompleted" &&
      event.params.request.method === "POST" && new URL(event.params.request.url).pathname === "/v1/auth/logout");
    return events.length === logoutNetworkBefore + 1 ? events.at(-1).params.response : null;
  }, "logout response");
  const clearAccountCookie = "__Host-unseen_account=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0";
  invariant(Number(logoutResponse.status) === 200 && requestHeader(logoutResponse, "set-cookie") === clearAccountCookie,
    `firefox_matrix_logout_clear_cookie_invalid:${JSON.stringify(logoutResponse)}`);
  invariant(!await browserCookie(webdriverPort, sessionId, "__Host-unseen_account"),
    "firefox_matrix_logout_cookie_not_cleared");
  await restoreCookie(webdriverPort, sessionId, ownerAccountCookie);
  const staleMeBefore = bidi.events.filter((event) => event.method === "network.responseCompleted" &&
    event.params.request.method === "GET" && new URL(event.params.request.url).pathname === "/v1/me").length;
  await navigate(webdriverPort, sessionId, `${origin}/spaces`);
  const staleMeResponse = await poll(async () => {
    const events = bidi.events.filter((event) => event.method === "network.responseCompleted" &&
      event.params.request.method === "GET" && new URL(event.params.request.url).pathname === "/v1/me");
    return events.length > staleMeBefore ? events.at(-1).params.response : null;
  }, "stale account real UI response");
  invariant(Number(staleMeResponse.status) === 401 && requestHeader(staleMeResponse, "set-cookie") === clearAccountCookie &&
    !await browserCookie(webdriverPort, sessionId, "__Host-unseen_account"),
  `firefox_matrix_stale_account_clear_cookie_invalid:${JSON.stringify(staleMeResponse)}`);
  const participantAccountBoundary = await evaluate(webdriverPort, sessionId,
    "return !document.body.innerText.includes('我的空间')&&Boolean(document.querySelector('[data-phase=session_or_permission_loss]'))");
  invariant(participantAccountBoundary, "firefox_matrix_participant_account_boundary_missing");

  const viewerPathname = `/v1/viewer/spaces/${spaceId}`;
  const uploadContextPathname = `/v1/spaces/${spaceId}/upload-context`;
  await navigate(webdriverPort, sessionId, `${origin}${campaignPath}`);
  await click(webdriverPort, sessionId, "[data-admit-campaign]");
  await waitForCondition(webdriverPort, sessionId,
    `return location.pathname.startsWith('/s/${spaceId}/')`, "participant admitted");
  const comboCookies = await browserCookies(webdriverPort, sessionId);
  const comboCookieNames = comboCookies.map((cookie) => cookie.name);
  invariant(comboCookieNames.includes("__Host-unseen_viewer") && comboCookieNames.includes("__Host-unseen_contributor"),
    `firefox_matrix_combo_cookies_missing:${JSON.stringify(comboCookieNames)}`);
  const viewerResponse = await poll(async () => bidi.events.findLast((event) =>
    event.method === "network.responseCompleted" && event.params.request.method === "GET" &&
    new URL(event.params.request.url).pathname === viewerPathname)?.params.response, "combo viewerSpace response");
  invariant(Number(viewerResponse.status) === 200, "firefox_matrix_combo_viewer_space_not_200");
  const uploadNavVisible = await waitForCondition(webdriverPort, sessionId,
    `return (()=>{const node=document.querySelector('a[href="/s/${spaceId}/upload"]');if(!node)return false;
      const rect=node.getBoundingClientRect(),style=getComputedStyle(node);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden'})()`,
  "visible combo upload navigation");
  await click(webdriverPort, sessionId, `a[href="/s/${spaceId}/upload"]`);
  await waitForUrl(webdriverPort, sessionId, `/s/${spaceId}/upload`);
  const uploadContextResponse = await poll(async () => bidi.events.findLast((event) =>
    event.method === "network.responseCompleted" && event.params.request.method === "GET" &&
    new URL(event.params.request.url).pathname === uploadContextPathname)?.params.response, "combo uploadContext response");
  invariant(Number(uploadContextResponse.status) === 200 && await evaluate(webdriverPort, sessionId,
    `return Boolean(document.querySelector('a[href="/s/${spaceId}/upload"]'))`),
  "firefox_matrix_combo_upload_context_or_capability_invalid");
  await click(webdriverPort, sessionId, "[data-notice-check]");
  await click(webdriverPort, sessionId, '[data-action="UPLOAD.ACCEPT_NOTICE"]');
  await element(webdriverPort, sessionId, "#photo-files");
  await injectFileInput(webdriverPort, sessionId, "#photo-files", "/assets/photos/photo-1.jpg", "photo-1.jpg");
  await element(webdriverPort, sessionId, '[data-action="UPLOAD.FINALIZE_BATCH"]');
  await waitForCondition(webdriverPort, sessionId,
    "return Boolean(document.querySelector('[data-action=\"UPLOAD.FINALIZE_BATCH\"]')?.dataset.itemsDigest)&&!document.querySelector('[data-action=\"UPLOAD.FINALIZE_BATCH\"]')?.disabled",
  "finalize control ready");
  const batchId = await attribute(webdriverPort, sessionId, '[data-action="UPLOAD.FINALIZE_BATCH"]', "data-batch-id");
  invariant(/^[A-Za-z0-9_-]+$/u.test(batchId), "firefox_matrix_batch_id_invalid");
  await click(webdriverPort, sessionId, '[data-action="UPLOAD.FINALIZE_BATCH"]');
  await waitForUrl(webdriverPort, sessionId, `/uploads/${batchId}`);
  await waitForText(webdriverPort, sessionId, "本次上传结果");
  for (let attempt = 0; attempt < 30 && !await evaluate(webdriverPort, sessionId,
    "return document.body.innerText.includes('已上传并定位')"); attempt += 1) {
    await delay(500);
    await navigate(webdriverPort, sessionId, `${origin}/uploads/${batchId}`);
  }
  let manualPlacementConfirmation = false;
  if (!await evaluate(webdriverPort, sessionId, "return document.body.innerText.includes('已上传并定位')")) {
    const itemId = await attribute(webdriverPort, sessionId, "a[data-queue-item]", "data-queue-item");
    invariant(/^[A-Za-z0-9_-]+$/u.test(itemId), "firefox_matrix_item_id_invalid");
    await click(webdriverPort, sessionId, `a[data-queue-item="${itemId}"]`);
    await waitForUrl(webdriverPort, sessionId, `/uploads/${batchId}/items/${itemId}`);
    await click(webdriverPort, sessionId, 'a[href^="/placements/"]');
    await element(webdriverPort, sessionId, "[data-viewer-root] canvas");
    await click(webdriverPort, sessionId, "[data-viewer-root] canvas");
    await pressKey(webdriverPort, sessionId, "\uE014");
    await waitForCondition(webdriverPort, sessionId,
      "return location.pathname.startsWith('/placements/')&&document.querySelector('[data-placement-form]')?.dataset.poseReady==='true'&&!document.querySelector('[data-placement-form] button[type=submit]')?.disabled",
    "placement pose ready");
    await click(webdriverPort, sessionId, '[data-placement-form] button[type="submit"]');
    await delay(300);
    await navigate(webdriverPort, sessionId, `${origin}/uploads/${batchId}`);
    await waitForText(webdriverPort, sessionId, "已上传并定位");
    manualPlacementConfirmation = true;
  }
  screenshots.set("upload-result",
    Buffer.from(await webdriver(webdriverPort, "GET", `/session/${sessionId}/screenshot`), "base64"));

  await navigate(webdriverPort, sessionId, `${origin}/manage/${spaceId}?tab=review`);
  const participantManagementBoundary = await evaluate(webdriverPort, sessionId,
    "return !document.body.innerText.includes('照片审核')&&Boolean(document.querySelector('[data-phase=session_or_permission_loss]'))");
  invariant(participantManagementBoundary, "firefox_matrix_participant_management_boundary_missing");
  await clearBrowserSiteData(webdriverPort, sessionId);
  await stopBrowserSession();
  await startBrowserSession();
  await loginOwner(webdriverPort, sessionId, origin, otpMailbox);
  await navigate(webdriverPort, sessionId, `${origin}/manage/${spaceId}?tab=review`);
  await waitForText(webdriverPort, sessionId, "照片审核");
  await element(webdriverPort, sessionId, '[data-queue-item] [data-action="CONTENT.APPROVE"]');
  screenshots.set("owner-review",
    Buffer.from(await webdriver(webdriverPort, "GET", `/session/${sessionId}/screenshot`), "base64"));
  const photoId = await attribute(webdriverPort, sessionId, "[data-queue-item]", "data-queue-item");
  invariant(/^[A-Za-z0-9_-]+$/u.test(photoId), "firefox_matrix_photo_id_invalid");
  await click(webdriverPort, sessionId, `[data-queue-item="${photoId}"] [data-action="CONTENT.APPROVE"]`);
  await waitForCondition(webdriverPort, sessionId,
    `return !document.querySelector('[data-queue-item="${photoId}"]')`, "owner approved photo");

  await navigate(webdriverPort, sessionId, `${origin}/s/${spaceId}/scene?photo=${photoId}`);
  await waitForCondition(webdriverPort, sessionId,
    `return Boolean(document.querySelector('[data-viewer-root] canvas,.unseen-viewer__fallback'))&&Boolean(document.querySelector('.viewer-photo-button[data-photo-id="${photoId}"]'))`,
  "approved photo in Viewer");
  await click(webdriverPort, sessionId, `.viewer-photo-button[data-photo-id="${photoId}"]`);
  await waitForCondition(webdriverPort, sessionId,
    "return Boolean(document.querySelector('[data-viewer-root] button[data-action=return]:not([hidden])'))&&document.activeElement?.matches('[data-viewer-root] canvas')",
  "Viewer focus completed");
  await click(webdriverPort, sessionId, "[data-viewer-root] button[data-action=return]");
  await waitForCondition(webdriverPort, sessionId,
    `return location.pathname==='/s/${spaceId}/album'&&new URLSearchParams(location.search).get('focus')==='${photoId}'`,
  "Viewer return to focused album photo");
  invariant(await evaluate(webdriverPort, sessionId,
    `return document.activeElement?.closest('[data-photo-card]')?.dataset.photoCard==='${photoId}'`),
  "firefox_matrix_viewer_return_focus_missing");

  await clearBrowserSiteData(webdriverPort, sessionId);
  await stopBrowserSession();
  await startBrowserSession();
  await navigate(webdriverPort, sessionId, `${origin}${viewCampaign.path}`);
  await click(webdriverPort, sessionId, "[data-admit-campaign]");
  await waitForCondition(webdriverPort, sessionId,
    `return location.pathname.startsWith('/s/${spaceId}/')`, "view-only participant admitted");
  const viewOnlyCookies = await browserCookies(webdriverPort, sessionId);
  const viewOnlyCookieNames = viewOnlyCookies.map((cookie) => cookie.name);
  invariant(viewOnlyCookieNames.includes("__Host-unseen_viewer") &&
    !viewOnlyCookieNames.includes("__Host-unseen_contributor") &&
    !await evaluate(webdriverPort, sessionId, `return Boolean(document.querySelector('a[href="/s/${spaceId}/upload"]'))`),
  `firefox_matrix_view_only_upload_boundary_failed:${JSON.stringify(viewOnlyCookieNames)}`);
  const viewOnlyViewerResponse = await poll(async () => bidi.events.findLast((event) =>
    event.method === "network.responseCompleted" && event.params.request.method === "GET" &&
    new URL(event.params.request.url).pathname === viewerPathname)?.params.response, "view-only viewerSpace response");
  invariant(Number(viewOnlyViewerResponse.status) === 200, "firefox_matrix_view_only_viewer_space_not_200");
  await clearBrowserSiteData(webdriverPort, sessionId);
  await stopBrowserSession();
  await startBrowserSession();
  await navigate(webdriverPort, sessionId, `${origin}${campaignPath}`);
  await click(webdriverPort, sessionId, "[data-admit-campaign]");
  await waitForCondition(webdriverPort, sessionId,
    `return location.pathname.startsWith('/s/${spaceId}/')`, "participant re-admitted after clear");
  await navigate(webdriverPort, sessionId, `${origin}/s/${spaceId}/scene?photo=${photoId}`);
  await waitForCondition(webdriverPort, sessionId,
    `return Boolean(document.querySelector('[data-viewer-root] canvas,.unseen-viewer__fallback'))&&Boolean(document.querySelector('.viewer-photo-button[data-photo-id="${photoId}"]'))`,
  "persisted photo in reopened Viewer");
  screenshots.set("viewer-reopen",
    Buffer.from(await webdriver(webdriverPort, "GET", `/session/${sessionId}/screenshot`), "base64"));

  await delay(500);
  const allBrowserEvents = browserEvents();
  const consoleErrors = allBrowserEvents.filter((event) => event.method === "log.entryAdded" &&
    ["error", "critical"].includes(event.params.entry.level));
  const beforeRequests = allBrowserEvents.filter((event) => event.method === "network.beforeRequestSent");
  const responseErrors = allBrowserEvents.filter((event) => event.method === "network.responseCompleted" &&
    Number(event.params.response.status) >= 400);
  const rawFetchErrors = allBrowserEvents.filter((event) => event.method === "network.fetchError");
  const expectedNavigationAborts = rawFetchErrors.filter((event) =>
    event.params.errorText === "NS_BINDING_ABORTED");
  const fetchErrors = rawFetchErrors.filter((event) => !expectedNavigationAborts.includes(event));
  const externalRequests = beforeRequests.filter((event) => {
    const url = event.params.request.url;
    return /^https?:/u.test(url) && new URL(url).origin !== origin;
  });
  const expectedBoundaryPaths = new Set(["/v1/me", "/v1/me/spaces", "/v1/me/owner-transfers",
    `/v1/spaces/${spaceId}/management`]);
  const expectedAuthorizationDenials = responseErrors.filter((event) =>
    [401, 403].includes(Number(event.params.response.status)) &&
    expectedBoundaryPaths.has(new URL(event.params.response.url).pathname));
  const unexpectedResponseErrors = responseErrors.filter((event) => !expectedAuthorizationDenials.includes(event));
  invariant(consoleErrors.length === 0, `firefox_matrix_console_errors:${JSON.stringify(consoleErrors)}`);
  invariant(expectedAuthorizationDenials.length >= 4,
    `firefox_matrix_expected_authorization_denials_missing:${JSON.stringify(responseErrors)}`);
  invariant(unexpectedResponseErrors.length === 0,
    `firefox_matrix_unexpected_http_errors:${JSON.stringify(unexpectedResponseErrors)}`);
  invariant(fetchErrors.length === 0, `firefox_matrix_fetch_errors:${JSON.stringify(fetchErrors)}`);
  invariant(externalRequests.length === 0, `firefox_matrix_external_requests:${JSON.stringify(externalRequests)}`);

  const metaResponse = await fetch(`${origin}/__staging/meta`, { cache: "no-store" });
  const meta = await metaResponse.json();
  invariant(metaResponse.ok && meta.listener === "loopback_only" && meta.externalExposure === false &&
    meta.cloudWrites === 0 && meta.inputs.bookWeb === expected.bookCommit,
  "firefox_matrix_staging_meta_invalid");
  const [macVersion, macBuild, macModel] = await Promise.all([
    command("sw_vers", ["-productVersion"]), command("sw_vers", ["-buildVersion"]),
    command("sysctl", ["-n", "hw.model"])
  ]);
  const runnerSha256 = await digest(fileURLToPath(import.meta.url), "sha256");
  runEvidence = {
    schema: "unseen-stage-rc-firefox-macos/2",
    status: "NAMED_BROWSER_CORE_MAIN_CHAIN_PASS_NOT_COMPLETE_MATRIX",
    generatedAt: new Date().toISOString(),
    claimBoundary: {
      macosFirefoxNamedPath: true,
      representativeCoreMainChain: true,
      currentCandidateCoverage: productCandidateCommit === "09076727051411eeb9274a26663f6ccd168378c3",
      currentCandidate: productCandidateCommit,
      completeFiveActorMatrix: false,
      remainingNamedDeviceBrowserMatrix: true,
      fixedCoreRc: false,
      coreR0: false,
      productionReady: false,
      liveStaging4282Accessed: false,
      liveStaging4180Accessed: false,
      releaseDecision: "NO_GO_PENDING_EXTERNAL_RELEASE_INPUTS_AND_FULL_R0",
      externalExposure: false,
      cloudWrites: 0
    },
    candidate: { productCommit: productCandidateCommit, harnessCommit: head,
      productPathsUnchangedFromCandidate: true, bookInput: bookHead, bookInputClean: true,
      runner: "tests/e2e/stage-rc-firefox.e2e.mjs", runnerSha256 },
    platform: {
      os: "macOS", version: macVersion.stdout.trim(), build: macBuild.stdout.trim(),
      hardwareModel: macModel.stdout.trim(), architecture: process.arch
    },
    browser: {
      name: "Mozilla Firefox", version: browserCapabilities.browserVersion,
      buildId: browserCapabilities["moz:buildID"], headless: browserCapabilities["moz:headless"],
      userAgent: await evaluate(webdriverPort, sessionId, "return navigator.userAgent")
    },
    tooling: {
      credentialsForwarded: [],
      nativeFileChooserAutomation: false,
      fileInputInjectedViaDom: true,
      firefox: {
        source: firefoxSource, archiveSha512: firefoxSha512, version: firefoxVersion,
        bundleVersion: firefoxBundleVersion, signingTeam: "43AQ936H96", codesignStrict: true, notarized: true
      },
      geckodriver: {
        source: geckodriverSource, archiveSha256: geckodriverSha256,
        version: expected.geckodriverVersion, signingTeam: "43AQ936H96", codesignStrict: true
      }
    },
    runtime: { origin: "dynamic_loopback_redacted", listener: meta.listener, externalExposure: false,
      providers: meta.providers, cloudWrites: meta.cloudWrites },
    userPath: [
      "open current Core home in official stable Firefox",
      "verify deterministic local locator fixture disclosures",
      "owner login through the real email and isolated local OTP forms",
      "owner create Space through the visible UI",
      "owner open collection and sharing through visible management controls",
      "owner upload and switch deterministic local panorama through the visible file/control path",
      "owner create a combo invitation through the visible dialog",
      "owner logout and anonymous participant account-space access fails closed",
      "participant enter through the visible public invitation control",
      "participant accept the visible media notice, upload one real local JPEG and finalize through visible controls",
      "participant management access fails closed",
      "owner login again, review and approve through the visible queue",
      "approved photo opens in Viewer and returns visibly to album",
      "clear cookies/site data, re-enter invitation and reopen the persisted photo in Viewer"
    ],
    browserExecutedCanonicalApi: [],
    automationBoundary: {
      nativeFileChooserAutomation: false,
      fileInputInjectedViaDom: true,
      detail: "The real #panorama-file and #photo-files inputs receive same-origin bytes as File objects through DataTransfer and dispatch bubbling change; existing UI handlers perform upload/commit.",
      classification: "ACCEPTED_AUTOMATION_BOUNDARY_NOT_A_NATIVE_PICKER_CLAIM",
      remainingP1: null
    },
    result: {
      finalRoute: `/s/:space/scene?photo=:photo`, initialAccountTitle: spaces.title,
      fixtureDisclosure: true, collectionOpened: true, sharingEnabled: true,
      deterministicPanoramaReady: true, deterministicHighPlacement: !manualPlacementConfirmation,
      manualPlacementConfirmation,
      panoramaRouteReloadUsed: false, campaignDialogKeyboard: comboCampaign.keyboard,
      viewOnlyCampaignDialogKeyboard: viewCampaign.keyboard,
      logoutAndStaleAccountCookie: {
        logoutStatus: Number(logoutResponse.status), logoutSetCookieExact: true,
        restoredRevokedCookieToModelLostClearDelivery: true,
        staleReadStatus: Number(staleMeResponse.status), staleReadSetCookieExact: true,
        accountCookieAbsentAfterStaleResponse: true
      },
      comboParticipant: {
        viewerCookie: true, contributorCookie: true, viewerSpaceStatus: Number(viewerResponse.status),
        uploadContextStatus: Number(uploadContextResponse.status), effectiveCanUpload: true,
        visibleUploadNavigation: Boolean(uploadNavVisible)
      },
      viewOnlyCounterexample: {
        viewerCookie: true, contributorCookie: false, viewerSpaceStatus: Number(viewOnlyViewerResponse.status),
        visibleUploadNavigation: false
      },
      participantAccountBoundary, participantManagementBoundary,
      participantUploadCommitted: true, ownerReviewApproved: true,
      ownerReviewIndependentBrowserContext: true,
      viewerFocusAndReturnToAlbumWithRestoredPhotoFocus: true,
      siteDataClearedAndPersistedViewerReopenedInNewBrowserContext: true,
      serviceWorkerRegistrations: serviceWorkers,
      screenshots: Object.fromEntries(Object.entries(screenshotPaths)
        .map(([name, target]) => [name, path.relative(repositoryRoot, target)]))
    },
    diagnostics: {
      consoleErrors: consoleErrors.length, unexpectedHttpErrors: unexpectedResponseErrors.length,
      expectedAuthorizationDenials: expectedAuthorizationDenials.map((event) => ({
        status: Number(event.params.response.status), path: new URL(event.params.response.url).pathname
      })),
      expectedNavigationAborts: expectedNavigationAborts.length,
      failedRequests: fetchErrors.length, externalRequests: externalRequests.length,
      browserNetworkRequests: beforeRequests.length
    },
    cleanup: { webdriverSessionDeleted: false, processGroupsStopped: false, temporaryStateRemoved: false,
      webdriverPortClosed: false, bidiPortClosed: false }
  };
} finally {
  let cleanupError;
  try {
    await stopBrowserSession();
    await Promise.all([terminateProcessGroup(driver), terminateProcessGroup(staging)]);
    invariant(!await portAcceptsConnections(webdriverPort), "firefox_matrix_webdriver_port_still_open");
    invariant(!await portAcceptsConnections(bidiPort), "firefox_matrix_bidi_port_still_open");
    await rm(temporaryRoot, { recursive: true, force: true });
    cleanupComplete = true;
  } catch (error) {
    cleanupError = error;
  }
  if (cleanupError) throw cleanupError;
}

invariant(runEvidence && screenshots.size === Object.keys(screenshotPaths).length && cleanupComplete,
  "firefox_matrix_run_incomplete");
runEvidence.cleanup = { webdriverSessionDeleted: true, processGroupsStopped: true, temporaryStateRemoved: true,
  webdriverPortClosed: true, bidiPortClosed: true };
await mkdir(path.dirname(screenshotPaths.spaces), { recursive: true });
for (const [name, bytes] of screenshots) await writeFile(screenshotPaths[name], bytes, { mode: 0o600 });
await writeFile(evidencePath, `${JSON.stringify(runEvidence, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ status: runEvidence.status, evidence: path.relative(repositoryRoot, evidencePath),
  screenshots: Object.values(screenshotPaths).map((target) => path.relative(repositoryRoot, target)),
  diagnostics: runEvidence.diagnostics,
  cleanup: runEvidence.cleanup }, null, 2)}\n`);
