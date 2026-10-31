import fs from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import * as data from '../public/moment-data.js';
import * as suggestions from '../public/moment-suggestions.js';
const documents=new Map(),media=new Map();
const cache={put:async(a,r)=>documents.set(a+':'+r.moment.id,structuredClone(r)),get:async(a,id)=>structuredClone(documents.get(a+':'+id)),list:async(a)=>[...documents].filter(([k])=>k.startsWith(a+':')).map(([,v])=>structuredClone(v)),putMedia:async(a,id,blob,meta={})=>media.set(a+':'+id,{blob,...meta}),getMedia:async(a,id)=>media.get(a+':'+id),removeMedia:async(a,id)=>media.delete(a+':'+id)};
let handler=async()=>({moments:[]});
class Api{constructor(){this.abort=new AbortController();}setAccount(id){this.accountId=id;}request(...args){return handler(...args);}}
let voiceOptions;
let exampleHandler=async()=>({examples:[]});
const fakeRecorder={getState:()=>({phase:'idle'}),cancel(){},finish:async()=>true,start:async()=>true};
const timeoutCalls=[];const testAbortSignal={any:AbortSignal.any,timeout:ms=>{timeoutCalls.push(ms);return AbortSignal.timeout(ms);}};
const node={replaceChildren(){},querySelector:()=>null,querySelectorAll:()=>[],style:{setProperty(){}},classList:{add(){},remove(){}},children:[],addEventListener(){}};
const context=vm.createContext({...data,...suggestions,createMomentSpaces:()=>({destroy(){},mount:async()=>{},resumeSave:async()=>{}}),spatialRoutes:()=>false,spatialHome:()=>'',fetchExamples:(...args)=>exampleHandler(...args),console,Blob,File,URL,AbortController,AbortSignal:testAbortSignal,DOMException,structuredClone,setTimeout,clearTimeout,navigator:{onLine:true},document:{querySelector:()=>node,hidden:false},window:{},history:{replaceState(){},pushState(){}},location:{hash:''},createMomentVoice:options=>{voiceOptions=options;return fakeRecorder;},createTurnVoicePlayer:()=>({stop(){},prepare(){},speak:async()=>true}),mountMomentParticles:()=>({}),openMomentCache:()=>cache,MomentApi:Api,blobToDataUrl:async()=> 'data:image/jpeg;base64,YQ=='});
let source=await fs.readFile(new URL('../public/moment-app.js',import.meta.url),'utf8');source=source.replace(/^import .*\n/gm,'').split("root.addEventListener('click'")[0];
vm.runInContext(source+`\nrender=()=>{};updateChat=()=>{};updateComposer=()=>{};updateSync=()=>{};toast=()=>{};globalThis.h={s,records,urls,api,saveCache,sync,change,loadLibrary,persistVoice,restoreRecord,hydrateMedia,ask,startVoice,maybeListen,preserveCapture,goHome,goProfile,finishMoment,leaveSession,submitClip,retryTranscription,establishSession,openExample};`,context);
const h=context.h;h.s.user={id:'account-a',preferences:{}};h.s.view='chat';h.api.setAccount('account-a');
const moment=data.newMoment();moment.photos=[{id:'photo-a',mediaId:'photo-media',url:'/v1/moment-media/photo-media'}];
const record={moment,version:0,base:null,revision:1,dirty:true,accountId:'account-a',uploads:[]};h.records.set(moment.id,record);h.s.record=record;
let release,puts=0;handler=async(path,opts={})=>{if(opts.method==='PUT'){puts++;if(puts===1)return new Promise(resolve=>{release=()=>resolve({version:1,moment:structuredClone(opts.body.moment)});});return {version:puts,moment:structuredClone(opts.body.moment)};}return {moments:[]};};
const syncing=h.sync(record);while(!release)await new Promise(resolve=>setImmediate(resolve));await h.loadLibrary();assert.equal(h.records.get(moment.id),record,'library must keep syncing record identity');
await h.change(record,m=>data.appendMessage(m,{id:'new-message',role:'user',text:'late edit',createdAt:new Date().toISOString()}));release();await syncing;
assert.equal(documents.get('account-a:'+moment.id).moment.messages[0].text,'late edit');assert.equal(puts,2);console.log('PASS deferred PUT + library reload + later edit preserves newest cache/server document');
const clip={blob:new Blob(['original voice'],{type:'audio/webm'}),duration:3,waveform:[.5],transcript:'声音',reason:'interrupted',sendRequested:false};await h.persistVoice(clip,{record,epoch:h.s.epoch,photoId:'photo-a'});
const restored=h.restoreRecord(await cache.get('account-a',moment.id),'account-a');await h.hydrateMedia(restored);assert.equal(await restored.pendingVoice.blob.text(),'original voice');assert.equal(restored.pendingVoice.messageId,clip.messageId);assert.equal(restored.pendingVoice.photoId,'photo-a');console.log('PASS interrupted original audio + identity + photo association survive document/blob restoration');
record.pendingVoice=null;record.moment.messages=[];record.pendingAI=null;h.s.pendingVoice=null;h.s.busy='';await cache.putMedia('account-a','photo-media',new Blob(['a'],{type:'image/jpeg'}));
let chatCalls=[];handler=async(path,opts={})=>{if(path==='/api/moment-chat'){chatCalls.push(structuredClone(opts.body));if(chatCalls.length===1)throw {code:'network_error'};return {message:{id:'assistant-retry',role:'assistant',text:'记得那一天吗',createdAt:new Date().toISOString()},context:{}};}if(opts.method==='PUT')return {version:3,moment:structuredClone(opts.body.moment)};return {moments:[]};};
await h.ask();assert.ok(record.pendingAI);await h.ask();assert.equal(chatCalls.length,2);assert.deepEqual(chatCalls[0],chatCalls[1]);assert.equal(record.moment.messages.filter(m=>m.id==='assistant-retry').length,1);console.log('PASS failed AI call retries the same frozen request ID/body and adds one response');
for(const url of h.urls.values())URL.revokeObjectURL(url);

