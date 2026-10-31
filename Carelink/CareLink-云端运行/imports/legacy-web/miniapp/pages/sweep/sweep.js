/*
 * UNSEEN 横向全景扫拍。
 *
 * 这是独立于球面多点拍摄的轻量路径：VisionKit 连续提供同帧 RGBA、
 * 姿态，pano-sweep-core 只挑中心条带关键帧并写入普通横向 2D 画布。
 * getCameraBuffer(width,height) 已按 VisionKit 的 aspect-fill 规则返回
 * 指定尺寸 RGBA；displayTransform 只用于预览纹理，不再拿它二次旋转
 * 或阻断 buffer。这里不上传、不调用球面投影，也不创建交互式查看器。
 */
"use strict";

var Sweep = require("../../utils/pano-sweep-core.js");
var VisionKit = require("../../utils/visionkit-capture.js");

var MIN_SPAN_DEG = 45;
var DEFAULT_SPAN_DEG = 120;
var MAX_SPAN_DEG = 180;
// VKFrame.getCameraBuffer() requires the width to be a multiple of 16.
// 352 keeps the portrait aspect close to 3:4 without the invalid 360px call
// that failed on physical Android WeChat at the first sweep frame.
var RGBA_WIDTH = 352;
var RGBA_HEIGHT = 480;
var FRAME_INTERVAL_MS = 70;
var FRAME_TIMEOUT_MS = 1800;
var RESULT_TIMEOUT_MS = 6000;
var RAD_TO_DEG = 180 / Math.PI;

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function finite(value, fallback) {
  value = Number(value);
  return isFinite(value) ? value : fallback;
}

function frameClockMs(snapshot, fallback) {
  return snapshot && snapshot.timestampNs > 0
    ? snapshot.timestampNs / 1000000
    : finite(snapshot && snapshot.receivedAtMs, fallback || Date.now());
}

function poseAngles(basis) {
  if (!basis || !basis.F) return null;
  return {
    yawDeg: Math.atan2(basis.F[0], basis.F[1]) * RAD_TO_DEG,
    pitchDeg: Math.asin(clamp(basis.F[2], -1, 1)) * RAD_TO_DEG,
    rollDeg: finite(basis.rollDeg, 0)
  };
}

function guideForReason(reason) {
  if (reason === "too_fast") return "慢一点，保持匀速扫动";
  if (reason === "reverse") return "不要回扫，继续刚才的方向";
  if (reason === "pitch_drift") return "保持中央横线，不要抬头或低头";
  if (reason === "roll") return "把手机扶正，保持地平线水平";
  if (reason === "locking_direction") return "继续向一侧移动，马上锁定方向";
  if (reason === "spacing") return "速度合适，继续平稳扫动";
  return "沿同一方向缓慢扫动";
}

