import {esc} from './data.js';
const exportDesign=()=>({
 clarity:{bg:'#ffffff',end:'#eef0f5',text:'#1d1d1f',muted:'#6e6e73',line:'#d5d7df',font:'system-ui, sans-serif'},
 cinema:{bg:'#191b20',end:'#08090b',text:'#f7f7fa',muted:'#a5a7af',line:'#5d606c',font:'system-ui, sans-serif'},
 keepsake:{bg:'#f8f5fa',end:'#ece6f2',text:'#292635',muted:'#76717f',line:'#cec6d8',font:'"Songti SC", serif'}
}[document.documentElement.dataset.design]||{bg:'#fff',end:'#eef0f5',text:'#1d1d1f',muted:'#6e6e73',line:'#d5d7df',font:'sans-serif'});
const dataUrl = blob => new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.readAsDataURL(blob);});
export function download(blob,name){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
function wrap(ctx,text,x,y,width,lineHeight,max=8){let line='',n=0;for(const char of String(text)){if(char==='\n'||ctx.measureText(line+char).width>width){ctx.fillText(line,x,y);y+=lineHeight;line='';if(++n>=max)return y;}if(char!=='\n')line+=char;}if(line)ctx.fillText(line,x,y);return y+lineHeight;}
export async function exportCard({title,photos,text='',qr}){
 const palette=exportDesign();
 const canvas=document.createElement('canvas');canvas.width=1080;canvas.height=1440;const c=canvas.getContext('2d');const g=c.createLinearGradient(0,0,1080,1440);g.addColorStop(0,palette.bg);g.addColorStop(1,palette.end);c.fillStyle=g;c.fillRect(0,0,1080,1440);
 c.fillStyle=palette.text;c.font='36px Georgia';c.fillText('U N S E E N',72,100);c.fillStyle=palette.muted;c.font='22px sans-serif';c.fillText(qr?'共忆邀请 · 本机预览':'把这一刻，留给以后',72,148);
 if(photos[0]){const im=new Image();im.src=photos[0].url;await im.decode();const x=72,y=210,w=936,h=650;const ratio=Math.max(w/im.width,h/im.height);c.save();c.beginPath();c.rect(x,y,w,h);c.clip();c.drawImage(im,x+(w-im.width*ratio)/2,y+(h-im.height*ratio)/2,im.width*ratio,im.height*ratio);c.restore();c.strokeStyle=palette.line;c.strokeRect(x,y,w,h);}
 else {c.strokeStyle=palette.line;c.strokeRect(72,210,936,650);c.fillStyle=palette.text;c.font='180px Georgia';c.fillText('U',470,570);}
 c.fillStyle=palette.text;c.font='52px '+palette.font;let y=wrap(c,title,72,963,930,68,3);c.fillStyle=palette.muted;c.font='28px sans-serif';wrap(c,text,72,y+32,qr?650:920,45,4);
 if(qr)c.drawImage(qr,814,1130,194,194);c.fillStyle=palette.muted;c.font='21px sans-serif';c.fillText(qr?'邀请仅能在同一浏览器预览，未发送给任何人':'UNSEEN · 由你选择，才被分享',72,1365);
 const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw Error('图片生成失败');return {blob,name:title+'.png',format:'image'};
}
export async function exportHTML({title,photos,text='',audio=[]}){
 const palette=exportDesign();
 const imgs=await Promise.all(photos.map(async p=>({...p,url:await dataUrl(await(await fetch(p.url)).blob())})));
 const audios=await Promise.all(audio.map(async t=>await dataUrl(await(await fetch(t.url)).blob())));
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{margin:0;background:${palette.bg};color:${palette.text};font:17px/1.9 system-ui}main{max-width:820px;margin:auto;padding:48px 24px}h1{font:42px/1.5 ${palette.font}}header,footer{color:${palette.muted}}img{width:100%;border-radius:6px}figure{margin:30px 0}p{white-space:pre-wrap}audio{display:block;width:100%;margin:20px 0}</style><main><header>U N S E E N · 离线回忆</header><h1>${esc(title)}</h1><p>${esc(text)}</p>${imgs.map(p=>`<figure><img src="${p.url}" alt="${esc(p.title)}"><figcaption>${esc(p.title)}</figcaption></figure>`).join('')}${audios.map(url=>`<audio controls src="${url}"></audio>`).join('')}<footer>照片与原话，由记录者选择后导出。此文件可独立离线打开。</footer></main></html>`;
 return {blob:new Blob([html],{type:'text/html;charset=utf-8'}),name:title+'.html',format:'html'};
}
