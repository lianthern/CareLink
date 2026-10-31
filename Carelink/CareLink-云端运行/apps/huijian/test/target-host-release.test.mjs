import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),driver=resolve('deploy/target-host-release.mjs');
const digest=b=>createHash('sha256').update(b).digest('hex');
for(const failure of ['postcheck','start'])for(const priorExists of [true,false])test(`target command restores state and prior drop-in ${priorExists?'bytes':'absence'} after failed ${failure} (service manager simulated)`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'target-release-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const state=join(root,'state');await mkdir(state,{mode:0o700});await writeFile(join(state,'keyset'),'fixture-original',{mode:0o600});
 const unit=join(root,'service.conf'),candidate=join(root,'candidate.conf');if(priorExists)await writeFile(unit,'old-unit');await writeFile(candidate,'new-unit');
 const ctl=join(root,'ctl.mjs');await writeFile(ctl,"import{appendFileSync}from'node:fs';appendFileSync(process.argv[2],process.argv.slice(3).join(' ')+'\\n');");
 if(failure==='start')await writeFile(ctl,`import{appendFileSync,readFileSync,existsSync}from'node:fs';appendFileSync(process.argv[2],process.argv.slice(3).join(' ')+'\\n');if(process.argv[3]==='start'&&existsSync(${JSON.stringify(unit)})&&readFileSync(${JSON.stringify(unit)},'utf8')==='new-unit')process.exit(1);`);
 const plan={schema:'unseen-target-release/1',ready:true,transactionDirectory:join(root,'transaction'),candidate:{id:'new'},previous:{id:'actual-artifact'},artifacts:[],units:[{source:candidate,target:unit,sha256:digest(await readFile(candidate))}],state:[{target:state}],serviceManager:[process.execPath,ctl,join(root,'services.log')],maintenanceOn:[process.execPath,'-e',`require('fs').writeFileSync(${JSON.stringify(join(root,'maintenance'))},'503')`],stopOrder:['app.service','canonical.service'],startOrder:['canonical.service','app.service'],candidateChecks:[[process.execPath,'-e',`require('fs').writeFileSync(${JSON.stringify(join(state,'keyset'))},'candidate-mutated');process.exit(1)`]],previousChecks:[[process.execPath,'-e',`if(require('fs').readFileSync(${JSON.stringify(join(state,'keyset'))},'utf8')!=='fixture-original')process.exit(1)`]]};
 const path=join(root,'plan.json');await writeFile(path,JSON.stringify(plan));await exec(process.execPath,[driver,'stage',path]);
 await assert.rejects(exec(process.execPath,[driver,'activate',path]),e=>e.stderr.includes('activation_failed_previous_pair_and_state_restored'));
 assert.equal(await readFile(join(state,'keyset'),'utf8'),'fixture-original');
 if(priorExists)assert.equal(await readFile(unit,'utf8'),'old-unit');else await assert.rejects(access(unit),{code:'ENOENT'});
 assert.equal(JSON.parse(await readFile(join(root,'transaction/restored.json'),'utf8')).previous.id,'actual-artifact');
 const log=await readFile(join(root,'services.log'),'utf8');assert.match(log,/stop app.service\nstop canonical.service/);assert.match(log,/start canonical.service\nstart app.service/);
});

test('second stop failure restarts original pair and keeps maintenance without touching state',async t=>{
 const root=await mkdtemp(join(tmpdir(),'target-stop-'));t.after(()=>rm(root,{recursive:true,force:true}));const state=join(root,'state');await mkdir(state);await writeFile(join(state,'value'),'old');const unit=join(root,'unit'),candidate=join(root,'candidate');await writeFile(unit,'old');await writeFile(candidate,'new');const log=join(root,'log'),ctl=join(root,'ctl.mjs');await writeFile(ctl,"import{appendFileSync}from'node:fs';appendFileSync(process.argv[2],process.argv.slice(3).join(' ')+'\\n');if(process.argv[3]==='stop'&&process.argv[4]==='canonical.service')process.exit(1);");
 const plan={schema:'unseen-target-release/1',ready:true,transactionDirectory:join(root,'tx'),candidate:{},previous:{},artifacts:[],units:[{source:candidate,target:unit,sha256:digest(await readFile(candidate))}],state:[{target:state}],serviceManager:[process.execPath,ctl,log],maintenanceOn:[process.execPath,'-e','process.exit(0)'],stopOrder:['app.service','canonical.service'],startOrder:['canonical.service','app.service'],candidateChecks:[[process.execPath,'-e','process.exit(0)']],previousChecks:[[process.execPath,'-e','process.exit(0)']]};const p=join(root,'plan');await writeFile(p,JSON.stringify(plan));await exec(process.execPath,[driver,'stage',p]);await assert.rejects(exec(process.execPath,[driver,'activate',p]),e=>e.stderr.includes('partial_stop_failed_original_pair_restarted_maintenance_retained'));assert.equal(await readFile(unit,'utf8'),'old');assert.equal(await readFile(join(state,'value'),'utf8'),'old');assert.match(await readFile(log,'utf8'),/start canonical.service\nstart app.service/);assert.equal(JSON.parse(await readFile(join(root,'tx/partial-stop-error.json'),'utf8')).failedUnit,'canonical.service');
});

