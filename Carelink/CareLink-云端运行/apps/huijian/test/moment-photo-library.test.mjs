import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import * as library from '../public/moment-photo-library.js';
import * as data from '../public/moment-data.js';
import * as design from '../public/moment-design.js';
import * as suggestions from '../public/moment-suggestions.js';

const photo=(id,originalMediaId=`original-${id}`)=>({id,mediaId:`preview-${id}`,originalMediaId,name:`${id}.jpg`,url:`/v1/moment-media/preview-${id}`});
const record=(id,photos,{accountId='owner',archivedAt=null,messages=[]}={})=>({accountId,moment:{...data.newMoment(),id,title:`故事 ${id}`,createdAt:'2026-09-06T00:00:00.000Z',photos,messages,archivedAt}});

test('photo grid includes every photo and keeps stable originals with all source stories',()=>{
  const a=record('one',[photo('p1'),photo('p2')],{messages:[{id:'voice',role:'user',text:'当时的风',audio:{mediaId:'unaltered-audio'}}]}),copy=record('copy',[photo('p1-copy','original-p1')]);
  const before=structuredClone([a,copy]);
  const entries=library.collectLibraryPhotos([a,copy,record('other',[photo('foreign')],{accountId:'other'}),record('archived',[photo('old')],{archivedAt:'2026-09-06'})],{accountId:'owner'});
  assert.equal(entries.length,2);assert.equal(entries.find(p=>p.originalMediaId==='original-p1').stories.length,2);
  assert.deepEqual([a,copy],before,'indexing does not copy or mutate original messages/audio');
  assert.equal(entries.some(p=>p.name==='foreign.jpg'||p.name==='old.jpg'),false);
  const refs=library.selectedPhotoRefs(entries,[entries[0].key]);assert.equal(refs.length,1);
  assert.deepEqual(Object.keys(refs[0]).sort(),['accountId','key','mediaId','momentId','name','originalMediaId','photoId']);
  assert.equal(JSON.stringify(refs).includes('unaltered-audio'),false);
});

test('filters use saved month and real user words, never an AI question as user content',()=>{
  const entries=library.collectLibraryPhotos([record('one',[photo('p1')],{messages:[{role:'user',text:'当时的风'},{role:'assistant',text:'AI隐含地点'}]})],{accountId:'owner'});
  assert.equal(library.filterLibraryPhotos(entries,{query:'当时的风',month:'2026-09'}).length,1);
  assert.equal(library.filterLibraryPhotos(entries,{query:'AI隐含地点'}).length,0);
  assert.equal(library.filterLibraryPhotos(entries,{month:'2025-01'}).length,0);
});

test('grid/detail show real navigation, selection and original download without exposing raw markup',()=>{
  const p=photo('p1');p.name='<img src=x onerror=alert(1)>';p.spaceLinks=[{spaceId:'space-one',photoId:'canonical-photo'}];
  const entries=library.collectLibraryPhotos([record('one',[p])],{accountId:'owner'});
  const grid=library.photoLibraryScreen({entries,media:p=>p.url,selecting:true,selectedKeys:[entries[0].key]});
  assert.match(grid,/已选 1 张/);assert.match(grid,/加入空间/);assert.equal(grid.includes('<img src=x'),false);
  const detail=library.photoDetailScreen({entry:entries[0],index:0,total:1,media:p=>p.url,originalUrl:'blob:original',originalDisplay:true});
  assert.match(detail,/data-photo-step="-1" disabled/);assert.match(detail,/data-photo-step="1" disabled/);
  assert.match(detail,/src="blob:original"/);assert.match(detail,/shared-space\/space-one\?tab=photos&amp;photoId=canonical-photo|shared-space\/space-one\?tab=photos&photoId=canonical-photo/);
  assert.match(detail,/查看已有故事（0）/);assert.match(library.photoCaptureScreen(),/保存不需要先回答 AI/);
});

