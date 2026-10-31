// Usage: node spaces/deploy/generate-previews.mjs /absolute/path/to/splat-transform
// Requires @playcanvas/splat-transform 3.3.3. Full-quality source files are read only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const tool=path.resolve(process.argv[2]||'');
const version=spawnSync(tool,['--version'],{encoding:'utf8'});
if(version.status!==0||!(version.stdout+version.stderr).includes('v3.3.3 '))throw Error('splat-transform 3.3.3 is required');
const previews=path.join(here,'previews');
const scratch=path.resolve('.task/mainland-speed/decimation');
fs.mkdirSync(previews,{recursive:true});fs.mkdirSync(scratch,{recursive:true});
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const manifestFile=path.join(here,'preview-manifest.json');
const saved=fs.existsSync(manifestFile)?JSON.parse(fs.readFileSync(manifestFile)).scenes:[];
const rows=[];
for(const id of fs.readdirSync(path.join(here,'../view')).sort()){
 const source=path.join(here,'../view',id,'assets/scene.sog');
 if(!fs.existsSync(source))continue;
 const output=path.join(previews,id+'.sog'),ply=path.join(scratch,id+'.ply');
 const sourceHash=sha(source);
 if(fs.existsSync(output)){
  const prior=saved.find(row=>row.id===id);
  if(!prior||prior.sourceSha256!==sourceHash||prior.sha256!==sha(output))throw Error('Existing preview is not verified against this source; preserve it and regenerate in a clean checkout: '+id);
 }
 if(!fs.existsSync(output)){
  const log=fs.openSync(path.join(scratch,id+'.log'),'a');
  for(const args of [['-g','cpu',source,'-H','0','--decimate','75000',ply],['-g','cpu',ply,output]]){
   const result=spawnSync(tool,args,{stdio:['ignore',log,log]});
   if(result.status!==0)throw Error('Preview conversion failed: '+id);
  }
  fs.closeSync(log);
 }
 if(sha(source)!==sourceHash)throw Error('Source changed: '+id);
 rows.push({id,path:'previews/'+id+'.sog',bytes:fs.statSync(output).size,sha256:sha(output),sourceSha256:sourceHash,sourceBytes:fs.statSync(source).size});
 const verified=[...rows,...saved.filter(old=>!rows.some(row=>row.id===old.id))].sort((a,b)=>a.id.localeCompare(b.id));
 fs.writeFileSync(manifestFile,JSON.stringify({tool:'@playcanvas/splat-transform@3.3.3',maxSplats:75000,previewSHBands:0,scenes:verified},null,2)+'\n');
 console.log(JSON.stringify(rows.at(-1)));
}
