import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {esc,statusLabel,snapshotHtml,moderationError as sharedModerationError} from '../public/moment-moderation.js';
const source=(await fs.readFile(new URL('../public/admin.js',import.meta.url),'utf8')).replace(/^import .*\n/gm,'').replace(/boot\(\);\s*$/,'');
function harness(handler){
 const events=new Map(),nodes=new Map(),requests=[];
 function node(){let html='';return {get innerHTML(){return html;},set innerHTML(value){html=value;this.children=value?[{}]:[];},children:[],inert:false,replaceChildren(){this.innerHTML='';},querySelector:()=>({focus(){}}),addEventListener(){}};}
 const document={activeElement:null,querySelector(key){if(!nodes.has(key))nodes.set(key,node());return nodes.get(key);},addEventListener(type,fn){events.set(type,fn);}};
 class MomentApi{async request(path,options){requests.push({path,options});return handler(path,options);}}
 const context=vm.createContext({MomentApi,esc,statusLabel,snapshotHtml,sharedModerationError,document,URLSearchParams,AbortController,console});
 vm.runInContext(source+`;user={id:'admin',adminRole:'super_admin',capabilities:{canManageRoles:true,canInspectPrivateData:true,canViewFullEmails:true,canManageAccounts:true,canReviewSubmissions:true,canViewOperationalAudit:true,canReviewRecoveryRequests:true}};globalThis.h={openInspection,close,emailHtml,privateMediaUrl,inspectionMomentHtml,getState:()=>({inspection,detail,busy})};`,context);
 return {h:context.h,requests,html:()=>nodes.get('#admin-dialog').innerHTML,click:dataset=>events.get('click')({target:{closest:()=>({dataset,disabled:false,isConnected:false})}})};
}
test('account inspection click navigation uses paginated GETs and returns to the same list page',async()=>{
 const app=harness(async path=>path.endsWith('/moments/m1')?{targetAccountId:'a1',moment:{id:'m1',title:'私人原话',photos:[],messages:[]},version:7}:path.includes('/moments?')?{moments:[{id:'m1',title:'回忆',photoCount:1,messageCount:2,hasAudio:true}],total:21,page:2,pageSize:20}:{account:{id:'a1',email:'person@example.test',status:'active'}});
 await app.click({action:'account-moments',accountId:'a1',page:'2'});assert.equal(app.h.getState().inspection.page,2);assert.match(app.html(),/第 2 页/);
 await app.click({action:'inspect-moment',accountId:'a1',momentId:'m1',page:'2'});assert.equal(app.h.getState().inspection.kind,'moment');assert.match(app.html(),/不是投稿快照/);assert.doesNotMatch(app.html(),/data-form="decision"/);
 await app.click({action:'account-moments',accountId:'a1',page:'2'});assert.match(app.requests.at(-1).path,/page=2/);
 await app.click({action:'inspection-account',accountId:'a1'});assert.equal(app.h.getState().detail.id,'a1');assert.match(app.html(),/person@example.test/);
 assert.ok(app.requests.every(x=>!x.options?.method||x.options.method==='GET'));
});
test('inspection retry recovers and closing a pending read aborts it without resurrecting the dialog',async()=>{
 let fail=true,release;
 const app=harness(async(path,{signal})=>{if(fail)throw {status:503,code:'network_error'};return new Promise(resolve=>{release=()=>resolve({moments:[],total:0,page:1});});});
 await app.click({action:'account-moments',accountId:'a1'});assert.match(app.html(),/重新读取/);fail=false;
 const pending=app.click({action:'inspection-retry'});assert.equal(app.requests.length,2);await app.click({action:'close'});assert.equal(app.requests.at(-1).options.signal.aborted,true);release();await pending;assert.equal(app.html(),'');assert.equal(app.h.getState().inspection,null);
});
test('late inspection response cannot overwrite a newer route',async()=>{
 let resolveFirst;const app=harness(async path=>path.includes('page=1')?new Promise(resolve=>resolveFirst=resolve):{moments:[],page:2,total:21});
 const first=app.click({action:'account-moments',accountId:'a1',page:'1'});await app.click({action:'account-moments',accountId:'a1',page:'2'});resolveFirst({moments:[{id:'old',title:'旧响应'}],page:1,total:21});await first;assert.equal(app.h.getState().inspection.page,2);assert.doesNotMatch(app.html(),/旧响应/);
});
test('private media permits only the current account and moment; original and audio are rendered safely',()=>{
 const app=harness(()=>{}),route={kind:'moment',accountId:'a1',momentId:'m1',page:1},valid='/v1/admin/accounts/a1/moments/m1/media/p1';
 for(const value of ['/v1/admin/accounts/a2/moments/m1/media/p1','/v1/admin/accounts/a1/moments/m2/media/p1',valid+'?token=x',valid+'/../../bad','https://outside.test/photo'])assert.equal(app.h.privateMediaUrl(value,'a1','m1'),'');
 assert.equal(app.h.privateMediaUrl(valid+'/preview','a1','m1'),valid+'/preview');
 const html=app.h.inspectionMomentHtml({moment:{photos:[{url:valid+'/preview',originalUrl:valid}],messages:[{role:'user',text:'<script>bad()</script>长原话',audio:{url:valid}}]},version:2},route);
 assert.match(html,/照片 1 原件/);assert.match(html,/audio controls preload="none"/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
 assert.doesNotMatch(snapshotHtml({photos:[{url:valid}]}),/src=/,'default submission renderer must keep refusing private media');
});
test('email distinguishes unavailable from unbound and escapes multiple full addresses',()=>{
 const app=harness(()=>{});assert.equal(app.h.emailHtml({email:null,emails:[]}), '未绑定');assert.doesNotMatch(app.h.emailHtml({emailUnavailable:true}),/未绑定/);assert.match(app.h.emailHtml({emailUnavailable:true}),/暂不可读取/);
 const html=app.h.emailHtml({emails:[{email:'first@example.test',verifiedAt:'2026-09-06'},{email:'<second>@example.test'}]},true);assert.match(html,/first@example.test/);assert.match(html,/&lt;second&gt;/);assert.match(html,/验证时间/);
});
test('a wrong-owner detail response is refused before rendering private text',async()=>{
 const app=harness(async()=>({targetAccountId:'other-account',moment:{id:'m1',title:'不应显示的内容'},version:1}));
 await app.click({action:'inspect-moment',accountId:'a1',momentId:'m1'});assert.match(app.html(),/与当前选择不一致/);assert.doesNotMatch(app.html(),/不应显示的内容/);
});
