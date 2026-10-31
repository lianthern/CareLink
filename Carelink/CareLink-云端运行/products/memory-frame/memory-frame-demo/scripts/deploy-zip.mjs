import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { HTTP_FUNCTION, functionParams, writePrivate } from './cloudbase-scf.mjs';

export const MAX_DIRECT_ZIP_BYTES = 50 * 1024 * 1024;
const EXCLUDED = new Set(['node_modules', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package-lock.json', 'yarn.lock']);
function excluded(name) {
  return name.startsWith('.') || EXCLUDED.has(name) || /^cloudbaserc(?:\.|$)/i.test(name)
    || /(?:^|[.-])private(?:[.-]|$)/i.test(name) || /\.(?:log|pem|key|p12|pfx)$/i.test(name);
}

// Source is always this checkout's server directory; never accept a supplied ZIP
// or follow symlinks into credentials, node_modules, or another checkout.
export function buildDirectZip(root, evidenceDir) {
  const server = path.resolve(root, 'server');
  if (realpathSync(server) !== server || !lstatSync(server).isDirectory()) throw Error('Direct ZIP source must be the real server directory');
  const pkg = JSON.parse(readFileSync(path.join(server, 'package.json'), 'utf8'));
  if (pkg.dependencies?.['@cloudbase/node-sdk'] !== '3.18.3') throw Error('Direct ZIP requires the validated CloudBase SDK pinned to 3.18.3');
  const files = [];
  function visit(relative = '') {
    for (const name of readdirSync(path.join(server, relative)).sort()) {
      if (excluded(name)) continue;
      const entry = relative ? `${relative}/${name}` : name;
      if (/[\r\n\0]/.test(entry) || name.startsWith('-')) throw Error('Unsupported deployment filename');
      const detail = lstatSync(path.join(server, entry));
      if (detail.isSymbolicLink()) throw Error('Direct ZIP refuses symlinked runtime files');
      if (detail.isDirectory()) visit(entry);
      else if (detail.isFile()) files.push(entry);
      else throw Error('Direct ZIP requires regular runtime files');
    }
  }
  visit();
  for (const required of ['package.json', 'server.js', 'scf_bootstrap']) if (!files.includes(required)) throw Error(`Missing required runtime file: ${required}`);
  const directory = path.resolve(evidenceDir);
  if (directory === server || directory.startsWith(server + path.sep)) throw Error('Private ZIP evidence must be outside the server source');
  mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
  const archive = path.join(directory, 'server-code.zip');
  if (existsSync(archive)) throw Error('Refusing to append to an existing deployment ZIP');
  const result = spawnSync('zip', ['-q', '-X', archive, '-@'], { cwd: server, input: files.join('\n') + '\n', encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 });
  if (existsSync(archive)) chmodSync(archive, 0o600);
  if (result.error || result.status !== 0) throw Error('Local ZIP creation failed; no cloud code update was requested');
  const listed = spawnSync('unzip', ['-Z1', archive], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const entries = (listed.stdout || '').trimEnd().split('\n');
  if (listed.error || listed.status !== 0 || entries.length !== files.length || entries.some((entry, index) => entry !== files[index])) throw Error('ZIP contents differ from the approved server file list');
  const checked = spawnSync('unzip', ['-tqq', archive], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (checked.error || checked.status !== 0) throw Error('ZIP integrity verification failed');
  const bytes = statSync(archive).size;
  if (!bytes || bytes > MAX_DIRECT_ZIP_BYTES) throw Error('Direct ZIP exceeds the official Code.ZipFile 50 MiB limit');
  const buffer = readFileSync(archive);
  const manifest = { source: server, archive, bytes, sha256: createHash('sha256').update(buffer).digest('hex'), files };
  writePrivate(path.join(directory, 'server-code-manifest.json'), manifest);
  return { manifest, body: { ...functionParams(HTTP_FUNCTION), CodeSource: 'ZipFile',
    Code: { ZipFile: buffer.toString('base64') }, InstallDependency: 'TRUE', Publish: 'FALSE' } };
}
