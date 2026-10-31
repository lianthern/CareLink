import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../public/spatial-lab.js',import.meta.url),'utf8');
function extract(start,end){return source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));}
function fixture(){
 const element=()=>({disabled:false,hidden:false,value:'',textContent:'',replaceChildren(){},classList:{add(){},remove(){}}});
 const ctx=vm.createContext({dialogueGeneration:0,dialogueRound:3,dialogueBusy:true,dialogueClarity:1,dialogueClarityTarget:1,dialogueAnswers:[],dialogueFocus:{},dialogueFocusTarget:{},dialogueLog:element(),dialogueForm:element(),dialogueAnswer:element(),startDialogueButton:element(),sendDialogueButton:element(),dialogueStatus:element(),addDialogueMessage(){},updateDialogueMeter(){},methodStatus:element(),viewer:element(),canvas:element(),fallbackImage:element(),renderer:null,fieldGroup:null,photoData:null,dialoguePhoto:null,startCount:0,setPhase(){},loadImage:async value=>value,buildPhotoData:image=>({source:{toDataURL:()=>`data:${image}`}})});
 ctx.startDialogue=()=>{ctx.startCount++;};
 vm.runInContext(extract('function resetDialogue()', 'function normalizeFocus(')+'\n'+extract('async function rebuild(', 'function initRenderer('),ctx);return ctx;
}
test('real reset restores editable input after three rounds or an in-flight previous photo',()=>{
 const ctx=fixture();ctx.dialogueAnswer.disabled=true;ctx.resetDialogue();assert.equal(ctx.dialogueAnswer.disabled,false);assert.equal(ctx.dialogueBusy,false);assert.equal(ctx.dialogueRound,0);
});
test('real rebuild without WebGL prepares current photo and starts text dialogue',async()=>{
 const ctx=fixture();await ctx.rebuild('photo-A');assert.equal(ctx.dialoguePhoto.dataUrl,'data:photo-A');assert.equal(ctx.fallbackImage.src,'photo-A');assert.equal(ctx.canvas.hidden,true);assert.equal(ctx.startCount,1);
});
test('slower old image decode cannot replace a newer static dialogue photo',async()=>{
 const ctx=fixture(),pending=new Map();ctx.loadImage=src=>new Promise(resolve=>pending.set(src,resolve));
 const old=ctx.rebuild('old'),current=ctx.rebuild('current');pending.get('current')('current');await current;pending.get('old')('old');await old;
 assert.equal(ctx.dialoguePhoto.dataUrl,'data:current');assert.equal(ctx.startCount,1);
});
