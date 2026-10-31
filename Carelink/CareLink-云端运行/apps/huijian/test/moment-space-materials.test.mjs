import test from 'node:test';
import assert from 'node:assert/strict';
import {materialFacts,materialWorldEligible,materialDraftId} from '../public/moment-space-materials.js';

const photo={id:'photo',type:'image/jpeg',width:2048,height:1536,bytes:200000};
const pano={id:'pano',type:'image/jpeg',width:4096,height:2048,bytes:300000};
const config={enabled:true,minImages:2,maxImages:8,maxImageBytes:12000000,maxTotalImageBytes:24000000};
test('mixed material routing respects exclusions, supported panorama dimensions and unavailable metadata',()=>{
  const video={id:'video',type:'video/mp4',width:1920,height:1080,bytes:1000000};
  const unreadable={id:'heic',type:'image/heic',metadataUnavailable:true,bytes:200000};
  const facts=materialFacts([photo,pano,video,unreadable,{...photo,id:'excluded',selected:false}]);
  assert.deepEqual(facts.photos.map(x=>x.id),['photo','pano','heic']);
  assert.deepEqual(facts.videos.map(x=>x.id),['video']);
  assert.deepEqual(facts.panoramas.map(x=>x.id),['pano']);
  assert.deepEqual(facts.world.map(x=>x.id),['photo']);
  const corrected=materialFacts([{...pano,forcePhoto:true}]);assert.equal(corrected.panoramas.length,0);assert.equal(corrected.world.length,1);
  for(const item of [{...pano,width:1200,height:600},{...pano,width:10000,height:5000},{...pano,bytes:13*1048576}])assert.equal(materialFacts([item]).panoramas.length,0);
});
test('AI choices require actual service limits; no network state cannot enable generation',()=>{
  assert.equal(materialWorldEligible([photo],null),false);
  assert.equal(materialWorldEligible([photo],{...config,enabled:false}),false);
  assert.equal(materialWorldEligible([photo],config),true);
  assert.equal(materialWorldEligible([photo,photo],config),true);
  assert.equal(materialWorldEligible([],config),false);
  assert.equal(materialWorldEligible(Array(9).fill(photo),config),false);
  assert.equal(materialWorldEligible([{...photo,bytes:12000001}],config),false);
  assert.equal(materialWorldEligible(Array(3).fill({...photo,bytes:9000000}),config),false);
  assert.equal(materialWorldEligible([photo],{enabled:true,minImages:2,maxImages:8}),false);
});
test('recovery keys separate accounts, spaces and delimiter-like identifiers',()=>{
  assert.notEqual(materialDraftId('owner-a','space'),materialDraftId('owner-b','space'));
  assert.notEqual(materialDraftId('owner-a','space'),materialDraftId('owner-a','other'));
  assert.notEqual(materialDraftId('a:b','c'),materialDraftId('a','b:c'));
});
