import test from 'node:test';
import assert from 'node:assert/strict';
import {captureMode,captureFileIssues} from '../public/moment-capture-drafts.js';
test('perspective video and panoramic captures keep different geometric checks',()=>{
 const phone=[{width:1920,height:1080}];
 assert.deepEqual(captureFileIssues('perspective-video',phone),[]);
 assert.match(captureFileIssues('panoramic-video',phone)[0],/2:1/);
 assert.equal(captureMode('panoramic'),'panoramic-video');
});
test('multiple positions cannot silently become single panorama viewing',()=>{
 assert.match(captureFileIssues('panoramic-images',[{width:4096,height:2048}])[0],/至少两张/);
 assert.deepEqual(captureFileIssues('panoramic-images',[{width:4096,height:2048},{width:4096,height:2048}]),[]);
 assert.match(captureFileIssues('panoramic-images',[{metadataUnavailable:true},{width:1920,height:1080}]).join(' '),/未验证/);
});

import fs from 'node:fs/promises';
import vm from 'node:vm';
import {createHash,webcrypto} from 'node:crypto';
import {captureCapability,captureDigest,captureUploadIssues} from '../public/moment-capture-drafts.js';
const source=(await fs.readFile(new URL('../public/moment-capture-drafts.js',import.meta.url),'utf8')).replace(/^export /gm,'');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const enabled={schema:'unseen-capture-capabilities/1',mode:'local-only',uploadAvailable:true,processingAvailable:false,registrationAvailable:false,reason:'scene_worker_contract_pending',supportedInputModes:['perspective_video','equirectangular_video','equirectangular_images'],limits:{chunkBytes:3,maxCaptureBytes:2000000,maxAccountBytes:4000000,storageBudgetBytes:8000000,maxFiles:8,maxVideoSeconds:600}};
const disabled={...enabled,mode:'disabled',uploadAvailable:false,limits:null};
const decode=value=>value.replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
class Surface{
  handlers=new Map();
  set innerHTML(html){this.html=html;this.nodes=[...html.matchAll(/<(button|input|select|textarea|form)\b([^>]*)(?:>([^<]*))?/g)].map(([,tag,attributes,text])=>{
    const attrs=Object.fromEntries([...attributes.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(([,key,value])=>[key,decode(value??'')]));
    return {tag,attrs,dataset:Object.fromEntries(Object.entries(attrs).filter(([key])=>key.startsWith('data-')).map(([key,value])=>[key.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase()),value])),name:attrs.name,value:attrs.value??decode(text||''),checked:Object.hasOwn(attrs,'checked'),disabled:Object.hasOwn(attrs,'disabled'),files:[],closest(selector){return selector==='button'?this.tag==='button'?this:null:this.matches(selector)?this:null;},matches(selector){const match=selector.match(/^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/);return Boolean(match&&Object.hasOwn(attrs,match[1])&&(match[2]===undefined||attrs[match[1]]===match[2]));}};
  });}
  get innerHTML(){return this.html;}
  querySelectorAll(selector){if(selector==='input,button,select')return this.nodes.filter(node=>['input','button','select'].includes(node.tag));return this.nodes.filter(node=>node.matches(selector));}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  addEventListener(type,callback){let list=this.handlers.get(type);if(!list)this.handlers.set(type,list=new Set());list.add(callback);}
  removeEventListener(type,callback){this.handlers.get(type)?.delete(callback);}
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function captureHarness({saved=[],db=new Map(saved.map(row=>[row.id,structuredClone(row)])),account='alice',capabilities=disabled,handle,write,metadata}={}){
  const root=new Surface(),surface=new Surface(),calls=[],writes=[],routes=[],urls=[],revoked=[],historyPaths=[];let who=account,serverCapture=null;
  const window={addEventListener:(...args)=>surface.addEventListener(...args),removeEventListener:(...args)=>surface.removeEventListener(...args)};
  const api={async request(path,options){calls.push({path,...options});if(handle){const result=await handle(path,options);if(result!==undefined)return result;}if(path==='/v1/capture-capabilities')return capabilities;if(path==='/v1/me/captures'||path==='/v1/spaces/space-one/captures')return {captures:[]};if(path==='/v1/me/spaces')return {spaces:[{spaceId:'space-one',name:'家',owner:true,spaceLifecycle:'active'}]};if(path==='/v1/spaces/space-one/management')return {space:{spaceId:'space-one',name:'家',owner:true,version:3},sceneVersion:7};throw Error('Unexpected '+path);}};
  const drafts=async(method,value)=>{if(method==='getAll')return structuredClone([...db.values()]);if(method==='put'){await write?.(value);writes.push(structuredClone(value));db.set(value.id,structuredClone(value));}};
  class BrowserURL extends URL{static createObjectURL(blob){const url=URL.createObjectURL(blob);urls.push(url);return url;}static revokeObjectURL(url){revoked.push(url);URL.revokeObjectURL(url);}}
  const document={createElement:tag=>{
    const media={naturalWidth:4000,naturalHeight:2000,videoWidth:1920,videoHeight:1080,duration:12,removeAttribute(){},load(){},async decode(){await metadata?.();}};
    Object.defineProperty(media,'src',{set(){if(tag==='video')Promise.resolve(metadata?.()).then(()=>media.onloadedmetadata?.());}});return media;
  }};
  const context=vm.createContext({console,structuredClone,Blob,File,URL:BrowserURL,URLSearchParams,DOMException,AbortController,AbortSignal,crypto:webcrypto,setTimeout,clearTimeout,window,document,btoa,history:{state:null,replaceState:(state,title,path)=>historyPaths.push(path)},drafts,api,user:()=>who?{id:who}:null,guest:()=>!who,navigate:route=>routes.push(route),login:()=>routes.push('login')});
  vm.runInContext(source+'\nglobalThis.capture=createMomentCaptureDrafts({drafts,api,user,guest,navigate,login});',context);
  const dispatch=async(type,node)=>{const event={target:node,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;}};if(type==='click')for(const fn of surface.handlers.get('click')||[]){fn(event);if(event.stopped)break;}if(!event.stopped)for(const fn of root.handlers.get(type)||[])await fn(event);if(type==='click'&&!event.stopped&&node.dataset.spatialRoute!==undefined)routes.push(node.dataset.spatialRoute);return event;};
  const click=async selector=>{const node=root.querySelector(selector);assert.ok(node,'missing '+selector);assert.equal(node.disabled,false,'disabled '+selector);return dispatch('click',node);};
  return {root,capture:context.capture,calls,writes,routes,db,urls,revoked,historyPaths,click,account:id=>{who=id;},mount:route=>context.capture.mount(root,route||'capture-space?mode=perspective&spaceId=space-one'),select:async files=>{const input=root.querySelector('[data-capture-files]');input.files=files;await dispatch('change',input);},input:async(name,value)=>{const node=root.querySelector('[name='+name+']');node.value=value;return dispatch('input',node);},submit:()=>dispatch('submit',root.querySelector('[data-capture-form]')),dispatch,unload:()=>{const event={preventDefault(){this.prevented=true;},returnValue:null};for(const fn of surface.handlers.get('beforeunload')||[])fn(event);return event;}};
}
const file=()=>new File(['exact original video'],'room.mov',{type:'video/quicktime'});
const localDraft=(accountId='alice',extra={})=>({id:'capture-saved-'+accountId,kind:'capture',accountId,title:accountId+' 的采集',mode:'perspective-video',spaceId:'space-one',files:[{id:'client-one',name:'room.mov',blob:file(),width:1920,height:1080,durationSeconds:12}],state:'draft',...extra});

