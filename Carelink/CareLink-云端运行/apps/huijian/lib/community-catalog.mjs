import {readFile} from 'node:fs/promises';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {Readable} from 'node:stream';
import {readBoundedJson} from './bounded-response.mjs';

const unavailable=()=>Object.assign(new Error('case_policy_unavailable'),{status:503});
function fetchCanonicalPolicy(url,{signal,headers}){
  return new Promise((resolve,reject)=>{
    const transport=url.protocol==='https:'?httpsRequest:httpRequest;
    const request=transport(url,{method:'GET',signal,headers},response=>{
      resolve({ok:response.statusCode===200,headers:new Headers(response.headers),body:Readable.toWeb(response)});
    });request.on('error',reject);request.end();
  });
}
export function createCommunityCatalog({catalogPath,upstream=process.env.CANONICAL_UPSTREAM,publicOrigin=process.env.CANONICAL_PUBLIC_ORIGIN,fetchImpl=fetchCanonicalPolicy}={}) {
  async function policy(){
    if(!upstream)return null;
    let response;
    try {response=await fetchImpl(new URL('/v1/public/community/cases',upstream),{signal:AbortSignal.timeout(8000),redirect:'error',headers:{accept:'application/json',host:new URL(publicOrigin||upstream).host}});}catch{throw unavailable();}
    if(!response.ok){await response.body?.cancel().catch(()=>{});throw unavailable();}
    const body=await readBoundedJson(response,2*1024*1024);
    if(!Array.isArray(body?.cases)||body.cases.length>1000||body.cases.some(c=>!['catalog','example'].includes(c.source)||typeof c.sourceId!=='string'||c.status!=='visible'))throw unavailable();
    return body.cases;
  }
  async function catalog(){
    const original=JSON.parse(await readFile(catalogPath,'utf8')),rules=await policy();
    if(rules===null)return original;
    const entries=new Map(original.cases.map(c=>[c.id,c]));
    return {...original,cases:rules.filter(r=>r.source==='catalog'&&entries.has(r.sourceId)).map(r=>({...entries.get(r.sourceId),featured:r.featured,sortRank:r.sortRank}))};
  }
  async function examples(entries){
    const rules=await policy();if(rules===null)return entries;
    const byId=new Map(entries.map(e=>[e.id,e]));return rules.filter(r=>r.source==='example'&&byId.has(r.sourceId)).map(r=>({...byId.get(r.sourceId),featured:r.featured,sortRank:r.sortRank}));
  }
  async function exampleVisible(id){const rules=await policy();return rules===null||rules.some(r=>r.source==='example'&&r.sourceId===id);}
  return {catalog,examples,exampleVisible};
}
