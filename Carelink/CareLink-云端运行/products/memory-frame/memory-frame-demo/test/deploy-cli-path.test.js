'use strict';
// Exercise the installed CLI's actual path methods without loading its command
// router, logging in, packaging/uploading, or making any cloud request.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
let bundle;
try { bundle = process.env.CLOUDBASE_CLI_BUNDLE || require.resolve('@cloudbase/cli'); } catch {}

function method(source, className, methodName, nextName, globals) {
  const start = source.indexOf(`let ${className} = class ${className}`);
  assert.ok(start >= 0, 'locked CLI class must be present');
  const begin = source.indexOf(`    ${methodName}(`, start), end = source.indexOf(`    ${nextName}(`, begin);
  assert.ok(begin > start && end > begin, 'locked CLI method boundaries must be present');
  return vm.runInNewContext('({' + source.slice(begin, end) + '})', globals)[methodName];
}

test('locked CloudBase CLI resolves both generated commands to the exact server directory', { skip: !bundle }, async t => {
  const source = fs.readFileSync(bundle, 'utf8');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-cli-path-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverDir = path.join(root, 'server'); fs.mkdirSync(serverDir); fs.writeFileSync(path.join(serverDir, 'package.json'), '{"main":"server.js"}');
  const [, { deploy }, cleanup] = await Promise.all([import('../scripts/cloudbase-scf.mjs'), import('../scripts/deploy.mjs'), import('../scripts/prepare-realtime-cleanup.mjs')]);
  const api = await import('../scripts/cloudbase-scf.mjs');
  const config = { envId: api.ENV_ID, region: api.REGION, functions: [{ name: api.HTTP_FUNCTION, type: 'HTTP', runtime: 'Nodejs20.19', role: 'MemoryFrameDemoRuntime', envVariables: {
    MEMORY_CLOUDBASE_ENV: api.ENV_ID, AI_REALTIME_TRTC_APP_ID: '1600164141', AI_REALTIME_TRTC_SECRET_ID: 'synthetic-id', AI_REALTIME_TRTC_SECRET_KEY: 'synthetic-key',
  } }] };
  const file = path.join(root, 'cloudbaserc.local.json'); api.writePrivate(file, config);
  const detail = { FunctionName: api.HTTP_FUNCTION, Type: 'HTTP', Runtime: 'Nodejs20.19', Role: 'MemoryFrameDemoRuntime', Status: 'Active', Environment: api.environmentUpdate(api.HTTP_FUNCTION, config.functions[0].envVariables).Environment };
  let codeArgs, codeConfig;
  await deploy({ root, configPath: file, report: () => {}, client: { scf: () => detail, run: args => {
    codeArgs = args; codeConfig = JSON.parse(fs.readFileSync(args[args.indexOf('--config-file') + 1], 'utf8')); return {};
  } } });
  const globals = { path_1: { default: path }, fs_1: { ...fs, default: fs }, process: { cwd: () => root },
    __awaiter: (self, args, _P, generator) => new Promise((resolve, reject) => { const g = generator.apply(self, args || []); function step(v) { let r; try { r = g.next(v); } catch (e) { reject(e); return; } if (r.done) resolve(r.value); else Promise.resolve(r.value).then(step, reject); } step(); }),
    utils_1: { checkFullAccess: dir => assert.ok(fs.statSync(dir).isDirectory()), isDirectory: dir => fs.statSync(dir).isDirectory() },
    i18n_1: { t: text => text }, error_1: { CloudBaseError: Error },
  };
  const begin = source.indexOf('function resolveFuncPathWithConfig('), end = source.indexOf('exports.resolveFuncPathWithConfig =', begin);
  globals.common_utils_1 = { resolveFuncPathWithConfig: vm.runInNewContext('(' + source.slice(begin, end).trim() + ')', globals) };
  const updateWithConfig = method(source, 'CodeUpdate', 'updateWithConfig', 'updateWithoutConfig', globals);
  const resolved = await updateWithConfig.call({ doUpdateCode: options => options }, { name: api.HTTP_FUNCTION,
    dir: codeArgs[codeArgs.indexOf('--dir') + 1], envId: api.ENV_ID, config: codeConfig, functions: codeConfig.functions, log: { info() {} } });
  // This is the value passed to getCodeParams/FunctionPacker, not just a UI path.
  assert.equal(resolved.functionPath, serverDir); assert.equal(resolved.functionRootPath, root);
  assert.ok(fs.existsSync(path.join(resolved.functionPath, 'package.json')));

  const { deployment } = cleanup.cleanupPlan(config, root), cleanupArgs = cleanup.cleanupDeployArgs(path.join(root, 'cleanup.json'), root);
  const resolveDeployPath = method(source, 'FunctionDeploy', 'resolveFunctionPath', 'buildMissingFunctionConfig', globals);
  const cleanupPath = resolveDeployPath.call({}, { name: api.CLEANUP_FUNCTION, dir: cleanupArgs[cleanupArgs.indexOf('--dir') + 1],
    func: deployment.functions[0], functionRootPath: path.join(root, deployment.functionRoot), log: { info() {} } });
  assert.equal(cleanupPath, serverDir); assert.equal(deployment.functions[0].handler, 'ai-realtime-cleanup.main');
});
