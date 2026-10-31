import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {loadLocalKeyring} from '../src/crypto.mjs';
import {FilesystemMediaStore} from '../src/ports/media/filesystem-media-store.mjs';
import {fixture} from './fixture-factory.mjs';
import {createPasswordAccount} from '../src/password-account-service.mjs';
test('explicit reviewed catalog binds the existing demo identity; replay is stable and altered content cannot overwrite it',async()=>{
 const root=await mkdtemp(join(tmpdir(),'app-catalog-')),database=join(root,'test.sqlite'),f=fixture({database,mediaStore:new FilesystemMediaStore(join(root,'media')),keyring:loadLocalKeyring(join(root,'keyset.json'),{allowCreate:true})});
 try{
  await createPasswordAccount(f.api.core,{username:'unseen_demo',password:'Catalog-test-2026'});
  await mkdir(join(root,'public/app-spatial/v1'),{recursive:true});
  const source=join(root,'public/app-spatial/v1/catalog.json'),manifest=join(root,'receipt.json');
  const content=JSON.stringify({schemaVersion:1,publication:'test-v1',author:{username:'unseen_demo'},cases:[{id:'one'}]});
  const hash=createHash('sha256').update(content).digest('hex');await writeFile(source,content);await writeFile(manifest,JSON.stringify({publication:'test-v1',catalogSha256:hash,assets:[]}));
  const script=fileURLToPath(new URL('../scripts/register-app-catalog.mjs',import.meta.url));
  const run=()=>JSON.parse(execFileSync(process.execPath,[script,source,manifest,hash],{env:{...process.env,UNSEEN_API_DB:database},stdio:['ignore','pipe','pipe']}));
  assert.equal(run().replayed,false);assert.equal(run().replayed,true);
  assert.equal(f.db.prepare('SELECT count(*) n FROM app_catalog_sources').get().n,1);
  await writeFile(source,content+' ');assert.throws(run);
  assert.equal(f.db.prepare('SELECT catalog_sha256 h FROM app_catalog_sources').get().h,hash);
 }finally{f.close();await rm(root,{recursive:true,force:true});}
});
