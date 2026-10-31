'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const root = path.join(__dirname, '..');
const sdkPath = path.join(root, 'server/public/vendor/trtc-5.19.2.mjs');

test('vendored SDK has no unresolved module dependencies and matches locked build digest', async () => {
  // Parse only, never execute the vendor. The original unbundled file reports
  // webrtc-adapter here, catching the real failure even without a browser.
  const dependencies = JSON.parse(execFileSync(process.execPath, ['--experimental-vm-modules', '-e',
    "const fs=require('node:fs'),vm=require('node:vm');process.stdout.write(JSON.stringify(new vm.SourceTextModule(fs.readFileSync(process.argv[1],'utf8')).dependencySpecifiers));", sdkPath],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.deepEqual(dependencies, []);
  const bytes = await fs.readFile(sdkPath), manifest = JSON.parse(await fs.readFile(path.join(root, 'server/public/vendor/trtc-5.19.2-build.json'), 'utf8'));
  assert.equal(bytes.length, manifest.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.sha256);
  assert.equal(manifest.runtimeDependencies['trtc-sdk-v5'].version, '5.19.2');
  assert.equal(manifest.runtimeDependencies['webrtc-adapter'].version, '9.0.4');
});

test('real isolated Chrome imports, configures, creates and destroys shipped TRTC under current CSP with zero Start',
  { skip: !process.env.AI_UX_PLAYWRIGHT || !process.env.AI_UX_CHROME }, async t => {
  const sdk = await fs.readFile(sdkPath);
  const source = await fs.readFile(path.join(root, 'server/server.js'), 'utf8');
  const csp = "default-src 'self'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; style-src 'self'; script-src 'self' 'wasm-unsafe-eval'; font-src 'self'; connect-src 'self' blob:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
  assert(source.includes("script-src 'self' 'wasm-unsafe-eval';")); assert(source.includes("worker-src 'self' blob:;"));
  const entry = `window.sdkSmoke={stage:'import',physicalMediaAttempts:0,apiCalls:0,violations:[]};
    document.addEventListener('securitypolicyviolation',event=>sdkSmoke.violations.push(event.violatedDirective));
    const deny=async()=>{sdkSmoke.physicalMediaAttempts++;throw Error('Physical media forbidden')};
    navigator.mediaDevices.getUserMedia=deny;navigator.mediaDevices.getDisplayMedia=deny;
    (async()=>{try{
      const TRTC=(await import('/vendor/trtc-5.19.2.mjs')).default;
      sdkSmoke.stage='logging';TRTC.setLogLevel(5,false);
      sdkSmoke.stage='create';const rtc=TRTC.create();
      for(const name of ['ERROR','KICKED_OUT','AUTOPLAY_FAILED','CONNECTION_STATE_CHANGED','REMOTE_AUDIO_AVAILABLE','REMOTE_USER_EXIT','TRACK']){
        if(typeof TRTC.EVENT[name]!=='string')throw Error('Missing event');rtc.on(TRTC.EVENT[name],()=>{});
      }
      sdkSmoke.stage='destroy';await rtc.destroy();sdkSmoke.stage='done';
    }catch(error){sdkSmoke.error=String(error.message);sdkSmoke.stage='failed';}})();`;
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('Permissions-Policy', 'microphone=(), camera=()');
    if (req.url === '/vendor/trtc-5.19.2.mjs') { res.setHeader('Content-Type', 'text/javascript'); return res.end(sdk); }
    if (req.url === '/smoke.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(entry); }
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><title>Isolated zero-call TRTC smoke test</title><script src="/smoke.js"></script>'); }
    res.statusCode = 404; res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { chromium } = require(process.env.AI_UX_PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath: process.env.AI_UX_CHROME, headless: true, args: ['--mute-audio'] });
  t.after(() => browser.close());
  const context = await browser.newContext({ permissions: [] }), page = await context.newPage();
  const unexpected = [], pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin && ['/', '/smoke.js', '/vendor/trtc-5.19.2.mjs', '/favicon.ico'].includes(url.pathname)) return route.continue();
    unexpected.push(url.origin); return route.abort();
  });
  await page.goto(origin);
  await page.waitForFunction(() => ['done', 'failed'].includes(window.sdkSmoke?.stage), null, { timeout: 15000 });
  const result = await page.evaluate(() => sdkSmoke);
  assert.equal(result.stage, 'done', result.error); assert.equal(result.physicalMediaAttempts, 0);
  assert.deepEqual(result.violations, []); assert.deepEqual(unexpected, []); assert.deepEqual(pageErrors, []);
  assert(requests.every(url => !url.startsWith('/api')));
  t.diagnostic('Real shipped SDK + real Chrome + existing CSP; import/setLogLevel/create/destroy only, zero cloud/Start/physical-media calls.');
});