function captureServer(){
  let receipt,createLost=false,chunkLost=false,dropCreate=false,dropChunk=false,targetCurrent=true;
  const calls=[],chunks=new Map();
  const handle=async(path,options)=>{
    if((path==='/v1/me/captures'||path==='/v1/spaces/space-one/captures')&&(!options.method||options.method==='GET'))return {captures:receipt?[structuredClone(receipt)]:[]};
    if(path==='/v1/spaces/space-one/captures'&&options.method==='POST'){
      calls.push({path,...options});
      receipt ||= {schema:'unseen-capture/1',captureId:'real-capture',accountId:'alice',spaceId:'space-one',sceneRevisionId:'scene-old',jobId:'reserved-job',inputMode:options.body.inputMode,title:options.body.title,status:'uploading',spaceVersion:options.version,sceneVersion:options.body.sceneIfMatchVersion,chunkBytes:3,expiresAt:'2026-10-01',targetCurrent,processingAvailable:false,registrationAvailable:false,manifestSha256:null,files:options.body.files.map((file,i)=>({...file,fileId:'file-'+i,status:'uploading',chunkCount:Math.ceil(file.bytes/3),receivedChunks:[]}))};
      if(dropCreate&&!createLost){createLost=true;throw {code:'network_error'};}return structuredClone(receipt);
    }
    if(path==='/v1/captures/real-capture')return structuredClone({...receipt,targetCurrent});
    const chunk=path.match(/^\/v1\/captures\/real-capture\/files\/([^/]+)\/chunks\/(\d+)$/);
    if(chunk){calls.push({path,...options});const item=receipt.files.find(file=>file.fileId===chunk[1]),index=Number(chunk[2]),bytes=Buffer.from(options.body.dataBase64,'base64');assert.equal(hash(bytes),options.body.sha256);chunks.set(index,bytes);item.receivedChunks.push({index,bytes:bytes.length,sha256:options.body.sha256});if(dropChunk&&!chunkLost){chunkLost=true;throw {code:'network_error'};}return structuredClone(item);}
    if(path.match(/^\/v1\/captures\/real-capture\/files\/[^/]+\/commits$/)){const item=receipt.files.find(file=>path.includes('/files/'+file.fileId+'/'));assert.equal(item.receivedChunks.length,item.chunkCount);item.status='uploaded';return structuredClone(receipt);}
    if(path==='/v1/captures/real-capture/commits'){receipt.status='uploaded';receipt.manifestSha256='a'.repeat(64);return structuredClone(receipt);}
    if(path==='/v1/captures/real-capture/cancellations'){receipt.status='cancelled';return structuredClone(receipt);}
  };
  return {handle,calls,chunks,loseCreate:()=>dropCreate=true,loseChunk:()=>dropChunk=true,setTarget:value=>targetCurrent=value,getReceipt:()=>receipt};
}

