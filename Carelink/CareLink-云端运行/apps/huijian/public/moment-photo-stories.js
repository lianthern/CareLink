const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const encode=encodeURIComponent;
export const photoStoryError=e=>({story_selection_invalid:'请明确选择至少一句原文或一段原声，每次最多 20 条。',story_source_changed:'这段私人记录刚刚更新。请关闭后重开，重新核对要分享的内容。',story_source_unavailable:'原来的照片或故事现在无法读取。',story_target_unavailable:'这张原件还没有加入所选空间，或它的权限已经变化。',story_too_large:'所选内容过长，请减少本次选择，分次分享。',story_credit_invalid:'请填写不超过 80 字的展示署名。',memory_storage_limit:'账号保存空间不足，暂时不能复制这段故事。',upload_unavailable:'空间已暂停收集，或你已经没有上传权限。',story_unavailable:'这段分享现在无法操作，可能已经撤回。',version_conflict:'这段分享刚刚更新，请重新打开后核对。',account_changed:'账号已切换，请回到原账号继续。'}[e?.code]||'暂时没有完成，请检查连接后重试。');
const action=(name,label,extra='',primary=false)=>`<button type="button" class="${primary?'primary':'secondary'}" data-story-action="${name}" ${extra}>${label}</button>`;
export function selectedStoryPieces(candidates,choices){
 const selected=[];for(const candidate of candidates){const choice=choices.find(c=>c.messageId===candidate.messageId);if(!choice)continue;
  const includeText=choice.includeText===true&&typeof candidate.text==='string'&&candidate.text.trim().length>0,includeAudio=choice.includeAudio===true&&!!candidate.audio;
  if(includeText||includeAudio)selected.push({messageId:candidate.messageId,includeText,includeAudio});}
 if(!selected.length||selected.length>20)throw {code:'story_selection_invalid'};return selected;
}
function safeAudio(url){return typeof url==='string'&&/^\/v1\/moment-media\/[A-Za-z0-9_-]+$/.test(url)?url:'';}
function previewHtml(candidates,selections){return selections.map(s=>{const candidate=candidates.find(c=>c.messageId===s.messageId);return `<article class="ms-story-piece">${s.includeText?`<blockquote>${esc(candidate.text)}</blockquote>`:''}${s.includeAudio?`<audio controls preload="none" src="${esc(safeAudio(candidate.audio.url))}"></audio>`:''}</article>`;}).join('');}
export function mountPhotoStoryPicker(root,{api,user=()=>null,source,spaceLinks=[],onClose=()=>{},onComplete=()=>{},navigate=()=>{}}){
 const owner=user()?.id,controller=new AbortController();let destroyed=false,busy=false,saved,pending,publishKey,existing=[];
 const current=()=>!destroyed&&!controller.signal.aborted&&user()?.id===owner;
 const check=()=>{if(!current())throw new DOMException('账号或页面已变化','AbortError');};
 async function request(path,options={}){check();const result=await api.request(path,{...options,accountId:owner,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(60000)])});check();return result;}
 const show=html=>{if(current())root.innerHTML=`<section class="ms-surface ms-picker ms-story-picker">${html}<p role="status" aria-live="polite" data-story-status></p></section>`;};
 const tell=text=>{if(current()){const status=root.querySelector('[data-story-status]');if(status)status.textContent=text;}};
 function existingHtml(){return existing.filter(s=>s.visibility!=='withdrawn').length?`<section class="ms-panel"><h3>这张照片已经分享的故事</h3><p>撤回会停止空间里的原文与原声访问，不会删除你的私人记录。</p>${existing.filter(s=>s.visibility!=='withdrawn').map(s=>`<article class="ms-story-piece"><p>${s.visibility==='hidden'?'主人暂时隐藏':'已分享'} · ${esc(new Date(s.createdAt).toLocaleString('zh-CN'))}</p>${s.pieces.map(p=>p.text?`<blockquote>${esc(p.text)}</blockquote>`:'<p>已选的原声</p>').join('')}${action('withdraw-review','撤回这段分享',`data-id="${esc(s.storyId)}"`)}</article>`).join('')}</section>`:'';}
 function selectionView(){
  show(`<h2>选择要一起留下的故事</h2><p>只分享你勾选的原文和原声。它们会独立复制到空间，后续修改私人记录不会改变这份分享；你可以随时撤回。</p>${saved.targets.length&&saved.candidates.length?`<form data-story-form="review"><label class="ms-field">分享给哪个空间<select name="target">${saved.targets.map((t,i)=>`<option value="${i}">${esc(t.name)}</option>`).join('')}</select></label><label class="ms-field">空间里显示的署名<input name="credit" maxlength="80" value="${esc(user()?.displayName||user()?.name||'讲述者')}" required></label><div class="ms-story-choices">${saved.candidates.map((c,i)=>`<article class="ms-panel">${c.text.trim()?`<label class="ms-consent"><input type="checkbox" name="text-${i}">分享这句原文</label><blockquote>${esc(c.text)}</blockquote>`:''}${c.audio?`<label class="ms-consent"><input type="checkbox" name="audio-${i}">分享这段原声</label><audio controls preload="none" src="${esc(safeAudio(c.audio.url))}"></audio>`:''}</article>`).join('')}</div><button class="primary">核对选中的内容</button></form>`:!saved.targets.length?'<p>请先把这张照片原件加入空间，并确认空间正在收集。这里只查验照片已经加入的空间，不会代你上传或认领草稿。</p>':'<p>这张照片还没有可分享的本人原文或原声。可以先回到照片，聊聊当时的故事。</p>'}${existingHtml()}${action('close','暂不分享')}`);
 }
 async function prepare(form){const index=Number(form.elements.target.value),target=saved.targets[index];if(!target)throw {code:'story_target_unavailable'};
  const selections=selectedStoryPieces(saved.candidates,saved.candidates.map((c,i)=>({messageId:c.messageId,includeText:form.elements['text-'+i]?.checked===true,includeAudio:form.elements['audio-'+i]?.checked===true})));
  const authorCredit=form.elements.credit.value.trim();if(!authorCredit||authorCredit.length>80)throw {code:'story_credit_invalid'};
  pending={target,body:{source:saved.source,selections,authorCredit,consent:true}};publishKey=crypto.randomUUID();
  show(`<h2>确认分享给 ${esc(target.name)}</h2><p>署名：${esc(authorCredit)}。下面是本次将复制的全部内容；空间内获准查看的人能够阅读或播放，空间主人可以隐藏，你可以撤回。</p>${previewHtml(saved.candidates,selections)}<p>私人记录里的其他内容不会加入。</p>${action('publish','确认分享所选内容','',true)}${action('back','重新选择')}${action('close','取消')}`);
 }
 async function publish(){const result=await request(`/v1/spaces/${encode(pending.target.spaceId)}/photos/${encode(pending.target.photoId)}/stories`,{method:'POST',key:publishKey,body:pending.body});
  show(`<h2>这段故事已经留下</h2><p>所选原文与原声已经保存到 ${esc(pending.target.name)}。只有空间里获准查看且可见的照片才会带出故事；如照片仍在审核，故事会一起等待。</p>${action('open','打开空间故事','',true)}${action('manage','查看并管理我的分享')}${action('close','关闭')}`);await onComplete({...result,source:saved.source});
 }
 async function refreshMine(){const result=await request('/v1/me/photo-stories');existing=result.stories.filter(s=>s.source?.momentId===source.momentId&&s.source?.photoId===source.photoId);}
 async function act(button){const name=button.dataset.storyAction;if(name==='close')return onClose();if(name==='back')return selectionView();if(name==='publish')return publish();if(name==='open')return navigate(`shared-space/${encode(pending.target.spaceId)}?tab=stories`);
  if(name==='manage'){await refreshMine();return selectionView();}
  if(name==='withdraw-review'){const s=existing.find(s=>s.storyId===button.dataset.id);if(!s)return;show(`<h2>撤回这段分享</h2><p>空间里的原文和原声将无法继续打开。你的私人记录会保留。</p>${action('withdraw','确认撤回',`data-id="${esc(s.storyId)}"`,true)}${action('back','保留分享')}`);return;}
  if(name==='withdraw'){const s=existing.find(s=>s.storyId===button.dataset.id);await request(`/v1/photo-stories/${encode(s.storyId)}/withdrawals`,{method:'POST',body:{},version:s.version});await refreshMine();selectionView();tell('分享已经撤回。');}
 }
 async function run(fn,button){if(busy||!current()||button?.disabled)return;busy=true;if(button)button.disabled=true;try{await fn();}catch(error){if(current()&&error.name!=='AbortError')tell(photoStoryError(error));}finally{busy=false;if(button?.isConnected)button.disabled=false;}}
 const click=e=>{const button=e.target.closest('[data-story-action]');if(!button||!root.contains(button))return;e.preventDefault();if(button.dataset.storyAction==='close'){onClose();return;}run(()=>act(button),button);};
 const submit=e=>{if(e.target.matches('[data-story-form="review"]')){e.preventDefault();run(()=>prepare(e.target),e.submitter);}};
 root.addEventListener('click',click);root.addEventListener('submit',submit);
 const ready=(async()=>{if(!owner||owner==='guest-local'){show(`<h2>先把这张照片保存到账号</h2><p>请回到照片详情，使用“保存到账号”，再决定分享哪句话、哪段原声。这里不会自动认领本机草稿。</p>${action('close','返回照片')}`);return;}
  show('<p role="status">正在核对这张照片的本人故事…</p>');saved=await request(`/v1/me/photo-story-sources?momentId=${encode(source.momentId)}&photoId=${encode(source.photoId)}`);await refreshMine();selectionView();
 })().catch(error=>{if(current()&&error.name!=='AbortError')show(`<h2>暂时无法打开选择器</h2><p>${esc(photoStoryError(error))}</p>${action('close','关闭')}`);});
 return {ready,destroy(){destroyed=true;controller.abort();root.querySelectorAll?.('audio').forEach(audio=>{audio.pause();audio.removeAttribute('src');audio.load();});root.removeEventListener('click',click);root.removeEventListener('submit',submit);saved=null;existing=[];pending=null;}};
}
