import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

process.umask(0o077);
const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const candidate = "b4651c997a4411fb35271d7025321455ed3d674f";
const evidenceFile = path.join(root,
  "release-evidence/local-operable/stage-rc/CHROME-PERF-A11Y-PREFLIGHT.json");
const chromeApp = "/Applications/Google Chrome.app";
const chromeBin = path.join(chromeApp, "Contents/MacOS/Google Chrome");
const profile = Object.freeze({ downloadBitsPerSecond: 25_000_000, uploadBitsPerSecond: 25_000_000,
  latencyMs: 0, cpuSlowdownMultiplier: 1, cacheDisabled: true, samples: 3 });

const invariant = (value, message) => { if (!value) throw new Error(message); };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function command(file, args, options = {}) {
  return exec(file, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 30_000, ...options });
}
async function capture(file, args) {
  try { const value = await command(file, args); return { ok: true, stdout: value.stdout, stderr: value.stderr }; }
  catch (error) { return { ok: false, stdout: error.stdout ?? "", stderr: error.stderr ?? String(error) }; }
}
async function poll(run, label, timeout = 20_000) {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) {
    try { const value = await run(); if (value) return value; } catch (error) { last = error; }
    await delay(75);
  }
  throw new Error(`chrome_preflight_timeout:${label}`, { cause: last });
}
async function stop(child) {
  if (!child?.pid || child.exitCode !== null) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  if (!await Promise.race([new Promise((resolve) => child.once("exit", () => resolve(true))), delay(3_000).then(() => false)])) {
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}
function stagingReady(child) {
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "";
    const timer = setTimeout(() => reject(new Error(`chrome_preflight_staging_timeout:${stderr}`)), 30_000);
    child.stdout.on("data", (bytes) => {
      stdout += bytes;
      const lines = stdout.split("\n"); stdout = lines.pop();
      for (const line of lines) try {
        const value = JSON.parse(line);
        if (value.status === "LOCAL_STAGING_READY") { clearTimeout(timer); resolve(value); }
      } catch {}
    });
    child.stderr.on("data", (bytes) => { stderr = `${stderr}${bytes}`.slice(-4_000); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`chrome_preflight_staging_exit:${code}:${stderr}`)); });
  });
}

class Cdp {
  constructor(url) {
    this.id = 0; this.pending = new Map(); this.listeners = new Map(); this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(String(data));
      if (message.id) {
        const pending = this.pending.get(message.id); if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
      } else for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
    });
  }
  async send(method, params = {}) {
    await this.ready; const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`cdp_timeout:${method}`)); }, 30_000);
      this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, listener) { this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener]); }
  once(method) { return new Promise((resolve) => {
    const listener = (value) => { this.listeners.set(method,
      (this.listeners.get(method) ?? []).filter((item) => item !== listener)); resolve(value); };
    this.on(method, listener);
  }); }
  close() { this.socket.close(); }
}

async function evaluate(cdp, expression) {
  const value = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true,
    returnByValue: true, userGesture: true });
  if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text);
  return value.result.value;
}
async function navigate(cdp, origin, route) {
  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url: `${origin}${route}` });
  await Promise.race([loaded, delay(30_000).then(() => { throw new Error(`load_timeout:${route}`); })]);
  await poll(() => evaluate(cdp,
    "Boolean(document.querySelector('#main'))&&!document.querySelector('[data-phase=loading]')"), route);
}
const observer = `(()=>{const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'};
globalThis.__preflight={firstUsableMs:null,lcp:null};const check=()=>{const main=document.querySelector('#main'),heading=main?.querySelector('h1,h2'),action=main?.querySelector('a[href],button,input,select,textarea');
const name=action&&(action.getAttribute('aria-label')||action.innerText||action.value||action.labels?.[0]?.innerText||'').trim();if(globalThis.__preflight.firstUsableMs===null&&visible(main)&&visible(heading)&&visible(action)&&name&&!main.querySelector('[data-phase=loading]'))globalThis.__preflight.firstUsableMs=performance.now()};
new MutationObserver(check).observe(document,{subtree:true,childList:true,attributes:true});try{new PerformanceObserver(list=>{for(const e of list.getEntries())globalThis.__preflight.lcp=e.toJSON()}).observe({type:'largest-contentful-paint',buffered:true})}catch{}addEventListener('DOMContentLoaded',check);requestAnimationFrame(check)})();`;

