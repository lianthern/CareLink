import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {worldPendingDecision,canClearWorldPendingAfterError} from '../public/unseen-app-world.js';
import {retainSpatialRevision,restoreSpatialRevision} from '../public/moment-spatial-history.js';
import {WORLD_MODELS,worldModelLabel,worldPhotoAssessment} from '../public/world-generation-options.js';
import {worldInputLimits,worldAccountDecision,worldDraftId,worldPendingKey} from '../public/moment-world.js';
const source=(await fs.readFile(new URL('../public/moment-world.js',import.meta.url),'utf8')).replace(/^import .*\n/gm,'').replace(/^export /gm,'');
const decode=value=>value.replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
class Surface {
  set innerHTML(html){this.html=html;this.nodes=[...html.matchAll(/<(button|input|select|textarea)\b([^>]*)(?:>([^<]*))?/g)].map(([,tag,attributes,text])=>{
    const attrs=Object.fromEntries([...attributes.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(([,key,value])=>[key,decode(value??'')]));
    return {tag,attrs,dataset:Object.fromEntries(Object.entries(attrs).filter(([key])=>key.startsWith('data-')).map(([key,value])=>[key.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase()),value])),value:attrs.value??decode(text||''),checked:false,disabled:Object.hasOwn(attrs,'disabled'),listeners:{},addEventListener(type,callback){this.listeners[type]=callback;},closest(){return this;}};
  });}
  get innerHTML(){return this.html;}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  querySelectorAll(selector){if(selector==='input,select,textarea,button')return this.nodes;
    if(selector.startsWith('#'))return this.nodes.filter(node=>node.attrs.id===selector.slice(1));
    if(selector==='input[name="legacy-job"]:checked')return this.nodes.filter(node=>node.attrs.name==='legacy-job'&&node.checked);
    const attr=selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);if(attr)return this.nodes.filter(node=>Object.hasOwn(node.attrs,attr[1])&&(attr[2]===undefined||node.attrs[attr[1]]===attr[2]));
    return [];
  }
}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function harness({saved=[],storage=[],account='alice',config={},jobs=[],handle,draftWrite,decodeImage,preview}={}){
  const root=new Surface(),calls=[],writes=[],routes=[],previews=[],db=new Map(saved.map(row=>[row.id,structuredClone(row)])),local=new Map(storage);let who=account,activeJobs=jobs;
  const settings={enabled:true,maxImageBytes:1048576,maxTotalImageBytes:8388608,minImages:2,maxImages:8,quota:{remainingToday:7},...config};
  const api={async request(path,options){calls.push({path,...options});if(handle){const handled=await handle(path,options);if(handled!==undefined)return handled;}
    if(path==='/api/world/config')return settings;
    if(path==='/api/world/jobs')return {jobs:activeJobs,accountId:who};
    if(path==='/api/world/jobs/legacy')return {jobs:[]};
    if(path==='/v1/me/spaces')return {spaces:[{spaceId:'space-one',name:'家',owner:true,spaceLifecycle:'active'}]};
    if(path==='/v1/spaces/space-one/management')return {space:{spaceId:'space-one',name:'家',owner:true,version:3},sceneVersion:7};
    throw Error('Unexpected request '+path);
  }};
  const drafts=async(method,value)=>{if(method==='getAll')return structuredClone([...db.values()]);if(method==='put'){if(draftWrite)await draftWrite(value);writes.push(structuredClone(value));db.set(value.id,structuredClone(value));return value;}};
  class MockImage {naturalWidth=4000;naturalHeight=2000;async decode(){await decodeImage?.();}}
  class MockReader {readAsDataURL(file){queueMicrotask(()=>{this.result=file.contents||'data:image/png;base64,bmV3';this.onload?.();});}}
  const context=vm.createContext({console,structuredClone,DOMException,AbortController,AbortSignal,crypto:webcrypto,WORLD_MODELS,worldModelLabel,worldPhotoAssessment,worldPendingDecision,canClearWorldPendingAfterError,retainSpatialRevision,restoreSpatialRevision,Image:MockImage,FileReader:MockReader,document:{createElement:()=>({getContext:()=>({drawImage(){}}),toDataURL:()=> 'data:image/jpeg;base64,Y29weQ=='})},navigator:{locks:{request:async(name,options,callback)=>callback({name})}},localStorage:{getItem:key=>local.get(key)||null,setItem:(key,value)=>local.set(key,String(value)),removeItem:key=>local.delete(key)},api,drafts,user:()=>who?{id:who}:null,guest:()=>!who,navigate:route=>routes.push(route),showScene:scene=>{previews.push(scene);return preview?.(root,scene);},login:()=>routes.push('login')});
  vm.runInContext(source+'\nglobalThis.world=createMomentWorld({api,drafts,user,guest,navigate,showScene,login});',context);
  const click=async(selector,{forced=false}={})=>{const node=root.querySelector(selector);assert.ok(node,'missing control '+selector);if(!forced)assert.equal(node.disabled,false,'disabled control '+selector);await root.onclick?.({target:node});};
  return {root,world:context.world,calls,writes,routes,previews,db,local,click,account:id=>{who=id;},setJobs:rows=>{activeJobs=rows;},mount:(tasks=false,options={spaceId:'space-one'})=>context.world.mount(root,tasks,options),consent:()=>{root.querySelector('#account-world-consent').checked=true;}};
}
const photo=name=>({name,src:'data:image/png;base64,b3JpZ2luYWw='});
const draft=(account='alice',extra={})=>({id:worldDraftId(account),accountId:account,title:account+' 的原稿',prompt:'真实原文',photos:[photo('前'),photo('后')],worldMode:'multi',spaceId:'space-one',...extra});
const complete={id:'job-complete',createdAt:1788566400000,status:'complete',spaceId:'space-one',operation:{id:'operation-done',done:true,world:{id:'world-real',viewerUrl:'https://marble.worldlabs.ai/world/world-real'}}};

