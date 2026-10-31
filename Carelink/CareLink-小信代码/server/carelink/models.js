'use strict';
// No filesystem, cloud SDK, credentials, or implicit persistence in this module.
const KINDS=Object.freeze(['plan','dose','diet','discomfort','memory','pending','transfer','utterance']);
const clone=x=>structuredClone(x);
const str=(x,max=4000)=>typeof x==='string'&&x.trim().length>0&&x.length<=max;
const id=x=>str(x,120)&&/^[\w-]+$/.test(x);
const list=x=>Array.isArray(x)&&x.length<=50&&x.every(v=>str(v,200));
function scope(s){if(!s||!id(s.familyId)||!id(s.personId))throw Error('INVALID_SCOPE');return {familyId:s.familyId,personId:s.personId};}
function validate(r){
 if(!r||!KINDS.includes(r.kind)||!id(r.id)||!Number.isSafeInteger(r.createdAt)||r.createdAt<0)throw Error('INVALID_RECORD');scope(r);
 let ok=false;
 switch(r.kind){
 case 'plan':ok=str(r.name,200)&&str(r.dose,100)&&Array.isArray(r.times)&&r.times.length>0&&r.times.every(x=>/^([01]\d|2[0-3]):[0-5]\d$/.test(x))&&str(r.timeZone,80)&&['draft','active'].includes(r.status)&&Number.isSafeInteger(r.stock)&&r.stock>=0&&Number.isSafeInteger(r.unitsPerDose)&&r.unitsPerDose>0&&(r.status!=='active'||r.reviewedBy==='child');break;
 case 'dose':ok=id(r.planId)&&str(r.occurrence,200)&&['pending','taken','not_taken','unconfirmed','missed'].includes(r.status)&&Number.isSafeInteger(r.dueAt)&&typeof r.notified==='boolean';break;
 case 'diet':ok=list(r.foods)&&str(r.raw)&&str(r.audioRef);break;
 case 'discomfort':ok=list(r.symptoms)&&typeof r.urgent==='boolean'&&str(r.raw)&&str(r.audioRef);break;
 case 'memory':ok=str(r.raw)&&str(r.audioRef)&&list(r.people)&&typeof r.when==='string'&&typeof r.where==='string';break;
 case 'pending':ok=['photo','reminder','tip'].includes(r.type)&&['unheard','heard'].includes(r.status)&&Array.isArray(r.items);break;
 case 'transfer':ok=['up','down'].includes(r.direction)&&['queued','delivered'].includes(r.status)&&typeof r.urgent==='boolean'&&r.payload&&typeof r.payload==='object'&&str(r.dedupeKey,300);break;
 case 'utterance':ok=str(r.audioRef)&&typeof r.text==='string'&&['processed','unconfirmed'].includes(r.status)&&r.result&&typeof r.result==='object';break;
 }
 if(!ok)throw Error('INVALID_'+r.kind.toUpperCase());return clone(r);
}
// Adapter contract: transaction(scope, synchronous fn(tx)) -> Promise<result>.
// fn has get(kind,id), list(kind), put(record). Atomic, serializable, rollback on
// throw; unique (family,person,kind,id). Production adapter must implement this.
class MemoryRepository{
 constructor(){this.rows=new Map();this.tail=Promise.resolve();this.localTestOnly=true;}
 transaction(s,fn){s=scope(s);const run=this.tail.then(()=>{
  const prefix=JSON.stringify([s.familyId,s.personId])+':';const draft=new Map([...this.rows].map(([k,v])=>[k,clone(v)]));
  const key=(k,i)=>prefix+k+':'+i;
  const tx={get:(k,i)=>clone(draft.get(key(k,i))||null),list:k=>[...draft.entries()].filter(([n,v])=>n.startsWith(prefix)&&v.kind===k).map(([,v])=>clone(v)),put:r=>{r=validate(r);if(r.familyId!==s.familyId||r.personId!==s.personId)throw Error('SCOPE_MISMATCH');draft.set(key(r.kind,r.id),r);return clone(r)}};
  const value=fn(tx);if(value&&typeof value.then==='function')throw Error('ASYNC_TRANSACTION_CALLBACK');this.rows=draft;return clone(value);
 });this.tail=run.catch(()=>{});return run;}
}
module.exports={KINDS,scope,validate,MemoryRepository};
