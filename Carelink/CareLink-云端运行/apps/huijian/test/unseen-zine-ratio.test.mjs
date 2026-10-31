import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ZINE_FORMATS, classifyZineOrientation, recommendZineFormat, recommendZineRatio,
  createZineBook, createZinePrintModel, renderZinePageElement, renderZinePageCanvas,
  renderZinePagePngFiles, renderZineSharePng, planZineShareStrip
} from "../public/zine-book.js";

function mixedPhotos() {
  return Array.from({ length: 12 }, (_, index) => ({
    id: `memory-photo-${index + 1}`, src: `blob:memory-photo-${index + 1}`,
    width: index % 3 === 0 ? 1600 : index % 3 === 1 ? 900 : 1000,
    height: index % 3 === 0 ? 900 : index % 3 === 1 ? 1600 : 1000,
    caption: `第${index + 1}张独立图注。`,
    pairs: [{ question: "这张照片之外还有什么？", answer: `第${index + 1}张原话：${"我记得风和笑声，还有没拍到的小事。".repeat(12)}👨‍👩‍👧‍👦` }]
  }));
}
function recordingCanvas() {
  const canvases = [];
  const canvasFactory = (width, height) => {
    const draws = [];
    const context = {
      font: "20px sans-serif", fillStyle: "", textAlign: "start",
      fillRect(x, y, width, height) { draws.push({ type: "rect", x, y, width, height }); },
      fillText(text, x, y) {
        const fontSize = Number.parseFloat(this.font.match(/[\d.]+px/u)?.[0] || "20");
        draws.push({ type: "text", text, x, y, fontSize });
      },
      drawImage(image, ...coordinates) { draws.push({ type: "image", image, coordinates }); },
      // Conservative full-em measurement: narrow Latin characters receive no special discount.
      measureText(value) {
        const fontSize = Number.parseFloat(this.font.match(/[\d.]+px/u)?.[0] || "20");
        const segments = [...new Intl.Segmenter("zh", { granularity: "grapheme" }).segment(String(value))];
        return { width: segments.length * fontSize };
      }
    };
    const canvas = { width, height, draws, getContext: () => context,
      toBlob(callback) { callback(new Blob([JSON.stringify({ width, height })], { type: "image/png" })); } };
    canvases.push(canvas);
    return canvas;
  };
  return { canvases, canvasFactory, loadImage: async (src) => ({ src, naturalWidth: 1600, naturalHeight: 900 }) };
}
function documentFixture() {
  return { createElement(tag) { return {
    tag, dataset: {}, children: [], attributes: {},
    style: { properties: {}, setProperty(key, value) { this.properties[key] = value; } },
    setAttribute(key, value) { this.attributes[key] = value; },
    append(...children) { this.children.push(...children); }
  }; } };
}

test("recommendation retains canonical 1.12 neutral band and declines tied or unknown inputs", () => {
  assert.equal(classifyZineOrientation(1120, 1000), "landscape");
  assert.equal(classifyZineOrientation(1000, 1121), "portrait");
  assert.equal(classifyZineOrientation(1110, 1000), "square");
  assert.equal(classifyZineOrientation(0, 0), "unknown");
  assert.equal(recommendZineRatio(mixedPhotos()).formatId, null);
  assert.equal(recommendZineRatio([{}, {}]).ratio, null);
  assert.deepEqual(recommendZineFormat(["landscape", "landscape", "portrait", "unknown"]), {
    counts: { portrait: 1, square: 0, landscape: 2, unknown: 1 }, knownCount: 3, totalCount: 4, formatId: "landscape"
  });
  assert.equal(recommendZineRatio([{ naturalWidth: 1600, naturalHeight: 900 }]).ratio, "4:3");
});

test("manual ratio always wins; absence of a selection retains the existing 1080×1440 portrait default", () => {
  const photos = mixedPhotos().map((photo) => ({ ...photo, width: 1600, height: 900 }));
  assert.equal(recommendZineRatio(photos).formatId, "landscape");
  const defaultBook = createZineBook({ photos });
  assert.deepEqual(defaultBook.pageSize, { width: 1080, height: 1440 });
  assert.equal(defaultBook.pageAspect, "portrait");
  assert.equal(createZineBook({ photos, ratio: "1:1" }).pageAspect, "square");
  assert.equal(createZineBook({ photos, pageAspect: "portrait", ratio: "4:3" }).pageAspect, "portrait");
  assert.throws(() => createZineBook({ photos, ratio: "16:9" }), /未知小书比例/);
});