test('capability is fail closed and uses capture limits rather than album limits',()=>{
  assert.equal(captureCapability(disabled).uploadAvailable,false);assert.equal(captureCapability({...enabled,processingAvailable:true}).uploadAvailable,false);assert.equal(captureCapability({...enabled,limits:{...enabled.limits,chunkBytes:1024*1024}}).uploadAvailable,false);assert.equal(captureCapability(enabled).uploadAvailable,true);
  assert.deepEqual(captureUploadIssues(localDraft(),captureCapability(enabled)),[]);
  assert.ok(captureUploadIssues(localDraft('alice',{mode:'panoramic-video'}),captureCapability(enabled)).some(issue=>issue.includes('2:1')));
});

test('streamed original hashes match native SHA-256 across block and slice boundaries',async()=>{
  for(const size of [0,1,3,55,56,63,64,65,1000000,1048577]){const bytes=Buffer.alloc(size,42);assert.equal(await captureDigest(new Blob([bytes])),hash(bytes));}
  const abort=new AbortController();abort.abort();await assert.rejects(captureDigest(new Blob(['preserved']),{signal:abort.signal}),error=>error.name==='AbortError');
});

test('disabled service saves original bytes locally and never creates an upload or queued job',async()=>{
  const h=captureHarness();await h.mount();await h.select([file()]);const saved=[...h.db.values()].find(row=>row.files.length);assert.equal(await saved.files[0].blob.text(),'exact original video');assert.equal(saved.files[0].width,1920);assert.equal(h.unload().prevented,undefined);assert.match(h.root.innerHTML,/采集上传尚未开放/);assert.equal(h.root.querySelector('[data-capture-action="upload"]'),null);assert.equal(h.calls.some(call=>call.method==='POST'||call.method==='PUT'),false);assert.equal(h.urls.length,h.revoked.length);
});

