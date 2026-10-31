(function(root) {
 'use strict';
 // Safari only lets an element play on its own after a tap has played it once, so the iPad page reuses one.
 var unlocked=null,chimeContext=null;
 function unlock(){if(unlocked)return;unlocked=new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=');var p=unlocked.play();if(p&&p.catch)p.catch(function(){});try{chimeContext=new (root.AudioContext||root.webkitAudioContext)();chimeContext.resume();}catch(_){}}
 var playback=null, speech=null, finish=null,nativeSpeech=null,nativeHost=null;
 function stop(){if(nativeSpeech)nativeSpeech.stop();if(playback){playback.pause();playback=null;}if(speech&&root.speechSynthesis)root.speechSynthesis.cancel();speech=null;if(finish){var f=finish;finish=null;f(false);}}
 async function play(clip){
  stop();
  return new Promise(function(resolve){
   var timer=setTimeout(function(){stop();},90000);
   finish=function(ok){clearTimeout(timer);resolve(ok);};
   function done(ok){var f=finish;finish=null;playback=null;speech=null;if(f)f(ok);}
   if(clip.audioRef){if(unlocked){playback=unlocked;playback.src=clip.audioRef;}else playback=new Audio(clip.audioRef);playback.onended=function(){done(true);};playback.onerror=function(){done(false);};var p=playback.play();if(p&&p.catch)p.catch(function(){done(false);});}
   else if(nativeReady()){nativeSpeech.play(clip.text).then(function(accepted){if(!accepted)done(false);}).catch(function(){done(false);});}
   else if(root.speechSynthesis&&root.SpeechSynthesisUtterance){speech=new SpeechSynthesisUtterance(clip.text);speech.lang='zh-CN';speech.rate=.9;speech.onend=function(){done(true);};speech.onerror=function(){done(false);};root.speechSynthesis.speak(speech);}
   else done(false);
  });
 }
 function nativeReady(){
  try{
   var host=parent!==root?parent:root;
   if(!host.UnseenNative||!host.createAssistantSpeech)return false;
   var state=JSON.parse(host.UnseenNative.ttsStatus());if(!state.ready||!state.available)return false;
   if(!nativeSpeech){nativeHost=host;nativeSpeech=host.createAssistantSpeech({bridge:function(){return host.UnseenNative;},id:function(){return 'carelink-'+Date.now();},busy:async function(){return false;},state:function(s){if(finish&&s==='朗读已完成'){var f=finish;finish=null;f(true);}else if(finish&&s&&!['正在准备朗读…','正在朗读'].includes(s)){var end=finish;finish=null;end(false);}}});host.addEventListener('unseen-tts',function(e){nativeSpeech.event(e.detail);});}
   return true;
  }catch(_){return false;}
 }
 async function capture(options){
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia)throw Error('MICROPHONE_UNAVAILABLE');
  var raw=!!(options&&options.raw),stream=await navigator.mediaDevices.getUserMedia({audio:raw?{echoCancellation:false,noiseSuppression:false,autoGainControl:true}:true}),context,source,node,chunks=[];
  function release(){stream.getTracks().forEach(function(t){t.stop();});if(node)node.disconnect();if(source)source.disconnect();if(context)context.close();}
  try {
   // PCM/WAV works on WebView 66 without MediaRecorder/container support assumptions.
   context=new (root.AudioContext||root.webkitAudioContext)();await context.resume();source=context.createMediaStreamSource(stream);node=context.createScriptProcessor(4096,1,1);
   node.onaudioprocess=function(e){chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));};source.connect(node);node.connect(context.destination);
   var closed=false;
   return {cancel:function(){if(!closed){closed=true;release();}},stop:function(){
    if(closed)throw Error('RECORDING_CLOSED');closed=true;var rate=context.sampleRate;release();
    var rawLength=chunks.reduce(function(n,c){return n+c.length;},0),samples=new Float32Array(rawLength),offset=0;chunks.forEach(function(c){samples.set(c,offset);offset+=c.length;});var length=Math.floor(rawLength*16000/rate),resampled=new Float32Array(length);for(var z=0;z<length;z++)resampled[z]=samples[Math.min(rawLength-1,Math.floor(z*rate/16000))];chunks=[resampled];rate=16000;if(!length)throw Error('EMPTY_RECORDING');
    // The frame's microphone can arrive far too quiet for recognition: lift it, and keep the raw level for diagnosis.
    var peak=0;for(var q=0;q<length;q++)peak=Math.max(peak,Math.abs(resampled[q]));root.CareLinkMedia.lastPeak=Math.round(peak*32768);
    if(raw&&peak>0&&peak<.35){var lift=Math.min(30,.7/peak);for(var y=0;y<length;y++)resampled[y]*=lift;}
    var buffer=new ArrayBuffer(44+length*2),v=new DataView(buffer),pos=44;
    function text(at,s){for(var i=0;i<s.length;i++)v.setUint8(at+i,s.charCodeAt(i));}
    text(0,'RIFF');v.setUint32(4,36+length*2,true);text(8,'WAVE');text(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,rate,true);v.setUint32(28,rate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);text(36,'data');v.setUint32(40,length*2,true);
    chunks.forEach(function(c){for(var i=0;i<c.length;i++){var x=Math.max(-1,Math.min(1,c[i]));v.setInt16(pos,x<0?x*32768:x*32767,true);pos+=2;}});
    return new Blob([buffer],{type:'audio/wav'});
   }};
  }catch(e){release();throw e;}
 }
 function chime(){try{var c=chimeContext||new (root.AudioContext||root.webkitAudioContext)(),o=c.createOscillator(),g=c.createGain();o.frequency.value=660;g.gain.setValueAtTime(.025,c.currentTime);g.gain.exponentialRampToValueAtTime(.001,c.currentTime+.25);o.connect(g);g.connect(c.destination);o.start();o.stop(c.currentTime+.3);o.onended=function(){c.close();};return c.resume().catch(function(){});}catch(_) {}}
 root.CareLinkMedia={capture:capture,play:play,stop:stop,chime:chime,unlock:unlock};
})(window);
