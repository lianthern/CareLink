import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {UnseenAccountApi} from '../public/unseen-account-api.js';
import {cloudScreen} from '../public/unseen-app-library.js';
const source=readFileSync(new URL('../public/unseen-app.js',import.meta.url),'utf8');
const start=source.indexOf('document.addEventListener("click",async event=>{\n const b=event.target.closest("[data-app-library]');
const handler=source.slice(start,source.indexOf("document.addEventListener('submit'",start));
function fixture(api){const ctx=vm.createContext({state:{cloudMemories:[],screen:'cloud'},cloudEpoch:0,AbortController,accountApi:api,memoryStorePromise:Promise.resolve({}),render(){},showToast(){},document:{addEventListener(_t,fn){ctx.click=fn;},querySelector(){return null;}},clearCloudAccess(){ctx.invalidateCloudRequests();ctx.state.cloudMemories=[];}});vm.runInContext(source.slice(source.indexOf('let cloudSyncOperation='),source.indexOf('async function prepareSyncIdentity()')),ctx);vm.runInContext(handler,ctx);return ctx;}
test('a late authenticated list cannot repopulate cloud state after logout/navigation',async()=>{
 let resolve,entered;const started=new Promise(r=>entered=r);const cx=fixture({memories:()=>{entered();return new Promise(r=>resolve=r);}});
 const request=cx.click({target:{closest:()=>({dataset:{appLibrary:'cloud-refresh'}})}});await started;cx.clearCloudAccess();resolve({memories:[{id:'private-old-session'}]});await request;
 assert.equal(cx.state.cloudMemories.length,0);
});
test('401 removes an existing account list instead of leaving stale private entries',async()=>{
 const cx=fixture({memories:async()=>{throw {status:401};}});cx.state.cloudMemories=[{id:'old'}];await cx.click({target:{closest:()=>({dataset:{appLibrary:'cloud-refresh'}})}});
 assert.equal(cx.state.cloudMemories.length,0);assert.match(cx.state.cloudStatus,/登录/);
});
test('account trash/restore mutations use displayed canonical version and refresh real state',async()=>{
 const calls=[];let trashed=false;const cx=fixture({trashMemory:async(id,version)=>{calls.push([id,version]);trashed=true;},restoreMemory:async(id,version)=>{calls.push([id,version]);trashed=false;},memories:async()=>({memories:[{id:'a',version:trashed?8:9,deletedAt:trashed?123:null}]})});cx.state.cloudMemories=[{id:'a',version:7}];
 await cx.click({target:{closest:()=>({dataset:{appCloudTrash:'a'}})}});assert.equal(cx.state.cloudMemories[0].deletedAt,123);
 await cx.click({target:{closest:()=>({dataset:{appCloudRestore:'a'}})}});assert.equal(cx.state.cloudMemories[0].deletedAt,null);assert.deepEqual(calls,[['a',7],['a',8]]);
 assert.match(cloudScreen({cloudMemories:[{id:'a',version:8,deletedAt:123}]}),/恢复账号作品/);
});

test('a pending local draft write never absorbs a newly opened private account record',async()=>{
 let resume,stored;const opened=new Promise(resolve=>{resume=resolve;});
 const cx=vm.createContext({structuredClone,Date,state:{photos:[{id:'local'}],pairs:[{answer:'local words'}],photo:{id:'local'},memoryId:'local'},activePhoto(){return cx.state.photo;},isUserOwnedPhoto(){return true;},openNavigationDb:()=>opened});
 const from=source.indexOf('async function saveNavigationState()');vm.runInContext(source.slice(from,source.indexOf('async function takeNavigationState()',from)),cx);
 const write=cx.saveNavigationState();cx.state.photo={id:'private'};cx.state.photos=[{id:'private'}];cx.state.pairs=[{answer:'private words'}];cx.state.cloudRecord={};cx.state.memoryId=null;
 resume({transaction(){const tx={objectStore:()=>({put(record){stored=record;queueMicrotask(()=>tx.oncomplete());}})};return tx;},close(){}});
 await write;assert.equal(stored.photo.id,'local');assert.equal(stored.draft.pairs[0].answer,'local words');assert.equal(stored.draft.photos[0].id,'local');
});

