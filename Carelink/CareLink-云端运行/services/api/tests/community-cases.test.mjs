import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixture-factory.mjs';
import {seedCommunityCases} from '../src/community-case-service.mjs';
const entry={id:'catalog-demo',source:'catalog',sourceId:'demo',title:'已公开示例',description:'展示控制',kind:'photo',coverPhotoUrl:'/photos/demo.jpg',previewUrl:'/app#case/demo'};
test('case controls enforce live roles, version, reason, idempotency and persisted visibility',async()=>{
 const f=fixture();try{
  const helper=await f.login('helper@example.test'),user=await f.login('member@example.test');
  f.db.prepare("UPDATE account_administration SET is_admin=1,admin_role='admin' WHERE account_id=?").run(helper.accountId);
  seedCommunityCases(f.db,[entry]);
  const route='/v1/admin/community/cases/catalog-demo/presentation';
  const body={status:'hidden',featured:true,sortRank:-1,expectedVersion:1,reason:'撤下旧版示例'};
  assert.equal((await f.call('POST',route,body)).status,401);
  assert.equal((await f.call('POST',route,body,user.headers)).status,403);
  assert.equal((await f.call('POST',route,{...body,reason:''},helper.headers)).status,400);
  assert.equal((await f.ok('GET','/v1/public/community/cases')).cases.length,1);
  const headers={...helper.headers,'idempotency-key':'case-operation-replay-123456'};
  const changed=await f.ok('POST',route,body,headers);
  assert.equal(changed.case.version,2);assert.equal((await f.ok('POST',route,body,headers)).case.version,2);
  assert.equal((await f.ok('GET','/v1/public/community/cases')).cases.length,0);
  assert.equal((await f.call('POST',route,{...body,status:'visible'},helper.headers)).status,409);
  seedCommunityCases(f.db,[{...entry,title:'新说明保留隐藏选择'}]);
  assert.equal((await f.ok('GET','/v1/public/community/cases')).cases.length,0);
  const inventory=await f.ok('GET','/v1/admin/community/cases?status=hidden&q=新说明',{},helper.headers);
  assert.equal(inventory.total,1);assert.equal(inventory.cases[0].version,2);
  await f.ok('POST',route,{...body,expectedVersion:2,status:'visible'},helper.headers);
  const visible=(await f.ok('GET','/v1/public/community/cases')).cases[0];
  assert.equal(visible.featured,true);assert.equal(Object.hasOwn(visible,'reason'),false);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM administration_audit WHERE action='community_case_presentation'").get().n,2);
  f.db.prepare("UPDATE account_administration SET is_admin=0,admin_role='user' WHERE account_id=?").run(helper.accountId);
  assert.equal((await f.call('POST',route,body,headers)).status,403);
 }finally{f.close();}
});
test('case mutation and audit roll back together; inventory validation is atomic',async()=>{
 const f=fixture();try{
  const helper=await f.login('operator@example.test');f.db.prepare("UPDATE account_administration SET is_admin=1,admin_role='admin' WHERE account_id=?").run(helper.accountId);
  assert.throws(()=>seedCommunityCases(f.db,[entry,{...entry,id:'bad'}]));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM community_case_display').get().n,0);
  seedCommunityCases(f.db,[entry]);
  f.api.adminConsole.audit=()=>{throw new Error('synthetic-audit-failure');};
  assert.equal((await f.call('POST','/v1/admin/community/cases/catalog-demo/presentation',{status:'hidden',featured:false,sortRank:0,expectedVersion:1,reason:'test'},helper.headers)).status,500);
  assert.equal((await f.ok('GET','/v1/public/community/cases')).cases.length,1);
 }finally{f.close();}
});
