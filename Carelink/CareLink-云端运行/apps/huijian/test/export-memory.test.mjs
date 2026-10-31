import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateMemoryCanvasHeight,
  calculatePosterCanvasHeight,
  downloadBlob,
  posterWords,
  resolveMemoryExportStyle,
  wrapText
} from "../public/export-memory.js";

const context = {
  measureText(value) {
    return { width: Array.from(value).length * 10 };
  }
};

test("wrapText preserves every character while wrapping Chinese text", () => {
  const source = "照片里的灯亮着，我们刚从海边回来。";
  const lines = wrapText(context, source, 60);
  assert.ok(lines.length > 1);
  assert.equal(lines.join(""), source);
  assert.ok(lines.every((line) => context.measureText(line).width <= 60));
});

test("wrapText preserves intentional blank lines", () => {
  assert.deepEqual(wrapText(context, "第一段\n\n第二段", 200), ["第一段", "", "第二段"]);
});

test("PNG height expands for long answers instead of clipping them", () => {
  const shortHeight = calculateMemoryCanvasHeight([
    { promptLines: ["问题"], answerLines: ["回答"] }
  ]);
  const longHeight = calculateMemoryCanvasHeight([
    { promptLines: ["问题"], answerLines: Array.from({ length: 20 }, () => "很长的一行回答") }
  ]);

  assert.equal(shortHeight, 1754);
  assert.equal(longHeight, 2276);
  assert.ok(longHeight > shortHeight);
});

test("downloadBlob keeps a persistent fallback link usable", () => {
  let clicks = 0;
  const anchor = {
    hidden: true,
    click() { clicks += 1; }
  };
  const url = downloadBlob(new Blob(["png"]), "回见.png", anchor);

  assert.match(url, /^blob:/u);
  assert.equal(anchor.href, url);
  assert.equal(anchor.download, "回见.png");
  assert.equal(anchor.hidden, false);
  assert.equal(clicks, 1);
  URL.revokeObjectURL(url);
});

test("poster keeps all confirmed user words without model prompts", () => {
  assert.equal(posterWords([
    { question: "问题一", answer: "第一段原话" },
    { question: "问题二", answer: "第二段\n原话" }
  ]), "第一段原话\n\n第二段\n原话");
});

test("poster canvas expands for long original words", () => {
  assert.equal(calculatePosterCanvasHeight(1), 1754);
  assert.ok(calculatePosterCanvasHeight(20) > 1754);
});

test("memory PNG export follows the selected style with an explicit fallback", () => {
  assert.equal(resolveMemoryExportStyle("black-fragments").background, "#0c0c0c");
  assert.equal(resolveMemoryExportStyle("quiet-white").background, "#ffffff");
  assert.deepEqual(
    resolveMemoryExportStyle("unknown-style"),
    resolveMemoryExportStyle("evening-paper")
  );
});
