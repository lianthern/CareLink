import fcntl,json,pathlib,sqlite3,subprocess,datetime
root=pathlib.Path('/mnt/d/H3-runtime')
lock=open('/home/max/unseen-local-product/state/gpu-worker.lock','a+')
fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
db=sqlite3.connect('file:/home/max/unseen-local-product/state/product.sqlite3?mode=ro',uri=True)
counts=dict(db.execute('select state,count(*) from jobs group by state').fetchall());db.close()
if any(counts.get(s,0) for s in ['queued','leased','running','uploading']): raise RuntimeError('3DGS queue is not empty')
print('LOCKED',flush=True)
__import__('sys').stdin.read()
