import test from "node:test";
import assert from "node:assert/strict";

import {
  RESULT_SHAPES,
  VISUAL_STYLES,
  assertProductSelection,
  chooseDefaultShape,
  createMemoryRecord,
  normalizeStyleId,
  resultShapeOptions
} from "../public/memory-product.js";

test("product shape and style ids stay stable", () => {
  assert.deepEqual(RESULT_SHAPES.map(({ id }) => id), ["memory-page", "poster", "zine", "spatial"]);
  assert.deepEqual(VISUAL_STYLES.map(({ id }) => id), ["evening-paper", "black-fragments", "quiet-white"]);
});

test("one photo cannot pretend to be a book and multiple photos default to zine", () => {
  const single = resultShapeOptions(1);
  assert.equal(single.find(({ id }) => id === "zine").available, false);
  assert.match(single.find(({ id }) => id === "zine").reason, /至少选择 2 张/u);
  assert.equal(chooseDefaultShape(1), "memory-page");
  assert.equal(chooseDefaultShape(2), "zine");
  assert.throws(
    () => assertProductSelection({ photoCount: 1, resultShape: "zine", styleId: "evening-paper" }),
    /至少选择 2 张/u
  );
});

test("multi-photo selection may still use its primary photo for a single-photo output", () => {
  const options = resultShapeOptions(3);
  for (const id of ["memory-page", "poster", "spatial"]) {
    assert.equal(options.find((option) => option.id === id).available, true);
    assert.match(options.find((option) => option.id === id).notice, /第一张主照片/u);
  }
  assert.equal(options.find((option) => option.id === "zine").available, true);
  assert.equal(assertProductSelection({ photoCount: 3, resultShape: "poster", styleId: "quiet-white" }), true);
});

test("every product rejects more than 24 photos and zine never exceeds its frozen range", () => {
  for (const resultShape of ["memory-page", "poster", "zine", "spatial"]) {
    const option = resultShapeOptions(25).find(({ id }) => id === resultShape);
    assert.equal(option.available, false);
    assert.match(option.reason, /最多选择 24 张/u);
    assert.throws(
      () => assertProductSelection({ photoCount: 25, resultShape, styleId: "evening-paper" }),
      /最多选择 24 张/u
    );
  }
});

test("style fallback is explicit and stable", () => {
  assert.equal(normalizeStyleId("black-fragments"), "black-fragments");
  assert.equal(normalizeStyleId("missing"), "evening-paper");
  assert.equal(normalizeStyleId("missing", "quiet-white"), "quiet-white");
});

test("memory records require photos and confirmed user words", () => {
  const record = createMemoryRecord({
    id: "memory-1",
    collectionId: "year-2026",
    photos: [{ id: "photo-1", src: "data:image/jpeg;base64,AA==" }],
    facts: ["桌上有一只杯子", "", "不会被带入"],
    pairs: [{ question: "你想留下什么？", answer: "这是第一次一起旅行。" }],
    resultShape: "poster",
    styleId: "quiet-white",
    createdAt: "2026-09-01T00:00:00.000Z"
  });
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.photos.length, 1);
  assert.deepEqual(record.facts, ["桌上有一只杯子", "不会被带入"]);
  assert.equal(record.pairs[0].answer, "这是第一次一起旅行。");

  assert.throws(() => createMemoryRecord({
    id: "memory-2",
    collectionId: "year-2026",
    photos: [{ src: "photo.jpg" }],
    pairs: [],
    resultShape: "memory-page",
    styleId: "evening-paper"
  }), /memory_requires_user_words/u);
});
