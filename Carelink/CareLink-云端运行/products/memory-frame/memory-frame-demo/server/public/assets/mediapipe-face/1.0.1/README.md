# Local face presence assets

Vendored from Google's `@mediapipe/tasks-vision` **1.0.1** (Apache 2.0) and
BlazeFace short-range **float16/1**. Retrieved 2026-09-24. Original filenames and
JavaScript bytes are preserved. WASM is losslessly gzip-compressed (mtime 0) to
keep the response under the CloudBase gateway's 6 MiB limit; the browser worker
decompresses it before initializing MediaPipe. `manifest.json` records every
runtime asset's size and SHA-256. The included upstream LICENSE also lists its
third-party notices.

- Package: https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-1.0.1.tgz
- Model: https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite
- Web guide: https://developers.google.com/edge/mediapipe/solutions/vision/face_detector/web_js
- Model card: https://storage.googleapis.com/mediapipe-assets/MediaPipe%20BlazeFace%20Model%20Card%20%28Short%20Range%29.pdf

The task detects faces, not identities or eye contact. Short-range/front-facing
use is intended; turned backs, distant people, dim lighting and occlusion may
be missed. A photo of a face may also be detected; no liveness claim is made.
Only a local yes/no/unknown observation is returned. Camera images and face
landmarks are never uploaded or retained by this integration.
