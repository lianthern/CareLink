import { openSpacePhotoStory } from './space-photo-story.js';
import { escapeHtml as esc, photoRows } from './app-v2-core.js';
import { drafts } from './moment-spaces.js';
import { inspectCaptureFile } from './moment-capture-drafts.js';
import { SharedUpload, sharedPhotoFile } from './moment-shared-upload.js';
import { sharedError } from './moment-shared-spaces.js';
import { worldDraftId, worldInputLimits } from './moment-world.js';
import { retainSpatialRevision } from './moment-spatial-history.js';
import { mountAppSpatial } from './unseen-app-spatial.js';

const enc = encodeURIComponent;
const imageTypes = ['image/jpeg','image/png','image/webp','image/heic','image/heif'];
const videoTypes = ['video/mp4','video/quicktime','video/webm'];
const fileType = file => file.type || ({jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',heic:'image/heic',heif:'image/heif',mp4:'video/mp4',mov:'video/quicktime',webm:'video/webm'}[file.name?.split('.').at(-1).toLowerCase()] || '');
const dataUrl = file => new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(file);});
const button = (action,text,cls='btn ghost',attrs='') => `<button type="button" class="${cls}" data-material-action="${action}" ${attrs}>${text}</button>`;
const fail = code => {throw Object.assign(new Error(code),{code});};
export const materialDraftId = (owner,sid) => `space-materials:${enc(owner)}:${enc(sid)}`;

// Dimensions suggest a panorama; they cannot prove projection or shared location.
export function materialFacts(items) {
  const photos=items.filter(item=>item.selected!==false && imageTypes.includes(item.type));
  const videos=items.filter(item=>item.selected!==false && videoTypes.includes(item.type));
  const panoramas=photos.filter(item=>!item.forcePhoto&&['image/jpeg','image/png','image/webp'].includes(item.type)&&item.width===item.height*2&&item.width>=1600&&item.width<=8192&&item.bytes<=12*1048576);
  const world=photos.filter(item=>['image/jpeg','image/png','image/webp'].includes(item.type)&&item.width>0&&item.height>0&&!panoramas.includes(item));
  return {photos,videos,panoramas,world};
}
export function materialWorldEligible(items,config) {
  const limits=worldInputLimits(config);
  return Boolean(config?.enabled&&limits&&items.length>0&&items.length<=(items.length===1?1:limits.maxImages)&&(items.length===1||items.length>=limits.minImages)&&items.every(p=>p.bytes<=limits.imageBytes)&&items.reduce((n,p)=>n+p.bytes,0)<=limits.totalBytes);
}

export function materialUploadProgress(upload) {
  const files=upload.state?.files||[];
  if(!files.length)return '';
  const received=entry=>upload.result?.items?.some(item=>(item.itemId||item.id)===entry.itemId&&item.status==='committed')||(!entry.error&&entry.phase==='已接收');
  const done=files.filter(received).length,total=files.length;
  const failed=files.filter(entry=>entry.error&&!received(entry)).length;
  const title=upload.state.completed?'照片已保存':done===total?'正在确认保存':upload.busy?'正在上传照片':failed?'部分照片待重试':'准备上传照片';
  const detail=failed?`${failed} 张未完成，继续保存可重试` :done===total?(upload.state.completed?'可以继续布置回廊':'原图已接收，正在确认保存结果'):'原图逐张保存，请稍候';
  return `<div class="material-upload"><div class="material-upload-heading"><strong>${title}</strong><span>${done}<small> / ${total} 张</small></span></div><progress class="material-upload-bar" value="${done}" max="${total}" aria-label="照片接收进度">${done} / ${total}</progress><div class="material-upload-caption">${detail}</div></div>`;
}

