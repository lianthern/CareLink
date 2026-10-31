import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { build, scanDirectory } from './package-public.mjs';

async function repositoryFixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'public-device-export-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const repo = path.join(temporary, 'source'); await fs.mkdir(repo);
  const put = async (name, content) => { const file = path.join(repo, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); };
  const git = args => {
    const result = spawnSync('git', ['-C', repo, ...args], { windowsHide: true });
    assert.equal(result.status, 0, 'fixture git command succeeds'); return result.stdout.toString().trim();
  };
  git(['init', '-q']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'user.name', 'fixture']);
  await put('memory-frame-demo/server/server.js', "console.log('fixture');\n");
  await put('memory-frame-demo/public-release/README.md', '# Public fixture\n');
  await put('memory-frame-demo/public-release/scripts/generate-demo-assets.mjs', await fs.readFile(new URL('../public-release/scripts/generate-demo-assets.mjs', import.meta.url)));
  return { temporary, repo, put, git, commit: () => { git(['add', '-f', '.']); git(['commit', '-qm', 'fixture snapshot']); return git(['rev-parse', 'HEAD']); } };
}

test('public export uses committed allowlisted files, blocks private extras, and produces repeatable bytes', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'public-export-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const repo = path.join(temporary, 'source'); await fs.mkdir(repo);
  const put = async (name, content) => { const file = path.join(repo, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); };
  const git = args => { const r = spawnSync('git', ['-C', repo, ...args], { windowsHide: true }); assert.equal(r.status, 0, 'fixture git command succeeds'); };
  git(['init', '-q']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'user.name', 'fixture']);
  await put('memory-frame-demo/server/server.js', "console.log('fixture');\n");
  await put('memory-frame-demo/server/.env.production', 'PRIVATE_FIXTURE=must-not-export\n');
  await put('memory-frame-demo/server/backup.json', '{"private":"must-not-export"}');
  await put('memory-frame-demo/docs/HANDOFF.md', 'private delivery history');
  await put('memory-frame-demo/docs/PRESENCE-CLOUD-API.md', '# Generic presence contract\n');
  await put('reference/unseen.html', 'private old reference');
  await put('memory-frame-demo/public-release/README.md', '# Public fixture\n');
  const generator = await fs.readFile(new URL('../public-release/scripts/generate-demo-assets.mjs', import.meta.url));
  await put('memory-frame-demo/public-release/scripts/generate-demo-assets.mjs', generator);
  git(['add', '.']); git(['commit', '-qm', 'fixture snapshot']);
  await put('memory-frame-demo/server/server.js', 'PRIVATE_UNCOMMITTED=must-not-export\n');
  await put('memory-frame-demo/server/untracked.js', 'PRIVATE_UNTRACKED=must-not-export\n');
  const one = path.join(temporary, 'one'), two = path.join(temporary, 'two');
  await build({ source: repo, output: one }); await build({ source: repo, output: two });
  assert.equal(await fs.readFile(path.join(one, 'server/server.js'), 'utf8'), "console.log('fixture');\n");
  for (const omitted of ['.git', 'server/.env.production', 'server/backup.json', 'server/untracked.js', 'docs/HANDOFF.md', 'reference']) await assert.rejects(fs.access(path.join(one, omitted)));
  assert.equal(await fs.readFile(path.join(one, 'SHA256SUMS'), 'utf8'), await fs.readFile(path.join(two, 'SHA256SUMS'), 'utf8'));
  assert.match(await fs.readFile(path.join(one, 'docs/PRESENCE-CLOUD-API.md'), 'utf8'), /Generic presence/);
  await assert.rejects(build({ source: repo, output: one }), /already exists/);
  await assert.rejects(build({ source: repo, output: path.join(repo, 'bad') }), /outside/);
});

test('sensitive scan returns only paths and categories, never matched secret bytes', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'public-scan-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const secret = 'AKID' + 'x'.repeat(32);
  await fs.writeFile(path.join(temporary, 'bad.js'), 'const key = "' + secret + '";');
  await fs.writeFile(path.join(temporary, '.env.production'), 'private configuration');
  const report = await scanDirectory(temporary);
  assert.ok(report.findings.some(x => x.path === 'bad.js' && x.category === 'provider-key'));
  assert.ok(report.findings.some(x => x.path === '.env.production' && x.category === 'excluded-private-or-media-file'));
  assert.equal(JSON.stringify(report).includes(secret), false);
});

