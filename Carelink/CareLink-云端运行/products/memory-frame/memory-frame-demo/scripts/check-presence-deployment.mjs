// Uses existing cloud accounts/frame only. Does not create families or media, call AI,
// or read a camera. The temporary sensor is revoked in finally; no token is printed.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'https://memory-frame-demo-d7djiee0702b6c.service.tcloudbase.com';
if (!process.argv[2] || !process.argv[3]) throw Error('Pass private existing-account context and evidence output paths.');
const context = JSON.parse(await readFile(process.argv[2], 'utf8'));
const evidence = { checkedAt: new Date().toISOString(), version: '0.4.9', checks: [],
  newFamilies: 0, contentWrites: 0, modelCalls: 0, hardwareVerified: false, browserVerified: false, staticFiles: [] };
const sessions = [], deviceId = 'link2-cloud-verification';
const sha = v => createHash('sha256').update(v).digest('hex');
let stage = 'health', owner, sensorIssued = false;
async function api(action, data = {}, token, expected = 200) {
  const r = await fetch(origin + '/api', {method:'POST', headers:{'Content-Type':'application/json', ...(token ? {Authorization:'Bearer '+token}: {})},
    body:JSON.stringify({action,data}), signal:AbortSignal.timeout(30000)});
  assert.equal(r.status, expected, action+' status');
  return r.json();
}
const event = () => ({version:1,eventId:randomUUID(),source:'link2-windows',deviceId,type:'presence.dwell',occurredAt:Date.now(),dwellMs:4200,headCount:1});
const dataDigest = state => sha(JSON.stringify(state.messages.map(m => ({id:m._id,text:m.text,image:m.image,audio:m.audio,deleted:m.deleted}))));
try {
  const h = await fetch(origin+'/api/health', {signal:AbortSignal.timeout(30000)});
  assert.equal(h.status,200); const health=await h.json(); assert.equal(health.version,evidence.version); assert.equal(health.storage,'cloudbase');
  evidence.checks.push('cloud-health-version');
  stage='static';
  for (const file of ['index.html','app.js','style.css','ai-conversation.js','ai-realtime.js','account-auth.js','presence-invitation.js','presence-settings.js','presence.css','spatial-link.js','family-theme.css','frame-presentation.js','frame-presentation.css','family-call.js','family-call.css']) {
    const local=await readFile(path.join(root,'server/public',file));
    const r=await fetch(origin+'/'+file,{signal:AbortSignal.timeout(30000)}); assert.equal(r.status,200);
    const remote=Buffer.from(await r.arrayBuffer()); assert.equal(sha(local),sha(remote));
    evidence.staticFiles.push({file,bytes:local.length,sha256:sha(local)});
  }
  stage='existing-authentication';
  for (const credential of context.credentials) { const s=await api('login',{username:credential.username,password:credential.password}); sessions.push(s); }
  owner=sessions.find(s=>s.role==='owner'); const member=sessions.find(s=>s.role==='family'); assert.ok(owner&&member&&context.frame?.token);
  const before=await api('state',{},owner.token); const initialDigest=dataDigest(before);
  const callCaps=await api('callCapabilities',{},owner.token);
  evidence.familyCallEnabled=Boolean(callCaps.enabled);
  assert.equal(callCaps.enabled,false);
  evidence.checks.push('family-call-disabled-without-configuration');
  const realtime=await api('aiRealtimeCapabilities',{},owner.token);
  assert.equal(realtime.enabled,false);
  const conversation=await api('aiCapabilities',{},owner.token);
  assert.equal(conversation.text,true); assert.equal(conversation.vision,true);
  evidence.checks.push('realtime-disabled-text-and-vision-still-configured');
  const frameToken=context.frame.token, frameId='s_'+sha(frameToken);
  const paired=await api('state',{},frameToken); assert.equal(paired.role,'frame'); assert.equal(paired.room.id,owner.room);
  const listed=await api('presenceSensorList',{},owner.token); assert.ok(listed.frames.some(f=>f.id===frameId));
  await api('presenceSensorList',{},member.token,403);
  await api('presenceReport',event(),undefined,401);
  await api('presenceReport',event(),owner.token,401);
  evidence.checks.push('separate-sensor-auth-and-owner-management');
  stage='issue-and-report';
  // A fixed verification id can be safely reused after previous verification cleanup.
  if (listed.sensors.some(s=>s.deviceId===deviceId)) await api('presenceSensorRevoke',{deviceId},owner.token);
  const issued=await api('presenceSensorIssue',{deviceId,targetFrameId:frameId},owner.token); sensorIssued=true;
  assert.ok(issued.token); const payload=event();
  const concurrent=await Promise.all(Array.from({length:3},()=>api('presenceReport',payload,issued.token)));
  const first=concurrent[0]; assert.ok(concurrent.every(result=>result.seq===first.seq));
  assert.equal(first.accepted,true); assert.equal(first.eventId,payload.eventId);
  const duplicate=await api('presenceReport',payload,issued.token); assert.equal(duplicate.seq,first.seq);
  const target=await api('state',{},frameToken); assert.equal(target.presenceEvent?.eventId,payload.eventId); assert.equal(target.presenceEvent.seq,first.seq);
  assert.equal(target.presenceEvent.expiresAt-target.presenceEvent.receivedAt,15000);
  assert.equal((await api('state',{},owner.token)).presenceEvent,undefined);
  assert.equal((await api('state',{},member.token)).presenceEvent,undefined);
  evidence.checks.push('report-accepted-and-persistent-idempotency','target-only-state-event');
  stage='expiry';
  await new Promise(resolve=>setTimeout(resolve,16000));
  const retry=await api('presenceReport',payload,issued.token); assert.equal(retry.seq,first.seq);
  assert.equal((await api('state',{},frameToken)).presenceEvent,undefined);
  evidence.checks.push('expired-retry-does-not-renew-event');
  stage='rotation-and-revocation';
  const rotated=await api('presenceSensorRotate',{deviceId},owner.token); assert.ok(rotated.token&&rotated.token!==issued.token);
  await api('presenceReport',event(),issued.token,401);
  await api('presenceReport',payload,rotated.token,409);
  await api('presenceReport',{...event(),headCount:11},rotated.token,400);
  const next=event(); const accepted=await api('presenceReport',next,rotated.token); assert.ok(accepted.seq>first.seq);
  await api('presenceSensorRevoke',{deviceId},owner.token); sensorIssued=false;
  await api('presenceReport',next,rotated.token,401);
  assert.equal((await api('state',{},frameToken)).presenceEvent,undefined);
  evidence.checks.push('rotation-invalidates-old-token-and-does-not-resurrect-event','invalid-head-count-rejected','revoke-stops-event-delivery');
  const after=await api('state',{},owner.token); assert.equal(dataDigest(after),initialDigest); assert.equal(after.messagePage.total,before.messagePage.total);
  evidence.messageCount=after.messagePage.total; evidence.checks.push('existing-content-unchanged'); evidence.passed=true;
} catch(error) {
  evidence.passed=false; evidence.failure={stage,reason:error instanceof assert.AssertionError ? 'Expected contract did not match response' : 'Network, file or verification failure'};
} finally {
  if(sensorIssued&&owner) {try {await api('presenceSensorRevoke',{deviceId},owner.token);}catch {evidence.passed=false;evidence.sensorCleanupFailed=true;}}
  for(const s of sessions) {try {await api('logout',{},s.token);await api('state',{},s.token,401);}catch {evidence.passed=false;evidence.sessionCleanupFailed=true;}}
}
await writeFile(process.argv[3],JSON.stringify(evidence,null,2)+'\n'); console.log(JSON.stringify(evidence,null,2));
process.exitCode=evidence.passed?0:1;