Page({
  data: {
    navBarTop: 20,
    navBarHeight: 44,
    phase: "ready",
    cameraOn: false,
    cameraReady: false,
    supported: true,
    blockedMessage: "",
    targetSpanDeg: DEFAULT_SPAN_DEG,
    sweptDeg: 0,
    progress: 0,
    canFinish: false,
    scanning: false,
    busy: false,
    direction: "unknown",
    speedText: "等待扫动",
    levelText: "保持水平",
    levelOk: true,
    guideTitle: "先开启相机",
    guideDetail: "竖直握住手机，随后向左或向右匀速扫动",
    diagnosticText: "将读取同帧 RGBA 与相机姿态",
    resultImagePath: "",
    resultMeta: "",
    saving: false
  },

  onLoad: function (query) {
    var app = getApp();
    var nav = app.globalData.nav || {};
    var requested = parseFloat(query && (query.degrees || query.span));
    var span = clamp(
      isFinite(requested) ? requested : DEFAULT_SPAN_DEG,
      MIN_SPAN_DEG,
      MAX_SPAN_DEG
    );
    this.setData({
      navBarTop: nav.barTop != null
        ? nav.barTop
        : (app.globalData.statusBarHeight || 20),
      navBarHeight: nav.barHeight != null ? nav.barHeight : 44,
      targetSpanDeg: Math.round(span)
    });

    this.pageAlive = true;
    this.pageVisible = true;
    this.lifecycleToken = 1;
    this.captureGeneration = 1;
    this.visionKit = null;
    this.visionVersion = "";
    this.latestSnapshot = null;
    this.pendingFrame = null;
    this.nextFrameTimer = null;
    this.activeRgbaFrame = null;
    this.sweepSession = null;
    this.resultPixels = null;
    this.resultCanvas = null;
    this.resultWidth = 0;
    this.resultHeight = 0;
    this.exportJob = null;
    this.lastUiAt = 0;
    this.lastPoseSample = null;
    this.cameraStartAttempt = 0;
    this.cameraStartInFlight = false;
    this.resumeCameraOnShow = false;
    this.autoResumeScheduled = false;
    this.support = VisionKit.detectSupport(wx);
    if (!this.support.supported) {
      this.setData({
        supported: false,
        blockedMessage: this.support.message +
          "。横向扫拍不会静默退回异步相机，以免画面和姿态错帧。",
        guideTitle: "当前微信暂不支持可靠扫拍",
        guideDetail: "请升级微信后再试"
      });
    }
  },

  onShow: function () {
    this.pageVisible = true;
    if (!this.pageAlive || !this.resumeCameraOnShow ||
        this.autoResumeScheduled) return;
    this.resumeCameraOnShow = false;
    this.autoResumeScheduled = true;
    var self = this;
    var resume = function () {
      self.autoResumeScheduled = false;
      if (!self.pageAlive || !self.pageVisible || self.data.scanning ||
          self.visionKit) return;
      self.startVisionKit();
    };
    if (wx.nextTick) wx.nextTick(resume);
    else setTimeout(resume, 0);
  },

  onHide: function () {
    this.pageVisible = false;
    // The OS camera permission sheet can transiently hide a Mini Program.
    // Treating that as a real background transition destroyed the pending
    // VKSession and left the user on the visible "扫拍已取消" state forever.
    // Invalidate and release the old start attempt, then rebuild it onShow.
    var startingCamera = !this.data.scanning &&
      (this.cameraStartInFlight ||
       (this.data.cameraOn && !this.data.cameraReady && this.data.busy));
    if (startingCamera) {
      this.resumeCameraOnShow = true;
      this.lifecycleToken += 1;
      this.cameraStartAttempt += 1;
      this.cameraStartInFlight = false;
      this.stopVisionKit();
      this.setData({
        cameraOn: false,
        cameraReady: false,
        busy: false,
        guideTitle: "相机授权返回后继续",
        guideDetail: "回到小程序会自动恢复，不会取消扫拍",
        diagnosticText: "CAMERA_PERMISSION_ROUNDTRIP"
      });
      return;
    }
    this.lifecycleToken += 1;
    this.cancelSweep("页面进入后台，扫拍已取消");
  },

  onUnload: function () {
    this.pageAlive = false;
    this.pageVisible = false;
    this.resumeCameraOnShow = false;
    this.autoResumeScheduled = false;
    this.lifecycleToken += 1;
    this.cancelSweep("页面已退出");
    this.releaseResult();
  },

  queryCanvas: function (selector) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error("等待画布节点超时"));
      }, 900);
      try {
        self.createSelectorQuery()
          .select(selector)
          .fields({ node: true, size: true })
          .exec(function (items) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            var item = items && items[0];
            if (!item || !item.node) {
              reject(new Error("画布节点不可用: " + selector));
              return;
            }
            resolve(item);
          });
      } catch (error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
  },

  onPrimary: function () {
    if (this.data.busy || !this.data.supported) return;
    if (!this.data.cameraOn) {
      this.startVisionKit();
      return;
    }
    if (this.data.cameraReady && !this.data.scanning) {
      if (!this.data.levelOk) {
        this.setData({
          guideTitle: "先把手机扶正",
          guideDetail: "让中央横线贴近真实地平线后再开始"
        });
        return;
      }
      this.beginSweep();
    }
  },

  ensureCameraPermission: function () {
    if (!wx.getSetting || !wx.authorize) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      function requestPermission() {
        wx.authorize({
          scope: "scope.camera",
          success: resolve,
          fail: function (cause) {
            var error = new Error("请在微信设置中允许相机权限后重试");
            error.code = "CAMERA_PERMISSION_DENIED";
            error.cause = cause;
            reject(error);
          }
        });
      }
      wx.getSetting({
        success: function (result) {
          var settings = result && result.authSetting;
          if (settings && settings["scope.camera"] === true) {
            resolve();
            return;
          }
          requestPermission();
        },
        fail: requestPermission
      });
    });
  },

  startVisionKit: async function () {
    if (!this.pageAlive || !this.pageVisible || this.visionKit ||
        !this.support.supported) return;
    var token = this.lifecycleToken;
    var attempt = this.cameraStartAttempt + 1;
    this.cameraStartAttempt = attempt;
    this.cameraStartInFlight = true;
    var self = this;
    await new Promise(function (resolve) {
      self.setData({
        cameraOn: true,
        busy: true,
        guideTitle: "正在开启后摄",
        guideDetail: "首次使用请允许微信访问相机"
      }, resolve);
    });
    try {
      await this.ensureCameraPermission();
      if (!this.pageAlive || !this.pageVisible ||
          token !== this.lifecycleToken ||
          attempt !== this.cameraStartAttempt) return;
      var item = await this.queryCanvas("#vkSweepCanvas");
      if (!this.pageAlive || !this.pageVisible ||
          token !== this.lifecycleToken ||
          attempt !== this.cameraStartAttempt) return;
      var info = {};
      try {
        info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      } catch (ignored) {}
      this.visionKit = VisionKit.createAdapter({
        wxApi: wx,
        canvas: item.node,
        cssWidth: item.width || 360,
        cssHeight: item.height || 480,
        pixelRatio: finite(info.pixelRatio, 1),
        onReady: function (status) {
          if (!self.pageAlive || token !== self.lifecycleToken) return;
          self.visionVersion = status.version || "v1";
        },
        onFrame: function (snapshot) {
          self.onVisionFrame(snapshot, token);
        },
        onFatal: function (error) {
          if (!self.pageAlive || token !== self.lifecycleToken) return;
          self.failSweep(
            "相机帧已中断，请重新开启",
            (error && (error.code || error.message)) || "VK_FRAME_FAILED"
          );
        }
      });
      await this.visionKit.start();
      if (!this.pageAlive || !this.pageVisible ||
          token !== this.lifecycleToken ||
          attempt !== this.cameraStartAttempt) {
        this.stopVisionKit();
        return;
      }
      this.setData({
        busy: false,
        guideTitle: "等待同帧相机数据",
        guideDetail: "相机就绪后即可开始扫拍"
      });
    } catch (error) {
      if (this.pageAlive && token === this.lifecycleToken &&
          attempt === this.cameraStartAttempt) {
        this.failSweep(
          error && error.code === "CAMERA_PERMISSION_DENIED"
            ? error.message
            : "同帧相机没有启动成功，请检查微信相机权限",
          (error && (error.code || error.message)) || "VK_START_FAILED"
        );
      }
    } finally {
      if (attempt === this.cameraStartAttempt) {
        this.cameraStartInFlight = false;
      }
    }
  },

  onVisionFrame: function (snapshot, token) {
    if (!this.pageAlive || !this.pageVisible || token !== this.lifecycleToken ||
        !snapshot || !snapshot.basis) return;
    if (snapshot.hasRgbaCapture !== true) {
      this.failSweep(
        "当前微信版本不能读取连续相机画面，请升级微信后重试",
        "VK_RGBA_CAPTURE_UNAVAILABLE"
      );
      return;
    }
    this.latestSnapshot = snapshot;
    var pose = poseAngles(snapshot.basis);
    var levelOk = !!pose &&
      Math.abs(pose.pitchDeg) <= 10 &&
      Math.abs(pose.rollDeg) <= 12;
    if (!this.data.cameraReady) {
      this.setData({
        cameraReady: true,
        busy: false,
        guideTitle: levelOk ? "准备好了" : "先把手机扶正",
        guideDetail: levelOk
          ? "点“开始扫拍”，再向任意一侧匀速移动"
          : "让中央横线贴近真实地平线",
        diagnosticText: "VisionKit " + (this.visionVersion || "v1") +
          " · RGBA 同帧候选"
      });
    }
    var now = Date.now();
    if (now - this.lastUiAt >= 120) {
      var speed = this.estimatePoseSpeed(pose, frameClockMs(snapshot, now));
      this.lastUiAt = now;
      this.setData({
        levelOk: levelOk,
        levelText: levelOk
          ? "水平良好"
          : (Math.abs(pose.rollDeg) > 12 ? "请扶正手机" : "不要抬头低头"),
        speedText: this.data.scanning
          ? (speed > 24 ? "太快" : (speed < 3 ? "再移动一点" : "速度合适"))
          : "等待扫动"
      });
    }
  },

  estimatePoseSpeed: function (pose, timeMs) {
    if (!pose) return 0;
    var previous = this.lastPoseSample;
    this.lastPoseSample = { yawDeg: pose.yawDeg, timeMs: timeMs };
    if (!previous) return 0;
    var delta = Sweep.shortestDelta(previous.yawDeg, pose.yawDeg);
    return Math.abs(delta) * 1000 / Math.max(1, timeMs - previous.timeMs);
  },

  beginSweep: function () {
    if (!this.visionKit || !this.latestSnapshot || this.data.scanning) return;
    this.releaseSweepSession();
    this.sweepSession = Sweep.createSweepSession({
      targetSpanDeg: this.data.targetSpanDeg,
      minSpanDeg: MIN_SPAN_DEG,
      maxSpanDeg: MAX_SPAN_DEG,
      fovXDeg: clamp(finite(this.latestSnapshot.fovXDeg, 65), 45, 85),
      outputHeight: 512,
      maxOutputWidth: 2048,
      ownerMap: false
    });
    this.captureGeneration += 1;
    this.setData({
      scanning: true,
      sweptDeg: 0,
      progress: 0,
      canFinish: false,
      direction: "unknown",
      guideTitle: "向左或向右开始扫动",
      guideDetail: "方向锁定后不要回扫；建议 8–20°/秒",
      diagnosticText: "VisionKit RGBA · 16px 对齐 352×480"
    });
    this.requestNextRgba(this.captureGeneration);
  },

  requestNextRgba: function (generation) {
    var self = this;
    if (!this.pageAlive || !this.pageVisible || !this.data.scanning ||
        !this.visionKit || generation !== this.captureGeneration ||
        this.pendingFrame) return;
    var request;
    try {
      request = this.visionKit.captureNextFrame({
        preferRgba: true,
        rgbaOnly: true,
        rgbaWidth: RGBA_WIDTH,
        rgbaHeight: RGBA_HEIGHT,
        timeoutMs: FRAME_TIMEOUT_MS
      });
    } catch (error) {
      this.failSweep("读取连续相机帧失败", error.code || error.message);
      return;
    }
    this.pendingFrame = request;
    request.then(function (payload) {
      if (self.pendingFrame === request) self.pendingFrame = null;
      if (!self.pageAlive || !self.pageVisible || !self.data.scanning ||
          generation !== self.captureGeneration) return;
      self.consumeRgbaFrame(payload, generation);
    }).catch(function (error) {
      if (self.pendingFrame === request) self.pendingFrame = null;
      if (!self.pageAlive || !self.pageVisible || !self.data.scanning ||
          generation !== self.captureGeneration) return;
      self.failSweep(
        error && error.code === "VK_CAPTURE_TIMEOUT"
          ? "等待同帧 RGBA 超时，请重新开始"
          : "连续相机帧已中断，请重新开始",
        (error && (error.code || error.message)) || "VK_SWEEP_CAPTURE_FAILED"
      );
    });
  },

  consumeRgbaFrame: function (payload, generation) {
    if (!payload || payload.kind !== "rgba" || !payload.buffer ||
        !payload.snapshot || !payload.snapshot.basis) {
      this.failSweep("当前帧不是可验证的同帧 RGBA", "VK_SWEEP_RGBA_INVALID");
      return;
    }
    var pose = poseAngles(payload.snapshot.basis);
    if (!pose) {
      this.failSweep("当前帧没有可靠姿态", "VK_SWEEP_POSE_MISSING");
      return;
    }

    // Do not retain a second caller-side RGBA frame. During ingest the core
    // owns at most its previous and current keyframe, then immediately commits
    // and releases the previous one.
    this.activeRgbaFrame = payload;
    var decision;
    try {
      decision = Sweep.ingestFrame(this.sweepSession, {
        rgba: new Uint8ClampedArray(payload.buffer),
        width: payload.width,
        height: payload.height,
        timeMs: frameClockMs(payload.snapshot, payload.acquiredAtMs),
        yawDeg: pose.yawDeg,
        pitchDeg: pose.pitchDeg,
        rollDeg: pose.rollDeg
      });
    } catch (error) {
      this.activeRgbaFrame = null;
      this.failSweep(
        "横向拼接内核处理失败",
        (error && (error.code || error.message)) || "SWEEP_INGEST_FAILED"
      );
      return;
    }
    this.activeRgbaFrame = null;
    this.applySweepDecision(decision || {});
    if (!this.data.scanning || generation !== this.captureGeneration) return;
    if (decision && decision.reason === "target_reached") {
      this.finishSweep();
      return;
    }
    var self = this;
    if (this.nextFrameTimer) clearTimeout(this.nextFrameTimer);
    this.nextFrameTimer = setTimeout(function () {
      self.nextFrameTimer = null;
      self.requestNextRgba(generation);
    }, FRAME_INTERVAL_MS);
  },

  applySweepDecision: function (decision) {
    var swept = clamp(finite(decision.progressDeg, this.data.sweptDeg), 0, MAX_SPAN_DEG);
    var direction = decision.direction > 0
      ? "right"
      : (decision.direction < 0 ? "left" : this.data.direction);
    this.setData({
      sweptDeg: Math.round(swept),
      progress: Math.round(clamp(
        swept / Math.max(MIN_SPAN_DEG, this.data.targetSpanDeg) * 100,
        0,
        100
      )),
      canFinish: swept >= MIN_SPAN_DEG,
      direction: direction,
      guideTitle: guideForReason(decision.reason),
      guideDetail: swept >= MIN_SPAN_DEG
        ? "已达到最短范围，可完成；继续可扫到 " + this.data.targetSpanDeg + "°"
        : "至少扫满 " + MIN_SPAN_DEG + "° 才能生成"
    });
    if (finite(decision.retainedFrames, 0) > 2) {
      this.failSweep("扫拍内存门失败：保留帧超过 2", "SWEEP_FRAME_BUDGET_EXCEEDED");
    }
  },

  onFinish: function () {
    if (!this.data.canFinish || this.data.busy) return;
    this.finishSweep();
  },

  finishSweep: async function () {
    if (!this.sweepSession || this.data.busy) return;
    this.captureGeneration += 1;
    this.setData({
      busy: true,
      scanning: false,
      phase: "processing",
      guideTitle: "正在生成横向全景"
    });
    this.stopVisionKit();
    var result;
    try {
      result = Sweep.finalizeSweep(this.sweepSession);
      if (!result || !result.ok || !result.pixels) {
        throw new Error(result && result.reason === "too_short"
          ? "至少需要扫满 " + MIN_SPAN_DEG + "°"
          : "横向结果存在空洞，请重新匀速扫拍");
      }
      this.resultPixels = result.pixels;
      this.resultWidth = result.width;
      this.resultHeight = result.height;
      // Detach output before releasing the core session; releaseSweepSession
      // deliberately nulls every session-owned large allocation.
      result.pixels = null;
      if (result.ownerMap) result.ownerMap = null;
      this.releaseSweepSession();
      await this.mountAndExportResult(result);
    } catch (error) {
      this.releaseSweepSession();
      this.resultPixels = null;
      if (this.pageAlive) {
        this.setData({
          phase: "ready",
          cameraOn: false,
          cameraReady: false,
          scanning: false,
          busy: false,
          guideTitle: "这次没有生成成功",
          guideDetail: error.message || "请重新匀速扫拍"
        });
      }
    }
  },

  mountAndExportResult: function (metadata) {
    var self = this;
    return new Promise(function (resolve, reject) {
      self.setData({
        phase: "result",
        cameraOn: false,
        cameraReady: false,
        resultMeta: Math.round(metadata.centerSpanDeg || self.data.sweptDeg) +
          "° · " + self.resultWidth + "×" + self.resultHeight
      }, function () {
        self.renderResultCanvas().then(function (path) {
          if (!self.pageAlive) {
            resolve(path);
            return;
          }
          self.setData({
            resultImagePath: path,
            busy: false,
            diagnosticText: "普通 2D 横向临时文件 · 未上传"
          });
          resolve(path);
        }).catch(reject);
      });
    });
  },

  renderResultCanvas: async function () {
    var item = await this.queryCanvas("#sweepResultCanvas");
    var canvas = item.node;
    canvas.width = this.resultWidth;
    canvas.height = this.resultHeight;
    var context = canvas.getContext("2d");
    if (!context || typeof context.createImageData !== "function") {
      throw new Error("2D 结果画布不可用");
    }
    var imageData = context.createImageData(this.resultWidth, this.resultHeight);
    imageData.data.set(this.resultPixels);
    context.putImageData(imageData, 0, 0);
    this.resultCanvas = canvas;
    this.resultPixels = null;
    return this.exportResultCanvas();
  },

  exportResultCanvas: function () {
    var self = this;
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        finish(reject, new Error("横向结果导出超时"));
      }, RESULT_TIMEOUT_MS);
      var job = {
        cancel: function () {
          finish(reject, new Error("横向结果导出已取消"));
        }
      };
      self.exportJob = job;
      function finish(callback, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (self.exportJob === job) self.exportJob = null;
        callback(value);
      }
      try {
        wx.canvasToTempFilePath({
          canvas: self.resultCanvas,
          x: 0,
          y: 0,
          width: self.resultWidth,
          height: self.resultHeight,
          destWidth: self.resultWidth,
          destHeight: self.resultHeight,
          fileType: "jpg",
          quality: 0.9,
          success: function (result) {
            if (!result || !result.tempFilePath) {
              finish(reject, new Error("横向画布没有返回临时文件"));
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

  onSave: function () {
    var self = this;
    if (!this.data.resultImagePath || this.data.saving) return;
    this.setData({ saving: true });
    wx.saveImageToPhotosAlbum({
      filePath: this.data.resultImagePath,
      success: function () {
        if (self.pageAlive) {
          self.setData({ saving: false });
          wx.showToast({ title: "已保存到相册", icon: "success" });
        }
      },
      fail: function () {
        if (self.pageAlive) {
          self.setData({ saving: false });
          wx.showToast({ title: "保存失败，请检查相册权限", icon: "none" });
        }
      }
    });
  },

  onRetry: function () {
    this.releaseResult();
    this.resumeCameraOnShow = false;
    this.cameraStartInFlight = false;
    this.setData({
      phase: "ready",
      cameraOn: false,
      cameraReady: false,
      scanning: false,
      busy: false,
      sweptDeg: 0,
      progress: 0,
      canFinish: false,
      direction: "unknown",
      resultImagePath: "",
      guideTitle: "先开启相机",
      guideDetail: "竖直握住手机，随后向左或向右匀速扫动"
    });
  },

  failSweep: function (message, code) {
    this.captureGeneration += 1;
    this.resumeCameraOnShow = false;
    this.cameraStartInFlight = false;
    this.stopVisionKit();
    this.releaseSweepSession();
    this.activeRgbaFrame = null;
    if (this.pageAlive) {
      this.setData({
        phase: "ready",
        cameraOn: false,
        cameraReady: false,
        scanning: false,
        busy: false,
        canFinish: false,
        guideTitle: "扫拍已停止",
        guideDetail: message,
        diagnosticText: String(code || "SWEEP_FAILED")
      });
    }
  },

  cancelSweep: function (message) {
    this.captureGeneration += 1;
    this.resumeCameraOnShow = false;
    this.cameraStartInFlight = false;
    this.stopVisionKit();
    this.releaseSweepSession();
    this.activeRgbaFrame = null;
    if (this.exportJob && this.exportJob.cancel) this.exportJob.cancel();
    this.exportJob = null;
    if (this.pageAlive) {
      this.setData({
        phase: "ready",
        cameraOn: false,
        cameraReady: false,
        scanning: false,
        busy: false,
        canFinish: false,
        guideTitle: "扫拍已取消",
        guideDetail: message || "可重新开始"
      });
    }
  },

  stopVisionKit: function () {
    var adapter = this.visionKit;
    this.visionKit = null;
    this.pendingFrame = null;
    if (this.nextFrameTimer) {
      clearTimeout(this.nextFrameTimer);
      this.nextFrameTimer = null;
    }
    if (adapter && typeof adapter.stop === "function") {
      try { adapter.stop(); } catch (ignored) {}
    }
    this.latestSnapshot = null;
    this.lastPoseSample = null;
  },

  releaseSweepSession: function () {
    if (this.sweepSession) {
      Sweep.releaseSweepSession(this.sweepSession);
      this.sweepSession = null;
    }
  },

  releaseResult: function () {
    this.resultPixels = null;
    this.resultCanvas = null;
    this.resultWidth = 0;
    this.resultHeight = 0;
  },

  onBack: function () {
    this.cancelSweep("用户返回");
    wx.navigateBack();
  },

  noop: function () {}
});

module.exports = {
  poseAngles: poseAngles
};
