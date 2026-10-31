import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHmac} from 'node:crypto';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const requestId='account-world-request-0001';
const operation={operation_id:'account-world-operation-0001',done:true,response:{world_id:'world-complete-0001',display_name:'Synthetic World',assets:{imagery:{pano_url:'https://cdn.marble.worldlabs.ai/fixture/panorama.jpg'},splats:{spz_urls:{'100k':'https://cdn.marble.worldlabs.ai/fixture/preview.spz'}}}}};
async function fixture(t,{operable=false}={}){
 const directory=await mkdtemp(join(tmpdir(),'world-account-http-')),key=randomBytes(32).toString('hex'),calls=[],imports=new Map();let owner=true,spaceVersion=2,hold=null;
 const canonical=createServer(async(req,res)=>{
  const account=['Bearer session-a','Bearer another-session-a'].includes(req.headers.authorization)?'account-a':req.headers.authorization==='Bearer session-b'?'account-b':null;
  res.setHeader('content-type','application/json');
  const send=(status,body)=>{res.statusCode=status;res.end(JSON.stringify(body));};
  if(!account)return send(401,{error:{code:'session_unavailable'}});
  if(req.url==='/v1/me')return send(200,{accountId:account});
  if(req.headers['x-unseen-expected-account-id']!==account)return send(409,{error:{code:'account_changed'}});
  if(req.url==='/v1/spaces/space-one/management')return send(200,{worldImportConfigured:true,sceneVersion:1,...(operable?{isOwner:owner&&account==='account-a'}:{}),space:{spaceId:'space-one',...(operable?{}:{owner:owner&&account==='account-a'}),version:spaceVersion,spaceLifecycle:'active'}});
  if(req.url==='/v1/spaces/space-one/world-results'){
   const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));const {payload,signature}=body.worldProof;
   assert.equal(signature,createHmac('sha256',key).update(JSON.stringify(payload)).digest('base64url'));assert.equal(payload.accountId,account);assert.equal(payload.spaceId,'space-one');
   assert.equal(req.headers['if-match'],String(payload.spaceVersion));assert.equal(body.sceneIfMatchVersion,payload.sceneVersion);
   let receipt=imports.get(payload.requestId);if(!receipt){receipt={spaceId:payload.spaceId,worldResultId:'world-result-one',sceneVersion:2,spaceVersion:3,active:true};imports.set(payload.requestId,receipt);spaceVersion=3;}return send(200,receipt);
  }
  send(404,{error:{code:'resource_unavailable'}});
 });
 const provider=createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);calls.push(req.url);res.setHeader('content-type','application/json');if(req.url==='/worlds:generate'&&hold){const fn=hold;hold=null;return fn(res);}res.end(JSON.stringify(req.url.startsWith('/worlds/')?operation.response:operation));});
 for(const s of [canonical,provider]){s.listen(0,'127.0.0.1');await once(s,'listening');}
 const children=[];t.after(async()=>{for(const c of children){if(c.exitCode===null&&c.signalCode===null){c.kill('SIGTERM');await once(c,'exit');}}for(const s of [canonical,provider]){s.closeAllConnections();await new Promise(r=>s.close(r));}await rm(directory,{recursive:true,force:true});});
 async function boot({withKey=true}={}){
  const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:'0',STATE_DIRECTORY:directory,CANONICAL_UPSTREAM:`http://127.0.0.1:${canonical.address().port}`,WORLDLABS_BASE_URL:`http://127.0.0.1:${provider.address().port}`,WORLDLABS_API_KEY:'not-a-real-local-account-fixture',MINIMAX_API_KEY:'not-a-real-local-account-fixture',MINIMAX_BASE_URL:'http://127.0.0.1:1',WORLD_RESULT_SIGNING_KEY:withKey?key:'',WORLDLABS_DAILY_LIMIT:'10',WORLDLABS_VISITOR_DAILY_LIMIT:'10'},stdio:['ignore','pipe','pipe']});children.push(child);let stdout='',errors='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>errors+=b);
  for(let i=0;i<200&&!stdout.match(/127\.0\.0\.1:(\d+)/);i++){if(child.exitCode!==null)throw new Error(errors);await delay(10);}const match=stdout.match(/127\.0\.0\.1:(\d+)/);assert.ok(match,errors);
  const base='http://127.0.0.1:'+match[1];return {child,async req(path,{method='GET',account='account-a',session='session-a',body,cookie}={}){const r=await fetch(base+path,{method,headers:{...(account?{'x-unseen-expected-account-id':account}:{}),...(session?{authorization:'Bearer '+session}:{}),...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}};
 }
 return {boot,calls,imports,setOwner(v){owner=v;},hold(fn){hold=fn;},setVersion(v){spaceVersion=v;}};
}
const input=(id=requestId)=>({clientRequestId:id,mode:'single',image:'data:image/jpeg;base64,'+Buffer.alloc(300,7).toString('base64'),publicConsent:true,spaceId:'space-one',spaceVersion:2,sceneVersion:1});
test('production operable ownership admits the owner and rejects other accounts before contacting the provider',async t=>{
 const f=await fixture(t,{operable:true}),app=await f.boot();
 const denied=await app.req('/api/world/generate',{method:'POST',account:'account-b',session:'session-b',body:input()});
 assert.equal(denied.status,403);assert.equal(denied.body.admitted,false);assert.equal(f.calls.length,0);
 const accepted=await app.req('/api/world/generate',{method:'POST',body:input()});
 assert.equal(accepted.status,202,JSON.stringify(accepted));assert.equal(f.calls.filter(p=>p==='/worlds:generate').length,1);
});
test('account World admission authenticates and checks target before provider; separate sessions recover and import once',async t=>{
 const f=await fixture(t),app=await f.boot();
 assert.equal((await app.req('/api/world/jobs',{session:null,account:null})).status,401);
 assert.equal((await app.req('/api/world/jobs',{account:'account-b'})).status,409);
 f.setOwner(false);const refused=await app.req('/api/world/generate',{method:'POST',body:input()});assert.equal(refused.status,403);assert.equal(refused.body.admitted,false);assert.equal(refused.body.requestId,requestId);assert.equal(f.calls.length,0);
 f.setOwner(true);const stale=await app.req('/api/world/generate',{method:'POST',body:{...input(),spaceVersion:1}});assert.equal(stale.status,409);assert.equal(stale.body.admitted,false);assert.equal(f.calls.length,0);
 const result=await app.req('/api/world/generate',{method:'POST',body:input()});assert.equal(result.status,202,JSON.stringify(result));assert.equal(f.calls.filter(p=>p==='/worlds:generate').length,1);
 const noActor={session:null,account:null};
 assert.equal((await app.req('/api/worldlabs/operations/'+operation.operation_id,noActor)).status,404);
 assert.equal((await app.req('/api/worldlabs/worlds/'+operation.response.world_id,noActor)).status,404);
 assert.equal(f.calls.filter(p=>p.startsWith('/operations/')||p.startsWith('/worlds/')).length,0,'legacy paths cannot fetch known account result IDs');
 const another=await app.req('/api/world/jobs',{session:'another-session-a'});assert.equal(another.body.jobs[0].id,requestId);assert.equal(another.body.jobs[0].spaceId,'space-one');
 assert.equal((await app.req('/api/world/jobs/'+requestId,{account:'account-b',session:'session-b'})).status,404);
 const imported=await app.req('/api/world/jobs/'+requestId+'/import',{method:'POST',body:{spaceId:'space-one',spaceVersion:2,sceneVersion:1}});assert.equal(imported.status,200,JSON.stringify(imported));assert.equal(imported.body.job.importedSpaceId,'space-one');
 const replay=await app.req('/api/world/jobs/'+requestId+'/import',{method:'POST',body:{spaceId:'space-one',spaceVersion:2,sceneVersion:1}});assert.equal(replay.status,200);assert.equal(f.imports.size,1);
 const generateReplay=await app.req('/api/world/generate',{method:'POST',body:input()});assert.equal(generateReplay.status,202,'scene changed after import must not prevent recovering same request');assert.equal(f.calls.filter(p=>p==='/worlds:generate').length,1);
 app.child.kill('SIGTERM');await once(app.child,'exit');const restarted=await f.boot();assert.equal((await restarted.req('/api/world/jobs',{session:'another-session-a'})).body.jobs[0].importedSpaceId,'space-one');
});
test('a second account session cannot bypass an unresolved admission; old cookie claim preserves a late response',async t=>{
 const f=await fixture(t),app=await f.boot();let complete,received;const started=new Promise(r=>received=r);f.hold(res=>{complete=()=>res.end(JSON.stringify(operation));received();});
 const first=app.req('/api/world/generate',{method:'POST',body:input()});await started;
 const second=await app.req('/api/world/generate',{method:'POST',session:'another-session-a',body:input('account-world-request-0002')});assert.equal(second.status,409);assert.equal(second.body.error,'world_result_pending_reconciliation');assert.equal(second.body.admitted,false);assert.equal(f.calls.length,1);complete();assert.equal((await first).status,202);
 const bootstrap=await app.req('/api/worldlabs/jobs',{account:null,session:null});const cookie=bootstrap.cookie;assert.ok(cookie);
 let oldComplete,oldReceived;const oldStarted=new Promise(r=>oldReceived=r);f.hold(res=>{oldComplete=()=>res.end(JSON.stringify(operation));oldReceived();});
 const oldId='legacy-world-request-0001';const old=app.req('/api/worldlabs/generate',{method:'POST',account:null,session:null,cookie,body:input(oldId)});await oldStarted;
 assert.equal((await app.req('/api/world/jobs/legacy',{cookie})).body.jobs[0].id,oldId);
 assert.equal((await app.req('/api/world/jobs/claim',{method:'POST',cookie,body:{ids:[oldId]}})).status,200);oldComplete();assert.equal((await old).status,409,'former browser request cannot receive result after claim');
 assert.equal((await app.req('/api/world/jobs/'+oldId)).body.job.status,'complete');assert.equal((await app.req('/api/worldlabs/jobs',{account:null,session:null,cookie})).body.jobs.length,0);
 assert.equal(f.calls.filter(p=>p==='/worlds:generate').length,2);
});

test('missing import configuration blocks account generation before any provider admission',async t=>{
 const f=await fixture(t),app=await f.boot({withKey:false});
 const config=await app.req('/api/world/config',{session:null,account:null});assert.equal(config.body.enabled,false);assert.equal(config.body.importConfigured,false);
 const refused=await app.req('/api/world/generate',{method:'POST',body:input()});assert.equal(refused.status,503);assert.equal(refused.body.error,'world_import_not_configured');assert.equal(refused.body.admitted,false);assert.equal(refused.body.requestId,requestId);assert.equal(f.calls.length,0);
});

test('provider 402 is opaque in account and legacy HTTP responses, persisted jobs and replays',async t=>{
 const f=await fixture(t),app=await f.boot();
 const bootstrap=await app.req('/api/worldlabs/jobs',{account:null,session:null});
 for(const legacy of [false,true]){
  const path=legacy?'/api/worldlabs':'/api/world',id=legacy?'legacy-refusal-request-0001':'account-refusal-request-0001';
  const actor=legacy?{account:null,session:null,cookie:bootstrap.cookie}:{};
  const before=(await app.req('/api/world/config')).body.quota.remainingToday;
  f.hold(res=>{res.statusCode=402;res.setHeader('content-type','text/plain');res.end('Insufficient credits; visit billing');});
  const failed=await app.req(path+'/generate',{...actor,method:'POST',body:input(id)});
  assert.equal(failed.status,503);assert.equal(failed.body.error,'WL-204');assert.equal(failed.body.status,'rejected');assert.equal(failed.body.requestId,id);
  assert.match(failed.body.message,/WL-204/);assert.doesNotMatch(JSON.stringify(failed.body),/credit|billing|额度|余额|payment|provider_/i);
  assert.equal((await app.req('/api/world/config')).body.quota.remainingToday,before,'rejected calls release local daily quota');
  const listed=await app.req(path+'/jobs',actor),job=listed.body.jobs.find(j=>j.id===id);
  assert.equal(job.error,'WL-204');assert.equal(job.status,'rejected');
  assert.equal((await app.req(path+'/jobs/'+id,actor)).body.job.error,'WL-204');
  const calls=f.calls.length;
  const replay=await app.req(path+'/generate',{...actor,method:'POST',body:input(id)});
  assert.equal(replay.status,409);assert.equal(replay.body.job.error,'WL-204');assert.equal(f.calls.length,calls);
 }
});
