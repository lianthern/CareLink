import { mountSpacePhotoStory } from './space-photo-story.js';
import { createSpaceMaterials } from './moment-space-materials.js';
import { createMomentSpaces as createLegacySpaces } from './moment-spaces.js';
import { designTitle } from './moment-design.js';
import { photoRows, escapeHtml as esc } from './app-v2-core.js';
import { mountCorridor } from './app-v2-corridor.js';
import { sharedSceneOptions } from './moment-shared-spaces.js';
import { mountAppSpatial } from './unseen-app-spatial.js';
import { createViewRequest } from './moment-view-request.js';
import { createMomentSpaces as createDiscovery } from './moment-space-discovery.js';
import { createCommunitySpaces } from './moment-community-spaces.js';

const enc = encodeURIComponent;
const themes = [['sea','海边'],['wedding','婚礼'],['travel','旅行'],['night','夜色'],['campus','校园']];
const routeButton = (route, text, cls = 'btn ghost') => `<button class="${cls}" data-v2-route="${esc(route)}"${text==='‹'?' aria-label="返回"':text==='✎'?' aria-label="编辑空间信息"':text==='↗'?' aria-label="分享空间"':''}>${text}</button>`;
const spatialButton = (route, text, cls = 'btn ghost') => `<button class="${cls}" data-spatial-route="${esc(route)}">${text}</button>`;
const blank = () => ({version:0,theme:'sea',startDate:'',endDate:'',place:'',coverPhotoId:''});
const cover = (theme='sea', url='') => url ? `<img src="${esc(url)}" alt="空间封面" loading="lazy">` : `<div class="v2-cover-art v2-theme-${themes.some(([t])=>t===theme)?theme:'sea'}" aria-hidden="true"><span></span><i></i><b></b></div>`;
const copy = error => ({version_conflict:'另一页更新了空间信息。请重新打开后再保存。',space_details_invalid:'请检查日期顺序、地点和封面后重试。',session_unavailable:'登录后即可继续。',account_changed:'账号已切换，请重新打开空间。',resource_unavailable:'这个空间暂时无法访问，请检查账号或邀请。',cover_photo_unavailable:'这张照片已不可查看，请重新选择封面。'}[error?.code] || '暂时没有完成，请检查连接后重试。');
const ownedSpaces = rows => (rows || []).filter(s=>s.spaceLifecycle==='active' && (s.owner || s.effectiveCanView || s.effectiveCanUpload));

export async function hydrateHome(root,{api,user,guest}) {
  const anchor=root.querySelector('.design-space-link');
  if(!anchor)return;
  const account=user()?.id, valid=()=>anchor.isConnected && root.contains(anchor) && user()?.id===account;
  const entry=root.querySelector('.design-entry small');
  if(entry)entry.innerHTML='一群人共创<br>照片和故事聚到一起';
  anchor.dataset.spatialRoute='my-spaces';
  if(guest()){anchor.querySelector('strong').textContent='从一次相聚开始';anchor.querySelector('small').textContent='创建空间，邀请同行的人一起留下';anchor.dataset.spatialRoute='new-space';return;}
  try {
    const result=await api.request('/v1/me/spaces');if(!valid())return;
    const rows=ownedSpaces(result.spaces),item=rows[0];
    if(!item){anchor.querySelector('strong').textContent='还没有创建空间';anchor.querySelector('small').textContent='选个封面，给这段回忆一个名字';anchor.dataset.spatialRoute='new-space';return;}
    const sid=enc(item.spaceId);anchor.dataset.spatialRoute='shared-space/'+sid;
    anchor.querySelector('strong').textContent=item.name;anchor.querySelector('small').textContent=(item.owner?'我创建的':'共同参与')+' · '+(item.collectionState==='open'?'正在收集照片':'继续这段回忆');
    const sub=root.querySelector('.design-home .nav h1 small');if(sub)sub.textContent+=' · '+rows.length+' 个空间';
    const view=await api.request('/v1/viewer/spaces/'+sid);if(!valid())return;
    const photos=photoRows(sid,view.photos);
    const photo=photos[0];if(photo)anchor.querySelector('.entry-icon').outerHTML=`<span class="v2-home-thumb"><img src="${esc(photo.url)}" alt="" loading="lazy"></span>`;
  } catch { if(valid())anchor.querySelector('small').textContent='打开我的空间，继续查看或重试'; }
}

