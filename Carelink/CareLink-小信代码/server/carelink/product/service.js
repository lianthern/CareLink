'use strict';
const {createEngine}=require('./engine');
const {turn,chat}=require('./assistant');
const crypto=require('node:crypto');
const local=new Set(['xx','scr','ptab','ctab','meal','modal','who','mode','recStart','sound','scen','gstep','utter']);
function merge(current,base,next){
 if(JSON.stringify(current)===JSON.stringify(base))return next;
 if(Array.isArray(base)&&Array.isArray(next)&&Array.isArray(current)){
  const key=x=>x&&x.id?'id:'+x.id:JSON.stringify(x),before=new Map(base.map(x=>[key(x),x])),after=new Map(next.map(x=>[key(x),x]));
  const result=current.filter(x=>!before.has(key(x))||after.has(key(x))).map(x=>before.has(key(x))&&after.has(key(x))?merge(x,before.get(key(x)),after.get(key(x))):x);
  const exists=new Set(result.map(key));for(const x of next)if(!exists.has(key(x))&&!before.has(key(x)))result.push(x);return result;
 }
 if(base&&next&&current&&typeof base==='object'&&typeof next==='object'&&typeof current==='object'&&!Array.isArray(base)){const r={...current};for(const k of Object.keys(next)){if(['__proto__','constructor','prototype'].includes(k))continue;if(JSON.stringify(base[k])!==JSON.stringify(next[k]))r[k]=merge(current[k],base[k],next[k]);}for(const k of Object.keys(base))if(!Object.hasOwn(next,k)&&JSON.stringify(current[k])===JSON.stringify(base[k]))delete r[k];return r;}
 if(typeof current==='number'&&typeof base==='number'&&typeof next==='number')return current+next-base;
 return next;
}
function createProduct(store,options={}){
 const locks=new Map();
 async function handle(action,data,s){
  const prior=locks.get(s.room)||Promise.resolve();const work=prior.catch(()=>{}).then(()=>run(action,data,s));locks.set(s.room,work);try{return await work}finally{if(locks.get(s.room)===work)locks.delete(s.room)}
 }
 // Last turns and voice-line events: the only remote view of what happens on a frame in the field.
 async function journal(room,entry){const id='carelink_turns_'+room,doc=await store.get(id)||{_id:id,kind:'carelinkTurns',room,entries:[]};doc.entries=doc.entries.concat({at:Date.now(),...entry}).slice(-80);await store.put(doc);}
 async function log(s,text,a,via,started){const client={answer:a.answer,action:a.action,client:a.client,volume:a.volume,emergency:a.emergency};await journal(s.room,{type:'turn',via,text:text.slice(0,200),answer:a.answer,action:a.action,source:a.source,ms:Date.now()-started});return client;}
 // Pictures must not live in the shared state: both ends fetch it every 1.5 s, and it has a size limit.
 const urlHash=value=>crypto.createHash('sha256').update(value).digest('hex');
 async function offload(state,room){
  const walk=async(node)=>{if(!node||typeof node!=='object')return;for(const key of Object.keys(node)){const v=node[key];
    if(typeof v==='string'){const m=v.length>3000&&/^data:(image\/(?:jpeg|png|webp));base64,/.exec(v);if(!m)continue;
     const key2='carelink_image_'+crypto.randomUUID(),file=await store.upload(key2,Buffer.from(v.slice(m[0].length),'base64')),access=crypto.randomBytes(24).toString('hex');
     await store.put({_id:'d_'+urlHash(access),kind:'download',room,file,mime:m[1],expires:Date.now()+365*86400000});node[key]='/media/'+access;
    }else await walk(v);}};
  await walk(state);
 }
 async function run(action,data,s){
  const started=Date.now();
  if(action==='carelinkProductDiag'){await journal(s.room,{type:'diag',event:String(data.event||'').slice(0,40),detail:JSON.stringify(data.detail||null).slice(0,1500)});return {ok:true};}
  const id='carelink_product_'+s.room;let doc=await store.get(id);
  // The common poll: nothing changed and no minute has passed, so skip the engine and the payload.
  if(doc&&action==='carelinkProductState'&&data.since===doc.revision&&Date.now()-(doc.lastTick||0)<(options.fake?1000:60000))return {unchanged:true,revision:doc.revision};
  if(doc&&JSON.stringify(doc.state).length>100000){await offload(doc.state,s.room);await store.put(doc);}
  const engine=createEngine(doc&&doc.state),created=!doc;
  // Reminders run on China time; the server's own clock is UTC.
  if(!doc&&!options.fake){const cn=new Date(Date.now()+8*3600000);engine.prototype.state().clock=cn.getUTCHours()*60+cn.getUTCMinutes();}
  // Documents from before these switches existed: on by default, and present so the phone can change them.
  {const live=engine.prototype.state();if(live.remindPopup===undefined){live.remindPopup=true;live.remindVoice=true;if(doc)doc.state=engine.snapshot();}}
  if(!doc)doc={_id:id,kind:'carelinkProduct',room:s.room,revision:0,ops:[],lastTick:Date.now(),state:engine.snapshot()};
  const interval=options.fake?1000:60000,elapsed=Math.min(1440,Math.floor((Date.now()-(doc.lastTick||Date.now()))/interval));
  if(elapsed>0){
   // Small lag behind China time (older versions drifted) is caught up here; a large gap means the demo console moved the clock on purpose.
   let ticks=elapsed;if(!options.fake){const cn=new Date(Date.now()+8*3600000),behind=cn.getUTCHours()*60+cn.getUTCMinutes()-engine.prototype.state().clock;if(behind>elapsed&&behind<=15)ticks=behind;}
   for(let i=0;i<ticks;i++)await engine.call('tick');doc.state=engine.snapshot();doc.revision++;doc.lastTick=elapsed>=1440?Date.now():doc.lastTick+elapsed*interval;await store.put(doc);
  }
  if(action==='carelinkProductState'){if(created||!doc.lastTick){doc.lastTick=doc.lastTick||Date.now();await store.put(doc);}return {state:doc.state,revision:doc.revision,demo:!!options.fake};}
  // A frame that gave up waiting retries the same recording: it still needs the reply it missed.
  if(data.opId&&doc.ops.includes(data.opId))return {state:doc.state,revision:doc.revision,duplicate:true,assistant:(doc.replies||{})[data.opId]};
  if(action==='carelinkProductPatch'){
   for(const [key,value]of Object.entries(data.patch||{})){if(!Object.hasOwn(doc.state,key)||local.has(key)||['__proto__','constructor','prototype'].includes(key))continue;doc.state[key]=data.revision===doc.revision?value:merge(doc.state[key],(data.base||{})[key],value);}
   await offload(doc.state,s.room);if(JSON.stringify(doc.state).length>3000000)throw Error('STATE_TOO_LARGE');engine.set(doc.state);
  }else if(action==='carelinkProductCommand'){
   const allowed=options.fake?['scenario','tick','fireReminders','flushQueues','process']:['tick','fireReminders','flushQueues'];
   if(!allowed.includes(data.command))throw Error('COMMAND_NOT_ALLOWED');
   await engine.call(data.command,...(data.args||[]));
  }else if(action==='carelinkProductUploadAudio'){
   const audio=String(data.audio||'');if(!audio||audio.length>2800000)throw Error('AUDIO_REQUIRED');const audioId='carelink_audio_'+crypto.randomUUID();const file=await store.upload(audioId+'.wav',Buffer.from(audio,'base64'));await store.put({_id:audioId,kind:'carelinkAudio',room:s.room,file,createdAt:Date.now()});return {audioId};
  }else if(action==='carelinkProductVoice'){
   const audio=String(data.audio||'');if(audio.length>2800000||!audio)throw Error('AUDIO_REQUIRED');
   const audioId='carelink_audio_'+crypto.randomUUID();const file=await store.upload(audioId+'.wav',Buffer.from(audio,'base64'));await store.put({_id:audioId,kind:'carelinkAudio',room:s.room,file,createdAt:Date.now()});
   let transcript='',degraded=false,assistant;
   try{transcript=options.fake?engine.prototype.utterances[Number(data.fixture)||0].t:await require('./providers').recognize(Buffer.from(audio,'base64'))}catch(_){degraded=true}
   if(transcript){
    assistant=await turn(engine,transcript,{fake:options.fake,ctx:data.ctx,id:audioId,dur:Math.round(Buffer.from(audio,'base64').length/32000),options:options.assistant});
    assistant.added.forEach(f=>{f.audioId=audioId;f.btns=f.btns||[];if(!f.btns.some(b=>b[2].startsWith('audio')))f.btns.push(['','听原音频','audio:'+audioId]);});
   }else{engine.prototype.state().feed.unshift({id:crypto.randomUUID(),ic:'🎙',title:'收到一段语音，待家人听取',desc:'没听清内容，原声已保存',t:engine.prototype.state().clock,tab:'home',audioId,btns:[['','听原音频','audio:'+audioId]]});assistant={answer:'没太听清，原声我先留给家人了。',action:'none',source:'no-speech',added:[]};}
   doc.lastAssistant=await log(s,transcript,assistant,'record',started);
   doc.lastVoice={audioId,transcript,degraded};
  }else if(action==='carelinkProductAssistant'){
   const text=String(data.text||'').trim().slice(0,500);if(!text)throw Error('TEXT_REQUIRED');
   const id=String(data.opId||crypto.randomUUID()).slice(0,100),assistant=await turn(engine,text,{fake:options.fake,ctx:data.ctx,id,options:options.assistant});
   // Spoken through the realtime line: there is no saved recording to offer.
   assistant.added.forEach(f=>{f.btns=(f.btns||[]).filter(b=>!String(b[2]).startsWith('audio'));});
   doc.lastAssistant=await log(s,text,assistant,String(data.via||'button').slice(0,12),started);
  }else if(action==='carelinkProductChat'){
   if(s.role==='frame')throw Error('FAMILY_ONLY');
   const text=String(data.text||'').trim().slice(0,500);if(!text)throw Error('TEXT_REQUIRED');
   if(options.fake)return {reply:null};
   let reply=null;try{reply=await chat(engine,text,data.history,options.assistant);}catch(_){}
   await journal(s.room,{type:'chat',text:text.slice(0,200),answer:reply&&reply.answer,action:reply&&reply.act,ms:Date.now()-started});
   return {reply};
  }else if(action==='carelinkProductHear'){
   if(s.role==='frame')throw Error('FAMILY_ONLY');
   const audio=String(data.audio||'');if(!audio||audio.length>1400000)throw Error('AUDIO_REQUIRED');
   if(options.fake)return {text:''};
   try{return {text:await require('./providers').recognize(Buffer.from(audio,'base64'))};}catch(_){return {text:''};}
  }else if(action==='carelinkProductAudio'){
   const audio=await store.get(String(data.id||''));if(!audio||audio.room!==s.room||audio.kind!=='carelinkAudio')throw Error('AUDIO_NOT_FOUND');return {audio:audio.file?(await store.read(audio.file)).toString('base64'):audio.audio};
  }else if(action==='carelinkProductSpeech')return require('./providers').speak(String(data.text||'').slice(0,1200),options.fake);
  else throw Error('UNKNOWN_PRODUCT_ACTION');
  const assistant=doc.lastAssistant;delete doc.lastAssistant;if(assistant&&data.opId)doc.replies=Object.fromEntries(Object.entries({...(doc.replies||{}),[String(data.opId).slice(0,100)]:assistant}).slice(-5));doc.state=engine.snapshot();doc.revision++;if(data.opId)doc.ops=doc.ops.concat(String(data.opId).slice(0,100)).slice(-500);await store.put(doc);return {state:doc.state,revision:doc.revision,voice:doc.lastVoice,assistant};
 }
 return {handle};
}
module.exports={createProduct,merge};
