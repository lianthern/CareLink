import test from 'node:test';
import assert from 'node:assert/strict';
import {sharedWorldSceneOptions} from '../public/moment-world-scene.js';
const path='/v1/viewer/spaces/space-one/world-results/world-one/media/';
test('shared World uses canonical invitation media and does not expose provider URLs',()=>{
 const result=sharedWorldSceneOptions({world:{id:'world-one',marbleUrl:'https://provider.invalid/one',panoramaUrl:path+'panorama',splats:{standard:path+'standard.spz',full:'https://cdn.marble.worldlabs.ai/full.spz'}}},{invitation:true});
 assert.equal(result.kind,'world');assert.equal(result.world.splats.standard,path+'standard.spz?access=invitation');assert.equal(result.world.splats.full,null);assert.equal(result.world.marbleUrl,null);assert.match(result.authenticity,/AI/);
 assert.equal(sharedWorldSceneOptions({world:{splats:{standard:'https://evil.invalid/private.spz'}}}),null);
});
