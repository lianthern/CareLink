import { parseDepthImport } from './spatial-contract/import.js';
import { allowedRadiusForHeading } from './spatial-contract/math.js';
// Native App surface: versioned depth parsing and conservative display movement.
let threePromise;
function loadThree() {
  if (globalThis.THREE) return Promise.resolve(globalThis.THREE);
  if (threePromise) return threePromise;
  threePromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/unseen-dap/v1/vendor/three.min.js';
    const timer = setTimeout(() => { script.remove(); threePromise = null; reject(new Error('空间组件加载超时')); }, 12000);
    script.onload = () => { clearTimeout(timer); resolve(globalThis.THREE); };
    script.onerror = () => { clearTimeout(timer); script.remove(); threePromise = null; reject(new Error('空间组件加载失败')); };
    document.head.append(script);
  });
  return threePromise;
}

export function clampSpatialPosition(x, z, radius = 0.42) {
  const distance = Math.hypot(x, z);
  const limit = Math.max(0, Math.min(0.42, Number(radius) || 0));
  return distance > limit && distance > 0 ? { x: x / distance * limit, z: z / distance * limit } : { x, z };
}
const uvShader = `varying vec3 vDir;
uniform float yawOffset;
const float PI = 3.14159265359;
vec2 equirectUv(vec3 dir) {
 return vec2(fract(0.5 + (atan(dir.x, -dir.z) + yawOffset) / (2.0 * PI)), clamp(0.5 + asin(clamp(dir.y, -1.0, 1.0)) / PI, 0.0, 1.0));
}`;
const flatVertex = `${uvShader}
void main(){vec3 dir=normalize(position);vDir=dir;gl_Position=projectionMatrix*modelViewMatrix*vec4(dir*3.0,1.0);}`;
const depthVertex = `${uvShader}
uniform sampler2D depthMap; uniform vec2 depthTexel; uniform float depthRawMin; uniform float depthRawMax; uniform float depthScale; uniform float depthStrength;
float smoothDepth(vec2 uv) {
 vec2 d=depthTexel*4.0;
 float t=texture2D(depthMap,uv).r*0.24;
 t+=texture2D(depthMap,uv+vec2(d.x,0.0)).r*0.12;
 t+=texture2D(depthMap,uv+vec2(-d.x,0.0)).r*0.12;
 t+=texture2D(depthMap,uv+vec2(0.0,d.y)).r*0.12;
 t+=texture2D(depthMap,uv+vec2(0.0,-d.y)).r*0.12;
 t+=texture2D(depthMap,uv+vec2(d.x,d.y)).r*0.07;
 t+=texture2D(depthMap,uv+vec2(-d.x,d.y)).r*0.07;
 t+=texture2D(depthMap,uv+vec2(d.x,-d.y)).r*0.07;
 t+=texture2D(depthMap,uv+vec2(-d.x,-d.y)).r*0.07;
 return t;
}
void main(){ vec3 dir=normalize(position);vDir=dir;float rawDepth=mix(depthRawMin,depthRawMax,smoothDepth(equirectUv(dir)));float radius=mix(3.0,clamp(rawDepth*depthScale,1.8,6.0),depthStrength);gl_Position=projectionMatrix*modelViewMatrix*vec4(dir*radius,1.0);}`;
const fragment = `${uvShader}
uniform sampler2D panoMap;
void main(){vec3 dir=normalize(vDir);float u=0.5+(atan(dir.x,-dir.z)+yawOffset)/(2.0*PI);float v=clamp(0.5+asin(clamp(dir.y,-1.0,1.0))/PI,0.0,1.0);gl_FragColor=texture2D(panoMap,vec2(u,v));}`;

// One bounded request, including its body; navigating away cancels immediately.
export async function readSpatialResource(url, { signal, as = 'blob', onProgress = () => {}, timeoutMs = 60000, maxBytes = 64 * 1024 * 1024 } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  const limit = as === 'json' ? Math.min(maxBytes, 1024 * 1024) : maxBytes;
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`空间资源读取失败 (${response.status})`);
    if (Number(response.headers.get('content-length')) > limit) throw new Error('空间资源过大');
    const chunks = []; let bytes = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > limit) throw new Error('空间资源过大');
        chunks.push(value); onProgress(bytes);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const blob = new Blob(chunks, { type: response.headers.get('content-type') || '' });
    return as === 'json' ? JSON.parse(await blob.text()) : blob;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
}

