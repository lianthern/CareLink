// Local, explicit exports. Media is supplied through the caller's current-account reader;
// this module never follows a stored URL or publishes personal content.
import { wrapText } from './export-memory.js';

export const MOMENT_EXPORT_LIMITS = Object.freeze({ width: 1080, height: 2160, pages: 80,
  mediaBytes: 96 * 1024 * 1024, fileBytes: 16 * 1024 * 1024, photos: 100, voices: 100, text: 160000 });
const serif = '"Songti SC", "STSong", "Noto Serif CJK SC", serif';
const sans = '"PingFang SC", "Microsoft YaHei", sans-serif';
const fail = code => Object.assign(new Error(code), { code });
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const plain = value => typeof value === 'string' ? value : '';
const fileName = value => Array.from(value.normalize('NFC').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/gu, '').trim()).slice(0, 60).join('') || '回忆时刻';
const dateLabel = value => { const date = new Date(value); return Number.isFinite(date.valueOf()) ? new Intl.DateTimeFormat('zh-CN', {year:'numeric',month:'long',day:'numeric'}).format(date) : ''; };
export function describeExportError(error) { return ({export_empty:'还没有可导出的照片或原话。',export_too_large:'这段回忆内容较多，请分成几段后导出。',export_too_many_pages:'这段文字太长，请分成几段后导出；也可以保存 HTML 回忆档案。',export_media_too_large:'有一份素材超过 16 MB，请先使用较小的副本。',export_photo_type:'有一张照片暂不能导出，请使用 JPEG、PNG 或 WebP 副本。',export_audio_type:'有一段原声格式暂不支持归档。',export_media_unavailable:'有一份原素材没有读到，请重试，或先重新打开这段回忆。',export_fonts_timeout:'字体还没准备好，请稍后重试。',export_image_failed:'有一张照片暂时无法打开，请重试或换用较小的副本。',export_encode_failed:'图片没有生成成功，请重试；也可以保存 HTML 回忆档案。',export_timeout:'读取素材超时，请检查连接后重试。'}[error?.code] || '这次没有导出成功，原回忆仍然保留，请重试。'); }
function guard({ signal, isCurrent }) {
  signal?.throwIfAborted();
  if (isCurrent && !isCurrent()) throw new DOMException('Export cancelled', 'AbortError');
}
function bounded(promise, options, code = 'export_timeout', ms = 15000) {
  guard(options);
  return new Promise((resolve, reject) => {
    let timer;
    const stop = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
    const abort = () => { stop(); reject(options.signal.reason || new DOMException('Export cancelled', 'AbortError')); };
    options.signal?.addEventListener('abort', abort, { once:true });
    timer = setTimeout(() => { stop(); reject(fail(code)); }, ms);
    Promise.resolve(promise).then(value => { stop(); try { guard(options); resolve(value); } catch(error) { reject(error); } }, error => { stop(); reject(error); });
  });
}

export function momentExportSnapshot(moment) {
  if (!moment || typeof moment !== 'object') throw fail('export_empty');
  const photos = Array.isArray(moment.photos) ? moment.photos : [];
  const words = (Array.isArray(moment.messages) ? moment.messages : []).filter(m => m?.role === 'user')
    .map(m => ({ text:plain(m.text), ...(m.audio ? { audio:structuredClone(m.audio) } : {}) }));
  const title = plain(moment.title).trim() || '留住的这一刻';
  if (photos.length > MOMENT_EXPORT_LIMITS.photos || words.filter(m => m.audio).length > MOMENT_EXPORT_LIMITS.voices ||
      title.length + words.reduce((n,m) => n + m.text.length, 0) > MOMENT_EXPORT_LIMITS.text) throw fail('export_too_large');
  if (!photos.length && !words.some(m => m.text.trim() || m.audio)) throw fail('export_empty');
  return { title, date:dateLabel(moment.createdAt), photos:structuredClone(photos), words };
}

