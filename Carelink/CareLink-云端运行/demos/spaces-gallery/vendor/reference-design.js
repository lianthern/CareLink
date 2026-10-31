// Components directly ported from 回忆时刻_Demo.html. No demo state or simulated actions.
export function designDeco(cur="P0"){
  const b=[["-50px","-40px","210px","#C7DCFA"],["225px","-70px","230px","#F6CFE2"],["-80px","540px","250px","#FBDCC4"],["250px","640px","190px","#DCD1F6"]];
  let s=b.map(([l,t,w,c])=>`<span class="blob" style="left:${l};top:${t};width:${w};height:${w};background:${c}"></span>`).join("");
  const sp=[[38,120,10],[300,90,8],[70,430,7],[330,520,11],[180,700,8],[24,660,9],[250,300,7],[110,560,9]];
  s+=sp.map(([l,t,z],i)=>`<span class="spk" style="left:${l}px;top:${t}px;--s:${z}px;animation-delay:${i*.45}s"></span>`).join("");
  s+=`<span class="pband"></span>`;
  const orn=(x,y,h,d)=>`<span class="orn" style="left:${x}px;top:${y}px;animation-delay:${d}s">${h}</span>`;
  const O={
    P0:orn(316,86,`<span class="bal pink"><i></i></span>`,0)+orn(346,128,`<span class="bal gold" style="transform:scale(.72)"><i></i></span>`,1.4),
    A1:orn(-6,300,`<span class="bal silver"><i></i></span>`,.8)+orn(330,520,`<span class="bow"><i></i><i></i><b></b></span>`,1.2),
    A2:orn(304,74,`<span class="bal pink"><i></i></span>`,.4)+orn(-4,430,`<span class="bal gold" style="transform:scale(.8)"><i></i></span>`,1.6),
    B1:orn(318,92,`<span class="bow"><i></i><i></i><b></b></span>`,.6)+orn(-8,470,`<span class="bal pink" style="transform:scale(.78)"><i></i></span>`,1.8),
    B3:orn(322,96,`<span class="bal silver" style="transform:scale(.8)"><i></i></span>`,.9),
    S3:orn(-6,110,`<span class="bow"><i></i><i></i><b></b></span>`,.5)
  }[cur]||"";
  let pt="";
  for(let i=0;i<5;i++) pt+=`<span class="petal" style="left:${8+i*21}%;animation-duration:${13+i*3}s;animation-delay:${-i*4}s"></span>`;
  return `<div class="deco" aria-hidden="true">${s}${O}${pt}<span class="vig"></span></div>`;
}
let PN=0;
const PV=[[18,12,22,56],[62,20,17,62],[30,26,26,52],[74,10,14,66],[46,16,20,58],[12,24,24,60],[68,28,18,54]];
function pvar(){const v=PV[PN++%PV.length];return `--gx:${v[0]}%;--gy:${v[1]}%;--gs:${v[2]}%;--hz:${v[3]}%`}
function ph(k,cls=""){return `<div class="ph ph--${k} ${cls}" style="${pvar()}">
  <span class="gl"></span><span class="hz"></span><span class="vg"></span></div>`}
function phP(k,cls=""){return `<div class="ph ph--${k} ${cls}" style="${pvar()}">
  <span class="gl"></span><span class="hz"></span><span class="vg"></span>
  <span class="fg"><i style="height:50%"></i><i style="height:64%"></i><i style="height:56%"></i><i style="height:70%"></i></span></div>`}
