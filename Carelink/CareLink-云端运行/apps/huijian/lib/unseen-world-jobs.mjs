import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {publicWorldErrorCode, publicWorldOperation} from './worldlabs-public-errors.mjs';
export function createWorldJobStore(filePath){
 let queue=Promise.resolve();
 const run=fn=>{const next=queue.then(async()=>{let records={};try{records=JSON.parse(await readFile(filePath,'utf8'));if(!records||Array.isArray(records)||typeof records!=='object')throw new Error('invalid');}catch(error){if(error.code!=='ENOENT')throw Object.assign(new Error('world_jobs_unavailable'),{code:'world_jobs_unavailable'});}const result=await fn(records);await mkdir(dirname(filePath),{recursive:true});const temp=`${filePath}.${randomUUID()}.tmp`;await writeFile(temp,JSON.stringify(records),{mode:0o600});await rename(temp,filePath);return result;});queue=next.catch(()=>{});return next;};
 const key=(owner,id)=>createHash('sha256').update(owner+':'+id).digest('hex');
 return {
  begin(owner,id,input){return run(records=>{const k=key(owner,id),hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');const existing=records[k];if(existing){if(existing.claimedBy||existing.inputHash!==hash)throw Object.assign(new Error('world_request_conflict'),{status:409});return {fresh:false,job:existing};}if(owner.startsWith('account:')&&Object.values(records).some(j=>j.owner===key(owner,'owner')&&!j.claimedBy&&['submitting','unknown'].includes(j.status)&&!j.operation?.id))throw Object.assign(new Error('world_result_pending_reconciliation'),{code:'world_result_pending_reconciliation',status:409});const job={id,owner:key(owner,'owner'),inputHash:hash,status:'submitting',createdAt:Date.now(),updatedAt:Date.now(),...(input.spaceId?{spaceId:input.spaceId,spaceVersion:input.spaceVersion,sceneVersion:input.sceneVersion}:{}),...(input.displayName?{displayName:input.displayName}:{}),...(input.model?{model:input.model}:{}),...(input.mode?{mode:input.mode}:{}),...(input.sceneSource?{sceneSource:input.sceneSource}:{}),...(input.images?{imageCount:input.images.length}:{})};records[k]=job;return {fresh:true,job};});},
  update(owner,id,patch){return run(records=>{let k=key(owner,id);if(!records[k])throw new Error('world_job_missing');const seen=new Set();while(records[k].claimedBy){if(seen.has(k))throw new Error('world_claim_cycle');seen.add(k);const target=Object.entries(records).find(([,j])=>j.id===id&&j.owner===records[k].claimedBy);if(!target)throw new Error('world_claim_target_missing');k=target[0];}records[k]={...records[k],...patch,updatedAt:Date.now()};return records[k];});},
  get(owner,id){return run(records=>{const job=records[key(owner,id)];return job&&!job.claimedBy?job:null;});},
  list(owner){return run(records=>Object.values(records).filter(j=>j.owner===key(owner,'owner')&&!j.claimedBy).sort((a,b)=>b.createdAt-a.createdAt));},
  claim(sourceOwner,targetOwner,ids){return run(records=>{
    if(!Array.isArray(ids)||!ids.length||ids.length>100||new Set(ids).size!==ids.length)throw Object.assign(new Error('world_claim_invalid'),{code:'world_claim_invalid',status:422});
    const targetHash=key(targetOwner,'owner');
    const selected=ids.map(id=>{
      const old=records[key(sourceOwner,id)],target=records[key(targetOwner,id)];
      if(!old||old.claimedBy&&old.claimedBy!==targetHash||target&&target.inputHash!==old.inputHash)throw Object.assign(new Error('world_claim_unavailable'),{code:'world_claim_unavailable',status:409});
      return {id,old,target};
    });
    return selected.map(({id,old,target})=>{
      if(!target){const {claimedBy,claimedAt,...original}=old;records[key(targetOwner,id)]={...original,owner:targetHash};}
      records[key(sourceOwner,id)]={...old,claimedBy:targetHash,claimedAt:old.claimedAt||Date.now()};
      return records[key(targetOwner,id)];
    });
  });}
 };
}
export function publicWorldJob(job){if(!job)return null;const {owner,inputHash,...visible}=job;return {...visible,...(job.error?{error:publicWorldErrorCode(job.error)}:{}),...(job.operation?{operation:publicWorldOperation(job.operation)}:{})};}
