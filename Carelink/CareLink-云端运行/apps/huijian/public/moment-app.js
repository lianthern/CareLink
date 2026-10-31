import { spatialRoutes } from './moment-home.js';
import { GUEST_ACCOUNT, newId, newMoment, appendMessage, mergeMoment, messageTextHistory, momentTitle, momentPreview, safeMediaUrl, MomentApi, openMomentCache, blobToDataUrl, preparePhoto } from './moment-data.js';
import { createMomentVoice } from './moment-voice.js';
import { mountMomentParticles } from './moment-particles.js';
import { createTurnVoicePlayer } from './turn-voice.js';
import { fetchExamples, examplesGallery, exampleScreen } from './moment-examples.js';
import { statusLabel, snapshotHtml, submissionMedia, moderationError } from './moment-moderation.js';
import { communityHome, communityAuthorCredit } from './moment-community.js';
import { spaceLoadingScreen } from './moment-space-loading.js';

import { designNav, designHeader, designShell, designDeco, designTitle, designHome, designLibrary, designCapture, designReview } from './moment-design.js';
import { normalizeMomentSuggestions, fallbackMomentSuggestions, suggestionsHtml } from './moment-suggestions.js';
import { createMomentExport, describeExportError } from './moment-export.js';
import { mountMomentRecovery } from './moment-recovery.js';
import { collectLibraryPhotos, filterLibraryPhotos, selectedPhotoRefs, photoLibraryTabs, photoLibraryStyles, photoLibraryScreen, photoDetailScreen, photoCaptureScreen, photoLibraryCaption, photoDetailAssociations } from './moment-photo-library.js';
import { createFamilyFrame } from './moment-family-frame.js';

