'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const imports = Promise.all([import('../scripts/cloudbase-scf.mjs'), import('../scripts/deploy.mjs'), import('../scripts/prepare-realtime-cleanup.mjs')]);
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-deploy-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function config(api) { return { envId: api.ENV_ID, region: api.REGION, functions: [{ name: api.HTTP_FUNCTION, type: 'HTTP', runtime: 'Nodejs20.19', role: 'MemoryFrameDemoRuntime', envVariables: {
  MEMORY_CLOUDBASE_ENV: api.ENV_ID, PORT: '9000', DEMO_SETUP_CODE: 'private-existing', AI_MODEL: 'hy3',
  AI_REALTIME_ENABLED: '0', AI_REALTIME_TRTC_APP_ID: '1600164141', AI_REALTIME_TRTC_SECRET_ID: 'private-control-id', AI_REALTIME_TRTC_SECRET_KEY: 'private-control-key',
  AI_REALTIME_TTS_JSON: '{"TTSType":"flow","Model":"flow_02_turbo","VoiceId":"private-voice"}',
} }] }; }
function detail(api, env) { return { FunctionName: api.HTTP_FUNCTION, Type: 'HTTP', Runtime: 'Nodejs20.19', Role: 'MemoryFrameDemoRuntime', Status: 'Active', Environment: api.environmentUpdate(api.HTTP_FUNCTION, env).Environment }; }
function fixture(t, api) { const root = temp(t), cfg = config(api), file = path.join(root, 'cloudbaserc.local.json'); api.writePrivate(file, cfg); return { root, cfg, file }; }

test('JSON environment strings stay byte-identical; the original seven values and unknown live values survive', async () => {
  const [api] = await imports, cfg = config(api), source = cfg.functions[0].envVariables;
  const original = { MEMORY_CLOUDBASE_ENV: api.ENV_ID, PORT: '9000', DEMO_SETUP_CODE: 'private-existing', AI_MODEL: 'hy3', AI_VISION_MODEL: 'M3', AI_VISION_KEY: 'private-vision', RETAIN_ME: 'private-extra' };
  const merged = api.mergeEnvironment(original, source), request = api.environmentUpdate(api.HTTP_FUNCTION, merged);
  for (const [key, value] of Object.entries(original)) assert.equal(merged[key], value);
  assert.equal(merged.AI_REALTIME_TTS_JSON, source.AI_REALTIME_TTS_JSON);
  assert.equal(JSON.parse(merged.AI_REALTIME_TTS_JSON).Model, 'flow_02_turbo');
  assert.ok(request.Environment.Variables.every(item => typeof item.Value === 'string'));
  assert.throws(() => api.mergeEnvironment(original, { AI_MODEL: 'other' }), /non-realtime/);
  for (const item of [{ value: {} }, { value: [] }, { value: null }, { value: 1 }]) assert.throws(() => api.stringEnvironment(item), /string/);
});

test('private config rejects wrong target, non-string values and malformed secret JSON without leaking its contents', async t => {
  const [api] = await imports, { cfg, file } = fixture(t, api);
  assert.equal(api.readDeployConfig(file).env.AI_REALTIME_TTS_JSON, cfg.functions[0].envVariables.AI_REALTIME_TTS_JSON);
  for (const edit of [c => { c.envId = 'other'; }, c => { c.region = 'other'; }, c => { c.functions[0].name = 'other'; }, c => { c.functions[0].envVariables.AI_REALTIME_TTS_JSON = {}; }]) {
    const bad = structuredClone(cfg); edit(bad); api.writePrivate(file, bad); assert.throws(() => api.readDeployConfig(file));
  }
  api.writePrivate(file, '{"key":"private-secret-unclosed');
  assert.throws(() => api.readDeployConfig(file), error => !error.message.includes('private-secret'));
});

test('actual CLI child uses stdin for private body and captures output with restrictive permissions', async t => {
  const [api] = await imports, root = temp(t), fakeCli = path.join(root, 'fake-cli.cjs');
  fs.writeFileSync(fakeCli, "const i=process.argv.indexOf('--body'); const body=JSON.parse(process.argv[i+1]); console.log('CLI banner'); console.log(JSON.stringify({data:{received:body}}));");
  const evidenceDir = path.join(root, 'private'), client = api.createCloudClient({ root, cliPath: fakeCli, evidenceDir });
  const body = api.environmentUpdate(api.HTTP_FUNCTION, { AI_REALTIME_TTS_JSON: '{"private-secret":true}' });
  const result = client.scf('UpdateFunctionConfiguration', body);
  assert.deepEqual(result.received, body);
  if (process.platform !== 'win32') { assert.equal(fs.statSync(evidenceDir).mode & 0o777, 0o700); assert.equal(fs.statSync(path.join(evidenceDir, '001-UpdateFunctionConfiguration.log')).mode & 0o777, 0o600); }
  let args, options;
  const mocked = api.createCloudClient({ root, cliPath: fakeCli, evidenceDir, runner: (_exe, a, o) => { args = a; options = o; return { status: 0, stdout: '{"data":{"ok":true}}' }; } });
  mocked.scf('UpdateFunctionConfiguration', body);
  assert.doesNotMatch(JSON.stringify(args), /private-secret|--body/);
  assert.match(options.input, /private-secret/); assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
});

