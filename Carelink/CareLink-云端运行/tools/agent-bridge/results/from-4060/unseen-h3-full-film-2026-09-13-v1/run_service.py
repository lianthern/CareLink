import pathlib,socket
from owned_service import run_owned
root=pathlib.Path('D:/H3-runtime')
def service_exit_code(result):
    if result.get('reason')!='child_exit' or result.get('cleanupError') or result.get('error') or result.get('survivors'):
        return 1
    code=result.get('childExitCode')
    return code if isinstance(code,int) and 0<=code<=255 else 1
if __name__=='__main__':
    with socket.socket() as s:
        if s.connect_ex(('127.0.0.1',8193))==0:raise RuntimeError('8193 is occupied')
    args=[str(root/'.venv/Scripts/python.exe'),'-X','utf8',str(root/'ComfyUI/main.py'),'--listen','127.0.0.1','--port','8193','--disable-auto-launch','--extra-model-paths-config',str(root/'extra_model_paths.yaml'),'--output-directory',str(root/'projects/unseen-full-v1/generated'),'--cache-none','--disable-pinned-memory','--fast-disk']
    result=run_owned(['wsl.exe','-d','Ubuntu-22.04','--','python3','/mnt/d/H3-runtime/guard_service.py'],args,root/'ComfyUI',root/'projects/unseen-full-v1/evidence/service')
    raise SystemExit(service_exit_code(result))