const isV2 = /^\/app-v2\/?$/.test(location.pathname);
const appPath = isV2 ? '/app-v2' : '/app';
if(isV2)document.documentElement.classList.add('fidelity-app');
const root = document.querySelector('#moment-app'), dialogRoot = document.querySelector('#moment-dialog');
const photoInput = document.querySelector('#moment-photo-input'), cameraInput = document.querySelector('#moment-camera-input');
const api = new MomentApi(), cache = openMomentCache();
const escape = value => String(value ?? '').replace(/[&<>"']/g,c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icons = {
  plus:'<path d="M12 5v14M5 12h14"/>', back:'<path d="m14 5-7 7 7 7"/>', close:'<path d="m6 6 12 12M6 18 18 6"/>',
  mic:'<rect x="8" y="3" width="8" height="12" rx="4"/><path d="M5 11v1a7 7 0 0 0 14 0v-1M12 19v3M9 22h6"/>',
  photo:'<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-7 5 8"/>',
  book:'<path d="M12 5v16M3 4h5a4 4 0 0 1 4 2 4 4 0 0 1 4-2h5v15h-5a4 4 0 0 0-4 2 4 4 0 0 0-4-2H3z"/>',
  user:'<circle cx="12" cy="8" r="4"/><path d="M4 22v-3a8 8 0 0 1 16 0v3"/>', camera:'<path d="M3 7h4l2-3h6l2 3h4v14H3z"/><circle cx="12" cy="13" r="4"/>',
  keyboard:'<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M5 9h1m3 0h1m3 0h1m3 0h1M5 12h1m3 0h1m3 0h1m3 0h1M7 16h10"/>',
  send:'<path d="M12 19V5m-6 6 6-6 6 6"/>', play:'<path d="m8 4 12 8-12 8z"/>', stop:'<rect x="6" y="6" width="12" height="12" rx="2"/>',
  sound:'<path d="m11 4-6 5H2v6h3l6 5zM16 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  settings:'<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>',
  eye:'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12"/><circle cx="12" cy="12" r="3"/>', edit:'<path d="m14 5 5 5M4 20l5-1L20 8l-5-5L4 14z"/>',
  check:'<path d="m5 12 4 4L19 6"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.photo}</svg>`;
const ib = (action,name,label,extra='') => `<button class="icon-button" data-action="${action}" aria-label="${label}" ${extra}>${icon(name)}</button>`;
const date = value => { const d = new Date(value); return Number.isFinite(d.getTime()) ? new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric'}).format(d) : ''; };
const time = value => { const d = new Date(value); return Number.isFinite(d.getTime()) ? new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}).format(d) : ''; };
const seconds = value => `${Math.floor(value/60)}:${String(Math.floor(value%60)).padStart(2,'0')}`;
const sculpture = '<div class="photo-sculpture" aria-hidden="true"><i></i><i></i><i></i></div>';
const s = { user:null, items:[], view:'loading', record:null, photoIndex:0, textDraft:'', mode:'voice', uploads:[], busy:'', error:'', loginError:'', voice:{phase:'idle',elapsedMs:0}, continuous:true, armed:false, readReplies:true, speaking:false, pendingVoice:null, config:null, loading:false, epoch:0 };
s.examples=[];s.examplesLoading=true;s.examplesError=false;s.example=null;s.exampleIndex=0;
const records = new Map(), urls = new Map(), syncing = new Map(), cacheWrites = new Map();
s.nav = 0;
const isGuest = () => s.user?.id === GUEST_ACCOUNT;
let authIntent = null, loginAttempt = null;
let communityController = null;
let recoverySurface=null,exportJob=null;const exportUrls=new Set();
let photoDetailJob=null,photoDetailUrl='',photoSpacePicker=null,photoStoryPicker=null,photoPickerGeneration=0;
const selectedLibraryPhotos=new Set();
const isFamilyFrameRoute=hash=>/^#?family-frame(?:\/[A-Za-z0-9_-]{1,160})?(?:\?.*)?$/.test(String(hash||''));
const isSpatialRoute=hash=>(isV2 && /^#(?:new$|spaces(?:\?|$)|community-space\/|community-author\/|publish-space\/|community-submissions(?:\?|$)|space-materials\/|space-details\/|space\/)/.test(hash))||spatialRoutes(hash)||/^#(?:photo-scenes(?:\?|$)|shared-space\/|join\/|capture-space(?:\?|$)|capture-tasks(?:\?|$)|world-create(?:\?|$)|tasks\?)/.test(hash);
function claimIntent(value){try{if(value===undefined)return JSON.parse(localStorage.getItem('moment-claim-intent')||'null');if(value===null)localStorage.removeItem('moment-claim-intent');else localStorage.setItem('moment-claim-intent',JSON.stringify(value));}catch{return null;}}
let particle = null, particleKey = '', activeAudio = null, aiAbort = null, toastTimer, dialogFocus, playingId = null, speechTarget = null;
const messages = {
  draft_claimed:'这份草稿已在另一页保存到账号，请刷新后登录查看。',guest_heic_unsupported:'此浏览器暂时打不开这张 HEIC 照片，请改选 JPEG 或 PNG。原件仍保留在此设备。',
  username_invalid:'账号需为 3–32 位字母、数字、点、短横线或下划线。',username_already_exists:'这个账号已被使用，请换一个。',authentication_rate_limited:'尝试次数较多，请稍后再试。',password_invalid:'密码太短，请增加几个字符（至少 10 字节）。',password_too_long:'密码过长，请缩短一些（最多 256 字节，中文和表情会占多个字节）。',profile_invalid:'资料没有填写完整，请检查后再保存。',
  authentication_failed:'账号或密码不正确，请再试一次。', memory_storage_limit:'账号空间已满，这段内容仍保留在此设备。', password_login_failed:'账号或密码不正确，请再试一次。', invalid_credentials:'账号或密码不正确，请再试一次。', password_login_rate_limited:'尝试次数较多，请稍后再登录。',
  session_unavailable:'登录已失效，请重新登录。', account_pending:'账号正在等待审核，批准后即可登录。',account_rejected:'注册申请未通过审核。',account_disabled:'账号已停用。',account_changed:'账号已切换。当前内容已保留，请重新登录后继续。',
  photo_too_large:'这张照片超过 12 MB，请选择小一点的文件。', photo_format:'请选择照片文件。', photo_decode:'这张照片暂时打不开，请重新选择。',
  heic_conversion_required:'这张照片需要转换，正在准备…', media_decode_rejected:'暂时无法读取这张照片，请换一张 JPEG 照片。',
  storage_full:'账号空间不足，这段内容仍保留在此设备。', cache_unavailable:'这台设备无法保留待同步内容，请保持页面打开并重试。',
  version_conflict:'另一台设备更新了这段回忆，你的内容已保留。', transcription_not_configured:'这次没有识别出文字，原声已保留，可以重试或补充文字。',
  rate_limited:'稍等片刻再继续，刚才的话已经留下。', canonical_not_configured:'暂时无法连接账号，请稍后重试。',
  media_too_large:'这个文件太大，请选择较小的照片或缩短录音。', network_error:'网络暂时没连上，内容会在连接恢复后继续同步。'
};
const errorText = error => messages[error?.code] || (error?.status === 429 ? messages.rate_limited : error?.status === 401 ? messages.session_unavailable : '暂时没有完成，请重试。你的内容仍保留在此设备。');
function toast(text) { const el = document.querySelector('#moment-toast'); el.textContent=text; el.classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove('show'),4500); }
function current(record,epoch=s.epoch) { return s.epoch===epoch && s.user && record?.accountId===s.user.id; }
function visible(record,epoch=s.epoch,nav=s.nav) { return current(record,epoch)&&s.record===record&&s.view==='chat'&&s.nav===nav; }
function requireCurrent(record,epoch,signal) { if(!current(record,epoch)||signal?.aborted)throw new DOMException('Account or operation changed','AbortError'); }
function background(promise) { Promise.resolve(promise).catch(error=>{if(error?.name!=='AbortError')toast(errorText(error));}); }
function ownUrl(record,id,blob,epoch=s.epoch) { if(!current(record,epoch))return '';const previous=urls.get(id);if(previous)URL.revokeObjectURL(previous);const url=URL.createObjectURL(blob);urls.set(id,url);return url; }
const mediaCacheId = item => safeMediaUrl(item?.url).endsWith('/preview')?`preview-${item.mediaId}`:item?.mediaId;
function bindDrafts(record) { s.uploads=record.uploads ||= [];s.textDraft=record.textDraft||'';s.pendingVoice=record.pendingVoice||null;if(s.pendingVoice)s.pendingVoice.target={record,epoch:s.epoch,photoId:s.pendingVoice.photoId}; }
function photoFile(file,name=file?.name||'photo.jpg',type=file?.type) { const mime=type||({jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',heic:'image/heic',heif:'image/heif',gif:'image/gif'}[name.split('.').at(-1)?.toLowerCase()]||'application/octet-stream');return file instanceof File&&file.type===mime?file:new File([file],name,{type:mime}); }
function aiSource(moment,p) { return JSON.stringify({photoId:p?.id,photoUrl:p?.url,messages:messageTextHistory(moment)}); }
function photo() { return s.record?.moment.photos[s.photoIndex] || s.record?.moment.photos[0]; }
function mediaSource(item) { return urls.get(mediaCacheId(item) || item?.id) || safeMediaUrl(item?.url || item?.coverPhotoUrl) || ''; }
function avatar() { return `<button class="avatar" data-action="profile" aria-label="打开我的">${safeMediaUrl(s.user?.avatar) ? `<img src="${escape(s.user.avatar)}" alt="头像">` : escape((s.user?.displayName || s.user?.username || 'U').slice(0,1))}</button>`; }
function brand() { return `<button class="brand" data-action="home" aria-label="UNSEEN 回忆时刻首页"><span class="brand-mark">U</span><span><span class="brand-name">UNSEEN</span><span class="brand-sub">回忆时刻</span></span></button>`; }
function masthead() { return `<header class="masthead">${brand()}${avatar()}</header>`; }
function nav(selected) { return designNav(selected); }
function loginForm() { return `<p>${authIntent?.action==='save'?'照片、原声和文字会一起保存到你的账号。':'登录后，查看你已保存的私人回忆。'}${s.items.length&&isGuest()?(authIntent?.action==='save'?' 只保存当前这一段，其余草稿仍留在这台设备。':' 本机草稿会留在这台设备，不会自动放进账号。'):''}</p><form data-form="login"><label class="field">账号<input name="username" autocomplete="username" required maxlength="80" placeholder="输入你的账号" autocapitalize="none" spellcheck="false"></label><label class="field">密码<input type="password" name="password" autocomplete="current-password" required maxlength="256"></label><button class="primary full">登录并${authIntent?.action==='save'?'保存':'继续'}</button><button type="button" class="text-button full" data-action="recover-password">忘记密码？</button><button type="button" class="text-button full" data-action="register">还没有账号？立即注册</button><button type="button" class="text-button full" data-action="close-dialog">暂不登录，继续回忆</button><p class="form-status" role="status"></p></form>`; }
function card(item) { const src = mediaSource(item.photos?.[0]) || safeMediaUrl(item.coverPhotoUrl); return `<button class="memory-card" data-open="${escape(item.id)}">${src?`<img src="${escape(src)}" alt="${escape(momentTitle(item))}" loading="lazy">`:'<div class="memory-no-photo"></div>'}<div class="memory-card-copy"><small>${date(item.createdAt)} · ${item.photoCount ?? item.photos?.length ?? 0} 张照片</small><h3>${escape(momentTitle(item))}</h3><p>${escape(item.preview || momentPreview(item))}</p>${item.status==='active'?'<span class="tag active">继续聊</span>':''}</div></button>`; }
let spatialSurface, spatialModule, discoverySurface, discoveryModule, sceneSurface, sceneModule, spatialGeneration=0;
const familyFrame={
  surface:null,generation:0,
  destroy(){++this.generation;this.surface?.destroy();this.surface=null;},
  async mount(target,route){const generation=++this.generation;target.innerHTML='<div class="initial-loading" role="status">正在打开家庭相框…</div>';if(!s.user)return;const pending=this.surface||(this.surface=createFamilyFrame({api,user:()=>s.user,navigate:r=>background(navigateApp(r)),login:requestLogin}));try{await pending.mount(target,route);if(generation!==this.generation||!target.isConnected){pending.destroy();}}catch(error){if(generation===this.generation&&target.isConnected)target.innerHTML='<div class="ff-empty ff-empty-main" role="status"><h2>家庭相框暂时无法打开</h2><p>请检查连接后重试。</p><button class="btn ghost" data-action="family-frame">重新加载</button></div>';}}
};
const spaces = {
  destroy(){++spatialGeneration;spatialSurface?.destroy();discoverySurface?.destroy();sceneSurface?.destroy();},
  async mount(target,route){
    const generation=++spatialGeneration;
    const discovery=isV2&&/^(?:spaces|my-spaces)(?:\?|$)/.test(route);
    target.closest('.design-shell')?.classList.toggle('v2-discover-hall',isV2&&/^spaces(?:\?|$)/.test(route));
    target.innerHTML=isV2?spaceLoadingScreen(route):'<p class="empty-note" role="status">正在打开空间…</p>';
    target.onclick=event=>{const b=event.target.closest('[data-spatial-route]');if(b){event.stopPropagation();background(navigateApp(b.dataset.spatialRoute));}};
    // A direct space link gets its own shell while the account is checked.
    if(isV2&&!s.user)return;
    try {
      let timeout;const scenes=route.startsWith('photo-scenes');const pending=scenes?(sceneModule ||= import('./moment-photo-scenes.js').catch(error=>{sceneModule=null;throw error;})):discovery?(discoveryModule ||= import('./moment-space-discovery.js').catch(error=>{discoveryModule=null;throw error;})):(spatialModule ||= (isV2 ? import('./moment-v2-spaces.js') : import('./moment-spaces.js')).catch(error=>{spatialModule=null;throw error;}));
      const module=await Promise.race([pending,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('spatial_timeout')),12000);})]).finally(()=>clearTimeout(timeout));
      if(generation!==spatialGeneration||!target.isConnected)return;
      const context={api,user:()=>s.user,guest:isGuest,navigate:route=>background(navigateApp(route)),login:requestLogin,photo:()=>choosePhotos(true),materialLibrary:async()=>{await loadLibrary();await loadPhotoRecords();if(s.error)throw new Error(s.error);return libraryPhotos().map(entry=>({...entry,thumbnail:mediaSource(entry.photo)}));},readMaterialPhoto:readLibraryPhoto};
      const surface=scenes?(sceneSurface ||= module.createMomentSpaces(context)):discovery?(discoverySurface ||= module.createMomentSpaces(context)):(spatialSurface ||= module.createMomentSpaces(context));
      await surface.mount(target,route);
    } catch(error) {
      if(generation!==spatialGeneration||!target.isConnected)return;
      target.closest('.design-shell')?.classList.remove('v2-discover-hall');
      target.innerHTML='<div class="glass v2-empty" role="status"><h2>暂时没能打开空间</h2><p>检查连接后再试，你的回忆仍然保留。</p><button class="btn gold" data-action="retry-spatial">重新加载</button><button class="btn ghost" data-action="home">回到首页</button></div>';
    }
  },
  async resumeSave(){await spatialSurface?.resumeSave();}
};
let renderedRoute='',routeDispatch;const routeScroll=new Map();
function setRoute(route) { routeScroll.set(renderedRoute,window.scrollY||0); const next=appPath+(route?'#'+route:''); if(location.pathname+location.hash!==next)history.pushState({momentApp:true},'',next); }
async function navigateApp(route) {
  if(!s.user && route && !/^(?:cases(?:\?|$)|case\/|example\/|public(?:\/|$)|join\/)/.test(route)){const nav=s.nav;await bootSession;if(!s.user||s.nav>nav+1)return;}
  if(route==='library'||/^library\/(?:photos|stories)$/.test(route)){await goLibrary(route.split('/')[1]);return;}
  if(route.startsWith('photo/')){await openLibraryPhoto(decodeURIComponent(route.slice(6)));return;}
  if(route==='capture'){await goCapture();return;}
  if(route==='me'){await goProfile();return;}
  if(!route||route==='home'){await goHome();return;}
  if(isFamilyFrameRoute(route)){await goFamilyFrame(route);return;}
  if(isV2 && route==='new')route='new-space';
  if(route.startsWith('memory/')){const [id,mode]=route.slice(7).split('/');await openMoment(id,{review:mode==='review'});return;}
  if(route==='public'||route.startsWith('public/')){await openPublic(route.slice(7));return;}
  if(route.startsWith('example/')){await openExample(route.slice(8));return;}
  const epoch=s.epoch,nav=++s.nav;await stopAll();if(epoch!==s.epoch||nav!==s.nav)return;
  s.view='spatial';s.spatialRoute=route;setRoute(route);render();
}
function designData() { return {user:s.user,items:s.items.filter(item=>!item.archivedAt),avatar:avatar(),media:mediaSource,title:momentTitle,preview:momentPreview,date,loading:s.loading,error:s.error,guest:isGuest()}; }
function homeScreen() { return isV2 ? communityHome({avatar:avatar(),...s.community,date,loading:s.community?.loading ?? true}) : designHome(designData()); }
function libraryScreen() {
  const archived=s.items.filter(item=>item.archivedAt);
  if((s.libraryMode||'photos')==='photos'&&s.libraryFilter!=='archived'){
    const all=libraryPhotos(),entries=filterLibraryPhotos(all,{query:s.photoQuery,month:s.photoMonth});
    return photoLibraryScreen({entries,allEntries:all,media:mediaSource,query:s.photoQuery,month:s.photoMonth,selecting:s.photoSelecting,selectedKeys:[...selectedLibraryPhotos],loading:s.loading||s.photoLoading,error:s.error,guest:isGuest(),archivedCount:archived.length,pending:pendingLibraryPhotos()});
  }
  if(s.libraryFilter==='archived')return designShell(`${designHeader('已归档的回忆',`${archived.length} 段 · 照片与原话仍然保留`,'library-active')}<p class="design-spaces-intro">打开一段回忆即可恢复。归档不会撤回已经公开的投稿。</p>${s.error?`<p class="inline-error">${escape(s.error)}</p>`:''}<div class="examples-grid">${archived.map(card).join('')||'<p class="design-empty">还没有归档的回忆。</p>'}</div>`,{selected:'library'});
  const stories=designData();stories.items=stories.items.filter(item=>(item.messageCount??item.messages?.length??0)>0);
  return designLibrary({...stories,filter:s.libraryFilter||'all',query:s.libraryQuery||''}).replace('</header>',`</header>${photoLibraryStyles}${photoLibraryTabs('stories')}`).replace('</form>',`</form><button class="text-button" data-library-filter="archived">已归档的回忆（${archived.length}）</button>`);
}
async function goLibrary(mode) {const epoch=s.epoch,nav=++s.nav;await stopAll();if(epoch!==s.epoch||nav!==s.nav)return;clearPhotoDetail();s.libraryMode=mode||s.libraryMode||'photos';s.photoLoading=s.libraryMode==='photos';s.view='library';s.error='';setRoute(`library/${s.libraryMode}`);render();await loadLibrary();if(epoch===s.epoch&&nav===s.nav&&s.libraryMode==='photos')await loadPhotoRecords();}
async function goCapture() {const epoch=s.epoch,nav=++s.nav;await stopAll();if(epoch!==s.epoch||nav!==s.nav)return;closeDialog();s.view='capture';setRoute('capture');render();}
function libraryPhotos(){const listed=new Set(s.items.map(item=>item.id));return collectLibraryPhotos([...records.values()].filter(record=>isGuest()||record.dirty||listed.has(record.moment.id)),{accountId:s.user?.id});}
function pendingLibraryPhotos(){return [...records.values()].filter(record=>current(record)).flatMap(record=>(record.uploads||[]).filter(task=>!task.done).map(task=>({...task,momentId:record.moment.id})));}
async function loadPhotoRecords(){
  if(!s.user)return;const epoch=s.epoch,generation=s.photoLoadGeneration=(s.photoLoadGeneration||0)+1; s.photoLoading=true;
  try{
    const items=[...s.items];
    for(let offset=0;offset<items.length;offset+=4){
      await Promise.all(items.slice(offset,offset+4).map(async item=>{
        if(epoch!==s.epoch||generation!==s.photoLoadGeneration)return;let record=records.get(item.id);
        if(!isGuest()&&(!record||!record.dirty&&!record.saving&&record.version!==item.version)){
          const revision=record?.revision;const response=await api.request(`/v1/moments/${encodeURIComponent(item.id)}`,{accountId:s.user.id});if(epoch!==s.epoch||generation!==s.photoLoadGeneration)return;
          record=records.get(item.id);
          if(!record){record=restoreRecord({moment:response.moment,base:structuredClone(response.moment),version:response.version,dirty:false,revision:0},s.user.id);records.set(item.id,record);}
          else if(!record.dirty&&!record.saving&&record.revision===revision){record.moment=response.moment;record.base=structuredClone(response.moment);record.version=response.version;}
          await saveCache(record);
        }
        if(record)await hydrateMedia(record,epoch);
      }));
    }
  }catch(error){if(epoch===s.epoch&&generation===s.photoLoadGeneration&&error.name!=='AbortError')s.error=errorText(error);}
  finally{if(epoch===s.epoch&&generation===s.photoLoadGeneration){s.photoLoading=false;const keys=new Set(libraryPhotos().map(entry=>entry.key));for(const key of selectedLibraryPhotos)if(!keys.has(key))selectedLibraryPhotos.delete(key);if(['library','photo'].includes(s.view))render();}}
}
function clearPhotoDetail(){photoDetailJob?.abort();photoDetailJob=null;if(photoDetailUrl)URL.revokeObjectURL(photoDetailUrl);photoDetailUrl='';s.photoOriginalLoading=false;s.photoOriginalError='';s.photoOriginalDisplay=false;}
function currentLibraryPhoto(){return libraryPhotos().find(entry=>entry.key===s.libraryPhotoKey);}
function libraryPhotoSequence(){const all=libraryPhotos(),filtered=filterLibraryPhotos(all,{query:s.photoQuery,month:s.photoMonth});return filtered.some(entry=>entry.key===s.libraryPhotoKey)?filtered:all;}
function libraryPhotoDetail(){const entries=libraryPhotoSequence(),entry=currentLibraryPhoto();return photoDetailScreen({entry,index:entries.findIndex(p=>p.key===s.libraryPhotoKey),total:entries.length,media:mediaSource,originalUrl:photoDetailUrl,originalDisplay:s.photoOriginalDisplay,originalLoading:s.photoOriginalLoading,originalError:s.photoOriginalError,guest:isGuest()});}
async function readLibraryPhoto(ref,{signal}={}){
  const epoch=s.epoch,record=records.get(ref.momentId);if(!record||ref.accountId!==s.user?.id)throw {code:'account_changed'};
  requireCurrent(record,epoch,signal);const p=record.moment.photos.find(photo=>photo.id===ref.photoId);
  if(!p||p.mediaId!==ref.mediaId||p.originalMediaId!==ref.originalMediaId)throw {code:'photo_decode'};
  const id=p.originalMediaId||p.mediaId,stored=await boundedWait(cache.getMedia(record.accountId,id).catch(()=>null),signal);requireCurrent(record,epoch,signal);
  const blob=stored?.blob||await fetchOwnedBlob(record,`/v1/moment-media/${encodeURIComponent(id)}`,{epoch,signal});requireCurrent(record,epoch,signal);return blob;
}
async function openLibraryPhoto(key){
  const epoch=s.epoch,nav=++s.nav;await stopAll();if(epoch!==s.epoch||nav!==s.nav||!s.user)return;clearPhotoDetail();s.libraryPhotoKey=key;s.view='photo';setRoute(`photo/${encodeURIComponent(key)}`);render();
  if(!currentLibraryPhoto()){await loadLibrary();if(epoch!==s.epoch||nav!==s.nav)return;await loadPhotoRecords();}
  if(epoch!==s.epoch||nav!==s.nav)return;const entry=currentLibraryPhoto();if(!entry){render();return;}
  const control=photoDetailJob=new AbortController();s.photoOriginalLoading=true;render();
  try{const blob=await readLibraryPhoto(entry,{signal:control.signal});if(epoch!==s.epoch||nav!==s.nav||control.signal.aborted)return;photoDetailUrl=URL.createObjectURL(blob);s.photoOriginalDisplay=/^image\/(?:jpeg|png|webp|gif|avif)(?:;|$)/i.test(blob.type);}
  catch(error){if(epoch===s.epoch&&nav===s.nav&&!control.signal.aborted)s.photoOriginalError='原照片暂时无法读取。已保留的显示副本仍可查看，请稍后重试。';}
  finally{if(epoch===s.epoch&&nav===s.nav&&!control.signal.aborted){s.photoOriginalLoading=false;render();}}
}
async function talkLibraryPhoto(momentId,photoId){
  const entry=currentLibraryPhoto();const target=momentId?{momentId,photoId}:entry?.stories.find(story=>!story.archivedAt)||entry?.stories[0];if(!target)return;
  const epoch=s.epoch;await openMoment(target.momentId);if(epoch!==s.epoch||s.record?.moment.id!==target.momentId||s.view!=='chat')return;
  s.photoIndex=Math.max(0,s.record.moment.photos.findIndex(photo=>photo.id===target.photoId));
  if(!momentId&&!s.record.moment.archivedAt){if(s.record.moment.status==='complete')await change(s.record,m=>({...m,status:'active'}));if(epoch!==s.epoch||s.record?.moment.id!==target.momentId)return;s.review=false;setRoute(`memory/${encodeURIComponent(target.momentId)}`);}
  render({end:true});
}
async function savePhotoContributions(refs,result,epoch=s.epoch){
  if(epoch!==s.epoch||!s.user||typeof result?.spaceId!=='string')return false;
  const targets=new Map(refs.map(ref=>[ref.momentId,records.get(ref.momentId)]));
  for(const contribution of result.contributions||[]){
    const ref=refs.find(item=>item.key===contribution.refKey),record=ref&&targets.get(ref.momentId);
    if(!record||ref.accountId!==s.user.id||!current(record,epoch)||typeof contribution.photoId!=='string')continue;
    const p=record.moment.photos.find(photo=>photo.id===ref.photoId);if(!p||p.mediaId!==ref.mediaId||p.originalMediaId!==ref.originalMediaId)continue;
    await change(record,m=>({...m,photos:m.photos.map(photo=>photo.id===ref.photoId?{...photo,spaceLinks:[...(photo.spaceLinks||[]).filter(link=>link.spaceId!==result.spaceId||link.photoId!==contribution.photoId),{spaceId:result.spaceId,photoId:contribution.photoId}]}:photo)}));
    requireCurrent(record,epoch);await saveCache(record,{strict:true});
  }
  return epoch===s.epoch;
}
async function joinLibraryPhotos(refs){
  if(!refs.length)return;const epoch=s.epoch,accountId=s.user?.id;await stopAll();if(epoch!==s.epoch)return;
  showDialog('把照片加入空间','<div id="photo-space-picker"><p role="status">正在读取可加入的空间…</p></div>');const generation=++photoPickerGeneration;
  try{const module=await import('./moment-shared-spaces.js');if(epoch!==s.epoch||generation!==photoPickerGeneration||!dialogRoot.querySelector('#photo-space-picker'))return;
    photoSpacePicker=module.mountPhotoSpacePicker(dialogRoot.querySelector('#photo-space-picker'),{api,user:()=>s.user,refs,readPhoto:readLibraryPhoto,navigate:route=>{closeDialog();background(navigateApp(route));},onClose:closeDialog,onComplete:async result=>{
      if(epoch!==s.epoch||accountId!==s.user?.id)return;
      await savePhotoContributions(refs,result,epoch);
      if(epoch===s.epoch){updatePhotoAssociations();selectedLibraryPhotos.clear();s.photoSelecting=false;toast('所选照片已加入空间。私人聊天和原声没有一同分享。');}
    }});
  }catch(error){if(epoch===s.epoch&&generation===photoPickerGeneration){const node=dialogRoot.querySelector('#photo-space-picker');if(node)node.innerHTML='<p role="status">空间列表暂时无法读取。请关闭后重试，你的照片仍保留在回忆库。</p>';}}
}
async function shareLibraryPhotoStory(momentId,photoId){
  const entry=currentLibraryPhoto();if(!entry||isGuest())return;
  const source=momentId?entry.stories.find(story=>story.momentId===momentId&&story.photoId===photoId):entry.stories.find(story=>story.userCount)||entry.stories[0];
  if(!source)return;if(!entry.spaceLinks.length){toast('先把这张照片加入空间，再选择要分享的故事与原声。');return;}
  const epoch=s.epoch,nav=s.nav,accountId=s.user.id,record=records.get(source.momentId);
  if(!record||!current(record,epoch))return;
  await stopAll();if(epoch!==s.epoch||nav!==s.nav)return;
  if(record.dirty||record.saving)await sync(record);
  if(epoch!==s.epoch||nav!==s.nav||!current(record,epoch))return;
  if(record.dirty||record.saving||record.conflict||record.cloudMedia?.length||record.uploads?.some(task=>!task.done)){toast('请先完成这份回忆的账号保存，再选择要分享的内容。');return;}
  if(!record.moment.photos.some(photo=>photo.id===source.photoId))return;
  showDialog('选择这张照片的故事与原声','<div id="photo-story-picker"><p role="status">正在读取这张照片可分享的本人讲述…</p></div>');const generation=++photoPickerGeneration;
  const active=()=>epoch===s.epoch&&accountId===s.user?.id&&generation===photoPickerGeneration;
  try{const module=await import('./moment-photo-stories.js');if(!active()||!dialogRoot.querySelector('#photo-story-picker'))return;
    photoStoryPicker=module.mountPhotoStoryPicker(dialogRoot.querySelector('#photo-story-picker'),{api,user:()=>s.user,source:{momentId:record.moment.id,photoId:source.photoId},spaceLinks:entry.spaceLinks.map(link=>({...link})),
      onClose:()=>{if(active())closeDialog();},onComplete:()=>{if(active())toast('你明确选择的故事与原声已分享，私人回忆原稿继续保留。');},navigate:route=>{if(active()){closeDialog();background(navigateApp(route));}}});
  }catch(error){if(active()){const node=dialogRoot.querySelector('#photo-story-picker');if(node)node.innerHTML='<p role="status">可分享内容暂时无法读取，请关闭后重试。私人故事与原声仍保留在原回忆中。</p>';}}
}
async function reviewMemory() {if(!s.record)return;await stopAll();s.review=true;setRoute('memory/'+encodeURIComponent(s.record.moment.id)+'/review');render();}
function suggestedReplies() {const m=s.record?.moment,last=m?.messages.at(-1);if(s.busy||m?.status!=='active'||!last||last.role!=='assistant')return '';const history=messageTextHistory(m),choices=s.record.suggestionMessageId===last.id?normalizeMomentSuggestions(s.record.suggestions,history):[];return `<div class="reply-directions"><span>可以从这里说起，也可以自由输入</span><div class="chips">${suggestionsHtml(choices.length?choices:fallbackMomentSuggestions(last.text,history),{history})}</div></div>`;}
function modeControl(mode) { return `<div class="segmented" aria-label="照片显示方式"><button data-photo-mode="reveal" class="${mode==='reveal'?'selected':''}" aria-pressed="${mode==='reveal'}">渐渐清晰</button><button data-photo-mode="clear" class="${mode==='clear'?'selected':''}" aria-pressed="${mode==='clear'}">始终清晰</button></div>`; }
function preferencesHtml() { return `<div class="settings-row"><div>照片的样子<p>两种方式都会保留粒子流动</p></div>${modeControl(s.record&&s.view==='chat'?s.record.moment.preferences.photoMode:s.user.preferences?.photoMode || 'reveal')}</div><div class="settings-row"><div>读出回复<p>听着聊，也可以随时打断</p></div><button class="toggle" role="switch" aria-label="读出回复" aria-checked="${s.readReplies}" data-action="toggle-read"></button></div><div class="settings-row"><div>连续语音<p>说完自动发送，回复后接着听</p></div><button class="toggle" role="switch" aria-label="连续语音" aria-checked="${s.continuous}" data-action="toggle-continuous"></button></div>`; }
function profileScreen() { return designShell(`${designHeader('我的','把你想留下的，好好收着','')}<div class="design-account-heading">${avatar()}<div><h1>${escape(s.user.displayName || s.user.username || '我的')}</h1><p>${isGuest()?'尚未登录 · 草稿保存在这台设备':'@'+escape(s.user.username || 'unseen')}</p></div></div><section class="settings-panel"><h2>我的收藏</h2><div class="spatial-filters"><button class="secondary" data-action="open-library">${s.items.filter(item=>!item.archivedAt).length} 段回忆</button><button class="primary" data-spatial-route="my-spaces">我的空间</button><button class="secondary" data-spatial-route="tasks">导入任务</button></div></section>${isGuest()?'<section class="settings-panel"><h2>把这一刻留下</h2><p class="design-spaces-intro">登录后，照片、原声和文字可以一起保存到账号。</p><button class="btn gold" data-action="login-profile">登录账号</button></section>':`<section class="settings-panel"><h2>我的资料</h2><form data-form="profile"><label class="field">昵称<input name="displayName" value="${escape(s.user.displayName || '')}" maxlength="40" required></label><button type="button" class="secondary" data-action="avatar">更换头像</button> <button class="primary">保存资料</button><p class="form-status" role="status"></p></form></section>`}<section class="settings-panel"><h2>回忆偏好</h2>${preferencesHtml()}</section>${isGuest()?'':`<section class="settings-panel"><h2>账号</h2>${s.user.isAdmin?'<p><a class="secondary" href="/admin">打开管理后台</a></p>':''}<button class="text-button" data-action="my-submissions">我的投稿记录</button><br><button class="text-button" data-action="username">修改账号</button><br><button class="text-button" data-action="password">修改密码</button><br><button class="text-button" data-action="logout">退出登录</button></section>`}<div class="design-bottom-links"><button data-spatial-route="cases">真实案例与空间示例 ›</button><button data-spatial-route="world-tasks">查看 World 任务 ›</button></div>`,{page:'B4',selected:'profile',className:'design-account'}); }
function syncLabel() { if(isGuest())return s.record?.cacheFailed?'草稿未存好 · 请保持页面打开':'本机草稿 · 保存到账号'; if (s.record?.conflict) return '内容有更新 · 点击处理'; if(s.record?.saving) return '正在保存…';if(s.record?.cacheFailed&&(s.record?.dirty||s.record?.pendingVoice))return '尚未保存 · 请保持页面打开'; if(s.record?.dirty||s.record?.pendingVoice||s.record?.uploads?.some(t=>!t.done)) return navigator.onLine?'等待同步':'离线 · 等待同步'; return '已保存'; }
function waveHtml(values, count=24) { const valuesSafe=Array.isArray(values)&&values.length?values:[.15,.2,.3,.4,.25,.6,.45,.3];return Array.from({length:count},(_,i)=>`<i style="height:${Math.round(4+Math.max(0,Math.min(1,Number(valuesSafe[Math.floor(i*valuesSafe.length/count)])||0))*19)}px"></i>`).join(''); }
function messageHtml(message) { const mine=message.role==='user', voice=message.audio; return `<article class="message ${mine?'user':'assistant'}" data-message="${escape(message.id)}"><div class="message-meta">${mine?'我':'回忆时刻'} <span>${time(message.createdAt)}</span></div><div class="message-bubble ${voice?'voice-bubble':''}">${voice?`<button class="voice-play" data-play="${escape(message.id)}" aria-label="${playingId===message.id?'停止播放':'播放语音'}">${icon(playingId===message.id?'stop':'play')}<span class="saved-waveform" aria-hidden="true">${waveHtml(voice.waveform)}</span><span class="voice-duration">${seconds(voice.duration||0)}</span></button>${message.text?`<details class="transcript"><summary>查看文字</summary>${escape(message.text)}</details>`:'<span class="transcript">原声已留下</span>'}`:escape(message.text)}</div><div class="message-tools">${mine?`<button data-edit="${escape(message.id)}">${icon('edit')}${message.text?'修改文字':'补充文字'}</button>${voice&&!message.text?`<button data-transcribe="${escape(message.id)}">重新识别</button>`:''}`:`<button data-read="${escape(message.id)}">${icon('sound')}${speechTarget===message.id&&s.speaking?'停止朗读':'听一遍'}</button>`}</div></article>`; }
function conversationHtml() { const m=s.record.moment; return `<div class="conversation-date">${date(m.createdAt)}</div>${m.messages.map(messageHtml).join('')}${!m.messages.length&&!s.busy?`<div class="empty-chat">${icon('mic')}<p>${m.photos.length?'说说这张照片里，你最先想到的事。':'先选一张照片，故事就从这里开始。'}</p></div>`:''}${s.busy?`<div class="thinking" role="status"><i></i><i></i><i></i>${escape(s.busy)}</div>`:''}${s.error?`<div class="inline-error" role="status">${escape(s.error)} ${s.record?.conflict?'<button data-action="conflict">处理更新</button>':'<button data-action="retry">重试</button>'}</div>`:''}`; }
function composerHtml() {
  if(s.record.moment.archivedAt)return '<div class="completion-panel"><p>这段回忆已归档，照片与原话仍然保留。</p><button class="primary warm" data-action="restore-memory">恢复这段回忆</button></div>';
  if(s.pendingVoice) return `<div class="voice-composer"><span class="mic-copy"><strong>刚才的语音已保留</strong><small>${seconds(s.pendingVoice.duration)} · 确认后发送</small></span><button class="text-button" data-action="discard-voice">取消</button><button class="recording-send" data-action="send-voice" aria-label="发送语音">${icon('send')}</button></div>`;
  if(s.record.moment.status==='complete') return `<div class="completion-panel"><p>这段回忆，已经留下。<br>${escape(syncLabel())}</p><button class="primary warm" data-action="continue">接着聊</button></div>`;
  if(['recording','requesting','processing'].includes(s.voice.phase)) return `<div class="voice-composer"><button class="icon-button" data-action="cancel-voice" aria-label="取消录音">${icon('close')}</button><span class="recording-time">${seconds(s.voice.elapsedMs/1000)}</span><div class="live-waveform" aria-label="麦克风音量">${Array.from({length:24},()=>'<i></i>').join('')}</div><button class="recording-send" data-action="finish-voice" aria-label="发送语音" ${s.voice.phase!=='recording'?'disabled':''}>${icon('send')}</button></div><div class="composer-hint"><span>${s.voice.phase==='requesting'?'请允许使用麦克风':s.voice.phase==='processing'?'正在收好这段声音…':'正在听，说完会自动发送'}</span></div>`;
  if(s.mode==='text') return `<form class="text-composer" data-form="message">${ib('voice-mode','mic','切换到语音')}<textarea id="moment-text" name="text" rows="2" maxlength="12000" placeholder="说说你记得的事…" aria-label="想留下的话">${escape(s.textDraft)}</textarea><button class="recording-send" aria-label="发送文字" ${s.busy||!photo()?'disabled':''}>${icon('send')}</button></form>`;
  return `<div class="voice-composer"><button class="mic-main" data-action="start-voice" aria-label="${s.speaking?'打断朗读并开始说话':'开始语音'}" ${s.busy||!photo()?'disabled':''}>${icon('mic')}</button><div class="mic-copy"><strong>${s.speaking?'正在读给你听':'说说这一刻'}</strong><small>${s.speaking?'点麦克风，就可以接着说':'点一下开始，说完自动发送'}</small></div>${ib('text-mode','keyboard','切换到文字')}</div><div class="composer-hint"><span>${s.armed?'连续语音已开启':'什么时候结束，由你决定'}</span>${s.armed?'<button data-action="pause-listening">暂停语音</button>':'<button data-action="chat-settings">语音与照片设置</button>'}</div>`;
}
function uploadsHtml(){const pending=s.uploads.filter(u=>!u.done);return pending.length?`<div class="upload-list" aria-label="照片上传进度">${pending.map(u=>`<div class="upload-item">${u.preview?`<img src="${escape(u.preview)}" alt="选中的照片">`:''}<span>${escape(u.name||u.file?.name||'照片')}<br>${escape(u.status)}</span>${u.error?`<button data-upload-retry="${u.id}">重试</button><button data-upload-remove="${u.id}">移除</button>`:`<progress max="100" value="${u.progress}" aria-label="${escape(u.status)}"></progress>`}</div>`).join('')}</div>`:'';}
function chatScreen() { const m=s.record.moment,p=photo(),src=mediaSource(p); return `<div class="chat-shell design-chat">${designDeco('B2')}<header class="chat-header nav">${ib('open-library','back','回到回忆库')}<button class="chat-title" data-action="rename"><strong>${escape(momentTitle(m))}</strong><span class="sync-status" role="status">${escape(syncLabel())}</span></button>${ib('chat-settings','settings','回忆设置')}<button class="btn gold sm" data-action="end" style="width:auto">${m.status==='complete'?'查看回忆':'我说完了'}</button></header><div class="chat-body"><section class="photo-column" aria-label="回忆照片"><div class="frame-gold"><div class="photo-frame">${src?`<img class="image-fallback" src="${escape(src)}" alt="${escape(p.name||'回忆照片')}"><canvas id="moment-particles" aria-label="照片粒子效果"></canvas><button class="peek" aria-label="按住看清照片" data-action="peek">${icon('eye')}</button><span class="tag ${m.status==='complete'?'gold':'rose'} photo-status">${m.status==='complete'?'已确认':'● 对话中'}</span>`:`<div class="empty-chat">${icon('photo')}<button class="secondary" data-action="add">选择照片</button></div>`}</div></div>${m.exampleSource?'<span class="tag ice design-example-notice">设计稿示例 · 非实拍照片</span>':''}<div class="photo-thumbs">${m.photos.map((p,i)=>`<button class="photo-thumb ${i===s.photoIndex?'active':''}" data-photo="${i}" aria-label="第 ${i+1} 张照片" aria-pressed="${i===s.photoIndex}"><img src="${escape(mediaSource(p))}" alt=""></button>`).join('')}<button class="photo-thumb add" data-action="add" aria-label="添加照片">${icon('plus')}</button></div>${uploadsHtml()}<div class="gems" aria-label="回忆谈话方向">${[['地点','我想说说拍照的地方。'],['人物','我想聊聊照片里的人。'],['事情','我想说说那天发生的事。'],['心情','我想聊聊当时的心情。']].map(([label,text])=>`<button class="gem" data-action="suggestion" data-suggestion-text="${text}" ${m.status==='complete'||s.busy?'disabled':''}><span class="d"></span><span>${label}</span></button>`).join('')}</div></section><section class="dialogue-column" aria-label="回忆对话"><div class="conversation" role="log" aria-live="polite">${conversationHtml()}</div><div class="composer">${suggestedReplies()}${composerHtml()}</div></section></div></div>`; }
function enhanceProfile(){
  const heading=root.querySelector('.design-account-heading');if(heading)heading.classList.add('glass','gilt');
  const panels=[...root.querySelectorAll('.settings-panel')];
  for(const panel of panels){const h=panel.querySelector('h2');if(!h)continue;
    if(h.textContent==='我的收藏'){h.textContent='我的回忆';continue;}
    if(isGuest()&&h.textContent==='把这一刻留下')continue;
    const details=document.createElement('details');details.className='v2-settings glass';
    const summary=document.createElement('summary');summary.textContent=h.textContent;details.append(summary);h.remove();
    panel.before(details);details.append(panel);
  }
}
function render({end=false}={}) {
  if(s.view!=='photo')clearPhotoDetail();
  spaces.destroy();familyFrame.destroy();
  const scroll=root.querySelector('.conversation')?.scrollTop||0;
  particle?.destroy();particle=null;particleKey='';
  root.innerHTML=s.view==='spatial'?`<div class="app-shell spatial-app-shell design-shell">${designDeco('A1')}<div class="design-spatial-content"><div id="spatial-content"></div></div>${nav(s.spatialRoute?.startsWith('community-author/')?'home':'spaces')}</div>`:s.view==='family-frame'?`<div class="family-frame-app"><div id="family-frame-content"></div></div>`:s.view==='home'?homeScreen():s.view==='library'?libraryScreen():s.view==='photo'?libraryPhotoDetail():s.view==='capture'?photoCaptureScreen():s.view==='public'?publicScreen():s.view==='example'?exampleScreen(s.example,s.exampleIndex,{back:ib('home','back','回到首页'),plus:icon('plus'),loading:s.exampleLoading}):s.view==='profile'?profileScreen():s.view==='chat'&&s.record?(s.review?designReview({moment:s.record.moment,media:mediaSource,title:momentTitle,sync:syncLabel(),guest:isGuest(),error:s.error,pendingVoice:s.record.pendingVoice}):chatScreen()):'<div class="initial-loading" role="status">正在打开回忆时刻…</div>';
  if(isV2 && s.view==='profile')enhanceProfile();
  if(isV2 && s.view==='home' && (!s.community||s.community.epoch!==s.epoch||s.community.nav!==s.nav))background(loadCommunity());
  if(!isV2 && s.view==='home'){const host=root.querySelector('.design-body')||root.querySelector('.body')||root.firstElementChild;host?.insertAdjacentHTML('beforeend','<section class="public-entry"><button class="btn ghost" data-action="public-list">看看大家公开的回忆 ›</button></section>');}
  if(s.view==='chat'&&s.review&&!isGuest()&&s.record?.moment.status==='complete'){root.querySelector('.design-review-actions')?.insertAdjacentHTML('beforebegin','<section class="glass publication-entry"><strong>想把这段回忆分享给大家？</strong><p>默认不公开；获授权的管理员可为审核查看。你同意投稿后，当前版本经审核才会公开。</p><button class="btn ghost sm" data-action="moment-submission">投稿与公开状态</button></section>');}
  if(s.view==='chat'&&s.review&&s.record)root.querySelector('.design-review-actions')?.insertAdjacentHTML('beforebegin',memoryToolsHtml());
  const nextRoute=location.hash;const moved=renderedRoute!==nextRoute;renderedRoute=nextRoute;
  if(s.view==='spatial')background(spaces.mount(root.querySelector('#spatial-content'),s.spatialRoute).then(()=>{if(renderedRoute===nextRoute&&moved)window.scrollTo?.(0,routeScroll.get(nextRoute)||0);}));
  else if(s.view==='family-frame')background(familyFrame.mount(root.querySelector('#family-frame-content'),s.familyFrameRoute));
  else if(moved)window.scrollTo?.(0,routeScroll.get(nextRoute)||0);
  if(s.view==='chat'&&!s.review) { mountParticles();const flow=root.querySelector('.conversation');if(flow)flow.scrollTop=end?flow.scrollHeight:scroll; }
  updateViewport();
  window.momentBoot?.ready();
}
function updateChat({end=false}={}) {
  if(s.view!=='chat')return;
  if(s.review){render();return;}
  const flow=root.querySelector('.conversation'),bottom=flow.scrollHeight-flow.scrollTop-flow.clientHeight<100,scroll=flow.scrollTop;
  flow.innerHTML=conversationHtml();flow.scrollTop=end||bottom?flow.scrollHeight:scroll;
  updateComposer();updateSync();particle?.setProgress(revealProgress());
}
function updateComposer() { const node=root.querySelector('.composer');if(node)node.innerHTML=suggestedReplies()+composerHtml(); }
function updatePhotoSync(){if(s.view!=='library'||s.libraryMode==='stories')return;const entries=new Map(libraryPhotos().map(entry=>[entry.key,entry]));root.querySelectorAll('[data-photo-sync]').forEach(node=>{const entry=entries.get(node.dataset.photoSync);if(entry)node.textContent=photoLibraryCaption(entry,isGuest());});}
function updatePhotoAssociations(){if(s.view!=='photo')return;const entry=currentLibraryPhoto();if(!entry)return;const parts=photoDetailAssociations(entry,{guest:isGuest()}),share=root.querySelector('[data-photo-share-entry]'),spaces=root.querySelector('[data-photo-linked-spaces]');if(share)share.innerHTML=parts.shareHtml;if(spaces)spaces.innerHTML=parts.spacesHtml;const stories=new Map(parts.stories.map(item=>[item.key,item.html]));root.querySelectorAll('[data-photo-story-share]').forEach(node=>{node.innerHTML=stories.get(node.dataset.photoStoryShare)||'';});}
function updateSync() { const label=syncLabel();root.querySelectorAll('.sync-status').forEach(node=>{node.textContent=label;});updatePhotoSync(); }
function revealProgress() { return s.record?.moment.status==='complete'?1:Math.min(.9,.12+(s.record?.moment.messages.filter(m=>m.role==='user').length||0)*.17); }
function mountParticles() { const canvas=root.querySelector('#moment-particles'),src=mediaSource(photo());if(!canvas||!src)return;particleKey=src;particle=mountMomentParticles({canvas,src,mode:s.record.moment.preferences.photoMode,progress:revealProgress()});particle.ready.then(ok=>{if(!ok&&particleKey===src)canvas.style.display='none';}); }
function updateViewport() { const vv=window.visualViewport;if(!vv)return;root.style.setProperty('--app-height',`${vv.height}px`);dialogRoot.style.setProperty('--app-height',`${vv.height}px`);root.querySelector('.chat-shell')?.classList.toggle('keyboard-open',innerHeight-vv.height>140); }
function clearDialogWork(){++photoPickerGeneration;photoSpacePicker?.destroy();photoSpacePicker=null;photoStoryPicker?.destroy();photoStoryPicker=null;recoverySurface?.destroy();recoverySurface=null;exportJob?.abort();exportJob=null;for(const url of exportUrls)URL.revokeObjectURL(url);exportUrls.clear();}
function cancelLoginAttempt(){loginAttempt?.abort();loginAttempt=null;if(authIntent)authIntent={...authIntent};}
function startLoginAttempt(){cancelLoginAttempt();return {intent:authIntent,attempt:loginAttempt=new AbortController()};}
function closeDialog() { clearDialogWork();loginAttempt?.abort();loginAttempt=null;authIntent=null;dialogRoot.replaceChildren();root.inert=false;dialogFocus?.focus?.(); }
function showDialog(title,content) { clearDialogWork();dialogFocus=document.activeElement;root.inert=true;dialogRoot.innerHTML=`<div class="dialog-backdrop"><section class="dialog-panel" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><header class="dialog-head"><h2 id="dialog-title">${escape(title)}</h2>${ib('close-dialog','close','关闭')}</header>${content}</section></div>`;dialogRoot.querySelector('input,textarea,button')?.focus(); }
function choosePhotos(fresh=false) { if(!s.user)return;s.avatarUpload=false;s.chooseFresh=fresh;showDialog('添加照片',`<div class="choose-source"><button data-action="camera">${icon('camera')}拍一张照片</button><button data-action="library">${icon('photo')}从相册选择</button></div>`); }
function voiceMetadata(clip) {
  if(!clip)return null;
  const {mediaId,messageId,createdAt,mimeType,duration,waveform,transcript,reason,photoId,sendRequested,receipt,transcriptionId}=clip;
  return {mediaId,messageId,createdAt,mimeType,duration,waveform,transcript,reason,photoId,sendRequested,receipt,transcriptionId};
}
function photoMetadata(task) { const {id,photoId,originalId,previewId,name,mimeType,strategy,width,height,done}=task;return {id,photoId,originalId,previewId,name,mimeType,strategy,width,height,done}; }
async function saveCache(record,{strict=false}={}) {
  // Queue by the live record, so a CAS recovery moving it to a new ID keeps all
  // already queued saves in order instead of opening a second write pipeline.
  const epoch=s.epoch,key=record;
  const snapshot=structuredClone({moment:record.moment,version:record.version,base:record.base,dirty:record.dirty,revision:record.revision,pendingWrite:record.pendingWrite,conflict:record.conflict,pendingVoice:voiceMetadata(record.pendingVoice),pendingPhotos:(record.uploads||record.pendingPhotos||[]).filter(t=>!t.done).map(photoMetadata),textDraft:record.textDraft,pendingAI:record.pendingAI,suggestions:record.suggestions,suggestionMessageId:record.suggestionMessageId,cloudMedia:record.cloudMedia});
  const write=(cacheWrites.get(key)||Promise.resolve()).catch(()=>{}).then(async()=>{
    if(snapshot.moment.id!==record.moment.id){snapshot.moment={...snapshot.moment,id:record.moment.id,title:record.moment.title,createdAt:record.moment.createdAt};snapshot.pendingAI=null;snapshot.pendingWrite=null;snapshot.version=0;snapshot.base=null;}
    const result=await cache.put(record.accountId,snapshot,record.accountId===GUEST_ACCOUNT?{expectedCacheVersion:record.cacheVersion||0}:{});
    if(result?.cacheVersion)record.cacheVersion=result.cacheVersion;
    if(result?.recoveredRecord){
      const originalId=record.moment.id,recovery=result.recoveredRecord;
      record.moment={...record.moment,id:recovery.moment.id,title:recovery.moment.title,createdAt:recovery.moment.createdAt};
      record.version=0;record.base=null;record.dirty=true;record.pendingWrite=null;record.pendingAI=null;record.conflict=null;
      if(current(record,epoch)){
        records.delete(originalId);
        if(result.latestRecord){const latest=restoreRecord(result.latestRecord,record.accountId);records.set(originalId,latest);refreshLocalItem(latest);background(hydrateMedia(latest,epoch));}
        records.set(record.moment.id,record);refreshLocalItem(record);
        if(s.record===record){aiAbort?.abort();aiAbort=null;s.busy='';s.busyOwner=null;setRoute(`memory/${encodeURIComponent(record.moment.id)}${s.review?'/review':''}`);render();}
        toast('另一页更新了原回忆。此页内容已另存为副本，两份都保留了。');
      }
    }
  });
  cacheWrites.set(key,write);
  try { await write;record.cacheFailed=false;if(record.textDraft===snapshot.textDraft)record.textUncached=false;return true; }
  catch(error) { record.cacheFailed=true;if(visible(record,epoch)){s.error=errorText(error?.code?error:{code:'cache_unavailable'});updateChat();}if(strict)throw error;return false; }
  finally {if(cacheWrites.get(key)===write)cacheWrites.delete(key);}
}
async function change(record,fn) {
  const epoch=s.epoch;requireCurrent(record,epoch);
  const before=JSON.stringify({photos:record.moment.photos,messages:messageTextHistory(record.moment)});
  record.moment=fn(record.moment);record.moment.updatedAt=new Date().toISOString();record.revision=(record.revision||0)+1;record.dirty=true;
  if(before!==JSON.stringify({photos:record.moment.photos,messages:messageTextHistory(record.moment)}))record.pendingAI=null;
  await saveCache(record);if(!current(record,epoch))return false;
  refreshLocalItem(record);updateSync();background(sync(record));return true;
}
function refreshLocalItem(record) { if(!current(record))return;const m=record.moment,summary={...m,photoCount:m.photos.length,coverPhotoUrl:m.photos[0]?.url,preview:momentPreview(m)};s.items=[summary,...s.items.filter(x=>x.id!==m.id)].sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt))); }
async function sync(record) {
  if(record.accountId===GUEST_ACCOUNT)return saveCache(record);
  if(record.cloudMedia?.length)return false;
  const identity=`${record.accountId}:${record.moment.id}`;
  if(syncing.has(identity))return syncing.get(identity);
  const job=(async()=>{
    const epoch=s.epoch;if(!current(record,epoch)||!navigator.onLine||record.conflict)return false;
    record.saving=true;updateSync();
    try {
      let merges=0;
      while(record.dirty&&current(record,epoch)) {
        record.pendingWrite ||= {key:newId(),revision:record.revision,expectedVersion:record.version,moment:structuredClone(record.moment)};
        await saveCache(record);requireCurrent(record,epoch);const pending=record.pendingWrite;
        try {
          const response=await api.request(`/v1/moments/${record.moment.id}`,{method:'PUT',key:pending.key,body:{expectedVersion:pending.expectedVersion,moment:pending.moment},accountId:record.accountId,signal:AbortSignal.timeout(45000)});
          requireCurrent(record,epoch);
          record.version=response.version??response.moment?.version;record.base=structuredClone(response.moment);
          record.pendingWrite=null;if(record.revision===pending.revision){record.moment=response.moment;record.dirty=false;}
          await saveCache(record);if(current(record,epoch))refreshLocalItem(record);
        } catch(error) {
          if(!current(record,epoch))return false;
          if(error.status===409&&error.code!=='account_changed'&&merges++<2) {
            const remote=await api.request(`/v1/moments/${record.moment.id}`,{accountId:record.accountId});requireCurrent(record,epoch);
            const merged=mergeMoment(record.base,record.moment,remote.moment);record.pendingWrite=null;
            if(!merged){record.conflict=remote;if(visible(record,epoch))s.error=messages.version_conflict;await saveCache(record);if(visible(record,epoch))updateChat();return false;}
            record.moment=merged;record.pendingAI=null;record.base=structuredClone(remote.moment);record.version=remote.version;record.revision++;await saveCache(record);continue;
          }
          throw error;
        }
      }
      return !record.dirty;
    }catch(error){if(current(record,epoch)&&error.name!=='AbortError'){if(visible(record,epoch))s.error=errorText(error);await saveCache(record);if(visible(record,epoch))updateChat();}return false;}
    finally{record.saving=false;if(current(record,epoch))updateSync();}
  })();
  syncing.set(identity,job);try{return await job;}finally{if(syncing.get(identity)===job)syncing.delete(identity);}
}
function restoreRecord(entry,accountId) { return {...entry,accountId,uploads:(entry.pendingPhotos||[]).map(t=>({...t,error:true,status:'等待重新上传',progress:0})),pendingPhotos:undefined}; }
async function loadLibrary() {
  if(!s.user)return;const epoch=s.epoch,accountId=s.user.id;s.loading=true;
  try {
    const local=await cache.list(accountId).catch(()=>[]);if(epoch!==s.epoch)return;
    // A single live object owns edits, cache writes and synchronization per ID.
    for(const entry of local)if(!records.has(entry.moment.id))records.set(entry.moment.id,restoreRecord(entry,accountId));
    if(isGuest()){s.items=[];for(const record of records.values())if(current(record)){refreshLocalItem(record);await hydrateMedia(record,epoch);}s.error='';return;}
    const data=await api.request('/v1/moments',{accountId});if(epoch!==s.epoch)return;
    s.items=data.moments||[];
    for(const record of records.values())if(current(record)&&(record.dirty||record.pendingVoice||record.uploads?.some(t=>!t.done))){refreshLocalItem(record);if(record.dirty)background(record.cloudMedia?.length?retryOutbox(record):sync(record));}
    s.error='';
  }catch(error){if(epoch===s.epoch){s.items=[...records.values()].filter(r=>current(r)).map(r=>r.moment);s.error=errorText(error);}}
  finally{if(epoch===s.epoch){s.loading=false;if(['home','library'].includes(s.view))render();}}
}
async function hydrateMedia(record,epoch=s.epoch) {
  for(const item of [...record.moment.photos,...record.moment.messages.map(m=>m.audio).filter(Boolean)]) {
    const id=mediaCacheId(item);const stored=await cache.getMedia(record.accountId,id).catch(()=>null);requireCurrent(record,epoch);
    if(stored?.blob&&!urls.has(id))ownUrl(record,id,stored.blob,epoch);
  }
  for(const task of record.uploads||[]) {
    if(task.done)continue;
    if(!task.file){const source=await cache.getMedia(record.accountId,task.originalId).catch(()=>null);requireCurrent(record,epoch);if(source?.blob){task.file=photoFile(source.blob,task.name,task.mimeType);task.durable=true;}}
    if(task.file&&!task.preview)task.preview=ownUrl(record,`upload-${task.id}`,task.file,epoch);
    if(!task.file){task.error=true;task.status='原照片暂时无法读取，请重新选择';}
  }
  const clip=record.pendingVoice;
  if(clip&&!clip.blob){const source=await cache.getMedia(record.accountId,clip.mediaId).catch(()=>null);requireCurrent(record,epoch);if(source?.blob){clip.blob=source.blob;clip.mimeType ||= source.blob.type;}else{record.cacheFailed=true;}}
}
async function openMoment(id,{review=false}={}) {
  const epoch=s.epoch,nav=++s.nav;await stopAll();if(epoch!==s.epoch||nav!==s.nav||!s.user)return;
  s.busy='';s.error='';let record=records.get(id);
  try {
    if(!record){const local=await cache.get(s.user.id,id).catch(()=>null);if(epoch!==s.epoch||nav!==s.nav)return;if(local)record=restoreRecord(local,s.user.id);if(record)records.set(id,record);}
    if(!isGuest()&&!record?.dirty&&!record?.saving){
      const revision=record?.revision;const data=await api.request(`/v1/moments/${encodeURIComponent(id)}`);if(epoch!==s.epoch||nav!==s.nav)return;
      if(!record){record={moment:data.moment,version:data.version,base:structuredClone(data.moment),dirty:false,revision:0,accountId:s.user.id,uploads:[]};records.set(id,record);}
      else if(!record.dirty&&record.revision===revision){record.moment=data.moment;record.version=data.version;record.base=structuredClone(data.moment);}
    }
    if(record)await hydrateMedia(record,epoch);
  }catch(error){if(epoch!==s.epoch||nav!==s.nav||error.name==='AbortError')return;if(!record){toast(errorText(error));return;}s.error=errorText(error);}
  if(epoch!==s.epoch||nav!==s.nav||!record)return;
  records.set(id,record);s.record=record;s.photoIndex=0;s.review=review||record.moment.status==='complete'||Boolean(record.moment.archivedAt);bindDrafts(record);s.view='chat';setRoute(`memory/${encodeURIComponent(id)}${s.review?'/review':''}`);render({end:true});if(record.dirty)background(record.cloudMedia?.length?retryOutbox(record):sync(record));
}
async function startNew() {
  const epoch=s.epoch,nav=++s.nav;await stopAll();if(epoch!==s.epoch||nav!==s.nav||!s.user)return null;
  const moment=newMoment(s.user.preferences),record={moment,version:0,base:null,dirty:true,revision:1,accountId:s.user.id,uploads:[]};
  records.set(moment.id,record);s.record=record;s.review=false;s.view='chat';s.photoIndex=0;s.error='';s.busy='';bindDrafts(record);history.replaceState(null,'',`${appPath}#memory/${moment.id}`);
  await saveCache(record);if(visible(record,epoch,nav))render();return current(record,epoch)?record:null;
}
async function uploadBlob(record,mediaId,blob,{kind,name,createPreview=false,epoch=s.epoch,signal}={}) {
  requireCurrent(record,epoch,signal);
  await cache.putMedia(record.accountId,mediaId,blob,{kind,name});requireCurrent(record,epoch,signal);
  if(record.accountId===GUEST_ACCOUNT)return {media:{id:mediaId,url:`/v1/moment-media/${mediaId}`}};
  const dataUrl=await blobToDataUrl(blob);requireCurrent(record,epoch,signal);
  const result=await api.request(`/v1/moment-media/${mediaId}`,{method:'PUT',key:`media-${mediaId}`,accountId:record.accountId,signal:AbortSignal.any([AbortSignal.timeout(45000),...(signal?[signal]:[])]),body:{kind,name,mimeType:blob.type||'application/octet-stream',dataBase64:dataUrl.split(',')[1],...(createPreview?{createPreview:true}:{})}});
  requireCurrent(record,epoch,signal);return result;
}
async function uploadPhoto(task,record,epoch=s.epoch) {
  if(task.running)return task.running;
  if(task.done||!current(record,epoch))return false;
  const nav=s.nav,paint=()=>{if(visible(record,epoch,nav)){bindDrafts(record);render();}else if(current(record,epoch)&&s.view==='library')render();};
  const job=(async()=>{
    task.error=false;task.progress=10;task.status='正在准备照片';paint();
    try {
      if(!task.file){const stored=await cache.getMedia(record.accountId,task.originalId);requireCurrent(record,epoch);if(!stored?.blob)throw {code:'photo_decode'};task.file=photoFile(stored.blob,task.name,task.mimeType);}
      task.file=photoFile(task.file,task.name||task.file.name,task.mimeType||task.file.type);task.name=task.file.name;task.mimeType=task.file.type;
      let prepared;
      const cachedPreview=await cache.getMedia(record.accountId,task.previewId).catch(()=>null);requireCurrent(record,epoch);
      if(cachedPreview?.blob&&task.width&&task.height){prepared={preview:cachedPreview.blob,width:task.width,height:task.height};task.strategy='local';}
      else if(task.strategy!=='server') {
        try{prepared=await preparePhoto(task.file);requireCurrent(record,epoch);task.strategy='local';task.width=prepared.width;task.height=prepared.height;await cache.putMedia(record.accountId,task.previewId,prepared.preview,{kind:'photo',name:`${task.name}.jpg`});}
        catch(error){if(error.code!=='heic_conversion_required')throw error;task.strategy='server';}
      }
      requireCurrent(record,epoch);await saveCache(record,{strict:true});requireCurrent(record,epoch);
      let p;
      if(task.strategy==='server') {
        if(isGuest())throw {code:'guest_heic_unsupported'};
        task.status='正在转换照片';task.progress=30;paint();
        const uploaded=await uploadBlob(record,task.originalId,task.file,{kind:'photo',name:task.name,createPreview:true,epoch});requireCurrent(record,epoch);
        const media=uploaded.media;if(!safeMediaUrl(media.previewUrl))throw {code:'photo_decode'};
        p={id:task.photoId,mediaId:media.id||media.mediaId,originalMediaId:media.id||media.mediaId,url:media.previewUrl,name:task.name,width:media.width,height:media.height};
        // Raw HEIC bytes never occupy the /preview cache entry.
        try{const preview=await fetchOwnedBlob(record,p.url,{epoch});await cache.putMedia(record.accountId,mediaCacheId(p),preview,{kind:'photo'});requireCurrent(record,epoch);ownUrl(record,mediaCacheId(p),preview,epoch);}catch(error){if(error.name==='AbortError')throw error;}
      } else {
        task.progress=35;task.status='正在上传原照片';paint();
        await uploadBlob(record,task.originalId,task.file,{kind:'photo',name:task.name,epoch});requireCurrent(record,epoch);
        task.progress=70;task.status='正在保存照片';paint();
        const uploaded=await uploadBlob(record,task.previewId,prepared.preview,{kind:'photo',name:`${task.name}.jpg`,epoch});requireCurrent(record,epoch);
        p={id:task.photoId,mediaId:uploaded.media.id||uploaded.media.mediaId,originalMediaId:task.originalId,url:uploaded.media.url,name:task.name,width:prepared.width,height:prepared.height};
        ownUrl(record,p.mediaId,prepared.preview,epoch);
      }
      await change(record,m=>({...m,photos:m.photos.some(item=>item.id===task.photoId)?m.photos:[...m.photos,p]}));requireCurrent(record,epoch);
      task.progress=100;task.status='已上传';task.done=true;await saveCache(record);requireCurrent(record,epoch);
      if(visible(record,epoch,nav))s.photoIndex=record.moment.photos.findIndex(item=>item.id===task.photoId);
      paint();return true;
    }catch(error){if(current(record,epoch)){task.error=true;task.status=errorText(error);await saveCache(record);paint();}return false;}
  })();task.running=job;try{return await job;}finally{task.running=null;}
}
async function selected(files) {
  if(!files.length||!s.user)return;
  const epoch=s.epoch;const avatarOnly=s.avatarUpload;s.avatarUpload=false;
  if(avatarOnly){await uploadAvatar(photoFile(files[0]));return;}
  const saveOnly=s.view!=='chat'||s.chooseFresh;
  let record=s.record;
  if(!s.chooseFresh&&record?.moment.archivedAt&&s.view==='chat'){toast('请先恢复这段回忆，再添加照片。');return;}
  if(s.chooseFresh||!record||s.view!=='chat')record=await startNew();else await stopAll();s.chooseFresh=false;
  if(!record||!current(record,epoch)||s.record!==record)return;
  const nav=s.nav;const available=24-record.moment.photos.length-(record.uploads||[]).filter(t=>!t.done).length;
  if(files.length>available)toast(`这段回忆还能添加 ${Math.max(0,available)} 张照片`);
  const tasks=[...files].slice(0,Math.max(0,available)).map(source=>{const file=photoFile(source);const task={id:newId(),photoId:newId(),originalId:newId(),previewId:newId(),file,name:file.name,mimeType:file.type,status:'正在准备照片',progress:0};task.preview=ownUrl(record,`upload-${task.id}`,file,epoch);return task;});
  (record.uploads||=[]).push(...tasks);bindDrafts(record);
  if(saveOnly){s.libraryMode='photos';s.libraryFilter='all';s.view='library';setRoute('library/photos');}render();
  // Persist all selected originals before the first network upload starts.
  for(const task of tasks){try{await cache.putMedia(record.accountId,task.originalId,task.file,{kind:'photo',name:task.name});requireCurrent(record,epoch);task.durable=true;}catch(error){task.error=true;task.status=messages.cache_unavailable;}}
  await saveCache(record);if(!current(record,epoch))return;
  for(const task of tasks){if(!current(record,epoch))break;if(task.durable)await uploadPhoto(task,record,epoch);}
  if(current(record,epoch)&&tasks.every(task=>task.done)&&!isGuest())await sync(record);
  if(current(record,epoch)&&s.view==='library'){render();toast(tasks.every(task=>task.done)?(!isGuest()&&record.dirty?'照片已留在本机，账号保存未完成；请点击刷新重试。':'照片已保存。想说时，点开一张照片就能继续。'):'已保留选中的原照片。未完成的项目可以单独重试。');}
}
async function fetchOwnedBlob(record,url,{epoch=s.epoch,signal,limit=24*1024*1024}={}) {
  requireCurrent(record,epoch,signal);const safe=safeMediaUrl(url);if(!safe)throw {code:'photo_decode'};
  const scope=api.abort.signal,timeout=AbortSignal.timeout(20000),combined=AbortSignal.any([scope,timeout,...(signal?[signal]:[])]);
  const response=await fetch(safe,{credentials:'same-origin',cache:'no-store',signal:combined,headers:{'X-Unseen-Expected-Account-Id':record.accountId}});
  requireCurrent(record,epoch,combined);if(!response.ok)throw {status:response.status,code:'network_error'};
  if(Number(response.headers.get('content-length'))>limit)throw {code:'media_too_large'};
  const blob=await response.blob();requireCurrent(record,epoch,combined);if(!blob.size||blob.size>limit)throw {code:'media_too_large'};return blob;
}
async function clearPhotoData(record,p,{epoch=s.epoch,signal}={}) {
  requireCurrent(record,epoch,signal);const local=await boundedWait(cache.getMedia(record.accountId,mediaCacheId(p)).catch(()=>null),signal);requireCurrent(record,epoch,signal);
  const blob=local?.blob||await fetchOwnedBlob(record,p.url,{epoch,signal});requireCurrent(record,epoch,signal);
  const dataUrl=await boundedWait(blobToDataUrl(blob),signal);requireCurrent(record,epoch,signal);return dataUrl;
}
function boundedWait(promise,signal){
  const scope=AbortSignal.any([api.abort.signal,AbortSignal.timeout(20000),...(signal?[signal]:[])]);
  return new Promise((resolve,reject)=>{const abort=()=>reject(scope.reason||new DOMException('Aborted','AbortError'));if(scope.aborted)abort();else scope.addEventListener('abort',abort,{once:true});Promise.resolve(promise).then(value=>{scope.removeEventListener('abort',abort);resolve(value);},error=>{scope.removeEventListener('abort',abort);reject(error);});});
}
async function ask() {
  const record=s.record,p=photo(),epoch=s.epoch,nav=s.nav;if(!record||!p||s.busy||record.moment.status!=='active'||record.moment.archivedAt)return;
  stopPlayback({disarm:false});aiAbort?.abort();const control=aiAbort=new AbortController();s.busy=record.moment.messages.length?'正在听懂你的故事…':'正在看这张照片…';s.error='';updateChat({end:true});
  const source=aiSource(record.moment,p),valid=()=>visible(record,epoch,nav)&&!control.signal.aborted&&source===aiSource(record.moment,p);
  try {
    let pending=record.pendingAI;
    if(!pending||pending.source!==source){
      const snapshot={momentId:record.moment.id,requestId:newId(),photo:{id:p.id},messages:structuredClone(messageTextHistory(record.moment)),context:structuredClone(record.moment.context)};
      snapshot.photo.dataUrl=await clearPhotoData(record,p,{epoch,signal:control.signal});if(!valid())return;
      pending=record.pendingAI={source,requestId:snapshot.requestId,body:snapshot};await saveCache(record,{strict:true});if(!valid())return;
    }
    const result=await api.request('/api/moment-chat',{method:'POST',key:pending.requestId,accountId:record.accountId,signal:AbortSignal.any([control.signal,AbortSignal.timeout(65000)]),body:pending.body});
    if(!valid()||record.pendingAI!==pending)return;
    record.suggestions=normalizeMomentSuggestions(result.suggestions,messageTextHistory(record.moment));record.suggestionMessageId=result.message.id;
    await change(record,m=>({...appendMessage(m,result.message),context:result.context}));
    if(!visible(record,epoch,nav)||control.signal.aborted||record.moment.status!=='active')return;
    s.busy='';updateChat({end:true});
    if(s.readReplies){speechTarget=result.message.id;await tts.speak(result.message.text);}else maybeListen();
  }catch(error){if(visible(record,epoch,nav)&&!control.signal.aborted){s.error=errorText(error);s.armed=false;}}
  finally{if(aiAbort===control){aiAbort=null;if(visible(record,epoch,nav)){s.busy='';updateChat();}}}
}
async function sendText(text) {
  const record=s.record,p=photo(),epoch=s.epoch,nav=s.nav;if(!record||!text.trim()||s.busy||!p||record.moment.archivedAt)return;
  tts.prepare();s.textDraft='';record.textDraft='';await change(record,m=>appendMessage(m,{id:newId(),role:'user',text:text.trim(),photoId:p.id,createdAt:new Date().toISOString()}));
  if(visible(record,epoch,nav)){updateChat({end:true});background(ask());}
}
let recordingTarget=null,clipSave=Promise.resolve(true);
function transcriptionTimeoutMs(){const value=Number(s.config?.transcription?.requestTimeoutMs);return Number.isFinite(value)&&value>0?Math.min(180000,Math.max(5000,value)):65000;}
const recorder=createMomentVoice({
  getMaxDurationMs:()=>s.config?.transcription?.recommendedSegmentMs||120000,
  onState:state=>{const changed=s.voice.phase!==state.phase;s.voice=state;if(changed)updateComposer();else{const el=root.querySelector('.recording-time');if(el)el.textContent=seconds(state.elapsedMs/1000);}},
  onLevel:level=>{particle?.setLevel(level);root.querySelectorAll('.live-waveform i').forEach((el,i)=>el.style.height=`${5+Math.round(level*32*(.45+.55*Math.sin(i*1.8+performance.now()/170)**2))}px`);},
  onError:error=>{if(!error.recoverable){s.armed=false;toast(error.message||'麦克风没有开启，可以重试或打字。');updateComposer();}},
  onComplete:clip=>{const target=recordingTarget;clipSave=finishClip(clip,target).catch(error=>{if(target&&current(target.record,target.epoch)){s.error=errorText(error);updateChat();}return false;});}
});
const tts=createTurnVoicePlayer({onState:state=>{const was=s.speaking;s.speaking=state.phase==='speaking'||state.phase==='loading';if(state.phase==='error'){s.armed=false;toast(state.code==='playback-blocked'?'点“听一遍”播放回复。':'这次没有读出声音，仍可继续聊天。');}if(was!==s.speaking)updateComposer();if(state.phase==='idle'&&!state.code&&was)maybeListen();}});
function stopPlayback({disarm=true}={}){if(disarm)s.armed=false;tts.stop();if(activeAudio){activeAudio.onended=activeAudio.onerror=null;activeAudio.pause();}activeAudio=null;playingId=null;s.speaking=false;}
async function preserveCapture(){
  s.armed=false;
  if(['recording','processing'].includes(s.voice.phase)){await recorder.finish('interrupted');if(await clipSave===false)throw {code:'cache_unavailable'};}
  else if(s.voice.phase==='requesting')recorder.cancel();
  else if(await clipSave===false&&s.record?.pendingVoice&&!s.record.pendingVoice.durable)throw {code:'cache_unavailable'};
}
async function stopAll(){communityController?.abort();communityController=null;s.community=null;s.armed=false;aiAbort?.abort();aiAbort=null;s.busy='';s.busyOwner=null;stopPlayback();await preserveCapture();if(s.record?.textDraft){clearTimeout(s.record.draftTimer);await saveCache(s.record,{strict:true});}}
async function startVoice(){
  const record=s.record,p=photo(),epoch=s.epoch,nav=s.nav;if(!record||!p||s.busy||record.pendingVoice||record.moment.status==='complete'||record.moment.archivedAt||recorder.getState().phase!=='idle')return;
  stopPlayback();s.armed=s.continuous;tts.prepare();const target=recordingTarget={record,epoch,nav,photoId:p.id};const ok=await recorder.start();
  if(recordingTarget===target&&visible(record,epoch,nav)){if(!ok)s.armed=false;updateComposer();}
}
function maybeListen(){
  if(s.armed&&s.continuous&&s.view==='chat'&&s.record?.moment.status==='active'&&!document.hidden&&!s.busy&&!s.record.pendingVoice&&photo()&&recorder.getState().phase==='idle'){
    const target=recordingTarget={record:s.record,epoch:s.epoch,nav:s.nav,photoId:photo().id};
    background(recorder.start().then(ok=>{if(recordingTarget===target&&visible(target.record,target.epoch,target.nav)&&!ok){s.armed=false;updateComposer();}}));
  }
}
async function persistVoice(clip,target){
  const {record,epoch,photoId}=target;requireCurrent(record,epoch);
  clip.mediaId ||= newId();clip.messageId ||= newId();clip.createdAt ||= new Date().toISOString();clip.transcriptionId ||= newId();clip.photoId ||= photoId;clip.mimeType ||= clip.blob?.type||'audio/webm';clip.target=target;
  record.pendingVoice=clip;if(visible(record,epoch)){s.pendingVoice=clip;updateComposer();}
  if(!clip.blob){const stored=await cache.getMedia(record.accountId,clip.mediaId);requireCurrent(record,epoch);clip.blob=stored?.blob;}
  if(!clip.blob)throw {code:'cache_unavailable'};
  await cache.putMedia(record.accountId,clip.mediaId,clip.blob,{kind:'audio',...voiceMetadata(clip)});requireCurrent(record,epoch);
  await saveCache(record,{strict:true});requireCurrent(record,epoch);clip.durable=true;return true;
}
async function finishClip(clip,target){
  if(!target||!current(target.record,target.epoch))return false;
  clip.sendRequested=clip.reason!=='interrupted';if(!clip.sendRequested)s.armed=false;
  await persistVoice(clip,target);
  if(clip.sendRequested)background(submitClip(clip,target));
  return true;
}
async function submitClip(clip,target){
  if(!target)return false;const {record,epoch,photoId}=target;if(!current(record,epoch))return false;
  if(record.voiceJob)return record.voiceJob;
  const nav=s.nav,armed=visible(record,epoch)&&s.armed,token={};
  const paint=()=>{if(visible(record,epoch)){bindDrafts(record);updateChat({end:true});}};
  const job=(async()=>{
    try {
      clip.sendRequested=true;await persistVoice(clip,{...target,photoId:clip.photoId||photoId});requireCurrent(record,epoch);
      if(visible(record,epoch,nav)){s.busyOwner=token;s.busy='正在留下这段声音…';s.pendingVoice=null;updateChat();}
      if(!clip.receipt){const result=await uploadBlob(record,clip.mediaId,clip.blob,{kind:'audio',name:`${clip.mediaId}.${clip.mimeType.includes('mp4')?'m4a':'webm'}`,epoch});requireCurrent(record,epoch);clip.receipt=result.media;await saveCache(record,{strict:true});requireCurrent(record,epoch);}
      ownUrl(record,clip.mediaId,clip.blob,epoch);let text=clip.transcript?.trim()||'',recognitionError=null;
      if(!text&&s.config?.transcription?.enabled){
        try {
          const dataUrl=await blobToDataUrl(clip.blob);requireCurrent(record,epoch);
          const result=await api.request('/api/moment-transcribe',{method:'POST',key:clip.transcriptionId,accountId:record.accountId,signal:AbortSignal.timeout(transcriptionTimeoutMs()),body:{requestId:clip.transcriptionId,audio:{dataUrl,durationMs:clip.duration*1000},language:'zh'}});requireCurrent(record,epoch);text=result.text?.trim()||'';clip.transcript=text;
        }catch(error){requireCurrent(record,epoch);recognitionError=error;}
      }
      requireCurrent(record,epoch);
      const msg={id:clip.messageId,role:'user',text,photoId:clip.photoId||photoId,createdAt:clip.createdAt,audio:{mediaId:clip.mediaId,url:clip.receipt.url,duration:clip.duration,waveform:clip.waveform}};
      await change(record,m=>appendMessage(m,msg));requireCurrent(record,epoch);
      if(record.pendingVoice?.messageId===clip.messageId)record.pendingVoice=null;
      await saveCache(record);requireCurrent(record,epoch);
      if(s.busyOwner===token){s.busy='';s.busyOwner=null;}
      paint();
      if(visible(record,epoch,nav)&&s.ending!==record&&record.moment.status==='active'){
        s.armed=armed;
        if(text)background(ask());else{s.armed=false;s.error=recognitionError?errorText(recognitionError):'原声已经留下。这次没有听清，可以重试识别，或给这条语音补充文字。';updateChat();}
      }
      return true;
    }catch(error){
      if(current(record,epoch)){record.pendingVoice=clip;await saveCache(record);if(visible(record,epoch)){s.armed=false;s.error=errorText(error);}}
      return false;
    }finally{if(s.busyOwner===token){s.busy='';s.busyOwner=null;}paint();}
  })();record.voiceJob=job;try{return await job;}finally{if(record.voiceJob===job)record.voiceJob=null;}
}
async function audioBlob(record,audio,epoch,signal){
  const cached=await cache.getMedia(record.accountId,audio.mediaId).catch(()=>null);requireCurrent(record,epoch,signal);
  if(cached?.blob)return cached.blob;
  const blob=await fetchOwnedBlob(record,audio.url,{epoch,signal});requireCurrent(record,epoch,signal);
  await cache.putMedia(record.accountId,audio.mediaId,blob,{kind:'audio'}).catch(()=>{});requireCurrent(record,epoch,signal);return blob;
}
async function playMessage(id){
  const record=s.record,epoch=s.epoch,nav=s.nav,m=record?.moment.messages.find(item=>item.id===id);if(!m?.audio)return;
  if(playingId===id){stopPlayback();updateChat();return;}
  await preserveCapture();if(!visible(record,epoch,nav))return;stopPlayback();
  try {
    let src=urls.get(m.audio.mediaId);if(!src){const blob=await audioBlob(record,m.audio,epoch);if(!visible(record,epoch,nav))return;src=ownUrl(record,m.audio.mediaId,blob,epoch);}
    const audio=activeAudio=new Audio(src);playingId=id;
    audio.onended=()=>{if(activeAudio!==audio)return;playingId=null;activeAudio=null;if(visible(record,epoch,nav))updateChat();};
    audio.onerror=()=>{if(activeAudio!==audio)return;playingId=null;activeAudio=null;if(visible(record,epoch,nav)){toast('没有播放成功，可以再试一次。');updateChat();}};
    await audio.play();if(!visible(record,epoch,nav)){audio.pause();return;}updateChat();
  }catch(error){if(visible(record,epoch,nav)){playingId=null;toast(error.name==='NotAllowedError'?'请再点一次播放。':errorText(error));updateChat();}}
}
async function retryTranscription(id){
  const record=s.record,epoch=s.epoch,nav=s.nav,m=record?.moment.messages.find(item=>item.id===id);if(!m?.audio||s.busy)return;
  if(!s.config?.transcription?.enabled){editMessage(id);return;}
  await preserveCapture();if(!visible(record,epoch,nav))return;
  stopPlayback();const sourceText=m.text,control=aiAbort=new AbortController();s.busyOwner=control;s.busy='正在重新听这段声音…';updateChat();
  try {
    const blob=await audioBlob(record,m.audio,epoch,control.signal);requireCurrent(record,epoch,control.signal);
    const dataUrl=await blobToDataUrl(blob);requireCurrent(record,epoch,control.signal);if(!visible(record,epoch,nav))return;
    const requestId=newId(),result=await api.request('/api/moment-transcribe',{method:'POST',key:requestId,accountId:record.accountId,signal:AbortSignal.any([control.signal,AbortSignal.timeout(transcriptionTimeoutMs())]),body:{requestId,audio:{dataUrl,durationMs:m.audio.duration*1000},language:'zh'}});
    requireCurrent(record,epoch,control.signal);if(!visible(record,epoch,nav)||record.moment.messages.find(item=>item.id===id)?.text!==sourceText)return;
    await change(record,moment=>({...moment,context:{},messages:moment.messages.map(item=>item.id===id?{...item,text:result.text}:item)}));
    requireCurrent(record,epoch,control.signal);if(!visible(record,epoch,nav))return;
    s.busy='';s.busyOwner=null;updateChat();if(record.moment.status==='active')background(ask());
  }catch(error){if(visible(record,epoch,nav)&&error.name!=='AbortError')s.error=errorText(error);}
  finally{if(aiAbort===control)aiAbort=null;if(s.busyOwner===control){s.busy='';s.busyOwner=null;}if(visible(record,epoch,nav))updateChat();}
}
function editMessage(id){const m=s.record.moment.messages.find(m=>m.id===id);if(!m||m.role!=='user')return;showDialog(m.text?'修改这句话':'补充这段语音',`<form data-form="edit-message" data-id="${escape(id)}"><label class="field">你想留下的话<textarea name="text" required maxlength="12000">${escape(m.text||'')}</textarea></label><button class="primary full">保存修改</button><p class="form-status" role="status"></p></form>`);}
async function finishMoment(){
  const record=s.record,epoch=s.epoch,nav=s.nav;if(!record||s.ending)return;s.ending=record;s.armed=false;aiAbort?.abort();aiAbort=null;s.busy='';s.busyOwner=null;stopPlayback();
  try {
    if(['recording','processing'].includes(s.voice.phase)){await recorder.finish('manual');if(await clipSave===false)throw {code:'cache_unavailable'};}else recorder.cancel();
    requireCurrent(record,epoch);
    if(record.pendingVoice)await submitClip(record.pendingVoice,{record,epoch,photoId:record.pendingVoice.photoId});else if(record.voiceJob)await record.voiceJob;
    requireCurrent(record,epoch);
    await change(record,m=>({...m,status:'complete'}));requireCurrent(record,epoch);
    if(visible(record,epoch,nav)){bindDrafts(record);if(!record.pendingVoice)s.error='';render({end:true});}
    await sync(record);
    if(isGuest()&&visible(record,epoch,nav))await requestLogin('save');
  }finally{if(s.ending===record)s.ending=null;}
}
function showRename(){if(!s.record)return;showDialog('给这段回忆起个名字',`<form data-form="rename"><label class="field">回忆名称<input name="title" maxlength="80" value="${escape(s.record.moment.title)}" placeholder="例如：那天的晚风" autofocus></label><button class="primary full">完成</button></form>`);}
async function setPhotoMode(mode){
  if(!['clear','reveal'].includes(mode)||!s.user)return;const record=s.record,epoch=s.epoch,accountId=s.user.id,nav=s.nav;
  if(record&&s.view==='chat'){await change(record,m=>({...m,preferences:{...m.preferences,photoMode:mode}}));if(!current(record,epoch))return;if(visible(record,epoch,nav))particle?.setMode(mode);}
  if(isGuest()){s.user.preferences={...s.user.preferences,photoMode:mode};showSettings();return;}
  try{const result=await api.request('/v1/profile',{method:'PATCH',accountId,body:{preferences:{photoMode:mode}}});if(epoch!==s.epoch)return;s.user={...s.user,...result.user};}catch(error){if(epoch===s.epoch&&error.name!=='AbortError')toast(errorText(error));}
  if(epoch!==s.epoch)return;if(dialogRoot.children.length)showSettings();else if(s.view==='profile')render();
}
function memoryToolsHtml(){if(!s.record)return '';const archived=Boolean(s.record.moment.archivedAt);return `<section class="glass publication-entry"><strong>把这一刻带走</strong><p>图片留下照片和本人原话；HTML 回忆档案还包含原声，可离线打开，由你自行保存或分享。特殊照片格式会使用已有的显示副本。</p><div class="spatial-filters"><button class="btn gold sm" data-export-format="png">保存回忆图片</button><button class="btn ghost sm" data-export-format="html">保存含原声的回忆档案</button></div></section><section class="glass publication-entry"><strong>${archived?'这段回忆已归档':'整理这段回忆'}</strong><p>归档后可从回忆库恢复，照片和原话都会保留；已经公开的投稿需要单独撤回。</p><div class="spatial-filters"><button class="btn ghost sm" data-action="${archived?'restore-memory':'archive-memory'}">${archived?'恢复这段回忆':'归档这段回忆'}</button>${!archived&&s.record.moment.photos.length?'<button class="btn ghost sm" data-action="manage-photos">整理照片</button>':''}</div></section>`;}
function showSettings(){if(s.user)showDialog('回忆的样子',preferencesHtml()+(s.view==='chat'?memoryToolsHtml():''));}
async function archiveMemory(restore=false){
  const record=s.record,epoch=s.epoch,nav=s.nav;if(!record)return;
  await stopAll();if(!visible(record,epoch,nav))return;
  await change(record,m=>({...m,archivedAt:restore?null:new Date().toISOString()}));requireCurrent(record,epoch);
  await saveCache(record,{strict:true});const synced=await sync(record);if(!visible(record,epoch,nav))return;
  closeDialog();s.libraryFilter=restore?'all':'archived';await goLibrary();
  toast(`${restore?'已恢复':'已归档'}${record.accountId!==GUEST_ACCOUNT&&!synced?'至本机，等待同步到账号':'，照片和原话仍然保留'}。`);
}
function showPhotoManager(){const record=s.record;if(!record||record.moment.archivedAt)return;showDialog('整理照片',`<p>移除选错的照片时会另存一份回忆。原回忆、照片原件和所有原话都会保留。</p>${record.moment.photos.map(p=>`<article class="settings-panel"><img src="${escape(mediaSource(p))}" alt="${escape(p.name||'回忆照片')}" style="display:block;width:100%;max-height:180px;object-fit:contain"><p>${escape(p.name||'照片')}</p><button class="secondary" data-remove-photo="${escape(p.id)}">移除此照片并另存副本</button></article>`).join('')}`);}
async function removePhotoCopy(photoId){
  const original=s.record,epoch=s.epoch,nav=s.nav;if(!original||original.moment.archivedAt||!original.moment.photos.some(p=>p.id===photoId))return;
  await stopAll();if(!visible(original,epoch,nav))return;
  if(original.pendingVoice||original.uploads?.some(t=>!t.done)){toast('请先处理未发送的原声和照片上传，再整理照片。');return;}
  await saveCache(original,{strict:true});requireCurrent(original,epoch);
  const moment=structuredClone(original.moment),now=new Date().toISOString();moment.id=newId();moment.title=`${momentTitle(moment)} · 整理副本`;moment.createdAt=moment.updatedAt=now;moment.archivedAt=null;moment.context={};moment.photos=moment.photos.filter(p=>p.id!==photoId);
  moment.messages=moment.messages.map(message=>{if(message.photoId!==photoId)return message;const copy={...message};delete copy.photoId;return copy;});
  const copy={moment,accountId:original.accountId,version:0,base:null,revision:1,dirty:true,uploads:[],textDraft:original.textDraft||'',cloudMedia:original.cloudMedia?[...original.cloudMedia]:undefined};
  await saveCache(copy,{strict:true});requireCurrent(original,epoch);records.set(moment.id,copy);refreshLocalItem(copy);
  if(visible(original,epoch,nav)){s.record=copy;s.photoIndex=0;bindDrafts(copy);closeDialog();setRoute(`memory/${moment.id}${s.review?'/review':''}`);render();toast('整理后的副本已留下。原回忆和所有原话都还在。');}
  background(copy.cloudMedia?.length?retryOutbox(copy):sync(copy));
}
async function exportMedia(record,ref,{kind,signal,epoch=s.epoch}={}){
  requireCurrent(record,epoch,signal);
  if(kind==='audio')return audioBlob(record,ref,epoch,signal);
  const supported=blob=>blob&&['image/jpeg','image/png','image/webp'].includes(blob.type.split(';')[0].toLowerCase());
  const originalId=ref.originalMediaId||ref.mediaId;
  if(originalId){
    try{const stored=await cache.getMedia(record.accountId,originalId);requireCurrent(record,epoch,signal);const original=stored?.blob||await fetchOwnedBlob(record,`/v1/moment-media/${originalId}`,{epoch,signal,limit:16*1024*1024});requireCurrent(record,epoch,signal);if(supported(original))return original;}
    catch(error){requireCurrent(record,epoch,signal);if(error.name==='AbortError'||error.code==='account_changed')throw error;}
  }
  const cached=await cache.getMedia(record.accountId,mediaCacheId(ref));requireCurrent(record,epoch,signal);
  const preview=cached?.blob||await fetchOwnedBlob(record,ref.url,{epoch,signal,limit:16*1024*1024});requireCurrent(record,epoch,signal);return preview;
}
async function exportMoment(format){
  const record=s.record,epoch=s.epoch,nav=s.nav;if(!record||!['png','html'].includes(format))return;
  await stopAll();if(!visible(record,epoch,nav))return;
  if(record.pendingVoice||record.uploads?.some(t=>!t.done)||record.textDraft?.trim()){toast('还有未发送的文字、原声或照片上传，请返回对话处理后再导出。');return;}
  await saveCache(record,{strict:true});if(!visible(record,epoch,nav))return;
  showDialog('保存这段回忆','<div id="moment-export-output"><p role="status">正在准备回忆文件…</p><button class="text-button" data-action="close-dialog">取消</button></div>');
  const control=exportJob=new AbortController(),valid=()=>exportJob===control&&!control.signal.aborted&&visible(record,epoch,nav);
  try{
    const result=await createMomentExport({moment:structuredClone(record.moment),format,signal:control.signal,isCurrent:valid,readMedia:(ref,options)=>exportMedia(record,ref,{...options,epoch}),onProgress:({stage,current,total})=>{if(valid()){const el=dialogRoot.querySelector('#moment-export-output [role="status"]');if(el)el.textContent=stage==='media'?`正在读取素材 ${current}/${total}…`:`正在生成图片 ${current}/${total}…`;}}});
    if(!valid())return;
    const links=result.files.map(file=>{const url=URL.createObjectURL(file.blob);exportUrls.add(url);return `<article class="settings-panel"><a class="primary" href="${url}" download="${escape(file.name)}">下载 ${escape(file.name)}</a>${format==='png'?`<img src="${url}" alt="回忆图片预览" loading="lazy" style="display:block;width:100%;height:auto;margin-top:12px">`:''}</article>`;});
    const output=dialogRoot.querySelector('#moment-export-output');if(output)output.innerHTML=`<p role="status">文件已生成。点击下载；手机也可长按图片保存。文件保存在你的设备上，没有公开投稿。</p>${links.join('')}`;
  }catch(error){if(valid()&&error.name!=='AbortError'){const output=dialogRoot.querySelector('#moment-export-output');if(output)output.innerHTML=`<p class="inline-error" role="status">${escape(describeExportError(error))}</p><button class="primary" data-export-format="${format}">重试导出</button>`;}}
}
function showPasswordRecovery(){
  const intent=authIntent;
  const back=()=>{authIntent=intent;showDialog('回到你的回忆里',loginForm());};
  showDialog('找回密码','<div id="moment-recovery"></div>');
  recoverySurface=mountMomentRecovery(dialogRoot.querySelector('#moment-recovery'),{api,onClose:back,onComplete:()=>{back();toast('密码已更新，请用新密码登录。');}});
}
async function uploadAvatar(file){
  if(!s.user)return;const epoch=s.epoch,record={accountId:s.user.id};
  try{const prepared=await preparePhoto(file);requireCurrent(record,epoch);const result=await uploadBlob(record,newId(),prepared.preview,{kind:'photo',name:'avatar.jpg',epoch});requireCurrent(record,epoch);const profile=await api.request('/v1/profile',{method:'PATCH',accountId:record.accountId,body:{avatar:result.media.url}});requireCurrent(record,epoch);s.user={...s.user,...profile.user};render();toast('头像已更新');}catch(error){if(current(record,epoch)&&error.name!=='AbortError')toast(errorText(error));}
}
async function establishSession({intent=null,expectedAccountId=null}={}){
  const oldEpoch=s.epoch;
  // Validate credentials before changing ownership or clearing any in-memory draft.
  const profile=await api.request('/v1/profile',{accountId:expectedAccountId,signal:AbortSignal.timeout(10000)});if(oldEpoch!==s.epoch)return;
  if(expectedAccountId&&profile.user.id!==expectedAccountId)throw {code:'account_changed',status:409};
  if(intent&&authIntent!==intent)return;
  const wasGuest=isGuest(),recovery=claimIntent(),previousHash=location.hash;
  // A save authorizes one frozen memory ID, never every draft in the browser.
  // Legacy profile/library/spatial markers are not authorization to transfer data.
  const validId=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(id);
  const recoveryIsSave=recovery?.action==='save'&&validId(recovery.momentId)&&Array.isArray(recovery.ids)&&recovery.ids.includes(recovery.momentId);
  const recovering=!intent&&recoveryIsSave&&recovery.accountId===profile.user.id;
  const currentId=intent?.action==='save'&&wasGuest&&validId(intent.momentId)?intent.momentId:recovering?recovery.momentId:null;
  if(recovery&&!recoveryIsSave)claimIntent(null);
  if(wasGuest){
    await stopAll();
    await Promise.all([...records.values()].filter(r=>current(r)).flatMap(r=>[r.voiceJob,...(r.uploads||[]).map(t=>t.running)].filter(Boolean)));
    if(oldEpoch!==s.epoch||(intent&&authIntent!==intent))return;
    // Persist guest work locally before switching the active account, including
    // unrelated drafts; their ownership is untouched by ordinary login.
    for(const record of records.values())if(current(record)&&record.accountId===GUEST_ACCOUNT&&await cache.get(GUEST_ACCOUNT,record.moment.id))await saveCache(record,{strict:true});
  }
  if(oldEpoch!==s.epoch||(intent&&authIntent!==intent))return;
  if(currentId){
    claimIntent({accountId:profile.user.id,momentId:currentId,ids:[currentId],action:'save'});
    await cache.claimGuest(currentId,profile.user.id);
    if(oldEpoch!==s.epoch||(intent&&authIntent!==intent))return;
    intent ||= {action:'save',momentId:currentId};
    claimIntent(null);
  }
  const epoch=++s.epoch,nav=++s.nav;
  clearPhotoDetail();selectedLibraryPhotos.clear();s.photoSelecting=false;s.photoLoading=false;s.photoQuery='';s.photoMonth='';s.libraryPhotoKey=null;
  s.user=profile.user;api.setAccount(s.user.id);records.clear();s.items=[];s.record=null;s.uploads=[];s.pendingVoice=null;s.textDraft='';s.ending=null;clipSave=Promise.resolve(true);
  for(const url of urls.values())URL.revokeObjectURL(url);urls.clear();if(!['spatial','example'].includes(s.view))s.view='home';s.readReplies=s.user.preferences?.readReplies!==false;s.continuous=s.user.preferences?.continuous!==false;closeDialog();render();
  background(api.request('/api/moment-config').then(config=>{if(epoch===s.epoch)s.config=config;}));
  await loadLibrary();if(epoch!==s.epoch||nav!==s.nav)return;
  const id=intent?.action==='save'?currentId:wasGuest?null:previousHash.match(/^#memory\/([a-zA-Z0-9_-]+)(?:\/review)?$/)?.[1];
  if(intent?.action==='profile'||previousHash==='#me')await goProfile();else if(intent?.action==='library')await goLibrary();else if(id)await openMoment(id);else if(previousHash==='#public'||previousHash.startsWith('#public/'))await openPublic(previousHash.slice(8));else if(previousHash.startsWith('#example/'))await openExample(previousHash.slice(9));else if(isFamilyFrameRoute(previousHash)||isSpatialRoute(previousHash)||/^(?:#library(?:\/(?:photos|stories))?|#capture|#photo\/.+)$/.test(previousHash)){if(isFamilyFrameRoute(previousHash)){if(s.view!=='family-frame'||s.familyFrameRoute!==previousHash.slice(1))await navigateApp(previousHash.slice(1));}else if(s.view!=='spatial'||s.spatialRoute!==previousHash.slice(1))await navigateApp(previousHash.slice(1));}
  if(intent?.action==='spatial-save')await spaces.resumeSave();
  for(const record of records.values())if(current(record))background(retryOutbox(record));
}
async function guestSession(){
  const epoch=++s.epoch,nav=++s.nav;api.setAccount(GUEST_ACCOUNT);
  s.user={id:GUEST_ACCOUNT,guest:true,displayName:'访客',preferences:{}};if(!['spatial','example'].includes(s.view))s.view='home';s.loading=false;s.readReplies=true;s.continuous=true;render();
  background(api.request('/api/moment-config').then(config=>{if(epoch===s.epoch)s.config=config;}));
  await loadLibrary();if(epoch!==s.epoch||nav!==s.nav)return;
  const id=location.hash.match(/^#memory\/([a-zA-Z0-9_-]+)(?:\/review)?$/)?.[1];
  if(id&&records.has(id))await openMoment(id);
  else if(location.hash==='#public'||location.hash.startsWith('#public/'))await openPublic(location.hash.slice(8));
  else if(location.hash.startsWith('#example/'))await openExample(location.hash.slice(9));
  else if(location.hash==='#me')await goProfile();else if(isFamilyFrameRoute(location.hash)||isSpatialRoute(location.hash)||/^(?:#library(?:\/(?:photos|stories))?|#capture|#photo\/.+)$/.test(location.hash)){if(isFamilyFrameRoute(location.hash)){if(s.view!=='family-frame'||s.familyFrameRoute!==location.hash.slice(1))await navigateApp(location.hash.slice(1));}else if(s.view!=='spatial'||s.spatialRoute!==location.hash.slice(1))await navigateApp(location.hash.slice(1));}
}
async function requestLogin(action='save'){
  if(!s.user){await bootSession;if(!s.user)return;}
  const epoch=s.epoch;await stopAll();if(epoch!==s.epoch)return;
  if(!isGuest()){if(s.record)await retryOutbox(s.record);return;}
  if(s.record&&await cache.get(GUEST_ACCOUNT,s.record.moment.id))await saveCache(s.record,{strict:true});
  authIntent={action,...(action==='save'&&s.record?{momentId:s.record.moment.id}:{})};showDialog(action==='save'?'把这一刻留下':'回到你的回忆里',loginForm());
}
async function leaveSession(){
  const epoch=s.epoch,nav=++s.nav;await stopAll();if(epoch!==s.epoch||nav!==s.nav)return;
  s.epoch++;clearPhotoDetail();selectedLibraryPhotos.clear();s.photoSelecting=false;s.photoLoading=false;s.photoQuery='';s.photoMonth='';s.libraryPhotoKey=null;api.setAccount(null);s.user=null;s.record=null;s.items=[];s.uploads=[];s.pendingVoice=null;s.textDraft='';s.ending=null;records.clear();
  for(const url of urls.values())URL.revokeObjectURL(url);urls.clear();s.loginError='';s.loading=false;closeDialog();history.replaceState(null,'',appPath);await guestSession();
}
async function goHome(){const epoch=s.epoch,nav=++s.nav;await stopAll();if(epoch!==s.epoch||nav!==s.nav)return;clearPhotoDetail();s.view='home';s.error='';setRoute('');render();await loadLibrary();}
async function goFamilyFrame(route='family-frame'){const epoch=s.epoch,nav=++s.nav;await stopAll();if(epoch!==s.epoch||nav!==s.nav)return;clearPhotoDetail();s.view='family-frame';s.familyFrameRoute=route;setRoute(route);render();}

async function loadCommunity(page=1){
  communityController?.abort();
  const controller=communityController=new AbortController(),epoch=s.epoch,nav=s.nav;
  const active=()=>communityController===controller&&!controller.signal.aborted&&s.epoch===epoch&&s.nav===nav&&s.view==='home';
  s.community={data:null,loading:true,error:'',page,epoch,nav};render();
  try{
    const response=await fetch('/v1/public/moments?page='+page+'&pageSize=20',{credentials:'omit',cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});
    if(!response.ok)throw new Error('community_unavailable');
    const data=await response.json();if(!Array.isArray(data.moments))throw new Error('community_invalid');
    if(active())s.community={data,loading:false,error:'',page,epoch,nav};
  }catch{if(active())s.community={data:null,loading:false,error:'社区暂时没能打开，请检查连接后重试。',page,epoch,nav};}
  finally{if(active()){communityController=null;render();}}
}

function registrationForm(){return `<p>填写账号、密码和昵称，注册后即可创建私人空间。公开展示需另行提交审核。</p><form data-form="register"><label class="field">账号<input name="username" autocomplete="username" required minlength="3" maxlength="32" pattern="[A-Za-z0-9][A-Za-z0-9_.-]{2,31}" autocapitalize="none" spellcheck="false"></label><label class="field">密码<input name="password" type="password" autocomplete="new-password" maxlength="256" required placeholder="输入密码"></label><label class="field">昵称<input name="displayName" autocomplete="nickname" required maxlength="40"></label><button class="primary full">注册并继续</button><button type="button" class="text-button full" data-action="back-login">已有账号，返回登录</button><p class="form-status" role="status"></p></form>`;}
async function showSubmissions(record){
 const epoch=s.epoch,accountId=s.user.id;const result=await api.request('/v1/me/submissions');if(epoch!==s.epoch||accountId!==s.user.id)return;
 const items=(result.submissions||[]).filter(x=>!record||x.momentId===record.moment.id);const active=items.some(x=>['pending','published'].includes(x.status));
 showDialog(record?'投稿与公开状态':'我的投稿记录',`<p>只有明确提交的照片和对话会进入审核。此后修改私人回忆，不会改变已提交的版本。</p>${items.map(x=>`<section class="submission-item"><h3>${escape(x.title)}</h3><p><strong>${escape(statusLabel(x.status))}</strong> · ${date(x.createdAt)}</p>${x.reason?`<p>审核原因：${escape(x.reason)}</p>`:''}${x.status==='published'?`<button class="text-button" data-public-id="${escape(x.id)}">查看公开版本</button>`:''}${['pending','published'].includes(x.status)?`<form data-form="publish-withdraw" data-id="${escape(x.id)}" data-version="${x.version}" data-moment-id="${record?escape(record.moment.id):''}"><p>撤回会立即取消审核或停止公开。</p><button class="secondary">撤回投稿</button><p class="form-status" role="status"></p></form>`:''}</section>`).join('')||'<p>还没有投稿。已保存回忆的确认页中可以申请公开。</p>'}${record&&!active?`<form data-form="publish-submit" data-moment-id="${escape(record.moment.id)}"><label class="publication-consent"><input type="checkbox" name="consent" required>我有权公开这段回忆中的照片、对话和原声，同意将当前版本提交给管理员审核，批准后供所有人查看。</label><button class="primary full">提交当前版本，申请公开</button><p class="form-status" role="status"></p></form>`:''}`);
}
async function openPublic(id=''){
 closeDialog();const epoch=s.epoch,nav=++s.nav;await stopAll();if(epoch!==s.epoch||nav!==s.nav)return;s.view='public';s.publicId=id;s.publicData=null;s.publicError='';s.publicLoading=true;setRoute('public'+(id?'/'+encodeURIComponent(id):''));render();
 try{const response=await fetch('/v1/public/moments'+(id?'/'+encodeURIComponent(id):''),{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('public_unavailable');const result=await response.json();if(epoch===s.epoch&&nav===s.nav)s.publicData=result;}catch{if(epoch===s.epoch&&nav===s.nav)s.publicError='这段公开内容可能已经撤回或下架，也可能暂时无法连接。';}finally{if(epoch===s.epoch&&nav===s.nav){s.publicLoading=false;render();}}
}
function publicScreen(){const d=s.publicData;if(isV2&&s.publicId)return designShell(`${designHeader('公开的回忆','','home')}<section class="community-public-story">${s.publicLoading?'<p class="community-status" role="status">正在打开这段回忆…</p>':s.publicError?`<div class="glass community-empty"><p role="status">${escape(s.publicError)}</p><button class="btn ghost" data-action="public-retry">重新打开</button><button class="btn ghost" data-action="home">返回社区</button></div>`:`<h1>${escape(d?.moment?.title||d?.submission?.title)}</h1>${communityAuthorCredit(d?.submission||{})}${snapshotHtml(d?.moment,value=>/^\/v1\/public\/moments\//.test(value||'')?submissionMedia(value):'')}<p class="community-snapshot-note">这是作者选择公开的版本。</p>`}</section>`,{selected:'home',className:'community-home'});return designShell(`${designHeader(s.publicId?'公开的回忆':'大家留下的回忆','经讲述者授权与审核后公开','home')}<div class="public-moments">${s.publicLoading?'<p role="status">正在打开公开回忆…</p>':s.publicError?`<p role="status">${escape(s.publicError)}</p><button class="btn ghost" data-action="public-retry">重试</button>`:s.publicId?`<button class="text-button" data-action="public-list">← 全部公开回忆</button><h1>${escape(d?.moment?.title||d?.submission?.title)}</h1><p class="design-spaces-intro">${escape(d?.submission?.authorName||d?.submission?.displayName||'')} · 公开的提交版本</p>${snapshotHtml(d?.moment)}`:`<div class="public-grid">${(d?.moments||[]).map(m=>`<button class="glass public-card" data-public-id="${escape(m.id)}">${submissionMedia(m.coverPhotoUrl)?`<img src="${escape(m.coverPhotoUrl)}" alt="${escape(m.title)}" loading="lazy">`:''}<strong>${escape(m.title)}</strong><small>${escape(m.authorName)} · ${date(m.createdAt)}</small></button>`).join('')||'<p>还没有公开回忆。你保存的回忆默认不公开；获授权的管理员可为审核查看。公开仍需你同意投稿。</p>'}</div>`}</div>`,{page:'A1',selected:'home'});}

async function loadExamples(){
  s.examplesLoading=true;s.examplesError=false;
  try{s.examples=(await fetchExamples()).examples||[];}catch{s.examplesError=true;}
  finally{s.examplesLoading=false;if(s.view==='home')render();}
}
async function openExample(id){
  const epoch=s.epoch,nav=++s.nav;await stopAll();if(epoch!==s.epoch||nav!==s.nav)return;
  s.exampleId=id;s.example=null;s.exampleIndex=0;s.exampleLoading=true;s.view='example';
  setRoute(`example/${encodeURIComponent(id)}`);render();
  try{const data=await fetchExamples(id);if(epoch!==s.epoch||nav!==s.nav)return;s.example=data.example;}
  catch{if(epoch!==s.epoch||nav!==s.nav)return;}
  if(epoch===s.epoch&&nav===s.nav){s.exampleLoading=false;render();}
}
async function goProfile(){const epoch=s.epoch,nav=++s.nav;await stopAll();if(epoch!==s.epoch||nav!==s.nav)return;s.view='profile';setRoute('me');render();}
async function discardVoice(){
  const record=s.record,clip=record?.pendingVoice,epoch=s.epoch;if(!clip||record.voiceJob)return;
  record.pendingVoice=null;await saveCache(record,{strict:true});requireCurrent(record,epoch);
  await cache.removeMedia(record.accountId,clip.mediaId);requireCurrent(record,epoch);s.armed=false;clipSave=Promise.resolve(true);if(visible(record,epoch)){bindDrafts(record);updateComposer();}
}

async function onAction(event){
  const target=event.target.closest('button');if(!target||target.disabled)return;
  try{
    if(!s.user && target.dataset.example===undefined && target.dataset.examplePhoto===undefined && target.dataset.spatialRoute===undefined && target.dataset.action!=='home'){const nav=s.nav;await bootSession;if(!s.user||s.nav>nav+1)return;}
    if(target.dataset.action==='recover-password'){cancelLoginAttempt();showPasswordRecovery();return;}
    if(target.dataset.libraryMode){s.libraryFilter=target.dataset.libraryFilter||'all';await goLibrary(target.dataset.libraryMode);return;}
    if(target.dataset.libraryPhoto){if(s.photoSelecting){const key=target.dataset.libraryPhoto;if(selectedLibraryPhotos.has(key))selectedLibraryPhotos.delete(key);else selectedLibraryPhotos.add(key);render();}else await openLibraryPhoto(target.dataset.libraryPhoto);return;}
    if(target.dataset.photoStep){const entries=libraryPhotoSequence(),next=entries[entries.findIndex(entry=>entry.key===s.libraryPhotoKey)+Number(target.dataset.photoStep)];if(next)await openLibraryPhoto(next.key);return;}
    if(target.dataset.sharePhotoStory){await shareLibraryPhotoStory(target.dataset.sharePhotoStory,target.dataset.storyPhoto);return;}
    if(target.dataset.photoStory){await talkLibraryPhoto(target.dataset.photoStory,target.dataset.storyPhoto);return;}
    if(target.dataset.libraryUploadRetry){const record=records.get(target.dataset.memoryId),task=record?.uploads?.find(task=>task.id===target.dataset.libraryUploadRetry);if(record&&task&&current(record)){target.disabled=true;await uploadPhoto(task,record);if(s.view==='library')render();}return;}
    if(target.dataset.exportFormat){target.disabled=true;try{await exportMoment(target.dataset.exportFormat);}finally{if(target.isConnected)target.disabled=false;}return;}
    if(target.dataset.action==='register'){cancelLoginAttempt();showDialog('创建回忆时刻账号',registrationForm());return;}
    if(target.dataset.action==='back-login'){cancelLoginAttempt();showDialog('回到你的回忆里',loginForm());return;}
    if(target.dataset.action==='community-refresh'){await loadCommunity(s.community?.page||1);return;}
    if(target.dataset.communityPage){await loadCommunity(Math.max(1,Number(target.dataset.communityPage)||1));return;}
    if(target.dataset.communityAuthor){await navigateApp('community-author/'+target.dataset.communityAuthor);return;}
    if(target.dataset.action==='public-list'){await openPublic();return;}
    if(target.dataset.publicId){await openPublic(target.dataset.publicId);return;}
    if(target.dataset.action==='public-retry'){await openPublic(s.publicId);return;}
    if(['moment-submission','my-submissions'].includes(target.dataset.action)){target.disabled=true;try{await showSubmissions(target.dataset.action==='moment-submission'?s.record:null);}finally{if(target.isConnected)target.disabled=false;}return;}
    if(target.dataset.action==='retry-spatial'){location.reload();return;}
    if(target.dataset.spatialRoute!==undefined){if(s.view!=='spatial'||!target.closest?.('#spatial-content'))await navigateApp(target.dataset.spatialRoute);return;}
    if(target.dataset.example){await openExample(target.dataset.example);return;}
    if(target.dataset.examplePhoto!==undefined){s.exampleIndex=Number(target.dataset.examplePhoto);render();return;}
    if(target.dataset.libraryFilter){s.libraryFilter=target.dataset.libraryFilter;render();return;}
    if(target.dataset.removePhoto){target.disabled=true;try{await removePhotoCopy(target.dataset.removePhoto);}finally{if(target.isConnected)target.disabled=false;}return;}
    if(target.dataset.direction){s.mode='text';s.textDraft=target.dataset.direction;s.record.textDraft=s.textDraft;updateComposer();root.querySelector('textarea')?.focus();background(saveCache(s.record));return;}
    if(target.dataset.open){await openMoment(target.dataset.open);return;}
    if(target.dataset.photo!==undefined){const record=s.record,epoch=s.epoch,nav=++s.nav;await stopAll();if(visible(record,epoch,nav)){s.photoIndex=Number(target.dataset.photo);record.pendingAI=null;background(saveCache(record));render({end:true});}return;}
    if(target.dataset.play){await playMessage(target.dataset.play);return;}
    if(target.dataset.read){const record=s.record,epoch=s.epoch,nav=s.nav,msg=record.moment.messages.find(x=>x.id===target.dataset.read);if(!msg)return;if(speechTarget===msg.id&&s.speaking){stopPlayback();updateChat();}else{await preserveCapture();if(!visible(record,epoch,nav))return;stopPlayback();tts.prepare();speechTarget=msg.id;await tts.speak(msg.text);}return;}
    if(target.dataset.edit){editMessage(target.dataset.edit);return;}
    if(target.dataset.transcribe){await retryTranscription(target.dataset.transcribe);return;}
    if(target.dataset.photoMode){await setPhotoMode(target.dataset.photoMode);return;}
    if(target.dataset.uploadRetry){const record=s.record,epoch=s.epoch,nav=s.nav,task=s.uploads.find(x=>x.id===target.dataset.uploadRetry);if(task){await uploadPhoto(task,record,epoch);if(visible(record,epoch,nav)&&record.moment.photos.length&&!record.moment.messages.length&&!s.busy)background(ask());}return;}
    if(target.dataset.uploadRemove){const record=s.record,epoch=s.epoch,task=record.uploads.find(x=>x.id===target.dataset.uploadRemove);if(task&&!task.running){record.uploads=record.uploads.filter(x=>x!==task);await saveCache(record,{strict:true});if(visible(record,epoch)){bindDrafts(record);render();}}return;}
    switch(target.dataset.action){
      case 'close-dialog':closeDialog();break;
      case 'home':if(s.user)await goHome();break;
      case 'family-frame':await navigateApp('family-frame');break;
      case 'profile':await goProfile();break;
      case 'login-profile':await requestLogin('profile');break;
      case 'open-library':await goLibrary();break;
      case 'photo-library-back':s.libraryFilter='all';await goLibrary('photos');break;
      case 'add-library-photos':await goCapture();break;
      case 'refresh-photos':await loadLibrary();await loadPhotoRecords();break;
      case 'toggle-photo-selection':s.photoSelecting=!s.photoSelecting;if(!s.photoSelecting)selectedLibraryPhotos.clear();render();break;
      case 'join-selected-photos':await joinLibraryPhotos(selectedPhotoRefs(libraryPhotos(),selectedLibraryPhotos));break;
      case 'join-library-photo':await joinLibraryPhotos(selectedPhotoRefs(libraryPhotos(),[s.libraryPhotoKey]));break;
      case 'talk-library-photo':await talkLibraryPhoto();break;
      case 'share-photo-story':await shareLibraryPhotoStory();break;
      case 'photo-stories':root.querySelector('#photo-stories')?.scrollIntoView({behavior:'smooth'});break;
      case 'save-photo-cloud':{const entry=currentLibraryPhoto();if(entry){await openMoment(entry.momentId);if(isGuest()&&s.record?.moment.id===entry.momentId)await requestLogin('save');}break;}
      case 'library-active':s.libraryFilter='all';await goLibrary();break;
      case 'archive-memory':await archiveMemory();break;
      case 'restore-memory':await archiveMemory(true);break;
      case 'manage-photos':showPhotoManager();break;
      case 'capture':await goCapture();break;
      case 'capture-camera':s.chooseFresh=true;s.avatarUpload=false;cameraInput.value='';cameraInput.click();break;
      case 'capture-library':s.chooseFresh=true;s.avatarUpload=false;photoInput.value='';photoInput.click();break;
      case 'suggestion':{if(!s.record||s.busy)break;await preserveCapture();s.mode='text';s.armed=false;stopPlayback();s.textDraft=target.dataset.suggestionText||'';s.record.textDraft=s.textDraft;updateComposer();root.querySelector('textarea')?.focus();await saveCache(s.record);break;}
      case 'review-back':s.review=false;setRoute('memory/'+encodeURIComponent(s.record.moment.id));render({end:true});break;
      case 'confirm-memory':await finishMoment();break;
      case 'refresh':await loadLibrary();break;
      case 'retry-examples':await loadExamples();break;
      case 'retry-example':await openExample(s.exampleId);break;
      case 'cloud-library':await requestLogin('library');break;
      case 'save-cloud':await requestLogin('save');break;
      case 'new':showDialog('添加到回忆里',`<div class="choose-source"><button data-action="new-photo">${icon('photo')}添加照片</button><button data-action="new-space">${icon('book')}创建空间</button></div>`);break;
      case 'new-photo':await goCapture();break;
      case 'new-space':closeDialog();await navigateApp('new-space');break;
      case 'add':choosePhotos(false);break;
      case 'library':closeDialog();photoInput.value='';photoInput.click();break;
      case 'camera':closeDialog();cameraInput.value='';cameraInput.click();break;
      case 'avatar':s.avatarUpload=true;photoInput.value='';photoInput.click();break;
      case 'start-voice':await startVoice();break;
      case 'finish-voice':await recorder.finish();break;
      case 'cancel-voice':s.armed=false;recorder.cancel();updateComposer();break;
      case 'send-voice':{const clip=s.pendingVoice;if(clip)await submitClip(clip,clip.target);break;}
      case 'discard-voice':await discardVoice();break;
      case 'pause-listening':await preserveCapture();updateComposer();break;
      case 'voice-mode':s.mode='voice';updateComposer();break;
      case 'text-mode':{const record=s.record,epoch=s.epoch,nav=s.nav;await preserveCapture();if(!visible(record,epoch,nav))break;s.mode='text';s.armed=false;stopPlayback();updateComposer();root.querySelector('textarea')?.focus();break;}
      case 'rename':s.record?.conflict?conflictDialog():showRename();break;
      case 'chat-settings':showSettings();break;
      case 'end':await reviewMemory();break;
      case 'continue':{s.review=false;const record=s.record,epoch=s.epoch,nav=s.nav;await change(record,m=>({...m,status:'active'}));if(visible(record,epoch,nav))render({end:true});break;}
      case 'toggle-read':s.readReplies=!s.readReplies;if(!s.readReplies)stopPlayback();await savePrefs({readReplies:s.readReplies});break;
      case 'toggle-continuous':s.continuous=!s.continuous;if(!s.continuous)s.armed=false;await savePrefs({continuous:s.continuous});break;
      case 'retry':{const record=s.record,epoch=s.epoch,nav=s.nav;s.error='';await retryOutbox(record);if(visible(record,epoch,nav)&&!record.conflict)background(ask());break;}
      case 'conflict':conflictDialog();break;
      case 'copy-conflict':await saveConflictCopy();break;
      case 'username':showDialog('修改登录账号',`<form data-form="username"><p>当前账号：${escape(s.user.username)}</p><label class="field">新的账号<input name="username" autocomplete="username" value="${escape(s.user.username||'')}" minlength="3" maxlength="32" pattern="[A-Za-z0-9][A-Za-z0-9_.-]{2,31}" required autocapitalize="none" spellcheck="false"></label><label class="field">当前密码<input name="currentPassword" type="password" autocomplete="current-password" required></label><button class="primary full">保存账号</button><p class="form-status" role="status"></p></form>`);break;
      case 'password':showDialog('修改密码','<form data-form="password"><label class="field">当前密码<input name="currentPassword" type="password" autocomplete="current-password" required></label><label class="field">新密码<input name="newPassword" type="password" autocomplete="new-password" maxlength="256" required placeholder="输入新密码"></label><label class="field">再输入一次<input name="repeatPassword" type="password" autocomplete="new-password" required></label><button class="primary full">修改密码</button><p class="form-status" role="status"></p></form>');break;
      case 'logout':await stopAll();await api.request('/v1/auth/logout',{method:'POST',body:{}});await leaveSession();break;
    }
  }catch(error){if(error.name!=='AbortError')toast(errorText(error));}
}
async function savePrefs(preferences){
  if(isGuest()){s.user.preferences={...s.user.preferences,...preferences};if(dialogRoot.children.length)showSettings();else render();return;}
  if(!s.user)return;const epoch=s.epoch,accountId=s.user.id;
  try{const result=await api.request('/v1/profile',{method:'PATCH',accountId,body:{preferences}});if(epoch!==s.epoch)return;s.user={...s.user,...result.user};}catch(error){if(epoch===s.epoch&&error.name!=='AbortError')toast(errorText(error));}
  if(epoch!==s.epoch)return;if(dialogRoot.children.length)showSettings();else render();
}
function conflictDialog(){showDialog('另一台设备有新的内容','<p>两份修改都已保留。把此设备的内容另存为一段回忆，就可以分别查看。</p><button class="primary full" data-action="copy-conflict">另存此设备的回忆</button>');}
async function saveConflictCopy(){
  const old=s.record,epoch=s.epoch,nav=s.nav;if(!old?.conflict)return;
  const copy=structuredClone(old.moment);copy.id=newId();copy.title=`${momentTitle(copy)} · 此设备`;copy.createdAt=new Date().toISOString();
  const record={moment:copy,version:0,base:null,dirty:true,revision:1,accountId:s.user.id,uploads:[],pendingVoice:null};
  await saveCache(record,{strict:true});requireCurrent(old,epoch);records.set(copy.id,record);
  old.moment=old.conflict.moment;old.version=old.conflict.version;old.base=structuredClone(old.moment);old.dirty=false;old.pendingWrite=null;old.conflict=null;old.pendingAI=null;await saveCache(old);requireCurrent(old,epoch);
  if(visible(old,epoch,nav)){s.record=record;bindDrafts(record);s.error='';closeDialog();history.replaceState(null,'',`${appPath}#memory/${copy.id}`);render();}background(sync(record));
}
function passwordForSubmission(value){const password=String(value??''),bytes=new Blob([password]).size;if(bytes<10||bytes>256)throw {code:bytes>256?'password_too_long':'password_invalid'};return password;}
async function passwordSignIn(credentials,{intent,attempt,epoch}){
  const login=await api.request('/v1/auth/password-login',{method:'POST',body:credentials,accountId:null,signal:attempt.signal});
  if(epoch===s.epoch&&authIntent===intent&&!attempt.signal.aborted){
    loginAttempt=null;
    claimIntent(intent?.action==='save'&&intent.momentId?{accountId:login.accountId,momentId:intent.momentId,ids:[intent.momentId],action:'save'}:null);
    await establishSession({intent,expectedAccountId:login.accountId});
  }
}
async function onSubmit(event){
  const form=event.target.closest('form[data-form]');if(!form)return;event.preventDefault();
  const data=new FormData(form),button=form.querySelector('button[type="submit"],button:not([type])'),status=form.querySelector('.form-status');if(button)button.disabled=true;
  const epoch=s.epoch,record=s.record,nav=s.nav,accountId=s.user?.id;
  try{switch(form.dataset.form){
    case 'register':{
      const {intent,attempt}=startLoginAttempt(),username=String(data.get('username')).trim(),password=passwordForSubmission(data.get('password'));
      const result=await api.request('/v1/auth/register',{method:'POST',accountId:null,signal:attempt.signal,body:{username,password,displayName:String(data.get('displayName')).trim()}});
      if(epoch!==s.epoch||authIntent!==intent||attempt.signal.aborted)break;
      if(result.registration?.status!=='active'){loginAttempt=null;showDialog('账号状态','<p>账号尚未启用，请稍后重新登录。你的本机草稿仍保留。</p><button class="primary full" data-action="back-login">返回登录</button>');break;}
      try{await passwordSignIn({username,password},{intent,attempt,epoch});}
      catch(error){if(epoch===s.epoch&&authIntent===intent&&!attempt.signal.aborted){loginAttempt=null;showDialog('账号已创建',loginForm());const usernameField=dialogRoot.querySelector('[name=username]');if(usernameField)usernameField.value=username;const message=dialogRoot.querySelector('.form-status');if(message)message.textContent='账号已创建，可以直接登录。'+errorText(error);}}
      break;
    }
    case 'publish-submit':{if(!data.get('consent'))throw {code:'consent_required'};if(!record||record.moment.id!==form.dataset.momentId)throw {code:'account_changed'};await sync(record);requireCurrent(record,epoch);if(record.dirty||!record.version)throw {code:'sync_required'};await api.request(`/v1/moments/${encodeURIComponent(record.moment.id)}/submissions`,{method:'POST',body:{expectedVersion:record.version,consent:true}});if(epoch===s.epoch)await showSubmissions(record);break;}
    case 'publish-withdraw':{await api.request(`/v1/me/submissions/${encodeURIComponent(form.dataset.id)}/withdraw`,{method:'POST',body:{expectedVersion:Number(form.dataset.version)}});if(epoch===s.epoch)await showSubmissions(form.dataset.momentId?record:null);break;}
    case 'login':{const {intent,attempt}=startLoginAttempt();await passwordSignIn({username:String(data.get('username')).trim(),password:String(data.get('password'))},{intent,attempt,epoch});break;}
    case 'photo-search':s.photoQuery=String(data.get('query')||'').trim();s.photoMonth=String(data.get('month')||'');render();break;
    case 'library-search':s.libraryQuery=String(data.get('query')||'').trim();render();break;
    case 'message':await sendText(String(data.get('text')));break;
    case 'profile':{const result=await api.request('/v1/profile',{method:'PATCH',accountId,body:{displayName:String(data.get('displayName')).trim()}});if(epoch!==s.epoch)break;s.user={...s.user,...result.user};render();toast('资料已保存');break;}
    case 'username':{const result=await api.request('/v1/profile',{method:'PATCH',accountId,body:{username:String(data.get('username')).trim(),currentPassword:String(data.get('currentPassword'))}});if(epoch!==s.epoch)break;s.user={...s.user,...result.user};closeDialog();render();toast('登录账号已更新');break;}
    case 'password':if(data.get('newPassword')!==data.get('repeatPassword'))throw {code:'password_mismatch'};await stopAll();if(epoch!==s.epoch)break;await api.request('/v1/auth/password-change',{method:'POST',accountId,body:{currentPassword:String(data.get('currentPassword')),newPassword:passwordForSubmission(data.get('newPassword'))}});if(epoch!==s.epoch)break;closeDialog();toast('密码已更新，请重新登录。');await leaveSession();break;
    case 'rename':await change(record,m=>({...m,title:String(data.get('title')).trim()}));if(visible(record,epoch,nav)){closeDialog();render();}break;
    case 'edit-message':{
      if(!visible(record,epoch,nav))break;aiAbort?.abort();aiAbort=null;s.busy='';s.busyOwner=null;stopPlayback();
      const id=form.dataset.id;await change(record,m=>({...m,context:{},messages:m.messages.map(x=>x.id===id?{...x,text:String(data.get('text')).trim()}:x)}));
      if(visible(record,epoch,nav)){closeDialog();updateChat();if(record.moment.status==='active'&&record.moment.messages.at(-1)?.id===id)background(ask());}break;
    }
  }}catch(error){if(epoch!==s.epoch||error.name==='AbortError')return;const msg=['publish-submit','publish-withdraw','register'].includes(form.dataset.form)?(error.code==='sync_required'?'当前回忆还没有同步完成。请先关闭窗口，重试同步后再投稿。':error.code==='consent_required'?'请先确认公开授权。':moderationError(error)):error.code==='password_mismatch'?'两次输入的新密码不一致。':error.code==='authentication_failed'&&['username','password'].includes(form.dataset.form)?'当前密码不正确，请再试一次。':errorText(error);if(status?.isConnected)status.textContent=msg;else toast(msg);}finally{if(button?.isConnected)button.disabled=false;}
}
async function retryOutbox(record,epoch=s.epoch){
  if(!current(record,epoch)||!navigator.onLine)return;
  if(record.outboxJob)return record.outboxJob;
  const job=flushOutbox(record,epoch);record.outboxJob=job;try{return await job;}catch(error){if(visible(record,epoch)){s.error=errorText(error);updateChat();}throw error;}finally{record.outboxJob=null;}
}
async function flushOutbox(record,epoch){
  for(const id of [...(record.cloudMedia||[])]){
    const stored=await cache.getMedia(record.accountId,id);requireCurrent(record,epoch);
    if(!stored?.blob)throw {code:'cache_unavailable'};
    await uploadBlob(record,id,stored.blob,{kind:stored.kind||'photo',name:stored.name||id,epoch});requireCurrent(record,epoch);
    record.cloudMedia=record.cloudMedia.filter(x=>x!==id);await saveCache(record,{strict:true});
  }
  await hydrateMedia(record,epoch);requireCurrent(record,epoch);
  for(const task of record.uploads||[]){if(!current(record,epoch))return;if(!task.done&&task.file)await uploadPhoto(task,record,epoch);}
  requireCurrent(record,epoch);
  if(record.pendingVoice?.sendRequested)await submitClip(record.pendingVoice,{record,epoch,nav:s.nav,photoId:record.pendingVoice.photoId});
  if(record.dirty)await sync(record);
}
root.addEventListener('click',onAction);dialogRoot.addEventListener('click',onAction);root.addEventListener('submit',onSubmit);dialogRoot.addEventListener('submit',onSubmit);
root.addEventListener('input',event=>{if(event.target.id==='moment-text'){s.textDraft=event.target.value;if(s.record){const record=s.record;record.textDraft=s.textDraft;record.textUncached=true;clearTimeout(record.draftTimer);record.draftTimer=setTimeout(()=>background(saveCache(record)),250);}}});
photoInput.addEventListener('change',()=>{background(selected([...photoInput.files]));});cameraInput.addEventListener('change',()=>{background(selected([...cameraInput.files]));});
dialogRoot.addEventListener('keydown',event=>{if(event.key==='Escape'){closeDialog();return;}if(event.key==='Tab'){const all=[...dialogRoot.querySelectorAll('button,input,textarea,a[href]')].filter(e=>!e.disabled);const first=all[0],last=all.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}});
window.visualViewport?.addEventListener('resize',updateViewport);
function restoreRoute(){clearTimeout(routeDispatch);routeDispatch=setTimeout(()=>{if(s.user){routeScroll.set(renderedRoute,window.scrollY||0);background(navigateApp(location.hash.slice(1)));}},0);}
window.addEventListener('popstate',restoreRoute);
window.addEventListener('hashchange',restoreRoute);
window.addEventListener('online',()=>{for(const record of records.values())if(current(record))background(retryOutbox(record));});
window.addEventListener('offline',updateSync);
window.addEventListener('pagehide',()=>{s.armed=false;tts.stop();if(s.record)background(saveCache(s.record));});
window.addEventListener('beforeunload',event=>{if(['recording','processing'].includes(s.voice.phase)||[...records.values()].some(r=>current(r)&&(r.cacheFailed||r.textUncached||r.uploads?.some(t=>!t.done&&!t.durable)))){event.preventDefault();event.returnValue='';}});
document.addEventListener('visibilitychange',()=>{if(document.hidden){s.armed=false;tts.stop();activeAudio?.pause();}});
await window.momentStyles;
s.view=isV2&&isFamilyFrameRoute(location.hash)?'family-frame':isV2&&isSpatialRoute(location.hash)?'spatial':'home';
if(s.view==='family-frame')s.familyFrameRoute=location.hash.slice(1);else if(s.view==='spatial')s.spatialRoute=location.hash.slice(1);
render();
const bootEpoch=s.epoch;const bootSession=establishSession().catch(async error=>{if(s.epoch!==bootEpoch)return;await guestSession();if(error.status!==401&&error.name!=='AbortError')toast('暂时无法连接账号，可先在此设备留下回忆。');});background(bootSession);
background(loadExamples());
if(/^(?:#cases(?:\?|$)|#case\/|#example\/)/.test(location.hash))background(navigateApp(location.hash.slice(1)));

function peekPhoto(clear){particle?.setMode(clear?'clear':s.record?.moment.preferences.photoMode||'reveal');}
root.addEventListener('pointerdown',event=>{const button=event.target.closest('[data-action="peek"]');if(!button)return;button.setPointerCapture?.(event.pointerId);peekPhoto(true);});
root.addEventListener('pointerup',()=>peekPhoto(false));root.addEventListener('pointercancel',()=>peekPhoto(false));
root.addEventListener('keydown',event=>{if(event.target.closest('[data-action="peek"]')&&[' ','Enter'].includes(event.key)){event.preventDefault();peekPhoto(true);}});
root.addEventListener('keyup',event=>{if(event.target.closest('[data-action="peek"]')&&[' ','Enter'].includes(event.key))peekPhoto(false);});
root.addEventListener('focusout',event=>{if(event.target.closest('[data-action="peek"]'))peekPhoto(false);});
