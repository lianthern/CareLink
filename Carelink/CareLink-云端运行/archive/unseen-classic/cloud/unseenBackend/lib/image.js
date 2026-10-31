"use strict";

const { AppError, invariant } = require("./errors.js");

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
]);

function parsePng(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) return null;
  invariant(buffer.readUInt32BE(8) === 13 && buffer.toString("ascii", 12, 16) === "IHDR",
    "INVALID_IMAGE", "PNG 文件头不完整或已损坏", 422);
  return {
    format: "png",
    mime: "image/png",
    extension: "png",
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    animated: false
  };
}

function parseJpeg(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 1 < buffer.length) {
    while (offset < buffer.length && buffer[offset] !== 0xff) offset += 1;
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;
    const marker = buffer[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    invariant(offset + 2 <= buffer.length, "INVALID_IMAGE", "JPEG 文件头不完整或已损坏", 422);
    const length = buffer.readUInt16BE(offset);
    invariant(length >= 2 && offset + length <= buffer.length,
      "INVALID_IMAGE", "JPEG 文件段长度无效", 422);
    if (JPEG_SOF_MARKERS.has(marker)) {
      invariant(length >= 8, "INVALID_IMAGE", "JPEG 尺寸信息无效", 422);
      return {
        format: "jpeg",
        mime: "image/jpeg",
        extension: "jpg",
        width: buffer.readUInt16BE(offset + 5),
        height: buffer.readUInt16BE(offset + 3),
        animated: false
      };
    }
    offset += length;
  }
  throw new AppError("INVALID_IMAGE", "无法读取 JPEG 尺寸", 422);
}

function parseWebp(buffer) {
  if (buffer.length < 20 || buffer.toString("ascii", 0, 4) !== "RIFF" ||
      buffer.toString("ascii", 8, 12) !== "WEBP") return null;
  const declared = buffer.readUInt32LE(4) + 8;
  invariant(declared <= buffer.length && declared >= 20,
    "INVALID_IMAGE", "WebP 文件长度无效", 422);
  let offset = 12;
  while (offset + 8 <= declared) {
    const type = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const data = offset + 8;
    invariant(data + size <= declared, "INVALID_IMAGE", "WebP 文件块不完整", 422);
    if (type === "VP8X") {
      invariant(size >= 10, "INVALID_IMAGE", "WebP VP8X 文件头无效", 422);
      const flags = buffer[data];
      const width = 1 + buffer[data + 4] + (buffer[data + 5] << 8) + (buffer[data + 6] << 16);
      const height = 1 + buffer[data + 7] + (buffer[data + 8] << 8) + (buffer[data + 9] << 16);
      return { format: "webp", mime: "image/webp", extension: "webp", width, height,
        animated: Boolean(flags & 0x02) };
    }
    if (type === "VP8 ") {
      invariant(size >= 10 && buffer[data + 3] === 0x9d && buffer[data + 4] === 0x01 && buffer[data + 5] === 0x2a,
        "INVALID_IMAGE", "WebP VP8 文件头无效", 422);
      return {
        format: "webp", mime: "image/webp", extension: "webp",
        width: buffer.readUInt16LE(data + 6) & 0x3fff,
        height: buffer.readUInt16LE(data + 8) & 0x3fff,
        animated: false
      };
    }
    if (type === "VP8L") {
      invariant(size >= 5 && buffer[data] === 0x2f,
        "INVALID_IMAGE", "WebP VP8L 文件头无效", 422);
      const b1 = buffer[data + 1];
      const b2 = buffer[data + 2];
      const b3 = buffer[data + 3];
      const b4 = buffer[data + 4];
      return {
        format: "webp", mime: "image/webp", extension: "webp",
        width: 1 + b1 + ((b2 & 0x3f) << 8),
        height: 1 + (b2 >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10),
        animated: false
      };
    }
    offset = data + size + (size % 2);
  }
  throw new AppError("INVALID_IMAGE", "无法读取 WebP 尺寸", 422);
}

function inspectImage(buffer, kind) {
  invariant(Buffer.isBuffer(buffer) && buffer.length > 0,
    "EMPTY_IMAGE", "图片为空", 422);
  const maxBytes = kind === "panorama" ? 50 * 1024 * 1024 : 20 * 1024 * 1024;
  invariant(buffer.length <= maxBytes, "IMAGE_TOO_LARGE",
    kind === "panorama" ? "全景图不能超过 50 MB" : "照片不能超过 20 MB", 413);
  const parsed = parsePng(buffer) || parseJpeg(buffer) || parseWebp(buffer);
  invariant(parsed, "UNSUPPORTED_IMAGE", "仅支持 JPEG、PNG 或 WebP 图片", 422);
  invariant(!parsed.animated, "ANIMATED_IMAGE_UNSUPPORTED", "不支持动态 WebP", 422);
  invariant(Number.isSafeInteger(parsed.width) && Number.isSafeInteger(parsed.height) &&
    parsed.width > 0 && parsed.height > 0, "INVALID_IMAGE", "图片尺寸无效", 422);

  if (kind === "panorama") {
    const ratio = parsed.width / parsed.height;
    invariant(parsed.width >= 1600 && parsed.height >= 800,
      "PANORAMA_TOO_SMALL", "全景图至少需要 1600 × 800 像素", 422);
    invariant(parsed.width <= 8192 && parsed.height <= 4096,
      "PANORAMA_DIMENSIONS_TOO_LARGE", "全景图不能超过 8192 × 4096 像素", 422);
    invariant(ratio >= 1.9 && ratio <= 2.1,
      "PANORAMA_RATIO_INVALID", "全景图宽高比需要接近 2:1", 422);
  } else {
    invariant(parsed.width <= 8192 && parsed.height <= 8192,
      "IMAGE_DIMENSIONS_TOO_LARGE", "照片任一边不能超过 8192 像素", 422);
  }
  return { ...parsed, size: buffer.length };
}

module.exports = { inspectImage, parseJpeg, parsePng, parseWebp };
