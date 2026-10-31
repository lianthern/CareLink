import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,png,createAccountUpload,mp4} from './fixture-factory.mjs';
import {LocalKeyring} from '../src/crypto.mjs';
import {exportPersonalMemories} from '../src/personal-memory-service.mjs';
import {registerCommunitySpaceRoutes} from '../src/community-space-service.mjs';
export async function communityFixture(options={}) {
 const f=fixture(options); if(!f.api.communitySpaces) registerCommunitySpaceRoutes(f.api,f.api.add.bind(f.api));
 const owner=await f.login('space-owner@example.test'), admin=await f.login('space-reviewer@example.test'), other=await f.login('space-other@example.test');
 f.db.prepare("UPDATE account_administration SET is_admin=1,admin_role='admin' WHERE account_id=?").run(admin.accountId);
 const pano=png(1600,800), depth=png(32,16);
 const saved=await f.ok('PUT','/v1/app-spaces/community-fixture',{consent:true,title:'PRIVATE TITLE',panorama:{name:'private.png',mimeType:'image/png',dataBase64:pano.toString('base64')},depth:{name:'depth.png',mimeType:'image/png',dataBase64:depth.toString('base64')},metadata:{model:'DAP',convention:'near_small',min:.01,max:.19,width:32,height:16,source_image:'private.png',source_resolution:[1600,800]}},{...owner.headers,'x-unseen-expected-account-id':owner.accountId});
 const sid=saved.space.spaceId;
 const eligible=()=>f.ok('GET',`/v1/spaces/${sid}/community/eligible`,{},owner.headers);
 const submit=async(photoIds=[])=>f.ok('POST',`/v1/spaces/${sid}/community/submissions`,{expectedVersion:(await eligible()).spaceVersion,consent:true,title:'公开空间',description:'明确公开说明',authorName:'公开署名',includeDepth:true,photoIds},owner.headers);
 const review=(id,expectedVersion,decision)=>f.ok('POST',`/v1/admin/community/spaces/${id}/review`,{expectedVersion,decision,reason:'合成数据审核'},admin.headers);
 return {...f,owner,admin,other,pano,sid,eligible,submit,review};
}
test('community frozen publication transitions, public projection, replay, legacy CLI gate and removal',async()=>{
 const f=await communityFixture(); try {
  const pending=(await f.submit()).submission, id=pending.id, pub=`/v1/public/spaces/${id}`;
  assert.equal((await f.call('GET',pub)).status,404);
  assert.equal((await f.call('GET',`/v1/admin/community/spaces/${id}`,{},f.other.headers)).status,403);
  const preview=await f.ok('GET',`/v1/admin/community/spaces/${id}`,{},f.admin.headers);
  assert.equal(preview.space.photos.length,0); assert.ok(!JSON.stringify(preview).includes('PRIVATE TITLE'));
  f.db.prepare("UPDATE public_space_listings SET status='listed',open_url='/legacy-private' WHERE community_submission_id=?").run(id);
  assert.equal((await f.call('GET',pub)).status,404); assert.deepEqual((await f.ok('GET','/v1/discover/spaces')).spaces,[]);
  const published=(await f.review(id,1,'approve')).submission;
  assert.equal(published.version,2);
  const dto=await f.ok('GET',pub); assert.equal(dto.submission.authorId,f.owner.accountId);
  for(const secret of ['spaceId','reason','example.test','private.png','PRIVATE TITLE','source_image','private_object_key']) assert.ok(!JSON.stringify(dto).includes(secret),secret);
  assert.deepEqual((await f.call('GET',pub+'/media/panorama')).body,f.pano);
  assert.equal((await f.call('GET',pub+'/media/__proto__')).status,404);
  const ranged=await f.call('GET',pub+'/media/panorama',{}, {range:'bytes=0-9'}); assert.equal(ranged.status,206); assert.equal(ranged.body.length,10);
  assert.equal((await f.call('POST',`/v1/spaces/${f.sid}/community/submissions`,{expectedVersion:(await f.eligible()).spaceVersion,consent:true,title:'更新',description:'',authorName:'我',includeDepth:false,photoIds:[]},f.owner.headers)).status,409);
  const key={'idempotency-key':'community-unpublish-unique',...f.admin.headers},body={expectedVersion:2,decision:'unpublish',reason:'暂时下架'};
  await f.ok('POST',`/v1/admin/community/spaces/${id}/review`,body,key); assert.equal((await f.call('GET',pub+'/media/panorama')).status,404);
  assert.equal((await f.ok('POST',`/v1/admin/community/spaces/${id}/review`,body,key)).replayed,true);
  await f.review(id,3,'restore');
  await f.ok('POST',`/v1/me/community/spaces/${id}/withdraw`,{expectedVersion:4},f.owner.headers);
  assert.equal((await f.call('GET',pub)).status,404);
  assert.equal((await f.call('POST',`/v1/admin/community/spaces/${id}/review`,{expectedVersion:5,decision:'restore',reason:'不能复活'},f.admin.headers)).status,409);
  assert.ok((await f.submit()).submission.id!==id);
 } finally {f.close();}
});
test('community rechecks authorization after media await and removes metadata with encrypted snapshot',async()=>{
 const f=await communityFixture(); try {
  const id=(await f.submit()).submission.id; await f.review(id,1,'approve');
  const get=f.api.mediaStore.get.bind(f.api.mediaStore);
  f.api.mediaStore.get=async(...args)=>{const object=await get(...args); f.db.prepare("UPDATE account_administration SET status='disabled' WHERE account_id=?").run(f.owner.accountId); return object;};
  assert.equal((await f.call('GET',`/v1/public/spaces/${id}/media/panorama`)).status,404);
  f.api.mediaStore.get=get; f.db.prepare("UPDATE account_administration SET status='active' WHERE account_id=?").run(f.owner.accountId);
  assert.equal((await f.call('GET',`/v1/public/spaces/${id}`)).status,200);
  f.api.mediaStore.get=async(...args)=>{const object=await get(...args); f.db.prepare("UPDATE account_administration SET is_admin=0,admin_role='user' WHERE account_id=?").run(f.admin.accountId); return object;};
  assert.equal((await f.call('GET',`/v1/admin/community/spaces/${id}/media/panorama`,{},f.admin.headers)).status,403);
  f.db.prepare('DELETE FROM personal_memories WHERE account_id=?').run(f.owner.accountId);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM community_space_submissions').get().n,0);
  assert.equal(f.db.prepare('SELECT status FROM public_space_listings').get().status,'hidden');
 } finally {f.close();}
});
test('photo-only publication freezes owner selected safe photo/video and denies transferred or deleted sources',async()=>{
 const f=fixture(); if(!f.api.communitySpaces)registerCommunitySpaceRoutes(f.api,f.api.add.bind(f.api));
 try {
  const owner=await f.login('album-owner@example.test'),admin=await f.login('album-reviewer@example.test'),other=await f.login('album-other@example.test');
  f.db.prepare("UPDATE account_administration SET is_admin=1,admin_role='admin' WHERE account_id=?").run(admin.accountId);
  const space=await f.openSpace(owner,await f.createSpace(owner,'PRIVATE ALBUM'));
  const photo=await createAccountUpload(f,owner,space), video=await createAccountUpload(f,owner,space,mp4(),'video/mp4');
  const eligible=await f.ok('GET',`/v1/spaces/${space.spaceId}/community/eligible`,{},owner.headers);
  assert.equal(eligible.panorama,null); assert.equal(eligible.photos.length,2);
  const body={expectedVersion:eligible.spaceVersion,consent:true,title:'相册',description:'',authorName:'照片主人',includeDepth:false,photoIds:[photo.committed.photoId,video.committed.photoId]};
  const submission=(await f.ok('POST',`/v1/spaces/${space.spaceId}/community/submissions`,body,owner.headers)).submission;
  const base=`/v1/admin/community/spaces/${submission.id}`,pub=`/v1/public/spaces/${submission.id}`;
  await f.ok('POST',base+'/review',{expectedVersion:1,decision:'approve',reason:'清晰授权'},admin.headers);
  const detail=await f.ok('GET',pub); assert.equal(detail.space.panorama,null); assert.equal(detail.space.photos.length,2); assert.equal(detail.submission.coverPhotoUrl,pub+'/media/photo-0');
  const bytes=await f.call('GET',pub+'/media/video-1',{}, {range:'bytes=0-9'}); assert.equal(bytes.status,206); assert.equal(bytes.body.length,10);
  await createAccountUpload(f,owner,space,png(40,20)); assert.equal((await f.ok('GET',pub)).space.photos.length,2);
  f.db.prepare('UPDATE spaces SET owner_account_id=? WHERE id=?').run(other.accountId,space.spaceId);
  assert.equal((await f.call('GET',pub)).status,404);
  assert.equal((await f.ok('GET',`/v1/spaces/${space.spaceId}/community/eligible`,{},other.headers)).submission,null);
  f.db.prepare('UPDATE spaces SET owner_account_id=? WHERE id=?').run(owner.accountId,space.spaceId);
  const get=f.api.mediaStore.get.bind(f.api.mediaStore);
  f.api.mediaStore.get=async(...args)=>{const object=await get(...args);f.db.prepare('UPDATE photos SET deleted_at=? WHERE id=?').run(f.clock.iso(),photo.committed.photoId);return object;};
  assert.equal((await f.call('GET',pub+'/media/photo-0')).status,404);
 } finally {f.close();}
});

