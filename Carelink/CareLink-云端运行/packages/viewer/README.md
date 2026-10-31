# @unseen/viewer

Framework-free UNSEEN panorama viewer. It renders a validated 2:1 panorama as a real WebGL spherical view, optionally consumes a pre-generated versioned depth artifact for bounded translation, and otherwise reports an honest look-only or flat fallback.

`@unseen/viewer` is the sole supported import. Its runtime and types are exported only from `src/public/`; other `src/` modules are private implementation.

The package does not provide page IA, authorization, asset signing, panorama generation, a browser-side depth model, or video/scan-to-3D. `walkable3d` is deliberately reported as unsupported and falls back to look-only.

## Local checks

```sh
npm --prefix packages/viewer run check
node --test packages/viewer/tests/unit/*.test.mjs
node packages/viewer/tests/browser/run-browser.mjs
node packages/viewer/tests/browser/run-cleanup-counterexample.mjs
node packages/viewer/tests/browser/run-soak.mjs
```

The browser runner uses an installed Chrome/Chromium plus Node standard libraries, starts a loopback-only static server, blocks external dependencies by assertion, drives real pointer/touch/key input through the DevTools protocol, and writes evidence under `tests/evidence/`. Every stage and assertion is marked; CDP calls, stages, and the whole suite have hard timeouts; browser/server cleanup runs in `finally` and asserts zero owned orphan processes. The counterexample deliberately hangs a stage and proves non-zero exit plus complete cleanup. The parameterized soak runner defaults to the acceptance duration of 30 minutes; shorter `UNSEEN_VIEWER_SOAK_DURATION_MS` runs are explicitly CI-only and cannot produce acceptance evidence.

Open the deterministic harness by serving `packages/viewer/` locally and visiting `/harness/index.html`. It contains no CDN, model download, credentials, analytics, or cloud write.

Each panorama DTO carries a required lowercase SHA-256 and immutable panorama revision. Bytes are hashed before container/magic/dimension checks, browser decode or upload. Runtime accepts only static PNG/JPEG/WebP: PNG `acTL`, the WebP VP8X animation flag, and WebP `ANIM`/`ANMF` chunks fail closed as non-retryable `asset_animation_unsupported` before decode; GIF, SVG and unknown formats are also rejected. HEIC/HEIF is an upstream static-derivative seam. Focus input additionally carries `photoId`, `photoAssetId`, integer `photoAssetVersion`, `photoRawSha256`, `placementRevisionId`, matching `panoramaRevisionId`, exact `nodeId`, and finite required `yawDeg`. Viewer shape/binds and returns that identity verbatim; Track 1A/Track 2 remain responsible for verifying the photo bytes Viewer does not download. Short-lived signed URLs are refreshed by listening for cancelable `retryrequest`, calling `preventDefault()`, obtaining a new scene-context, and passing it to `updateScene`; otherwise retry remains standalone.

## Resource ceilings

- fetched color bytes: 32 MiB;
- fetched depth bytes: 8 MiB;
- decoded input: at most 16,384×8,192 and 64 MiPixels;
- uploaded texture: at most 4,096 edge and 4,096×2,048 pixels, further limited by `MAX_TEXTURE_SIZE`;
- DPR: capped at 2;
- one color texture, at most one depth texture, and on-demand animation frames only.
- each color/depth fetch, body read, and decode: one fresh 15 s deadline by default, configurable from 100–30,000 ms with `assetLoadTimeoutMs`; timeout is retryable `asset_timeout`, cancels readers/timers, and closes a late decoder result.

Server-side media validation remains authoritative. Browser ceilings are a second containment layer, not a substitute for the frozen server decoder contract.

See [API.md](./API.md) for DTOs and lifecycle semantics and [ATTRIBUTION.md](./ATTRIBUTION.md) for provenance/license boundaries.
