import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.181.2/build/three.module.js";
import {
  audioEnvelope,
  clamp,
  depthProxyAt,
  flowVector,
  particleBudget,
  particleSeed,
  smoothstep
} from "/spatial-lab-core.js";

const viewer = document.querySelector("#viewer");
const frame = document.querySelector("#photo-frame");
const canvas = document.querySelector("#spatial-canvas");
const fallbackImage = document.querySelector("#fallback-image");
const depthCanvas = document.querySelector("#depth-map");
const replayButton = document.querySelector("#replay");
const audioButton = document.querySelector("#audio-toggle");
const audioLabel = document.querySelector("#audio-label");
const compareButton = document.querySelector("#compare");
const uploadInput = document.querySelector("#upload");
const phaseTitle = document.querySelector("#phase-title");
const phaseCopy = document.querySelector("#phase-copy");
const particleCount = document.querySelector("#particle-count");
const methodStatus = document.querySelector("#method-status");
const flipButton = document.querySelector("#flip-photo");
const orbitLabel = document.querySelector("#orbit-label");
const orbitAngle = document.querySelector("#orbit-angle");
const startDialogueButton = document.querySelector("#start-dialogue");
const dialogueForm = document.querySelector("#dialogue-form");
const dialogueAnswer = document.querySelector("#dialogue-answer");
const sendDialogueButton = document.querySelector("#send-dialogue");
const dialogueLog = document.querySelector("#dialogue-log");
const dialogueProgress = document.querySelector("#dialogue-progress");
const dialogueStatus = document.querySelector("#dialogue-status");
const rebuildMeter = document.querySelector("#rebuild-meter");

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const params = new URLSearchParams(location.search);
const forcedProgress = params.has("progress") ? clamp(Number(params.get("progress"))) : null;
const forcedAudio = params.has("audio") ? clamp(Number(params.get("audio"))) : null;
const staticMode = params.get("static") === "1";
const INTRO_MS = 9000;
const TAU = Math.PI * 2;

const settings = {
  surfaceOpacity: 0.18,
  scatter: 0.28,
  density: 0.64,
  flowSpeed: 0.24,
  flowAmplitude: 0.16,
  attraction: 0.052,
  particleSize: 1.15,
  depthStrength: 0.26,
  audioGain: 1.4
};

const controls = [
  ["surface-opacity", "surface-opacity-value", "surfaceOpacity", 2],
  ["scatter", "scatter-value", "scatter", 2],
  ["density", "density-value", "density", 2],
  ["flow-speed", "flow-speed-value", "flowSpeed", 2],
  ["flow-amplitude", "flow-amplitude-value", "flowAmplitude", 2],
  ["attraction", "attraction-value", "attraction", 3],
  ["particle-size", "particle-size-value", "particleSize", 2],
  ["depth-strength", "depth-strength-value", "depthStrength", 2],
  ["audio-gain", "audio-gain-value", "audioGain", 2]
];

let renderer;
let scene;
let camera;
let fieldGroup;
let portalSurface;
let portalBack;
let particles;
let particleState;
let sourceTexture;
let depthTexture;
let backTexture;
let photoData;
let dialoguePhoto;
let objectUrl;
let animationFrame = 0;
let lastFrameAt = 0;
let introStartedAt = 0;
let introProgress = forcedProgress ?? (reducedMotion.matches ? 1 : 0);
let fieldTime = 0;
let currentTimeline = particleizeTimeline(introProgress);
let visualDissolve = currentTimeline.dissolve;
let pointerTarget = { x: 0, y: 0, active: false };
let pointerCurrent = { x: 0, y: 0, active: false };
let comparing = false;
let imageAspect = 1.5;
let planeWidth = 3.8;
let planeHeight = planeWidth / imageAspect;
let phaseMode = "";
let audioContext;
let audioAnalyser;
let audioData;
let audioStream;
let audioLevel = 0;
let audioStarting = false;
let orbitTargetYaw = 0;
let orbitYaw = 0;
let orbitTargetPitch = 0;
let orbitPitch = 0;
let orbitDrag = null;
let dialogueRound = 0;
let dialogueBusy = false;
let dialogueClarity = 0;
let dialogueClarityTarget = 0;
let dialogueAnswers = [];
let dialogueFocus = { x: 0.5, y: 0.5, radius: 0.24, strength: 0 };
let dialogueFocusTarget = { x: 0.5, y: 0.5, radius: 0.24, strength: 0 };
let dialogueGeneration = 0;

function setPhase(mode, title, copy) {
  if (phaseMode === mode && phaseTitle.textContent === title && phaseCopy.textContent === copy) return;
  phaseMode = mode;
  phaseTitle.textContent = title;
  phaseCopy.textContent = copy;
  viewer.classList.toggle("is-listening", mode === "listening");
  viewer.classList.toggle("is-settled", ["breathing", "listening", "rebuilding", "restored"].includes(mode));
}

function particleizeTimeline(progress) {
  const value = clamp(progress);
  const dissolve = smoothstep(0.08, 0.94, value);
  return {
    progress: value,
    dissolve,
    settle: 1,
    particleOpacity: 0.03 + smoothstep(0.06, 0.58, value) * 0.97,
    interaction: smoothstep(0.38, 0.82, value),
    fieldStrength: smoothstep(0.12, 0.96, value)
  };
}

function addDialogueMessage(role, copy, { focus = false } = {}) {
  const message = document.createElement("article");
  message.className = `dialogue-message dialogue-message--${role}${focus ? " dialogue-message--focus" : ""}`;
  const speaker = document.createElement("span");
  speaker.textContent = role === "user" ? "你" : "阿见";
  const text = document.createElement("p");
  text.textContent = copy;
  message.append(speaker, text);
  dialogueLog.append(message);
  dialogueLog.scrollTop = dialogueLog.scrollHeight;
}

function updateDialogueMeter() {
  dialogueProgress.value = `${dialogueRound} / 3`;
  [...rebuildMeter.children].forEach((segment, index) => {
    segment.classList.toggle("is-filled", index < dialogueRound);
  });
}

function resetDialogue() {
  dialogueGeneration += 1;
  dialogueRound = 0;
  dialogueBusy = false;
  dialogueClarity = 0;
  dialogueClarityTarget = 0;
  dialogueAnswers = [];
  dialogueFocus = { x: 0.5, y: 0.5, radius: 0.24, strength: 0 };
  dialogueFocusTarget = { ...dialogueFocus };
  dialogueLog.replaceChildren();
  addDialogueMessage("ai", "我会直接看清晰原图，再从画面里一个确实存在的细节和你聊起。");
  dialogueForm.hidden = true;
  dialogueAnswer.value = "";
  dialogueAnswer.disabled = false;
  startDialogueButton.hidden = false;
  startDialogueButton.disabled = true;
  startDialogueButton.textContent = "正在读取原图…";
  sendDialogueButton.disabled = false;
  dialogueStatus.textContent = "AI 看的是原图；粒子只呈现对话进度。";
  updateDialogueMeter();
}

