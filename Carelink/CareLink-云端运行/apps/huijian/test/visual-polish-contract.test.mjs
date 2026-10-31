import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const style = await readFile(new URL("../public/style.css", import.meta.url), "utf8");

function elementWithId(id) {
  const match = html.match(new RegExp(`<[^>]+id="${id}"[^>]*>`, "u"));
  assert.ok(match, `missing #${id}`);
  return match[0];
}

test("the folded-photo mascot is absent and A-Jian remains plain text", () => {
  assert.doesNotMatch(html, /agent-paper|agent-eye|agent-fold|阿见，一张会折角的小相片/u);
  assert.doesNotMatch(style, /\.agent-paper|\.agent-eye|\.agent-fold/u);
  assert.doesNotMatch(elementWithId("chat-agent"), /role="img"/u);
  assert.match(html, /id="status-text">阿见正在看这张照片……</u);
  assert.match(html, /<strong>阿见看到了：<\/strong>/u);
});

test("the entrance is a real upload slot instead of a detached CTA", () => {
  assert.match(elementWithId("upload-start"), /class="photo-entry"/u);
  assert.match(elementWithId("upload-start"), /aria-label="选择 1 到 24 张照片"/u);
  assert.match(elementWithId("photo-input"), /\smultiple(?:\s|>)/u);
  assert.match(style, /\.photo-entry\s*\{[^}]*min-height:\s*48px/su);
});

test("shape and style choices expose eight real-photo preview hooks", () => {
  assert.equal((html.match(/data-product-preview-photo/gu) ?? []).length, 8);
  for (const shape of ["memory-page", "poster", "zine", "spatial"]) {
    assert.match(html, new RegExp(`data-preview-shape="${shape}"`, "u"));
    assert.match(style, new RegExp(`data-preview-shape="${shape}"`, "u"));
  }
  for (const visualStyle of ["evening-paper", "black-fragments", "quiet-white"]) {
    assert.match(html, new RegExp(`data-preview-style="${visualStyle}"`, "u"));
    assert.match(style, new RegExp(`data-preview-style="${visualStyle}"`, "u"));
  }
  assert.match(elementWithId("shape-preview"), /data-shape="memory-page" data-style="evening-paper"/u);
  assert.match(elementWithId("shape-preview-photo"), /data-product-preview-photo/u);
});

test("the outer result stage stays black while paper remains a contained material", () => {
  assert.match(style, /body\[data-screen="result"\]\s*\{[^}]*background:\s*var\(--stage-black\)/su);
  assert.match(style, /\.memory-page\s*\{[^}]*background:\s*var\(--photo-paper\)/su);
  assert.doesNotMatch(style, /body\[data-screen="result"\][^{]*\{[^}]*background:\s*var\(--photo-paper\)/su);
  assert.match(style, /\.result-screen\[data-photo-count="1"\] \.result-workspace/su);
});

test("conversation and memory-page photos preserve intrinsic ratio by default", () => {
  assert.match(style, /#chat-photo\s*\{[^}]*height:\s*auto[^}]*object-fit:\s*contain/su);
  assert.match(style, /\.memory-photo-wrap img\s*\{[^}]*height:\s*auto[^}]*object-fit:\s*contain/su);
  assert.match(style, /\.memory-page\[data-shape="poster"\] \.memory-photo-wrap img\s*\{[^}]*aspect-ratio:\s*4 \/ 5/su);
});

test("visual motion has an explicit reduced-motion mode", () => {
  assert.match(style, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(style, /#memory-particles,[\s\S]*#result-memory-particles\s*\{\s*display:\s*none/su);
  assert.match(style, /\.shape-preview\[data-shape="spatial"\] \.shape-preview-paper/su);
});
