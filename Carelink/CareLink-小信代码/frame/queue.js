(function(root) {
 'use strict';
 function open(scope) {
  if (!scope || !/^[\w-]{1,120}$/.test(scope)) return Promise.reject(Error('SCOPE_REQUIRED'));
  return new Promise(function(resolve,reject) {
   var req=indexedDB.open('carelink-frame-'+scope,1);
   req.onupgradeneeded=function(){req.result.createObjectStore('records',{keyPath:'id'});};
   req.onerror=function(){reject(Error('LOCAL_STORAGE_UNAVAILABLE'));};
   req.onsuccess=function(){var db=req.result; resolve({
    put:function(row){return transact('readwrite',function(store){store.put(row);});},
    list:function(){return transact('readonly',function(store){return store.getAll();});},
    close:function(){db.close();}
   });
   function transact(mode,fn){return new Promise(function(ok,fail){var tx=db.transaction('records',mode),r=fn(tx.objectStore('records'));tx.oncomplete=function(){ok(r?r.result:undefined);};tx.onerror=function(){fail(Error('LOCAL_SAVE_FAILED'));};tx.onabort=tx.onerror;});}
   };
  });
 }
 root.CareLinkQueue={open:open};
})(window);
