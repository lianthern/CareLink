import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, ENV_ID, REGION, CLEANUP_FUNCTION, readDeployConfig, stringEnvironment, writePrivate, functionParams } from './cloudbase-scf.mjs';

export function cleanupPlan(config, root = ROOT) {
  const source = stringEnvironment(config.functions[0].envVariables);
  if (config.envId !== ENV_ID || config.region !== REGION || source.MEMORY_CLOUDBASE_ENV !== ENV_ID) throw Error('Cleanup must use the existing environment');
  const env = { MEMORY_CLOUDBASE_ENV: ENV_ID, AI_REALTIME_CLEANUP_ENABLED: '1' };
  for (const key of ['AI_REALTIME_TRTC_APP_ID', 'AI_REALTIME_TRTC_REGION', 'AI_REALTIME_TRTC_SECRET_ID', 'AI_REALTIME_TRTC_SECRET_KEY', 'AI_REALTIME_TRTC_TOKEN']) {
    if (source[key]) env[key] = source[key];
  }
  for (const key of ['AI_REALTIME_TRTC_APP_ID', 'AI_REALTIME_TRTC_SECRET_ID', 'AI_REALTIME_TRTC_SECRET_KEY']) if (!env[key]?.trim()) throw Error('Cleanup control configuration is incomplete');
  const deployment = { envId: ENV_ID, region: REGION, functionRoot: '.', functions: [{
    name: CLEANUP_FUNCTION, dir: path.resolve(root, 'server'), type: 'Event', runtime: 'Nodejs20.19',
    handler: 'ai-realtime-cleanup.main', timeout: 60, memorySize: 512, role: 'MemoryFrameDemoRuntime',
    installDependency: true, isWaitInstall: true, public: false,
    // Store imports public/spatial-link.js through spatial-network; retain the
    // small shared JS files while excluding browser binaries and HTTP startup.
    ignore: ['node_modules/**', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
      'public/assets/**', 'public/vendor/**', 'scf_bootstrap', 'server.js'], envVariables: env,
  }] };
  const trigger = { ...functionParams(CLEANUP_FUNCTION), TriggerName: CLEANUP_FUNCTION, Type: 'timer',
    // CreateTrigger accepts the cron string; ListTriggers returns JSON with cron.
    TriggerDesc: '0 * * * * * *', Qualifier: '$LATEST', Enable: 'OPEN' };
  return { deployment, trigger };
}

export function cleanupDeployArgs(configPath, root = ROOT) {
  if (typeof configPath !== 'string' || !configPath) throw Error('A private cleanup config path is required');
  // Explicit --dir keeps both the legacy and current CLI packers on server/.
  return ['fn', 'deploy', CLEANUP_FUNCTION, '--dir', path.resolve(root, 'server'),
    '--config-file', path.resolve(configPath), '-e', ENV_ID, '-r', REGION, '--deployMode', 'zip', '--json'];
}

export function verifyCleanup(detail, triggers) {
  const list = Array.isArray(triggers) ? triggers : triggers?.Triggers || [];
  const trigger = list.find(item => item.TriggerName === CLEANUP_FUNCTION);
  let cron;
  try { cron = JSON.parse(trigger?.TriggerDesc || '{}').cron; } catch { /* Fail closed. */ }
  return { functionType: detail?.Type, eventFunction: detail?.Type === 'Event', handlerMatches: detail?.Handler === 'ai-realtime-cleanup.main',
    noHttpTrigger: !list.some(item => item.Type === 'http'), timerPresent: !!trigger,
    timerEnabled: trigger?.Enable === 1 || trigger?.Enable === 'OPEN', scheduleMatches: cron === '0 * * * * * *',
    actualInvocationVerified: false, expiredTaskStopVerified: false };
}

export function cleanupInvokeParams() {
  return { ...functionParams(CLEANUP_FUNCTION), InvocationType: 'RequestResponse', LogType: 'Tail',
    ClientContext: JSON.stringify({ Type: 'Timer', TriggerName: CLEANUP_FUNCTION, Time: new Date().toISOString() }) };
}

const COUNT_KEYS = ['scanned', 'candidates', 'attempted', 'ended', 'pending', 'skipped', 'errors', 'deferred'];
export function cleanupSummary(text) {
  let value;
  try { value = typeof text === 'string' ? JSON.parse(text) : text; } catch { return { cleanupResponseRecognized: false }; }
  if (!value || value.enabled !== true || typeof value.ok !== 'boolean') return { cleanupResponseRecognized: false, enabled: value?.enabled === true };
  const result = { cleanupResponseRecognized: true, enabled: true, ok: value.ok };
  for (const key of COUNT_KEYS) if (Number.isSafeInteger(value[key]) && value[key] >= 0) result[key] = value[key];
  return result;
}

export function summarizeCleanupInvocation(response) {
  const result = response?.Result || {};
  return { evidence: 'explicit-cloud-invocation', executionSucceeded: result.InvokeResult === 0 && !result.ErrMsg,
    ...cleanupSummary(result.RetMsg), functionRequestId: /^[a-zA-Z0-9-]{1,100}$/.test(result.FunctionRequestId || '') ? result.FunctionRequestId : undefined,
    scheduledInvocationVerified: false };
}

export function summarizeCleanupLogs(response) {
  return { totalCount: Number.isSafeInteger(response?.TotalCount) ? response.TotalCount : null,
    executions: (Array.isArray(response?.Data) ? response.Data : []).map(item => {
      let summary = cleanupSummary(item.RetMsg);
      if (!summary.cleanupResponseRecognized && typeof item.Log === 'string') {
        for (const line of item.Log.split('\n')) {
          const at = line.indexOf('[ai-realtime-cleanup]');
          if (at >= 0) { const candidate = cleanupSummary(line.slice(at + '[ai-realtime-cleanup]'.length).trim()); if (candidate.cleanupResponseRecognized) summary = candidate; }
        }
      }
      return { executionSucceeded: item.RetCode === 0 && item.InvokeFinished === 1,
        startTime: /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/.test(item.StartTime || '') ? item.StartTime : undefined,
        functionRequestId: /^[a-zA-Z0-9-]{1,100}$/.test(item.RequestId || '') ? item.RequestId : undefined, ...summary };
    }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), configAt = args.indexOf('--config'), outAt = args.indexOf('--out');
    if (configAt >= 0 && (!args[configAt + 1] || args[configAt + 1].startsWith('--'))) throw Error('--config requires a file path');
    if (outAt >= 0 && (!args[outAt + 1] || args[outAt + 1].startsWith('--'))) throw Error('--out requires a directory');
    const out = outAt >= 0 ? path.resolve(args[outAt + 1]) : path.join(ROOT, '.tools', 'realtime-cleanup-plan');
    const { config } = readDeployConfig(configAt >= 0 ? path.resolve(args[configAt + 1]) : undefined);
    const { deployment, trigger } = cleanupPlan(config);
    writePrivate(path.join(out, 'cloudbaserc.cleanup.private.json'), deployment);
    writePrivate(path.join(out, 'create-trigger.json'), trigger);
    console.log(JSON.stringify({ mode: 'offline-plan', cloudRequests: 0, outputDirectory: out, function: CLEANUP_FUNCTION,
      type: 'Event', public: false, timerMinutes: 1, envKeys: Object.keys(deployment.functions[0].envVariables),
      deploymentArgs: cleanupDeployArgs(path.join(out, 'cloudbaserc.cleanup.private.json')),
      actualInvocationVerified: false, expiredTaskStopVerified: false }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
