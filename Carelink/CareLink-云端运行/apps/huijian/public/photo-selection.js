export const MAX_SELECTED_PHOTOS = 24;
export const MAX_PHOTO_BYTES = 30 * 1024 * 1024;
export const SUPPORTED_PHOTO_TYPES = Object.freeze(["image/jpeg", "image/png", "image/webp"]);

export function validatePhotoFile(file) {
  if (!file || !SUPPORTED_PHOTO_TYPES.includes(file.type)) return "unsupported_type";
  if (!Number.isFinite(file.size) || file.size <= 0) return "empty_photo";
  if (file.size > MAX_PHOTO_BYTES) return "photo_too_large";
  return "";
}

export function photoId(file, ordinal = 0) {
  const name = String(file?.name ?? "photo").normalize("NFC");
  const size = Number(file?.size ?? 0);
  const lastModified = Number(file?.lastModified ?? 0);
  return `${lastModified}:${size}:${ordinal}:${name}`;
}

export function limitPhotoFiles(files, max = MAX_SELECTED_PHOTOS) {
  const list = Array.from(files ?? []);
  const requested = Number.isInteger(max) && max > 0 ? max : MAX_SELECTED_PHOTOS;
  const limit = Math.min(requested, MAX_SELECTED_PHOTOS);
  return {
    accepted: list.slice(0, limit),
    omittedCount: Math.max(0, list.length - limit)
  };
}

export function removeSelectedPhoto(photos, id) {
  return photos.filter((photo) => photo.id !== id);
}

export function moveSelectedPhoto(photos, fromIndex, toIndex) {
  const next = [...photos];
  if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) return next;
  if (fromIndex < 0 || fromIndex >= next.length || toIndex < 0 || toIndex >= next.length) return next;
  const [photo] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, photo);
  return next;
}

export function selectionSummary(photos, failedCount = 0, omittedCount = 0) {
  const selected = Array.isArray(photos) ? photos.length : 0;
  const notes = [`已选 ${selected} 张`];
  if (failedCount > 0) notes.push(`${failedCount} 张没有读成功`);
  if (omittedCount > 0) notes.push(`最多处理 ${MAX_SELECTED_PHOTOS} 张，另有 ${omittedCount} 张未加入`);
  return notes.join("；");
}
