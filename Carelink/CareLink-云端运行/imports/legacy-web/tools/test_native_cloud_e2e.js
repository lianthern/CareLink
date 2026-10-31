#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const automator = require("/opt/homebrew/lib/node_modules/miniprogram-automator");

const cliPath = process.env.WECHAT_DEVTOOLS_CLI ||
  "/Applications/wechatwebdevtools.app/Contents/MacOS/cli";
const projectPath = path.resolve(__dirname, "../miniapp");
const automationPort = Math.max(1024, Number(process.env.WECHAT_AUTOMATION_PORT) || 9440);
const envId = "cloudbase-d0gowqdov1065e179";
const functionName = "unseenNative";
const fixturePath = path.resolve(__dirname, "../miniapp/assets/panos/expo.jpg");

function assert(condition, message, detail) {
  if (condition) return;
  const error = new Error(message);
  error.detail = detail;
  throw error;
}

async function evaluate(miniProgram, source, argument) {
  return miniProgram.evaluate(source, argument);
}

async function cloudCall(miniProgram, data) {
  const response = await evaluate(miniProgram, function (input) {
    return new Promise(function (resolve) {
      wx.cloud.callFunction({
        name: input.functionName,
        data: input.data,
        config: { env: input.envId },
        success: function (result) { resolve({ ok: true, result: result.result }); },
        fail: function (error) { resolve({ ok: false, error: error }); }
      });
    });
  }, { envId, functionName, data });
  assert(response && response.ok, "wx.cloud.callFunction 调用失败", response);
  return response.result;
}

async function writeFixture(miniProgram, base64) {
  const response = await evaluate(miniProgram, function (input) {
    return new Promise(function (resolve) {
      const target = wx.env.USER_DATA_PATH + "/unseen-native-cloud-e2e.jpg";
      wx.getFileSystemManager().writeFile({
        filePath: target,
        data: input.base64,
        encoding: "base64",
        success: function () { resolve({ ok: true, filePath: target }); },
        fail: function (error) { resolve({ ok: false, error: error }); }
      });
    });
  }, { base64 });
  assert(response && response.ok && response.filePath, "无法写入 E2E 图片", response);
  return response.filePath;
}

async function uploadFile(miniProgram, filePath, cloudPath) {
  const response = await evaluate(miniProgram, function (input) {
    return new Promise(function (resolve) {
      wx.cloud.uploadFile({
        cloudPath: input.cloudPath,
        filePath: input.filePath,
        config: { env: input.envId },
        success: function (result) { resolve({ ok: true, fileID: result.fileID }); },
        fail: function (error) { resolve({ ok: false, error: error }); }
      });
    });
  }, { envId, filePath, cloudPath });
  assert(response && response.ok && response.fileID, "wx.cloud.uploadFile 调用失败", response);
  return response.fileID;
}

async function main() {
  const miniProgram = await automator.launch({
    cliPath,
    projectPath,
    port: automationPort,
    timeout: 60000,
    trustProject: true
  });
  const suffix = Date.now().toString(36) + Math.random().toString(16).slice(2, 10);
  let sid = "";
  try {
    await evaluate(miniProgram, function (input) {
      wx.cloud.init({ env: input.envId, traceUser: true });
      return true;
    }, { envId });
    const fixture = await writeFixture(miniProgram, fs.readFileSync(fixturePath).toString("base64"));

    const health = await cloudCall(miniProgram, { action: "health" });
    assert(health && health.ok && health.data && health.data.service === "unseen-native-cloud",
      "健康检查失败", health);

    const created = await cloudCall(miniProgram, {
      action: "createSpace",
      clientCreateId: "create-e2e-" + suffix,
      title: "UNSEEN 原生云 E2E",
      date: "2026-08-02",
      place: "Brisbane",
      scene: "测试",
      subtitle: "场景：测试",
      media: { panorama: true, panoramaFormat: "jpeg" }
    });
    assert(created && created.ok && created.data && /^u[a-f0-9]{24}$/.test(created.data.spaceId),
      "创建空间失败", created);
    sid = created.data.spaceId;
    assert(created.data.panoramaCloudPath === "unseen/v1/staging/" + sid + "/panorama.jpg",
      "全景上传路径不受空间约束", created);

    const panoramaFileID = await uploadFile(miniProgram, fixture, created.data.panoramaCloudPath);
    const finalized = await cloudCall(miniProgram, {
      action: "finalizeSpace",
      spaceId: sid,
      panoramaFileID
    });
    assert(finalized && finalized.ok && finalized.data && finalized.data.status === "published",
      "发布空间失败", finalized);
    assert(finalized.data.manifest && finalized.data.manifest.nodes[0].panorama,
      "发布结果没有可显示的全景临时地址", finalized);

    const clientUploadId = "upload-e2e-" + suffix;
    const prepared = await cloudCall(miniProgram, {
      action: "preparePhoto",
      spaceId: sid,
      clientUploadId,
      contributor: "E2E",
      caption: "native cloud"
    });
    assert(prepared && prepared.ok && prepared.data && prepared.data.cloudPath,
      "准备普通照片失败", prepared);
    const photoFileID = await uploadFile(miniProgram, fixture, prepared.data.cloudPath);
    const committed = await cloudCall(miniProgram, {
      action: "commitPhoto",
      spaceId: sid,
      clientUploadId,
      fileID: photoFileID
    });
    assert(committed && committed.ok && committed.data && committed.data.photo,
      "登记普通照片失败", committed);

    const committedAgain = await cloudCall(miniProgram, {
      action: "commitPhoto",
      spaceId: sid,
      clientUploadId,
      fileID: photoFileID
    });
    assert(committedAgain && committedAgain.ok && committedAgain.data.idempotent === true,
      "重复提交没有保持幂等", committedAgain);

    const fetched = await cloudCall(miniProgram, { action: "getSpace", spaceId: sid });
    const manifest = fetched && fetched.data && fetched.data.manifest;
    assert(fetched && fetched.ok && manifest && manifest.photos.length === 1,
      "读取空间没有返回一张已提交照片", fetched);
    assert(manifest.capacity.received === 1 && manifest.capacity.remaining === 89,
      "容量计数不正确", manifest && manifest.capacity);
    assert(manifest.upload.mode === "native-cloud-v1", "上传协议不是原生云", manifest && manifest.upload);

    const removed = await cloudCall(miniProgram, { action: "deleteOwnedSpace", spaceId: sid });
    assert(removed && removed.ok && removed.data.deleted === true, "E2E 清理失败", removed);
    sid = "";

    process.stdout.write(JSON.stringify({
      ok: true,
      envId,
      functionName,
      panorama: { width: 2048, height: 1024 },
      photoCount: 1,
      idempotentCommit: true,
      cleaned: true
    }, null, 2) + "\n");
  } finally {
    if (sid) {
      try { await cloudCall(miniProgram, { action: "deleteOwnedSpace", spaceId: sid }); } catch (_) {}
    }
    await miniProgram.close();
  }
}

main().catch(function (error) {
  console.error(error && error.stack || error);
  if (error && error.detail) console.error(JSON.stringify(error.detail, null, 2));
  process.exitCode = 1;
});
