'use strict';
(() => {
  const $ = selector => document.querySelector(selector);
  const query = new URLSearchParams(location.search), fragment = new URLSearchParams(location.hash.slice(1));
  const invite = query.get('invite') || fragment.get('invite') || '';
  const storageKey = 'unseen-onsite:' + invite;
  let saved = {}, items = [], previews = [], busy = false, timer, token, info, checks = 0;
  try { saved = JSON.parse(localStorage.getItem(storageKey) || '{}') || {}; } catch {}
  let visitor = /^[a-f0-9-]{36,48}$/.test(saved.visitor || '') ? saved.visitor : crypto.randomUUID();
  const showError = text => { $('#error').textContent = text; $('#error').hidden = !text; };
  function persist() {
    try { localStorage.setItem(storageKey, JSON.stringify({ visitor, name: $('#nickname').value, sent: items.filter(x => x.messageId).map(x => ({messageId:x.messageId, received:x.received})).slice(-20) })); }
    catch { /* Upload remains usable with storage disabled. */ }
  }
  async function api(action, data = {}, auth = token) {
    const response = await fetch('/api', { method:'POST', headers:{'Content-Type':'application/json', ...(auth ? {Authorization:'Bearer ' + auth} : {})},
      body:JSON.stringify({action,data}), signal:AbortSignal.timeout(45000) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || '暂时没有连接成功，请重试');
    return value;
  }
  function render() {
    $('#resultList').replaceChildren();
    for (const item of items) {
      const li = document.createElement('li');
      if (item.preview) { const img = document.createElement('img'); img.src = item.preview; img.alt = '你选择的照片'; li.append(img); }
      const span = document.createElement('span');
      span.textContent = item.received ? '相框已收到' : item.messageId ? '已上传，等待相框接收' : item.status || '等待发送';
      if (item.received) span.className = 'received';
      li.append(span); $('#resultList').append(li);
    }
    $('#results').hidden = !items.length;
    $('#morePhotos').hidden = busy || items.some(item => !item.messageId);
  }
  async function receipts() {
    clearTimeout(timer);
    const pending = items.filter(x => x.messageId && !x.received);
    if (!token || !pending.length || document.hidden || checks >= 60) return;
    checks++;
    try {
      const result = await api('uploadStatus', { ids:pending.map(x => x.messageId).slice(-20) });
      for (const status of result.items) { for (const item of items.filter(x => x.messageId === status.id)) item.received = status.received; }
      persist(); render();
    } catch { /* An upload is saved even if the receipt connection is unavailable. */ }
    if (items.some(x => x.messageId && !x.received)) timer = setTimeout(receipts, 5000);
  }
  async function identity() {
    if (token) return;
    const result = await api('uploadJoin', { invite, visitor, nickname:$('#nickname').value }, null);
    token = result.token; $('#nickname').value = result.name; $('#nickname').readOnly = true; persist();
  }
  async function start() {
    $('#retryLink').hidden = true; showError('');
    try {
      if (!/^[a-f0-9]{48}$/.test(invite)) throw new Error('请扫描现场的上传二维码，或打开工作人员发来的完整链接。');
      info = await api('uploadInfo', {invite}, null);
      $('#destination').textContent = info.label;
      $('#notice').textContent = '照片会送到现场相框所在的家庭。';
      $('#expiry').textContent = '本次入口有效至 ' + new Date(info.expires).toLocaleString('zh-CN', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
      $('#uploadForm').hidden = false;
      if (info.remaining <= 0) $('#notice').textContent = '新照片名额已满；之前未完成的照片仍可重新选择并继续寄出。';
      $('#nickname').value = typeof saved.name === 'string' ? saved.name.slice(0,30) : '';
      if (Array.isArray(saved.sent)) {
        items = saved.sent.filter(x => typeof x.messageId === 'string').slice(-20).map(x => ({messageId:x.messageId,received:!!x.received}));
        saved.sent = null;
        if (items.length) { await identity(); render(); void receipts(); }
      }
    } catch (error) { $('#uploadForm').hidden=true; $('#notice').textContent='还没有连接上传入口'; showError(error.message); $('#retryLink').hidden=false; }
  }
  $('#photos').addEventListener('change', () => {
    if (busy) return;
    showError(''); for(const url of previews) URL.revokeObjectURL(url); previews=[];
    const files = [...$('#photos').files];
    if (files.length > 9) { $('#photos').value=''; $('#previews').replaceChildren(); showError('一次最多选择 9 张照片，请重新选择。'); return; }
    items = files.map(file => { const preview=URL.createObjectURL(file); previews.push(preview); return {file,preview,id:crypto.randomUUID()}; });
    $('#previews').replaceChildren();
    for(const item of items) {const img=document.createElement('img');img.src=item.preview;img.alt='待发送照片';$('#previews').append(img);}
    $('#results').hidden=true;
  });
  async function prepare(file) {
    if(file.size>30*1024*1024)throw new Error('单张原图请小于 30 MB。');
    const img=new Image(), url=URL.createObjectURL(file);
    try {
      img.src=url; await img.decode();
      if (!img.naturalWidth || !img.naturalHeight) throw Error();
      const scale=Math.min(1,1920/Math.max(img.naturalWidth,img.naturalHeight));
      const canvas=document.createElement('canvas'); canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));
      const context=canvas.getContext('2d');context.fillStyle='#ffffff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(img,0,0,canvas.width,canvas.height);
      const data=canvas.toDataURL('image/jpeg',.86).split(',')[1];
      if(data.length>4000000)throw new Error('照片压缩后仍然过大，请选择小一些的图片。');
      return data;
    } catch(error) {throw new Error(error.message?.startsWith('照片压缩')?error.message:'这张照片暂时无法打开，请改用 JPEG / PNG 照片或截图。');}
    finally {URL.revokeObjectURL(url);}
  }
  $('#uploadForm').addEventListener('submit', async event => {
    event.preventDefault(); if(busy||!items.length)return;
    busy=true;showError(''); clearTimeout(timer);
    const controls=[...$('#uploadForm').querySelectorAll('input,textarea,button')];controls.forEach(x=>x.disabled=true);
    $('#sendPhotos').textContent='正在寄出…'; render();
    try {
      await identity();
      for(const item of items) {
        if(item.messageId)continue;
        item.status='正在处理照片…';render();
        if(!item.imageId) {const data=await prepare(item.file);item.status='正在上传…';render();item.imageId=(await api('upload',{base64:data})).id;}
        // The file identity is stable across reselection, refresh and lost responses.
        item.id = item.imageId;
        item.text ??= $('#note').value;
        const result=await api('send',{id:item.id,image:item.imageId,text:item.text});
        item.messageId=result.id;persist();render();
      }
      $('#uploadForm').hidden=true;
      $('#notice').textContent='照片已保存。相框联网并打开时会自动接收。';
      checks=0; void receipts();
    } catch(error) {showError((error.name==='TimeoutError'?'连接等待超时，已完成的照片不会重复发送':error.message)+' 未完成的照片可点“继续寄出”重试。');}
    finally {busy=false;controls.forEach(x=>x.disabled=false);$('#sendPhotos').textContent='继续寄出';render();}
  });
  $('#morePhotos').onclick=() => {
    clearTimeout(timer);items=[];for(const url of previews)URL.revokeObjectURL(url);previews=[];
    $('#photos').value='';$('#note').value='';$('#previews').replaceChildren();$('#results').hidden=true;$('#uploadForm').hidden=false;
    $('#sendPhotos').textContent='寄到相框';showError('');$('#notice').textContent='再选几张想分享的照片。';persist();
  };
  $('#retryLink').onclick=start;
  document.addEventListener('visibilitychange',()=>{if(document.hidden)clearTimeout(timer);else {checks=0;void receipts();}});
  window.addEventListener('beforeunload',event=>{if(busy){event.preventDefault();event.returnValue='';}});
  void start();
})();
