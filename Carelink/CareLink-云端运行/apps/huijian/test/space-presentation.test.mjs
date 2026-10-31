import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpacePresentationHttp, validatePresentation } from '../lib/space-presentation.mjs';

const fields = {version:0,theme:'sea',startDate:'2026-09-07',endDate:'2026-09-09',place:'海边',coverPhotoId:''};
async function fixture({projected=false}={}){
  const directory=await mkdtemp(join(tmpdir(),'unseen-space-presentation-'));
  let owner=true,viewer=true,account='owner-a',lifecycle='active',nestedOwner;
  const handle=createSpacePresentationHttp({directory,authenticate:async()=>({accountId:account}),canonical:async(req,path)=>{
    if(path.endsWith('/management'))return projected ? {isOwner:owner,space:{owner:nestedOwner,spaceLifecycle:lifecycle}} : {space:{owner,spaceLifecycle:lifecycle}};
    if(!viewer)throw Object.assign(new Error('denied'),{code:'resource_unavailable',status:403});
    return {photos:[{id:'photo-a'}]};
  },readBody:async req=>req.body,send:(res,status,body)=>{res.status=status;res.body=body;}});
  return {directory,set:values=>{if('owner'in values)owner=values.owner;if('viewer'in values)viewer=values.viewer;if('account'in values)account=values.account;if('lifecycle'in values)lifecycle=values.lifecycle;if('nestedOwner'in values)nestedOwner=values.nestedOwner;},request:async(method='GET',body,headers={})=>{const res={};await handle({method,body,headers:{host:'localhost','content-type':'application/json',...headers}},res,'/api/space-presentation/space-a');return res;}};
}
test('operable management ownership permits private-space setup and still rejects non-owners',async()=>{
  const f=await fixture({projected:true});
  assert.equal((await f.request('PUT',fields)).status,200);
  f.set({owner:false,nestedOwner:true,account:'participant'});
  assert.equal((await f.request('GET')).status,200);
  assert.equal((await f.request('PUT',{...fields,version:1,theme:'night'})).status,403);
  f.set({owner:true,lifecycle:'archived'});
  assert.equal((await f.request('PUT',{...fields,version:1,theme:'night'})).status,403);
});
test('presentation persists real dates and theme, validates input and retries an already saved version',async()=>{
  const f=await fixture();const saved=await f.request('PUT',fields);assert.equal(saved.status,200);assert.equal(saved.body.presentation.version,1);
  const disk=JSON.parse(await readFile(join(f.directory,'space-a.json'),'utf8'));assert.equal(disk.place,'海边');assert.equal(disk.owner,'owner-a');
  assert.equal((await f.request('GET')).body.presentation.startDate,'2026-09-07');
  assert.equal((await f.request('PUT',fields)).status,200);
  assert.equal((await f.request('PUT',{...fields,theme:'night'})).status,409);
  assert.throws(()=>validatePresentation({...fields,startDate:'2026-02-30'}));
  assert.throws(()=>validatePresentation({...fields,endDate:'2026-09-01'}));
  assert.throws(()=>validatePresentation({...fields,arbitrary:'x'}));
});
test('canonical access is checked for every read and ownership is required for writes',async()=>{
  const f=await fixture();await f.request('PUT',fields);f.set({owner:false,viewer:true,account:'participant'});
  assert.equal((await f.request('GET')).status,200);assert.equal((await f.request('PUT',{...fields,version:1})).status,403);
  f.set({viewer:false});assert.equal((await f.request('GET')).status,403);
  assert.equal((await f.request('GET',null,{origin:'https://elsewhere.example'})).status,403);
});
test('concurrent edits compare versions, and foreign photo references cannot become covers',async()=>{
  const f=await fixture();await f.request('PUT',fields);
  const results=await Promise.all(['night','travel'].map(theme=>f.request('PUT',{...fields,version:1,theme})));
  assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);
  assert.equal((await f.request('PUT',{...fields,version:2,coverPhotoId:'foreign-photo'})).status,422);
  assert.equal((await f.request('PUT',{...fields,version:2,coverPhotoId:'photo-a'})).status,200);
});
test('the current canonical owner can edit metadata after an ownership transfer',async()=>{
  const f=await fixture();await f.request('PUT',fields);
  f.set({owner:true,viewer:true,account:'owner-b'});
  const saved=await f.request('PUT',{...fields,version:1,theme:'travel'});
  assert.equal(saved.status,200);assert.equal(saved.body.presentation.version,2);
  assert.equal(JSON.parse(await readFile(join(f.directory,'space-a.json'),'utf8')).owner,'owner-b');
});
