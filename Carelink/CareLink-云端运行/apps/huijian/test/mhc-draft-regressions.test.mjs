import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import * as data from '../public/moment-data.js';
import * as suggestions from '../public/moment-suggestions.js';
import * as design from '../public/moment-design.js';
import * as photoLibrary from '../public/moment-photo-library.js';

const source=(await fs.readFile(new URL('../public/moment-app.js',import.meta.url),'utf8')).replace(/^import .*\n/gm,'').split("root.addEventListener('click'")[0];

// Async structured-clone IDB contract. This verifies the actual application's
// transactions and handlers; physical disk/quota behaviour needs browser QA.
function memoryIndexedDB(){
  const stores=new Map();let initialized=false;
  const db={createObjectStore(name){stores.set(name,new Map());},transaction(){
    const tx={pending:0,aborted:false};
    tx.abort=()=>{tx.aborted=true;queueMicrotask(()=>tx.onabort?.());};
    tx.objectStore=name=>{
      const values=stores.get(name);
      const run=fn=>{const request={};tx.pending++;queueMicrotask(()=>{if(!tx.aborted){try{request.result=fn();request.onsuccess?.();}catch(error){tx.error=error;tx.abort();}}tx.pending--;if(tx.pending===0)queueMicrotask(()=>{if(!tx.aborted&&tx.pending===0)tx.oncomplete?.();});});return request;};
      return {get:key=>run(()=>structuredClone(values.get(key))),getAll:()=>run(()=>structuredClone([...values.values()])),
        put:value=>run(()=>{const copy=structuredClone(value);values.set(copy.key,copy);return copy.key;}),
        add:value=>run(()=>{if(values.has(value.key))throw Error('ConstraintError');const copy=structuredClone(value);values.set(copy.key,copy);return copy.key;}),
        delete:key=>run(()=>values.delete(key))};
    };return tx;
  }};
  return {open(){const request={};queueMicrotask(()=>{request.result=db;if(!initialized){initialized=true;request.onupgradeneeded?.();}request.onsuccess?.();});return request;}};
}

function harness(cache){
  const routes=[],notices=[],requests=[],createdUrls=[],revokedUrls=[],output={innerHTML:''},node={querySelector:selector=>selector==='#moment-export-output'?output:null,querySelectorAll:()=>[],replaceChildren(){},children:[],style:{setProperty(){}},classList:{add(){},remove(){}},addEventListener(){}};let handler,exportHandler;
  class BrowserURL extends URL{static createObjectURL(blob){const url=URL.createObjectURL(blob);createdUrls.push(url);return url;}static revokeObjectURL(url){revokedUrls.push(url);URL.revokeObjectURL(url);}}
  class Api{constructor(){this.abort=new AbortController();}setAccount(id){this.accountId=id;}async request(path,options={}){requests.push({path,...options});if(handler)return handler(path,options);throw Error('Unexpected API request');}}
  const context=vm.createContext({...data,...suggestions,...design,...photoLibrary,console,Blob,File,URL:BrowserURL,AbortController,AbortSignal,DOMException,structuredClone,setTimeout,clearTimeout,navigator:{onLine:true},document:{querySelector:()=>node,hidden:false},window:{},history:{pushState(){},replaceState(){}},location:{hash:'',pathname:'/app'},localStorage:{getItem:()=>null},MomentApi:Api,openMomentCache:()=>cache,createMomentVoice:()=>({getState:()=>({phase:'idle'}),cancel(){},finish:async()=>true}),createTurnVoicePlayer:()=>({stop(){},prepare(){},speak:async()=>true}),mountMomentParticles:()=>({}),spatialRoutes:()=>false,fetchExamples:async()=>({examples:[]}),createMomentExport:options=>exportHandler(options),describeExportError:()=> '导出失败',recordRoute:route=>routes.push(route),recordNotice:message=>notices.push(message)});
  vm.runInContext(source+`\nrender=()=>{};updateChat=()=>{};updateComposer=()=>{};updateSync=()=>{};toast=recordNotice;navigateApp=async route=>recordRoute(route);globalThis.h={s,records,saveCache,change,onAction,loginForm,registrationForm,passwordForSubmission,restoreRecord,archiveMemory,removePhotoCopy,designData,libraryScreen,exportMedia,exportMoment,closeDialog};`,context);
  return {h:context.h,routes,notices,requests,createdUrls,revokedUrls,output,setHandler:fn=>{handler=fn;},setExportHandler:fn=>{exportHandler=fn;}};
}

