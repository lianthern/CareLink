import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.181.2/build/three.module.js";
import { JELLY_PRESETS, clamp, fitPhoto, releaseEnergy, stepSpring } from "./jelly-core.js";

const stage = document.querySelector("#jelly-stage");
const canvas = document.querySelector("#jelly-canvas");
const shadow = document.querySelector("#jelly-shadow");
const dragCursor = document.querySelector("#drag-cursor");
const loadingNote = document.querySelector("#loading-note");
const uploadInput = document.querySelector("#photo-upload");
const soundButton = document.querySelector("#sound-toggle");
const soundLabel = document.querySelector("#sound-label");
const resetButton = document.querySelector("#reset-jelly");
const feelReadout = document.querySelector("#feel-readout");
const presetButtons = [...document.querySelectorAll("[data-preset]")];
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

let presetKey = "bounce";
let preset = JELLY_PRESETS[presetKey];
let soundEnabled = true;
let audioContext;
let masterGain;
let renderer;
let scene;
let camera;
let jellyGroup;
let mesh;
let shellMesh;
let material;
let shellMaterial;
let photoTexture;
let photoAspect = 1.48;
let planeSize = { width: 3.7, height: 2.5 };
let viewSize = { width: 6, height: 6 };
let animationFrame;
let previousFrame = performance.now();
let elapsed = 0;
let releaseStartedAt = -10;
let drag = null;
let press = 0;
let pressTarget = 0;
let energy = 0;
let lastStretchSound = 0;
let sourceObjectUrl = null;

const SHELL_DEPTH = 0.34;
const SHELL_MARGIN = 0.09;

const spring = {
  x: 0,
  y: 0,
  velocityX: 0,
  velocityY: 0,
  targetX: 0,
  targetY: 0
};

const uniforms = {
  uPhoto: { value: null },
  uTime: { value: 0 },
  uGrabOrigin: { value: new THREE.Vector2(0.5, 0.5) },
  uOffset: { value: new THREE.Vector2(0, 0) },
  uOffsetUv: { value: new THREE.Vector2(0, 0) },
  uPress: { value: 0 },
  uEnergy: { value: 0 },
  uReleaseAge: { value: 10 },
  uRadius: { value: preset.radius },
  uAspect: { value: photoAspect },
  uWobble: { value: preset.wobble }
};

