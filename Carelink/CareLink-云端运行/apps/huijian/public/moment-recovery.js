import {solveAccountChallenge} from './unseen-account-api.js';
import {esc} from './moment-moderation.js';

const copy = error => ({authentication_failed:'验证码不正确、已失效，或当前账号不支持这次恢复。请重新获取验证码。',authentication_rate_limited:'尝试次数较多，请稍后再试。',authentication_busy:'正在处理其他验证，请稍后重试。',password_invalid:'新密码须为 10–256 个 UTF-8 字节；中文通常每字占 3 字节。',otp_delivery_unavailable:'邮件服务暂不可用，请稍后重试或联系管理员。',otp_verification_failed:'图形验证没有通过，请重新选择。',otp_pow_verification_failed:'图形验证没有通过，请重新选择。',otp_verification_unavailable:'当前验证方式暂不可用，请联系管理员。',otp_pow_solve_timeout:'验证超时，请重新获取。',validation_failed:'请检查邮箱和填写内容。',recovery_target_changed:'账号状态已改变，请联系管理员重新核实。'})[error.code] || '暂时未能完成，请检查网络后重试。';

export function mountMomentRecovery(root,{api,onClose=()=>{},onComplete=()=>{}}) {
  const controller=new AbortController();
  let mode='reset',email='',username='',statement='',challenge=null,challengeId=null,selection=new Set(),busy=false,done=false;
  const request=(path,body)=>{controller.signal.throwIfAborted();return api.request(path,{method:'POST',accountId:null,body,signal:controller.signal});};
  const status=message=>{const node=root.querySelector('[data-recovery-status]');if(node)node.textContent=message;};
  const captcha=()=>!challenge?.visual?'':`<fieldset><legend>${esc(challenge.visual.prompt)}</legend><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">${challenge.visual.tiles.map((tile,index)=>`<button type="button" data-recovery-tile="${index}" aria-pressed="${selection.has(index)}" aria-label="图形 ${index+1}" style="min-height:72px"><svg viewBox="0 0 100 100" width="56" height="56" aria-hidden="true"><path d="${esc(tile.path)}" fill="${esc(tile.fill)}" transform="rotate(${Number(tile.rotate)||0} 50 50)"/></svg></button>`).join('')}</div></fieldset>`;
  function render(){
    if(controller.signal.aborted)return;
    root.innerHTML=`<div data-recovery-surface><p>${mode==='reset'?'使用账号已验证的邮箱恢复密码。完成后所有旧登录都会退出，请用新密码重新登录。':'先验证你能收信的联系邮箱，再提交账号与情况说明。管理员会另行核实身份；申请本身不会授予账号权限。'}</p>${done?'<p role="status">密码已更新。请使用新密码登录。</p><button type="button" class="primary full" data-recovery-action="complete">返回登录</button>':`<form data-recovery-form="${challengeId?'complete':'send'}"><label class="field">${mode==='reset'?'已验证的邮箱':'联系邮箱'}<input name="email" type="email" autocomplete="email" required maxlength="254" value="${esc(email)}" ${challengeId?'readonly':''}></label>${mode==='manual'?`<label class="field">要恢复的账号<input name="username" autocomplete="username" required minlength="3" maxlength="32" value="${esc(username)}"></label><label class="field">情况说明<textarea name="statement" minlength="10" maxlength="2000" required rows="4" placeholder="说明可以由管理员独立核实的情况，请勿填写密码、验证码或证件原件。">${esc(statement)}</textarea></label>`:''}${challengeId?`<label class="field">邮箱验证码<input name="otp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label>${mode==='reset'?'<label class="field">新密码<input type="password" name="newPassword" autocomplete="new-password" maxlength="256" required></label><label class="field">再次输入新密码<input type="password" name="confirmPassword" autocomplete="new-password" maxlength="256" required></label>':''}`:captcha()}<button type="submit" class="primary full">${challengeId?(mode==='reset'?'验证并更新密码':'验证并提交人工恢复申请'):(challenge?'验证并获取邮箱验证码':'获取邮箱验证码')}</button></form>${challengeId?'<button type="button" class="text-button full" data-recovery-action="resend">重新获取验证码</button>':''}<button type="button" class="text-button full" data-recovery-action="mode">${mode==='reset'?'账号未绑定邮箱？申请人工恢复':'已有已验证邮箱？返回密码恢复'}</button>`}<p class="form-status" data-recovery-status role="status" aria-live="polite"></p><button type="button" class="text-button full" data-recovery-action="close">返回登录</button></div>`;
    root.querySelector('input:not([readonly]),button')?.focus();
  }
  async function submit(event){
    const form=event.target.closest('[data-recovery-form]');if(!form||!root.contains(form))return;
    event.preventDefault();event.stopPropagation();if(busy)return;
    const values=new FormData(form);email=String(values.get('email')||'').trim();
    if(mode==='manual'){username=String(values.get('username')||'').trim();statement=String(values.get('statement')||'').trim();}
    busy=true;root.querySelectorAll('button').forEach(button=>button.disabled=true);
    try{
      if(form.dataset.recoveryForm==='send'){
        if(!challenge){challenge=await request('/v1/auth/otp-verification-challenges',{});selection=new Set();if(challenge.visual){render();status('请选择符合提示的图形，再获取验证码。');return;}}
        status('正在验证…');const proof=await solveAccountChallenge(challenge,{signal:controller.signal});
        const sent=await request(mode==='reset'?'/v1/auth/password-reset-challenges':'/v1/auth/recovery-contact-challenges',{email,...proof,...(challenge.visual?{verificationSelection:[...selection]}:{})});
        challengeId=sent.challengeId;challenge=null;render();status(mode==='reset'?'如果邮箱已绑定可恢复账号，或人工申请已获批准，将收到 10 分钟内有效的验证码。':'验证码已发送到联系邮箱，10 分钟内有效。');
      }else if(mode==='reset'){
        const password=String(values.get('newPassword')||''),bytes=new Blob([password]).size;
        if(bytes<10||bytes>256){status(copy({code:'password_invalid'}));return;}
        if(password!==String(values.get('confirmPassword')||'')){status('两次输入的新密码不一致。');return;}
        await request('/v1/auth/password-reset-completions',{challengeId,otp:String(values.get('otp')||''),newPassword:password});done=true;render();
      }else{
        const result=await request('/v1/auth/recovery-requests',{username,challengeId,otp:String(values.get('otp')||''),statement});
        root.innerHTML=`<p>联系邮箱已验证。如账号符合人工恢复条件，管理员会收到申请并独立核实身份。</p><p>请记下申请编号：<strong>${esc(result.requestId)}</strong>。与管理员核实后，若获批准，请在批准后的 24 小时内返回「已验证邮箱恢复」，用同一联系邮箱获取新的重置验证码。</p><p>仅凭账号名、这段说明或申请编号，都不能取得恢复权限。管理员不会要求你提供密码。</p><button type="button" class="primary full" data-recovery-action="reset">返回密码恢复</button><button type="button" class="text-button full" data-recovery-action="close">返回登录</button>`;
      }
    }catch(error){if(error.name!=='AbortError'&&!controller.signal.aborted){if(!challengeId){challenge=null;selection=new Set();render();}status(copy(error));}}
    finally{busy=false;if(!controller.signal.aborted)root.querySelectorAll('button').forEach(button=>button.disabled=false);}
  }
  function click(event){
    const button=event.target.closest('[data-recovery-action],[data-recovery-tile]');if(!button||!root.contains(button))return;
    event.preventDefault();event.stopPropagation();if(busy)return;
    if(button.dataset.recoveryTile!==undefined){const index=Number(button.dataset.recoveryTile);selection.has(index)?selection.delete(index):selection.add(index);button.setAttribute('aria-pressed',String(selection.has(index)));return;}
    const action=button.dataset.recoveryAction;
    if(action==='close'){onClose();return;}if(action==='complete'){onComplete();return;}
    if(action==='mode')mode=mode==='reset'?'manual':'reset';if(action==='reset')mode='reset';
    challengeId=null;challenge=null;done=false;selection=new Set();render();
  }
  root.addEventListener('submit',submit);root.addEventListener('click',click);render();
  return {destroy(){controller.abort();root.removeEventListener('submit',submit);root.removeEventListener('click',click);root.replaceChildren();}};
}
