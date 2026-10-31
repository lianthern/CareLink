import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = process.argv[2];
if (!origin || !/^https?:\/\//.test(origin)) throw new Error('参数需为待验证的 Demo 地址');
const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname);
const setupCode = local
  ? (await readFile(path.join(root, '.data/setup-code'), 'utf8')).trim()
  : JSON.parse(await readFile(path.join(root, 'cloudbaserc.local.json'), 'utf8')).functions[0].envVariables.DEMO_SETUP_CODE;
async function call(action, data = {}, token, expected = 200) {
  const r = await fetch(new URL('/api', origin), { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify({ action, data }), signal: AbortSignal.timeout(30000) });
  const value = await r.json(); assert.equal(r.status, expected, value.error || action); return value;
}
const started = performance.now();
const health = await fetch(new URL('/api/health', origin)); assert.equal(health.status, 200);
const status = await health.json(); assert.equal(status.ok, true);
const owner = await call('create', { setupCode, name: '联调验证家庭', nickname: '测试手机' });
const invite = await call('invite', { role: 'frame' }, owner.token);
const frame = await call('join', { invite: invite.invite, nickname: '测试相框' });
const photo = await readFile(path.join(root, 'server/public/assets/today.png'));
const image = await call('upload', { base64: photo.toString('base64') }, owner.token);
const id = randomUUID();
const message = await call('send', { id, image: image.id, text: '联调测试：照片与真实文件已上传。', title: '试用照片' }, owner.token);
const repeated = await call('send', { id, image: image.id, text: '重复重试' }, owner.token); assert.equal(repeated.id, message.id);
const state = await call('state', {}, frame.token); const incoming = state.messages.find(x => x._id === message.id); assert.ok(incoming);
const downloaded = await fetch(new URL(incoming.imageURL, origin)); assert.equal(downloaded.status, 200);
assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), photo);
await call('receipt', { id: message.id }, frame.token);
const wav = Buffer.alloc(44 + 16000 * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
const audio = await call('upload', { base64: wav.toString('base64') }, frame.token);
const reply = await call('send', { id: randomUUID(), audio: audio.id, parent: message.id }, frame.token);
const received = await call('state', {}, owner.token); const voice = received.messages.find(x => x._id === reply.id); assert.ok(voice?.audioURL);
const raw = await fetch(new URL(voice.audioURL, origin)); assert.deepEqual(Buffer.from(await raw.arrayBuffer()), wav);
await call('state', {}, '0'.repeat(48), 401);
await call('invite', { role: 'family' }, frame.token, 403);
console.log(JSON.stringify({ ok: true, storage: status.storage, elapsedMs: Math.round(performance.now() - started),
  checked: ['家庭配对', '照片上传下载字节一致', '重复发送幂等', '相框送达回执', '相框音频文件回传字节一致', '无效登录拒绝', '相框权限限制'],
  limitations: ['本脚本音频为一秒静音测试数据，不等于真实麦克风验证', '未调用收费语音或模型接口', '耗时只代表当前机器到服务的路径，不代表国内三网或用户手机'],
  testRoom: '联调验证家庭'
}, null, 2));