test('stale guest tab preserves both versions and queued edits keep following one recovery copy',async()=>{
  const cache=data.openMomentCache(memoryIndexedDB()),a=harness(cache),b=harness(cache);
  const initial={moment:{...data.newMoment(),id:'shared-guest',title:'原回忆'},accountId:data.GUEST_ACCOUNT,version:0,revision:1,dirty:true,uploads:[]};
  await cache.put(data.GUEST_ACCOUNT,initial);
  for(const tab of [a,b]){const record=tab.h.restoreRecord(await cache.get(data.GUEST_ACCOUNT,initial.moment.id),data.GUEST_ACCOUNT);tab.record=record;tab.h.s.user={id:data.GUEST_ACCOUNT};tab.h.s.view='chat';tab.h.s.record=record;tab.h.records.set(record.moment.id,record);}
  const msg=id=>({id,role:'user',text:id,createdAt:'2026-09-06T00:00:00.000Z'});
  await a.h.change(a.record,m=>data.appendMessage(m,msg('来自第一页')));
  await new Promise(resolve=>setImmediate(resolve));
  b.record.textDraft='尚未发送的文字';
  b.record.pendingVoice={mediaId:'voice-draft',messageId:'voice-message',duration:3,photoId:'photo-one'};
  await cache.putMedia(data.GUEST_ACCOUNT,'voice-draft',new Blob(['unaltered original audio'],{type:'audio/webm'}));
  const first=b.h.change(b.record,m=>data.appendMessage(m,msg('来自第二页')));
  const queued=b.h.change(b.record,m=>data.appendMessage(m,msg('排队中的新原话')));
  await Promise.all([first,queued]);await new Promise(resolve=>setImmediate(resolve));
  const entries=await cache.list(data.GUEST_ACCOUNT);
  assert.equal(entries.length,2,'one original and exactly one recovery copy');
  const original=entries.find(x=>x.moment.id==='shared-guest'),recovered=entries.find(x=>x.moment.id===b.record.moment.id);
  assert.deepEqual(original.moment.messages.map(m=>m.id),['来自第一页']);
  assert.deepEqual(recovered.moment.messages.map(m=>m.id),['来自第二页','排队中的新原话']);
  assert.equal(recovered.textDraft,'尚未发送的文字');
  assert.equal(recovered.pendingVoice.mediaId,'voice-draft');
  assert.equal(await (await cache.getMedia(data.GUEST_ACCOUNT,'voice-draft')).blob.text(),'unaltered original audio');
  assert.equal(b.h.records.size,2);
  assert.equal(b.notices.filter(x=>x.includes('另存为副本')).length,1);
  await b.h.change(b.record,m=>data.appendMessage(m,msg('继续修改副本')));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await cache.list(data.GUEST_ACCOUNT)).length,2);
  assert.equal((await cache.get(data.GUEST_ACCOUNT,b.record.moment.id)).moment.messages.at(-1).id,'继续修改副本');
});

test('claimed drafts cannot be revived as a recovery copy',async()=>{
  const cache=data.openMomentCache(memoryIndexedDB());
  const record={moment:{...data.newMoment(),id:'claim-guard'},claimedBy:'account-owner'};
  await cache.put(data.GUEST_ACCOUNT,record);
  await assert.rejects(cache.put(data.GUEST_ACCOUNT,{moment:record.moment},{expectedCacheVersion:0}),error=>error.code==='draft_claimed');
  assert.equal((await cache.list(data.GUEST_ACCOUNT)).length,0);
});

test('a stale but unchanged save does not create a redundant copy',async()=>{
  const cache=data.openMomentCache(memoryIndexedDB()),record={moment:{...data.newMoment(),id:'unchanged'}};
  const first=await cache.put(data.GUEST_ACCOUNT,record,{expectedCacheVersion:0});
  assert.equal(first.cacheVersion,1);
  const replay=await cache.put(data.GUEST_ACCOUNT,record,{expectedCacheVersion:0});
  assert.equal(replay.cacheVersion,1);assert.equal(replay.recoveredRecord,undefined);
  assert.equal((await cache.list(data.GUEST_ACCOUNT)).length,1);
});

