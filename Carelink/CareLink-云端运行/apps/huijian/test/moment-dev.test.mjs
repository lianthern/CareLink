import test from 'node:test';
import assert from 'node:assert/strict';
import { momentDevEnvironment } from '../tools/run-moment-dev.mjs';

test('development launcher routes an existing Groq credential only to the documented Groq endpoint', async () => {
  const env = { PORT: '4679', MINIMAX_API_KEY: 'not-a-real-existing-test-key' };
  const result = await momentDevEnvironment({ env, readSecrets: async () => ({ authProfiles: { groq: { apiKey: 'not-a-real-groq-fixture' } } }) });
  assert.equal(result.MOMENT_ASR_BASE_URL, 'https://api.groq.com/openai/v1');
  assert.equal(result.MOMENT_ASR_MODEL, 'whisper-large-v3-turbo');
  assert.equal(result.MOMENT_ASR_API_KEY, 'not-a-real-groq-fixture');
  assert.equal(result.PORT, env.PORT);
  assert.equal(env.MOMENT_ASR_API_KEY, undefined);
});

test('custom endpoint never silently receives the existing Groq key', async () => {
  let reads = 0;
  for (const url of ['https://other.example/v1', 'https://api.groq.com.other.example/openai/v1', 'https://api.groq.com/openai/v1?foo=bar']) {
    await assert.rejects(momentDevEnvironment({ env: { MOMENT_ASR_BASE_URL: url }, readSecrets: async () => { reads++; return {}; } }), /asr_explicit_key_required_for_custom_endpoint/u);
  }
  assert.equal(reads, 0);
});

test('explicit provider credentials and model are preserved without reading the local store', async () => {
  const result = await momentDevEnvironment({ env: { MOMENT_ASR_BASE_URL: 'https://other.example/v1', MOMENT_ASR_API_KEY: 'not-a-real-explicit-fixture', MOMENT_ASR_MODEL: 'explicit-model' }, readSecrets: async () => { throw new Error('must not read'); } });
  assert.equal(result.MOMENT_ASR_API_KEY, 'not-a-real-explicit-fixture');
  assert.equal(result.MOMENT_ASR_MODEL, 'explicit-model');
  assert.equal(result.MOMENT_ASR_ADAPTER, 'openai-compatible');
});

test('missing credential fails with a fixed code, never a source error that could contain credentials', async () => {
  await assert.rejects(momentDevEnvironment({ env: {}, readSecrets: async () => { throw new Error('sensitive-source'); } }), error => error.message === 'existing_groq_credential_unavailable');
});

test('local ASR starts with administrator configuration without reading a cloud key', async () => {
  const env = { MOMENT_ASR_ADAPTER: 'local-whisper', MOMENT_ASR_WHISPER_BIN: '/installed/whisper-cli',
    MOMENT_ASR_WHISPER_MODEL: '/installed/model.bin', MOMENT_ASR_FFMPEG_BIN: '/usr/bin/ffmpeg' };
  const result = await momentDevEnvironment({ env, readSecrets: async () => { throw new Error('must not read'); } });
  assert.deepEqual(result, env);
  assert.equal(result.MOMENT_ASR_API_KEY, undefined);
});