const source=(await fs.readFile(new URL('../public/moment-app.js',import.meta.url),'utf8')).replace(/^import .*\n/gm,'').split("root.addEventListener('click'")[0].replace("import('./moment-photo-stories.js')",'loadStoryModule()').replace("import('./moment-shared-spaces.js')",'loadSpaceModule()');
function appHarness(){
  const documents=new Map(),media=new Map(),requests=[],notices=[],routes=[],storyMounts=[],spaceMounts=[],captions=[];let renderCalls=0;let requestHandler,resolveMedia,storyLoader,destroyedStories=0;
  const cache={async put(owner,value){documents.set(`${owner}:${value.moment.id}`,structuredClone(value));return {cacheVersion:1};},async list(owner){return [...documents.entries()].filter(([key])=>key.startsWith(owner+':')).map(([,value])=>value);},async get(owner,id){return documents.get(`${owner}:${id}`);},async putMedia(owner,id,blob,meta){media.set(`${owner}:${id}`,{blob,...meta});},async getMedia(owner,id){return resolveMedia?resolveMedia(owner,id):media.get(`${owner}:${id}`);}};
  class Api{constructor(){this.abort=new AbortController();}setAccount(id){this.accountId=id;}async request(path,options={}){requests.push({path,...options});if(requestHandler)return requestHandler(path,options);throw Error('Unexpected request '+path);}}
  const storyNode={innerHTML:''},spaceNode={innerHTML:''},shareNode={innerHTML:''},linkedNode={innerHTML:''},storyShareNodes=[],joinNode={focusCount:0,focus(){this.focusCount++;}};
  const node={querySelector:selector=>({'[data-photo-share-entry]':shareNode,'[data-photo-linked-spaces]':linkedNode,'[data-action="join-library-photo"]':joinNode}[selector]||null),querySelectorAll:selector=>selector==='[data-photo-sync]'?captions:selector==='[data-photo-story-share]'?storyShareNodes:[],replaceChildren(){this.innerHTML='';},style:{setProperty(){}},classList:{add(){},remove(){}},addEventListener(){}};
  const dialog={...node,querySelector:selector=>selector==='#photo-story-picker'&&dialog.innerHTML?.includes('id="photo-story-picker"')?storyNode:selector==='#photo-space-picker'&&dialog.innerHTML?.includes('id="photo-space-picker"')?spaceNode:null};
  const context=vm.createContext({...data,...design,...library,...suggestions,console,Blob,File,URL,AbortController,AbortSignal,DOMException,structuredClone,setTimeout,clearTimeout,navigator:{onLine:true},document:{querySelector:selector=>selector==='#moment-dialog'?dialog:node,hidden:false,activeElement:joinNode},window:{},location:{hash:'',pathname:'/app'},history:{replaceState(){},pushState(){}},localStorage:{getItem:()=>null},MomentApi:Api,openMomentCache:()=>cache,blobToDataUrl:async blob=>'data:'+blob.type+';base64,'+Buffer.from(await blob.arrayBuffer()).toString('base64'),preparePhoto:async file=>({preview:new Blob(['JPEG display'],{type:'image/jpeg'}),width:100,height:100}),createMomentVoice:()=>({getState:()=>({phase:'idle'}),cancel(){},finish:async()=>true}),createTurnVoicePlayer:()=>({stop(){},prepare(){},speak:async()=>true}),mountMomentParticles:()=>({}),spatialRoutes:()=>false,fetchExamples:async()=>({examples:[]}),notice:text=>notices.push(text),route:value=>routes.push(value),rendered:()=>renderCalls++,loadSpaceModule:()=>Promise.resolve({mountPhotoSpacePicker:(root,options)=>{spaceMounts.push(options);return {destroy(){},ready:Promise.resolve()};}}),loadStoryModule:()=>storyLoader?storyLoader():Promise.resolve({mountPhotoStoryPicker:(root,options)=>{storyMounts.push(options);return {destroy(){destroyedStories++;},ready:Promise.resolve()};}})});
  vm.runInContext(source+`\nrender=rendered;updateChat=()=>{};updateComposer=()=>{};stopAll=async()=>{};toast=notice;setRoute=route;globalThis.h={s,records,selected,api,readLibraryPhoto,loadPhotoRecords,libraryPhotos,restoreRecord,openLibraryPhoto,talkLibraryPhoto,clearPhotoDetail,selectedLibraryPhotos,libraryPhotoDetail,onAction,isSpatialRoute,savePhotoContributions,shareLibraryPhotoStory,closeDialog,joinLibraryPhotos,updatePhotoSync,updatePhotoAssociations};`,context);
  return {h:context.h,cache,documents,media,requests,notices,routes,context,setHandler:fn=>requestHandler=fn,setMediaReader:fn=>resolveMedia=fn,storyMounts,setStoryLoader:fn=>storyLoader=fn,getDestroyedStories:()=>destroyedStories,spaceMounts,captions,shareNode,linkedNode,storyShareNodes,joinNode,getRenderCalls:()=>renderCalls};
}

