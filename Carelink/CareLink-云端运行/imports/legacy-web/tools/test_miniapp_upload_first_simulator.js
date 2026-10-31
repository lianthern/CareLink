#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const automator = require("/opt/homebrew/lib/node_modules/miniprogram-automator");

const cliPath = process.env.WECHAT_DEVTOOLS_CLI ||
  "/Applications/wechatwebdevtools.app/Contents/MacOS/cli";
const projectPath = path.resolve(__dirname, "../miniapp");
const automationPort = Math.max(1024, Number(process.env.WECHAT_AUTOMATION_PORT) || 9446);
const runs = Math.max(1, Number(process.argv[2]) || 10);
const titlePrefix = "__UNSEEN_UPLOAD_FIRST_REGRESSION__";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function snapshot(miniProgram) {
  return miniProgram.evaluate(function () {
    var pages = getCurrentPages();
    var page = pages[pages.length - 1];
    return page ? {
      route: page.route,
      data: JSON.parse(JSON.stringify(page.data || {})),
      stack: pages.map(function (item) { return item.route; })
    } : { route: "", data: {}, stack: [] };
  });
}

async function waitFor(miniProgram, route, predicate, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 15000);
  let latest = null;
  while (Date.now() < deadline) {
    latest = await snapshot(miniProgram);
    if (latest.route === route && (!predicate || predicate(latest.data))) return latest;
    await delay(120);
  }
  const error = new Error(`等待 ${route} 超时`);
  error.latest = latest;
  throw error;
}

async function route(miniProgram, method, url) {
  const result = await miniProgram.evaluate(function (input) {
    return new Promise(function (resolve) {
      wx[input.method]({
        url: input.url,
        success: function () { resolve({ ok: true }); },
        fail: function (error) { resolve({ ok: false, error: error }); }
      });
    });
  }, { method, url });
  if (!result || !result.ok) throw new Error(`${method} ${url} 失败: ${JSON.stringify(result && result.error)}`);
}

function assert(condition, message, detail) {
  if (condition) return;
  const error = new Error(message);
  error.detail = detail;
  throw error;
}

async function cleanup(miniProgram) {
  return miniProgram.evaluate(function (prefix) {
    var key = "unseen_local_spaces_v2";
    var spaces = wx.getStorageSync(key) || [];
    var removedIds = spaces.filter(function (space) {
      return String(space && space.title || "").indexOf(prefix) === 0;
    }).map(function (space) { return space.id; });
    var kept = spaces.filter(function (space) {
      return String(space && space.title || "").indexOf(prefix) !== 0;
    });
    wx.setStorageSync(key, kept);
    var queueKey = "unseen_upload_queue_v2";
    var queue = wx.getStorageSync(queueKey) || [];
    if (Array.isArray(queue) && removedIds.length) {
      wx.setStorageSync(queueKey, queue.filter(function (item) {
        return removedIds.indexOf(item && item.sid) < 0;
      }));
    }
    return removedIds.length;
  }, titlePrefix);
}

async function prepareFixture(miniProgram, base64) {
  return miniProgram.evaluate(function (data) {
    return new Promise(function (resolve) {
      var filePath = wx.env.USER_DATA_PATH + "/unseen-upload-first-simulator.jpg";
      wx.getFileSystemManager().writeFile({
        filePath: filePath,
        data: data,
        encoding: "base64",
        success: function () { resolve({ ok: true, filePath: filePath }); },
        fail: function (error) { resolve({ ok: false, error: error }); }
      });
    });
  }, base64);
}

async function addLocalPanorama(miniProgram, sid, fixturePath) {
  return miniProgram.evaluate(function (input) {
    var key = "unseen_local_spaces_v2";
    var spaces = wx.getStorageSync(key) || [];
    var found = false;
    spaces.forEach(function (space) {
      if (space.id !== input.sid || !space.localOnly) return;
      space.panorama = {
        src: input.src,
        width: 2048,
        height: 1024,
        size: 199680,
        format: "jpeg"
      };
      space.updatedAt = new Date().toISOString();
      found = true;
    });
    if (found) wx.setStorageSync(key, spaces);
    return found;
  }, { sid, src: fixturePath });
}

