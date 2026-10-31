import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_PHOTO_BYTES,
  limitPhotoFiles,
  moveSelectedPhoto,
  photoId,
  removeSelectedPhoto,
  selectionSummary,
  validatePhotoFile
} from "../public/photo-selection.js";

test("photo validation has explicit mobile-safe format and size errors", () => {
  assert.equal(validatePhotoFile({ type: "image/jpeg", size: 12 }), "");
  assert.equal(validatePhotoFile({ type: "image/heic", size: 12 }), "unsupported_type");
  assert.equal(validatePhotoFile({ type: "image/png", size: 0 }), "empty_photo");
  assert.equal(validatePhotoFile({ type: "image/webp", size: MAX_PHOTO_BYTES + 1 }), "photo_too_large");
});

test("selection keeps the first 24 files in user order", () => {
  const files = Array.from({ length: 27 }, (_, index) => ({ name: `${index}.jpg` }));
  const result = limitPhotoFiles(files);
  assert.equal(result.accepted.length, 24);
  assert.equal(result.accepted[0], files[0]);
  assert.equal(result.accepted[23], files[23]);
  assert.equal(result.omittedCount, 3);
  assert.equal(limitPhotoFiles(files, 99).accepted.length, 24, "callers cannot raise the product ceiling");
});

test("photo ids distinguish same file picked in different positions", () => {
  const file = { name: "旅行.jpg", size: 123, lastModified: 456 };
  assert.notEqual(photoId(file, 0), photoId(file, 1));
});

test("selection can reorder and remove without mutating the original", () => {
  const original = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(moveSelectedPhoto(original, 0, 2).map(({ id }) => id), ["b", "c", "a"]);
  assert.deepEqual(original.map(({ id }) => id), ["a", "b", "c"]);
  assert.deepEqual(removeSelectedPhoto(original, "b").map(({ id }) => id), ["a", "c"]);
});

test("selection summary reports partial failures instead of erasing successful photos", () => {
  assert.equal(
    selectionSummary([{ id: "a" }, { id: "b" }], 1, 3),
    "已选 2 张；1 张没有读成功；最多处理 24 张，另有 3 张未加入"
  );
});