test('spatial footer routes once while content routes stay with their own delegated handler',async()=>{
  const tab=harness({});tab.h.s.user={id:data.GUEST_ACCOUNT};tab.h.s.view='spatial';
  const footer={dataset:{spatialRoute:'spaces'},disabled:false,closest:()=>null};
  await tab.h.onAction({target:{closest:()=>footer}});
  assert.deepEqual(tab.routes,['spaces']);
  const inner={dataset:{spatialRoute:'cases'},disabled:false,closest:()=>({id:'spatial-content'})};
  await tab.h.onAction({target:{closest:()=>inner}});
  assert.deepEqual(tab.routes,['spaces'],'inner event was already consumed by spatial surface');
});

test('password creation uses backend UTF-8 limits and login can accept existing long passwords',()=>{
  const tab=harness({});tab.h.s.user={id:data.GUEST_ACCOUNT};
  assert.match(tab.h.loginForm(),/name="password"[^>]*maxlength="256"/);
  assert.match(tab.h.registrationForm(),/name="password"[^>]*maxlength="256"/);
  assert.equal(tab.h.passwordForSubmission('a'.repeat(256)).length,256);
  assert.equal(tab.h.passwordForSubmission('中'.repeat(85)).length,85);
  assert.equal(tab.h.passwordForSubmission('中文密码'),'中文密码');
  assert.throws(()=>tab.h.passwordForSubmission('中'.repeat(86)),error=>error.code==='password_too_long');
  assert.throws(()=>tab.h.passwordForSubmission('a'.repeat(9)),error=>error.code==='password_invalid');
});

test('archive state participates in cloud conflict merging without losing an independent new message',()=>{
  const base=data.newMoment(),local=structuredClone(base),remote=structuredClone(base);
  local.archivedAt='2026-09-06T00:00:00.000Z';remote.messages.push({id:'remote-message',role:'user',text:'保留的原话'});
  const merged=data.mergeMoment(base,local,remote);
  assert.equal(merged.archivedAt,local.archivedAt);assert.equal(merged.messages[0].id,'remote-message');
});

async function savedRecord(tab,cache,accountId=data.GUEST_ACCOUNT){
  const moment={...data.newMoment(),id:'kept-memory',title:'保留全部原件',photos:[{id:'photo-one',mediaId:'preview-one',originalMediaId:'original-one',url:'/v1/moment-media/preview-one'},{id:'photo-two',mediaId:'preview-two',url:'/v1/moment-media/preview-two'}],messages:[{id:'words-one',role:'user',text:'不应丢失的原话',photoId:'photo-one',audio:{mediaId:'voice-one',url:'/v1/moment-media/voice-one',duration:2}},{id:'words-two',role:'user',text:'另一句原话',photoId:'photo-two'}]};
  await cache.put(accountId,{moment,version:accountId===data.GUEST_ACCOUNT?0:1,base:structuredClone(moment),dirty:false,revision:1});
  const record=tab.h.restoreRecord(await cache.get(accountId,moment.id),accountId);
  tab.h.s.user={id:accountId};tab.h.s.view='chat';tab.h.s.record=record;tab.h.records.set(moment.id,record);
  for(const id of ['original-one','preview-one','preview-two'])await cache.putMedia(accountId,id,new Blob([id],{type:'image/jpeg'}));
  await cache.putMedia(accountId,'voice-one',new Blob(['original voice bytes'],{type:'audio/webm'}));
  return record;
}

