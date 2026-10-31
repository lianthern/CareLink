import { readSpatialResource } from './unseen-app-spatial.js';
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";

function bestSplatUrl(world) {
  return world?.splats?.standard || world?.splats?.preview || world?.splats?.full || null;
}
export async function mountWorldViewer({ container, world, onStatus = () => {}, controlsContainer, signal }) {
  const splatUrl = bestSplatUrl(world);
  if (!container || !splatUrl) throw new Error("world_splat_missing");

  onStatus('正在读取 3D 空间…');
  const bytes=await readSpatialResource(splatUrl,{signal,timeoutMs:60000,maxBytes:48*1024*1024,onProgress:n=>onStatus(`正在读取 3D 空间 · ${(n/1048576).toFixed(1)} MB`)});
  if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 1.75));
  renderer.setClearColor(0x020202, 1);
  container.replaceChildren(renderer.domElement);
  container.tabIndex = 0;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 1, 0.01, 1200);
  camera.position.set(0, 1.4, 3);
  const spark = new SparkRenderer({ renderer });
  scene.add(spark);

  const controls = new OrbitControls(camera, renderer.domElement);
  const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = motionQuery.matches, paused = false, disposed = false, frame, settleFrames = 45;
  controls.enableDamping = !reduced;
  controls.dampingFactor = 0.075;
  controls.screenSpacePanning = true;
  controls.target.set(0, 1.2, 0);
  controls.minDistance = 0.03;
  controls.maxDistance = 300;

  let loaded = false;
  let worldRadius = 4;
  const splats = new SplatMesh({
    fileBytes: await bytes.arrayBuffer(),
    fileName: new URL(splatUrl,globalThis.location?.href||'https://local.invalid').pathname.split('/').at(-1),
    lod: true,
    onProgress(event) {
      if (!event?.lengthComputable) return onStatus("正在读取 3D 点云…");
      onStatus(`正在读取 3D 点云 · ${Math.round((event.loaded / event.total) * 100)}%`);
    },
    onLoad() {
      if(disposed)return;
      loaded = true;
      onStatus("空间已载入");
      settleFrames = 45; requestDraw();
    }
  });
  splats.quaternion.set(1, 0, 0, 0);
  splats.scale.setScalar(world?.semantics?.metricScaleFactor || 1);
  splats.position.y = world?.semantics?.groundPlaneOffset || 0;
  scene.add(splats);

  const pressed = new Set();
  const movementKeys = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight"]);
  const onKeyDown = (event) => {
    if (!movementKeys.has(event.code)) return;
    event.preventDefault();
    if(paused) return;
    if(reduced) { if(!event.repeat) { pressed.add(event.code); move(.06); pressed.clear(); } } else pressed.add(event.code);
    requestDraw();
  };
  const onKeyUp = (event) => pressed.delete(event.code);
  const onBlur = () => pressed.clear();
  container.addEventListener("keydown", onKeyDown);
  container.addEventListener("keyup", onKeyUp);
  container.addEventListener("blur", onBlur);

  const resize = () => {
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    requestDraw();
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);
  // Initial draw is scheduled after movement helpers are initialized.

  const clock = new THREE.Clock();
  const forward = new THREE.Vector3();
  const side = new THREE.Vector3();
  const deltaMove = new THREE.Vector3();
  function move(delta) {
    if (loaded && pressed.size) {
      camera.getWorldDirection(forward); forward.y=0;
      if(forward.lengthSq()<.001) forward.set(0,0,-1);
      forward.normalize(); side.crossVectors(forward,camera.up).normalize(); deltaMove.set(0,0,0);
      if(pressed.has('KeyW')||pressed.has('ArrowUp'))deltaMove.add(forward);
      if(pressed.has('KeyS')||pressed.has('ArrowDown'))deltaMove.sub(forward);
      if(pressed.has('KeyD')||pressed.has('ArrowRight'))deltaMove.add(side);
      if(pressed.has('KeyA')||pressed.has('ArrowLeft'))deltaMove.sub(side);
      if(deltaMove.lengthSq()){deltaMove.normalize().multiplyScalar(Math.max(.08,worldRadius*.24)*delta);camera.position.add(deltaMove);controls.target.add(deltaMove);}
    }
  }
  function requestDraw() {
    if(frame===undefined && !disposed && !paused && !document.hidden) frame=requestAnimationFrame(draw);
  }
  function draw() {
    frame=undefined;
    if(disposed||paused||document.hidden)return;
    move(Math.min(.05,clock.getDelta()));
    const changing=controls.update();
    renderer.render(scene,camera);
      container.dataset.renderCount = String(Number(container.dataset.renderCount || 0) + 1);
    if(settleFrames>0)settleFrames--;
    // Loading / asynchronous splat sorting needs a short settling period; idle scenes do not loop.
    const continuing=!loaded||pressed.size||changing||settleFrames>0;
    container.dataset.renderState=continuing?'settling':'idle';
    if(continuing)requestDraw();
  }
  const onChange=()=>{settleFrames=Math.max(settleFrames,12);requestDraw();};
  controls.addEventListener('change',onChange);
  const motionChanged=()=>{reduced=motionQuery.matches;controls.enableDamping=!reduced;pressed.clear();container.dataset.reducedMotion=String(reduced);onChange();};
  motionQuery.addEventListener('change',motionChanged); motionChanged();
  const visibilityChanged=()=>{pressed.clear();if(document.hidden){cancelAnimationFrame(frame);frame=undefined;}else onChange();};
  document.addEventListener('visibilitychange',visibilityChanged);
  const controlNodes=[];
  function addButton(label,action){if(!controlsContainer)return;const button=document.createElement('button');button.type='button';button.textContent=label;button.addEventListener('click',action);controlsContainer.append(button);controlNodes.push(button);return button;}
  const pauseButton=addButton('停止画面',()=>{paused=!paused;pressed.clear();controls.enabled=!paused;cancelAnimationFrame(frame);frame=undefined;pauseButton.textContent=paused?'继续环视':'停止画面';container.dataset.renderState=paused?'paused':'idle';if(!paused)onChange();});
  const offset=new THREE.Vector3();
  for(const [label,angle] of [['向左看',.15],['向右看',-.15]]) addButton(label,()=>{if(paused)return;offset.copy(controls.target).sub(camera.position).applyAxisAngle(camera.up,angle);controls.target.copy(camera.position).add(offset);onChange();});
  for(const [label,code] of [['向前看近','KeyW'],['向后退远','KeyS']])addButton(label,()=>{if(paused)return;pressed.add(code);move(.16);pressed.clear();onChange();});
  addButton('回到起点',()=>{camera.position.set(0,1.4,3);controls.target.set(0,1.2,0);onChange();});
  resize(); requestDraw();

  onStatus("正在读取 3D 点云…");
  const destroy = () => {
    if(disposed)return;
    disposed=true;signal?.removeEventListener('abort',destroy);clearTimeout(loadTimer);cancelAnimationFrame(frame);
    motionQuery.removeEventListener('change',motionChanged);
    document.removeEventListener('visibilitychange',visibilityChanged);
    controls.removeEventListener('change',onChange);
    controlNodes.forEach(node=>node.remove());
    renderer.setAnimationLoop(null);
    resizeObserver.disconnect();
    container.removeEventListener("keydown", onKeyDown);
    container.removeEventListener("keyup", onKeyUp);
    container.removeEventListener("blur", onBlur);
    controls.dispose();
    splats.dispose?.();
    spark.dispose?.();
    renderer.dispose();renderer.forceContextLoss?.();
    container.replaceChildren();
  };
  const loadTimer=setTimeout(()=>{onStatus('空间解码超时，请返回后重试。');destroy();},60000);
  destroy.ready=splats.initialized.then(()=>{clearTimeout(loadTimer);}).catch(error=>{onStatus('空间文件无法解码，请返回后重试。');destroy();throw error;});
  // The caller may not await ready (legacy standalone viewer).
  destroy.ready.catch(()=>{});
  signal?.addEventListener('abort',destroy,{once:true});if(signal?.aborted)destroy();
  return destroy;
}
