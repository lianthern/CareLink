import { designHeader, designShell } from './moment-design.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const savedDate=value=>{const d=new Date(value);return Number.isFinite(d.getTime())?new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'long',day:'numeric'}).format(d):'保存日期未知';};

// One original can appear in multiple recovery/edit copies. Its media identity
// stays stable; stories retain their original record/photo IDs and audio.
export function collectLibraryPhotos(records,{accountId,includeArchived=false}={}) {
  const photos=new Map();
  for(const record of records){
    if(record.accountId!==accountId||!record.moment||record.moment.archivedAt&&!includeArchived)continue;
    const moment=record.moment;
    for(const photo of moment.photos||[]){
      const identity=photo.originalMediaId||photo.mediaId||`${moment.id}/${photo.id}`;
      const key=`${accountId}|${identity}`;
      const words=(moment.messages||[]).filter(m=>m.role==='user');
      const story={momentId:moment.id,photoId:photo.id,title:moment.title||photo.name||'未命名回忆',status:moment.status,archivedAt:moment.archivedAt,userCount:words.length};
      let entry=photos.get(key);
      if(!entry){entry={key,accountId,momentId:moment.id,photoId:photo.id,mediaId:photo.mediaId,originalMediaId:photo.originalMediaId,name:photo.name||'照片',photo,savedAt:moment.createdAt,stories:[],spaceLinks:[],searchText:'',syncPending:false};photos.set(key,entry);}
      entry.syncPending ||= Boolean(record.dirty||record.saving||record.cloudMedia?.length);
      entry.stories.push(story);
      entry.searchText+=` ${photo.name||''} ${moment.title||''} ${words.map(m=>m.text||'').join(' ')}`;
      for(const link of photo.spaceLinks||[]){if(typeof link?.spaceId==='string'&&typeof link?.photoId==='string'&&!entry.spaceLinks.some(x=>x.spaceId===link.spaceId&&x.photoId===link.photoId))entry.spaceLinks.push({spaceId:link.spaceId,photoId:link.photoId});}
    }
  }
  return [...photos.values()].sort((a,b)=>String(b.savedAt).localeCompare(String(a.savedAt))||a.key.localeCompare(b.key));
}

export function filterLibraryPhotos(entries,{query='',month=''}={}){
  const term=String(query).trim().toLocaleLowerCase();
  return entries.filter(entry=>(!term||entry.searchText.toLocaleLowerCase().includes(term))&&(!month||String(entry.savedAt).slice(0,7)===month));
}

export function selectedPhotoRefs(entries,keys){
  const selected=new Set(keys);
  return entries.filter(p=>selected.has(p.key)).map(({key,accountId,momentId,photoId,mediaId,originalMediaId,name})=>({key,accountId,momentId,photoId,mediaId,originalMediaId,name}));
}

export const photoLibraryTabs=mode=>`<div class="photo-library-tabs" aria-label="回忆库内容"><button class="${mode==='photos'?'selected':''}" data-library-mode="photos" aria-pressed="${mode==='photos'}">照片</button><button class="${mode==='stories'?'selected':''}" data-library-mode="stories" aria-pressed="${mode==='stories'}">故事</button></div>`;

export const photoLibraryStyles=`<style>
.photo-library .nav>.btn{width:fit-content;flex:0 0 auto;white-space:nowrap}.photo-library .nav>h1{flex:1;min-width:0}.photo-library .nav>.grow{display:none}.photo-library-tabs{display:flex;gap:6px;padding:5px;margin:12px 0 20px;border:1px solid rgba(173,150,186,.18);border-radius:18px;background:rgba(255,255,255,.42)}.photo-library-tabs button{flex:1;border:0;border-radius:13px;padding:12px;background:transparent;font:inherit;color:var(--muted,#82758b)}.photo-library-tabs .selected{background:rgba(255,255,255,.9);box-shadow:0 3px 14px #bcacc322;color:var(--ink,#46374e)}.photo-library-intro{font-size:12px;line-height:1.8;color:var(--muted,#82758b);margin:8px 0 18px}.photo-library-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:12px 0}.photo-library-tools input{flex:1;min-width:110px}.photo-library-tools select{max-width:132px}.photo-library-tools input,.photo-library-tools select{border:1px solid #d8cddc;border-radius:12px;background:#ffffffe0;padding:11px;font:inherit;color:inherit}.photo-library-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin:18px 0}.photo-library-cell{position:relative;border:0;padding:0;background:#efe9f1;border-radius:15px;overflow:hidden;aspect-ratio:1;cursor:pointer}.photo-library-cell img{display:block;width:100%;height:100%;object-fit:cover}.photo-library-cell[aria-pressed="true"]{outline:3px solid #c5a465;outline-offset:2px}.photo-library-check{position:absolute;right:7px;top:7px;display:grid;place-items:center;width:22px;height:22px;border-radius:50%;background:#fffc;border:1px solid #d7bd8c;color:#6c552e}.photo-library-caption{position:absolute;bottom:0;left:0;right:0;padding:16px 7px 7px;background:linear-gradient(transparent,#25203499);color:white;font-size:10px;text-align:left}.photo-library-selection{position:sticky;bottom:94px;z-index:4;display:flex;gap:8px;align-items:center;padding:12px;border-radius:18px;background:#fff8ed;border:1px solid #dec99f;box-shadow:0 5px 24px #38254515}.photo-library-selection span{flex:1;font-size:12px}.photo-detail .nav h1{min-width:0;overflow-wrap:anywhere}.photo-detail-frame{background:#ede7f0;border-radius:22px;overflow:hidden;margin:16px 0}.photo-detail-frame img{display:block;width:100%;max-height:65vh;min-height:180px;object-fit:contain}.photo-detail-paging{display:flex;justify-content:space-between;align-items:center;gap:8px;color:var(--muted,#82758b);font-size:12px}.photo-detail-actions{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin:20px 0}.photo-detail-actions .btn{width:100%;padding:13px 8px}.photo-detail-story{padding:16px;margin:10px 0}.photo-detail-story p{font-size:12px;line-height:1.7}.photo-detail-original{font-size:12px;line-height:1.7;overflow-wrap:anywhere}.photo-library-pending{display:flex;gap:10px;align-items:center;padding:12px;margin:8px 0;border-radius:14px;background:#fff9}.photo-library-pending img{width:46px;height:46px;object-fit:cover;border-radius:9px}.photo-library-pending span{flex:1;min-width:0;font-size:12px;overflow-wrap:anywhere}.photo-library-empty{padding:36px 20px;text-align:center;line-height:1.9;color:var(--muted,#82758b)}@media(min-width:700px){.photo-library-grid{grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.photo-detail-frame img{max-height:70vh}}
</style>`;
const styles=photoLibraryStyles;

