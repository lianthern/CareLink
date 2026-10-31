import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createLocalWhisperAdapter, decodedWhisperWav } from '../lib/moment-local-whisper.mjs';
import { createMomentProviders } from '../lib/moment-provider.mjs';
import { createMomentHttp } from '../lib/moment-http.mjs';

function wav(seconds = 0.1) {
  const pcm = Buffer.alloc(Math.round(seconds * 16000) * 2);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i * Math.PI / 8)), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
const voice = { bytes: wav(), mimeType: 'audio/wav', language: 'zh' };
const succeed = "process.stdout.write('这是我们一起画的彩色方格。\\n');";

async function fixture(t, { whisper = succeed, decoder, timeoutMs = 5000 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'moment-asr-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const whisperBin = join(directory, 'whisper-fixture'), ffmpegBin = join(directory, 'ffmpeg-fixture'), modelPath = join(directory, 'model.bin');
  const prelude = `#!${process.execPath}\nconst fs=require('node:fs');const path=require('node:path');\n`;
  await writeFile(modelPath, 'model fixture', { mode: 0o600 });
  await writeFile(whisperBin, prelude + whisper, { mode: 0o700 });
  await writeFile(ffmpegBin, prelude + (decoder ?? `process.stdout.write(Buffer.from('${wav().toString('base64')}', 'base64'));`), { mode: 0o700 });
  const options = { whisperBin, ffmpegBin, modelPath, temporaryDirectory: directory, timeoutMs };
  return { directory, options, adapter: createLocalWhisperAdapter(options), prelude,
    async noPrivateFiles() { assert.deepEqual((await readdir(directory)).filter(name => name.startsWith('unseen-asr-')), []); } };
}
async function waitFor(path) {
  for (let i = 0; i < 100; i++) { if (existsSync(path)) return JSON.parse(await readFile(path, 'utf8')); await delay(20); }
  throw new Error('fixture process did not start');
}

test('local readiness checks administrator files and never accepts missing binaries or keys as readiness', async t => {
  const f = await fixture(t);
  const env = { MOMENT_ASR_ADAPTER: 'local-whisper', MOMENT_ASR_WHISPER_BIN: f.options.whisperBin,
    MOMENT_ASR_WHISPER_MODEL: f.options.modelPath, MOMENT_ASR_FFMPEG_BIN: f.options.ffmpegBin };
  const adapter = createMomentProviders({ env }).transcription;
  assert.equal(adapter.id, 'local-whisper');
  assert.deepEqual(adapter.clientConfig, { requestTimeoutMs: 130000, recommendedSegmentMs: 30000 });
  assert.equal(createMomentProviders({ env: { ...env, MOMENT_ASR_WHISPER_MODEL: '/not-installed/model.bin' } }).transcription, null);
  assert.equal(createMomentProviders({ env: { ...env, MOMENT_ASR_WHISPER_BIN: 'whisper-cli' } }).transcription, null);
  assert.equal(createMomentProviders({ env: { ...env, MOMENT_ASR_TIMEOUT_MS: '999999' } }).transcription, null);
});

test('real subprocess lifecycle keeps originals, private permissions and administrator-only CLI settings', async t => {
  const f = await fixture(t);
  const capture = join(f.directory, 'capture.json');
  await writeFile(f.options.whisperBin, f.prelude + `
    const args=process.argv.slice(2), input=args[args.indexOf('-f')+1];
    fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({args,envNames:Object.keys(process.env),
      directoryMode:fs.statSync(process.cwd()).mode&511,inputMode:fs.statSync(input).mode&511,
      sourceMode:fs.statSync(path.join(process.cwd(),'source.audio')).mode&511,
      source:fs.readFileSync(path.join(process.cwd(),'source.audio')).toString('base64')}));
    ${succeed}`);
  const original = Buffer.from(voice.bytes);
  const result = await f.adapter.transcribe({ ...voice, modelPath: '/client-controlled', whisperBin: '/client-controlled', extension: ';touch sentinel' });
  assert.deepEqual(result, { text: '这是我们一起画的彩色方格。', provider: 'local-whisper', model: 'whisper-small-q5_1' });
  assert.deepEqual(voice.bytes, original);
  const detail = JSON.parse(await readFile(capture, 'utf8'));
  assert.equal(detail.source, original.toString('base64'));
  assert.equal(detail.directoryMode, 0o700); assert.equal(detail.inputMode, 0o600); assert.equal(detail.sourceMode, 0o600);
  assert.ok(detail.args.includes(f.options.modelPath)); assert.ok(!detail.args.includes('/client-controlled'));
  assert.equal(detail.args[detail.args.indexOf('--prompt') + 1], '以下是普通话的简体中文转写。');
  assert.ok(!detail.envNames.some(key => /KEY|TOKEN|SECRET|WHISPER_ARG|LD_PRELOAD/u.test(key)));
  await f.noPrivateFiles();
  await f.adapter.transcribe({ ...voice, language: 'en' });
  assert.ok(!JSON.parse(await readFile(capture, 'utf8')).args.includes('--prompt'));
  await assert.rejects(f.adapter.transcribe({ ...voice, language: 'zh;touch sentinel' }), { code: 'audio_language_invalid' });
  await f.noPrivateFiles();
});

test('actual decoded samples enforce 180 seconds without silently returning the first 180 seconds', () => {
  assert.equal(decodedWhisperWav(wav(180)).length, 44 + 180 * 32000);
  assert.throws(() => decodedWhisperWav(wav(180.001)), { code: 'audio_duration_invalid', status: 413 });
  const streamed = wav(); streamed.writeUInt32LE(0xffffffff, 4); streamed.writeUInt32LE(0xffffffff, 40);
  const normalized = decodedWhisperWav(streamed);
  assert.equal(normalized.readUInt32LE(40), voice.bytes.length - 44);
  const corrupt = wav(); corrupt.writeUInt32LE(48000, 24);
  assert.throws(() => decodedWhisperWav(corrupt), { code: 'audio_invalid' });
  const silence = wav(); silence.fill(0, 44);
  assert.throws(() => decodedWhisperWav(silence), { code: 'speech_not_recognized' });
});

test('HTTP exposes local timing guidance without paths and keeps the same transcription/dedup contract', async t => {
  const f = await fixture(t, { timeoutMs: 110000 });
  let reservations = 0;
  const handler = createMomentHttp({ providers: { transcription: f.adapter }, timeoutMs: 120000,
    authenticate: async () => ({ accountId: 'fixture-account' }), identity: () => 'fixture',
    gate: { reserve: async () => { reservations++; return { ok: true, release() {} }; } } });
  const server = createServer((req, res) => handler(req, res, req.url));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const config = await (await fetch(`${url}/api/moment-config`)).json();
  assert.equal(config.transcription.enabled, true);
  assert.equal(config.transcription.requestTimeoutMs, 130000);
  assert.equal(config.transcription.recommendedSegmentMs, 30000);
  assert.ok(!JSON.stringify(config).includes(f.directory));
  const request = { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'voice-1', audio: { dataUrl: `data:audio/wav;base64,${voice.bytes.toString('base64')}` }, language: 'zh' }) };
  const first = await fetch(`${url}/api/moment-transcribe`, request);
  assert.equal(first.status, 200);
  const result = await first.json();
  assert.deepEqual(Object.keys(result).sort(), ['model', 'provider', 'text']);
  assert.deepEqual(await (await fetch(`${url}/api/moment-transcribe`, request)).json(), result);
  assert.equal(reservations, 1);
  await f.noPrivateFiles();
});

