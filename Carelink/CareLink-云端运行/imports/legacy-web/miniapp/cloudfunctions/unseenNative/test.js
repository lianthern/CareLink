"use strict";

const assert = require("assert");

const fakeCloud = {
  DYNAMIC_CURRENT_ENV: "dynamic",
  init: function () {},
  database: function () {
    return {
      command: {},
      collection: function () { throw new Error("database must not be touched in pure tests"); }
    };
  }
};

const Module = require("module");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "wx-server-sdk") return fakeCloud;
  return originalLoad.call(this, request, parent, isMain);
};
const native = require("./index.js")._test;
Module._load = originalLoad;

assert.match(native.digest("same"), /^[a-f0-9]{40}$/);
assert.strictEqual(native.digest("same"), native.digest("same"));
assert.strictEqual(native.extensionFor("JPEG"), "jpg");
assert.strictEqual(native.extensionFor("png"), "png");
assert.throws(function () { native.extensionFor("heic"); }, /JPEG|PNG|WebP/);
assert.strictEqual(native.fileCloudPath("cloud://env.bucket/unseen/v1/a.jpg"), "unseen/v1/a.jpg");
assert.strictEqual(native.validateSid("u" + "a".repeat(24)), "u" + "a".repeat(24));
assert.throws(function () { native.validateSid("bad"); }, /空间编号/);
assert.strictEqual(native.validateClientId("create-" + "b".repeat(36), "create"),
  "create-" + "b".repeat(36));

console.log("✅ 微信原生云后端纯函数安全边界测试通过");
