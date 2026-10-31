
(()=>{
const IMG={"bg_home": "/r15/carelink/product/images/bg_home.jpg", "bg_kitchen": "/r15/carelink/product/images/bg_kitchen.jpg", "box_amlo": "/r15/carelink/product/images/box_amlo.jpg", "box_ator": "/r15/carelink/product/images/box_ator.jpg", "box_bag": "/r15/carelink/product/images/box_bag.jpg", "box_metf": "/r15/carelink/product/images/box_metf.jpg", "box_pen": "/r15/carelink/product/images/box_pen.jpg", "box_vitd": "/r15/carelink/product/images/box_vitd.jpg", "dad": "/r15/carelink/product/images/dad.jpg", "grandma": "/r15/carelink/product/images/grandma.jpg", "grandpa": "/r15/carelink/product/images/grandpa.jpg", "gunainai": "/r15/carelink/product/images/gunainai.jpg", "mom": "/r15/carelink/product/images/mom.jpg", "p_baby": "/r15/carelink/product/images/p_baby.jpg", "p_factory": "/r15/carelink/product/images/p_factory.jpg", "p_family": "/r15/carelink/product/images/p_family.jpg", "p_garden": "/r15/carelink/product/images/p_garden.jpg", "p_grad": "/r15/carelink/product/images/p_grad.jpg", "p_lake": "/r15/carelink/product/images/p_lake.jpg", "xiaomin": "/r15/carelink/product/images/xiaomin.jpg", "xiaoyu": "/r15/carelink/product/images/xiaoyu.jpg", "xx_cheer": "/r15/carelink/product/images/xx_cheer.png", "xx_good": "/r15/carelink/product/images/xx_good.png", "xx_hello": "/r15/carelink/product/images/xx_hello.png", "xx_hug": "/r15/carelink/product/images/xx_hug.png", "xx_listen": "/r15/carelink/product/images/xx_listen.png", "xx_main": "/r15/carelink/product/images/xx_main.png", "xx_miss": "/r15/carelink/product/images/xx_miss.png", "xx_move": "/r15/carelink/product/images/xx_move.png", "xx_night": "/r15/carelink/product/images/xx_night.png", "xx_remind": "/r15/carelink/product/images/xx_remind.png", "xx_slow": "/r15/carelink/product/images/xx_slow.png", "xx_thanks": "/r15/carelink/product/images/xx_thanks.png", "xx_with": "/r15/carelink/product/images/xx_with.png"};
/* image classes, injected once */
(()=>{const st=document.createElement('style');st.textContent=Object.entries(IMG).map(([k,v])=>`.i-${k}{background-image:url(${v})}`).join('\n');document.head.appendChild(st);})();

/* ================= helpers ================= */
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const sleep=ms=>window.__CARELINK_HEADLESS__?Promise.resolve():new Promise(r=>setTimeout(r,ms));
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const pad=n=>String(n).padStart(2,'0');
const fmt=m=>pad(Math.floor(m/60)%24)+':'+pad(m%60);
const uid=()=>Math.random().toString(36).slice(2,9);

/* ================= data ================= */
const PHOTOS={
  lake:{title:'西湖·1978',img:'p_lake'}, family:{title:'全家福·1992',img:'p_family'}, factory:{title:'纺织厂·1965',img:'p_factory'},
  grad:{title:'小宇毕业',img:'p_grad'}, garden:{title:'阳台的花',img:'p_garden'}, baby:{title:'曾孙满月',img:'p_baby'}
};
const photoHTML=p=>p.src?`<div class="ph" style="background-image:url(${p.src})"></div>`:`<div class="ph i-${PHOTOS[p.key].img}"></div>`;
const FOODS=['小米粥','白粥','稀饭','粥','鸡蛋','面条','馄饨','饺子','包子','馒头','豆浆','牛奶','米饭','青菜','白菜','豆腐','鱼','红烧肉','肉','咸菜','苹果','香蕉','橘子','玉米','红薯','汤','排骨','西红柿','冬瓜','油条','蛋糕','点心'];
const FICON={小米粥:'🥣',白粥:'🥣',稀饭:'🥣',粥:'🥣',鸡蛋:'🥚',面条:'🍜',馄饨:'🥟',饺子:'🥟',包子:'🥟',馒头:'🍞',豆浆:'🥛',牛奶:'🥛',米饭:'🍚',青菜:'🥬',白菜:'🥬',豆腐:'🧊',鱼:'🐟',红烧肉:'🍖',肉:'🥩',咸菜:'🥒',苹果:'🍎',香蕉:'🍌',橘子:'🍊',玉米:'🌽',红薯:'🍠',汤:'🍲',排骨:'🍖',西红柿:'🍅',冬瓜:'🍈',油条:'🥖',蛋糕:'🍰',点心:'🍪'};
const SALTY=['咸菜','红烧肉','排骨','油条','馄饨'], OILY=['红烧肉','油条','排骨','肉','点心'], SUGARY=['小米粥','白粥','稀饭','粥','蛋糕','点心','馒头','米饭','红薯','面条'];
const SYMPTOMS=['头晕','头疼','腿疼','腰疼','膝盖疼','睡不好','没睡好','咳嗽','没胃口','乏力','没力气','手麻','眼花','便秘','心慌','耳鸣'];
const EMERGENCY=['胸口疼','胸口闷','摔了','摔倒','摔了一跤','喘不上气','喘不过气','晕倒','说不出话','半边麻','出血'];
const PLACES=['西湖','杭州','上海','北京','苏州','老家','纺织厂','厂里','学校','部队','公园','海边','火车站','医院','乡下','村里','照相馆'];
const PEOPLE=['你姑奶奶','你爷爷','爷爷','你爸','你妈','你姑姑','你大伯','小宇','我爸','我妈','老伴','我姐','我哥','师傅','曾孙','孙子'];
const MED_OK=/吃过了|吃了药|药吃了|已经吃了|吃过药|刚吃了|吃好了|吃完了/;
const MED_NO=/还没吃|没吃药|忘了吃|不想吃药/;
const MEM_RE=/\d{2,4}年|[一二三四五六七八九零〇十]{2,4}年|那时候|以前|当年|年轻|小时候|结婚|那会儿|那年|老早/;
const MED_LIB=[
  {key:'amlo',name:'苯磺酸氨氯地平片',spec:'5mg × 28 片',use:'降压药',box:'box_amlo',count:28,freq:1,per:1,unit:'片',timing:'早饭后',times:[8*60],look:'白色小圆片',conf:{name:.98,spec:.95,freq:.93,timing:.71},ocr:[[14,24,58,16,'药名'],[16,38,30,9,'规格'],[24,52,24,9,'用法']]},
  {key:'metf',name:'盐酸二甲双胍片',spec:'0.5g × 48 片',use:'降糖药',box:'box_metf',count:48,freq:2,per:1,unit:'片',timing:'随餐',times:[8*60,18*60],look:'白色椭圆片',conf:{name:.97,spec:.96,freq:.94,timing:.9},ocr:[[18,14,58,18,'药名'],[22,40,28,10,'规格'],[26,60,34,8,'用法']]},
  {key:'ator',name:'阿托伐他汀钙片',spec:'20mg × 7 片',use:'降脂药',box:'box_ator',count:7,freq:1,per:1,unit:'片',timing:'睡前',times:[20*60],look:'白色椭圆片',conf:{name:.96,spec:.9,freq:.92,timing:.88},ocr:[[16,40,40,13,'药名'],[16,54,20,8,'规格'],[16,64,40,9,'用法']]},
  {key:'vitd',name:'维生素 D 软胶囊',spec:'400 单位 × 60 粒',use:'补充剂',box:'box_vitd',count:60,freq:1,per:1,unit:'粒',timing:'早饭后',times:[8*60],look:'黄色透明小软胶囊',conf:{name:.95,spec:.93,freq:.9,timing:.62},ocr:[[34,26,34,12,'药名'],[36,40,28,9,'规格'],[52,52,18,7,'用法']]}
];
const REPORT={title:'2026 年度体检报告 · 王秀兰 · 72 岁',inds:[
  {k:'血压',v:'148/92 mmHg',ref:'< 140/90',up:true,ex:'血管像家里的水管，现在水压比正常高一点。降压药是减压阀，按时吃、少吃咸，水压就稳。连续一周早晚各量一次，复诊带给医生。'},
  {k:'空腹血糖',v:'6.8 mmol/L',ref:'3.9–6.1',up:true,ex:'血糖像锅里的水温，早上空肚子时偏热了一点。主食换点杂粮，等于把大火调成小火。'},
  {k:'低密度脂蛋白',v:'3.9 mmol/L',ref:'< 3.4',up:true,ex:'这是管道里的油垢，现在有点多。少吃油炸和肥肉，降脂药就是刷管道的刷子；3 个月后复查。'},
  {k:'血红蛋白',v:'128 g/L',ref:'115–150',up:false,ex:'运氧气的小货车，数量正常。'},
  {k:'肌酐',v:'72 μmol/L',ref:'41–81',up:false,ex:'肾这台过滤器，运转正常。'},
  {k:'骨密度 T 值',v:'-2.1',ref:'> -1.0',up:true,ex:'骨头像房子的承重墙，有点松了。要防摔：起身慢、浴室铺防滑垫；补不补钙请问医生。'}
]};
const RULES=[
  {id:'R1',n:'两键',d:'继承：长辈端只保留两个按键，不做文字输入和确认弹窗'},
  {id:'R2',n:'只亮红点',d:'继承：新内容只亮红点，不自动换图'},
  {id:'R3',n:'必附语音',d:'继承：子女发送必须附语音'},
  {id:'R4',n:'离线排队',d:'继承：离线时双端排队补发'},
  {id:'H1',n:'到点提醒',d:'用药提醒亮灯 + 弹窗 + 小信主动说一句，手机设置里可关；不重复催促'},
  {id:'H2',n:'原声优先',d:'提醒优先播放子女录音，其余由数字人以家人语气播报，不用系统告警音'},
  {id:'H3',n:'建议不告警',d:'长辈端不出现告警；具体可行的建议用子女或温和的语音说给长辈（如「今天咸菜少吃点」），完整分析和报告推给子女'},
  {id:'H4',n:'说即确认',d:'长辈说「吃过了」即视为确认，不再追问、不弹二次确认'},
  {id:'H5',n:'超时告知',d:'提醒后一段时间无回应，通知子女，由子女决定是否打电话（不对长辈重复催促）'},
  {id:'H6',n:'紧急插队',d:'口述命中紧急关键词，跳过排队，立即通知子女'},
  {id:'H7',n:'一说双分',d:'一条口述可同时生成记忆卡片和健康记录，由云端分流'},
  {id:'G1',n:'安全护栏',d:'建议生成先检索医学知识库，再过规则校验；涉及诊断、换药、调剂量的内容一律拦截，改为「请咨询医生」'}
];
const UTTER=[
  {k:'med',t:'吃过了，早上喝的小米粥，还吃了个鸡蛋。'},
  {k:'mem',t:'这张是七八年在西湖照的，那时候刚和你爷爷结婚，你姑奶奶非要借照相馆的衣服给我穿。'},
  {k:'mix',t:'这是我年轻时候在纺织厂，那年我才十九。对了，今天中午吃了面条，腿有点疼。'},
  {k:'symp',t:'吃过了。昨晚没睡好，早上有点头晕，喝了碗白粥。'},
  {k:'emg',t:'小宇啊，我刚才在卫生间摔了一跤，胸口疼。'},
  {k:'no',t:'还没吃呢，等会儿吃。'},
  {k:'blur',t:'那个……药……嗯……吃那个……'},
  {k:'salt',t:'中午吃了稀饭配咸菜，还有两块红烧肉。'},
  {k:'ask',t:'小宇，这降压药我吃了有点头晕，能不能少吃半片？'},
  {k:'want',t:'小敏说晚上带我去吃火锅，好久没吃了。'},
  {k:'want2',t:'快中秋了，我想吃块月饼。'},
  {k:'chat',t:'小宇你啥时候回来呀，阳台的花开了。'}
];
/* family & relations (x,y in % of graph box) */
const FAM={
  grandma:{nm:'奶奶',full:'王秀兰',img:'grandma',x:48,y:16},
  grandpa:{nm:'爷爷',full:'李国栋',img:'grandpa',x:81,y:16,rel:['grandma','夫妻']},
  gunainai:{nm:'姑奶奶',full:'王秀英',img:'gunainai',x:15,y:16,rel:['grandma','姐妹'],hidden:true},
  dad:{nm:'爸爸',full:'李建平',img:'dad',x:48,y:55,rel:['grandma','儿子']},
  mom:{nm:'妈妈',full:'陈慧',img:'mom',x:15,y:55,rel:['dad','夫妻']},
  xiaomin:{nm:'小敏',full:'李敏',img:'xiaomin',x:81,y:55,rel:['grandma','女儿']},
  xiaoyu:{nm:'小宇',full:'李宇',img:'xiaoyu',x:48,y:88,rel:['dad','孙子']}
};
const NEW_MAP={'姑奶奶':'gunainai','我姐':'gunainai'};
const HIST={m1:[1,1,1,1,1,1],m2:[1,1,0,1,1,1]}, HDAYS=['周五','周六','周日','周一','周二','周三'];
HIST.m1[4]=0; // 周二漏了早上

/* ================= state ================= */
let S;
function freshState(){
  const p0={id:uid(),key:'garden',title:'阳台的花',from:'小宇',voice:'奶奶，这是您阳台的花，我上次回来拍的。',heard:true};
  return {
    clock:7*60+55, running:true, speed:1, sound:true, online:true,
    photos:[p0], cur:0, pend:[], downQ:[], upQ:[],
    meds:[
      {id:'m1',grp:'amlo',name:'苯磺酸氨氯地平片',dose:'5mg × 1 片',use:'降压药',time:8*60,box:'box_amlo',per:1,unit:'片',timing:'早饭后',look:'白色小圆片',voice:'奶奶，该吃降压药了，就是白色那个小药片。'},
      {id:'m2',grp:'ator',name:'阿托伐他汀钙片',dose:'20mg × 1 片',use:'降脂药',time:20*60,box:'box_ator',per:1,unit:'片',timing:'睡前',look:'白色椭圆片',voice:'奶奶，晚上的降脂药记得吃，吃完早点睡。'}
    ],
    stock:{amlo:{count:6,perDay:1,spec:'5mg × 28 片'},ator:{count:20,perDay:1,spec:'20mg × 7 片'}},
    today:{}, lastHeard:null, mode:'idle', recStart:0, lastSaid:'小宇你啥时候回来呀，阳台的花开了。', lastSaidAt:null,
    cards:[], diet:[], symp:[], reports:[], health:0,
    feed:[], badges:{home:0,mem:0,health:0},
    scr:'home', ptab:'intro', ctab:'week7', meal:'all', modal:null,
    who:'grandma', me:ME0(),
    rules:{}, tools:{}, revealed:{}, newNodes:[], extraPeople:[],
    visible:{xiaoyu:true,xiaomin:false,dad:false}, care:{xiaoyu:128,xiaomin:64,dad:52},
    mergeRemind:true, remindPopup:true, remindVoice:true, timeoutMin:30,
    tips:{rep:{why:'体检：血压、血糖、血脂偏高',line:'奶奶，体检结果大体都好。菜里少放点盐，白粥换成杂粮粥。',plain:'盐和白粥会让水管的水压、锅里的水温往上走，换一换就稳了。'},
          praise:{why:'七天打卡',line:'奶奶，这周的药您吃得可准时了，我都看到了，真棒！'}}, tipsSent:0,
    utter:UTTER[0].t, scen:null, gstep:0
  };
}

/* ================= audio ================= */
let actx;
function chime(){
  if(!S.sound) return;
  try{actx=actx||new (window.AudioContext||window.webkitAudioContext)();
    [[660,0],[880,.18]].forEach(([f,t])=>{const o=actx.createOscillator(),g=actx.createGain();o.type='sine';o.frequency.value=f;
      g.gain.setValueAtTime(0,actx.currentTime+t);g.gain.linearRampToValueAtTime(.18,actx.currentTime+t+.02);g.gain.exponentialRampToValueAtTime(.001,actx.currentTime+t+.5);
      o.connect(g).connect(actx.destination);o.start(actx.currentTime+t);o.stop(actx.currentTime+t+.55);});
  }catch(e){}
}
function say(text){if(!S.sound||!window.speechSynthesis)return;try{speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(text);u.lang='zh-CN';u.rate=1.02;u.pitch=1.15;speechSynthesis.speak(u);}catch(e){}}
function hush(){try{window.speechSynthesis&&speechSynthesis.cancel()}catch(e){}}

/* ================= rules & log ================= */
function hit(...ids){
  ids.forEach(id=>{S.rules[id]=(S.rules[id]||0)+1;});
  renderRules();
  ids.forEach(id=>{const el=$(`.rule[data-id="${id}"]`);if(el){el.classList.remove('flash');void el.offsetWidth;el.classList.add('flash');}});
}
const TOOLS=[['report','报告解析'],['med','用药管理'],['oral','口述理解'],['record','健康档案'],['risk','风险评估'],['notify','提醒与通知']];
function tool(...ks){ks.forEach(k=>S.tools[k]=(S.tools[k]||0)+1);renderTools();ks.forEach(k=>{const el=$(`.tool[data-k="${k}"]`);if(el){el.classList.remove('flash');void el.offsetWidth;el.classList.add('flash');}});}
const TOOLD={report:['📄','体检报告 → 指标与通俗解读'],med:['💊','药盒照片 → 用药计划'],oral:['🎙','口述 → 服药 / 饮食 / 症状'],record:['🗂','长期档案：趋势与服药率'],risk:['🎟','知识库 + 护栏 → 生活作弊码'],notify:['🔔','相框提醒 / 子女推送']};
function renderTools(){$('#tools').innerHTML=TOOLS.map(([k,n])=>`<div class="tool ${S.tools[k]?'hit':''}" data-k="${k}"><span class="ti">${TOOLD[k][0]}</span><span class="tn"><b>${n}</b><small>${TOOLD[k][1]}</small></span>${S.tools[k]?`<span class="n">${S.tools[k]}</span>`:''}</div>`).join('');}
function renderRules(){$('#rules').innerHTML=RULES.map(r=>`<div class="rule ${S.rules[r.id]?'hit':''}" data-id="${r.id}" title="${esc(r.d)}">${r.id}<em>${r.n}</em>${S.rules[r.id]?`<span class="n">${S.rules[r.id]}</span>`:''}</div>`).join('');}
function log(cls,tag,body,opts={}){
  const el=document.createElement('div');el.className='ev '+cls;
  el.innerHTML=`<div class="h"><span>${fmt(S.clock)}</span><span class="tag">${tag}</span>${(opts.rules||[]).map(r=>`<span class="r">${r}</span>`).join('')}</div><div class="b">${body}</div>${opts.kv?`<div class="kv">${opts.kv}</div>`:''}`;
  $('#log').prepend(el);
  if(opts.rules) hit(...opts.rules);
  return el;
}
async function runSteps(el,steps,ms=380){
  const box=document.createElement('div');box.className='steps';el.appendChild(box);
  for(const s of steps){const sp=document.createElement('span');sp.textContent=s;box.appendChild(sp);await sleep(ms);sp.classList.add('ok');}
}
function renderQueues(){$('#qDown').textContent=S.downQ.length;$('#qUp').textContent=S.upQ.length;$('#qMem').textContent=S.cards.length;$('#qHealth').textContent=S.health;}

/* ================= frame ================= */
let toastTimer;
function renderFrame(){
  const f=$('#frame');
  f.classList.toggle('lit',S.pend.some(p=>p.type!=='photo')&&S.online);
  f.classList.toggle('offline',!S.online);
  $('#fDot').classList.toggle('hide',!S.pend.some(p=>p.type==='photo')||!S.online);
  $('#fOff').classList.toggle('hide',S.online);
  const p=S.photos[S.cur];
  if($('#fPhoto').dataset.pid!==p.id){$('#fPhoto').innerHTML=photoHTML(p);$('#fPhoto').dataset.pid=p.id;}
  $('#kR').classList.toggle('recording',S.mode==='recording');
  $('#fRec').classList.toggle('show',S.mode==='recording');
  if(S.mode==='recording'){$('#fDhImg').className='dhImg i-xx_listen';$('#fDh').className='dhStage show listen';$('#fCap').classList.remove('show');}
  else if(S.mode!=='playing') $('#fDh').className='dhStage';
}
function frameToast(t,ms=2600){$('#fToastT').textContent=t;$('#fToast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#fToast').classList.remove('show'),ms);}
function press(btn){btn.classList.add('press');setTimeout(()=>btn.classList.remove('press'),140);}
let playToken=0;
function xxExp(t,med){t=t||'';
  if(/晚安|睡|早点休息/.test(t))return 'night';
  if(med||/药|吃了没|到点|该.{0,4}了/.test(t))return 'remind';
  if(/走走|散步|活动|动一动|锻炼/.test(t))return 'move';
  if(/火锅|换|条件|答应|少放/.test(t))return 'with';
  if(/真棒|做得|好样|不错|坚持|厉害|夸/.test(t))return 'good';
  if(/想你|照片|回来|视频/.test(t))return 'miss';
  if(/慢慢|别急|不着急/.test(t))return 'slow';
  if(/谢谢/.test(t))return 'thanks';
  return 'main';}
async function playClip(who,text,kind='child',med=null){
  const tok=++playToken;S.mode='playing';renderFrame();
  const bi=$('#fCapImg'),bs=$('#fCapSub');
  if(med&&(med.box||med.boxSrc)){bi.className='bimg pimg '+boxCls(med);bi.setAttribute('style',boxStyle(med));bs.textContent=`认准：${med.look||''} · 每次 ${med.per||1} ${med.unit||'片'} · ${med.timing||''}`;bs.classList.remove('hide');}
  else{bi.className='bimg hide';bs.classList.add('hide');}
  if(kind==='dh') $('#fDhImg').className='dhImg i-xx_'+xxExp(text,med);
  $('#fDh').className='dhStage'+(kind==='dh'?' show':'');
  $('#fCap').className='bubbleF show'+(kind==='dh'?'':' child');
  $('#fCapWho').innerHTML=(kind==='dh'?'<span class="cav xxa i-xx_hello"></span><span class="aitag">AI 数字人</span> ':'<span class="cav pimg i-xiaoyu"></span>')+esc(who);$('#fCapTxt').textContent='“'+text+'”';
  const dur=Math.max(2600,text.length*230);
  const bar=$('#fCapBar');bar.style.transition='none';bar.style.width='0';void bar.offsetWidth;bar.style.transition=`width ${dur}ms linear`;bar.style.width='100%';
  say(text);await sleep(dur);
  if(tok!==playToken) return false;
  $('#fCap').classList.remove('show');$('#fDh').className='dhStage';return true;
}
function stopPlay(){playToken++;hush();$('#fCap').classList.remove('show');$('#fDh').className='dhStage';if(S&&S.mode==='playing')S.mode='idle';}

async function onGreen(){
  press($('#kG'));
  if(S.mode==='recording') return;
  hit('R1');
  if(!S.online){frameToast('相框离线，联网后自动收取');return;}
  const rem=S.pend.filter(p=>p.type!=='photo').sort((a,b)=>a.time-b.time);
  if(rem.length){
    S.pend=S.pend.filter(p=>p.type==='photo');renderFrame();
    const meds=rem.filter(r=>r.type==='reminder'),tips=rem.filter(r=>r.type==='tip');
    if(meds.length) log('health','相框·绿键',`奶奶按绿键收听 ${meds.length} 条用药叮嘱${rem.length>1?'（合并亮灯，按时间顺序播放）':''}：${meds.map(r=>r.dh?'数字人小信播报':'小宇原声').join('、')}`,{rules:['H2']});
    if(tips.length) log('health','相框·绿键',`${tips[0].kind==='dh'?'数字人小信':'小宇原声'}说给奶奶「${esc(tips[0].voice)}」—— 一句能照做的话，没有告警`,{rules:['H3']});
    S.lastHeard=meds.length?{type:'reminder',ids:meds.map(r=>r.medId),at:S.clock}:{type:'tip',at:S.clock};
    gstep('green');
    for(const r of rem){const ok=await playClip(r.type==='tip'?r.who:(r.dh?`健康管家 小信 · 代小宇提醒${r.medName}`:`小宇的原声 · ${r.medName}`),r.voice,r.type==='tip'?r.kind:(r.dh?'dh':'child'),r.type==='reminder'?S.meds.find(x=>x.id===r.medId):null);if(!ok)return;}
    if(tips.length){pushFeed('💗','奶奶听到了你的话',`“${tips[0].voice}”`,'home',true);gstep('tipheard');renderApp();}
    S.mode='idle';renderFrame();return;
  }
  const ph=S.pend.find(p=>p.type==='photo');
  if(ph){
    S.pend=S.pend.filter(p=>p!==ph);
    const idx=S.photos.findIndex(p=>p.id===ph.photoId);S.cur=idx;S.photos[idx].heard=true;renderFrame();
    log('mem','相框·绿键',`奶奶按绿键，切到新照片「${esc(S.photos[idx].title)}」并播放小宇的语音`);
    S.lastHeard={type:'photo',photoId:ph.photoId,at:S.clock};
    pushFeed('👂','奶奶听了你的消息',`「${S.photos[idx].title}」· 已播放语音`,'home',false);
    gstep('green');renderApp();
    const ok=await playClip('小宇的原声',S.photos[idx].voice);
    if(ok){S.mode='idle';renderFrame();}
    return;
  }
  const p=S.photos[S.cur];
  const ok=await playClip(`${p.from||'小宇'}的原声 · 重播`,p.voice||'（这张照片没有语音）');
  if(ok){S.mode='idle';renderFrame();}
}
let recTick;
function onRed(){
  press($('#kR'));hit('R1');
  if(S.mode==='recording'){finishRec();return;}
  stopPlay();S.mode='recording';S.recStart=Date.now();renderFrame();
  $('#fRecT').textContent='00:00';clearInterval(recTick);
  recTick=setInterval(()=>{const s=Math.floor((Date.now()-S.recStart)/1000);$('#fRecT').textContent='00:'+pad(s);if(s>=30)finishRec();},250);
  gstep('red1');
}
function finishRec(){
  clearInterval(recTick);S.mode='idle';renderFrame();
  const text=($('#uText').value||'').trim()||'（没说话）';
  const unclear=$('#swUnclear').checked||/……/.test(text)&&text.replace(/[……\s，。嗯啊那个]/g,'').length<6;
  const item={id:uid(),text,unclear,ctx:S.lastHeard&&S.clock-S.lastHeard.at<=90?S.lastHeard:null,at:S.clock,dur:Math.max(2,Math.round((Date.now()-S.recStart)/1000))};
  frameToast(!item.ctx||item.ctx.type!=='photo'?'已告诉小宇':'已送到小宇的手机');
  gstep('red2');
  if(!S.online){S.upQ.push(item);renderQueues();log('warn','相框·离线',`相框离线，这段讲述（${item.dur}″）先存在相框本地，联网后补传`,{rules:['R4']});return;}
  processUtter(item);
}

/* ================= cloud ================= */
function analyze(text){
  const r={foods:[],symp:[],emg:null,med:null,mem:null};
  FOODS.forEach(f=>{if(text.includes(f)&&!r.foods.some(x=>x.includes(f)))r.foods.push(f);});
  const tn=text.replace(/有点|有些|一点|有一点|好像/g,'');
  SYMPTOMS.forEach(s=>{if(tn.includes(s))r.symp.push(s);});
  r.emg=EMERGENCY.find(k=>text.includes(k))||null;
  if(MED_OK.test(text))r.med='ok';else if(MED_NO.test(text))r.med='no';
  if(/想吃|想喝|要去吃|带我去吃|馋|去吃/.test(text)){r.want=WANTS.find(w=>text.includes(w))||null;if(r.want)r.foods=r.foods.filter(f=>!r.want.includes(f)&&!f.includes(r.want));}
  r.ask=/药|片/.test(text)&&/(少吃|减|停|换|加|多吃)(半片|一片|点|药|掉)|(能不能|可不可以|要不要).{0,8}(不吃|停|减|少吃|换)/.test(text);
  if(MEM_RE.test(text)){
    const when=(text.match(/(\d{2,4}年|[一二三四五六七八九零〇十]{2,4}年|年轻时候?|小时候|那年我[^，。]{0,4})/)||[])[0]||'';
    const where=PLACES.find(p=>text.includes(p))||'';
    const who=PEOPLE.filter(p=>text.includes(p)).filter((p,i,a)=>!a.some(o=>o!==p&&o.includes(p)));
    r.mem={when,where,who};
  }
  return window.CareLinkAnalysis?window.CareLinkAnalysis(r,text):r;
}
async function processUtter(item,fromQueue=false){
  const a=analyze(item.text);
  S.lastSaid=item.text;S.lastSaidAt=S.clock;S.saidN=(S.saidN||0)+1;tool('oral');
  if(a.emg&&!item.unclear){
    tool('risk','notify');
    log('emg','紧急关键词',`命中「${esc(a.emg)}」→ 跳过排队，立即通知子女；相框端不出现任何告警`,{rules:['H6','H3'],kv:`<span class="r">原话：${esc(item.text)}</span>`});
    S.symp.push({t:S.clock,s:a.emg,raw:item.text,emg:true});S.health++;
    pushFeed('🚨',`紧急：奶奶说「${a.emg}」`,`“${item.text}”`,'home',true,{emg:true,btns:[['red','📞 打给奶奶','call'],['','听原音频','audio:'+item.id],['','急救电话提示','120']]});
    S.modal={type:'emg',text:item.text,kw:a.emg,id:item.id};
    ribT(true,'🚨 奶奶说「'+a.emg+'」','刚刚 · 必要时拨打急救电话');
    gstep('emg');renderQueues();renderApp();return;
  }
  const el=log(item.unclear?'warn':'',fromQueue?'补传·口述':'相框·口述',`收到奶奶讲述 ${item.dur}″${item.ctx?(item.ctx.type==='reminder'?'（刚听完用药叮嘱）':item.ctx.type==='photo'?'（刚听完照片语音）':'（刚听完建议）'):''}`);
  await runSteps(el,['Agent · 口述理解：ASR','抽取服药 / 饮食 / 症状','分流记忆 / 健康']);
  if(item.unclear){
    el.insertAdjacentHTML('beforeend',`<div class="kv"><span class="a">识别置信度低，不让奶奶重说；原音频留给子女，记录标「待确认」</span></div>`);
    if(item.ctx&&item.ctx.type==='reminder') item.ctx.ids.forEach(id=>{S.today[id]={...S.today[id],status:'q',at:S.clock};});
    S.health++;tool('record','notify');
    pushFeed('❔','奶奶说了一段话，没听清','已保留原音频，健康记录标为「待确认」','health',true,{btns:[['','▶ 听原音频','audio:'+item.id],['pri','确认已服药','confirm:'+(item.ctx&&item.ctx.type==='reminder'?item.ctx.ids.join(','):'')]]});
    ribT(false,'❔ 奶奶说了一段话，没听清','点开听原音频，帮她确认');
    gstep('unclear');renderQueues();renderApp();return;
  }
  const outs=[];
  if(item.ctx&&item.ctx.type==='reminder'&&a.med){
    item.ctx.ids.forEach(id=>{S.today[id]={...S.today[id],status:a.med==='ok'?'ok':'no',at:S.clock};});
    if(a.med==='ok') item.ctx.ids.forEach(useStock);
    const names=item.ctx.ids.map(id=>S.meds.find(m=>m.id===id)?.use||'药').join('、');
    if(a.med==='ok'){
      outs.push(`<span class="g">服药 ✓ ${esc(names)}</span>`);
      pushFeed('💊','奶奶已服药',`${names} · 口头确认`,'home',true);
      ribT(false,'💊 奶奶已服药',`${fmt(S.clock)} · ${names} · 她说“${item.text.slice(0,10)}…”`);
      hit('H4');gstep('medok');
    }else{
      outs.push(`<span class="a">未服药：${esc(names)}</span>`);
      pushFeed('⏳','奶奶说还没吃药',`“${item.text}” · 不再催奶奶，要不要打个电话？`,'home',true,{btns:[['pri','📞 打给奶奶','call']]});
      hit('H3');
    }
    S.health++;
  }else if(a.med==='ok'&&(!item.ctx||item.ctx.type!=='reminder')){
    const open=Object.entries(S.today).filter(([k,v])=>v.status==='lit'||v.status==='miss').map(([k])=>k);
    if(open.length){open.forEach(id=>{S.today[id]={...S.today[id],status:'ok',at:S.clock};useStock(id);});outs.push(`<span class="g">服药 ✓（补确认）</span>`);pushFeed('💊','奶奶已服药','她主动说“吃过了”，补记今天的提醒','home',true);hit('H4');S.health++;gstep('medok');}
  }
  if(a.foods.length){S.diet.push({t:S.clock,foods:a.foods,raw:item.text});S.health++;outs.push(`<span class="g">饮食：${esc(a.foods.join('、'))}</span>`);S.badges.health++;gstep('diet');}
  if(a.symp.length){
    S.symp.push({t:S.clock,s:a.symp.join('、'),raw:item.text});S.health++;
    outs.push(`<span class="a">不适：${esc(a.symp.join('、'))}</span>`);
    pushFeed('🩺',`奶奶提到「${a.symp.join('、')}」`,adviceFor(a.symp),'health',true);hit('H3');
  }
  if(a.foods.length||a.symp.length||a.med) tool('record');
  if(a.ask){
    tool('risk','notify');
    const tid=uid();S.tips[tid]={why:'奶奶想调整用药，护栏已拦截',line:'奶奶，药量的事得问医生，先按原来的吃，我让小宇帮您约个门诊。'};
    el.insertAdjacentHTML('beforeend',`<div class="kv"><span>风险评估：检索知识库「降压药 · 用药调整」</span><span class="r">护栏拦截：涉及调剂量，不给具体用法</span><span class="g">给奶奶：“${esc(S.tips[tid].line)}”</span></div>`);
    log('warn','安全护栏','奶奶问到调整用药 → 规则校验命中「换药 / 调剂量」，拦截具体建议，改为「请咨询医生」',{rules:['G1','H3']});
    pushFeed('🛡','奶奶想调整用药，AI 已拦截',`她说“${item.text}”。AI 不给剂量建议；建议带上药盒复诊时问医生。`,'home',true,{tip:tid,btns:[['pri','让小信转达','tipv:'+tid],['','📞 打给奶奶','call'],['','🎙 我录一句','tip:'+tid]]});
    ribT(false,'🛡 奶奶想调整用药','AI 已拦截剂量建议 · 建议复诊问医生');
    gstep('guard');
  }
  if(a.want&&!a.ask){
    const cc=cheatFor(a.want);
    if(cc){const tid=uid();S.tips[tid]=cc;tool('risk');
      el.insertAdjacentHTML('beforeend','<div class="kv"><span>作弊码计算器：查奶奶的药 + 体检「'+esc(cc.kb)+'」</span><span class="g">规则校验 ✓ 饮食类交换条件，放行</span></div><div class="kv"><span class="g">给奶奶：“'+esc(cc.line)+'”</span><span>白话：'+esc(cc.plain)+'</span></div>');
      pushFeed('🎟','奶奶想吃'+cc.want+' · 小信给了作弊码','“'+cc.line+'” 白话：'+cc.plain,'home',true,{btns:[['','🎙 我也说一句','tip:'+tid]]});
      ribT(false,'🎟 奶奶想吃'+cc.want,'小信没说不行，给了一个照吃的办法');
      gstep('cheat');
      setTimeout(()=>deliverTip(cc.line+' '+cc.plain,'健康管家 小信 · 作弊码'),600);
    }
  }
  const tip=(a.ask||a.want)?null:tipFor(a.foods,a.symp);
  if(tip){
    tool('risk');
    el.insertAdjacentHTML('beforeend',`<div class="kv"><span>风险评估：检索知识库「${esc(tip.kb)}」</span><span class="g">规则校验 ✓ 饮食 / 作息类建议，放行</span></div>`);
    const tid=uid();S.tips[tid]=tip;
    el.insertAdjacentHTML('beforeend',`<div class="kv"><span class="a">建议依据：${esc(tip.why)}</span><span class="g">可说给奶奶：“${esc(tip.line)}”</span></div>`);
    pushFeed('💡','小信想到一个「照做就行」的办法',`${tip.why} · “${tip.line}” 白话：${tip.plain||''}`,'home',true,{tip:tid,btns:[['pri','让小信转达','tipv:'+tid],['','🎙 我录一句','tip:'+tid]]});
    hit('H3');gstep('tipgen');
  }
  let card=null;
  const photoCtx=item.ctx&&item.ctx.type==='photo';
  if(a.mem||(photoCtx&&item.text.length>12&&!a.med)){
    const m=a.mem||{when:'',where:'',who:[]};
    const photo=photoCtx?S.photos.find(p=>p.id===item.ctx.photoId):(m.where&&/厂/.test(m.where)?{key:'factory',title:'纺织厂·1965'}:null);
    card={id:uid(),t:S.clock,photo,title:cardTitle(m,item.text),raw:item.text,m};
    S.cards.unshift(card);S.badges.mem++;
    const added=[];
    m.who.forEach(w=>{const k=w.replace(/^你|^我/,'');const id=NEW_MAP[k];
      if(id&&!S.revealed[id]){S.revealed[id]=true;S.newNodes.push(id);added.push(FAM[id].nm);}
      else if(!id&&!Object.values(FAM).some(f=>f.nm===k)&&!S.extraPeople.includes(k)&&!['小宇','孙子'].includes(k)){S.extraPeople.push(k);added.push(k);}});
    outs.unshift(`<span>记忆卡：${esc(card.title)}</span>`+(m.when?`<span>时间 ${esc(m.when)}</span>`:'')+(m.where?`<span>地点 ${esc(m.where)}</span>`:'')+(m.who.length?`<span>人物 ${esc(m.who.join('、'))}</span>`:''));
    pushFeed('🎞','奶奶回复了你 · 新传记卡',`「${card.title}」${added.length?' · 族谱新增 '+added.join('、'):''}`,'mem',true);
    if(!(item.ctx&&item.ctx.type==='reminder')) ribT(false,'🎞 奶奶回复了你',`新传记卡「${card.title}」${added.length?' · 族谱 +'+added.length:''}`);
    gstep('card');
  }
  if(card&&(a.foods.length||a.symp.length||a.med)){hit('H7');outs.push(`<span class="r">一条口述 → 记忆 + 健康两路</span>`);gstep('h7');}
  if(!outs.length&&!tip&&!a.want&&!a.ask){
    outs.push('<span>闲聊 · 作为语音留言转给小宇</span>');
    pushFeed('💬','奶奶给你留了一段话',`“${item.text}”`,'home',true,{btns:[['','▶ 听原音频','audio:'+item.id]]});
    ribT(false,'💬 奶奶给你留言',item.text.slice(0,22));
  }
  el.insertAdjacentHTML('beforeend',`<div class="kv">${outs.join('')}</div>`);
  if(a.foods.length||a.symp.length||a.med) el.classList.add('health'); else if(card) el.classList.add('mem');
  renderQueues();renderApp();
}
function cardTitle(m,raw){
  if(m.when&&m.where) return `${m.when.replace(/年轻时候?/,'年轻时')}·${m.where}`;
  if(/结婚/.test(raw)) return '刚结婚那年';
  if(m.where) return `在${m.where}`;
  if(m.when) return m.when;
  return raw.slice(0,8)+'…';
}
function adviceFor(sy){
  const t=sy.join('');
  if(/头晕/.test(t)) return '这两天早晚帮她量血压；若反复头晕或伴随胸闷，带她就医。是否调药请咨询医生。';
  if(/睡不好|没睡好/.test(t)) return '下午少喝浓茶，晚饭后散步 15 分钟；持续一周以上建议门诊咨询。';
  if(/腿疼|膝盖|腰疼/.test(t)) return '减少爬楼和久站，注意防跌倒；疼痛加重请就医，不要自行加止痛药。';
  return '已记入健康档案，会汇总进本周周报。';
}
const WANTS=['火锅','红烧肉','烧烤','蛋糕','月饼','汤圆','粽子','奶茶','咸鸭蛋','腊肉','咸菜'];
const SWEET=['蛋糕','月饼','汤圆','粽子','奶茶'],SALT2=['咸鸭蛋','腊肉','咸菜'];
function cheatFor(w){
  const hasMetf=S.meds.some(m=>m.grp==='metf');
  if(w==='火锅') return {want:w,why:'奶奶在吃降压药，体检血压偏高',kb:'高血压膳食 · 限盐 × 氨氯地平',line:'火锅照吃！点清汤锅，蘸料放蒜和醋就够，手边放杯白开水，吃两口菜喝一口水。'+(hasMetf?'主食换成玉米。':''),plain:'您吃的降压药像水管上的减压阀，火锅汤里的盐会把水管撑起来；多喝白开水、少喝汤，阀门就稳得住。'};
  if(w==='红烧肉'||w==='烧烤') return {want:w,why:'奶奶在吃降脂药，体检血脂偏高',kb:'血脂异常 · 膳食脂肪 × 阿托伐他汀',line:w+'照吃！先吃一碗青菜垫底，再吃三块，肉汁别拌饭。',plain:'降脂药像疏通管道的刷子，油一多刷子就忙不过来；先吃青菜，等于先给管道铺一层滤网。'};
  if(SWEET.includes(w)) return {want:w,why:'体检空腹血糖偏高'+(hasMetf?'，在吃降糖药':''),kb:'血糖管理 · 甜食与进餐时间',line:w+'照吃！切一小块，放在饭后吃，别空着肚子吃。',plain:'血糖像锅里的水，空肚子吃甜的是大火猛烧，饭后吃是小火慢热，水就不会溢出来。'};
  if(SALT2.includes(w)) return {want:w,why:'奶奶在吃降压药，体检血压偏高',kb:'高血压膳食 · 限盐',line:w+'吃一点点，配一碗青菜，晚上多喝一杯白开水。',plain:'盐会让身体里的水管涨起来，降压药这个减压阀就得加班；多喝水等于给水管冲一冲。'};
  return null;
}
function tipFor(foods,sy){
  const f=foods.join(''),t=sy.join('');
  if(/头晕/.test(t)) return {why:'奶奶提到头晕，体检血压偏高',kb:'高血压 · 体位性头晕',line:'奶奶，起身前先坐着数到五再站起来。',plain:'血压像水塔送水，猛一站水还没送上来，头就发晕；慢一点，水就跟上了。'};
  if(/咸菜/.test(f)) return {why:'午饭偏咸，体检血压 148/92 偏高',kb:'高血压膳食 · 限盐',line:'奶奶，咸菜夹一筷子就够，晚上多喝一杯白开水。',plain:'盐会让水管涨起来，降压药这个减压阀就得加班；多喝水等于给水管冲一冲。'};
  if(/红烧肉|油条/.test(f)) return {why:'饮食偏油，体检低密度脂蛋白偏高',kb:'血脂异常 · 膳食脂肪',line:'奶奶，晚饭多来一碗青菜，饭后出去走十分钟。',plain:'油多了管道容易挂油垢，青菜和走路就是帮降脂药一起刷管道。'};
  if(/睡不好|没睡好/.test(t)) return {why:'奶奶说没睡好',kb:'老年睡眠卫生',line:'奶奶，下午的浓茶换成菊花茶，晚饭后出去走一圈。',plain:'浓茶像给身体踩油门，下午踩了，晚上就刹不住车。'};
  if(/腿疼|膝盖|腰疼/.test(t)) return {why:'奶奶提到腿疼，骨密度偏低',kb:'骨量减少 · 防跌倒',line:'奶奶，上下楼扶着扶手，一步一台阶慢慢走。',plain:'骨头像房子的承重墙，现在有点松，走慢些就是给墙减点力。'};
  return null;
}

/* ================= scheduler ================= */
function tick(){
  if(!S.running) return;
  S.clock+=S.speed;if(S.clock>=24*60){S.clock-=24*60;S.today={};S.pend=S.pend.filter(p=>p.type==='photo');log('','新的一天','过零点，今天的用药提醒重新开始');renderFrame();renderApp();}
  const due=S.meds.filter(m=>m.time<=S.clock&&m.time>S.clock-S.speed&&!S.today[m.id]);
  if(due.length) fireReminders(due);
  Object.entries(S.today).forEach(([id,v])=>{
    if(v.status==='lit'&&S.clock-v.firedAt>=S.timeoutMin&&!v.notified){
      v.notified=true;v.status='miss';const m=S.meds.find(x=>x.id===id);tool('notify');
      log('warn','超时未回应',`${m.use}提醒 ${S.timeoutMin} 分钟无回应 → 通知子女；相框保持亮灯，不重复催促奶奶`,{rules:['H5']});
      pushFeed('⏰',`奶奶 ${S.timeoutMin} 分钟没回应${m.use}提醒`,v.offline?'相框当时离线，提醒未送达':'相框一直亮着灯，可能没注意到。要不要打个电话？','home',true,{btns:[['pri','📞 打给奶奶','call'],['','稍后再看','dismiss']]});
      ribT(false,'⏰ 奶奶还没回应用药提醒',`${m.use} · 已过 ${S.timeoutMin} 分钟`);
      gstep('timeout');renderApp();
    }
  });
  renderClock();
}
function fireReminders(due){
  due.forEach(m=>S.today[m.id]={status:'lit',firedAt:S.clock});tool('notify');
  const merged=due.length>1&&S.mergeRemind;
  if(!S.online){
    due.forEach(m=>{S.today[m.id].offline=true;S.downQ.push({id:uid(),type:'reminder',medId:m.id,medName:m.use,voice:m.voice,dh:!!m.dh,time:m.time});});
    log('warn','定时提醒',`${due.map(m=>m.use).join('、')}到点，但相框离线 → 进入下行队列，上线后补亮灯`,{rules:['R4']});
    renderQueues();renderApp();return;
  }
  due.forEach(m=>S.pend.push({id:uid(),type:'reminder',medId:m.id,medName:m.use,voice:m.voice,dh:!!m.dh,time:m.time}));
  log('health','定时提醒',`${fmt(due[0].time)} ${due.map(m=>m.use).join('、')}到点 → 推送相框${merged?'，同一时段多条合并为一次亮灯':''}`,{rules:['H1','R2'],kv:`<span class="g">相框：亮灯 + 轻提示音</span><span>不自动播报</span><span>不换图</span>`});
  chime();renderFrame();renderApp();gstep('lit');
}

/* ================= child actions ================= */
async function deliverToFrame(item,label){
  if(!S.online){S.downQ.push(item);renderQueues();log('warn','下行排队',`${label} → 相框离线，云端排队，上线补发`,{rules:['R4']});return false;}
  S.pend.push(item);renderFrame();return true;
}
async function sendPhoto(p,voice){
  const ph={id:uid(),key:p.key,src:p.src,title:p.title,from:'小宇',voice,heard:false};
  S.photos.push(ph);S.care.xiaoyu+=3;
  const el=log('mem','子女·发照片',`小宇发送照片「${esc(ph.title)}」+ 语音 ${Math.max(2,Math.round(voice.length/4))}″`,{rules:['R3']});
  await runSteps(el,['存储','识别标签','推送相框'],300);
  const ok=await deliverToFrame({id:uid(),type:'photo',photoId:ph.id},'照片「'+ph.title+'」');
  if(ok){el.insertAdjacentHTML('beforeend',`<div class="kv"><span>相框：只亮红点，不自动换图</span></div>`);hit('R2');}
  pushFeed('📤','已发送给奶奶',`「${ph.title}」${ok?'· 相框亮红点，等奶奶按绿键':'· 相框离线，上线后送达'}`,'home',false);
  atoast(ok?'已送达相框，等奶奶按「听」':'相框离线，已排队');
  gstep('sent');renderApp();
}
async function deliverTip(line,who){
  const kind=who.startsWith('小宇')?'child':'dh';
  const item={id:uid(),type:'tip',voice:line,who,kind,time:S.clock};
  tool('notify');
  log('health','建议转达',`${kind==='dh'?'数字人小信播报（家人语气）':'小宇原声'}：「${esc(line)}」`,{rules:['H3','H2'],kv:`<span class="g">相框：亮灯 + 轻提示音，按绿键才开口</span><span>没有告警字样</span>${kind==='dh'?'<span>标注 AI 数字人 · 合成内容</span>':''}<span>完整分析留在子女端</span>`});
  const ok=await deliverToFrame(item,'建议');
  if(ok) chime();
  S.tipsSent++;S.care.xiaoyu+=2;
  atoast(ok?'已送到相框，奶奶按「听」就能听到':'相框离线，已排队');
  gstep('tipsent');renderApp();
}
function flushQueues(){
  if(S.upQ.length){
    const q=S.upQ.splice(0);
    q.sort((a,b)=>(analyze(b.text).emg?1:0)-(analyze(a.text).emg?1:0));
    log('','重新联网',`相框上线，补传 ${q.length} 段讲述${q.some(i=>analyze(i.text).emg)?'（紧急关键词优先）':''}`,{rules:['R4']});
    q.forEach((it,i)=>setTimeout(()=>processUtter(it,true),400+i*900));
  }
  if(S.downQ.length){
    const q=S.downQ.splice(0);q.forEach(it=>S.pend.push(it));
    const r=q.filter(x=>x.type!=='photo').length,p=q.length-r;
    log('health','补发相框',`下发排队内容：${p?p+' 张照片（亮红点）':''}${p&&r?'，':''}${r?r+' 条叮嘱（补亮灯）':''}`,{rules:['R4'].concat(r?['H1']:[])});
    if(r){chime();gstep('lit');q.filter(x=>x.type==='reminder').forEach(x=>{const t=S.today[x.medId];if(t&&t.status==='miss'){t.status='lit';t.firedAt=S.clock;t.notified=false;}});}
  }
  renderQueues();renderFrame();renderApp();
}

/* ================= app chrome ================= */
function pushFeed(ic,title,desc,area,badge,extra={}){
  S.feed.unshift({id:uid(),ic,title,desc,t:S.clock,...extra});
  if(S.xx&&S.xx.on){const im=$('#xxFabImg');if(im){im.className='xxa i-xx_'+(/服药|吃药|已打/.test(title)&&!extra.emg?'good':'remind');setTimeout(()=>{im.className='xxa i-xx_hello';},4000);}setTimeout(()=>xxBubble(title.length>14?title.slice(0,14)+'…':title),50);}
  if(badge){S.badges.home++;if(area!=='home')S.badges[area]++;}
}
let ribTimer;
function ribT(emg,t,d){
  $('#ribT').classList.toggle('emg',emg);$('#rtAv').className='av pimg i-grandma';
  $('#rtT').textContent=t;$('#rtD').textContent=d;$('#ribT').classList.add('show');
  clearTimeout(ribTimer);ribTimer=setTimeout(()=>$('#ribT').classList.remove('show'),emg?5000:3200);
}
let atTimer;
function atoast(t){$('#atoast').textContent=t;$('#atoast').classList.add('show');clearTimeout(atTimer);atTimer=setTimeout(()=>$('#atoast').classList.remove('show'),2200);}
function fit(){const w=$('#appwrap').clientWidth;$('#app').style.transform=`scale(${w/390})`;}
new ResizeObserver(fit).observe(document.getElementById('appwrap'));

const TABS=[['home','⌂','首页'],['meds','💊','用药'],['health','♡','健康'],['mem','🎞','回忆'],['me','☺','我的']];
const tabbar=()=>`<nav class="tabbar">${TABS.map(([k,i,n])=>`<button class="${S.scr===k?'on':''}" data-go="${k}"><span class="ti">${i}</span>${n}${k==='mem'&&S.badges.mem?`<span class="badge">${S.badges.mem}</span>`:''}${k==='health'&&S.badges.health?'<span class="badge">●</span>':''}${k==='meds'&&S.meds.some(m=>['lit','miss','q','no'].includes(S.today[m.id]?.status))?'<span class="badge">●</span>':''}</button>`).join('')}</nav>`;
const phd=(t,sub='',act='')=>`<div class="phd"><div><h3>${t}</h3>${sub?`<small>${sub}</small>`:''}</div>${act}</div>`;
const sub=(t)=>`<div class="sbh"><h3>${t}</h3></div>`;
function medStatus(m){
  const v=S.today[m.id];
  if(!v) return `<span class="pill x">${m.time>S.clock?'待提醒':'今日已过'}</span>`;
  return {lit:'<span class="pill a">亮灯中</span>',ok:`<span class="pill g">✓ ${fmt(v.at)}</span>`,miss:'<span class="pill r">未回应</span>',no:'<span class="pill r">说还没吃</span>',q:'<span class="pill p">待确认</span>'}[v.status];
}
function daysLeft(g){const st=S.stock[g];return st?Math.floor(st.count/Math.max(1,st.perDay)):null;}
function useStock(id){const m=S.meds.find(x=>x.id===id);if(!m||!S.stock[m.grp])return;const st=S.stock[m.grp];st.count=Math.max(0,st.count-(m.per||1));
  const d=daysLeft(m.grp);if(d<=5&&!st.warned){st.warned=true;tool('notify');pushFeed('📦',`${m.use}还剩 ${d} 天`,'扫一下新药盒就能补上余量；需要续方请提前挂号','home',true,{btns:[['pri','📷 扫新药盒','scan:'+m.grp]]});}}
const boxStyle=m=>m.boxSrc?`background-image:url(${m.boxSrc})`:'';
const boxCls=m=>m.boxSrc?'':(m.box?'i-'+m.box:'');
function doseDone(id){return S.today[id]?.status==='ok'?1:0;}
function rate7(){
  let n=0,d=0;S.meds.forEach(m=>{const h=HIST[m.id];if(h){h.forEach(x=>{n+=x;d++;});}if(S.today[m.id]||m.time<=S.clock){n+=doseDone(m.id);d++;}});
  return d?Math.round(n/d*100):100;
}

function renderApp(){
  const H=$('#scrHost');let h='';
  h=({home:homeHTML,meds:medsHTML,health:healthHTML,mem:memHTML,me:meHTML}[S.scr]||homeHTML)();
  H.innerHTML=h+tabbar();
  renderModal();xxRender();
  const inp=document.getElementById('sayIn');if(inp)inp.onkeydown=e=>{if(e.key==='Enter'){openModal('tip',{line:inp.value.trim()||'奶奶，今天天气好，下午出去晒晒太阳，走慢一点。'});}};
}
function attn(){
  const q=[];
  const emg=S.feed.find(f=>f.emg&&!f.closed);
  if(emg) q.push(`<div class="qi"><div class="t" style="color:var(--red2);font-weight:700">🚨 ${esc(emg.title)}<small>${fmt(emg.t)} · 已跳过排队立即通知</small></div><button class="gbtn red" data-fa="call">打电话</button></div>`);
  const tipOpen=S.feed.find(f=>f.tip&&!f.closed);
  if(tipOpen) q.push(`<div class="qi"><div class="t">💡 可以说给奶奶<small>${esc(S.tips[tipOpen.tip].line.slice(0,18))}…</small></div><button class="gbtn pri" data-fa="tipv:${tipOpen.tip}" data-fid="${tipOpen.id}">小信转达</button></div>`);
  Object.keys(S.stock).filter(g=>daysLeft(g)<=7).forEach(g=>{const m=S.meds.find(x=>x.grp===g);if(m)q.push(`<div class="qi"><div class="t">📦 ${esc(m.use.replace(/（.*）/,''))}只够 ${daysLeft(g)} 天<small>扫新药盒补充余量</small></div><button class="gbtn pri" data-fa="scan:${g}">补药</button></div>`);});
  S.meds.filter(m=>['lit','miss','q','no'].includes(S.today[m.id]?.status)).forEach(m=>q.push(`<div class="qi"><div class="t">${fmt(m.time)} ${esc(m.use)}<small>${esc(m.name)}</small></div>${medStatus(m)}</div>`));
  if(S.reports.length) q.push(`<div class="qi"><div class="t">📄 体检报告解读好了<small>4 项需关注</small></div><button class="gbtn" data-modal="report">查看</button></div>`);
  if(S.cards[0]) q.push(`<div class="qi"><div class="t">🎞 新传记「${esc(S.cards[0].title)}」<small>奶奶刚讲的往事</small></div><button class="gbtn" data-go="profile" data-ptab="bio">查看</button></div>`);
  return q;
}
function headline(){
  const emg=S.feed.find(f=>f.emg&&!f.closed);if(emg)return ['奶奶刚才说「'+((emg.title.match(/「(.*)」/)||[])[1]||'')+'」','已经通知你，必要时拨打急救电话'];
  const pend=S.meds.find(m=>['lit','miss'].includes(S.today[m.id]?.status));if(pend)return [`${fmt(pend.time)} 的${pend.use}还没确认`,'相框正亮灯等奶奶按「听」'];
  const done=S.meds.filter(m=>S.today[m.id]?.status==='ok').length,due=S.meds.filter(m=>m.time<=S.clock).length;
  if(due&&done>=due)return ['奶奶今天按时吃药了','我是小信，帮你照看奶奶的健康'];
  return ['奶奶今天还好','我是小信，帮你照看奶奶的健康'];
}
function ME0(){return {shots:[{w:'上周日',site:'左腹'}],weights:[86.0,85.4,84.9,84.6,83.8,83.5],target:78,todayW:false,
  fx:[{w:'第 2 周',t:'轻微恶心，两天后好了'}],
  med:{name:'玛仕度肽注射液',use:'减重针',how:'每周一次 · 皮下注射',when:'每周日 20:00',box:'box_pen'}};}
const SITES=['左腹','右腹','左大腿','右大腿'];
function nextSite(){const l=S.me.shots[S.me.shots.length-1];const i=SITES.indexOf(l?l.site:'');return SITES[(i+1)%SITES.length];}
function whoBar(){
  return `<div class="whob">${[['grandma','奶奶','相框提醒'],['xiaoyu','小宇','我自己']].map(([k,n,sm])=>`<button class="${S.who===k?'on':''}" data-who="${k}"><span class="av pimg i-${k}"></span><span><b>${n}</b><small>${sm}</small></span></button>`).join('')}<button class="add" data-addfam="1">＋ 家人</button></div>`;
}
function wtChart(){
  const w=S.me.weights,mx=Math.max(...w,S.me.target)+1,mn=Math.min(...w,S.me.target)-1,W=300,H=112;
  const x=i=>16+i*(W-32)/(w.length-1||1),y=v=>10+(mx-v)/(mx-mn)*(H-32);
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">
    <line x1="10" x2="${W-10}" y1="${y(S.me.target)}" y2="${y(S.me.target)}" stroke="#e7a2c6" stroke-dasharray="4 4"/>
    <text x="${W-12}" y="${y(S.me.target)-4}" text-anchor="end" font-size="10" fill="#c46a9c">目标 ${S.me.target} kg</text>
    <polyline points="${w.map((v,i)=>x(i)+','+y(v)).join(' ')}" fill="none" stroke="#8466ee" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    ${w.map((v,i)=>`<circle cx="${x(i)}" cy="${y(v)}" r="3.5" fill="#fff" stroke="#8466ee" stroke-width="2"/><text x="${x(i)}" y="${y(v)-8}" text-anchor="middle" font-size="9" fill="#5b3fd6">${v}</text><text x="${x(i)}" y="${H-4}" text-anchor="middle" font-size="9.5" fill="#857ca3">${i===w.length-1&&S.me.todayW?'今天':'第'+(i+1)+'周'}</text>`).join('')}
  </svg>`;
}
function medsMeHTML(){
  const m=S.me.med,last=S.me.shots[S.me.shots.length-1],done=S.me.shots.some(s=>s.w==='本周');
  return `<div class="page">${phd('用药','小宇 · 体重管理','<button class="ib pri" data-fa="shot" title="记录打针">＋</button>')}${whoBar()}
    <div class="cd"><h4>本周这一针 <small>只在你手机上提醒</small></h4>
      <div class="mrow"><div class="th pimg i-${m.box}"></div><div class="n"><b>${m.use} · ${m.when}</b><small>${m.name} · ${m.how}</small></div><span class="pill ${done?'g':'a'}">${done?'本周已打':'待打'}</span></div>
      <div class="note2 ok">上次：${last?last.w+' · '+last.site:'—'}　这次建议打：<b>${nextSite()}</b>（换个位置，皮肤不容易起硬块）</div>
      <button class="sbtn" data-fa="shot">${done?'再记录一次':'💉 我打完了'}</button>
      <div class="disc">处方药，剂量和加量节奏都听医生的；小信只做提醒和记录，不推荐、不调整用药。</div></div>
    <div class="cd"><h4>体重 <small>每周记一次就够</small></h4>${wtChart()}
      <div class="ibar" style="margin-top:8px"><input id="wtIn" type="number" step="0.1" placeholder="今天的体重（kg）"><button data-fa="wt">✓</button></div>
      <div class="plain">🔧 白话：这针像给胃装了个慢放阀，饭吃得慢、饱得早；每餐先吃菜、饭后走一走，效果更稳。</div></div>
    <div class="cd"><h4>身体感受 <small>记下来，复诊给医生看</small></h4>
      <div class="chips2" style="flex-wrap:wrap">${['还好','有点恶心','没胃口','便秘','肚子一直很疼'].map(t=>`<button data-fa="fx:${t}">${t}</button>`).join('')}</div>
      ${S.me.fx.slice().reverse().map(f=>`<div class="row"><span class="t" style="width:52px">${esc(f.w)}</span><span class="n" style="${f.bad?'color:#c0414e;font-weight:700':''}">${esc(f.t)}</span></div>`).join('')}</div>
    <div class="cd"><h4>和奶奶一起坚持</h4><div style="font-size:12.5px;color:var(--ink2)">把你这周的进展说给奶奶听：相框亮灯，她按「听」就能听到。祖孙俩一起管好身体。</div>
      <div class="gbtns"><button class="pri" data-fa="cheer">💬 让奶奶知道我也在坚持</button></div></div>
  </div>`;
}
function healthMeHTML(){
  const w=S.me.weights,d=(w[0]-w[w.length-1]).toFixed(1);
  return `<div class="page">${phd('健康','小宇 · 我自己的档案','<button class="ib pri" data-addrep="1" title="拍报告">＋</button>')}${whoBar()}
    <div class="cd"><h4>这几周</h4><div class="stat"><div style="border-color:#ddd2fb;background:#f6f2ff"><small>体重变化</small><b>-${d}</b> kg</div><div style="border-color:#f3d6e6;background:#fdf3f8"><small>按时打针</small><b>${S.me.shots.length+5}</b> 周</div><div style="border-color:#f1dcc0;background:#fff8ee"><small>不舒服</small><b>${S.me.fx.length}</b> 条</div></div></div>
    <div class="cd"><h4>我的体检 · 2026 <small>白话解读</small></h4>
      ${[['BMI','29.1','偏高','体重和身高的比例。现在像车多拉了几袋米，跑起来费油。'],['空腹血糖','6.2 mmol/L','略高','锅里的水温早上有点热，少喝甜饮料、主食换点杂粮。'],['甘油三酯','2.1 mmol/L','略高','血里的油有点多，少喝酒、少吃夜宵就能降下来。'],['血压','128/84','正常','水管压力正常，保持住。']].map(([k,v,l,ex])=>`<div class="ind"><div>${k}<small>${ex}</small></div><div class="v ${l==='正常'?'':'up'}">${v}<small>${l}</small></div></div>`).join('')}
      <div class="disc">你的体检和用药只有你自己能看；奶奶和其他家人看不到，除非你单独授权。</div></div>
  </div>`;
}
function sheetShot(set){
  let site=nextSite(),fx='还好';
  const draw=()=>set('记录这一针',`<div class="lbl2">打在哪里（建议 ${nextSite()}，和上次换个位置）</div><div class="sg">${SITES.map(x=>`<button class="${x===site?'on':''}" data-s="${x}">${x}${x===nextSite()?' ✓':''}</button>`).join('')}</div>
    <div class="lbl2">打完感觉怎么样</div><div class="sg">${['还好','有点恶心','没胃口'].map(x=>`<button class="${x===fx?'on':''}" data-f="${x}">${x}</button>`).join('')}</div>
    <button class="sbtn" id="shSave">保存</button><div class="hint">下周日 20:00 手机再提醒你；不会推到奶奶的相框。</div>`,b=>{
    b.querySelectorAll('[data-s]').forEach(x=>x.onclick=()=>{site=x.dataset.s;draw();});
    b.querySelectorAll('[data-f]').forEach(x=>x.onclick=()=>{fx=x.dataset.f;draw();});
    b.querySelector('#shSave').onclick=()=>{
      S.me.shots.push({w:'本周',site});if(fx!=='还好')S.me.fx.push({w:'本周',t:fx});tool('record');
      log('health','子女·自己的档案','小宇记录本周减重针：'+site+(fx!=='还好'?'，'+fx:'')+'（手机提醒，不进奶奶的相框）');
      atoast('已记录 · 下次建议打 '+nextSite());gstep('shot');closeModal();};
  });
  draw();
}
function medsHTML(){return S.who==='xiaoyu'?medsMeHTML():medsGmHTML().replace('<div class="cd">',whoBar()+'<div class="cd">');}
function healthHTML(){return S.who==='xiaoyu'?healthMeHTML():healthGmHTML().replace('<div class="cd">',whoBar()+'<div class="cd">');}

function grid7(){
  const meds=S.meds.slice().sort((a,b)=>a.time-b.time);
  let g=`<div class="chk" style="grid-template-columns:58px repeat(7,1fr)"><div></div>${['五','六','日','一','二','三','今'].map(d=>`<div class="hd">${d}</div>`).join('')}`;
  meds.forEach(m=>{g+=`<div class="rl">${fmt(m.time)}<small>${esc(m.use)}</small></div>`;
    (HIST[m.id]||[null,null,null,null,null,null]).forEach(x=>{g+=x==null?'<div class="cell wait">·</div>':x?'<div class="cell ok">✓</div>':'<div class="cell miss">✕</div>';});
    const v=S.today[m.id];g+=!v?'<div class="cell wait">○</div>':{ok:'<div class="cell ok">✓</div>',lit:'<div class="cell lit">🔔</div>',miss:'<div class="cell miss">✕</div>',no:'<div class="cell miss">✕</div>',q:'<div class="cell q">?</div>'}[v.status];});
  return g+'</div>';
}
function medsGmHTML(){
  const meds=S.meds.slice().sort((a,b)=>a.time-b.time),done=meds.filter(m=>S.today[m.id]?.status==='ok').length;
  const groups=meds.filter((m,i,a)=>a.findIndex(x=>x.grp===m.grp)===i);
  return `<div class="page">${phd('用药',`今天 ${done}/${meds.length} 次 · 近 7 天 ${rate7()}%`,'<button class="ib pri" data-a="med" title="扫药盒">＋</button>')}
    <div class="cd"><h4>今天 <small>点一条看详情</small></h4>${meds.map(m=>`<div class="mrow tap" data-meddet="${m.id}"><div class="th pimg ${boxCls(m)}" style="${boxStyle(m)}"></div><div class="n"><b>${fmt(m.time)} ${esc(m.use)}</b><small>${m.per||1} ${m.unit||'片'} · ${esc(m.timing||'')} · ${m.dh?'小信播报':'小宇原声'}</small></div>${medStatus(m)}<span class="chev">›</span></div>`).join('')}
      <button class="sbtn" data-a="med">📷 扫药盒：加新药或补药</button></div>
    <div class="cd"><h4>近 7 天 <small>✓ 已吃　✕ 漏服</small></h4>${grid7()}
      <div class="gbtns"><button data-fa="tip:praise">🎙 录一句夸奖</button><button class="pri" data-fa="tipv:praise">让小信夸夸奶奶</button></div></div>
    <div class="cd"><h4>药还够吃几天</h4>${groups.map(m=>{const d=daysLeft(m.grp);return `<div class="mrow"><div class="th pimg ${boxCls(m)}" style="${boxStyle(m)}"></div><div class="n"><b>${esc(m.use.replace(/（.*）/,''))}</b><small>${d!=null?`<span style="color:${d<=7?'#b8741a':'inherit'}">还够 ${d} 天</span>`:'—'}</small></div><button class="gbtn ${d!=null&&d<=7?'pri':''}" data-fa="scan:${m.grp}">补药</button></div>`;}).join('')}</div>
    <button class="lk" data-modal="weekly">📊 健康周报<span>›</span></button>
  </div>`;
}
function healthGmHTML(){
  const meal=S.meal;
  const inMeal=d=>meal==='all'||(meal==='b'&&d.t<10*60+30)||(meal==='l'&&d.t>=10*60+30&&d.t<15*60)||(meal==='d'&&d.t>=15*60);
  const foods=[...new Set(S.diet.filter(inMeal).flatMap(d=>d.foods))],all=[...new Set(S.diet.flatMap(d=>d.foods))];
  const lv=list=>Math.min(100,all.filter(f=>list.includes(f)).length*34);
  const mt=(n,v,col)=>`<div class="meter" style="display:flex;align-items:center;--cl-gap:10px"><span style="width:18px">${n}</span><div class="tr" style="flex:1;border-radius:6px;overflow:hidden"><i style="display:block;height:100%;width:${v}%;background:${col}"></i></div><span style="width:30px;font-size:11px;color:var(--ink2)">${v>=60?'偏高':v>=30?'适中':'低'}</span></div>`;
  const tip=tipFor(all,[]),tid=tip?Object.keys(S.tips).find(k=>S.tips[k].line===tip.line):null;
  return `<div class="page">${phd('健康','饮食、报告和身体情况，Agent 已经整理好','<button class="ib pri" data-a="report" title="拍报告">＋</button>')}
    <div class="cd"><h4>本周</h4><div class="stat"><div style="border-color:#ddd2fb;background:#f6f2ff"><small>按时吃药</small><b>${rate7()}%</b></div><div style="border-color:#f3d6e6;background:#fdf3f8"><small>聊到吃饭</small><b>${S.diet.length}</b> 次</div><div style="border-color:#f1dcc0;background:#fff8ee"><small>说不舒服</small><b>${S.symp.length}</b> 次</div></div>
      <button class="lk in" data-modal="weekly">看完整周报<span>›</span></button></div>
    <div class="cd"><h4>今天吃了什么 <small>奶奶随口说，自动记</small></h4>
      <div class="seg2">${[['all','全天'],['b','早'],['l','午'],['d','晚']].map(([k,n])=>`<button class="${meal===k?'on':''}" data-meal="${k}">${n}</button>`).join('')}</div>
      ${foods.length?`<div class="fgrid">${foods.map(f=>`<div><b>${FICON[f]||'🍽'}</b>${esc(f)}${SALTY.includes(f)?'<em>偏咸</em>':OILY.includes(f)?'<em class="o">偏油</em>':''}</div>`).join('')}</div>`:'<div class="empty">奶奶说了吃什么，这里就会出现</div>'}
      <div style="margin-top:10px">${mt('盐',lv(SALTY),'#9fb6e8')}${mt('油',lv(OILY),'#efbe72')}${mt('糖',lv(SUGARY),'#e7a2c6')}</div></div>
    ${tip?`<div class="cd scroll"><h4>🎟 生活作弊码</h4><div style="font-size:13.5px;color:var(--ink)">“${esc(tip.line)}”</div><div class="plain">🔧 白话：${esc(tip.plain||'')}</div><div style="font-size:11px;color:var(--ink3);margin:4px 0 8px">依据：${esc(tip.why)}</div><div class="gbtns" style="margin:0"><button data-fa="tip:${tid||'x'}">🎙 我录一句</button><button class="pri" data-fa="tipv:${tid||'x'}">让小信转达</button></div></div>`:''}
    <div class="cd"><h4>体检报告</h4>${S.reports.length?`<div class="mrow tap" data-modal="report"><div class="th" style="display:grid;place-items:center;font-size:22px;background:var(--vis)">📄</div><div class="n"><b>2026 年度体检</b><small>4 项值得留意：血压、血糖、血脂、骨密度</small></div><span class="chev">›</span></div>`:`<div class="empty" style="padding:6px 0">还没有报告，拍一下就行，几页一起拍</div><button class="sbtn" data-a="report">📄 拍体检报告</button>`}</div>
    <div class="cd"><h4>身体不适 <small>奶奶说过的</small></h4>${S.symp.length?S.symp.map(d=>`<div class="row"><span class="t">${fmt(d.t)}</span><span class="n" style="${d.emg?'color:var(--red);font-weight:700':''}">${esc(d.s)}${d.emg?' · 紧急':''}<small>“${esc(d.raw.slice(0,24))}”</small></span></div>`).join(''):'<div class="empty" style="padding:6px 0">今天没提到不舒服</div>'}</div>
  </div>`;
}
function memHTML(){
  const t=S.mseg||'bio';let c='';
  if(t==='bio'){
    const seed=[{photo:{key:'family'},title:'全家福·1992',raw:'这是建平考上大学那年，全家去照相馆照的，小敏非要站中间。',m:{when:'1992年',where:'照相馆',who:['建平','小敏']},old:1}];
    c=[...S.cards,...seed].map(x=>`<div class="cd" style="padding:0;overflow:hidden">${x.photo?photoHTML(x.photo).replace('class="ph','style="width:100%;height:150px" class="ph'):''}<div style="padding:12px 14px"><div style="font:800 15px var(--sans);color:var(--ink)">${esc(x.title)}${x.old?'':' <span class="pill p">新</span>'}</div><div style="font-size:12.5px;color:var(--ink2);margin:6px 0">“${esc(x.raw)}”</div><div class="kv">${x.m.when?`<span>🕰 ${esc(x.m.when)}</span>`:''}${x.m.where?`<span>📍 ${esc(x.m.where)}</span>`:''}${x.m.who.map(w=>`<span>👤 ${esc(w)}</span>`).join('')}<span class="g" style="cursor:pointer" data-fa="say:${esc(x.raw)}">▶ 奶奶原声</span></div></div></div>`).join('');
  }else{
    const ids=Object.keys(FAM).filter(k=>!FAM[k].hidden||S.revealed[k]);
    const lines=ids.filter(k=>FAM[k].rel).map(k=>{const a=FAM[k],b=FAM[a.rel[0]];const mx=(a.x+b.x)/2,my=(a.y+b.y)/2;
      return `<line x1="${a.x}%" y1="${a.y}%" x2="${b.x}%" y2="${b.y}%" stroke="${S.newNodes.includes(k)?'#8466ee':'#d6cde8'}" stroke-width="1.5" stroke-dasharray="${a.rel[1]==='夫妻'?'0':'4 4'}"/><text x="${mx}%" y="${my}%" dy="${a.x===b.x?4:a.y===b.y?-30:0}" dx="${a.x===b.x?8:0}" text-anchor="${a.x===b.x?'start':'middle'}" font-size="11" fill="#857ca3" stroke="#f7f4fd" stroke-width="3" paint-order="stroke">${a.rel[1]}</text>`;}).join('');
    c=`<div class="cd" style="padding:8px"><div class="rel"><svg>${lines}</svg>${ids.map(k=>`<div class="rn ${S.newNodes.includes(k)?'new':''}" style="left:${FAM[k].x}%;top:${FAM[k].y}%"><div class="fr pimg i-${FAM[k].img}"></div><span class="nm">${FAM[k].nm}</span></div>`).join('')}
      ${!S.revealed.gunainai?`<div class="rn ghost" style="left:${FAM.gunainai.x}%;top:${FAM.gunainai.y}%"><div class="fr" style="background:#f1ecfa;display:grid;place-items:center;color:#c3b8dc">?</div><span class="nm">待讲述</span></div>`:''}</div>
      <div class="disc">奶奶讲到新的人，族谱就会自动多一个。${S.extraPeople.length?'还提到了：'+S.extraPeople.map(esc).join('、'):''}</div></div>`;
  }
  return `<div class="page">${phd('回忆','奶奶讲的往事，自动整理成传记和族谱','<button class="ib pri" data-a="photo" title="发照片">＋</button>')}
    <div class="seg2">${[['bio',`传记 ${S.cards.length+1}`],['rel','族谱']].map(([k,n])=>`<button class="${t===k?'on':''}" data-mseg="${k}">${n}</button>`).join('')}</div>
    ${c}
    <button class="sbtn" data-a="photo">🖼 发一张老照片，听奶奶讲</button>
  </div>`;
}
function meHTML(){
  return `<div class="page">${phd('我的')}
    <div class="cd"><div class="gm"><div class="av pimg i-grandma"></div><div><div class="nm">奶奶 · 王秀兰 · 72 岁</div><div style="font-size:12px;color:var(--ink2);margin-top:2px">退休纺织工人 · 与老伴同住</div><div class="st"><span class="pill r">高血压</span><span class="pill a">血脂偏高</span><span class="pill p">骨量偏低</span></div></div></div></div>
    <div class="cd"><h4>健康档案 · 分人管理 <small>各看各的，记忆全家共享</small></h4>
      <div class="prow tap" data-who="grandma" data-go="meds"><div class="av pimg i-grandma"></div><div class="n">奶奶<small>慢病 · ${S.meds.length} 个提醒 · 相框提醒</small></div><span class="chev">›</span></div>
      <div class="prow tap" data-who="xiaoyu" data-go="meds"><div class="av pimg i-xiaoyu"></div><div class="n">小宇（我）<small>体重管理 · 每周一针 · 只在手机提醒</small></div><span class="chev">›</span></div>
      <div class="prow"><div class="av pimg i-dad" style="filter:grayscale(.5);opacity:.75"></div><div class="n">爸爸 · 小敏<small>还没建档：发个邀请，他们自己管自己的</small></div><button class="gbtn" data-addfam="1">邀请</button></div></div>
    <div class="cd"><h4>家人 <small>记忆全家共享；健康档案单独授权</small></h4>${[['xiaoyu','孙子 · 你自己'],['xiaomin','女儿'],['dad','儿子']].map(([k,role])=>`<div class="prow tap" data-person="${k}"><div class="av pimg i-${FAM[k].img}"></div><div class="n">${FAM[k].nm}<small>${role} · ${S.visible[k]?'🔓 可看健康档案':'🔒 只看记忆与族谱'}</small></div><span class="chev">›</span></div>`).join('')}</div>
    <div class="cd"><h4>设置</h4>
      <div class="mrow tap" data-modal="settings"><div class="th" style="display:grid;place-items:center;font-size:18px;background:var(--vis)">⏰</div><div class="n"><b>提醒与隐私</b><small>合并提醒 · 超时通知 · 小信浮窗 · 数据导出删除</small></div><span class="chev">›</span></div>
      <div class="mrow"><div class="th" style="display:grid;place-items:center;font-size:18px;background:var(--vis)">🖼</div><div class="n"><b>奶奶的相框</b><small>${S.online?'在线 · 客厅':'离线 · 消息会排队补发'}</small></div><span class="pill ${S.online?'g':'x'}">${S.online?'在线':'离线'}</span></div>
      <div class="mrow tap" data-modal="schedule"><div class="th" style="display:grid;place-items:center;font-size:18px;background:var(--vis)">🗓</div><div class="n"><b>用药提醒时间表</b><small>每天 ${S.meds.length} 次</small></div><span class="chev">›</span></div>
    </div>
  </div>`;
}
function medDetHTML(id){
  const m=S.meds.find(x=>x.id===id);if(!m)return '<div class="empty">这条提醒已删除</div>';const d=daysLeft(m.grp);
  return `<div style="display:flex;--cl-gap:12px;align-items:center"><div class="pimg ${boxCls(m)}" style="width:112px;height:84px;border-radius:12px;flex:none;${boxStyle(m)}"></div><div><div style="font:800 16px var(--sans);color:var(--ink)">${fmt(m.time)} ${esc(m.use)}</div><div style="font-size:12px;color:var(--ink2);margin:2px 0 4px">${esc(m.name)}</div>${medStatus(m)}</div></div>
    <div class="box" style="margin-top:10px">
      <div class="row"><span class="n">怎么吃<small>每次 ${m.per||1} ${m.unit||'片'} · ${esc(m.timing||'')} · 认准${esc(m.look||'')}</small></span></div>
      <div class="row"><span class="n">谁来提醒<small>${m.dh?'数字人小信（家人语气）':'小宇的原声'}：“${esc(m.voice)}”</small></span><button class="gbtn" data-fa="voice:${m.id}">▶ 试听</button></div>
      <div class="row"><span class="n">余量<small>${d!=null?'还够 '+d+' 天':'—'}</small></span><button class="gbtn ${d!=null&&d<=7?'pri':''}" data-fa="scan:${m.grp}">补药</button></div>
    </div>
    <div class="gbtns"><button data-fa="tgldh:${m.id}">${m.dh?'改成我的原声':'改成小信播报'}</button><button class="pri" data-fa="remind:${m.id}">现在提醒一次</button></div>`;
}
function homeHTML(){
  const meds=S.meds.slice().sort((a,b)=>a.time-b.time),done=meds.filter(m=>S.today[m.id]?.status==='ok').length,pct=meds.length?done/meds.length*100:0;
  const [h1]=headline();const q=attn();
  const emg=S.feed.find(f=>f.emg&&!f.closed),pend=meds.find(m=>['lit','miss','q','no'].includes(S.today[m.id]?.status));
  const tone=emg?'bad':pend?'warn':'ok';
  const next=meds.find(m=>!S.today[m.id]&&m.time>S.clock);
  const lastAct=S.lastSaidAt!=null?fmt(S.lastSaidAt):'昨天';
  return `<div class="page dash">
    <div class="dhd"><div><div class="logo"><span class="xxa i-xx_hello"></span>小信 <i>CareLink</i></div><small>10 月 30 日 · 周四 · 小宇</small></div><button class="ib" data-modal="feed">🔔${S.badges.home?`<span class="badge">${S.badges.home}</span>`:''}</button></div>
    <div class="cd who2 ${tone}">
      <div class="gm"><div class="av pimg i-grandma"></div><div style="flex:1;min-width:0"><div class="nm">奶奶 · 王秀兰</div><div class="st"><span class="pill ${S.online?'g':'x'}">${S.online?'相框在线 · 客厅':'相框离线'}</span><span class="pill x">最后互动 ${lastAct}</span></div></div><button class="ib call" data-fa="call" title="打电话">📞</button></div>
      <div class="state"><span class="dot"></span>${esc(h1)}</div>
    </div>
    ${q.length?`<div class="cd"><h4>需要你处理 <small>${q.length} 项</small></h4>${q.join('')}</div>`:''}
    <div class="cd tap" data-go="meds"><h4>今天的药 <small>查看全部 ›</small></h4>
      <div style="display:flex;--cl-gap:14px;align-items:center">
        <div class="ring" style="margin:0;background:conic-gradient(var(--vi) ${pct}%,#ece6fb 0)"><div>${done}/${meds.length}<small>已吃</small></div></div>
        <div style="flex:1;min-width:0">${meds.map(m=>`<div class="drow"><span class="t">${fmt(m.time)}</span><span class="n">${esc(m.use)}</span>${medStatus(m)}</div>`).join('')}
          ${next?`<div class="nx">下一次 ${fmt(next.time)} · ${esc(next.use)}</div>`:''}</div>
      </div></div>
    <div class="cd tap" data-who="xiaoyu" data-go="meds"><h4>我自己 · 体重管理 <small>只有你能看 ›</small></h4><div class="mrow" style="padding:0"><div class="th pimg i-box_pen"></div><div class="n"><b>${S.me.shots.some(x=>x.w==='本周')?'本周这一针已打':'周日 20:00 · 减重针'}</b><small>${S.me.weights.length} 周 · ${S.me.weights[0]} → ${S.me.weights[S.me.weights.length-1]} kg</small></div></div></div>
    <div class="cd"><h4>奶奶刚说 <small>${lastAct}</small></h4>
      <div class="msg"><div class="av pimg i-grandma"></div><div class="bb">“${esc(S.lastSaid.length>48?S.lastSaid.slice(0,48)+'…':S.lastSaid)}”</div></div>
      <div class="ibar"><span class="xxa i-xx_listen"></span><input id="sayIn" placeholder="给奶奶留句话，小信帮你转达…"><button data-a="say">➤</button></div></div>
    <div class="qa">
      <button data-a="photo"><span class="ic">🖼</span><b>发照片</b><small>听她讲往事</small></button>
      <button data-a="med"><span class="ic">💊</span><b>扫药盒</b><small>一袋药拍一张</small></button>
      <button data-a="report"><span class="ic">📄</span><b>拍报告</b><small>白话解读</small></button>
    </div>
  </div>`;
}
function feedHTML(){S.badges.home=0;
  return `<div class="page">${phd('动态','奶奶说的话、提醒结果和小信的建议')}
    ${S.feed.length?S.feed.map(f=>`<div class="fi ${f.emg?'emg':''}"><div class="ic">${f.ic}</div><div style="flex:1;min-width:0"><div class="tt">${esc(f.title)}</div><div class="ds">${esc(f.desc)}</div>${f.btns&&!f.closed?`<div class="btns">${f.btns.map(([c,t,a])=>`<button class="gbtn ${c}" data-fa="${a}" data-fid="${f.id}">${t}</button>`).join('')}</div>`:''}</div><div class="tm">${fmt(f.t)}</div></div>`).join(''):'<div class="empty">还没有动态。等 08:00 的用药提醒，或给奶奶发张照片。</div>'}
  </div>`;
}
function careHTML(){
  const F=S.careF||'all';
  const nFam=Object.keys(FAM).filter(k=>!FAM[k].hidden||S.revealed[k]).length;
  const cards=[
    ['med','🗓','用药日程',`${new Set(S.meds.map(m=>m.grp)).size} 种药 · 每天 ${S.meds.length} 次`,'data-modal="schedule"'],
    ['med','📷','扫药盒','拍照建档 · 补药','data-a="med"'],
    ['med','✅','服药打卡',`近 7 天 ${rate7()}%`,'data-go="check" data-ctab="week7"'],
    ['diet','🍚','饮食',`今天 ${S.diet.length} 次口述`,'data-go="table"'],
    ['report','📄','体检报告',S.reports.length?'4 项需关注':'还没上传',S.reports.length?'data-modal="report"':'data-a="report"'],
    ['report','📊','健康周报','每周日推送','data-go="check" data-ctab="weekly"'],
    ['mem','🎞','传记',`${S.cards.length+1} 张${S.badges.mem?' · 有新的':''}`,'data-go="profile" data-ptab="bio"'],
    ['mem','🌳','族谱',`${nFam} 人`,'data-go="profile" data-ptab="rel"'],
    ['all','👵','奶奶档案','慢病 · 用药 · 今日','data-go="profile" data-ptab="intro"']
  ].filter(c=>F==='all'||c[0]===F||c[0]==='all');
  const days=[...HDAYS.map((d,i)=>S.meds.every(m=>!HIST[m.id]||HIST[m.id][i])),S.meds.filter(m=>m.time<=S.clock).every(m=>S.today[m.id]?.status==='ok')];
  let streak=0;for(let i=days.length-1;i>=0&&days[i];i--)streak++;
  const low=Object.keys(S.stock).filter(g=>daysLeft(g)<=7)[0];const lm=low&&S.meds.find(x=>x.grp===low);
  return `<div class="page">${phd('照护空间','给奶奶的健康工具，每天用得上')}
    <div class="chips2">${[['all','全部'],['med','用药'],['diet','饮食'],['report','报告'],['mem','记忆']].map(([k,n])=>`<button class="${F===k?'on':''}" data-cf="${k}">${n}</button>`).join('')}</div>
    <div class="cg">${cards.map(([c,i,t,d,a])=>`<button ${a}><span class="ci">${i}</span><b>${t}</b><small>${d}</small></button>`).join('')}</div>
    <div class="cd jr"><h4>服药打卡 <small data-go="check" data-ctab="week7" style="cursor:pointer">查看 ›</small></h4>
      <div style="display:flex;--cl-gap:14px;align-items:center"><div class="ring" style="margin:0;background:conic-gradient(var(--vi) ${streak/7*100}%,#eceaf3 0)"><div>${streak}<small>天连续</small></div></div>
      <div style="flex:1"><div style="font-size:12px;color:var(--ink2);margin-bottom:6px">${streak>=5?'连续按时吃药，记得夸夸奶奶。':'有几天漏服，可以把叮嘱换成更具体的一句话。'}</div><div class="dots">${days.map((ok,i)=>`<span class="${ok?'ok':''}">${ok?'✓':''}<em>${['五','六','日','一','二','三','今'][i]}</em></span>`).join('')}</div></div></div></div>
    ${lm?`<div class="cd upb"><span class="ci">📦</span><div style="flex:1"><b>${esc(lm.use)}只够 ${daysLeft(low)} 天</b><small>扫一下新药盒，余量自动补上</small></div><button class="gbtn pri" data-fa="scan:${low}">补药</button></div>`:''}
  </div>`;
}
function familyHTML(){
  const ppl=[['xiaoyu','孙子 · 你自己',S.care.xiaoyu],['xiaomin','女儿',S.care.xiaomin],['dad','儿子',S.care.dad]];
  return `<div class="page">${phd('家人','健康档案只给奶奶指定的人看')}<div class="cd" style="display:flex;--cl-gap:8px"><button class="gbtn" style="flex:1;padding:8px" data-modal="settings">⚙ 提醒与隐私设置</button><button class="gbtn" style="flex:1;padding:8px" data-modal="schedule">🗓 用药日程</button></div>
    <div class="cd"><div class="prow"><div class="av pimg i-grandma"></div><div class="n">奶奶 · 王秀兰<small>被照顾的人 · 72 岁</small></div><button class="gbtn pri" data-person="grandma">档案</button></div></div>
    <div class="cd"><h4>家庭成员 <small>记忆卡片与族谱全家共享</small></h4>
    ${ppl.map(([k,role,v])=>`<div class="prow"><div class="av pimg i-${FAM[k].img}"></div><div class="n">${FAM[k].nm}<small>${role} · ${S.visible[k]?'🔓 可看健康档案':'🔒 仅看记忆与族谱'} · 互动 ${v} 次</small></div><button class="gbtn" data-person="${k}">权限</button></div>`).join('')}</div>
  </div>`;
}
function profileHTML(){
  const t=S.ptab;let c='';
  if(t==='intro'){
    c=`<div class="cd"><h4>用药清单 <small>扫药盒自动建档</small></h4>${S.meds.slice().sort((a,b)=>a.time-b.time).map(m=>{const d=daysLeft(m.grp);return `<div class="mrow"><div class="th pimg ${boxCls(m)}" style="${boxStyle(m)}"></div><div class="n"><b>${fmt(m.time)} ${esc(m.use)}</b><small>${esc(m.name)} · ${esc(m.look||'')}${d!=null?' · 还够 '+d+' 天':''}</small></div>${medStatus(m)}</div>`;}).join('')}</div>
      <div class="cd"><h4>体检报告</h4>${S.reports.length?`<div class="qi" style="border:none"><div class="t">${esc(REPORT.title)}<small>4 项需关注</small></div><button class="gbtn" data-modal="report">查看解读</button></div>`:`<div class="qi" style="border:none"><div class="t">还没有报告</div><button class="gbtn pri" data-a="report">拍报告</button></div>`}</div>`;
  }else if(t==='health'){
    c=`<div class="cd"><h4>今日饮食 <small>口述自动抽取</small></h4>${S.diet.length?S.diet.map(d=>`<div class="row"><span class="t">${fmt(d.t)}</span><span class="n">${esc(d.foods.join('、'))}<small>“${esc(d.raw.slice(0,24))}”</small></span></div>`).join(''):'<div class="empty">奶奶还没提到吃了什么</div>'}</div>
      <div class="cd"><h4>身体不适 <small>只推给子女</small></h4>${S.symp.length?S.symp.map(d=>`<div class="row"><span class="t">${fmt(d.t)}</span><span class="n" style="${d.emg?'color:var(--red);font-weight:700':''}">${esc(d.s)}${d.emg?' · 紧急':''}<small>“${esc(d.raw.slice(0,24))}”</small></span></div>`).join(''):'<div class="empty">今天没有提到不舒服</div>'}</div>`;
  }else if(t==='bio'){
    const seed=[{photo:{key:'family'},title:'全家福·1992',raw:'这是建平考上大学那年，全家去照相馆照的，小敏非要站中间。',m:{when:'1992年',where:'照相馆',who:['建平','小敏']},old:1}];
    c=[...S.cards,...seed].map(x=>`<div class="cd" style="padding:0;overflow:hidden">${x.photo?photoHTML(x.photo).replace('class="ph','style="width:100%;height:150px" class="ph'):''}<div style="padding:12px 14px"><div style="font:800 15px var(--sans);color:#4a4245">${esc(x.title)}${x.old?'':' <span class="pill p">新</span>'}</div><div class="q" style="font-size:12.5px;color:var(--ink2);margin:6px 0">“${esc(x.raw)}”</div><div class="kv">${x.m.when?`<span>🕰 ${esc(x.m.when)}</span>`:''}${x.m.where?`<span>📍 ${esc(x.m.where)}</span>`:''}${x.m.who.map(w=>`<span>👤 ${esc(w)}</span>`).join('')}<span class="g" style="cursor:pointer" data-fa="say:${esc(x.raw)}">▶ 原声</span></div></div></div>`).join('');
  }else{
    const ids=Object.keys(FAM).filter(k=>!FAM[k].hidden||S.revealed[k]);
    const lines=ids.filter(k=>FAM[k].rel).map(k=>{const a=FAM[k],b=FAM[a.rel[0]];const mx=(a.x+b.x)/2,my=(a.y+b.y)/2;
      return `<line x1="${a.x}%" y1="${a.y}%" x2="${b.x}%" y2="${b.y}%" stroke="${S.newNodes.includes(k)?'#c08f98':'#d6ccc8'}" stroke-width="1.5" stroke-dasharray="${a.rel[1]==='夫妻'?'0':'4 4'}"/><text x="${mx}%" y="${my}%" dy="${a.x===b.x?4:a.y===b.y?-30:0}" dx="${a.x===b.x?8:0}" text-anchor="${a.x===b.x?'start':'middle'}" font-size="11" fill="#8b8084" stroke="#faf8f7" stroke-width="3" paint-order="stroke">${a.rel[1]}</text>`;}).join('');
    c=`<div class="cd" style="padding:8px"><div class="rel"><svg>${lines}</svg>${ids.map(k=>`<div class="rn ${S.newNodes.includes(k)?'new':''}" style="left:${FAM[k].x}%;top:${FAM[k].y}%"><div class="fr pimg i-${FAM[k].img}"></div><span class="nm">${FAM[k].nm}</span></div>`).join('')}
      ${!S.revealed.gunainai?`<div class="rn ghost" style="left:${FAM.gunainai.x}%;top:${FAM.gunainai.y}%"><div class="fr" style="background:#f3eeee;display:grid;place-items:center;color:#c9bcbf">?</div><span class="nm">待讲述</span></div>`:''}</div>
      <div class="disc">族谱从奶奶的讲述里自动长出来：讲到新的人，就会出现在这里。${S.extraPeople.length?'还提到了：'+S.extraPeople.map(esc).join('、'):''}</div></div>`;
  }
  const done=S.meds.filter(m=>S.today[m.id]?.status==='ok').length;
  return `<div class="page">${sub('奶奶档案')}
    <div class="cd"><div class="gm"><div class="av pimg i-grandma"></div><div><div class="nm">王秀兰 · 72 岁</div><div style="font-size:12px;color:var(--ink2);margin-top:2px">退休纺织工人 · 与老伴同住 · 紧急联系人小宇</div><div class="st"><span class="pill r">高血压</span><span class="pill a">血脂偏高</span><span class="pill p">骨量偏低</span></div></div></div></div>
    <div class="seg2">${[['intro','档案'],['health','今日'],['bio','传记'],['rel','关系']].map(([k,n])=>`<button class="${t===k?'on':''}" data-ptab="${k}">${n}${k==='bio'&&S.badges.mem?' ●':''}</button>`).join('')}</div>
    ${c}
  </div>`;
}
function checkHTML(){
  const t=S.ctab;let c='';
  if(t==='week7'){
    const meds=S.meds.slice().sort((a,b)=>a.time-b.time);
    let g=`<div class="chk" style="grid-template-columns:58px repeat(7,1fr)"><div></div>${['五','六','日','一','二','三','今'].map(d=>`<div class="hd">${d}</div>`).join('')}`;
    meds.forEach(m=>{
      g+=`<div class="rl">${fmt(m.time)}<small>${esc(m.use)}</small></div>`;
      (HIST[m.id]||[null,null,null,null,null,null]).forEach(x=>{g+=x==null?`<div class="cell wait">·</div>`:x?`<div class="cell ok">✓</div>`:`<div class="cell miss">✕</div>`;});
      const v=S.today[m.id];
      g+=!v?`<div class="cell wait">○</div>`:{ok:`<div class="cell ok">✓</div>`,lit:`<div class="cell lit">🔔</div>`,miss:`<div class="cell miss">✕</div>`,no:`<div class="cell miss">✕</div>`,q:`<div class="cell q">?</div>`}[v.status];
    });
    g+='</div>';
    c=`<div class="cd"><h4>近 7 天服药 <small>依从率 ${rate7()}%</small></h4>${g}<div class="disc">记录来自奶奶的口头确认，复诊时可导出给医生；经授权也可对接药企患者服务项目。</div></div>
      <div class="cd"><h4>夸夸奶奶</h4><div style="font-size:12px;color:var(--ink2);margin-bottom:8px">打卡数据只给你看；奶奶听到的是一句夸奖，不是分数。</div><div class="gbtns" style="margin:0"><button data-fa="tip:praise">🎙 录一句夸奖</button><button class="pri" data-fa="tipv:praise">让小信转达</button></div></div>
      <div class="cd"><h4>药盒与余量</h4>${S.meds.filter((m,i,a)=>a.findIndex(x=>x.grp===m.grp)===i).map(m=>{const d=daysLeft(m.grp);return `<div class="mrow"><div class="th pimg ${boxCls(m)}" style="${boxStyle(m)}"></div><div class="n"><b>${esc(m.use.replace(/（.*）/,''))}</b><small>${esc(m.name)}${d!=null?` · <span style="color:${d<=7?'var(--red2)':'inherit'}">还够 ${d} 天</span>`:''}</small></div><button class="gbtn ${d!=null&&d<=7?'pri':''}" data-fa="scan:${m.grp}">扫新药盒</button></div>`;}).join('')}</div>`;
  }else if(t==='weekly'){c=weeklyHTML();}
  else if(t==='report'){c=reportHTML();}
  return `<div class="page">${sub(S.ctab==='weekly'?'健康周报':S.ctab==='report'?'报告解读':'服药打卡')}
    <div class="seg2">${[['week7','服药记录'],['weekly','健康周报'],['report','报告解读']].map(([k,n])=>`<button class="${t===k?'on':''}" data-ctab="${k}">${n}</button>`).join('')}</div>
    ${c}
  </div>`;
}
function tableHTML(){
  const meal=S.meal;
  const inMeal=d=>meal==='all'||(meal==='b'&&d.t<10*60+30)||(meal==='l'&&d.t>=10*60+30&&d.t<15*60)||(meal==='d'&&d.t>=15*60);
  const foods=[...new Set(S.diet.filter(inMeal).flatMap(d=>d.foods))];
  const all=[...new Set(S.diet.flatMap(d=>d.foods))];
  const lv=list=>Math.min(100,all.filter(f=>list.includes(f)).length*34);
  const mt=(n,v,col)=>`<div class="meter" style="display:flex;align-items:center;--cl-gap:10px"><span style="width:18px">${n}</span><div class="tr" style="flex:1;border-radius:6px;overflow:hidden"><i style="display:block;height:100%;width:${v}%;background:${col}"></i></div><span style="width:30px;font-size:11px;color:var(--ink2)">${v>=60?'偏高':v>=30?'适中':'低'}</span></div>`;
  const tip=tipFor(all,[]);
  const tid=tip?Object.keys(S.tips).find(k=>S.tips[k].line===tip.line):null;
  return `<div class="page">${sub('饮食')}<p class="hs" style="text-align:left;margin:-6px 0 10px">今天 ${S.diet.length} 次口述 · 奶奶随口说，Agent 自动记</p>
    <div class="cd"><h4>今日盐 / 油 / 糖 <small>对照体检结果</small></h4>${mt('盐',lv(SALTY),'#8fb8d0')}${mt('油',lv(OILY),'#e8b464')}${mt('糖',lv(SUGARY),'#d6a0aa')}</div>
    <div class="seg2">${[['all','全天'],['b','早餐'],['l','午餐'],['d','晚餐']].map(([k,n])=>`<button class="${meal===k?'on':''}" data-meal="${k}">${n}</button>`).join('')}</div>
    <div class="cd"><h4>吃了什么</h4>${foods.length?`<div class="fgrid">${foods.map(f=>`<div><b>${FICON[f]||'🍽'}</b>${esc(f)}${SALTY.includes(f)?'<em>偏咸</em>':OILY.includes(f)?'<em class="o">偏油</em>':''}</div>`).join('')}</div>`:'<div class="empty">奶奶说了吃什么，这里就会出现</div>'}</div>
    <div class="cd scroll" style="position:static">${tip?`<h4>🎟 生活作弊码</h4><div style="font-size:13.5px;color:var(--ink)">“${esc(tip.line)}”</div><div class="plain">🔧 白话：${esc(tip.plain||'')}</div><div style="font-size:11px;color:var(--ink3);margin:4px 0 8px">依据：${esc(tip.why)} · 不亮红牌，只给照做的办法</div><div class="gbtns" style="margin:0"><button data-fa="tip:${tid||'x'}">🎙 我录一句</button><button class="pri" data-fa="tipv:${tid||'x'}">让小信转达</button></div>`:`<h4>🍵 ${S.diet.length?'今天吃得挺清淡':'还没有饮食记录'}</h4><div style="font-size:12px;color:var(--ink2)">饮食来自奶奶按「说」随口讲，不用手填。</div>`}</div>
  </div>`;
}
function reportHTML(){
  if(!S.reports.length) return `<div class="empty">还没有体检报告。<br><br><button class="gbtn pri" data-a="report">📄 拍体检报告</button></div>`;
  return `<div class="box"><h5>📄 ${esc(REPORT.title)} <small>${fmt(S.reports[0].t)}</small></h5>
    <div style="font-size:11.5px;color:var(--ink2);margin-bottom:4px">共 ${REPORT.inds.length} 项，${REPORT.inds.filter(i=>i.up).length} 项值得留意。下面用白话讲，不构成诊断。</div>
    ${REPORT.inds.map(i=>`<div class="ind"><div>${esc(i.k)} ${i.up?'⚠️':''}<small>${esc(i.ex)}</small></div><div class="v ${i.up?'up':''}">${esc(i.v)}<small>参考 ${esc(i.ref)}</small></div></div>`).join('')}</div>
    <div class="box" style="background:#fff7ea"><h5>可以做的事</h5><div style="font-size:12px;line-height:1.8">① 3 个月后复查血脂、血糖 <button class="gbtn" data-fa="addcal">加到日历</button><br>② 连续一周早晚量血压，复诊带给医生<br>③ 饮食少油少稀饭</div>
    <div style="display:flex;--cl-gap:6px;margin-top:6px;align-items:center;flex-wrap:wrap"><button class="gbtn pri" data-fa="tip:rep">🎙 录一句说给奶奶</button><button class="gbtn" data-fa="tipv:rep">让小信转达</button><span style="font-size:10.5px;color:#8a5a10">奶奶只听到一句能照做的话，看不到指标</span></div>
    <div class="disc">只做通俗化解释和异常标注，不输出疾病结论；涉及换药、调剂量请咨询医生。附原始报告 · 仅指定子女可见</div></div>`;
}
function weeklyHTML(){
  const days=[...HDAYS,'今天'];
  const rates=days.map((d,i)=>{let n=0,c=0;S.meds.forEach(m=>{if(i<6){const h=HIST[m.id];if(h){n+=h[i];c++;}}else if(S.today[m.id]||m.time<=S.clock){n+=doseDone(m.id);c++;}});return c?n/c:1;});
  const avg=rate7();
  const hsym=['腿疼','睡不好'],syms=[...hsym,...S.symp.map(s=>s.s)];
  const cnt={};syms.join('、').split('、').filter(Boolean).forEach(s=>cnt[s]=(cnt[s]||0)+1);
  const hdiet='粥、鸡蛋、青菜、面条、豆腐、饺子、稀饭、咸菜、鱼、包子、豆浆、米饭、红烧肉、白菜';
  const allDiet=hdiet+'、'+S.diet.map(d=>d.foods.join('、')).join('、');
  const porr=(allDiet.match(/粥|稀饭/g)||[]).length;
  return `<div class="box"><h5>📊 本周健康周报 <small>每周日推送给你</small></h5>
    <div class="stat"><div style="border-color:#a8d8bd;background:#eef9f2"><small>用药依从率</small><b>${avg}%</b></div><div style="border-color:#f1cf95;background:#fff6e4"><small>提到不适</small><b>${syms.length}</b> 次</div><div style="border-color:#d3c0f0;background:#f6f0ff"><small>传记卡片</small><b>${S.cards.length+3}</b> 张</div></div>
    <div style="font-size:11px;color:var(--ink3)">每日服药完成度</div>
    <div class="bars">${days.map((d,i)=>`<div><i class="${rates[i]<1?'lo':''}" style="height:${Math.max(6,rates[i]*56)}px"></i>${d}</div>`).join('')}</div>
    <div class="disc">依从性记录来自奶奶的口头确认，复诊时可一键导出给医生；经授权也可对接药企患者服务项目。本周已说给奶奶的话：${S.tipsSent} 条。</div></div>
    <div class="box"><h5>🍚 饮食</h5><div style="font-size:12px;color:var(--ink2)">稀饭/粥出现 ${porr} 次，结合体检空腹血糖偏高，可以换成杂粮粥或配鸡蛋。${/咸菜/.test(allDiet)?'有咸菜，注意控盐。':''}</div></div>
    <div class="box"><h5>🩺 身体</h5><div style="font-size:12px;color:var(--ink2)">${Object.entries(cnt).map(([k,v])=>`${esc(k)} ${v} 次`).join('，')}。</div></div>
    <div class="box" style="background:#fff7ea"><h5>✅ 本周可以做的 3 件事</h5><div style="font-size:12px;line-height:1.8">① 周日晚、周二早各漏了一次，可以把那个时段的叮嘱换成更具体的一句话<br>② 她提到过${Object.keys(cnt).slice(0,2).map(esc).join('和')}，周末打电话时顺口问问<br>③ 3 个月复查血脂、血糖的日子快到了，提前约好陪诊</div><div class="disc">建议仅涉及饮食、作息、复查时间；诊断、换药、调剂量请咨询医生。</div></div>`;
}

/* ================= modals ================= */
/* ===== 小信浮窗陪伴 ===== */
const XXQ=['奶奶今天吃药了吗','药还够吃几天','奶奶最近说了什么','我这周体重怎么样','帮我跟奶奶说句话','我有点累'];
function xxMedLine(m){const v=S.today[m.id];
  if(!v) return m.time>S.clock?fmt(m.time)+' 才提醒':'今天没有记录';
  return {ok:'已吃（'+fmt(v.at)+'）',lit:'相框亮着灯，奶奶还没按绿键',q:'她说了一句，等你确认',no:'她说还没吃',miss:'到点没回应，已通知你'}[v.status]||'处理中';}
function xxGreet(){const ok=S.meds.filter(m=>S.today[m.id]&&S.today[m.id].status==='ok').length,due=S.meds.filter(m=>m.time<=S.clock).length;
  const low=Object.keys(S.stock).filter(g=>daysLeft(g)<=7);
  const h=Math.floor(S.clock/60),hi=h<11?'早上好':h<14?'中午好':h<18?'下午好':'晚上好';
  return {t:'小宇'+hi+'，我在呢。'+(due?'奶奶今天该吃的 '+due+' 次药，已经吃了 '+ok+' 次。':'奶奶今天的药还没到点。')+(low.length?'降压药快吃完了，记得补。':'')+'想问什么都可以，或者就随便聊聊。',exp:'hello'};}
function xxReply(q){
  const has=(...w)=>w.some(x=>q.includes(x));
  if(has('胸痛','胸口疼','晕倒','摔倒','喘不上','120','急救','昏'))
    return {t:'这个情况先别等我分析：马上给奶奶打电话；如果有胸痛、晕倒、说不出话，直接拨 120。我会把这段记进她的档案。',exp:'remind',acts:[['📞 打给奶奶','data-fa="call"']]};
  if(has('减量','加量','停药','少吃','多吃','换药','剂量','半片','能不能不吃'))
    return {t:'吃多少、能不能停，得听医生的，我不能给剂量建议。我可以帮你把奶奶最近的血压和服药记录整理好，复诊时直接给医生看。',exp:'slow',acts:[['看用药记录','data-go="meds"'],['看体检报告','data-modal="report"']]};
  if(has('吃药','吃了吗','吃了没','服药','药吃'))
    return {t:'奶奶今天：<br>'+S.meds.map(m=>'· '+fmt(m.time)+' '+esc(m.use)+'：'+xxMedLine(m)).join('<br>'),exp:'remind',acts:[['去用药页','data-go="meds"']]};
  if(has('够吃','余量','补药','快吃完','还剩','药盒'))
    return {t:Object.keys(S.stock).map(g=>{const m=S.meds.find(x=>x.grp===g);const d=daysLeft(g);return m?'· '+esc(m.use)+'：还够 '+d+' 天'+(d<=7?'，该补了':''):'';}).filter(Boolean).join('<br>')+'<br>拍一下新药盒，我就把余量加上。',exp:'remind',acts:[['📷 扫药盒','data-a="med"']]};
  if(has('跟奶奶说','告诉奶奶','转达','带句话','说句话')){const line=q.replace(/^(帮我)?(跟|告诉|和)奶奶说[，,：: ]?/,'').trim();const ok=line&&line!==q&&line.length>2&&!/^句话/.test(line);
    return {t:ok?'好，我按你的语气跟奶奶说：“'+esc(line)+'”。你也可以自己录一句，她更爱听你的声音。':'你想跟奶奶说什么？直接打出来，比如“帮我跟奶奶说今天降温多穿点”，我来转达。',exp:'with',acts:ok?[['让小信转达','data-xxtip="'+esc(line)+'"']]:[]};}
  if(has('奶奶说','说了什么','心情','最近怎么样','她怎么样','聊了什么'))
    return {t:'奶奶'+(S.lastSaidAt!=null?fmt(S.lastSaidAt):'昨天')+'说：“'+esc(S.lastSaid)+'”<br>'+(/花|回来|想/.test(S.lastSaid)?'听得出来她挺想你的，有空给她回个电话吧。':'状态挺平稳的。'),exp:'miss',acts:[['📞 打给奶奶','data-fa="call"'],['发张照片给她','data-a="photo"']]};
  if(has('体重','减重','打针','这一针','瘦')){const w=S.me.weights,a=w[0],b=w[w.length-1];
    return {t:'你这 '+w.length+' 周从 '+a+' 降到 '+b+' kg，一共少了 '+(a-b).toFixed(1)+' kg，离目标 '+S.me.target+' kg 还差 '+(b-S.me.target).toFixed(1)+' kg。'+(S.me.shots.some(x=>x.w==='本周')?'本周这针已经打了。':'本周这一针还没记，周日 20:00 我提醒你，记得换个部位。'),exp:'good',acts:[['看我的档案','data-who="xiaoyu" data-go="meds"']]};}
  if(has('报告','体检','血压','血糖','血脂'))
    return {t:'奶奶的体检我用大白话解释过了：血压像水管的水压，盐吃多了水压就往上走。详细的在报告解读里。',exp:'with',acts:[['看报告解读','data-modal="report"']]};
  if(has('累','烦','焦虑','担心','难受','压力','睡不着','哭'))
    return {t:'辛苦了。一个人在外地还惦记家里，真的不容易。奶奶这边我一直看着，有事第一时间告诉你，你先照顾好自己。',exp:'hug'};
  if(has('谢谢','辛苦','爱你','真好'))
    return {t:'不客气，陪着你们是我的事～',exp:'thanks'};
  if(has('晚安','睡了','去睡'))
    return {t:'晚安小宇。奶奶睡前的药我会盯着，你安心睡。',exp:'night'};
  if(has('你是谁','你好','嗨','在吗','你叫'))
    return {t:'我是小信，奶奶相框里的那个，也住在你手机边上。奶奶的提醒、她说的话、你的减重针，我都记着。',exp:'hello'};
  return {t:'这个我还不太确定。我能帮你看奶奶的用药、药还够几天、她最近说了什么、你的体重进度，也可以帮你给奶奶带句话。',exp:'slow'};
}
function xxPush(m){S.xx.msgs.push(m);xxMsgs();}
function xxMsgs(){const el=$('#xxMsgs');if(!el)return;
  el.innerHTML=S.xx.msgs.map(m=>m.me?'<div class="xxM me"><div class="bb">'+esc(m.t)+'</div></div>':m.typing?'<div class="xxM"><span class="xxa i-xx_listen"></span><div class="bb typing"><i></i><i></i><i></i></div></div>':
    '<div class="xxM"><span class="xxa i-xx_'+(m.exp||'hello')+'"></span><div class="bb">'+m.t+(m.acts&&m.acts.length?'<div class="acts">'+m.acts.map(([l,a])=>'<button class="xxAct" '+a+'>'+l+'</button>').join('')+'</div>':'')+'</div></div>').join('');
  el.scrollTop=el.scrollHeight;}
function xxAsk(q){q=(q||'').trim();if(!q)return;xxPush({me:1,t:q});const tp={typing:1};xxPush(tp);
  setTimeout(()=>{S.xx.msgs=S.xx.msgs.filter(x=>x!==tp);const r=xxReply(q);xxPush(r);
    log('health','子女·问小信','小宇问：「'+esc(q)+'」→ 小信用档案里的实时记录回答'+(r.acts&&r.acts.length?'，附快捷入口':''),{rules:/剂量|减量|加量|停药|半片|少吃|多吃|换药/.test(q)?['G1']:[]});},700);}
function xxRender(){const fab=$('#xxFab'),ch=$('#xxChat');if(!fab||!S||!S.xx)return;
  fab.classList.toggle('hide',!S.xx.on||S.xx.open);fab.classList.toggle('left',S.xx.side==='left');
  if(!fab.classList.contains('drag')){fab.style.top=S.xx.y+'px';fab.style.left=S.xx.side==='left'?'10px':'auto';fab.style.right=S.xx.side==='left'?'auto':'10px';}
  const ping=S.feed.some(f=>(f.emg||f.tip)&&!f.closed)||Object.keys(S.stock).some(g=>daysLeft(g)<=7);fab.classList.toggle('ping',ping);
  ch.classList.toggle('show',S.xx.on&&S.xx.open);$('#xxMaskC').classList.toggle('show',S.xx.on&&S.xx.open);}
function xxOpen(){S.xx.open=true;if(!S.xx.greeted){S.xx.greeted=true;S.xx.msgs.push(xxGreet());}
  $('#xxQs').innerHTML=XXQ.map(q=>'<button data-xxq="'+q+'">'+q+'</button>').join('');xxRender();xxMsgs();}
function xxOff(){S.xx.on=false;S.xx.open=false;xxRender();atoast('小信浮窗已关闭，可在「我的 → 提醒与隐私」重新打开');log('','子女·设置','关闭了手机上的小信浮窗陪伴（相框上的小信不受影响）');}
let xxBubT;function xxBubble(t){const b=$('#xxBub');if(!b||!S.xx.on||S.xx.open)return;b.textContent=t;b.classList.add('show');clearTimeout(xxBubT);xxBubT=setTimeout(()=>b.classList.remove('show'),3200);}
function openModal(type,data={}){S.modal={type,...data};$('#modal').dataset.cur='';renderApp();}
function closeModal(){S.modal=null;$('#modal').dataset.cur='';renderApp();}
function renderModal(){
  const m=S.modal,M=$('#modal');
  $('#mask').classList.toggle('show',!!m);M.classList.toggle('show',!!m);M.classList.toggle('emg',!!m&&m.type==='emg');
  if(!m) return;
  if(M.dataset.cur===m.type+(m.key||'')&&['photo','med','reportShot','tip','settings','person','batch','shot'].includes(m.type)) return;
  M.dataset.cur=m.type+(m.key||'');
  const set=(t,h,bind)=>{$('#mT').textContent=t;$('#mB').innerHTML=h;bind&&bind($('#mB'));};
  if(m.type==='feed'){S.badges.home=0;
    set('家人动态',S.feed.length?S.feed.map(f=>`<div class="fi ${f.emg?'emg':''}"><div class="ic">${f.ic}</div><div style="flex:1;min-width:0"><div class="tt">${esc(f.title)}</div><div class="ds">${esc(f.desc)}</div>${f.btns&&!f.closed?`<div class="btns">${f.btns.map(([c,t,a])=>`<button class="gbtn ${c}" data-fa="${a}" data-fid="${f.id}">${t}</button>`).join('')}</div>`:''}</div><div class="tm">${fmt(f.t)}</div></div>`).join(''):'<div class="empty">还没有动态</div>');}
  else if(m.type==='schedule') set('用药日程',`<div class="box"><h5>💊 每天的提醒 <small>到点相框亮灯、弹窗并主动提醒</small></h5>${S.meds.slice().sort((a,b)=>a.time-b.time).map(x=>{const d=daysLeft(x.grp);return `<div class="mrow"><div class="th pimg ${boxCls(x)}" style="${boxStyle(x)}"></div><div class="n"><b>${fmt(x.time)} ${esc(x.use)}</b> · ${x.per||1}${x.unit||'片'} · ${esc(x.timing||'')}<small>${esc(x.name)} · ${x.dh?'小信播报':'小宇原声'}${d!=null?` · <span style="color:${d<=7?'var(--red2)':'var(--ink3)'}">还够 ${d} 天</span>`:''}</small></div>${medStatus(x)}</div>`;}).join('')}</div>
    ${Object.keys(S.stock).filter(g=>daysLeft(g)<=7).map(g=>{const m=S.meds.find(x=>x.grp===g);return `<div class="note2 wa">📦 ${esc(m?m.use:'')}只够 ${daysLeft(g)} 天了。扫一下新药盒就能补上；续方请提前挂号。 <button class="gbtn pri" data-fa="scan:${g}">扫新药盒</button></div>`;}).join('')}
    <button class="sbtn" data-a="med">📷 扫药盒，加一种药</button>`);
  else if(m.type==='report'){set('体检报告解读',reportHTML());gstep('rtab');}
  else if(m.type==='settings') set('提醒设置',`<div class="box">
      <div class="setrow"><div>同时段提醒合并<small>合并为一次亮灯，按时间顺序播放</small></div><label class="sw"><input type="checkbox" id="setMerge" ${S.mergeRemind?'checked':''}><span class="s"></span></label></div>
      <div class="setrow"><div>无回应多久通知我<small>不会对奶奶重复催促</small></div><select id="setTo" class="tin" style="width:auto">${[15,30,60].map(n=>`<option ${S.timeoutMin===n?'selected':''} value="${n}">${n} 分钟</option>`).join('')}</select></div>
      <div class="setrow"><div>到点弹窗提醒<small>相框屏幕弹出吃药提醒，家人可关</small></div><label class="sw"><input type="checkbox" id="setPopup" ${S.remindPopup!==false?"checked":""}><span class="s"></span></label></div>
      <div class="setrow"><div>到点小信主动说<small>不用按键，到点直接播报一次，家人可关</small></div><label class="sw"><input type="checkbox" id="setVoice" ${S.remindVoice!==false?"checked":""}><span class="s"></span></label></div>
      <div class="setrow"><span class="xxa i-xx_main" style="width:40px;height:40px"></span><div style="flex:1">数字人形象<small>IP 形象「小信」；按场景换表情（提醒 / 在听 / 夸奖 / 晚安…），合成内容在相框上显著标识</small></div><span class="pill g">小信</span></div>
      <div class="setrow"><div>小信浮窗陪伴<small>手机屏幕边上的小信，点开就能聊；关了也随时能在这里打开</small></div><label class="sw"><input type="checkbox" id="setXX" ${S.xx.on?'checked':''}><span class="s"></span></label></div>
      <div class="setrow"><div>使用家人形象 / 声音<small>须本人授权，按深度合成相关规定显著标识</small></div><span class="pill x">未授权</span></div>
      <div class="setrow"><div>体检报告、口述音频<small>加密存储</small></div><span class="pill g">已加密</span></div>
      <div class="setrow"><div>导出 / 删除健康数据</div><span><button class="gbtn" data-fa="export">导出</button> <button class="gbtn red" data-fa="del">删除</button></span></div></div>
      <div class="disc">本产品为健康记录与提醒工具，不提供诊断，不申报医疗器械功能。紧急情况请拨打 120。</div>`);
  else if(m.type==='person'){const k=m.key,f=FAM[k];
    set(f.nm+' · '+f.full,`<div style="display:flex;--cl-gap:14px"><div class="pimg i-${f.img}" style="width:130px;height:150px;border-radius:60px 60px 10px 10px;border:3px solid var(--gold2);flex:none"></div><div style="flex:1"><div class="box"><h5>权限 <small>记忆与健康分开授权</small></h5>
      <div class="setrow"><div>记忆卡片 · 族谱<small>全家共享</small></div><span class="pill g">可看</span></div>
      <div class="setrow"><div>健康档案<small>${k==='xiaoyu'?'奶奶指定的子女':'需要奶奶同意'}</small></div><label class="sw"><input type="checkbox" data-vis="${k}" ${S.visible[k]?'checked':''}><span class="s"></span></label></div></div>
      <div class="box"><h5>陪伴值 ${S.care[k]}</h5><div style="font-size:11.5px;color:var(--ink2)">发照片、录叮嘱、说给奶奶的话都会累积。只在家人之间显示，不给奶奶排名。</div></div></div></div>`);}
  else if(m.type==='emg') set('紧急 · 奶奶需要你',`<div style="display:flex;--cl-gap:14px;align-items:center"><div class="pimg i-grandma" style="width:110px;height:110px;border-radius:50%;border:3px solid var(--red);flex:none"></div><div><div style="font:800 18px var(--serif);color:var(--red2)">奶奶说「${esc(m.kw)}」</div><div class="q" style="font-size:13px;color:var(--ink2);margin:6px 0">“${esc(m.text)}”</div><div style="font-size:11.5px;color:var(--ink3)">${fmt(S.clock)} · 已跳过排队立即通知你 · 相框上只显示「已告诉小宇」</div></div></div>
      <div style="display:flex;--cl-gap:8px;margin-top:14px"><button class="sbtn" style="margin:0;background:linear-gradient(180deg,#ec7a80,var(--red));border-color:var(--red2)" data-fa="call">📞 马上打给奶奶</button><button class="sbtn" style="margin:0;background:#fff;color:var(--wood2);border-color:var(--gold2)" data-fa="audio:${m.id}">▶ 听原音频</button></div>
      <div class="disc">如有危险请立即拨打 120 或联系邻居 / 社区；相框不承诺急救能力。</div>`);
  else if(m.type==='photo') sheetPhoto(set);
  else if(m.type==='med') sheetMed(set);
  else if(m.type==='batch') sheetBatch(set);
  else if(m.type==='shot') sheetShot(set);
  else if(m.type==='weekly'){set('健康周报',weeklyHTML());gstep('week');}
  else if(m.type==='meddet'){const mm=S.meds.find(x=>x.id===m.key);set(mm?mm.use+' · '+fmt(mm.time):'用药',medDetHTML(m.key));}
  else if(m.type==='reportShot') sheetReport(set);
  else if(m.type==='tip') sheetTip(set,m.line);
}
function holdBtn(btn,onDone){
  let t0=0,iv;
  const start=e=>{e.preventDefault();t0=Date.now();btn.classList.add('rec');btn.classList.remove('done');iv=setInterval(()=>btn.textContent='● 录音中 '+((Date.now()-t0)/1000).toFixed(1)+'″ · 松开结束',100);};
  const end=()=>{if(!t0)return;clearInterval(iv);const d=(Date.now()-t0)/1000;t0=0;btn.classList.remove('rec');
    if(d<0.8){btn.textContent='🎙 按住录语音（太短了，再按久一点）';return;}
    btn.classList.add('done');btn.textContent=`✓ 已录 ${d.toFixed(1)}″ · 按住重录`;onDone(d);};
  btn.addEventListener('pointerdown',start);btn.addEventListener('pointerup',end);btn.addEventListener('pointerleave',end);
}
function sheetPhoto(set){
  let sel=null,rec=false;
  const keys=['lake','family','factory','grad','baby','garden'];
  set('发照片给奶奶',`<div class="lbl2">选照片（也可上传自己的）</div>
    <div class="pgrid">${keys.map(k=>`<div class="pi" data-k="${k}">${photoHTML({key:k})}<div class="cap2">${PHOTOS[k].title}</div></div>`).join('')}<label class="pi up">＋ 上传<input type="file" accept="image/*" hidden></label></div>
    <div class="lbl2">语音内容（演示用，相框会播放）</div><input class="tin" id="vTxt" value="奶奶，您看这张照片是在哪儿拍的？给我讲讲呗。">
    <div class="lbl2">录语音 · 必须附语音才能发送</div><button class="hold" id="vHold">🎙 按住录语音</button>
    <button class="sbtn" id="vSend" disabled>发送到相框</button><div class="hint">相框只会亮红点、不会自动换图，奶奶按「听」才切过去。</div>`,b=>{
    const upd=()=>{b.querySelector('#vSend').disabled=!(sel&&rec);};
    b.querySelectorAll('.pi[data-k]').forEach(el=>el.onclick=()=>{b.querySelectorAll('.pi').forEach(x=>x.classList.remove('on'));el.classList.add('on');sel={key:el.dataset.k,title:PHOTOS[el.dataset.k].title};upd();});
    b.querySelector('input[type=file]').onchange=e=>{const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=()=>{const lab=e.target.parentElement;lab.innerHTML=`<div class="ph" style="background-image:url(${r.result});position:absolute;top:0;right:0;bottom:0;left:0"></div>`;b.querySelectorAll('.pi').forEach(x=>x.classList.remove('on'));lab.classList.add('on');sel={src:r.result,title:f.name.replace(/\.\w+$/,'').slice(0,10)||'新照片'};upd();};Promise.resolve(window.CareLinkCompress?CareLinkCompress(f):f).then(v=>r.readAsDataURL(v)).catch(e=>atoast(e.message));};
    holdBtn(b.querySelector('#vHold'),()=>{rec=true;upd();});
    b.querySelector('#vSend').onclick=()=>{closeModal();sendPhoto(sel,b.querySelector('#vTxt').value.trim()||'奶奶，给您发了张照片。');};
    if(S.scen==='mem'||S.scen==='offline') b.querySelector('.pi[data-k="lake"]').click();
  });
}
function medLine(f){return `奶奶，该吃${f.use}了，${f.timing==='随餐'?'吃饭的时候':f.timing==='睡前'?'睡觉前':f.timing==='饭前'?'吃饭前':'吃完早饭'}吃 ${f.per===1?'一':'两'}${f.unit}，${f.look.replace(/片$/,'的那种').replace(/胶囊$/,'胶囊那种')}。`;}
function sheetBatch(set){
  const st={step:0,ok:{}};
  const keys=['amlo','metf','vitd'];
  const items=()=>keys.map(k=>{const L=MED_LIB.find(x=>x.key===k);const ex=S.meds.find(m=>m.grp===k);return {L,mode:ex?'refill':'new',low:Object.entries(L.conf).filter(([a,v])=>v<.8).map(([a])=>a)};});
  const render=()=>{
    let h='';
    if(st.step===0){
      h=`<div class="vf"><div class="shot pimg i-box_bag" style="background-position:center"></div><div class="scanl"></div></div><div class="agl" id="bAg"></div>`;
    }else if(st.step===1){
      const its=items();
      h=`<div class="note2 ok">一张照片认出 3 盒药。不用填表，核对一下就能全部建档。</div>`+its.map(({L,mode,low})=>{const days=Math.floor(L.count/(L.freq*L.per));
        return `<div class="mrow" style="align-items:flex-start"><div class="th pimg i-${L.box}"></div><div class="n"><b>${esc(L.use)}</b> <span class="pill ${mode==='refill'?'g':'p'}">${mode==='refill'?'补药':'新建'}</span><small>${esc(L.name)} · ${esc(L.spec)}</small>
          <small>${mode==='refill'?`同一种药，只补余量：${daysLeft(L.key)} 天 → ${Math.floor((S.stock[L.key].count+L.count)/S.stock[L.key].perDay)} 天`:`每天 ${L.freq} 次 · ${esc(L.timing)} · ${L.times.map(fmt).join(' / ')} · 够吃 ${days} 天`}</small>
          ${low.length&&mode!=='refill'?`<label class="sw" style="font-size:11.5px;margin-top:4px;color:#8a5a10"><input type="checkbox" data-ok="${L.key}" ${st.ok[L.key]?'checked':''}><span class="s"></span>「${low.includes('timing')?'什么时候吃':'每天几次'}」看不清，默认${esc(L.timing)}，我核对过了</label>`:''}</div></div>`;}).join('')+
        `<button class="sbtn" id="bSave">全部建档</button><div class="hint">提醒先由小信用家人语气播报，你随时可以在日程里补录自己的原声。</div>`;
    }else h=st.done;
    set('整袋药 · 一键建档',h,bind);
  };
  function bind(b){
    if(st.step===0){(async()=>{const ag=b.querySelector('#bAg');tool('med');
      for(const t of ['照片质量检测','找到 3 个药盒','逐盒识别药名 / 规格 / 用法','和奶奶现有用药比对：1 盒是补药，2 盒新建']){const d=document.createElement('div');d.textContent=t;ag.appendChild(d);await sleep(450);d.className='ok';}
      await sleep(300);st.step=1;render();})();}
    else if(st.step===1){
      const its=items(),btn=b.querySelector('#bSave');
      const upd=()=>btn.disabled=its.some(({L,mode,low})=>low.length&&mode!=='refill'&&!st.ok[L.key]);
      b.querySelectorAll('[data-ok]').forEach(x=>x.onchange=()=>{st.ok[x.dataset.ok]=x.checked;upd();});upd();
      btn.onclick=()=>{
        const out=[];
        its.forEach(({L,mode})=>{
          if(mode==='refill'){S.stock[L.key].count+=L.count;S.stock[L.key].warned=false;S.feed.forEach(x=>{if(x.btns&&x.btns.some(bb=>bb[2]==='scan:'+L.key))x.closed=true;});out.push(`${L.use}补到 ${daysLeft(L.key)} 天`);}
          else{const f={use:L.use,timing:L.timing,per:L.per,unit:L.unit,look:L.look};
            const made=L.times.map((t,i)=>({id:'m'+uid(),grp:L.key,name:L.name,dose:`${L.spec.split('×')[0].trim()} × ${L.per} ${L.unit}`,use:L.use+(L.times.length>1?`（${['早','晚','午'][i]}）`:''),time:t,box:L.box,per:L.per,unit:L.unit,timing:L.timing,look:L.look,voice:medLine(f),dh:true}));
            S.meds.push(...made);S.stock[L.key]={count:L.count,perDay:L.freq*L.per,spec:L.spec};out.push(`${L.use} ${L.times.map(fmt).join(' / ')}`);}
        });
        tool('record','notify');
        log('health','子女·整袋药建档','Agent · 用药管理：一张照片识别 3 盒 → '+esc(out.join('；'))+'；提醒先由小信播报',{rules:['H2'],kv:'<span class="g">零填表：拍一张，核对一下就建好</span>'});
        pushFeed('💊','整袋药已建档',out.join('；'),'home',false);
        st.done=`<div style="text-align:center;padding:8px 0"><div class="pimg i-box_bag" style="width:150px;height:100px;border-radius:12px;margin:0 auto 8px"></div><div style="font:800 17px var(--sans)">3 盒药都记好了</div></div><div class="box">${out.map(o=>`<div class="row"><span class="n">${esc(o)}</span></div>`).join('')}</div><button class="sbtn" data-close="1">完成</button>`;
        st.step=2;gstep('batch');renderApp();render();
      };
    }else b.querySelectorAll('[data-close]').forEach(x=>x.onclick=()=>closeModal());
  }
  render();
}
function sheetMed(set){
  const pre=S.modal&&S.modal.grp?MED_LIB.findIndex(x=>x.key===S.modal.grp):1;
  const st={step:0,pick:Math.max(0,pre),blur:false,src:null,f:null,rec:false,dh:false,mode:'new'};
  const L=()=>MED_LIB[st.pick];
  const STEPS=['拍药盒','识别','核对','相框预览','完成'];
  const head=()=>`<div class="wzt">${STEPS.map((n,i)=>`<span style="${i===st.step?'color:#a8737e':''}">${n}</span>`).join('')}</div><div class="wz">${STEPS.map((n,i)=>`<span class="${i<=st.step?'on':''}"></span>`).join('')}</div>`;
  const shotDiv=(cls='')=>st.src?`<div class="shot ${cls}" style="background-image:url(${st.src})"></div>`:`<div class="shot pimg i-${L().box} ${cls}" style="background-position:center"></div>`;
  const render=()=>{
    let h=head();
    if(st.step===0){
      h+=`<div class="vf">${shotDiv(st.blur?'blur':'')}${st.blur?'<div class="glare"></div>':''}<span class="cn a"></span><span class="cn b"></span><span class="cn c"></span><span class="cn d"></span><div class="tipv">把药盒正面放进框里，药名和「用法用量」都要拍到</div></div>
        <div class="smp">${MED_LIB.map((m,i)=>`<div class="s1 pimg i-${m.box} ${!st.src&&!st.blur&&st.pick===i?'on':''}" data-i="${i}"><em>${m.use}</em></div>`).join('')}<div class="s1 pimg i-box_bag" data-bag="1"><em>整袋药</em></div><div class="s1 pimg i-box_amlo ${st.blur?'on':''}" data-blur="1" style="filter:blur(1.5px) brightness(1.2)"><em>反光示例</em></div></div>
        <div style="display:flex;--cl-gap:8px;margin-top:10px"><button class="sbtn" style="margin:0;flex:2" id="wShot">📷 拍照</button><label class="sbtn" style="margin:0;flex:1;background:#fff;color:#7a6a6d;border-color:#d6c6bd;text-align:center;cursor:pointer">🖼 相册<input type="file" accept="image/*" hidden id="wFile"></label></div>
        <div class="hint">演示：点下面的示例当作镜头里的药盒；也可以从相册上传自己的药盒照片。</div>`;
    }else if(st.step===1){
      h+=`<div class="vf">${shotDiv()}<div class="scanl"></div></div><div class="agl" id="wAg"></div>`;
    }else if(st.step===2){
      const f=st.f,low=k=>L().conf[k]<.8;
      const cf=k=>`<span class="cf">${low(k)?'请核对':'✓ '+Math.round(L().conf[k]*100)+'%'}</span>`;
      h+=`<div class="vf" style="height:150px">${shotDiv()}${L().ocr.map(([x,y,w,hh,t])=>`<div class="ob" style="left:${x}%;top:${y}%;width:${w}%;height:${hh}%"><i>${t}</i></div>`).join('')}</div>
        ${st.src?'<div class="note2 wa">这是你上传的照片：演示里按示例药品填入识别结果，请逐项核对。</div>':''}
        ${st.mode==='refill'?`<div class="note2 ok">✓ 识别为奶奶正在吃的「${esc(f.name)}」：这是新的一盒。确认后只补充余量，不重复建提醒。</div>`:''}
        ${st.mode==='dup'?`<div class="note2 wa">⚠ 奶奶已经在吃一种${esc(f.use)}。新增同类药前，请向医生确认是不是换药或加药；Agent 不判断能否同时吃。</div>`:''}
        <div class="box" style="margin-top:8px">
          <div class="fl"><label>药名</label><input class="tin" id="fName" value="${esc(f.name)}">${cf('name')}</div>
          <div class="fl"><label>规格</label><input class="tin" id="fSpec" value="${esc(f.spec)}">${cf('spec')}</div>
          <div class="fl"><label>通俗叫法</label><input class="tin" id="fUse" value="${esc(f.use)}"><span class="cf" style="color:var(--ink3)">给奶奶听</span></div>
          ${st.mode==='refill'?'':`<div class="fl ${low('freq')?'low':''}"><label>每天</label><div class="sg" id="fFreq">${[1,2,3].map(n=>`<button class="${f.freq===n?'on':''}" data-n="${n}">${n} 次</button>`).join('')}</div>${cf('freq')}</div>
          <div class="fl"><label>每次</label><div class="sg" id="fPer">${[1,2].map(n=>`<button class="${f.per===n?'on':''}" data-n="${n}">${n} ${f.unit}</button>`).join('')}</div></div>
          <div class="fl ${low('timing')?'low':''}"><label>什么时候</label><div class="sg" id="fTim">${['饭前','随餐','早饭后','睡前'].map(n=>`<button class="${f.timing===n?'on':''}" data-n="${n}">${n}</button>`).join('')}</div>${cf('timing')}</div>
          <div class="fl"><label>提醒时间</label><div class="sg" id="fTimes">${f.times.map((t,i)=>`<input type="time" class="tin" style="width:92px" data-i="${i}" value="${fmt(t)}">`).join('')}</div></div>
          <div class="fl"><label>药长啥样</label><input class="tin" id="fLook" value="${esc(f.look)}"><span class="cf" style="color:var(--ink3)">帮奶奶认药</span></div>`}
          <div class="fl"><label>这盒数量</label><input class="tin" id="fCount" type="number" style="width:70px" value="${f.count}"> ${f.unit} <span style="font-size:11.5px;color:var(--ink2)">→ ${st.mode==='refill'?`余量从 ${daysLeft(L().key)} 天补到 <b>${Math.floor((S.stock[L().key].count+f.count)/S.stock[L().key].perDay)}</b> 天`:`够吃 <b>${Math.floor(f.count/(f.freq*f.per))}</b> 天`}</span></div>
        </div>
        ${!st.mode.match(/refill/)&&f.times.some(t=>S.meds.some(m=>m.time===t))?`<div class="note2 ok">同一时间还有别的药，相框会合并成一次亮灯，按顺序播报。</div>`:''}
        ${['timing','freq'].some(low)&&st.mode!=='refill'?`<label class="sw" style="margin-top:8px;font-size:12px"><input type="checkbox" id="fOk"><span class="s"></span>标黄的项我已对照药盒 / 医嘱核对过</label>`:''}
        <button class="sbtn" id="wNext">${st.mode==='refill'?'确认补药':'下一步：看看奶奶那边'}</button>`;
    }else if(st.step===3){
      const f=st.f,line=b2();
      h+=`<div class="lbl2">到点时，奶奶的相框会这样提醒（亮灯、弹窗并主动说，可在设置里关）</div>
        <div class="mini"><div class="ms pimg i-${S.photos[S.cur].src?'':PHOTOS[S.photos[S.cur].key].img}" style="${S.photos[S.cur].src?`background-image:url(${S.photos[S.cur].src})`:''}"><div class="mb2"><div class="bimg pimg ${st.src?'':'i-'+L().box}" style="${st.src?`background-image:url(${st.src})`:''}"></div><div><b>“${esc(line)}”</b><small>认准：${esc(f.look)} · 每次 ${f.per} ${f.unit} · ${esc(f.timing)}</small></div></div></div><div class="lit"></div></div>
        <div class="lbl2">叮嘱的话（可改）</div><input class="tin" id="fVoice" value="${esc(line)}">
        <div style="display:flex;--cl-gap:8px;margin-top:8px"><button class="hold" id="wHold" style="flex:2">🎙 按住录叮嘱（原声优先）</button><button class="gbtn" id="wTry" style="flex:1">▶ 试听</button></div>
        <label class="sw" style="margin-top:8px;font-size:12px"><input type="checkbox" id="wDh" ${st.dh?'checked':''}><span class="s"></span>没空录？由数字人小信用家人语气播报</label>
        <button class="sbtn" id="wSave" ${st.rec||st.dh?'':'disabled'}>保存，建档</button>`;
    }else{
      h+=st.done;
    }
    set('扫药盒 · 建档',h,bind);
  };
  const b2=()=>{const f=st.f;return `奶奶，该吃${f.use}了，${f.timing==='随餐'?'吃饭的时候':f.timing==='睡前'?'睡觉前':f.timing==='饭前'?'吃饭前':'吃完早饭'}吃 ${f.per===1?'一':'两'}${f.unit}，${f.look.replace(/片$/,'的那种').replace(/胶囊$/,'胶囊那种')}。`;};
  const startRecog=async b=>{
    const ag=b.querySelector('#wAg');const steps=['照片质量检测','文字识别（药名 / 规格 / 用法用量）','药品库匹配',`说明书用法抽取`,'与奶奶现有用药比对'];
    tool('med');
    for(let i=0;i<steps.length;i++){const d=document.createElement('div');d.textContent=steps[i];ag.appendChild(d);await sleep(420);
      if(i===0&&st.blur){d.className='wa';d.textContent='照片反光，药名看不清 —— 请换个角度，避开灯光重拍';
        const bt=document.createElement('button');bt.className='sbtn';bt.textContent='重拍';bt.onclick=()=>{st.step=0;st.blur=false;render();};ag.appendChild(bt);
        log('warn','Agent · 用药管理','药盒照片反光，质量检测未通过 → 提示子女重拍，不做猜测识别');return;}
      d.className='ok';
      if(i===2) d.textContent+=`：${L().name}`;
      if(i===4){const ex=S.meds.find(m=>m.grp===L().key),same=S.meds.find(m=>m.use===L().use&&m.grp!==L().key);
        st.mode=ex?'refill':same?'dup':'new';d.className=st.mode==='dup'?'wa':'ok';
        d.textContent+=st.mode==='refill'?'：奶奶已在吃，识别为补药':st.mode==='dup'?'：已有同类药，需向医生确认':'：没有重复';}
    }
    const m=L();st.f={name:m.name,spec:m.spec,use:m.use,freq:m.freq,per:m.per,unit:m.unit,timing:m.timing,times:m.times.slice(),look:m.look,count:m.count};
    await sleep(300);st.step=2;render();
  };
  function bind(b){
    if(st.step===0){
      b.querySelectorAll('.s1').forEach(el=>el.onclick=()=>{if(el.dataset.bag){openModal('batch');return;}st.src=null;if(el.dataset.blur){st.blur=true;st.pick=0;}else{st.blur=false;st.pick=+el.dataset.i;}render();});
      b.querySelector('#wShot').onclick=()=>{st.step=1;render();};
      b.querySelector('#wFile').onchange=e=>{const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=()=>{st.src=r.result;st.blur=false;st.step=1;render();};Promise.resolve(window.CareLinkCompress?CareLinkCompress(f):f).then(v=>r.readAsDataURL(v)).catch(e=>atoast(e.message));};
    }else if(st.step===1){startRecog(b);}
    else if(st.step===2){
      const f=st.f;
      const grab=()=>{f.name=b.querySelector('#fName').value;f.spec=b.querySelector('#fSpec').value;f.use=b.querySelector('#fUse').value;f.count=+b.querySelector('#fCount').value||0;
        if(b.querySelector('#fLook'))f.look=b.querySelector('#fLook').value;
        b.querySelectorAll('#fTimes input').forEach(x=>{const[hh,mm]=x.value.split(':').map(Number);f.times[+x.dataset.i]=hh*60+mm;});};
      const seg=(id,fn)=>{const el=b.querySelector(id);if(el)el.querySelectorAll('button').forEach(x=>x.onclick=()=>{grab();fn(x.dataset.n);render();});};
      seg('#fFreq',n=>{f.freq=+n;const base=[[8*60],[8*60,18*60],[8*60,12*60,18*60]][f.freq-1];f.times=base.slice();});
      seg('#fPer',n=>f.per=+n);seg('#fTim',n=>f.timing=n);
      b.querySelector('#fCount').oninput=()=>{grab();};
      b.querySelector('#fCount').onchange=()=>{grab();render();};
      const ok=b.querySelector('#fOk'),nx=b.querySelector('#wNext');
      if(ok){nx.disabled=true;ok.onchange=()=>nx.disabled=!ok.checked;}
      nx.onclick=()=>{grab();
        if(st.mode==='refill'){const g=L().key;S.stock[g].count+=f.count;S.stock[g].warned=false;tool('med','record');
          log('health','子女·补药',`Agent · 用药管理：新药盒「${esc(f.name)}」${f.count}${f.unit} 计入余量，现够吃 ${daysLeft(g)} 天`);
          pushFeed('📦',`${f.use}已补充`,`现在够吃 ${daysLeft(g)} 天`,'home',false);
          S.feed.forEach(x=>{if(x.btns&&x.btns.some(bb=>bb[2]==='scan:'+g))x.closed=true;});
          st.done=`<div style="text-align:center;padding:10px 0"><div style="font-size:40px">📦</div><div style="font:800 17px var(--serif);color:#6b5558;margin:6px 0">已补充余量</div><div style="font-size:13px;color:var(--ink2)">${esc(f.use)} 现在够吃 <b>${daysLeft(g)}</b> 天，提醒时间不变。</div></div><button class="sbtn" data-close="1">完成</button>`;
          st.step=4;renderApp();gstep('refill');render();return;}
        st.step=3;render();};
    }else if(st.step===3){
      const f=st.f;
      holdBtn(b.querySelector('#wHold'),()=>{st.rec=true;b.querySelector('#wSave').disabled=false;});
      b.querySelector('#wDh').onchange=e=>{st.dh=e.target.checked;b.querySelector('#wSave').disabled=!(st.rec||st.dh);};
      b.querySelector('#wTry').onclick=()=>say(b.querySelector('#fVoice').value);
      b.querySelector('#wSave').onclick=()=>{
        const voice=b.querySelector('#fVoice').value,dh=!st.rec&&st.dh,g=L().key;
        const names=f.times.length>1?['早','晚','中'].slice(0,f.times.length):[''];
        const made=f.times.map((t,i)=>({id:'m'+uid(),grp:g,name:f.name,dose:`${f.spec.split('×')[0].trim()} × ${f.per} ${f.unit}`,use:f.use+(f.times.length>1?`（${['早','晚','午'][i]}）`:''),time:t,box:st.src?null:L().box,boxSrc:st.src,per:f.per,unit:f.unit,timing:f.timing,look:f.look,voice,dh}));
        S.meds.push(...made);S.stock[g]={count:f.count,perDay:f.freq*f.per,spec:f.spec};
        tool('med','record','notify');
        log('health','子女·扫药盒建档',`Agent · 用药管理：${esc(f.name)}，每天 ${f.freq} 次 · 每次 ${f.per}${f.unit} · ${esc(f.timing)}；提醒 ${f.times.map(fmt).join(' / ')}；${dh?'数字人小信播报':'小宇原声叮嘱'}；够吃 ${daysLeft(g)} 天`,{rules:dh?['H2']:['H2','R3'],kv:`<span class="g">相框提醒带药盒照片 + 「${esc(f.look)}」帮奶奶认药</span><span>剩 5 天时提醒小宇补药</span>`});
        pushFeed('💊','已建档并设好提醒',`${f.use} · ${f.times.map(fmt).join(' / ')} · 够吃 ${daysLeft(g)} 天`,'home',false);
        st.done=`<div style="text-align:center;padding:6px 0 4px"><div class="pimg ${st.src?'':'i-'+L().box}" style="width:120px;height:90px;border-radius:12px;margin:0 auto;border:2px solid #e0d2c8;${st.src?`background-image:url(${st.src})`:''}"></div><div style="font:800 17px var(--serif);color:#6b5558;margin:8px 0 4px">已建档 · ${esc(f.use)}</div></div>
          <div class="box"><div class="row"><span class="n">每天提醒<small>${f.times.map(fmt).join(' / ')} · 相框亮灯、弹窗并主动提醒</small></span></div><div class="row"><span class="n">谁来说<small>${dh?'数字人小信（家人语气，标注 AI 合成）':'小宇的原声'}</small></span></div><div class="row"><span class="n">帮奶奶认药<small>提醒时相框显示药盒照片 + 「${esc(f.look)}」</small></span></div><div class="row"><span class="n">余量<small>够吃 ${daysLeft(g)} 天，剩 5 天时提醒你补药</small></span></div></div>
          <div style="display:flex;--cl-gap:8px"><button class="sbtn" style="flex:1;background:#fff;color:#7a6a6d;border-color:#d6c6bd" data-rescan="1">再扫一盒</button><button class="sbtn" style="flex:1" data-close="1">完成</button></div>`;
        st.step=4;renderApp();if(dh)gstep('dhmed');gstep('scanned');render();
        made.filter(m=>m.time<=S.clock&&m.time>S.clock-60).forEach(m=>fireReminders([m]));
      };
    }else{
      b.querySelectorAll('[data-close]').forEach(x=>x.onclick=()=>closeModal());
      const rs=b.querySelector('[data-rescan]');if(rs)rs.onclick=()=>{Object.assign(st,{step:0,src:null,blur:false,rec:false,dh:false,mode:'new'});render();};
    }
  }
  render();
}
function sheetReport(set){
  set('拍体检报告',`<div class="scan">📄 对准体检报告…</div><button class="sbtn" id="rShot">拍照并解读</button><div class="hint">完整解读只推给你；奶奶的相框不会出现任何指标和告警。</div>`,b=>{
    b.querySelector('#rShot').onclick=async()=>{
      closeModal();const t0=S.clock;
      tool('report');const el=log('health','子女·体检报告','收到体检报告照片 3 页 → Agent · 报告解析',{rules:['H3']});
      await runSteps(el,['多模态识别','指标结构化','比对参考范围','检索知识库','生成通俗解读','护栏校验：不输出疾病结论'],400);tool('record','risk');
      el.insertAdjacentHTML('beforeend',`<div class="kv">${REPORT.inds.filter(i=>i.up).map(i=>`<span class="r">${esc(i.k)} ${esc(i.v)}</span>`).join('')}<span>不输出疾病结论</span></div>`);
      S.reports.unshift({t:t0});S.health++;
      pushFeed('📄','体检报告解读好了',`${REPORT.inds.filter(i=>i.up).length} 项需要关注 · 附复查建议`,'health',true);
      ribT(false,'📄 体检报告解读好了','4 项需关注 · 点开看通俗解读');
      gstep('report');renderQueues();renderApp();
    };
  });
}
function sheetTip(set,line){
  set('说给奶奶听',`<div class="lbl2">你想对奶奶说（可改）</div><textarea class="tin" id="tTxt" rows="3" style="resize:none">${esc(line)}</textarea>
    <div class="lbl2">谁来说</div><button class="hold" id="tHold">🎙 按住录我的声音（原声优先）</button>
    <div style="display:flex;--cl-gap:8px;margin-top:10px"><button class="sbtn" style="margin:0;flex:1;background:#fff;color:var(--vi);border:1px solid var(--line)" id="tDh">让小信念给奶奶</button><button class="sbtn" style="margin:0;flex:1" id="tSend" disabled>发我的原声</button></div>
    <div class="hint">相框只亮灯，奶奶按「听」才播；只说一句能照做的话，指标和风险分析不会出现在相框上。</div>`,b=>{
    const v=()=>b.querySelector('#tTxt').value.trim()||line;
    const clear=()=>{const i=document.getElementById('sayIn');if(i)i.value='';};
    holdBtn(b.querySelector('#tHold'),()=>{b.querySelector('#tSend').disabled=false;});
    b.querySelector('#tSend').onclick=()=>{const t=v();clear();closeModal();deliverTip(t,'小宇的原声 · 建议');};
    b.querySelector('#tDh').onclick=()=>{const t=v();clear();closeModal();deliverTip(t,'健康管家 小信 · 代小宇转达');};
  });
}

/* ================= app events ================= */
$('#app').addEventListener('click',e=>{
  const go=e.target.closest('[data-go]');
  const fa=e.target.closest('[data-fa]');
  const a=e.target.closest('[data-a]');
  if(fa){faction(fa);return;}
  if(a){const k=a.dataset.a;if(k==='say'){const iv=document.getElementById('sayIn');openModal('tip',{line:(iv&&iv.value.trim())||'奶奶，今天天气好，下午出去晒晒太阳，走慢一点。'});return;}openModal({photo:'photo',med:'med',report:'reportShot'}[k]);return;}
  const md=e.target.closest('[data-modal]');if(md){openModal(md.dataset.modal);return;}
  const cfb=e.target.closest('[data-cf]');if(cfb){S.careF=cfb.dataset.cf;renderApp();return;}
  const wb=e.target.closest('[data-who]');if(wb){S.who=wb.dataset.who;if(wb.dataset.go)S.scr=wb.dataset.go;if(S.who==='xiaoyu')gstep('me');renderApp();const pg=document.querySelector('#scrHost .page');if(pg)pg.scrollTop=0;return;}
  if(e.target.closest('[data-addfam]')){atoast('演示：发邀请给爸爸、小敏，他们各自管理自己的档案');return;}
  if(e.target.closest('[data-addrep]')){atoast('演示：拍你自己的体检报告，只存进你的档案');return;}
  const ms=e.target.closest('[data-mseg]');if(ms){S.mseg=ms.dataset.mseg;if(S.mseg==='rel')gstep('rel');renderApp();return;}
  const md2=e.target.closest('[data-meddet]');if(md2){openModal('meddet',{key:md2.dataset.meddet});return;}
  if(go){
    // 旧入口统一映射到 5 个标签
    let to=go.dataset.go;const pt0=go.dataset.ptab,ct0=go.dataset.ctab;
    const MAP={check:'meds',table:'health',profile:'mem',family:'me',care:'home'};
    if(to==='feed'){openModal('feed');return;}
    if(to==='check'&&ct0==='weekly'){S.scr='meds';openModal('weekly');return;}
    if(to==='check'&&ct0==='report'){openModal('report');return;}
    if(to==='profile'){if(pt0==='health')to='health';else if(pt0==='intro')to='me';else{S.mseg=pt0==='rel'?'rel':'bio';}}
    S.scr=MAP[to]||to;
    if(S.scr==='mem'){S.badges.mem=0;if(S.mseg==='rel')gstep('rel');}
    if(S.scr==='health'){S.badges.health=0;gstep('table');}
    if(S.scr==='meds')gstep('check');
    $('#pBodyTop')&&0;
    renderApp();const pg=document.querySelector('#scrHost .page');if(pg)pg.scrollTop=0;return;}
  const pt=e.target.closest('[data-ptab]');if(pt){S.ptab=pt.dataset.ptab;if(S.ptab==='bio'||S.ptab==='rel'){S.badges.mem=0;gstep('rel');}renderApp();return;}
  const ct=e.target.closest('[data-ctab]');if(ct){S.ctab=ct.dataset.ctab;if(S.ctab==='weekly')gstep('week');if(S.ctab==='report')gstep('rtab');renderApp();return;}
  const ml=e.target.closest('[data-meal]');if(ml){S.meal=ml.dataset.meal;renderApp();return;}
  const ps=e.target.closest('[data-person]');if(ps){if(ps.dataset.person==='grandma'){S.scr='profile';renderApp();}else openModal('person',{key:ps.dataset.person});return;}
  if(e.target.closest('#ribT')){$('#ribT').classList.remove('show');if(S.feed[0]&&S.feed[0].emg)openModal('emg',{text:S.feed[0].desc.replace(/[“”]/g,''),kw:S.feed[0].title.replace(/.*「|」.*/g,''),id:''});else openModal('feed');return;}
});
function faction(fa){
  const [k,v]=fa.dataset.fa.split(/:(.*)/);
  const f=S.feed.find(x=>x.id===fa.dataset.fid);
  if(k==='tip'||k==='tipv'){const tp=S.tips[v];if(!tp){atoast('先让奶奶说说吃了什么');return;}
    S.feed.forEach(x=>{if(x.tip===v)x.closed=true;});if(f)f.closed=true;
    if(k==='tip'){openModal('tip',{line:(tp.line+(tp.plain?' '+tp.plain:''))});}else{closeModal();deliverTip((tp.line+(tp.plain?' '+tp.plain:'')),'健康管家 小信 · 数字人播报');}return;}
  if(k==='scan'){openModal('med',{grp:v});return;}
  if(k==='shot'){openModal('shot');return;}
  if(k==='wt'){const i=document.getElementById('wtIn');const val=parseFloat(i&&i.value);if(!val||val<30||val>250){atoast('输入一个合理的体重（kg）');return;}
    if(S.me.todayW)S.me.weights[S.me.weights.length-1]=val;else{S.me.weights.push(val);S.me.todayW=true;}
    tool('record');log('health','子女·自己的档案','小宇记录体重 '+val+' kg');atoast('已记录 '+val+' kg');gstep('wt');renderApp();return;}
  if(k==='fx'){const bad=v==='肚子一直很疼';S.me.fx.push({w:'今天',t:v+(bad?' → 已提醒：持续腹痛请尽快就医':''),bad});tool('record');
    if(bad){tool('risk');log('warn','安全护栏','小宇记录「肚子一直很疼」→ 提醒尽快就医，不给用药建议',{rules:['G1']});atoast('持续腹痛请尽快就医，别等下次复诊');}else atoast('已记下，复诊时给医生看');renderApp();return;}
  if(k==='cheer'){const w=S.me.weights,dd=w[w.length-2]-w[w.length-1];
    openModal('tip',{line:dd>0?'奶奶，我这周也坚持打针、少吃夜宵了，体重又轻了'+Math.round(dd*2)+'斤。您也按时吃药，咱俩一起加油！':'奶奶，我这周也在坚持管住嘴、迈开腿。您也按时吃药，咱俩一起加油！'});return;}
  if(k==='voice'){const mm=S.meds.find(x=>x.id===v);if(mm){say(mm.voice);atoast('▶ '+(mm.dh?'小信':'小宇原声')+'：'+mm.voice.slice(0,14)+'…');}return;}
  if(k==='tgldh'){const mm=S.meds.find(x=>x.id===v);if(mm){mm.dh=!mm.dh;atoast(mm.dh?'改由小信用家人语气播报':'改成你的原声，记得补录一句');log('health','子女·改提醒',(mm.dh?'改由数字人小信播报：':'改为小宇原声：')+esc(mm.use),{rules:['H2']});renderApp();}return;}
  if(k==='remind'){const mm=S.meds.find(x=>x.id===v);if(mm){delete S.today[mm.id];closeModal();fireReminders([mm]);atoast('相框已亮灯，等奶奶按「听」');}return;}
  if(k==='call'){atoast('📞 正在呼叫奶奶的手机…');if(f)f.closed=true;S.feed.forEach(x=>{if(x.btns&&x.btns.some(b=>b[2]==='call'))x.closed=true;});log('','子女·打电话','小宇决定给奶奶打电话（由子女判断，不由相框催促）',{rules:['H5']});if(S.modal&&S.modal.type==='emg')closeModal();}
  else if(k==='120') atoast('如有危险请立即拨打 120；相框不承诺急救能力');
  else if(k==='audio'){atoast('▶ 播放奶奶原音频');say((f&&f.desc.replace(/[“”]/g,''))||(S.modal&&S.modal.text)||S.lastSaid);}
  else if(k==='say'){say(v);atoast('▶ 奶奶原声');}
  else if(k==='confirm'){if(v)v.split(',').forEach(id=>{if(S.today[id]){S.today[id].status='ok';S.today[id].at=S.clock;}});if(f)f.closed=true;atoast('已手动确认：奶奶已服药');log('health','子女·确认','小宇听完原音频，手动把「待确认」改为已服药');}
  else if(k==='dismiss'){if(f)f.closed=true;}
  else if(k==='export') atoast('已生成加密健康档案导出文件');
  else if(k==='del'){if(confirm('演示：确定删除全部健康数据？')){S.diet=[];S.symp=[];S.reports=[];S.today={};S.health=0;atoast('健康数据已删除');renderQueues();}}
  else if(k==='addcal') atoast('已加到日历：3 个月后复查血脂、血糖');
  if(S.modal&&S.modal.type==='feed'){renderModal();}
  renderApp();
}
$('#app').addEventListener('change',e=>{
  if(e.target.dataset.vis){S.visible[e.target.dataset.vis]=e.target.checked;atoast(e.target.checked?'已授权查看健康档案':'已取消健康档案权限');S.modal.keep=true;renderApp();S.modal.keep=false;}
  if(e.target.id==='setMerge') S.mergeRemind=e.target.checked;
  if(e.target.id==='setPopup') S.remindPopup=e.target.checked;
  if(e.target.id==='setVoice') S.remindVoice=e.target.checked;
  if(e.target.id==='setXX'){S.xx.on=e.target.checked;if(!S.xx.on)S.xx.open=false;xxRender();atoast(S.xx.on?'小信回来啦，在屏幕边上陪着你':'小信浮窗已关闭');}
  if(e.target.id==='setTo'){S.timeoutMin=+e.target.value;atoast(`超过 ${S.timeoutMin} 分钟无回应时通知你`);}
});
$('#mask').onclick=closeModal;$('#mX').onclick=closeModal;

/* ================= frame & operator events ================= */
$('#kG').onclick=onGreen;$('#kR').onclick=onRed;
document.addEventListener('keydown',e=>{if(/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName))return;if(e.key==='g'||e.key==='G')onGreen();if(e.key==='r'||e.key==='R')onRed();});
function renderChips(){$('#uChips').innerHTML=UTTER.map((u,i)=>`<button class="chip ${$('#uText').value===u.t?'on':''}" data-i="${i}">${esc(u.t.length>16?u.t.slice(0,16)+'…':u.t)}</button>`).join('');}
$('#uChips').onclick=e=>{const c=e.target.closest('.chip');if(!c)return;$('#uText').value=UTTER[+c.dataset.i].t;renderChips();};
$('#uText').oninput=renderChips;
$('#swOnline').onchange=e=>{S.online=e.target.checked;log(S.online?'':'warn','相框状态',S.online?'相框重新联网':'相框断网（演示）');renderFrame();renderApp();gstep(S.online?'online':'offline');if(S.online)flushQueues();};

/* ================= clock ================= */
function renderClock(){$('#clk').textContent=fmt(S.clock);$('#fClk').textContent=fmt(S.clock);$('#pClk').textContent=fmt(S.clock);}
if(!window.CareLinkProductMode)setInterval(tick,1000);
$('#clkPlay').onclick=()=>{S.running=!S.running;$('#clkPlay').textContent=S.running?'▶ 走':'⏸ 停';$('#clkPlay').classList.toggle('on',S.running);};
$('#clkSpeed').onclick=()=>{S.speed=S.speed===1?5:1;$('#clkSpeed').textContent=S.speed+'×';$('#clkSpeed').classList.toggle('on',S.speed>1);};
$('#clkNext').onclick=()=>{const nx=S.meds.filter(m=>!S.today[m.id]&&m.time>S.clock).sort((a,b)=>a.time-b.time)[0];if(!nx){atoast('今天没有待触发的提醒了');return;}S.clock=nx.time-1;renderClock();renderApp();};
$('#sndBtn').onclick=()=>{S.sound=!S.sound;$('#sndBtn').textContent=S.sound?'🔊 声音开':'🔇 声音关';if(!S.sound)hush();};
$('#resetBtn').onclick=()=>reset();

/* ================= scenarios ================= */
const SCEN=[
  {id:'med',n:'① 早 8 点用药闭环',s:'H1 H2 H4',setup(){S.clock=7*60+58;S.utter=UTTER[0].t;},
    steps:[['lit','等 08:00，相框亮灯 + 提示音（不播报、不换图）'],['green','按绿键「听」小宇的叮嘱'],['red1','按红键「说」'],['red2','再按红键结束'],['medok','手机收到「奶奶已服药」'],['check','底部「用药」看今天的服药']]},
  {id:'mem',n:'② 发照片·讲往事',s:'记忆闭环',setup(){S.clock=10*60;S.utter=UTTER[1].t;},
    steps:[['sent','首页「发照片」，选西湖老照片，按住录语音后发送'],['green','相框亮红点不换图，按绿键听'],['red2','按红键讲往事，再按结束'],['card','手机首页出现新传记卡'],['rel','底部「回忆 › 族谱」里多出了姑奶奶']]},
  {id:'mix',n:'③ 一句话双分流',s:'H7',setup(){S.clock=12*60+40;S.utter=UTTER[2].t;},
    steps:[['red1','直接按红键开始讲'],['red2','再按红键结束'],['h7','云端同时生成传记卡 + 饮食 + 不适'],['table','底部「健康」看今天吃了什么']]},
  {id:'report',n:'④ 体检报告解读',s:'H3',setup(){S.clock=19*60;},
    steps:[['report','首页「拍报告」→ 拍照并解读'],['rtab','首页「需要你处理」或底部「健康」点体检报告；相框上没有任何指标'],['tipsent','点「让小信转达」，把一句建议送到相框'],['tipheard','相框亮灯，奶奶按绿键听到']]},
  {id:'emg',n:'⑤ 紧急关键词',s:'H6 H3',setup(){S.clock=15*60+20;S.utter=UTTER[4].t;},
    steps:[['red1','按红键开始讲'],['red2','再按红键结束'],['emg','跳过排队，小宇手机弹出紧急窗；相框只显示「已告诉小宇」']]},
  {id:'timeout',n:'⑥ 没回应提醒',s:'H5',setup(){S.clock=7*60+58;S.speed=5;},
    steps:[['lit','到点亮灯，这次不要按任何键'],['timeout','30 分钟后小宇收到通知，由他决定是否打电话']]},
  {id:'offline',n:'⑦ 离线排队补发',s:'R4',setup(){S.clock=7*60+57;S.online=false;S.utter=UTTER[0].t;},
    steps:[['sent','相框已离线；手机发一张照片'],['online','过了 08:00 后，打开「相框在线」'],['lit','上线后补亮灯 + 红点，再按绿/红键完成闭环']]},
  {id:'unclear',n:'⑧ 识别不清',s:'待确认',setup(){S.clock=7*60+59;S.utter=UTTER[6].t;$('#swUnclear').checked=true;},
    steps:[['green','08:00 亮灯后按绿键听'],['red2','按红键说一段含糊的话，再按结束'],['unclear','不让奶奶重说，原音频给小宇，记录标「待确认」']]},
  {id:'merge',n:'⑨ 多条提醒合并',s:'H1',setup(){S.clock=7*60+59;S.meds.push({id:'m3',grp:'vitd',name:'维生素 D 软胶囊',dose:'1 粒',use:'维生素D',time:8*60,box:'box_vitd',per:1,unit:'粒',timing:'早饭后',look:'黄色透明小软胶囊',voice:'奶奶，顺便把维生素 D 也吃了，黄色那粒。'});S.stock.vitd={count:40,perDay:1,spec:'400 单位 × 60 粒'};S.utter=UTTER[3].t;},
    steps:[['lit','08:00 两条提醒合并成一次亮灯'],['green','按绿键，按时间顺序连续播放两条叮嘱'],['red2','按红键说，再按结束'],['medok','两条药同时确认，头晕推给小宇并生成一句建议']]},
  {id:'tip',n:'⑩ 建议说给奶奶',s:'H3（新）',setup(){S.clock=12*60+30;S.utter=UTTER[7].t;},
    steps:[['red2','按红键说中午吃了什么，再按结束'],['tipgen','云端记饮食、对照体检，生成一句能照做的建议'],['table','底部「健康」：盐、油偏高，咸菜标红'],['tipsent','点「让小信转达」或「我录一句」'],['tipheard','相框亮灯，奶奶按绿键听到建议']]},
  {id:'praise',n:'⑪ 打卡·夸夸奶奶',s:'依从性',setup(){S.clock=20*60+30;S.today.m1={status:'ok',at:8*60+6};S.today.m2={status:'ok',at:20*60+4};},
    steps:[['check','底部「用药」看近 7 天'],['tipsent','点「让小信转达」送一句夸奖'],['tipheard','奶奶按绿键听到夸奖；她听不到分数']]},
  {id:'guard',n:'⑬ 护栏：问减药',s:'G1 安全护栏',setup(){S.clock=9*60+30;S.utter=UTTER[8].t;},
    steps:[['red1','按红键开始讲'],['red2','奶奶问「能不能少吃半片」，再按红键结束'],['guard','风险评估命中护栏，拦截剂量建议，推给小宇'],['tipsent','小宇点「让小信转达」'],['tipheard','奶奶按绿键，数字人小信说「这得问医生」']]},
  {id:'dh',n:'⑭ 数字人代播提醒',s:'H2 原声优先',setup(){S.clock=8*60+40;},
    steps:[['dhmed','首页「扫药盒」，在相框预览里勾选「由数字人小信播报」后保存'],['lit','到点相框亮灯'],['green','奶奶按绿键，数字人小信以家人语气提醒'],['red2','奶奶说「吃过了」，再按结束'],['medok','小宇收到回执']]},
  {id:'scan',n:'⑮ 扫药盒建档',s:'拍→识别→核对→预览',setup(){S.clock=17*60+50;},
    steps:[['scanned','首页「扫药盒」：选降糖药药盒拍照，核对后在相框预览里录一句或交给小信，保存'],['lit','18:00 到点，相框亮灯'],['green','奶奶按绿键：相框上出现药盒照片和「白色椭圆片」帮她认药'],['red2','奶奶说「吃过了」，再按结束'],['medok','小宇收到回执，余量自动扣减']]},
  {id:'refill',n:'⑯ 药快吃完·补药',s:'余量闭环',setup(){S.clock=10*60;},
    steps:[['refill','首页「需要你处理」→ 降压药只够 6 天 → 补药 → 扫新药盒，识别为同一种药，只补余量']]},
  {id:'cheat',n:'⑰ 想吃火锅·作弊码',s:'不亮红牌',setup(){S.clock=16*60+30;S.utter=UTTER.find(u=>u.k==='want').t;},
    steps:[['red2','按红键说「晚上想去吃火锅」，再按结束'],['cheat','小信不说不行，查了奶奶的药和体检，算出交换条件'],['tipheard','奶奶按绿键：「火锅照吃，清汤锅，多喝白开水」+ 白话原理']]},
  {id:'batch',n:'⑱ 整袋药一键建档',s:'不填表',setup(){S.clock=10*60;},
    steps:[['batch','首页「扫药盒」→ 选「整袋药」：一张照片认出 3 盒，补药 + 新建一键完成']]},
  {id:'me2',n:'⑲ 子女也建档·减重针',s:'分人档案',setup(){S.clock=20*60+10;},
    steps:[['me','底部「用药」，顶部切到「小宇」'],['shot','点「我打完了」：部位自动建议轮换'],['wt','记一下今天的体重，看趋势'],['tipsent','「让奶奶知道我也在坚持」→ 发到相框'],['tipheard','奶奶按绿键，听到孙子也在坚持']]},
  {id:'week',n:'⑫ 健康周报',s:'档案汇总',setup(){S.clock=21*60;S.scr='meds';S.modal={type:'weekly'};},
    steps:[['week','「用药 › 健康周报」：依从率、饮食、不适与 3 条可执行建议']]}
];
function renderScen(){$('#scen').innerHTML=`<button data-s="" class="${!S.scen?'on':''}"><b>自由体验</b><span>随便按、随便发</span></button>`+SCEN.map(s=>`<button data-s="${s.id}" class="${S.scen===s.id?'on':''}"><b>${s.n}</b><span>${s.s}</span></button>`).join('');}
$('#scen').onclick=e=>{const b=e.target.closest('button');if(!b)return;startScen(b.dataset.s||null);};
function startScen(id){
  reset(true);S.scen=id;S.gstep=0;
  const sc=SCEN.find(s=>s.id===id);
  if(sc){sc.setup();S.meds.forEach(m=>{if(m.time<S.clock-1&&!S.today[m.id])S.today[m.id]={status:'ok',at:m.time+6};});if(id==='week')gstep('week');$('#uText').value=S.utter;$('#swOnline').checked=S.online;log('','演示剧本',`开始：${sc.n.replace(/^[①-⑲]\s*/,'')}`);}
  $('#clkSpeed').textContent=S.speed+'×';$('#clkSpeed').classList.toggle('on',S.speed>1);
  renderScen();renderGuide();renderAll();
  if(id==='offline') log('warn','相框状态','相框断网（演示）');
}
function renderGuide(){
  const sc=SCEN.find(s=>s.id===S.scen);
  $('#guide').classList.toggle('hide',!sc);if(!sc)return;
  $('#gSteps').innerHTML=sc.steps.map(([k,t],i)=>`<li class="${i<S.gstep?'done':i===S.gstep?'cur':''}">${t}</li>`).join('');
}
function gstep(key){
  const sc=SCEN.find(s=>s.id===S.scen);if(!sc)return;
  const i=sc.steps.findIndex(([k],j)=>k===key&&j>=S.gstep);
  if(i>=0){S.gstep=i+1;renderGuide();}
}

/* ================= reset ================= */
function renderAll(){renderRules();renderTools();renderFrame();renderApp();renderQueues();renderClock();renderChips();fit();}
(()=>{const fab=$('#xxFab');let st=null;
  fab.addEventListener('pointerdown',e=>{if(e.target.closest('[data-xx]'))return;st={x:e.clientX,y:e.clientY,moved:false};try{fab.setPointerCapture(e.pointerId);}catch(_){}});
  fab.addEventListener('pointermove',e=>{if(!st)return;const dx=e.clientX-st.x,dy=e.clientY-st.y;if(!st.moved&&Math.hypot(dx,dy)<6)return;st.moved=true;fab.classList.add('drag');
    const r=$('#app').getBoundingClientRect(),k=r.width/390;const x=(e.clientX-r.left)/k-32,y=(e.clientY-r.top)/k-32;
    fab.style.left=Math.max(0,Math.min(326,x))+'px';fab.style.right='auto';S.xx.y=Math.max(90,Math.min(660,y));fab.style.top=S.xx.y+'px';});
  fab.addEventListener('pointerup',e=>{if(!st)return;fab.classList.remove('drag');
    if(st.moved){const r=$('#app').getBoundingClientRect(),k=r.width/390;S.xx.side=(e.clientX-r.left)/k<195?'left':'right';xxRender();}else xxOpen();st=null;});
  $('#app').addEventListener('click',e=>{
    const x=e.target.closest('[data-xx]');
    if(x){const k=x.dataset.xx;if(k==='off')xxOff();else if(k==='min'){S.xx.open=false;xxRender();}else if(k==='send'){const i=$('#xxInp');xxAsk(i.value);i.value='';}return;}
    const qb=e.target.closest('[data-xxq]');if(qb){xxAsk(qb.dataset.xxq);return;}
    const tb=e.target.closest('[data-xxtip]');if(tb){S.xx.open=false;xxRender();openModal('tip',{line:tb.dataset.xxtip});return;}
    if(e.target.closest('.xxAct')){S.xx.open=false;xxRender();}
  });
  $('#xxInp').addEventListener('keydown',e=>{if(e.key==='Enter'){xxAsk(e.target.value);e.target.value='';}});
})();
function reset(silent){
  stopPlay();clearInterval(recTick);
  const keepSound=S?S.sound:true,keepXX=S&&S.xx?S.xx.on:true;
  S=freshState();S.sound=keepSound;S.xx={on:keepXX,open:false,msgs:[],side:'right',y:560,greeted:false};
  $('#log').innerHTML='';$('#uText').value=S.utter;$('#swOnline').checked=true;$('#swUnclear').checked=false;
  $('#clkPlay').textContent='▶ 走';$('#clkPlay').classList.add('on');$('#clkSpeed').textContent='1×';$('#clkSpeed').classList.remove('on');
  $('#fPhoto').dataset.pid='';$('#modal').dataset.cur='';$('#ribT').classList.remove('show');$('#atoast').classList.remove('show');
  if(!silent){log('','系统','演示已重置：今天 07:55，奶奶的相框正显示「阳台的花」');renderScen();renderGuide();}
  renderAll();
}

/* ================= plan view ================= */


window.CareLinkPrototype={state:()=>S,setState:v=>{S=v;},render:()=>renderAll(),analyze,utterances:UTTER,scenarios:SCEN.map(x=>({id:x.id,name:x.n,steps:x.steps})),photos:PHOTOS,medications:MED_LIB,report:REPORT,
 reset:()=>reset(true),scenario:startScen,tick,process:processUtter,sendPhoto,deliverTip,fireReminders,flushQueues,listen:onGreen,stop:stopPlay,
 openModal,closeModal,toast:atoast,frameToast,playClip,
 install(o){if(o.green)onGreen=o.green;if(o.red)onRed=o.red;if(o.clip)playClip=o.clip;if(o.hold)holdBtn=o.hold;if(o.sendPhoto)sendPhoto=o.sendPhoto;if(o.tip)deliverTip=o.tip;if(o.say)say=o.say;if(o.hush)hush=o.hush;if(o.faction)faction=o.faction;if(o.xxAsk)xxAsk=o.xxAsk;},
 faction:fa=>faction(fa),originalFaction:faction,
 xxExp,xxReply,xxPush,xxGreet,chime,photoHTML,daysLeft,fmt, renderApp:()=>renderApp(),setRenderHook(fn){const prior=renderApp;renderApp=()=>{prior();fn();};},
 markStep:gstep,clock:renderClock,fit};
if(window.__CARELINK_HEADLESS__){
 renderRules=renderTools=renderFrame=renderApp=renderQueues=renderClock=renderChips=renderScen=renderGuide=fit=renderModal=xxRender=xxMsgs=xxBubble=()=>{};
 chime=say=hush=atoast=ribT=frameToast=()=>{};
 runSteps=async()=>{};
}

S=null;reset();
})();
