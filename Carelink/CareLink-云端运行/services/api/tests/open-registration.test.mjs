import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from './fixture-factory.mjs';
import { openDatabase } from '../src/database.mjs';
import { hashAccountPassword } from '../src/password-account-service.mjs';
import { LocalKeyring } from '../src/crypto.mjs';
import { FilesystemMediaStore } from '../src/ports/media/filesystem-media-store.mjs';

const password='registration-test-password';
test('default password and verified-email registrations can create private spaces without admin approval', async()=>{
  const f=fixture({autoApproveRegistrations:undefined});
  try {
    const body={username:'new-space-owner',password,displayName:'空间主人'};
    const registration=await f.ok('POST','/v1/auth/register',body,{'idempotency-key':'open-registration-replay'});
    assert.equal(registration.registration.status,'active');
    assert.deepEqual((await f.ok('POST','/v1/auth/register',body,{'idempotency-key':'open-registration-replay'})).registration,registration.registration);
    assert.equal((await f.call('POST','/v1/auth/register',body)).body.error.code,'username_already_exists');
    const signed=await f.ok('POST','/v1/auth/password-login',{username:body.username,password});
    assert.equal(signed.user.isAdmin,false);
    const passwordAccount={...signed,headers:{authorization:`Bearer ${signed.accountSessionSecret}`}};
    const emailAccount=await f.login('open-registration@example.test');
    for(const account of [passwordAccount,emailAccount]) {
      const space=await f.createSpace(account,'即刻创建的私人空间');
      assert.equal(space.sharingState,'private');
      assert.equal(space.spaceLifecycle,'active');
      assert.equal((await f.call('GET',`/v1/viewer/spaces/${space.spaceId}`)).status,401);
      assert.equal((await f.call('GET','/v1/admin/overview',{},account.headers)).status,403);
      const requested=await f.ok('POST',`/v1/spaces/${space.spaceId}/public-listing-requests`,{},account.headers);
      assert.equal(requested.status,'requested');
    }
    assert.equal((await f.ok('GET','/v1/discover/spaces')).spaces.length,0);
  } finally {f.close();}
});

test('upgrade releases only ordinary pending registrations, once, without changing credentials or publication decisions', async()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'unseen-open-registration-'));
  const migrations=path.join(directory,'migrations');
  const {mkdirSync}=await import('node:fs');mkdirSync(migrations);
  const source=fileURLToPath(new URL('../db/migrations/',import.meta.url));
  for(const name of readdirSync(source))if(name.endsWith('.sql')&&!name.startsWith('0029_'))copyFileSync(path.join(source,name),path.join(migrations,name));
  const database=path.join(directory,'unseen.sqlite'),keyring=new LocalKeyring({persistent:true});
  let db=openDatabase(database,migrations);
  const hash=await hashAccountPassword(password),now='2026-09-07T00:00:00Z';
  const rows=[['waiting','pending','active',0],['refused','rejected','active',0],['banned','disabled','active',0],['erased','pending','deleted',0],['operator','pending','active',1],['existing','active','active',0]];
  for(const [name,status,lifecycle,admin] of rows){
    db.prepare('INSERT INTO accounts(id,locale,status,session_epoch,version,created_at) VALUES(?,?,?,?,?,?)').run(name,'zh-CN',lifecycle,1,1,now);
    db.prepare('INSERT INTO account_administration(account_id,status,is_admin,display_name) VALUES(?,?,?,?)').run(name,status,admin,name);
    db.prepare('INSERT INTO account_password_credentials(account_id,username,password_hash,created_at,updated_at) VALUES(?,?,?,?,?)').run(name,name,hash,now,now);
  }
  db.prepare("INSERT INTO moment_submissions(id,account_id,moment_id,snapshot_id,title,author_name,status,created_at) VALUES('submission','waiting','memory','snapshot','私人内容','本人','pending',?)").run(now);
  const credentials=db.prepare('SELECT * FROM account_password_credentials ORDER BY account_id').all();
  const submission=db.prepare('SELECT * FROM moment_submissions').all();
  db.close();
  let f=fixture({database,keyring,mediaStore:new FilesystemMediaStore(path.join(directory,'media'))});
  try {
    for(const [name,status,,admin] of rows){
      const row=f.db.prepare('SELECT m.status,m.is_admin,a.version FROM account_administration m JOIN accounts a ON a.id=m.account_id WHERE account_id=?').get(name);
      assert.equal(row.status,name==='waiting'?'active':status);
      assert.equal(row.is_admin,admin);assert.equal(row.version,name==='waiting'?2:1);
    }
    assert.deepEqual(f.db.prepare('SELECT * FROM account_password_credentials ORDER BY account_id').all(),credentials);
    assert.deepEqual(f.db.prepare('SELECT * FROM moment_submissions').all(),submission);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM administration_audit WHERE action='registration_opened'").get().n,1);
    for(const name of ['refused','banned','erased','operator'])assert.equal((await f.call('POST','/v1/auth/password-login',{username:name,password})).status,name==='erased'?401:403);
    const signed=await f.ok('POST','/v1/auth/password-login',{username:'waiting',password});
    assert.equal(signed.user.isAdmin,false);
    const space=await f.createSpace({headers:{authorization:`Bearer ${signed.accountSessionSecret}`}});
    assert.equal(space.sharingState,'private');
    assert.equal(f.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
  } finally {f.close();}
  f=fixture({database,keyring,mediaStore:new FilesystemMediaStore(path.join(directory,'media'))});
  try {
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM administration_audit WHERE action='registration_opened'").get().n,1);
    assert.equal(f.db.prepare("SELECT version FROM accounts WHERE id='waiting'").get().version,2);
  } finally {f.close();}
});
