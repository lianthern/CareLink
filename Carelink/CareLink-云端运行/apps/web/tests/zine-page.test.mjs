import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homePage, startUploadPage, zineCopy, zinePage } from "../src/ui/templates.js";
import { flipbookMarkup, pickerMarkup, ZINE_DEMO_SOURCES } from "../src/zine/zine-app.js";

// 三分钟纪念册 (zine tool, v0): a purely local, no-backend companion tool. These tests only cover
// the string-rendered entry points (home link, start-upload card, the /zine shell itself) --
// the canvas layout engine has its own coverage in zine-layout.test.mjs, and the interactive
// flip/export behaviour in src/zine/zine-app.js is verified by hand in a real browser (see the
// delivery report), the same way this codebase already treats the panorama viewer.

function withStubbedDocument(run) {
  const priorDocument = globalThis.document;
  globalThis.document = { title: "" };
  try { return run(); }
  finally { globalThis.document = priorDocument; }
}

const loggedOutState = { account: null, capabilities: {}, spaces: [], currentSpaceId: "", debug: false };

test("home page links to /zine at the same quiet tier as the existing /open shortcut, not as a fourth nav card", () => {
  withStubbedDocument(() => {
    const html = homePage(loggedOutState);
    // UI v4 调和：quiet link 前置 SVG 图标（与 /open 链接同风格），断言允许可选图标
    assert.match(html, /href="\/zine" data-nav>(?:<svg[\s\S]*?<\/svg>)?拍了很多照片？三分钟做一本纪念册<\/a>/);
    // Still exactly three nav cards -- the zine entry must not compete with them.
    assert.equal((html.match(/class="card interactive-card nav-card"/g) || []).length, 3);
    // Both quiet links sit at the same level, after the card grid.
    assert.match(html, /已有邀请链接或二维码？直接打开<\/a>\s*<a class="text-link" href="\/zine"/);
  });
});

test("start-upload page offers a third card for the zine tool alongside the existing two", () => {
  withStubbedDocument(() => {
    const html = startUploadPage(loggedOutState);
    assert.match(html, /href="\/zine" data-nav/);
    assert.match(html, /三分钟做一本纪念册/);
    assert.match(html, /选好照片，马上生成翻页小书/);
  });
});

test("zinePage renders the local-only privacy disclosure and an empty mount point for the JS layer", () => {
  withStubbedDocument(() => {
    const html = zinePage(loggedOutState);
    assert.match(html, /三分钟做一本纪念册/);
    assert.match(html, /照片只在你的手机\/电脑上处理，不会上传、不会保存。/);
    assert.match(html, /<div id="zine-mount" data-zine-mount aria-live="polite"><\/div>/);
    // No backend action wired to this route -- it must never emit a data-action attribute.
    assert.doesNotMatch(html, /data-action=/);
  });
});

test("zinePage never throws on a minimal/anonymous state and sets a distinct document title", () => {
  withStubbedDocument(() => {
    zinePage({ account: null, capabilities: {}, spaces: [], currentSpaceId: "" });
    assert.equal(document.title, "三分钟纪念册 · UNSEEN");
  });
});

test("zineCopy centralizes the tool's copy in one exported object, same convention as homeV3Copy", () => {
  assert.equal(zineCopy.entryCard.title, "三分钟做一本纪念册");
  assert.equal(zineCopy.title, "三分钟做一本纪念册");
});

function workbenchState(overrides = {}) {
  return {
    files: [],
    thumbUrls: [],
    sourceOrientations: [],
    title: "我们的小书",
    templateId: "story",
    formatId: "portrait",
    formatTouched: false,
    sortMode: "selection",
    ...overrides
  };
}

test("the empty workbench has one primary action plus a one-click bundled demo", () => {
  const html = pickerMarkup(workbenchState());
  assert.equal((html.match(/button-primary/g) || []).length, 1);
  assert.match(html, /data-zine-file-input/);
  assert.match(html, /data-zine-demo>先用 6 张合成示例试排/);
  assert.match(html, /适合屏幕分享或家用打印 \/ 存 PDF，不是商业印刷文件/);
  assert.match(html, /不会复制或上传任何二进制/);
});

test("the bundled demo is six rights-clean synthetic scenes, not a release-blocked photo asset", () => {
  assert.equal(ZINE_DEMO_SOURCES.length, 6);
  assert.ok(ZINE_DEMO_SOURCES.every((source) => source.kind === "synthetic-demo" &&
    source.type === "image/svg+xml" && source.src.startsWith("data:image/svg+xml,")));
  assert.doesNotMatch(JSON.stringify(ZINE_DEMO_SOURCES), /\/assets\/photos|\/assets\/panorama/u);
});

