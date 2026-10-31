import {test} from 'node:test';
import assert from 'node:assert/strict';
import {snapshotHtml,submissionMedia,moderationError} from '../public/moment-moderation.js';
import {MomentApi,GUEST_ACCOUNT} from '../public/moment-data.js';
test('snapshot renderer never renders private or untrusted media and escapes user words',()=>{
 const html=snapshotHtml({photos:[{url:'/v1/moment-media/private'},{url:'https://outside.test/a'},{url:'/v1/public/moments/sub-1/media/photo-1/preview',name:'<img>'}],messages:[{role:'user',text:'<script>alert(1)</script>',audio:{url:'/v1/admin/submissions/sub-1/media/voice-1'}}]});
 assert.doesNotMatch(html,/src="(?:https:|\/v1\/moment-media)/);assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);assert.match(html,/controls preload="none"/);assert.match(html,/photo-1\/preview/);
 for(const url of ['javascript:alert(1)','//evil.test/a','/v1/public/moments/a/media/../../private','/v1/public/moments/a/media/b?token=x'])assert.equal(submissionMedia(url),'');
});
test('registration bypasses guest transport restrictions only with explicit null identity; mutations bind admin identity',async()=>{
 const oldFetch=globalThis.fetch,calls=[];globalThis.fetch=async(path,options)=>{calls.push({path,options});return new Response(JSON.stringify({registration:{status:'pending'}}),{status:200});};
 try{const api=new MomentApi();api.setAccount(GUEST_ACCOUNT);await assert.rejects(api.request('/v1/auth/register',{method:'POST',body:{}}),{code:'session_unavailable'});await api.request('/v1/auth/register',{method:'POST',accountId:null,body:{username:'local_test'}});assert.equal(api.accountId,GUEST_ACCOUNT);assert.equal(calls[0].options.credentials,'same-origin');assert.equal(calls[0].options.headers['X-Unseen-Expected-Account-Id'],undefined);api.setAccount('admin-id');await api.request('/v1/admin/accounts/id/status',{method:'POST',body:{expectedVersion:3,status:'active',reason:'verified'}});assert.equal(calls[1].options.headers['X-Unseen-Expected-Account-Id'],'admin-id');assert.ok(calls[1].options.headers['Idempotency-Key']);assert.equal(JSON.parse(calls[1].options.body).expectedVersion,3);}finally{globalThis.fetch=oldFetch;}
});
test('version conflicts and pending login have actionable copy',()=>{assert.match(moderationError({status:409}),/刷新/);assert.match(moderationError({code:'account_pending'}),/批准后/);});
