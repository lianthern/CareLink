import {designTitle} from './moment-design.js';
import {esc, statusLabel} from './moment-moderation.js';
import {communityAuthorCredit, communityMomentCards, communityMoments} from './moment-community.js';
import {mountCorridor} from './app-v2-corridor.js';
import {mountAppSpatial} from './unseen-app-spatial.js';

const id = encodeURIComponent;
export function publicSpaceMedia(value, submissionId) {
  if(typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(submissionId || ''))return '';
  const prefix=`/v1/public/spaces/${submissionId}/media/`;
  return value.startsWith(prefix) && /^(?:panorama|depth|photo-\d+|video-\d+)$/.test(value.slice(prefix.length)) ? value : '';
}
export async function readCommunity(path,{signal}={}) {
  if(!/^\/v1\/public\/(?:moments|spaces|authors)(?:[/?]|$)/.test(path))throw new Error('public_path_invalid');
  const response=await fetch(path,{credentials:'omit',cache:'no-store',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)});
  const data=await response.json();
  if(!response.ok)throw Object.assign(new Error('public_unavailable'),{status:response.status,code:data?.error?.code||data?.error});
  return data;
}
const button=(route,words,cls='btn ghost')=>`<button class="${cls}" data-community-route="${esc(route)}">${words}</button>`;
const errorCopy=error=>error?.status===409?'内容刚刚有更新，请重新打开后核对状态。':error?.status===404||error?.status===403?'这段公开内容已不可查看，可能已撤回或下架。':'暂时没有完成，请检查连接后重试。';

