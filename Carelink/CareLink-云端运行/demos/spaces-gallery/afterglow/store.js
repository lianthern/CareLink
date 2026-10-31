import {blankState} from './data.js';
export const DATABASE=new URLSearchParams(location.search).get('qa')==='acceptance'?'unseen-afterglow-local-20260910-v1':'unseen-afterglow-personal-20260910-v1';
let db, queue=Promise.resolve();
export async function openStore(){
 db=await new Promise((resolve,reject)=>{const request=indexedDB.open(DATABASE,1);request.onupgradeneeded=()=>{request.result.createObjectStore('state');request.result.createObjectStore('assets');};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
 return await loadState();
}
export async function loadState(){return new Promise((resolve,reject)=>{const r=db.transaction('state').objectStore('state').get('current');r.onsuccess=()=>resolve(r.result||blankState());r.onerror=()=>reject(r.error);});}
export async function getAsset(id){return new Promise((resolve,reject)=>{const r=db.transaction('assets').objectStore('assets').get(id);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
export function saveState(state,assets=[]){
 const snapshot=structuredClone(state); snapshot.photos.forEach(p=>{if(p.assetId)delete p.url;});snapshot.memories.forEach(m=>{m.turns?.forEach(t=>{if(t.assetId)delete t.url;});if(m.pendingAudio)delete m.pendingAudio.url;});
 const next=queue.catch(()=>{}).then(()=>new Promise((resolve,reject)=>{
  const tx=db.transaction(['state','assets'],'readwrite'); tx.objectStore('state').put(snapshot,'current'); for(const a of assets)tx.objectStore('assets').put(a.blob,a.id);
  tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('保存被中断'));
 }));queue=next;return next;
}
export async function decodeImage(file){
 if(!file.type.startsWith('image/'))throw Error('这不是图片，请选择 JPG、PNG 或 WebP。');
 if(file.size>35*1024*1024)throw Error('单张图片请小于 35 MB。');
 const url=URL.createObjectURL(file);try{const im=new Image();im.src=url;await im.decode();if(!im.naturalWidth)throw Error();return {url,width:im.naturalWidth,height:im.naturalHeight};}catch{URL.revokeObjectURL(url);throw Error('这张照片无法打开，请重试或改选 JPG、PNG、WebP。');}
}
