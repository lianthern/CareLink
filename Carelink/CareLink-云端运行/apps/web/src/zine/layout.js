// Pure layout choices for the local-only zine workbench. This module never touches image bytes,
// browser APIs, or the DOM, so the picker, canvas renderer, and tests share one frozen contract.

export const ZINE_TEMPLATES = Object.freeze({
  COVER: "cover",
  FULL: "full",
  DUO: "duo",
  GRID: "grid",
  ACCENT: "accent",
  CLOSING: "closing"
});

export const ZINE_BOOK_TEMPLATES = Object.freeze({
  STORY: Object.freeze({
    id: "story",
    label: "故事流",
    description: "大图、双图与停顿页交替，像顺着一天往后翻。",
    rhythm: Object.freeze([
      ZINE_TEMPLATES.FULL, ZINE_TEMPLATES.DUO, ZINE_TEMPLATES.GRID, ZINE_TEMPLATES.FULL,
      ZINE_TEMPLATES.ACCENT, ZINE_TEMPLATES.DUO, ZINE_TEMPLATES.FULL, ZINE_TEMPLATES.GRID
    ])
  }),
  GALLERY: Object.freeze({
    id: "gallery",
    label: "留白画廊",
    description: "单图与留白页居多，让每张照片慢一点被看见。",
    rhythm: Object.freeze([
      ZINE_TEMPLATES.ACCENT, ZINE_TEMPLATES.FULL, ZINE_TEMPLATES.ACCENT,
      ZINE_TEMPLATES.DUO, ZINE_TEMPLATES.ACCENT, ZINE_TEMPLATES.FULL
    ])
  }),
  COLLAGE: Object.freeze({
    id: "collage",
    label: "热闹拼贴",
    description: "多图页连续出现，适合人多、表情多的现场。",
    rhythm: Object.freeze([
      ZINE_TEMPLATES.GRID, ZINE_TEMPLATES.DUO, ZINE_TEMPLATES.GRID,
      ZINE_TEMPLATES.FULL, ZINE_TEMPLATES.GRID, ZINE_TEMPLATES.DUO
    ])
  })
});

export const ZINE_FORMATS = Object.freeze({
  PORTRAIT: Object.freeze({ id: "portrait", label: "竖版小书", ratio: "3:4", width: 840, height: 1120, printWidthMm: 120, printHeightMm: 160 }),
  SQUARE: Object.freeze({ id: "square", label: "方形相册", ratio: "1:1", width: 1080, height: 1080, printWidthMm: 150, printHeightMm: 150 }),
  LANDSCAPE: Object.freeze({ id: "landscape", label: "横版画册", ratio: "4:3", width: 1200, height: 900, printWidthMm: 180, printHeightMm: 135 })
});

export const ZINE_SORT_MODES = Object.freeze({
  SELECTION: "selection",
  FILE_TIME: "file-time"
});

export const ZINE_ORIENTATIONS = Object.freeze({
  PORTRAIT: "portrait",
  SQUARE: "square",
  LANDSCAPE: "landscape",
  UNKNOWN: "unknown"
});

export const ZINE_ACCENT_CAPTIONS = Object.freeze(["此刻", "微光", "日常", "并肩", "留白", "余温", "细节", "回声"]);

