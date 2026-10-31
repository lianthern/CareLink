const $=s=>document.querySelector(s),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let entries=[],kind='all',selected={};
const params=new URLSearchParams(location.search);kind=params.get('kind')||'all';$('#search').value=params.get('q')||'';$('#playable').checked=params.get('playable')==='1';
function render(){
 const q=$('#search').value.trim().toLowerCase(),playable=$('#playable').checked;
 const matching=entries.filter(e=>(kind==='all'||e.kind===kind)&&(!playable||e.url)&&(!q||[e.title,e.source,e.method,e.attribution,e.version,e.photoDescription].join(' ').toLowerCase().includes(q)));
 const groups=Map.groupBy(matching,e=>e.group);
 $('#count').textContent=`${groups.size} 个空间 · ${matching.filter(e=>e.url).length} 个可漫游版本`;
 $('#empty').hidden=groups.size>0;
 $('#cards').innerHTML=[...groups].map(([group,list])=>{
 const e=list.find(e=>e.id===selected[group])||list.find(e=>e.url)||list[0];
 const photo=e.cover?`<img src="${esc(e.cover)}" alt="${esc(e.title)}的输入素材画面" loading="lazy"><span class="image-note">输入素材画面</span>`:`<div class="placeholder">${e.kind==='model'?'SOG / IMPORT':e.title.includes('香港')?'HKUST / 360Roam':'PanDORA / RESEARCH'}</div>`;
 return `<article class="card" data-group="${esc(group)}">${e.url?`<a class="cover" href="${esc(e.url)}" aria-label="进入${esc(e.title)}">${photo}</a>`:`<div class="cover">${photo}</div>`}<div class="body"><span class="tag">${esc(e.method)}</span><h2>${esc(e.title)}</h2>${e.photoCount?`<a class="photo-entry" href="${esc(e.url)}?photos=1">${e.photoCount} 张空间照片 · 点击回到拍摄视角 ↗</a>`:``}<label class="version">版本<select aria-label="${esc(e.title)}的版本" data-select="${esc(group)}">${list.map(v=>`<option value="${v.id}" ${v.id===e.id?'selected':''}>${esc(v.version)}${v.status==='processing'?' · 生成中':v.status==='reference'?' · 来源展示':''}</option>`).join('')}</select></label><p class="source">素材：${esc(e.source)}${e.duration?`<br>1 段 · ${e.duration} 秒`:''}</p><p class="note">${esc(e.note)}${e.photoDescription?`<br>${esc(e.photoDescription)}。`:``}</p><div class="actions">${e.url?`<a class="enter" href="${esc(e.url)}">进入空间 ↗</a><span class="size">模型 ${e.mb} MB</span>`:e.sourceUrl?`<a class="enter reference" href="${esc(e.sourceUrl)}" target="_blank" rel="noopener">查看官方项目 ↗</a><span class="size">暂未公开模型</span>`:'<span class="pending">此版本正在生成</span>'}</div><p class="attribution">${esc(e.attribution)}${e.sourceUrl?` <a href="${esc(e.sourceUrl)}" target="_blank" rel="noopener">素材来源</a>`:''}</p></div></article>`;
 }).join('');
 document.querySelectorAll('[data-select]').forEach(s=>s.onchange=()=>{selected[s.dataset.select]=s.value;render()});
 document.querySelectorAll('[data-kind]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.kind===kind)));
 const u=new URL(location.href);u.search='';if(kind!=='all')u.searchParams.set('kind',kind);if(q)u.searchParams.set('q',$('#search').value);if(playable)u.searchParams.set('playable','1');history.replaceState(null,'',u);
}
$('#filters').onclick=e=>{if(e.target.dataset.kind){kind=e.target.dataset.kind;render()}};$('#search').oninput=render;$('#playable').onchange=render;$('#reset').onclick=()=>{kind='all';$('#search').value='';$('#playable').checked=false;render()};
$('#share').onclick=async()=>{try{await navigator.clipboard.writeText(location.href);$('#toast').textContent='链接已复制，可以发给队友了。'}catch{$('#toast').textContent='请复制浏览器地址栏的链接。'}};
fetch('./catalog.json').then(r=>{if(!r.ok)throw Error();return r.json()}).then(data=>{entries=data.entries;render()}).catch(()=>{$('#count').textContent='空间目录加载失败，请刷新重试。'});
