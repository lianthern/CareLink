'use strict';
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const script=new vm.Script(fs.readFileSync(path.join(__dirname,'prototype.js'),'utf8'),{filename:'carelink-prototype.js'});
// The original prototype remains the rule authority. This DOM sink discards presentation only.
function createEngine(initial){
 const nodes=new Map(),jobs=[];
 function node(key=''){if(nodes.has(key))return nodes.get(key);const n={value:'',checked:false,innerHTML:'',textContent:'',dataset:{},style:{setProperty(){}},classList:{add(){},remove(){},toggle(){}},clientWidth:390,offsetWidth:390,appendChild(){},append(){},prepend(){},remove(){},insertAdjacentHTML(){},setAttribute(){},getAttribute(){return '';},addEventListener(){},querySelector:s=>node(key+' '+s),querySelectorAll:()=>[],closest:()=>null,click(){},focus(){}};nodes.set(key,n);return n;}
 const document={querySelector:node,querySelectorAll:()=>[],createElement:()=>node('element-'+Math.random()),getElementById:id=>node('#'+id),head:node('head'),body:node('body'),activeElement:{tagName:'BODY'},addEventListener(){}};
 const context={document,console:{log(){},warn(){},error(){}},setTimeout:fn=>(jobs.push(fn),jobs.length),clearTimeout(){},setInterval(){return 0;},clearInterval(){},addEventListener(){},ResizeObserver:class {observe(){}},innerWidth:1280,innerHeight:800,Math,Date,Promise,JSON};context.window=context;context.CareLinkProductMode=true;context.__CARELINK_HEADLESS__=true;
 vm.createContext(context);script.runInContext(context,{timeout:2000});
 const p=context.CareLinkPrototype;if(initial)p.setState(structuredClone(initial));
 async function drain(){let n=0;while(jobs.length&&n++<100)await jobs.shift()();jobs.length=0;}
 return {prototype:p,context,snapshot:()=>JSON.parse(JSON.stringify(p.state())),async call(name,...args){const result=await p[name](...args);await drain();return result;},set:state=>p.setState(structuredClone(state))};
}
module.exports={createEngine};
