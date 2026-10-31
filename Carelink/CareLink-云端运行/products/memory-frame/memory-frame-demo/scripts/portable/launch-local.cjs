'use strict';
// Packaged beside START-WINDOWS.cmd. Only the local snapshot is opened here.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');
const crypto = require('node:crypto');
const root = __dirname;
const noOpen = process.argv.includes('--no-open');
const readyAt = process.argv.indexOf('--ready-file');
const readyFile = readyAt >= 0 ? process.argv[readyAt + 1] : null;
const lockServer = net.createServer(socket => socket.end());

async function claimLock() {
  // The OS releases this lock even after a forced close. Never run two
  // LocalStore instances against the same extracted preview directory.
  const identity = crypto.createHash('sha256').update(await fs.realpath(root)).digest('hex');
  const target = process.platform === 'win32' ? { path: '\\\\.\\pipe\\unseen-preview-' + identity.slice(0, 24) }
    : { host: '127.0.0.1', port: 40000 + parseInt(identity.slice(0, 8), 16) % 10000 };
  return await new Promise((resolve, reject) => {
    lockServer.once('error', error => {
      if (error.code === 'EADDRINUSE') { console.log('This preview is already running, or its local lock is busy. Return to the existing window.'); resolve(false); }
      else reject(error);
    });
    lockServer.listen(target, () => resolve(true));
  });
}

async function start() {
  // A colleague may already have cloud environment variables. The preview must
  // never inherit them or silently access the live database / paid AI providers.
  for (const name of Object.keys(process.env)) {
    if (/^(MEMORY_|AI_|ASR_|TENCENT|RTC_|TRTC_|TURN_|FAMILY_|DEMO_)/i.test(name)) delete process.env[name];
  }
  process.env.AI_REALTIME_ENABLED = '0';
  process.env.FAMILY_CALL_ENABLED = '0';
  if (!await claimLock()) return;
  const data = path.join(root, 'preview', 'data');
  try { await fs.access(data); }
  catch {
    const temporary = await fs.mkdtemp(path.join(root, 'preview', 'initializing-'));
    const candidate = path.join(temporary, 'data');
    try {
      await fs.cp(path.join(root, 'content', 'seed-data'), candidate, { recursive: true, errorOnExist: true, force: false });
      await fs.rename(candidate, data);
    } finally {
      // Only this process's freshly created temporary folder may be removed.
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
  await fs.access(path.join(data, 'records.json'));
  const { createApp } = require(path.join(root, 'preview', 'server', 'server.js'));
  const { server } = await createApp({ dataDir: data });
  server.once('close', () => { lockServer.close(); });
  server.on('error', () => { lockServer.close(); console.error('Local preview could not start. Check the folder permissions.'); process.exitCode = 1; });
  server.listen(0, '127.0.0.1', async () => {
    const origin = 'http://127.0.0.1:' + server.address().port;
    console.log('unseen local preview: ' + origin + '/family');
    console.log('Login: private-access/LOCAL-PREVIEW-LOGIN.txt');
    console.log('Local content only. Use OPEN-ONLINE.url for online AI. Ctrl+C stops this preview.');
    if (readyFile) await fs.writeFile(readyFile, JSON.stringify({ origin, pid: process.pid, storage: 'local' }));
    if (!noOpen && process.platform === 'win32') {
      const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', origin + '/family'], { windowsHide: true, detached: true, stdio: 'ignore' });
      browser.on('error', () => {}); browser.unref();
    } else if (!noOpen && process.platform === 'darwin') {
      const browser = spawn('open', [origin + '/family'], { detached: true, stdio: 'ignore' });
      browser.on('error', () => {}); browser.unref();
    }
  });
  const close = () => { server.close(); server.closeAllConnections(); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
start().catch(() => { lockServer.close(); console.error('Local preview startup failed. Fully extract the ZIP into a writable folder, then retry.'); process.exitCode = 1; });
