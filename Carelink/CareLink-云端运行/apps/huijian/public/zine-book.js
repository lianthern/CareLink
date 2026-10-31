import { wrapText } from "./export-memory.js";

export const ZINE_LIMITS = Object.freeze({ minimumPhotos: 2, maximumPhotos: 24 });
export const ZINE_PAGE_SIZE = Object.freeze({ width: 1080, height: 1440 });
// Same orientation neutral band and unique-majority recommendation as canonical Book Studio.
export const ZINE_FORMATS = Object.freeze({
  PORTRAIT: Object.freeze({ id: "portrait", label: "竖版小书", ratio: "3:4", width: 1080, height: 1440, printWidthMm: 120, printHeightMm: 160 }),
  SQUARE: Object.freeze({ id: "square", label: "方形相册", ratio: "1:1", width: 1080, height: 1080, printWidthMm: 150, printHeightMm: 150 }),
  LANDSCAPE: Object.freeze({ id: "landscape", label: "横版画册", ratio: "4:3", width: 1440, height: 1080, printWidthMm: 180, printHeightMm: 135 })
});
export function classifyZineOrientation(width, height) {
  width = Number(width); height = Number(height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return "unknown";
  const ratio = width / height;
  return ratio >= 1.12 ? "landscape" : ratio <= 1 / 1.12 ? "portrait" : "square";
}
export function recommendZineFormat(orientations = []) {
  const counts = { portrait: 0, square: 0, landscape: 0, unknown: 0 };
  for (const orientation of orientations) counts[Object.hasOwn(counts, orientation) ? orientation : "unknown"] += 1;
  const ranked = ["portrait", "square", "landscape"].sort((left, right) => counts[right] - counts[left]);
  const knownCount = orientations.length - counts.unknown;
  const formatId = knownCount && counts[ranked[0]] > counts[ranked[1]] ? ranked[0] : null;
  return Object.freeze({ counts: Object.freeze(counts), knownCount, totalCount: orientations.length, formatId });
}
export function recommendZineRatio(photos = []) {
  const summary = recommendZineFormat(photos.map((photo) => classifyZineOrientation(
    photo?.naturalWidth ?? photo?.width, photo?.naturalHeight ?? photo?.height
  )));
  const format = Object.values(ZINE_FORMATS).find((entry) => entry.id === summary.formatId);
  return Object.freeze({ ...summary, ratio: format?.ratio ?? null });
}
function resolveZineFormat(pageAspect, ratio) {
  const selected = pageAspect ?? ratio ?? "portrait";
  const format = Object.values(ZINE_FORMATS).find((entry) => entry.id === selected || entry.ratio === selected ||
    (typeof selected === "number" && Math.abs(entry.width / entry.height - selected) < 0.0001));
  if (!format) throw new RangeError(`未知小书比例：${selected}`);
  return format;
}
function bookFormat(book) { return resolveZineFormat(book.pageAspect, book.ratio); }
function sourceLabel(source) { return source === "user" ? "你的原话" : source === "question" ? "提问" : "回见"; }

export const ZINE_LAYOUTS = Object.freeze(["full-photo", "duo", "grid", "text-break"]);
export const ZINE_STYLE_IDS = Object.freeze(["evening-paper", "black-fragments", "quiet-white"]);

const THEMES = Object.freeze({
  "evening-paper": Object.freeze({
    background: "#fff9ea",
    foreground: "#26333d",
    muted: "#65717a",
    accent: "#b64942",
    frame: "#efe5cf"
  }),
  "black-fragments": Object.freeze({
    background: "#0c0c0c",
    foreground: "#fff9ea",
    muted: "#aab5bc",
    accent: "#f2c55c",
    frame: "#262626"
  }),
  "quiet-white": Object.freeze({
    background: "#fdfdfb",
    foreground: "#26333d",
    muted: "#758089",
    accent: "#8bc4de",
    frame: "#e9edef"
  })
});

function cleanText(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").trim();
}

function stablePhotoId(value, index) {
  const candidate = cleanText(value).replace(/[^\p{Letter}\p{Number}_.-]+/gu, "-").slice(0, 80);
  return candidate || `photo-${String(index + 1).padStart(2, "0")}`;
}

function normalizePairs(photo) {
  const pairs = Array.isArray(photo?.pairs) ? photo.pairs : [];
  const normalized = pairs.flatMap((pair) => {
    const question = cleanText(pair?.question);
    const answer = cleanText(pair?.answer);
    return answer ? [{ question, answer }] : [];
  });
  const answer = cleanText(photo?.answer);
  if (answer && !normalized.some((pair) => pair.answer === answer)) {
    normalized.push({ question: cleanText(photo?.question), answer });
  }
  return normalized;
}

function normalizePhoto(photo, index) {
  if (!photo || typeof photo !== "object") throw new TypeError(`第 ${index + 1} 张照片无效。`);
  const src = cleanText(photo.src ?? photo.dataUrl ?? photo.objectUrl);
  if (!src) throw new TypeError(`第 ${index + 1} 张照片缺少可预览地址。`);
  return Object.freeze({
    id: stablePhotoId(photo.id, index),
    src,
    alt: cleanText(photo.alt, `第 ${index + 1} 张照片`),
    caption: cleanText(photo.caption),
    date: cleanText(photo.date),
    pairs: Object.freeze(normalizePairs(photo).map((pair) => Object.freeze(pair)))
  });
}

function splitGraphemes(value) {
  if (globalThis.Intl?.Segmenter) {
    return Array.from(new Intl.Segmenter("zh-CN", { granularity: "grapheme" }).segment(value), ({ segment }) => segment);
  }
  return Array.from(value);
}

export function splitZineText(value, maximumGraphemes = 180) {
  if (!Number.isInteger(maximumGraphemes) || maximumGraphemes < 1) {
    throw new RangeError("maximumGraphemes 必须是正整数。");
  }
  const text = cleanText(value);
  if (!text) return [];
  const graphemes = splitGraphemes(text);
  const chunks = [];
  for (let index = 0; index < graphemes.length; index += maximumGraphemes) {
    chunks.push(graphemes.slice(index, index + maximumGraphemes).join(""));
  }
  return chunks;
}

function pageFactory() {
  let index = 0;
  return (page) => Object.freeze({
    id: `page-${String(++index).padStart(3, "0")}`,
    ...page
  });
}

function fillGridRefs(primary, photoCount) {
  const refs = [...primary];
  for (let index = 0; refs.length < Math.min(4, photoCount); index += 1) {
    const candidate = index % photoCount;
    if (!refs.includes(candidate)) refs.push(candidate);
  }
  return refs;
}

function collectTextBreaks(photos, explicitQuote, pageAspect) {
  const narratives = [];
  const quote = cleanText(explicitQuote);
  if (quote) narratives.push({ text: quote, question: "", source: "user" });
  for (const photo of photos) {
    for (const pair of photo.pairs) narratives.push({ ...pair, text: pair.answer, source: "user" });
    if (photo.caption && !photo.pairs.some((pair) => pair.answer === photo.caption)) narratives.push({ text: photo.caption, question: "", source: "user" });
  }
  if (!narratives.length) {
    narratives.push({ text: "照片之外，留下的是你说过的话。", question: "", source: "system" });
  }
  const maximum = { portrait: 180, square: 140, landscape: 100 }[pageAspect];
  // Newlines consume vertical room too. Break on grapheme boundaries and retain every character.
  const chunks = (value) => {
    const output = []; let text = ""; let cost = 0;
    for (const character of splitGraphemes(value)) {
      const weight = /[\r\n]/u.test(character) ? Math.ceil(maximum / 7) : 1;
      if (text && cost + weight > maximum) { output.push(text); text = ""; cost = 0; }
      text += character; cost += weight;
    }
    if (text) output.push(text);
    return output;
  };
  return narratives.flatMap((narrative) => {
    const question = narrative.question || "";
    const separateQuestion = splitGraphemes(question).length > 40 || question.includes("\n");
    const questionPages = separateQuestion ? chunks(question).map((text, index) => ({ text, question: "", source: "question", continuation: index > 0 })) : [];
    return [...questionPages, ...chunks(narrative.text).map((text, chunkIndex) => ({
      ...narrative, text, question: separateQuestion || chunkIndex > 0 ? "" : question, continuation: chunkIndex > 0
    }))];
  });
}

function contentPages(photos, makePage, explicitQuote, pageAspect) {
  const pages = [];
  let cursor = 0;
  let cycle = 0;
  while (cursor < photos.length) {
    const layout = ZINE_LAYOUTS[cycle % 3];
    if (layout === "full-photo") {
      pages.push(makePage({ kind: "content", layout, photoRefs: Object.freeze([cursor]) }));
      cursor += 1;
    } else if (layout === "duo") {
      const primary = Array.from({ length: Math.min(2, photos.length - cursor) }, (_, offset) => cursor + offset);
      cursor += primary.length;
      if (primary.length < 2) primary.push(cursor > 1 ? 0 : Math.min(1, photos.length - 1));
      pages.push(makePage({ kind: "content", layout, photoRefs: Object.freeze(primary) }));
    } else {
      const primary = Array.from({ length: Math.min(4, photos.length - cursor) }, (_, offset) => cursor + offset);
      cursor += primary.length;
      pages.push(makePage({
        kind: "content",
        layout,
        photoRefs: Object.freeze(fillGridRefs(primary, photos.length))
      }));
    }
    cycle += 1;
  }

  const presentLayouts = new Set(pages.map((page) => page.layout));
  if (!presentLayouts.has("duo")) {
    pages.push(makePage({ kind: "content", layout: "duo", photoRefs: Object.freeze([0, 1]) }));
  }
  if (!presentLayouts.has("grid")) {
    pages.push(makePage({
      kind: "content",
      layout: "grid",
      photoRefs: Object.freeze(fillGridRefs([], photos.length))
    }));
  }

  const textPages = collectTextBreaks(photos, explicitQuote, pageAspect).map((narrative) => makePage({
    kind: "content",
    layout: "text-break",
    photoRefs: Object.freeze([]),
    text: narrative.text,
    question: narrative.question,
    source: narrative.source,
    continuation: narrative.continuation
  }));
  const insertion = Math.min(2, pages.length);
  pages.splice(insertion, 0, ...textPages);
  return pages;
}

export function createZineBook({
  photos,
  shapeId = "zine",
  title = "回见",
  date = new Date().toISOString().slice(0, 10),
  author = "",
  quote = "",
  styleId = "evening-paper",
  pageAspect,
  ratio
} = {}) {
  if (!Array.isArray(photos)) throw new TypeError("photos 必须是照片数组。");
  if (shapeId !== "zine") throw new RangeError(`zine 引擎不支持形态：${shapeId}`);
  if (photos.length < ZINE_LIMITS.minimumPhotos || photos.length > ZINE_LIMITS.maximumPhotos) {
    throw new RangeError(`zine 需要 ${ZINE_LIMITS.minimumPhotos}–${ZINE_LIMITS.maximumPhotos} 张照片。`);
  }
  if (!ZINE_STYLE_IDS.includes(styleId)) throw new RangeError(`未知 zine 风格：${styleId}`);
  const format = resolveZineFormat(pageAspect, ratio);
  const normalizedPhotos = Object.freeze(photos.map(normalizePhoto));
  const makePage = pageFactory();
  const cleanTitle = cleanText(title, "回见");
  const cleanDate = cleanText(date);
  const cleanAuthor = cleanText(author);
  const pages = [makePage({
    kind: "cover",
    layout: "cover",
    photoRefs: Object.freeze([0]),
    title: cleanTitle,
    meta: [cleanDate, `共 ${normalizedPhotos.length} 张`].filter(Boolean).join(" · ")
  })];
  pages.push(...contentPages(normalizedPhotos, makePage, quote, format.id));
  pages.push(makePage({
    kind: "closing",
    layout: "closing",
    photoRefs: Object.freeze([]),
    text: "照片是它看的，话是你说的。"
  }));

  return Object.freeze({
    id: "huijian-zine",
    version: 1,
    shapeId,
    title: cleanTitle,
    date: cleanDate,
    author: cleanAuthor,
    styleId,
    pageAspect: format.id,
    ratio: format.ratio,
    pageSize: Object.freeze({ width: format.width, height: format.height }),
    photoCount: normalizedPhotos.length,
    photos: normalizedPhotos,
    pages: Object.freeze(pages)
  });
}

export function materializeZinePage(book, pageOrIndex) {
  const page = typeof pageOrIndex === "number" ? book.pages[pageOrIndex] : pageOrIndex;
  if (!page || !book.pages.includes(page)) throw new RangeError("zine 页不存在。");
  return {
    ...page,
    photos: page.photoRefs.map((index) => book.photos[index])
  };
}

export function createZinePrintModel(book) {
  return {
    version: book.version,
    shapeId: book.shapeId,
    title: book.title,
    date: book.date,
    author: book.author,
    styleId: book.styleId,
    pageAspect: bookFormat(book).id,
    ratio: bookFormat(book).ratio,
    pageSize: { width: bookFormat(book).width, height: bookFormat(book).height },
    printSizeMm: { width: bookFormat(book).printWidthMm, height: bookFormat(book).printHeightMm },
    pages: book.pages.map((page, index) => ({
      ...materializeZinePage(book, page),
      pageNumber: index + 1,
      pageCount: book.pages.length
    }))
  };
}

export function createZinePageController({ pageCount, initialIndex = 0, onChange = () => {} }) {
  if (!Number.isInteger(pageCount) || pageCount < 1) throw new RangeError("pageCount 必须是正整数。");
  let index = Math.min(pageCount - 1, Math.max(0, Math.trunc(initialIndex)));
  const snapshot = () => Object.freeze({
    index,
    pageNumber: index + 1,
    pageCount,
    canPrevious: index > 0,
    canNext: index < pageCount - 1
  });
  function goTo(nextIndex) {
    const bounded = Math.min(pageCount - 1, Math.max(0, Math.trunc(nextIndex)));
    if (bounded === index) return snapshot();
    index = bounded;
    const state = snapshot();
    onChange(state);
    return state;
  }
  function handleSwipe({ deltaX = 0, deltaY = 0, durationMs = 0, threshold = 42 } = {}) {
    if (durationMs > 700 || Math.abs(deltaX) < threshold || Math.abs(deltaX) <= Math.abs(deltaY) * 1.2) {
      return { changed: false, state: snapshot() };
    }
    const before = index;
    const state = deltaX < 0 ? goTo(index + 1) : goTo(index - 1);
    return { changed: before !== index, state };
  }
  return Object.freeze({
    getState: snapshot,
    goTo,
    previous: () => goTo(index - 1),
    next: () => goTo(index + 1),
    handleSwipe
  });
}

function appendText(documentRef, parent, tagName, className, text) {
  const node = documentRef.createElement(tagName);
  node.className = className;
  node.textContent = text;
  parent.append(node);
  return node;
}

function photoCaption(photo) {
  const caption = photo.caption || photo.pairs[0]?.answer || "";
  return splitGraphemes(caption).length > 70 || caption.includes("\n") ? "原话见文字页" : caption;
}

function appendPhoto(documentRef, parent, photo, className = "") {
  const figure = documentRef.createElement("figure");
  figure.className = `zine-photo ${className}`.trim();
  const image = documentRef.createElement("img");
  image.src = photo.src;
  image.alt = photo.alt;
  image.loading = "lazy";
  image.draggable = false;
  figure.append(image);
  const caption = photoCaption(photo);
  if (caption) appendText(documentRef, figure, "figcaption", "zine-photo__caption", caption);
  parent.append(figure);
  return figure;
}

export function renderZinePageElement(book, pageOrIndex, documentRef = document) {
  const page = materializeZinePage(book, pageOrIndex);
  const article = documentRef.createElement("article");
  article.className = `zine-page zine-page--${page.layout}`;
  article.dataset.pageId = page.id;
  article.dataset.layout = page.layout;
  article.dataset.pageAspect = bookFormat(book).id;
  for (const [property, value] of Object.entries({ "--zine-paper": THEMES[book.styleId].background, "--zine-ink": THEMES[book.styleId].foreground, "--zine-muted": THEMES[book.styleId].muted, "--zine-accent": THEMES[book.styleId].accent })) article.style.setProperty(property, value);
  article.style.setProperty("--zine-page-aspect", `${bookFormat(book).width} / ${bookFormat(book).height}`);
  article.setAttribute("aria-label", `${page.id}，${page.layout}`);

  if (page.kind === "cover") {
    const titleLength = splitGraphemes(page.title).length;
    if (titleLength > 8) article.style.setProperty("--zine-cover-title-size", `clamp(.75rem, ${Math.max(3.5, Math.min(12, 80 / titleLength))}cqw, 2rem)`);
    appendPhoto(documentRef, article, page.photos[0], "zine-photo--cover");
    const copy = documentRef.createElement("div");
    copy.className = "zine-cover-copy";
    appendText(documentRef, copy, "h2", "zine-cover-title", page.title);
    appendText(documentRef, copy, "p", "zine-cover-meta", page.meta);
    article.append(copy);
  } else if (page.layout === "text-break") {
    if (page.question) appendText(documentRef, article, "p", "zine-text-question", page.question);
    appendText(documentRef, article, "blockquote", "zine-text-answer", page.text);
    appendText(documentRef, article, "p", "zine-text-source", sourceLabel(page.source));
  } else if (page.kind === "closing") {
    appendText(documentRef, article, "p", "zine-closing-copy", page.text);
    appendText(documentRef, article, "span", "zine-closing-seal", "见");
  } else {
    const gallery = documentRef.createElement("div");
    gallery.className = `zine-gallery zine-gallery--${page.layout}`;
    page.photos.forEach((photo) => appendPhoto(documentRef, gallery, photo));
    article.append(gallery);
  }
  return article;
}

export function mountZinePreview({ container, book, initialIndex = 0, onPageChange = () => {} }) {
  if (!container?.replaceChildren) throw new TypeError("container 必须是 DOM 元素。");
  const documentRef = container.ownerDocument ?? document;
  const pageNodes = book.pages.map((page) => renderZinePageElement(book, page, documentRef));
  const root = documentRef.createElement("div");
  root.className = "zine-book";
  root.dataset.style = book.styleId;
  root.dataset.pageAspect = bookFormat(book).id;
  root.append(...pageNodes);
  container.replaceChildren(root);
  let touch = null;

  function renderState(state) {
    pageNodes.forEach((node, index) => {
      node.hidden = index !== state.index;
      node.setAttribute("aria-hidden", String(index !== state.index));
    });
    root.dataset.page = String(state.pageNumber);
    onPageChange(state);
  }
  const controller = createZinePageController({ pageCount: pageNodes.length, initialIndex, onChange: renderState });
  const onTouchStart = (event) => {
    const point = event.changedTouches?.[0];
    if (point) touch = { x: point.clientX, y: point.clientY, time: Date.now() };
  };
  const onTouchEnd = (event) => {
    const point = event.changedTouches?.[0];
    if (!touch || !point) return;
    controller.handleSwipe({
      deltaX: point.clientX - touch.x,
      deltaY: point.clientY - touch.y,
      durationMs: Date.now() - touch.time
    });
    touch = null;
  };
  root.addEventListener("touchstart", onTouchStart, { passive: true });
  root.addEventListener("touchend", onTouchEnd, { passive: true });
  renderState(controller.getState());
  return Object.freeze({
    root,
    controller,
    destroy() {
      root.removeEventListener("touchstart", onTouchStart);
      root.removeEventListener("touchend", onTouchEnd);
      container.replaceChildren();
    }
  });
}

function defaultLoadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => image.naturalWidth && image.naturalHeight
      ? resolve(image)
      : reject(new Error("zine_image_failed"));
    image.onerror = () => reject(new Error("zine_image_failed"));
    image.src = src;
  });
}

