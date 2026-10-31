import { UnseenAccountApi, solveAccountChallenge } from './unseen-account-api.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const id = value => encodeURIComponent(String(value));
const button = (action, label, attributes = '') => `<button type="button" data-account-action="${action}" ${attributes}>${label}</button>`;
const statusCopy = { selected:'待上传', uploading:'正在上传', removed:'已移除', visible:'已展示', pending_review:'待审核', hidden:'已隐藏', rejected:'未通过', needs_confirmation:'待确认位置', confirmed:'已归位', failed:'处理失败', validating:'正在检查', ready:'可用', active:'有效', revoked:'已撤回', expired:'已过期', exhausted:'名额已满', finalized:'已提交', committed:'已接收', pending:'待审核', open:'待完成', draft:'草稿', preview_ready:'预览已准备', frozen:'已定稿' };
const status = value => statusCopy[value] || value || '待处理';
const errorCopy = error => ({ session_unavailable:'登录已失效，请重新登录。', request_origin_invalid:'账号服务连接未完成，请刷新后重试。', otp_verification_failed:'图形验证未通过，请重新选择。', otp_pow_solve_timeout:'验证耗时较长，请重新验证。', otp_invalid:'验证码不正确或已过期。', version_conflict:'内容刚刚发生变化，请刷新后再操作。', resource_unavailable:'你暂时无权查看这里，或内容已不可用。', book_lab_extension_unavailable:'活动书服务暂未开启。', book_render_generation_paused:'新的成书预览与 PDF 暂未开放，书稿可继续编辑。', book_version_unavailable:'这个成书版本暂不可读，可能仍在生成，或其中的授权已撤回。请更新状态后重试。', book_artifact_integrity_failed:'成品内容校验未通过，请刷新重新读取。', invitation_unavailable:'这个邀请暂不可用，请返回案例或向空间主人索取新的邀请。', upload_unavailable:'当前没有上传权限，或活动已暂停收集。', memory_unavailable:'这份记忆暂不可用。', media_decode_rejected:'这张文件无法解码，可完成本批后另选可打开的照片。', upload_object_failed:'上传暂未完成，可以继续这张照片。', receipt_recovery_required:'上传已完成，但此回执凭证已失效。请返回现场核对照片。', upload_original_file_required:'请选择原照片后继续。', upload_original_file_mismatch:'这张文件与原选择不同，请重新选择同一张原照片。', upload_items_not_finished:'还有照片没有上传完，请先继续上传或等检查完成。', upload_pending_batch:'请先完成当前这批照片。', upload_recovery_storage_unavailable:'浏览器无法保存进度，请允许本地存储后重试。' }[error?.code] || `暂时没有完成（${error?.code || 'network_error'}），你可以重试。`);
const safeMedia = value => typeof value === 'string' && /^\/(?:v1\/|__local-operable\/private-media\/)/.test(value) && !value.includes('..') ? value : '';
const photoCard = (photo, controls = '') => `<article class="ua-photo">${safeMedia(photo.assetUrl || photo.photoMedia?.url) ? `<img loading="lazy" src="${esc(photo.assetUrl || photo.photoMedia.url)}" alt="${esc(photo.title || '活动照片')}">` : '<div class="ua-no-photo">照片处理中</div>'}<div><strong>${esc(photo.title || photo.fileName || '现场照片')}</strong><p>${esc(status(photo.contentState))} · ${esc(status(photo.placementState))}</p>${controls}</div></article>`;
const uuid = () => crypto.randomUUID();
const sha = async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2,'0')).join('');

export function resolveInvitationDestination(result, {readOnly=false,spaceId:fallback}={}) {
  const direct=typeof result?.destinationRoute==='string'&&result.destinationRoute.match(/^\/s\/([A-Za-z0-9_-]+)\/(album|upload)$/);
  const spaceId=direct?.[1] || result?.spaceId || fallback;
  if(typeof spaceId!=='string'||!spaceId||spaceId==='undefined'||!/^[A-Za-z0-9_-]+$/.test(spaceId))throw {code:'invitation_unavailable'};
  return {route:!readOnly&&(direct?.[2]==='upload'||(!direct&&result.entryTask==='upload'))?'upload':'album',spaceId};
}

export function frozenBookDestination(response, spaceId, bookId) {
  if (!response?.ok) return null;
  const completed=(response.body?.completedVersions || []).find(version=>version.status==='available'&&version.readerPath===`/s/${id(spaceId)}/books/${id(bookId)}/versions/${id(version.versionId)}`);
  if(completed)return completed.readerPath;
  if(response.body?.status !== 'frozen')return null;
  try {
    const versionId = JSON.parse(response.unseenHeaders?.['x-unseen-book-owner-preconditions'] || '{}').startNewVersion?.fromVersionId;
    if (![spaceId, bookId, versionId].every(value => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value))) return null;
    return `/s/${id(spaceId)}/books/${id(bookId)}/versions/${id(versionId)}`;
  } catch { return null; }
}

export function bookMountCallbacks({signal,isCurrent,fetchImpl=fetch,onPdf,navigate}) {
  const current=()=>!signal.aborted&&isCurrent();
  return {
    fetchImpl:(url,options={})=>{if(!current())throw new DOMException('Book view closed','AbortError');return fetchImpl(url,{...options,signal});},
    onPdf:response=>{if(current())return onPdf(response);},
    navigate:destination=>{if(current())return navigate(destination);}
  };
}

