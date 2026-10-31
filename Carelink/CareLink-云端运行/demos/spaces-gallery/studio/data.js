export const uid = () => crypto.randomUUID();
export const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const img = name => './assets/' + name;
export const photos = [
 ['dinner','photo3_group_back.jpg','那晚，谁也没说再见','灯一盏一盏亮起来，盘子渐渐空了，话却总也说不完。我们好像都在等一个人说，该回去了。可是那天，没有人先开口。'],
 ['cheers','photo1_cheers.jpg','这一杯，敬在场的人','杯子碰在一起的时候，阳光正好落在桌上。我们约好，以后也要这样常常见面。'],
 ['cake','photo2_cake.jpg','许了一个很小的愿望','不记得那天许的愿望了。只记得闭上眼睛的时候，身边都是熟悉的声音。'],
 ['table','photo4_table_detail.jpg','餐桌上的小事','桌上有花，有被风吹歪的纸巾，也有没来得及说完的话。'],
 ['laugh','photo5_laughing.jpg','笑到照片也模糊了','已经忘了是谁讲了那个笑话。可是看见这张照片，还是会笑。'],
 ['dance','photo6_dancing.jpg','再放一首歌吧','灯光渐暗，音乐还在。我们暂时不必成为明天的自己。'],
 ['hall','ballroom_p1.jpg','光留在了这里','那道光落在钢琴旁边。重访一个地方，有时候只需要重新看见一个角落。'],
 ['window','ballroom_p2.jpg','熟悉的另一面','沿着窗边慢慢走，看看不同角度的光。'],
 ['room','ballroom_p3.jpg','回到大厅','照片留下了一个房间，也留下了看它的角度。'],
 ['chapel','chapel_day_p2.jpg','长廊尽头的光','在长廊中停一停，看看光从哪里来。'],
 ['chapel2','chapel_day_p1.jpg','走过长廊','记忆里安静的一页。'],
 ['chapel3','chapel_day_p3.jpg','另一侧的光','再看看这个地方。']
].map(([id,file,title,story]) => ({id:'ex-'+id,url:img(file),title,story,example:true,contributor:'UNSEEN 示例',createdAt:'2026-08-16',source:file.startsWith('photo')?'既有 AI 生成示例照片；故事为界面示例，并非真实人物经历':file.startsWith('ballroom')?'Sergej Majboroda / Poly Haven · CC0，全景裁片；文字为示例':'UNSEEN 既有教堂示例照片；文字为示例'}));
export const examples = [
 {id:'example-summer',name:'那个不想散场的夏天',description:'从日落前的碰杯，到灯亮后的最后一首歌。',photoIds:photos.slice(0,6).map(p=>p.id),example:true,author:'UNSEEN 编辑室',authorId:'editorial',date:'2026-08-16',place:'夏日庭院',theme:'film',cover:'ex-dinner'},
 {id:'example-light',name:'光落下来的地方',description:'走进同一个房间，看见不同的记忆。',photoIds:photos.slice(6,9).map(p=>p.id),example:true,author:'UNSEEN 空间集',authorId:'spaces',date:'2026-08-18',place:'宴会厅',theme:'sea',cover:'ex-hall'},
 {id:'example-chapel',name:'在长廊的尽头',description:'沿着照片，再走一次。',photoIds:photos.slice(9).map(p=>p.id),example:true,author:'UNSEEN 空间集',authorId:'spaces',date:'2026-08-20',place:'光影长廊',theme:'wedding',cover:'ex-chapel'}
];
export const themes=[['sea','海边','潮汐蓝'],['wedding','婚礼','绢白'],['travel','旅行','远山绿'],['night','夜色','星夜'],['film','胶片','银盐'],['journal','手账','纸页']];
export const blankState=()=>({version:1,revision:0,profile:null,preferences:{reduceMotion:false,largeText:false,examples:true},photos:[],memories:[],spaces:[],favorites:[],submissions:[],shares:[]});
export const icons={
 discover:'<circle cx="12" cy="12" r="9"/><path d="m16 8-2 6-6 2 2-6Z"/>',library:'<rect x="4" y="6" width="16" height="15" rx="3"/><path d="M8 3h8M8 11h8M8 15h5"/>',plus:'<path d="M12 5v14M5 12h14"/>',spaces:'<path d="m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5"/>',user:'<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>',back:'<path d="m14 5-7 7 7 7"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>',heart:'<path d="M20.8 4.6c-2.2-2.1-5.5-1.4-8.8 1.8C8.7 3.2 5.4 2.5 3.2 4.6c-3.1 3 .8 8.6 8.8 14.8 8-6.2 11.9-11.8 8.8-14.8Z"/>',photo:'<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1"/><path d="m3 16 5-5 5 5 3-3 5 5"/>',mic:'<rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 11a7 7 0 0 0 14 0m-7 7v4m-4 0h8"/>',check:'<path d="m5 12 4 4L19 6"/>',lock:'<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v2"/>',share:'<path d="M12 16V2m-5 5 5-5 5 5M5 12H3v9h18v-9h-2"/>',more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',edit:'<path d="m15 3 6 6-12 12H3v-6L15 3Zm-3 3 6 6"/>',play:'<path d="m8 4 12 8-12 8V4Z"/>',download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',sun:'<circle cx="12" cy="12" r="4"/><path d="M12 1v2m0 18v2M1 12h2m18 0h2M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2"/>',volume:'<path d="m11 4-6 5H2v6h3l6 5V4Zm4 4a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',copy:'<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',mail:'<rect x="3" y="5" width="18" height="15" rx="2"/><path d="m3 6 9 7 9-7"/>',up:'<path d="m6 14 6-6 6 6"/>',down:'<path d="m6 10 6 6 6-6"/>',refresh:'<path d="M20 7v6h-6M4 17v-6h6M5 7a8 8 0 0 1 14 0M5 17a8 8 0 0 0 14 0"/>',book:'<path d="M12 5C8 2 4 3 2 4v16c3-2 7-1 10 1 3-2 7-3 10-1V4c-2-1-6-2-10 1Zm0 0v16"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',send:'<path d="m3 3 18 9-18 9 4-9-4-9Zm4 9h14"/>',stop:'<rect x="5" y="5" width="14" height="14" rx="2"/>'};
export const icon=(name,cls='')=>`<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]||icons.photo}</svg>`;
