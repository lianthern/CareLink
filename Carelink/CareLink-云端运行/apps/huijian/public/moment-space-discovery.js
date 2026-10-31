import {escapeHtml as esc,photoRows} from './app-v2-core.js';
import {createViewRequest} from './moment-view-request.js';
import {mountSpaceGallery} from './moment-space-gallery.js';
import {spaceListFrame,spaceListLoading} from './moment-space-loading.js';
import {loadDiscovery} from './moment-space-discovery-data.js';

const enc=encodeURIComponent;
const button=(route,text,cls='btn ghost')=>`<button class="${cls}" data-spatial-route="${esc(route)}">${text}</button>`;
const art=(theme='sea')=>`<div class="v2-cover-art v2-theme-${['sea','wedding','travel','night','campus'].includes(theme)?theme:'sea'}" aria-hidden="true"><span></span><i></i><b></b></div>`;
export function createMomentSpaces({api,user,guest,login,navigate}){
  let root,controller,dispose=()=>{},generation=0,position=0;
  function destroy(){generation++;controller?.abort();dispose();dispose=()=>{};root?.closest('.design-shell')?.classList.remove('v2-discover-hall');if(root)root.onclick=null;}
  async function mount(target,route){
    destroy();root=target;controller=new AbortController();
    const signal=controller.signal,token=generation,account=user()?.id;
    const current=()=>token===generation&&root.isConnected&&user()?.id===account;
    const boundedApi={request:(path,options)=>api.request(path,{...options,signal:AbortSignal.any([options.signal,AbortSignal.timeout(12000)])})};
    const {request,assertCurrent}=createViewRequest(boundedApi,{signal,isCurrent:current});
    const [path,query='']=route.split('?'),mode=path==='my-spaces'?'mine':'discover',page=Math.max(1,Number(new URLSearchParams(query).get('page'))||1);
    root.closest('.design-shell')?.classList.toggle('v2-discover-hall',mode==='discover');
    root.innerHTML=spaceListFrame(mode,spaceListLoading(mode));
    root.onclick=event=>{const b=event.target.closest('[data-spatial-route]');if(b){event.stopPropagation();navigate(b.dataset.spatialRoute);}};
    const content=root.querySelector('[data-v2-list]');
    try{
      if(mode==='mine'){
        if(guest()){content.innerHTML='<div class="glass v2-empty"><h2>把你在意的时刻，收在这里</h2><p>登录后查看你创建和参与的空间。</p><button class="btn gold" data-v2-login>登录账号</button></div>';content.querySelector('[data-v2-login]').onclick=()=>login('spatial');return;}
        const data=await request('/v1/me/spaces'),rows=(data.spaces||[]).filter(s=>s.spaceLifecycle==='active'&&(s.owner||s.effectiveCanView||s.effectiveCanUpload));assertCurrent();
        content.innerHTML=`<div class="v2-my-spaces">${rows.map(s=>button('shared-space/'+enc(s.spaceId),`<span class="v2-space-thumb">${art()}</span><span><strong>${esc(s.name)}</strong><small>${s.owner?'我创建的':'共同参与'} · ${s.collectionState==='open'?'收集中':'已保存'}</small></span><b>›</b>`,'glass v2-space-card')).join('')||`<div class="glass v2-empty"><h2>第一段回忆，从这里开始</h2><p>一次旅行、一场相聚，都值得留下。</p>${button('new-space','创建回忆时刻','btn gold')}</div>`}</div><details class="v2-secondary"><summary>任务与采集草稿</summary>${button('community-submissions','社区投稿记录','btn ghost sm')}${button('tasks','导入记录','btn ghost sm')}${button('world-tasks','现场生成记录','btn ghost sm')}${button('capture-tasks','采集草稿','btn ghost sm')}</details>`;
        // Cards are already usable; cap background cover requests to three spaces.
        let next=0;
        await Promise.all(Array.from({length:Math.min(3,rows.length)},async()=>{
          while(next<rows.length&&!signal.aborted){const i=next++,s=rows[i];if(!s.owner&&!s.effectiveCanView)continue;
            try{const [view,meta]=await Promise.all([request('/v1/viewer/spaces/'+enc(s.spaceId)),request('/api/space-presentation/'+enc(s.spaceId)).catch(()=>null)]);assertCurrent();
              const photos=photoRows(s.spaceId,view.photos),url=(photos.find(p=>p.id===meta?.presentation?.coverPhotoId)||photos[0])?.url;
              const thumb=content.querySelectorAll('.v2-space-thumb')[i];if(thumb)thumb.innerHTML=url?`<img src="${esc(url)}" alt="" loading="lazy" decoding="async">`:art(meta?.presentation?.theme);
            }catch{signal.throwIfAborted();}
          }
        }));return;
      }
      const {rows,total,partial}=await loadDiscovery({page,signal});assertCurrent();
      if(!rows.length){content.innerHTML=spaceListLoading(mode)+`<div class="glass v2-gallery-message"><h2>让回忆在这里相遇</h2><p>这里会展示大家分享的空间。</p>${button('new-space','创建我的空间','btn gold')}</div>`;content.querySelector('.v2-loading-copy')?.remove();return;}
      dispose=mountSpaceGallery(content,{spaces:rows,kindLabel:'回忆空间',initialPosition:position,onPositionChange:value=>{position=value;},onEnter:item=>navigate(item.community?'community-space/'+item.id:'case/'+item.id+'?from=gallery')});
      if(partial)content.insertAdjacentHTML('beforeend',`<div class="v2-gallery-notice" role="status">部分空间暂未加载 ${button(route,'重试','btn ghost sm')}</div>`);
      if(page>1||page*20<total)content.insertAdjacentHTML('beforeend',`<div class="community-pagination">${page>1?button('spaces?page='+(page-1),'上一页'):''}${page*20<total?button('spaces?page='+(page+1),'更多空间'):''}</div>`);
    }catch(error){if(signal.aborted||!current())return;content.innerHTML=`<div class="glass v2-empty ${mode==='discover'?'v2-gallery-message':''}" role="status"><h2>暂时没能打开空间</h2><p>检查连接后再试，你的回忆仍然保留。</p>${button(route,'重新加载','btn gold')}${button('','回到首页','btn ghost')}</div>`;}
  }
  return {mount,destroy};
}
