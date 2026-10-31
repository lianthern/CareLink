import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

test("multi-photo confirmation compacts every readable photo but only asks about the primary photo", () => {
  assert.match(app, /const files = \[\.\.\.event\.target\.files\]/u);
  assert.match(app, /for \(const \[index, file\] of accepted\.entries\(\)\)/u);
  assert.match(app, /startConversation\(photos\[0\], photos\)/u);
  assert.match(app, /photo: state\.photo\.payload/u);
  assert.doesNotMatch(app, /photos:\s*state\.photos\s*,\s*kind:/u);
});

test("ordered selection bypasses DataTransfer and stale compaction cannot reopen a cancelled session", () => {
  assert.match(app, /addEventListener\("huijian:selection-confirmed"/u);
  assert.match(app, /event\.preventDefault\(\);\s*startWithUpload\(files\)/u);
  assert.match(app, /const uploadGeneration = \+\+state\.uploadGeneration/u);
  assert.match(app, /if \(uploadGeneration !== state\.uploadGeneration\) return/u);
  assert.match(app, /addEventListener\("huijian:photo-selection-cancel"/u);
});

test("one confirmed answer reaches product choice before a forced second AI question", () => {
  assert.match(app, /if \(state\.pairs\.length === 1\) return showDecision\(\)/u);
  assert.match(app, /window\.huijianProductShell\.openShapePicker\(\)/u);
});

test("product selection is actually handled by page, poster and zine renderers", () => {
  assert.match(app, /addEventListener\("huijian:product-confirm"/u);
  assert.match(app, /event\.preventDefault\(\)/u);
  assert.match(app, /renderPosterPng/u);
  assert.match(app, /createZineBook/u);
  assert.match(app, /mountZinePreview/u);
  assert.match(app, /renderZineSharePng/u);
  assert.match(app, /renderZinePagePngFiles/u);
  assert.match(html, /id="download-zine-pages"/u);
  assert.match(html, /id="zine-page-downloads"/u);
});

test("local save and destructive delete wait for truthful storage callbacks", () => {
  assert.match(app, /addEventListener\("huijian:memory-save"/u);
  assert.match(app, /await store\.saveMemory/u);
  assert.match(app, /event\.detail\.complete\(`已保存到本机合集/u);
  assert.match(app, /event\.detail\.fail\("这次没有保存成功/u);
  assert.match(app, /await store\.deleteCollection\(collection\.id\)/u);
  assert.match(app, /event\.detail\.complete\?\.\(\)/u);
});

test("empty default collection does not suppress the honest library empty state", () => {
  assert.match(app, /filter\(\(collection\) => Number\(collection\.memoryCount\) > 0\)/u);
});

test("reopening a memory preserves its collection as the default overwrite target", () => {
  assert.match(app, /function restoreStoredMemory\(memory, collection\)/u);
  assert.match(app, /\$\("save-collection-name"\)\.value = collection\?\.name \|\| "这一年"/u);
  assert.match(app, /restoreStoredMemory\(memory, collection\)/u);
});
