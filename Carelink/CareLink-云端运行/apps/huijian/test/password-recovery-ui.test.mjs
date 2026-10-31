import test from 'node:test';
import assert from 'node:assert/strict';
import {mountMomentRecovery} from '../public/moment-recovery.js';
import {mountAdminRecovery} from '../public/admin-recovery.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function surface(t,handler){
 const previous=globalThis.FormData;globalThis.FormData=class{constructor(form){this.values=form.values;}get(key){return this.values[key]??null;}};
 t.after(()=>globalThis.FormData=previous);
 const events=new Map(),status={textContent:'',isConnected:true,focus(){}},requests=[];
 const root={innerHTML:'',contains:()=>true,querySelector:()=>status,querySelectorAll:()=>[],replaceChildren(){this.innerHTML='';},addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:(name)=>events.delete(name)};
 const api={async request(path,options){requests.push({path,options});return handler(path,options);}};
 return {root,api,requests,status,async submit(dataset,values={},decision){const form={dataset,values,querySelector:()=>status};await events.get('submit')({target:{closest:()=>form},preventDefault(){},stopPropagation(){},submitter:decision?{value:decision}:null});},async click(dataset){await events.get('click')({target:{closest:()=>({dataset,setAttribute(){}})},preventDefault(){},stopPropagation(){}});}};
}

test('recovery UI uses purpose-scoped endpoints, confirms password, and returns to login only after completion',async t=>{
 const ui=surface(t,path=>path==='/v1/auth/otp-verification-challenges'?{mode:'disabled'}:path==='/v1/auth/password-reset-challenges'?{accepted:true,challengeId:'otp-synthetic'}:{changed:true});
 let completed=0,closed=0;const app=mountMomentRecovery(ui.root,{api:ui.api,onComplete:()=>completed++,onClose:()=>closed++});t.after(()=>app.destroy());
 await ui.submit({recoveryForm:'send'},{email:'verified@example.test'});
 assert.deepEqual(ui.requests.map(r=>r.path),['/v1/auth/otp-verification-challenges','/v1/auth/password-reset-challenges']);
 assert.deepEqual(ui.requests[1].options.body,{email:'verified@example.test'});assert.match(ui.status.textContent,/如果邮箱已绑定/);
 await ui.submit({recoveryForm:'complete'},{email:'verified@example.test',otp:'123456',newPassword:'not-a-real-Synthetic-new-2026',confirmPassword:'not-a-real-different'});
 assert.equal(ui.requests.length,2);assert.match(ui.status.textContent,/不一致/);
 await ui.submit({recoveryForm:'complete'},{email:'verified@example.test',otp:'123456',newPassword:'中文密码',confirmPassword:'中文密码'});
 assert.equal(ui.requests[2].path,'/v1/auth/password-reset-completions');assert.equal(ui.requests[2].options.accountId,null);
 assert.equal(ui.requests[2].options.body.newPassword,'中文密码','12 UTF-8 bytes are valid even though fewer than 10 characters');
 assert.equal(completed,0);assert.match(ui.root.innerHTML,/密码已更新/);assert.doesNotMatch(ui.root.innerHTML,/not-a-real-Synthetic-new-2026/);
 await ui.click({recoveryAction:'complete'});assert.equal(completed,1);assert.equal(closed,0);
});

test('manual recovery UI proves the contact mailbox and submits a claim without granting a session',async t=>{
 const ui=surface(t,path=>path==='/v1/auth/otp-verification-challenges'?{mode:'disabled'}:path==='/v1/auth/recovery-contact-challenges'?{accepted:true,challengeId:'contact-synthetic'}:{accepted:true,requestId:'recovery-synthetic'});
 const app=mountMomentRecovery(ui.root,{api:ui.api});t.after(()=>app.destroy());await ui.click({recoveryAction:'mode'});
 const values={email:'contact@example.test',username:'account-owner',statement:'请通过线下核实身份后再决定是否批准这次申请。'};
 await ui.submit({recoveryForm:'send'},values);await ui.submit({recoveryForm:'complete'},{...values,otp:'123456'});
 assert.equal(ui.requests[1].path,'/v1/auth/recovery-contact-challenges');assert.equal(ui.requests[2].path,'/v1/auth/recovery-requests');
 assert.equal(ui.requests[2].options.body.username,'account-owner');assert.equal(ui.requests[2].options.body.challengeId,'contact-synthetic');
 assert.match(ui.root.innerHTML,/24 小时/);assert.match(ui.root.innerHTML,/不能取得恢复权限/);assert.ok(ui.requests.every(r=>!r.path.includes('password-login')));
});

test('closing recovery aborts pending verification and suppresses a late email request',async t=>{
 let resolve;const ui=surface(t,()=>new Promise(r=>resolve=r));const app=mountMomentRecovery(ui.root,{api:ui.api});
 const sending=ui.submit({recoveryForm:'send'},{email:'contact@example.test'});await tick();app.destroy();resolve({mode:'disabled'});await sending;
 assert.equal(ui.requests.length,1);assert.equal(ui.requests[0].options.signal.aborted,true);assert.equal(ui.root.innerHTML,'');
});

test('administrator UI escapes applicant text and blocks approval until identity was independently verified',async t=>{
 const row={id:'recovery-1',username:'owner',accountId:'acct-1',contactEmail:'contact@example.test',statement:'<script>untrusted()</script>',status:'pending',version:3};
 const ui=surface(t,()=>({requests:[row],total:1}));const app=mountAdminRecovery(ui.root,{api:ui.api});t.after(()=>app.destroy());await tick();
 assert.match(ui.root.innerHTML,/&lt;script&gt;/);assert.doesNotMatch(ui.root.innerHTML,/<script>/);
 const values={reason:'已通过独立线下见面核实注册约定，凭证定位为合成测试记录。'};
 await ui.submit({recoveryReview:row.id,version:'3'},values,'approve');assert.equal(ui.requests.length,1);assert.match(ui.status.textContent,/独立核实/);
 await ui.submit({recoveryReview:row.id,version:'3'},{...values,identityVerified:'on'},'approve');
 const write=ui.requests.find(r=>r.options.method==='POST');assert.equal(write.path,'/v1/admin/recovery-requests/recovery-1/review');
 assert.deepEqual(write.options.body,{decision:'approve',identityVerified:true,reason:values.reason,expectedVersion:3});
 assert.match(ui.status.textContent,/未自动发送通知/);
});
