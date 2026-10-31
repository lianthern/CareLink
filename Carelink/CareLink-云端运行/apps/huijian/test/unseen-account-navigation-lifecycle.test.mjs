import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createAccountSurface,bookMountCallbacks} from '../public/unseen-app-account.js';
const source=readFileSync(new URL('../public/unseen-app.js',import.meta.url),'utf8');
const section=(from,to)=>{const start=source.indexOf(from);assert.notEqual(start,-1,from);const end=source.indexOf(to,start+from.length);assert.notEqual(end,-1,to);return source.slice(start,end);};

function harness(){
 const pending=[];let renders=0,downloads=0,lateNavigations=0;
 const surface=createAccountSurface({api:{viewer:(_id,{signal})=>new Promise(resolve=>pending.push({signal,resolve}))}});
 const events=new Map();
 const context=vm.createContext({state:{screen:'account',history:[],accountTarget:{route:'album',spaceId:'space'},accountHtml:'old'},accountSurface:surface,
  screenRenderers:{home(){},mine(){},account(){}},invalidateCloudRequests(){},invalidateQuestion(){},voiceInput:{cancel(){}},turnVoice:{stop(){}},
  syncAppUrl(){},persistDraft(){},render(){renders++;},renderOverlay(){},window:{addEventListener:(name,handler)=>events.set(name,handler)},
  appCases:{get:()=>null},URLSearchParams,location:{search:'',pathname:'/app'},teardownSpatial(){}});
 // Run the production root functions and listeners, not substitutes for their cleanup calls.
 vm.runInContext(section('let accountGeneration=0;','const Recognition ='),context);
 vm.runInContext(section('function navigate(screen,','function officialPostFromLocation()'),context);
 vm.runInContext(section('function goBack(){','function showToast('),context);
 vm.runInContext(section('window.addEventListener("pagehide"','\nrender();\nconst navigationRestorePromise'),context);
 return {context,events,pending,get renders(){return renders;},surface,
  lateCallbacks(signal){return bookMountCallbacks({signal,isCurrent:()=>true,onPdf:()=>downloads++,navigate:()=>lateNavigations++});},
  get published(){return {downloads,lateNavigations};}};
}
async function begin(f){
 const running=f.context.openAccount({route:'album',spaceId:'space'},{remember:false});
 assert.equal(f.pending.length,1);const request=f.pending[0];
 return {running,request,callbacks:f.lateCallbacks(request.signal)};
}
async function finishCancelled(f,job){
 assert.equal(job.request.signal.aborted,true,'the real account render signal must be cancelled');
 job.callbacks.onPdf({ok:true,body:new Uint8Array([1])});job.callbacks.navigate('/stale-book');
 const before=f.context.state.accountHtml;job.request.resolve({photos:[]});await job.running;
 assert.deepEqual(f.published,{downloads:0,lateNavigations:0});
 assert.equal(f.context.state.accountHtml,before,'late account HTML must not repaint a replaced surface');
}

test('normal navigation from account to My cancels the real pending surface and late book callbacks',async()=>{
 const f=harness(),job=await begin(f);f.context.navigate('mine');await finishCancelled(f,job);assert.equal(f.context.state.screen,'mine');
});
test('in-app Back to My disposes the account before applying its history destination',async()=>{
 const f=harness(),job=await begin(f);f.context.state.history=[{screen:'mine'}];f.context.goBack();await finishCancelled(f,job);assert.equal(f.context.state.screen,'mine');
});
test('browser popstate to My cancels pending account work and refuses late PDF/navigation',async()=>{
 const f=harness(),job=await begin(f);f.events.get('popstate')({state:{unseenApp:true,screen:'mine'}});await finishCancelled(f,job);assert.equal(f.context.state.screen,'mine');
});
test('pagehide cancels unfinished account work without requiring an in-app navigation',async()=>{
 const f=harness(),job=await begin(f);f.events.get('pagehide')({});await finishCancelled(f,job);
});
test('same-account route replacement cancels the prior surface but current downloads remain usable',async()=>{
 const f=harness(),old=await begin(f);const current=f.context.openAccount({route:'album',spaceId:'other'});assert.equal(f.pending.length,2);
 await finishCancelled(f,old);const request=f.pending[1];assert.equal(request.signal.aborted,false);
 const callbacks=f.lateCallbacks(request.signal);callbacks.onPdf({ok:true});callbacks.navigate('/current-version');assert.deepEqual(f.published,{downloads:1,lateNavigations:1});
 request.resolve({photos:[]});await current;f.surface.destroy();
});

test('browser history within account aborts the old request and renders the new account target',async()=>{
 const f=harness(),old=await begin(f);
 f.events.get('popstate')({state:{unseenApp:true,screen:'account',accountTarget:{route:'album',spaceId:'history-space'}}});
 await finishCancelled(f,old);assert.equal(f.pending.length,2);assert.equal(f.pending[1].signal.aborted,false);
 f.pending[1].resolve({photos:[]});await new Promise(resolve=>setImmediate(resolve));f.surface.destroy();
});

test('bfcache pageshow restores a fresh account request after pagehide cancellation',async()=>{
 const f=harness(),old=await begin(f);f.events.get('pagehide')({});await finishCancelled(f,old);
 f.events.get('pageshow')({persisted:true});assert.equal(f.pending.length,2);assert.equal(f.pending[1].signal.aborted,false);
 f.pending[1].resolve({photos:[]});await new Promise(resolve=>setImmediate(resolve));f.surface.destroy();
});
