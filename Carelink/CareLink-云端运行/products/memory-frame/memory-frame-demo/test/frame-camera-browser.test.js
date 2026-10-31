'use strict';
// Production HTTP/CSP + real Chrome. Camera streams, speech and AI are synthetic.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/server');
const { LocalStore } = require('../server/store');

test('frame browser camera consent, dwell invitation and lifecycle', {
  skip: !process.env.AI_UX_PLAYWRIGHT || !process.env.AI_UX_CHROME,
}, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-camera-browser-'));
  const app = await createApp({ store: new LocalStore(dir), setupCode: 'isolated-camera-test' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const { chromium } = require(process.env.AI_UX_PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath: process.env.AI_UX_CHROME, headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  t.after(async () => { await browser.close(); await new Promise(resolve => app.server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  async function fixture({ detectorDouble = true, role = 'frame', nativeFakeCamera = false } = {}) {
    const context = await browser.newContext({ viewport: { width: 1180, height: 820 } });
    const page = await context.newPage(), actions = [], errors = [], foreignRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (!request.url().startsWith(origin) && !request.url().startsWith('blob:')) foreignRequests.push(request.url()); });
    await page.addInitScript(({ role, nativeFakeCamera }) => {
      localStorage.setItem('memory-session-' + (role === 'frame' ? 'frame' : 'family'), JSON.stringify({ token: 'synthetic-camera-session', room: 'camera-room', name: '测试相框', role }));
      window.captureRequests = []; window.captureStreams = []; window.detectorCloses = 0;
      window.faceObservation = 'absent'; window.spokenInvitations = []; window.cancelledSpeech = 0;
      window.hiddenForTest = false; window.rejectCamera = ''; window.holdCamera = false;
      Object.defineProperty(document, 'hidden', { get: () => window.hiddenForTest });
      Object.defineProperty(window, 'speechSynthesis', { value: {
        speaking: false, getVoices: () => [], cancel() { this.speaking = false; window.cancelledSpeech++; },
        speak(value) { window.spokenInvitations.push(value.text); },
      } });
      window.SpeechSynthesisUtterance = function(text) { this.text = text; };
      if (nativeFakeCamera) return;
      navigator.mediaDevices.enumerateDevices = async () => [{ kind: 'videoinput', deviceId: 'usb-test', label: 'USB 测试摄像头' }];
      navigator.mediaDevices.getUserMedia = async constraints => {
        window.captureRequests.push(constraints);
        if (window.rejectCamera) throw new DOMException('synthetic camera error', window.rejectCamera);
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
        const context = canvas.getContext('2d'); context.fillStyle = '#a0a0a0'; context.fillRect(0, 0, 640, 480);
        const stream = canvas.captureStream(5); window.captureStreams.push(stream);
        if (window.holdCamera) await new Promise(resolve => { window.releaseCamera = resolve; });
        return stream;
      };
    }, { role, nativeFakeCamera });
    const snapshot = { room: { name: '摄像头合成验收' }, members: [], people: [], receipts: [], messages: [{
      _id: 'photo-one', type: 'photo', image: 'synthetic-image', imageURL: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#9aa"/></svg>'), title: '测试照片', createdAt: 1, name: '家人',
    }] };
    await page.route('**/api', route => {
      const body = route.request().postDataJSON(); actions.push(body);
      const result = { state: { ...snapshot, serverTime: Date.now() }, framePresence: { ok: true }, receipt: { ok: true }, contactState: { members: [], requests: [] }, aiCapabilities: { text: true, vision: true, asr: false }, aiRealtimeCapabilities: { enabled: false }, aiChat: { answer: '这张照片让您想起了什么？', imageUsed: true, action: null }, logout: { ok: true } }[body.action] || {};
      return route.fulfill({ json: result });
    });
    if (detectorDouble) await page.route('**/camera-face-detector.mjs*', route => route.fulfill({ contentType: 'application/javascript', body: `export async function createLocalFaceDetector(){return {capabilities:{presence:true,gaze:false},async detect(){return {presence:window.faceObservation,attention:'unknown'}},close(){window.detectorCloses++}}}` }));
    await page.goto(origin + (role === 'frame' ? '/frame' : '/family'));
    await page.waitForFunction(() => document.querySelector('#caption')?.textContent.includes('测试照片'));
    return { page, actions, errors, foreignRequests,
      async open() { await page.locator('#frameMenu summary').click(); await page.locator('#frameCameraEntry').click(); },
      async enable() { await this.open(); await page.locator('#frameCameraStart').click(); await page.waitForFunction(() => document.querySelector('#frameCameraEntry')?.textContent.includes('已开启')); },
      async finish() { assert.deepEqual(errors, []); assert.deepEqual(foreignRequests, []); await context.close(); },
    };
  }

  await t.test('real bundled MediaPipe initializes under production CSP and rejects a blank frame without any camera permission', async () => {
    const f = await fixture({ detectorDouble: false });
    try {
      const result = await f.page.evaluate(async () => {
        const { createLocalFaceDetector } = await import('/camera-face-detector.mjs');
        const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
        const context = canvas.getContext('2d'); context.fillStyle = '#a0a0a0'; context.fillRect(0, 0, 320, 240);
        const detector = await createLocalFaceDetector({ createBitmap: () => createImageBitmap(canvas) });
        try { return await detector.detect({ readyState: 2, videoWidth: 320, videoHeight: 240, currentTime: 1 }); }
        finally { detector.close(); }
      });
      assert.deepEqual(result, { presence: 'absent', attention: 'unknown' });
      assert.equal(await f.page.evaluate(() => captureRequests.length), 0);
    } finally { await f.finish(); }
  });

  await t.test('production frame permissions allow real browser getUserMedia through Chrome fake hardware; family remains camera-disabled', async () => {
    const f = await fixture({ detectorDouble: false, nativeFakeCamera: true });
    try {
      const result = await f.page.evaluate(async () => {
        const allowed = document.featurePolicy.allowsFeature('camera');
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        const live = stream.getVideoTracks().length === 1 && stream.getVideoTracks()[0].readyState === 'live';
        stream.getTracks().forEach(track => track.stop());
        return { allowed, live, audioTracks: stream.getAudioTracks().length };
      });
      assert.deepEqual(result, { allowed: true, live: true, audioTracks: 0 });
      await f.page.goto(origin + '/family');
      assert.equal(await f.page.evaluate(() => document.featurePolicy.allowsFeature('camera')), false);
    } finally { await f.finish(); }
  });

  await t.test('USB opt-in triggers one spoken invitation after dwell; cloud polling cannot close it; AI waits for acceptance', async () => {
    const f = await fixture(); try {
      assert.equal(await f.page.evaluate(() => captureRequests.length), 0);
      await f.open(); await f.page.locator('#frameCameraDevice').selectOption('usb-test');
      await f.page.locator('#frameCameraStart').click();
      await f.page.waitForFunction(() => document.querySelector('#frameCameraEntry')?.textContent.includes('已开启'));
      assert.deepEqual(await f.page.evaluate(() => captureRequests[0].video.deviceId), { exact: 'usb-test' });
      assert.equal(await f.page.evaluate(() => captureRequests[0].audio), false);
      await f.page.evaluate(() => { window.faceObservation = 'present'; });
      await f.page.locator('#presenceInvitation').waitFor({ state: 'visible', timeout: 7000 });
      await f.page.evaluate(() => poll());
      assert.equal(await f.page.locator('#presenceInvitation').isVisible(), true);
      assert.equal(await f.page.evaluate(() => spokenInvitations.length), 1);
      assert.equal(f.actions.some(item => ['aiChat', 'aiTranscribe', 'aiRealtimeStart', 'upload'].includes(item.action)), false);
      await f.page.locator('#presenceAccept').click();
      await f.page.waitForFunction(() => document.querySelector('#aiMessages')?.textContent.includes('这张照片让您想起了什么'));
      const chats = f.actions.filter(item => item.action === 'aiChat'); assert.equal(chats.length, 1); assert.deepEqual(chats[0].data.messageIds, ['photo-one']);
      await f.page.waitForFunction(() => captureStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')));
      assert.equal(await f.page.evaluate(() => captureRequests.some(constraints => constraints.audio !== false)), false);
    } finally { await f.finish(); }
  });

  await t.test('declining does not ask again during the same visit and stopping releases all tracks', async () => {
    const f = await fixture(); try {
      await f.enable(); await f.page.evaluate(() => { window.faceObservation = 'present'; });
      await f.page.locator('#presenceInvitation').waitFor({ state: 'visible', timeout: 7000 });
      await f.page.locator('#presenceDecline').click();
      await f.page.waitForTimeout(3300);
      assert.equal(await f.page.locator('#presenceInvitation').count(), 0);
      assert.equal(await f.page.evaluate(() => spokenInvitations.length), 1);
      assert.equal(f.actions.some(item => item.action === 'aiChat'), false);
      await f.page.evaluate(() => MemoryCamera.stop());
      assert.equal(await f.page.evaluate(() => captureStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended'))), true);
      assert.equal(await f.page.evaluate(() => detectorCloses), 1);
    } finally { await f.finish(); }
  });

  await t.test('verified absence withdraws a local invitation without opening AI', async () => {
    const f = await fixture(); try {
      await f.enable(); await f.page.evaluate(() => { window.faceObservation = 'present'; });
      await f.page.locator('#presenceInvitation').waitFor({ state: 'visible', timeout: 7000 });
      await f.page.evaluate(() => { window.faceObservation = 'absent'; });
      await f.page.locator('#presenceInvitation').waitFor({ state: 'detached' });
      assert.equal(f.actions.some(item => item.action === 'aiChat'), false);
    } finally { await f.finish(); }
  });

  for (const cause of ['night', 'session', 'unplug']) await t.test(cause + ' ends the frame camera session', async () => {
    const f = await fixture(); try {
      await f.enable();
      await f.page.evaluate(cause => {
        if (cause === 'night') document.documentElement.classList.add('night-view');
        else if (cause === 'session') expireSession();
        else { const track = captureStreams[0].getVideoTracks()[0]; track.stop(); track.dispatchEvent(new Event('ended')); }
      }, cause);
      await f.page.waitForFunction(() => captureStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')));
      await f.page.waitForFunction(() => detectorCloses > 0);
      assert.equal(await f.page.locator('#presenceInvitation').count(), 0);
    } finally { await f.finish(); }
  });

  for (const action of ['logout', 'rejoin']) await t.test('blocked ' + action + ' stops capture but keeps a usable camera entry', async () => {
    const f = await fixture(); try {
      await f.enable();
      await f.page.evaluate(async action => {
        sending = true;
        try { if (action === 'logout') await logoutSession(); else await rejoinSession(); }
        finally { sending = false; }
      }, action);
      assert.equal(await f.page.locator('#frameCameraEntry').count(), 1);
      assert.equal(await f.page.evaluate(() => captureStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended'))), true);
      await f.open(); assert.equal(await f.page.locator('#frameCameraStart').isEnabled(), true);
    } finally { await f.finish(); }
  });

  await t.test('background closes camera and invitation; visibility restoration never reopens capture', async () => {
    const f = await fixture(); try {
      await f.enable(); await f.page.evaluate(() => { window.faceObservation = 'present'; });
      await f.page.locator('#presenceInvitation').waitFor({ state: 'visible', timeout: 7000 });
      await f.page.evaluate(() => { window.hiddenForTest = true; document.dispatchEvent(new Event('visibilitychange')); });
      assert.equal(await f.page.locator('#presenceInvitation').count(), 0);
      assert.equal(await f.page.evaluate(() => captureStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended'))), true);
      await f.page.evaluate(() => { window.hiddenForTest = false; document.dispatchEvent(new Event('visibilitychange')); });
      await f.page.waitForTimeout(400);
      assert.equal(await f.page.evaluate(() => captureRequests.length), 1);
    } finally { await f.finish(); }
  });

  await t.test('permission denial has a useful retry path and stop releases a late granted stream', async () => {
    const f = await fixture(); try {
      await f.page.evaluate(() => { window.rejectCamera = 'NotAllowedError'; });
      await f.open(); await f.page.locator('#frameCameraStart').click();
      await f.page.waitForFunction(() => document.querySelector('#frameCameraStatus')?.textContent.includes('未获允许'));
      assert.equal(await f.page.locator('#frameCameraStart').isEnabled(), true);
      await f.page.evaluate(() => { window.rejectCamera = ''; window.holdCamera = true; });
      await f.page.locator('#frameCameraStart').click();
      await f.page.waitForFunction(() => !!window.releaseCamera);
      await f.page.locator('#frameCameraStop').click(); await f.page.evaluate(() => releaseCamera());
      await f.page.waitForFunction(() => captureStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')));
      assert.equal(await f.page.locator('#frameCameraStart').isEnabled(), true);
      assert.equal(await f.page.locator('#presenceInvitation').count(), 0);
    } finally { await f.finish(); }
  });

  await t.test('family page does not mount camera controls or request capture', async () => {
    const f = await fixture({ role: 'family' }); try {
      assert.equal(await f.page.locator('#frameCameraEntry').count(), 0);
      assert.equal(await f.page.evaluate(() => captureRequests.length), 0);
    } finally { await f.finish(); }
  });
});
