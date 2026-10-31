'use strict';
// Private photo objects only. Health, medication and voice records never enter this interface.
const crypto = require('node:crypto');
class StorageError extends Error {
 constructor(code, retryable = false) { super(code); this.code = code; this.retryable = retryable; }
}
function validate(input) {
 if (!input || !/^[\w-]{1,120}$/.test(input.room || '') || !/^[\w-]{1,120}$/.test(input.id || '') || !['image/jpeg','image/png'].includes(input.mime) || !Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > 3000000 || !/^[a-f0-9]{64}$/.test(input.sha256 || '')) throw new StorageError('INVALID_PHOTO');
 return 'carelink/photos/' + input.room + '/' + input.id;
}
function createLocalPhotoStorage({now = Date.now, ttlMs = 60000} = {}) {
 const pending = new Map(), objects = new Map(), grants = new Map();
 function grant(kind, key) { const token = crypto.randomBytes(24).toString('hex'); grants.set(token,{kind,key,expiresAt:now()+ttlMs}); return {token,expiresAt:now()+ttlMs}; }
 function resolve(token,kind) { const g=grants.get(token); if(!g || g.kind!==kind)throw new StorageError('INVALID_GRANT'); if(now()>=g.expiresAt)throw new StorageError('GRANT_EXPIRED',true); return g.key; }
 return {
  provider:'local-fake', region:'local-test-only',
  async prepare(input) { const key=validate(input), old=pending.get(key)||objects.get(key); if(old && old.sha256!==input.sha256)throw new StorageError('ID_CONFLICT'); pending.set(key,Object.assign({},input)); return Object.assign({key,method:'PUT',provider:'local-fake'},grant('write',key)); },
  async put(token,bytes) { const key=resolve(token,'write'), meta=pending.get(key); if(!Buffer.isBuffer(bytes)||bytes.length!==meta.bytes||crypto.createHash('sha256').update(bytes).digest('hex')!==meta.sha256)throw new StorageError('INTEGRITY_MISMATCH'); objects.set(key,Object.assign({},meta,{body:Buffer.from(bytes)})); return {key}; },
  async complete(input) { const key=validate(input), obj=objects.get(key); if(!obj)throw new StorageError('UPLOAD_INCOMPLETE',true); if(obj.sha256!==input.sha256||obj.bytes!==input.bytes)throw new StorageError('INTEGRITY_MISMATCH'); return {id:input.id,key,provider:'local-fake',sha256:obj.sha256}; },
  async read({room,id}) { const key='carelink/photos/'+room+'/'+id; if(!objects.has(key))throw new StorageError('PHOTO_NOT_FOUND'); return Object.assign({key,provider:'local-fake'},grant('read',key)); },
  async get(token) { const key=resolve(token,'read'); return Buffer.from(objects.get(key).body); }
 };
}
function createCosPhotoStorage({approved = false, client = null, bucket = '', region = 'ap-shanghai'} = {}) {
 function ready() { if(!approved)throw new StorageError('COS_APPROVAL_REQUIRED'); if(!client||!bucket||region!=='ap-shanghai')throw new StorageError('COS_NOT_CONFIGURED'); }
 // client is deliberately injected: no SDK, ambient credentials, bucket creation or network on construction.
 return {
  provider:'cos', region,
  async prepare(input) { const key=validate(input); ready(); return client.preparePrivateUpload({bucket,region,key,mime:input.mime,bytes:input.bytes,sha256:input.sha256,expiresIn:60}); },
  async complete(input) { const key=validate(input); ready(); const obj=await client.headPrivateObject({bucket,region,key}); if(!obj||obj.bytes!==input.bytes||obj.sha256!==input.sha256)throw new StorageError('INTEGRITY_MISMATCH'); return {id:input.id,key,provider:'cos',sha256:input.sha256}; },
  async read({room,id}) { if(!/^[\w-]{1,120}$/.test(room||'')||!/^[\w-]{1,120}$/.test(id||''))throw new StorageError('INVALID_PHOTO'); ready(); return client.signPrivateRead({bucket,region,key:'carelink/photos/'+room+'/'+id,expiresIn:60}); }
 };
}
module.exports={StorageError,createLocalPhotoStorage,createCosPhotoStorage};
