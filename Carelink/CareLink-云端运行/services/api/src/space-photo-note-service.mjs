import {assert} from './errors.mjs';
import {id,sha256,stableJson,parseJson} from './util.mjs';
import {plausibleMedia} from './moment-service.mjs';

const MAX_AUDIO=6*1024*1024, ACCOUNT_LIMIT=128*1024*1024;
const aad=(accountId,memoryId)=>`personal-memory-v1:${accountId}:${memoryId}`;
const audioTypes=new Set(['audio/webm','audio/mp4','audio/ogg','audio/wav','audio/mpeg']);
export class SpacePhotoNoteService {
 constructor(api){this.api=api;this.core=api.core;this.db=api.core.db;this.stories=api.photoStories;}
 target(ctx,spaceId,photoId){
  const actor=this.api.uploads.actor(ctx,spaceId);
  if(actor.account)this.stories.snapshots.requireExpectedAccount(ctx,actor.account);
  const photo=this.core.one(`SELECT p.*,b.actor_kind,b.actor_id FROM photos p JOIN contribution_batches b ON b.id=p.batch_id
   WHERE p.id=? AND p.space_id=? AND p.deleted_at IS NULL`,photoId,spaceId);
  assert(photo&&!['hidden','rejected'].includes(photo.photo_content_state),'story_target_unavailable',404);
  const own=photo.actor_kind===actor.kind&&photo.actor_id===actor.id;
  if(!own){
   assert(photo.photo_content_state==='visible','story_target_unavailable',404);
   if(actor.account)this.core.accountSpace(actor.account,spaceId,{task:'view'});
   else {const c=actor.contributor;assert(c.space.sharing_state==='shared'&&parseJson(c.grant.tasks_json,[]).includes('view'),'story_target_unavailable',404);}
  }
  return {actor,photo};
 }
 context(ctx,sid,pid){
  const {actor,photo}=this.target(ctx,sid,pid);
  const rows=this.core.all(`SELECT * FROM photo_stories WHERE space_id=? AND photo_id=? AND author_actor_kind=? AND author_actor_id=? AND visibility!='withdrawn' ORDER BY created_at,id`,sid,pid,actor.kind,actor.id);
  return {photoId:pid,upload:this.api.viewerMedia.photoUploadInfo(photo),authorCredit:actor.account?this.core.one('SELECT display_name FROM account_administration WHERE account_id=?',actor.id)?.display_name||'':'',
   photoMedia:{url:`/v1/spaces/${sid}/photos/${pid}/note-media`},stories:rows.map(r=>{const dto=this.stories.dto(r);return {...dto,canWithdraw:true,pieces:dto.pieces.map(p=>({...p,...(p.audio?{audio:{...p.audio,url:`/v1/spaces/${sid}/photos/${pid}/notes/${r.id}/audio/${p.messageId}`}}:{})}))};})};
 }
 audio(ctx,sid,pid,storyId,messageId){
  const {actor}=this.target(ctx,sid,pid);
  const row=this.core.one("SELECT * FROM photo_stories WHERE id=? AND space_id=? AND photo_id=? AND author_actor_kind=? AND author_actor_id=? AND visibility='visible'",storyId,sid,pid,actor.kind,actor.id);
  assert(row,'story_unavailable',404);const audio=this.stories.snapshot(row).pieces.find(p=>p.messageId===messageId)?.audio;assert(audio,'story_audio_unavailable',404);return this.stories.serveAudio(ctx,audio);
 }
 media(ctx,sid,pid){
  const {photo}=this.target(ctx,sid,pid);
  const asset=this.core.one(`SELECT * FROM assets WHERE id=? AND space_id=? AND validation_state='valid'`,photo.viewer_safe_asset_id,sid);
  assert(asset,'media_unavailable',404);
  return this.api.viewerMedia.serve(ctx,{photo:photo.version,asset:asset.version},asset,()=>{assert(this.target(ctx,sid,pid).photo.viewer_safe_asset_id===asset.id,'media_unavailable',404);});
 }
 create(ctx,sid,pid){
  const authorize=()=>this.target(ctx,sid,pid),{actor}=authorize(),b=ctx.body;
  assert(b?.consent===true&&typeof b.text==='string'&&b.text.length<=4000&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(b.text),'story_selection_invalid');
  assert(typeof b.authorCredit==='string'&&b.authorCredit.trim().length>0&&b.authorCredit.length<=80,'story_credit_invalid');
  const piece={messageId:'original'};if(b.text.trim())piece.text=b.text;
  if(b.audio!=null){
   const a=b.audio;assert(typeof a.mimeType==='string','story_audio_invalid');const mime=a.mimeType.split(';')[0].trim();
   assert(audioTypes.has(mime)&&typeof a.dataBase64==='string'&&a.dataBase64.length<=Math.ceil(MAX_AUDIO/3)*4,'story_audio_invalid',413);
   const bytes=Buffer.from(a.dataBase64,'base64');
   assert(bytes.length>0&&bytes.length<=MAX_AUDIO&&bytes.toString('base64')===a.dataBase64&&plausibleMedia(bytes,mime),'story_audio_invalid');
   assert(Number.isFinite(a.duration)&&a.duration>0&&a.duration<=120,'story_audio_invalid');
   piece.audio={mimeType:mime,dataBase64:a.dataBase64,duration:a.duration,byteLength:bytes.length,sha256:sha256(bytes)};
  }
  assert(piece.text||piece.audio,'story_selection_invalid');
  return this.core.mutation(ctx,{endpoint:`/v1/spaces/${sid}/photos/${pid}/notes`,scope:`${actor.kind}:${actor.id}`,reauthorize:authorize},()=>{
   authorize();const accountId=actor.account?.accountId||actor.space.owner_account_id;
   const document={kind:'photo-story',title:'照片里的原话',authorCredit:b.authorCredit.trim(),pieces:[piece]};
   const text=JSON.stringify(document),size=Buffer.byteLength(text),digest=sha256(stableJson({...document,actor:{kind:actor.kind,id:actor.id},request:ctx.idempotencyKey}));
   const usage=this.core.one('SELECT COALESCE(SUM(byte_length),0) bytes,COUNT(*) count FROM personal_memories WHERE account_id=?',accountId);
   assert(usage.bytes+size<=ACCOUNT_LIMIT&&usage.count<1000,'memory_storage_limit',413);
   const storyId=id('story'),memoryId=`photo-story:${storyId}`,now=this.core.now();
   this.db.prepare(`INSERT INTO personal_memories(account_id,id,document_ciphertext,envelope_key_id,byte_length,version,created_at,updated_at,record_kind)
    VALUES(?,?,?,?,?,1,?,?,'moment-media')`).run(accountId,memoryId,this.core.keyring.seal(text,aad(accountId,memoryId)),this.core.keyring.keyId,size,now,now);
   this.db.prepare(`INSERT INTO photo_stories(id,account_id,memory_id,space_id,photo_id,source_moment_id,source_photo_id,selection_hash,visibility,created_at,updated_at,author_actor_kind,author_actor_id)
    VALUES(?,?,?,?,?,'','',?,'visible',?,?,?,?)`).run(storyId,accountId,memoryId,sid,pid,digest,now,now,actor.kind,actor.id);
   // Never include submitted words or audio in the idempotency cache.
   return {storyId,spaceId:sid,photoId:pid,visibility:'visible',version:1,createdAt:now};
  });
 }
 withdraw(ctx,sid,pid,storyId){
  const authorize=()=>{const {actor}=this.target(ctx,sid,pid),row=this.core.one('SELECT * FROM photo_stories WHERE id=? AND space_id=? AND photo_id=? AND author_actor_kind=? AND author_actor_id=?',storyId,sid,pid,actor.kind,actor.id);assert(row,'story_unavailable',404);return {actor,row};};
  const {actor}=authorize();return this.core.mutation(ctx,{endpoint:`/v1/spaces/${sid}/photos/${pid}/notes/${storyId}/withdrawals`,scope:`${actor.kind}:${actor.id}`,reauthorize:authorize},()=>{
   const {row}=authorize();this.core.requireIfMatch(ctx,row);const now=this.core.now();
   this.db.prepare("UPDATE photo_stories SET visibility='withdrawn',version=version+1,updated_at=? WHERE id=?").run(now,storyId);
   this.db.prepare('UPDATE personal_memories SET document_ciphertext=?,byte_length=2,envelope_key_id=?,version=version+1,updated_at=? WHERE account_id=? AND id=?').run(this.core.keyring.seal('{}',aad(row.account_id,row.memory_id)),this.core.keyring.keyId,now,row.account_id,row.memory_id);
   return {storyId,version:row.version+1,visibility:'withdrawn'};
  });
 }
}
export function registerSpacePhotoNoteRoutes(api,add){
 const s=api.spacePhotoNotes=new SpacePhotoNoteService(api);
 add('GET','/v1/spaces/{sid}/photos/{pid}/notes',(c,p)=>s.context(c,p.sid,p.pid));
 add('POST','/v1/spaces/{sid}/photos/{pid}/notes',(c,p)=>s.create(c,p.sid,p.pid));
 add('GET','/v1/spaces/{sid}/photos/{pid}/note-media',(c,p)=>s.media(c,p.sid,p.pid));
 add('GET','/v1/spaces/{sid}/photos/{pid}/notes/{storyId}/audio/{messageId}',(c,p)=>s.audio(c,p.sid,p.pid,p.storyId,p.messageId));
 add('POST','/v1/spaces/{sid}/photos/{pid}/notes/{storyId}/withdrawals',(c,p)=>s.withdraw(c,p.sid,p.pid,p.storyId));
}
