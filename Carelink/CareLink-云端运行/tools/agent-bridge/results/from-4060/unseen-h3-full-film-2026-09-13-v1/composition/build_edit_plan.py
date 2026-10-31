"""Create an auditable edit plan. Missing shots never become silent placeholders."""
import pathlib,json,hashlib
root=pathlib.Path(__file__).parent
read=lambda p:json.loads(p.read_text(encoding='utf-8-sig'))
shots=read(root/'control/SHOTS.json')['shots']
selected={'H01':1,'H10':2,'H11':1,'S02':1,'S03':3,'E01':1,'E02':1,'W06':1,'W07':1}
# Coordinator reviewed source frame boundaries; end is exclusive, 24 fps.
overrides={'H10':{'frames':[0,107]},'H11':{'frames':[78,107],'crop':[480,270,90,65]},'S02':{'frames':[0,107],'crop':[384,216,224,136]},'S03':{'frames':[17,107]}}
entries=[];missing=[]
for s in shots:
    sid=s['id'];row={'id':sid,'type':s['type'],'nominalSeconds':s['edit_seconds'],'state':'missing','requiredCriteria':s['pass_criteria']}
    if sid in selected:
        folder=root/'shots'/sid/f'attempt-{selected[sid]:02d}'
        result=read(folder/'result.json');review=read(folder/'visual-review.json');video=pathlib.Path(result['video'])
        assert hashlib.sha256(video.read_bytes()).hexdigest()==result['sha256'],sid
        row.update(state='candidate',source=str(video),sha256=result['sha256'],frames=[0,107],crop=[608,342,0,5],review=review)
        row.update(overrides.get(sid,{}));row['seconds']=(row['frames'][1]-row['frames'][0])/24
        if sid=='H11':row['cropReview']='Frames 78 and 103 reviewed; 480x270 crop retains pocket insertion/hand withdrawal, no second packet. Whole retained interval review follows in cut candidate.'
    elif sid=='E03':
        record=read(root/'composition/E03/record.json');row.update(state='title_candidate',source=record['video'],seconds=3,review=record)
    else:missing.append(sid)
    entries.append(row)
plan={'version':1,'output':{'width':1280,'height':720,'fps':24,'minSeconds':110,'maxSeconds':140,'resampling':'608x352 sources cropped/resampled; S02 only 384x216 effective'},'completeFilm':False,'missingSegments':missing,'candidateSeconds':sum(e.get('seconds',0) for e in entries),'audio':'Final mix and listening review required; original generation audio is not automatically approved.','entries':entries}
out=root/'composition/EDIT-PLAN.json';out.write_text(json.dumps(plan,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'segments':len(entries),'missing':missing,'candidateSeconds':plan['candidateSeconds'],'completeFilm':False}))
