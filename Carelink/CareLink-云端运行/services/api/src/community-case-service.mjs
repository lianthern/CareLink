import { assert } from './errors.mjs';

const idPattern=/^[A-Za-z0-9_-]{1,120}$/;
function publicUrl(value) {
  if(value===null||value===undefined||value==='') return null;
  assert(typeof value==='string'&&value.length<=2000,'case_url_invalid');
  if(value.startsWith('/')&&!value.startsWith('//')&&!/[\\\r\n]/.test(value)) return value;
  let u; try {u=new URL(value);} catch {};
  assert(u?.protocol==='https:'&&!u.username&&!u.password,'case_url_invalid'); return u.href;
}
export function seedCommunityCases(db, entries, now=new Date().toISOString()) {
  assert(Array.isArray(entries)&&entries.length<=1000,'case_inventory_invalid');
  const seen=new Set();
  const normalized=entries.map(e=>{
    assert(['catalog','example'].includes(e.source)&&idPattern.test(e.sourceId)&&e.id===`${e.source}-${e.sourceId}`&&!seen.has(e.id),'case_inventory_invalid');seen.add(e.id);
    assert(typeof e.title==='string'&&e.title.trim()&&e.title.length<=300&&typeof e.description==='string'&&e.description.length<=10000&&typeof e.kind==='string'&&e.kind.length<=80,'case_inventory_invalid');
    return {...e,definition:JSON.stringify({title:e.title,description:e.description,kind:e.kind,coverPhotoUrl:publicUrl(e.coverPhotoUrl),previewUrl:publicUrl(e.previewUrl)})};
  });
  for(const e of normalized) db.prepare(`INSERT INTO community_case_display(id,source,source_id,public_definition,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET public_definition=excluded.public_definition`).run(e.id,e.source,e.sourceId,e.definition,now);
  return normalized.length;
}
export class CommunityCaseService {
 constructor(api){this.api=api;this.core=api.core;}
 row(id){const r=this.core.one('SELECT * FROM community_case_display WHERE id=?',id);assert(r,'case_unavailable',404);return r;}
 dto(r,isPublic=false){return {id:r.id,source:r.source,sourceId:r.source_id,...JSON.parse(r.public_definition),status:r.status,featured:!!r.featured,sortRank:r.sort_rank,...(isPublic?{}:{version:r.version,reason:r.reason,updatedAt:r.updated_at})};}
 list(ctx,isPublic=false){
  if(!isPublic)this.api.adminConsole.admin(ctx);
  const q=ctx.query||{}, {page,pageSize}=isPublic?{page:1,pageSize:1000}:this.api.adminConsole.page(q);
  assert(!q.status||['visible','hidden'].includes(q.status),'case_status_invalid');
  const cases=this.core.all('SELECT * FROM community_case_display ORDER BY featured DESC,sort_rank,id').filter(r=>(!isPublic||r.status==='visible')&&(!q.status||q.status===r.status)).map(r=>this.dto(r,isPublic)).filter(r=>!q.q||`${r.title} ${r.description} ${r.sourceId}`.toLowerCase().includes(String(q.q).toLowerCase()));
  return isPublic?{cases}:{cases:cases.slice((page-1)*pageSize,page*pageSize),total:cases.length,page,pageSize};
 }
 detail(ctx,id){this.api.adminConsole.admin(ctx);return {case:this.dto(this.row(id))};}
 presentation(ctx,id){
  const admin=this.api.adminConsole, actor=admin.admin(ctx);
  assert(ctx.headers?.['x-unseen-expected-account-id']===undefined||ctx.headers['x-unseen-expected-account-id']===actor.accountId,'account_changed',409);
  const result=this.core.mutation(ctx,{endpoint:`/v1/admin/community/cases/${id}/presentation`,scope:actor.accountId,reauthorize:()=>admin.admin(ctx)},()=>{
    const current=admin.admin(ctx),r=this.row(id),b=ctx.body;
    assert(b.expectedVersion===r.version,'version_conflict',409);
    assert(['visible','hidden'].includes(b.status)&&typeof b.featured==='boolean'&&Number.isSafeInteger(b.sortRank)&&Math.abs(b.sortRank)<=1000000,'case_presentation_invalid');
    assert(typeof b.reason==='string'&&b.reason.trim()&&b.reason.length<=500,'reason_required');
    if(r.status!==b.status||!!r.featured!==b.featured||r.sort_rank!==b.sortRank){
      this.core.db.prepare('UPDATE community_case_display SET status=?,featured=?,sort_rank=?,version=version+1,reason=?,updated_at=? WHERE id=?').run(b.status,Number(b.featured),b.sortRank,b.reason.trim(),this.core.now(),id);
      admin.audit(current,'community_case_presentation','community_case',id,r.status,b.status,b.reason.trim());
    }
    return {id};
  });
  admin.admin(ctx);return {case:this.dto(this.row(result.id)),...(result.replayed?{replayed:true}:{})};
 }
}
export function registerCommunityCaseRoutes(api,add){
 const s=api.communityCases=new CommunityCaseService(api);
 add('GET','/v1/public/community/cases',c=>s.list(c,true));
 add('GET','/v1/admin/community/cases',c=>s.list(c));
 add('GET','/v1/admin/community/cases/{id}',(c,p)=>s.detail(c,p.id));
 add('POST','/v1/admin/community/cases/{id}/presentation',(c,p)=>s.presentation(c,p.id));
}
