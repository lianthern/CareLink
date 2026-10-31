import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {parseDepthImport} from '../public/spatial-contract/import.js';
const root=new URL('../public/',import.meta.url);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const catalog=JSON.parse(await readFile(new URL('app-spatial/v1/catalog.json',root)));
test('every explicit published asset is readable and all five real DAP sets retain their original byte receipts',async()=>{
  const receipts=JSON.parse(await readFile(new URL('../.task/app-spatial/asset-receipts.json',import.meta.url)));
  for(const r of receipts)assert.equal(digest(await readFile(new URL('../'+r.path,import.meta.url))),r.sha256,r.path);
  const ids=catalog.cases.map(c=>c.id);assert.equal(new Set(ids).size,ids.length);
  const scenes=catalog.cases.filter(c=>c.type==='dap');assert.equal(scenes.length,5);
  for(const item of scenes){
    const s=item.space,meta=JSON.parse(await readFile(new URL(s.depthMetaSrc.slice(1),root)));
    const input={panorama:{width:meta.source_resolution[0],height:meta.source_resolution[1]},depth:{width:meta.width,height:meta.height},panoramaName:s.panorama.split('/').at(-1)};
    const parsed=parseDepthImport(meta,input);assert.equal(parsed.encoding,'legacy-dap-minmax-v1');
    assert.throws(()=>parseDepthImport(meta,{...input,panoramaName:'wrong-scene.jpg'}),{code:'depth_source_mismatch'});
  }
  async function check(value){if(typeof value==='string'&&/^\/(app-spatial|photos|unseen-app-cases-assets)\//.test(value))assert.ok((await readFile(new URL(value.startsWith('/photos/')?'../'+value.slice(1):value.slice(1),root))).length,value);else if(value&&typeof value==='object')for(const v of Object.values(value))await check(v);}
  await check(catalog);
});
