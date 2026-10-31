(function(root) {
  'use strict';
  // Frame 698 competition product default; explicit device-local false keeps the legacy frame.
  var config = {enabled:true, brand:'小信 CareLink', device:'single', listenKey:'green', speakKey:'red'};
  try {
    var saved = JSON.parse(localStorage.getItem('unseen-carelink-device') || 'null');
    if(saved && saved.enabled === false)config.enabled=false;
    if (saved && saved.enabled === true) {
      config.enabled = true;
      if (saved.device === 'dual') config.device = 'dual';
      if (typeof saved.listenKey === 'string') config.listenKey = saved.listenKey;
      if (typeof saved.speakKey === 'string') config.speakKey = saved.speakKey;
      if (!config.listenKey || !config.speakKey || config.listenKey === config.speakKey) config.enabled = false;
    }
  } catch (_) {}
  root.CareLinkConfig = Object.freeze(config);
})(window);
