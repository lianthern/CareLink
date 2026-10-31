#!/usr/bin/env python3
"""Explicitly upload one selected scene. Standard library only; no credential files."""
import argparse, getpass, hashlib, http.cookiejar, json, pathlib, re, sys, urllib.error, urllib.parse, urllib.request, uuid, zipfile

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--server',default='https://huijian.maxxam.xyz')
    p.add_argument('--username',required=True)
    p.add_argument('--list-spaces',action='store_true')
    p.add_argument('--source',type=pathlib.Path,help='Exported ZIP or scene folder')
    p.add_argument('--revision',help='Exactly one source sceneRevisionId selected by Max')
    p.add_argument('--space-id')
    p.add_argument('--activate',action='store_true',help='Explicitly select this as the current revision')
    args=p.parse_args();origin=urllib.parse.urlsplit(args.server)
    if origin.scheme!='https' and not(origin.scheme=='http' and origin.hostname in ('127.0.0.1','localhost')):p.error('HTTPS is required')
    if origin.path not in ('','/') or origin.username or origin.password:p.error('Use a server origin only')
    if not args.list_spaces and not all((args.source,args.revision,args.space_id)):p.error('--source, --revision and --space-id are required; nothing uploads by default')
    jar=http.cookiejar.CookieJar();opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar));account=None;session=None
    def request(path,method='GET',body=None,binary=False):
        headers={'Accept':'application/json','Origin':args.server.rstrip('/'),'Idempotency-Key':str(uuid.uuid4())}
        if account:headers['X-Unseen-Expected-Account-Id']=account
        if session:headers['Cookie']='__Host-unseen_account='+session
        if body is not None:
            headers['Content-Type']='application/octet-stream' if binary else 'application/json'
            if not binary:body=json.dumps(body,ensure_ascii=False).encode()
        req=urllib.request.Request(args.server.rstrip('/')+path,data=body,headers=headers,method=method)
        try:
            with opener.open(req,timeout=180) as r:return json.load(r)
        except urllib.error.HTTPError as e:
            try:code=json.load(e).get('error','request_failed')
            except Exception:code='request_failed'
            raise RuntimeError(f'HTTP {e.code}: {code}') from None
    request('/v1/auth/password-login','POST',{'username':args.username,'password':getpass.getpass('UNSEEN password (not saved): ')})
    session=next((c.value for c in jar if c.name=='__Host-unseen_account'),None)
    if not session:raise RuntimeError('Login did not return an account session')
    # The live operable projections require the existing account Cookie, including
    # management responses. Keep it in memory; never persist a password or session.
    opener=urllib.request.build_opener()
    account=request('/v1/me')['accountId']
    spaces=[s for s in request('/v1/me/spaces')['spaces'] if s.get('owner') and s.get('spaceLifecycle')=='active']
    if args.list_spaces:
        print(json.dumps([{'spaceId':s['spaceId'],'name':s['name']} for s in spaces],ensure_ascii=False,indent=2));return
    if args.space_id not in [s['spaceId'] for s in spaces]:raise RuntimeError('Target space must be active and owned by this account')
    archive=None
    try:
        if args.source.is_file():
            archive=zipfile.ZipFile(args.source)
            if len(archive.namelist())!=len(set(archive.namelist())):raise RuntimeError('Duplicate ZIP members')
            names=archive.namelist()
            def read(name):
                info=archive.getinfo(name)
                if info.file_size>128*1024*1024:raise RuntimeError('File exceeds server limit')
                return archive.read(name)
        else:
            base=args.source.resolve();names=[f.relative_to(base).as_posix() for f in base.rglob('*') if f.is_file() and not f.is_symlink()]
            def read(name):
                f=(base/name).resolve()
                if not f.is_relative_to(base) or f.stat().st_size>128*1024*1024:raise RuntimeError('Unsafe or oversized source file')
                return f.read_bytes()
        candidates=[]
        for name in names:
            if name=='scene.json' or name.endswith('/scene.json'):
                if '..' in pathlib.PurePosixPath(name).parts or name.startswith('/'):continue
                scene=json.loads(read(name))
                if scene.get('sceneRevisionId')==args.revision:candidates.append((name[:-10],scene))
        if len(candidates)!=1:raise RuntimeError('Expected exactly one selected revision in the source')
        prefix,scene=candidates[0];wanted={'scene.json','assets/scene.sog'}
        if prefix+'navigation-map.json' in names:wanted.add('navigation-map.json')
        for anchor in scene.get('photoAnchors',[]):
            for key in ('thumbnail','originalUrl'):
                if anchor.get(key):wanted.add(anchor[key])
        allowed=re.compile(r'^(scene\.json|navigation-map\.json|assets/scene\.sog|(photos|videos)/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp|mp4|webm))$')
        for path in wanted:
            if not allowed.fullmatch(path) or prefix+path not in names:raise RuntimeError('Missing or nonportable scene reference: '+path)
        files=[]
        for path in sorted(wanted):
            data=read(prefix+path);files.append({'path':path,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
        body={'consent':True,'spaceId':args.space_id,'sourceRevisionId':args.revision,'title':scene.get('name') or args.revision,'files':files}
        result=request('/api/scene-results','POST',body)['result'];rid=result['resultId']
        if result['status']!='ready':
            received={f['path'] for f in result['files'] if f.get('received')}
            for f in files:
                if f['path'] in received:continue
                print('Uploading:',f['path'],f['bytes'],'bytes',flush=True)
                request('/api/scene-results/'+rid+'/files/'+urllib.parse.quote(f['path'],safe=''),'PUT',read(prefix+f['path']),binary=True)
            result=request('/api/scene-results/'+rid+'/commit','POST',{})['result']
        if args.activate:result=request('/api/scene-results/'+rid+'/activate','POST',{})['result']
        print(json.dumps({'resultId':rid,'sourceRevisionId':args.revision,'status':result['status'],'active':result['active'],'viewerUrl':args.server.rstrip('/')+result['viewerUrl'],'hasLocalizationMap':result.get('hasLocalizationMap',False)},ensure_ascii=False,indent=2))
    finally:
        if archive:archive.close()

if __name__=='__main__':
    try:main()
    except (RuntimeError,OSError,ValueError,KeyError) as e:sys.exit(str(e))
