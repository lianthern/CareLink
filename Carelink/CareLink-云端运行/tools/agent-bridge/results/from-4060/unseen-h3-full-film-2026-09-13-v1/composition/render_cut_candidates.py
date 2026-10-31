import pathlib,json,subprocess,hashlib
root=pathlib.Path(__file__).parent
plan=json.loads((root/'composition/EDIT-PLAN.json').read_text(encoding='utf-8'))
shots={s['id']:s for s in plan['entries']}
out=root/'composition/cuts';out.mkdir(exist_ok=True)
records=[]
for pair in [('H10','H11'),('S02','S03')]:
    name='-'.join(pair);cmd=['ffmpeg','-y'];filters=[]
    for sid in pair:cmd+=['-i',shots[sid]['source']]
    for i,sid in enumerate(pair):
        s=shots[sid];start,end=s['frames'];crop=':'.join(map(str,s['crop']))
        filters += [f'[{i}:v]trim=start_frame={start}:end_frame={end},setpts=PTS-STARTPTS,crop={crop},scale=1280:720,setsar=1[v{i}]',f'[{i}:a]atrim=start={start/24}:end={end/24},asetpts=PTS-STARTPTS,aresample=48000[a{i}]']
    filters+=['[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]']
    video=out/f'{name}-cut-candidate.mp4'
    cmd+=['-filter_complex',';'.join(filters),'-map','[v]','-map','[a]','-c:v','libx264','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k',str(video)]
    with (out/f'{name}-render.log').open('w') as log:subprocess.run(cmd,check=True,stdout=log,stderr=log)
    subprocess.run(['ffmpeg','-v','error','-i',str(video),'-f','null','-'],check=True)
    subprocess.run(['ffmpeg','-v','error','-y','-i',str(video),'-vf','fps=2,scale=320:180,tile=4x5','-frames:v','1',str(out/f'{name}-sheet.png')],check=True)
    records.append({'pair':pair,'sourceEdits':[shots[s] for s in pair],'output':str(video),'sha256':hashlib.sha256(video.read_bytes()).hexdigest(),'bytes':video.stat().st_size,'decodeExit':0,'visualReview':'pending','audioReview':'not_listened','finalFilm':False})
(out/'RECORDS.json').write_text(json.dumps(records,ensure_ascii=False,indent=2),encoding='utf-8')
