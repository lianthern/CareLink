import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,png,createAccountUpload} from './fixture-factory.mjs';
import {sha256} from '../src/util.mjs';
import {LocalKeyring} from '../src/crypto.mjs';
import {exportPersonalMemories} from '../src/personal-memory-service.mjs';
const audio=Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(4),Buffer.from('WAVEfmt '),Buffer.alloc(60)]);
async function setup(f){
 const a=await f.login('story-author@example.test'),other=await f.login('story-other@example.test');let space=await f.openSpace(a,await f.createSpace(a,'Selected stories'));
 const bytes=png(32,16),up=await createAccountUpload(f,a,space,bytes);const photo=f.db.prepare('SELECT * FROM photos WHERE batch_item_id=?').get(up.item.itemId);
 f.db.prepare("UPDATE photos SET photo_content_state='visible' WHERE id=?").run(photo.id);
 for(const [mid,kind,b,mimeType]of [['source-photo','photo',bytes,'image/png'],['source-audio','audio',audio,'audio/wav']])await f.ok('PUT',`/v1/moment-media/${mid}`,{kind,name:mid,mimeType,dataBase64:b.toString('base64')},a.headers);
 const moment={id:'source-moment',title:'Private',status:'active',createdAt:f.clock.iso(),updatedAt:f.clock.iso(),photos:[{id:'p1',mediaId:'source-photo'}],messages:[
  {id:'one',role:'user',photoId:'p1',text:'只分享这句话 👨‍👩‍👧‍👦',createdAt:f.clock.iso(),audio:{mediaId:'source-audio',duration:1,waveform:[]}},
  {id:'private',role:'user',photoId:'p1',text:'私人的第二句话',createdAt:f.clock.iso()},
  {id:'ai',role:'assistant',photoId:'p1',text:'AI不应发表',createdAt:f.clock.iso()}]};
 await f.ok('PUT','/v1/moments/source-moment',{moment,expectedVersion:0},a.headers);
 const body={source:{momentId:moment.id,photoId:'p1',version:1},consent:true,authorCredit:'我选择的署名',selections:[{messageId:'one',includeText:true,includeAudio:true}]};
 const create=(b=body,headers=a.headers)=>f.call('POST',`/v1/spaces/${space.spaceId}/photos/${photo.id}/stories`,b,headers);
 const view=(headers=a.headers)=>f.call('GET',`/v1/viewer/spaces/${space.spaceId}/stories`,{},headers);
 return {a,other,space,photo,moment,body,create,view};
}
test('selected original words/audio are frozen, encrypted, scoped, idempotent and never cached in mutation response',async()=>{const f=fixture();try{const s=await setup(f);
 const source=await f.ok('GET','/v1/me/photo-story-sources?momentId=source-moment&photoId=p1',{},s.a.headers);assert.deepEqual(source.candidates.map(x=>x.messageId),['one','private']);assert.equal(source.targets.length,1);
 const created=await s.create();assert.equal(created.status,200,JSON.stringify(created.body));const story=created.body;
 const duplicate=await s.create();assert.equal(duplicate.body.storyId,story.storyId);
 let viewer=(await s.view()).body;assert.equal(viewer.stories.length,1);assert.equal(viewer.stories[0].pieces.length,1);assert.equal(viewer.stories[0].pieces[0].text,s.moment.messages[0].text);
 assert.doesNotMatch(JSON.stringify(viewer),/私人的第二句话|AI不应发表|source-moment|source-audio|accountId|dataBase64/);
 const url=viewer.stories[0].pieces[0].audio.url;const sound=await f.call('GET',url,{},s.a.headers);assert.equal(sound.status,200);assert.equal(sha256(sound.body),sha256(audio));
 const range=await f.call('GET',url,{}, {...s.a.headers,range:'bytes=0-3'});assert.equal(range.status,206);assert.equal(range.body.toString(),'RIFF');
 s.moment.messages[0].text='后来修改的私人文字';await f.ok('PUT','/v1/moments/source-moment',{moment:s.moment,expectedVersion:1},s.a.headers);
 viewer=(await s.view()).body;assert.equal(viewer.stories[0].pieces[0].text,'只分享这句话 👨‍👩‍👧‍👦');
 const rows=f.db.prepare('SELECT document_ciphertext FROM personal_memories').all();assert.doesNotMatch(JSON.stringify(rows),/只分享这句话|私人的第二句话|dataBase64/);
 assert.doesNotMatch(JSON.stringify(f.db.prepare('SELECT response_ref FROM idempotency_records').all()),/只分享这句话|私人的第二句话|dataBase64/);
 assert.ok((await s.view(s.other.headers)).status>=400);assert.ok((await f.call('GET',url,{},s.other.headers)).status>=400);
}finally{f.close();}});
test('refuses assistant, unbound photo, forged target, missing consent, stale source and cross-account selection',async()=>{const f=fixture();try{const s=await setup(f);
 for(const body of [{...s.body,consent:false},{...s.body,selections:[]},{...s.body,selections:[{messageId:'ai',includeText:true,includeAudio:false}]},{...s.body,source:{...s.body.source,version:0}}])assert.ok((await s.create(body)).status>=400);
 assert.ok((await s.create(s.body,s.other.headers)).status>=400);
 s.moment.photos.push({id:'p2',mediaId:'source-photo'});s.moment.messages[0].photoId='p2';s.moment.messages[1].photoId=undefined;
 await f.ok('PUT','/v1/moments/source-moment',{moment:s.moment,expectedVersion:1},s.a.headers);
 assert.equal((await f.ok('GET','/v1/me/photo-story-sources?momentId=source-moment&photoId=p1',{},s.a.headers)).candidates.length,0);
 assert.ok((await s.create({...s.body,source:{...s.body.source,version:2}})).status>=400);
 f.db.prepare('UPDATE contribution_batches SET actor_id=? WHERE id=?').run(s.other.accountId,s.photo.batch_id);
 const sources=await f.ok('GET','/v1/me/photo-story-sources?momentId=source-moment&photoId=p2',{},s.a.headers);assert.equal(sources.targets.length,0);
 assert.ok((await s.create({...s.body,source:{...s.body.source,photoId:'p2',version:2}})).status>=400);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM photo_stories').get().n,0);
}finally{f.close();}});
test('text and audio are independent opt-ins; hiding, photo state, withdrawal and account purge revoke payload',async()=>{const f=fixture();try{const s=await setup(f);
 const text=(await s.create({...s.body,selections:[{messageId:'one',includeText:true,includeAudio:false}]})).body;
 const sound=(await s.create({...s.body,selections:[{messageId:'one',includeText:false,includeAudio:true}]})).body;
 const stories=(await s.view()).body.stories;assert.equal(stories.find(x=>x.storyId===text.storyId).pieces[0].audio,undefined);assert.equal(stories.find(x=>x.storyId===sound.storyId).pieces[0].text,undefined);
 const url=stories.find(x=>x.storyId===sound.storyId).pieces[0].audio.url;
 const hidden=await f.ok('POST',`/v1/photo-stories/${sound.storyId}/visibility`,{to:'hidden'},{...s.a.headers,'if-match':String(sound.version)});assert.equal((await f.call('GET',url,{},s.a.headers)).status,404);
 await f.ok('POST',`/v1/photo-stories/${sound.storyId}/visibility`,{to:'visible'},{...s.a.headers,'if-match':String(hidden.version)});
 f.db.prepare("UPDATE photos SET photo_content_state='hidden' WHERE id=?").run(s.photo.id);assert.equal((await s.view()).body.stories.length,0);assert.equal((await f.call('GET',url,{},s.a.headers)).status,404);
 f.db.prepare("UPDATE photos SET photo_content_state='visible' WHERE id=?").run(s.photo.id);
 // Withdrawal is the speaker's right even after losing all space membership.
 f.db.prepare('UPDATE spaces SET owner_account_id=? WHERE id=?').run(s.other.accountId,s.space.spaceId);
 const own=await f.ok('GET',`/v1/me/photo-stories?spaceId=${s.space.spaceId}`,{},s.a.headers),current=own.stories.find(x=>x.storyId===sound.storyId);
 assert.ok((await f.call('POST',`/v1/photo-stories/${sound.storyId}/withdrawals`,{}, {...s.other.headers,'if-match':String(current.version)})).status>=400);
 await f.ok('POST',`/v1/photo-stories/${sound.storyId}/withdrawals`,{}, {...s.a.headers,'if-match':String(current.version)});
 assert.equal((await f.call('GET',url,{},s.other.headers)).status,404);assert.ok((await f.call('POST',`/v1/photo-stories/${sound.storyId}/visibility`,{to:'visible'},{...s.other.headers,'if-match':String(current.version+1)})).status>=400);
 const row=f.db.prepare('SELECT * FROM photo_stories WHERE id=?').get(sound.storyId);assert.deepEqual(f.api.photoStories.snapshot(row),{});
 f.db.prepare('DELETE FROM personal_memories WHERE account_id=?').run(s.a.accountId);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM photo_stories').get().n,0);
}finally{f.close();}});
test('invited viewer may hear selected audio; upload-only, paused collection and revoked invitation cannot gain access',async()=>{const f=fixture();try{const s=await setup(f);const created=await s.create();assert.equal(created.status,200);
 async function invite(mode,nonce){const c=await f.ok('POST',`/v1/spaces/${s.space.spaceId}/external-invitation-campaigns`,{taskMode:mode,entryTask:mode==='upload'?'upload':'view',expiresAt:new Date(f.clock.now()+86400000).toISOString(),maxSuccessfulUses:10},{...s.a.headers,'if-match':String(s.space.version)});const token=new URL(c.publicCampaignUrl).pathname.split('/').at(-1),origin={origin:'http://127.0.0.1:8787',host:'127.0.0.1:8787','sec-fetch-site':'same-origin'},body={publicCampaignId:token,clientNonce:nonce};const challenge=await f.ok('POST','/v1/external-campaign-admission-challenges',body,origin);const admitted=await f.ok('POST','/v1/external-campaign-admissions',body,{...origin,'x-campaign-challenge':challenge.challengeCookieSecret});const x=await f.ok('POST','/v1/external-invitation-exchanges',{secretFromClearedInviteBootstrap:admitted.oneTimeSecret},origin);return {c,headers:{...s.other.headers,'x-viewer-session':x.viewerSessionSecret,'x-contributor-session':x.contributorSessionSecret}};}
 const guest=await invite('combo','combo-story-nonce');const viewPath=`/v1/viewer/spaces/${s.space.spaceId}/stories?access=invitation`;const v=await f.ok('GET',viewPath,{},guest.headers);const audioUrl=v.stories[0].pieces[0].audio.url+'?access=invitation';assert.equal((await f.call('GET',audioUrl,{},guest.headers)).status,200);
 const uploadOnly=await invite('upload','upload-story-nonce');assert.ok((await f.call('GET',viewPath,{},uploadOnly.headers)).status>=400);
 await f.ok('POST',`/v1/external-invitation-campaigns/${guest.c.campaignId}/revocations`,{reasonClass:'owner_revoked'},{...s.a.headers,'if-match':String(f.db.prepare('SELECT version FROM external_invitation_campaigns WHERE id=?').get(guest.c.campaignId).version)});assert.ok((await f.call('GET',audioUrl,{},guest.headers)).status>=400);
 await f.transition(s.a,s.space.spaceId,'collection','paused',s.space.version);assert.ok((await s.create()).status>=400);
}finally{f.close();}});