function makePlaceholderTexture() {
  const data = new Uint8Array([255, 253, 252, 255]);
  const texture = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
  texture.needsUpdate = true;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms,
    vertexShader: `
      uniform float uTime;
      uniform float uPress;
      uniform float uEnergy;
      uniform float uReleaseAge;
      uniform float uRadius;
      uniform float uAspect;
      uniform float uWobble;
      uniform vec2 uGrabOrigin;
      uniform vec2 uOffset;
      varying vec2 vUv;
      varying float vInfluence;
      varying float vShapeWave;

      void main() {
        vUv = uv;
        vec2 local = (uv - uGrabOrigin) * vec2(uAspect, 1.0);
        float distanceToTouch = length(local);
        float influence = 1.0 - smoothstep(uRadius * 0.18, uRadius, distanceToTouch);
        influence = pow(max(0.0, influence), 1.36);
        float ring = exp(-pow((distanceToTouch - uRadius * 0.55) / max(0.03, uRadius * 0.2), 2.0));
        float releaseEnvelope = exp(-uReleaseAge * 2.35) * uEnergy;
        float releaseWave = sin(distanceToTouch * 29.0 - uReleaseAge * 15.0) * releaseEnvelope;
        float ambient = sin(uv.y * 8.0 + uTime * 0.72)
          + sin((uv.x + uv.y) * 10.0 - uTime * 0.48);

        vec3 displaced = position;
        displaced.xy += uOffset * influence;
        vec2 radial = distanceToTouch > 0.001 ? local / distanceToTouch : vec2(0.0);
        displaced.xy += radial * ring * uPress * 0.045;
        displaced.x += ambient * 0.0045 * uWobble;
        displaced.y += sin(uv.x * 9.0 - uTime * 0.58) * 0.005 * uWobble;
        displaced.z -= uPress * pow(influence, 1.55) * 0.28;
        displaced.z += ring * uPress * 0.085;
        displaced.z += releaseWave * 0.095 * (0.38 + influence);

        vInfluence = influence;
        vShapeWave = releaseWave;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D uPhoto;
      uniform float uTime;
      uniform float uPress;
      uniform float uEnergy;
      uniform float uAspect;
      uniform vec2 uGrabOrigin;
      uniform vec2 uOffsetUv;
      varying vec2 vUv;
      varying float vInfluence;
      varying float vShapeWave;

      float superellipse(vec2 point, float power) {
        vec2 shaped = pow(abs(point), vec2(power));
        return pow(shaped.x + shaped.y, 1.0 / power);
      }

      void main() {
        vec2 fromTouch = (vUv - uGrabOrigin) * vec2(uAspect, 1.0);
        float touchDistance = max(0.001, length(fromTouch));
        vec2 refractDirection = fromTouch / touchDistance / vec2(uAspect, 1.0);
        vec2 refraction = refractDirection * vInfluence * uPress * 0.012;
        refraction += vec2(vShapeWave * 0.0025, -vShapeWave * 0.0035);
        refraction -= uOffsetUv * vInfluence * 0.022;
        vec2 photoUv = clamp(vUv + refraction, vec2(0.002), vec2(0.998));

        vec3 photo = texture2D(uPhoto, photoUv).rgb;
        float shape = superellipse((vUv - 0.5) / vec2(0.492, 0.485), 5.4);
        float edgeNoise = sin(vUv.y * 21.0 + uTime * 0.42) * 0.004
          + sin(vUv.x * 17.0 - uTime * 0.33) * 0.003;
        float alphaMask = 1.0 - smoothstep(0.976 + edgeNoise, 1.01 + edgeNoise, shape);
        if (alphaMask < 0.01) discard;

        float rim = smoothstep(0.68, 0.985, shape) * alphaMask;
        float cornerGlint = 1.0 - smoothstep(0.0, 0.45, distance(vUv, vec2(0.22, 0.14)));
        float diagonalSheen = exp(-pow((vUv.x + vUv.y * 0.31 - 0.28) / 0.11, 2.0));
        diagonalSheen *= smoothstep(0.04, 0.28, vUv.y) * (1.0 - smoothstep(0.58, 0.93, vUv.y));
        float pressedSheen = pow(vInfluence, 2.0) * (0.16 + uPress * 0.2);

        vec3 color = mix(photo, vec3(1.0, 0.995, 0.99), 0.035);
        color = mix(color, vec3(0.76, 1.0, 0.89), rim * 0.16);
        color += vec3(0.95, 1.0, 0.98) * (cornerGlint * 0.2 + diagonalSheen * 0.13);
        color += vec3(0.68, 0.96, 0.83) * pressedSheen * 0.14;
        color += vec3(1.0) * max(0.0, vShapeWave) * uEnergy * 0.09;

        float alpha = alphaMask * mix(0.94, 0.81, rim);
        gl_FragColor = vec4(color, alpha);
      }
    `
  });
}

function makeRoundedRectangle(width, height, radius) {
  const shape = new THREE.Shape();
  const left = -width / 2;
  const bottom = -height / 2;
  shape.moveTo(left + radius, bottom);
  shape.lineTo(left + width - radius, bottom);
  shape.quadraticCurveTo(left + width, bottom, left + width, bottom + radius);
  shape.lineTo(left + width, bottom + height - radius);
  shape.quadraticCurveTo(left + width, bottom + height, left + width - radius, bottom + height);
  shape.lineTo(left + radius, bottom + height);
  shape.quadraticCurveTo(left, bottom + height, left, bottom + height - radius);
  shape.lineTo(left, bottom + radius);
  shape.quadraticCurveTo(left, bottom, left + radius, bottom);
  return shape;
}

function makeShellGeometry() {
  const width = planeSize.width + SHELL_MARGIN;
  const height = planeSize.height + SHELL_MARGIN;
  const radius = Math.min(0.32, height * 0.13);
  const geometry = new THREE.ExtrudeGeometry(makeRoundedRectangle(width, height, radius), {
    depth: SHELL_DEPTH,
    steps: 1,
    curveSegments: 14,
    bevelEnabled: true,
    bevelSegments: reducedMotion.matches ? 3 : 6,
    bevelSize: 0.075,
    bevelThickness: 0.075
  });
  geometry.translate(0, 0, -SHELL_DEPTH / 2);
  geometry.computeVertexNormals();
  return geometry;
}

