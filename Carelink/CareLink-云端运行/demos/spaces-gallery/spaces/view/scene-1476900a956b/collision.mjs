// Swept circle against line capsules in viewer XZ scene units.
// Proxies are manually checked, independent of the camera coverage boundary.
const EPS = 1e-8;
const dot = (a,b) => a[0]*b[0]+a[1]*b[1];
const sub = (a,b) => [a[0]-b[0],a[1]-b[1]];
function closest(p,a,b) {
  const edge=sub(b,a), t=Math.max(0,Math.min(1,dot(sub(p,a),edge)/Math.max(EPS,dot(edge,edge))));
  return [a[0]+edge[0]*t,a[1]+edge[1]*t];
}
function active(proxy,y,bodyHeight) { return y >= proxy.minY && y-bodyHeight <= proxy.maxY; }
function segments(proxy) {
  if(proxy.kind==='wall') return [[proxy.a,proxy.b,proxy.thickness/2]];
  const [x,z]=proxy.min, [X,Z]=proxy.max;
  return [[[x,z],[X,z],0],[[X,z],[X,Z],0],[[X,Z],[x,Z],0],[[x,Z],[x,z],0]];
}
export function blocked(position,collision) {
  if(!collision?.enabled)return false;
  const p=[position[0],position[2]];
  return collision.proxies.some(s=>active(s,position[1],collision.bodyHeight)&&(
    (s.kind==='furniture'&&p[0]>=s.min[0]&&p[0]<=s.max[0]&&p[1]>=s.min[1]&&p[1]<=s.max[1])||
    segments(s).some(([a,b,r])=>Math.hypot(...sub(p,closest(p,a,b))) < collision.radius+r-1e-6)
  ));
}
export function validateCollision(c,revision) {
  if(c===undefined)return [];
  const errors=[],finite=Number.isFinite,vec=v=>Array.isArray(v)&&v.length===2&&v.every(finite);
  if(!c || c.version!==1||c.sceneRevisionId!==revision||c.units!=='scene'||typeof c.enabled!=='boolean')return ['碰撞设置与场景版本不匹配。'];
  if(!finite(c.radius)||c.radius<=0||!finite(c.bodyHeight)||c.bodyHeight<=0||!finite(c.floorY)||!finite(c.eyeOffset)||c.eyeOffset<=0)errors.push('碰撞半径或地板高度无效。');
  if(!Array.isArray(c.proxies)||c.proxies.length>100)return [...errors,'碰撞体数量无效。'];
  for(const p of c.proxies){
    if(!p||!['wall','furniture'].includes(p.kind)||!finite(p.minY)||!finite(p.maxY)||p.minY>=p.maxY||typeof p.label!=='string')errors.push('碰撞体高度或名称无效。');
    else if(p.kind==='wall'&&(!vec(p.a)||!vec(p.b)||Math.hypot(...sub(p.a,p.b))<EPS||!finite(p.thickness)||p.thickness<0))errors.push('墙体端点无效。');
    else if(p.kind==='furniture'&&(!vec(p.min)||!vec(p.max)||p.min[0]>=p.max[0]||p.min[1]>=p.max[1]))errors.push('家具范围无效。');
  }
  return errors;
}
function sweep(p,d,a,b,r) {
  const edge=sub(b,a),len=Math.hypot(...edge),u=edge.map(v=>v/Math.max(EPS,len)),n=[-u[1],u[0]],hits=[];
  const q=closest(p,a,b),gap=sub(p,q),dist=Math.hypot(...gap);
  if(dist<r+EPS && dist>EPS && dot(d,gap)<-EPS)hits.push({t:0,n:gap.map(v=>v/dist)});
  const pn=dot(sub(p,a),n),dn=dot(d,n);
  if(len>EPS&&Math.abs(dn)>EPS)for(const sign of [-1,1]){
    const normal=n.map(v=>sign*v),t=(sign*r-pn)/dn;
    const along=dot([p[0]+d[0]*t-a[0],p[1]+d[1]*t-a[1]],u);
    if(t>=-EPS&&t<=1&&along>=0&&along<=len&&dot(d,normal)<-EPS)hits.push({t:Math.max(0,t),n:normal});
  }
  const A=dot(d,d);
  if(A>EPS)for(const endpoint of [a,b]){
    const rel=sub(p,endpoint),B=2*dot(rel,d),C=dot(rel,rel)-r*r,dis=B*B-4*A*C;
    if(dis<0)continue;
    const t=(-B-Math.sqrt(Math.max(0,dis)))/(2*A);
    if(t>=-EPS&&t<=1){const delta=[rel[0]+d[0]*t,rel[1]+d[1]*t],l=Math.hypot(...delta);if(l>EPS&&dot(delta,d)<-EPS)hits.push({t:Math.max(0,t),n:delta.map(v=>v/l)});}
  }
  return hits.sort((a,b)=>a.t-b.t)[0];
}
export function moveWithCollision(position,displacement,collision,boundary=[]) {
  const p=[position[0],position[2]],edges=[];
  if(blocked(position,collision))return [...position]; // Invalid later anchor never escapes through a solid.
  if(collision?.enabled)for(const s of collision.proxies)if(active(s,position[1],collision.bodyHeight))for(const [a,b,r] of segments(s))edges.push([a,b,r+collision.radius]);
  // Coverage boundary is a separate limit, not a wall proxy.
  for(let i=0;i<boundary.length;i++)edges.push([boundary[i],boundary[(i+1)%boundary.length],1e-7]);
  let d=[displacement[0],displacement[1]];
  for(let iteration=0;iteration<6&&Math.hypot(...d)>EPS;iteration++){
    const hits=edges.map(([a,b,r])=>sweep(p,d,a,b,r)).filter(Boolean).sort((a,b)=>a.t-b.t);
    if(!hits.length){p[0]+=d[0];p[1]+=d[1];break;}
    const hit=hits[0],t=Math.max(0,hit.t-1e-6/Math.max(1,Math.hypot(...d)));
    p[0]+=d[0]*t;p[1]+=d[1]*t;d=d.map(v=>v*(1-t));
    // All simultaneous contacts remove their inward components, including corners.
    for(const h of hits.filter(h=>h.t<=hit.t+1e-6)){const inward=Math.min(0,dot(d,h.n));d=d.map((v,i)=>v-inward*h.n[i]);}
  }
  return [p[0],position[1],p[1]];
}