test('guest drafts are read-only after login until an explicit new-ID copy preserves the original',async()=>{
  const original=localDraft('guest'),h=captureHarness({saved:[original]});await h.mount('capture-space?draft='+original.id);assert.equal(h.root.querySelector('[data-capture-files]'),null);assert.equal(h.writes.length,0);await h.click('[data-capture-action="claim"]');const copy=[...h.db.values()].find(row=>row.accountId==='alice');assert.ok(copy);assert.notEqual(copy.id,original.id);assert.equal(copy.spaceId,null);assert.equal(copy.consent,false);assert.equal(await copy.files[0].blob.text(),await original.files[0].blob.text());assert.deepEqual(h.db.get(original.id),structuredClone(original));assert.equal(h.calls.some(call=>call.method==='POST'),false);
});

test('account lists separate the guest section and hide another account originals',async()=>{
  const h=captureHarness({saved:[localDraft('alice'),localDraft('bob'),localDraft('guest')]});await h.mount('capture-tasks');assert.match(h.root.innerHTML,/alice 的采集/);assert.match(h.root.innerHTML,/这个浏览器的访客草稿/);assert.doesNotMatch(h.root.innerHTML,/bob 的采集/);
});

test('selecting a file then leaving during metadata decode keeps the raw local recovery draft',async()=>{
  const waiting=deferred(),h=captureHarness({metadata:()=>waiting.promise});await h.mount();const selection=h.select([file()]);await flush();const raw=[...h.db.values()][0];assert.equal(await raw.files[0].blob.text(),'exact original video');h.capture.destroy();h.account('bob');await h.mount('capture-tasks');waiting.resolve();await selection;assert.doesNotMatch(h.root.innerHTML,/room.mov/);assert.equal(h.writes.some(row=>row.accountId==='bob'),false);assert.equal(h.urls.length,h.revoked.length);
});

test('failed disk storage retains recoverable bytes and blocks refresh while allowing explicit in-app leave',async()=>{
  let failing=true;const h=captureHarness({write:()=>{if(failing)throw Error('QuotaExceeded');}});await h.mount();await h.select([file()]);assert.match(h.root.innerHTML,/本机保存失败/);assert.equal(h.unload().prevented,true);await h.click('[data-spatial-route="capture-tasks"]');await flush();assert.equal(h.routes.length,0);assert.ok(h.root.querySelector('[data-capture-action="leave"]'));await h.click('[data-capture-action="leave"]');assert.deepEqual(h.routes,['capture-tasks']);h.capture.destroy();await h.mount('capture-tasks');assert.match(h.root.innerHTML,/本页恢复记录/);const open=h.root.querySelector('[data-capture-open]');await h.mount('capture-space?draft='+open.dataset.captureOpen);failing=false;await h.submit();assert.equal(await [...h.db.values()][0].files[0].blob.text(),'exact original video');assert.equal(h.unload().prevented,undefined);
});

test('parallel edits to a saved draft fork independently and leave the saved original intact',async()=>{
  const original=localDraft(),db=new Map([[original.id,structuredClone(original)]]),a=captureHarness({db}),b=captureHarness({db});await a.mount('capture-space?draft='+original.id);await b.mount('capture-space?draft='+original.id);await a.input('title','第一页的新名称');await a.submit();await b.input('title','第二页的新名称');await b.submit();assert.equal(db.size,3);assert.equal(db.get(original.id).title,original.title);assert.ok([...db.values()].some(row=>row.title==='第一页的新名称'));assert.ok([...db.values()].some(row=>row.title==='第二页的新名称'));
});