function normalizeFocus(focus) {
  if (!focus || !Number.isFinite(Number(focus.x)) || !Number.isFinite(Number(focus.y))) return null;
  return {
    label: typeof focus.label === "string" ? focus.label.slice(0, 30) : "这个细节",
    x: clamp(Number(focus.x)),
    y: clamp(Number(focus.y)),
    radius: clamp(Number(focus.radius) || 0.22, 0.08, 0.45)
  };
}

function applyDialogueFocus(focus) {
  const normalized = normalizeFocus(focus);
  if (!normalized) return;
  dialogueFocusTarget = { ...normalized, strength: 1 };
  dialogueStatus.textContent = `AI 正在照亮你谈到的“${normalized.label}”。`;
  if (staticMode || reducedMotion.matches) renderFrame();
}

async function requestDialogue(round, userText = "") {
  const response = await fetch("/api/memory-dialogue", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      photo: dialoguePhoto,
      round,
      userText,
      history: round > 0 ? dialogueAnswers.slice(0, -1) : dialogueAnswers
    })
  });
  if (!response.ok) throw new Error(`dialogue_${response.status}`);
  return response.json();
}

function fallbackQuestion(round) {
  if (round === 0) return "照片里哪个细节最容易让你开口讲故事？";
  if (round === 1) return "刚才那个细节之外，画面里还有什么让你想继续说下去？";
  return "如果把这张照片讲给别人听，你还想补充哪句话？";
}

async function startDialogue() {
  if (!dialoguePhoto || dialogueBusy) return;
  const generation = dialogueGeneration;
  dialogueBusy = true;
  startDialogueButton.disabled = true;
  startDialogueButton.textContent = "阿见正在看照片…";
  dialogueStatus.textContent = "AI 正在查看清晰原图里的物体、位置和动作。";
  try {
    const outcome = await requestDialogue(0);
    if (generation !== dialogueGeneration) return;
    const firstFocus = normalizeFocus(outcome.focus);
    if (firstFocus) {
      dialogueFocusTarget = { ...firstFocus, strength: 1 };
      dialogueStatus.textContent = `AI 正从“${firstFocus.label}”这个画面细节问起。`;
    } else {
      dialogueStatus.textContent = "回答一次，画面会清晰一层。";
    }
    addDialogueMessage("ai", outcome.question || fallbackQuestion(0), { focus: Boolean(firstFocus) });
    methodStatus.textContent = "AI 已读取清晰原图；粒子画面只负责呈现三轮对话的进度。";
  } catch {
    if (generation !== dialogueGeneration) return;
    addDialogueMessage("ai", fallbackQuestion(0));
    dialogueStatus.textContent = "AI 暂时没有读到原图，先用通用问题继续对话。";
  }
  startDialogueButton.hidden = true;
  dialogueForm.hidden = false;
  dialogueBusy = false;
  dialogueAnswer.focus();
}

async function submitDialogue(event) {
  event.preventDefault();
  const answer = dialogueAnswer.value.trim();
  if (!answer || dialogueBusy || dialogueRound >= 3) return;
  const generation = dialogueGeneration;
  dialogueBusy = true;
  sendDialogueButton.disabled = true;
  dialogueAnswer.disabled = true;
  addDialogueMessage("user", answer);
  dialogueAnswers.push({ round: dialogueRound + 1, userText: answer });
  dialogueRound += 1;
  dialogueClarityTarget = dialogueRound / 3;
  if (staticMode || reducedMotion.matches) renderFrame();
  updateDialogueMeter();
  dialogueAnswer.value = "";
  dialogueStatus.textContent = `已聊 ${dialogueRound} / 3 · 画面正在显影…`;

  if (dialogueRound >= 3) {
    dialogueFocusTarget.strength = 0;
    window.setTimeout(() => {
      if (generation !== dialogueGeneration) return;
      addDialogueMessage("ai", "我们已经从三个细节走过了整张照片。刚才说出的故事，也一起留在了画面里。", { focus: true });
      dialogueForm.hidden = true;
      dialogueStatus.textContent = "对话完成 · 原图完整显现";
    }, reducedMotion.matches ? 0 : 650);
    dialogueBusy = false;
    return;
  }

  try {
    const outcome = await requestDialogue(dialogueRound, answer);
    if (generation !== dialogueGeneration) return;
    applyDialogueFocus(outcome.focus);
    addDialogueMessage("ai", outcome.question || fallbackQuestion(dialogueRound), { focus: Boolean(outcome.focus) });
  } catch {
    if (generation !== dialogueGeneration) return;
    addDialogueMessage("ai", fallbackQuestion(dialogueRound));
    dialogueStatus.textContent = `已聊 ${dialogueRound} / 3；AI 暂时离线，仍可继续。`;
  } finally {
    if (generation !== dialogueGeneration) return;
    dialogueBusy = false;
    sendDialogueButton.disabled = false;
    dialogueAnswer.disabled = false;
    dialogueAnswer.focus();
  }
}

function updatePhase() {
  if (comparing) return setPhase("original", "原图", "粒子暂时退到画面之外");
  if (dialogueClarity > 0.985) return setPhase("restored", "原图完整显现", "三段对话已经走过整张照片");
  if (dialogueRound > 0) return setPhase("rebuilding", `细节显影 ${dialogueRound} / 3`, "AI 正在照亮你谈到的位置");
  if (audioStream || forcedAudio !== null && forcedAudio > .01) {
    return setPhase("listening", "正在听你", "声音正在推开整个粒子场");
  }
  if (introProgress < 0.1) return setPhase("photo", "原照片", "先看清照片，再开始粒子化");
  if (introProgress < 0.92) return setPhase("forming", "正在粒子化", "轮廓先松开，主体仍保持原来的关系");
  return setPhase("breathing", "粒子仍在流动", "照片已经粒子化，但内容没有被打散");
}

function updateParticleCount() {
  const count = particleState?.count ?? 0;
  if (!count) return;
  particleCount.textContent = `${Math.round(count * settings.density / 1000)}K / ${Math.round(count / 1000)}K`;
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

function pixelAt(pixels, width, x, y) {
  const offset = (y * width + x) * 4;
  return {
    red: pixels[offset],
    green: pixels[offset + 1],
    blue: pixels[offset + 2],
    alpha: pixels[offset + 3]
  };
}

function boxBlur(values, width, height, radius = 2) {
  let source = values;
  for (let pass = 0; pass < 2; pass += 1) {
    const target = new Float32Array(source.length);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let sum = 0;
        let count = 0;
        for (let offset = -radius; offset <= radius; offset += 1) {
          const sampleX = pass === 0 ? clamp(x + offset, 0, width - 1) : x;
          const sampleY = pass === 0 ? y : clamp(y + offset, 0, height - 1);
          sum += source[sampleY * width + sampleX];
          count += 1;
        }
        target[y * width + x] = sum / count;
      }
    }
    source = target;
  }
  return source;
}

