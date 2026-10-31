import {assert} from './errors.mjs';
import {id,sha256,stableJson} from './util.mjs';
import {PersonalMemoryService} from './personal-memory-service.mjs';
import {validMomentId} from './moment-service.mjs';

const MAX_TEXT=64000,MAX_BYTES=18*1024*1024,ACCOUNT_LIMIT=128*1024*1024;
const aad=(accountId,memoryId)=>`personal-memory-v1:${accountId}:${memoryId}`;
const sourceMessage=(message,photo,moment)=>message.role==='user'&&(message.photoId===photo.id||!message.photoId&&moment.photos.length===1);
const versionDto=row=>({storyId:row.id,spaceId:row.space_id,photoId:row.photo_id,visibility:row.visibility,version:row.version,createdAt:row.created_at});

export class PhotoStoryService {
 constructor(core,moments,viewerMedia){this.core=core;this.db=core.db;this.moments=moments;this.viewerMedia=viewerMedia;
  // Same encrypted media lifecycle, in a separate reserved namespace. This is
  // deliberately inaccessible through MomentService's moment-media:<id> routes.
  this.snapshots=new PersonalMemoryService(core,{recordKind:'moment-media'});
 }
 source(account,momentId,photoId){
  assert(validMomentId(momentId)&&validMomentId(photoId),'story_source_invalid');
  const saved=this.moments.get(account,momentId),moment=saved.moment,photo=moment.photos.find(p=>p.id===photoId);
  assert(photo,'story_source_unavailable',404);
  const original=this.moments.mediaDocument(account,photo.originalMediaId||photo.mediaId);
  assert(original.kind==='photo','story_source_unavailable',404);
  return {moment,photo,original,version:saved.version};
 }
 target(account,spaceId,photoId,original){
  const access=this.core.accountSpace(account,spaceId,{task:'upload'});
  assert(access.space.collection_state==='open','upload_unavailable',403);
  const photo=this.core.one(`SELECT p.*,b.actor_kind,b.actor_id,a.raw_sha256 FROM photos p
   JOIN contribution_batches b ON b.id=p.batch_id AND b.space_id=p.space_id
   JOIN assets a ON a.id=p.asset_id AND a.space_id=p.space_id
   WHERE p.id=? AND p.space_id=? AND p.deleted_at IS NULL`,photoId,spaceId);
  assert(photo&&photo.actor_kind==='account'&&photo.actor_id===account.accountId&&photo.raw_sha256===original.sha256,'story_target_unavailable',404);
  return {access,photo};
 }
 sources(account,query){
  const s=this.source(account,query.momentId,query.photoId);
  const candidates=s.moment.messages.filter(m=>sourceMessage(m,s.photo,s.moment)).map(m=>({messageId:m.id,text:m.text,
   ...(m.audio?{audio:{url:`/v1/moment-media/${m.audio.mediaId}`,duration:m.audio.duration}}:{})}));
  const rows=this.core.all(`SELECT p.id,p.space_id,s.name FROM photos p JOIN contribution_batches b ON b.id=p.batch_id
   JOIN assets a ON a.id=p.asset_id JOIN spaces s ON s.id=p.space_id WHERE b.actor_kind='account' AND b.actor_id=?
   AND a.raw_sha256=? AND p.deleted_at IS NULL ORDER BY p.rowid DESC`,account.accountId,s.original.sha256);
  const targets=[];for(const row of rows){try{this.target(account,row.space_id,row.id,s.original);targets.push({spaceId:row.space_id,photoId:row.id,name:row.name});}catch(error){if(error.status>=500)throw error;}}
  return {source:{momentId:s.moment.id,photoId:s.photo.id,version:s.version},candidates,targets};
 }
 create(ctx,account,spaceId,photoId){
  this.snapshots.requireExpectedAccount(ctx,account);
  const b=ctx.body;
  assert(b?.consent===true&&b.source&&typeof b.source==='object'&&!Array.isArray(b.source)&&Array.isArray(b.selections)&&b.selections.length>0&&b.selections.length<=20,'story_selection_invalid');
  assert(typeof b.authorCredit==='string'&&b.authorCredit.trim().length>0&&b.authorCredit.length<=80,'story_credit_invalid');
  const validate=()=>{this.core.account(ctx.accountSession);const s=this.source(account,b.source.momentId,b.source.photoId);this.target(account,spaceId,photoId,s.original);return s;};
  validate();
  return this.core.mutation(ctx,{endpoint:`/v1/spaces/${spaceId}/photos/${photoId}/stories`,scope:account.accountId,reauthorize:validate},()=>{
   const s=validate();assert(b.source.version===s.version,'story_source_changed',409);
   const seen=new Set(),selected=[];let selectedBytes=0;
   for(const choice of b.selections){
    assert(choice&&typeof choice.messageId==='string'&&!seen.has(choice.messageId)&&typeof choice.includeText==='boolean'&&typeof choice.includeAudio==='boolean'&&(choice.includeText||choice.includeAudio),'story_selection_invalid');seen.add(choice.messageId);
    const message=s.moment.messages.find(m=>m.id===choice.messageId);
    assert(message&&sourceMessage(message,s.photo,s.moment),'story_source_unavailable',404);
    const piece={messageId:message.id};
    if(choice.includeText){assert(message.text.trim().length>0,'story_selection_invalid');piece.text=message.text;}
    if(choice.includeAudio){assert(message.audio,'story_source_unavailable',404);const audio=this.moments.mediaDocument(account,message.audio.mediaId);assert(audio.kind==='audio','story_source_unavailable',404);
     piece.audio={mimeType:audio.mimeType,dataBase64:audio.dataBase64,sha256:audio.sha256,byteLength:audio.byteLength,duration:message.audio.duration};}
    selectedBytes+=Buffer.byteLength(JSON.stringify(piece));assert(selectedBytes<=MAX_BYTES,'story_too_large',413);
    selected.push(piece);
   }
   // Preserve the original conversation order, independent of checkbox click order.
   selected.sort((a,b)=>s.moment.messages.findIndex(m=>m.id===a.messageId)-s.moment.messages.findIndex(m=>m.id===b.messageId));
   assert(selected.reduce((n,p)=>n+(p.text?.length||0),0)<=MAX_TEXT,'story_too_large',413);
   const document={kind:'photo-story',title:'分享的故事',authorCredit:b.authorCredit.trim(),pieces:selected};
   const text=JSON.stringify(document),size=Buffer.byteLength(text);assert(size<=MAX_BYTES,'story_too_large',413);
   const digest=sha256(stableJson(document));
   const old=this.core.one(`SELECT * FROM photo_stories WHERE account_id=? AND photo_id=? AND selection_hash=? AND visibility!='withdrawn'`,account.accountId,photoId,digest);
   if(old)return versionDto(old);
   const usage=this.core.one('SELECT COALESCE(SUM(byte_length),0) bytes,COUNT(*) count FROM personal_memories WHERE account_id=?',account.accountId);
   assert(usage.bytes+size<=ACCOUNT_LIMIT&&usage.count<1000,'memory_storage_limit',413);
   const storyId=id('story'),memoryId=`photo-story:${storyId}`,now=this.core.now();
   this.db.prepare(`INSERT INTO personal_memories(account_id,id,document_ciphertext,envelope_key_id,byte_length,version,created_at,updated_at,record_kind)
    VALUES(?,?,?,?,?,1,?,?,'moment-media')`).run(account.accountId,memoryId,this.core.keyring.seal(text,aad(account.accountId,memoryId)),this.core.keyring.keyId,size,now,now);
   this.db.prepare(`INSERT INTO photo_stories(id,account_id,memory_id,space_id,photo_id,source_moment_id,source_photo_id,selection_hash,visibility,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,'visible',?,?)`).run(storyId,account.accountId,memoryId,spaceId,photoId,s.moment.id,s.photo.id,digest,now,now);
   return versionDto(this.core.one('SELECT * FROM photo_stories WHERE id=?',storyId));
  });
 }
 snapshot(row){return this.snapshots.get({accountId:row.account_id},row.memory_id).document;}
 dto(row,{own=false}={}){const snapshot=row.visibility==='withdrawn'?{pieces:[]}:this.snapshot(row);return {...versionDto(row),authorizationState:row.visibility==='withdrawn'?'withdrawn':'active',authorCredit:snapshot.authorCredit,
  pieces:snapshot.pieces.map(p=>({messageId:p.messageId,...(p.text!==undefined?{text:p.text}:{}),...(p.audio?{audio:{duration:p.audio.duration,url:`/v1/viewer/spaces/${row.space_id}/stories/${row.id}/audio/${p.messageId}`}}:{})})),
  ...(row.author_actor_kind?{sourceKind:'space-note'}:{}),
  ...(own?{...(row.author_actor_kind?{}:{source:{momentId:row.source_moment_id,photoId:row.source_photo_id}}),canWithdraw:row.visibility!=='withdrawn'}:{})};}
 mine(account,query){return {stories:this.core.all(`SELECT * FROM photo_stories WHERE account_id=? AND (author_actor_kind IS NULL OR (author_actor_kind='account' AND author_actor_id=account_id)) AND (? IS NULL OR space_id=?) ORDER BY created_at DESC,id`,account.accountId,query.spaceId||null,query.spaceId||null).map(row=>this.dto(row,{own:true}))};}
 visibleRows(spaceId){return this.core.all(`SELECT st.* FROM photo_stories st JOIN photos p ON p.id=st.photo_id AND p.space_id=st.space_id
  JOIN accounts a ON a.id=st.account_id WHERE st.space_id=? AND st.visibility='visible' AND p.photo_content_state='visible' AND p.deleted_at IS NULL AND a.status='active' ORDER BY st.created_at,st.id`,spaceId);}
 viewer(ctx,spaceId){const auth=this.viewerMedia.authorize(ctx,spaceId);const canHide=auth.branch==='account'&&auth.access.owner;return {stories:this.visibleRows(spaceId).map(row=>({...this.dto(row),canHide,canWithdraw:auth.branch==='account'&&row.account_id===auth.account.accountId&&(!row.author_actor_kind||row.author_actor_kind==='account'&&row.author_actor_id===auth.account.accountId)}))};}
 withdraw(ctx,account,storyId){this.snapshots.requireExpectedAccount(ctx,account);const authorize=()=>{this.core.account(ctx.accountSession);const row=this.core.one("SELECT * FROM photo_stories WHERE id=? AND account_id=? AND (author_actor_kind IS NULL OR (author_actor_kind='account' AND author_actor_id=account_id))",storyId,account.accountId);assert(row,'story_unavailable',404);return row;};authorize();
  return this.core.mutation(ctx,{endpoint:`/v1/photo-stories/${storyId}/withdrawals`,scope:account.accountId,reauthorize:authorize},()=>{const row=authorize();this.core.requireIfMatch(ctx,row);const now=this.core.now();
   this.db.prepare(`UPDATE photo_stories SET visibility='withdrawn',version=version+1,updated_at=? WHERE id=?`).run(now,storyId);
   // Remove the selected payload as well as its visibility. A stale audio URL is
   // denied before decryption, even if the source moment or membership is gone.
   this.db.prepare(`UPDATE personal_memories SET document_ciphertext=?,byte_length=2,envelope_key_id=?,version=version+1,updated_at=? WHERE account_id=? AND id=?`).run(this.core.keyring.seal('{}',aad(account.accountId,row.memory_id)),this.core.keyring.keyId,now,account.accountId,row.memory_id);
   return versionDto(this.core.one('SELECT * FROM photo_stories WHERE id=?',storyId));
  });
 }
 visibility(ctx,account,storyId){this.snapshots.requireExpectedAccount(ctx,account);assert(['hidden','visible'].includes(ctx.body?.to),'story_visibility_invalid');
  const authorize=()=>{this.core.account(ctx.accountSession);const row=this.core.one('SELECT * FROM photo_stories WHERE id=?',storyId);assert(row&&row.visibility!=='withdrawn','story_unavailable',404);this.core.accountSpace(account,row.space_id,{ownerOnly:true});return row;};authorize();
  return this.core.mutation(ctx,{endpoint:`/v1/photo-stories/${storyId}/visibility`,scope:account.accountId,reauthorize:authorize},()=>{const row=authorize();this.core.requireIfMatch(ctx,row);this.db.prepare('UPDATE photo_stories SET visibility=?,version=version+1,updated_at=? WHERE id=?').run(ctx.body.to,this.core.now(),storyId);return versionDto(this.core.one('SELECT * FROM photo_stories WHERE id=?',storyId));});
 }
 audio(ctx,spaceId,storyId,messageId){this.viewerMedia.authorize(ctx,spaceId);const row=this.visibleRows(spaceId).find(r=>r.id===storyId);assert(row,'story_unavailable',404);const audio=this.snapshot(row).pieces.find(p=>p.messageId===messageId)?.audio;assert(audio,'story_audio_unavailable',404);
  return this.serveAudio(ctx,audio);
 }
 serveAudio(ctx,audio){
  let body=Buffer.from(audio.dataBase64,'base64');const size=body.length,headers={'content-type':audio.mimeType,'cache-control':'no-store, private','x-content-type-options':'nosniff','cross-origin-resource-policy':'same-origin','accept-ranges':'bytes'};let status=200;
  if(ctx.headers.range){const match=/^bytes=(\d*)-(\d*)$/.exec(ctx.headers.range);assert(match&&(match[1]||match[2]),'media_range_invalid',416);const start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2])),end=match[1]&&match[2]?Math.min(size-1,Number(match[2])):size-1;assert(Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=0&&start<=end&&start<size,'media_range_invalid',416);body=body.subarray(start,end+1);headers['content-range']=`bytes ${start}-${end}/${size}`;status=206;}
  return {_raw:body,status,headers:{...headers,'content-length':String(body.length)}};
 }
}
export function registerPhotoStoryRoutes(api,add){
 const service=api.photoStories=new PhotoStoryService(api.core,api.moments,api.viewerMedia);
 add('GET','/v1/me/photo-story-sources',c=>service.sources(api.account(c),c.query));
 add('GET','/v1/me/photo-stories',c=>service.mine(api.account(c),c.query));
 add('POST','/v1/spaces/{sid}/photos/{pid}/stories',(c,p)=>service.create(c,api.account(c),p.sid,p.pid));
 add('POST','/v1/photo-stories/{storyId}/withdrawals',(c,p)=>service.withdraw(c,api.account(c),p.storyId));
 add('POST','/v1/photo-stories/{storyId}/visibility',(c,p)=>service.visibility(c,api.account(c),p.storyId));
 add('GET','/v1/viewer/spaces/{sid}/stories',(c,p)=>service.viewer(c,p.sid));
 add('GET','/v1/viewer/spaces/{sid}/stories/{storyId}/audio/{messageId}',(c,p)=>service.audio(c,p.sid,p.storyId,p.messageId));
}
