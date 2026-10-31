import test from 'node:test';
import assert from 'node:assert/strict';
import {loadDiscovery} from '../public/moment-space-discovery-data.js';
const reply=data=>({ok:true,json:async()=>data});
const signal=()=>new AbortController().signal;
test('space discovery starts independent sources before either completes',async()=>{
 const pending=[],paths=[];
 const job=loadDiscovery({signal:signal(),fetcher:path=>{paths.push(path);return new Promise(resolve=>pending.push(resolve));}});
 assert.equal(paths.length,2);assert.match(paths[0],/public\/spaces/);assert.equal(paths[1],'/api/app-catalog');
 pending[1](reply({cases:[{id:'case',title:'案例',category:'space',cover:'/case.jpg'}]}));
 pending[0](reply({submissions:[{id:'sub',title:'社区',coverPhotoUrl:'/v1/public/spaces/sub/media/photo-0'}],total:1}));
 const result=await job;assert.deepEqual(result.rows.map(x=>x.id),['sub','case']);assert.equal(result.partial,false);
});
test('one unavailable source keeps usable cards and marks partial results; total failure rejects',async()=>{
 const run=fetcher=>loadDiscovery({signal:signal(),fetcher});
 const result=await run(async path=>path.includes('/public/')?Promise.reject(new Error('offline')):reply({cases:[{id:'c',category:'space',cover:'/c.jpg'}]}));
 assert.equal(result.partial,true);assert.equal(result.rows.length,1);
 await assert.rejects(run(async()=>({ok:false})),/spaces_unavailable/);
 await assert.rejects(run(async()=>reply({unrelated:[]})),/spaces_unavailable/);
});
test('navigation abort rejects late responses; later pages never request historical catalog',async()=>{
 const controller=new AbortController();let finish;const paths=[];
 const job=loadDiscovery({page:2,signal:controller.signal,fetcher:path=>{paths.push(path);return new Promise(resolve=>finish=resolve);}});
 controller.abort();finish(reply({submissions:[],total:0}));await assert.rejects(job,{name:'AbortError'});assert.equal(paths.length,1);
});
test('public cards cannot embed another submission or private cover',async()=>{
 const result=await loadDiscovery({signal:signal(),fetcher:async path=>reply(path.includes('/public/')?{submissions:[{id:'sub',coverPhotoUrl:'/v1/private/photo'},{id:'sub2',coverPhotoUrl:'/v1/public/spaces/sub/media/photo-0'}]}:{cases:[]})});
 assert.deepEqual(result.rows.map(x=>x.cover),['','']);
});
