'use strict';
const initial=()=>({mode:'idle',startedAt:null,held:null});
// Edges only: ignore key repeat/held press until matching release. Timestamp in ms.
function transition(state,event,config={device:'single',listenKey:'green',speakKey:'red'}){
 const s=Object.assign({},state),effects=[];if(!Number.isFinite(event.at))throw Error('INVALID_KEY_TIME');
 if(event.type==='tick'){if(s.mode==='recording'&&event.at-s.startedAt>=30000){s.mode='processing';s.startedAt=null;s.held=null;effects.push('stop_recording','transcribe');}return {state:s,effects};}
 if(event.type==='settingsClosed'){s.mode='idle';s.held=null;return {state:s,effects};}
 if(event.type==='processed'){if(s.mode==='processing')s.mode='idle';return {state:s,effects};}
 if(event.type==='playbackEnded'){if(s.mode==='playing')s.mode='idle';return {state:s,effects};}
 if(!['single','dual'].includes(config.device))throw Error('INVALID_KEY_CONFIG');
 const validKeys=config.device==='single'?['main']:[config.listenKey,config.speakKey];
 if(config.device==='dual'&&(!config.listenKey||!config.speakKey||config.listenKey===config.speakKey))throw Error('INVALID_KEY_CONFIG');
 if(!validKeys.includes(event.key))return {state:s,effects};
 if(event.type==='down'){if(!s.held)s.held={key:event.key,at:event.at};return {state:s,effects};}
 if(event.type!=='up'||!s.held||s.held.key!==event.key)return {state:s,effects};
 const duration=event.at-s.held.at;s.held=null;if(duration<0)throw Error('INVALID_KEY_TIME');
 if(config.device==='single'&&duration>=800){if(s.mode==='recording')effects.push('cancel_recording');if(s.mode==='playing')effects.push('stop_playback');s.mode='settings';s.startedAt=null;effects.push('open_settings');return {state:s,effects};}
 if(['processing','settings'].includes(s.mode))return {state:s,effects};
 const speak=()=>{if(s.mode==='recording'){s.mode='processing';s.startedAt=null;effects.push('stop_recording','transcribe');}else{if(s.mode==='playing')effects.push('stop_playback');s.mode='recording';s.startedAt=event.at;effects.push('start_recording');}};
 if(config.device==='single'){
  if(s.mode==='idle'&&event.hasUnheard){s.mode='playing';effects.push('play_pending');}else speak();
 }else if(event.key===config.speakKey)speak();else if(s.mode!=='recording'&&event.hasUnheard){s.mode='playing';effects.push('play_pending');}
 return {state:s,effects};
}
module.exports={initial,transition};