test('SCF helper refuses another function, namespace, action, invalid env values and public triggers before invocation', async t => {
  const [api] = await imports, root = temp(t), fakeCli = path.join(root, 'fake.cjs'); fs.writeFileSync(fakeCli, ''); let calls = 0;
  const client = api.createCloudClient({ root, cliPath: fakeCli, evidenceDir: path.join(root, 'evidence'), runner: () => { calls++; } });
  for (const [action, body] of [
    ['DeleteFunction', api.functionParams()], ['GetFunction', { ...api.functionParams(), FunctionName: 'other' }], ['GetFunction', { ...api.functionParams(), Namespace: 'other' }],
    ['UpdateFunctionConfiguration', { ...api.functionParams(), Role: 'admin' }],
    ['UpdateFunctionConfiguration', { ...api.functionParams(), Environment: { Variables: [{ Key: 'X', Value: {} }] } }],
    ['CreateTrigger', { ...api.functionParams(api.CLEANUP_FUNCTION), Type: 'http', TriggerName: api.CLEANUP_FUNCTION, Enable: 'OPEN' }],
  ]) assert.throws(() => client.scf(action, body));
  assert.equal(calls, 0);
});

test('decoder accepts prefixed official envelope and rejects provider errors without exposing secrets', async () => {
  const [api] = await imports;
  assert.deepEqual(api.decodeCliJson('banner\n{"data":{"Response":{"Status":"Active"}}}\n'), { Status: 'Active' });
  for (const text of ['private-error', '{"data":{"Error":{"Message":"private-secret"}}}', '{"error":"private-secret"}']) assert.throws(() => api.decodeCliJson(text), e => !e.message.includes('private-secret'));
});

test('deployment uses code-only command, preserves cloud extras, writes string config, and reads back before declaring success', async t => {
  const [api, { deploy }] = await imports, { root, cfg, file } = fixture(t, api);
  let env = { MEMORY_CLOUDBASE_ENV: api.ENV_ID, PORT: '9000', DEMO_SETUP_CODE: 'private-existing', AI_MODEL: 'hy3', RETAIN_ME: 'private-cloud-extra' }, calls = [], codeConfig, codeArgs;
  const client = { scf: (action, body) => { calls.push(action); if (action === 'GetFunction') return detail(api, env); if (action === 'UpdateFunctionConfiguration') { env = api.environmentOf(body); return {}; } throw Error('unexpected'); },
    run: (args) => { calls.push(args.slice(0, 4).join(' ')); codeArgs = args; codeConfig = JSON.parse(fs.readFileSync(args[args.indexOf('--config-file') + 1])); return {}; } };
  const messages = [], report = await deploy({ root, configPath: file, client, report: text => messages.push(text) });
  assert.equal(report.verified, true); assert.equal(report.runtimeAudioVerified, false); assert.equal(env.RETAIN_ME, 'private-cloud-extra');
  assert.equal(env.AI_REALTIME_TTS_JSON, cfg.functions[0].envVariables.AI_REALTIME_TTS_JSON); assert.equal(codeConfig.functions[0].envVariables, undefined);
  assert.equal(codeConfig.functionRoot, '.'); assert.equal(codeArgs[codeArgs.indexOf('--dir') + 1], path.join(root, 'server'));
  assert.deepEqual(calls, ['GetFunction', 'fn code update memory-frame-demo', 'GetFunction', 'UpdateFunctionConfiguration', 'GetFunction']);
  assert.doesNotMatch(JSON.stringify([report, messages]), /private-control|private-existing|private-voice/);
});

test('concurrent cloud variable changes after code upload abort before env mutation and retain the original snapshot', async t => {
  const [api, { deploy }] = await imports, { root, file } = fixture(t, api); let reads = 0, writes = 0;
  const original = { MEMORY_CLOUDBASE_ENV: api.ENV_ID, PORT: '9000', DEMO_SETUP_CODE: 'private-existing', AI_MODEL: 'hy3' };
  const evidenceDir = path.join(root, 'evidence');
  const client = { run: () => ({}), scf: action => { if (action === 'GetFunction') return detail(api, ++reads === 1 ? original : { ...original, OTHER_EDITOR: 'new' }); writes++; } };
  await assert.rejects(deploy({ root, configPath: file, client, evidenceDir, report: () => {} }), /concurrent/);
  assert.equal(writes, 0); assert.deepEqual(api.environmentOf(JSON.parse(fs.readFileSync(path.join(evidenceDir, 'before-function.private.json')))), original);
});

