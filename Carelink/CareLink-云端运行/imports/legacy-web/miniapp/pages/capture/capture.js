/*
 * UNSEEN 微信小程序全景拍摄。
 *
 * 与 H5 共用 miniapp/utils/pano-core.js：+Y 前、+Z 上，以及每一张照片的
 * F/U/R 正交基都是同一份实现。拍摄期只保存压缩临时文件；投影时逐张解码，
 * 从不让 28 张 ImageBitmap/像素数组同时常驻。
 */
var P = require("../../utils/pano-core.js");
var Pose = require("../../utils/capture-pose.js");
var Quality = require("../../utils/capture-quality.js");
var VisionKit = require("../../utils/visionkit-capture.js");
var Registration = require("../../utils/mini-visual-registration.js");

var DEFAULT_CAPTURE_FOV_DEG = 65;
// This raster is only the live aiming guide. The final export is rebuilt from
// the saved photos at 1024/768 px, so keeping a 1024 px live raster wastes
// about 3.1 MiB and can add a ~100 ms low-end-device stall after every shot.
var COARSE_WIDTH = 512;
var TARGET_COUNT = 28;
var MIN_FINISH_FRAMES = 12;
var STABLE_ANGLE_DEG = 6;
var RAW_INSTANT_SPEED_DEG_S = 3;
var STABLE_WINDOW_SPEED_DEG_S = 6;
var STABLE_POSE_SPAN_DEG = 1;
var MIN_STABLE_WINDOW_MS = 400;
var MAX_ROLL_DEG = 25;
var DWELL_MS = 500;
var DISPLAY_POSE_TAU_MS = 90;
var TAKE_PHOTO_TIMEOUT_MS = 8000;
var IMAGE_INFO_TIMEOUT_MS = 1500;
var IMAGE_DECODE_TIMEOUT_MS = 3500;
var IMAGE_WRITE_TIMEOUT_MS = 3000;
var RGBA_EXPORT_TIMEOUT_MS = 5000;
var RESULT_EXPORT_TIMEOUT_MS = 5000;
var RESULT_VALIDATE_TIMEOUT_MS = 2500;
var VIEWER_IMAGE_TIMEOUT_MS = 3500;
var SAVE_ALBUM_TIMEOUT_MS = 10000;
var SELECTOR_QUERY_TIMEOUT_MS = 650;
var VIEWPORT_MEASURE_TIMEOUT_MS = 800;
var SET_DATA_CALLBACK_TIMEOUT_MS = 1000;
var PERMISSION_FLOW_TIMEOUT_MS = 30000;
var VK_CAPTURE_TIMEOUT_MS = 1800;
var VK_CAPTURE_WIDTH = 720;
var VK_CAPTURE_HEIGHT = 960;
var VK_RGBA_CAPTURE_WIDTH = 480;
var VK_RGBA_CAPTURE_HEIGHT = 640;
var SESSION_FOV_MIN_CONFIDENCE = 0.5;
var SESSION_FOV_MIN_SCORE = 0.78;
var SESSION_FOV_MIN_SAMPLES = 4;
var SESSION_FOV_MIN_DEG = DEFAULT_CAPTURE_FOV_DEG - 6;
var SESSION_FOV_MAX_DEG = DEFAULT_CAPTURE_FOV_DEG + 6;
// The progressive photo layer is only a spatial guide, not the final export.
// Keep its CPU raster deliberately tiny: the old ~242 x 524 buffer cost
// 58–66 ms per draw even on desktop and could starve VisionKit on a phone.
var WORLD_PREVIEW_MAX_WIDTH = 120;
var WORLD_PREVIEW_MIN_WIDTH = 88;
var WORLD_PREVIEW_INTERVAL_MS = 125;
var TEST_IMAGE_PATH = "/assets/panos/expo.jpg";

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function releaseRaster(raster, releasePixels) {
  if (!raster) return;
  raster.weights = null;
  raster.priorities = null;
  raster.owners = null;
  raster.lastSeamStats = null;
  raster.seamSummary = null;
  // Kept defensive for future seam planners that expose scratch buffers on
  // the raster while debugging. The current core releases its per-frame
  // labels immediately, so these are normally undefined.
  raster.seam = null;
  raster.seamLabels = null;
  raster.seamValid = null;
  raster.lonSin = null;
  raster.lonCos = null;
  raster.latSin = null;
  raster.latCos = null;
  if (releasePixels) raster.pixels = null;
}

function weightedMedian(samples) {
  if (!samples.length) return NaN;
  var ordered = samples.slice().sort(function (left, right) {
    return left.value - right.value;
  });
  var total = 0;
  var i;
  for (i = 0; i < ordered.length; i += 1) {
    total += Math.max(0, Number(ordered[i].weight) || 0);
  }
  if (total <= 0) return ordered[Math.floor(ordered.length / 2)].value;
  var cumulative = 0;
  for (i = 0; i < ordered.length; i += 1) {
    cumulative += Math.max(0, Number(ordered[i].weight) || 0);
    if (cumulative >= total / 2) return ordered[i].value;
  }
  return ordered[ordered.length - 1].value;
}

function robustFovEstimate(samples) {
  var median = weightedMedian(samples);
  var mad = NaN;
  var inliers = [];
  if (samples.length >= SESSION_FOV_MIN_SAMPLES && isFinite(median)) {
    var deviations = samples.map(function (sample) {
      return {
        value: Math.abs(sample.value - median),
        weight: sample.weight
      };
    });
    mad = weightedMedian(deviations);
    var inlierRadius = Math.max(0.75, (Number(mad) || 0) * 2.5);
    inliers = samples.filter(function (sample) {
      return Math.abs(sample.value - median) <= inlierRadius;
    });
  }
  return {
    median: median,
    mad: mad,
    inliers: inliers,
    selected: inliers.length >= SESSION_FOV_MIN_SAMPLES
      ? P.clamp(
        weightedMedian(inliers),
        SESSION_FOV_MIN_DEG,
        SESSION_FOV_MAX_DEG
      )
      : NaN
  };
}

function sourceConfidenceForFrame(frame) {
  var visual = frame && frame.visual;
  if (!visual) return 1;
  if (visual.accepted === false) return 0.2;
  var confidence = Number(visual.confidence);
  return isFinite(confidence) ? P.clamp(confidence, 0.2, 1) : 1;
}

