import subprocess,sys,json,pathlib
root=pathlib.Path(__file__).parent
base={'reason':'child_exit','childExitCode':0,'survivors':[]}
cases=[('normal',{},0),('child_nonzero',{'childExitCode':7},7),('guard_loss',{'reason':'guard_exit'},1),('cleanup_failure',{'cleanupError':'mock'},1),('survivor',{'survivors':[1]},1),('missing_status',{'childExitCode':None},1)]
results=[]
for name,change,expected in cases:
    value=base|change
    code='from run_service import service_exit_code; raise SystemExit(service_exit_code('+repr(value)+'))'
    p=subprocess.run([sys.executable,'-c',code],cwd=root,capture_output=True,text=True)
    assert p.returncode==expected,(name,p.returncode,p.stderr)
    results.append({'case':name,'expected':expected,'actual':p.returncode,'passed':True})
(root/'projects/unseen-full-v1/evidence/RUNNER-EXIT-TEST.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
print('6 isolated runner exit mappings passed; no live service or GPU interaction')
