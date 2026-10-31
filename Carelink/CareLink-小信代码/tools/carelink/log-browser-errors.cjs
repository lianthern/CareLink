const {chromium}=require('/opt/homebrew/lib/node_modules/playwright'),launch=chromium.launch.bind(chromium);
chromium.launch=async function(options){const b=await launch(options),create=b.newContext.bind(b);b.newContext=async function(options){const c=await create(options);c.on('page',p=>p.on('pageerror',e=>console.log('BROWSER_START_ERROR',e.stack))); return c;};return b;};