export function createMomentSpaces(context) {
  const {api,user,guest,navigate,login}=context;
  const legacy=createLegacySpaces({...context,fidelity:true});
  const community=createCommunitySpaces(context),discovery=createDiscovery(context);
  let materialSurface,storySurface;
  let root,controller,generation=0,cleanup=()=>{},currentRoute='',dialog,dialogOrigin,guestCreateDraft=null,currentView;
  const valid=(token,owner)=>token===generation && !controller.signal.aborted && user()?.id===owner && root?.isConnected;
  const go=route=>navigate(route);
  const head=(title,back='spaces',right='')=>`<header class="v2-page-head nav">${routeButton(back,'‹','ib')}<h1>${esc(title)}</h1><div class="grow"></div>${right}</header>`;
  const tell=text=>{const el=root?.querySelector('[data-v2-status]');if(el)el.textContent=text;};
  function closeDialog(){storySurface?.destroy();storySurface=null;if(!dialog)return;dialog.querySelectorAll('audio').forEach(a=>{a.pause();a.removeAttribute('src');a.load();});dialog.close();dialog.remove();dialog=null;if(dialogOrigin?.isConnected)dialogOrigin.focus();}
  function showDialog(title,html){closeDialog();dialogOrigin=document.activeElement;dialog=document.createElement('dialog');dialog.className='v2-story';dialog.innerHTML=`<header><h2>${esc(title)}</h2><button class="ib" data-v2-close aria-label="关闭">×</button></header>${html}`;document.body.append(dialog);dialog.onclick=e=>{if(e.target===dialog||e.target.closest('[data-v2-close]'))closeDialog();};dialog.addEventListener('cancel',e=>{e.preventDefault();closeDialog();});dialog.showModal();return dialog;}
  function frame(html){root.innerHTML=html+'<p class="v2-feedback" role="status" data-v2-status></p>';root.onclick=event=>{const b=event.target.closest('[data-v2-route]');if(b){event.stopPropagation();go(b.dataset.v2Route);}};}
  async function presentation(sid,request){return (await request('/api/space-presentation/'+enc(sid))).presentation;}
  function draftKey(){return 'unseen.fidelity.create:'+enc(user()?.id || 'guest');}
  function readDraft(){if(!guest()&&guestCreateDraft){const d=guestCreateDraft;guestCreateDraft=null;saveDraft(d);return d;}try{return JSON.parse(sessionStorage.getItem(draftKey()) || 'null') || {name:'',...blank(),key:crypto.randomUUID()};}catch{return {name:'',...blank(),key:crypto.randomUUID()};}}
  function saveDraft(value){try{sessionStorage.setItem(draftKey(),JSON.stringify(value));}catch{tell('这台设备无法保留草稿，请保持页面打开直到创建完成。');}}
  function fieldsHtml(d,{editing=false,photos=[]}={}){
    return `<div class="frame-gold v2-create-cover" data-cover-preview>${cover(d.theme,photos.find(p=>p.id===d.coverPhotoId)?.url)}<span class="v2-cover-label">空间封面</span></div>
      <div class="v2-themes" role="group" aria-label="封面风格">${themes.map(([key,name])=>`<button type="button" data-theme="${key}" aria-pressed="${key===d.theme}"><span>${cover(key)}</span><small>${name}</small></button>`).join('')}</div>
      ${editing && photos.length?`<label class="v2-field">用空间照片作封面<select name="coverPhotoId"><option value="">使用上面的封面风格</option>${photos.map((p,i)=>`<option value="${esc(p.id)}" ${d.coverPhotoId===p.id?'selected':''}>照片 ${i+1}</option>`).join('')}</select></label>`:''}
      ${editing?'':`<label class="v2-field">活动名称<input name="name" maxlength="120" required placeholder="例如：那年夏天的海边" value="${esc(d.name)}" autocomplete="off"></label>`}
      <div class="v2-date-row"><label class="v2-field">开始日期 <small>可选</small><input name="startDate" type="date" value="${esc(d.startDate)}"></label><label class="v2-field">结束日期 <small>可选</small><input name="endDate" type="date" value="${esc(d.endDate)}" min="${esc(d.startDate)}"></label></div>
      <label class="v2-field">地点 <small>可选</small><input name="place" maxlength="120" placeholder="那天，我们在哪里" value="${esc(d.place)}"></label>`;
  }
  function bindFields(form,d,photos=[],persist=true){
    const read=()=>{for(const key of ['name','startDate','endDate','place','coverPhotoId'])if(form.elements[key])d[key]=form.elements[key].value;d.consent=!!form.elements.consent?.checked;};
    const repaint=()=>{form.querySelector('[data-cover-preview]').innerHTML=cover(d.theme,photos.find(p=>p.id===d.coverPhotoId)?.url)+'<span class="v2-cover-label">空间封面</span>';};
    form.oninput=()=>{read();if(form.elements.endDate)form.elements.endDate.min=d.startDate;if(persist)saveDraft(d);};
    form.onchange=()=>{read();repaint();if(persist)saveDraft(d);};
    form.addEventListener('click',event=>{const b=event.target.closest('[data-theme]');if(!b)return;d.theme=b.dataset.theme;d.coverPhotoId='';if(form.elements.coverPhotoId)form.elements.coverPhotoId.value='';form.querySelectorAll('[data-theme]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));repaint();if(persist)saveDraft(d);});
    return read;
  }
  async function create(){
    const {request,assertCurrent}=currentView;
    const d=readDraft(),token=generation,owner=user()?.id;
    frame(head('创建回忆时刻','')+`<form class="v2-create" data-v2-create>${fieldsHtml(d)}<div class="glass v2-private"><span>♧</span><div><strong>私密空间</strong><small>创建后，由你决定邀请谁来查看和上传</small></div><span class="v2-private-lock" aria-label="默认私密">✓</span></div><label class="v2-consent"><input name="consent" type="checkbox" required ${d.consent?'checked':''}>我有权使用这些照片与内容</label><div class="v2-create-footer"><p>照片会聚在同一个空间，邀请可以稍后再发。</p><button class="btn gold" type="submit">${d.spaceId?'继续完成空间':guest()?'登录并创建空间':'创建专属空间'}</button></div></form>`);
    const form=root.querySelector('form'),read=bindFields(form,d);
    form.onsubmit=async event=>{
      event.preventDefault();read();saveDraft(d);if(guest()){guestCreateDraft=d;await login('spatial');return;}if(!valid(token,owner))return;
      const b=form.querySelector('[type=submit]');b.disabled=true;tell('正在保存空间…');
      try {
        if(d.endDate&&(!d.startDate||d.endDate<d.startDate))throw {code:'space_details_invalid'};
        if(!d.spaceId){const notice=await request('/v1/notices/current?purpose=space_create');assertCurrent();const result=await request('/v1/spaces',{method:'POST',body:{name:d.name.trim()},key:d.key,notice});if(!valid(token,owner))return;d.spaceId=result.spaceId;saveDraft(d);}
        const saved=await request('/api/space-presentation/'+enc(d.spaceId),{method:'PUT',body:{version:d.version,...Object.fromEntries(['theme','startDate','endDate','place','coverPhotoId'].map(k=>[k,d[k]]))}});
        if(!valid(token,owner))return;
        d.version=saved.presentation.version;saveDraft(d);
        if(!d.collectionReady){const management=await request('/v1/spaces/'+enc(d.spaceId)+'/management');if(management.space.collectionState!=='open')await request('/v1/spaces/'+enc(d.spaceId)+'/collection-transitions',{method:'POST',body:{to:'open'},version:management.space.version??management.version});assertCurrent();d.collectionReady=true;}
        sessionStorage.removeItem(draftKey());go('space-materials/'+enc(d.spaceId)+'?created=1');
      } catch(error){if(valid(token,owner)){tell((d.spaceId?'空间已经创建，还有一步尚未完成；重试会继续这个空间。 ':'')+copy(error));b.disabled=false;}}
    };
  }
  async function getSpace(sid,request){const data=await request('/v1/me/spaces');const s=ownedSpaces(data.spaces).find(x=>x.spaceId===sid);if(!s)throw {code:'resource_unavailable'};return s;}
  async function materials(sid){
    const {request,assertCurrent}=currentView;
    if(guest()){await login('spatial');return;}
    const s=await getSpace(sid,request);assertCurrent();if(!s.owner)throw {code:'resource_unavailable'};
    materialSurface=createSpaceMaterials(context);
    await materialSurface.mount(root,{space:s,view:currentView});
  }
  async function openPhoto(p,sid){
    const {request,assertCurrent}=currentView;
    const sheet=showDialog('照片与故事','<p role="status">正在打开这张照片…</p>');
    try {
      const detail=await request(`/v1/viewer/spaces/${enc(sid)}/photos/${enc(p.id)}`);
      assertCurrent();if(dialog!==sheet||!sheet.open)return;
      const safe=url=>typeof url==='string'&&/^\/v1\/(viewer|photos)\//.test(url)&&!url.includes('..')?url:'';
      sheet.insertAdjacentHTML('beforeend',`<div class="frame-gold"><img class="v2-story-photo" src="${esc(safe(detail.photoMedia?.url)||p.url)}" alt="照片完整画面"></div><div class="v2-story-copy" data-photo-story></div>`);sheet.querySelector('[role=status]').remove();
      storySurface=mountSpacePhotoStory(sheet.querySelector('[data-photo-story]'),{request,api,user,spaceId:sid,photoId:p.id,signal:currentView.signal});
      await storySurface.ready;
    } catch(error){if(dialog===sheet)sheet.querySelector('[role=status]').textContent=copy(error);}
  }
  async function detail(sid,mode=''){
    const {request,assertCurrent,signal}=currentView;
    if(guest()){await login('spatial');return;}
    const s=await getSpace(sid,request),base='shared-space/'+sid;assertCurrent();
    if(!s.owner&&!s.effectiveCanView){await legacy.mount(root,base+'?tab=upload');return;}
    const [view,meta,saved]=await Promise.all([
      request('/v1/viewer/spaces/'+enc(sid)),
      presentation(sid,request).then(value=>({value})).catch(error=>{assertCurrent();if(error.name==='AbortError'||error.code==='account_changed')throw error;return {error};}),
      request('/api/space-scenes/'+enc(sid)),
    ]);assertCurrent();
    const photos=photoRows(sid,view.photos),p=meta.value||blank(),metaError=!!meta.error;
    const photoAction=(s.owner||s.effectiveCanUpload)&&s.collectionState==='open'?'留一句':'照片与故事';
    const scene=saved.scene||sharedSceneOptions(view.sceneContext),coverPhoto=photos.find(x=>x.id===p.coverPhotoId)||photos[0];
    const sub=[photos.length+' 张照片',p.place,p.startDate?(p.startDate+(p.endDate?' — '+p.endDate:'')):''].filter(Boolean).join(' · ');
    if((mode==='corridor'&&photos.length)||(mode==='scene'&&scene)){
      if(mode==='scene'&&saved.scene){
       frame(head(s.name,base,s.owner?routeButton(base+'?tab=share','分享空间','btn gold sm'):'')+`<iframe class="v2-saved-scene" title="${esc(s.name)} · 3D 空间" src="${esc(saved.scene.viewerUrl)}" allow="fullscreen" allowfullscreen></iframe><p>拖动环顾，W A S D 移动。${saved.scene.photoAnchorCount?'已带入 '+saved.scene.photoAnchorCount+' 个照片机位。':'还没有照片也可以浏览和分享这个现场。'}</p>`);return;
      }
      root.closest('.design-shell')?.classList.add('v2-immersive');
      frame(`<section class="v2-full-scene"><div class="v2-scene-surface"></div><header class="v2-scene-header">${routeButton(base,'‹','ib')}<div><h1>${esc(s.name)}</h1><p>${esc(mode==='corridor'?sub:scene.authenticity||'全景现场')}</p></div>${s.owner?routeButton(base+'?tab=share','↗','ib'):''}</header><div class="v2-scene-versions">${routeButton(base+'?view=corridor','照片走廊',mode==='corridor'?'on':'')}${scene?routeButton(base+'?view=scene','回到现场',mode==='scene'?'on':''):''}</div>${mode==='scene'?`<p class="v2-scene-note">${esc(scene.authenticity||'全景现场 · 拖动环顾')}</p>`:''}</section>`);
      if(mode==='corridor')cleanup=mountCorridor(root.querySelector('.v2-scene-surface'),{photos,accountId:user().id,spaceId:sid,onPhoto:p=>openPhoto(p,sid),immersive:true,onEnd:s.owner||s.effectiveCanUpload?()=>go(base+'?tab=upload'):undefined});
      else cleanup=mountAppSpatial({container:root.querySelector('.v2-scene-surface'),...scene,signal,onError:()=>tell('现场暂时没有读完，请返回后重试。照片仍然保留。')});
      return;
    }
    frame(head(s.name,'my-spaces',s.owner?routeButton('space-details/'+sid,'✎','ib'):'')+`<div class="v2-space-summary"><span class="tag ${s.collectionState==='open'?'rose':'gold'}">${s.collectionState==='open'?'一起共创中':'已保存'}</span><span>${esc(sub)}</span></div><div class="frame-gold v2-space-hero">${cover(p.theme,coverPhoto?.url)}<div><small>MEMORY MOMENT</small><h2>${esc(s.name)}</h2>${photos.length?routeButton(base+'?view=corridor','走进照片走廊 →','btn gold sm'):`<p>${saved.scene?'现场已就绪，可以直接进入':'等第一张照片，展开这段回忆'}</p>`}</div></div><div class="v2-space-actions">${s.owner?routeButton(base+'?tab=share','分享空间','btn rose'):''}${s.owner?routeButton('space-materials/'+sid,'＋ 添加素材','btn gold'):s.effectiveCanUpload?routeButton(base+'?tab=upload','＋ 添加照片','btn gold'):''}</div>${scene?routeButton(base+'?view=scene','◎ 回到现场','glass v2-scene-link'):''}${designTitle('OUR PHOTOS','一起留下的照片')}<div class="v2-photo-grid">${photos.slice(0,60).map((photo,i)=>`<button data-v2-photo="${i}" aria-label="照片 ${i+1}，${photoAction}"><img src="${esc(photo.url)}" alt="" loading="lazy"><span class="v2-photo-note">${photoAction}</span></button>`).join('')}</div>${!photos.length?`<div class="glass v2-empty"><p>照片还没到齐也没关系。自己先上传，或请同行者一起补上。</p>${s.owner?routeButton('space-materials/'+sid,'添加第一张照片','btn rose sm'):s.effectiveCanUpload?routeButton(base+'?tab=upload','添加第一张照片','btn rose sm'):''}</div>`:''}<div class="v2-detail-links">${s.owner?routeButton('publish-space/'+sid,'分享空间到社区','btn gold sm'):''}${routeButton(base+'?tab=stories','照片里的故事','btn ghost sm')}</div>${metaError?'<p class="v2-feedback">封面信息暂时没读到，照片仍可查看。重新打开空间可重试。</p>':''}`);
    root.querySelectorAll('[data-v2-photo]').forEach(button=>button.onclick=()=>openPhoto(photos[Number(button.dataset.v2Photo)],sid));
  }
  async function edit(sid){
    const {request,assertCurrent}=currentView;
    const s=await getSpace(sid,request);assertCurrent();if(!s.owner)throw {code:'resource_unavailable'};
    const p=await presentation(sid,request),view=await request('/v1/viewer/spaces/'+enc(sid)),photos=photoRows(sid,view.photos),token=generation,owner=user()?.id;assertCurrent();
    frame(head('空间封面与信息','shared-space/'+sid)+`<form class="v2-create">${fieldsHtml(p,{editing:true,photos})}<button class="btn gold" type="submit">保存空间信息</button></form>`);
    const form=root.querySelector('form'),read=bindFields(form,p,photos,false);form.onsubmit=async event=>{event.preventDefault();read();const button=form.querySelector('[type=submit]');button.disabled=true;try{await request('/api/space-presentation/'+enc(sid),{method:'PUT',body:{version:p.version,...Object.fromEntries(['theme','startDate','endDate','place','coverPhotoId'].map(k=>[k,p[k]]))}});if(valid(token,owner))go('shared-space/'+sid);}catch(error){if(valid(token,owner)){tell(copy(error));button.disabled=false;}}};
  }
  function destroy(){generation++;controller?.abort();cleanup();cleanup=()=>{};community.destroy();discovery.destroy();materialSurface?.destroy();legacy.destroy();closeDialog();root?.closest('.design-shell')?.classList.remove('v2-immersive','v2-focused','v2-discover-hall');if(root)root.onclick=null;}
  async function mount(target,route){
    destroy();root=target;currentRoute=route;controller=new AbortController();const token=generation,owner=user()?.id;
    currentView=createViewRequest(api,{signal:controller.signal,isCurrent:()=>valid(token,owner)});
    const {assertCurrent}=currentView;
    try {
      const [path,query='']=route.split('?'),params=new URLSearchParams(query);
      root.classList.remove('v2-legacy');
      if(path==='new-space'||path==='new'||path.startsWith('space-details/')||path.startsWith('space-materials/'))root.closest('.design-shell')?.classList.add('v2-focused');
      if(path==='spaces'||path==='my-spaces')await discovery.mount(root,route);
      else if(path.startsWith('community-author/')||path.startsWith('community-space/')||path.startsWith('publish-space/')||path==='community-submissions')await community.mount(root,route);
      else if(route==='new-space'||route==='new'||route==='new-space?kind=collection')await create();
      else if(path.startsWith('space-materials/'))await materials(path.slice(16));
      else if(path.startsWith('space-details/'))await edit(path.slice(14));
      else if(path.startsWith('shared-space/')&&!params.has('photo')&&!params.has('photoId')&&(!params.has('tab')||['photos','scene'].includes(params.get('tab'))))await detail(path.slice(13),params.get('view')||(params.get('tab')==='scene'?'scene':''));
      else if(path.startsWith('space/')&&path.split('/').length>2){const [,sid,mode]=path.split('/');await detail(sid,mode);}
      else {await legacy.mount(root,route);assertCurrent();if(!root.isConnected)return;root.classList.add('v2-legacy');const previous=root.onclick;root.onclick=event=>{const b=event.target.closest('[data-v2-route]');if(b){event.stopPropagation();go(b.dataset.v2Route);}else previous?.(event);};}
    } catch(error){if(valid(token,owner)&&error.name!=='AbortError'){frame(head('回忆空间','spaces')+`<div class="glass v2-empty"><p>${esc(copy(error))}</p>${routeButton(currentRoute,'重新打开','btn gold')}</div>`);}}
  }
  return {mount,destroy,resumeSave:()=>legacy.resumeSave()};
}
