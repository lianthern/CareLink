/* Canonical account and activity transport. No tokens or private cloud cache in localStorage. */
export class UnseenAccountError extends Error {
  constructor(code, status, detail) { super(code); this.name = 'UnseenAccountError'; this.code = code; this.status = status; this.detail = detail; }
}
const segment = value => encodeURIComponent(String(value));
export class UnseenAccountApi {
  constructor({ base = '', fetch: transport = globalThis.fetch, invitationViewer = false } = {}) {
    this.invitationViewer = invitationViewer; this.base = base.replace(/\/$/, ''); this.transport = (...args) => transport(...args);
  }
  async request(path, { method = 'GET', body, version, idempotencyKey, signal, headers = {} } = {}) {
    if (!/^\/(?:v1|v2-labs)\//.test(path) || path.includes('://') || path.includes('..')) throw new Error('canonical_path_invalid');
    signal?.throwIfAborted();
    const mutation = method !== 'GET';
    if(this.invitationViewer&&!mutation&&path.startsWith('/v1/viewer/'))path+='?access=invitation';
    const response = await this.transport(`${this.base}${path}`, {
      method, credentials: 'same-origin', cache: 'no-store', signal,
      headers: { Accept: 'application/json', ...(mutation ? { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey || crypto.randomUUID() } : {}),
        ...(version !== undefined ? { 'If-Match': String(version) } : {}), ...headers },
      ...(mutation ? { body: JSON.stringify(body || {}) } : {})
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new UnseenAccountError(data?.error?.code || data?.code || 'canonical_unavailable', response.status, data);
    if (!data) throw new UnseenAccountError('canonical_response_invalid', 502);
    if(this.invitationViewer){
      const decorate=value=>{if(typeof value==='string'&&value.startsWith('/v1/viewer/')&&!value.includes('?'))return value+'?access=invitation';if(Array.isArray(value))return value.map(decorate);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,decorate(v)]));return value;};
      return decorate(data);
    }
    return data;
  }
  me(options) { return this.request('/v1/me', options); }
  spaces(options) { return this.request('/v1/me/spaces', options); }
  logout(options = {}) { return this.request('/v1/auth/logout', { ...options, method: 'POST' }); }
  challenge(options = {}) { return this.request('/v1/auth/otp-verification-challenges', { ...options, method: 'POST' }); }
  requestCode(email, proof = {}, options = {}) { return this.request('/v1/auth/email-otp-challenges', { ...options, method: 'POST', body: { email, purpose: 'login', locale: 'zh-CN', ...proof } }); }
  verifyCode(challengeId, otp, options = {}) { return this.request('/v1/auth/email-otp-verifications', { ...options, method: 'POST', body: { challengeId, otp, purpose: 'login' } }); }
  memories(options) { return this.request('/v1/me/memories', options); }
  memory(id, options) { return this.request(`/v1/me/memories/${segment(id)}`, options); }
  syncMemory(id, document, { consent = false, version = 0, expectedAccountId, ...options } = {}) {
    if (consent !== true) throw new UnseenAccountError('memory_sync_consent_required', 400);
    return this.request(`/v1/me/memories/${segment(id)}`, { ...options, method: 'POST', version, headers: {...options.headers, ...(expectedAccountId ? {'X-Unseen-Expected-Account-Id': expectedAccountId} : {})}, body: { document, consent: true } });
  }
  trashMemory(id, version, options = {}) { return this.request(`/v1/me/memories/${segment(id)}/trash`, { ...options, method: 'POST', version }); }
  restoreMemory(id, version, options = {}) { return this.request(`/v1/me/memories/${segment(id)}/restore`, { ...options, method: 'POST', version }); }
  createSpace(name, notice, options = {}) { return this.request('/v1/spaces', { ...options, method: 'POST', body: { name }, headers: { ...options.headers, 'Notice-Acknowledgement': JSON.stringify(notice) } }); }
  personalSpace(options = {}) { return this.request('/v1/me/personal-space', { ...options, method: 'POST' }); }
  management(id, options) { return this.request(`/v1/spaces/${segment(id)}/management`, options); }
  viewer(id, options) { return this.request(`/v1/viewer/spaces/${segment(id)}`, options); }
  uploadContext(id, options) { return this.request(`/v1/spaces/${segment(id)}/upload-context`, options); }
  placement(id, options) { return this.request(`/v1/photos/${segment(id)}/placement-edit`, options); }
  async admitCampaign(publicCampaignId, options = {}) {
    const body = { publicCampaignId, clientNonce: crypto.randomUUID() };
    await this.request('/v1/external-campaign-admission-challenges', { ...options, method: 'POST', body });
    return this.request('/v1/external-campaign-admissions', { ...options, method: 'POST', body });
  }
  exchangeInvite(secret, options = {}) { return this.request('/v1/external-invitation-exchanges', { ...options, method: 'POST', body: { secretFromClearedInviteBootstrap: secret, clientNonce: crypto.randomUUID() } }); }
}

// Existing canonical PoW protocol; Web Crypto yields between attempts and supports cancellation.
export async function solveAccountChallenge(challenge, { signal, timeoutMs = 20000 } = {}) {
  if (challenge?.mode === 'disabled') return {};
  if (challenge?.mode !== 'pow' || challenge.algorithm !== 'sha256-prefix-bits-v1' ||
      !Number.isInteger(challenge.difficultyBits) || challenge.difficultyBits < 0 || challenge.difficultyBits > 24) {
    throw new UnseenAccountError('otp_verification_unavailable', 503);
  }
  const started = Date.now();
  const threshold = 1n << BigInt(256 - challenge.difficultyBits);
  for (let nonce = 0; ; nonce += 1) {
    if (signal?.aborted) throw new DOMException('已取消验证', 'AbortError');
    if (Date.now() - started > timeoutMs) throw new UnseenAccountError('otp_pow_solve_timeout', 408);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${challenge.salt}:${nonce}`));
    const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    if (BigInt(`0x${hex}`) < threshold) return { verificationChallengeId: challenge.challengeId, verificationNonce: nonce };
  }
}
