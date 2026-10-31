import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const rows=JSON.parse(fs.readFileSync(path.join(root,'deploy/media-sha256.json')));
for(const row of rows){const bytes=fs.readFileSync(path.join(root,row.path));if(bytes.length!==row.bytes||crypto.createHash('sha256').update(bytes).digest('hex')!==row.sha256)throw Error('Verification failed: '+row.path)}
console.log(`Verified ${rows.length} model/photo files.`);
