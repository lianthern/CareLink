'use strict';
const {scope}=require('./models');
const R=require('./rules'),C=require('./classification');
const digest=x=>require('node:crypto').createHash('sha256').update(x).digest('hex').slice(0,32);
const validEvent=(id,now)=>{if(typeof id!=='string'||!/^[-\w]{1,120}$/.test(id)||!Number.isSafeInteger(now)||now<0)throw Error('INVALID_EVENT');};
const common=(s,kind,id,now)=>({...scope(s),kind,id,createdAt:now});
function transfer(s,key,payload,now,{direction='up',urgent=false}={}){return {...common(s,'transfer',digest(key),now),direction,urgent,status:'queued',dedupeKey:key,payload};}
function localTime(now,timeZone){return new Intl.DateTimeFormat('zh-CN',{timeZone,dateStyle:'full',timeStyle:'short',hour12:false}).format(new Date(now));}
function createCareLink({repository,model,fallbackModel,approvedAdvice=()=>null,modelTimeoutMs=3000}={}){
 if(!repository||typeof repository.transaction!=='function')throw Error('REPOSITORY_REQUIRED');
 const tx=(s,fn)=>repository.transaction(scope(s),fn);
 async function receive(s,input){
  scope(s);if(!input||typeof input.id!=='string'||!/^[-\w]{1,120}$/.test(input.id)||typeof input.text!=='string'||input.text.length>4000||typeof input.audioRef!=='string'||!input.audioRef.trim()||!Number.isSafeInteger(input.now)||input.now<0||!Number.isFinite(input.confidence)||input.confidence<0||input.confidence>1)throw Error('INVALID_ASR_RESULT');
  const prior=await tx(s,t=>t.get('utterance',input.id));if(prior)return prior.result;
  // Deterministic safety is evaluated before awaiting any model. Urgent speech
  // bypasses the model entirely; notifier drains urgent outbox immediately.
  const urgentWords=R.emergencies(input.text),boundary=R.medicalBoundary(input.text);
  let classified={value:C.empty(),valid:false,reason:'unclear'};
  if(!urgentWords.length&&input.confidence>=0.6&&!input.unclear)classified=await C.classify(model,{text:input.text,localTime:localTime(input.now,input.timeZone||'Asia/Shanghai')},{timeoutMs:modelTimeoutMs,fallbackModel});
  const c=classified.value,urgent=urgentWords.length>0||c.urgent;
  const uncertain=!urgent&&(!classified.valid||input.unclear||input.confidence<0.6);
  let advice=null;if(!uncertain&&!urgent){try{advice=await approvedAdvice({classification:c,scope:scope(s)});}catch{}}
  const spoken=urgent?{text:'请先在安全的地方坐下，立即联系家人；需要急救请拨打120。',reason:'H6'}:boundary?{text:'请咨询医生，不要自行调整用药。',reason:'G1'}:uncertain?{text:'这段声音已保留，家人可以帮您查看。',reason:'unclear'}:R.guardReply({text:input.text,classification:c,approvedTip:advice});
  return tx(s,t=>{
   const exists=t.get('utterance',input.id);if(exists)return exists.result;
   const records=[],add=(kind,data)=>{const r={...common(s,kind,digest(input.id+':'+kind),input.now),...data};t.put(r);records.push({kind,id:r.id});};
   const status=uncertain?'unconfirmed':'processed';
   // Never use model-supplied medication ids or update a dose without a spoken
   // acknowledgement. A noisy/invalid classification cannot mark it taken.
   const med=uncertain||urgent?'none':R.medication(input.text);
   const requested=input.doseIds;
   if(requested!==undefined&&(!Array.isArray(requested)||requested.some(i=>typeof i!=='string')))throw Error('INVALID_DOSE_CONTEXT');
   const doses=t.list('dose').filter(d=>['pending','missed','unconfirmed','not_taken'].includes(d.status)&&d.dueAt<=input.now&&(requested?requested.includes(d.id):input.now-d.dueAt<86400000));
   if(uncertain||med!=='none')for(const d of doses){const next={...d,status:uncertain?'unconfirmed':med,audioRef:input.audioRef,confirmedAt:input.now};t.put(next);records.push({kind:'dose',id:d.id});if(med==='taken'){const plan=t.get('plan',d.planId);if(plan)t.put({...plan,stock:Math.max(0,plan.stock-plan.unitsPerDose)});}}
   if(!uncertain){
    if(c.foods.length)add('diet',{foods:c.foods,raw:input.text,audioRef:input.audioRef});
    if(c.symptoms.length||urgent)add('discomfort',{symptoms:[...new Set([...urgentWords,...c.symptoms])],urgent,raw:input.text,audioRef:input.audioRef});
    if(c.memory)add('memory',{...c.memory,raw:input.text,audioRef:input.audioRef});
   }
   const child={text:input.text,audioRef:input.audioRef,status,classification:c,urgentWords,guard:spoken.reason,records};
   const out=transfer(s,'utterance:'+input.id,child,input.now,{urgent});t.put(out);
   const result={elder:{...R.elderPolicy,text:spoken.text,askRepeat:false,autoReply:true},child,notification:{id:out.id,priority:urgent?'immediate':'normal',state:'queued'},records,status};
   t.put({...common(s,'utterance',input.id,input.now),text:input.text,audioRef:input.audioRef,status,result});return result;
  });
 }
 async function savePlan(s,plan,{reviewedBy}={}){return tx(s,t=>{if(reviewedBy!=='child'&&plan.status==='active')throw Error('CHILD_REVIEW_REQUIRED');return t.put({...plan,...scope(s),kind:'plan',reviewedBy:reviewedBy||null});});}
 async function refill(s,planId,units,eventId,now){validEvent(eventId,now);if(!Number.isSafeInteger(units)||units<=0)throw Error('INVALID_REFILL');return tx(s,t=>{const key='refill:'+planId+':'+eventId;const tid=digest(key);if(t.get('transfer',tid))return t.get('plan',planId);const p=t.get('plan',planId);if(!p)throw Error('PLAN_NOT_FOUND');const updated=t.put({...p,stock:p.stock+units});t.put(transfer(s,key,{type:'refill',planId,units},now));return updated;});}
 async function schedule(s,{date,time,now,dueAt}){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)||!Number.isSafeInteger(now)||!Number.isSafeInteger(dueAt)||dueAt>now)throw Error('INVALID_SCHEDULE');
  return tx(s,t=>{const group=R.reminderGroups(t.list('plan'),date,now).find(g=>g.slot===date+'T'+time);if(!group)return null;
   const key='reminder:'+group.slot;const pendingId=digest(key);if(t.get('pending',pendingId))return null;
   const items=group.plans.map(p=>{const id=digest(p.id+':'+group.slot);t.put({...common(s,'dose',id,now),planId:p.id,occurrence:group.slot,status:'pending',dueAt,notified:false});return {doseId:id,planId:p.id,playback:R.playback(p)};});
   const pending={...common(s,'pending',pendingId,now),type:'reminder',status:'unheard',items};t.put(pending);t.put(transfer(s,key,{type:'reminder',pendingId,light:true,chime:true,autoPlay:false,changePhoto:false},now,{direction:'down'}));return pending;
  });
 }
 async function checkTimeouts(s,now,timeoutMs=1800000){return tx(s,t=>{const result=[];for(const d of t.list('dose')){const next=R.timeout(d,now,timeoutMs);if(next){t.put(next);const item=transfer(s,'timeout:'+d.id,{type:'no_response',doseId:d.id,elderRepeat:false},now);t.put(item);result.push(item);}}return result;});}
 async function sendPhoto(s,{id,audioRef,imageRef,now}){validEvent(id,now);const effects=R.photoArrival({audioRef});if(typeof imageRef!=='string'||!imageRef.trim())throw Error('PHOTO_REQUIRED');return tx(s,t=>{const pid=digest('photo:'+id);if(t.get('pending',pid))return t.get('pending',pid);const p={...common(s,'pending',pid,now),type:'photo',status:'unheard',items:[{imageRef,audioRef}]};t.put(p);t.put(transfer(s,'photo:'+id,{pendingId:pid,...effects},now,{direction:'down'}));return p;});}
 async function sendTip(s,{id,text,audioRef,reviewed,now}){validEvent(id,now);if(reviewed!==true||typeof text!=='string'||!text.trim()||R.medicalBoundary(text)||/警报|告警/.test(text))throw Error('REVIEWED_SAFE_TIP_REQUIRED');return tx(s,t=>{const pid=digest('tip:'+id);if(t.get('pending',pid))return t.get('pending',pid);const p={...common(s,'pending',pid,now),type:'tip',status:'unheard',items:[{playback:R.playback({voiceRef:audioRef,reminderText:text})}]};t.put(p);t.put(transfer(s,'tip:'+id,{pendingId:pid,light:true,chime:true,autoPlay:false},now,{direction:'down'}));return p;});}
 async function acknowledgeHeard(s,id){return tx(s,t=>{const p=t.get('pending',id);if(!p)throw Error('PENDING_NOT_FOUND');return t.put({...p,status:'heard'});});}
 async function flush(s,{online,deliver,direction='up'}={}){
  if(!online)return {delivered:[],failed:[]};if(typeof deliver!=='function')throw Error('DELIVERY_ADAPTER_REQUIRED');
  const queued=await tx(s,t=>R.orderTransfers(t.list('transfer').filter(r=>r.direction===direction)));const result={delivered:[],failed:[]};
  for(const item of queued){try{const ack=await deliver(item,{idempotencyKey:item.id});if(!ack||ack.accepted!==true)throw Error('NOT_ACKNOWLEDGED');await tx(s,t=>{const current=t.get('transfer',item.id);t.put({...current,status:'delivered'});});result.delivered.push(item.id);}catch{result.failed.push(item.id);}}
  return result;
 }
 // ASR result entry point with an optional explicit transport. Emergency routes
 // call this immediately; failed/absent delivery always remains in the outbox.
 async function process(s,input,delivery={}){const result=await receive(s,input);let receipt=null;if(delivery.online&&typeof delivery.deliver==='function')receipt=await flush(s,{...delivery,direction:'up'});return {...result,delivery:receipt};}
 return {receive,process,savePlan,refill,schedule,checkTimeouts,sendPhoto,sendTip,acknowledgeHeard,flush,list:(s,kind)=>tx(s,t=>t.list(kind))};
}
module.exports={createCareLink,localTime};