test('selected snapshots survive existing identity rekey and account export; malformed and long sources fail safely',async()=>{
 const old=new LocalKeyring({keyId:'story-old-key'}),next=new LocalKeyring({keyId:'story-next-key'}),both=new LocalKeyring({current:next.current,previous:[old.current]});const f=fixture({keyring:old});
 try{const s=await setup(f);assert.equal((await s.create({...s.body,source:null})).status,400);const created=await s.create();assert.equal(created.status,200);
 const before=(await s.view()).body;f.api.core.keyring=both;f.api.identityRekey.run({fromCollisionKeyEpoch:old.keyId,toCollisionKeyEpoch:next.keyId,leaseId:'story-key-rotation'});assert.deepEqual((await s.view()).body,before);
 const row=f.db.prepare("SELECT * FROM personal_memories WHERE id LIKE 'photo-story:%'").get();assert.equal(row.envelope_key_id,next.keyId);
 const exported=exportPersonalMemories(f.db,both,s.a.accountId).find(x=>x.id===row.id);assert.equal(exported.document.pieces[0].text,'只分享这句话 👨‍👩‍👧‍👦');assert.equal(exported.document.pieces.length,1);
 s.moment.messages[0].text='长'.repeat(64001);await f.ok('PUT','/v1/moments/source-moment',{moment:s.moment,expectedVersion:1},s.a.headers);assert.equal((await s.create({...s.body,source:{...s.body.source,version:2}})).status,413);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM photo_stories').get().n,1);
 }finally{f.close();}
});
