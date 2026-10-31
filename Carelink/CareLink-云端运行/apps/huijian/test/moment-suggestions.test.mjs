import test from 'node:test';
import assert from 'node:assert/strict';
import { fallbackMomentSuggestions, normalizeMomentSuggestions, suggestionsHtml } from '../public/moment-suggestions.js';

const safe = [
  { label: '聊聊人物', text: '我可以说说我记得的人。' },
  { label: '记不清', text: '我现在只记得一些片段。' },
  { label: '换个方向', text: '我想从另一个细节说起。' },
  { label: '先讲经过', text: '我可以先讲我记得的经过。' }
];

test('normalization exposes only three or four short unique label/text choices', () => {
  assert.deepEqual(normalizeMomentSuggestions(safe).length, 4);
  assert.equal(normalizeMomentSuggestions(safe.slice(0, 2)).length, 0);
  assert.equal(normalizeMomentSuggestions([...safe.slice(0, 2), safe[0]]).length, 0);
  assert.equal(normalizeMomentSuggestions([...safe, { label: '第五项', text: '我愿意继续聊。' }]).length, 4);
  assert.equal(normalizeMomentSuggestions([{ label: 'x'.repeat(15), text: '短句' }, ...safe.slice(0, 2)]).length, 0);
});

test('untrusted markup and unsupported first-person facts discard the model set', () => {
  const markup = [{ label: '<img src=x>', text: '点我' }, ...safe.slice(0, 2)];
  assert.deepEqual(normalizeMomentSuggestions(markup), []);
  const invented = [
    { label: '人物', text: '我和哥哥在杭州吃了生日晚饭。' },
    ...safe.slice(1, 3)
  ];
  assert.deepEqual(normalizeMomentSuggestions(invented), []);
  const history = [{ role: 'user', text: '我和哥哥在杭州吃了生日晚饭。' }];
  assert.equal(normalizeMomentSuggestions(invented, history).length, 3);
  assert.match(suggestionsHtml(invented, { history }), /我和哥哥在杭州吃了生日晚饭/u);
  const mostlySafe = [
    { label: '朋友', text: '当时是和几个朋友一起。' },
    { label: '家人', text: '是家人一起吃饭。' },
    { label: '同事', text: '是和同事一起的。' },
    { label: '记不清', text: '记不太清对方是谁了。' }
  ];
  assert.deepEqual(normalizeMomentSuggestions(mostlySafe).map(item => item.label), ['朋友', '同事', '记不清']);
  assert.deepEqual(normalizeMomentSuggestions([
    { label: '杭州', text: '是在杭州拍的。' }, ...safe.slice(0, 3)
  ]).map(item => item.label), safe.slice(0, 3).map(item => item.label));
});

test('fallback choices change with the current question, avoid concrete facts and rotate past an answered fallback', () => {
  const person = fallbackMomentSuggestions('照片里的人和你是什么关系？');
  const time = fallbackMomentSuggestions('这大概是什么时候？');
  assert.equal(person.length, 4); assert.equal(time.length, 4);
  assert.notDeepEqual(person, time);
  assert.ok([...person, ...time].every(item => !/杭州|哥哥|生日|晚饭|\d{4}/u.test(item.text)));
  assert.deepEqual(person.map(item => item.label), ['朋友', '家人', '同事', '记不清']);
  assert.deepEqual(fallbackMomentSuggestions('你当时是什么感受？').map(item => item.label), ['轻松', '开心', '有点不舍', '说不清']);
  assert.ok(person.every(item => !/我可以说说|我想聊聊/u.test(item.text)));
  const rotated = fallbackMomentSuggestions('照片里的人是谁？', [{ role: 'user', text: person[0].text }]);
  assert.ok(!rotated.some(item => item.text === person[0].text));
});

test('button HTML escapes attributes and labels and never makes a submit control', () => {
  const value = [
    { label: '聊聊“人物” & 更多', text: '我愿意聊聊 "当时" & 后来。' },
    ...safe.slice(1, 3)
  ];
  const html = suggestionsHtml(value, { disabled: true });
  assert.match(html, /type="button"/u); assert.match(html, /data-action="suggestion"/u);
  assert.match(html, /&quot;当时&quot; &amp; 后来/u); assert.match(html, / disabled/u);
  assert.doesNotMatch(html, /type="submit"|<script/u);
});
