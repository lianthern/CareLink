import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { trustedVisitorIdentity } from './tts-cost-gate.mjs';
const allowed = path => /^\/(?:v1|v2-labs)\//.test(path) || /^\/__local\/media\//.test(path) || /^\/__local-operable\/private-media\//.test(path) || /^\/__book_lab_web__\/(?:src\/.*\.mjs|catalog\.json)$/.test(path);
export function isCanonicalPath(path) { return allowed(path); }
export function proxyCanonical(req,res,{upstream=process.env.CANONICAL_UPSTREAM,publicOrigin=process.env.CANONICAL_PUBLIC_ORIGIN}={}) {
 if(!upstream){res.writeHead(503,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({error:{code:'canonical_not_configured'}}));return;}
 const target=new URL(req.url,new URL(upstream));
 const base=new URL(upstream);
 if(target.origin!==base.origin||!allowed(target.pathname))throw new Error('canonical_path_invalid');
 const headers={...req.headers,host:new URL(publicOrigin||upstream).host};
 for(const key of ['connection','keep-alive','proxy-authorization','proxy-authenticate','upgrade','transfer-encoding','x-forwarded-host','x-forwarded-proto','x-forwarded-for'])delete headers[key];
 // Caddy replaces X-Huijian-Visitor; accept it only from the local reverse proxy.
 // Rebuild the canonical risk identity instead of merging caller-supplied chains.
 const visitor=trustedVisitorIdentity(req);
 delete headers['x-huijian-visitor'];
 if(isIP(visitor))headers['x-forwarded-for']=visitor;
 if(req.headers.origin)headers.origin=new URL(publicOrigin||upstream).origin;
 headers['sec-fetch-site']='same-origin';
 headers['accept-encoding']='identity';
 const transport=target.protocol==='https:'?httpsRequest:httpRequest;
 const outgoing=transport(target,{method:req.method,headers,timeout:60000},incoming=>{
  incoming.once("aborted",()=>{if(!res.writableEnded)res.destroy();});
  incoming.once("error",()=>{if(!res.writableEnded)res.destroy();});
  try {
  const responseHeaders={...incoming.headers,'cache-control':'no-store'};
  delete responseHeaders.connection;delete responseHeaders['transfer-encoding'];
  // Canonical API cannot send the browser to another application's full-page UI.
  if(responseHeaders.location){const location=new URL(responseHeaders.location,base);if(location.origin===base.origin)responseHeaders.location=location.pathname+location.search;else delete responseHeaders.location;}
  res.writeHead(incoming.statusCode,responseHeaders);incoming.pipe(res);
  } catch { if(!res.headersSent){res.writeHead(502,{"content-type":"application/json","cache-control":"no-store"});res.end(JSON.stringify({error:{code:"canonical_response_invalid"}}));}else res.destroy(); incoming.destroy(); }
 });
 outgoing.on('timeout',()=>outgoing.destroy(new Error('canonical_timeout')));
 outgoing.on('error',()=>{if(!res.headersSent){res.writeHead(502,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({error:{code:'canonical_unavailable'}}));}else res.destroy();});
 req.once('aborted',()=>outgoing.destroy());res.once('close',()=>{if(!res.writableEnded)outgoing.destroy();});
 req.pipe(outgoing);
}