function drawCoverCrop(context, image, x, y, width, height) {
  const naturalWidth = image.naturalWidth || image.width;
  const naturalHeight = image.naturalHeight || image.height;
  if (!naturalWidth || !naturalHeight) throw new Error("zine_image_failed");
  const scale = Math.max(width / naturalWidth, height / naturalHeight);
  const sourceWidth = width / scale;
  const sourceHeight = height / scale;
  context.drawImage(
    image,
    (naturalWidth - sourceWidth) / 2,
    (naturalHeight - sourceHeight) / 2,
    sourceWidth,
    sourceHeight,
    x,
    y,
    width,
    height
  );
}

function fitZineText(context, text, maxWidth, maxHeight, { maximum = 54, minimum = 22 } = {}) {
  const family = '"PingFang SC", "Microsoft YaHei", sans-serif';
  for (let size = maximum; size >= minimum; size -= 2) {
    context.font = `${size}px ${family}`;
    const lines = wrapText(context, text, maxWidth);
    const lineHeight = Math.ceil(size * 1.58);
    if (lines.length * lineHeight <= maxHeight) return { lines, lineHeight, font: context.font };
  }
  context.font = `${minimum}px ${family}`;
  const lines = wrapText(context, text, maxWidth);
  const lineHeight = Math.ceil(minimum * 1.58);
  if (lines.length * lineHeight > maxHeight) throw Object.assign(new Error("文字尚未排入完整页面，请增加文字页后导出。"), { code: "zine_text_does_not_fit" });
  return { lines, lineHeight, font: context.font };
}

