// Canonical contribution workflow. Persist request identities and digests, never upload,
// invitation or receipt secrets. Every retry first reconciles the existing server item.
const uuid=()=>crypto.randomUUID();
const encode=encodeURIComponent;
const fail=code=>{throw Object.assign(new Error(code),{code});};
export const stableJson=value=>JSON.stringify(value&&typeof value==='object'?(Array.isArray(value)?value.map(v=>JSON.parse(stableJson(v))):Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(stableJson(value[k]))]))):value);
export async function sharedDigest(value){const data=value instanceof Blob?await value.arrayBuffer():new TextEncoder().encode(value);return [...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(n=>n.toString(16).padStart(2,'0')).join('');}
export async function batchDigest(items){return sharedDigest(stableJson(items.map(item=>({itemId:item.itemId||item.id,status:item.status,version:item.itemVersion??item.version,failureCode:item.failureCode??null}))));}
export function sharedPhotoFile(blob,name='照片.jpg') {
  const ext=name.split('.').at(-1)?.toLowerCase(),type=blob?.type?.split(';')[0]||({jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',heic:'image/heic',heif:'image/heif'}[ext]);
  if(!(blob instanceof Blob)||!blob.size)fail('upload_original_file_required');
  return new File([blob],name,{type:type||'application/octet-stream'});
}
export function validateSharedFiles(files,context){
  if(!Array.isArray(files)||!files.length||files.length>context.limits?.batchItems)fail('upload_selection_invalid');
  for(const file of files)if(!(file instanceof Blob)||!file.size||file.size>context.limits.photoBytes||!(context.photoFormats||context.formats||[]).filter(x=>x.startsWith('image/')).includes(file.type))fail('upload_photo_policy');
}
export function sharedTicket(envelope,origin=globalThis.location?.origin||'http://localhost'){
 const ticket=envelope?.oneTimeUploadTicket||envelope?.exactPrivateUploadTicketOnce;
 const exact=envelope?.exactPrivateObjectKey||ticket?.exactPrivateObjectKey;
 if(!ticket?.url||!exact||!ticket.headers||typeof ticket.headers!=='object'||Array.isArray(ticket.headers))fail('upload_ticket_invalid');
 const url=new URL(ticket.url,origin);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||!decodeURIComponent(url.pathname).endsWith('/'+exact))fail('upload_ticket_invalid');
 // Canonical local tickets use its public origin; the App exposes the same private proxy path.
 if(/^\/__(?:local\/media|local-operable\/private-media)\//.test(url.pathname))return {url:url.pathname+url.search,headers:ticket.headers};
 return {url:url.href,headers:ticket.headers};
}
export class SharedUpload {
 constructor({request,spaceId,identityKey,signal,isCurrent=()=>true,onChange=()=>{},storage=globalThis.sessionStorage,transport=(url,options)=>globalThis.fetch(url,options)}){
  Object.assign(this,{request,spaceId,identityKey,signal,isCurrent,onChange,storage,transport});this.files=new Map();this.busy=false;this.result=null;
  this.key='unseen.shared-upload.v1.'+identityKey+'.'+spaceId;
  try{const state=JSON.parse(storage?.getItem(this.key)||'null');this.state=state?.spaceId===spaceId&&state.identityKey===identityKey&&Array.isArray(state.files)?state:null;}catch{this.state=null;}
 }
 check(){if(this.signal?.aborted||!this.isCurrent())throw new DOMException('已取消','AbortError');}
 save(){this.check();try{if(this.state)this.storage?.setItem(this.key,JSON.stringify(this.state));else this.storage?.removeItem(this.key);}catch{fail('upload_recovery_storage_unavailable');}this.onChange(this);}
 async call(path,options={}){this.check();const result=await this.request(path,{...options,signal:this.signal});this.check();return result;}
 async context(){return this.call(`/v1/spaces/${encode(this.spaceId)}/upload-context`);}
 async refresh(){if(this.state?.batchId)this.result=await this.call(`/v1/contribution-batches/${encode(this.state.batchId)}/result`);this.onChange(this);return this.result;}
 async start(files,context,{refKeys=[]}={}){
  this.check();if(this.state)fail('upload_pending_batch');validateSharedFiles(files,context);
  const entries=[];for(const [index,file]of files.entries()){const clientId=uuid();entries.push({clientId,itemKey:uuid(),name:file.name||'照片',type:file.type,size:file.size,sha256:await sharedDigest(file),refKey:refKeys[index]||null});this.check();this.files.set(clientId,file);}
  this.state={spaceId:this.spaceId,identityKey:this.identityKey,createdAt:new Date().toISOString(),files:entries,consentKey:uuid(),consentBody:{purpose:'photo_upload',noticeVersion:context.mediaNotice.version,noticeHash:context.mediaNotice.hash},batchKey:uuid(),clientBatchId:uuid()};this.save();return this.resume();
 }
 async ensureBatch(){
  const s=this.state;if(!s)fail('batch_unavailable');
  if(s.batchId)return;
  if(!s.consentEventId){const consent=await this.call('/v1/consent-events',{method:'POST',body:s.consentBody,key:s.consentKey});s.consentEventId=consent.consentEventId;this.save();}
  const created=await this.call(`/v1/spaces/${encode(this.spaceId)}/contribution-batches`,{method:'POST',body:{clientBatchId:s.clientBatchId,consentEventId:s.consentEventId,declaredItemCount:s.files.length},key:s.batchKey});
  s.batchId=created.batchId;this.save();
 }
 async resume(index=null,replacement=null){
  if(this.busy)fail('upload_busy');this.busy=true;this.onChange(this);
  try{await this.ensureBatch();await this.refresh();const indexes=index===null?this.state.files.map((_,i)=>i):[index];
   for(const i of indexes){this.check();const entry=this.state.files[i];if(!entry)fail('upload_selection_invalid');
    try{await this.sendFile(entry,index===i&&replacement?replacement:this.files.get(entry.clientId));}catch(error){if(error.name==='AbortError')throw error;entry.error=error.code||'network_error';this.save();}
   }
   await this.refresh();return this.result;
  }finally{this.busy=false;if(this.isCurrent()&&!this.signal?.aborted)this.onChange(this);}
 }
 async sendFile(entry,file,attempt=0){
  await this.refresh();let item=this.result?.items?.find(i=>(i.itemId||i.id)===entry.itemId);
  if(['committed','removed'].includes(item?.status)){entry.error=null;this.save();return;}
  if(!file)fail('upload_original_file_required');
  if(file.size!==entry.size||file.type!==entry.type||await sharedDigest(file)!==entry.sha256)fail('upload_original_file_mismatch');this.check();this.files.set(entry.clientId,file);
  entry.error=null;entry.phase='准备上传';this.save();
  if(!entry.itemId){
   const context=await this.context();
   entry.addVersion??=this.result.version??this.result.ifMatch;entry.addSpaceVersion??=context.spaceVersion??context.version;this.save();
   const created=await this.call(`/v1/contribution-batches/${encode(this.state.batchId)}/items`,{method:'POST',body:{clientItemId:entry.clientId,declaredMime:entry.type,declaredBytes:entry.size,fileNameHash:await sharedDigest(entry.name)},version:entry.addVersion,headers:{'X-Space-Version':String(entry.addSpaceVersion)},key:entry.itemKey});
   entry.itemId=created.itemId;this.save();await this.refresh();item=this.result.items.find(i=>(i.itemId||i.id)===entry.itemId);
  }
  if(!item)fail('item_unavailable');
  if(!entry.authorization||(item.status==='failed'&&entry.authorization.itemVersion!==item.itemVersion)){
   entry.authorization={key:uuid(),clientUploadId:uuid(),itemVersion:item.itemVersion??item.version};entry.objectUploaded=false;entry.commitVersion=null;entry.commitKey=uuid();entry.commitId=uuid();this.save();
  }
  const spec=entry.authorization;
  const auth=await this.call(`/v1/contribution-batches/${encode(this.state.batchId)}/items/${encode(entry.itemId)}/upload-sessions`,{method:'POST',body:{declaredMime:entry.type,declaredBytes:entry.size,clientUploadId:spec.clientUploadId},version:spec.itemVersion,key:spec.key});
  if(auth.secretUnavailable){if(attempt>=1)fail('upload_ticket_expired');entry.authorization=null;this.save();return this.sendFile(entry,file,attempt+1);}
  const commit=async()=>{
   await this.refresh();const current=this.result.items.find(i=>(i.itemId||i.id)===entry.itemId);
   if(current?.status==='committed')return current;
   if(current?.uploadSessionId===auth.uploadSessionId&&['issued','uploaded'].includes(current.uploadSessionStatus))entry.commitVersion=`upload:${current.uploadSessionVersion};item:${current.itemVersion}`;
   entry.commitVersion ||= auth.commitIfMatch||auth.ifMatch;this.save();
   return this.call(`/v1/upload-sessions/${encode(auth.uploadSessionId)}/commits`,{method:'POST',body:{clientCommitId:entry.commitId},version:entry.commitVersion,key:entry.commitKey});
  };
  if(!entry.objectUploaded){
   entry.phase='正在上传原图';this.save();const ticket=sharedTicket(auth);
   try{const response=await this.transport(ticket.url,{method:'PUT',headers:ticket.headers,body:file,credentials:'omit',signal:this.signal});this.check();if(!response.ok)fail('upload_object_failed');
    const put=await response.json().catch(()=>null);this.check();if(put?.uploadSessionVersion)entry.commitVersion=`upload:${put.uploadSessionVersion};item:${auth.itemVersion}`;
    entry.objectUploaded=true;this.save();}
   catch(error){this.check();if(error.name==='AbortError')throw error;
    // The PUT response may be lost after durable storage. Reconcile via the same commit,
    // whose server re-inspects the exact object, before asking the user to resend bytes.
    try{await commit();await this.refresh();item=this.result.items.find(i=>(i.itemId||i.id)===entry.itemId);if(item?.status==='committed'){entry.phase='已接收';entry.error=null;this.files.delete(entry.clientId);this.save();return;}}catch(reconcile){this.check();}
    throw error;
   }
  }
  entry.phase='正在检查';this.save();await commit();this.files.delete(entry.clientId);entry.phase='已接收';entry.error=null;this.save();await this.refresh();
 }
 complete(){return Boolean(this.state&&this.result?.items?.length===this.state.files.length&&this.result.items.every(i=>i.status==='committed'));}
 async finalize(){
  if(this.busy)fail('upload_busy');this.busy=true;this.onChange(this);
  try{await this.ensureBatch();await this.refresh();const s=this.state,r=this.result;
   if(!this.complete())fail('upload_items_not_finished');
   const digest=r.itemsDigest||await batchDigest(r.items);this.check();
   if(!s.finalization||s.finalization.digest!==digest){s.finalization={key:uuid(),clientRequestId:uuid(),digest,version:r.version??r.ifMatch,exchangeKey:uuid(),nonce:uuid()};this.save();}
   const f=s.finalization;
   const receipt=await this.call(`/v1/contribution-batches/${encode(s.batchId)}/finalizations`,{method:'POST',body:{itemsDigest:f.digest,clientRequestId:f.clientRequestId},version:f.version,key:f.key});
   if(!receipt.receiptSessionReady){const raw=receipt.oneTimeSecret||new URL(receipt.receiptBootstrapUrlOnce||receipt.batchReceiptBootstrapUrlOnce||'/',globalThis.location?.origin||'http://localhost').hash.match(/^#receipt=([A-Za-z0-9_-]+)$/)?.[1];if(!raw)fail('receipt_recovery_required');
    await this.call('/v1/batch-receipt-exchanges',{method:'POST',body:{receiptSecretFromClearedBootstrap:raw,clientNonce:f.nonce},key:f.exchangeKey});}
   const verified=await this.call('/v1/batch-receipt');if(verified.batchId!==s.batchId)fail('receipt_unavailable');
   const contributions=s.files.map(e=>({refKey:e.refKey,photoId:r.items.find(i=>(i.itemId||i.id)===e.itemId)?.photoId})).filter(x=>x.photoId);
   const finished={spaceId:this.spaceId,batchId:s.batchId,receiptId:receipt.receiptId,photoIds:contributions.map(x=>x.photoId),contributions,receipt:verified};
   s.completed=finished;s.finalizedAt=new Date().toISOString();this.save();return finished;
  }finally{this.busy=false;if(this.isCurrent()&&!this.signal?.aborted)this.onChange(this);}
 }
 clearCompleted(){if(!this.state?.completed)fail('upload_pending_batch');this.state=null;this.result=null;this.files.clear();this.save();}
}