async function sample(cdp, origin, route) {
  await cdp.send("Network.clearBrowserCache");
  const loaded = cdp.once("Page.loadEventFired"); await cdp.send("Page.navigate", { url: `${origin}${route}` });
  await Promise.race([loaded, delay(30_000).then(() => { throw new Error(`perf_load_timeout:${route}`); })]);
  await poll(() => evaluate(cdp, "globalThis.__preflight?.firstUsableMs||null"), `first_usable:${route}`);
  await delay(250);
  return evaluate(cdp, `(()=>{const n=performance.getEntriesByType('navigation')[0],p=Object.fromEntries(performance.getEntriesByType('paint').map(e=>[e.name,e.startTime])),phase=document.querySelector('[data-phase]')?.dataset.phase??null;
return {route:location.pathname,title:document.title,phase,firstUsableMs:globalThis.__preflight.firstUsableMs,lcp:globalThis.__preflight.lcp,paint:p,navigation:n?.toJSON()??null}})()`);
}
const p75 = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .75) - 1];

async function login(cdp, origin, mailbox) {
  let prior = ""; try { prior = JSON.parse(await readFile(mailbox, "utf8")).challengeId ?? ""; } catch {}
  await navigate(cdp, origin, "/login");
  await evaluate(cdp, `(()=>{const e=document.querySelector('#email');e.value='chrome-preflight-owner@example.test';e.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-login-form]').requestSubmit();return true})()`);
  await poll(() => evaluate(cdp, "Boolean(document.querySelector('#code'))"), "OTP input");
  const otp = await poll(async () => { try { const value = JSON.parse(await readFile(mailbox, "utf8"));
    return value.challengeId !== prior && /^\d{6}$/u.test(value.code) ? value.code : null; } catch { return null; } }, "OTP mailbox");
  await evaluate(cdp, `(()=>{const e=document.querySelector('#code');e.value=${JSON.stringify(otp)};e.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-login-form]').requestSubmit();return true})()`);
  await poll(() => evaluate(cdp, "location.pathname==='/spaces'&&document.body.innerText.includes('我的空间')"), "authenticated spaces");
  return { method: "real Web login form + isolated local OTP", accountTextPresent: true };
}