function makeShellMaterial() {
  return new THREE.MeshPhysicalMaterial({
    color: 0xbcefd7,
    emissive: 0x193c2e,
    emissiveIntensity: 0.08,
    transparent: true,
    opacity: 0.64,
    transmission: 0.14,
    thickness: 0.88,
    ior: 1.34,
    roughness: 0.12,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
    side: THREE.FrontSide,
    depthWrite: false
  });
}

function resetSpring({ ripple = false } = {}) {
  if (ripple) {
    energy = Math.max(energy, releaseEnergy(
      spring.x,
      spring.y,
      spring.velocityX,
      spring.velocityY
    ));
    releaseStartedAt = elapsed;
  }
  spring.x = 0;
  spring.y = 0;
  spring.velocityX = 0;
  spring.velocityY = 0;
  spring.targetX = 0;
  spring.targetY = 0;
  press = 0;
  pressTarget = 0;
  uniforms.uOffset.value.set(0, 0);
  uniforms.uOffsetUv.value.set(0, 0);
  uniforms.uPress.value = 0;
  drag = null;
  canvas.classList.remove("is-grabbing");
  dragCursor.classList.remove("is-visible", "is-pulling");
}

function replaceGeometry() {
  if (!mesh || !shellMesh) return;
  mesh.geometry.dispose();
  shellMesh.geometry.dispose();
  const columns = reducedMotion.matches ? 42 : 70;
  const rows = Math.max(34, Math.round(columns / photoAspect));
  mesh.geometry = new THREE.PlaneGeometry(planeSize.width, planeSize.height, columns, rows);
  mesh.position.z = SHELL_DEPTH / 2 + 0.085;
  shellMesh.geometry = makeShellGeometry();
}

function resize() {
  if (!renderer || !camera) return;
  const width = Math.max(1, stage.clientWidth);
  const height = Math.max(1, stage.clientHeight);
  camera.aspect = width / height;
  viewSize.height = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.z;
  viewSize.width = viewSize.height * width / height;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.8));
  renderer.setSize(width, height, false);
  planeSize = fitPhoto(photoAspect, viewSize.width, viewSize.height);
  replaceGeometry();
}

function initializeScene() {
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: "high-performance"
    });
  } catch {
    loadingNote.textContent = "这个浏览器暂时无法运行照片果冻，请换用最新版浏览器。";
    return false;
  }

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  camera.position.z = 10.8;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;

  scene.add(new THREE.HemisphereLight(0xffffff, 0xa58fba, 1.85));
  const keyLight = new THREE.DirectionalLight(0xfff9f4, 3.6);
  keyLight.position.set(-3.4, 4.6, 6.2);
  scene.add(keyLight);
  const edgeLight = new THREE.PointLight(0xb7f5d6, 34, 18, 1.7);
  edgeLight.position.set(3.8, -1.3, 4.5);
  scene.add(edgeLight);
  const blushLight = new THREE.PointLight(0xf6cfe2, 22, 16, 1.8);
  blushLight.position.set(-3.6, -2.4, 3.2);
  scene.add(blushLight);

  material = makeMaterial();
  shellMaterial = makeShellMaterial();
  photoTexture = makePlaceholderTexture();
  uniforms.uPhoto.value = photoTexture;
  jellyGroup = new THREE.Group();
  shellMesh = new THREE.Mesh(makeShellGeometry(), shellMaterial);
  shellMesh.renderOrder = 0;
  mesh = new THREE.Mesh(new THREE.PlaneGeometry(planeSize.width, planeSize.height, 70, 48), material);
  mesh.position.z = SHELL_DEPTH / 2 + 0.085;
  mesh.renderOrder = 2;
  jellyGroup.add(shellMesh, mesh);
  scene.add(jellyGroup);
  resize();
  return true;
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = source;
  });
}

async function setPhoto(source, { objectUrl = false } = {}) {
  loadingNote.textContent = "正在把照片变软……";
  loadingNote.hidden = false;
  loadingNote.classList.remove("is-hidden");
  try {
    const image = await loadImage(source);
    const nextTexture = new THREE.Texture(image);
    nextTexture.colorSpace = THREE.SRGBColorSpace;
    nextTexture.minFilter = THREE.LinearFilter;
    nextTexture.magFilter = THREE.LinearFilter;
    nextTexture.needsUpdate = true;
    photoTexture?.dispose();
    photoTexture = nextTexture;
    photoAspect = clamp(image.naturalWidth / Math.max(1, image.naturalHeight), 0.58, 2.1);
    uniforms.uPhoto.value = photoTexture;
    uniforms.uAspect.value = photoAspect;
    resetSpring();
    resize();
    loadingNote.classList.add("is-hidden");
    loadingNote.hidden = true;
  } catch {
    loadingNote.textContent = "这张照片没有读成功，请换一张 JPG、PNG 或 WebP。";
    loadingNote.hidden = false;
  } finally {
    if (objectUrl) URL.revokeObjectURL(source);
  }
}

