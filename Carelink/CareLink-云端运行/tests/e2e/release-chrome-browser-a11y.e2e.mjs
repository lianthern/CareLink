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
const candidate = process.env.UNSEEN_PRODUCT_CANDIDATE_COMMIT ??
  "09076727051411eeb9274a26663f6ccd168378c3";
const evidenceRoot = path.resolve(process.env.UNSEEN_BROWSER_A11Y_EVIDENCE_ROOT ??
  path.join(root, "release-evidence/r0/browser-a11y"));
const evidenceFile = path.join(evidenceRoot, "CHROME-MACOS-MAIN-CHAIN-A11Y.json");
const chromeApp = "/Applications/Google Chrome.app";
const chromeBin = path.join(chromeApp, "Contents/MacOS/Google Chrome");
const diagnosticProfile = Object.freeze({ downloadBitsPerSecond: 25_000_000,
  uploadBitsPerSecond: 25_000_000, latencyMs: 0, cpuSlowdownMultiplier: 1,
  cachePolicy: "cold_each_sample", samples: 5 });

const invariant = (value, message) => { if (!value) throw new Error(`release_chrome_a11y:${message}`); };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
async function command(file, args, options = {}) {
  return exec(file, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000, ...options });
}
async function capture(file, args) {
  try { const result = await command(file, args); return { ok: true, stdout: result.stdout, stderr: result.stderr }; }
  catch (error) { return { ok: false, stdout: error.stdout ?? "", stderr: error.stderr ?? String(error) }; }
}
async function poll(run, label, timeout = 30_000) {
  const started = Date.now(); let last;
  while (Date.now() - started < timeout) {
    try { const value = await run(); if (value) return value; } catch (error) { last = error; }
    await delay(75);
  }
  throw new Error(`release_chrome_a11y_timeout:${label}`, { cause: last });
}
async function stop(child) {
  if (!child?.pid || child.exitCode !== null) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  const closed = await Promise.race([new Promise((resolve) => child.once("exit", () => resolve(true))),
    delay(3_000).then(() => false)]);
  if (!closed) try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
}
function stagingReady(child) {
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "";
    const timer = setTimeout(() => reject(new Error(`staging_timeout:${stderr.slice(-2_000)}`)), 30_000);
    child.stdout.on("data", (bytes) => {
      stdout += bytes; const lines = stdout.split("\n"); stdout = lines.pop();
      for (const line of lines) try {
        const event = JSON.parse(line);
        if (event.status === "LOCAL_STAGING_READY") { clearTimeout(timer); resolve(event); }
      } catch {}
    });
    child.stderr.on("data", (bytes) => { stderr = `${stderr}${bytes}`.slice(-8_000); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`staging_exit:${code}:${stderr}`)); });
  });
}

class Cdp {
  constructor(url) {
    this.sequence = 0; this.pending = new Map(); this.listeners = new Map(); this.socket = new WebSocket(url);
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
    await this.ready; const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`cdp_timeout:${method}`)); }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, listener) { this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener]); }
  once(method) { return new Promise((resolve) => {
    const listener = (params) => { this.listeners.set(method,
      (this.listeners.get(method) ?? []).filter((item) => item !== listener)); resolve(params); };
    this.on(method, listener);
  }); }
  close() { if (this.socket.readyState < WebSocket.CLOSING) this.socket.close(); }
}

async function evaluate(page, expression) {
  const value = await page.cdp.send("Runtime.evaluate", { expression, awaitPromise: true,
    returnByValue: true, userGesture: true });
  if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text);
  return value.result.value;
}
async function navigate(page, origin, route) {
  const loaded = page.cdp.once("Page.loadEventFired");
  await page.cdp.send("Page.navigate", { url: `${origin}${route}` });
  await Promise.race([loaded, delay(30_000).then(() => { throw new Error(`load_timeout:${route}`); })]);
  await poll(() => evaluate(page, "document.readyState==='complete'&&Boolean(document.querySelector('#main'))&&!document.querySelector('[data-phase=loading]')"), `app:${route}`);
}
async function waitLocation(page, expression, label) {
  await poll(() => evaluate(page, `Boolean(${expression})`), label);
  await poll(() => evaluate(page, "Boolean(document.querySelector('#main'))&&!document.querySelector('[data-phase=loading]')"), `${label}:render`);
}
async function elementCenter(page, selector) {
  await evaluate(page, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.scrollIntoView({block:'center',inline:'center'});return true})()`);
  return poll(() => evaluate(page, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return null;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'?{x:r.left+r.width/2,y:r.top+r.height/2}:null})()`), `element:${selector}`);
}
async function uiClick(page, selector) {
  const { x, y } = await elementCenter(page, selector);
  await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await page.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}