const auditScript = `(()=>{const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return !el.closest('[hidden],[inert]')&&!el.matches('.sr-only')&&r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'};
const rgba=v=>{const n=(v.match(/[\\d.]+/g)||[]).map(Number);return n.length>=3?{r:n[0],g:n[1],b:n[2],a:n[3]??1}:null},blend=(f,b)=>({r:f.r*f.a+b.r*(1-f.a),g:f.g*f.a+b.g*(1-f.a),b:f.b*f.a+b.b*(1-f.a),a:1});
const bg=el=>{let node=el,color={r:255,g:255,b:255,a:1},image=false,pseudo=false,stack=[];while(node){const s=getComputedStyle(node);if(s.backgroundImage!=='none')image=true;const c=rgba(s.backgroundColor);if(c&&c.a>0)stack.push(c);for(const selector of ['::before','::after']){const p=getComputedStyle(node,selector),pc=rgba(p.backgroundColor);if(p.backgroundImage!=='none'||(p.content!=='none'&&pc&&pc.a>0)){image=true;pseudo=true}}node=node.parentElement}for(const c of stack.reverse())color=blend(c,color);return{color,image,pseudo}};
const lum=c=>{const f=v=>(v/=255)<=.04045?v/12.92:((v+.055)/1.055)**2.4;return .2126*f(c.r)+.7152*f(c.g)+.0722*f(c.b)},ratio=(a,b)=>(Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05),name=el=>(el.getAttribute('aria-label')||el.getAttribute('title')||el.innerText||el.value||el.labels?.[0]?.innerText||'').trim().slice(0,80);
const skippedTextReasons=[];const text=[];for(const el of [...document.querySelectorAll('body *')].filter(visible)){if(![...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()))continue;const b=bg(el);if(b.image){skippedTextReasons.push({tag:el.tagName,name:name(el),reason:b.pseudo?'pseudo-element gradient/image/background':'ancestor gradient/image'});continue}const s=getComputedStyle(el),f=rgba(s.color);if(!f)continue;const large=parseFloat(s.fontSize)>=24||(parseFloat(s.fontSize)>=18.66&&(Number(s.fontWeight)||400)>=700),value=ratio(blend(f,b.color),b.color),required=large?3:4.5;text.push({tag:el.tagName,name:name(el),ratio:+value.toFixed(2),required,pass:value>=required})}
const skippedControlReasons=[];const controls=[];for(const el of [...document.querySelectorAll('button,input:not([type=hidden]),select,textarea')].filter(visible)){const own=bg(el),around=bg(el.parentElement||document.body);if(own.image||around.image){skippedControlReasons.push({tag:el.tagName,name:name(el),reason:own.pseudo||around.pseudo?'pseudo-element gradient/image/background':'ancestor gradient/image'});continue}const border=rgba(getComputedStyle(el).borderColor),value=Math.max(ratio(own.color,around.color),border?ratio(border,around.color):1);controls.push({tag:el.tagName,name:name(el),ratio:+value.toFixed(2),required:3,pass:value>=3})}
const ids=[...document.querySelectorAll('[id]')].map(e=>e.id),headings=[...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(visible).map(e=>({level:+e.tagName[1],name:name(e)})),focusables=[...document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,summary,[tabindex]:not([tabindex="-1"])')].filter(visible).filter(e=>!e.disabled).map(e=>({tag:e.tagName,name:name(e)}));
return{route:location.pathname,title:document.title,phase:document.querySelector('[data-phase]')?.dataset.phase??null,landmarks:{main:document.querySelectorAll('main').length,header:document.querySelectorAll('header').length,nav:document.querySelectorAll('nav').length},headings,headingSkip:headings.some((h,i)=>i&&h.level>headings[i-1].level+1),duplicateIds:[...new Set(ids.filter((id,i)=>ids.indexOf(id)!==i))],unlabeledForms:[...document.querySelectorAll('input:not([type=hidden]),select,textarea')].filter(visible).filter(e=>!(e.labels?.length||e.getAttribute('aria-label')||e.getAttribute('aria-labelledby'))).map(e=>({tag:e.tagName,id:e.id})),unnamedButtons:[...document.querySelectorAll('button')].filter(visible).filter(e=>!name(e)).map(e=>e.className),textContrast:text,controlContrast:controls,skippedText:skippedTextReasons.length,skippedControl:skippedControlReasons.length,skippedTextReasons,skippedControlReasons,focusables}})()`;

