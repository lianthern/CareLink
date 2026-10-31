import { designHero, designTitle } from './moment-design.js';
import { createMomentCaptureDrafts } from './moment-capture-drafts.js';
import { mergeAccountSpaces } from './moment-space-list.js';
import { createMomentSharedSpaces } from './moment-shared-spaces.js';
import { versionPublicItem } from './app-originals.js';
import { previewImage } from './app-thumbnails.js';
import { createMomentWorld } from './moment-world.js';
import { retainSpatialRevision, restoreSpatialRevision } from './moment-spatial-history.js';
import { mountMomentParticles } from './moment-particles.js';
import { mountAppSpatial } from './unseen-app-spatial.js';
import { parseDepthImport } from './spatial-contract/import.js';
import { createAccountSurface } from './unseen-app-account.js';
import { UnseenAccountApi } from './unseen-account-api.js';
const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const encode = encodeURIComponent;
const copy = error => ({ depth_source_mismatch:'全景与深度元数据不配对。请选同一场景的原文件，保留全景原文件名。',depth_pair_required:'请同时选择深度 PNG 和元数据 JSON。',depth_dimensions_invalid:'图片尺寸不符合要求：全景和深度图都应为 2:1。',depth_metadata_invalid:'深度元数据无效，请检查格式、尺寸和 min/max。',spatial_import_busy:'正在处理上一份空间，请稍后重试。',spatial_import_conflict:'同一份导入已保存过不同内容，请新建一份导入。',account_changed:'账号发生变化。素材已保留，请回到原账号继续。',spatial_file_too_large:'每个图片文件不能超过 12 MB。',panorama_decode_rejected:'全景无法读取，请选择 1600×800 至 8192×4096 的 2:1 全景。',media_decode_rejected:'深度图无法读取，请选择完整的 PNG 文件。',spatial_file_type:'全景支持 JPEG、PNG、WebP；深度支持 PNG。',session_unavailable:'登录已失效，素材仍在，请重新登录保存。'}[error.code] || `暂时没有完成（${error.code || error.message || '连接失败'}）。素材保留，可重试。`);
const hash = async blob => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(b=>b.toString(16).padStart(2,'0')).join('');
const imageInfo = async blob => { const url=URL.createObjectURL(blob);try{const img=new Image();img.src=url;await img.decode();return {width:img.naturalWidth,height:img.naturalHeight};}finally{URL.revokeObjectURL(url);} };
const fileBody = blob => new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve({name:blob.name,mimeType:blob.type,dataBase64:reader.result.split(',')[1]});reader.onerror=reject;reader.readAsDataURL(blob);});
let dbPromise;
export async function drafts(method, value) {
  const db=await (dbPromise ||= new Promise((resolve,reject)=>{const r=indexedDB.open('unseen-spatial-drafts',1);r.onupgradeneeded=()=>r.result.createObjectStore('drafts',{keyPath:'id'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);}));
  return new Promise((resolve,reject)=>{const tx=db.transaction('drafts',method==='getAll'?'readonly':'readwrite');const table=tx.objectStore('drafts');let r,conflict=false;
    if(method==='put'){r=table.get(value.id);r.onsuccess=()=>{const prior=r.result;if(prior&&prior.accountId!=='guest'&&prior.accountId!==value.accountId){conflict=true;tx.abort();return;}r=table.put(value);};}else r=table[method](...(value===undefined?[]:[value]));
    tx.oncomplete=()=>resolve(r.result);tx.onabort=tx.onerror=()=>reject(conflict?{code:'account_changed'}:tx.error);});
}
// Claim a local guest draft in one IndexedDB transaction; concurrent tabs cannot
// attach the same local files to two different accounts.
async function claimDraft(draft, owner) {
  const db=await dbPromise;
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('drafts','readwrite'), table=tx.objectStore('drafts'), read=table.get(draft.id);
    let conflict=false;
    read.onsuccess=()=>{const prior=read.result;if(prior&&prior.accountId!=='guest'&&prior.accountId!==owner){conflict=true;tx.abort();return;}draft.accountId=owner;table.put(draft);};
    tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(conflict?{code:'account_changed'}:tx.error);
  });
}