test('excess decoded duration skips inference and cleans up even when client metadata claims a short clip', async t => {
  const f = await fixture(t, { decoder: `process.stdout.write(Buffer.from('${wav(0.1).toString('base64')}', 'base64'));` });
  const longFile = join(f.directory, 'long.wav'); await writeFile(longFile, wav(181));
  await writeFile(f.options.ffmpegBin, f.prelude + `fs.createReadStream(${JSON.stringify(longFile)}).pipe(process.stdout);`);
  await writeFile(f.options.whisperBin, f.prelude + 'process.exit(99);');
  await assert.rejects(f.adapter.transcribe({ ...voice, durationMs: 1 }), { code: 'audio_duration_invalid', status: 413 });
  await f.noPrivateFiles();
});

test('concurrent callers across adapters are rejected; cancellation kills inference before freeing the slot', async t => {
  const f = await fixture(t);
  const marker = join(f.directory, 'started.json');
  await writeFile(f.options.whisperBin, f.prelude + `fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid}));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`);
  const abort = new AbortController();
  const pending = f.adapter.transcribe({ ...voice, signal: abort.signal });
  const rejected = assert.rejects(pending, { code: 'request_aborted', status: 499 });
  const child = await waitFor(marker);
  await assert.rejects(createLocalWhisperAdapter(f.options).transcribe(voice), { code: 'provider_rate_limited', status: 429 });
  abort.abort(); await rejected;
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  await f.noPrivateFiles();
  await writeFile(f.options.whisperBin, f.prelude + succeed);
  assert.equal((await f.adapter.transcribe(voice)).provider, 'local-whisper');
});

