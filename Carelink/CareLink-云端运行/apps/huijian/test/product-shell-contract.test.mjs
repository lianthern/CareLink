import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const shell = await readFile(new URL("../public/product-shell.js", import.meta.url), "utf8");
const style = await readFile(new URL("../public/style.css", import.meta.url), "utf8");

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function elementWithId(id) {
  const match = html.match(new RegExp(`<[^>]+id="${escapeRegExp(id)}"[^>]*>`, "u"));
  assert.ok(match, `missing #${id}`);
  return match[0];
}

function selectorBody(selector) {
  const match = style.match(new RegExp(`${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`, "u"));
  assert.ok(match, `missing selector ${selector}`);
  return match[1];
}

test("the original single-photo, voice, spatial and export hooks remain present", () => {
  for (const id of [
    "photo-input", "chat-photo", "voice-toggle", "effect-spatial", "memory-particles",
    "memory-page", "result-photo", "download-memory", "print-memory", "edit-memory", "restart"
  ]) elementWithId(id);
});

test("the upload entry accepts multiple supported photos before conversation", () => {
  const input = elementWithId("photo-input");
  assert.match(input, /\smultiple(?:\s|>)/u);
  assert.match(input, /accept="image\/jpeg,image\/png,image\/webp"/u);
  assert.match(shell, /MAX_PHOTOS\s*=\s*24/u);
  assert.match(shell, /event\.stopImmediatePropagation\(\)/u);
  assert.match(shell, /dataset\.shellCommit/u);
});

test("shape and style choices use the frozen shared IDs", () => {
  const shapeValues = [...html.matchAll(/name="result-shape"\s+value="([^"]+)"/gu)].map((match) => match[1]);
  const styleValues = [...html.matchAll(/name="result-style"\s+value="([^"]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(shapeValues, ["memory-page", "poster", "zine", "spatial"]);
  assert.deepEqual(styleValues, ["evening-paper", "black-fragments", "quiet-white"]);
  assert.match(elementWithId("screen-shape"), /\shidden(?:\s|>)/u);
  assert.match(shell, /screen === "result" && !productChosen/u);
});

test("zine is enabled only for two or more selected photos", () => {
  assert.match(shell, /const enabled = count >= 2/u);
  assert.match(shell, /\$\("shape-zine"\)\.disabled = !enabled/u);
  assert.match(shell, /files: \[\.\.\.selectedFiles\]/u);
});

test("local-library and UNSEEN boundaries are explicit and honest", () => {
  assert.match(html, /保存在这台设备的这个浏览器里/u);
  assert.match(html, /不会自动同步到账号或 UNSEEN/u);
  assert.match(html, /回见里的本机合集不会自动同步过去/u);
  assert.match(html, /href="https:\/\/unseen\.maxxam\.xyz"/u);
  assert.doesNotMatch(html, /已同步|账号已连接|云端已保存/u);
});

test("shell integration events keep storage and zine implementations independent", () => {
  for (const eventName of [
    "huijian:photos-selected", "huijian:selection-confirmed", "huijian:photo-session-ready",
    "huijian:product-confirm", "huijian:memory-save",
    "huijian:library-request", "huijian:collection-action"
  ]) assert.match(shell, new RegExp(escapeRegExp(eventName), "u"));
  assert.match(shell, /window\.huijianProductShell/u);
});

test("compacted and reopened sessions release original file URLs and retain their real photo count", () => {
  assert.match(shell, /addEventListener\("huijian:photo-session-ready"/u);
  assert.match(shell, /revokePreviews\(\);\s*selectedFiles = \[\]/u);
  assert.match(shell, /const count = selectedPreviews\.length \|\| selectedFiles\.length \|\| 1/u);
});

test("reopened product choices remain checked when the user edits them", () => {
  assert.match(shell, /shapeOption\.checked = true/u);
  assert.match(shell, /styleOption\.checked = true/u);
});

test("shape and style changes update only the real-photo draft preview before submit", () => {
  assert.match(shell, /function syncProductPreview\(\)/u);
  assert.match(shell, /querySelectorAll\("\[data-product-preview-photo\]"\)/u);
  assert.match(shell, /preview\.dataset\.shape = shape/u);
  assert.match(shell, /preview\.dataset\.style = style/u);
  assert.match(shell, /label\.textContent = SHAPE_LABELS\[shape\]/u);
  const changeStart = shell.indexOf('$("product-controls").addEventListener("change"');
  const changeEnd = shell.indexOf("\n});", changeStart);
  const changeHandler = shell.slice(changeStart, changeEnd);
  assert.match(changeHandler, /syncProductPreview\(\)/u);
  assert.doesNotMatch(changeHandler, /dispatchEvent|product-confirm|showResult/u);
});

test("the result stage stays black and a single photo does not render a redundant result rail", () => {
  assert.match(shell, /content = "#050505"/u);
  assert.match(shell, /if \(previews\.length <= 1\) target\.replaceChildren\(\)/u);
  assert.match(shell, /resultRail\.hidden = previews\.length <= 1/u);
  assert.match(shell, /\$\("screen-result"\)\.dataset\.photoCount = String\(previews\.length\)/u);
  assert.equal(shell.match(/正在排成一本 zine……/gu)?.length, 1);
});

test("library state is assigned once and mixed valid/empty selection reports the partial failure", () => {
  assert.equal(
    shell.match(/libraryCollections = Array\.isArray\(collections\) \? collections : \[\];/gu)?.length,
    1,
    "renderLibrary must not repeat the same state assignment"
  );
  assert.match(
    shell,
    /const options = \{\s*rejectedType: result\.rejectedType,\s*rejectedSize: result\.rejectedSize,\s*rejectedEmpty: result\.rejectedEmpty\s*\};/u
  );
  assert.match(shell, /if \(rejectedEmpty\) parts\.push\(`\$\{rejectedEmpty\} 张照片文件为空，已跳过。`\)/u);
});

test("new mobile controls meet the 48px touch contract", () => {
  for (const selector of [
    ".library-entry", ".selection-icon-action", ".shape-option", ".style-option",
    ".library-row", ".danger-action", ".memory-dialog input"
  ]) {
    const match = selectorBody(selector).match(/min-height:\s*([\d.]+)px/u);
    assert.ok(match, `${selector} needs an explicit min-height`);
    assert.ok(Number(match[1]) >= 48, `${selector} is shorter than 48px`);
  }
});

test("desktop result keeps a left-photo, middle-preview, right-control layout", () => {
  assert.match(selectorBody(".result-workspace"), /min-width:\s*0/u);
  assert.match(style, /grid-template-columns:\s*minmax\(9rem, 12rem\) minmax\(28rem, 42rem\) minmax\(15rem, 19rem\)/u);
  assert.match(selectorBody(".result-photo-rail"), /max-width:\s*100%/u);
  assert.match(selectorBody(".shape-strip"), /max-width:\s*100%/u);
});