test('a new guest saves multiple original photos durably without any AI/network request',async()=>{
  const a=appHarness();a.h.s.user={id:data.GUEST_ACCOUNT};a.h.s.view='capture';a.h.s.chooseFresh=true;
  const files=[new File(['first original'],'first.jpg',{type:'image/jpeg'}),new File(['second original'],'second.jpg',{type:'image/jpeg'})];
  await a.h.selected(files);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(a.h.s.view,'library');assert.equal(a.h.s.libraryMode,'photos');assert.equal(a.h.s.record.moment.photos.length,2);assert.equal(a.h.s.record.moment.messages.length,0);
  assert.equal(a.requests.length,0);assert.equal(a.h.libraryPhotos().length,2);
  for(const [i,p] of a.h.s.record.moment.photos.entries())assert.equal(await a.media.get(`${data.GUEST_ACCOUNT}:${p.originalMediaId}`).blob.text(),await files[i].text());
  const reloaded=await a.cache.list(data.GUEST_ACCOUNT);assert.equal(reloaded[0].moment.photos.length,2);assert.equal(reloaded[0].moment.messages.length,0);
});

test('another authorized session loads all photos rather than only list covers',async()=>{
  const a=appHarness(),m=record('remote',[photo('one'),photo('two')]);a.h.s.user={id:'owner'};a.h.s.items=[{id:'remote',version:3,photoCount:2}];a.h.s.view='library';
  a.setHandler(async(path,options)=>{assert.equal(path,'/v1/moments/remote');assert.equal(options.accountId,'owner');return {moment:m.moment,version:3};});
  await a.h.loadPhotoRecords();assert.equal(a.h.libraryPhotos().length,2);assert.equal((await a.cache.get('owner','remote')).moment.photos.length,2);
});

test('photo loading cannot overwrite an edited draft or land after an account change',async()=>{
  const a=appHarness(),local={...record('edited',[photo('local')]),dirty:true,version:1,revision:2};a.h.s.user={id:'owner'};a.h.s.items=[{id:'edited',version:5}];a.h.records.set('edited',local);
  await a.h.loadPhotoRecords();assert.equal(a.requests.length,0);assert.equal(local.moment.photos[0].id,'local');
  let release;a.h.s.items=[{id:'remote',version:1}];a.setHandler(()=>new Promise(resolve=>release=resolve));const pending=a.h.loadPhotoRecords();await new Promise(resolve=>setImmediate(resolve));a.h.s.epoch++;a.h.s.user={id:'other'};a.h.records.clear();release({moment:record('remote',[photo('private')]).moment,version:1});await pending;
  assert.equal(a.h.records.size,0);assert.equal(a.h.libraryPhotos().length,0);
});

test('sharing reads exactly the selected original and rejects a delayed old-account result',async()=>{
  const a=appHarness(),r={...record('one',[photo('p1')]),dirty:false,version:1};a.h.s.user={id:'owner'};a.h.records.set('one',r);a.h.s.items=[{id:'one'}];const entry=a.h.libraryPhotos()[0];
  await a.cache.putMedia('owner','original-p1',new Blob(['true original'],{type:'image/heic'}));await a.cache.putMedia('owner','preview-p1',new Blob(['display copy'],{type:'image/jpeg'}));
  assert.equal(await (await a.h.readLibraryPhoto(entry)).text(),'true original');
  let release;a.setMediaReader(()=>new Promise(resolve=>release=resolve));const pending=a.h.readLibraryPhoto(entry);await new Promise(resolve=>setImmediate(resolve));a.h.s.epoch++;a.h.s.user={id:'other'};release({blob:new Blob(['late original'])});await assert.rejects(pending,error=>error.name==='AbortError');
});

test('photo detail moves through real photos and revokes the previous original URL',async()=>{
  const a=appHarness(),r=record('one',[photo('p1'),photo('p2')],{accountId:data.GUEST_ACCOUNT});a.h.s.user={id:data.GUEST_ACCOUNT};a.h.records.set('one',r);a.h.s.view='library';
  for(const p of r.moment.photos)await a.cache.putMedia(data.GUEST_ACCOUNT,p.originalMediaId,new Blob([p.id],{type:'image/jpeg'}));
  const entries=a.h.libraryPhotos();await a.h.openLibraryPhoto(entries[0].key);const original=a.h.libraryPhotoDetail().match(/src="(blob:[^"]+)"/)[1];assert.equal(await (await fetch(original)).text(),'p1');
  await a.h.onAction({target:{closest:()=>({dataset:{photoStep:'1'}})}});assert.equal(a.h.s.libraryPhotoKey,entries[1].key);await assert.rejects(fetch(original));
  const next=a.h.libraryPhotoDetail().match(/src="(blob:[^"]+)"/)[1];assert.equal(await (await fetch(next)).text(),'p2');a.h.clearPhotoDetail();await assert.rejects(fetch(next));
});

