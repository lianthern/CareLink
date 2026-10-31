import { WORLD_MODELS, worldModelLabel, worldPhotoAssessment } from './world-generation-options.js';
import { worldPendingDecision, canClearWorldPendingAfterError } from './unseen-app-world.js';
import { retainSpatialRevision, restoreSpatialRevision } from './moment-spatial-history.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const LEGACY_KEY='unseen.app.world.pending';
export const worldDraftId=owner=>'world-input:'+owner;
export const worldPendingKey=owner=>'unseen.app.world.pending:'+owner;
const readPending=key=>{try{return localStorage.getItem(key);}catch{return 'storage-unavailable';}};
const dataUrl=file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});
const positive=value=>Number.isSafeInteger(value)&&value>0?value:null;
export function worldInputLimits(config){const imageBytes=positive(config?.maxImageBytes),totalBytes=positive(config?.maxTotalImageBytes),minImages=positive(config?.minImages),maxImages=positive(config?.maxImages);return imageBytes&&totalBytes&&minImages&&maxImages&&minImages<=maxImages?{imageBytes,totalBytes,minImages,maxImages}:null;}
export function worldAccountDecision(pending,jobs=[]){
  const unresolved=jobs.find(job=>['submitting','unknown'].includes(job.status)||job.status==='processing'&&!job.operation?.id);
  const decision=worldPendingDecision(pending||unresolved?.id,jobs);
  return unresolved&&!decision.blocked?worldPendingDecision(unresolved.id,jobs):decision;
}
const jobLabel=status=>({submitting:'提交结果待确认',unknown:'结果未知 · 需要核对',processing:'正在生成',complete:'已完成',failed:'生成失败',rejected:'未受理'}[status]||'状态待核对');
const errorCopy=error=>({world_model_invalid:'这个生成档位当前不可用，请重新选择。',panorama_confirmation_required:'请确认这是完整 360° 全景，包含天空和地面。',photo_ratio_mismatch:'多图需要相同横竖比例。请先在相册裁成同一比例，再重新选择。',panorama_ratio_invalid:'全景必须为 2:1，并包含完整的天空和地面。',image_unresolved:'有照片无法读取，请换用 JPG、PNG 或 WebP 原图。','WL-204':'生成暂时不可用（错误码：WL-204）。请稍后再试。',world_target_unavailable:'暂时无法核对现场版本，请重新读取空间后再确认。',image_size_invalid:'照片格式、数量或大小超出当前服务限制，请按页面提示重新选择。',local_draft_unavailable:'原素材未能保存到本机，请保留当前页面并重试。',account_changed:'账号已变化，请回到原账号核对。',session_unavailable:'请重新登录原账号。',world_jobs_unavailable:'任务记录暂时不可读，请保留原请求编号。',world_result_pending_reconciliation:'请先核对原请求，当前不会再次生成。',world_request_conflict:'该请求已有记录，不能改变素材后重放。',world_claim_unavailable:'旧任务可能已由其他账号认领，请保留原记录核对。',scene_version_conflict:'现场版本已变化。请重新读取并确认目标，不会重新生成。',version_conflict:'空间版本已变化。请重新读取并确认目标，不会重新生成。',resource_unavailable:'你已无权修改这个空间，请选择自己拥有的空间。',daily_limit:'今天的体验额度已用完。',visitor_daily_limit:'今天的体验额度已用完。',worldlabs_not_configured:'World 生成服务暂未启用。'}[error?.code||error?.data?.error]||'暂时没有完成。保留素材和原任务，核对状态后再操作。');

