import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  ZINE_LAYOUTS,
  createZineBook,
  createZinePageController,
  createZinePrintModel,
  materializeZinePage,
  planZineShareStrip,
  renderZineSharePng,
  splitZineText,
  zinePageFilename
} from "../public/zine-book.js";

function photos(count, overrides = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: `chosen-${index + 1}`,
    src: `blob:photo-${index + 1}`,
    alt: `第 ${index + 1} 张照片`,
    caption: `原话 ${index + 1}`,
    ...overrides
  }));
}

test("2–24 张照片确定性生成封面、四类内容页和尾页", () => {
  for (const count of [2, 3, 7, 24]) {
    const first = createZineBook({ photos: photos(count), date: "2026-09-01" });
    const second = createZineBook({ photos: photos(count), date: "2026-09-01" });
    assert.deepEqual(first, second);
    assert.equal(first.shapeId, "zine");
    assert.equal(first.pages[0].kind, "cover");
    assert.equal(first.pages.at(-1).kind, "closing");
    const layouts = new Set(first.pages.map((page) => page.layout));
    for (const layout of ZINE_LAYOUTS) assert.ok(layouts.has(layout), `${count} 张缺少 ${layout}`);
  }
});

test("每张照片第一次进入内容页的顺序与用户选择顺序一致", () => {
  const book = createZineBook({ photos: photos(12) });
  const firstOccurrences = [];
  for (const page of book.pages.filter((item) => ["full-photo", "duo", "grid"].includes(item.layout))) {
    for (const ref of page.photoRefs) {
      if (!firstOccurrences.includes(ref)) firstOccurrences.push(ref);
    }
  }
  assert.deepEqual(firstOccurrences, Array.from({ length: 12 }, (_, index) => index));
});

test("照片数量和风格边界明确拒绝无效输入", () => {
  assert.throws(() => createZineBook({ photos: photos(1) }), /2–24/u);
  assert.throws(() => createZineBook({ photos: photos(25) }), /2–24/u);
  assert.throws(() => createZineBook({ photos: photos(2), styleId: "mystery" }), /未知 zine 风格/u);
  assert.throws(() => createZineBook({ photos: photos(2), shapeId: "poster" }), /不支持形态/u);
});

test("长中文分块不丢字、不补字", () => {
  const source = "那天的风很大，但我们还是沿着海边慢慢走了很久。".repeat(30);
  const chunks = splitZineText(source, 53);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => Array.from(chunk).length <= 53));
  assert.equal(chunks.join(""), source);
});

test("用户原话只作为文本保存，页面模型不生成 HTML", async () => {
  const unsafe = '<img src=x onerror="globalThis.pwned=true">我记得那盏灯';
  const book = createZineBook({ photos: photos(2, { caption: unsafe }) });
  const print = createZinePrintModel(book);
  assert.equal(print.shapeId, "zine");
  assert.ok(print.pages.some((page) => page.text === unsafe));
  assert.equal(materializeZinePage(book, 0).photos[0].caption, unsafe);
  const source = await readFile(new URL("../public/zine-book.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../public/zine-book.css", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.innerHTML\s*=/u);
  assert.match(source, /\.textContent\s*=/u);
  assert.match(css, /@media print[\s\S]*\.zine-pager\s*\{[\s\S]*display:\s*none !important/u);
});

test("翻页控制器夹住边界，并只接受明确的横向快速滑动", () => {
  const changes = [];
  const controller = createZinePageController({ pageCount: 4, onChange: (state) => changes.push(state.index) });
  assert.equal(controller.previous().index, 0);
  assert.equal(controller.handleSwipe({ deltaX: -80, deltaY: 9, durationMs: 240 }).state.index, 1);
  assert.equal(controller.handleSwipe({ deltaX: -80, deltaY: 75, durationMs: 240 }).changed, false);
  assert.equal(controller.handleSwipe({ deltaX: -80, deltaY: 0, durationMs: 900 }).changed, false);
  assert.equal(controller.goTo(99).index, 3);
  assert.equal(controller.next().index, 3);
  assert.deepEqual(changes, [1, 3]);
});

test("打印模型解析照片引用并保留页码", () => {
  const book = createZineBook({ photos: photos(4), styleId: "black-fragments" });
  const print = createZinePrintModel(book);
  assert.equal(print.styleId, "black-fragments");
  assert.equal(print.pages[0].pageNumber, 1);
  assert.equal(print.pages.at(-1).pageNumber, print.pages.length);
  assert.equal(print.pages[0].photos[0].id, "chosen-1");
});

test("分享长图规划保持顺序且限制在常见浏览器画布高度内", () => {
  const plan = planZineShareStrip(Array.from({ length: 15 }, () => ({ width: 1080, height: 1440 })));
  assert.ok(plan.width >= 240 && plan.width <= 720);
  assert.ok(plan.height <= 15_800);
  assert.equal(plan.placements.length, 15);
  assert.ok(plan.placements.every((placement, index) => index === 0 || placement.y > plan.placements[index - 1].y));
  const mixed = planZineShareStrip([
    { width: 1080, height: 1440 },
    { width: 540, height: 1440 },
    { width: 1080, height: 1440 }
  ], { maximumHeight: 3000 });
  assert.ok(mixed.height <= 3000, "different page widths must still honor the browser canvas ceiling");
});

test("分享长图逐页合成，不先持有整套 1080px 页画布", async () => {
  const book = createZineBook({ photos: photos(2) });
  const created = [];
  const canvasFactory = (width, height) => {
    created.push({ width, height });
    const context = {
      fillStyle: "",
      font: "",
      textAlign: "start",
      fillRect() {},
      fillText() {},
      drawImage() {},
      measureText(value) { return { width: Array.from(String(value)).length * 10 }; }
    };
    return {
      width,
      height,
      getContext: () => context,
      toBlob(callback) { callback(new Blob(["png"], { type: "image/png" })); }
    };
  };
  const blob = await renderZineSharePng(book, {
    canvasFactory,
    loadImage: async () => ({ naturalWidth: 100, naturalHeight: 100 })
  });
  assert.equal(blob.type, "image/png");
  assert.equal(created.length, book.pages.length + 1);
  assert.ok(created.slice(1).every(({ width }) => width <= 720));
});

test("逐页下载文件名稳定并去除文件系统保留字符", () => {
  const book = createZineBook({ photos: photos(2), title: '海边/重逢:*?"' });
  assert.equal(zinePageFilename(book, 0), "海边-重逢--01.png");
  assert.equal(zinePageFilename(book, 9), "海边-重逢--10.png");
});
