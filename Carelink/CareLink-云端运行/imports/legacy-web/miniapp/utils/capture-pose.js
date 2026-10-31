/*
 * Mini-program-only pose helpers.
 *
 * The shared pano-core owns the cross-platform +Y-forward/+Z-up contract.
 * This module deliberately stays local to the mini program: it adapts
 * VisionKit matrices and smooths only the pose used for display. Capture
 * geometry must always use the unsmoothed tracking pose from the camera frame.
 */
"use strict";

var RAD_TO_DEG = 180 / Math.PI;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

function normalize(vector, fallback) {
  var length = Math.sqrt(dot(vector, vector));
  if (!isFinite(length) || length < 1e-8) return (fallback || [0, 1, 0]).slice();
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function orthonormalBasis(forward, upHint) {
  var F = normalize(forward, [0, 1, 0]);
  var R = normalize(cross(F, upHint || [0, 0, 1]), [1, 0, 0]);
  var U = normalize(cross(R, F), [0, 0, 1]);
  var horizonRight = normalize(cross(F, [0, 0, 1]), R);
  var horizonUp = normalize(cross(horizonRight, F), U);
  var rollDeg = Math.atan2(dot(U, horizonRight), dot(U, horizonUp)) * RAD_TO_DEG;
  return { F: F, U: U, R: R, rollDeg: rollDeg };
}

function copyBasis(basis) {
  if (!basis) return null;
  return {
    F: basis.F.slice(),
    U: basis.U.slice(),
    R: basis.R.slice(),
    rollDeg: Number(basis.rollDeg) || 0
  };
}

/*
 * A basis is the camera rotation matrix [R, U, -F]. That matrix is
 * right-handed even though the camera looks down local -Z.
 */
function basisToQuaternion(basis) {
  var m00 = basis.R[0], m01 = basis.U[0], m02 = -basis.F[0];
  var m10 = basis.R[1], m11 = basis.U[1], m12 = -basis.F[1];
  var m20 = basis.R[2], m21 = basis.U[2], m22 = -basis.F[2];
  var trace = m00 + m11 + m22;
  var x, y, z, w, scale;

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
  var length = Math.sqrt(x * x + y * y + z * z + w * w) || 1;
  return [x / length, y / length, z / length, w / length];
}

function quaternionToBasis(quaternion) {
  var x = quaternion[0], y = quaternion[1], z = quaternion[2], w = quaternion[3];
  var xx = x * x, yy = y * y, zz = z * z;
  var xy = x * y, xz = x * z, yz = y * z;
  var wx = w * x, wy = w * y, wz = w * z;
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

function slerpQuaternion(from, to, amount) {
  var t = clamp(Number(amount) || 0, 0, 1);
  var ax = from[0], ay = from[1], az = from[2], aw = from[3];
  var bx = to[0], by = to[1], bz = to[2], bw = to[3];
  var cosine = ax * bx + ay * by + az * bz + aw * bw;
  if (cosine < 0) {
    cosine = -cosine;
    bx = -bx; by = -by; bz = -bz; bw = -bw;
  }
  if (cosine > 0.9995) {
    var linear = [
      ax + t * (bx - ax),
      ay + t * (by - ay),
      az + t * (bz - az),
      aw + t * (bw - aw)
    ];
    var linearLength = Math.sqrt(
      linear[0] * linear[0] + linear[1] * linear[1] +
      linear[2] * linear[2] + linear[3] * linear[3]
    ) || 1;
    return linear.map(function (value) { return value / linearLength; });
  }
  var theta = Math.acos(clamp(cosine, -1, 1));
  var sinTheta = Math.sin(theta);
  var a = Math.sin((1 - t) * theta) / sinTheta;
  var b = Math.sin(t * theta) / sinTheta;
  return [
    ax * a + bx * b,
    ay * a + by * b,
    az * a + bz * b,
    aw * a + bw * b
  ];
}

/*
 * Event-rate-independent low-pass filter. A 90 ms time constant has the same
 * response at 20, 30 or 60 fps; unlike a fixed 0.15 lerp it does not add a
 * device-dependent capture lag. This output is display-only.
 */
function smoothBasisDt(previous, current, deltaMs, timeConstantMs) {
  if (!previous || !current || !isFinite(deltaMs) || deltaMs <= 0 || deltaMs > 500) {
    return copyBasis(current);
  }
  var tau = Math.max(1, Number(timeConstantMs) || 90);
  var amount = 1 - Math.exp(-deltaMs / tau);
  return quaternionToBasis(slerpQuaternion(
    basisToQuaternion(previous),
    basisToQuaternion(current),
    amount
  ));
}

function basisRotationErrorDeg(a, b) {
  if (!a || !b) return Infinity;
  var trace = dot(a.R, b.R) + dot(a.U, b.U) + dot(a.F, b.F);
  return Math.acos(clamp((trace - 1) / 2, -1, 1)) * RAD_TO_DEG;
}

function vkVectorToPano(vector) {
  // VisionKit/OpenGL: +X right, +Y up, -Z forward.
  // UNSEEN: +X right, +Y forward, +Z up.
  return [vector[0], -vector[2], vector[1]];
}

/*
 * VKCamera.viewMatrix is a column-major world-to-camera matrix. Its first
 * three rows are the camera right/up/back axes expressed in VK world space.
 */
function basisFromVisionKitViewMatrix(viewMatrix) {
  if (!viewMatrix || viewMatrix.length < 16) return null;
  var rightVk = [viewMatrix[0], viewMatrix[4], viewMatrix[8]];
  var upVk = [viewMatrix[1], viewMatrix[5], viewMatrix[9]];
  var backVk = [viewMatrix[2], viewMatrix[6], viewMatrix[10]];
  var right = vkVectorToPano(rightVk);
  var up = vkVectorToPano(upVk);
  var forward = vkVectorToPano([-backVk[0], -backVk[1], -backVk[2]]);
  var basis = orthonormalBasis(forward, up);
  if (dot(basis.R, right) < 0) {
    basis.R = [-basis.R[0], -basis.R[1], -basis.R[2]];
    basis.U = normalize(cross(basis.R, basis.F), [0, 0, 1]);
  }
  return basis;
}

function fovFromIntrinsics(intrinsics, width, fallbackDeg) {
  var fallback = Number(fallbackDeg) || 65;
  if (!intrinsics || intrinsics.length < 5) return fallback;
  var fx = Math.abs(Number(intrinsics[0]));
  var w = Math.max(1, Number(width) || 1);
  if (!isFinite(fx) || fx < 1) return fallback;
  var fov = 2 * Math.atan(w / (2 * fx)) * RAD_TO_DEG;
  return isFinite(fov) && fov >= 25 && fov <= 125 ? fov : fallback;
}

function fovFromProjectionMatrix(projectionMatrix, fallbackDeg) {
  var fallback = Number(fallbackDeg) || 65;
  if (!projectionMatrix || projectionMatrix.length < 6) return fallback;
  var scaleX = Math.abs(Number(projectionMatrix[0]));
  if (!isFinite(scaleX) || scaleX < 0.01) return fallback;
  var fov = 2 * Math.atan(1 / scaleX) * RAD_TO_DEG;
  return isFinite(fov) && fov >= 25 && fov <= 125 ? fov : fallback;
}

module.exports = {
  basisFromVisionKitViewMatrix: basisFromVisionKitViewMatrix,
  basisRotationErrorDeg: basisRotationErrorDeg,
  basisToQuaternion: basisToQuaternion,
  copyBasis: copyBasis,
  fovFromIntrinsics: fovFromIntrinsics,
  fovFromProjectionMatrix: fovFromProjectionMatrix,
  quaternionToBasis: quaternionToBasis,
  slerpQuaternion: slerpQuaternion,
  smoothBasisDt: smoothBasisDt
};