export function mountAppSpatial(options) {
  const { container, kind = '360', world, onStatus = () => {}, onError = () => {}, signal } = options;
  if (!container) throw new Error('spatial_container_missing');
  let disposed = false;
  let cleanupRenderer = () => {};
  const controller = new AbortController();
  const cleanups = [];
  const textures = [];
  const stage = document.createElement('div'); stage.className = 'us-stage'; stage.tabIndex = 0;
  stage.setAttribute('role', 'region'); stage.setAttribute('aria-label', '空间画面，拖动环视');
  const status = document.createElement('p'); status.className = 'us-status'; status.setAttribute('role', 'status');
  const controls = document.createElement('div'); controls.className = 'us-controls';
  const shell = document.createElement('section'); shell.className = 'us-spatial'; const drawer=document.createElement('details');drawer.className='us-tool-drawer';const summary=document.createElement('summary');summary.textContent='观看工具 · 复位与探身';drawer.append(summary,controls);shell.append(stage,status,drawer);
  container.replaceChildren(shell);
  const setStatus = message => { if (!disposed) { status.textContent = message; onStatus(message); } };
  const destroy = () => {
    if (disposed) return;
    disposed = true; controller.abort(); cleanupRenderer(); cleanups.splice(0).forEach(fn => fn());
    textures.splice(0).forEach(texture => texture.dispose());
    shell.remove();
  };
  signal?.addEventListener('abort', destroy, { once: true });
  cleanups.push(() => signal?.removeEventListener('abort', destroy));
  if (signal?.aborted) destroy();
  function listen(target, type, callback, config) { target.addEventListener(type, callback, config); cleanups.push(() => target.removeEventListener(type, callback, config)); }
  listen(shell, 'keydown', event => { if (event.key === 'Escape' && options.onExit) { event.preventDefault(); options.onExit(); } });
  const getBytes = (url, as = 'blob') => readSpatialResource(url, {
    signal: controller.signal, as,
    onProgress: bytes => setStatus(`正在读取空间 · ${(bytes / 1048576).toFixed(1)} MB…`)
  });
  async function textureFrom(THREE, url) {
    const blob = await getBytes(url);
    if (disposed) throw new Error('cancelled');
    const objectUrl = URL.createObjectURL(blob);
    try {
      const image = new Image(); image.src = objectUrl; await image.decode();
      if (disposed) throw new Error('cancelled');
      const texture = new THREE.Texture(image); texture.needsUpdate = true;
      textures.push(texture);texture.userData ||= {}; texture.userData.sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(b=>b.toString(16).padStart(2,'0')).join('');
      texture.minFilter = THREE.LinearFilter; texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false; texture.wrapS = THREE.RepeatWrapping; texture.wrapT = THREE.ClampToEdgeWrapping;
      if(disposed){texture.dispose();throw new Error('cancelled');}return texture;
    } finally { URL.revokeObjectURL(objectUrl); }
  }
  async function start() {
    if (disposed) return;
    setStatus('正在载入空间…');
    if (kind === 'world') {
      const { mountWorldViewer } = await import('./world-viewer.js');
      if (disposed) return;
      const cleanup = await mountWorldViewer({ container: stage, world, onStatus: setStatus, controlsContainer: controls, signal:controller.signal });
      if (disposed) cleanup(); else cleanupRenderer = cleanup;
      await cleanup.ready;return;
    }
    if (!['360', 'dap'].includes(kind)) throw new Error('这种空间效果暂未接入');
    const panoramaSrc = options.panoramaSrc || options.panorama || options.src;
    if (!panoramaSrc) throw new Error('没有可查看的全景图');
    const THREE = await loadThree();
    if (disposed) return;
    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'low-power' });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
    stage.append(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(kind === 'dap' ? 75 : 64, 1, 0.05, 100);
    camera.position.set(0, 1.4, 0);
    let geometry; let material; let observer; let renderFrame;
    cleanupRenderer = () => { cancelAnimationFrame(renderFrame); renderer.setAnimationLoop(null); observer?.disconnect(); geometry?.dispose(); material?.dispose(); renderer.dispose(); renderer.forceContextLoss?.(); };
    const panoramaTexture = await textureFrom(THREE, panoramaSrc);
    let depthTexture, depthMeta, depthFailure;
    if (kind === 'dap') {
      try {
        const fixed = new URL(panoramaSrc, location.href).pathname === '/unseen-dap/v1/assets/ballroom.jpg';
        const depthSrc = options.depthSrc || options.depth || (fixed ? '/unseen-dap/v1/assets/ballroom-depth.png' : null);
        const metaSrc = options.depthMetaSrc || (fixed ? '/unseen-dap/v1/assets/ballroom-depth.json' : null);
        if (!depthSrc || !options.depthMetadata && !metaSrc) throw new Error('缺少配对的深度图或元数据');
        const metadata = options.depthMetadata || await getBytes(metaSrc, 'json');
        depthTexture = await textureFrom(THREE, depthSrc);
        depthMeta = parseDepthImport(metadata, { panorama: { width: panoramaTexture.image.naturalWidth, height: panoramaTexture.image.naturalHeight },
          depth: { width: depthTexture.image.naturalWidth, height: depthTexture.image.naturalHeight },
          panoramaSha256: panoramaTexture.userData.sha256, depthSha256: depthTexture.userData.sha256, panoramaName: options.panoramaName || decodeURIComponent(new URL(panoramaSrc, location.href).pathname.split('/').at(-1)) });
        if (fixed && depthMeta.encoding === 'legacy-dap-minmax-v1') { depthMeta.maxRadius = .42; depthMeta.scale = 100; }

      } catch (error) {
        if (disposed) return;
        depthMeta = null; depthTexture = null; depthFailure = error.message;
      }
    }
    if (disposed) return;
    const hasDepth = !!depthMeta && !!depthTexture;
    geometry = new THREE.SphereGeometry(1, hasDepth ? 256 : 96, hasDepth ? 128 : 64);
    const uniforms = { panoMap: { value: panoramaTexture }, yawOffset: { value: Math.PI } };
    if (hasDepth) Object.assign(uniforms, { depthMap: { value: depthTexture }, depthTexel: { value: new THREE.Vector2(1 / depthMeta.width, 1 / depthMeta.height) }, depthRawMin: { value: depthMeta.near }, depthRawMax: { value: depthMeta.far }, depthScale: { value: depthMeta.scale }, depthStrength: { value: depthMeta.strength } });
    material = new THREE.ShaderMaterial({ uniforms, vertexShader: hasDepth ? depthVertex : flatVertex, fragmentShader: fragment, side: THREE.BackSide });
    const mesh = new THREE.Mesh(geometry, material); mesh.position.y = 1.4; mesh.frustumCulled = false; scene.add(mesh);
    shell.dataset.mode = hasDepth ? 'limited-parallax' : 'rotation360';
    let yaw = -(Number(options.initialYaw) || 0) * Math.PI / 180;
    let pitch = (Number.isFinite(options.initialPitch) ? options.initialPitch : -14) * Math.PI / 180;
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    let reduced = media.matches, paused = false;
    const keys = new Set(); let drag = null; let lastFrame = 0;
    const euler = new THREE.Euler(0,0,0,'YXZ');
    const step = (code, distance = .04) => {
      if (!hasDepth || paused) return;
      const f = Number(code === 'KeyW') - Number(code === 'KeyS');
      const r = Number(code === 'KeyD') - Number(code === 'KeyA');
      const next = clampSpatialPosition(camera.position.x + (-Math.sin(yaw)*f + Math.cos(yaw)*r)*distance, camera.position.z + (-Math.cos(yaw)*f - Math.sin(yaw)*r)*distance, depthMeta.maxRadius);
      if (depthMeta.safetyEnvelope) { const limit = allowedRadiusForHeading(depthMeta.safetyEnvelope, Math.atan2(next.x, -next.z)*180/Math.PI); const safe = clampSpatialPosition(next.x, next.z, limit); next.x=safe.x;next.z=safe.z; }
      camera.position.x = next.x; camera.position.z = next.z;
    };
    const draw = time => {
      renderFrame = undefined;
      if (disposed || paused || document.hidden) return;
      const dt = Math.min(.05, (time - lastFrame) / 1000 || .016); lastFrame = time;
      if (!reduced) for (const code of keys) step(code, dt*.3);
      euler.set(pitch,yaw,0); camera.quaternion.setFromEuler(euler);
      renderer.render(scene,camera);
      stage.dataset.renderCount = String(Number(stage.dataset.renderCount || 0) + 1);
      stage.dataset.renderState = keys.size && !reduced ? 'moving' : 'idle';
      if (keys.size && !reduced) requestDraw();
    };
    const requestDraw = () => { if (renderFrame === undefined && !disposed && !paused && !document.hidden) renderFrame = requestAnimationFrame(draw); };
    const resize = () => { const width = Math.max(1, stage.clientWidth); const height = Math.max(1, stage.clientHeight); renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); requestDraw(); };
    observer = new ResizeObserver(resize); observer.observe(stage); resize();
    const clearInput = () => { keys.clear(); drag = null; };
    const changeMotion = () => { reduced = media.matches; clearInput(); shell.dataset.reducedMotion = String(reduced); requestDraw(); };
    listen(media, 'change', changeMotion); changeMotion();
    listen(stage, 'pointerdown', event => { if (event.button !== 0 || paused) return; stage.focus(); drag = { id: event.pointerId, x: event.clientX, y: event.clientY }; stage.setPointerCapture(event.pointerId); });
    listen(stage, 'pointermove', event => { if (paused || drag?.id !== event.pointerId) return; yaw -= (event.clientX - drag.x) * .0034; pitch = Math.max(-1.45, Math.min(1.45, pitch - (event.clientY - drag.y) * .0034)); drag.x = event.clientX; drag.y = event.clientY; requestDraw(); });
    for (const type of ['pointerup','pointercancel','lostpointercapture']) listen(stage, type, () => { drag = null; });
    const turn = code => { if(paused) return; yaw += code === 'ArrowLeft' ? .12 : code === 'ArrowRight' ? -.12 : 0; pitch = Math.max(-1.45, Math.min(1.45, pitch + (code === 'ArrowUp' ? .1 : code === 'ArrowDown' ? -.1 : 0))); requestDraw(); };
    listen(stage, 'keydown', event => {
      if (paused) return;
      if (['KeyW','KeyA','KeyS','KeyD'].includes(event.code) && hasDepth) { event.preventDefault(); if(reduced) { if(!event.repeat) step(event.code); } else keys.add(event.code); requestDraw(); }
      if (event.code.startsWith('Arrow')) { event.preventDefault(); if(!reduced || !event.repeat) turn(event.code); }
    });
    listen(stage, 'keyup', event => keys.delete(event.code));
    listen(stage, 'blur', clearInput); listen(window, 'blur', clearInput);
    listen(document, 'visibilitychange', () => { clearInput(); if(document.hidden) { cancelAnimationFrame(renderFrame); renderFrame=undefined; } else requestDraw(); });
    const button = (label, handler) => { const b = document.createElement('button'); b.type='button'; b.textContent=label; controls.append(b); listen(b,'click',handler); return b; };
    const pauseButton = button('停止画面', () => { paused = !paused; clearInput(); cancelAnimationFrame(renderFrame); renderFrame=undefined; pauseButton.textContent=paused?'继续环视':'停止画面'; stage.dataset.renderState=paused?'paused':'idle'; if(!paused) requestDraw(); });
    for(const [code,label] of [['ArrowLeft','向左看'],['ArrowRight','向右看'],['ArrowUp','向上看'],['ArrowDown','向下看']]) button(label,()=>turn(code));
    button('回到中心', () => { if(paused) return; camera.position.set(0,1.4,0); yaw=-(Number(options.initialYaw)||0)*Math.PI/180; pitch=(Number.isFinite(options.initialPitch)?options.initialPitch:-14)*Math.PI/180; requestDraw(); });
    if(hasDepth) for(const [code,label] of [['KeyW','向前探身'],['KeyS','向后探身'],['KeyA','向左探身'],['KeyD','向右探身']]) button(label,()=>{step(code);requestDraw();});
    const credit = document.createElement('p'); credit.className='us-credit';
    credit.textContent = options.authenticity || (kind==='dap' ? 'DAP 深度 · 受限视差预览，不能自由穿行，也不用于测量。' : '360° 环视 · 可用方向按钮或拖动画面');
    shell.append(credit);
    setStatus(hasDepth ? '拖动环视 · 按按钮轻轻探身' : kind==='dap' ? `深度未载入，已切换为 360° 环视；不能探身（${depthFailure}）` : '空间已载入 · 可用方向按钮或键盘环视');
    destroy.lookAt = (nextYaw, nextPitch = 0) => { yaw=-nextYaw*Math.PI/180; pitch=nextPitch*Math.PI/180; camera.position.set(0,1.4,0); paused=false; requestDraw(); };
    requestDraw();

  }
  destroy.ready = start().catch(error => {
    if (disposed) return;
    cleanupRenderer(); cleanupRenderer = () => {};
    setStatus(error.name === 'AbortError' ? '空间读取超时，可以返回原图后重试。' : `空间暂时打不开：${error.message}。可以返回原图。`);
    onError(error);
  });
  return destroy;
}
