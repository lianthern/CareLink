import {SharedUpload} from './moment-shared-upload.js';
import {openSpacePhotoStory,storyMediaUrl} from './space-photo-story.js';

const enc=encodeURIComponent;
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(value);
const safeMedia=value=>{
  if(typeof value!=='string'||!value.startsWith('/v1/viewer/spaces/')||value.includes('..'))return '';
  try{const url=new URL(value,'https://unseen.local');url.searchParams.set('access','account');return url.pathname+url.search;}catch{return '';}
};
const photoUrl=(spaceId,photo)=>{const photoIdValue=photo?.id||photo?.photoId||'',candidate=safeMedia(photo?.photoMedia?.url||photo?.assetUrl||'');if(candidate&&!new RegExp(`/photos/${enc(photoIdValue)}/media(?:\\?|$)`).test(candidate))return candidate;return safeMedia(`/v1/viewer/spaces/${enc(spaceId)}/photos/${enc(photoIdValue)}/album-media`);};
const photoId=photo=>photo?.id||photo?.photoId||'';
const nameOf=value=>typeof value==='string'?value.trim():String(value?.displayName||value?.name||value?.authorCredit||value?.username||value?.uploader||'').trim();
const avatarOf=value=>safeMedia(value?.avatar||value?.avatarUrl||value?.photoUrl||'');
const anonymousPersonNames=new Set(['空间成员','家庭成员','同行者','成员','成员信息由空间提供','成员信息','未知成员']);
const normalizePersonName=value=>String(value||'').trim().replace(/\s+/g,' ').toLocaleLowerCase();
export function dedupeFamilyPeople(values=[]){
  const seenIds=new Set(),seenNames=new Set(),result=[];
  for(const value of values){
    const name=nameOf(value),normalized=normalizePersonName(name);
    if(!normalized||anonymousPersonNames.has(name)||anonymousPersonNames.has(normalized))continue;
    const rawId=typeof value==='object'&&(value?.id||value?.userId||value?.accountId);
    const id=rawId?String(rawId).trim():'';
    if(id?seenIds.has(id):seenNames.has(normalized))continue;
    if(id)seenIds.add(id);else seenNames.add(normalized);
    result.push({id:id||`name:${normalized}`,name,avatar:avatarOf(value)});
  }
  return result;
}