test('opening a completed World keeps the viewer on screen after the task action finishes',async()=>{
  const viewerClick=()=>{};
  const h=harness({saved:[draft()],jobs:[complete],preview:root=>{root.innerHTML='<button data-viewer>3D viewer</button>';root.onclick=viewerClick;}});
  await h.mount(true);const oldClick=h.root.onclick;
  await h.click('[data-world-preview="job-complete"]');
  assert.match(h.root.innerHTML,/3D viewer/);assert.equal(h.root.onclick,viewerClick);
  assert.equal(h.previews[0].space.world.id,'world-real');
  await oldClick({target:{dataset:{worldAction:'clear'},closest(){return this;}}});
  assert.match(h.root.innerHTML,/3D viewer/);assert.equal(h.writes.length,0);
  await h.mount(true);assert.match(h.root.innerHTML,/我的空间任务/);
});

test('limits are server values and account-wide unknown jobs block without a browser hint',()=>{
  assert.equal(worldInputLimits(null),null);assert.equal(worldInputLimits({maxImageBytes:1,maxTotalImageBytes:2,minImages:4,maxImages:2}),null);
  assert.deepEqual(worldInputLimits({maxImageBytes:1,maxTotalImageBytes:2,minImages:2,maxImages:4}),{imageBytes:1,totalBytes:2,minImages:2,maxImages:4});
  for(const status of ['unknown','submitting','processing'])assert.equal(worldAccountDecision(null,[{id:'server-only',status}]).blocked,true);
  assert.equal(worldAccountDecision('settled',[{id:'settled',status:'complete'},{id:'unknown',status:'unknown'}]).blocked,true);
  assert.equal(worldAccountDecision(null,[{id:'accepted',status:'processing',operation:{id:'actual-receipt'}}]).blocked,false);
});

