'use strict';
// All assets are served by this application. Video frames never leave the worker.
const ASSETS = '/assets/mediapipe-face/1.0.1/';
let detector = null;

async function initialize() {
  let binaryURL;
  try {
    if (typeof DecompressionStream !== 'function' || typeof OffscreenCanvas !== 'function') throw Error('unsupported');
    importScripts(ASSETS + 'vision_bundle.js');
    const [wasmResponse, modelResponse] = await Promise.all([
      fetch(ASSETS + 'vision_wasm_nosimd_internal.wasm.gz'),
      fetch(ASSETS + 'blaze_face_short_range.tflite'),
    ]);
    if (!wasmResponse.ok || !modelResponse.ok) throw Error('assets');
    // The 3.3 MB compressed asset stays below the cloud gateway's response limit.
    // It is intentionally served as bytes, then decompressed locally.
    const wasm = await new Response(wasmResponse.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    binaryURL = URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' }));
    detector = await Vision.FaceDetector.createFromOptions({
      wasmLoaderPath: new URL(ASSETS + 'vision_wasm_nosimd_internal.js', self.location.origin).href,
      wasmBinaryPath: binaryURL,
    }, {
      baseOptions: { modelAssetBuffer: new Uint8Array(await modelResponse.arrayBuffer()), delegate: 'CPU' },
      canvas: new OffscreenCanvas(1, 1), runningMode: 'VIDEO', minDetectionConfidence: 0.7,
    });
    self.postMessage({ type: 'ready' });
  } catch {
    self.postMessage({ type: 'failed', code: 'detector-unavailable' });
  } finally { if (binaryURL) URL.revokeObjectURL(binaryURL); }
}

self.onmessage = event => {
  const { type, id, image, timestamp } = event.data || {};
  if (type !== 'detect') return;
  try {
    if (!detector || !image || !Number.isFinite(timestamp)) throw Error('not-ready');
    const result = detector.detectForVideo(image, timestamp);
    if (!Array.isArray(result?.detections)) throw Error('invalid-result');
    // Return only whether a face was detected. Do not retain boxes, keypoints,
    // identity information, or the input image; this does not establish gaze.
    self.postMessage({ type: 'result', id, presence: result.detections.length ? 'present' : 'absent' });
  } catch { self.postMessage({ type: 'result', id, presence: 'unknown', error: true }); }
  finally { image?.close?.(); }
};

void initialize();
