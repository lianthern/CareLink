import test from 'node:test';
import assert from 'node:assert/strict';
import {probeApp} from './app-probe.mjs';
const config={curlBin:'curl',httpTimeoutMs:2000,appHost:'example.test',appOrigin:'http://127.0.0.1:4611'};
const bodies={'/api/health':'{"ok":true,"buildId":"release-a"}','/app':'<!doctype html><html><script src="/app-assets/hash/moment-app.js"></script></html>','/api/app-catalog':'{"cases":[{"id":"sample"}]}'};
test('App monitor reads the health, real shell, and nonempty catalog with the trusted Host',()=>{
  const paths=[];const result=probeApp(config,{spawn:(_bin,args)=>{assert.ok(args.includes('Host: example.test'));const path=new URL(args.at(-1)).pathname;paths.push(path);return {status:0,stdout:bodies[path]+'\n200'};}});
  assert.equal(result.level,'ok');assert.deepEqual(paths,Object.keys(bodies));
});
test('a live process cannot conceal an empty catalog or a broken App page',()=>{
  for(const broken of ['/app','/api/app-catalog']){
    const result=probeApp(config,{spawn:(_bin,args)=>{const path=new URL(args.at(-1)).pathname;return {status:0,stdout:(path===broken?'{}':bodies[path])+'\n200'};}});
    assert.equal(result.level,'critical');assert.ok(result.detail.includes(broken));
  }
});
