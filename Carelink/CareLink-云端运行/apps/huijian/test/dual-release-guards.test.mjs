import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile);
test('dual rehearsal refuses production destinations before archive or migration',async()=>{
 await assert.rejects(exec(process.execPath,['deploy/dual-release-rehearsal.mjs','--root','/opt/unseen/releases/forbidden']),error=>error.stderr.includes('isolated_task_root_required'));
});
test('dual rehearsal rejects floating and missing revision inputs',async()=>{
 await assert.rejects(exec(process.execPath,['deploy/dual-release-rehearsal.mjs','--root','.task/unseen-app/never-created-invalid-revision','--app-sha','HEAD']),error=>error.stderr.includes('exact_sha_required:app-sha'));
});