async function uiType(page, selector, text) {
  await uiClick(page, selector);
  await page.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 4 });
  await page.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 4 });
  await page.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace" });
  await page.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace" });
  await page.cdp.send("Input.insertText", { text });
}
async function uiActivate(page, selector, limit = 100) {
  for (let index = 0; index < limit; index += 1) {
    if (await evaluate(page, `document.activeElement?.matches(${JSON.stringify(selector)})===true`)) {
      await page.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter",
        text: "\r", unmodifiedText: "\r", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await page.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter",
        windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      return index;
    }
    await page.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab",
      windowsVirtualKeyCode: 9 });
    await page.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab",
      windowsVirtualKeyCode: 9 });
  }
  throw new Error(`release_chrome_a11y_keyboard_target:${selector}`);
}
async function injectFileInput(page, selector, sourcePath, filename) {
  const result = await evaluate(page, `(async()=>{const input=document.querySelector(${JSON.stringify(selector)});if(!input)return{ok:false,phase:'input'};const response=await fetch(${JSON.stringify(sourcePath)},{cache:'no-store'});if(!response.ok)return{ok:false,phase:'source',status:response.status};const blob=await response.blob(),transfer=new DataTransfer();transfer.items.add(new File([blob],${JSON.stringify(filename)},{type:blob.type,lastModified:0}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));return{ok:true,files:input.files.length,bytes:blob.size,type:blob.type}})()`);
  invariant(result.ok && result.files === 1 && result.bytes > 0, `file_input:${JSON.stringify(result)}`);
  return result;
}
async function loginOwner(page, origin, mailbox) {
  let previous = ""; try { previous = JSON.parse(await readFile(mailbox, "utf8")).challengeId ?? ""; } catch {}
  await navigate(page, origin, "/login");
  await uiType(page, "#email", "chrome-release-owner@example.test");
  await uiClick(page, '[data-login-form] button[type="submit"]');
  await poll(() => evaluate(page, "Boolean(document.querySelector('#code'))"), "OTP field");
  const otp = await poll(async () => { try { const value = JSON.parse(await readFile(mailbox, "utf8"));
    return value.challengeId !== previous && /^\d{6}$/u.test(value.code) ? value.code : null; } catch { return null; } }, "OTP mailbox");
  await uiType(page, "#code", otp);
  await uiClick(page, '[data-login-form] button[type="submit"]');
  await waitLocation(page, "location.pathname==='/spaces'", "owner login");
}

const preloadObserver = `(()=>{const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'};globalThis.__releaseTiming={firstUsableMs:null,viewerUsableMs:null};const check=()=>{const main=document.querySelector('#main'),heading=main?.querySelector('h1,h2'),action=main?.querySelector('a[href],button,input,select,textarea'),name=action&&(action.getAttribute('aria-label')||action.innerText||action.value||action.labels?.[0]?.innerText||'').trim();if(globalThis.__releaseTiming.firstUsableMs===null&&visible(main)&&visible(heading)&&visible(action)&&name&&!main.querySelector('[data-phase=loading]'))globalThis.__releaseTiming.firstUsableMs=performance.now();const viewer=document.querySelector('[data-viewer-root] canvas,.unseen-viewer__fallback'),photo=document.querySelector('.viewer-photo-button');if(globalThis.__releaseTiming.viewerUsableMs===null&&visible(viewer)&&visible(photo))globalThis.__releaseTiming.viewerUsableMs=performance.now()};new MutationObserver(check).observe(document,{subtree:true,childList:true,attributes:true});addEventListener('DOMContentLoaded',check);requestAnimationFrame(check)})();`;

async function createPage(browser, debugPort, contextId, label, origin, diagnostics) {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank", browserContextId: contextId });
  const target = await poll(async () => {
    const values = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    return values.find((item) => item.id === targetId);
  }, `target:${label}`);
  const cdp = new Cdp(target.webSocketDebuggerUrl); await cdp.ready;
  await Promise.all([cdp.send("Page.enable"), cdp.send("Runtime.enable"), cdp.send("Network.enable"),
    cdp.send("Log.enable"), cdp.send("Accessibility.enable"), cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: preloadObserver }),
    cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })]);
  const page = { cdp, targetId, contextId, label, requests: new Map() };
  cdp.on("Runtime.consoleAPICalled", (event) => { if (["error", "assert"].includes(event.type))
    diagnostics.consoleErrors.push({ page: label, text: event.args.map((item) => item.value ?? item.description ?? "").join(" ").slice(0, 400) }); });
  cdp.on("Runtime.exceptionThrown", (event) => diagnostics.consoleErrors.push({ page: label,
    text: (event.exceptionDetails.exception?.description ?? event.exceptionDetails.text).slice(0, 400) }));
  cdp.on("Network.requestWillBeSent", ({ requestId, request }) => { page.requests.set(requestId, request.url);
    if (/^https?:/u.test(request.url) && new URL(request.url).origin !== origin) diagnostics.externalRequests.push(request.url); });
  cdp.on("Network.responseReceived", ({ response }) => { if (response.status >= 400)
    diagnostics.httpErrors.push({ page: label, status: response.status, path: /^https?:/u.test(response.url) ? new URL(response.url).pathname : response.url }); });
  cdp.on("Network.loadingFailed", ({ requestId, canceled, errorText }) => { if (!canceled && errorText !== "net::ERR_ABORTED")
    diagnostics.fetchErrors.push({ page: label, errorText, url: page.requests.get(requestId) }); });
  return page;
}

