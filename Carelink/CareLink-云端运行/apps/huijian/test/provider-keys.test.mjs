import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

test('team mode uses explicit keys and does not read another agent secret store', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'unseen-provider-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, '.config/openclaw-secrets');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'runtime-secrets.json'), JSON.stringify({ authProfiles: {
    'minimax-cn': { apiKey: 'not-a-real-stored-key' }, worldlabs: { apiKey: 'not-a-real-stored-key' }
  } }));
  const code = `import {minimaxApiKey,worldLabsApiKey} from ${JSON.stringify(new URL('../lib/provider-keys.mjs', import.meta.url).href)};
    let missing=false;try{await minimaxApiKey()}catch(error){missing=error.message==='minimax_key_missing'}
    const world=await worldLabsApiKey();process.env.MINIMAX_API_KEY='not-a-real-explicit-key';
    console.log(JSON.stringify({missing,world,explicit:await minimaxApiKey()}));`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], { env: {
    ...process.env, HOME: home, USERPROFILE: home, MINIMAX_API_KEY: '', WORLDLABS_API_KEY: '', WLT_API_KEY: '', UNSEEN_PROVIDER_KEYS_ENV_ONLY: 'true'
  } });
  assert.deepEqual(JSON.parse(stdout), { missing: true, world: null, explicit: 'not-a-real-explicit-key' });
});
