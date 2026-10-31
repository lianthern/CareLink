import pathlib, msvcrt, json
def acquire(root):
    path=pathlib.Path(root)/'submission.lock'
    handle=path.open('a+b')
    handle.seek(0,2)
    if handle.tell()==0:handle.write(b'0');handle.flush()
    handle.seek(0)
    try:msvcrt.locking(handle.fileno(),msvcrt.LK_NBLCK,1)
    except OSError:
        handle.close();raise RuntimeError('Another film submission/generation owns the lock; reconcile its state')
    return handle
def write_intent(path,data):
    with pathlib.Path(path).open('x',encoding='utf-8') as f:
        json.dump(data,f,indent=2);f.flush()