for(const accountId of [data.GUEST_ACCOUNT,'signed-account'])test(`archive and restore preserve all content for ${accountId}`,async()=>{
  const cache=data.openMomentCache(memoryIndexedDB()),tab=harness(cache),record=await savedRecord(tab,cache,accountId),before=structuredClone(record.moment);
  let cloud=structuredClone(before),version=1;
  tab.setHandler(async(path,options)=>{if(options.method==='PUT'){assert.equal(options.accountId,accountId);assert.equal(options.body.expectedVersion,version);cloud=structuredClone(options.body.moment);return {moment:cloud,version:++version};}if(path==='/v1/moments')return {moments:[cloud]};throw Error('Unexpected API');});
  await tab.h.archiveMemory();
  const archived=(await cache.get(accountId,before.id)).moment;
  assert.ok(archived.archivedAt);assert.deepEqual(archived.photos,before.photos);assert.deepEqual(archived.messages,before.messages);
  assert.equal(tab.h.designData().items.length,0);assert.match(tab.h.libraryScreen(),/保留全部原件/);
  tab.h.s.view='chat';tab.h.s.record=record;await tab.h.archiveMemory(true);
  const restored=(await cache.get(accountId,before.id)).moment;
  assert.equal(restored.archivedAt,null);assert.deepEqual(restored.photos,before.photos);assert.deepEqual(restored.messages,before.messages);
  assert.equal((await cache.list(accountId)).length,1);assert.equal(tab.h.designData().items.length,1);
  assert.equal(await (await cache.getMedia(accountId,'voice-one')).blob.text(),'original voice bytes');
  assert(!tab.requests.some(request=>request.method==='DELETE'||request.path.includes('submission')));
});

test('photo removal creates a separate editable copy while retaining original photos, original speech and text',async()=>{
  const cache=data.openMomentCache(memoryIndexedDB()),tab=harness(cache),record=await savedRecord(tab,cache),before=structuredClone(record.moment);
  await tab.h.removePhotoCopy('photo-one');await new Promise(resolve=>setImmediate(resolve));
  const original=(await cache.get(data.GUEST_ACCOUNT,before.id)).moment,copy=(await cache.get(data.GUEST_ACCOUNT,tab.h.s.record.moment.id)).moment;
  assert.deepEqual(original,before);assert.notEqual(copy.id,original.id);assert.deepEqual(copy.photos.map(p=>p.id),['photo-two']);
  assert.deepEqual(copy.messages.map(m=>m.text),before.messages.map(m=>m.text));assert.deepEqual(copy.messages[0].audio,before.messages[0].audio);
  assert.equal(copy.messages[0].photoId,undefined);assert.equal(copy.messages[1].photoId,'photo-two');
  assert.equal(await (await cache.getMedia(data.GUEST_ACCOUNT,'original-one')).blob.text(),'original-one');
  assert.equal(await (await cache.getMedia(data.GUEST_ACCOUNT,'voice-one')).blob.text(),'original voice bytes');
});

test('export reads local originals and refuses a delayed old-account read after account switching',async()=>{
  const cache=data.openMomentCache(memoryIndexedDB()),tab=harness(cache),record=await savedRecord(tab,cache);
  assert.equal(await (await tab.h.exportMedia(record,record.moment.photos[0],{kind:'photo'})).text(),'original-one');
  assert.equal(await (await tab.h.exportMedia(record,record.moment.messages[0].audio,{kind:'audio'})).text(),'original voice bytes');
  const saved=cache.getMedia;let release;
  cache.getMedia=()=>new Promise(resolve=>{release=resolve;});
  const pending=tab.h.exportMedia(record,record.moment.photos[0],{kind:'photo'});
  tab.h.s.epoch++;tab.h.s.user={id:'another-account'};release({blob:new Blob(['private old original'],{type:'image/jpeg'})});
  await assert.rejects(pending,error=>error.name==='AbortError');cache.getMedia=saved;
});

test('closing an export aborts late output; closing completed downloads revokes every URL',async()=>{
  const cache=data.openMomentCache(memoryIndexedDB()),tab=harness(cache);await savedRecord(tab,cache);
  let release,options;tab.setExportHandler(value=>{options=value;return new Promise(resolve=>{release=resolve;});});
  const pending=tab.h.exportMoment('png');while(!release)await new Promise(resolve=>setImmediate(resolve));
  tab.h.closeDialog();assert.equal(options.signal.aborted,true);assert.equal(options.isCurrent(),false);
  release({files:[{name:'cancelled.png',blob:new Blob(['cancelled'],{type:'image/png'})}]});await pending;
  assert.equal(tab.createdUrls.length,0,'late completion creates no private download URL');
  tab.setExportHandler(async()=>({files:[{name:'complete.png',blob:new Blob(['complete'],{type:'image/png'})}]}));
  await tab.h.exportMoment('png');assert.equal(tab.createdUrls.length,1);assert.match(tab.output.innerHTML,/complete.png/);
  tab.h.closeDialog();assert.deepEqual(tab.revokedUrls,tab.createdUrls);
});