test('talking about an existing photo selects that photo while preserving its story and original audio',async()=>{
  const a=appHarness(),r={...record('one',[photo('p1'),photo('p2')],{accountId:data.GUEST_ACCOUNT,messages:[{id:'voice',role:'user',text:'我自己的话',photoId:'p2',createdAt:'2026-09-06',audio:{mediaId:'original-voice'}}]}),version:0,revision:1,dirty:true,uploads:[]};r.moment.status='complete';a.h.s.user={id:data.GUEST_ACCOUNT};a.h.s.view='photo';a.h.records.set('one',r);a.h.s.libraryPhotoKey=`${data.GUEST_ACCOUNT}|original-p2`;const before=structuredClone(r.moment.messages);
  await a.h.talkLibraryPhoto();await new Promise(resolve=>setImmediate(resolve));assert.equal(a.h.s.view,'chat');assert.equal(a.h.s.photoIndex,1);assert.equal(a.h.s.review,false);assert.equal(a.h.records.size,1);assert.deepEqual(r.moment.messages,before);assert.equal(a.requests.length,0);
});

test('new capture and sharing deep links are recognized without losing legacy routing',()=>{
  const a=appHarness();for(const hash of ['#shared-space/space-one?tab=photos','#join/token','#capture-space?kind=phone','#capture-tasks','#world-create?spaceId=one','#tasks?archived=1'])assert.equal(a.h.isSpatialRoute(hash),true,hash);
});

test('space receipts attach only selected photo links and preserve original media and private speech',async()=>{
  const a=appHarness(),r={...record('one',[photo('p1'),photo('p2')],{accountId:data.GUEST_ACCOUNT,messages:[{role:'user',text:'私人讲述',audio:{mediaId:'private-voice'}}]}),dirty:true,revision:1,version:0};a.h.s.user={id:data.GUEST_ACCOUNT};a.h.records.set('one',r);const refs=library.selectedPhotoRefs(a.h.libraryPhotos(),[`${data.GUEST_ACCOUNT}|original-p2`]),before=structuredClone(r.moment);
  const result={spaceId:'actual-space',contributions:[{refKey:refs[0].key,photoId:'canonical-photo'},{refKey:'unselected',photoId:'must-ignore'}]};
  await a.h.savePhotoContributions(refs,result);await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(r.moment.photos[0],before.photos[0]);assert.equal(r.moment.photos[1].originalMediaId,before.photos[1].originalMediaId);assert.equal(r.moment.photos[1].spaceLinks[0].photoId,'canonical-photo');assert.deepEqual(r.moment.messages,before.messages);
  await a.h.savePhotoContributions(refs,result);assert.equal(r.moment.photos[1].spaceLinks.length,1,'receipt replay does not duplicate links');
  assert.equal((await a.cache.get(data.GUEST_ACCOUNT,'one')).moment.photos[1].spaceLinks[0].spaceId,'actual-space');assert.equal(a.requests.length,0);
});


test('photo detail offers explicit sharing per source story and explains the photo-first prerequisite',()=>{
  const linked=photo('p1');linked.spaceLinks=[{spaceId:'space-one',photoId:'actual-photo'}];
  const entries=library.collectLibraryPhotos([record('one',[linked],{messages:[{role:'user',text:'one'}]}),record('copy',[photo('copied','original-p1')],{messages:[{role:'user',text:'copy'}]})],{accountId:'owner'});
  const detail=library.photoDetailScreen({entry:entries[0],index:0,total:1,media:p=>p.url});
  assert.match(detail,/data-action="share-photo-story"/);assert.match(detail,/data-share-photo-story="one" data-story-photo="p1"/);assert.match(detail,/data-share-photo-story="copy" data-story-photo="copied"/);
  const guest=library.photoDetailScreen({entry:entries[0],index:0,total:1,media:p=>p.url,guest:true});assert.doesNotMatch(guest,/data-share-photo-story|data-action="share-photo-story"/);
  entries[0].spaceLinks=[];assert.match(library.photoDetailScreen({entry:entries[0],index:0,total:1,media:p=>p.url}),/先把照片加入空间/);
});