const auditScript = `(()=>{const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return !e.closest('[hidden],[inert]')&&!e.matches('.sr-only')&&r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'};const rgba=v=>{const n=(v.match(/[\\d.]+/g)||[]).map(Number);return n.length>=3?{r:n[0],g:n[1],b:n[2],a:n[3]??1}:null},blend=(f,b)=>({r:f.r*f.a+b.r*(1-f.a),g:f.g*f.a+b.g*(1-f.a),b:f.b*f.a+b.b*(1-f.a),a:1});const bg=e=>{let n=e,c={r:255,g:255,b:255,a:1},image=false,pseudo=false,stack=[];while(n){const s=getComputedStyle(n);if(s.backgroundImage!=='none')image=true;const v=rgba(s.backgroundColor);if(v&&v.a>0)stack.push(v);for(const q of ['::before','::after']){const p=getComputedStyle(n,q),pc=rgba(p.backgroundColor);if(p.backgroundImage!=='none'||(p.content!=='none'&&pc&&pc.a>0)){image=true;pseudo=true}}n=n.parentElement}for(const v of stack.reverse())c=blend(v,c);return{color:c,image,pseudo}};const lum=c=>{const f=v=>(v/=255)<=.04045?v/12.92:((v+.055)/1.055)**2.4;return .2126*f(c.r)+.7152*f(c.g)+.0722*f(c.b)},ratio=(a,b)=>(Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05),name=e=>(e.getAttribute('aria-label')||e.getAttribute('title')||e.innerText||e.value||e.labels?.[0]?.innerText||'').trim().slice(0,80);const skippedTextReasons=[],text=[];for(const e of [...document.querySelectorAll('body *')].filter(visible)){if(![...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()))continue;const b=bg(e),s=getComputedStyle(e),f=rgba(s.color);if(!f)continue;const large=parseFloat(s.fontSize)>=24||(parseFloat(s.fontSize)>=18.66&&(Number(s.fontWeight)||400)>=700),required=large?3:4.5;if(b.image){const r=e.getBoundingClientRect();skippedTextReasons.push({tag:e.tagName,name:name(e),reason:b.pseudo?'pseudo-element gradient/image/background':'ancestor gradient/image',foreground:f,required,rect:{x:r.x,y:r.y,width:r.width,height:r.height}});continue}const value=ratio(blend(f,b.color),b.color);text.push({tag:e.tagName,name:name(e),ratio:+value.toFixed(2),required,pass:value>=required})}const skippedControlReasons=[],controls=[];for(const e of [...document.querySelectorAll('button,input:not([type=hidden]),select,textarea')].filter(visible)){const own=bg(e),around=bg(e.parentElement||document.body);if(own.image||around.image){skippedControlReasons.push({tag:e.tagName,name:name(e),reason:own.pseudo||around.pseudo?'pseudo-element gradient/image/background':'ancestor gradient/image'});continue}const border=rgba(getComputedStyle(e).borderColor),value=Math.max(ratio(own.color,around.color),border?ratio(border,around.color):1);controls.push({tag:e.tagName,name:name(e),ratio:+value.toFixed(2),required:3,pass:value>=3})}const ids=[...document.querySelectorAll('[id]')].map(e=>e.id),headings=[...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(visible).map(e=>({level:+e.tagName[1],name:name(e)})),focusables=[...document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,summary,[tabindex]:not([tabindex="-1"])')].filter(visible).filter(e=>!e.disabled).map(e=>({tag:e.tagName,name:name(e)}));return{route:location.pathname,title:document.title,phase:document.querySelector('[data-phase]')?.dataset.phase??null,landmarks:{main:document.querySelectorAll('main').length,header:document.querySelectorAll('header').length,nav:document.querySelectorAll('nav').length},headings,headingSkip:headings.some((h,i)=>i&&h.level>headings[i-1].level+1),duplicateIds:[...new Set(ids.filter((id,i)=>ids.indexOf(id)!==i))],unlabeledForms:[...document.querySelectorAll('input:not([type=hidden]),select,textarea')].filter(visible).filter(e=>!(e.labels?.length||e.getAttribute('aria-label')||e.getAttribute('aria-labelledby'))).map(e=>({tag:e.tagName,id:e.id})),unnamedButtons:[...document.querySelectorAll('button')].filter(visible).filter(e=>!name(e)).map(e=>e.className),textContrast:text,controlContrast:controls,skippedTextReasons,skippedControlReasons,focusables}})()`;

const pixelProbe = String.raw`import json,sys
from PIL import Image
im=Image.open(sys.argv[1]).convert('RGB'); rows=json.load(open(sys.argv[2])); out=[]
def lum(c):
 def f(v):
  v=v/255
  return v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4
 return .2126*f(c[0])+.7152*f(c[1])+.0722*f(c[2])
for row in rows:
 r=row['rect']; x,y,w,h=[float(r[k]) for k in ('x','y','width','height')]
 pts=[(x+2,y+2),(x+w-3,y+2),(x+2,y+h-3),(x+w-3,y+h-3),(x+w/2,y+2),(x+w/2,y+h-3)]
 pts=[(max(0,min(im.width-1,round(a))),max(0,min(im.height-1,round(b)))) for a,b in pts if w>=6 and h>=6 and a>=0 and b>=0 and a<im.width and b<im.height]
 colors=[im.getpixel(p) for p in pts]
 if len(colors)<4: out.append({'name':row['name'],'status':'INDETERMINATE_OUTSIDE_VIEWPORT','sampleCount':len(colors),'channelSpread':None}); continue
 spread=max(max(c[i] for c in colors)-min(c[i] for c in colors) for i in range(3))
 if spread>4: out.append({'name':row['name'],'status':'INDETERMINATE_NON_UNIFORM','sampleCount':len(colors),'channelSpread':spread}); continue
 bg=tuple(sum(c[i] for c in colors)/len(colors) for i in range(3)); fg0=row['foreground']; a=float(fg0.get('a',1)); fg=tuple(float(fg0[k])*a+bg[i]*(1-a) for i,k in enumerate(('r','g','b'))); ratio=(max(lum(fg),lum(bg))+.05)/(min(lum(fg),lum(bg))+.05); required=float(row['required']); out.append({'name':row['name'],'status':'MEASURED_UNIFORM_PIXELS','sampleCount':len(colors),'channelSpread':spread,'ratio':round(ratio,2),'required':required,'pass':ratio>=required})
print(json.dumps(out,separators=(',',':')))`;

async function pixelContrast(page, audit, temporary, id) {
  if (!audit.skippedTextReasons.length) return [];
  const capture = await page.cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  const image = path.join(temporary, `a11y-${id}.png`), rows = path.join(temporary, `a11y-${id}.json`);
  await Promise.all([writeFile(image, Buffer.from(capture.data, "base64"), { mode: 0o600 }),
    writeFile(rows, JSON.stringify(audit.skippedTextReasons), { mode: 0o600 })]);
  const result = await command("python3", ["-c", pixelProbe, image, rows]);
  return JSON.parse(result.stdout);
}

