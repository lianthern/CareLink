import test from 'node:test';
import assert from 'node:assert/strict';
import {createViewRequest} from '../public/moment-view-request.js';

test('a late response cannot supply an old account or a replaced view',async()=>{
  for(const change of ['account','navigation']){
    let resolve,account='a';const control=new AbortController();
    const view=createViewRequest({request:()=>new Promise(r=>{resolve=r;})},{signal:control.signal,isCurrent:()=>account==='a'});
    const result=view.request('/photos');
    if(change==='account')account='b';else control.abort();
    resolve({photos:['private-a']});
    await assert.rejects(result,{name:'AbortError'});
    await assert.rejects(view.request('/next'),{name:'AbortError'});
  }
});
test('errors from an old view become cancellation, while a current error is preserved',async()=>{
  let reject,current=true;const control=new AbortController();
  const view=createViewRequest({request:()=>new Promise((_,r)=>{reject=r;})},{signal:control.signal,isCurrent:()=>current});
  const result=view.request('/metadata');current=false;reject(new Error('late failure'));
  await assert.rejects(result,{name:'AbortError'});
  current=true;const fresh=view.request('/metadata');reject(Object.assign(new Error('offline'),{code:'offline'}));
  await assert.rejects(fresh,{code:'offline'});
});
