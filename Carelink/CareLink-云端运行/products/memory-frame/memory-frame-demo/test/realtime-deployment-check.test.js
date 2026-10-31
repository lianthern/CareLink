'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('deployment verifier checks on/off capabilities, page policies and camera artifacts without starting services', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'realtime-deployment-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const publicRoot = path.join(directory, 'server/public'); await fs.mkdir(path.join(directory, 'scripts'), { recursive: true });
  const script = path.join(directory, 'scripts/check-realtime-deployment.mjs');
  await fs.copyFile(path.join(__dirname, '../scripts/check-realtime-deployment.mjs'), script);
  const files = ['app.js', 'style.css', 'frame-presentation.js', 'frame-presentation.css', 'frame-camera.js', 'camera-presence.mjs',
    'camera-adapters.mjs', 'camera-face-detector.mjs', 'camera-face-worker.js', 'presence-invitation.js', 'vendor/trtc-5.19.2.mjs'];
  for (const file of files) { await fs.mkdir(path.dirname(path.join(publicRoot, file)), { recursive: true }); await fs.writeFile(path.join(publicRoot, file), '/* fixture ' + file + ' */'); }
  await fs.writeFile(path.join(publicRoot, 'index.html'), '<!doctype html><link rel="stylesheet" href="/style.css?v=0.5.0"><script src="/frame-camera.js?v=0.5.0"></script><script src="/frame-presentation.js?v=0.5.0"></script><script src="/app.js?v=0.5.0"></script>');
  const assetRoot = path.join(publicRoot, 'assets/mediapipe-face/1.0.1'); await fs.mkdir(assetRoot, { recursive: true });
  const manifest = {};
  for (const file of ['LICENSE', 'blaze_face_short_range.tflite', 'vision_bundle.js', 'vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.wasm.gz']) {
    const bytes = Buffer.from('local fixture ' + file); manifest[file] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    await fs.writeFile(path.join(assetRoot, file), bytes);
  }
  await fs.writeFile(path.join(assetRoot, 'manifest.json'), JSON.stringify(manifest));
  const accounts = path.join(directory, 'accounts.private.json');
  await fs.writeFile(accounts, JSON.stringify({ accounts: [{ username: 'fixture-owner', password: 'fixture-pass-only' }, { username: 'fixture-family', password: 'fixture-pass-only' }] }));
  const preload = path.join(directory, 'fetch-fixture.mjs');
  await fs.writeFile(preload, `import fs from 'node:fs/promises'; import path from 'node:path';
    const active = new Set(); let logins = 0; const root = process.env.VERIFIER_FIXTURE_ROOT;
    const enabled = process.env.VERIFIER_FIXTURE_ENABLED === 'true', mismatch = process.env.VERIFIER_FIXTURE_MISMATCH;
    const json = (value,status=200) => new Response(JSON.stringify(value), {status,headers:{'Content-Type':'application/json'}});
    globalThis.fetch = async (value,options={}) => {
      const url = new URL(value); if(url.origin !== 'https://memory-frame-demo-d7djiee0702b6c.service.tcloudbase.com') throw Error('Unexpected origin');
      const body = options.body ? JSON.parse(options.body) : null;
      await fs.appendFile(process.env.VERIFIER_FIXTURE_TRACE, JSON.stringify({route:url.pathname,action:body?.action})+'\\n');
      if(url.pathname === '/api/health')return json({version:'0.5.0',storage:'cloudbase'});
      if(url.pathname === '/api') {
        if(!['login','logout','state','aiCapabilities','aiRealtimeCapabilities','callCapabilities'].includes(body.action))throw Error('Forbidden service action');
        const token = (options.headers.Authorization || '').replace('Bearer ','');
        if(body.action === 'login') { const token='fixture-token-'+(++logins); active.add(token); return json({token,room:'same-fixture-family',role:logins===1?'owner':'family'}); }
        if(!active.has(token))return json({error:'fixture unauthorized'},401);
        if(body.action === 'logout'){active.delete(token);return json({ok:true});}
        if(body.action === 'state')return json({messagePage:{total:17}});
        if(body.action === 'aiCapabilities')return json({text:true,vision:true});
        if(body.action === 'callCapabilities')return json({enabled:false,audioCall:false});
        return json({enabled:mismatch==='capabilities'?!enabled:enabled,provider:'tencent-trtc'});
      }
      const document = ['/family','/frame'].includes(url.pathname);
      const filename = document ? 'index.html' : url.pathname.slice(1);
      let bytes=await fs.readFile(path.join(root,'server/public',filename));
      if(mismatch==='asset' && filename.endsWith('.tflite'))bytes=Buffer.from('tampered camera model');
      const rtc = enabled ? ' https://*.rtc.qq.com wss://*.rtc.qq.com https://*.webrtc.qq.com wss://*.webrtc.qq.com https://*.rtc.qcloud.com wss://*.rtc.qcloud.com https://*.cloud-rtc.com wss://*.cloud-rtc.com https://*.cloud-rtc.net wss://*.cloud-rtc.net https://*.my-imcloud.com wss://*.my-imcloud.com https://*.rtc-web.com wss://*.rtc-web.com https://*.rtc-web.io wss://*.rtc-web.io https://yun.tim.qq.com https://web.sdk.qcloud.com' : '';
      const connect = mismatch==='csp' ? " 'self' blob: https:" : " 'self' blob:"+rtc;
      const headers={'Content-Type':/\\.(js|mjs)$/.test(filename)?'application/javascript':document?'text/html':'application/octet-stream',
        'Cache-Control':document?'no-store':'public,max-age=600',
        'Permissions-Policy': 'microphone=(self), camera=('+(url.pathname==='/frame' && mismatch!=='permissions'?'self':'')+')',
        'Content-Security-Policy': "default-src 'self'; connect-src"+connect+"; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:;"};
      return new Response(bytes,{status:200,headers});
    };`);
  for (const scenario of [
    { name: 'off-by-default', enabled: false, success: true, logins: 2 },
    { name: 'explicit-on', enabled: true, success: true, logins: 2 },
    { name: 'wrong-capability', enabled: true, mismatch: 'capabilities', success: false, logins: 1 },
    { name: 'wide-csp', enabled: false, mismatch: 'csp', success: false, logins: 0 },
    { name: 'frame-camera-denied', enabled: false, mismatch: 'permissions', success: false, logins: 0 },
    { name: 'wrong-camera-model', enabled: false, mismatch: 'asset', success: false, logins: 0 },
  ]) await t.test(scenario.name, async () => {
    const reportPath = path.join(directory, scenario.name + '.json'), tracePath = path.join(directory, scenario.name + '.trace');
    const args = ['--import', preload, script, accounts, reportPath, '0.5.0', ...(scenario.enabled ? ['--realtime-enabled=true'] : [])];
    let output;
    try { output = await promisify(execFile)(process.execPath, args, { env: { ...process.env, VERIFIER_FIXTURE_ROOT: directory,
      VERIFIER_FIXTURE_ENABLED: String(scenario.enabled), VERIFIER_FIXTURE_MISMATCH: scenario.mismatch || '', VERIFIER_FIXTURE_TRACE: tracePath } }); }
    catch (error) { assert.equal(scenario.success, false); assert.equal(error.code, 1); output = error; }
    const report = JSON.parse(await fs.readFile(reportPath, 'utf8')), trace = (await fs.readFile(tracePath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(report.passed, scenario.success); assert.equal(report.expectedRealtimeEnabled, scenario.enabled);
    assert.equal(report.sessionsRevoked, scenario.logins); assert.equal(trace.filter(item => item.action === 'login').length, scenario.logins);
    assert.equal(trace.filter(item => item.action === 'logout').length, scenario.logins);
    assert.equal(report.realtimeStarts, 0); assert.equal(report.modelCalls, 0); assert.equal(report.newFamilies, 0); assert.equal(report.contentWrites, 0);
    assert.equal(report.realtimeTransportVerified, false); assert.doesNotMatch(output.stdout, /fixture-pass-only|fixture-token/);
    if (scenario.success) {
      for (const file of ['frame-camera.js', 'camera-face-worker.js', 'frame-presentation.js', 'assets/mediapipe-face/1.0.1/vision_wasm_nosimd_internal.wasm.gz']) assert.ok(report.staticFiles.some(item => item.file === file), file);
      assert.deepEqual(report.checks.filter(item => item?.check === 'document-policy').map(item => [item.route, item.cameraAllowed]).sort(), [['/family', false], ['/frame', true]]);
    }
  });
});