export function defaultZineTitle(date = new Date()) {
  return `我们的小书 · ${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

export function getZineBookTemplate(templateId) {
  return Object.values(ZINE_BOOK_TEMPLATES).find((template) => template.id === templateId) || ZINE_BOOK_TEMPLATES.STORY;
}

export function getZineFormat(formatId) {
  return Object.values(ZINE_FORMATS).find((format) => format.id === formatId) || ZINE_FORMATS.PORTRAIT;
}

// A small neutral band keeps almost-square crops from being described as portrait or landscape.
// The browser supplies display-oriented natural dimensions, so EXIF rotation stays out of this pure layer.
export function classifyZineOrientation(width, height) {
  const safeWidth = Number(width);
  const safeHeight = Number(height);
  if (!Number.isFinite(safeWidth) || !Number.isFinite(safeHeight) || safeWidth <= 0 || safeHeight <= 0) {
    return ZINE_ORIENTATIONS.UNKNOWN;
  }
  const ratio = safeWidth / safeHeight;
  if (ratio >= 1.12) return ZINE_ORIENTATIONS.LANDSCAPE;
  if (ratio <= 1 / 1.12) return ZINE_ORIENTATIONS.PORTRAIT;
  return ZINE_ORIENTATIONS.SQUARE;
}

export function recommendZineFormat(orientations = []) {
  const counts = {
    [ZINE_ORIENTATIONS.PORTRAIT]: 0,
    [ZINE_ORIENTATIONS.SQUARE]: 0,
    [ZINE_ORIENTATIONS.LANDSCAPE]: 0,
    [ZINE_ORIENTATIONS.UNKNOWN]: 0
  };
  for (const orientation of orientations) {
    if (Object.hasOwn(counts, orientation)) counts[orientation] += 1;
    else counts[ZINE_ORIENTATIONS.UNKNOWN] += 1;
  }
  const ranked = [ZINE_ORIENTATIONS.PORTRAIT, ZINE_ORIENTATIONS.SQUARE, ZINE_ORIENTATIONS.LANDSCAPE]
    .map((id) => ({ id, count: counts[id] }))
    .sort((left, right) => right.count - left.count);
  const knownCount = orientations.length - counts[ZINE_ORIENTATIONS.UNKNOWN];
  const formatId = knownCount > 0 && ranked[0].count > ranked[1].count ? ranked[0].id : null;
  return Object.freeze({ counts: Object.freeze(counts), knownCount, totalCount: orientations.length, formatId });
}

export function zineCropRiskCount(summary, formatId) {
  if (!summary?.counts || !Object.values(ZINE_FORMATS).some((format) => format.id === formatId)) return 0;
  return [ZINE_ORIENTATIONS.PORTRAIT, ZINE_ORIENTATIONS.SQUARE, ZINE_ORIENTATIONS.LANDSCAPE]
    .filter((orientation) => orientation !== formatId)
    .reduce((total, orientation) => total + (summary.counts[orientation] || 0), 0);
}

// Returns indexes instead of cloned File objects so a time-sorted thumbnail can still remove the
// exact item from the visitor's original selection. Unknown timestamps stay at the end.
export function orderZineIndexes(files, sortMode = ZINE_SORT_MODES.SELECTION) {
  const indexes = Array.from({ length: files?.length || 0 }, (_, index) => index);
  if (sortMode !== ZINE_SORT_MODES.FILE_TIME) return indexes;
  const time = (file) => {
    const value = Number(file?.lastModified);
    return Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY;
  };
  return indexes.sort((left, right) => time(files[left]) - time(files[right]) || left - right);
}

// Image 0 is the cover. Every remaining image is consumed once by the selected template's frozen
// rhythm; an over-large page type degrades at the tail instead of inventing or repeating photos.
export function buildZinePages(imageCount, templateId = ZINE_BOOK_TEMPLATES.STORY.id) {
  const count = Math.max(0, Math.floor(Number(imageCount)) || 0);
  if (count === 0) return [];
  const rhythm = getZineBookTemplate(templateId).rhythm;
  const pages = [{ type: ZINE_TEMPLATES.COVER, images: [0] }];
  let cursor = 1;
  let rhythmIndex = 0;
  let accentCount = 0;
  while (cursor < count) {
    const remaining = count - cursor;
    let template = rhythm[rhythmIndex % rhythm.length];
    rhythmIndex += 1;
    if (template === ZINE_TEMPLATES.GRID && remaining < 3) template = remaining >= 2 ? ZINE_TEMPLATES.DUO : ZINE_TEMPLATES.FULL;
    else if (template === ZINE_TEMPLATES.DUO && remaining < 2) template = ZINE_TEMPLATES.FULL;
    const capacity = template === ZINE_TEMPLATES.GRID ? 4 : template === ZINE_TEMPLATES.DUO ? 2 : 1;
    const take = Math.min(capacity, remaining);
    const page = { type: template, images: Array.from({ length: take }, (_, index) => cursor + index) };
    if (template === ZINE_TEMPLATES.ACCENT) {
      page.caption = ZINE_ACCENT_CAPTIONS[accentCount % ZINE_ACCENT_CAPTIONS.length];
      accentCount += 1;
    }
    pages.push(page);
    cursor += take;
  }
  pages.push({ type: ZINE_TEMPLATES.CLOSING, images: [] });
  return pages;
}
