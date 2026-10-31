import { spawnSync } from 'node:child_process';

// Read the user-facing shell and catalog as well as the process health response.
export function probeApp(config, { spawn = spawnSync } = {}) {
  const failed=[];
  for (const [pathname, valid] of [
    ['/api/health', text=>{const data=JSON.parse(text);return data.ok===true&&typeof data.buildId==='string'&&data.buildId.length>0;}],
    ['/app', text=>/<(?:!doctype html|html)[\s>]/i.test(text)&&/moment-app|app-assets/.test(text)],
    ['/api/app-catalog', text=>{const data=JSON.parse(text);return Array.isArray(data.cases)&&data.cases.length>0;}]
  ]) {
    const result=spawn(config.curlBin,['-sS','--max-time',String(Math.max(1,Math.ceil(config.httpTimeoutMs/1000))),
      '-H',`Host: ${config.appHost}`,'-w','\n%{http_code}',new URL(pathname,config.appOrigin).href],{encoding:'utf8'});
    const output=result.stdout||'',at=output.lastIndexOf('\n'),status=Number(output.slice(at+1));
    try { if(result.error||result.status!==0||status!==200||!valid(output.slice(0,at)))failed.push(pathname); }
    catch { failed.push(pathname); }
  }
  return {id:'moment-app',level:failed.length?'critical':'ok',
    detail:failed.length?`回忆时刻 App 入口异常：${failed.join('、')}`:'回忆时刻 App、版本与案例目录正常',
    nextSteps:'systemctl status huijian && journalctl -u huijian -n 100 --no-pager'};
}
