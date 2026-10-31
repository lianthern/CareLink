import { normalizeContent, commitAnswer, contentSnapshot } from '../public/unseen-content.js';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createMemoryRepository, MEMORY_STORE_NAMES } from '../public/memory-store.js';
import { createMemoryRecord } from '../public/memory-product.js';
import { makeBook } from '../public/unseen-app-create.js';

const cwd=new URL('..',import.meta.url).pathname;
const source=readFileSync(`${cwd}/public/unseen-app.js`,'utf8');
const part=(a,b)=>{const i=source.indexOf(a),j=source.indexOf(b,i+a.length);assert(i>=0&&j>i);return source.slice(i,j);};
const helper=readFileSync(`${cwd}/test/memory-store.test.mjs`,'utf8');
const ac=vm.createContext({MEMORY_STORE_NAMES,structuredClone});vm.runInContext(helper.slice(helper.indexOf('function createMemoryAdapter()')),ac);
const store=createMemoryRepository(ac.createMemoryAdapter(),{currentYear:2026});await store.ensureDefaultCollection();
const listeners={};let editedText='';
const state={requestId:0,memoryId:null,photos:[],pairs:[],question:'',answer:'',answerDraft:'',visibleFacts:[],resultShape:'zine',styleId:'quiet-white',title:'',screen:'home',history:[],createdAt:Date.now(),activePairIndex:-1};
const cx=vm.createContext({state,cloudEpoch:0,normalizeContent,commitAnswer,contentSnapshot,structuredClone,Date,AbortController,setTimeout,clearTimeout,console,
  memoryStorePromise:Promise.resolve(store),voiceInput:{cancel(){}},turnVoice:{clear(){},stop(){}},render(){},showToast(){},openOverlay(){},persistDraft(){},refreshMemories:async()=>{},saveNavigationState:async()=>{},
  navigate(screen){state.screen=screen;},invalidateQuestion(){state.requestId++;},
  document:{addEventListener(type,handler){(listeners[type]||=[]).push(handler);},querySelector(selector){return selector==='#dialogue-input'?{value:editedText}:null;}}
});
vm.runInContext(part('function isUserOwnedPhoto(', 'function formatDate(')+'\n'+part('function currentMemoryInput()', '\ndocument.addEventListener("click"')+'\n'+part('document.addEventListener("submit"', '\nfor (const [input, source]'),cx);
const submit=(text)=>{editedText=text;listeners.submit[0]({preventDefault(){},target:{matches(){return true;}}});};
const photos=[{id:'upload:a',src:'data:image/jpeg;base64,a',capturedAt:1},{id:'upload:b',src:'data:image/jpeg;base64,b',capturedAt:2}];
const legacy=await store.saveMemory({id:'legacy',photos,pairs:[{question:'A-first-question',answer:'A-FIRST-ORIGINAL'},{question:'A-second-question',answer:'A-SECOND-ORIGINAL'}],resultShape:'zine',styleId:'quiet-white'});
await cx.restoreMemory(legacy.id);
submit('A-SECOND-EDITED');
await cx.saveMemory();
const legacyAfter=await store.getMemory(legacy.id);
const book=makeBook(state);const texts=book.pages.filter(p=>p.source==='user').map(p=>p.text);
assert.equal(legacyAfter.pairs[0].answer,'A-FIRST-ORIGINAL');
assert(texts.includes('A-FIRST-ORIGINAL'));assert(texts.includes('A-SECOND-EDITED'));
console.log(JSON.stringify({case:'legacy-edit-omits-earlier-story-in-zine',storedAnswers:legacyAfter.pairs.map(p=>p.answer),exportedTextPages:texts}));

const tagged=await store.saveMemory({id:'tagged',photos,pairs:[{photoId:'upload:a',question:'PHOTO-A-Q',answer:'PHOTO-A-ORIGINAL'},{photoId:'upload:b',question:'PHOTO-B-Q',answer:'PHOTO-B-ORIGINAL'}],resultShape:'zine'});
await cx.restoreMemory(tagged.id);
state.photo=state.photos[0];state.activePairIndex=0;state.question='PHOTO-A-Q';state.answer='PHOTO-A-ORIGINAL';
submit('PHOTO-A-EDITED');await cx.saveMemory();
const firstSave=await store.getMemory(tagged.id);
await cx.restoreMemory(tagged.id);
state.title='Only rename this work';state.saved=false;
await cx.saveMemory();
const secondSave=await store.getMemory(tagged.id);
assert.equal(firstSave.pairs[1].answer,'PHOTO-B-ORIGINAL');
assert.equal(secondSave.pairs[1].answer,'PHOTO-B-ORIGINAL');
assert.equal(secondSave.pairs[1].photoId,'upload:b');
console.log(JSON.stringify({case:'reopen-and-rename-overwrites-other-photo-answer',before:firstSave.pairs,after:secondSave.pairs}));

const oldInput=createMemoryRecord({id:tagged.id,collectionId:firstSave.collectionId,photos:firstSave.photos,facts:firstSave.facts,pairs:firstSave.pairs,resultShape:firstSave.resultShape,styleId:firstSave.styleId,createdAt:new Date().toISOString()});
await store.saveMemory(oldInput);const oldResaved=await store.getMemory(tagged.id);
assert.equal(oldResaved.pairs[0].photoId,'upload:a');assert.equal(oldResaved.photos[0].pairs[0].answer,'PHOTO-A-EDITED');
console.log(JSON.stringify({case:'legacy-full-editor-drops-new-photo-relations',beforePairs:firstSave.pairs,afterPairs:oldResaved.pairs,afterPhotoKeys:Object.keys(oldResaved.photos[0])}));

