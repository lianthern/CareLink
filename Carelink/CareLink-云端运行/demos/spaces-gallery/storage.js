export const initialState=()=>({version:1,photos:[],spaces:[],favorites:[],preferences:{effects:true,name:'体验者'},draft:null});
let dbPromise;
export function openStore(){return dbPromise??=new Promise((resolve,reject)=>{const r=indexedDB.open('unseen-ui-preview-20260910',1);r.onupgradeneeded=()=>r.result.createObjectStore('state');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
export async function readState(){const db=await openStore();return new Promise((resolve,reject)=>{const r=db.transaction('state').objectStore('state').get('current');r.onsuccess=()=>resolve(r.result?.version===1?r.result:initialState());r.onerror=()=>reject(r.error);});}
export async function writeState(value){const db=await openStore();return new Promise((resolve,reject)=>{const t=db.transaction('state','readwrite');t.objectStore('state').put(value,'current');t.oncomplete=resolve;t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error);});}
export const toDataUrl=blob=>new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.readAsDataURL(blob);});
export async function importImage(file){
 if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw new Error('请选择 JPG、PNG 或 WebP 照片。');
 if(file.size>30*1024*1024)throw new Error('这张照片超过 30MB，请选择较小的照片。');
 const bitmap=await createImageBitmap(file);const scale=Math.min(1,1800/Math.max(bitmap.width,bitmap.height));
 const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
 return {id:crypto.randomUUID(),url:canvas.toDataURL('image/jpeg',.88),title:file.name.replace(/\.[^.]+$/,''),story:'',example:false,local:true,createdAt:new Date().toISOString()};
}