export function createMomentSpaces({ api, user, guest, navigate, login, photo, onError, fidelity=false }) {
  let root, aborter, dispose=()=>{}, sceneDispose=()=>{}, generation=0, draft=null, viewer=null, savingId=null;
  let catalogReturn='cases', collectionDraft={title:'',consent:false,key:null};
  const captureSurface=createMomentCaptureDrafts({drafts,user,guest,navigate,api,login});
  const sharedSurface=createMomentSharedSpaces({api,user,guest,navigate,login,onError,fidelity});
  const localUrls=[];
  const worldSurface=createMomentWorld({navigate:route=>go(route),showScene,drafts,api,user,guest,login});
  const request=(path,options={})=>api.request(path,{...options,signal:aborter.signal});
  const header=(title,back='spaces')=>`<header class="spatial-heading nav"><button class="ib" data-spatial-route="${back}" aria-label="返回">←</button><h1>${esc(title)}</h1></header>`;
  const go=route=>navigate(route);
  const busy=message=>{const el=root?.querySelector('[data-spatial-status]');if(el)el.textContent=message;};
  const wrap=html=>{root.innerHTML=html+'<p class="spatial-feedback" role="status" data-spatial-status></p>';};
  const previewUrl=file=>{const url=URL.createObjectURL(file);localUrls.push(url);return url;};
  async function accountSpaces() {
    if(guest())return [];
    const [canonical,imports]=await Promise.all([request('/v1/me/spaces'),request('/v1/app-spaces')]);
    return mergeAccountSpaces(canonical.spaces,imports.spaces);
  }
  const spaceCards=entries=>entries.map(item=>`<button class="spatial-card" data-spatial-route="${esc(item.route)}">${item.panorama?`<img src="${esc(item.panorama.url)}" alt="${esc(item.title)}" loading="lazy">`:'<div class="spatial-card-empty" aria-hidden="true">◫</div>'}<span><small>${item.owner?'我创建的':'共同参与'} · ${item.depth?'DAP 空间':item.panorama?'360 全景':'照片与故事'}</small><strong>${esc(item.title)}</strong><p>${item.effectiveCanView?(item.sharingState==='shared'?'按邀请权限访问':'私人保存，分享由你开启'):'可上传照片 · 无权查看他人内容'}</p></span></button>`).join('');
  function showCreateChoices(params) {
    const target=params.get('spaceId'),suffix=target?'&spaceId='+encode(target):'';
    wrap(header('用手头的素材，留下空间','spaces')+`<p class="empty-note">同一个空间里，可以慢慢积累照片、原话与不同版本的现场。</p><section class="spatial-grid spatial-create-choices">${[
      ['panorama','全景照片','一张完整全景，上传后就能环顾现场。可导入配套 DAP 深度成果。','new-space?kind=panorama'+suffix],
      ['world','多张照片','同一处现场的多个角度，由 AI 补成可探索的空间；补全部分可能与实景不同。','world-create'+(target?'?spaceId='+encode(target):'')],
      ['phone','手机视频','边走边拍，重建拍到的现场。先保留采集草稿，当前尚未连接训练算力。','capture-space?mode=perspective'+suffix],
      ['panoramic','全景相机采集','移动全景视频，或不同位置拍的多张全景照片。覆盖更广，采集质量仍需检查。','capture-space?mode=panoramic'+suffix]
    ].map(([kind,title,description,route])=>`<button class="spatial-card" data-spatial-route="${route}"><span><small>${kind==='phone'||kind==='panoramic'?'采集草稿 · 重建待开放':'选择素材'}</small><strong>${title}</strong><p>${description}</p></span></button>`).join('')}</section>${target?'':`<div class="glass design-empty"><p>还没有底图也没关系，先给空间起名字，和大家收集照片。</p><button class="btn ice" data-spatial-route="new-space?kind=collection">先收集照片</button></div>`}`);
  }
  async function showCollection(valid) {
    wrap(header('先给照片一个空间','new-space')+`<form data-collection-create><label class="field">空间名称<input name="title" maxlength="120" required value="${esc(collectionDraft.title)}" placeholder="例如：周末的家宴"></label><p>先私有保存。创建后可分别开启查看或上传邀请，也可以之后补全景现场。</p><label class="spatial-consent"><input name="consent" type="checkbox" required ${collectionDraft.consent?'checked':''}>我有权建立这个空间，分享前会确认照片与内容的使用范围。</label><button class="primary">${guest()?'登录并创建':'创建空间'}</button></form>`);
    const form=root.querySelector('[data-collection-create]');
    form.oninput=()=>{collectionDraft.title=form.elements.title.value;collectionDraft.consent=form.elements.consent.checked;};
    form.onsubmit=async event=>{
      event.preventDefault();if(!valid())return;
      collectionDraft.title=form.elements.title.value.trim();collectionDraft.consent=form.elements.consent.checked;
      if(!collectionDraft.title||!collectionDraft.consent)return;
      if(guest()){await login('spatial');return;}
      const owner=user().id,button=form.querySelector('button');button.disabled=true;
      try{
        const notice=await request('/v1/notices/current?purpose=space_create');if(!valid()||owner!==user()?.id)return;
        collectionDraft.key ||= crypto.randomUUID();
        const result=await request('/v1/spaces',{method:'POST',body:{name:collectionDraft.title},key:collectionDraft.key,notice,accountId:owner});
        if(!valid()||owner!==user()?.id)return;
        collectionDraft={title:'',consent:false,key:null};go('shared-space/'+encode(result.spaceId)+'?tab=photos');
      }catch(error){if(valid()){busy(copy(error));button.disabled=false;}}
    };
  }
  async function catalog() { const r=await fetch('/api/app-catalog',{signal:aborter.signal,cache:'no-store'});if(!r.ok)throw new Error('案例目录暂时不可读');const entries=(await r.json()).cases,visible=new Set(entries.map(item=>item.id));return entries.map(item=>({...item,...(item.related?{related:item.related.filter(link=>visible.has(link.id))}:{})})); }
  async function mount(target,route) {
    captureSurface.destroy();sharedSurface.destroy();worldSurface.destroy();sceneDispose();sceneDispose=()=>{};dispose();viewer?.();viewer=null;aborter?.abort();localUrls.splice(0).forEach(URL.revokeObjectURL);root=target;root.onclick=null;aborter=new AbortController();const current=++generation;
    root.innerHTML='<p class="empty-note" role="status">正在打开…</p>';
    const valid=()=>current===generation&&!aborter.signal.aborted;
    const handler=event=>{const button=event.target.closest('button');if(button?.dataset.spatialRoute!==undefined)go(button.dataset.spatialRoute);};
    root.addEventListener('click',handler);dispose=()=>root?.removeEventListener('click',handler);
    try {
      if(route==='spaces') {
        const entries=await accountSpaces();if(!valid())return;
        wrap(header('回忆空间','')+`<div class="design-spaces-hero">${designHero()}</div><div class="design-spaces-actions"><button class="btn gold" data-spatial-route="new-space">创建回忆时刻</button><button class="btn ghost" data-spatial-route="cases?type=space">走进示例空间</button></div><div class="design-spaces-links"><button class="chip" data-spatial-route="my-spaces">我的空间</button><button class="chip" data-spatial-route="tasks">导入任务</button><button class="chip" data-spatial-route="world-tasks">World 任务</button><button class="secondary" data-spatial-route="capture-tasks">采集草稿</button></div>${designTitle('MY SPACES','留下的现场')}<section class="spatial-grid">${spaceCards(entries)}</section>${entries.length?'':`<div class="glass design-empty"><p>${guest()?'先选素材、看看效果，保存时再登录。':'还没有空间。用一张全景，留下眼前的现场。'}</p><button class="btn ice sm" data-spatial-route="new-space">留下我的空间</button></div>`}<div class="design-bottom-links"><button data-spatial-route="cases">查看全部真实案例 ›</button></div>`);
      } else if(route==='cases'||route.startsWith('cases?')) {
        const entries=await catalog();if(!valid())return;
        catalogReturn=route;
        const filter=new URLSearchParams(route.split('?')[1]||'').get('type')||'all';
        let examples=[];try{const r=await fetch('/api/moment-examples',{signal:aborter.signal});if(r.ok)examples=(await r.json()).examples;}catch{}if(!valid())return;
        const combined=[...entries,...examples.map(e=>({...e,route:'example/'+e.id,cover:e.coverPhotoUrl,label:'账号示例 · 照片与原话',intro:e.preview,category:'photo'}))];
        wrap(header('那些留下来的瞬间','')+`<p class="empty-note">一处现场，一张照片，或一整晚的故事。</p><div class="spatial-filters">${[['all','全部'],['space','空间现场'],['photo','照片与原话'],['book','纪念册与短片'],['history','项目历程']].map(([id,label])=>`<button class="secondary ${filter===id?'selected':''}" data-spatial-route="cases?type=${id}">${label}</button>`).join('')}</div><section class="spatial-grid">${combined.filter(c=>filter==='all'||c.category===filter).map(c=>`<button class="spatial-card" data-spatial-route="${c.route||'case/'+c.id}"><img ${previewImage(c.cover)} decoding="async" alt="${esc(c.title)}" loading="lazy"><span><small>${esc(c.label)}</small><strong>${esc(c.title)}</strong><p>${esc(c.intro)}</p></span></button>`).join('')}</section>`);
      } else if(route.startsWith('case/')) {
        if(fidelity&&new URLSearchParams(route.split('?')[1]||'').get('from')==='gallery')catalogReturn='spaces';else if(catalogReturn==='spaces')catalogReturn='cases';
        const id=route.slice(5).split('?')[0],entries=await catalog();if(!valid())return;const item=entries.find(c=>c.id===id);
        if(item)showCatalogItem(item);
        else wrap(header('案例暂不可见',catalogReturn)+'<div class="glass design-empty"><p>这个案例已隐藏或暂时无法查看。</p><button class="btn ghost" data-spatial-route="cases">返回案例列表</button></div>');
      } else if(route.startsWith('capture-space')||route.startsWith('capture-tasks')) {
        await captureSurface.mount(root,route);
      } else if(route.startsWith('shared-space/')||route.startsWith('join/')) {
        await sharedSurface.mount(root,route);
      } else if(route.startsWith('space/')) {
        if(guest()){await login('spatial');return;}
        const data=await request('/v1/app-spaces/'+encode(route.slice(6)));if(!valid())return;const item=data.space;
        await sharedSurface.mount(root,'shared-space/'+encode(item.spaceId));
      } else if(route==='my-spaces'||route==='tasks'||route==='tasks?archived=1') {
        const local=(await drafts('getAll')).filter(d=>d.kind!=='capture'&&d.kind!=='space-materials'&&(d.accountId===user()?.id || d.accountId==='guest'));
        const archived=route==='tasks?archived=1', taskRoute=route.startsWith('tasks');
        if(route==='my-spaces'&&guest()){await login('spatial');return;}
        const spaces=taskRoute?[]:await accountSpaces();if(!valid())return;
        if(!taskRoute)wrap(header('我的空间','me')+`<div class="spatial-filters"><button class="secondary" data-spatial-route="my-spaces">空间</button><button class="secondary" data-spatial-route="tasks">任务</button><button class="primary" data-spatial-route="new-space">＋ 创建空间</button><button class="secondary" data-spatial-route="world-tasks">World 任务</button><button class="secondary" data-spatial-route="capture-tasks">采集草稿</button></div><p class="empty-note">这里是你创建及有权持续参与的空间。临时邀请需要通过原链接再进入。</p><section class="spatial-grid">${spaceCards(spaces)}</section>${spaces.length?'':'<p class="empty-note">先创建一个空间收集照片，或用一张全景留下现场。</p>'}`);
        if(taskRoute){
          const list=local.filter(d=>Boolean(d.archivedAt)===archived);
          wrap(header(archived?'收起的空间草稿':'我的任务','me')+`<div class="spatial-filters"><button class="secondary" data-spatial-route="tasks">待处理</button><button class="secondary" data-spatial-route="tasks?archived=1">已收起与历史素材</button><button class="secondary" data-spatial-route="new-space?fresh=1">＋ 新草稿</button><button class="secondary" data-spatial-route="world-tasks">World 任务</button><button class="secondary" data-spatial-route="capture-tasks">采集草稿</button></div><p class="empty-note">收起和替换的素材仍保留在本机，可以恢复为新草稿。</p>`+list.map(d=>`<article class="spatial-task"><h2>${esc(d.title||'未命名空间')}</h2><p>${esc(archived?(d.historyReason||'已收起'):d.saved?'已保存到我的空间':d.error||'本机草稿 · 尚未提交')}</p>${archived?`<button class="secondary" data-restore-draft="${esc(d.id)}">恢复为新草稿</button>`:`<button class="secondary" data-spatial-route="${d.saved?'space/'+d.id:'new-space?draft='+d.id}">${d.saved?'打开空间':'继续导入'}</button><button class="text-button" data-archive-draft="${esc(d.id)}">收起本机记录</button>`}</article>`).join('')+(list.length?'':'<p class="empty-note">这里暂时没有草稿。</p>'));
          root.onclick=async event=>{const b=event.target.closest('button');if(!b||!valid())return;const id=b.dataset.archiveDraft||b.dataset.restoreDraft;if(!id)return;b.disabled=true;try{const item=local.find(d=>d.id===id);if(!item)return;if(b.dataset.archiveDraft){item.archivedAt=new Date().toISOString();await drafts('put',item);if(draft?.id===id)draft=null;if(valid())await mount(root,route);}else{const restored=await restoreSpatialRevision(drafts,item,{accountId:guest()?'guest':user().id});if(valid())go('new-space?draft='+restored.id);}}catch(error){if(valid()){busy(copy(error));b.disabled=false;}}};
        }
      } else if(route==='new-space'||route.startsWith('new-space?kind=collection')) {
        if(new URLSearchParams(route.split('?')[1]||'').get('kind')==='collection')await showCollection(valid);
        else showCreateChoices(new URLSearchParams());
      } else if(route==='world-create'||route.startsWith('world-create?')||route==='world-tasks'){await worldSurface.mount(root,route==='world-tasks',{spaceId:new URLSearchParams(route.split('?')[1]||'').get('spaceId'),fromMaterials:new URLSearchParams(route.split('?')[1]||'').get('from')==='materials'});
      } else if(route.startsWith('new-space')) {
        const params=new URLSearchParams(route.split('?')[1]||''),id=params.get('draft'),targetSpace=params.get('spaceId');const all=await drafts('getAll');if(!valid())return;
        if(id&&!all.some(d=>d.id===id&&[user()?.id,'guest'].includes(d.accountId)))throw {code:'spatial_unavailable'};
        draft=(id&&all.find(d=>d.id===id&&[user()?.id,'guest'].includes(d.accountId))) || (!id&&!new URLSearchParams(route.split('?')[1]||'').has('fresh')&&draft&&!draft.saved&&!draft.archivedAt&&(draft.spaceId||null)===(targetSpace||null)&&[user()?.id,'guest'].includes(draft.accountId)?draft:null) || {id:crypto.randomUUID(),accountId:guest()?'guest':user().id,title:'',createdAt:new Date().toISOString()};
        if(draft.archivedAt){draft=await restoreSpatialRevision(drafts,draft,{accountId:guest()?'guest':user().id});if(!valid())return;}
        if(targetSpace){
          if(guest()){await login('spatial');return;}
          if(draft.spaceId&&draft.spaceId!==targetSpace)throw {code:'spatial_source_conflict'};
          const info=await request('/v1/spaces/'+encode(targetSpace)+'/management');if(!valid())return;
          draft.spaceId=targetSpace;draft.spaceVersion=info.version;draft.sceneIfMatchVersion=info.sceneVersion;
          if(!draft.title)draft.title=info.name;
        }
        history.replaceState(history.state,'',(/^\/app-v2\/?$/.test(location.pathname)?'/app-v2':'/app')+'#new-space?draft='+draft.id);
        await drafts('put',draft);if(valid())showImport();
      } else wrap(header('没有找到这个入口','')+'<p>请返回首页重试。</p>');
    } catch(error) { if(valid()){wrap(header('这里暂时没有打开','')+`<p class="inline-error">${esc(copy(error))}</p><button class="secondary" data-spatial-route="${esc(route)}">重试</button>`);onError?.(error);} }
  }
  function showCatalogItem(item) {
    if(item.type==='chapters') {
      const index=Number(new URLSearchParams(location.hash.split('?')[1]||'').get('chapter'))||0;
      const chapter=item.chapters[index]||item.chapters[0];
      showScene({...item,...chapter,title:item.title+' · '+chapter.title},catalogReturn);
      const menu=document.createElement('div');menu.className='spatial-filters';menu.innerHTML=item.chapters.map((c,i)=>`<button class="secondary ${i===index?'selected':''}" data-chapter="${i}">${esc(c.title)}</button>`).join('');
      root.querySelector('[data-scene-stage]').before(menu);
      menu.onclick=e=>{const b=e.target.closest('[data-chapter]');if(b){history.replaceState(null,'',`${/^\/app-v2\/?$/.test(location.pathname)?'/app-v2':'/app'}#case/${item.id}?chapter=${b.dataset.chapter}${fidelity&&catalogReturn==='spaces'?'&from=gallery':''}`);showCatalogItem(item);}};
      if(item.map){const img=document.createElement('img');img.className='spatial-map';img.src=item.map;img.alt='原婚礼流程示意地图';root.querySelector('.spatial-source').append(img);}
      return;
    }
    if(item.type==='particles'){wrap(header(item.title,catalogReturn)+`<p class="spatial-notice">${esc(item.notice)}</p><canvas class="spatial-particles"></canvas><label class="field">让回忆逐渐清晰<input type="range" min="0" max="100" value="30"></label>`);const effect=mountMomentParticles({canvas:root.querySelector('canvas'),src:item.cover,progress:.3});viewer=()=>effect.destroy();root.querySelector('input').oninput=e=>effect.setProgress(Number(e.target.value)/100);return;}
    if(item.type==='video') {wrap(header(item.title,catalogReturn)+`<p class="spatial-notice">${esc(item.notice)}</p><video class="spatial-video" controls playsinline preload="metadata" poster="${esc(item.cover)}" src="${esc(item.video)}"></video><p class="spatial-source">${esc(item.source)}</p>`);return;}
    if(item.type==='article') {wrap(header(item.title,catalogReturn)+`<p class="spatial-notice">${esc(item.notice)}</p><article class="spatial-article">${item.sections.map(p=>p.heading?`<h2>${esc(p.text)}</h2>`:`<p>${esc(p.text)}</p>`).join('')}</article><div class="spatial-filters">${(item.related||[]).map(link=>`<button class="secondary" data-spatial-route="case/${esc(link.id)}">${esc(link.title)} →</button>`).join('')}</div><p class="spatial-source">${esc(item.source)}</p>`);return;}
    if(item.type==='album') {let index=0;wrap(header(item.title,catalogReturn)+`<p class="spatial-notice">${esc(item.notice)}</p><div class="spatial-filters"><button class="secondary" data-album-mode="album">相册</button><button class="secondary" data-album-mode="timeline">时光轴</button></div><figure data-album-selected><img class="spatial-original" src="${esc(item.photos[0].src)}"><figcaption>${esc(item.photos[0].chapter)}</figcaption></figure><div class="spatial-grid" data-album-grid>${item.photos.map((p,i)=>`<button class="spatial-card" data-album-photo="${i}"><img src="${esc(p.src)}" loading="lazy"><span>${esc(p.chapter)} · ${esc(p.title)}</span></button>`).join('')}</div>`);root.onclick=e=>{const b=e.target.closest('button');if(b?.dataset.albumPhoto!==undefined){index=Number(b.dataset.albumPhoto);const p=item.photos[index];root.querySelector('[data-album-selected]').innerHTML=`<img class="spatial-original" src="${esc(p.src)}"><figcaption>${esc(p.chapter)} · ${esc(p.title)}</figcaption>`;}if(b?.dataset.albumMode)root.querySelector('[data-album-grid]').classList.toggle('timeline',b.dataset.albumMode==='timeline');};return;}
    showScene(item,catalogReturn);
  }
  function showScene(item,back) {
    item=versionPublicItem(item);
    sceneDispose();viewer?.();viewer=null;
    const space=item.space,hasDepth=space.kind==='dap',isWorld=space.kind==='world';
    wrap(header(item.title,back)+`<p class="spatial-notice">${esc(item.notice||item.label||'只读示例')}</p><div class="spatial-filters" aria-label="观看方式">${isWorld?'<button class="primary" data-scene-mode="world">3D 空间</button>'+(space.panorama?'<button class="secondary" data-scene-mode="image">原图</button><button class="secondary" data-scene-mode="360">360 环视</button>':''):'<button class="secondary" data-scene-mode="image">原图</button><button class="secondary" data-scene-mode="360">360 环视</button>'}${hasDepth?'<button class="primary" data-scene-mode="dap">空间探身</button>':''}<button class="secondary" data-scene-full>最大化</button></div><div data-scene-stage></div><div class="spatial-photo-strip">${(item.photos||[]).map((p,i)=>`<button data-scene-photo="${i}" aria-label="回到${esc(p.title)}"><img src="${esc(p.src)}" alt="${esc(p.title)}"><span>${esc(p.title)}</span></button>`).join('')}</div><details class="spatial-source"><summary>关于这处现场</summary><p>${esc(item.source||'你上传的原始素材')}</p><p>${esc(item.notice||'')}</p></details>`);
    const stage=root.querySelector('[data-scene-stage]');
    const view=kind=>{viewer?.();viewer=null;root.querySelectorAll('[data-scene-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.sceneMode===kind)));if(kind==='image')stage.innerHTML=`<img class="spatial-original" src="${esc(space.panorama||space.src)}" alt="${esc(item.title)}全景原图">`;else viewer=mountAppSpatial({...space,kind,container:stage,signal:aborter.signal,authenticity:item.source,onExit:()=>go(back)});};
    const handler=event=>{const b=event.target.closest('button');if(!b)return;if(b.dataset.sceneMode)view(b.dataset.sceneMode);if(b.hasAttribute('data-scene-full')){stage.classList.toggle('expanded');b.textContent=stage.classList.contains('expanded')?'收起画面':'最大化';if(stage.classList.contains('expanded')){const close=document.createElement('button');close.className='secondary spatial-full-close';close.textContent='收起画面';close.onclick=()=>{stage.classList.remove('expanded');close.remove();b.textContent='最大化';};stage.prepend(close);}}if(b.dataset.scenePhoto!==undefined){const p=item.photos[Number(b.dataset.scenePhoto)];if(!viewer)view(hasDepth?'dap':'360');viewer.ready.then(()=>viewer?.lookAt?.(p.yaw,p.pitch));}};
    const sceneRoot=root;sceneRoot.addEventListener('click',handler);sceneDispose=()=>sceneRoot.removeEventListener('click',handler);view(space.kind);
  }
  async function showActivity(page) {
    const current=generation;const valid=()=>current===generation;
    const surface=createAccountSurface({api:new UnseenAccountApi({invitationViewer:true}),onNavigate:async next=>{if(next.route==='case-return')return go('case/'+next.caseId);const html=await surface.render(next);if(valid()){wrap(html);surface.bind(root);}},onViewer:options=>showScene({title:'AdventureX 现场',space:{...options,kind:'360',panorama:options.panoramaUrl&&(options.panoramaUrl.includes('?')?options.panoramaUrl:options.panoramaUrl+'?access=invitation')},photos:[],source:'AdventureX 2026 公开活动'},'case/adventurex')});
    const html=await surface.render(page);if(!valid()){surface.destroy();return;}wrap(html);surface.bind(root);const prev=dispose;dispose=()=>{surface.destroy();prev();};
  }
  function showImport() {
    viewer?.();viewer=null;
    wrap(header(draft.spaceId?'更新这处现场':'留下我的空间',draft.spaceId?'shared-space/'+encode(draft.spaceId):'new-space')+`<p class="empty-note">先在这里选素材、看看效果。保存到账号时再登录。</p><form data-spatial-import><label class="field">空间名称<input name="title" maxlength="120" value="${esc(draft.title)}" placeholder="例如：午后的咖啡馆" required></label><label class="field">2:1 全景图<input name="panorama" type="file" accept="image/jpeg,image/png,image/webp"><small>${esc(draft.panorama?.name||'JPEG、PNG 或 WebP · 1600×800 至 8192×4096 · 最多 12 MB')}</small></label><details ${draft.depth?'open':''}><summary>导入已生成的 DAP 成果</summary><label class="field">深度 PNG<input name="depth" type="file" accept="image/png"><small>${esc(draft.depth?.name||'与全景配对的 2:1 深度图 · 最多 12 MB')}</small></label><label class="field">元数据 JSON<input name="metadata" type="file" accept="application/json,.json"><small>${esc(draft.metadataName||'历史 DAP min/max 或 canonical linear-red-v1')}</small></label><p>保留全景原文件名，选择同一场景、同一版本的三个文件。仅引用本次选择的素材。</p><button type="button" class="secondary" data-import-clear-depth>移除已选深度</button><a href="/app-spatial/v1/chapel_day.jpg" download>教堂全景</a> · <a href="/app-spatial/v1/chapel_day-depth.png" download>深度 PNG</a> · <a href="/app-spatial/v1/chapel_day-depth.json" download>元数据 JSON</a></details><div data-import-preview>${draft.panorama?`<img class="spatial-import-preview" src="${previewUrl(draft.panorama)}" alt="已选全景">`:''}</div><label class="spatial-consent"><input name="consent" type="checkbox" ${draft.consent?'checked':''} required>我有权上传这些素材，并同意将它们私有保存到自己的账号。</label><div class="spatial-filters"><button type="button" class="secondary" data-import-preview-button>预览空间</button><button class="primary">${guest()?'登录并保存':draft.spaceId?'更新现场，保留照片与邀请':'保存到我的空间'}</button></div><p>只上传全景会保存为 360 环视。在线 DAP 生成尚未开放；当前可导入已生成成果。</p><button type="button" class="secondary" data-spatial-route="world-create${draft.spaceId?'?spaceId='+encode(draft.spaceId):''}">从照片生成 World →</button><p class="inline-error">${esc(draft.error||'')}</p><button type="button" class="text-button" data-spatial-route="new-space?fresh=1">另开一份草稿，保留当前素材</button></form>`);
    const form=root.querySelector('form'),editing=draft,current=generation;
    const valid=()=>current===generation&&editing===draft;
    form.addEventListener('input',event=>{if(event.target.name==='title')editing.title=event.target.value;if(event.target.name==='consent')editing.consent=event.target.checked;drafts('put',editing).catch(error=>{if(valid())busy(copy(error));});});
    form.addEventListener('change',async event=>{const file=event.target.files?.[0];if(!file)return;try{editing.error='';await retainSpatialRevision(drafts,editing,'替换素材前的草稿');if(event.target.name==='metadata'){if(file.size>1024*1024)throw new Error('元数据不能超过 1 MB');editing.metadata=JSON.parse(await file.text());editing.metadataName=file.name;}else{if(file.size>12*1024*1024)throw {code:'spatial_file_too_large'};editing[event.target.name]=file;}await drafts('put',editing);if(valid())showImport();}catch(error){busy(copy(error));}});
    root.querySelector('[data-import-preview-button]').onclick=async()=>{try{await validateDraft(editing);if(!valid())return;const stage=root.querySelector('[data-import-preview]');viewer?.();viewer=mountAppSpatial({container:stage,kind:draft.depth?'dap':'360',panorama:previewUrl(draft.panorama),panoramaName:draft.panorama.name,depth:draft.depth?previewUrl(draft.depth):null,depthMetadata:draft.metadata,authenticity:'本机预览 · 尚未保存'});}catch(error){busy(copy(error));}};
    root.querySelector('[data-import-clear-depth]').onclick=async()=>{try{await retainSpatialRevision(drafts,editing,'移除深度前的完整素材');editing.depth=null;editing.metadata=null;editing.metadataName='';editing.error='';await drafts('put',editing);if(valid())showImport();}catch(error){if(valid())busy(copy(error));}};
    form.onsubmit=async event=>{event.preventDefault();await saveDraft();};
  }
  async function validateDraft(draft) {
    if(!draft.panorama)throw new Error('请先选择全景图');
    const pano=await imageInfo(draft.panorama);if(pano.width!==pano.height*2||pano.width<1600||pano.width>8192)throw {code:'panorama_decode_rejected'};
    if(!draft.depth !== !draft.metadata)throw {code:'depth_pair_required'};
    if(draft.depth)parseDepthImport(draft.metadata,{panorama:pano,depth:await imageInfo(draft.depth),panoramaName:draft.panorama.name,panoramaSha256:await hash(draft.panorama),depthSha256:await hash(draft.depth)});
    await drafts('put',draft);
  }
  async function saveDraft() {
    const saving=draft,owner=user()?.id,current=generation;if(!saving||savingId)return;savingId=saving.id;try{
      await validateDraft(saving);if(guest()){await login('spatial-save');return;}
      if(saving.accountId!=='guest'&&saving.accountId!==owner)throw {code:'account_changed'};
      saving.state='uploading';await claimDraft(saving,owner);busy('正在上传并校验空间…');
      root.querySelectorAll('form input,form button').forEach(el=>el.disabled=true);
      const payload={title:saving.title,consent:saving.consent===true,panorama:await fileBody(saving.panorama),...(saving.depth?{depth:await fileBody(saving.depth),metadata:saving.metadata}:{}),...(saving.spaceId?{spaceId:saving.spaceId,sceneIfMatchVersion:saving.sceneIfMatchVersion}:{})};
      const result=await api.request('/v1/app-spaces/'+saving.id,{method:'PUT',body:payload,key:saving.id,version:saving.spaceVersion,accountId:owner,signal:AbortSignal.timeout(120000)});
      saving.saved=true;saving.spaceId=result.space.spaceId;saving.state='ready';saving.error='';await drafts('put',saving);if(user()?.id===owner&&current===generation)go('shared-space/'+encode(result.space.spaceId));
    } catch(error){saving.error=copy(error);await drafts('put',saving).catch(()=>{});if(current===generation){busy(saving.error);root?.querySelectorAll('form input,form button').forEach(el=>el.disabled=false);}}finally{savingId=null;}
  }
  return { mount, destroy(){generation++;captureSurface.destroy();sharedSurface.destroy();worldSurface.destroy();sceneDispose();sceneDispose=()=>{};aborter?.abort();viewer?.();viewer=null;dispose();localUrls.splice(0).forEach(URL.revokeObjectURL);}, resumeSave:saveDraft };
}