test('public spatial tests retain their one reviewed helper with a sanitized scene, without opening the helpers directory', async t => {
  const f = await repositoryFixture(t), originalScene = 'GS3DC' + 'b'.repeat(32);
  const helper = 'test/helpers/spatial-fixture.js';
  await f.put('memory-frame-demo/' + helper, `module.exports = { SCENE: '${originalScene}' };\n`);
  await f.put('memory-frame-demo/test/spatial-import.test.js', "module.exports = require('./helpers/spatial-fixture');\n");
  const excluded = ['test/helpers/private.json', 'test/helpers/unreviewed.js', 'test/helpers/nested/spatial-fixture.js'];
  for (const name of excluded) await f.put('memory-frame-demo/' + name, 'PRIVATE-EXCLUDED-FIXTURE\n');
  f.commit();
  const output = path.join(f.temporary, 'export'); await build({ source: f.repo, output });
  const exported = await fs.readFile(path.join(output, helper), 'utf8');
  assert.match(exported, /GS3DC[a-f0-9]{32}/); assert.equal(exported.includes(originalScene), false);
  for (const name of excluded) await assert.rejects(fs.access(path.join(output, name)));
  const loaded = spawnSync(process.execPath, ['-e', "const fixture = require(process.argv[1]); if (!/^GS3DC[a-f0-9]{32}$/.test(fixture.SCENE)) throw Error('Missing fixture');", path.join(output, 'test/spatial-import.test.js')], { windowsHide: true });
  assert.equal(loaded.status, 0, 'exported test resolves its retained helper');
  const report = JSON.parse(await fs.readFile(path.join(output, 'SANITIZATION-REPORT.json'), 'utf8'));
  assert.ok(report.transformations.some(x => x.path === helper && x.category === 'external-scene-fixture'));
  assert.ok((await fs.readFile(path.join(output, 'SHA256SUMS'), 'utf8')).includes('  ' + helper + '\n'));
});

