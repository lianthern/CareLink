export const seedPhotos=[
{id:'cheers',url:'./assets/photo1_cheers.jpg',title:'日落前，碰个杯',story:'杯子碰在一起的时候，阳光刚好落在桌上。想把这个慢下来的傍晚留下。',spaceId:'summer'},
{id:'cake',url:'./assets/photo2_cake.jpg',title:'把愿望留给夏天',story:'蛋糕端上来的那一刻，大家都安静下来，等着一个愿望。',spaceId:'summer'},
{id:'back',url:'./assets/photo3_group_back.jpg',title:'同一个方向',story:'不必每张照片都看镜头。一起看向远处，也是很好的合影。',spaceId:'summer'},
{id:'table',url:'./assets/photo4_table_detail.jpg',title:'餐桌上的小事',story:'记住一个晚上，有时只需要桌上的一束花、一只杯子。',spaceId:'summer'},
{id:'laugh',url:'./assets/photo5_laughing.jpg',title:'这一刻的笑声',story:'后来记得最清楚的，是笑得停不下来的那几秒。',spaceId:'summer'},
{id:'dance',url:'./assets/photo6_dancing.jpg',title:'音乐还没有停',story:'天色慢慢暗下来，音乐还没有停。',spaceId:'summer'},
...['白色钢琴','大厅的一角','窗边的光'].map((title,i)=>({id:'ballroom-'+i,url:`./assets/ballroom_p${i+1}.jpg`,title,story:'一处熟悉的细节，也可以成为回忆的入口。此处为界面示例文字。',spaceId:'ballroom',source:'UNSEEN 既有宴会厅照片 · 原全景 Sergej Majboroda / Poly Haven CC0'})),
...['彩色玻璃下','走过长廊','另一侧的光'].map((title,i)=>({id:'chapel-'+i,url:`./assets/chapel_day_p${i+1}.jpg`,title,story:'沿着不同的视角，再看一遍这个地方。此处为界面示例文字。',spaceId:'chapel',source:'UNSEEN 既有教堂示例照片'}))
].map(p=>({...p,example:true,createdAt:'2026-08-16T10:00:00Z'}));
export const seedSpaces=[{id:'summer',name:'那个夏天，我们在一起',cover:'./assets/photo1_cheers.jpg',description:'从碰杯到日落，沿着照片再走一次。',photoIds:seedPhotos.filter(p=>p.spaceId==='summer').map(p=>p.id),example:true,type:'照片走廊',notice:'AI 生成照片与示例故事，用于体验。'}, {id:'ballroom',name:'光落下来的地方',cover:'./assets/ballroom_p1.jpg',description:'走进宴会厅，看光线穿过熟悉的角落。',photoIds:seedPhotos.filter(p=>p.spaceId==='ballroom').map(p=>p.id),example:true,type:'照片走廊',notice:'UNSEEN 既有宴会厅照片与示例文字；原全景 Sergej Majboroda / Poly Haven CC0。'}, {id:'chapel',name:'在这里，说愿意',cover:'./assets/chapel_day_p2.jpg',description:'沿着长廊，再看看那一束光。',photoIds:seedPhotos.filter(p=>p.spaceId==='chapel').map(p=>p.id),example:true,type:'照片走廊',notice:'UNSEEN 既有教堂示例照片与示例文字；不代表真实婚礼事件。'}];
export const escapeHtml=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function validateDraft(d){if(!d.title?.trim())return '给这段回忆起一个名字。';if(!d.photoIds?.length)return '先选择至少一张照片。';return '';}
export function filterPhotos(photos,query='',filter='all',favorites=[]){const q=query.trim().toLowerCase();return photos.filter(p=>(!q||`${p.title} ${p.story}`.toLowerCase().includes(q))&&(filter!=='favorites'||favorites.includes(p.id))&&(filter!=='stories'||p.story||p.audioUrl)&&(filter!=='mine'||p.local));}
export function makeSpace(d,id,now){return {id,name:d.title.trim(),description:d.description?.trim()||'',cover:d.cover,photoIds:[...new Set(d.photoIds)],example:false,type:'照片走廊',createdAt:now,visibility:'private'};}