export const photoLibraryCaption=(entry,guest=false)=>savedDate(entry.savedAt)+(!guest&&entry.syncPending?' · 待同步':entry.stories.some(story=>story.userCount)?' · 有故事':'');
export function photoLibraryScreen({entries,allEntries=entries,media,query='',month='',selecting=false,selectedKeys=[],loading=false,error='',guest=false,pending=[],archivedCount=0}){
  const selected=new Set(selectedKeys),months=[...new Set(allEntries.map(p=>String(p.savedAt).slice(0,7)).filter(m=>/^\d{4}-\d{2}$/.test(m)))].sort().reverse();
  return designShell(`${styles}${designHeader('回忆库',loading&&!allEntries.length?'正在读取照片…':`${allEntries.length} 张照片${guest?' · 保存在这台设备':''}`,'home','<button class="btn gold sm" data-action="add-library-photos">＋ 添加</button>')}${photoLibraryTabs('photos')}
    <p class="photo-library-intro">先把照片留下，想说时再慢慢聊。${guest?'打开一张照片，可将它所在的这一组回忆保存到账号。':'照片、原件与故事会一起保存到账号；待同步内容先留在本机。'}</p>
    <form class="photo-library-tools" data-form="photo-search"><input name="query" type="search" value="${esc(query)}" placeholder="搜索照片名、故事或自己的原话" aria-label="搜索照片"><select name="month" aria-label="按保存月份筛选"><option value="">全部时间</option>${months.map(value=>`<option value="${value}" ${month===value?'selected':''}>${value}</option>`).join('')}</select><button class="btn ghost sm">查找</button></form>
    <div class="photo-library-tools"><button class="btn gold sm" data-spatial-route="photo-scenes">按场景整理大量照片</button><button class="text-button" data-action="toggle-photo-selection">${selecting?'取消多选':'多选照片'}</button><button class="text-button" data-library-mode="stories" data-library-filter="archived">已归档（${archivedCount}）</button><button class="text-button" data-action="refresh-photos">刷新</button></div>
    ${error?`<p class="inline-error" role="status">${esc(error)} <button data-action="refresh-photos">重试</button></p>`:''}${loading?'<p class="photo-library-intro" role="status">正在读取全部照片…</p>':''}
    ${pending.map(t=>`<div class="photo-library-pending" role="status">${t.preview?`<img src="${esc(t.preview)}" alt="待保存照片">`:''}<span>${esc(t.name)}<br>${esc(t.status||'等待保存')}</span>${t.error?`<button class="text-button" data-library-upload-retry="${esc(t.id)}" data-memory-id="${esc(t.momentId)}">重试</button>`:''}</div>`).join('')}
    <div class="photo-library-grid">${loading&&!entries.length?Array.from({length:6},()=>'<div class="photo-library-cell" aria-hidden="true"></div>').join(''):''}${entries.map(p=>`<button class="photo-library-cell" data-library-photo="${esc(p.key)}" aria-label="${selecting?'选择':'查看'} ${esc(p.name)}" ${selecting?`aria-pressed="${selected.has(p.key)}"`:''}><img src="${esc(media(p.photo))}" alt="${esc(p.name)}" loading="lazy" decoding="async">${selecting?`<span class="photo-library-check" aria-hidden="true">${selected.has(p.key)?'✓':''}</span>`:''}<span class="photo-library-caption" data-photo-sync="${esc(p.key)}">${esc(photoLibraryCaption(p,guest))}</span></button>`).join('')}</div>
    ${!entries.length&&!loading?`<div class="photo-library-empty">${allEntries.length?'没有符合筛选条件的照片。':'这里会收好你的每一张照片。'}<br><button class="btn gold" data-action="add-library-photos">添加照片</button></div>`:''}
    ${selecting?`<div class="photo-library-selection"><span>已选 ${selected.size} 张</span><button class="btn gold sm" data-action="join-selected-photos" ${!selected.size?'disabled':''}>加入空间</button></div>`:''}`,{page:'A1',selected:'library',className:'photo-library'});
}

