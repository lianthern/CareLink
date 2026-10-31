import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENV_ID = 'memory-frame-demo-d7djiee0702b6c';
export const REGION = 'ap-shanghai';
export const HTTP_FUNCTION = 'memory-frame-demo';
export const CLEANUP_FUNCTION = 'unseen-ai-realtime-cleanup';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE_CHILD = fileURLToPath(new URL('./cloudbase-cli-private.cjs', import.meta.url));
const ACTIONS = new Set(['GetFunction', 'GetFunctionAddress', 'UpdateFunctionConfiguration', 'UpdateFunctionCode', 'ListTriggers', 'CreateTrigger', 'Invoke', 'GetFunctionLogs']);

export function writePrivate(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function stringEnvironment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Expected an environment variable object');
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof item !== 'string') throw Error('Every environment Value must already be a string');
    Object.defineProperty(result, key, { value: item, enumerable: true, writable: true, configurable: true });
  }
  return result;
}

export function environmentOf(detail) {
  const variables = detail?.Environment?.Variables;
  if (!Array.isArray(variables)) throw Error('Cloud environment readback is missing');
  const env = {};
  for (const item of variables) {
    if (!item || typeof item.Key !== 'string' || Object.hasOwn(env, item.Key)) throw Error('Invalid cloud environment readback');
    Object.defineProperty(env, item.Key, { value: item.Value, enumerable: true, writable: true, configurable: true });
  }
  return stringEnvironment(env);
}

export function sameEnvironment(left, right) {
  return Object.keys(left).length === Object.keys(right).length && Object.entries(left).every(([key, value]) => Object.hasOwn(right, key) && right[key] === value);
}

export function mergeEnvironment(current, desired) {
  const before = stringEnvironment(current), next = stringEnvironment(desired);
  for (const [key, value] of Object.entries(next)) {
    if (Object.hasOwn(before, key) && before[key] !== value && !key.startsWith('AI_REALTIME_')) throw Error('Refusing to replace an existing non-realtime environment value');
  }
  return { ...before, ...next };
}

export function readDeployConfig(configPath = path.join(ROOT, 'cloudbaserc.local.json')) {
  let config;
  try { config = JSON.parse(readFileSync(configPath, 'utf8')); } catch { throw Error('Cannot read the private deployment JSON; values are not printed'); }
  if (config.envId !== ENV_ID || config.region !== REGION || config.functions?.length !== 1 || config.functions[0].name !== HTTP_FUNCTION) throw Error('Only the existing Shanghai environment and HTTP function are allowed');
  const func = config.functions[0];
  if (func.type !== 'HTTP' || func.role !== 'MemoryFrameDemoRuntime' || func.runtime !== 'Nodejs20.19') throw Error('Unexpected function type, runtime or role');
  const env = stringEnvironment(func.envVariables);
  if (env.MEMORY_CLOUDBASE_ENV !== ENV_ID) throw Error('Environment binding differs from the allowed environment');
  if (Object.values(env).some(value => /__COPY_EXISTING_|DO_NOT_DEPLOY_THIS_PLACEHOLDER/.test(value))) throw Error('Deployment still contains placeholder values');
  return { config, func, env };
}

export function functionParams(name = HTTP_FUNCTION) {
  if (![HTTP_FUNCTION, CLEANUP_FUNCTION].includes(name)) throw Error('Function is not in the deployment allowlist');
  return { FunctionName: name, Namespace: ENV_ID };
}

export function environmentUpdate(name, env) {
  return { ...functionParams(name), Environment: { Variables: Object.entries(stringEnvironment(env)).map(([Key, Value]) => ({ Key, Value })) } };
}