test('the story picker receives explicit source IDs and space receipts without any private speech payload',async()=>{
  const a=appHarness(),p=photo('p1');p.spaceLinks=[{spaceId:'space-one',photoId:'actual-photo'}];
  const r=record('one',[p],{messages:[{id:'voice',role:'user',text:'私人故事',audio:{mediaId:'raw-voice'}}]}),copy=record('copy',[photo('copied','original-p1')],{messages:[{role:'user',text:'副本里的故事'}]});
  a.h.s.user={id:'owner'};a.h.s.items=[{id:'one'},{id:'copy'}];a.h.records.set('one',r);a.h.records.set('copy',copy);a.h.s.view='photo';a.h.s.libraryPhotoKey='owner|original-p1';const before=structuredClone(r.moment);
  await a.h.onAction({target:{closest:()=>({dataset:{sharePhotoStory:'copy',storyPhoto:'copied'}})}});
  assert.equal(a.storyMounts.length,1);const options=a.storyMounts[0];assert.deepEqual(JSON.parse(JSON.stringify(options.source)),{momentId:'copy',photoId:'copied'});assert.deepEqual(JSON.parse(JSON.stringify(options.spaceLinks)),[{spaceId:'space-one',photoId:'actual-photo'}]);assert.equal(Object.hasOwn(options,'messages'),false);assert.equal(Object.hasOwn(options,'readAudio'),false);assert.equal(a.requests.length,0);assert.deepEqual(r.moment,before);
  options.onComplete({storyId:'server-receipt'});assert.match(a.notices.at(-1),/明确选择/);a.h.closeDialog();assert.equal(a.getDestroyedStories(),1);options.onComplete({storyId:'late'});assert.equal(a.notices.length,1,'closed surface cannot display late success');
});

test('unlinked or unsaved stories cannot silently publish an older cloud copy',async()=>{
  const a=appHarness(),r=record('one',[photo('p1')]);a.h.s.user={id:'owner'};a.h.s.items=[{id:'one'}];a.h.records.set('one',r);a.h.s.libraryPhotoKey='owner|original-p1';await a.h.shareLibraryPhotoStory();assert.match(a.notices.at(-1),/先把这张照片加入空间/);assert.equal(a.storyMounts.length,0);
  r.moment.photos[0].spaceLinks=[{spaceId:'space-one',photoId:'actual-photo'}];r.dirty=true;r.cloudMedia=[{mediaId:'pending-audio'}];await a.h.shareLibraryPhotoStory();assert.match(a.notices.at(-1),/先完成这份回忆的账号保存/);assert.equal(a.storyMounts.length,0);assert.equal(a.requests.length,0);
});

test('a closed or switched-account dialog cannot mount a late-loaded story picker',async()=>{
  for(const switchAccount of [false,true]){const a=appHarness(),p=photo('p1');p.spaceLinks=[{spaceId:'space-one',photoId:'actual-photo'}];const r=record('one',[p]);a.h.s.user={id:'owner'};a.h.s.items=[{id:'one'}];a.h.records.set('one',r);a.h.s.libraryPhotoKey='owner|original-p1';let resolve,mounted=0;a.setStoryLoader(()=>new Promise(done=>resolve=done));const loading=a.h.shareLibraryPhotoStory();await new Promise(done=>setImmediate(done));if(switchAccount){a.h.s.epoch++;a.h.s.user={id:'other'};}else a.h.closeDialog();resolve({mountPhotoStoryPicker(){mounted++;return {destroy(){}};}});await loading;assert.equal(mounted,0);}
});