test('ordinary video is never silently reinterpreted as panoramic input',async()=>{
  const h=captureHarness({saved:[localDraft('alice',{mode:'panoramic-video'})]});await h.mount('capture-space?draft=capture-saved-alice');await h.click('[data-capture-mode="panoramic-images"]');assert.match(h.root.innerHTML,/另开另一种采集/);assert.equal(h.db.get('capture-saved-alice').mode,'panoramic-video');
});

test('explicit upload preserves exact bytes and ends as uploaded without any registration request',async()=>{
  const server=captureServer(),h=captureHarness({saved:[localDraft()],capabilities:enabled,handle:server.handle});await h.mount('capture-space?draft=capture-saved-alice');h.root.querySelector('[data-capture-upload-consent]').checked=true;await h.click('[data-capture-action="upload"]');assert.match(h.root.innerHTML,/原片已经完整上传，真实训练尚未开放/);assert.equal(Buffer.concat([...server.chunks.entries()].sort(([a],[b])=>a-b).map(([,bytes])=>bytes)).toString(),'exact original video');assert.equal(h.calls.some(call=>/registrations|scene-jobs|world/.test(call.path)),false);assert.equal(h.calls.filter(call=>call.path==='/v1/spaces/space-one/captures').length,1);assert.equal(h.db.get('capture-saved-alice').capture,undefined,'previous saved draft stays intact');
});

test('lost chunk response resumes by server hash receipt and sends only missing chunks',async()=>{
  const server=captureServer();server.loseChunk();const h=captureHarness({saved:[localDraft()],capabilities:enabled,handle:server.handle});await h.mount('capture-space?draft=capture-saved-alice');h.root.querySelector('[data-capture-upload-consent]').checked=true;await h.click('[data-capture-action="upload"]');assert.equal(server.getReceipt().status,'uploading');await h.click('[data-capture-action="upload"]');assert.equal(server.getReceipt().status,'uploaded');assert.equal(server.calls.filter(call=>call.path.endsWith('/chunks/0')).length,1,'acknowledged first chunk is not sent again');assert.equal(server.calls.filter(call=>call.path.endsWith('/captures')).length,1);
});

test('lost create response replays the same immutable key and source manifest',async()=>{
  const server=captureServer();server.loseCreate();const h=captureHarness({saved:[localDraft()],capabilities:enabled,handle:server.handle});await h.mount('capture-space?draft=capture-saved-alice');h.root.querySelector('[data-capture-upload-consent]').checked=true;await h.click('[data-capture-action="upload"]');assert.match(h.root.innerHTML,/结果待核对/);await h.click('[data-capture-action="upload"]');const creates=server.calls.filter(call=>call.path.endsWith('/captures'));assert.equal(creates.length,2);assert.equal(creates[0].key,creates[1].key);assert.equal(JSON.stringify(creates[0].body),JSON.stringify(creates[1].body));assert.equal(server.getReceipt().status,'uploaded');
});

test('target version change preserves the original upload without creating another capture',async()=>{
  const server=captureServer();server.loseCreate();const h=captureHarness({saved:[localDraft()],capabilities:enabled,handle:server.handle});await h.mount('capture-space?draft=capture-saved-alice');h.root.querySelector('[data-capture-upload-consent]').checked=true;await h.click('[data-capture-action="upload"]');server.setTarget(false);await h.click('[data-capture-action="upload"]');assert.match(h.root.innerHTML,/空间.*版本.*变化/);assert.equal(server.calls.some(call=>call.path.includes('/chunks/')),false);assert.equal(new Set(server.calls.filter(call=>call.path.endsWith('/captures')).map(call=>call.key)).size,1);
});