function buildPhotoData(image) {
  const aspect = clamp(image.naturalWidth / Math.max(1, image.naturalHeight), 0.68, 2.05);
  const landscape = aspect >= 1;
  const width = landscape ? 320 : Math.round(320 * aspect);
  const height = landscape ? Math.round(320 / aspect) : 320;
  const analysis = document.createElement("canvas");
  analysis.width = width;
  analysis.height = height;
  const context = analysis.getContext("2d", { alpha: false, willReadFrequently: true });
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;

  const displayLongEdge = Math.min(1600, Math.max(900, Math.max(image.naturalWidth, image.naturalHeight)));
  const displayWidth = landscape ? displayLongEdge : Math.round(displayLongEdge * aspect);
  const displayHeight = landscape ? Math.round(displayLongEdge / aspect) : displayLongEdge;
  const source = document.createElement("canvas");
  source.width = displayWidth;
  source.height = displayHeight;
  source.getContext("2d", { alpha: false }).drawImage(image, 0, 0, displayWidth, displayHeight);

  const luminance = new Float32Array(width * height);
  for (let index = 0; index < luminance.length; index += 1) {
    const offset = index * 4;
    luminance[index] = (
      pixels[offset] * 0.299 +
      pixels[offset + 1] * 0.587 +
      pixels[offset + 2] * 0.114
    ) / 255;
  }

  const edge = new Float32Array(width * height);
  const rawDepth = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const left = luminance[y * width + Math.max(0, x - 2)];
      const right = luminance[y * width + Math.min(width - 1, x + 2)];
      const top = luminance[Math.max(0, y - 2) * width + x];
      const bottom = luminance[Math.min(height - 1, y + 2) * width + x];
      const localEdge = Math.min(1, Math.abs(right - left) + Math.abs(bottom - top));
      const index = y * width + x;
      edge[index] = localEdge;
      rawDepth[index] = depthProxyAt(
        { ...pixelAt(pixels, width, x, y), edge: localEdge },
        x / Math.max(1, width - 1),
        y / Math.max(1, height - 1)
      );
    }
  }

  const depth = boxBlur(rawDepth, width, height, 2);
  const depthContext = depthCanvas.getContext("2d", { alpha: false });
  depthCanvas.width = width;
  depthCanvas.height = height;
  const depthImage = depthContext.createImageData(width, height);
  for (let index = 0; index < depth.length; index += 1) {
    const value = Math.round(depth[index] * 255);
    const offset = index * 4;
    depthImage.data[offset] = value;
    depthImage.data[offset + 1] = value;
    depthImage.data[offset + 2] = value;
    depthImage.data[offset + 3] = 255;
  }
  depthContext.putImageData(depthImage, 0, 0);
  return { source, pixels, luminance, edge, depth, width, height, aspect };
}

function disposeObject(object) {
  if (!object) return;
  object.geometry?.dispose();
  object.material?.dispose();
  fieldGroup?.remove(object);
}

function makeBackTexture() {
  const backing = document.createElement("canvas");
  backing.width = 1200;
  backing.height = Math.round(1200 / imageAspect);
  const context = backing.getContext("2d");
  const gradient = context.createRadialGradient(
    backing.width * 0.5,
    backing.height * 0.46,
    20,
    backing.width * 0.5,
    backing.height * 0.5,
    backing.width * 0.72
  );
  gradient.addColorStop(0, "#252320");
  gradient.addColorStop(0.56, "#171614");
  gradient.addColorStop(1, "#090909");
  context.fillStyle = gradient;
  context.fillRect(0, 0, backing.width, backing.height);
  context.strokeStyle = "rgba(238, 237, 232, .22)";
  context.lineWidth = 2;
  context.strokeRect(28, 28, backing.width - 56, backing.height - 56);
  context.beginPath();
  context.arc(backing.width / 2, backing.height / 2, Math.min(backing.width, backing.height) * 0.105, 0, TAU);
  context.stroke();
  context.beginPath();
  context.arc(backing.width / 2, backing.height / 2, Math.min(backing.width, backing.height) * 0.15, 0, TAU);
  context.strokeStyle = "rgba(185, 214, 228, .09)";
  context.stroke();
  context.fillStyle = "rgba(238, 237, 232, .74)";
  context.beginPath();
  context.arc(backing.width / 2, backing.height / 2, 5, 0, TAU);
  context.fill();
  const texture = new THREE.CanvasTexture(backing);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

function makePortalSurface() {
  const geometry = new THREE.PlaneGeometry(planeWidth, planeHeight, 150, Math.max(72, Math.round(150 / imageAspect)));
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uPhoto: { value: sourceTexture },
      uDepth: { value: depthTexture },
      uTime: { value: 0 },
      uAudio: { value: 0 },
      uDepthStrength: { value: settings.depthStrength },
      uOpacity: { value: 0 },
      uCompare: { value: 0 },
      uFocus: { value: new THREE.Vector2(0.5, 0.5) },
      uFocusRadius: { value: 0.24 },
      uFocusStrength: { value: 0 }
    },
    vertexShader: `
      uniform sampler2D uDepth;
      uniform float uTime;
      uniform float uAudio;
      uniform float uDepthStrength;
      uniform float uCompare;
      varying vec2 vUv;
      varying float vDepth;

      void main() {
        vUv = uv;
        float depth = texture2D(uDepth, uv).r;
        vDepth = depth;
        float edgeMask = smoothstep(0.0, 0.16, uv.x)
          * smoothstep(0.0, 0.16, 1.0 - uv.x)
          * smoothstep(0.0, 0.16, uv.y)
          * smoothstep(0.0, 0.16, 1.0 - uv.y);
        float wave = sin(uv.y * 8.0 + uTime * 0.7) * 0.012
          + sin((uv.x + uv.y) * 11.0 - uTime * 0.42) * 0.008;
        vec3 displaced = position;
        displaced.z += (depth - 0.48) * uDepthStrength * edgeMask;
        displaced.z += wave * (1.0 + uAudio * 3.0) * edgeMask * (1.0 - uCompare);
        displaced.x += sin(uv.y * 6.0 + uTime * 0.18) * 0.008 * (1.0 - uCompare);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D uPhoto;
      uniform float uTime;
      uniform float uAudio;
      uniform float uOpacity;
      uniform float uCompare;
      uniform vec2 uFocus;
      uniform float uFocusRadius;
      uniform float uFocusStrength;
      varying vec2 vUv;
      varying float vDepth;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }

      void main() {
        vec3 color = pow(texture2D(uPhoto, vUv).rgb, vec3(0.72)) * 1.08;
        float grain = hash(floor(vUv * 94.0) + floor(uTime * 0.16));
        vec2 centered = (vUv - vec2(0.5, 0.51)) / vec2(0.52, 0.49);
        float radius = length(centered);
        float organicEdge = 1.0 - smoothstep(0.68 + grain * 0.035, 1.03 + grain * 0.035, radius);
        float veil = 0.72 + vDepth * 0.2;
        float voiceFade = 1.0 - min(0.78, uAudio * 0.72);
        float focusDistance = length((vUv - uFocus) / vec2(1.0, 0.84));
        float focusMask = (1.0 - smoothstep(uFocusRadius * 0.58, uFocusRadius, focusDistance)) * uFocusStrength;
        float compareWeight = max(uCompare, focusMask);
        float localOpacity = mix(uOpacity, 1.0, focusMask);
        float alpha = mix(organicEdge * veil * voiceFade, 1.0, compareWeight) * localOpacity;
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(color, alpha);
      }
    `
  });
  portalSurface = new THREE.Mesh(geometry, material);
  portalSurface.renderOrder = 1;
  fieldGroup.add(portalSurface);

  backTexture = makeBackTexture();
  portalBack = new THREE.Mesh(
    new THREE.PlaneGeometry(planeWidth, planeHeight),
    new THREE.MeshBasicMaterial({
      map: backTexture,
      side: THREE.BackSide,
      transparent: true,
      opacity: 0.98,
      depthWrite: false
    })
  );
  portalBack.position.z = -0.018;
  portalBack.renderOrder = 0;
  fieldGroup.add(portalBack);
}

