"""Freeze byte-identical public viewer images/depth at content-addressed URLs."""
import pathlib,hashlib,json,os
root=pathlib.Path(__file__).resolve().parents[1];public=root/'public';mapping={};receipt=[]
for folder in ['app-spatial/v1','unseen-app-cases-assets']:
 for path in sorted((public/folder).rglob('*')):
  if path.suffix.lower() not in ['.jpg','.jpeg','.png','.webp'] or not path.is_file():continue
  b=path.read_bytes();digest=hashlib.sha256(b).hexdigest();url='/app-originals/'+digest+'/'+path.name;dest=public/url.lstrip('/');dest.parent.mkdir(parents=True,exist_ok=True)
  if not dest.exists():os.link(path,dest)
  mapping['/'+path.relative_to(public).as_posix()]=url;receipt.append({'source':'/'+path.relative_to(public).as_posix(),'url':url,'sha256':digest,'bytes':len(b)})
(public/'app-originals.js').write_text('const originals='+json.dumps(mapping,separators=(',',':'))+';\nexport function versionPublicItem(value){if(typeof value==="string")return originals[value]||value;if(Array.isArray(value))return value.map(versionPublicItem);if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,versionPublicItem(v)]));return value;}\n')
(root/'.task/app-loading/original-receipt.json').write_text(json.dumps(receipt,indent=2))
print('Frozen',len(mapping),'public originals without pixel changes')
