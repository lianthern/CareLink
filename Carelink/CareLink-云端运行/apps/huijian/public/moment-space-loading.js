// Shared by the immediate route shell and the asynchronously loaded list.
const button=(route,text,cls='')=>`<button class="${cls}" data-spatial-route="${route}"${text==='‹'?' aria-label="返回"':text==='＋'?' aria-label="创建回忆空间"':''}>${text}</button>`;
export function spaceListFrame(mode,body){
  return `<header class="v2-page-head nav">${button('','‹','ib')}<h1>回忆空间</h1><div class="grow"></div>${button('new-space','＋','ib')}</header><div class="v2-segment" aria-label="空间浏览">${button('spaces','社区',mode==='discover'?'on':'')}${button('my-spaces','我的',mode==='mine'?'on':'')}</div><div data-v2-list>${body}</div>`;
}
export function spaceListLoading(mode){
  if(mode==='mine')return `<div class="v2-list-loading" role="status" aria-label="正在读取我的空间"><p>正在找回你的空间…</p>${Array.from({length:3},()=>'<div class="glass v2-space-placeholder" aria-hidden="true"><i></i><span><b></b><small></small></span></div>').join('')}</div>`;
  return `<section class="v2-gallery v2-gallery-loading" role="status" aria-label="正在打开回忆空间"><div class="v2-gallery-hall" aria-hidden="true">${Array.from({length:9},(_,i)=>`<div class="ring" style="transform:translateZ(${-i*250}px)"></div>`).join('')}</div><div class="floor"></div><div class="fog"></div><div class="v2-loading-copy"><span class="v2-loading-star" aria-hidden="true">✦</span><p>正在展开回忆回廊</p><small>照片与故事，马上相见</small></div></section>`;
}
export function spaceLoadingScreen(route){
  const path=route.split('?')[0];
  if(path==='spaces'||path==='my-spaces'){const mode=path==='spaces'?'discover':'mine';return spaceListFrame(mode,spaceListLoading(mode));}
  return `<div class="v2-route-loading" role="status"><div class="v2-page-head nav">${button('my-spaces','‹','ib')}<h1>回忆空间</h1></div><div class="glass v2-route-placeholder" aria-hidden="true"><span>✦</span></div><p>正在打开这段回忆…</p></div>`;
}
