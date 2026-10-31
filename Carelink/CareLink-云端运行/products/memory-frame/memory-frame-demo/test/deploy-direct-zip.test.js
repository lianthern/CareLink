'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const imports = Promise.all([import('../scripts/cloudbase-scf.mjs'), import('../scripts/deploy-zip.mjs'), import('../scripts/deploy.mjs')]);
function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-direct-zip-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = fs.realpathSync(temporary), server = path.join(root, 'server'); fs.mkdirSync(server);
  const put = (file, value) => { const target = path.join(server, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value); };
  put('package.json', JSON.stringify({ dependencies: { '@cloudbase/node-sdk': '3.18.3' } }));
  put('server.js', 'console.log("runtime");'); put('scf_bootstrap', '#!/bin/sh\nnode server.js\n'); fs.chmodSync(path.join(server, 'scf_bootstrap'), 0o755);
  put('public/nested/model.bin', Buffer.from([0, 1, 2, 3]));
  for (const file of ['node_modules/nested/dependency.js', 'pnpm-lock.yaml', 'package-lock.json', '.env', '.env.production', '.tools/secret.json', '.data/account.json', 'cloudbaserc.local.json', 'snapshot.private.json', 'credential.pem']) put(file, 'excluded-private-marker');
  return { root, server, put, evidenceDir: path.join(root, 'evidence') };
}

test('direct ZIP has the exact runtime files, bootstrap permissions, integrity and private evidence', async t => {
  const [api, { buildDirectZip }] = await imports, { root, evidenceDir } = fixture(t);
  const { manifest, body } = buildDirectZip(root, evidenceDir);
  assert.deepEqual(manifest.files, ['package.json', 'public/nested/model.bin', 'scf_bootstrap', 'server.js']);
  assert.equal(spawnSync('unzip', ['-tqq', manifest.archive]).status, 0);
  const contents = spawnSync('unzip', ['-p', manifest.archive, 'public/nested/model.bin']);
  assert.deepEqual(contents.stdout, Buffer.from([0, 1, 2, 3]));
  const listing = spawnSync('zipinfo', ['-l', manifest.archive], { encoding: 'utf8' });
  assert.match(listing.stdout, /-rwxr-xr-x[^\n]+scf_bootstrap/);
  assert.deepEqual(body, { FunctionName: api.HTTP_FUNCTION, Namespace: api.ENV_ID, CodeSource: 'ZipFile', Code: { ZipFile: fs.readFileSync(manifest.archive).toString('base64') }, InstallDependency: 'TRUE', Publish: 'FALSE' });
  if (process.platform !== 'win32') { assert.equal(fs.statSync(evidenceDir).mode & 0o777, 0o700); assert.equal(fs.statSync(manifest.archive).mode & 0o777, 0o600); }
  assert.throws(() => buildDirectZip(root, evidenceDir), /existing deployment ZIP/);
});

test('direct ZIP rejects linked sources, unpinned SDK and missing bootstrap before cloud mutation', async t => {
  const [, { buildDirectZip }] = await imports, { root, server, evidenceDir, put } = fixture(t);
  put('package.json', JSON.stringify({ dependencies: { '@cloudbase/node-sdk': '^3.18.3' } }));
  assert.throws(() => buildDirectZip(root, evidenceDir), /pinned/);
  put('package.json', JSON.stringify({ dependencies: { '@cloudbase/node-sdk': '3.18.3' } }));
  fs.symlinkSync('/etc/hosts', path.join(server, 'linked.js'));
  assert.throws(() => buildDirectZip(root, evidenceDir), /symlinked/); fs.unlinkSync(path.join(server, 'linked.js'));
  fs.unlinkSync(path.join(server, 'scf_bootstrap')); assert.throws(() => buildDirectZip(root, evidenceDir), /Missing required runtime/);
});

