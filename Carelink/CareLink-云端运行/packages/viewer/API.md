# Viewer public API

Import `createViewer` from `@unseen/viewer`. The returned `EventTarget` is framework-independent and owns only the container passed to `mount`.

The package export backed by `src/public/index.js` and `src/public/index.d.ts` is the only supported public entry. Files elsewhere under `src/` are implementation details and must not be imported by hosts.

```js
import { createViewer } from "@unseen/viewer";

const viewer = createViewer({ assetLoadTimeoutMs: 15_000 });
await viewer.mount(container);
await viewer.updateScene(scene);
await viewer.focusPose({
  nodeId: "node-a",
  photoId: "photo-7",
  photoAssetId: "asset-photo-7",
  photoAssetVersion: 3,
  photoRawSha256: "64 lowercase hex characters",
  placementRevisionId: "placement-revision-12",
  panoramaRevisionId: "pano-revision-a",
  returnTarget: "/s/space-a/photos/photo-7",
  yawDeg: 359,
  pitchDeg: 18,
}, { focusOnComplete: true });
```

## Methods

- `mount(container, scene?)`: mounts isolated viewer-owned DOM; remounting first disposes the previous mount.
- `updateScene(scene)`: cancels stale loads, releases old GPU/assets, validates and loads the next scene, then resolves with `ViewerStateDTO`. A color-load failure rejects and emits `error`; supported degradation resolves with a machine-readable `failure` and emits `error`.
- `focusPose(pose, options?)`: requires immutable `photoId`, `photoAssetId`, integer `photoAssetVersion >= 1`, lowercase `photoRawSha256`, `placementRevisionId`, the current `panoramaRevisionId`, an exact matching `nodeId`, and a finite `yawDeg` (including valid `0`). Optional pitch/FOV must also be finite before normalization. Missing/non-finite pose input fails as `focus_pose_invalid`; malformed identity, stale node and stale panorama placement have distinct stable codes and are never guessed. Focus requires a real spherical render mode; an existing flat fallback or a render frame that loses spherical output rejects within the call as `spherical_view_unavailable`, never stays pending. User input/reset/update/dispose and an externally delivered context-loss interruption reject as `focus_cancelled`; all failure paths clear focus/return state and never resolve false success. `focusOnComplete: true` moves focus to the canvas for a user-invoked photo CTA, including reduced-motion; it defaults to false so background calls do not steal external focus.
- `reset()`: returns to the saved initial node/yaw/pitch/FOV and camera origin, clearing photo focus.
- `retry()`: programmatically reloads the last scene and reacquires a new canvas/WebGL context. The visible retry button first emits cancelable `retryrequest`; see Events for signed-URL refresh integration.
- `dispose()`: aborts fetch/decode, cancels animation and movement, removes listeners/observers/DOM, deletes textures/buffers/program/shaders, revokes object URLs, and closes image bitmaps. It is idempotent; the same instance/container may be mounted again.
- `getState()`: returns a detached `ViewerStateDTO` snapshot.

## Scene DTO

```js
{
  sceneId: "scene-a",
  nodeId: "node-a",
  sceneReadiness: "ready",
  sceneMode: "rotation360", // or depth_limited_parallax / walkable3d
  panorama: {
    revisionId: "pano-revision-a",
    sha256: "64 lowercase hex characters",
    url: "/signed-or-same-origin/panorama.jpg",
    alt: "婚礼现场 360°全景"
  },
  initialPose: { yawDeg: 15, pitchDeg: -4, fovDeg: 72 },
  depthArtifact: null
}
```

`panorama.sha256` is required. The load order for panorama and depth is: bounded fetch/body read → SHA-256 comparison → static-raster container/magic/dimension policy → browser decode → WebGL upload. A panorama mismatch fails as retryable `panorama_hash_mismatch`; mismatched bytes never enter a browser decoder or renderer. Production runtime accepts only static PNG, JPEG and WebP. PNG chunks are walked through `IEND`; `acTL` rejects APNG. WebP must have an exact RIFF size and bounded chunks; the VP8X animation flag or any `ANIM`/`ANMF` chunk rejects the file. These animation failures use non-retryable `asset_animation_unsupported` and enter no browser decoder. GIF, SVG and unknown input also fail closed; HEIC/HEIF must be converted by the media/API layer to a checksum-bound static browser derivative. `ViewerStateDTO.panoramaRevisionId`, focused placement state, and `returnrequest` retain the bound panorama revision.

Photo-file checksum authority remains at the Track 1A media + Track 2/API adapter seam: the host must verify the photo bytes and obtain the same immutable `photoId`, `photoAssetId`, `photoAssetVersion`, `photoRawSha256`, `placementRevisionId` and `panoramaRevisionId` from authoritative scene-context before constructing `FocusPoseDTO`. Viewer validates shape and binding, retains those identity fields verbatim in `state.focus` and `returnrequest`, and does not claim to checksum photo bytes it never downloads.

## Product runtime timeout

`createViewer({assetLoadTimeoutMs})` gives each color and depth asset load a fresh deadline covering fetch, response-body read and browser decode. The default is 15 seconds; input is clamped to 100–30,000 ms. A color timeout becomes retryable `asset_timeout`, exits `loading` into `error`, hides the canvas and exposes retry. A depth timeout honestly resolves as `rotation360` with translation disabled, the same failure code and retry visible. Success, failure, abort, superseding update and `dispose()` clear timers; an aborted body reader is canceled, and a non-cancelable decoder that resolves late is immediately closed. Retry starts a new deadline rather than reusing the expired timer.

