import test from 'node:test';
import assert from 'node:assert/strict';
import {communityMoments,communityHome} from '../public/moment-community.js';
import {publicSpaceMedia} from '../public/moment-community-spaces.js';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

test('community cards accept only public submission media and escape author and story text',()=>{
  const data={moments:[
    {id:'sub-a',title:'<script>story</script>',authorName:'<img onerror=bad>',coverPhotoUrl:'/v1/public/moments/sub-a/media/photo-a/preview'},
    {id:'sub-b',title:'private url',coverPhotoUrl:'/v1/admin/submissions/sub-b/media/private'},
    {id:'sub-c',title:'external url',coverPhotoUrl:'https://elsewhere.test/a.jpg'},
    {id:'../../private',title:'bad identifier'},
  ]};
  const rows=communityMoments(data);assert.equal(rows.length,3);assert.equal(rows[1].coverPhotoUrl,'');assert.equal(rows[2].coverPhotoUrl,'');
  const html=communityHome({data});assert.doesNotMatch(html,/<script>|onerror=bad>|src="https:|\/v1\/admin|\.\.\/private/);assert.match(html,/&lt;script&gt;/);assert.match(html,/&lt;img onerror=bad&gt;/);
  assert.match(html,/data-public-id="sub-a"/);assert.match(html,/sub-a\/media\/photo-a\/preview/);
});
test('featured and latest labels come from public data; private records are not a homepage fallback',()=>{
  const data={moments:[{id:'new',title:'最新故事'},{id:'featured',title:'后台选择的故事',featured:true}]};
  let html=communityHome({data});assert.match(html,/aria-label="打开后台选择的故事"/);assert.match(html,/>社区精选</);
  data.moments[1].featured=false;html=communityHome({data});assert.match(html,/aria-label="打开最新故事"/);assert.match(html,/>最新回忆</);assert.doesNotMatch(html,/>社区精选</);
  html=communityHome({items:[{id:'private-owned',title:'私人照片'}],data:{moments:[]}});assert.doesNotMatch(html,/私人照片|private-owned/);assert.match(html,/第一段分享，从你开始/);
});
test('community failure clears prior content and offers retry while create and library actions remain',()=>{
  const html=communityHome({error:'社区暂时没能打开',data:null});assert.match(html,/data-action="community-refresh"/);assert.match(html,/data-action="capture"/);assert.match(html,/data-spatial-route="new-space"/);assert.match(html,/data-action="open-library"/);assert.doesNotMatch(html,/data-public-id=/);
  assert.match(communityHome({loading:true}),/aria-busy="true"/);
});
test('public space media is bound to the selected published submission',()=>{
  assert.equal(publicSpaceMedia('/v1/public/spaces/sub-a/media/photo-0','sub-a'),'/v1/public/spaces/sub-a/media/photo-0');
  for(const value of ['/v1/public/spaces/sub-b/media/photo-0','/v1/admin/community/spaces/sub-a/media/photo-0','/v1/public/spaces/sub-a/media/../private','/v1/public/spaces/sub-a/media/photo-0?access=account','https://other.test/photo'])assert.equal(publicSpaceMedia(value,'sub-a'),'');
});
test('a session established during first community load starts a current request; late results cannot leave it loading',async()=>{
  const source=await readFile(new URL('../public/moment-app.js',import.meta.url),'utf8');
  const body=source.slice(source.indexOf('async function loadCommunity('),source.indexOf('function registrationForm()'));
  const renderLine=source.split('\n').find(line=>line.includes('background(loadCommunity())'));
  const calls=[],jobs=[];
  const c=vm.createContext({isV2:true,s:{view:'home',epoch:0,nav:0},AbortController,AbortSignal,fetch:()=>new Promise(resolve=>calls.push(resolve)),background:promise=>jobs.push(promise)});
  vm.runInContext(`let communityController=null;function render(){${renderLine}}\n${body}\nrender();`,c);
  assert.equal(calls.length,1);
  vm.runInContext('s.epoch++;s.nav++;render();',c);assert.equal(calls.length,2);
  calls[1]({ok:true,json:async()=>({moments:[{id:'current'}]})});await jobs[1];
  calls[0]({ok:true,json:async()=>({moments:[{id:'stale'}]})});await jobs[0];
  assert.equal(c.s.community.loading,false);assert.equal(c.s.community.data.moments[0].id,'current');assert.equal(calls.length,2);
});
