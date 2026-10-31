export const newId = () => crypto.randomUUID();
export const GUEST_ACCOUNT = 'guest-local';
export function newMoment(preferences = {}) {
  const now = new Date().toISOString();
  return { id: newId(), title: '', createdAt: now, updatedAt: now, status: 'active', photos: [], messages: [], context: {}, preferences: { photoMode: preferences.photoMode || 'reveal' } };
}
export function appendMessage(moment, message) {
  if (moment.messages.some(item => item.id === message.id)) return moment;
  return { ...moment, updatedAt: new Date().toISOString(), messages: [...moment.messages, message] };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Conflicting edits must remain recoverable; only merge unambiguous changes.
export function mergeMoment(base, local, remote) {
  if (!base || local.id !== remote.id || base.id !== local.id) return null;
  const merged = { ...remote };
  for (const key of ['title', 'status', 'preferences', 'archivedAt']) {
    const a = !same(local[key], base[key]), b = !same(remote[key], base[key]);
    if (a && b && !same(local[key], remote[key])) return null;
    if (a) merged[key] = local[key];
  }
  for (const key of ['photos', 'messages']) {
    const baseline = new Map(base[key].map(x => [x.id, x])), left = new Map(local[key].map(x => [x.id, x])), right = new Map(remote[key].map(x => [x.id, x]));
    for (const [id, old] of baseline) {
      if (!left.has(id) || !right.has(id)) return null;
      if (!same(left.get(id), old) && !same(right.get(id), old) && !same(left.get(id), right.get(id))) return null;
    }
    for (const [id, value] of left) if (!baseline.has(id) && right.has(id) && !same(value, right.get(id))) return null;
    merged[key] = remote[key].map(x => baseline.has(x.id) && !same(left.get(x.id), baseline.get(x.id)) ? left.get(x.id) : x);
    for (const item of local[key]) if (!right.has(item.id)) merged[key].push(item);
    if (key === 'messages') merged[key].sort((a,b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
  }
  merged.context = {}; merged.updatedAt = new Date().toISOString(); return merged;
}
export function messageTextHistory(moment) {
  return moment.messages.filter(x => ['user', 'assistant'].includes(x.role) && x.text?.trim()).map(({ id, role, text, photoId, createdAt }) => ({ id, role, text, photoId, createdAt }));
}
export const momentTitle = moment => moment.title?.trim() || '未命名的回忆';
export const momentPreview = moment => [...(moment.messages || [])].reverse().find(x => x.role === 'user' && x.text)?.text || (moment.status === 'complete' ? '这一刻，已经留下。' : '还有故事，等你慢慢说。');
export function safeMediaUrl(value) { return typeof value === 'string' && /^\/v1\/moment-media\/[a-zA-Z0-9_-]+(?:\/preview)?$/.test(value) ? value : ''; }
export class MomentApiError extends Error { constructor(code, status, data) { super(code); this.code = code; this.status = status; this.data = data; } }
export class MomentApi {
  constructor() { this.accountId = null; this.abort = new AbortController(); }
  setAccount(id) { this.abort.abort(); this.abort = new AbortController(); this.accountId = id; }
  async request(path, { method = 'GET', body, key, signal, version, notice, headers = {}, accountId = this.accountId, guestRetry = true } = {}) {
    const guest = accountId === GUEST_ACCOUNT;
    if (guest && !/^\/api\/moment-(config|chat|transcribe|guest)$/.test(path)) throw new MomentApiError('session_unavailable', 401);
    const controller = this.abort;
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const check = () => { requestSignal.throwIfAborted(); if (this.abort !== controller) throw new DOMException('Account changed', 'AbortError'); };
    const mutation = !['GET', 'HEAD'].includes(method);
    const extraHeaders = Object.fromEntries(Object.entries(headers).filter(([name]) => ['if-match','notice-acknowledgement','x-space-version','x-item-version','x-batch-version','x-placement-authorization-version'].includes(name.toLowerCase())));
    if (version !== undefined) extraHeaders['If-Match'] = String(version);
    if (notice !== undefined) extraHeaders['Notice-Acknowledgement'] = JSON.stringify(notice);
    const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', signal: requestSignal,
      headers: { ...extraHeaders, Accept: 'application/json', ...(guest ? { 'X-Unseen-Moment-Guest': '1' } : accountId ? { 'X-Unseen-Expected-Account-Id': accountId } : {}), ...(mutation ? { 'Content-Type': 'application/json', 'Idempotency-Key': key || newId() } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    check();
    const data = await response.json().catch(error => { if (error.name === 'AbortError') throw error; return null; });
    check();
    if (!response.ok) {
      if (guest && guestRetry && data?.error === 'guest_session_expired') {
        await this.request('/api/moment-guest', { method: 'POST', body: {}, accountId, signal: requestSignal, guestRetry: false }); check();
        return this.request(path, { method, body, key, version, notice, headers, signal: requestSignal, accountId, guestRetry: false });
      }
      throw new MomentApiError(data?.error?.code || data?.error || 'network_error', response.status, data);
    }
    const responseAccountId = data?.accountId || data?.user?.id;
    if (accountId && responseAccountId && accountId !== responseAccountId) throw new MomentApiError('account_changed', 409);
    return data;
  }
}
export function openMomentCache(indexedDB = globalThis.indexedDB) {
  let opening;
  const open = () => opening ||= new Promise((resolve, reject) => {
    if (!indexedDB) { reject(new Error('cache_unavailable')); return; }
    const req = indexedDB.open('unseen-memory-moment', 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('documents', { keyPath: 'key' }); req.result.createObjectStore('media', { keyPath: 'key' }); };
    req.onerror = () => { opening = null; reject(req.error); }; req.onsuccess = () => resolve(req.result);
  });
  const transact = async (store, mode, execute) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode); let result;
      tx.oncomplete = () => resolve(result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('cache_unavailable'));
      const request = execute(tx.objectStore(store)); if (request) request.onsuccess = () => { result = request.result; };
    });
  };
  const key = (account, id) => `${account}:${id}`;
  return {
    async put(accountId, record, { expectedCacheVersion } = {}) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('documents', 'readwrite'), s = tx.objectStore('documents'); let failure, result;
        tx.oncomplete = () => resolve(result); tx.onerror = tx.onabort = () => reject(failure || tx.error || new Error('cache_unavailable'));
        const req = s.get(key(accountId, record.moment.id));
        req.onsuccess = () => {
          const prior = req.result;
          if (prior?.claimedBy) { failure = new MomentApiError('draft_claimed', 409); tx.abort(); return; }
          const cacheVersion = Number(prior?.cacheVersion) || 0;
          if (expectedCacheVersion !== undefined && expectedCacheVersion !== cacheVersion) {
            const metadata = new Set(['key','accountId','cacheVersion']);
            if(prior&&[...new Set([...Object.keys(prior),...Object.keys(record)])].every(field=>metadata.has(field)||same(prior[field],record[field]))){result={cacheVersion};return;}
            // Compare and preserve in the SAME transaction. Another tab cannot
            // claim the original between the check and saving this page's work.
            const recoveryId = newId(), now = new Date().toISOString();
            const recoveredRecord = { ...record, accountId, key: key(accountId, recoveryId), cacheVersion: 1,
              moment: { ...record.moment, id: recoveryId, title: `${momentTitle(record.moment)} · 此页副本`, createdAt: now },
              version: 0, base: null, dirty: true, pendingWrite: null, pendingAI: null, conflict: null };
            s.add(recoveredRecord);
            result = { cacheVersion: 1, recoveredRecord, latestRecord: prior };
            return;
          }
          result = { cacheVersion: cacheVersion + 1 };
          s.put({ ...record, key: key(accountId, record.moment.id), accountId, cacheVersion: result.cacheVersion });
        };
      });
    },
    async get(accountId, id) { const r = await transact('documents','readonly',s => s.get(key(accountId,id))); return r?.claimedBy ? undefined : r; },
    async list(accountId) { return (await transact('documents','readonly',s => s.getAll())).filter(r => r.accountId === accountId && !r.claimedBy); },
    // Transfer document and referenced original Blobs in ONE IndexedDB transaction.
    // The claim marker also stops another tab from reviving or claiming this draft.
    async claimGuest(id, accountId) {
      if (!accountId || accountId === GUEST_ACCOUNT) throw new Error('account_required');
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(['documents', 'media'], 'readwrite'), docs = tx.objectStore('documents'), media = tx.objectStore('media'); let failure;
        const fail = code => { failure = new MomentApiError(code, 409); tx.abort(); };
        tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(failure || tx.error || new Error('cache_unavailable'));
        const req = docs.get(key(GUEST_ACCOUNT, id));
        req.onsuccess = () => {
          const source = req.result;
          if (!source) return fail('draft_unavailable');
          if (source.claimedBy) { if (source.claimedBy !== accountId) fail('draft_claimed'); return; }
          const ids = new Set([
            ...source.moment.photos.flatMap(p => [p.mediaId, p.originalMediaId]),
            ...source.moment.messages.map(m => m.audio?.mediaId),
            ...(source.pendingPhotos || []).flatMap(p => [p.originalId, p.previewId]), source.pendingVoice?.mediaId
          ].filter(Boolean));
          const cloudMedia = [...new Set([...source.moment.photos.flatMap(p => [p.mediaId, p.originalMediaId]), ...source.moment.messages.map(m => m.audio?.mediaId)].filter(Boolean))];
          const target = { ...source, key: key(accountId, id), accountId, version: 0, base: null, dirty: true, pendingWrite: null, cloudMedia };
          if (target.pendingVoice) target.pendingVoice = { ...target.pendingVoice, receipt: null };
          for (const mediaId of ids) {
            const blob = media.get(key(GUEST_ACCOUNT, mediaId));
            blob.onsuccess = () => {
              if (!blob.result?.blob) {
                // An unfinished photo may not have its preview yet; retry generates it.
                if (source.pendingPhotos?.some(p => p.previewId === mediaId)) { target.cloudMedia = target.cloudMedia.filter(x => x !== mediaId); docs.put(target); return; }
                fail('cache_unavailable'); return;
              }
              media.put({ ...blob.result, key: key(accountId, mediaId), accountId });
            };
          }
          docs.put(target); docs.put({ ...source, claimedBy: accountId });
        };
      });
    },
    putMedia: (accountId, id, blob, meta = {}) => transact('media','readwrite',s => s.put({ ...meta, key:key(accountId,id), accountId, id, blob })),
    getMedia: (accountId, id) => transact('media','readonly',s => s.get(key(accountId,id))),
    removeMedia: (accountId, id) => transact('media','readwrite',s => s.delete(key(accountId,id)))
  };
}
export function blobToDataUrl(blob) { return new Promise((resolve,reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(r.error); r.readAsDataURL(blob); }); }
export async function preparePhoto(file) {
  if (!file || file.size > 12 * 1024 * 1024) throw new MomentApiError('photo_too_large',400);
  if (!file.type.startsWith('image/') && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) throw new MomentApiError('photo_format',400);
  const src = URL.createObjectURL(file);
  try {
    const image = new Image(); image.src = src;
    try { await image.decode(); } catch { throw new MomentApiError(/hei[cf]/i.test(file.type + file.name) ? 'heic_conversion_required' : 'photo_decode',400); }
    const scale = Math.min(1,1600 / Math.max(image.naturalWidth,image.naturalHeight));
    const canvas = document.createElement('canvas'); canvas.width = Math.round(image.naturalWidth * scale); canvas.height = Math.round(image.naturalHeight * scale);
    canvas.getContext('2d',{alpha:false}).drawImage(image,0,0,canvas.width,canvas.height);
    const preview = await new Promise(resolve => canvas.toBlob(resolve,'image/jpeg',.9));
    if (!preview) throw new MomentApiError('photo_decode',400);
    return { preview, original:file, width:canvas.width, height:canvas.height };
  } finally { URL.revokeObjectURL(src); }
}
