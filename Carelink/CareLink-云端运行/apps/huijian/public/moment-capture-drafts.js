const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const modes=['perspective-video','panoramic-video','panoramic-images'];
export const captureApiMode=mode=>({'perspective-video':'perspective_video','panoramic-video':'equirectangular_video','panoramic-images':'equirectangular_images'}[mode]);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const uuid=()=>crypto.randomUUID();
const copyError=error=>({account_changed:'账号已变化，请回到原账号继续。',capture_target_stale:'空间的现场版本已变化。原记录保留，另存一份草稿后重新选择空间。',capture_upload_not_configured:'当前采集上传未开放，原片继续保留在本机。',capture_budget_exhausted:'当前原片存储预算不足，原片仍保留在本机，请稍后核对。',capture_cancelled:'这次上传已取消，本机原片仍保留。',capture_target_changed:'空间的现场版本已变化。原记录保留，另存一份草稿后重新选择空间。',scene_version_conflict:'现场版本已变化，请重新选择空间并核对。',version_conflict:'空间版本已变化，请重新选择并核对。',capture_upload_disabled:'当前采集上传未开放，原片继续保留在本机。',scene_worker_contract_pending:'真实训练尚未开放，上传不会进入排队或训练。',capture_expired:'这次上传已过期，原片仍保留，请另存草稿后重新选择空间。',capture_upload_paused:'已暂停本页后续发送。已收到的分片会在续传时核对；也可以取消本次上传并保留本机原片。',capture_receipt_invalid:'服务器回执与这份原片不一致，已暂停上传，请保留记录核对。',capture_limits_invalid:'当前上传限制无法核对，请稍后重新读取服务状态。',capture_input_invalid:'素材不符合当前采集格式或限制，请按页面说明核对。',capture_save_failed:'本机保存失败。原片仍在本页恢复记录中，请保留原文件并重试保存。'}[error?.code||error?.data?.error]||'暂时没有完成。原片和已确认的回执继续保留，请稍后核对后重试。');
export function captureMode(value){return modes.includes(value)?value:value==='panoramic'?'panoramic-video':'perspective-video';}
export function captureFileIssues(mode,files){
  const issues=[];if(!files.length)return ['请先选择采集素材。'];
  if(mode==='panoramic-images'){
    if(files.length<2)issues.push('多位置全景需要至少两张照片；单张全景请使用全景照片入口。');
    if(files.some(file=>file.width&&file.height&&file.width!==file.height*2))issues.push('部分照片不是 2:1 全景，请核对相机导出的原片。');
  }else{
    if(files.length!==1)issues.push('这份草稿保留一个连续视频；其他采集可另建草稿。');
    if(mode==='panoramic-video'&&files.some(file=>file.width&&file.height&&file.width!==file.height*2))issues.push('全景视频应先由相机软件导出为 2:1 等距柱状全景。');
  }
  if(files.some(file=>file.metadataUnavailable))issues.push('浏览器无法读取部分原片的信息，素材仍可保留；训练兼容性尚未验证。');
  return issues;
}
export function captureCapability(raw){
  const limits=raw?.limits;
  const verified=raw?.schema==='unseen-capture-capabilities/1'&&raw.mode==='local-only'&&raw.uploadAvailable===true&&raw.processingAvailable===false&&raw.registrationAvailable===false&&modes.every(mode=>raw.supportedInputModes?.includes(captureApiMode(mode)))&&limits&&['chunkBytes','maxCaptureBytes','maxAccountBytes','storageBudgetBytes','maxFiles','maxVideoSeconds'].every(key=>positive(limits[key]))&&limits.chunkBytes<=512*1024;
  return {uploadAvailable:Boolean(verified),processingAvailable:false,limits:verified?limits:null,reason:raw?.reason||'capability_unavailable'};
}
export function captureUploadIssues(item,capability){
  if(!capability.uploadAvailable)return ['当前采集上传未开放，原片可以保存到本机。'];
  const limits=capability.limits,files=item.files||[],issues=captureFileIssues(item.mode,files);
  if(!item.title?.trim())issues.push('请为这份采集填写名称。');
  if(files.length>limits.maxFiles)issues.push(`本次最多 ${limits.maxFiles} 份原片。`);
  if(files.reduce((sum,file)=>sum+(file.blob?.size||file.bytes||0),0)>limits.maxCaptureBytes)issues.push('原片总量超出当前采集上传预算。');
  for(const file of files){
    if(!file.name||file.name.length>200||/[\u0000-\u001f\u007f]/.test(file.name))issues.push('原文件名过长或含控制字符，请保留原片并修改文件名后重选。');
    if(!file.blob?.size||!positive(file.width)||!positive(file.height)||file.width>32768||file.height>32768||file.metadataUnavailable)issues.push('上传前需要读到每份原片的真实尺寸与格式。');
    if(item.mode==='panoramic-images'){
      if(!/^image\/(jpeg|png)$/.test(file.blob?.type||''))issues.push('当前采集适配器仅接收 JPEG 或 PNG 全景原片；其他格式继续保留在本机，不会自动转换。');
    }else{
      if(!/^video\/(mp4|quicktime|webm)$/.test(file.blob?.type||'')||!Number.isFinite(file.durationSeconds)||file.durationSeconds<=0)issues.push('当前视频格式或时长不能核对，请保留原片。');
      if(file.durationSeconds>limits.maxVideoSeconds)issues.push(`视频超过当前服务限制 ${limits.maxVideoSeconds} 秒。`);
    }
  }
  return [...new Set(issues)];
}

