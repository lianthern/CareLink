# Track 4 `focusPose()` pending counterexample

Status: reproduced against Track 4 `a0f50ee`; resolved upstream in clean Track 4 commit `b5d54f9` and retained at verification commit `5c32fb9`. Track 2 keeps an 1800 ms host-side bounded wait only as a defensive fallback; it never converts the timeout into success. The merged Track 5 visible-GPU run remains the final 360 interaction gate.

## Environment and public entry

- Chrome headless new, production WebGL policy unchanged (Track 2 does not force WebGL off or force a fallback).
- Track 4 worktree commit observed by Track 2: `a0f50ee`.
- Import: the sole public `packages/viewer/src/public/index.js` entry.
- Call: synchronous `createViewer()`; `await viewer.mount(container, scene)`; then `viewer.focusPose(pose, {focusOnComplete:true})`.

## Minimal DTO

```json
{
  "sceneId": "scene-gongguang",
  "nodeId": "scene-gongguang",
  "sceneReadiness": "ready",
  "sceneMode": "rotation360",
  "panorama": {
    "url": "/assets/panorama/pano.jpg",
    "revisionId": "pano-revision-2",
    "sha256": "ab8217935e469d11e4c72d4b253b4088f8c7b19b56aff2fc6ef8410c3abc676d"
  }
}
```

```json
{
  "nodeId": "scene-gongguang",
  "yawDeg": -58,
  "pitchDeg": 0,
  "fovDeg": 75,
  "photoId": "photo-1",
  "photoAssetId": "asset-photo-1",
  "photoAssetVersion": 1,
  "photoRawSha256": "65e6aa0fa79e3f863c6e86183c1a5fcff1ef2bbb0eb84dd14381e0b00e257a50",
  "placementRevisionId": "placement-photo-1-v2",
  "panoramaRevisionId": "pano-revision-2",
  "returnTarget": "/s/space-gongguang/photos/photo-1"
}
```

Before focus, the browser had mounted Track 4 output with `phase=ready`, requested/render mode initially `rotation360`, `capability.sphericalView=true`, and a real canvas. During the animated focus, a WebGL render failure can call `_activateFallback(...)`, change the effective render to the honest flat fallback, and make `_render()` return `false`.

## Pending evidence and source path

The public promise had not settled after 1800 ms while CDP remained responsive. Track 2's bounded wait expired and returned `false`; it did not emit success or invoke the return target.

The directly read Track 4 source explains the permanent pending path:

- `viewer.js:1051-1053`: a GL error activates the fallback and `_render()` returns `false`.
- `viewer.js:1117-1147`: the animated `focusPose()` owns resolve/reject callbacks.
- `viewer.js:1132`: `if (!this._render()) return;` exits the RAF callback without resolving, rejecting, or scheduling another frame.
- The non-animated branch at `viewer.js:1103-1107` correctly throws `spherical_view_unavailable`, so the animated branch is inconsistent.

## Required upstream behavior

`focusPose()` must always settle. If spherical rendering becomes unavailable before or during focus, it must reject with a stable error such as `spherical_view_unavailable` after clearing animation state. Flat fallback must remain visibly usable, but focus/return must not be reported as successful. Track 5 must re-run this exact case against the merged clean Track 4 commit and then run the full yaw/360/return flow in a GPU-capable visible browser.

## Accepted upstream resolution

Track 2 re-read the clean `b5d54f9` public implementation. The animated branch now supplies a `spherical_view_unavailable` failure to `_render()`, and `_activateFallback()` calls `_cancelAnimation(false, focusFailure)` so the public promise rejects instead of remaining pending. Track 2's adapter still treats the rejection as `false` and does not expose a return success. The browser run exports and imports clean Track 4 `5c32fb9`; the unit contract test independently checks the mounted Track 4 public entry and exact declared surface.
