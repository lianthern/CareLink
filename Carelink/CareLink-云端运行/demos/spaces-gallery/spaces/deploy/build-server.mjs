// Build an isolated static release. Source models and photos remain byte-for-byte intact.
// node spaces/deploy/build-server.mjs .deploy/release-id
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.resolve(process.argv[2]||'');
if(!process.argv[2]||fs.existsSync(output))throw Error('Supply a new, nonexistent release directory.');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);
const media=JSON.parse(fs.readFileSync(path.join(source,'deploy/media-sha256.json')));
for(const row of media){const b=fs.readFileSync(path.join(source,row.path));if(b.length!==row.bytes||hash(b)!==row.sha256)throw Error('Source media changed: '+row.path);}
const root=path.join(output,'spaces');
fs.mkdirSync(root,{recursive:true});
for(const name of fs.readdirSync(source))if(name!=='deploy'&&name!=='README.md')fs.cpSync(path.join(source,name),path.join(root,name),{recursive:true});
function fingerprint(file){
 const ext=path.extname(file),bytes=fs.readFileSync(file);
 const target=file.slice(0,-ext.length)+'.'+hash(bytes).slice(0,16)+ext;
 fs.renameSync(file,target);return path.basename(target);
}
const vendor=fingerprint(path.join(root,'vendor/playcanvas.min.mjs'));
const previewManifest=JSON.parse(fs.readFileSync(path.join(source,'deploy/preview-manifest.json')));
fs.mkdirSync(path.join(root,'runtime'),{recursive:true});
fs.copyFileSync(path.join(source,'deploy/progressive-viewer.mjs'),path.join(root,'runtime/progressive-viewer.mjs'));
const progressive=fingerprint(path.join(root,'runtime/progressive-viewer.mjs'));
for(const entry of fs.readdirSync(path.join(root,'view'))){
 const dir=path.join(root,'view',entry),manifestFile=path.join(dir,'scene.json');
 if(!fs.existsSync(manifestFile))continue;
 const manifest=JSON.parse(fs.readFileSync(manifestFile));
 const oldModel=path.resolve(dir,manifest.sceneAsset.url);
 if(!oldModel.startsWith(root+path.sep))throw Error('Model outside release');
 const model=fingerprint(oldModel);
 manifest.sceneAsset.url='./assets/'+model;
 const previewRow=previewManifest.scenes.find(row=>row.id===entry);
 if(!previewRow)throw Error('Missing preview: '+entry);
 const previewBytes=fs.readFileSync(path.join(source,'deploy',previewRow.path));
 if(hash(previewBytes)!==previewRow.sha256||previewBytes.length!==previewRow.bytes||hash(fs.readFileSync(path.join(dir,'assets',model)))!==previewRow.sourceSha256)throw Error('Preview/source mismatch: '+entry);
 fs.writeFileSync(path.join(dir,'assets/preview.sog'),previewBytes);
 const preview=fingerprint(path.join(dir,'assets/preview.sog'));
 manifest.sceneAsset.previewUrl='./assets/'+preview;
 fs.writeFileSync(manifestFile,JSON.stringify(manifest));
 const collision=fingerprint(path.join(dir,'collision.mjs'));
 let app=fs.readFileSync(path.join(dir,'app.js'),'utf8');
 app=`import {loadProgressiveScene} from "../../runtime/${progressive}";\n`+app;
 const loadMarker='  const assetUrl = relativeAssetUrl(sceneAsset.url);';
 if(!app.includes(loadMarker))throw Error('Viewer load function changed: '+entry);
 app=app.replace(loadMarker,`  if(sceneAsset.previewUrl&&query.get('quality')!=='full')return loadProgressiveScene({pc,app,sceneAsset,resolveUrl:relativeAssetUrl,ui,setLoading,setSceneState});\n`+loadMarker);
 app=app.replace('"./collision.mjs"',JSON.stringify('./'+collision)).replace('"../../vendor/playcanvas.min.mjs"',JSON.stringify('../../vendor/'+vendor));
 fs.writeFileSync(path.join(dir,'app.js'),app);
 const script=fingerprint(path.join(dir,'app.js')),css=fingerprint(path.join(dir,'styles.css'));
 let html=fs.readFileSync(path.join(dir,'index.html'),'utf8');
 html=html.replace('href="./styles.css"',`href="./${css}"`).replace('src="./app.js"',`src="./${script}"`);
 // Start independent requests while HTML is being parsed. The model preload uses
 // the same URL/credentials as PlayCanvas fetch, so it is reused, not downloaded twice.
 const hints=`<link rel="modulepreload" href="../../vendor/${vendor}">\n<link rel="modulepreload" href="../../runtime/${progressive}">\n<link rel="modulepreload" href="./${collision}">\n<link rel="preload" href="./scene.json" as="fetch" crossorigin>\n<script>if(!new URLSearchParams(location.search).has('scene')&&!new URLSearchParams(location.search).has('demo')){const p=document.createElement('link');p.rel='preload';p.as='fetch';p.crossOrigin='anonymous';p.href=new URLSearchParams(location.search).get('quality')==='full'?${JSON.stringify('./assets/'+model)}:${JSON.stringify('./assets/'+preview)};document.head.append(p);}</script>\n`;
 html=html.replace('</head>',hints+'</head>');fs.writeFileSync(path.join(dir,'index.html'),html);
}
const galleryCss=fingerprint(path.join(root,'gallery.css')),galleryJs=fingerprint(path.join(root,'gallery.js'));
let gallery=fs.readFileSync(path.join(root,'index.html'),'utf8');
gallery=gallery.replace('./gallery.css','./'+galleryCss).replace('./gallery.js','./'+galleryJs).replace('href="../"','href="https://maxi-max-dev.github.io/unseen-ui-preview/"');
fs.writeFileSync(path.join(root,'index.html'),gallery);
const manifest=[];
for(const file of walk(root)){
 const bytes=fs.readFileSync(file);
 manifest.push({path:path.relative(output,file),bytes:bytes.length,sha256:hash(bytes)});
 if(/\.(html|css|m?js|json|svg)$/.test(file)&&bytes.length>512){
  fs.writeFileSync(file+'.br',zlib.brotliCompressSync(bytes,{params:{[zlib.constants.BROTLI_PARAM_QUALITY]:11}}));
  fs.writeFileSync(file+'.gz',zlib.gzipSync(bytes,{level:9}));
 }
}
fs.writeFileSync(path.join(output,'release-manifest.json'),JSON.stringify(manifest,null,2));
const preserved=media.every(row=>manifest.some(out=>out.sha256===row.sha256&&out.bytes===row.bytes));
if(!preserved)throw Error('Release did not preserve all source media');
console.log(JSON.stringify({output,files:manifest.length,verifiedMedia:media.length,bytes:manifest.reduce((n,r)=>n+r.bytes,0),vendor,compressedVendorBytes:fs.statSync(path.join(root,'vendor',vendor+'.br')).size}));