function ensureAudio() {
  if (!soundEnabled) return null;
  if (!audioContext) {
    const AudioConstructor = window.AudioContext || window.webkitAudioContext;
    if (!AudioConstructor) return null;
    audioContext = new AudioConstructor();
    masterGain = audioContext.createGain();
    masterGain.gain.value = 0.68;
    masterGain.connect(audioContext.destination);
  }
  if (audioContext.state === "suspended") audioContext.resume();
  return audioContext;
}

function playTone({ frequency, endFrequency, duration, volume, type = "sine" }) {
  const context = ensureAudio();
  if (!context || !masterGain) return;
  const now = context.currentTime;
  const oscillator = context.createOscillator();
  const filter = context.createBiquadFilter();
  const gain = context.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(Math.max(30, frequency * preset.pitch), now);
  oscillator.frequency.exponentialRampToValueAtTime(Math.max(30, endFrequency * preset.pitch), now + duration);
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(640, now);
  filter.frequency.exponentialRampToValueAtTime(210, now + duration);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(volume, now + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  oscillator.connect(filter).connect(gain).connect(masterGain);
  oscillator.start(now);
  oscillator.stop(now + duration + 0.02);
}

function playNoise(duration, volume) {
  const context = ensureAudio();
  if (!context || !masterGain) return;
  const frameCount = Math.max(1, Math.round(context.sampleRate * duration));
  const buffer = context.createBuffer(1, frameCount, context.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let index = 0; index < samples.length; index += 1) {
    const envelope = 1 - index / samples.length;
    samples[index] = (Math.random() * 2 - 1) * envelope;
  }
  const source = context.createBufferSource();
  const filter = context.createBiquadFilter();
  const gain = context.createGain();
  filter.type = "bandpass";
  filter.frequency.value = 280;
  filter.Q.value = 0.7;
  gain.gain.value = volume;
  source.buffer = buffer;
  source.connect(filter).connect(gain).connect(masterGain);
  source.start();
}

function playPress() {
  playTone({ frequency: 118, endFrequency: 63, duration: 0.13, volume: 0.075, type: "sine" });
  playNoise(0.06, 0.035);
}

function playStretch(strength) {
  playTone({
    frequency: 72 + strength * 36,
    endFrequency: 52,
    duration: 0.085,
    volume: 0.022 + strength * 0.018,
    type: "triangle"
  });
}

function playRelease(strength) {
  playTone({
    frequency: 185 + strength * 80,
    endFrequency: 76,
    duration: 0.19 + strength * 0.06,
    volume: 0.055 + strength * 0.055,
    type: "sine"
  });
  window.setTimeout(() => playNoise(0.055, 0.025 + strength * 0.025), 22);
}

const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();

function raycastPhoto(event) {
  if (!mesh || !camera) return null;
  const rect = canvas.getBoundingClientRect();
  pointerNdc.set(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(pointerNdc, camera);
  return raycaster.intersectObject(mesh, false)[0] ?? null;
}

function placeCursor(event, { pulling = false } = {}) {
  const rect = stage.getBoundingClientRect();
  dragCursor.style.left = `${event.clientX - rect.left}px`;
  dragCursor.style.top = `${event.clientY - rect.top}px`;
  dragCursor.classList.add("is-visible");
  dragCursor.classList.toggle("is-pulling", pulling);
}

function beginDrag(event) {
  if (drag || !mesh) return;
  const hit = raycastPhoto(event);
  if (!hit?.uv) return;
  event.preventDefault();
  ensureAudio();
  canvas.setPointerCapture?.(event.pointerId);
  drag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    lastX: event.clientX,
    lastY: event.clientY,
    lastTime: performance.now()
  };
  uniforms.uGrabOrigin.value.copy(hit.uv);
  pressTarget = 1;
  energy = Math.max(energy, 0.15);
  canvas.classList.add("is-grabbing");
  placeCursor(event, { pulling: true });
  playPress();
}

function moveDrag(event) {
  if (!drag || event.pointerId !== drag.pointerId) {
    if (event.pointerType === "mouse") {
      if (raycastPhoto(event)) placeCursor(event);
      else dragCursor.classList.remove("is-visible");
    }
    return;
  }

  event.preventDefault();
  const rect = stage.getBoundingClientRect();
  const deltaX = event.clientX - drag.startX;
  const deltaY = event.clientY - drag.startY;
  spring.targetX = clamp(deltaX / rect.width * viewSize.width * preset.pull, -1.65, 1.65);
  spring.targetY = clamp(-deltaY / rect.height * viewSize.height * preset.pull, -1.45, 1.45);
  energy = Math.max(energy, clamp(Math.hypot(deltaX, deltaY) / 260, 0, 0.8));
  placeCursor(event, { pulling: true });

  const now = performance.now();
  const traveled = Math.hypot(event.clientX - drag.lastX, event.clientY - drag.lastY);
  if (traveled > 13 && now - lastStretchSound > 115) {
    playStretch(clamp(traveled / Math.max(14, now - drag.lastTime), 0.15, 1));
    lastStretchSound = now;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    drag.lastTime = now;
  }
}

function endDrag(event) {
  if (!drag || (event && event.pointerId !== drag.pointerId)) return;
  const strength = releaseEnergy(
    spring.x,
    spring.y,
    spring.velocityX,
    spring.velocityY
  );
  const pointerId = drag.pointerId;
  drag = null;
  spring.targetX = 0;
  spring.targetY = 0;
  pressTarget = 0;
  energy = Math.max(energy, strength);
  releaseStartedAt = elapsed;
  canvas.releasePointerCapture?.(pointerId);
  canvas.classList.remove("is-grabbing");
  dragCursor.classList.remove("is-visible", "is-pulling");
  playRelease(strength);
}

function keyboardPoke(event) {
  if (event.key !== " " && event.key !== "Enter") return;
  event.preventDefault();
  if (drag) return;
  uniforms.uGrabOrigin.value.set(0.5, 0.5);
  spring.targetX = 0.28;
  spring.targetY = 0.09;
  pressTarget = 1;
  playPress();
  window.setTimeout(() => {
    spring.targetX = 0;
    spring.targetY = 0;
    pressTarget = 0;
    energy = 0.72;
    releaseStartedAt = elapsed;
    playRelease(0.65);
  }, reducedMotion.matches ? 40 : 150);
}

function animate(now) {
  const delta = Math.min(1 / 30, Math.max(0.001, (now - previousFrame) / 1000));
  previousFrame = now;
  elapsed += delta;
  const motionPreset = reducedMotion.matches
    ? { ...preset, damping: Math.max(19, preset.damping), stiffness: Math.max(92, preset.stiffness) }
    : preset;
  const nextX = stepSpring(spring.x, spring.velocityX, spring.targetX, motionPreset, delta);
  const nextY = stepSpring(spring.y, spring.velocityY, spring.targetY, motionPreset, delta);
  spring.x = nextX.position;
  spring.velocityX = nextX.velocity;
  spring.y = nextY.position;
  spring.velocityY = nextY.velocity;
  const pressEase = 1 - Math.exp(-delta * (pressTarget ? 13 : 8));
  press += (pressTarget - press) * pressEase;
  if (!drag) energy *= Math.exp(-delta * 2.6);

  uniforms.uTime.value = elapsed;
  uniforms.uOffset.value.set(spring.x, spring.y);
  uniforms.uOffsetUv.value.set(
    spring.x / Math.max(0.01, planeSize.width),
    spring.y / Math.max(0.01, planeSize.height)
  );
  uniforms.uPress.value = press;
  uniforms.uEnergy.value = reducedMotion.matches ? energy * 0.16 : energy;
  uniforms.uReleaseAge.value = Math.max(0, elapsed - releaseStartedAt);
  uniforms.uRadius.value = preset.radius;
  uniforms.uWobble.value = reducedMotion.matches ? 0 : preset.wobble;

  const idleTiltX = reducedMotion.matches ? 0.026 : 0.035 + Math.sin(elapsed * 0.46) * 0.008;
  const idleTiltY = reducedMotion.matches ? -0.035 : -0.07 + Math.sin(elapsed * 0.39 + 0.8) * 0.014;
  jellyGroup.rotation.x = idleTiltX - spring.y * 0.095;
  jellyGroup.rotation.y = idleTiltY + spring.x * 0.12;
  jellyGroup.rotation.z = -spring.x * 0.016;
  jellyGroup.position.z = reducedMotion.matches ? 0 : Math.sin(elapsed * 0.64) * 0.018;
  jellyGroup.scale.set(1 + press * 0.012, 1 - press * 0.018, 1 + press * 0.025);

  const pixelOffset = spring.x / Math.max(0.01, viewSize.width) * stage.clientWidth * 0.12;
  const shadowScale = clamp(1 - Math.abs(spring.y) * 0.045 + press * 0.06, 0.88, 1.12);
  shadow.style.transform = `translate(calc(-50% + ${pixelOffset.toFixed(1)}px), -50%) scaleX(${shadowScale.toFixed(3)})`;
  shadow.style.opacity = String(clamp(0.74 - Math.abs(spring.y) * 0.08, 0.42, 0.8));

  renderer.render(scene, camera);
  animationFrame = requestAnimationFrame(animate);
}

function selectPreset(nextKey) {
  if (!JELLY_PRESETS[nextKey]) return;
  presetKey = nextKey;
  preset = JELLY_PRESETS[presetKey];
  presetButtons.forEach((button) => {
    const active = button.dataset.preset === presetKey;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  feelReadout.lastChild.textContent = ` 3D · ${preset.label}`;
  uniforms.uRadius.value = preset.radius;
  uniforms.uWobble.value = preset.wobble;
  energy = Math.max(energy, 0.36);
  releaseStartedAt = elapsed;
  playTone({ frequency: 130, endFrequency: 86, duration: 0.11, volume: 0.045, type: "sine" });
}

presetButtons.forEach((button) => {
  button.addEventListener("click", () => selectPreset(button.dataset.preset));
});

soundButton.addEventListener("click", () => {
  soundEnabled = !soundEnabled;
  soundButton.setAttribute("aria-pressed", String(soundEnabled));
  soundLabel.textContent = soundEnabled ? "声音开" : "声音关";
  if (soundEnabled) {
    ensureAudio();
    playTone({ frequency: 155, endFrequency: 92, duration: 0.12, volume: 0.05 });
  }
});

resetButton.addEventListener("click", () => {
  resetSpring({ ripple: true });
  uniforms.uGrabOrigin.value.set(0.5, 0.5);
  playRelease(0.42);
});

uploadInput.addEventListener("change", async () => {
  const file = uploadInput.files?.[0];
  if (!file) return;
  if (!/^image\/(jpeg|png|webp)$/u.test(file.type)) {
    loadingNote.textContent = "请选择 JPG、PNG 或 WebP 照片。";
    loadingNote.hidden = false;
    loadingNote.classList.remove("is-hidden");
    uploadInput.value = "";
    return;
  }
  sourceObjectUrl = URL.createObjectURL(file);
  await setPhoto(sourceObjectUrl, { objectUrl: true });
  sourceObjectUrl = null;
  uploadInput.value = "";
});

canvas.addEventListener("pointerdown", beginDrag);
canvas.addEventListener("pointermove", moveDrag);
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);
canvas.addEventListener("pointerleave", () => {
  if (!drag) dragCursor.classList.remove("is-visible");
});
canvas.addEventListener("keydown", keyboardPoke);
canvas.addEventListener("webglcontextlost", (event) => {
  event.preventDefault();
  cancelAnimationFrame(animationFrame);
  loadingNote.textContent = "照片果冻暂停了，刷新页面可以重新开始。";
  loadingNote.hidden = false;
  loadingNote.classList.remove("is-hidden");
});

const resizeObserver = new ResizeObserver(resize);
resizeObserver.observe(stage);

if (initializeScene()) {
  setPhoto("./photos/photo1_cheers.jpg");
  animationFrame = requestAnimationFrame(animate);
}

window.addEventListener("pagehide", () => {
  cancelAnimationFrame(animationFrame);
  sourceObjectUrl && URL.revokeObjectURL(sourceObjectUrl);
  photoTexture?.dispose();
  mesh?.geometry.dispose();
  shellMesh?.geometry.dispose();
  material?.dispose();
  shellMaterial?.dispose();
  renderer?.dispose();
  audioContext?.close();
});