export function designTitle(en,zh){
  return `<div class="otitle"><div class="en">${en}</div><h2>${zh}</h2>
    <div class="rule"><i></i><b>◆</b><i></i></div></div>`;
}
export function designRing(pct,n,c){
  const r=44,C=2*Math.PI*r,off=C*(1-pct/100),id="g"+Math.round(pct*7%997);
  return `<div class="ringstat"><svg width="104" height="104" viewBox="0 0 104 104" style="transform:rotate(-90deg)">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#F5B8D0"/><stop offset="55%" stop-color="#EBD3A2"/><stop offset="100%" stop-color="#C9A45B"/></linearGradient></defs>
    <circle cx="52" cy="52" r="${r}" fill="none" stroke="rgba(150,138,180,.18)" stroke-width="7"/>
    <circle cx="52" cy="52" r="${r}" fill="none" stroke="url(#${id})" stroke-width="7" stroke-linecap="round"
      stroke-dasharray="${C}" stroke-dashoffset="${off}"/></svg>
    <div class="txt"><div class="n">${n}</div><div class="c">${c}</div></div></div>`;
}
export function designScene(hud=false){
  const K=["sunset","sea","wedding","party","campus","mountain","cafe","night","sky","snow"];
  let r="",p="",d="";
  for(let i=0;i<9;i++) r+=`<div class="ring" style="transform:translateZ(${-i*250}px) scale(${1+i*.02});opacity:${1-i*.055}"></div>`;
  for(let i=0;i<10;i++){
    const sd=i%2?1:-1, z=-140-Math.floor(i/2)*250-(i%2)*60;
    p+=`<div class="gf" style="transform:translate3d(${sd*168}px,${(i%3-1)*12}px,${z}px) rotateY(${sd*-30}deg)">${i%3===0?phP(K[i%10]):ph(K[i%10])}</div>`;
  }
  for(let i=0;i<14;i++) d+=`<i style="left:${(i*37)%100}%;top:${40+(i*17)%55}%;animation-duration:${4+i%5}s;animation-delay:${i*.4}s"></i>`;
  return `<div class="scene" aria-hidden="true"><div class="corr">${r}${p}</div>
    <div class="dust">${d}</div><div class="floor"></div><div class="fog"></div>
    ${hud?`<div class="hud">拖动 / 滚轮 漫游 · 轻触相框展开故事<div class="bar"><i id="wbar" style="width:8%"></i></div></div>`:""}</div>`;
}

