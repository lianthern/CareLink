#!/usr/bin/env node
// Local-only two-repository rehearsal. Does not install services or touch production.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, readdir, cp, rename, stat, symlink, readlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
const exec=promisify(execFile);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const options=Object.fromEntries(process.argv.slice(2).reduce((pairs,value,index,args)=>index%2?pairs:[...pairs,[value.slice(2),args[index+1]]],[]));
const root=resolve(options.root||'.');
if(!root.split('/').includes('.task'))throw Error('isolated_task_root_required');
for(const key of ['app-sha','canonical-sha','previous-canonical-sha','previous-app-sha'])if(!/^[a-f0-9]{40}$/.test(options[key]||''))throw Error(`exact_sha_required:${key}`);
await mkdir(root,{recursive:false,mode:0o700});
const receipt={schema:'unseen-dual-rehearsal/2',startedAt:new Date().toISOString(),app:options['app-sha'],canonical:options['canonical-sha'],previousCanonical:options['previous-canonical-sha'],previousApp:options['previous-app-sha'],production:false,checks:[]};
async function archive(source,sha,name){
 const found=(await exec('git',['-C',source,'rev-parse',`${sha}^{commit}`])).stdout.trim();assert.equal(found,sha);
 const directory=join(root,name);await mkdir(directory);
 const tar=join(root,`${name}.tar`);await exec('git',['-C',source,'archive','--format=tar',`--output=${tar}`,sha]);await exec('tar',['-xf',tar,'-C',directory]);
 return directory;
}
async function port(){const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const p=server.address().port;await new Promise(r=>server.close(r));return p;}
const children=[];
async function boot(directory,entry,env,health){
 const child=spawn(process.execPath,[entry],{cwd:directory,env:{PATH:process.env.PATH,...env},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
 const handle={async stop(){if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await once(child,'exit');}}};children.push(handle);
 for(let i=0;i<200;i++){if(child.exitCode!==null)throw Error(`local_process_failed:${output.slice(-2000)}`);try{const r=await fetch(health);if(r.ok)return handle;}catch{}await delay(25);}
 throw Error(`local_startup_timeout:${output.slice(-2000)}`);
}
async function inventory(directory,prefix=''){
 const result={};for(const item of await readdir(directory,{withFileTypes:true})){const relative=prefix?`${prefix}/${item.name}`:item.name;assert.equal(item.isSymbolicLink(),false);
 if(item.isDirectory())Object.assign(result,await inventory(join(directory,item.name),relative));else result[relative]=hash(await readFile(join(directory,item.name)));}return result;
}
let maintenance=true;
let targetOrigin;
const gateway=createServer((req,res)=>{
 if(maintenance){res.writeHead(503,{'retry-after':'60','content-type':'application/json'});res.end('{"error":"local_release_maintenance"}');return;}
 const target=new URL(req.url,targetOrigin);
 const upstream=httpRequest(target,{method:req.method,headers:{...req.headers,host:target.host}},incoming=>{res.writeHead(incoming.statusCode,incoming.headers);incoming.pipe(res);});
 upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(upstream);
});
gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
const gatewayOrigin=`http://127.0.0.1:${gateway.address().port}`;
try{
 const app=await archive(options['app-source'],options['app-sha'],'app');
 const previousApp=await archive(options['app-source'],options['previous-app-sha'],'previous-app');
 const previous=await archive(options['canonical-source'],options['previous-canonical-sha'],'previous-canonical');
 const canonical=await archive(options['canonical-source'],options['canonical-sha'],'canonical');
 await mkdir(join(root,'pairs'));
 const pairs={previous:{app:previousApp,canonical:previous,appSha:options['previous-app-sha'],canonicalSha:options['previous-canonical-sha']},candidate:{app,canonical,appSha:options['app-sha'],canonicalSha:options['canonical-sha']}};
 for(const [name,pair] of Object.entries(pairs)){
  pair.hashes={app:await inventory(pair.app),canonical:await inventory(pair.canonical)};
  await writeFile(join(root,'pairs',name+'.json'),JSON.stringify(pair,null,2));
 }
 async function selectPair(name){
  for(const service of ['app','canonical'])assert.deepEqual(await inventory(pairs[name][service]),pairs[name].hashes[service],`staged ${name} ${service} changed`);
  const temporary=join(root,'current.next');await symlink(`pairs/${name}.json`,temporary);await rename(temporary,join(root,'current'));
  assert.equal(await readlink(join(root,'current')),`pairs/${name}.json`);
 }
 const data=join(root,'data'),appState=join(root,'app-state');await mkdir(data,{mode:0o700});await mkdir(appState,{mode:0o700});await mkdir(join(data,'media'),{mode:0o700});await writeFile(join(data,'media','preserved-fixture.txt'),'local fixture media; no user data',{mode:0o600});
 const oldDbModule=await import(pathToFileURL(join(previous,'services/api/src/database.mjs')));
 const oldDb=oldDbModule.openDatabase(join(data,'unseen.sqlite'));oldDb.exec("CREATE TABLE rehearsal_marker(value TEXT); INSERT INTO rehearsal_marker VALUES('before-upgrade')");oldDb.close();
 const crypto=await import(pathToFileURL(join(previous,'services/api/src/crypto.mjs')));crypto.loadLocalKeyring(join(data,'local.keyset.json'),{allowCreate:true});
 const gateModule=await import(pathToFileURL(join(app,'lib/photo-ai-gate.mjs')));
 const quotaModule=await import(pathToFileURL(join(app,'lib/worldlabs-quota.mjs')));
 const jobsModule=await import(pathToFileURL(join(app,'lib/unseen-world-jobs.mjs')));
 const owner='a'.repeat(64),jobId='paired-restore-unknown-job-0001';
 const photoGate=gateModule.createPhotoAiGate({filePath:join(appState,'photo-ai-usage.json')});const allowance=await photoGate.reserve('local-fixture');assert.equal(allowance.ok,true);allowance.release();
 const quota=quotaModule.createGenerationQuota({filePath:join(appState,'worldlabs-usage.json')});assert.equal((await quota.reserve('local-fixture')).ok,true);
 const jobs=jobsModule.createWorldJobStore(join(appState,'world-jobs.json'));await jobs.begin(owner,jobId,{fixture:true});await jobs.update(owner,jobId,{status:'unknown',error:'synthetic_response_lost'});
 const p=await port(),origin=`http://127.0.0.1:${p}`,appPort=await port();targetOrigin=`http://127.0.0.1:${appPort}`;
 const canonicalEnv={UNSEEN_LOCAL_HOST:'127.0.0.1',UNSEEN_LOCAL_PORT:String(p),UNSEEN_LOCAL_PUBLIC_ORIGIN:origin,UNSEEN_LOCAL_DATA_DIR:data,UNSEEN_LOCAL_EVIDENCE_DIR:join(root,'runtime-evidence'),UNSEEN_LOCATOR_MODE:'fixture',UNSEEN_OTP_DELIVERY_PROVIDER:'disabled',UNSEEN_BOOK_LAB_ENABLED:'true',UNSEEN_PRIVATE_AI_WORKER_ENABLED:'false',UNSEEN_BOOK_RENDER_WORKER_ENABLED:'true'};
 let running=[];
 async function stopPair(){for(const service of running.reverse())await service.stop();running=[];}
 async function bootPair(name){
  const selected=JSON.parse(await readFile(join(root,'current'),'utf8'));assert.equal(selected.appSha,pairs[name].appSha);assert.equal(selected.canonicalSha,pairs[name].canonicalSha);
  running.push(await boot(selected.canonical,'infra/integration/local-operable.mjs',canonicalEnv,origin+'/healthz'));
  running.push(await boot(selected.app,'server.mjs',{PORT:String(appPort),BUILD_ID:selected.appSha,STATE_DIRECTORY:appState,CANONICAL_UPSTREAM:origin,CANONICAL_PUBLIC_ORIGIN:origin,MINIMAX_API_KEY:'not-a-real-local-rehearsal-disabled',WORLDLABS_API_KEY:'not-a-real-local-rehearsal-disabled',MINIMAX_BASE_URL:'http://127.0.0.1:1',WORLDLABS_BASE_URL:'http://127.0.0.1:1'},targetOrigin+'/api/health'));
  const health=await (await fetch(targetOrigin+'/api/health')).json();assert.equal(health.buildId,selected.appSha);
  const status=await (await fetch(origin+'/__local-operable/status')).json();assert.equal(status.bookLab.enabled,true);assert.equal(status.bookLab.mounted,true);if(name==='candidate')assert.equal(status.bookLab.renderWorker,true);assert.equal(status.bookLab.privateAiWorker,false);
  const recoveredJobs=await (await fetch(targetOrigin+'/api/worldlabs/jobs',{headers:{cookie:`unseen_world_owner=${owner}`}})).json();assert.equal(recoveredJobs.jobs.find(j=>j.id===jobId)?.status,'unknown');
  assert.equal((await (await fetch(targetOrigin+'/api/worldlabs/config')).json()).quota.remainingToday,4);
  receipt.checks.push({phase:name,appBuildId:health.buildId,bookLab:status.bookLab,unknownJobRetained:true,worldBudgetRemaining:4,renderWorkerMeaning:status.bookLab.renderWorker===true?'real timer worker enabled; no render job submitted':'historical entry has no local render worker support',privateAiWorkerMeaning:'disabled explicitly; no provider or online execution claim'});
 }
 async function maintain(){maintenance=true;assert.equal((await fetch(gatewayOrigin+'/api/health')).status,503);await stopPair();}
 async function openTraffic(){maintenance=false;assert.equal((await fetch(gatewayOrigin+'/api/health')).status,200);}
 await selectPair('previous');await bootPair('previous');await openTraffic();await maintain();
 const before={canonical:await inventory(data),app:await inventory(appState)};
 const backup=join(root,'backup');await mkdir(backup,{mode:0o700});await cp(data,join(backup,'canonical'),{recursive:true,preserveTimestamps:true});await cp(appState,join(backup,'app'),{recursive:true,preserveTimestamps:true});
 receipt.backup={sha256:before,method:'maintenance gateway 503; both processes stopped; complete canonical and app state snapshots',syntheticLocalData:true};
 await selectPair('candidate');await bootPair('candidate');
 const assets=[];for(const name of ['integrated-shell.mjs','integrated-controller.mjs','integrated-transport.mjs','routes.mjs']){const path=`/__book_lab_web__/src/${name}`,response=await fetch(targetOrigin+path);assert.equal(response.status,200);const expected=hash(await readFile(join(canonical,'packages/book-lab-web/src',name)));assert.equal(hash(Buffer.from(await response.arrayBuffer())),expected);assets.push({path,sha256:expected});}
 receipt.checks.push({stage:'candidate',twoProcessHttpProxy:true,assets});
 try { await openTraffic(); throw new Error('injected_post_switch_gate_failure'); }
 catch(error){assert.equal(error.message,'injected_post_switch_gate_failure');receipt.rollbackTrigger=error.message;}
 // No external clients exist: this is an isolated synthetic maintenance-window rollback rehearsal.
 await maintain();
 const upgraded=new DatabaseSync(join(data,'unseen.sqlite'));receipt.appliedMigrations=upgraded.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(r=>r.version);upgraded.exec("UPDATE rehearsal_marker SET value='after-upgrade'");upgraded.close();
 await writeFile(join(appState,'world-jobs.json'),'{}');await writeFile(join(appState,'photo-ai-usage.json'),'{}');await writeFile(join(appState,'worldlabs-usage.json'),'{}');
 await rename(data,join(root,'failed-candidate-data'));await rename(appState,join(root,'failed-candidate-app-state'));
 await cp(join(backup,'canonical'),data,{recursive:true,preserveTimestamps:true});await cp(join(backup,'app'),appState,{recursive:true,preserveTimestamps:true});
 assert.deepEqual(await inventory(data),before.canonical);assert.deepEqual(await inventory(appState),before.app);
 const restored=oldDbModule.openDatabase(join(data,'unseen.sqlite'));assert.equal(restored.prepare('SELECT value FROM rehearsal_marker').get().value,'before-upgrade');assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check,'ok');restored.close();
 crypto.loadLocalKeyring(join(data,'local.keyset.json'),{allowCreate:false});
 await selectPair('previous');await bootPair('previous');await openTraffic();await maintain();
 assert.equal(hash(await readFile(join(data,'local.keyset.json'))),before.canonical['local.keyset.json']);
 assert.equal(hash(await readFile(join(appState,'photo-ai-usage.json'))),before.app['photo-ai-usage.json']);
 assert.equal(hash(await readFile(join(appState,'worldlabs-usage.json'))),before.app['worldlabs-usage.json']);
 receipt.checks.push({failureInjected:'post-switch synthetic state corruption after both processes stopped',bothPreviousProcessesRestarted:true,pairedPointer:await readlink(join(root,'current')),maintenance503Verified:true,databaseIntegrity:'ok',appBudgetsRestored:true,unknownWorldJobRestored:true,keysetBytesPreserved:true,mediaBytesPreserved:true,failedStateRetained:true});
 receipt.completedAt=new Date().toISOString();receipt.result='pass';await writeFile(join(root,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({result:'pass',root,app:receipt.app,canonical:receipt.canonical,previousApp:receipt.previousApp,previousCanonical:receipt.previousCanonical}));
}finally{for(const child of children.reverse())await child.stop();gateway.closeAllConnections();await new Promise(r=>gateway.close(r));}