async function auditCurrent(page, id, temporary, options = {}) {
  const viewport = { width: options.width ?? 1280, height: options.height ?? 900,
    mobile: options.mobile ?? false };
  const checkReflow200 = options.checkReflow200 ?? true;
  await page.cdp.send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1 });
  await page.cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
  await page.cdp.send("Emulation.resetPageScaleFactor");
  await page.cdp.send("Emulation.setEmulatedMedia", { features: [] });
  const automated = await evaluate(page, auditScript);
  const pixelText = await pixelContrast(page, automated, temporary, id);
  await evaluate(page, "document.body.tabIndex=-1;document.body.focus();true");
  const keyboard = [];
  for (let index = 0; index < Math.min(12, automated.focusables.length); index += 1) {
    await page.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await page.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    const item = await evaluate(page, `(()=>{const e=document.activeElement,s=getComputedStyle(e),r=e.getBoundingClientRect(),name=(e.getAttribute('aria-label')||e.getAttribute('title')||e.innerText||e.value||e.labels?.[0]?.innerText||'').trim().slice(0,80);return{tag:e.tagName,name,visible:r.width>0&&r.height>0,focusVisible:(s.outlineStyle!=='none'&&parseFloat(s.outlineWidth)>0)||s.boxShadow!=='none'}})()`);
    keyboard.push(item);
  }
  const expected = automated.focusables.slice(0, keyboard.length);
  const orderPass = JSON.stringify(expected.map(({ tag, name }) => ({ tag, name }))) ===
    JSON.stringify(keyboard.map(({ tag, name }) => ({ tag, name })));
  const ax = await page.cdp.send("Accessibility.getFullAXTree");
  const axUnnamed = ax.nodes.filter((node) => ["button", "link", "textbox", "combobox", "checkbox", "radio"]
    .includes(node.role?.value) && !node.ignored && !node.name?.value).map((node) => node.role.value);
  let reflow200;
  if (checkReflow200) {
    await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: 640, height: 450,
      deviceScaleFactor: 1, mobile: false });
    await page.cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 }); await delay(150);
    reflow200 = await evaluate(page, `({applicable:true,equivalentViewportCssPx:640,clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,pass:document.documentElement.scrollWidth<=document.documentElement.clientWidth})`);
  } else {
    reflow200 = await evaluate(page, `({applicable:false,reason:'desktop 200% measured separately',clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,pass:document.documentElement.scrollWidth<=document.documentElement.clientWidth})`);
  }
  await page.cdp.send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1 });
  await page.cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
  await page.cdp.send("Emulation.resetPageScaleFactor");
  await page.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }); await delay(100);
  const reducedMotion = await evaluate(page, `(()=>{const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'},ms=v=>Math.max(0,...v.split(',').map(x=>x.trim().endsWith('ms')?parseFloat(x):parseFloat(x)*1000||0));const offenders=[...document.querySelectorAll('body *')].filter(visible).map(e=>{const s=getComputedStyle(e);return{tag:e.tagName,name:(e.getAttribute('aria-label')||e.innerText||'').trim().slice(0,60),animationName:s.animationName,animationMs:ms(s.animationDuration),iteration:s.animationIterationCount,transition:s.transitionProperty.split(',').map(x=>x.trim()),transitionMs:ms(s.transitionDuration)}}).filter(x=>(x.animationName!=='none'&&x.animationMs>.01)||x.transitionMs>120||(x.transitionMs>.01&&x.transition.some(p=>['transform','translate','scale','rotate','all'].includes(p))));return{rule:'opacity transitions <=120ms allowed; animation/continuous/scale/parallax/auto-pan rejected',offenders,pass:offenders.length===0}})()`);
  await page.cdp.send("Emulation.setEmulatedMedia", { features: [] });
  const measuredPixelFailure = pixelText.some((item) => item.status === "MEASURED_UNIFORM_PIXELS" && !item.pass);
  const pixelIndeterminate = pixelText.some((item) => item.status.startsWith("INDETERMINATE"));
  const checks = { landmarks: automated.landmarks.main === 1 && automated.landmarks.header >= 1,
    headings: automated.headings.length > 0 && !automated.headingSkip,
    names: automated.unlabeledForms.length === 0 && automated.unnamedButtons.length === 0 && axUnnamed.length === 0,
    duplicateIds: automated.duplicateIds.length === 0,
    textContrast: automated.textContrast.some((item) => !item.pass) || measuredPixelFailure ? false :
      pixelIndeterminate ? "INDETERMINATE" : true,
    controlContrast: automated.controlContrast.some((item) => !item.pass) ? false :
      automated.skippedControlReasons.length ? "INDETERMINATE" : true,
    keyboardOrder: orderPass && keyboard.every((item) => item.visible && item.name),
    visibleFocus: keyboard.every((item) => item.focusVisible), reflow200: reflow200.pass,
    reducedMotion: reducedMotion.pass };
  return { id, route: automated.route, viewport, automated, pixelText,
    keyboard: { expected, actual: keyboard, orderPass },
    axUnnamed, reflow200, reducedMotion, checks };
}

