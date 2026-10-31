import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { mkdtemp, chmod, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { MomentError } from './moment-context.mjs';

export const LOCAL_WHISPER_MAX_DURATION_MS = 180000;
const PCM_BYTES_PER_SECOND = 16000 * 2;
const MAX_DECODED_BYTES = 181 * PCM_BYTES_PER_SECOND + 65536;
const MAX_TEXT_BYTES = 64 * 1024;
const DEMUXERS = Object.freeze({ 'audio/webm': 'matroska', 'audio/mp4': 'mov', 'audio/m4a': 'mov',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav' });

// One CPU job across adapter instances in this Node process. A second caller receives a retryable
// response; it does not create an unbounded queue of private recordings or overlapping model loads.
let activeJob = false;

function checkedPath(value, executable = false) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw new MomentError('provider_configuration_invalid', 503);
  try {
    accessSync(value, executable ? constants.X_OK : constants.R_OK);
    if (!statSync(value).isFile() || (!executable && !statSync(value).size)) throw new Error();
  } catch { throw new MomentError('provider_configuration_invalid', 503); }
  return value;
}
function abortedError(signal) {
  const timeout = signal.reason?.name === 'TimeoutError';
  return new MomentError(timeout ? 'provider_timeout' : 'request_aborted', timeout ? 504 : 499);
}

// Use execFile without a shell. Do not pass the server's credentials or loader/CLI override envs
// into native decoders. Kill immediately on cancellation/overflow and wait for close before the
// CPU slot or private directory is released; execFile's AbortError alone can precede actual exit.
function runFile(file, args, { signal, maxBytes, cwd, failureCode = 'provider_unavailable' }) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let outcome, stderrBytes = 0, overflow = false;
    const child = execFile(file, args, { cwd, shell: false, windowsHide: true, encoding: 'buffer',
      maxBuffer: maxBytes, killSignal: 'SIGKILL', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8',
        OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1', VECLIB_MAXIMUM_THREADS: '1' } },
    (error, stdout) => { outcome = { error, stdout }; });
    const abort = () => child.kill('SIGKILL');
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stdin?.end();
    child.stderr?.on('data', chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_TEXT_BYTES) { overflow = true; child.kill('SIGKILL'); }
    });
    child.once('close', () => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) { reject(abortedError(signal)); return; }
      if (overflow || outcome?.error || !Buffer.isBuffer(outcome?.stdout)) {
        // Native errors may contain file paths, arbitrary media metadata, or recognized words.
        // None become error messages, logs, or public response bodies.
        reject(new MomentError(failureCode, failureCode === 'audio_invalid' ? 422 : 502)); return;
      }
      resolve(outcome.stdout);
    });
  });
}

