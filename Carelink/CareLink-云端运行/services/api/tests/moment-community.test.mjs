import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixture-factory.mjs';

test('community moment search, safe authors, presentation, restore and live permissions', async()=>{
 const f=fixture();
 try {
  const admin=await f.login('helper@example.test'), user=await f.login('private@example.test');
  f.db.prepare("INSERT INTO account_administration(account_id,is_admin,admin_role) VALUES(?,1,'admin') ON CONFLICT(account_id) DO UPDATE SET is_admin=1,admin_role='admin'").run(admin.accountId);
  user.headers['x-unseen-expected-account-id']=user.accountId;
  async function submit(id,title) {
   await f.ok('PUT',`/v1/moments/${id}`,{expectedVersion:0,moment:{id,title,status:'active',createdAt:f.clock.iso(),updatedAt:f.clock.iso(),photos:[],messages:[]}},user.headers);
   return (await f.ok('POST',`/v1/moments/${id}/submissions`,{expectedVersion:1,consent:true},user.headers)).submission;
  }
  async function review(s,decision) {return (await f.ok('POST',`/v1/admin/submissions/${s.id}/review`,{expectedVersion:s.version,decision,reason:'运营审核'},admin.headers)).submission;}
  let a=await submit('a','Alpha 100%'), b=await submit('b','Beta');
  assert.equal((await f.ok('GET','/v1/public/moments')).total,0);
  a=await review(a,'approve');b=await review(b,'approve');
  const route=`/v1/admin/submissions/${b.id}/presentation`, body={featured:true,sortRank:-2,expectedVersion:b.version,reason:'精选展示'}, headers={...admin.headers,'idempotency-key':'community-presentation-12345'};
  assert.equal((await f.call('POST',route,body)).status,401);
  assert.equal((await f.call('POST',route,body,user.headers)).status,403);
  b=(await f.ok('POST',route,body,headers)).submission;
  assert.equal((await f.ok('POST',route,body,headers)).submission.version,b.version);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM administration_audit WHERE action='submission_presentation'").get().n,1);
  assert.equal((await f.call('POST',route,{...body,sortRank:4},admin.headers)).status,409);
  let list=await f.ok('GET','/v1/public/moments?pageSize=1');
  assert.equal(list.total,2);assert.equal(list.moments[0].id,b.id);assert.equal(list.moments[0].authorId,user.accountId);
  assert.equal((await f.ok('GET',`/v1/public/moments?q=100%25&authorId=${user.accountId}`)).total,1);
  assert.equal((await f.ok('GET','/v1/public/moments?featured=true')).total,1);
  assert.equal((await f.ok('GET',`/v1/admin/submissions?status=&q=Alpha&authorId=${user.accountId}`,{},admin.headers)).total,1);
  const detail=await f.ok('GET',`/v1/public/moments/${a.id}`);
  assert.equal(Object.hasOwn(detail.submission,'username'),false);assert.equal(Object.hasOwn(detail.submission,'reason'),false);
  assert.equal(JSON.stringify(detail).includes('private@example.test'),false);
  a=await review(a,'unpublish');
  assert.equal((await f.call('POST',`/v1/admin/submissions/${a.id}/presentation`,{...body,expectedVersion:a.version},admin.headers)).status,409);
  a=await review(a,'restore'); assert.equal((await f.ok('GET','/v1/public/moments')).total,2);
  a=await review(a,'unpublish');
  let newer=(await f.ok('POST','/v1/moments/a/submissions',{expectedVersion:1,consent:true},user.headers)).submission;
  assert.equal((await f.call('POST',`/v1/admin/submissions/${a.id}/review`,{expectedVersion:a.version,decision:'restore',reason:'冲突'},admin.headers)).body.error.code,'submission_already_active');
  newer=await review(newer,'reject');
  assert.equal((await f.call('POST',`/v1/admin/submissions/${newer.id}/review`,{expectedVersion:newer.version,decision:'restore',reason:'不可恢复'},admin.headers)).status,409);
  f.db.prepare("UPDATE account_administration SET status='disabled' WHERE account_id=?").run(user.accountId);
  assert.equal((await f.ok('GET','/v1/public/moments')).total,0);
  assert.equal((await f.call('POST',`/v1/admin/submissions/${a.id}/review`,{expectedVersion:a.version,decision:'restore',reason:'已停用'},admin.headers)).status,403);
  f.db.prepare("UPDATE account_administration SET is_admin=0,admin_role='user' WHERE account_id=?").run(admin.accountId);
  assert.equal((await f.call('POST',route,body,headers)).status,403);
 } finally {f.close();}
});
