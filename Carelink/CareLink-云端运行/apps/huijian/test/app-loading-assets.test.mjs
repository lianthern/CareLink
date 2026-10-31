import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
const read=path=>readFile(new URL('../'+path,import.meta.url));
const digest=b=>createHash('sha256').update(b).digest('hex');
test('released asset graph matches source and every frozen public image retains its bytes',async()=>{
 const build=JSON.parse(await read('.task/app-loading/asset-build.json'));
 for(const name of build.sourceFiles||build.files)assert.deepEqual(await read('public'+build.prefix+'/'+name),await read('public/'+name),name+' needs rebuild');
 for(const name of build.bundles||[])assert.ok(build.files.includes(name),'release inventory must include '+name);
 const originals=JSON.parse(await read('.task/app-loading/original-receipt.json'));
 for(const item of originals){const bytes=await read('public'+item.url);assert.equal(digest(bytes),item.sha256);assert.deepEqual(bytes,await read('public'+item.source));}
 const previews=JSON.parse(await read('.task/app-loading/thumbnail-receipt.json'));
 for(const item of previews)for(const v of item.variants){const bytes=await read('public'+v.url);assert.equal(bytes.length,v.bytes);assert.ok(v.url.includes(digest(bytes)));}
 // Viewer/parser and catalog are the exact production versions. Only URLs for public originals change.
 const frozen=JSON.parse(await read('test/fixtures/frozen-public-assets.json'));
 for(const [path,expected] of Object.entries(frozen.sha256))assert.equal(digest(await read(path)),expected,path);
});
