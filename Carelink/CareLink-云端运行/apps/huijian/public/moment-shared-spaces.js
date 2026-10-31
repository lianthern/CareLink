import { mountSpacePhotoStory, openSpacePhotoStory } from './space-photo-story.js';
import {mountAppSpatial} from './unseen-app-spatial.js';
import {SharedUpload,sharedPhotoFile} from './moment-shared-upload.js';
import {photoStoryError} from './moment-photo-stories.js';
import {sharedWorldSceneOptions} from './moment-world-scene.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const id=encodeURIComponent,uuid=()=>crypto.randomUUID();
const labels={scene:'现场',photos:'照片',stories:'故事',upload:'上传照片',share:'分享与管理'};
const statusNames={processing:'正在建议位置',confirmed:'已回到现场',needs_confirmation:'位置待确认',failed:'处理失败',outside_scene:'保留在相册',stale:'现场已更新，位置待确认',committed:'原图已接收',selected:'等待上传',uploading:'正在上传',validating:'正在检查',pending:'待主人审核',visible:'可以查看',hidden:'暂不展示',rejected:'未通过审核',active:'有效',revoked:'已撤销',expired:'已到期',exhausted:'已达到进入次数上限',paused:'暂停'};
const label=value=>statusNames[value]||value||'等待处理';
export const sharedError=error=>({upload_unavailable:'收集已暂停，或这次邀请没有上传权限。',resource_unavailable:'这个入口没有查看权限，或邀请已经失效。',viewer_session_unavailable:'查看邀请已失效，请向空间主人索取新的邀请。',contributor_session_unavailable:'上传邀请已失效，请向空间主人索取新的邀请。',campaign_unavailable:'邀请已到期、撤销或暂停，请联系空间主人。',campaign_preview_unavailable:'邀请现在无法打开，请向空间主人确认。',invite_unavailable:'邀请现在无法打开，请向空间主人确认。',session_unavailable:'请登录原账号后继续。',account_changed:'账号已切换，请回到原账号继续。',version_conflict:'内容刚刚有更新。请刷新后再操作。',upload_photo_policy:'照片格式或大小不符合当前空间要求，请按页面限制重新选择。',upload_selection_invalid:'请选择本批允许数量内的照片。',upload_original_file_required:'请重新选择这张原照片，已上传成功的照片不会重传。',upload_original_file_mismatch:'这不是原来选择的文件，请选择同一张原照片。',upload_pending_batch:'请先完成当前这批照片。',upload_object_failed:'网络上传未完成，可以只重试这一张。',upload_ticket_expired:'上传授权已过期，请更新状态后再试。',upload_items_not_finished:'还有照片没有完成，请只重试失败项。',upload_recovery_storage_unavailable:'浏览器无法保留上传进度，请允许本机存储后重试。',receipt_recovery_required:'原图已接收，但回执凭证需要重新核对。请保留页面并联系空间主人。',receipt_unavailable:'回执暂时不可读取，请更新状态重试。',stale_revision:'现场已更新，请重新打开位置编辑器。',scene_unavailable:'这里还没有可查看的现场，可以先收集照片。',media_decode_rejected:'照片无法读取，请保留原文件并换一张受支持的照片。',upload_busy:'正在处理这批照片，请稍候。',network_error:'网络请求未完成，请重新选择原件后重试这一张。',upload_ticket_invalid:'上传授权暂时无法读取，请更新状态后重试。'}[error?.code]||'暂时没有完成，请检查连接后重试。');
const button=(action,text,extra='',kind='secondary')=>`<button type="button" class="${kind}" data-ms-action="${action}" ${extra}>${text}</button>`;
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(value);
export function sharedRoute(route){
 const [path,query='']=String(route).split('?'),p=new URLSearchParams(query),match=path.match(/^(shared-space|join)\/([A-Za-z0-9_-]{1,160})$/);
 if(!match)throw Object.assign(new Error('resource_unavailable'),{code:'resource_unavailable'});
 return {spaceId:match[1]==='shared-space'?match[2]:null,token:match[1]==='join'?match[2]:null,tab:labels[p.get('tab')]?p.get('tab'):'scene',photoId:validId(p.get('photo')||p.get('photoId'))?(p.get('photo')||p.get('photoId')):null};
}
export function sharedInvitationUrl(campaign,origin=location.origin){
 const url=new URL(campaign.publicCampaignUrl||campaign.qrPayload,origin),match=url.pathname.match(/^\/open\/([A-Za-z0-9_-]{20,160})$/);
 if(!match||url.hash||url.search)throw new Error('campaign_url_invalid');
 const entry=typeof location!=='undefined'&&/^\/app-v2\/?$/.test(location.pathname)?'/app-v2':'/app';
 return new URL(entry+'#join/'+match[1],origin).href;
}
function mediaUrl(value,{invitation=false,account=false}={}){
 if(typeof value!=='string'||!/^\/v1\/(?:viewer|photos)\//.test(value)||value.includes('..'))return '';
 const url=new URL(value,'https://local.invalid');if(invitation)url.searchParams.set('access','invitation');else if(account)url.searchParams.set('access','account');return url.pathname+url.search;
}
export function sharedSceneOptions(context,{invitation=false}={}){
 const world=sharedWorldSceneOptions(context,{invitation});if(world)return world;
 if(!context?.panorama?.url)return null;const panorama=mediaUrl(context.panorama.url,{invitation});if(!panorama)return null;
 const imported=context.depthImport,artifact=context.depthArtifact;
 const revision=context.scene?.panoramaRevisionId||context.panorama.revisionId;
 if(revision&&(context.panorama.revisionId&&context.panorama.revisionId!==revision||imported?.metadata?.sourcePanoramaRevisionId&&imported.metadata.sourcePanoramaRevisionId!==revision||artifact?.sourcePanoramaRevisionId&&artifact.sourcePanoramaRevisionId!==revision))throw {code:'stale_revision'};
 const depth=mediaUrl(imported?.url||artifact?.depthMap?.url,{invitation});
 const metadata=imported?.metadata||(artifact?{...artifact,sourcePanoramaSha256:context.panorama.sha256}:null);
 const source=metadata?.metadata||metadata;
  return {kind:depth&&metadata?'dap':'360',panorama,panoramaName:imported?.panoramaName||context.panorama.name||source?.source_image||source?.sourceImage||'',depth:depth||null,depthMetadata:metadata,
  initialYaw:context.placement?.yawDeg||0,initialPitch:context.placement?.pitchDeg??0,
  authenticity:depth&&metadata?'全景与深度来自同一现场版本 · 只支持有限探身':'真实全景 · 可环顾，不能走到照片没有拍到的位置'};
}
function canonicalRequest(api,{user,owner,invitation=false,signal,isCurrent=()=>true}){
 return async(path,options={})=>{
  const check=()=>{if(signal.aborted||!isCurrent()||user?.()?.id!==owner)throw new DOMException('账号或页面已变化','AbortError');};check();
  const timed=AbortSignal.timeout(120000),requestSignal=AbortSignal.any([signal,timed,...(options.signal?[options.signal]:[])]);
  const url=new URL(path,'https://local.invalid');if(invitation)url.searchParams.set('access','invitation');
  try{const data=await api.request(url.pathname+url.search,{...options,signal:requestSignal,accountId:invitation?null:owner});check();return data;}
  catch(error){check();if(invitation&&error?.code==='session_unavailable')throw Object.assign(new Error('invite_unavailable'),{code:'invite_unavailable'});throw error;}
 };
}
function uploadRows(upload){
 const state=upload?.state;if(!state)return '';
 return state.files.map((entry,index)=>{const item=upload.result?.items?.find(i=>(i.itemId||i.id)===entry.itemId),done=item?.status==='committed'||state.completed;
  return `<article class="ms-upload-item"><div><strong>${esc(entry.name)}</strong><p>${esc(done?'原图已接收':entry.error?sharedError({code:entry.error}):entry.phase||label(item?.status||'selected'))}${item?.photoContentState?' · '+esc(label(item.photoContentState)):''}</p></div>${done&&item?.photoId?button('leave-note','留一句 · 文字或语音',`data-photo="${esc(item.photoId)}" ${upload.busy?'disabled':''}`):''}${!done?`<label class="ms-reselect">重新选择原照片<input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" data-ms-reselect="${index}" ${upload.busy?'disabled':''}></label>${button('retry-item','重试这一张',`data-index="${index}" ${upload.busy?'disabled':''}`)}`:''}</article>`;
 }).join('');
}
function uploadPanel(upload,context,{privateSelection=false}={}){
 const s=upload?.state;if(s){const complete=s.completed;
  return `<section class="ms-panel"><h2>${complete?'这次照片已经留下':'本次上传'}</h2><p>${complete?'下方是实际收到的照片。':upload.busy?'正在逐项处理，成功的照片不会重复上传。':'本标签页只保留上传进度，不保存照片副本或访问凭证。刷新后未完成项可重选原件继续。'}</p><div data-ms-upload-items>${uploadRows(upload)}</div><div class="ms-actions">${button('refresh-upload','更新状态',upload.busy?'disabled':'')}${!complete?button('finish-upload','完成并核对回执',upload.busy?'disabled':'','primary'):button('new-upload','再上传一批')}</div>${complete?`<p class="ms-receipt">已收到 ${complete.photoIds.length} 张照片 · ${esc(new Date(s.finalizedAt).toLocaleString('zh-CN'))}</p><p>这是本次上传的回执，不代表所有照片都已通过展示审核或已经定位。</p>`:''}</section>`;
 }
 const limit=context?.limits;if(!limit)return '<p class="ms-empty">现在无法上传，请更新权限状态。</p>';
 return `<form data-ms-form="upload" class="ms-panel"><h2>${privateSelection?'确认加入这些照片':'把你的视角留下'}</h2><p>每批最多 ${limit.batchItems} 张，每张不超过 ${(limit.photoBytes/1048576).toFixed(0)} MB。支持 ${(context.photoFormats||[]).map(x=>x.split('/')[1].toUpperCase()).join(' / ')}。</p><label class="ms-field">选择照片原件<input name="photos" type="file" accept="${esc((context.photoFormats||[]).join(','))}" multiple required></label><label class="ms-consent"><input type="checkbox" name="consent" required>我有权将选中的照片加入这个空间，并同意用于空间内展示与位置建议；照片可能由空间主人或授权管理员审核。私人聊天和原声不会随照片加入。</label><details><summary>照片处理说明</summary><p>原件用于校验与处理。空间展示副本会移除 EXIF/GPS 元数据；拍摄时间可能用于排序。原件及空间内容受既有账号、邀请与审核权限保护。</p></details><button class="primary">上传选中的照片</button></form>`;
}

export function createMomentSharedSpaces({api,user=()=>null,guest=()=>!user()?.id,navigate,login,onError=()=>{},fidelity=false}){
 let noteSurface,noteDialog;
 let root,control,generation=0,cleanup=()=>{},sceneDestroy=()=>{},upload,page,data={},request,owner,activeRoute='',refreshTimer,working=false;
 const valid=()=>Boolean(root&&!control?.signal.aborted&&user()?.id===owner);
 const tell=text=>{if(valid()){const el=root.querySelector('[data-ms-status]');if(el)el.textContent=text;}};
 const routeFor=(tab,photoId)=>`${page.token?'join/'+page.token:'shared-space/'+page.spaceId}?tab=${tab}${photoId?'&photo='+id(photoId):''}`;
 const go=(tab,photoId)=>navigate(routeFor(tab,photoId));
 function stopMedia(){root?.querySelectorAll?.('audio,video').forEach(media=>{media.pause();media.removeAttribute('src');media.load();});}
 function frame(body){stopMedia();sceneDestroy();sceneDestroy=()=>{};root.innerHTML=`<section class="ms-surface">${body}<p data-ms-status class="ms-status" role="status" aria-live="polite"></p></section>`;}
 function head(){const s=data.space||{},tasks=page.token?data.join.tasks:s.tasks||[];const canView=tasks.includes('view'),canUpload=tasks.includes('upload');
  if(fidelity&&!page.token)return `<header class="v2-page-head nav"><button class="ib" data-ms-action="back" aria-label="回到空间">‹</button><h1>${esc(labels[page.tab])}</h1></header><p class="v2-shared-subtitle">${esc(s.name||'回忆空间')}</p>`;
  return `<header class="ms-heading"><button class="ib" data-ms-action="back" aria-label="返回回忆空间">←</button><div><small>UNSEEN · 一起留下</small><h1>${esc(s.name||'回忆空间')}</h1><p>${page.token?'通过链接参与 · 临时权限不会自动加入你的账号空间':s.owner?'我创建的空间': '共同参与 · 可从账号找回'}</p></div>${!page.token&&(s.owner||s.managementScopes?.includes('canInvite'))?button('share','分享与管理','','primary'):''}</header><nav class="ms-tabs" aria-label="空间内容">${['scene','photos','stories'].map(tab=>button('tab',labels[tab],`data-tab="${tab}" ${canView?'':'disabled'} aria-current="${page.tab===tab?'page':'false'}"`)).join('')}${canUpload?button('tab','上传照片',`data-tab="upload" aria-current="${page.tab==='upload'?'page':'false'}"`):''}</nav>${page.token?'<p class="ms-boundary">以本次邀请的权限参与。链接撤销、到期或收集暂停后，相应访问会停止。正式成员由主人另外管理。</p>':''}`;
 }
 function polishShare(target){
  const settings=target.querySelector('[data-ms-action="collection"]')?.closest('.ms-panel');
  if(settings){const details=document.createElement('details');details.className='v2-secondary';details.innerHTML='<summary>收集、查看与照片审核设置</summary>';settings.before(details);details.append(settings);target.append(details);}
  const form=target.querySelector('[data-ms-form="invite"]'),fields=form?.querySelector('.ms-fields');
  if(fields){const details=document.createElement('details');details.className='v2-secondary';details.innerHTML='<summary>有效期与人数 · 默认 7 天 / 20 次</summary>';fields.before(details);details.append(fields);}
 }
 function uploadHtml(){return uploadPanel(upload,data.upload)+(fidelity&&!page.token&&upload?.state?.completed?button('open-space','回到空间，看看照片','','primary'):'');}
 function decoratePhoto(p){const photoId=p.id||p.photoId;return {...p,id:photoId,photoMedia:{url:mediaUrl(p.photoMedia?.url||p.assetUrl||`/v1/viewer/spaces/${id(page.spaceId)}/photos/${id(photoId)}/album-media`,{invitation:!!page.token})}};}
 function photosHtml(){const photos=(data.viewer?.photos||[]).map(decoratePhoto),queues=data.management?.queues,review=queues?.review||data.management?.reviewQueue||[];
  const canLeaveNote=(data.space?.tasks||[]).includes('upload')&&(page.token||data.space?.collectionState==='open');
  return `<div class="ms-section-head"><h2>各自的照片，同一个现场</h2>${button('refresh','更新')}</div>${data.space?.owner&&review.length?`<section class="ms-panel"><h3>${review.length} 张等待展示审核</h3><div class="ms-actions">${review.map(p=>button('review-photo','核对这张照片',`data-photo="${esc(p.id||p.photoId)}"`)).join('')}</div></section>`:''}<div class="ms-photo-grid">${photos.map((p,i)=>`<article class="ms-photo-card"><button class="ms-photo-open" data-ms-action="photo" data-photo="${esc(p.id)}"><img src="${esc(p.photoMedia.url)}" alt="空间照片 ${i+1}" loading="lazy"><span>照片 ${i+1}${canLeaveNote?' · 留一句':''}</span></button><p>${esc(label(p.placementState||p.placement_state))}${p.uploader?' · '+esc(p.uploader):''}</p>${data.space?.owner||data.space?.managementScopes?.includes('canEditPlacement')?button('edit-placement','确认或调整位置',`data-photo="${esc(p.id)}"`):''}</article>`).join('')}</div>${photos.length?'':'<div class="ms-empty"><p>这里还没有可以展示的照片。可以先上传；需要审核的照片通过后才会出现。</p></div>'}`;
 }
 function shareHtml(){const m=data.management,s={...data.space,...m?.space},scopes=m?.scopes||s.managementScopes||[],ownerCan=s.owner,canInvite=ownerCan||scopes.includes('canInvite');
  return `<div class="ms-section-head"><h2>邀请一起留下的人</h2>${button('refresh','更新状态')}</div><p>空间目前${s.sharingState==='shared'?'允许受邀查看':'仅账号内授权成员可查看'}，${s.collectionState==='open'?'正在收集照片':'已暂停收集'}。邀请不会把空间列入公开广场。</p>${ownerCan?`<section class="ms-panel"><h3>空间开关</h3><div class="ms-actions">${button('collection',s.collectionState==='open'?'暂停收集照片':'开启照片收集')}${button('sharing',s.sharingState==='shared'?'关闭链接查看':'允许链接查看')}${button('approval',m.autoApproveUploads?'改为主人审核照片':'允许系统检查后展示')}</div><p>暂停收集会停止后续上传；关闭链接查看会停止访客查看。撤销一条邀请不移除已经单独加入的正式成员。</p></section>`:''}${canInvite?`<form data-ms-form="invite" class="ms-panel"><label class="ms-field">允许做什么<select name="mode"><option value="view">可查看</option><option value="upload">可上传</option><option value="combo">可查看并上传</option></select></label><div class="ms-fields"><label class="ms-field">有效天数<input name="days" type="number" min="1" max="30" value="7" required></label><label class="ms-field">最多成功进入次数<input name="uses" type="number" min="1" max="1000" value="20" required></label></div><p>创建邀请会开启所选范围需要的查看或收集开关。只上传的访客不能浏览其他照片。</p><button class="primary">生成邀请链接与二维码</button></form>`:''}<div data-ms-qr></div><section class="ms-panel"><h3>已创建的邀请</h3>${(m?.campaigns||[]).map(c=>`<article class="ms-invite-row"><div><strong>${esc({view:'可查看',upload:'可上传',combo:'可查看并上传'}[c.taskMode])}</strong><p>${esc(label(c.campaignStatus))} · 已进入 ${Number(c.successfulUseCount)||0} 次 · ${esc(new Date(c.expiresAt).toLocaleString('zh-CN'))} 到期</p></div><div class="ms-actions">${button('show-qr','链接与二维码',`data-campaign="${esc(c.campaignId||c.id)}"`)}${['active','exhausted'].includes(c.campaignStatus)?button('revoke','撤销邀请',`data-campaign="${esc(c.campaignId||c.id)}"`):''}</div></article>`).join('')||'<p>还没有邀请。空间创建后默认私有。</p>'}</section>`;
 }

 function storiesHtml(){
  const merged=new Map((data.stories||[]).map(s=>[s.storyId,s]));for(const mine of data.myStories||[])merged.set(mine.storyId,{...merged.get(mine.storyId),...mine,canWithdraw:true});
  data.storyRows=[...merged.values()];
  return `<div class="ms-section-head"><h2>在这里说过的话</h2>${button('refresh','更新')}</div><p>只有讲述者另外选中并确认的原文、原声会出现在这里。私人聊天不会自动加入。打开空间里的任意照片，就能直接留一句或请 AI 问你一句。</p>${data.storyRows.map(s=>`<article class="ms-panel ms-story-card" data-story-card="${esc(s.storyId)}"><p>${esc(s.authorCredit||'讲述者')} · ${s.visibility==='hidden'?'主人暂时隐藏':'已授权分享'}</p>${s.pieces.map(p=>`${p.text!==undefined?`<blockquote>${esc(p.text)}</blockquote>`:''}${p.audio&&s.visibility==='visible'?`<audio controls preload="none" src="${esc(mediaUrl(p.audio.url,{invitation:!!page.token}))}"></audio>`:''}`).join('')}<div class="ms-actions">${button('photo','看看这张照片',`data-photo="${esc(s.photoId)}"`)}${s.canWithdraw?button('story-withdraw-review','撤回我的分享',`data-story="${esc(s.storyId)}"`):''}${s.canHide?button('story-hide','暂时隐藏',`data-story="${esc(s.storyId)}"`):''}</div></article>`).join('')||'<div class="ms-empty"><p>这里还没有另外确认分享的故事。可以先留下照片，之后再决定分享哪句话与哪段原声。</p></div>'}`;
 }
 function paintUpload(){if(!valid())return;const container=root.querySelector('[data-ms-upload-panel]');if(container)container.innerHTML=uploadHtml();}
 async function load(){
  noteSurface?.destroy();noteDialog?.destroy();
  data={join:data.join};
  if(page.token){data.join ||= readJoin(page.token);if(!data.join){const preview=await request(`/v1/external-invitation-campaigns/${id(page.token)}/preview`);data.preview=preview;frame(`<header class="ms-welcome"><small>UNSEEN · 受邀一起留下</small><h1>${esc(preview.displayName||'一处共同的现场')}</h1><p>以空间主人给予的范围，查看现场或贡献照片。</p></header><div class="ms-panel"><p>通过链接获得的是临时参与权限；不会自动成为账号里的永久空间成员。</p>${button('join','接受邀请并继续','','primary')}</div>`);return;}
   page.spaceId=data.join.spaceId;data.space={name:data.join.name,tasks:data.join.tasks};
  }else{if(guest()){await login?.('spatial');return;}const result=await request('/v1/me/spaces');data.space=result.spaces.find(s=>(s.spaceId||s.id)===page.spaceId);if(!data.space)throw {code:'resource_unavailable'};}
  const tasks=data.space.tasks||[],canView=tasks.includes('view'),canUpload=tasks.includes('upload');
  if(!canView&&page.tab!=='upload')page.tab='upload';if(!canUpload&&page.tab==='upload')page.tab='photos';
  if(!page.token&&(data.space.owner||data.space.managementScopes?.length)){data.management=await request(`/v1/spaces/${id(page.spaceId)}/management`);}
  if(['scene','photos','stories'].includes(page.tab)&&canView){data.viewer=await request(`/v1/viewer/spaces/${id(page.spaceId)}`);data.space.name=data.viewer.name||data.space.name;if(page.token&&data.join&&data.viewer.name){data.join.name=data.viewer.name;try{sessionStorage.setItem('unseen.shared-join.'+page.token,JSON.stringify(data.join));}catch{}}}
  if(page.tab==='stories'){const shared=await request(`/v1/viewer/spaces/${id(page.spaceId)}/stories`);data.stories=shared.stories;if(!page.token){const mine=await request(`/v1/me/photo-stories?spaceId=${id(page.spaceId)}`);data.myStories=mine.stories.filter(s=>s.visibility!=='withdrawn');}}
  if(page.tab==='upload'){
   try{data.upload=await request(`/v1/spaces/${id(page.spaceId)}/upload-context`);data.space.name=data.upload.name||data.space.name;if(page.token&&data.join&&data.upload.name){data.join.name=data.upload.name;try{sessionStorage.setItem('unseen.shared-join.'+page.token,JSON.stringify(data.join));}catch{}}}catch(error){data.uploadError=error;}
   upload=new SharedUpload({request,spaceId:page.spaceId,identityKey:page.token?'invitation-'+page.token:String(owner),signal:control.signal,isCurrent:valid,onChange:paintUpload});
   if(upload.state?.batchId){try{await upload.refresh();}catch(error){data.uploadError ||= error;}}
  }
  frame(head()+`<main class="ms-content" data-ms-content></main>`);const target=root.querySelector('[data-ms-content]');
  if(page.tab==='share'){if(!data.management)throw {code:'resource_unavailable'};target.innerHTML=shareHtml();if(fidelity)polishShare(target);}
  if(page.tab==='photos'){target.innerHTML=photosHtml();if(page.photoId)await openPhoto(page.photoId);}
  if(page.tab==='stories')target.innerHTML=storiesHtml();
  if(page.tab==='upload'){target.innerHTML=`${data.uploadError?`<div class="ms-panel"><p>${esc(sharedError(data.uploadError))}</p>${data.space.owner&&data.space.collectionState!=='open'?button('collection','开启照片收集'):button('refresh','重新检查权限')}</div>`:''}<div data-ms-upload-panel>${uploadHtml()}</div>`;}
  if(page.tab==='scene'){
   let context=data.viewer?.sceneContext;if(page.photoId){try{context=await request(`/v1/viewer/spaces/${id(page.spaceId)}/photos/${id(page.photoId)}/scene-context`);}catch(error){target.innerHTML=`<div class="ms-empty"><p>这张照片还没有这个现场版本的确认位置，可以先在相册保留或请主人调整。</p>${button('tab','回到照片', 'data-tab="photos"')}</div>`;return;}}
   if(!page.photoId){
    const saved=await request('/api/space-scenes/'+id(page.spaceId));
    if(saved.scene){target.innerHTML=`<div class="ms-section-head"><h2>${esc(data.space.name||'走进现场')}</h2>${button('refresh','更新')}</div><iframe class="v2-saved-scene" title="3D 空间" src="${esc(saved.scene.viewerUrl)}" allow="fullscreen" allowfullscreen></iframe><p>没有照片也可以先浏览现场。照片上传后会留在同一空间；新照片的自动定位尚未接通。</p>`;return;}
   }
   const options=sharedSceneOptions(context,{invitation:!!page.token});target.innerHTML=`<div class="ms-section-head"><h2>${page.photoId?'从照片回到这里':'再次环顾那一天'}</h2>${button('refresh','更新')}</div>${options?`<div class="ms-scene" data-ms-scene></div><p>${options?.kind==='world'?'这是 AI 补全的空间，可能与真实现场不同；照片的全景方向不代表 World 中的三维机位。'+(options.providerExposure==='provider_may_be_public'?'生成服务可能保留公开结果链接。撤销 UNSEEN 邀请不会撤回第三方已经公开的副本。':''):'照片位置为全景中的方向，不是完整三维机位。AI 建议位置，可调整。'}</p>`:`<div class="ms-empty"><p>这里还没有可查看的现场，可以先收集照片。</p>${data.space.owner?button('add-scene','补充现场全景','','primary'):''}</div>`}${data.space.owner?button('replace-scene','更新现场素材'):''}`;
   if(options)sceneDestroy=mountAppSpatial({container:target.querySelector('[data-ms-scene]'),...options,signal:control.signal,onError:()=>tell('现场资源暂时没有读完，请更新重试。')});
  }
 }
 function readJoin(token){try{const row=JSON.parse(sessionStorage.getItem('unseen.shared-join.'+token)||'null');return validId(row?.spaceId)&&Array.isArray(row.tasks)?row:null;}catch{return null;}}
 async function join(){
  const body={publicCampaignId:page.token,clientNonce:uuid()};await request('/v1/external-campaign-admission-challenges',{method:'POST',body});
  const admitted=await request('/v1/external-campaign-admissions',{method:'POST',body});
  const secret=admitted.oneTimeSecret||new URL(admitted.invitationBootstrapUrlOnce||'/',location.origin).hash.match(/^#invite=([A-Za-z0-9_-]+)$/)?.[1];if(!secret)throw {code:'invite_unavailable'};
  const exchange=await request('/v1/external-invitation-exchanges',{method:'POST',body:{secretFromClearedInviteBootstrap:secret,clientNonce:body.clientNonce}});
  const sid=exchange.spaceId||exchange.destinationRoute?.match(/^\/s\/([A-Za-z0-9_-]+)\/(album|upload)$/)?.[1];if(!validId(sid)||!Array.isArray(exchange.tasks))throw {code:'invite_unavailable'};
  data.join={spaceId:sid,tasks:exchange.tasks.filter(x=>['view','upload'].includes(x)),entryTask:exchange.entryTask,name:data.preview?.displayName||'一起留下的空间'};
  try{sessionStorage.setItem('unseen.shared-join.'+page.token,JSON.stringify(data.join));}catch{ /* Current visit remains usable with HttpOnly sessions; refresh asks to re-enter. */ }
  page.spaceId=sid;page.tab=exchange.entryTask==='upload'?'upload':'scene';await load();
 }
 async function qr(campaign){
  const url=sharedInvitationUrl(campaign),target=root.querySelector('[data-ms-qr]');if(!target)return;
  target.innerHTML=`<section class="ms-panel ms-qr-panel"><h3>邀请二维码</h3><canvas width="280" height="280" aria-label="可打开空间邀请的二维码"></canvas><a href="${esc(url)}" target="_blank" rel="noopener">在新页面打开邀请</a><input class="ms-link" readonly aria-label="邀请链接" value="${esc(url)}"><div class="ms-actions">${button('copy-link','复制链接',`data-url="${esc(url)}"`)}${button('system-share','系统分享',`data-url="${esc(url)}"`)}</div><p>二维码只包含可分享的邀请地址，不包含一次性访问凭证。</p></section>`;
  const {renderQr}=await import('./vendor/shared-qrcode.js');if(valid()&&target.isConnected){renderQr(target.querySelector('canvas'),url);target.scrollIntoView({block:'nearest',behavior:'smooth'});}
 }
 async function transition(kind,to){const s={...data.space,...data.management?.space},m=data.management;await request(`/v1/spaces/${id(page.spaceId)}/${kind}-transitions`,{method:'POST',body:{to},version:s.version??m?.version});}
 async function createInvite(form){const values=new FormData(form),mode=String(values.get('mode')),days=Number(values.get('days')),uses=Number(values.get('uses'));
  if(!['view','upload','combo'].includes(mode)||!Number.isInteger(days)||days<1||days>30||!Number.isInteger(uses)||uses<1||uses>1000)throw {code:'campaign_policy_invalid'};
  let s={...data.space,...data.management.space};
  for(const [kind,to,needed]of [['sharing','shared',mode!=='upload'],['collection','open',mode!=='view']])if(needed&&s[kind+'State']!==to){const updated=await request(`/v1/spaces/${id(page.spaceId)}/${kind}-transitions`,{method:'POST',body:{to},version:s.version});s={...s,...updated,[kind+'State']:to};}
  const created=await request(`/v1/spaces/${id(page.spaceId)}/external-invitation-campaigns`,{method:'POST',body:{taskMode:mode,entryTask:mode==='upload'?'upload':'view',expiresAt:new Date(Date.now()+days*86400000).toISOString(),maxSuccessfulUses:uses},version:s.version});await load();await qr(created);
 }
 async function openPhoto(photoId){
  noteSurface?.destroy();
  const detail=await request(`/v1/viewer/spaces/${id(page.spaceId)}/photos/${id(photoId)}`);const target=root.querySelector('[data-ms-content]');if(!target)return;
  target.innerHTML=`${button('tab','← 返回照片','data-tab="photos"')}<figure class="ms-photo-detail"><img src="${esc(mediaUrl(detail.photoMedia?.url,{invitation:!!page.token}))}" alt="照片完整画面">${detail.video?`<video controls playsinline preload="metadata" src="${esc(mediaUrl(detail.video.url,{invitation:!!page.token}))}"></video>`:''}<figcaption>${esc(label(detail.placementState))}</figcaption></figure><div class="ms-actions">${detail.canReturnToScene?button('return-scene','回到照片所在的现场',`data-photo="${esc(photoId)}"`):'<p>暂时没有当前现场的确认位置；照片仍留在相册。</p>'}${data.space.owner||data.space.managementScopes?.includes('canEditPlacement')?button('edit-placement','确认或调整位置',`data-photo="${esc(photoId)}"`):''}</div><div data-ms-photo-story></div>`;
  noteSurface=mountSpacePhotoStory(target.querySelector('[data-ms-photo-story]'),{request,api,user,spaceId:page.spaceId,photoId,invitation:!!page.token,identityKey:page.token?'invitation-'+page.token:owner,signal:control.signal});
  await noteSurface.ready;
 }
 async function editPhoto(photoId,review=false){
  const edit=await request(`/v1/photos/${id(photoId)}/placement-edit?access=account`);data.edit=edit;data.edit.photoId=photoId;const context=edit.sceneContext,options=sharedSceneOptions(context),target=root.querySelector('[data-ms-content]');
  if(!target)return;sceneDestroy();sceneDestroy=()=>{};
  target.innerHTML=`${button('tab','← 返回照片','data-tab="photos"')}<h2>${review?'先核对展示内容':'AI 建议位置，可调整'}</h2><p>方向来自全景图；位置拿不准，或不属于这个现场，可以只保留在相册。</p><img class="ms-editor-photo" src="${esc(mediaUrl(context?.photoMedia?.url||`/v1/photos/${id(photoId)}/placement-edit/media`,{account:true}))}" alt="待核对照片">${options?'<div class="ms-scene" data-ms-scene></div>':'<p>还没有现场底图，上传后再定位。</p>'}<section class="ms-panel">${(edit.candidates||[]).length?`<h3>可核对的候选方向</h3><div class="ms-actions">${edit.candidates.map((c,i)=>button('candidate',`候选 ${i+1} · ${Math.round(c.yaw)}°`,`data-candidate="${esc(c.candidateId)}"`)).join('')}</div><p>先选候选，在现场中核对，再确认保存。</p>`:''}<form data-ms-form="placement"><div class="ms-fields"><label class="ms-field">水平方向（°）<input name="yaw" type="number" min="-180" max="360" step="0.1" value="${Number(context?.placement?.yawDeg)||0}" required></label><label class="ms-field">俯仰（°）<input name="pitch" type="number" min="-85" max="85" step="0.1" value="${Number(context?.placement?.pitchDeg)||0}" required></label></div><div class="ms-actions">${button('preview-pose','看看这个方向',options?'':'disabled')}<button class="primary" ${options?'':'disabled'}>确认这个位置</button>${button('outside','只保留在相册')}</div></form></section>${review?`<section class="ms-panel"><h3>展示审核</h3><p>只有核对后允许展示的照片才会出现在访客相册。</p><div class="ms-actions">${button('approve','允许空间内展示')}${button('hide','暂不展示')}</div></section>`:''}`;
  if(options)sceneDestroy=mountAppSpatial({container:target.querySelector('[data-ms-scene]'),...options,signal:control.signal});
 }
 function placementHeaders(){const e=data.edit;return {version:e.photoVersion,headers:{'X-Item-Version':String(e.itemVersion),'X-Placement-Authorization-Version':String(e.placementAuthorizationVersion)}};}
 async function act(action,b){
  if(action==='leave-note'){noteDialog?.destroy();noteDialog=openSpacePhotoStory({request,api,user,spaceId:page.spaceId,photoId:b.dataset.photo,invitation:!!page.token,identityKey:page.token?'invitation-'+page.token:owner,signal:control.signal,showPhoto:true});return;}
  if(action==='back')return navigate(fidelity&&!page.token?'shared-space/'+id(page.spaceId):'spaces');if(action==='open-space')return navigate('shared-space/'+id(page.spaceId));if(action==='tab')return go(b.dataset.tab);if(action==='share')return go('share');if(action==='join')return join();if(action==='refresh')return load();
  if(action==='replace-scene')return navigate('new-space?spaceId='+id(page.spaceId));
  if(action==='add-scene')return navigate('new-space?spaceId='+id(page.spaceId)+'&kind=panorama');
  if(action==='story-withdraw-review'){const s=data.storyRows.find(s=>s.storyId===b.dataset.story);const card=root.querySelector(`[data-story-card="${s.storyId}"]`);card.innerHTML=`<h3>撤回这段分享？</h3><p>空间里的原文与原声将无法打开，私人记录会保留。</p>${button('story-withdraw','确认撤回',`data-story="${esc(s.storyId)}"`,'primary')}${button('refresh','保留分享')}`;return;}
  if(action==='story-withdraw'||action==='story-hide'){const s=data.storyRows.find(s=>s.storyId===b.dataset.story);await request(`/v1/photo-stories/${id(s.storyId)}/${action==='story-withdraw'?'withdrawals':'visibility'}`,{method:'POST',body:action==='story-withdraw'?{}:{to:'hidden'},version:s.version});return load();}
  if(action==='photo')return openPhoto(b.dataset.photo);if(action==='return-scene')return go('scene',b.dataset.photo);if(action==='edit-placement'||action==='review-photo')return editPhoto(b.dataset.photo,action==='review-photo');
  if(action==='refresh-upload'){if(upload.state?.completed){const receipt=await request('/v1/batch-receipt');if(receipt.batchId!==upload.state.batchId)throw {code:'receipt_unavailable'};upload.state.completed.receipt=receipt;upload.save();}else await upload.refresh();paintUpload();return;}
  if(action==='retry-item'){const index=Number(b.dataset.index),selected=root.querySelector(`[data-ms-reselect="${index}"]`)?.files?.[0];await upload.resume(index,selected);paintUpload();return;}
  if(action==='finish-upload'){await upload.finalize();paintUpload();return;}
  if(action==='new-upload'){upload.clearCompleted();paintUpload();return;}
  if(action==='collection'){await transition('collection',data.space.collectionState==='open'?'paused':'open');return load();}
  if(action==='sharing'){await transition('sharing',data.space.sharingState==='shared'?'private':'shared');return load();}
  if(action==='approval'){await transition('auto-approve-uploads',data.management.autoApproveUploads?'off':'on');return load();}
  if(action==='show-qr'){const c=data.management.campaigns.find(c=>(c.campaignId||c.id)===b.dataset.campaign);return qr(c);}
  if(action==='revoke'){const c=data.management.campaigns.find(c=>(c.campaignId||c.id)===b.dataset.campaign);await request(`/v1/external-invitation-campaigns/${id(c.campaignId||c.id)}/revocations`,{method:'POST',body:{reasonClass:'owner_revoked',clientRequestId:uuid()},version:c.version??c.ifMatch});return load();}
  if(action==='copy-link'){try{await navigator.clipboard.writeText(b.dataset.url);tell('邀请链接已复制');}catch{root.querySelector('.ms-link')?.select();tell('请选择并复制上方邀请链接');}return;}
  if(action==='system-share'){if(navigator.share)try{await navigator.share({title:data.space.name,url:b.dataset.url});}catch(error){if(error.name!=='AbortError')throw error;}else tell('此浏览器不支持系统分享，可以复制链接。');return;}
  if(action==='preview-pose'){const form=root.querySelector('[data-ms-form="placement"]'),yaw=Number(form.elements.yaw.value),pitch=Number(form.elements.pitch.value);if(Number.isFinite(yaw)&&Number.isFinite(pitch))sceneDestroy.lookAt?.(yaw,pitch);return;}
  if(action==='candidate'){const c=data.edit.candidates.find(c=>c.candidateId===b.dataset.candidate);data.edit.selectedCandidate=c.candidateId;const form=root.querySelector('[data-ms-form="placement"]');form.elements.yaw.value=c.yaw;form.elements.pitch.value=c.pitch??0;sceneDestroy.lookAt?.(c.yaw,c.pitch??0);tell('已预览候选方向。核对照片后，点击确认这个位置。');return;}
  if(action==='outside'){await request(`/v1/photos/${id(data.edit.photoId)}/placement-actions?access=account`,{method:'POST',body:{action:'mark_outside_scene',reason:'owner_outside_scene'},...placementHeaders()});return go('photos');}
  if(action==='approve'||action==='hide'){await request(`/v1/photos/${id(data.edit.photoId)}/content-transitions`,{method:'POST',body:{to:action==='approve'?'visible':'hidden',transitionReasonCode:action==='approve'?'manual_approved':'manual_hidden',decisionReasonCode:action==='approve'?null:'safety_hold'},version:data.edit.photoVersion});return go('photos');}
 }
 async function submit(form){
  if(form.dataset.msForm==='invite')return createInvite(form);
  if(form.dataset.msForm==='upload'){if(!form.elements.consent.checked)return;const files=[...form.elements.photos.files];await upload.start(files,data.upload);if(upload.complete())await upload.finalize();paintUpload();return;}
  if(form.dataset.msForm==='placement'){const yaw=Number(form.elements.yaw.value),pitch=Number(form.elements.pitch.value);if(!Number.isFinite(yaw)||yaw< -180||yaw>360||!Number.isFinite(pitch)||Math.abs(pitch)>85)return;
   const candidate=data.edit.candidates?.find(c=>c.candidateId===data.edit.selectedCandidate&&c.yaw===yaw&&(c.pitch??0)===pitch);
   const body={...(candidate?{mode:'candidate',confirmationMode:'manual',suggestionId:data.edit.suggestionId,candidateId:candidate.candidateId}:{mode:'manual',confirmationMode:'manual',yawDeg:yaw,pitchDeg:pitch,reason:'owner_manual_adjustment'}),panoramaRevisionId:data.edit.currentPanoramaRevisionId||data.edit.sceneContext?.scene?.panoramaRevisionId};
   await request(`/v1/photos/${id(data.edit.photoId)}/placement-revisions?access=account`,{method:'POST',body,...placementHeaders()});return go('photos');}
 }
 async function mount(target,route){
  destroy();root=target;owner=user()?.id;activeRoute=route;page=sharedRoute(route);data={};control=new AbortController();const g=++generation;
  request=canonicalRequest(api,{user,owner,invitation:!!page.token,signal:control.signal,isCurrent:()=>g===generation});
  frame('<p role="status">正在打开这处现场…</p>');
  const run=async(fn,button)=>{if(!valid()||working||button?.disabled)return;working=true;tell('');if(button)button.disabled=true;try{await fn();}catch(error){if(valid()&&error.name!=='AbortError'){tell(error.code?.startsWith('story_')?photoStoryError(error):sharedError(error));onError(error);}}finally{working=false;if(button?.isConnected)button.disabled=false;}};
  const click=e=>{const b=e.target.closest('[data-ms-action]');if(b&&root.contains(b)){e.preventDefault();if(['back','tab','share','add-scene','replace-scene','return-scene'].includes(b.dataset.msAction)&&!b.disabled){act(b.dataset.msAction,b);return;}run(()=>act(b.dataset.msAction,b),b);}};
  const form=e=>{if(e.target.matches('[data-ms-form]')){e.preventDefault();run(()=>submit(e.target),e.submitter);}};
  root.addEventListener('click',click);root.addEventListener('submit',form);cleanup=()=>{target.removeEventListener('click',click);target.removeEventListener('submit',form);};
  try{await load();}catch(error){if(valid()&&error.name!=='AbortError')frame(`<header class="ms-welcome"><h1>这里暂时无法打开</h1><p>${esc(sharedError(error))}</p>${button('refresh','重新检查')}${button('back','回到回忆空间')}</header>`);}
  // Recheck only the active visitor permission, without mutating an admission or replacing
  // selected files. A revoked invitation clears the already-open scene/album promptly.
  if(page.token)refreshTimer=setInterval(async()=>{if(!valid()||document.hidden||!page.spaceId)return;try{await request(data.join.tasks.includes('view')?`/v1/viewer/spaces/${id(page.spaceId)}`:`/v1/spaces/${id(page.spaceId)}/upload-context`);}catch(error){if(valid()&&error.name!=='AbortError'){stopMedia();sceneDestroy();control.abort();root.innerHTML=`<section class="ms-surface ms-empty"><h1>暂时无法确认邀请权限</h1><p>${esc(sharedError(error))}</p><a class="secondary" href="${fidelity?'/app-v2':'/app'}#join/${id(page.token)}">重新打开邀请</a></section>`;}}},30000);
 }
 function destroy(){noteSurface?.destroy();noteDialog?.destroy();generation++;working=false;clearInterval(refreshTimer);control?.abort();stopMedia();sceneDestroy();sceneDestroy=()=>{};cleanup();cleanup=()=>{};upload=null;root=null;}
 return {mount,destroy};
}

export function mountPhotoSpacePicker(root,{api,user=()=>null,refs,readPhoto,onClose=()=>{},onComplete=()=>{},navigate=()=>{}}){
 const owner=user()?.id,control=new AbortController();let destroyed=false,busy=false,upload,context,spaces=[];const selected=[...new Map((refs||[]).map(r=>[r.key,r])).values()];
 const current=()=>!destroyed&&!control.signal.aborted&&user()?.id===owner;
 const request=canonicalRequest(api,{user,owner,signal:control.signal,isCurrent:current});
 function show(html){if(current())root.innerHTML=`<section class="ms-surface ms-picker">${html}<p role="status" data-ms-status></p></section>`;}
 function tell(text){if(current()){const el=root.querySelector('[data-ms-status]');if(el)el.textContent=text;}}
 function redraw(){if(!current()||!upload?.state)return;show(`<h2>加入${esc(spaces.find(s=>(s.spaceId||s.id)===upload.spaceId)?.name||'空间')}</h2>${uploadPanel(upload,context,{privateSelection:true})}${upload.state.completed?button('open-space','打开空间里的照片','','primary'):''}${button('close','关闭')}`);}
 async function complete(){const result=await upload.finalize();redraw();if(current())await onComplete(result);}
 async function start(form){
  if(!form.elements.consent.checked)return;const spaceId=form.elements.space.value;if(!spaces.some(s=>(s.spaceId||s.id)===spaceId))throw {code:'resource_unavailable'};
  context=await request(`/v1/spaces/${id(spaceId)}/upload-context`);
  upload=new SharedUpload({request,spaceId,identityKey:String(owner),signal:control.signal,isCurrent:current,onChange:redraw});
  if(upload.state){await upload.refresh();redraw();return;}
  const files=[];for(const ref of selected){if(ref.accountId!==owner)throw {code:'account_changed'};tell(`正在读取选中的原图 ${files.length+1}/${selected.length}…`);const blob=await readPhoto(ref,{signal:control.signal});if(!current())throw new DOMException('账号已变化','AbortError');files.push(sharedPhotoFile(blob,ref.name||'照片.jpg'));}
  await upload.start(files,context,{refKeys:selected.map(r=>r.key)});if(upload.complete())await complete();else redraw();
 }
 async function action(b){const a=b.dataset.msAction;if(a==='close')return onClose();if(a==='open-space')return navigate('shared-space/'+id(upload.spaceId)+'?tab=photos');
  if(a==='retry-item'){const index=Number(b.dataset.index),file=root.querySelector(`[data-ms-reselect="${index}"]`)?.files?.[0];await upload.resume(index,file);if(upload.complete())await complete();return;}
  if(a==='finish-upload')return complete();if(a==='refresh-upload'){await upload.refresh();return redraw();}if(a==='new-upload'){upload.clearCompleted();await readyView();}
 }
 async function run(work){if(busy||!current())return;busy=true;try{await work();}catch(error){if(current()&&error.name!=='AbortError')tell(sharedError(error));}finally{busy=false;}}
 const click=e=>{const b=e.target.closest('[data-ms-action]');if(b){e.preventDefault();if(b.dataset.msAction==='close'){onClose();return;}run(()=>action(b));}};
 const submit=e=>{if(e.target.matches('[data-ms-form="private-add"]')){e.preventDefault();run(()=>start(e.target));}};
 root.addEventListener('click',click);root.addEventListener('submit',submit);
 async function readyView(){
  if(owner==='guest-local'){show(`<h2>先把照片保存到账号</h2><p>请先返回照片详情，使用“保存到账号”，再选择空间。这里不会把本机草稿自动认领到账号。</p>${button('close','回到照片')}`);return;}
  if(!owner||!selected.length||selected.some(r=>r.accountId!==owner))throw {code:'account_changed'};
  const result=await request('/v1/me/spaces');spaces=result.spaces.filter(s=>s.spaceLifecycle==='active'&&(s.owner||s.effectiveCanUpload)&&s.collectionState==='open');
  show(`<h2>把选中的照片加入空间</h2><p>已选择 ${selected.length} 张照片原件。只加入这些照片，不会带上整段私人聊天或原声。</p>${spaces.length?`<form data-ms-form="private-add"><label class="ms-field">加入哪个空间<select name="space">${spaces.map(s=>`<option value="${esc(s.spaceId||s.id)}">${esc(s.name)}</option>`).join('')}</select></label><label class="ms-consent"><input type="checkbox" name="consent" required>我有权分享这些照片，同意选中原件加入该空间用于展示与位置建议，并接受空间主人和授权管理员的审核。</label><button class="primary">确认加入这 ${selected.length} 张照片</button></form>`:'<p>还没有正在收集且允许你上传的空间。请先在空间内开启收集，或向主人取得上传权限。</p>'}${button('close','暂不加入')}`);
 }
 const ready=readyView().catch(error=>{if(current())show(`<h2>暂时无法加入</h2><p>${esc(sharedError(error))}</p>${button('close','关闭')}`);});
 return {ready,destroy(){destroyed=true;control.abort();root.removeEventListener('click',click);root.removeEventListener('submit',submit);upload?.files.clear();}};
}
