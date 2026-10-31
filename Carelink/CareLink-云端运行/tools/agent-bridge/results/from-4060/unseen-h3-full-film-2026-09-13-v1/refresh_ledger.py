import json,pathlib,hashlib,datetime
root=pathlib.Path('D:/H3-runtime/projects/unseen-full-v1')
shots=json.loads((root/'control/SHOTS.json').read_text(encoding='utf-8-sig'))['shots']; ledger=[]
for s in shots:
    record={'id':s['id'],'type':s['type'],'editSeconds':s['edit_seconds'],'state':'planned','attempts':[]}
    for attempt in sorted((root/'shots'/s['id']).glob('attempt-*')):
        item={'attempt':attempt.name,'path':str(attempt)}
        for name in ['intent','submission','result','visual-review']:
            p=attempt/(name+'.json')
            if p.exists():item[name]=json.loads(p.read_text(encoding='utf-8-sig'))
        record['attempts'].append(item)
    if record['attempts']:record['state']='awaiting_visual_review' if 'result' in record['attempts'][-1] else 'generating'
    if record['attempts'] and 'visual-review' in record['attempts'][-1]:record['state']=record['attempts'][-1]['visual-review']['verdict']
    composite=root/'composition'/s['id']/'record.json'
    if composite.exists():
        record['composition']=json.loads(composite.read_text(encoding='utf-8-sig'))
        record['state']=record['composition']['state']
    ledger.append(record)
(root/'SHOT-LEDGER.json').write_text(json.dumps(ledger,ensure_ascii=False,indent=2),encoding='utf-8')
(root/'STATUS.json').write_text(json.dumps({'job':'unseen-h3-full-film-2026-09-13-v1','state':'RUNNING','stage':'action_candidates_and_composition','activeShots':[r['id'] for r in ledger if r['state']=='generating'],'updatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'inputVerified':True,'guardTestsPassed':6,'completedFilm':False},indent=2),encoding='utf-8')
