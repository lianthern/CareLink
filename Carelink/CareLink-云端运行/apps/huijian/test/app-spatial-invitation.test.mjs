import test from 'node:test';
import assert from 'node:assert/strict';
import {UnseenAccountApi} from '../public/unseen-account-api.js';
test('read-only invitation viewing selects the live visitor grant for JSON and nested media, without changing account requests',async()=>{
 const calls=[];const api=new UnseenAccountApi({invitationViewer:true,fetch:async(path,options)=>{calls.push({path,options});return new Response(JSON.stringify({panorama:{url:'/v1/viewer/spaces/event/panorama-revisions/rev/media'},private:'/v1/moment-media/private',photos:[{assetUrl:'/v1/viewer/spaces/event/photos/photo/media'}]}),{status:200,headers:{'content-type':'application/json'}});}});
 const result=await api.viewer('event');assert.equal(calls[0].path,'/v1/viewer/spaces/event?access=invitation');assert.equal(calls[0].options.credentials,'same-origin');
 assert.equal(result.panorama.url,'/v1/viewer/spaces/event/panorama-revisions/rev/media?access=invitation');assert.equal(result.photos[0].assetUrl,'/v1/viewer/spaces/event/photos/photo/media?access=invitation');assert.equal(result.private,'/v1/moment-media/private');
 await api.me();assert.equal(calls[1].path,'/v1/me');await api.logout();assert.equal(calls[2].path,'/v1/auth/logout');
});
