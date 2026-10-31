(function(root){
 'use strict';
 if(!root.CareLinkConfig||!root.CareLinkConfig.enabled)return;
 var originalKey=root.UnseenR15Native&&root.UnseenR15Native.handleKey;
 function child(){var f=document.getElementById('frame');return f&&f.contentWindow;}
 function active(){var w=child();return w&&w.CareLinkFrame;}
 if(root.UnseenR15Native)root.UnseenR15Native.handleKey=function(action){
  var frame=active();
  if(frame&&(action==='ai'||(action==='back'&&CareLinkConfig.device==='dual'))){
   if(typeof route!=='undefined'&&route!=='home'){if(typeof go==='function')go('home');return true;}
   return child().UnseenR15Native.handleKey(action);
  }
  if(action==='ai')return false; // Native delivery can retry once the new frame has mounted.
  return originalKey?originalKey(action):false;
 };
 var originalBack=root.UnseenR15Native&&root.UnseenR15Native.handleBack;
 if(root.UnseenR15Native)root.UnseenR15Native.handleBack=function(){if(active()&&CareLinkConfig.device==='dual'&&typeof route!=='undefined'&&route==='home')return child().CareLinkFrame.press(CareLinkConfig.listenKey);return originalBack?originalBack():false;};
 if(root.UnseenAssistant){root.UnseenAssistant.open=function(){return root.UnseenR15Native.handleKey('ai');};root.UnseenAssistant.pressKey=root.UnseenAssistant.open;}
 if(root.UnseenDeviceUI&&root.UnseenDeviceUI.open){
  var settings=root.UnseenDeviceUI.open,opening=false;
  root.UnseenDeviceUI.open=function(){
   if(opening||!active())return settings.apply(this,arguments);
   if(CareLinkConfig.device==='single'){
    opening=true;try{var now=Date.now();active().event({type:'down',key:'main',at:now});active().event({type:'up',key:'main',at:now+800});}finally{opening=false;}return;
   }
   if(child().UnseenR15Native)child().UnseenR15Native.handleBack();return settings.apply(this,arguments);
  };
 }
 // Existing family calling and settings stay owned by the OS. Only the AI entry is replaced.
 root.addEventListener('keydown',function(e){if(e.key==='F8'&&active()){e.preventDefault();e.stopImmediatePropagation();if(!e.repeat)root.UnseenR15Native.handleKey('ai');}},true);
 root.addEventListener('message',function(e){if(e.origin!==location.origin||e.source!==child())return;if(e.data&&e.data.type==='assistant-open'&&active()){e.stopImmediatePropagation();root.UnseenR15Native.handleKey('ai');}},true);
 root.addEventListener('unseen-background',function(){var w=child();if(active())w.dispatchEvent(new Event('unseen-background'));});
})(window);