function sampleIndex(u, v, width, height) {
  const x = clamp(Math.round(u * (width - 1)), 0, width - 1);
  const y = clamp(Math.round(v * (height - 1)), 0, height - 1);
  return y * width + x;
}

function makeParticles(data) {
  const requestedCount = particleBudget(window.innerWidth, reducedMotion.matches);
  const columns = Math.max(72, Math.round(Math.sqrt(requestedCount * imageAspect)));
  const rows = Math.max(72, Math.ceil(requestedCount / columns));
  const count = columns * rows;
  const positions = new Float32Array(count * 3);
  const velocities = new Float32Array(count * 3);
  const targets = new Float32Array(count * 3);
  const depths = new Float32Array(count);
  const edges = new Float32Array(count);
  const seeds = new Float32Array(count);
  const delays = new Float32Array(count);
  const sizes = new Float32Array(count);
  const masks = new Float32Array(count);
  const reveals = new Float32Array(count);
  const photoUvs = new Float32Array(count * 2);
  const voiceTargets = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const color = new THREE.Color();
  const white = new THREE.Color(1, 1, 1);

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const index = row * columns + column;
      const jitterX = ((index * 37) % 101) / 101 - 0.5;
      const jitterY = ((index * 61) % 97) / 97 - 0.5;
      const u = clamp((column + 0.5 + jitterX * 0.82) / columns, 0.001, 0.999);
      const v = clamp((row + 0.5 + jitterY * 0.82) / rows, 0.001, 0.999);
      const photoIndex = sampleIndex(u, v, data.width, data.height);
      const pixelOffset = photoIndex * 4;
      const depth = data.depth[photoIndex];
      const localEdge = data.edge[photoIndex];
      const seed = particleSeed(index, u, v, depth);
      const offset = index * 3;
      const seedFraction = seed.seed % 1;
      const normalizedX = (u - 0.5) / 0.52;
      const normalizedY = (v - 0.51) / 0.54;
      const radius = Math.sqrt(normalizedX * normalizedX + normalizedY * normalizedY);
      const radialX = normalizedX / Math.max(0.001, radius);
      const radialY = normalizedY / Math.max(0.001, radius);
      const shell = 1 - smoothstep(0.035, 0.19, Math.abs(radius - 0.86));
      const body = 1 - smoothstep(0.7, 1.04, radius);
      const halo = smoothstep(0.82, 0.9, radius) * (1 - smoothstep(0.9, 1.25, radius));
      const outward = (shell * 0.035 + halo * (0.035 + seedFraction * 0.22));

      targets[offset] = (u - 0.5) * planeWidth + radialX * outward;
      targets[offset + 1] = (0.5 - v) * planeHeight - radialY * outward * 0.78;
      targets[offset + 2] =
        (depth - 0.48) * settings.depthStrength
        + Math.sqrt(Math.max(0, 1 - Math.min(1, radius) ** 2)) * 0.12;
      voiceTargets[offset] =
        Math.sin((v - 0.5) * 5.6 + 0.8) * 0.16
        + (seedFraction - 0.5) * 0.065;
      voiceTargets[offset + 1] = (0.5 - v) * planeHeight * 1.72 + (seedFraction - 0.5) * 0.08;
      voiceTargets[offset + 2] = Math.sin(seed.seed * 13.0) * 0.18;
      positions[offset] = targets[offset];
      positions[offset + 1] = targets[offset + 1];
      positions[offset + 2] = targets[offset + 2];
      velocities[offset] = 0;
      velocities[offset + 1] = 0;
      velocities[offset + 2] = 0;
      depths[index] = depth;
      edges[index] = clamp(shell * 0.92 + halo * 0.52 + localEdge * 1.28);
      seeds[index] = seed.seed;
      delays[index] = seed.delay;
      sizes[index] = seed.size * (0.78 + localEdge * 0.75);
      masks[index] = clamp(body * 0.76 + shell * 0.72 + halo * 0.34, 0, 1);
      reveals[index] = seedFraction;
      photoUvs[index * 2] = u;
      photoUvs[index * 2 + 1] = 1 - v;

      color.setRGB(
        data.pixels[pixelOffset] / 255,
        data.pixels[pixelOffset + 1] / 255,
        data.pixels[pixelOffset + 2] / 255,
        THREE.SRGBColorSpace
      );
      const photoLuminance = data.luminance[photoIndex];
      const lift = 0.18 + (1 - photoLuminance) * 0.12 + localEdge * 0.18 + shell * 0.52 + halo * 0.7;
      color.lerp(white, clamp(lift, 0.18, 0.9));
      colors[offset] = color.r;
      colors[offset + 1] = color.g;
      colors[offset + 2] = color.b;
    }
  }

  const geometry = new THREE.BufferGeometry();
  const positionAttribute = new THREE.BufferAttribute(positions, 3);
  positionAttribute.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", positionAttribute);
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute("aEdge", new THREE.BufferAttribute(edges, 1));
  geometry.setAttribute("aMask", new THREE.BufferAttribute(masks, 1));
  geometry.setAttribute("aReveal", new THREE.BufferAttribute(reveals, 1));
  geometry.setAttribute("aPhotoUv", new THREE.BufferAttribute(photoUvs, 2));

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    vertexColors: true,
    blending: THREE.NormalBlending,
    uniforms: {
      uOpacity: { value: 1 },
      uPointScale: { value: settings.particleSize },
      uDensity: { value: settings.density },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 1.7) },
      uAudio: { value: 0 },
      uFocus: { value: new THREE.Vector2(0.5, 0.5) },
      uFocusRadius: { value: 0.24 },
      uFocusStrength: { value: 0 }
    },
    vertexShader: `
      attribute float aSize;
      attribute float aEdge;
      attribute float aMask;
      attribute float aReveal;
      attribute vec2 aPhotoUv;
      uniform float uOpacity;
      uniform float uPointScale;
      uniform float uDensity;
      uniform float uPixelRatio;
      uniform float uAudio;
      uniform vec2 uFocus;
      uniform float uFocusRadius;
      uniform float uFocusStrength;
      varying vec3 vColor;
      varying float vAlpha;
      varying float vEdge;

      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        float audioScale = 1.0 + uAudio * (0.22 + aEdge * 0.6);
        gl_PointSize = max(0.8, aSize * uPointScale * uPixelRatio * audioScale * (6.0 / max(1.0, -mvPosition.z)));
        float voiceWhite = clamp(uAudio * (0.62 + aEdge * 0.58), 0.0, 0.86);
        vColor = mix(color, vec3(1.0, 0.99, 0.95), voiceWhite);
        vEdge = aEdge;
        float densityMask = 1.0 - step(uDensity, aReveal);
        float focusDistance = length((aPhotoUv - uFocus) / vec2(1.0, 0.84));
        float focusMask = (1.0 - smoothstep(uFocusRadius * 0.58, uFocusRadius, focusDistance)) * uFocusStrength;
        vAlpha = uOpacity * (0.5 + aEdge * 0.42) * aMask * densityMask * (1.0 - focusMask * 0.94);
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vAlpha;
      varying float vEdge;
      void main() {
        float distanceToCenter = length(gl_PointCoord - vec2(0.5));
        float core = 1.0 - smoothstep(0.08, 0.38, distanceToCenter);
        float halo = (1.0 - smoothstep(0.24, 0.5, distanceToCenter)) * (0.08 + vEdge * 0.12);
        float alpha = (core + halo) * vAlpha;
        if (alpha < 0.018) discard;
        gl_FragColor = vec4(vColor * (1.02 + vEdge * 0.16), alpha);
      }
    `
  });

  particles = new THREE.Points(geometry, material);
  particles.frustumCulled = false;
  particles.renderOrder = 2;
  fieldGroup.add(particles);
  particleState = { count, positions, velocities, targets, voiceTargets, depths, edges, seeds, delays };
  updateParticleCount();
}

