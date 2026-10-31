"use strict";

var NORMAL_MAX_BYTES = 20 * 1024 * 1024;
var PANO_MAX_BYTES = 50 * 1024 * 1024;
var PANO_MIN_WIDTH = 1600;
var PANO_MIN_HEIGHT = 800;
var PANO_RATIO_MIN = 1.90;
var PANO_RATIO_MAX = 2.10;
var PANO_MAX_PIXELS = 8192 * 4096;

var HEIC_BRANDS = {
  heic: true, heix: true, hevc: true, hevx: true,
  heim: true, heis: true, hevm: true, hevs: true,
  mif1: true, msf1: true
};

function extensionOf(file) {
  var raw = (file && (file.name || file.tempFilePath || file.path)) || "";
  var match = String(raw).toLowerCase().match(/\.([a-z0-9]+)(?:[?#].*)?$/);
  return match ? match[1] : "";
}

function ascii(bytes, start, length) {
  var out = "";
  for (var i = start; i < start + length && i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i]);
  }
  return out.toLowerCase();
}

function detectBytes(buffer) {
  var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || 0);
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { format: "jpeg", heic: false };
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === "png") {
    return { format: "png", heic: false };
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "riff" && ascii(bytes, 8, 4) === "webp") {
    return { format: "webp", heic: false };
  }
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") {
    var brands = [ascii(bytes, 8, 4)];
    for (var offset = 16; offset + 3 < bytes.length; offset += 4) {
      brands.push(ascii(bytes, offset, 4));
    }
    var heic = brands.some(function (brand) { return !!HEIC_BRANDS[brand]; });
    return { format: heic ? "heic" : "isobmff", heic: heic, brands: brands };
  }
  return { format: "unknown", heic: false };
}

function classify(file, bytesInfo) {
  var ext = extensionOf(file);
  var mime = String((file && (file.fileType || file.type || file.mimeType)) || "").toLowerCase();
  var heic = !!(bytesInfo && bytesInfo.heic) || /^(heic|heif)$/.test(ext) || /heic|heif/.test(mime);
  if (heic) return { ok: false, format: "heic", message: "暂不支持 HEIC/HEIF，请先在相册中导出为 JPEG" };

  var format = bytesInfo && bytesInfo.format;
  if (format === "jpeg" || format === "png" || format === "webp") {
    return { ok: true, format: format };
  }
  if (/^(jpe?g|png|webp)$/.test(ext)) {
    return { ok: true, format: ext === "jpg" ? "jpeg" : ext };
  }
  if (/image\/(jpeg|png|webp)/.test(mime)) {
    return { ok: true, format: mime.split("/")[1] };
  }
  return { ok: false, format: "unknown", message: "只支持 JPEG、PNG 或 WebP 图片" };
}

function validateMeta(meta, purpose) {
  var size = Number(meta && meta.size) || 0;
  var max = purpose === "panorama" ? PANO_MAX_BYTES : NORMAL_MAX_BYTES;
  if (!size) {
    return { ok: false, code: "SIZE_UNKNOWN", message: "无法读取图片大小，请重新选择或导出后再试" };
  }
  if (size > max) {
    return {
      ok: false,
      code: "TOO_LARGE",
      message: purpose === "panorama" ? "全景图不能超过 50 MB" : "单张照片不能超过 20 MB"
    };
  }
  var bytesFormat = meta && meta.bytesInfo && meta.bytesInfo.format;
  if (purpose === "panorama" && bytesFormat !== "jpeg" && bytesFormat !== "png" && bytesFormat !== "webp" && bytesFormat !== "heic") {
    return { ok: false, code: "FORMAT", message: "无法确认全景图格式，请导出为标准 JPEG、PNG 或 WebP" };
  }
  var type = classify(meta && meta.file, meta && meta.bytesInfo);
  if (!type.ok) return { ok: false, code: type.format === "heic" ? "HEIC" : "FORMAT", message: type.message };

  var width = Number(meta && meta.width) || 0;
  var height = Number(meta && meta.height) || 0;
  if (!width || !height) return { ok: false, code: "DIMENSIONS", message: "无法读取图片尺寸，请换一张图片" };
  if (purpose === "panorama") {
    if (width < PANO_MIN_WIDTH || height < PANO_MIN_HEIGHT) {
      return { ok: false, code: "PANO_SMALL", message: "全景图至少需要 1600×800 像素" };
    }
    if (width * height > PANO_MAX_PIXELS) {
      return { ok: false, code: "PANO_PIXELS", message: "全景图像素过高，请导出为不超过 8192×4096 的版本" };
    }
    var ratio = width / height;
    if (ratio < PANO_RATIO_MIN || ratio > PANO_RATIO_MAX) {
      return { ok: false, code: "PANO_RATIO", message: "请选择宽高比接近 2:1 的等距柱状全景图" };
    }
  }
  return { ok: true, format: type.format, width: width, height: height, size: size };
}

function readHeader(filePath, callback) {
  try {
    wx.getFileSystemManager().readFile({
      filePath: filePath,
      position: 0,
      length: 64,
      success: function (res) { callback(detectBytes(res.data)); },
      fail: function () { callback({ format: "unknown", heic: false }); }
    });
  } catch (e) {
    callback({ format: "unknown", heic: false });
  }
}

function inspect(file, purpose, callback) {
  var path = file && (file.tempFilePath || file.path);
  if (!path) {
    callback({ ok: false, code: "MISSING", message: "没有找到这张图片" });
    return;
  }
  var size = Number(file.size) || 0;
  function withSize(realSize) {
    readHeader(path, function (bytesInfo) {
      wx.getImageInfo({
        src: path,
        success: function (info) {
          callback(validateMeta({
            file: file,
            size: realSize,
            bytesInfo: bytesInfo,
            width: info.width,
            height: info.height
          }, purpose));
        },
        fail: function () {
          callback({ ok: false, code: "DIMENSIONS", message: "无法读取图片，请换一张图片" });
        }
      });
    });
  }
  if (size) {
    withSize(size);
    return;
  }
  wx.getFileInfo({
    filePath: path,
    success: function (res) { withSize(Number(res.size) || 0); },
    fail: function () { withSize(0); }
  });
}

module.exports = {
  NORMAL_MAX_BYTES: NORMAL_MAX_BYTES,
  PANO_MAX_BYTES: PANO_MAX_BYTES,
  PANO_MAX_PIXELS: PANO_MAX_PIXELS,
  detectBytes: detectBytes,
  readHeader: readHeader,
  extensionOf: extensionOf,
  classify: classify,
  validateMeta: validateMeta,
  inspect: inspect
};