test('signed multi-photo save waits for the document receipt and clears live pending badges without replacing controls',async()=>{
  const a=appHarness();a.h.s.user={id:'owner'};a.h.s.view='capture';a.h.s.chooseFresh=true;let release,first=true,version=0;
  a.setHandler(async(path,options)=>{
    if(path.startsWith('/v1/moment-media/'))return {media:{id:path.split('/').at(-1),url:path}};
    if(path.startsWith('/v1/moments/')&&options.method==='PUT'){if(first){first=false;await new Promise(resolve=>release=resolve);}return {moment:structuredClone(options.body.moment),version:++version};}
    throw Error('Unexpected request '+path);
  });
  const saving=a.h.selected([new File(['original one'],'one.jpg',{type:'image/jpeg'}),new File(['original two'],'two.jpg',{type:'image/jpeg'})]);
  for(let n=0;n<10&&(!release||a.h.s.record?.moment.photos.length!==2);n++)await new Promise(resolve=>setImmediate(resolve));
  assert.ok(release);assert.equal(a.h.s.record.moment.photos.length,2);assert.equal(a.notices.length,0,'no stale pending toast before awaiting the actual receipt');
  for(const entry of a.h.libraryPhotos())a.captions.push({dataset:{photoSync:entry.key},textContent:library.photoLibraryCaption(entry)});
  assert.ok(a.captions.every(node=>node.textContent.includes('待同步')));const nodes=[...a.captions];release();await saving;
  assert.equal(a.h.s.record.dirty,false);assert.equal(a.h.s.record.saving,false);assert.ok(a.captions.every(node=>!node.textContent.includes('待同步')));assert.equal(a.captions[0],nodes[0],'caption text updated in place');assert.match(a.notices.at(-1),/照片已保存/);assert.doesNotMatch(a.notices.at(-1),/仍在同步/);assert.equal(a.requests.some(request=>request.path.includes('chat')),false);
});

test('successful photo contribution updates sharing regions immediately while keeping the source button and original URL',async()=>{
  const a=appHarness(),r={...record('one',[photo('p1')],{messages:[{id:'words',role:'user',text:'我的原话',photoId:'p1'}]}),version:1,revision:1,dirty:false,uploads:[]};a.h.s.user={id:'owner'};a.h.s.items=[{id:'one',version:1}];a.h.records.set('one',r);await a.cache.putMedia('owner','original-p1',new Blob(['unchanged original'],{type:'image/jpeg'}));a.setHandler(async(path,options)=>{if(path==='/v1/moments/one'&&options.method==='PUT')return {moment:structuredClone(options.body.moment),version:2};throw Error('Unexpected request '+path);});
  await a.h.openLibraryPhoto('owner|original-p1');const originalUrl=a.h.libraryPhotoDetail().match(/src="(blob:[^"]+)"/)[1];const entry=a.h.libraryPhotos()[0],parts=library.photoDetailAssociations(entry);a.shareNode.innerHTML=parts.shareHtml;a.linkedNode.innerHTML=parts.spacesHtml;a.storyShareNodes.push({dataset:{photoStoryShare:'one|p1'},innerHTML:''});
  await a.h.joinLibraryPhotos(library.selectedPhotoRefs([entry],[entry.key]));assert.equal(a.spaceMounts.length,1);assert.match(a.linkedNode.innerHTML,/先把照片加入空间/);const renders=a.getRenderCalls(),sourceButton=a.joinNode;
  await a.spaceMounts[0].onComplete({spaceId:'real-space',contributions:[{refKey:entry.key,photoId:'real-photo'}]});
  assert.match(a.shareNode.innerHTML,/选择故事与原声分享/);assert.match(a.linkedNode.innerHTML,/shared-space\/real-space/);assert.doesNotMatch(a.linkedNode.innerHTML,/先把照片加入空间/);assert.match(a.storyShareNodes[0].innerHTML,/data-share-photo-story="one"/);assert.equal(a.getRenderCalls(),renders,'receipt updates only association regions');assert.equal(a.joinNode,sourceButton);a.h.closeDialog();assert.equal(sourceButton.focusCount,1);assert.equal(await (await fetch(originalUrl)).text(),'unchanged original');a.h.clearPhotoDetail();
});


test('failed document save keeps originals and reports an actionable unsaved state instead of claiming work is still running',async()=>{
  const a=appHarness();a.h.s.user={id:'owner'};a.h.s.view='capture';a.h.s.chooseFresh=true;
  a.setHandler(async(path)=>{if(path.startsWith('/v1/moment-media/'))return {media:{id:path.split('/').at(-1),url:path}};if(path.startsWith('/v1/moments/'))throw {code:'network_error',status:503};throw Error('Unexpected request');});
  await a.h.selected([new File(['preserved when save fails'],'kept.jpg',{type:'image/jpeg'})]);assert.equal(a.h.s.record.dirty,true);assert.equal(a.h.s.record.saving,false);assert.match(a.notices.at(-1),/账号保存未完成.*刷新重试/);assert.doesNotMatch(a.notices.at(-1),/仍在同步|照片已保存/);const p=a.h.s.record.moment.photos[0];assert.equal(await a.media.get('owner:'+p.originalMediaId).blob.text(),'preserved when save fails');
});