test("the populated workbench exposes three proof strips, three ratios, two sorts, and one primary action", () => {
  const html = pickerMarkup(workbenchState({
    files: ZINE_DEMO_SOURCES,
    thumbUrls: ZINE_DEMO_SOURCES.map((source) => source.src),
    sortMode: "file-time",
    formatId: "square",
    templateId: "gallery"
  }));
  assert.equal((html.match(/button-primary/g) || []).length, 1);
  assert.equal((html.match(/data-zine-proof="/g) || []).length, 3);
  assert.match(html, /故事流/);
  assert.match(html, /留白画廊/);
  assert.match(html, /热闹拼贴/);
  assert.equal((html.match(/data-zine-format-shape="/g) || []).length, 3);
  assert.match(html, /竖版小书/);
  assert.match(html, /方形相册/);
  assert.match(html, /横版画册/);
  assert.equal((html.match(/data-zine-sort/g) || []).length, 2);
  assert.match(html, /安全边距/);
});

test("real-photo orientation recommends and preselects the safer finished ratio", () => {
  const html = pickerMarkup(workbenchState({
    files: [{ name: "wide-1.jpg" }, { name: "wide-2.jpg" }, { name: "tall.jpg" }],
    thumbUrls: ["blob:wide-1", "blob:wide-2", "blob:tall"],
    sourceOrientations: ["landscape", "landscape", "portrait"],
    formatId: "landscape"
  }));
  assert.match(html, /横图 2/);
  assert.match(html, /竖图 1/);
  assert.match(html, /这组照片更适合横版画册/);
  assert.match(html, /已替你选好。仍有 1 张不同方向的照片可能被裁切。/);
  assert.match(html, /data-zine-format-shape="landscape"/);
  assert.equal((html.match(/zine-format-recommended/g) || []).length, 1);
});

test("a manual format choice is preserved and receives a concrete crop-risk warning", () => {
  const html = pickerMarkup(workbenchState({
    files: [{ name: "wide-1.jpg" }, { name: "wide-2.jpg" }, { name: "tall.jpg" }],
    thumbUrls: ["blob:wide-1", "blob:wide-2", "blob:tall"],
    sourceOrientations: ["landscape", "landscape", "portrait"],
    formatId: "portrait",
    formatTouched: true
  }));
  assert.match(html, /你现在选的是竖版小书；2 张不同方向的照片可能被明显裁切。/);
  assert.match(html, /value="portrait" data-zine-format checked/);
});

test("a decode failure is rendered as a visible, escaped alert", () => {
  const html = pickerMarkup(workbenchState(), `无法读取「bad<script>.heic」。`);
  assert.match(html, /role="alert"/);
  assert.match(html, /bad&lt;script&gt;\.heic/);
  assert.doesNotMatch(html, /bad<script>/);
});

test("the finished view binds the chosen ratio to flipbook and print, with one primary export", () => {
  const html = flipbookMarkup(workbenchState({ title: `春日 <相册>`, templateId: "collage", formatId: "landscape" }));
  assert.equal((html.match(/button-primary/g) || []).length, 1);
  assert.match(html, /data-zine-format="landscape" style="--zine-page-ratio: 1200 \/ 900"/);
  assert.match(html, /data-zine-print-sheet data-zine-format="landscape"/);
  assert.match(html, /热闹拼贴 · 横版画册 4:3/);
  assert.match(html, /分享与家用 PDF，不是含出血线的商业印刷稿/);
  assert.match(html, /春日 &lt;相册&gt;/);
  assert.doesNotMatch(html, /春日 <相册>/);
});

test("print CSS maps each finished ratio to a distinct physical home-print size", () => {
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(styles, /zine-print-sheet\[data-zine-format="portrait"\][^{]*\{[^}]*120mm;[^}]*160mm;/);
  assert.match(styles, /zine-print-sheet\[data-zine-format="square"\][^{]*\{[^}]*150mm;[^}]*150mm;/);
  assert.match(styles, /zine-print-sheet\[data-zine-format="landscape"\][^{]*\{[^}]*180mm;[^}]*135mm;/);
  assert.match(styles, /\.zine-print-page \{[^}]*object-fit: contain;[^}]*break-after: page;/);
});

test("the workbench caps a small local book and stores encoded pages instead of full-size canvases", () => {
  const source = readFileSync(new URL("../src/zine/zine-app.js", import.meta.url), "utf8");
  assert.match(source, /const MAX_FILES = 20;/);
  assert.match(source, /pageArtifacts/);
  assert.match(source, /canvasToBlob\(canvas\)/);
  assert.match(source, /image\.src = page\.url;/, "printing must reuse the encoded full-resolution page");
  assert.match(source, /URL\.revokeObjectURL\(page\.url\)/);
  assert.doesNotMatch(source, /state\.canvases/);
  assert.doesNotMatch(source, /canvas\.toDataURL\("image\/png"\)/);
});

test("share export is a phone-friendly single vertical strip", () => {
  const source = readFileSync(new URL("../src/zine/zine-app.js", import.meta.url), "utf8");
  assert.match(source, /const contentWidth = 540;/);
  assert.match(source, /sheet\.width = pad \* 2 \+ contentWidth;/);
  assert.match(source, /sheet\.height = pad \* 2 \+ state\.pageArtifacts\.length \* pageHeight/);
  assert.match(source, /context\.drawImage\(image, pad, pad \+ index \* \(pageHeight \+ gap\), contentWidth, pageHeight\)/);
  assert.doesNotMatch(source, /const cols = 4;/);
});

test("file focus and the 320px format selector stay visibly usable", () => {
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.zine-file-button:focus-within \{[^}]*outline:/);
  assert.match(styles, /\.zine-format-grid \{[^}]*repeat\(auto-fit, minmax\(100px, 1fr\)\)/);
});