console.log('All review counterexamples are now prevented using current actual functions, actual submit handler, createMemoryRecord, makeBook and repository with isolated in-memory adapter. No browser, external services or user records touched.');

await cx.restoreMemory(tagged.id);
state.pageAspect='landscape';state.saved=false;await cx.saveMemory();
await cx.restoreMemory(tagged.id);
assert.equal(state.pageAspect,'landscape');
assert.equal(makeBook(state).ratio,'4:3');
const beforeLegacyRatio=await store.getMemory(tagged.id);
await store.saveMemory(createMemoryRecord({...beforeLegacyRatio,createdAt:new Date().toISOString()}));
const afterLegacyRatio=await store.getMemory(tagged.id);
assert.equal(afterLegacyRatio.pageAspect,'landscape');
assert.equal(afterLegacyRatio.createdAt,beforeLegacyRatio.createdAt);
assert.deepEqual(afterLegacyRatio.pairs,beforeLegacyRatio.pairs);
console.log(JSON.stringify({case:'manual-ratio-survives-save-reopen-and-legacy-edit',ratio:makeBook(state).ratio}));

// Additional real draft/handler/store counterexample: reload before sending a new round.
// Only storage, DOM and AI transport boundaries are replaced; actual app functions run.
let navigationRecord;
const session = new Map();
cx.sessionStorage = { getItem:key=>session.get(key)??null, setItem:(key,value)=>session.set(key,value) };
cx.openNavigationDb = async () => ({
  transaction() {
    const tx = { objectStore: () => ({
      put(record) { navigationRecord=structuredClone(record);queueMicrotask(()=>tx.oncomplete?.()); },
      get() { const request={};queueMicrotask(()=>{request.result=structuredClone(navigationRecord);request.onsuccess?.();tx.oncomplete?.();});return request; }
    }) };return tx;
  },close(){}
});
cx.fetch=async()=>({ok:true,json:async()=>({question:'SECOND-QUESTION',facts:[]})});
cx.document.querySelector=selector=>selector==='#dialogue-input'?{value:editedText,focus(){}}:null;
vm.runInContext('let questionController=null;let draftTimer=null;\n'+
  part('function persistDraft()', '\nlet voiceBaseText')+'\n'+
  part('async function saveNavigationState()', '\nasync function openDap(')+'\n'+
  part('async function startDialogue(', '\nfunction renderVoiceChrome(')+'\n'+
  part('document.addEventListener("input"', '\ndocument.addEventListener("submit"'),cx);
const oneRound=await store.saveMemory({id:'draft-two-rounds',photos:[photos[0]],pairs:[{question:'FIRST-QUESTION',answer:'FIRST-ORIGINAL'}],resultShape:'memory-page'});
await cx.restoreMemory(oneRound.id);
await cx.startDialogue(true);
listeners.input[0]({target:{id:'dialogue-input',value:'SECOND-DRAFT',matches:()=>true}});
await cx.saveNavigationState();
vm.runInContext('clearTimeout(draftTimer)',cx);
const persisted={activePairIndex:navigationRecord.draft.activePairIndex,activePairId:navigationRecord.draft.activePairId,answers:navigationRecord.draft.pairs.map(p=>p.answer)};
for(const key of Object.keys(state))delete state[key];
Object.assign(state,{requestId:0,photos:[],pairs:[],screen:'home',history:[],answer:'',answerDraft:'',question:'',activePairIndex:-1});
assert(await cx.restoreNavigationState());
const restored={activePairIndex:state.activePairIndex,activePairId:state.activePairId,question:state.question,draft:state.answerDraft};
submit('SECOND-DRAFT');
await cx.saveMemory();
vm.runInContext('clearTimeout(draftTimer)',cx);
const afterReload=await store.getMemory(oneRound.id);
// A new unsent round must remain distinct from editing an existing pair.
assert.equal(persisted.activePairIndex,-1);
assert.equal(restored.activePairIndex,-1);
assert.equal(restored.activePairId,null);
assert.deepEqual(afterReload.pairs.map(p=>p.answer),['FIRST-ORIGINAL','SECOND-DRAFT']);
console.log(JSON.stringify({case:'F-A5-PASS-new-round-draft-refresh-preserves-prior-round',persisted,restored,afterPairs:afterReload.pairs,expectedAnswers:['FIRST-ORIGINAL','SECOND-DRAFT']}));

// Existing-pair editing takes the opposite branch through the real editor handler.
await cx.restoreMemory(oneRound.id);
vm.runInContext(part("document.addEventListener('click',event=>{\n const button=event.target.closest('[data-app-edit-pair]')",'\ndocument.addEventListener("click", (event) => {'),cx);
listeners.click.at(-1)({target:{closest:()=>({dataset:{appEditPair:'0'}})}});
listeners.input[0]({target:{id:'dialogue-input',value:'FIRST-EDITED-AFTER-REFRESH',matches:()=>true}});
await cx.saveNavigationState();vm.runInContext('clearTimeout(draftTimer)',cx);
for(const key of Object.keys(state))delete state[key];
Object.assign(state,{requestId:0,photos:[],pairs:[],screen:'home',history:[],answer:'',answerDraft:'',question:'',activePairIndex:-1});
assert(await cx.restoreNavigationState());assert.equal(state.pendingNewAnswer,false);assert.equal(state.activePairIndex,0);
submit('FIRST-EDITED-AFTER-REFRESH');await cx.saveMemory();vm.runInContext('clearTimeout(draftTimer)',cx);
assert.deepEqual((await store.getMemory(oneRound.id)).pairs.map(p=>p.answer),['FIRST-EDITED-AFTER-REFRESH','SECOND-DRAFT']);
console.log('F-A5-PASS existing-pair edit draft refresh updates original id without appending or losing the second round');