async function activatedArtifactFixture(t){
 const root=await mkdtemp(join(tmpdir(),'target-corruption-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const state=join(root,'state'),old=join(root,'old-code'),build=join(root,'build');for(const d of [state,old,build])await mkdir(d);
 await writeFile(join(state,'value'),'original');await writeFile(join(old,'server.mjs'),'old verified code');await writeFile(join(build,'server.mjs'),'candidate verified code');
 const archive=join(root,'candidate.tar');await exec('tar',['-cf',archive,'-C',build,'.']);
 const unit=join(root,'service.conf'),newUnit=join(root,'candidate.conf');await writeFile(unit,'original unit');await writeFile(newUnit,'candidate unit');
 const plan={schema:'unseen-target-release/1',ready:true,transactionDirectory:join(root,'tx'),candidate:{id:'new'},previous:{id:'manifest-bound-old'},artifacts:[{source:archive,target:join(root,'release'),sha256:digest(await readFile(archive))}],previousArtifacts:[{target:old,files:{'server.mjs':digest(await readFile(join(old,'server.mjs')))}}],units:[{source:newUnit,target:unit,sha256:digest(await readFile(newUnit))}],state:[{target:state}],serviceManager:[process.execPath,'-e','process.exit(0)','--'],maintenanceOn:[process.execPath,'-e','process.exit(0)'],stopOrder:['app.service','canonical.service'],startOrder:['canonical.service','app.service'],candidateChecks:[[process.execPath,'-e',`require('fs').writeFileSync(${JSON.stringify(join(state,'value'))},'candidate state')`]],previousChecks:[[process.execPath,'-e',`if(require('fs').readFileSync(${JSON.stringify(join(state,'value'))},'utf8')!=='original')process.exit(1)`]]};
 const path=join(root,'plan.json');await writeFile(path,JSON.stringify(plan));await exec(process.execPath,[driver,'stage',path]);await exec(process.execPath,[driver,'activate',path]);assert.equal(await readFile(unit,'utf8'),'candidate unit');
 await writeFile(join(root,'release/server.mjs'),'corrupted after successful activation');
 return {root,state,old,unit,plan,path,rollback:()=>exec(process.execPath,[driver,'rollback',path])};
}
test('successful activate then candidate corruption still allows explicit rollback to trusted old code, unit and state',async t=>{
 const f=await activatedArtifactFixture(t);await assert.rejects(exec(process.execPath,[driver,'activate',f.path]),e=>e.stderr.includes('staged_artifact_changed'));await f.rollback();assert.equal(await readFile(f.unit,'utf8'),'original unit');assert.equal(await readFile(join(f.state,'value'),'utf8'),'original');assert.equal(await readFile(join(f.old,'server.mjs'),'utf8'),'old verified code');
});
for(const kind of ['state','unit','metadata','plan','old-artifact'])test(`candidate corruption does not bypass ${kind} integrity guard during rollback`,async t=>{
 const f=await activatedArtifactFixture(t);
 const targets={state:join(f.root,'tx/backup/state-0/value'),unit:join(f.root,'tx/backup/unit-0'),metadata:join(f.root,'tx/backup/units.json'),'old-artifact':join(f.old,'server.mjs')};
 if(kind==='plan'){f.plan.previous.id='untrusted-new-plan';await writeFile(f.path,JSON.stringify(f.plan));}else await writeFile(targets[kind],'tampered');
 const codes={state:'backup_tampered_restore_refused',unit:'unit_backup_tampered_restore_refused',metadata:'backup_metadata_tampered_restore_refused',plan:'plan_changed_after_stage','old-artifact':'previous_artifact_changed'};
 await assert.rejects(f.rollback(),e=>e.stderr.includes(codes[kind]));assert.equal(await readFile(f.unit,'utf8'),'candidate unit');assert.equal(await readFile(join(f.state,'value'),'utf8'),'candidate state');
});
