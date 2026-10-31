import test from 'node:test';
import assert from 'node:assert/strict';
import { frozenBookDestination, bookMountCallbacks } from '../public/unseen-app-account.js';

test('book entry uses only matching canonical available versions and guarded legacy source',()=>{
 const response={ok:true,body:{status:'frozen',completedVersions:[{status:'available',versionId:'version-2',readerPath:'/s/space/books/book/versions/version-2'}]}};
 assert.equal(frozenBookDestination(response,'space','book'),'/s/space/books/book/versions/version-2');
 response.body.completedVersions[0].readerPath='https://external.example/book';
 assert.equal(frozenBookDestination(response,'space','book'),null);
 response.unseenHeaders={'x-unseen-book-owner-preconditions':JSON.stringify({startNewVersion:{fromVersionId:'historical'}})};
 assert.equal(frozenBookDestination(response,'space','book'),'/s/space/books/book/versions/historical');
 assert.equal(frozenBookDestination({...response,ok:false},'space','book'),null);
 response.unseenHeaders['x-unseen-book-owner-preconditions']='bad json';
 assert.equal(frozenBookDestination(response,'space','book'),null);
});

test('cancelled book mount cannot publish late PDF or navigate and retains original signal',async()=>{
 const controller=new AbortController();let release,downloads=0,navigations=0,receivedSignal;
 const callbacks=bookMountCallbacks({signal:controller.signal,isCurrent:()=>true,fetchImpl:(_url,options)=>{receivedSignal=options.signal;return new Promise(resolve=>release=resolve);},onPdf:()=>downloads++,navigate:()=>navigations++});
 const late=callbacks.fetchImpl('/authorized.pdf').then(callbacks.onPdf);
 assert.equal(receivedSignal,controller.signal);
 controller.abort();release({ok:true,body:new Uint8Array([1])});await late;
 callbacks.navigate('/next');assert.equal(downloads,0);assert.equal(navigations,0);
 assert.throws(()=>callbacks.fetchImpl('/next.pdf'),{name:'AbortError'});
});

test('superseded generation suppresses results but active mount publishes normally',()=>{
 let active=true,downloads=0,navigations=0;
 const callbacks=bookMountCallbacks({signal:new AbortController().signal,isCurrent:()=>active,onPdf:()=>downloads++,navigate:()=>navigations++});
 callbacks.onPdf({});callbacks.navigate('/current');assert.equal(downloads,1);assert.equal(navigations,1);
 active=false;callbacks.onPdf({});callbacks.navigate('/stale');assert.equal(downloads,1);assert.equal(navigations,1);
});
