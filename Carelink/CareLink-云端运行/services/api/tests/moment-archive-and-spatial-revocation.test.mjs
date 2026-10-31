import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,png} from './fixture-factory.mjs';

test('archive and restore preserve every photo, original audio and message; public approval remains its frozen version',async()=>{
 const f=fixture();try{
  const owner=await f.login('archive-owner@example.test'),admin=await f.login('archive-admin@example.test'),other=await f.login('archive-other@example.test');
  f.db.prepare('UPDATE account_administration SET is_admin=1 WHERE account_id=?').run(admin.accountId);
  const photo=png(),audio=Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(4),Buffer.from('WAVEfmt '),Buffer.alloc(60)]);
  for(const [id,kind,mimeType,bytes]of[['photo','photo','image/png',photo],['voice','audio','audio/wav',audio]])await f.ok('PUT',`/v1/moment-media/${id}`,{kind,mimeType,name:id,dataBase64:bytes.toString('base64')},owner.headers);
  const input={id:'kept',title:'这一天',status:'complete',createdAt:f.clock.iso(),updatedAt:f.clock.iso(),photos:[{id:'p',mediaId:'photo',originalMediaId:'photo'}],messages:[{id:'m',role:'user',text:'必须保留的完整原话',createdAt:f.clock.iso(),audio:{mediaId:'voice',duration:1,waveform:[0,.5,1]}}]};
  const initial=await f.ok('PUT','/v1/moments/kept',{expectedVersion:0,moment:input},owner.headers);
  assert.equal((await f.ok('GET','/v1/moments',{},owner.headers)).moments[0].archivedAt,null);
  const submitted=await f.ok('POST','/v1/moments/kept/submissions',{consent:true,expectedVersion:1},owner.headers);
  await f.ok('POST',`/v1/admin/submissions/${submitted.submission.id}/review`,{decision:'approve',expectedVersion:1,reason:'合成样本人工审批'},admin.headers);
  const before=f.db.prepare("SELECT id,document_ciphertext,version FROM personal_memories WHERE record_kind='moment-media' ORDER BY id").all();
  const archived=await f.ok('PUT','/v1/moments/kept',{expectedVersion:1,moment:{...initial.moment,archivedAt:f.clock.iso()}},owner.headers);
  assert.equal((await f.ok('GET','/v1/moments',{},owner.headers)).moments[0].archivedAt,f.clock.iso());
  assert.equal((await f.call('PUT','/v1/moments/kept',{expectedVersion:1,moment:{...initial.moment,archivedAt:null}},owner.headers)).status,409);
  assert.equal((await f.call('GET','/v1/moments/kept',{},other.headers)).status,404);
  assert.equal((await f.call('PUT','/v1/moments/kept',{expectedVersion:2,moment:{...initial.moment,archivedAt:'yesterday'}},owner.headers)).body.error.code,'moment_archive_invalid');
  const publicCopy=await f.ok('GET',`/v1/public/moments/${submitted.submission.id}`);assert.equal(publicCopy.submission.status,'published');assert.equal(publicCopy.moment.archivedAt,undefined);
  const restored=await f.ok('PUT','/v1/moments/kept',{expectedVersion:archived.version,moment:{...archived.moment,archivedAt:null}},owner.headers);
  assert.deepEqual(restored.moment,{...initial.moment,archivedAt:null});
  assert.deepEqual(f.db.prepare("SELECT id,document_ciphertext,version FROM personal_memories WHERE record_kind='moment-media' ORDER BY id").all(),before);
  assert.deepEqual((await f.call('GET','/v1/moment-media/photo',{},owner.headers)).body,photo);
  assert.deepEqual((await f.call('GET','/v1/moment-media/voice',{},owner.headers)).body,audio);
 }finally{f.close();}
});

test('App spatial bytes are withheld if session, ownership or current panorama changes while the media store is reading',async()=>{
 for(const change of ['session','owner','panorama']){
  const f=fixture();try{
   const owner=await f.login('space-reader@example.test'),other=await f.login('space-stranger@example.test');
   const saved=await f.ok('PUT','/v1/app-spaces/kept-space',{consent:true,title:'持久空间',panorama:{name:'pano.png',mimeType:'image/png',dataBase64:png(1600,800).toString('base64')}},{...owner.headers,'x-unseen-expected-account-id':owner.accountId});
   const originalGet=f.api.mediaStore.get.bind(f.api.mediaStore);
   let markRead,release;const reading=new Promise(r=>markRead=r),unblock=new Promise(r=>release=r);
   f.api.mediaStore.get=async(...args)=>{const bytes=await originalGet(...args);markRead();await unblock;return bytes;};
   const response=f.call('GET',saved.space.panorama.url,{},owner.headers);await reading;
   if(change==='session')f.api.adminConsole.operations.revoke(owner.accountId);
   if(change==='owner')f.db.prepare('UPDATE spaces SET owner_account_id=? WHERE id=?').run(other.accountId,saved.space.spaceId);
   if(change==='panorama')f.db.prepare('UPDATE spaces SET current_panorama_revision_id=NULL WHERE id=?').run(saved.space.spaceId);
   release();const result=await response;assert.ok([401,404].includes(result.status),change);assert.ok(!Buffer.isBuffer(result.body),change);
  }finally{f.close();}
 }
});