export function photoDetailAssociations(entry,{guest=false}={}){
  const linked=entry.spaceLinks.length>0;
  return {shareHtml:guest?'':linked?'<button class="btn ghost" data-action="share-photo-story">选择故事与原声分享</button>':'',
    spacesHtml:linked?`<section><h2>照片所在的空间</h2>${entry.spaceLinks.map((link,i)=>`<button class="btn ghost" data-spatial-route="shared-space/${encodeURIComponent(link.spaceId)}?tab=photos&photoId=${encodeURIComponent(link.photoId)}">回到空间${entry.spaceLinks.length>1?' '+(i+1):''} ›</button>`).join('')}</section>`:guest?'':'<p class="photo-library-intro">先把照片加入空间，再逐项选择要分享的故事与原声。私人聊天不会随照片自动分享。</p>',
    stories:entry.stories.map(story=>({key:story.momentId+'|'+story.photoId,html:!guest&&linked?`<button class="btn ghost sm" data-share-photo-story="${esc(story.momentId)}" data-story-photo="${esc(story.photoId)}">选择此故事的内容分享</button>`:''}))};
}
export function photoDetailScreen({entry,index,total,media,originalUrl='',originalDisplay=false,originalLoading=false,originalError='',guest=false}){
  if(!entry)return designShell(`${styles}${designHeader('照片','这张照片暂时不可读取','photo-library-back')}<p class="photo-library-empty">照片可能在另一份草稿或账号中。<button data-action="photo-library-back">返回照片库</button></p>`,{selected:'library'});
  const stories=entry.stories.filter(story=>story.userCount),associations=photoDetailAssociations(entry,{guest});
  return designShell(`${styles}${designHeader(entry.name,savedDate(entry.savedAt),'photo-library-back')}
    <div class="photo-detail-paging"><button class="text-button" data-photo-step="-1" ${index<=0?'disabled':''}>‹ 上一张</button><span>${index+1} / ${total}</span><button class="text-button" data-photo-step="1" ${index>=total-1?'disabled':''}>下一张 ›</button></div>
    <div class="photo-detail-frame"><img src="${esc(originalDisplay&&originalUrl?originalUrl:media(entry.photo))}" alt="${esc(entry.name)}"></div>
    <div class="photo-detail-original">${originalLoading?'正在读取原照片…':originalError?esc(originalError):originalDisplay?'正在查看原照片。':'特殊格式使用已有显示副本，原件仍保留。'}${originalUrl?` <a href="${esc(originalUrl)}" download="${esc(entry.name)}">保存原照片</a>`:''}</div>
    <div class="photo-detail-actions"><button class="btn gold" data-action="talk-library-photo">聊聊这张</button><button class="btn ghost" data-action="join-library-photo">加入空间</button><button class="btn ghost" data-action="photo-stories">查看已有故事（${stories.length}）</button>${guest?'<button class="btn ghost" data-action="save-photo-cloud">保存到账号</button>':''}<span data-photo-share-entry>${associations.shareHtml}</span></div>
    <div data-photo-linked-spaces>${associations.spacesHtml}</div>
    <section id="photo-stories"><h2>已有故事</h2><p class="photo-library-intro">故事与原声保留在原来的回忆里。AI 的提问和你的原话分别显示。</p>${stories.map(story=>`<article class="glass photo-detail-story"><strong>${esc(story.title)}</strong><p>${story.userCount} 条本人讲述${story.archivedAt?' · 已归档':''}</p><button class="btn ghost sm" data-photo-story="${esc(story.momentId)}" data-story-photo="${esc(story.photoId)}">打开故事与原声</button><span data-photo-story-share="${esc(story.momentId+'|'+story.photoId)}">${associations.stories.find(item=>item.key===story.momentId+'|'+story.photoId)?.html||''}</span></article>`).join('')||'<p class="photo-library-intro">还没有留下讲述。照片已经保存，可以随时开始。</p>'}</section>`,{page:'A2',selected:'library',className:'photo-detail'});
}

export function photoCaptureScreen(){return designShell(`${styles}${designHeader('添加照片','一次选多张，先保存，也可以以后再聊','photo-library-back')}<div class="glass" style="padding:28px 20px;margin-top:26px"><h2>先收好这一刻</h2><p class="photo-library-intro">原照片保留，保存不需要先回答 AI。每组最多 24 张，单张最多 12 MB。</p><div class="photo-detail-actions"><button class="btn gold" data-action="capture-library">从相册选择</button><button class="btn ghost" data-action="capture-camera">拍一张照片</button></div></div>`,{page:'B1',selected:'library'});}