test('community metadata participates in real identity key rotation and export with no live private fields',async()=>{
 const old=new LocalKeyring({persistent:true,keyId:'community-old'}),next=new LocalKeyring({persistent:true,keyId:'community-next'}),both=new LocalKeyring({current:next.current,previous:[old.current],persistent:true});
 const f=await communityFixture({keyring:old}); try {
  const sid=(await f.submit()).submission.id;await f.review(sid,1,'approve');
  f.api.core.keyring=both;
  const result=f.api.identityRekey.run({fromCollisionKeyEpoch:old.keyId,toCollisionKeyEpoch:next.keyId,leaseId:'community-rekey-lease'});
  assert.equal(result.switched,3);
  const row=f.db.prepare('SELECT * FROM personal_memories WHERE id=?').get(`submission:space:${sid}`);assert.equal(row.envelope_key_id,next.keyId);assert.equal(row.version,1);assert.ok(!row.document_ciphertext.includes('公开空间'));
  const exported=exportPersonalMemories(f.db,both,f.owner.accountId).find(x=>x.id===row.id); assert.equal(exported.document.title,'公开空间');assert.ok(!JSON.stringify(exported).includes('PRIVATE TITLE'));
  assert.equal((await f.call('GET',`/v1/public/spaces/${sid}`)).status,200);
 } finally {f.close();}
});
test('community review concurrency has one winner and caches only IDs; foreign media never qualifies',async()=>{
 const f=await communityFixture();try{
  const id=(await f.submit()).submission.id,route=`/v1/admin/community/spaces/${id}/review`;
  const results=await Promise.all(['approve','reject'].map(decision=>f.call('POST',route,{expectedVersion:1,decision,reason:'版本竞争'},f.admin.headers)));
  assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);
  const records=f.db.prepare("SELECT response_ref FROM idempotency_records WHERE canonical_endpoint LIKE '%/community/%'").all();
  for(const r of records) for(const privateText of ['公开空间','公开署名','明确公开说明','panorama','private_object_key']) assert.ok(!r.response_ref.includes(privateText));
  const audit=JSON.stringify(f.db.prepare("SELECT * FROM administration_audit WHERE target_type='community_space_submission'").all());
  assert.ok(!audit.includes('公开署名'));assert.ok(!audit.includes('PRIVATE TITLE'));
  const before=f.db.prepare('SELECT version,status FROM community_space_submissions WHERE id=?').get(id);
  assert.equal(before.version,2);
  const space=await f.openSpace(f.owner,await f.createSpace(f.owner,'another private album'));
  const photo=await createAccountUpload(f,f.owner,space);
  f.db.prepare('UPDATE contribution_batches SET actor_id=? WHERE id=?').run(f.other.accountId,photo.batch.batchId);
  const eligible=await f.ok('GET',`/v1/spaces/${space.spaceId}/community/eligible`,{},f.owner.headers);assert.equal(eligible.photos.length,0);
  assert.equal((await f.call('POST',`/v1/spaces/${space.spaceId}/community/submissions`,{expectedVersion:eligible.spaceVersion,consent:true,title:'不允许',description:'',authorName:'我',includeDepth:false,photoIds:[photo.committed.photoId]},f.owner.headers)).status,404);
 }finally{f.close();}
});
