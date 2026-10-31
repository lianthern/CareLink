import { drafts } from './moment-spaces.js';
import { SharedUpload, sharedDigest, sharedPhotoFile } from './moment-shared-upload.js';
import { worldDraftId, worldInputLimits } from './moment-world.js';
import { retainSpatialRevision } from './moment-spatial-history.js';
import { blobToDataUrl } from './moment-data.js';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const enc=encodeURIComponent,base='/api/photo-scenes';
const stateLabel={uploading:'等待续传',queued:'排队处理中',working:'正在处理',waiting:'等待服务恢复',failed:'处理失败',done:'分析完成'};
const stageLabel={upload:'上传',preprocess:'生成小图',analysis:'识图',grouping:'核对场景',complete:'完成'};
const errorCopy=e=>({analysis_not_configured:'识图服务尚未配置，原件已保存。',analysis_quota:'当前识图额度已用完，队列会稍后继续。',image_processing_failed:'暂时无法解码这张照片，原件已保留。可改用 JPG / PNG 再试。',provider_unavailable:'识图服务暂时不可用，已保留进度。',provider_reply_invalid:'识图结果无法使用，可以重试。',group_version_conflict:'分组已变化，请刷新后再操作。',photo_policy:'支持 JPG、PNG、WebP、HEIC，每张最多 40 MB。',storage_full:'服务器可用空间不足，已上传内容保留。',library_limit:'这个账号已达到当前照片库容量上限。',session_unavailable:'请登录后继续。',account_changed:'账号已切换，请回到原账号。',selection_invalid:'请选同一组内 2–8 张已完成分析的照片。',upload_recovery_storage_unavailable:'本机无法保存上传恢复信息，请检查浏览器存储。',upload_pending_batch:'这个空间有未完成的上传，请先继续原批次。',photo_ratio_mismatch:'所选照片横竖比例不同，请改选比例一致的视角。',service_limit:'所选照片超出当前生成服务限制。'}[e?.code||e]||'暂时未完成，已保存的内容仍保留。请刷新或重试。');
const styles=`<style>.scene-library{max-width:820px;margin:auto;padding:12px 6px 30px;overflow-wrap:anywhere}.scene-library h1{font-size:26px}.scene-edit{margin:18px 0;padding:12px;border:1px solid #d8cddd;border-radius:15px}.scene-edit summary{cursor:pointer;font-size:14px}.scene-card>p{font-size:13px}.scene-library>.scene-toolbar .btn{width:auto;flex:1}.scene-library h2{font-size:20px}.scene-library p,.scene-library small{line-height:1.7}.scene-toolbar{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0}.scene-toolbar>*{max-width:100%}.scene-toolbar input,.scene-toolbar select{min-width:0;flex:1;padding:12px;border:1px solid #d8cddd;border-radius:12px;font:inherit;background:#fff9}.scene-card{padding:18px;margin:14px 0;border:1px solid #d8cddd;border-radius:22px;background:#ffffffa8}.scene-card h2{margin:0 0 9px}.scene-reps{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px}.scene-reps img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:10px}.scene-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.scene-photo{position:relative;border:1px solid #ded4e0;border-radius:13px;overflow:hidden;background:#fff9;min-width:0}.scene-photo img,.scene-placeholder{display:block;width:100%;aspect-ratio:1;object-fit:cover;background:#ece6f0}.scene-photo label{display:block;font-size:12px;padding:8px;line-height:1.5}.scene-photo input{width:19px;height:19px;vertical-align:middle;margin-right:5px}.scene-photo small{display:block;font-size:10px;padding:0 8px 8px}.scene-photo button,.scene-photo a{font-size:11px;margin:4px 8px}.scene-progress{padding:14px;border-radius:15px;background:#eee9f5}.scene-progress progress{width:100%;accent-color:#a185b2}.scene-warning{color:#76581e;background:#fff8e9;padding:12px;border-radius:13px}.scene-live{min-height:24px;font-size:13px;color:#725a7c}.scene-library button{min-height:42px}.scene-library .scene-back{font-size:13px}.scene-rights{display:flex;align-items:flex-start;gap:9px;font-size:13px;margin:14px 0}.scene-rights input{margin-top:5px}.scene-selected{outline:2px solid #c5a465;outline-offset:-2px}@media(min-width:650px){.scene-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}</style>`;
export function createMomentSpaces({api,user,guest,login,navigate}){
 let root,owner,controller,timer,alive=false,busy=false,summary,group,photos=[],next=null,route,selection=null,selected=new Set(),marked=new Set(),status='',groupAfter='',groupNext=null,rights=false,picking=false,uploadFiles=[],uploadIndex=0,paused=false,progress={done:0,total:0},previewUrls=new Map();
 const check=()=>{if(!alive||controller.signal.aborted||user()?.id!==owner)throw new DOMException('Account changed','AbortError');};
 const request=async(path,options={})=>{check();const r=await api.request(path,{...options,accountId:owner,signal:controller.signal});check();return r;};
 const media=(p,kind='thumb')=>`${base}/photos/${enc(p.id)}/${kind}?account=${enc(owner)}`;
 const tell=s=>{status=s;const el=root?.querySelector('[data-scene-live]');if(el)el.textContent=s;};
 const raw=async(path,options={})=>{check();const r=await fetch(path,{...options,credentials:'same-origin',cache:'no-store',headers:{'X-Unseen-Expected-Account-Id':owner,...options.headers},signal:controller.signal});check();if(!r.ok){const d=await r.json().catch(()=>({}));throw {code:d.error};}return r;};
 const button=(action,label,attrs='')=>`<button class="btn ghost sm" type="button" data-scene-action="${action}" ${attrs}>${label}</button>`;
 const image=p=>p.metadata?`<img src="${esc(media(p))}" alt="${esc(p.name)}" loading="lazy" decoding="async">`:'<span class="scene-placeholder"></span>';
 const tile=(p,world=false)=>`<article class="scene-photo ${(world?selected:marked).has(p.id)?'scene-selected':''}">${image(p)}<label><input type="checkbox" data-scene-${world?'world':'mark'}="${esc(p.id)}" ${(world?selected:marked).has(p.id)?'checked':''}>${esc(p.name)}</label><small>${esc(p.descriptor?.label||stateLabel[p.state])} · ${esc(stageLabel[p.stage]||'')}<br>${p.descriptor?`AI：${p.descriptor.structure>=.7?'结构充分':p.descriptor.structure>=.35?'结构有限':'结构很少'} · ${p.descriptor.quality>=.7?'清晰':p.descriptor.quality>=.35?'一般':'模糊'}`:''}${p.metadata?.capturedAt?'<br>拍摄日期 '+esc(p.metadata.capturedAt.slice(0,10)):'<br>拍摄时间未提供'}</small>${p.state!=='uploading'?`<a href="${esc(media(p,'original'))}" target="_blank" rel="noopener">原件</a>`:''}${['failed','waiting'].includes(p.state)?`<small>${esc(errorCopy(p.error))}</small>${button('retry','重试',`data-id="${esc(p.id)}"`)}`:''}</article>`;
 function draw(){check();
  if(guest()){root.innerHTML=styles+`<section class="scene-library"><h1>按场景整理照片</h1><p>登录后从手机相册多选上传，换设备也能继续查看处理结果。</p>${button('login','登录并继续')}</section>`;bind();return;}
  const counts=summary?.status||{};
  root.innerHTML=styles+`<section class="scene-library"><button class="text-button scene-back" data-spatial-route="library/photos">‹ 回忆库</button><h1>${esc(group?.name||'按场景整理照片')}</h1><p>${group?'这是逻辑相册，原照片、原话与原声保留。候选分组需要你核对真实地点。':'从手机或电脑多选照片，后台先找出可能属于同一处房间或地点的照片。'}</p><div class="scene-live" data-scene-live role="status" aria-live="polite">${esc(status)}</div>
  ${!group?`<section class="scene-card"><h2>把照片先收好</h2><p>单张最多 40 MB，按文件分片续传。页面关闭后，已上传的分析继续；未传完的请再次选择同一批照片恢复。</p><label class="scene-rights"><input type="checkbox" data-scene-rights ${rights?'checked':''}>我有权使用这些照片，同意由已配置的识图服务分析画面以整理场景。</label><input type="file" hidden multiple accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" data-scene-files><div class="scene-toolbar">${button('pick','＋ 从相册多选上传')}${uploadFiles.length?button(paused?'resume':'pause',paused?'继续上传':'暂停上传'):''}</div><div class="scene-progress"><progress max="${progress.total||1}" value="${progress.done}"></progress><small>${progress.total?`这批 ${progress.done} / ${progress.total} 张已保存。`:''}原件按账号私密保存；浏览只加载小图。20 GB 吞吐尚未实测。</small></div></section><p>${Object.entries(counts).map(([k,v])=>esc(stateLabel[k]||k)+' '+v).join(' · ')||'还没有导入照片'}</p><div class="scene-toolbar">${button('refresh','刷新进度')}${button('unassigned','待确认 / 未分组')}${button('all','全部导入照片')}${groupAfter?button('first-groups','第一组'):''}</div>${(summary?.groups||[]).map(g=>`<article class="scene-card"><h2>${esc(g.name)} <small>${g.confirmed?'已确认':'候选'}</small></h2><div class="scene-reps">${g.representatives.map(p=>`<img src="${esc(media(p))}" alt="场景代表照片" loading="lazy">`).join('')}</div><p>${g.count} 张 · ${esc(g.reason)}</p>${button('open','查看与确认',`data-id="${esc(g.id)}"`)}</article>`).join('')}${groupNext?button('next-groups','下一页场景'):''}${photos.length?`<h2>${route==='unassigned'?'待确认照片':'导入照片'}</h2>${route==='unassigned'?`<div class="scene-toolbar"><select data-add-target aria-label="放入哪个场景"><option value="">选择现有场景</option>${(summary?.groups||[]).map(g=>`<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select>${button('add-to','把勾选照片加入')}</div><p>只有人物特写、结构不足或证据不够时，会留在这里。</p>`:''}`:''}`:
  `<p>${esc(group.reason)}</p><div class="scene-toolbar">${button('back','全部场景')}${button('confirm',group.confirmed?'已确认 ✓':'确认是同一地点')}</div><details class="scene-edit"><summary>整理分组 · 改名、合并与拆分</summary><div class="scene-toolbar"><input data-scene-name value="${esc(group.name)}" maxlength="80" aria-label="场景名称">${button('rename','改名')}</div><div class="scene-toolbar">${button('split','勾选照片拆为新组')}${button('remove','移出勾选照片')}${button('reanalyze','重新分析勾选照片')}</div><div class="scene-toolbar"><select data-merge-target aria-label="合并哪个场景"><option value="">选择要合并的场景</option>${(summary?.groups||[]).filter(g=>g.id!==group.id).map(g=>`<option value="${g.id}" data-version="${g.version}">${esc(g.name)}（${g.count}）</option>`).join('')}</select>${button('merge','合并并重新确认')}${groupNext?button('next-groups','更多场景'):''}${groupAfter?button('first-groups','最前的场景'):''}</div></details>${group.confirmed?`<section class="scene-card"><h2>为这处空间选择呈现</h2><p>回廊保存整组照片；超过回廊上传限制时使用展示副本，原件留在本相册。生成先挑互补视角，下一页由你确认档位和提交。</p><div class="scene-toolbar">${button('gallery','保存整组到照片回廊')}${button('selection','挑选建空间照片')}${group.spaceId?`<button class="btn ghost sm" data-spatial-route="shared-space/${enc(group.spaceId)}?view=scene">打开空间</button>`:''}</div></section>`:'<p class="scene-warning">先确认是否同一物理地点，再选择回廊或生成。相似的客厅可能属于不同房间。</p>'}`}
  ${selection?`<section class="scene-card"><h2>生成选图 · 已选 ${selected.size} 张</h2><p>优先清晰结构、互补视角与共同可见区域。全组原件继续保留。${selection.considered>=200?'已优先取不同画面特征的 200 张作为候选；可在下方替换。':''}</p>${selection.warnings.map(w=>`<p class="scene-warning">${esc(w)}</p>`).join('')}<div class="scene-grid">${selection.photos.map(p=>tile(p,true)).join('')}</div><div class="scene-toolbar">${button('use-marked','用下方勾选照片替换')}${button('handoff','继续到生成确认',selected.size<2||selected.size>8?'disabled':'')}${button('close-selection','收起选图')}</div></section>`:''}
  <div class="scene-grid">${photos.map(p=>tile(p)).join('')}</div>${next?`<div class="scene-toolbar">${button('next','下一页照片')}${button('first','第一张起')}</div>`:''}</section>`;
  bind();if(busy)root.querySelectorAll('[data-scene-action]:not([data-scene-action="pause"])').forEach(b=>b.disabled=true);
 }
 function bind(){root.onclick=e=>{const b=e.target.closest('[data-scene-action]');if(!b)return;e.stopPropagation();if(b.dataset.sceneAction==='pause'){paused=true;tell('会在当前分片保存后暂停。');return;}if(b.dataset.sceneAction==='pick'){if(busy)return;if(!root.querySelector('[data-scene-rights]')?.checked){tell('请先勾选照片使用与识图授权。');return;}picking=true;root.querySelector('[data-scene-files]').click();return;}void run(()=>act(b.dataset.sceneAction,b));};
  root.querySelector('[data-scene-files]')?.addEventListener('cancel',()=>{picking=false;});root.onchange=e=>{if(e.target.matches('[data-scene-rights]'))rights=e.target.checked;if(e.target.matches('[data-scene-files]')){uploadFiles=[...e.target.files];uploadIndex=0;progress={done:0,total:uploadFiles.length};paused=false;picking=false;draw();void run(upload);}const field=e.target.dataset.sceneWorld||e.target.dataset.sceneMark;if(field){const set=e.target.dataset.sceneWorld?selected:marked;e.target.checked?set.add(field):set.delete(field);e.target.closest('.scene-photo').classList.toggle('scene-selected',e.target.checked);if(e.target.dataset.sceneWorld)draw();}};
 }
 async function run(fn){if(busy)return;busy=true;root.setAttribute('aria-busy','true');try{await fn();}catch(e){if(e.name!=='AbortError')tell(errorCopy(e));}finally{busy=false;root?.setAttribute('aria-busy','false');if(alive&&!controller.signal.aborted&&user()?.id===owner)draw();}}
 async function refresh({after='',keep=false}={}){
  summary=await request(base+'?after='+enc(groupAfter));groupNext=summary.next;
  if(group){const d=await request(base+'/groups/'+group.id+'?after='+enc(after));group=d.group;photos=d.photos;next=d.next;}
  else if(route){const d=await request(base+'/photos?'+(route==='unassigned'?'group=unassigned&':'')+'after='+enc(after));photos=d.photos;next=d.next;}
  if(!keep)marked.clear();
 }
 async function upload(){
  while(uploadIndex<uploadFiles.length&&!paused){
   const file=uploadFiles[uploadIndex];tell(`正在保存 ${uploadIndex+1} / ${uploadFiles.length}：${file.name}`);
   const mime=file.type||({heic:'image/heic',heif:'image/heif',jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp'}[file.name.split('.').at(-1).toLowerCase()]);
   if(file.size>40*1048576){tell(file.name+' 超过 40 MB，已暂停；请另选照片。');paused=true;break;}
   const sha=await sharedDigest(file);check();let {photo:p}=await request(base+'/photos',{method:'POST',body:{sha,bytes:file.size,name:file.name,mime}});
   while(p.state==='uploading'&&p.offset<file.size&&!paused){
    const part=file.slice(p.offset,Math.min(p.offset+1048576,file.size));
    try{const result=await raw(base+'/photos/'+p.id+'/chunk?offset='+p.offset,{method:'PUT',body:part,headers:{'Content-Type':'application/octet-stream'}});p.offset=(await result.json()).offset;}
    catch(e){const latest=await request(base+'/photos/'+p.id);p=latest.photo;if(e.code!=='upload_offset_conflict'){paused=true;throw e;}}
    tell(`正在上传 ${file.name} · ${Math.round(p.offset/file.size*100)}%（${uploadIndex+1}/${uploadFiles.length}）`);
   }
   if(paused)break;
   if(p.state==='uploading')await request(base+'/photos/'+p.id+'/commit',{method:'POST',body:{}});
   uploadIndex++;progress.done=uploadIndex;
  }
  tell(paused?'上传已暂停。成功项保留，点击继续上传。':'原件已保存，服务端继续分析；可以离开后回来查看。');await refresh();
 }
 async function edit(body){const r=await request(base+'/groups/'+group.id,{method:'POST',body:{version:group.version,...body}});group=r.group;await refresh();selection=null;selected.clear();return r;}
 async function ensureSpace(){
  if(group.spaceId)return group.spaceId;
  const notice=await request('/v1/notices/current?purpose=space_create');
  const created=await request('/v1/spaces',{method:'POST',key:'photo-scene-space-'+group.id,body:{name:group.name},notice});
  const m=await request('/v1/spaces/'+enc(created.spaceId)+'/management');
  if(m.space.collectionState!=='open')await request('/v1/spaces/'+enc(created.spaceId)+'/collection-transitions',{method:'POST',body:{to:'open'},version:m.space.version??m.version});
  const result=await request(base+'/groups/'+group.id,{method:'POST',body:{action:'space',version:group.version,spaceId:created.spaceId}});group=result.group;return group.spaceId;
 }
 async function allMembers(){const out=[];let after='';do{const r=await request(base+'/photos?group='+group.id+'&limit=100&after='+enc(after));out.push(...r.photos);after=r.next;}while(after);return out;}
 async function gallery(){
  const sid=await ensureSpace(),all=await allMembers();
  const requestBound=(p,o)=>request(p,o),u=new SharedUpload({request:requestBound,spaceId:sid,identityKey:owner,signal:controller.signal,isCurrent:()=>alive&&user()?.id===owner,storage:localStorage,onChange:()=>{}});
  const remember=async receipt=>{await request(base+'/groups/'+group.id+'/links',{method:'POST',body:{links:receipt.contributions.map(c=>({photoId:c.refKey,canonicalPhotoId:c.photoId}))}});u.clearCompleted();};
  if(u.state?.completed)await remember(u.state.completed);
  const linked=new Set((await request(base+'/groups/'+group.id+'/links')).links.map(l=>l.photoId));
  const context=await u.context();
  const fileFor=async p=>{const original=p.bytes<=context.limits.photoBytes&&(context.photoFormats||context.formats||[]).includes(p.mime);const response=await raw(media(p,original?'original':'preview'));return sharedPhotoFile(await response.blob(),original?p.name:p.name+'.jpg');};
  if(u.state){if(u.state.files.some(f=>!all.some(p=>p.id===f.refKey)))throw {code:'upload_pending_batch'};for(let i=0;i<u.state.files.length;i++)await u.resume(i,await fileFor(all.find(p=>p.id===u.state.files[i].refKey)));if(!u.complete())throw {code:'upload_pending_batch'};const receipt=await u.finalize();for(const c of receipt.contributions)linked.add(c.refKey);await remember(receipt);}
  const pending=all.filter(p=>!linked.has(p.id)&&p.state!=='uploading'&&p.metadata);
  // Small bounded batches; no original library decoding, no all-library blobs in memory.
  for(let i=0;i<pending.length;i+=Math.min(4,context.limits.batchItems)){
   const batch=pending.slice(i,i+Math.min(4,context.limits.batchItems));tell(`正在保存回廊照片 ${Math.min(i+batch.length,pending.length)} / ${pending.length}…`);
   const files=[];for(const p of batch)files.push(await fileFor(p));
   await u.start(files,await u.context(),{refKeys:batch.map(p=>p.id)});if(!u.complete())throw {code:'upload_pending_batch'};await remember(await u.finalize());
  }
  tell('已完成照片已加入回廊。未完成处理的原件仍在本相册，可处理后再次补入。');
 }
 async function loadSelection(){selection=await request(base+'/groups/'+group.id+'/selection');selected=new Set(selection.selectedIds);selection.photos=[];for(const id of selection.selectedIds)selection.photos.push((await request(base+'/photos/'+id)).photo);}
 async function handoff(){
  const config=await request('/api/world/config'),limits=worldInputLimits(config);if(!limits||selected.size<limits.minImages||selected.size>limits.maxImages)throw {code:'service_limit'};
  const sid=await ensureSpace(),chosen=[];let size=0;
  for(const id of selected){const p=(await request(base+'/photos/'+id)).photo;const response=await raw(media(p,'preview')),blob=await response.blob();size+=blob.size;if(blob.size>limits.imageBytes||size>limits.totalBytes)throw {code:'service_limit'};chosen.push({src:await blobToDataUrl(blob),name:p.name,width:p.metadata.width,height:p.metadata.height,sourcePhotoId:p.id,sourceSha256:p.sha});}
  if(chosen.some(p=>Math.abs(p.width/p.height-chosen[0].width/chosen[0].height)>.025))throw {code:'photo_ratio_mismatch'};
  const receipt=await request(base+'/groups/'+group.id+'/handoff',{method:'POST',body:{version:group.version,photoIds:[...selected]}});
  const prior=(await drafts('getAll')).find(d=>d.id===worldDraftId(owner)&&d.accountId===owner);check();if(prior?.photos?.length)await retainSpatialRevision(drafts,prior,'按场景选图前的素材');
  await drafts('put',{id:worldDraftId(owner),accountId:owner,title:group.name,prompt:'',photos:chosen,worldMode:'multi',worldModel:prior?.worldModel||config.recommendedModel,spaceId:sid,sceneSource:{handoffId:receipt.id,groupId:group.id,groupVersion:receipt.groupVersion,photos:chosen.map(p=>({id:p.sourcePhotoId,sha:p.sourceSha256}))}});check();navigate('world-create?spaceId='+enc(sid));
 }
 async function act(a,b){
  if(a==='login'){await login('spatial');return;}if(a==='resume'){paused=false;await upload();return;}
  if(a==='refresh'){await refresh();return;}if(a==='open'){group=(await request(base+'/groups/'+b.dataset.id)).group;photos=[];selection=null;await refresh();return;}
  if(a==='back'){group=null;selection=null;photos=[];route='';await refresh();return;}
  if(a==='unassigned'||a==='all'){route=a;group=null;selection=null;await refresh();return;}
  if(a==='next-groups'){groupAfter=groupNext;await refresh();return;}if(a==='first-groups'){groupAfter='';await refresh();return;}
  if(a==='next'){await refresh({after:next});return;}if(a==='first'){await refresh();return;}
  if(a==='retry'){await request(base+'/photos/'+b.dataset.id+'/retry',{method:'POST',body:{}});await refresh();return;}
  if(a==='rename'){await edit({action:'rename',name:root.querySelector('[data-scene-name]').value});return;}
  if(a==='confirm'){await edit({action:'confirm'});tell('已确认场景。之后仍可拆分或移出。');return;}
  if(a==='split'||a==='remove'){await edit({action:a,photoIds:[...marked]});return;}
  if(a==='merge'){const select=root.querySelector('[data-merge-target]');await edit({action:'merge',targetId:select.value,targetVersion:Number(select.selectedOptions[0].dataset.version)});return;}
  if(a==='add-to'){const id=root.querySelector('[data-add-target]').value;if(!id||!marked.size)return;const g=(await request(base+'/groups/'+id)).group;await request(base+'/groups/'+id,{method:'POST',body:{action:'add',version:g.version,addIds:[...marked]}});await refresh();return;}
  if(a==='reanalyze'){for(const id of marked)await request(base+'/photos/'+id+'/retry',{method:'POST',body:{}});await refresh();tell('已重新排队。人工分组保留；相同分析版本复用已有结果。');return;}
  if(a==='gallery'){await gallery();return;}if(a==='selection'){await loadSelection();return;}if(a==='close-selection'){selection=null;return;}
  if(a==='use-marked'){selected=new Set(marked);selection.photos=[];for(const id of selected)selection.photos.push((await request(base+'/photos/'+id)).photo);selection.warnings=['这是你的手动选图，请核对是否跨地点、重复视角，以及门窗是否有重叠。'];return;}
  if(a==='handoff')await handoff();
 }
 async function poll(){if(!alive)return;if(!busy&&!group&&!picking){try{await refresh({keep:true});draw();}catch(e){if(e.name!=='AbortError')tell(errorCopy(e));}}if(alive)timer=setTimeout(poll,6000);}
 return {async mount(target){this.destroy();root=target;owner=user()?.id;controller=new AbortController();alive=true;busy=false;summary=null;group=null;photos=[];selection=null;selected.clear();marked.clear();route='';status='';draw();if(!guest()){await refresh();draw();timer=setTimeout(poll,6000);}},destroy(){alive=false;paused=true;clearTimeout(timer);controller?.abort();if(root){root.onclick=null;root.onchange=null;}for(const url of previewUrls.values())URL.revokeObjectURL(url);previewUrls.clear();}};
}
