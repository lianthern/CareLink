import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeAccountSpaces} from '../public/moment-space-list.js';
test('imports and created spaces share one identity; stale imports never grant access',()=>{
 const owner={spaceId:'a',name:'现场',owner:true,effectiveCanView:true,effectiveCanUpload:true,spaceLifecycle:'active'};
 const member={spaceId:'b',name:'参与现场',owner:false,effectiveCanView:true,spaceLifecycle:'active'};
 const rows=mergeAccountSpaces([owner,owner,member],[{spaceId:'a',id:'app-a',panorama:{url:'/own.jpg'}},{spaceId:'revoked',id:'old'}]);
 assert.equal(rows.length,2);assert.equal(rows[0].importId,'app-a');assert.equal(rows[0].route,'shared-space/a?tab=scene');assert.equal(rows[1].title,'参与现场');
});
test('upload-only participation exposes no preview; archived and no-task spaces stay out',()=>{
 const rows=mergeAccountSpaces([{spaceId:'upload',name:'收集',spaceLifecycle:'active',effectiveCanUpload:true},{spaceId:'archived',spaceLifecycle:'archived',owner:true},{spaceId:'none',spaceLifecycle:'active'}],[{spaceId:'upload',panorama:{url:'/old.jpg'},depth:{url:'/old.png'}}]);
 assert.equal(rows.length,1);assert.equal(rows[0].panorama,null);assert.equal(rows[0].depth,null);assert.equal(rows[0].route,'shared-space/upload?tab=upload');
});
