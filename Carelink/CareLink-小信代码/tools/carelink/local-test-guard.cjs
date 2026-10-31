'use strict';
// Applied to BOTH baseline and final runs. Never opens configuration/secrets.
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path');
function blocked(p){return typeof p==='string'&&(/^\/(private\/)?etc\//.test(p)||/\.(pem|key|pk8|jks|keystore)$/.test(p));}
for(const name of ['readFile','open']){const old=fsp[name];fsp[name]=async function(p,...args){if(blocked(p))throw Object.assign(Error('LOCAL_TEST_BLOCKED'),{code:'EACCES'});return old.call(this,p,...args)}}
for(const name of ['readFileSync','openSync']){const old=fs[name];fs[name]=function(p,...args){if(blocked(p))throw Object.assign(Error('LOCAL_TEST_BLOCKED'),{code:'EACCES'});return old.call(this,p,...args)}}
const net=require('node:net');const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){let a=args[0];if(Array.isArray(a))a=a[0];const h=typeof a==='object'?a.host:typeof args[1]==='string'?args[1]:undefined;if(h&&!['localhost','127.0.0.1','::1'].includes(h))throw Error('LOCAL_TEST_NETWORK_BLOCKED');return connect.apply(this,args)};
const originalFetch=global.fetch;
global.fetch=function(url,...args){const u=new URL(typeof url==='string'?url:url.url||url);if(!['localhost','127.0.0.1','::1','[::1]'].includes(u.hostname))throw Error('LOCAL_TEST_NETWORK_BLOCKED');return originalFetch(url,...args)};
// Old tests hard-code their output directory relative to the old checkout.
const oldRoot=path.resolve(__dirname,'../../../../outputs');const output=path.resolve(__dirname,'../../evidence/legacy-output');
for(const name of ['mkdir','writeFile']){const old=fsp[name];fsp[name]=function(p,...args){if(typeof p==='string'&&p.startsWith(oldRoot+'/'))p=output+p.slice(oldRoot.length);return old.call(this,p,...args)}}
try{const {chromium}=require('/opt/homebrew/lib/node_modules/playwright');const launch=chromium.launch.bind(chromium);chromium.launch=async function(options){const b=await launch(options);const nc=b.newContext.bind(b);b.newContext=async function(o){const c=await nc(o);await c.route('**/*',r=>{const u=new URL(r.request().url());return ['127.0.0.1','localhost','::1'].includes(u.hostname)||['data:','blob:'].includes(u.protocol)?r.continue():r.abort()});return c};return b}}catch{}
