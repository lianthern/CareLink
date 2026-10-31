import { normalizeContent, commitAnswer, contentSnapshot } from '../public/unseen-content.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { createMemoryRepository, MEMORY_STORE_NAMES } from '../public/memory-store.js';

const cwd = new URL('..', import.meta.url).pathname;
const source = readFileSync(`${cwd}/public/unseen-demo.js`, 'utf8');
const part = (start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert(from >= 0 && to > from, `${start}: source markers exist`);
  return source.slice(from, to);
};
const helper = readFileSync(`${cwd}/test/memory-store.test.mjs`, 'utf8');
const adapterSource = helper.slice(helper.indexOf('function createMemoryAdapter()'));
const adapterContext = vm.createContext({ MEMORY_STORE_NAMES, structuredClone });
vm.runInContext(adapterSource, adapterContext);
const store = createMemoryRepository(adapterContext.createMemoryAdapter(), { currentYear: 2026 });
await store.ensureDefaultCollection();

const makeState = () => ({ screen: 'home', requestId: 0, answer: '', answerDraft: '', question: '', questionStatus: 'idle', memoryId: null, photo: null, source: '', spaceMode: 'instant', memories: [] });
const context = vm.createContext({
  state: makeState(),normalizeContent,commitAnswer,contentSnapshot,
  memoryStorePromise: Promise.resolve(store),
  voiceInput: { cancel() {} },
  turnVoice: { clear() {} },
  render() {},
  showToast() {},
  openOverlay() {},
  document: { querySelector() { return null; } },
  navigate(screen) { context.state.screen = screen; },
  console, structuredClone, Date, AbortController, setTimeout, clearTimeout,
  persistDraft() {}, async refreshMemories() {},
  invalidateQuestion() { context.state.requestId += 1; },
});
const funcs = [
  part('function isUserOwnedPhoto(', 'function formatDate('),
  part('function currentMemoryInput()', '\ndocument.addEventListener("click"'),
  part('async function startDialogue(', '\nfunction renderVoiceChrome('),
  part('async function saveNavigationState()', '\nasync function takeNavigationState('),
  part('async function restoreNavigationState()', '\nasync function openDap(')
];
vm.runInContext('let questionController = null;\n' + funcs.join('\n'), context);

const before = await store.saveMemory({
  id: 'audit-existing-zine',
  photos: [
    { id: 'upload:1', src: 'data:image/jpeg;base64,one', capturedAt: 1 },
    { id: 'upload:2', src: 'data:image/jpeg;base64,two', capturedAt: 2 }
  ],
  pairs: [ { question: '第一问', answer: '第一段原话' }, { question: '第二问', answer: '第二段原话' } ],
  resultShape: 'zine'
});
context.saveNavigationState = async () => {};
await context.restoreMemory(before.id);
commitAnswer(context.state,'在新入口修改最后一句');
await context.saveMemory();
const after = await store.getMemory(before.id);
assert.equal(after.photos.length, 2);
assert.deepEqual(after.photos.map(({pairs,...photo})=>photo), before.photos);
assert.equal(after.pairs.length, 2);
assert.equal(after.pairs[0].question, before.pairs[0].question);
assert.equal(after.pairs[0].answer, before.pairs[0].answer);
assert.equal(after.createdAt, before.createdAt);
assert.equal(after.resultShape, 'zine');
console.log(JSON.stringify({ case: 'legacy-zine-overwrite', before: { photos: before.photos.length, pairs: before.pairs.length, shape: before.resultShape }, after: { photos: after.photos.length, pairs: after.pairs.length, shape: after.resultShape } }));

vm.runInContext(part('async function saveNavigationState()', '\nasync function takeNavigationState('), context);
let navigationRecord;
context.openNavigationDb = async () => ({
  transaction() {
    const tx = { objectStore: () => ({ put(record) { navigationRecord = structuredClone(record); queueMicrotask(() => tx.oncomplete?.()); } }) };
    return tx;
  },
  close() {}
});
context.takeNavigationState = async () => navigationRecord;
context.state.question = '尚未保存的问题';
context.state.answer = '尚未保存的原话';
await context.saveNavigationState();
context.state = makeState();
await context.restoreNavigationState();
assert(context.state.photo);
assert.equal(context.state.answer, '尚未保存的原话');
assert.equal(context.state.question, '尚未保存的问题');
console.log(JSON.stringify({ case: 'spatial-return-loses-draft', savedKeys: Object.keys(navigationRecord), restoredPhoto: Boolean(context.state.photo), restoredQuestion: context.state.question, restoredAnswer: context.state.answer }));

let releaseFetch;
context.fetch = () => new Promise(resolve => { releaseFetch = resolve; });
context.state.photo = { ownership: 'user', src: 'data:image/jpeg;base64,new', dataUrl: 'data:image/jpeg;base64,new', capturedAt: 3 };
const inFlight = context.startDialogue();
await context.restoreMemory(before.id);
const restoredQuestion = context.state.question;
const restoredAnswer = context.state.answer;
releaseFetch({ ok: true, json: async () => ({ question: '另一张照片迟到的问题', facts: ['另一张照片的事实'] }) });
await inFlight;
assert.equal(context.state.question, restoredQuestion);
assert.equal(context.state.answer, restoredAnswer);
console.log(JSON.stringify({ case: 'late-question-corrupts-restored-memory', restoredQuestion, actualQuestion: context.state.question, retainedAnswer: context.state.answer, requestId: context.state.requestId }));

console.log('All three defects prevented against current source functions plus actual memory repository. This is a deterministic function harness, not browser acceptance. No external API calls or user data access.');