async function a11y(cdp, origin, route, expected) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
  await cdp.send("Emulation.setEmulatedMedia", { features: [] }); await navigate(cdp, origin, route);
  const automated = await evaluate(cdp, auditScript);
  invariant(automated.route === expected.route && automated.title === expected.title && automated.phase === expected.phase,
    `route_lock_failed:${route}`);
  await evaluate(cdp, "document.body.tabIndex=-1;document.body.focus();true");
  const keyboard = [];
  for (let i = 0; i < Math.min(10, automated.focusables.length); i += 1) {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    const item = await evaluate(cdp, `(()=>{const e=document.activeElement,s=getComputedStyle(e),r=e.getBoundingClientRect(),name=(e.getAttribute('aria-label')||e.getAttribute('title')||e.innerText||e.value||e.labels?.[0]?.innerText||'').trim().slice(0,80);return{tag:e.tagName,name,visible:r.width>0&&r.height>0,focusVisible:(s.outlineStyle!=='none'&&parseFloat(s.outlineWidth)>0)||s.boxShadow!=='none'}})()`);
    keyboard.push(item); if (keyboard.slice(0, -1).some((value) => value.tag === item.tag && value.name === item.name)) break;
  }
  const expectedPrefix = automated.focusables.slice(0, keyboard.length);
  const keyboardResult = { expectedPrefix, actual: keyboard,
    orderPass: JSON.stringify(expectedPrefix.map(({ tag, name }) => ({ tag, name }))) ===
      JSON.stringify(keyboard.map(({ tag, name }) => ({ tag, name }))),
    visibleNamedPass: keyboard.length === Math.min(10, automated.focusables.length) && keyboard.every((item) => item.visible && item.name),
    visibleFocusPass: keyboard.length === Math.min(10, automated.focusables.length) && keyboard.every((item) => item.focusVisible) };
  const ax = await cdp.send("Accessibility.getFullAXTree");
  const axUnnamed = ax.nodes.filter((node) => ["button", "link", "textbox", "combobox", "checkbox", "radio"]
    .includes(node.role?.value) && !node.ignored && !node.name?.value).map((node) => node.role.value);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 }); await navigate(cdp, origin, route);
  const reflow200 = await evaluate(cdp, `({clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,pass:document.documentElement.scrollWidth<=document.documentElement.clientWidth})`);
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await navigate(cdp, origin, route);
  const reducedMotion = await evaluate(cdp, `(()=>{const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'},ms=v=>Math.max(0,...v.split(',').map(x=>x.trim().endsWith('ms')?parseFloat(x):parseFloat(x)*1000||0));const all=[...document.querySelectorAll('body *')].filter(visible).map(e=>{const s=getComputedStyle(e);return{tag:e.tagName,name:(e.getAttribute('aria-label')||e.innerText||'').trim().slice(0,60),animationName:s.animationName,animationMs:ms(s.animationDuration),iteration:s.animationIterationCount,transition:s.transitionProperty.split(',').map(x=>x.trim()),transitionMs:ms(s.transitionDuration)}}),offenders=all.filter(x=>(x.animationName!=='none'&&x.animationMs>.01)||x.transitionMs>120||(x.transitionMs>.01&&x.transition.some(p=>['transform','translate','scale','rotate','all'].includes(p))));return{rule:'opacity transitions <=120ms allowed; animation/continuous/scale/parallax/auto-pan rejected',offenders,pass:offenders.length===0}})()`);
  await cdp.send("Emulation.setEmulatedMedia", { features: [] }); await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
  const checks = { landmarks: automated.landmarks.main === 1 && automated.landmarks.header >= 1,
    headings: automated.headings.length > 0 && !automated.headingSkip, formLabels: automated.unlabeledForms.length === 0,
    buttonNames: automated.unnamedButtons.length === 0 && axUnnamed.length === 0, duplicateIds: automated.duplicateIds.length === 0,
    textContrast: automated.textContrast.some((item) => !item.pass) ? false :
      automated.skippedText ? "INDETERMINATE" : true,
    controlContrast: automated.controlContrast.some((item) => !item.pass) ? false :
      automated.skippedControl ? "INDETERMINATE" : true,
    keyboardOrder: keyboardResult.orderPass && keyboardResult.visibleNamedPass, visibleFocus: keyboardResult.visibleFocusPass,
    reflow200: reflow200.pass, reducedMotion: reducedMotion.pass };
  return { route, lock: expected, automated, keyboard: keyboardResult, axUnnamed, reflow200, reducedMotion, checks };
}

