import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { clampSpatialPosition } from '../public/unseen-app-spatial.js';

test('DAP motion is clamped to 0.42m in every direction, including diagonal movement', () => {
  for (let angle = 0; angle < Math.PI * 2; angle += .03) {
    for (const distance of [0, .1, .42, .6, 10, 1000]) {
      const next = clampSpatialPosition(Math.cos(angle) * distance, Math.sin(angle) * distance);
      assert.ok(Math.hypot(next.x, next.z) <= .4200000001);
      if (distance <= .42) assert.ok(Math.abs(Math.hypot(next.x, next.z) - distance) < 1e-10);
    }
  }
  assert.deepEqual(clampSpatialPosition(1,1,0), { x:0,z:0 });
  assert.deepEqual(clampSpatialPosition(4,0,100), { x:.42,z:0 });
});

test('DAP sampling metadata and calibrated renderer retain the existing fixed-scene contract', async () => {
  const metadata = JSON.parse(await readFile(new URL('../public/unseen-dap/v1/assets/ballroom-depth.json', import.meta.url)));
  assert.ok(metadata.min * 100 > 0 && metadata.max > metadata.min);
  const minimumWallLimit = 1.8 * .55;
  assert.ok(minimumWallLimit > .42, 'Original directional depth clamp never tightens the 0.42m radius because raw scene depth is clamped above 1.8m');
});

test('spatial body reads are bounded and cancel when navigation aborts', async t => {
  const { readSpatialResource } = await import('../public/unseen-app-spatial.js');
  t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(5)));
  await assert.rejects(readSpatialResource('/asset', { maxBytes: 4 }), /资源过大/);
  globalThis.fetch.mock.mockImplementation(async () => new Response(new Uint8Array(3), { headers: { 'content-length': '90' } }));
  await assert.rejects(readSpatialResource('/asset', { maxBytes: 4 }), /资源过大/);
  globalThis.fetch.mock.mockImplementation(async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) { signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true }); }
  })));
  const navigation = new AbortController();
  const pending = readSpatialResource('/asset', { signal: navigation.signal });
  navigation.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(readSpatialResource('/asset', { timeoutMs: 5 }), { name: 'AbortError' });
});