`walkable3d` never enables movement. It reports `failure.code="walkable3d_not_supported"` and uses `rotation360` when WebGL exists, otherwise `flat_fallback`.

The frozen release-readiness contract keeps the production v1 default at `rotation360`. Hosts must not request `depth_limited_parallax` until the controller enables it and supplies a licensed, validated artifact; this package's optional capability does not by itself change release scope.

## Depth artifact v1

Depth translation activates only when all fields validate, the artifact is bound to the current panorama revision, the downloaded bytes match SHA-256, `quality.validFraction >= 0.98`, and the polar safety envelope covers the full circle with gaps no larger than 60°. Deterministic schema/version/revision/quality/envelope/encoding/dimension failures are non-retryable and continue as `rotation360` with retry hidden. Fetch, timeout and checksum failures are retryable because a host can refresh signed scene-context and replace the artifact.

```js
{
  schemaVersion: "unseen-depth-artifact/1",
  artifactId: "depth-a",
  sourcePanoramaRevisionId: "pano-revision-a",
  depthMap: {
    url: "/signed-or-same-origin/depth.png",
    sha256: "64 lowercase hex characters",
    width: 1024,
    height: 512,
    encoding: "linear-red-v1",
    nearMeters: 0.5,
    farMeters: 12
  },
  quality: { validFraction: 0.99 },
  safetyEnvelope: {
    schemaVersion: "unseen-polar-safety-envelope/1",
    absoluteMaxRadiusMeters: 0.4,
    directions: [
      { yawDeg: 0, allowedRadiusMeters: 0.34 },
      // at least eight unique, full-circle samples
    ]
  }
}
```

The fragment shader performs iterative depth-shell reprojection from the real camera `(x,z)` translation. Movement uses the smaller adjacent directional radius between samples and the frozen hard package ceiling of 0.42 m. Invalid/non-finite/incomplete safety data returns an allowed radius of zero; no movement is exposed. The browser never runs or downloads a depth model.

Canonical yaw uses the panorama-core convention: yaw `0°` faces `[0,+1,0]` and samples the equirectangular `u=0` seam; `90/180/270°` advance in the same direction in both color and depth sampling. At the first interactive frame and after completed focus, the Viewer adds no more than `0.5°` circular seam error to any finite canonical yaw.

## State and render truth

`ViewerStateDTO.schemaVersion` is `unseen-viewer-state/1`.

- `phase`: `idle | loading | ready | error | disposed`;
- `renderMode`: `flat_fallback | rotation360 | depth_limited_parallax`;
- `requestedSceneMode`: the canonical requested mode, kept separate from actual render mode;
- `capability`: explicit booleans for WebGL, spherical view, validated depth, translation, input and fullscreen;
- `pose`: normalized `[0,360)` yaw, clamped `[-89,89]` pitch, FOV, node, and actual camera `x/z`;
- `failure`: stable `{code,message,retryable}` even when the flat/look-only degradation remains usable;
- `metrics`: first-frame latency and uploaded texture size.

## Events

- `statechange`: complete state snapshot;
- `posechange`: current pose/camera snapshot;
- `firstframe`: first-frame timing, texture size and actual render mode;
- `error`: stable error/degradation DTO; no error is logged to console by the package;
- `returnrequest`: revision-bound `{photoId,photoAssetId,photoAssetVersion,photoRawSha256,placementRevisionId,panoramaRevisionId,returnTarget,pose}` for the host adapter;
- `retryrequest`: cancelable `{failure,sceneId,panoramaRevisionId}` emitted by the visible retry button. A host using short-lived signed scene URLs must synchronously call `event.preventDefault()`, fetch a fresh canonical scene-context, then call `updateScene(newScene)`. With no cancellation, the Viewer reloads its last scene for standalone/context-loss recovery.

## Input and accessibility

Pointer drag and one-finger drag orbit; two pointers pinch FOV; mouse wheel adjusts FOV; arrows and the four 44 px direction controls orbit. In validated depth mode desktop `WASD` and a named four-button 44 px translation group change real camera `x/z`; the gesture joystick appears only for coarse touch layouts and is hidden from the accessibility tree because the equivalent named controls remain available. Reset, retry, return and fullscreen are keyboard controls. Direction/boundary/status changes use live regions. `prefers-reduced-motion` makes photo focus immediate and removes continuous decorative motion. If a focused viewer fails, focus moves to visible retry or a focusable status; only a retry/user-CTA success returns it to the new canvas.

## Stable codes and customer messages

`failure.code` is for adapters, telemetry and tests. The visible HUD uses customer language and never exposes implementation terms such as artifact, shader or texture.

| Stable code family | Visible customer message | Retry |
| --- | --- | --- |
| `asset_timeout` / temporary fetch | `现场加载超时，请重试。` / `现场暂时无法打开，请重试。` | visible |
| `panorama_hash_mismatch` | `现场图片校验失败，请重试。` | visible; host may refresh scene-context |
| `asset_animation_unsupported` | `现场图片格式暂不支持。` | hidden; provide a static derivative |
| deterministic depth validation | `暂时只能环视现场。` | hidden |
| temporary depth fetch/hash/timeout | `暂时只能环视现场。` | visible; host may refresh scene-context |
| WebGL/context/render failures | `当前设备暂时无法环视，已显示平面图。` | visible when recoverable |
| `focus_cancelled` | `照片定位已取消。` | not an asset retry |
