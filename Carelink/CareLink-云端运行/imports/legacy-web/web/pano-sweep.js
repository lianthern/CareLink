(function () {
  "use strict";

  var P = window.PanoCore;
  var R = window.PanoCaptureRuntime;
  var S = window.PanoSweepCore;
  var params = new URLSearchParams(location.search);
  var testMode = params.get("__sweep_test") === "1";
  var testScenario = params.get("scenario") || "steady-ltr";
  var testSeed = parseInt(params.get("seed") || "701", 10) || 701;
  var diagnosticMode = testMode || params.get("__sweep_diag") === "1";
  var BUILD_ID = "web-horizontal-sweep-v13-20260731";
  var MIN_SWEEP_DEG = 45;
  var AUTO_FINISH_DEG = 120;
  var DIRECTION_LOCK_DEG = 5;
  var FAST_LIMIT_DEG_S = 24;
  var PITCH_LIMIT_DEG = 7;
  var ROLL_LIMIT_DEG = 7;
  var BACKTRACK_TOLERANCE_DEG = 2.2;
  var FRAME_INTERVAL_MS = 96;
  var FRAME_FOV_X_DEG = 50;
  var JPEG_TIMEOUT_MS = testMode && testScenario === "jpeg-timeout"
    ? 180
    : 4500;

  var el = {
    captureStage: document.getElementById("captureStage"),
    processStage: document.getElementById("processStage"),
    resultStage: document.getElementById("resultStage"),
    video: document.getElementById("cameraVideo"),
    cameraEmpty: document.getElementById("cameraEmpty"),
    statusTitle: document.getElementById("statusTitle"),
    statusDetail: document.getElementById("statusDetail"),
    ribbonCanvas: document.getElementById("ribbonCanvas"),
    ribbonEmpty: document.getElementById("ribbonEmpty"),
    ribbonProgress: document.getElementById("ribbonProgress"),
    sweepGuide: document.getElementById("sweepGuide"),
    guideCursor: document.getElementById("guideCursor"),
    guideArrow: document.getElementById("guideArrow"),
    angleValue: document.getElementById("angleValue"),
    speedValue: document.getElementById("speedValue"),
    levelValue: document.getElementById("levelValue"),
    notice: document.getElementById("captureNotice"),
    noticeTitle: document.getElementById("noticeTitle"),
    noticeDetail: document.getElementById("noticeDetail"),
    cancel: document.getElementById("cancelButton"),
    sweep: document.getElementById("sweepButton"),
    finish: document.getElementById("finishButton"),
    processText: document.getElementById("processText"),
    resultCanvas: document.getElementById("resultCanvas"),
    resultMeta: document.getElementById("resultMeta"),
    resultAngle: document.getElementById("resultAngle"),
    resultDetail: document.getElementById("resultDetail"),
    restart: document.getElementById("restartButton"),
    download: document.getElementById("downloadButton"),
    back: document.getElementById("backButton"),
    help: document.getElementById("helpButton"),
    helpDialog: document.getElementById("helpDialog"),
    helpClose: document.getElementById("helpClose"),
    testReport: document.getElementById("testReport"),
    diagnosticPanel: document.getElementById("diagnosticPanel")
  };

  var state = {
    stage: "capture",
    stream: null,
    cameraReady: false,
    starting: false,
    sweeping: false,
    processing: false,
    generation: 0,
    core: null,
    poseTimeline: R && R.PoseTimeline
      ? new R.PoseTimeline({ maxAgeMs: 2600, maxSamples: 220 })
      : null,
    basis: null,
    poseReady: false,
    rawYawDeg: 0,
    continuousYawDeg: 0,
    lastRawYawDeg: null,
    lastPoseTimeMs: 0,
    startContinuousYawDeg: 0,
    startPitchDeg: 0,
    startRollDeg: 0,
    pitchOffsetDeg: 0,
    rollOffsetDeg: 0,
    signedAngleDeg: 0,
    progressDeg: 0,
    maxProgressDeg: 0,
    direction: 0,
    speedDegS: 0,
    instantaneousSpeedDegS: 0,
    gateReason: "",
    rvfcId: 0,
    rafId: 0,
    lastFallbackFrameAt: 0,
    lastIngestAt: 0,
    ingestPending: false,
    lastThumbnail: null,
    frameCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    rejectReasons: {},
    pauseCounts: {
      tooFast: 0,
      backtrack: 0,
      pitch: 0,
      roll: 0,
      sensor: 0
    },
    ribbonFrames: 0,
    exportUrl: "",
    resultBlob: null,
    resultStats: null,
    uploadAttempted: false,
    getUserMediaCalls: 0,
    autoFinishing: false,
    releasedSessions: 0,
    restartCount: 0
  };

  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
  }

  function nowMs() {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  }

  function nextFrame() {
    return new Promise(function (resolve) { requestAnimationFrame(resolve); });
  }

  function setStage(name) {
    state.stage = name;
    el.captureStage.hidden = name !== "capture";
    el.processStage.hidden = name !== "process";
    el.resultStage.hidden = name !== "result";
    document.body.dataset.stage = name;
  }

  function portraitReady() {
    return innerHeight >= innerWidth;
  }

  function screenAngle() {
    var reported = screen.orientation && typeof screen.orientation.angle === "number"
      ? screen.orientation.angle
      : (typeof window.orientation === "number" ? window.orientation : 0);
    var normalized = ((Number(reported) || 0) % 360 + 360) % 360;
    if (portraitReady() && (normalized === 90 || normalized === 270)) return 0;
    return normalized;
  }

  function eventTime(event) {
    var now = nowMs();
    var stamp = Number(event && event.timeStamp);
    return Number.isFinite(stamp) && stamp >= now - 10000 && stamp <= now + 1000
      ? stamp
      : now;
  }

  function signedNumber(value, digits) {
    var amount = Number(value) || 0;
    return (amount > 0 ? "+" : "") + amount.toFixed(digits == null ? 1 : digits);
  }

  function createCoreSession() {
    if (!S || typeof S.createSweepSession !== "function") {
      throw new Error("横向拼接内核没有加载");
    }
    return S.createSweepSession({
      targetSpanDeg: AUTO_FINISH_DEG,
      minSpanDeg: MIN_SWEEP_DEG,
      maxSpanDeg: 180,
      fovXDeg: FRAME_FOV_X_DEG,
      keyframeStepDeg: 6,
      maxSpeedDegPerSec: FAST_LIMIT_DEG_S,
      maxPitchDriftDeg: PITCH_LIMIT_DEG,
      maxRollDeg: ROLL_LIMIT_DEG,
      thumbnailWidth: 96,
      outputHeight: 512,
      maxOutputWidth: 2048,
      ownerMap: true,
      directionLockDeg: DIRECTION_LOCK_DEG,
      diagnostics: true
    });
  }

  function releaseCore() {
    if (!state.core) return;
    if (S && typeof S.releaseSweepSession === "function") {
      S.releaseSweepSession(state.core);
    }
    state.core = null;
    state.lastThumbnail = null;
    state.releasedSessions += 1;
  }

  function clearExport() {
    if (state.exportUrl) {
      URL.revokeObjectURL(state.exportUrl);
      state.exportUrl = "";
    }
    state.resultBlob = null;
    el.download.removeAttribute("href");
    el.download.setAttribute("aria-disabled", "true");
    el.download.setAttribute("tabindex", "-1");
  }

  function enableExport(url) {
    el.download.href = url;
    el.download.removeAttribute("aria-disabled");
    el.download.removeAttribute("tabindex");
  }

  function clearRibbon() {
    var canvas = el.ribbonCanvas;
    canvas.width = 720;
    canvas.height = 160;
    var context = canvas.getContext("2d");
    context.fillStyle = "#080808";
    context.fillRect(0, 0, canvas.width, canvas.height);
    el.ribbonProgress.style.width = "0%";
    el.ribbonProgress.style.left = "0";
    el.captureStage.classList.remove("has-ribbon");
    el.ribbonCanvas.parentNode.classList.remove("has-content");
    state.ribbonFrames = 0;
  }

  function resetSweepState(keepCamera) {
    stopFramePump();
    releaseCore();
    clearExport();
    state.sweeping = false;
    state.processing = false;
    state.autoFinishing = false;
    state.direction = 0;
    state.signedAngleDeg = 0;
    state.progressDeg = 0;
    state.maxProgressDeg = 0;
    state.speedDegS = 0;
    state.instantaneousSpeedDegS = 0;
    state.pitchOffsetDeg = 0;
    state.rollOffsetDeg = 0;
    state.gateReason = "";
    state.frameCount = 0;
    state.acceptedCount = 0;
    state.rejectedCount = 0;
    state.rejectReasons = {};
    state.pauseCounts = { tooFast: 0, backtrack: 0, pitch: 0, roll: 0, sensor: 0 };
    state.lastIngestAt = 0;
    state.ingestPending = false;
    state.lastThumbnail = null;
    state.resultStats = null;
    if (!keepCamera) stopCamera();
    clearRibbon();
    el.resultCanvas.width = 1;
    el.resultCanvas.height = 1;
    el.sweep.classList.remove("is-recording");
    el.sweep.querySelector("span").textContent = "开始";
    el.sweepGuide.classList.remove("is-paused", "is-rtl");
    el.guideArrow.textContent = "→";
    el.guideCursor.style.top = "50%";
    el.cancel.disabled = true;
    el.finish.disabled = true;
    updateUi();
  }

  function headingPitch(basis) {
    var point = P.yawPitchFromDirection(basis.F);
    return {
      headingDeg: P.headingDeg(basis),
      pitchDeg: point.pitchDeg,
      rollDeg: Number(basis.rollDeg) || 0
    };
  }

  function updatePoseFromBasis(basis, timeMs, allowAutoFinish) {
    var pose = headingPitch(basis);
    var time = Number(timeMs) || nowMs();
    if (state.lastRawYawDeg === null) {
      state.lastRawYawDeg = pose.headingDeg;
      state.continuousYawDeg = pose.headingDeg;
      state.instantaneousSpeedDegS = 0;
      state.speedDegS = 0;
    } else {
      var yawStep = P.shortestDelta(state.lastRawYawDeg, pose.headingDeg);
      var deltaTime = Math.max(8, time - state.lastPoseTimeMs);
      state.continuousYawDeg += yawStep;
      state.instantaneousSpeedDegS = Math.abs(yawStep) * 1000 / deltaTime;
      state.speedDegS = state.speedDegS * 0.58 + state.instantaneousSpeedDegS * 0.42;
      state.lastRawYawDeg = pose.headingDeg;
    }
    state.lastPoseTimeMs = time;
    state.rawYawDeg = pose.headingDeg;
    state.basis = P.copyBasis(basis);
    state.poseReady = true;
    if (state.poseTimeline) state.poseTimeline.push(time, basis, "horizontal-sweep");

    if (state.sweeping) {
      state.signedAngleDeg = state.continuousYawDeg - state.startContinuousYawDeg;
      state.pitchOffsetDeg = pose.pitchDeg - state.startPitchDeg;
      state.rollOffsetDeg = pose.rollDeg;
      if (!state.direction && Math.abs(state.signedAngleDeg) >= DIRECTION_LOCK_DEG) {
        state.direction = state.signedAngleDeg >= 0 ? 1 : -1;
        el.sweepGuide.classList.toggle("is-rtl", state.direction < 0);
        el.guideArrow.textContent = state.direction < 0 ? "←" : "→";
      }
      state.progressDeg = state.direction
        ? Math.max(0, state.direction * state.signedAngleDeg)
        : Math.abs(state.signedAngleDeg);
      state.maxProgressDeg = Math.max(state.maxProgressDeg, state.progressDeg);
      updateGate();
      if (allowAutoFinish !== false && state.direction &&
          state.progressDeg >= AUTO_FINISH_DEG && !state.autoFinishing) {
        state.autoFinishing = true;
        /*
         * The orientation event normally arrives just before the matching
         * presented video frame. Give requestVideoFrameCallback one short
         * turn to ingest that final 120° frame before committing the raster.
         */
        setTimeout(function () {
          if (state.sweeping && state.autoFinishing) finishSweep("auto");
        }, 160);
      }
    }
    updateUi();
  }

  function onOrientation(event) {
    if (typeof event.alpha !== "number" ||
        typeof event.beta !== "number" ||
        typeof event.gamma !== "number") return;
    updatePoseFromBasis(
      P.basisFromDeviceOrientation(
        event.alpha,
        event.beta,
        event.gamma,
        screenAngle()
      ),
      eventTime(event),
      true
    );
  }

  async function requestMotionPermission(generation) {
    if (typeof DeviceOrientationEvent === "undefined") {
      throw new Error("浏览器没有提供方向传感器");
    }
    if (typeof DeviceOrientationEvent.requestPermission === "function") {
      var answer = await DeviceOrientationEvent.requestPermission();
      if (answer !== "granted") throw new Error("动作与方向权限未开启");
    }
    if (generation !== state.generation || document.hidden) return false;
    window.removeEventListener("deviceorientation", onOrientation, true);
    window.addEventListener("deviceorientation", onOrientation, true);
    return true;
  }

  function waitForVideo() {
    return new Promise(function (resolve, reject) {
      var timeout = setTimeout(function () {
        reject(new Error("等待相机画面超时"));
      }, 6000);
      function ready() {
        if (!el.video.videoWidth || !el.video.videoHeight) return;
        clearTimeout(timeout);
        el.video.removeEventListener("loadedmetadata", ready);
        resolve();
      }
      el.video.addEventListener("loadedmetadata", ready);
      ready();
    });
  }

  async function openCameraAndSensors() {
    if (testMode) return true;
    if (!portraitReady()) throw new Error("请把手机转回竖屏");
    if (state.cameraReady && state.poseReady) return true;
    if (state.starting) return false;
    var generation = ++state.generation;
    state.starting = true;
    updateUi();
    try {
      var motionPromise = requestMotionPermission(generation);
      if (!navigator.mediaDevices ||
          typeof navigator.mediaDevices.getUserMedia !== "function") {
        throw new Error(location.protocol === "https:"
          ? "浏览器不支持相机"
          : "相机需要 HTTPS 页面");
      }
      state.getUserMediaCalls += 1;
      var streamPromise = navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 960 },
          aspectRatio: { ideal: 4 / 3 },
          frameRate: { ideal: 30, max: 30 }
        }
      });
      var results = await Promise.all([motionPromise, streamPromise]);
      var stream = results[1];
      if (generation !== state.generation || document.hidden || !portraitReady()) {
        stream.getTracks().forEach(function (track) { track.stop(); });
        return false;
      }
      state.stream = stream;
      el.video.srcObject = stream;
      await el.video.play();
      await waitForVideo();
      if (generation !== state.generation || document.hidden) {
        stream.getTracks().forEach(function (track) { track.stop(); });
        return false;
      }
      state.cameraReady = true;
      el.captureStage.classList.add("is-ready");
      var poseDeadline = Date.now() + 1600;
      while (!state.poseReady && Date.now() < poseDeadline) {
        await new Promise(function (resolve) { setTimeout(resolve, 25); });
      }
      if (!state.poseReady) throw new Error("没有收到方向传感器数据");
      return true;
    } finally {
      if (generation === state.generation) state.starting = false;
      updateUi();
    }
  }

  function stopCamera() {
    state.generation += 1;
    state.starting = false;
    stopFramePump();
    window.removeEventListener("deviceorientation", onOrientation, true);
    if (state.stream) {
      state.stream.getTracks().forEach(function (track) { track.stop(); });
      state.stream = null;
    }
    el.video.srcObject = null;
    state.cameraReady = false;
    state.poseReady = false;
    state.basis = null;
    state.lastRawYawDeg = null;
    if (state.poseTimeline) state.poseTimeline.clear();
    el.captureStage.classList.remove("is-ready");
  }

  function updateGate() {
    var reason = "";
    if (!state.poseReady || nowMs() - state.lastPoseTimeMs > 650) {
      reason = "sensor";
    } else if (Math.abs(state.pitchOffsetDeg) > PITCH_LIMIT_DEG) {
      reason = "pitch";
    } else if (Math.abs(state.rollOffsetDeg) > ROLL_LIMIT_DEG) {
      reason = "roll";
    } else if (state.direction &&
               state.progressDeg < state.maxProgressDeg - BACKTRACK_TOLERANCE_DEG) {
      reason = "backtrack";
    } else if (state.speedDegS > FAST_LIMIT_DEG_S) {
      reason = "tooFast";
    }
    if (reason && reason !== state.gateReason && state.pauseCounts[reason] != null) {
      state.pauseCounts[reason] += 1;
    }
    state.gateReason = reason;
    el.sweepGuide.classList.toggle("is-paused", !!reason);
    return !reason;
  }

  function updateUi() {
    var progress = Math.max(0, state.progressDeg);
    var deviation = Math.max(Math.abs(state.pitchOffsetDeg), Math.abs(state.rollOffsetDeg));
    el.angleValue.textContent = Math.round(progress) + "°";
    el.speedValue.textContent = Math.round(state.speedDegS) + "°/s";
    el.levelValue.textContent = signedNumber(
      Math.abs(state.pitchOffsetDeg) >= Math.abs(state.rollOffsetDeg)
        ? state.pitchOffsetDeg
        : state.rollOffsetDeg,
      1
    ) + "°";
    el.ribbonProgress.style.width = clamp(progress / AUTO_FINISH_DEG * 100, 0, 100) + "%";
    el.guideCursor.style.top = clamp(50 + state.pitchOffsetDeg * 3.4, 6, 94) + "%";
    el.cancel.disabled = !state.sweeping && !state.acceptedCount;
    el.finish.disabled = !state.sweeping || progress < MIN_SWEEP_DEG;

    el.notice.classList.toggle("is-alert", !!state.gateReason);
    if (state.starting) {
      el.statusTitle.textContent = "正在开启相机";
      el.statusDetail.textContent = "请允许相机和动作与方向权限";
      el.noticeTitle.textContent = "保持手机竖直";
      el.noticeDetail.textContent = "权限完成后会直接开始横扫";
    } else if (!state.sweeping) {
      el.statusTitle.textContent = state.cameraReady ? "可以开始" : "准备横扫";
      el.statusDetail.textContent = "只挑选关键帧，不录制和上传视频";
      el.noticeTitle.textContent = "保持手机竖直";
      el.noticeDetail.textContent = "前 4–6° 会自动锁定左右方向";
    } else if (state.gateReason === "tooFast") {
      el.statusTitle.textContent = "已暂停取帧";
      el.statusDetail.textContent = "速度降下来后自动继续";
      el.noticeTitle.textContent = "转得太快";
      el.noticeDetail.textContent = "放慢到约 6–18°/秒";
    } else if (state.gateReason === "backtrack") {
      el.statusTitle.textContent = "已暂停取帧";
      el.statusDetail.textContent = "回到最远位置后自动继续";
      el.noticeTitle.textContent = "方向反了";
      el.noticeDetail.textContent = "请继续沿箭头方向横扫";
    } else if (state.gateReason === "pitch") {
      el.statusTitle.textContent = "已暂停取帧";
      el.statusDetail.textContent = "圆点回到水平线后自动继续";
      el.noticeTitle.textContent = "镜头偏离水平线";
      el.noticeDetail.textContent = "不要向上或向下抬手机";
    } else if (state.gateReason === "roll") {
      el.statusTitle.textContent = "已暂停取帧";
      el.statusDetail.textContent = "扶正手机后自动继续";
      el.noticeTitle.textContent = "手机歪斜";
      el.noticeDetail.textContent = "让手机两侧保持竖直";
    } else if (state.gateReason === "sensor") {
      el.statusTitle.textContent = "等待方向数据";
      el.statusDetail.textContent = "收到新姿态后自动继续";
      el.noticeTitle.textContent = "方向传感器暂时中断";
      el.noticeDetail.textContent = "轻轻转动手机";
    } else if (!state.direction) {
      el.statusTitle.textContent = "正在判断方向";
      el.statusDetail.textContent = "继续向左或向右转动约 5°";
      el.noticeTitle.textContent = "选择一个方向";
      el.noticeDetail.textContent = "锁定后请一直沿同一方向横扫";
    } else {
      el.statusTitle.textContent = "正在横扫 · " + state.acceptedCount + " 个关键帧";
      el.statusDetail.textContent = progress >= MIN_SWEEP_DEG
        ? "现在可以完成，扫到 120° 会自动结束"
        : "至少扫到 45° 才能完成";
      el.noticeTitle.textContent = "沿箭头缓慢转动";
      el.noticeDetail.textContent = deviation > 4
        ? "让圆点回到中央水平线"
        : "速度稳定，继续保持";
    }
  }

  function captureCanvasFromVideo() {
    var sourceWidth = el.video.videoWidth;
    var sourceHeight = el.video.videoHeight;
    if (!sourceWidth || !sourceHeight) throw new Error("相机还没有画面");
    var crop = P.centerCropRect(sourceWidth, sourceHeight, 3 / 4);
    var memory = Number(navigator.deviceMemory) || 4;
    var maxSide = memory <= 4 ? 640 : 800;
    var scale = Math.min(1, maxSide / Math.max(crop.width, crop.height));
    var canvas = document.createElement("canvas");
    canvas.width = Math.max(96, Math.round(crop.width * scale));
    canvas.height = Math.max(128, Math.round(crop.height * scale));
    var context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("关键帧画布不可用");
    context.drawImage(
      el.video,
      crop.x, crop.y, crop.width, crop.height,
      0, 0, canvas.width, canvas.height
    );
    return canvas;
  }

  function makeThumbnail(imageData) {
    if (!S || typeof S.makeLumaThumbnail !== "function") return null;
    return S.makeLumaThumbnail(
      imageData.data,
      imageData.width,
      imageData.height,
      { width: 96, height: 128 }
    );
  }

  function estimateFlow(previous, current) {
    if (!previous || !current || !S ||
        typeof S.estimateGridFlow !== "function") return null;
    return S.estimateGridFlow(previous, current, {
      gridX: 9,
      gridY: 7,
      searchRadius: 12,
      patchRadius: 3
    });
  }

  function normalizeIngestResult(result) {
    if (result === false) return { accepted: false, reason: "selector" };
    if (result === true || result == null) return { accepted: true };
    return {
      accepted: result.accepted !== false &&
        result.status !== "rejected" &&
        result.status !== "skipped",
      reason: result.reason || result.rejectReason || result.status || "",
      raw: result
    };
  }

  function drawRibbonFrame(sourceCanvas) {
    var canvas = el.ribbonCanvas;
    var context = canvas.getContext("2d");
    var x01 = clamp(state.progressDeg / AUTO_FINISH_DEG, 0, 1);
    var destinationX = Math.round(x01 * (canvas.width - 10));
    var sourceWidth = Math.max(6, Math.round(sourceCanvas.width * 0.045));
    var sourceX = Math.round((sourceCanvas.width - sourceWidth) / 2);
    var destinationWidth = state.ribbonFrames ? 14 : 24;
    if (!state.ribbonFrames) {
      context.fillStyle = "#080808";
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.drawImage(
      sourceCanvas,
      sourceX, 0, sourceWidth, sourceCanvas.height,
      destinationX, 0, destinationWidth, canvas.height
    );
    state.ribbonFrames += 1;
    el.ribbonCanvas.parentNode.classList.add("has-content");
  }

  async function ingestCanvas(canvas, poseTimeMs, syntheticMeta) {
    if (!state.core || state.ingestPending) return null;
    state.ingestPending = true;
    try {
      var context = canvas.getContext("2d", { willReadFrequently: true });
      var imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      var thumbnail = makeThumbnail(imageData);
      var flow = estimateFlow(state.lastThumbnail, thumbnail);
      /*
       * A presented video frame can lag the newest DeviceOrientation event.
       * Map the frame timestamp back into the pose timeline; projecting with
       * the latest basis instead creates a repeatable strip offset while the
       * user is turning.
       */
      var mappedPose = state.poseTimeline
        ? state.poseTimeline.at(poseTimeMs, 420)
        : null;
      var frameBasis = mappedPose && mappedPose.basis
        ? mappedPose.basis
        : (state.poseTimeline ? null : state.basis);
      if (!frameBasis) throw new Error("当前视频帧没有可匹配的方向姿态");
      var currentPose = headingPitch(frameBasis);
      var pose = {
        timeMs: Number(poseTimeMs) || nowMs(),
        width: imageData.width,
        height: imageData.height,
        rgba: imageData.data,
        pixels: imageData.data,
        imageData: imageData,
        lumaThumbnail: thumbnail,
        thumbnail: thumbnail,
        flow: flow,
        visualDx: flow ? flow.dx : undefined,
        visualDy: flow ? flow.dy : undefined,
        confidence: flow ? flow.confidence : undefined,
        basis: P.copyBasis(frameBasis),
        yawDeg: currentPose.headingDeg,
        headingDeg: currentPose.headingDeg,
        signedAngleDeg: state.signedAngleDeg,
        sweepAngleDeg: state.progressDeg,
        direction: state.direction,
        /*
         * Projection needs the absolute gravity-aligned pose. The offsets are
         * only UI/gating values; using them here makes the pixels contradict
         * the camera ray whenever the scan starts slightly tilted.
         */
        pitchDeg: currentPose.pitchDeg,
        rollDeg: currentPose.rollDeg,
        angularSpeedDegS: state.speedDegS,
        fovXDeg: FRAME_FOV_X_DEG,
        synthetic: syntheticMeta || null
      };
      var result = await Promise.resolve(S.ingestFrame(state.core, pose));
      var normalized = normalizeIngestResult(result);
      state.frameCount += 1;
      state.lastThumbnail = thumbnail;
      if (normalized.accepted) {
        state.acceptedCount += 1;
        drawRibbonFrame(canvas);
      } else {
        state.rejectedCount += 1;
        var reason = normalized.reason || "selector";
        state.rejectReasons[reason] = (state.rejectReasons[reason] || 0) + 1;
      }
      updateUi();
      return normalized;
    } finally {
      state.ingestPending = false;
    }
  }

  async function onPresentedFrame(timeMs) {
    if (!state.sweeping || state.processing || state.ingestPending) return;
    if (timeMs - state.lastIngestAt < FRAME_INTERVAL_MS) return;
    state.lastIngestAt = timeMs;
    if (!updateGate()) return;
    try {
      await ingestCanvas(captureCanvasFromVideo(), timeMs, null);
    } catch (error) {
      var poseMismatch = error &&
        error.message === "当前视频帧没有可匹配的方向姿态";
      if (!poseMismatch) console.warn("[pano-sweep] frame skipped", error);
      state.rejectedCount += 1;
      var rejectKey = poseMismatch ? "pose" : "draw";
      state.rejectReasons[rejectKey] =
        (state.rejectReasons[rejectKey] || 0) + 1;
    }
  }

  function startFramePump() {
    stopFramePump();
    if (typeof el.video.requestVideoFrameCallback === "function") {
      function videoTick(time, metadata) {
        state.rvfcId = 0;
        if (!state.sweeping) return;
        var framePose = R && typeof R.framePoseTime === "function"
          ? R.framePoseTime(time, metadata)
          : null;
        onPresentedFrame(framePose ? framePose.timeMs : time);
        state.rvfcId = el.video.requestVideoFrameCallback(videoTick);
      }
      state.rvfcId = el.video.requestVideoFrameCallback(videoTick);
      return;
    }
    function animationTick(time) {
      state.rafId = 0;
      if (!state.sweeping) return;
      if (time - state.lastFallbackFrameAt >= FRAME_INTERVAL_MS) {
        state.lastFallbackFrameAt = time;
        onPresentedFrame(time);
      }
      state.rafId = requestAnimationFrame(animationTick);
    }
    state.rafId = requestAnimationFrame(animationTick);
  }

  function stopFramePump() {
    if (state.rvfcId && typeof el.video.cancelVideoFrameCallback === "function") {
      el.video.cancelVideoFrameCallback(state.rvfcId);
    }
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.rvfcId = 0;
    state.rafId = 0;
  }

  function beginSweepSession() {
    releaseCore();
    state.core = createCoreSession();
    state.sweeping = true;
    state.processing = false;
    state.autoFinishing = false;
    state.direction = 0;
    state.signedAngleDeg = 0;
    state.progressDeg = 0;
    state.maxProgressDeg = 0;
    state.startContinuousYawDeg = state.continuousYawDeg;
    var pose = headingPitch(state.basis);
    state.startPitchDeg = pose.pitchDeg;
    state.startRollDeg = pose.rollDeg;
    state.pitchOffsetDeg = 0;
    state.rollOffsetDeg = pose.rollDeg;
    state.speedDegS = 0;
    state.instantaneousSpeedDegS = 0;
    state.gateReason = "";
    state.frameCount = 0;
    state.acceptedCount = 0;
    state.rejectedCount = 0;
    state.rejectReasons = {};
    state.pauseCounts = { tooFast: 0, backtrack: 0, pitch: 0, roll: 0, sensor: 0 };
    state.lastIngestAt = 0;
    state.lastThumbnail = null;
    clearRibbon();
    el.sweep.classList.add("is-recording");
    el.sweep.querySelector("span").textContent = "";
    el.cancel.disabled = false;
    if (!testMode) startFramePump();
    updateUi();
  }

  async function handleSweepButton() {
    if (state.processing || state.starting) return;
    if (state.sweeping) {
      await finishSweep("manual");
      return;
    }
    try {
      await openCameraAndSensors();
      if (!state.cameraReady || !state.poseReady) return;
      var initialPose = headingPitch(state.basis);
      if (Math.abs(initialPose.rollDeg) > ROLL_LIMIT_DEG) {
        el.notice.classList.add("is-alert");
        el.noticeTitle.textContent = "先把手机扶正";
        el.noticeDetail.textContent = "让中央横线贴近真实地平线后再开始";
        return;
      }
      beginSweepSession();
    } catch (error) {
      console.error("[pano-sweep] start failed", error);
      stopCamera();
      el.statusTitle.textContent = "没有开始拍摄";
      el.statusDetail.textContent = (error && error.message) || "请检查相机与方向权限";
      el.notice.classList.add("is-alert");
      el.noticeTitle.textContent = "需要相机和方向权限";
      el.noticeDetail.textContent = "允许后再次点击开始";
    }
  }

  function rasterDescriptor(value) {
    if (!value) return null;
    if (value.canvas && value.canvas.width) {
      return { canvas: value.canvas, width: value.canvas.width, height: value.canvas.height };
    }
    if (typeof HTMLCanvasElement !== "undefined" && value instanceof HTMLCanvasElement) {
      return { canvas: value, width: value.width, height: value.height };
    }
    if (value.imageData && value.imageData.data) {
      return {
        data: value.imageData.data,
        width: value.imageData.width,
        height: value.imageData.height
      };
    }
    var source = value.raster || value.panorama || value.output || value;
    var data = source.rgba || source.pixels || source.data;
    var width = Number(source.width || value.width);
    var height = Number(source.height || value.height);
    if (data && width > 0 && height > 0) {
      return { data: data, width: width, height: height };
    }
    return null;
  }

  function drawFinalResult(result) {
    var descriptor = rasterDescriptor(result) ||
      rasterDescriptor(state.core && state.core.result) ||
      rasterDescriptor(state.core && state.core.output);
    if (!descriptor) throw new Error("拼接内核没有返回可见画面");
    el.resultCanvas.width = descriptor.width;
    el.resultCanvas.height = descriptor.height;
    var context = el.resultCanvas.getContext("2d");
    if (!context) throw new Error("结果画布不可用");
    if (descriptor.canvas) {
      context.drawImage(descriptor.canvas, 0, 0);
    } else {
      var pixels = descriptor.data instanceof Uint8ClampedArray
        ? descriptor.data
        : new Uint8ClampedArray(descriptor.data);
      context.putImageData(
        new ImageData(pixels, descriptor.width, descriptor.height),
        0,
        0
      );
    }
    var stats = result &&
      (result.diagnostics || result.stats || result.metrics) || {};
    state.resultStats = {
      width: descriptor.width,
      height: descriptor.height,
      acceptedFrames: Number(
        result && (result.acceptedFrames || result.keyframeCount)
      ) || state.acceptedCount,
      coverageDeg: Number(result && (
        result.centerSpanDeg ||
        result.coverageDeg ||
        result.sweepAngleDeg
      )) || state.progressDeg,
      coverageRatio: Number(result && result.coverage) || 0,
      internalBlackColumns: Number(
        result && result.internalBlackColumns
      ) || 0,
      seamLumaJumpP95: Number(
        stats.seamLumaJumpP95 ||
        stats.seamMeanError ||
        stats.meanSeamError
      ) || 0,
      estimatedFovXDeg: Number(stats.estimatedFovXDeg) || 0,
      fovCandidateCount: Number(stats.fovCandidateCount) || 0,
      contentAwareSeams: Number(stats.contentAwareSeams) || 0,
      seamMaxOffsetDeg: Number(stats.seamMaxOffsetDeg) || 0,
      ownedSeamLumaP50: Number(stats.ownedSeamLumaP50) || 0,
      ownedSeamLumaP95: Number(stats.ownedSeamLumaP95) || 0,
      ownedSeamSamples: Number(stats.ownedSeamSamples) || 0,
      maxRetainedFrames: Number(stats.maxRetainedFrames) || 0,
      nonBlack: canvasNonBlack(el.resultCanvas)
    };
    return state.resultStats;
  }

  function canvasNonBlack(canvas) {
    if (!canvas.width || !canvas.height) return false;
    var context = canvas.getContext("2d", { willReadFrequently: true });
    var width = Math.min(80, canvas.width);
    var height = Math.min(50, canvas.height);
    var probe = document.createElement("canvas");
    probe.width = width;
    probe.height = height;
    var probeContext = probe.getContext("2d", { willReadFrequently: true });
    probeContext.drawImage(canvas, 0, 0, width, height);
    var pixels = probeContext.getImageData(0, 0, width, height).data;
    var colored = 0;
    for (var index = 0; index < pixels.length; index += 4) {
      if (pixels[index] + pixels[index + 1] + pixels[index + 2] > 30 &&
          pixels[index + 3] > 0) colored += 1;
    }
    return colored >= width * height * 0.12;
  }

  function canvasBlob(canvas, type, quality, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        finish(reject, new Error("JPEG 编码超时"));
      }, Math.max(100, Number(timeoutMs) || JPEG_TIMEOUT_MS));
      function finish(callback, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      }
      try {
        canvas.toBlob(function (blob) {
          if (blob) finish(resolve, blob);
          else finish(reject, new Error("JPEG 编码失败"));
        }, type || "image/jpeg", quality == null ? 0.9 : quality);
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  async function finishSweep(source) {
    if (!state.sweeping || state.processing) return false;
    if (state.progressDeg < MIN_SWEEP_DEG) {
      state.autoFinishing = false;
      el.notice.classList.add("is-alert");
      el.noticeTitle.textContent = "至少横扫 45°";
      el.noticeDetail.textContent = "当前只有 " + Math.round(state.progressDeg) + "°，请继续沿箭头方向";
      return false;
    }
    state.processing = true;
    state.sweeping = false;
    stopFramePump();
    setStage("process");
    try {
      await nextFrame();
      var result = await Promise.resolve(S.finalizeSweep(state.core, {
        jpegQuality: 0.9,
        maxOutputWidth: (Number(navigator.deviceMemory) || 4) <= 4 ? 4096 : 6144
      }));
      if (!result || result.ok === false) {
        throw new Error(result && result.reason === "too_short"
          ? "至少需要横扫 " + Math.round(result.requiredDeg || MIN_SWEEP_DEG) + "°"
          : "横向全景没有形成连续画面");
      }
      var stats = drawFinalResult(result);
      clearExport();
      el.resultAngle.textContent = "已覆盖 " + Math.round(stats.coverageDeg) + "°";
      el.resultMeta.textContent = stats.width + " × " + stats.height +
        " · " + stats.acceptedFrames + " 个关键帧";
      el.resultDetail.textContent = "全景已生成，正在准备 JPEG 保存文件";
      /*
       * The ordinary 2D canvas is the product. Show it and release all large
       * source allocations before JPEG encoding, which is only an optional
       * download enhancement and may hang in a memory-starved WebView.
       */
      releaseCore();
      if (!testMode) stopCamera();
      setStage("result");
      await nextFrame();
      try {
        state.resultBlob = await canvasBlob(
          el.resultCanvas,
          "image/jpeg",
          0.9,
          JPEG_TIMEOUT_MS
        );
        state.exportUrl = URL.createObjectURL(state.resultBlob);
        enableExport(state.exportUrl);
        el.resultDetail.textContent = source === "auto"
          ? "达到 120° 后自动完成 · 普通 2D JPEG"
          : "手动完成 · 普通 2D JPEG";
      } catch (encodeError) {
        /*
         * Keep the valid canvas visible. A failed encoder must never turn a
         * successful panorama into a black/processing screen.
         */
        console.warn("[pano-sweep] JPEG download unavailable", encodeError);
        el.resultDetail.textContent = "全景已生成；本次 JPEG 保存不可用，可重新拍摄";
      }
      return true;
    } catch (error) {
      console.error("[pano-sweep] finalize failed", error);
      state.sweeping = false;
      releaseCore();
      if (!testMode) stopCamera();
      setStage("capture");
      el.statusTitle.textContent = "横向全景生成失败";
      el.statusDetail.textContent = (error && error.message) || "请重新拍摄";
      return false;
    } finally {
      state.processing = false;
      state.autoFinishing = false;
      updateUi();
    }
  }

  function cancelSweep() {
    state.restartCount += 1;
    resetSweepState(false);
    setStage("capture");
    el.statusTitle.textContent = "已取消";
    el.statusDetail.textContent = "上一轮关键帧已释放，可以重新开始";
  }

  function restartSweep() {
    state.restartCount += 1;
    resetSweepState(false);
    setStage("capture");
  }

  function seededNoise(seed) {
    var value = seed >>> 0;
    return function () {
      value += 0x6D2B79F5;
      var t = value;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function syntheticCanvas(yawDeg, pitchDeg, rollDeg, scenario, frameIndex, random) {
    var canvas = document.createElement("canvas");
    canvas.width = 216;
    canvas.height = 288;
    var context = canvas.getContext("2d", { willReadFrequently: true });
    var image = context.createImageData(canvas.width, canvas.height);
    var cameraBasis = syntheticBasis(yawDeg, pitchDeg, rollDeg);
    var tanX = Math.tan(FRAME_FOV_X_DEG * Math.PI / 360);
    var tanY = tanX / (canvas.width / canvas.height);
    var verticalFovDeg = Math.atan(tanY) * 360 / Math.PI;
    var exposure = scenario === "exposure"
      ? 0.72 + 0.42 * (0.5 + 0.5 * Math.sin(frameIndex * 0.27))
      : 1;
    for (var y = 0; y < canvas.height; y += 1) {
      var screenVertical = (y + 0.5) / canvas.height;
      for (var x = 0; x < canvas.width; x += 1) {
        var local = (x + 0.5) / canvas.width - 0.5;
        /*
         * Render the same rectilinear camera ray that a phone would expose.
         * The world texture is then sampled from that ray, so the simulator
         * also exercises pitch/roll compensation instead of feeding pixels
         * that contradict the synthetic sensor pose.
         */
        var rayX = local * 2 * tanX;
        var rayY = (0.5 - screenVertical) * 2 * tanY;
        var worldX = cameraBasis.F[0] +
          cameraBasis.R[0] * rayX + cameraBasis.U[0] * rayY;
        var worldY = cameraBasis.F[1] +
          cameraBasis.R[1] * rayX + cameraBasis.U[1] * rayY;
        var worldZ = cameraBasis.F[2] +
          cameraBasis.R[2] * rayX + cameraBasis.U[2] * rayY;
        var world = (Math.atan2(worldX, worldY) * 180 / Math.PI + 720) % 360;
        var worldLat = Math.atan2(
          worldZ,
          Math.sqrt(worldX * worldX + worldY * worldY)
        ) * 180 / Math.PI;
        var worldVertical = 0.5 - worldLat / Math.max(1, verticalFovDeg);
        var band = Math.floor(world / 7.5);
        var row = Math.floor(worldVertical * 18);
        var grid = Math.abs((world / 15) % 1 - 0.5) > 0.465 ||
          Math.abs((worldVertical * 9) % 1 - 0.5) > 0.465;
        var checker = (band + row) % 2;
        var waveA = 0.5 + 0.5 * Math.sin(world * Math.PI / 27 + worldVertical * 11);
        var waveB = 0.5 + 0.5 * Math.cos(world * Math.PI / 19 - worldVertical * 15);
        var offset = (y * canvas.width + x) * 4;
        var red = grid ? 240 : 28 + 142 * waveA + checker * 30;
        var green = grid ? 238 : 32 + 136 * waveB + (1 - checker) * 26;
        var blue = grid ? 226 : 44 + 112 *
          (0.5 + 0.5 * Math.sin(world / 13 + worldVertical * 8));
        if (scenario === "moving-object") {
          var objectWorld = 49 + Math.sin(frameIndex * 0.6) * 5;
          var objectDx = Math.abs(P.shortestDelta(world, objectWorld));
          if (objectDx < 3.8 && worldVertical > 0.34 &&
              worldVertical < 0.76) {
            red = 234;
            green = 62;
            blue = 84;
          }
        }
        var grain = (random() - 0.5) * 3;
        image.data[offset] = clamp(Math.round(red * exposure + grain), 0, 255);
        image.data[offset + 1] = clamp(Math.round(green * exposure + grain), 0, 255);
        image.data[offset + 2] = clamp(Math.round(blue * exposure + grain), 0, 255);
        image.data[offset + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
    return canvas;
  }

  function scenarioSteps(name) {
    var steps = [];
    var index;
    var direction = name === "steady-rtl" ? -1 : 1;
    var finishAngle = name === "stop-too-short" || name === "fast-fail" ? 32 : 122;
    for (index = 0; index <= finishAngle; index += 2) {
      steps.push({
        yaw: direction * index,
        pitch: name === "pitch-drift" && index >= 36 && index <= 54 ? 11 : Math.sin(index / 17) * 0.55,
        roll: Math.cos(index / 21) * 0.45,
        dt: name === "fast-fail" ? 18 : 150
      });
    }
    if (name === "backtrack") {
      steps = [];
      for (index = 0; index <= 46; index += 2) steps.push({ yaw: index, pitch: 0, roll: 0, dt: 150 });
      for (index = 44; index >= 32; index -= 2) steps.push({ yaw: index, pitch: 0, roll: 0, dt: 150 });
      for (index = 34; index <= 122; index += 2) steps.push({ yaw: index, pitch: 0, roll: 0, dt: 150 });
    }
    return steps;
  }

  function syntheticBasis(yawDeg, pitchDeg, rollDeg) {
    var base = P.orthonormalBasis(
      P.directionFromYawPitch(yawDeg, pitchDeg),
      [0, 0, 1]
    );
    return Math.abs(rollDeg) > 0.001
      ? P.rotateBasisLocal(base, 0, 0, rollDeg)
      : base;
  }

  async function runSyntheticPass(name, seed, stopShort) {
    var random = seededNoise(seed);
    var steps = scenarioSteps(name);
    var latestSyntheticPose = state.poseTimeline
      ? state.poseTimeline.latest()
      : null;
    var time = Math.max(
      nowMs() + 1000,
      latestSyntheticPose ? latestSyntheticPose.timeMs + 1000 : 0
    );
    state.poseReady = true;
    state.basis = syntheticBasis(steps[0].yaw, 0, 0);
    state.lastRawYawDeg = null;
    state.lastPoseTimeMs = 0;
    updatePoseFromBasis(state.basis, time, false);
    state.cameraReady = true;
    beginSweepSession();
    for (var index = 0; index < steps.length; index += 1) {
      var step = steps[index];
      time += step.dt;
      var basis = syntheticBasis(step.yaw, step.pitch, step.roll);
      updatePoseFromBasis(basis, time, false);
      var gateAccepted = updateGate();
      if (gateAccepted) {
        await ingestCanvas(
          syntheticCanvas(
            step.yaw,
            step.pitch,
            step.roll,
            name,
            index,
            random
          ),
          time,
          { scenario: name, frameIndex: index, seed: seed }
        );
      }
      if (index % 8 === 0) await nextFrame();
    }
    var stopAccepted = false;
    if (!stopShort && state.progressDeg >= MIN_SWEEP_DEG) {
      stopAccepted = await finishSweep("test");
    }
    return {
      stopAccepted: stopAccepted,
      stopRejected: !stopAccepted,
      progressDeg: state.progressDeg,
      direction: state.direction,
      frameCount: state.frameCount,
      acceptedFrames: state.acceptedCount,
      rejectedFrames: state.rejectedCount,
      rejectReasons: Object.assign({}, state.rejectReasons),
      pauses: Object.assign({}, state.pauseCounts),
      result: state.resultStats ? Object.assign({}, state.resultStats) : null
    };
  }

  async function runSimulator() {
    document.body.classList.add("is-test");
    el.testReport.hidden = false;
    var supported = [
      "steady-ltr",
      "steady-rtl",
      "exposure",
      "backtrack",
      "fast-fail",
      "pitch-drift",
      "moving-object",
      "jpeg-timeout",
      "stop-too-short",
      "cancel-restart"
    ];
    var report = {
      ok: false,
      buildId: BUILD_ID,
      scenario: testScenario,
      seed: testSeed,
      supportedScenarios: supported,
      getUserMediaCalled: state.getUserMediaCalls > 0,
      uploadAttempted: false
    };
    try {
      if (supported.indexOf(testScenario) < 0) {
        throw new Error("未知测试场景：" + testScenario);
      }
      setStage("capture");
      clearRibbon();
      var firstPass;
      var pass;
      if (testScenario === "cancel-restart") {
        firstPass = await runSyntheticPass("stop-too-short", testSeed, true);
        var releasedBefore = state.releasedSessions;
        cancelSweep();
        state.poseReady = true;
        pass = await runSyntheticPass("steady-ltr", testSeed + 1, false);
        pass.cancelReleased = state.releasedSessions > releasedBefore;
        pass.firstPass = firstPass;
      } else if (testScenario === "jpeg-timeout") {
        var originalToBlob = el.resultCanvas.toBlob;
        el.resultCanvas.toBlob = function () {};
        try {
          pass = await runSyntheticPass(
            "steady-ltr",
            testSeed,
            false
          );
          pass.jpegFallback = state.stage === "result" &&
            !state.exportUrl &&
            el.download.getAttribute("aria-disabled") === "true";
        } finally {
          el.resultCanvas.toBlob = originalToBlob;
        }
      } else {
        pass = await runSyntheticPass(
          testScenario,
          testSeed,
          testScenario === "stop-too-short" || testScenario === "fast-fail"
        );
      }
      var expectedDirection = testScenario === "steady-rtl" ? -1 : 1;
      var baseHealthy = pass.frameCount > 0 && pass.acceptedFrames > 0;
      var behaviorHealthy;
      if (testScenario === "fast-fail") {
        behaviorHealthy = pass.pauses.tooFast > 0 && pass.stopRejected && !pass.result;
      } else if (testScenario === "stop-too-short") {
        behaviorHealthy = pass.progressDeg < MIN_SWEEP_DEG && pass.stopRejected && !pass.result;
      } else if (testScenario === "backtrack") {
        behaviorHealthy = pass.pauses.backtrack > 0 && pass.stopAccepted;
      } else if (testScenario === "pitch-drift") {
        behaviorHealthy = pass.pauses.pitch > 0 && pass.stopAccepted;
      } else if (testScenario === "cancel-restart") {
        behaviorHealthy = pass.cancelReleased && pass.stopAccepted &&
          pass.firstPass && pass.firstPass.progressDeg < MIN_SWEEP_DEG;
      } else if (testScenario === "jpeg-timeout") {
        behaviorHealthy = pass.stopAccepted && pass.jpegFallback;
      } else {
        behaviorHealthy = pass.direction === expectedDirection && pass.stopAccepted;
      }
      var resultHealthy = testScenario === "fast-fail" || testScenario === "stop-too-short"
        ? !pass.result
        : !!(pass.result && pass.result.nonBlack &&
          pass.result.width > pass.result.height &&
          pass.result.coverageDeg >= 115 &&
          pass.result.coverageRatio >= 0.90 &&
          pass.result.internalBlackColumns === 0 &&
          pass.result.ownedSeamLumaP95 <= 45 &&
          pass.result.height <= 202 &&
          pass.result.maxRetainedFrames <= 2);
      report.pass = pass;
      report.behaviorHealthy = behaviorHealthy;
      report.resultHealthy = resultHealthy;
      report.uploadAttempted = state.uploadAttempted;
      report.ok = baseHealthy && behaviorHealthy && resultHealthy &&
        !report.getUserMediaCalled && !report.uploadAttempted;
    } catch (error) {
      report.error = String(error && error.stack || error);
      console.error("[pano-sweep] simulator failed", error);
    }
    window.__HORIZONTAL_PANO_TEST_RESULT__ = report;
    document.body.dataset.testStatus = report.ok ? "passed" : "failed";
    el.testReport.textContent = JSON.stringify(report, null, 2);
    updateDiagnostics(true);
  }

  function diagnosticSnapshot() {
    return {
      buildId: BUILD_ID,
      testMode: testMode,
      scenario: testMode ? testScenario : null,
      stage: state.stage,
      cameraReady: state.cameraReady,
      poseReady: state.poseReady,
      sweeping: state.sweeping,
      direction: state.direction,
      progressDeg: state.progressDeg,
      speedDegS: state.speedDegS,
      pitchOffsetDeg: state.pitchOffsetDeg,
      rollOffsetDeg: state.rollOffsetDeg,
      gateReason: state.gateReason,
      frames: state.frameCount,
      acceptedFrames: state.acceptedCount,
      rejectedFrames: state.rejectedCount,
      pauses: state.pauseCounts,
      usesVideoFrameCallback: typeof el.video.requestVideoFrameCallback === "function",
      uploadAttempted: state.uploadAttempted
    };
  }

  function updateDiagnostics(force) {
    var snapshot = diagnosticSnapshot();
    window.__HORIZONTAL_PANO_DIAGNOSTICS__ = snapshot;
    document.body.dataset.buildId = BUILD_ID;
    if (diagnosticMode) {
      el.diagnosticPanel.hidden = false;
      el.diagnosticPanel.textContent = JSON.stringify(snapshot, null, 2);
    } else if (force) {
      el.diagnosticPanel.hidden = true;
    }
  }

  el.sweep.addEventListener("click", handleSweepButton);
  el.finish.addEventListener("click", function () { finishSweep("manual"); });
  el.cancel.addEventListener("click", cancelSweep);
  el.restart.addEventListener("click", restartSweep);
  el.back.addEventListener("click", restartSweep);
  el.help.addEventListener("click", function () {
    if (el.helpDialog.showModal) el.helpDialog.showModal();
    else el.helpDialog.setAttribute("open", "");
  });
  el.helpClose.addEventListener("click", function () {
    if (el.helpDialog.close) el.helpDialog.close();
    else el.helpDialog.removeAttribute("open");
  });
  window.addEventListener("resize", function () {
    if (!testMode && !portraitReady() &&
        (state.cameraReady || state.starting || state.sweeping)) {
      cancelSweep();
    }
  });
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) return;
    if (state.sweeping || state.cameraReady || state.starting) cancelSweep();
  });
  window.addEventListener("pagehide", function () {
    stopCamera();
    releaseCore();
    clearExport();
  });

  setStage("capture");
  clearRibbon();
  updateUi();
  updateDiagnostics(true);
  setInterval(updateDiagnostics, 500);
  if (testMode) runSimulator();
})();
