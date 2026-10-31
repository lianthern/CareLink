import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('..', import.meta.url));
const file = name => readFile(join(cwd, 'public', name), 'utf8');

test('isolated App document serves deep links while frozen legacy routes retain their own documents', { timeout:15000 }, async t => {
  const reserve = createServer(); reserve.listen(0,'127.0.0.1'); await once(reserve,'listening');
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const stateDir = await mkdtemp(join(tmpdir(),'unseen-route-qa-'));
  const child = spawn(process.execPath,['server.mjs'],{cwd,stdio:['ignore','pipe','pipe'],env:{...process.env,PORT:String(port),STATE_DIRECTORY:stateDir,MINIMAX_API_KEY:'',WORLDLABS_API_KEY:''}});
  let output = ''; child.stdout.on('data',data=>output+=data); child.stderr.on('data',data=>output+=data);
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await once(child,'exit');}await rm(stateDir,{recursive:true,force:true});});
  const base = `http://127.0.0.1:${port}`;
  for(let i=0;i<100;i++){try{if((await fetch(`${base}/api/health`)).ok)break;}catch{}if(child.exitCode!==null)throw new Error(output);await new Promise(resolve=>setTimeout(resolve,20));}
  const routes = {
    '/':'spatial-lab.html','/demo':'spatial-lab.html','/demo/':'spatial-lab.html','/index.html':'index.html',
    '/unseen-demo':'unseen-demo.html','/unseen-demo/':'unseen-demo.html','/unseen-3':'unseen-demo.html',
    '/unseen-dap':'unseen-dap.html','/world':'world-lab.html','/world-lab':'world-lab.html',
    '/app':'unseen-app.html','/app/':'unseen-app.html','/app/case/summer-gathering':'unseen-app.html',
    '/app?case=summer-book':'unseen-app.html','/app/case/adventurex':'unseen-app.html'
  };
  for (const [route,document] of Object.entries(routes)) {
    const response = await fetch(base+route,{redirect:'manual'});
    assert.equal(response.status,200,route);
    assert.equal(await response.text(),await file(document),route);
  }
  const manifest=JSON.parse(await readFile(join(cwd,'.task/app-loading/asset-build.json'),'utf8'));
  const preview=JSON.parse(await readFile(join(cwd,'.task/app-loading/thumbnail-receipt.json'),'utf8'))[0].variants[0].url;
  const original=JSON.parse(await readFile(join(cwd,'.task/app-loading/original-receipt.json'),'utf8'))[0].url;
  for(const path of [manifest.prefix+'/moment-app.js',manifest.prefix+'/moment-app.css',...manifest.bundles.map(name=>manifest.prefix+'/'+name),preview,original]){
    const first=await fetch(base+path);assert.equal(first.status,200,path);assert.match(first.headers.get('cache-control'),/^public,.*immutable$/);await first.arrayBuffer();
    const second=await fetch(base+path,{headers:{'if-none-match':first.headers.get('etag')}});assert.equal(second.status,304,path);assert.equal((await second.arrayBuffer()).byteLength,0);
  }
  for(const path of ['/app','/api/moment-examples','/v1/profile','/v1/moment-media/missing','/v1/app-spaces']){
    const response=await fetch(base+path);assert.match(response.headers.get('cache-control'),/no-store/,path);assert.doesNotMatch(response.headers.get('cache-control'),/public|immutable/,path);
  }
  assert.equal((await fetch(base+manifest.prefix+'/missing.js')).status,404);
  assert.match((await fetch(base+manifest.prefix+'/missing.js')).headers.get('cache-control'),/no-store/);
  const app = await file('unseen-app.html'); const old = await file('unseen-demo.html');
  assert.match(app, /import\('\/app-assets\/[a-f0-9]{24}\/optimized\/moment-app\.js'\)/);
  assert.match(app, /UNSEEN 回忆时刻/);
  assert.doesNotMatch(app, /src="\/unseen-app\.js/);
  assert.doesNotMatch(old,/unseen-app\.(?:js|css)|unseen-refinement\.css/);
});

test('legacy M0 presentation remains byte-identical apart from the deliberate data-fix script cache version', async () => {
  const baseline = JSON.parse(await readFile(join(cwd,'test/fixtures/legacy-presentation-hashes.json'),'utf8'));
  const digest = text => createHash('sha256').update(text).digest('hex');
  const normalize = html => html.replace(/unseen-demo\.js\?v=[^"\s]+/g,'unseen-demo.js?v=CONTENT_VERSION');
  assert.equal(digest(await file('unseen-demo.css')),baseline.css);
  assert.equal(digest(normalize(await file('unseen-demo.html'))),baseline.normalizedHtml);
});
