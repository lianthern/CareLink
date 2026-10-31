import { bookPhotos, normalizeContent } from "./unseen-content.js";
import { renderMemoryPng, renderPosterPng, downloadBlob } from './export-memory.js';
import { createZineBook, recommendZineRatio, ZINE_FORMATS, mountZinePreview, renderZinePageElement, renderZinePagePngFiles, renderZineSharePng } from './zine-book.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function photoStrip(state) {
  return `<ol class="app-photo-strip" aria-label="照片顺序">${state.photos.map((photo,i) => `<li><button data-app-photo="${i}" aria-label="编辑第 ${i+1} 张照片" aria-pressed="${Boolean(photo === state.photo || (photo.id && photo.id === state.photo?.id))}"><img src="${esc(photo.src)}" alt="第 ${i+1} 张"><span>${i+1}</span></button><div><button data-app-move="${i}" data-direction="-1" ${i===0?'disabled':''} aria-label="向前移">←</button><button data-app-remove="${i}" ${state.photos.length===1?'disabled':''} aria-label="移除第 ${i+1} 张">×</button><button data-app-move="${i}" data-direction="1" ${i===state.photos.length-1?'disabled':''} aria-label="向后移">→</button></div></li>`).join('')}</ol>`;
}
export function accessibleCreationText(state){
 const pairs=normalizeContent({photos:state.photos,pairs:state.pairs}).pairs;
 return `<details class="app-accessible-copy"><summary>阅读全部照片说明与原话</summary><h3>${esc(state.title||'留住的这一刻')}</h3><p>${state.photos.length} 张照片 · ${pairs.length} 段原话</p>${state.photos.map((photo,index)=>`<h4>第 ${index+1} 张照片</h4><p>${esc(photo.caption||photo.alt||'未添加文字说明。')}</p>${pairs.filter(pair=>pair.photoId===photo.id).map(pair=>`<p>提问：${esc(pair.question)}</p><blockquote>你的原话：${esc(pair.answer)}</blockquote>`).join('')}`).join('')}</details>`;
}
export function creationTools(state) {
 const recommendation=recommendZineRatio(state.photos);
 const format=state.pageAspect||recommendation.formatId||'portrait';
 const ratioControl=state.resultShape==='zine'?`<label>小书比例<select id="app-page-aspect"><option value="" ${!state.pageAspect?'selected':''}>按照片推荐${recommendation.ratio?' · '+recommendation.ratio:' · 暂用竖版'}</option>${Object.values(ZINE_FORMATS).map(f=>`<option value="${f.id}" ${state.pageAspect===f.id?'selected':''}>${f.label} · ${f.ratio}</option>`).join('')}</select></label><p>横图 ${recommendation.counts.landscape} · 竖图 ${recommendation.counts.portrait} · 方图 ${recommendation.counts.square}。手动选择会保留。</p>`:'';

 return `<section class="app-tools"><h2>选择成品</h2><div class="button-row">${[['memory-page','一页'],['poster','海报'],['zine','小书']].map(([id,label])=>`<button class="secondary-button" data-app-shape="${id}" aria-pressed="${state.resultShape===id}" ${id==='zine'&&state.photos.length<2?'disabled':''}>${label}</button>`).join('')}</div><label>作品名称<input id="app-memory-title" maxlength="100" value="${esc(state.title||'')}" placeholder="给这一刻起个名字"></label><label>纸张风格<select id="app-memory-style">${[['evening-paper','晚风纸'],['black-fragments','黑色碎片'],['quiet-white','留白']].map(([id,label])=>`<option value="${id}" ${state.styleId===id?'selected':''}>${label}</option>`).join('')}</select></label>${ratioControl}<div id="app-single-preview"></div><div id="app-book-preview"></div><div class="button-row"><button class="secondary-button" data-app-book="previous">上一页</button><span id="app-book-page" aria-live="polite"></span><button class="secondary-button" data-app-book="next">下一页</button></div><div class="app-export-actions"><button data-app-export="png">下载${state.resultShape==='zine'?'长图':'图片'}</button>${state.resultShape==='zine'?'<button data-app-export="pages">逐页 PNG</button>':''}<button data-app-export="print">打印 / 存为 PDF</button><button data-app-export="share">系统分享</button></div><div id="app-downloads"></div><p id="app-export-status" role="status"></p>${accessibleCreationText(state)}</section>`;
}
export function makeBook(state) {
 const photos = bookPhotos(state);
 return createZineBook({photos,title:state.title||'留住的这一刻',date:new Date(state.createdAt).toLocaleDateString('zh-CN'),styleId:state.styleId||'evening-paper',pageAspect:state.pageAspect||recommendZineRatio(photos).formatId||'portrait'});
}
export function mountCreation(state, root) {
 if (state.resultShape !== 'zine' || state.photos.length<2) {
  root.querySelector('[data-app-book="previous"]')?.parentElement.setAttribute('hidden','');
  let live=true,url;const container=root.querySelector('#app-single-preview');container.textContent='正在准备完整成品…';
  renderSingle(state).then(blob=>{if(!live)return;url=URL.createObjectURL(blob);const img=document.createElement('img');img.src=url;img.alt=`${state.title||'留住的这一刻'} · ${state.pairs.length} 段原话`;img.className='app-single-result';container.replaceChildren(img);}).catch(()=>{if(live)container.textContent='预览未生成，请重试；原话仍保留。';});
  return ()=>{live=false;if(url)URL.revokeObjectURL(url);};
 }
 const preview=mountZinePreview({container:root.querySelector('#app-book-preview'),book:makeBook(state),initialIndex:state.bookPage||0,onPageChange:s=>{state.bookPage=s.index; const label=root.querySelector('#app-book-page');if(label)label.textContent=`${s.pageNumber} / ${s.pageCount}`;}});
 root.querySelectorAll('[data-app-book]').forEach(button=>button.onclick=()=>preview.controller[button.dataset.appBook]());
 return ()=>preview.destroy();
}
export function singleExportOptions(state){return {photoSrc:state.photo.src,date:new Date(state.createdAt).toLocaleDateString('zh-CN'),title:state.title||'留住的这一刻',pairs:normalizeContent({photos:state.photos,pairs:state.pairs}).pairs,styleId:state.styleId||'evening-paper'};}
function renderSingle(state){return (state.resultShape==='poster'?renderPosterPng:renderMemoryPng)(singleExportOptions(state));}
export async function exportCreation(state,mode,root) {
 const status=root.querySelector('#app-export-status'); const buttons=root.querySelectorAll('[data-app-export]');
 buttons.forEach(b=>b.disabled=true); status.textContent='正在准备成品…';
 try {
 const book=state.resultShape==='zine'?makeBook(state):null;
 if(mode==='print') {
  const print=document.createElement('section'); print.id='app-print-output';
  if(book) book.pages.forEach(page=>print.append(renderZinePageElement(book,page)));
  else { const blob=await renderSingle(state);const img=document.createElement('img');img.src=URL.createObjectURL(blob);img.alt=state.title||'留住的这一刻';print.append(img); }
  document.querySelector('#app-print-output')?.remove();document.body.append(print);
  await Promise.all([...print.querySelectorAll('img')].map(img=>img.decode().catch(()=>{})));
  window.print();status.textContent='在系统打印窗口选择打印机或存为 PDF。';return;
 }
 const options=singleExportOptions(state);
 if(mode==='pages') {
  const files=await renderZinePagePngFiles(book);const downloads=root.querySelector('#app-downloads');downloads.replaceChildren();
  for(const f of files){ const a=document.createElement('a');a.textContent=`下载第 ${f.pageIndex+1} 页`;a.download=f.filename;a.href=URL.createObjectURL(f.blob);downloads.append(a); }
  status.textContent=`${files.length} 页已生成，请逐页下载。`;return;
 }
 const blob=book?await renderZineSharePng(book):await (state.resultShape==='poster'?renderPosterPng:renderMemoryPng)(options);
 const file=new File([blob],'unseen-memory.png',{type:'image/png'});
 if(mode==='share'&&navigator.canShare?.({files:[file]})){status.textContent='请在系统分享面板中选择操作，或取消返回。';await navigator.share({files:[file],title:state.title||'UNSEEN'});status.textContent='已交给系统分享。';}
 else {downloadBlob(blob,file.name);status.textContent=mode==='share'?'此浏览器不支持文件分享，已下载图片。':'图片已交给浏览器下载。';}
 }catch(error){status.textContent=error.name==='AbortError'?'已取消分享，作品仍然保留。':error.code==='zine_share_too_tall'?error.message:'没有导出成功；请重试或改用打印。';}
 finally{buttons.forEach(b=>b.disabled=false);}
}
