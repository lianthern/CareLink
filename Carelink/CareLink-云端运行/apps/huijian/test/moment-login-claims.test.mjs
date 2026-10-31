import fs from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as data from '../public/moment-data.js';
import * as suggestions from '../public/moment-suggestions.js';

const appSource=(await fs.readFile(new URL('../public/moment-app.js',import.meta.url),'utf8')).replace(/^import .*\n/gm,'').split("root.addEventListener('click'")[0];
const GUEST=data.GUEST_ACCOUNT;

function harness({recovery,boot=false,register=async()=>({registration:{status:"active"}}),loginError=null}={}) {
  const documents=new Map(),claims=[],writes=[],routes=[],storage=new Map(),apiCalls=[],dialogs=[];
  const key=(account,id)=>`${account}:${id}`;
  const cache={
    get:async(account,id)=>{const value=documents.get(key(account,id));return value?.claimedBy?undefined:structuredClone(value);},
    list:async account=>[...documents].filter(([k,v])=>k.startsWith(account+':')&&!v.claimedBy).map(([,v])=>structuredClone(v)),
    put:async(account,record)=>documents.set(key(account,record.moment.id),structuredClone({...record,accountId:account})),
    getMedia:async()=>null,
    async claimGuest(id,accountId){
      claims.push({id,accountId});
      const source=documents.get(key(GUEST,id));
      assert(source,'claim requires an existing guest document');
      if(source.claimedBy){assert.equal(source.claimedBy,accountId);return;}
      documents.set(key(accountId,id),structuredClone({...source,accountId,dirty:true,version:0,base:null}));
      documents.set(key(GUEST,id),structuredClone({...source,claimedBy:accountId}));
    }
  };
  const owned={moment:{...data.newMoment(),id:'existing-owned',title:'Existing account memory'},accountId:'signed-in',dirty:false,version:1,uploads:[]};
  documents.set(key('signed-in',owned.moment.id),structuredClone(owned));
  class Api {
    setAccount(accountId){this.accountId=accountId;}
    async request(path,options={}){
      apiCalls.push(path);
      if(path==='/v1/auth/register')return register();
      if(path==='/v1/auth/password-login'){if(loginError)throw loginError;return {accountId:'signed-in'};}
      if(path==='/v1/profile')return {user:{id:'signed-in',username:'qa',preferences:{}}};
      if(path==='/api/moment-config')return {};
      if(path==='/v1/moments')return {moments:[]};
      if(options.method==='PUT') { writes.push(options.body.moment.id);return {version:2,moment:structuredClone(options.body.moment)}; }
      if(path.startsWith('/v1/moments/')) {const id=path.split('/').at(-1);const record=documents.get(key(this.accountId,id));assert(record,`unexpected account lookup ${id}`);return {version:record.version||1,moment:structuredClone(record.moment)};}
      throw new Error(`unexpected API call ${path}`);
    }
  }
  const node={querySelector:()=>null,querySelectorAll:()=>[],replaceChildren(){},children:[],style:{setProperty(){}},classList:{add(){},remove(){}},addEventListener(){}};
  const location={hash:'#memory/current/review',pathname:'/app'};
  const localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
  if(recovery)storage.set('moment-claim-intent',JSON.stringify(recovery));
  const navigate=url=>{routes.push(url);location.hash=url.includes('#')?'#'+url.split('#')[1]:'';};
  const context=vm.createContext({...data,...suggestions,dialogs,console,Blob,File,URL,AbortController,AbortSignal,DOMException,structuredClone,setTimeout,clearTimeout,location,localStorage,navigator:{onLine:true},document:{querySelector:()=>node,hidden:false},window:{},history:{pushState:(_a,_b,url)=>navigate(url),replaceState:(_a,_b,url)=>navigate(url)},FormData:class{constructor(form){this.values=form.values;}get(name){return this.values[name];}},MomentApi:Api,openMomentCache:()=>cache,createMomentVoice:()=>({getState:()=>({phase:'idle'}),cancel(){},finish:async()=>true}),createTurnVoicePlayer:()=>({stop(){},prepare(){},speak:async()=>true}),mountMomentParticles:()=>({}),spatialRoutes:hash=>hash==='#new-space',fetchExamples:async()=>({examples:[]})});
  vm.runInContext(appSource+`\nrender=()=>{};updateChat=()=>{};updateComposer=()=>{};updateSync=()=>{};toast=()=>{};showDialog=(title)=>dialogs.push(title);spaces.resumeSave=async()=>{};globalThis.h={s,records,requestLogin,onSubmit,establishSession,claimIntent,closeDialog,onAction};`,context);
  const h=context.h;
  h.s.user=boot?null:{id:GUEST,guest:true,preferences:{}};h.s.view='chat';
  for(const [id,status] of [['current','complete'],['unrelated','active']]){
    const record={moment:{...data.newMoment(),id,status,title:id},accountId:GUEST,dirty:true,version:0,revision:1,uploads:[]};
    documents.set(key(GUEST,id),structuredClone(record));
    if(!boot)h.records.set(id,record);
    if(id==='current'&&!boot)h.s.record=record;
  }
  async function submit(action,kind="login"){
    await h.requestLogin(action);
    const form={dataset:{form:kind},values:{username:'qa',password:'test-password-2026',displayName:'新用户'},querySelector:()=>null,closest(){return this;}};
    await h.onSubmit({target:form,preventDefault(){}});
    await new Promise(resolve=>setImmediate(resolve));
  }
  return {h,submit,documents,claims,writes,routes,location,storage,owned,key,apiCalls,dialogs};
}

