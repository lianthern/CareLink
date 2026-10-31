'use strict';
const EMERGENCY=Object.freeze(['胸口疼','胸口闷','摔了','摔倒','摔了一跤','喘不上气','喘不过气','晕倒','说不出话','半边麻','出血']);
const normalized=s=>String(s||'').normalize('NFKC').replace(/[\s，。！？、,.!?…]/g,'');
function emergencies(text){const t=normalized(text);return EMERGENCY.filter(w=>t.includes(w));}
function medicalBoundary(text){const t=normalized(text);return /诊断|确诊|治疗|开药|处方|什么病|得了.{0,8}病|是不是.{0,8}(病|炎|癌|中风)|换药|调药|停药|断药|加药|减药|药量|剂量|少吃半片|多吃.{0,4}片|减半|加倍|半粒|毫克|\d+mg/i.test(t)||/(药|片|粒).{0,18}(少吃|多吃|减|停|换|加|改|不吃)|(?:少吃|多吃|减|停|换|加|不吃).{0,12}(药|片|粒)/.test(t);}
function medication(text){const t=normalized(text);if(/还没吃|没吃药|忘了吃|不想吃药|没吃呢/.test(t))return 'not_taken';if(/吃过了|吃了药|药吃了|已经吃了|吃过药|刚吃了|吃好了|吃完了/.test(t))return 'taken';return 'none';}
const elderPolicy=Object.freeze({textInput:false,confirmationDialog:false,showAlert:false});
function photoArrival(photo){if(!photo||typeof photo.audioRef!=='string'||!photo.audioRef.trim())throw Error('PHOTO_VOICE_REQUIRED');return {redDot:true,changePhoto:false,autoPlay:false,light:false,chime:false};}
function playback(plan){return plan.voiceRef?{source:'child',audioRef:plan.voiceRef,synthetic:false}:{source:'assistant',text:plan.reminderText||'到用药时间了，请按家人确认的用药计划服药。',synthetic:true,label:'AI 合成内容'};}
function reminderGroups(plans,date,now){
 const groups=new Map();
 for(const p of plans.filter(p=>p.status==='active'))for(const time of p.times){const k=date+'T'+time;if(!groups.has(k))groups.set(k,{slot:k,plans:[],light:true,chime:true,autoPlay:false,changePhoto:false,createdAt:now});groups.get(k).plans.push(p);}
 return [...groups.values()].sort((a,b)=>a.slot.localeCompare(b.slot));
}
function timeout(dose,now,timeoutMs){if(!Number.isFinite(timeoutMs)||timeoutMs<=0)throw Error('INVALID_TIMEOUT');return dose.status==='pending'&&!dose.notified&&now-dose.dueAt>=timeoutMs?Object.assign({},dose,{status:'missed',notified:true}):null;}
function orderTransfers(rows){return rows.filter(r=>r.status==='queued').map((r,i)=>({r,i})).sort((a,b)=>Number(b.r.urgent)-Number(a.r.urgent)||a.r.createdAt-b.r.createdAt||a.i-b.i).map(x=>x.r);}
function guardReply({text,classification,approvedTip=null}){
 if(medicalBoundary(text)||classification.medicalRequest||medicalBoundary(classification.answer))return {text:'请咨询医生，不要自行调整用药。',reason:'G1'};
 const health=classification.foods.length||classification.symptoms.length||classification.foodWish;
 if(health){if(approvedTip&&approvedTip.reviewed===true&&typeof approvedTip.text==='string'&&!medicalBoundary(approvedTip.text)&&!/告警|警报|确诊/.test(approvedTip.text))return {text:approvedTip.text.slice(0,90),reason:'reviewed_tip'};return {text:'我记下了，家人可以查看这段记录。',reason:'no_reviewed_advice'};}
 if(/血压|血糖|诊断|患有|你有|您有|治疗|服用|用药|药物|病|癌|炎|瘤|症|中风|心脏|警报|告警|风险|指标|[一二两三四五六七八九十半0-9]+(片|粒|毫克|毫升)/.test(classification.answer))return {text:'请咨询医生。',reason:'G1'};
 const sentences=classification.answer.match(/[^。！？!?]+[。！？!?]?/g)||[];return {text:sentences.slice(0,2).join('').slice(0,90)||'我在，您说。',reason:'chat'};
}
function weeklySummary(doses,diet,discomfort){const total=doses.length,taken=doses.filter(d=>d.status==='taken').length;return {child:{total,taken,adherence:total?taken/total:null,foods:diet.reduce((all,d)=>all.concat(d.foods),[]),symptoms:discomfort.reduce((all,d)=>all.concat(d.symptoms),[])},elder:{text:'谢谢您和家人一起坚持记录。'}};}
module.exports={EMERGENCY,emergencies,medicalBoundary,medication,elderPolicy,photoArrival,playback,reminderGroups,timeout,orderTransfers,guardReply,weeklySummary};
