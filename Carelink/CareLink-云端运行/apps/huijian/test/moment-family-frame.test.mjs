import test from 'node:test';
import assert from 'node:assert/strict';
import {dedupeFamilyPeople,familyRoute,familyPhotoStatus} from '../public/moment-family-frame.js';

test('family frame routes accept only the account-scoped frame forms',()=>{
  assert.deepEqual(familyRoute('family-frame'),{spaceId:null});
  assert.deepEqual(familyRoute('#family-frame/space_123?tab=photos'),{spaceId:'space_123'});
  for(const route of ['family-frame/../other','family-frame/<img>','family-frame/'])assert.equal(familyRoute(route),null);
});

test('family frame status keeps call priority above message and photo rings',()=>{
  assert.equal(familyPhotoStatus({}, {newPhoto:true}),'yellow');
  assert.equal(familyPhotoStatus({}, {newStory:true}),'blue');
  assert.equal(familyPhotoStatus({}, {newPhoto:true,newStory:true}),'blue');
  assert.equal(familyPhotoStatus({}, {calling:true,newPhoto:true,newStory:true}),'green');
});

test('family frame people use real identities and omit anonymous uploader placeholders',()=>{
  assert.deepEqual(dedupeFamilyPeople([
    {id:'u1',displayName:'奶奶'},
    {id:'u1',displayName:'奶奶'},
    {name:' 爷爷 '},
    {name:'爷爷'},
    {name:'空间成员'},
    {name:'家庭成员'},
    {name:'同行者'},
  ]).map(person=>person.name),['奶奶','爷爷']);
  assert.deepEqual(dedupeFamilyPeople([{name:'空间成员'},{name:'家庭成员'}]),[]);
});
