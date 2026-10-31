#!/usr/bin/env node
// Opt-in supplier smoke test. Invoking without --execute performs no I/O.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { installRealtimeProbe } from './lib/realtime-probe-browser.mjs';

const origin = 'https://memory-frame-demo-d7djiee0702b6c.service.tcloudbase.com';
const script = fileURLToPath(import.meta.url), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = value => createHash('sha256').update(value).digest('hex');
const writePrivate = async (filename, value) => {
  const temporary = filename + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await fs.rename(temporary, filename);
};
async function api(action, data = {}, token) {
  if (!['login', 'logout', 'state', 'aiRealtimeCapabilities', 'aiRealtimeStop'].includes(action)) throw Error('API action denied');
  const response = await fetch(origin + '/api', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify({ action, data }) });
  if (!response.ok) throw Error('Probe API request failed');
  return response.json();
}
async function stopUntilEnded(record, timeoutMs = 75000) {
  const deadline = Date.now() + timeoutMs;
  do {
    try { if ((await api('aiRealtimeStop', { requestId: record.requestId }, record.token)).status === 'ended') return true; } catch {}
    await pause(2000);
  } while (Date.now() < deadline);
  return false;
}
async function watchdog(filename) {
  const read = async () => JSON.parse(await fs.readFile(filename, 'utf8'));
  let record = await read();
  if (record.origin !== origin || typeof record.token !== 'string' || !/^[a-f0-9-]{36}$/.test(record.requestId)
    || !Number.isSafeInteger(record.stopAt) || record.stopAt > Date.now() + 60000) return;
  await fs.writeFile(filename + '.ready', 'ready\n', { mode: 0o600 });
  while (!record.closed && Date.now() < record.stopAt + 10000) { await pause(500); record = await read(); }
  if (record.closed) return;
  const ended = await stopUntilEnded(record);
  let sessionRevoked = false;
  let parentAlive = false;
  if (Number.isSafeInteger(record.parentPid)) { try { process.kill(record.parentPid, 0); parentAlive = true; } catch {} }
  if (ended && !parentAlive) { try { await api('logout', {}, record.token); sessionRevoked = true; } catch {} }
  await writePrivate(filename + '.watchdog.json', { checkedAt: new Date().toISOString(), ended, sessionRevoked });
}
function help() {
  console.log(JSON.stringify({ mode: 'plan-only', networkRequests: 0, realtimeStarts: 0,
    execute: 'AI_UX_PLAYWRIGHT=<module path> AI_UX_CHROME=<Chrome path> node scripts/check-realtime-call.mjs --execute <private-accounts.json> <synthetic.wav> <private-output-dir> <cloud-cleanup-receipt.json>',
    limit: 'One Start attempt; synthetic audio only; active client stops after 45 seconds; independent Node watchdog repeats the same Stop. Cloud cleanup must already be verified.',
    limitation: 'A Stop timeout is not a confirmed end or a strict cloud billing cap. Supplier ASR/hy3/TTS semantics need separate bot-audio and bridge evidence review.' }, null, 2));
}
async function execute([accountsPath, audioPath, outputPath, cleanupPath]) {
  if (!accountsPath || !audioPath || !outputPath || !cleanupPath) throw Error('Missing explicit probe paths');
  if (!process.env.AI_UX_PLAYWRIGHT || !process.env.AI_UX_CHROME) throw Error('Use explicit isolated browser paths');
  const privateData = JSON.parse(await fs.readFile(accountsPath, 'utf8'));
  const accounts = privateData.accounts || privateData.credentials;
  if (!Array.isArray(accounts) || accounts.length !== 2 || accounts.some(value => !value.username || !value.password)) throw Error('Use existing two-account fixture');
  if (privateData.familyUrl && new URL(privateData.familyUrl).origin !== origin) throw Error('Wrong account destination');
  const cleanupBytes = await fs.readFile(cleanupPath), cleanup = JSON.parse(cleanupBytes);
  // This is an operator-provided receipt, not a self-verified cloud claim. The
  // underlying Timer configuration/invocation evidence must accompany it.
  if (cleanup.origin !== origin || cleanup.timerEnabled !== true || cleanup.cleanupInvocationSucceeded !== true || cleanup.noPublicHttpTrigger !== true
    || !Number.isFinite(Date.parse(cleanup.checkedAt)) || Math.abs(Date.now() - Date.parse(cleanup.checkedAt)) > 3600000) throw Error('Recent verified private cloud cleanup receipt required');
  const wav = await fs.readFile(audioPath);
  if (wav.length > 1000000 || wav.subarray(0, 4).toString() !== 'RIFF' || wav.subarray(8, 12).toString() !== 'WAVE') throw Error('Use a bounded synthetic WAV');
  const out = path.resolve(outputPath); await fs.mkdir(out, { recursive: true, mode: 0o700 }); await fs.chmod(out, 0o700);
  const reportPath = path.join(out, 'realtime-call-report.json'), recoveryPath = path.join(out, 'realtime-call-recovery.private.json');
  // Never overwrite a prior uncertain task or its cleanup credential.
  try { await fs.access(recoveryPath); throw Error('Use a fresh output directory for each explicitly authorized attempt'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const evidence = { checkedAt: new Date().toISOString(), origin, supplierTest: true, browserMode: 'fresh-headless-profile',
    cleanupReceiptSha256: digest(cleanupBytes), syntheticInputSha256: digest(wav), maximumStartAttempts: 1,
    requestedClientDurationMs: 45000, newFamilies: 0, contentWrites: 0, cameraUsed: false, physicalMicrophoneUsed: false,
    uiButtonVerified: false, asrHy3TtsSemanticsVerified: false, startsObserved: 0, stopConfirmed: false, sessionRevoked: false, pageErrors: 0 };
  let browser, page, session, recovery, watchdogProcess, watchdogTimer, aborted = false, stage = 'login';
  const interrupt = () => { aborted = true; if (page) void page.evaluate(() => window.realtimeProbe?.stop()).catch(() => {}); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    session = await api('login', { username: accounts[1].username, password: accounts[1].password });
    if (!session.token || !['owner', 'family'].includes(session.role)) throw Error('Existing account authentication failed');
    const [caps, before] = await Promise.all([api('aiRealtimeCapabilities', {}, session.token), api('state', {}, session.token)]);
    if (!caps.enabled || caps.provider !== 'tencent-trtc') throw Error('Realtime is not enabled');
    evidence.messageCountBefore = before.messagePage?.total;
    stage = 'browser-prepare';
    const { chromium } = createRequire(import.meta.url)(process.env.AI_UX_PLAYWRIGHT);
    browser = await chromium.launch({ executablePath: process.env.AI_UX_CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
    const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, permissions: [] });
    page = await context.newPage(); page.on('pageerror', () => evidence.pageErrors++);
    await page.addInitScript(() => {
      const deny = async () => { throw new DOMException('No physical devices in probe', 'NotAllowedError'); };
      navigator.mediaDevices.getUserMedia = deny; navigator.mediaDevices.getDisplayMedia = deny;
    });
    await page.goto(origin + '/family', { timeout: 20000 });
    // The CloudBase test domain shows its own acknowledgement on a fresh
    // browser. This is the observed website notice, never a browser TLS warning.
    if (await page.title() === '风险提醒') {
      if (new URL(page.url()).origin !== origin ||
          !(await page.locator('body').innerText()).includes(new URL(origin).hostname)) throw Error('Unexpected website notice');
      await page.getByRole('button', { name: '确定访问', exact: true }).click({ timeout: 10000 });
      evidence.testDomainNoticeAcknowledged = true;
    }
    await page.waitForFunction(() => !!window.MemoryRealtime?.createClient, null, { timeout: 10000 });
    if (aborted) throw Error('Probe interrupted before Start');
    recovery = { origin, token: session.token, requestId: randomUUID(), stopAt: Date.now() + 45000, parentPid: process.pid, closed: false };
    await writePrivate(recoveryPath, recovery);
    watchdogProcess = spawn(process.execPath, [script, '--watchdog', recoveryPath], { detached: true, stdio: 'ignore' }); watchdogProcess.unref();
    for (let i = 0; i < 30; i++) { try { await fs.access(recoveryPath + '.ready'); break; } catch {} await pause(100); }
    await fs.access(recoveryPath + '.ready');
    await page.route(origin + '/api', route => {
      const value = route.request().postDataJSON();
      if (!['aiRealtimeStart', 'aiRealtimeStatus', 'aiRealtimeStop'].includes(value.action) || value.data?.requestId !== recovery.requestId) return route.abort();
      if (value.action === 'aiRealtimeStart' && (++evidence.startsObserved > 1 || Date.now() >= recovery.stopAt)) return route.abort();
      return route.continue();
    });
    await page.evaluate(installRealtimeProbe, { token: session.token, requestId: recovery.requestId, wavBase64: wav.toString('base64'), stopAt: recovery.stopAt });
    // Node also stops the page independently of browser timers. If either this
    // process or the browser dies, the detached watchdog has the same request ID.
    watchdogTimer = setTimeout(() => { void page.evaluate(() => realtimeProbe.stop()).catch(() => {}); }, Math.max(1, recovery.stopAt - Date.now()));
    stage = 'one-bounded-call';
    await page.evaluate(() => { void realtimeProbe.start(); });
    while (!aborted && Date.now() < recovery.stopAt) {
      const sample = await page.evaluate(() => realtimeProbe.result);
      if (sample.phases.length > 1 && ['idle', 'stop-pending'].includes(sample.phases.at(-1))) break;
      await pause(500);
    }
    await page.evaluate(() => realtimeProbe.stop());
    evidence.browser = await page.evaluate(() => realtimeProbe.result);
    const recorded = await page.evaluate(() => realtimeProbe.recording());
    if (recorded) {
      const bytes = Buffer.from(recorded, 'base64'); await fs.writeFile(path.join(out, 'bot-reply.private.webm'), bytes, { mode: 0o600 });
      evidence.botReplyAudio = { bytes: bytes.length, sha256: digest(bytes), humanReviewed: false };
    }
    stage = 'stop-and-content-check';
    evidence.stopConfirmed = await stopUntilEnded(recovery);
    const after = await api('state', {}, session.token); evidence.messageCountAfter = after.messagePage?.total;
    evidence.transportPassed = evidence.startsObserved === 1 && evidence.browser.sdkEnteredRoom && evidence.browser.localAudioPublished
      && evidence.browser.remoteAudioTrack && evidence.browser.remoteAudioNonzero && evidence.stopConfirmed
      && evidence.browser.physicalDeviceAttempts === 0 && evidence.messageCountBefore === evidence.messageCountAfter;
  } catch {
    evidence.transportPassed = false; evidence.failure = { stage, reason: aborted ? 'Interrupted' : 'Precondition, network or supplier check failed; private credentials and provider details omitted' };
  } finally {
    clearTimeout(watchdogTimer);
    if (page) { try { await page.evaluate(() => window.realtimeProbe?.stop()); } catch {} }
    if (browser) await browser.close().catch(() => {});
    if (recovery && !evidence.stopConfirmed) evidence.stopConfirmed = await stopUntilEnded(recovery);
    if (session && (!recovery || evidence.stopConfirmed)) {
      try { await api('logout', {}, session.token); evidence.sessionRevoked = true; } catch {}
    }
    if (recovery && evidence.stopConfirmed && evidence.sessionRevoked) await writePrivate(recoveryPath, { origin, requestId: recovery.requestId, stopAt: recovery.stopAt, closed: true });
    else if (recovery) evidence.recoveryCredentialRetained = true;
    evidence.operatorActionRequired = Boolean(recovery && (!evidence.stopConfirmed || !evidence.sessionRevoked));
    evidence.completedAt = new Date().toISOString();
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    await writePrivate(reportPath, evidence);
    console.log(JSON.stringify(evidence, null, 2));
    process.exitCode = evidence.transportPassed && evidence.sessionRevoked ? 0 : 1;
  }
}
try {
  if (process.argv[2] === '--watchdog' && process.argv.length === 4) await watchdog(process.argv[3]);
  else if (process.argv[2] === '--execute' && process.argv.length === 7) await execute(process.argv.slice(3));
  else help();
} catch { console.error(JSON.stringify({ ok: false, reason: 'Invalid probe input or private cleanup file; inspect any report and recovery file before another attempt. No private values printed.' })); process.exitCode = 1; }
