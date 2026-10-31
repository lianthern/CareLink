import test from 'node:test';
import assert from 'node:assert/strict';
import {sharedRoute,sharedInvitationUrl,sharedSceneOptions,mountPhotoSpacePicker,createMomentSharedSpaces} from '../public/moment-shared-spaces.js';
import {batchDigest,sharedDigest,sharedTicket,validateSharedFiles,sharedPhotoFile,SharedUpload} from '../public/moment-shared-upload.js';
const root=()=>({innerHTML:'',listeners:new Map(),addEventListener(n,f){this.listeners.set(n,f);},removeEventListener(n){this.listeners.delete(n);},querySelector(){return null;}});
test('shared routes keep canonical space, selected photo and invitation token separate',()=>{
 assert.deepEqual(sharedRoute('shared-space/space-one?tab=scene&photo=photo-two'),{spaceId:'space-one',token:null,tab:'scene',photoId:'photo-two'});
 assert.deepEqual(sharedRoute('join/campaign-token?tab=upload'),{spaceId:null,token:'campaign-token',tab:'upload',photoId:null});
 for(const path of ['space/client-id','shared-space/../other','join/<img>'])assert.throws(()=>sharedRoute(path));
 const url=sharedInvitationUrl({publicCampaignUrl:'https://core.test/open/abcdefghijklmnopqrstuvwx'},'https://app.test');assert.equal(url,'https://app.test/app#join/abcdefghijklmnopqrstuvwx');
 assert.throws(()=>sharedInvitationUrl({publicCampaignUrl:'https://core.test/open#invite=secret'},'https://app.test'));
});
test('shared scene uses original depth encoding and authorized invitation resources',()=>{
 const metadata={schemaVersion:'unseen-depth-import/1',metadata:{model:'DAP',source_image:'room.png'}};
 const result=sharedSceneOptions({panorama:{url:'/v1/viewer/spaces/s/panorama-revisions/p/media'},depthImport:{url:'/v1/viewer/spaces/s/panorama-revisions/p/depth-map',panoramaName:'original-room.png',metadata},placement:{yawDeg:60,pitchDeg:10}},{invitation:true});
 assert.equal(result.kind,'dap');assert.equal(result.panoramaName,'original-room.png');assert.equal(result.depthMetadata,metadata);assert.equal(result.initialYaw,60);assert.ok(result.panorama.endsWith('?access=invitation'));assert.ok(result.depth.endsWith('?access=invitation'));
 assert.equal(sharedSceneOptions({panorama:{url:'https://evil.test/private'}}),null);
 assert.equal(sharedSceneOptions({panorama:{url:'/v1/viewer/spaces/s/panorama-revisions/p/media'}}).kind,'360');
});
test('selection validates live photo limits and retains original bytes and MIME',async()=>{
 const file=sharedPhotoFile(new Blob(['original'],{type:'image/heic'}),'room.heic');assert.equal(file.type,'image/heic');assert.equal(await file.text(),'original');
 const context={limits:{batchItems:2,photoBytes:8},photoFormats:['image/heic']};validateSharedFiles([file],context);
 for(const files of [[],[file,file,file],[new File(['too many bytes'],'a.heic',{type:'image/heic'})],[new File(['x'],'a.png',{type:'image/png'})]])assert.throws(()=>validateSharedFiles(files,context));
});
test('canonical item digest uses raw item versions in row order; tickets bind exact object and never cookies',async()=>{
 const items=[{itemId:'a',status:'committed',itemVersion:3,failureCode:null},{itemId:'b',status:'failed',itemVersion:4,failureCode:'bad'}];
 assert.equal(await batchDigest(items),await sharedDigest('[{"failureCode":null,"itemId":"a","status":"committed","version":3},{"failureCode":"bad","itemId":"b","status":"failed","version":4}]'));
 assert.notEqual(await batchDigest(items),await batchDigest([...items].reverse()));
 assert.equal(sharedTicket({exactPrivateObjectKey:'private/a',oneTimeUploadTicket:{url:'https://core.test/__local/media/private/a',headers:{'x-upload-ticket':'synthetic'}}},'https://app.test').url,'/__local/media/private/a');
 assert.throws(()=>sharedTicket({exactPrivateObjectKey:'private/b',oneTimeUploadTicket:{url:'https://core.test/private/a',headers:{}}}));
});
test('guest photo picker makes no account or media requests and never claims drafts',async()=>{
 const element=root();let requests=0;const picker=mountPhotoSpacePicker(element,{api:{request(){requests++;}},user:()=>({id:'guest-local'}),refs:[{key:'g',accountId:'guest-local'}],readPhoto(){requests++;}});
 await picker.ready;assert.equal(requests,0);assert.match(element.innerHTML,/先把照片保存到账号/);picker.destroy();assert.equal(element.listeners.size,0);
});
test('account switch after pending picker list cannot expose old account space names',async()=>{
 const element=root();let user={id:'a'},resolve;const picker=mountPhotoSpacePicker(element,{api:{request:()=>new Promise(r=>resolve=r)},user:()=>user,refs:[{key:'a',accountId:'a'}]});
 user={id:'b'};resolve({spaces:[{name:'PRIVATE ACCOUNT A',spaceId:'s',owner:true,spaceLifecycle:'active',collectionState:'open'}]});await picker.ready;
 assert.doesNotMatch(element.innerHTML,/PRIVATE ACCOUNT A/);picker.destroy();
});
test('destroyed shared surface rejects late account list and removes handlers',async()=>{
 const element=root();let resolve;const surface=createMomentSharedSpaces({api:{request:()=>new Promise(r=>resolve=r)},user:()=>({id:'owner'}),guest:()=>false});
 const loading=surface.mount(element,'shared-space/space-one');surface.destroy();resolve({spaces:[{name:'LATE PRIVATE CONTENT',spaceId:'space-one'}]});await loading;
 assert.doesNotMatch(element.innerHTML,/LATE PRIVATE CONTENT/);assert.equal(element.listeners.size,0);
});
test('revoked invitation reports its own expiry with an account present and never falls back to that account',async()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');
 Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:()=>JSON.stringify({spaceId:'space-one',tasks:['view'],name:'Shared room'})}});
 try{for(const invitation of [true,false]){
  const element=root(),calls=[],surface=createMomentSharedSpaces({api:{request:async(path,options)=>{calls.push({path,accountId:options.accountId});throw {code:'session_unavailable'};}},user:()=>({id:'signed-in-owner'}),guest:()=>false});
  try{await surface.mount(element,invitation?'join/campaign-token?tab=scene':'shared-space/space-one');
   assert.equal(calls.length,1,'a rejected invitation cannot retry through the signed-in account');
   if(invitation){assert.deepEqual(calls[0],{path:'/v1/viewer/spaces/space-one?access=invitation',accountId:null});assert.match(element.innerHTML,/邀请现在无法打开，请向空间主人确认/);assert.doesNotMatch(element.innerHTML,/请登录原账号/);}
   else{assert.deepEqual(calls[0],{path:'/v1/me/spaces',accountId:'signed-in-owner'});assert.match(element.innerHTML,/请登录原账号后继续/);}
  }finally{surface.destroy();}
 }}finally{if(previous)Object.defineProperty(globalThis,'sessionStorage',previous);else delete globalThis.sessionStorage;}
});
test('cancelled upload never starts a remote mutation',async()=>{
 const controller=new AbortController();controller.abort();let calls=0;
 const upload=new SharedUpload({request:()=>{calls++;},spaceId:'s',identityKey:'a',signal:controller.signal,storage:null});
 await assert.rejects(upload.start([new File(['x'],'a.png',{type:'image/png'})],{limits:{batchItems:2,photoBytes:5},photoFormats:['image/png']}),{name:'AbortError'});assert.equal(calls,0);
});
test('default browser transport retains Window/global fetch receiver',async()=>{
 const previous=globalThis.fetch;let seen=false;globalThis.fetch=function(){assert.equal(this,globalThis,'native browser fetch requires its global receiver');seen=true;return Promise.resolve(new Response('{}'));};
 try{const upload=new SharedUpload({request:()=>{},spaceId:'s',identityKey:'a',signal:new AbortController().signal,storage:null});await upload.transport('/synthetic',{method:'PUT'});assert.equal(seen,true);}finally{globalThis.fetch=previous;}
});
