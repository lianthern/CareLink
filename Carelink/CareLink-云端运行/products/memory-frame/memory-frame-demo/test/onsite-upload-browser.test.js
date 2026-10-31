'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs/promises'), os=require('node:os'), path=require('node:path');
const {createApp}=require('../server/server');
const {LocalStore}=require('../server/store');
test('onsite upload: real mobile browser to frame, private guest scope, lost-response recovery at quota and admin QR', {
  skip:!process.env.AI_UX_PLAYWRIGHT || !process.env.AI_UX_CHROME, timeout:90000
},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'onsite-browser-'));
  const app=await createApp({store:new LocalStore(dir),setupCode:'local-browser-setup'});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+app.server.address().port;
  const {chromium}=require(process.env.AI_UX_PLAYWRIGHT);
  const browser=await chromium.launch({executablePath:process.env.AI_UX_CHROME,headless:true});
  t.after(async()=>{await browser.close();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));await fs.rm(dir,{recursive:true,force:true});});
  const owner=await app.api('create',{setupCode:'local-browser-setup',name:'测试相框',nickname:'管理员'});
  const pair=await app.api('invite',{role:'frame'},owner.token);
  const frameSession=await app.api('join',{invite:pair.invite,nickname:'测试平板'});
  const link=await app.api('uploadInvite',{label:'现场相框',limit:1},owner.token);
  const errors=[];
  const frameContext=await browser.newContext({viewport:{width:1180,height:820}});
  await frameContext.addInitScript(s=>localStorage.setItem('memory-session-frame',JSON.stringify(s)),frameSession);
  const frame=await frameContext.newPage(); frame.on('pageerror',e=>errors.push(e.message));
  await frame.goto(origin+'/frame');await frame.locator('#roomName').waitFor();
  const guestContext=await browser.newContext({viewport:{width:390,height:844}});
  const guest=await guestContext.newPage();guest.on('pageerror',e=>errors.push(e.message));
  await guest.goto(origin+'/contribute?invite='+link.invite);await guest.locator('#uploadForm').waitFor({state:'visible'});
  for(const width of [320,390,768]) {await guest.setViewportSize({width,height:844});assert.equal(await guest.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
  await guest.setViewportSize({width:390,height:844});
  const image=await guest.evaluate(()=>{const c=document.createElement('canvas');c.width=600;c.height=400;const x=c.getContext('2d');x.fillStyle='#a9d3f3';x.fillRect(0,0,600,400);x.fillStyle='#57537c';x.font='36px sans-serif';x.fillText('Local upload verification',50,200);return c.toDataURL().split(',')[1];});
  const file={name:'verification.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')};
  await guest.locator('#nickname').fill('现场访客测试');await guest.locator('#note').fill('扫码上传测试');await guest.locator('#photos').setInputFiles(file);
  if(process.env.AI_UX_SCREENSHOTS){await fs.mkdir(process.env.AI_UX_SCREENSHOTS,{recursive:true});await guest.screenshot({path:path.join(process.env.AI_UX_SCREENSHOTS,'onsite-mobile.png'),fullPage:true});}
  let lost=false;
  await guest.route('**/api',async route=>{
    const data=route.request().postDataJSON();
    if(data.action==='send'&&!lost){lost=true;await route.fetch();return route.abort('failed');}
    return route.continue();
  });
  await guest.locator('#sendPhotos').click();await guest.locator('#error').waitFor({state:'visible'});
  assert.ok(lost);assert.equal((await app.api('state',{},owner.token)).messages.length,1);
  // Refresh after the server accepted a send but its HTTP response was lost.
  await guest.reload();await guest.locator('#uploadForm').waitFor({state:'visible'});
  assert.match(await guest.locator('#notice').textContent(),/名额已满/);
  await guest.locator('#photos').setInputFiles([file,file]);await guest.locator('#sendPhotos').click();
  await guest.waitForFunction(()=>document.querySelector('#resultList').textContent.includes('相框已收到'));
  await guest.waitForFunction(()=>document.querySelectorAll('#resultList .received').length===2);
  const state=await app.api('state',{},owner.token);assert.equal(state.messages.length,1);assert.equal(state.messages[0].name,'现场访客测试');
  await frame.waitForFunction(()=>document.querySelector('#caption').textContent.includes('现场访客测试'));
  assert.equal(state.members.some(m=>m.role==='contributor'),false);
  const forbidden=await guest.evaluate(async()=>{const invite=new URLSearchParams(location.search).get('invite');const saved=JSON.parse(localStorage.getItem('unseen-onsite:'+invite));const post=async(action,data={},token)=>fetch('/api',{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify({action,data})});const session=await(await post('uploadJoin',{invite,visitor:saved.visitor})).json();return(await post('state',{},session.token)).status;});assert.equal(forbidden,403);
  if(process.env.AI_UX_SCREENSHOTS){await guest.screenshot({path:path.join(process.env.AI_UX_SCREENSHOTS,'onsite-delivered.png'),fullPage:true});await frame.screenshot({path:path.join(process.env.AI_UX_SCREENSHOTS,'onsite-frame.png'),fullPage:true});}
  const adminContext=await browser.newContext({viewport:{width:390,height:844}});
  await adminContext.addInitScript(s=>localStorage.setItem('memory-session-family',JSON.stringify(s)),owner);
  const admin=await adminContext.newPage();await admin.goto(origin+'/family');await admin.locator('#mineTab').click();await admin.locator('#invite').click();await admin.locator('#uploadInvite').click();
  await admin.locator('#closeUploadInvite').waitFor({state:'visible'});assert.match(await admin.locator('.invite-link').textContent(),/contribute/);
  await admin.locator('#closeUploadInvite').click();await admin.waitForFunction(()=>document.querySelector('#inviteResult').textContent.includes('已关闭'));
  assert.deepEqual(errors,[]);
});
