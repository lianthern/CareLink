import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const ENV_ID = 'memory-frame-demo-d7djiee0702b6c';
const ORIGIN = `https://${ENV_ID}.service.tcloudbase.com`;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TABLE = 'memory_demo_records';
const fail = () => { throw Error('Read-only realtime evidence unavailable; raw cloud output is suppressed.'); };
const COUNT_KEYS = ['turns', 'inputChars', 'outputChars'];
const PROVIDER_SESSION = /^unseen_(?:[a-f0-9]{57}|[a-f0-9]{64})$/;
const FAILURE_CODE = /^(?:InvalidParameter|InvalidParameterValue|FailedOperation|AuthFailure|UnauthorizedOperation|UnsupportedOperation|LimitExceeded|ResourceUnavailable|ResourceInsufficient|InternalError|RequestLimitExceeded|MissingParameter|ResourceNotFound|OperationDenied)(?:\.[A-Za-z0-9]+)*$/;
const FAILURE_FIELDS = new Set([
  'SessionId', 'RoomId', 'RoomIdType', 'AgentConfig', 'UserId', 'UserSig', 'TargetUserId',
  'MaxIdleTime', 'InterruptMode', 'InterruptSpeechDuration', 'TurnDetectionMode',
  'WelcomeMessage', 'WelcomeMessagePriority', 'STTConfig', 'Language', 'LLMConfig',
  'LLMType', 'Model', 'APIKey', 'APIUrl', 'History', 'HistoryMode', 'Streaming',
  'SystemPrompt', 'Timeout', 'MaxTokens', 'Temperature', 'TopP', 'ExtraBody', 'MetaInfo',
  'TTSConfig', 'TTSType', 'VoiceId', 'Speed'
]);
const REQUEST_ID = /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/;

export function recoveryId(value) {
  if (value?.origin !== ORIGIN || !/^[a-zA-Z0-9_-]{16,80}$/.test(value?.requestId || '')) fail();
  return value.requestId;
}

// Projection runs in the database. No family content, auth grant, owner, room,
// body hash, transcript or raw turn objects leave it. Two rows detect ambiguity.
export function commandsFor(requestId) {
  recoveryId({ origin: ORIGIN, requestId });
  const pipeline = [
    { $match: { kind: 'ai-realtime', 'entries.requestId': requestId } },
    { $unwind: '$entries' },
    { $match: { 'entries.requestId': requestId } },
    { $project: {
      _id: 0, providerSession: '$entries.providerSession', status: '$entries.status',
      attempted: { $eq: [{ $ifNull: ['$entries.attempted', false] }, true] },
      startSettled: { $eq: [{ $ifNull: ['$entries.startSettled', false] }, true] },
      startFailureCode: { $ifNull: ['$entries.startFailureCode', null] },
      startFailureFields: { $ifNull: ['$entries.startFailureFields', null] },
      startFailureRequestId: { $ifNull: ['$entries.startFailureRequestId', null] },
      budgetPresent: { $ne: [{ $ifNull: ['$entries.bridgeBudget', null] }, null] },
      turns: { $size: { $ifNull: ['$entries.bridgeBudget.turns', []] } },
      inputChars: { $ifNull: ['$entries.bridgeBudget.inputChars', 0] },
      outputChars: { $ifNull: ['$entries.bridgeBudget.outputChars', 0] },
      claimActive: { $ne: [{ $ifNull: ['$entries.bridgeBudget.active', null] }, null] }
    } },
    { $limit: 2 }
  ];
  return [{ TableName: TABLE, CommandType: 'COMMAND', Command: JSON.stringify({ aggregate: TABLE, pipeline, cursor: { batchSize: 2 } }) }];
}

function counterNumber(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const keys = Object.keys(value);
  if (keys.length !== 1 || !['$numberInt', '$numberLong', '$numberDouble'].includes(keys[0])) return value;
  const text = value[keys[0]];
  // RunCommands returns BSON numbers in Extended JSON, even after the CLI
  // parses its envelope. Accept only exact, nonnegative safe integer counters.
  const pattern = keys[0] === '$numberDouble' ? /^(?:0|[1-9]\d*)(?:\.0+)?$/ : /^(?:0|[1-9]\d*)$/;
  if (typeof text !== 'string' || !pattern.test(text)) return value;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : value;
}

