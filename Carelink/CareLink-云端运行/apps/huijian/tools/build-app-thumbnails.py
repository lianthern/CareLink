"""Generate engineering previews only. Originals and viewer contracts stay unchanged."""
import hashlib,json,pathlib,urllib.request,io
from PIL import Image,ImageOps
root=pathlib.Path(__file__).resolve().parents[1]
sources=json.loads((root/'.task/app-loading/cover-sources.json').read_text())
out=root/'public/app-previews';out.mkdir(exist_ok=True)
manifest={};receipt=[]
for url in sources:
    if url.startswith('https:'):continue # existing public World thumbnails
    source=root/url.lstrip('/') if url.startswith('/photos/') else root/'public'/url.lstrip('/')
    data=source.read_bytes() if source.is_file() else urllib.request.urlopen('https://huijian.maxxam.xyz'+url).read()
    im=ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert('RGB')
    variants=[]
    for width in (480,960):
        copy=im.copy();copy.thumbnail((width,round(width*im.height/im.width)),Image.Resampling.LANCZOS)
        buf=io.BytesIO();copy.save(buf,format='WEBP',quality=78,method=6);b=buf.getvalue();name=hashlib.sha256(b).hexdigest()+'.webp'
        (out/name).write_bytes(b);variants.append({'url':'/app-previews/'+name,'width':copy.width,'bytes':len(b)})
    manifest[url]=variants;receipt.append({'source':url,'originalBytes':len(data),'originalSize':im.size,'variants':variants})
(root/'public/app-thumbnails.js').write_text('export const thumbnails = '+json.dumps(manifest,ensure_ascii=False,separators=(',',':'))+';\nexport function previewImage(url){const v=thumbnails[url];return v?`src="${v[0].url}" srcset="${v.map(x=>`${x.url} ${x.width}w`).join(", ")}" sizes="(max-width: 600px) 90vw, 480px"`:`src="${String(url||"").replace(/[&<>"\\\']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",\'"\':"&quot;", "\\\'":"&#39;"}[c]))}"`;}\n')
(root/'.task/app-loading/thumbnail-receipt.json').write_text(json.dumps(receipt,indent=2))
print('Generated',len(manifest),'public preview pairs')
