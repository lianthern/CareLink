'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('supplier probe defaults to a zero-network plan', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [path.join(__dirname, '../scripts/check-realtime-call.mjs')]);
  const report = JSON.parse(stdout); assert.equal(report.mode, 'plan-only'); assert.equal(report.networkRequests, 0); assert.equal(report.realtimeStarts, 0);
});

test('detached cleanup repeats only the same Stop and revokes only an orphaned session', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'realtime-probe-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const parentAlive of [true, false]) {
    const filename = path.join(directory, parentAlive ? 'alive.json' : 'orphan.json');
    const requestId = '11111111-1111-4111-8111-111111111111';
    await fs.writeFile(filename, JSON.stringify({ origin: 'https://memory-frame-demo-d7djiee0702b6c.service.tcloudbase.com', token: 'local-only-fixture', requestId,
      stopAt: Date.now() - 11000, closed: false, ...(parentAlive ? { parentPid: process.pid } : {}) }));
    // Every fetch is replaced before the script loads; this child cannot contact
    // Tencent. Validate request identity and stop-only behavior inside the stub.
    const preload = `globalThis.fetch=async(url,options)=>{const value=JSON.parse(options.body); if(!['aiRealtimeStop','logout'].includes(value.action))throw Error('unexpected action'); if(value.action==='aiRealtimeStop' && value.data.requestId!=='${requestId}')throw Error('wrong ID'); return {ok:true,json:async()=>({status:'ended'})};};`;
    await promisify(execFile)(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload), path.join(__dirname, '../scripts/check-realtime-call.mjs'), '--watchdog', filename]);
    const report = JSON.parse(await fs.readFile(filename + '.watchdog.json', 'utf8'));
    assert.equal(report.ended, true); assert.equal(report.sessionRevoked, !parentAlive);
  }
});

test('isolated probe publishes synthetic audio, records a test remote track and guards duplicate Start', { skip: !process.env.AI_UX_PLAYWRIGHT || !process.env.AI_UX_CHROME }, async t => {
  const { installRealtimeProbe } = await import('../scripts/lib/realtime-probe-browser.mjs');
  const client = await fs.readFile(path.join(__dirname, '../server/public/ai-realtime.js'));
  const actions = [];
  const sdk = `const EVENT = Object.fromEntries(['ERROR','KICKED_OUT','AUTOPLAY_FAILED','CONNECTION_STATE_CHANGED','REMOTE_AUDIO_AVAILABLE','REMOTE_USER_EXIT','TRACK'].map(key => [key,key]));
    export default { EVENT, setLogLevel(){}, create(){ const listeners={}; return {
      on(key,callback){ (listeners[key] ||= []).push(callback); }, async enterRoom(){},
      async startLocalAudio(options){
        const track=options.option.audioTrack.clone();
        for(const callback of listeners.TRACK || [])callback({userId:'test-bot',track});
        for(const callback of listeners.REMOTE_AUDIO_AVAILABLE || [])callback({userId:'test-bot'});
      }, async updateLocalAudio(){}, async muteRemoteAudio(){}, async stopLocalAudio(){}, async exitRoom(){}, destroy(){}
    }; } };`;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api') {
      let body = ''; for await (const chunk of req) body += chunk;
      const data = JSON.parse(body); actions.push(data);
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(data.action === 'aiRealtimeStart'
        ? { status: 'active', provider: 'tencent-trtc', expiresAt: Date.now() + 600000, connection: { agentId: 'test-bot' } }
        : { status: data.action === 'aiRealtimeStop' ? 'ended' : 'active' }));
    }
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/ai-realtime.js' || pathname === '/vendor/trtc-5.19.2.mjs') {
      res.setHeader('Content-Type', 'text/javascript'); return res.end(req.url.includes('vendor') ? sdk : client);
    }
    res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Isolated synthetic probe test</title><script src="/ai-realtime.js"></script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { chromium } = require(process.env.AI_UX_PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath: process.env.AI_UX_CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
  const context = await browser.newContext({ permissions: [] }), page = await context.newPage();
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const samples = 24000, wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 16000) * 9000), 44 + i * 2);
  const id = '11111111-1111-4111-8111-111111111111';
  await page.evaluate(installRealtimeProbe, { token: 'synthetic-test-only', requestId: id, wavBase64: wav.toString('base64'), stopAt: Date.now() + 10000 });
  assert.deepEqual(actions, []);
  await page.evaluate(async () => { await Promise.all([realtimeProbe.start(), realtimeProbe.start()]); });
  await page.waitForFunction(() => realtimeProbe.result.remoteAudioNonzero, null, { timeout: 5000 });
  await page.evaluate(() => realtimeProbe.stop());
  const result = await page.evaluate(() => realtimeProbe.result);
  for (const key of ['sdkEnteredRoom', 'localAudioPublished', 'syntheticAudioPlayed', 'remoteAudioTrack', 'remoteAudioNonzero', 'stopConfirmed']) assert.equal(result[key], true, key);
  assert.equal(result.physicalDeviceAttempts, 0); assert.equal(result.startAttempts, 1);
  assert.equal(actions.filter(item => item.action === 'aiRealtimeStart').length, 1); assert.ok(actions.every(item => item.data.requestId === id));
  const recording = await page.evaluate(() => realtimeProbe.recording()); assert.ok(Buffer.from(recording, 'base64').length > 100);
  t.diagnostic('Real isolated Chrome/WebAudio/MediaRecorder with local API and SDK doubles; no supplier, cloud, physical camera or microphone used.');
});