function syncFixture({base=2}={}) {
 const statuses={textContent:''}, button={dataset:{appLibrary:'sync-current'}};
 const memory={id:'local',title:'old local',syncBases:{A:base}};
 const calls=[];
 const cx=fixture({me:async()=>({accountId:'A'}),syncMemory:async(id,doc,opts)=>{calls.push({id,doc,opts});return {memory:{version:base+1}};},memory:async()=>{throw Error('must not fetch a new base');}});
 cx.state.syncIdentity={accountId:'A'};cx.state.memoryId='local';cx.state.screen='sync';
 cx.memoryStorePromise=Promise.resolve({getMemory:async()=>memory,markMemorySynced:async()=>({...memory,syncBases:{A:base+1}})});
 cx.document.querySelector=selector=>selector==='#app-sync-consent'?{checked:true}:statuses;
 return {cx,statuses,button,memory,calls,run:()=>cx.click({target:{closest:()=>button}})};
}
test('sync sends the locally recorded base, never latest remote version, and excludes local metadata',async()=>{
 const f=syncFixture();await f.run();assert.equal(f.calls.length,1);assert.equal(f.calls[0].opts.version,2);assert.equal(f.calls[0].opts.expectedAccountId,'A');assert.equal(f.calls[0].doc.syncBases,undefined);assert.equal(f.cx.state.originalMemory.syncBases.A,3);
});
test('remote conflict preserves the local base and words and does not claim success',async()=>{
 const f=syncFixture();f.cx.accountApi.syncMemory=async(_id,_doc,opts)=>{assert.equal(opts.version,2);throw {status:409};};await f.run();assert.equal(f.memory.title,'old local');assert.equal(f.memory.syncBases.A,2);assert.match(f.statuses.textContent,/未覆盖远端/);assert.doesNotMatch(f.statuses.textContent,/已同步/);
});
test('a local record without a recorded remote basis can only create, not overwrite an existing copy',async()=>{
 const f=syncFixture();delete f.memory.syncBases;await f.run();assert.equal(f.calls[0].opts.version,0);
});
test('logout during local read stops identity and mutation requests',async()=>{
 const f=syncFixture();let resume,entered;const started=new Promise(r=>entered=r);f.cx.memoryStorePromise=Promise.resolve({getMemory:()=>{entered();return new Promise(r=>resume=r);}});
 let identities=0;f.cx.accountApi.me=async()=>{identities++;return{accountId:'B'};};const pending=f.run();await started;f.cx.clearCloudAccess();resume(f.memory);await pending;assert.equal(identities,0);assert.equal(f.calls.length,0);assert.doesNotMatch(f.statuses.textContent,/已同步/);
});
test('logout during identity lookup aborts the signal and prevents a stale A operation from writing under B',async()=>{
 const f=syncFixture();let resume,entered,signal;const started=new Promise(r=>entered=r);f.cx.accountApi.me=opts=>{signal=opts.signal;entered();return new Promise(r=>resume=r);};
 const pending=f.run();await started;f.cx.clearCloudAccess();resume({accountId:'A'});await pending;assert.equal(signal.aborted,true);assert.equal(f.calls.length,0);assert.doesNotMatch(f.statuses.textContent,/已同步/);
});
test('late sync receipt after logout neither persists a basis nor displays success',async()=>{
 const f=syncFixture();let resume,entered,writes=0;const started=new Promise(r=>entered=r);f.cx.accountApi.syncMemory=()=>{entered();return new Promise(r=>resume=r);};f.cx.memoryStorePromise=Promise.resolve({getMemory:async()=>f.memory,markMemorySynced:async()=>{writes++;}});
 const pending=f.run();await started;f.cx.clearCloudAccess();resume({memory:{version:3}});await pending;assert.equal(writes,0);assert.doesNotMatch(f.statuses.textContent,/已同步/);
});

