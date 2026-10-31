import {readFileSync,existsSync} from 'node:fs';
import {openDatabase,transaction} from '../src/database.mjs';
import {seedCommunityCases} from '../src/community-case-service.mjs';
let db;
try {
 if(process.argv.length!==3||!existsSync(process.env.UNSEEN_API_DB||''))throw new Error('existing_database_required');
 const file=readFileSync(process.argv[2]);if(file.length>4*1024*1024)throw new Error('inventory_too_large');
 const entries=JSON.parse(file);db=openDatabase(process.env.UNSEEN_API_DB);
 const count=transaction(db,()=>seedCommunityCases(db,entries));
 process.stdout.write(JSON.stringify({seeded:count})+'\n');
} catch(e){process.stderr.write(`Case inventory seed failed: ${e.code||e.message}\n`);process.exitCode=1;}finally{db?.close();}
