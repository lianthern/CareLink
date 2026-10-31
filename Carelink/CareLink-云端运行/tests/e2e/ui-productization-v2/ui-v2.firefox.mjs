import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

process.umask(0o077);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const origin = process.env.UNSEEN_UI_ORIGIN || "http://127.0.0.1:4286";
const firefox = process.env.UNSEEN_FIREFOX_BINARY || "/tmp/unseen-firefox-stage-rc-tools/Firefox.app/Contents/MacOS/firefox";
const geckodriver = process.env.UNSEEN_GECKODRIVER || "/tmp/unseen-firefox-stage-rc-tools/geckodriver";
const port = Number(process.env.UNSEEN_UI_GECKODRIVER_PORT || 9486);
const evidenceRoot = resolve(root, "release-evidence/local-operable/ui-v2");
const screenshotRoot = resolve(evidenceRoot, "screenshots");
await mkdir(screenshotRoot, { recursive: true, mode: 0o700 });

const driver = spawn(geckodriver, ["--host", "127.0.0.1", "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
const delay = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
async function poll(operation, label, timeout = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { const value = await operation(); if (value) return value; } catch {}
    await delay(75);
  }
  throw new Error(`ui_v2_firefox_timeout:${label}`);
}
async function webdriver(method, route, body) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method, headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000)
  });
  const payload = await response.json();
  if (!response.ok || payload.value?.error) throw new Error(`ui_v2_firefox_webdriver:${method}:${route}:${response.status}:${payload.value?.error || "unknown"}`);
  return payload.value;
}
function invariant(value, message) { if (!value) throw new Error(message); }