// Run the actual app start handlers with a native permission result that arrives
// after another recording attempt has already begun in the same conversation.
const starts=[];let voicePhase='idle';
const setVoicePhase=phase=>{voicePhase=phase;voiceOptions.onState({phase,elapsedMs:0});};
fakeRecorder.getState=()=>({phase:voicePhase});
fakeRecorder.start=()=>{setVoicePhase('requesting');return new Promise(resolve=>starts.push(resolve));};
fakeRecorder.cancel=()=>{setVoicePhase('idle');};
h.s.view='chat';h.s.record=record;h.s.busy='';h.s.pendingVoice=null;record.pendingVoice=null;h.s.continuous=true;record.moment.status='active';
const abandoned=h.startVoice();await h.preserveCapture();
const replacement=h.startVoice();setVoicePhase('recording');starts[1](true);await replacement;
assert.equal(h.s.armed,true);
starts[0](false);await abandoned;
assert.equal(h.s.armed,true,'a cancelled old start must not disarm the replacement recording');
assert.equal(voicePhase,'recording');
console.log('PASS late permission result cannot disarm a newer voice attempt');

// A pending permission prompt does not make the app wait before navigation or
// ending the memory; actual stream disposal is exercised by moment-voice tests.
for(const action of ['goHome','goProfile','finishMoment','leaveSession']){
  h.s.user={id:'account-a',preferences:{}};h.s.record=record;h.s.view='chat';h.s.busy='';h.s.ending=null;record.moment.status='active';
  setVoicePhase('requesting');await h[action]();assert.equal(voicePhase,'idle',action);
  if(action==='goHome')assert.equal(h.s.view,'home');
  if(action==='goProfile')assert.equal(h.s.view,'profile');
  if(action==='finishMoment')assert.equal(record.moment.status,'complete');
  if(action==='leaveSession')assert.equal(h.s.view,'home');
}
console.log('PASS pending microphone permission does not block home, profile, end or logout');

// The adapter recommendations affect newly captured segments and transcription
// deadlines, while a previously captured long clip is submitted unchanged.
h.s.user={id:'account-a',preferences:{}};h.s.record=record;h.s.view='chat';h.s.busy='';h.s.ending=null;record.moment.status='complete';
h.s.config={transcription:{enabled:true,recommendedSegmentMs:45000,requestTimeoutMs:120000}};
assert.equal(voiceOptions.getMaxDurationMs(),45000);
h.s.config.transcription.recommendedSegmentMs=30000;assert.equal(voiceOptions.getMaxDurationMs(),30000);
h.s.config.transcription.recommendedSegmentMs=45000;
const transcriptionBodies=[];
handler=async(path,opts={})=>{
  if(path.startsWith('/v1/moment-media/'))return {media:{id:path.split('/').at(-1),url:path}};
  if(path==='/api/moment-transcribe'){transcriptionBodies.push(opts.body);return {text:'原声已识别'};}
  if(opts.method==='PUT')return {version:4,moment:structuredClone(opts.body.moment)};
  return {moments:[]};
};
const legacyClip={blob:new Blob(['unchanged older original'],{type:'audio/webm'}),duration:180,waveform:[.3],transcript:'',reason:'manual'};
timeoutCalls.length=0;
assert.equal(await h.submitClip(legacyClip,{record,epoch:h.s.epoch,photoId:'photo-a'}),true);
assert.ok(timeoutCalls.includes(120000),'initial transcription uses the adapter deadline');
assert.equal(transcriptionBodies[0].audio.durationMs,180000,'existing audio duration is retained');
assert.equal(await media.get('account-a:'+legacyClip.mediaId).blob.text(),'unchanged older original');
const voiceMessage=record.moment.messages.find(m=>m.id===legacyClip.messageId);voiceMessage.text='';
timeoutCalls.length=0;
await h.retryTranscription(voiceMessage.id);
assert.ok(timeoutCalls.includes(120000),'retry transcription uses the adapter deadline');
assert.equal(transcriptionBodies[1].audio.durationMs,180000);
assert.ok(!timeoutCalls.includes(65000),'neither transcription path uses the old hardcoded deadline');
console.log('PASS new segment config and both ASR deadlines are used without shortening existing audio');

