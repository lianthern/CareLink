import {esc} from './moment-moderation.js';
const date=value=>value?new Date(value).toLocaleString('zh-CN'):'未处理';
const label=value=>({pending:'待核实身份',approved:'已批准恢复',rejected:'已拒绝',completed:'已完成恢复'})[value]||value;
export function mountAdminRecovery(root,{api}) {
  const controller=new AbortController();let page=1,busy=false,requestVersion=0;
  const request=(path,options={})=>api.request(path,{...options,signal:controller.signal});
  const tell=message=>{const node=root.querySelector('[data-recovery-notice]');if(node)node.textContent=message;};
  async function load(){
    const version=++requestVersion;
    root.innerHTML='<p role="status">正在读取人工恢复申请…</p>';
    try{
      const data=await request(`/v1/admin/recovery-requests?page=${page}&pageSize=20`);
      if(controller.signal.aborted||version!==requestVersion)return;
      root.innerHTML=`<section class="panel"><h2>账号人工恢复</h2><p class="notice">邮箱验证码只证明申请人能收信。必须另行核实其持有目标账号，记录核实方式、时间和可复核依据，才能批准；无法核实就拒绝。禁止仅凭账号名、申请说明或申请编号批准。审批不会显示或设置密码。</p><p data-recovery-notice role="status"></p>${data.requests.length?data.requests.map(row=>`<article class="panel"><h3>${esc(row.username||row.accountId)} · ${esc(label(row.status))}${row.approvalExpired?'（资格已过期）':''}</h3><p>申请编号：${esc(row.id)}<br>账号 ID：${esc(row.accountId)}<br>联系邮箱：${esc(row.contactEmail)}<br>邮箱验证：${date(row.contactVerifiedAt)}<br>申请时间：${date(row.createdAt)}</p><blockquote>${esc(row.statement)}</blockquote>${row.status==='pending'?`<form data-recovery-review="${esc(row.id)}" data-version="${row.version}"><label class="field">核实依据或拒绝原因<textarea name="reason" minlength="20" maxlength="1000" rows="4" required placeholder="记录独立核实方式、时间和凭据定位信息。不要复制密码、验证码或证件原件。"></textarea></label><label><input type="checkbox" name="identityVerified">我已独立核实申请人持有此账号，并确认将使用上方联系邮箱恢复</label><p class="muted">批准后有 24 小时获取新验证码并设置密码；成功后绑定联系邮箱并退出所有旧会话。请通过已核实的联系渠道告知申请人结果。此处不会自动发送通知。</p><div class="actions"><button name="decision" value="approve" class="primary">批准恢复资格</button><button name="decision" value="reject">拒绝申请</button></div><p data-review-status role="status"></p></form>`:`<p>处理时间：${date(row.reviewedAt)}<br>资格截止：${date(row.approvalExpiresAt)}<br>核实记录：${esc(row.reviewReason||'—')}</p>`}</article>`).join(''):'<p>暂无人工恢复申请。</p>'}<div class="pager"><span>共 ${data.total} 条 · 第 ${page} 页</span><button type="button" data-recovery-page="-1" ${page<=1?'disabled':''}>上一页</button><button type="button" data-recovery-page="1" ${page*20>=data.total?'disabled':''}>下一页</button><button type="button" data-recovery-page="0">刷新</button></div></section>`;
    }catch(error){if(error.name!=='AbortError'&&version===requestVersion){root.innerHTML='<p class="notice error" data-recovery-notice role="status"></p>';tell(error.status===403?'管理员权限已撤销，请重新登录。':error.status===401?'登录已失效，请重新登录。':'读取失败，请使用后台刷新重试。');}}
  }
  async function submit(event){
    const form=event.target.closest('[data-recovery-review]');if(!form||!root.contains(form))return;event.preventDefault();event.stopPropagation();if(busy)return;
    const values=new FormData(form),decision=event.submitter?.value,verified=values.get('identityVerified')==='on',status=form.querySelector('[data-review-status]');
    if(!['approve','reject'].includes(decision))return;
    if(decision==='approve'&&!verified){status.textContent='只有独立核实账号身份后才能批准；无法核实请选择拒绝。';return;}
    busy=true;const buttons=[...root.querySelectorAll('button')].map(button=>[button,button.disabled]);buttons.forEach(([button])=>button.disabled=true);status.textContent='正在保存决定…';
    try{await request(`/v1/admin/recovery-requests/${encodeURIComponent(form.dataset.recoveryReview)}/review`,{method:'POST',body:{decision,identityVerified:verified,reason:String(values.get('reason')||'').trim(),expectedVersion:Number(form.dataset.version)}});await load();tell('决定已记录。请通过已核实的联系渠道告知申请人；未自动发送通知。');}
    catch(error){if(error.name!=='AbortError'&&status.isConnected)status.textContent=error.status===409?'申请或账号已变化，请刷新并重新核实。':error.code==='identity_verification_required'?'请完成独立身份核实。':'保存失败，请核对填写内容及管理员权限。';}
    finally{busy=false;if(!controller.signal.aborted)buttons.forEach(([button,disabled])=>{if(button.isConnected)button.disabled=disabled;});}
  }
  async function click(event){const button=event.target.closest('[data-recovery-page]');if(!button||!root.contains(button))return;event.preventDefault();event.stopPropagation();if(busy)return;page=Math.max(1,page+Number(button.dataset.recoveryPage));await load();}
  root.addEventListener('submit',submit);root.addEventListener('click',click);load();
  return {destroy(){controller.abort();root.removeEventListener('submit',submit);root.removeEventListener('click',click);root.replaceChildren();}};
}
