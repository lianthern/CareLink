'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const script = path.join(__dirname, '../scripts/check-realtime-evidence.mjs');
const load = () => import(script);
const requestId = 'probe_fixture_12345678';
const fixture = () => ({ providerSession: 'unseen_' + 'a'.repeat(64), status: 'ended', attempted: true, startSettled: true,
  budgetPresent: true, turns: 1, inputChars: 15, outputChars: 3, claimActive: false });

test('evidence defaults to a plan without reading configuration or making requests', () => {
  const report = JSON.parse(execFileSync(process.execPath, [script], { encoding: 'utf8', cwd: '/' }));
  assert.equal(report.networkRequests, 0); assert.equal(report.writes, 0);
});

test('query is a request-scoped aggregate with fixed counters, diagnostics and provider session', async () => {
  const { commandsFor } = await load();
  const [command] = commandsFor(requestId), query = JSON.parse(command.Command);
  assert.equal(command.CommandType, 'COMMAND'); assert.equal(query.aggregate, 'memory_demo_records');
  assert.deepEqual(query.pipeline[0], { $match: { kind: 'ai-realtime', 'entries.requestId': requestId } });
  assert.deepEqual(query.pipeline[2], { $match: { 'entries.requestId': requestId } });
  assert.deepEqual(query.pipeline.at(-1), { $limit: 2 });
  assert.equal(query.pipeline[3].$project._id, 0);
  assert.deepEqual(query.pipeline[3].$project.startSettled, { $eq: [{ $ifNull: ['$entries.startSettled', false] }, true] });
  assert.deepEqual(query.pipeline[3].$project.startFailureCode, { $ifNull: ['$entries.startFailureCode', null] });
  assert.deepEqual(query.pipeline[3].$project.startFailureFields, { $ifNull: ['$entries.startFailureFields', null] });
  assert.deepEqual(query.pipeline[3].$project.startFailureRequestId, { $ifNull: ['$entries.startFailureRequestId', null] });
  assert(!/\$out|\$merge|bridgeHash|owner|room|bodyHash|transcript|message|response|token/.test(command.Command));
  assert.throws(() => commandsFor({ $ne: null }));
});

test('CLI output variants decode but ambiguous and failed responses do not succeed', async () => {
  const { decodeRows, collectEvidence } = await load(), row = fixture();
  for (const result of [[row], [JSON.stringify(row)], { cursor: { firstBatch: [row] } }]) {
    assert.deepEqual(decodeRows('CLI banner\n' + JSON.stringify({ data: { results: [result] } })), [row]);
  }
  assert.throws(() => decodeRows(JSON.stringify({ success: false, data: { results: [[row]] } })));
  for (const rows of [[], [row, row]]) await assert.rejects(collectEvidence(rows, () => assert.fail('Describe must not run')));
});

test('real CLI Extended JSON counters decode without turning a Stop-only record into a completed call', async () => {
  const { decodeRows, collectEvidence } = await load();
  const row = { ...fixture(), attempted: false, startSettled: false, budgetPresent: false, startFailureCode: null,
    turns: { $numberInt: '0' }, inputChars: { $numberInt: '0' }, outputChars: { $numberInt: '0' } };
  const rows = decodeRows(JSON.stringify({ success: true, data: { results: [[row]] } }));
  assert.deepEqual([rows[0].turns, rows[0].inputChars, rows[0].outputChars], [0, 0, 0]);
  const report = await collectEvidence(rows, async () => null);
  assert.equal(report.ended, true); assert.equal(report.attempted, false); assert.equal(report.startSettled, false);
  assert.equal(report.complete, false); assert.equal(report.bridgeBudget.present, false);
  assert.equal(Object.hasOwn(report, 'startFailureCode'), false);
  assert.equal(Object.hasOwn(report, 'startFailureFields'), false);
  assert.equal(Object.hasOwn(report, 'startFailureRequestId'), false);

  const populated = { ...fixture(), turns: { $numberLong: '1' }, inputChars: { $numberDouble: '15.0' }, outputChars: { $numberInt: '3' } };
  const normalized = decodeRows(JSON.stringify({ data: { results: [{ cursor: { firstBatch: [JSON.stringify(populated)] } }] } }));
  assert.equal((await collectEvidence(normalized, async () => null)).complete, true);
});

