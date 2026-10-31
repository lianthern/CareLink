#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const GROQ_BASE = 'https://api.groq.com/openai/v1';
const SECRET_STORE = join(homedir(), '.config', 'openclaw-secrets', 'runtime-secrets.json');
const serverPath = fileURLToPath(new URL('../server.mjs', import.meta.url));

// Return a child-only environment. Never print it, serialize it, or put secrets in command arguments.
// The injected reader lets tests exercise credential routing without opening the user's store.
export async function momentDevEnvironment({ env = process.env, readSecrets = async () => JSON.parse(await readFile(SECRET_STORE, 'utf8')) } = {}) {
  const result = { ...env };
  // The local adapter needs no API key. Its factory validates administrator-owned paths.
  if (result.MOMENT_ASR_ADAPTER === 'local-whisper') return result;
  const base = result.MOMENT_ASR_BASE_URL || GROQ_BASE;
  let url;
  try { url = new URL(base); } catch { throw new Error('asr_endpoint_invalid'); }
  const groqEndpoint = url.origin === 'https://api.groq.com' && url.pathname.replace(/\/+$/u, '') === '/openai/v1' && !url.search && !url.hash && !url.username && !url.password;
  if (result.MOMENT_ASR_ADAPTER && result.MOMENT_ASR_ADAPTER !== 'openai-compatible') throw new Error('asr_adapter_unsupported');
  if (!result.MOMENT_ASR_API_KEY) {
    if (!groqEndpoint) throw new Error('asr_explicit_key_required_for_custom_endpoint');
    let secrets;
    try { secrets = await readSecrets(); } catch { throw new Error('existing_groq_credential_unavailable'); }
    const key = secrets?.authProfiles?.groq?.apiKey;
    if (typeof key !== 'string' || !key.trim()) throw new Error('existing_groq_credential_unavailable');
    result.MOMENT_ASR_API_KEY = key;
  }
  if (!groqEndpoint && !result.MOMENT_ASR_MODEL) throw new Error('asr_explicit_model_required_for_custom_endpoint');
  result.MOMENT_ASR_ADAPTER = 'openai-compatible';
  result.MOMENT_ASR_BASE_URL = base;
  result.MOMENT_ASR_MODEL ||= 'whisper-large-v3-turbo';
  return result;
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: node tools/run-moment-dev.mjs [-- command ...args]\nDefault: node server.mjs\nReads the existing Groq credential into the child environment; never writes an env file.');
    return;
  }
  const args = process.argv.slice(2);
  if (args.length && args[0] !== '--') throw new Error('use_double_dash_before_devserver_command');
  const command = args.length > 1 ? args[1] : process.execPath;
  const commandArgs = args.length > 1 ? args.slice(2) : [serverPath];
  const env = await momentDevEnvironment();
  const child = spawn(command, commandArgs, { env, stdio: 'inherit', cwd: process.cwd() });
  const forward = signal => { if (!child.killed) child.kill(signal); };
  const onInt = () => forward('SIGINT'), onTerm = () => forward('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  await new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('devserver_start_failed')));
    child.once('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1); resolve(); });
  });
  process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    // Only fixed codes from this file; do not forward arbitrary filesystem/process error text.
    const allowed = new Set(['asr_endpoint_invalid', 'asr_adapter_unsupported', 'asr_explicit_key_required_for_custom_endpoint',
      'existing_groq_credential_unavailable', 'asr_explicit_model_required_for_custom_endpoint',
      'use_double_dash_before_devserver_command', 'devserver_start_failed']);
    console.error(`Moment development launch failed: ${allowed.has(error.message) ? error.message : 'configuration_unavailable'}`);
    process.exitCode = 1;
  });
}
