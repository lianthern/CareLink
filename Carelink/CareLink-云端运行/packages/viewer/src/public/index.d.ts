/** The complete supported public surface of @unseen/viewer. */
export type SceneMode = "rotation360" | "depth_limited_parallax" | "walkable3d";
export type RenderMode = "flat_fallback" | "rotation360" | "depth_limited_parallax";

export interface ViewerOptions {
  assetLoadTimeoutMs?: number;
}

export interface PoseDTO {
  nodeId: string | null;
  yawDeg: number;
  pitchDeg: number;
  fovDeg: number;
  x?: number;
  z?: number;
}

export interface SafetyDirectionDTO {
  yawDeg: number;
  allowedRadiusMeters: number;
}

export interface SafetyEnvelopeDTO {
  schemaVersion: "unseen-polar-safety-envelope/1";
  absoluteMaxRadiusMeters: number;
  directions: SafetyDirectionDTO[];
}

export interface DepthArtifactDTO {
  schemaVersion: "unseen-depth-artifact/1";
  artifactId: string;
  sourcePanoramaRevisionId: string;
  depthMap: {
    url: string;
    sha256: string;
    width: number;
    height: number;
    encoding: "linear-red-v1";
    nearMeters: number;
    farMeters: number;
  };
  quality: { validFraction: number };
  safetyEnvelope: SafetyEnvelopeDTO;
}

export interface ViewerSceneDTO {
  sceneId?: string;
  nodeId?: string;
  sceneReadiness: "ready";
  sceneMode: SceneMode;
  panorama: { url: string; revisionId: string; sha256: string; alt?: string };
  initialPose?: Partial<PoseDTO>;
  depthArtifact?: DepthArtifactDTO | null;
}

export interface ViewerStateDTO {
  schemaVersion: "unseen-viewer-state/1";
  phase: "idle" | "loading" | "ready" | "error" | "disposed";
  renderMode: RenderMode;
  requestedSceneMode: SceneMode | null;
  sceneId: string | null;
  panoramaRevisionId: string | null;
  capability: {
    webgl: boolean;
    sphericalView: boolean;
    depthArtifact: boolean;
    translation: boolean;
    keyboard: boolean;
    touch: boolean;
    fullscreen: boolean;
  };
  pose: PoseDTO & { x: number; z: number };
  focus: null | {
    photoId: string;
    photoAssetId: string;
    photoAssetVersion: number;
    photoRawSha256: string;
    placementRevisionId: string;
    panoramaRevisionId: string;
    returnTarget: string | null;
    pose: PoseDTO & { panoramaRevisionId: string };
  };
  failure: null | { code: string; message: string; retryable: boolean };
  metrics: { firstFrameMs: number | null; textureWidth: number | null; textureHeight: number | null };
}

export interface FocusPoseDTO {
  nodeId: string;
  yawDeg: number;
  pitchDeg?: number;
  fovDeg?: number;
  photoId: string;
  photoAssetId: string;
  photoAssetVersion: number;
  photoRawSha256: string;
  placementRevisionId: string;
  panoramaRevisionId: string;
  returnTarget?: string;
}

export interface ReturnRequestDTO {
  photoId: string;
  photoAssetId: string;
  photoAssetVersion: number;
  photoRawSha256: string;
  placementRevisionId: string;
  panoramaRevisionId: string;
  returnTarget: string | null;
  pose: PoseDTO & { panoramaRevisionId: string };
}

export interface RetryRequestDTO {
  failure: NonNullable<ViewerStateDTO["failure"]>;
  sceneId: string | null;
  panoramaRevisionId: string | null;
}

export class UnseenViewer extends EventTarget {
  constructor(options?: ViewerOptions);
  mount(container: Element, scene?: ViewerSceneDTO): Promise<ViewerStateDTO>;
  updateScene(scene: ViewerSceneDTO): Promise<ViewerStateDTO>;
  focusPose(pose: FocusPoseDTO, options?: { animate?: boolean; durationMs?: number; focusOnComplete?: boolean }): Promise<ViewerStateDTO>;
  reset(): ViewerStateDTO;
  retry(): Promise<ViewerStateDTO>;
  dispose(): void;
  getState(): ViewerStateDTO;
  addEventListener(type: "statechange", listener: (event: CustomEvent<ViewerStateDTO>) => void): void;
  addEventListener(type: "posechange", listener: (event: CustomEvent<ViewerStateDTO["pose"]>) => void): void;
  addEventListener(type: "firstframe", listener: (event: CustomEvent<ViewerStateDTO["metrics"] & { renderMode: RenderMode }>) => void): void;
  addEventListener(type: "error", listener: (event: CustomEvent<NonNullable<ViewerStateDTO["failure"]>>) => void): void;
  addEventListener(type: "returnrequest", listener: (event: CustomEvent<ReturnRequestDTO>) => void): void;
  addEventListener(type: "retryrequest", listener: (event: CustomEvent<RetryRequestDTO>) => void): void;
}

export function createViewer(options?: ViewerOptions): UnseenViewer;
export function normalizeYaw(yawDeg: number): number;
export function clampPitch(pitchDeg: number): number;
export function normalizePose(pose?: Partial<PoseDTO>): PoseDTO;
export function shortestYawDelta(fromDeg: number, toDeg: number): number;
export function validateSafetyEnvelope(value: unknown): { ok: boolean; code?: string; value?: SafetyEnvelopeDTO };
export function allowedRadiusForHeading(envelope: SafetyEnvelopeDTO, yawDeg: number): number;
export function constrainMovement(
  position: { x: number; z: number },
  delta: { x: number; z: number },
  envelope: SafetyEnvelopeDTO,
): { x: number; z: number; blocked: boolean; allowedRadiusMeters: number; reason?: string };
export function localMovementDelta(yawDeg: number, strafeMeters: number, forwardMeters: number): { x: number; z: number };
export function validateDepthArtifact(value: unknown, panoramaRevisionId: string): { ok: boolean; code?: string; value?: DepthArtifactDTO };
export const MAX_PITCH_DEG: 89;
export const MAX_TRANSLATION_METERS: 0.42;
export const DEPTH_ARTIFACT_VERSION: "unseen-depth-artifact/1";
