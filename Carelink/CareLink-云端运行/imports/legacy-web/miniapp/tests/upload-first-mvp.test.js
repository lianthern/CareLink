#!/usr/bin/env node
"use strict";

var assert = require("assert");
var fs = require("fs");
var path = require("path");

var root = path.resolve(__dirname, "..");
var app = JSON.parse(fs.readFileSync(path.join(root, "app.json"), "utf8"));
var experimentRoutes = ["pages/demo/demo", "pages/capture/capture", "pages/sweep/sweep"];
var formalRoutes = app.pages.filter(function (route) { return experimentRoutes.indexOf(route) < 0; });
var formalSource = formalRoutes.map(function (route) {
  var base = path.join(root, route);
  return [".js", ".wxml", ".wxss"].map(function (ext) {
    return fs.readFileSync(base + ext, "utf8");
  }).join("\n");
}).join("\n");
var globalCss = fs.readFileSync(path.join(root, "app.wxss"), "utf8");
var uploadSource = fs.readFileSync(path.join(root, "utils/upload.js"), "utf8");
var storeSource = fs.readFileSync(path.join(root, "utils/store.js"), "utf8");
var indexSource = fs.readFileSync(path.join(root, "pages/index/index.js"), "utf8");
var indexMarkup = fs.readFileSync(path.join(root, "pages/index/index.wxml"), "utf8");
var indexCss = fs.readFileSync(path.join(root, "pages/index/index.wxss"), "utf8");
var appSource = fs.readFileSync(path.join(root, "app.js"), "utf8");
var panoSource = fs.readFileSync(path.join(root, "pages/pano/pano.js"), "utf8");
var photosSource = fs.readFileSync(path.join(root, "pages/photos/photos.js"), "utf8");
var demoSource = ["js", "wxml", "wxss"].map(function (ext) {
  return fs.readFileSync(path.join(root, "pages/demo/demo." + ext), "utf8");
}).join("\n");