test('device export selects reviewed committed text at the explicit revision and sanitizes its public layout', async t => {
  const f = await repositoryFixture(t), prefix = 'devices/link2-windows/';
  const endpoint = 'https://camera-fixture.service.tcloudbase.com/api';
  const sources = new Map([
    ['README.md', `[API](../../memory-frame-demo/docs/PRESENCE-CLOUD-API.md)\n${endpoint}\n`],
    ['UPSTREAM.md', '# SDK obtained separately\n'], ['.gitignore', '*.private.json\nbuild/\n'],
    ['presence_uploader.cjs', `const endpoint = '${endpoint}';\n`],
    ['start-cloud-uploader.ps1', `\ufeff$env:PRESENCE_API_URL = '${endpoint}'\n`],
    ['build.ps1', '# Build with your separately installed SDK\n'],
    ['CMakeLists.txt', 'cmake_minimum_required(VERSION 3.20)\n'],
    ['main.cc', `const char* endpoint = "${endpoint}";\n`],
    ['detector_types.h', '#pragma once\n'], ['debug_ui.cc', '// reviewed source\n'], ['debug_ui.h', '#pragma once\n'],
    ['video_stream_capture.cc', '// reviewed source\n'], ['video_stream_capture.h', '#pragma once\n'],
    ['test/presence_uploader.test.cjs', "require('../presence_uploader.cjs');\n"],
    ['test/uploader-lifecycle.test.cjs', "require('../presence_uploader.cjs');\n"],
    ['test/current-api.test.cjs', "require('../../../memory-frame-demo/server/server');\n"],
    ['test/launcher.test.cjs', '// reviewed test\n'],
  ]);
  for (const [name, content] of sources) await f.put(prefix + name, content);
  const excluded = ['private.json', 'device.private.json', 'config.local.json', '.env', 'presence.token', 'unreviewed.ps1',
    'unreviewed.cc', 'test/extra.test.cjs', 'SDK/Link.h', 'SDK/Link.dll', 'include/vendor.h',
    'build/main.cc', 'build/Release/link2.exe', 'link2.exe', 'Link.dll', 'Link.lib', 'symbols.pdb', 'objects.obj',
    'original.rar', 'other.RAR', 'portable.zip', 'source.7z', 'source.tar.gz'];
  for (const name of excluded) await f.put(prefix + name, 'PRIVATE-EXCLUDED-FIXTURE\n');
  const revision = f.commit();
  const tracked = f.git(['ls-tree', '-r', '--name-only', revision]);
  for (const name of excluded) assert.ok(tracked.includes(prefix + name), 'dangerous fixture is actually tracked: ' + name);
  await f.put(prefix + 'main.cc', 'NEWER-COMMIT-MUST-NOT-EXPORT\n'); f.commit();
  await f.put(prefix + 'presence_uploader.cjs', 'UNCOMMITTED-MUST-NOT-EXPORT\n');
  await f.put(prefix + 'test/new-untracked.test.cjs', 'UNTRACKED-MUST-NOT-EXPORT\n');
  const output = path.join(f.temporary, 'export');
  assert.equal((await build({ source: f.repo, output, ref: revision })).sourceRevision, revision);
  for (const name of sources.keys()) {
    const text = await fs.readFile(path.join(output, prefix, name), 'utf8');
    assert.equal(text.includes(endpoint), false); assert.equal(text.includes('memory-frame-demo/'), false);
    assert.doesNotMatch(text, /MUST-NOT-EXPORT|PRIVATE-EXCLUDED-FIXTURE/);
  }
  for (const name of [...excluded, 'test/new-untracked.test.cjs']) await assert.rejects(fs.access(path.join(output, prefix, name)));
  assert.match(await fs.readFile(path.join(output, prefix, 'main.cc'), 'utf8'), /https:\/\/example\.invalid\/api/);
  assert.equal((await fs.readFile(path.join(output, prefix, 'start-cloud-uploader.ps1'))).subarray(0, 3).toString('hex'), 'efbbbf');
  const report = JSON.parse(await fs.readFile(path.join(output, 'SANITIZATION-REPORT.json'), 'utf8'));
  assert.equal(report.passed, true);
  for (const name of ['README.md', 'start-cloud-uploader.ps1', 'main.cc']) assert.ok(report.transformations.some(x => x.path === prefix + name && x.category === 'device-deployment-origin'));
  const manifest = await fs.readFile(path.join(output, 'SHA256SUMS'), 'utf8');
  for (const name of sources.keys()) assert.ok(manifest.includes('  ' + prefix + name + '\n'));
});

test('device PowerShell and C++ secrets block publication without echoing matching values', async t => {
  const sensorToken = ['ps1', '11111111-1111-4111-8111-111111111111', 'a'.repeat(64)].join('.');
  for (const [name, content, category] of [
    ['start-cloud-uploader.ps1', `$env:PRESENCE_SENSOR_TOKEN = '${sensorToken}'\n`, 'sensor-token'],
    ['main.cc', `const char* token = "${sensorToken}";\n`, 'sensor-token'],
    ['detector_types.h', 'const char* key = "' + 'AKID' + 'x'.repeat(32) + '";\n', 'provider-key'],
  ]) await t.test(name, async child => {
    const f = await repositoryFixture(child), relative = 'devices/link2-windows/' + name;
    await f.put(relative, content); f.commit();
    const output = path.join(f.temporary, 'export');
    await assert.rejects(build({ source: f.repo, output }), error => /blocked by sensitive scan/.test(error.message) && !error.message.includes(sensorToken));
    const reportText = await fs.readFile(path.join(output, 'SANITIZATION-REPORT.json'), 'utf8'), report = JSON.parse(reportText);
    assert.equal(report.passed, false); assert.ok(report.findings.some(x => x.path === relative && x.category === category));
    assert.equal(reportText.includes(sensorToken), false); await assert.rejects(fs.access(path.join(output, 'SHA256SUMS')));
  });
});

test('device text cannot bypass sanitization through NULs, UTF-16 or malformed UTF-8', async t => {
  for (const [label, bytes] of [['nul', Buffer.from('safe\0hidden')], ['utf16', Buffer.from('private-token', 'utf16le')], ['invalid', Buffer.from([0xc3, 0x28])]]) {
    await t.test(label, async child => {
      const f = await repositoryFixture(child); await f.put('devices/link2-windows/start-cloud-uploader.ps1', bytes); f.commit();
      await assert.rejects(build({ source: f.repo, output: path.join(f.temporary, 'export') }), /UTF-8 text required/);
    });
  }
});
