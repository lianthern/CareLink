import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {validateExampleCatalog} from '../lib/moment-examples.mjs';

export function caseInventory(catalog,exampleCatalog={schemaVersion:1,examples:[]}){
 if(!Array.isArray(catalog?.cases)||catalog.cases.length>500)throw new Error('catalog_invalid');
 const entries=catalog.cases.map(c=>({id:'catalog-'+c.id,source:'catalog',sourceId:c.id,title:c.title,description:c.intro||c.notice||'',kind:c.type||'case',coverPhotoUrl:c.cover||null,previewUrl:`/app#case/${encodeURIComponent(c.id)}`}));
 for(const e of validateExampleCatalog(exampleCatalog).examples)entries.push({id:'example-'+e.id,source:'example',sourceId:e.id,title:e.title,description:e.notice||'',kind:'example',coverPhotoUrl:e.photos[0]?`/api/moment-examples/${e.id}/media/${e.photos[0].mediaId}`:null,previewUrl:`/app#example/${encodeURIComponent(e.id)}`});
 return entries;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const catalog=JSON.parse(await readFile(new URL('../public/app-spatial/v1/catalog.json',import.meta.url),'utf8'));
 const examples=process.argv[2]?JSON.parse(await readFile(join(process.argv[2],'catalog.json'),'utf8')):undefined;
 process.stdout.write(JSON.stringify(caseInventory(catalog,examples))+'\n');
}
