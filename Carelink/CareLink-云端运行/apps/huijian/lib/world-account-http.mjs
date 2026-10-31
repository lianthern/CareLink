import {createHmac} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {authenticateMoment} from './moment-http.mjs';
import {publicWorldJob} from './unseen-world-jobs.mjs';
import {publicWorldFailure} from './worldlabs-public-errors.mjs';

const fail=(code,status=400)=>Object.assign(new Error(code),{code,status});
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
export function worldTarget(body){
 if(!validId(body?.spaceId)||!Number.isSafeInteger(body.spaceVersion)||body.spaceVersion<1||!(body.sceneVersion===null||Number.isSafeInteger(body.sceneVersion)&&body.sceneVersion>=1))throw fail('world_space_target_invalid',422);
 return {spaceId:body.spaceId,spaceVersion:body.spaceVersion,sceneVersion:body.sceneVersion};
}
// The upstream validates its public Host. Native HTTP preserves it, unlike Node fetch.
export async function worldCanonical(req,path,{method='GET',body,version,idempotencyKey,upstream=process.env.CANONICAL_UPSTREAM,publicOrigin=process.env.CANONICAL_PUBLIC_ORIGIN}={}){
 if(!upstream)throw fail('account_service_unavailable',503);
 const url=new URL(path,upstream),origin=new URL(publicOrigin||upstream),bytes=body===undefined?null:Buffer.from(JSON.stringify(body));
 return new Promise((resolve,reject)=>{
  let outgoing,incoming,settled=false,count=0;const chunks=[];
  const timer=setTimeout(()=>finish(fail('account_service_timeout',504)),120000);
  function finish(error,value){if(settled)return;settled=true;clearTimeout(timer);if(error){incoming?.destroy();outgoing?.destroy();reject(error);}else resolve(value);}
  outgoing=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{method,headers:{host:origin.host,origin:origin.origin,'sec-fetch-site':'same-origin',accept:'application/json','accept-encoding':'identity',
   'x-unseen-expected-account-id':req.headers['x-unseen-expected-account-id'],
   ...(req.headers.cookie?{cookie:req.headers.cookie}:{}),...(req.headers.authorization?{authorization:req.headers.authorization}:{}),
   ...(bytes?{'content-type':'application/json','content-length':bytes.length}:{}),...(version!==undefined?{'if-match':String(version)}:{}),...(idempotencyKey?{'idempotency-key':idempotencyKey}:{})}},response=>{
    incoming=response;response.once('error',error=>finish(error));response.once('aborted',()=>finish(fail('account_response_incomplete',502)));
    response.on('data',chunk=>{count+=chunk.length;if(count>2*1024*1024)return finish(fail('account_response_too_large',502));chunks.push(chunk);});
    response.once('end',()=>{let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return finish(fail('account_response_invalid',502));}
     if(response.statusCode<200||response.statusCode>=300)return finish(fail(typeof data?.error?.code==='string'?data.error.code:'account_request_failed',response.statusCode));finish(null,data);});
   });
  outgoing.once('error',()=>finish(fail('account_service_unavailable',503)));outgoing.end(bytes);
 });
}
export async function assertWorldSpace(req,target,canonical=worldCanonical){
 const management=await canonical(req,`/v1/spaces/${encodeURIComponent(target.spaceId)}/management`);
 if(management.worldImportConfigured!==true)throw fail('world_import_not_configured',503);
 // The deployed operable API puts ownership at the top level; canonical nests it.
 const space=management.space;if((management.isOwner??space?.owner)!==true||space?.spaceLifecycle!=='active')throw fail('world_space_unavailable',403);
 if(space.version!==target.spaceVersion||(management.sceneVersion??space.sceneVersion??null)!==target.sceneVersion)throw fail('version_conflict',409);
 return management;
}
export function createAccountWorldHttp({jobs,client,send,readBody,config,generate,existingOwner,authenticate=authenticateMoment,canonical=worldCanonical,signingKey=()=>process.env.WORLD_RESULT_SIGNING_KEY}={}){
 return async function handle(req,res,path){
  if(!path.startsWith('/api/world/'))return false;
  const context={admitted:false};
  try{
   if(req.headers['sec-fetch-site']==='cross-site'||req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)throw fail('origin_not_allowed',403);
   if(req.method==='GET'&&path==='/api/world/config'){await config(req,res,true);return true;}
   if(req.method==='POST'&&!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw fail('json_required',415);
   const {accountId}=await authenticate(req);context.accountId=accountId;context.owner='account:'+accountId;
   if(req.method==='GET'&&path==='/api/world/jobs'){send(res,200,{accountId,jobs:(await jobs.list(context.owner)).map(publicWorldJob)});return true;}
   if(req.method==='GET'&&path==='/api/world/jobs/legacy'){const old=existingOwner(req);send(res,200,{jobs:old?(await jobs.list(old)).map(publicWorldJob):[]});return true;}
   if(req.method==='POST'&&path==='/api/world/jobs/claim'){
    const body=await readBody(req,16384),old=existingOwner(req);if(!old)throw fail('world_claim_unavailable',409);
    if(!Array.isArray(body.ids)||body.ids.some(id=>!validId(id)))throw fail('world_claim_invalid',422);
    send(res,200,{accountId,jobs:(await jobs.claim(old,context.owner,body.ids)).map(publicWorldJob)});return true;
   }
   if(req.method==='POST'&&path==='/api/world/generate'){await generate(req,res,context);return true;}
   const match=path.match(/^\/api\/world\/jobs\/([A-Za-z0-9-]{16,80})(\/import)?$/);
   if(!match)throw fail('resource_unavailable',404);
   let job=await jobs.get(context.owner,match[1]);if(!job)throw fail('job_not_found',404);
   if(req.method==='GET'&&!match[2]){
    if(job.operation?.id&&!job.operation.done&&client){const operation=await client.getOperation(job.operation.id);job=await jobs.update(context.owner,job.id,{operation,status:operation.done?(operation.error?'failed':'complete'):'processing'});}
    send(res,200,{accountId,job:publicWorldJob(job)});return true;
   }
   if(req.method==='POST'&&match[2]){
    const body=await readBody(req,16384),target=worldTarget(body);
    if(job.spaceId&&job.spaceId!==target.spaceId)throw fail('world_space_target_mismatch',409);
    if(!job.operation?.done||job.operation.error||!job.operation.world?.id)throw fail('world_result_not_ready',409);
    if(job.importedSpaceId&&job.importedSpaceId!==target.spaceId)throw fail('world_space_target_mismatch',409);
    const key=signingKey();if(typeof key!=='string'||Buffer.byteLength(key)<32)throw fail('world_import_not_configured',503);
    const payload={version:1,accountId,...target,requestId:job.id,world:job.operation.world,issuedAt:new Date().toISOString()};
    const worldProof={payload,signature:createHmac('sha256',key).update(JSON.stringify(payload)).digest('base64url')};
    const result=await canonical(req,`/v1/spaces/${encodeURIComponent(target.spaceId)}/world-results`,{method:'POST',version:target.spaceVersion,body:{sceneIfMatchVersion:target.sceneVersion,worldProof},idempotencyKey:'world-import-'+job.id});
    job=await jobs.update(context.owner,job.id,{spaceId:target.spaceId,importedSpaceId:target.spaceId,importedSpace:result,importedAt:new Date().toISOString()});
    send(res,200,{space:result,job:publicWorldJob(job)});return true;
   }
   throw fail('method_not_allowed',405);
  }catch(error){
   const status=Number.isInteger(error.status)&&error.status>=400&&error.status<=599?error.status:503;
   const code=typeof error.code==='string'&&/^[a-z0-9_]+$/.test(error.code)?error.code:'service_temporarily_unavailable';
   const visible=publicWorldFailure(code,status);
   send(res,visible.status,{...visible.body,...(path==='/api/world/generate'&&context.admitted===false&&context.requestId?{requestId:context.requestId,admitted:false}:{})});return true;
  }
 };
}
