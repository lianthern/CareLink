import {escapeHtml as esc} from './app-v2-core.js';
import {createMomentVoice} from './moment-voice.js';

const enc=encodeURIComponent;
const toDataUrl=blob=>new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.readAsDataURL(blob);});
const date=value=>value?new Date(value).toLocaleString('zh-CN'):'';
export function storyMediaUrl(value,invitation=false){
 if(typeof value!=='string'||!/^\/v1\/(viewer\/spaces|spaces)\/[A-Za-z0-9_-]+\//.test(value)||value.includes('..'))return '';
 const u=new URL(value,'https://local.invalid');u.searchParams.set('access',invitation?'invitation':'account');return u.pathname+u.search;
}
export function spaceStoriesHtml(stories,invitation=false){return stories.map(s=>`<article class="photo-story-saved" data-note-story="${esc(s.storyId)}"><small>${esc(s.authorCredit)} · ${esc(date(s.createdAt))}${s.visibility==='hidden'?' · 暂未展示':''}</small>${s.pieces.map(p=>`${p.text?`<blockquote>${esc(p.text)}</blockquote>`:''}${p.audio&&storyMediaUrl(p.audio.url,invitation)?`<small>原声${p.audio.duration?` · ${Math.ceil(p.audio.duration)} 秒`:""}</small><audio controls preload="none" src="${esc(storyMediaUrl(p.audio.url,invitation))}"></audio>`:''}`).join('')}${s.canWithdraw?`<button type="button" data-note-withdraw="${esc(s.storyId)}" data-version="${s.version}">撤回我这句话</button>`:''}</article>`).join('');}

// Separate local drafts, scoped to the account/invitation AND the target photo.
export function createStoryDrafts(indexedDB=globalThis.indexedDB){
 let db;const open=()=>db||=new Promise((resolve,reject)=>{const q=indexedDB.open('unseen-space-photo-stories',1);q.onupgradeneeded=()=>q.result.createObjectStore('drafts');q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
 return async(key,value)=>{const connection=await open();return new Promise((resolve,reject)=>{const tx=connection.transaction('drafts',value===undefined?'readonly':'readwrite'),s=tx.objectStore('drafts'),q=value===undefined?s.get(key):value===null?s.delete(key):s.put(value,key);tx.oncomplete=()=>resolve(q.result);tx.onerror=()=>reject(tx.error);});};
}
export function singlePhotoQuestion(text){
 const value=String(text||'').trim(),end=value.search(/[?？]/u);
 return end<0?'看着这张照片，你最想留下哪一句话？':value.slice(0,end+1).slice(0,240);
}

export function mountSpacePhotoStory(root,{request,api,user=()=>null,spaceId,photoId,invitation=false,identityKey,signal,autoAsk=false,showPhoto=false,onSaved=()=>{},drafts=createStoryDrafts(),voiceFactory=createMomentVoice}){
 const abort=new AbortController(),owner=user()?.id,key=`${identityKey||owner||'guest'}:${spaceId}:${photoId}`;
 const base=`/v1/spaces/${enc(spaceId)}/photos/${enc(photoId)}/notes`,creditKey=`credit:${identityKey||owner||'guest'}:${spaceId}`;
 let destroyed=false,context,draft={text:'',credit:user()?.displayName||user()?.name||'',question:'',questionId:crypto.randomUUID(),momentId:crypto.randomUUID()},pending,clipUrl='',voice,busy=false,asking=false,transcribing=false,phase='idle',writeQueue=Promise.resolve();
 const current=()=>!destroyed&&!signal?.aborted&&user()?.id===owner&&root.isConnected;
 const check=()=>{if(!current())throw new DOMException('Page changed','AbortError');};
 const req=async(path,options={})=>{check();const result=await request(path,{...options,signal:AbortSignal.any([abort.signal,...(signal?[signal]:[])])});check();return result;};
 const ai=async(path,body)=>{check();const result=await api.request(path,{method:'POST',accountId:owner&&owner!=='guest-local'?owner:'guest-local',key:body.requestId,body,signal:AbortSignal.any([abort.signal,AbortSignal.timeout(120000),...(signal?[signal]:[])])});check();return result;};
 const tell=text=>{if(current()){const el=root.querySelector('[data-note-status]');if(el)el.textContent=text;}};
 const persist=()=>{const value=structuredClone({...draft,pending});writeQueue=writeQueue.catch(()=>{}).then(async()=>{await drafts(key,value);if(value.credit.trim())await drafts(creditKey,value.credit);});return writeQueue.catch(()=>tell('这台设备暂时存不下草稿，请保持页面打开后重试。'));};
 function controls(){if(!current())return;root.querySelectorAll('[data-note-input]').forEach(n=>n.disabled=busy||!!pending);const save=root.querySelector('[data-note-save]');if(save){save.disabled=busy||phase!=='idle'||transcribing||(!pending&&!draft.text.trim()&&!draft.audio);save.textContent=pending?'重试保存这句话':'留在这张照片上';}const record=root.querySelector('[data-note-record]');if(record){record.disabled=busy||!!pending||transcribing||phase==='processing';record.textContent=phase==='recording'?'松开结束 · 正在录音':phase==='requesting'?'正在打开麦克风…':phase==='processing'?'正在收好原声…':'按住说话';}const stop=root.querySelector('[data-note-stop]');if(stop)stop.hidden=!['recording','requesting'].includes(phase);}
 function editor(){
  root.querySelector('[data-note-editor]').hidden=false;
  root.querySelector('[data-note-text]').value=draft.text;root.querySelector('[data-note-credit]').value=draft.credit;
  const question=root.querySelector('[data-note-question]');question.textContent=draft.question;question.hidden=!draft.question;
  root.querySelector('[data-note-ask]').disabled=asking||!!draft.question;
  const preview=root.querySelector('[data-note-preview]');
  if(draft.audio){if(clipUrl)URL.revokeObjectURL(clipUrl);clipUrl=URL.createObjectURL(draft.audio.blob);preview.innerHTML=`<audio controls src="${esc(clipUrl)}"></audio><button type="button" data-note-clear>重新录一段</button>`;}else preview.innerHTML='';
  controls();
 }
 async function ask(){
  if(asking||draft.question)return;asking=true;editor();root.querySelector('[data-note-ask]').disabled=true;tell('正在看这张照片，只问你一句…');
  try{
   const url=storyMediaUrl(context.photoMedia?.url,invitation);if(!url)throw new Error('photo_unavailable');
   const response=await fetch(url,{credentials:'same-origin',cache:'no-store',signal:abort.signal});check();if(!response.ok)throw new Error('photo_unavailable');
   const blob=await response.blob();check();if(blob.size>6*1048576)throw new Error('photo_too_large');
   const dataUrl=await toDataUrl(blob);check();
   const result=await ai('/api/moment-chat',{requestId:draft.questionId,momentId:draft.momentId,photo:{id:photoId,dataUrl},messages:[]});
   draft.question=singlePhotoQuestion(result.message?.text);const question=root.querySelector('[data-note-question]');question.textContent=draft.question;question.hidden=false;await persist();tell('想说多少都可以。');
  }catch(error){if(current()&&error.name!=='AbortError')tell('AI 暂时没连上，你可以直接留话，或稍后重试提问。');}
  finally{asking=false;if(current())root.querySelector('[data-note-ask]').disabled=!!draft.question;}
 }
 async function recorded(clip){
  if(!current())return;draft.audio={blob:clip.blob,duration:clip.duration};if(clip.transcript&&!draft.text)draft.text=clip.transcript;await persist();if(!current())return;editor();
  if(clip.reason==='interrupted'){tell('录音被打断，已保留为草稿。试听后再保存。');return;}
  if(clip.transcript){tell('原声已留在草稿，可以试听并修改文字。');return;}
  transcribing=true;controls();tell('原声已保留，正在转成文字…');const before=draft.text;
  try{const dataUrl=await toDataUrl(clip.blob);check();const result=await ai('/api/moment-transcribe',{requestId:crypto.randomUUID(),audio:{dataUrl,durationMs:clip.duration*1000},language:'zh'});if(draft.text===before){draft.text=result.text||'';root.querySelector('[data-note-text]').value=draft.text;await persist();}tell('可以试听原声、核对文字，然后留在照片上。');}
  catch(error){if(current()&&error.name!=='AbortError')tell('文字暂时没识别出来，原声仍可试听和保存，也可以手动补字。');}
  finally{transcribing=false;controls();}
 }
 async function save(){
  if(busy||phase!=='idle'||transcribing)return;
  if(!draft.credit.trim()){tell('先写一个同行者认识的名字。');root.querySelector('[data-note-credit]').focus();return;}
  if(!draft.text.trim()&&!draft.audio&&!pending)return;
  busy=true;controls();tell('正在把原话和声音留在这张照片上…');
  try{
   if(!pending){const audio=draft.audio?{mimeType:draft.audio.blob.type,dataBase64:(await toDataUrl(draft.audio.blob)).split(',')[1],duration:draft.audio.duration}:undefined;check();pending={key:crypto.randomUUID(),body:{text:draft.text,authorCredit:draft.credit,consent:true,...(audio?{audio}:{})}};await persist();check();}
   const saved=await req(base,{method:'POST',...pending});
   const body=pending.body;const story={...saved,canWithdraw:true,authorCredit:body.authorCredit,pieces:[{text:body.text,...(body.audio?{audio:{duration:body.audio.duration,url:`${base}/${saved.storyId}/audio/original`}}:{})}]};
   if(![...root.querySelectorAll('[data-note-story]')].some(el=>el.dataset.noteStory===saved.storyId))root.querySelector('[data-note-stories]').insertAdjacentHTML('beforeend',spaceStoriesHtml([story],invitation));root.querySelector('[data-note-empty]')?.remove();
   pending=undefined;draft.text='';draft.audio=undefined;await persist();check();editor();tell('已经留下。同行者打开这张照片，就能读到原话、听到声音。');onSaved(saved);
  }catch(error){if(current()&&error.name!=='AbortError')tell(['upload_unavailable','story_target_unavailable'].includes(error.code)?'空间的收集或照片权限已变化，草稿仍保留。请确认邀请后重试。':'还没确认保存成功，草稿仍保留。点击重试会核对同一次保存。');}
  finally{busy=false;controls();}
 }
 const click=e=>{const b=e.target.closest('button');if(!b||!root.contains(b))return;
  if(b.matches('[data-note-ask]')){editor();void ask();}
  if(b.matches('[data-note-save]'))void save();
  if(b.matches('[data-note-withdraw]')){b.disabled=true;const path=invitation?`${base}/${enc(b.dataset.noteWithdraw)}/withdrawals`:`/v1/photo-stories/${enc(b.dataset.noteWithdraw)}/withdrawals`;void req(path,{method:'POST',body:{},version:Number(b.dataset.version)}).then(()=>{b.closest('article').remove();tell('这句话和原声已从空间撤回。');}).catch(()=>{if(current()){b.disabled=false;tell('暂时没能撤回，请重新打开后重试。');}});}
  if(b.matches('[data-note-stop]'))void voice.finish();
  if(b.matches('[data-note-clear]')&&!busy&&!pending){draft.audio=undefined;void persist();editor();}
  // Keyboard / accessibility activation toggles recording; pointer input uses hold.
  if(b.matches('[data-note-record]')&&e.detail===0){if(phase==='idle')void voice.start();else void voice.finish();}
 };
 const input=e=>{if(e.target.matches('[data-note-text]'))draft.text=e.target.value;if(e.target.matches('[data-note-credit]'))draft.credit=e.target.value;void persist();controls();};
 let holding=false;
 const down=e=>{const b=e.target.closest('[data-note-record]');if(!b||b.disabled||e.button!==0)return;e.preventDefault();holding=true;b.setPointerCapture(e.pointerId);void voice.start().then(()=>{if(!holding&&current())void voice.finish();});};
 const up=e=>{if(!holding)return;holding=false;if(e.type==='pointercancel')voice.cancel();else void voice.finish();};
 const ready=(async()=>{
  root.innerHTML='<p role="status">正在读取照片里的故事…</p>';
  const [access,shared,local,credit]=await Promise.allSettled([req(base),req(`/v1/viewer/spaces/${enc(spaceId)}/stories`),drafts(key),drafts(creditKey)]);check();
  const storyMap=new Map((shared.status==='fulfilled'?shared.value.stories.filter(s=>s.photoId===photoId):[]).map(s=>[s.storyId,s]));
  if(access.status==='fulfilled')for(const s of access.value.stories)storyMap.set(s.storyId,s);
  const stories=[...storyMap.values()];
  context=access.status==='fulfilled'?access.value:null;
  if(local.status==='fulfilled'&&local.value){draft={...draft,...local.value};pending=draft.pending;delete draft.pending;}
  if(!draft.credit)draft.credit=context?.authorCredit||(credit.status==='fulfilled'&&typeof credit.value==='string'?credit.value:'');
  root.innerHTML=`<section class="photo-story">
   ${showPhoto&&context?`<img class="v2-story-photo" src="${esc(storyMediaUrl(context.photoMedia.url,invitation))}" alt="正在留话的照片">`:''}
   ${context?.upload?.uploadedAt?`<small class="photo-story-hint">${esc(context.upload.authorCredit)} 上传于 ${esc(date(context.upload.uploadedAt))}</small>`:''}
   ${context?`<div data-note-editor>
    <p class="photo-story-question" data-note-question hidden></p>
    <label>给这张照片留一句<textarea data-note-text data-note-input rows="3" maxlength="4000" placeholder="那一刻，我记得…"></textarea></label>
    <div class="photo-story-actions"><button type="button" class="btn ghost" data-note-record>按住说话</button><button type="button" class="btn ghost" data-note-stop hidden>结束录音</button><button type="button" class="photo-story-ask" data-note-ask>没想好？让 AI 问一句</button></div>
    <div data-note-preview></div>
    <label>署名<input data-note-credit data-note-input maxlength="80" autocomplete="nickname" placeholder="让同行者知道是谁留下的"></label>
    <p class="photo-story-hint">保存后，空间里的同行者能看到这句话、听到原声，并看到你的署名与时间。</p>
    <button type="button" class="btn gold" data-note-save>留在这张照片上</button>
   </div>`:'<p class="photo-story-hint">这个入口目前只能查看。获得上传权限、开启收集后，就能一起留话。</p>'}
   <p role="status" aria-live="polite" data-note-status></p>
   <div data-note-stories>${spaceStoriesHtml(stories,invitation)}</div>
   ${stories.length||context?'':'<div data-note-empty><h3>这张照片，还等着一个故事</h3></div>'}
  </section>`;
  root.addEventListener('click',click);
  if(!context)return;
  voice=voiceFactory({maxDurationMs:60000,Recognition:null,onState:s=>{phase=s.phase;controls();},onComplete:clip=>void recorded(clip),onError:e=>tell(e.message)});
  root.addEventListener('input',input);root.addEventListener('pointerdown',down);root.addEventListener('pointerup',up);root.addEventListener('pointercancel',up);
  editor();if(autoAsk)void ask();
 })().catch(e=>{if(current()&&e.name!=='AbortError')root.innerHTML='<p>照片故事暂时没有读到，请关闭后重试。</p>';});
 const destroy=()=>{if(destroyed)return;destroyed=true;abort.abort();voice?.destroy();if(clipUrl)URL.revokeObjectURL(clipUrl);root.querySelectorAll('audio').forEach(a=>{a.pause();a.removeAttribute('src');a.load();});for(const [name,fn]of [['click',click],['input',input],['pointerdown',down],['pointerup',up],['pointercancel',up]])root.removeEventListener(name,fn);signal?.removeEventListener('abort',destroy);};
 signal?.addEventListener('abort',destroy,{once:true});
 return {ready,destroy};
}

export function openSpacePhotoStory(options){
 const origin=document.activeElement,dialog=document.createElement('dialog');dialog.className='v2-story';dialog.innerHTML='<header><h2>照片与故事</h2><button type="button" class="ib" aria-label="关闭">×</button></header><div data-note-dialog></div>';document.body.append(dialog);dialog.showModal();
 const surface=mountSpacePhotoStory(dialog.querySelector('[data-note-dialog]'),options);
 const close=()=>{surface.destroy();dialog.close();dialog.remove();origin?.isConnected&&origin.focus();options.signal?.removeEventListener('abort',close);};
 dialog.querySelector('header button').onclick=close;dialog.addEventListener('cancel',e=>{e.preventDefault();close();});options.signal?.addEventListener('abort',close,{once:true});return {destroy:close,ready:surface.ready};
}
