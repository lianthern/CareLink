import argparse,json,pathlib,hashlib,datetime,requests,time,subprocess,psutil
p=argparse.ArgumentParser();p.add_argument('shot');p.add_argument('reference');p.add_argument('--attempt',type=int,choices=(1,2,3),default=1);p.add_argument('--prompt-file');p.add_argument('--conditioning',choices=('first-frame','reference'),default='first-frame');a=p.parse_args()
root=pathlib.Path('D:/H3-runtime/projects/unseen-full-v1');base='http://127.0.0.1:8193';target=root/'shots'/a.shot/f'attempt-{a.attempt:02d}';target.mkdir(parents=True,exist_ok=True)
from submission_guard import acquire,write_intent
submission_lock=acquire(root)
if (target/'intent.json').exists():raise RuntimeError('Intent exists: reconcile queue/history before any resubmit')
queue=requests.get(base+'/queue',timeout=10).json()
if queue['queue_running'] or queue['queue_pending']:raise RuntimeError('GPU queue occupied')
shot=next(s for s in json.loads((root/'control/SHOTS.json').read_text())['shots'] if s['id']==a.shot)
ref=pathlib.Path(a.reference);sha=hashlib.sha256(ref.read_bytes()).hexdigest()
with ref.open('rb') as f:
    upload=requests.post(base+'/upload/image',files={'image':(f'{a.shot}-{sha[:16]}.png',f,'image/png')},data={'type':'input','overwrite':'false'},timeout=30);upload.raise_for_status()
name=upload.json()['name'];api=json.loads((root/'control/BASE-T2V-API.json').read_text())
api['200']={'class_type':'LoadImage','inputs':{'image':name}}
api['131']['inputs'].update(first_frame=['200',0],prompt=(pathlib.Path(a.prompt_file).read_text() if a.prompt_file else shot['prompt']+' '+shot['audio']),width=608,height=352,length=shot['frame_count_starting_point'])
if a.conditioning=='reference':
    old=api['131']['inputs']
    api['131']={'class_type':'MiniMaxH3ReferenceToVideo','inputs':{'clip':old['clip'],'vae':['119',0],'prompt':old['prompt'],'width':608,'height':352,'length':shot['frame_count_starting_point'],'ref_image_size':'match','ref_images.ref_image_0':['200',0]}}
seed=2026091400+sum(ord(c) for c in a.shot)+a.attempt;api['129']['inputs']['noise_seed']=seed
prefix=f'unseen-full-v1/{a.shot}/attempt-{a.attempt:02d}'
api['92']['inputs'].update(filename_prefix=prefix,format='mp4');api['92']['inputs'].pop('codec',None);api['92']['inputs']['format.codec']='h264';api['92']['inputs']['format.codec.encoding']='auto'
(target/'workflow-api.json').write_text(json.dumps(api,indent=2))
intent=dict(key=f'unseen-h3-full-film-2026-09-13-v1/{a.shot}/attempt-{a.attempt:02d}',startedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),reference=str(ref),inputSha256=sha,seed=seed,shot=shot,outputPrefix=prefix,apiSha256=hashlib.sha256((target/'workflow-api.json').read_bytes()).hexdigest())
intent.update(conditioningMode=a.conditioning,templatePrompt=shot['prompt'],executedPrompt=api['131']['inputs']['prompt'])
write_intent(target/'intent.json',intent)
r=requests.post(base+'/prompt',json={'prompt':api,'client_id':intent['key']},timeout=60);(target/'submission.json').write_text(r.text);r.raise_for_status();pid=r.json()['prompt_id']
with (target/'resources.jsonl').open('a') as out:
    while True:
        m=psutil.virtual_memory();swap=psutil.swap_memory();g=subprocess.run(['nvidia-smi','--query-gpu=memory.used,utilization.gpu','--format=csv,noheader,nounits'],capture_output=True,text=True,timeout=20)
        out.write(json.dumps(dict(utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),ramUsed=m.used,ramAvailable=m.available,swapUsed=swap.used,gpu=g.stdout.strip()))+'\n');out.flush()
        h=requests.get(base+'/history/'+pid,timeout=30).json()
        if pid in h:break
        time.sleep(5)
(target/'history.json').write_text(json.dumps(h,indent=2))
if h[pid]['status']['status_str']!='success':raise RuntimeError('Generation failed: inspect history')
file=h[pid]['outputs']['92']['images'][0];video=root/'generated'/file['subfolder']/file['filename']
with (target/'decode.log').open('w') as log:
    decode=subprocess.run(['ffmpeg','-v','error','-i',str(video),'-f','null','-'],stderr=log)
probe=subprocess.run(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(video)],capture_output=True,text=True);(target/'ffprobe.json').write_text(probe.stdout)
subprocess.run(['ffmpeg','-v','error','-i',str(video),'-vf','fps=2,scale=304:176,tile=4x3','-frames:v','1','-y',str(target/'sheet.png')],check=True)
subprocess.run(['ffmpeg','-v','error','-sseof','-0.05','-i',str(video),'-frames:v','1','-y',str(target/'last.png')],check=True)
result=dict(shot=a.shot,attempt=a.attempt,promptId=pid,video=str(video),bytes=video.stat().st_size,sha256=hashlib.sha256(video.read_bytes()).hexdigest(),decodeExit=decode.returncode,endedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),visualVerdict='pending_agent_review')
(target/'result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result),flush=True)
