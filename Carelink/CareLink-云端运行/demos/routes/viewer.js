import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";

export function preferQuality() {
  return matchMedia("(min-width: 760px)").matches && matchMedia("(pointer: fine)").matches
    ? "standard"
    : "preview";
}

export async function mountWorldViewer({ container, world, quality = "preview", onStatus = () => {} }) {
  const splatUrl = world?.splats?.[quality] || world?.splats?.preview || world?.splats?.standard;
  if (!container || !splatUrl) throw new Error("world_splat_missing");

  onStatus("正在读取空间…");
  const response = await fetch(splatUrl);
  if (!response.ok) throw new Error(`splat_http_${response.status}`);
  const fileBytes = await response.arrayBuffer();
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 1.75));
  renderer.setClearColor(0x122026, 1);
  container.replaceChildren(renderer.domElement);
  container.tabIndex = 0;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 1, 0.01, 1200);
  camera.position.set(0, 1.4, 3);
  const spark = new SparkRenderer({ renderer });
  scene.add(spark);

  const controls = new OrbitControls(camera, renderer.domElement);
  const motionQuery = matchMedia("(prefers-reduced-motion: reduce)");
  let reduced = motionQuery.matches;
  let paused = false;
  let disposed = false;
  let frame;
  let settleFrames = 45;
  controls.enableDamping = !reduced;
  controls.dampingFactor = 0.075;
  controls.screenSpacePanning = true;
  controls.target.set(0, 1.2, 0);
  controls.minDistance = 0.03;
  controls.maxDistance = 300;

  let loaded = false;
  let worldRadius = 4;
  const splats = new SplatMesh({
    fileBytes,
    fileName: `${world.id || "world"}.spz`,
    lod: true,
    onProgress(event) {
      if (!event?.lengthComputable) return onStatus("正在读取点云…");
      onStatus(`正在读取点云 · ${Math.round((event.loaded / event.total) * 100)}%`);
    },
    onLoad() {
      if (disposed) return;
      loaded = true;
      onStatus("拖动环看 · 滚轮靠近 · WASD 走动");
      settleFrames = 45;
      requestDraw();
    }
  });
  splats.quaternion.set(1, 0, 0, 0);
  scene.add(splats);

  const pressed = new Set();
  const movementKeys = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight"]);
  const onKeyDown = (event) => {
    if (!movementKeys.has(event.code)) return;
    event.preventDefault();
    if (paused) return;
    if (reduced) {
      if (!event.repeat) {
        pressed.add(event.code);
        move(0.06);
        pressed.clear();
      }
    } else pressed.add(event.code);
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

  const clock = new THREE.Clock();
  const forward = new THREE.Vector3();
  const side = new THREE.Vector3();
  const deltaMove = new THREE.Vector3();
  function move(delta) {
    if (loaded && pressed.size) {
      camera.getWorldDirection(forward);
      forward.y = 0;
      if (forward.lengthSq() < 0.001) forward.set(0, 0, -1);
      forward.normalize();
      side.crossVectors(forward, camera.up).normalize();
      deltaMove.set(0, 0, 0);
      if (pressed.has("KeyW") || pressed.has("ArrowUp")) deltaMove.add(forward);
      if (pressed.has("KeyS") || pressed.has("ArrowDown")) deltaMove.sub(forward);
      if (pressed.has("KeyD") || pressed.has("ArrowRight")) deltaMove.add(side);
      if (pressed.has("KeyA") || pressed.has("ArrowLeft")) deltaMove.sub(side);
      if (deltaMove.lengthSq()) {
        deltaMove.normalize().multiplyScalar(Math.max(0.08, worldRadius * 0.24) * delta);
        camera.position.add(deltaMove);
        controls.target.add(deltaMove);
      }
    }
  }
  function requestDraw() {
    if (frame === undefined && !disposed && !paused && !document.hidden) frame = requestAnimationFrame(draw);
  }
  function draw() {
    frame = undefined;
    if (disposed || paused || document.hidden) return;
    move(Math.min(0.05, clock.getDelta()));
    const changing = controls.update();
    renderer.render(scene, camera);
    if (settleFrames > 0) settleFrames--;
    if (!loaded || pressed.size || changing || settleFrames > 0) requestDraw();
  }
  const onChange = () => {
    settleFrames = Math.max(settleFrames, 12);
    requestDraw();
  };
  controls.addEventListener("change", onChange);
  const motionChanged = () => {
    reduced = motionQuery.matches;
    controls.enableDamping = !reduced;
    pressed.clear();
    onChange();
  };
  motionQuery.addEventListener("change", motionChanged);
  const visibilityChanged = () => {
    pressed.clear();
    if (document.hidden) {
      cancelAnimationFrame(frame);
      frame = undefined;
    } else onChange();
  };
  document.addEventListener("visibilitychange", visibilityChanged);

  resizeObserver.observe(container);
  resize();
  requestDraw();

  const loadTimer = setTimeout(() => {
    onStatus("读取超时，可换更轻的预览，或去 Marble 打开。");
  }, 45000);

  splats.initialized
    ?.then(() => clearTimeout(loadTimer))
    .catch(() => {
      clearTimeout(loadTimer);
      onStatus("这个空间文件打不开，去 Marble 看原页。");
    });

  return () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(loadTimer);
    cancelAnimationFrame(frame);
    motionQuery.removeEventListener("change", motionChanged);
    document.removeEventListener("visibilitychange", visibilityChanged);
    controls.removeEventListener("change", onChange);
    resizeObserver.disconnect();
    container.removeEventListener("keydown", onKeyDown);
    container.removeEventListener("keyup", onKeyUp);
    container.removeEventListener("blur", onBlur);
    controls.dispose();
    splats.dispose?.();
    spark.dispose?.();
    renderer.dispose();
    renderer.forceContextLoss?.();
    container.replaceChildren();
  };
}