function validateBlob(blob, kind) {
  if (!(blob instanceof Blob) || !blob.size) throw fail('export_media_unavailable');
  if (blob.size > MOMENT_EXPORT_LIMITS.fileBytes) throw fail('export_media_too_large');
  // SVG/HTML are deliberately not embedded, even when a misleading filename was supplied.
  const mime = blob.type.split(';')[0].toLowerCase();
  const allowed = kind === 'photo' ? ['image/jpeg','image/png','image/webp'] :
    ['audio/wav','audio/x-wav','audio/wave','audio/webm','audio/ogg','audio/mp4','audio/mpeg','audio/aac'];
  if (!allowed.includes(mime)) throw fail(kind === 'photo' ? 'export_photo_type' : 'export_audio_type');
}
async function collect(snapshot, options) {
  const media = { photos:[], voices:[] }; let bytes = 0, current = 0;
  const count = snapshot.photos.length + (options.format === 'html' ? snapshot.words.filter(m => m.audio).length : 0);
  const read = async (ref, kind) => {
    guard(options);
    const blob = await bounded(Promise.resolve().then(() => options.readMedia(ref, {kind,signal:options.signal})), options);
    validateBlob(blob, kind); bytes += blob.size;
    if (bytes > MOMENT_EXPORT_LIMITS.mediaBytes) throw fail('export_too_large');
    if(kind==='photo')photoDimensions(await bounded(blob.arrayBuffer(),options));
    options.onProgress?.({stage:'media',current:++current,total:count}); guard(options); return blob;
  };
  for (const photo of snapshot.photos) media.photos.push(await read(photo, 'photo'));
  if (options.format === 'html') for (const message of snapshot.words) if (message.audio) media.voices.push(await read(message.audio, 'audio'));
  return media;
}

