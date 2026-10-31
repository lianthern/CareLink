import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, ENV_ID, REGION, HTTP_FUNCTION, readDeployConfig, environmentOf, mergeEnvironment, sameEnvironment,
  writePrivate, createCloudClient, functionParams, environmentUpdate, waitActive } from './cloudbase-scf.mjs';
import { buildDirectZip } from './deploy-zip.mjs';

export async function deploy({ root = ROOT, configPath = path.join(root, 'cloudbaserc.local.json'), configOnly = false,
  verifyOnly = false, plan = false, directZip = false, client, evidenceDir, report = console.log, waitOptions } = {}) {
  const { config, func, env } = readDeployConfig(configPath);
  const summary = { environment: ENV_ID, function: HTTP_FUNCTION, region: REGION, environmentKeys: Object.keys(env), allValuesAreStrings: true };
  if (plan) return { ...summary, mode: 'offline-plan', cloudRequests: 0 };
  evidenceDir ||= path.join(root, '.tools', `deploy-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  client ||= createCloudClient({ root, evidenceDir });
  const before = await waitActive(client, HTTP_FUNCTION, waitOptions);
  if (before.FunctionName !== HTTP_FUNCTION || before.Type !== 'HTTP' || before.Runtime !== 'Nodejs20.19' || before.Role !== 'MemoryFrameDemoRuntime') throw Error('Live function differs from the approved deployment baseline');
  writePrivate(path.join(evidenceDir, 'before-function.private.json'), before);
  const original = environmentOf(before), desired = mergeEnvironment(original, env);
  writePrivate(path.join(evidenceDir, 'desired-environment.private.json'), environmentUpdate(HTTP_FUNCTION, desired));
  if (verifyOnly) return { ...summary, mode: 'readback', matches: sameEnvironment(original, desired), originalVariableCount: Object.keys(original).length, evidenceDir };
  report(`已保存私有部署快照：${evidenceDir}`);
  if (!configOnly && directZip) {
    const { manifest, body } = buildDirectZip(root, evidenceDir);
    report(`正在通过官方 SCF Code.ZipFile 更新函数代码（${manifest.bytes} 字节）；现有环境变量保持原样。`);
    await client.scf('UpdateFunctionCode', body);
  } else if (!configOnly) {
    // The code-only CLI command never updates config. CLI 3.8.3's fn deploy
    // reviver converts JSON-looking env strings into objects, so do not use it.
    // CLI 3.8.3 joins cwd + functionRoot (it does not resolve absolute roots),
    // and CodeUpdate forwards functionPath to its packer only for --dir.
    const serverDir = path.resolve(root, 'server');
    const codeConfig = { ...config, functionRoot: '.', functions: [{ ...func, dir: serverDir }] };
    delete codeConfig.functions[0].envVariables;
    const codeConfigPath = path.join(evidenceDir, 'code-only-config.json');
    writePrivate(codeConfigPath, codeConfig);
    report('正在更新函数代码；现有环境变量保持原样。');
    await client.run(['fn', 'code', 'update', HTTP_FUNCTION, '--dir', serverDir, '--config-file', codeConfigPath, '-e', ENV_ID, '-r', REGION, '--json'], { label: 'code-update', timeout: 600000 });
  }
  const afterCode = await waitActive(client, HTTP_FUNCTION, waitOptions);
  writePrivate(path.join(evidenceDir, 'after-code.private.json'), afterCode);
  if (!sameEnvironment(environmentOf(afterCode), original)) throw Error('Cloud environment changed during deployment; stopping before overwriting concurrent changes');
  if (!sameEnvironment(original, desired)) {
    report('通过官方 SCF API 写入字符串环境值并读回核对。');
    await client.scf('UpdateFunctionConfiguration', environmentUpdate(HTTP_FUNCTION, desired));
  }
  const after = await waitActive(client, HTTP_FUNCTION, waitOptions);
  writePrivate(path.join(evidenceDir, 'after-function.private.json'), after);
  if (!sameEnvironment(environmentOf(after), desired)) throw Error('Cloud environment readback differs; private before/after snapshots are retained');
  const result = { ...summary, mode: configOnly ? 'configuration-update' : 'code-and-configuration-update', verified: true,
    originalVariableCount: Object.keys(original).length, finalVariableCount: Object.keys(desired).length, evidenceDir,
    runtimeAudioVerified: false, timerInvocationVerified: false };
  writePrivate(path.join(evidenceDir, 'result.json'), result);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), at = args.indexOf('--config');
    if (!args.some(arg => ['--update', '--config-only', '--verify-only', '--plan'].includes(arg))) throw Error('Choose --update, --config-only, --verify-only or --plan; this tool never creates the HTTP function');
    if (at >= 0 && (!args[at + 1] || args[at + 1].startsWith('--'))) throw Error('--config requires a private file path');
    if (args.includes('--direct-zip') && !args.includes('--update')) throw Error('--direct-zip requires the explicit --update mode');
    const result = await deploy({ configPath: at >= 0 ? path.resolve(args[at + 1]) : undefined,
      configOnly: args.includes('--config-only'), verifyOnly: args.includes('--verify-only'), plan: args.includes('--plan'), directZip: args.includes('--direct-zip') });
    console.log(JSON.stringify(result, null, 2));
    if (result.matches === false) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
