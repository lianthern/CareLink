#!/usr/bin/env node
"use strict";

var assert = require("assert");
var fs = require("fs");
var path = require("path");

var root = path.resolve(__dirname, "..");
var memory = {};
var randomSeed = 10;
var pageConfigs = [];
var calls = [];
var uploads = [];
var redirects = [];
var removedFiles = [];
var failCreate = false;
var failGet = false;
var scenario = "plain";

var SID_PLAIN = "u111111111111111111111111";
var SID_PANO = "u222222222222222222222222";

function managedManifest(sid, withPano) {
  return {
    schema: "unseen-native/1",
    id: sid,
    title: withPano ? "云端全景空间" : "云端普通空间",
    date: "2026-08-02",
    place: "Brisbane",
    scene: "旅行",
    subtitle: "场景：旅行",
    collection: { status: "open", open: true },
    capacity: { maxPhotos: 90, received: 0, remaining: 90, full: false },
    nodes: [{ id: "n1", panorama: withPano ? "https://example.invalid/pano.jpg" : null,
      panoMini: withPano ? "https://example.invalid/pano.jpg" : null }],
    photos: [],
    pending: [],
    upload: { enabled: true, mode: "native-cloud-v1", functionName: "unseenNative" }
  };
}

function cloudSuccess(opts, data) {
  opts.success({ result: { ok: true, data: data } });
}

global.wx = {
  env: { USER_DATA_PATH: "/user" },
  getStorageSync: function (key) { return memory[key]; },
  setStorageSync: function (key, value) { memory[key] = JSON.parse(JSON.stringify(value)); },
  getRandomValues: function (opts) {
    var bytes = new Uint8Array(opts.length);
    randomSeed += 1;
    for (var index = 0; index < bytes.length; index += 1) bytes[index] = (randomSeed + index * 13) & 255;
    opts.success({ randomValues: bytes.buffer });
  },
  cloud: {
    callFunction: function (opts) {
      calls.push(opts);
      var action = opts.data && opts.data.action;
      if (failCreate && action === "createSpace") {
        opts.fail({ errMsg: "cloud.callFunction:fail timeout" });
        return null;
      }
      if (failGet && action === "getSpace") {
        opts.fail({ errMsg: "cloud.callFunction:fail network" });
        return null;
      }
      if (action === "createSpace") {
        var withPano = !!(opts.data.media && opts.data.media.panorama);
        var sid = withPano ? SID_PANO : SID_PLAIN;
        cloudSuccess(opts, {
          spaceId: sid,
          status: "draft",
          panoramaCloudPath: withPano ? "unseen/v1/staging/" + sid + "/panorama.jpg" : ""
        });
        return null;
      }
      if (action === "finalizeSpace") {
        var panorama = scenario === "pano";
        var finalSid = panorama ? SID_PANO : SID_PLAIN;
        cloudSuccess(opts, {
          spaceId: finalSid,
          status: "published",
          manifest: managedManifest(finalSid, panorama)
        });
        return null;
      }
      if (action === "getSpace") {
        cloudSuccess(opts, { manifest: managedManifest(opts.data.spaceId, false) });
        return null;
      }
      opts.success({ result: { ok: false, error: { code: "UNKNOWN_ACTION", message: "unexpected action" } } });
      return null;
    },
    uploadFile: function (opts) {
      uploads.push(opts);
      opts.success({ fileID: "cloud://test.env/" + opts.cloudPath });
      return { abort: function () {} };
    }
  },
  request: function (opts) { opts.fail({ errMsg: "request:fail legacy offline" }); },
  redirectTo: function (opts) { redirects.push(opts.url); },
  navigateBack: function () {},
  showToast: function () {},
  hideShareMenu: function () {},
  showShareMenu: function () {},
  removeSavedFile: function (opts) {
    removedFiles.push(opts.filePath);
    if (opts.success) opts.success({});
  },
  getFileSystemManager: function () {
    return {
      saveFile: function (opts) { opts.success({ savedFilePath: "/user/" + path.basename(opts.tempFilePath) }); }
    };
  }
};

global.getApp = function () { return { globalData: { nav: { barTop: 20, barHeight: 44 } } }; };
global.Page = function (config) { pageConfigs.push(config); };

var util = require("../utils/util.js");
var store = require("../utils/store.js");

assert.strictEqual(util.NATIVE_CLOUD_ENV, "cloudbase-d0gowqdov1065e179");
assert.strictEqual(util.NATIVE_CLOUD_FUNCTION, "unseenNative");
assert.strictEqual(util.uploadNativeFile("/tmp/a.jpg", "bad/path.jpg", function (error) {
  assert.strictEqual(error.code, "UNTRUSTED_CLOUD_PATH");
}), null);

require("../pages/create/create.js");
var createConfig = pageConfigs.pop();

function makePage(config) {
  var page = Object.create(config);
  page.data = JSON.parse(JSON.stringify(config.data));
  page.setData = function (values) {
    Object.keys(values || {}).forEach(function (key) { page.data[key] = values[key]; });
  };
  return page;
}