test('mount reads only the signed-in draft; legacy content requires explicit copy and keeps the original',async()=>{
  const legacy={...draft('world-browser'),id:'world-input',title:'浏览器旧原稿'},h=harness({saved:[draft(),draft('bob'),legacy,{...draft(),id:'other-history',archivedAt:'2026-09-06',sourceDraftId:'capture-other'}]});
  await h.mount();assert.match(h.root.innerHTML,/alice 的原稿/);assert.doesNotMatch(h.root.innerHTML,/bob 的原稿|浏览器旧原稿|other-history/);assert.equal(h.writes.length,0);assert.equal(h.calls.some(call=>call.path.includes('legacy')),false);
  await h.click('[data-world-action="claim-draft"]');assert.equal(h.db.get(worldDraftId('alice')).title,'浏览器旧原稿');assert.deepEqual(h.db.get('world-input'),legacy);assert.equal(h.db.get(worldDraftId('bob')).title,'bob 的原稿');assert.ok(h.writes.some(row=>row.archivedAt&&row.title==='alice 的原稿'));
});

test('only selected legacy jobs are claimed and the matching pending marker follows that explicit claim',async()=>{
  const old={id:'legacy-request',status:'unknown',createdAt:1788566400000};let claimed=[];const h=harness({saved:[draft()],storage:[['unseen.app.world.pending',old.id]],handle:(path,options)=>{
    if(path.endsWith('/legacy'))return {jobs:[old,{...old,id:'not-selected'}]};
    if(path.endsWith('/claim')){claimed=[...options.body.ids];h.setJobs([old]);return {jobs:[old]};}
  }});
  await h.mount();assert.equal(h.root.querySelector('[data-world-action="generate"]').disabled,true);
  await h.click('[data-world-action="legacy-jobs"]');h.root.nodes.find(node=>node.attrs.name==='legacy-job'&&node.value===old.id).checked=true;await h.click('[data-world-action="claim-jobs"]');
  assert.deepEqual(claimed,[old.id]);assert.equal(h.local.has('unseen.app.world.pending'),false);assert.equal(h.local.get(worldPendingKey('alice')),old.id);assert.match(h.root.innerHTML,/先核对已有提交/);
});

test('an unresolved account marker is not overwritten by a different legacy claim',async()=>{
  const h=harness({storage:[[worldPendingKey('alice'),'current-unknown'],['unseen.app.world.pending','old-unknown']],handle:path=>path.endsWith('/legacy')?{jobs:[{id:'old-unknown',status:'unknown'}]}:undefined});await h.mount();await h.click('[data-world-action="legacy-jobs"]');h.root.nodes.find(node=>node.attrs.name==='legacy-job').checked=true;await h.click('[data-world-action="claim-jobs"]');assert.equal(h.calls.some(call=>call.path.endsWith('/claim')),false);assert.equal(h.local.get(worldPendingKey('alice')),'current-unknown');assert.equal(h.local.get('unseen.app.world.pending'),'old-unknown');
});

test('server-only unresolved work and locally missing records each prevent generation',async()=>{
  for(const params of [{jobs:[{id:'remote-unknown',status:'unknown'}]},{storage:[[worldPendingKey('alice'),'missing-record']]}]){
    const h=harness({...params,saved:[draft()]});await h.mount();h.consent();assert.equal(h.root.querySelector('[data-world-action="generate"]').disabled,true);assert.equal(h.calls.some(call=>call.method==='POST'),false);assert.match(h.root.innerHTML,/先核对已有提交/);
  }
});

test('unknown scene version disables submission instead of guessing the initial version',async()=>{
  const h=harness({saved:[draft()],handle:path=>path.endsWith('/management')?{space:{spaceId:'space-one',owner:true,version:3},sceneVersion:null}:undefined});await h.mount();assert.equal(h.root.querySelector('[data-world-action="generate"]').disabled,true);assert.match(h.root.innerHTML,/无法核对现场版本/);assert.equal(h.calls.some(call=>call.method==='POST'),false);
});

