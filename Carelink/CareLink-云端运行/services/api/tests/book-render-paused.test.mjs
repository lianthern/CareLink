import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {fixture} from './fixture-factory.mjs';
import {COLLECTION_NOTICE_CONTEXT_DISCLOSURE} from '../../book-lab/src/index.mjs';
import {sha256} from '../src/util.mjs';
function bookLabTestEnv(dir, overrides = {}) {
  const collectionNoticeCopy = `测试收集须知文案。${COLLECTION_NOTICE_CONTEXT_DISCLOSURE}`;
  return {
    UNSEEN_BOOK_LAB_DB: path.join(dir, "book-lab.sqlite"),
    UNSEEN_BOOK_LAB_ETAG_SECRET: "test-book-lab-etag-secret-not-production-0001",
    UNSEEN_BOOK_LAB_WORKER_SECRET: "test-book-lab-worker-secret-not-production-0002",
    UNSEEN_BOOK_LAB_CLEANUP_SECRET: "test-book-lab-cleanup-secret-not-production-0003",
    UNSEEN_BOOK_LAB_RENDER_WORKER_SECRET: "test-book-lab-render-secret-not-production-0004",
    UNSEEN_BOOK_LAB_COLLECTION_NOTICE_VERSION: "test-collection-notice-1",
    UNSEEN_BOOK_LAB_COLLECTION_NOTICE_HASH: sha256(collectionNoticeCopy),
    UNSEEN_BOOK_LAB_COLLECTION_NOTICE_COPY: collectionNoticeCopy,
    UNSEEN_BOOK_LAB_GRANT_NOTICE_VERSION: "test-grant-notice-1",
    UNSEEN_BOOK_LAB_GRANT_NOTICE_HASH: sha256("test-grant-notice-1"),
    ...overrides
  };
}

function bookLabModuleLoader(env, capture) {
  return async () => {
    const module = await import("../src/extensions/book-lab.mjs");
    return { registerBookLabExtension: (input) => {
      const runtime = module.registerBookLabExtension(input, { env });
      if (capture) capture(runtime);
      return runtime;
    } };
  };
}


test('paused rendering mounts without sandbox, keeps draft reads and edits, rejects render admissions and internal jobs', async t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'book-paused-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 let runtime;
 const env=bookLabTestEnv(dir,{UNSEEN_BOOK_RENDER_GENERATION_ENABLED:'false',UNSEEN_BOOK_LAB_EGRESS_WRAPPER:'/missing-renderer',UNSEEN_BOOK_LAB_EGRESS_ATTESTATION:'invalid'});
 const f=fixture({featureFlags:{bookLab:true,privateAiWorker:false},extensionModuleLoader:bookLabModuleLoader(env,r=>runtime=r)});t.after(()=>f.close());await f.api.ready;
 const owner=await f.login('release-probe@example.test');let space=await f.createSpace(owner,'发布测试');space=await f.openSpace(owner,space);
 const base=`/v2-labs/owner/spaces/${space.spaceId}/books`;
 const created=await f.call('POST',base,{bookId:'release-book',title:'发布测试',eventId:space.spaceId},{...owner.headers,'if-none-match':'*'});assert.equal(created.status,200);
 const draft=await f.call('GET',base+'/release-book/draft',{},owner.headers);assert.equal(draft.status,200);
 const edited=await f.call('PATCH',base+'/release-book/title',{title:'已修改标题'},{...owner.headers,'if-match':draft.headers.etag});assert.equal(edited.status,200,JSON.stringify(edited.body));
 for(const suffix of ['/render-jobs','/versions']) {const response=await f.call('POST',base+'/release-book'+suffix,{},{...owner.headers});assert.equal(response.status,503);assert.equal(response.body.error.code,'book_render_generation_paused');}
 await assert.rejects(async()=>f.api.dispatchInternalJob('internal:book-lab-render-processor',{}),/book_render_generation_paused/);
 assert.deepEqual(runtime.pendingRenderRequests(),[]);
 const db=new DatabaseSync(path.join(dir,'book-lab.sqlite'));assert.equal(db.prepare('SELECT count(*) AS n FROM book_render_jobs').get().n,0);db.close();
});
test('default enabled still validates renderer configuration',async t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'book-default-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const env=bookLabTestEnv(dir,{UNSEEN_BOOK_RENDERER_TRANSPORT:'unseen-book-renderer-ipc/v1'});
 const f=fixture({featureFlags:{bookLab:true,privateAiWorker:false},extensionModuleLoader:bookLabModuleLoader(env)});t.after(()=>f.close());await assert.rejects(f.api.ready);
});
