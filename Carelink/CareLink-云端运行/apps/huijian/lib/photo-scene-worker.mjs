import sharp from 'sharp';
import exifr from 'exifr';
import { mkdir, readFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { analysisVersion, SCENE_PROMPT, MATCH_PROMPT, descriptor, matches, credibleMatch } from './photo-scene-analysis.mjs';
sharp.cache({memory:32,files:0,items:16});sharp.concurrency(1);
export const photoFile=(store,id,kind='original')=>join(store.directory,id,kind);
export async function preprocess(store,p){
 const source=photoFile(store,p.id),pipeline=()=>sharp(source,{limitInputPixels:96_000_000,failOn:'error'}).rotate();
 const handle=await open(source,'r'),signature=Buffer.alloc(40);
 try{await handle.read(signature,0,40,0);}finally{await handle.close();}
 const supported=signature.subarray(0,3).equals(Buffer.from([255,216,255])) || signature.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || (signature.toString('ascii',0,4)==='RIFF'&&signature.toString('ascii',8,12)==='WEBP') || (signature.toString('ascii',4,8)==='ftyp'&&/heic|heix|hevc|hevx|mif1|msf1/.test(signature.toString('ascii',8)));
 if(!supported)throw Object.assign(new Error('image_processing_failed'),{code:'image_processing_failed'});
 const info=await pipeline().metadata();
 if(!['jpeg','png','webp','heif'].includes(info.format))throw Object.assign(new Error('image_processing_failed'),{code:'image_processing_failed'});
 const extra=await exifr.parse(source,{pick:['DateTimeOriginal','latitude','longitude'],translateValues:true}).catch(()=>null);
 const date=extra?.DateTimeOriginal instanceof Date&&Number.isFinite(extra.DateTimeOriginal.getTime())?extra.DateTimeOriginal:null;
 await mkdir(join(store.directory,p.id),{recursive:true,mode:0o700});
 await pipeline().resize({width:320,height:320,fit:'inside',withoutEnlargement:true}).jpeg({quality:74}).toFile(photoFile(store,p.id,'thumb'));
 const preview=await pipeline().resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true}).jpeg({quality:88}).toFile(photoFile(store,p.id,'preview'));
 const pixels=await pipeline().resize(9,8,{fit:'fill'}).greyscale().raw().toBuffer();let hash=0n;
 for(let y=0;y<8;y++)for(let x=0;x<8;x++)hash=(hash<<1n)|BigInt(pixels[y*9+x]>pixels[y*9+x+1]);
 return {hash:hash.toString(16).padStart(16,'0'),metadata:{width:preview.width,height:preview.height,originalWidth:info.width,originalHeight:info.height,format:info.format,previewBytes:preview.size,capturedAt:date?.toISOString()||null,capturedAtMs:date?.getTime()||null,timeSource:date?'exif':null,latitude:Number.isFinite(extra?.latitude)?extra.latitude:null,longitude:Number.isFinite(extra?.longitude)?extra.longitude:null,locationSource:Number.isFinite(extra?.latitude)?'exif':null}};
}
export function createSceneWorker({store,provider,gate,preprocessImpl=preprocess,delay=1000}){
 const version=analysisVersion(provider);let busy=false,closed=false,timer;
 const image=async p=>({id:p.id,dataUrl:'data:image/jpeg;base64,'+(await readFile(photoFile(store,p.id,'preview'))).toString('base64')});
 async function process(p){
  let reservation;
  try{
   store.update(p.id,{state:'working',error:null});
   if(!p.metadata){store.update(p.id,{stage:'preprocess'});Object.assign(p,await preprocessImpl(store,p));store.update(p.id,{metadata:p.metadata,hash:p.hash});}
   if(!provider?.completeJSON)throw Object.assign(new Error('analysis_not_configured'),{code:'analysis_not_configured'});
   if(gate){reservation=await gate.reserve('scene:'+p.owner);if(!reservation.ok)throw Object.assign(new Error('analysis_quota'),{code:'analysis_quota',retryAfterSeconds:reservation.retryAfterSeconds||3600});}
   if(!p.descriptor||p.version!==version){store.update(p.id,{stage:'analysis'});p.descriptor=descriptor(await provider.completeJSON({instructions:SCENE_PROMPT,images:[await image(p)]}));p.version=version;store.update(p.id,{descriptor:p.descriptor,version});}
   store.update(p.id,{stage:'grouping'});
   let evidence=[],matched;
   if(!p.locked&&p.descriptor.structure>=.35&&p.descriptor.confidence>=.65&&!['portrait','closeup'].includes(p.descriptor.composition)){
    const candidates=store.candidates(p);
    if(candidates.length){evidence=matches(await provider.completeJSON({instructions:MATCH_PROMPT,images:[await image(p),...await Promise.all(candidates.map(image))]}),candidates.map(x=>x.id));matched=evidence.filter(credibleMatch).sort((a,b)=>b.confidence-a.confidence)[0];}
    store.transaction(()=>{
     // Re-read manual membership after model I/O: user edits always win.
     const latest=store.photo(p.owner,p.id);
     for(const e of evidence)store.db.prepare('INSERT OR REPLACE INTO edges VALUES(?,?,?,?,?)').run(p.owner,p.id,e.id,JSON.stringify(e),version);
     if(!latest.locked){
      const reference=matched&&store.photo(p.owner,matched.id);
      const target=reference&&!reference.locked&&reference.groupId;
      const groupId=target||store.newGroup(p.owner,p.descriptor.label||'待确认场景','仅有一张可见场景，等待补充或人工合并');
      store.update(p.id,{groupId});
      if(target)store.db.prepare('UPDATE groups SET reason=?,version=version+1 WHERE id=?').run('AI 候选：'+matched.sharedStructures.join('；')+'。仍需你确认是否同一地点。',target);
     }
    });
   }
   store.index(p);store.update(p.id,{state:'done',stage:'complete',attempts:0,error:null});
  }catch(error){
   const attempts=p.attempts+1,code=error.code||'image_processing_failed';
   const wait=['analysis_not_configured','analysis_quota'].includes(code);
   store.update(p.id,{state:wait?'waiting':attempts<3?'queued':'failed',attempts:wait?p.attempts:attempts,retryAt:Date.now()+(wait?(error.retryAfterSeconds||300)*1000:2**attempts*5000),error:code});
  }finally{reservation?.release?.();}
 }
 async function tick(){if(busy||closed)return;busy=true;try{const row=store.db.prepare("SELECT * FROM photos WHERE state IN ('queued','waiting') AND retryAt<=? ORDER BY updated LIMIT 1").get(Date.now());if(row)await process(store.decode(row));}catch(error){console.error('photo_scene_queue_unavailable');}finally{busy=false;if(!closed){timer=setTimeout(tick,delay);timer.unref?.();}}}
 return {version,start(){if(!timer&&!busy&&!closed)void tick();},async tick(){await tick();},async stop(){closed=true;clearTimeout(timer);while(busy)await new Promise(r=>setTimeout(r,10));},process};
}
