// Usage: node spaces/deploy/test-progressive-recovery.mjs BASE_URL
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
import assert from 'node:assert/strict';
const base=process.argv[2];if(!base)throw Error('Supply the spaces/ base URL');
const browser=await chromium.launch({...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chrome'}),headless:true,...(process.env.SPACE_TEST_RESOLVE?{args:['--host-resolver-rules=MAP spaces.maxxam.xyz '+(process.env.SPACE_TEST_IP||'43.132.167.200')]}:{})});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];let failures=0;
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/assets/scene.*.sog',route=>failures++===0?route.abort('failed'):route.continue());
 await page.goto(base+'view/scene-3aafc6cc274a/');
 await page.waitForFunction(()=>document.querySelector('canvas').dataset.modelQuality==='preview-error',null,{timeout:90000});
 const before=await page.locator('canvas').getAttribute('data-camera-position');
 await page.locator('canvas').focus();await page.keyboard.down('w');await page.waitForTimeout(350);await page.keyboard.up('w');
 const after=await page.locator('canvas').getAttribute('data-camera-position');assert.notEqual(before,after);
 await page.getByRole('button',{name:'重试加载清晰画质'}).click();
 await page.waitForFunction(()=>document.querySelector('canvas').dataset.modelQuality==='full',null,{timeout:90000});
 assert.equal(await page.locator('canvas').getAttribute('data-camera-position'),after);
 console.log('PASS: full download failure retains walking; retry upgrades without a camera reset.');
 await page.unroute('**/assets/scene.*.sog');
 await page.route('**/assets/preview.*.sog',route=>route.abort('failed'));
 await page.goto(base+'view/scene-3aafc6cc274a/');
 await page.waitForFunction(()=>document.querySelector('canvas').dataset.modelQuality==='full',null,{timeout:90000});
 console.log('PASS: failed preview falls back to the original.');
 await page.unroute('**/assets/preview.*.sog');
 const requests=[];page.on('request',r=>{if(r.url().includes('.sog'))requests.push(r.url())});
 await page.goto(base+'view/scene-3aafc6cc274a/?quality=full');
 await page.waitForFunction(()=>document.querySelector('.shell').dataset.sceneState==='ready',null,{timeout:90000});
 assert.equal(requests.length,1);assert.ok(!requests[0].includes('/preview.'));
 console.log('PASS: explicit full-quality mode downloads only the original.');
 requests.length=0;
 await page.goto(base+'view/scene-3aafc6cc274a/?scene=scene.json');
 await page.waitForFunction(()=>document.querySelector('canvas').dataset.modelQuality==='full',null,{timeout:90000});
 assert.equal(requests.length,2);assert.equal(new Set(requests).size,2);
 console.log('PASS: custom manifest mode resolves both assets without duplicate downloads.');
 assert.deepEqual(errors,[]);
}finally{await browser.close()}
