import test from 'node:test';
import assert from 'node:assert/strict';
import { createMomentGuest } from '../lib/moment-guest.mjs';
import { MomentApi, GUEST_ACCOUNT } from '../public/moment-data.js';

test('guest cookie is scoped, signed, expiring, and cannot authenticate accounts', () => {
  let now=1788580000000;
  const guest=createMomentGuest({now:()=>now,ttlMs:10000}), req={headers:{'x-forwarded-proto':'https'}};
  const cookie=guest.issue(req);assert.match(cookie,/HttpOnly; SameSite=Strict/);assert.match(cookie,/Path=\/api\//);assert.match(cookie,/; Secure$/);
  req.headers.cookie=cookie.split(';')[0];const identity=guest.authenticate(req);assert.match(identity.accountId,/^guest:/);
  assert.equal(guest.issue(req),cookie,'renewing a valid cookie preserves idempotency scope');
  assert.throws(()=>guest.authenticate({headers:{cookie:req.headers.cookie,'x-unseen-expected-account-id':'account-a'}}),{code:'account_changed'});
  assert.throws(()=>guest.authenticate({headers:{cookie:req.headers.cookie.replace(/.$/,'!')}}),{code:'guest_session_expired'});
  now+=10001;assert.throws(()=>guest.authenticate(req),{code:'guest_session_expired'});
  assert.notEqual(guest.issue(req),cookie);
});

test('browser guest requests cannot reach private API and renew only the guest capability with frozen body', async () => {
  const saved=globalThis.fetch,calls=[];let ready=false;
  globalThis.fetch=async(path,options)=>{calls.push({path,...options});if(path==='/api/moment-guest'){ready=true;return Response.json({guest:true});}return ready?Response.json({message:{id:'answer'}}):Response.json({error:'guest_session_expired'},{status:401});};
  try{
    const api=new MomentApi();api.setAccount(GUEST_ACCOUNT);
    await assert.rejects(api.request('/v1/moments'),{code:'session_unavailable'});assert.equal(calls.length,0);
    const body={requestId:'stable-id',momentId:'draft-id'};
    const response=await api.request('/api/moment-chat',{method:'POST',key:'stable-id',body});assert.equal(response.message.id,'answer');
    assert.deepEqual(calls.map(x=>x.path),['/api/moment-chat','/api/moment-guest','/api/moment-chat']);
    assert.equal(calls[0].body,calls[2].body);assert.equal(calls[0].headers['Idempotency-Key'],calls[2].headers['Idempotency-Key']);
    for(const call of calls){assert.equal(call.headers['X-Unseen-Moment-Guest'],'1');assert.equal(call.headers['X-Unseen-Expected-Account-Id'],undefined);}
  }finally{globalThis.fetch=saved;}
});
