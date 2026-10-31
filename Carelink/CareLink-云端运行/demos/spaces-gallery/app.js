import {createExperience} from './experience.js';
import {icon} from './icons.js';
import {seedPhotos,seedSpaces,escapeHtml as esc} from './data.js';
import {designDeco,designHero,designTitle} from './vendor/reference-design.js';
const content=document.querySelector('#content');
const navs=[['home','home','首页'],['spaces','space','回忆空间'],['library','library','回忆库'],['me','user','我的']];
let route=location.hash.slice(1)||'home';
const button=(label,action,cls='primary',ic='')=>`<button class="${cls}" data-action="${action}">${ic?icon(ic):''}<span>${label}</span></button>`;
function nav(){
 const active=route.startsWith('space/')||route.startsWith('corridor/')?'spaces':route;
 document.querySelector('#sidebar').innerHTML='';
 const tab=([id,ic,label])=>`<button class="tab ${active===id?'on':''}" data-action="${id}" ${active===id?'aria-current="page"':''}><span class="ti">${icon(ic)}</span><span>${label}</span></button>`;
 document.querySelector('#bottom-nav').className='tabs';
 document.querySelector('#bottom-nav').innerHTML=navs.slice(0,2).map(tab).join('')+`<button class="fab" data-action="create" aria-label="创建">＋</button>`+navs.slice(2).map(tab).join('');
 const ambientPage=route==='compose'?'B1':route==='spaces'?'A1':route.startsWith('space/')?'A2':'P0';
 document.querySelector('#ambient').innerHTML=designDeco(ambientPage);
}
function header(title,subtitle,action=''){
 return `<header class="page-header nav"><h1>${esc(title)}${subtitle?`<small>${esc(subtitle)}</small>`:''}</h1><div class="grow"></div>${action}</header>`;
}
function home({state}={}){
 const recent=[...(state?.photos||[]),...seedPhotos].slice(0,6),space=state?.spaces?.[0]||seedSpaces[0];
 return `<div class="nav home-nav"><button class="ava a6 home-avatar" data-action="me" aria-label="我的资料">${icon('user')}</button><h1>${esc(state?.preferences.name||'体验者')}<small>${state?.photos.length||0} 段回忆 · ${state?.spaces.length||0} 个空间</small></h1><div class="grow"></div><button class="ib" data-action="my-favorites" aria-label="收藏的回忆">♡</button><button class="ib" data-action="my-spaces" aria-label="我的空间">◔</button></div>
 <button class="restored-hero" data-action="spaces" aria-label="回忆时刻，进入回忆空间">${designHero()}</button>
 <div class="original-entries"><button class="glass gilt card-corner original-entry" data-action="new-space"><span class="original-entry-icon gold">◫</span><strong>创建回忆空间</strong><small>把同一天的照片，放在一起</small></button><button class="glass card-corner original-entry" data-action="compose-memory"><span class="original-entry-icon rose">✦</span><strong>留下一段回忆</strong><small>从一张照片，慢慢说起</small></button></div>
 ${designTitle('YOUR SPACES','回到回忆空间')}
 <button class="glass home-space-row" data-action="space:${esc(space.id)}"><span class="rounded"><img src="${esc(space.cover)}" alt="${esc(space.name)}"></span><span class="home-space-copy"><strong>${esc(space.name)}</strong><small>${space.example?'示例空间':'私密空间'} · ${space.photoIds.length} 张照片</small><span class="home-space-types">照片相册<span> · </span>照片走廊</span></span><span class="home-space-arrow">›</span></button>
 ${designTitle('RECENT','最近的回忆')}
 <div class="hs original-recent">${recent.map(p=>`<button data-action="photo:${esc(p.id)}"><span class="rounded"><img src="${esc(p.url)}" alt="${esc(p.title)}" loading="lazy"><span class="tag ${p.local?'gold':'ice'}">${p.local?'已保存':'示例'}</span></span><span class="original-recent-title">${esc(p.title)}</span></button>`).join('')}</div>
 <div class="home-end"><button data-action="library">查看全部回忆 ›</button><a href="./reference/original.html" target="_blank" rel="noopener">对照原设计稿</a></div>`;
}
createExperience({content,header,button,home,onRoute:r=>{route=r;nav();}});
