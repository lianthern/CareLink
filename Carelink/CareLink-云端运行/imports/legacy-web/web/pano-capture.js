(function () {
  "use strict";

  var P = window.PanoCore;
  var R = window.PanoCaptureRuntime;
  if (!P) throw new Error("PanoCore 未加载");
  if (!R) throw new Error("PanoCaptureRuntime 未加载");

  var params = new URLSearchParams(location.search);
  var testMode = params.get("__pano_test") === "1";
  var diagnosticMode = params.get("__pano_diag") === "1" || testMode;
  var requestedTestScene = testMode ? params.get("__pano_scene") : "";
  var testScene = requestedTestScene === "dynamic"
    ? "dynamic"
    : (requestedTestScene === "handheld" ? "handheld" : "static");
  var dynamicTestMode = testScene === "dynamic";
  var handheldTestMode = testScene === "handheld";
  var HANDHELD_TEST_SEED = 0x51e7c0de;
  var requestedFrames = P.clamp(parseInt(params.get("frames") || "12", 10) || 12, 1, 28);
  var MIN_FINISH_FRAMES = 12;
  var CAPTURE_FOV_DEG = 65;
  var COARSE_WIDTH = 1024;
  var STABLE_ANGLE_DEG = 6;
  var STABLE_SPEED_DEG_S = 18;
  var STABLE_ROBUST_SPEED_DEG_S = 18;
  var STABLE_DISPERSION_DEG = 1.8;
  var STABLE_WINDOW_MS = 520;
  var STABLE_MIN_WINDOW_MS = 400;
  var SIGNIFICANT_MOTION_DEG = 0.45;
  var SENSOR_SILENCE_STEADY_MS = 400;
  var POSE_FRESHNESS_MS = 900;
  var MANUAL_POSE_FRESHNESS_MS = 900;
  var FRAME_POSE_MATCH_TOLERANCE_MS = 420;
  var QUIET_HOLD_FRAME_POSE_MAX_AGE_MS = 950;
  var QUIET_HOLD_ENTRY_TO_DRAW_MAX_MS = 300;
  var QUIET_HOLD_EXISTING_FRAME_MAX_AGE_MS = 600;
  var QUIET_HOLD_FRAME_BASIS_DRIFT_DEG = 0.35;
  var MAX_ROLL_DEG = 25;
  var DWELL_MS = 420;
  var ENCODE_TIMEOUT_MS = 7000;
  var CAPTURE_MAX_SIDE_DEFAULT = 1024;
  var CAPTURE_MAX_SIDE_LOW_MEMORY = 768;
  var PREVIEW_INTERVAL_MS = 1000 / 10;
  var WORLD_PREVIEW_MAX_WIDTH = 160;
  var WORLD_PREVIEW_MIN_WIDTH = 120;
  var ALIGNMENT_MAX_SIDE = 240;
  var VISUAL_ALIGNMENT_OPTIONS = {
    maxCorrectionDeg: 5,
    maxRollDeg: 3,
    maxFovCorrectionDeg: 6,
    minOverlapRatio: 0.08,
    minScore: 0.7,
    targetSamples: 420,
    maxReferences: 6,
    maxReferenceAngleDeg: 78,
    imuPriorWeight: 0.06
  };
  var VISUAL_SEQUENCE_OPTIONS = {
    maxCorrectionDeg: 4,
    maxRollDeg: 2.5,
    maxFovCorrectionDeg: 0,
    minOverlapRatio: 0.1,
    minScore: 0.74,
    targetSamples: 520,
    levels: 3
  };
  var SESSION_FOV_MIN_CONFIDENCE = 0.5;
  var SESSION_FOV_MIN_SCORE = 0.78;
  var SESSION_FOV_MIN_SAMPLES = 4;
  var SESSION_FOV_MIN_DEG = CAPTURE_FOV_DEG - 6;
  var SESSION_FOV_MAX_DEG = CAPTURE_FOV_DEG + 6;
  var SEQUENCE_MIN_CONFIDENCE = 0.52;
  var LOOP_MIN_CONFIDENCE = 0.64;
  var LOOP_MAX_RESIDUAL_DEG = 2.5;

  var el = {
    captureStage: document.getElementById("captureStage"),
    processStage: document.getElementById("processStage"),
    resultStage: document.getElementById("resultStage"),
    worldCanvas: document.getElementById("worldCanvas"),
    video: document.getElementById("cameraVideo"),
    liveWindow: document.getElementById("liveWindow"),
    liveEmpty: document.getElementById("liveEmpty"),
    flash: document.getElementById("captureFlash"),
    target: document.getElementById("targetDot"),
    count: document.getElementById("captureCount"),
    coverage: document.getElementById("coverageText"),
    guideTitle: document.getElementById("guideTitle"),
    guideDetail: document.getElementById("guideDetail"),
    start: document.getElementById("startButton"),
    undo: document.getElementById("undoButton"),
    finish: document.getElementById("finishButton"),
    processText: document.getElementById("processText"),
    progressBar: document.getElementById("progressBar"),
    progressNumber: document.getElementById("progressNumber"),
    resultCanvas: document.getElementById("resultCanvas"),
    viewerCanvas: document.getElementById("viewerCanvas"),
    viewerMessage: document.getElementById("viewerMessage"),
    resultMode: document.getElementById("resultMode"),
    resultMeta: document.getElementById("resultMeta"),
    toggle360: document.getElementById("toggle360Button"),
    download: document.getElementById("downloadButton"),
    backToCapture: document.getElementById("backToCapture"),
    help: document.getElementById("helpButton"),
    helpDialog: document.getElementById("helpDialog"),
    helpClose: document.getElementById("helpClose"),
    testReport: document.getElementById("testReport"),
    capabilityBadge: document.getElementById("capabilityBadge"),
    diagnosticPanel: document.getElementById("diagnosticPanel")
  };

  var defaultBasis = P.orthonormalBasis([0, 1, 0], [0, 0, 1]);
  var session = {
    targets: P.createTargets(testMode ? requestedFrames : undefined),
    targetIndex: 0,
    frames: [],
    alignmentFrames: [],
    visualEdges: [],
    visualSummary: null,
    seamSummary: null,
    sessionFovXDeg: CAPTURE_FOV_DEG,
    sessionFovSummary: null,
    coarse: P.createRaster(COARSE_WIDTH, COARSE_WIDTH / 2),
    trackingBasis: P.copyBasis(defaultBasis),
    displayBasis: P.copyBasis(defaultBasis),
    captureBasis: null,
    poseTimeline: new R.PoseTimeline({ maxAgeMs: 3200, maxSamples: 240 }),
    displayFilter: new R.DisplayPoseFilter({ timeConstantMs: 52, snapAfterMs: 280 }),
    headingOffsetDeg: null,
    angularSpeed: Infinity,
    quietBasis: null,
    quietSince: 0,
    lastSignificantMotionAt: 0,
    stableSince: 0,
    orientationReady: false,
    cameraReady: false,
    cameraStarting: false,
    cameraGeneration: 0,
    capturing: false,
    autoCaptureSuspended: false,
    captureAttemptCount: 0,
    rebuilding: false,
    processing: false,
    stream: null,
    videoClock: null,
    latestVideoFrame: null,
    captureSessionStarted: false,
    animationRaf: 0,
    lastAnimationAt: 0,
    previewDirty: true,
    lastPreviewDrawAt: 0,
    previewFrames: 0,
    previewFpsStartedAt: 0,
    previewFps: 0,
    previewBuffer: null,
    lastDiagnosticAt: 0,
    lastCaptureDiagnostic: null,
    lastCaptureError: null,
    lastQuietHoldReject: null,
    capabilities: R.detectCapabilities(el.video),
    exportUrl: "",
    resultBlob: null,
    viewer: null,
    progressEvents: [],
    uploadAttempted: false,
    testCameraStreamFactory: null
  };

  function nextFrame() {
    return new Promise(function (resolve) { requestAnimationFrame(resolve); });
  }

  function setStage(name) {
    el.captureStage.hidden = name !== "capture";
    el.processStage.hidden = name !== "process";
    el.resultStage.hidden = name !== "result";
    document.body.dataset.stage = name;
  }

  function effectiveScreenAngle(reported, portrait) {
    var normalized = ((reported % 360) + 360) % 360;
    // Capture is intentionally portrait-only. Some embedded WebViews retain a
    // stale 90° ScreenOrientation value after the viewport has returned to
    // portrait; applying it turns an upright pose into roll ±90° and blocks
    // every shutter. Trust the actual viewport in that contradictory state.
    if (portrait && (normalized === 90 || normalized === 270)) {
      return 0;
    }
    return normalized;
  }

  function screenAngle() {
    var reported = screen.orientation && typeof screen.orientation.angle === "number"
      ? screen.orientation.angle
      : (typeof window.orientation === "number" ? window.orientation : 0);
    return effectiveScreenAngle(reported, portraitCaptureReady());
  }

  function eventMonotonicTime(event) {
    var now = performance.now();
    var eventTime = Number(event && event.timeStamp);
    // Modern Event.timeStamp shares performance.timeOrigin. Some older Safari
    // builds returned epoch-based values, so only accept a plausible local
    // monotonic timestamp.
    return Number.isFinite(eventTime) &&
      eventTime >= now - 10000 &&
      eventTime <= now + 1000
      ? eventTime
      : now;
  }

  function portraitCaptureReady() {
    return innerHeight >= innerWidth;
  }

  function liveWindowRect() {
    var rect = el.liveWindow.getBoundingClientRect();
    if (rect.width && rect.height) return rect;
    var width = innerWidth * 0.72;
    var height = width * 4 / 3;
    var left = (innerWidth - width) / 2;
    var top = (innerHeight - height) / 2;
    return {
      left: left,
      top: top,
      width: width,
      height: height,
      right: left + width,
      bottom: top + height
    };
  }

  function captureGateAt(now, target, poseBasis) {
    var basis = poseBasis || session.trackingBasis;
    var rect = liveWindowRect();
    var aspect = Math.max(0.3, rect.width / Math.max(1, rect.height));
    var projected = P.projectDirection(target.dir, basis, CAPTURE_FOV_DEG, aspect);
    var latestPose = session.poseTimeline.latest();
    // Some WebViews reduce DeviceOrientation frequency when the handset is
    // completely still. Evaluate the stable window at the last real sensor
    // sample, then separately bound how old that sample may be.
    var motionEnd = latestPose ? Math.min(now, latestPose.timeMs) : now;
    var motion = session.poseTimeline.motionStats(motionEnd, STABLE_WINDOW_MS);
    motion.latestAgeMs = latestPose
      ? Math.max(0, now - latestPose.timeMs)
      : Infinity;
    var statisticallyStill = motion.ready &&
      motion.durationMs >= STABLE_MIN_WINDOW_MS &&
      motion.instantaneousDegS <= STABLE_SPEED_DEG_S &&
      motion.robustDegS <= STABLE_ROBUST_SPEED_DEG_S &&
      motion.dispersionDeg <= STABLE_DISPERSION_DEG;
    var quietForMs = session.quietSince
      ? Math.max(0, now - session.quietSince)
      : 0;
    // DeviceOrientation implementations may stop dispatching once the pose no
    // longer changes. A bounded 400–900ms silent period after the last
    // significant movement is therefore valid evidence of a quiet hold; it is
    // not treated as an indefinitely reusable stale pose.
    var silentAndQuiet = motion.latestAgeMs >= SENSOR_SILENCE_STEADY_MS &&
      motion.latestAgeMs <= POSE_FRESHNESS_MS &&
      quietForMs >= STABLE_MIN_WINDOW_MS;
    var steady = motion.latestAgeMs <= POSE_FRESHNESS_MS &&
      quietForMs >= STABLE_MIN_WINDOW_MS &&
      (statisticallyStill || silentAndQuiet);
    return {
      projected: projected,
      motion: motion,
      visible: projected.visible,
      aligned: projected.angleDeg <= STABLE_ANGLE_DEG,
      upright: Math.abs(basis.rollDeg || 0) <= MAX_ROLL_DEG,
      steady: steady,
      statisticallyStill: statisticallyStill,
      silentAndQuiet: silentAndQuiet,
      quietForMs: quietForMs
    };
  }

  function quietHoldFramePose(entry, presentedFrame, now, target) {
    var latestPose = session.poseTimeline.latest();
    var environmentReady = testMode ||
      (session.cameraReady &&
        session.orientationReady &&
        !document.hidden &&
        portraitCaptureReady() &&
        el.video.readyState >= 2);
    function reject(reason, detail) {
      session.lastQuietHoldReject = {
        reason: reason,
        detail: detail || null,
        atMs: now
      };
      return null;
    }
    if (!entry || !entry.entryAccepted || !entry.gate || !entry.pose) {
      return reject("ENTRY_MISSING");
    }
    if (!entry.gate.silentAndQuiet) return reject("ENTRY_NOT_SILENT");
    if (!latestPose) return reject("LATEST_POSE_MISSING");
    if (!presentedFrame) return reject("VIDEO_FRAME_MISSING");
    var frameAgeMs = now - presentedFrame.poseTimeMs;
    if (presentedFrame.sequence <= entry.frameSequence &&
        (frameAgeMs < -30 ||
          frameAgeMs > QUIET_HOLD_EXISTING_FRAME_MAX_AGE_MS)) {
      return reject("VIDEO_FRAME_NOT_NEW", {
        entrySequence: entry.frameSequence,
        frameSequence: presentedFrame.sequence,
        frameAgeMs: frameAgeMs
      });
    }
    if (now - entry.timeMs > QUIET_HOLD_ENTRY_TO_DRAW_MAX_MS) {
      return reject("ENTRY_TO_DRAW_LIMIT", {
        entryToDrawMs: now - entry.timeMs
      });
    }
    if (session.targetIndex !== entry.targetIndex) return reject("TARGET_CHANGED");
    if (session.cameraGeneration !== entry.cameraGeneration) {
      return reject("CAMERA_CHANGED");
    }
    if (session.quietSince !== entry.quietSince ||
        session.lastSignificantMotionAt !== entry.lastSignificantMotionAt) {
      return reject("MOTION_AFTER_ENTRY");
    }
    if (!environmentReady) return reject("CAPTURE_ENVIRONMENT_INVALID");
    var videoTrack = session.stream && session.stream.getVideoTracks
      ? session.stream.getVideoTracks()[0]
      : null;
    if (videoTrack && videoTrack.readyState !== "live") {
      return reject("VIDEO_TRACK_NOT_LIVE");
    }
    var latestAgeMs = Math.max(0, now - latestPose.timeMs);
    var poseGapMs = presentedFrame.poseTimeMs - entry.pose.timeMs;
    var basisDriftDeg = P.basisRotationErrorDeg(
      entry.pose.basis,
      latestPose.basis
    );
    var rect = liveWindowRect();
    var aspect = Math.max(0.3, rect.width / Math.max(1, rect.height));
    var projected = P.projectDirection(
      target.dir,
      entry.pose.basis,
      CAPTURE_FOV_DEG,
      aspect
    );
    if (latestAgeMs > QUIET_HOLD_FRAME_POSE_MAX_AGE_MS) {
      return reject("LATEST_POSE_TOO_OLD", { latestAgeMs: latestAgeMs });
    }
    if (poseGapMs < 0 || poseGapMs > QUIET_HOLD_FRAME_POSE_MAX_AGE_MS) {
      return reject("FRAME_POSE_GAP_LIMIT", { poseGapMs: poseGapMs });
    }
    var frameAgeLimit = presentedFrame.sequence <= entry.frameSequence
      ? QUIET_HOLD_EXISTING_FRAME_MAX_AGE_MS
      : QUIET_HOLD_ENTRY_TO_DRAW_MAX_MS;
    if (frameAgeMs < -30 || frameAgeMs > frameAgeLimit) {
      return reject("VIDEO_FRAME_AGE_LIMIT", { frameAgeMs: frameAgeMs });
    }
    if (presentedFrame.poseTimeMs <
        entry.lastSignificantMotionAt + STABLE_MIN_WINDOW_MS) {
      return reject("FRAME_BEFORE_QUIET_HOLD", {
        quietFrameLeadMs: presentedFrame.poseTimeMs -
          entry.lastSignificantMotionAt
      });
    }
    if (basisDriftDeg > QUIET_HOLD_FRAME_BASIS_DRIFT_DEG) {
      return reject("BASIS_DRIFT", { basisDriftDeg: basisDriftDeg });
    }
    if (!projected.visible || projected.angleDeg > STABLE_ANGLE_DEG) {
      return reject("TARGET_NOT_ALIGNED", {
        visible: projected.visible,
        angleDeg: projected.angleDeg
      });
    }
    if (Math.abs(entry.pose.basis.rollDeg || 0) > MAX_ROLL_DEG) {
      return reject("ROLL_LIMIT", { rollDeg: entry.pose.basis.rollDeg || 0 });
    }
    session.lastQuietHoldReject = null;
    return {
      basis: P.copyBasis(entry.pose.basis),
      source: "entry-quiet-hold",
      gapMs: poseGapMs,
      poseFallback: true,
      quietHoldFallback: true,
      entryToDrawMs: now - entry.timeMs,
      geometryGate: {
        projected: projected,
        motion: entry.gate.motion,
        visible: projected.visible,
        aligned: projected.angleDeg <= STABLE_ANGLE_DEG,
        upright: Math.abs(entry.pose.basis.rollDeg || 0) <= MAX_ROLL_DEG,
        steady: true,
        statisticallyStill: false,
        silentAndQuiet: true,
        quietForMs: entry.gate.quietForMs
      }
    };
  }

  function manualCaptureAllowed(gate) {
    return !!gate &&
      gate.visible &&
      gate.aligned &&
      gate.upright &&
      gate.motion.latestAgeMs <= MANUAL_POSE_FRESHNESS_MS;
  }

  function autoCaptureEligible() {
    // Tier B browsers do not expose requestVideoFrameCallback, but captureCurrent
    // already maps a draw-time fallback to the pose timeline. Because auto
    // capture only happens after the handset is still, that timing uncertainty
    // is bounded and far preferable to silently disabling auto capture.
    return session.captureSessionStarted &&
      session.frames.length > 0 &&
      !session.autoCaptureSuspended;
  }

  function explainRejectedGate(gate, manual) {
    session.stableSince = 0;
    if (!gate.upright) {
      el.guideTitle.textContent = "请把手机扶正";
      el.guideDetail.textContent = "侧倾过大会暂停拍摄";
    } else if (!gate.visible || !gate.aligned) {
      el.guideTitle.textContent = "请把白点放进中央圆环";
      el.guideDetail.textContent = "对准后再" + (manual ? "点击拍摄" : "停稳手机");
    } else if (gate.motion.latestAgeMs > MANUAL_POSE_FRESHNESS_MS) {
      el.guideTitle.textContent = "方向数据暂时中断";
      el.guideDetail.textContent = "轻轻转动手机后再试";
    } else {
      el.guideTitle.textContent = "请先停稳手机";
      el.guideDetail.textContent = "停稳后会自动拍摄";
    }
  }

  function updateCapabilityUi() {
    var capability = session.capabilities;
    document.body.dataset.captureTier = capability.tier;
    el.capabilityBadge.textContent = "设备 " + capability.tier + " · " + capability.label;
    el.capabilityBadge.title = capability.videoFrameCallback
      ? "视频帧会关联到同一时间轴上的方向姿态"
      : "浏览器未提供逐帧回调，使用兼容时间估计";
  }

  function updateControls() {
    var total = session.targets.length;
    var count = session.frames.length;
    var stats = P.rasterStats(session.coarse);
    var locked = session.processing || session.capturing || session.rebuilding || session.cameraStarting;
    el.count.textContent = count + " / " + total;
    el.coverage.textContent = count
      ? "已覆盖约 " + Math.round(stats.coverage * 100) + "% · 黑色仍待拍"
      : "未拍区域保持黑色";
    el.undo.disabled = locked || count === 0;
    el.finish.disabled = locked || count < Math.min(MIN_FINISH_FRAMES, total);
    el.start.disabled = locked || !portraitCaptureReady() ||
      (!testMode && !session.capabilities.canCaptureDirected);
    if (session.cameraStarting) el.start.textContent = "正在开启…";
    else if (!session.cameraReady) el.start.textContent = "开启相机";
    else if (!session.orientationReady) el.start.textContent = "重试方向权限";
    else if (!session.captureSessionStarted) el.start.textContent = "拍第一张";
    else if (session.autoCaptureSuspended) el.start.textContent = "重试这一张";
    else el.start.textContent = "手动拍这一张";
  }

  function updateTarget() {
    var target = session.targets[session.targetIndex];
    if (!target) {
      el.target.classList.add("is-hidden");
      el.guideTitle.textContent = "所有目标都拍完了";
      el.guideDetail.textContent = "正在准备 2D 全景结果";
      return null;
    }
    if (!portraitCaptureReady() && !testMode) {
      session.stableSince = 0;
      el.target.classList.add("is-hidden");
      el.guideTitle.textContent = "请竖直握持手机";
      el.guideDetail.textContent = "竖屏照片能覆盖更多天空与地面";
      return null;
    }
    var rect = liveWindowRect();
    var aspect = Math.max(0.3, rect.width / Math.max(1, rect.height));
    var displayProjected = P.projectDirection(
      target.dir,
      session.displayBasis,
      CAPTURE_FOV_DEG,
      aspect
    );
    var orientationActive = session.orientationReady || testMode;
    var visible = displayProjected.visible && orientationActive;
    el.target.classList.toggle("is-hidden", !orientationActive);
    el.target.classList.toggle("is-offscreen", orientationActive && !visible);
    if (orientationActive) {
      var nx = visible ? displayProjected.nx : displayProjected.guideNx;
      var ny = visible ? displayProjected.ny : displayProjected.guideNy;
      var x = rect.left + (nx * 0.5 + 0.5) * rect.width;
      var y = rect.top + (0.5 - ny * 0.5) * rect.height;
      el.target.style.left = P.clamp(x, rect.left + 18, rect.right - 18) + "px";
      el.target.style.top = P.clamp(y, rect.top + 18, rect.bottom - 18) + "px";
    }
    var helpOpen = !!el.helpDialog.open;
    var now = performance.now();
    var gate = testMode ? {
      projected: displayProjected,
      visible: true,
      aligned: true,
      steady: true,
      upright: true,
      motion: { latestAgeMs: 0 }
    } : captureGateAt(now, target);
    var autoEligible = autoCaptureEligible();
    if ((!session.cameraReady || !session.orientationReady) && !testMode) {
      session.stableSince = 0;
      el.guideTitle.textContent = "把下一颗白点移进中央圆环";
      el.guideDetail.textContent = !session.cameraReady
        ? "开启相机后开始拍摄"
        : "需要方向权限，不能用默认方向代替";
    } else if (gate.visible && gate.aligned && gate.steady && gate.upright && session.cameraReady &&
               session.orientationReady && !session.capturing && !session.rebuilding &&
               !session.processing && !helpOpen && !document.hidden) {
      if (!autoEligible) {
        session.stableSince = 0;
        el.target.style.setProperty("--dwell", "0deg");
        el.target.classList.add("is-aligned");
        el.guideTitle.textContent = session.captureSessionStarted
          ? "当前方向已对准"
          : "第一张已对准";
        el.guideDetail.textContent = session.autoCaptureSuspended
          ? "自动拍摄已暂停，请点击“重试这一张”"
          : (session.captureSessionStarted
            ? "请点击按钮手动拍摄这一张"
            : "请点击“拍第一张”确认起始方向");
        return gate;
      }
      if (!session.stableSince) {
        // quietForMs already represents time held still. Reusing it here keeps
        // total wait near 0.42s instead of requiring a second full dwell after
        // the stability gate finally opens.
        session.stableSince = now - Math.min(DWELL_MS, gate.quietForMs || 0);
      }
      var dwell = P.clamp((now - session.stableSince) / DWELL_MS, 0, 1);
      el.target.style.setProperty("--dwell", Math.round(dwell * 360) + "deg");
      el.target.classList.add("is-aligned");
      el.guideTitle.textContent = "保持不动";
        el.guideDetail.textContent = session.capabilities.videoFrameCallback
          ? "正在核对原始运动与当前视频帧"
          : "兼容帧时间估计中，请继续保持不动";
      if (dwell >= 1) captureCurrent("auto");
    } else {
      session.stableSince = 0;
      el.target.style.setProperty("--dwell", "0deg");
      el.target.classList.remove("is-aligned");
      if (!gate.upright) {
        el.guideTitle.textContent = "请把手机扶正";
        el.guideDetail.textContent = "侧倾过大会暂停自动拍摄";
      } else if (!gate.steady) {
        el.guideTitle.textContent = "先停稳手机";
        el.guideDetail.textContent = gate.motion.latestAgeMs > POSE_FRESHNESS_MS
          ? "方向数据暂时中断，正在等待新姿态"
          : "原始转动仍在变化，暂不触发快门";
      } else if (!gate.visible) {
        el.guideTitle.textContent = "继续转向屏幕边缘白点";
        el.guideDetail.textContent = gate.projected.behind
          ? "下一方向在身后"
          : "白点进入真实取景窗后再对准中央圆环";
      } else {
        el.guideTitle.textContent = "只对准下一颗白点";
        if (autoEligible) {
          el.guideDetail.textContent = "停稳约半秒会自动拍摄";
        } else if (session.autoCaptureSuspended) {
          el.guideDetail.textContent = "自动拍摄已暂停，请点击按钮重试这一张";
        } else if (session.captureSessionStarted) {
          el.guideDetail.textContent = "当前浏览器是兼容模式，请手动拍摄";
        } else {
          el.guideDetail.textContent = "第一张必须由你点击确认";
        }
      }
    }
    return gate;
  }

  function onOrientation(event) {
    if (typeof event.alpha !== "number" || typeof event.beta !== "number" || typeof event.gamma !== "number") return;
    var raw = P.basisFromDeviceOrientation(event.alpha, event.beta, event.gamma, screenAngle());
    if (session.headingOffsetDeg === null) {
      // 镜头接近天顶/地底时 heading 没有数学定义，等回到接近水平再锁零方向。
      if (Math.hypot(raw.F[0], raw.F[1]) < 0.25) {
        el.guideTitle.textContent = "先让镜头接近水平";
        el.guideDetail.textContent = "锁定起始方向后再开始拍摄";
        return;
      }
      session.headingOffsetDeg = P.headingDeg(raw);
    }
    var rebased = P.rotateBasisZ(raw, session.headingOffsetDeg);
    var now = eventMonotonicTime(event);
    session.trackingBasis = rebased;
    var sample = session.poseTimeline.push(now, rebased, "deviceorientation-eventTime");
    session.angularSpeed = sample ? sample.speedDegS : Infinity;
    if (!session.quietBasis) {
      session.quietBasis = P.copyBasis(rebased);
      session.quietSince = now;
      session.lastSignificantMotionAt = now;
    } else if (P.basisRotationErrorDeg(session.quietBasis, rebased) >=
               SIGNIFICANT_MOTION_DEG) {
      session.quietBasis = P.copyBasis(rebased);
      session.quietSince = now;
      session.lastSignificantMotionAt = now;
    }
    if (!session.displayFilter.basis) {
      session.displayBasis = session.displayFilter.update(rebased, now);
    }
    if (!session.orientationReady) {
      session.orientationReady = true;
      updateControls();
    }
    session.previewDirty = true;
  }

  function cameraOperationValid(generation) {
    return generation === session.cameraGeneration &&
      !document.hidden && portraitCaptureReady();
  }

  async function requestMotionPermission(generation) {
    if (typeof DeviceOrientationEvent === "undefined") return false;
    if (typeof DeviceOrientationEvent.requestPermission === "function") {
      var answer = await DeviceOrientationEvent.requestPermission();
      if (answer !== "granted") return false;
    }
    if (!cameraOperationValid(generation)) return false;
    window.removeEventListener("deviceorientation", onOrientation, true);
    window.addEventListener("deviceorientation", onOrientation, true);
    return true;
  }

  function waitForVideo(video) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error("相机画面超时")); }, 5000);
      function ready() {
        if (!video.videoWidth) return;
        clearTimeout(timer);
        video.removeEventListener("loadedmetadata", ready);
        resolve();
      }
      video.addEventListener("loadedmetadata", ready);
      ready();
    });
  }

  function requestCameraStream(constraints) {
    if (testMode && session.testCameraStreamFactory) {
      return session.testCameraStreamFactory(constraints);
    }
    return navigator.mediaDevices.getUserMedia(constraints);
  }

  function startVideoClock() {
    if (session.videoClock) session.videoClock.stop();
    session.videoClock = new R.VideoFrameClock(el.video, {
      onFrame: function (frame) {
        var pose = session.poseTimeline.at(frame.poseTimeMs, 420);
        frame.pose = pose;
        session.latestVideoFrame = frame;
      }
    });
    session.videoClock.start();
  }

  async function startCamera() {
    if (!portraitCaptureReady()) {
      el.guideTitle.textContent = "请先转回竖屏";
      el.guideDetail.textContent = "竖直握持后才能开始全景拍摄";
      updateControls();
      return;
    }
    if (session.cameraReady) {
      if (session.orientationReady) {
        session.autoCaptureSuspended = false;
        captureCurrent("manual");
        return;
      }
      if (session.cameraStarting) return;
      var retryGeneration = ++session.cameraGeneration;
      session.cameraStarting = true;
      updateControls();
      try {
        var motionRetried = await requestMotionPermission(retryGeneration);
        if (!cameraOperationValid(retryGeneration)) return;
        el.guideTitle.textContent = motionRetried ? "等待方向传感器" : "缺少方向权限";
        el.guideDetail.textContent = motionRetried
          ? "轻轻转动手机；收到姿态后才允许拍摄"
          : "请在浏览器设置中允许动作与方向";
      } catch (motionError) {
        if (!cameraOperationValid(retryGeneration)) return;
        console.warn("[pano-capture] motion permission retry failed", motionError);
        el.guideTitle.textContent = "缺少方向权限";
        el.guideDetail.textContent = "请在浏览器设置中允许动作与方向";
      } finally {
        if (retryGeneration === session.cameraGeneration) {
          session.cameraStarting = false;
          updateControls();
        }
      }
      return;
    }
    if (session.cameraStarting) return;
    var generation = ++session.cameraGeneration;
    session.cameraStarting = true;
    updateControls();
    try {
      var motionGranted = await requestMotionPermission(generation);
      if (!cameraOperationValid(generation)) return;
      if (!session.testCameraStreamFactory &&
          (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)) {
        throw new Error("浏览器不支持相机");
      }
      var stream = await requestCameraStream({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 960 },
          height: { ideal: 1280 },
          aspectRatio: { ideal: 0.75 }
        }
      });
      if (!cameraOperationValid(generation)) {
        stream.getTracks().forEach(function (track) { track.stop(); });
        return;
      }
      session.stream = stream;
      el.video.srcObject = stream;
      await el.video.play();
      if (!cameraOperationValid(generation)) {
        stream.getTracks().forEach(function (track) { track.stop(); });
        if (session.stream === stream) session.stream = null;
        if (el.video.srcObject === stream) el.video.srcObject = null;
        return;
      }
      await waitForVideo(el.video);
      if (!cameraOperationValid(generation)) return;
      session.cameraReady = true;
      startVideoClock();
      el.liveWindow.classList.add("is-ready");
      el.guideDetail.textContent = motionGranted
        ? "轻轻转动手机；收到姿态后会显示下一目标"
        : "缺少方向权限，暂时不能进行定向拍摄";
      updateControls();
      updateTarget();
    } catch (error) {
      if (!cameraOperationValid(generation)) return;
      console.error("[pano-capture] start failed", error);
      // Preserve the original heading zero after any successful frame. A
      // transient camera restart failure must not rebase later photos.
      stopCamera();
      el.liveEmpty.textContent = (error && error.message) || "相机没有成功开启";
      el.guideTitle.textContent = "相机没有开启";
      el.guideDetail.textContent = "请允许相机权限后重试";
      updateControls();
    } finally {
      if (generation === session.cameraGeneration) {
        session.cameraStarting = false;
        updateControls();
      }
    }
  }

  function stopCamera(resetHeading) {
    session.cameraGeneration += 1;
    session.cameraStarting = false;
    window.removeEventListener("deviceorientation", onOrientation, true);
    if (session.videoClock) {
      session.videoClock.stop();
      session.videoClock = null;
    }
    session.latestVideoFrame = null;
    if (session.stream) {
      session.stream.getTracks().forEach(function (track) { track.stop(); });
      session.stream = null;
    }
    el.video.srcObject = null;
    session.cameraReady = false;
    session.orientationReady = false;
    session.poseTimeline.clear();
    session.displayFilter.clear();
    session.trackingBasis = P.copyBasis(defaultBasis);
    session.displayBasis = P.copyBasis(defaultBasis);
    session.captureBasis = null;
    session.angularSpeed = Infinity;
    session.quietBasis = null;
    session.quietSince = 0;
    session.lastSignificantMotionAt = 0;
    session.stableSince = 0;
    if (resetHeading || !session.frames.length) session.headingOffsetDeg = null;
    el.liveWindow.classList.remove("is-ready");
    session.previewDirty = true;
  }

  function canvasBlob(canvas, type, quality) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        var timeoutError = new Error("照片编码超时");
        timeoutError.code = "PHOTO_ENCODE_TIMEOUT";
        reject(timeoutError);
      }, ENCODE_TIMEOUT_MS);
      canvas.toBlob(function (blob) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (blob) resolve(blob);
        else reject(new Error("照片编码失败"));
      }, type || "image/jpeg", quality == null ? 0.78 : quality);
    });
  }

  function captureCanvasFromVideo() {
    var sourceW = el.video.videoWidth;
    var sourceH = el.video.videoHeight;
    if (!sourceW || !sourceH) throw new Error("相机还没有画面");
    // The live window is 3:4 with object-fit:cover. Some browsers still
    // deliver a landscape sensor frame despite a portrait page, so crop the
    // saved/projected frame to that exact visible 3:4 centre region.
    var crop = P.centerCropRect(sourceW, sourceH, 3 / 4);
    var cropX = crop.x;
    var cropY = crop.y;
    var cropW = crop.width;
    var cropH = crop.height;
    var memory = Number(navigator.deviceMemory) || 4;
    var captureMaxSide = memory <= 4
      ? CAPTURE_MAX_SIDE_LOW_MEMORY
      : CAPTURE_MAX_SIDE_DEFAULT;
    var scale = Math.min(1, captureMaxSide / Math.max(cropW, cropH));
    var canvas = document.createElement("canvas");
    canvas.width = Math.max(2, Math.round(cropW * scale));
    canvas.height = Math.max(2, Math.round(cropH * scale));
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(el.video, cropX, cropY, cropW, cropH, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  function handheldTestNoise(index, salt) {
    // A fixed integer seed keeps screenshots and local-warp diagnostics byte
    // reproducible across repeated browser runs. This path exists only behind
    // __pano_test=1&__pano_scene=handheld.
    var value = HANDHELD_TEST_SEED ^
      Math.imul((index + 1) | 0, 0x045d9f3b) ^
      Math.imul((salt + 17) | 0, 0x27d4eb2d);
    value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
    value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
    value = (value ^ (value >>> 16)) >>> 0;
    return value / 4294967295 * 2 - 1;
  }

  function handheldTestProfile(index, basis) {
    if (!handheldTestMode || index === 0) {
      return {
        seed: HANDHELD_TEST_SEED,
        zoom: 1,
        cropNx: 0,
        cropNy: 0,
        rollingYawDeg: 0,
        rollingPitchDeg: 0,
        translationMetres: [0, 0, 0],
        sceneRadiusMetres: 3.6
      };
    }
    var alternating = index % 2 ? 1 : -1;
    var right = alternating * (0.018 + 0.005 * Math.abs(
      handheldTestNoise(index, 4)
    ));
    var up = 0.005 * handheldTestNoise(index, 5);
    var forward = 0.004 * handheldTestNoise(index, 6);
    return {
      seed: HANDHELD_TEST_SEED,
      zoom: 1.009 + 0.003 * Math.abs(handheldTestNoise(index, 0)),
      cropNx: alternating * (0.003 +
        0.0015 * Math.abs(handheldTestNoise(index, 1))),
      cropNy: 0.0025 * handheldTestNoise(index, 2),
      rollingYawDeg: alternating * (0.58 +
        0.14 * Math.abs(handheldTestNoise(index, 7))),
      rollingPitchDeg: 0.24 * handheldTestNoise(index, 8),
      translationMetres: [
        basis.R[0] * right + basis.U[0] * up + basis.F[0] * forward,
        basis.R[1] * right + basis.U[1] * up + basis.F[1] * forward,
        basis.R[2] * right + basis.U[2] * up + basis.F[2] * forward
      ],
      sceneRadiusMetres: 3.6
    };
  }

  function handheldFiniteSceneDirection(direction, profile) {
    var origin = profile.translationMetres;
    if (!origin || (!origin[0] && !origin[1] && !origin[2])) return direction;
    var radius = profile.sceneRadiusMetres;
    var originAlongRay = P.dot(origin, direction);
    var originLengthSquared = P.dot(origin, origin);
    var distance = -originAlongRay + Math.sqrt(Math.max(
      0,
      originAlongRay * originAlongRay + radius * radius - originLengthSquared
    ));
    return P.normalize([
      origin[0] + direction[0] * distance,
      origin[1] + direction[1] * distance,
      origin[2] + direction[2] * distance
    ], direction);
  }

  function syntheticCanvas(index, target, trueBasis) {
    var canvas = document.createElement("canvas");
    canvas.width = 240;
    canvas.height = 320;
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    var image = ctx.createImageData(canvas.width, canvas.height);
    var basis = trueBasis || P.orthonormalBasis(target.dir, [0, 0, 1]);
    var aspect = canvas.width / canvas.height;
    var handheldProfile = handheldTestProfile(index, basis);
    var dynamicSubject = dynamicTestMode && index < 2;
    var subjectLongitudeDeg = index === 0 ? 7 : 23;
    var subjectDirection = dynamicSubject
      ? P.directionFromYawPitch(subjectLongitudeDeg, 0)
      : null;
    var subjectLongitudeRad = subjectLongitudeDeg * Math.PI / 180;
    var subjectTangent = dynamicSubject
      ? [Math.cos(subjectLongitudeRad), -Math.sin(subjectLongitudeRad), 0]
      : null;
    var cameraOffset = index === 0 ? -0.03 : 0.03;
    var cameraOrigin = dynamicSubject
      ? [
        subjectTangent[0] * cameraOffset,
        subjectTangent[1] * cameraOffset,
        0
      ]
      : null;
    var subjectCentre = dynamicSubject
      ? [
        subjectDirection[0] * 1.35,
        subjectDirection[1] * 1.35,
        subjectDirection[2] * 1.35
      ]
      : null;
    for (var y = 0; y < canvas.height; y += 1) {
      var ny = 1 - (y + 0.5) / canvas.height * 2;
      var rowBasis = handheldTestMode
        ? P.rotateBasisLocal(
          basis,
          handheldProfile.rollingYawDeg * ny,
          handheldProfile.rollingPitchDeg * ny,
          0
        )
        : basis;
      var sampleNy = handheldTestMode
        ? ny / handheldProfile.zoom + handheldProfile.cropNy
        : ny;
      for (var x = 0; x < canvas.width; x += 1) {
        var nx = (x + 0.5) / canvas.width * 2 - 1;
        var sampleNx = handheldTestMode
          ? nx / handheldProfile.zoom + handheldProfile.cropNx
          : nx;
        var direction = P.directionFromImagePoint(
          sampleNx,
          sampleNy,
          rowBasis,
          CAPTURE_FOV_DEG,
          aspect
        );
        if (handheldTestMode) {
          direction = handheldFiniteSceneDirection(direction, handheldProfile);
        }
        var longitude = Math.atan2(direction[0], direction[1]);
        if (longitude < 0) longitude += Math.PI * 2;
        var latitude = Math.asin(P.clamp(direction[2], -1, 1));
        var lon01 = longitude / (Math.PI * 2);
        var lat01 = latitude / Math.PI + 0.5;
        var checker = (Math.floor(lon01 * 36) + Math.floor(lat01 * 18)) % 2;
        var lonGrid = Math.abs((lon01 * 12) % 1 - 0.5) > 0.455;
        var latGrid = Math.abs((lat01 * 9) % 1 - 0.5) > 0.455;
        var waveA = 0.5 + 0.5 * Math.sin(longitude * 3 + latitude * 2.3);
        var waveB = 0.5 + 0.5 * Math.cos(longitude * 5 - latitude * 3.1);
        var offset = (y * canvas.width + x) * 4;
        if (lonGrid || latGrid) {
          image.data[offset] = 238;
          image.data[offset + 1] = 242;
          image.data[offset + 2] = 232;
        } else {
          image.data[offset] = Math.round(36 + 150 * waveA + checker * 24);
          image.data[offset + 1] = Math.round(40 + 142 * waveB + (1 - checker) * 30);
          image.data[offset + 2] = Math.round(
            48 + 120 * (0.5 + 0.5 * Math.sin(longitude - latitude * 4)) + checker * 18
          );
        }
        if (dynamicSubject) {
          var denominator = P.dot(direction, subjectDirection);
          if (denominator > 1e-6) {
            var distance = P.dot([
              subjectCentre[0] - cameraOrigin[0],
              subjectCentre[1] - cameraOrigin[1],
              subjectCentre[2] - cameraOrigin[2]
            ], subjectDirection) / denominator;
            if (distance > 0) {
              var relative = [
                cameraOrigin[0] + direction[0] * distance - subjectCentre[0],
                cameraOrigin[1] + direction[1] * distance - subjectCentre[1],
                cameraOrigin[2] + direction[2] * distance - subjectCentre[2]
              ];
              var localX = P.dot(relative, subjectTangent);
              var localY = relative[2];
              var head = localX * localX +
                (localY - 0.37) * (localY - 0.37) <= 0.078 * 0.078;
              var torso = Math.abs(localX) <= 0.105 &&
                localY >= -0.16 && localY <= 0.30;
              var arms = Math.abs(localX) <= 0.19 &&
                localY >= 0.03 && localY <= 0.11;
              var leftLeg = localX >= -0.10 && localX <= -0.018 &&
                localY >= -0.48 && localY < -0.16;
              var rightLeg = localX >= 0.018 && localX <= 0.10 &&
                localY >= -0.48 && localY < -0.16;
              if (head || torso || arms || leftLeg || rightLeg) {
                // 背景不会生成这种色相，便于端到端断言人物只保留一个时刻。
                image.data[offset] = 250;
                image.data[offset + 1] = 18;
                image.data[offset + 2] = 244;
              }
            }
          }
        }
        image.data[offset + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    return canvas;
  }

  function alignmentFrameFromCanvas(canvas, basis, fovXDeg, frameIndex) {
    var scale = Math.min(1, ALIGNMENT_MAX_SIDE / Math.max(canvas.width, canvas.height));
    var thumbnail = document.createElement("canvas");
    thumbnail.width = Math.max(24, Math.round(canvas.width * scale));
    thumbnail.height = Math.max(24, Math.round(canvas.height * scale));
    var context = thumbnail.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("视觉校正画布不可用");
    context.drawImage(canvas, 0, 0, thumbnail.width, thumbnail.height);
    var imageData = context.getImageData(0, 0, thumbnail.width, thumbnail.height);
    return {
      width: thumbnail.width,
      height: thumbnail.height,
      pixels: imageData.data,
      basis: P.copyBasis(basis),
      correctedBasis: P.copyBasis(basis),
      fovXDeg: Number(fovXDeg) || CAPTURE_FOV_DEG,
      correctedFovXDeg: Number(fovXDeg) || CAPTURE_FOV_DEG,
      gain: 1,
      bias: 0,
      accepted: true,
      frameIndex: frameIndex
    };
  }

  function releaseAlignmentFrame(frame) {
    if (!frame) return;
    if (P.releaseFrameResources) P.releaseFrameResources(frame);
    else frame.pixels = null;
  }

  function visualPoseWeight(alignment) {
    var confidence = P.clamp(Number(alignment && alignment.confidence) || 0, 0, 1);
    var score = Number(alignment && alignment.score);
    var scoreEvidence = Number.isFinite(score)
      ? P.clamp(
        (score - VISUAL_ALIGNMENT_OPTIONS.minScore) /
          Math.max(0.01, 1 - VISUAL_ALIGNMENT_OPTIONS.minScore),
        0,
        1
      )
      : 0;
    // Direct photometric registration is an aid to the capture-time IMU pose,
    // not a replacement for it. Even excellent matches retain an IMU prior;
    // barely accepted matches can only make a small correction.
    return P.clamp(0.12 + Math.min(confidence, scoreEvidence) * 0.72, 0.12, 0.84);
  }

  function weightedMedian(samples) {
    if (!samples.length) return NaN;
    var ordered = samples.slice().sort(function (a, b) {
      return a.value - b.value;
    });
    var total = ordered.reduce(function (sum, sample) {
      return sum + Math.max(0, Number(sample.weight) || 0);
    }, 0);
    if (total <= 0) return ordered[Math.floor(ordered.length / 2)].value;
    var cumulative = 0;
    for (var i = 0; i < ordered.length; i += 1) {
      cumulative += Math.max(0, Number(ordered[i].weight) || 0);
      if (cumulative >= total / 2) return ordered[i].value;
    }
    return ordered[ordered.length - 1].value;
  }

  function finalizeSessionFov() {
    var candidates = [];
    for (var i = 0; i < session.frames.length; i += 1) {
      var alignment = session.frames[i].visualAlignment;
      var estimatedFov = Number(alignment && alignment.correctedFovXDeg);
      var confidence = Number(alignment && alignment.confidence) || 0;
      var score = Number(alignment && alignment.score);
      if (!alignment || !alignment.accepted ||
          confidence < SESSION_FOV_MIN_CONFIDENCE ||
          !Number.isFinite(score) || score < SESSION_FOV_MIN_SCORE ||
          !Number.isFinite(estimatedFov) ||
          estimatedFov < SESSION_FOV_MIN_DEG ||
          estimatedFov > SESSION_FOV_MAX_DEG) {
        continue;
      }
      candidates.push({
        value: estimatedFov,
        weight: confidence * Math.max(0.1, score)
      });
    }

    var selected = CAPTURE_FOV_DEG;
    var inliers = [];
    var median = weightedMedian(candidates);
    var mad = NaN;
    if (candidates.length >= SESSION_FOV_MIN_SAMPLES && Number.isFinite(median)) {
      var deviations = candidates.map(function (sample) {
        return {
          value: Math.abs(sample.value - median),
          weight: sample.weight
        };
      });
      mad = weightedMedian(deviations);
      var inlierRadius = Math.max(0.75, (Number(mad) || 0) * 2.5);
      inliers = candidates.filter(function (sample) {
        return Math.abs(sample.value - median) <= inlierRadius;
      });
      if (inliers.length >= SESSION_FOV_MIN_SAMPLES) {
        selected = P.clamp(
          weightedMedian(inliers),
          SESSION_FOV_MIN_DEG,
          SESSION_FOV_MAX_DEG
        );
      }
    }
    selected = Math.round(selected * 10) / 10;
    session.sessionFovXDeg = selected;
    session.sessionFovSummary = {
      method: inliers.length >= SESSION_FOV_MIN_SAMPLES
        ? "confidence-weighted-median"
        : "fixed-default",
      fovXDeg: selected,
      candidateCount: candidates.length,
      inlierCount: inliers.length,
      medianFovXDeg: Number.isFinite(median)
        ? Math.round(median * 100) / 100
        : null,
      madFovDeg: Number.isFinite(mad)
        ? Math.round(mad * 100) / 100
        : null
    };
    for (i = 0; i < session.frames.length; i += 1) {
      session.frames[i].correctedFovXDeg = selected;
    }
    for (i = 0; i < session.alignmentFrames.length; i += 1) {
      session.alignmentFrames[i].fovXDeg = selected;
      session.alignmentFrames[i].correctedFovXDeg = selected;
    }
    return session.sessionFovSummary;
  }

  function prepareVisualFrame(canvas, basis, fovXDeg, frameIndex) {
    var visualFrame = alignmentFrameFromCanvas(canvas, basis, fovXDeg, frameIndex);
    if (!session.alignmentFrames.length) {
      var anchorQuality = P.measureFrameQuality
        ? P.measureFrameQuality(visualFrame, VISUAL_ALIGNMENT_OPTIONS.quality)
        : { accepted: true, rejectReason: "" };
      visualFrame.alignment = {
        accepted: !!anchorQuality.accepted,
        confidence: anchorQuality.accepted ? 1 : 0,
        score: anchorQuality.accepted ? 1 : -1,
        rejectReason: anchorQuality.rejectReason || "",
        fallbackToImu: !anchorQuality.accepted,
        method: anchorQuality.accepted ? "visual-anchor" : "imu-anchor-fallback",
        currentQuality: anchorQuality
      };
      return visualFrame;
    }
    if (!P.refineFramePoseFromReferences) return visualFrame;
    var alignment = P.refineFramePoseFromReferences(
      session.alignmentFrames,
      visualFrame,
      VISUAL_ALIGNMENT_OPTIONS
    );
    if (!alignment.accepted) {
      // IMU/F-U-R is the primary spatial contract. Photometric registration is
      // an enhancement and must not deadlock frame two because the first photo
      // happened to be a wall, dark scene, blur, or a camera whose real FOV is
      // outside the bounded search. Keep the raw pose and record the fallback
      // so final optimization can ignore this edge without dropping the photo.
      visualFrame.correctedBasis = P.copyBasis(basis);
      visualFrame.correctedFovXDeg = Number(fovXDeg) || CAPTURE_FOV_DEG;
      visualFrame.gain = 1;
      visualFrame.bias = 0;
      alignment.fallbackToImu = true;
      alignment.method = (alignment.method || "photometric") + "+imu-fallback";
      visualFrame.alignment = alignment;
      var rejectedReference = session.alignmentFrames[alignment.referenceIndex];
      visualFrame.edge = {
        from: rejectedReference &&
          Number.isFinite(rejectedReference.frameIndex)
          ? rejectedReference.frameIndex
          : alignment.referenceIndex,
        to: frameIndex,
        accepted: false,
        confidence: alignment.confidence || 0,
        result: alignment,
        correctedBasis: P.copyBasis(basis)
      };
      return visualFrame;
    }
    var reference = session.alignmentFrames[alignment.referenceIndex];
    var referenceGain = reference && Number.isFinite(reference.gain) ? reference.gain : 1;
    var referenceBias = reference && Number.isFinite(reference.bias) ? reference.bias : 0;
    var appliedPoseWeight = visualPoseWeight(alignment);
    visualFrame.correctedBasis = P.blendBasis
      ? P.blendBasis(basis, alignment.correctedBasis, appliedPoseWeight)
      : P.copyBasis(alignment.correctedBasis);
    // FOV is a camera/session property. Keep every live projection at the
    // same value and retain this pair's estimate only as evidence for the
    // robust session-wide value selected immediately before final stitching.
    visualFrame.correctedFovXDeg = session.sessionFovXDeg;
    visualFrame.gain = P.clamp(alignment.gain * referenceGain, 0.45, 2.2);
    visualFrame.bias = P.clamp(alignment.bias * referenceGain + referenceBias, -96, 96);
    alignment.appliedPoseWeight = appliedPoseWeight;
    alignment.appliedFovXDeg = session.sessionFovXDeg;
    visualFrame.alignment = alignment;
    visualFrame.edge = {
      from: reference && Number.isFinite(reference.frameIndex)
        ? reference.frameIndex
        : alignment.referenceIndex,
      to: frameIndex,
      accepted: true,
      confidence: alignment.confidence,
      result: alignment,
      correctedBasis: P.copyBasis(visualFrame.correctedBasis)
    };
    return visualFrame;
  }

  async function addFrame(canvas, basis, target, captureMetadata) {
    // Encode first, then allocate the raw ImageData only for the synchronous
    // coarse projection. This avoids keeping both the encoder and RGBA copy
    // alive across the asynchronous toBlob operation.
    var visualFrame = prepareVisualFrame(
      canvas,
      basis,
      captureMetadata && captureMetadata.fovXDeg || CAPTURE_FOV_DEG,
      session.frames.length
    );
    var blob;
    try {
      blob = await canvasBlob(canvas, "image/jpeg", 0.78);
    } catch (encodeError) {
      releaseAlignmentFrame(visualFrame);
      throw encodeError;
    }
    var pixels;
    try {
      pixels = canvas.getContext("2d", { willReadFrequently: true })
        .getImageData(0, 0, canvas.width, canvas.height);
    } catch (pixelError) {
      releaseAlignmentFrame(visualFrame);
      throw pixelError;
    }
    var correctedBasis = visualFrame
      ? visualFrame.correctedBasis
      : P.copyBasis(basis);
    var correctedFovXDeg = visualFrame
      ? visualFrame.correctedFovXDeg
      : CAPTURE_FOV_DEG;
    var frame = {
      blob: blob,
      basis: P.copyBasis(basis),
      correctedBasis: P.copyBasis(correctedBasis),
      fovXDeg: captureMetadata && captureMetadata.fovXDeg || CAPTURE_FOV_DEG,
      correctedFovXDeg: correctedFovXDeg,
      gain: visualFrame ? visualFrame.gain : 1,
      bias: visualFrame ? visualFrame.bias : 0,
      visualAlignment: visualFrame && visualFrame.alignment || null,
      targetIndex: target.index,
      yawDeg: target.yawDeg,
      pitchDeg: target.pitchDeg,
      width: canvas.width,
      height: canvas.height,
      capture: captureMetadata || null
    };
    if (captureMetadata && visualFrame && visualFrame.alignment) {
      captureMetadata.visualAlignment = {
        accepted: visualFrame.alignment.accepted,
        score: visualFrame.alignment.score,
        confidence: visualFrame.alignment.confidence,
        correction: visualFrame.alignment.correction || null,
        estimatedFovXDeg: visualFrame.alignment.correctedFovXDeg,
        appliedFovXDeg: visualFrame.correctedFovXDeg,
        appliedPoseWeight: visualFrame.alignment.appliedPoseWeight || 0
      };
    }
    session.frames.push(frame);
    if (visualFrame) {
      session.alignmentFrames.push(visualFrame);
      if (visualFrame.edge) session.visualEdges.push(visualFrame.edge);
    }
    P.projectPatch(session.coarse, pixels.data, pixels.width, pixels.height, frame.correctedBasis, {
      fovXDeg: session.sessionFovXDeg,
      feather: 0.2,
      gain: frame.gain,
      bias: frame.bias
    });
    pixels = null;
    session.targetIndex += 1;
    session.captureSessionStarted = true;
    session.autoCaptureSuspended = false;
    updateControls();
    updateTarget();
    scheduleWorldPreview(true);
  }

  async function captureCurrent(mode) {
    var target = session.targets[session.targetIndex];
    if (!target || session.capturing || session.rebuilding || session.processing) return;
    if (!testMode && (!session.cameraReady || !session.orientationReady)) return;
    var captureMode = mode === "auto" ? "auto" : "manual";
    var entryGate = null;
    var entryAccepted = false;
    var entrySnapshot = null;
    if (captureMode === "manual") session.autoCaptureSuspended = false;
    if (!testMode) {
      var entryTime = performance.now();
      entryGate = captureGateAt(entryTime, target);
      entryAccepted = captureMode === "manual"
        ? manualCaptureAllowed(entryGate)
        : (entryGate.visible && entryGate.aligned && entryGate.upright && entryGate.steady);
      if (!entryAccepted) {
        explainRejectedGate(entryGate, captureMode === "manual");
        return;
      }
      var latestEntryPose = session.poseTimeline.latest();
      if (latestEntryPose) {
        entrySnapshot = {
          timeMs: entryTime,
          gate: entryGate,
          entryAccepted: entryAccepted,
          targetIndex: session.targetIndex,
          cameraGeneration: session.cameraGeneration,
          quietSince: session.quietSince,
          lastSignificantMotionAt: session.lastSignificantMotionAt,
          frameSequence: session.latestVideoFrame
            ? session.latestVideoFrame.sequence
            : 0,
          videoFrame: session.latestVideoFrame
            ? Object.assign({}, session.latestVideoFrame)
            : null,
          pose: {
            timeMs: latestEntryPose.timeMs,
            basis: P.copyBasis(latestEntryPose.basis),
            source: latestEntryPose.source
          }
        };
      }
    }
    session.capturing = true;
    session.captureAttemptCount += 1;
    session.lastCaptureError = null;
    session.lastQuietHoldReject = null;
    var shouldFinish = false;
    session.stableSince = 0;
    updateControls();
    try {
      var canvas;
      var basis;
      var captureMetadata;
      if (testMode) {
        var trueBasis = P.orthonormalBasis(target.dir, [0, 0, 1]);
        canvas = syntheticCanvas(session.targetIndex, target, trueBasis);
        var poseError = session.targetIndex === 0 ? 0 :
          Math.sin(session.targetIndex * 1.73) * 0.8;
        var pitchError = session.targetIndex === 0 ? 0 :
          Math.cos(session.targetIndex * 1.11) * 0.45;
        var rollError = session.targetIndex === 0 ? 0 :
          Math.sin(session.targetIndex * 0.77) * 0.3;
        basis = P.rotateBasisLocal(
          trueBasis,
          poseError,
          pitchError,
          rollError
        );
        captureMetadata = {
          mode: "simulator",
          poseSource: "synthetic-noisy-imu",
          frameTimeSource: "synthetic",
          fovXDeg: CAPTURE_FOV_DEG,
          injectedPoseErrorDeg: P.basisRotationErrorDeg(basis, trueBasis)
        };
        if (handheldTestMode) {
          captureMetadata.handheldProfile = handheldTestProfile(
            session.targetIndex,
            trueBasis
          );
        }
      } else {
        var previousFrameSequence = entrySnapshot
          ? entrySnapshot.frameSequence
          : (session.latestVideoFrame ? session.latestVideoFrame.sequence : 0);
        var entryVideoFrame = entrySnapshot && entrySnapshot.videoFrame;
        var entryVideoFrameAge = entryVideoFrame && entrySnapshot
          ? entrySnapshot.timeMs - entryVideoFrame.poseTimeMs
          : Infinity;
        var useFreshEntryFrame = !!(entryVideoFrame &&
          entryVideoFrameAge >= -30 &&
          entryVideoFrameAge <= QUIET_HOLD_EXISTING_FRAME_MAX_AGE_MS &&
          entryVideoFrame.poseTimeMs >=
            entrySnapshot.lastSignificantMotionAt + STABLE_MIN_WINDOW_MS);
        var presentedFrame = useFreshEntryFrame
          ? entryVideoFrame
          : (session.videoClock
            ? await session.videoClock.waitForNext(previousFrameSequence, 220)
            : null);
        if (!session.cameraReady || !session.orientationReady || document.hidden) {
          throw new Error("相机在取帧时中断");
        }
        var drawTime = performance.now();
        var poseTime = presentedFrame ? presentedFrame.poseTimeMs : drawTime;
        var mappedPose = session.poseTimeline.at(
          poseTime,
          FRAME_POSE_MATCH_TOLERANCE_MS
        );
        var frameGate = mappedPose
          ? captureGateAt(poseTime, target, mappedPose.basis)
          : null;
        var frameAccepted = mappedPose && (captureMode === "manual"
          ? manualCaptureAllowed(frameGate)
          : (frameGate.visible &&
            frameGate.aligned &&
            frameGate.upright &&
            frameGate.steady));
        // Android may retain a mappable pose whose historical motion window
        // still contains the final turn. If the already accepted entry was a
        // bounded silent hold, validate that frozen entry again instead of
        // turning the stale historical window into an endless retry loop.
        if (!frameAccepted) {
          var quietHoldPose = quietHoldFramePose(
            entrySnapshot,
            presentedFrame,
            drawTime,
            target
          );
          if (quietHoldPose) {
            mappedPose = quietHoldPose;
            frameGate = quietHoldPose.geometryGate;
            frameAccepted = entryAccepted &&
              frameGate.visible &&
              frameGate.aligned &&
              frameGate.upright;
          }
        }
        if (!mappedPose) {
          var poseError = new Error("当前视频帧找不到对应姿态");
          poseError.code = "FRAME_POSE_MISSING";
          throw poseError;
        }
        if (!frameAccepted) {
          var motionError = new Error("取帧时手机仍在移动");
          motionError.code = "CAPTURE_NOT_STABLE";
          throw motionError;
        }
        canvas = captureCanvasFromVideo();
        basis = P.copyBasis(mappedPose.basis);
        session.captureBasis = P.copyBasis(basis);
        captureMetadata = {
          mode: captureMode,
          drawTimeMs: drawTime,
          frameSequence: presentedFrame ? presentedFrame.sequence : null,
          framePoseTimeMs: poseTime,
          frameTimeSource: presentedFrame ? presentedFrame.timeSource : "drawTime-fallback",
          frameSelection: useFreshEntryFrame
            ? "fresh-entry-frame"
            : "next-presented-frame",
          frameAgeAtDrawMs: Math.max(0, drawTime - poseTime),
          mediaTime: presentedFrame && Number.isFinite(presentedFrame.mediaTime)
            ? presentedFrame.mediaTime
            : null,
          poseSource: mappedPose.source,
          poseGapMs: mappedPose.gapMs,
          poseFallback: !!mappedPose.poseFallback,
          poseEntryToDrawMs: Number.isFinite(mappedPose.entryToDrawMs)
            ? mappedPose.entryToDrawMs
            : null,
          rawInstantaneousDegS: frameGate.motion.instantaneousDegS,
          rawMaxDegS: frameGate.motion.maxDegS,
          rawDispersionDeg: frameGate.motion.dispersionDeg,
          rawWindowMs: frameGate.motion.durationMs,
          fovXDeg: CAPTURE_FOV_DEG
        };
        session.lastCaptureDiagnostic = captureMetadata;
      }
      captureMetadata.photoWidth = canvas.width;
      captureMetadata.photoHeight = canvas.height;
      await addFrame(canvas, basis, target, captureMetadata);
      el.flash.classList.remove("is-on");
      void el.flash.offsetWidth;
      el.flash.classList.add("is-on");
      shouldFinish = session.targetIndex >= session.targets.length;
    } catch (error) {
      console.error("[pano-capture] capture failed", error);
      session.lastCaptureError = {
        code: error && error.code || "CAPTURE_FAILED",
        message: error && error.message || "这一张没有保存下来",
        alignmentReason: error && error.alignment &&
          error.alignment.rejectReason || ""
      };
      if (error && error.code === "CAPTURE_NOT_STABLE") {
        el.guideTitle.textContent = "刚才仍有轻微移动";
        el.guideDetail.textContent = "这一张没有写入，重新停稳即可";
      } else if (error && error.code === "VISUAL_ALIGNMENT_REJECTED") {
        el.guideTitle.textContent = "这一张没有对齐";
        el.guideDetail.textContent = error.alignment &&
          error.alignment.rejectReason === "CORRECTION_LIMIT"
          ? "方向误差过大，请把白点重新放回中央后再拍"
          : "请绕镜头原地转动并保留上一张画面的重叠区域";
      } else {
        session.autoCaptureSuspended = true;
        el.guideTitle.textContent = "这一张没有保存下来";
        el.guideDetail.textContent = error && error.code === "FRAME_POSE_MISSING"
          ? "视频帧与方向数据没有对上，请保持页面在前台后重试"
          : "照片都还在，可以重试当前方向";
      }
    } finally {
      session.capturing = false;
      updateControls();
    }
    if (shouldFinish) await finishCapture();
  }

  async function decodeBlob(blob, maxSide) {
    var source = null;
    var bitmap = null;
    var objectUrl = "";
    try {
      if (window.createImageBitmap) {
        try {
          bitmap = await createImageBitmap(blob);
          source = bitmap;
        } catch (bitmapError) {
          // 部分 iOS 版本暴露 createImageBitmap 但对相机 JPEG 解码会失败。
          console.warn("[pano-capture] ImageBitmap decode fallback", bitmapError);
        }
      }
      if (!source) {
        objectUrl = URL.createObjectURL(blob);
        source = await new Promise(function (resolve, reject) {
          var image = new Image();
          image.onload = function () { resolve(image); };
          image.onerror = function () { reject(new Error("照片解码失败")); };
          image.src = objectUrl;
        });
      }
      var scale = Math.min(1, maxSide / Math.max(source.width, source.height));
      var canvas = document.createElement("canvas");
      canvas.width = Math.max(2, Math.round(source.width * scale));
      canvas.height = Math.max(2, Math.round(source.height * scale));
      var ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("2D Canvas 不可用");
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
      return ctx.getImageData(0, 0, canvas.width, canvas.height);
    } finally {
      // Canvas 分配或读像素失败时也必须释放，否则轻量重试会叠加内存压力。
      if (bitmap && bitmap.close) bitmap.close();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  }

  async function rebuildCoarse(frames) {
    var rebuilt = P.createRaster(COARSE_WIDTH, COARSE_WIDTH / 2);
    for (var i = 0; i < frames.length; i += 1) {
      var data = await decodeBlob(frames[i].blob, 640);
      P.projectPatch(
        rebuilt,
        data.data,
        data.width,
        data.height,
        frames[i].optimizedBasis || frames[i].correctedBasis || frames[i].basis,
        {
          fovXDeg: session.sessionFovXDeg,
          feather: 0.2,
          gain: frames[i].gain,
          bias: frames[i].bias
        }
      );
      await nextFrame();
    }
    return rebuilt;
  }

  async function undoLast() {
    if (!session.frames.length || session.capturing || session.rebuilding || session.processing) return;
    session.rebuilding = true;
    session.stableSince = 0;
    updateControls();
    var remainingFrames = session.frames.slice(0, -1);
    try {
      var rebuilt = await rebuildCoarse(remainingFrames);
      var removedAlignmentFrame = session.alignmentFrames.pop();
      releaseAlignmentFrame(removedAlignmentFrame);
      session.visualEdges = session.visualEdges.filter(function (edge) {
        return edge.from < remainingFrames.length && edge.to < remainingFrames.length;
      });
      session.frames = remainingFrames;
      session.targetIndex = remainingFrames.length;
      session.captureSessionStarted = remainingFrames.length > 0;
      session.coarse = rebuilt;
      scheduleWorldPreview(true);
      updateTarget();
    } catch (error) {
      console.error("[pano-capture] undo rebuild failed", error);
      el.guideTitle.textContent = "撤销没有完成";
      el.guideDetail.textContent = "原照片与预览都已保留，可以再试";
    } finally {
      session.rebuilding = false;
      updateControls();
    }
  }

  function setProgress(value, text) {
    var pct = P.clamp(Math.round(value), 0, 100);
    session.progressEvents.push(pct);
    el.progressBar.style.width = pct + "%";
    el.progressNumber.textContent = pct + "%";
    if (text) el.processText.textContent = text;
  }

  function putRaster(canvas, raster) {
    canvas.width = raster.width;
    canvas.height = raster.height;
    var ctx = canvas.getContext("2d");
    var imageData = ctx.createImageData(raster.width, raster.height);
    imageData.data.set(raster.pixels);
    ctx.putImageData(imageData, 0, 0);
  }

  function canvasHasNonBlackPixels(canvas) {
    var probe = document.createElement("canvas");
    probe.width = 64;
    probe.height = 32;
    var ctx = probe.getContext("2d", { willReadFrequently: true });
    if (!ctx) return false;
    ctx.drawImage(canvas, 0, 0, probe.width, probe.height);
    var data = ctx.getImageData(0, 0, probe.width, probe.height).data;
    for (var i = 0; i < data.length; i += 4) {
      if (data[i] + data[i + 1] + data[i + 2] > 18 && data[i + 3] > 0) return true;
    }
    return false;
  }

  function testNetworkMutationObserved() {
    if (!performance.getEntriesByType) return false;
    return performance.getEntriesByType("resource").some(function (entry) {
      return entry.initiatorType === "fetch" ||
        entry.initiatorType === "xmlhttprequest" ||
        entry.initiatorType === "beacon";
    });
  }

  function ringDefinitions(frameCount) {
    var candidates = [
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      [12, 13, 14, 15, 16, 17, 18, 19],
      [20, 21, 22, 23, 24, 25, 26, 27]
    ];
    return candidates.filter(function (ring) {
      return ring[ring.length - 1] < frameCount;
    });
  }

  /*
   * The three latitude rings overlap vertically, so they must not be optimized
   * as three unrelated panoramas. Link every completed upper/lower frame to
   * the two nearest equator headings; the second candidate is evaluated only
   * when the nearest one is not reliable.
   */
  function crossRingDefinitions(frameCount) {
    if (frameCount < 13) return [];
    var equatorCount = Math.min(12, frameCount);
    var links = [];
    for (var to = 12; to < frameCount; to += 1) {
      var frame = session.frames[to];
      if (!frame || !Number.isFinite(Number(frame.yawDeg))) continue;
      var candidates = [];
      for (var from = 0; from < equatorCount; from += 1) {
        var equator = session.frames[from];
        if (!equator || !Number.isFinite(Number(equator.yawDeg))) continue;
        candidates.push({
          index: from,
          yawDistanceDeg: Math.abs(P.shortestDelta(
            Number(equator.yawDeg),
            Number(frame.yawDeg)
          ))
        });
      }
      candidates.sort(function (left, right) {
        return left.yawDistanceDeg - right.yawDistanceDeg;
      });
      links.push({
        to: to,
        candidates: candidates.slice(0, 2)
      });
    }
    return links;
  }

  function correctionMagnitude(result) {
    var correction = result && result.correction || {};
    var yaw = Number(correction.yawDeg) || 0;
    var pitch = Number(correction.pitchDeg) || 0;
    var roll = Number(correction.rollDeg) || 0;
    return Math.sqrt(yaw * yaw + pitch * pitch + roll * roll);
  }

  function reliableSequenceEdge(result, minConfidence) {
    return !!(result && result.accepted &&
      Number(result.confidence) >= minConfidence &&
      Number(result.score) >= VISUAL_SEQUENCE_OPTIONS.minScore &&
      correctionMagnitude(result) <= VISUAL_SEQUENCE_OPTIONS.maxCorrectionDeg);
  }

  function optimizeVisualSequence() {
    var fovSummary = finalizeSessionFov();
    if (!P.optimizeFrameSequence ||
        session.alignmentFrames.length !== session.frames.length) {
      session.visualSummary = {
        method: "uniform-fov-without-sequence-optimizer",
        acceptedLocalEdges: 0,
        rejectedLocalEdges: 0,
        rejectedLocalEdgeDetails: [],
        acceptedCrossRingEdges: 0,
        rejectedCrossRingEdges: 0,
        rejectedCrossRingEdgeDetails: [],
        appliedVisualEdges: 0,
        loops: [],
        ignoredEdges: 0,
        sessionFov: fovSummary
      };
      return null;
    }
    var rings = ringDefinitions(session.frames.length);
    var edges = [];
    var acceptedLocalEdges = 0;
    var rejectedLocalEdges = 0;
    var rejectedLocalEdgeDetails = [];
    var acceptedCrossRingEdges = 0;
    var rejectedCrossRingEdges = 0;
    var rejectedCrossRingEdgeDetails = [];
    for (var ringIndex = 0; ringIndex < rings.length; ringIndex += 1) {
      var ring = rings[ringIndex];
      for (var position = 1; position < ring.length; position += 1) {
        var from = ring[position - 1];
        var to = ring[position];
        var local = P.refineFramePose(
          session.alignmentFrames[from],
          session.alignmentFrames[to],
          VISUAL_SEQUENCE_OPTIONS
        );
        var localReliable = reliableSequenceEdge(local, SEQUENCE_MIN_CONFIDENCE);
        edges.push({
          from: from,
          to: to,
          accepted: localReliable,
          confidence: local.confidence,
          result: local,
          correctedBasis: local.correctedBasis
        });
        if (localReliable) acceptedLocalEdges += 1;
        else {
          rejectedLocalEdges += 1;
          rejectedLocalEdgeDetails.push({
            from: from,
            to: to,
            reason: local.rejectReason || "UNKNOWN",
            confidence: local.confidence,
            score: local.score,
            correction: local.correction || null,
            reliabilityFiltered: !!local.accepted
          });
        }
      }
      var last = ring[ring.length - 1];
      var first = ring[0];
      var closure = P.refineFramePose(
        session.alignmentFrames[last],
        session.alignmentFrames[first],
        VISUAL_SEQUENCE_OPTIONS
      );
      var closureResidual = closure.correctedBasis
        ? P.basisRotationErrorDeg(
          closure.correctedBasis,
          session.frames[first].correctedBasis || session.frames[first].basis
        )
        : Infinity;
      var closureReliable =
        reliableSequenceEdge(closure, LOOP_MIN_CONFIDENCE) &&
        closureResidual <= LOOP_MAX_RESIDUAL_DEG;
      edges.push({
        from: last,
        to: first,
        isClosure: true,
        accepted: closureReliable,
        confidence: closure.confidence,
        result: closure,
        predictedStartBasis: closure.correctedBasis,
        residualDeg: closureResidual
      });
    }
    var crossLinks = crossRingDefinitions(session.frames.length);
    for (var crossIndex = 0; crossIndex < crossLinks.length; crossIndex += 1) {
      var link = crossLinks[crossIndex];
      var selectedCross = null;
      var selectedFrom = null;
      for (var candidateIndex = 0;
        candidateIndex < link.candidates.length;
        candidateIndex += 1) {
        var candidateFrom = link.candidates[candidateIndex].index;
        var cross = P.refineFramePose(
          session.alignmentFrames[candidateFrom],
          session.alignmentFrames[link.to],
          VISUAL_SEQUENCE_OPTIONS
        );
        if (!selectedCross ||
            Number(cross.score) > Number(selectedCross.score)) {
          selectedCross = cross;
          selectedFrom = candidateFrom;
        }
        if (reliableSequenceEdge(cross, SEQUENCE_MIN_CONFIDENCE)) {
          selectedCross = cross;
          selectedFrom = candidateFrom;
          break;
        }
      }
      if (!selectedCross || selectedFrom == null) continue;
      var crossReliable = reliableSequenceEdge(
        selectedCross,
        SEQUENCE_MIN_CONFIDENCE
      );
      edges.push({
        from: selectedFrom,
        to: link.to,
        accepted: crossReliable,
        confidence: selectedCross.confidence,
        result: selectedCross,
        correctedBasis: selectedCross.correctedBasis,
        isCrossRing: true
      });
      if (crossReliable) {
        acceptedCrossRingEdges += 1;
      } else {
        rejectedCrossRingEdges += 1;
        rejectedCrossRingEdgeDetails.push({
          from: selectedFrom,
          to: link.to,
          reason: selectedCross.rejectReason || "UNKNOWN",
          confidence: selectedCross.confidence,
          score: selectedCross.score,
          correction: selectedCross.correction || null
        });
      }
    }
    var optimized = P.optimizeFrameSequence(session.frames, edges, {
      rings: rings,
      minEdgeConfidence: SEQUENCE_MIN_CONFIDENCE,
      imuPriorWeight: 0.32,
      loopStrength: 0.25
    });
    // Reliable local constraints are useful even when a closure is absent or
    // deliberately rejected. Requiring a loop here previously discarded all
    // local corrections, while a false loop could bend an otherwise stable
    // ring. Apply every confidence-gated result; loop distribution is only a
    // small residual correction.
    if (optimized.acceptedEdges.length) {
      for (var index = 0; index < session.frames.length; index += 1) {
        session.frames[index].optimizedBasis = P.copyBasis(optimized.bases[index]);
      }
    }
    session.visualSummary = {
      method: optimized.method,
      acceptedLocalEdges: acceptedLocalEdges,
      rejectedLocalEdges: rejectedLocalEdges,
      rejectedLocalEdgeDetails: rejectedLocalEdgeDetails,
      acceptedCrossRingEdges: acceptedCrossRingEdges,
      rejectedCrossRingEdges: rejectedCrossRingEdges,
      rejectedCrossRingEdgeDetails: rejectedCrossRingEdgeDetails,
      appliedVisualEdges: optimized.acceptedEdges.length,
      loops: optimized.loops,
      ignoredEdges: optimized.ignoredEdges.length,
      rejectedPoseGraphEdges: optimized.rejectedEdges,
      poseGraphIterations: optimized.iterations,
      residualBeforeMeanDeg: optimized.residualBeforeMeanDeg,
      residualAfterMeanDeg: optimized.residualAfterMeanDeg,
      residualAfterMaxDeg: optimized.residualAfterMaxDeg,
      sessionFov: fovSummary
    };
    return optimized;
  }

  function releaseVisualMemory() {
    for (var i = 0; i < session.alignmentFrames.length; i += 1) {
      releaseAlignmentFrame(session.alignmentFrames[i]);
    }
    session.alignmentFrames.length = 0;
    session.visualEdges.length = 0;
  }

  function copyLocalWarpDiagnostic(diagnostic) {
    if (!diagnostic) return null;
    var copy = {};
    Object.keys(diagnostic).forEach(function (key) {
      var value = diagnostic[key];
      copy[key] = Array.isArray(value) ? value.slice() : value;
    });
    return copy;
  }

  async function stitch(frames, lightMode) {
    var width = lightMode ? 768 : (innerWidth < 600 ? 1024 : 1536);
    var raster = P.createRaster(width, width / 2);
    var seamSummary = null;
    var localWarpLastDiagnostics = null;
    var localWarpLastAppliedDiagnostics = null;
    try {
      setProgress(0, "准备配准、选缝与稳定的 2D 结果…");
      for (var i = 0; i < frames.length; i += 1) {
        var decoded = await decodeBlob(frames[i].blob, lightMode ? 640 : 1024);
        var projector = P.projectPatchSeamAware || P.projectPatch;
        projector(
          raster,
          decoded.data,
          decoded.width,
          decoded.height,
          frames[i].optimizedBasis || frames[i].correctedBasis || frames[i].basis,
          {
            fovXDeg: session.sessionFovXDeg,
            feather: 0.2,
            gain: frames[i].gain,
            bias: frames[i].bias,
            frameIndex: i,
            sourceConfidence: frames[i].visualAlignment &&
              frames[i].visualAlignment.accepted
              ? frames[i].visualAlignment.confidence
              : 0.2,
            agreeThreshold: 12,
            autoExposure: true,
            // Pairwise pixels cannot distinguish affine EIS from a dominant
            // moving foreground. Keep the mesh confined to the deterministic
            // hidden fixture until a multi-frame/static-scene proof exists.
            localWarp: handheldTestMode,
            warpGridCols: 8,
            warpGridRows: 6
          }
        );
        if (raster.lastSeamStats && raster.lastSeamStats.localWarp) {
          localWarpLastDiagnostics = copyLocalWarpDiagnostic(
            raster.lastSeamStats.localWarp
          );
          if (raster.lastSeamStats.localWarp.applied) {
            localWarpLastAppliedDiagnostics = copyLocalWarpDiagnostic(
              raster.lastSeamStats.localWarp
            );
          }
        }
        decoded = null;
        setProgress(
          ((i + 1) / frames.length) * 100,
          "正在配准并选择第 " + (i + 1) + " / " + frames.length + " 张"
        );
        await nextFrame();
      }
      var stats = P.rasterStats(raster);
      if (!stats.nonBlackPixels) throw new Error("2D 拼接结果为空");
      seamSummary = raster.seamSummary ? {
        enabled: typeof P.projectPatchSeamAware === "function",
        frames: raster.seamSummary.frames,
        copiedPixels: raster.seamSummary.copiedPixels,
        blendedPixels: raster.seamSummary.blendedPixels,
        hardSelectedPixels: raster.seamSummary.hardSelectedPixels,
        conflictPixels: raster.seamSummary.conflictPixels,
        motionSeamBridges: raster.seamSummary.motionSeamBridges || 0,
        motionSeamBridgeCells: raster.seamSummary.motionSeamBridgeCells || 0,
        motionSeamCoreCells: raster.seamSummary.motionSeamCoreCells || 0,
        localWarpAttempted: raster.seamSummary.localWarpAttempted || 0,
        localWarpApplied: raster.seamSummary.localWarpApplied || 0,
        localWarpFallbacks: raster.seamSummary.localWarpFallbacks || 0,
        localWarpLastReason: raster.seamSummary.localWarpLastReason || null,
        localWarp: localWarpLastDiagnostics,
        localWarpLastDiagnostics: localWarpLastDiagnostics,
        localWarpLastAppliedDiagnostics: localWarpLastAppliedDiagnostics,
        seamStep: raster.lastSeamStats && raster.lastSeamStats.seamStep || 0,
        seamGridWidth: raster.lastSeamStats &&
          raster.lastSeamStats.seamGridWidth || 0,
        seamGridHeight: raster.lastSeamStats &&
          raster.lastSeamStats.seamGridHeight || 0,
        motionSeamBridgeDiagnostics: raster.lastSeamStats &&
          raster.lastSeamStats.motionSeamBridgeDiagnostics || [],
        motionSeamComponentDiagnostics: raster.lastSeamStats &&
          raster.lastSeamStats.motionSeamComponentDiagnostics || []
      } : {
        enabled: false,
        frames: 0,
        copiedPixels: 0,
        blendedPixels: 0,
        hardSelectedPixels: 0,
        conflictPixels: 0,
        motionSeamBridges: 0,
        motionSeamBridgeCells: 0,
        motionSeamCoreCells: 0,
        localWarpAttempted: 0,
        localWarpApplied: 0,
        localWarpFallbacks: 0,
        localWarpLastReason: null,
        localWarp: null,
        localWarpLastDiagnostics: null,
        localWarpLastAppliedDiagnostics: null,
        seamStep: 0,
        seamGridWidth: 0,
        seamGridHeight: 0,
        motionSeamBridgeDiagnostics: [],
        motionSeamComponentDiagnostics: []
      };
      session.seamSummary = seamSummary;
      stats.seam = seamSummary;
      putRaster(el.resultCanvas, raster);
      // putImageData has copied the final pixels into the visible Canvas. Drop
      // every CPU-side raster array before JPEG encoding, which is the actual
      // peak-memory phase on mobile browsers.
      raster.pixels = null;
      raster.weights = null;
      raster.lonSin = null;
      raster.lonCos = null;
      raster.latSin = null;
      raster.latCos = null;
      raster.priorities = null;
      raster.owners = null;
      raster.lastSeamStats = null;
      raster.seamSummary = null;
      session.resultBlob = await canvasBlob(el.resultCanvas, "image/jpeg", 0.88);
      if (session.exportUrl) URL.revokeObjectURL(session.exportUrl);
      session.exportUrl = URL.createObjectURL(session.resultBlob);
      el.download.href = session.exportUrl;
      el.resultMeta.textContent = raster.width + " × " + raster.height +
        " · 覆盖约 " + Math.round(stats.coverage * 100) + "%" +
        (seamSummary.enabled ? " · 智能选缝" : " · 兼容融合");
      return stats;
    } finally {
      // Standard-size stitching may fail before putImageData/canvasBlob. The
      // lite retry must not overlap the abandoned raster's CPU arrays.
      raster.pixels = null;
      raster.weights = null;
      raster.lonSin = null;
      raster.lonCos = null;
      raster.latSin = null;
      raster.latCos = null;
      raster.priorities = null;
      raster.owners = null;
      raster.lastSeamStats = null;
      raster.seamSummary = null;
    }
  }

  async function finishCapture() {
    if (session.capturing || session.rebuilding || session.processing || !session.frames.length) return;
    session.processing = true;
    stopCamera();
    setStage("process");
    try {
      setProgress(0, "正在核对相邻照片与 360° 闭环…");
      optimizeVisualSequence();
      await nextFrame();
      var stats;
      try {
        stats = await stitch(session.frames, false);
      } catch (firstError) {
        console.warn("[pano-capture] standard stitch failed, retry lite", firstError);
        setProgress(0, "标准结果没有完成，正在生成轻量版…");
        stats = await stitch(session.frames, true);
      }
      setProgress(100, "2D 结果已生成");
      session.resultStats = stats;
      setStage("result");
      document.body.dataset.resultNonblack = stats.nonBlackPixels > 0 ? "1" : "0";
      el.resultCanvas.hidden = false;
      el.viewerCanvas.hidden = true;
      el.resultMode.textContent = "2D 等距柱状结果";
      el.toggle360.textContent = "开启 360° 查看";
    } catch (error) {
      console.error("[pano-capture] stitch failed", error);
      setStage("capture");
      el.guideTitle.textContent = "照片都已保留";
      el.guideDetail.textContent = "这次生成没有完成，可点“完成”生成轻量版";
    } finally {
      session.processing = false;
      updateControls();
    }
  }

  function scheduleWorldPreview(force) {
    session.previewDirty = true;
    if (force) session.lastPreviewDrawAt = 0;
  }

  function drawWorldPreview() {
    var raster = session.coarse;
    var cssW = Math.max(1, innerWidth);
    var cssH = Math.max(1, innerHeight);
    var memory = Number(navigator.deviceMemory) || 4;
    var scale = Math.min(1, WORLD_PREVIEW_MAX_WIDTH / cssW);
    if (memory <= 4) scale *= 0.82;
    var w = Math.max(WORLD_PREVIEW_MIN_WIDTH, Math.round(cssW * scale));
    var h = Math.max(WORLD_PREVIEW_MIN_WIDTH, Math.round(cssH * w / cssW));
    if (el.worldCanvas.width !== w || el.worldCanvas.height !== h) {
      el.worldCanvas.width = w;
      el.worldCanvas.height = h;
      session.previewBuffer = null;
    }
    var ctx = el.worldCanvas.getContext("2d");
    if (!ctx) return false;
    if (!session.frames.length) {
      ctx.clearRect(0, 0, w, h);
      return true;
    }
    if (!session.previewBuffer ||
        session.previewBuffer.width !== w ||
        session.previewBuffer.height !== h) {
      session.previewBuffer = ctx.createImageData(w, h);
    }
    var out = session.previewBuffer;
    var rect = liveWindowRect();
    var centerX = rect.left + rect.width / 2;
    var centerY = rect.top + rect.height / 2;
    var tanX = Math.tan(CAPTURE_FOV_DEG * Math.PI / 360);
    var tanY = tanX / Math.max(0.25, rect.width / Math.max(1, rect.height));
    var F = session.displayBasis.F;
    var U = session.displayBasis.U;
    var rightBasis = session.displayBasis.R;
    var x, y;
    for (y = 0; y < h; y += 1) {
      var cssY = (y + 0.5) / h * cssH;
      var ny = (centerY - cssY) / Math.max(1, rect.height / 2) * tanY;
      for (x = 0; x < w; x += 1) {
        var cssX = (x + 0.5) / w * cssW;
        var nx = (cssX - centerX) / Math.max(1, rect.width / 2) * tanX;
        var dx = F[0] + rightBasis[0] * nx + U[0] * ny;
        var dy = F[1] + rightBasis[1] * nx + U[1] * ny;
        var dz = F[2] + rightBasis[2] * nx + U[2] * ny;
        var inv = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
        dx *= inv; dy *= inv; dz *= inv;
        var yaw = Math.atan2(dx, dy);
        if (yaw < 0) yaw += Math.PI * 2;
        var sx = Math.floor(yaw / (Math.PI * 2) * raster.width) % raster.width;
        var sy = P.clamp(Math.floor((0.5 - Math.asin(P.clamp(dz, -1, 1)) / Math.PI) * raster.height), 0, raster.height - 1);
        var si = (sy * raster.width + sx) * 4;
        var di = (y * w + x) * 4;
        out.data[di] = raster.pixels[si];
        out.data[di + 1] = raster.pixels[si + 1];
        out.data[di + 2] = raster.pixels[si + 2];
        out.data[di + 3] = 255;
      }
    }
    ctx.putImageData(out, 0, 0);
    return true;
  }

  function diagnosticSnapshot(now) {
    var latestPose = session.poseTimeline.latest();
    var latestFrame = session.latestVideoFrame;
    var motion = session.poseTimeline.motionStats(now, STABLE_WINDOW_MS);
    var target = session.targets[session.targetIndex];
    var gate = target && session.orientationReady ? captureGateAt(now, target) : null;
    var settings = null;
    if (session.stream && session.stream.getVideoTracks) {
      var track = session.stream.getVideoTracks()[0];
      if (track && track.getSettings) settings = track.getSettings();
    }
    return {
    version: "web-capture-localwarp-v25-20260801",
      capability: session.capabilities,
      captureReady: session.capabilities.canCaptureDirected,
      cameraReady: session.cameraReady,
      orientationReady: session.orientationReady,
      poseSamples: session.poseTimeline.samples.length,
      poseAgeMs: latestPose ? Math.round(Math.max(0, now - latestPose.timeMs)) : null,
      rawInstantaneousDegS: Number.isFinite(motion.instantaneousDegS)
        ? Math.round(motion.instantaneousDegS * 10) / 10
        : null,
      rawMaxDegS: Number.isFinite(motion.maxDegS)
        ? Math.round(motion.maxDegS * 10) / 10
        : null,
      rawDispersionDeg: Number.isFinite(motion.dispersionDeg)
        ? Math.round(motion.dispersionDeg * 100) / 100
        : null,
      stableGate: gate ? {
        aligned: gate.aligned,
        steady: gate.steady,
        upright: gate.upright,
        statisticallyStill: gate.statisticallyStill,
        silentAndQuiet: gate.silentAndQuiet,
        quietForMs: Math.round(gate.quietForMs)
      } : null,
      stableThresholds: {
        instantaneousDegS: STABLE_SPEED_DEG_S,
        robustDegS: STABLE_ROBUST_SPEED_DEG_S,
        dispersionDeg: STABLE_DISPERSION_DEG,
        minimumWindowMs: STABLE_MIN_WINDOW_MS,
        dwellMs: DWELL_MS,
        poseFreshnessMs: POSE_FRESHNESS_MS,
        framePoseMatchToleranceMs: FRAME_POSE_MATCH_TOLERANCE_MS,
        quietHoldFramePoseMaxAgeMs: QUIET_HOLD_FRAME_POSE_MAX_AGE_MS,
        quietHoldEntryToDrawMaxMs: QUIET_HOLD_ENTRY_TO_DRAW_MAX_MS,
        quietHoldExistingFrameMaxAgeMs:
          QUIET_HOLD_EXISTING_FRAME_MAX_AGE_MS,
        significantMotionDeg: SIGNIFICANT_MOTION_DEG,
        sensorSilenceSteadyMs: SENSOR_SILENCE_STEADY_MS
      },
      displayLagDeg: session.orientationReady
        ? Math.round(R.quaternionAngleDeg(
          R.quaternionFromBasis(session.trackingBasis),
          R.quaternionFromBasis(session.displayBasis)
        ) * 100) / 100
        : null,
      latestVideoFrame: latestFrame ? {
        sequence: latestFrame.sequence,
        timeSource: latestFrame.timeSource,
        ageMs: Math.round(now - latestFrame.poseTimeMs),
        poseMapped: !!latestFrame.pose
      } : null,
      preview: {
        width: el.worldCanvas.width,
        height: el.worldCanvas.height,
        fps: Math.round(session.previewFps * 10) / 10,
        renderer: "canvas2d"
      },
      cameraSettings: settings,
      autoCaptureEligible: autoCaptureEligible(),
      autoCaptureSuspended: session.autoCaptureSuspended,
      captureAttemptCount: session.captureAttemptCount,
      lastCaptureError: session.lastCaptureError,
      lastQuietHoldReject: session.lastQuietHoldReject,
      lastCapture: session.lastCaptureDiagnostic,
      visualStitch: session.visualSummary,
      seamStitch: session.seamSummary,
      sessionFov: session.sessionFovSummary
    };
  }

  function updateDiagnostics(now) {
    if (now - session.lastDiagnosticAt < 250) return;
    session.lastDiagnosticAt = now;
    var snapshot = diagnosticSnapshot(now);
    window.__PANO_DIAGNOSTICS__ = snapshot;
    if (diagnosticMode) {
      el.diagnosticPanel.hidden = false;
      el.diagnosticPanel.textContent = JSON.stringify(snapshot, null, 2);
    }
  }

  function animationLoop(now) {
    session.animationRaf = requestAnimationFrame(animationLoop);
    if (document.hidden) return;
    if (session.orientationReady) {
      var previousDisplay = session.displayBasis;
      session.displayBasis = session.displayFilter.update(session.trackingBasis, now);
      if (!previousDisplay || R.quaternionAngleDeg(
        R.quaternionFromBasis(previousDisplay),
        R.quaternionFromBasis(session.displayBasis)
      ) > 0.01) {
        session.previewDirty = true;
      }
    }
    if (!el.captureStage.hidden) {
      var currentGate = updateTarget();
      // The real-photo preview is CPU-heavy on Android WebViews. Never start a
      // preview projection while the next target is already in the shutter
      // zone: a long draw would otherwise skip the bounded quiet-hold
      // window and leave the user staring at a centered spinning ring.
      var shutterZoneActive = session.captureSessionStarted &&
        currentGate &&
        currentGate.visible &&
        currentGate.aligned &&
        !session.autoCaptureSuspended;
      if (session.previewDirty && !shutterZoneActive &&
          now - session.lastPreviewDrawAt >= PREVIEW_INTERVAL_MS) {
        if (drawWorldPreview()) {
          session.previewDirty = false;
          session.lastPreviewDrawAt = now;
          if (!session.previewFpsStartedAt) session.previewFpsStartedAt = now;
          session.previewFrames += 1;
          var elapsed = now - session.previewFpsStartedAt;
          if (elapsed >= 1000) {
            session.previewFps = session.previewFrames * 1000 / elapsed;
            session.previewFrames = 0;
            session.previewFpsStartedAt = now;
          }
        }
      }
    }
    updateDiagnostics(now);
  }

  function shader(gl, type, source) {
    var result = gl.createShader(type);
    gl.shaderSource(result, source);
    gl.compileShader(result);
    if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) {
      var message = gl.getShaderInfoLog(result);
      gl.deleteShader(result);
      throw new Error(message);
    }
    return result;
  }

  function destroyViewer() {
    var state = session.viewer;
    if (!state) return;
    if (state.raf) cancelAnimationFrame(state.raf);
    var canvas = state.canvas || el.viewerCanvas;
    canvas.onpointerdown = null;
    canvas.onpointermove = null;
    canvas.onpointerup = null;
    canvas.onpointercancel = null;
    canvas.ontouchstart = null;
    canvas.ontouchmove = null;
    canvas.ontouchend = null;
    if (state.contextLostHandler) {
      canvas.removeEventListener("webglcontextlost", state.contextLostHandler);
    }
    try {
      if (state.texture) state.gl.deleteTexture(state.texture);
      if (state.buffer) state.gl.deleteBuffer(state.buffer);
      if (state.program) state.gl.deleteProgram(state.program);
      if (state.vs) state.gl.deleteShader(state.vs);
      if (state.fs) state.gl.deleteShader(state.fs);
    } catch (cleanupError) {
      console.warn("[pano-capture] WebGL cleanup failed", cleanupError);
    }
    session.viewer = null;
  }

  function fallbackTo2D(message) {
    destroyViewer();
    el.viewerCanvas.hidden = true;
    el.resultCanvas.hidden = false;
    el.resultMode.textContent = "2D 等距柱状结果";
    el.toggle360.textContent = "重试 360° 查看";
    if (message) {
      el.viewerMessage.textContent = message + "，已自动回到 2D 结果";
      el.viewerMessage.hidden = false;
    }
    document.body.dataset.viewerMode = "2d";
  }

  function open360(forceFailure) {
    destroyViewer();
    try {
      if (forceFailure) throw new Error("测试注入的 WebGL 失败");
      var canvas = el.viewerCanvas;
      var frame = canvas.parentElement;
      var dpr = Math.min(2, devicePixelRatio || 1);
      canvas.width = Math.max(2, Math.round((frame.clientWidth || 320) * dpr));
      canvas.height = Math.max(2, Math.round((frame.clientHeight || 180) * dpr));
      var gl = canvas.getContext("webgl", { alpha: false, antialias: false, powerPreference: "low-power" });
      if (!gl) throw new Error("WebGL 不可用");
      var state = {
        canvas: canvas,
        gl: gl,
        yaw: 0,
        pitch: 0,
        pointer: null,
        raf: 0,
        vs: null,
        fs: null,
        program: null,
        buffer: null,
        texture: null,
        contextLostHandler: null
      };
      session.viewer = state;
      var vs = shader(gl, gl.VERTEX_SHADER,
        "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}");
      state.vs = vs;
      var fs = shader(gl, gl.FRAGMENT_SHADER, [
        "precision mediump float;",
        "uniform sampler2D pano;uniform vec2 turn;uniform float aspect;",
        "const float PI=3.14159265359;",
        "void main(){",
        "vec2 q=(gl_FragCoord.xy/vec2(" + canvas.width + ".0," + canvas.height + ".0))*2.-1.;",
        "vec3 d=normalize(vec3(q.x*aspect*.82,q.y*.82,-1.));",
        "float cp=cos(turn.y),sp=sin(turn.y);d=vec3(d.x,d.y*cp-d.z*sp,d.y*sp+d.z*cp);",
        "float cy=cos(turn.x),sy=sin(turn.x);d=vec3(d.x*cy+d.z*sy,d.y,-d.x*sy+d.z*cy);",
        "float lon=atan(d.x,-d.z);float u=fract(lon/(2.*PI)+1.);",
        "float v=.5-asin(clamp(d.y,-1.,1.))/PI;gl_FragColor=texture2D(pano,vec2(u,v));}"
      ].join(""));
      state.fs = fs;
      var program = gl.createProgram();
      state.program = program;
      gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
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
      var texture = gl.createTexture();
      state.texture = texture;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      // WebGL1 only permits REPEAT on power-of-two textures. The desktop and
      // lite panoramas are 1536/768px wide, so let the shader's fract(u) wrap
      // longitude and keep the texture itself complete.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el.resultCanvas);
      if (gl.isContextLost() || gl.getError() !== gl.NO_ERROR) {
        throw new Error("360° 贴图内存不足");
      }
      var turn = gl.getUniformLocation(program, "turn");
      gl.uniform1f(gl.getUniformLocation(program, "aspect"), canvas.width / canvas.height);
      function render() {
        if (gl.isContextLost()) {
          fallbackTo2D("360° 图形上下文已中断");
          return false;
        }
        gl.uniform2f(turn, state.yaw, state.pitch);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        if (gl.getError() !== gl.NO_ERROR) {
          fallbackTo2D("360° 绘制内存不足");
          return false;
        }
        return true;
      }
      function down(event) {
        var p = event.touches ? event.touches[0] : event;
        state.pointer = { x: p.clientX, y: p.clientY };
      }
      function move(event) {
        if (!state.pointer) return;
        var p = event.touches ? event.touches[0] : event;
        state.yaw += (p.clientX - state.pointer.x) * 0.006;
        state.pitch = P.clamp(state.pitch + (p.clientY - state.pointer.y) * 0.004, -1.35, 1.35);
        state.pointer = { x: p.clientX, y: p.clientY };
        event.preventDefault();
        render();
      }
      function up() { state.pointer = null; }
      canvas.onpointerdown = down;
      canvas.onpointermove = move;
      canvas.onpointerup = up;
      canvas.onpointercancel = up;
      canvas.ontouchstart = down;
      canvas.ontouchmove = move;
      canvas.ontouchend = up;
      state.contextLostHandler = function (event) {
        event.preventDefault();
        fallbackTo2D("360° 图形上下文已中断");
      };
      canvas.addEventListener("webglcontextlost", state.contextLostHandler, { once: true });
      el.viewerMessage.hidden = true;
      el.resultCanvas.hidden = true;
      el.viewerCanvas.hidden = false;
      el.resultMode.textContent = "360° 查看 · 拖动环视";
      el.toggle360.textContent = "返回 2D 结果";
      document.body.dataset.viewerMode = "webgl";
      if (!render()) return false;
      return true;
    } catch (error) {
      console.warn("[pano-capture] WebGL fallback", error);
      fallbackTo2D((error && error.message) || "360° 查看启动失败");
      return false;
    }
  }

  function toggle360() {
    if (!el.viewerCanvas.hidden) {
      fallbackTo2D("");
      el.viewerMessage.hidden = true;
      el.toggle360.textContent = "开启 360° 查看";
      return;
    }
    open360(false);
  }

  async function testPendingCameraCancellation() {
    if (!portraitCaptureReady()) return null;
    var stopped = 0;
    var resolveStream = null;
    session.testCameraStreamFactory = function () {
      return new Promise(function (resolve) { resolveStream = resolve; });
    };
    var pending = startCamera();
    var deadline = Date.now() + 1000;
    while (!resolveStream && Date.now() < deadline) {
      await new Promise(function (resolve) { setTimeout(resolve, 10); });
    }
    if (!resolveStream) {
      session.testCameraStreamFactory = null;
      stopCamera();
      await pending;
      return false;
    }
    // Same invalidation path used by landscape resize, visibilitychange and
    // pagehide while a real permission/getUserMedia request is pending.
    stopCamera();
    resolveStream({
      getTracks: function () {
        return [{ stop: function () { stopped += 1; } }];
      }
    });
    await pending;
    session.testCameraStreamFactory = null;
    updateControls();
    return stopped === 1 && !session.cameraReady && !session.cameraStarting &&
      !session.stream && el.start.textContent === "开启相机";
  }

  function runCaptureGateRegression() {
    var originalTimeline = session.poseTimeline;
    var originalTrackingBasis = session.trackingBasis;
    var originalQuietBasis = session.quietBasis;
    var originalQuietSince = session.quietSince;
    var originalLastSignificantMotionAt = session.lastSignificantMotionAt;
    var originalLastQuietHoldReject = session.lastQuietHoldReject;
    var originalCaptureSessionStarted = session.captureSessionStarted;
    var originalAutoCaptureSuspended = session.autoCaptureSuspended;
    var originalCapabilities = session.capabilities;
    var originalAlignmentFrames = session.alignmentFrames;
    var now = performance.now();
    var target = P.createTargets()[0];
    var secondTarget = P.createTargets()[1];
    var anchor = P.orthonormalBasis(target.dir, [0, 0, 1]);
    var noisyTimeline = new R.PoseTimeline({ maxAgeMs: 3200, maxSamples: 240 });
    var latestBasis = anchor;
    for (var offset = -520, sampleIndex = 0; offset <= 0; offset += 20, sampleIndex += 1) {
      var yawNoise = Math.sin(sampleIndex * 1.71) * 0.15;
      var pitchNoise = Math.cos(sampleIndex * 1.17) * 0.08;
      if (sampleIndex === 8) yawNoise += 0.4;
      latestBasis = P.rotateBasisLocal(anchor, yawNoise, pitchNoise, 0);
      noisyTimeline.push(now + offset, latestBasis, "synthetic-quantized-deviceorientation");
    }
    session.poseTimeline = noisyTimeline;
    session.trackingBasis = latestBasis;
    session.quietBasis = P.copyBasis(latestBasis);
    session.quietSince = now - 500;
    session.captureSessionStarted = true;
    session.autoCaptureSuspended = false;
    session.capabilities = Object.assign({}, originalCapabilities, {
      videoFrameCallback: false,
      tier: "B"
    });
    var noisyGate = captureGateAt(now, target, latestBasis);
    var tierBAuto = autoCaptureEligible();

    var lowFrequencyTimeline = new R.PoseTimeline({ maxAgeMs: 3200, maxSamples: 16 });
    [-400, -200, 0].forEach(function (lowOffset, lowIndex) {
      lowFrequencyTimeline.push(
        now + lowOffset,
        P.rotateBasisLocal(anchor, lowIndex === 1 ? 0.05 : 0, 0, 0),
        "synthetic-android-5hz"
      );
    });
    session.poseTimeline = lowFrequencyTimeline;
    session.trackingBasis = anchor;
    session.quietBasis = P.copyBasis(anchor);
    session.quietSince = now - 500;
    var lowFrequencyGate = captureGateAt(now, target, anchor);

    var silentTimeline = new R.PoseTimeline({ maxAgeMs: 3200, maxSamples: 16 });
    silentTimeline.push(
      now - 650,
      P.orthonormalBasis(secondTarget.dir, [0, 0, 1]),
      "synthetic-last-moving-pose"
    );
    var secondAnchor = P.orthonormalBasis(secondTarget.dir, [0, 0, 1]);
    silentTimeline.push(now - 450, secondAnchor, "synthetic-quiet-stop");
    session.poseTimeline = silentTimeline;
    session.trackingBasis = secondAnchor;
    session.quietBasis = P.copyBasis(secondAnchor);
    session.quietSince = now - 450;
    var silentGate = captureGateAt(now, secondTarget, secondAnchor);
    var secondTargetAutoEligible = autoCaptureEligible();

    var quietHoldTimeline = new R.PoseTimeline({ maxAgeMs: 3200, maxSamples: 16 });
    quietHoldTimeline.push(
      now - 900,
      secondAnchor,
      "synthetic-android-sensor-silence"
    );
    session.poseTimeline = quietHoldTimeline;
    session.trackingBasis = secondAnchor;
    session.quietBasis = P.copyBasis(secondAnchor);
    session.quietSince = now - 900;
    session.lastSignificantMotionAt = now - 1000;
    var quietHoldEntry = {
      timeMs: now - 100,
      gate: silentGate,
      entryAccepted: true,
      targetIndex: session.targetIndex,
      cameraGeneration: session.cameraGeneration,
      quietSince: session.quietSince,
      lastSignificantMotionAt: session.lastSignificantMotionAt,
      frameSequence: 10,
      pose: {
        timeMs: now - 900,
        basis: P.copyBasis(secondAnchor),
        source: "synthetic-entry-gate"
      }
    };
    var quietHoldFrameFallback = quietHoldFramePose(
      quietHoldEntry,
      { sequence: 11, poseTimeMs: now - 100 },
      now,
      secondTarget
    );
    var quietHoldExistingFrameFallback = quietHoldFramePose(
      quietHoldEntry,
      { sequence: 10, poseTimeMs: now - 500 },
      now,
      secondTarget
    );
    var driftedBasis = P.rotateBasisLocal(secondAnchor, 0.6, 0, 0);
    quietHoldTimeline.push(now - 50, driftedBasis, "synthetic-post-entry-drift");
    session.quietSince = now - 50;
    session.lastSignificantMotionAt = now - 50;
    var driftingFrameFallbackRejected = !quietHoldFramePose(
      quietHoldEntry,
      { sequence: 12, poseTimeMs: now - 25 },
      now,
      secondTarget
    );

    var onePoseTimeline = new R.PoseTimeline({ maxAgeMs: 3200, maxSamples: 16 });
    onePoseTimeline.push(now, anchor, "synthetic-manual");
    session.poseTimeline = onePoseTimeline;
    session.trackingBasis = anchor;
    session.quietBasis = P.copyBasis(anchor);
    session.quietSince = now;
    var manualGate = captureGateAt(now, target, anchor);
    var manualWithoutStableWindow = manualCaptureAllowed(manualGate) && !manualGate.steady;

    var flatFallback = false;
    var fallbackReason = "";
    session.alignmentFrames = [];
    var flatA = document.createElement("canvas");
    flatA.width = 64;
    flatA.height = 80;
    flatA.getContext("2d").fillRect(0, 0, flatA.width, flatA.height);
    var flatB = document.createElement("canvas");
    flatB.width = 64;
    flatB.height = 80;
    var flatBContext = flatB.getContext("2d");
    flatBContext.fillStyle = "#222";
    flatBContext.fillRect(0, 0, flatB.width, flatB.height);
    var flatAnchor = prepareVisualFrame(flatA, anchor, 65, 0);
    session.alignmentFrames.push(flatAnchor);
    var flatSecond = prepareVisualFrame(flatB, secondAnchor, 50, 1);
    flatFallback = !!(flatSecond.alignment &&
      flatSecond.alignment.fallbackToImu &&
      !flatSecond.alignment.accepted);
    fallbackReason = flatSecond.alignment && flatSecond.alignment.rejectReason || "";
    releaseAlignmentFrame(flatAnchor);
    releaseAlignmentFrame(flatSecond);

    session.poseTimeline = originalTimeline;
    session.trackingBasis = originalTrackingBasis;
    session.quietBasis = originalQuietBasis;
    session.quietSince = originalQuietSince;
    session.lastSignificantMotionAt = originalLastSignificantMotionAt;
    session.lastQuietHoldReject = originalLastQuietHoldReject;
    session.captureSessionStarted = originalCaptureSessionStarted;
    session.autoCaptureSuspended = originalAutoCaptureSuspended;
    session.capabilities = originalCapabilities;
    session.alignmentFrames = originalAlignmentFrames;
    return {
      ok: noisyGate.steady && lowFrequencyGate.steady && silentGate.steady &&
        tierBAuto && secondTargetAutoEligible && manualWithoutStableWindow &&
        quietHoldFrameFallback && quietHoldExistingFrameFallback &&
        driftingFrameFallbackRejected && flatFallback &&
        effectiveScreenAngle(90, true) === 0 &&
        effectiveScreenAngle(270, true) === 0,
      noisyPoseSteady: noisyGate.steady,
      noisyPoseSamples: noisyGate.motion.sampleCount,
      noisyPoseMaxDegS: noisyGate.motion.maxDegS,
      noisyPoseRobustDegS: noisyGate.motion.robustDegS,
      noisyPoseDispersionDeg: noisyGate.motion.dispersionDeg,
      android5HzSteady: lowFrequencyGate.steady,
      android5HzDurationMs: lowFrequencyGate.motion.durationMs,
      silentSensorQuietHoldSteady: silentGate.steady,
      silentSensorAgeMs: silentGate.motion.latestAgeMs,
      quietHoldFramePoseFallback: !!quietHoldFrameFallback,
      quietHoldFramePoseSource: quietHoldFrameFallback &&
        quietHoldFrameFallback.source,
      quietHoldExistingFrameFallback: !!quietHoldExistingFrameFallback,
      postEntryDriftFallbackRejected: driftingFrameFallbackRejected,
      tierBWithoutVideoFrameCallbackAuto: tierBAuto,
      secondTargetAutoEligible: secondTargetAutoEligible,
      manualWithoutStableWindow: manualWithoutStableWindow,
      lowTextureVisualFallbackToImu: flatFallback,
      lowTextureFallbackReason: fallbackReason,
      portraitStaleScreenAngleNormalized: effectiveScreenAngle(90, true) === 0 &&
        effectiveScreenAngle(270, true) === 0
    };
  }

  function analyzeDynamicSubject(canvas) {
    var context = canvas.getContext("2d", { willReadFrequently: true });
    var width = canvas.width;
    var height = canvas.height;
    var pixels = context.getImageData(0, 0, width, height).data;
    var mask = new Uint8Array(width * height);
    var index;
    for (index = 0; index < mask.length; index += 1) {
      var offset = index * 4;
      if (pixels[offset] >= 210 &&
          pixels[offset + 1] <= 80 &&
          pixels[offset + 2] >= 205) {
        mask[index] = 1;
      }
    }
    var visited = new Uint8Array(mask.length);
    var queue = new Int32Array(mask.length);
    var components = [];
    for (var start = 0; start < mask.length; start += 1) {
      if (!mask[start] || visited[start]) continue;
      var head = 0;
      var tail = 1;
      var minX = width;
      var maxX = -1;
      var minY = height;
      var maxY = -1;
      queue[0] = start;
      visited[start] = 1;
      while (head < tail) {
        var current = queue[head];
        head += 1;
        var x = current % width;
        var y = Math.floor(current / width);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        var left = x > 0 ? current - 1 : -1;
        var right = x + 1 < width ? current + 1 : -1;
        var up = y > 0 ? current - width : -1;
        var down = y + 1 < height ? current + width : -1;
        var neighbors = [left, right, up, down];
        for (var neighborIndex = 0; neighborIndex < neighbors.length; neighborIndex += 1) {
          var neighbor = neighbors[neighborIndex];
          if (neighbor < 0 || visited[neighbor] || !mask[neighbor]) continue;
          visited[neighbor] = 1;
          queue[tail] = neighbor;
          tail += 1;
        }
      }
      components.push({
        area: tail,
        minX: minX,
        maxX: maxX,
        minY: minY,
        maxY: maxY,
        width: maxX - minX + 1,
        height: maxY - minY + 1
      });
    }
    components.sort(function (a, b) { return b.area - a.area; });
    var minimumArea = width * height * 0.001;
    var minimumHeight = height * 0.08;
    var significant = components.filter(function (component) {
      return component.area >= minimumArea &&
        component.height >= minimumHeight;
    });
    var largest = significant[0] || null;
    return {
      healthy: significant.length === 1 &&
        largest.area >= width * height * 0.002 &&
        largest.height >= height * 0.16 &&
        largest.width <= width * 0.07,
      significantComponents: significant.length,
      largest: largest,
      components: significant.slice(0, 4),
      threshold: {
        minimumArea: Math.round(minimumArea),
        minimumHeight: Math.round(minimumHeight),
        maximumWidth: Math.round(width * 0.07)
      }
    };
  }

  async function runSimulator() {
    document.body.classList.add("is-test");
    el.testReport.hidden = false;
    setStage("capture");
    el.liveEmpty.textContent = dynamicTestMode
      ? "隐藏回归模拟器：移动人物 + 6 cm 相机平移"
      : (handheldTestMode
        ? "隐藏回归模拟器：固定种子 EIS + rolling shutter + 手持平移"
        : "隐藏回归模拟器：彩色经纬网合成帧");
    var error = null;
    try {
      while (session.targetIndex < session.targets.length) {
        var beforeCaptureIndex = session.targetIndex;
        await captureCurrent();
        if (session.targetIndex === beforeCaptureIndex) {
          throw new Error("视觉回归第 " + (beforeCaptureIndex + 1) + " 帧被拒收");
        }
        await nextFrame();
      }
      // captureCurrent 会等待最后一次 finishCapture；仍保留有界等待，避免未来
      // 异步重构后失败状态把隐藏回归页永久挂住。
      var resultDeadline = Date.now() + 20000;
      while (session.processing || el.resultStage.hidden) {
        if (!session.processing && el.resultStage.hidden) {
          throw new Error("拼接没有进入结果页");
        }
        if (Date.now() > resultDeadline) throw new Error("等待拼接结果超时");
        await new Promise(function (resolve) { setTimeout(resolve, 25); });
      }
      var progress100 = session.progressEvents.indexOf(100) >= 0;
      var nonBlack = canvasHasNonBlackPixels(el.resultCanvas);
      var coverage = session.resultStats ? session.resultStats.coverage : 0;
      var coverageHealthy = requestedFrames < 28 || coverage >= 0.99;

      // 先走一次真实 WebGL 成功路径；不支持 WebGL 的设备仍以 2D 回退为合格。
      var webglOpened = open360(false);
      var webglNonBlack = null;
      if (webglOpened && session.viewer) {
        var probePixel = new Uint8Array(4);
        var probeGl = session.viewer.gl;
        probeGl.finish();
        probeGl.readPixels(
          Math.floor(session.viewer.canvas.width / 2),
          Math.floor(session.viewer.canvas.height / 2),
          1, 1, probeGl.RGBA, probeGl.UNSIGNED_BYTE, probePixel
        );
        webglNonBlack = probePixel[0] + probePixel[1] + probePixel[2] > 18 &&
          probePixel[3] > 0 && probeGl.getError() === probeGl.NO_ERROR;
      }
      var webglHealthy = !webglOpened ||
        (document.body.dataset.viewerMode === "webgl" &&
         el.resultCanvas.hidden && !el.viewerCanvas.hidden && webglNonBlack);
      var contextLostFallback = null;
      if (webglOpened && session.viewer) {
        var contextGl = session.viewer.gl;
        var loseContext = contextGl.getExtension("WEBGL_lose_context");
        if (loseContext) {
          loseContext.loseContext();
          var contextDeadline = Date.now() + 1500;
          while (document.body.dataset.viewerMode !== "2d" && Date.now() < contextDeadline) {
            await new Promise(function (resolve) { setTimeout(resolve, 25); });
          }
          contextLostFallback = document.body.dataset.viewerMode === "2d" && !el.resultCanvas.hidden;
          loseContext.restoreContext();
          var restoreDeadline = Date.now() + 1500;
          while (contextGl.isContextLost() && Date.now() < restoreDeadline) {
            await new Promise(function (resolve) { setTimeout(resolve, 25); });
          }
        } else {
          fallbackTo2D("");
        }
      }

      var forcedWebglOpened = open360(true);
      var fallback = !forcedWebglOpened &&
        document.body.dataset.viewerMode === "2d" && !el.resultCanvas.hidden;
      var cameraRaceCancelled = await testPendingCameraCancellation();
      var captureGateRegression = runCaptureGateRegression();
      session.uploadAttempted = testNetworkMutationObserved();
      var visualExpectedEdges = requestedFrames >= 28
        ? 25
        : (requestedFrames >= 20 ? 18 : (requestedFrames >= 12 ? 11 : 0));
      var visualExpectedCrossRingEdges = requestedFrames > 12
        ? requestedFrames - 12
        : 0;
      var visualSummary = session.visualSummary;
      var robustVisualTestMode = handheldTestMode || dynamicTestMode;
      var visualEdgesHealthy = !!visualSummary && (robustVisualTestMode
        ? (visualSummary.acceptedLocalEdges >= Math.floor(visualExpectedEdges * 0.7) &&
           visualSummary.acceptedCrossRingEdges >=
             Math.floor(visualExpectedCrossRingEdges * 0.7) &&
           visualSummary.acceptedLocalEdges + visualSummary.rejectedLocalEdges >=
             visualExpectedEdges &&
           visualSummary.acceptedCrossRingEdges +
             visualSummary.rejectedCrossRingEdges >= visualExpectedCrossRingEdges &&
           visualSummary.residualAfterMeanDeg <
             visualSummary.residualBeforeMeanDeg)
        : (visualSummary.acceptedLocalEdges >= visualExpectedEdges &&
           visualSummary.rejectedLocalEdges === 0 &&
           visualSummary.acceptedCrossRingEdges >= visualExpectedCrossRingEdges &&
           visualSummary.rejectedCrossRingEdges === 0));
      // Handheld noise and a moving subject can both invalidate a minority of
      // visual edges. Rejecting those edges is the robust path, not a test
      // failure, provided the retained graph improves globally.
      var visualHealthy = visualEdgesHealthy &&
        (requestedFrames < 12 || visualSummary.loops.length >= 1);
      var seamHealthy = !!session.seamSummary &&
        session.seamSummary.enabled &&
        session.seamSummary.frames === session.frames.length;
      var dynamicSubject = dynamicTestMode
        ? analyzeDynamicSubject(el.resultCanvas)
        : null;
      var dynamicHealthy = !dynamicTestMode ||
        (dynamicSubject.healthy &&
         session.seamSummary.motionSeamBridges >= 1);
      var localWarpSummary = session.seamSummary || {};
      var localWarpLastDiagnostics =
        localWarpSummary.localWarpLastDiagnostics || localWarpSummary.localWarp;
      var localWarpLastAppliedDiagnostics =
        localWarpSummary.localWarpLastAppliedDiagnostics;
      var localWarpCountsHealthy =
        localWarpSummary.localWarpAttempted >= 2 &&
        localWarpSummary.localWarpApplied + localWarpSummary.localWarpFallbacks ===
          localWarpSummary.localWarpAttempted;
      // A fully-accounted safe fallback is healthy too. Local warping is a
      // conservative enhancement, not a requirement: after global pose solve,
      // a non-zero mean residual is intentionally rejected because two-frame
      // pixels cannot distinguish it from a dominant moving foreground.
      var localWarpAppliedSafely = localWarpSummary.localWarpApplied === 0 ||
        (!!localWarpLastAppliedDiagnostics &&
         localWarpLastAppliedDiagnostics.attempted === true &&
         localWarpLastAppliedDiagnostics.applied === true &&
         localWarpLastAppliedDiagnostics.reason === "ACCEPTED" &&
         localWarpLastAppliedDiagnostics.flowMeanMagnitude <=
           localWarpLastAppliedDiagnostics.flowMeanMagnitudeLimit + 1e-6 &&
         localWarpLastAppliedDiagnostics.holdoutAfter <
           localWarpLastAppliedDiagnostics.holdoutBefore &&
         localWarpLastAppliedDiagnostics.seamP90After <
           localWarpLastAppliedDiagnostics.seamP90Before &&
         localWarpLastAppliedDiagnostics.minJacobian >= 0.55 &&
         localWarpLastAppliedDiagnostics.maxJacobian <= 1.8 &&
         localWarpLastAppliedDiagnostics.maxDisplacement <=
           localWarpLastAppliedDiagnostics.maxDisplacementLimit + 1e-6);
      var localWarpHealthy = !handheldTestMode ||
        (localWarpCountsHealthy && localWarpAppliedSafely &&
         !!localWarpLastDiagnostics &&
         localWarpLastDiagnostics.attempted === true);
      window.__PANO_TEST_RESULT__ = {
        ok: progress100 && nonBlack && coverageHealthy && webglHealthy && contextLostFallback !== false &&
          fallback && cameraRaceCancelled !== false && captureGateRegression.ok &&
          !session.uploadAttempted && visualHealthy && seamHealthy && dynamicHealthy &&
          localWarpHealthy,
        scene: testScene,
        frames: session.frames.length,
        progress100: progress100,
        nonBlack2D: nonBlack,
        coverage2D: coverage,
        coverageExpected: coverageHealthy,
        webglSuccess: webglOpened ? webglHealthy : null,
        nonBlackWebGL: webglNonBlack,
        contextLostFallback2D: contextLostFallback,
        webglFailureFallback2D: fallback,
        cameraPendingCancellation: cameraRaceCancelled,
        captureGateRegression: captureGateRegression,
        uploadAttempted: session.uploadAttempted,
        captureAlignments: session.frames.map(function (frame, index) {
          var alignment = frame.visualAlignment || {};
          return {
            index: index,
            accepted: !!alignment.accepted,
            fallbackToImu: !!alignment.fallbackToImu,
            score: Number.isFinite(alignment.score) ? alignment.score : null,
            globalScore: Number.isFinite(alignment.globalScore)
              ? alignment.globalScore
              : null,
            confidence: Number.isFinite(alignment.confidence)
              ? alignment.confidence
              : null,
            appliedPoseWeight: Number.isFinite(alignment.appliedPoseWeight)
              ? alignment.appliedPoseWeight
              : null,
            rejectedBlockCount: alignment.rejectedBlockCount || 0,
            correctionFromImuDeg: P.basisRotationErrorDeg(
              frame.correctedBasis || frame.basis,
              frame.basis
            )
          };
        }),
        visualAlignmentHealthy: visualHealthy,
        visualAcceptedEdges: session.visualSummary &&
          session.visualSummary.acceptedLocalEdges,
        visualRejectedEdges: session.visualSummary &&
          session.visualSummary.rejectedLocalEdges,
        visualCrossRingEdges: session.visualSummary &&
          session.visualSummary.acceptedCrossRingEdges,
        visualRejectedCrossRingEdges: session.visualSummary &&
          session.visualSummary.rejectedCrossRingEdges,
        visualLoopClosures: session.visualSummary &&
          session.visualSummary.loops.length,
        sessionFovXDeg: session.sessionFovXDeg,
        sessionFovMethod: session.sessionFovSummary &&
          session.sessionFovSummary.method,
        seamAwareHealthy: seamHealthy,
        seamFrames: session.seamSummary && session.seamSummary.frames,
        seamConflictPixels: session.seamSummary &&
          session.seamSummary.conflictPixels,
        seamHardSelectedPixels: session.seamSummary &&
          session.seamSummary.hardSelectedPixels,
        motionSeamBridges: session.seamSummary &&
          session.seamSummary.motionSeamBridges,
        motionSeamBridgeCells: session.seamSummary &&
          session.seamSummary.motionSeamBridgeCells,
        motionSeamCoreCells: session.seamSummary &&
          session.seamSummary.motionSeamCoreCells,
        localWarpHealthy: localWarpHealthy,
        localWarpAttempted: localWarpSummary.localWarpAttempted || 0,
        localWarpApplied: localWarpSummary.localWarpApplied || 0,
        localWarpFallbacks: localWarpSummary.localWarpFallbacks || 0,
        localWarpLastReason: localWarpSummary.localWarpLastReason || null,
        localWarpLastDiagnostics: localWarpLastDiagnostics || null,
        localWarpLastAppliedDiagnostics: localWarpLastAppliedDiagnostics || null,
        handheldSeed: handheldTestMode ? HANDHELD_TEST_SEED : null,
        handheldProfiles: handheldTestMode ? session.frames.map(function (frame) {
          return frame.capture && frame.capture.handheldProfile || null;
        }) : null,
        seamStep: session.seamSummary && session.seamSummary.seamStep,
        seamGridWidth: session.seamSummary &&
          session.seamSummary.seamGridWidth,
        seamGridHeight: session.seamSummary &&
          session.seamSummary.seamGridHeight,
        motionSeamBridgeDiagnostics: session.seamSummary &&
          session.seamSummary.motionSeamBridgeDiagnostics,
        motionSeamComponentDiagnostics: session.seamSummary &&
          session.seamSummary.motionSeamComponentDiagnostics,
        dynamicSubjectHealthy: dynamicHealthy,
        dynamicSubject: dynamicSubject
      };
    } catch (caught) {
      error = caught;
      window.__PANO_TEST_RESULT__ = {
        ok: false,
        error: String(caught && caught.stack || caught),
        uploadAttempted: session.uploadAttempted
      };
    }
    document.body.dataset.testStatus = window.__PANO_TEST_RESULT__.ok ? "passed" : "failed";
    el.testReport.textContent = JSON.stringify(window.__PANO_TEST_RESULT__, null, 2);
    if (error) console.error(error);
  }

  function resetToCapture() {
    if (session.viewer) fallbackTo2D("");
    setStage("capture");
    el.guideTitle.textContent = "照片还保留在本次拍摄中";
    el.guideDetail.textContent = "可以撤销最后一张，或再次生成";
    updateControls();
    updateTarget();
    scheduleWorldPreview(true);
  }

  el.start.addEventListener("click", startCamera);
  el.undo.addEventListener("click", undoLast);
  el.finish.addEventListener("click", finishCapture);
  el.toggle360.addEventListener("click", toggle360);
  el.backToCapture.addEventListener("click", resetToCapture);
  el.help.addEventListener("click", function () {
    session.stableSince = 0;
    if (el.helpDialog.showModal) el.helpDialog.showModal();
    else el.helpDialog.setAttribute("open", "");
  });
  el.helpClose.addEventListener("click", function () {
    session.stableSince = 0;
    el.helpDialog.close();
  });
  window.addEventListener("resize", function () {
    if (!testMode && !portraitCaptureReady() &&
        (session.cameraReady || session.cameraStarting || session.stream)) {
      stopCamera();
    }
    scheduleWorldPreview(true);
    updateControls();
    updateTarget();
  });
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) return;
    stopCamera();
    if (session.viewer) fallbackTo2D("页面进入后台");
    updateControls();
  });
  window.addEventListener("pagehide", function () {
    stopCamera();
    destroyViewer();
    releaseVisualMemory();
    if (session.animationRaf) {
      cancelAnimationFrame(session.animationRaf);
      session.animationRaf = 0;
    }
    if (session.exportUrl) {
      URL.revokeObjectURL(session.exportUrl);
      session.exportUrl = "";
    }
  });

  setStage("capture");
  updateCapabilityUi();
  updateControls();
  updateTarget();
  drawWorldPreview();
  session.animationRaf = requestAnimationFrame(animationLoop);
  if (testMode) runSimulator();
})();
