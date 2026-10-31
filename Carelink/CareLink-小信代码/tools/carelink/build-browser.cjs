'use strict';
const fs=require('fs'),path=require('path');
const out=path.resolve(__dirname,'../../server/public/r15/carelink');
for(const name of ['keys','rules']) {
 const source=fs.readFileSync(path.resolve(__dirname,'../../server/carelink/'+name+'.js'),'utf8');
 const content='// Generated from server/carelink/'+name+'.js; run node tools/carelink/build-browser.cjs\n(function(root){ var module={exports:{}};\n'+source+'\nroot.CareLink'+(name==='keys'?'Keys':'Rules')+'=module.exports;\n})(window);\n';
 fs.writeFileSync(path.join(out,name+'.js'),content);
}
