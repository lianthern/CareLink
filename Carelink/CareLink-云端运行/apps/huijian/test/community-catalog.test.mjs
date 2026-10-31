import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {createCommunityCatalog} from '../lib/community-catalog.mjs';
import {createMomentExamplesHttp} from '../lib/moment-examples.mjs';
test('catalog uses fresh canonical visibility and denies unavailable or malformed policies',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'case-policy-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const catalogPath=join(dir,'catalog.json');await writeFile(catalogPath,JSON.stringify({cases:[{id:'a'},{id:'b'}]}));
 let rules=[{source:'catalog',sourceId:'b',status:'visible',featured:true,sortRank:-2}],fail=false;
 const c=createCommunityCatalog({catalogPath,upstream:'http://canonical.test',fetchImpl:async(url,options)=>{
  assert.equal(url.pathname,'/v1/public/community/cases');assert.equal(options.headers.cookie,undefined);if(fail)return new Response('',{status:503});return Response.json({cases:rules});
 }});
 assert.deepEqual((await c.catalog()).cases,[{id:'b',featured:true,sortRank:-2}]);
 rules=[];assert.equal((await c.catalog()).cases.length,0);
 fail=true;await assert.rejects(c.catalog(),/case_policy_unavailable/);
 fail=false;rules=[{source:'catalog',sourceId:'a',status:'hidden'}];await assert.rejects(c.catalog(),/case_policy_unavailable/);
});
test('hidden examples disappear from lists, details and bytes, including during a media read',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'case-example-'));await mkdir(join(dir,'media'));await writeFile(join(dir,'media/p'),'synthetic');
 await writeFile(join(dir,'catalog.json'),JSON.stringify({schemaVersion:1,examples:[{id:'a',title:'A',notice:'Public fixture',photos:[{id:'p',mediaId:'p',mimeType:'image/jpeg'}],messages:[]}]}));
 let visible=true,denyAfterFirst=false,reads=0;
 const handler=createMomentExamplesHttp({directory:dir,presentation:{examples:async e=>visible?e:[],exampleVisible:async()=>visible&&(!denyAfterFirst||++reads<2)}});
 const server=createServer(async(req,res)=>{await handler(req,res,new URL(req.url,'http://local').pathname);});server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}/api/moment-examples`;
 assert.equal((await fetch(base+'/a/media/p')).status,200);
 visible=false;assert.equal((await(await fetch(base)).json()).examples.length,0);
 for(const p of ['/a','/a/media/p'])assert.equal((await fetch(base+p)).status,404);
 visible=true;denyAfterFirst=true;assert.equal((await fetch(base+'/a/media/p')).status,404);
});
test('internal policy fetch uses the configured canonical public host',async t=>{
 const server=createServer((req,res)=>{res.setHeader('content-type','application/json');res.statusCode=req.headers.host==='canonical.example.test'?200:403;res.end(JSON.stringify({cases:[]}));});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 const c=createCommunityCatalog({upstream:`http://127.0.0.1:${server.address().port}`,publicOrigin:'https://canonical.example.test'});
 assert.deepEqual(await c.examples([{id:'a'}]),[]);
});