test('production management ownership enables only the actual owner to submit selected photos',async()=>{
  for(const owner of [true,false]){
    const h=harness({saved:[draft()],handle:(path,options)=>{
      if(path.endsWith('/management'))return {isOwner:owner,sceneVersion:7,space:{spaceId:'space-one',name:'家',version:3,spaceLifecycle:'active'}};
      if(path==='/api/world/generate'){h.setJobs([{id:options.body.clientRequestId,status:'processing',operation:{id:'receipt'},createdAt:1788566400000}]);return {operation:{id:'receipt'}};}
    }});
    await h.mount();
    assert.equal(h.root.querySelector('[data-world-action="generate"]').disabled,!owner);
    if(owner){h.consent();await h.click('[data-world-action="generate"]');}
    assert.equal(h.calls.filter(call=>call.path==='/api/world/generate').length,owner?1:0);
  }
});

test('generation captures current canonical versions and a receipt clears only its own attempt',async()=>{
  const h=harness({saved:[draft()],handle:(path,options)=>{if(path==='/api/world/generate'){h.setJobs([{id:options.body.clientRequestId,status:'processing',operation:{id:'real-receipt'},createdAt:1788566400000}]);return {operation:{id:'real-receipt'}};}}});await h.mount();h.consent();await h.click('[data-world-action="generate"]');
  const posts=h.calls.filter(call=>call.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0].path,'/api/world/generate');assert.equal(posts[0].accountId,'alice');assert.deepEqual(JSON.parse(JSON.stringify(posts[0].body)),{clientRequestId:posts[0].key,mode:'multi',model:'marble-1.1',images:['data:image/jpeg;base64,Y29weQ==','data:image/jpeg;base64,Y29weQ=='],displayName:'alice 的原稿',prompt:'真实原文',publicConsent:true,spaceId:'space-one',spaceVersion:3,sceneVersion:7});assert.equal(h.local.has(worldPendingKey('alice')),false);assert.equal(h.db.get(worldDraftId('alice')).photos[0].src,photo('前').src);
});

test('unknown transport result keeps its request and cannot be submitted again',async()=>{
  const h=harness({saved:[draft()],handle:path=>{if(path==='/api/world/generate')throw {code:'provider_timeout',status:504,data:{error:'provider_timeout'}};}});await h.mount();h.consent();await h.click('[data-world-action="generate"]');const attempt=h.calls.find(call=>call.path==='/api/world/generate').key;assert.equal(h.local.get(worldPendingKey('alice')),attempt);assert.equal(h.root.querySelector('[data-world-action="generate"]').disabled,true);await h.click('[data-world-action="tasks"]');assert.equal(h.calls.filter(call=>call.method==='POST').length,1);
});

test('only an exact pre-admission proof can clear a rejected attempt',async()=>{
  for(const correct of [true,false]){const h=harness({saved:[draft()],handle:(path,options)=>{if(path==='/api/world/generate')throw {status:409,data:{error:'version_conflict',admitted:false,requestId:correct?options.body.clientRequestId:'different-request'}};}});await h.mount();h.consent();await h.click('[data-world-action="generate"]');assert.equal(h.local.has(worldPendingKey('alice')),!correct);}
});

test('failure to retain originals stops before POST and unlocks the editor',async()=>{
  let failed=true;const h=harness({saved:[draft()],draftWrite:()=>{if(failed)throw Error('QuotaExceeded');}});await h.mount();h.consent();await h.click('[data-world-action="generate"]');assert.equal(h.calls.some(call=>call.method==='POST'),false);assert.match(h.root.innerHTML,/原素材未能保存/);assert.equal(h.root.querySelector('[data-world-action="clear"]').disabled,false);assert.equal(h.db.get(worldDraftId('alice')).photos.length,2);failed=false;
});

