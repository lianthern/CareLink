import {mkdir, readFile, writeFile, rename, readdir, stat, open, unlink} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {join} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {worldCanonical} from './world-account-http.mjs';

const fail=(code,status=422)=>Object.assign(new Error(code),{code,status});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const filePath=value=>typeof value==='string'&&/^(?:scene\.json|navigation-map\.json|assets\/scene\.sog|(?:photos|videos)\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp|mp4|webm))$/.test(value);
export const SCENE_LIMITS=Object.freeze({maxFiles:256,maxFileBytes:128*1024*1024,maxResultBytes:512*1024*1024,maxAccountBytes:2*1024**3,maxResults:100});
const mime=name=>name.endsWith('.json')?'application/json':name.endsWith('.sog')?'application/octet-stream':/\.jpe?g$/.test(name)?'image/jpeg':name.endsWith('.png')?'image/png':name.endsWith('.webp')?'image/webp':name.endsWith('.mp4')?'video/mp4':'video/webm';
export function validateResult(body,limits=SCENE_LIMITS){
 if(!body||body.consent!==true||!id(body.spaceId)||!id(body.sourceRevisionId)||typeof body.title!=='string'||!body.title.trim()||body.title.length>120||!Array.isArray(body.files)||body.files.length<2||body.files.length>limits.maxFiles)throw fail('scene_result_invalid');
 const names=new Set();let total=0;
 const files=body.files.map(f=>{
  if(!filePath(f?.path)||names.has(f.path)||!Number.isSafeInteger(f.bytes)||f.bytes<1||f.bytes>limits.maxFileBytes||typeof f.sha256!=='string'||!/^[a-f0-9]{64}$/.test(f.sha256))throw fail('scene_file_invalid');
  if(f.path.endsWith('.json')&&f.bytes>2*1024*1024)throw fail('scene_file_too_large',413);
  names.add(f.path);total+=f.bytes;return {path:f.path,bytes:f.bytes,sha256:f.sha256};
 }).sort((a,b)=>a.path.localeCompare(b.path));
 if(!names.has('scene.json')||!names.has('assets/scene.sog')||total>limits.maxResultBytes)throw fail('scene_result_too_large_or_incomplete',413);
 return {spaceId:body.spaceId,sourceRevisionId:body.sourceRevisionId,title:body.title.trim(),files,totalBytes:total};
}
export function validateSceneManifest(scene,row){
 const vector=(a,n)=>Array.isArray(a)&&a.length===n&&a.every(Number.isFinite);
 const pose=p=>vector(p?.position,3)&&vector(p?.quaternion,4)&&Math.hypot(...p.quaternion)>0.001&&Number.isFinite(p.fov)&&p.fov>=10&&p.fov<=170;
 const nav=scene?.navigation;
 if(scene?.sceneRevisionId!==row.sourceRevisionId||scene?.sceneAsset?.format!=='sog'||scene.sceneAsset.url!=='assets/scene.sog'||!Number.isFinite(nav?.eyeHeight)||!pose(nav.startPose)||!Array.isArray(nav.boundaryXZ)||nav.boundaryXZ.length<3||nav.boundaryXZ.length>4096||!nav.boundaryXZ.every(p=>vector(p,2))||!Array.isArray(scene.photoAnchors)||scene.photoAnchors.length>256)throw fail('scene_manifest_invalid');
 const names=new Set(row.files.map(f=>f.path));
 for(const a of scene.photoAnchors){
  if(a.sceneRevisionId!==row.sourceRevisionId||!id(a.id)||!pose(a))throw fail('scene_photo_anchor_invalid');
  for(const field of ['thumbnail','originalUrl'])if(a[field]&&(!filePath(a[field])||!names.has(a[field])||!a[field].startsWith('photos/')))throw fail('scene_photo_file_missing');
 }
 // Only these URL fields are consumed by the pinned renderer. All resolve inside this revision.
 return scene;
}
async function atomic(path,value){const tmp=path+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(value),{mode:0o600});await rename(tmp,path);}
async function jsonFile(path){try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function readBytes(req,limit){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>limit)throw fail('request_too_large',413);chunks.push(chunk);}return Buffer.concat(chunks);}

