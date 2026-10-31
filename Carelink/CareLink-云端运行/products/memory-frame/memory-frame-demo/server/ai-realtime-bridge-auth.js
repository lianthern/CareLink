'use strict';
const crypto = require('node:crypto');
const HASH = value => crypto.createHash('sha256').update(value).digest('hex');
const reject = (status = 401, code) => { throw Object.assign(Error('实时语音请求无效或已结束'), { status, ...(code ? { code } : {}) }); };
const LIMITS = Object.freeze({ turns: 40, inputChars: 64000, outputChars: 24000, turnMs: 45000 });
function issueGrant(room, key) {
  if (!/^[a-zA-Z0-9_-]{1,90}$/.test(room) || !/^[a-f0-9]{64}$/.test(key)) reject();
  const token = `rtb1.${room}.${key}.${crypto.randomBytes(32).toString('hex')}`;
  return { token, hash: HASH(token) };
}
function parseGrant(token) {
  if (typeof token !== 'string' || token.length > 230) reject();
  const match = /^rtb1\.([a-zA-Z0-9_-]{1,90})\.([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(token);
  if (!match) reject();
  return { room: match[1], key: match[2], hash: HASH(token), recordId: 'air_' + match[1] };
}
function validEntry(entry, grant, now) {
  return entry && typeof entry.bridgeHash === 'string' && /^[a-f0-9]{64}$/.test(entry.bridgeHash) &&
    crypto.timingSafeEqual(Buffer.from(entry.bridgeHash, 'hex'), Buffer.from(grant.hash, 'hex')) &&
    ['starting', 'active'].includes(entry.status) && entry.expiresAt > now && entry.leaseUntil > now;
}
function createBridgeAuth(store, { allowed, clock = Date.now } = {}) {
  async function check(grant) {
    const record = await store.get(grant.recordId), entry = record?.entries?.find(e => e.key === grant.key);
    if (record?.room !== grant.room || !validEntry(entry, grant, clock())) reject();
    const owner = await store.get(entry.owner);
    if (!owner || owner.kind !== 'session' || owner.room !== grant.room || owner.revoked || owner.expires <= clock() ||
      typeof allowed !== 'function' || !await allowed(owner)) reject();
    return entry;
  }
  async function authorize(token) { const grant = parseGrant(token); await check(grant); return grant; }
  async function claim(grant, requestId, inputChars, bodyHash) {
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(requestId || '') || !Number.isInteger(inputChars) || inputChars < 1 || inputChars > 16000) reject(400);
    await check(grant);
    const claimId = crypto.randomUUID(), at = clock();
    const record = await store.mutate(grant.recordId, old => {
      const entry = old?.entries?.find(e => e.key === grant.key);
      if (old?.room !== grant.room || !validEntry(entry, grant, clock())) reject();
      const budget = entry.bridgeBudget || { turns: [], inputChars: 0, outputChars: 0 };
      // A duplicate never generates again, including an interrupted/failed turn.
      if (budget.turns.some(t => t.id === requestId)) reject(409);
      // Do not steal an expired worker's claim: it might still be running on a
      // frozen instance. A crashed turn keeps this call unavailable until stop.
      if (budget.active) reject(409, 'BRIDGE_BUSY');
      if (budget.turns.length >= LIMITS.turns || budget.inputChars + inputChars > LIMITS.inputChars || budget.outputChars >= LIMITS.outputChars) reject(429);
      budget.turns.push({ id: requestId, bodyHash, at });
      budget.inputChars += inputChars;
      budget.active = { claimId, requestId, deadline: at + LIMITS.turnMs };
      entry.bridgeBudget = budget;
      return old;
    });
    return { grant, claimId, requestId, deadline: at + LIMITS.turnMs,
      outputRemaining: LIMITS.outputChars - record.entries.find(e => e.key === grant.key).bridgeBudget.outputChars };
  }
  async function validate(claim) {
    const entry = await check(claim.grant), active = entry.bridgeBudget?.active;
    if (active?.claimId !== claim.claimId || active.deadline <= clock()) reject();
    return entry;
  }
  async function release(claim, outputChars) {
    await store.mutate(claim.grant.recordId, old => {
      const entry = old?.entries?.find(e => e.key === claim.grant.key), budget = entry?.bridgeBudget;
      if (budget?.active?.claimId !== claim.claimId) return null;
      budget.outputChars += Math.min(2400, Math.max(0, outputChars));
      delete budget.active;
      return old;
    });
  }
  return { authorize, check, claim, validate, release };
}
module.exports = { issueGrant, parseGrant, createBridgeAuth, LIMITS };
