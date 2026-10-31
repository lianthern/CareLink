import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createBookLabSameOriginServer, listenBookLabSameOriginServer } from '../../../infra/integration/book-lab/same-origin-server.mjs';

test('deployment adapter serves canonical Book module aliases as exact bytes and keeps legacy routes', async t => {
  const server=createBookLabSameOriginServer({api:{handle(){throw Error('static request must not call API');},privateAiObservation(){return {enabled:false};}},runtime:{readCanonicalHtmlForUi(){throw Error('static request must not read private books');}}});
  await listenBookLabSameOriginServer(server);
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const origin=`http://127.0.0.1:${server.address().port}`;
  for(const name of ['integrated-shell.mjs','integrated-controller.mjs','integrated-transport.mjs','routes.mjs','styles.css']){
    const expected=await readFile(new URL(`../../../packages/book-lab-web/src/${name}`,import.meta.url));
    for(const prefix of ['/__book_lab_web__/src/','/packages/book-lab-web/src/']){
      const response=await fetch(origin+prefix+name);
      assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()),expected);
    }
  }
  const catalog=await fetch(origin+'/__book_lab_web__/catalog.json');
  assert.equal(catalog.status,200);
  assert.deepEqual(Buffer.from(await catalog.arrayBuffer()),await readFile(new URL('../../../packages/contracts/generated/book-lab/string-catalog.zh-CN.json',import.meta.url)));
  for(const path of ['/__book_lab_web__/src/missing.mjs','/__book_lab_web__/package.json','/__book_lab_web__/%2e%2e/services/api/src/api.mjs']){
    assert.equal((await fetch(origin+path)).status,404);
  }
});
