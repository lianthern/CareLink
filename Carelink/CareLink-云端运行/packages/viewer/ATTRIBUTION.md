# Provenance and license boundary

This package contains new, dependency-free, project-owned source. It copies no third-party runtime, model, weight, texture, font, or non-commercial code.

Read-only historical sources consulted:

- `imports/recovered-backend/web/pano-capture.js` (byte-identical legacy copy also exists): coordinate convention, NPOT `CLAMP_TO_EDGE`, first-frame-before-cover, context-loss fallback and explicit WebGL deletion patterns.
- `imports/recovered-backend/miniapp/pages/capture/capture.js`: touch input and lifecycle cleanup evidence.
- `imports/recovered-backend/miniapp/utils/pano-core.js`: historical yaw/pitch convention and seam normalization evidence. The viewer's public math is independently implemented as ES modules.
- `imports/recovered-backend/web/pov.html`: evidence that the historical depth demo used DAP and labeled it `CC BY-NC 4.0`; it is not a production implementation source.
- `contracts/source/technical/EVIDENCE/01-INVENTORY-CLOUD.md`: records historical DAP weight hash/license and states commercial permission is absent.

No separate reusable license grant was found for the recovered panorama JavaScript listed above. It was therefore treated as evidence only: no source text or assets were copied. The only explicit model license found was DAP's non-commercial `CC BY-NC 4.0`, which is excluded below.

Excluded by design:

- DAP weights/code and any `CC BY-NC 4.0` artifact;
- Three.js, external viewers, CDNs and network model downloads;
- Poly Haven or other historical demo media;
- 3DGS, Instant-NGP and video/scan-to-complete-3D claims.

The raster fixtures under `tests/fixtures/` were generated specifically for this package with the local ImageMagick CLI and contain no third-party image content. `panorama.png`, `depth.png`, `yaw-markers.png`, and `square.png` are a synthetic 2:1 color panorama, a synthetic 16-bit linear depth map, a numeric yaw/seam marker raster, and a deterministic invalid-ratio raster. `static-panorama.webp` is a static WebP derivative of that synthetic panorama. `animated.apng` and `animated.webp` are synthetic 1024×512 two-frame red/blue counterexamples retained from the independent final red-team reproduction; their SHA-256 values are asserted in unit and browser tests. All are test-only. `unsupported.svg` is likewise project-authored test input used only to prove production runtime rejects SVG before decode. The package remains private `UNLICENSED`, matching the repository baseline. Any future dependency, media, model, or depth generator requires the controller's root-lock and license process; it must not be smuggled into this viewer package.