export function decodeCliJson(output) {
  const plain = output.replace(/\u001b\[[0-9;]*m/g, '');
  for (let at = plain.indexOf('{'); at >= 0; at = plain.indexOf('{', at + 1)) {
    try {
      const parsed = JSON.parse(plain.slice(at));
      if (!Object.hasOwn(parsed, 'data')) continue;
      const data = parsed.data?.Response ?? parsed.data;
      if (!data || typeof data !== 'object' || data.Error) throw Error('Cloud API returned an error');
      return data;
    } catch { /* Never echo a raw error containing GetFunction secrets. */ }
  }
  throw Error('Cloud CLI did not return a successful JSON envelope; inspect the private log');
}

export function createCloudClient({ root = ROOT, cliPath = path.join(root, 'node_modules/@cloudbase/cli/bin/tcb'), evidenceDir, runner = spawnSync } = {}) {
  if (!evidenceDir) throw Error('A private evidence directory is required');
  if (!existsSync(cliPath)) throw Error('CloudBase CLI is not installed in this checkout');
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 }); chmodSync(evidenceDir, 0o700);
  const minimalConfig = path.join(evidenceDir, 'api-config.json');
  writePrivate(minimalConfig, { envId: ENV_ID, region: REGION });
  let sequence = 0;
  function run(args, { body, label = 'cli', timeout = 120000 } = {}) {
    if (!/^[A-Za-z0-9-]+$/.test(label)) throw Error('Invalid private log label');
    const logPath = path.join(evidenceDir, `${String(++sequence).padStart(3, '0')}-${label}.log`);
    const result = runner(process.execPath, [PRIVATE_CHILD, cliPath, ...args], {
      cwd: root, input: JSON.stringify({ body }), encoding: 'utf8', timeout, maxBuffer: 24 * 1024 * 1024,
      env: { ...process.env, CI: '1', NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    writePrivate(logPath, String(result.stdout || '') + '\n' + String(result.stderr || ''));
    if (result.error || result.status !== 0) throw Error(`Cloud command failed; private evidence: ${logPath}`);
    return decodeCliJson(String(result.stdout || ''));
  }
  function scf(action, body) {
    if (!ACTIONS.has(action)) throw Error('SCF action is not in the deployment allowlist');
    if (![HTTP_FUNCTION, CLEANUP_FUNCTION].includes(body?.FunctionName)) throw Error('Function is not in the deployment allowlist');
    const expected = functionParams(body?.FunctionName);
    if (body?.Namespace !== expected.Namespace || body?.Region && body.Region !== REGION) throw Error('SCF request is outside the existing environment');
    if (action === 'UpdateFunctionConfiguration') {
      if (Object.keys(body).some(key => !['FunctionName', 'Namespace', 'Environment'].includes(key))) throw Error('Only environment changes are accepted by this helper');
      environmentOf(body);
    }
    if (action === 'UpdateFunctionCode') {
      const allowed = ['FunctionName', 'Namespace', 'CodeSource', 'Code', 'InstallDependency', 'Publish'];
      if (body.FunctionName !== HTTP_FUNCTION || body.CodeSource !== 'ZipFile'
        || body.InstallDependency !== 'TRUE' || body.Publish !== 'FALSE' || Object.keys(body).some(key => !allowed.includes(key))
        || !body.Code || Object.keys(body.Code).length !== 1 || typeof body.Code.ZipFile !== 'string') throw Error('Only a direct ZIP code update of the existing HTTP function is allowed');
      const encoded = body.Code.ZipFile;
      if (!encoded.length || encoded.length > Math.ceil(50 * 1024 * 1024 / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw Error('Invalid direct ZIP payload');
      const zip = Buffer.from(encoded, 'base64');
      if (zip.length > 50 * 1024 * 1024 || zip.length < 4 || zip.readUInt32LE(0) !== 0x04034b50 || zip.toString('base64') !== encoded) throw Error('Invalid direct ZIP payload');
    }
    if (action === 'CreateTrigger' && (body.FunctionName !== CLEANUP_FUNCTION || body.Type !== 'timer' || body.TriggerName !== CLEANUP_FUNCTION || body.Enable !== 'OPEN')) throw Error('Only the private cleanup Timer is allowed');
    if (action === 'Invoke') {
      let event;
      try { event = JSON.parse(body.ClientContext); } catch { throw Error('Cleanup invocation needs the fixed Timer event'); }
      if (body.FunctionName !== CLEANUP_FUNCTION || body.InvocationType !== 'RequestResponse' || event?.Type !== 'Timer' || event.TriggerName !== CLEANUP_FUNCTION || Object.keys(event).some(key => !['Type', 'TriggerName', 'Time'].includes(key))) throw Error('Only the private cleanup Timer can be invoked');
    }
    if (action === 'GetFunctionLogs' && body.FunctionName !== CLEANUP_FUNCTION) throw Error('Only cleanup logs are exposed by this helper');
    return run(['api', 'scf', action, '--api-version', '2018-04-16', '-e', ENV_ID, '-r', REGION, '--config-file', minimalConfig, '--json'], { body, label: action, timeout: action === 'UpdateFunctionCode' ? 600000 : 120000 });
  }
  return { scf, run };
}

export async function waitActive(client, name = HTTP_FUNCTION, { attempts = 60, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  for (let index = 0; index < attempts; index++) {
    const detail = await client.scf('GetFunction', functionParams(name));
    if (detail.Status === 'Active') return detail;
    if (/Failed|Deleting/.test(detail.Status || '')) throw Error('Cloud function entered a failure state');
    await wait(2000);
  }
  throw Error('Function readiness was not confirmed; inspect private deployment evidence');
}
