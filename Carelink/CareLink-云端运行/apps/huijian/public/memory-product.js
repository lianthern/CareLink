export const PRODUCT_SCHEMA_VERSION = 1;
export const MAX_PRODUCT_PHOTOS = 24;

export const RESULT_SHAPES = Object.freeze([
  Object.freeze({
    id: "memory-page",
    label: "一页回忆",
    description: "照片和原话排成一页，适合保存和打印。",
    minPhotos: 1,
    maxPhotos: 1
  }),
  Object.freeze({
    id: "poster",
    label: "记忆海报",
    description: "突出一张照片和一句原话，适合发给别人。",
    minPhotos: 1,
    maxPhotos: 1
  }),
  Object.freeze({
    id: "zine",
    label: "一本 zine",
    description: "把多张照片排成有封面、内页和尾页的小书。",
    minPhotos: 2,
    maxPhotos: 24
  }),
  Object.freeze({
    id: "spatial",
    label: "立体记忆",
    description: "让主照片在轻透视与持续粒子里呼吸。",
    minPhotos: 1,
    maxPhotos: 1,
    experimental: true
  })
]);

export const VISUAL_STYLES = Object.freeze([
  Object.freeze({
    id: "evening-paper",
    label: "傍晚相纸",
    description: "暖色相纸、日期印章和安静的手写感。"
  }),
  Object.freeze({
    id: "black-fragments",
    label: "黑色碎片",
    description: "深色底、边缘微光和克制的记忆碎片。"
  }),
  Object.freeze({
    id: "quiet-white",
    label: "极简留白",
    description: "清楚的照片和大块留白，适合长文字与打印。"
  })
]);

const shapeIds = new Set(RESULT_SHAPES.map(({ id }) => id));
const styleIds = new Set(VISUAL_STYLES.map(({ id }) => id));

export function resultShapeById(id) {
  return RESULT_SHAPES.find((shape) => shape.id === id) ?? null;
}

export function visualStyleById(id) {
  return VISUAL_STYLES.find((style) => style.id === id) ?? null;
}

export function resultShapeOptions(photoCount, { spatialAvailable = true } = {}) {
  const count = Number.isInteger(photoCount) && photoCount > 0 ? photoCount : 0;
  return RESULT_SHAPES.map((shape) => {
    let reason = "";
    let notice = "";
    if (count < shape.minPhotos) reason = `至少选择 ${shape.minPhotos} 张照片`;
    if (!reason && count > MAX_PRODUCT_PHOTOS) reason = `最多选择 ${MAX_PRODUCT_PHOTOS} 张照片`;
    if (!reason && Number.isInteger(shape.maxPhotos) && count > shape.maxPhotos) {
      if (shape.id === "zine") reason = `zine 最多使用 ${shape.maxPhotos} 张照片`;
      else notice = "会使用第一张主照片，其余照片仍可留在本机合集";
    }
    if (!reason && shape.id === "spatial" && !spatialAvailable) {
      reason = "当前设备会使用原样照片";
    }
    return Object.freeze({ ...shape, available: !reason, reason, notice });
  });
}

export function chooseDefaultShape(photoCount) {
  return photoCount >= 2 ? "zine" : "memory-page";
}

export function normalizeStyleId(styleId, fallback = "evening-paper") {
  if (styleIds.has(styleId)) return styleId;
  return styleIds.has(fallback) ? fallback : VISUAL_STYLES[0].id;
}

export function assertProductSelection({ photoCount, resultShape, styleId }) {
  if (!shapeIds.has(resultShape)) throw new TypeError("unknown_result_shape");
  if (!styleIds.has(styleId)) throw new TypeError("unknown_visual_style");
  const selected = resultShapeOptions(photoCount).find((shape) => shape.id === resultShape);
  if (!selected?.available) throw new RangeError(selected?.reason || "result_shape_unavailable");
  return true;
}

export function createMemoryRecord({
  id,
  collectionId,
  photos,
  facts = [],
  pairs,
  resultShape,
  styleId,
  createdAt = new Date().toISOString(),
  updatedAt = createdAt
}) {
  const cleanPhotos = Array.isArray(photos) ? photos.filter((photo) => photo?.src) : [];
  const cleanPairs = Array.isArray(pairs)
    ? pairs
      .filter((pair) => typeof pair?.answer === "string" && pair.answer.trim())
      .map((pair) => ({ ...pair, question: String(pair.question ?? ""), answer: pair.answer }))
    : [];
  assertProductSelection({ photoCount: cleanPhotos.length, resultShape, styleId });
  if (!cleanPairs.length) throw new RangeError("memory_requires_user_words");
  return {
    schemaVersion: PRODUCT_SCHEMA_VERSION,
    id: String(id),
    collectionId: String(collectionId),
    photos: cleanPhotos.map((photo) => ({
      ...photo,
      id: String(photo.id ?? photo.key ?? ""),
      src: photo.src,
      capturedAt: photo.capturedAt ?? null
    })),
    facts: facts.filter((fact) => typeof fact === "string" && fact.trim()).slice(0, 2),
    pairs: cleanPairs,
    resultShape,
    styleId,
    createdAt,
    updatedAt
  };
}
