// Content-addressed public module/CSS graph. Retain previous directories on release.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {posix,relative,resolve,sep} from 'node:path';
import {build, transform} from 'esbuild';
const files=new Map();
async function collect(path){
 if(files.has(path))return;
 const text=await readFile('public/'+path,'utf8');files.set(path,text);
 for(const match of text.matchAll(/(?:from\s*|import\s*\(|import\s*)['"](\.[^'"]+)['"]/g)){
  const child=posix.normalize(posix.join(posix.dirname(path),match[1]));
  if(/\.(?:js|mjs|css)$/.test(child))await collect(child);
 }
}
const styles=['moment-app.css','moment-spaces.css','moment-shared-spaces.css','unseen-app-spatial.css','unseen-app-cases.css','unseen-app-account.css','moment-design-reference.css','moment-design.css','moment-v2-reference.css','moment-v2.css'];
await collect('moment-app.js');for(const style of styles)await collect(style);
// Keep the source graph for old integrations; browsers use optimized entry/chunks.
// All dynamic imports stay split so opening home does not download space viewers.
const outdir='optimized';
const bundled=await build({
 entryPoints:['public/moment-app.js'],outdir,bundle:true,splitting:true,format:'esm',
 platform:'browser',target:['es2022'],minify:true,charset:'utf8',write:false,metafile:true,
 chunkNames:'chunks/[name]-[hash]',external:['three','three/*','@sparkjsdev/spark','/__book_lab_web__/*'],
 legalComments:'inline',logLevel:'warning'
});
const outputs=new Map(bundled.outputFiles.map(file=>[outdir+'/'+relative(resolve(outdir),file.path).split(sep).join('/'),file.text]));
const baseStyles=['moment-app.css','moment-spaces.css','moment-shared-spaces.css','unseen-app-spatial.css','unseen-app-cases.css','unseen-app-account.css'];
const styleSets={app:[...baseStyles,'moment-design-reference.css','moment-design.css'],v2:[...baseStyles,'moment-v2-reference.css','moment-design.css','moment-v2.css']};
for(const [variant,names] of Object.entries(styleSets)){
 const result=await transform(names.map(name=>files.get(name)).join('\n'),{loader:'css',minify:true,charset:'utf8',legalComments:'inline'});
 outputs.set(`optimized/${variant}.css`,result.code);
}
const hash=createHash('sha256');for(const [name,text] of [...files,...outputs].sort())hash.update(name+'\0'+text+'\0');
const version=hash.digest('hex').slice(0,24),prefix='/app-assets/'+version;
for(const [name,text] of [...files,...outputs]){const path='public'+prefix+'/'+name;await mkdir(posix.dirname(path),{recursive:true});await writeFile(path,text);}
let html=await readFile('public/unseen-app.template.html','utf8');
const initial=new Set();
function staticGraph(name){if(initial.has(name))return;initial.add(name);for(const dependency of bundled.metafile.outputs[name]?.imports||[]){if(dependency.kind==='import-statement'&&!dependency.external)staticGraph(dependency.path);}}
staticGraph('optimized/moment-app.js');
html=html.replace('<!-- APP_PRELOADS -->',[...initial].map(name=>`<link rel="modulepreload" href="${prefix}/${name}">`).join('\n'));
html=html.replaceAll('__APP_ASSETS__',prefix);
await writeFile('public/unseen-app.html',html);
const v2html=html.replaceAll('optimized/app.css','optimized/v2.css');
await writeFile('public/app-v2.html',v2html);
await mkdir('.task/app-loading',{recursive:true});
await writeFile('.task/app-loading/asset-build.json',JSON.stringify({version,prefix,files:[...files.keys(),...outputs.keys()],sourceFiles:[...files.keys()],bundles:[...outputs.keys()],preloads:[...initial],entry:'optimized/moment-app.js',styles:{app:'optimized/app.css',v2:'optimized/v2.css'},bytes:[...files.values(),...outputs.values()].reduce((n,s)=>n+Buffer.byteLength(s),0)},null,2)+'\n');
console.log(prefix,files.size+' source files',outputs.size+' optimized files',initial.size+' initial modules');
