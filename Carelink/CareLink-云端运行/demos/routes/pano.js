import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export async function mountPanoViewer({ container, panorama, onStatus = () => {} }) {
  onStatus("正在打开全景…");
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 1.75));
  renderer.setClearColor(0x122026, 1);
  container.replaceChildren(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 80);
  camera.position.set(0, 0, 0.01);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableZoom = true;
  controls.enablePan = false;
  controls.rotateSpeed = -0.35;
  controls.minDistance = 0.01;
  controls.maxDistance = 0.01;

  const texture = await new THREE.TextureLoader().loadAsync(panorama);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.mapping = THREE.EquirectangularReflectionMapping;
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(20, 64, 48),
    new THREE.MeshBasicMaterial({ map: texture, side: THREE.BackSide })
  );
  scene.add(mesh);
  onStatus("拖动环看");

  const resize = () => {
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();
  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });

  return () => {
    renderer.setAnimationLoop(null);
    observer.disconnect();
    controls.dispose();
    texture.dispose();
    mesh.geometry.dispose();
    mesh.material.dispose();
    renderer.dispose();
    container.replaceChildren();
  };
}
