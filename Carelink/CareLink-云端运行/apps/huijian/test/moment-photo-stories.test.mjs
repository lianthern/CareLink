import test from 'node:test';
import assert from 'node:assert/strict';
import {mountPhotoStoryPicker,selectedStoryPieces} from '../public/moment-photo-stories.js';
const root=()=>({innerHTML:'',listeners:new Map(),status:{textContent:''},addEventListener(n,f){this.listeners.set(n,f);},removeEventListener(n){this.listeners.delete(n);},contains(){return true;},querySelector(){return this.status;},querySelectorAll(){return [];}});
const candidates=[{messageId:'one',text:'原文 <b> 👨‍👩‍👧‍👦',audio:{url:'/v1/moment-media/own-audio',duration:2}},{messageId:'two',text:'不分享的私事'}];
const source={momentId:'moment',photoId:'photo',version:3};
const target={spaceId:'space',photoId:'sharedphoto',name:'共同现场'};
const tick=()=>new Promise(r=>setImmediate(r));
function button(element,name,extra={}){const b={dataset:{storyAction:name,...extra},isConnected:false};element.listeners.get('click')({target:{closest:()=>b},preventDefault(){}});return b;}
test('explicit selection treats words and audio independently and ignores noncandidate IDs',()=>{
 assert.throws(()=>selectedStoryPieces(candidates,[]));
 assert.deepEqual(selectedStoryPieces(candidates,[{messageId:'one',includeText:false,includeAudio:true},{messageId:'forged',includeText:true}]),[{messageId:'one',includeText:false,includeAudio:true}]);
 assert.throws(()=>selectedStoryPieces(candidates,[{messageId:'two',includeText:false,includeAudio:true}]));
 assert.throws(()=>selectedStoryPieces(Array.from({length:21},(_,i)=>({messageId:String(i),text:'x'})),Array.from({length:21},(_,i)=>({messageId:String(i),includeText:true}))));
});
test('guest does not read private media, claim, or write a story',async()=>{const el=root();let calls=0;const picker=mountPhotoStoryPicker(el,{api:{request(){calls++;}},user:()=>({id:'guest-local'}),source});await picker.ready;assert.equal(calls,0);assert.match(el.innerHTML,/先把这张照片保存到账号/);picker.destroy();assert.equal(el.listeners.size,0);});
test('every checkbox is initially empty; review carries only selected IDs and needs a separate publish click',async()=>{
 const el=root(),calls=[];const api={request:async(path,options)=>{calls.push({path,options});if(path.includes('sources'))return {source,candidates,targets:[target]};if(path==='/v1/me/photo-stories')return {stories:[]};return {storyId:'saved',spaceId:'space',photoId:'sharedphoto',version:1};}};let completed;
 const picker=mountPhotoStoryPicker(el,{api,user:()=>({id:'a'}),source,onComplete:r=>{completed=r;}});await picker.ready;
 assert.equal(calls.length,2);assert.doesNotMatch(el.innerHTML,/<input[^>]+checked/);assert.match(el.innerHTML,/&lt;b&gt;/);
 el.listeners.get('submit')({target:{matches:()=>true,elements:{target:{value:'0'},credit:{value:'我'},'text-0':{checked:true},'audio-0':{checked:false},'text-1':{checked:false}}},preventDefault(){}});await tick();
 assert.equal(calls.length,2);assert.doesNotMatch(el.innerHTML,/不分享的私事|<audio/);assert.match(el.innerHTML,/确认分享所选内容/);
 button(el,'publish');await tick();assert.equal(calls.length,3);assert.deepEqual(calls[2].options.body.selections,[{messageId:'one',includeText:true,includeAudio:false}]);assert.equal(calls[2].options.body.source.version,3);assert.doesNotMatch(JSON.stringify(calls[2].options.body),/原文|私事|dataBase64/);assert.equal(completed.storyId,'saved');picker.destroy();
});
test('late source read or publish completion after account switch cannot expose former account or call completion',async()=>{
 const el=root();let user={id:'a'},resolve;const picker=mountPhotoStoryPicker(el,{api:{request:()=>new Promise(r=>resolve=r)},user:()=>user,source});user={id:'b'};resolve({source,candidates,targets:[target]});await picker.ready;assert.doesNotMatch(el.innerHTML,/原文|共同现场/);picker.destroy();
 const el2=root();user={id:'a'};let pending,completed=0;const p=mountPhotoStoryPicker(el2,{api:{request:async(path)=>path.includes('sources')?{source,candidates,targets:[target]}:path==='/v1/me/photo-stories'?{stories:[]}:new Promise(r=>pending=r)},user:()=>user,source,onComplete:()=>completed++});await p.ready;
 el2.listeners.get('submit')({target:{matches:()=>true,elements:{target:{value:'0'},credit:{value:'我'},'text-0':{checked:true}}},preventDefault(){}});await tick();button(el2,'publish');await tick();const before=el2.innerHTML;user={id:'b'};pending({storyId:'late'});await tick();assert.equal(el2.innerHTML,before);assert.equal(completed,0);p.destroy();
});
