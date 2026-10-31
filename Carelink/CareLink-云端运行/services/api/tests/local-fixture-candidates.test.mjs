import test from 'node:test';
import assert from 'node:assert/strict';
import {createDeterministicLocator} from '../../../infra/integration/local-locator-fixture.mjs';
import {LOCAL_LOCATOR_FIXTURE_RELEASE_ID} from '../src/ports/locator/deterministic-locator-fixture.mjs';
import {dispatchOne} from '../../jobs/dispatch/index.mjs';
import {fixture,createAccountUpload} from './fixture-factory.mjs';
const config={fixture:{releaseId:LOCAL_LOCATOR_FIXTURE_RELEASE_ID,unknownInputClassification:'uncertain'}};
test('local candidates are explicit opt-in and retain simulated provenance',()=>{
 const refs={photoId:'photo_local',panoramaRevisionId:'panorama_local'};
 assert.equal(createDeterministicLocator(config).outcome(refs).candidates,undefined);
 const enabled=createDeterministicLocator(config,{candidateDirections:true});
 assert.equal(enabled.outcome(refs).locatorProvenance.isProduction,false);
 assert.equal(enabled.outcome(refs).locatorProvenance.syntheticCandidateDirections,true);
 assert.equal(enabled.outcome(refs,'failed').candidates,undefined);
});
test('local fixture candidates dispatch through jobs and owner confirms a server-issued candidate',async()=>{
 const f=fixture();try{
 const owner=await f.login('fixture-candidates@example.test');
 const space=await f.openSpace(owner,await f.createSpace(owner));
 const locator=createDeterministicLocator(config,{candidateDirections:true});
 const flow=await createAccountUpload(f,owner,space);
 const valid=dispatchOne(f.db,flow.committed.jobId,{now:f.clock.iso(),locatorFixture:locator});
 const result=dispatchOne(f.db,valid.placementJobId,{now:f.clock.iso(),locatorFixture:locator});
 assert.equal(result.placementState,'needs_confirmation');assert.ok(result.suggestionId);
 const view=await f.ok('GET',`/v1/photos/${flow.committed.photoId}/placement-edit`,undefined,owner.headers);
 assert.equal(view.candidates[0].yaw,25);
 const headers={...owner.headers,'if-match':String(view.photoVersion),'x-item-version':String(view.itemVersion),'x-placement-authorization-version':String(view.placementAuthorizationVersion)};
 const saved=await f.ok('POST',`/v1/photos/${flow.committed.photoId}/placement-revisions`,{mode:'candidate',confirmationMode:'manual',suggestionId:view.suggestionId,candidateId:view.candidates[0].candidateId},headers);
 assert.equal(saved.placementState,'confirmed');
 const revision=f.db.prepare('SELECT * FROM placement_revisions WHERE photo_id=? ORDER BY rowid DESC LIMIT 1').get(flow.committed.photoId);
 assert.equal(revision.yaw,25);assert.equal(revision.suggestion_id,view.suggestionId);
 }finally{f.close()}
});