async function screenshot(page) {
  const capture = await page.cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  return Buffer.from(capture.data, "base64");
}
const p75 = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .75) - 1];
async function sampleViewer(page, origin, route) {
  await page.cdp.send("Network.clearBrowserCache");
  const loaded = page.cdp.once("Page.loadEventFired"); await page.cdp.send("Page.navigate", { url: `${origin}${route}` });
  await Promise.race([loaded, delay(30_000).then(() => { throw new Error("viewer_sample_load_timeout"); })]);
  await poll(() => evaluate(page, "globalThis.__releaseTiming?.viewerUsableMs||null"), "viewer usable"); await delay(100);
  return evaluate(page, `({route:location.pathname,phase:document.querySelector('[data-phase]')?.dataset.phase??null,firstUsableMs:globalThis.__releaseTiming.firstUsableMs,viewerUsableMs:globalThis.__releaseTiming.viewerUsableMs,realScene:Boolean(document.querySelector('[data-viewer-root] canvas,.unseen-viewer__fallback')),photoControl:Boolean(document.querySelector('.viewer-photo-button'))})`);
}

const temporary = await mkdtemp(path.join(tmpdir(), "unseen-release-browser-a11y-"));
const config = JSON.parse(await readFile(path.join(root, "config/rc/local-staging.json"), "utf8"));
const runtimeRoot = path.join(temporary, "candidate-runtime");
const bookWorktree = path.resolve(process.env.UNSEEN_BOOK_WORKTREE ??
  `/Users/max/Library/Application Support/UNSEEN/staging-next/book-input-${config.inputs.bookWeb.slice(0, 7)}`);
