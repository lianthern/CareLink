import subprocess,pathlib,json,datetime
root=pathlib.Path('D:/H3-runtime')
with open(root/'logs/guard.stderr.log','a') as err:
    guard=subprocess.Popen(['wsl.exe','-d','Ubuntu-22.04','--','python3','/mnt/d/H3-runtime/guard_service.py'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=err)
    if guard.stdout.readline().strip()!=b'LOCKED': raise RuntimeError('GPU coordination lock unavailable')
    args=[str(root/'.venv/Scripts/python.exe'),'-X','utf8',str(root/'ComfyUI/main.py'),'--listen','127.0.0.1','--port','8193','--disable-auto-launch','--extra-model-paths-config',str(root/'extra_model_paths.yaml'),'--output-directory',str(root/'output'),'--cache-none','--disable-pinned-memory','--fast-disk']
    try:
        with open(root/'logs/comfy-service.log','a') as log:
            child=subprocess.Popen(args,cwd=root/'ComfyUI',stdout=log,stderr=subprocess.STDOUT)
            (root/'logs/service-guard.json').write_text(json.dumps(dict(pid=child.pid,command=args,startedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())))
            code=child.wait()
            (root/'logs/service-exit.json').write_text(json.dumps(dict(exitCode=code)))
    finally:
        guard.stdin.close();guard.wait()