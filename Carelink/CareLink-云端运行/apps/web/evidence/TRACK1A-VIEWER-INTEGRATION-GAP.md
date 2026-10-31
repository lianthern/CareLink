# Track 1A → Track 4 scene media integration gap

Status: open integration NO-GO observed on 2026-08-13. Track 2 fails closed and does not substitute fixture state, strip authorization, or report a Viewer success.

## Exact revisions inspected

- Track 1A clean commit: `4e0c64e09dcf753cc3c1ff665cf594edabc0a41d`.
- Track 4 clean commit used by the browser run: `5c32fb94fced13055b67dc85f98fdb43d4a87816`.
- Track 2 consumer baseline inspected by the finding: `c956e2c4ada0313eb2ec1714bdfb86b3b09f3b60`.

## Producer shape

At Track 1A `services/api/src/read-service.mjs`, `sceneContext()` returns `photoMedia`, a nested `panorama.media`, and placement revision/pose fields. It does not return the controller-approved immutable photo identity fields `photoAssetId`, `photoAssetVersion`, and `photoRawSha256`.

At Track 1A `services/api/src/media-capability-service.mjs`, the panorama media object contains:

```json
{
  "url": "/v1/media/{capabilityId}",
  "authorizationHeader": "X-Media-Capability",
  "authorizationSecret": "<one-time secret>",
  "oneTime": true,
  "sha256": "<raw sha256>"
}
```

The media endpoint requires that header and consumes the capability once.

## Consumer shape

Track 4 `packages/viewer/src/public/index.d.ts` defines the only public panorama input as:

```ts
panorama: { url: string; revisionId: string; sha256: string; alt?: string }
```

There is no authorization-header field. Track 2 cannot safely put a secret in the URL, cannot bypass Track 1A authorization, and cannot invent the missing immutable photo identity/version.

## Track 2 behavior and reproduction

`canonicalViewerScene()` rejects header-bound panorama media with `viewer_scene_invalid:panorama_authorization_unsupported`. It separately rejects missing photo identity with `viewer_scene_invalid:placement_identity`. The production UI then presents the existing honest unavailable/retry/return state; it never calls `viewer.mount()` or `focusPose()` with an incomplete identity.

`apps/web/tests/viewer-adapter.test.mjs` contains the strict producer-shape counterexample. The canonical local HTTP browser run continues to test the already-approved target DTO shape, and its metadata does not claim a live connection to Track 1A `4e0c64e`.

## Exact seam request to Track 1A

The current Track 4 public API fixes the transport choice for this release: the panorama must be a URL-only, refreshable capability. Track 2 requests this scene-context shape (field names are exact):

```json
{
  "sceneId": "scene-id",
  "nodeId": "node-id",
  "sceneReadiness": "ready",
  "sceneMode": "rotation360",
  "panorama": {
    "url": "https://same-origin-or-signed.example/panorama",
    "revisionId": "panorama-revision-id",
    "sha256": "64-lowercase-hex",
    "expiresAt": "RFC3339 timestamp",
    "oneTime": false
  },
  "photoId": "photo-id",
  "photoAssetId": "immutable-photo-asset-id",
  "photoAssetVersion": 1,
  "photoRawSha256": "64-lowercase-hex",
  "placement": {
    "revisionId": "placement-revision-id",
    "status": "confirmed",
    "nodeId": "node-id",
    "yawDeg": 0,
    "pitchDeg": 0,
    "fovDeg": 75
  },
  "photoMedia": {
    "url": "/v1/media/photo-capability-id",
    "sha256": "same-photoRawSha256",
    "expiresAt": "RFC3339 timestamp",
    "oneTime": true,
    "authorizationHeader": "X-Media-Capability",
    "authorizationSecret": "redacted"
  }
}
```

Requirements:

- `panorama.url` carries all authorization Track 4 needs. It must not require a custom header, fragment, cookie unavailable to the media fetch, or a secret copied by Track 2.
- The panorama capability is multi-read until `expiresAt` (`oneTime=false`) because mount, range/media decoding, renderer recovery, and retry may perform more than one read. It is still revision-, viewer-session-, and Space-bound and becomes invalid at expiry or revision replacement.
- `expiresAt` must be later than DTO issuance and leave enough time for one mount. Track 2 validates any supplied expiry before calling Track 4 and requests a fresh DTO rather than extending it locally.
- Photo media may remain one-time and header-bound: Track 2 itself fetches the bytes with the supplied header, validates `photoRawSha256`, creates a local object URL, and never forwards that credential to Track 4.
- `photoAssetId`, positive integer `photoAssetVersion`, `photoRawSha256`, `placement.revisionId`, `panorama.revisionId`, finite yaw/pitch, and confirmed placement status are mandatory for a returnable photo. `needs_confirmation`, `outside_scene`, `failed`, stale, or incomplete placements are not projected as return targets.

## Errors and refresh behavior

- A header-bound panorama fails before `viewer.mount()` with `viewer_scene_invalid:panorama_authorization_unsupported`.
- A one-time panorama fails with `viewer_scene_invalid:panorama_one_time_unsupported`; an expired supplied capability fails with `viewer_scene_invalid:panorama_expired`.
- Missing or mismatched photo/placement identity fails with `viewer_scene_invalid:placement_identity` or the existing checksum unavailable state; Track 2 does not focus or return that photo.
- Initial failure shows the existing honest unavailable state. A page retry performs a new scene-context GET.
- Track 4 `retryrequest` is canceled by the host; Track 2 performs a new scene-context GET, calls `updateScene()` with the new URL/revision/sha, then re-focuses only when the new DTO contains the same complete photo identity. API `scene_unavailable`, `photo_scene_unavailable`, capability expiry, network failure, or a changed identity remains unavailable and retryable; no old URL or identity is reused.

## Consumer readiness and remaining owner action

Track 2's production adapter now accepts the URL-only shape above, rejects header-bound/one-time/expired panorama capabilities before mount, filters return controls to confirmed placements, and tests refresh → `updateScene()` → exact `focusPose()` identity. This closes the consumer preparation only; it does not close the cross-owner NO-GO.

Track 1A must issue the requested fields/transport, then Track 5 must lock exact Track 1A + Track 2 + Track 4 SHAs and run scene mount, panorama expiry refresh, photo checksum, every confirmed-photo focus, uncertain/OOD exclusion, and return identity equality in a GPU-capable visible browser.
