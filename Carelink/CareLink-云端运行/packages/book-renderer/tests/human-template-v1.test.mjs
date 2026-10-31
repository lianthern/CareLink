import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixtureBundle,resolveFixtureAsset} from '../fixtures/frozen-book-fixture.mjs';
import {manifestSemanticHash} from '../src/canonical.mjs';
import {renderCanonicalHtml,buildRenderReceipt} from '../src/render.mjs';
import {printExactHtmlToPdf} from '../src/pdf.mjs';

test('v1 uses human-readable HTML and PDF body while v0 retains the frozen HTML bytes',async()=>{
 const legacy=renderCanonicalHtml(fixtureBundle.manifest,resolveFixtureAsset,'fixture');
 assert.equal(legacy.htmlHash,'b06786fd229bee4721d31532a2a17c8d88f6d9dc0adb47466b1d6b38aeb9d7cd');
 const manifest=structuredClone(fixtureBundle.manifest);manifest.templateVersion='book-lab-v1';
 manifest.manifestHash=manifestSemanticHash(manifest);
 const current=renderCanonicalHtml(manifest,resolveFixtureAsset,'fixture');
 assert.notEqual(current.htmlHash,legacy.htmlHash);
 assert.ok(current.html.includes(`data-page-id="${manifest.pages[0].pageId}"`));
 const bodyText=current.html.replace(/<style>[\s\S]*?<\/style>/g,'').replace(/<aside[\s\S]*?<\/aside>/g,'').replace(/<[^>]*>/g,'');
 for(const page of manifest.pages){assert.ok(!bodyText.includes(page.pageId));if(page.sourcePhotoId)assert.ok(!bodyText.includes(page.sourcePhotoId));}
 assert.ok(!bodyText.includes('nodeId='));
 const directory=await mkdtemp(join(tmpdir(),'unseen-human-template-v1-'));
 try{
 const pdfPath=join(directory,'v1.pdf');
 const pdf=await printExactHtmlToPdf({html:current.html,htmlPath:join(directory,'v1.html'),pdfPath,
 orderedPageIds:current.equality.orderedPageIds,pageOrderMarkers:current.pageOrderMarkers,canonicalTimestamp:manifest.frozenAt});
 assert.equal(pdf.pageCount,manifest.pages.length);assert.equal(pdf.orderedMarkersVerified,true);
 assert.equal(buildRenderReceipt(manifest,current,pdf,'fixture').html.contentHash,current.htmlHash);
 const extracted=spawnSync('pdftotext',['-layout',pdfPath,'-'],{encoding:'utf8'});
 assert.equal(extracted.status,0);
 for(const page of manifest.pages){assert.ok(!extracted.stdout.includes(page.pageId));if(page.sourcePhotoId)assert.ok(!extracted.stdout.includes(page.sourcePhotoId));}
 assert.ok(!extracted.stdout.includes('nodeId='));
 assert.ok(extracted.stdout.includes('确定性本地样本'));
 for(const text of manifest.authorizedMemoryTexts){assert.ok(extracted.stdout.includes(text.authorCredit));assert.ok(extracted.stdout.replace(/\s/g,'').includes(text.originalUserText.replace(/\s/g,'')), text.originalUserText);}
 }finally{await rm(directory,{recursive:true,force:true});}
});
