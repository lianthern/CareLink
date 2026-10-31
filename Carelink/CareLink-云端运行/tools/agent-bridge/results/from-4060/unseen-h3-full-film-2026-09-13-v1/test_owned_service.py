import sys,pathlib,json,time,psutil
from owned_service import run_owned
root=pathlib.Path('D:/H3-runtime/projects/unseen-full-v1/evidence/guard-tests');root.mkdir(parents=True,exist_ok=True)
python=sys._base_executable
child="import subprocess,sys,time; subprocess.Popen([sys.executable,'-c','import time; time.sleep(120)']); time.sleep(120)"
cases=[('no_lock',"print('NO');",child,False),('normal',"import sys; print('LOCKED',flush=True); sys.stdin.read()","import time; time.sleep(1)",True),('guard_zero',"import time; print('LOCKED',flush=True); time.sleep(2)",child,True),('guard_nonzero',"import time,sys; print('LOCKED',flush=True); time.sleep(2); sys.exit(7)",child,True),('guard_eof',"import os,time; print('LOCKED',flush=True); time.sleep(2); os.close(1); time.sleep(120)",child,True),('startup_timeout',"import time; time.sleep(120)",child,False)]
results=[]
for name,g,c,launched in cases:
    r=run_owned([python,'-c',g],[python,'-c',c],root,root/name,startup_timeout=3)
    assert r['childLaunched']==launched,(name,r)
    assert not r['survivors'] and not r.get('cleanupError') and not r.get('error'),(name,r)
    if name=='normal':assert r['reason']=='child_exit' and r['childExitCode']==0,r
    if name.startswith('guard_'):assert r['reason'] in ('guard_exit','guard_eof'),r
    if name in ('guard_zero','guard_nonzero','guard_eof'):assert len(r['identities'])>=2,r
    results.append(dict(case=name,passed=True,result=r));print(name,'PASS',flush=True)
(root/'RESULTS.json').write_text(json.dumps(results,indent=2))