export function createCommunitySpaces({api,user,guest,navigate,login}) {
  let root,controller,generation=0,disposeView=()=>{},dialog,dialogOrigin;
  function closeDialog(){if(!dialog)return;dialog.querySelectorAll('video,audio').forEach(media=>{media.pause();media.removeAttribute('src');media.load();});dialog.close();dialog.remove();dialog=null;if(dialogOrigin?.isConnected)dialogOrigin.focus({preventScroll:true});}
  function destroy(){generation++;controller?.abort();disposeView();disposeView=()=>{};closeDialog();root?.closest('.design-shell')?.classList.remove('v2-immersive');}
  async function mount(target,route) {
    destroy();root=target;controller=new AbortController();const token=generation,account=user()?.id;
    const active=()=>token===generation&&!controller.signal.aborted&&root.isConnected&&user()?.id===account;
    const check=()=>{if(!active())throw new DOMException('页面已切换','AbortError');};
    const request=async(path,options={})=>{check();const result=await api.request(path,{...options,signal:controller.signal});check();return result;};
    const publicRead=async path=>{check();const result=await readCommunity(path,{signal:controller.signal});check();return result;};
    const tell=words=>{if(active())root.querySelector('[data-community-status]').textContent=words;};
    const header=(title,back='spaces')=>`<header class="nav v2-page-head">${button(back,'‹','ib')}<h1>${esc(title)}</h1></header>`;
    function frame(html){root.innerHTML=html+'<p class="v2-feedback" role="status" data-community-status></p>';root.onclick=event=>{const b=event.target.closest('[data-community-route]');if(b){event.stopPropagation();navigate(b.dataset.communityRoute);}};}
    frame(header('回忆空间')+'<p class="community-status" role="status">正在打开…</p>');
    const [path,query='']=route.split('?'),params=new URLSearchParams(query);
    try {
      if(path.startsWith('community-author/')){
        const authorId=path.slice(17),page=Math.max(1,Number(params.get('page'))||1),suffix=`?authorId=${id(authorId)}&page=${page}&pageSize=20`;
        const [moments,spaces]=await Promise.all([publicRead('/v1/public/moments'+suffix),publicRead('/v1/public/spaces'+suffix)]);
        const rows=communityMoments(moments),publicSpaces=spaces.submissions||[],name=rows[0]?.authorName||publicSpaces[0]?.authorName||'社区成员';
        const date=value=>{const d=new Date(value);return Number.isFinite(d.getTime())?d.toLocaleDateString('zh-CN',{month:'long',day:'numeric'}):'';};
        frame(header('公开作品','')+`<section class="community-author-profile"><span class="community-author-mark">${esc(Array.from(name)[0])}</span><h2>${esc(name)}</h2><p>在社区分享的照片、故事和空间</p></section>${designTitle('MEMORIES','照片与故事')}${rows.length?communityMomentCards(rows,date):'<p class="community-status">这一页没有公开的照片故事。</p>'}${designTitle('SPACES','回忆空间')}<div class="v2-my-spaces">${publicSpaces.map(s=>button('community-space/'+s.id,`<span class="v2-space-thumb">${publicSpaceMedia(s.coverPhotoUrl,s.id)?`<img src="${esc(s.coverPhotoUrl)}" alt="" loading="lazy">`:'<span class="community-no-photo">忆</span>'}</span><span><strong>${esc(s.title)}</strong><small>${esc(s.description||'公开的回忆空间')}</small></span><b>›</b>`,'glass v2-space-card')).join('')||'<p class="community-status">这一页没有公开的空间。</p>'}</div><div class="community-pagination">${page>1?button(path+'?page='+(page-1),'上一页'):''}${page*20<Math.max(moments.total||0,spaces.total||0)?button(path+'?page='+(page+1),'下一页'):''}</div>`);return;
      }
      if(path.startsWith('community-space/')) {
        const sid=path.slice(16),data=await publicRead('/v1/public/spaces/'+id(sid)),submission=data.submission,space=data.space;
        if(!submission || submission.id!==sid || !space)throw new Error('public_space_invalid');
        const photos=(space.photos||[]).map(p=>({...p,url:publicSpaceMedia(p.previewUrl,sid),videoUrl:publicSpaceMedia(p.videoUrl,sid)})).filter(p=>p.url);
        const stills=photos.filter(p=>p.mediaType!=='video'),panorama=publicSpaceMedia(space.panorama?.url,sid),depth=publicSpaceMedia(space.depth?.url,sid);
        const base='community-space/'+sid,author=communityAuthorCredit(submission);
        function showPhoto(photo){
          closeDialog();dialogOrigin=document.activeElement;dialog=document.createElement('dialog');dialog.className='v2-story community-photo-dialog';
          dialog.innerHTML=`<header><h2>${photo.mediaType==='video'?'视频':'照片'}</h2><button class="ib" data-community-close aria-label="关闭">×</button></header>${photo.videoUrl?`<video controls preload="metadata" poster="${esc(photo.url)}" src="${esc(photo.videoUrl)}"></video>`:`<img src="${esc(photo.url)}" alt="公开空间照片">`}<p>${esc(submission.title)}</p>`;
          dialog.onclick=event=>{if(event.target===dialog||event.target.closest('[data-community-close]'))closeDialog();};dialog.addEventListener('cancel',event=>{event.preventDefault();closeDialog();});document.body.append(dialog);dialog.showModal();
        }
        const view=params.get('view');
        if(view==='corridor'&&stills.length || view==='scene'&&panorama){
          root.closest('.design-shell')?.classList.add('v2-immersive');
          frame(`<section class="v2-full-scene"><div class="v2-scene-surface"></div><header class="v2-scene-header">${button(base,'‹','ib')}<div><h1>${esc(submission.title)}</h1><p>${view==='corridor'?'公开的照片回廊':'公开的全景现场'}</p></div></header></section>`);
          const surface=root.querySelector('.v2-scene-surface');
          if(view==='corridor')disposeView=mountCorridor(surface,{photos:stills,accountId:'public',spaceId:sid,immersive:true,onPhoto:showPhoto});
          else disposeView=mountAppSpatial({container:surface,kind:depth&&space.depth.metadata?'dap':'360',panorama,depth,depthMetadata:space.depth?.metadata,signal:controller.signal,onError:()=>tell('现场暂时没能打开，请返回后重试。')});
          return;
        }
        frame(header(submission.title)+`<div class="community-space-author">${author}</div><div class="frame-gold community-space-cover">${photos[0]?.url||panorama?`<img src="${esc(photos[0]?.url||panorama)}" alt="${esc(submission.title)}">`:'<span class="community-no-photo">忆</span>'}</div><p class="community-description">${esc(submission.description)}</p><div class="brow community-space-actions">${stills.length?button(base+'?view=corridor','走进照片回廊','btn gold'):''}${panorama?button(base+'?view=scene','回到全景现场','btn ghost'):''}</div>${designTitle('SHARED WITH YOU','这里留下的照片')}<div class="v2-photo-grid">${photos.map((p,i)=>`<button data-community-photo="${i}" aria-label="打开${p.mediaType==='video'?'视频':'照片'} ${i+1}"><img src="${esc(p.url)}" alt="" loading="lazy">${p.mediaType==='video'?'<span>▷ 视频</span>':''}</button>`).join('')}</div>${!photos.length?'<p class="community-status">这次分享包含全景现场。</p>':''}<p class="community-snapshot-note">这里展示的是作者选择公开的内容。</p>`);
        root.addEventListener('click',event=>{const b=event.target.closest('[data-community-photo]');if(b&&active()){event.stopPropagation();showPhoto(photos[Number(b.dataset.communityPhoto)]);}},{signal:controller.signal});
        return;
      }
      if(guest()){await login('spatial');return;}
      if(path==='community-submissions'){
        const page=Math.max(1,Number(params.get('page'))||1),data=await request(`/v1/me/community/spaces?page=${page}&pageSize=20`);
        frame(header('我的空间投稿','my-spaces')+(data.submissions||[]).map(sub=>submissionStatus(sub)).join('')+(!data.submissions?.length?'<div class="glass community-empty"><p>还没有空间投稿。先打开自己的空间，选择要分享的内容。</p>'+button('my-spaces','打开我的空间','btn gold')+'</div>':'')+`<div class="community-pagination">${page>1?button('community-submissions?page='+(page-1),'上一页'):''}${page*20<data.total?button('community-submissions?page='+(page+1),'下一页'):''}</div>`);
        bindWithdraw();return;
      }
      if(!path.startsWith('publish-space/'))throw new Error('route_invalid');
      const sid=path.slice(14),eligible=await request(`/v1/spaces/${id(sid)}/community/eligible`),back='shared-space/'+sid;
      if(eligible.submission&&['pending','published','unpublished'].includes(eligible.submission.status)){
        frame(header('空间投稿',back)+submissionStatus(eligible.submission));bindWithdraw();return;
      }
      const all=await request('/v1/me/spaces'),owned=(all.spaces||[]).find(s=>s.spaceId===sid&&s.owner);
      if(!owned)throw {status:403};
      const photos=eligible.photos||[],hasPanorama=!!eligible.panorama;
      frame(header('分享空间到社区',back)+`<form class="community-publish" data-community-publish>
        <p class="community-description">选择这次要分享的内容。审核通过后，所有人都可以查看。</p>
        <label class="v2-field">公开标题<input name="title" maxlength="200" required value="${esc(owned.name)}"></label>
        <label class="v2-field">署名<input name="authorName" maxlength="80" required value="${esc(user()?.displayName||user()?.username||'')}"></label>
        <label class="v2-field">说说这个空间<textarea name="description" maxlength="2000" rows="3" placeholder="那天在哪里，发生了什么"></textarea></label>
        ${hasPanorama?'<div class="glass community-public-scope"><strong>这次包含当前全景</strong><p>它会和下方选中的照片一起公开。</p></div>':''}
        ${eligible.depthAvailable?'<label class="v2-consent"><input name="includeDepth" type="checkbox">同时分享这份全景的空间深度效果</label>':''}
        <fieldset class="community-publish-photos"><legend>选择要公开的照片或视频</legend><p>只列出由你上传、当前可用的素材。新上传的内容不会自动加入这次分享。</p><div class="community-select-grid">${photos.map((p,i)=>`<label><input name="photoIds" type="checkbox" value="${esc(p.id)}"><img src="/v1/viewer/spaces/${id(sid)}/photos/${id(p.id)}/album-media" alt="${p.mediaType==='video'?'视频封面':'照片'} ${i+1}" loading="lazy"><span>${p.mediaType==='video'?'视频':'照片'} ${i+1}</span></label>`).join('')}</div>${!photos.length?'<p>这里还没有可选择的素材。</p>':''}</fieldset>
        <label class="v2-consent"><input name="consent" type="checkbox" required>我有权公开${hasPanorama?'当前全景及':''}选中的照片或视频，同意将此版本提交审核。私人对话和原声不包含在内。</label>
        <button type="submit" class="btn gold" ${!hasPanorama&&!photos.length?'disabled':''}>提交审核</button>${!hasPanorama&&!photos.length?button(back+'?tab=upload','先添加照片'):''}
      </form>`);
      let lastBody='',requestKey='';
      root.querySelector('form').onsubmit=async event=>{
        event.preventDefault();const form=event.target,b=form.querySelector('[type=submit]');b.disabled=true;
        try{
          const values=new FormData(form),photoIds=values.getAll('photoIds').map(String);
          if(!hasPanorama&&!photoIds.length){tell('请至少选择一张照片或一段视频。');return;}
          const body={expectedVersion:eligible.spaceVersion,consent:values.get('consent')==='on',title:String(values.get('title')).trim(),description:String(values.get('description')).trim(),authorName:String(values.get('authorName')).trim(),includeDepth:values.get('includeDepth')==='on',photoIds};
          if(JSON.stringify(body)!==lastBody){lastBody=JSON.stringify(body);requestKey=crypto.randomUUID();}
          await request(`/v1/spaces/${id(sid)}/community/submissions`,{method:'POST',body,key:requestKey});check();navigate('publish-space/'+sid);
        }catch(error){tell(errorCopy(error));}finally{if(active())b.disabled=false;}
      };
      function submissionStatus(sub){
        return `<section class="glass community-submission"><h2>${esc(sub.title)}</h2><p><strong>${esc(statusLabel(sub.status))}</strong>${sub.reason?' · '+esc(sub.reason):''}</p>${sub.status==='published'?button('community-space/'+sub.id,'查看公开版本'):''}${['pending','published','unpublished'].includes(sub.status)?`<form data-community-withdraw="${esc(sub.id)}" data-version="${esc(sub.version)}"><label class="v2-consent"><input type="checkbox" required>撤回此版本，停止审核或公开展示，私人原件保留。</label><button type="submit" class="btn ghost">撤回投稿</button></form>`:''}</section>`;
      }
      function bindWithdraw(){
        root.querySelectorAll('[data-community-withdraw]').forEach(form=>{form.onsubmit=async event=>{event.preventDefault();const b=form.querySelector('button');b.disabled=true;try{await request(`/v1/me/community/spaces/${id(form.dataset.communityWithdraw)}/withdraw`,{method:'POST',body:{expectedVersion:Number(form.dataset.version)}});check();navigate(route);}catch(error){tell(errorCopy(error));}finally{if(active())b.disabled=false;}};});
      }
    }catch(error){if(active())frame(header('回忆空间')+`<div class="glass community-empty"><p>${esc(errorCopy(error))}</p>${button(route,'重新打开')}${button('spaces','返回社区')}</div>`);}
  }
  return {mount,destroy};
}