test('account switch during image preparation cannot POST or write the next account draft',async()=>{
  const decoding=deferred();const h=harness({saved:[draft(),draft('bob')],decodeImage:()=>decoding.promise});await h.mount();const oldName=h.root.querySelector('#account-world-name'),oldRootClick=h.root.onclick;h.consent();const submitting=h.click('[data-world-action="generate"]');await flush();h.account('bob');await h.mount();oldName.value='late wrong account';await oldName.oninput();await oldRootClick({target:{disabled:false,dataset:{worldAction:'clear'},closest(){return this;}}});decoding.resolve();await submitting;assert.equal(h.calls.some(call=>call.method==='POST'),false);assert.equal(h.db.get(worldDraftId('bob')).title,'bob 的原稿');assert.match(h.root.innerHTML,/bob 的原稿/);assert.equal(h.local.has(worldPendingKey('bob')),false);
});

test('destroy aborts a pending account response; late results cannot render in a new mount',async()=>{
  const held=deferred();let heldOnce=false;const h=harness({saved:[draft(),draft('bob')],handle:(path,options)=>{if(path==='/api/world/jobs'&&!heldOnce){heldOnce=true;return held.promise;}}});const loading=h.mount();await flush();const active=h.calls.find(call=>call.path==='/api/world/jobs');h.world.destroy();assert.equal(active.signal.aborted,true);h.account('bob');await h.mount();held.resolve({jobs:[{...complete,displayName:'alice private result'}]});await loading;assert.doesNotMatch(h.root.innerHTML,/alice private result/);assert.match(h.root.innerHTML,/bob 的原稿/);
});

test('completed output imports only after explicit confirmation and never calls generation',async()=>{
  const h=harness({jobs:[complete],handle:(path,options)=>{if(path.endsWith('/import')){h.setJobs([{...complete,importedSpaceId:'space-one'}]);return {space:{spaceId:'space-one',worldResultId:'result-one',sceneVersion:8},job:{...complete,importedSpaceId:'space-one'}};}}});await h.mount(true);assert.equal(h.calls.some(call=>call.method==='POST'),false);await h.click('[data-world-import="job-complete"]');assert.match(h.root.innerHTML,/此操作只保存已有成果/);assert.equal(h.calls.some(call=>call.method==='POST'),false);await h.click('[data-world-action="confirm-import"]');const posts=h.calls.filter(call=>call.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0].path,'/api/world/jobs/job-complete/import');assert.deepEqual(JSON.parse(JSON.stringify(posts[0].body)),{spaceId:'space-one',spaceVersion:3,sceneVersion:7});assert.deepEqual(h.routes,['shared-space/space-one']);
});

test('import version conflict retains the completed job and requires a new explicit confirmation',async()=>{
  const h=harness({jobs:[complete],handle:path=>{if(path.endsWith('/import'))throw {code:'scene_version_conflict',status:409};}});await h.mount(true);await h.click('[data-world-import="job-complete"]');await h.click('[data-world-action="confirm-import"]');assert.match(h.root.innerHTML,/现场版本已变化/);assert.equal(h.calls.filter(call=>call.method==='POST').length,1);assert.equal(h.root.querySelector('[data-world-action="confirm-import"]').disabled,true);await h.click('[data-world-action="reload-target"]');assert.equal(h.calls.filter(call=>call.method==='POST').length,1);assert.deepEqual(h.routes,[]);assert.ok(h.root.querySelector('[data-world-action="confirm-import"]'));
});

test('an imported receipt reopens its canonical space without importing a second scene',async()=>{
  const h=harness({jobs:[{...complete,importedSpace:{spaceId:'space-one'},importedAt:'2026-09-06'}]});await h.mount(true);assert.equal(h.root.querySelector('[data-world-import="job-complete"]'),null);await h.click('[data-world-open-space="space-one"]');assert.deepEqual(h.routes,['shared-space/space-one']);assert.equal(h.calls.some(call=>call.method==='POST'),false);
});