function fitPortal() {
  if (!renderer || !camera) return;
  const viewerBounds = viewer.getBoundingClientRect();
  const compact = window.innerWidth <= 620;
  const horizontalReserve = compact ? 0 : 54;
  const verticalReserve = compact ? 70 : 92;
  const availableWidth = Math.max(220, viewerBounds.width - horizontalReserve);
  const availableHeight = Math.max(220, viewerBounds.height - verticalReserve);
  const width = Math.max(220, Math.min(900, availableWidth, availableHeight * imageAspect));
  const height = width / imageAspect;
  frame.style.width = `${width}px`;
  frame.style.height = `${height}px`;
  frame.style.setProperty("--photo-aspect", String(imageAspect));

  camera.aspect = width / Math.max(1, height);
  const halfFov = THREE.MathUtils.degToRad(camera.fov * 0.5);
  const heightDistance = planeHeight / (2 * Math.tan(halfFov));
  const widthDistance = planeWidth / (2 * Math.tan(halfFov) * camera.aspect);
  camera.position.z = Math.max(heightDistance, widthDistance) * 1.08;
  camera.updateProjectionMatrix();
  renderer.setSize(Math.max(1, width), Math.max(1, height), false);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.7));
  if (particles) particles.material.uniforms.uPixelRatio.value = Math.min(window.devicePixelRatio || 1, 1.7);
}

function sampleAudio() {
  if (forcedAudio !== null) {
    audioLevel = forcedAudio;
    return;
  }
  if (!audioAnalyser || !audioData) {
    audioLevel = audioEnvelope(audioLevel, 0);
    return;
  }
  audioAnalyser.getByteTimeDomainData(audioData);
  let energy = 0;
  for (const value of audioData) {
    const normalized = (value - 128) / 128;
    energy += normalized * normalized;
  }
  const rms = Math.sqrt(energy / audioData.length);
  const sample = clamp((rms - 0.012) * 8.5);
  audioLevel = audioEnvelope(audioLevel, sample);
}

