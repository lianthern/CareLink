import {MomentApi} from './moment-data.js';
const api=new MomentApi(),$=s=>document.querySelector(s);let accountId=null,groups=[];
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const tell=s=>{$('#notice').textContent=s;};
const errors={authentication_failed:'账号或密码不正确。',scene_file_hash_mismatch:'文件校验没有通过，请重新选择原文件并上传。',scene_files_incomplete:'还有文件未传完，重新选择同一文件夹即可继续。',scene_manifest_invalid:'场景配置不完整，请在本机重新导出。',scene_photo_file_missing:'照片引用缺少文件，请让本机导出程序一并打包。',scene_space_unavailable:'你没有这个空间的管理权限。',scene_upload_busy:'另一个上传正在进行，请稍后重试。',account_changed:'账号已变化，请刷新页面并重新登录。',scene_storage_limit:'当前账号的场景存储额度已满。',scene_result_immutable:'这个版本已经保存，请刷新查看。'};
function error(e){tell(errors[e.code]||`暂时未完成（${e.code||'连接中断'}）。保留文件夹，可刷新后重试。`);}
async function hash(file){const bytes=await file.arrayBuffer();return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');}
const request=(path,options)=>api.request(path,options);
async function refresh(){
 const data=await request('/v1/me/spaces'),old=$('#spaces').value;
 const spaces=(data.spaces||[]).filter(s=>(s.owner===true||s.isOwner===true)&&s.spaceLifecycle==='active');
 $('#spaces').innerHTML=spaces.map(s=>`<option value="${esc(s.spaceId||s.id)}">${esc(s.name||s.title)}</option>`).join('');if(spaces.some(s=>(s.spaceId||s.id)===old))$('#spaces').value=old;
 const {results}=await request('/api/scene-results');$('#count').textContent=`${results.filter(r=>r.status==='ready').length} 个已保存版本`;
 $('#results').innerHTML=results.length?results.map(r=>`<article class="result"><div><h3>${esc(r.title)}${r.active?'<span class="badge">空间当前版本</span>':''}</h3><p>${esc(r.sourceRevisionId)} · ${(r.totalBytes/1024/1024).toFixed(1)} MB · ${r.status==='ready'?'已保存':'等待上传完成'}</p>${r.status==='ready'?`<p>${r.photoAnchorCount||0} 个照片机位 · ${r.hasLocalizationMap?'定位资料已保存':'新照片自动定位尚未接入'}</p>`:''}</div><div class="actions">${r.viewerUrl?`<a href="/app-v2#shared-space/${esc(r.spaceId)}?tab=photos">空间照片 / 视频</a><a href="${esc(r.viewerUrl)}" target="_blank" rel="noopener">打开场景 ↗</a>${r.active?'':`<button class="quiet" data-activate="${r.resultId}">设为当前版本</button>`}`:'<span class="hint">重新选择同一文件夹可续传</span>'}</div></article>`).join(''):'<p>这里还没有上传的场景。选择一个你满意的本机版本开始。</p>';
}
$('#results').addEventListener('click',async e=>{const b=e.target.closest('[data-activate]');if(!b)return;b.disabled=true;try{await request(`/api/scene-results/${b.dataset.activate}/activate`,{method:'POST',body:{}});await refresh();tell('已设为这个空间的当前版本，其他版本仍然保留。');}catch(e){error(e);b.disabled=false;}});
$('#refresh').onclick=()=>refresh().catch(error);
$('#login').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);try{await request('/v1/auth/password-login',{method:'POST',body:{username:f.get('username'),password:f.get('password')}});e.target.reset();await boot();}catch(e){error(e);}};
$('#folder').onchange=async()=>{
 groups=[];$('#selection').textContent='正在读取场景清单…';$('#submit').disabled=true;
 try{
 const files=[...$('#folder').files],byPath=new Map(files.map(f=>[f.webkitRelativePath,f]));
 for(const f of files.filter(f=>f.name==='scene.json')){
  const base=f.webkitRelativePath.slice(0,-'scene.json'.length),manifest=JSON.parse(await f.text());
  const wanted=new Set(['scene.json','assets/scene.sog']);
  if(byPath.has(base+'navigation-map.json'))wanted.add('navigation-map.json');
  for(const a of manifest.photoAnchors||[])for(const key of ['thumbnail','originalUrl'])if(a[key])wanted.add(a[key]);
  const selected=[];for(const path of wanted){const item=byPath.get(base+path);if(!item)throw {code:'scene_photo_file_missing'};selected.push({path,file:item});}
  groups.push({manifest,files:selected});
 }
 $('#selection').innerHTML=groups.map((g,i)=>`<label class="pick"><input type="radio" name="selected-scene" data-group="${i}"><span>${esc(g.manifest.name||g.manifest.sceneRevisionId)}<small>${(g.files.reduce((s,f)=>s+f.file.size,0)/1024/1024).toFixed(1)} MB · ${esc(g.manifest.sceneRevisionId)}</small></span></label>`).join('')||'<p>没有找到 scene.json。请先解压本机导出的场景包，再选择包含场景的文件夹。</p>';
 }catch(e){error(e);$('#selection').textContent='读取失败，请检查导出的场景文件夹。';}
};
$('#selection').onchange=()=>{$('#submit').disabled=!$('#selection input:checked');};
$('#upload').onsubmit=async e=>{
 e.preventDefault();const selected=[...$('#selection').querySelectorAll('input:checked')].map(i=>groups[Number(i.dataset.group)]);if(!selected.length||!$('#spaces').value)return;
 $('#submit').disabled=true;$('#folder').disabled=true;$('#spaces').disabled=true;$('#progress').hidden=false;
 try{
  let complete=0;const total=selected.reduce((n,g)=>n+g.files.reduce((s,f)=>s+f.file.size,0),0);
  for(const g of selected){
   tell(`正在校验「${g.manifest.name}」…`);const files=[];for(const f of g.files)files.push({path:f.path,bytes:f.file.size,sha256:await hash(f.file)});
   let {result}=await request('/api/scene-results',{method:'POST',body:{consent:true,spaceId:$('#spaces').value,title:g.manifest.name||g.manifest.sceneRevisionId,sourceRevisionId:g.manifest.sceneRevisionId,files}});
   if(result.status!=='ready'){
    for(const f of g.files){if(!result.files.find(x=>x.path===f.path)?.received){tell(`正在上传「${g.manifest.name}」：${f.path}`);const response=await fetch(`/api/scene-results/${result.resultId}/files/${encodeURIComponent(f.path)}`,{method:'PUT',credentials:'same-origin',headers:{'Content-Type':'application/octet-stream','X-Unseen-Expected-Account-Id':accountId},body:f.file});const data=await response.json();if(!response.ok)throw {code:data.error};}complete+=f.file.size;$('#progress').value=complete/total*100;}
    ({result}=await request(`/api/scene-results/${result.resultId}/commit`,{method:'POST',body:{}}));
   }
  }
  $('#progress').value=100;await refresh();tell('选中的场景已保存。可以打开检查，满意后设为该空间的当前版本。');
 }catch(e){error(e);}finally{$('#submit').disabled=false;$('#folder').disabled=false;$('#spaces').disabled=false;}
};
async function boot(){try{const me=await request('/v1/me');accountId=me.accountId;api.setAccount(accountId);$('#login').hidden=true;$('#workspace').hidden=false;tell('');await refresh();}catch(e){if([401,403].includes(e.status)){accountId=null;api.setAccount(null);$('#login').hidden=false;$('#workspace').hidden=true;tell('登录后可查看你保存的场景。');}else error(e);}}
boot();