const temporary = await mkdtemp(path.join(tmpdir(), "unseen-chrome-preflight-"));
const config = JSON.parse(await readFile(path.join(root, "config/rc/local-staging.json"), "utf8"));
const directories = Object.fromEntries(["book", "data", "runtime", "output", "chrome"]
  .map((name) => [name, path.join(temporary, name)]));
await Promise.all(Object.values(directories).map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
let staging, chrome, cdp, report;
try {
  const head = (await command("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  await command("git", ["merge-base", "--is-ancestor", candidate, head], { cwd: root });
  await command("git", ["diff", "--quiet", candidate, "--", "apps/web", "services/api", "packages/viewer",
    "infra/integration/local-staging.mjs", "infra/integration/local-operable.mjs", "config/rc/local-staging.json"], { cwd: root });
  await command("git", ["clone", "--quiet", "--no-checkout", root, directories.book]);
  await command("git", ["checkout", "--quiet", "--detach", config.inputs.bookWeb], { cwd: directories.book });
  const strict = await capture("codesign", ["--verify", "--deep", "--strict", chromeApp]);
  const signing = await capture("codesign", ["-dv", "--verbose=4", chromeApp]);
  const spctl = await capture("spctl", ["--assess", "--type", "execute", "--verbose=4", chromeApp]);
  invariant(signing.stderr.includes("TeamIdentifier=EQHXZ8M8AV"), "chrome_signing_team_invalid");
  const chromeVersion = (await command("/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleShortVersionString", path.join(chromeApp, "Contents/Info.plist")])).stdout.trim();
  staging = spawn(process.execPath, ["infra/integration/local-staging.mjs"], { cwd: root, detached: true,
    stdio: ["ignore", "pipe", "pipe"], env: { HOME: process.env.HOME, PATH: process.env.PATH,
      LANG: process.env.LANG ?? "en_US.UTF-8", TMPDIR: process.env.TMPDIR, UNSEEN_STAGING_MODE: "local",
      UNSEEN_STAGING_HOST: "127.0.0.1", UNSEEN_STAGING_PORT: "0", UNSEEN_STAGING_DATA_DIR: directories.data,
      UNSEEN_STAGING_RUNTIME_EVIDENCE_DIR: directories.runtime, UNSEEN_BOOK_WORKTREE: directories.book,
      UNSEEN_BOOK_OUTPUT_DIR: directories.output, UNSEEN_STAGING_EXPECT_REPOSITORY_STATE: "allow_dirty" } });
  const ready = await stagingReady(staging), origin = ready.origin;
  invariant(/^http:\/\/127\.0\.0\.1:\d+$/u.test(origin) && !origin.endsWith(":4282"), "isolated_origin_invalid");
  chrome = spawn(chromeBin, ["--headless=new", "--disable-background-networking", "--disable-component-update",
    "--disable-default-apps", "--disable-sync", "--metrics-recording-only", "--no-first-run",
    "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${directories.chrome}`, "about:blank"],
  { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const port = await poll(async () => { try { return (await readFile(path.join(directories.chrome,
    "DevToolsActivePort"), "utf8")).trim().split("\n")[0]; } catch { return null; } }, "DevTools port");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  cdp = new Cdp(targets.find((item) => item.type === "page").webSocketDebuggerUrl); await cdp.ready;
  await Promise.all([cdp.send("Page.enable"), cdp.send("Runtime.enable"), cdp.send("Network.enable"),
    cdp.send("Accessibility.enable")]); await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: observer });
  const diagnostics = { consoleErrors: [], exceptions: [], httpErrors: [], failedRequests: [], externalRequests: [] };
  const urls = new Map();
  cdp.on("Runtime.consoleAPICalled", (value) => { if (["error", "assert"].includes(value.type))
    diagnostics.consoleErrors.push(value.args.map((item) => item.value ?? item.description ?? "").join(" ").slice(0, 500)); });
  cdp.on("Runtime.exceptionThrown", (value) => diagnostics.exceptions.push(
    (value.exceptionDetails.exception?.description ?? value.exceptionDetails.text).slice(0, 500)));
  cdp.on("Network.requestWillBeSent", ({ requestId, request }) => { urls.set(requestId, request.url);
    if (/^https?:/u.test(request.url) && new URL(request.url).origin !== origin) diagnostics.externalRequests.push(request.url); });
  cdp.on("Network.responseReceived", ({ response }) => { if (response.status >= 400)
    diagnostics.httpErrors.push({ status: response.status, url: response.url }); });
  cdp.on("Network.loadingFailed", ({ requestId, canceled, errorText }) => { if (!canceled && errorText !== "net::ERR_ABORTED")
    diagnostics.failedRequests.push({ errorText, url: urls.get(requestId) }); });
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: profile.latencyMs,
    downloadThroughput: profile.downloadBitsPerSecond / 8, uploadThroughput: profile.uploadBitsPerSecond / 8,
    connectionType: "cellular4g" });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpuSlowdownMultiplier });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  const homeSamples = []; for (let round = 1; round <= 3; round++) homeSamples.push({ round, ...await sample(cdp, origin, "/") });
  const homeLock = { route: "/", title: homeSamples[0].title, phase: homeSamples[0].phase };
  invariant(homeSamples.every((value) => value.route === homeLock.route && value.title === homeLock.title && value.phase === homeLock.phase), "home_lock_unstable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1,
    uploadThroughput: -1, connectionType: "none" });
  const homeA11y = await a11y(cdp, origin, "/", homeLock);
  const loginEvidence = await login(cdp, origin, path.join(directories.data, ".otp-mailbox.json"));
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: profile.latencyMs,
    downloadThroughput: profile.downloadBitsPerSecond / 8, uploadThroughput: profile.uploadBitsPerSecond / 8,
    connectionType: "cellular4g" });
  const spacesSamples = []; for (let round = 1; round <= 3; round++) spacesSamples.push({ round,
    ...await sample(cdp, origin, "/spaces") });
  const spacesLock = { route: "/spaces", title: spacesSamples[0].title, phase: spacesSamples[0].phase };
  invariant(spacesSamples.every((value) => value.route === spacesLock.route && value.title === spacesLock.title && value.phase === spacesLock.phase), "spaces_lock_unstable");
  invariant(await evaluate(cdp, "document.body.innerText.includes('我的空间')"), "spaces_not_authenticated");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1,
    uploadThroughput: -1, connectionType: "none" });
  const spacesA11y = await a11y(cdp, origin, "/spaces", spacesLock);
  const meta = await (await fetch(`${origin}/__staging/meta`)).json();
  invariant(meta.externalExposure === false && meta.cloudWrites === 0, "staging_boundary_invalid");
  invariant(Object.values(diagnostics).every((value) => value.length === 0), `diagnostics_not_zero:${JSON.stringify(diagnostics)}`);
  const [macVersion, macBuild, model] = await Promise.all([command("sw_vers", ["-productVersion"]),
    command("sw_vers", ["-buildVersion"]), command("sysctl", ["-n", "hw.model"])]);
  const perfRoute = (id, samples) => ({ id, samples, p75FirstUsableMs: p75(samples.map((value) => value.firstUsableMs)),
    diagnosticThresholdMs: 3_000, diagnosticWithinThreshold: p75(samples.map((value) => value.firstUsableMs)) <= 3_000 });
  const accessibility = [homeA11y, spacesA11y];
  const findings = accessibility.flatMap((route) => Object.entries(route.checks)
    .filter(([, value]) => value !== true).map(([check, value]) => ({ route: route.route, check,
      classification: value === "INDETERMINATE" ? value : "FAIL" })));
  const runnerSha256 = createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex");
  report = { schema: "unseen-stage-rc-chrome-perf-a11y-preflight/1", generatedAt: new Date().toISOString(),
    status: "PRE_RELEASE_PREFLIGHT_NOT_R0", claimBoundary: { productCandidate: candidate, harnessBaseCommit: head,
      runner: "tests/e2e/stage-rc-chrome-perf-a11y.mjs", runnerSha256,
      localDeterministicFixture: true, fixturePromotedToProductionEvidence: false, productionReady: false,
      liveStaging4282Accessed: false, externalExposure: false, cloudWrites: 0 },
    platform: { os: "macOS", version: macVersion.stdout.trim(), build: macBuild.stdout.trim(),
      model: model.stdout.trim(), architecture: process.arch, chrome: { version: chromeVersion,
        signingTeam: "EQHXZ8M8AV", signingTimestamp: signing.stderr.match(/Timestamp=(.+)/u)?.[1] ?? null,
        notarizationTicketStapled: signing.stderr.includes("Notarization Ticket=stapled"),
        strictCodesignPass: strict.ok, strictCodesignFailure: strict.stderr.trim().slice(0, 500),
        spctlAccepted: spctl.ok && /accepted/u.test(`${spctl.stdout}${spctl.stderr}`),
        spctlOutput: `${spctl.stdout}${spctl.stderr}`.trim().slice(0, 500),
        toolAttestation: "DEGRADED_NOT_RELEASE_ATTESTATION", officialIntegrityPassClaimed: false } },
    frozenGate: { source: "contracts/source/technical/RELEASE-READINESS-CONTRACT.md §9",
      literal: "named 4G/25Mbps profile P75≤3s; Scene lazy load measured separately", profileSignatureComplete: false,
      missingSignatureFields: ["RTT/latency", "CPU throttle", "cache cold/warm policy"],
      formalVerdict: "INDETERMINATE_PROFILE_UNDERSPECIFIED_FAIL_CLOSED" },
    diagnosticBenchmark: { profile, percentileMethod: "nearest-rank (3 samples => maximum)",
      firstUsableDefinition: "navigation start to visible #main, heading and named interactive control after loading phase",
      routes: [perfRoute("home", homeSamples), perfRoute("authenticated-spaces", spacesSamples)],
      viewer: { status: "INDETERMINATE_SETUP_UNAVAILABLE", measured: false,
        reason: "No already-provisioned real scene plus admission was available in this isolated run; unauthenticated or query-fixture error pages were not sampled." } },
    authentication: loginEvidence,
    accessibility: { scope: "automated WCAG AA preflight; home + authenticated /spaces only",
      contrastPolicy: "gradient/image backgrounds skipped as INDETERMINATE", dependenciesAdded: 0,
      routes: accessibility, findings, pass: findings.length === 0 },
    diagnostics: Object.fromEntries(Object.entries(diagnostics).map(([key, value]) => [key, value.length])),
    cleanup: { stagingProcessGroupStopped: false, chromeProcessGroupStopped: false,
      temporaryStateRemoved: false, devtoolsEndpointClosed: false } };
} finally {
  cdp?.close(); await Promise.all([stop(chrome), stop(staging)]); await rm(temporary, { recursive: true, force: true });
}
invariant(report, "preflight_incomplete");
report.cleanup = { stagingProcessGroupStopped: true, chromeProcessGroupStopped: true,
  temporaryStateRemoved: true, devtoolsEndpointClosed: true };
await mkdir(path.dirname(evidenceFile), { recursive: true });
await writeFile(evidenceFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ status: report.status, formalVerdict: report.frozenGate.formalVerdict,
  diagnosticP75: Object.fromEntries(report.diagnosticBenchmark.routes.map((route) => [route.id, route.p75FirstUsableMs])),
  viewer: report.diagnosticBenchmark.viewer.status, a11yFindings: report.accessibility.findings,
  cleanup: report.cleanup }, null, 2)}\n`);