function updateParticles(deltaScale) {
  if (!particleState || !particles) return;
  const { count, positions, velocities, targets, voiceTargets, depths, edges, seeds, delays } = particleState;
  const pointerX = pointerCurrent.x * planeWidth * 0.5;
  const pointerY = pointerCurrent.y * planeHeight * 0.5;
  const pointerRadius = Math.max(0.36, Math.min(0.72, planeHeight * 0.25));
  const pointerRadiusSq = pointerRadius * pointerRadius;
  const damping = Math.pow(0.905, deltaScale);
  const baseAmplitude = settings.flowAmplitude * currentTimeline.fieldStrength;
  const voice = audioLevel * settings.audioGain;
  const voiceMorph = smoothstep(0.035, 0.48, voice);

  for (let index = 0; index < count; index += 1) {
    const offset = index * 3;
    const seed = seeds[index];
    const edge = edges[index];
    const localSettle = smoothstep(delays[index], 1, currentTimeline.settle);
    const baseX = targets[offset];
    const baseY = targets[offset + 1];
    const flow = flowVector(baseX * 0.72, baseY * 0.86, fieldTime, seed);
    const localDissolve = smoothstep(0.04 + (1 - edge) * 0.18, 0.92, visualDissolve);
    const edgeMotion = (0.12 + edge * 0.88) * localDissolve;
    const breath = Math.sin(fieldTime * 0.94 + seed * TAU) * (0.006 + voice * 0.022);
    const orbit = fieldTime * (0.78 + (seed % 1) * 0.55) + seed * TAU * 2.7;
    const scatterAmount = settings.scatter * (0.018 + edge * 0.082) * localDissolve;
    const scatterX = Math.cos(orbit) * scatterAmount + flow.x * settings.scatter * (0.008 + edge * 0.022) * localDissolve;
    const scatterY = Math.sin(orbit * 0.83) * scatterAmount * 0.72 + flow.y * settings.scatter * (0.006 + edge * 0.018) * localDissolve;
    const restingX = baseX + flow.x * baseAmplitude * 0.16 * edgeMotion + scatterX;
    const restingY = baseY + flow.y * baseAmplitude * 0.14 * edgeMotion + scatterY;
    const restingZ =
      (depths[index] - 0.48) * settings.depthStrength +
      flow.z * baseAmplitude * 0.18 * edgeMotion +
      Math.sin(orbit * 1.14) * scatterAmount * 0.7 +
      breath * (0.55 + edge);
    const ribbonX = voiceTargets[offset]
      + Math.sin(voiceTargets[offset + 1] * 2.4 + fieldTime * 2.3 + seed * 0.6) * (0.025 + voice * 0.075);
    const ribbonY = voiceTargets[offset + 1]
      + Math.cos(fieldTime * 1.45 + seed * 19.0) * voice * 0.055;
    const ribbonZ = voiceTargets[offset + 2]
      + Math.sin(fieldTime * 2.0 + seed * 11.0) * voice * 0.12;
    const desiredX = restingX + (ribbonX - restingX) * voiceMorph;
    const desiredY = restingY + (ribbonY - restingY) * voiceMorph;
    const desiredZ = restingZ + (ribbonZ - restingZ) * voiceMorph;
    const spring = settings.attraction * (0.16 + localSettle * 0.84) * (1 + voiceMorph * 1.8) * deltaScale;

    velocities[offset] += (desiredX - positions[offset]) * spring;
    velocities[offset + 1] += (desiredY - positions[offset + 1]) * spring;
    velocities[offset + 2] += (desiredZ - positions[offset + 2]) * spring;

    if (pointerCurrent.active && currentTimeline.interaction > 0.02) {
      const dx = positions[offset] - pointerX;
      const dy = positions[offset + 1] - pointerY;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq < pointerRadiusSq) {
        const distance = Math.sqrt(distanceSq) || 0.0001;
        const force = Math.pow(1 - distance / pointerRadius, 2) * 0.026 * currentTimeline.interaction * deltaScale;
        velocities[offset] += dx / distance * force;
        velocities[offset + 1] += dy / distance * force;
        velocities[offset + 2] += force * 0.7;
      }
    }

    if (voice > 0.01) {
      const pulse = Math.sin(seed * 41 + fieldTime * 2.3) * voice * 0.0038 * (0.35 + edge) * deltaScale;
      velocities[offset] += flow.x * pulse;
      velocities[offset + 1] += flow.y * pulse;
      velocities[offset + 2] += Math.abs(pulse) * 1.7;
    }

    velocities[offset] *= damping;
    velocities[offset + 1] *= damping;
    velocities[offset + 2] *= damping;
    positions[offset] += velocities[offset] * deltaScale;
    positions[offset + 1] += velocities[offset + 1] * deltaScale;
    positions[offset + 2] += velocities[offset + 2] * deltaScale;
  }

  particles.geometry.attributes.position.needsUpdate = true;
}

function renderFrame(now = performance.now()) {
  if (!renderer || !scene || !camera) return;
  const deltaSeconds = lastFrameAt ? clamp((now - lastFrameAt) / 1000, 0.001, 0.05) : 1 / 60;
  const deltaScale = deltaSeconds * 60;
  lastFrameAt = now;

  if (forcedProgress === null) {
    introProgress = staticMode || reducedMotion.matches
      ? 1
      : clamp((now - introStartedAt) / INTRO_MS);
  } else introProgress = forcedProgress;
  currentTimeline = particleizeTimeline(introProgress);
  dialogueClarity = reducedMotion.matches
    ? dialogueClarityTarget
    : dialogueClarity + (dialogueClarityTarget - dialogueClarity) * 0.055;
  dialogueFocus.x += (dialogueFocusTarget.x - dialogueFocus.x) * 0.09;
  dialogueFocus.y += (dialogueFocusTarget.y - dialogueFocus.y) * 0.09;
  dialogueFocus.radius += (dialogueFocusTarget.radius - dialogueFocus.radius) * 0.09;
  dialogueFocus.strength += (dialogueFocusTarget.strength - dialogueFocus.strength) * 0.07;
  visualDissolve = currentTimeline.dissolve * (1 - dialogueClarity);
  fieldTime += deltaSeconds * settings.flowSpeed * 3.2 * (staticMode ? 0 : 1);
  sampleAudio();
  pointerCurrent.x += (pointerTarget.x - pointerCurrent.x) * 0.12;
  pointerCurrent.y += (pointerTarget.y - pointerCurrent.y) * 0.12;
  pointerCurrent.active = pointerTarget.active;

  if (!staticMode && !reducedMotion.matches) updateParticles(deltaScale);
  particles.material.uniforms.uOpacity.value = comparing
    ? 0.045
    : currentTimeline.particleOpacity * (1 - dialogueClarity * 0.94);
  particles.material.uniforms.uPointScale.value = settings.particleSize;
  particles.material.uniforms.uDensity.value = settings.density;
  particles.material.uniforms.uAudio.value = audioLevel * settings.audioGain;
  particles.material.uniforms.uFocus.value.set(dialogueFocus.x, 1 - dialogueFocus.y);
  particles.material.uniforms.uFocusRadius.value = dialogueFocus.radius;
  particles.material.uniforms.uFocusStrength.value = dialogueFocus.strength * (1 - dialogueClarity * 0.35);
  portalSurface.material.uniforms.uTime.value = fieldTime;
  portalSurface.material.uniforms.uAudio.value = audioLevel * settings.audioGain;
  portalSurface.material.uniforms.uDepthStrength.value = settings.depthStrength;
  portalSurface.material.uniforms.uOpacity.value = comparing
    ? 1
    : (1 - visualDissolve * (1 - settings.surfaceOpacity))
      * (1 - smoothstep(0.04, 0.55, audioLevel * settings.audioGain) * 0.96);
  portalSurface.material.uniforms.uCompare.value = comparing ? 1 : 1 - visualDissolve;
  portalSurface.material.uniforms.uFocus.value.set(dialogueFocus.x, 1 - dialogueFocus.y);
  portalSurface.material.uniforms.uFocusRadius.value = dialogueFocus.radius;
  portalSurface.material.uniforms.uFocusStrength.value = dialogueFocus.strength;

  const interaction = comparing ? 0 : currentTimeline.interaction;
  orbitYaw += (orbitTargetYaw - orbitYaw) * (reducedMotion.matches ? 1 : 0.11);
  orbitPitch += (orbitTargetPitch - orbitPitch) * (reducedMotion.matches ? 1 : 0.11);
  fieldGroup.rotation.y = orbitYaw;
  fieldGroup.rotation.x = orbitPitch;
  fieldGroup.position.x += (pointerCurrent.x * -0.035 * interaction - fieldGroup.position.x) * 0.08;
  fieldGroup.position.y += (pointerCurrent.y * -0.024 * interaction - fieldGroup.position.y) * 0.08;

  const degrees = ((Math.round(THREE.MathUtils.radToDeg(orbitYaw)) % 360) + 360) % 360;
  const showingBack = Math.cos(orbitYaw) < 0;
  orbitAngle.value = `${degrees}°`;
  orbitLabel.textContent = showingBack ? "回到正面" : "转到背面";
  flipButton.setAttribute("aria-label", showingBack ? "把照片转回正面" : "把照片转到背面");

  const displayAudio = clamp(audioLevel * settings.audioGain);
  viewer.style.setProperty("--audio-level", displayAudio.toFixed(3));
  audioButton.style.setProperty("--audio-level", displayAudio.toFixed(3));
  updatePhase();
  renderer.render(scene, camera);
}

