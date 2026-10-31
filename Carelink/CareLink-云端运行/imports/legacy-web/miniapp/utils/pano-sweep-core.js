/*
 * UNSEEN 横向视频扫拍共享内核。
 *
 * 这不是录像器，也不是球面 2:1 拼接器。调用端从相机视频流按节奏送入
 * RGBA 帧，本内核用 IMU + 小图视觉位移挑选关键帧，并把每张关键帧的
 * 中心条带写进单张柱面画布。高频内容永远只有一个 owner；接缝附近只
 * 校正缓慢变化的 RGB 增益/偏置，避免“重影”和透明叠加。
 *
 * 坐标约定：
 *   yawDeg 增大代表镜头向右旋转，pitchDeg 增大代表镜头向上；
 *   rollDeg 是相对画面水平的滚转角。输出从扫拍起点左侧半个 FOV 开始。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PanoSweepCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var DEG = Math.PI / 180;
  var RAD = 180 / Math.PI;

  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
  }

  function finite(value, fallback) {
    value = Number(value);
    return isFinite(value) ? value : fallback;
  }

  function shortestDelta(fromDeg, toDeg) {
    return ((toDeg - fromDeg) % 360 + 540) % 360 - 180;
  }

  function median(values) {
    if (!values.length) return 0;
    values.sort(function (a, b) { return a - b; });
    var middle = values.length >> 1;
    return values.length % 2
      ? values[middle]
      : (values[middle - 1] + values[middle]) * 0.5;
  }

  function percentile(values, fraction) {
    if (!values.length) return 0;
    values.sort(function (a, b) { return a - b; });
    return values[Math.min(
      values.length - 1,
      Math.max(0, Math.floor((values.length - 1) * fraction))
    )];
  }

  function copyRgba(rgba, expectedLength) {
    if (!rgba || rgba.length < expectedLength) return null;
    var copy = new Uint8ClampedArray(expectedLength);
    if (rgba.subarray) copy.set(rgba.subarray(0, expectedLength));
    else {
      for (var i = 0; i < expectedLength; i += 1) copy[i] = rgba[i] || 0;
    }
    return copy;
  }

  function makeLumaThumbnail(rgba, width, height, options) {
    options = options || {};
    width = Math.max(1, Math.floor(finite(width, 1)));
    height = Math.max(1, Math.floor(finite(height, 1)));
    var requestedWidth = clamp(
      Math.floor(finite(options.width, options.thumbnailWidth || 64)),
      16,
      128
    );
    var requestedHeight = options.height || options.thumbnailHeight;
    var thumbWidth = Math.min(width, requestedWidth);
    var thumbHeight = requestedHeight
      ? Math.min(height, clamp(Math.floor(requestedHeight), 12, 96))
      : Math.max(12, Math.min(96, Math.round(thumbWidth * height / width)));
    var data = new Uint8Array(thumbWidth * thumbHeight);
    var scaleX = width / thumbWidth;
    var scaleY = height / thumbHeight;
    var y;
    var x;
    var sx;
    var sy;
    var sx1;
    var sy1;
    var tx;
    var ty;
    var index;
    var source00;
    var source10;
    var source01;
    var source11;

    /*
     * A bilinear 2x2 sample avoids nearest-neighbour phase bias. That bias is
     * small visually but can shift a subpixel flow estimate by 0.15–0.25 px,
     * enough to mis-estimate the camera FOV and create a stair at every seam.
     */
    for (y = 0; y < thumbHeight; y += 1) {
      var sourceY = (y + 0.5) * scaleY - 0.5;
      sy = clamp(Math.floor(sourceY), 0, height - 1);
      sy1 = Math.min(height - 1, sy + 1);
      ty = clamp(sourceY - sy, 0, 1);
      for (x = 0; x < thumbWidth; x += 1) {
        var sourceX = (x + 0.5) * scaleX - 0.5;
        sx = clamp(Math.floor(sourceX), 0, width - 1);
        sx1 = Math.min(width - 1, sx + 1);
        tx = clamp(sourceX - sx, 0, 1);
        source00 = (sy * width + sx) * 4;
        source10 = (sy * width + sx1) * 4;
        source01 = (sy1 * width + sx) * 4;
        source11 = (sy1 * width + sx1) * 4;
        index = y * thumbWidth + x;
        var luma00 = (finite(rgba[source00], 0) * 77 +
          finite(rgba[source00 + 1], 0) * 150 +
          finite(rgba[source00 + 2], 0) * 29) / 256;
        var luma10 = (finite(rgba[source10], 0) * 77 +
          finite(rgba[source10 + 1], 0) * 150 +
          finite(rgba[source10 + 2], 0) * 29) / 256;
        var luma01 = (finite(rgba[source01], 0) * 77 +
          finite(rgba[source01 + 1], 0) * 150 +
          finite(rgba[source01 + 2], 0) * 29) / 256;
        var luma11 = (finite(rgba[source11], 0) * 77 +
          finite(rgba[source11 + 1], 0) * 150 +
          finite(rgba[source11 + 2], 0) * 29) / 256;
        var top = luma00 * (1 - tx) + luma10 * tx;
        var bottom = luma01 * (1 - tx) + luma11 * tx;
        data[index] = clamp(Math.round(
          top * (1 - ty) + bottom * ty
        ), 0, 255);
      }
    }

    return {
      data: data,
      width: thumbWidth,
      height: thumbHeight,
      sourceWidth: width,
      sourceHeight: height,
      scaleX: scaleX,
      scaleY: scaleY
    };
  }

  function patchSad(previous, current, x, y, dx, dy, radius) {
    var sum = 0;
    var count = 0;
    var yy;
    var xx;
    var a;
    var b;
    for (yy = -radius; yy <= radius; yy += 1) {
      for (xx = -radius; xx <= radius; xx += 1) {
        a = previous.data[(y + yy) * previous.width + x + xx];
        b = current.data[(y + dy + yy) * current.width + x + dx + xx];
        sum += Math.abs(a - b);
        count += 1;
      }
    }
    return count ? sum / count : 255;
  }

  /*
   * Grid block matching on luma thumbnails. dx/dy describe where a feature
   * from prev appears in curr. Thus a rightward camera pan normally produces
   * negative dx (the scene slides left).
   */
  function estimateGridFlow(previous, current, options) {
    options = options || {};
    if (!previous || !current ||
        !previous.data || !current.data ||
        previous.width !== current.width ||
        previous.height !== current.height) {
      return { dx: 0, dy: 0, confidence: 0, inliers: 0, samples: 0 };
    }

    var width = previous.width;
    var height = previous.height;
    var radius = clamp(Math.floor(finite(options.patchRadius, 2)), 1, 4);
    var search = clamp(Math.floor(finite(options.searchRadius, 6)), 2, 12);
    var gridX = clamp(Math.floor(finite(options.gridX, 6)), 3, 10);
    var gridY = clamp(Math.floor(finite(options.gridY, 4)), 2, 8);
    var margin = radius + search + 1;
    if (width <= margin * 2 || height <= margin * 2) {
      return { dx: 0, dy: 0, confidence: 0, inliers: 0, samples: 0 };
    }

    var flows = [];
    var gy;
    var gx;
    var x;
    var y;
    var dx;
    var dy;
    var score;
    var best;
    var second;
    var bestDx;
    var bestDy;
    var texture;
    var centreValue;
    var uniqueness;
    var scoreMinus;
    var scorePlus;
    var curvature;
    var subDx;
    var subDy;

    for (gy = 0; gy < gridY; gy += 1) {
      y = Math.round(margin + (height - margin * 2 - 1) *
        (gy + 0.5) / gridY);
      for (gx = 0; gx < gridX; gx += 1) {
        x = Math.round(margin + (width - margin * 2 - 1) *
          (gx + 0.5) / gridX);
        centreValue = previous.data[y * width + x];
        texture = 0;
        texture += Math.abs(centreValue - previous.data[y * width + x - radius]);
        texture += Math.abs(centreValue - previous.data[y * width + x + radius]);
        texture += Math.abs(centreValue - previous.data[(y - radius) * width + x]);
        texture += Math.abs(centreValue - previous.data[(y + radius) * width + x]);
        if (texture < 10) continue;

        best = Infinity;
        second = Infinity;
        bestDx = 0;
        bestDy = 0;
        for (dy = -search; dy <= search; dy += 1) {
          for (dx = -search; dx <= search; dx += 1) {
            score = patchSad(previous, current, x, y, dx, dy, radius);
            if (score < best) {
              second = best;
              best = score;
              bestDx = dx;
              bestDy = dy;
            } else if (score < second) {
              second = score;
            }
          }
        }
        uniqueness = second < Infinity
          ? clamp((second - best) / Math.max(2, second), 0, 1)
          : 0;
        /*
         * The integer block match is only a coarse location. Refine each axis
         * with the three-point parabola around the minimum; without this,
         * a 96 px thumbnail quantises a 50° field of view to about 0.52° and
         * that is enough to show as a one-pixel stair-step at every strip.
         */
        subDx = bestDx;
        subDy = bestDy;
        if (bestDx > -search && bestDx < search) {
          scoreMinus = patchSad(
            previous, current, x, y, bestDx - 1, bestDy, radius
          );
          scorePlus = patchSad(
            previous, current, x, y, bestDx + 1, bestDy, radius
          );
          curvature = scoreMinus - 2 * best + scorePlus;
          if (curvature > 1e-4) {
            subDx += clamp(
              0.5 * (scoreMinus - scorePlus) / curvature,
              -0.5,
              0.5
            );
          }
        }
        if (bestDy > -search && bestDy < search) {
          scoreMinus = patchSad(
            previous, current, x, y, bestDx, bestDy - 1, radius
          );
          scorePlus = patchSad(
            previous, current, x, y, bestDx, bestDy + 1, radius
          );
          curvature = scoreMinus - 2 * best + scorePlus;
          if (curvature > 1e-4) {
            subDy += clamp(
              0.5 * (scoreMinus - scorePlus) / curvature,
              -0.5,
              0.5
            );
          }
        }
        flows.push({
          dx: subDx,
          dy: subDy,
          x: x,
          y: y,
          score: best,
          quality: clamp(texture / 90, 0, 1) *
            clamp(1 - best / 42, 0, 1) *
            (0.35 + uniqueness * 0.65)
        });
      }
    }

    if (!flows.length) {
      return { dx: 0, dy: 0, confidence: 0, inliers: 0, samples: 0 };
    }

    var medianDx = median(flows.map(function (item) { return item.dx; }));
    var medianDy = median(flows.map(function (item) { return item.dy; }));
    var deviations = flows.map(function (item) {
      return Math.abs(item.dx - medianDx) + Math.abs(item.dy - medianDy);
    });
    var mad = median(deviations);
    var tolerance = Math.max(1, mad * 2.5);
    var inliers = flows.filter(function (item) {
      return Math.abs(item.dx - medianDx) +
        Math.abs(item.dy - medianDy) <= tolerance;
    });
    var dxValues = inliers.map(function (item) { return item.dx; });
    var dyValues = inliers.map(function (item) { return item.dy; });
    var qualityValues = inliers.map(function (item) { return item.quality; });
    var inlierRatio = inliers.length / flows.length;
    /*
     * A yaw rotation is not a uniform translation in a rectilinear image.
     * Blocks near the left/right edges move slightly farther than the optical
     * centre and would bias an FOV estimate low. Keep a central estimate for
     * calibration while retaining the full-grid median for robust gating.
     */
    var centralInliers = inliers.filter(function (item) {
      return Math.abs(item.x - width * 0.5) <= width * 0.18;
    });

    return {
      dx: median(dxValues),
      dy: median(dyValues),
      centralDx: centralInliers.length >= 2
        ? median(centralInliers.map(function (item) { return item.dx; }))
        : median(dxValues),
      centralDy: centralInliers.length >= 2
        ? median(centralInliers.map(function (item) { return item.dy; }))
        : median(dyValues),
      centralInliers: centralInliers.length,
      thumbnailWidth: width,
      rotationSamples: inliers.map(function (item) {
        return { x: item.x, dx: item.dx, dy: item.dy };
      }),
      confidence: clamp(
        inlierRatio * 0.65 + median(qualityValues) * 0.35,
        0,
        1
      ),
      inliers: inliers.length,
      samples: flows.length,
      mad: mad,
      p90Residual: percentile(deviations, 0.9)
    };
  }

  function createSweepSession(options) {
    options = options || {};
    var requestedSpan = finite(options.targetSpanDeg, 120);
    var maximumSpan = clamp(finite(options.maxSpanDeg, 180), 45, 180);
    var session = {
      options: {
        targetSpanDeg: clamp(requestedSpan, 45, maximumSpan),
        minSpanDeg: clamp(finite(options.minSpanDeg, 45), 20, 180),
        maxSpanDeg: maximumSpan,
        fovXDeg: clamp(finite(options.fovXDeg, 65), 35, 95),
        directionLockDeg: clamp(finite(options.directionLockDeg, 5), 4, 6),
        reverseToleranceDeg: clamp(finite(options.reverseToleranceDeg, 2), 1, 5),
        maxSpeedDegPerSec: clamp(finite(options.maxSpeedDegPerSec, 24), 8, 60),
        maxPitchDriftDeg: clamp(finite(options.maxPitchDriftDeg, 8), 3, 15),
        maxRollDeg: clamp(finite(options.maxRollDeg, 12), 5, 25),
        keyframeStepDeg: clamp(finite(options.keyframeStepDeg, 6), 3, 12),
        outputHeight: clamp(Math.floor(finite(options.outputHeight, 512)), 96, 768),
        maxOutputWidth: clamp(
          Math.floor(finite(options.maxOutputWidth, 2048)),
          512,
          2048
        ),
        verticalCropFactor: clamp(finite(options.verticalCropFactor, 0.70), 0.5, 0.9),
        seamBandPx: clamp(Math.floor(finite(options.seamBandPx, 12)), 8, 16),
        thumbnailWidth: clamp(
          Math.floor(finite(options.thumbnailWidth, 64)),
          32,
          96
        ),
        diagnostics: options.diagnostics !== false,
        ownerMap: options.ownerMap === true
      },
      state: "waiting",
      direction: 0,
      startYawDeg: null,
      startPitchDeg: null,
      startRollDeg: null,
      lastObservation: null,
      fovReference: null,
      pending: null,
      firstKeyframe: null,
      frameWidth: 0,
      frameHeight: 0,
      raster: null,
      ownerMap: null,
      initialFovXDeg: clamp(finite(options.fovXDeg, 65), 35, 95),
      rasterFovXDeg: 0,
      ppd: 0,
      verticalTanExtent: 0,
      nextWriteX: 0,
      rowWriteX: null,
      acceptedCenters: [],
      maxProgressDeg: 0,
      lastProgressDeg: 0,
      fovCandidates: [],
      fovLocked: false,
      retainedFrames: 0,
      released: false,
      finalized: false,
      result: null,
      diagnostics: {
        inputFrames: 0,
        acceptedKeyframes: 0,
        rejectedFast: 0,
        rejectedReverse: 0,
        rejectedPitch: 0,
        rejectedRoll: 0,
        rejectedInvalid: 0,
        skippedSpacing: 0,
        directionLocks: 0,
        visualUses: 0,
        estimatedFovXDeg: 0,
        fovCandidateCount: 0,
        maxRetainedFrames: 0,
        seamJumps: [],
        seamPaths: [],
        contentAwareSeams: 0,
        seamMaxOffsetDeg: 0,
        decisions: []
      }
    };
    if (session.options.minSpanDeg > session.options.maxSpanDeg) {
      session.options.minSpanDeg = session.options.maxSpanDeg;
    }
    return session;
  }

  function setupRaster(session, width, height) {
    if (session.raster) return true;
    if (!(width > 0 && height > 0)) return false;
    session.frameWidth = width;
    session.frameHeight = height;

    var aspect = width / height;
    var tanX = Math.tan(session.options.fovXDeg * DEG * 0.5);
    var tanY = tanX / Math.max(0.2, aspect);
    var verticalTan = tanY * session.options.verticalCropFactor;
    /*
     * Never upscale the vertically cropped source. Upsampling a 202 px
     * effective camera strip to 443 px makes two perfectly aligned frames land
     * on different bilinear phases and creates a repeatable 1–3 px seam stair.
     */
    var nativeOutputHeightCap = Math.max(
      64,
      Math.floor(height * session.options.verticalCropFactor)
    );
    var requestedOutputHeight = Math.min(
      session.options.outputHeight,
      nativeOutputHeightCap
    );
    var focal = requestedOutputHeight / Math.max(0.05, verticalTan * 2);
    var totalMaxDeg = session.options.maxSpanDeg + session.options.fovXDeg;
    var widthAtFocal = Math.ceil(totalMaxDeg * DEG * focal);
    if (widthAtFocal > session.options.maxOutputWidth) {
      focal *= session.options.maxOutputWidth / widthAtFocal;
    }
    var outputHeight = clamp(
      Math.floor(verticalTan * 2 * focal),
      64,
      requestedOutputHeight
    );
    var outputWidth = Math.min(
      session.options.maxOutputWidth,
      Math.ceil(totalMaxDeg * DEG * focal) + 2
    );

    session.ppd = focal * DEG;
    session.verticalTanExtent = verticalTan;
    session.rasterFovXDeg = session.options.fovXDeg;
    session.raster = {
      width: outputWidth,
      height: outputHeight,
      pixels: new Uint8ClampedArray(outputWidth * outputHeight * 4),
      covered: new Uint8Array(outputWidth * outputHeight)
    };
    session.rowWriteX = new Int32Array(outputHeight);
    session.ownerMap = session.options.ownerMap
      ? new Int16Array(outputWidth * outputHeight)
      : null;
    if (session.ownerMap) session.ownerMap.fill(-1);
    return true;
  }

  function rebuildEmptyRasterForFov(session) {
    if (!session.raster || session.nextWriteX !== 0 ||
        Math.abs(session.rasterFovXDeg - session.options.fovXDeg) < 0.05) {
      return;
    }
    session.raster.pixels = null;
    session.raster.covered = null;
    session.raster = null;
    session.ownerMap = null;
    session.rowWriteX = null;
    session.rasterFovXDeg = 0;
    setupRaster(session, session.frameWidth, session.frameHeight);
  }

  function rollDelta(reference, current) {
    return shortestDelta(reference, current);
  }

  function fitRectilinearFov(flow, signedDeltaDeg) {
    var samples = flow && flow.rotationSamples;
    var width = finite(flow && flow.thumbnailWidth, 0);
    if (!samples || samples.length < 4 || !(width > 0) ||
        Math.abs(signedDeltaDeg) < 0.35) {
      return null;
    }
    var delta = signedDeltaDeg * DEG;
    var bestFov = 0;
    var bestError = Infinity;
    var fov;
    for (fov = 35; fov <= 95; fov += 0.25) {
      var tanHalf = Math.tan(fov * DEG * 0.5);
      var errors = [];
      for (var i = 0; i < samples.length; i += 1) {
        var sample = samples[i];
        if (Math.abs(finite(sample.dy, 0)) >
            Math.max(3, Math.abs(finite(sample.dx, 0)) * 0.75)) {
          continue;
        }
        var q0 = ((sample.x + 0.5) / width) * 2 - 1;
        var q1 = ((sample.x + sample.dx + 0.5) / width) * 2 - 1;
        var predicted = Math.tan(Math.atan(q0 * tanHalf) - delta) /
          tanHalf;
        if (isFinite(predicted)) {
          errors.push(Math.abs(predicted - q1) * width * 0.5);
        }
      }
      if (errors.length < 4) continue;
      var error = median(errors);
      if (error < bestError) {
        bestError = error;
        bestFov = fov;
      }
    }
    return bestFov >= 35 && bestFov <= 95 && bestError <= 1.35
      ? { fovDeg: bestFov, residualPx: bestError }
      : null;
  }

  function updateFovEstimate(session, previous, rawYaw, flow) {
    if (!previous || session.fovLocked || !flow ||
        finite(flow.confidence, 0) < 0.55) return false;
    var signedImuDeltaDeg = rawYaw - previous.rawYawDeg;
    var imuDeltaDeg = Math.abs(signedImuDeltaDeg);
    var horizontalShift = Math.abs(finite(
      flow.centralInliers >= 2 ? flow.centralDx : flow.dx,
      0
    ));
    var thumbnailWidth = previous.thumbnail && previous.thumbnail.width;
    if (!(thumbnailWidth > 0) || imuDeltaDeg < 0.35 || imuDeltaDeg > 4.5 ||
        horizontalShift < 0.55 ||
        Math.abs(finite(flow.dy, 0)) > Math.max(3, horizontalShift * 0.75)) {
      return false;
    }
    /*
     * Near the optical centre of a rectilinear image:
     *   shift/width ≈ tan(deltaYaw) / (2*tan(fov/2)).
     * Solve for fov and robustly combine several small preview motions.
     */
    var fitted = fitRectilinearFov(flow, signedImuDeltaDeg);
    var shiftRatio = horizontalShift / thumbnailWidth;
    var candidate = fitted
      ? fitted.fovDeg
      : 2 * Math.atan(
        Math.tan(imuDeltaDeg * DEG) / Math.max(1e-5, 2 * shiftRatio)
      ) * RAD;
    if (!isFinite(candidate) || candidate < 35 || candidate > 95) return false;
    session.fovCandidates.push(candidate);
    if (session.fovCandidates.length > 12) session.fovCandidates.shift();
    session.diagnostics.fovCandidateCount = session.fovCandidates.length;
    if (session.fovCandidates.length < 3) return true;
    var estimate = median(session.fovCandidates.slice());
    /*
     * Block-flow calibration has roughly ±2° uncertainty on a 96 px
     * thumbnail. Keep a trustworthy caller/intrinsics prior inside that
     * deadband; only make a scale correction when the evidence is material.
     */
    session.options.fovXDeg = Math.abs(
      estimate - session.initialFovXDeg
    ) < 2.75
      ? session.initialFovXDeg
      : clamp(estimate, 35, 95);
    session.diagnostics.estimatedFovXDeg = session.options.fovXDeg;
    return true;
  }

  function makeObservation(session, frame, thumbnail, rawYaw) {
    var previous = session.lastObservation;
    var flow = null;
    var suppliedFlow = frame.flow || {};
    var visualDx = finite(
      frame.visualDx,
      finite(suppliedFlow.dx, NaN)
    );
    var visualDy = finite(
      frame.visualDy,
      finite(suppliedFlow.dy, NaN)
    );
    var visualConfidence = clamp(finite(
      frame.confidence,
      finite(suppliedFlow.confidence, NaN)
    ), 0, 1);
    if (!isFinite(visualDx) || !isFinite(visualConfidence)) {
      flow = estimateGridFlow(previous && previous.thumbnail, thumbnail, {});
      visualDx = flow.dx;
      visualDy = flow.dy;
      visualConfidence = flow.confidence;
    }
    var measuredFlow = flow ||
      (isFinite(Number(suppliedFlow.dx)) ? suppliedFlow : {
        dx: visualDx,
        dy: visualDy,
        confidence: visualConfidence
      });
    if (!session.fovReference) {
      session.fovReference = {
        thumbnail: thumbnail,
        rawYawDeg: rawYaw,
        fusedYawDeg: rawYaw,
        rawPitchDeg: finite(frame.pitchDeg, 0),
        fusedPitchDeg: finite(frame.pitchDeg, 0),
        timeMs: finite(frame.timeMs, 0)
      };
    }
    var referenceDelta = rawYaw - session.fovReference.rawYawDeg;
    var referenceAccepted = false;
    if (previous && Math.abs(referenceDelta) >= 2 &&
        Math.abs(referenceDelta) <= 6.8) {
      /*
       * FOV is a scale estimate, so a 4–6° baseline is substantially less
       * sensitive to a 0.1 px block-match error than adjacent ~2° frames.
       * Keep only the tiny first thumbnail; no extra full RGBA is retained.
       */
      var referenceFlow = estimateGridFlow(
        session.fovReference.thumbnail,
        thumbnail,
        {
          gridX: 8,
          gridY: 5,
          searchRadius: 12,
          patchRadius: 3
        }
      );
      referenceAccepted = updateFovEstimate(
        session,
        session.fovReference,
        rawYaw,
        referenceFlow
      );
    }
    if (!referenceAccepted) {
      updateFovEstimate(session, previous, rawYaw, measuredFlow);
    }
    if (measuredFlow.centralInliers >= 2 &&
        isFinite(Number(measuredFlow.centralDx))) {
      visualDx = measuredFlow.centralDx;
      visualDy = finite(measuredFlow.centralDy, visualDy);
    }

    var fusedYaw = rawYaw;
    var rawPitch = finite(frame.pitchDeg, 0);
    var fusedPitch = rawPitch;
    if (previous) {
      var imuDelta = rawYaw - previous.rawYawDeg;
      var visualDelta = -visualDx /
        Math.max(1, thumbnail.width) * session.options.fovXDeg;
      var compatible = Math.abs(visualDelta - imuDelta) <=
        Math.max(2.5, Math.abs(imuDelta) * 1.5 + 1);
      var weight = compatible ? visualConfidence * 0.58 : visualConfidence * 0.12;
      weight = clamp(weight, 0, 0.58);
      /*
       * Visual flow is quantised to thumbnail pixels. Integrating that tiny
       * rounding error over dozens of preview frames produces several degrees
       * of false drift and visible strip steps. Treat flow as a leaky,
       * short-lived correction to the current IMU pose instead: it damps a
       * momentary gyro wobble, while the IMU continues to own global scale.
       */
      var previousCorrection = previous.fusedYawDeg - previous.rawYawDeg;
      var innovation = visualDelta - imuDelta;
      var correction = previousCorrection * 0.72 + innovation * weight;
      fusedYaw = rawYaw + clamp(correction, -1.5, 1.5);
      if (weight > 0.08) session.diagnostics.visualUses += 1;

    }

    return {
      thumbnail: thumbnail,
      rawYawDeg: rawYaw,
      fusedYawDeg: fusedYaw,
      rawPitchDeg: rawPitch,
      fusedPitchDeg: fusedPitch,
      timeMs: finite(frame.timeMs, previous ? previous.timeMs + 33 : 0),
      flow: flow || {
        dx: visualDx,
        dy: visualDy,
        confidence: visualConfidence
      },
      visualConfidence: visualConfidence
    };
  }

  function cameraBasis(frame) {
    var yaw = finite(frame.yawDeg, 0) * DEG;
    var pitch = finite(frame.pitchDeg, 0) * DEG;
    var roll = finite(frame.rollDeg, 0) * DEG;
    var cp = Math.cos(pitch);
    var sp = Math.sin(pitch);
    var forward = [Math.sin(yaw) * cp, Math.cos(yaw) * cp, sp];
    var right0 = [Math.cos(yaw), -Math.sin(yaw), 0];
    var up0 = [
      -Math.sin(yaw) * sp,
      -Math.cos(yaw) * sp,
      cp
    ];
    var cr = Math.cos(roll);
    var sr = Math.sin(roll);
    return {
      F: forward,
      R: [
        right0[0] * cr - up0[0] * sr,
        right0[1] * cr - up0[1] * sr,
        right0[2] * cr - up0[2] * sr
      ],
      U: [
        up0[0] * cr + right0[0] * sr,
        up0[1] * cr + right0[1] * sr,
        up0[2] * cr + right0[2] * sr
      ]
    };
  }

  function makeKeyframe(session, frame, progressDeg, observation) {
    var width = Math.floor(finite(frame.width, 0));
    var height = Math.floor(finite(frame.height, 0));
    var rgba = copyRgba(frame.rgba, width * height * 4);
    if (!rgba) return null;
    var keyframe = {
      index: session.diagnostics.acceptedKeyframes,
      rgba: rgba,
      width: width,
      height: height,
      yawDeg: finite(frame.yawDeg, 0),
      rawPitchDeg: finite(frame.pitchDeg, 0),
      pitchDeg: finite(observation.fusedPitchDeg, frame.pitchDeg),
      rollDeg: finite(frame.rollDeg, 0),
      timeMs: finite(frame.timeMs, 0),
      progressDeg: progressDeg,
      fusedYawDeg: observation.fusedYawDeg,
      gain: [1, 1, 1],
      leftBias: [0, 0, 0],
      rightBias: [0, 0, 0],
      leftBoundaryDeg: null,
      rightBoundaryDeg: null,
      confidence: observation.visualConfidence,
      basis: null
    };
    /*
     * The fused centre, rather than the noisy raw IMU centre, owns horizontal
     * placement. Pitch/roll still come directly from gravity.
     */
    keyframe.basis = cameraBasis({
      yawDeg: session.startYawDeg + session.direction * progressDeg,
      pitchDeg: keyframe.pitchDeg,
      rollDeg: keyframe.rollDeg
    });
    session.retainedFrames += 1;
    session.diagnostics.maxRetainedFrames = Math.max(
      session.diagnostics.maxRetainedFrames,
      session.retainedFrames
    );
    return keyframe;
  }

  function dot3(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }

  function sampleBilinear(frame, sx, sy, output) {
    if (sx < 0 || sy < 0 || sx > frame.width - 1 || sy > frame.height - 1) {
      return false;
    }
    var x0 = Math.floor(sx);
    var y0 = Math.floor(sy);
    var x1 = Math.min(frame.width - 1, x0 + 1);
    var y1 = Math.min(frame.height - 1, y0 + 1);
    var tx = sx - x0;
    var ty = sy - y0;
    var w00 = (1 - tx) * (1 - ty);
    var w10 = tx * (1 - ty);
    var w01 = (1 - tx) * ty;
    var w11 = tx * ty;
    var i00 = (y0 * frame.width + x0) * 4;
    var i10 = (y0 * frame.width + x1) * 4;
    var i01 = (y1 * frame.width + x0) * 4;
    var i11 = (y1 * frame.width + x1) * 4;
    output[0] = frame.rgba[i00] * w00 + frame.rgba[i10] * w10 +
      frame.rgba[i01] * w01 + frame.rgba[i11] * w11;
    output[1] = frame.rgba[i00 + 1] * w00 + frame.rgba[i10 + 1] * w10 +
      frame.rgba[i01 + 1] * w01 + frame.rgba[i11 + 1] * w11;
    output[2] = frame.rgba[i00 + 2] * w00 + frame.rgba[i10 + 2] * w10 +
      frame.rgba[i01 + 2] * w01 + frame.rgba[i11 + 2] * w11;
    return true;
  }

  function sampleWorld(session, frame, progressDeg, verticalTan, output) {
    var worldYaw = (
      session.startYawDeg + session.direction * progressDeg
    ) * DEG;
    var horizontalLength = 1 / Math.sqrt(1 + verticalTan * verticalTan);
    var direction = [
      Math.sin(worldYaw) * horizontalLength,
      Math.cos(worldYaw) * horizontalLength,
      verticalTan * horizontalLength
    ];
    var basis = frame.basis;
    var depth = dot3(direction, basis.F);
    if (depth <= 1e-5) return false;
    var tanX = Math.tan(session.options.fovXDeg * DEG * 0.5);
    var tanY = tanX / Math.max(0.2, frame.width / frame.height);
    var nx = dot3(direction, basis.R) / (depth * tanX);
    var ny = dot3(direction, basis.U) / (depth * tanY);
    if (Math.abs(nx) > 0.9995 || Math.abs(ny) > 0.9995) return false;
    return sampleBilinear(
      frame,
      (nx * 0.5 + 0.5) * (frame.width - 1),
      (0.5 - ny * 0.5) * (frame.height - 1),
      output
    );
  }

  function matchExposure(session, previous, current) {
    var overlapStart = Math.max(
      previous.progressDeg - session.options.fovXDeg * 0.45,
      current.progressDeg - session.options.fovXDeg * 0.45
    );
    var overlapEnd = Math.min(
      previous.progressDeg + session.options.fovXDeg * 0.45,
      current.progressDeg + session.options.fovXDeg * 0.45
    );
    var ratios = [[], [], []];
    var sampleA = [0, 0, 0];
    var sampleB = [0, 0, 0];
    var ix;
    var iy;
    var p;
    var v;
    var channel;
    if (overlapEnd <= overlapStart) {
      current.gain = previous.gain.slice();
      return;
    }

    for (ix = 0; ix < 11; ix += 1) {
      p = overlapStart + (overlapEnd - overlapStart) * (ix + 0.5) / 11;
      for (iy = 0; iy < 9; iy += 1) {
        v = session.verticalTanExtent * ((iy + 0.5) / 9 * 1.6 - 0.8);
        if (!sampleWorld(session, previous, p, v, sampleA) ||
            !sampleWorld(session, current, p, v, sampleB)) {
          continue;
        }
        for (channel = 0; channel < 3; channel += 1) {
          if (sampleA[channel] > 18 && sampleA[channel] < 244 &&
              sampleB[channel] > 18 && sampleB[channel] < 244) {
            ratios[channel].push(
              sampleA[channel] * previous.gain[channel] /
              Math.max(1, sampleB[channel])
            );
          }
        }
      }
    }

    for (channel = 0; channel < 3; channel += 1) {
      var target = ratios[channel].length >= 8
        ? median(ratios[channel])
        : previous.gain[channel];
      /*
       * Clamp both the per-frame change and total compensation. A moving
       * foreground object cannot drag the whole panorama's exposure.
       */
      target = clamp(
        target,
        previous.gain[channel] * 0.86,
        previous.gain[channel] * 1.16
      );
      current.gain[channel] = clamp(
        previous.gain[channel] * 0.25 + target * 0.75,
        0.62,
        1.55
      );
    }
  }

  function computeBoundaryBias(session, previous, current, boundaryDeg) {
    var differences = [[], [], []];
    var a = [0, 0, 0];
    var b = [0, 0, 0];
    var i;
    var vertical;
    var channel;
    for (i = 0; i < 17; i += 1) {
      vertical = session.verticalTanExtent * ((i + 0.5) / 17 * 1.7 - 0.85);
      if (!sampleWorld(session, previous, boundaryDeg, vertical, a) ||
          !sampleWorld(session, current, boundaryDeg, vertical, b)) {
        continue;
      }
      for (channel = 0; channel < 3; channel += 1) {
        differences[channel].push(
          b[channel] * current.gain[channel] -
          a[channel] * previous.gain[channel]
        );
      }
    }
    var jump = [0, 0, 0];
    for (channel = 0; channel < 3; channel += 1) {
      jump[channel] = clamp(median(differences[channel]), -28, 28);
      previous.rightBias[channel] = jump[channel] * 0.5;
      current.leftBias[channel] = -jump[channel] * 0.5;
    }
    session.diagnostics.seamJumps.push({
      atDeg: boundaryDeg,
      rgb: jump.slice(),
      luma: Math.abs(jump[0] * 0.299 +
        jump[1] * 0.587 + jump[2] * 0.114)
    });
  }

  function luma(rgb) {
    return rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114;
  }

  /*
   * Find a low-cost seam through the overlap instead of cutting every pair at
   * one fixed vertical midpoint. The dynamic programme runs on a small number
   * of vertical control rows and penalises both inter-frame disagreement and
   * strong local edges. A smooth path is then interpolated to raster rows.
   *
   * This keeps high-frequency detail single-owner (so no ghost double edges)
   * while letting the cut bend around a moving person or a high-contrast pole.
   */
  function chooseContentAwareBoundary(session, previous, current, midpointDeg) {
    var gap = Math.max(0.5, current.progressDeg - previous.progressDeg);
    var overlapStart = Math.max(
      previous.progressDeg - session.options.fovXDeg * 0.44,
      current.progressDeg - session.options.fovXDeg * 0.44
    );
    var overlapEnd = Math.min(
      previous.progressDeg + session.options.fovXDeg * 0.44,
      current.progressDeg + session.options.fovXDeg * 0.44
    );
    var overlapWidth = Math.max(0, overlapEnd - overlapStart);
    var radius = Math.min(
      2.8,
      gap * 0.38,
      Math.max(0.45, overlapWidth * 0.18)
    );
    var low = Math.max(overlapStart + 0.35, midpointDeg - radius);
    var high = Math.min(overlapEnd - 0.35, midpointDeg + radius);
    if (!(high > low + 0.2) || !session.raster) {
      return {
        centerDeg: midpointDeg,
        byRow: null,
        maxOffsetDeg: 0
      };
    }

    var candidateCount = clamp(
      Math.round((high - low) * Math.max(2.5, session.ppd * 0.72)) + 1,
      9,
      31
    );
    var controlCount = clamp(
      Math.round(session.raster.height / 7),
      24,
      56
    );
    var stepDeg = (high - low) / Math.max(1, candidateCount - 1);
    var probeDeg = Math.max(0.12, 1 / Math.max(1, session.ppd));
    var previousCost = new Float64Array(candidateCount);
    var currentCost = new Float64Array(candidateCount);
    var parents = [];
    var a = [0, 0, 0];
    var b = [0, 0, 0];
    var aLeft = [0, 0, 0];
    var aRight = [0, 0, 0];
    var bLeft = [0, 0, 0];
    var bRight = [0, 0, 0];
    var row;
    var candidate;
    var prior;

    function dataCost(vertical, seamDeg) {
      if (!sampleWorld(session, previous, seamDeg, vertical, a) ||
          !sampleWorld(session, current, seamDeg, vertical, b)) {
        return 10000;
      }
      var ar = a[0] * previous.gain[0];
      var ag = a[1] * previous.gain[1];
      var ab = a[2] * previous.gain[2];
      var br = b[0] * current.gain[0];
      var bg = b[1] * current.gain[1];
      var bb = b[2] * current.gain[2];
      var disagreement = Math.abs(ar - br) * 0.299 +
        Math.abs(ag - bg) * 0.587 +
        Math.abs(ab - bb) * 0.114;
      var texture = 0;
      if (sampleWorld(session, previous, seamDeg - probeDeg, vertical, aLeft) &&
          sampleWorld(session, previous, seamDeg + probeDeg, vertical, aRight)) {
        texture += Math.abs(luma(aRight) - luma(aLeft));
      }
      if (sampleWorld(session, current, seamDeg - probeDeg, vertical, bLeft) &&
          sampleWorld(session, current, seamDeg + probeDeg, vertical, bRight)) {
        texture += Math.abs(luma(bRight) - luma(bLeft));
      }
      return Math.min(160, disagreement) +
        Math.min(90, texture) * 0.16 +
        Math.abs(seamDeg - midpointDeg) * 0.32;
    }

    for (row = 0; row < controlCount; row += 1) {
      var vertical = session.verticalTanExtent *
        (1 - (row + 0.5) / controlCount * 2);
      var parentRow = new Int16Array(candidateCount);
      for (candidate = 0; candidate < candidateCount; candidate += 1) {
        var seamDeg = low + candidate * stepDeg;
        var ownCost = dataCost(vertical, seamDeg);
        if (row === 0) {
          currentCost[candidate] = ownCost;
          parentRow[candidate] = -1;
          continue;
        }
        var bestCost = Infinity;
        var bestParent = candidate;
        var from = Math.max(0, candidate - 3);
        var to = Math.min(candidateCount - 1, candidate + 3);
        for (prior = from; prior <= to; prior += 1) {
          var transition = Math.abs(prior - candidate) * stepDeg * 2.2;
          var proposed = previousCost[prior] + transition;
          if (proposed < bestCost) {
            bestCost = proposed;
            bestParent = prior;
          }
        }
        currentCost[candidate] = ownCost + bestCost;
        parentRow[candidate] = bestParent;
      }
      parents.push(parentRow);
      var swap = previousCost;
      previousCost = currentCost;
      currentCost = swap;
    }

    var best = 0;
    for (candidate = 1; candidate < candidateCount; candidate += 1) {
      if (previousCost[candidate] < previousCost[best]) best = candidate;
    }
    var controlPath = new Float64Array(controlCount);
    for (row = controlCount - 1; row >= 0; row -= 1) {
      controlPath[row] = low + best * stepDeg;
      if (row > 0) best = parents[row][best];
    }
    var byRow = new Float64Array(session.raster.height);
    var offsets = [];
    var maxOffset = 0;
    for (row = 0; row < byRow.length; row += 1) {
      var controlPosition = (row + 0.5) / byRow.length * controlCount - 0.5;
      var row0 = clamp(Math.floor(controlPosition), 0, controlCount - 1);
      var row1 = clamp(row0 + 1, 0, controlCount - 1);
      var mix = clamp(controlPosition - row0, 0, 1);
      byRow[row] = controlPath[row0] * (1 - mix) + controlPath[row1] * mix;
      var offset = byRow[row] - midpointDeg;
      offsets.push(offset);
      maxOffset = Math.max(maxOffset, Math.abs(offset));
    }
    var centerDeg = midpointDeg + median(offsets);
    session.diagnostics.contentAwareSeams += 1;
    session.diagnostics.seamMaxOffsetDeg = Math.max(
      session.diagnostics.seamMaxOffsetDeg,
      maxOffset
    );
    session.diagnostics.seamPaths.push({
      midpointDeg: midpointDeg,
      centerDeg: centerDeg,
      maxOffsetDeg: maxOffset
    });
    return {
      centerDeg: centerDeg,
      byRow: byRow,
      maxOffsetDeg: maxOffset
    };
  }

  function boundaryAtRow(boundary, row, height) {
    if (typeof boundary === "number") return boundary;
    if (boundary && boundary.byRow && boundary.byRow.length) {
      var sourceRow = clamp(
        Math.round((row + 0.5) / height * boundary.byRow.length - 0.5),
        0,
        boundary.byRow.length - 1
      );
      return boundary.byRow[sourceRow];
    }
    return finite(boundary && boundary.centerDeg, 0);
  }

  function commitKeyframe(session, frame, leftBoundaryDeg, rightBoundaryDeg) {
    var raster = session.raster;
    var ppd = session.ppd;
    var rowWriteX = session.rowWriteX;
    var rowEndX = new Int32Array(raster.height);
    var xStart = raster.width;
    var xEnd = 0;
    var row;
    for (row = 0; row < raster.height; row += 1) {
      var rightForRow = boundaryAtRow(
        rightBoundaryDeg,
        row,
        raster.height
      );
      rowEndX[row] = Math.min(
        raster.width,
        Math.max(rowWriteX[row], Math.round(
          (rightForRow + session.options.fovXDeg * 0.5) * ppd
        ))
      );
      xStart = Math.min(xStart, rowWriteX[row]);
      xEnd = Math.max(xEnd, rowEndX[row]);
    }
    var seamBandDeg = session.options.seamBandPx / Math.max(0.01, ppd);
    var sample = [0, 0, 0];
    var x;
    var y;
    var p;
    var vertical;
    var pixelIndex;
    var offset;
    var leftFactor;
    var rightFactor;
    var r;
    var g;
    var b;
    var coveredInColumn;

    frame.leftBoundaryDeg = leftBoundaryDeg;
    frame.rightBoundaryDeg = rightBoundaryDeg;
    for (x = xStart; x < xEnd; x += 1) {
      p = (x + 0.5) / ppd - session.options.fovXDeg * 0.5;
      coveredInColumn = false;
      for (y = 0; y < raster.height; y += 1) {
        if (x < rowWriteX[y] || x >= rowEndX[y]) continue;
        var leftForRow = boundaryAtRow(
          leftBoundaryDeg,
          y,
          raster.height
        );
        var rightForPixelRow = boundaryAtRow(
          rightBoundaryDeg,
          y,
          raster.height
        );
        leftFactor = leftForRow >
          -session.options.fovXDeg * 0.5 + 1e-6
          ? clamp(1 - (p - leftForRow) / seamBandDeg, 0, 1)
          : 0;
        rightFactor = clamp(
          1 - (rightForPixelRow - p) / seamBandDeg,
          0,
          1
        );
        vertical = session.verticalTanExtent *
          (1 - (y + 0.5) / raster.height * 2);
        if (!sampleWorld(session, frame, p, vertical, sample)) continue;
        pixelIndex = y * raster.width + x;
        offset = pixelIndex * 4;
        r = sample[0] * frame.gain[0] +
          frame.leftBias[0] * leftFactor +
          frame.rightBias[0] * rightFactor;
        g = sample[1] * frame.gain[1] +
          frame.leftBias[1] * leftFactor +
          frame.rightBias[1] * rightFactor;
        b = sample[2] * frame.gain[2] +
          frame.leftBias[2] * leftFactor +
          frame.rightBias[2] * rightFactor;
        raster.pixels[offset] = clamp(Math.round(r), 0, 255);
        raster.pixels[offset + 1] = clamp(Math.round(g), 0, 255);
        raster.pixels[offset + 2] = clamp(Math.round(b), 0, 255);
        raster.pixels[offset + 3] = 255;
        raster.covered[pixelIndex] = 1;
        if (session.ownerMap) session.ownerMap[pixelIndex] = frame.index;
        coveredInColumn = true;
      }
      /*
       * With the conservative vertical crop, a valid keyframe should always
       * contribute to every strip column. The flag is retained for diagnostics.
       */
      if (!coveredInColumn) {
        session.diagnostics.decisions.push({
          type: "empty_column",
          x: x,
          progressDeg: p
        });
      }
    }
    session.nextWriteX = 0;
    for (row = 0; row < raster.height; row += 1) {
      rowWriteX[row] = rowEndX[row];
      session.nextWriteX = Math.max(session.nextWriteX, rowWriteX[row]);
    }
  }

  function dropKeyframe(session, keyframe) {
    if (!keyframe || !keyframe.rgba) return;
    keyframe.rgba = null;
    keyframe.basis = null;
    session.retainedFrames = Math.max(0, session.retainedFrames - 1);
  }

  function rememberDecision(session, decision) {
    if (!session.options.diagnostics) return;
    session.diagnostics.decisions.push(decision);
    if (session.diagnostics.decisions.length > 80) {
      session.diagnostics.decisions.shift();
    }
  }

  function reject(session, reason, detail) {
    rememberDecision(session, {
      type: "reject",
      reason: reason,
      detail: detail || null,
      inputFrame: session.diagnostics.inputFrames
    });
    return {
      accepted: false,
      reason: reason,
      state: session.state,
      direction: session.direction,
      progressDeg: session.maxProgressDeg,
      retainedFrames: session.retainedFrames
    };
  }

  function ingestFrame(session, frame) {
    if (!session || session.released) {
      return { accepted: false, reason: "released" };
    }
    if (session.finalized) {
      return { accepted: false, reason: "finalized" };
    }
    frame = frame || {};
    session.diagnostics.inputFrames += 1;
    var width = Math.floor(finite(frame.width, 0));
    var height = Math.floor(finite(frame.height, 0));
    var inputRgba = frame.rgba || frame.buffer;
    if (typeof ArrayBuffer !== "undefined" &&
        inputRgba instanceof ArrayBuffer) {
      inputRgba = new Uint8ClampedArray(inputRgba);
    } else if (inputRgba && inputRgba.buffer &&
               !(inputRgba instanceof Uint8ClampedArray)) {
      inputRgba = new Uint8ClampedArray(
        inputRgba.buffer,
        inputRgba.byteOffset || 0,
        inputRgba.byteLength || inputRgba.length
      );
    }
    if (width < 8 || height < 8 || !inputRgba ||
        inputRgba.length < width * height * 4 ||
        !isFinite(Number(frame.yawDeg))) {
      session.diagnostics.rejectedInvalid += 1;
      return reject(session, "invalid_frame");
    }
    frame.rgba = inputRgba;
    if (!setupRaster(session, width, height) ||
        width !== session.frameWidth || height !== session.frameHeight) {
      session.diagnostics.rejectedInvalid += 1;
      return reject(session, "frame_size_changed");
    }

    var yaw = finite(frame.yawDeg, 0);
    var pitch = finite(frame.pitchDeg, 0);
    var roll = finite(frame.rollDeg, 0);
    var timeMs = finite(
      frame.timeMs,
      session.lastObservation ? session.lastObservation.timeMs + 33 : 0
    );
    if (session.startYawDeg === null) {
      session.startYawDeg = yaw;
      session.startPitchDeg = pitch;
      session.startRollDeg = roll;
    }

    var pitchDrift = pitch - session.startPitchDeg;
    if (Math.abs(pitchDrift) > session.options.maxPitchDriftDeg) {
      session.diagnostics.rejectedPitch += 1;
      return reject(session, "pitch_drift", { pitchDriftDeg: pitchDrift });
    }
    var relativeRoll = rollDelta(0, roll);
    if (Math.abs(relativeRoll) > session.options.maxRollDeg) {
      session.diagnostics.rejectedRoll += 1;
      return reject(session, "roll", { rollDeg: relativeRoll });
    }

    var rawYaw = yaw;
    if (session.lastObservation) {
      rawYaw = session.lastObservation.rawYawDeg +
        shortestDelta(session.lastObservation.rawYawDeg, yaw);
    }
    var thumbnail = makeLumaThumbnail(frame.rgba, width, height, {
      width: session.options.thumbnailWidth
    });
    var observation = makeObservation(session, frame, thumbnail, rawYaw);

    if (session.lastObservation) {
      var elapsed = Math.max(1, timeMs - session.lastObservation.timeMs);
      var speed = Math.abs(rawYaw - session.lastObservation.rawYawDeg) *
        1000 / elapsed;
      if (speed > session.options.maxSpeedDegPerSec) {
        session.diagnostics.rejectedFast += 1;
        /*
         * Keep time/yaw observation current so one fast frame cannot poison
         * every later speed measurement. It is never retained or committed.
         */
        session.lastObservation = observation;
        return reject(session, "too_fast", { speedDegPerSec: speed });
      }
    }

    session.lastObservation = observation;
    if (!session.pending) {
      session.pending = makeKeyframe(session, frame, 0, observation);
      if (!session.pending) {
        session.diagnostics.rejectedInvalid += 1;
        return reject(session, "invalid_pixels");
      }
      session.firstKeyframe = session.pending;
      session.diagnostics.acceptedKeyframes = 1;
      session.acceptedCenters.push(0);
      session.state = "locking_direction";
      rememberDecision(session, { type: "seed", progressDeg: 0 });
      return {
        accepted: true,
        keyframe: true,
        reason: "seed",
        state: session.state,
        progressDeg: 0,
        retainedFrames: session.retainedFrames
      };
    }

    var signedFromStart = observation.fusedYawDeg - session.startYawDeg;
    if (!session.direction) {
      if (Math.abs(signedFromStart) < session.options.directionLockDeg) {
        return {
          accepted: false,
          reason: "locking_direction",
          state: session.state,
          lockProgressDeg: Math.abs(signedFromStart),
          retainedFrames: session.retainedFrames
        };
      }
      session.direction = signedFromStart >= 0 ? 1 : -1;
      session.state = "sweeping";
      session.diagnostics.directionLocks += 1;
      rememberDecision(session, {
        type: "direction_lock",
        direction: session.direction,
        atDeg: Math.abs(signedFromStart)
      });
    }

    var progress = session.direction * signedFromStart;
    if (progress < session.maxProgressDeg - session.options.reverseToleranceDeg) {
      session.diagnostics.rejectedReverse += 1;
      return reject(session, "reverse", {
        progressDeg: progress,
        maximumDeg: session.maxProgressDeg
      });
    }
    var reachesTarget = progress >= session.options.targetSpanDeg -
      Math.min(1, session.options.keyframeStepDeg * 0.2);
    if (progress <= session.pending.progressDeg + session.options.keyframeStepDeg &&
        !reachesTarget) {
      session.diagnostics.skippedSpacing += 1;
      session.maxProgressDeg = Math.max(session.maxProgressDeg, progress);
      return {
        accepted: false,
        reason: "spacing",
        state: session.state,
        progressDeg: progress,
        retainedFrames: session.retainedFrames
      };
    }

    progress = Math.min(progress, session.options.maxSpanDeg);
    var current = makeKeyframe(session, frame, progress, observation);
    if (!current) {
      session.diagnostics.rejectedInvalid += 1;
      return reject(session, "invalid_pixels");
    }
    /*
     * At this point there are exactly two full RGBA frames. The previous one
     * is committed and released before this call returns.
     */
    session.fovLocked = true;
    if (!session.diagnostics.estimatedFovXDeg) {
      session.diagnostics.estimatedFovXDeg = session.options.fovXDeg;
    }
    rebuildEmptyRasterForFov(session);
    matchExposure(session, session.pending, current);
    var midpoint = (session.pending.progressDeg + current.progressDeg) * 0.5;
    var boundary = chooseContentAwareBoundary(
      session,
      session.pending,
      current,
      midpoint
    );
    computeBoundaryBias(
      session,
      session.pending,
      current,
      boundary.centerDeg
    );
    var leftBoundary = session.pending.index === 0
      ? -session.options.fovXDeg * 0.5
      : session.pending.leftBoundaryDeg;
    if (leftBoundary === null) {
      leftBoundary = session.pending.index === 0
        ? -session.options.fovXDeg * 0.5
        : (session.acceptedCenters[session.acceptedCenters.length - 2] +
           session.pending.progressDeg) * 0.5;
    }
    commitKeyframe(session, session.pending, leftBoundary, boundary);
    current.leftBoundaryDeg = boundary;
    dropKeyframe(session, session.pending);
    session.pending = current;
    session.diagnostics.acceptedKeyframes += 1;
    session.acceptedCenters.push(progress);
    session.maxProgressDeg = Math.max(session.maxProgressDeg, progress);
    session.lastProgressDeg = progress;
    if (reachesTarget) session.state = "ready";
    rememberDecision(session, {
      type: "keyframe",
      progressDeg: progress,
      frameIndex: current.index
    });
    return {
      accepted: true,
      keyframe: true,
      reason: reachesTarget
        ? "target_reached"
        : "keyframe",
      state: session.state,
      direction: session.direction,
      progressDeg: progress,
      targetSpanDeg: session.options.targetSpanDeg,
      retainedFrames: session.retainedFrames
    };
  }

  function analyzeCoverage(raster, width) {
    var total = width * raster.height;
    var covered = 0;
    var blackColumns = 0;
    var internalBlackColumns = 0;
    var seenCoveredColumn = false;
    var x;
    var y;
    var columnCovered;
    for (x = 0; x < width; x += 1) {
      columnCovered = false;
      for (y = 0; y < raster.height; y += 1) {
        if (raster.covered[y * raster.width + x]) {
          covered += 1;
          columnCovered = true;
        }
      }
      if (!columnCovered) {
        blackColumns += 1;
        if (seenCoveredColumn && x < width - 1) internalBlackColumns += 1;
      } else {
        seenCoveredColumn = true;
      }
    }
    return {
      coverage: total ? covered / total : 0,
      blackColumns: blackColumns,
      internalBlackColumns: internalBlackColumns
    };
  }

  function cropRaster(session, width) {
    var source = session.raster;
    var output = new Uint8ClampedArray(width * source.height * 4);
    var owners = session.ownerMap
      ? new Int16Array(width * source.height)
      : null;
    var y;
    var sourceOffset;
    var targetOffset;
    for (y = 0; y < source.height; y += 1) {
      sourceOffset = y * source.width * 4;
      targetOffset = y * width * 4;
      output.set(
        source.pixels.subarray(sourceOffset, sourceOffset + width * 4),
        targetOffset
      );
      if (owners) {
        owners.set(
          session.ownerMap.subarray(y * source.width, y * source.width + width),
          y * width
        );
      }
    }
    return { pixels: output, owners: owners };
  }

  function flipRasterHorizontal(pixels, owners, width, height) {
    var half = Math.floor(width / 2);
    var y;
    var x;
    var leftPixel;
    var rightPixel;
    var channel;
    var temporary;
    for (y = 0; y < height; y += 1) {
      for (x = 0; x < half; x += 1) {
        leftPixel = y * width + x;
        rightPixel = y * width + (width - 1 - x);
        for (channel = 0; channel < 4; channel += 1) {
          temporary = pixels[leftPixel * 4 + channel];
          pixels[leftPixel * 4 + channel] =
            pixels[rightPixel * 4 + channel];
          pixels[rightPixel * 4 + channel] = temporary;
        }
        if (owners) {
          temporary = owners[leftPixel];
          owners[leftPixel] = owners[rightPixel];
          owners[rightPixel] = temporary;
        }
      }
    }
  }

  function measureOwnedSeams(pixels, owners, width, height) {
    if (!owners) return { p50: 0, p95: 0, samples: 0 };
    var differences = [];
    for (var y = 1; y < height - 1; y += 1) {
      for (var x = 1; x < width; x += 1) {
        var index = y * width + x;
        if (owners[index] < 0 || owners[index - 1] < 0 ||
            owners[index] === owners[index - 1]) {
          continue;
        }
        var left = (index - 1) * 4;
        var right = index * 4;
        var leftLuma = pixels[left] * 0.299 +
          pixels[left + 1] * 0.587 + pixels[left + 2] * 0.114;
        var rightLuma = pixels[right] * 0.299 +
          pixels[right + 1] * 0.587 + pixels[right + 2] * 0.114;
        differences.push(Math.abs(rightLuma - leftLuma));
      }
    }
    return {
      p50: percentile(differences.slice(), 0.50),
      p95: percentile(differences.slice(), 0.95),
      samples: differences.length
    };
  }

  function finalizeSweep(session) {
    if (!session || session.released) {
      return { ok: false, reason: "released" };
    }
    if (session.finalized) return session.result;
    if (!session.pending || !session.direction) {
      session.result = {
        ok: false,
        reason: "too_short",
        progressDeg: session.maxProgressDeg,
        requiredDeg: session.options.minSpanDeg,
        retainedFrames: session.retainedFrames
      };
      session.finalized = true;
      return session.result;
    }
    if (session.maxProgressDeg < session.options.minSpanDeg) {
      session.result = {
        ok: false,
        reason: "too_short",
        progressDeg: session.maxProgressDeg,
        requiredDeg: session.options.minSpanDeg,
        retainedFrames: session.retainedFrames
      };
      session.finalized = true;
      return session.result;
    }

    var leftBoundary = session.pending.leftBoundaryDeg;
    if (leftBoundary === null) {
      leftBoundary = session.pending.index === 0
        ? -session.options.fovXDeg * 0.5
        : (session.acceptedCenters[session.acceptedCenters.length - 2] +
           session.pending.progressDeg) * 0.5;
    }
    var rightBoundary = Math.min(
      session.options.maxSpanDeg + session.options.fovXDeg * 0.5,
      session.pending.progressDeg + session.options.fovXDeg * 0.5
    );
    commitKeyframe(session, session.pending, leftBoundary, rightBoundary);
    dropKeyframe(session, session.pending);
    session.pending = null;

    var finalWidth = clamp(
      session.nextWriteX,
      1,
      session.raster.width
    );
    var coverage = analyzeCoverage(session.raster, finalWidth);
    var cropped = cropRaster(session, finalWidth);
    /*
     * Progress always grows left-to-right in the work raster. During an RTL
     * sweep that means longitude decreases as x grows, which would mirror
     * text and reverse the scene. Deliver every panorama in natural
     * increasing-world-longitude order.
     */
    if (session.direction < 0) {
      flipRasterHorizontal(
        cropped.pixels,
        cropped.owners,
        finalWidth,
        session.raster.height
      );
    }
    var ownedSeams = measureOwnedSeams(
      cropped.pixels,
      cropped.owners,
      finalWidth,
      session.raster.height
    );
    var seamLuma = session.diagnostics.seamJumps.map(function (item) {
      return item.luma;
    });
    session.result = {
      ok: coverage.coverage >= 0.90 && coverage.internalBlackColumns === 0,
      reason: coverage.internalBlackColumns ? "internal_hole" : "complete",
      width: finalWidth,
      height: session.raster.height,
      pixels: cropped.pixels,
      ownerMap: cropped.owners,
      direction: session.direction > 0 ? "ltr" : "rtl",
      directionSign: session.direction,
      centerSpanDeg: session.maxProgressDeg,
      coverageSpanDeg: session.maxProgressDeg + session.options.fovXDeg,
      coverage: coverage.coverage,
      blackColumns: coverage.blackColumns,
      internalBlackColumns: coverage.internalBlackColumns,
      retainedFrames: session.retainedFrames,
      diagnostics: {
        inputFrames: session.diagnostics.inputFrames,
        acceptedKeyframes: session.diagnostics.acceptedKeyframes,
        rejectedFast: session.diagnostics.rejectedFast,
        rejectedReverse: session.diagnostics.rejectedReverse,
        rejectedPitch: session.diagnostics.rejectedPitch,
        rejectedRoll: session.diagnostics.rejectedRoll,
        visualUses: session.diagnostics.visualUses,
        ownedSeamLumaP50: ownedSeams.p50,
        ownedSeamLumaP95: ownedSeams.p95,
        ownedSeamSamples: ownedSeams.samples,
        estimatedFovXDeg: session.diagnostics.estimatedFovXDeg ||
          session.options.fovXDeg,
        fovCandidateCount: session.diagnostics.fovCandidateCount,
        maxRetainedFrames: session.diagnostics.maxRetainedFrames,
        contentAwareSeams: session.diagnostics.contentAwareSeams,
        seamMaxOffsetDeg: session.diagnostics.seamMaxOffsetDeg,
        seamLumaJumpP95: percentile(seamLuma, 0.95),
        seamCount: seamLuma.length
      }
    };
    /*
     * The cropped output now owns the pixels. Drop the maximum-size working
     * raster immediately instead of waiting for the result screen to close.
     */
    session.raster.pixels = null;
    session.raster.covered = null;
    session.raster = null;
    session.ownerMap = null;
    session.rowWriteX = null;
    session.finalized = true;
    session.state = "complete";
    return session.result;
  }

  function releaseSweepSession(session) {
    if (!session) return { released: true, retainedFrames: 0 };
    if (session.pending) dropKeyframe(session, session.pending);
    if (session.firstKeyframe && session.firstKeyframe !== session.pending) {
      session.firstKeyframe.rgba = null;
      session.firstKeyframe.basis = null;
    }
    session.pending = null;
    session.firstKeyframe = null;
    session.lastObservation = null;
    session.fovReference = null;
    if (session.raster) {
      session.raster.pixels = null;
      session.raster.covered = null;
    }
    session.raster = null;
    session.ownerMap = null;
    session.rowWriteX = null;
    if (session.result) {
      session.result.pixels = null;
      session.result.ownerMap = null;
      session.result.retainedFrames = 0;
    }
    session.retainedFrames = 0;
    session.released = true;
    session.state = "released";
    return { released: true, retainedFrames: 0 };
  }

  return {
    createSweepSession: createSweepSession,
    makeLumaThumbnail: makeLumaThumbnail,
    estimateGridFlow: estimateGridFlow,
    ingestFrame: ingestFrame,
    finalizeSweep: finalizeSweep,
    releaseSweepSession: releaseSweepSession,
    shortestDelta: shortestDelta
  };
});
