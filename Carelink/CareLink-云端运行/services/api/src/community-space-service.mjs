import { assert } from './errors.mjs';
import { id } from './util.mjs';
import { PersonalMemoryService } from './personal-memory-service.mjs';

const text = (value, min, max) => { assert(typeof value === 'string' && value.trim().length >= min && value.length <= max, 'publication_text_invalid'); return value.trim(); };
const fingerprint = a => ({ id:a.id, kind:a.kind, key:a.private_object_key, hash:a.raw_sha256, bytes:a.observed_bytes, mime:a.observed_mime, width:a.width, height:a.height });
export class CommunitySpaceService {
  constructor(api) { this.api=api; this.core=api.core; this.db=api.db; this.snapshots=new PersonalMemoryService(this.core); }
  actor(ctx, mode) { return mode==='admin' ? this.api.adminConsole.admin(ctx) : this.core.account(ctx.accountSession); }
  source(accountId, spaceId) {
    const row=this.core.one(`SELECT s.* FROM spaces s JOIN accounts a ON a.id=s.owner_account_id LEFT JOIN account_administration m ON m.account_id=a.id
      WHERE s.id=? AND s.owner_account_id=? AND s.space_lifecycle='active' AND a.status='active' AND COALESCE(m.status,'active')='active'`,spaceId,accountId);
    assert(row,'publication_source_unavailable',404); return row;
  }
  owner(ctx,spaceId) { const a=this.actor(ctx,'owner'); return {account:a,space:this.source(a.accountId,spaceId)}; }
  asset(spaceId, assetId, kind) {
    const a=this.core.one("SELECT * FROM assets WHERE id=? AND space_id=? AND kind=? AND validation_state='valid'",assetId,spaceId,kind);
    assert(a && (!['photo_viewer_safe','video_viewer_safe'].includes(kind)||a.metadata_policy_result==='exif_gps_stripped'),'publication_media_unavailable',404); return a;
  }
  photo(accountId,spaceId,photoId) {
    const p=this.core.one(`SELECT p.* FROM photos p JOIN contribution_batches b ON b.id=p.batch_id AND b.space_id=p.space_id
      JOIN contribution_batch_items i ON i.id=p.batch_item_id AND i.batch_id=b.id AND i.space_id=p.space_id AND i.photo_id=p.id AND i.asset_id=p.asset_id
      WHERE p.id=? AND p.space_id=? AND p.deleted_at IS NULL AND p.photo_content_state='visible'
      AND b.actor_kind='account' AND b.actor_id=? AND i.status='committed' AND i.deleted_at IS NULL AND i.revoked_at IS NULL`,photoId,spaceId,accountId);
    assert(p && this.core.one("SELECT 1 FROM assets WHERE id=? AND space_id=? AND validation_state='valid'",p.asset_id,spaceId),'publication_photo_unavailable',404); return p;
  }
  panorama(space) { const r=this.core.one('SELECT * FROM panorama_revisions WHERE id=? AND space_id=?',space.current_panorama_revision_id,space.id); return r?{revision:r,asset:this.asset(space.id,r.asset_id,'panorama')}:{revision:null,asset:null}; }
  depth(space,revisionId) {
    const imported=this.core.one('SELECT account_id FROM app_spatial_imports WHERE space_id=? AND panorama_revision_id=?',space.id,revisionId);
    if(imported && imported.account_id!==space.owner_account_id) return null;
    const d=this.api.viewerMedia.depthImportFor(space.id,revisionId)||this.api.viewerMedia.depthArtifactFor(space.id,revisionId)?.depthMap;
    if(!d) return null;
    const a=this.asset(space.id,d.assetId,'depth_map'), raw=d.metadata||d, metadata={};
    for(const key of ['model','convention','min','max','width','height','encoding','nearMeters','farMeters']) if(typeof raw[key]==='string'||(typeof raw[key]==='number'&&Number.isFinite(raw[key]))) metadata[key]=raw[key];
    return {asset:fingerprint(a),metadata};
  }
  eligible(ctx,spaceId) {
    const {account,space}=this.owner(ctx,spaceId), {revision,asset}=this.panorama(space);
    const photos=[];
    for(const p of this.core.all('SELECT id FROM photos WHERE space_id=? AND deleted_at IS NULL ORDER BY id',spaceId)) {
      try { const photo=this.photo(account.accountId,spaceId,p.id); this.asset(spaceId,photo.viewer_safe_asset_id,'photo_viewer_safe');
        photos.push({id:p.id,mediaType:photo.media_type,previewAvailable:true,videoAvailable:photo.media_type==='video'&&!!this.asset(spaceId,photo.video_asset_id,'video_viewer_safe')}); } catch(e) { if(!e.status||e.status>=500) throw e; }
    }
    const row=this.core.one('SELECT * FROM community_space_submissions WHERE space_id=? AND account_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',spaceId,account.accountId);
    return {spaceId,spaceVersion:space.version,panorama:revision?{revisionId:revision.id,width:asset.width,height:asset.height}:null,depthAvailable:!!revision&&!!this.depth(space,revision.id),photos,submission:row?this.dto(row):null};
  }
  row(submissionId) { const r=this.core.one('SELECT * FROM community_space_submissions WHERE id=?',submissionId); assert(r,'publication_unavailable',404); return r; }
  snapshot(row) { return this.snapshots.get({accountId:row.account_id},row.snapshot_id).document; }
  dto(row, isPublic=false) {
    const d=this.snapshot(row), listing=this.core.one('SELECT featured,rank FROM public_space_listings WHERE community_submission_id=?',row.id);
    return {id:row.id,authorId:row.account_id,authorName:d.authorName,title:d.title,description:d.description,createdAt:row.created_at,publishedAt:row.published_at,featured:!!listing?.featured,rank:listing?.rank||0,
      ...(isPublic?{coverPhotoUrl:`/v1/public/spaces/${row.id}/media/${d.photos[0]?.previewKey||'panorama'}`} : {}),
      ...(!isPublic?{spaceId:row.space_id,status:row.status,version:row.version,reason:row.reason,updatedAt:row.updated_at}: {})};
  }
  state(ctx,submissionId,mode) {
    const actor=mode==='public'?null:this.actor(ctx,mode), row=this.row(submissionId);
    if(mode==='owner') assert(actor.accountId===row.account_id,'publication_unavailable',404);
    if(mode==='public') assert(row.status==='published'&&this.core.one("SELECT 1 FROM public_space_listings WHERE community_submission_id=? AND status='listed'",row.id),'publication_unavailable',404);
    this.source(row.account_id,row.space_id);
    const d=this.snapshot(row), revision=this.core.one('SELECT * FROM panorama_revisions WHERE id=? AND space_id=?',d.revisionId,row.space_id);
    if(d.media.panorama) assert(revision?.asset_id===d.media.panorama.id,'publication_media_unavailable',404);
    for(const p of d.photos) { const current=this.photo(row.account_id,row.space_id,p.sourceId); assert(current.viewer_safe_asset_id===d.media[p.previewKey].id&&(!p.videoKey||current.video_asset_id===d.media[p.videoKey].id),'publication_media_unavailable',404); }
    for(const frozen of Object.values(d.media)) { const current=this.asset(row.space_id,frozen.id,frozen.kind); assert(JSON.stringify(fingerprint(current))===JSON.stringify(frozen),'publication_media_unavailable',404); }
    return {row,document:d,actor};
  }
  detail(ctx,submissionId,mode) {
    const {row,document:d,actor}=this.state(ctx,submissionId,mode), prefix=mode==='public'?'/v1/public/spaces':mode==='admin'?'/v1/admin/community/spaces':'/v1/me/community/spaces';
    if(mode==='admin') { this.audit(ctx,actor,row,'preview'); this.api.adminConsole.inspectionAudit(actor,'community_space_preview','community_space_submission',row.id); }
    const url=k=>`${prefix}/${row.id}/media/${k}`;
    return {submission:this.dto(row,mode==='public'),space:{panorama:d.media.panorama?{url:url('panorama'),width:d.media.panorama.width,height:d.media.panorama.height}:null,depth:d.depth?{url:url('depth'),metadata:d.depth}:null,
      photos:d.photos.map(p=>({id:p.previewKey,mediaType:p.videoKey?'video':'photo',previewUrl:url(p.previewKey),videoUrl:p.videoKey?url(p.videoKey):null}))}};
  }
  media(ctx,submissionId,key,mode) {
    const s=this.state(ctx,submissionId,mode), frozen=Object.hasOwn(s.document.media,key)?s.document.media[key]:null;
    assert(frozen,'publication_media_unavailable',404);
    const a=this.asset(s.row.space_id,frozen.id,frozen.kind);
    if(mode==='admin') { this.audit(ctx,s.actor,s.row,'media'); this.api.adminConsole.inspectionAudit(s.actor,'community_space_media','community_space_submission',s.row.id); }
    return this.api.viewerMedia.serve(ctx,{submission:s.row.version},a,()=>{ const latest=this.state(ctx,submissionId,mode); assert(latest.row.version===s.row.version,'publication_changed',409); });
  }
  audit(ctx,actor,row,event) { this.core.audit({aggregateType:'community_space_submission',aggregateId:row.id,eventType:event,actorKind:'account',authorizationId:actor.accountId,detail:{},requestId:ctx.requestId}); }
  write(ctx,mode,endpoint,fn) {
    const a=this.actor(ctx,mode); assert(ctx.headers?.['x-unseen-expected-account-id']===undefined||ctx.headers['x-unseen-expected-account-id']===a.accountId,'account_changed',409);
    const result=this.core.mutation(ctx,{endpoint,scope:a.accountId,reauthorize:()=>this.actor(ctx,mode)},()=>fn(this.actor(ctx,mode)));
    const row=this.row(result.id); if(mode==='owner') assert(row.account_id===a.accountId,'publication_unavailable',404);
    return {submission:this.dto(row),...(result.replayed?{replayed:true}:{})};
  }
  submit(ctx,spaceId) {
    return this.write(ctx,'owner',`/v1/spaces/${spaceId}/community/submissions`,a=>{
      const space=this.source(a.accountId,spaceId), b=ctx.body;
      assert(b.expectedVersion===space.version,'version_conflict',409); assert(b.consent===true,'publication_consent_required');
      assert(typeof b.includeDepth==='boolean'&&Array.isArray(b.photoIds)&&b.photoIds.length<=100&&new Set(b.photoIds).size===b.photoIds.length,'publication_selection_invalid');
      assert(!this.core.one("SELECT 1 FROM community_space_submissions WHERE space_id=? AND status IN ('pending','published','unpublished')",spaceId),'publication_active_submission',409);
      const {revision,asset}=this.panorama(space), media=asset?{panorama:fingerprint(asset)}:{}, photos=[];
      const d={title:text(b.title,1,200),description:text(b.description,0,2000),authorName:text(b.authorName,1,80),revisionId:revision?.id||null,media,photos,depth:null};
      if(b.includeDepth) { assert(revision,'publication_depth_unavailable',404); const depth=this.depth(space,revision.id); assert(depth,'publication_depth_unavailable',404); media.depth=depth.asset; d.depth=depth.metadata; }
      for(const [index,pid] of b.photoIds.entries()) { assert(typeof pid==='string','publication_selection_invalid'); const p=this.photo(a.accountId,spaceId,pid), previewKey=`photo-${index}`,videoKey=p.media_type==='video'?`video-${index}`:null;
        media[previewKey]=fingerprint(this.asset(spaceId,p.viewer_safe_asset_id,'photo_viewer_safe')); if(videoKey) media[videoKey]=fingerprint(this.asset(spaceId,p.video_asset_id,'video_viewer_safe')); photos.push({sourceId:pid,previewKey,videoKey}); }
      assert(Object.keys(media).length>0,'publication_media_required');
      const submissionId=id('csp'),snapshotId=`submission:space:${submissionId}`,doc=JSON.stringify(d),size=Buffer.byteLength(doc), now=this.core.now();
      const usage=this.core.one('SELECT COUNT(*) count,COALESCE(SUM(byte_length),0) bytes FROM personal_memories WHERE account_id=?',a.accountId);
      assert(size<=24*1024*1024&&usage.bytes+size<=128*1024*1024&&usage.count<1000,'memory_storage_limit',413);
      this.db.prepare("INSERT INTO personal_memories(account_id,id,document_ciphertext,envelope_key_id,byte_length,version,created_at,updated_at,record_kind) VALUES(?,?,?,?,?,1,?,?,'snapshot')").run(a.accountId,snapshotId,this.core.keyring.seal(doc,`personal-memory-v1:${a.accountId}:${snapshotId}`),this.core.keyring.keyId,size,now,now);
      this.db.prepare("INSERT INTO community_space_submissions(id,account_id,space_id,snapshot_id,status,created_at,updated_at) VALUES(?,?,?,?,'pending',?,?)").run(submissionId,a.accountId,spaceId,snapshotId,now,now);
      this.db.prepare("INSERT INTO public_space_listings(id,space_id,status,created_at,updated_at,community_submission_id) VALUES(?,?,'requested',?,?,?) ON CONFLICT(space_id) DO UPDATE SET status='requested',community_submission_id=excluded.community_submission_id,open_url='',title_override='',description_override='',featured=0,rank=0,updated_at=excluded.updated_at,version=public_space_listings.version+1").run(id('psl'),spaceId,now,now,submissionId);
      this.audit(ctx,a,this.row(submissionId),'submitted'); return {id:submissionId};
    });
  }
  transition(ctx,submissionId,mode,presentation=false) {
    const endpoint=`${mode==='owner'?'/v1/me/community/spaces':'/v1/admin/community/spaces'}/${submissionId}/${mode==='owner'?'withdraw':presentation?'presentation':'review'}`;
    return this.write(ctx,mode,endpoint,a=>{
      const r=this.row(submissionId),b=ctx.body; if(mode==='owner') assert(r.account_id===a.accountId,'publication_unavailable',404);
      assert(b.expectedVersion===r.version,'version_conflict',409);
      const reason=mode==='owner'?'':text(b.reason,1,500), now=this.core.now(); let next=r.status;
      if(presentation) { assert(r.status==='published','publication_transition_invalid',409); assert(typeof b.featured==='boolean'&&Number.isSafeInteger(b.rank)&&Math.abs(b.rank)<=1000000,'publication_presentation_invalid'); this.db.prepare('UPDATE public_space_listings SET featured=?,rank=?,version=version+1,updated_at=? WHERE community_submission_id=?').run(Number(b.featured),b.rank,now,r.id); }
      else {
        const decision=mode==='owner'?'withdraw':b.decision, transitions={approve:['pending','published'],reject:['pending','rejected'],unpublish:['published','unpublished'],restore:['unpublished','published']};
        if(decision==='withdraw') { assert(['pending','published','unpublished'].includes(r.status),'publication_transition_invalid',409); next='withdrawn'; }
        else { const pair=transitions[decision]; assert(pair&&pair[0]===r.status,'publication_transition_invalid',409); next=pair[1]; }
        if(next==='published') this.state(ctx,r.id,'admin');
        const doc=this.snapshot(r);
        this.db.prepare("UPDATE public_space_listings SET status=?,title_override=?,description_override=?,open_url=?,listed_at=CASE WHEN ?='published' THEN ? ELSE listed_at END,hidden_at=CASE WHEN ?<>'published' THEN ? ELSE NULL END,updated_at=?,version=version+1 WHERE community_submission_id=?").run(next==='published'?'listed':'hidden',doc.title,doc.description,next==='published'?`/app#community-space/${r.id}`:'',next,now,next,now,now,r.id);
      }
      this.db.prepare("UPDATE community_space_submissions SET status=?,reason=?,version=version+1,updated_at=?,published_at=CASE WHEN ?='published' THEN COALESCE(published_at,?) ELSE published_at END WHERE id=?").run(next,reason,now,next,now,r.id);
      this.audit(ctx,a,r,presentation?'presentation':mode==='owner'?'withdraw':b.decision);
      if(mode==='admin') this.api.adminConsole.audit(a,`community_space_${presentation?'presentation':b.decision}`,'community_space_submission',r.id,r.status,next,reason); return {id:r.id};
    });
  }
  list(ctx,mode) {
    const a=mode==='public'?null:this.actor(ctx,mode), q=ctx.query||{}, page=Number(q.page||1),pageSize=Number(q.pageSize||20);
    assert(Number.isSafeInteger(page)&&page>0&&Number.isSafeInteger(pageSize)&&pageSize>0&&pageSize<=100,'pagination_invalid');
    const entries=[];
    for(const r of this.core.all('SELECT s.* FROM community_space_submissions s LEFT JOIN public_space_listings l ON l.community_submission_id=s.id ORDER BY COALESCE(l.featured,0) DESC,COALESCE(l.rank,0) DESC,s.created_at DESC,s.id')) {
      if(mode==='owner'&&r.account_id!==a.accountId||q.authorId&&q.authorId!==r.account_id||q.status&&q.status!==r.status) continue;
      try { this.state(ctx,r.id,mode); const dto=this.dto(r,mode==='public'); if(q.q&&!`${dto.title} ${dto.description} ${dto.authorName}`.toLowerCase().includes(String(q.q).toLowerCase())) continue; entries.push(dto); } catch(e) { if(!e.status||e.status>=500) throw e; }
    }
    return {submissions:entries.slice((page-1)*pageSize,page*pageSize),total:entries.length,page,pageSize};
  }
}
export function registerCommunitySpaceRoutes(api,add) {
  const s=api.communitySpaces=new CommunitySpaceService(api);
  api.publicListings.community=s;
  add('GET','/v1/spaces/{sid}/community/eligible',(c,p)=>s.eligible(c,p.sid));
  add('POST','/v1/spaces/{sid}/community/submissions',(c,p)=>s.submit(c,p.sid));
  add('GET','/v1/me/community/spaces',c=>s.list(c,'owner'));
  add('POST','/v1/me/community/spaces/{id}/withdraw',(c,p)=>s.transition(c,p.id,'owner'));
  for(const [prefix,mode] of [['/v1/public/spaces','public'],['/v1/admin/community/spaces','admin'],['/v1/me/community/spaces','owner']]) {
    if(mode!=='owner') add('GET',prefix,c=>s.list(c,mode));
    add('GET',`${prefix}/{id}`,(c,p)=>s.detail(c,p.id,mode));
    add('GET',`${prefix}/{id}/media/{key}`,(c,p)=>s.media(c,p.id,p.key,mode));
  }
  add('POST','/v1/admin/community/spaces/{id}/review',(c,p)=>s.transition(c,p.id,'admin'));
  add('POST','/v1/admin/community/spaces/{id}/presentation',(c,p)=>s.transition(c,p.id,'admin',true));
}
