// A small, independently navigable preview precedes the unchanged original SOG.
// Camera, photo anchors and collision geometry belong to the caller and never reset.
export async function loadProgressiveScene({pc,app,sceneAsset,resolveUrl,ui,setLoading,setSceneState}) {
  const started=performance.now();
  const status=document.createElement('div');
  status.className='stream-quality';status.setAttribute('role','status');
  const label=document.createElement('span');status.append(label);
  const retry=document.createElement('button');retry.type='button';retry.textContent='重试加载清晰画质';retry.hidden=true;status.append(retry);
  ui.viewport.append(status);
  const style=document.createElement('style');
  style.textContent='.stream-quality{position:absolute;left:50%;top:68px;transform:translateX(-50%);max-width:calc(100% - 32px);z-index:12;padding:8px 12px;border-radius:8px;background:rgba(21,31,31,.88);color:#fff;font:12px/1.5 system-ui,sans-serif;text-align:center;pointer-events:none}.stream-quality:empty{display:none}.stream-quality button{pointer-events:auto;display:block;margin:6px auto 0;padding:5px 8px;border:1px solid #b6cac4;border-radius:5px;background:transparent;color:inherit;font:inherit}.stream-quality button[hidden]{display:none}';
  document.head.append(style);
  const dispose=loaded=>{if(!loaded)return;loaded.entity.destroy();loaded.asset.unload();app.assets.remove(loaded.asset);};
  function load(url,progress) {
    const asset=new pc.Asset('UNSEEN progressive scene','gsplat',{url:resolveUrl(url)});
    app.assets.add(asset);
    return new Promise((resolve,reject)=>{
      asset.on('progress',progress);
      asset.once('error',error=>{asset.off('progress',progress);asset.unload();app.assets.remove(asset);reject(new Error(String(error)));});
      asset.once('load',()=>{
        asset.off('progress',progress);
        const entity=new pc.Entity('Scene Gaussian Splat');
        entity.setPosition(...(sceneAsset.position||[0,0,0]));
        entity.setEulerAngles(...(sceneAsset.rotationEuler||[0,0,0]));
        const scale=Number.isFinite(sceneAsset.scale)?sceneAsset.scale:1;
        entity.setLocalScale(scale,scale,scale);
        entity.addComponent('gsplat',{asset});app.root.addChild(entity);
        // The old preview remains visible until the new splats have been sorted
        // and rendered. Resolving the network request alone is insufficient.
        let frames=0,ready=false;
        const frameReady=(_camera,_layer,sorted,loading)=>{ready=sorted&&!loading;};
        const cleanup=()=>{app.off('postrender',rendered);app.systems.gsplat.off('frame:ready',frameReady);clearTimeout(timeout);};
        const rendered=()=>{
          if(!ready){frames=0;return;}
          if(++frames>=2){cleanup();resolve({entity,asset});}
        };
        const timeout=setTimeout(()=>{cleanup();dispose({entity,asset});reject(new Error('Scene rendering timed out'));},30000);
        app.systems.gsplat.on('frame:ready',frameReady);
        app.on('postrender',rendered);
      });
      app.assets.load(asset);
    });
  }
  const pct=(n,total)=>total?Math.min(100,Math.round(n/total*100))+'%':(n/1048576).toFixed(1)+' MB';
  let preview;
  try {
    setLoading('正在载入快速预览…');
    preview=await load(sceneAsset.previewUrl,(n,total)=>setLoading('正在载入快速预览 · '+pct(n,total)));
    ui.canvas.dataset.modelQuality='preview';ui.canvas.dataset.previewReadyMs=String(Math.round(performance.now()));
    ui.canvas.dataset.modelLoadMs=String(Math.round(performance.now()-started));
    setSceneState('ready','快速预览');label.textContent='已可漫游 · 正在补齐清晰画质';
  } catch(error) {
    console.warn('Quick preview unavailable; loading original model.',error);
    label.textContent='';setLoading('正在载入完整空间…');
    await load(sceneAsset.url,(n,total)=>setLoading('正在载入完整空间 · '+pct(n,total)));
    ui.canvas.dataset.modelQuality='full';ui.canvas.dataset.fullReadyMs=String(Math.round(performance.now()));
    ui.canvas.dataset.modelLoadMs=String(Math.round(performance.now()-started));
    setSceneState('ready','完整画质');status.remove();return true;
  }
  let upgrading=false;
  async function upgrade() {
    if(upgrading)return;upgrading=true;retry.hidden=true;
    label.textContent='已可漫游 · 正在补齐清晰画质';
    try {
      await load(sceneAsset.url,(n,total)=>{label.textContent='已可漫游 · 清晰画质 '+pct(n,total);});
      dispose(preview);preview=null;
      ui.canvas.dataset.modelQuality='full';ui.canvas.dataset.fullReadyMs=String(Math.round(performance.now()));
      setSceneState('ready','完整画质');label.textContent='完整画质已加载';
      setTimeout(()=>status.remove(),2500);
    } catch(error) {
      console.warn('Full-quality download failed; keeping the usable preview.',error);
      ui.canvas.dataset.modelQuality='preview-error';label.textContent='快速预览可继续漫游 · 清晰画质加载失败';retry.hidden=false;
    } finally {upgrading=false;}
  }
  retry.addEventListener('click',upgrade);
  // Give the caller time to enable controls and remove the blocking load panel.
  setTimeout(upgrade,100);
  return true;
}
