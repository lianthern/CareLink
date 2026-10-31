import test from 'node:test';
import assert from 'node:assert/strict';
import {accessibleCreationText,photoStrip} from '../public/unseen-app-create.js';

test('accessible text keeps all legacy rounds and associates other photo words without markup injection',()=>{
 const html=accessibleCreationText({title:'Long <title>',photos:[{id:'a',alt:'Photo A'},{id:'b',alt:'Photo B'}],pairs:[{question:'First question',answer:'FIRST ORIGINAL'},{question:'Second question',answer:'SECOND\nORIGINAL'},{photoId:'b',question:'B question',answer:'<script>PRIVATE WORDS</script>'}]});
 assert.match(html,/FIRST ORIGINAL/);assert.match(html,/SECOND\nORIGINAL/);assert.match(html,/&lt;script&gt;PRIVATE WORDS&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>/);
 assert(html.indexOf('第 2 张照片')<html.indexOf('PRIVATE WORDS'));
 assert.match(html,/Long &lt;title&gt;/);
});

test('selected photo stays announced when restored main-photo metadata is a separate object',()=>{
 const html=photoStrip({photos:[{id:'a',src:'data:a'},{id:'b',src:'data:b'}],photo:{id:'b',src:'data:b',ownership:'user'}});
 assert.match(html,/data-app-photo="0"[^>]*aria-pressed="false"/);
 assert.match(html,/data-app-photo="1"[^>]*aria-pressed="true"/);
});