test('direct ZIP updates only code via private stdin, preserves env, and never falls back to COS', async t => {
  const [api, , { deploy }] = await imports, { root, evidenceDir } = fixture(t);
  const env = { MEMORY_CLOUDBASE_ENV: api.ENV_ID, AI_REALTIME_ENABLED: '1', RETAIN_ME: 'secret-existing' };
  const configPath = path.join(root, 'cloudbaserc.local.json');
  api.writePrivate(configPath, { envId: api.ENV_ID, region: api.REGION, functions: [{ name: api.HTTP_FUNCTION, type: 'HTTP', runtime: 'Nodejs20.19', role: 'MemoryFrameDemoRuntime', envVariables: env }] });
  const detail = { FunctionName: api.HTTP_FUNCTION, Type: 'HTTP', Runtime: 'Nodejs20.19', Role: 'MemoryFrameDemoRuntime', Status: 'Active', Environment: api.environmentUpdate(api.HTTP_FUNCTION, env).Environment };
  const actions = [];
  const fakeCli = path.join(root, 'fake.cjs'); fs.writeFileSync(fakeCli, '');
  const realClient = api.createCloudClient({ root, cliPath: fakeCli, evidenceDir, runner: (_exe, args, options) => {
    assert.equal(args[3], 'scf'); assert.equal(args[4], 'UpdateFunctionCode');
    assert.ok(!args.includes('--body')); const body = JSON.parse(options.input).body;
    assert.equal(body.InstallDependency, 'TRUE'); assert.equal(body.Environment, undefined);
    assert.ok(Buffer.from(body.Code.ZipFile, 'base64').length > 0);
    return { status: 0, stdout: '{"data":{"RequestId":"synthetic-request"}}' };
  } });
  const client = { run: () => assert.fail('COS must not run'), scf: (action, body) => { actions.push(action); return action === 'GetFunction' ? detail : realClient.scf(action, body); } };
  const result = await deploy({ root, configPath, directZip: true, evidenceDir, client, report: () => {} });
  assert.equal(result.verified, true); assert.deepEqual(actions, ['GetFunction', 'UpdateFunctionCode', 'GetFunction', 'GetFunction']);
  assert.doesNotMatch(JSON.stringify(result), /secret-existing/);

  const failedDir = path.join(root, 'failed');
  await assert.rejects(deploy({ root, configPath, directZip: true, evidenceDir: failedDir, report: () => {}, client: {
    run: () => assert.fail('failed ZIP must not retry COS'), scf: action => { if (action === 'GetFunction') return detail; throw Error('synthetic upload failure'); },
  } }), /synthetic upload failure/);
  assert.ok(fs.existsSync(path.join(failedDir, 'before-function.private.json')));
  assert.ok(fs.existsSync(path.join(failedDir, 'server-code.zip')));
});

test('SCF direct ZIP helper rejects wrong function, env mutation and malformed or oversized code without invocation', async t => {
  const [api, { buildDirectZip }] = await imports, { root, evidenceDir } = fixture(t);
  const { body } = buildDirectZip(root, evidenceDir), fakeCli = path.join(root, 'fake.cjs'); fs.writeFileSync(fakeCli, ''); let calls = 0;
  const client = api.createCloudClient({ root, cliPath: fakeCli, evidenceDir, runner: () => { calls++; throw Error('unexpected'); } });
  for (const edit of [
    value => { value.FunctionName = api.CLEANUP_FUNCTION; }, value => { value.EnvId = 'other'; },
    value => { value.Environment = { Variables: [] }; }, value => { value.InstallDependency = 'FALSE'; },
    value => { value.Publish = 'TRUE'; }, value => { value.Code = { ZipFile: 'not-base64' }; },
    value => { value.Code = { ZipFile: Buffer.from('not a ZIP').toString('base64') }; },
    value => { value.Code.CosObjectName = '/other'; },
    value => { value.Code.ZipFile = 'A'.repeat(Math.ceil(50 * 1024 * 1024 / 3) * 4 + 4); },
  ]) { const bad = structuredClone(body); edit(bad); assert.throws(() => client.scf('UpdateFunctionCode', bad)); }
  assert.equal(calls, 0);
});
