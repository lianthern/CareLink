import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const styleSource = await readFile(new URL("../public/style.css", import.meta.url), "utf8");
const caddySource = await readFile(new URL("../deploy/Caddyfile.huijian", import.meta.url), "utf8");
const indexSource = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../public/manifest.json", import.meta.url), "utf8"));
const shellSource = await readFile(new URL("../public/product-shell.js", import.meta.url), "utf8");

function handlerBody(source, eventStart) {
  const start = source.indexOf(eventStart);
  assert.notEqual(start, -1, `missing handler: ${eventStart}`);
  const end = source.indexOf("\n});", start);
  assert.notEqual(end, -1, `unterminated handler: ${eventStart}`);
  return source.slice(start, end);
}

function selectorBody(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "u"));
  assert.ok(match, `missing selector: ${selector}`);
  return match[1];
}

function minHeight(source, selector) {
  const match = selectorBody(source, selector).match(/min-height:\s*([\d.]+)px/u);
  assert.ok(match, `missing pixel min-height: ${selector}`);
  return Number(match[1]);
}

test("opening the print dialog does not count as a successful export", () => {
  const printHandler = handlerBody(
    appSource,
    '$("print-memory").addEventListener("click", () => {'
  );

  assert.match(printHandler, /window\.print\(\)/u);
  assert.doesNotMatch(printHandler, /hasExported\s*=\s*true/u);
});

test("mobile photo controls keep at least 48px-tall touch targets", () => {
  assert.ok(minHeight(styleSource, ".back-action") >= 48);
  assert.ok(minHeight(styleSource, ".effect-switch button") >= 48);
});

test("the narrow chat toolbar can wrap without forcing horizontal overflow", () => {
  assert.match(selectorBody(styleSource, ".chat-topline"), /flex-wrap:\s*wrap/u);
  const switchRules = selectorBody(styleSource, ".effect-switch");
  assert.match(switchRules, /max-width:\s*100%/u);
  assert.match(switchRules, /min-width:\s*0/u);
});

test("the public preview permits same-origin microphone input without opening camera access", () => {
  assert.match(caddySource, /Permissions-Policy "camera=\(\), microphone=\(self\), geolocation=\(\)"/u);
  assert.doesNotMatch(caddySource, /microphone=\(\)/u);
});

test("the product entrance stays neutral black while finished paper may stay light", () => {
  assert.match(styleSource, /--stage-black:\s*#050505/u);
  assert.match(styleSource, /body\[data-screen="result"\][^{]*\{[^}]*background:\s*var\(--stage-black\)/su);
  assert.match(styleSource, /\.memory-page\s*\{[^}]*background:\s*var\(--photo-paper\)/su);
  assert.match(indexSource, /name="theme-color" content="#050505"/u);
  assert.equal(manifest.background_color, "#050505");
  assert.equal(manifest.theme_color, "#050505");
  const neutralTheme = /querySelector\('meta\[name="theme-color"\]'\)\.content = "#050505"/u;
  assert.match(appSource, neutralTheme);
  assert.match(shellSource, neutralTheme);
});
