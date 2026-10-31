import test from 'node:test';
import assert from 'node:assert/strict';
import { retainSpatialRevision, restoreSpatialRevision } from '../public/moment-spatial-history.js';

test('replacing spatial selections retains original bytes, and restore creates an independent draft',async()=>{
  const rows=new Map(),store=async(method,value)=>{assert.equal(method,'put');rows.set(value.id,structuredClone(value));};
  const draft={id:'original-import',accountId:'guest',title:'海边',panorama:new Blob(['original panorama']),depth:new Blob(['original depth']),metadata:{min:1,max:5},saved:true};
  const revision=await retainSpatialRevision(store,draft,'移除深度前的完整素材');
  draft.depth=null;draft.metadata.min=9;
  assert.equal(await rows.get(revision.id).depth.text(),'original depth');
  assert.equal(rows.get(revision.id).metadata.min,1);
  const restored=await restoreSpatialRevision(store,revision,{accountId:'owner-a'});
  assert.notEqual(restored.id,draft.id);assert.notEqual(restored.id,revision.id);
  assert.equal(restored.accountId,'owner-a');assert.equal(restored.saved,false);assert.equal(restored.archivedAt,null);
  assert.equal(await restored.panorama.text(),'original panorama');
  assert.ok(rows.get(revision.id).archivedAt);
});

test('history never restores another account or discards source after storage failure',async()=>{
  const draft={id:'source',accountId:'owner-a',photos:[{src:'data:image/png;base64,AA=='}]};
  await assert.rejects(restoreSpatialRevision(async()=>assert.fail('must not write'),draft,{accountId:'owner-b'}),e=>e.code==='account_changed');
  await assert.rejects(retainSpatialRevision(async()=>{throw new Error('storage full');},draft,'replace'),/storage full/);
  assert.equal(draft.photos[0].src,'data:image/png;base64,AA==');
});

test('World history restores selected photos without carrying or changing a paid request',async()=>{
  const rows=new Map(),store=async(_method,value)=>rows.set(value.id,structuredClone(value));
  const source={id:'world-input',accountId:'world-browser',photos:[{name:'a.jpg',src:'original'}],prompt:'当时的风',worldMode:'single'};
  const revision=await retainSpatialRevision(store,source,'收起的素材');
  const restored=await restoreSpatialRevision(store,revision,{id:'world-input',accountId:'world-browser'});
  assert.deepEqual(restored.photos,source.photos);assert.equal(restored.prompt,source.prompt);
  assert.ok(rows.get(revision.id).archivedAt);assert.equal('worldPending' in restored,false);
});