export function familyRoute(route){
  const value=String(route||'').replace(/^#/,'').split('?')[0];
  if(value==='family-frame')return {spaceId:null};
  const match=value.match(/^family-frame\/([A-Za-z0-9_-]{1,160})$/);
  if(match)return {spaceId:match[1]};
  return null;
}

export function familyPhotoStatus(photo,{newPhoto=false,newStory=false,calling=false}={}){
  if(calling||photo?.calling===true)return 'green';
  if(newStory)return 'blue';
  if(newPhoto)return 'yellow';
  return 'quiet';
}

export function createFamilyFrame({api,user=()=>null,navigate=()=>{},login=()=>{}}){
  let root,control,owner,spaceId,spaces=[],data={},selected=0,search='',destroyed=false,poll,noteDialog,upload,recognition,recognitionTimer,loadPromise,loadGeneration=0;
  const current=()=>Boolean(root&&!destroyed&&!control?.signal.aborted&&user()?.id===owner);
  const accountPath=path=>{const url=new URL(path,globalThis.location?.origin||'http://localhost');url.searchParams.set('access','account');return url.pathname+url.search;};
  const request=(path,options={})=>api.request(accountPath(path),{...options,accountId:owner,signal:AbortSignal.any([control.signal,...(options.signal?[options.signal]:[])])});
  const status=text=>{const node=root?.querySelector('[data-ff-status]');if(node)node.textContent=text;};
  const storageKey=()=>`unseen.family-frame.v1.${owner}.${spaceId}`;
  const prefKey=()=>`unseen.family-frame.space.v1.${owner}`;
  function readSpacePreference(){try{const value=localStorage.getItem(prefKey());return validId(value)?value:null;}catch{return null;}}
  function writeSpacePreference(){try{if(validId(spaceId))localStorage.setItem(prefKey(),spaceId);}catch{/* preference is optional */}}
  function readSeen(){try{const value=JSON.parse(localStorage.getItem(storageKey())||'{}');return {photos:new Set(value.photos||[]),stories:new Set(value.stories||[])}}catch{return {photos:new Set(),stories:new Set()};}}
  function writeSeen(seen){try{localStorage.setItem(storageKey(),JSON.stringify({photos:[...seen.photos].slice(-200),stories:[...seen.stories].slice(-300)}));}catch{/* unread rings remain session-only */}}
  function markSeen(photo,{stories=false}={}){const seen=readSeen(),pid=photoId(photo);if(pid)seen.photos.add(pid);if(stories)for(const story of storiesFor(pid))if(story.storyId)seen.stories.add(story.storyId);writeSeen(seen);}
  function storyRows(){return Array.isArray(data.stories)?data.stories:[];}
  function storiesFor(pid){return storyRows().filter(story=>story.photoId===pid&&!['withdrawn','hidden'].includes(story.visibility));}
  function people(){
    const values=[];
    for(const source of [data.viewer?.members,data.viewer?.participants,data.viewer?.contributors,data.space?.members,data.space?.participants])if(Array.isArray(source))values.push(...source);
    for(const photo of data.photos||[])if(photo.uploader)values.push(typeof photo.uploader==='string'?{name:photo.uploader}:{...photo.uploader});
    return dedupeFamilyPeople(values).slice(0,6);
  }
  function currentPhoto(){return data.photos?.[selected]||null;}
  function filteredPhotos(){const query=search.trim().toLocaleLowerCase();if(!query)return data.photos||[];return (data.photos||[]).filter(photo=>`${nameOf(photo.uploader)} ${photo.caption||photo.title||''}`.toLocaleLowerCase().includes(query));}
  function visiblePhoto(){const photos=filteredPhotos();return photos[Math.min(selected,Math.max(0,photos.length-1))]||null;}
  function currentStatus(photo){
    if(!photo)return 'quiet';const seen=readSeen(),pid=photoId(photo),stories=storiesFor(pid);
    return familyPhotoStatus(photo,{calling:data.viewer?.calling===true,newPhoto:!!pid&&!seen.photos.has(pid),newStory:stories.some(story=>story.storyId&&!seen.stories.has(story.storyId))});
  }
  function unreadStoryPhoto(){const seen=readSeen();return (data.photos||[]).find(photo=>storiesFor(photoId(photo)).some(story=>story.storyId&&!seen.stories.has(story.storyId)))||null;}
  function unreadPhoto(){const seen=readSeen();return (data.photos||[]).find(photo=>photoId(photo)&&!seen.photos.has(photoId(photo)))||null;}
  function spaceStatus(){if(data.viewer?.calling===true)return {name:'green',copy:'通话状态（尚未接通）'};if(unreadStoryPhoto())return {name:'blue',copy:'有新留言，点留言查看'};if(unreadPhoto())return {name:'yellow',copy:'有新照片，点相框查看'};return {name:'quiet',copy:'可以给这张照片留言'};}
  function storyText(story){return (story?.pieces||[]).map(piece=>piece.text||'').filter(Boolean).join(' ');}
  function readPhoto(){
    const photo=visiblePhoto();if(!photo)return;
    const texts=[photo.caption,photo.title,nameOf(photo.uploader)&&`${nameOf(photo.uploader)}上传的照片`,...storiesFor(photoId(photo)).map(storyText)].filter(Boolean);
    if(!texts.length){status('这张照片还没有文字，可以点“留言”留下第一句话。');return;}
    if(!('speechSynthesis' in globalThis)){status('这台设备暂时不支持朗读。');return;}
    globalThis.speechSynthesis.cancel();const utterance=new SpeechSynthesisUtterance(texts.join('。'));utterance.lang='zh-CN';utterance.onstart=()=>status('正在朗读照片里的故事');utterance.onend=()=>{markSeen(photo,{stories:true});paint({preserveFocus:true});status('朗读结束');};globalThis.speechSynthesis.speak(utterance);
  }
  function peopleHtml(){
    const rows=people();if(!rows.length)return '';return `<section class="ff-people" aria-label="空间成员"><h2>一起留下的人</h2><div class="ff-avatars">${rows.map(person=>`<span class="ff-person" title="${esc(person.name)}">${person.avatar?`<img src="${esc(person.avatar)}" alt="${esc(person.name)}">`:`<b>${esc(Array.from(person.name)[0]||'人')}</b>`}<small>${esc(person.name)}</small></span>`).join('')}</div></section>`;
  }
  function photoStrip(){const photos=filteredPhotos();return photos.length?`<div class="ff-strip" role="tablist" aria-label="空间照片">${photos.map((photo,index)=>`<button class="ff-thumb ${index===selected?'is-selected':''} ff-status-${currentStatus(photo)}" data-ff-action="select" data-ff-index="${index}" role="tab" aria-selected="${index===selected}"><img src="${esc(photoUrl(spaceId,photo))}" alt="照片 ${index+1}" loading="lazy"><span>${index+1}</span></button>`).join('')}</div>`:`<div class="ff-empty"><p>这个空间还没有可以展示的照片。</p>${data.canUpload?'<p>可以从手机端上传第一张照片。</p>':''}</div>`;
  }
  function storySummary(photo){
    const rows=storiesFor(photoId(photo)).filter(story=>story.visibility!=='hidden');
    return rows.slice(-3).map(story=>`<article class="ff-story"><strong>${esc(story.authorCredit||'同行者')}</strong>${(story.pieces||[]).map(piece=>`${piece.text?`<p>${esc(piece.text)}</p>`:''}${piece.audio&&storyMediaUrl(piece.audio.url)?`<small>原声${piece.audio.duration?` · ${Math.ceil(piece.audio.duration)} 秒`:''}</small><audio controls preload="none" src="${esc(storyMediaUrl(piece.audio.url))}"></audio>`:''}`).join('')||'<p>原声已留下</p>'}</article>`).join('')||'<p class="ff-no-story">还没有留言。家人可以从手机端给这张照片留一句话。</p>';
  }
  function uploadHtml(){
    if(!data.canUpload)return '<p class="ff-permission">当前账号可以查看这个空间；上传权限由空间主人控制。</p>';
    if(data.uploadError)return `<p class="ff-permission" role="status">暂时不能上传，请稍后重新检查空间权限。</p><button type="button" class="ff-small-button" data-ff-action="refresh">重新检查</button>`;
    const formats=(data.upload?.photoFormats||[]).join(',');const limit=data.upload?.limits?.batchItems;
    return `<form class="ff-upload" data-ff-form="upload" data-family-upload><h2>从手机留下照片</h2><p>${limit?`每次最多 ${Number(limit)} 张。`:''}照片会进入这个空间，按现有审核规则展示。</p><label class="ff-file">选择照片<input name="photos" type="file" accept="${esc(formats||'image/*')}" multiple required></label><label class="ff-consent"><input type="checkbox" name="consent" required>我有权把选中的照片加入这个空间，并同意空间内展示与位置建议。</label><button type="submit" class="ff-action-button" ${upload?.busy?'disabled':''}>${upload?.busy?'正在上传…':'上传照片'}</button><p class="ff-upload-status" data-ff-upload-status>${upload?.state?.completed?`已收到 ${upload.state.completed.photoIds?.length||0} 张照片`:''}</p></form>`;
  }
  function frame(){
    const photo=visiblePhoto(),spaceState=spaceStatus(),statusName=spaceState.name,stories=photo?storiesFor(photoId(photo)):[];
    const spacesHtml=spaces.length>1?`<label class="ff-space-select">选择家庭空间<select data-ff-space>${spaces.map(space=>`<option value="${esc(space.spaceId||space.id)}" ${(space.spaceId||space.id)===spaceId?'selected':''}>${esc(space.name||'回忆空间')}</option>`).join('')}</select></label>`:'';
    const familyTools=`<details class="ff-family-tools"><summary>家属操作</summary>${spacesHtml}${uploadHtml()}<section class="ff-search" aria-label="找人"><label>按人找照片<input data-ff-search type="search" value="${esc(search)}" placeholder="输入姓名或照片标题"><button type="button" class="ff-small-button" data-ff-action="voice-search">语音找人</button></label></section>${photoStrip()}</details>`;
    if(data.guest)return `<section class="family-frame-shell" data-family-frame><div class="ff-empty ff-empty-main" role="status"><h2>先登录，再打开家庭相框</h2><p>登录后只会显示你有权限查看的家庭空间。</p><button type="button" class="ff-primary-button" data-ff-action="login">登录</button><button type="button" class="ff-small-button" data-ff-action="home">回到首页</button></div></section>`;
    if(data.spaceChoices)return `<section class="family-frame-shell" data-family-frame><header class="ff-head"><button type="button" class="ff-back" data-ff-action="back">‹ 回忆空间</button><div><small>家庭相框</small><h1>选择一个家庭空间</h1></div></header><div class="ff-empty ff-empty-main"><h2>你有多个可查看的空间</h2><p>先选择要显示在相框里的空间。</p><div class="ff-space-choices">${spaces.map(space=>`<button type="button" class="ff-space-choice" data-ff-action="choose-space" data-ff-space-id="${esc(space.spaceId||space.id)}"><strong>${esc(space.name||'回忆空间')}</strong><small>${(space.tasks||[]).includes('upload')?'可以上传照片':'可以查看照片'}</small></button>`).join('')}</div></div></section>`;
    if(data.noSpace)return `<section class="family-frame-shell" data-family-frame><header class="ff-head"><button type="button" class="ff-back" data-ff-action="back">‹ 回忆空间</button><div><small>家庭相框</small><h1>还没有家庭空间</h1></div></header><div class="ff-empty ff-empty-main" role="status"><h2>先创建一个回忆空间</h2><p>创建后，你可以邀请家人一起留下照片和留言。</p><button type="button" class="ff-primary-button" data-ff-action="create">创建回忆空间</button></div></section>`;
    if(!photo)return `<section class="family-frame-shell" data-family-frame><header class="ff-head"><button type="button" class="ff-back" data-ff-action="back">‹ 回忆空间</button><div><small>家庭相框</small><h1>${esc(data.space?.name||'家庭相框')}</h1></div><button type="button" class="ff-refresh" data-ff-action="refresh" aria-label="刷新">↻</button></header>${peopleHtml()}${familyTools}<div class="ff-empty ff-empty-main" role="status"><h2>${data.loading?'正在打开相框…':'还没有照片'}</h2><p>${data.error?esc(data.error):'照片和留言会出现在这里。'}</p>${!data.canUpload?'<p class="ff-permission">请让空间主人开启照片收集，或使用已有成员上传权限。</p>':''}</div><p class="ff-call-note">通话功能尚未接通；当前只展示真实照片、留言和朗读。</p></section>`;
    const ringLabel=spaceState.name==='blue'?'有新留言':spaceState.name==='yellow'?'有新照片':spaceState.name==='green'?'通话状态':'已读';
    const ring=spaceState.name==='quiet'?`<span class="ff-status-ring" aria-label="${ringLabel}"></span>`:`<button type="button" class="ff-status-ring" data-ff-action="jump-unread" aria-label="${ringLabel}，跳到新内容"></button>`;
    return `<section class="family-frame-shell" data-family-frame><header class="ff-head"><button type="button" class="ff-back" data-ff-action="back">‹ 回忆空间</button><div><small>家庭相框</small><h1>${esc(data.space?.name||'家庭相框')}</h1></div><button type="button" class="ff-refresh" data-ff-action="refresh" aria-label="刷新">↻</button></header>${peopleHtml()}<main class="ff-main"><section class="ff-stage" aria-label="家庭相框照片"><div class="ff-photo-wrap ff-status-${statusName}"><img class="ff-photo" data-family-photo src="${esc(photoUrl(spaceId,photo))}" alt="家庭照片 ${selected+1}">${ring}<span class="ff-photo-count">${selected+1} / ${data.photos.length}</span></div><div class="ff-photo-meta"><h2>${esc(photo.title||photo.caption||'这一刻')}</h2><p>${esc(nameOf(photo.uploader)?`${nameOf(photo.uploader)}留下的照片`:'空间里的照片')}</p></div><div class="ff-controls"><button type="button" class="ff-nav-button" data-ff-action="previous" aria-label="上一张">上一张</button><button type="button" class="ff-primary-button" data-ff-action="note" data-family-reply ${data.canReply?'':'disabled aria-disabled="true"'}>${data.canReply?'留言':'查看留言'}</button><button type="button" class="ff-nav-button" data-ff-action="next" aria-label="下一张">下一张</button></div><div class="ff-secondary-controls"><button type="button" class="ff-small-button" data-ff-action="read">朗读照片</button><span class="ff-state-copy" data-ff-status>${spaceState.copy}${stories.length?` · 当前照片 ${stories.length} 条留言`:''}</span></div></section><aside class="ff-side"><section class="ff-stories" aria-label="照片留言"><h2>照片留言</h2>${storySummary(photo)}</section></aside></main>${familyTools}<p class="ff-call-note">通话功能尚未接通；当前只展示真实照片、留言和朗读。</p></section>`;
  }
  function paint({preserveFocus=false}={}){if(!current())return;const openStates=[...root.querySelectorAll('.ff-family-tools')].map(node=>node.open),active=preserveFocus?root.querySelector('[data-ff-search]:focus'):null,selection=active?{start:active.selectionStart,end:active.selectionEnd}:null;root.innerHTML=frame();root.querySelectorAll('.ff-family-tools').forEach((node,index)=>{node.open=openStates[index]??false;});if(active){const next=root.querySelector('[data-ff-search]');next?.focus();if(selection&&typeof next.setSelectionRange==='function')next.setSelectionRange(selection.start,selection.end);}}
  function select(index){const photos=filteredPhotos();if(!photos.length)return;selected=Math.max(0,Math.min(Number(index)||0,photos.length-1));markSeen(photos[selected]);paint();}
  async function performLoad({quiet=false,generation}={}){
    const live=()=>current()&&generation===loadGeneration;if(!live())return;data.loading=!quiet;data.error='';if(!quiet)paint();
    try{
      if(!spaceId){const result=await request('/v1/me/spaces');if(!live())return;spaces=(result.spaces||[]).filter(space=>{const tasks=space.tasks||[];return validId(space.spaceId||space.id)&&tasks.includes('view')&&space.spaceLifecycle!=='archived';});const preferred=readSpacePreference();if(preferred&&spaces.some(space=>(space.spaceId||space.id)===preferred))spaceId=preferred;else if(spaces.length>1){data.spaceChoices=true;data.loading=false;paint();return;}else{const first=spaces[0];if(!first)throw Object.assign(new Error('no_space'),{code:'no_space'});spaceId=first.spaceId||first.id;}}
      else if(!spaces.length){const result=await request('/v1/me/spaces');if(!live())return;spaces=(result.spaces||[]).filter(space=>validId(space.spaceId||space.id)&&space.spaceLifecycle!=='archived');}
      const selectedSpace=spaces.find(space=>(space.spaceId||space.id)===spaceId);if(!selectedSpace)throw Object.assign(new Error('resource_unavailable'),{code:'resource_unavailable'});
      data.space=selectedSpace;data.spaceChoices=false;data.noSpace=false;data.canUpload=(selectedSpace.tasks||[]).includes('upload');data.canReply=data.canUpload&&selectedSpace.collectionState==='open';writeSpacePreference();
      const viewer=await request(`/v1/viewer/spaces/${enc(spaceId)}`);if(!live())return;const storyResult=await request(`/v1/viewer/spaces/${enc(spaceId)}/stories`);if(!live())return;
      data.viewer=viewer;data.photos=Array.isArray(viewer.photos)?viewer.photos.filter(photo=>validId(photoId(photo))&&photoUrl(spaceId,photo)):[];data.stories=Array.isArray(storyResult.stories)?storyResult.stories:[];
      if(data.canUpload){try{data.upload=await request(`/v1/spaces/${enc(spaceId)}/upload-context`);if(!live())return;upload ||= new SharedUpload({request,spaceId,identityKey:String(owner),signal:control.signal,isCurrent:current,onChange:()=>{const node=root?.querySelector('[data-ff-upload-status]');if(node)node.textContent=upload?.busy?'正在上传…':'';}});if(upload.state?.batchId&&!upload.result)await upload.refresh();if(!live())return;}catch(error){data.uploadError=error;}}
      if(!live())return;selected=Math.min(selected,Math.max(0,data.photos.length-1));data.loading=false;data.error='';const fileInput=root?.querySelector('.ff-upload input[type="file"]'),consent=root?.querySelector('.ff-upload input[name="consent"]'),searchInput=root?.querySelector('[data-ff-search]:focus');if(!quiet||(!fileInput?.files?.length&&!consent?.checked))paint({preserveFocus:Boolean(searchInput)});
    }catch(error){if(!live()||error.name==='AbortError')return;noteDialog?.destroy();noteDialog=null;globalThis.speechSynthesis?.cancel?.();recognition?.abort?.();recognition=null;data.loading=false;data.error=error.code==='no_space'?'还没有可查看的家庭空间。':error.code==='resource_unavailable'?'这个空间暂时无法查看。':'照片暂时没有读到，请稍后重试。';data.noSpace=error.code==='no_space';data.spaceChoices=false;data.viewer=null;data.photos=[];data.stories=[];data.canUpload=false;data.canReply=false;data.upload=null;data.uploadError=error;upload=null;paint();}
  }
  function load(options={}){if(loadPromise)return loadPromise;const generation=++loadGeneration;const promise=performLoad({...options,generation});const wrapped=promise.finally(()=>{if(loadPromise===wrapped)loadPromise=null;});loadPromise=wrapped;return wrapped;}
  async function submitUpload(form){
    if(!data.upload||!upload)return;const statusEl=root.querySelector('[data-ff-upload-status]');if(!form.elements.consent.checked){if(statusEl)statusEl.textContent='请先确认你有权分享这些照片。';return;}
    const files=[...form.elements.photos.files];if(!files.length)return;try{if(statusEl)statusEl.textContent='正在上传照片…';await upload.start(files,data.upload);if(upload.complete())await upload.finalize();if(statusEl)statusEl.textContent='照片已提交，正在更新相框。';await load();}catch(error){if(current()&&statusEl)statusEl.textContent=error.code==='upload_photo_policy'?'照片格式或大小不符合空间要求，请重新选择。':'照片还没有确认保存成功，保留原文件后可重试。';}
  }
  function voiceSearch(){
    const Recognition=globalThis.SpeechRecognition||globalThis.webkitSpeechRecognition;if(!Recognition){status('这台设备暂时不支持语音找人，请直接输入姓名。');return;}
    recognition?.abort?.();clearTimeout(recognitionTimer);recognition=new Recognition();recognition.lang='zh-CN';recognition.interimResults=false;recognition.maxAlternatives=1;status('请说出家人的名字');recognition.onresult=event=>{search=event.results?.[0]?.[0]?.transcript||'';selected=0;paint();};recognition.onerror=()=>status('没有听清，请直接输入姓名再试。');recognition.onend=()=>{clearTimeout(recognitionTimer);recognition=null;};recognition.start();recognitionTimer=setTimeout(()=>{recognition?.stop?.();recognition=null;status('没有听清，请直接输入姓名再试。');},10000);
  }
  function click(event){const button=event.target.closest('[data-ff-action]');if(button&&!root.contains(button)){return;}if(button){const action=button.dataset.ffAction;if(action==='back')return navigate('spaces');if(action==='home')return navigate('home');if(action==='login')return login('spatial');if(action==='create')return navigate('new-space');if(action==='choose-space'&&validId(button.dataset.ffSpaceId))return navigate(`family-frame/${button.dataset.ffSpaceId}`);if(action==='refresh')return void load();if(action==='jump-unread'){const target=unreadStoryPhoto()||unreadPhoto();if(target){search='';selected=Math.max(0,(data.photos||[]).indexOf(target));markSeen(target);paint();}return;}if(action==='select')return select(button.dataset.ffIndex);if(action==='previous')return select(selected-1);if(action==='next')return select(selected+1);if(action==='read')return readPhoto();if(action==='voice-search')return voiceSearch();if(action==='note'){const photo=visiblePhoto();if(!photo)return;if(!data.canReply){status('当前账号可以查看留言，但没有在此空间留言的权限。');return;}markSeen(photo,{stories:true});paint();noteDialog?.destroy();noteDialog=openSpacePhotoStory({request,api,user,spaceId,photoId:photoId(photo),identityKey:String(owner),signal:control.signal,showPhoto:true,onSaved:saved=>{if(saved?.storyId){const seen=readSeen();seen.stories.add(saved.storyId);writeSeen(seen);}void load({quiet:true})}});return;} }
  }
  function input(event){if(event.target.matches('[data-ff-search]')){search=event.target.value;selected=0;paint({preserveFocus:true});}}
  function change(event){const space=event.target.closest('[data-ff-space]');if(space){const next=space.value;if(validId(next)&&next!==spaceId)navigate(`family-frame/${next}`);}}
  function submit(event){const form=event.target.closest('[data-ff-form="upload"]');if(!form)return;event.preventDefault();void submitUpload(form);}
  async function mount(target,route){destroy();root=target;control=new AbortController();owner=user()?.id;destroyed=false;const parsed=familyRoute(route);if(!parsed){root.innerHTML='<p role="status">家庭相框地址无效。</p>';return;}spaceId=parsed.spaceId;spaces=[];data={loading:true,photos:[],stories:[]};selected=0;search='';if(!owner||user()?.guest===true){data.guest=true;root.addEventListener('click',click);paint();return;}root.addEventListener('click',click);root.addEventListener('input',input);root.addEventListener('change',change);root.addEventListener('submit',submit);paint();await load();poll=setInterval(()=>{if(current()&&!document.hidden)void load({quiet:true});},25000);}
  function destroy(){destroyed=true;loadGeneration++;loadPromise=null;clearInterval(poll);poll=null;clearTimeout(recognitionTimer);recognition?.abort?.();recognition=null;globalThis.speechSynthesis?.cancel?.();noteDialog?.destroy();noteDialog=null;control?.abort();root?.removeEventListener('click',click);root?.removeEventListener('input',input);root?.removeEventListener('change',change);root?.removeEventListener('submit',submit);root=null;upload=null;spaces=[];data={};}
  return {mount,destroy};
}