for(const action of ['profile','library','spatial','spatial-save']) test(`${action} login leaves all visitor drafts unclaimed`,async()=>{
  const h=harness({recovery:{accountId:'signed-in',action:'profile',momentId:'current',ids:['current','unrelated']}});
  if(action.startsWith('spatial'))h.location.hash='#new-space';
  await h.submit(action);
  assert.deepEqual(h.claims,[]);assert.deepEqual(h.writes,[]);
  for(const id of ['current','unrelated'])assert.equal(h.documents.get(h.key(GUEST,id)).claimedBy,undefined);
  assert.deepEqual(h.documents.get(h.key('signed-in','existing-owned')),h.owned);
  assert.equal(h.storage.has('moment-claim-intent'),false);
  if(action==='library')assert.equal(h.h.s.view,'library');
});

test('explicit save claims and uploads only the selected memory and preserves review routing',async()=>{
  const h=harness();await h.submit('save');
  assert.deepEqual(h.claims,[{id:'current',accountId:'signed-in'}]);
  assert(h.writes.includes('current'));assert(!h.writes.includes('unrelated'));
  assert.equal(h.documents.get(h.key(GUEST,'unrelated')).claimedBy,undefined);
  assert.deepEqual(h.documents.get(h.key('signed-in','existing-owned')),h.owned);
  assert.equal(h.h.s.record.moment.id,'current');assert.equal(h.h.s.review,true);
  assert.equal(h.location.hash,'#memory/current/review');
});

test('save authorization freezes the current ID before the login request',async()=>{
  const h=harness();await h.h.requestLogin('save');
  h.h.s.record=h.h.records.get('unrelated');
  const form={dataset:{form:'login'},values:{username:'qa',password:'password'},querySelector:()=>null,closest(){return this;}};
  await h.h.onSubmit({target:form,preventDefault(){}});
  assert.deepEqual(h.claims,[{id:'current',accountId:'signed-in'}]);
  assert.equal(h.location.hash,'#memory/current/review');
});