// Execute actual capture/outbox handlers as an anonymous visitor. Originals and
// messages must persist without making any account/media write request.
h.s.epoch++;h.s.user={id:data.GUEST_ACCOUNT,preferences:{}};h.api.setAccount(data.GUEST_ACCOUNT);h.s.view='chat';h.s.busy='';h.s.pendingVoice=null;
const guestMoment=data.newMoment();guestMoment.status='complete';guestMoment.photos=[{id:'guest-photo',mediaId:'guest-preview',url:'/v1/moment-media/guest-preview'}];
const guestRecord={moment:guestMoment,accountId:data.GUEST_ACCOUNT,version:0,dirty:true,revision:1,uploads:[]};h.s.record=guestRecord;h.records.clear();h.records.set(guestMoment.id,guestRecord);
const guestCalls=[];handler=async(path,opts)=>{guestCalls.push(path);if(path.startsWith('/v1/'))throw Error('visitor attempted private API');return {text:'识别成功'};};
const guestClip={blob:new Blob(['visitor original bytes'],{type:'audio/webm'}),duration:4,waveform:[.2,.8],transcript:'这是访客的原声',reason:'manual'};
assert.equal(await h.submitClip(guestClip,{record:guestRecord,epoch:h.s.epoch,photoId:'guest-photo'}),true);
assert.equal(await h.sync(guestRecord),true);assert.deepEqual(guestCalls,[]);
const savedGuest=await cache.get(data.GUEST_ACCOUNT,guestMoment.id);assert.equal(savedGuest.moment.messages[0].text,'这是访客的原声');
assert.equal(await (await cache.getMedia(data.GUEST_ACCOUNT,guestClip.mediaId)).blob.text(),'visitor original bytes');
assert.equal(guestRecord.moment.messages[0].audio.mediaId,guestClip.mediaId);
console.log('PASS guest original voice + transcript remain durable with zero private API calls');

const guestBefore=structuredClone(guestRecord.moment);
let profileExpected;handler=async(path,opts)=>{if(path==='/v1/profile'){profileExpected=opts.accountId;return {user:{id:'other-tab-account'}};}throw Error('unexpected transfer');};
await assert.rejects(h.establishSession({intent:{action:'save'},expectedAccountId:'intended-account'}),error=>error.code==='account_changed');
assert.equal(profileExpected,'intended-account');assert.equal(h.s.user.id,data.GUEST_ACCOUNT);assert.equal(JSON.stringify(guestRecord.moment),JSON.stringify(guestBefore));
console.log('PASS another tab changing account during login cannot receive the visitor draft');

// A delayed public fetch must not navigate back over a user's newer action or
// claim the current private/guest draft as an example.
const draftIdentity=h.s.record,draftBefore=JSON.stringify(draftIdentity.moment);
let resolveExample;exampleHandler=()=>new Promise(resolve=>{resolveExample=resolve;});
const opening=h.openExample('summer');while(!resolveExample)await new Promise(r=>setImmediate(r));
handler=async()=>({moments:[]});await h.goHome();resolveExample({example:{id:'summer',photos:[],messages:[]}});await opening;
assert.equal(h.s.view,'home');assert.equal(h.s.record,draftIdentity);assert.equal(JSON.stringify(draftIdentity.moment),draftBefore);
assert.equal(h.records.has('summer'),false);
console.log('PASS delayed public example never takes over navigation or owns a visitor draft');

// Initial profile resolution must retain navigation performed on the public shell.
h.s.user=null;h.s.record=null;h.records.clear();h.s.view='home';context.location.hash='';
let profileReady;handler=async(path)=>path==='/v1/profile'?new Promise(r=>{profileReady=r;}):path==='/api/moment-config'?new Promise(()=>{}):{moments:[]};
const identifying=h.establishSession();while(!profileReady)await new Promise(r=>setImmediate(r));
h.s.view='spatial';h.s.spatialRoute='cases';h.s.nav++;
profileReady({user:{id:'identified-account',preferences:{}}});await identifying;
assert.equal(h.s.user.id,'identified-account');assert.equal(h.s.view,'spatial');assert.equal(h.s.spatialRoute,'cases');
console.log('PASS slow profile retains public navigation and stalled config does not block library');
// A profile from a superseded account epoch cannot overwrite the current owner.
let staleProfile;handler=async()=>new Promise(r=>{staleProfile=r;});const oldIdentifying=h.establishSession();while(!staleProfile)await new Promise(r=>setImmediate(r));
h.s.epoch++;h.s.user={id:'new-account'};staleProfile({user:{id:'old-account'}});await oldIdentifying;assert.equal(h.s.user.id,'new-account');
console.log('PASS late profile cannot replace a newer account');
