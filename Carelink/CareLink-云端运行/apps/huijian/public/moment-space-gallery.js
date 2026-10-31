import {escapeHtml as esc} from './app-v2-core.js';

// A space stays on its wall while the same frame moves out and back.
export function mountSpaceGallery(root,{spaces,onEnter,initialPosition=0,onPositionChange=()=>{},kindLabel='示例空间'}) {
  if(!spaces.length){root.innerHTML='<p class="v2-gallery-empty">暂时没有可展示的空间。</p>';return ()=>{};}
  const motion=matchMedia('(prefers-reduced-motion: reduce)');
  const end=Math.max(0,Math.ceil(spaces.length/2)-1)*250;
  let distance=Math.max(0,Math.min(end,Number(initialPosition)||0)),selected=-1,drag=null,suppress=false,disposed=false;
  root.innerHTML=`<section class="v2-gallery" aria-label="双侧回忆空间回廊" tabindex="0">
    <div class="v2-gallery-hall" aria-hidden="true">${Array.from({length:9},(_,i)=>`<div class="ring" data-gallery-ring="${i}"></div>`).join('')}</div>
    <div class="floor"></div><div class="fog"></div><div class="v2-gallery-shade"></div>
    <div class="v2-gallery-frames" role="group" aria-label="两侧空间相框">${spaces.map((s,i)=>`<div class="v2-gallery-frame" data-gallery-frame="${i}">
      <button class="v2-gallery-cover" aria-label="展开${esc(s.title)}" aria-expanded="false" aria-controls="gallery-preview" data-gallery-open="${i}">${s.cover?`<img src="${esc(s.cover)}" alt="${esc(s.title)}" draggable="false" loading="lazy">`:'<div class="v2-cover-art" aria-hidden="true"><span></span><i></i><b></b></div>'}<span>${esc(s.title)}</span></button>
    </div>`).join('')}</div>
    <section class="v2-gallery-preview" id="gallery-preview" aria-label="空间预览" hidden>
      <span>MEMORY SPACE</span><h2></h2><p></p><button class="btn gold" data-gallery-enter>走进这个空间 →</button><button class="v2-gallery-return" data-gallery-close>收回相框</button>
    </section>
    <div class="v2-gallery-walk"><div class="v2-gallery-walk-buttons"><button class="ib" data-gallery-back aria-label="沿回廊后退">↓</button><span data-gallery-count role="status"></span><button class="ib" data-gallery-forward aria-label="沿回廊前进">↑</button></div><p>上下滑动，沿回廊前后走<br>轻触两侧相框，展开看看</p></div>
    <span class="v2-gallery-kind">${esc(kindLabel)}</span>
  </section>`;
  const stage=root.querySelector('.v2-gallery'),frames=[...root.querySelectorAll('[data-gallery-frame]')],rings=[...root.querySelectorAll('[data-gallery-ring]')];
  const preview=root.querySelector('.v2-gallery-preview');
  const back=root.querySelector('[data-gallery-back]'),forward=root.querySelector('[data-gallery-forward]');
  function paint(){
    root.querySelector('.v2-gallery-kind').textContent=selected>=0?(spaces[selected].kindLabel||kindLabel):kindLabel;
    stage.classList.toggle('has-selection',selected>=0);
    stage.classList.toggle('reduced',motion.matches);
    rings.forEach((ring,i)=>{ring.style.transform=`translateZ(${distance%250-i*250}px)`;});
    frames.forEach((frame,i)=>{
      const depth=-140-Math.floor(i/2)*250-(i%2)*60+distance;
      const visible=depth<=0&&depth>=-1400;
      frame.style.setProperty('--gallery-side',i%2?1:-1);
      frame.style.setProperty('--gallery-depth',depth+'px');
      frame.style.setProperty('--gallery-lift',((i%3-1)*12)+'px');
      frame.style.zIndex=String(i===selected?30:Math.max(1,20-Math.floor(i/2)));
      frame.classList.toggle('is-open',selected===i);
      frame.classList.toggle('is-passed',!visible);
      frame.setAttribute('aria-hidden',String(!visible&&i!==selected));
      const button=frame.querySelector('button');
      button.tabIndex=visible&&(selected===-1||selected===i)?0:-1;
      button.setAttribute('aria-expanded',String(i===selected));
      button.setAttribute('aria-label',(i===selected?'收回':'展开')+spaces[i].title);
    });
    back.disabled=distance<=0;forward.disabled=distance>=end;
    back.tabIndex=forward.tabIndex=selected===-1?0:-1;
    root.querySelector('[data-gallery-count]').textContent=`${Math.min(Math.floor(distance/250)+1,Math.ceil(spaces.length/2))} / ${Math.ceil(spaces.length/2)}`;
  }
  function close(){
    if(selected<0)return;
    const origin=frames[selected].querySelector('button');
    selected=-1;preview.hidden=true;paint();origin.focus({preventScroll:true});
  }
  function open(index){
    if(selected>=0){close();return;}
    selected=index;
    const space=spaces[index];preview.querySelector('h2').textContent=space.title;preview.querySelector('p').textContent=space.intro||'走进去，看看这处现场。';
    preview.hidden=false;paint();frames[index].querySelector('button').focus({preventScroll:true});
  }
  function walk(next){if(selected>=0)return;distance=Math.max(0,Math.min(end,next));onPositionChange(distance);paint();}
  const down=e=>{
    if(e.button!==0||selected>=0||e.target.closest('.v2-gallery-walk'))return;
    e.preventDefault();drag={x:e.clientX,y:e.clientY,start:distance,moved:0};suppress=false;
  };
  const move=e=>{
    if(!drag)return;
    const y=drag.y-e.clientY,x=drag.x-e.clientX;drag.moved=Math.max(drag.moved,Math.hypot(x,y));
    if(drag.moved>8&&!stage.hasPointerCapture(e.pointerId))stage.setPointerCapture(e.pointerId);
    if(Math.abs(y)>Math.abs(x))walk(drag.start+y*2.1);
  };
  const up=()=>{if(!drag)return;suppress=drag.moved>8;drag=null;};
  const cancel=()=>{drag=null;suppress=true;};
  const wheel=e=>{if(e.target.closest('.v2-gallery-preview')||e.ctrlKey)return;e.preventDefault();walk(distance+Math.max(-100,Math.min(100,e.deltaY*.8)));};
  const click=e=>{
    if(suppress){suppress=false;return;}
    const frame=e.target.closest('[data-gallery-open]');
    if(e.target.closest('[data-gallery-enter]')){if(selected>=0)onEnter(spaces[selected]);return;}
    if(e.target.closest('[data-gallery-close]')){close();return;}
    if(selected>=0){if(!e.target.closest('.v2-gallery-preview'))close();return;}
    if(frame){open(Number(frame.dataset.galleryOpen));return;}
    if(e.target.closest('[data-gallery-back]'))walk(distance-250);
    if(e.target.closest('[data-gallery-forward]'))walk(distance+250);
  };
  const key=e=>{
    if(e.key==='Escape'&&selected>=0){e.preventDefault();close();return;}
    if(selected>=0||!['ArrowDown','ArrowUp','PageDown','PageUp','Home','End'].includes(e.key))return;
    e.preventDefault();walk(e.key==='Home'?0:e.key==='End'?end:distance+(['ArrowDown','PageDown'].includes(e.key)?250:-250));
  };
  stage.addEventListener('pointerdown',down);stage.addEventListener('pointermove',move);stage.addEventListener('pointerup',up);stage.addEventListener('pointercancel',cancel);
  stage.addEventListener('wheel',wheel,{passive:false});stage.addEventListener('click',click);stage.addEventListener('keydown',key);motion.addEventListener('change',paint);
  frames.forEach(frame=>{const img=frame.querySelector('img');if(img)img.onerror=()=>{if(!disposed)frame.classList.add('image-unavailable');};});
  paint();
  return ()=>{disposed=true;drag=null;motion.removeEventListener('change',paint);stage.removeEventListener('pointerdown',down);stage.removeEventListener('pointermove',move);stage.removeEventListener('pointerup',up);stage.removeEventListener('pointercancel',cancel);stage.removeEventListener('wheel',wheel);stage.removeEventListener('click',click);stage.removeEventListener('keydown',key);frames.forEach(f=>{const img=f.querySelector('img');if(img)img.onerror=null;});};
}