for (const format of Object.values(ZINE_FORMATS)) {
  test(`${format.id}: mixed 12-photo model consumes all selected photos and every original answer/caption`, () => {
    const photos = mixedPhotos();
    const quote = "整本书的原话：这一天值得留下。";
    const book = createZineBook({ photos, pageAspect: format.id, quote });
    const referenced = new Set(book.pages.flatMap((page) => page.photoRefs));
    assert.deepEqual([...referenced].sort((a, b) => a - b), Array.from({ length: 12 }, (_, index) => index));
    const firstUsed = [...new Set(book.pages.filter((page) => page.kind === "content").flatMap((page) => page.photoRefs))];
    assert.deepEqual(firstUsed, Array.from({ length: 12 }, (_, index) => index));
    const fullText = book.pages.filter((page) => page.source === "user").map((page) => page.text).join("");
    assert.equal(fullText, quote + photos.map((photo) => photo.pairs[0].answer + photo.caption).join(""));
    assert.deepEqual(createZinePrintModel(book).pageSize, { width: format.width, height: format.height });
    const node = renderZinePageElement(book, 0, documentFixture());
    assert.equal(node.dataset.pageAspect, format.id);
    assert.equal(node.style.properties["--zine-page-aspect"], `${format.width} / ${format.height}`);
  });

  test(`${format.id}: every PNG page follows the chosen ratio and places complete narratives inside canvas bounds`, async () => {
    const book = createZineBook({ photos: mixedPhotos(), pageAspect: format.id });
    const renderer = recordingCanvas();
    const outputs = await renderZinePagePngFiles(book, renderer);
    assert.equal(outputs.length, book.pages.length);
    const drawnPhotos = new Set();
    for (const [index, canvas] of renderer.canvases.entries()) {
      assert.equal(canvas.width, format.width);
      assert.equal(canvas.height, format.height);
      for (const draw of canvas.draws) {
        if (draw.type === "image") drawnPhotos.add(draw.image.src);
        if (draw.type === "text") {
          assert.ok(draw.x >= 0 && draw.x <= canvas.width);
          assert.ok(draw.y >= 0 && draw.y <= canvas.height, `${format.id}/${index} text baseline ${draw.y} outside ${canvas.height}`);
        }
      }
      const page = book.pages[index];
      if (page.layout === "text-break") {
        const text = canvas.draws.filter((draw) => draw.type === "text").map((draw) => draw.text).join("");
        assert.ok(text.includes(page.text.replace(/\r?\n/gu, "")), `${page.id} lost part of its narrative`);
      }
    }
    assert.equal(drawnPhotos.size, 12);
    await assert.rejects(renderZinePageCanvas(book, 0, { ...renderer, width: 720, height: 720 * format.height / format.width + 100 }), /zine_page_ratio_mismatch/);
  });

  test(`${format.id}: share strip uses the same page geometry and print advertises matching physical ratio`, async () => {
    const photos = mixedPhotos().map((photo) => ({ ...photo, pairs: [{ answer: "这句原话不截断。" }] }));
    const book = createZineBook({ photos, pageAspect: format.id });
    const renderer = recordingCanvas();
    const blob = await renderZineSharePng(book, renderer);
    assert.equal(blob.type, "image/png");
    assert.equal(renderer.canvases.length, book.pages.length + 1);
    for (const page of renderer.canvases.slice(1)) assert.ok(Math.abs(page.height - page.width * format.height / format.width) <= 1);
    const print = createZinePrintModel(book);
    assert.equal(print.printSizeMm.width / print.printSizeMm.height, format.width / format.height);
  });
}

test("many explicit line breaks and long question text are paginated without dropping any original text", async () => {
  const answer = Array.from({ length: 24 }, (_, index) => `原话行${index + 1}`).join("\n");
  const question = "长问题也要完整保留。".repeat(20);
  const book = createZineBook({ photos: [{ src: "blob:a", pairs: [{ question, answer }] }, { src: "blob:b" }], pageAspect: "landscape" });
  assert.equal(book.pages.filter((page) => page.source === "user").map((page) => page.text).join(""), answer);
  assert.equal(book.pages.filter((page) => page.source === "question").map((page) => page.text).join(""), question);
  const renderer = recordingCanvas();
  await renderZinePagePngFiles(book, renderer);
  for (const canvas of renderer.canvases) assert.ok(canvas.draws.filter((draw) => draw.type === "text").every((draw) => draw.y <= canvas.height));
});

test("overlong share strips fail explicitly instead of truncating pages or allocating an oversized canvas", () => {
  assert.throws(() => planZineShareStrip(Array.from({ length: 100 }, () => ({ width: 1080, height: 1440 }))), { code: "zine_share_too_tall" });
});

test("print CSS preserves page ratio and exposes entire paginated text instead of scroll-box clipping", async () => {
  const css = await readFile(new URL("../public/zine-book.css", import.meta.url), "utf8");
  assert.match(css, /aspect-ratio:\s*var\(--zine-page-aspect, 3 \/ 4\)/);
  assert.match(css, /@page zine-landscape \{ size: 180mm 135mm/);
  assert.match(css, /@page zine-square \{ size: 150mm 150mm/);
  assert.match(css, /max-block-size: none; overflow: visible/);
});