async function main() {
  const miniProgram = await automator.launch({
    cliPath,
    projectPath,
    port: automationPort,
    timeout: 60000,
    trustProject: true
  });
  const exceptions = [];
  miniProgram.on("exception", (entry) => exceptions.push(entry));
  miniProgram.on("console", (entry) => {
    if (entry && /(?:error|failed|exception)/i.test(String(entry.message || ""))) exceptions.push(entry);
  });

  const results = [];
  const productionNetworkCalls = [];
  const mockedMethods = [];
  const createSource = fs.readFileSync(path.join(__dirname, "../miniapp/pages/create/create.js"), "utf8");
  const fixtureBytes = fs.readFileSync(path.join(__dirname, "../miniapp/assets/panos/expo.jpg"));
  const fixtureBase64 = fixtureBytes.toString("base64");
  let fixturePath = "";
  assert(/onSaveLocal\s*:\s*function/.test(createSource), "创建页缺少明确的本机保存 handler");
  try {
    const bindingName = `__unseenUploadFirstAudit_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await miniProgram.exposeFunction(bindingName, (kind, url) => {
      productionNetworkCalls.push({ kind: String(kind || ""), url: String(url || "") });
    });

    const requestMock = `function(options) {
      ${bindingName}("wx.request", String(options && options.url || ""));
      return { statusCode: 599, data: { ok: false, error: { code: "SIMULATOR_NETWORK_BLOCKED" } } };
    }`;
    const uploadMock = `function(options) {
      ${bindingName}("wx.uploadFile", String(options && options.url || ""));
      return { statusCode: 599, data: "SIMULATOR_NETWORK_BLOCKED" };
    }`;
    await miniProgram.mockWxMethod("request", requestMock);
    mockedMethods.push("request");
    await miniProgram.mockWxMethod("uploadFile", uploadMock);
    mockedMethods.push("uploadFile");
    const prepared = await prepareFixture(miniProgram, fixtureBase64);
    assert(prepared && prepared.ok && prepared.filePath, "无法准备本机相册测试图片", prepared);
    fixturePath = prepared.filePath;
    await miniProgram.mockWxMethod("chooseMedia", {
      tempFiles: [{
        tempFilePath: fixturePath,
        size: fixtureBytes.length,
        fileType: "image"
      }]
    });
    mockedMethods.push("chooseMedia");
    await miniProgram.mockWxMethod("showModal", { confirm: true, cancel: false });
    mockedMethods.push("showModal");

    await cleanup(miniProgram);
    for (let run = 1; run <= runs; run += 1) {
      const fixture = await prepareFixture(miniProgram, fixtureBase64);
      assert(fixture && fixture.ok && fixture.filePath === fixturePath, "本机测试图片重建失败", fixture);
      await route(miniProgram, "reLaunch", "/pages/index/index");
      const index = await waitFor(miniProgram, "pages/index/index", (data) => !data.opening);
      assert(Array.isArray(index.data.spaces), "首页 spaces 不是数组", index);

      await route(miniProgram, "navigateTo", "/pages/create/create");
      await waitFor(miniProgram, "pages/create/create", (data) => !data.submitting && !data.panoramaChecking);
      const title = `${titlePrefix}${run}`;
      await miniProgram.evaluate(function (value) {
        var pages = getCurrentPages();
        var page = pages[pages.length - 1];
        page.setData({ title: value });
        if (typeof page.onSaveLocal !== "function") throw new Error("本机保存 handler 不存在");
        page.onSaveLocal();
        return true;
      }, title);
      const localSpace = await waitFor(miniProgram, "pages/space/space", (data) => !data.loading && !!data.space);
      assert(localSpace.data.localOnly === true, "创建结果不是本机空间", localSpace);
      assert(localSpace.data.space.title === title, "创建空间标题不一致", localSpace);
      const localSid = localSpace.data.sid;

      await route(miniProgram, "navigateTo", `/pages/photos/photos?sid=${encodeURIComponent(localSid)}`);
      const localPhotos = await waitFor(miniProgram, "pages/photos/photos", (data) => !data.loading);
      assert(localPhotos.data.localOnly === true, "本机相册被错误标成云端", localPhotos);
      assert(localPhotos.data.busy === false && localPhotos.data.queue.length === 0, "本机相册初始队列不稳定", localPhotos);

      await miniProgram.evaluate(function () {
        var pages = getCurrentPages();
        var page = pages[pages.length - 1];
        page.onUpload();
        return true;
      });
      const uploaded = await waitFor(miniProgram, "pages/photos/photos", (data) =>
        !data.loading && !data.busy && data.doneCount === 1 && data.timeline.length === 1, 25000);
      assert(uploaded.data.localOnly === true, "普通照片上传后空间不再是本机", uploaded);
      assert(uploaded.data.queue.length === 1 && uploaded.data.queue[0].status === "done",
        "本机普通照片没有完成保存", uploaded);

      assert(await addLocalPanorama(miniProgram, localSid, fixturePath), "本机成品全景写入失败", { localSid });
      await route(miniProgram, "reLaunch", `/pages/space/space?sid=${encodeURIComponent(localSid)}`);
      const panoramaSpace = await waitFor(miniProgram, "pages/space/space", (data) => !data.loading, 15000);
      assert(panoramaSpace.data.localOnly === true, "全景空间被错误标成云端", panoramaSpace);
      assert(panoramaSpace.data.space && panoramaSpace.data.space.panorama,
        "本机成品全景没有出现在空间页", panoramaSpace);

      await route(miniProgram, "navigateTo", `/pages/pano/pano?sid=${encodeURIComponent(localSid)}`);
      const pano = await waitFor(miniProgram, "pages/pano/pano", (data) => !data.loading, 15000);
      assert(!pano.data.loadError && pano.data.panorama && pano.data.panorama.src,
        "本机 2D 全景页没有稳定结果", pano);

      await route(miniProgram, "reLaunch", "/pages/index/index");
      const beforeDelete = await waitFor(miniProgram, "pages/index/index", (data) =>
        Array.isArray(data.spaces) && data.spaces.some((space) => space.id === localSid), 15000);
      const deleteTitle = beforeDelete.data.spaces.filter((space) => space.id === localSid)[0].title;
      await miniProgram.evaluate(function (input) {
        var pages = getCurrentPages();
        var page = pages[pages.length - 1];
        page.onDeleteLocal({ currentTarget: { dataset: { sid: input.sid, title: input.title } } });
        return true;
      }, { sid: localSid, title: deleteTitle });
      const deleted = await waitFor(miniProgram, "pages/index/index", (data) =>
        !data.deletingSid && Array.isArray(data.spaces) && !data.spaces.some((space) => space.id === localSid), 15000);
      assert(deleted.data.spaces.every((space) => space.id !== localSid), "本机空间没有删除干净", deleted);
      assert(productionNetworkCalls.length === 0,
        "本机闭环触发了被禁止的生产网络调用", productionNetworkCalls);

      const allowed = new Set([
        "pages/index/index", "pages/create/create", "pages/space/space",
        "pages/photos/photos", "pages/pano/pano"
      ]);
      assert(deleted.stack.every((path) => allowed.has(path)), "正式栈出现拍摄/扫拍实验页", deleted.stack);
      const result = {
        run,
        status: "passed",
        localSid,
        localPhotos: uploaded.data.timeline.length,
        localPanorama: pano.data.panorama.src,
        deleted: true,
        productionNetworkCalls: productionNetworkCalls.length,
        routes: deleted.stack
      };
      results.push(result);
      process.stdout.write(JSON.stringify(result) + "\n");
    }
  } finally {
    const removed = await cleanup(miniProgram).catch(() => 0);
    for (const method of mockedMethods.reverse()) {
      await miniProgram.restoreWxMethod(method).catch(() => {});
    }
    await miniProgram.close();
    process.stdout.write(JSON.stringify({
      ok: results.length === runs && exceptions.length === 0 && productionNetworkCalls.length === 0,
      passed: results.length,
      requested: runs,
      exceptions: exceptions.length,
      productionNetworkCalls,
      localHandlerSourceProof: true,
      nativeCloudProof: "tools/test_native_cloud_e2e.js",
      cleanedTestSpaces: removed
    }, null, 2) + "\n");
  }
  if (exceptions.length) throw new Error(`模拟器捕获到 ${exceptions.length} 条异常`);
  if (productionNetworkCalls.length) {
    throw new Error(`模拟器捕获到 ${productionNetworkCalls.length} 次被禁止的生产网络调用`);
  }
}

main().catch((error) => {
  process.stderr.write(String(error && error.stack || error) + "\n");
  if (error && (error.latest || error.detail)) {
    process.stderr.write(JSON.stringify(error.latest || error.detail, null, 2) + "\n");
  }
  process.exitCode = 1;
});
