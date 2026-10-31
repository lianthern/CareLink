'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const detectorModule = import('../server/public/camera-face-detector.mjs');
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

async function fixture(options = {}) {
  const { createLocalFaceDetector } = await detectorModule;
  let terminated = 0, closedImages = 0, id = 0;
  const jobs = new Map(), requests = [];
  const worker = { terminate() { terminated++; }, postMessage(value) { requests.push(value); } };
  const abort = new AbortController();
  const startup = createLocalFaceDetector({ signal: abort.signal,
    createWorker: () => worker,
    createBitmap: async () => ({ close() { closedImages++; } }),
    schedule: fn => { jobs.set(++id, fn); return id; }, cancel: id => jobs.delete(id), ...options });
  return { worker, abort, startup, requests, jobs,
    ready() { worker.onmessage({ data: { type: 'ready' } }); },
    result(presence = 'present') { worker.onmessage({ data: { type: 'result', id: requests.at(-1).id, presence } }); },
    terminated: () => terminated, closedImages: () => closedImages,
    video: { readyState: 2, videoWidth: 640, videoHeight: 480, currentTime: 1 } };
}

test('local detector closes a pending startup on cancellation and ignores a late ready', async () => {
  const f = await fixture(); f.abort.abort(); f.ready();
  await assert.rejects(f.startup, { name: 'AbortError' });
  assert.equal(f.terminated(), 1); assert.equal(f.jobs.size, 0); assert.equal(f.requests.length, 0);
});

test('local detector reports only presence and never gaze; frozen video cannot count as dwell', async () => {
  const f = await fixture(); f.ready(); const detector = await f.startup;
  assert.equal(detector.capabilities.gaze, false);
  const detection = detector.detect(f.video); await settle(); f.result();
  assert.deepEqual(await detection, { presence: 'present', attention: 'unknown' });
  assert.deepEqual(await detector.detect(f.video), { presence: 'unknown', attention: 'unknown' });
  assert.equal(f.requests.length, 1);
  detector.close(); assert.equal(f.terminated(), 1); assert.equal(f.jobs.size, 0);
});

test('local detector releases a bitmap that arrives after capture cancellation', async () => {
  let resolveBitmap;
  const f = await fixture({ createBitmap: () => new Promise(resolve => { resolveBitmap = resolve; }) });
  f.ready(); const detector = await f.startup;
  const read = new AbortController(); const detection = detector.detect(f.video, { signal: read.signal });
  let closed = 0; read.abort(); resolveBitmap({ close() { closed++; } });
  await assert.rejects(detection, { name: 'AbortError' });
  assert.equal(closed, 1); assert.equal(f.requests.length, 0); detector.close();
});

test('local detector cannot return a late observation after cancel or close', async () => {
  for (const mode of ['abort-read', 'close']) {
    const f = await fixture(); f.ready(); const detector = await f.startup;
    const read = new AbortController(); const detection = detector.detect(f.video, { signal: read.signal }); await settle();
    if (mode === 'close') detector.close(); else read.abort();
    f.result(); await assert.rejects(detection, { name: 'AbortError' });
    detector.close(); assert.equal(f.jobs.size, 0); assert.equal(f.terminated(), 1);
  }
});

test('worker failure and detection timeout fail closed and release pending work', async () => {
  for (const mode of ['error', 'timeout']) {
    const f = await fixture(); f.ready(); const detector = await f.startup;
    const detection = detector.detect(f.video); await settle();
    if (mode === 'error') f.worker.onerror({ preventDefault() {} });
    else { const [id, fn] = [...f.jobs.entries()].at(-1); f.jobs.delete(id); fn(); }
    await assert.rejects(detection, /stopped|timed out/);
    assert.equal(f.jobs.size, 0); assert.equal(f.terminated(), 1);
  }
});