test('deadline also kills a stalled decoder, hides its stderr and releases its directory', async t => {
  const f = await fixture(t, { timeoutMs: 700 });
  const marker = join(f.directory, 'decoder.json');
  await writeFile(f.options.ffmpegBin, f.prelude + `fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid}));process.stderr.write('private source path and words');process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`);
  const pending = f.adapter.transcribe(voice);
  const rejected = assert.rejects(pending, error => error.code === 'provider_timeout' && !error.message.includes('private'));
  const child = await waitFor(marker); await rejected;
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  await f.noPrivateFiles();
});

test('empty, overlong, overflowed and failed CLI output never becomes a success or exposes stderr', async t => {
  const f = await fixture(t);
  for (const [script, code] of [
    ["process.stdout.write('  \\n');", 'speech_not_recognized'],
    ["process.stdout.write('x'.repeat(12001));", 'transcription_too_long'],
    ["process.stdout.write('x'.repeat(1000000));setInterval(()=>{},1000);", 'provider_unavailable'],
    ["process.stderr.write('s'.repeat(100000));setInterval(()=>{},1000);", 'provider_unavailable'],
    ["process.stderr.write('SECRET private path original speech');process.exit(1);", 'provider_unavailable']
  ]) {
    await writeFile(f.options.whisperBin, f.prelude + script);
    await assert.rejects(f.adapter.transcribe(voice), error => error.code === code && !/SECRET|private|speech/u.test(error.message.replace('speech_not_recognized', '')));
    await f.noPrivateFiles();
  }
});

const ffmpeg = ['/usr/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(existsSync);
test('real ffmpeg decodes browser WebM/M4A and WAV, rejects invalid media and enforces decoded duration', { skip: !ffmpeg }, async t => {
  const f = await fixture(t);
  const adapter = createLocalWhisperAdapter({ ...f.options, ffmpegBin: ffmpeg });
  const source = join(f.directory, 'fixture.wav'); await writeFile(source, wav(0.2));
  const formats = [['audio/webm', 'webm', 'libopus'], ['audio/m4a', 'mp4', 'aac'], ['audio/mpeg', 'mp3', 'libmp3lame']];
  for (const [mimeType, format, codec] of formats) {
    const encoded = execFileSync(ffmpeg, ['-nostdin', '-loglevel', 'error', '-i', source, '-c:a', codec,
      ...(format === 'mp4' ? ['-movflags', 'frag_keyframe+empty_moov'] : []), '-f', format, 'pipe:1'], { maxBuffer: 1024 * 1024 });
    assert.equal((await adapter.transcribe({ bytes: encoded, mimeType, language: 'zh' })).provider, 'local-whisper');
  }
  assert.equal((await adapter.transcribe(voice)).provider, 'local-whisper');
  await assert.rejects(adapter.transcribe({ ...voice, bytes: wav(180.001), durationMs: 1 }), { code: 'audio_duration_invalid', status: 413 });
  await assert.rejects(adapter.transcribe({ ...voice, bytes: Buffer.from('#EXTM3U\nhttp://127.0.0.1:1/private\n') }), { code: 'audio_invalid', status: 422 });
  await f.noPrivateFiles();
});
