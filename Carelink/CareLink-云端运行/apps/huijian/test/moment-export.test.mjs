import test from 'node:test';
import assert from 'node:assert/strict';
import { createMomentExport, momentExportSnapshot, layoutMomentExport, photoDimensions, MOMENT_EXPORT_LIMITS } from '../public/moment-export.js';

const png=new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64')],{type:'image/png'});
const audio=new Blob([new Uint8Array([82,73,70,70,4,0,0,0,87,65,86,69])],{type:'audio/wav'});
const fixture=()=>({id:'private-moment-id',accountId:'private-owner-id',title:'一晚 <长桌> 🎂',createdAt:'2026-09-06T00:00:00Z',photos:[{id:'secret-photo-id',url:'/v1/moment-media/private-photo-id'}],messages:[{role:'assistant',text:'DO NOT EXPORT THE AI QUESTION'},{role:'user',text:'我们聊到了深夜。\n\n我记得👨‍👩‍👧‍👦，还有 e\u0301。<script>bad()</script>',audio:{mediaId:'secret-audio-id'}}]});

test('offline archive includes exact original photo/audio bytes, only the user words, and no identifiers or remote media URLs',async()=>{
  const calls=[];const moment=fixture();
  const result=await createMomentExport({moment,format:'html',readMedia:async(ref,{kind})=>{calls.push(kind);return kind==='photo'?png:audio;},isCurrent:()=>true});
  const html=await result.files[0].blob.text();
  assert.deepEqual(calls,['photo','audio']);assert.equal(result.photoCount,1);assert.equal(result.audioCount,1);
  assert.match(html,/我们聊到了深夜。\n\n我记得👨‍👩‍👧‍👦，还有 é。&lt;script&gt;bad\(\)&lt;\/script&gt;/u);
  assert.doesNotMatch(html,/private-moment-id|private-owner-id|secret-photo-id|secret-audio-id|DO NOT EXPORT|\/v1\/|<script>/u);
  const embedded=[...html.matchAll(/src="data:([^;]+);base64,([A-Za-z0-9+/=]+)"/gu)];
  assert.equal(embedded.length,2);assert.deepEqual(Buffer.from(embedded[0][2],'base64'),Buffer.from(await png.arrayBuffer()));assert.deepEqual(Buffer.from(embedded[1][2],'base64'),Buffer.from(await audio.arrayBuffer()));
  assert.match(html,/default-src 'none'/u);assert.match(html,/media-src data:/u);assert.match(result.files[0].name,/\.html$/u);
});

test('empty memories fail, photos-only and voice-only archives work, and missing media never produce a partial export',async()=>{
  assert.throws(()=>momentExportSnapshot({photos:[],messages:[{role:'assistant',text:'question'}]}),{code:'export_empty'});
  const photoOnly=await createMomentExport({moment:{photos:[{}]},format:'html',readMedia:async()=>png});assert.equal(photoOnly.photoCount,1);assert.equal(photoOnly.audioCount,0);
  const voiceOnly=await createMomentExport({moment:{messages:[{role:'user',audio:{}}]},format:'html',readMedia:async()=>audio});assert.equal(voiceOnly.photoCount,0);assert.equal(voiceOnly.audioCount,1);
  await assert.rejects(createMomentExport({moment:fixture(),format:'html',readMedia:async(_,o)=>o.kind==='photo'?png:null}),{code:'export_media_unavailable'});
  await assert.rejects(createMomentExport({moment:fixture(),format:'html',readMedia:async()=>new Blob(['<svg/>'],{type:'image/svg+xml'})}),{code:'export_photo_type'});
  await assert.rejects(createMomentExport({moment:fixture(),format:'html',readMedia:async()=>new Blob(['not an image'],{type:'image/png'})}),{code:'export_image_failed'});
  const typed=await createMomentExport({moment:{photos:[{}]},format:'html',readMedia:async()=>new Blob([png],{type:'image/png;untrusted="injected-attribute"'})});
  assert.doesNotMatch(await typed.files[0].blob.text(),/injected-attribute/u);
});

test('switching accounts while media is reading discards the result and never asks for the next private asset',async()=>{
  let current=true,complete,calls=0;
  const exporting=createMomentExport({moment:fixture(),format:'html',isCurrent:()=>current,readMedia:()=>{calls++;return new Promise(resolve=>complete=resolve);}});
  await new Promise(resolve=>setImmediate(resolve));current=false;complete(png);
  await assert.rejects(exporting,{name:'AbortError'});assert.equal(calls,1);
});