function drawTextBlock(context, text, x, y, maxWidth, maxHeight, theme, options = {}) {
  const block = fitZineText(context, text, maxWidth, maxHeight, options);
  context.font = block.font;
  context.fillStyle = theme.foreground;
  block.lines.forEach((line, index) => context.fillText(line, x, y + index * block.lineHeight));
  return block;
}

async function loadPagePhotos(page, loadImage) {
  return Promise.all(page.photos.map((photo) => loadImage(photo.src)));
}

function canvasFromFactory(width, height, canvasFactory) {
  const canvas = canvasFactory ? canvasFactory(width, height) : document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export async function renderZinePageCanvas(book, pageOrIndex, {
  width = null,
  height = null,
  loadImage = defaultLoadImage,
  canvasFactory
} = {}) {
  const page = materializeZinePage(book, pageOrIndex);
  const format = bookFormat(book);
  width = width ?? format.width;
  if (!Number.isFinite(width) || width <= 0) throw new RangeError("zine_width_invalid");
  const expectedHeight = Math.round(format.height * width / format.width);
  if (height != null && (!Number.isFinite(height) || Math.abs(height - expectedHeight) > 1)) throw new RangeError("zine_page_ratio_mismatch");
  const pageHeight = height ?? expectedHeight;
  const scaleX = width / ZINE_PAGE_SIZE.width;
  const scaleY = pageHeight / ZINE_PAGE_SIZE.height;
  const scale = Math.min(scaleX, scaleY);
  const canvas = canvasFromFactory(width, pageHeight, canvasFactory);
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("zine_canvas_failed");
  const theme = THEMES[book.styleId];
  const images = await loadPagePhotos(page, loadImage);
  const unit = (value) => value * scale;
  const x = (value) => value * scaleX;
  const y = (value) => value * scaleY;
  context.fillStyle = theme.background;
  context.fillRect(0, 0, width, pageHeight);

  if (page.kind === "cover") {
    drawCoverCrop(context, images[0], 0, 0, width, pageHeight);
    context.fillStyle = "rgba(16, 24, 32, .42)";
    context.fillRect(0, 0, width, pageHeight);
    context.fillStyle = "#fff9ea";
    context.font = `700 ${unit(112)}px "Kaiti SC", "STKaiti", "KaiTi", serif`;
    if (context.measureText(page.title).width <= x(916)) context.fillText(page.title, x(82), y(1120));
    else drawTextBlock(context, page.title, x(82), y(940), x(916), y(240), { ...theme, foreground: "#fff9ea" }, { maximum: unit(112), minimum: unit(24) });
    context.font = `500 ${unit(26)}px "PingFang SC", sans-serif`;
    context.fillText(page.meta, x(86), y(1194));
  } else if (page.layout === "full-photo") {
    drawCoverCrop(context, images[0], x(70), y(78), x(940), y(1070));
    const caption = photoCaption(page.photos[0]);
    if (caption) drawTextBlock(context, caption, x(74), y(1220), x(920), y(132), theme, { maximum: unit(28), minimum: unit(18) });
  } else if (page.layout === "duo") {
    images.forEach((image, index) => {
      drawCoverCrop(context, image, x(66 + index * 483), y(92), x(448), y(1050));
    });
    context.fillStyle = theme.accent;
    context.fillRect(x(529), y(92), x(2), y(1050));
  } else if (page.layout === "grid") {
    const columns = page.photos.length > 1 ? 2 : 1;
    const rows = Math.ceil(page.photos.length / columns);
    const gap = unit(20);
    const left = x(66);
    const top = y(84);
    const areaWidth = x(948);
    const areaHeight = y(1180);
    const cellWidth = (areaWidth - gap * (columns - 1)) / columns;
    const cellHeight = (areaHeight - gap * (rows - 1)) / rows;
    images.forEach((image, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      drawCoverCrop(context, image, left + column * (cellWidth + gap), top + row * (cellHeight + gap), cellWidth, cellHeight);
    });
  } else if (page.layout === "text-break") {
    context.fillStyle = theme.accent;
    context.fillRect(x(84), y(190), x(84), y(5));
    if (page.question) {
      context.fillStyle = theme.muted;
      context.font = `500 ${unit(24)}px "PingFang SC", sans-serif`;
      const question = wrapText(context, page.question, x(850));
      question.forEach((line, index) => context.fillText(line, x(84), y(290 + index * 42)));
    }
    drawTextBlock(context, page.text, x(84), y(page.question ? 430 : 340), x(900), y(page.question ? 750 : 850), theme, {
      maximum: unit(54),
      minimum: unit(20)
    });
    context.fillStyle = theme.muted;
    context.font = `500 ${unit(22)}px "PingFang SC", sans-serif`;
    context.fillText(sourceLabel(page.source), x(84), y(1280));
  } else {
    context.fillStyle = theme.foreground;
    context.textAlign = "center";
    context.font = `500 ${unit(46)}px "Kaiti SC", "STKaiti", serif`;
    context.fillText(page.text, width / 2, y(620));
    context.fillStyle = theme.accent;
    context.font = `700 ${unit(96)}px "Kaiti SC", "STKaiti", serif`;
    context.fillText("见", width / 2, y(870));
    context.textAlign = "start";
  }

  context.fillStyle = theme.muted;
  context.font = `${unit(18)}px "PingFang SC", sans-serif`;
  context.textAlign = "right";
  const pageIndex = book.pages.indexOf(typeof pageOrIndex === "number" ? book.pages[pageOrIndex] : pageOrIndex);
  context.fillText(`${pageIndex + 1} / ${book.pages.length}`, width - unit(54), pageHeight - unit(34));
  context.textAlign = "start";
  return canvas;
}

function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("zine_encode_failed")), "image/png");
  });
}

