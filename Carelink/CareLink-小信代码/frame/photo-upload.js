(function(root) {
  'use strict';
  // The caller retains the IndexedDB original until the message ACK, including both-path failure.
  function deadline(job, ms) {
    var timer;
    return Promise.race([Promise.resolve().then(job), new Promise(function(_, reject) {
      timer = setTimeout(function() { reject(Error('PHOTO_UPLOAD_TIMEOUT')); }, ms);
    })]).then(function(v) { clearTimeout(timer); return v; }, function(e) { clearTimeout(timer); throw e; });
  }
  async function upload(options) {
    var media, fallbackReason = '', started = Date.now();
    function receipt(value) { if(!value || typeof value.id !== 'string' || !value.id) throw Error('PHOTO_ACK_REQUIRED'); return value; }
    if (options.direct) {
      try { media = receipt(await deadline(function() { return options.direct(options.file, options.id); }, options.timeoutMs || 15000)); }
      catch (e) { fallbackReason = 'DIRECT_UNAVAILABLE'; }
    }
    if (!media) media = receipt(await deadline(function() { return options.hongKong(options.file, options.id); }, options.timeoutMs || 60000));
    if (options.timing) options.timing({bytes: options.file.size, totalMs: Date.now()-started, path: media && !fallbackReason && options.direct ? 'direct' : 'hong-kong', fallback: !!fallbackReason});
    return media;
  }
  function createDirect(adapter) {
    if (!adapter || !adapter.prepare || !adapter.put || !adapter.complete) throw Error('PHOTO_ADAPTER_REQUIRED');
    return async function(file,id) {
      // prepare owns authenticated room scoping and short-lived private-object authorization.
      var grant=await adapter.prepare({id:id,mime:file.type,bytes:file.size},file);
      if(!grant || !grant.key || !Number.isFinite(grant.expiresAt) || grant.expiresAt<=Date.now()) throw Error('PHOTO_GRANT_INVALID');
      await adapter.put(grant,file);
      var result=await adapter.complete({id:id,key:grant.key},file);
      if(!result || !result.id)throw Error('PHOTO_COMMIT_FAILED');
      return result;
    };
  }
  var api = {upload: upload,createDirect:createDirect};
  if (typeof module !== 'undefined') module.exports = api;
  else root.CareLinkPhotoUpload = api;
})(typeof window === 'undefined' ? this : window);