const directories = Object.fromEntries(["data", "runtime", "output", "chrome"].map((name) => [name, path.join(temporary, name)]));
await Promise.all(Object.values(directories).map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
const diagnostics = { consoleErrors: [], httpErrors: [], fetchErrors: [], externalRequests: [] };
let staging, chrome, browser, origin, debugPort, result;
const pages = [], contexts = [], captures = new Map(), accessibility = [];
try {
  const head = (await command("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  await command("git", ["merge-base", "--is-ancestor", candidate, head], { cwd: root });
  await command("git", ["diff", "--quiet", candidate, "--", "apps/web", "services/api", "packages/viewer",
    "infra/integration/local-staging.mjs", "infra/integration/local-operable.mjs", "config/rc/local-staging.json"], { cwd: root });
  await command("git", ["clone", "--quiet", "--no-checkout", root, runtimeRoot]);
  await command("git", ["checkout", "--quiet", "--detach", candidate], { cwd: runtimeRoot });
  const runtimeConfigPath = path.join(runtimeRoot, "config/rc/local-staging.json");
  const runtimeConfig = JSON.parse(await readFile(runtimeConfigPath, "utf8"));
  runtimeConfig.inputs.coreLocal = candidate;
  await writeFile(runtimeConfigPath, `${JSON.stringify(runtimeConfig, null, 2)}\n`, { mode: 0o600 });
  invariant((await command("git", ["rev-parse", "HEAD"], { cwd: bookWorktree })).stdout.trim() === config.inputs.bookWeb,
    "book_commit");
  invariant(!(await command("git", ["status", "--porcelain"], { cwd: bookWorktree })).stdout.trim(), "book_dirty");
  const signing = await capture("codesign", ["-dv", "--verbose=4", chromeApp]);
  const strict = await capture("codesign", ["--verify", "--deep", "--strict", chromeApp]);
  const spctl = await capture("spctl", ["--assess", "--type", "execute", "--verbose=4", chromeApp]);
  invariant(signing.stderr.includes("TeamIdentifier=EQHXZ8M8AV"), "chrome_signer");
  const chromeVersion = (await command("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString",
    path.join(chromeApp, "Contents/Info.plist")])).stdout.trim();
  staging = spawn(process.execPath, ["infra/integration/local-staging.mjs"], { cwd: runtimeRoot, detached: true,
    stdio: ["ignore", "pipe", "pipe"], env: { HOME: process.env.HOME, PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR, LANG: process.env.LANG ?? "en_US.UTF-8", UNSEEN_STAGING_MODE: "local",
      UNSEEN_STAGING_HOST: "127.0.0.1", UNSEEN_STAGING_PORT: "0", UNSEEN_STAGING_DATA_DIR: directories.data,
      UNSEEN_STAGING_RUNTIME_EVIDENCE_DIR: directories.runtime, UNSEEN_BOOK_WORKTREE: bookWorktree,
      UNSEEN_BOOK_OUTPUT_DIR: directories.output, UNSEEN_STAGING_EXPECT_REPOSITORY_STATE: "allow_dirty" } });
  const ready = await stagingReady(staging); origin = ready.origin;
  invariant(/^http:\/\/127\.0\.0\.1:\d+$/u.test(origin) && !origin.endsWith(":4282") && !origin.endsWith(":4180"),
    "isolated_origin");
  chrome = spawn(chromeBin, ["--headless=new", "--disable-background-networking", "--disable-component-update",
    "--disable-default-apps", "--disable-sync", "--metrics-recording-only", "--no-first-run",
    "--no-default-browser-check", "--no-pings", "--remote-debugging-port=0",
    `--user-data-dir=${directories.chrome}`, "about:blank"], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const devtools = await poll(async () => { try { return (await readFile(path.join(directories.chrome,
    "DevToolsActivePort"), "utf8")).trim().split("\n"); } catch { return null; } }, "DevTools port");
  debugPort = Number(devtools[0]);
  const browserInfo = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
  browser = new Cdp(browserInfo.webSocketDebuggerUrl); await browser.ready;
  async function newPage(label) {
    const contextId = (await browser.send("Target.createBrowserContext")).browserContextId; contexts.push(contextId);
    const page = await createPage(browser, debugPort, contextId, label, origin, diagnostics); pages.push(page); return page;
  }
  const owner = await newPage("owner"), participant = await newPage("participant"), anonymous = await newPage("anonymous");
  await navigate(anonymous, origin, "/"); accessibility.push(await auditCurrent(anonymous, "anonymous-home", temporary));
  accessibility.push(await auditCurrent(anonymous, "anonymous-home-mobile-390", temporary,
    { width: 390, height: 844, mobile: true, checkReflow200: false }));
  captures.set("chrome-mobile-home-390.png", await screenshot(anonymous));
  await loginOwner(owner, origin, path.join(directories.data, ".otp-mailbox.json"));
  accessibility.push(await auditCurrent(owner, "owner-spaces", temporary));
  await uiClick(owner, 'a[href="/spaces/new"]'); await waitLocation(owner, "location.pathname==='/spaces/new'", "new space");
  await uiType(owner, "#space-name", "Chrome 发布主链现场"); await uiClick(owner, '[data-create-space-form] button[type="submit"]');
  const managePath = await poll(() => evaluate(owner, "/^\\/manage\\/[^/?]+$/.test(location.pathname)?location.pathname:null"), "space created");
  const spaceId = managePath.split("/").at(-1); invariant(/^[A-Za-z0-9_-]+$/u.test(spaceId), "space_id");
  await navigate(owner, origin, `/manage/${spaceId}?tab=settings`); await uiClick(owner, '[data-action="COLLECTION.RESUME"]');
  await poll(() => evaluate(owner, "Boolean(document.querySelector('[data-action=\"COLLECTION.PAUSE\"]'))"), "collection open");
  await uiClick(owner, '[data-action="SHARING.ENABLE"]');
  await poll(() => evaluate(owner, "Boolean(document.querySelector('[data-action=\"SHARING.DISABLE\"]'))"), "sharing enabled");
  await navigate(owner, origin, `/manage/${spaceId}?tab=scene`);
  await injectFileInput(owner, "#panorama-file", "/assets/panorama/pano.jpg", "pano.jpg");
  await poll(() => evaluate(owner, "Boolean(document.querySelector('[data-action=\"PANORAMA.SWITCH_CANDIDATE\"]'))"), "panorama ready");
  await uiClick(owner, '[data-action="PANORAMA.SWITCH_CANDIDATE"]');
  await poll(() => evaluate(owner, "document.body.innerText.includes('可环视 · 已准备好')"), "panorama switched");
  await navigate(owner, origin, `/manage/${spaceId}?tab=invitations`); await uiClick(owner, "[data-open-campaign]");
  await uiClick(owner, '[data-dialog-confirm][data-action-id="EXTERNAL_INVITATION.CREATE"]');
  const campaignPath = await poll(() => evaluate(owner, "document.querySelector('.campaign-card:last-of-type [data-copy-campaign]')?.dataset.url||null"), "campaign path");
  invariant(/^\/open\/[A-Za-z0-9_-]+$/u.test(campaignPath), "campaign_path");
  captures.set("chrome-owner-invitation.png", await screenshot(owner));
  await navigate(participant, origin, campaignPath); await uiClick(participant, "[data-admit-campaign]");
  await waitLocation(participant, `location.pathname.startsWith('/s/${spaceId}/')`, "participant admitted");
  await uiClick(participant, `a[href="/s/${spaceId}/upload"]`); await waitLocation(participant,
    `location.pathname==='/s/${spaceId}/upload'`, "participant upload");
  await uiClick(participant, "[data-notice-check]"); await uiClick(participant, '[data-action="UPLOAD.ACCEPT_NOTICE"]');
  await poll(() => evaluate(participant, "Boolean(document.querySelector('#photo-files'))"), "photo input");
  accessibility.push(await auditCurrent(participant, "participant-upload", temporary));
  accessibility.push(await auditCurrent(participant, "participant-upload-mobile-390", temporary,
    { width: 390, height: 844, mobile: true, checkReflow200: false }));
  captures.set("chrome-mobile-upload-390.png", await screenshot(participant));
  await participant.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900,
    deviceScaleFactor: 1, mobile: false });
  await injectFileInput(participant, "#photo-files", "/assets/photos/photo-1.jpg", "photo-1.jpg");
  try {
    await poll(() => evaluate(participant, "Boolean(document.querySelector('[data-action=\"UPLOAD.FINALIZE_BATCH\"]')?.dataset.itemsDigest)&&!document.querySelector('[data-action=\"UPLOAD.FINALIZE_BATCH\"]')?.disabled"), "finalize control ready");
  } catch (error) {
    const state = await evaluate(participant, `({text:document.body.innerText.slice(-1800),toast:document.querySelector('.toast')?.innerText??null,fileCount:document.querySelector('#photo-files')?.files?.length??-1,finalize:document.querySelector('[data-action="UPLOAD.FINALIZE_BATCH"]')?{disabled:document.querySelector('[data-action="UPLOAD.FINALIZE_BATCH"]').disabled,digest:document.querySelector('[data-action="UPLOAD.FINALIZE_BATCH"]').dataset.itemsDigest,batchId:document.querySelector('[data-action="UPLOAD.FINALIZE_BATCH"]').dataset.batchId}:null})`);
    throw new Error(`${error.message}:dom=${JSON.stringify(state)}`);
  }
  const batchId = await evaluate(participant, "document.querySelector('[data-action=\"UPLOAD.FINALIZE_BATCH\"]')?.dataset.batchId");
  await uiActivate(participant, '[data-action="UPLOAD.FINALIZE_BATCH"]');
  try { await waitLocation(participant, `location.pathname==='/uploads/${batchId}'`, "upload finalized"); }
  catch (error) {
    const state = await evaluate(participant, `({pathname:location.pathname,text:document.body.innerText.slice(-1200),toast:document.querySelector('.toast')?.innerText??null,active:{tag:document.activeElement?.tagName,text:(document.activeElement?.innerText||'').trim().slice(0,80)}})`);
    throw new Error(`${error.message}:dom=${JSON.stringify(state)}`);
  }
  let manualPlacementConfirmation = false;
  for (let attempt = 0; attempt < 30 && !await evaluate(participant,
    "document.body.innerText.includes('已上传并定位')"); attempt += 1) {
    await delay(500);
    await navigate(participant, origin, `/uploads/${batchId}`);
  }
  if (!await evaluate(participant, "document.body.innerText.includes('已上传并定位')")) {
    const itemId = await poll(() => evaluate(participant,
      "document.querySelector('a[data-queue-item]')?.dataset.queueItem||null"), "receipt item");
    await uiClick(participant, `a[data-queue-item="${itemId}"]`);
    await waitLocation(participant, `location.pathname==='/uploads/${batchId}/items/${itemId}'`, "receipt item opened");
    await uiClick(participant, 'a[href^="/placements/"]');
    await waitLocation(participant, "location.pathname.startsWith('/placements/')", "placement editor");
    await poll(() => evaluate(participant,
      "document.querySelector('[data-placement-form]')?.dataset.poseReady==='true'&&!document.querySelector('[data-placement-form] button[type=submit]')?.disabled"),
    "placement pose ready");
    await uiActivate(participant, '[data-placement-form] button[type="submit"]');
    await delay(300);
    await navigate(participant, origin, `/uploads/${batchId}`);
    await poll(() => evaluate(participant, "document.body.innerText.includes('已上传并定位')"), "manual placement result");
    manualPlacementConfirmation = true;
  }
  captures.set("chrome-participant-upload.png", await screenshot(participant));
  await navigate(owner, origin, `/manage/${spaceId}?tab=review`);
  const photoId = await poll(() => evaluate(owner, "document.querySelector('[data-queue-item]')?.dataset.queueItem||null"), "review item");
  invariant(/^[A-Za-z0-9_-]+$/u.test(photoId), "photo_id");
  accessibility.push(await auditCurrent(owner, "owner-review", temporary));
  captures.set("chrome-owner-review.png", await screenshot(owner));
  await uiActivate(owner, `[data-queue-item="${photoId}"] [data-action="CONTENT.APPROVE"]`);
  await poll(() => evaluate(owner, `!document.querySelector('[data-queue-item="${photoId}"]')`), "photo approved");
  const viewerRoute = `/s/${spaceId}/scene?photo=${photoId}`;
  await navigate(participant, origin, viewerRoute);
  await poll(() => evaluate(participant, `Boolean(document.querySelector('[data-viewer-root] canvas,.unseen-viewer__fallback'))&&Boolean(document.querySelector('.viewer-photo-button[data-photo-id="${photoId}"]'))`), "real Viewer scene");
  accessibility.push(await auditCurrent(participant, "participant-real-scene", temporary));
  captures.set("chrome-real-scene.png", await screenshot(participant));
  await participant.cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844,
    deviceScaleFactor: 1, mobile: true });
  await navigate(participant, origin, viewerRoute);
  await poll(() => evaluate(participant, `Boolean(document.querySelector('[data-viewer-root] canvas,.unseen-viewer__fallback'))&&Boolean(document.querySelector('.viewer-photo-button[data-photo-id="${photoId}"]'))`), "real Viewer scene mobile reload");
  accessibility.push(await auditCurrent(participant, "participant-real-scene-mobile-390", temporary,
    { width: 390, height: 844, mobile: true, checkReflow200: false }));
  captures.set("chrome-mobile-real-scene-390.png", await screenshot(participant));
  await participant.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900,
    deviceScaleFactor: 1, mobile: false });
  await participant.cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await participant.cdp.send("Network.emulateNetworkConditions", { offline: false,
    latency: diagnosticProfile.latencyMs, downloadThroughput: diagnosticProfile.downloadBitsPerSecond / 8,
    uploadThroughput: diagnosticProfile.uploadBitsPerSecond / 8, connectionType: "cellular4g" });
  await participant.cdp.send("Emulation.setCPUThrottlingRate", { rate: diagnosticProfile.cpuSlowdownMultiplier });
  const viewerSamples = [];
  for (let round = 1; round <= diagnosticProfile.samples; round += 1)
    viewerSamples.push({ round, ...await sampleViewer(participant, origin, viewerRoute) });
  await participant.cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0,
    downloadThroughput: -1, uploadThroughput: -1, connectionType: "none" });
  await participant.cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  invariant(viewerSamples.every((sample) => sample.realScene && sample.photoControl && sample.route === `/s/${spaceId}/scene`),
    "viewer_sample_lock");
  const publicViewerSamples = viewerSamples.map((sample) => ({ ...sample, route: "/s/:space/scene" }));
  await delay(300);
  invariant(Object.values(diagnostics).every((items) => items.length === 0), `diagnostics:${JSON.stringify(diagnostics)}`);
  const metaResponse = await fetch(`${origin}/__staging/meta`, { cache: "no-store" }), meta = await metaResponse.json();
  invariant(metaResponse.ok && meta.listener === "loopback_only" && meta.externalExposure === false &&
    meta.cloudWrites === 0, "staging_meta");
  const [macVersion, macBuild, model] = await Promise.all([command("sw_vers", ["-productVersion"]),
    command("sw_vers", ["-buildVersion"]), command("sysctl", ["-n", "hw.model"])]);
  const definiteFindings = accessibility.flatMap((route) => Object.entries(route.checks)
    .filter(([, value]) => value === false).map(([check]) => ({ route: route.id, check, classification: "FAIL" })));
  const indeterminate = accessibility.flatMap((route) => Object.entries(route.checks)
    .filter(([, value]) => value === "INDETERMINATE").map(([check]) => ({ route: route.id, check,
      classification: "INDETERMINATE_GRADIENT_OR_PSEUDO" })));
  const runnerSha256 = sha256(await readFile(fileURLToPath(import.meta.url)));
  result = { schema: "unseen-release-chrome-browser-a11y/2", generatedAt: new Date().toISOString(),
    status: definiteFindings.length ? "PRODUCT_A11Y_FINDINGS" : "CHROME_CURRENT_CANDIDATE_NAMED_MAIN_CHAIN_PASS",
    claimBoundary: { productCandidate: candidate, harnessBaseCommit: head,
      runner: "tests/e2e/release-chrome-browser-a11y.e2e.mjs", runnerSha256,
      currentCandidateCoverage: candidate === "09076727051411eeb9274a26663f6ccd168378c3",
      currentCandidate: candidate,
      productionReady: false, releaseDecision: "NO_GO_PENDING_EXTERNAL_RELEASE_INPUTS_AND_FULL_R0",
      liveStaging4282Accessed: false, liveStaging4180Accessed: false, credentialsForwarded: [],
      externalExposure: false, cloudWrites: 0 },
    platform: { os: "macOS", version: macVersion.stdout.trim(), build: macBuild.stdout.trim(),
      hardwareModel: model.stdout.trim(), architecture: process.arch,
      chrome: { version: chromeVersion, userAgent: browserInfo["User-Agent"], signingTeam: "EQHXZ8M8AV",
        strictCodesignPass: strict.ok, strictCodesignDiagnostic: strict.ok ? null : strict.stderr.trim().slice(0, 500),
        spctlAccepted: spctl.ok && /accepted/u.test(`${spctl.stdout}${spctl.stderr}`) } },
    runtime: { origin: "dynamic_loopback_redacted", listener: meta.listener,
      fixtureDisclosureRequired: true, externalExposure: meta.externalExposure, cloudWrites: meta.cloudWrites },
    mainChain: { pass: true, browserUiOnly: true, browserExecutedCanonicalApi: [],
      viewportCoverage: { desktop: { width: 1280, height: 900 },
        mobile390: { width: 390, height: 844,
          routes: ["anonymous-home-mobile-390", "participant-upload-mobile-390",
            "participant-real-scene-mobile-390"] } },
      manualPlacementConfirmation,
      steps: ["owner real email/isolated OTP login", "owner visible Space creation",
        "owner visible collection/sharing controls", "owner panorama input DataTransfer and visible switch",
        "owner visible invitation creation", "participant visible admission", "participant visible notice acceptance",
        "participant photo input DataTransfer and visible finalize", "owner visible review approval",
        "participant real persisted Scene Viewer"],
      automationBoundary: { nativeFilePickerClaimed: false, fileBytesViaDataTransfer: true,
        detail: "Only the real panorama/photo file inputs receive same-origin bytes through DataTransfer; all product mutations are initiated by visible UI controls." },
      structuredIdentifiersRedacted: true,
      screenshotBoundary: "isolated ephemeral fixture identifiers only; runtime is destroyed after the run",
      screenshots: [...captures.keys()].map((name) => `screenshots/${name}`) },
    viewerDiagnostic: { realScene: true, route: "/s/:space/scene?photo=:photo",
      firstUsableDefinition: "navigation start to visible real Viewer canvas/fallback plus named photo control",
      profile: diagnosticProfile, percentileMethod: "nearest-rank", samples: publicViewerSamples,
      p75ViewerUsableMs: p75(viewerSamples.map((sample) => sample.viewerUsableMs)),
      diagnosticThresholdMs: 3_000,
      diagnosticWithinThreshold: p75(viewerSamples.map((sample) => sample.viewerUsableMs)) <= 3_000,
      formalFrozenProfileVerdict: "INDETERMINATE_PROFILE_UNDERSPECIFIED_FAIL_CLOSED",
      missingFrozenProfileSignature: ["RTT/latency", "CPU throttle", "cache cold/warm policy"] },
    accessibility: { scope: accessibility.map((route) => route.id), routes: accessibility,
      contrastPolicy: "solid CSS measured; gradient/image/pseudo text measured only when screenshot edge pixels are uniform, otherwise INDETERMINATE; skipped controls remain conservative INDETERMINATE",
      reflow200Method: "1280px desktop viewport represented as 640 CSS px plus page scale factor 2",
      definiteFindings, indeterminate, pass: definiteFindings.length === 0 },
    diagnostics: Object.fromEntries(Object.entries(diagnostics).map(([name, items]) => [name, items.length])),
    cleanup: { processGroupsStopped: false, temporaryStateRemoved: false, devtoolsEndpointClosed: false } };
} finally {
  for (const page of pages) page.cdp.close();
  if (browser) {
    for (const contextId of contexts) await browser.send("Target.disposeBrowserContext", { browserContextId: contextId }).catch(() => {});
    browser.close();
  }
  await Promise.all([stop(chrome), stop(staging)]);
  await rm(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
invariant(result, "run_incomplete");
result.cleanup = { processGroupsStopped: true, temporaryStateRemoved: true, devtoolsEndpointClosed: true };
await mkdir(path.join(evidenceRoot, "screenshots"), { recursive: true, mode: 0o700 });
for (const [name, bytes] of captures) await writeFile(path.join(evidenceRoot, "screenshots", name), bytes, { mode: 0o600 });
await writeFile(evidenceFile, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ status: result.status, evidence: path.relative(root, evidenceFile),
  viewerP75Ms: result.viewerDiagnostic.p75ViewerUsableMs,
  a11yFindings: result.accessibility.definiteFindings, indeterminate: result.accessibility.indeterminate,
  diagnostics: result.diagnostics, cleanup: result.cleanup }, null, 2)}\n`);