export function decodeRows(output) {
  const plain = output.replace(/\u001b\[[0-9;]*m/g, '');
  let envelope;
  for (let at = plain.indexOf('{'); at >= 0; at = plain.indexOf('{', at + 1)) {
    try { const value = JSON.parse(plain.slice(at)); if (value?.data?.results) { envelope = value; break; } } catch {}
  }
  if (!envelope || envelope.success === false || envelope.data.results.length !== 1) fail();
  let result = envelope.data.results[0];
  if (typeof result === 'string') { try { result = JSON.parse(result); } catch { fail(); } }
  const rows = Array.isArray(result) ? result : result?.cursor?.firstBatch;
  if (!Array.isArray(rows)) fail();
  return rows.map(row => {
    if (typeof row === 'string') { try { row = JSON.parse(row); } catch { fail(); } }
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    return { ...row, ...Object.fromEntries(COUNT_KEYS.map(key => [key, counterNumber(row[key])])) };
  });
}

// The CLI reads its existing login. Request identifiers enter via stdin rather
// than shell/OS argv. stdout/stderr stay in memory and are never persisted.
export function queryRows(root, requestId, runner = spawnSync) {
  const directory = mkdtempSync(path.join(tmpdir(), 'unseen-realtime-read-'));
  try {
    const config = path.join(directory, 'cloudbaserc.json');
    writeFileSync(config, JSON.stringify({ envId: ENV_ID, region: 'ap-shanghai' }), { mode: 0o600 });
    const child = `const fs=require('node:fs');const i=JSON.parse(fs.readFileSync(0,'utf8'));process.argv=[process.execPath,i.cli,'db','nosql','execute','--command',JSON.stringify(i.commands),'-e','${ENV_ID}','-r','ap-shanghai','--config-file',i.config,'--json'];require(i.cli);`;
    const result = runner(process.execPath, ['-e', child], {
      cwd: root, env: { ...process.env, CI: '1', NO_COLOR: '1' }, encoding: 'utf8', timeout: 45000, maxBuffer: 1024 * 1024,
      input: JSON.stringify({ cli: path.join(root, 'node_modules/@cloudbase/cli/bin/tcb'), config, commands: commandsFor(requestId) })
    });
    if (result.error || result.status !== 0) fail();
    return decodeRows(result.stdout);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

export async function collectEvidence(rows, lookup) {
  if (rows.length !== 1) fail();
  const row = rows[0];
  // Current IDs fit Tencent's 64-character limit; legacy 71-character IDs stay
  // readable for diagnosis and reconciliation, without accepting arbitrary IDs.
  if (!row || !PROVIDER_SESSION.test(row.providerSession || '') ||
      !['starting', 'active', 'stopping', 'ended'].includes(row.status) ||
      !['attempted', 'startSettled', 'budgetPresent', 'claimActive'].every(key => typeof row[key] === 'boolean') ||
      !COUNT_KEYS.every(key => Number.isSafeInteger(row[key]) && row[key] >= 0)) fail();
  const startFailureCode = row.startFailureCode == null ? null :
    typeof row.startFailureCode === 'string' && row.startFailureCode.length <= 128 &&
      row.startFailureCode === row.startFailureCode.trim() && FAILURE_CODE.test(row.startFailureCode)
      ? row.startFailureCode : 'PROVIDER_UNCONFIRMED';
  // Revalidate persisted diagnostics before emitting them. Only fixed field
  // names and a standard API request UUID may leave the read-only evidence tool.
  const startFailureFields = Array.isArray(row.startFailureFields)
    ? [...new Set(row.startFailureFields.filter(field => typeof field === 'string' && FAILURE_FIELDS.has(field)))].slice(0, 8)
    : null;
  const startFailureRequestId = typeof row.startFailureRequestId === 'string' &&
    row.startFailureRequestId.length === 36 && REQUEST_ID.test(row.startFailureRequestId)
    ? row.startFailureRequestId : null;
  let provider;
  try {
    const task = await lookup({ providerSession: row.providerSession });
    if (task !== null && (typeof task !== 'string' || !task)) fail();
    provider = { operation: 'DescribeAIConversation', result: task === null ? 'task-not-found' : 'task-present', taskAbsent: task === null };
  } catch { provider = { operation: 'DescribeAIConversation', result: 'unconfirmed', taskAbsent: null }; }
  const evidence = {
    checkedAt: new Date().toISOString(), recordMatches: 1, status: row.status, ended: row.status === 'ended',
    attempted: row.attempted, startSettled: row.startSettled,
    ...(startFailureCode ? { startFailureCode } : {}),
    ...(startFailureFields ? { startFailureFields } : {}),
    ...(startFailureRequestId ? { startFailureRequestId } : {}),
    bridgeBudget: { present: row.budgetPresent, turns: row.turns, inputChars: row.inputChars, outputChars: row.outputChars },
    claimReleased: row.budgetPresent ? !row.claimActive : null, provider
  };
  evidence.complete = evidence.ended && evidence.attempted && evidence.startSettled && evidence.claimReleased === true &&
    row.turns > 0 && row.outputChars > 0 && provider.taskAbsent === true;
  return evidence;
}

export async function execute(recoveryPath, root = ROOT) {
  let requestId, config;
  try { requestId = recoveryId(JSON.parse(readFileSync(recoveryPath, 'utf8'))); config = JSON.parse(readFileSync(path.join(root, 'cloudbaserc.local.json'), 'utf8')); } catch { fail(); }
  if (config.envId !== ENV_ID || config.region !== 'ap-shanghai' || config.functions?.length !== 1 || config.functions[0].name !== 'memory-frame-demo') fail();
  const env = config.functions[0].envVariables;
  if (env?.MEMORY_CLOUDBASE_ENV !== ENV_ID) fail();
  const require = createRequire(path.join(root, 'server/package.json'));
  const { createTRTC, controlConfiguration } = require('./ai-realtime-trtc.js');
  if (!controlConfiguration(env)) fail();
  // Existing app adapter uses only its explicit AI_REALTIME_TRTC_* credentials;
  // lookup invokes Describe and accepts only TaskNotExist as authoritative absence.
  const provider = createTRTC({ env });
  return collectEvidence(queryRows(root, requestId), provider.lookup);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] !== '--execute') {
    process.stdout.write(JSON.stringify({ mode: 'plan-only', networkRequests: 0, usage: 'node scripts/check-realtime-evidence.mjs --execute <recovery.private.json> [app-root]', operations: ['CLI db nosql aggregate with fixed projection', 'TRTC DescribeAIConversation'], writes: 0 }) + '\n');
  } else if (args.length < 2 || args.length > 3) {
    process.stderr.write('Expected --execute <recovery.private.json> [app-root].\n'); process.exitCode = 1;
  } else {
    try { const result = await execute(args[1], args[2] ? path.resolve(args[2]) : ROOT); process.stdout.write(JSON.stringify(result, null, 2) + '\n'); process.exitCode = result.complete ? 0 : 2; }
    catch { process.stderr.write('Read-only realtime evidence unavailable; raw cloud output is suppressed.\n'); process.exitCode = 1; }
  }
}