function stopAnimation() {
  if (animationFrame) cancelAnimationFrame(animationFrame);
  animationFrame = 0;
}

function animate(now) {
  renderFrame(now);
  animationFrame = requestAnimationFrame(animate);
}

function startAnimation() {
  stopAnimation();
  lastFrameAt = 0;
  if (staticMode || reducedMotion.matches) {
    renderFrame();
    return;
  }
  animationFrame = requestAnimationFrame(animate);
}

function resetParticlePositions() {
  if (!particleState) return;
  const { count, positions, velocities, targets, depths } = particleState;
  for (let index = 0; index < count; index += 1) {
    const offset = index * 3;
    positions[offset] = targets[offset];
    positions[offset + 1] = targets[offset + 1];
    positions[offset + 2] = (depths[index] - 0.48) * settings.depthStrength;
    velocities[offset] = 0;
    velocities[offset + 1] = 0;
    velocities[offset + 2] = 0;
  }
  particles.geometry.attributes.position.needsUpdate = true;
}

function settleParticlePositions() {
  if (!particleState) return;
  const { count, positions, velocities, targets, depths } = particleState;
  for (let index = 0; index < count; index += 1) {
    const offset = index * 3;
    positions[offset] = targets[offset];
    positions[offset + 1] = targets[offset + 1];
    positions[offset + 2] = (depths[index] - 0.48) * settings.depthStrength;
    velocities[offset] = 0;
    velocities[offset + 1] = 0;
    velocities[offset + 2] = 0;
  }
  particles.geometry.attributes.position.needsUpdate = true;
}

function replay() {
  comparing = false;
  compareButton.setAttribute("aria-pressed", "false");
  pointerTarget = { x: 0, y: 0, active: false };
  pointerCurrent = { x: 0, y: 0, active: false };
  orbitTargetYaw = 0;
  orbitTargetPitch = 0;
  resetDialogue();
  resetParticlePositions();
  introStartedAt = performance.now();
  introProgress = reducedMotion.matches ? 1 : 0;
  phaseMode = "";
  if (reducedMotion.matches) {
    methodStatus.textContent = "系统已开启减少动态效果，照片保持为静态粒子表面。";
    renderFrame();
  } else startAnimation();
  void startDialogue();
}

async function stopAudio({ announce = true } = {}) {
  for (const track of audioStream?.getTracks?.() ?? []) track.stop();
  audioStream = null;
  audioAnalyser = null;
  audioData = null;
  if (audioContext && audioContext.state !== "closed") await audioContext.close().catch(() => {});
  audioContext = null;
  audioButton.setAttribute("aria-pressed", "false");
  audioLabel.textContent = "声音反应";
  phaseMode = "";
  if (announce) methodStatus.textContent = "声音反应已关闭；没有录音被保存。";
}

async function toggleAudio() {
  if (audioStarting) return;
  if (audioStream) return stopAudio();
  if (reducedMotion.matches) {
    methodStatus.textContent = "系统已开启减少动态效果，声音不会驱动画面。";
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
    methodStatus.textContent = "当前浏览器不能读取声音强弱，照片仍会保持呼吸。";
    return;
  }
  audioStarting = true;
  audioLabel.textContent = "正在请求麦克风";
  methodStatus.textContent = "只读取声音强弱，不录音、不上传。";
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
    audioContext = new AudioContext();
    if (audioContext.state === "suspended") await audioContext.resume();
    const source = audioContext.createMediaStreamSource(audioStream);
    audioAnalyser = audioContext.createAnalyser();
    audioAnalyser.fftSize = 256;
    audioAnalyser.smoothingTimeConstant = 0.62;
    audioData = new Uint8Array(audioAnalyser.fftSize);
    source.connect(audioAnalyser);
    audioButton.setAttribute("aria-pressed", "true");
    audioLabel.textContent = "关闭声音反应";
    methodStatus.textContent = "正在本机读取声音强弱；没有录音被保存或上传。";
    phaseMode = "";
  } catch (error) {
    audioStream = null;
    audioLabel.textContent = "声音反应";
    audioButton.setAttribute("aria-pressed", "false");
    methodStatus.textContent = error?.name === "NotAllowedError"
      ? "麦克风权限未开启；照片会继续自行呼吸。"
      : "没有读到声音；照片会继续自行呼吸。";
  } finally {
    audioStarting = false;
  }
}

async function rebuild(source) {
  resetDialogue();
  const generation = dialogueGeneration;
  methodStatus.textContent = "正在从照片建立颜色、密度与空间关系……";
  viewer.classList.add("is-loading");
  const image = await loadImage(source);
  if (generation !== dialogueGeneration) return;
  photoData = buildPhotoData(image);
  dialoguePhoto = { dataUrl: photoData.source.toDataURL("image/jpeg", 0.84) };
  if (!renderer || !fieldGroup) {
    canvas.hidden=true;fallbackImage.src=source;fallbackImage.hidden=false;
    viewer.classList.remove("is-loading");
    methodStatus.textContent="当前设备使用原照片；仍可继续文字对话。";
    setPhase("fallback","原图","静态照片 · 对话仍可继续");
    void startDialogue();return;
  }
  imageAspect = photoData.aspect;
  planeWidth = imageAspect >= 1 ? 3.8 : 3.05 * imageAspect;
  planeHeight = planeWidth / imageAspect;

  disposeObject(portalSurface);
  disposeObject(portalBack);
  disposeObject(particles);
  sourceTexture?.dispose();
  depthTexture?.dispose();
  backTexture?.dispose();

  sourceTexture = new THREE.CanvasTexture(photoData.source);
  sourceTexture.colorSpace = THREE.SRGBColorSpace;
  sourceTexture.minFilter = THREE.LinearFilter;
  sourceTexture.magFilter = THREE.LinearFilter;
  depthTexture = new THREE.CanvasTexture(depthCanvas);
  depthTexture.colorSpace = THREE.NoColorSpace;
  depthTexture.minFilter = THREE.LinearFilter;
  depthTexture.magFilter = THREE.LinearFilter;

  makePortalSurface();
  makeParticles(photoData);
  if (staticMode || reducedMotion.matches || forcedProgress === 1) settleParticlePositions();
  fitPortal();
  canvas.hidden = false;
  fallbackImage.hidden = true;
  viewer.classList.remove("is-loading");
  methodStatus.textContent = reducedMotion.matches
    ? "AI 已读取清晰原图；系统按偏好使用静态呈现。"
    : "AI 正在读取清晰原图；粒子画面只负责呈现三轮对话的进度。";
  orbitTargetYaw = 0;
  orbitYaw = 0;
  orbitTargetPitch = 0;
  orbitPitch = 0;
  introStartedAt = performance.now();
  introProgress = forcedProgress ?? (staticMode || reducedMotion.matches ? 1 : 0);
  phaseMode = "";
  startAnimation();
  void startDialogue();
}

