#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.dirname(__dirname);
const P = require(path.join(ROOT, "miniapp/utils/pano-core.js"));
const source = fs.readFileSync(
  path.join(ROOT, "miniapp/pages/capture/capture.js"),
  "utf8"
);
const captureWxml = fs.readFileSync(
  path.join(ROOT, "miniapp/pages/capture/capture.wxml"),
  "utf8"
);
const failures = [];
let captureDefinition = null;
const unlinkedPaths = [];

const wxMock = {
  stopDeviceMotionListening() {},
  offDeviceMotionChange() {},
  nextTick(callback) { callback(); },
  // Intentionally never settles; exportRgbaFrame's own watchdog must recover.
  canvasToTempFilePath() {},
  saveImageToPhotosAlbum() {},
  getFileSystemManager() {
    return {
      unlinkSync(filePath) {
        unlinkedPaths.push(filePath);
      }
    };
  }
};

vm.runInNewContext(source, {
  require: () => P,
  Page: (definition) => { captureDefinition = definition; },
  wx: wxMock,
  getApp: () => ({ globalData: { nav: {}, statusBarHeight: 20 } }),
  console,
  setTimeout,
  clearTimeout,
  Promise,
  Date,
  Math,
  Uint8Array,
  Uint8ClampedArray,
  Float32Array
});

function ok(condition, label) {
  console.log(`${condition ? "✅" : "❌"} ${label}`);
  if (!condition) failures.push(label);
}

function makePage(overrides = {}) {
  const page = Object.assign({}, captureDefinition, {
    data: Object.assign({}, captureDefinition.data, {
      phase: "capture",
      cameraReady: true,
      orientationReady: true,
      captureSessionStarted: true,
      busy: false
    }),
    pageAlive: true,
    pageVisible: true,
    lifecycleToken: 1,
    captureAttemptId: 0,
    autoCaptureSuspended: false,
    capturing: false,
    motionActive: true,
    targets: P.createTargets().slice(0, 2),
    targetIndex: 0,
    frames: [],
    basis: P.orthonormalBasis([0, 1, 0], [0, 0, 1]),
    coarse: P.createRaster(64, 32),
    stableSince: 0,
    updateTarget() {},
    drawWorldPreview() {},
    stopMotion() {
      this.motionActive = false;
    },
    setData(patch, callback) {
      Object.assign(this.data, patch);
      if (callback) callback();
    }
  }, overrides);
  return page;
}

function fakeViewerGl() {
  let id = 0;
  return {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    STATIC_DRAW: 6,
    FLOAT: 7,
    TEXTURE_2D: 8,
    TEXTURE_WRAP_S: 9,
    TEXTURE_WRAP_T: 10,
    CLAMP_TO_EDGE: 11,
    TEXTURE_MIN_FILTER: 12,
    TEXTURE_MAG_FILTER: 13,
    LINEAR: 14,
    RGB: 15,
    UNSIGNED_BYTE: 16,
    TRIANGLE_STRIP: 17,
    NO_ERROR: 0,
    createShader() { return { id: ++id }; },
    shaderSource() {},
    compileShader() {},
    getShaderParameter() { return true; },
    getShaderInfoLog() { return ""; },
    deleteShader() {},
    createProgram() { return { id: ++id }; },
    attachShader() {},
    linkProgram() {},
    getProgramParameter() { return true; },
    getProgramInfoLog() { return ""; },
    useProgram() {},
    deleteProgram() {},
    viewport() {},
    createBuffer() { return { id: ++id }; },
    bindBuffer() {},
    bufferData() {},
    getAttribLocation() { return 0; },
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    deleteBuffer() {},
    getUniformLocation() { return {}; },
    uniform1f() {},
    uniform2f() {},
    createTexture() { return { id: ++id }; },
    bindTexture() {},
    texParameteri() {},
    deleteTexture() {},
    isContextLost() { return false; },
    getError() { return 0; }
  };
}