test('abort does not wait for a stuck media reader and frozen export data is unaffected by subsequent edits',async()=>{
  const controller=new AbortController();let start;
  const began=new Promise(resolve=>start=resolve);
  const exporting=createMomentExport({moment:fixture(),format:'html',signal:controller.signal,readMedia:()=>{start();return new Promise(()=>{});}});
  await began;controller.abort();await assert.rejects(exporting,{name:'AbortError'});
  const moment=fixture();let release;
  const pending=createMomentExport({moment,format:'html',readMedia:(_,o)=>o.kind==='photo'?new Promise(resolve=>release=resolve):audio});
  await new Promise(resolve=>setImmediate(resolve));moment.title='later secret title';moment.messages[1].text='later secret words';release(png);
  const html=await (await pending).files[0].blob.text();assert.doesNotMatch(html,/later secret/u);assert.match(html,/我们聊到了深夜/u);
});

test('long Unicode text is fully retained across bounded pages without splitting grapheme clusters or cropping photos',()=>{
  const family='👨‍👩‍👧‍👦',combined='e\u0301';
  const original=('这是一段需要完整保留的回忆'+family+combined).repeat(1800);
  const snapshot=momentExportSnapshot({title:'回忆',photos:[{},{}],messages:[{role:'user',text:original}]});
  const context={measureText:text=>({width:[...new Intl.Segmenter('zh',{granularity:'grapheme'}).segment(text)].length*30})};
  const sizes=[{width:4000,height:1000},{width:1000,height:4000}];
  const pages=layoutMomentExport(snapshot,sizes,context);assert.ok(pages.length>2);
  assert.ok(pages.every(p=>p.width===1080&&p.height<=2160));
  const commands=pages.flatMap(p=>p.commands),text=commands.filter(c=>c.kind==='text'&&c.font.startsWith('32px')).map(c=>c.text);
  assert.equal(text.join(''),original);
  assert.ok(text.every(line=>!line.startsWith('\u200d')&&!line.endsWith('\u200d')&&!line.startsWith('\u0301')));
  for(const image of commands.filter(c=>c.kind==='image')){assert.equal(image.width/image.height,sizes[image.index].width/sizes[image.index].height);assert.ok(image.y+image.height<=2060);}
});

test('input and canvas bounds reject extreme content explicitly instead of truncating or allocating an unbounded canvas',()=>{
  assert.throws(()=>momentExportSnapshot({messages:[{role:'user',text:'文'.repeat(MOMENT_EXPORT_LIMITS.text+1)}]}),{code:'export_too_large'});
  const snapshot=momentExportSnapshot({messages:[{role:'user',text:'长'.repeat(4000)}]});
  assert.throws(()=>layoutMomentExport(snapshot,[],{measureText:text=>({width:text.length*2000})}),{code:'export_too_many_pages'});
  const corrupt=new Uint8Array(24);corrupt.set([137,80,78,71]);const view=new DataView(corrupt.buffer);view.setUint32(16,32768);view.setUint32(20,32768);
  assert.throws(()=>photoDimensions(corrupt),{code:'export_image_failed'});
});

test('older browsers without Intl.Segmenter keep joined emoji, accents, skin tones and flag pairs together',()=>{
  const prior=Intl.Segmenter;Intl.Segmenter=undefined;
  try{
    const original='👨‍👩‍👧‍👦e\u0301👍🏽🇨🇳'.repeat(10),snapshot=momentExportSnapshot({messages:[{role:'user',text:original}]});
    const lines=layoutMomentExport(snapshot,[],{measureText:text=>({width:Array.from(text).length*200})}).flatMap(p=>p.commands).filter(c=>c.kind==='text'&&c.font.startsWith('32px')).map(c=>c.text);
    assert.equal(lines.join(''),original);assert.ok(lines.every(line=>!line.startsWith('\u200d')&&!line.endsWith('\u200d')&&!line.startsWith('\u0301')&&!line.startsWith('🏽')));
  }finally{Intl.Segmenter=prior;}
});

test('PNG generation waits for fonts and aborts before any canvas allocation when the account changes',async()=>{
  const prior=globalThis.document;let ready,allocations=0,current=true;
  globalThis.document={fonts:{load:async()=>[],ready:new Promise(resolve=>ready=resolve)},createElement:()=>{allocations++;throw new Error('canvas must not be allocated');}};
  try{const exporting=createMomentExport({moment:{messages:[{role:'user',text:'只有原话'}]},format:'png',readMedia:async()=>png,isCurrent:()=>current});await new Promise(resolve=>setImmediate(resolve));assert.equal(allocations,0);current=false;ready();await assert.rejects(exporting,{name:'AbortError'});assert.equal(allocations,0);}
  finally{if(prior===undefined)delete globalThis.document;else globalThis.document=prior;}
});
