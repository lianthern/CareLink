'use strict';
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const ACTIONS = new Set(['upload', 'send', 'uploadStatus', 'logout']);
const TOKEN = /^[a-f0-9]{48}$/;
const VISITOR = /^(?:[a-f0-9]{48}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
function createOnsiteUpload(store, { clock = Date.now } = {}) {
  function valid(inv) {
    if (!inv || inv.kind !== 'upload-invite' || inv.revoked || inv.expires <= clock()) fail('上传链接已到期或关闭，请向现场工作人员索取新二维码', 403);
    return inv;
  }
  async function invitation(token) {
    if (typeof token !== 'string' || !TOKEN.test(token)) fail('上传链接不完整', 400);
    return valid(await store.get('ui_' + hash(token)));
  }
  async function authorize(s) {
    if (s.role !== 'contributor') return;
    const inv = valid(await store.get(s.uploadInvite));
    if (inv.room !== s.room) fail('上传身份无效', 403);
  }
  async function publicAction(action, data) {
    const inv = await invitation(data.invite);
    if (action === 'uploadInfo') return { label: inv.label, expires: inv.expires, remaining: Math.max(0, inv.limit - Object.keys(inv.claims || {}).length) };
    if (!VISITOR.test(data.visitor || '')) fail('请刷新页面后重试');
    const token = crypto.createHmac('sha256', inv.sessionKey).update(data.visitor).digest('hex').slice(0, 48);
    const id = 's_' + hash(token);
    const name = typeof data.nickname === 'string' ? data.nickname.trim().slice(0, 30) : '';
    await store.mutate(inv._id, current => {
      valid(current);
      const visitors = current.visitors || {};
      const key = hash(data.visitor);
      if (visitors[key]) return null;
      if (Object.keys(visitors).length >= 200) fail('本次现场上传人数已满，请向工作人员索取新二维码', 429);
      return { ...current, visitors: { ...visitors, [key]: true } };
    });
    const existing = await store.get(id);
    if (existing?.revoked) fail('这个上传身份已退出，请重新打开页面并创建新的访客身份', 403);
    if (!existing) {
      try { await store.put({ _id: id, kind: 'session', room: inv.room, role: 'contributor', name: name || '现场访客',
        uploadInvite: inv._id, expires: inv.expires, lastSeen: clock() }, true); }
      catch (error) { if (!await store.get(id)) throw error; }
    }
    const s = await store.get(id);
    await authorize(s);
    if (s.revoked) fail('这个上传身份已退出', 403);
    return { token, room: s.room, role: s.role, name: s.name };
  }
  async function manage(action, data, s) {
    if (s.role !== 'owner') fail('仅家庭管理员可管理上传链接', 403);
    if (action === 'revokeUploadInvite') {
      await store.mutate(typeof data.id === 'string' ? data.id : '', inv => {
        if (!inv || inv.kind !== 'upload-invite' || inv.room !== s.room) fail('上传链接不存在', 404);
        return { ...inv, revoked: true };
      });
      return { ok: true };
    }
    const limit = data.limit === undefined ? 60 : data.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('每个上传链接允许 1–100 张照片');
    const invite = crypto.randomBytes(24).toString('hex'), id = 'ui_' + hash(invite), expires = clock() + 86400000;
    const label = typeof data.label === 'string' ? data.label.trim().slice(0, 40) : '';
    await store.put({ _id: id, kind: 'upload-invite', room: s.room, label: label || '给现场的相框送照片', expires, limit,
      sessionKey: crypto.randomBytes(32).toString('hex'), claims: {}, visitors: {} }, true);
    return { id, invite, expires, limit };
  }
  async function reserve(s, id) {
    if (s.role !== 'contributor') return;
    await store.mutate(s.uploadInvite, inv => {
      valid(inv);
      if (inv.room !== s.room) fail('上传身份无效', 403);
      const claims = inv.claims || {};
      if (claims[id]) return null;
      if (Object.keys(claims).length >= inv.limit) fail('本次上传名额已满，请向工作人员索取新二维码', 429);
      return { ...inv, claims: { ...claims, [id]: true } };
    });
  }
  async function status(data, s) {
    if (s.role !== 'contributor') fail('请使用现场上传入口', 403);
    if (!Array.isArray(data.ids) || data.ids.length > 20 || data.ids.some(id => typeof id !== 'string' || id.length > 160)) fail('发送记录无效');
    const items = [];
    for (const id of [...new Set(data.ids)]) {
      const m = await store.get(id);
      if (!m || m.kind !== 'message' || m.room !== s.room || m.author !== s._id || m.deleted) fail('发送记录不存在', 404);
      const r = await store.get('a_' + id);
      items.push({ id, received: Boolean(r?.deliveredAt), deliveredAt: r?.deliveredAt || null });
    }
    return { items };
  }
  return { authorize, publicAction, manage, reserve, status, allowed: action => ACTIONS.has(action) };
}
module.exports = { createOnsiteUpload };
