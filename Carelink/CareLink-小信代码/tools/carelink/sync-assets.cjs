const fs=require('fs'),path=require('path');
const source=path.resolve(__dirname,'../../server/public/r15'),target=path.resolve(__dirname,'../../native/unseen-y1max-os-p5-20261018/frame-source/assets/web/r15');
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name),out=path.join(target,path.relative(source,p));if(e.isDirectory())walk(p);else if(!fs.existsSync(out)||!fs.readFileSync(p).equals(fs.readFileSync(out))){fs.mkdirSync(path.dirname(out),{recursive:true});fs.copyFileSync(p,out);}}}walk(source);
