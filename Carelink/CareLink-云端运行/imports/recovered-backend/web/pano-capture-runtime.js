/*
 * Web-only capture runtime.
 *
 * PanoCore remains the shared projection contract. This file handles the
 * browser-specific parts that must not leak into the Weixin implementation:
 * monotonic pose history, time-based display smoothing and correlation of a
 * presented camera frame with the closest sensor pose.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PanoCaptureRuntime = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var RAD_TO_DEG = 180 / Math.PI;
  var WORLD_UP = [0, 0, 1];

  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
  }

  function dot3(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }

  function cross3(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0]
    ];
  }

  function normalize3(value, fallback) {
    var length = Math.sqrt(dot3(value, value));
    if (length < 1e-8) return (fallback || [0, 1, 0]).slice();
    return [value[0] / length, value[1] / length, value[2] / length];
  }

  function copyBasis(basis) {
    return {
      F: basis.F.slice(),
      U: basis.U.slice(),
      R: basis.R.slice(),
      rollDeg: Number(basis.rollDeg) || 0
    };
  }

  function orthonormalBasis(forward, upHint) {
    var F = normalize3(forward, [0, 1, 0]);
    var R = normalize3(cross3(F, upHint || WORLD_UP), [1, 0, 0]);
    var U = normalize3(cross3(R, F), WORLD_UP);
    var horizonRight = normalize3(cross3(F, WORLD_UP), R);
    var horizonUp = normalize3(cross3(horizonRight, F), U);
    var rollDeg = Math.atan2(dot3(U, horizonRight), dot3(U, horizonUp)) * RAD_TO_DEG;
    return { F: F, U: U, R: R, rollDeg: rollDeg };
  }

  function normalizeQuaternion(value) {
    var length = Math.hypot(value[0], value[1], value[2], value[3]);
    if (length < 1e-9) return [0, 0, 0, 1];
    return [
      value[0] / length,
      value[1] / length,
      value[2] / length,
      value[3] / length
    ];
  }

  /*
   * A PanoCore basis uses +R, +U, +F, while a right-handed camera rotation
   * matrix uses columns +R, +U, -F. Keeping that sign explicit prevents the
   * browser interpolation layer from silently changing the shared coordinate
   * convention (+Y forward, +Z up).
   */
  function quaternionFromBasis(basis) {
    var m00 = basis.R[0];
    var m01 = basis.U[0];
    var m02 = -basis.F[0];
    var m10 = basis.R[1];
    var m11 = basis.U[1];
    var m12 = -basis.F[1];
    var m20 = basis.R[2];
    var m21 = basis.U[2];
    var m22 = -basis.F[2];
    var trace = m00 + m11 + m22;
    var x;
    var y;
    var z;
    var w;
    var scale;
    if (trace > 0) {
      scale = Math.sqrt(trace + 1) * 2;
      w = 0.25 * scale;
      x = (m21 - m12) / scale;
      y = (m02 - m20) / scale;
      z = (m10 - m01) / scale;
    } else if (m00 > m11 && m00 > m22) {
      scale = Math.sqrt(1 + m00 - m11 - m22) * 2;
      w = (m21 - m12) / scale;
      x = 0.25 * scale;
      y = (m01 + m10) / scale;
      z = (m02 + m20) / scale;
    } else if (m11 > m22) {
      scale = Math.sqrt(1 + m11 - m00 - m22) * 2;
      w = (m02 - m20) / scale;
      x = (m01 + m10) / scale;
      y = 0.25 * scale;
      z = (m12 + m21) / scale;
    } else {
      scale = Math.sqrt(1 + m22 - m00 - m11) * 2;
      w = (m10 - m01) / scale;
      x = (m02 + m20) / scale;
      y = (m12 + m21) / scale;
      z = 0.25 * scale;
    }
    return normalizeQuaternion([x, y, z, w]);
  }

  function basisFromQuaternion(value) {
    var q = normalizeQuaternion(value);
    var x = q[0];
    var y = q[1];
    var z = q[2];
    var w = q[3];
    var xx = x * x;
    var yy = y * y;
    var zz = z * z;
    var xy = x * y;
    var xz = x * z;
    var yz = y * z;
    var wx = w * x;
    var wy = w * y;
    var wz = w * z;
    var m00 = 1 - 2 * (yy + zz);
    var m01 = 2 * (xy - wz);
    var m02 = 2 * (xz + wy);
    var m10 = 2 * (xy + wz);
    var m11 = 1 - 2 * (xx + zz);
    var m12 = 2 * (yz - wx);
    var m20 = 2 * (xz - wy);
    var m21 = 2 * (yz + wx);
    var m22 = 1 - 2 * (xx + yy);
    return orthonormalBasis(
      [-m02, -m12, -m22],
      [m01, m11, m21]
    );
  }

  function quaternionDot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  }

  function slerpQuaternion(from, to, amount) {
    var t = clamp(Number(amount) || 0, 0, 1);
    var a = normalizeQuaternion(from);
    var b = normalizeQuaternion(to);
    var cosine = quaternionDot(a, b);
    if (cosine < 0) {
      cosine = -cosine;
      b = [-b[0], -b[1], -b[2], -b[3]];
    }
    if (cosine > 0.9995) {
      return normalizeQuaternion([
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
        a[3] + (b[3] - a[3]) * t
      ]);
    }
    var angle = Math.acos(clamp(cosine, -1, 1));
    var sine = Math.sin(angle);
    var fromWeight = Math.sin((1 - t) * angle) / sine;
    var toWeight = Math.sin(t * angle) / sine;
    return [
      a[0] * fromWeight + b[0] * toWeight,
      a[1] * fromWeight + b[1] * toWeight,
      a[2] * fromWeight + b[2] * toWeight,
      a[3] * fromWeight + b[3] * toWeight
    ];
  }

  function quaternionAngleDeg(a, b) {
    var cosine = Math.abs(quaternionDot(normalizeQuaternion(a), normalizeQuaternion(b)));
    return 2 * Math.acos(clamp(cosine, -1, 1)) * RAD_TO_DEG;
  }

  function interpolateBasis(from, to, amount) {
    return basisFromQuaternion(slerpQuaternion(
      quaternionFromBasis(from),
      quaternionFromBasis(to),
      amount
    ));
  }

  function PoseTimeline(options) {
    options = options || {};
    this.maxAgeMs = Math.max(500, Number(options.maxAgeMs) || 3000);
    this.maxSamples = Math.max(16, Number(options.maxSamples) || 240);
    this.samples = [];
  }

  PoseTimeline.prototype.clear = function () {
    this.samples.length = 0;
  };

  PoseTimeline.prototype.push = function (timeMs, basis, source) {
    var time = Number(timeMs);
    if (!Number.isFinite(time) || !basis) return null;
    var q = quaternionFromBasis(basis);
    var previous = this.samples[this.samples.length - 1];
    if (previous && time <= previous.timeMs) time = previous.timeMs + 0.01;
    var speedDegS = Infinity;
    if (previous) {
      var dt = Math.max(0.01, time - previous.timeMs);
      speedDegS = quaternionAngleDeg(previous.quaternion, q) * 1000 / dt;
    }
    var sample = {
      timeMs: time,
      basis: copyBasis(basis),
      quaternion: q,
      speedDegS: speedDegS,
      source: source || "orientation"
    };
    this.samples.push(sample);
    var cutoff = time - this.maxAgeMs;
    while (this.samples.length > this.maxSamples ||
           (this.samples.length > 2 && this.samples[1].timeMs < cutoff)) {
      this.samples.shift();
    }
    return sample;
  };

  PoseTimeline.prototype.latest = function () {
    return this.samples.length ? this.samples[this.samples.length - 1] : null;
  };

  PoseTimeline.prototype.at = function (timeMs, maxGapMs) {
    var samples = this.samples;
    if (!samples.length) return null;
    var time = Number(timeMs);
    var maxGap = Math.max(0, Number(maxGapMs) || 360);
    if (!Number.isFinite(time)) return null;
    if (time <= samples[0].timeMs) {
      if (samples[0].timeMs - time > maxGap) return null;
      return {
        timeMs: samples[0].timeMs,
        requestedTimeMs: time,
        basis: copyBasis(samples[0].basis),
        source: samples[0].source,
        interpolation: 0,
        gapMs: samples[0].timeMs - time
      };
    }
    var last = samples[samples.length - 1];
    if (time >= last.timeMs) {
      if (time - last.timeMs > maxGap) return null;
      return {
        timeMs: last.timeMs,
        requestedTimeMs: time,
        basis: copyBasis(last.basis),
        source: last.source,
        interpolation: 1,
        gapMs: time - last.timeMs
      };
    }
    var low = 0;
    var high = samples.length - 1;
    while (high - low > 1) {
      var middle = (low + high) >> 1;
      if (samples[middle].timeMs <= time) low = middle;
      else high = middle;
    }
    var before = samples[low];
    var after = samples[high];
    var span = Math.max(0.01, after.timeMs - before.timeMs);
    var amount = clamp((time - before.timeMs) / span, 0, 1);
    return {
      timeMs: time,
      requestedTimeMs: time,
      basis: basisFromQuaternion(slerpQuaternion(
        before.quaternion,
        after.quaternion,
        amount
      )),
      source: before.source === after.source ? before.source : "mixed",
      interpolation: amount,
      gapMs: Math.min(time - before.timeMs, after.timeMs - time)
    };
  };

  /*
   * Capture gating intentionally reads the raw pose history. The display
   * filter is never consulted here, so UI smoothing cannot make a moving
   * handset look falsely steady to the shutter.
   */
  PoseTimeline.prototype.motionStats = function (endTimeMs, windowMs) {
    var end = Number(endTimeMs);
    var windowLength = Math.max(80, Number(windowMs) || 260);
    var samples = this.samples.filter(function (sample) {
      return sample.timeMs <= end + 1 && sample.timeMs >= end - windowLength;
    });
    if (samples.length < 2) {
      return {
        ready: false,
        sampleCount: samples.length,
        durationMs: 0,
        latestAgeMs: samples.length ? Math.max(0, end - samples[0].timeMs) : Infinity,
        instantaneousDegS: Infinity,
        maxDegS: Infinity,
        dispersionDeg: Infinity
      };
    }
    var latest = samples[samples.length - 1];
    var maxSpeed = 0;
    var finiteSpeeds = [];
    var dispersion = 0;
    for (var index = 0; index < samples.length; index += 1) {
      var sample = samples[index];
      if (Number.isFinite(sample.speedDegS)) {
        maxSpeed = Math.max(maxSpeed, sample.speedDegS);
        finiteSpeeds.push(sample.speedDegS);
      }
      dispersion = Math.max(
        dispersion,
        quaternionAngleDeg(sample.quaternion, latest.quaternion)
      );
    }
    finiteSpeeds.sort(function (a, b) { return a - b; });
    // DeviceOrientation commonly contains an isolated high-speed sample even
    // while a handset is resting. Keep maxDegS for diagnostics, but expose a
    // robust upper speed for the shutter gate so one sensor spike cannot block
    // every capture forever. floor(80%) also trims one outlier in a 4-sample
    // low-frequency window.
    var robustSpeedIndex = finiteSpeeds.length
      ? Math.floor((finiteSpeeds.length - 1) * 0.8)
      : -1;
    return {
      ready: true,
      sampleCount: samples.length,
      durationMs: latest.timeMs - samples[0].timeMs,
      latestAgeMs: Math.max(0, end - latest.timeMs),
      instantaneousDegS: latest.speedDegS,
      maxDegS: maxSpeed,
      robustDegS: robustSpeedIndex >= 0
        ? finiteSpeeds[robustSpeedIndex]
        : Infinity,
      dispersionDeg: dispersion
    };
  };

  function DisplayPoseFilter(options) {
    options = options || {};
    this.timeConstantMs = Math.max(1, Number(options.timeConstantMs) || 55);
    this.snapAfterMs = Math.max(80, Number(options.snapAfterMs) || 260);
    this.quaternion = null;
    this.basis = null;
    this.lastTimeMs = 0;
  }

  DisplayPoseFilter.prototype.clear = function () {
    this.quaternion = null;
    this.basis = null;
    this.lastTimeMs = 0;
  };

  DisplayPoseFilter.prototype.update = function (targetBasis, timeMs) {
    if (!targetBasis) return this.basis;
    var target = quaternionFromBasis(targetBasis);
    var now = Number(timeMs);
    if (!Number.isFinite(now)) now = 0;
    if (!this.quaternion || !this.lastTimeMs || now - this.lastTimeMs > this.snapAfterMs) {
      this.quaternion = target;
    } else {
      var dt = Math.max(0, now - this.lastTimeMs);
      var amount = 1 - Math.exp(-dt / this.timeConstantMs);
      this.quaternion = slerpQuaternion(this.quaternion, target, amount);
    }
    this.lastTimeMs = now;
    this.basis = basisFromQuaternion(this.quaternion);
    return this.basis;
  };

  function normalizeFrameTimestamp(value, nowMs) {
    var number = Number(value);
    if (!Number.isFinite(number)) return null;
    // requestVideoFrameCallback timestamps and performance.now() share the
    // document's monotonic time origin. Reject epoch or remote-clock values.
    if (number < nowMs - 10000 || number > nowMs + 1000) return null;
    return number;
  }

  function framePoseTime(nowMs, metadata) {
    metadata = metadata || {};
    var capture = normalizeFrameTimestamp(metadata.captureTime, nowMs);
    if (capture !== null) return { timeMs: capture, source: "captureTime" };
    var presentation = normalizeFrameTimestamp(metadata.presentationTime, nowMs);
    if (presentation !== null) return { timeMs: presentation, source: "presentationTime" };
    var expected = normalizeFrameTimestamp(metadata.expectedDisplayTime, nowMs);
    if (expected !== null) return { timeMs: Math.min(nowMs, expected), source: "expectedDisplayTime" };
    return { timeMs: nowMs, source: "callbackNow" };
  }

  function VideoFrameClock(video, options) {
    options = options || {};
    this.video = video;
    this.onFrame = typeof options.onFrame === "function" ? options.onFrame : null;
    this.running = false;
    this.callbackId = 0;
    this.sequence = 0;
    this.latestFrame = null;
    this.waiters = [];
    this.boundTick = this.tick.bind(this);
  }

  VideoFrameClock.prototype.supported = function () {
    return !!(this.video && typeof this.video.requestVideoFrameCallback === "function");
  };

  VideoFrameClock.prototype.start = function () {
    if (this.running) return;
    this.running = true;
    if (this.supported()) {
      this.callbackId = this.video.requestVideoFrameCallback(this.boundTick);
    }
  };

  VideoFrameClock.prototype.tick = function (now, metadata) {
    if (!this.running) return;
    var poseTime = framePoseTime(now, metadata);
    var frame = {
      sequence: ++this.sequence,
      observedAtMs: now,
      poseTimeMs: poseTime.timeMs,
      timeSource: poseTime.source,
      mediaTime: Number(metadata && metadata.mediaTime),
      presentedFrames: Number(metadata && metadata.presentedFrames),
      width: Number(metadata && metadata.width) || this.video.videoWidth || 0,
      height: Number(metadata && metadata.height) || this.video.videoHeight || 0
    };
    this.latestFrame = frame;
    if (this.onFrame) this.onFrame(frame);
    var pending = this.waiters.slice();
    this.waiters.length = 0;
    for (var index = 0; index < pending.length; index += 1) {
      var waiter = pending[index];
      if (frame.sequence > waiter.afterSequence) {
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      } else {
        this.waiters.push(waiter);
      }
    }
    this.callbackId = this.video.requestVideoFrameCallback(this.boundTick);
  };

  VideoFrameClock.prototype.waitForNext = function (afterSequence, timeoutMs) {
    var self = this;
    var after = Number(afterSequence) || 0;
    if (!this.supported() || !this.running) {
      return Promise.resolve(this.latestFrame);
    }
    return new Promise(function (resolve) {
      var waiter = {
        afterSequence: after,
        resolve: resolve,
        timer: 0
      };
      waiter.timer = setTimeout(function () {
        var index = self.waiters.indexOf(waiter);
        if (index >= 0) self.waiters.splice(index, 1);
        resolve(self.latestFrame);
      }, Math.max(40, Number(timeoutMs) || 180));
      self.waiters.push(waiter);
    });
  };

  VideoFrameClock.prototype.stop = function () {
    this.running = false;
    if (this.supported() && this.callbackId &&
        typeof this.video.cancelVideoFrameCallback === "function") {
      this.video.cancelVideoFrameCallback(this.callbackId);
    }
    this.callbackId = 0;
    var pending = this.waiters.slice();
    this.waiters.length = 0;
    for (var index = 0; index < pending.length; index += 1) {
      clearTimeout(pending[index].timer);
      pending[index].resolve(this.latestFrame);
    }
  };

  function detectCapabilities(video) {
    var nav = typeof navigator !== "undefined" ? navigator : {};
    var win = typeof window !== "undefined" ? window : {};
    var camera = !!(nav.mediaDevices && typeof nav.mediaDevices.getUserMedia === "function");
    var orientation = typeof win.DeviceOrientationEvent !== "undefined";
    var videoFrameCallback = !!(video && typeof video.requestVideoFrameCallback === "function");
    var relativeOrientationSensor = typeof win.RelativeOrientationSensor !== "undefined";
    var secureContext = !!win.isSecureContext ||
      (typeof location !== "undefined" &&
       (location.hostname === "localhost" || location.hostname === "127.0.0.1"));
    var tier;
    var label;
    if (camera && orientation && videoFrameCallback && secureContext) {
      tier = "A";
      label = "帧姿态对时";
    } else if (camera && orientation && secureContext) {
      tier = "B";
      label = "兼容时间估计";
    } else if (camera && secureContext) {
      tier = "C";
      label = "缺少方向姿态";
    } else {
      tier = "D";
      label = secureContext ? "相机不可用" : "需要 HTTPS";
    }
    return {
      tier: tier,
      label: label,
      secureContext: secureContext,
      camera: camera,
      orientation: orientation,
      orientationPermissionPrompt: !!(
        orientation &&
        typeof win.DeviceOrientationEvent.requestPermission === "function"
      ),
      videoFrameCallback: videoFrameCallback,
      relativeOrientationSensor: relativeOrientationSensor,
      canCaptureDirected: camera && orientation && secureContext
    };
  }

  return {
    copyBasis: copyBasis,
    quaternionFromBasis: quaternionFromBasis,
    basisFromQuaternion: basisFromQuaternion,
    quaternionAngleDeg: quaternionAngleDeg,
    slerpQuaternion: slerpQuaternion,
    interpolateBasis: interpolateBasis,
    PoseTimeline: PoseTimeline,
    DisplayPoseFilter: DisplayPoseFilter,
    VideoFrameClock: VideoFrameClock,
    framePoseTime: framePoseTime,
    detectCapabilities: detectCapabilities
  };
});
