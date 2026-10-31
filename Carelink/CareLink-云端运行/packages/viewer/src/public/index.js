import { UnseenViewer } from "../viewer.js";

export {
  MAX_PITCH_DEG,
  MAX_TRANSLATION_METERS,
  allowedRadiusForHeading,
  clampPitch,
  constrainMovement,
  localMovementDelta,
  normalizePose,
  normalizeYaw,
  shortestYawDelta,
  validateSafetyEnvelope,
} from "../math.js";
export { DEPTH_ARTIFACT_VERSION, validateDepthArtifact } from "../depth.js";
export { UnseenViewer } from "../viewer.js";

export function createViewer(options) {
  return new UnseenViewer(options);
}
