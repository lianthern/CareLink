/*
 * UNSEEN 全景拍摄两端共用数学内核。
 *
 * 这份文件同时被网页和微信小程序直接加载，禁止在两端各抄一份坐标公式。
 * 世界坐标固定为：+Y 正前方、+Z 天空、+X 右侧。
 * 相机姿态只用正交基 F/U/R 表示：
 *   F = 后摄镜头朝向，U = 画面上方，R = 画面右方。
 * Capture、渐进粗球和最终 Stitch 全部消费同一份基，不再靠 Euler 符号试凑。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PanoCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var DEG = Math.PI / 180;
  var RAD = 180 / Math.PI;
  var WORLD_UP = [0, 0, 1];

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function centerCropRect(width, height, aspect) {
    var w = Math.max(1, Number(width) || 1);
    var h = Math.max(1, Number(height) || 1);
    var target = Math.max(0.01, Number(aspect) || 1);
    var cropW = w;
    var cropH = h;
    var x = 0;
    var y = 0;
    if (w / h > target) {
      cropW = h * target;
      x = (w - cropW) / 2;
    } else {
      cropH = w / target;
      y = (h - cropH) / 2;
    }
    return { x: x, y: y, width: cropW, height: cropH };
  }
  function wrapDeg(v) { return ((v % 360) + 360) % 360; }
  function shortestDelta(from, to) {
    return ((to - from) % 360 + 540) % 360 - 180;
  }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0]
    ];
  }
  function length(v) { return Math.sqrt(dot(v, v)); }
  function normalize(v, fallback) {
    var n = length(v);
    if (n < 1e-8) return (fallback || [0, 1, 0]).slice();
    return [v[0] / n, v[1] / n, v[2] / n];
  }
  function lerpVec(a, b, t) {
    return [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t
    ];
  }
  function angleDeg(a, b) {
    return Math.acos(clamp(dot(normalize(a), normalize(b)), -1, 1)) * RAD;
  }
  function rotateZ(v, deg) {
    var a = deg * DEG;
    var c = Math.cos(a);
    var s = Math.sin(a);
    return [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]];
  }

  function rotateAroundAxis(v, axis, deg) {
    var n = normalize(axis, WORLD_UP);
    var a = deg * DEG;
    var c = Math.cos(a);
    var s = Math.sin(a);
    var d = dot(n, v) * (1 - c);
    var k = cross(n, v);
    return [
      v[0] * c + k[0] * s + n[0] * d,
      v[1] * c + k[1] * s + n[1] * d,
      v[2] * c + k[2] * s + n[2] * d
    ];
  }

  function headingDeg(basis) {
    return Math.atan2(basis.F[0], basis.F[1]) * RAD;
  }

  function rotateBasisZ(basis, deg) {
    return orthonormalBasis(rotateZ(basis.F, deg), rotateZ(basis.U, deg));
  }

  /*
   * 在相机自己的 U/R/F 轴上施加小旋转。yaw 正值朝画面右侧，pitch
   * 正值朝画面上方；用于把 IMU 姿态当作初值做视觉微调，而不是重新解释
   * DeviceOrientation 的 Euler 符号。
   */
  function rotateBasisLocal(basis, yawDeg, pitchDeg, rollDeg) {
    var F = basis.F.slice();
    var U = basis.U.slice();
    var R = basis.R.slice();
    var yaw = Number(yawDeg) || 0;
    var pitch = Number(pitchDeg) || 0;
    var roll = Number(rollDeg) || 0;
    var axis;
    if (Math.abs(yaw) > 1e-9) {
      axis = U.slice();
      F = rotateAroundAxis(F, axis, -yaw);
      R = rotateAroundAxis(R, axis, -yaw);
    }
    if (Math.abs(pitch) > 1e-9) {
      axis = R.slice();
      F = rotateAroundAxis(F, axis, pitch);
      U = rotateAroundAxis(U, axis, pitch);
    }
    if (Math.abs(roll) > 1e-9) {
      axis = F.slice();
      R = rotateAroundAxis(R, axis, roll);
      U = rotateAroundAxis(U, axis, roll);
    }
    return orthonormalBasis(F, U);
  }

  function orthonormalBasis(forward, upHint) {
    var F = normalize(forward, [0, 1, 0]);
    var R = normalize(cross(F, upHint || WORLD_UP), [1, 0, 0]);
    var U = normalize(cross(R, F), WORLD_UP);
    var horizonRight = normalize(cross(F, WORLD_UP), R);
    var horizonUp = normalize(cross(horizonRight, F), U);
    var roll = Math.atan2(dot(U, horizonRight), dot(U, horizonUp)) * RAD;
    return { F: F, U: U, R: R, rollDeg: roll };
  }

  /*
   * W3C DeviceOrientation：Rz(alpha) * Rx(beta) * Ry(gamma)。
   * 后摄光轴是设备局部 -Z；屏幕右/上方向按 screen.orientation.angle 修正。
   */
  function basisFromDeviceOrientation(alpha, beta, gamma, screenDeg) {
    var a = (Number(alpha) || 0) * DEG;
    var b = (Number(beta) || 0) * DEG;
    var g = (Number(gamma) || 0) * DEG;
    var ca = Math.cos(a), sa = Math.sin(a);
    var cb = Math.cos(b), sb = Math.sin(b);
    var cg = Math.cos(g), sg = Math.sin(g);
    var m = [
      ca * cg - sa * sb * sg, -sa * cb, ca * sg + sa * sb * cg,
      sa * cg + ca * sb * sg,  ca * cb, sa * sg - ca * sb * cg,
      -cb * sg,                 sb,      cb * cg
    ];
    function mv(v) {
      return [
        m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
        m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
        m[6] * v[0] + m[7] * v[1] + m[8] * v[2]
      ];
    }
    var s = (Number(screenDeg) || 0) * DEG;
    var localRight = [Math.cos(s), -Math.sin(s), 0];
    var localUp = [Math.sin(s), Math.cos(s), 0];
    var F = normalize(mv([0, 0, -1]), [0, 1, 0]);
    var R = normalize(mv(localRight), [1, 0, 0]);
    var U = normalize(mv(localUp), WORLD_UP);
    // 传感器取整和跨端实现会有微小非正交误差，统一在这里收回正交基。
    var basis = orthonormalBasis(F, U);
    if (dot(basis.R, R) < 0) {
      basis.R = [-basis.R[0], -basis.R[1], -basis.R[2]];
      basis.U = normalize(cross(basis.R, basis.F), WORLD_UP);
    }
    return basis;
  }

  /*
   * 微信小程序 wx.onDeviceMotionChange 的三个角度使用弧度，而浏览器
   * DeviceOrientationEvent 使用度数。适配必须显式发生，避免真机的 π/2
   * 被误当成 1.57°。最终仍只进入上面同一套 F/U/R 矩阵。
   */
  function basisFromDeviceMotionRadians(alpha, beta, gamma, screenDeg) {
    return basisFromDeviceOrientation(
      (Number(alpha) || 0) * RAD,
      (Number(beta) || 0) * RAD,
      (Number(gamma) || 0) * RAD,
      screenDeg
    );
  }

  /*
   * 开启拍摄时只归零 heading。pitch/roll 保留真实重力关系，不能把歪着拿手机
   * 的起始姿态伪装成水平。
   */
  function rebaseHeading(basis) {
    return rotateBasisZ(basis, headingDeg(basis));
  }

  function smoothBasis(previous, current, t) {
    if (!previous) return orthonormalBasis(current.F, current.U);
    var nextF = normalize(lerpVec(previous.F, current.F, t), current.F);
    var nextU = normalize(lerpVec(previous.U, current.U, t), current.U);
    return orthonormalBasis(nextF, nextU);
  }

  function directionFromYawPitch(yawDeg, pitchDeg) {
    var yaw = yawDeg * DEG;
    var pitch = pitchDeg * DEG;
    var cp = Math.cos(pitch);
    return [Math.sin(yaw) * cp, Math.cos(yaw) * cp, Math.sin(pitch)];
  }

  function yawPitchFromDirection(dir) {
    var d = normalize(dir);
    return {
      yawDeg: wrapDeg(Math.atan2(d[0], d[1]) * RAD),
      pitchDeg: Math.asin(clamp(d[2], -1, 1)) * RAD
    };
  }

  function createTargets(limit) {
    var targets = [];
    var i;
    for (i = 0; i < 12; i += 1) targets.push({ yawDeg: i * 30, pitchDeg: 0 });
    // 竖屏 3:4 相机在 ±50° 两圈可覆盖天顶/地底；±45° 会留下黑色极帽。
    for (i = 0; i < 8; i += 1) targets.push({ yawDeg: i * 45 + 22.5, pitchDeg: 50 });
    for (i = 0; i < 8; i += 1) targets.push({ yawDeg: i * 45 + 22.5, pitchDeg: -50 });
    targets.forEach(function (target, index) {
      target.index = index;
      target.dir = directionFromYawPitch(target.yawDeg, target.pitchDeg);
    });
    return typeof limit === "number" ? targets.slice(0, Math.max(0, limit)) : targets;
  }

  function projectDirection(dir, basis, fovXDeg, aspect) {
    var z = dot(dir, basis.F);
    var tanX = Math.tan((fovXDeg || 65) * DEG / 2);
    var tanY = tanX / Math.max(0.2, Number(aspect) || 1);
    var right = dot(dir, basis.R);
    var up = dot(dir, basis.U);
    var nx = z > 1e-5 ? right / (z * tanX) : 0;
    var ny = z > 1e-5 ? up / (z * tanY) : 0;
    var guideX = z > 1e-5 ? nx : right / tanX;
    var guideY = z > 1e-5 ? ny : up / tanY;
    if (Math.abs(guideX) + Math.abs(guideY) < 1e-5) guideX = 1;
    var guideScale = Math.max(Math.abs(guideX), Math.abs(guideY), 1e-5);
    return {
      visible: z > 1e-5 && Math.abs(nx) <= 1.18 && Math.abs(ny) <= 1.18,
      behind: z <= 1e-5,
      nx: nx,
      ny: ny,
      guideNx: guideX / guideScale,
      guideNy: guideY / guideScale,
      angleDeg: angleDeg(dir, basis.F)
    };
  }

  function directionFromImagePoint(nx, ny, basis, fovXDeg, aspect) {
    var tanX = Math.tan((Number(fovXDeg) || 65) * DEG / 2);
    var tanY = tanX / Math.max(0.2, Number(aspect) || 1);
    return normalize([
      basis.F[0] + basis.R[0] * nx * tanX + basis.U[0] * ny * tanY,
      basis.F[1] + basis.R[1] * nx * tanX + basis.U[1] * ny * tanY,
      basis.F[2] + basis.R[2] * nx * tanX + basis.U[2] * ny * tanY
    ], basis.F);
  }

  function imagePointFromDirection(dir, basis, fovXDeg, aspect) {
    var z = dot(dir, basis.F);
    if (z <= 1e-7) return null;
    var tanX = Math.tan((Number(fovXDeg) || 65) * DEG / 2);
    var tanY = tanX / Math.max(0.2, Number(aspect) || 1);
    return {
      nx: dot(dir, basis.R) / (z * tanX),
      ny: dot(dir, basis.U) / (z * tanY),
      depth: z
    };
  }

  function basisRotationErrorDeg(a, b) {
    var trace = dot(a.R, b.R) + dot(a.U, b.U) + dot(a.F, b.F);
    return Math.acos(clamp((trace - 1) / 2, -1, 1)) * RAD;
  }

  function createRaster(width, height) {
    var w = Math.max(2, width | 0);
    var h = Math.max(1, height | 0);
    var raster = {
      width: w,
      height: h,
      pixels: new Uint8ClampedArray(w * h * 4),
      weights: new Float32Array(w * h),
      lonSin: new Float32Array(w),
      lonCos: new Float32Array(w),
      latSin: new Float32Array(h),
      latCos: new Float32Array(h)
    };
    var x, y, lon, lat;
    for (x = 0; x < w; x += 1) {
      lon = (x / w) * Math.PI * 2;
      raster.lonSin[x] = Math.sin(lon);
      raster.lonCos[x] = Math.cos(lon);
    }
    for (y = 0; y < h; y += 1) {
      lat = Math.PI / 2 - ((y + 0.5) / h) * Math.PI;
      raster.latSin[y] = Math.sin(lat);
      raster.latCos[y] = Math.cos(lat);
    }
    for (x = 3; x < raster.pixels.length; x += 4) raster.pixels[x] = 255;
    return raster;
  }

  function sampleRgbaBilinear(pixels, width, height, x, y, out) {
    var x0 = clamp(Math.floor(x), 0, width - 1);
    var y0 = clamp(Math.floor(y), 0, height - 1);
    var x1 = Math.min(width - 1, x0 + 1);
    var y1 = Math.min(height - 1, y0 + 1);
    var tx = clamp(x - x0, 0, 1);
    var ty = clamp(y - y0, 0, 1);
    var i00 = (y0 * width + x0) * 4;
    var i10 = (y0 * width + x1) * 4;
    var i01 = (y1 * width + x0) * 4;
    var i11 = (y1 * width + x1) * 4;
    var channel;
    for (channel = 0; channel < 3; channel += 1) {
      out[channel] =
        (pixels[i00 + channel] * (1 - tx) + pixels[i10 + channel] * tx) * (1 - ty) +
        (pixels[i01 + channel] * (1 - tx) + pixels[i11 + channel] * tx) * ty;
    }
    out[3] = 255;
    return out;
  }

  /*
   * 把一张真实照片按拍摄瞬间的 F/U/R 反投影到等距柱状图。
   * srcPixels 必须是 RGBA；返回写入像素数，0 表示本帧没有有效覆盖。
   */
  function projectPatch(raster, srcPixels, srcWidth, srcHeight, basis, options) {
    options = options || {};
    var fovX = (options.fovXDeg || 65) * DEG;
    var tanX = Math.tan(fovX / 2);
    var aspect = srcWidth / Math.max(1, srcHeight);
    var tanY = tanX / Math.max(0.2, aspect);
    var feather = clamp(Number(options.feather) || 0.18, 0.02, 0.48);
    var gain = Number(options.gain) || 1;
    var bias = Number(options.bias) || 0;
    var bilinear = options.bilinear === true;
    var rawSourceConfidence = Number(options.sourceConfidence);
    var sourceConfidence = options.sourceConfidence == null ||
      !isFinite(rawSourceConfidence) ?
      1 : clamp(rawSourceConfidence, 0.2, 1);
    var priorities = raster.priorities || null;
    var sample = [0, 0, 0, 255];
    var w = raster.width;
    var h = raster.height;
    var written = 0;
    var y, x;
    for (y = 0; y < h; y += 1) {
      var dz = raster.latSin[y];
      var cp = raster.latCos[y];
      for (x = 0; x < w; x += 1) {
        var dx = raster.lonSin[x] * cp;
        var dy = raster.lonCos[x] * cp;
        var zCam = dx * basis.F[0] + dy * basis.F[1] + dz * basis.F[2];
        if (zCam <= 1e-5) continue;
        var xNorm = (dx * basis.R[0] + dy * basis.R[1] + dz * basis.R[2]) / (zCam * tanX);
        var yNorm = (dx * basis.U[0] + dy * basis.U[1] + dz * basis.U[2]) / (zCam * tanY);
        var ax = Math.abs(xNorm);
        var ay = Math.abs(yNorm);
        if (ax > 1 || ay > 1) continue;
        var edge = Math.min(1 - ax, 1 - ay);
        var weight = clamp(edge / feather, 0, 1);
        weight = weight * weight * (3 - 2 * weight);
        if (weight <= 0.001) continue;
        var sxFloat = clamp((xNorm * 0.5 + 0.5) * (srcWidth - 1), 0, srcWidth - 1);
        var syFloat = clamp((0.5 - yNorm * 0.5) * (srcHeight - 1), 0, srcHeight - 1);
        var si = 0;
        if (bilinear) {
          sampleRgbaBilinear(
            srcPixels,
            srcWidth,
            srcHeight,
            sxFloat,
            syFloat,
            sample
          );
        } else {
          var sx = Math.round(sxFloat);
          var sy = Math.round(syFloat);
          si = (sy * srcWidth + sx) * 4;
          sample[0] = srcPixels[si];
          sample[1] = srcPixels[si + 1];
          sample[2] = srcPixels[si + 2];
          sample[3] = srcPixels[si + 3];
        }
        var di = (y * w + x) * 4;
        var wi = y * w + x;
        var oldWeight = raster.weights[wi];
        var total = oldWeight + weight;
        raster.pixels[di] = clamp((raster.pixels[di] * oldWeight + (sample[0] * gain + bias) * weight) / total, 0, 255);
        raster.pixels[di + 1] = clamp((raster.pixels[di + 1] * oldWeight + (sample[1] * gain + bias) * weight) / total, 0, 255);
        raster.pixels[di + 2] = clamp((raster.pixels[di + 2] * oldWeight + (sample[2] * gain + bias) * weight) / total, 0, 255);
        raster.pixels[di + 3] = 255;
        raster.weights[wi] = total;
        if (priorities) {
          var centerPriority = (1 - ax) * (1 - ay);
          centerPriority = centerPriority * centerPriority * sourceConfidence;
          if (centerPriority > priorities[wi]) priorities[wi] = centerPriority;
        }
        written += 1;
      }
    }
    return written;
  }

  function createProjectionLayer(raster) {
    return {
      width: raster.width,
      height: raster.height,
      pixels: new Uint8ClampedArray(raster.width * raster.height * 4),
      weights: new Float32Array(raster.width * raster.height),
      priorities: new Float32Array(raster.width * raster.height),
      // Trigonometric lookup tables are immutable and can be shared with the
      // destination. A single temporary layer is released after every frame.
      lonSin: raster.lonSin,
      lonCos: raster.lonCos,
      latSin: raster.latSin,
      latCos: raster.latCos
    };
  }

  function colorDistance(pixelsA, pixelsB, pixelIndex) {
    var offset = pixelIndex * 4;
    var dr = pixelsA[offset] - pixelsB[offset];
    var dg = pixelsA[offset + 1] - pixelsB[offset + 1];
    var db = pixelsA[offset + 2] - pixelsB[offset + 2];
    return Math.sqrt((dr * dr + dg * dg + db * db) / 3);
  }

  function median(values) {
    if (!values.length) return 0;
    values.sort(function (a, b) { return a - b; });
    var middle = Math.floor(values.length / 2);
    return values.length % 2 ?
      values[middle] :
      (values[middle - 1] + values[middle]) / 2;
  }

  /*
   * 对当前临时投影层做一次稳健的 overlap 残余曝光补偿。线上帧已经带有
   * 光度配准所得 gain/bias；这里仅吸收其链式传播误差。中位数统计会忽略
   * 少量视差/运动前景，并把修正限制在保守区间，避免把内容差当曝光差。
   */
  function compensateLayerExposure(raster, layer, options) {
    options = options || {};
    if (options.autoExposure === false) {
      return { applied: false, samples: 0, gain: 1, bias: [0, 0, 0] };
    }
    var targetSamples = Math.max(256, Number(options.exposureSamples) || 1800);
    var step = Math.max(
      1,
      Math.floor(raster.weights.length / targetSamples)
    );
    var logRatios = [];
    var sampleIndices = [];
    var i;
    for (i = 0; i < raster.weights.length; i += step) {
      if (raster.weights[i] <= 0.05 || layer.weights[i] <= 0.05) continue;
      var offset = i * 4;
      var oldLuma = raster.pixels[offset] * 0.2126 +
        raster.pixels[offset + 1] * 0.7152 +
        raster.pixels[offset + 2] * 0.0722;
      var newLuma = layer.pixels[offset] * 0.2126 +
        layer.pixels[offset + 1] * 0.7152 +
        layer.pixels[offset + 2] * 0.0722;
      if (oldLuma < 16 || oldLuma > 239 || newLuma < 16 || newLuma > 239) continue;
      if (Math.abs(oldLuma - newLuma) > 96) continue;
      logRatios.push(Math.log((oldLuma + 8) / (newLuma + 8)));
      sampleIndices.push(i);
    }
    if (logRatios.length < 32) {
      return {
        applied: false,
        samples: logRatios.length,
        gain: 1,
        bias: [0, 0, 0]
      };
    }
    var maxGain = options.maxExposureGain == null ?
      1.28 : Math.max(1, Number(options.maxExposureGain));
    var gain = clamp(Math.exp(median(logRatios)), 1 / maxGain, maxGain);
    var channelBiases = [[], [], []];
    for (i = 0; i < sampleIndices.length; i += 1) {
      var pixelIndex = sampleIndices[i];
      var pixelOffset = pixelIndex * 4;
      var channel;
      for (channel = 0; channel < 3; channel += 1) {
        var residual = raster.pixels[pixelOffset + channel] -
          layer.pixels[pixelOffset + channel] * gain;
        if (Math.abs(residual) <= 72) channelBiases[channel].push(residual);
      }
    }
    var maxBias = options.maxExposureBias == null ?
      24 : Math.max(0, Number(options.maxExposureBias));
    var biases = channelBiases.map(function (values) {
      return clamp(median(values), -maxBias, maxBias);
    });
    if (Math.abs(gain - 1) < 0.004 &&
        Math.max(Math.abs(biases[0]), Math.abs(biases[1]), Math.abs(biases[2])) < 0.8) {
      return {
        applied: false,
        samples: logRatios.length,
        gain: gain,
        bias: biases
      };
    }
    for (i = 0; i < layer.weights.length; i += 1) {
      if (layer.weights[i] <= 0.001) continue;
      var out = i * 4;
      layer.pixels[out] = clamp(layer.pixels[out] * gain + biases[0], 0, 255);
      layer.pixels[out + 1] = clamp(
        layer.pixels[out + 1] * gain + biases[1],
        0,
        255
      );
      layer.pixels[out + 2] = clamp(
        layer.pixels[out + 2] * gain + biases[2],
        0,
        255
      );
    }
    return {
      applied: true,
      samples: logRatios.length,
      gain: gain,
      bias: biases
    };
  }

  /*
   * Conservative projected-layer residual warp.
   *
   * The global SO(3) graph removes camera-pose drift, but a browser video
   * frame can still contain per-frame EIS crop/scale, rolling-shutter shear,
   * and small translation parallax.  Those effects cannot be represented by
   * one basis and one session FOV.  This opt-in 8x6 inverse-flow mesh repairs
   * only a coherent, low-amplitude residual.  Every acceptance gate is
   * evaluated before merge; a rejected field is exactly the old path.
   *
   * No second panorama-sized layer is allocated.  The seam planner and merge
   * sample the original projected layer on demand through the accepted mesh.
   */
  function wrapPixelX(x, width) {
    return ((x % width) + width) % width;
  }

  function sampleProjectedContainer(container, x, y, out) {
    out = out || [0, 0, 0, 0, 0];
    var width = container.width;
    var height = container.height;
    if (!(y >= 0 && y <= height - 1)) return false;
    var wrappedX = wrapPixelX(x, width);
    var x0 = Math.floor(wrappedX);
    var y0 = Math.floor(y);
    var x1 = (x0 + 1) % width;
    var y1 = Math.min(height - 1, y0 + 1);
    var tx = wrappedX - x0;
    var ty = y - y0;
    var i00 = y0 * width + x0;
    var i10 = y0 * width + x1;
    var i01 = y1 * width + x0;
    var i11 = y1 * width + x1;
    var w00 = (1 - tx) * (1 - ty);
    var w10 = tx * (1 - ty);
    var w01 = (1 - tx) * ty;
    var w11 = tx * ty;
    // An integer sample has zero contribution from x1/y1. Requiring those
    // neighbours to be covered incorrectly punches a one-pixel hole around a
    // valid support boundary.
    if ((w00 > 1e-8 && container.weights[i00] <= 0.001) ||
        (w10 > 1e-8 && container.weights[i10] <= 0.001) ||
        (w01 > 1e-8 && container.weights[i01] <= 0.001) ||
        (w11 > 1e-8 && container.weights[i11] <= 0.001)) {
      return false;
    }
    var channel;
    for (channel = 0; channel < 3; channel += 1) {
      out[channel] =
        container.pixels[i00 * 4 + channel] * w00 +
        container.pixels[i10 * 4 + channel] * w10 +
        container.pixels[i01 * 4 + channel] * w01 +
        container.pixels[i11 * 4 + channel] * w11;
    }
    out[3] = container.weights[i00] * w00 +
      container.weights[i10] * w10 +
      container.weights[i01] * w01 +
      container.weights[i11] * w11;
    var priorities = container.priorities;
    out[4] = priorities ?
      priorities[i00] * w00 + priorities[i10] * w10 +
        priorities[i01] * w01 + priorities[i11] * w11 : out[3];
    return true;
  }

  function residualWarpAt(warp, x, y, out) {
    out = out || [0, 0];
    out[0] = 0;
    out[1] = 0;
    if (!warp || !warp.active ||
        !(y >= warp.minY && y <= warp.maxY)) return out;
    var localX = x - warp.centerX;
    var halfWidth = warp.panoramaWidth / 2;
    while (localX < -halfWidth) localX += warp.panoramaWidth;
    while (localX >= halfWidth) localX -= warp.panoramaWidth;
    if (localX < warp.minLocalX || localX > warp.maxLocalX) return out;
    var ux = (localX - warp.minLocalX) /
      Math.max(1e-6, warp.maxLocalX - warp.minLocalX) * warp.gridCols;
    var uy = (y - warp.minY) /
      Math.max(1e-6, warp.maxY - warp.minY) * warp.gridRows;
    var gx = Math.min(warp.gridCols - 1, Math.max(0, Math.floor(ux)));
    var gy = Math.min(warp.gridRows - 1, Math.max(0, Math.floor(uy)));
    var tx = clamp(ux - gx, 0, 1);
    var ty = clamp(uy - gy, 0, 1);
    var columns = warp.gridCols + 1;
    var i00 = gy * columns + gx;
    var i10 = i00 + 1;
    var i01 = i00 + columns;
    var i11 = i01 + 1;
    out[0] =
      (warp.dx[i00] * (1 - tx) + warp.dx[i10] * tx) * (1 - ty) +
      (warp.dx[i01] * (1 - tx) + warp.dx[i11] * tx) * ty;
    out[1] =
      (warp.dy[i00] * (1 - tx) + warp.dy[i10] * tx) * (1 - ty) +
      (warp.dy[i01] * (1 - tx) + warp.dy[i11] * tx) * ty;
    var cellWidth = Math.max(
      1e-6,
      (warp.maxLocalX - warp.minLocalX) / warp.gridCols
    );
    var cellHeight = Math.max(
      1e-6,
      (warp.maxY - warp.minY) / warp.gridRows
    );
    var edgeCells = warp.edgeTaperCells > 0 ? warp.edgeTaperCells : 1.25;
    var edgeDistance = Math.min(
      localX - warp.minLocalX,
      warp.maxLocalX - localX,
      y - warp.minY,
      warp.maxY - y
    );
    var edgeTaper = clamp(
      edgeDistance / (Math.min(cellWidth, cellHeight) * edgeCells),
      0,
      1
    );
    edgeTaper = edgeTaper * edgeTaper * (3 - 2 * edgeTaper);
    out[0] *= edgeTaper;
    out[1] *= edgeTaper;
    return out;
  }

  function sampleProjectedLayer(
    layer,
    warp,
    x,
    y,
    out,
    displacement
  ) {
    out = out || [0, 0, 0, 0, 0];
    // Always establish a valid raw sample first. It is the exact fallback if
    // the inverse target leaves the projected support.
    if (!sampleProjectedContainer(layer, x, y, out)) return false;
    displacement = residualWarpAt(warp, x, y, displacement || [0, 0]);
    if (!(displacement[0] || displacement[1])) return true;

    // Fade once more through the projected source feather. Combined with the
    // 1.25-cell geometric taper in residualWarpAt, the entire current frame
    // consumes one continuous inverse field and reaches exactly zero before
    // the raw support boundary.
    var boundaryWeight = warp && warp.boundaryWeight > 0 ?
      warp.boundaryWeight : 0.2;
    var layerTaper = clamp(out[3] / boundaryWeight, 0, 1);
    layerTaper = layerTaper * layerTaper * (3 - 2 * layerTaper);
    var taper = layerTaper;
    if (taper <= 1e-4) return true;
    var warpedX = x + displacement[0] * taper;
    var warpedY = y + displacement[1] * taper;
    if (sampleProjectedContainer(layer, warpedX, warpedY, out)) return true;

    return false;
  }

  function projectedPatchScore(
    raster,
    layer,
    oldX,
    oldY,
    newX,
    newY,
    sampleStep,
    scratch
  ) {
    scratch = scratch || {};
    var oldSample = scratch.oldSample || (scratch.oldSample = [0, 0, 0, 0, 0]);
    var newSample = scratch.newSample || (scratch.newSample = [0, 0, 0, 0, 0]);
    var radius = sampleStep * 3;
    var sumA = 0;
    var sumB = 0;
    var sumAA = 0;
    var sumBB = 0;
    var sumAB = 0;
    var count = 0;
    var oy, ox;
    for (oy = -radius; oy <= radius; oy += sampleStep) {
      for (ox = -radius; ox <= radius; ox += sampleStep) {
        if (!sampleProjectedContainer(
          raster,
          oldX + ox,
          oldY + oy,
          oldSample
        ) || !sampleProjectedContainer(
          layer,
          newX + ox,
          newY + oy,
          newSample
        )) continue;
        var a = oldSample[0] * 0.2126 + oldSample[1] * 0.7152 +
          oldSample[2] * 0.0722;
        var b = newSample[0] * 0.2126 + newSample[1] * 0.7152 +
          newSample[2] * 0.0722;
        sumA += a;
        sumB += b;
        sumAA += a * a;
        sumBB += b * b;
        sumAB += a * b;
        count += 1;
      }
    }
    if (count < 36) return { score: -1, std: 0, count: count };
    var varA = Math.max(1e-9, sumAA - sumA * sumA / count);
    var varB = Math.max(1e-9, sumBB - sumB * sumB / count);
    return {
      score: (sumAB - sumA * sumB / count) / Math.sqrt(varA * varB),
      std: Math.sqrt(varA / count),
      count: count
    };
  }

  function projectedPatchOwnerPurity(raster, x, y, sampleStep) {
    if (!raster.owners) return 1;
    var counts = new Uint8Array(255);
    var radius = sampleStep * 3;
    var total = 0;
    var maximum = 0;
    var oy, ox;
    for (oy = -radius; oy <= radius; oy += sampleStep) {
      var py = Math.round(y + oy);
      if (py < 0 || py >= raster.height) continue;
      for (ox = -radius; ox <= radius; ox += sampleStep) {
        var px = Math.round(wrapPixelX(x + ox, raster.width)) % raster.width;
        var owner = raster.owners[py * raster.width + px];
        if (!owner) continue;
        counts[owner] += 1;
        maximum = Math.max(maximum, counts[owner]);
        total += 1;
      }
    }
    return total ? maximum / total : 0;
  }

  function findProjectedLayerFootprint(layer, sampleStep) {
    var width = layer.width;
    var height = layer.height;
    var centreIndex = -1;
    var centrePriority = -1;
    var i;
    for (i = 0; i < layer.weights.length; i += sampleStep) {
      if (layer.weights[i] <= 0.05) continue;
      var priority = layer.priorities ? layer.priorities[i] : layer.weights[i];
      if (priority > centrePriority) {
        centrePriority = priority;
        centreIndex = i;
      }
    }
    if (centreIndex < 0) return null;
    var centerX = centreIndex % width;
    var minLocalX = Infinity;
    var maxLocalX = -Infinity;
    var minY = height;
    var maxY = -1;
    var y, x;
    for (y = 0; y < height; y += sampleStep) {
      for (x = 0; x < width; x += sampleStep) {
        var index = y * width + x;
        if (layer.weights[index] <= 0.05) continue;
        var localX = x - centerX;
        if (localX < -width / 2) localX += width;
        if (localX >= width / 2) localX -= width;
        minLocalX = Math.min(minLocalX, localX);
        maxLocalX = Math.max(maxLocalX, localX);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
    if (!isFinite(minLocalX) || maxY < minY) return null;
    return {
      centerX: centerX,
      minLocalX: minLocalX,
      maxLocalX: maxLocalX,
      minY: minY,
      maxY: maxY
    };
  }

  function searchProjectedMatch(
    raster,
    layer,
    x,
    y,
    coarseStep,
    maxDisplacement
  ) {
    var scoreScratch = {
      oldSample: [0, 0, 0, 0, 0],
      newSample: [0, 0, 0, 0, 0]
    };
    if (!sampleProjectedContainer(raster, x, y, scoreScratch.oldSample) ||
        !sampleProjectedContainer(layer, x, y, scoreScratch.newSample)) {
      return {
        accepted: false,
        dx: 0,
        dy: 0,
        score: -1,
        zeroScore: -1,
        margin: 0,
        reverseMargin: 0,
        improvement: 0,
        forwardBackwardPx: Infinity,
        ownerPurity: 0,
        confidence: 0
      };
    }
    var zero = projectedPatchScore(
      raster,
      layer,
      x,
      y,
      x,
      y,
      coarseStep,
      scoreScratch
    );
    var bestScore = -2;
    var bestDx = 0;
    var bestDy = 0;
    // Keep every evaluated candidate for exact non-maximum suppression after
    // the final winner is known. A top-N leaderboard can be filled entirely by
    // one broad peak and miss an equally good repeated-texture basin.
    var candidateScores = [];
    var candidateDxValues = [];
    var candidateDyValues = [];
    function rememberCandidate(candidateScore, candidateDxValue, candidateDyValue) {
      if (!isFinite(candidateScore)) return;
      candidateScores.push(candidateScore);
      candidateDxValues.push(candidateDxValue);
      candidateDyValues.push(candidateDyValue);
    }
    var dx, dy;
    for (dy = -maxDisplacement; dy <= maxDisplacement; dy += coarseStep) {
      for (dx = -maxDisplacement; dx <= maxDisplacement; dx += coarseStep) {
        var coarse = projectedPatchScore(
          raster,
          layer,
          x,
          y,
          x + dx,
          y + dy,
          coarseStep,
          scoreScratch
        );
        rememberCandidate(coarse.score, dx, dy);
        if (coarse.score > bestScore) {
          bestScore = coarse.score;
          bestDx = dx;
          bestDy = dy;
        }
      }
    }
    var refineRadius = Math.max(1, coarseStep);
    var refinedScore = -2;
    var refinedDx = bestDx;
    var refinedDy = bestDy;
    var secondScore = -2;
    for (dy = bestDy - refineRadius; dy <= bestDy + refineRadius; dy += 1) {
      if (Math.abs(dy) > maxDisplacement) continue;
      for (dx = bestDx - refineRadius; dx <= bestDx + refineRadius; dx += 1) {
        if (Math.abs(dx) > maxDisplacement) continue;
        var refined = projectedPatchScore(
          raster,
          layer,
          x,
          y,
          x + dx,
          y + dy,
          coarseStep,
          scoreScratch
        );
        rememberCandidate(refined.score, dx, dy);
        if (refined.score > refinedScore) {
          secondScore = refinedScore;
          refinedScore = refined.score;
          refinedDx = dx;
          refinedDy = dy;
        } else if (Math.max(
          Math.abs(dx - refinedDx),
          Math.abs(dy - refinedDy)
        ) > 2) {
          secondScore = Math.max(secondScore, refined.score);
        }
      }
    }

    // Exact basin-external second peak after the final winner is known.
    secondScore = -2;
    var candidateIndex;
    for (
      candidateIndex = 0;
      candidateIndex < candidateScores.length;
      candidateIndex += 1
    ) {
      if (Math.max(
        Math.abs(candidateDxValues[candidateIndex] - refinedDx),
        Math.abs(candidateDyValues[candidateIndex] - refinedDy)
      ) <= 2) continue;
      secondScore = Math.max(secondScore, candidateScores[candidateIndex]);
    }

    var reverseBestScore = -2;
    var reverseDx = 0;
    var reverseDy = 0;
    var newX = x + refinedDx;
    var newY = y + refinedDy;
    var reverseCandidateScores = [];
    var reverseCandidateDx = [];
    var reverseCandidateDy = [];
    for (dy = -maxDisplacement; dy <= maxDisplacement; dy += coarseStep) {
      for (dx = -maxDisplacement; dx <= maxDisplacement; dx += coarseStep) {
        var reverse = projectedPatchScore(
          raster,
          layer,
          newX + dx,
          newY + dy,
          newX,
          newY,
          coarseStep,
          scoreScratch
        );
        reverseCandidateScores.push(reverse.score);
        reverseCandidateDx.push(dx);
        reverseCandidateDy.push(dy);
        if (reverse.score > reverseBestScore) {
          reverseBestScore = reverse.score;
          reverseDx = dx;
          reverseDy = dy;
        }
      }
    }
    var reverseRefinedScore = reverseBestScore;
    var reverseRefinedDx = reverseDx;
    var reverseRefinedDy = reverseDy;
    for (dy = reverseDy - refineRadius; dy <= reverseDy + refineRadius; dy += 1) {
      if (Math.abs(dy) > maxDisplacement) continue;
      for (dx = reverseDx - refineRadius; dx <= reverseDx + refineRadius; dx += 1) {
        if (Math.abs(dx) > maxDisplacement) continue;
        reverse = projectedPatchScore(
          raster,
          layer,
          newX + dx,
          newY + dy,
          newX,
          newY,
          coarseStep,
          scoreScratch
        );
        reverseCandidateScores.push(reverse.score);
        reverseCandidateDx.push(dx);
        reverseCandidateDy.push(dy);
        if (reverse.score > reverseRefinedScore) {
          reverseRefinedScore = reverse.score;
          reverseRefinedDx = dx;
          reverseRefinedDy = dy;
        }
      }
    }
    var reverseSecondScore = -2;
    for (
      candidateIndex = 0;
      candidateIndex < reverseCandidateScores.length;
      candidateIndex += 1
    ) {
      if (Math.max(
        Math.abs(reverseCandidateDx[candidateIndex] - reverseRefinedDx),
        Math.abs(reverseCandidateDy[candidateIndex] - reverseRefinedDy)
      ) <= 2) continue;
      reverseSecondScore = Math.max(
        reverseSecondScore,
        reverseCandidateScores[candidateIndex]
      );
    }
    var magnitude = Math.sqrt(refinedDx * refinedDx + refinedDy * refinedDy);
    var forwardBackward = Math.sqrt(
      Math.pow(refinedDx + reverseRefinedDx, 2) +
      Math.pow(refinedDy + reverseRefinedDy, 2)
    );
    var margin = refinedScore - secondScore;
    var reverseMargin = reverseRefinedScore - reverseSecondScore;
    var improvement = refinedScore - zero.score;
    var ownerPurity = projectedPatchOwnerPurity(
      raster,
      x,
      y,
      coarseStep
    );
    var accepted = zero.count >= 36 && zero.std >= 8 &&
      refinedScore >= 0.8 && margin >= 0.025 && ownerPurity >= 0.65 &&
      reverseRefinedScore >= 0.8 && reverseMargin >= 0.02 &&
      (magnitude <= 1 || improvement >= 0.025) &&
      forwardBackward <= Math.max(2, magnitude * 0.2);
    var confidence = accepted ?
      clamp((refinedScore - 0.78) / 0.2, 0, 1) *
        clamp(margin / 0.09, 0, 1) * ownerPurity : 0;
    return {
      accepted: accepted,
      dx: refinedDx,
      dy: refinedDy,
      score: refinedScore,
      zeroScore: zero.score,
      margin: margin,
      reverseMargin: reverseMargin,
      improvement: improvement,
      forwardBackwardPx: forwardBackward,
      ownerPurity: ownerPurity,
      confidence: confidence
    };
  }

  function analyzeResidualFlowClusters(matches, warp) {
    var accepted = [];
    var i;
    for (i = 0; i < matches.length; i += 1) {
      if (matches[i].accepted) accepted.push(i);
    }
    var result = {
      dominantMatches: accepted.length,
      secondaryMatches: 0,
      separationPx: 0,
      dominantMagnitudePx: 0,
      secondaryMagnitudePx: 0,
      meanMagnitudePx: 0,
      spreadP75Px: 0,
      competing: false,
      nearConstantLarge: false
    };
    if (accepted.length < 4) return result;
    var meanDx = 0;
    var meanDy = 0;
    for (i = 0; i < accepted.length; i += 1) {
      meanDx += matches[accepted[i]].dx;
      meanDy += matches[accepted[i]].dy;
    }
    meanDx /= accepted.length;
    meanDy /= accepted.length;
    var flowDeviations = [];
    for (i = 0; i < accepted.length; i += 1) {
      flowDeviations.push(Math.sqrt(
        Math.pow(matches[accepted[i]].dx - meanDx, 2) +
        Math.pow(matches[accepted[i]].dy - meanDy, 2)
      ));
    }
    result.meanMagnitudePx = Math.sqrt(meanDx * meanDx + meanDy * meanDy);
    result.spreadP75Px = percentile(flowDeviations, 0.75);
    result.nearConstantLarge = result.meanMagnitudePx > Math.max(
      1.25,
      warp.panoramaWidth * 1.25 / 360
    ) && result.spreadP75Px < Math.max(
      0.4,
      warp.panoramaWidth * 0.25 / 360
    );
    var clusterRadius = Math.max(
      1.25,
      warp.panoramaWidth * 0.55 / 360
    );
    var bestSeed = accepted[0];
    var bestCount = -1;
    var seedIndex;
    for (seedIndex = 0; seedIndex < accepted.length; seedIndex += 1) {
      var seed = matches[accepted[seedIndex]];
      var count = 0;
      var compareIndex;
      for (compareIndex = 0; compareIndex < accepted.length; compareIndex += 1) {
        var compare = matches[accepted[compareIndex]];
        if (Math.sqrt(
          Math.pow(compare.dx - seed.dx, 2) +
          Math.pow(compare.dy - seed.dy, 2)
        ) <= clusterRadius) count += 1;
      }
      if (count > bestCount) {
        bestCount = count;
        bestSeed = accepted[seedIndex];
      }
    }
    var dominantMask = new Uint8Array(matches.length);
    var dominantDx = 0;
    var dominantDy = 0;
    var dominantCount = 0;
    var dominantSeed = matches[bestSeed];
    for (i = 0; i < accepted.length; i += 1) {
      var acceptedMatch = matches[accepted[i]];
      if (Math.sqrt(
        Math.pow(acceptedMatch.dx - dominantSeed.dx, 2) +
        Math.pow(acceptedMatch.dy - dominantSeed.dy, 2)
      ) > clusterRadius) continue;
      dominantMask[accepted[i]] = 1;
      dominantDx += acceptedMatch.dx;
      dominantDy += acceptedMatch.dy;
      dominantCount += 1;
    }
    dominantDx /= Math.max(1, dominantCount);
    dominantDy /= Math.max(1, dominantCount);
    var secondarySeed = -1;
    var secondaryBestCount = 0;
    for (seedIndex = 0; seedIndex < accepted.length; seedIndex += 1) {
      if (dominantMask[accepted[seedIndex]]) continue;
      seed = matches[accepted[seedIndex]];
      count = 0;
      for (compareIndex = 0; compareIndex < accepted.length; compareIndex += 1) {
        if (dominantMask[accepted[compareIndex]]) continue;
        compare = matches[accepted[compareIndex]];
        if (Math.sqrt(
          Math.pow(compare.dx - seed.dx, 2) +
          Math.pow(compare.dy - seed.dy, 2)
        ) <= clusterRadius) count += 1;
      }
      if (count > secondaryBestCount) {
        secondaryBestCount = count;
        secondarySeed = accepted[seedIndex];
      }
    }
    var secondaryDx = 0;
    var secondaryDy = 0;
    var secondaryCount = 0;
    if (secondarySeed >= 0) {
      var candidateSeed = matches[secondarySeed];
      for (i = 0; i < accepted.length; i += 1) {
        if (dominantMask[accepted[i]]) continue;
        acceptedMatch = matches[accepted[i]];
        if (Math.sqrt(
          Math.pow(acceptedMatch.dx - candidateSeed.dx, 2) +
          Math.pow(acceptedMatch.dy - candidateSeed.dy, 2)
        ) > clusterRadius) continue;
        secondaryDx += acceptedMatch.dx;
        secondaryDy += acceptedMatch.dy;
        secondaryCount += 1;
      }
    }
    secondaryDx /= Math.max(1, secondaryCount);
    secondaryDy /= Math.max(1, secondaryCount);
    var separation = secondaryCount ? Math.sqrt(
      Math.pow(dominantDx - secondaryDx, 2) +
      Math.pow(dominantDy - secondaryDy, 2)
    ) : 0;
    var dominantMagnitude = Math.sqrt(
      dominantDx * dominantDx + dominantDy * dominantDy
    );
    var secondaryMagnitude = Math.sqrt(
      secondaryDx * secondaryDx + secondaryDy * secondaryDy
    );
    var minimumSecondary = Math.max(2, Math.ceil(accepted.length * 0.14));
    var zeroLikeLimit = Math.max(1, warp.panoramaWidth * 0.8 / 360);
    var separationLimit = Math.max(1.75, warp.panoramaWidth * 1.75 / 360);
    result.dominantMatches = dominantCount;
    result.secondaryMatches = secondaryCount;
    result.separationPx = separation;
    result.dominantMagnitudePx = dominantMagnitude;
    result.secondaryMagnitudePx = secondaryMagnitude;
    result.competing = secondaryCount >= minimumSecondary &&
      separation >= separationLimit &&
      (dominantMagnitude <= zeroLikeLimit ||
        secondaryMagnitude <= zeroLikeLimit ||
        separation >= separationLimit * 1.4);
    return result;
  }

  function validateResidualWarpSupport(layer, warp) {
    var sample = [0, 0, 0, 0, 0];
    var displacement = [0, 0];
    var samples = 0;
    var invalid = 0;
    var i;
    for (i = 0; i < layer.weights.length; i += 1) {
      if (layer.weights[i] <= 0.001) continue;
      var x = i % layer.width;
      var y = Math.floor(i / layer.width);
      samples += 1;
      if (!sampleProjectedLayer(layer, warp, x, y, sample, displacement)) {
        invalid += 1;
        if (invalid > 0) break;
      }
    }
    return { safe: invalid === 0, samples: samples, invalid: invalid };
  }

  function solveResidualWarp(warp, matches, holdoutModulo, includeHoldout) {
    var nodeCount = matches.length;
    var weights = new Float32Array(nodeCount);
    var measuredDx = new Float32Array(nodeCount);
    var measuredDy = new Float32Array(nodeCount);
    var acceptedDx = [];
    var acceptedDy = [];
    var i;
    for (i = 0; i < nodeCount; i += 1) {
      if (!matches[i].accepted) continue;
      var acceptedGx = i % (warp.gridCols + 1);
      var acceptedGy = Math.floor(i / (warp.gridCols + 1));
      var acceptedIsHoldout =
        (acceptedGx + acceptedGy * 2 + warp.frameIndex) % holdoutModulo === 0;
      if (acceptedIsHoldout && !includeHoldout) continue;
      acceptedDx.push(matches[i].dx);
      acceptedDy.push(matches[i].dy);
    }
    var medianDx = median(acceptedDx);
    var medianDy = median(acceptedDy);
    var deviations = [];
    for (i = 0; i < nodeCount; i += 1) {
      if (!matches[i].accepted) continue;
      acceptedGx = i % (warp.gridCols + 1);
      acceptedGy = Math.floor(i / (warp.gridCols + 1));
      acceptedIsHoldout =
        (acceptedGx + acceptedGy * 2 + warp.frameIndex) % holdoutModulo === 0;
      if (acceptedIsHoldout && !includeHoldout) continue;
      deviations.push(Math.sqrt(
        Math.pow(matches[i].dx - medianDx, 2) +
        Math.pow(matches[i].dy - medianDy, 2)
      ));
    }
    var deviationLimit = Math.max(3, median(deviations) * 2.5);
    var trainingCount = 0;
    for (i = 0; i < nodeCount; i += 1) {
      var match = matches[i];
      if (!match.accepted) continue;
      var deviation = Math.sqrt(
        Math.pow(match.dx - medianDx, 2) +
        Math.pow(match.dy - medianDy, 2)
      );
      if (deviation > deviationLimit) continue;
      var gx = i % (warp.gridCols + 1);
      var gy = Math.floor(i / (warp.gridCols + 1));
      var isHoldout = (gx + gy * 2 + warp.frameIndex) % holdoutModulo === 0;
      if (isHoldout && !includeHoldout) continue;
      weights[i] = Math.max(0.08, match.confidence);
      measuredDx[i] = match.dx;
      measuredDy[i] = match.dy;
      trainingCount += 1;
    }
    var dx = new Float32Array(nodeCount);
    var dy = new Float32Array(nodeCount);
    var lambda = 0.32;
    var prior = 0.045;
    var columns = warp.gridCols + 1;
    var iteration;
    for (iteration = 0; iteration < 42; iteration += 1) {
      var reverse = iteration % 2 === 1;
      var start = reverse ? nodeCount - 1 : 0;
      var end = reverse ? -1 : nodeCount;
      var direction = reverse ? -1 : 1;
      for (i = start; i !== end; i += direction) {
        var nodeX = i % columns;
        var nodeY = Math.floor(i / columns);
        var sumX = weights[i] * measuredDx[i];
        var sumY = weights[i] * measuredDy[i];
        var denominator = weights[i] + prior;
        var neighbor;
        if (nodeX > 0) {
          neighbor = i - 1;
          sumX += dx[neighbor] * lambda;
          sumY += dy[neighbor] * lambda;
          denominator += lambda;
        }
        if (nodeX < warp.gridCols) {
          neighbor = i + 1;
          sumX += dx[neighbor] * lambda;
          sumY += dy[neighbor] * lambda;
          denominator += lambda;
        }
        if (nodeY > 0) {
          neighbor = i - columns;
          sumX += dx[neighbor] * lambda;
          sumY += dy[neighbor] * lambda;
          denominator += lambda;
        }
        if (nodeY < warp.gridRows) {
          neighbor = i + columns;
          sumX += dx[neighbor] * lambda;
          sumY += dy[neighbor] * lambda;
          denominator += lambda;
        }
        var solvedX = sumX / denominator;
        var solvedY = sumY / denominator;
        var solvedMagnitude = Math.sqrt(solvedX * solvedX + solvedY * solvedY);
        if (solvedMagnitude > warp.maxDisplacementPx) {
          var solvedScale = warp.maxDisplacementPx / solvedMagnitude;
          solvedX *= solvedScale;
          solvedY *= solvedScale;
        }
        dx[i] = solvedX;
        dy[i] = solvedY;
      }
    }
    return {
      dx: dx,
      dy: dy,
      weights: weights,
      trainingCount: trainingCount,
      deviationLimitPx: deviationLimit
    };
  }

  function residualWarpFieldHealth(warp) {
    var columns = warp.gridCols + 1;
    var cellWidth = Math.max(
      1e-6,
      (warp.maxLocalX - warp.minLocalX) / warp.gridCols
    );
    var cellHeight = Math.max(
      1e-6,
      (warp.maxY - warp.minY) / warp.gridRows
    );
    var maxMagnitude = 0;
    var maxNeighborDelta = 0;
    var minJacobian = Infinity;
    var maxJacobian = -Infinity;
    var i;
    for (i = 0; i < warp.dx.length; i += 1) {
      maxMagnitude = Math.max(
        maxMagnitude,
        Math.sqrt(warp.dx[i] * warp.dx[i] + warp.dy[i] * warp.dy[i])
      );
    }
    var gy, gx;
    for (gy = 0; gy < warp.gridRows; gy += 1) {
      for (gx = 0; gx < warp.gridCols; gx += 1) {
        var i00 = gy * columns + gx;
        var i10 = i00 + 1;
        var i01 = i00 + columns;
        var i11 = i01 + 1;
        var horizontalTop = Math.sqrt(
          Math.pow(warp.dx[i10] - warp.dx[i00], 2) +
          Math.pow(warp.dy[i10] - warp.dy[i00], 2)
        );
        var horizontalBottom = Math.sqrt(
          Math.pow(warp.dx[i11] - warp.dx[i01], 2) +
          Math.pow(warp.dy[i11] - warp.dy[i01], 2)
        );
        var verticalLeft = Math.sqrt(
          Math.pow(warp.dx[i01] - warp.dx[i00], 2) +
          Math.pow(warp.dy[i01] - warp.dy[i00], 2)
        );
        var verticalRight = Math.sqrt(
          Math.pow(warp.dx[i11] - warp.dx[i10], 2) +
          Math.pow(warp.dy[i11] - warp.dy[i10], 2)
        );
        maxNeighborDelta = Math.max(
          maxNeighborDelta,
          horizontalTop,
          horizontalBottom,
          verticalLeft,
          verticalRight
        );
        // For a bilinear inverse field q=p+d(p), derivatives reach their
        // extrema at cell corners. Check all four corner Jacobians so the
        // accepted map cannot fold or aggressively stretch a mobile frame.
        var corner;
        for (corner = 0; corner < 4; corner += 1) {
          var useBottom = corner >= 2;
          var useRight = corner % 2 === 1;
          var ddxDx = ((useBottom ? warp.dx[i11] - warp.dx[i01] :
            warp.dx[i10] - warp.dx[i00])) / cellWidth;
          var ddyDx = ((useBottom ? warp.dy[i11] - warp.dy[i01] :
            warp.dy[i10] - warp.dy[i00])) / cellWidth;
          var ddxDy = ((useRight ? warp.dx[i11] - warp.dx[i10] :
            warp.dx[i01] - warp.dx[i00])) / cellHeight;
          var ddyDy = ((useRight ? warp.dy[i11] - warp.dy[i10] :
            warp.dy[i01] - warp.dy[i00])) / cellHeight;
          var determinant =
            (1 + ddxDx) * (1 + ddyDy) - ddxDy * ddyDx;
          minJacobian = Math.min(minJacobian, determinant);
          maxJacobian = Math.max(maxJacobian, determinant);
        }
      }
    }
    return {
      maxMagnitudePx: maxMagnitude,
      maxNeighborDeltaPx: maxNeighborDelta,
      minJacobian: minJacobian,
      maxJacobian: maxJacobian,
      safe: minJacobian >= 0.55 && maxJacobian <= 1.8 &&
        maxNeighborDelta <= Math.max(3, Math.min(cellWidth, cellHeight) * 0.45)
    };
  }

  function percentile(values, q) {
    if (!values.length) return Infinity;
    values.sort(function (a, b) { return a - b; });
    return values[Math.min(
      values.length - 1,
      Math.floor((values.length - 1) * clamp(q, 0, 1))
    )];
  }

  function projectedColorDistance(oldSample, newSample) {
    var dr = oldSample[0] - newSample[0];
    var dg = oldSample[1] - newSample[1];
    var db = oldSample[2] - newSample[2];
    return Math.sqrt((dr * dr + dg * dg + db * db) / 3);
  }

  function residualWarpSeamEvidence(raster, layer, warp, sampleStep) {
    var before = [];
    var after = [];
    var oldSample = [0, 0, 0, 0, 0];
    var rawNew = [0, 0, 0, 0, 0];
    var warpedNew = [0, 0, 0, 0, 0];
    var displacement = [0, 0];
    var y, localX;
    for (y = warp.minY; y <= warp.maxY; y += sampleStep) {
      for (
        localX = warp.minLocalX;
        localX <= warp.maxLocalX;
        localX += sampleStep
      ) {
        var x = wrapPixelX(warp.centerX + localX, raster.width);
        if (!sampleProjectedContainer(raster, x, y, oldSample) ||
            !sampleProjectedContainer(layer, x, y, rawNew)) continue;
        var rawRatio = Math.log(
          (rawNew[4] + 1e-4) / (oldSample[4] + 1e-4)
        );
        if (!sampleProjectedLayer(
          layer,
          warp,
          x,
          y,
          warpedNew,
          displacement
        )) continue;
        var warpedRatio = Math.log(
          (warpedNew[4] + 1e-4) / (oldSample[4] + 1e-4)
        );
        // Measure the union of the old and the actually warped seam strip.
        // A field that merely moves its own priority boundary cannot hide a
        // worsening seam from this gate.
        if (Math.min(Math.abs(rawRatio), Math.abs(warpedRatio)) > 0.28) continue;
        before.push(projectedColorDistance(oldSample, rawNew));
        after.push(projectedColorDistance(oldSample, warpedNew));
      }
    }
    return {
      samples: before.length,
      beforeP90: percentile(before, 0.9),
      afterP90: percentile(after, 0.9)
    };
  }

  function estimateProjectedResidualWarp(raster, layer, options) {
    options = options || {};
    // Explicit opt-in: omitted options must remain byte-identical to the
    // pre-warp seam compositor. H5 and WeChat pass the same true/config tuple.
    var enabled = options.localWarp === true;
    var configuredGridCols = Math.max(
      4,
      Math.min(12, Number(options.warpGridCols) || 8)
    );
    var configuredGridRows = Math.max(
      3,
      Math.min(10, Number(options.warpGridRows) || 6)
    );
    var inactive = {
      active: false,
      attempted: false,
      applied: false,
      reason: enabled ? "INVALID_INPUT" : "DISABLED",
      dx: null,
      dy: null,
      acceptedMatches: 0,
      validationMatches: 0,
      validationImprovement: 0,
      holdoutBeforeMedian: null,
      holdoutAfterMedian: null,
      holdoutBeforeP75: null,
      holdoutAfterP75: null,
      seamSamples: 0,
      seamP90Before: null,
      seamP90After: null,
      maxDisplacement: 0,
      maxDisplacementPx: 0,
      grid: [configuredGridCols, configuredGridRows],
      coarseStep: 0,
      minJacobian: null,
      maxJacobian: null,
      dominantFlowMatches: 0,
      secondaryFlowMatches: 0,
      flowClusterSeparation: 0,
      flowMeanMagnitude: 0,
      flowSpreadP75: 0,
      flowMeanMagnitudeLimit: 0,
      supportSamples: 0,
      supportInvalid: 0,
      extraBytes: 0,
      extraBytesKind: "conservative_peak_estimate"
    };
    if (!enabled || !raster || !layer ||
        !raster.weights || !layer.weights) return inactive;
    inactive.attempted = true;
    var gridCols = configuredGridCols;
    var gridRows = configuredGridRows;
    var coarseStep = Math.max(
      2,
      Math.ceil(Math.max(raster.width / 384, raster.height / 192))
    );
    inactive.coarseStep = coarseStep;
    // First frame and tiny accidental overlaps should not pay for feature
    // search. This scan allocates nothing and exits as soon as enough support
    // is proven.
    var overlapSamples = 0;
    var overlapIndex;
    for (overlapIndex = 0; overlapIndex < layer.weights.length; overlapIndex += 1) {
      if (raster.weights[overlapIndex] > 0.05 &&
          layer.weights[overlapIndex] > 0.05) {
        overlapSamples += 1;
        if (overlapSamples >= 32) break;
      }
    }
    if (overlapSamples < 32) {
      inactive.reason = "INSUFFICIENT_OVERLAP";
      return inactive;
    }
    var footprint = findProjectedLayerFootprint(layer, coarseStep);
    if (!footprint) {
      inactive.reason = "NO_LAYER_FOOTPRINT";
      return inactive;
    }
    if (footprint.maxLocalX - footprint.minLocalX > raster.width * 0.45 ||
        footprint.minY < raster.height * 0.035 ||
        footprint.maxY > raster.height * 0.965) {
      inactive.reason = "UNSAFE_PROJECTION_REGION";
      return inactive;
    }
    var maxDisplacement = Math.max(
      3,
      Math.min(24, Math.round(raster.width * 5 / 360))
    );
    var warp = {
      active: false,
      attempted: true,
      applied: false,
      reason: "MATCHING",
      panoramaWidth: raster.width,
      panoramaHeight: raster.height,
      centerX: footprint.centerX,
      minLocalX: footprint.minLocalX,
      maxLocalX: footprint.maxLocalX,
      minY: footprint.minY,
      maxY: footprint.maxY,
      gridCols: gridCols,
      gridRows: gridRows,
      maxDisplacementPx: maxDisplacement,
      edgeTaperCells: Math.max(
        1,
        Math.min(2, Number(options.warpEdgeTaperCells) || 1.25)
      ),
      boundaryWeight: Math.max(
        0.05,
        Math.min(0.5, Number(options.warpBoundaryWeight) || 0.2)
      ),
      frameIndex: Math.max(0, Number(options.frameIndex) || 0),
      dx: null,
      dy: null,
      acceptedMatches: 0,
      validationMatches: 0,
      validationImprovement: 0,
      holdoutBeforeMedian: null,
      holdoutAfterMedian: null,
      holdoutBeforeP75: null,
      holdoutAfterP75: null,
      seamSamples: 0,
      seamP90Before: null,
      seamP90After: null,
      maxDisplacement: 0,
      grid: [gridCols, gridRows],
      coarseStep: coarseStep,
      minJacobian: null,
      maxJacobian: null,
      dominantFlowMatches: 0,
      secondaryFlowMatches: 0,
      flowClusterSeparation: 0,
      flowMeanMagnitude: 0,
      flowSpreadP75: 0,
      flowMeanMagnitudeLimit: 0,
      supportSamples: 0,
      supportInvalid: 0,
      extraBytes: 0,
      extraBytesKind: "conservative_peak_estimate"
    };
    var nodeCount = (gridCols + 1) * (gridRows + 1);
    // No panorama-sized scratch buffer exists. This is a deliberately
    // conservative upper estimate for node objects, typed solver arrays and
    // per-node matcher scratch that can coexist at peak.
    warp.extraBytes = nodeCount * 288 + 8192;
    var matches = new Array(nodeCount);
    var accepted = 0;
    var coveredColumns = new Uint8Array(gridCols + 1);
    var coveredRows = new Uint8Array(gridRows + 1);
    var index = 0;
    var gy, gx;
    for (gy = 0; gy <= gridRows; gy += 1) {
      var y = footprint.minY +
        (footprint.maxY - footprint.minY) * gy / gridRows;
      for (gx = 0; gx <= gridCols; gx += 1) {
        var localX = footprint.minLocalX +
          (footprint.maxLocalX - footprint.minLocalX) * gx / gridCols;
        var x = wrapPixelX(footprint.centerX + localX, raster.width);
        var match = searchProjectedMatch(
          raster,
          layer,
          x,
          y,
          coarseStep,
          maxDisplacement
        );
        match.x = x;
        match.y = y;
        match.gx = gx;
        match.gy = gy;
        matches[index] = match;
        if (match.accepted) {
          accepted += 1;
          coveredColumns[gx] = 1;
          coveredRows[gy] = 1;
        }
        index += 1;
      }
    }
    var columnCount = 0;
    var rowCount = 0;
    for (index = 0; index < coveredColumns.length; index += 1) {
      columnCount += coveredColumns[index];
    }
    for (index = 0; index < coveredRows.length; index += 1) {
      rowCount += coveredRows[index];
    }
    warp.acceptedMatches = accepted;
    if (accepted < 12 || columnCount < 4 || rowCount < 3) {
      warp.reason = "INSUFFICIENT_COHERENT_MATCHES";
      return warp;
    }

    var flowClusters = analyzeResidualFlowClusters(matches, warp);
    warp.dominantFlowMatches = flowClusters.dominantMatches;
    warp.secondaryFlowMatches = flowClusters.secondaryMatches;
    warp.flowClusterSeparation = flowClusters.separationPx;
    warp.flowMeanMagnitude = flowClusters.meanMagnitudePx;
    warp.flowSpreadP75 = flowClusters.spreadP75Px;
    // The upstream SO(3) pose graph owns the global/DC component. With only
    // two projected frames, a smooth residual translation is not observable
    // separately from a dominant moving foreground plane. Local mesh warping
    // is therefore limited to near-zero-mean differential deformation.
    warp.flowMeanMagnitudeLimit = Math.max(
      1.25,
      raster.width * 1.25 / 360
    );
    if (flowClusters.meanMagnitudePx > warp.flowMeanMagnitudeLimit) {
      warp.reason = "NON_ZERO_MEAN_RESIDUAL";
      return warp;
    }
    if (flowClusters.competing) {
      warp.reason = "COMPETING_RESIDUAL_FLOWS";
      return warp;
    }

    var holdoutModulo = 4;
    var training = solveResidualWarp(warp, matches, holdoutModulo, false);
    if (training.trainingCount < 8) {
      warp.reason = "INSUFFICIENT_TRAINING_MATCHES";
      return warp;
    }
    warp.dx = training.dx;
    warp.dy = training.dy;
    warp.active = true;
    var trainingHealth = residualWarpFieldHealth(warp);
    warp.maxDisplacement = trainingHealth.maxMagnitudePx;
    warp.minJacobian = trainingHealth.minJacobian;
    warp.maxJacobian = trainingHealth.maxJacobian;
    if (!trainingHealth.safe) {
      warp.active = false;
      warp.reason = "FIELD_FOLD_RISK";
      return warp;
    }
    // A near-constant large shift belongs in the upstream global pose model;
    // from a two-frame overlap it is not semantically distinguishable from a
    // dominant moving plane. The local mesh therefore rejects it by prior.
    var maxAppliedDisplacement = raster.width * Math.max(
      1,
      Math.min(4, Number(options.warpMaxAppliedDeg) || 3.5)
    ) / 360;
    if (trainingHealth.maxMagnitudePx > maxAppliedDisplacement) {
      warp.active = false;
      warp.reason = "EXCESSIVE_RESIDUAL_TRANSLATION";
      return warp;
    }
    var supportHealth = validateResidualWarpSupport(layer, warp);
    warp.supportSamples = supportHealth.samples;
    warp.supportInvalid = supportHealth.invalid;
    if (!supportHealth.safe) {
      warp.active = false;
      warp.reason = "WARPED_SUPPORT_INVALID";
      return warp;
    }
    var beforeResiduals = [];
    var afterResiduals = [];
    var displacement = [0, 0];
    var validationScratch = {
      oldSample: [0, 0, 0, 0, 0],
      newSample: [0, 0, 0, 0, 0]
    };
    for (index = 0; index < matches.length; index += 1) {
      match = matches[index];
      if (!match.accepted ||
          (match.gx + match.gy * 2 + warp.frameIndex) % holdoutModulo !== 0) {
        continue;
      }
      residualWarpAt(warp, match.x, match.y, displacement);
      var validation = projectedPatchScore(
        raster,
        layer,
        match.x,
        match.y,
        match.x + displacement[0],
        match.y + displacement[1],
        coarseStep,
        validationScratch
      );
      if (!isFinite(validation.score)) continue;
      beforeResiduals.push(Math.max(0, 1 - match.zeroScore));
      afterResiduals.push(Math.max(0, 1 - validation.score));
    }
    warp.validationMatches = beforeResiduals.length;
    var beforeMedian = percentile(beforeResiduals, 0.5);
    var afterMedian = percentile(afterResiduals, 0.5);
    warp.holdoutBeforeMedian = isFinite(beforeMedian) ? beforeMedian : null;
    warp.holdoutAfterMedian = isFinite(afterMedian) ? afterMedian : null;
    warp.validationImprovement = isFinite(beforeMedian) && beforeMedian > 1e-6 ?
      (beforeMedian - afterMedian) / beforeMedian : 0;
    var afterP75 = percentile(afterResiduals, 0.75);
    var beforeP75 = percentile(beforeResiduals, 0.75);
    warp.holdoutBeforeP75 = isFinite(beforeP75) ? beforeP75 : null;
    warp.holdoutAfterP75 = isFinite(afterP75) ? afterP75 : null;
    if (warp.validationMatches < 4 || warp.validationImprovement < 0.08 ||
        afterP75 > beforeP75 * 1.05) {
      warp.active = false;
      warp.reason = "HOLDOUT_DID_NOT_IMPROVE";
      return warp;
    }
    var seamEvidence = residualWarpSeamEvidence(
      raster,
      layer,
      warp,
      coarseStep
    );
    warp.seamSamples = seamEvidence.samples;
    warp.seamP90Before = seamEvidence.beforeP90;
    warp.seamP90After = seamEvidence.afterP90;
    warp.extraBytes += seamEvidence.samples * 32;
    var maximumSeamResidual = Math.max(
      24,
      Math.min(64, Number(options.warpMaxSeamP90) || 48)
    );
    if (seamEvidence.samples < 8) {
      warp.active = false;
      warp.reason = "INSUFFICIENT_SEAM_EVIDENCE";
      return warp;
    }
    if (seamEvidence.afterP90 > maximumSeamResidual) {
      warp.active = false;
      warp.reason = "SEAM_RESIDUAL_TOO_HIGH";
      return warp;
    }
    if (seamEvidence.beforeP90 <= 12 ?
        seamEvidence.afterP90 > Math.min(8, seamEvidence.beforeP90 * 0.95) :
        seamEvidence.afterP90 > seamEvidence.beforeP90 * 0.92) {
      warp.active = false;
      warp.reason = "SEAM_BAND_DID_NOT_IMPROVE";
      return warp;
    }

    // Keep the training-only field. Holdout nodes remain genuinely unseen by
    // the exact field that is applied and reported in diagnostics.
    warp.reason = "ACCEPTED";
    warp.applied = true;
    warp.extraBytes += warp.dx.byteLength + warp.dy.byteLength +
      coveredColumns.byteLength + coveredRows.byteLength;
    return warp;
  }

  function finiteDiagnostic(value) {
    return isFinite(value) ? value : null;
  }

  function residualWarpDiagnostics(warp) {
    warp = warp || {};
    return {
      attempted: !!warp.attempted,
      applied: !!warp.active && !!warp.applied,
      reason: warp.reason || "UNKNOWN",
      acceptedMatches: Number(warp.acceptedMatches) || 0,
      validationMatches: Number(warp.validationMatches) || 0,
      holdoutBefore: finiteDiagnostic(warp.holdoutBeforeMedian),
      holdoutAfter: finiteDiagnostic(warp.holdoutAfterMedian),
      holdoutP75Before: finiteDiagnostic(warp.holdoutBeforeP75),
      holdoutP75After: finiteDiagnostic(warp.holdoutAfterP75),
      holdoutImprovement: finiteDiagnostic(warp.validationImprovement) || 0,
      seamSamples: Number(warp.seamSamples) || 0,
      seamP90Before: finiteDiagnostic(warp.seamP90Before),
      seamP90After: finiteDiagnostic(warp.seamP90After),
      maxDisplacement: finiteDiagnostic(warp.maxDisplacement) || 0,
      maxDisplacementLimit: finiteDiagnostic(warp.maxDisplacementPx) || 0,
      minJacobian: finiteDiagnostic(warp.minJacobian),
      maxJacobian: finiteDiagnostic(warp.maxJacobian),
      dominantFlowMatches: Number(warp.dominantFlowMatches) || 0,
      secondaryFlowMatches: Number(warp.secondaryFlowMatches) || 0,
      flowClusterSeparation: finiteDiagnostic(warp.flowClusterSeparation) || 0,
      flowMeanMagnitude: finiteDiagnostic(warp.flowMeanMagnitude) || 0,
      flowSpreadP75: finiteDiagnostic(warp.flowSpreadP75) || 0,
      flowMeanMagnitudeLimit:
        finiteDiagnostic(warp.flowMeanMagnitudeLimit) || 0,
      supportSamples: Number(warp.supportSamples) || 0,
      supportInvalid: Number(warp.supportInvalid) || 0,
      holdoutField: "training-only",
      grid: warp.grid && warp.grid.length === 2 ?
        [warp.grid[0], warp.grid[1]] : [0, 0],
      coarseStep: Number(warp.coarseStep) || 0,
      extraBytes: Math.max(0, Number(warp.extraBytes) || 0),
      extraBytesKind: warp.extraBytesKind || "conservative_peak_estimate"
    };
  }

  /*
   * 在低分辨率网格上为“已有合成结果”和“当前新帧”求一个二值来源标签。
   *
   * 初值是离各自照片中心更近的 Voronoi 分区；随后用少量 ICM 扫描把边界
   * 推向两张照片颜色更接近的位置。它不是完整 GraphCut，但保持了成熟全景
   * 管线最重要的契约：高冲突像素只选一个来源，不再把整个 overlap 平均。
   */
  function planSeamLabels(raster, layer, options, warp) {
    options = options || {};
    var maxGridWidth = Math.max(64, Number(options.seamGridWidth) || 320);
    var maxGridHeight = Math.max(32, Number(options.seamGridHeight) || 180);
    var step = Math.max(
      1,
      Math.ceil(Math.max(raster.width / maxGridWidth, raster.height / maxGridHeight))
    );
    var gridWidth = Math.ceil(raster.width / step);
    var gridHeight = Math.ceil(raster.height / step);
    var length = gridWidth * gridHeight;
    var labels = new Uint8Array(length);
    var valid = new Uint8Array(length);
    var mutable = new Uint8Array(length);
    var differences = new Float32Array(length);
    var oldPriority = new Float32Array(length);
    var newPriority = new Float32Array(length);
    var conflictMask = new Uint8Array(length);
    var hysteresis = options.seamHysteresis == null ?
      0.08 : Math.max(0, Number(options.seamHysteresis));
    var protectConflictThreshold = options.seamProtectConflictThreshold == null ?
      36 : Math.max(0, Number(options.seamProtectConflictThreshold));
    var sampledNew = [0, 0, 0, 0, 0];
    var sampledDisplacement = [0, 0];
    var gx, gy;
    for (gy = 0; gy < gridHeight; gy += 1) {
      var y = Math.min(raster.height - 1, gy * step + Math.floor(step / 2));
      for (gx = 0; gx < gridWidth; gx += 1) {
        var x = Math.min(raster.width - 1, gx * step + Math.floor(step / 2));
        var gridIndex = gy * gridWidth + gx;
        var pixelIndex = y * raster.width + x;
        var hasOld = raster.weights[pixelIndex] > 0.001;
        var hasNew = layer.weights[pixelIndex] > 0.001;
        var hasWarpedNew = false;
        if (hasNew && warp && warp.active) {
          hasWarpedNew = sampleProjectedLayer(
            layer,
            warp,
            x,
            y,
            sampledNew,
            sampledDisplacement
          );
          hasNew = hasWarpedNew;
        }
        if (!hasOld && !hasNew) continue;
        valid[gridIndex] = 1;
        oldPriority[gridIndex] = hasOld ? raster.priorities[pixelIndex] : 0;
        newPriority[gridIndex] = hasNew ?
          (hasWarpedNew ? sampledNew[4] : layer.priorities[pixelIndex]) : 0;
        if (!hasOld) {
          labels[gridIndex] = 1;
        } else if (!hasNew) {
          labels[gridIndex] = 0;
        } else {
          mutable[gridIndex] = 1;
          if (hasWarpedNew) {
            var oldOffset = pixelIndex * 4;
            var dr = raster.pixels[oldOffset] - sampledNew[0];
            var dg = raster.pixels[oldOffset + 1] - sampledNew[1];
            var db = raster.pixels[oldOffset + 2] - sampledNew[2];
            differences[gridIndex] = Math.sqrt(
              (dr * dr + dg * dg + db * db) / 3
            );
          } else {
            differences[gridIndex] = colorDistance(
              raster.pixels,
              layer.pixels,
              pixelIndex
            );
          }
          if (differences[gridIndex] >= protectConflictThreshold) {
            conflictMask[gridIndex] = 1;
          }
          labels[gridIndex] = newPriority[gridIndex] >
            oldPriority[gridIndex] * (1 + hysteresis) ? 1 : 0;
        }
      }
    }

    var unaryWeight = options.seamCenterWeight == null ?
      1.35 : Math.max(0, Number(options.seamCenterWeight));
    var smoothBase = options.seamSmoothBase == null ?
      0.025 : Math.max(0, Number(options.seamSmoothBase));
    var conflictWeight = options.seamConflictWeight == null ?
      1.4 : Math.max(0, Number(options.seamConflictWeight));
    var iterations = Math.max(0, Math.min(8, Number(options.seamIterations) || 4));

    function labelEnergy(index, label) {
      var delta = newPriority[index] - oldPriority[index];
      var energy = label === 1 ?
        Math.max(0, -delta) * unaryWeight :
        Math.max(0, delta) * unaryWeight;
      var x = index % gridWidth;
      var y = Math.floor(index / gridWidth);
      var neighbors = [
        x > 0 ? index - 1 : index + gridWidth - 1,
        x + 1 < gridWidth ? index + 1 : index - gridWidth + 1,
        y > 0 ? index - gridWidth : -1,
        y + 1 < gridHeight ? index + gridWidth : -1
      ];
      var n;
      for (n = 0; n < neighbors.length; n += 1) {
        var neighbor = neighbors[n];
        if (neighbor < 0 || !valid[neighbor] || labels[neighbor] === label) continue;
        var conflict = (differences[index] + differences[neighbor]) / (2 * 255);
        energy += smoothBase + conflict * conflictWeight;
      }
      return energy;
    }

    var iteration;
    for (iteration = 0; iteration < iterations; iteration += 1) {
      var reverse = iteration % 2 === 1;
      var start = reverse ? length - 1 : 0;
      var end = reverse ? -1 : length;
      var direction = reverse ? -1 : 1;
      var index;
      for (index = start; index !== end; index += direction) {
        if (!mutable[index]) continue;
        var oldEnergy = labelEnergy(index, 0);
        var newEnergy = labelEnergy(index, 1);
        if (newEnergy + 1e-6 < oldEnergy) labels[index] = 1;
        else if (oldEnergy + 1e-6 < newEnergy) labels[index] = 0;
      }
    }

    /*
     * A seam can still erase a displaced foreground object when it runs
     * through the quiet gap between that object's two parallax copies:
     * background from the opposite frame wins at both copies. Protect a
     * narrow, dilated conflict island and give the whole island one owner.
     *
     * This is deliberately bounded. Large/highly textured overlap regions
     * keep the ordinary ICM labels instead of collapsing to one frame.
     */
    var protectRadius = Math.max(
      0,
      Math.min(4, Number(options.seamProtectRadius) || 2)
    );
    var protectedMask = new Uint8Array(length);
    var conflictIndex;
    for (conflictIndex = 0; conflictIndex < length; conflictIndex += 1) {
      if (!conflictMask[conflictIndex]) continue;
      var conflictX = conflictIndex % gridWidth;
      var conflictY = Math.floor(conflictIndex / gridWidth);
      var minProtectY = Math.max(0, conflictY - protectRadius);
      var maxProtectY = Math.min(gridHeight - 1, conflictY + protectRadius);
      var protectY;
      for (protectY = minProtectY; protectY <= maxProtectY; protectY += 1) {
        var verticalDistance = Math.abs(protectY - conflictY);
        var horizontalRadius = protectRadius - verticalDistance;
        var minProtectX = Math.max(0, conflictX - horizontalRadius);
        var maxProtectX = Math.min(gridWidth - 1, conflictX + horizontalRadius);
        var protectX;
        for (protectX = minProtectX; protectX <= maxProtectX; protectX += 1) {
          var protectIndex = protectY * gridWidth + protectX;
          if (mutable[protectIndex]) protectedMask[protectIndex] = 1;
        }
      }
    }

    var mutableCount = 0;
    var countIndex;
    for (countIndex = 0; countIndex < length; countIndex += 1) {
      if (mutable[countIndex]) mutableCount += 1;
    }
    var maxProtectedFraction = options.seamProtectMaxFraction == null ?
      0.35 : clamp(Number(options.seamProtectMaxFraction), 0, 1);
    var maxProtectedCells = Math.max(
      1,
      Math.floor(mutableCount * maxProtectedFraction)
    );
    var visitedProtected = new Uint8Array(length);
    var protectedQueue = new Int32Array(length);
    var protectedComponents = 0;
    var protectedCells = 0;
    var componentStart;
    for (componentStart = 0; componentStart < length; componentStart += 1) {
      if (!protectedMask[componentStart] || visitedProtected[componentStart]) {
        continue;
      }
      var queueHead = 0;
      var queueTail = 1;
      protectedQueue[0] = componentStart;
      visitedProtected[componentStart] = 1;
      var componentOldCost = 0;
      var componentNewCost = 0;
      var componentOldLabels = 0;
      var componentNewLabels = 0;
      while (queueHead < queueTail) {
        var componentIndex = protectedQueue[queueHead];
        queueHead += 1;
        var componentDelta =
          newPriority[componentIndex] - oldPriority[componentIndex];
        componentOldCost += Math.max(0, componentDelta) * unaryWeight;
        componentNewCost += Math.max(0, -componentDelta) * unaryWeight;
        if (labels[componentIndex] === 1) componentNewLabels += 1;
        else componentOldLabels += 1;
        var componentX = componentIndex % gridWidth;
        var componentY = Math.floor(componentIndex / gridWidth);
        var componentNeighbors = [
          componentX > 0 ? componentIndex - 1 : componentIndex + gridWidth - 1,
          componentX + 1 < gridWidth ?
            componentIndex + 1 : componentIndex - gridWidth + 1,
          componentY > 0 ? componentIndex - gridWidth : -1,
          componentY + 1 < gridHeight ? componentIndex + gridWidth : -1
        ];
        var componentNeighborIndex;
        for (
          componentNeighborIndex = 0;
          componentNeighborIndex < componentNeighbors.length;
          componentNeighborIndex += 1
        ) {
          var componentNeighbor = componentNeighbors[componentNeighborIndex];
          if (componentNeighbor < 0 ||
              !protectedMask[componentNeighbor] ||
              visitedProtected[componentNeighbor]) {
            continue;
          }
          visitedProtected[componentNeighbor] = 1;
          protectedQueue[queueTail] = componentNeighbor;
          queueTail += 1;
        }
      }
      if (queueTail > maxProtectedCells ||
          componentOldLabels === 0 ||
          componentNewLabels === 0) {
        continue;
      }
      var protectedLabel;
      if (componentNewCost + 1e-6 < componentOldCost) {
        protectedLabel = 1;
      } else if (componentOldCost + 1e-6 < componentNewCost) {
        protectedLabel = 0;
      } else {
        protectedLabel = componentNewLabels > componentOldLabels ? 1 : 0;
      }
      var protectedQueueIndex;
      for (
        protectedQueueIndex = 0;
        protectedQueueIndex < queueTail;
        protectedQueueIndex += 1
      ) {
        labels[protectedQueue[protectedQueueIndex]] = protectedLabel;
      }
      protectedComponents += 1;
      protectedCells += queueTail;
    }

    /*
     * A moving foreground can create two separate conflict islands: the old
     * silhouette lies on the old frame's side of the centre-priority seam and
     * the new silhouette lies on the new side.  Each island is internally
     * "pure", so the protection above cannot see that retaining both produces
     * a duplicated person.
     *
     * Pair only small, vertically-overlapping, opposite-owner islands within
     * a bounded horizontal motion envelope.  The envelope then takes one
     * source label, removing one temporal copy without allocating a full-size
     * motion mask or optical-flow field.  Large texture/parallax regions stay
     * untouched and are reported as unresolved rather than globally warped.
     */
    var motionBridgeMaxCells = options.seamMotionBridgeMaxCells == null ?
      28 : Math.max(
        0,
        Math.min(32, Number(options.seamMotionBridgeMaxCells) || 0)
      );
    var motionMinimumCells = Math.max(
      2,
      Math.min(24, Number(options.seamMotionMinimumCells) || 4)
    );
    var motionMinimumHeightCells = Math.max(
      2,
      Math.min(32, Number(options.seamMotionMinimumHeightCells) || 8)
    );
    var motionMinimumComponentHeightFraction =
      options.seamMotionMinimumComponentHeightFraction == null ?
        0.185 : clamp(
          Number(options.seamMotionMinimumComponentHeightFraction),
          0,
          0.4
        );
    var motionMinimumComponentHeightCells = Math.max(
      motionMinimumHeightCells,
      Math.ceil(gridHeight * motionMinimumComponentHeightFraction)
    );
    var motionMinimumVerticalOverlap = options.seamMotionMinimumVerticalOverlap == null ?
      0.42 : clamp(Number(options.seamMotionMinimumVerticalOverlap), 0, 1);
    var motionMinimumPurity = options.seamMotionMinimumPurity == null ?
      0.84 : clamp(Number(options.seamMotionMinimumPurity), 0.5, 1);
    var motionMaximumHeightFraction = options.seamMotionMaximumHeightFraction == null ?
      0.55 : clamp(Number(options.seamMotionMaximumHeightFraction), 0.05, 1);
    var motionMaximumFraction = options.seamMotionMaximumFraction == null ?
      0.55 : clamp(Number(options.seamMotionMaximumFraction), 0.05, 0.8);
    var motionComponentLimit = Math.max(
      8,
      Math.min(192, Number(options.seamMotionComponentLimit) || 96)
    );
    var motionMaximumCells = Math.max(
      1,
      Math.floor(mutableCount * motionMaximumFraction)
    );
    var motionCoreMinimumNeighbors = options.seamMotionCoreMinimumNeighbors == null ?
      5 : Math.max(
        1,
        Math.min(9, Number(options.seamMotionCoreMinimumNeighbors) || 5)
      );
    /*
     * Small accepted pose corrections turn high-contrast panorama grid lines
     * into thin conflict components. They can connect to a moving subject and
     * make the raw component frame-wide. Reuse the no-longer-needed protected
     * mask as a dense 3x3 conflict core: thin lines disappear, while solid
     * subject-vs-background lobes remain available to temporal ownership.
     */
    var motionConflictMask = protectedMask;
    motionConflictMask.fill(0);
    var motionCoreCells = 0;
    var motionCoreIndex;
    for (
      motionCoreIndex = 0;
      motionCoreIndex < length;
      motionCoreIndex += 1
    ) {
      if (!conflictMask[motionCoreIndex] || !mutable[motionCoreIndex]) continue;
      var motionCoreX = motionCoreIndex % gridWidth;
      var motionCoreY = Math.floor(motionCoreIndex / gridWidth);
      var motionNeighborCount = 0;
      var motionNeighborY;
      for (
        motionNeighborY = Math.max(0, motionCoreY - 1);
        motionNeighborY <= Math.min(gridHeight - 1, motionCoreY + 1);
        motionNeighborY += 1
      ) {
        var motionNeighborX;
        for (
          motionNeighborX = Math.max(0, motionCoreX - 1);
          motionNeighborX <= Math.min(gridWidth - 1, motionCoreX + 1);
          motionNeighborX += 1
        ) {
          if (conflictMask[motionNeighborY * gridWidth + motionNeighborX]) {
            motionNeighborCount += 1;
          }
        }
      }
      if (motionNeighborCount >= motionCoreMinimumNeighbors) {
        motionConflictMask[motionCoreIndex] = 1;
        motionCoreCells += 1;
      }
    }
    var motionComponents = [];
    var motionBridges = 0;
    var motionBridgeCells = 0;
    var motionBridgeDiagnostics = [];
    var motionVisited = visitedProtected;
    motionVisited.fill(0);

    for (componentStart = 0; componentStart < length; componentStart += 1) {
      if (!motionConflictMask[componentStart] ||
          motionVisited[componentStart]) {
        continue;
      }
      var motionHead = 0;
      var motionTail = 1;
      var motionOldLabels = 0;
      var motionNewLabels = 0;
      var motionMinX = gridWidth;
      var motionMaxX = -1;
      var motionMinY = gridHeight;
      var motionMaxY = -1;
      protectedQueue[0] = componentStart;
      motionVisited[componentStart] = 1;
      while (motionHead < motionTail) {
        var motionIndex = protectedQueue[motionHead];
        motionHead += 1;
        var motionX = motionIndex % gridWidth;
        var motionY = Math.floor(motionIndex / gridWidth);
        motionMinX = Math.min(motionMinX, motionX);
        motionMaxX = Math.max(motionMaxX, motionX);
        motionMinY = Math.min(motionMinY, motionY);
        motionMaxY = Math.max(motionMaxY, motionY);
        if (labels[motionIndex] === 1) motionNewLabels += 1;
        else motionOldLabels += 1;
        var motionNeighbors = [
          motionX > 0 ? motionIndex - 1 : motionIndex + gridWidth - 1,
          motionX + 1 < gridWidth ?
            motionIndex + 1 : motionIndex - gridWidth + 1,
          motionY > 0 ? motionIndex - gridWidth : -1,
          motionY + 1 < gridHeight ? motionIndex + gridWidth : -1
        ];
        var motionNeighborOffset;
        for (
          motionNeighborOffset = 0;
          motionNeighborOffset < motionNeighbors.length;
          motionNeighborOffset += 1
        ) {
          var motionNeighbor = motionNeighbors[motionNeighborOffset];
          if (motionNeighbor < 0 ||
              motionVisited[motionNeighbor] ||
              !motionConflictMask[motionNeighbor]) {
            continue;
          }
          motionVisited[motionNeighbor] = 1;
          protectedQueue[motionTail] = motionNeighbor;
          motionTail += 1;
        }
      }
      if (motionTail < motionMinimumCells) continue;
      var motionDominantCount = Math.max(motionOldLabels, motionNewLabels);
      var motionPurity = motionDominantCount / Math.max(1, motionTail);
      if (motionComponents.length < motionComponentLimit) {
        motionComponents.push({
          minX: motionMinX,
          maxX: motionMaxX,
          minY: motionMinY,
          maxY: motionMaxY,
          cells: motionTail,
          label: motionPurity >= motionMinimumPurity ?
            (motionNewLabels > motionOldLabels ? 1 : 0) : -1,
          oldLabels: motionOldLabels,
          newLabels: motionNewLabels,
          used: false
        });
      }
    }

    /*
     * When the two silhouettes overlap slightly, their conflict lobes form
     * one mixed-label component instead of a pair.  Handle that equivalent
     * topology first, still under the same bounded envelope.
     */
    var mixedMotionIndex;
    for (
      mixedMotionIndex = 0;
      mixedMotionIndex < motionComponents.length;
      mixedMotionIndex += 1
    ) {
      var mixedMotion = motionComponents[mixedMotionIndex];
      if (mixedMotion.label !== -1) continue;
      var mixedWidth = mixedMotion.maxX - mixedMotion.minX + 1;
      var mixedHeight = mixedMotion.maxY - mixedMotion.minY + 1;
      var mixedMinLabelCount = Math.min(
        mixedMotion.oldLabels,
        mixedMotion.newLabels
      );
      if (mixedWidth > motionBridgeMaxCells ||
          mixedHeight < motionMinimumComponentHeightCells ||
          mixedHeight > gridHeight * motionMaximumHeightFraction ||
          mixedMotion.cells > motionMaximumCells ||
          mixedMinLabelCount / Math.max(1, mixedMotion.cells) <
            1 - motionMinimumPurity) {
        continue;
      }
      var mixedMinX = Math.max(0, mixedMotion.minX - 1);
      var mixedMaxX = Math.min(gridWidth - 1, mixedMotion.maxX + 1);
      var mixedMinY = Math.max(0, mixedMotion.minY - 1);
      var mixedMaxY = Math.min(gridHeight - 1, mixedMotion.maxY + 1);
      var mixedOldCost = 0;
      var mixedNewCost = 0;
      var mixedMutableCells = 0;
      var mixedY;
      for (mixedY = mixedMinY; mixedY <= mixedMaxY; mixedY += 1) {
        var mixedX;
        for (mixedX = mixedMinX; mixedX <= mixedMaxX; mixedX += 1) {
          var mixedIndex = mixedY * gridWidth + mixedX;
          if (!mutable[mixedIndex]) continue;
          var mixedDelta =
            newPriority[mixedIndex] - oldPriority[mixedIndex];
          mixedOldCost += Math.max(0, mixedDelta) * unaryWeight;
          mixedNewCost += Math.max(0, -mixedDelta) * unaryWeight;
          mixedMutableCells += 1;
        }
      }
      if (!mixedMutableCells ||
          mixedMutableCells > motionMaximumCells) {
        continue;
      }
      var mixedLabel = mixedNewCost + 1e-6 < mixedOldCost ? 1 : 0;
      for (mixedY = mixedMinY; mixedY <= mixedMaxY; mixedY += 1) {
        for (mixedX = mixedMinX; mixedX <= mixedMaxX; mixedX += 1) {
          mixedIndex = mixedY * gridWidth + mixedX;
          if (mutable[mixedIndex]) labels[mixedIndex] = mixedLabel;
        }
      }
      mixedMotion.used = true;
      motionBridges += 1;
      motionBridgeCells += mixedMutableCells;
      if (motionBridgeDiagnostics.length < 12) {
        motionBridgeDiagnostics.push({
          type: "mixed-component",
          bounds: [mixedMinX, mixedMinY, mixedMaxX, mixedMaxY],
          cells: mixedMutableCells
        });
      }
    }

    var motionAIndex;
    for (
      motionAIndex = 0;
      motionAIndex < motionComponents.length;
      motionAIndex += 1
    ) {
      var motionA = motionComponents[motionAIndex];
      if (motionA.used) continue;
      var bestMotionB = null;
      var bestMotionBIndex = -1;
      var bestMotionDistance = Infinity;
      var motionBIndex;
      for (
        motionBIndex = motionAIndex + 1;
        motionBIndex < motionComponents.length;
        motionBIndex += 1
      ) {
        var motionB = motionComponents[motionBIndex];
        if (motionB.used || motionB.label === motionA.label) continue;
        var motionBoxMinX = Math.min(motionA.minX, motionB.minX);
        var motionBoxMaxX = Math.max(motionA.maxX, motionB.maxX);
        var motionBoxMinY = Math.min(motionA.minY, motionB.minY);
        var motionBoxMaxY = Math.max(motionA.maxY, motionB.maxY);
        var motionBoxWidth = motionBoxMaxX - motionBoxMinX + 1;
        var motionBoxHeight = motionBoxMaxY - motionBoxMinY + 1;
        var motionAHeight = motionA.maxY - motionA.minY + 1;
        var motionBHeight = motionB.maxY - motionB.minY + 1;
        if (motionBoxWidth > motionBridgeMaxCells ||
            motionBoxHeight < motionMinimumHeightCells ||
            motionAHeight < motionMinimumComponentHeightCells ||
            motionBHeight < motionMinimumComponentHeightCells ||
            motionBoxHeight > gridHeight * motionMaximumHeightFraction ||
            motionBoxWidth * motionBoxHeight > motionMaximumCells) {
          continue;
        }
        var motionVerticalOverlap = Math.max(
          0,
          Math.min(motionA.maxY, motionB.maxY) -
            Math.max(motionA.minY, motionB.minY) + 1
        );
        var motionMinHeight = Math.min(
          motionA.maxY - motionA.minY + 1,
          motionB.maxY - motionB.minY + 1
        );
        if (
          motionVerticalOverlap /
            Math.max(1, motionMinHeight) <
          motionMinimumVerticalOverlap
        ) {
          continue;
        }
        var motionCentreDistance = Math.abs(
          (motionA.minX + motionA.maxX) / 2 -
            (motionB.minX + motionB.maxX) / 2
        );
        if (motionCentreDistance < bestMotionDistance) {
          bestMotionDistance = motionCentreDistance;
          bestMotionB = motionB;
          bestMotionBIndex = motionBIndex;
        }
      }
      if (!bestMotionB) continue;

      var bridgeMinX = Math.max(
        0,
        Math.min(motionA.minX, bestMotionB.minX) - 1
      );
      var bridgeMaxX = Math.min(
        gridWidth - 1,
        Math.max(motionA.maxX, bestMotionB.maxX) + 1
      );
      var bridgeMinY = Math.max(
        0,
        Math.min(motionA.minY, bestMotionB.minY) - 1
      );
      var bridgeMaxY = Math.min(
        gridHeight - 1,
        Math.max(motionA.maxY, bestMotionB.maxY) + 1
      );
      var bridgeOldCost = 0;
      var bridgeNewCost = 0;
      var bridgeMutableCells = 0;
      var bridgeY;
      for (bridgeY = bridgeMinY; bridgeY <= bridgeMaxY; bridgeY += 1) {
        var bridgeX;
        for (bridgeX = bridgeMinX; bridgeX <= bridgeMaxX; bridgeX += 1) {
          var bridgeIndex = bridgeY * gridWidth + bridgeX;
          if (!mutable[bridgeIndex]) continue;
          var bridgeDelta =
            newPriority[bridgeIndex] - oldPriority[bridgeIndex];
          bridgeOldCost += Math.max(0, bridgeDelta) * unaryWeight;
          bridgeNewCost += Math.max(0, -bridgeDelta) * unaryWeight;
          bridgeMutableCells += 1;
        }
      }
      if (!bridgeMutableCells ||
          bridgeMutableCells > motionMaximumCells) {
        continue;
      }
      var bridgeLabel = bridgeNewCost + 1e-6 < bridgeOldCost ? 1 : 0;
      for (bridgeY = bridgeMinY; bridgeY <= bridgeMaxY; bridgeY += 1) {
        for (bridgeX = bridgeMinX; bridgeX <= bridgeMaxX; bridgeX += 1) {
          bridgeIndex = bridgeY * gridWidth + bridgeX;
          if (mutable[bridgeIndex]) labels[bridgeIndex] = bridgeLabel;
        }
      }
      motionA.used = true;
      motionComponents[bestMotionBIndex].used = true;
      motionBridges += 1;
      motionBridgeCells += bridgeMutableCells;
      if (motionBridgeDiagnostics.length < 12) {
        motionBridgeDiagnostics.push({
          type: "component-pair",
          bounds: [bridgeMinX, bridgeMinY, bridgeMaxX, bridgeMaxY],
          componentBounds: [
            [motionA.minX, motionA.minY, motionA.maxX, motionA.maxY],
            [
              bestMotionB.minX,
              bestMotionB.minY,
              bestMotionB.maxX,
              bestMotionB.maxY
            ]
          ],
          cells: bridgeMutableCells
        });
      }
    }

    /*
     * A small accepted pose correction can split one moving silhouette into
     * several conflict components. Greedily pairing the closest two protects
     * only one limb/edge and leaves the two full temporal copies visible.
     *
     * Consolidate the bounded component graph once more: nearby components
     * with vertically overlapping (or nearly touching) spans form one motion
     * envelope, then the whole envelope gets a single source owner. The final
     * width/height/cell caps are identical to the conservative checks above,
     * so a chain cannot grow into a frame-wide overwrite.
     */
    var motionComponentCount = motionComponents.length;
    var motionParents = new Int16Array(motionComponentCount);
    var motionParentIndex;
    for (
      motionParentIndex = 0;
      motionParentIndex < motionComponentCount;
      motionParentIndex += 1
    ) {
      motionParents[motionParentIndex] = motionParentIndex;
    }
    function findMotionParent(index) {
      var parent = index;
      while (motionParents[parent] !== parent) {
        parent = motionParents[parent];
      }
      while (motionParents[index] !== index) {
        var next = motionParents[index];
        motionParents[index] = parent;
        index = next;
      }
      return parent;
    }
    function unionMotionParents(a, b) {
      var rootA = findMotionParent(a);
      var rootB = findMotionParent(b);
      if (rootA !== rootB) motionParents[rootB] = rootA;
    }
    var motionPairA;
    for (
      motionPairA = 0;
      motionPairA < motionComponentCount;
      motionPairA += 1
    ) {
      var graphA = motionComponents[motionPairA];
      var motionPairB;
      for (
        motionPairB = motionPairA + 1;
        motionPairB < motionComponentCount;
        motionPairB += 1
      ) {
        var graphB = motionComponents[motionPairB];
        var graphMinX = Math.min(graphA.minX, graphB.minX);
        var graphMaxX = Math.max(graphA.maxX, graphB.maxX);
        var graphMinY = Math.min(graphA.minY, graphB.minY);
        var graphMaxY = Math.max(graphA.maxY, graphB.maxY);
        if (graphMaxX - graphMinX + 1 > motionBridgeMaxCells ||
            graphMaxY - graphMinY + 1 >
              gridHeight * motionMaximumHeightFraction) {
          continue;
        }
        var graphVerticalOverlap = Math.max(
          0,
          Math.min(graphA.maxY, graphB.maxY) -
            Math.max(graphA.minY, graphB.minY) + 1
        );
        var graphMinimumHeight = Math.min(
          graphA.maxY - graphA.minY + 1,
          graphB.maxY - graphB.minY + 1
        );
        var graphVerticalGap = Math.max(
          0,
          Math.max(graphA.minY, graphB.minY) -
            Math.min(graphA.maxY, graphB.maxY) - 1
        );
        var graphHorizontalGap = Math.max(
          0,
          Math.max(graphA.minX, graphB.minX) -
            Math.min(graphA.maxX, graphB.maxX) - 1
        );
        if (graphHorizontalGap > 12 ||
            (graphVerticalOverlap / Math.max(1, graphMinimumHeight) < 0.25 &&
             graphVerticalGap > 2)) {
          continue;
        }
        unionMotionParents(motionPairA, motionPairB);
      }
    }

    var motionGroups = {};
    var motionGroupIndex;
    for (
      motionGroupIndex = 0;
      motionGroupIndex < motionComponentCount;
      motionGroupIndex += 1
    ) {
      var motionRoot = findMotionParent(motionGroupIndex);
      var motionGroupKey = String(motionRoot);
      var motionGroup = motionGroups[motionGroupKey];
      var groupComponent = motionComponents[motionGroupIndex];
      if (!motionGroup) {
        motionGroup = {
          count: 0,
          minX: gridWidth,
          maxX: -1,
          minY: gridHeight,
          maxY: -1,
          cells: 0,
          oldLabels: 0,
          newLabels: 0,
          tallComponents: 0
        };
        motionGroups[motionGroupKey] = motionGroup;
      }
      motionGroup.count += 1;
      motionGroup.minX = Math.min(motionGroup.minX, groupComponent.minX);
      motionGroup.maxX = Math.max(motionGroup.maxX, groupComponent.maxX);
      motionGroup.minY = Math.min(motionGroup.minY, groupComponent.minY);
      motionGroup.maxY = Math.max(motionGroup.maxY, groupComponent.maxY);
      motionGroup.cells += groupComponent.cells;
      motionGroup.oldLabels += groupComponent.oldLabels;
      motionGroup.newLabels += groupComponent.newLabels;
      if (groupComponent.maxY - groupComponent.minY + 1 >=
          motionMinimumComponentHeightCells) {
        motionGroup.tallComponents += 1;
      }
    }

    var motionGroupName;
    for (motionGroupName in motionGroups) {
      if (!Object.prototype.hasOwnProperty.call(motionGroups, motionGroupName)) {
        continue;
      }
      motionGroup = motionGroups[motionGroupName];
      if (motionGroup.count < 2) continue;
      var groupWidth = motionGroup.maxX - motionGroup.minX + 1;
      var groupHeight = motionGroup.maxY - motionGroup.minY + 1;
      var groupMinorityLabels = Math.min(
        motionGroup.oldLabels,
        motionGroup.newLabels
      );
      if (groupWidth > motionBridgeMaxCells ||
          groupHeight < motionMinimumHeightCells ||
          motionGroup.tallComponents < 2 ||
          groupHeight > gridHeight * motionMaximumHeightFraction ||
          motionGroup.cells > motionMaximumCells ||
          groupMinorityLabels / Math.max(1, motionGroup.cells) < 0.08) {
        continue;
      }
      var groupMinX = Math.max(0, motionGroup.minX - 1);
      var groupMaxX = Math.min(gridWidth - 1, motionGroup.maxX + 1);
      var groupMinY = Math.max(0, motionGroup.minY - 1);
      var groupMaxY = Math.min(gridHeight - 1, motionGroup.maxY + 1);
      var groupOldCost = 0;
      var groupNewCost = 0;
      var groupMutableCells = 0;
      var groupY;
      for (groupY = groupMinY; groupY <= groupMaxY; groupY += 1) {
        var groupX;
        for (groupX = groupMinX; groupX <= groupMaxX; groupX += 1) {
          var groupIndex = groupY * gridWidth + groupX;
          if (!mutable[groupIndex]) continue;
          var groupDelta =
            newPriority[groupIndex] - oldPriority[groupIndex];
          groupOldCost += Math.max(0, groupDelta) * unaryWeight;
          groupNewCost += Math.max(0, -groupDelta) * unaryWeight;
          groupMutableCells += 1;
        }
      }
      if (!groupMutableCells ||
          groupMutableCells > motionMaximumCells) {
        continue;
      }
      var groupLabel = groupNewCost + 1e-6 < groupOldCost ? 1 : 0;
      for (groupY = groupMinY; groupY <= groupMaxY; groupY += 1) {
        for (groupX = groupMinX; groupX <= groupMaxX; groupX += 1) {
          groupIndex = groupY * gridWidth + groupX;
          if (mutable[groupIndex]) labels[groupIndex] = groupLabel;
        }
      }
      motionBridges += 1;
      motionBridgeCells += groupMutableCells;
      if (motionBridgeDiagnostics.length < 12) {
        motionBridgeDiagnostics.push({
          type: "component-group",
          bounds: [groupMinX, groupMinY, groupMaxX, groupMaxY],
          cells: groupMutableCells
        });
      }
    }

    var motionComponentDiagnostics = [];
    var motionDiagnosticIndex;
    for (
      motionDiagnosticIndex = 0;
      motionDiagnosticIndex < Math.min(24, motionComponents.length);
      motionDiagnosticIndex += 1
    ) {
      var motionDiagnosticComponent =
        motionComponents[motionDiagnosticIndex];
      motionComponentDiagnostics.push({
        bounds: [
          motionDiagnosticComponent.minX,
          motionDiagnosticComponent.minY,
          motionDiagnosticComponent.maxX,
          motionDiagnosticComponent.maxY
        ],
        cells: motionDiagnosticComponent.cells,
        label: motionDiagnosticComponent.label,
        oldLabels: motionDiagnosticComponent.oldLabels,
        newLabels: motionDiagnosticComponent.newLabels
      });
    }

    return {
      labels: labels,
      valid: valid,
      gridWidth: gridWidth,
      gridHeight: gridHeight,
      step: step,
      protectedComponents: protectedComponents,
      protectedCells: protectedCells,
      motionBridges: motionBridges,
      motionBridgeCells: motionBridgeCells,
      motionCoreCells: motionCoreCells,
      motionBridgeDiagnostics: motionBridgeDiagnostics,
      motionComponentDiagnostics: motionComponentDiagnostics
    };
  }

  function mergeProjectedLayer(raster, layer, seam, options, warp) {
    options = options || {};
    if (!raster.priorities ||
        raster.priorities.length !== raster.weights.length) {
      raster.priorities = new Float32Array(raster.weights.length);
    }
    if (!raster.owners || raster.owners.length !== raster.weights.length) {
      raster.owners = new Uint8Array(raster.weights.length);
    }
    var frameIndex = Math.max(0, Number(options.frameIndex) || 0);
    var ownerValue = frameIndex % 254 + 1;
    var agreeThreshold = options.agreeThreshold == null ?
      12 : Math.max(0, Number(options.agreeThreshold));
    var copied = 0;
    var blended = 0;
    var hardSelected = 0;
    var conflicts = 0;
    var sampledNew = [0, 0, 0, 0, 0];
    var sampledDisplacement = [0, 0];
    var i;
    for (i = 0; i < raster.weights.length; i += 1) {
      var newWeight = layer.weights[i];
      if (newWeight <= 0.001) continue;
      var oldWeight = raster.weights[i];
      var offset = i * 4;
      var newRed = layer.pixels[offset];
      var newGreen = layer.pixels[offset + 1];
      var newBlue = layer.pixels[offset + 2];
      var newPriorityValue = layer.priorities[i];
      var sampled = false;
      if (warp && warp.active) {
        var pixelX = i % raster.width;
        var pixelY = Math.floor(i / raster.width);
        sampled = sampleProjectedLayer(
          layer,
          warp,
          pixelX,
          pixelY,
          sampledNew,
          sampledDisplacement
        );
        if (!sampled) continue;
        newRed = sampledNew[0];
        newGreen = sampledNew[1];
        newBlue = sampledNew[2];
        newWeight = sampledNew[3];
        newPriorityValue = sampledNew[4];
      }
      if (oldWeight <= 0.001) {
        raster.pixels[offset] = newRed;
        raster.pixels[offset + 1] = newGreen;
        raster.pixels[offset + 2] = newBlue;
        raster.pixels[offset + 3] = 255;
        raster.weights[i] = newWeight;
        raster.priorities[i] = newPriorityValue;
        raster.owners[i] = ownerValue;
        copied += 1;
        continue;
      }

      var difference = Math.sqrt(
        (Math.pow(raster.pixels[offset] - newRed, 2) +
          Math.pow(raster.pixels[offset + 1] - newGreen, 2) +
          Math.pow(raster.pixels[offset + 2] - newBlue, 2)) / 3
      );
      var gx = Math.min(
        seam.gridWidth - 1,
        Math.floor((i % raster.width) / seam.step)
      );
      var gy = Math.min(
        seam.gridHeight - 1,
        Math.floor(Math.floor(i / raster.width) / seam.step)
      );
      var seamIndex = gy * seam.gridWidth + gx;
      var oldPriority = Math.max(1e-6, raster.priorities[i]);
      var newPriority = Math.max(
        1e-6,
        newPriorityValue
      );
      var chooseNew = seam.valid[seamIndex] ?
        seam.labels[seamIndex] === 1 :
        newPriority > oldPriority;

      if (difference <= agreeThreshold) {
        // Only pixels that already agree are allowed to mix across the full
        // overlap. Misregistered edges and moving objects take a hard owner.
        var alpha = newPriority / (oldPriority + newPriority);
        raster.pixels[offset] = clamp(
          raster.pixels[offset] * (1 - alpha) + newRed * alpha,
          0,
          255
        );
        raster.pixels[offset + 1] = clamp(
          raster.pixels[offset + 1] * (1 - alpha) + newGreen * alpha,
          0,
          255
        );
        raster.pixels[offset + 2] = clamp(
          raster.pixels[offset + 2] * (1 - alpha) + newBlue * alpha,
          0,
          255
        );
        raster.pixels[offset + 3] = 255;
        if (chooseNew) raster.owners[i] = ownerValue;
        blended += 1;
      } else {
        conflicts += 1;
        if (chooseNew) {
          raster.pixels[offset] = newRed;
          raster.pixels[offset + 1] = newGreen;
          raster.pixels[offset + 2] = newBlue;
          raster.pixels[offset + 3] = 255;
          raster.owners[i] = ownerValue;
        }
        hardSelected += 1;
      }
      raster.weights[i] = Math.max(oldWeight, newWeight);
      if (chooseNew) raster.priorities[i] = newPriority;
      else raster.priorities[i] = oldPriority;
    }
    return {
      copiedPixels: copied,
      blendedPixels: blended,
      hardSelectedPixels: hardSelected,
      conflictPixels: conflicts,
      seamGridWidth: seam.gridWidth,
      seamGridHeight: seam.gridHeight,
      seamStep: seam.step,
      protectedSeamComponents: seam.protectedComponents || 0,
      protectedSeamCells: seam.protectedCells || 0,
      motionSeamBridges: seam.motionBridges || 0,
      motionSeamBridgeCells: seam.motionBridgeCells || 0,
      motionSeamCoreCells: seam.motionCoreCells || 0,
      motionSeamBridgeDiagnostics: seam.motionBridgeDiagnostics || [],
      motionSeamComponentDiagnostics:
        seam.motionComponentDiagnostics || []
    };
  }

  /*
   * Low-level projected-layer compositor shared by production projection and
   * deterministic synthetic regression fixtures. The layer is intentionally
   * not released here; its owner controls that lifetime.
   */
  function compositeProjectedLayerSeamAware(raster, layer, options) {
    options = options || {};
    if (!raster.priorities ||
        raster.priorities.length !== raster.weights.length) {
      raster.priorities = new Float32Array(raster.weights.length);
    }
    var exposure = compensateLayerExposure(raster, layer, options);
    var warp = estimateProjectedResidualWarp(raster, layer, options);
    var seam = planSeamLabels(raster, layer, options, warp);
    var mergeStats = mergeProjectedLayer(raster, layer, seam, options, warp);
    mergeStats.exposure = exposure;
    mergeStats.localWarp = residualWarpDiagnostics(warp);
    raster.lastSeamStats = mergeStats;
    if (!raster.seamSummary) {
      raster.seamSummary = {
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
        localWarpLastReason: null
      };
    }
    raster.seamSummary.localWarpAttempted =
      Number(raster.seamSummary.localWarpAttempted) || 0;
    raster.seamSummary.localWarpApplied =
      Number(raster.seamSummary.localWarpApplied) || 0;
    raster.seamSummary.localWarpFallbacks =
      Number(raster.seamSummary.localWarpFallbacks) || 0;
    raster.seamSummary.frames += 1;
    raster.seamSummary.copiedPixels += mergeStats.copiedPixels;
    raster.seamSummary.blendedPixels += mergeStats.blendedPixels;
    raster.seamSummary.hardSelectedPixels += mergeStats.hardSelectedPixels;
    raster.seamSummary.conflictPixels += mergeStats.conflictPixels;
    raster.seamSummary.motionSeamBridges += mergeStats.motionSeamBridges;
    raster.seamSummary.motionSeamBridgeCells +=
      mergeStats.motionSeamBridgeCells;
    raster.seamSummary.motionSeamCoreCells +=
      mergeStats.motionSeamCoreCells;
    if (mergeStats.localWarp.attempted) {
      raster.seamSummary.localWarpAttempted += 1;
      if (mergeStats.localWarp.applied) {
        raster.seamSummary.localWarpApplied += 1;
      } else {
        raster.seamSummary.localWarpFallbacks += 1;
      }
    }
    raster.seamSummary.localWarpLastReason = mergeStats.localWarp.reason;
    seam.labels = null;
    seam.valid = null;
    warp.dx = null;
    warp.dy = null;
    return mergeStats;
  }

  function projectPatchSeamAware(
    raster,
    srcPixels,
    srcWidth,
    srcHeight,
    basis,
    options
  ) {
    options = options || {};
    if (!raster.priorities ||
        raster.priorities.length !== raster.weights.length) {
      raster.priorities = new Float32Array(raster.weights.length);
    }
    var layer = createProjectionLayer(raster);
    var written = projectPatch(
      layer,
      srcPixels,
      srcWidth,
      srcHeight,
      basis,
      {
        fovXDeg: options.fovXDeg,
        feather: options.feather,
        gain: options.gain,
        bias: options.bias,
        bilinear: options.bilinear !== false,
        sourceConfidence: options.sourceConfidence
      }
    );
    compositeProjectedLayerSeamAware(raster, layer, options);
    // Make the peak-memory lifetime explicit; the next decoded frame should
    // never coexist with an older projected layer.
    layer.pixels = null;
    layer.weights = null;
    layer.priorities = null;
    return written;
  }

  function rasterStats(raster) {
    var covered = 0;
    var nonBlack = 0;
    var i;
    for (i = 0; i < raster.weights.length; i += 1) {
      if (raster.weights[i] <= 0) continue;
      covered += 1;
      var p = i * 4;
      if (raster.pixels[p] + raster.pixels[p + 1] + raster.pixels[p + 2] > 18) nonBlack += 1;
    }
    return {
      coveredPixels: covered,
      nonBlackPixels: nonBlack,
      coverage: covered / raster.weights.length
    };
  }

  function framePixelData(frame) {
    if (!frame) return null;
    if (frame.pixels && typeof frame.pixels.length === "number") return frame.pixels;
    if (frame.data && typeof frame.data.length === "number") return frame.data;
    if (frame.srcPixels && typeof frame.srcPixels.length === "number") return frame.srcPixels;
    if (frame.imageData && frame.imageData.data &&
        typeof frame.imageData.data.length === "number") return frame.imageData.data;
    return null;
  }

  function lumaAt(pixels, width, height, x, y) {
    if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return NaN;
    var x0 = Math.floor(x);
    var y0 = Math.floor(y);
    var x1 = Math.min(width - 1, x0 + 1);
    var y1 = Math.min(height - 1, y0 + 1);
    var tx = x - x0;
    var ty = y - y0;
    function at(px, py) {
      var i = (py * width + px) * 4;
      if (pixels[i + 3] === 0) return NaN;
      return pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722;
    }
    var a = at(x0, y0);
    var b = at(x1, y0);
    var c = at(x0, y1);
    var d = at(x1, y1);
    if (!isFinite(a) || !isFinite(b) || !isFinite(c) || !isFinite(d)) return NaN;
    return (a * (1 - tx) + b * tx) * (1 - ty) +
      (c * (1 - tx) + d * tx) * ty;
  }

  /*
   * 只做便宜、可解释的输入质量判断。它不会把“清晰”误称为“已对齐”；
   * 几何置信度仍由 refineFramePose 的重叠区域光度一致性给出。
   */
  function measureFrameQuality(frame, options) {
    options = options || {};
    var pixels = framePixelData(frame);
    var width = Math.max(1, Number(frame && frame.width) || 0);
    var height = Math.max(1, Number(frame && frame.height) || 0);
    if (!pixels || pixels.length < width * height * 4) {
      return {
        accepted: false,
        rejectReason: "MISSING_PIXELS",
        meanLuma: 0,
        lumaStd: 0,
        gradientEnergy: 0,
        laplacianStd: 0,
        saturatedRatio: 1,
        samples: 0
      };
    }
    var targetSamples = Math.max(256, Number(options.targetSamples) || 1600);
    var step = Math.max(1, Math.floor(Math.sqrt(width * height / targetSamples)));
    var sum = 0;
    var sum2 = 0;
    var gradient = 0;
    var lapSum = 0;
    var lapSum2 = 0;
    var saturated = 0;
    var count = 0;
    var lapCount = 0;
    var x, y;
    for (y = step; y < height - step; y += step) {
      for (x = step; x < width - step; x += step) {
        var center = lumaAt(pixels, width, height, x, y);
        var right = lumaAt(pixels, width, height, x + step, y);
        var left = lumaAt(pixels, width, height, x - step, y);
        var down = lumaAt(pixels, width, height, x, y + step);
        var up = lumaAt(pixels, width, height, x, y - step);
        if (!isFinite(center) || !isFinite(right) || !isFinite(left) ||
            !isFinite(down) || !isFinite(up)) continue;
        sum += center;
        sum2 += center * center;
        // step 会随输入分辨率变化；这里按固定采样网格的两侧差归一化，
        // 避免同一画面仅因像素更多就被误判为“更模糊”。
        gradient += (Math.abs(right - left) + Math.abs(down - up)) / 2;
        var lap = right + left + down + up - 4 * center;
        lapSum += lap;
        lapSum2 += lap * lap;
        if (center < 5 || center > 250) saturated += 1;
        count += 1;
        lapCount += 1;
      }
    }
    var mean = count ? sum / count : 0;
    var variance = count ? Math.max(0, sum2 / count - mean * mean) : 0;
    var lapMean = lapCount ? lapSum / lapCount : 0;
    var lapVariance = lapCount ? Math.max(0, lapSum2 / lapCount - lapMean * lapMean) : 0;
    var lumaStd = Math.sqrt(variance);
    var gradientEnergy = count ? gradient / count / 255 : 0;
    var laplacianStd = Math.sqrt(lapVariance) / 255;
    var saturatedRatio = count ? saturated / count : 1;
    var minLumaStd = options.minLumaStd == null ? 5 : Number(options.minLumaStd);
    var minGradient = options.minGradient == null ? 0.012 : Number(options.minGradient);
    var minMean = options.minMean == null ? 4 : Number(options.minMean);
    var maxMean = options.maxMean == null ? 251 : Number(options.maxMean);
    var accepted = count >= 64 && lumaStd >= minLumaStd &&
      gradientEnergy >= minGradient && mean >= minMean && mean <= maxMean;
    var reason = "";
    if (count < 64) reason = "TOO_FEW_VALID_PIXELS";
    else if (mean < minMean) reason = "TOO_DARK";
    else if (mean > maxMean) reason = "TOO_BRIGHT";
    else if (lumaStd < minLumaStd) reason = "LOW_TEXTURE";
    else if (gradientEnergy < minGradient) reason = "TOO_BLURRY";
    return {
      accepted: accepted,
      rejectReason: reason,
      meanLuma: mean,
      lumaStd: lumaStd,
      gradientEnergy: gradientEnergy,
      laplacianStd: laplacianStd,
      saturatedRatio: saturatedRatio,
      samples: count
    };
  }

  function createAlignmentSamples(frame, basis, fovXDeg, options) {
    options = options || {};
    var pixels = framePixelData(frame);
    var width = Math.max(1, Number(frame.width) || 0);
    var height = Math.max(1, Number(frame.height) || 0);
    var targetSamples = Math.max(200, Number(options.targetSamples) || 900);
    var step = Math.max(2, Math.floor(Math.sqrt(width * height / targetSamples)));
    var margin = Math.max(2, step);
    var aspect = width / Math.max(1, height);
    var samples = [];
    var x, y;
    for (y = margin; y < height - margin; y += step) {
      for (x = margin; x < width - margin; x += step) {
        var luma = lumaAt(pixels, width, height, x, y);
        if (!isFinite(luma)) continue;
        var nx = x / Math.max(1, width - 1) * 2 - 1;
        var ny = 1 - y / Math.max(1, height - 1) * 2;
        samples.push({
          dir: directionFromImagePoint(nx, ny, basis, fovXDeg, aspect),
          luma: luma,
          // 固定在参考照片上的小网格只需一个字节量级的整数。配准评分
          // 可据此剔除少数移动人物/近景占据的异常块，而不保存逐候选残差。
          blockIndex: Math.min(5, Math.max(0, Math.floor((nx + 1) * 3))) +
            Math.min(3, Math.max(0, Math.floor((1 - ny) * 2))) * 6
        });
      }
    }
    return samples;
  }

  function alignmentMoments(
    sumA,
    sumB,
    sumAA,
    sumBB,
    sumAB,
    count
  ) {
    if (count < 12) return null;
    var varA = Math.max(1e-9, sumAA - sumA * sumA / count);
    var varB = Math.max(1e-9, sumBB - sumB * sumB / count);
    var covariance = sumAB - sumA * sumB / count;
    var zncc = covariance / Math.sqrt(varA * varB);
    var gain = covariance / varB;
    var bias = sumA / count - gain * sumB / count;
    var sse = Math.max(0, varA - covariance * covariance / varB);
    return {
      zncc: zncc,
      rmse: Math.sqrt(sse / count),
      gain: gain,
      bias: bias,
      varianceA: varA / count,
      varianceB: varB / count
    };
  }

  function createAlignmentScoreScratch() {
    return {
      blockSamples: new Uint16Array(24),
      blockSumA: new Float64Array(24),
      blockSumB: new Float64Array(24),
      blockSumAA: new Float64Array(24),
      blockSumBB: new Float64Array(24),
      blockSumAB: new Float64Array(24),
      rejectedBlocks: new Uint8Array(24),
      occupiedColumns: new Uint8Array(6),
      occupiedRows: new Uint8Array(4)
    };
  }

  function scoreAlignment(samples, frame, basis, fovXDeg, scratch) {
    var pixels = framePixelData(frame);
    var width = Math.max(1, Number(frame.width) || 0);
    var height = Math.max(1, Number(frame.height) || 0);
    var aspect = width / Math.max(1, height);
    var sumA = 0;
    var sumB = 0;
    var sumAA = 0;
    var sumBB = 0;
    var sumAB = 0;
    var count = 0;
    var blockCount = 24;
    scratch = scratch || createAlignmentScoreScratch();
    var blockSamples = scratch.blockSamples;
    var blockSumA = scratch.blockSumA;
    var blockSumB = scratch.blockSumB;
    var blockSumAA = scratch.blockSumAA;
    var blockSumBB = scratch.blockSumBB;
    var blockSumAB = scratch.blockSumAB;
    var resetIndex;
    for (resetIndex = 0; resetIndex < blockCount; resetIndex += 1) {
      blockSamples[resetIndex] = 0;
      blockSumA[resetIndex] = 0;
      blockSumB[resetIndex] = 0;
      blockSumAA[resetIndex] = 0;
      blockSumBB[resetIndex] = 0;
      blockSumAB[resetIndex] = 0;
      scratch.rejectedBlocks[resetIndex] = 0;
    }
    for (resetIndex = 0; resetIndex < 6; resetIndex += 1) {
      scratch.occupiedColumns[resetIndex] = 0;
    }
    for (resetIndex = 0; resetIndex < 4; resetIndex += 1) {
      scratch.occupiedRows[resetIndex] = 0;
    }
    var i;
    for (i = 0; i < samples.length; i += 1) {
      var point = imagePointFromDirection(samples[i].dir, basis, fovXDeg, aspect);
      if (!point || Math.abs(point.nx) > 0.985 || Math.abs(point.ny) > 0.985) continue;
      var x = (point.nx * 0.5 + 0.5) * (width - 1);
      var y = (0.5 - point.ny * 0.5) * (height - 1);
      var current = lumaAt(pixels, width, height, x, y);
      if (!isFinite(current)) continue;
      var reference = samples[i].luma;
      sumA += reference;
      sumB += current;
      sumAA += reference * reference;
      sumBB += current * current;
      sumAB += reference * current;
      count += 1;
      var blockIndex = Number(samples[i].blockIndex);
      if (!(blockIndex >= 0 && blockIndex < blockCount)) blockIndex = 0;
      blockSamples[blockIndex] += 1;
      blockSumA[blockIndex] += reference;
      blockSumB[blockIndex] += current;
      blockSumAA[blockIndex] += reference * reference;
      blockSumBB[blockIndex] += current * current;
      blockSumAB[blockIndex] += reference * current;
    }
    if (count < 12) {
      return {
        rank: -10,
        zncc: -1,
        globalZncc: -1,
        rmse: 255,
        overlapRatio: samples.length ? count / samples.length : 0,
        overlapSamples: count,
        gain: 1,
        bias: 0,
        robustBlockCount: 0,
        rejectedBlockCount: 0
      };
    }
    var global = alignmentMoments(
      sumA,
      sumB,
      sumAA,
      sumBB,
      sumAB,
      count
    );
    var selected = global;
    var validBlocks = [];
    var block;
    for (block = 0; block < blockCount; block += 1) {
      var blockStats = alignmentMoments(
        blockSumA[block],
        blockSumB[block],
        blockSumAA[block],
        blockSumBB[block],
        blockSumAB[block],
        blockSamples[block]
      );
      // 纯墙面小块的相关系数容易被微小噪声放大，不能参与异常块判断。
      if (!blockStats ||
          blockStats.varianceA < 4 ||
          blockStats.varianceB < 4) {
        continue;
      }
      validBlocks.push({
        index: block,
        zncc: blockStats.zncc
      });
    }
    var rejectedBlocks = scratch.rejectedBlocks;
    var rejectedBlockCount = 0;
    var robustBlockCount = 0;
    if (validBlocks.length >= 6) {
      var blockScores = validBlocks.map(function (entry) {
        return entry.zncc;
      });
      var blockMedian = median(blockScores);
      var blockDeviations = validBlocks.map(function (entry) {
        return Math.abs(entry.zncc - blockMedian);
      });
      var blockMad = median(blockDeviations);
      var rejectThreshold = blockMedian - Math.max(0.12, blockMad * 2.5);
      var rejectBudget = Math.max(
        1,
        Math.floor(validBlocks.length * 0.25)
      );
      validBlocks.sort(function (left, right) {
        return left.zncc - right.zncc;
      });
      for (i = 0; i < validBlocks.length && i < rejectBudget; i += 1) {
        if (validBlocks[i].zncc >= rejectThreshold) break;
        rejectedBlocks[validBlocks[i].index] = 1;
        rejectedBlockCount += 1;
      }
      if (rejectedBlockCount > 0) {
        var robustSumA = 0;
        var robustSumB = 0;
        var robustSumAA = 0;
        var robustSumBB = 0;
        var robustSumAB = 0;
        var robustSamples = 0;
        var occupiedColumns = scratch.occupiedColumns;
        var occupiedRows = scratch.occupiedRows;
        for (block = 0; block < blockCount; block += 1) {
          if (rejectedBlocks[block] || blockSamples[block] <= 0) continue;
          robustSumA += blockSumA[block];
          robustSumB += blockSumB[block];
          robustSumAA += blockSumAA[block];
          robustSumBB += blockSumBB[block];
          robustSumAB += blockSumAB[block];
          robustSamples += blockSamples[block];
          occupiedColumns[block % 6] = 1;
          occupiedRows[Math.floor(block / 6)] = 1;
        }
        var columnCoverage = 0;
        var rowCoverage = 0;
        for (i = 0; i < occupiedColumns.length; i += 1) {
          columnCoverage += occupiedColumns[i];
        }
        for (i = 0; i < occupiedRows.length; i += 1) {
          rowCoverage += occupiedRows[i];
        }
        var robust = alignmentMoments(
          robustSumA,
          robustSumB,
          robustSumAA,
          robustSumBB,
          robustSumAB,
          robustSamples
        );
        if (robust && columnCoverage >= 2 && rowCoverage >= 2) {
          selected = robust;
          robustBlockCount = validBlocks.length - rejectedBlockCount;
        } else {
          rejectedBlockCount = 0;
        }
      }
    }
    var overlapRatio = samples.length ? count / samples.length : 0;
    return {
      // 鲁棒分数负责最终置信门；搜索排序与全局证据各占一半，避免某个
      // 候选靠偶然舍弃异常块而战胜整体背景几何更准确的候选。
      rank: selected.zncc * 0.5 + global.zncc * 0.5 +
        Math.min(0.5, overlapRatio) * 0.015 -
        Math.min(80, selected.rmse) * 0.00005 -
        rejectedBlockCount / Math.max(1, validBlocks.length) * 0.004,
      zncc: selected.zncc,
      globalZncc: global.zncc,
      rmse: selected.rmse,
      overlapRatio: overlapRatio,
      overlapSamples: count,
      gain: selected.gain,
      bias: selected.bias,
      robustBlockCount: robustBlockCount,
      rejectedBlockCount: rejectedBlockCount
    };
  }

  /*
   * 轻量直接光度配准：相邻/重叠帧之间，在 IMU 初值附近搜索小 yaw/pitch/
   * roll 与水平 FOV，并以 ZNCC 评分。ZNCC 对线性曝光变化不敏感，返回的
   * gain/bias 可用于 2D 粗拼。
   *
   * 这是有边界的移动端纠偏，不是 ORB/RANSAC、bundle adjustment 或局部
   * mesh warp。少数动态前景块可由背景鲁棒统计排除，但剔除预算严格限制为
   * 有效块的 25%；超过 maxCorrectionDeg、大面积动态物体、强视差或低纹理
   * 时仍必须拒绝并重拍，不能把低置信结果伪装成成功。
   */
  function refineFramePose(referenceFrame, currentFrame, options) {
    options = options || {};
    referenceFrame = referenceFrame || {};
    currentFrame = currentFrame || {};
    var referenceBasis = referenceFrame.correctedBasis || referenceFrame.basis;
    var initialBasis = currentFrame.basis;
    var referenceFov = Number(referenceFrame.correctedFovXDeg ||
      referenceFrame.fovXDeg || options.fovXDeg || 65);
    var initialFov = Number(currentFrame.fovXDeg || options.fovXDeg || 65);
    var referenceQuality = measureFrameQuality(referenceFrame, options.quality);
    var currentQuality = measureFrameQuality(currentFrame, options.quality);
    var fallback = {
      basis: initialBasis ? copyBasis(initialBasis) : null,
      correctedBasis: initialBasis ? copyBasis(initialBasis) : null,
      fovXDeg: initialFov,
      correctedFovXDeg: initialFov,
      correction: { yawDeg: 0, pitchDeg: 0, rollDeg: 0, fovDeg: 0 },
      initialScore: -1,
      score: -1,
      rmse: 255,
      overlapRatio: 0,
      overlapSamples: 0,
      gain: 1,
      bias: 0,
      confidence: 0,
      accepted: false,
      rejectReason: "",
      referenceQuality: referenceQuality,
      currentQuality: currentQuality,
      method: "local-multiscale-photometric-zncc"
    };
    if (!referenceBasis || !initialBasis) {
      fallback.rejectReason = "MISSING_BASIS";
      return fallback;
    }
    if (!referenceQuality.accepted) {
      fallback.rejectReason = "REFERENCE_" + referenceQuality.rejectReason;
      return fallback;
    }
    if (!currentQuality.accepted) {
      fallback.rejectReason = currentQuality.rejectReason;
      return fallback;
    }
    var samples = createAlignmentSamples(
      referenceFrame,
      referenceBasis,
      referenceFov,
      options
    );
    if (samples.length < 64) {
      fallback.rejectReason = "TOO_FEW_REFERENCE_SAMPLES";
      return fallback;
    }
    var maxCorrection = Math.max(0.25, Number(options.maxCorrectionDeg) || 6);
    var maxRoll = options.maxRollDeg == null ? 4 : Math.max(0, Number(options.maxRollDeg));
    var maxFov = options.maxFovCorrectionDeg == null ?
      6 : Math.max(0, Number(options.maxFovCorrectionDeg));
    var levels = Math.max(1, Math.min(4, Number(options.levels) || 3));
    var state = { yaw: 0, pitch: 0, roll: 0, fov: initialFov };
    // 搜索期复用固定 24 块统计缓冲，数百个候选不会反复分配大数组。
    var scoreScratch = createAlignmentScoreScratch();
    var initial = scoreAlignment(
      samples,
      currentFrame,
      initialBasis,
      initialFov,
      scoreScratch
    );
    var best = initial;
    var level;
    for (level = 0; level < levels; level += 1) {
      var divisor = Math.pow(3, level);
      var yawStep = maxCorrection / 2 / divisor;
      var pitchStep = yawStep;
      var rollStep = maxRoll > 0 ? maxRoll / 2 / divisor : 0;
      var fovStep = maxFov > 0 ? maxFov / 2 / divisor : 0;
      var center = {
        yaw: state.yaw,
        pitch: state.pitch,
        roll: state.roll,
        fov: state.fov
      };
      var iy, ip, ir;
      for (iy = -2; iy <= 2; iy += 1) {
        for (ip = -2; ip <= 2; ip += 1) {
          for (ir = rollStep > 0 ? -2 : 0; ir <= (rollStep > 0 ? 2 : 0); ir += 1) {
            var yaw = clamp(center.yaw + iy * yawStep, -maxCorrection, maxCorrection);
            var pitch = clamp(center.pitch + ip * pitchStep, -maxCorrection, maxCorrection);
            var roll = clamp(center.roll + ir * rollStep, -maxRoll, maxRoll);
            var candidateBasis = rotateBasisLocal(initialBasis, yaw, pitch, roll);
            var result = scoreAlignment(
              samples,
              currentFrame,
              candidateBasis,
              state.fov,
              scoreScratch
            );
            if (result.rank > best.rank) {
              best = result;
              state.yaw = yaw;
              state.pitch = pitch;
              state.roll = roll;
            }
          }
        }
      }
      if (fovStep > 0) {
        var f;
        center.fov = state.fov;
        for (f = -2; f <= 2; f += 1) {
          var fov = clamp(center.fov + f * fovStep, 25, 120);
          var fixedBasis = rotateBasisLocal(initialBasis, state.yaw, state.pitch, state.roll);
          var fovResult = scoreAlignment(
            samples,
            currentFrame,
            fixedBasis,
            fov,
            scoreScratch
          );
          if (fovResult.rank > best.rank) {
            best = fovResult;
            state.fov = fov;
          }
        }
      }
    }
    var corrected = rotateBasisLocal(initialBasis, state.yaw, state.pitch, state.roll);
    // 搜索的最后一次可能改变了姿态但 best 仍来自上一 FOV，统一按最终状态复算。
    best = scoreAlignment(
      samples,
      currentFrame,
      corrected,
      state.fov,
      scoreScratch
    );
    var minOverlap = options.minOverlapRatio == null ? 0.08 :
      Math.max(0, Number(options.minOverlapRatio));
    var minScore = options.minScore == null ? 0.72 : Number(options.minScore);
    var overlapConfidence = clamp(best.overlapRatio / Math.max(0.18, minOverlap), 0, 1);
    var scoreConfidence = clamp((best.zncc - minScore) / Math.max(0.01, 1 - minScore), 0, 1);
    var textureConfidence = clamp(
      Math.min(referenceQuality.lumaStd, currentQuality.lumaStd) / 24,
      0.2,
      1
    );
    var confidence = scoreConfidence * overlapConfidence * textureConfidence;
    var atBoundary = Math.abs(state.yaw) >= maxCorrection - 1e-4 ||
      Math.abs(state.pitch) >= maxCorrection - 1e-4 ||
      (maxRoll > 0 && Math.abs(state.roll) >= maxRoll - 1e-4) ||
      (maxFov > 0 && Math.abs(state.fov - initialFov) >= maxFov - 1e-4);
    var accepted = best.overlapRatio >= minOverlap && best.zncc >= minScore &&
      (!atBoundary || options.allowBoundary === true);
    var rejectReason = "";
    if (best.overlapRatio < minOverlap) rejectReason = "INSUFFICIENT_OVERLAP";
    else if (best.zncc < minScore) rejectReason = "LOW_ALIGNMENT_CONFIDENCE";
    else if (atBoundary && options.allowBoundary !== true) rejectReason = "CORRECTION_LIMIT";
    return {
      basis: corrected,
      correctedBasis: corrected,
      fovXDeg: state.fov,
      correctedFovXDeg: state.fov,
      correction: {
        yawDeg: state.yaw,
        pitchDeg: state.pitch,
        rollDeg: state.roll,
        fovDeg: state.fov - initialFov
      },
      initialScore: initial.zncc,
      score: best.zncc,
      globalScore: best.globalZncc,
      rmse: best.rmse,
      overlapRatio: best.overlapRatio,
      overlapSamples: best.overlapSamples,
      gain: best.gain,
      bias: best.bias,
      robustBlockCount: best.robustBlockCount || 0,
      rejectedBlockCount: best.rejectedBlockCount || 0,
      confidence: confidence,
      accepted: accepted,
      rejectReason: rejectReason,
      referenceQuality: referenceQuality,
      currentQuality: currentQuality,
      method: "local-multiscale-photometric-zncc"
    };
  }

  /*
   * 尝试多个几何相邻参考帧，避免把拍摄序号当作重叠关系。选择分数同时考虑
   * ZNCC、置信度和相对 IMU 初值的修正幅度；没有任何可靠候选时保留最佳
   * 拒绝原因，不传播错误姿态。
   */
  function refineFramePoseFromReferences(referenceFrames, currentFrame, options) {
    options = options || {};
    referenceFrames = referenceFrames || [];
    currentFrame = currentFrame || {};
    var maxReferences = Math.max(1, Number(options.maxReferences) || 6);
    var maxReferenceAngle = options.maxReferenceAngleDeg == null ?
      78 : Number(options.maxReferenceAngleDeg);
    var candidates = [];
    var currentBasis = currentFrame.basis;
    if (!currentBasis || !currentBasis.F) {
      return refineFramePose(referenceFrames[0] || {}, currentFrame, options);
    }
    var i;
    for (i = 0; i < referenceFrames.length; i += 1) {
      var referenceBasis = referenceFrames[i].correctedBasis || referenceFrames[i].basis;
      if (!referenceBasis || !referenceBasis.F) continue;
      var separation = angleDeg(referenceBasis.F, currentBasis.F);
      if (separation <= maxReferenceAngle) {
        candidates.push({ frame: referenceFrames[i], angle: separation, index: i });
      }
    }
    candidates.sort(function (a, b) { return a.angle - b.angle; });
    candidates = candidates.slice(0, maxReferences);
    var tried = [];
    var best = null;
    var bestSelectionScore = -Infinity;
    for (i = 0; i < candidates.length; i += 1) {
      var result = refineFramePose(candidates[i].frame, currentFrame, options);
      var correctionMagnitude = Math.sqrt(
        result.correction.yawDeg * result.correction.yawDeg +
        result.correction.pitchDeg * result.correction.pitchDeg +
        result.correction.rollDeg * result.correction.rollDeg
      );
      var priorPenalty = (Number(options.imuPriorWeight) || 0.035) *
        correctionMagnitude / Math.max(1, Number(options.maxCorrectionDeg) || 6);
      var selectionScore = result.score + result.confidence * 0.04 - priorPenalty;
      result.referenceIndex = candidates[i].index;
      result.referenceAngleDeg = candidates[i].angle;
      result.selectionScore = selectionScore;
      tried.push(result);
      if (!best ||
          (result.accepted && !best.accepted) ||
          (result.accepted === best.accepted && selectionScore > bestSelectionScore)) {
        best = result;
        bestSelectionScore = selectionScore;
      }
    }
    if (!best) {
      var quality = measureFrameQuality(currentFrame, options.quality);
      return {
        basis: currentBasis ? copyBasis(currentBasis) : null,
        correctedBasis: currentBasis ? copyBasis(currentBasis) : null,
        fovXDeg: Number(currentFrame.fovXDeg || options.fovXDeg || 65),
        correctedFovXDeg: Number(currentFrame.fovXDeg || options.fovXDeg || 65),
        correction: { yawDeg: 0, pitchDeg: 0, rollDeg: 0, fovDeg: 0 },
        initialScore: -1,
        score: -1,
        rmse: 255,
        overlapRatio: 0,
        overlapSamples: 0,
        gain: 1,
        bias: 0,
        confidence: 0,
        accepted: false,
        rejectReason: "NO_GEOMETRIC_NEIGHBOR",
        currentQuality: quality,
        triedReferences: 0,
        method: "local-multireference-photometric-zncc"
      };
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
    best.method = "local-multireference-photometric-zncc";
    return best;
  }

  function rotationDelta(source, target) {
    var m = [];
    var i, j;
    var sourceAxes = [source.R, source.U, source.F];
    var targetAxes = [target.R, target.U, target.F];
    for (i = 0; i < 3; i += 1) {
      for (j = 0; j < 3; j += 1) {
        m[i * 3 + j] =
          targetAxes[0][i] * sourceAxes[0][j] +
          targetAxes[1][i] * sourceAxes[1][j] +
          targetAxes[2][i] * sourceAxes[2][j];
      }
    }
    var angle = Math.acos(clamp((m[0] + m[4] + m[8] - 1) / 2, -1, 1));
    if (angle < 1e-8) return { axis: WORLD_UP.slice(), angleDeg: 0 };
    var sinAngle = Math.sin(angle);
    var axis;
    if (Math.abs(sinAngle) > 1e-6) {
      axis = normalize([
        m[7] - m[5],
        m[2] - m[6],
        m[3] - m[1]
      ], WORLD_UP);
    } else {
      axis = normalize([
        Math.sqrt(Math.max(0, (m[0] + 1) / 2)),
        Math.sqrt(Math.max(0, (m[4] + 1) / 2)),
        Math.sqrt(Math.max(0, (m[8] + 1) / 2))
      ], WORLD_UP);
    }
    return { axis: axis, angleDeg: angle * RAD };
  }

  function rotateBasisWorld(basis, axis, deg) {
    return orthonormalBasis(
      rotateAroundAxis(basis.F, axis, deg),
      rotateAroundAxis(basis.U, axis, deg)
    );
  }

  function blendBasis(source, target, t) {
    var delta = rotationDelta(source, target);
    return rotateBasisWorld(source, delta.axis, delta.angleDeg * clamp(t, 0, 1));
  }

  /*
   * 相机基是左手的 [R,U,F] 三列（R×U=-F），但两个相机基之间的
   * S^T*T 仍是合法的 SO(3) 相对旋转。视觉边必须保存这个相对量，而不是
   * 在优化时反复把某个绝对 correctedBasis 覆盖到 to 节点。
   */
  function basisMatrix(basis) {
    return [
      basis.R[0], basis.U[0], basis.F[0],
      basis.R[1], basis.U[1], basis.F[1],
      basis.R[2], basis.U[2], basis.F[2]
    ];
  }

  function transposeMatrix3(matrix) {
    return [
      matrix[0], matrix[3], matrix[6],
      matrix[1], matrix[4], matrix[7],
      matrix[2], matrix[5], matrix[8]
    ];
  }

  function multiplyMatrix3(a, b) {
    var out = new Array(9);
    var row;
    var column;
    for (row = 0; row < 3; row += 1) {
      for (column = 0; column < 3; column += 1) {
        out[row * 3 + column] =
          a[row * 3] * b[column] +
          a[row * 3 + 1] * b[3 + column] +
          a[row * 3 + 2] * b[6 + column];
      }
    }
    return out;
  }

  function basisFromMatrix(matrix) {
    return orthonormalBasis(
      [matrix[2], matrix[5], matrix[8]],
      [matrix[1], matrix[4], matrix[7]]
    );
  }

  function relativeBasisMatrix(source, target) {
    return multiplyMatrix3(
      transposeMatrix3(basisMatrix(source)),
      basisMatrix(target)
    );
  }

  function applyRelativeBasis(source, relativeMatrix) {
    return basisFromMatrix(
      multiplyMatrix3(basisMatrix(source), relativeMatrix)
    );
  }

  function addUniqueNumber(values, value) {
    if (values.indexOf(value) < 0) values.push(value);
  }

  /*
   * 轻量全局 3DoF rotation pose graph：
   * - 每条 accepted 视觉边是 from→to 的相对 SO(3) 约束；
   * - 原始 IMU basis 是弱 unary prior，首帧固定以消除 gauge；
   * - 所有节点联合做 Huber-robust 松弛，不再沿拍摄顺序覆盖/传播；
   * - 过大的初始残差和优化后仍不一致的边会被剔除并重新求解；
   * - closure 只有在去掉自身后仍有可靠替代路径时才成立，因此断边不会
   *   借一条“闭环”边绕回去污染另一段。
   *
   * edges: {from,to,accepted,confidence,correctedBasis|result,isClosure}
   * correctedBasis/result.correctedBasis 是视觉认为的 to 绝对姿态；函数会
   * 用采集时 frames[from].correctedBasis 推导一次相对测量，随后只消费
   * 相对旋转。relativeMatrix(9 个 row-major 数)也可由调用方直接提供。
   */
  function optimizeFrameSequence(frames, edges, options) {
    options = options || {};
    frames = frames || [];
    edges = edges || [];
    var minConfidence = options.minEdgeConfidence == null ?
      0.45 : Number(options.minEdgeConfidence);
    var imuPriorWeight = options.imuPriorWeight == null ?
      0.08 : Math.max(0, Number(options.imuPriorWeight));
    // 配置值表达“prior 相对视觉边的强度”而非又一条同量纲边；
    // 平方后 0.1 保持为真正的弱先验，1 仍可明确锁紧 IMU。
    var unaryPriorWeight = imuPriorWeight * imuPriorWeight;
    var loopStrength = options.loopStrength == null ?
      1 : clamp(Number(options.loopStrength), 0, 1);
    var maxInitialResidual = options.maxInitialEdgeResidualDeg == null ?
      8 : Math.max(0.5, Number(options.maxInitialEdgeResidualDeg));
    var maxFinalResidual = options.maxFinalEdgeResidualDeg == null ?
      4.5 : Math.max(0.5, Number(options.maxFinalEdgeResidualDeg));
    var huberDeg = options.huberDeg == null ?
      2.25 : Math.max(0.25, Number(options.huberDeg));
    var iterations = Math.max(
      1,
      Math.min(80, Number(options.iterations) || 42)
    );
    var relaxation = options.relaxation == null ?
      0.58 : clamp(Number(options.relaxation), 0.05, 0.95);
    var maxIterationStep = options.maxIterationStepDeg == null ?
      1.5 : Math.max(0.1, Number(options.maxIterationStepDeg));
    var maxNodeCorrection = options.maxNodeCorrectionDeg == null ?
      8 : Math.max(0.5, Number(options.maxNodeCorrectionDeg));
    var anchorIndex = Math.max(
      0,
      Math.min(frames.length - 1, Number(options.anchorIndex) || 0)
    );
    var initialBases = frames.map(function (frame) {
      return copyBasis(frame.correctedBasis || frame.basis);
    });
    var priors = frames.map(function (frame, index) {
      return copyBasis(frame.basis || initialBases[index]);
    });
    var ignoredEdges = [];
    var rejectedEdges = [];
    var candidateEdges = [];
    var i;

    function rejectEdge(index, reason, residualDeg) {
      addUniqueNumber(ignoredEdges, index);
      rejectedEdges.push({
        index: index,
        reason: reason,
        residualDeg: isFinite(residualDeg) ? residualDeg : null
      });
    }

    for (i = 0; i < edges.length; i += 1) {
      var edge = edges[i];
      var result = edge.result || edge;
      var confidence = edge.confidence == null ?
        Number(result.confidence) || 0 : Number(edge.confidence);
      var reliable = edge.accepted !== false && result.accepted !== false &&
        confidence >= minConfidence;
      if (!reliable) {
        rejectEdge(i, "LOW_CONFIDENCE", NaN);
        continue;
      }
      var from = Number(edge.from);
      var to = Number(edge.to);
      if (!(from >= 0 && from < initialBases.length) ||
          !(to >= 0 && to < initialBases.length) ||
          from === to) {
        rejectEdge(i, "INVALID_ENDPOINT", NaN);
        continue;
      }
      var relative = edge.relativeMatrix;
      if (!relative || relative.length !== 9) {
        var measuredFrom = edge.fromBasis || result.fromBasis ||
          frames[from].correctedBasis || frames[from].basis;
        var measuredTo = edge.predictedStartBasis ||
          edge.correctedBasis || result.correctedBasis || result.basis;
        if (!measuredFrom || !measuredTo) {
          rejectEdge(i, "MISSING_RELATIVE_MEASUREMENT", NaN);
          continue;
        }
        relative = relativeBasisMatrix(measuredFrom, measuredTo);
      } else {
        relative = Array.prototype.slice.call(relative, 0, 9);
      }
      var initialPrediction = applyRelativeBasis(initialBases[from], relative);
      var initialResidual = basisRotationErrorDeg(
        initialBases[to],
        initialPrediction
      );
      if (!isFinite(initialResidual) || initialResidual > maxInitialResidual) {
        rejectEdge(i, "INITIAL_RESIDUAL_OUTLIER", initialResidual);
        continue;
      }
      candidateEdges.push({
        from: from,
        to: to,
        confidence: clamp(confidence, 0, 1),
        index: i,
        isClosure: edge.isClosure === true,
        relativeMatrix: relative,
        initialResidualDeg: initialResidual
      });
    }

    function hasAlternatePath(from, to, skippedIndex) {
      var visited = new Uint8Array(initialBases.length);
      var queue = new Int32Array(initialBases.length);
      var head = 0;
      var tail = 1;
      queue[0] = from;
      visited[from] = 1;
      while (head < tail) {
        var node = queue[head];
        head += 1;
        if (node === to) return true;
        var edgeIndex;
        for (edgeIndex = 0; edgeIndex < candidateEdges.length; edgeIndex += 1) {
          var candidate = candidateEdges[edgeIndex];
          if (candidate.index === skippedIndex || candidate.isClosure) continue;
          var neighbor = -1;
          if (candidate.from === node) neighbor = candidate.to;
          else if (candidate.to === node) neighbor = candidate.from;
          if (neighbor < 0 || visited[neighbor]) continue;
          visited[neighbor] = 1;
          queue[tail] = neighbor;
          tail += 1;
        }
      }
      return false;
    }

    var activeEdges = [];
    for (i = 0; i < candidateEdges.length; i += 1) {
      if (candidateEdges[i].isClosure &&
          !hasAlternatePath(
            candidateEdges[i].from,
            candidateEdges[i].to,
            candidateEdges[i].index
          )) {
        rejectEdge(
          candidateEdges[i].index,
          "CLOSURE_WITHOUT_ALTERNATE_PATH",
          candidateEdges[i].initialResidualDeg
        );
      } else {
        activeEdges.push(candidateEdges[i]);
      }
    }

    function solvePoseGraph(graphEdges) {
      var solved = initialBases.map(copyBasis);
      var completedIterations = 0;
      var iteration;
      for (iteration = 0; iteration < iterations; iteration += 1) {
        var sums = [];
        var weights = new Float32Array(solved.length);
        var nodeIndex;
        for (nodeIndex = 0; nodeIndex < solved.length; nodeIndex += 1) {
          sums.push([0, 0, 0]);
        }
        for (i = 0; i < graphEdges.length; i += 1) {
          var graphEdge = graphEdges[i];
          var predictedTo = applyRelativeBasis(
            solved[graphEdge.from],
            graphEdge.relativeMatrix
          );
          var edgeError = rotationDelta(solved[graphEdge.to], predictedTo);
          var edgeMagnitude = edgeError.angleDeg;
          var robust = edgeMagnitude <= huberDeg ?
            1 : huberDeg / Math.max(huberDeg, edgeMagnitude);
          var edgeWeight = graphEdge.confidence * robust *
            (graphEdge.isClosure ? loopStrength : 1);
          if (edgeWeight <= 1e-8) continue;
          var ex = edgeError.axis[0] * edgeMagnitude * edgeWeight;
          var ey = edgeError.axis[1] * edgeMagnitude * edgeWeight;
          var ez = edgeError.axis[2] * edgeMagnitude * edgeWeight;
          if (graphEdge.to !== anchorIndex) {
            sums[graphEdge.to][0] += ex;
            sums[graphEdge.to][1] += ey;
            sums[graphEdge.to][2] += ez;
            weights[graphEdge.to] += edgeWeight;
          }
          if (graphEdge.from !== anchorIndex) {
            sums[graphEdge.from][0] -= ex;
            sums[graphEdge.from][1] -= ey;
            sums[graphEdge.from][2] -= ez;
            weights[graphEdge.from] += edgeWeight;
          }
        }
        for (nodeIndex = 0; nodeIndex < solved.length; nodeIndex += 1) {
          if (nodeIndex === anchorIndex) continue;
          var priorError = rotationDelta(solved[nodeIndex], priors[nodeIndex]);
          if (unaryPriorWeight > 0) {
            sums[nodeIndex][0] +=
              priorError.axis[0] * priorError.angleDeg * unaryPriorWeight;
            sums[nodeIndex][1] +=
              priorError.axis[1] * priorError.angleDeg * unaryPriorWeight;
            sums[nodeIndex][2] +=
              priorError.axis[2] * priorError.angleDeg * unaryPriorWeight;
            weights[nodeIndex] += unaryPriorWeight;
          }
        }
        var maxApplied = 0;
        for (nodeIndex = 0; nodeIndex < solved.length; nodeIndex += 1) {
          if (nodeIndex === anchorIndex || weights[nodeIndex] <= 1e-8) continue;
          var scale = relaxation / weights[nodeIndex];
          var vx = sums[nodeIndex][0] * scale;
          var vy = sums[nodeIndex][1] * scale;
          var vz = sums[nodeIndex][2] * scale;
          var magnitude = Math.sqrt(vx * vx + vy * vy + vz * vz);
          if (magnitude > maxIterationStep) {
            var stepScale = maxIterationStep / magnitude;
            vx *= stepScale;
            vy *= stepScale;
            vz *= stepScale;
            magnitude = maxIterationStep;
          }
          if (magnitude > 1e-8) {
            solved[nodeIndex] = rotateBasisWorld(
              solved[nodeIndex],
              [vx / magnitude, vy / magnitude, vz / magnitude],
              magnitude
            );
            var correction = rotationDelta(
              initialBases[nodeIndex],
              solved[nodeIndex]
            );
            if (correction.angleDeg > maxNodeCorrection) {
              solved[nodeIndex] = rotateBasisWorld(
                initialBases[nodeIndex],
                correction.axis,
                maxNodeCorrection
              );
            }
          }
          maxApplied = Math.max(maxApplied, magnitude);
        }
        solved[anchorIndex] = copyBasis(initialBases[anchorIndex]);
        completedIterations = iteration + 1;
        if (maxApplied < 0.0005) break;
      }
      return { bases: solved, iterations: completedIterations };
    }

    var firstSolve = solvePoseGraph(activeEdges);
    var retainedEdges = [];
    for (i = 0; i < activeEdges.length; i += 1) {
      var active = activeEdges[i];
      var predicted = applyRelativeBasis(
        firstSolve.bases[active.from],
        active.relativeMatrix
      );
      var finalResidual = basisRotationErrorDeg(
        firstSolve.bases[active.to],
        predicted
      );
      if (finalResidual > maxFinalResidual &&
          active.initialResidualDeg > huberDeg) {
        rejectEdge(active.index, "ROBUST_RESIDUAL_OUTLIER", finalResidual);
      } else {
        active.finalResidualDeg = finalResidual;
        retainedEdges.push(active);
      }
    }
    var solvedResult = retainedEdges.length === activeEdges.length ?
      firstSolve : solvePoseGraph(retainedEdges);
    var bases = solvedResult.bases;
    var acceptedEdges = retainedEdges.map(function (retained) {
      return retained.index;
    });
    var loopReports = [];
    for (i = 0; i < retainedEdges.length; i += 1) {
      if (!retainedEdges[i].isClosure) continue;
      var closurePrediction = applyRelativeBasis(
        bases[retainedEdges[i].from],
        retainedEdges[i].relativeMatrix
      );
      loopReports.push({
        residualBeforeDeg: retainedEdges[i].initialResidualDeg,
        residualAfterDeg: basisRotationErrorDeg(
          bases[retainedEdges[i].to],
          closurePrediction
        ),
        appliedToEndDeg: basisRotationErrorDeg(
          initialBases[retainedEdges[i].from],
          bases[retainedEdges[i].from]
        ),
        confidence: retainedEdges[i].confidence,
        closureEdgeIndex: retainedEdges[i].index
      });
    }
    ignoredEdges.sort(function (a, b) { return a - b; });
    var maxResidualAfter = 0;
    var meanResidualAfter = 0;
    var finalResiduals = [];
    for (i = 0; i < retainedEdges.length; i += 1) {
      var finalPrediction = applyRelativeBasis(
        bases[retainedEdges[i].from],
        retainedEdges[i].relativeMatrix
      );
      var retainedResidual = basisRotationErrorDeg(
        bases[retainedEdges[i].to],
        finalPrediction
      );
      finalResiduals.push(retainedResidual);
      meanResidualAfter += retainedResidual;
      maxResidualAfter = Math.max(maxResidualAfter, retainedResidual);
    }
    if (finalResiduals.length) {
      meanResidualAfter /= finalResiduals.length;
    }
    var initialResidualMean = 0;
    for (i = 0; i < retainedEdges.length; i += 1) {
      initialResidualMean += retainedEdges[i].initialResidualDeg;
    }
    if (retainedEdges.length) initialResidualMean /= retainedEdges.length;
    return {
      bases: bases,
      acceptedEdges: acceptedEdges,
      ignoredEdges: ignoredEdges,
      rejectedEdges: rejectedEdges,
      loops: loopReports,
      iterations: solvedResult.iterations,
      residualBeforeMeanDeg: initialResidualMean,
      residualAfterMeanDeg: meanResidualAfter,
      residualAfterMaxDeg: maxResidualAfter,
      method: "robust-global-so3-relative-pose-graph"
    };
  }

  function releaseFrameResources(frame) {
    if (!frame) return 0;
    var releasedBytes = 0;
    var pixels = framePixelData(frame);
    if (pixels && typeof pixels.byteLength === "number") releasedBytes += pixels.byteLength;
    var closables = [frame.bitmap, frame.imageBitmap];
    var i;
    for (i = 0; i < closables.length; i += 1) {
      if (closables[i] && typeof closables[i].close === "function") {
        try { closables[i].close(); } catch (ignore) {}
      }
    }
    frame.bitmap = null;
    frame.imageBitmap = null;
    frame.pixels = null;
    frame.srcPixels = null;
    if (frame.data && typeof frame.data.length === "number") frame.data = null;
    if (frame.imageData && frame.imageData.data) frame.imageData = null;
    return releasedBytes;
  }

  function projectFrame(raster, frame, options) {
    options = options || {};
    var pixels = framePixelData(frame);
    if (!pixels) return 0;
    var basis = frame.correctedBasis || frame.basis;
    if (!basis || !basis.F || !basis.U || !basis.R) return 0;
    var patchOptions = {
      fovXDeg: frame.correctedFovXDeg || frame.fovXDeg ||
        options.fovXDeg || 65,
      feather: options.feather,
      gain: frame.gain == null ? options.gain : frame.gain,
      bias: frame.bias == null ? options.bias : frame.bias,
      bilinear: options.bilinear,
      frameIndex: options.frameIndex,
      sourceConfidence: options.sourceConfidence,
      agreeThreshold: options.agreeThreshold,
      seamGridWidth: options.seamGridWidth,
      seamGridHeight: options.seamGridHeight,
      seamIterations: options.seamIterations,
      seamHysteresis: options.seamHysteresis,
      seamCenterWeight: options.seamCenterWeight,
      seamSmoothBase: options.seamSmoothBase,
      seamConflictWeight: options.seamConflictWeight,
      localWarp: options.localWarp,
      warpGridCols: options.warpGridCols,
      warpGridRows: options.warpGridRows
    };
    var projector = options.seamAware === true ?
      projectPatchSeamAware : projectPatch;
    var written = projector(
      raster,
      pixels,
      frame.width,
      frame.height,
      basis,
      patchOptions
    );
    if (options.releaseAfterProject === true) releaseFrameResources(frame);
    return written;
  }

  /*
   * 新调用方的默认低内存 2D 管线：只消费 accepted !== false 的帧，投影后
   * 默认释放 RGBA/ImageBitmap。旧 createRaster/projectPatch 完全不受影响。
   */
  function stitchFrames2D(frames, width, height, options) {
    options = options || {};
    frames = frames || [];
    var raster = createRaster(width, height);
    var acceptedCount = 0;
    var rejectedCount = 0;
    var writtenPixels = 0;
    var i;
    for (i = 0; i < frames.length; i += 1) {
      if (frames[i].accepted === false) {
        rejectedCount += 1;
        if (options.releaseRejected !== false) releaseFrameResources(frames[i]);
        continue;
      }
      writtenPixels += projectFrame(raster, frames[i], {
        fovXDeg: options.fovXDeg,
        feather: options.feather,
        gain: options.gain,
        bias: options.bias,
        seamAware: options.seamAware === true,
        frameIndex: i,
        sourceConfidence: frames[i].alignmentConfidence,
        localWarp: options.localWarp,
        warpGridCols: options.warpGridCols,
        warpGridRows: options.warpGridRows,
        agreeThreshold: options.agreeThreshold,
        seamGridWidth: options.seamGridWidth,
        seamGridHeight: options.seamGridHeight,
        seamIterations: options.seamIterations,
        releaseAfterProject: options.releaseAfterProject !== false
      });
      acceptedCount += 1;
    }
    return {
      raster: raster,
      stats: rasterStats(raster),
      acceptedCount: acceptedCount,
      rejectedCount: rejectedCount,
      writtenPixels: writtenPixels
    };
  }

  function copyBasis(basis) {
    return {
      F: basis.F.slice(),
      U: basis.U.slice(),
      R: basis.R.slice(),
      rollDeg: Number(basis.rollDeg) || 0
    };
  }

  return {
    WORLD_UP: WORLD_UP,
    clamp: clamp,
    centerCropRect: centerCropRect,
    wrapDeg: wrapDeg,
    shortestDelta: shortestDelta,
    dot: dot,
    cross: cross,
    normalize: normalize,
    angleDeg: angleDeg,
    headingDeg: headingDeg,
    rotateAroundAxis: rotateAroundAxis,
    rotateBasisZ: rotateBasisZ,
    rotateBasisLocal: rotateBasisLocal,
    orthonormalBasis: orthonormalBasis,
    basisFromDeviceOrientation: basisFromDeviceOrientation,
    basisFromDeviceMotionRadians: basisFromDeviceMotionRadians,
    rebaseHeading: rebaseHeading,
    smoothBasis: smoothBasis,
    directionFromYawPitch: directionFromYawPitch,
    yawPitchFromDirection: yawPitchFromDirection,
    createTargets: createTargets,
    projectDirection: projectDirection,
    directionFromImagePoint: directionFromImagePoint,
    imagePointFromDirection: imagePointFromDirection,
    basisRotationErrorDeg: basisRotationErrorDeg,
    createRaster: createRaster,
    projectPatch: projectPatch,
    projectPatchSeamAware: projectPatchSeamAware,
    compositeProjectedLayerSeamAware: compositeProjectedLayerSeamAware,
    estimateProjectedResidualWarp: estimateProjectedResidualWarp,
    sampleProjectedLayer: sampleProjectedLayer,
    projectFrame: projectFrame,
    stitchFrames2D: stitchFrames2D,
    rasterStats: rasterStats,
    measureFrameQuality: measureFrameQuality,
    refineFramePose: refineFramePose,
    refineFramePoseFromReferences: refineFramePoseFromReferences,
    rotationDelta: rotationDelta,
    rotateBasisWorld: rotateBasisWorld,
    blendBasis: blendBasis,
    optimizeFrameSequence: optimizeFrameSequence,
    releaseFrameResources: releaseFrameResources,
    copyBasis: copyBasis
  };
});