function initRenderer() {
  if (!window.WebGLRenderingContext) throw new Error("webgl_unavailable");
  renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: false,
    preserveDrawingBuffer: true,
    powerPreference: "high-performance"
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x050505, 0);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(34, 1.5, 0.1, 30);
  fieldGroup = new THREE.Group();
  scene.add(fieldGroup);
}

function setPointer(event) {
  if (reducedMotion.matches || comparing) return;
  const bounds = frame.getBoundingClientRect();
  pointerTarget = {
    x: clamp((event.clientX - bounds.left) / bounds.width * 2 - 1, -1, 1),
    y: clamp(1 - (event.clientY - bounds.top) / bounds.height * 2, -1, 1),
    active: true
  };
}

function startOrbit(event) {
  if (event.button !== 0) return;
  frame.setPointerCapture?.(event.pointerId);
  orbitDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  pointerTarget.active = false;
  frame.classList.add("is-orbiting");
}

function moveOrbit(event) {
  if (!orbitDrag || event.pointerId !== orbitDrag.pointerId) return setPointer(event);
  const deltaX = event.clientX - orbitDrag.x;
  const deltaY = event.clientY - orbitDrag.y;
  orbitDrag.x = event.clientX;
  orbitDrag.y = event.clientY;
  orbitTargetYaw += deltaX * 0.012;
  orbitTargetPitch = clamp(orbitTargetPitch + deltaY * 0.006, -0.58, 0.58);
  event.preventDefault();
  if (staticMode || reducedMotion.matches) renderFrame();
}

function endOrbit(event) {
  if (!orbitDrag || event.pointerId !== orbitDrag.pointerId) return;
  frame.releasePointerCapture?.(event.pointerId);
  orbitDrag = null;
  frame.classList.remove("is-orbiting");
  pointerTarget = { x: 0, y: 0, active: false };
}

for (const [inputId, outputId, key, decimals] of controls) {
  const input = document.querySelector(`#${inputId}`);
  const output = document.querySelector(`#${outputId}`);
  input.addEventListener("input", () => {
    settings[key] = Number(input.value);
    output.value = settings[key].toFixed(decimals);
    if (key === "density") updateParticleCount();
    if (staticMode || reducedMotion.matches) renderFrame();
  });
}

frame.addEventListener("pointerdown", startOrbit);
frame.addEventListener("pointermove", moveOrbit);
frame.addEventListener("pointerenter", setPointer);
frame.addEventListener("pointerleave", () => {
  if (!orbitDrag) pointerTarget = { x: 0, y: 0, active: false };
});
frame.addEventListener("pointerup", endOrbit);
frame.addEventListener("pointercancel", endOrbit);
flipButton.addEventListener("click", () => {
  orbitTargetYaw += Math.PI;
  if (staticMode || reducedMotion.matches) renderFrame();
});
dialogueForm.addEventListener("submit", submitDialogue);
replayButton.addEventListener("click", replay);
audioButton.addEventListener("click", toggleAudio);
compareButton.addEventListener("pointerdown", () => {
  comparing = true;
  compareButton.setAttribute("aria-pressed", "true");
  phaseMode = "";
  if (staticMode || reducedMotion.matches) renderFrame();
});
for (const eventName of ["pointerup", "pointerleave", "pointercancel"]) {
  compareButton.addEventListener(eventName, () => {
    comparing = false;
    compareButton.setAttribute("aria-pressed", "false");
    phaseMode = "";
    if (staticMode || reducedMotion.matches) renderFrame();
  });
}
uploadInput.addEventListener("change", async () => {
  const [file] = uploadInput.files ?? [];
  if (!file) return;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  fallbackImage.src = objectUrl;
  canvas.hidden = true;
  fallbackImage.hidden = false;
  methodStatus.textContent = "正在读取新照片；粒子场准备好后会从原图开始。";
  try {
    await rebuild(objectUrl);
  } catch {
    methodStatus.textContent = "没有读到这张照片，请换一张 JPG、PNG 或 WebP。";
  }
});
window.addEventListener("resize", fitPortal, { passive: true });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopAnimation();
  else startAnimation();
});
reducedMotion.addEventListener?.("change", async (event) => {
  if (event.matches) await stopAudio({ announce: false });
  if (event.matches) settleParticlePositions();
  else resetParticlePositions();
  introProgress = event.matches ? 1 : 0;
  introStartedAt = performance.now();
  methodStatus.textContent = event.matches
    ? "系统已开启减少动态效果，照片保持为静态粒子表面。"
    : "动态效果已恢复，照片重新进入流场。";
  startAnimation();
});
window.addEventListener("pagehide", () => {
  stopAnimation();
  stopAudio({ announce: false });
  if (objectUrl) URL.revokeObjectURL(objectUrl);
}, { once: true });

canvas.addEventListener("webglcontextlost", (event) => {
  event.preventDefault();
  stopAnimation();
  canvas.hidden = true;
  fallbackImage.hidden = false;
  methodStatus.textContent = "图形环境已暂停，当前显示原照片。";
});

window.spatialLab = {
  replay,
  setControl(name, value) {
    if (!(name in settings)) return false;
    settings[name] = Number(value);
    return true;
  },
  getState() {
    return {
      ...currentTimeline,
      visualDissolve,
      audioLevel,
      orbitDegrees: THREE.MathUtils.radToDeg(orbitYaw),
      dialogueRound,
      dialogueClarity,
      dialogueFocus: { ...dialogueFocus },
      particleCount: particleState?.count ?? 0,
      settings: { ...settings }
    };
  }
};

try {
  initRenderer();
  await rebuild("/photos/photo1_cheers.jpg");
} catch (error) {
  console.error("spatial lab fallback", error);
  stopAnimation();
  renderer?.dispose();renderer=null;
  canvas.hidden = true;
  fallbackImage.hidden = false;
  methodStatus.textContent = "当前设备暂不支持粒子场，已显示原照片。";
  try {await rebuild(fallbackImage.getAttribute("src")||"/photos/photo1_cheers.jpg");}
  catch {methodStatus.textContent="没有读到照片，请重新选择一张。";}
  setPhase("fallback", "原图", "当前设备使用静态降级");
}
