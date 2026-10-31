// The ordered pairs array is the only editable source of user words. Photo.pairs and
// top-level question/answer are derived compatibility projections, never write inputs.
export function normalizeContent(input = {}) {
 const photos=(input.photos||[]).map((photo,index)=>({...photo,id:photo.id||`photo:${index}`}));
 const ids=new Set(photos.map(photo=>photo.id));
 const mainPhotoId=ids.has(input.mainPhotoId)?input.mainPhotoId:photos[0]?.id;
 let source=Array.isArray(input.pairs)&&input.pairs.length?input.pairs:null;
 if(!source)source=photos.flatMap(photo=>(photo.pairs||[]).map(pair=>({...pair,photoId:photo.id})));
 if(!source.length && input.answer)source=[{question:input.question||'',answer:input.answer}];
 const pairs=source.map((pair,index)=>({...pair,id:pair.id||`pair:${index}`,photoId:ids.has(pair.photoId)?pair.photoId:mainPhotoId}));
 const active=pairs.find(pair=>pair.id===input.activePairId)
   || pairs.findLast(pair=>pair.question===input.question&&pair.answer===input.answer)
   || pairs.findLast(pair=>pair.photoId===mainPhotoId) || pairs.at(-1);
 return {...input,mainPhotoId,activePairId:active?.id||null,pairs,
  photos:photos.map(photo=>({...photo,pairs:pairs.filter(pair=>pair.photoId===photo.id).map(pair=>({...pair}))})),
  question:active?.question||'',answer:active?.answer||''};
}
export function commitAnswer(state,answer) {
 const index=!state.pendingNewAnswer&&Number.isInteger(state.activePairIndex)?state.activePairIndex:-1;
 const existing=index>=0?state.pairs[index]:null;
 const photoId=existing?.photoId||state.photo?.id||state.photos[0]?.id;
 const pair={...existing,id:existing?.id||`pair:${state.pairs.length}:${Date.now()}`,photoId,question:state.question,answer};
 if(existing)state.pairs[index]=pair;else{state.pairs.push(pair);state.activePairIndex=state.pairs.length-1;}
 state.pendingNewAnswer=false;state.activePairId=pair.id;state.answer=state.answerDraft=answer;state.saved=false;
 state.photos=normalizeContent({photos:state.photos,pairs:state.pairs,mainPhotoId:state.photo?.id,activePairId:pair.id}).photos;
 state.photo=state.photos.find(photo=>photo.id===state.photo?.id)||state.photos[0];
}
export function contentSnapshot(state){
 return normalizeContent({...state.originalMemory,syncBases:{...state.originalMemory?.syncBases},id:state.memoryId||undefined,photos:state.photos.length?state.photos:[state.photo],pairs:state.pairs,
  mainPhotoId:state.photo?.id,activePairId:state.activePairId||state.pairs[state.activePairIndex]?.id,
  title:state.title,pageAspect:state.pageAspect,styleId:state.styleId,resultShape:state.resultShape,createdAt:state.createdAt,
  capturedAt:state.originalMemory?.capturedAt||state.photo?.capturedAt,facts:state.visibleFacts,
  origin:state.questionStatus==='ready'?'unseen-demo-live:model':state.questionStatus==='degraded'?'unseen-demo-live:degraded':state.memoryOrigin||'unseen-demo-live:restored'});
}
export function bookPhotos(state){return normalizeContent({photos:state.photos,pairs:state.pairs,mainPhotoId:state.photo?.id}).photos;}
