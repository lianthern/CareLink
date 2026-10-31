// Service-identity operator command. Records an explicit public allowlist under the
// existing unseen_demo account; never copies all of that account's private records.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,sep} from 'node:path';
import {openDatabase} from '../src/database.mjs';
const [source,manifest,expectedHash]=process.argv.slice(2);
if(!process.env.UNSEEN_API_DB||!source||!manifest||!/^[a-f0-9]{64}$/.test(expectedHash||''))throw Error('explicit_paths_and_hash_required');
const bytes=await readFile(source),catalog=JSON.parse(bytes),receipt=JSON.parse(await readFile(manifest));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
if(sha(bytes)!==expectedHash||receipt.catalogSha256!==expectedHash||catalog.author?.username!=='unseen_demo'||catalog.publication!==receipt.publication)throw Error('publication_mismatch');
const releaseRoot=resolve(source,'../../../..');
for(const asset of receipt.assets){const path=resolve(releaseRoot,asset.path);if(!path.startsWith(releaseRoot+sep)||!asset.path.startsWith('public/app-spatial/v1/')||sha(await readFile(path))!==asset.sha256)throw Error('publication_asset_mismatch');}
const db=openDatabase(process.env.UNSEEN_API_DB);
try{
 const account=db.prepare('SELECT account_id FROM account_password_credentials WHERE username=?').get('unseen_demo');
 if(!account)throw Error('existing_demo_account_required');
 const existing=db.prepare('SELECT catalog_sha256,maintainer_account_id FROM app_catalog_sources WHERE publication_id=?').get(catalog.publication);
 if(existing&&(existing.catalog_sha256!==expectedHash||existing.maintainer_account_id!==account.account_id))throw Error('immutable_publication_conflict');
 if(!existing)db.prepare('INSERT INTO app_catalog_sources(publication_id,maintainer_account_id,catalog_sha256,catalog_json,asset_manifest_json,created_at) VALUES(?,?,?,?,?,?)').run(catalog.publication,account.account_id,expectedHash,bytes.toString(),JSON.stringify(receipt),new Date().toISOString());
 console.log(JSON.stringify({registered:true,replayed:!!existing,publication:catalog.publication,catalogSha256:expectedHash,maintainer:'unseen_demo',caseCount:catalog.cases.length}));
}finally{db.close();}
