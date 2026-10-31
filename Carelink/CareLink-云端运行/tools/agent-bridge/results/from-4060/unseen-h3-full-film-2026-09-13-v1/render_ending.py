import pathlib, subprocess, json, hashlib
root=pathlib.Path(__file__).parent
out=root/'composition'/'E03'
out.mkdir(parents=True,exist_ok=True)
texts=['那些年，你没看见的，也有人替你记着。','UNSEEN','概念演示']
for i,t in enumerate(texts): (out/f'text{i}.txt').write_text(t,encoding='utf-8')
# Deliberate closing title hold, not a replacement for a missing action shot.
filters=['scale=1280:720:force_original_aspect_ratio=increase','crop=1280:720',"drawbox=color=black@0.38:t=fill"]
for i,(size,y) in enumerate([(38,280),(62,369),(24,463)]):
    filters.append(f"drawtext=fontfile='C\\:/Windows/Fonts/msyh.ttc':textfile=text{i}.txt:fontsize={size}:fontcolor=white:x=(w-tw)/2:y={y}:alpha='min(1,t/0.7)'")
filters.append('fade=t=out:st=2.4:d=0.6')
source=root/'shots/E02/attempt-01/last.png'
video=out/'E03-title-candidate.mp4'
cmd=['ffmpeg','-y','-loop','1','-i',str(source),'-t','3','-r','24','-vf',','.join(filters),'-an','-c:v','libx264','-pix_fmt','yuv420p',str(video)]
subprocess.run(cmd,cwd=out,check=True,stdout=subprocess.DEVNULL,stderr=(out/'render.log').open('w'))
subprocess.run(['ffmpeg','-v','error','-i',str(video),'-f','null','-'],check=True)
subprocess.run(['ffmpeg','-y','-ss','1','-i',str(video),'-frames:v','1',str(out/'review.png')],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
(out/'record.json').write_text(json.dumps({'segment':'E03','state':'pending_visual_review','duration':3,'source':str(source),'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'video':str(video),'sha256':hashlib.sha256(video.read_bytes()).hexdigest(),'decodeExit':0,'audio':'No audio in intermediate. Final mix must carry E02 room tone through the title.','representation':'Closing typography over deliberate hold of generated E02 ending. Upsampled 608x352 source; not native 720p.'},ensure_ascii=False,indent=2),encoding='utf-8')