export function createMomentWorld({navigate,showScene,drafts,api,user=()=>null,guest=()=>!user()?.id,login=()=>{}}){
  let root,owner,epoch=0,control,alive=false,editLock=null,tasksView=false,materialFlow=false;
  let state={},config=null,spaces=[],management=null,revisions=[],legacyDraft=null,legacyJobs=null,legacyPending=null,importJob=null;
  const current=token=>alive&&token===epoch&&!control?.signal.aborted&&user()?.id===owner;
  const check=token=>{if(!current(token))throw new DOMException('Account or page changed','AbortError');};
  const request=async(path,options={},token=epoch)=>{check(token);const data=await api.request(path,{...options,accountId:path==='/api/world/config'?null:owner,signal:AbortSignal.any([control.signal,AbortSignal.timeout(90000),...(options.signal?[options.signal]:[])])});check(token);return data;};
  const pending=()=>readPending(worldPendingKey(owner));
  const decision=()=>worldAccountDecision(pending(),state.worldJobs||[]);
  const canEdit=()=>!editLock&&!state.worldBusy&&!state.loading;
  const lockEdit=()=>{if(!canEdit())return null;const lock=editLock={};root.querySelectorAll('input,select,textarea,button').forEach(el=>el.disabled=true);return lock;};
  const unlock=(lock,token)=>{if(editLock===lock)editLock=null;if(current(token))draw();};
  const sourceSnapshot=()=>({id:worldDraftId(owner),accountId:owner,title:state.title||'',prompt:state.prompt||'',photos:state.photos||[],worldMode:state.worldMode||'multi',worldModel:state.worldModel,spaceId:state.spaceId||'',sceneSource:state.sceneSource||null});
  const persist=()=>drafts('put',sourceSnapshot());
  async function readRevisions(token=epoch){const rows=await drafts('getAll');check(token);revisions=rows.filter(d=>d.accountId===owner&&d.archivedAt&&d.sourceDraftId===worldDraftId(owner)).sort((a,b)=>b.archivedAt.localeCompare(a.archivedAt));return rows;}
  async function retain(reason,token){await retainSpatialRevision(drafts,sourceSnapshot(),reason);check(token);await readRevisions(token);}
  async function refresh(token=epoch){const result=await request('/api/world/jobs',{},token);state.worldJobs=Array.isArray(result.jobs)?result.jobs:[];const d=worldPendingDecision(pending(),state.worldJobs);if(d.canClear)localStorage.removeItem(worldPendingKey(owner));}
  async function readSpace(spaceId,token=epoch){check(token);management=null;if(!spaceId)return;const result=await request('/v1/spaces/'+encodeURIComponent(spaceId)+'/management',{},token);if(result.space?.spaceId!==spaceId||(result.isOwner??result.space?.owner)!==true)throw {code:'resource_unavailable'};if(!positive(result.space.version)||!positive(result.sceneVersion))throw {code:'world_target_unavailable'};management=result;}
  function targetHtml(){if(materialFlow&&!importJob)return `<section class="glass spatial-task"><h2>${esc(management?.space.name||'当前空间')}</h2><p>已带入选中的 ${state.photos?.length||0} 张原照片，生成完成后仍可选择是否用于这处现场。</p><button class="secondary" data-world-action="materials">返回调整素材与呈现方式</button>${!management?'<p>空间权限暂未核对，请重新读取后再确认。</p><button class="secondary" data-world-action="reload-target">重新读取空间</button>':''}</section>`;return `<section class="glass spatial-task"><h2>放进哪个空间</h2><label class="field">我的空间<select data-world-space ${state.worldBusy?'disabled':''}><option value="">请选择</option>${spaces.map(space=>`<option value="${esc(space.spaceId||space.id)}" ${(space.spaceId||space.id)===state.spaceId?'selected':''}>${esc(space.name||space.title)}</option>`).join('')}</select></label>${management?`<p>已选择：${esc(management.space.name)}。生成完成后会再次确认是否更新这个空间的现场。</p>`:state.spaceId?'<p>尚未读到可用的修改权限与现场版本，请重新读取。</p>':'<p>可以先创建一个空空间，再回到这里继续。</p>'}<button class="secondary" data-world-action="reload-target">重新读取空间版本</button><button class="secondary" data-world-action="create-space">创建空间</button></section>`;}
  function blockedHtml(){const d=decision();return d.blocked?`<aside class="spatial-notice" role="status"><strong>先核对已有提交</strong><p>原请求 ${esc(d.requestId||'编号暂缺')} 尚未有明确结果。任务暂时不在列表中，也不能证明未受理。现在不会再次生成。</p><button class="secondary" data-world-action="tasks">查看账号任务</button></aside>`:'';}
  function legacyHtml(){return `<details class="glass spatial-task"><summary>旧浏览器素材与任务</summary><p>这里的旧记录属于这个浏览器，尚未自动归入当前账号。认领只处理你明确选择的项目。</p>${legacyDraft?'<button class="secondary" data-world-action="claim-draft">把旧素材复制到当前账号</button>':'<p>没有未归入账号的本机素材。</p>'}${legacyPending?`<p>旧提交编号：${esc(legacyPending)}。结果未知时先核对，不能当成失败重交。</p>`:''}<button class="secondary" data-world-action="legacy-jobs">读取这个浏览器的旧任务</button>${legacyJobs?legacyJobs.length?`<div>${legacyJobs.map(job=>`<label class="field"><span><input type="checkbox" name="legacy-job" value="${esc(job.id)}"> ${esc(job.displayName||job.id)} · ${esc(jobLabel(job.status))}</span></label>`).join('')}</div><button class="secondary" data-world-action="claim-jobs">认领勾选的任务到当前账号</button>`:'<p>没有可认领的旧任务。旧提交编号仍保留，不会自动清除。</p>':''}</details>`;}
  function jobHtml(job){const imported=job.importedSpaceId||job.importedSpace?.spaceId;return `<article class="spatial-task"><h2>${esc(job.displayName||'照片生成的空间')}</h2><p>${esc(worldModelLabel(job.model))} · ${job.mode==='pano'?'360° 全景':job.mode==='multi'?'同场景多图':job.mode==='single'?'单图延展':''}${job.imageCount?` · ${job.imageCount} 张`:''}</p><p>${esc(jobLabel(job.status))} · ${esc(new Date(job.createdAt).toLocaleString('zh-CN'))}</p><small>${esc(job.id)}</small>${job.spaceId?`<p>关联空间编号：${esc(job.spaceId)}</p>`:''}${job.error||job.operation?.error?`<p>${esc(errorCopy({code:job.error||job.operation.error.code}))}</p>`:''}${imported?`<button class="secondary" data-world-open-space="${esc(imported)}">打开已保存的空间</button>`:job.status==='complete'&&job.operation?.world?.id?`<p>这是 World Labs 的 AI 补全结果，尚需确认写入空间。</p><button class="secondary" data-world-import="${esc(job.id)}">确认归入空间</button><button class="text-button" data-world-preview="${esc(job.id)}">先查看完成品</button>`:job.operation?.id&&!job.operation.done&&!['failed','rejected'].includes(job.status)?`<button class="secondary" data-world-poll="${esc(job.id)}">核对生成进度</button>`:job.status==='rejected'?'<p>服务端已确认未受理，原记录继续保留。</p>':job.status==='failed'?'<p>供应商已经受理后返回失败。不会自动退款、重提或再消耗生成额度。</p>':'<p>保留原请求核对，不显示虚构进度，也不会自动重提。</p>'}</article>`;}
  function importHtml(){if(!importJob)return '';const matching=management?.space?.spaceId===state.spaceId;return `<section class="glass spatial-task"><h2>确认完成品的归属</h2><p>原请求：${esc(importJob.id)}。此操作只保存已有成果，不重新生成。</p>${targetHtml()}<p>确认后会更新这个空间的现场版本。已有照片和邀请保留，原有照片位置需要按新现场核对。</p><button class="secondary" data-world-action="reload-target">重新读取空间版本</button><button class="primary" data-world-action="confirm-import" ${!matching?'disabled':''}>确认将完成品用于这个空间</button><button class="text-button" data-world-action="cancel-import">暂不写入</button></section>`;}
  function settingsHtml(selected){
    const available=Array.isArray(config?.models)?config.models:WORLD_MODELS;
    const assessment=worldPhotoAssessment(selected,state.worldMode);
    const card=model=>`<button type="button" class="world-tier" data-world-model="${esc(model.id)}" aria-pressed="${state.worldModel===model.id}"><strong>${esc(model.label)}${model.id==='marble-1.1'?'<span>推荐</span>':''}</strong><small>${esc(model.subtitle)}</small><p>${esc(model.description)}</p></button>`;
    return `<section class="world-generation-settings"><div class="world-settings-heading"><h2>选择生成档位</h2><a href="/space-guide.html" target="_blank" rel="noopener">空间生成手册 ↗</a></div><div class="world-tier-grid" role="group" aria-label="生成档位">${available.filter(m=>!m.legacy).map(card).join('')}</div><details class="world-legacy"><summary>历史模型${state.worldModel==='marble-1.0'?' · 已选经典版':''}</summary>${available.filter(m=>m.legacy).map(card).join('')}</details><p class="world-tip">Plus 会尝试生成更大的空间。模糊、遮挡或缺少视角，仍要先改善照片。</p><div class="world-input-review"><h3>生成前，先看看素材</h3><p>${state.worldMode==='multi'?'选同一处空间、相近位置拍摄的不同方向，保留重叠的门窗或家具。提交时统一尺寸，不裁剪原图。':state.worldMode==='pano'?'只上传一张完整 360° 全景。2:1 比例只是必要条件，还要包含天空、地面和连续的左右边缘。':'选能看见地面、墙面与远近关系的全貌。未拍到的方向会由 AI 想象。'}</p>${[...assessment.errors,...assessment.notes].map(note=>`<p class="world-material-note">${esc(note)}</p>`).join('')}${state.worldMode==='pano'?'<label class="field"><span><input id="world-pano-confirm" type="checkbox">这是完整 360° 全景，包含天空和地面；不是手机横扫长图。</span></label>':''}<a href="/space-guide.html#photos" target="_blank" rel="noopener">查看选片与补拍示例 ↗</a></div></section>`;
  }
  function draw(){
    const drawToken=epoch;if(!current(drawToken))return;
    if(guest()||!owner){root.innerHTML='<section class="spatial-world"><h1>照片里的空间</h1><p>生成任务保存到账号，换设备也能找回。请先登录；这个浏览器的旧素材和任务不会自动认领。</p><button class="primary" data-world-action="login">登录后继续</button></section>';root.onclick=e=>{if(current(drawToken)&&e.target.closest('[data-world-action="login"]'))login('spatial');};return;}
    const limits=worldInputLimits(config),d=decision(),selected=state.worldMode!=='multi'?(state.photos||[]).slice(0,1):state.photos||[];
    const countOk=limits&&selected.length>=(state.worldMode!=='multi'?1:limits.minImages)&&selected.length<=(state.worldMode!=='multi'?1:limits.maxImages);
    const enabled=config?.enabled&&limits&&countOk&&management&&!d.blocked&&!legacyPending&&worldPhotoAssessment(selected,state.worldMode).errors.length===0;
    root.innerHTML=`<section class="spatial-world"><div class="spatial-filters"><button class="secondary" data-world-action="create">生成空间</button><button class="secondary" data-world-action="tasks">账号任务</button></div><p class="spatial-notice">任务和新素材归当前账号所有。World Labs 会生成 AI 补全区域，可能与实景不同；这不是精确现场重建。</p>${blockedHtml()}${state.worldStatus?`<p role="status">${esc(state.worldStatus)}</p>`:''}${importHtml()}${tasksView?`<h1>我的空间任务</h1><button class="secondary" data-world-action="refresh">刷新任务</button>${(state.worldJobs||[]).map(jobHtml).join('')||'<p>当前账号还没有任务。</p>'}`:`${targetHtml()}<h1>${materialFlow?'确认 AI 补全':'从同一空间的照片开始'}</h1><div class="spatial-filters" role="group" aria-label="输入方式"><button class="secondary" data-world-mode="multi" aria-pressed="${state.worldMode==='multi'}">同场景多图</button><button class="secondary" data-world-mode="single" aria-pressed="${state.worldMode==='single'}">单图延展</button><button class="secondary" data-world-mode="pano" aria-pressed="${state.worldMode==='pano'}">完整 360° 全景</button></div><p>${limits?`每张最多 ${(limits.imageBytes/1048576).toFixed(1)} MB，总计 ${(limits.totalBytes/1048576).toFixed(1)} MB；多图模式 ${limits.minImages}–${limits.maxImages} 张。`:'正在读取实际照片限制，读取成功后才能提交。'}${config?.quota?`今日公共额度剩余 ${Number(config.quota.remainingToday)||0} 次。`:''}</p>${materialFlow?'':`<label class="field">选择原照片<input type="file" accept="image/jpeg,image/png,image/webp" multiple data-world-files ${!limits?'disabled':''}></label>`}${state.worldMode!=='multi'&&(state.photos?.length||0)>1?'<p>当前只使用第一张照片；其他照片仍保留，切回多图即可查看。</p>':''}<div class="app-photo-strip">${selected.map(photo=>`<img src="${esc(photo.src)}" alt="${esc(photo.name||'选中的原照片')}" style="max-width:150px;max-height:100px;object-fit:contain">`).join('')}</div>${settingsHtml(selected)}<label class="field">名称<input id="account-world-name" maxlength="64" value="${esc(state.title||'')}"></label><label class="field">补充描述（可选）<textarea id="account-world-prompt" maxlength="2000" placeholder="例如：这是同一间客厅，保留窗户、沙发和通往阳台的门。自然光，保持原有布局。">${esc(state.prompt||'')}</textarea></label><p>${state.sceneSource?'原照片保留在场景相册；本页使用已选照片的适配副本。':'原照片保留在本机账号草稿；提交时发送适配尺寸的副本。'}照片交给 World Labs 处理，生成结果有公开链接，输入可能依其条款用于改进模型。</p><label class="field"><span><input id="account-world-consent" type="checkbox">我有照片使用权，同意第三方处理、公开生成结果和消耗当前体验额度。</span></label>${legacyPending?'<p>这个浏览器有一笔旧提交待核对。请先从下方旧任务中明确认领并核对，不能直接重交。</p>':''}<button class="primary" data-world-action="generate" ${!enabled?'disabled':''}>用${esc(WORLD_MODELS.find(m=>m.id===state.worldModel)?.label||'所选档位')}生成${selected.length?` ${selected.length} 张照片`:''}</button><button class="secondary" data-world-action="clear">收起素材，另开草稿</button><details><summary>恢复当前账号的历史素材（${revisions.length}）</summary>${revisions.map(revision=>`<p>${esc(revision.title||'未命名草稿')} · ${revision.photos?.length||0} 张 <button class="secondary" data-world-restore="${esc(revision.id)}">恢复这份素材</button></p>`).join('')}</details>`}${legacyHtml()}</section>`;
    const name=root.querySelector('#account-world-name'),prompt=root.querySelector('#account-world-prompt');
    for(const input of [name,prompt].filter(Boolean))input.oninput=()=>{if(!current(drawToken)||!canEdit())return;state.title=name.value;state.prompt=prompt.value;persist().catch(()=>{if(current(drawToken)){state.worldStatus='素材未能保存到本机，请保持页面并重试。';}});};
    root.querySelector('[data-world-space]')?.addEventListener('change',event=>{const token=drawToken;return run(async()=>{if(importJob?.spaceId&&event.target.value!==importJob.spaceId)throw {code:'resource_unavailable'};state.spaceId=event.target.value;await persist();check(token);await readSpace(state.spaceId,token);},token);});
    root.querySelector('[data-world-files]')?.addEventListener('change',event=>{const files=[...event.target.files],token=drawToken;return run(async()=>{const limit=worldInputLimits(config);if(!limit||!files.length||files.length>limit.maxImages||files.some(file=>!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>limit.imageBytes)||files.reduce((n,file)=>n+file.size,0)>limit.totalBytes)throw {code:'image_size_invalid'};const photos=await Promise.all(files.map(async file=>{const src=await dataUrl(file),image=new Image();image.src=src;try{await image.decode();}catch{throw {code:'image_unresolved'};}return {src,name:file.name,width:image.naturalWidth,height:image.naturalHeight};}));check(token);await retain('替换前的原素材',token);state.photos=photos;state.sceneSource=null;await persist();},token);});
    root.onclick=event=>{const button=event.target.closest('button');if(!button||button.disabled||editLock)return;const token=drawToken;return run(()=>action(button,token),token);};
    if(editLock||state.worldBusy||state.loading)root.querySelectorAll('input,select,textarea,button').forEach(el=>el.disabled=true);
  }
  async function run(work,token=epoch){if(!current(token))return;const lock=lockEdit();if(!lock)return;try{await work();}catch(error){if(current(token)&&error.name!=='AbortError'){if(['scene_version_conflict','version_conflict'].includes(error.code||error.data?.error))management=null;state.worldStatus=errorCopy(error);}}finally{unlock(lock,token);}}
  async function prepareSet(photos,mode){
    const decoded=await Promise.all(photos.map(async photo=>{const image=new Image();image.src=photo.src;try{await image.decode();}catch{throw {code:'image_unresolved'};}return image;}));
    const dimensions=decoded.map(image=>({width:image.naturalWidth,height:image.naturalHeight}));
    if(dimensions.some(d=>!d.width||!d.height))throw {code:'image_unresolved'};
    if(worldPhotoAssessment(dimensions,mode).errors.length)throw {code:mode==='pano'?'panorama_ratio_invalid':'photo_ratio_mismatch'};
    const cap=mode==='pano'?4096:2048;
    const commonWidth=Math.min(...dimensions.map(d=>d.width*Math.min(1,cap/Math.max(d.width,d.height))));
    return decoded.map(image=>{const scale=mode==='multi'?commonWidth/image.naturalWidth:Math.min(1,cap/Math.max(image.naturalWidth,image.naturalHeight));const canvas=document.createElement('canvas');canvas.width=Math.round(image.naturalWidth*scale);canvas.height=mode==='multi'?Math.round(commonWidth*dimensions[0].height/dimensions[0].width):Math.round(image.naturalHeight*scale);canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);return canvas.toDataURL('image/jpeg',.92);});
  }
  async function generate(token){
    if(state.worldBusy||!root.querySelector('#account-world-consent')?.checked||!management||!config?.enabled||!worldInputLimits(config)||decision().blocked||legacyPending)return;
    if(state.worldMode==='pano'&&!root.querySelector('#world-pano-confirm')?.checked){state.worldStatus=errorCopy({code:'panorama_confirmation_required'});return;}
    if(!navigator.locks){state.worldStatus='当前浏览器不能安全协调提交，请使用支持 Web Locks 的浏览器。';return;}
    await navigator.locks.request('unseen-world-generation:'+owner,{ifAvailable:true},async lock=>{
      check(token);if(!lock){state.worldStatus='另一页正在提交，请先核对账号任务。';return;}
      state.worldBusy=true;
      const requestId=state.sceneSource?.handoffId||crypto.randomUUID(),name=state.title||'照片生成的空间',prompt=state.prompt||'',mode=state.worldMode,model=state.worldModel,selected=mode!=='multi'?state.photos.slice(0,1):[...state.photos];
      const target={spaceId:management.space.spaceId,spaceVersion:management.space.version,sceneVersion:management.sceneVersion};
      try{const limits=worldInputLimits(config);if(selected.length<(mode!=='multi'?1:limits.minImages)||selected.length>(mode!=='multi'?1:limits.maxImages))throw {code:'image_size_invalid'};try{await persist();}catch{throw {code:'local_draft_unavailable'};}check(token);await refresh(token);if(decision().blocked)return;
        const images=await prepareSet(selected,mode);check(token);
        localStorage.setItem(worldPendingKey(owner),requestId);
        await request('/api/world/generate',{method:'POST',key:requestId,body:{clientRequestId:requestId,mode,model,...(mode==='pano'?{panoConfirmed:true}:{}),images,displayName:name,prompt,publicConsent:true,...(state.sceneSource?{sceneSource:state.sceneSource}:{}),...target}},token);
        await refresh(token);state.worldStatus='提交已记录。请在账号任务中核对结果。';tasksView=true;
      }catch(error){if(!current(token))return;const same=readPending(worldPendingKey(owner))===requestId;
        if(same&&(canClearWorldPendingAfterError(pending(),error,requestId)||error?.data?.admitted===false&&error.data.requestId===requestId))localStorage.removeItem(worldPendingKey(owner));
        try{await refresh(token);}catch{}if(['scene_version_conflict','version_conflict'].includes(error.code||error.data?.error))management=null;state.worldStatus=errorCopy(error);
      }finally{if(current(token))state.worldBusy=false;}
    });
  }
  async function action(button,token){
    const action=button.dataset.worldAction;
    if(action==='materials')return navigate('space-materials/'+encodeURIComponent(state.spaceId));
    if(action==='tasks'){tasksView=true;await refresh(token);return;}
    if(action==='create'){tasksView=false;return;}
    if(action==='create-space')return navigate('new-space');
    if(action==='refresh'){await refresh(token);return;}
    if(action==='legacy-jobs'){legacyJobs=(await request('/api/world/jobs/legacy',{},token)).jobs||[];return;}
    if(action==='claim-jobs'){
      const ids=[...root.querySelectorAll('input[name="legacy-job"]:checked')].map(input=>input.value);if(!ids.length){state.worldStatus='请先勾选要认领的旧任务。';return;}
      if(legacyPending&&ids.includes(legacyPending)&&pending()&&pending()!==legacyPending){state.worldStatus='当前账号另有一笔提交待核对。请先核对账号任务，再认领这笔旧提交。';return;}
      await request('/api/world/jobs/claim',{method:'POST',key:crypto.randomUUID(),body:{ids}},token);
      if(legacyPending&&ids.includes(legacyPending)){localStorage.setItem(worldPendingKey(owner),legacyPending);localStorage.removeItem(LEGACY_KEY);legacyPending=null;}
      await refresh(token);legacyJobs=(await request('/api/world/jobs/legacy',{},token)).jobs||[];state.worldStatus='已选择的旧任务归入当前账号，原请求与结果继续保留。';tasksView=true;return;
    }
    if(action==='claim-draft'){if(!legacyDraft)return;await retain('认领旧素材前的账号草稿',token);const copy=structuredClone(legacyDraft);Object.assign(state,{title:copy.title||'',prompt:copy.prompt||'',photos:copy.photos||[],worldMode:copy.worldMode||'multi',sceneSource:null});await persist();check(token);state.worldStatus='旧素材已复制到当前账号，浏览器原稿仍然保留。';return;}
    if(action==='clear'){await retain('收起的原素材',token);Object.assign(state,{title:'',prompt:'',photos:[],worldMode:'multi',sceneSource:null});await persist();return;}
    if(button.dataset.worldRestore){const revision=revisions.find(row=>row.id===button.dataset.worldRestore);if(!revision)return;await retain('恢复其他素材前的草稿',token);const restored=await restoreSpatialRevision(drafts,revision,{id:worldDraftId(owner),accountId:owner});check(token);Object.assign(state,{title:restored.title||'',prompt:restored.prompt||'',photos:restored.photos||[],worldMode:restored.worldMode||'multi',worldModel:restored.worldModel||config?.recommendedModel||config?.model||'marble-1.1',sceneSource:restored.sceneSource||null});await persist();return;}
    if(button.dataset.worldModel){if((config?.models||WORLD_MODELS).some(m=>m.id===button.dataset.worldModel)){state.worldModel=button.dataset.worldModel;await persist();}return;}
    if(button.dataset.worldMode){state.worldMode=button.dataset.worldMode;await persist();return;}
    if(button.dataset.worldPoll){await request('/api/world/jobs/'+encodeURIComponent(button.dataset.worldPoll),{},token);await refresh(token);return;}
    if(button.dataset.worldOpenSpace)return navigate('shared-space/'+encodeURIComponent(button.dataset.worldOpenSpace));
    if(button.dataset.worldPreview){const job=state.worldJobs.find(job=>job.id===button.dataset.worldPreview);if(job?.operation?.world){destroy();return showScene({title:job.displayName||'World 完成品',notice:'World Labs · AI 补全结果，已有公开链接',space:{kind:'world',world:job.operation.world},photos:[]},'world-tasks');}return;}
    if(button.dataset.worldImport){importJob=state.worldJobs.find(job=>job.id===button.dataset.worldImport);if(!importJob?.operation?.world?.id){importJob=null;return;}if(importJob.spaceId)state.spaceId=importJob.spaceId;await readSpace(state.spaceId,token);return;}
    if(action==='reload-target'){await readSpace(state.spaceId,token);state.worldStatus='已读取最新空间版本，请重新确认。';return;}
    if(action==='cancel-import'){importJob=null;return;}
    if(action==='confirm-import'){
      if(!importJob||!management||importJob.spaceId&&importJob.spaceId!==management.space.spaceId)return;
      const job=importJob,target={spaceId:management.space.spaceId,spaceVersion:management.space.version,sceneVersion:management.sceneVersion};
      const result=await request('/api/world/jobs/'+encodeURIComponent(job.id)+'/import',{method:'POST',key:`world-import-${job.id}-${target.spaceId}-${target.spaceVersion}-${target.sceneVersion}`,body:target},token);
      const spaceId=result.space?.spaceId||result.space?.id;if(!spaceId)throw {code:'world_result_pending_reconciliation'};importJob=null;await refresh(token);check(token);navigate('shared-space/'+encodeURIComponent(spaceId));return;
    }
    if(action==='generate')await generate(token);
  }
  // Release the task editor before another view takes ownership of its DOM.
  function destroy(){alive=false;epoch++;control?.abort();editLock=null;if(root)root.onclick=null;}
  return {
    async mount(target,tasks=false,{spaceId,fromMaterials=false}={}){
      this.destroy();root=target;owner=user()?.id;alive=true;control=new AbortController();const token=++epoch;tasksView=tasks;materialFlow=fromMaterials;editLock=null;state={photos:[],title:'',prompt:'',worldMode:'multi',worldModel:'marble-1.1',worldJobs:[],spaceId:spaceId||'',worldBusy:false,loading:true};config=null;management=null;spaces=[];legacyJobs=null;legacyDraft=null;legacyPending=readPending(LEGACY_KEY);importJob=null;revisions=[];draw();
      try{config=await request('/api/world/config',{},token);state.worldModel=config.recommendedModel||config.model||'marble-1.1';if(guest()||!owner){draw();return;}
        const rows=await readRevisions(token),saved=rows.find(row=>row.id===worldDraftId(owner)&&row.accountId===owner&&!row.archivedAt);legacyDraft=rows.find(row=>row.id==='world-input'&&row.accountId==='world-browser')||null;
        if(saved)Object.assign(state,{title:saved.title||'',prompt:saved.prompt||'',photos:saved.photos||[],worldMode:saved.worldMode||'multi',worldModel:(config.models||WORLD_MODELS).some(m=>m.id===saved.worldModel)?saved.worldModel:state.worldModel,spaceId:spaceId||saved.spaceId||'',sceneSource:saved.sceneSource||null});
        const listed=await request('/v1/me/spaces',{},token);spaces=(listed.spaces||[]).filter(space=>space.owner===true&&space.spaceLifecycle==='active');
        await refresh(token);await readSpace(state.spaceId,token);
      }catch(error){if(current(token)&&error.name!=='AbortError'){if(['scene_version_conflict','version_conflict'].includes(error.code||error.data?.error))management=null;state.worldStatus=errorCopy(error);}}
      if(current(token)){state.loading=false;draw();}
    },
    destroy
  };
}
