#!/usr/bin/env node
// Explicit target-host operations. Preparing this script does not authorize running it on production.
import { readFile,writeFile,mkdir,cp,rename,access,readdir,lstat,chmod,unlink,chown } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join,resolve,isAbsolute } from 'node:path';
const exec=promisify(execFile);
const [operation,planPath]=process.argv.slice(2);
if(!['stage','activate','rollback'].includes(operation)||!planPath)throw Error('usage: stage|activate|rollback release-plan.json');
const plan=JSON.parse(await readFile(planPath,'utf8'));
if(plan.schema!=='unseen-target-release/1'||plan.ready!==true)throw Error('release_plan_not_ready');
for(const item of [...plan.artifacts,...plan.units,...plan.state])if(!isAbsolute(item.target))throw Error('absolute_target_required');
if(!isAbsolute(plan.transactionDirectory))throw Error('absolute_transaction_directory_required');
if(!plan.candidateChecks?.length||!plan.previousChecks?.length||!plan.stopOrder?.length||!plan.startOrder?.length||!plan.state?.length||!plan.units?.length)throw Error('incomplete_release_plan');
const transaction=resolve(plan.transactionDirectory);
for(const command of [plan.serviceManager,plan.maintenanceOn,...plan.candidateChecks,...plan.previousChecks])if(!Array.isArray(command)||!command.length||command.some(x=>typeof x!=='string'||!x||x.includes('\0')))throw Error('explicit_argv_required');
for(const name of [...plan.stopOrder,...plan.startOrder])if(typeof name!=='string'||!name.endsWith('.service'))throw Error('explicit_service_unit_required');
const run=async command=>{if(!Array.isArray(command)||!command.length)throw Error('explicit_argv_required');return exec(command[0],command.slice(1));};
const ctl=async(...args)=>run([...plan.serviceManager,...args]);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function inventory(directory,prefix=''){const out={};for(const entry of await readdir(directory,{withFileTypes:true})){const rel=prefix?prefix+'/'+entry.name:entry.name;if(entry.isSymbolicLink())throw Error('symlink_artifact_rejected');if(entry.isDirectory())Object.assign(out,await inventory(join(directory,entry.name),rel));else out[rel]=sha(await readFile(join(directory,entry.name)));}return out;}
async function verifyPreviousArtifacts(){if(plan.artifacts.length&&!plan.previousArtifacts?.length)throw Error('previous_artifact_manifest_required');for(const item of plan.previousArtifacts||[]){if(!isAbsolute(item.target)||!item.files||!Object.keys(item.files).length)throw Error('previous_artifact_manifest_invalid');if(JSON.stringify(await inventory(item.target))!==JSON.stringify(item.files))throw Error('previous_artifact_changed');}}
const checked=async item=>{const bytes=await readFile(item.source);if(sha(bytes)!==item.sha256)throw Error('source_hash_mismatch');return bytes;};
if(operation==='stage'){
 await verifyPreviousArtifacts();
 await mkdir(transaction,{recursive:false,mode:0o700});
 const hashes={};
 for(const artifact of plan.artifacts){await checked(artifact);await mkdir(artifact.target,{recursive:false});const listing=(await exec('tar',['-tf',artifact.source])).stdout.trim().split('\n');if(listing.some(p=>p.startsWith('/')||p.split('/').includes('..')))throw Error('unsafe_archive_path');const verbose=(await exec('tar',['-tvf',artifact.source])).stdout.trim().split('\n');if(verbose.some(line=>!['-','d'].includes(line[0])))throw Error('archive_links_or_specials_rejected');await exec('tar',['-xf',artifact.source,'-C',artifact.target]);hashes[artifact.target]=await inventory(artifact.target);}
 for(const unit of plan.units)await checked(unit);
 await writeFile(join(transaction,'staged-plan.json'),JSON.stringify(plan,null,2),{mode:0o600});
 await writeFile(join(transaction,'staged-hashes.json'),JSON.stringify(hashes));console.log('staged');process.exit(0);
}
const staged=JSON.parse(await readFile(join(transaction,'staged-plan.json'),'utf8'));if(JSON.stringify(staged)!==JSON.stringify(plan))throw Error('plan_changed_after_stage');
if(operation==='activate'){const hashes=JSON.parse(await readFile(join(transaction,'staged-hashes.json'),'utf8'));for(const [directory,expected] of Object.entries(hashes))if(JSON.stringify(await inventory(directory))!==JSON.stringify(expected))throw Error('staged_artifact_changed');}
await verifyPreviousArtifacts();
const backup=join(transaction,'backup');
async function exists(p){try{await access(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function stateInventory(p,prefix=''){const info=await lstat(p);if(info.isSymbolicLink())throw Error('state_symlink_requires_explicit_plan');const out={[prefix||'.']:{mode:info.mode&0o777,uid:info.uid,gid:info.gid,type:info.isDirectory()?'directory':'file',...(info.isFile()?{sha256:sha(await readFile(p))}:{})}};if(info.isDirectory())for(const name of await readdir(p))Object.assign(out,await stateInventory(join(p,name),prefix?prefix+'/'+name:name));return out;}
async function copyState(source,target){const metadata=await stateInventory(source);await cp(source,target,{recursive:true,preserveTimestamps:true});for(const [relative,entry] of Object.entries(metadata)){const p=relative==='.'?target:join(target,relative);await chmod(p,entry.mode);const current=await lstat(p);if(current.uid!==entry.uid||current.gid!==entry.gid)await chown(p,entry.uid,entry.gid);}}
const equalInventory=async(a,b)=>{if(JSON.stringify(await stateInventory(a))!==JSON.stringify(await stateInventory(b)))throw Error('state_backup_integrity_mismatch');};
async function stop(){const stopped=[];for(const unit of plan.stopOrder){try{await ctl('stop',unit);stopped.push(unit);}catch(error){await writeFile(join(transaction,'partial-stop-error.json'),JSON.stringify({at:new Date().toISOString(),stopped,failedUnit:unit,maintenanceRetained:true}));throw new Error('partial_stop_failed_maintenance_retained',{cause:error});}}}
async function restore(){
 await verifyPreviousArtifacts();
 const integrity=JSON.parse(await readFile(join(transaction,'backup-receipt.json'),'utf8'));for(const [file,expected] of Object.entries(integrity))if(sha(await readFile(join(backup,file)))!==expected)throw Error('backup_metadata_tampered_restore_refused');
 const priorUnits=JSON.parse(await readFile(join(backup,'units.json'),'utf8'));for(let i=0;i<priorUnits.length;i++)if(priorUnits[i].existed&&sha(await readFile(join(backup,`unit-${i}`)))!==priorUnits[i].sha256)throw Error('unit_backup_tampered_restore_refused');
 const inventory=JSON.parse(await readFile(join(backup,'state-inventory.json'),'utf8'));for(let i=0;i<plan.state.length;i++)if(JSON.stringify(await stateInventory(join(backup,`state-${i}`)))!==JSON.stringify(inventory[i]))throw Error('backup_tampered_restore_refused');
 await run(plan.maintenanceOn);await stop();
 for(let i=0;i<plan.state.length;i++){const item=plan.state[i];await rename(item.target,join(transaction,`failed-state-${i}-${Date.now()}`));await copyState(join(backup,`state-${i}`),item.target);await equalInventory(join(backup,`state-${i}`),item.target);}
 for(let i=0;i<plan.units.length;i++){const target=plan.units[i].target;if(await exists(target))await rename(target,join(transaction,`failed-unit-${i}-${Date.now()}`));if(priorUnits[i].existed)await cp(join(backup,`unit-${i}`),target,{preserveTimestamps:true});}
 await ctl('daemon-reload');for(const unit of plan.startOrder)await ctl('start',unit);
 for(const command of plan.previousChecks)await run(command);
 await writeFile(join(transaction,'restored.json'),JSON.stringify({restoredAt:new Date().toISOString(),previous:plan.previous}),{mode:0o600});
 // Maintenance remains enabled until an operator accepts the restored checks.
}
if(operation==='rollback'){await restore();console.log('restored; maintenance remains enabled');process.exit(0);}
for(const item of plan.state)await stateInventory(item.target);for(const item of plan.units)await checked(item);
await run(plan.maintenanceOn);
try{await stop();}catch(error){try{for(const unit of plan.startOrder)await ctl('start',unit);for(const command of plan.previousChecks)await run(command);}catch(restartError){throw new Error('partial_stop_and_original_pair_restart_failed_maintenance_retained',{cause:restartError});}throw new Error('partial_stop_failed_original_pair_restarted_maintenance_retained',{cause:error});}
try { await mkdir(backup,{recursive:false,mode:0o700});
for(let i=0;i<plan.state.length;i++){await copyState(plan.state[i].target,join(backup,`state-${i}`));await equalInventory(plan.state[i].target,join(backup,`state-${i}`));}
await writeFile(join(backup,'state-inventory.json'),JSON.stringify(await Promise.all(plan.state.map(item=>stateInventory(item.target)))));
const priorUnits=[];for(let i=0;i<plan.units.length;i++){const existed=await exists(plan.units[i].target);priorUnits.push({existed,...(existed?{sha256:sha(await readFile(plan.units[i].target))}:{})});if(existed)await cp(plan.units[i].target,join(backup,`unit-${i}`),{preserveTimestamps:true});}
await writeFile(join(backup,'units.json'),JSON.stringify(priorUnits));
await writeFile(join(transaction,'backup-receipt.json'),JSON.stringify(Object.fromEntries(await Promise.all(['units.json','state-inventory.json'].map(async file=>[file,sha(await readFile(join(backup,file)))])))),{mode:0o600});
} catch(error){for(const unit of plan.startOrder)await ctl('start',unit);throw new Error('backup_failed_original_units_restarted_maintenance_retained',{cause:error});}
try{
 for(const unit of plan.units){await checked(unit);await mkdir(resolve(unit.target,'..'),{recursive:true});await cp(unit.source,unit.target);}
 await ctl('daemon-reload');for(const unit of plan.startOrder)await ctl('start',unit);
 for(const command of plan.candidateChecks)await run(command);
 await writeFile(join(transaction,'activated.json'),JSON.stringify({activatedAt:new Date().toISOString(),candidate:plan.candidate}),{mode:0o600});
 console.log('activated and checked; maintenance remains enabled for explicit acceptance');
}catch(error){await restore();throw new Error('activation_failed_previous_pair_and_state_restored',{cause:error});}
