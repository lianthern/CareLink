export const MAX_TRANSLATION_METERS = 0.42;
export const MAX_PITCH_DEG = 89;

const finite = (value) => Number.isFinite(Number(value));

export function normalizeYaw(yawDeg) {
  if (!finite(yawDeg)) return 0;
  const wrapped = ((Number(yawDeg) % 360) + 360) % 360;
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

export function clampPitch(pitchDeg) {
  if (!finite(pitchDeg)) return 0;
  return Math.max(-MAX_PITCH_DEG, Math.min(MAX_PITCH_DEG, Number(pitchDeg)));
}

export function shortestYawDelta(fromDeg, toDeg) {
  return ((normalizeYaw(toDeg) - normalizeYaw(fromDeg) + 540) % 360) - 180;
}

export function normalizePose(pose = {}) {
  return {
    nodeId: typeof pose.nodeId === "string" ? pose.nodeId : null,
    yawDeg: normalizeYaw(pose.yawDeg),
    pitchDeg: clampPitch(pose.pitchDeg),
    fovDeg: finite(pose.fovDeg)
      ? Math.max(35, Math.min(100, Number(pose.fovDeg)))
      : 75,
  };
}

export function validateSafetyEnvelope(value) {
  if (!value || value.schemaVersion !== "unseen-polar-safety-envelope/1") {
    return { ok: false, code: "safety_schema_unsupported" };
  }
  const absolute = Number(value.absoluteMaxRadiusMeters);
  if (typeof value.absoluteMaxRadiusMeters !== "number" || !Number.isFinite(absolute) ||
      absolute <= 0 || absolute > MAX_TRANSLATION_METERS) {
    return { ok: false, code: "safety_absolute_radius_invalid" };
  }
  if (!Array.isArray(value.directions) || value.directions.length < 8 || value.directions.length > 72) {
    return { ok: false, code: "safety_directions_invalid" };
  }

  const directions = [];
  const seen = new Set();
  for (const item of value.directions) {
    const yawDeg = normalizeYaw(item?.yawDeg);
    const allowedRadiusMeters = Number(item?.allowedRadiusMeters);
    const key = yawDeg.toFixed(6);
    if (typeof item?.yawDeg !== "number" || typeof item?.allowedRadiusMeters !== "number" ||
        !finite(item.yawDeg) || !Number.isFinite(allowedRadiusMeters) ||
        allowedRadiusMeters < 0 || allowedRadiusMeters > absolute || seen.has(key)) {
      return { ok: false, code: "safety_direction_value_invalid" };
    }
    seen.add(key);
    directions.push({ yawDeg, allowedRadiusMeters });
  }
  directions.sort((a, b) => a.yawDeg - b.yawDeg);

  for (let index = 0; index < directions.length; index += 1) {
    const current = directions[index].yawDeg;
    const next = index === directions.length - 1
      ? directions[0].yawDeg + 360
      : directions[index + 1].yawDeg;
    if (next - current > 60.000001) {
      return { ok: false, code: "safety_direction_coverage_invalid" };
    }
  }
  return {
    ok: true,
    value: {
      schemaVersion: value.schemaVersion,
      absoluteMaxRadiusMeters: absolute,
      directions,
    },
  };
}

export function allowedRadiusForHeading(envelope, yawDeg) {
  const validated = validateSafetyEnvelope(envelope);
  if (!validated.ok) return 0;
  const directions = validated.value.directions;
  const yaw = normalizeYaw(yawDeg);

  for (const direction of directions) {
    if (Math.abs(direction.yawDeg - yaw) < 1e-7) return direction.allowedRadiusMeters;
  }

  let upperIndex = directions.findIndex((direction) => direction.yawDeg > yaw);
  if (upperIndex < 0) upperIndex = 0;
  const lowerIndex = (upperIndex - 1 + directions.length) % directions.length;
  // ponytail: use the smaller neighboring radius; upgrade only when an artifact
  // supplies a proved interpolation policy. This cannot bulge through a wall.
  return Math.min(
    directions[lowerIndex].allowedRadiusMeters,
    directions[upperIndex].allowedRadiusMeters,
    validated.value.absoluteMaxRadiusMeters,
  );
}

export function constrainMovement(position, delta, envelope) {
  const x = Number(position?.x);
  const z = Number(position?.z);
  const dx = Number(delta?.x);
  const dz = Number(delta?.z);
  if (![x, z, dx, dz].every(Number.isFinite)) {
    return { x: 0, z: 0, blocked: true, allowedRadiusMeters: 0, reason: "non_finite" };
  }
  const safety = validateSafetyEnvelope(envelope);
  if (!safety.ok) {
    return { x, z, blocked: true, allowedRadiusMeters: 0, reason: "unsafe_or_invalid_depth" };
  }

  const candidateX = x + dx;
  const candidateZ = z + dz;
  const radius = Math.hypot(candidateX, candidateZ);
  if (radius < 1e-9) {
    return { x: 0, z: 0, blocked: false, allowedRadiusMeters: MAX_TRANSLATION_METERS };
  }
  const yawDeg = normalizeYaw(Math.atan2(candidateX, candidateZ) * 180 / Math.PI);
  const allowed = Math.min(
    allowedRadiusForHeading(safety.value, yawDeg),
    MAX_TRANSLATION_METERS,
  );
  if (!(allowed > 0)) {
    return { x, z, blocked: true, allowedRadiusMeters: 0, reason: "unsafe_or_invalid_depth" };
  }
  if (radius <= allowed) {
    return { x: candidateX, z: candidateZ, blocked: false, allowedRadiusMeters: allowed };
  }
  const scale = allowed / radius;
  return {
    x: candidateX * scale,
    z: candidateZ * scale,
    blocked: true,
    allowedRadiusMeters: allowed,
    reason: "direction_boundary",
  };
}

export function localMovementDelta(yawDeg, strafeMeters, forwardMeters) {
  const yaw = normalizeYaw(yawDeg) * Math.PI / 180;
  const rightX = Math.cos(yaw);
  const rightZ = -Math.sin(yaw);
  const forwardX = Math.sin(yaw);
  const forwardZ = Math.cos(yaw);
  return {
    x: rightX * strafeMeters + forwardX * forwardMeters,
    z: rightZ * strafeMeters + forwardZ * forwardMeters,
  };
}
