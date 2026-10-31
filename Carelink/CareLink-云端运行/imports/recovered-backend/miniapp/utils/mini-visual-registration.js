/*
 * Bounded CPU thumbnails for the mini-program visual registration stage.
 * Full-resolution camera frames remain on disk; only <=216 px RGBA copies are
 * retained while capturing, keeping 28 worst-case square thumbnails under
 * 5 MiB (normal 3:4 captures use about 3.9 MiB).
 */
"use strict";

var DEFAULT_MAX_SIDE = 216;
var MAX_TOTAL_BYTES = 5 * 1024 * 1024;

function createThumbnail(decoded, maxSide) {
  var sourceWidth = Math.max(1, Number(decoded && decoded.width) || 0);
  var sourceHeight = Math.max(1, Number(decoded && decoded.height) || 0);
  var source = decoded && decoded.data;
  if (!source || source.length < sourceWidth * sourceHeight * 4) {
    throw new Error("视觉配准缩略图缺少 RGBA 像素");
  }
  var limit = Math.max(32, Number(maxSide) || DEFAULT_MAX_SIDE);
  var scale = Math.min(1, limit / Math.max(sourceWidth, sourceHeight));
  var width = Math.max(2, Math.round(sourceWidth * scale));
  var height = Math.max(2, Math.round(sourceHeight * scale));
  var pixels = new Uint8ClampedArray(width * height * 4);

  for (var y = 0; y < height; y += 1) {
    var sourceY = (y + 0.5) / height * sourceHeight - 0.5;
    var y0 = Math.max(0, Math.floor(sourceY));
    var y1 = Math.min(sourceHeight - 1, y0 + 1);
    var ty = Math.max(0, Math.min(1, sourceY - y0));
    for (var x = 0; x < width; x += 1) {
      var sourceX = (x + 0.5) / width * sourceWidth - 0.5;
      var x0 = Math.max(0, Math.floor(sourceX));
      var x1 = Math.min(sourceWidth - 1, x0 + 1);
      var tx = Math.max(0, Math.min(1, sourceX - x0));
      var a = (y0 * sourceWidth + x0) * 4;
      var b = (y0 * sourceWidth + x1) * 4;
      var c = (y1 * sourceWidth + x0) * 4;
      var d = (y1 * sourceWidth + x1) * 4;
      var output = (y * width + x) * 4;
      for (var channel = 0; channel < 4; channel += 1) {
        var top = source[a + channel] * (1 - tx) + source[b + channel] * tx;
        var bottom = source[c + channel] * (1 - tx) + source[d + channel] * tx;
        pixels[output + channel] = Math.round(top * (1 - ty) + bottom * ty);
      }
    }
  }
  return {
    pixels: pixels,
    width: width,
    height: height,
    byteLength: pixels.byteLength
  };
}

function totalBytes(frames) {
  return (frames || []).reduce(function (sum, frame) {
    var pixels = frame && frame.pixels;
    return sum + (pixels && pixels.byteLength || 0);
  }, 0);
}

function releasePixels(frames) {
  var released = 0;
  (frames || []).forEach(function (frame) {
    if (!frame || !frame.pixels) return;
    released += frame.pixels.byteLength || 0;
    frame.pixels = null;
  });
  return released;
}

function completeRings(frameCount) {
  var count = Math.max(0, Number(frameCount) || 0);
  var rings = [];
  function range(start, end) {
    var values = [];
    for (var index = start; index <= end; index += 1) values.push(index);
    return values;
  }
  if (count >= 12) rings.push(range(0, 11));
  if (count >= 20) rings.push(range(12, 19));
  if (count >= 28) rings.push(range(20, 27));
  return rings;
}

function rejectMessage(reason) {
  var messages = {
    MISSING_PIXELS: "视觉校正没有读到照片",
    REFERENCE_MISSING_PIXELS: "上一张视觉参考已经失效",
    LOW_TEXTURE: "画面纹理太少，无法可靠对齐",
    TOO_BLURRY: "画面模糊，无法可靠对齐",
    TOO_DARK: "画面太暗，无法可靠对齐",
    TOO_BRIGHT: "画面过曝，无法可靠对齐",
    INSUFFICIENT_OVERLAP: "与相邻照片重叠不足",
    LOW_ALIGNMENT_CONFIDENCE: "相邻照片内容没有可靠对齐",
    CORRECTION_LIMIT: "照片偏差超出安全校正范围",
    NO_GEOMETRIC_NEIGHBOR: "没有找到可验证的相邻照片"
  };
  return messages[reason] || "视觉校正没有达到可靠阈值";
}

module.exports = {
  DEFAULT_MAX_SIDE: DEFAULT_MAX_SIDE,
  MAX_TOTAL_BYTES: MAX_TOTAL_BYTES,
  completeRings: completeRings,
  createThumbnail: createThumbnail,
  rejectMessage: rejectMessage,
  releasePixels: releasePixels,
  totalBytes: totalBytes
};
