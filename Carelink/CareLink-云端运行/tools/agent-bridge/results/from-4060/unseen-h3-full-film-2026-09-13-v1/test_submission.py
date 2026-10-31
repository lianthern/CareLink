import pathlib,tempfile,subprocess,sys,json
root=pathlib.Path('D:/H3-runtime/projects/unseen-full-v1');folder=pathlib.Path(tempfile.mkdtemp(prefix='atomic-',dir=root/'evidence'))
code='''import pathlib,sys,time
from submission_guard import acquire,write_intent
root=pathlib.Path(sys.argv[1])
try:
    lock=acquire(root)
    write_intent(root/'intent.json',{'key':'same-shot-attempt'})
    with (root/'mock-posts.txt').open('a') as f:f.write('POST\\n')
    time.sleep(1)
except (RuntimeError,FileExistsError):sys.exit(3)
'''
workers=[subprocess.Popen([sys._base_executable,'-c',code,str(folder)],cwd=root) for _ in range(2)]
codes=[p.wait() for p in workers]
assert sorted(codes)==[0,3],codes
assert (folder/'mock-posts.txt').read_text().splitlines()==['POST']
original=(folder/'intent.json').read_bytes()
p=subprocess.run([sys._base_executable,'-c',code,str(folder)],cwd=root)
assert p.returncode==3 and (folder/'intent.json').read_bytes()==original
r={'passed':True,'concurrentReturnCodes':codes,'mockPostCount':1,'existingIntentUnchanged':True,'noNetworkOrGPU':True}
(root/'evidence/ATOMIC-SUBMISSION-TEST.json').write_text(json.dumps(r,indent=2));print(json.dumps(r))