for(const action of ['profile','library','spatial-save']) test(`boot ignores legacy ${action} claim markers`,async()=>{
  const h=harness({boot:true,recovery:{accountId:'signed-in',action,momentId:'current',ids:['current','unrelated']}});
  h.location.hash='';await h.h.establishSession();
  assert.deepEqual(h.claims,[]);assert.equal(h.storage.has('moment-claim-intent'),false);
  assert.equal(h.documents.get(h.key(GUEST,'current')).claimedBy,undefined);
  assert.equal(h.documents.get(h.key(GUEST,'unrelated')).claimedBy,undefined);
});

test('boot recovers only the explicitly authorized save ID, ignoring legacy broad ID lists',async()=>{
  const h=harness({boot:true,recovery:{accountId:'signed-in',action:'save',momentId:'current',ids:['current','unrelated']}});
  await h.h.establishSession();
  assert.deepEqual(h.claims,[{id:'current',accountId:'signed-in'}]);
  assert.equal(h.documents.get(h.key(GUEST,'unrelated')).claimedBy,undefined);
  assert.equal(h.location.hash,'#memory/current/review');
});

test('ordinary login does not replay a pending save recovery',async()=>{
  const h=harness({recovery:{accountId:'signed-in',action:'save',momentId:'current',ids:['current']}});
  await h.submit('profile');assert.deepEqual(h.claims,[]);
});

test('save recovery for a different account never transfers drafts',async()=>{
  const h=harness({boot:true,recovery:{accountId:'different-account',action:'save',momentId:'current',ids:['current']}});
  h.location.hash='';await h.h.establishSession();assert.deepEqual(h.claims,[]);
});

for(const action of ['spatial','save'])test(`${action} registration signs in immediately and preserves the intended draft ownership`,async()=>{
  const h=harness();if(action==='spatial')h.location.hash='#new-space';
  await h.submit(action,'register');
  assert.deepEqual(h.apiCalls.slice(0,3),['/v1/auth/register','/v1/auth/password-login','/v1/profile']);
  assert.equal(h.h.s.user.id,'signed-in');
  if(action==='spatial'){assert.deepEqual(h.claims,[]);assert.equal(h.location.hash,'#new-space');}
  else assert.deepEqual(h.claims,[{id:'current',accountId:'signed-in'}]);
  assert.equal(h.documents.get(h.key(GUEST,'unrelated')).claimedBy,undefined);
});

test('closing registration before the response does not trigger a late login or claim drafts',async()=>{
  let release;const h=harness({register:()=>new Promise(resolve=>{release=resolve;})});
  const submitted=h.submit('spatial','register');
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  h.h.closeDialog();release({registration:{status:'active'}});await submitted;
  assert.deepEqual(h.apiCalls,['/v1/auth/register']);assert.deepEqual(h.claims,[]);assert.equal(h.h.s.user.id,GUEST);
});

test('registration success followed by a failed login returns to login without asking for another registration',async()=>{
  const h=harness({loginError:{code:'session_unavailable'}});await h.submit('spatial','register');
  assert.equal(h.dialogs.at(-1),'账号已创建');assert.deepEqual(h.claims,[]);assert.equal(h.h.s.user.id,GUEST);
});

test('returning to login invalidates a late registration while preserving the save intent for the chosen login',async()=>{
  let release;const h=harness({register:()=>new Promise(resolve=>{release=resolve;})});
  const submitted=h.submit('save','register');
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  const button={dataset:{action:'back-login'},closest(){return this;}};
  await h.h.onAction({target:button});
  const form={dataset:{form:'login'},values:{username:'chosen-account',password:'test-password-2026'},querySelector:()=>null,closest(){return this;}};
  await h.h.onSubmit({target:form,preventDefault(){}});
  release({registration:{status:'active'}});await submitted;
  assert.equal(h.apiCalls.filter(path=>path==='/v1/auth/password-login').length,1);
  assert.deepEqual(h.claims,[{id:'current',accountId:'signed-in'}]);
  assert.equal(h.documents.get(h.key(GUEST,'unrelated')).claimedBy,undefined);
});
