import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, stat, statfs, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { authenticateMoment } from './moment-http.mjs';
import { worldCanonical } from './world-account-http.mjs';
import { sceneError } from './photo-scene-store.mjs';
import { photoFile } from './photo-scene-worker.mjs';

const send=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(data));};
async function body(req,max=32768){let n=0;const chunks=[];for await(const c of req){n+=c.length;if(n>max)throw sceneError('request_too_large',413);chunks.push(c);}try{return JSON.parse(Buffer.concat(chunks).toString());}catch{throw sceneError('bad_request');}}
export function createPhotoSceneHttp({store,worker,authenticate=authenticateMoment,canonical=worldCanonical}){
 const locks=new Set();
 return async(req,res,path)=>{
  if(!path.startsWith('/api/photo-scenes'))return false;
  try{
   if(req.headers['sec-fetch-site']==='cross-site'||req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)throw sceneError('origin_not_allowed',403);
   const url=new URL(req.url,'http://localhost'),media=path.match(/^\/api\/photo-scenes\/photos\/([a-f0-9-]{36})\/(thumb|preview|original)$/);
   // Image requests cannot attach headers; expected owner is still compared with the live canonical session.
   const authReq=media?{headers:{...req.headers,'x-unseen-expected-account-id':url.searchParams.get('account')}}:req;
   const {accountId:owner}=await authenticate(authReq);
   if(['POST','PATCH'].includes(req.method)&&!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw sceneError('json_required',415);
   if(media&&req.method==='GET'){
    const p=store.photo(owner,media[1]),kind=media[2];if(p.state==='uploading'||kind!=='original'&&!p.metadata)throw sceneError('photo_not_ready',409);
    const file=photoFile(store,p.id,kind),s=await stat(file);
    res.writeHead(200,{'content-type':kind==='original'?p.mime:'image/jpeg','content-length':s.size,'cache-control':'private, no-store','x-content-type-options':'nosniff',...(kind==='original'?{'content-disposition':`attachment; filename*=UTF-8''${encodeURIComponent(p.name)}`}:{})});
    const stream=createReadStream(file);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);return true;
   }
   if(path==='/api/photo-scenes'&&req.method==='GET'){send(res,200,{accountId:owner,status:store.status(owner),version:worker.version,...store.groups(owner,url.searchParams.get('after')||'')});return true;}
   if(path==='/api/photo-scenes/photos'){
    if(req.method==='GET'){send(res,200,store.list(owner,{after:url.searchParams.get('after')||'',group:url.searchParams.get('group'),limit:url.searchParams.get('limit')}));return true;}
    if(req.method==='POST'){
     const b=await body(req),p=store.create(owner,b);await mkdir(join(store.directory,p.id),{recursive:true,mode:0o700});send(res,200,{photo:p});return true;
    }
   }
   const pm=path.match(/^\/api\/photo-scenes\/photos\/([a-f0-9-]{36})(?:\/(chunk|commit|retry))?$/);
   if(pm){const p=store.photo(owner,pm[1]);
    if(!pm[2]&&req.method==='GET'){send(res,200,{photo:p});return true;}
    if(pm[2]==='retry'&&req.method==='POST'){
     if(p.state==='uploading'||p.state==='working')throw sceneError('photo_not_ready',409);
     store.update(p.id,{state:'queued',attempts:0,retryAt:0,error:null});send(res,200,{photo:store.photo(owner,p.id)});return true;
    }
    if(pm[2]==='chunk'&&req.method==='PUT'){
     if(p.state!=='uploading')throw sceneError('upload_already_complete',409);if(locks.has(p.id))throw sceneError('upload_busy',409);
     const offset=Number(url.searchParams.get('offset')),length=Number(req.headers['content-length']);
     if(!Number.isSafeInteger(offset)||offset!==p.offset||!Number.isSafeInteger(length)||length<1||length>1048576||offset+length>p.bytes)throw sceneError('upload_offset_conflict',409);
     locks.add(p.id);const part=photoFile(store,p.id,'part');let f;
     try{
      const free=await statfs(store.directory);if(free.bavail*free.bsize<1024**3+length)throw sceneError('storage_full',507);
      f=await open(part,'a',0o600);await f.truncate(offset);let count=0;
      for await(const c of req){count+=c.length;if(count>length)throw sceneError('request_too_large',413);await f.writeFile(c);}
      if(count!==length)throw sceneError('upload_incomplete',409);await f.sync();store.update(p.id,{offset:offset+length});send(res,200,{offset:offset+length});
     }catch(e){await f?.truncate(offset);throw e;}finally{await f?.close();locks.delete(p.id);}return true;
    }
    if(pm[2]==='commit'&&req.method==='POST'){
     if(p.state!=='uploading'){send(res,200,{photo:p});return true;}
     if(locks.has(p.id)||p.offset!==p.bytes)throw sceneError('upload_incomplete',409);locks.add(p.id);
     try{const part=photoFile(store,p.id,'part');
      // Reconcile a crash after atomic rename but before database commit.
      const source=await stat(part).then(()=>part).catch(()=>photoFile(store,p.id));
      const hash=createHash('sha256');let bytes=0;for await(const chunk of createReadStream(source)){hash.update(chunk);bytes+=chunk.length;}
      if(bytes!==p.bytes||hash.digest('hex')!==p.sha){store.update(p.id,{offset:0,error:'hash_mismatch'});if(source===part)await truncate(part,0);throw sceneError('hash_mismatch',422);}
      if(source===part)await rename(part,photoFile(store,p.id));store.update(p.id,{state:'queued',stage:'preprocess',retryAt:0});send(res,200,{photo:store.photo(owner,p.id)});
     }finally{locks.delete(p.id);}return true;
    }
   }
   const gm=path.match(/^\/api\/photo-scenes\/groups\/([a-f0-9-]{36})(?:\/(selection|handoff|links))?$/);
   if(gm){const g=store.group(owner,gm[1]);
    if(req.method==='GET'){send(res,200,gm[2]==='selection'?store.selection(owner,g.id):gm[2]==='links'?{links:store.db.prepare('SELECT * FROM links WHERE owner=? AND spaceId=?').all(owner,g.spaceId||'')}:{group:g,...store.list(owner,{group:g.id,after:url.searchParams.get('after')||''})});return true;}
    if(req.method==='POST'){
     const b=await body(req);
     if(gm[2]==='handoff'){send(res,200,store.handoff(owner,g.id,b));return true;}
     if(gm[2]==='links'){
      if(!g.spaceId||!Array.isArray(b.links)||b.links.length>24)throw sceneError('selection_invalid');
      for(const link of b.links){const p=store.photo(owner,link.photoId);if(p.groupId!==g.id||typeof link.canonicalPhotoId!=='string')throw sceneError('selection_invalid');}
      const viewer=await canonical(req,'/v1/viewer/spaces/'+encodeURIComponent(g.spaceId));
      const text=JSON.stringify(viewer);for(const link of b.links)if(!text.includes('"'+link.canonicalPhotoId+'"'))throw sceneError('photo_not_ready',409);
      for(const link of b.links)store.db.prepare('INSERT OR IGNORE INTO links VALUES(?,?,?,?)').run(owner,g.spaceId,link.photoId,link.canonicalPhotoId);send(res,200,{ok:true});return true;
     }
     if(b.action==='space'){
      const management=await canonical(req,'/v1/spaces/'+encodeURIComponent(b.spaceId||'')+'/management');if((management.isOwner??management.space?.owner)!==true)throw sceneError('space_unavailable',403);
     }
     send(res,200,store.edit(owner,g.id,b));return true;
    }
   }
   throw sceneError('resource_unavailable',404);
  }catch(error){if(!res.headersSent)send(res,error.status||503,{error:error.code||'photo_service_unavailable'});else res.destroy();return true;}
 };
}