export function createSceneResultsHttp({directory=join(process.env.STATE_DIRECTORY||'.state','scene-results'),canonical=worldCanonical,send,limits=SCENE_LIMITS}={}){
 const pending=new Map();let activeUploads=0;
 async function locked(key,run){const prior=pending.get(key)||Promise.resolve(),next=prior.catch(()=>{}).then(run);pending.set(key,next);try{return await next;}finally{if(pending.get(key)===next)pending.delete(key);}}
 const root=accountId=>join(directory,accountId), rowPath=(a,r)=>join(root(a),r,'result.json');
 const scoped=req=>({...req,headers:{...req.headers,'x-unseen-expected-account-id':req.headers['x-unseen-expected-account-id']||''}});
 async function account(req,write=false){const me=await canonical(scoped(req),'/v1/me');if(!id(me.accountId))throw fail('session_unavailable',401);const expected=req.headers['x-unseen-expected-account-id'];if((write||expected)&&expected!==me.accountId)throw fail('account_changed',409);return me.accountId;}
 async function owner(req,spaceId){const m=await canonical(scoped(req),`/v1/spaces/${spaceId}/management`);if((m.isOwner??m.space?.owner)!==true||m.space?.spaceLifecycle!=='active')throw fail('scene_space_unavailable',403);return m;}
 async function rows(a){let names;try{names=await readdir(root(a));}catch(e){if(e.code==='ENOENT')return [];throw e;}return (await Promise.all(names.filter(n=>/^result_[a-f0-9]{32}$/.test(n)).map(n=>jsonFile(rowPath(a,n))))).filter(Boolean);}
 async function dto(a,row){const selected=await jsonFile(join(root(a),'active-'+row.spaceId+'.json'));return {...row,accountId:undefined,files:row.files.map(f=>({...f,received:row.received.includes(f.path)})),active:selected?.resultId===row.resultId,viewerUrl:row.status==='ready'?`/scene-results/${row.resultId}/`:null};}
 async function get(a,r){const row=await jsonFile(rowPath(a,r));if(!row||row.accountId!==a)throw fail('scene_result_unavailable',404);return row;}
 async function receivedFile(a,row,f){const p=join(root(a),row.resultId,'files',f.path);const info=await stat(p);if(info.size!==f.bytes)throw fail('scene_integrity_failed',409);const hash=createHash('sha256');for await(const b of createReadStream(p))hash.update(b);if(hash.digest('hex')!==f.sha256)throw fail('scene_integrity_failed',409);return p;}
 // Read access follows canonical space permissions, including revocable invitation sessions.
 async function currentForSpace(spaceId){
  let accounts;try{accounts=await readdir(directory);}catch(e){if(e.code==='ENOENT')return null;throw e;}
  for(const a of accounts.filter(id)){
   const selected=await jsonFile(join(root(a),'active-'+spaceId+'.json'));
   if(!selected||!/^result_[a-f0-9]{32}$/.test(selected.resultId))continue;
   const row=await get(a,selected.resultId);
   if(row.spaceId===spaceId&&row.status==='ready')return {a,row};
  }
  return null;
 }
 return async function handle(req,res,pathname){
  const api=pathname==='/api/scene-results'||pathname.startsWith('/api/scene-results/');
  const media=/^\/scene-results\/(result_[a-f0-9]{32})\/(.*)$/.exec(pathname);
  const spaceView=/^\/scene-spaces\/([A-Za-z0-9_-]{1,128})\/$/.exec(pathname);
  const sharedInfo=/^\/api\/space-scenes\/([A-Za-z0-9_-]{1,128})$/.exec(pathname);
  const sharedMedia=/^\/space-scene-media\/(account|invitation)\/([A-Za-z0-9_-]{1,128})\/(result_[a-f0-9]{32})\/(.*)$/.exec(pathname);
  if(!api&&!media&&!spaceView&&!sharedInfo&&!sharedMedia)return false;
  try{
   if(req.headers['sec-fetch-site']==='cross-site'||req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)throw fail('origin_not_allowed',403);
   const write=!['GET','HEAD'].includes(req.method);
   let shared;
   if(sharedInfo||sharedMedia){
    if(write)throw fail('method_not_allowed',405);
    const access=sharedMedia?.[1]||(new URL(req.url,'http://local').searchParams.get('access')==='invitation'?'invitation':'account');
    const sid=sharedInfo?.[1]||sharedMedia[2];
    if(access==='account')await account(req);
    await canonical(scoped(req),`/v1/viewer/spaces/${sid}?access=${access}`);
    shared=await currentForSpace(sid);
    if(sharedInfo){
     const result=shared?.row,manifest=result?`/space-scene-media/${access}/${sid}/${result.resultId}/scene.json`:null;
     send(res,200,{scene:result?{title:result.title,resultId:result.resultId,sourceRevisionId:result.sourceRevisionId,photoAnchorCount:result.photoAnchorCount,automaticPhotoPlacement:false,viewerUrl:'/scene-viewer/index.html?scene='+encodeURIComponent(manifest)}:null});return true;
    }
    if(!shared||shared.row.resultId!==sharedMedia[3])throw fail('scene_result_unavailable',404);
   }
   const a=shared?shared.a:await account(req,write);
   if(spaceView){
    if(write)throw fail('method_not_allowed',405);await owner(req,spaceView[1]);
    const selected=await jsonFile(join(root(a),'active-'+spaceView[1]+'.json'));if(!selected)throw fail('scene_current_version_missing',404);
    const row=await get(a,selected.resultId);if(row.status!=='ready'||row.spaceId!==spaceView[1])throw fail('scene_result_not_ready',409);
    res.writeHead(302,{'location':`/scene-results/${row.resultId}/`,'cache-control':'no-store'});res.end();return true;
   }
   if(media||sharedMedia){
    if(write)throw fail('method_not_allowed',405);
    const row=shared?.row||await get(a,media[1]);if(!shared)await owner(req,row.spaceId);if(row.status!=='ready')throw fail('scene_result_not_ready',409);
    let name;try{name=decodeURIComponent(sharedMedia?sharedMedia[4]:media[2]);}catch{throw fail('path_invalid');}
    // Executable viewer code is always served from our release, never from an uploaded package.
    if(!name||name==='index.html'){
     res.writeHead(302,{'location':`/scene-viewer/index.html?scene=${encodeURIComponent(`/scene-results/${row.resultId}/scene.json`)}`,'cache-control':'no-store'});res.end();return true;
    }
    const f=row.files.find(f=>f.path===name);if(!f||!filePath(name))throw fail('scene_file_unavailable',404);
    const p=join(root(a),row.resultId,'files',name),info=await stat(p);if(info.size!==f.bytes)throw fail('scene_integrity_failed',503);
    let start=0,end=f.bytes-1,status=200;const range=req.headers.range;
    if(range){const m=/^bytes=(\d*)-(\d*)$/.exec(range);if(!m||!m[1]&&!m[2])throw fail('range_invalid',416);if(!m[1])start=Math.max(0,f.bytes-Number(m[2]));else{start=Number(m[1]);if(m[2])end=Math.min(end,Number(m[2]));}if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>end||start>=f.bytes)throw fail('range_invalid',416);status=206;}
    const headers={'content-type':mime(name),'content-length':end-start+1,'cache-control':'private, no-store','x-content-type-options':'nosniff','cross-origin-resource-policy':'same-origin','accept-ranges':'bytes'};
    if(range)headers['content-range']=`bytes ${start}-${end}/${f.bytes}`;
    res.writeHead(status,headers);if(req.method==='HEAD'){res.end();return true;}
    const stream=createReadStream(p,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);return true;
   }
   if(req.method==='GET'&&pathname==='/api/scene-results/capabilities'){send(res,200,{accountId:a,schema:'unseen-scene-result/1',manualUpload:true,automaticTraining:false,limits});return true;}
   if(req.method==='GET'&&pathname==='/api/scene-results'){
    const visible=[];for(const row of await rows(a)){try{await owner(req,row.spaceId);visible.push(await dto(a,row));}catch(e){if(![403,404].includes(e.status))throw e;}}
    send(res,200,{accountId:a,results:visible.sort((x,y)=>y.createdAt.localeCompare(x.createdAt))});return true;
   }
   if(req.method==='POST'&&pathname==='/api/scene-results'){
    if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw fail('json_required',415);
    const data=validateResult(JSON.parse((await readBytes(req,256*1024)).toString()),limits);await owner(req,data.spaceId);
    const resultId='result_'+digest(JSON.stringify({accountId:a,...data})).slice(0,32);
    const row=await locked(a,async()=>{
     const old=await jsonFile(rowPath(a,resultId));if(old)return old;
     const all=await rows(a);if(all.length>=limits.maxResults||all.reduce((n,r)=>n+r.totalBytes,0)+data.totalBytes>limits.maxAccountBytes)throw fail('scene_storage_limit',413);
     await owner(req,data.spaceId);await mkdir(join(root(a),resultId,'files'),{recursive:true,mode:0o700});
     const row={schema:'unseen-scene-result/1',resultId,accountId:a,...data,status:'uploading',received:[],createdAt:new Date().toISOString()};await atomic(rowPath(a,resultId),row);return row;
    });send(res,200,{accountId:a,result:await dto(a,row)});return true;
   }
   const m=/^\/api\/scene-results\/(result_[a-f0-9]{32})(?:\/(files\/(.+)|commit|activate))?$/.exec(pathname);
   if(!m)throw fail('resource_unavailable',404);
   const row=await get(a,m[1]);await owner(req,row.spaceId);
   if(req.method==='GET'&&!m[2]){send(res,200,{accountId:a,result:await dto(a,row)});return true;}
   if(req.method==='PUT'&&m[3]){
    let name;try{name=decodeURIComponent(m[3]);}catch{throw fail('path_invalid');}
    const f=row.files.find(f=>f.path===name);if(!f||!filePath(name))throw fail('scene_file_unavailable',404);
    if(req.headers['content-length']&&Number(req.headers['content-length'])!==f.bytes)throw fail('scene_file_size_mismatch');
    if(activeUploads>=2)throw fail('scene_upload_busy',429);activeUploads++;
    try{await locked(a+row.resultId,async()=>{
     const current=await get(a,row.resultId);if(current.status==='ready')throw fail('scene_result_immutable',409);
     const file=join(root(a),row.resultId,'files',name),temp=file+'.'+randomUUID()+'.part';await mkdir(join(file,'..'),{recursive:true,mode:0o700});
     try{
      const fd=await open(temp,'wx',0o600),hash=createHash('sha256');let bytes=0;
      try{for await(const chunk of req){bytes+=chunk.length;if(bytes>f.bytes)throw fail('scene_file_size_mismatch');hash.update(chunk);await fd.writeFile(chunk);}await fd.sync();}finally{await fd.close();}
      if(bytes!==f.bytes||hash.digest('hex')!==f.sha256)throw fail('scene_file_hash_mismatch',409);
      if(await account(req,true)!==a)throw fail('account_changed',409);await owner(req,row.spaceId);
      await rename(temp,file);current.received=[...new Set([...current.received,name])];await atomic(rowPath(a,row.resultId),current);
     }finally{await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
    });}finally{activeUploads--;}
    send(res,200,{accountId:a,result:await dto(a,await get(a,row.resultId))});return true;
   }
   if(req.method==='POST'&&m[2]==='commit'){
    const ready=await locked(a+row.resultId,async()=>{
     const current=await get(a,row.resultId);if(current.status==='ready')return current;
     if(current.files.some(f=>!current.received.includes(f.path)))throw fail('scene_files_incomplete',409);
     for(const f of current.files)await receivedFile(a,current,f);
     const scene=JSON.parse(await readFile(join(root(a),row.resultId,'files/scene.json'),'utf8'));validateSceneManifest(scene,current);
     const sog=await open(join(root(a),row.resultId,'files/assets/scene.sog'),'r');const head=Buffer.alloc(4);try{await sog.read(head,0,4,0);}finally{await sog.close();}if(!head.equals(Buffer.from([0x50,0x4b,3,4])))throw fail('scene_sog_invalid');
     if(await account(req,true)!==a)throw fail('account_changed',409);await owner(req,row.spaceId);
     current.status='ready';current.readyAt=new Date().toISOString();current.photoAnchorCount=scene.photoAnchors.length;current.hasLocalizationMap=false;await atomic(rowPath(a,row.resultId),current);return current;
    });send(res,200,{accountId:a,result:await dto(a,ready)});return true;
   }
   if(req.method==='POST'&&m[2]==='activate'){
    if(row.status!=='ready')throw fail('scene_result_not_ready',409);
    await locked(a,async()=>{await owner(req,row.spaceId);await atomic(join(root(a),'active-'+row.spaceId+'.json'),{resultId:row.resultId,activatedAt:new Date().toISOString()});});
    send(res,200,{accountId:a,result:await dto(a,row)});return true;
   }
   throw fail('method_not_allowed',405);
  }catch(e){const code=e instanceof SyntaxError?'json_invalid':typeof e.code==='string'&&/^[a-z0-9_]+$/.test(e.code)?e.code:'scene_service_unavailable';send(res,e instanceof SyntaxError?422:e.status||503,{error:code});return true;}
 };
}