// ffmpeg writes a streaming RIFF header to stdout, whose data length can be UINT32_MAX. Read the
// actual bounded PCM payload, then write a normal seekable WAV for whisper.cpp. No duration claim
// from the client or container metadata participates in this sample-count limit.
export function decodedWhisperWav(source) {
  if (!Buffer.isBuffer(source) || source.length > MAX_DECODED_BYTES || source.length < 44 ||
    source.toString('ascii', 0, 4) !== 'RIFF' || source.toString('ascii', 8, 12) !== 'WAVE') throw new MomentError('audio_invalid', 422);
  let offset = 12, validFormat = false, pcm = null;
  while (offset + 8 <= source.length) {
    const tag = source.toString('ascii', offset, offset + 4);
    const declared = source.readUInt32LE(offset + 4);
    const start = offset + 8;
    const size = tag === 'data' && declared === 0xffffffff ? source.length - start : declared;
    if (size > source.length - start) throw new MomentError('audio_invalid', 422);
    if (tag === 'fmt ') {
      if (size < 16 || source.readUInt16LE(start) !== 1 || source.readUInt16LE(start + 2) !== 1 ||
        source.readUInt32LE(start + 4) !== 16000 || source.readUInt32LE(start + 8) !== PCM_BYTES_PER_SECOND ||
        source.readUInt16LE(start + 12) !== 2 || source.readUInt16LE(start + 14) !== 16) throw new MomentError('audio_invalid', 422);
      validFormat = true;
    }
    if (tag === 'data') {
      if (pcm) throw new MomentError('audio_invalid', 422);
      pcm = source.subarray(start, start + size);
    }
    offset = start + size + (size % 2);
  }
  if (!validFormat || !pcm?.length || pcm.length % 2) throw new MomentError('audio_invalid', 422);
  if (pcm.length > LOCAL_WHISPER_MAX_DURATION_MS / 1000 * PCM_BYTES_PER_SECOND) throw new MomentError('audio_duration_invalid', 413);
  if (!pcm.some(byte => byte !== 0)) throw new MomentError('speech_not_recognized', 422);
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(PCM_BYTES_PER_SECOND, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function createLocalWhisperAdapter({ whisperBin, modelPath, ffmpegBin, model = 'whisper-small-q5_1',
  timeoutMs = 110000, temporaryDirectory = tmpdir() } = {}) {
  checkedPath(whisperBin, true); checkedPath(ffmpegBin, true); checkedPath(modelPath);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 110000 ||
    typeof model !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/u.test(model) ||
    !isAbsolute(temporaryDirectory)) throw new MomentError('provider_configuration_invalid', 503);
  try {
    accessSync(temporaryDirectory, constants.W_OK | constants.X_OK);
    if (!statSync(temporaryDirectory).isDirectory()) throw new Error();
  } catch { throw new MomentError('provider_configuration_invalid', 503); }
  const recommendedSegmentMs = Math.min(30000, Math.max(1000, Math.floor((timeoutMs - 20000) / 3)));
  return { id: 'local-whisper', model,
    clientConfig: { requestTimeoutMs: timeoutMs + 20000, recommendedSegmentMs },
    async transcribe({ bytes, mimeType, language = 'zh', signal: externalSignal }) {
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(new DOMException('Deadline exceeded', 'TimeoutError')), timeoutMs);
      const signal = externalSignal ? AbortSignal.any([externalSignal, deadline.signal]) : deadline.signal;
      let directory, acquired = false;
      try {
        if (signal.aborted) throw abortedError(signal);
        if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 8 * 1024 * 1024) throw new MomentError('audio_too_large', 413);
        if (!Object.hasOwn(DEMUXERS, mimeType)) throw new MomentError('audio_format_unsupported', 415);
        if (typeof language !== 'string' || !/^[a-z]{2}$/u.test(language)) throw new MomentError('audio_language_invalid');
        if (activeJob) throw Object.assign(new MomentError('provider_rate_limited', 429), { retryAfterSeconds: 2 });
        activeJob = acquired = true;
        directory = await mkdtemp(join(temporaryDirectory, 'unseen-asr-'));
        await chmod(directory, 0o700);
        const inputPath = join(directory, 'source.audio'), wavPath = join(directory, 'speech.wav');
        await writeFile(inputPath, bytes, { mode: 0o600, flag: 'wx', signal });
        const decoded = await runFile(ffmpegBin, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-nostats', '-xerror',
          '-max_alloc', '67108864', '-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1',
          '-protocol_whitelist', 'file', '-probesize', '1048576', '-analyzeduration', '5000000',
          '-f', DEMUXERS[mimeType], ...(DEMUXERS[mimeType] === 'mov' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : []),
          '-i', inputPath, '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1',
          '-t', '181', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-threads', '1', '-f', 'wav', 'pipe:1'],
        { signal, maxBytes: MAX_DECODED_BYTES, cwd: directory, failureCode: 'audio_invalid' });
        await writeFile(wavPath, decodedWhisperWav(decoded), { mode: 0o600, flag: 'wx', signal });
        const output = await runFile(whisperBin, ['-m', modelPath, '-f', wavPath, '-l', language, '-t', '2', '-p', '1',
          '-ng', '-nt', '-np', '-bs', '1', '-bo', '1',
          ...(language === 'zh' ? ['--prompt', '以下是普通话的简体中文转写。'] : [])],
        { signal, maxBytes: MAX_TEXT_BYTES, cwd: directory });
        const text = new TextDecoder('utf-8', { fatal: true }).decode(output).trim();
        if (!text || /^\[(?:BLANK_AUDIO|NO_SPEECH|SILENCE)\]$/iu.test(text)) throw new MomentError('speech_not_recognized', 422);
        if (text.length > 12000) throw new MomentError('transcription_too_long', 413);
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw new MomentError('provider_reply_invalid', 502);
        if (signal.aborted) throw abortedError(signal);
        return { text, provider: 'local-whisper', model };
      } catch (error) {
        if (signal.aborted) throw abortedError(signal);
        throw error instanceof MomentError ? error : new MomentError('provider_unavailable', 502);
      } finally {
        clearTimeout(timer);
        try { if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 }); }
        catch { throw new MomentError('provider_unavailable', 502); }
        finally { if (acquired) activeJob = false; }
      }
    }
  };
}
