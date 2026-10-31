import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadLocalKeyring } from '../../../services/api/src/crypto.mjs';
import {verifyPrivateBackup} from './verify-private-backup.mjs';

function fixture(t){
  const root=mkdtempSync(path.join(tmpdir(),'private-backup-')),keyFile=path.join(root,'local.keyset.json'),file=path.join(root,'backup.sqlite');
  const keyring=loadLocalKeyring(keyFile,{allowCreate:true}),db=new DatabaseSync(file);
  db.exec('CREATE TABLE personal_memories(account_id TEXT,id TEXT,record_kind TEXT,document_ciphertext TEXT,envelope_key_id TEXT,byte_length INTEGER)');
  const put=(document)=>{const value=JSON.stringify(document);db.prepare('INSERT INTO personal_memories VALUES(?,?,?,?,?,?)').run('synthetic-account','moment-media:a','moment-media',keyring.seal(value,'personal-memory-v1:synthetic-account:moment-media:a'),keyring.keyId,Buffer.byteLength(value));};
  t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
  return {root,keyFile,file,db,put,keyring};
}
test('restore proof opens encrypted media with the backed-up key without returning private text',t=>{
  const f=fixture(t),bytes=Buffer.from('synthetic original media');
  f.put({dataBase64:bytes.toString('base64'),byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  assert.deepEqual(verifyPrivateBackup(f.file,f.keyFile),{verified:true,records:1,moments:0,media:1,mediaBytes:bytes.length});
  const wrong=path.join(f.root,'wrong-key.json');loadLocalKeyring(wrong,{allowCreate:true});
  assert.throws(()=>verifyPrivateBackup(f.file,wrong));
});
test('an intact SQLite database with invalid decrypted media is rejected',t=>{
  const f=fixture(t);f.put({dataBase64:Buffer.from('changed').toString('base64'),byteLength:7,sha256:'not-the-real-hash'});
  assert.throws(()=>verifyPrivateBackup(f.file,f.keyFile));
});

test('an intact database with a missing photo reference cannot pass restore verification',t=>{
  const f=fixture(t),bytes=Buffer.from('synthetic original media');
  f.put({kind:'photo',dataBase64:bytes.toString('base64'),byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  const text=JSON.stringify({photos:[{mediaId:'a'}],messages:[]});
  f.db.prepare('INSERT INTO personal_memories VALUES(?,?,?,?,?,?)').run('synthetic-account','moment:one','moment',f.keyring.seal(text,'personal-memory-v1:synthetic-account:moment:one'),f.keyring.keyId,Buffer.byteLength(text));
  assert.equal(verifyPrivateBackup(f.file,f.keyFile).moments,1);
  f.db.prepare("DELETE FROM personal_memories WHERE record_kind='moment-media'").run();
  assert.throws(()=>verifyPrivateBackup(f.file,f.keyFile),/Referenced original media/);
});
