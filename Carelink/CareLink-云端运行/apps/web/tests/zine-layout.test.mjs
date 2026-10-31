import test from "node:test";
import assert from "node:assert/strict";
import {
  buildZinePages,
  classifyZineOrientation,
  defaultZineTitle,
  getZineBookTemplate,
  getZineFormat,
  orderZineIndexes,
  recommendZineFormat,
  ZINE_ACCENT_CAPTIONS,
  ZINE_BOOK_TEMPLATES,
  ZINE_FORMATS,
  ZINE_ORIENTATIONS,
  ZINE_SORT_MODES,
  ZINE_TEMPLATES,
  zineCropRiskCount
} from "../src/zine/layout.js";

test("buildZinePages returns nothing for zero or negative photo counts", () => {
  assert.deepEqual(buildZinePages(0), []);
  assert.deepEqual(buildZinePages(-3), []);
  assert.deepEqual(buildZinePages(NaN), []);
});

test("a single photo becomes just a cover + closing page", () => {
  const pages = buildZinePages(1);
  assert.equal(pages.length, 2);
  assert.deepEqual(pages[0], { type: ZINE_TEMPLATES.COVER, images: [0] });
  assert.equal(pages[1].type, ZINE_TEMPLATES.CLOSING);
  assert.deepEqual(pages[1].images, []);
});

test("every book starts with a one-image cover and ends with an image-less closing page", () => {
  for (const count of [1, 2, 3, 4, 5, 9, 17, 40, 80]) {
    const pages = buildZinePages(count);
    assert.equal(pages[0].type, ZINE_TEMPLATES.COVER, `count=${count}`);
    assert.deepEqual(pages[0].images, [0], `count=${count}`);
    assert.equal(pages.at(-1).type, ZINE_TEMPLATES.CLOSING, `count=${count}`);
    assert.deepEqual(pages.at(-1).images, [], `count=${count}`);
  }
});

test("every photo index is used exactly once, in ascending selection order, across all pages", () => {
  for (const count of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 17, 33, 80]) {
    const pages = buildZinePages(count);
    const used = pages.flatMap((page) => page.images);
    assert.deepEqual(used, Array.from({ length: count }, (_, index) => index), `count=${count}`);
  }
});

test("each template consumes exactly the number of photos its layout needs", () => {
  const capacity = { [ZINE_TEMPLATES.COVER]: 1, [ZINE_TEMPLATES.FULL]: 1, [ZINE_TEMPLATES.DUO]: 2, [ZINE_TEMPLATES.ACCENT]: 1, [ZINE_TEMPLATES.CLOSING]: 0 };
  for (const count of [5, 17, 33, 80]) {
    for (const page of buildZinePages(count)) {
      if (page.type === ZINE_TEMPLATES.GRID) { assert.ok([3, 4].includes(page.images.length), `grid page has ${page.images.length} images`); continue; }
      assert.equal(page.images.length, capacity[page.type], `${page.type} page (count=${count})`);
    }
  }
});

test("a template downgrades gracefully when too few photos remain to fill it (no template ever runs out of photos)", () => {
  // count=4: cover(0) leaves 3 remaining; rhythm's first slot is FULL (1), leaving 2 for DUO -- no
  // downgrade needed here, but this and the count=3/count=2 cases below cover the boundary where a
  // GRID or DUO slot in the rhythm would otherwise be asked for more photos than exist.
  for (const count of [2, 3, 4, 6, 7]) {
    const pages = buildZinePages(count);
    for (const page of pages) {
      assert.ok(Object.values(ZINE_TEMPLATES).includes(page.type), `count=${count} unknown template ${page.type}`);
    }
  }
});

test("interior pages rotate through full/duo/grid templates with periodic accent breather pages for a long book", () => {
  const pages = buildZinePages(40);
  const interior = pages.slice(1, -1); // drop cover and closing
  const types = new Set(interior.map((page) => page.type));
  assert.ok(types.has(ZINE_TEMPLATES.FULL));
  assert.ok(types.has(ZINE_TEMPLATES.DUO));
  assert.ok(types.has(ZINE_TEMPLATES.GRID));
  assert.ok(types.has(ZINE_TEMPLATES.ACCENT), "a long book must include at least one breather/accent page");
  // Rhythm, not randomness: never two accent pages back to back.
  for (let i = 1; i < interior.length; i += 1) {
    if (interior[i].type === ZINE_TEMPLATES.ACCENT) assert.notEqual(interior[i - 1].type, ZINE_TEMPLATES.ACCENT);
  }
});

test("accent pages carry a caption drawn from the fixed caption list, cycling deterministically", () => {
  const pages = buildZinePages(80);
  const accentPages = pages.filter((page) => page.type === ZINE_TEMPLATES.ACCENT);
  assert.ok(accentPages.length > 1, "80 photos should produce more than one accent page");
  accentPages.forEach((page) => assert.ok(ZINE_ACCENT_CAPTIONS.includes(page.caption)));
  assert.equal(accentPages[0].caption, ZINE_ACCENT_CAPTIONS[0]);
});

test("buildZinePages is a pure function: same input always produces a deep-equal result", () => {
  assert.deepEqual(buildZinePages(23), buildZinePages(23));
});

