import test from 'node:test';
import assert from 'node:assert/strict';
import {publicWorldJob} from '../lib/unseen-world-jobs.mjs';
import {publicWorldFailure, publicWorldOperation} from '../lib/worldlabs-public-errors.mjs';

test('credit diagnostics in old jobs and operations stay private without mutating storage', () => {
  for (const error of [{code:402,message:'Payment Required'}, {code:8,message:'Insufficient credits. Visit billing.'}]) {
    const job={id:'old-job',owner:'private-owner',inputHash:'private-hash',error:'provider_credits_low',operation:{id:'op',done:true,error}};
    const saved=structuredClone(job),visible=publicWorldJob(job);
    assert.equal(visible.error,'WL-204');
    assert.equal(visible.operation.error.code,'WL-204');
    assert.doesNotMatch(JSON.stringify(visible),/credits|payment|billing|private-/i);
    assert.deepEqual(job,saved);
  }
});

test('rate limits, timeouts and other operation failures are not labeled credit failures', () => {
  for(const [code,status] of [['provider_rate_limited',429],['daily_limit',429],['provider_timeout',502]])
    assert.deepEqual(publicWorldFailure(code,status),{status,body:{error:code}});
  const operation={id:'op',error:{code:8,message:'GPU resource exhausted'}};
  assert.deepEqual(publicWorldOperation(operation),operation);
});
