import ctypes, ctypes.wintypes as W, subprocess, threading, queue, time, json, pathlib, psutil
class Basic(ctypes.Structure):
    _fields_=[('p',ctypes.c_longlong),('j',ctypes.c_longlong),('flags',W.DWORD),('min',ctypes.c_size_t),('max',ctypes.c_size_t),('active',W.DWORD),('affinity',ctypes.c_size_t),('priority',W.DWORD),('scheduling',W.DWORD)]
class IO(ctypes.Structure):
    _fields_=[(n,ctypes.c_ulonglong) for n in ['a','b','c','d','e','f']]
class Extended(ctypes.Structure):
    _fields_=[('basic',Basic),('io',IO),('p',ctypes.c_size_t),('j',ctypes.c_size_t),('pp',ctypes.c_size_t),('pj',ctypes.c_size_t)]
k=ctypes.WinDLL('kernel32',use_last_error=True)
k.CreateJobObjectW.argtypes=[ctypes.c_void_p,W.LPCWSTR];k.CreateJobObjectW.restype=W.HANDLE
k.SetInformationJobObject.argtypes=[W.HANDLE,ctypes.c_int,ctypes.c_void_p,W.DWORD]
k.AssignProcessToJobObject.argtypes=[W.HANDLE,W.HANDLE];k.TerminateJobObject.argtypes=[W.HANDLE,W.UINT];k.CloseHandle.argtypes=[W.HANDLE]
nt=ctypes.WinDLL('ntdll');nt.NtResumeProcess.argtypes=[W.HANDLE];nt.NtResumeProcess.restype=ctypes.c_long
def run_owned(guard_args,child_args,cwd,logdir,startup_timeout=30):
    logdir=pathlib.Path(logdir);logdir.mkdir(parents=True,exist_ok=True)
    events=queue.Queue();child=None;guard=None;job=None;reason='startup_failure';identities=[]
    result={'guardCommand':guard_args,'childCommand':child_args,'startedAt':time.time(),'childLaunched':False}
    def read_pipe(pipe):
        try:
            for line in iter(pipe.readline,b''):events.put(('line',line.strip()))
        finally:events.put(('eof',None))
    with open(logdir/'guard.stderr.log','ab') as err,open(logdir/'comfy-service.log','ab') as out:
        try:
            guard=subprocess.Popen(guard_args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=err)
            result['guardIdentity']={'pid':guard.pid,'createdAt':psutil.Process(guard.pid).create_time()}
            threading.Thread(target=read_pipe,args=(guard.stdout,),daemon=True).start()
            kind,line=events.get(timeout=startup_timeout)
            if kind!='line' or line!=b'LOCKED' or guard.poll() is not None:
                reason='no_lock';return result
            job=k.CreateJobObjectW(None,None)
            if not job:raise ctypes.WinError(ctypes.get_last_error())
            limits=Extended();limits.basic.flags=0x2000
            if not k.SetInformationJobObject(job,9,ctypes.byref(limits),ctypes.sizeof(limits)):raise ctypes.WinError(ctypes.get_last_error())
            child=subprocess.Popen(child_args,cwd=cwd,stdout=out,stderr=subprocess.STDOUT,creationflags=0x4)
            if not k.AssignProcessToJobObject(job,int(child._handle)):
                child.kill();raise ctypes.WinError(ctypes.get_last_error())
            owner=psutil.Process(child.pid);result['childIdentity']={'pid':child.pid,'createdAt':owner.create_time(),'command':child_args};result['childLaunched']=True
            (logdir/'service-guard.json').write_text(json.dumps(result,indent=2))
            if nt.NtResumeProcess(int(child._handle))!=0:raise RuntimeError('Resume failed')
            while True:
                if guard.poll() is not None:reason='guard_exit';break
                try:
                    if events.get_nowait()[0]=='eof':reason='guard_eof';break
                except queue.Empty:pass
                if child.poll() is not None:reason='child_exit';break
                try:identities=[{'pid':p.pid,'createdAt':p.create_time(),'command':p.cmdline()} for p in [owner]+owner.children(recursive=True)]
                except (psutil.NoSuchProcess,psutil.AccessDenied):pass
                time.sleep(.1)
        except queue.Empty:reason='startup_timeout'
        except Exception as exc:result['error']=repr(exc);reason='supervision_error'
        finally:
            if job:
                if not k.TerminateJobObject(job,1):result['cleanupError']=str(ctypes.get_last_error())
                k.CloseHandle(job)
            if child:
                try:result['childExitCode']=child.wait(timeout=10)
                except subprocess.TimeoutExpired:result['cleanupError']='Child did not exit'
            if guard:
                try:guard.stdin.close()
                except (BrokenPipeError,OSError):pass
                try:guard.wait(timeout=5)
                except subprocess.TimeoutExpired:guard.terminate();guard.wait(timeout=5)
            survivors=[]
            for item in identities:
                try:
                    p=psutil.Process(item['pid'])
                    if abs(p.create_time()-item['createdAt'])<.01:survivors.append(item)
                except psutil.NoSuchProcess:pass
            result.update(reason=reason,guardExitCode=guard.returncode if guard else None,identities=identities,survivors=survivors,endedAt=time.time())
            (logdir/'service-exit.json').write_text(json.dumps(result,indent=2))
    return result