test('a cookie account changed in another tab cannot retarget consent given to account A',async()=>{
 const f=syncFixture();f.cx.accountApi.me=async()=>({accountId:'B'});await f.run();assert.equal(f.calls.length,0);assert.match(f.statuses.textContent,/账号或作品版本已变化/);
});

test('actual account transport sends CAS and actor binding; a newer remote document remains intact',async()=>{
 const f=syncFixture();let remote={version:4,document:{answer:'REMOTE-NEWER'}};const wire=[];
 f.cx.accountApi=new UnseenAccountApi({fetch:async(path,init)=>{
  if(path==='/v1/me')return Response.json({accountId:'A'});
  wire.push({method:init.method,version:init.headers['If-Match'],actor:init.headers['X-Unseen-Expected-Account-Id']});
  if(Number(init.headers['If-Match'])!==remote.version)return Response.json({error:{code:'version_conflict'}},{status:409});
  remote={version:remote.version+1,document:JSON.parse(init.body).document};return Response.json(remote);
 }});
 await f.run();assert.deepEqual(wire,[{method:'POST',version:'2',actor:'A'}]);assert.equal(remote.document.answer,'REMOTE-NEWER');assert.equal(remote.version,4);assert.equal(f.memory.title,'old local');assert.match(f.statuses.textContent,/未覆盖远端/);
});
test('actual account transport preserves normal first binding at version zero',async()=>{
 const f=syncFixture();f.memory.syncBases={};let saved;
 f.cx.accountApi=new UnseenAccountApi({fetch:async(path,init)=>{
  if(path==='/v1/me')return Response.json({accountId:'A'});
  assert.equal(init.headers['If-Match'],'0');assert.equal(init.headers['X-Unseen-Expected-Account-Id'],'A');saved=JSON.parse(init.body).document;return Response.json({id:saved.id,version:1});
 }});
 await f.run();assert.equal(saved.title,'old local');assert.match(f.statuses.textContent,/已同步到当前账号/);
});

test('account list displays escaped private titles and dates without using internal IDs as copy',()=>{
 const html=cloudScreen({cloudMemories:[{id:'memory:secret-internal',title:'夏夜 <照片>',createdAt:1788570000000,photoCount:2},{id:'memory:unnamed',title:'',createdAt:'bad'}]});
 assert.match(html,/夏夜 &lt;照片&gt;/);assert.match(html,/2 张照片/);assert.match(html,/未命名作品/);
 assert.doesNotMatch(html,/>memory:secret-internal</);assert.doesNotMatch(html,/>memory:unnamed</);assert.match(html,/data-app-cloud="memory:secret-internal"/);
});
test('loading a cloud list clears stale titles, distinguishes empty results, and exposes retry after failure',async()=>{
 let resume,entered;const started=new Promise(r=>entered=r);const cx=fixture({memories:()=>{entered();return new Promise(r=>resume=r);}});cx.state.cloudMemories=[{title:'stale private title'}];
 const flight=cx.loadCloudMemories();await started;assert.equal(cx.state.cloudMemories.length,0);assert.equal(cx.state.cloudLoading,true);assert.match(cloudScreen(cx.state),/aria-busy="true"/);
 resume({memories:[]});await flight;assert.equal(cx.state.cloudLoading,false);assert.match(cx.state.cloudStatus,/还没有归入/);
 cx.accountApi.memories=async()=>{throw Error('offline');};await cx.loadCloudMemories();assert.equal(cx.state.cloudLoading,false);assert.match(cx.state.cloudStatus,/暂时读不到/);assert.match(cloudScreen(cx.state),/刷新账号作品/);
});