Page({
  data: {
    navBarTop: 20,
    navBarHeight: 44,
    phase: "capture",
    cameraOn: false,
    cameraReady: false,
    orientationReady: false,
    cameraError: "",
    capturedCount: 0,
    targetCount: TARGET_COUNT,
    coverageText: "未拍区域保持黑色",
    targetX: 187,
    targetY: 280,
    targetHidden: true,
    targetOffscreen: false,
    targetAligned: false,
    dwellDeg: 0,
    captureSessionStarted: false,
    captureNeedsRetry: false,
    captureBackend: "checking",
    captureBackendLabel: "正在检测可靠相机",
    capabilityBlocked: false,
    capabilityMessage: "",
    diagnosticText: "等待同帧时间戳、姿态和相机内参",
    guideTitle: "把下一颗白点移进中央圆环",
    guideDetail: "停稳 0.5 秒会自动拍摄",
    canFinish: false,
    busy: false,
    flashOn: false,
    progress: 0,
    processText: "逐张解码与拼接，不会同时把所有照片塞进内存。",
    resultMeta: "默认显示稳定的 2D 结果",
    viewerActive: false,
    viewerStarting: false,
    viewerMessage: "",
    worldCanvasMounted: true,
    worldPreviewAvailable: true,
    sourceCanvasFallback: false,
    resultCanvasMounted: false,
    viewerCanvasMounted: false,
    resultImagePath: "",
    testStatus: "idle",
    testCoverage: 0,
    testViewerNonBlack: null,
    saving: false,
    helpVisible: false
  },

  onLoad: function (query) {
    var app = getApp();
    var nav = app.globalData.nav || {};
    this.setData({
      navBarTop: nav.barTop != null ? nav.barTop : (app.globalData.statusBarHeight || 20),
      navBarHeight: nav.barHeight != null ? nav.barHeight : 44
    });
    this.targets = P.createTargets();
    this.targetIndex = 0;
    this.frames = [];
    this.registrationFrames = [];
    this.visualEdges = [];
    this.registrationBytes = 0;
    this.registrationReleased = false;
    this.sessionFovXDeg = DEFAULT_CAPTURE_FOV_DEG;
    this.sessionFovSummary = null;
    this.coarse = P.createRaster(COARSE_WIDTH, COARSE_WIDTH / 2);
    this.trackingPose = P.orthonormalBasis([0, 1, 0], [0, 0, 1]);
    this.displayPose = P.copyBasis(this.trackingPose);
    this.capturePose = null;
    // Kept only for the hidden simulator and old result viewer code. Live
    // guidance explicitly reads displayPose; capture explicitly reads the
    // unsmoothed frame pose.
    this.basis = this.displayPose;
    this.headingOffsetDeg = null;
    this.resumeHeadingDeg = null;
    this.lastTrackingPose = null;
    this.lastTrackingAt = 0;
    this.rawAngularSpeed = Infinity;
    this.poseHistory = [];
    this.currentFovXDeg = DEFAULT_CAPTURE_FOV_DEG;
    this.latestFrameSnapshot = null;
    this.stableSince = 0;
    this.capturing = false;
    this.captureAttemptId = 0;
    this.activeRgbaExport = null;
    this.activeResultExport = null;
    this.activeAlbumSave = null;
    this.autoCaptureSuspended = false;
    this.motionHandler = null;
    this.motionStarting = false;
    this.motionActive = false;
    this.motionGeneration = 0;
    this.previewLastAt = 0;
    this.previewTimer = null;
    this.viewerState = null;
    this.viewerGeneration = 0;
    this.pageAlive = true;
    this.pageVisible = true;
    this.lifecycleToken = 1;
    this.saving = false;
    this.cameraStartTimer = null;
    // A native camera permission sheet can transiently hide the Mini Program
    // while VisionKit is still starting. Remember that narrow lifecycle case
    // so onShow can rebuild the cancelled session exactly once.
    this.cameraStartInFlight = false;
    this.resumeCameraOnShow = false;
    this.autoResumeScheduled = false;
    this.pageReady = false;
    this.worldRenderFailures = 0;
    this.resultRenderFailures = 0;
    this.testMode = !!(query && query.__pano_test === "1");
    this.testFrameCount = P.clamp(parseInt(query && query.frames || "28", 10) || 28, 1, 28);
    this.compatibilityMode = !!(query && query.__pano_compat === "1");
    this.visionKit = null;
    this.visionSessionVersion = "";
    this.visionFovWarningLogged = false;
    this.liveViewport = null;
    this.ownedFramePaths = [];
    this.visionSupport = VisionKit.detectSupport(wx);
    if (this.testMode) {
      this.captureBackend = "simulator";
      this.setData({
        captureBackend: "simulator",
        captureBackendLabel: "隐藏回归模拟器",
        capabilityBlocked: false
      });
    } else if (this.visionSupport.supported) {
      this.captureBackend = "visionkit";
      this.setData({
        captureBackend: "visionkit",
        captureBackendLabel: "VisionKit 同帧模式",
        capabilityBlocked: false
      });
    } else if (this.compatibilityMode) {
      // Explicit developer-only fallback. It never appears in the normal
      // product entry and retains the full shutter-window rejection gate.
      this.captureBackend = "basic";
      this.setData({
        captureBackend: "basic",
        captureBackendLabel: "兼容诊断模式 · 非推荐",
        capabilityBlocked: false,
        diagnosticText: "基础相机没有曝光时间戳，整段快门窗口不稳就拒收"
      });
    } else {
      this.captureBackend = "unsupported";
      this.setData({
        captureBackend: "unsupported",
        captureBackendLabel: "可靠全景不可用",
        capabilityBlocked: true,
        capabilityMessage: this.visionSupport.message +
          "。为避免生成错位全景，本机不会静默进入旧兼容模式。"
      });
    }
  },

  onReady: function () {
    var self = this;
    this.pageReady = true;
    this.initCanvases().then(function () {
      if (self.testMode) self.runSimulator();
    }).catch(function (error) {
      console.error("[capture] initial canvas setup failed", error);
      if (self.pageAlive) {
        self.blockReliableCapture(
          "当前微信无法创建照片处理画布。为避免拍完后卡住，请升级微信后重新进入。",
          (error && (error.code || error.message)) || "SOURCE_CANVAS_INIT_FAILED"
        );
      }
    });
  },

  onUnload: function () {
    this.pageAlive = false;
    this.pageVisible = false;
    this.resumeCameraOnShow = false;
    this.autoResumeScheduled = false;
    this.cameraStartInFlight = false;
    this.lifecycleToken += 1;
    this.cancelCaptureAttempt();
    this.cancelResultExport("页面已退出", "RESULT_EXPORT_CANCELLED");
    this.cancelAlbumSave();
    this.stopVisionKit();
    this.stopMotion();
    this.stopViewer();
    this.releaseRegistrationFrames();
    this.cleanupOwnedFramePaths();
    if (this.previewTimer) clearTimeout(this.previewTimer);
    if (this.cameraStartTimer) clearTimeout(this.cameraStartTimer);
  },

  onShow: function () {
    this.pageVisible = true;
    if (this.pageReady && this.data.phase === "capture" && !this.worldCanvasNode) {
      this.ensureWorldCanvas().catch(function (error) {
        console.warn("[capture] world canvas resume failed", error);
      });
    }
    if (!this.pageAlive || !this.resumeCameraOnShow ||
        this.autoResumeScheduled || this.data.phase !== "capture") return;
    this.resumeCameraOnShow = false;
    this.autoResumeScheduled = true;
    var self = this;
    var resume = function () {
      self.autoResumeScheduled = false;
      if (!self.pageAlive || !self.pageVisible || self.visionKit ||
          self.data.phase !== "capture") return;
      self.setData({
        cameraOn: true,
        cameraReady: false,
        guideTitle: "正在恢复后摄",
        guideDetail: "相机授权已返回，正在重建同帧会话"
      }, function () {
        self.startVisionKit();
      });
    };
    if (wx.nextTick) wx.nextTick(resume);
    else setTimeout(resume, 0);
  },

  onHide: function () {
    this.pageVisible = false;
    // The native camera permission sheet temporarily hides the page. The old
    // unconditional cleanup converted that permission roundtrip into a
    // permanent cancelled state because onShow never restarted VisionKit.
    var startingCamera = this.data.phase === "capture" &&
      (this.cameraStartInFlight ||
       (this.data.cameraOn && !this.data.cameraReady));
    if (startingCamera) {
      this.resumeCameraOnShow = true;
      this.lifecycleToken += 1;
      this.cameraStartInFlight = false;
      this.cancelCaptureAttempt();
      this.stableSince = 0;
      this.capturing = false;
      this.stopVisionKit();
      if (this.cameraStartTimer) {
        clearTimeout(this.cameraStartTimer);
        this.cameraStartTimer = null;
      }
      if (this.pageAlive) {
        this.setData({
          cameraOn: false,
          cameraReady: false,
          orientationReady: false,
          busy: false,
          dwellDeg: 0,
          guideTitle: "相机授权返回后继续",
          guideDetail: "回到小程序会自动恢复，不会取消本次全景",
          diagnosticText: "CAMERA_PERMISSION_ROUNDTRIP"
        });
      }
      return;
    }
    this.lifecycleToken += 1;
    this.cancelCaptureAttempt();
    this.cancelResultExport("页面进入后台", "RESULT_EXPORT_CANCELLED");
    this.cancelAlbumSave();
    this.stableSince = 0;
    this.capturing = false;
    this.stopVisionKit();
    this.stopMotion();
    this.stopViewer();
    if (this.cameraStartTimer) {
      clearTimeout(this.cameraStartTimer);
      this.cameraStartTimer = null;
    }
    if (this.pageAlive) {
      var hiddenState = {
        cameraOn: false,
        cameraReady: false,
        orientationReady: false,
        viewerActive: false,
        viewerStarting: false,
        saving: false,
        busy: false,
        dwellDeg: 0
      };
      if (this.data.phase === "processing") {
        hiddenState.phase = "capture";
        hiddenState.worldCanvasMounted = true;
        hiddenState.resultCanvasMounted = false;
        hiddenState.guideTitle = "照片都已保留";
        hiddenState.guideDetail = "返回页面后可再次点“完成”生成";
        this.resultCanvasNode = null;
        this.resultCtx = null;
      }
      this.setData(hiddenState);
    }
  },

  setDataAsync: function (patch, timeoutMs) {
    var self = this;
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(
        finish,
        Math.max(20, Number(timeoutMs) || SET_DATA_CALLBACK_TIMEOUT_MS)
      );
      function finish() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      }
      try {
        self.setData(patch, finish);
      } catch (error) {
        finish();
      }
    });
  },

  queryCanvasNode: function (selector, attempts, timeoutMs) {
    var remaining = attempts || 4;
    var perAttemptTimeout = Math.max(
      20,
      Number(timeoutMs) || SELECTOR_QUERY_TIMEOUT_MS
    );
    return new Promise(function (resolve, reject) {
      var settled = false;
      function finish(callback, value) {
        if (settled) return;
        settled = true;
        callback(value);
      }
      function query() {
        if (settled) return;
        var run = function () {
          var callbackHandled = false;
          var timer = setTimeout(function () {
            completeAttempt(null);
          }, perAttemptTimeout);
          function completeAttempt(items) {
            if (callbackHandled || settled) return;
            callbackHandled = true;
            clearTimeout(timer);
            var item = items && items[0];
            if (item && item.node) {
              finish(resolve, item);
              return;
            }
            remaining -= 1;
            if (remaining <= 0) {
              var error = new Error(selector + " 节点没有准备好");
              error.code = "CANVAS_QUERY_TIMEOUT";
              finish(reject, error);
              return;
            }
            setTimeout(query, 40);
          }
          try {
            wx.createSelectorQuery()
              .select(selector)
              .fields({ node: true, size: true })
              .exec(completeAttempt);
          } catch (error) {
            completeAttempt(null);
          }
        };
        if (wx.nextTick) wx.nextTick(run);
        else setTimeout(run, 0);
      }
      query();
    });
  },

  measureLiveViewport: function (timeoutMs) {
    var self = this;
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        finish(null);
      }, Math.max(20, Number(timeoutMs) || VIEWPORT_MEASURE_TIMEOUT_MS));
      function finish(items) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        var item = items && items[0];
        if (item && item.width > 1 && item.height > 1) {
          self.liveViewport = {
            left: item.left,
            top: item.top,
            width: item.width,
            height: item.height,
            centerX: item.left + item.width / 2,
            centerY: item.top + item.height / 2
          };
        } else {
          var width = self.worldCssWidth || 375;
          var height = self.worldCssHeight || 667;
          var fallbackWidth = width * 0.72;
          var fallbackHeight = fallbackWidth * 4 / 3;
          self.liveViewport = {
            left: (width - fallbackWidth) / 2,
            top: (height - fallbackHeight) / 2,
            width: fallbackWidth,
            height: fallbackHeight,
            centerX: width / 2,
            centerY: height / 2
          };
        }
        resolve(self.liveViewport);
      }
      try {
        wx.createSelectorQuery()
          .select(".live-window")
          .boundingClientRect()
          .exec(finish);
      } catch (error) {
        finish(null);
      }
    });
  },

  initSourceCanvas: async function () {
    try {
      if (!wx.createOffscreenCanvas) throw new Error("OffscreenCanvas API 不可用");
      var source = wx.createOffscreenCanvas({ type: "2d", width: 640, height: 480 });
      var context = source && source.getContext && source.getContext("2d");
      if (!source || !source.createImage || !context) throw new Error("OffscreenCanvas 2D 不完整");
      this.sourceCanvasNode = source;
      this.sourceCtx = context;
      return;
    } catch (error) {
      console.warn("[capture] offscreen source fallback", error);
    }
    await this.setDataAsync({ sourceCanvasFallback: true });
    var item = await this.queryCanvasNode("#sourceCanvas", 4);
    this.sourceCanvasNode = item.node;
    this.sourceCanvasNode.width = 640;
    this.sourceCanvasNode.height = 480;
    this.sourceCtx = this.sourceCanvasNode.getContext("2d");
    if (!this.sourceCtx || !this.sourceCanvasNode.createImage) {
      throw new Error("图片解码画布不可用");
    }
  },

  ensureWorldCanvas: async function () {
    if (!this.pageAlive || this.data.phase !== "capture") return false;
    if (this.worldCanvasNode && this.worldCtx) return true;
    if (!this.data.worldCanvasMounted) {
      await this.setDataAsync({ worldCanvasMounted: true });
    }
    var item = await this.queryCanvasNode("#worldCanvas", 4);
    this.worldCanvasNode = item.node;
    this.worldCssWidth = Math.max(1, item.width || 375);
    this.worldCssHeight = Math.max(1, item.height || 667);
    // CSS scales this guide to the screen. The final 2D result keeps its full
    // resolution; this buffer exists only while aiming the next shot.
    var previewW = Math.min(
      WORLD_PREVIEW_MAX_WIDTH,
      Math.max(WORLD_PREVIEW_MIN_WIDTH, Math.round(this.worldCssWidth * 0.3))
    );
    var previewH = Math.max(
      WORLD_PREVIEW_MIN_WIDTH,
      Math.round(previewW * this.worldCssHeight / this.worldCssWidth)
    );
    this.worldCanvasNode.width = previewW;
    this.worldCanvasNode.height = previewH;
    this.worldCtx = this.worldCanvasNode.getContext("2d");
    if (!this.worldCtx) throw new Error("渐进预览 2D 上下文不可用");
    await this.measureLiveViewport();
    this.setData({ worldPreviewAvailable: true });
    this.drawWorldPreview();
    this.updateTarget();
    return true;
  },

  ensureResultCanvas: async function () {
    if (this.resultCanvasNode && this.resultCtx) return true;
    if (!this.data.resultCanvasMounted) {
      await this.setDataAsync({ resultCanvasMounted: true });
    }
    var item = await this.queryCanvasNode("#resultCanvas", 4);
    this.resultCanvasNode = item.node;
    this.resultCanvasNode.width = 2;
    this.resultCanvasNode.height = 2;
    this.resultCtx = this.resultCanvasNode.getContext("2d");
    if (!this.resultCtx) throw new Error("结果 2D 上下文不可用");
    return true;
  },

  ensureViewerCanvas: async function () {
    if (this.viewerCanvasNode) return true;
    if (!this.data.viewerCanvasMounted) {
      await this.setDataAsync({ viewerCanvasMounted: true });
    }
    var item = await this.queryCanvasNode("#viewerCanvas", 4);
    this.viewerCanvasNode = item.node;
    this.viewerCanvasNode.width = Math.max(2, Math.round(item.width || this.worldCssWidth || 375));
    this.viewerCanvasNode.height = Math.max(2, Math.round(item.height || (this.worldCssWidth || 375) / 2));
    return true;
  },

  initCanvases: async function () {
    try {
      await this.initSourceCanvas();
    } catch (error) {
      error.code = error.code || "SOURCE_CANVAS_INIT_FAILED";
      throw error;
    }
    try {
      await this.ensureWorldCanvas();
    } catch (worldError) {
      console.warn("[capture] progressive preview unavailable", worldError);
      if (this.pageAlive) {
        this.setData({
          worldCanvasMounted: false,
          worldPreviewAvailable: false,
          guideTitle: "实时照片层已降级",
          guideDetail: "相机与最终 2D 拼接仍可使用"
        });
      }
    }
    await this.measureLiveViewport();
  },

  stopVisionKit: function () {
    if (this.trackingPose && this.headingOffsetDeg !== null) {
      this.resumeHeadingDeg = P.headingDeg(this.trackingPose);
    }
    if (this.visionKit) {
      try { this.visionKit.stop(); } catch (error) {
        console.warn("[capture] VisionKit stop failed", error);
      }
      this.visionKit = null;
    }
    this.latestFrameSnapshot = null;
    this.visionSessionVersion = "";
  },

  cleanupOwnedFramePaths: function () {
    var paths = this.ownedFramePaths || [];
    this.ownedFramePaths = [];
    if (!paths.length || !wx.getFileSystemManager) return;
    var fs = wx.getFileSystemManager();
    paths.forEach(function (path) {
      try { fs.unlinkSync(path); } catch (ignored) {}
    });
  },

  releaseRegistrationFrames: function () {
    var frames = this.registrationFrames || [];
    var released = 0;
    if (typeof Registration.releasePixels === "function") {
      released = Registration.releasePixels(frames);
    } else {
      frames.forEach(function (frame) {
        if (!frame || !frame.pixels) return;
        released += frame.pixels.byteLength || 0;
        frame.pixels = null;
      });
    }
    this.registrationBytes = 0;
    this.registrationReleased = frames.length > 0;
    return released;
  },

  createRegistrationFrame: function (decoded, frame, index) {
    var thumbnail = Registration.createThumbnail(
      decoded,
      Registration.DEFAULT_MAX_SIDE || 216
    );
    if (this.registrationBytes + thumbnail.byteLength >
        (Registration.MAX_TOTAL_BYTES || 5 * 1024 * 1024)) {
      var memoryError = new Error("视觉参考缩略图超过 5MB 内存上限");
      memoryError.code = "REGISTRATION_MEMORY_LIMIT";
      throw memoryError;
    }
    return {
      index: index,
      pixels: thumbnail.pixels,
      width: thumbnail.width,
      height: thumbnail.height,
      basis: P.copyBasis(frame.basis),
      correctedBasis: (frame.optimizedBasis || frame.correctedBasis)
        ? P.copyBasis(frame.optimizedBasis || frame.correctedBasis)
        : P.copyBasis(frame.basis),
      fovXDeg: frame.fovXDeg || DEFAULT_CAPTURE_FOV_DEG,
      correctedFovXDeg: frame.correctedFovXDeg ||
        frame.fovXDeg || DEFAULT_CAPTURE_FOV_DEG,
      gain: frame.gain == null ? 1 : frame.gain,
      bias: frame.bias == null ? 0 : frame.bias,
      targetIndex: frame.targetIndex
    };
  },

  restoreRegistrationFrames: async function (operationToken) {
    if (this.testMode || !this.frames.length) return;
    var available = (this.registrationFrames || []).length === this.frames.length &&
      this.registrationFrames.every(function (frame) {
        return frame && frame.pixels && frame.pixels.length;
      });
    if (available) return;
    this.releaseRegistrationFrames();
    this.registrationFrames = [];
    this.registrationBytes = 0;
    this.setData({
      guideTitle: "正在恢复视觉参考",
      guideDetail: "只解码低清缩略图，不会把原图同时放进内存"
    });
    for (var i = 0; i < this.frames.length; i += 1) {
      if (!this.pageAlive || !this.pageVisible || operationToken !== this.lifecycleToken) {
        throw new Error("页面进入后台，已取消视觉参考恢复");
      }
      var decoded = await this.loadImageData(
        this.frames[i].path,
        Registration.DEFAULT_MAX_SIDE || 216
      );
      var registration = this.createRegistrationFrame(decoded, this.frames[i], i);
      this.registrationFrames.push(registration);
      this.registrationBytes += registration.pixels.byteLength;
      decoded = null;
      await delay(0);
    }
    this.registrationReleased = false;
  },

  visualRegistrationOptions: function () {
    return {
      // Two nearest geometric neighbours keep the low-end interpreter path
      // around one animation beat. A third synchronous search pushed one
      // accepted shot past 200 ms before decode/export was even counted.
      maxReferences: 2,
      maxReferenceAngleDeg: 78,
      maxCorrectionDeg: 6,
      maxRollDeg: 4,
      maxFovCorrectionDeg: 6,
      levels: 2,
      minOverlapRatio: 0.08,
      minScore: 0.72,
      imuPriorWeight: 0.04,
      targetSamples: 420
    };
  },

  refineFramePoseMobile: async function (referenceFrames, currentFrame, options) {
    referenceFrames = referenceFrames || [];
    options = options || {};
    if (typeof P.refineFramePoseFromReferences !== "function") {
      throw new Error("视觉配准内核不可用");
    }
    if (typeof P.refineFramePose !== "function") {
      return P.refineFramePoseFromReferences(referenceFrames, currentFrame, options);
    }
    var currentBasis = currentFrame && currentFrame.basis;
    if (!currentBasis || !currentBasis.F) {
      return P.refineFramePose(referenceFrames[0] || {}, currentFrame, options);
    }
    var maxReferenceAngle = options.maxReferenceAngleDeg == null
      ? 78
      : Number(options.maxReferenceAngleDeg);
    var maxReferences = Math.max(1, Number(options.maxReferences) || 2);
    var candidates = [];
    for (var index = 0; index < referenceFrames.length; index += 1) {
      var referenceBasis = referenceFrames[index].correctedBasis ||
        referenceFrames[index].basis;
      if (!referenceBasis || !referenceBasis.F) continue;
      var separation = P.angleDeg(referenceBasis.F, currentBasis.F);
      if (separation <= maxReferenceAngle) {
        candidates.push({
          frame: referenceFrames[index],
          index: index,
          angle: separation
        });
      }
    }
    candidates.sort(function (left, right) { return left.angle - right.angle; });
    candidates = candidates.slice(0, maxReferences);
    if (!candidates.length) {
      return P.refineFramePoseFromReferences([], currentFrame, options);
    }

    var tried = [];
    var best = null;
    var bestSelectionScore = -Infinity;
    for (var candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      if (candidateIndex > 0) await delay(0);
      var candidate = candidates[candidateIndex];
      var result = P.refineFramePose(candidate.frame, currentFrame, options);
      var correction = result.correction || {
        yawDeg: 0,
        pitchDeg: 0,
        rollDeg: 0
      };
      var correctionMagnitude = Math.sqrt(
        correction.yawDeg * correction.yawDeg +
        correction.pitchDeg * correction.pitchDeg +
        correction.rollDeg * correction.rollDeg
      );
      var priorPenalty = (Number(options.imuPriorWeight) || 0.035) *
        correctionMagnitude / Math.max(1, Number(options.maxCorrectionDeg) || 6);
      var selectionScore = result.score + result.confidence * 0.04 - priorPenalty;
      result.referenceIndex = candidate.index;
      result.referenceAngleDeg = candidate.angle;
      result.selectionScore = selectionScore;
      tried.push(result);
      if (!best ||
          (result.accepted && !best.accepted) ||
          (result.accepted === best.accepted && selectionScore > bestSelectionScore)) {
        best = result;
        bestSelectionScore = selectionScore;
      }
      // A confident nearest neighbour is enough for this guided grid. Only a
      // rejection/weak match pays for the second reference, after yielding so
      // the camera preview can present a frame between searches.
      if (result.accepted && result.confidence >= 0.28) break;
    }
    best.triedReferences = tried.length;
    best.referenceCandidates = tried.map(function (result) {
      return {
        referenceIndex: result.referenceIndex,
        referenceAngleDeg: result.referenceAngleDeg,
        accepted: result.accepted,
        score: result.score,
        confidence: result.confidence,
        rejectReason: result.rejectReason
      };
    });
    best.method = "local-progressive-mobile-photometric-zncc";
    return best;
  },

  refineCapturedFrame: async function (decoded, rawFrame, operationToken) {
    if (this.testMode || typeof P.refineFramePoseFromReferences !== "function" ||
        typeof Registration.createThumbnail !== "function") {
      return {
        registration: null,
        result: {
          accepted: true,
          correctedBasis: P.copyBasis(rawFrame.basis),
          correctedFovXDeg: rawFrame.fovXDeg,
          gain: 1,
          bias: 0,
          confidence: 1,
          correction: { yawDeg: 0, pitchDeg: 0, rollDeg: 0, fovDeg: 0 },
          method: this.testMode ? "simulator-skip" : "compatibility-skip"
        }
      };
    }
    await this.restoreRegistrationFrames(operationToken);
    var registration = this.createRegistrationFrame(
      decoded,
      rawFrame,
      this.frames.length
    );
    if (!this.registrationFrames.length) {
      registration.correctedBasis = P.copyBasis(rawFrame.basis);
      registration.correctedFovXDeg = rawFrame.fovXDeg;
      return {
        registration: registration,
        result: {
          accepted: true,
          correctedBasis: P.copyBasis(rawFrame.basis),
          correctedFovXDeg: rawFrame.fovXDeg,
          gain: 1,
          bias: 0,
          confidence: 1,
          correction: { yawDeg: 0, pitchDeg: 0, rollDeg: 0, fovDeg: 0 },
          referenceIndex: null,
          rejectReason: "",
          method: "visual-anchor"
        }
      };
    }
    var result = await this.refineFramePoseMobile(
      this.registrationFrames,
      registration,
      this.visualRegistrationOptions()
    );
    if (!result.accepted) {
      registration.pixels = null;
      var rejected = new Error(Registration.rejectMessage(result.rejectReason));
      rejected.code = "VISUAL_REGISTRATION_REJECTED";
      rejected.visualResult = result;
      throw rejected;
    }
    // scoreAlignment returns a local transform from the current raw frame into
    // the selected reference frame. Compose that with the reference's already
    // accumulated transform so exposure remains in one global panorama space.
    var reference = this.registrationFrames[result.referenceIndex];
    var referenceGain = reference && isFinite(Number(reference.gain))
      ? Number(reference.gain)
      : 1;
    var referenceBias = reference && isFinite(Number(reference.bias))
      ? Number(reference.bias)
      : 0;
    result.localGain = result.gain;
    result.localBias = result.bias;
    result.gain = P.clamp((Number(result.gain) || 1) * referenceGain, 0.45, 2.2);
    result.bias = P.clamp(
      (Number(result.localBias) || 0) * referenceGain + referenceBias,
      -96,
      96
    );
    registration.correctedBasis = P.copyBasis(result.correctedBasis);
    registration.correctedFovXDeg = result.correctedFovXDeg;
    registration.gain = result.gain;
    registration.bias = result.bias;
    registration.visualConfidence = result.confidence;
    return { registration: registration, result: result };
  },

  commitVisualRegistration: function (registration, result, frameIndex) {
    if (!registration || this.testMode) return;
    this.registrationFrames.push(registration);
    this.registrationBytes += registration.pixels.byteLength;
    this.registrationReleased = false;
    if (result && result.referenceIndex != null) {
      this.visualEdges.push({
        from: result.referenceIndex,
        to: frameIndex,
        accepted: result.accepted,
        confidence: result.confidence,
        result: result
      });
    }
    var ringStarts = { 11: 0, 19: 12, 27: 20 };
    var firstIndex = ringStarts[frameIndex];
    if (firstIndex == null || typeof P.refineFramePose !== "function") return;
    var first = this.registrationFrames[firstIndex];
    var last = this.registrationFrames[frameIndex];
    if (!first || !last || !first.pixels || !last.pixels) return;
    try {
      var closure = P.refineFramePose(last, first, this.visualRegistrationOptions());
      this.visualEdges.push({
        from: frameIndex,
        to: firstIndex,
        isClosure: true,
        accepted: closure.accepted,
        confidence: closure.confidence,
        predictedStartBasis: closure.correctedBasis,
        result: closure
      });
    } catch (error) {
      // The frame itself was already reliably registered against a neighbour.
      // A closure edge is an optional global correction and cannot roll back
      // an otherwise valid capture.
      console.warn("[capture] visual loop edge skipped", error);
    }
  },

  finalizeSessionFov: function () {
    var visualCandidates = [];
    var measuredCandidates = [];
    var frames = this.frames || [];
    var i;
    for (i = 0; i < frames.length; i += 1) {
      var measuredFov = Number(frames[i].fovXDeg);
      if (isFinite(measuredFov) &&
          measuredFov >= SESSION_FOV_MIN_DEG &&
          measuredFov <= SESSION_FOV_MAX_DEG) {
        measuredCandidates.push({ value: measuredFov, weight: 1 });
      }

      var visual = frames[i].visual;
      var correctedFov = Number(frames[i].correctedFovXDeg);
      var confidence = Number(visual && visual.confidence) || 0;
      var score = Number(visual && visual.score);
      if (!visual || visual.accepted === false ||
          confidence < SESSION_FOV_MIN_CONFIDENCE ||
          !isFinite(score) || score < SESSION_FOV_MIN_SCORE ||
          !isFinite(correctedFov) ||
          correctedFov < SESSION_FOV_MIN_DEG ||
          correctedFov > SESSION_FOV_MAX_DEG) {
        continue;
      }
      visualCandidates.push({
        value: correctedFov,
        weight: confidence * Math.max(0.1, score)
      });
    }

    var visualEstimate = robustFovEstimate(visualCandidates);
    var measuredEstimate = robustFovEstimate(measuredCandidates);
    var selected = DEFAULT_CAPTURE_FOV_DEG;
    var selectedEstimate = null;
    var method = "fixed-default";
    if (isFinite(visualEstimate.selected)) {
      selected = visualEstimate.selected;
      selectedEstimate = visualEstimate;
      method = "visual-confidence-weighted-median";
    } else if (isFinite(measuredEstimate.selected)) {
      // VisionKit projection/intrinsics FOV is a stronger fallback than
      // retaining independent values per frame. A single robust lens value
      // avoids frame-by-frame scale breathing in the final panorama.
      selected = measuredEstimate.selected;
      selectedEstimate = measuredEstimate;
      method = "measured-median";
    }
    selected = Math.round(selected * 10) / 10;
    this.sessionFovXDeg = selected;
    this.sessionFovSummary = {
      method: method,
      fovXDeg: selected,
      visualCandidateCount: visualCandidates.length,
      measuredCandidateCount: measuredCandidates.length,
      inlierCount: selectedEstimate ? selectedEstimate.inliers.length : 0,
      medianFovXDeg: selectedEstimate && isFinite(selectedEstimate.median)
        ? Math.round(selectedEstimate.median * 100) / 100
        : null,
      madFovDeg: selectedEstimate && isFinite(selectedEstimate.mad)
        ? Math.round(selectedEstimate.mad * 100) / 100
        : null
    };
    for (i = 0; i < frames.length; i += 1) {
      frames[i].correctedFovXDeg = selected;
    }
    for (i = 0; i < (this.registrationFrames || []).length; i += 1) {
      this.registrationFrames[i].fovXDeg = selected;
      this.registrationFrames[i].correctedFovXDeg = selected;
    }
    return this.sessionFovSummary;
  },

  optimizeCapturedSequence: function () {
    if (this.testMode || !this.frames.length ||
        typeof P.optimizeFrameSequence !== "function") return null;
    var rings = typeof Registration.completeRings === "function"
      ? Registration.completeRings(this.frames.length)
      : [];
    var optimized = P.optimizeFrameSequence(
      this.frames,
      this.visualEdges || [],
      {
        rings: rings,
        minEdgeConfidence: 0.45,
        imuPriorWeight: 0.12,
        loopStrength: 0.9
      }
    );
    for (var i = 0; i < optimized.bases.length; i += 1) {
      this.frames[i].optimizedBasis = P.copyBasis(optimized.bases[i]);
      if (this.registrationFrames[i]) {
        this.registrationFrames[i].optimizedBasis = P.copyBasis(optimized.bases[i]);
      }
    }
    this.lastOptimizationReport = optimized;
    return optimized;
  },

  blockReliableCapture: function (message, code) {
    this.cameraStartInFlight = false;
    this.resumeCameraOnShow = false;
    this.stopVisionKit();
    this.cancelCaptureAttempt();
    this.stableSince = 0;
    this.captureBackend = "unsupported";
    if (this.pageAlive) {
      this.setData({
        cameraOn: false,
        cameraReady: false,
        orientationReady: false,
        busy: false,
        captureSessionStarted: false,
        captureBackend: "unsupported",
        captureBackendLabel: "可靠全景不可用",
        capabilityBlocked: true,
        capabilityMessage: message || "当前设备不能提供同帧相机姿态与照片",
        diagnosticText: code ? "能力诊断：" + code : ""
      });
    }
  },

  failVisionKitRecoverably: function (message, code) {
    this.cameraStartInFlight = false;
    this.resumeCameraOnShow = false;
    this.stopVisionKit();
    this.cancelCaptureAttempt();
    this.stableSince = 0;
    this.captureBackend = "visionkit";
    if (this.cameraStartTimer) {
      clearTimeout(this.cameraStartTimer);
      this.cameraStartTimer = null;
    }
    if (this.pageAlive) {
      this.setData({
        cameraOn: false,
        cameraReady: false,
        orientationReady: false,
        busy: false,
        targetHidden: true,
        captureSessionStarted: false,
        captureBackend: "visionkit",
        captureBackendLabel: "VisionKit 同帧模式 · 可重试",
        capabilityBlocked: false,
        guideTitle: "相机会话已安全停止",
        guideDetail: message || "请点“开启相机”重新建立同帧会话",
        diagnosticText: code ? "会话诊断：" + code : ""
      });
    }
  },

  onCapabilityBack: function () {
    this.onBack();
  },

  recoverCameraPermission: function (timeoutMs) {
    var self = this;
    if (!wx.showModal || !wx.openSetting) return Promise.resolve(false);
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        finish(false);
      }, Math.max(20, Number(timeoutMs) || PERMISSION_FLOW_TIMEOUT_MS));
      function finish(value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(!!value);
      }
      try {
        wx.showModal({
          title: "需要相机权限",
          content: "请在微信设置中允许使用相机。回来后再点一次“开启相机”。",
          confirmText: "去设置",
          success: function (modal) {
            if (!modal.confirm) {
              finish(false);
              return;
            }
            try {
              wx.openSetting({
                success: function (setting) {
                  var allowed = !!(
                    setting &&
                    setting.authSetting &&
                    setting.authSetting["scope.camera"]
                  );
                  if (self.pageAlive) {
                    self.setData({
                      guideTitle: allowed ? "相机权限已开启" : "仍未获得相机权限",
                      guideDetail: allowed
                        ? "点“开启相机”重新建立同帧会话"
                        : "可再次开启相机并进入设置"
                    });
                  }
                  finish(allowed);
                },
                fail: function () { finish(false); }
              });
            } catch (error) {
              finish(false);
            }
          },
          fail: function () { finish(false); }
        });
      } catch (error) {
        finish(false);
      }
    });
  },

  onStartOrCapture: function () {
    if (this.data.busy || this.motionStarting || (this.data.cameraOn && !this.data.cameraReady)) return;
    if (this.data.capabilityBlocked || this.captureBackend === "unsupported") {
      wx.showToast({ title: "当前手机不支持可靠全景", icon: "none" });
      return;
    }
    if (this.data.cameraReady) {
      if (this.data.orientationReady) {
        this.autoCaptureSuspended = false;
        if (!this.data.captureSessionStarted) {
          this.setData({
            captureSessionStarted: true,
            captureNeedsRetry: false,
            guideTitle: "对准第一颗白点",
            guideDetail: "停稳后，再点“确认第一张”"
          });
          this.updateTarget();
          return;
        }
        this.setData({ captureNeedsRetry: false });
        this.captureCurrent();
      }
      else {
        if (this.captureBackend === "basic") this.startMotion();
        this.setData({
          guideTitle: "等待方向传感器",
          guideDetail: "收到同帧相机姿态后才允许拍摄"
        });
      }
      return;
    }
    this.setData({
      cameraOn: true,
      guideTitle: "正在开启后摄",
      guideDetail: "首次使用请允许相机权限"
    });
    if (this.captureBackend === "visionkit") {
      var self = this;
      this.setData({ cameraOn: true }, function () {
        self.startVisionKit();
      });
    } else {
      this.startMotion();
    }
    var self = this;
    if (this.cameraStartTimer) clearTimeout(this.cameraStartTimer);
    this.cameraStartTimer = setTimeout(function () {
      self.cameraStartTimer = null;
      if (!self.pageAlive || !self.pageVisible || self.data.cameraReady) return;
      if (self.captureBackend === "visionkit") {
        self.failVisionKitRecoverably(
          "启动超过 8 秒，旧会话已清理；检查相机权限后可直接重试",
          "VK_START_TIMEOUT"
        );
        return;
      }
      self.stopMotion();
      self.setData({
        cameraOn: false,
        cameraReady: false,
        orientationReady: false,
        guideTitle: "相机开启超时",
        guideDetail: "请检查微信相机权限后重试"
      });
    }, 8000);
  },

  startVisionKit: async function () {
    if (!this.pageAlive || !this.pageVisible || this.visionKit ||
        this.captureBackend !== "visionkit") return;
    this.cameraStartInFlight = true;
    var operationToken = this.lifecycleToken;
    try {
      // A new VKSession owns a new local world origin. Rebase its first frame
      // onto the last visible panorama heading so retry/background resume does
      // not rotate every already captured patch to a new coordinate system.
      if (this.headingOffsetDeg !== null && this.trackingPose) {
        this.resumeHeadingDeg = P.headingDeg(this.trackingPose);
      }
      this.headingOffsetDeg = null;
      this.lastTrackingPose = null;
      this.lastTrackingAt = 0;
      this.poseHistory = [];
      await this.measureLiveViewport();
      var item = await this.queryCanvasNode("#vkCameraCanvas", 6);
      if (!this.pageAlive || !this.pageVisible || operationToken !== this.lifecycleToken) return;
      var info = {};
      try {
        info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      } catch (ignored) {}
      var self = this;
      this.visionKit = VisionKit.createAdapter({
        wxApi: wx,
        canvas: item.node,
        cssWidth: item.width || (this.liveViewport && this.liveViewport.width) || 270,
        cssHeight: item.height || (this.liveViewport && this.liveViewport.height) || 360,
        pixelRatio: info.pixelRatio || 1,
        onReady: function (status) {
          if (!self.pageAlive || !self.pageVisible || operationToken !== self.lifecycleToken) return;
          self.visionSessionVersion = status.version || "v1";
          self.setData({
            captureBackendLabel: "VisionKit " + self.visionSessionVersion + " · 正在同步帧",
            diagnosticText: "会话已开启，等待相机帧时间戳"
          });
        },
        onFrame: function (snapshot) {
          self.onVisionFrame(snapshot, operationToken);
        },
        onFatal: function (error) {
          if (!self.pageAlive || operationToken !== self.lifecycleToken) return;
          console.error("[capture] VisionKit fatal", error);
          self.failVisionKitRecoverably(
            "相机帧中断，旧会话已清理；请重新开启相机。",
            (error && (error.code || error.message)) || "VK_FRAME_FAILED"
          );
        }
      });
      await this.visionKit.start();
    } catch (error) {
      this.cameraStartInFlight = false;
      console.error("[capture] VisionKit start failed", error);
      if (this.pageAlive && operationToken === this.lifecycleToken) {
        var reason = (error && (error.errMsg || error.message || error.code)) || "";
        var permissionDenied = /auth|authorize|permission|deny|scope\.camera/i.test(String(reason));
        this.failVisionKitRecoverably(
          permissionDenied
            ? "微信没有获得相机权限；请在设置中允许后重新开启"
            : "同帧相机没有启动成功；已清理旧会话，可直接重试",
          (error && (error.errCode || error.code || error.message)) || "VK_START_FAILED"
        );
        if (permissionDenied) this.recoverCameraPermission();
      }
    }
  },

  onVisionFrame: function (snapshot, operationToken) {
    if (!this.pageAlive || !this.pageVisible || operationToken !== this.lifecycleToken ||
        this.captureBackend !== "visionkit" || !snapshot || !snapshot.basis) return;
    if (!snapshot.hasJpegCapture && !snapshot.hasRgbaCapture) {
      this.blockReliableCapture(
        "VisionKit 可以预览，但当前微信不能从同一帧导出照片，因此不会进入错误的兼容拍摄。",
        "VK_FRAME_EXPORT_UNSUPPORTED"
      );
      return;
    }
    this.cameraStartInFlight = false;
    this.resumeCameraOnShow = false;
    this.latestFrameSnapshot = snapshot;
    if (snapshot.diagnostics && !this.visionFovWarningLogged) {
      this.visionFovWarningLogged = true;
      console.warn("[capture] VisionKit projection/intrinsics FOV mismatch", snapshot.diagnostics);
    }
    var frameClockMs = snapshot.timestampNs > 0
      ? snapshot.timestampNs / 1000000
      : snapshot.receivedAtMs;
    var trackingAccepted = this.acceptTrackingPose(snapshot.basis, frameClockMs, {
      source: "visionkit",
      timestampNs: snapshot.timestampNs,
      fovXDeg: snapshot.fovXDeg,
      intrinsics: snapshot.intrinsics
    });
    if (!this.data.cameraReady) {
      if (this.cameraStartTimer) {
        clearTimeout(this.cameraStartTimer);
        this.cameraStartTimer = null;
      }
      this.setData({
        cameraReady: true,
        cameraError: "",
        captureSessionStarted: false,
        captureNeedsRetry: false,
        captureBackendLabel: "VisionKit " + (this.visionSessionVersion || "v1") + " 同帧 · " +
          (snapshot.hasJpegCapture ? "JPG" : "RGBA"),
        guideTitle: trackingAccepted ? "方向就绪后，点“开始拍摄”" : "先让镜头接近水平",
        guideDetail: trackingAccepted
          ? "第一张由你确认，后续停稳 0.5 秒自动拍摄"
          : "锁定起始方向后再开始拍摄"
      });
    }
  },

  acceptTrackingPose: function (rawBasis, sampleTimeMs, metadata) {
    if (!rawBasis) return false;
    var horizontal = Math.sqrt(
      rawBasis.F[0] * rawBasis.F[0] + rawBasis.F[1] * rawBasis.F[1]
    );
    if (this.headingOffsetDeg === null) {
      if (horizontal < 0.25) {
        if (this.pageAlive) {
          this.setData({
            orientationReady: false,
            guideTitle: "先让镜头接近水平",
            guideDetail: "锁定起始方向后再开始拍摄"
          });
        }
        return false;
      }
      var desiredHeadingDeg = isFinite(Number(this.resumeHeadingDeg))
        ? Number(this.resumeHeadingDeg)
        : 0;
      this.headingOffsetDeg = P.headingDeg(rawBasis) - desiredHeadingDeg;
      this.resumeHeadingDeg = null;
    }
    var rebased = P.rotateBasisZ(rawBasis, this.headingOffsetDeg);
    var timeMs = Number(sampleTimeMs) || Date.now();
    var deltaMs = this.lastTrackingAt ? timeMs - this.lastTrackingAt : 0;
    if (this.lastTrackingPose && deltaMs > 0 && deltaMs <= 500) {
      this.rawAngularSpeed =
        Pose.basisRotationErrorDeg(this.lastTrackingPose, rebased) * 1000 / deltaMs;
    } else {
      this.rawAngularSpeed = Infinity;
    }
    this.trackingPose = P.copyBasis(rebased);
    this.displayPose = Pose.smoothBasisDt(
      this.displayPose,
      this.trackingPose,
      deltaMs,
      DISPLAY_POSE_TAU_MS
    );
    this.basis = this.displayPose;
    this.lastTrackingPose = P.copyBasis(this.trackingPose);
    this.lastTrackingAt = timeMs;
    this.poseHistory.push({
      timeMs: timeMs,
      timestampNs: metadata && metadata.timestampNs || 0,
      basis: P.copyBasis(this.trackingPose),
      rawSpeedDegS: this.rawAngularSpeed
    });
    if (this.activeShutterWindow && timeMs >= this.activeShutterWindow.startTimeMs) {
      var shutter = this.activeShutterWindow;
      shutter.sampleCount += 1;
      shutter.lastTimeMs = timeMs;
      if (isFinite(this.rawAngularSpeed)) {
        shutter.maxRawSpeedDegS = Math.max(
          shutter.maxRawSpeedDegS,
          this.rawAngularSpeed
        );
      } else {
        shutter.hasUnmeasuredSpeed = true;
      }
      shutter.poseSpanDeg = Math.max(
        shutter.poseSpanDeg,
        Pose.basisRotationErrorDeg(shutter.referenceBasis, this.trackingPose)
      );
    }
    while (this.poseHistory.length && timeMs - this.poseHistory[0].timeMs > 1800) {
      this.poseHistory.shift();
    }
    if (metadata && isFinite(metadata.fovXDeg) &&
        metadata.fovXDeg >= 25 && metadata.fovXDeg <= 125) {
      this.currentFovXDeg = metadata.fovXDeg;
    }
    if (!this.data.orientationReady) {
      this.setData({
        orientationReady: true,
        guideTitle: this.data.captureSessionStarted
          ? "只对准下一颗白点"
          : "方向已就绪，点“开始拍摄”",
        guideDetail: this.data.captureSessionStarted
          ? "停稳 0.5 秒会自动拍摄"
          : "第一张由你确认，后续会自动拍摄"
      });
    }
    var now = Date.now();
    if (!this.lastDiagnosticUiAt || now - this.lastDiagnosticUiAt >= 300) {
      this.lastDiagnosticUiAt = now;
      var source = metadata && metadata.source === "visionkit" ? "同帧" : "兼容";
      this.setData({
        diagnosticText: source + "姿态 · FOV " +
          this.currentFovXDeg.toFixed(1) + "° · 原始角速 " +
          (isFinite(this.rawAngularSpeed) ? this.rawAngularSpeed.toFixed(1) : "—") + "°/s"
      });
    }
    this.updateTarget();
    this.scheduleWorldPreview();
    return true;
  },

  poseWindowStats: function (startTimeMs, endTimeMs, referenceBasis) {
    var start = Number(startTimeMs);
    var end = Number(endTimeMs);
    var reference = referenceBasis || this.trackingPose;
    var samples = (this.poseHistory || []).filter(function (sample) {
      return sample.timeMs >= start - 0.01 && sample.timeMs <= end + 0.01;
    });
    var maxSpeed = 0;
    var maxSpan = 0;
    samples.forEach(function (sample) {
      if (isFinite(sample.rawSpeedDegS)) maxSpeed = Math.max(maxSpeed, sample.rawSpeedDegS);
      maxSpan = Math.max(maxSpan, Pose.basisRotationErrorDeg(reference, sample.basis));
    });
    return {
      sampleCount: samples.length,
      durationMs: samples.length ? samples[samples.length - 1].timeMs - samples[0].timeMs : 0,
      maxRawSpeedDegS: samples.length ? maxSpeed : Infinity,
      poseSpanDeg: samples.length ? maxSpan : Infinity
    };
  },

  beginShutterWindow: function (startTimeMs, referenceBasis) {
    this.activeShutterWindow = {
      startTimeMs: Number(startTimeMs) || Date.now(),
      lastTimeMs: Number(startTimeMs) || Date.now(),
      referenceBasis: P.copyBasis(referenceBasis),
      sampleCount: 1,
      maxRawSpeedDegS: isFinite(this.rawAngularSpeed) ? this.rawAngularSpeed : Infinity,
      poseSpanDeg: 0,
      hasUnmeasuredSpeed: !isFinite(this.rawAngularSpeed)
    };
    return this.activeShutterWindow;
  },

  endShutterWindow: function (endTimeMs) {
    var shutter = this.activeShutterWindow;
    this.activeShutterWindow = null;
    if (!shutter) {
      return {
        sampleCount: 0,
        durationMs: Infinity,
        maxRawSpeedDegS: Infinity,
        poseSpanDeg: Infinity
      };
    }
    var end = Number(endTimeMs) || shutter.lastTimeMs;
    return {
      sampleCount: shutter.sampleCount,
      durationMs: Math.max(0, end - shutter.startTimeMs),
      maxRawSpeedDegS: shutter.hasUnmeasuredSpeed
        ? Infinity
        : shutter.maxRawSpeedDegS,
      poseSpanDeg: shutter.poseSpanDeg
    };
  },

  stableTrackingWindow: function (endTimeMs) {
    var end = Number(endTimeMs) || this.lastTrackingAt;
    var stats = this.poseWindowStats(
      end - MIN_STABLE_WINDOW_MS - 80,
      end,
      this.trackingPose
    );
    stats.instantRawSpeedDegS = this.rawAngularSpeed;
    stats.stable = stats.sampleCount >= 4 &&
      stats.durationMs >= MIN_STABLE_WINDOW_MS &&
      isFinite(stats.instantRawSpeedDegS) &&
      stats.instantRawSpeedDegS <= RAW_INSTANT_SPEED_DEG_S &&
      stats.maxRawSpeedDegS <= STABLE_WINDOW_SPEED_DEG_S &&
      stats.poseSpanDeg <= STABLE_POSE_SPAN_DEG;
    return stats;
  },

  onCameraReady: function () {
    if (!this.pageAlive || !this.pageVisible) return;
    this.cameraStartInFlight = false;
    if (this.cameraStartTimer) {
      clearTimeout(this.cameraStartTimer);
      this.cameraStartTimer = null;
    }
    this.cameraContext = wx.createCameraContext();
    this.autoCaptureSuspended = false;
    this.setData({
      cameraReady: true,
      cameraError: "",
      captureSessionStarted: false,
      captureNeedsRetry: false,
      guideTitle: "方向就绪后，点“开始拍摄”",
      guideDetail: this.data.orientationReady
        ? "第一张由你确认，后续停稳 0.5 秒自动拍摄"
        : "等待方向传感器，未就绪前不能拍摄"
    });
  },

  onCameraError: function (event) {
    var detail = event && event.detail;
    console.error("[capture] camera error", detail);
    this.cameraStartInFlight = false;
    this.resumeCameraOnShow = false;
    if (this.cameraStartTimer) {
      clearTimeout(this.cameraStartTimer);
      this.cameraStartTimer = null;
    }
    this.cancelCaptureAttempt();
    this.stableSince = 0;
    this.autoCaptureSuspended = false;
    this.stopMotion();
    this.setData({
      cameraOn: false,
      cameraReady: false,
      orientationReady: false,
      busy: false,
      captureSessionStarted: false,
      cameraError: (detail && detail.errMsg) || "相机没有开启",
      guideTitle: "相机没有开启",
      guideDetail: "请在微信设置中允许相机权限后重试"
    });
  },

  onCameraStop: function () {
    this.cameraStartInFlight = false;
    this.resumeCameraOnShow = false;
    if (this.cameraStartTimer) {
      clearTimeout(this.cameraStartTimer);
      this.cameraStartTimer = null;
    }
    this.cancelCaptureAttempt();
    this.stableSince = 0;
    this.autoCaptureSuspended = false;
    this.stopMotion();
    this.setData({
      cameraOn: false,
      cameraReady: false,
      orientationReady: false,
      busy: false,
      captureSessionStarted: false,
      guideTitle: "相机已暂停",
      guideDetail: "从后台返回后请重新开启"
    });
  },

  startMotion: function () {
    var self = this;
    if (!this.pageAlive || !this.pageVisible || this.motionStarting || this.motionActive) return;
    if (!wx.startDeviceMotionListening || !wx.onDeviceMotionChange) {
      this.setData({
        orientationReady: false,
        guideTitle: "方向传感器不可用",
        guideDetail: "不能可靠定位照片方向，当前设备无法进行全景拍摄"
      });
      return;
    }
    this.motionStarting = true;
    var generation = ++this.motionGeneration;
    var lifecycleToken = this.lifecycleToken;
    wx.startDeviceMotionListening({
      interval: "game",
      success: function () {
        if (!self.pageAlive || !self.pageVisible || generation !== self.motionGeneration ||
            lifecycleToken !== self.lifecycleToken) {
          self.motionStarting = false;
          try { wx.stopDeviceMotionListening(); } catch (ignored) {}
          return;
        }
        self.motionStarting = false;
        self.motionHandler = function (event) { self.onMotion(event); };
        self.motionActive = true;
        wx.onDeviceMotionChange(self.motionHandler);
      },
      fail: function (error) {
        if (generation !== self.motionGeneration) return;
        self.motionStarting = false;
        self.motionActive = false;
        console.warn("[capture] device motion unavailable", error);
        self.setData({
          orientationReady: false,
          guideTitle: "方向传感器不可用",
          guideDetail: "不能可靠定位照片方向，请检查微信权限或更换设备"
        });
      }
    });
  },

  stopMotion: function () {
    this.motionGeneration += 1;
    this.motionStarting = false;
    this.motionActive = false;
    this.lastTrackingPose = null;
    this.lastTrackingAt = 0;
    this.rawAngularSpeed = Infinity;
    this.poseHistory = [];
    this.stableSince = 0;
    if (this.motionHandler && wx.offDeviceMotionChange) {
      try { wx.offDeviceMotionChange(this.motionHandler); } catch (e) {}
      this.motionHandler = null;
    }
    if (wx.stopDeviceMotionListening) {
      try { wx.stopDeviceMotionListening(); } catch (e2) {}
    }
  },

  onMotion: function (event) {
    if (!this.pageAlive || !this.pageVisible || !this.motionActive ||
        this.data.phase !== "capture") return;
    if (!event || typeof event.alpha !== "number" ||
        typeof event.beta !== "number" || typeof event.gamma !== "number") return;
    // 微信回调是弧度，浏览器 DeviceOrientationEvent 是度数；先在共享适配层
    // 明确换算，再走同一个完整 alpha/beta/gamma 矩阵。capture.json 锁定
    // portrait，因此 screen angle 固定为 0。
    var raw = P.basisFromDeviceMotionRadians(event.alpha, event.beta, event.gamma, 0);
    this.acceptTrackingPose(raw, Date.now(), {
      source: "basic",
      timestampNs: 0,
      fovXDeg: DEFAULT_CAPTURE_FOV_DEG,
      intrinsics: null
    });
  },

  updateTarget: function () {
    var target = this.targets[this.targetIndex];
    if (!target) {
      this.setData({
        targetHidden: true,
        guideTitle: "所有目标都拍完了",
        guideDetail: "正在准备 2D 全景结果"
      });
      return;
    }
    // 快门/解码与方向监听是两条独立链路。保存这一张时隐藏目标，
    // 避免真机图片回调变慢时出现“白点还在跑、但应用像卡住”的假象。
    if (this.data.busy || this.capturing) {
      this.stableSince = 0;
      if (!this.data.targetHidden || this.data.dwellDeg) {
        this.setData({ targetHidden: true, targetAligned: false, dwellDeg: 0 });
      }
      return;
    }
    var width = this.worldCssWidth || 375;
    var height = this.worldCssHeight || 667;
    var viewport = this.liveViewport || {
      left: width * 0.14,
      top: (height - width * 0.96) / 2,
      width: width * 0.72,
      height: width * 0.96,
      centerX: width / 2,
      centerY: height / 2
    };
    var fovXDeg = this.currentFovXDeg || DEFAULT_CAPTURE_FOV_DEG;
    var trackingPose = this.trackingPose || this.displayPose || this.basis;
    // VisionKit preview and tracking come from the same VKFrame. Projecting the
    // target with a 90 ms delayed display pose makes the dot visibly swim over
    // the live image, so reliable mode uses that frame's raw pose for geometry.
    // Smoothing remains isolated to the legacy diagnostic path and never
    // participates in shutter stability.
    var displayPose = this.captureBackend === "visionkit"
      ? trackingPose
      : (this.displayPose || trackingPose);
    var projected = P.projectDirection(
      target.dir,
      displayPose,
      fovXDeg,
      viewport.width / viewport.height
    );
    var captureProjected = P.projectDirection(
      target.dir,
      trackingPose,
      fovXDeg,
      viewport.width / viewport.height
    );
    var orientationActive = this.data.cameraReady && this.data.orientationReady && this.motionActive;
    if (this.captureBackend === "visionkit") {
      orientationActive = this.data.cameraReady && this.data.orientationReady && !!this.visionKit;
    }
    var visible = projected.visible && orientationActive;
    var nx = visible ? projected.nx : projected.guideNx;
    var ny = visible ? projected.ny : projected.guideNy;
    var x = orientationActive
      ? P.clamp(
          viewport.left + (nx * 0.5 + 0.5) * viewport.width,
          viewport.left + 18,
          viewport.left + viewport.width - 18
        )
      : viewport.centerX;
    var y = orientationActive
      ? P.clamp(
          viewport.top + (0.5 - ny * 0.5) * viewport.height,
          viewport.top + 18,
          viewport.top + viewport.height - 18
        )
      : viewport.centerY;
    var aligned = captureProjected.angleDeg <= STABLE_ANGLE_DEG;
    var stability = this.stableTrackingWindow(this.lastTrackingAt);
    var steady = stability.stable;
    var upright = Math.abs(trackingPose.rollDeg || 0) <= MAX_ROLL_DEG;
    var now = Date.now();
    var trackingNow = this.lastTrackingAt || now;
    var dwell = 0;
    var title = "只对准下一颗白点";
    var detail = "停稳 0.5 秒会自动拍摄";

    var canAutoCapture = this.data.phase === "capture" && this.pageVisible &&
      !this.data.busy && !this.data.helpVisible && !this.capturing &&
      !this.autoCaptureSuspended && this.data.captureSessionStarted &&
      this.frames.length > 0 && this.data.cameraReady && this.data.orientationReady &&
      (this.captureBackend === "visionkit" ? !!this.visionKit : this.motionActive);

    if (!orientationActive) {
      this.stableSince = 0;
      title = "把下一颗白点移进中央圆环";
      detail = !this.data.cameraReady
        ? (this.data.cameraOn ? "相机准备好后开始拍摄" : "开启相机后开始拍摄")
        : "等待方向传感器，未就绪前不能拍摄";
    } else if (!this.data.captureSessionStarted) {
      this.stableSince = 0;
      title = "方向已就绪";
      detail = "点底部“开始拍摄”确认第一张";
    } else if (!this.frames.length) {
      this.stableSince = 0;
      title = visible && aligned && steady && upright ? "第一张已对准" : "对准第一颗白点并停稳";
      detail = visible && aligned && steady && upright
        ? "点底部“确认第一张”"
        : "第一张不会自动抢拍";
    } else if (this.autoCaptureSuspended) {
      this.stableSince = 0;
      title = "当前方向需要重试";
      detail = "点底部“重试这一张”，不会等待上传";
    } else if (visible && aligned && steady && upright && canAutoCapture) {
      if (!this.stableSince) this.stableSince = trackingNow - MIN_STABLE_WINDOW_MS;
      dwell = P.clamp((trackingNow - this.stableSince) / DWELL_MS, 0, 1);
      title = "保持不动";
      detail = "正在锁定这一方向";
      if (dwell >= 1) this.captureCurrent();
    } else {
      this.stableSince = 0;
      if (!upright) {
        title = "请把手机扶正";
        detail = "侧倾过大会暂停自动拍摄";
      } else if (!steady) {
        title = "移动慢一点";
        detail = "原始姿态稳定满 0.4 秒后才会拍摄";
      } else if (!visible) {
        title = "继续转向屏幕边缘白点";
        detail = projected.behind ? "下一方向在身后" : "白点进入取景区后再对准中央圆环";
      }
    }

    // VisionKit geometry is tied to its camera frame, so keep the target near
    // 30 Hz. The legacy diagnostic path stays at ~20 Hz to avoid noisy setData.
    var targetUiIntervalMs = this.captureBackend === "visionkit" ? 32 : 48;
    if (!this.lastTargetUiAt || now - this.lastTargetUiAt >= targetUiIntervalMs || dwell >= 1) {
      this.lastTargetUiAt = now;
      this.setData({
        targetX: x,
        targetY: y,
        targetHidden: !orientationActive,
        targetOffscreen: orientationActive && !visible,
        targetAligned: visible && aligned,
        dwellDeg: Math.round(dwell * 360),
        guideTitle: title,
        guideDetail: detail
      });
    }
  },

  takePhoto: function (timeoutMs) {
    var self = this;
    return new Promise(function (resolve, reject) {
      if (!self.cameraContext) {
        reject(new Error("相机还没有准备好"));
        return;
      }
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        var error = new Error("相机拍摄响应超时");
        error.code = "TAKE_PHOTO_TIMEOUT";
        reject(error);
      }, timeoutMs || TAKE_PHOTO_TIMEOUT_MS);
      function finish(callback, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      }
      self.cameraContext.takePhoto({
        quality: "normal",
        success: function (res) {
          if (res && res.tempImagePath) finish(resolve, res.tempImagePath);
          else finish(reject, new Error("相机没有返回照片"));
        },
        fail: function (error) { finish(reject, error); }
      });
    });
  },

  writeVisionJpeg: function (buffer) {
    var self = this;
    return new Promise(function (resolve, reject) {
      if (!wx.getFileSystemManager || !wx.env || !wx.env.USER_DATA_PATH) {
        reject(new Error("微信文件系统不可用"));
        return;
      }
      var path = wx.env.USER_DATA_PATH + "/unseen-pano-" +
        Date.now() + "-" + self.captureAttemptId + ".jpg";
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        var error = new Error("VisionKit 照片写入超时");
        error.code = "IMAGE_WRITE_TIMEOUT";
        reject(error);
      }, IMAGE_WRITE_TIMEOUT_MS);
      function finish(callback, value) {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        callback(value);
        return true;
      }
      wx.getFileSystemManager().writeFile({
        filePath: path,
        data: buffer,
        success: function () {
          if (settled) {
            try { wx.getFileSystemManager().unlinkSync(path); } catch (ignored) {}
            return;
          }
          self.ownedFramePaths.push(path);
          finish(resolve, path);
        },
        fail: function (error) { finish(reject, error); }
      });
    });
  },

  exportRgbaFrame: function (pixels, width, height, timeoutMs) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = null;
      var exportJob = {
        cancel: function (error) {
          finish(reject, error || new Error("RGBA 照片导出已取消"));
        }
      };
      function finish(callback, value) {
        if (settled) {
          if (value && value.tempFilePath && wx.getFileSystemManager) {
            try { wx.getFileSystemManager().unlinkSync(value.tempFilePath); } catch (ignored) {}
          }
          return false;
        }
        settled = true;
        if (timer) clearTimeout(timer);
        if (self.activeRgbaExport === exportJob) self.activeRgbaExport = null;
        callback(value);
        return true;
      }
      try {
        if (!self.sourceCanvasNode || !self.sourceCtx) {
          var unavailable = new Error("RGBA 照片处理画布不可用");
          unavailable.code = "RGBA_EXPORT_CANVAS_UNAVAILABLE";
          throw unavailable;
        }
        self.activeRgbaExport = exportJob;
        timer = setTimeout(function () {
          var error = new Error("RGBA 照片导出超时");
          error.code = "RGBA_EXPORT_TIMEOUT";
          finish(reject, error);
        }, Math.max(50, Number(timeoutMs) || RGBA_EXPORT_TIMEOUT_MS));
        self.sourceCanvasNode.width = width;
        self.sourceCanvasNode.height = height;
        self.sourceCtx = self.sourceCanvasNode.getContext("2d");
        if (!self.sourceCtx) {
          var contextError = new Error("RGBA 照片处理上下文不可用");
          contextError.code = "RGBA_EXPORT_CANVAS_UNAVAILABLE";
          throw contextError;
        }
        var imageData = self.sourceCtx.createImageData(width, height);
        imageData.data.set(pixels);
        self.sourceCtx.putImageData(imageData, 0, 0);
        imageData = null;
        wx.canvasToTempFilePath({
          canvas: self.sourceCanvasNode,
          x: 0,
          y: 0,
          width: width,
          height: height,
          destWidth: width,
          destHeight: height,
          fileType: "jpg",
          quality: 0.9,
          success: function (result) {
            if (!result || !result.tempFilePath) {
              finish(reject, new Error("RGBA 画布没有返回照片路径"));
              return;
            }
            if (settled) {
              if (wx.getFileSystemManager) {
                try { wx.getFileSystemManager().unlinkSync(result.tempFilePath); } catch (ignored) {}
              }
              return;
            }
            finish(resolve, result.tempFilePath);
          },
          fail: function (error) { finish(reject, error); }
        }, self);
      } catch (error) {
        finish(reject, error);
      }
    });
  },

  removeOwnedFramePath: function (path) {
    var index = (this.ownedFramePaths || []).indexOf(path);
    if (index < 0) return;
    this.ownedFramePaths.splice(index, 1);
    if (!wx.getFileSystemManager) return;
    try { wx.getFileSystemManager().unlinkSync(path); } catch (ignored) {}
  },

  poseNearestTime: function (timeMs) {
    var history = this.poseHistory || [];
    if (!history.length) {
      return P.copyBasis(
        this.trackingPose ||
        this.basis ||
        P.orthonormalBasis([0, 1, 0], [0, 0, 1])
      );
    }
    var nearest = history[0];
    var best = Math.abs(nearest.timeMs - timeMs);
    for (var i = 1; i < history.length; i += 1) {
      var distance = Math.abs(history[i].timeMs - timeMs);
      if (distance < best) {
        nearest = history[i];
        best = distance;
      }
    }
    return P.copyBasis(nearest.basis);
  },

  collectCaptureFrame: async function (requestedWallMs, requestedPoseTimeMs) {
    if (this.captureBackend === "visionkit") {
      if (!this.visionKit) throw new Error("VisionKit 会话已中断");
      var vk = await this.visionKit.captureNextFrame({
        preferRgba: true,
        width: VK_CAPTURE_WIDTH,
        height: VK_CAPTURE_HEIGHT,
        rgbaWidth: VK_RGBA_CAPTURE_WIDTH,
        rgbaHeight: VK_RGBA_CAPTURE_HEIGHT,
        quality: 90,
        timeoutMs: VK_CAPTURE_TIMEOUT_MS
      });
      if (!vk.snapshot || !vk.snapshot.basis) throw new Error("VisionKit 同帧姿态缺失");
      var captureBasis = P.rotateBasisZ(vk.snapshot.basis, this.headingOffsetDeg || 0);
      var captureTimeMs = vk.snapshot.timestampNs > 0
        ? vk.snapshot.timestampNs / 1000000
        : vk.acquiredAtMs;
      var shutterStats = this.endShutterWindow(captureTimeMs);
      var decoded;
      var path;
      var ownedPath = false;
      if (vk.kind === "jpeg") {
        path = await this.writeVisionJpeg(vk.buffer);
        ownedPath = true;
        decoded = await this.loadImageData(path, 720);
      } else if (vk.kind === "rgba") {
        var pixels = new Uint8ClampedArray(vk.buffer);
        decoded = {
          data: pixels,
          width: vk.width,
          height: vk.height
        };
        path = null;
      } else {
        throw new Error("VisionKit 返回了未知照片格式");
      }
      return {
        backend: "visionkit",
        path: path,
        ownedPath: ownedPath,
        decoded: decoded,
        captureBasis: captureBasis,
        captureTimeMs: captureTimeMs,
        captureWallMs: vk.acquiredAtMs,
        shutterWindowMs: Math.max(0, captureTimeMs - requestedPoseTimeMs),
        shutterStats: shutterStats,
        timestampNs: vk.snapshot.timestampNs || 0,
        fovXDeg: vk.snapshot.fovXDeg || this.currentFovXDeg,
        intrinsics: vk.snapshot.intrinsics,
        viewMatrix: vk.snapshot.viewMatrix
      };
    }

    // Developer-only basic fallback. Because takePhoto exposes no exposure
    // timestamp, every pose sample from request to callback is part of the
    // rejection window and the midpoint pose is only an explicit estimate.
    var path = await this.takePhoto();
    var callbackWallMs = Date.now();
    var shutterStats = this.endShutterWindow(callbackWallMs);
    return {
      backend: "basic",
      path: path,
      ownedPath: false,
      decoded: await this.loadImageData(path, 640),
      captureBasis: this.poseNearestTime((requestedWallMs + callbackWallMs) / 2),
      captureTimeMs: callbackWallMs,
      captureWallMs: callbackWallMs,
      shutterWindowMs: callbackWallMs - requestedWallMs,
      shutterStats: shutterStats,
      timestampNs: 0,
      fovXDeg: DEFAULT_CAPTURE_FOV_DEG,
      intrinsics: null,
      viewMatrix: null
    };
  },

  normalizeImagePath: function (path, timeoutMs) {
    return new Promise(function (resolve) {
      // 包内资源必须保留 `/assets/...`。开发者工具的 getImageInfo 会把它
      // 规范化成缺少前导斜杠的 `assets/...`，Canvas Image 随后反而无法加载。
      if (/^\/assets\//.test(path || "")) {
        resolve(path);
        return;
      }
      if (!wx.getImageInfo) {
        resolve(path);
        return;
      }
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        resolve(path);
      }, timeoutMs || IMAGE_INFO_TIMEOUT_MS);
      function finish(value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value || path);
      }
      wx.getImageInfo({
        src: path,
        success: function (info) {
          var candidate = info && (info.path || info.tempFilePath);
          // 只采用明确的绝对沙箱/URI 路径；相对路径继续用原值。
          finish(candidate && (/^(?:wxfile|file|https?):/i.test(candidate) || candidate.charAt(0) === "/")
            ? candidate
            : path);
        },
        fail: function () { finish(path); }
      });
    });
  },

  decodeImageOnce: function (factoryCanvas, path, maxSide, timeoutMs, label) {
    var self = this;
    return new Promise(function (resolve, reject) {
      if (!factoryCanvas || !factoryCanvas.createImage || !self.sourceCanvasNode) {
        reject(new Error((label || "Canvas") + " 图片解码不可用"));
        return;
      }
      var settled = false;
      var image = factoryCanvas.createImage();
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        image.onload = null;
        image.onerror = null;
        try { image.src = ""; } catch (ignored) {}
        var error = new Error((label || "Canvas") + " 照片解码超时");
        error.code = "IMAGE_DECODE_TIMEOUT";
        reject(error);
      }, timeoutMs || IMAGE_DECODE_TIMEOUT_MS);
      function finish(callback, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        image.onload = null;
        image.onerror = null;
        callback(value);
      }
      image.onload = function () {
        try {
          if (!self.pageAlive || !self.pageVisible) {
            finish(reject, new Error("页面进入后台，已取消图片解码"));
            return;
          }
          // Match the visible 3:4 live window even if a device returns a
          // landscape sensor file. Projection must consume the same centre
          // crop the user framed, otherwise the 28-target coverage contract
          // leaves black polar caps on those devices.
          var crop = P.centerCropRect(image.width, image.height, 3 / 4);
          var cropX = crop.x;
          var cropY = crop.y;
          var cropW = crop.width;
          var cropH = crop.height;
          var scale = Math.min(1, maxSide / Math.max(cropW, cropH));
          var width = Math.max(2, Math.round(cropW * scale));
          var height = Math.max(2, Math.round(cropH * scale));
          self.sourceCanvasNode.width = width;
          self.sourceCanvasNode.height = height;
          self.sourceCtx = self.sourceCanvasNode.getContext("2d");
          self.sourceCtx.clearRect(0, 0, width, height);
          self.sourceCtx.drawImage(
            image, cropX, cropY, cropW, cropH, 0, 0, width, height
          );
          var data = self.sourceCtx.getImageData(0, 0, width, height);
          finish(resolve, data);
        } catch (error) {
          finish(reject, error);
        }
      };
      image.onerror = function (error) {
        finish(reject, error || new Error((label || "Canvas") + " 照片解码失败"));
      };
      image.src = path;
    });
  },

  loadImageData: async function (path, maxSide, timeoutMs) {
    var normalizedPath = await this.normalizeImagePath(path);
    var candidates = [];
    if (this.worldCanvasNode && this.worldCanvasNode.createImage) {
      candidates.push({ canvas: this.worldCanvasNode, label: "可见 Canvas" });
    }
    if (this.sourceCanvasNode && this.sourceCanvasNode.createImage &&
        this.sourceCanvasNode !== this.worldCanvasNode) {
      candidates.push({ canvas: this.sourceCanvasNode, label: "离屏 Canvas" });
    }
    if (!candidates.length) throw new Error("2D Canvas 图片解码不可用");
    var errors = [];
    for (var i = 0; i < candidates.length; i += 1) {
      try {
        return await this.decodeImageOnce(
          candidates[i].canvas,
          normalizedPath,
          maxSide,
          timeoutMs || IMAGE_DECODE_TIMEOUT_MS,
          candidates[i].label
        );
      } catch (error) {
        errors.push(error);
        console.warn("[capture] image decode candidate failed", candidates[i].label, error);
      }
    }
    var finalError = errors[errors.length - 1] || new Error("照片解码失败");
    if (errors.some(function (error) { return error && error.code === "IMAGE_DECODE_TIMEOUT"; })) {
      finalError.code = "IMAGE_DECODE_TIMEOUT";
    }
    throw finalError;
  },

  cancelCaptureAttempt: function () {
    this.captureAttemptId = (this.captureAttemptId || 0) + 1;
    this.capturing = false;
    this.activeShutterWindow = null;
    if (this.activeRgbaExport && this.activeRgbaExport.cancel) {
      var error = new Error("照片导出已取消");
      error.code = "RGBA_EXPORT_CANCELLED";
      this.activeRgbaExport.cancel(error);
    }
  },

  captureCurrent: async function () {
    var target = this.targets[this.targetIndex];
    var backendActive = this.captureBackend === "visionkit"
      ? !!this.visionKit
      : this.motionActive;
    if (!target || this.capturing || this.data.busy || !this.pageVisible ||
        !backendActive || !this.data.cameraReady || !this.data.orientationReady) return;

    // Capture gates consume trackingPose only. displayPose is intentionally
    // absent here: smoothing must never hide real motion from the shutter.
    var viewport = this.liveViewport || { width: 270, height: 360 };
    var captureTrackingPose = this.trackingPose ||
      this.basis ||
      P.orthonormalBasis([0, 1, 0], [0, 0, 1]);
    var preProjection = P.projectDirection(
      target.dir,
      captureTrackingPose,
      this.currentFovXDeg || DEFAULT_CAPTURE_FOV_DEG,
      viewport.width / viewport.height
    );
    var preStability = Array.isArray(this.poseHistory)
      ? this.stableTrackingWindow(this.lastTrackingAt)
      : {
          stable: true,
          instantRawSpeedDegS: 0,
          maxRawSpeedDegS: 0,
          poseSpanDeg: 0
        };
    var preUpright = Math.abs(captureTrackingPose.rollDeg || 0) <= MAX_ROLL_DEG;
    if (!preProjection.visible || preProjection.angleDeg > STABLE_ANGLE_DEG ||
        !preStability.stable || !preUpright) {
      this.stableSince = 0;
      this.setData({
        captureNeedsRetry: true,
        guideTitle: !preUpright
          ? "请先把手机扶正"
          : (!preStability.stable ? "请先保持不动" : "请把白点放回中央"),
        guideDetail: !preStability.stable
          ? "原始姿态需稳定至少 0.4 秒；显示平滑不参与判断"
          : "未满足质量门，本张不会计入"
      });
      return;
    }

    this.capturing = true;
    var attemptId = ++this.captureAttemptId;
    var shouldFinish = false;
    var operationToken = this.lifecycleToken;
    var requestedWallMs = Date.now();
    var requestedPoseTimeMs = this.lastTrackingAt || requestedWallMs;
    var requestedPose = P.copyBasis(captureTrackingPose);
    var captureFrame = null;
    this.beginShutterWindow(requestedPoseTimeMs, requestedPose);
    this.stableSince = 0;
    this.setData({
      busy: true,
      targetHidden: true,
      dwellDeg: 0,
      guideTitle: "正在拍摄第 " + (this.frames.length + 1) + " 张",
      guideDetail: "请保持方向；照片只在本机处理"
    });
    try {
      captureFrame = await this.collectCaptureFrame(requestedWallMs, requestedPoseTimeMs);
      if (!this.pageAlive || !this.pageVisible || operationToken !== this.lifecycleToken ||
          attemptId !== this.captureAttemptId) return;
      this.setData({
        guideTitle: "正在检查这一帧",
        guideDetail: "核对完整快门窗口、清晰度与曝光"
      });

      var basis = captureFrame.captureBasis;
      var decoded = captureFrame.decoded;
      var endPoseTimeMs = captureFrame.captureTimeMs;
      var shutterStats = captureFrame.shutterStats || this.poseWindowStats(
        this.captureBackend === "visionkit" ? requestedPoseTimeMs : requestedWallMs,
        endPoseTimeMs,
        requestedPose
      );
      var maxRawSpeed = shutterStats.maxRawSpeedDegS;
      if (shutterStats.sampleCount < 2) maxRawSpeed = Infinity;
      if (isFinite(preStability.instantRawSpeedDegS)) {
        maxRawSpeed = Math.max(maxRawSpeed, preStability.instantRawSpeedDegS);
      }
      var targetAngleDeg = P.angleDeg(target.dir, basis.F);
      var imageMetrics = typeof Quality.analyzeImage === "function"
        ? Quality.analyzeImage(decoded.data, decoded.width, decoded.height)
        : { sharpness: 100, lumaMean: 128, clippedRatio: 0 };
      var qualityInput = {
        maxRawSpeedDegS: maxRawSpeed,
        poseSpanDeg: shutterStats.poseSpanDeg,
        targetAngleDeg: targetAngleDeg,
        rollDeg: basis.rollDeg,
        shutterWindowMs: captureFrame.shutterWindowMs,
        sharpness: imageMetrics.sharpness,
        lumaMean: imageMetrics.lumaMean,
        clippedRatio: imageMetrics.clippedRatio
      };
      var quality = typeof Quality.classifyFrame === "function"
        ? Quality.classifyFrame(qualityInput)
        : {
            accepted: true,
            reasons: [],
            maxRawSpeedDegS: 0,
            poseSpanDeg: 0,
            targetAngleDeg: targetAngleDeg,
            rollDeg: Math.abs(Number(basis.rollDeg) || 0),
            shutterWindowMs: captureFrame.shutterWindowMs,
            sharpness: imageMetrics.sharpness,
            lumaMean: imageMetrics.lumaMean,
            clippedRatio: imageMetrics.clippedRatio
          };
      quality.backend = captureFrame.backend;
      quality.timestampNs = captureFrame.timestampNs;
      quality.fovXDeg = captureFrame.fovXDeg;
      quality.sampleCount = shutterStats.sampleCount;
      if (!quality.accepted) {
        if (captureFrame.ownedPath && captureFrame.path) {
          this.removeOwnedFramePath(captureFrame.path);
          captureFrame.path = null;
        }
        var rejected = new Error(quality.reasons[0] || "这一张没有通过质量检查");
        rejected.code = "FRAME_REJECTED";
        rejected.quality = quality;
        throw rejected;
      }

      this.setData({
        guideTitle: this.frames.length ? "正在做相邻照片视觉校正" : "正在建立第一张视觉锚点",
        guideDetail: "传感器只作初值；低置信对齐会要求重拍"
      });
      await delay(0);
      var visual = await this.refineCapturedFrame(
        decoded,
        {
          basis: P.copyBasis(basis),
          fovXDeg: captureFrame.fovXDeg || DEFAULT_CAPTURE_FOV_DEG,
          targetIndex: target.index
        },
        operationToken
      );
      var correctedBasis = visual.result.correctedBasis || basis;
      var correctedFovXDeg = visual.result.correctedFovXDeg ||
        captureFrame.fovXDeg || DEFAULT_CAPTURE_FOV_DEG;
      var exposureGain = visual.result.gain == null ? 1 : visual.result.gain;
      var exposureBias = visual.result.bias == null ? 0 : visual.result.bias;

      if (!captureFrame.path && captureFrame.backend === "visionkit") {
        captureFrame.path = await this.exportRgbaFrame(
          decoded.data,
          decoded.width,
          decoded.height
        );
        captureFrame.ownedPath = true;
        if (this.ownedFramePaths.indexOf(captureFrame.path) < 0) {
          this.ownedFramePaths.push(captureFrame.path);
        }
      }
      if (!this.pageAlive || !this.pageVisible || operationToken !== this.lifecycleToken ||
          attemptId !== this.captureAttemptId) return;
      this.capturePose = P.copyBasis(basis);
      var frameRecord = {
        path: captureFrame.path,
        basis: P.copyBasis(this.capturePose),
        correctedBasis: P.copyBasis(correctedBasis),
        targetIndex: target.index,
        yawDeg: target.yawDeg,
        pitchDeg: target.pitchDeg,
        fovXDeg: captureFrame.fovXDeg || DEFAULT_CAPTURE_FOV_DEG,
        correctedFovXDeg: correctedFovXDeg,
        gain: exposureGain,
        bias: exposureBias,
        timestampNs: captureFrame.timestampNs || 0,
        intrinsics: captureFrame.intrinsics,
        viewMatrix: captureFrame.viewMatrix,
        backend: captureFrame.backend,
        ownedPath: !!captureFrame.ownedPath,
        quality: quality,
        visual: {
          accepted: visual.result.accepted,
          confidence: visual.result.confidence,
          score: visual.result.score,
          overlapRatio: visual.result.overlapRatio,
          correction: visual.result.correction,
          referenceIndex: visual.result.referenceIndex,
          method: visual.result.method
        }
      };
      P.projectPatch(this.coarse, decoded.data, decoded.width, decoded.height, correctedBasis, {
        fovXDeg: correctedFovXDeg,
        feather: 0.2,
        gain: exposureGain,
        bias: exposureBias
      });
      this.frames.push(frameRecord);
      this.commitVisualRegistration(
        visual.registration,
        visual.result,
        this.frames.length - 1
      );
      decoded = null;
      this.targetIndex += 1;
      this.autoCaptureSuspended = false;
      this.updateCaptureState();
      this.setData({
        flashOn: false,
        captureNeedsRetry: false,
        diagnosticText: "已接收 · " + captureFrame.backend +
          " · 视觉置信 " + Math.round((visual.result.confidence || 0) * 100) + "%" +
          " · 修正 " + Math.sqrt(
            Math.pow(visual.result.correction && visual.result.correction.yawDeg || 0, 2) +
            Math.pow(visual.result.correction && visual.result.correction.pitchDeg || 0, 2)
          ).toFixed(2) + "°"
      });
      await delay(16);
      if (!this.pageAlive || !this.pageVisible || operationToken !== this.lifecycleToken) return;
      this.setData({ flashOn: true });
      var self = this;
      setTimeout(function () {
        if (self.pageAlive && self.pageVisible && operationToken === self.lifecycleToken) {
          self.setData({ flashOn: false });
        }
      }, 240);
      shouldFinish = this.targetIndex >= this.targets.length;
    } catch (error) {
      if (!this.pageAlive || !this.pageVisible || operationToken !== this.lifecycleToken ||
          attemptId !== this.captureAttemptId) return;
      console.error("[capture] take/project failed", error);
      this.activeShutterWindow = null;
      if (captureFrame && captureFrame.ownedPath && captureFrame.path) {
        this.removeOwnedFramePath(captureFrame.path);
        captureFrame.path = null;
      }
      this.autoCaptureSuspended = true;
      var timedOut = error && (
        error.code === "TAKE_PHOTO_TIMEOUT" ||
        error.code === "IMAGE_DECODE_TIMEOUT" ||
        error.code === "IMAGE_WRITE_TIMEOUT" ||
        error.code === "VK_CAPTURE_TIMEOUT" ||
        error.code === "RGBA_EXPORT_TIMEOUT"
      );
      if (error && error.code === "VK_CAPTURE_UNSUPPORTED") {
        this.blockReliableCapture(
          "当前微信无法从 VisionKit 同一帧导出照片。为避免错位，本次拍摄已停止。",
          error.code
        );
      }
      this.setData({
        captureNeedsRetry: true,
        guideTitle: error && (
          error.code === "FRAME_REJECTED" ||
          error.code === "VISUAL_REGISTRATION_REJECTED"
        )
          ? "这一张质量未通过"
          : (timedOut ? "这一张处理超时" : "这一张没有保存下来"),
        guideDetail: error && error.code === "FRAME_REJECTED"
          ? ((error.quality && error.quality.reasons || []).join("；") + "。请停稳后重拍")
          : (error && error.code === "VISUAL_REGISTRATION_REJECTED"
            ? error.message + "。请保持原位，对准同一白点重拍"
            : "本张未计入；请保持方向，点底部按钮重试"),
        diagnosticText: error && error.code === "FRAME_REJECTED"
          ? "拒收 · " + (error.quality.reasons || []).join(" / ")
          : (error && error.code === "VISUAL_REGISTRATION_REJECTED"
            ? "视觉拒收 · " + (
              error.visualResult && error.visualResult.rejectReason || "LOW_CONFIDENCE"
            )
            : this.data.diagnosticText)
      });
    } finally {
      if (attemptId === this.captureAttemptId) {
        this.capturing = false;
      }
      this.activeShutterWindow = null;
      if (this.pageAlive && operationToken === this.lifecycleToken &&
          attemptId === this.captureAttemptId) {
        var capturePage = this;
        this.setData({ busy: false, targetHidden: false }, function () {
          capturePage.updateTarget();
          capturePage.scheduleWorldPreview();
        });
      }
      if (shouldFinish && this.pageAlive && this.pageVisible &&
          operationToken === this.lifecycleToken && attemptId === this.captureAttemptId) {
        var self = this;
        setTimeout(function () { self.finishCapture(); }, 0);
      }
    }
  },

  updateCaptureState: function () {
    var stats = P.rasterStats(this.coarse);
    var count = this.frames.length;
    this.setData({
      capturedCount: count,
      coverageText: count
        ? "已覆盖约 " + Math.round(stats.coverage * 100) + "% · 黑色仍待拍"
        : "未拍区域保持黑色",
      canFinish: count >= MIN_FINISH_FRAMES
    });
  },

  scheduleWorldPreview: function () {
    if (!this.pageAlive || !this.pageVisible || this.data.phase !== "capture" ||
        this.data.busy || this.capturing || !this.frames.length) return;
    var self = this;
    var now = Date.now();
    if (this.previewTimer || now - this.previewLastAt < WORLD_PREVIEW_INTERVAL_MS) return;
    this.previewTimer = setTimeout(function () {
      self.previewTimer = null;
      if (!self.pageAlive || !self.pageVisible || self.data.phase !== "capture" ||
          self.data.busy || self.capturing || !self.frames.length) return;
      self.previewLastAt = Date.now();
      self.drawWorldPreview();
    }, 16);
  },

  drawWorldPreview: function () {
    if (!this.worldCtx || !this.worldCanvasNode || !this.coarse ||
        !this.pageAlive || !this.pageVisible || this.data.phase !== "capture" ||
        this.data.busy || this.capturing) return;
    if (!this.frames.length) {
      this.worldCtx.fillStyle = "#000";
      this.worldCtx.fillRect(
        0,
        0,
        this.worldCanvasNode.width,
        this.worldCanvasNode.height
      );
      return;
    }
    var raster = this.coarse;
    var w = this.worldCanvasNode.width;
    var h = this.worldCanvasNode.height;
    var output = this.worldCtx.createImageData(w, h);
    var cssWidth = this.worldCssWidth || 375;
    var cssHeight = this.worldCssHeight || 667;
    var viewport = this.liveViewport || {
      left: cssWidth * 0.14,
      top: (cssHeight - cssWidth * 0.96) / 2,
      width: cssWidth * 0.72,
      height: cssWidth * 0.96,
      centerX: cssWidth / 2,
      centerY: cssHeight / 2
    };
    var tanX = Math.tan(
      (this.currentFovXDeg || DEFAULT_CAPTURE_FOV_DEG) * Math.PI / 360
    );
    var tanY = tanX / Math.max(0.25, viewport.width / viewport.height);
    var displayPose = this.captureBackend === "visionkit"
      ? (this.trackingPose || this.displayPose || this.basis)
      : (this.displayPose || this.basis);
    var F = displayPose.F, U = displayPose.U, R = displayPose.R;
    var x, y;
    for (y = 0; y < h; y += 1) {
      var cssY = (y + 0.5) / h * cssHeight;
      var ny = (viewport.centerY - cssY) / (viewport.height / 2) * tanY;
      for (x = 0; x < w; x += 1) {
        var cssX = (x + 0.5) / w * cssWidth;
        var nx = (cssX - viewport.centerX) / (viewport.width / 2) * tanX;
        var dx = F[0] + R[0] * nx + U[0] * ny;
        var dy = F[1] + R[1] * nx + U[1] * ny;
        var dz = F[2] + R[2] * nx + U[2] * ny;
        var inv = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
        dx *= inv; dy *= inv; dz *= inv;
        var yaw = Math.atan2(dx, dy);
        if (yaw < 0) yaw += Math.PI * 2;
        var sx = Math.floor(yaw / (Math.PI * 2) * raster.width) % raster.width;
        var sy = P.clamp(Math.floor((0.5 - Math.asin(P.clamp(dz, -1, 1)) / Math.PI) * raster.height), 0, raster.height - 1);
        var si = (sy * raster.width + sx) * 4;
        var di = (y * w + x) * 4;
        output.data[di] = raster.pixels[si];
        output.data[di + 1] = raster.pixels[si + 1];
        output.data[di + 2] = raster.pixels[si + 2];
        output.data[di + 3] = 255;
      }
    }
    this.worldCtx.putImageData(output, 0, 0);
  },

  onUndo: async function () {
    if (!this.frames.length || this.data.busy || this.capturing) return;
    this.stableSince = 0;
    var operationToken = this.lifecycleToken;
    this.setData({ busy: true });
    var removedFrame = this.frames[this.frames.length - 1];
    var removedRegistration = (this.registrationFrames || [])[this.frames.length - 1];
    var remainingFrames = this.frames.slice(0, -1);
    var remainingRegistrationFrames = (this.registrationFrames || []).slice(0, -1);
    var remainingVisualEdges = (this.visualEdges || []).filter(function (edge) {
      return Number(edge.from) < remainingFrames.length &&
        Number(edge.to) < remainingFrames.length;
    });
    var rebuilt = P.createRaster(COARSE_WIDTH, COARSE_WIDTH / 2);
    var committed = false;
    try {
      for (var i = 0; i < remainingFrames.length; i += 1) {
        if (!this.pageAlive || !this.pageVisible || operationToken !== this.lifecycleToken) {
          throw new Error("页面进入后台，已取消撤销");
        }
        var decoded = await this.loadImageData(remainingFrames[i].path, 640);
        if (!this.pageAlive || !this.pageVisible || operationToken !== this.lifecycleToken) {
          throw new Error("页面进入后台，已取消撤销");
        }
        P.projectPatch(
          rebuilt,
          decoded.data,
          decoded.width,
          decoded.height,
          remainingFrames[i].optimizedBasis ||
            remainingFrames[i].correctedBasis ||
            remainingFrames[i].basis,
          {
            fovXDeg: remainingFrames[i].correctedFovXDeg ||
              remainingFrames[i].fovXDeg || DEFAULT_CAPTURE_FOV_DEG,
            feather: 0.2,
            gain: remainingFrames[i].gain,
            bias: remainingFrames[i].bias
          }
        );
        decoded = null;
        await delay(0);
      }
      if (!this.pageAlive || !this.pageVisible || operationToken !== this.lifecycleToken) {
        throw new Error("页面进入后台，已取消撤销");
      }
      // 全部重建成功后再原子交换，失败时原帧清单和粗球保持一致。
      this.frames = remainingFrames;
      this.registrationFrames = remainingRegistrationFrames;
      if (removedRegistration) removedRegistration.pixels = null;
      this.visualEdges = remainingVisualEdges;
      this.registrationBytes = typeof Registration.totalBytes === "function"
        ? Registration.totalBytes(this.registrationFrames)
        : 0;
      this.registrationReleased = this.registrationFrames.length > 0 &&
        !this.registrationFrames.some(function (frame) { return frame && frame.pixels; });
      this.targetIndex = remainingFrames.length;
      this.coarse = rebuilt;
      if (removedFrame && removedFrame.ownedPath) {
        this.removeOwnedFramePath(removedFrame.path);
      }
      committed = true;
      this.updateCaptureState();
    } catch (error) {
      if (!committed) releaseRaster(rebuilt, true);
      console.error("[capture] undo rebuild failed", error);
      if (this.pageAlive && this.pageVisible && operationToken === this.lifecycleToken) {
        wx.showToast({ title: "撤销失败，照片未变", icon: "none" });
      }
    } finally {
      if (this.pageAlive && operationToken === this.lifecycleToken) {
        var undoPage = this;
        this.setData({ busy: false }, function () {
          undoPage.drawWorldPreview();
          undoPage.updateTarget();
        });
      }
    }
  },

  onFinish: function () {
    this.finishCapture();
  },

  buildResultRaster: async function (width, maxSide, operationToken) {
    var raster = P.createRaster(width, width / 2);
    try {
      if (typeof P.projectPatchSeamAware !== "function") {
        throw new Error("接缝融合内核不可用");
      }
      var fovSummary = this.finalizeSessionFov();
      for (var i = 0; i < this.frames.length; i += 1) {
        if (!this.pageAlive || !this.pageVisible || operationToken !== this.lifecycleToken) {
          throw new Error("页面进入后台，已暂停生成");
        }
        var decoded = await this.loadImageData(this.frames[i].path, maxSide);
        P.projectPatchSeamAware(
          raster,
          decoded.data,
          decoded.width,
          decoded.height,
          this.frames[i].optimizedBasis ||
            this.frames[i].correctedBasis ||
            this.frames[i].basis,
          {
            fovXDeg: fovSummary.fovXDeg,
            feather: 0.2,
            gain: this.frames[i].gain,
            bias: this.frames[i].bias,
            bilinear: true,
            frameIndex: i,
            sourceConfidence: sourceConfidenceForFrame(this.frames[i]),
            // Same conservative shared-core mesh as H5. Rejected candidates
            // are byte-identical to the pre-warp compositor.
            localWarp: true,
            warpGridCols: 8,
            warpGridRows: 6
          }
        );
        decoded = null;
        var progress = Math.round((i + 1) / this.frames.length * 100);
        this.setData({
          progress: progress,
          processText: "正在处理第 " + (i + 1) + " / " + this.frames.length + " 张"
        });
        await delay(0);
      }
      var stats = P.rasterStats(raster);
      if (!stats.nonBlackPixels) throw new Error("2D 拼接结果为空");
      var seamSummary = raster.seamSummary || {};
      stats.seam = {
        frames: Number(seamSummary.frames) || 0,
        conflictPixels: Number(seamSummary.conflictPixels) || 0,
        hardSelectedPixels: Number(seamSummary.hardSelectedPixels) || 0,
        blendedPixels: Number(seamSummary.blendedPixels) || 0,
        localWarpAttempted: Number(seamSummary.localWarpAttempted) || 0,
        localWarpApplied: Number(seamSummary.localWarpApplied) || 0,
        localWarpFallbacks: Number(seamSummary.localWarpFallbacks) || 0,
        localWarpLastReason: seamSummary.localWarpLastReason || null,
        localWarp: raster.lastSeamStats &&
          raster.lastSeamStats.localWarp || null
      };
      stats.sessionFov = {
        method: fovSummary.method,
        fovXDeg: fovSummary.fovXDeg,
        inlierCount: fovSummary.inlierCount
      };
      return { raster: raster, stats: stats };
    } catch (error) {
      releaseRaster(raster, true);
      throw error;
    }
  },

  buildAndExportResult: async function (width, maxSide, operationToken) {
    var built = null;
    var succeeded = false;
    try {
      built = await this.buildResultRaster(width, maxSide, operationToken);
      if (!this.pageAlive || !this.pageVisible || operationToken !== this.lifecycleToken) {
        throw new Error("页面进入后台，已暂停生成");
      }
      if (this.resultCanvasFailed) throw new Error("结果画布同层渲染失败");
      var raster = built.raster;
      this.resultCanvasNode.width = raster.width;
      this.resultCanvasNode.height = raster.height;
      this.resultCtx = this.resultCanvasNode.getContext("2d");
      var imageData = this.resultCtx.createImageData(raster.width, raster.height);
      imageData.data.set(raster.pixels);
      this.resultCtx.putImageData(imageData, 0, 0);
      imageData = null;
      this.resultWidth = raster.width;
      this.resultHeight = raster.height;
      var tempPath = await this.exportResultCanvas();
      this.lastResultExportValidation = await this.validateExportedResult(
        tempPath,
        RESULT_VALIDATE_TIMEOUT_MS
      );
      succeeded = true;
      return {
        width: raster.width,
        height: raster.height,
        stats: built.stats,
        tempPath: tempPath
      };
    } finally {
      // Canvas already owns the copied pixels on success. On failure, also
      // shrink it so a standard-size partial result does not overlap the lite
      // retry in memory.
      if (built && built.raster) releaseRaster(built.raster, true);
      if (!succeeded && this.resultCanvasNode) {
        this.resultCanvasNode.width = 2;
        this.resultCanvasNode.height = 2;
        this.resultCtx = this.resultCanvasNode.getContext("2d");
      }
    }
  },

  finishCapture: async function () {
    if (this.data.busy || !this.frames.length) return;
    var operationToken = this.lifecycleToken;
    this.stopVisionKit();
    this.stopMotion();
    this.worldCanvasNode = null;
    this.worldCtx = null;
    this.resultCanvasFailed = false;
    this.lastResultExportValidation = null;
    await this.setDataAsync({
      busy: true,
      phase: "processing",
      worldCanvasMounted: false,
      resultCanvasMounted: true,
      viewerCanvasMounted: false,
      resultImagePath: "",
      cameraOn: false,
      cameraReady: false,
      orientationReady: false,
      progress: 0,
      processText: "准备稳定的 2D 等距柱状结果…"
    });
    try {
      this.setData({ processText: "正在汇总高置信视觉边与完整纬圈闭环…" });
      // Lock the whole session to one robust lens model before any final pose
      // optimization. Per-frame FOV estimates otherwise look like scale
      // breathing and can be mistaken for yaw correction at an overlap.
      this.finalizeSessionFov();
      var optimization = this.optimizeCapturedSequence();
      // Optimization has consumed all thumbnail pixels. Release them before
      // allocating the final panorama and result canvas; failed builds lazily
      // restore references from the retained photo paths on the next capture.
      var releasedRegistrationBytes = this.releaseRegistrationFrames();
      await this.ensureResultCanvas();
      var result;
      try {
        result = await this.buildAndExportResult(1024, 768, operationToken);
      } catch (firstError) {
        if (!this.pageAlive || !this.pageVisible || operationToken !== this.lifecycleToken) {
          throw firstError;
        }
        console.warn("[capture] standard stitch failed, retry lite", firstError);
        if (this.resultCanvasFailed) {
          this.resultCanvasNode = null;
          this.resultCtx = null;
          this.resultCanvasFailed = false;
          await this.setDataAsync({ resultCanvasMounted: false });
          await this.setDataAsync({ resultCanvasMounted: true });
          await this.ensureResultCanvas();
        }
        this.setData({
          progress: 0,
          processText: "标准结果没有完成，正在生成轻量版…"
        });
        result = await this.buildAndExportResult(768, 640, operationToken);
      }
      if (!this.pageAlive || !this.pageVisible || operationToken !== this.lifecycleToken) return;
      this.resultWidth = result.width;
      this.resultHeight = result.height;
      this.resultTempPath = result.tempPath;
      this.lastResultStats = result.stats;
      this.lastSeamSummary = result.stats.seam || null;
      // 结果 Canvas 已持有最终像素；缩小逐张解码画布。
      this.sourceCanvasNode.width = 2;
      this.sourceCanvasNode.height = 2;
      this.sourceCtx = this.sourceCanvasNode.getContext("2d");
      this.resultCanvasNode = null;
      this.resultCtx = null;
      this.setData({
        phase: "result",
        resultCanvasMounted: false,
        resultImagePath: result.tempPath,
        progress: 100,
        resultMeta: this.resultWidth + " × " + this.resultHeight +
          " · 覆盖约 " + Math.round(result.stats.coverage * 100) + "%" +
          (optimization
            ? " · 视觉边 " + optimization.acceptedEdges.length +
              " · 闭环 " + optimization.loops.length
            : ""),
        viewerActive: false,
        viewerMessage: "",
        diagnosticText: "最终 2D 已生成 · 视觉缩略图已释放 " +
          Math.round(releasedRegistrationBytes / 1024) + "KB" +
          (result.stats.seam
            ? " · 接缝冲突/单源 " +
              result.stats.seam.conflictPixels + "/" +
              result.stats.seam.hardSelectedPixels
            : "")
      });
    } catch (error) {
      console.error("[capture] stitch failed", error);
      if (this.pageAlive && this.pageVisible && operationToken === this.lifecycleToken) {
        this.setData({
          phase: "capture",
          worldCanvasMounted: true,
          resultCanvasMounted: false,
          guideTitle: "照片都已保留",
          guideDetail: "这次生成没有完成，可再次点“完成”重试"
        });
        this.resultCanvasNode = null;
        this.resultCtx = null;
        this.ensureWorldCanvas().catch(function (worldError) {
          console.warn("[capture] world canvas restore failed", worldError);
        });
      }
    } finally {
      if (this.pageAlive && operationToken === this.lifecycleToken) {
        this.setData({ busy: false });
      }
    }
  },

  cancelResultExport: function (message, code) {
    if (!this.activeResultExport || !this.activeResultExport.cancel) return;
    var error = new Error(message || "全景结果导出已取消");
    error.code = code || "RESULT_EXPORT_CANCELLED";
    this.activeResultExport.cancel(error);
  },

  validateExportedResult: async function (path, timeoutMs) {
    try {
      var decoded = await this.loadImageData(
        path,
        64,
        Math.max(100, Number(timeoutMs) || RESULT_VALIDATE_TIMEOUT_MS)
      );
      var pixels = decoded && decoded.data;
      var total = decoded ? decoded.width * decoded.height : 0;
      var nonBlack = 0;
      var lumaSum = 0;
      for (var i = 0; pixels && i < pixels.length; i += 4) {
        var sum = pixels[i] + pixels[i + 1] + pixels[i + 2];
        if (sum > 18) nonBlack += 1;
        lumaSum += sum / 3;
      }
      var required = Math.max(4, Math.floor(total * 0.002));
      if (!pixels || !total || nonBlack < required) {
        var blackError = new Error("全景结果文件为空或全黑");
        blackError.code = "RESULT_EXPORT_BLACK";
        throw blackError;
      }
      return {
        width: decoded.width,
        height: decoded.height,
        nonBlackPixels: nonBlack,
        nonBlackRatio: nonBlack / total,
        meanLuma: lumaSum / total
      };
    } catch (error) {
      if (path && wx.getFileSystemManager) {
        try { wx.getFileSystemManager().unlinkSync(path); } catch (ignored) {}
      }
      throw error;
    }
  },

  exportResultCanvas: function (timeoutMs) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = null;
      var exportJob = {
        cancel: function (error) {
          finish(reject, error || new Error("全景结果导出已取消"));
        }
      };
      function cleanupLatePath(value) {
        var path = value && value.tempFilePath;
        if (!path || !wx.getFileSystemManager) return;
        try { wx.getFileSystemManager().unlinkSync(path); } catch (ignored) {}
      }
      function finish(callback, value) {
        if (settled) {
          cleanupLatePath(value);
          return false;
        }
        settled = true;
        if (timer) clearTimeout(timer);
        if (self.activeResultExport === exportJob) self.activeResultExport = null;
        callback(value);
        return true;
      }
      try {
        if (!self.resultCanvasNode) {
          var unavailable = new Error("全景结果画布不可用");
          unavailable.code = "RESULT_EXPORT_CANVAS_UNAVAILABLE";
          throw unavailable;
        }
        self.activeResultExport = exportJob;
        timer = setTimeout(function () {
          var timeoutError = new Error("全景结果导出超时");
          timeoutError.code = "RESULT_EXPORT_TIMEOUT";
          finish(reject, timeoutError);
        }, Math.max(50, Number(timeoutMs) || RESULT_EXPORT_TIMEOUT_MS));
        wx.canvasToTempFilePath({
          canvas: self.resultCanvasNode,
          x: 0,
          y: 0,
          width: self.resultWidth || 1024,
          height: self.resultHeight || 512,
          destWidth: self.resultWidth || 1024,
          destHeight: self.resultHeight || 512,
          fileType: "jpg",
          quality: 0.88,
          success: function (result) {
            if (!result || !result.tempFilePath) {
              var noPath = new Error("全景结果画布没有返回文件路径");
              noPath.code = "RESULT_EXPORT_NO_PATH";
              finish(reject, noPath);
              return;
            }
            if (settled) {
              cleanupLatePath(result);
              return;
            }
            finish(resolve, result.tempFilePath);
          },
          fail: function (error) { finish(reject, error); }
        }, self);
      } catch (error) {
        finish(reject, error);
      }
    });
  },

  compileShader: function (gl, type, source) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      var message = gl.getShaderInfoLog(shader) || "shader compile failed";
      gl.deleteShader(shader);
      throw new Error(message);
    }
    return shader;
  },

  startViewer: async function (timeoutMs) {
    this.stopViewer(true);
    await this.ensureViewerCanvas();
    var self = this;
    return new Promise(function (resolve, reject) {
      var settled = false;
      var loadTimer = null;
      var state = null;
      function finish(callback, value) {
        if (settled) return false;
        settled = true;
        if (loadTimer) clearTimeout(loadTimer);
        if (state) state.cancelStart = null;
        callback(value);
        return true;
      }
      function fail(error) {
        if (!finish(reject, error)) return;
        self.stopViewer();
      }
      try {
        var generation = ++self.viewerGeneration;
        var canvas = self.viewerCanvasNode;
        var gl = canvas && canvas.getContext("webgl", { alpha: false, antialias: false });
        if (!gl || !canvas.createImage || !self.resultTempPath) throw new Error("WebGL 不可用");
        state = {
          generation: generation,
          canvas: canvas,
          gl: gl,
          vs: null,
          fs: null,
          program: null,
          buffer: null,
          texture: null,
          turn: null,
          yaw: 0,
          pitch: 0,
          touch: null,
          healthTimer: null,
          cancelStart: function (error) {
            fail(error || new Error("360° 查看已取消"));
          }
        };
        self.viewerState = state;
        var vs = self.compileShader(gl, gl.VERTEX_SHADER,
          "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}");
        state.vs = vs;
        var fs = self.compileShader(gl, gl.FRAGMENT_SHADER, [
          "precision mediump float;",
          "uniform sampler2D pano;uniform vec2 turn;uniform float aspect;uniform vec2 resolution;",
          "const float PI=3.14159265359;",
          "void main(){vec2 q=(gl_FragCoord.xy/resolution)*2.-1.;",
          "vec3 d=normalize(vec3(q.x*aspect*.82,q.y*.82,-1.));",
          "float cp=cos(turn.y),sp=sin(turn.y);d=vec3(d.x,d.y*cp-d.z*sp,d.y*sp+d.z*cp);",
          "float cy=cos(turn.x),sy=sin(turn.x);d=vec3(d.x*cy+d.z*sy,d.y,-d.x*sy+d.z*cy);",
          "float lon=atan(d.x,-d.z);float u=fract(lon/(2.*PI)+1.);",
          "float v=.5-asin(clamp(d.y,-1.,1.))/PI;gl_FragColor=texture2D(pano,vec2(u,v));}"
        ].join(""));
        state.fs = fs;
        var program = gl.createProgram();
        state.program = program;
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
        gl.useProgram(program);
        gl.viewport(0, 0, canvas.width, canvas.height);
        var buffer = gl.createBuffer();
        state.buffer = buffer;
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
        var pos = gl.getAttribLocation(program, "p");
        gl.enableVertexAttribArray(pos);
        gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
        gl.uniform1f(gl.getUniformLocation(program, "aspect"), canvas.width / canvas.height);
        gl.uniform2f(gl.getUniformLocation(program, "resolution"), canvas.width, canvas.height);
        var texture = gl.createTexture();
        state.texture = texture;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        // Lite output is 768×384 (NPOT). WebGL1 requires CLAMP_TO_EDGE for
        // NPOT textures; the shader already wraps longitude with fract().
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

        var image = canvas.createImage();
        loadTimer = setTimeout(function () {
          var timeoutError = new Error("360° 贴图加载超时");
          timeoutError.code = "VIEWER_IMAGE_TIMEOUT";
          fail(timeoutError);
        }, Math.max(50, Number(timeoutMs) || VIEWER_IMAGE_TIMEOUT_MS));
        image.onload = function () {
          if (settled) return;
          try {
            if (!self.pageAlive || !self.pageVisible || generation !== self.viewerGeneration ||
                self.viewerState !== state) {
              fail(new Error("360° 查看已取消"));
              return;
            }
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);
            if (gl.isContextLost && gl.isContextLost()) throw new Error("WebGL 上下文已中断");
            if (gl.getError() !== gl.NO_ERROR) throw new Error("360° 贴图内存不足");
            state.turn = gl.getUniformLocation(program, "turn");
            self.setData({ viewerActive: true, viewerMessage: "" });
            if (!self.renderViewer()) throw new Error("360° 首帧绘制失败");
            if (self.testMode && gl.readPixels) {
              var pixel = new Uint8Array(4);
              if (gl.finish) gl.finish();
              gl.readPixels(
                Math.floor(canvas.width / 2),
                Math.floor(canvas.height / 2),
                1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel
              );
              state.firstPixelNonBlack = pixel[0] + pixel[1] + pixel[2] > 18 && pixel[3] > 0;
              if (!state.firstPixelNonBlack || gl.getError() !== gl.NO_ERROR) {
                throw new Error("360° 首帧像素为空");
              }
            }
            self.monitorViewerContext();
            finish(resolve);
          } catch (error) {
            fail(error);
          }
        };
        image.onerror = function () {
          fail(new Error("360° 贴图加载失败"));
        };
        image.src = self.resultTempPath;
      } catch (error) {
        fail(error);
      }
    });
  },

  renderViewer: function () {
    var state = this.viewerState;
    if (!state || !this.viewerCanvasNode) return false;
    if (state.gl.isContextLost && state.gl.isContextLost()) {
      this.fallbackTo2D("360° 图形上下文已中断");
      return false;
    }
    state.gl.uniform2f(state.turn, state.yaw, state.pitch);
    state.gl.drawArrays(state.gl.TRIANGLE_STRIP, 0, 4);
    if (state.gl.getError() !== state.gl.NO_ERROR) {
      this.fallbackTo2D("360° 绘制内存不足");
      return false;
    }
    return true;
  },

  monitorViewerContext: function () {
    var self = this;
    var state = this.viewerState;
    if (!state) return;
    if (state.healthTimer) clearTimeout(state.healthTimer);
    state.healthTimer = setTimeout(function check() {
      if (!self.viewerState || self.viewerState !== state || !self.data.viewerActive) return;
      if (state.gl.isContextLost && state.gl.isContextLost()) {
        self.fallbackTo2D("360° 图形上下文已中断");
        return;
      }
      state.healthTimer = setTimeout(check, 1000);
    }, 1000);
  },

  stopViewer: function (keepCanvas) {
    this.viewerGeneration += 1;
    var state = this.viewerState;
    if (state && state.cancelStart) {
      var cancelStart = state.cancelStart;
      state.cancelStart = null;
      cancelStart(new Error("360° 查看已取消"));
      return;
    }
    if (state) {
      if (state.healthTimer) clearTimeout(state.healthTimer);
      try {
        if (state.texture) state.gl.deleteTexture(state.texture);
        if (state.buffer) state.gl.deleteBuffer(state.buffer);
        if (state.program) state.gl.deleteProgram(state.program);
        if (state.vs) state.gl.deleteShader(state.vs);
        if (state.fs) state.gl.deleteShader(state.fs);
      } catch (cleanupError) {
        console.warn("[capture] WebGL cleanup failed", cleanupError);
      }
    }
    this.viewerState = null;
    if (!keepCanvas) {
      this.viewerCanvasNode = null;
      if (this.pageAlive && this.data.viewerCanvasMounted) {
        this.setData({ viewerCanvasMounted: false });
      }
    }
  },

  fallbackTo2D: function (message) {
    this.stopViewer();
    this.setData({
      viewerActive: false,
      viewerStarting: false,
      viewerMessage: message ? message + "，已自动回到 2D 结果" : ""
    });
  },

  onToggleViewer: async function () {
    if (this.data.viewerStarting) return;
    if (this.data.viewerActive) {
      this.fallbackTo2D("");
      return;
    }
    this.setData({ viewerStarting: true });
    try {
      await this.startViewer();
    } catch (error) {
      console.warn("[capture] WebGL fallback", error);
      if (this.pageAlive && this.pageVisible) {
        this.fallbackTo2D((error && error.message) || "360° 查看启动失败");
      }
    } finally {
      if (this.pageAlive) this.setData({ viewerStarting: false });
    }
  },

  onWebGLContextLost: function () {
    this.fallbackTo2D("360° 图形上下文已中断");
  },

  onVKContextLost: function () {
    this.blockReliableCapture(
      "相机图形上下文已中断。照片仍保留；请返回上一页后重新进入全景拍摄。",
      "VK_WEBGL_CONTEXT_LOST"
    );
  },

  onNativeRenderError: function (event) {
    var id = event && event.currentTarget && event.currentTarget.id;
    var detail = event && event.detail;
    var runtime = {};
    try {
      var base = wx.getAppBaseInfo ? wx.getAppBaseInfo() : {};
      var device = wx.getDeviceInfo ? wx.getDeviceInfo() : {};
      runtime = {
        SDKVersion: base.SDKVersion || "",
        version: base.version || "",
        brand: device.brand || "",
        model: device.model || "",
        system: device.system || ""
      };
    } catch (ignored) {}
    console.warn("[capture] native component render error", id, detail, runtime);
    this.stableSince = 0;
    if (id === "viewerCanvas") {
      this.fallbackTo2D("360° 原生画布渲染失败");
      return;
    }
    if (id === "vkCameraCanvas") {
      this.blockReliableCapture(
        "相机原生画布已失效。照片仍保留；请返回上一页后重新进入全景拍摄。",
        "VK_CANVAS_RENDER_FAILED"
      );
      return;
    }
    if (id === "cameraView") {
      this.cancelCaptureAttempt();
      this.stopMotion();
      this.setData({
        cameraOn: false,
        cameraReady: false,
        orientationReady: false,
        busy: false,
        captureSessionStarted: false,
        guideTitle: "相机渲染失败",
        guideDetail: "请重新开启；若仍失败请换一台设备"
      });
      return;
    }
    if (id === "worldCanvas") {
      this.worldRenderFailures += 1;
      this.worldCanvasNode = null;
      this.worldCtx = null;
      if (this.data.phase === "capture" && this.worldRenderFailures <= 1) {
        var self = this;
        this.setData({ worldCanvasMounted: false }, function () {
          self.setData({ worldCanvasMounted: true }, function () {
            self.ensureWorldCanvas().catch(function (error) {
              console.warn("[capture] world canvas remount failed", error);
              self.setData({
                worldPreviewAvailable: false,
                guideTitle: "实时预览已降级",
                guideDetail: "照片仍会保存方向，完成后可生成 2D 全景"
              });
            });
          });
        });
      } else {
        this.setData({
          worldCanvasMounted: false,
          worldPreviewAvailable: false,
          guideTitle: "实时预览已降级",
          guideDetail: "照片仍会保存方向，完成后可生成 2D 全景"
        });
      }
      return;
    }
    if (id === "resultCanvas") {
      this.resultRenderFailures += 1;
      this.resultCanvasFailed = true;
      if (this.activeResultExport && this.activeResultExport.cancel) {
        var resultExportError = new Error("全景结果画布渲染失败");
        resultExportError.code = "RESULT_EXPORT_RENDER_FAILED";
        this.activeResultExport.cancel(resultExportError);
      }
      return;
    }
    if (id === "sourceCanvas") {
      if (this.activeRgbaExport && this.activeRgbaExport.cancel) {
        var exportError = new Error("照片处理画布渲染失败");
        exportError.code = "RGBA_EXPORT_RENDER_FAILED";
        this.activeRgbaExport.cancel(exportError);
      }
      this.sourceCanvasNode = null;
      this.sourceCtx = null;
      this.blockReliableCapture(
        "照片处理画布已中断。为避免拍完后卡住，请升级微信并重新进入。",
        "SOURCE_CANVAS_RENDER_FAILED"
      );
    }
  },

  onViewerTouchStart: function (event) {
    var touch = event.touches && event.touches[0];
    if (this.viewerState && touch) this.viewerState.touch = { x: touch.clientX, y: touch.clientY };
  },

  onViewerTouchMove: function (event) {
    var touch = event.touches && event.touches[0];
    var state = this.viewerState;
    if (!state || !state.touch || !touch) return;
    state.yaw += (touch.clientX - state.touch.x) * 0.006;
    state.pitch = P.clamp(state.pitch + (touch.clientY - state.touch.y) * 0.004, -1.35, 1.35);
    state.touch = { x: touch.clientX, y: touch.clientY };
    this.renderViewer();
  },

  onViewerTouchEnd: function () {
    if (this.viewerState) this.viewerState.touch = null;
  },

  cancelAlbumSave: function () {
    if (!this.activeAlbumSave || !this.activeAlbumSave.cancel) return;
    var error = new Error("保存全景已取消");
    error.code = "SAVE_ALBUM_CANCELLED";
    this.activeAlbumSave.cancel(error);
  },

  saveResultOnce: function (timeoutMs) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = null;
      var saveJob = {
        cancel: function (error) {
          finish(reject, error || new Error("保存全景已取消"));
        }
      };
      function finish(callback, value) {
        if (settled) return false;
        settled = true;
        if (timer) clearTimeout(timer);
        if (self.activeAlbumSave === saveJob) self.activeAlbumSave = null;
        callback(value);
        return true;
      }
      try {
        self.activeAlbumSave = saveJob;
        timer = setTimeout(function () {
          var timeoutError = new Error("保存到相册超时");
          timeoutError.code = "SAVE_ALBUM_TIMEOUT";
          finish(reject, timeoutError);
        }, Math.max(100, Number(timeoutMs) || SAVE_ALBUM_TIMEOUT_MS));
        wx.saveImageToPhotosAlbum({
          filePath: self.resultTempPath,
          success: function (result) { finish(resolve, result); },
          fail: function (error) { finish(reject, error); }
        });
      } catch (error) {
        finish(reject, error);
      }
    });
  },

  recoverAlbumPermission: function (timeoutMs) {
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        finish(false);
      }, Math.max(20, Number(timeoutMs) || PERMISSION_FLOW_TIMEOUT_MS));
      function finish(value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(!!value);
      }
      try {
        wx.showModal({
          title: "需要相册权限",
          content: "请在设置中允许“保存到相册”，再回来保存全景。",
          confirmText: "去设置",
          success: function (modal) {
            if (!modal.confirm) {
              finish(false);
              return;
            }
            try {
              wx.openSetting({
                success: function (setting) {
                  finish(!!(
                    setting &&
                    setting.authSetting &&
                    setting.authSetting["scope.writePhotosAlbum"]
                  ));
                },
                fail: function () { finish(false); }
              });
            } catch (error) {
              finish(false);
            }
          },
          fail: function () { finish(false); }
        });
      } catch (error) {
        finish(false);
      }
    });
  },

  onSaveResult: async function () {
    if (!this.resultTempPath) {
      wx.showToast({ title: "结果还没准备好", icon: "none" });
      return;
    }
    if (this.saving) return;
    this.saving = true;
    this.setData({ saving: true });
    try {
      await this.saveResultOnce();
      wx.showToast({ title: "已保存到相册", icon: "success" });
    } catch (error) {
      console.warn("[capture] save failed", error);
      if (!this.pageAlive || !this.pageVisible ||
          (error && error.code === "SAVE_ALBUM_CANCELLED")) return;
      var denied = /auth|authorize|permission|deny/i.test(String(error && error.errMsg || error));
      if (denied && await this.recoverAlbumPermission()) {
        try {
          await this.saveResultOnce();
          wx.showToast({ title: "已保存到相册", icon: "success" });
          return;
        } catch (retryError) {
          console.warn("[capture] save retry failed", retryError);
        }
      }
      wx.showToast({ title: "保存失败，请检查相册权限", icon: "none" });
    } finally {
      this.saving = false;
      if (this.pageAlive) this.setData({ saving: false });
    }
  },

  runSimulator: async function () {
    if (!this.testMode || this.testRunning) return;
    this.testRunning = true;
    var startedAt = Date.now();
    var operationToken = this.lifecycleToken;
    this.setData({ testStatus: "running", testCoverage: 0, testViewerNonBlack: null });
    try {
      for (var i = 0; i < this.testFrameCount; i += 1) {
        if (!this.pageAlive || operationToken !== this.lifecycleToken) {
          throw new Error("测试页面生命周期中断");
        }
        var target = this.targets[i];
        var basis = P.orthonormalBasis(target.dir, [0, 0, 1]);
        var decoded = await this.loadImageData(TEST_IMAGE_PATH, 320);
        this.frames.push({
          path: TEST_IMAGE_PATH,
          basis: basis,
          targetIndex: target.index,
          yawDeg: target.yawDeg,
          pitchDeg: target.pitchDeg,
          fovXDeg: DEFAULT_CAPTURE_FOV_DEG,
          backend: "simulator"
        });
        P.projectPatch(this.coarse, decoded.data, decoded.width, decoded.height, basis, {
          fovXDeg: DEFAULT_CAPTURE_FOV_DEG,
          feather: 0.2
        });
        decoded = null;
        this.targetIndex += 1;
        if (i % 4 === 3 || i === this.testFrameCount - 1) {
          this.updateCaptureState();
          this.trackingPose = basis;
          this.displayPose = basis;
          this.basis = basis;
          this.drawWorldPreview();
          await delay(0);
        }
      }
      await this.finishCapture();
      if (this.data.phase !== "result" || !this.resultTempPath ||
          !this.lastResultStats || !this.lastResultStats.nonBlackPixels ||
          !this.lastResultExportValidation ||
          !this.lastResultExportValidation.nonBlackPixels) {
        throw new Error("2D 结果未生成或为空");
      }
      if (this.testFrameCount >= 28 && this.lastResultStats.coverage < 0.99) {
        throw new Error("28 帧覆盖率不足");
      }
      var resultPath = this.resultTempPath;
      var info = await new Promise(function (resolve, reject) {
        var settled = false;
        var timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          var error = new Error("隐藏回归读取结果尺寸超时");
          error.code = "TEST_RESULT_INFO_TIMEOUT";
          reject(error);
        }, IMAGE_INFO_TIMEOUT_MS);
        function finish(callback, value) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          callback(value);
        }
        try {
          wx.getImageInfo({
            src: resultPath,
            success: function (value) { finish(resolve, value); },
            fail: function (error) { finish(reject, error); }
          });
        } catch (error) {
          finish(reject, error);
        }
      });
      if (!info || info.width < 700 || info.height < 350) {
        throw new Error("导出结果尺寸异常");
      }

      var viewerNonBlack = null;
      try {
        await this.setDataAsync({ viewerStarting: true });
        await this.startViewer();
        viewerNonBlack = !!(this.viewerState && this.viewerState.firstPixelNonBlack);
        if (!viewerNonBlack) throw new Error("WebGL 首帧没有非黑像素");
      } catch (viewerError) {
        console.warn("[capture:test] viewer fallback", viewerError);
        viewerNonBlack = false;
      }
      this.fallbackTo2D(viewerNonBlack ? "测试主动返回" : "测试确认回退");
      await delay(30);
      if (this.data.viewerActive || this.data.viewerCanvasMounted) {
        throw new Error("WebGL 回退后原生画布未卸载");
      }
      this.setData({
        testStatus: "passed",
        testCoverage: this.lastResultStats.coverage,
        testViewerNonBlack: viewerNonBlack,
        processText: "隐藏回归通过 · " + (Date.now() - startedAt) + "ms"
      });
    } catch (error) {
      console.error("[capture:test] failed", error);
      if (this.pageAlive) {
        this.setData({
          testStatus: "failed",
          processText: String(error && error.message || error)
        });
      }
    } finally {
      this.testRunning = false;
    }
  },

  onBackToCapture: function () {
    this.fallbackTo2D("");
    this.resultCanvasNode = null;
    this.resultCtx = null;
    var self = this;
    this.setData({
      phase: "capture",
      worldCanvasMounted: true,
      resultCanvasMounted: false,
      resultImagePath: "",
      guideTitle: "照片还保留在本次拍摄中",
      guideDetail: "可以撤销最后一张，或再次生成"
    }, function () {
      self.ensureWorldCanvas().then(function () {
        self.drawWorldPreview();
        self.updateTarget();
      }).catch(function (error) {
        console.warn("[capture] world canvas return failed", error);
      });
    });
  },

  onBack: function () {
    this.stopVisionKit();
    this.stopMotion();
    this.stopViewer();
    if (getCurrentPages().length > 1) {
      wx.navigateBack();
    } else {
      wx.reLaunch({ url: "/pages/index/index" });
    }
  },

  onHelp: function () {
    this.stableSince = 0;
    this.setData({ helpVisible: true, dwellDeg: 0 });
  },
  onCloseHelp: function () {
    this.stableSince = 0;
    this.setData({ helpVisible: false, dwellDeg: 0 });
  },
  noop: function () {}
});
