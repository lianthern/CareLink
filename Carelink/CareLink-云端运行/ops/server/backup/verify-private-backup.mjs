import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { loadLocalKeyring } from '../../../services/api/src/crypto.mjs';

export function verifyPrivateBackup(database, keyFile) {
  const keyring=loadLocalKeyring(keyFile),db=new DatabaseSync(database,{readOnly:true});
  const counts={records:0,moments:0,media:0,mediaBytes:0};
  const activeMedia=new Map(),references=[];
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    for(const row of db.prepare('SELECT * FROM personal_memories').iterate()){
      const plaintext=keyring.open(row.document_ciphertext,`personal-memory-v1:${row.account_id}:${row.id}`,row.envelope_key_id);
      assert.equal(Buffer.byteLength(plaintext),row.byte_length);
      const document=JSON.parse(plaintext);counts.records++;
      if(row.record_kind==='moment'){
        counts.moments++;
        if(!row.deleted_at){
          for(const photo of document.photos||[]){
            references.push([row.account_id,photo.mediaId,'photo']);
            if(photo.originalMediaId)references.push([row.account_id,photo.originalMediaId,'photo']);
          }
          for(const message of document.messages||[])if(message.audio)references.push([row.account_id,message.audio.mediaId,'audio']);
        }
      }
      if(row.record_kind==='moment-media'){
        const bytes=Buffer.from(document.dataBase64,'base64');
        assert.equal(bytes.length,document.byteLength);
        assert.equal(createHash('sha256').update(bytes).digest('hex'),document.sha256);
        counts.media++;counts.mediaBytes+=bytes.length;
        if(!row.deleted_at)activeMedia.set(`${row.account_id}:${row.id}`,document.kind);
      }
    }
    for(const [owner,id,kind] of references)assert.equal(activeMedia.get(`${owner}:moment-media:${id}`),kind,'Referenced original media is missing or belongs to another account');
    return {verified:true,...counts};
  } finally {db.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try {process.stdout.write(JSON.stringify(verifyPrivateBackup(process.argv[2],process.argv[3]))+'\n');}
  catch {process.stderr.write('Private backup verification failed; no private content was printed.\n');process.exitCode=1;}
}
