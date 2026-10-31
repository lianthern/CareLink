import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { retrievalTerms, selectScenePhotos } from './photo-scene-analysis.mjs';
export const sceneError=(code,status=400)=>Object.assign(new Error(code),{code,status});
const parse=s=>s?JSON.parse(s):null;
export class PhotoSceneStore {
  constructor(directory){
    mkdirSync(directory,{recursive:true,mode:0o700});this.directory=directory;
    this.db=new DatabaseSync(join(directory,'photos.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS photos(id TEXT PRIMARY KEY,owner TEXT NOT NULL,sha TEXT NOT NULL,bytes INTEGER NOT NULL,name TEXT NOT NULL,mime TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'uploading',stage TEXT NOT NULL DEFAULT 'upload',offset INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,retryAt INTEGER NOT NULL DEFAULT 0,error TEXT,version TEXT,metadata TEXT,descriptor TEXT,hash TEXT,groupId TEXT,locked INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,updated INTEGER NOT NULL,UNIQUE(owner,sha));
      CREATE INDEX IF NOT EXISTS photos_queue ON photos(state,retryAt,updated);
      CREATE INDEX IF NOT EXISTS photos_owner ON photos(owner,created,id);
      CREATE INDEX IF NOT EXISTS photos_group ON photos(owner,groupId);
      CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY,owner TEXT NOT NULL,name TEXT NOT NULL,confirmed INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,reason TEXT NOT NULL,spaceId TEXT,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS edges(owner TEXT NOT NULL,a TEXT NOT NULL,b TEXT NOT NULL,data TEXT NOT NULL,version TEXT NOT NULL,PRIMARY KEY(owner,a,b));
      CREATE TABLE IF NOT EXISTS exclusions(owner TEXT NOT NULL,a TEXT NOT NULL,b TEXT NOT NULL,PRIMARY KEY(owner,a,b));
      CREATE TABLE IF NOT EXISTS links(owner TEXT NOT NULL,spaceId TEXT NOT NULL,photoId TEXT NOT NULL,canonicalPhotoId TEXT NOT NULL,PRIMARY KEY(owner,spaceId,photoId));
      CREATE TABLE IF NOT EXISTS handoffs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,groupId TEXT NOT NULL,groupVersion INTEGER NOT NULL,photoIds TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS photo_search USING fts5(id UNINDEXED,owner UNINDEXED,terms);
      UPDATE photos SET state='queued' WHERE state='working';`);
  }
  transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  close(){this.db.close();}
  photo(owner,id){const p=this.db.prepare('SELECT * FROM photos WHERE owner=? AND id=?').get(owner,id);if(!p)throw sceneError('photo_not_found',404);return this.decode(p);}
  decode(p){return {...p,metadata:parse(p.metadata),descriptor:parse(p.descriptor)};}
  update(id,patch){const entries=Object.entries({...patch,updated:Date.now()});this.db.prepare(`UPDATE photos SET ${entries.map(([k])=>`${k}=?`).join(',')} WHERE id=?`).run(...entries.map(([,v])=>v&&typeof v==='object'?JSON.stringify(v):v),id);}
  create(owner,{sha,bytes,name,mime}){
    if(!/^[a-f0-9]{64}$/.test(sha)||!Number.isSafeInteger(bytes)||bytes<1||bytes>40*1048576||typeof name!=='string'||name.length>240||!['image/jpeg','image/png','image/webp','image/heic','image/heif'].includes(mime))throw sceneError('photo_policy',422);
    const old=this.db.prepare('SELECT id FROM photos WHERE owner=? AND sha=?').get(owner,sha);if(old)return this.photo(owner,old.id);
    const usage=this.db.prepare('SELECT COUNT(*) n,COALESCE(SUM(bytes),0) bytes FROM photos WHERE owner=?').get(owner);
    if(usage.n>=50000||usage.bytes+bytes>64*1024**3)throw sceneError('library_limit',413);
    const id=randomUUID(),now=Date.now();this.db.prepare('INSERT INTO photos(id,owner,sha,bytes,name,mime,created,updated) VALUES(?,?,?,?,?,?,?,?)').run(id,owner,sha,bytes,name,mime,now,now);return this.photo(owner,id);
  }
  status(owner){return Object.fromEntries(this.db.prepare('SELECT state,COUNT(*) n FROM photos WHERE owner=? GROUP BY state').all(owner).map(p=>[p.state,p.n]));}
  list(owner,{after='',group,limit=48}={}){
    const n=Math.max(1,Math.min(Number(limit)||48,100)),where=group==='unassigned'?' AND groupId IS NULL':group?' AND groupId=?':'';
    const rows=this.db.prepare(`SELECT * FROM photos WHERE owner=? AND id>?${where} ORDER BY id LIMIT ?`).all(owner,after,...(group&&group!=='unassigned'?[group]:[]),n+1);
    return {photos:rows.slice(0,n).map(p=>this.decode(p)),next:rows.length>n?rows[n-1].id:null};
  }
  groups(owner,after=''){
    const rows=this.db.prepare(`SELECT g.*,COUNT(p.id) count FROM groups g JOIN photos p ON p.groupId=g.id AND p.owner=g.owner WHERE g.owner=? AND g.id>? GROUP BY g.id ORDER BY g.id LIMIT 25`).all(owner,after);
    return {groups:rows.slice(0,24).map(g=>({...g,representatives:this.db.prepare('SELECT id,name,state FROM photos WHERE owner=? AND groupId=? ORDER BY created LIMIT 4').all(owner,g.id)})),next:rows.length>24?rows[23].id:null};
  }
  group(owner,id){const g=this.db.prepare('SELECT * FROM groups WHERE owner=? AND id=?').get(owner,id);if(!g)throw sceneError('group_not_found',404);return g;}
  newGroup(owner,name,reason){const id=randomUUID();this.db.prepare('INSERT INTO groups(id,owner,name,reason,created) VALUES(?,?,?,?,?)').run(id,owner,name.slice(0,80)||'待确认场景',reason,Date.now());return id;}
  index(p){this.db.prepare('DELETE FROM photo_search WHERE id=?').run(p.id);this.db.prepare('INSERT INTO photo_search(id,owner,terms) VALUES(?,?,?)').run(p.id,p.owner,retrievalTerms(p.descriptor).join(' '));}
  candidates(p){
    const terms=retrievalTerms(p.descriptor),ids=new Set();
    if(terms.length)for(const x of this.db.prepare('SELECT id FROM photo_search WHERE photo_search MATCH ? AND owner=? ORDER BY rank LIMIT 20').all(terms.map(t=>'"'+t+'"').join(' OR '),p.owner))ids.add(x.id);
    // Metadata is a retrieval hint only; no timestamp is synthesized from file mtime.
    if(p.metadata?.capturedAt)for(const x of this.db.prepare("SELECT id FROM photos WHERE owner=? AND state='done' AND ABS(json_extract(metadata,'$.capturedAtMs')-?)<7200000 ORDER BY ABS(json_extract(metadata,'$.capturedAtMs')-?) LIMIT 12").all(p.owner,p.metadata.capturedAtMs,p.metadata.capturedAtMs))ids.add(x.id);
    if(Number.isFinite(p.metadata?.latitude))for(const x of this.db.prepare("SELECT id FROM photos WHERE owner=? AND state='done' AND ABS(json_extract(metadata,'$.latitude')-?)<0.002 AND ABS(json_extract(metadata,'$.longitude')-?)<0.002 LIMIT 12").all(p.owner,p.metadata.latitude,p.metadata.longitude))ids.add(x.id);
    const seen=new Set();return [...ids].filter(id=>id!==p.id).map(id=>this.photo(p.owner,id)).filter(x=>x.state==='done'&&x.version===p.version&&x.groupId&&!x.locked&&!this.db.prepare('SELECT 1 FROM exclusions WHERE owner=? AND ((a=? AND b=?) OR (a=? AND b=?))').get(p.owner,p.id,x.id,x.id,p.id)).filter(x=>{if(seen.has(x.groupId))return false;seen.add(x.groupId);return true;}).slice(0,5);
  }
  edges(owner,ids){if(!ids.length)return [];return this.db.prepare(`SELECT a,b,data FROM edges WHERE owner=? AND a IN (${ids.map(()=>'?').join(',')}) AND b IN (${ids.map(()=>'?').join(',')})`).all(owner,...ids,...ids).map(e=>({a:e.a,b:e.b,...parse(e.data)}));}
  edit(owner,id,body){return this.transaction(()=>{
    const g=this.group(owner,id);if(body.version!==g.version)throw sceneError('group_version_conflict',409);
    const members=this.db.prepare('SELECT id FROM photos WHERE owner=? AND groupId=?').all(owner,id).map(p=>p.id);
    const selected=body.photoIds||[];if(!Array.isArray(selected)||selected.length>100||selected.some(p=>!members.includes(p)))throw sceneError('selection_invalid',422);
    let resultId=id;
    if(body.action==='rename'){if(typeof body.name!=='string'||!body.name.trim()||body.name.length>80)throw sceneError('name_invalid');this.db.prepare('UPDATE groups SET name=? WHERE id=?').run(body.name.trim(),id);}
    else if(body.action==='confirm')this.db.prepare('UPDATE groups SET confirmed=1 WHERE id=?').run(id);
    else if(['split','remove'].includes(body.action)){
      if(!selected.length)throw sceneError('selection_required');resultId=body.action==='split'?this.newGroup(owner,body.name||'拆分的场景','由你拆分，后续分析保留'):null;
      for(const pid of selected){this.update(pid,{groupId:resultId,locked:1});for(const other of members.filter(x=>!selected.includes(x)))this.db.prepare('INSERT OR IGNORE INTO exclusions VALUES(?,?,?)').run(owner,pid,other);}
    }else if(body.action==='merge'){
      const target=this.group(owner,body.targetId);if(target.id===id||target.version!==body.targetVersion)throw sceneError('group_version_conflict',409);
      this.db.prepare('UPDATE photos SET groupId=?,locked=1 WHERE owner=? AND groupId=?').run(id,owner,target.id);
      this.db.prepare('UPDATE groups SET version=version+1 WHERE id=?').run(target.id);
      this.db.prepare('UPDATE groups SET confirmed=0,reason=? WHERE id=?').run('由你合并，请重新确认地点与视角',id);
    }else if(body.action==='add'){
      if(!Array.isArray(body.addIds)||!body.addIds.length||body.addIds.length>100)throw sceneError('selection_required');
      for(const pid of body.addIds){const p=this.photo(owner,pid);if(p.groupId)throw sceneError('photo_already_grouped',409);this.update(pid,{groupId:id,locked:1});}
      this.db.prepare('UPDATE groups SET confirmed=0 WHERE id=?').run(id);
    }else if(body.action==='space'){
      if(typeof body.spaceId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(body.spaceId))throw sceneError('space_invalid');this.db.prepare('UPDATE groups SET spaceId=? WHERE id=?').run(body.spaceId,id);
    }else throw sceneError('action_invalid');
    this.db.prepare('UPDATE photos SET locked=1 WHERE owner=? AND groupId=?').run(owner,id);
    this.db.prepare('UPDATE groups SET version=version+1 WHERE id=?').run(id);return {group:this.group(owner,id),resultId};
  });}
  selection(owner,id){const group=this.group(owner,id);if(!group.confirmed)throw sceneError('group_confirmation_required',409);const photos=this.db.prepare("WITH ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY substr(hash,1,6) ORDER BY json_extract(descriptor,'$.quality')+json_extract(descriptor,'$.structure') DESC) AS viewRank FROM photos WHERE owner=? AND groupId=? AND state='done') SELECT * FROM ranked ORDER BY viewRank, json_extract(descriptor,'$.structure') DESC LIMIT 200").all(owner,id).map(p=>this.decode(p));return {group,...selectScenePhotos(photos,this.edges(owner,photos.map(p=>p.id))),considered:photos.length};}
  source(owner,source){const row=this.db.prepare('SELECT * FROM handoffs WHERE owner=? AND id=?').get(owner,source?.handoffId||'');if(!row)throw sceneError('scene_source_invalid',422);const ids=JSON.parse(row.photoIds);return {handoffId:row.id,groupId:row.groupId,groupVersion:row.groupVersion,photos:ids.map(id=>{const p=this.photo(owner,id);return {id:p.id,sha:p.sha};})};}
  handoff(owner,id,body){const group=this.group(owner,id);if(!group.confirmed||group.version!==body.version)throw sceneError('group_version_conflict',409);const ids=body.photoIds;if(!Array.isArray(ids)||new Set(ids).size!==ids.length||ids.length<2||ids.length>8)throw sceneError('selection_invalid',422);for(const id of ids){const p=this.photo(owner,id);if(p.groupId!==group.id||p.state!=='done')throw sceneError('selection_invalid',422);}const previous=this.db.prepare('SELECT id FROM handoffs WHERE owner=? AND groupId=? AND groupVersion=? AND photoIds=?').get(owner,id,group.version,JSON.stringify(ids));if(previous)return {id:previous.id,groupVersion:group.version,photoIds:ids};const key=randomUUID();this.db.prepare('INSERT INTO handoffs VALUES(?,?,?,?,?,?)').run(key,owner,id,group.version,JSON.stringify(ids),Date.now());return {id:key,groupVersion:group.version,photoIds:ids};}
}