let sessionId;
try {
  await poll(async () => (await fetch(`http://127.0.0.1:${port}/status`)).ok, "geckodriver");
  const session = await webdriver("POST", "/session", { capabilities: { alwaysMatch: {
    browserName: "firefox", pageLoadStrategy: "normal", acceptInsecureCerts: false,
    "moz:firefoxOptions": { binary: firefox, args: ["-headless"] }
  } } });
  sessionId = session.sessionId;
  await webdriver("POST", `/session/${sessionId}/window/rect`, { x: 0, y: 0, width: 1440, height: 1000 });
  const evaluate = (script, args = []) => webdriver("POST", `/session/${sessionId}/execute/sync`, { script, args });
  const element = async (selector) => poll(async () => {
    try { return await webdriver("POST", `/session/${sessionId}/element`, { using: "css selector", value: selector }); } catch { return null; }
  }, `element:${selector}`);
  const currentPath = async () => new URL(await webdriver("GET", `/session/${sessionId}/url`)).pathname;
  async function click(selector, expectedPath) {
    const target = await element(selector);
    await webdriver("POST", `/session/${sessionId}/element/${target["element-6066-11e4-a52e-4f735466cecf"]}/click`, {});
    if (expectedPath) await poll(async () => await currentPath() === expectedPath, `click:${selector}`, expectedPath.includes("versions") ? 30_000 : 15_000);
  }
  async function audit(label) {
    const result = await evaluate(`return (()=>{const controls=[...document.querySelectorAll('button,a[href],input,textarea,select,summary')].filter(node=>node.getClientRects().length);const name=node=>(node.getAttribute('aria-label')||node.labels?.[0]?.textContent||node.textContent||node.value||'').trim();const text=document.body.innerText;return{label:${JSON.stringify(label)},path:location.pathname,title:document.title,fixtureNotice:text.includes('本地确定性样本')&&text.includes('非真实 AI')&&text.includes('不代表正式发布'),sampleBoundary:text.includes('向晚婚礼')&&text.includes('AdventureX 2026')&&text.includes('不是同一组数据'),developerTerms:[...text.matchAll(/BL0[1-6]|Manifest|HTML|PDF|打开打印|同源对账/g)].map(match=>match[0]),horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1,unnamedControls:controls.filter(node=>!name(node)).map(node=>node.outerHTML.slice(0,120)),externalResources:performance.getEntriesByType('resource').map(entry=>entry.name).filter(value=>{try{const url=new URL(value);return !['data:','blob:'].includes(url.protocol)&&url.origin!==location.origin}catch{return true}})}})()`);
    invariant(result.fixtureNotice && !result.horizontalOverflow && !result.developerTerms.length && !result.unnamedControls.length && !result.externalResources.length,
      `ui_v2_firefox_audit:${label}:${JSON.stringify(result)}`);
    return result;
  }
  async function screenshot(name) {
    const value = await webdriver("GET", `/session/${sessionId}/screenshot`);
    await writeFile(resolve(screenshotRoot, `${name}.png`), Buffer.from(value, "base64"), { mode: 0o600 });
  }

  await webdriver("POST", `/session/${sessionId}/url`, { url: `${origin}/` });
  const results = [await audit("home")];
  await webdriver("POST", `/session/${sessionId}/actions`, { actions: [{ type: "key", id: "keyboard", actions: [{ type: "keyDown", value: "\uE004" }, { type: "keyUp", value: "\uE004" }] }] });
  const focus = await evaluate("return {tag:document.activeElement?.tagName,text:(document.activeElement?.innerText||document.activeElement?.getAttribute('aria-label')||'').trim(),outline:getComputedStyle(document.activeElement).outlineStyle}");
  invariant(focus.tag === "A" && focus.text && focus.outline !== "none", `ui_v2_firefox_focus:${JSON.stringify(focus)}`);
  await screenshot("firefox-1440-home");
  await click(".home-actions .button-primary", "/s/space-gongguang/album");
  results.push(await audit("space"));
  await click(".photo-card a", "/s/space-gongguang/photos/photo-1");
  const photo = await audit("photo");
  invariant(photo.sampleBoundary, `ui_v2_firefox_sample_disclosure_missing:${JSON.stringify(photo)}`);
  results.push(photo);
  await click(".memory-bridge a", "/labs/memories/photos/photo-01");
  results.push(await audit("BL01"));
  await click('[data-action="MEMORY.START_QUESTION"]', "/labs/memories/memory-01");
  await click('[data-action="MEMORY.CONFIRM"]', "/labs/books/book-adventurex-night/contributions/memory-01");
  await click(".explicit-consent input");
  await click('[data-action="BOOK_MEMORY.AUTHORIZE"]');
  await click('[data-entry="BL04"]', "/manage/space-adventurex-2026/book-lab");
  await click('[data-action="BOOK.CREATE"]', "/manage/space-adventurex-2026/book-lab/book-adventurex-night/draft");
  await click('[data-action="BOOK.FREEZE"]', "/s/space-adventurex-2026/books/book-adventurex-night/versions/book-version-02");
  results.push(await audit("BL06"));
  await screenshot("firefox-1440-book");

  const evidence = {
    schema: "unseen-ui-productization-v2-firefox/1", status: "PASS", origin,
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    browser: { name: "Mozilla Firefox", version: session.capabilities.browserVersion, headless: true },
    driver: execFileSync(geckodriver, ["--version"], { encoding: "utf8" }).split("\n")[0],
    fixture: true, representativePath: ["home", "space", "photo", "BL01", "BL02", "BL03", "BL04", "BL05", "BL06"],
    keyboardFocus: focus, externalResources: results.flatMap((result) => result.externalResources),
    fileInputBoundary: "not exercised in this slice; DataTransfer remains the declared file-input automation boundary", results
  };
  await writeFile(resolve(evidenceRoot, "FIREFOX-REPRESENTATIVE-PATH.json"), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ status: "UI_PRODUCTIZATION_V2_FIREFOX_OK", evidence: resolve(evidenceRoot, "FIREFOX-REPRESENTATIVE-PATH.json"), path: evidence.representativePath }, null, 2)}\n`);
} finally {
  if (sessionId) await webdriver("DELETE", `/session/${sessionId}`).catch(() => {});
  if (driver.exitCode === null) driver.kill("SIGTERM");
  await Promise.race([once(driver, "exit"), delay(2_000)]).catch(() => {});
}