test("defaultZineTitle formats a Chinese date string with the fixed book-name prefix", () => {
  const title = defaultZineTitle(new Date(2026, 7, 16)); // August is month index 7
  assert.equal(title, "我们的小书 · 2026年8月16日");
});

test("the three frozen book templates have visibly different deterministic rhythms", () => {
  const templates = Object.values(ZINE_BOOK_TEMPLATES);
  assert.deepEqual(templates.map((template) => template.id), ["story", "gallery", "collage"]);
  assert.ok(templates.every(Object.isFrozen));
  assert.ok(templates.every((template) => Object.isFrozen(template.rhythm)));

  const firstFive = (templateId) => buildZinePages(40, templateId).slice(1, 6).map((page) => page.type);
  assert.deepEqual(firstFive("story"), ["full", "duo", "grid", "full", "accent"]);
  assert.deepEqual(firstFive("gallery"), ["accent", "full", "accent", "duo", "accent"]);
  assert.deepEqual(firstFive("collage"), ["grid", "duo", "grid", "full", "grid"]);
});

test("every template consumes every photo exactly once without changing its input order", () => {
  for (const template of Object.values(ZINE_BOOK_TEMPLATES)) {
    for (const count of [1, 2, 5, 17, 80]) {
      const used = buildZinePages(count, template.id).flatMap((page) => page.images);
      assert.deepEqual(used, Array.from({ length: count }, (_, index) => index), `${template.id} count=${count}`);
    }
  }
});

test("book template and format lookups fail closed to the portrait story defaults", () => {
  assert.equal(getZineBookTemplate("missing"), ZINE_BOOK_TEMPLATES.STORY);
  assert.equal(getZineFormat("missing"), ZINE_FORMATS.PORTRAIT);
});

test("the three finished ratios expose their exact canvas and home-print dimensions", () => {
  assert.deepEqual(
    Object.values(ZINE_FORMATS).map(({ id, ratio, width, height, printWidthMm, printHeightMm }) => ({ id, ratio, width, height, printWidthMm, printHeightMm })),
    [
      { id: "portrait", ratio: "3:4", width: 840, height: 1120, printWidthMm: 120, printHeightMm: 160 },
      { id: "square", ratio: "1:1", width: 1080, height: 1080, printWidthMm: 150, printHeightMm: 150 },
      { id: "landscape", ratio: "4:3", width: 1200, height: 900, printWidthMm: 180, printHeightMm: 135 }
    ]
  );
  for (const format of Object.values(ZINE_FORMATS)) {
    const horizontalPpi = format.width / (format.printWidthMm / 25.4);
    const verticalPpi = format.height / (format.printHeightMm / 25.4);
    assert.ok(Math.min(horizontalPpi, verticalPpi) >= 150, `${format.id} must stay above 150 effective PPI`);
  }
});

test("photo dimensions classify into a restrained portrait/square/landscape contact sheet", () => {
  assert.equal(classifyZineOrientation(3024, 4032), ZINE_ORIENTATIONS.PORTRAIT);
  assert.equal(classifyZineOrientation(1080, 1080), ZINE_ORIENTATIONS.SQUARE);
  assert.equal(classifyZineOrientation(4032, 3024), ZINE_ORIENTATIONS.LANDSCAPE);
  assert.equal(classifyZineOrientation(111, 100), ZINE_ORIENTATIONS.SQUARE, "near-square photos stay neutral");
  assert.equal(classifyZineOrientation(0, 100), ZINE_ORIENTATIONS.UNKNOWN);
  assert.equal(classifyZineOrientation("bad", 100), ZINE_ORIENTATIONS.UNKNOWN);
});

test("the dominant real-photo orientation recommends a format while ties stay honest", () => {
  const landscape = recommendZineFormat(["landscape", "landscape", "landscape", "portrait", "unknown"]);
  assert.equal(landscape.formatId, ZINE_FORMATS.LANDSCAPE.id);
  assert.equal(landscape.knownCount, 4);
  assert.deepEqual(landscape.counts, { portrait: 1, square: 0, landscape: 3, unknown: 1 });
  assert.equal(zineCropRiskCount(landscape, ZINE_FORMATS.LANDSCAPE.id), 1);
  assert.equal(zineCropRiskCount(landscape, ZINE_FORMATS.PORTRAIT.id), 3);

  const tie = recommendZineFormat(["portrait", "landscape", "unknown"]);
  assert.equal(tie.formatId, null);
  assert.equal(tie.knownCount, 2);
  assert.equal(zineCropRiskCount(tie, "missing"), 0);
});

test("photo ordering supports stable selection order and oldest-to-newest file time", () => {
  const files = [
    { name: "third.jpg", lastModified: 300 },
    { name: "first.jpg", lastModified: 100 },
    { name: "unknown.jpg", lastModified: 0 },
    { name: "second-a.jpg", lastModified: 200 },
    { name: "second-b.jpg", lastModified: 200 }
  ];
  assert.deepEqual(orderZineIndexes(files, ZINE_SORT_MODES.SELECTION), [0, 1, 2, 3, 4]);
  assert.deepEqual(orderZineIndexes(files, ZINE_SORT_MODES.FILE_TIME), [1, 3, 4, 0, 2]);
  assert.deepEqual(orderZineIndexes(files, "unknown-mode"), [0, 1, 2, 3, 4]);
});
