import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fixture } from './fixture-factory.mjs';
import { createPasswordAccount,hashAccountPassword } from '../src/password-account-service.mjs';
import { createLocalHttpServer } from '../src/http-server.mjs';
import {LocalKeyring} from '../src/crypto.mjs';
import {FilesystemMediaStore} from '../src/ports/media/filesystem-media-store.mjs';
import {dispatchOne} from '../../jobs/dispatch/index.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const oldPassword=randomUUID(),newPassword=randomUUID();
async function bound(f,email='bound@example.test',username='bound-account') {
  const account=await f.login(email),now=f.api.core.now();
  f.db.prepare('INSERT INTO account_password_credentials(account_id,username,password_hash,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run(account.accountId,username,await hashAccountPassword(oldPassword),now,now);
  return account;
}
async function challenge(f,email,contact=false) {
  const sent=await f.ok('POST',contact?'/v1/auth/recovery-contact-challenges':'/v1/auth/password-reset-challenges',{email});
  return {...sent,otp:f.otp.findLast(x=>x.challengeId===sent.challengeId)?.code};
}
const finish=(f,c,password=newPassword)=>f.call('POST','/v1/auth/password-reset-completions',{challengeId:c.challengeId,otp:c.otp,newPassword:password});
async function administrator(f){const a=await f.login('admin@example.test');f.db.prepare("UPDATE account_administration SET is_admin=1,admin_role='super_admin' WHERE account_id=?").run(a.accountId);return a;}
async function apply(f,username='unbound-account',email='contact@example.test'){
  const c=await challenge(f,email,true);
  return f.ok('POST','/v1/auth/recovery-requests',{username,challengeId:c.challengeId,otp:c.otp,statement:'我是此账号的持有人，可与管理员当面核实注册时的约定信息。'});
}
const decision={decision:'approve',identityVerified:true,expectedVersion:1,reason:'已通过线下当面核对预先保留的注册凭证并由管理员确认申请人身份。'};

test('verified-email reset is single-use, non-enumerating, purpose-bound and revokes every existing session',async()=>{
 const f=fixture();try{
  const a=await bound(f),second=await f.ok('POST','/v1/auth/password-login',{username:'bound-account',password:oldPassword});
  const count=f.otp.length,unknown=await challenge(f,'absent@example.test');
  assert.equal(unknown.accepted,true);assert.equal(unknown.otp,undefined);assert.equal(f.otp.length,count);
  const c=await challenge(f,'bound@example.test');assert.ok(c.otp);assert.equal(c.accepted,true);
  assert.equal((await f.call('POST','/v1/auth/email-otp-verifications',{challengeId:c.challengeId,otp:c.otp,purpose:'password_reset'})).status,400);
  const result=await finish(f,c);assert.equal(result.status,200);assert.equal(result.body.changed,true);
  assert.equal(result.body.accountSessionSecret,undefined);
  for(const headers of [a.headers,{authorization:`Bearer ${second.accountSessionSecret}`}])assert.equal((await f.call('GET','/v1/profile',{},headers)).status,401);
  assert.equal((await finish(f,c,'Different-password-2026')).status,401);
  assert.equal((await f.call('POST','/v1/auth/password-login',{username:'bound-account',password:oldPassword})).status,401);
  assert.equal((await f.call('POST','/v1/auth/password-login',{username:'bound-account',password:newPassword})).status,200);
  const rows=f.db.prepare('SELECT request_hash,response_ref FROM idempotency_records').all();
  assert.ok(!JSON.stringify(rows).includes(newPassword));
  assert.equal(f.db.prepare("SELECT count(*) n FROM administration_audit WHERE action='password_recovery_completed'").get().n,1);
 }finally{f.close();}
});

test('wrong codes remain counted, expiry and password/session epoch changes invalidate reset challenges',async()=>{
 const f=fixture();try{
  const a=await bound(f),c=await challenge(f,'bound@example.test'),wrong=c.otp==='000000'?'111111':'000000';
  for(let i=0;i<5;i++)assert.equal((await finish(f,{...c,otp:wrong})).status,401);
  assert.equal(f.db.prepare('SELECT attempts FROM email_otp_challenges WHERE id=?').get(c.challengeId).attempts,5);
  assert.equal((await finish(f,c)).status,401);
  const expired=await challenge(f,'bound@example.test');f.clock.advance(10*60_000+1);assert.equal((await finish(f,expired)).status,401);
  const revoked=await challenge(f,'bound@example.test');f.api.adminConsole.operations.revoke(a.accountId);assert.equal((await finish(f,revoked)).status,401);
  const renewed=await challenge(f,'bound@example.test');
  const results=await Promise.all([finish(f,renewed,'Concurrent-pass-one'),finish(f,renewed,'Concurrent-pass-two')]);
  assert.deepEqual(results.map(x=>x.status).sort(),[200,401]);
 }finally{f.close();}
});

test('manual recovery requires verified contact plus explicit administrator identity decision, then a fresh reset OTP',async()=>{
 const f=fixture();try{
  const account=await createPasswordAccount(f.api.core,{username:'unbound-account',password:oldPassword}),admin=await administrator(f);
  const before=await challenge(f,'contact@example.test');assert.equal(before.otp,undefined);
  const submitted=await apply(f),path=`/v1/admin/recovery-requests/${submitted.requestId}/review`;
  assert.equal((await f.call('GET','/v1/admin/recovery-requests')).status,401);
  const ordinary=await f.ok('POST','/v1/auth/password-login',{username:'unbound-account',password:oldPassword});
  assert.equal((await f.call('GET','/v1/admin/recovery-requests',{}, {authorization:`Bearer ${ordinary.accountSessionSecret}`})).status,403);
  const queue=await f.ok('GET','/v1/admin/recovery-requests',{},admin.headers);assert.equal(queue.requests.length,1);
  assert.equal(queue.requests[0].contactEmail,'contact@example.test');assert.ok(queue.requests[0].contactVerifiedAt);
  assert.ok(!f.db.prepare('SELECT statement_ciphertext FROM password_recovery_requests').get().statement_ciphertext.includes('当面'));
  assert.equal((await f.call('POST',path,{...decision,identityVerified:false},admin.headers)).body.error.code,'identity_verification_required');
  assert.equal((await challenge(f,'contact@example.test')).otp,undefined);
  const approved=await f.ok('POST',path,decision,admin.headers);assert.equal(approved.request.status,'approved');
  assert.equal(f.api.passwordRecovery.emailOwner(f.db.prepare('SELECT identifier_equivalence_id FROM password_recovery_requests').get().identifier_equivalence_id),undefined);
  const reset=await challenge(f,'contact@example.test');assert.ok(reset.otp);assert.equal((await finish(f,reset)).status,200);
  assert.equal(f.db.prepare('SELECT status FROM password_recovery_requests').get().status,'completed');
  const email=await f.login('contact@example.test');assert.equal(email.accountId,account.accountId);
  assert.equal((await f.call('POST','/v1/auth/password-login',{username:'unbound-account',password:newPassword})).status,200);
  assert.equal((await f.call('POST',path,decision,admin.headers)).status,409);
 }finally{f.close();}
});

test('manual recovery cannot capture another account email and stale approval cannot reset changed credentials',async()=>{
 const f=fixture();try{
  await createPasswordAccount(f.api.core,{username:'unbound-account',password:oldPassword});
  const admin=await administrator(f);await f.login('occupied@example.test');
  assert.equal((await apply(f,'unbound-account','occupied@example.test')).accepted,true);
  assert.equal(f.db.prepare('SELECT count(*) n FROM password_recovery_requests').get().n,0);
  assert.equal((await apply(f,'unknown-account','free@example.test')).accepted,true);
  assert.equal(f.db.prepare('SELECT count(*) n FROM password_recovery_requests').get().n,0);
  const submitted=await apply(f);await f.ok('POST',`/v1/admin/recovery-requests/${submitted.requestId}/review`,decision,admin.headers);
  f.clock.advance(24*60*60_000+1);assert.equal((await challenge(f,'contact@example.test')).otp,undefined);
  // A new application after an expired grant may be independently reviewed.
  const next=await apply(f);const credential=f.db.prepare('SELECT * FROM account_password_credentials').get();
  f.db.prepare('UPDATE account_password_credentials SET version=version+1 WHERE account_id=?').run(credential.account_id);
  assert.equal((await f.call('POST',`/v1/admin/recovery-requests/${next.requestId}/review`,decision,admin.headers)).body.error.code,'recovery_target_changed');
 }finally{f.close();}
});

test('real HTTP recovery rejects cross-origin requests, clears cookies and never sends an authentication secret',async()=>{
 const f=fixture(),server=createLocalHttpServer({api:f.api});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${server.address().port}`,origin=base;
 f.api.campaigns.publicOrigin=origin;
 try{
  const a=await bound(f),c=await challenge(f,'bound@example.test');
  const send=(headers)=>fetch(base+'/v1/auth/password-reset-completions',{method:'POST',headers:{'content-type':'application/json','idempotency-key':randomUUID(),...headers},body:JSON.stringify({challengeId:c.challengeId,otp:c.otp,newPassword})});
  assert.equal((await send({origin:'https://foreign.test','sec-fetch-site':'cross-site'})).status,403);
  const response=await send({origin,'sec-fetch-site':'same-origin',cookie:`__Host-unseen_account=${a.token}`});
  assert.equal(response.status,200);assert.match(response.headers.get('set-cookie'),/Max-Age=0/);
  assert.deepEqual(await response.json(),{changed:true});
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));f.close();}
});

test('recovery evidence survives persistent restart/key rotation, exports only to its account and is erased with account deletion',async()=>{
 const root=mkdtempSync(join(tmpdir(),'unseen-recovery-lifecycle-'));
 const old=new LocalKeyring({persistent:true,keyId:'recovery-old-v1'}),next=new LocalKeyring({persistent:true,keyId:'recovery-new-v1'});
 const both=new LocalKeyring({current:next.current,previous:[old.current],persistent:true}),retired=new LocalKeyring({current:next.current,previous:[],persistent:true});
 const open=keyring=>fixture({database:join(root,'test.sqlite'),keyring,mediaStore:new FilesystemMediaStore(join(root,'media'))});
 let f=open(old);
 try{
  const account=await createPasswordAccount(f.api.core,{username:'unbound-account',password:oldPassword});await administrator(f);
  const submitted=await apply(f),original=f.db.prepare('SELECT * FROM password_recovery_requests').get();f.close();f=null;
  assert.throws(()=>open(retired),error=>error.code==='password_recovery_key_retirement_incomplete');
  f=open(both);f.api.identityRekey.run({fromCollisionKeyEpoch:old.keyId,toCollisionKeyEpoch:next.keyId,leaseId:'recovery-test-key-rotation'});
  const changed=f.db.prepare('SELECT * FROM password_recovery_requests').get();assert.equal(changed.envelope_key_id,next.keyId);assert.equal(changed.version,original.version);f.close();f=null;
  f=open(retired);const admin=await administrator(f),queue=await f.ok('GET','/v1/admin/recovery-requests',{},admin.headers);assert.equal(queue.requests[0].contactEmail,'contact@example.test');
  const session=await f.ok('POST','/v1/auth/password-login',{username:'unbound-account',password:oldPassword});
  const exported=await f.ok('POST','/v1/exports',{scope:'account',format:'json'},{authorization:`Bearer ${session.accountSessionSecret}`});
  dispatchOne(f.db,exported.jobId,{now:f.clock.iso(),keyring:f.api.keyring});
  const document=JSON.parse(Buffer.from(f.db.prepare('SELECT content FROM export_artifacts WHERE export_id=?').get(exported.exportId).content));
  assert.equal(document.passwordRecoveryRequests[0].statement,queue.requests[0].statement);
  assert.ok(!JSON.stringify(document.passwordRecoveryRequests).includes('ciphertext'));
  await f.ok('POST',`/v1/admin/recovery-requests/${submitted.requestId}/review`,decision,admin.headers);
  assert.equal((await finish(f,await challenge(f,'contact@example.test'))).status,200);
  const owner=await f.login('contact@example.test');assert.equal(owner.accountId,account.accountId);
  const grant=await f.reauth(owner,'ACCOUNT.DELETE_REQUEST','account_delete','account',owner.accountId);
  const version=f.db.prepare('SELECT version FROM accounts WHERE id=?').get(owner.accountId).version;
  await f.ok('POST','/v1/me/deletion-requests',{confirmation:true,reauthGrant:grant.reauthGrantSecret},{...owner.headers,'if-match':String(version)});
  assert.equal(f.db.prepare('SELECT count(*) n FROM password_recovery_requests WHERE account_id=?').get(owner.accountId).n,0);
 }finally{f?.close();rmSync(root,{recursive:true,force:true});}
});

test('recovery uses the existing captcha gate and reset audit failure rolls password, sessions and OTP consumption back',async()=>{
 const guarded=fixture({otpCaptcha:{provider:'pow',difficultyBits:0}});
 try{
  for(const path of ['/v1/auth/password-reset-challenges','/v1/auth/recovery-contact-challenges']){
   assert.ok((await guarded.call('POST',path,{email:'guarded@example.test'})).status>=400);
   assert.equal(guarded.otp.length,0);
  }
 }finally{guarded.close();}
 const f=fixture();try{
  const account=await bound(f),c=await challenge(f,'bound@example.test'),audit=f.api.adminConsole.audit.bind(f.api.adminConsole);
  f.api.adminConsole.audit=()=>{throw new Error('synthetic_audit_failure');};
  assert.equal((await finish(f,c)).status,500);
  assert.equal(f.db.prepare('SELECT consumed_at FROM email_otp_challenges WHERE id=?').get(c.challengeId).consumed_at,null);
  assert.equal((await f.call('GET','/v1/profile',{},account.headers)).status,200);
  assert.equal((await f.call('POST','/v1/auth/password-login',{username:'bound-account',password:oldPassword})).status,200);
  f.api.adminConsole.audit=audit;assert.equal((await finish(f,c)).status,200);
 }finally{f.close();}
});

test('an unrelated pending claim cannot suppress the real applicants verified contact request',async()=>{
 const f=fixture();try{
  await createPasswordAccount(f.api.core,{username:'unbound-account',password:oldPassword});
  const first=await apply(f,'unbound-account','first-contact@example.test');
  const second=await apply(f,'unbound-account','second-contact@example.test');
  assert.notEqual(first.requestId,second.requestId);assert.equal(f.db.prepare('SELECT count(*) n FROM password_recovery_requests').get().n,2);
  const fresh=await apply(f,'unbound-account','second-contact@example.test');assert.notEqual(fresh.requestId,second.requestId);
  assert.equal(f.db.prepare('SELECT count(*) n FROM password_recovery_requests').get().n,3);
  const unknown1=await apply(f,'unknown-account','unknown-contact@example.test');
  const unknown2=await apply(f,'unknown-account','unknown-contact@example.test');assert.notEqual(unknown1.requestId,unknown2.requestId);
  assert.deepEqual(Object.keys(fresh).sort(),Object.keys(unknown2).sort());
 }finally{f.close();}
});

test('verified recovery proofs backfill legacy email envelopes before the administrator reads them',async()=>{
 const f=fixture();try{
  await createPasswordAccount(f.api.core,{username:'unbound-account',password:oldPassword});const admin=await administrator(f);
  const identity=f.api.identity.ensureIdentity('legacy-contact@example.test');
  f.db.prepare('UPDATE identifier_equivalences SET normalized_identifier_ciphertext=NULL,normalized_identifier_envelope_key_id=NULL,normalized_identifier_envelope_format=NULL WHERE id=?').run(identity.equivalenceId);
  const sent=await challenge(f,'legacy-contact@example.test',true);
  assert.ok(f.db.prepare('SELECT pending_identifier_ciphertext FROM email_otp_challenges WHERE id=?').get(sent.challengeId).pending_identifier_ciphertext);
  assert.equal(f.db.prepare('SELECT normalized_identifier_ciphertext FROM identifier_equivalences WHERE id=?').get(identity.equivalenceId).normalized_identifier_ciphertext,null);
  const submitted=await f.ok('POST','/v1/auth/recovery-requests',{username:'unbound-account',challengeId:sent.challengeId,otp:sent.otp,statement:'请管理员通过既有线下约定记录核实此恢复申请。'});
  const queue=await f.ok('GET','/v1/admin/recovery-requests',{},admin.headers);assert.equal(queue.requests[0].id,submitted.requestId);assert.equal(queue.requests[0].contactEmail,'legacy-contact@example.test');
  assert.ok(f.db.prepare('SELECT normalized_identifier_ciphertext FROM identifier_equivalences WHERE id=?').get(identity.equivalenceId).normalized_identifier_ciphertext);
  await bound(f,'legacy-bound@example.test','legacy-bound');const boundIdentity=f.api.identity.ensureIdentity('legacy-bound@example.test');
  f.db.prepare('UPDATE identifier_equivalences SET normalized_identifier_ciphertext=NULL,normalized_identifier_envelope_key_id=NULL,normalized_identifier_envelope_format=NULL WHERE id=?').run(boundIdentity.equivalenceId);
  assert.equal((await finish(f,await challenge(f,'legacy-bound@example.test'))).status,200);
  assert.ok(f.db.prepare('SELECT normalized_identifier_ciphertext FROM identifier_equivalences WHERE id=?').get(boundIdentity.equivalenceId).normalized_identifier_ciphertext);
 }finally{f.close();}
});