test('configuration-only and offline plan never upload code; verify-only makes no writes', async t => {
  const [api, { deploy }] = await imports, { root, file, cfg } = fixture(t, api);
  const never = () => { throw Error('unexpected I/O'); };
  assert.equal((await deploy({ root, configPath: file, plan: true, client: { scf: never, run: never } })).cloudRequests, 0);
  let reads = 0;
  const client = { run: never, scf: action => { assert.equal(action, 'GetFunction'); reads++; return detail(api, cfg.functions[0].envVariables); } };
  assert.equal((await deploy({ root, configPath: file, verifyOnly: true, client, report: () => {} })).matches, true); assert.equal(reads, 1);
  assert.equal((await deploy({ root, configPath: file, configOnly: true, client, report: () => {} })).verified, true);
});

test('readback mismatch fails instead of claiming completion', async t => {
  const [api, { deploy }] = await imports, { root, file } = fixture(t, api); let writes = 0;
  const original = { MEMORY_CLOUDBASE_ENV: api.ENV_ID, PORT: '9000', DEMO_SETUP_CODE: 'private-existing', AI_MODEL: 'hy3' };
  const client = { run: () => ({}), scf: action => { if (action === 'UpdateFunctionConfiguration') { writes++; return {}; } return detail(api, original); } };
  await assert.rejects(deploy({ root, configPath: file, configOnly: true, client, report: () => {} }), /readback differs/); assert.equal(writes, 1);
});

test('cleanup plan is private Event + one-minute Timer and copies no LLM, signing, voice or setup secrets', async () => {
  const [api, , { cleanupPlan, cleanupDeployArgs, verifyCleanup }] = await imports, cfg = config(api), { deployment, trigger } = cleanupPlan(cfg);
  const args = cleanupDeployArgs('/tmp/private-cleanup.json'); assert.equal(args[args.indexOf('--dir') + 1], deployment.functions[0].dir); assert.equal(deployment.functionRoot, '.');
  assert.equal(args[args.indexOf('--deployMode') + 1], 'zip');
  assert.ok(deployment.functions[0].ignore.includes('public/assets/**'));
  assert.ok(deployment.functions[0].ignore.includes('public/vendor/**'));
  assert.ok(deployment.functions[0].ignore.includes('scf_bootstrap'));
  assert.ok(!deployment.functions[0].ignore.includes('public/**'), 'backend-shared public/spatial-link.js must be packaged');
  assert.equal(deployment.functions[0].type, 'Event'); assert.equal(deployment.functions[0].public, false); assert.equal(deployment.functions[0].gatewayPath, undefined);
  assert.doesNotMatch(JSON.stringify(deployment), /private-voice|private-existing|AI_REALTIME_TTS_JSON|SDK_SECRET/);
  assert.equal(trigger.Namespace, api.ENV_ID); assert.equal(trigger.Enable, 'OPEN'); assert.equal(trigger.TriggerDesc, '0 * * * * * *');
  const evidence = verifyCleanup({ Type: 'Event', Handler: 'ai-realtime-cleanup.main' }, [{ ...trigger, TriggerDesc: JSON.stringify({ cron: trigger.TriggerDesc }), Enable: 1 }]);
  assert.equal(evidence.eventFunction && evidence.handlerMatches && evidence.noHttpTrigger && evidence.timerEnabled && evidence.scheduleMatches, true);
  assert.equal(evidence.actualInvocationVerified, false); assert.equal(evidence.expiredTaskStopVerified, false);
});

test('cleanup invocation and logs report only fixed booleans and counts, separating manual from scheduled evidence', async () => {
  const [api, , tools] = await imports;
  const params = tools.cleanupInvokeParams(); assert.equal(params.FunctionName, api.CLEANUP_FUNCTION); assert.equal(JSON.parse(params.ClientContext).Type, 'Timer');
  const payload = { enabled: true, ok: true, scanned: 2, attempted: 0, pending: 0, privateValue: 'private-secret' };
  const manual = tools.summarizeCleanupInvocation({ Result: { InvokeResult: 0, RetMsg: JSON.stringify(payload), FunctionRequestId: 'manual-request', Log: 'private-logs' } });
  assert.equal(manual.executionSucceeded, true); assert.equal(manual.scheduledInvocationVerified, false);
  const logs = tools.summarizeCleanupLogs({ TotalCount: 2, Data: [
    { RetCode: 0, InvokeFinished: 1, RetMsg: JSON.stringify(payload), StartTime: '2026-09-24 10:00:00', RequestId: 'timer-request' },
    { RetCode: 0, InvokeFinished: 1, RetMsg: 'Success', Log: '[ai-realtime-cleanup] ' + JSON.stringify(payload) + '\nprivate-logs' },
  ] });
  assert.equal(logs.executions.length, 2); assert.equal(logs.executions[1].scanned, 2);
  assert.doesNotMatch(JSON.stringify([manual, logs]), /private-/);
});
