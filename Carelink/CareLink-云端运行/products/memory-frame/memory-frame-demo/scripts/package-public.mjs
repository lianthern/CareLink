// Export reviewed application source from an explicit Git revision. Never read
// worktree/private files. This internal exporter is not copied into the public repo.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const prefix = 'memory-frame-demo/';
const templates = prefix + 'public-release/';
const scripts = new Set(['scripts/build-fonts.py', 'scripts/check-trtc-readiness.mjs', 'scripts/portable-content.mjs']);
const rootFiles = new Set(['package.json', 'pnpm-lock.yaml']);
const technicalDocs = new Set(['docs/PRESENCE-CLOUD-API.md']);
const testSupportFiles = new Set(['test/helpers/spatial-fixture.js']);
const devicePrefix = 'devices/link2-windows/';
// Deliberately enumerate reviewed files: adding a sibling source/test/configuration
// never silently makes it public. SDK headers/libraries belong to their upstream.
const deviceFiles = new Set([
  'README.md', 'UPSTREAM.md', '.gitignore', 'presence_uploader.cjs',
  'start-cloud-uploader.ps1', 'build.ps1', 'CMakeLists.txt', 'main.cc',
  'detector_types.h', 'debug_ui.cc', 'debug_ui.h', 'video_stream_capture.cc', 'video_stream_capture.h',
  'test/presence_uploader.test.cjs', 'test/uploader-lifecycle.test.cjs', 'test/current-api.test.cjs', 'test/launcher.test.cjs',
]);
const textExtensions = new Set(['.js', '.mjs', '.cjs', '.json', '.yaml', '.yml', '.html', '.css', '.md', '.txt', '.py', '.sh', '.example', '.ps1', '.cc', '.cpp', '.c', '.h', '.hpp', '.cmake']);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (parent, child) => { const rel = path.relative(parent, child); return !rel || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

function git(source, args) {
  const result = spawnSync('git', ['-C', source, ...args], { maxBuffer: 80 * 1024 * 1024, windowsHide: true });
  if (result.status !== 0) throw Error('Git read failed; verify the source repository and revision (private output suppressed).');
  return result.stdout;
}
function accepted(relative) {
  if (relative.split('/').some(x => ['.git', '.tools', '.data', 'node_modules', 'private-access', 'reference'].includes(x))) return false;
  if (/\.(?:local|private)\.|(?:^|\/)\.env(?:\.|$)|\.(?:log|zip|bundle|pem|key|mp3|wav|sog)$/i.test(relative)) return false;
  if (relative.startsWith('server/public/assets/') && !relative.startsWith('server/public/assets/fonts/')) return false;
  if (relative === 'server/public/vendor/trtc-5.19.2.mjs') return false;
  const serverModule = /^server\/[a-z][a-z0-9-]*\.js$/.test(relative);
  const serverMeta = new Set(['server/package.json', 'server/pnpm-lock.yaml', 'server/pnpm-workspace.yaml', 'server/scf_bootstrap']);
  const frontend = /^server\/public\/[^/]+\.(?:js|mjs|css|html)$/.test(relative);
  const font = /^server\/public\/assets\/fonts\/unseen-sans\/(?:[^/]+\.(?:woff2|css)|manifest\.json|LICENSE\.txt|\.gitattributes)$/.test(relative);
  const vendor = /^server\/public\/vendor\/(?:playcanvas-2\.22\.3\.mjs|playcanvas-LICENSE\.txt|trtc-5\.19\.2-package\.json|trtc-NOTICE\.md|\.gitattributes)$/.test(relative);
  return rootFiles.has(relative) || scripts.has(relative) || technicalDocs.has(relative) || testSupportFiles.has(relative) || serverModule || serverMeta.has(relative) || frontend || font || vendor || /^test\/[^/]+\.test\.js$/.test(relative);
}
function sanitize(text, relative, transformations) {
  const replace = (regex, value, category) => {
    let count = 0; text = text.replace(regex, (...args) => { count++; return typeof value === 'function' ? value(...args) : value; });
    if (count) transformations.push({ path: relative, category, count });
  };
  // These old test examples matched a private demo login. Use unmistakable new
  // fixtures, including uppercase variants that test username normalization.
  replace(/unseen0([1-9])/gi, (match, n) => match === match.toUpperCase() ? `FIXTURE0${n}` : `fixture0${n}`, 'historical-login-fixture');
  replace(/fixture-not-production-9364/gi, 'fixture-only-password-9364', 'historical-password-fixture');
  replace(/memory-frame-demo-[a-z0-9]{10,}/gi, 'your-cloudbase-environment', 'deployment-environment');
  replace(/https:\/\/your-cloudbase-environment\.service\.tcloudbase\.com/g, 'https://example.invalid', 'deployment-origin');
  if (relative.startsWith(devicePrefix)) {
    replace(/https:\/\/[a-z0-9.-]+\.service\.tcloudbase\.com/gi, 'https://example.invalid', 'device-deployment-origin');
    // The private development tree nests the application one directory deeper.
    // Keep device tests and documentation usable after exporting a flat app root.
    replace(/((?:\.\.\/)+)memory-frame-demo\//g, (match, parents) => parents, 'device-application-reference');
  }
  replace(/MemoryFrameDemoRuntime/g, 'YourMemoryFrameRuntimeRole', 'deployment-role');
  replace(/GS3DC([a-f0-9]{32})/gi, (match, id) => /^0+$/.test(id) ? match : 'GS3DC' + sha('public-fixture-scene:' + id).slice(0, 32), 'external-scene-fixture');
  replace(/assets\/(couple1|couple2|daughter|dil|family|grandma|grandpa|grandson|house|son|today)\.jpg/g, (match, name) => `assets/${name}.png`, 'neutral-demo-asset');
  return text;
}
const scanRules = [
  ['deployment-environment', /memory-frame-demo-[a-z0-9]{10,}|MemoryFrameDemoRuntime/i],
  ['historical-login', /unseen0[1-9]|fixture-not-production-9364/i],
  ['private-filesystem-path', /(?:[A-Z]:[\\/](?:Users|ChatGPTData|CodexData|Projects)[\\/]|\/(?:Users|home)\/[a-zA-Z][\w.-]*\/)/],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['provider-key', /\b(?:AKIA[A-Z0-9]{16}|AKID[a-zA-Z0-9]{28,}|sk-[a-zA-Z0-9_-]{24,}|gh[pousr]_[a-zA-Z0-9]{30,}|github_pat_[a-zA-Z0-9_]{30,})\b/],
  ['bearer-jwt', /\beyJ[a-zA-Z0-9_-]{12,}\.[a-zA-Z0-9_-]{12,}\.[a-zA-Z0-9_-]{12,}\b/],
  ['sensor-token', /\bps1\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.[a-f0-9]{64}\b/i],
  ['signed-media-url', /https?:\/\/[^\s'"<>]+[?&](?:q-signature|X-Amz-Signature|x-cos-security-token|sign)=[a-zA-Z0-9%_-]{16,}/i],
  ['credential-url', /https?:\/\/[^\s/@:'"]+:[^\s/@'"]{16,}@/i],
];
export async function scanDirectory(output) {
  const files = [], findings = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const filename = path.join(dir, entry.name), relative = path.relative(output, filename).replaceAll('\\', '/');
      if (entry.isSymbolicLink()) { findings.push({ path: relative, category: 'symbolic-link' }); continue; }
      if (entry.isDirectory()) { if (['.git', '.data', '.tools', 'node_modules', 'private-access'].includes(entry.name)) findings.push({ path: relative, category: 'excluded-directory' }); else await walk(filename); continue; }
      files.push(relative);
      if (/(?:^|\/)(?:[^/]*[.-])?private\.json$|\.(?:local|private)\.|(?:^|\/)\.env(?:\.(?!example$)|$)|\.(?:pem|key|bundle|zip|rar|7z|tar|gz|exe|dll|lib|obj|pdb|wav|mp3|jpg|jpeg)$/i.test(relative)) findings.push({ path: relative, category: 'excluded-private-or-media-file' });
      const bytes = await fs.readFile(filename);
      if (relative.startsWith(devicePrefix)) {
        if (!deviceFiles.has(relative.slice(devicePrefix.length))) findings.push({ path: relative, category: 'unreviewed-device-file' });
        try { if (bytes.includes(0)) throw Error(); new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { findings.push({ path: relative, category: 'non-utf8-device-source' }); }
        if (/https:\/\/[a-z0-9.-]+\.service\.tcloudbase\.com/i.test(bytes.toString('utf8'))) findings.push({ path: relative, category: 'device-deployment-origin' });
      }
      if (!bytes.includes(0)) for (const [category, rule] of scanRules) if (rule.test(bytes.toString('utf8'))) findings.push({ path: relative, category });
    }
  }
  await walk(output);
  return { files: files.sort(), findings };
}
export async function build({ source, output, ref = 'HEAD' }) {
  source = await fs.realpath(source); output = path.resolve(output);
  output = path.join(await fs.realpath(path.dirname(output)), path.basename(output));
  const repo = git(source, ['rev-parse', '--show-toplevel']).toString().trim();
  if (within(repo, output)) throw Error('Output must be outside the source repository.');
  try { await fs.lstat(output); throw Error('Output already exists; choose a fresh output directory.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const revision = git(source, ['rev-parse', '--verify', ref + '^{commit}']).toString().trim();
  const tree = git(source, ['ls-tree', '-r', '-z', revision]).toString().split('\0').filter(Boolean).map(line => { const [meta, filename] = line.split('\t'); return { mode: meta.split(' ')[0], filename }; });
  const selected = tree.filter(({ filename }) => filename.startsWith(prefix) && accepted(filename.slice(prefix.length)));
  const selectedDevice = tree.filter(({ filename }) => filename.startsWith(devicePrefix) && deviceFiles.has(filename.slice(devicePrefix.length)));
  const templateFiles = tree.filter(({ filename }) => filename.startsWith(templates));
  if (!templateFiles.some(x => x.filename === templates + 'README.md') || !selected.some(x => x.filename === prefix + 'server/server.js')) throw Error('Required public templates/application files are absent from the selected revision. Commit the packaging changes first.');
  const transformations = [];
  await fs.mkdir(output, { recursive: true });
  for (const { filename, mode } of [...selected, ...selectedDevice, ...templateFiles]) {
    if (mode === '120000' || mode === '160000') throw Error('Symlink/submodule export refused.');
    const isTemplate = filename.startsWith(templates), isDevice = filename.startsWith(devicePrefix);
    const relative = isDevice ? filename : filename.slice(isTemplate ? templates.length : prefix.length);
    let bytes = git(source, ['show', `${revision}:${filename}`]);
    if (isDevice) {
      let decoded;
      try { if (bytes.includes(0)) throw Error(); decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw Error(`Device export refused: UTF-8 text required (${relative}).`); }
      bytes = Buffer.from(sanitize(decoded, relative, transformations));
    } else if (!bytes.includes(0) && (textExtensions.has(path.extname(relative)) || path.basename(relative).startsWith('.') || relative.endsWith('scf_bootstrap'))) bytes = Buffer.from(sanitize(bytes.toString('utf8'), relative, transformations));
    const dest = path.join(output, relative);
    await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.writeFile(dest, bytes, { mode: mode === '100755' ? 0o755 : 0o644 });
  }
  const { generate } = await import(pathToFileURL(path.join(output, 'scripts/generate-demo-assets.mjs')).href);
  await generate(output);
  const { files, findings } = await scanDirectory(output);
  const report = { format: 1, passed: findings.length === 0, scannedFiles: files.length, rules: scanRules.map(([category]) => category),
    exclusions: ['original Git history', 'historical delivery and account documents', 'runtime data and uploaded family media', 'local cloud settings and environment files', 'private tooling and machine paths', 'original demo photographs', 'TRTC SDK binary', 'device SDK files, binaries, build outputs, private configuration and original archives'],
    transformations, findings, limitation: 'Pattern-based scan complements the explicit file allowlist and manual source review; it cannot prove the absence of every possible secret.' };
  await fs.writeFile(path.join(output, 'SANITIZATION-REPORT.json'), JSON.stringify(report, null, 2) + '\n');
  if (findings.length) throw Error('Public export blocked by sensitive scan. Read SANITIZATION-REPORT.json for paths/categories only; no matched values are logged.');
  const manifestFiles = [...files, 'SANITIZATION-REPORT.json'].sort();
  const manifest = await Promise.all(manifestFiles.map(async relative => `${sha(await fs.readFile(path.join(output, relative)))}  ${relative}`));
  await fs.writeFile(path.join(output, 'SHA256SUMS'), manifest.join('\n') + '\n');
  return { fileCount: manifestFiles.length + 1, sanitized: true, sourceRevision: revision };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) { const key = process.argv[i].replace(/^--/, ''); if (!['source', 'output', 'ref'].includes(key) || !process.argv[i + 1]) throw Error('Usage: node scripts/package-public.mjs --source REPOSITORY --output NEW_DIRECTORY [--ref HEAD]'); options[key] = process.argv[i + 1]; }
  if (!options.source || !options.output) throw Error('--source and --output are required.');
  try { console.log(JSON.stringify(await build(options))); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
