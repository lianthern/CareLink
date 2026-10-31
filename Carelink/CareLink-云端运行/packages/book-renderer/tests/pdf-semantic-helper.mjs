import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { sha256 } from '../src/canonical.mjs';

const compact = value => String(value).normalize('NFC').replace(/\s/gu, '');

// Browser releases may change PDF font subsets/vector serialization. The contract remains
// the exact frozen input, every original word and attribution on its own page, and order.
export function assertFixturePageText(pages, manifest) {
  assert.equal(pages.length, manifest.pages.length, 'PDF page count differs from the frozen manifest');
  const byId = new Map(manifest.authorizedMemoryTexts.map(text => [text.authorizedMemoryTextId, text]));
  for (const [index, page] of manifest.pages.entries()) {
    const content = compact(pages[index]);
    const contains = (text, label) => assert.ok(content.includes(compact(text)), `PDF page ${index + 1} lost ${label}`);
    contains(page.pageId, 'its page/source order marker');
    contains(`${index + 1} / ${pages.length}`, 'its page number');
    if (page.kind === 'cover') contains(manifest.title, 'the frozen title');
    if (page.kind === 'closing') contains('记得不同，也可以一起留下。', 'the closing text');
    if (page.authorizedMemoryTextId) {
      const text = byId.get(page.authorizedMemoryTextId);
      assert.ok(text, 'page references a missing authorized original');
      contains(text.originalUserText, 'the complete original user words');
      contains(`—${text.authorCredit}`, 'the author attribution');
      contains(text.questionProvenance.at(-1).question, 'the question');
      contains(`来源记录${page.sourcePhotoId}`, 'its source photograph');
      contains(`展示照片${page.displayPhotoId}`, 'its displayed photograph');
    }
  }
}

export async function inspectFixturePdf(pdfPath, manifest, receipt = null) {
  const bytes = await readFile(pdfPath);
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  const info = spawnSync('pdfinfo', [pdfPath], { encoding:'utf8', timeout:10000 });
  const text = spawnSync('pdftotext', ['-raw', pdfPath, '-'], { encoding:'utf8', timeout:20000 });
  assert.equal(info.status, 0, info.stderr); assert.equal(text.status, 0, text.stderr);
  assert.match(info.stdout, /^Pages:\s+16$/mu);
  assert.match(info.stdout, /^Page size:\s+594\.96 x 594\.96 pts/mu);
  const pages = text.stdout.split('\f');
  if (!pages.at(-1)?.trim()) pages.pop();
  assertFixturePageText(pages, manifest);
  if (receipt) {
    assert.equal(receipt.contentHash, sha256(bytes), 'receipt hash must bind the exact current PDF bytes');
    assert.equal(receipt.byteLength, bytes.length, 'receipt length must bind the exact current PDF bytes');
    assert.equal(receipt.pageCount, pages.length);
    assert.equal(receipt.orderedMarkersVerified, true);
  }
  return { bytes, pages, producer:info.stdout.match(/^Producer:\s+(.+)$/mu)?.[1],
    creator:info.stdout.match(/^Creator:\s+(.+)$/mu)?.[1] };
}