test('credit rejection shows WL-204 in the editor and recovered tasks without automatically resubmitting',async()=>{
 const h=harness({saved:[draft()],handle:(path,options)=>{
  if(path==='/api/world/generate'){
   const id=options.body.clientRequestId;h.setJobs([{id,status:'rejected',error:'WL-204',createdAt:1788566400000}]);
   throw {status:503,code:'WL-204',data:{error:'WL-204',status:'rejected',requestId:id}};
  }
 }});
 await h.mount();h.consent();await h.click('[data-world-action="generate"]');
 assert.match(h.root.innerHTML,/生成暂时不可用（错误码：WL-204）/);
 assert.doesNotMatch(h.root.innerHTML,/provider_credits_low|服务商额度不足|余额不足/);
 assert.equal(h.local.has(worldPendingKey('alice')),false,'server-confirmed rejection resolves the pending marker');
 assert.equal(h.db.get(worldDraftId('alice')).photos.length,2,'original photos remain');
 await h.click('[data-world-action="tasks"]');assert.match(h.root.innerHTML,/WL-204/);
 assert.equal(h.calls.filter(call=>call.path==='/api/world/generate').length,1);
});

test('a failed asynchronous operation displays the same public support code',async()=>{
 const h=harness({jobs:[{id:'failed-operation',createdAt:1788566400000,status:'failed',operation:{id:'op',done:true,error:{code:'WL-204',message:'生成暂时不可用'}}}]});
 await h.mount(true);assert.match(h.root.innerHTML,/错误码：WL-204/);
});

test('quality picker persists per account, restores on remount and submits exactly the chosen Plus model',async()=>{
 const h=harness({saved:[draft(),draft('bob',{worldModel:'marble-1.0-draft'})],handle:(path,options)=>{if(path==='/api/world/generate'){h.setJobs([{id:options.body.clientRequestId,status:'processing',operation:{id:'plus-receipt'}}]);return {operation:{id:'plus-receipt'}};}}});
 await h.mount();assert.equal(h.root.querySelector('[data-world-model="marble-1.1"]').attrs['aria-pressed'],'true');
 await h.click('[data-world-model="marble-1.1-plus"]');assert.equal(h.db.get(worldDraftId('alice')).worldModel,'marble-1.1-plus');assert.equal(h.db.get(worldDraftId('bob')).worldModel,'marble-1.0-draft');
 await h.mount();assert.equal(h.root.querySelector('[data-world-model="marble-1.1-plus"]').attrs['aria-pressed'],'true');h.consent();await h.click('[data-world-action="generate"]');assert.equal(h.calls.find(c=>c.path==='/api/world/generate').body.model,'marble-1.1-plus');
});

test('panorama needs a separate full-sphere confirmation and only submits one photo',async()=>{
 const h=harness({saved:[draft()],handle:(path,options)=>{if(path==='/api/world/generate'){h.setJobs([{id:options.body.clientRequestId,status:'processing',operation:{id:'pano-receipt'}}]);return {operation:{id:'pano-receipt'}};}}});
 await h.mount();await h.click('[data-world-mode="pano"]');h.consent();await h.click('[data-world-action="generate"]');assert.equal(h.calls.some(c=>c.path==='/api/world/generate'),false);assert.match(h.root.innerHTML,/完整 360° 全景/);
 h.consent();h.root.querySelector('#world-pano-confirm').checked=true;await h.click('[data-world-action="generate"]');const post=h.calls.find(c=>c.path==='/api/world/generate');assert.equal(post.body.mode,'pano');assert.equal(post.body.panoConfirmed,true);assert.equal(post.body.images.length,1);assert.equal(h.db.get(worldDraftId('alice')).photos.length,2);
});

test('photo guidance detects ratio mismatch, low resolution and non-2:1 panoramas',()=>{
 assert.equal(worldPhotoAssessment([{width:4000,height:3000},{width:3000,height:4000}],'multi').errors.length,1);
 assert.equal(worldPhotoAssessment([{width:4000,height:3000},{width:2000,height:1500}],'multi').errors.length,0);
 assert.equal(worldPhotoAssessment([{width:2000,height:1000}],'pano').errors.length,0);
 assert.equal(worldPhotoAssessment([{width:3000,height:1000}],'pano').errors.length,1);
 assert.equal(worldPhotoAssessment([{width:640,height:480}],'single').notes.length,1);
});