test('an incomplete uploaded receipt cannot be shown as success',async()=>{
  const server=captureServer(),h=captureHarness({saved:[localDraft()],capabilities:enabled,handle:async(path,options)=>{const result=await server.handle(path,options);if(path==='/v1/captures/real-capture'&&result)return {...result,status:'uploaded',manifestSha256:null};return result;}});await h.mount('capture-space?draft=capture-saved-alice');h.root.querySelector('[data-capture-upload-consent]').checked=true;await h.click('[data-capture-action="upload"]');assert.match(h.root.innerHTML,/回执与这份原片不一致/);assert.doesNotMatch(h.root.innerHTML,/原片已经完整上传/);assert.equal(server.calls.some(call=>call.path.includes('/chunks/')),false);
});

test('switching accounts during a create response cannot upload chunks or attach data to the next account',async()=>{
  const server=captureServer(),waiting=deferred();const h=captureHarness({saved:[localDraft(),localDraft('bob')],capabilities:enabled,handle:async(path,options)=>{const result=await server.handle(path,options);if(path.endsWith('/captures')&&options.method==='POST'){await waiting.promise;}return result;}});await h.mount('capture-space?draft=capture-saved-alice');h.root.querySelector('[data-capture-upload-consent]').checked=true;const upload=h.click('[data-capture-action="upload"]');await flush();h.account('bob');await h.mount('capture-tasks');waiting.resolve();await upload;assert.equal(h.calls.some(call=>call.path.includes('/chunks/')),false);assert.equal(h.db.get('capture-saved-bob').capture,undefined);assert.doesNotMatch(h.root.innerHTML,/alice 的采集/);
});

test('another device lists account receipts and resumes only after matching the original bytes',async()=>{
  const server=captureServer();server.loseChunk();const first=captureHarness({saved:[localDraft()],capabilities:enabled,handle:server.handle});await first.mount('capture-space?draft=capture-saved-alice');first.root.querySelector('[data-capture-upload-consent]').checked=true;await first.click('[data-capture-action="upload"]');
  const next=captureHarness({capabilities:enabled,handle:server.handle});await next.mount('capture-tasks');assert.match(next.root.innerHTML,/账号里的原片上传记录/);await next.click('[data-capture-remote="real-capture"]');assert.match(next.root.innerHTML,/当前设备没有这份采集的原片/);const before=server.calls.length;await next.click('[data-capture-action="upload"]');assert.equal(server.calls.length,before);
  await next.select([new File(['different bytes'],'room.mov',{type:'video/quicktime'})]);assert.match(next.root.innerHTML,/回执与这份原片不一致/);assert.equal([...next.db.values()][0].files[0].blob,null);
  await next.select([file()]);assert.match(next.root.innerHTML,/原字节与服务器登记一致/);await next.click('[data-capture-action="upload"]');assert.equal(server.getReceipt().status,'uploaded');assert.equal(server.calls.filter(call=>call.path.endsWith('/captures')).length,1);assert.equal(server.calls.filter(call=>call.path.endsWith('/chunks/0')).length,1);
});

test('cancellation receipts may purge server chunks without removing the local original',async()=>{
  const server=captureServer();server.loseChunk();const h=captureHarness({saved:[localDraft()],capabilities:enabled,handle:async(path,options)=>{const result=await server.handle(path,options);if(path.endsWith('/cancellations'))for(const remote of result.files)remote.receivedChunks=[];return result;}});await h.mount('capture-space?draft=capture-saved-alice');h.root.querySelector('[data-capture-upload-consent]').checked=true;await h.click('[data-capture-action="upload"]');await h.click('[data-capture-action="cancel"]');assert.match(h.root.innerHTML,/本次上传已取消，本机原片仍保留/);const stored=[...h.db.values()].find(row=>row.capture?.status==='cancelled');assert.equal(await stored.files[0].blob.text(),'exact original video');
});

test('unsupported panorama originals stay local without being converted or admitted',async()=>{
  const h=captureHarness({capabilities:enabled});await h.mount('capture-space?mode=panoramic-images&spaceId=space-one');await h.select([new File(['first heic original'],'first.heic',{type:'image/heic'}),new File(['second heic original'],'second.heic',{type:'image/heic'})]);await h.input('title','相机原片');await h.submit();assert.match(h.root.innerHTML,/仅接收 JPEG 或 PNG 全景原片/);assert.equal(h.root.querySelector('[data-capture-action="upload"]').disabled,true);assert.equal(h.calls.some(call=>call.method==='POST'),false);assert.equal(await [...h.db.values()].find(row=>row.files.length).files[0].blob.text(),'first heic original');
});

