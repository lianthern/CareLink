'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
(async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(__dirname, 'FILE-MANIFEST.json'), 'utf8'));
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (name.includes('\\') || name.split('/').includes('..') || path.isAbsolute(name)) throw Error('Invalid path');
    const actual = crypto.createHash('sha256').update(await fs.readFile(path.join(__dirname, name))).digest('hex');
    if (actual !== expected) throw Error('File mismatch: ' + name);
  }
  console.log('Verified ' + Object.keys(manifest.files).length + ' packaged files.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