export function createSpaceMaterials({api,user,navigate,materialLibrary,readMaterialPhoto}) {
  let noteDialog;
  let root,view,space,owner,active=false,runId=0,busy=false,status='',state,step=1,config,uploadContext,existing=[],upload,preview=()=>{},library=null,libraryKeys=new Set(),sceneConflict=false;
  const urls=new Map();
  const current=()=>active&&root?.isConnected&&user()?.id===owner&&!view.signal.aborted;
  const check=()=>{view.assertCurrent();if(!current())throw new DOMException('Page changed','AbortError');};
  const request=(path,options={})=>view.request(path,options);
  const persist=async()=>{check();try{await drafts('put',state);}catch(error){if(error.code==='account_changed')throw error;fail('material_storage');}check();};
  const url=item=>{if(item.url)return item.url;if(!item.blob)return '';if(!urls.has(item.id))urls.set(item.id,URL.createObjectURL(item.blob));return urls.get(item.id);};
  const facts=()=>materialFacts(state.items);
  let uploadProgress='';
  const showUpload=u=>{uploadProgress=materialUploadProgress(u);if(current()){const el=root.querySelector('[data-material-progress]');if(el)el.innerHTML=uploadProgress;const message=root.querySelector('[data-material-status]');if(message)message.textContent='';}status='';};
  const tell=text=>{uploadProgress='';if(current()){const el=root.querySelector('[data-material-progress]');if(el)el.innerHTML='';}status=text;if(current()){const el=root.querySelector('[data-material-status]');if(el)el.textContent=text;}};
  const thumb=item=>item.type?.startsWith('video/')?'<span class="material-video">▷<small>视频</small></span>':url(item)?`<img src="${esc(url(item))}" alt="" loading="lazy">`:'<span class="material-video">◫</span>';
  const summary=()=>{const f=facts();return [f.photos.length&&`${f.photos.length} 张照片`,f.videos.length&&`${f.videos.length} 段视频`].filter(Boolean).join('、')||'还没有选择素材';};
  function choices(items,field,selected) {return `<div class="material-options" role="group" aria-label="${field==='pano'?'选择全景底图':'选择用于 AI 补全的照片'}">${items.map(item=>`<label class="material-option">${thumb(item)}<input type="${field==='pano'?'radio':'checkbox'}" name="${field}" value="${esc(item.id)}" ${selected.includes(item.id)?'checked':''}><span>${esc(item.name)}</span></label>`).join('')}</div>`;}
  function sample(kind,items) {
    return `<div class="material-sample material-sample-${kind}" aria-hidden="true">${items.slice(0,3).map(item=>`<span>${thumb(item)}</span>`).join('')}${!items.length?'<span>◫</span>':''}<small>${kind==='world'?'呈现示意 · 生成后可探索':kind==='panorama'?'拖动环顾现场':'照片在走廊里展开'}</small></div>`;
  }
  function draw() {
    if(!current())return;preview();preview=()=>{};
    const f=facts(),pano=f.panoramas.find(p=>p.id===state.panoId),world=f.world.filter(p=>state.worldIds.includes(p.id));
    root.innerHTML=`<section class="material-flow" aria-busy="${busy}"><header class="v2-page-head nav">${button(step===2?'back':'space','‹','ib','aria-label="'+(step===2?'返回添加素材':'回到空间')+'"')}<h1>${step===1?'添加回忆素材':'选择呈现方式'}</h1></header><ol class="material-steps" aria-label="创建进度"><li ${step===1?'aria-current="step"':''}><span>1</span> 添加素材</li><li ${step===2?'aria-current="step"':''}><span>2</span> 选择呈现</li></ol><div class="material-intro"><small>${esc(space.name)}</small><h2>${step===1?'从手头的回忆开始':'这些素材，可以这样留下'}</h2><p>${step===1?'先放入照片或视频，再看看适合怎样呈现。':'同一个空间，之后还可以补素材、换一种看法。'}</p></div>
      ${state.storyPhotos?.length?`<section class="glass material-story-receipt"><h3>照片已经留下，也留一句你的话</h3><p>每张照片都可以补上原话或原声，也可以之后在回廊里慢慢说。</p><div class="material-story-list">${state.storyPhotos.map(item=>`<article>${thumb(item)}<span>${esc(item.name)}</span>${button('leave-note','留一句 · 文字或语音','btn ghost',`data-photo="${esc(item.uploadedPhotoId)}"`)}</article>`).join('')}</div>${button('corridor','走进照片回廊 →','btn gold')}</section>`:''}
      ${step===1?`<div class="glass material-drop"><div class="material-paper-stack" aria-hidden="true"><span>◫</span><span>＋</span></div><h3>你想留下哪些回忆？</h3><p>普通照片、全景照片或视频，都从这里添加</p>${button('pick','＋ 添加照片或视频','btn gold')}<input type="file" data-material-files hidden multiple accept="${[...imageTypes,...videoTypes,'.heic','.heif','.mov'].join(',')}">${materialLibrary?button('library','从我的照片库选择','material-text'):''}<small>选择后先保留在这台设备，确认呈现方式后再上传。</small></div>
      ${state.items.length?`<div class="material-section-heading"><h3>已选择 · ${summary()}</h3><span>取消勾选可暂不使用</span></div><div class="material-grid">${state.items.map(item=>`<label class="material-tile ${item.selected===false?'off':''}">${thumb(item)}<input type="checkbox" data-material-selected="${esc(item.id)}" aria-label="使用 ${esc(item.name)}" ${item.selected!==false?'checked':''}><span>${esc(item.name)}<small>${item.type.startsWith('video/')?'视频':item.width?`${item.width} × ${item.height}`:'尺寸暂未读到'}${f.panoramas.includes(item)?' · 全景候选':''}</small></span></label>`).join('')}</div>`:'<p class="material-hint">照片可以布置成回廊；有完整全景，还能环顾现场。</p>'}
      ${existing.length?`<p class="material-hint">空间里已有 ${existing.length} 张照片，继续添加会保留它们。</p>`:''}
      <div class="material-footer">${f.photos.length||f.videos.length?button('next','看看这些素材能做什么 →','btn gold'):''}${button('space',existing.length?'先看看已有的空间':'先进入空间，稍后添加','material-text')}</div>`:
      `<div class="glass material-summary"><div><strong>${summary()}</strong><p>${f.panoramas.length?`${f.panoramas.length} 张尺寸符合全景要求，请确认画面。`:'已读取素材格式与尺寸。'}${f.videos.length?'视频先保存采集草稿。':''}</p></div>${button('back','调整素材','material-text')}</div><div class="material-results">
      ${f.photos.length?`<article class="glass material-result ${state.presentation==='gallery'?'is-active':'is-collapsed'}">${sample('corridor',f.photos)}<div class="material-result-copy"><span class="material-badge">${f.panoramas.length?'随时可用':'推荐 · 直接看原照片'}</span><h3>照片回廊</h3>${button('choose-gallery','选择照片回廊','material-choose')}<p>把 ${f.photos.length} 张照片布置成可以逛的回忆展览，保留原来的画面。</p><small>使用全部已选照片${f.videos.length?'，视频另存采集草稿':''}。</small><label class="material-consent"><input type="checkbox" data-material-consent>我有权将这些照片加入空间，用于展示与位置建议。</label>${button('gallery',upload?.state&&!upload.state.completed?'继续保存并核对照片':`用这 ${f.photos.length} 张照片布置回廊`,'btn gold',!state.consent?'disabled':'')}</div></article>`:''}
      ${pano?`<article class="glass material-result ${state.presentation==='panorama'?'is-active':'is-collapsed'}">${sample('panorama',[pano])}<div class="material-result-copy"><span class="material-badge">推荐 · 使用真实全景</span><h3>环顾现场</h3>${button('choose-panorama','选择环顾现场','material-choose')}<p>用一张完整全景铺开现场，拖动环顾那一天。</p>${f.panoramas.length>1?choices(f.panoramas,'pano',[pano.id]):`<small>使用：${esc(pano.name)}</small>`}<label class="material-consent"><input type="checkbox" data-material-pano-confirm ${state.panoConfirmed?'checked':''}>这是一张完整的 360° 全景，我有权将它保存到此空间。</label><p class="material-note">其他照片仍保留在素材里，可以随后布置回廊。${state.hasScene?'确认后会更新已有现场，照片和邀请保留，照片位置需要重新核对。':''}</p><div class="material-result-actions">${button('preview-pano','先环顾看看','btn ghost')}${button('panorama','用这张全景搭建现场','btn gold',!state.panoConfirmed?'disabled':'')}</div>${config?.inputTypes?.includes('panorama')?`<p class="material-note">想在场景里移动？可用这张全景生成 AI 三维空间，再选择是否保存。</p>${button('world-pano','生成可探索的 3D 空间','btn ghost',!state.panoConfirmed||!materialWorldEligible([pano],config)?'disabled':'')}`:''}${button('ordinary-photo','这不是全景，按普通照片使用','material-text',`data-item="${esc(pano.id)}"`)}<div data-material-preview></div></div></article>`:''}
      ${f.world.length?`<article class="glass material-result ${state.presentation==='world'?'is-active':'is-collapsed'}">${sample('world',world)}<div class="material-result-copy"><span class="material-badge">${config?.enabled?'AI 创作':'当前暂不可用'}</span><h3>AI 补全空间</h3><a class="material-text" href="/space-guide.html" target="_blank" rel="noopener">先看看空间生成手册 ↗</a>${button('choose-world','选择 AI 补全','material-choose')}<p>${world.length===1?'从一张照片延展出可探索的空间。':'用同一地点的不同角度，尝试补成可探索的空间。'}未拍到的部分由 AI 补全，可能与现场不同。</p><details class="material-adjust"><summary>使用 ${world.length} 张照片 · 调整</summary>${choices(f.world,'world',state.worldIds)}</details><label class="material-consent"><input type="checkbox" data-material-same-scene ${state.sameScene?'checked':''}>${world.length===1?'我想尝试单张照片的创意延展':'这些照片是同一地点，画面有重叠'}</label><small>${config?.enabled?(materialWorldEligible(world,config)?'下一步选择快速草稿、标准或 Plus，尚未提交生成。':`请调整照片数量或大小。${worldInputLimits(config)?`多图需 ${config.minImages}–${config.maxImages} 张，单张最多 ${Math.round(config.maxImageBytes/1048576)} MB。`:''}`):'生成服务暂不可用，可以先布置照片回廊。'}</small>${button('world','用这组照片，继续确认','btn ghost',!state.sameScene||!materialWorldEligible(world,config)?'disabled':'')}</div></article>`:''}
      ${f.videos.length||f.panoramas.length>1?`<article class="glass material-result material-capture"><div class="material-result-copy"><span class="material-badge">采集重建尚未开放</span><h3>先收好现场原片</h3><p>保留原片为采集草稿，当前不会生成空间。</p>${f.videos.map(item=>`<div class="material-video-row"><span>${esc(item.name)}<small>${item.width?`${item.width} × ${item.height}`:'暂未读到视频信息'}</small><select data-material-video-mode="${esc(item.id)}" aria-label="${esc(item.name)} 的拍摄来源"><option value="perspective-video" ${item.captureMode!=='panoramic-video'?'selected':''}>普通手机视频</option><option value="panoramic-video" ${item.captureMode==='panoramic-video'?'selected':''}>全景相机导出的视频</option></select></span>${button('capture','保存这段草稿','btn ghost sm',`data-item="${esc(item.id)}"`)}</div>`).join('')}${f.panoramas.length>1?`<p>如果这 ${f.panoramas.length} 张全景是在不同位置拍摄，也可以保留为一份多位置采集。</p>${button('capture','保存多位置全景草稿','btn ghost', 'data-item="panoramas"')}`:''}</div></article>`:''}
      </div>${button('space','回到空间','material-text material-exit')}`}
      <div data-material-progress>${uploadProgress}</div><p data-material-status class="v2-feedback" role="status" aria-live="polite">${esc(status)}</p>${sceneConflict?button('refresh-scene','重新核对现场，再确认保存','btn ghost'):''}<div data-material-library></div></section>`;
    if(f.panoramas.length&&f.photos.length){const results=root.querySelector('.material-results');if(results)results.prepend(results.children[1]);}
    if(state.consent&&root.querySelector('[data-material-consent]'))root.querySelector('[data-material-consent]').checked=true;
    root.querySelector('[data-material-files]')?.addEventListener('change',e=>{const files=[...e.target.files];run(()=>addFiles(files));});
    root.querySelectorAll('[data-material-selected]').forEach(input=>input.onchange=()=>run(async()=>{state.items.find(p=>p.id===input.dataset.materialSelected).selected=input.checked;resetChoice();await persist();}));
    for(const [selector,key] of [['[data-material-consent]','consent'],['[data-material-pano-confirm]','panoConfirmed'],['[data-material-same-scene]','sameScene']])root.querySelector(selector)?.addEventListener('change',e=>run(async()=>{state[key]=e.target.checked;await persist();}));
    root.querySelectorAll('[data-material-video-mode]').forEach(input=>input.onchange=()=>run(async()=>{const item=state.items.find(p=>p.id===input.dataset.materialVideoMode);item.captureMode=input.value;item.captureDraftId=null;await persist();}));
    root.querySelectorAll('input[name=pano]').forEach(input=>input.onchange=()=>run(async()=>{state.panoId=input.value;state.panoConfirmed=false;state.panoDraftId=null;await persist();}));
    root.querySelectorAll('input[name=world]').forEach(input=>input.onchange=()=>run(async()=>{state.worldIds=[...root.querySelectorAll('input[name=world]:checked')].map(i=>i.value);state.sameScene=false;await persist();}));
    root.onclick=e=>{const b=e.target.closest('[data-material-action]');if(!b||b.disabled||busy)return;e.stopPropagation();if(b.dataset.materialAction==='pick'){root.querySelector('[data-material-files]').click();return;}run(()=>action(b));};
    if(library)drawLibrary();
    if(step===2&&state.previewPano&&pano){const target=root.querySelector('[data-material-preview]');target.className='material-pano-preview';preview=mountAppSpatial({container:target,kind:'360',panorama:url(pano),signal:view.signal,authenticity:'本机预览 · 尚未保存',onError:()=>tell('暂时无法预览，请确认这是一张完整全景。')});state.previewPano=false;}
    if(busy)root.querySelectorAll('button,input').forEach(node=>node.disabled=true);
  }
  function resetChoice(){const f=facts();state.presentation=f.panoramas.length?'panorama':'gallery';state.panoId=f.panoramas[0]?.id;state.worldIds=f.world.slice(0,worldInputLimits(config)?.maxImages||8).map(p=>p.id);state.sameScene=state.panoConfirmed=state.consent=false;state.panoDraftId=null;}
  async function run(work) {if(busy||!current())return;const token=runId;busy=true;root.querySelectorAll('button,input,select').forEach(n=>n.disabled=true);try{await work();}catch(error){if(token===runId&&current()&&error.name!=='AbortError'){sceneConflict=['version_conflict','scene_version_conflict'].includes(error.code);tell(sceneConflict?'空间的现场已发生变化。原素材保留，请重新核对后再确认。':error.code==='material_storage'?'这台设备未能保存素材。请保留页面与原片，再试一次。':error.code==='material_selection'?'这批最多选择 24 份素材；照片单张最多 12 MB，全部素材合计最多 512 MB。请调整后再试。':error.code==='material_type'?'有文件暂不支持，请添加照片或 MP4、MOV、WebM 视频。':sharedError(error));}}finally{if(token===runId&&current()){busy=false;draw();}}}
  async function addFiles(files,refs=[]) {
    check();if(!files.length)return;
    if(state.items.length+files.length>24||files.some(f=>!f.size||(fileType(f).startsWith('image/')&&f.size>12*1048576))||[...state.items.map(i=>i.bytes),...files.map(f=>f.size)].reduce((a,b)=>a+b,0)>512*1048576)fail('material_selection');
    if(files.some(f=>![...imageTypes,...videoTypes].includes(fileType(f))))fail('material_type');
    const added=[];
    for(const [i,original] of files.entries()) {tell(`正在读取素材 ${i+1}/${files.length}…`);const file=new File([original],original.name,{type:fileType(original),lastModified:original.lastModified});const info=await inspectCaptureFile(file,file.type.startsWith('image/'),{signal:view.signal});check();added.push({id:crypto.randomUUID(),blob:file,name:file.name,type:file.type,bytes:file.size,...info,selected:true,...(refs[i]?{libraryKey:refs[i].key}:{})});}
    state.items.push(...added);resetChoice();await persist();tell(`已读取 ${summary()}。可以继续添加，或看看适合的呈现方式。`);
  }
  async function openLibrary(){
    tell('正在读取你的照片库…');library=await materialLibrary();check();libraryKeys=new Set();
    tell('');
  }
  function drawLibrary(){
    const target=root.querySelector('[data-material-library]');target.innerHTML=`<section class="glass material-library"><h3>从我的照片库选择</h3><p>只使用选中的照片，私人聊天和原声不会加入。</p><div class="material-grid">${library.map((entry,i)=>`<label class="material-tile"><img src="${esc(entry.thumbnail)}" alt=""><input type="checkbox" data-material-library-key="${i}" ${state.items.some(p=>p.libraryKey===entry.key)?'disabled':''}><span>${esc(entry.name)}</span></label>`).join('')||'<p>照片库里还没有照片，可以从设备添加。</p>'}</div>${button('add-library','添加勾选的照片','btn gold')}${button('close-library','收起照片库','material-text')}</section>`;
    target.querySelectorAll('[data-material-library-key]').forEach(input=>input.onchange=()=>{if(input.checked)libraryKeys.add(Number(input.dataset.materialLibraryKey));else libraryKeys.delete(Number(input.dataset.materialLibraryKey));});
    target.scrollIntoView({block:'start',behavior:'instant'});
  }
  async function saveGallery(){
    if(!state.consent)return;
    const f=facts(),newPhotos=f.photos.filter(item=>!item.uploadedPhotoId);
    if(!upload)upload=new SharedUpload({request,spaceId:space.spaceId,identityKey:owner,signal:view.signal,isCurrent:current,onChange:showUpload});
    upload.onChange=showUpload;
    if(upload.state?.completed){await rememberReceipt(upload.state.completed);upload.clearCompleted();}
    const remaining=newPhotos.filter(item=>!item.uploadedPhotoId);
    if(upload.state&&!upload.state.files.every(item=>state.items.some(p=>p.id===item.refKey))) {tell('这个空间还有一批照片待核对，请先继续原来的上传。');navigate('shared-space/'+enc(space.spaceId)+'?tab=upload');return;}
    if(!upload.state&&remaining.length){uploadContext=await request(`/v1/spaces/${enc(space.spaceId)}/upload-context`);await upload.start(remaining.map(p=>sharedPhotoFile(p.blob,p.name)),uploadContext,{refKeys:remaining.map(p=>p.id)});}
    else if(upload.state){for(const [i,item] of upload.state.files.entries()){const source=state.items.find(p=>p.id===item.refKey);await upload.resume(i,source&&sharedPhotoFile(source.blob,source.name));}}
    if(upload.state){if(!upload.complete()){tell('部分照片还未保存。原素材和成功项已保留，点击继续保存会核对后重试。');return;}await rememberReceipt(await upload.finalize());}
    check();state.storyPhotos=f.photos.filter(p=>p.uploadedPhotoId);step=1;state.step=1;await persist();tell('照片已保存。可以逐张留话，或直接走进回廊。');
  }
  async function rememberReceipt(receipt){for(const item of receipt.contributions||[]){const p=state.items.find(p=>p.id===item.refKey);if(p)p.uploadedPhotoId=item.photoId;}await persist();}
  async function handoff(kind,itemId){
    const f=facts(),sid=space.spaceId;
    if(kind==='panorama'){
      const item=f.panoramas.find(p=>p.id===state.panoId);if(!item||!state.panoConfirmed)return;
      if(!state.panoDraftId){state.panoDraftId=crypto.randomUUID();await persist();}
      const rows=await drafts('getAll');check();let draft=rows.find(d=>d.id===state.panoDraftId&&d.accountId===owner);
      if(!draft){const management=await request('/v1/spaces/'+enc(sid)+'/management');draft={id:state.panoDraftId,accountId:owner,title:space.name,spaceId:sid,spaceVersion:management.space.version??management.version,sceneIfMatchVersion:management.sceneVersion,panorama:sharedPhotoFile(item.blob,item.name),consent:true,createdAt:new Date().toISOString(),materialSource:state.id};await drafts('put',draft);check();}
      tell('正在保存全景现场…');const source=await dataUrl(draft.panorama);check();
      await request('/v1/app-spaces/'+enc(draft.id),{method:'PUT',key:draft.id,version:draft.spaceVersion,body:{title:draft.title,consent:true,spaceId:sid,sceneIfMatchVersion:draft.sceneIfMatchVersion,panorama:{name:draft.panorama.name,mimeType:draft.panorama.type,dataBase64:source.split(',')[1]}}});
      draft.saved=true;await drafts('put',draft);check();navigate('shared-space/'+enc(sid)+'?view=scene');
    }else if(kind==='world'||kind==='world-pano'){
      const isPano=kind==='world-pano',items=isPano?f.panoramas.filter(p=>p.id===state.panoId):f.world.filter(p=>state.worldIds.includes(p.id));if(!(isPano?state.panoConfirmed:state.sameScene)||!materialWorldEligible(items,config))return;
      const rows=await drafts('getAll');check();const prior=rows.find(row=>row.id===worldDraftId(owner)&&row.accountId===owner);if(prior?.photos?.length)await retainSpatialRevision(drafts,prior,'从空间素材选择新的一组照片');check();
      const photos=[];for(const item of items){photos.push({src:await dataUrl(item.blob),name:item.name,width:item.width,height:item.height});check();}
      await drafts('put',{id:worldDraftId(owner),accountId:owner,title:space.name,prompt:'',photos,worldMode:isPano?'pano':photos.length===1?'single':'multi',worldModel:prior?.worldModel||config?.recommendedModel||'marble-1.1',spaceId:sid,materialSource:state.id});check();navigate('world-create?spaceId='+enc(sid)+'&from=materials');
    }else if(kind==='capture'){
      const items=itemId==='panoramas'?f.panoramas:f.videos.filter(p=>p.id===itemId);if(!items.length)return;
      const item=items[0],multi=itemId==='panoramas',id=(!multi&&item.captureDraftId)||'capture-'+crypto.randomUUID();
      if(multi||!item.captureDraftId){await drafts('put',{id,kind:'capture',accountId:owner,title:space.name,spaceId:sid,createdAt:new Date().toISOString(),mode:multi?'panoramic-images':item.captureMode||'perspective-video',files:items.map(p=>({id:crypto.randomUUID(),blob:p.blob,name:p.name,bytes:p.bytes,width:p.width,height:p.height,durationSeconds:p.durationSeconds,metadataUnavailable:p.metadataUnavailable})),consent:false,state:'draft',localRevision:0});check();if(!multi)item.captureDraftId=id;await persist();}
      navigate('capture-space?draft='+enc(id));
    }
  }
  async function action(b){
    const a=b.dataset.materialAction;
    if(a==='leave-note'){noteDialog?.destroy();noteDialog=openSpacePhotoStory({request,api,user,spaceId:space.spaceId,photoId:b.dataset.photo,identityKey:owner,signal:view.signal,showPhoto:true});return;}
    if(a==='corridor')return navigate('shared-space/'+enc(space.spaceId)+'?view=corridor');
    if(a==='ordinary-photo'){const item=state.items.find(p=>p.id===b.dataset.item);if(item){item.forcePhoto=true;resetChoice();await persist();status='已按普通照片使用，仍可布置回廊或选择 AI 补全。';}return;}
    if(a==='refresh-scene'){await request('/v1/spaces/'+enc(space.spaceId)+'/management');state.panoDraftId=null;state.panoConfirmed=false;sceneConflict=false;await persist();status='已核对当前空间。请重新确认要保存的全景。';return;}
    if(['choose-gallery','choose-panorama','choose-world'].includes(a)){state.presentation=a.slice(7);await persist();return;}
    if(a==='space')return navigate('shared-space/'+enc(space.spaceId));
    if(a==='next'){if(!facts().photos.length&&!facts().videos.length)return;step=2;state.step=2;await persist();status='';return;}
    if(a==='back'){step=1;state.step=1;await persist();status='';return;}
    if(a==='library'){await openLibrary();return;}
    if(a==='close-library'){library=null;return;}
    if(a==='add-library'){const entries=[...libraryKeys].map(i=>library[i]);if(!entries.length)return;const files=[];for(const entry of entries){check();if(entry.accountId!==owner)fail('account_changed');files.push(sharedPhotoFile(await readMaterialPhoto(entry,{signal:view.signal}),entry.name));}await addFiles(files,entries);library=null;return;}
    if(a==='preview-pano'){const item=facts().panoramas.find(p=>p.id===state.panoId);if(item){state.previewPano=true;}return;}
    if(a==='gallery')return saveGallery();
    if(['panorama','world','world-pano','capture'].includes(a))return handoff(a,b.dataset.item);
  }
  return {
    async mount(target,{space:nextSpace,view:nextView}){
      this.destroy();root=target;view=nextView;space=nextSpace;owner=user()?.id;active=true;uploadProgress='';busy=false;status='';library=null;config=null;existing=[];upload=null;const token=runId;
      const rows=await drafts('getAll');check();state=rows.find(d=>d.id===materialDraftId(owner,space.spaceId)&&d.accountId===owner)||{id:materialDraftId(owner,space.spaceId),kind:'space-materials',accountId:owner,spaceId:space.spaceId,items:[],worldIds:[],step:1,createdAt:new Date().toISOString()};step=state.step===2&&state.items.some(i=>i.selected!==false)?2:1;state.presentation||=facts().panoramas.length?'panorama':'gallery';
      const result=await Promise.allSettled([request('/api/world/config'),request('/v1/viewer/spaces/'+enc(space.spaceId))]);check();if(token!==runId)return;
      config=result[0].status==='fulfilled'?result[0].value:null;if(result[1].status==='fulfilled'){existing=photoRows(space.spaceId,result[1].value.photos);state.hasScene=Boolean(result[1].value.sceneContext?.scene);}
      const pending=new SharedUpload({request,spaceId:space.spaceId,identityKey:owner,signal:view.signal,isCurrent:current});if(pending.state&&!pending.state.completed)upload=pending;
      draw();
    },
    destroy(){noteDialog?.destroy();active=false;runId++;preview();preview=()=>{};urls.forEach(URL.revokeObjectURL);urls.clear();upload?.files.clear();if(root)root.onclick=null;}
  };
}