async function dataUrl(blob, options) {
  const bytes = new Uint8Array(await bounded(blob.arrayBuffer(), options));
  const chunks=[];
  for (let index=0; index<bytes.length; index+=32768) { guard(options); chunks.push(String.fromCharCode(...bytes.subarray(index,index+32768))); }
  return `data:${blob.type.split(';')[0].toLowerCase()};base64,${btoa(chunks.join(''))}`;
}
const archiveStyle = `*{box-sizing:border-box}body{margin:0;background:#f7f3f4;color:#473b4b;font:17px/1.95 ${serif};overflow-wrap:anywhere}main{max-width:860px;margin:0 auto;padding:44px 24px 64px;background:linear-gradient(160deg,#edf3fb 0,#fffafb 38%,#fff8ef)}header{border-bottom:1px solid #d8c3a0;padding:0 0 24px;margin-bottom:28px}small,figcaption,footer{font:13px/1.7 ${sans};color:#796f7f}h1{font-weight:500;font-size:clamp(30px,6vw,48px);line-height:1.35;margin:12px 0}h2{font-weight:500;font-size:22px}figure{margin:0 0 28px;padding:12px;background:#fff;border:1px solid #dfcdaa;border-radius:12px}img{display:block;width:100%;height:auto;object-fit:contain}figcaption{margin-top:10px}article{white-space:pre-wrap;background:#fffafc;border-left:3px solid #dcc1d1;padding:16px 20px;margin:16px 0}audio{display:block;width:100%;margin:12px 0}footer{border-top:1px solid #d8c3a0;margin-top:36px;padding-top:18px}@media print{body,main{background:#fff}main{max-width:none;padding:12mm}figure,article{break-inside:avoid}audio{display:none}}`;
async function renderArchive(snapshot, media, options) {
  const figures=[];
  for (const [index,blob] of media.photos.entries()) figures.push(`<figure><img src="${await dataUrl(blob,options)}" alt="第 ${index+1} 张回忆照片"><figcaption>第 ${index+1} 张照片 · 完整画面</figcaption></figure>`);
  let voice=0; const words=[];
  for (const message of snapshot.words) {
    const audio=message.audio ? `<audio controls preload="metadata" src="${await dataUrl(media.voices[voice++],options)}"></audio>` : '';
    if(message.text || audio) words.push(`<article>${escape(message.text)}${audio}</article>`);
  }
  guard(options);
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escape(snapshot.title)}</title><style>${archiveStyle}</style><main><header><small>回忆时刻 · 留下的照片与原话</small><h1>${escape(snapshot.title)}</h1><small>${escape(snapshot.date)}</small></header>${figures.join('')}${words.length?'<h2>我想留下的话</h2>'+words.join(''):''}<footer>照片、原话${voice?'与原声':''}已保存在这份文件里，可离线打开。${voice?'原声也可在播放器中保存；能否播放取决于浏览器对原录音格式的支持。':''}</footer></main></html>`;
  return [{ name:`${fileName(snapshot.title)}.html`, blob:new Blob([html],{type:'text/html;charset=utf-8'}) }];
}

// Pure layout uses the same grapheme-safe wrapping as the existing exporter, but splits at a
// bounded page height. Nothing is cropped or silently truncated when text crosses a page.
function exportLines(context, text, width) {
  if(globalThis.Intl?.Segmenter)return wrapText(context,text,width);
  const lines=[];
  for(const paragraph of text.split('\n')){
    const clusters=[];
    for(const character of Array.from(paragraph)){
      const previous=clusters.at(-1),regional=/^[\u{1f1e6}-\u{1f1ff}]$/u;
      if(previous&&(/^[\p{Mark}\uFE0E\uFE0F\u{1F3FB}-\u{1F3FF}\u200D]$/u.test(character)||previous.endsWith('\u200D')||(regional.test(previous)&&regional.test(character))))clusters[clusters.length-1]+=character;
      else clusters.push(character);
    }
    let line='';for(const cluster of clusters){if(line&&context.measureText(line+cluster).width>width){lines.push(line);line=cluster;}else line+=cluster;}lines.push(line);
  }
  return lines;
}
export function layoutMomentExport(snapshot, sizes, context) {
  const width=MOMENT_EXPORT_LIMITS.width, height=MOMENT_EXPORT_LIMITS.height, padding=64, content=width-2*padding;
  const pages=[];let page, cursor;
  const newPage=()=> { if(pages.length>=MOMENT_EXPORT_LIMITS.pages)throw fail('export_too_many_pages');page=[];pages.push(page);cursor=106; };
  const room=n=>{if(cursor+n>height-100)newPage();};
  const lines=(text,font,lineHeight,color,gap=24)=>{
    context.font=font;
    // Treat every Unicode line separator as a real paragraph boundary.
    for(const line of exportLines(context,text.replace(/\r\n?|\u2028|\u2029/gu,'\n'),content)){room(lineHeight);page.push({kind:'text',text:line,x:padding,y:cursor,font,color});cursor+=lineHeight;}
    cursor+=gap;
  };
  newPage();lines(snapshot.title,`500 52px ${serif}`,72,'#473b4b',12);
  if(snapshot.date)lines(snapshot.date,`24px ${sans}`,38,'#877585',30);
  for(const [index,size] of sizes.entries()){
    const scaled=Math.min(content/size.width,1120/size.height),w=size.width*scaled,h=size.height*scaled;
    room(h+82);page.push({kind:'image',index,x:(width-w)/2,y:cursor,width:w,height:h});cursor+=h+18;
    lines(`第 ${index+1} 张照片`, `22px ${sans}`,34,'#877585',30);
  }
  const words=snapshot.words.filter(m=>m.text || m.audio);
  if(words.length){room(114);lines('我想留下的话',`500 32px ${serif}`,48,'#9e748b',18);}
  for(const message of words){if(message.text)lines(message.text,`32px ${serif}`,54,'#473b4b',30);if(message.audio)lines('原声可随 HTML 回忆档案一起保存',`22px ${sans}`,36,'#877585',22);}
  return pages.map((commands,index)=>({width,height:Math.min(height,Math.max(600,Math.ceil((commands.at(-1)?.y||cursor)+(commands.at(-1)?.height||90)+100))),index,commands}));
}

export function photoDimensions(bytes) {
  const b=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes),v=new DataView(b.buffer,b.byteOffset,b.byteLength);
  let width,height;
  if(b.length>=24&&b[0]===137&&b[1]===80&&b[2]===78&&b[3]===71){width=v.getUint32(16);height=v.getUint32(20);}
  else if(b.length>=30&&String.fromCharCode(...b.subarray(0,4))==='RIFF'&&String.fromCharCode(...b.subarray(8,12))==='WEBP'){
    const format=String.fromCharCode(...b.subarray(12,16));
    if(format==='VP8X'){width=1+b[24]+(b[25]<<8)+(b[26]<<16);height=1+b[27]+(b[28]<<8)+(b[29]<<16);}
    if(format==='VP8 '&&b[23]===157&&b[24]===1&&b[25]===42){width=v.getUint16(26,true)&16383;height=v.getUint16(28,true)&16383;}
    if(format==='VP8L'&&b[20]===47){const bits=v.getUint32(21,true);width=(bits&16383)+1;height=((bits>>>14)&16383)+1;}
  } else if(b.length>=4&&b[0]===255&&b[1]===216){
    for(let p=2;p+8<b.length;){if(b[p++]!==255)break;while(b[p]===255)p++;const marker=b[p++];if(marker===217||marker===218)break;if(marker===1||(marker>=208&&marker<=215))continue;const size=v.getUint16(p);if(size<2||p+size>b.length)break;if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){height=v.getUint16(p+3);width=v.getUint16(p+5);break;}p+=size;}
  }
  if(!width||!height||width>32768||height>32768||width*height>128*1024*1024||Math.max(width/height,height/width)>1120)throw fail('export_image_failed');
  return {width,height};
}
async function decodePhoto(blob, options) {
  guard(options);
  const dimensions=photoDimensions(await bounded(blob.arrayBuffer(),options));
  if(typeof createImageBitmap === 'function') {
    // One resize dimension preserves the decoder's EXIF orientation and aspect ratio. A
    // conservative bound fits both possible orientations without decoding a huge bitmap.
    const ratio=dimensions.width/dimensions.height;
    const resizeWidth=Math.max(1,Math.floor(Math.min(952,1120*Math.min(ratio,1/ratio),dimensions.width)));
    const task=createImageBitmap(blob,{resizeWidth,resizeQuality:'high'});
    let accepting=true;
    // A late decoder must release its allocation after cancellation, too.
    task.then(image=>{try{guard(options);if(!accepting)image.close();}catch{image.close();}},()=>{});
    try { const image=await bounded(task,options,'export_image_failed'); if(!image.width||!image.height) { image.close();throw fail('export_image_failed'); } return image; }
    catch(error){if(error.name==='AbortError')throw error;throw fail('export_image_failed');}
    finally{accepting=false;}
  }
  if(dimensions.width*dimensions.height>16*1024*1024)throw fail('export_image_failed');
  const url=URL.createObjectURL(blob), image=new Image();
  try { image.src=url;await bounded(image.decode(),options,'export_image_failed');if(!image.naturalWidth||!image.naturalHeight)throw fail('export_image_failed');return image; }
  catch(error){image.src='';throw error;}
  finally{URL.revokeObjectURL(url);}
}
const release = image => { if(image.close)image.close();else image.src=''; };
async function renderPng(snapshot,media,options) {
  if(typeof document==='undefined')throw fail('export_canvas_failed');
  if(document.fonts){await bounded(Promise.all([document.fonts.load(`32px ${serif}`),document.fonts.ready]),options,'export_fonts_timeout');}
  const canvas=document.createElement('canvas');canvas.width=MOMENT_EXPORT_LIMITS.width;canvas.height=10;
  let context=canvas.getContext('2d',{alpha:false});if(!context)throw fail('export_canvas_failed');
  const sizes=[];
  // Decode sequentially and immediately release. At most one photo plus one small canvas lives.
  for(const blob of media.photos){const image=await decodePhoto(blob,options);try{sizes.push({width:image.width||image.naturalWidth,height:image.height||image.naturalHeight});}finally{release(image);}}
  const pages=layoutMomentExport(snapshot,sizes,context),files=[];
  try {
    for(const [index,page] of pages.entries()){
      guard(options);canvas.width=page.width;canvas.height=page.height;context=canvas.getContext('2d',{alpha:false});
      const wash=context.createLinearGradient(0,0,page.width,page.height);wash.addColorStop(0,'#eaf1fa');wash.addColorStop(.4,'#fffafd');wash.addColorStop(1,'#fcf3ec');context.fillStyle=wash;context.fillRect(0,0,page.width,page.height);
      context.fillStyle='#9b8799';context.font=`21px ${sans}`;context.textBaseline='top';context.fillText('回忆时刻',64,42);
      for(const command of page.commands){
        guard(options);
        if(command.kind==='text'){context.font=command.font;context.fillStyle=command.color;context.fillText(command.text,command.x,command.y);}
        else{const image=await decodePhoto(media.photos[command.index],options);try{context.fillStyle='#d8c3a0';context.fillRect(command.x-8,command.y-8,command.width+16,command.height+16);context.drawImage(image,command.x,command.y,command.width,command.height);}finally{release(image);}}
      }
      context.fillStyle='#877585';context.font=`20px ${sans}`;context.fillText(`照片与我的原话 · ${index+1} / ${pages.length}`,64,page.height-48);
      const blob=await bounded(new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(fail('export_encode_failed')),'image/png')),options,'export_encode_failed');
      files.push({name:`${fileName(snapshot.title)}${pages.length>1?'-'+String(index+1).padStart(2,'0'):''}.png`,blob});
      options.onProgress?.({stage:'pages',current:index+1,total:pages.length});guard(options);
      await bounded(new Promise(resolve=>setTimeout(resolve,0)),options);
    }
  } finally{canvas.width=1;canvas.height=1;}
  return files;
}

export async function createMomentExport(options) {
  if(!['png','html'].includes(options?.format)||typeof options.readMedia!=='function')throw fail('export_options_invalid');
  guard(options);const snapshot=momentExportSnapshot(options.moment);const media=await collect(snapshot,options);
  const files=options.format==='html'?await renderArchive(snapshot,media,options):await renderPng(snapshot,media,options);
  guard(options);
  return {files,pageCount:files.length,photoCount:snapshot.photos.length,audioCount:snapshot.words.filter(m=>m.audio).length};
}