assert.deepStrictEqual(app.pages, [
  "pages/index/index",
  "pages/demo/demo",
  "pages/demo-archive/demo-archive",
  "pages/demo-ai-pano/demo-ai-pano",
  "pages/demo-detail/demo-detail",
  "pages/demo-story/demo-story",
  "pages/demo-vision/demo-vision",
  "pages/create/create",
  "pages/space/space",
  "pages/photos/photos",
  "pages/pano/pano",
  "pages/capture/capture",
  "pages/sweep/sweep"
]);
assert.strictEqual(/navigateTo\([^\n]*(capture|sweep)/.test(formalSource), false,
  "formal product pages must not link directly to capture/sweep");
assert.strictEqual(/createVKSession|createCameraContext|<camera\b|uploadFromCamera/.test(formalSource), false,
  "formal product pages must not start a capture/stitch flow");
assert.ok(/pages\/capture\/capture\?source=demo/.test(demoSource) &&
  /pages\/sweep\/sweep\?source=demo/.test(demoSource),
  "camera experiments must only be reachable from the isolated demo center");
assert.ok(/不会自动上传|仅本机处理/.test(demoSource),
  "demo center must state its no-auto-upload boundary");
[
  "#F4EEF0", "#FFF9F7", "#FFFCFB", "#59383E", "#765A60",
  "#F8C8D6", "#FDE0A8", "#FF7F9F"
].forEach(function (token) { assert.ok(globalCss.indexOf(token) >= 0, "missing visual token " + token); });
assert.ok(/linear-gradient\(100deg, #F8C8D6, #FDE0A8\)/.test(globalCss));
assert.ok(/function deleteSpace\(/.test(storeSource), "local spaces need a deletion/cleanup API");
assert.ok(/wx\.showModal\(/.test(indexSource) && /onDeleteLocal/.test(indexSource), "home deletion must require confirmation");
assert.ok(/fallbackSrc/.test(panoSource) && /usingFallback/.test(panoSource), "pano viewer must fall back after original load failure");
assert.ok(/JPEG_CONVERSION/.test(uploadSource), "remote non-JPEG conversion failures must be explicit");
assert.ok(/_skipNextShow/.test(photosSource), "photos must not issue duplicate onLoad/onShow fetches");
assert.ok(/onUnload/.test(photosSource) && /_loadToken/.test(photosSource), "photos async callbacks need unload guards");
assert.ok(/wx\.setEnableDebug\(\{ enableDebug: false \}\)/.test(appSource), "formal launch must disable persisted vConsole");
assert.ok(/SHARED MEMORY SPACE/.test(indexMarkup) && /从哪个场景开始/.test(indexMarkup), "mini home must use the shared Web information hierarchy");
assert.ok(/演示中心/.test(indexMarkup) && /onDemo/.test(indexSource), "mini home must keep a visible demo-center entry");
assert.ok(/min-width:\s*0/.test(indexCss) && /overflow:\s*hidden/.test(indexCss), "mini home must constrain shrinking rows");
assert.ok(/\.open-button\s*\{[^}]*width:\s*128rpx[^}]*min-width:\s*128rpx[^}]*max-width:\s*128rpx/s.test(indexCss), "open action width must be bounded on real devices");

var memory = {};
var headers = {};
var infos = {};
var sizes = {};
var choosePending = null;
var chooseCount = 0;
var failSave = false;
var failCompress = false;
var uploadCalls = 0;
var uploadOutcome = "success";
var removedFiles = [];
var requestResponder = null;
var cloudResponder = null;
var randomCounter = 0;
var uploadRequests = [];
var nativeUploadRequests = [];

function jpegHeader() {
  var bytes = new Uint8Array(64);
  bytes[0] = 0xff; bytes[1] = 0xd8; bytes[2] = 0xff;
  return bytes;
}

function pngHeader() {
  var bytes = new Uint8Array(64);
  bytes[0] = 0x89; bytes[1] = 0x50; bytes[2] = 0x4e; bytes[3] = 0x47;
  return bytes;
}

global.wx = {
  env: { USER_DATA_PATH: "/user" },
  getStorageSync: function (key) { return memory[key]; },
  setStorageSync: function (key, value) { memory[key] = JSON.parse(JSON.stringify(value)); },
  getRandomValues: function (opts) {
    var bytes = new Uint8Array(opts.length);
    randomCounter += 1;
    for (var index = 0; index < bytes.length; index += 1) bytes[index] = (randomCounter + index * 17) & 255;
    opts.success({ randomValues: bytes.buffer });
  },
  getFileSystemManager: function () {
    return {
      readFile: function (opts) {
        var data = headers[opts.filePath] || jpegHeader();
        opts.success({ data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) });
      },
      saveFile: function (opts) {
        if (failSave) opts.fail({ errMsg: "quota" });
        else opts.success({ savedFilePath: "/user/" + path.basename(opts.tempFilePath) });
      }
    };
  },
  getImageInfo: function (opts) {
    var info = infos[opts.src] || { width: 4032, height: 3024 };
    opts.success(info);
  },
  getFileInfo: function (opts) { opts.success({ size: sizes[opts.filePath] || 2 * 1024 * 1024 }); },
  compressImage: function (opts) {
    if (failCompress) { opts.fail({ errMsg: "compress fail" }); return; }
    var compressed = opts.src + ".compressed.jpg";
    headers[compressed] = jpegHeader();
    infos[compressed] = infos[opts.src] || { width: 2560, height: 1920 };
    sizes[compressed] = 900000;
    opts.success({ tempFilePath: compressed });
  },
  chooseMedia: function (opts) { chooseCount += 1; choosePending = opts; },
  cloud: {
    callFunction: function (opts) {
      if (cloudResponder) cloudResponder(opts);
      else opts.fail({ errMsg: "cloud.callFunction:fail offline" });
      return null;
    },
    uploadFile: function (opts) {
      nativeUploadRequests.push(opts);
      if (uploadOutcome === "fail") opts.fail({ errMsg: "cloud.uploadFile:fail offline" });
      else opts.success({ fileID: "cloud://test.env/" + opts.cloudPath });
      return { abort: function () {} };
    }
  },
  request: function (opts) {
    if (requestResponder) requestResponder(opts);
    else opts.fail({ errMsg: "offline" });
  },
  uploadFile: function (opts) {
    uploadCalls += 1;
    uploadRequests.push(opts);
    if (uploadOutcome === "fail") opts.fail({ errMsg: "offline" });
    else opts.success({ statusCode: 201, data: "" });
    return { abort: function () {} };
  }
  ,removeSavedFile: function (opts) { removedFiles.push(opts.filePath); if (opts.success) opts.success({}); }
};

var rules = require("../utils/file-rules.js");
var store = require("../utils/store.js");
var upload = require("../utils/upload.js");
var util = require("../utils/util.js");

var normalized = util.normalizeRemote("fallback", {
  nodes: [{
    panoMini: "https://example.invalid/pano-mini.jpg",
    panorama: "https://example.invalid/pano.jpg"
  }],
  pending: [{ id: "pending-1" }]
});
assert.strictEqual(normalized.panorama.src, "https://example.invalid/pano.jpg");
assert.strictEqual(normalized.panorama.fallbackSrc, "https://example.invalid/pano-mini.jpg");
assert.strictEqual(normalized.panorama.thumbSrc, "https://example.invalid/pano-mini.jpg");
assert.strictEqual(normalized.pending.length, 1);
assert.strictEqual(util.uploadGate({ collection: { status: "closed" } }).code, "COLLECTION_CLOSED");
assert.strictEqual(util.uploadGate({ capacity: { full: true, remaining: 2 } }).code, "CAPACITY_FULL");
assert.strictEqual(util.uploadGate({ capacity: { full: false, remaining: 3 } }).remaining, 3);
assert.strictEqual(util.uploadGate({ capacity: { full: false, remaining: null } }).remaining, null);
assert.strictEqual(util.uploadGate({ capacity: { maxPhotos: 10, received: 8 } }).remaining, 2);

var heic = new Uint8Array(32);
"ftyp".split("").forEach(function (char, index) { heic[4 + index] = char.charCodeAt(0); });
"mif1".split("").forEach(function (char, index) { heic[8 + index] = char.charCodeAt(0); });
"heic".split("").forEach(function (char, index) { heic[16 + index] = char.charCodeAt(0); });
assert.strictEqual(rules.detectBytes(heic).heic, true, "compatible HEIC brand at byte 16 must be detected");
assert.strictEqual(rules.validateMeta({
  file: { name: "pano.jpg" }, bytesInfo: rules.detectBytes(jpegHeader()),
  size: 4 * 1024 * 1024, width: 2000, height: 1000
}, "panorama").ok, true);
assert.strictEqual(rules.validateMeta({
  file: { name: "pano.jpg" }, bytesInfo: rules.detectBytes(jpegHeader()),
  size: 4 * 1024 * 1024, width: 2000, height: 1300
}, "panorama").code, "PANO_RATIO");
assert.strictEqual(rules.validateMeta({
  file: { name: "x.heic" }, bytesInfo: rules.detectBytes(heic), size: 1000, width: 2000, height: 1000
}, "panorama").code, "HEIC");
assert.strictEqual(rules.validateMeta({
  file: { name: "zero.jpg" }, bytesInfo: rules.detectBytes(jpegHeader()), size: 0, width: 1600, height: 800
}, "panorama").code, "SIZE_UNKNOWN");
assert.strictEqual(rules.validateMeta({
  file: { name: "huge.jpg" }, bytesInfo: rules.detectBytes(jpegHeader()), size: 1000000, width: 10000, height: 5000
}, "panorama").code, "PANO_PIXELS");

var local = store.createSpace({ title: "Node 模拟空间", date: "2026-08-02" });
assert.ok(store.getSpace(local.id));

var disposable = store.createSpace({ title: "待删除空间", panorama: { src: "/user/pano.jpg" } });
store.addPhoto(disposable.id, { clientUploadId: "delete-photo", src: "/user/photo.jpg" });
var deleteResult = null;
assert.strictEqual(store.deleteSpace(disposable.id, function (err, result) {
  assert.strictEqual(err, null);
  deleteResult = result;
}), true);
assert.strictEqual(store.getSpace(disposable.id), null);
assert.deepStrictEqual(removedFiles.slice().sort(), ["/user/pano.jpg", "/user/photo.jpg"]);
assert.deepStrictEqual(deleteResult, { deleted: true, removedFiles: 2, failedFiles: 0 });
removedFiles.length = 0;

var firstCallback = null;
upload.startUpload(local.id, function (err, batch) { firstCallback = { err: err, batch: batch }; });
var busyError = null;
upload.startUpload(local.id, function (err) { busyError = err; });
assert.strictEqual(chooseCount, 1, "double tap must open the album once");
assert.strictEqual(busyError.code, "BUSY");
headers["/tmp/a.jpg"] = jpegHeader();
infos["/tmp/a.jpg"] = { width: 4000, height: 3000 };
sizes["/tmp/a.jpg"] = 3 * 1024 * 1024;
choosePending.success({ tempFiles: [{ tempFilePath: "/tmp/a.jpg", size: sizes["/tmp/a.jpg"] }] });
assert.strictEqual(firstCallback.err, null);
assert.strictEqual(upload.getMyUploads(local.id)[0].status, "done");
assert.strictEqual(store.getSpace(local.id).photos.length, 1);

upload.finishQueue(local.id);
failSave = true;
upload.startUpload(local.id, function () {});
headers["/tmp/retry.jpg"] = jpegHeader();
infos["/tmp/retry.jpg"] = { width: 3000, height: 2000 };
choosePending.success({ tempFiles: [{ tempFilePath: "/tmp/retry.jpg", size: 2000000 }] });
var failedId = upload.getMyUploads(local.id)[0].clientUploadId;
assert.strictEqual(upload.getMyUploads(local.id)[0].status, "error");
failSave = false;
upload.retryFailed(local.id, function (count, err) { assert.strictEqual(count, 1); assert.strictEqual(err, null); });
assert.strictEqual(upload.getMyUploads(local.id)[0].clientUploadId, failedId, "retry must preserve clientUploadId");
assert.strictEqual(upload.getMyUploads(local.id)[0].status, "done");

upload.finishQueue(local.id);
upload.startUpload(local.id, function () {});
var nine = [];
for (var i = 0; i < 9; i += 1) {
  var filePath = "/tmp/" + i + ".jpg";
  headers[filePath] = jpegHeader(); infos[filePath] = { width: 2000, height: 1500 }; sizes[filePath] = 1000000;
  nine.push({ tempFilePath: filePath, size: 1000000 });
}
assert.strictEqual(choosePending.count, 9);
choosePending.success({ tempFiles: nine });
assert.strictEqual(upload.getMyUploads(local.id).length, 9);
var fullError = null;
upload.startUpload(local.id, function (err) { fullError = err; });
assert.strictEqual(fullError.code, "QUEUE_FULL", "done/error items still count toward the nine-item queue cap");

function remotePayload(sid, options) {
  options = options || {};
  return {
    title: sid,
    collection: { status: options.status || "open" },
    capacity: {
      full: !!options.full,
      remaining: options.remaining === undefined ? null : options.remaining
    },
    upload: {
      host: "https://psm-advx-2026.oss-cn-hangzhou.aliyuncs.com",
      OSSAccessKeyId: "a",
      policy: "p",
      Signature: "s",
      keyPrefix: "spaces/" + sid + "/inbox-v2/g1/",
      expiresAt: options.expiresAt === undefined ? Date.now() / 1000 + 3600 : options.expiresAt,
      maxSize: 12 * 1024 * 1024
    }
  };
}

var remoteError = null;
var chooseBeforeGate = chooseCount;
requestResponder = function (opts) {
  opts.success({ statusCode: 200, data: remotePayload("expired-space", { expiresAt: 1 }) });
};
upload.startUpload("expired-space", function (err) { remoteError = err; });
assert.strictEqual(remoteError.code, "POLICY_EXPIRED");
assert.strictEqual(chooseCount, chooseBeforeGate, "expired policy must fail before opening the album");
assert.strictEqual(uploadCalls, 0, "expired policy must fail before wx.uploadFile");
assert.strictEqual(upload.isBusy("expired-space"), false, "expired policy must terminate instead of polling forever");

var closedError = null;
requestResponder = function (opts) {
  opts.success({ statusCode: 200, data: remotePayload("closed-space", { status: "closed" }) });
};
upload.startUpload("closed-space", function (err) { closedError = err; });
assert.strictEqual(closedError.code, "COLLECTION_CLOSED");
assert.strictEqual(closedError.retryable, false);
assert.strictEqual(chooseCount, chooseBeforeGate, "closed collection must not open the album");

var capacityError = null;
requestResponder = function (opts) {
  opts.success({ statusCode: 200, data: remotePayload("full-space", { full: true, remaining: 0 }) });
};
upload.startUpload("full-space", function (err) { capacityError = err; });
assert.strictEqual(capacityError.code, "CAPACITY_FULL");
assert.strictEqual(chooseCount, chooseBeforeGate, "full collection must not open the album");

requestResponder = function (opts) {
  opts.success({ statusCode: 200, data: remotePayload("limited-space", { remaining: 2 }) });
};
upload.startUpload("limited-space", function (err) { assert.strictEqual(err, null); });
assert.strictEqual(choosePending.count, 2, "server remaining must cap the album picker");
["limited-a.jpg", "limited-b.jpg"].forEach(function (name) {
  headers["/tmp/" + name] = jpegHeader();
  infos["/tmp/" + name] = { width: 2000, height: 1500 };
  sizes["/tmp/" + name] = 1000000;
});
choosePending.success({ tempFiles: [
  { tempFilePath: "/tmp/limited-a.jpg", name: "limited-a.jpg", size: 1000000 },
  { tempFilePath: "/tmp/limited-b.jpg", name: "limited-b.jpg", size: 1000000 }
] });
assert.strictEqual(uploadCalls, 2);
assert.strictEqual(upload.getMyUploads("limited-space").every(function (item) { return item.status === "done"; }), true);

var nativeActions = [];
var nativeUploadIds = [];
cloudResponder = function (opts) {
  var action = opts.data.action;
  nativeActions.push(action);
  if (action === "getSpace") {
    opts.success({ result: { ok: true, data: { manifest: {
      title: "managed native",
      collection: { status: "open" },
      capacity: { remaining: 1, full: false },
      upload: { enabled: true, mode: "native-cloud-v1", functionName: "unseenNative",
        maxSize: 20 * 1024 * 1024 }
    } } } });
    return;
  }
  if (action === "preparePhoto") {
    nativeUploadIds.push(opts.data.clientUploadId);
    opts.success({ result: { ok: true, data: {
      spaceId: opts.data.spaceId,
      clientUploadId: opts.data.clientUploadId,
      photoId: "p_222222222222222222222222",
      cloudPath: "unseen/v1/uploads/" + opts.data.spaceId + "/p_222222222222222222222222.jpg",
      committed: false
    } } });
    return;
  }
  assert.strictEqual(action, "commitPhoto");
  assert.ok(/^cloud:\/\/test\.env\/unseen\/v1\/uploads\//.test(opts.data.fileID));
  opts.success({ result: { ok: true, data: {
    spaceId: opts.data.spaceId,
    photo: { id: "p_222222222222222222222222" }
  } } });
};
var cloudUploadsBefore = nativeUploadRequests.length;
upload.startUpload("u111111111111111111111111", function (err) { assert.strictEqual(err, null); });
headers["/tmp/native.jpg"] = jpegHeader();
infos["/tmp/native.jpg"] = { width: 1800, height: 1200 };
sizes["/tmp/native.jpg"] = 900000;
choosePending.success({ tempFiles: [{ tempFilePath: "/tmp/native.jpg", name: "native.jpg", size: 900000 }] });
assert.deepStrictEqual(nativeActions, ["getSpace", "preparePhoto", "commitPhoto"],
  "native cloud must fetch, prepare, upload, then commit");
assert.strictEqual(nativeUploadRequests.length, cloudUploadsBefore + 1);
assert.strictEqual(nativeUploadRequests[nativeUploadRequests.length - 1].config.env, util.NATIVE_CLOUD_ENV);
assert.ok(/^upload-[a-f0-9]{36}$/.test(nativeUploadIds[0]), "native clientUploadId must use secure random bytes");
assert.strictEqual(upload.getMyUploads("u111111111111111111111111")[0].status, "done");

var retryNativeIds = [];
var commitAttempts = 0;
cloudResponder = function (opts) {
  var action = opts.data.action;
  if (action === "getSpace") {
    opts.success({ result: { ok: true, data: { manifest: {
      title: "managed retry",
      collection: { status: "open" },
      capacity: { remaining: 1, full: false },
      upload: { enabled: true, mode: "native-cloud-v1", functionName: "unseenNative",
        maxSize: 20 * 1024 * 1024 }
    } } } });
    return;
  }
  if (action === "preparePhoto") {
    retryNativeIds.push(opts.data.clientUploadId);
    opts.success({ result: { ok: true, data: {
      spaceId: opts.data.spaceId,
      clientUploadId: opts.data.clientUploadId,
      photoId: "p_333333333333333333333333",
      cloudPath: "unseen/v1/uploads/" + opts.data.spaceId + "/p_333333333333333333333333.jpg",
      committed: false
    } } });
    return;
  }
  commitAttempts += 1;
  if (commitAttempts === 1) opts.fail({ errMsg: "cloud.callFunction:fail offline" });
  else opts.success({ result: { ok: true, data: { photo: { id: "p_333333333333333333333333" } } } });
};
upload.startUpload("u333333333333333333333333", function (err) { assert.strictEqual(err, null); });
headers["/tmp/native-retry.jpg"] = jpegHeader();
infos["/tmp/native-retry.jpg"] = { width: 1800, height: 1200 };
sizes["/tmp/native-retry.jpg"] = 900000;
choosePending.success({ tempFiles: [{ tempFilePath: "/tmp/native-retry.jpg", name: "native-retry.jpg", size: 900000 }] });
assert.strictEqual(upload.getMyUploads("u333333333333333333333333")[0].status, "error");
upload.retryFailed("u333333333333333333333333", function (count, err) {
  assert.strictEqual(count, 1);
  assert.strictEqual(err, null);
});
assert.deepStrictEqual(retryNativeIds, [retryNativeIds[0], retryNativeIds[0]],
  "native retry must preserve the same clientUploadId");
assert.strictEqual(upload.getMyUploads("u333333333333333333333333")[0].status, "done");

var uploadsBeforePng = uploadCalls;
failCompress = true;
requestResponder = function (opts) {
  opts.success({ statusCode: 200, data: remotePayload("png-space", { remaining: 1 }) });
};
upload.startUpload("png-space", function (err) { assert.strictEqual(err, null); });
headers["/tmp/source.png"] = pngHeader();
infos["/tmp/source.png"] = { width: 1800, height: 1200 };
sizes["/tmp/source.png"] = 800000;
choosePending.success({ tempFiles: [{ tempFilePath: "/tmp/source.png", name: "相册/source.png", size: 800000 }] });
var pngItem = upload.getMyUploads("png-space")[0];
assert.strictEqual(pngItem.name, "source.png");
assert.strictEqual(pngItem.errorCode, "JPEG_CONVERSION");
assert.strictEqual(pngItem.retryable, false);
assert.strictEqual(upload.statusLabel(pngItem), "无法上传");
assert.notStrictEqual(upload.statusLabel(pngItem), pngItem.error, "status and error copy must not be duplicated");
assert.strictEqual(uploadCalls, uploadsBeforePng, "PNG must never be uploaded under a .jpg key when conversion fails");
upload.retryFailed("png-space", function (count, err) { assert.strictEqual(count, 0); assert.strictEqual(err, null); });

requestResponder = function (opts) {
  opts.success({ statusCode: 200, data: remotePayload("jpeg-fallback-space", { remaining: 1 }) });
};
upload.startUpload("jpeg-fallback-space", function (err) { assert.strictEqual(err, null); });
headers["/tmp/original.jpg"] = jpegHeader();
infos["/tmp/original.jpg"] = { width: 1800, height: 1200 };
sizes["/tmp/original.jpg"] = 900000;
choosePending.success({ tempFiles: [{ tempFilePath: "/tmp/original.jpg", name: "original.jpg", size: 900000 }] });
assert.strictEqual(uploadCalls, uploadsBeforePng + 1, "verified JPEG may fall back to the original after compression failure");
assert.strictEqual(upload.getMyUploads("jpeg-fallback-space")[0].status, "done");
failCompress = false;

var callsBeforeRetryLimit = uploadCalls;
uploadOutcome = "fail";
requestResponder = function (opts) {
  opts.success({ statusCode: 200, data: remotePayload("retry-limit-space", { remaining: 3 }) });
};
upload.startUpload("retry-limit-space", function (err) { assert.strictEqual(err, null); });
var retryFiles = ["retry-a.jpg", "retry-b.jpg", "retry-c.jpg"].map(function (name) {
  var retryPath = "/tmp/" + name;
  headers[retryPath] = jpegHeader();
  infos[retryPath] = { width: 1800, height: 1200 };
  sizes[retryPath] = 900000;
  return { tempFilePath: retryPath, name: name, size: 900000 };
});
choosePending.success({ tempFiles: retryFiles });
assert.strictEqual(uploadCalls, callsBeforeRetryLimit + 3);
assert.strictEqual(upload.getMyUploads("retry-limit-space").every(function (item) {
  return item.status === "error" && item.retryable === true;
}), true);

uploadOutcome = "success";
requestResponder = function (opts) {
  opts.success({ statusCode: 200, data: remotePayload("retry-limit-space", { remaining: 1 }) });
};
upload.retryFailed("retry-limit-space", function (count, err) {
  assert.strictEqual(count, 1, "retry must also respect current server remaining");
  assert.strictEqual(err, null);
});
assert.strictEqual(upload.getMyUploads("retry-limit-space").filter(function (item) { return item.status === "done"; }).length, 1);
assert.strictEqual(upload.getMyUploads("retry-limit-space").filter(function (item) { return item.status === "error"; }).length, 2);
upload.clearSpace("retry-limit-space");
removedFiles.length = 0;

var rollover = { clientUploadId: "upload-stable", retryFilePath: "/user/retry.jpg" };
upload._ensureRemoteKey(rollover, { keyPrefix: "spaces/s4/inbox-v2/g1/" });
assert.strictEqual(rollover.key, "spaces/s4/inbox-v2/g1/stable__miniapp__free.jpg");
upload._ensureRemoteKey(rollover, { keyPrefix: "spaces/s4/inbox-v2/g2/" });
assert.strictEqual(rollover.key, "spaces/s4/inbox-v2/g2/stable__miniapp__free.jpg", "policy rotation must replace the old prefix");
upload._releaseRetryCopy(rollover);
assert.deepStrictEqual(removedFiles, ["/user/retry.jpg"], "successful remote upload must release its retry copy");

console.log("✅ upload-first 删除清理、容量门禁、JPEG 远传、永久错误、稳定重试、生命周期与全景回退契约均通过");
