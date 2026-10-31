import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMomentExamplesHttp, publicExample, validateExampleCatalog } from '../lib/moment-examples.mjs';
import { exampleScreen, examplesGallery } from '../public/moment-examples.js';
const example = { id:'summer',title:'夏夜',notice:'虚构示例',accountId:'PRIVATE',context:{private:'secret'},photos:[{id:'p1',mediaId:'m1',mimeType:'image/jpeg',name:'碰杯',originalUrl:'/v1/private'}],messages:[{id:'m',role:'user',text:'记得那天',photoId:'p1',private:'never'}] };
async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'moment-examples-'));await mkdir(join(directory,'media'));
  await writeFile(join(directory,'media/m1'),Buffer.from([255,216,255,1]));
  await writeFile(join(directory,'media/unpublished'),'private bytes');
  await writeFile(join(directory,'catalog.json'),JSON.stringify({schemaVersion:1,examples:[example]}));
  const handler=createMomentExamplesHttp({directory});
  const server=createServer(async(req,res)=>{if(!await handler(req,res,new URL(req.url,'http://local').pathname)){res.writeHead(404);res.end();}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});});
  return {directory,url:`http://127.0.0.1:${server.address().port}`};
}
test('anonymous readers get only selected examples, explicit fields and associated media',async t=>{
  const {url}=await fixture(t),list=await fetch(url+'/api/moment-examples');
  assert.equal(list.headers.get('set-cookie'),null);
  assert.equal((await list.json()).examples[0].coverPhotoUrl,'/api/moment-examples/summer/media/m1');
  const detail=await(await fetch(url+'/api/moment-examples/summer',{headers:{cookie:'private-user-session=ABC'}})).json();
  assert.equal(JSON.stringify(detail).includes('PRIVATE'),false);assert.equal(JSON.stringify(detail).includes('secret'),false);
  assert.equal(JSON.stringify(detail).includes('/v1/'),false);
  const media=await fetch(url+'/api/moment-examples/summer/media/m1');assert.equal(media.headers.get('content-type'),'image/jpeg');assert.equal((await media.arrayBuffer()).byteLength,4);
  for(const path of ['/other','/summer/media/unpublished','/summer/media/..%2f..%2fcatalog.json','/summer/media/m1/preview']) assert.equal((await fetch(url+'/api/moment-examples'+path)).status,404);
});
test('public publication routes cannot write, list unpublished files or authenticate a visitor',async t=>{
  const {url}=await fixture(t);
  for(const method of ['POST','PUT','PATCH','DELETE']) {
    const r=await fetch(url+'/api/moment-examples/summer',{method,body:'{}'});assert.equal(r.status,405);assert.equal(r.headers.get('set-cookie'),null);
  }
});
test('invalid or absent publication fails visibly without a built-in fake success',async t=>{
  const {url,directory}=await fixture(t);await writeFile(join(directory,'catalog.json'),'{}');
  assert.equal((await fetch(url+'/api/moment-examples')).status,503);
  assert.throws(()=>validateExampleCatalog({schemaVersion:1,examples:[{...example,photos:[{mediaId:'../secret',mimeType:'image/jpeg'}]}]}));
  assert.throws(()=>validateExampleCatalog({schemaVersion:1,examples:[{...example,photos:[{mediaId:'m1',mimeType:'text/html'}]}]}));
});
test('published detail is read-only and escapes text and untrusted media URLs',()=>{
  const projected=publicExample(example),html=exampleScreen(projected,0,{back:'back',plus:'+'});
  assert.match(html,/示例讲述者/);assert.match(html,/选一张我的照片/);
  assert.doesNotMatch(html,/data-edit|data-action="(?:save-cloud|rename|continue|add)"|textarea/);
  const poisoned={...projected,title:'<img src=x onerror=alert(1)>',photos:[{...projected.photos[0],url:'javascript:alert(1)'}]};
  assert.doesNotMatch(exampleScreen(poisoned,0,{back:'',plus:''}),/<img src=x|javascript:/);
  assert.match(examplesGallery([],true),/再试一次/);
});
