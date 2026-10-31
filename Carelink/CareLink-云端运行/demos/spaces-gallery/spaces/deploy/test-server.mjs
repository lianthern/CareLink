// Usage: node spaces/deploy/test-server.mjs https://spaces.maxxam.xyz/spaces/ output-prefix
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
const [base,out]=process.argv.slice(2),results={base,gallery:{},scenes:[],photos:[],errors:[]};
const browser=await chromium.launch({...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chrome'}),headless:true,...(process.env.SPACE_TEST_RESOLVE?{args:['--host-resolver-rules=MAP spaces.maxxam.xyz '+(process.env.SPACE_TEST_IP||'43.132.167.200')]}:{} )});
const persist=()=>writeFile(out+'.json',JSON.stringify(results,null,2));
try{
 const ctx=await browser.newContext({viewport:{width:1440,height:1000}}),page=await ctx.newPage();
 page.on('pageerror',e=>results.errors.push(e.message));
 page.on('response',r=>{if(r.status()>=400)results.errors.push(r.status()+': '+r.url());});
 await page.goto(base);
 await page.waitForFunction(()=>document.querySelectorAll('.card').length===8);
 results.gallery.cards=await page.locator('.card').count();
 results.gallery.modelRequests=await page.evaluate(()=>performance.getEntriesByType('resource').filter(r=>r.name.includes('.sog')).length);
 assert.equal(results.gallery.modelRequests,0);
 await page.screenshot({path:out+'-gallery.png',fullPage:true});
 await page.locator('#search').fill('咖啡');assert.equal(await page.locator('.card').count(),1);
 await page.locator('#search').fill('');
 for(const kind of ['video','360','sequence','model','all']){await page.locator(`[data-kind="${kind}"]`).click();assert.ok(await page.locator('.card').count()>0);}
 const catalog=await page.evaluate(async url=>(await fetch(url)).json(),base+'catalog.json');
 for(const e of catalog.entries.filter(e=>e.url)){
  const url=new URL(e.url,base).href;
  await page.goto(url,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.querySelector('.shell')?.dataset.sceneState==='ready',null,{timeout:90000});
  await page.waitForFunction(()=>document.querySelector('canvas').dataset.modelQuality==='full',null,{timeout:90000});
  await page.waitForFunction(()=>Number(document.querySelector('#fpsValue')?.textContent)>0);
  const row=await page.evaluate(()=>({url:location.href,ms:Math.round(performance.now()),previewMs:Number(document.querySelector('canvas').dataset.previewReadyMs),fullMs:Number(document.querySelector('canvas').dataset.fullReadyMs),fps:document.querySelector('#fpsValue').textContent,models:performance.getEntriesByType('resource').filter(r=>r.name.includes('.sog')).map(r=>({url:r.name,bytes:r.transferSize,duration:r.duration}))}));
  results.scenes.push(row);await persist();console.log(JSON.stringify(row));
  assert.equal(row.models.length,2,'One preview and one full model request');
  assert.equal(row.models.filter(m=>m.url.includes('/preview.')).length,1);
  assert.ok(row.previewMs>0&&row.fullMs>row.previewMs);
  assert.ok(row.models.find(m=>m.url.includes('/preview.')).bytes<1200000);
  assert.ok(row.models.every(r=>new URL(r.url).origin===new URL(base).origin));
 }
 await ctx.close();
 for(const width of [1440,390]){
  const ctx=await browser.newContext({viewport:{width,height:width===390?844:1000},isMobile:width===390,hasTouch:width===390}),p=await ctx.newPage();
  p.on('pageerror',e=>results.errors.push(e.message));
  for(const id of ['scene-3aafc6cc274a','scene-8af1691afe40','scene-aaff992ddb8c']){
   await p.goto(base+'view/'+id+'/?photos=1',{waitUntil:'domcontentloaded'});
   await p.locator('.photo-comparison[data-loaded="true"]').waitFor({timeout:90000});
   await p.waitForFunction(()=>document.querySelector('canvas').dataset.modelQuality==='full',null,{timeout:90000});
   const buttons=p.locator('#photoAnchorList [data-photo-anchor-id]'),count=await buttons.count();assert.equal(count,3);
   for(let n=0;n<count;n++){
    const photoId=await buttons.nth(n).getAttribute('data-photo-anchor-id');await buttons.nth(n).click();
    await p.waitForFunction(photoId=>document.querySelector('.photo-comparison')?.dataset.loaded==='true'&&JSON.parse(document.querySelector('canvas').dataset.worldPhoto||'{}').id===photoId,photoId);
    const before=await p.locator('canvas').getAttribute('data-world-photo');
    const box=await p.locator('canvas').boundingBox();
    await p.mouse.move(box.x+box.width*.4,box.y+box.height*.4);await p.mouse.down();await p.mouse.move(box.x+box.width*.6,box.y+box.height*.45,{steps:8});await p.mouse.up();
    assert.equal(await p.locator('canvas').getAttribute('data-world-photo'),before,'Anchored plane must stay fixed in the world');
    await p.getByRole('button',{name:'放大查看原图',exact:true}).click();
    await p.locator('dialog[open] img').waitFor();
    assert.ok(await p.locator('dialog[open] img').evaluate(i=>i.complete&&i.naturalWidth>0));
    await p.getByRole('button',{name:'关闭原图，继续漫游',exact:true}).click();
   }
   await p.screenshot({path:out+'-'+id+'-'+width+'.png',fullPage:true});
   await p.getByRole('button',{name:'收起照片，继续漫游',exact:true}).click();
   await p.locator('.photo-comparison').waitFor({state:'detached'});
   const overflow=await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);assert.equal(overflow,false);
   results.photos.push({id,width,count,photoReturn:true,worldPlaneFixed:true,originalImage:true,resumeWalk:true,overflow});await persist();
  }
  await ctx.close();
 }
 assert.deepEqual(results.errors,[]);results.passed=true;await persist();
}finally{await persist();await browser.close();}