async function run() {
  console.log("\n【0】相机授权生命周期必须可恢复");
  let permissionStops = 0;
  let permissionResumes = 0;
  const permissionPage = makePage({
    cameraStartInFlight: true,
    resumeCameraOnShow: false,
    autoResumeScheduled: false,
    visionKit: {
      stop() { permissionStops += 1; }
    },
    startVisionKit() {
      permissionResumes += 1;
    }
  });
  permissionPage.data.cameraOn = true;
  permissionPage.data.cameraReady = false;
  permissionPage.data.busy = true;
  permissionPage.onHide();
  ok(permissionStops === 1 &&
     permissionPage.resumeCameraOnShow === true &&
     permissionPage.data.guideTitle === "相机授权返回后继续" &&
     permissionPage.data.diagnosticText === "CAMERA_PERMISSION_ROUNDTRIP",
  "相机授权页短暂 hide 只释放旧会话并记录恢复意图");
  permissionPage.onShow();
  ok(permissionResumes === 1 &&
     permissionPage.resumeCameraOnShow === false &&
     permissionPage.data.guideTitle === "正在恢复后摄",
  "授权返回 onShow 只重建一次 VisionKit，不停在取消态");

  console.log("\n【1】底层 Promise 必须按时结算");
  const photoPage = makePage({
    cameraContext: { takePhoto() {} }
  });
  const photoStarted = Date.now();
  let photoError = null;
  try {
    await photoPage.takePhoto(20);
  } catch (error) {
    photoError = error;
  }
  ok(photoError && photoError.code === "TAKE_PHOTO_TIMEOUT" &&
     Date.now() - photoStarted < 250,
  "takePhoto 永不回调时 watchdog 拒绝，不会永久 pending");

  let lateCallback = null;
  const latePage = makePage({
    cameraContext: {
      takePhoto(options) {
        lateCallback = options.success;
        setTimeout(() => options.success({ tempImagePath: "late.jpg" }), 45);
      }
    }
  });
  let lateSettles = 0;
  try {
    await latePage.takePhoto(15);
  } catch (error) {
    lateSettles += error.code === "TAKE_PHOTO_TIMEOUT" ? 1 : 10;
  }
  await new Promise((resolve) => setTimeout(resolve, 60));
  ok(typeof lateCallback === "function" && lateSettles === 1,
    "快门超时后的迟到 success 被忽略，只结算一次");

  const hangingImage = {};
  Object.defineProperty(hangingImage, "src", {
    set() {}
  });
  const decodePage = makePage({
    worldCanvasNode: null,
    sourceCanvasNode: {
      createImage() { return hangingImage; },
      getContext() { return {}; }
    },
    sourceCtx: {}
  });
  let decodeError = null;
  try {
    await decodePage.loadImageData("wxfile://never.jpg", 640, 20);
  } catch (error) {
    decodeError = error;
  }
  ok(decodeError && decodeError.code === "IMAGE_DECODE_TIMEOUT",
    "Canvas Image 不触发 onload/onerror 时 watchdog 拒绝");

  const rgbaPixels = new Uint8ClampedArray(2 * 2 * 4).fill(128);
  const rgbaContext = {
    createImageData(width, height) {
      return { data: new Uint8ClampedArray(width * height * 4) };
    },
    putImageData() {}
  };
  const rgbaPage = makePage({
    sourceCanvasNode: {
      width: 2,
      height: 2,
      getContext() { return rgbaContext; }
    },
    sourceCtx: rgbaContext
  });
  const rgbaStarted = Date.now();
  let rgbaError = null;
  try {
    await rgbaPage.exportRgbaFrame(rgbaPixels, 2, 2, 20);
  } catch (error) {
    rgbaError = error;
  }
  ok(rgbaError && rgbaError.code === "RGBA_EXPORT_TIMEOUT" &&
     Date.now() - rgbaStarted < 250 && rgbaPage.activeRgbaExport === null,
  "RGBA Canvas 导出丢失回调时 watchdog 解锁且清理活动任务");

  const resultPage = makePage({
    resultCanvasNode: {},
    resultWidth: 8,
    resultHeight: 4,
    activeResultExport: null
  });
  const resultStarted = Date.now();
  let resultError = null;
  try {
    await resultPage.exportResultCanvas(20);
  } catch (error) {
    resultError = error;
  }
  ok(resultError && resultError.code === "RESULT_EXPORT_TIMEOUT" &&
     Date.now() - resultStarted < 250 && resultPage.activeResultExport === null,
  "最终 2D 导出丢失回调时 watchdog 解锁，不会卡在 100%");

  wxMock.canvasToTempFilePath = function (options) {
    setTimeout(() => options.success({ tempFilePath: "late-result.jpg" }), 80);
  };
  let lateResultError = null;
  try {
    await resultPage.exportResultCanvas(15);
  } catch (error) {
    lateResultError = error;
  }
  await new Promise((resolve) => setTimeout(resolve, 95));
  ok(lateResultError && lateResultError.code === "RESULT_EXPORT_TIMEOUT" &&
     unlinkedPaths.includes("late-result.jpg"),
  "最终 2D 导出超时后的迟到文件会删除，不会泄漏");

  wxMock.canvasToTempFilePath = function (options) {
    options.success({});
  };
  let noPathError = null;
  try {
    await resultPage.exportResultCanvas(20);
  } catch (error) {
    noPathError = error;
  }
  ok(noPathError && noPathError.code === "RESULT_EXPORT_NO_PATH",
    "最终 2D 导出缺少文件路径时拒绝空白假成功");

  const blackValidationPage = makePage({
    loadImageData() {
      return Promise.resolve({
        width: 8,
        height: 4,
        data: new Uint8ClampedArray(8 * 4 * 4)
      });
    }
  });
  let blackResultError = null;
  try {
    await blackValidationPage.validateExportedResult("black-result.jpg", 50);
  } catch (error) {
    blackResultError = error;
  }
  ok(blackResultError && blackResultError.code === "RESULT_EXPORT_BLACK" &&
     unlinkedPaths.includes("black-result.jpg"),
  "最终 JPG 会重新解码验黑，静默黑图会删除并触发轻量重试");

  const visiblePixels = new Uint8ClampedArray(8 * 4 * 4);
  visiblePixels.fill(120);
  const visibleValidationPage = makePage({
    loadImageData() {
      return Promise.resolve({ width: 8, height: 4, data: visiblePixels });
    }
  });
  const visibleValidation = await visibleValidationPage.validateExportedResult(
    "visible-result.jpg",
    50
  );
  ok(visibleValidation.nonBlackPixels === 32 &&
     visibleValidation.nonBlackRatio === 1,
  "最终 JPG 的真实非黑像素验证通过后才进入结果页");

  wxMock.createSelectorQuery = function () {
    const chain = {
      select() { return chain; },
      fields() { return chain; },
      boundingClientRect() { return chain; },
      exec() {}
    };
    return chain;
  };
  let selectorError = null;
  try {
    await resultPage.queryCanvasNode("#lostCanvas", 2, 20);
  } catch (error) {
    selectorError = error;
  }
  ok(selectorError && selectorError.code === "CANVAS_QUERY_TIMEOUT",
    "原生 Canvas selector 丢失回调时会重试后退出");

  const setDataLostPage = makePage({
    setData(patch) {
      Object.assign(this.data, patch);
    }
  });
  const setDataStarted = Date.now();
  await setDataLostPage.setDataAsync({ viewerCanvasMounted: true }, 20);
  ok(Date.now() - setDataStarted < 250 &&
     setDataLostPage.data.viewerCanvasMounted,
  "setData 丢失回调时异步流程仍会继续进入有界 Canvas 查询");

  const viewportPage = makePage({
    worldCssWidth: 400,
    worldCssHeight: 800,
    liveViewport: null
  });
  const fallbackViewport = await viewportPage.measureLiveViewport(20);
  ok(fallbackViewport && fallbackViewport.width === 288 &&
     fallbackViewport.height === 384 && fallbackViewport.centerX === 200,
  "取景窗测量丢失回调时使用确定性 fallback");

  const viewerGl = fakeViewerGl();
  const hangingViewerImage = {};
  Object.defineProperty(hangingViewerImage, "src", { set() {} });
  const viewerCanvas = {
    width: 320,
    height: 180,
    getContext() { return viewerGl; },
    createImage() { return hangingViewerImage; }
  };
  const viewerPage = makePage({
    resultTempPath: "result.jpg",
    viewerGeneration: 0,
    viewerState: null,
    viewerCanvasNode: null,
    ensureViewerCanvas() {
      this.viewerCanvasNode = viewerCanvas;
      return Promise.resolve(true);
    }
  });
  let viewerError = null;
  try {
    await viewerPage.startViewer(20);
  } catch (error) {
    viewerError = error;
  }
  ok(viewerError && viewerError.code === "VIEWER_IMAGE_TIMEOUT" &&
     viewerPage.viewerState === null,
  "360° 贴图丢失回调时自动清理并保留 2D 回退");
  ok(/result-canvas \{\{viewerActive \? 'canvas-hidden' : ''\}\}/.test(captureWxml) &&
     /viewer-canvas \{\{viewerActive \? '' : 'canvas-hidden'\}\}/.test(captureWxml),
  "360° 启动期间继续显示默认 2D，不用黑画布遮住结果");

  wxMock.saveImageToPhotosAlbum = function () {};
  const savePage = makePage({
    resultTempPath: "result.jpg",
    activeAlbumSave: null
  });
  let saveError = null;
  try {
    await savePage.saveResultOnce(50);
  } catch (error) {
    saveError = error;
  }
  ok(saveError && saveError.code === "SAVE_ALBUM_TIMEOUT" &&
     savePage.activeAlbumSave === null,
  "相册桥丢失回调时保存按钮会解锁");

  wxMock.showModal = function () {};
  wxMock.openSetting = function () {};
  const albumPermission = await savePage.recoverAlbumPermission(20);
  const cameraPermission = await savePage.recoverCameraPermission(20);
  ok(albumPermission === false && cameraPermission === false,
    "权限弹窗/设置桥丢失回调时不会永久占住保存或相机恢复流程");

  wxMock.canvasToTempFilePath = function () {};

  ok(/var COARSE_WIDTH = 512;/.test(source) &&
     /var WORLD_PREVIEW_MAX_WIDTH = 120;/.test(source) &&
     /var WORLD_PREVIEW_INTERVAL_MS = 125;/.test(source),
  "真机渐进照片层使用 512 粗球、最多 120px 且不高于 8Hz");
  ok(/this\.data\.busy \|\| this\.capturing \|\| !this\.frames\.length/.test(source) &&
     /this\.data\.busy \|\| this\.capturing\) return;/.test(source),
  "拍摄/处理期间暂停渐进预览，避免与相机和视觉配准争抢主线程");

  console.log("\n【2】页面状态机必须能恢复");
  const rejectedPage = makePage({
    takePhoto() {
      const error = new Error("相机拍摄响应超时");
      error.code = "TAKE_PHOTO_TIMEOUT";
      return Promise.reject(error);
    }
  });
  await rejectedPage.captureCurrent();
  ok(!rejectedPage.data.busy && !rejectedPage.capturing &&
     rejectedPage.frames.length === 0 && rejectedPage.targetIndex === 0,
  "拍摄超时后 busy/capturing 解锁，帧和目标不误增");
  ok(rejectedPage.autoCaptureSuspended && rejectedPage.data.captureNeedsRetry,
    "失败后暂停自动连拍，明确要求用户重试本张");

  const stopPage = makePage({
    takePhoto() {
      return new Promise((resolve) => {
        setTimeout(() => resolve("late-after-stop.jpg"), 45);
      });
    },
    loadImageData() {
      throw new Error("取消后不应进入解码");
    }
  });
  const pendingCapture = stopPage.captureCurrent();
  setTimeout(() => stopPage.onCameraStop(), 8);
  await pendingCapture;
  ok(!stopPage.data.busy && !stopPage.capturing &&
     !stopPage.data.cameraReady && stopPage.frames.length === 0,
  "相机中断会取消旧 attempt，迟到照片不能写入 frames");

  const pixels = new Uint8ClampedArray(6 * 8 * 4).fill(220);
  const successPage = makePage({
    takePhoto() { return Promise.resolve("ok.jpg"); },
    loadImageData() {
      return Promise.resolve({ data: pixels, width: 6, height: 8 });
    }
  });
  await successPage.captureCurrent();
  ok(!successPage.data.busy && !successPage.capturing &&
     successPage.frames.length === 1 && successPage.targetIndex === 1,
  "正常路径仍能拍摄、投影、推进到下一目标");

  console.log(failures.length
    ? `\n❌ 不通过 ${failures.length} 条：\n  - ${failures.join("\n  - ")}`
    : "\n✅ 真机卡死 watchdog 回归全部通过");
  process.exit(failures.length ? 1 : 0);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