test('malformed, fractional and unsafe Extended JSON counters remain rejected before provider lookup', async () => {
  const { decodeRows, collectEvidence } = await load();
  for (const value of [{ $numberInt: '-1' }, { $numberLong: '9007199254740993' }, { $numberDouble: '1.0000000000000001' },
    { $numberInt: '1', private: 'NEVER_PRINT' }, { $numberInt: 1 }, { $numberDouble: 'Infinity' }, { $numberDecimal: '1' }]) {
    const rows = decodeRows(JSON.stringify({ data: { results: [[{ ...fixture(), turns: value }]] } }));
    await assert.rejects(collectEvidence(rows, () => assert.fail('Describe must not run')));
  }
});

test('optional provider failure codes use the server code categories and never print raw error text', async () => {
  const { collectEvidence } = await load();
  for (const code of ['InvalidParameterValue.SDKAppId', 'AuthFailure.UnauthorizedOperation', 'FailedOperation.TaskNotExist']) {
    const report = await collectEvidence([{ ...fixture(), startFailureCode: code }], async () => null);
    assert.equal(report.startFailureCode, code);
  }
  for (const value of ['PRIVATE_CREDENTIAL', 'AuthFailure.secret WITH MESSAGE', 'AuthFailure.' + 'a'.repeat(129), 'InvalidParameter\n', { message: 'PRIVATE_CREDENTIAL' }]) {
    const report = await collectEvidence([{ ...fixture(), startFailureCode: value }], async () => null);
    assert.equal(report.startFailureCode, 'PROVIDER_UNCONFIRMED');
    assert(!JSON.stringify(report).includes('PRIVATE_CREDENTIAL'));
  }
});

test('failure fields emit at most eight unique exact allowed names, without raw error or field values', async () => {
  const { collectEvidence } = await load();
  const allowed = ['SessionId', 'RoomId', 'RoomIdType', 'AgentConfig', 'UserId', 'UserSig', 'TargetUserId',
    'MaxIdleTime', 'InterruptMode', 'InterruptSpeechDuration', 'TurnDetectionMode', 'WelcomeMessage',
    'WelcomeMessagePriority', 'STTConfig', 'Language', 'LLMConfig', 'LLMType', 'Model', 'APIKey', 'APIUrl',
    'History', 'HistoryMode', 'Streaming', 'SystemPrompt', 'Timeout', 'MaxTokens', 'Temperature', 'TopP',
    'ExtraBody', 'MetaInfo', 'TTSConfig', 'TTSType', 'VoiceId', 'Speed'];
  for (let at = 0; at < allowed.length; at += 8) {
    const fields = allowed.slice(at, at + 8);
    const report = await collectEvidence([{ ...fixture(), startFailureFields: fields }], async () => null);
    assert.deepEqual(report.startFailureFields, fields);
  }
  const raw = { ...fixture(), startFailureFields: [
    'APIKey', 'APIKey', 'PRIVATE_CREDENTIAL', 'Model\n', ' Model', 'model', 'ModelSecret', '模型Model',
    { UserSig: 'PRIVATE_CREDENTIAL' }, 123, null, 'Model', 'SystemPrompt', 'SessionId', 'RoomId',
    'RoomIdType', 'AgentConfig', 'UserId', 'UserSig'
  ], message: 'APIKey=PRIVATE_CREDENTIAL', response: { token: 'PRIVATE_CREDENTIAL' } };
  const report = await collectEvidence([raw], async entry => {
    assert.deepEqual(entry, { providerSession: raw.providerSession }); return null;
  });
  assert.deepEqual(report.startFailureFields, ['APIKey', 'Model', 'SystemPrompt', 'SessionId', 'RoomId', 'RoomIdType', 'AgentConfig', 'UserId']);
  assert.equal(report.complete, true);
  assert(!/PRIVATE_CREDENTIAL|ModelSecret|模型Model|message|response|token/.test(JSON.stringify(report)));
  for (const value of [undefined, null, 'Model PRIVATE_CREDENTIAL', { APIKey: 'PRIVATE_CREDENTIAL' }, 123]) {
    const malformed = await collectEvidence([{ ...fixture(), startFailureFields: value }], async () => null);
    assert.equal(Object.hasOwn(malformed, 'startFailureFields'), false);
    assert(!JSON.stringify(malformed).includes('PRIVATE_CREDENTIAL'));
  }
});