// Incremental SHA-256 avoids loading a whole original video into memory. Read
// fixed slices; neither hashing nor transport changes the source bytes.
const shaK=new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
export async function captureDigest(blob,{signal,check=()=>{},onProgress=()=>{}}={}){
  const h=new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]),w=new Uint32Array(64);let tail=new Uint8Array();
  const rotate=(n,b)=>(n>>>b)|(n<<(32-b));
  const block=(bytes,offset)=>{
    const view=new DataView(bytes.buffer,bytes.byteOffset+offset,64);for(let i=0;i<16;i++)w[i]=view.getUint32(i*4);
    for(let i=16;i<64;i++){const a=w[i-15],b=w[i-2];w[i]=(w[i-16]+(rotate(a,7)^rotate(a,18)^(a>>>3))+w[i-7]+(rotate(b,17)^rotate(b,19)^(b>>>10)))>>>0;}
    let [a,b,c,d,e,f,g,z]=h;for(let i=0;i<64;i++){const t1=(z+(rotate(e,6)^rotate(e,11)^rotate(e,25))+((e&f)^(~e&g))+shaK[i]+w[i])>>>0,t2=((rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&b)^(a&c)^(b&c)))>>>0;z=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}
    for(const [i,value]of [a,b,c,d,e,f,g,z].entries())h[i]=(h[i]+value)>>>0;
  };
  const guard=()=>{signal?.throwIfAborted();check();};
  for(let offset=0;offset<blob.size;offset+=1048576){guard();const bytes=new Uint8Array(await blob.slice(offset,offset+1048576).arrayBuffer());guard();const combined=new Uint8Array(tail.length+bytes.length);combined.set(tail);combined.set(bytes,tail.length);const full=combined.length-combined.length%64;for(let i=0;i<full;i+=64)block(combined,i);tail=combined.slice(full);onProgress(Math.min(blob.size,offset+bytes.length),blob.size);}
  guard();const padded=new Uint8Array(tail.length<56?64:128);padded.set(tail);padded[tail.length]=128;const length=new DataView(padded.buffer);length.setUint32(padded.length-8,Math.floor(blob.size/0x20000000));length.setUint32(padded.length-4,(blob.size*8)>>>0);for(let i=0;i<padded.length;i+=64)block(padded,i);return [...h].map(value=>value.toString(16).padStart(8,'0')).join('');
}
const base64=bytes=>{let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text);};
export async function inspectCaptureFile(file,image,{signal}={}){
  const url=URL.createObjectURL(file),media=document.createElement(image?'img':'video');let timer,abort;
  try{return await new Promise(resolve=>{
    const finish=value=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);media.onloadedmetadata=media.onerror=null;resolve(value);};
    abort=()=>finish({metadataUnavailable:true});if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(abort,8000);
    if(image){media.src=url;media.decode().then(()=>finish({width:media.naturalWidth,height:media.naturalHeight}),abort);}
    else{media.preload='metadata';media.onloadedmetadata=()=>finish({width:media.videoWidth,height:media.videoHeight,durationSeconds:Number.isFinite(media.duration)?media.duration:null});media.onerror=abort;media.src=url;}
  });}catch{return {metadataUnavailable:true};}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);media.removeAttribute('src');if(!image)media.load();URL.revokeObjectURL(url);}
}
const newDraft=(accountId,source={})=>({id:'capture-'+uuid(),kind:'capture',accountId,createdAt:new Date().toISOString(),mode:captureMode(source.mode),spaceId:source.spaceId||null,title:source.title||'',files:structuredClone(source.files||[]),consent:false,state:'draft',localRevision:0,...(source.id?{sourceDraftId:source.id}:{})});
export function createMomentCaptureDrafts({drafts,user,guest,navigate,api,login=()=>{}}){
  let uploading=false,pauseRequested=false;
  let root,epoch=0,control,dispose=()=>{},active=null,busy=false,status='',rows=[],remoteRows=[],capability=captureCapability(null),spaces=[],management=null,tasks=false,loaded=false,leaveRoute=null,saveTimer;
  const recovery=new Map(),writes=new Map();
  const owner=()=>guest()?'guest':user()?.id;
  const valid=(token,who)=>epoch===token&&!control?.signal.aborted&&owner()===who;
  const check=(token,who)=>{if(!valid(token,who))throw new DOMException('Account or page changed','AbortError');};
  const warnUnload=event=>{if(recovery.size){event.preventDefault();event.returnValue='';}};
  const updateWarning=()=>{window.removeEventListener('beforeunload',warnUnload);if(recovery.size)window.addEventListener('beforeunload',warnUnload);};
  function remember(item){item.localRevision=(item.localRevision||0)+1;item.updatedAt=new Date().toISOString();recovery.set(item.id,item);updateWarning();}
  async function saveItem(item){
    const snapshot=structuredClone(item),revision=item.localRevision;const previous=writes.get(item.id)||Promise.resolve();
    const job=previous.catch(()=>{}).then(()=>drafts('put',snapshot));writes.set(item.id,job);
    try{await job;if(root&&active===item&&item.accountId===owner()&&!tasks&&!control?.signal.aborted)history.replaceState(history.state,'','/app#capture-space?draft='+encodeURIComponent(item.id));if(recovery.get(item.id)?.localRevision===revision)recovery.delete(item.id);updateWarning();}
    catch{recovery.set(item.id,recovery.get(item.id)||item);updateWarning();throw {code:'capture_save_failed'};}
    finally{if(writes.get(item.id)===job)writes.delete(item.id);}
  }
  const request=async(path,options={},token=epoch,who=owner())=>{check(token,who);if(!api)throw {code:'capture_upload_disabled'};const result=await api.request(path,{...options,accountId:path==='/v1/capture-capabilities'?null:who,signal:AbortSignal.any([control.signal,AbortSignal.timeout(90000)])});check(token,who);return result;};
  const refreshRows=async(token,who)=>{let saved=[];try{saved=await drafts('getAll');}catch{status='本机数据库暂时不可读，本页未保存的恢复记录仍保留。';}check(token,who);rows=[...new Map([...saved,...recovery.values()].filter(row=>row.kind==='capture'&&(row.accountId===who||row.accountId==='guest')).map(row=>[row.id,row])).values()];};
  const feedback=text=>{status=text;const el=root?.querySelector('[data-capture-status]');if(el)el.textContent=text;const button=root?.querySelector('[data-capture-action="upload"]');if(button&&active&&!active.uploadAttempt&&!active.capture)button.disabled=busy||captureUploadIssues(active,capability).length>0||!management;};
  const lock=value=>{busy=value;root?.querySelectorAll('input,button,select').forEach(node=>{if(node.dataset.captureAction==='pause'){node.disabled=!uploading;node.hidden=!uploading;}else node.disabled=value;});};
  const own=()=>active&&active.accountId===owner();
  function editable(){if(!own())throw {code:'account_changed'};if(loaded||active.uploadAttempt||active.capture){active=newDraft(owner(),active);loaded=false;remember(active);}return active;}
  function localChanged(){const item=editable();remember(item);clearTimeout(saveTimer);const token=epoch,who=owner();saveTimer=setTimeout(()=>{saveItem(item).then(()=>{if(valid(token,who))feedback('修改已保存在本机，未上传。');}).catch(error=>{if(valid(token,who))feedback(copyError(error));});},350);}
  async function readTarget(id,token,who){management=null;if(!id)return;const result=await request('/v1/spaces/'+encodeURIComponent(id)+'/management',{},token,who);if(result.space?.spaceId!==id||result.space.owner!==true||!positive(result.space.version)||!positive(result.sceneVersion))throw {code:'capture_target_changed'};if(active?.spaceId===id)management=result;}
  async function refreshCapability(token,who){
    const raw=await request('/v1/capture-capabilities',{},token,who);capability=captureCapability(raw);
    if(who!=='guest'){
      if(tasks){const result=await request('/v1/me/captures',{},token,who);remoteRows=(result.captures||[]).filter(row=>row.accountId===who);}
      if(capability.uploadAvailable){const listed=await request('/v1/me/spaces',{},token,who);spaces=(listed.spaces||[]).filter(space=>space.owner===true&&space.spaceLifecycle==='active');if(active?.spaceId&&!active.capture)await readTarget(active.spaceId,token,who);}
    }
  }
  const remoteDraft=receipt=>({id:'capture-remote-'+receipt.captureId,kind:'capture',accountId:receipt.accountId,title:receipt.title,mode:modes.find(mode=>captureApiMode(mode)===receipt.inputMode),spaceId:receipt.spaceId,files:receipt.files.map(file=>({id:file.clientFileId,name:file.name,bytes:file.bytes,sha256:file.sha256,width:file.width,height:file.height,durationSeconds:file.durationSeconds,blob:null})),state:'draft',localRevision:0,capture:receipt,uploadAttempt:{spaceId:receipt.spaceId,spaceVersion:receipt.spaceVersion,body:{sceneIfMatchVersion:receipt.sceneVersion}}});
  const taskCard=(item,guestCopy=false)=>`<article class="spatial-task"><h2>${esc(item.title||'未命名采集')}</h2><p>${item.files?.length||0} 份原片 · ${recovery.has(item.id)?'尚未存好 · 本页恢复记录':guestCopy?'这个浏览器的访客草稿':item.files?.some(file=>!file.blob)?'本机只保留回执，原片需重选':'本机原片已保留'}${item.capture?' · '+(item.capture.status==='uploaded'?'原片已上传，训练未开放':item.capture.status==='cancelled'?'上传已取消':'上传可核对恢复'):''}</p><button class="secondary" data-capture-open="${esc(item.id)}">${guestCopy?'查看并选择是否复制到账号':'继续整理'}</button></article>`;
  function uploadHtml(){
    if(!active||!own())return '';
    const receipt=active.capture,hasOriginals=active.files.every(file=>file.blob);
    if(receipt)return `<section class="glass spatial-article"><h2>原片上传记录</h2><p>编号：${esc(receipt.captureId)}</p><p>${receipt.status==='uploaded'?'原片已经完整上传，真实训练尚未开放。':receipt.status==='cancelled'?(hasOriginals?'本次上传已取消，本机原片仍保留。':'本次上传已取消。当前设备没有原片副本。'):'已收到的分片会先核对，再继续缺失部分。'}${receipt.targetCurrent===false?' 空间版本已经变化，这份采集保留原版本绑定，不能继续上传。':''}</p>${active.files.some(file=>!file.blob)?'<p>当前设备没有这份采集的原片。续传前请重新选择全部原文件，逐份核对原字节哈希；不会用显示副本替代。</p>':''}<button type="button" class="secondary" data-capture-action="reconcile">核对服务端记录</button>${!hasOriginals&&receipt.status!=='cancelled'?'<label class="spatial-consent"><input type="checkbox" data-capture-cancel-consent>当前设备没有原片副本；我确认移除服务器原片，之后不能在这里找回。</label>':''}${receipt.status==='uploaded'?`<button type="button" class="text-button" data-capture-action="cancel">${hasOriginals?'移除服务器原片，保留本机原片':'确认移除服务器原片'}</button>`:''}${receipt.status==='uploading'?'<button type="button" class="primary" data-capture-action="upload">核对并继续上传</button><button type="button" class="text-button" data-capture-action="cancel">取消这次上传</button>':''}<button type="button" class="secondary" data-capture-action="fork">另存一份草稿</button><p>上传完成不等于进入队列、完成训练或已有可查看模型。</p></section>`;
    if(active.uploadAttempt)return '<section class="glass spatial-article"><h2>创建上传的结果待核对</h2><p>保留同一请求和原片。核对不会更换请求编号，也不会开始训练。</p><button type="button" class="primary" data-capture-action="upload">核对原请求并继续</button></section>';
    if(!capability.uploadAvailable)return `<section class="glass spatial-article"><h2>采集上传尚未开放</h2><p>${capability.reason==='capability_unavailable'?'服务能力暂时无法读取。':'当前服务没有开放采集上传与真实训练。'}原片继续保存在这台设备，不会进入假队列。</p><button type="button" class="secondary" data-capture-action="capability">重新读取服务状态</button></section>`;
    if(owner()==='guest')return '<section class="glass spatial-article"><p>上传采集需要账号。登录后，这份访客草稿仍需你明确选择复制，才属于该账号。</p><button type="button" class="secondary" data-capture-action="login">登录账号</button></section>';
    const limits=capability.limits,issues=captureUploadIssues(active,capability);
    return `<section class="glass spatial-article"><h2>保存原片到账号空间</h2><p>这里只接收原片。当前真实训练未开放，上传后不会排队或计费训练。</p><p>当前限制：每份采集最多 ${(limits.maxCaptureBytes/1048576).toFixed(1)} MB、${limits.maxFiles} 份文件；视频最多 ${limits.maxVideoSeconds} 秒。不会缩小或压缩原片。</p><label class="field">我的空间<select data-capture-space><option value="">请选择</option>${spaces.map(space=>`<option value="${esc(space.spaceId)}" ${active.spaceId===space.spaceId?'selected':''}>${esc(space.name)}</option>`).join('')}</select></label><button type="button" class="secondary" data-capture-action="target">重新读取空间版本</button><button type="button" class="secondary" data-capture-action="create-space">创建空间</button>${management?`<p>将保存到 ${esc(management.space.name)}，绑定当前现场版本 ${management.sceneVersion}。</p>`:'<p>尚未核对目标空间与现场版本。</p>'}<ul>${issues.map(issue=>`<li>${esc(issue)}</li>`).join('')}</ul><label class="spatial-consent"><input type="checkbox" data-capture-upload-consent>只将列出的原片上传到这个账号空间，当前不进行训练。</label><button type="button" class="primary" data-capture-action="upload" ${issues.length||!management?'disabled':''}>确认上传原片</button></section>`;
  }
  function render(){
    if(!root)return;
    const who=owner();
    if(tasks){const mine=rows.filter(item=>item.accountId===who),guests=who==='guest'?[]:rows.filter(item=>item.accountId==='guest'),known=new Set(mine.map(item=>item.capture?.captureId)),remote=remoteRows.filter(row=>!known.has(row.captureId));root.innerHTML=`<header class="spatial-heading nav"><button class="ib" data-spatial-route="spaces" aria-label="返回">←</button><h1>采集草稿</h1></header><p class="empty-note">本机草稿按账号区分。真实训练尚未开放，上传记录也不代表训练任务。</p><p role="status" data-capture-status>${esc(status)}</p>${mine.map(item=>taskCard(item)).join('')||'<p class="empty-note">当前账号还没有采集草稿。</p>'}${remote.length?`<section><h2>账号里的原片上传记录</h2><p>服务器记录可跨设备找回；当前设备未保留的原片需要重新选择，才可续传。</p>${remote.map(receipt=>`<article class="spatial-task"><h2>${esc(receipt.title)}</h2><p>${receipt.status==='uploaded'?'原片已上传，训练尚未开放':receipt.status==='cancelled'?'上传已取消':'原片上传可核对恢复'}</p><button class="secondary" data-capture-remote="${esc(receipt.captureId)}">查看上传记录</button></article>`).join('')}</section>`:''}${guests.length?`<details><summary>这个浏览器的访客草稿（${guests.length}）</summary><p>只有明确复制后，素材才归入当前账号，访客原稿仍保留。</p>${guests.map(item=>taskCard(item,true)).join('')}</details>`:''}`;return;}
    if(!active){root.innerHTML='<p class="inline-error">这份草稿不在当前设备或账号，请从原账号打开。</p>';return;}
    if(!own()){root.innerHTML=`<header class="spatial-heading nav"><h1>访客原片</h1></header><p>这是这个浏览器的访客草稿，尚未归入当前账号。原片不会自动上传或改变归属。</p>${taskCard(active,true)}<button class="primary" data-capture-action="claim">复制原片到当前账号</button><button class="secondary" data-spatial-route="capture-tasks">返回草稿列表</button><p role="status" data-capture-status>${esc(status)}</p>`;return;}
    const panoramic=active.mode!=='perspective-video',images=active.mode==='panoramic-images';
    root.innerHTML=`<header class="spatial-heading nav"><button class="ib" data-spatial-route="${active.spaceId?'shared-space/'+esc(active.spaceId):'new-space'}" aria-label="返回">←</button><h1>${panoramic?'全景相机采集':'手机视频采集'}</h1></header><p class="spatial-notice">选择后先保存一份本机恢复草稿。当前真实训练尚未接通，保存与上传原片都不会开始训练或付费。</p><section class="glass spatial-article"><p>在同一处空间缓慢移动，保持相邻画面重叠、光线与镜头稳定；补拍家具背后和遮挡处。原地转一圈不能替代移动采集。</p>${panoramic?'<p>全景相机先导出 2:1 原片。多张全景应在不同位置拍摄，保留相邻位置的重叠。</p>':''}</section>${panoramic?`<div class="spatial-filters"><button class="secondary" data-capture-mode="panoramic-video">移动全景视频</button><button class="secondary" data-capture-mode="panoramic-images">多位置全景照片</button></div>`:''}<form data-capture-form><label class="field">采集名称<input name="title" maxlength="120" value="${esc(active.title)}"></label><label class="field">选择${images?'原始全景照片':'原始视频'}<input type="file" data-capture-files ${images?'multiple accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"':'accept="video/mp4,video/quicktime,video/webm,.mov,.mp4,.webm"'}></label><p>保留原始字节，不压缩成相册投稿视频。浏览器读到信息不等于已经可以重建。</p><div>${active.files.map(file=>`<article class="spatial-task"><strong>${esc(file.name)}</strong><p>${((file.blob?.size||file.bytes||0)/1048576).toFixed(1)} MB${file.width?' · '+file.width+'×'+file.height:''}${file.durationSeconds?' · '+Math.round(file.durationSeconds)+' 秒':''}</p></article>`).join('')}</div><ul>${captureFileIssues(active.mode,active.files).map(issue=>`<li>${esc(issue)}</li>`).join('')}</ul><p>清晰度、覆盖和机位估计检查尚未执行。</p><label class="spatial-consent"><input type="checkbox" name="consent" ${active.consent?'checked':''}>我有权使用这些素材；上传前另行确认范围。</label><button class="primary" type="submit">保存采集草稿</button><button class="secondary" type="button" data-capture-action="inspect">重新读取原片信息</button><button class="secondary" type="button" data-spatial-route="capture-tasks">查看本机采集</button><p role="status" data-capture-status>${esc(status|| (recovery.has(active.id)?'尚未存好，原片保留在本页恢复记录。':active.files.some(file=>!file.blob)?'本机只有上传回执，续传需要重新选择原片。':'本机原片已保留，尚未训练。'))}</p>${leaveRoute?'<button type="button" class="text-button" data-capture-action="leave">保留本页恢复记录并离开</button>':''}${uploadHtml()}<button type="button" class="secondary" data-capture-action="pause" ${uploading?'':'disabled hidden'}>暂停本页上传</button></form>`;
    root.querySelectorAll('input,button,select').forEach(node=>{if(busy)node.disabled=node.dataset.captureAction!=='pause'||!uploading;});
  }
  function receiptFor(item,result){
    const invalid=()=>{throw {code:'capture_receipt_invalid'};},hex=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
    if(result?.schema!=='unseen-capture/1'||result.accountId!==item.accountId||result.spaceId!==item.uploadAttempt?.spaceId||result.inputMode!==captureApiMode(item.mode)||!result.captureId||item.capture&&item.capture.captureId!==result.captureId||!['uploading','uploaded','cancelled'].includes(result.status)||!positive(result.chunkBytes)||result.chunkBytes>512*1024||!Array.isArray(result.files)||result.files.length!==item.files.length||result.spaceVersion!==item.uploadAttempt.spaceVersion||result.sceneVersion!==item.uploadAttempt.body.sceneIfMatchVersion)invalid();
    const ids=new Set();
    for(const local of item.files){
      const remote=result.files.find(file=>file.clientFileId===local.id);
      if(!remote||remote.sha256!==local.sha256||remote.bytes!==(local.blob?.size||local.bytes)||!remote.fileId||ids.has(remote.fileId)||remote.chunkCount!==Math.ceil((local.blob?.size||local.bytes)/result.chunkBytes)||!['uploading','uploaded'].includes(remote.status)||!Array.isArray(remote.receivedChunks))invalid();
      ids.add(remote.fileId);const indexes=new Set();
      for(const chunk of remote.receivedChunks){if(!Number.isSafeInteger(chunk.index)||chunk.index<0||chunk.index>=remote.chunkCount||indexes.has(chunk.index)||chunk.bytes!==Math.min(result.chunkBytes,(local.blob?.size||local.bytes)-chunk.index*result.chunkBytes)||!hex(chunk.sha256))invalid();indexes.add(chunk.index);}
      if(result.status!=='cancelled'&&remote.status==='uploaded'&&indexes.size!==remote.chunkCount)invalid();
    }
    if(result.status==='uploaded'&&(!hex(result.manifestSha256)||result.files.some(file=>file.status!=='uploaded')))invalid();
    return result;
  }
  async function saveReceipt(item,result){item.capture=receiptFor(item,result);remember(item);await saveItem(item);}
  async function reconcile(item,token,who){const result=await request('/v1/captures/'+encodeURIComponent(item.capture.captureId),{},token,who);await saveReceipt(item,result);check(token,who);return result;}
  async function upload(token,who){
    const uploadingCheck=()=>{check(token,who);if(pauseRequested)throw {code:'capture_upload_paused'};};
    if(!own()||who==='guest')return;
    let item=active;
    if(item.files.some(file=>!file.blob)){feedback('续传前请重新选择全部原片。会逐份核对原字节，不改变之前的请求或文件绑定。');return;}
    if(!item.capture&&!item.uploadAttempt){
      if(!root.querySelector('[data-capture-upload-consent]')?.checked||!management)return;
      if(captureUploadIssues(item,capability).length)throw {code:'capture_input_invalid'};
      item=editable();await saveItem(item);check(token,who);
      const target={spaceId:management.space.spaceId,spaceVersion:management.space.version,sceneVersion:management.sceneVersion};
      for(const file of item.files){feedback('正在核验原片：'+file.name);file.sha256=await captureDigest(file.blob,{signal:control.signal,check:uploadingCheck});}
      check(token,who);item.uploadAttempt={key:uuid(),spaceId:target.spaceId,spaceVersion:target.spaceVersion,body:{inputMode:captureApiMode(item.mode),title:item.title.trim(),sceneIfMatchVersion:target.sceneVersion,files:item.files.map(file=>({clientFileId:file.id,name:file.name,mimeType:file.blob.type,bytes:file.blob.size,sha256:file.sha256,width:file.width,height:file.height,durationSeconds:file.durationSeconds??null}))}};remember(item);await saveItem(item);check(token,who);
    }
    uploadingCheck();if(!item.capture){const attempt=item.uploadAttempt;await saveReceipt(item,await request('/v1/spaces/'+encodeURIComponent(attempt.spaceId)+'/captures',{method:'POST',version:attempt.spaceVersion,key:attempt.key,body:attempt.body},token,who));check(token,who);}
    uploadingCheck();let receipt=await reconcile(item,token,who);
    if(receipt.status==='uploaded'){feedback('原片已上传完成，真实训练尚未开放。');return;}
    if(receipt.status==='cancelled')throw {code:'capture_expired'};
    if(receipt.targetCurrent===false)throw {code:'capture_target_changed'};
    for(const file of item.files){
      if(await captureDigest(file.blob,{signal:control.signal,check:uploadingCheck})!==file.sha256)throw {code:'capture_receipt_invalid'};
      let remote=receipt.files.find(row=>row.clientFileId===file.id);if(remote.status==='uploaded')continue;
      const base='/v1/captures/'+encodeURIComponent(receipt.captureId)+'/files/'+encodeURIComponent(remote.fileId);
      for(let index=0;index<remote.chunkCount;index++){
        uploadingCheck();const piece=file.blob.slice(index*receipt.chunkBytes,Math.min(file.blob.size,(index+1)*receipt.chunkBytes)),bytes=new Uint8Array(await piece.arrayBuffer());check(token,who);const sha256=await captureDigest(piece,{signal:control.signal,check:uploadingCheck}),existing=remote.receivedChunks?.find(chunk=>chunk.index===index);
        if(existing){if(existing.bytes!==bytes.length||existing.sha256!==sha256)throw {code:'capture_receipt_invalid'};continue;}
        uploadingCheck();const result=await request(base+'/chunks/'+index,{method:'PUT',body:{dataBase64:base64(bytes),sha256}},token,who);
        const confirmed=result?.fileId?result:result?.file;
        if(confirmed?.fileId!==remote.fileId||!confirmed.receivedChunks?.some(chunk=>chunk.index===index&&chunk.bytes===bytes.length&&chunk.sha256===sha256))throw {code:'capture_receipt_invalid'};
        remote=confirmed;feedback(file.name+'：已确认 '+remote.receivedChunks.length+' / '+remote.chunkCount+' 个分片');
      }
      uploadingCheck();await request(base+'/commits',{method:'POST',body:{}},token,who);receipt=await reconcile(item,token,who);
    }
    uploadingCheck();await request('/v1/captures/'+encodeURIComponent(receipt.captureId)+'/commits',{method:'POST',body:{}},token,who);receipt=await reconcile(item,token,who);if(receipt.status!=='uploaded')throw {code:'capture_receipt_invalid'};feedback('原片已完整上传。训练尚未开放，没有创建排队任务。');
  }
  async function run(work,token,who){if(!valid(token,who)||busy)return;lock(true);try{await work();}catch(error){if(valid(token,who)&&error.name!=='AbortError')status=copyError(error);}finally{if(valid(token,who)){busy=false;render();}}}
  async function mount(target,route){
    destroy();root=target;control=new AbortController();const token=++epoch,who=owner();status='';busy=false;uploading=false;pauseRequested=false;active=null;loaded=false;remoteRows=[];tasks=route.startsWith('capture-tasks');capability=captureCapability(null);spaces=[];management=null;leaveRoute=null;
    await refreshRows(token,who);check(token,who);const query=new URLSearchParams(route.split('?')[1]||''),id=query.get('draft');
    if(!tasks){active=id?rows.find(row=>row.id===id):newDraft(who,{mode:captureMode(query.get('mode')),spaceId:query.get('spaceId')});loaded=Boolean(id&&!recovery.has(id));}
    const action=async event=>{
      const button=event.target.closest('button');if(!button||button.disabled||!valid(token,who))return;
      if(button.dataset.captureRemote){await run(async()=>{const receipt=remoteRows.find(row=>row.captureId===button.dataset.captureRemote);if(!receipt||receipt.accountId!==who)return;active=remoteDraft(receipt);receiptFor(active,receipt);tasks=false;loaded=false;remember(active);await saveItem(active);check(token,who);history.replaceState(history.state,'','/app#capture-space?draft='+encodeURIComponent(active.id));status='已恢复账号上传记录。当前设备的原片需要重新选择并核对。';},token,who);return;}
      if(button.dataset.captureOpen)return navigate('capture-space?draft='+encodeURIComponent(button.dataset.captureOpen));
      if(button.dataset.captureMode){await run(async()=>{if(!own())return;if(active.files.length){status='请保留当前原片，从创建入口另开另一种采集。';return;}const item=editable();item.mode=captureMode(button.dataset.captureMode);remember(item);await saveItem(item);},token,who);return;}
      const kind=button.dataset.captureAction;if(!kind)return;
      if(kind==='pause'){pauseRequested=true;button.disabled=true;feedback('正在等待当前请求返回；随后暂停发送。已收到的原片分片会保留。');return;}
      if(kind==='login')return login('spatial');if(kind==='create-space')return navigate('new-space');
      if(kind==='leave'){const next=leaveRoute;leaveRoute=null;if(next)navigate(next);return;}
      await run(async()=>{
        if(kind==='claim'){if(!active||active.accountId!=='guest'||who==='guest')return;active=newDraft(who,{...active,spaceId:null});loaded=false;remember(active);await saveItem(active);check(token,who);history.replaceState(history.state,'','/app#capture-space?draft='+encodeURIComponent(active.id));status='原片已复制到当前账号的本机草稿。访客原稿仍保留，尚未上传。';}
        if(kind==='fork'){if(!own())return;active=newDraft(who,active);loaded=false;remember(active);await saveItem(active);management=null;status='已另存为新草稿。原片与之前的上传记录仍保留。';}
        if(kind==='inspect'){if(!own())return;if(active.files.some(file=>!file.blob)){status='请先重新选择全部原片，再读取信息。';return;}const item=editable();for(const file of item.files){Object.assign(file,await inspectCaptureFile(file.blob,item.mode==='panoramic-images',{signal:control.signal}));check(token,who);if(file.width&&file.height)file.metadataUnavailable=false;}remember(item);await saveItem(item);status='已重新读取原片信息，未上传或训练。';}
        if(kind==='target'){await readTarget(active.spaceId,token,who);status='已读取最新空间与现场版本，请重新确认。';}
        if(kind==='capability'){await refreshCapability(token,who);status=capability.uploadAvailable?'已读取当前原片上传限制。真实训练仍未开放。':'当前采集上传仍未开放，本机原片继续保留。';}
        if(kind==='upload'){uploading=true;pauseRequested=false;lock(true);try{await upload(token,who);}finally{if(valid(token,who)){uploading=false;pauseRequested=false;}}}
        if(kind==='reconcile'&&active.capture){await reconcile(active,token,who);status=active.capture.status==='uploaded'?'原片已完整上传，真实训练尚未开放。':'已读到实际服务端状态。';}
        if(kind==='cancel'&&active.capture){const item=active;if(item.files.some(file=>!file.blob)&&!root.querySelector('[data-capture-cancel-consent]')?.checked){status='当前设备没有原片副本。请先确认是否移除服务器原片。';return;}await saveReceipt(item,await request('/v1/captures/'+encodeURIComponent(item.capture.captureId)+'/cancellations',{method:'POST',body:{}},token,who));status=item.files.every(file=>file.blob)?'本次上传已取消，本机原片仍保留。':'本次上传已取消；当前设备没有原片副本。';}
      },token,who);
    };
    const change=async event=>{
      if(!valid(token,who)||busy||!own())return;
      if(event.target.name==='title'){editable().title=event.target.value;localChanged();return;}
      if(event.target.name==='consent'){editable().consent=event.target.checked;localChanged();return;}
      if(event.target.matches('[data-capture-space]')){await run(async()=>{editable().spaceId=event.target.value;remember(active);await saveItem(active);check(token,who);await readTarget(active.spaceId,token,who);},token,who);return;}
      if(!event.target.matches('[data-capture-files]'))return;
      const files=[...event.target.files];if(!files.length)return;
      if(active.capture&&active.files.some(file=>!file.blob)){
        const item=active;
        await run(async()=>{
          if(files.length!==item.files.length)throw {code:'capture_input_invalid'};
          const remaining=[...item.files],matched=[];
          for(const file of files){const digest=await captureDigest(file,{signal:control.signal,check:()=>check(token,who)}),index=remaining.findIndex(original=>original.sha256===digest&&original.bytes===file.size&&original.name===file.name);if(index<0)throw {code:'capture_receipt_invalid'};matched.push({...remaining[index],blob:file});remaining.splice(index,1);}
          check(token,who);item.files=item.files.map(original=>matched.find(file=>file.id===original.id));remember(item);await saveItem(item);status='原字节与服务器登记一致。已保存到本机，可以明确继续上传。';
        },token,who);return;
      }
      // Keep bytes before the first asynchronous metadata read, even if the
      // user navigates away or the media decoder never returns.
      clearTimeout(saveTimer);if(active.files.length){const previous=active;active=newDraft(who,previous);loaded=false;remember(previous);saveItem(previous).catch(()=>{});}else editable();
      const item=active;item.files=files.map(file=>({id:uuid(),name:file.name,blob:file,metadataUnavailable:true}));remember(item);
      await run(async()=>{feedback('正在保存原片到本机…');await saveItem(item);check(token,who);for(const file of item.files){Object.assign(file,await inspectCaptureFile(file.blob,item.mode==='panoramic-images',{signal:control.signal}));check(token,who);if(file.width&&file.height)file.metadataUnavailable=false;}remember(item);await saveItem(item);check(token,who);history.replaceState(history.state,'','/app#capture-space?draft='+encodeURIComponent(item.id));status='原片已保存在本机恢复草稿，尚未上传或训练。';},token,who);
    };
    const submit=async event=>{if(!event.target.matches('[data-capture-form]'))return;event.preventDefault();await run(async()=>{if(!own())return;clearTimeout(saveTimer);const item=active;remember(item);await saveItem(item);check(token,who);history.replaceState(history.state,'','/app#capture-space?draft='+encodeURIComponent(item.id));status='原片与修改已保存在本机，真实训练尚未开始。';},token,who);};
    const leaving=event=>{if(!valid(token,who)||!active||!recovery.has(active.id))return;const button=event.target.closest?.('[data-spatial-route]');if(!button)return;const next=button.dataset.spatialRoute;event.preventDefault();event.stopImmediatePropagation();clearTimeout(saveTimer);const item=active;saveItem(item).then(()=>{if(valid(token,who))navigate(next);}).catch(error=>{if(valid(token,who)){leaveRoute=next;status=copyError(error);render();}});};
    root.addEventListener('click',action);root.addEventListener('input',change);root.addEventListener('change',change);root.addEventListener('submit',submit);window.addEventListener('click',leaving,true);
    const mounted=root;dispose=()=>{mounted.removeEventListener('click',action);mounted.removeEventListener('input',change);mounted.removeEventListener('change',change);mounted.removeEventListener('submit',submit);window.removeEventListener('click',leaving,true);};render();
    try{await refreshCapability(token,who);}catch{if(valid(token,who))status='服务能力暂时无法读取。原片仍可保存到本机，不会上传或训练。';}if(valid(token,who))render();
  }
  function destroy(){clearTimeout(saveTimer);if(active&&recovery.has(active.id))saveItem(active).catch(()=>{});epoch++;control?.abort();dispose();dispose=()=>{};root=null;active=null;}
  return {mount,destroy};
}