export function zinePageFilename(book, pageIndex) {
  const safeTitle = cleanText(book.title, "回见").replace(/[\\/:*?"<>|]+/gu, "-").slice(0, 48);
  return `${safeTitle}-${String(pageIndex + 1).padStart(2, "0")}.png`;
}

export async function renderZinePagePng(book, pageOrIndex, options) {
  return canvasToPngBlob(await renderZinePageCanvas(book, pageOrIndex, options));
}

export async function renderZinePagePngFiles(book, options) {
  const files = [];
  for (let index = 0; index < book.pages.length; index += 1) {
    files.push({
      pageId: book.pages[index].id,
      pageIndex: index,
      filename: zinePageFilename(book, index),
      blob: await renderZinePagePng(book, index, options)
    });
  }
  return files;
}

export function planZineShareStrip(pageSizes, { gap = 18, maximumHeight = 15_800, maximumWidth = 720 } = {}) {
  if (!Array.isArray(pageSizes) || !pageSizes.length) throw new TypeError("pageSizes 不能为空。");
  const sizes = pageSizes.map(({ width, height }) => {
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
      throw new RangeError("pageSizes 必须包含正数宽高。");
    }
    return { width, height };
  });
  const safeGap = Number.isFinite(gap) && gap >= 0 ? gap : 18;
  const safeMaximumWidth = Number.isFinite(maximumWidth) && maximumWidth > 0 ? maximumWidth : 720;
  const safeMaximumHeight = Number.isFinite(maximumHeight) && maximumHeight > 0 ? maximumHeight : 15_800;
  const gapHeight = safeGap * (sizes.length - 1);
  const heightAtMaximumWidth = sizes.reduce((sum, size) => (
    sum + size.height * safeMaximumWidth / size.width
  ), 0);
  const heightScale = Math.min(1, Math.max(0, safeMaximumHeight - gapHeight) / Math.max(1, heightAtMaximumWidth));
  let width = Math.max(240, Math.floor(safeMaximumWidth * heightScale));

  const place = (candidateWidth) => {
    const placements = [];
    let y = 0;
    sizes.forEach((size, index) => {
      const height = Math.round(size.height * candidateWidth / size.width);
      placements.push({ x: 0, y, width: candidateWidth, height });
      y += height + (index === sizes.length - 1 ? 0 : safeGap);
    });
    return { placements, height: y };
  };

  let planned = place(width);
  while (planned.height > safeMaximumHeight && width > 240) {
    width -= 1;
    planned = place(width);
  }
  if (planned.height > safeMaximumHeight) throw Object.assign(new RangeError("内容较长，请选择逐页 PNG 或打印，原话不会截断。"), { code: "zine_share_too_tall" });
  return { width, height: planned.height, gap: safeGap, placements: planned.placements };
}

export async function renderZineSharePng(book, options = {}) {
  const requestedWidth = Number.isFinite(options.width) && options.width > 0
    ? options.width
    : bookFormat(book).width;
  const requestedHeight = Number.isFinite(options.height) && options.height > 0
    ? options.height
    : Math.round(bookFormat(book).height * requestedWidth / bookFormat(book).width);
  const maximumWidth = Math.min(
    Number.isFinite(options.maximumWidth) && options.maximumWidth > 0 ? options.maximumWidth : 720,
    requestedWidth
  );
  const pageSizes = book.pages.map(() => ({ width: requestedWidth, height: requestedHeight }));
  const plan = planZineShareStrip(pageSizes, { ...options, maximumWidth });
  const strip = canvasFromFactory(plan.width, plan.height, options.canvasFactory);
  const context = strip.getContext("2d", { alpha: false });
  if (!context) throw new Error("zine_canvas_failed");
  const theme = THEMES[book.styleId];
  context.fillStyle = theme.frame;
  context.fillRect(0, 0, strip.width, strip.height);
  for (let index = 0; index < book.pages.length; index += 1) {
    const placement = plan.placements[index];
    const page = await renderZinePageCanvas(book, index, {
      ...options,
      width: placement.width,
      height: placement.height
    });
    context.drawImage(page, placement.x, placement.y, placement.width, placement.height);
  }
  return canvasToPngBlob(strip);
}

export { THEMES as ZINE_THEMES };