test('failure API request identifiers require an exact UUID and never expose arbitrary request data', async () => {
  const { collectEvidence } = await load();
  const uuid = '12345678-90ab-cdef-1234-567890abcdef';
  for (const value of [uuid, uuid.toUpperCase()]) {
    const report = await collectEvidence([{ ...fixture(), startFailureRequestId: value }], async () => null);
    assert.equal(report.startFailureRequestId, value);
  }
  for (const value of [undefined, null, '', 'PRIVATE_CREDENTIAL', uuid + '\n', ' ' + uuid, uuid + ' ',
    uuid.replaceAll('-', ''), uuid.replace('f', 'g'), { requestId: uuid, token: 'PRIVATE_CREDENTIAL' }, 123]) {
    const report = await collectEvidence([{ ...fixture(), startFailureRequestId: value }], async () => null);
    assert.equal(Object.hasOwn(report, 'startFailureRequestId'), false);
    assert(!JSON.stringify(report).includes('PRIVATE_CREDENTIAL'));
  }
});

test('provider lookup accepts only current 64-character and legacy 71-character session formats', async () => {
  const { collectEvidence } = await load();
  for (const length of [57, 64]) {
    const providerSession = 'unseen_' + 'a'.repeat(length);
    const report = await collectEvidence([{ ...fixture(), providerSession }], async entry => {
      assert.deepEqual(entry, { providerSession }); return null;
    });
    assert.equal(report.complete, true); assert(!JSON.stringify(report).includes(providerSession));
  }
  for (const length of [56, 58, 63, 65]) {
    await assert.rejects(collectEvidence([{ ...fixture(), providerSession: 'unseen_' + 'a'.repeat(length) }], () => assert.fail('Describe must not run')));
  }
});

test('request goes into CLI stdin and only sanitized success evidence leaves the tool', async () => {
  const { queryRows, collectEvidence } = await load(), row = { ...fixture(), privateFamilyText: 'NEVER_PRINT' };
  const rows = queryRows('/tmp', requestId, (bin, args, options) => {
    assert(!args.join(' ').includes(requestId));
    const input = JSON.parse(options.input);
    assert.match(input.commands[0].Command, new RegExp(requestId));
    assert.equal(input.cli, '/tmp/node_modules/@cloudbase/cli/bin/tcb');
    return { status: 0, stdout: JSON.stringify({ data: { results: [{ cursor: { firstBatch: [row] } }] } }) };
  });
  let calls = 0;
  const report = await collectEvidence(rows, async entry => { calls++; assert.deepEqual(entry, { providerSession: row.providerSession }); return null; });
  assert.equal(calls, 1); assert.equal(report.complete, true); assert.equal(report.claimReleased, true);
  assert(!JSON.stringify(report).includes('NEVER_PRINT')); assert(!JSON.stringify(report).includes(row.providerSession));
});

test('claim, provider absence and output must all be proven; provider errors stay private', async () => {
  const { collectEvidence } = await load();
  for (const patch of [{ status: 'stopping' }, { attempted: false }, { startSettled: false }, { claimActive: true }, { turns: 0 }, { outputChars: 0 }, { budgetPresent: false }]) {
    assert.equal((await collectEvidence([{ ...fixture(), ...patch }], async () => null)).complete, false);
  }
  assert.equal((await collectEvidence([fixture()], async () => 'secret-task-id')).complete, false);
  const error = await collectEvidence([fixture()], async () => { throw Error('PRIVATE_CREDENTIAL'); });
  assert.equal(error.provider.result, 'unconfirmed'); assert(!JSON.stringify(error).includes('PRIVATE_CREDENTIAL'));
  await assert.rejects(collectEvidence([{ ...fixture(), turns: -1 }], () => assert.fail('Describe must not run')));
});
