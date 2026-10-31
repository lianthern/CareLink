(function(root) {
 'use strict';
 var config=root.CareLinkConfig;
 if(!config.enabled)return;
 var K=root.CareLinkKeys,R=root.CareLinkRules,media=root.CareLinkMedia;
 var state=K.initial(),rows=[],queue=null,photo=null,capture=null,startPromise=null,job=0,flushing=false,closing=false,unsaved=null,online=navigator.onLine!==false;
 var session=null,transport=null,scope='',syncing=false,pendingOps=Promise.resolve(),playEpoch=0;
 var $=function(id){return document.getElementById(id);};
 try{session=JSON.parse(localStorage.getItem('memory-session-frame')||'null');}catch(_){}
 try{transport=parent.CareLinkTransport||null;}catch(_){}
 // Never send new voice/health data to the legacy Hong Kong endpoint.
 if(transport&&!['ap-shanghai','local-test-only'].includes(transport.region))transport=null;
 scope=session&&session.room;
 function status(text){$('status').textContent=text;}
 function pending(){return rows.filter(function(r){return r.kind==='inbox'&&!r.heard;}).sort(function(a,b){return (a.type==='photo'?1:0)-(b.type==='photo'?1:0)||a.createdAt-b.createdAt;});}
 function render(){
  if(photo&&photo.imageBlob&&!photo.localURL)photo.localURL=URL.createObjectURL(photo.imageBlob);
  var p=pending(),count=rows.filter(function(r){return r.kind==='voice'&&r.status==='queued';}).length;
  $('carelink').hidden=false;$('brand').textContent=config.brand;$('clock').textContent=new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false});
  $('carelink').className=(photo?'':'empty ')+state.mode;$('photo').hidden=!photo;$('empty').hidden=!!photo;if(photo&&$('photo').getAttribute('src')!==(photo.localURL||photo.imageURL))$('photo').src=photo.localURL||photo.imageURL;
  $('dot').hidden=!p.some(function(r){return r.type==='photo';});$('light').hidden=!p.some(function(r){return r.type!=='photo';});
  $('offline').hidden=online&&count===0;$('offline').textContent=count?'有 '+count+' 段话保存在相框，连接后自动送出':'暂时没有网络，照片还在，您也可以留言';
  $('recording').hidden=state.mode!=='recording';$('elapsed').textContent='00:'+('0'+Math.min(30,Math.max(0,Math.floor((Date.now()-(state.startedAt||Date.now()))/1000)))).slice(-2);
  $('listen').hidden=$('speak').hidden=config.device!=='dual';$('main').hidden=config.device==='dual';
  $('main').textContent=state.mode==='recording'?'说好了':state.mode==='playing'?'回一句':p.length?'听留言':'说句话';$('speak').textContent=state.mode==='recording'?'说好了':'说';
  [$('main'),$('listen'),$('speak')].forEach(function(b){b.disabled=!queue||!!unsaved||state.mode==='processing';});
 }
 function bubble(text,synthetic,who){$('speaker').textContent=who||(synthetic?'小信':'家人的原声');$('words').textContent=text;$('synthetic').hidden=!synthetic;$('bubble').hidden=false;}
 function reset(){state=K.initial();render();}
 function bounded(fn){var timer;return Promise.race([Promise.resolve().then(fn),new Promise(function(_,reject){timer=setTimeout(function(){reject(Error('TRANSPORT_TIMEOUT'));},15000);})]).then(function(v){clearTimeout(timer);return v;},function(e){clearTimeout(timer);throw e;});}
 async function save(row){await queue.put(row);var i=rows.findIndex(function(r){return r.id===row.id;});if(i<0)rows.push(row);else rows[i]=row;}
 async function flush(){
  if(flushing||!queue||!online||!transport||closing)return;
  flushing=true;
  try{
   var transfers=R.orderTransfers(rows.filter(function(r){return r.kind==='voice';}));
   for(var i=0;i<transfers.length;i++){
    var row=transfers[i];
    try{
     var result=await bounded(function(){return transport.sendVoice({id:row.id,room:scope,audio:row.audio,createdAt:row.createdAt,urgent:row.urgent,context:row.context});});
     if(closing)return;
     if(!result||result.id!==row.id||result.accepted!==true)throw Error('ACK_REQUIRED');
     await save(Object.assign({},row,{status:'delivered'}));
     // Only the policy-filtered elder reply is allowed here, never child analysis.
     if(result.elderReply&&state.mode==='idle'){
      var safe=R.guardReply({text:'',classification:{answer:String(result.elderReply),foods:[],symptoms:[],medicalRequest:false}}).text;
      var replyEpoch=++playEpoch;state.mode='playing';bubble(safe,true);render();await media.play({text:safe});if(replyEpoch===playEpoch)event({type:'playbackEnded',at:Date.now()});
     }
    }catch(_){break;}
   }
  }finally{flushing=false;render();}
 }
 async function recordStart(){
  var epoch=++job;status('');$('bubble').hidden=true;
  startPromise=media.capture();
  try{var owned=await startPromise;if(epoch!==job||closing){owned.cancel();return;}capture=owned;}
  catch(_){if(epoch===job){status('暂时没能打开麦克风，请让家人帮忙看看');reset();}}
 }
 async function recordStop(){
  try{
   if(startPromise)await startPromise;
   if(!capture){reset();return;}
   var blob=capture.stop();capture=null;
   unsaved={id:'voice-'+Date.now()+'-'+Math.random().toString(36).slice(2),kind:'voice',audio:blob,status:'queued',urgent:false,createdAt:Date.now(),context:photo?{photoId:photo.sourceId||photo.id}:null};
   await save(unsaved);unsaved=null;status('这段话已保存在相框');
  }catch(_){status(unsaved?'这段话还在，请保持相框开启，正在重试保存':'这次没有录到声音，您可以继续看照片');}
  finally{startPromise=null;reset();flush();}
 }
 async function playPending(){
  var epoch=++playEpoch,items=pending();
  if(items.length&&items[0].type==='photo')items=items.slice(0,1);else items=items.filter(function(r){return r.type!=='photo';});
  for(var i=0;i<items.length;i++){
   if(epoch!==playEpoch||closing)return;
   var item=items[i],clips=item.type==='photo'?[{audioRef:item.audioBlob?URL.createObjectURL(item.audioBlob):item.audioRef,synthetic:false,text:'听听家人的留言'}]:item.plans.map(R.playback);
   if(item.type==='photo'){photo=item;await save({id:'current-photo',kind:'current',photo:item});render();}
   for(var j=0;j<clips.length;j++){
    var clip=clips[j];bubble(clip.text||'听听家人的留言',clip.synthetic);
    var ok=await media.play(clip);if(item.audioBlob&&clip.audioRef)URL.revokeObjectURL(clip.audioRef);
    if(epoch!==playEpoch||closing)return;
    if(!ok){status('这段声音暂时没能播放，稍后还可以听');reset();return;}
   }
   await save(Object.assign({},item,{heard:true}));
  }
  if(epoch===playEpoch){$('bubble').hidden=true;event({type:'playbackEnded',at:Date.now()});}
 }
 function effects(list){list.forEach(function(effect){
  if(effect==='start_recording')recordStart();
  if(effect==='stop_recording')recordStop();
  if(effect==='play_pending')playPending().catch(function(){status('内容还在，稍后可以继续听');reset();});
  if(effect==='stop_playback'){playEpoch++;media.stop();$('bubble').hidden=true;}
  if(effect==='cancel_recording'){job++;if(capture)capture.cancel();capture=null;}
  if(effect==='open_settings'){try{if(parent!==root&&parent.UnseenDeviceUI)parent.UnseenDeviceUI.open();}catch(_){}event({type:'settingsClosed',at:Date.now()});}
 });}
 function event(e){if(closing||!queue)return;var next=K.transition(state,e,config);state=next.state;render();effects(next.effects);}
 function press(key){if(unsaved)return true;var at=Date.now();event({type:'down',key:key,at:at});event({type:'up',key:key,at:at+1,hasUnheard:pending().length>0});return true;}
 async function receive(input){
  if(!queue||closing)throw Error('FRAME_NOT_READY');
  if(!input||typeof input.id!=='string'||!input.id||!['photo','reminder'].includes(input.type))throw Error('INVALID_INBOX');
  if(rows.some(function(r){return r.id==='inbox-'+input.id;}))return;
  var row=Object.assign({},input,{id:'inbox-'+input.id,sourceId:input.id,kind:'inbox',heard:false,createdAt:input.createdAt||Date.now()});
  if(input.type==='photo'){
   R.photoArrival(input);if(typeof input.imageURL!=='string'||!input.imageURL)throw Error('PHOTO_URL_REQUIRED');
  }else{
   if(!Array.isArray(input.plans)||!input.plans.length||typeof input.slot!=='string'||!input.slot)throw Error('INVALID_REMINDER');
   row.plans=input.plans.map(function(p){return {voiceRef:p.voiceRef||'',reminderText:R.guardReply({text:'',classification:{answer:p.reminderText||'',foods:[],symptoms:[],medicalRequest:false}}).text};});
  }
  var chime=row.type==='reminder'&&!rows.some(function(r){return r.kind==='inbox'&&r.slot===row.slot;});
  await save(row);
  if(row.type==='photo'){try{var cached=await bounded(async function(){var image=await fetch(row.imageURL),audio=await fetch(row.audioRef);if(!image.ok||!audio.ok)throw Error('CACHE_UNAVAILABLE');return {image:await image.blob(),audio:await audio.blob()};});row=Object.assign({},row,{imageBlob:cached.image,audioBlob:cached.audio});await save(row);}catch(_){} }
  if(!photo&&row.type==='photo'&&input.initial===true){photo=row;await save({id:'current-photo',kind:'current',photo:row});}
  render();if(chime)media.chime();
 }
 async function synchronize(){
  if(!queue||closing||syncing||!session)return;
  syncing=true;
  try{
   var snapshot;
   if(transport&&transport.photos) snapshot=await bounded(function(){return transport.photos();});
   else {
    var controller=typeof AbortController==='function'?new AbortController():null;
    var timer=setTimeout(function(){if(controller)controller.abort();},10000);
    try{var response=await fetch('/api',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+session.token},body:JSON.stringify({action:'state',data:{}}),signal:controller?controller.signal:undefined});
     if(!response.ok)throw Error('PHOTO_SYNC_UNAVAILABLE');snapshot=await response.json();
    }finally{clearTimeout(timer);}
   }
   var photos=(snapshot.messages||[]).filter(function(m){return m.type==='photo'&&m.imageURL;});
   for(var i=photos.length-1;i>=0;i--){
    var m=photos[i];
    if(m.audioURL)await root.CareLinkFrame.receive({id:m._id,type:'photo',imageURL:m.imageURL,audioRef:m.audioURL,caption:m.text||'',createdAt:m.createdAt,initial:!photo});
    else if(!photo){photo={id:m._id,imageURL:m.imageURL};await save({id:'current-photo',kind:'current',photo:photo});}
   }
   if(transport&&transport.pending){var items=await bounded(function(){return transport.pending();});for(var j=0;j<items.length;j++)await root.CareLinkFrame.receive(items[j]);}
   online=true;render();flush();
  }catch(_){online=false;render();}finally{syncing=false;}
 }
 root.CareLinkFrame={press:press,event:event,receive:function(input){pendingOps=pendingOps.then(function(){return receive(input);},function(){return receive(input);});return pendingOps;},snapshot:function(){return {mode:state.mode,photo:photo&&photo.id,unheard:pending().length,queued:rows.filter(function(r){return r.kind==='voice'&&r.status==='queued';}).length,ready:!!queue};},flush:flush};
 root.UnseenR15Native={handleKey:function(action){if(action==='ai')return press(config.device==='single'?'main':config.speakKey);if(action==='back'&&config.device==='dual')return press(config.listenKey);return false;},handleBack:function(){playEpoch++;media.stop();if(state.mode==='recording'){state.mode='processing';recordStop();}else reset();return true;}};
 $('main').onclick=function(){press('main');};$('listen').onclick=function(){press(config.listenKey);};$('speak').onclick=function(){press(config.speakKey);};
 root.addEventListener('keydown',function(e){var k=e.key==='F8'?(config.device==='single'?'main':config.speakKey):e.key==='F9'&&config.device==='dual'?config.listenKey:null;if(k&&!e.repeat){e.preventDefault();event({type:'down',key:k,at:Date.now()});}});
 root.addEventListener('keyup',function(e){var k=e.key==='F8'?(config.device==='single'?'main':config.speakKey):e.key==='F9'&&config.device==='dual'?config.listenKey:null;if(k){e.preventDefault();event({type:'up',key:k,at:Date.now(),hasUnheard:pending().length>0});}});
 root.addEventListener('online',function(){online=true;render();flush();});root.addEventListener('offline',function(){online=false;render();});
 root.addEventListener('storage',function(e){if(e.key==='memory-session-frame'||e.key==='unseen-carelink-device'||e.key===null){closing=true;job++;playEpoch++;media.stop();if(capture)capture.cancel();location.reload();}});
 document.addEventListener('visibilitychange',function(){if(document.hidden&&state.mode==='recording'){state.mode='processing';recordStop();}});
 root.addEventListener('unseen-background',function(){if(state.mode==='recording'){state.mode='processing';recordStop();}media.stop();});
 render();
 if(!scope){status('请让家人先连接相框');return;}
 CareLinkQueue.open(scope).then(async function(q){queue=q;rows=await queue.list();var current=rows.find(function(r){return r.kind==='current';});photo=current?current.photo:null;if(photo)delete photo.localURL;render();flush();synchronize();}).catch(function(){status('暂时不能保存留言，请让家人检查相框空间');});
 setInterval(function(){if(closing)return;event({type:'tick',at:Date.now()});if(unsaved&&queue){var row=unsaved;queue.put(row).then(function(){if(unsaved===row){rows.push(row);unsaved=null;status('这段话已保存在相框');render();flush();}}).catch(function(){});}render();},250);
 setInterval(flush,10000);setInterval(synchronize,15000);
})(window);