var plain = makePage(createConfig);
plain.onLoad();
plain.setData({ title: "云端普通空间", date: "2026-08-02", place: "Brisbane", sceneIndex: 1 });
plain.onSubmit();
assert.deepStrictEqual(calls.slice(0, 2).map(function (item) { return item.data.action; }),
  ["createSpace", "finalizeSpace"]);
assert.ok(/^create-[a-f0-9]{36}$/.test(calls[0].data.clientCreateId));
assert.strictEqual(calls[0].data.place, "Brisbane");
assert.strictEqual(calls[0].data.scene, "旅行");
assert.strictEqual(calls[1].data.panoramaFileID, "");
assert.strictEqual(calls[0].name, "unseenNative");
assert.strictEqual(calls[0].config.env, util.NATIVE_CLOUD_ENV);
assert.strictEqual(redirects[0], "/pages/space/space?sid=" + SID_PLAIN);
assert.strictEqual(store.getHostKey(SID_PLAIN), "");
assert.strictEqual(store.getSpace(SID_PLAIN).localOnly, false);

scenario = "pano";
var pano = makePage(createConfig);
pano.setData({
  title: "云端全景空间",
  panorama: { tempFilePath: "/tmp/pano.jpg", width: 2000, height: 1000,
    size: 4 * 1024 * 1024, format: "jpeg" }
});
pano.onSubmit();
assert.deepStrictEqual(calls.slice(2, 4).map(function (item) { return item.data.action; }),
  ["createSpace", "finalizeSpace"]);
assert.strictEqual(uploads.length, 1);
assert.strictEqual(uploads[0].cloudPath, "unseen/v1/staging/" + SID_PANO + "/panorama.jpg");
assert.strictEqual(uploads[0].config.env, util.NATIVE_CLOUD_ENV);
assert.strictEqual(calls[3].data.panoramaFileID,
  "cloud://test.env/unseen/v1/staging/" + SID_PANO + "/panorama.jpg");
assert.strictEqual(store.getHostKey(SID_PANO), "");
assert.strictEqual(store.getSpace(SID_PANO).panorama.src, "https://example.invalid/pano.jpg");

var beforeFailureCount = store.listSpaces().length;
failCreate = true;
var failed = makePage(createConfig);
failed.setData({ title: "失败后仍保留", place: "原地点" });
failed.onSubmit();
assert.strictEqual(failed.data.title, "失败后仍保留");
assert.strictEqual(failed.data.place, "原地点");
assert.ok(/超时|网络/.test(failed.data.cloudError));
assert.strictEqual(failed.data.submitting, false);
assert.strictEqual(store.listSpaces().length, beforeFailureCount,
  "cloud failure must never silently create a local space");
failCreate = false;

var local = makePage(createConfig);
local.setData({ title: "明确的本机空间", sceneIndex: 3 });
local.onSaveLocal();
var localRecord = store.listSpaces().filter(function (item) { return item.title === "明确的本机空间"; })[0];
assert.ok(localRecord && localRecord.localOnly === true);

require("../pages/space/space.js");
var spaceConfig = pageConfigs.pop();
var remotePage = makePage(spaceConfig);
remotePage.setData({ sid: SID_PLAIN, canShare: true, space: { title: "云端普通空间" } });
var share = remotePage.onShareAppMessage();
assert.strictEqual(share.path, "/pages/space/space?sid=" + SID_PLAIN);
assert.strictEqual(share.path.split("?")[1], "sid=" + SID_PLAIN);

failGet = true;
var reopened = null;
util.loadSpace(SID_PLAIN, function (error, space) {
  assert.strictEqual(error, null);
  reopened = space;
}, true);
assert.ok(reopened && reopened.id === SID_PLAIN && reopened.offline === true,
  "remote history must reopen from a local snapshot when native cloud is offline");

var deleteResult = null;
store.deleteSpace(SID_PLAIN, function (error, result) {
  assert.strictEqual(error, null);
  deleteResult = result;
});
assert.deepStrictEqual(deleteResult, { deleted: true, remoteOnly: true, removedFiles: 0, failedFiles: 0 });
assert.strictEqual(store.getSpace(SID_PLAIN), null);
assert.deepStrictEqual(removedFiles, [], "removing a remote history record must never delete cloud files");

var createWxml = fs.readFileSync(path.join(root, "pages/create/create.wxml"), "utf8");
var spaceWxml = fs.readFileSync(path.join(root, "pages/space/space.wxml"), "utf8");
var appSource = fs.readFileSync(path.join(root, "app.js"), "utf8");
var project = JSON.parse(fs.readFileSync(path.join(root, "project.config.json"), "utf8"));
assert.ok(/创建云端共享空间/.test(createWxml) && /仅保存在本机/.test(createWxml));
assert.ok(/open-type="share"/.test(spaceWxml) && /wx:if="\{\{canShare\}\}"/.test(spaceWxml));
assert.strictEqual(/hostKey|host_key/.test(spaceWxml), false);
assert.ok(/wx\.cloud\.init/.test(appSource));
assert.ok(project.packOptions.ignore.some(function (item) { return item.value === "cloudfunctions"; }));

console.log("✅ 微信原生云 create→uploadFile→finalize、sid 分享、离线快照与本机次入口契约均通过");