export function createAccountSurface({ api = new UnseenAccountApi(), onNavigate, onViewer, onBook, onSessionChange = () => {}, onStatus = () => {} } = {}) {
  let root, binding, aborter = new AbortController(), page = { route:'spaces' }, data = {}, generation = 0, email = '', challenge, challengeId, selection = new Set(), bookShell, pendingReauth, bookReaderResize;
  const opts = () => ({ signal: aborter.signal });
  const request = (path, options = {}) => api.request(path, { ...opts(), ...options });
  const post = (path, body = {}, version, headers = {}) => request(path, { method:'POST', body, version, headers });
  const nav = async target => { if(page.readOnly)target={...target,readOnly:true,caseId:page.caseId}; if (onNavigate) return onNavigate(target); page = target; await repaint(); };
  const heading = (title, copy = '') => `<header class="ua-head"><p>UNSEEN · 一起留下</p><h1>${esc(title)}</h1>${copy ? `<p>${esc(copy)}</p>` : ''}</header>`;
  const frame = html => `<section class="ua-surface">${html}<p id="ua-account-status" class="ua-status" role="status" aria-live="polite"></p></section>`;
  const back = () => page.readOnly ? button('case-return','← 返回案例') : page.spaceId && ['upload','placement','book','receipt'].includes(page.route) ? button('album','← 返回现场') : button('spaces','← 我的空间');
  function tell(message) { const target = root?.querySelector('.ua-status'); if (target) target.textContent = message; onStatus(message); }
  async function render(next = page) {
    generation += 1; bookReaderResize?.disconnect(); bookReaderResize=null; aborter.abort(); aborter = new AbortController(); bookShell?.destroy(); bookShell = null;
    page = { route:'spaces', ...next }; data = {}; pendingReauth = null;
    try {
      if(page.readOnly && !['invite','album'].includes(page.route))return frame(back()+heading('案例只读浏览','请从案例邀请进入相册。'));
      if (page.route === 'login') return frame(loginHtml());
      if (page.route === 'invite') {
        data.preview = await request(`/v1/external-invitation-campaigns/${id(page.inviteToken)}/preview`);
        return frame((page.readOnly?back():'')+heading(data.preview.displayName || data.preview.spaceName || data.preview.name || '受邀一起留下', page.readOnly?'只读浏览这个案例的照片与 360 现场。':'加入后，你可以在授权范围内看现场、贡献照片。') + `<p>${esc(data.preview.message || '这个邀请由空间主人发起。')}</p>` + button('join','接受邀请并继续'));
      }
      if (page.route === 'book') return frame(back() + heading('把共同经历，做成一本书', '照片、原话和署名逐项获得授权后，才会进入书页。') + '<div class="ua-book" data-account-book></div>');
      if (page.route === 'receipt') {
        data.receipt = await request('/v1/batch-receipt');
        return frame(back() + heading('这次上传已留下', '在这里核对处理结果；失败的照片不会冒充上传成功。') + receiptHtml(data.receipt));
      }
      if (page.route === 'placement') {
        data.placement = await api.placement(page.photoId, opts());
        return frame(back() + placementHtml(data.placement));
      }
      if (page.route === 'upload') {
        data.upload = await api.uploadContext(page.spaceId, opts());
        data.uploadRecovery=readUploadRecovery();await refreshUploadRecovery();
        return frame(back() + uploadHtml(data.upload));
      }
      if (page.route === 'album') {
        data.viewer = await api.viewer(page.spaceId, opts());
        return frame(back() + albumHtml(data.viewer));
      }
      if (page.route === 'manage') {
        data.management = await api.management(page.spaceId, opts());
        return frame(back() + manageHtml(data.management));
      }
      data.me = await api.me(opts());
      data.spaces = (await api.spaces(opts())).spaces || [];
      return frame(heading('把我们，放在同一个地方', '建一个空间，邀请同行的人，把照片与原话留下。') + `<div class="ua-row"><span>已登录 · ${esc(data.me.identifiers?.[0]?.display_mask || data.me.emailMask || data.me.account?.emailMask || data.me.accountSettingsView?.emailMask || 'UNSEEN 账号')}</span>${button('logout','退出账号')}</div><form data-account-form="create"><label>新空间的名字<input name="name" required maxlength="80" placeholder="例如：夏天的那次相聚"></label><button type="submit">创建空间</button></form><div class="ua-space-list">${data.spaces.map(s => `<article class="ua-space"><h2>${esc(s.name)}</h2><p>${esc(s.photoCount ?? 0)} 张照片 · ${esc(s.isOwner || s.owner ? '我创建的' : '我参与的')}</p><div class="ua-row">${s.spaceLifecycle === 'archived' ? button('restore-space','恢复已归档空间',`data-space="${esc(s.id || s.spaceId)}"`) : button('album','看看现场',`data-space="${esc(s.id || s.spaceId)}"`)}${s.spaceLifecycle !== 'archived' && s.effectiveCanUpload ? button('upload','加入照片',`data-space="${esc(s.id || s.spaceId)}"`) : ''}${s.spaceLifecycle !== 'archived' && (s.isOwner || s.owner || s.managementScopes?.length) ? button('manage','管理空间',`data-space="${esc(s.id || s.spaceId)}"`) : ''}</div></article>`).join('') || '<p class="ua-empty">还没有空间。第一张共同的照片，可以从这里开始。</p>'}</div>`);
    } catch (error) {
      if (error.name === 'AbortError') return '';
      if (error.status === 401 && page.route === 'spaces') return frame(loginHtml());
      return frame(back() + heading('这里暂时没有打开') + `<p role="alert">${esc(errorCopy(error))}</p>` + button('refresh','重试'));
    }
  }
  function loginHtml() {
    return heading('登录，接着留下', '本机照片仍留在本机。只有你选择归入账号的内容，才会同步。') + `<form data-account-form="login"><label>邮箱<input type="email" name="email" autocomplete="email" required value="${esc(email)}" placeholder="you@example.com"></label>${challenge?.visual ? `<fieldset class="ua-captcha"><legend>${esc(challenge.visual.prompt)}</legend><div class="ua-tiles">${challenge.visual.tiles.map((tile,i) => `<button type="button" data-account-action="tile" data-tile="${i}" aria-pressed="${selection.has(i)}" aria-label="图形 ${i+1}"><svg viewBox="0 0 100 100" aria-hidden="true"><path d="${esc(tile.path)}" fill="${esc(tile.fill)}" transform="rotate(${Number(tile.rotate)||0} 50 50)"/></svg></button>`).join('')}</div></fieldset>` : ''}<button type="submit">${challenge ? '验证并获取邮箱验证码' : '获取邮箱验证码'}</button></form>${challengeId ? `<form data-account-form="verify"><label>邮箱验证码<input name="otp" autocomplete="one-time-code" inputmode="numeric" required pattern="[0-9]{6}" maxlength="6"></label><button type="submit">登录</button></form>` : ''}`;
  }
  function uploadHtml(context) {
    if(data.uploadRecovery)return heading('接着把照片留下')+recoveryHtml();
    return heading('把照片加入现场', '只上传你有权分享的照片；活动主人可以审核展示和确认位置。') + `<div class="ua-notice"><p>照片会逐张检查，并尝试定位到这个空间。GPS 和设备序列号会从展示副本移除。只有带时区、可信的原始拍摄时间会保留，用于照片、记忆与经你授权的成书来源；删除照片时也会清除。</p></div><form data-account-form="upload"><label>选择照片<input type="file" name="photos" accept="image/jpeg,image/png,image/webp" multiple required></label><label class="ua-check"><input type="checkbox" name="consent" required>我有权分享这些照片，并同意展示和位置处理。</label><button type="submit">确认并上传</button></form><div class="ua-upload-results"></div>`;
  }
  function albumHtml(view) {
    return heading(view.name || '共同现场', `${view.photos?.length || 0} 张照片记录`) + `<div class="ua-row">${button('scene','360 回到现场')}${button('refresh','更新相册')}${page.readOnly?'':button('upload','加入我的照片')+button('receipt','查看上传回执')}</div><div class="ua-photos">${(view.photos || []).map(p => photoCard(p, button('photo-scene','回到这张照片',`data-photo="${esc(p.id || p.photoId)}"`) + (page.readOnly?'':button('memory','留下这张的原话',`data-photo="${esc(p.id || p.photoId)}"`)))).join('') || '<p class="ua-empty">照片通过检查和授权后，会出现在这里。</p>'}</div>`;
  }
  function manageHtml(view) {
    const s = view.space || view;
    const owner = view.isOwner === true;
    return heading(s.name || '管理空间', '照片展示、位置、邀请和现场设置都在这里。') + `<div class="ua-row">${button('album','看相册')}${button('upload','加入照片')}${owner ? button('book','制作活动书') : ''}${button('refresh','更新处理状态')}</div>${owner ? `<details class="ua-panel"><summary>空间设置</summary><div class="ua-row">${button('collection',s.collectionState === 'open' ? '暂停收集' : '开放收集')}${button('sharing',s.sharingState === 'shared' ? '暂停分享' : '开放分享')}${button('approval',s.autoApproveUploads ? '改为主人审核' : '允许自动通过检查')}${button('archive',s.spaceLifecycle === 'archived' ? '恢复空间' : '归档空间')}</div><form data-account-form="wishes"><label>想收集些什么<textarea name="wishes" maxlength="2000">${esc((view.wishes || []).join('\n'))}</textarea></label><button>保存收集提示</button></form></details><details class="ua-panel"><summary>邀请朋友加入</summary><p>邀请仅授予所选范围。原话入书需要本人另外同意。</p><form data-account-form="invite"><label>邀请范围<select name="taskMode"><option value="combo">看现场并贡献照片</option><option value="view">只看现场</option><option value="upload">只贡献照片</option></select></label><label>有效天数<input name="days" type="number" min="1" max="30" value="7" required></label><label>可加入人数<input name="uses" type="number" min="1" max="1000" value="20" required></label><button>创建邀请</button></form><div class="ua-invite-result"></div>${(view.campaigns || []).map(c => `<div class="ua-invite"><p>${esc(status(c.campaignStatus))} · ${esc(c.successfulUseCount)} / ${esc(c.maxSuccessfulUses)} 人</p>${button('copy-invite','复制邀请',`data-campaign="${esc(c.id)}"`)}${c.campaignStatus === 'active' ? button('revoke','撤回邀请',`data-campaign="${esc(c.id)}"`) : ''}</div>`).join('')}</details><details class="ua-panel"><summary>更新 360 现场全景</summary><form data-account-form="panorama"><label>选择 2:1 全景照片<input type="file" name="panorama" accept="image/jpeg,image/png" required></label><button>上传并检查全景</button></form>${(view.panoramaCandidates || []).map(c => `<p>${esc(c.fileName)} · ${esc(status(c.status))} ${c.panoramaRevisionId === s.currentPanoramaRevisionId ? '<strong>当前现场</strong>' : c.status === 'ready' ? button('switch-panorama','设为当前现场',`data-candidate="${esc(c.id)}"`) : ''}</p>`).join('')}</details>` : ''}<h2>等待审核</h2><div class="ua-photos">${(view.reviewQueue || []).map(p => photoCard(p, button('approve','允许展示',`data-photo="${esc(p.id)}"`) + button('hide','暂不展示',`data-photo="${esc(p.id)}"`))).join('') || '<p>没有等待审核的照片。</p>'}</div><h2>确认照片位置</h2><div class="ua-photos">${(view.placementQueue || []).map(p => photoCard(p, button('placement','确认或调整位置',`data-photo="${esc(p.id)}"`))).join('') || '<p>没有等待确认的位置。</p>'}</div>`;
  }
  function placementHtml(view) {
    const candidates = view.suggestion?.candidates || view.candidates || view.placementSuggestion?.candidates || [];
    return heading('把照片放回现场', '系统提供候选方向，由你核对；也可以手动修正。') + (view.localFixture ? '<p class="ua-note">本地模拟定位候选，用于验收人工确认流程，不代表真实 AI 识别。</p>' : '') + photoCard(view) + button('placement-scene','先看看 360 现场') + `<div class="ua-row">${candidates.map(c => button('candidate',`确认方向 ${esc(c.yawDeg ?? c.yawDegrees ?? c.yaw ?? '')}°`,`data-candidate="${esc(c.candidateId || c.id)}"`)).join('')}</div><form data-account-form="placement"><label>水平朝向（-180° 至 180°）<input type="number" name="yaw" min="-180" max="180" step="0.1" value="${Number(view.sceneContext?.placement?.yawDeg ?? view.currentPlacement?.yawDeg ?? view.placement?.yawDeg ?? 0)}" required></label><label>俯仰角（-90° 至 90°）<input type="number" name="pitch" min="-90" max="90" step="0.1" value="${Number(view.sceneContext?.placement?.pitchDeg ?? 0)}" required></label><label>调整说明<input name="reason" value="由我核对现场后调整" maxlength="500" required></label><button>保存我确认的位置</button></form>${button('outside','这张不在这个现场')}`;
  }
  function receiptHtml(receipt) {
    return `<p>当前状态：${esc(status(receipt.status))}</p>${button('refresh','更新处理状态')}<div class="ua-photos">${(receipt.items || []).map(item => photoCard(item, item.photoId ? button('placement','查看或修正位置',`data-photo="${esc(item.photoId)}"`) + button('memory','留下原话',`data-photo="${esc(item.photoId)}"`) : `<p>${esc(status(item.status || item.state))} ${esc(item.failureCode)}</p>`)).join('')}</div>`;
  }
  async function repaint() { if (!root) return; const target = root; const open = [...root.querySelectorAll('details[open]')].map(el=>el.querySelector('summary')?.textContent); const html = await render(page); if (root === target && html) { root.innerHTML = html; for(const el of root.querySelectorAll('details')) if(open.includes(el.querySelector('summary')?.textContent)) el.open=true; bind(root); } }
  function bind(target) {
    binding?.abort(); binding = new AbortController(); root = target;
    target.addEventListener('click', click, { signal:binding.signal });
    target.addEventListener('error',event=>{const image=event.target;if(image.matches?.('.ua-photo img')){const fallback=document.createElement('div');fallback.className='ua-no-photo';fallback.setAttribute('role','status');fallback.textContent='这张照片暂时无法显示';image.replaceWith(fallback);}},{capture:true,signal:binding.signal});
    target.addEventListener('submit', submit, { signal:binding.signal });
    for(const field of target.querySelectorAll('form,input,textarea,select'))field.setAttribute('aria-describedby','ua-account-status');
    const title=target.querySelector('.ua-head h1');if(title){title.tabIndex=-1;title.focus({preventScroll:true});}
    if (page.route === 'book') void mountBook().catch(error => tell(errorCopy(error)));
  }
  async function mountBook() {
    const target = root?.querySelector('[data-account-book]'); if (!target) return;
    const ownGeneration = generation, mountSignal = aborter.signal;
    const [module, catalogResponse] = await Promise.all([import('/__book_lab_web__/src/integrated-shell.mjs'), fetch('/__book_lab_web__/catalog.json', { credentials:'same-origin', signal:aborter.signal })]);
    if (!catalogResponse.ok) throw { code:'book_lab_extension_unavailable' };
    const renderGenerationPaused = catalogResponse.headers.get("x-unseen-book-render-generation") === "paused";
    const catalog = await catalogResponse.json(); if (ownGeneration !== generation) return;
    const path = page.bookPath || `/manage/${id(page.spaceId)}/book-lab`;
    bookShell = module.createIntegratedBookLabVisualShell({ origin:location.origin, catalog,
      ...bookMountCallbacks({signal:mountSignal,isCurrent:()=>ownGeneration===generation&&Boolean(root),
        onPdf:response=>module.downloadIntegratedBookLabPdf(response),
        navigate:async destination=>{page.bookPath=destination;onBook?.({spaceId:page.spaceId,bookPath:destination});await bookShell.read(destination);}})
    });
    // Reuse canonical guards and actions, while replacing technical ID inputs with product controls.
    let availablePhotos=[];const bookTitles=new Map();
    if(page.spaceId){try{availablePhotos=(await api.viewer(page.spaceId,{signal:mountSignal})).photos || [];}catch{/* Existing book rights still decide every action. */}}
    if(page.spaceId){try{for(const book of (await request(`/v2-labs/owner/spaces/${id(page.spaceId)}/book-lab`,{signal:mountSignal})).books || [])bookTitles.set(book.bookId,book.title);}catch{/* Participant authorization does not imply owner access. */}}
    if(mountSignal.aborted||ownGeneration!==generation)return;
    const originalPaint=bookShell.paint.bind(bookShell);
    bookShell.paint=()=>{
      bookReaderResize?.disconnect(); bookReaderResize=null;
      originalPaint();
      const versionMatch=page.bookPath?.match(/^\/s\/([^/]+)\/books\/([^/]+)\/versions\/([^/]+)$/);
      if(versionMatch&&bookShell.view?.response?.ok){
        const version=bookShell.view.response.body.bookVersion || {};
        const download=target.querySelector('[data-book-action="BOOK.DOWNLOAD_PDF"]');if(download)download.textContent='下载这本书 · PDF';
        const reopen=target.querySelector('[data-book-action="BOOK.OPEN_PREVIEW"]');if(reopen)reopen.hidden=true;
        const header=target.querySelector('.page-header');
        if(header)header.innerHTML=`<h2>${esc(bookTitles.get(decodeURIComponent(versionMatch[2])) || '活动纪念册')}</h2><p>第 ${esc(version.ordinal || 1)} 版 · ${esc(version.pageCount || 0)} 页</p><a href="/manage/${esc(versionMatch[1])}/book-lab/${esc(versionMatch[2])}/draft">← 返回书稿</a>`;
        const metadata=target.querySelector('.reader-meta dl');
        if(metadata){const details=document.createElement('details');details.className='ua-panel';details.innerHTML='<summary>版本核对信息</summary>';metadata.replaceWith(details);details.append(metadata);}
        const view=bookShell.view,path=`/v2-labs/live/spaces/${id(decodeURIComponent(versionMatch[1]))}/books/${id(decodeURIComponent(versionMatch[2]))}/versions/${id(decodeURIComponent(versionMatch[3]))}/html`;
        void (async()=>{
          const response=await fetch(path,{credentials:'same-origin',cache:'no-store',signal:mountSignal});
          if(!response.ok)throw {code:'book_version_unavailable'};
          const html=await response.text(),digest=await sha(html);
          if(digest!==view.response.body.htmlArtifact?.contentHash||response.headers.get('etag')!==`"${digest}"`)throw {code:'book_artifact_integrity_failed'};
          if(ownGeneration!==generation||bookShell?.view!==view)return;
          const documentSource=new DOMParser().parseFromString(html,'text/html'),pages=[...documentSource.querySelectorAll('body > .book-page')];
          if(pages.length!==view.response.body.bookVersion?.pageCount)throw {code:'book_artifact_integrity_failed'};
          const host=document.createElement('section');host.className='ua-canonical-book';host.setAttribute('aria-label','已定稿的完整书页');
          const shadow=host.attachShadow({mode:'open'}),style=document.createElement('style');
          style.textContent=[...documentSource.querySelectorAll('head style')].map(s=>s.textContent).join('\n');
          if(/@import|url\s*\(/i.test(style.textContent))throw {code:'book_artifact_integrity_failed'};
          style.textContent+='\n:host{display:block;width:100%}.scaled-page{position:relative;width:100%;overflow:hidden;margin:0 0 16px}.book-page{transform-origin:top left}';shadow.append(style);
          for(const pageNode of pages){
            for(const unsafe of pageNode.querySelectorAll('script,iframe,object,embed,link,meta,form,svg,math'))unsafe.remove();
            for(const node of [pageNode,...pageNode.querySelectorAll('*')])for(const attribute of [...node.attributes]){
              if(/^on/i.test(attribute.name)||['href','srcset','style'].includes(attribute.name))node.removeAttribute(attribute.name);
              if(attribute.name==='src'&&!(node.tagName==='IMG'&&/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(attribute.value)))node.removeAttribute('src');
            }
            const wrap=document.createElement('div');wrap.className='scaled-page';wrap.append(document.importNode(pageNode,true));shadow.append(wrap);
          }
          target.append(host);
          style.textContent+='\n.scaled-page{height:auto!important}.book-page{width:100%;height:auto;min-height:600px;transform:none!important}.source-line,footer>span:first-child,.provenance-ribbon>span:nth-child(2){display:none}';

        })().catch(error=>{if(ownGeneration===generation)tell(errorCopy(error));});
      }
      const draftMatch=page.bookPath?.match(/^\/manage\/([^/]+)\/book-lab\/([^/]+)\/draft$/);
      if(draftMatch&&bookShell.view?.response?.ok&&['editing','preview_ready','preview_failed','stale'].includes(bookShell.view.response.body.status)){
        const view=bookShell.view,endpoint=`/v2-labs/owner/spaces/${id(decodeURIComponent(draftMatch[1]))}/books/${id(decodeURIComponent(draftMatch[2]))}/draft`;
        void request(`${endpoint}/sources`).then(result=>{
          if(ownGeneration!==generation||bookShell?.view!==view)return;
          target.querySelector('[data-book-assembly]')?.remove();
          const sources=result.sources || [],remaining=Math.max(0,5-sources.length);
          target.insertAdjacentHTML('afterbegin',`<section class="ua-panel" data-book-assembly><h2>把已授权的照片与原话加入书稿</h2><p>选择 5 至 7 张不同照片的授权原话。每份素材生成照片页和原话页，再加入封面与尾页，共 12 至 16 页。原文与署名保留，撤回授权后对应内容会失效。</p>${remaining?`<p role="status">还需要 ${remaining} 份不同照片的授权原话。当前书稿会保留，可以先继续收集。</p>`:''}<form data-account-form="assemble-book" aria-describedby="ua-account-status" data-endpoint="${esc(endpoint)}" data-version="${esc(view.response.etag)}">${sources.map((source,index)=>`<label class="ua-check"><input type="checkbox" name="grantIds" value="${esc(source.grantId)}" ${index<7?'checked':''}><span>${esc(source.creditLabel)} · ${esc(source.capturedAt)}<br>${esc(source.userText)}</span></label>`).join('')}<button type="submit" ${remaining?'disabled':''}>用选中素材更新书稿</button></form></section>`);
        }).catch(error=>{if(ownGeneration===generation)tell(errorCopy(error));});
      }
      const grant=(bookShell.view?.response?.body?.grantReceipts || []).find(grant=>grant.bookId===bookShell.view?.route?.parameters?.bookId&&grant.status==='active');
      if(grant){
        const title=bookTitles.get(grant.bookId) || '这本活动书';
        target.querySelector('.consent-card')?.insertAdjacentHTML('afterbegin',`<p role="status">已授权给《${esc(title)}》，署名为${esc(grant.creditLabel)}。你仍可撤回这本书的授权。</p>`);
        for(const node of target.querySelectorAll('.integrated-warning,[data-book-action="BOOK_MEMORY.AUTHORIZE"]'))node.hidden=true;
        for(const field of target.querySelectorAll('[data-book-field="creditLabel"],[data-book-field="consent"]'))field.closest('label').hidden=true;
        const bookSelect=target.querySelector('select[data-book-field="bookId"]');if(bookSelect)bookSelect.innerHTML=`<option value="${esc(grant.bookId)}">${esc(title)}</option>`;
        const ownStatus=root.querySelector('.ua-status');if(ownStatus)ownStatus.textContent='';
      }
      for(const book of bookShell.view?.response?.body?.eligibleBooks || [])if(book.currentTitle)bookTitles.set(book.bookId,book.currentTitle);
      for(const option of target.querySelectorAll('select[data-book-field="bookId"] option'))option.textContent=bookTitles.get(option.value) || '本次选择的活动书';
      for(const link of target.querySelectorAll('a[href^="/labs/books/"]')){const targetId=decodeURIComponent(new URL(link.href,location.origin).pathname.split('/')[3]);link.textContent=`加入 ${bookTitles.get(targetId) || '这本活动书'}`;}

      if(bookShell.view?.route?.screenId==='BL05'||draftMatch){
        const count=bookShell.view?.response?.body?.pages?.length;
        if(count===0){for(const node of target.querySelectorAll('[data-book-action="BOOK.REMOVE_PAGE"],[data-book-action="BOOK.REPLACE_PAGE_PHOTO"]'))node.hidden=true;target.querySelector('[data-book-field="displayPhotoId"]')?.closest('label')?.setAttribute('hidden','');}
        if(Number.isInteger(count)&&count<12){const preview=target.querySelector('[data-book-action="BOOK.GENERATE_PREVIEW"]');if(preview){preview.disabled=true;preview.title='先用 5 至 7 份独立授权素材组装书稿';}}
      }
      for(const field of target.querySelectorAll('input,textarea,select'))field.setAttribute('aria-describedby','ua-account-status');
      if(draftMatch&&['frozen','preview_queued'].includes(bookShell.view?.response?.body?.status))for(const action of ['BOOK.EDIT_TITLE','BOOK.REMOVE_PAGE','BOOK.REPLACE_PAGE_PHOTO','BOOK.GENERATE_PREVIEW']){const control=target.querySelector(`[data-book-action="${action}"]`);if(control)control.disabled=true;}
      if(draftMatch){
        target.insertAdjacentHTML('afterbegin',button('book-refresh','更新成书状态'));
        if(bookShell.view?.response?.body?.status==='frozen'){
          const description=target.querySelector('.page-header p:last-of-type');if(description)description.textContent='这一版已定稿，可以查看成品，或继续制作下一版。';
          const destination=frozenBookDestination(bookShell.view.response,decodeURIComponent(draftMatch[1]),decodeURIComponent(draftMatch[2]));
          const workbench=target.querySelector('.page-workbench');
          if(workbench)workbench.innerHTML=`<section class="ua-finished-book"><p class="ua-book-eyebrow">已定稿 · ${esc(bookShell.view.response.body.pages?.length ?? 0)} 页</p><h2>${esc(bookShell.view.response.body.title || '这本活动书')}</h2><p>照片、原话和署名已收进这个版本。打开后可以阅读完整书页，并下载 PDF。</p>${destination?`<a class="button ua-read-book" href="${esc(destination)}">查看已定稿版本 →</a><p class="microcopy">打开时会核对当前查看权限；内容授权撤回后，版本可能不可读。</p>`:'<p role="status">暂未取得定稿版本入口，请更新成书状态后重试。</p>'}</section>`;
          const controls=target.querySelector('.draft-controls');
          if(controls){
            const next=controls.querySelector('[data-book-action="BOOK.START_NEW_VERSION"]');
            controls.replaceChildren();
            if(next&&!next.disabled){const details=document.createElement('details');details.className='ua-panel';const summary=document.createElement('summary');summary.textContent='继续制作下一版';details.append(summary,next);controls.append(details);}
          }
        }
      }
      if(bookShell.view?.response?.ok){
        const books=bookShell.view.response.body.books;
        if(Array.isArray(books)){
          const completed=books.flatMap(book=>(book.completedVersions || []).filter(version=>version.status==='available'&&version.readerPath===`/s/${id(page.spaceId)}/books/${id(book.bookId)}/versions/${id(version.versionId)}`).map(version=>({book,version})));
          if(completed.length)target.insertAdjacentHTML('afterbegin',`<section class="ua-panel ua-completed-books"><h2>已完成的活动书</h2>${completed.map(({book,version})=>`<article><h3>${esc(book.title)}</h3><p>第 ${esc(version.ordinal)} 版 · ${esc(version.pageCount)} 页</p><a class="button ua-read-book" href="${esc(version.readerPath)}">阅读成品与下载 PDF →</a></article>`).join('')}</section>`);
        }
      }
      if(renderGenerationPaused){
        for(const control of target.querySelectorAll('[data-book-action="BOOK.GENERATE_PREVIEW"],[data-book-action="BOOK.FREEZE"]')){
          control.disabled=true;control.title='新的成书预览与 PDF 暂未开放';
        }
        if(draftMatch)target.insertAdjacentHTML('afterbegin','<p class="ua-panel" role="status">新的成书预览与 PDF 暂未开放。书稿可继续编辑，已有成品仍可阅读和下载。</p>');
      }
      const kindCopy={cover:'封面',multi_view:'照片页',memory:'原话页',closing:'尾页'};
      for(const node of target.querySelectorAll('.page-thumb'))for(const child of [...node.childNodes])if(child.nodeType===3&&kindCopy[child.textContent.trim()])child.textContent=kindCopy[child.textContent.trim()];
      for(const node of target.querySelectorAll('.integrated-book-choice small,.closing-draft small'))node.textContent=node.textContent.replace(/\b(frozen|editing|draft|preview_ready|preview_queued|preview_failed|stale)\b/g,value=>({frozen:'已定稿',editing:'编辑中',draft:'草稿',preview_ready:'预览已准备',preview_queued:'正在准备预览',preview_failed:'预览未完成',stale:'需更新内容'}[value]));
      for(const node of target.querySelectorAll('[data-book-action="BOOK.OPEN_DRAFT"]'))node.textContent='打开书稿';

      const issue=bookShell.view?.response?.body?.error?.code;
      if(issue==='book_version_unavailable'&&versionMatch){
        target.innerHTML=`<section class="ua-panel" role="status"><h2>这个版本暂时无法打开</h2><p>成品可能仍在准备，或查看权限已发生变化。可以更新状态；如果原话授权已撤回，这个版本将不再提供。</p><div class="ua-row"><button type="button" data-book-retry>更新成品状态</button><a class="button ua-read-book" href="/manage/${esc(versionMatch[1])}/book-lab/${esc(versionMatch[2])}/draft">返回书稿</a></div></section>`;
      }
      if(issue==='memory_unavailable'){const message=target.querySelector('[role=alert] p');if(message)message.textContent='当前照片尚未开放原话采集，或你没有这张照片的操作权限。你仍可返回现场继续查看。';}
      for(const link of target.querySelectorAll('a[href="/"]')){link.textContent='返回现场';link.href='#account-return';}
      const newId=target.querySelector('[data-book-field="newBookId"]');
      if(newId){newId.value=`book-${uuid()}`;newId.closest('label').hidden=true;}
      const replacement=target.querySelector('input[data-book-field="displayPhotoId"]');
      if(replacement){const select=document.createElement('select');select.dataset.bookField='displayPhotoId';select.innerHTML=availablePhotos.map(photo=>`<option value="${esc(photo.id || photo.photoId)}">${esc(photo.title || photo.fileName || '活动照片')}</option>`).join('');replacement.closest('label').firstChild.textContent='替换照片';replacement.replaceWith(select);}
      for(const node of target.querySelectorAll('.microcopy'))if(node.textContent.includes('填写右侧信息'))node.textContent='还没有书稿。填写书名，开始把共同的经历收在一起。';
      const create=target.querySelector('[data-book-action="BOOK.CREATE"]');
      const title=target.querySelector('[data-book-field="title"]');
      if(create&&title){title.placeholder='例如：夏天，我们一起';title.closest('aside')?.prepend(title.closest('label'));}
    };
    target.addEventListener('click', event => {
      if(event.target.closest('[data-book-action="BOOK_MEMORY.AUTHORIZE"]')){
        const consent=target.querySelector('[data-book-field="consent"]'),credit=target.querySelector('[data-book-field="creditLabel"]');
        if(!consent?.checked||!credit?.value.trim()){event.preventDefault();event.stopImmediatePropagation();tell(!consent?.checked?'请先勾选同意，只授权给当前这一本书。':'请填写你希望使用的署名。');return;}
      }
      const link = event.target.closest('a[href]'); if (!link) return; const path = new URL(link.href,location.origin).pathname;
      if(link.hash==='#account-return'){event.preventDefault();void nav({route:page.spaceId?'album':'spaces',spaceId:page.spaceId});return;}
      if (/^\/(?:labs\/|manage\/[^/]+\/book-lab|s\/[^/]+\/books\/)/.test(path)) { event.preventDefault(); page.bookPath = path; onBook?.({spaceId:page.spaceId,bookPath:path}); void bookShell.read(path).catch(error => tell(errorCopy(error))); }
    }, {signal:binding.signal});
    await bookShell.mount(target,path);
  }
  async function click(event) {
    const trigger = event.target.closest('[data-account-action]'); if (!trigger || !root.contains(trigger)) return;
    const action = trigger.dataset.accountAction;
    if(page.readOnly&&!['join','album','scene','photo-scene','refresh','case-return'].includes(action)){event.preventDefault();return;}
    if(action==='case-return')return await nav({route:'case-return',caseId:page.caseId});
    if (action === 'tile') { const n=Number(trigger.dataset.tile); selection.has(n)?selection.delete(n):selection.add(n); trigger.setAttribute('aria-pressed',String(selection.has(n))); return; }
    trigger.disabled = true;
    try {
      if (['spaces','album','manage','upload','placement','receipt'].includes(action)) return await nav({ route:action, spaceId:trigger.dataset.space || page.spaceId, photoId:trigger.dataset.photo });
      if(action==='book-refresh')return await bookShell?.reread();
      if(action==='refresh-upload'){await refreshUploadRecovery();return await repaint();}
      if(action==='close-upload'){if(data.batch?.status!=='finalized')throw {code:'upload_items_not_finished'};saveUploadRecovery(null);return await repaint();}
      if(action==='finalize-upload')return await finishUpload();
      if (action === 'cancel-reauth') {pendingReauth=null;root.querySelector('[data-reauth-panel]')?.remove();return;}
      if (action === 'restore-space') return await beginSpaceReauth(data.spaces.find(s=>(s.id || s.spaceId)===trigger.dataset.space),true);
      if (action === 'refresh') return await repaint();
      if (action === 'logout') { onSessionChange({phase:'start',action:'logout'}); await api.logout(opts()); onSessionChange({phase:'complete',action:'logout'}); for(const key of Object.keys(sessionStorage))if(key.startsWith('unseen.app.activity-upload.'))sessionStorage.removeItem(key);uploadFilesInMemory.clear();challengeId=null; challenge=null; onStatus('已退出账号'); return await nav({route:'login'}); }
      if (action === 'join') {
        const admission=await api.admitCampaign(page.inviteToken,opts());
        if(admission.destinationRoute)return await nav(resolveInvitationDestination(admission,{readOnly:page.readOnly}));
        const bootstrap=admission.invitationBootstrapUrlOnce || admission.invitationBootstrapUrl;
        const secret=bootstrap?new URL(bootstrap,location.origin).hash.match(/invite=([A-Za-z0-9_-]+)/)?.[1]:admission.inviteSecret;
        if(!secret)throw {code:'invitation_unavailable'};
        const result=await api.exchangeInvite(secret,opts());
        return await nav(resolveInvitationDestination(result,{readOnly:page.readOnly,spaceId:data.preview.spaceId}));
      }
      if (action === 'book' || action === 'memory') return await nav({route:'book',spaceId:page.spaceId,bookPath:action==='memory'?`/labs/memories/photos/${id(trigger.dataset.photo)}`:undefined});
      if (['scene','photo-scene','placement-scene'].includes(action)) {
        let scene = data.placement?.sceneContext;
        if (action === 'photo-scene') scene=await request(`/v1/viewer/spaces/${id(page.spaceId)}/photos/${id(trigger.dataset.photo)}/scene-context`);
        const revision=data.viewer?.scene?.currentPanoramaRevisionId || data.management?.space?.currentPanoramaRevisionId;
        if (!scene && !revision) throw {code:'scene_unavailable'};
        return await onViewer?.({readOnly:page.readOnly===true,caseId:page.caseId,spaceId:page.spaceId,scene,initialYaw:scene?.placement?.yawDeg,initialPitch:scene?.placement?.pitchDeg,panoramaUrl:scene?.panorama?.url || (revision?`/v1/viewer/spaces/${id(page.spaceId)}/panorama-revisions/${id(revision)}/media`:null),photo:data.viewer?.photos?.find(p=>p.id===trigger.dataset.photo)});
      }
      const management=data.management, space=management?.space;
      if(action === 'archive') return await beginSpaceReauth({...space,spaceId:page.spaceId},space.spaceLifecycle==='archived');
      if (['collection','sharing','approval'].includes(action)) {
        const endpoint=action==='approval'?'auto-approve-uploads-transitions':action==='archive'?(space.spaceLifecycle==='archived'?'unarchive':'archive'):`${action}-transitions`;
        const body=action==='collection'?{to:space.collectionState==='open'?'paused':'open'}:action==='sharing'?{to:space.sharingState==='shared'?'private':'shared'}:action==='approval'?{to:space.autoApproveUploads?'off':'on'}:{};
        await post(`/v1/spaces/${id(page.spaceId)}/${endpoint}`,body,space.ifMatch || space.version); return await repaint();
      }
      if(action==='copy-invite') {const campaign=management.campaigns.find(c=>c.id===trigger.dataset.campaign);return await copyInvite(campaign.publicCampaignUrl);}
      if(action==='revoke') { const campaign=management.campaigns.find(c=>c.id===trigger.dataset.campaign);await post(`/v1/external-invitation-campaigns/${id(campaign.id)}/revocations`,{reasonClass:'owner_revoked',clientRequestId:uuid()},campaign.ifMatch);return await repaint(); }
      if(action==='approve'||action==='hide') {const photo=management.reviewQueue.find(p=>p.id===trigger.dataset.photo);await post(`/v1/photos/${id(photo.id)}/content-transitions`,{to:action==='approve'?'visible':'hidden',transitionReasonCode:action==='approve'?'manual_approved':'manual_hidden',decisionReasonCode:action==='approve'?null:'safety_hold'},photo.ifMatch);return await repaint();}
      if(action==='switch-panorama') { const c=management.panoramaCandidates.find(c=>c.id===trigger.dataset.candidate);await post(`/v1/spaces/${id(page.spaceId)}/panorama-switches`,{mode:'switch',candidateRevisionId:c.panoramaRevisionId,sceneIfMatchVersion:space.scene.version},space.ifMatch);return await repaint(); }
      if(action==='candidate') {const p=data.placement;await post(`/v1/photos/${id(page.photoId)}/placement-revisions`,{mode:'candidate',suggestionId:p.suggestion?.suggestionId || p.suggestionId || p.placementSuggestion?.id,candidateId:trigger.dataset.candidate,confirmationMode:'manual'},p.ifMatch);return await repaint();}
      if(action==='outside') {await post(`/v1/photos/${id(page.photoId)}/placement-actions`,{action:'mark_outside_scene',reasonCode:'marked_outside_scene'},data.placement.ifMatch);return await repaint();}
    } catch(error) { if(error.name!=='AbortError') tell(errorCopy(error)); } finally { trigger.disabled=false; }
  }
  async function beginSpaceReauth(space,restore) {
    const targetId=space.spaceId || space.id;
    const scope={actionId:restore?'SPACE.RESTORE':'SPACE.ARCHIVE',purpose:restore?'space_restore':'space_archive',targetType:'space',targetId};
    const sent=await post('/v1/auth/reauth-challenges',{...scope,locale:'zh-CN'});
    pendingReauth={scope,challengeId:sent.challengeId,version:space.ifMatch || space.version,restore};
    root.querySelector('[data-reauth-panel]')?.remove();
    root.querySelector('.ua-surface').insertAdjacentHTML('afterbegin',`<section class="ua-panel" data-reauth-panel><h2>${restore?'恢复空间':'归档空间'}</h2><p>${restore?'恢复后仍暂停分享和收集，可以在设置中重新开放。':'归档后会暂停分享和收集，现有邀请会撤回。照片保留，可再次恢复空间。'}</p><form data-account-form="space-reauth"><label>再次验证邮箱<input name="otp" autocomplete="one-time-code" inputmode="numeric" required pattern="[0-9]{6}" maxlength="6" placeholder="输入邮箱验证码"></label><button>验证并${restore?'恢复':'归档'}</button>${button('cancel-reauth','取消')}</form></section>`);
    root.querySelector('[data-reauth-panel] input').focus();tell('验证邮件已发送。输入验证码后完成操作。');
  }
  async function copyInvite(path) { const token=new URL(path,location.origin).pathname.split('/').filter(Boolean).at(-1); const url=new URL(`/app?account=invite&invite=${encodeURIComponent(token)}`,location.origin).href; await navigator.clipboard.writeText(url); tell('邀请链接已复制，可由你分享给朋友。'); }
  async function submit(event) {
    if(page.readOnly){event.preventDefault();return;}
    const form=event.target.closest('[data-account-form]'); if(!form) return; event.preventDefault();
    const values=new FormData(form), trigger=form.querySelector('button[type="submit"],button:not([type])'); if(trigger) trigger.disabled=true;
    const action=form.dataset.accountForm;
    try {
      if(action==='assemble-book'){const grantIds=values.getAll('grantIds');if(grantIds.length<5||grantIds.length>7){tell('请选择 5 至 7 份不同照片的授权原话。');return;}await post(`${form.dataset.endpoint}/assembly`,{grantIds},form.dataset.version);await bookShell.reread();tell('已用授权素材更新书稿，现在可以生成预览。');return;}
      if(action==='retry-upload'){const index=Number(form.dataset.index),entry=data.uploadRecovery?.files[index],selected=values.get('photo');try{await sendRecoveredFile(index,selected?.size?selected:uploadFilesInMemory.get(entry?.clientId));}catch(error){if(entry){entry.error=error.code||'network_error';saveUploadRecovery(data.uploadRecovery);}throw error;}return await repaint();}
      if(action==='space-reauth') {
        if(!pendingReauth)throw {code:'reauth_challenge_unavailable'};
        const pending=pendingReauth;
        const verified=await post('/v1/auth/reauth-verifications',{...pending.scope,challengeId:pending.challengeId,otp:String(values.get('otp'))});
        await post(`/v1/spaces/${id(pending.scope.targetId)}/${pending.restore?'unarchive':'archive'}`,{reauthGrant:verified.reauthGrantSecret,...(pending.restore?{sharingState:'private',collectionState:'paused'}:{})},pending.version);
        pendingReauth=null;return await nav({route:'spaces'});
      }
      if(action==='login') {
        onSessionChange({phase:'start',action:'login'});
        email=String(values.get('email'));
        if(!challenge) {challenge=await api.challenge(opts());selection=new Set();if(challenge.visual){root.innerHTML=frame(loginHtml());return bind(root);}}
        tell('正在验证…');const proof=await solveAccountChallenge(challenge,opts());
        const sent=await api.requestCode(email,{...proof,...(challenge.visual?{verificationSelection:[...selection]}:{})},opts());challengeId=sent.challengeId;challenge=null;root.innerHTML=frame(loginHtml());bind(root);tell('验证码已发送，请查收邮箱。');return;
      }
      if(action==='verify'){onSessionChange({phase:'start',action:'verify'});const verified=await api.verifyCode(challengeId,String(values.get('otp')),opts());challengeId=null;challenge=null;if(verified.registration?.status==='pending'){root.innerHTML=frame(heading('申请已提交','账号正在等待管理员审核。批准后可重新获取验证码登录。')+button('login','返回登录'));bind(root);onStatus('账号等待审核，尚未登录');return;}onSessionChange({phase:'complete',action:'verify'});onStatus('已登录');return await nav({route:'spaces'});}
      if(action==='create'){const created=await post('/v1/spaces',{name:String(values.get('name'))});return await nav({route:'manage',spaceId:created.spaceId});}
      if(action==='invite') {const taskMode=String(values.get('taskMode'));const created=await post(`/v1/spaces/${id(page.spaceId)}/external-invitation-campaigns`,{taskMode,entryTask:taskMode==='upload'?'upload':'view',expiresAt:new Date(Date.now()+Number(values.get('days'))*86400000).toISOString(),maxSuccessfulUses:Number(values.get('uses'))},data.management.space.ifMatch);await repaint();return await copyInvite(created.publicCampaignUrl);}
      if(action==='wishes'){await request(`/v1/spaces/${id(page.spaceId)}/wishes`,{method:'PATCH',body:{wishes:String(values.get('wishes')).split('\n').map(s=>s.trim()).filter(Boolean)},version:data.management.space.ifMatch});return tell('收集提示已保存。');}
      if(action==='placement'){await post(`/v1/photos/${id(page.photoId)}/placement-revisions`,{mode:'manual',confirmationMode:'manual',yawDeg:Number(values.get('yaw')),pitchDeg:Number(values.get('pitch')),reason:String(values.get('reason'))},data.placement.ifMatch);tell('位置已保存。');return await repaint();}
      if(action==='upload') {if(values.get('consent')!=='on') throw {code:'consent_required'};const files=values.getAll('photos').filter(f=>f.size);return await uploadFiles(files);}
      if(action==='panorama') {const file=values.get('panorama');const created=await post(`/v1/spaces/${id(page.spaceId)}/panorama-candidates`,{declaredMime:file.type,declaredBytes:file.size,clientAssetId:uuid()},data.management.space.ifMatch);await putTicket(created,file);await post(`/v1/panorama-upload-sessions/${id(created.uploadSessionId)}/commits`,{clientRequestId:uuid()},created.uploadSessionIfMatch || created.ifMatch);tell('全景已上传，检查完成后可设为现场。');return await repaint();}
    } catch(error) {if(error.name!=='AbortError')tell(errorCopy(error));if(action==='login'&&error.code?.startsWith('otp_')){challenge=null;selection=new Set();}}finally{if(trigger)trigger.disabled=false;}
  }
  async function putTicket(envelope,file) {
    const ticket=envelope.oneTimeUploadTicket || envelope.exactPrivateUploadTicketOnce;
    const url=new URL(ticket?.url || envelope.uploadUrl,location.origin), exact=envelope.exactPrivateObjectKey || ticket?.exactPrivateObjectKey;
    if(!exact || !url.pathname.startsWith('/__local/media/') || !decodeURIComponent(url.pathname).endsWith(exact))throw {code:'upload_ticket_invalid'};
    const response=await fetch(url.pathname+url.search,{method:'PUT',headers:ticket?.headers || envelope.providerHeaders,body:file,credentials:'omit',signal:aborter.signal});
    if(!response.ok)throw {code:'upload_object_failed'};return response.headers.get('etag');
  }
  const recoveryKey = () => `unseen.app.activity-upload.${page.spaceId}`;
  let uploadFilesInMemory = new Map();
  function readUploadRecovery(){try{const value=JSON.parse(sessionStorage.getItem(recoveryKey()) || 'null');return value?.spaceId===page.spaceId&&Array.isArray(value.files)?value:null;}catch{return null;}}
  function saveUploadRecovery(value){data.uploadRecovery=value;try{if(value)sessionStorage.setItem(recoveryKey(),JSON.stringify(value));else sessionStorage.removeItem(recoveryKey());}catch{throw {code:'upload_recovery_storage_unavailable'};}}
  const fileDigest=async file=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('');
  function recoveryHtml(){
    const pending=data.uploadRecovery;if(!pending)return '';
    const complete=data.batch?.status==='finalized';
    return `<section class="ua-panel"><h2>${complete?'这次上传已完成':'接着完成这次上传'}</h2><p>本标签页只保留上传进度，不保存照片副本或上传凭证。刷新后需重新选择未完成的原文件。</p>${pending.files.map((file,index)=>{
      const item=data.batch?.items?.find(item=>(item.itemId || item.id)===file.itemId);const done=['committed','removed'].includes(item?.status);
      return `<article class="ua-invite"><strong>${esc(file.name)}</strong><p>${esc(status(item?.status || 'selected'))}${file.error?` · ${esc(errorCopy({code:file.error}))}`:''}</p>${!done&&!complete?`<form data-account-form="retry-upload" data-index="${index}"><label>重新选择这张原照片<input type="file" name="photo" accept="image/jpeg,image/png,image/webp" ${uploadFilesInMemory.has(file.clientId)?'':'required'}></label><button>继续上传这张</button></form>`:''}</article>`;
    }).join('')}<div class="ua-row">${button('refresh-upload','更新上传状态')}${complete?button('close-upload','开始下一次上传'):button('finalize-upload','完成本次上传并查看回执')}</div></section>`;
  }
  async function refreshUploadRecovery(){
    const pending=data.uploadRecovery || readUploadRecovery();if(!pending)return;
    data.uploadRecovery=pending;
    if(pending.batchId)data.batch=await request(`/v1/contribution-batches/${id(pending.batchId)}/result`);
  }
  async function ensureUploadBatch(pending){
    if(pending.batchId)return;
    const created=await request(`/v1/spaces/${id(page.spaceId)}/contribution-batches`,{method:'POST',body:pending.batchBody,version:pending.contextVersion,idempotencyKey:pending.batchKey});
    pending.batchId=created.batchId;saveUploadRecovery(pending);
  }
  async function sendRecoveredFile(index,file){
    const pending=data.uploadRecovery,entry=pending?.files[index];if(!entry||!file)throw {code:'upload_original_file_required'};
    if(file.size!==entry.size||file.type!==entry.type||await fileDigest(file)!==entry.sha256)throw {code:'upload_original_file_mismatch'};
    uploadFilesInMemory.set(entry.clientId,file);entry.error=null;saveUploadRecovery(pending);
    await ensureUploadBatch(pending);await refreshUploadRecovery();
    let item=data.batch.items.find(item=>(item.itemId || item.id)===entry.itemId);
    if(['committed','removed'].includes(item?.status))return;
    if(!entry.itemId){
      const created=await request(`/v1/contribution-batches/${id(pending.batchId)}/items`,{method:'POST',body:{clientItemId:entry.clientId,declaredMime:entry.type,declaredBytes:entry.size,fileNameHash:await sha(entry.name)},version:data.batch.ifMatch,idempotencyKey:entry.itemKey});
      entry.itemId=created.itemId;saveUploadRecovery(pending);await refreshUploadRecovery();item=data.batch.items.find(i=>(i.itemId || i.id)===entry.itemId);
    }
    // Save request identity, never its ticket. A lost response replays the same canonical operation.
    if(!entry.authorization || (item.status==='failed' && entry.authorization.failureVersion!==item.failureVersion)){
      entry.objectUploaded=false;entry.authorization={key:uuid(),clientUploadId:uuid(),retry:item.status==='failed',failureVersion:item.failureVersion,version:item.ifMatch};entry.commitKey=uuid();entry.commitId=uuid();saveUploadRecovery(pending);
    }
    const authSpec=entry.authorization;
    let auth=await request(`/v1/contribution-batches/${id(pending.batchId)}/items/${id(entry.itemId)}/upload-sessions`,{method:'POST',body:{declaredMime:entry.type,declaredBytes:entry.size,clientUploadId:authSpec.clientUploadId},version:authSpec.version,idempotencyKey:authSpec.key});
    if(auth.secretUnavailable){entry.authorization=null;saveUploadRecovery(pending);return await sendRecoveredFile(index,file);}
    if(!entry.objectUploaded){await putTicket(auth,file);entry.objectUploaded=true;saveUploadRecovery(pending);}
    await request(`/v1/upload-sessions/${id(auth.uploadSessionId)}/commits`,{method:'POST',body:{clientCommitId:entry.commitId},version:auth.commitIfMatch || auth.ifMatch,idempotencyKey:entry.commitKey});
    uploadFilesInMemory.delete(entry.clientId);entry.error=null;saveUploadRecovery(pending);await refreshUploadRecovery();
  }
  async function finishUpload(){
    const pending=data.uploadRecovery;if(!pending)throw {code:'batch_unavailable'};
    await ensureUploadBatch(pending);await refreshUploadRecovery();const result=data.batch;
    if(result.status==='finalized'&&!pending.finalization)throw {code:'receipt_recovery_required'};
    if(pending.files.some(file=>!file.itemId)||!result.items.length||result.items.some(item=>!['committed','failed','removed'].includes(item.status)))throw {code:'upload_items_not_finished'};
    pending.finalization ||= {key:uuid(),clientRequestId:uuid(),digest:result.itemsDigest,version:result.ifMatch};
    if(pending.finalization.digest!==result.itemsDigest)pending.finalization={key:uuid(),clientRequestId:uuid(),digest:result.itemsDigest,version:result.ifMatch};saveUploadRecovery(pending);
    const final=await request(`/v1/contribution-batches/${id(pending.batchId)}/finalizations`,{method:'POST',body:{itemsDigest:pending.finalization.digest,clientRequestId:pending.finalization.clientRequestId},version:pending.finalization.version,idempotencyKey:pending.finalization.key});
    if(!final.receiptSessionReady){const url=final.receiptBootstrapUrlOnce || final.batchReceiptBootstrapUrlOnce;const secret=url&&new URL(url,location.origin).hash.match(/receipt=([A-Za-z0-9_-]+)/)?.[1];if(!secret)throw {code:'receipt_unavailable'};await post('/v1/batch-receipt-exchanges',{receiptSecretFromClearedBootstrap:secret,clientNonce:uuid()});}
    saveUploadRecovery(null);return await nav({route:'receipt',spaceId:page.spaceId});
  }
  async function uploadFiles(files){
    const context=data.upload;if(data.uploadRecovery)throw {code:'upload_pending_batch'};
    if(!files.length||files.length>(context.limits?.batchItems || 24))throw {code:'upload_selection_invalid'};
    const notice=context.mediaNotice;if(!notice)throw {code:'media_notice_unavailable'};
    const entries=[];for(const file of files){const clientId=uuid();entries.push({clientId,itemKey:uuid(),name:file.name,type:file.type,size:file.size,sha256:await fileDigest(file)});uploadFilesInMemory.set(clientId,file);}
    const consent=await post('/v1/consent-events',{purpose:'photo_upload',noticeVersion:notice.version,noticeHash:notice.hash,mediaPolicyVersion:'2',choices:{display:true,placement:true}});
    const pending={spaceId:page.spaceId,files:entries,batchKey:uuid(),contextVersion:context.ifMatch,batchBody:{clientBatchId:uuid(),consentEventId:consent.consentEventId,declaredItemCount:entries.length}};saveUploadRecovery(pending);
    for(let index=0;index<files.length;index++){
      tell(`正在上传 ${index+1} / ${files.length}：${files[index].name}`);
      try{await sendRecoveredFile(index,files[index]);}catch(error){if(error.name==='AbortError')throw error;entries[index].error=error.code || 'network_error';saveUploadRecovery(pending);}
    }
    await refreshUploadRecovery();
    if(data.batch?.items.length===entries.length&&data.batch.items.every(item=>item.status==='committed'))return await finishUpload();
    await repaint();tell('有照片尚未完成。可逐张继续上传，也可在处理结束后完成本次上传。');
  }
  function destroy(){bookReaderResize?.disconnect();bookReaderResize=null;generation++;aborter.abort();binding?.abort();bookShell?.destroy();bookShell=null;root=null;}
  return {render,bind,destroy};
}
