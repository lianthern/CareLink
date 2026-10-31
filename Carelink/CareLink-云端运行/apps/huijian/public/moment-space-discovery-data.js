// Independent public sources start together. A failed optional source must not
// hide usable spaces from the other source, and neither may hang indefinitely.
export async function loadDiscovery({page=1,signal,fetcher=fetch}){
  const read=async path=>{
    const response=await fetcher(path,{credentials:'omit',cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(12000)])});
    if(!response.ok)throw new Error('spaces_unavailable');
    return response.json();
  };
  const [community,catalog]=await Promise.allSettled([
    read(`/v1/public/spaces?page=${page}&pageSize=20`).then(data=>{if(!Array.isArray(data.submissions))throw new Error('spaces_invalid');return data;}),
    page===1?read('/api/app-catalog').then(data=>{if(!Array.isArray(data.cases))throw new Error('catalog_invalid');return data;}):Promise.resolve({cases:[]}),
  ]);
  signal.throwIfAborted();
  const data=community.status==='fulfilled'?community.value:{submissions:[],total:0};
  const cases=catalog.status==='fulfilled'?catalog.value.cases:[];
  const rows=data.submissions.map(item=>({id:item.id,title:item.title,cover:publicCover(item.coverPhotoUrl,item.id),intro:[item.authorName,item.description].filter(Boolean).join(' · '),community:true,kindLabel:'社区空间'}));
  rows.push(...cases.filter(x=>x.category==='space'&&x.cover).map(x=>({...x,kindLabel:'历史案例'})));
  const failed=community.status==='rejected'||catalog.status==='rejected';
  if(failed&&!rows.length)throw new Error('spaces_unavailable');
  return {rows,total:data.total||0,partial:failed};
}
function publicCover(value,id){
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(id||''))return '';
  const prefix=`/v1/public/spaces/${id}/media/`;
  return value.startsWith(prefix)&&/^(?:panorama|depth|photo-\d+|video-\d+)$/.test(value.slice(prefix.length))?value:'';
}
