import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {createSceneResultsHttp,validateResult,validateSceneManifest} from '../lib/scene-results.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const manifest={sceneRevisionId:'test-r001',name:'测试空间',sceneAsset:{url:'assets/scene.sog',format:'sog'},navigation:{eyeHeight:1.6,boundaryXZ:[[-1,-1],[1,-1],[1,1]],startPose:{position:[0,1.6,0],quaternion:[0,0,0,1],fov:60}},photoAnchors:[]};
const bodies={'scene.json':Buffer.from(JSON.stringify(manifest)),'assets/scene.sog':Buffer.from([0x50,0x4b,3,4,0,1,2,3]),'videos/clip.mp4':Buffer.from('test-video-only-not-a-visual-proof')};
const payload={consent:true,title:'房间',spaceId:'space_a',sourceRevisionId:'test-r001',files:Object.entries(bodies).map(([path,b])=>({path,bytes:b.length,sha256:sha(b)}))};
test('reject unselected, executable, duplicate and oversized uploads',()=>{
 assert.throws(()=>validateResult({...payload,consent:false}));
 for(const path of ['../scene.json','assets/../scene.sog','index.html','photos/a.svg','https://bad/a.jpg'])assert.throws(()=>validateResult({...payload,files:[...payload.files,{path,bytes:1,sha256:'a'.repeat(64)}]}));
 assert.throws(()=>validateResult({...payload,files:[...payload.files,payload.files[0]]}));
 assert.throws(()=>validateResult({...payload,files:payload.files.map(f=>({...f,bytes:1024**3}))}));
 assert.equal(validateResult(payload).totalBytes,Object.values(bodies).reduce((n,b)=>n+b.length,0));
});
test('manifest rejects wrong revision, invalid pose and external photo URLs',()=>{
 assert.throws(()=>validateSceneManifest({...manifest,sceneRevisionId:'wrong'},payload));
 assert.throws(()=>validateSceneManifest({...manifest,sceneAsset:{format:'sog',url:'https://bad/model.sog'}},payload));
 assert.throws(()=>validateSceneManifest({...manifest,photoAnchors:[{id:'photo',sceneRevisionId:'test-r001',...manifest.navigation.startPose,originalUrl:'https://bad/photo.jpg'}]},payload));
 assert.equal(validateSceneManifest(manifest,payload),manifest);
});
test('real HTTP lifecycle: retry, integrity, persistence, activation and access boundaries',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'unseen-scene-results-'));let revoked=false;
 const canonical=async(req,path)=>{
  const who=req.headers.authorization?.replace('Bearer ','');if(!['alice','bob'].includes(who)||revoked)throw Object.assign(new Error(),{status:401,code:'session_unavailable'});
  if(path==='/v1/viewer/spaces/space_a?access=account'&&who==='alice')return {photos:[]};
  if(path==='/v1/viewer/spaces/space_a?access=invitation'&&who==='bob')return {photos:[]};
  if(path.startsWith('/v1/viewer/'))throw Object.assign(new Error(),{status:403,code:'resource_unavailable'});
  if(path==='/v1/me')return {accountId:who};
  if(path==='/v1/spaces/space_a/management')return {isOwner:who==='alice',space:{spaceLifecycle:'active'}};
  throw Object.assign(new Error(),{status:404,code:'resource_unavailable'});
 };
 let handler=createSceneResultsHttp({directory,canonical,send:(res,s,b)=>{res.writeHead(s,{'content-type':'application/json'});res.end(JSON.stringify(b));}});
 const server=createServer((req,res)=>handler(req,res,new URL(req.url,'http://local').pathname).catch(e=>{res.statusCode=500;res.end(e.message);}));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const origin=`http://127.0.0.1:${server.address().port}`;
 async function req(path,method='GET',body,who='alice',extra={}){const r=await fetch(origin+path,{method,headers:{authorization:'Bearer '+who,'x-unseen-expected-account-id':who,...(Buffer.isBuffer(body)?{'content-type':'application/octet-stream'}:{'content-type':'application/json'}),...extra},body:body===undefined?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body),redirect:'manual'});const data=r.headers.get('content-type')?.includes('json')?await r.json():Buffer.from(await r.arrayBuffer());return {status:r.status,headers:r.headers,data};}
 assert.equal((await req('/api/scene-results','POST',payload,'bob')).status,403);
 assert.equal((await req('/api/scene-results','POST',payload,'alice',{'x-unseen-expected-account-id':'bob'})).status,409);
 assert.equal((await req('/api/scene-results','POST',payload,'alice',{origin:'https://bad.example'})).status,403);
 const created=await req('/api/scene-results','POST',payload);assert.equal(created.status,200);const rid=created.data.result.resultId,base='/api/scene-results/'+rid;
 assert.equal((await req('/api/scene-results','POST',payload)).data.result.resultId,rid);
 assert.equal((await req(base+'/commit','POST',{})).status,409);
 assert.equal((await req('/scene-results/'+rid+'/assets/scene.sog')).status,409);
 for(const [name,bytes] of Object.entries(bodies)){
  const path=base+'/files/'+encodeURIComponent(name);
  const corrupt=Buffer.from(bytes);corrupt[0]^=1;assert.equal((await req(path,'PUT',corrupt)).status,409);
  assert.equal((await req(path,'PUT',bytes)).status,200);
  assert.equal((await req(path,'PUT',bytes)).status,200);
 }
 const committed=await req(base+'/commit','POST',{});assert.equal(committed.status,200);assert.equal(committed.data.result.status,'ready');assert.equal(committed.data.result.active,false);
 assert.equal((await req(base+'/commit','POST',{})).status,200);
 assert.equal((await req(base+'/files/scene.json','PUT',bodies['scene.json'])).status,409);
 assert.equal((await req(base+'/activate','POST',{})).data.result.active,true);
 assert.equal((await req('/scene-spaces/space_a/')).headers.get('location'),'/scene-results/'+rid+'/');
 const shared='/space-scene-media/invitation/space_a/'+rid+'/';
 const info=await req('/api/space-scenes/space_a?access=invitation','GET',undefined,'bob');assert.equal(info.status,200);assert.equal(info.data.scene.photoAnchorCount,0);
 assert.match(info.data.scene.viewerUrl,/space-scene-media/);
 assert.equal((await req('/api/space-scenes/space_a','GET',undefined,'bob')).status,403);
 assert.equal((await req('/api/space-scenes/space_a','POST',{})).status,405);
 assert.equal((await req(shared+'scene.json','GET',undefined,'bob')).status,200);
 assert.equal((await req(shared+'assets/scene.sog','GET',undefined,'bob')).status,200);
 assert.equal((await req(shared+'assets/scene.sog','GET',undefined,'bob',{range:'bytes=0-3'})).status,206);
 assert.equal((await req(shared+'scene.json','GET',undefined,'alice')).status,403);
 assert.equal((await req(shared.replace('space_a','space_other')+'scene.json','GET',undefined,'bob')).status,403);
 assert.equal((await req(shared+'result.json','GET',undefined,'bob')).status,404);
 assert.equal((await req(shared.replace(rid,'result_'+'0'.repeat(32))+'scene.json','GET',undefined,'bob')).status,404);

 assert.equal((await req('/scene-spaces/space_a/','GET',undefined,'bob')).status,403);
 handler=createSceneResultsHttp({directory,canonical,send:(res,s,b)=>{res.writeHead(s,{'content-type':'application/json'});res.end(JSON.stringify(b));}});
 assert.equal((await req('/api/scene-results')).data.results[0].active,true);
 assert.equal((await req(base,'GET',undefined,'bob')).status,404);
 assert.equal((await req('/scene-results/'+rid+'/assets/scene.sog','GET',undefined,'bob')).status,404);
 const model=await req('/scene-results/'+rid+'/assets/scene.sog');assert.equal(model.status,200);assert.equal(sha(model.data),sha(bodies['assets/scene.sog']));assert.match(model.headers.get('cache-control'),/private/);
 const video=await req('/scene-results/'+rid+'/videos/clip.mp4','GET',undefined,'alice',{range:'bytes=2-5'});assert.equal(video.status,206);assert.equal(video.data.toString(),bodies['videos/clip.mp4'].subarray(2,6).toString());
 assert.equal((await req('/scene-results/'+rid+'/videos/clip.mp4','GET',undefined,'alice',{range:'bytes=999-'})).status,416);
 const viewer=await req('/scene-results/'+rid+'/');assert.equal(viewer.status,302);assert.match(viewer.headers.get('location'),/^\/scene-viewer\/index.html\?scene=/);
 assert.equal((await req('/scene-results/'+rid+'/index.html','POST',{})).status,405);
 assert.equal((await req('/scene-results/'+rid+'/%2e%2e%2fresult.json')).status,404);
 revoked=true;assert.equal((await req(shared+'assets/scene.sog','GET',undefined,'bob')).status,401);assert.equal((await req('/scene-results/'+rid+'/assets/scene.sog')).status,401);
 assert.equal(JSON.parse(await readFile(join(directory,'alice',rid,'result.json'),'utf8')).status,'ready');
});