const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function designNav(selected) {
  const tab=(key,label,glyph,action)=>`<button class="tab ${selected===key?'on':''}" ${action} ${selected===key?'aria-current="page"':''}><span class="ti" aria-hidden="true">${glyph}</span><span>${label}</span></button>`;
  return `<nav class="tabs" aria-label="主导航">${tab('home','首页','⌂','data-action="home"')}${tab('spaces','回忆空间','◫','data-spatial-route="spaces"')}<button class="fab" data-action="new" aria-label="创建回忆">＋</button>${tab('library','回忆库','✦','data-action="open-library"')}${tab('profile','我的','♙','data-action="profile"')}</nav>`;
}
export function designHeader(title,sub='',action='home',right='',subClass='') { return `<header class="nav">${action?`<button class="ib" data-action="${action}" aria-label="返回">‹</button>`:''}<h1>${esc(title)}${sub?`<small${subClass?` class="${esc(subClass)}"`:''}>${esc(sub)}</small>`:''}</h1><div class="grow"></div>${right}</header>`; }
export function designShell(content,{page='P0',selected='',className=''}={}) { return `<div class="design-shell ${className}">${designDeco(page)}<div class="body design-body">${content}</div>${selected?designNav(selected):''}</div>`; }
export function designHero() { return `<div class="frame-gold" style="margin-top:2px"><div style="position:relative"><div class="mini-scene">${designScene()}</div><div class="design-hero-caption"><div style="font-family:var(--serif);font-style:italic;letter-spacing:.3em;font-size:9px;color:rgba(255,245,225,.9)">MEMORY MOMENT</div><div style="font-family:var(--serif);font-size:19px;letter-spacing:.14em;color:#fff;margin-top:4px;text-shadow:0 2px 8px rgba(40,28,60,.5)">回忆时刻</div></div></div></div>`; }
export function designStatus(item) { return item.status==='complete'?'<span class="tag gold">✦ 已确认</span>':(item.photoCount??item.photos?.length??0)?'<span class="tag rose">● 对话中</span>':'<span class="tag grey">未开始</span>'; }
export function designHome({user,items,avatar,media,title,preview,date,loading,error}) {
  const unfinished=items.filter(x=>x.status!=='complete');
  return designShell(`<div class="nav">${avatar}<h1 style="font-family:var(--sans);font-size:13.5px;letter-spacing:.02em">${esc(user?.displayName||user?.username||'回忆时刻')}<small>${user?`${items.length} 段${user.guest?'本机草稿':'回忆'}`:'正在确认账号…'}</small></h1><div class="grow"></div><button class="ib" data-action="open-library" aria-label="打开回忆库">♡</button><button class="ib" style="margin-left:8px" data-spatial-route="tasks" aria-label="查看空间任务">◔</button></div>
  ${designHero()}
  <div class="design-entry-row"><button class="glass gilt card-corner design-entry" data-spatial-route="new-space"><span class="entry-icon gold">◫</span><strong>创建回忆时刻</strong><small>留下眼前的现场<br>走进可漫游的空间</small></button><button class="glass card-corner design-entry" data-action="capture"><span class="entry-icon rose">✦</span><strong>拍一张，聊成回忆</strong><small>AI 陪你把一张照片<br>聊成一段故事</small></button></div>
  ${designTitle('IN PROGRESS','进行中的空间')}
  <button class="glass design-space-link" data-spatial-route="tasks"><span class="entry-icon gold">◫</span><span><strong>我的空间与导入任务</strong><small>继续上次的素材，或留下新的现场</small></span><span class="grow"></span><span aria-hidden="true">›</span></button>
  ${unfinished.length?`<button class="glass design-resume" data-open="${esc(unfinished[0].id)}"><span class="entry-icon rose">💬</span><span>还有 <b>${unfinished.length} 段</b>回忆没说完</span><span class="grow"></span>›</button>`:''}
  ${designTitle('RECENT','最近的回忆')}
  ${error?`<p class="inline-error">${esc(error)} <button data-action="refresh">重试</button></p>`:''}
  ${items.length?`<div class="hs design-recent">${items.slice(0,8).map(item=>{const src=media(item.photos?.[0])||media({url:item.coverPhotoUrl});return `<button data-open="${esc(item.id)}"><div class="rounded">${src?`<img src="${esc(src)}" alt="${esc(title(item))}" loading="lazy">`:'<span class="design-photo-empty">✦</span>'}<span class="recent-status">${designStatus(item)}</span></div><span class="recent-title">${esc(title(item))}</span></button>`;}).join('')}</div>`:`<div class="glass design-empty"><p>${loading?'正在读取回忆…':'这里会放下你亲口讲过的故事。'}</p><button class="btn rose sm" data-action="capture">留下第一段回忆</button></div>`}
  <div class="design-bottom-links"><button data-spatial-route="cases">看看真实案例与空间示例 ›</button>${user?.guest?'<button data-action="cloud-library">登录，查看已保存的回忆 ›</button>':'<button data-action="open-library">查看全部回忆 ›</button>'}</div>`,{selected:'home',className:'design-home'});
}
export function designLibrary({items,filter='all',query='',media,title,preview,date,loading,error,guest}) {
  const done=items.filter(x=>x.status==='complete').length,active=items.filter(x=>x.status!=='complete');
  const filtered=items.filter(x=>(filter==='all'||(filter==='done'?x.status==='complete':filter==='new'?!(x.photoCount??x.photos?.length):x.status!=='complete'&&(x.photoCount??x.photos?.length)>0))&&(!query||`${title(x)} ${x.preview||preview(x)}`.toLowerCase().includes(query.toLowerCase())));
  return designShell(`${designHeader('我的回忆库',`${items.length} 段${guest?'本机草稿':'回忆'} · ${done} 段已确认`,'',`<button class="ib" data-action="refresh" aria-label="刷新回忆库">↻</button>`)}
  <div class="glass gilt" style="display:flex;gap:15px;align-items:center">${designRing(items.length?Math.round(done/items.length*100):0,done,'STORIES')}<div style="flex:1"><div style="font-size:12.5px;font-weight:700;margin-bottom:6px">${active.length?`还有 ${active.length} 段没说完`:items.length?'每一段，都好好留下了':'第一段回忆，从这里开始'}</div><p style="font-size:10.5px;color:var(--muted);line-height:1.7;margin-bottom:10px">${guest?'照片和原话先留在这台设备':'照片、声音和你说过的话，都在这里'}</p><button class="btn rose sm" style="width:auto;padding:9px 16px;font-size:12px" ${active.length?`data-open="${esc(active[0].id)}"`:'data-action="capture"'}>${active.length?'继续未完成的对话':'记录一张照片'}</button></div></div>
  <form class="design-search inp" data-form="library-search"><span aria-hidden="true">⌕</span><input name="query" aria-label="搜索回忆" placeholder="找一段回忆" value="${esc(query)}"><button type="submit">搜索</button></form>
  <div class="chips" style="margin:15px 0 13px">${[['all','全部'],['new','未开始'],['chat','对话中'],['done','已确认']].map(([k,n])=>`<button class="chip ${filter===k?'on':''}" data-library-filter="${k}">${n}</button>`).join('')}</div>
  ${error?`<p class="inline-error">${esc(error)} <button data-action="refresh">重试</button></p>`:''}
  <div class="tl">${filtered.map(item=>{const src=media(item.photos?.[0])||media({url:item.coverPhotoUrl});return `<article class="ti-row ${item.status==='complete'?'g':''}"><div style="font-size:9.5px;color:var(--muted);margin:0 0 6px 2px;letter-spacing:.1em">${esc(date(item.createdAt))}</div><button class="mem" data-open="${esc(item.id)}"><span class="thumb">${src?`<img src="${esc(src)}" alt="" loading="lazy">`:'<span class="design-photo-empty">✦</span>'}</span><span style="flex:1;min-width:0"><span class="mt">${esc(title(item))}</span><span class="md">${esc(item.preview||preview(item))}</span><span class="memory-state">${designStatus(item)}<small>${item.status==='complete'?'查看故事':'点击继续'} ›</small></span></span></button></article>`;}).join('')}</div>
  ${!filtered.length?`<div class="design-empty"><p>${loading?'正在读取…':query||filter!=='all'?'还没有符合条件的回忆。':'回忆库还是空的，选张照片开始吧。'}</p></div>`:''}${guest?'<button class="btn ghost sm" data-action="cloud-library">登录，查看已保存回忆</button>':''}`,{page:'B4',selected:'library'});
}
export function designCapture({items,media,title}) { return designShell(`${designHeader('记录这张照片','从一张照片，聊成一段故事')}<div class="glass gilt card-corner" style="padding:26px 18px;text-align:center">${designTitle('ONE PHOTO','一 张 照 片')}<div class="capture-camera">📷</div><div style="font-size:11px;color:var(--ink2);line-height:1.9;margin-bottom:18px">和 AI 一起慢慢想起<br><b style="color:var(--gold-d)">和谁 · 在哪 · 发生了什么 · 什么心情</b></div><div class="brow"><button class="btn rose sm" style="flex:1" data-action="capture-camera">拍 照</button><button class="btn ghost sm" style="flex:1" data-action="capture-library">从相册选择</button></div></div>${designTitle('MEMORIES','最近回忆里的照片')}<div class="design-album">${items.filter(i=>media(i.photos?.[0])||media({url:i.coverPhotoUrl})).slice(0,9).map(i=>`<button class="rounded" data-open="${esc(i.id)}"><img src="${esc(media(i.photos?.[0])||media({url:i.coverPhotoUrl}))}" alt="${esc(title(i))}"></button>`).join('')}</div>${!items.length?'<p class="design-empty">选择后的照片会出现在回忆里。<br>系统相册将在你点击后打开。</p>':''}`,{page:'B1',selected:'capture'}); }
export function designReview({moment,media,title,sync,guest,error,pendingVoice}) {
  const done=moment.status==='complete',src=media(moment.photos?.[0]),said=moment.messages.filter(m=>m.role==='user');
  return designShell(`${designHeader(done?'这段回忆，已经留下':'确认这段回忆',done?sync:'确认后存进你的回忆库',done?'open-library':'review-back',`<button class="ib" data-action="rename" aria-label="修改回忆名称">✎</button>`,done?'sync-status':'')}<div class="frame-gold"><div class="review-photo">${src?`<img src="${esc(src)}" alt="${esc(title(moment))}">`:'<span class="design-photo-empty">✦</span>'}<span class="tag ${done?'gold':'ice'}">${done?'已确认':'待确认'}</span></div></div><div class="glass gilt card-corner review-story">${moment.exampleSource?'<span class="tag ice">设计稿示例 · 非实拍照片</span>':''}${designTitle('YOUR OWN WORDS','你 为 这 一 刻 留 下')}<h2>${esc(title(moment))}</h2>${said.length?said.map(m=>`<article><p>${esc(m.text||'这一段，你用声音留下了回忆。')}</p><div class="message-tools">${m.audio?`<button data-play="${esc(m.id)}">▷ 听原声</button>`:''}<button data-edit="${esc(m.id)}">✎ ${m.text?'修改这段原话':'补充文字'}</button></div></article>`).join(''):'<p>还没有留下文字。你可以再聊聊，或先保存照片。</p>'}<div class="chips" style="margin-top:15px;justify-content:center"><span class="chip">◫ ${moment.photos.length} 张照片</span><span class="chip">♫ ${said.filter(m=>m.audio).length} 段原声</span></div></div><div class="glass design-save-status"><span>♧</span><div><strong>${guest?'本机草稿':'默认不公开'}</strong><small class="sync-status" role="status">${esc(sync)}</small></div></div>${error?`<p class="inline-error" role="status">${esc(error)} <button data-action="retry">重试同步</button></p>`:''}${pendingVoice?'<p class="glass design-empty">有一段尚未发送的原声。点击确认时会一起保存，也可以返回对话查看。</p>':''}<div class="design-review-actions brow"><button class="btn ghost sm" style="flex:1" data-action="review-back">${done?'查看对话':'再聊聊'}</button><button class="btn gold sm" style="flex:2" data-action="${done?(guest?'save-cloud':'open-library'):'confirm-memory'}">${done?(guest?'保存到账号':'回到回忆库'):'OK，就这么记'}</button></div>`,{page:'B3',className:'design-review'});
}