test('reloading the actual saved URL after lost create response keeps the same immutable attempt',async()=>{
  const server=captureServer();server.loseCreate();const h=captureHarness({saved:[localDraft()],capabilities:enabled,handle:server.handle});await h.mount('capture-space?draft=capture-saved-alice');h.root.querySelector('[data-capture-upload-consent]').checked=true;await h.click('[data-capture-action="upload"]');const route=h.historyPaths.at(-1).split('#')[1],draftId=new URLSearchParams(route.split('?')[1]).get('draft');assert.ok(h.db.get(draftId).uploadAttempt);h.capture.destroy();const reloaded=captureHarness({db:h.db,capabilities:enabled,handle:server.handle});await reloaded.mount(route);await reloaded.click('[data-capture-action="upload"]');const creates=server.calls.filter(call=>call.path.endsWith('/captures'));assert.equal(creates.length,2);assert.equal(creates[0].key,creates[1].key);assert.equal(JSON.stringify(creates[0].body),JSON.stringify(creates[1].body));assert.equal(server.getReceipt().status,'uploaded');
});

test('reloading the actual URL after partial upload uses the same capture and skips acknowledged bytes',async()=>{
  const server=captureServer();server.loseChunk();const h=captureHarness({saved:[localDraft()],capabilities:enabled,handle:server.handle});await h.mount('capture-space?draft=capture-saved-alice');h.root.querySelector('[data-capture-upload-consent]').checked=true;await h.click('[data-capture-action="upload"]');const route=h.historyPaths.at(-1).split('#')[1];h.capture.destroy();const reloaded=captureHarness({db:h.db,capabilities:enabled,handle:server.handle});await reloaded.mount(route);await reloaded.click('[data-capture-action="upload"]');assert.equal(server.getReceipt().status,'uploaded');assert.equal(server.calls.filter(call=>call.path.endsWith('/captures')).length,1);assert.equal(server.calls.filter(call=>call.path.endsWith('/chunks/0')).length,1);
});

test('pause stops after the in-flight chunk and unlocks explicit cancellation',async()=>{
  const server=captureServer(),waiting=deferred();let entered=false;const h=captureHarness({saved:[localDraft()],capabilities:enabled,handle:async(path,options)=>{const result=await server.handle(path,options);if(path.endsWith('/chunks/0')&&!entered){entered=true;await waiting.promise;}return result;}});await h.mount('capture-space?draft=capture-saved-alice');h.root.querySelector('[data-capture-upload-consent]').checked=true;const upload=h.click('[data-capture-action="upload"]');await flush();assert.equal(entered,true);await h.click('[data-capture-action="pause"]');waiting.resolve();await upload;assert.match(h.root.innerHTML,/已暂停本页后续发送/);assert.equal(server.calls.filter(call=>call.path.includes('/chunks/')).length,1);await h.click('[data-capture-action="cancel"]');assert.equal(server.getReceipt().status,'cancelled');
});

test('uploaded originals can be explicitly removed while the durable local bytes remain',async()=>{
  const server=captureServer(),h=captureHarness({saved:[localDraft()],capabilities:enabled,handle:server.handle});await h.mount('capture-space?draft=capture-saved-alice');h.root.querySelector('[data-capture-upload-consent]').checked=true;await h.click('[data-capture-action="upload"]');assert.match(h.root.innerHTML,/移除服务器原片，保留本机原片/);await h.click('[data-capture-action="cancel"]');assert.equal(server.getReceipt().status,'cancelled');assert.equal(await [...h.db.values()].find(row=>row.capture?.status==='cancelled').files[0].blob.text(),'exact original video');
});
