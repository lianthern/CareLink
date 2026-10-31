#!/usr/bin/env node
// Build tools stay in ignored .tools; application/server dependencies are untouched.
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = path.join(root, '.tools/trtc-sdk-build');
const vendor = path.join(root, 'server/public/vendor');
const check = process.argv.slice(2).join(' ') === '--check';
if (process.argv.length > (check ? 3 : 2)) throw Error('Only --check is accepted');
await mkdir(buildRoot, { recursive: true });
for (const name of ['package.json', 'package-lock.json']) await copyFile(path.join(root, 'scripts/vendor/trtc-sdk', name), path.join(buildRoot, name));
const installed = spawnSync('npm', ['ci', '--prefix', buildRoot, '--registry=https://registry.npmjs.org', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit' });
if (installed.status !== 0) throw Error('Pinned vendor dependency installation failed');
const require = createRequire(path.join(buildRoot, 'package.json'));
const esbuild = require('esbuild');
if (esbuild.version !== '0.25.9') throw Error('Unexpected bundler version');
const bundled = await esbuild.build({
  absWorkingDir: buildRoot, entryPoints: ['node_modules/trtc-sdk-v5/trtc.esm.js'], outfile: 'trtc-5.19.2.mjs',
  bundle: true, format: 'esm', platform: 'browser', target: ['es2020'], minify: true,
  legalComments: 'inline', charset: 'utf8', write: false, metafile: true, logLevel: 'silent'
});
if (Object.values(bundled.metafile.outputs).some(output => output.imports.length)) throw Error('Vendor output still has an external import');
const code = Buffer.from('// Self-contained TRTC 5.19.2 + webrtc-adapter 9.0.4; see trtc-NOTICE.md.\n' + bundled.outputFiles[0].text);
const lock = JSON.parse(await readFile(path.join(buildRoot, 'package-lock.json'), 'utf8'));
const runtimeDependencies = Object.fromEntries(['trtc-sdk-v5', 'webrtc-adapter', 'sdp'].map(name => {
  const item = lock.packages['node_modules/' + name];
  return [name, { version: item.version, integrity: item.integrity }];
}));
const manifest = { bundler: 'esbuild@0.25.9', target: 'es2020', runtimeDependencies,
  bytes: code.length, sha256: createHash('sha256').update(code).digest('hex'), externalImports: 0 };
const outputs = new Map([
  ['trtc-5.19.2.mjs', code],
  ['trtc-5.19.2-build.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n')],
  ['webrtc-adapter-9.0.4-LICENSE.txt', await readFile(path.join(buildRoot, 'node_modules/webrtc-adapter/LICENSE.md'))],
  ['sdp-3.2.2-LICENSE.txt', await readFile(path.join(buildRoot, 'node_modules/sdp/LICENSE'))]
]);
for (const [name, bytes] of outputs) {
  if (check) {
    if (!(await readFile(path.join(vendor, name))).equals(bytes)) throw Error('Vendor artifact differs from its locked build: ' + name);
  } else await writeFile(path.join(vendor, name), bytes);
}
console.log(JSON.stringify({ check, ...manifest }, null, 2));
