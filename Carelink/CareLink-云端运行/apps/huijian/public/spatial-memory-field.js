import {
  audioEnvelope,
  clamp,
  depthProxyAt,
  flowVector,
  particleBudget,
  particleSeed,
  smoothstep,
  timelineState
} from "./spatial-lab-core.js";

const THREE_MODULE_URL = "https://cdn.jsdelivr.net/npm/three@0.181.2/build/three.module.js";
const INTRO_MS = 3100;
const TAU = Math.PI * 2;
const SETTINGS = Object.freeze({
  flowSpeed: .22,
  flowAmplitude: .16,
  attraction: .04,
  particleSize: 1,
  depthStrength: .28,
  audioGain: 1.4
});

let threePromise;

function loadThree() {
  threePromise ??= import(THREE_MODULE_URL);
  return threePromise;
}

function loadImageSource(source) {
  return new Promise((resolve, reject) => {
    const nextImage = new Image();
    nextImage.decoding = "async";
    nextImage.onload = () => resolve(nextImage);
    nextImage.onerror = reject;
    nextImage.src = source;
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

function buildPhotoData(sourceImage) {
  const aspect = clamp(sourceImage.naturalWidth / Math.max(1, sourceImage.naturalHeight), .68, 2.05);
  const landscape = aspect >= 1;
  const width = landscape ? 320 : Math.round(320 * aspect);
  const height = landscape ? Math.round(320 / aspect) : 320;
  const analysis = document.createElement("canvas");
  analysis.width = width;
  analysis.height = height;
  const context = analysis.getContext("2d", { alpha: false, willReadFrequently: true });
  context.drawImage(sourceImage, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;

  const displayLongEdge = Math.min(1600, Math.max(900, Math.max(sourceImage.naturalWidth, sourceImage.naturalHeight)));
  const displayWidth = landscape ? displayLongEdge : Math.round(displayLongEdge * aspect);
  const displayHeight = landscape ? Math.round(displayLongEdge / aspect) : displayLongEdge;
  const source = document.createElement("canvas");
  source.width = displayWidth;
  source.height = displayHeight;
  source.getContext("2d", { alpha: false }).drawImage(sourceImage, 0, 0, displayWidth, displayHeight);

  const luminance = new Float32Array(width * height);
  for (let index = 0; index < luminance.length; index += 1) {
    const offset = index * 4;
    luminance[index] = (
      pixels[offset] * .299 +
      pixels[offset + 1] * .587 +
      pixels[offset + 2] * .114
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
  const depthCanvas = document.createElement("canvas");
  depthCanvas.width = width;
  depthCanvas.height = height;
  const depthContext = depthCanvas.getContext("2d", { alpha: false });
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
  return { source, depthCanvas, pixels, luminance, edge, depth, width, height, aspect };
}

function sampleIndex(u, v, width, height) {
  const x = clamp(Math.round(u * (width - 1)), 0, width - 1);
  const y = clamp(Math.round(v * (height - 1)), 0, height - 1);
  return y * width + x;
}

function disposeRenderable(renderable, group) {
  if (!renderable) return;
  renderable.geometry?.dispose();
  renderable.material?.dispose();
  group?.remove(renderable);
}

export function createDemoMemoryField({
  host,
  image,
  canvas,
  reducedMotion = { matches: false },
  onSettled = () => {},
  onSupportChange = () => {}
}) {
  let THREE;
  let renderer;
  let scene;
  let camera;
  let fieldGroup;
  let portalSurface;
  let particles;
  let particleState;
  let sourceTexture;
  let depthTexture;
  let animationFrame = 0;
  let rebuildRevision = 0;
  let active = false;
  let wanted = false;
  let unavailable = false;
  let settledSent = false;
  let introStartedAt = 0;
  let introProgress = 0;
  let fieldTime = 0;
  let lastFrameAt = 0;
  let currentTimeline = timelineState(0);
  let pointerTarget = { x: 0, y: 0, active: false };
  let pointerCurrent = { x: 0, y: 0, active: false };
  let imageAspect = 1.5;
  let planeWidth = 3.8;
  let planeHeight = planeWidth / imageAspect;
  let audioTarget = 0;
  let audioLevel = 0;
  let listening = false;
  let frameCount = 0;

  const supported = () => Boolean(
    host && image && canvas &&
    globalThis.window?.WebGLRenderingContext &&
    !unavailable
  );
  const sourceKey = () => image?.currentSrc || image?.src || "";

  function markUnavailable(error) {
    unavailable = true;
    active = false;
    canvas.hidden = true;
    canvas.dataset.engineState = "fallback";
    if (globalThis.location?.search?.includes("spatial-debug")) {
      console.warn("demo memory field unavailable", error);
    }
    onSupportChange(false);
  }

  function initRenderer() {
    if (renderer) return;
    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance"
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x050505, 0);
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(34, 1.5, .1, 30);
    fieldGroup = new THREE.Group();
    scene.add(fieldGroup);
    canvas.dataset.engine = "demo-memory-field";
  }

  function makePortalSurface() {
    const geometry = new THREE.PlaneGeometry(
      planeWidth,
      planeHeight,
      150,
      Math.max(72, Math.round(150 / imageAspect))
    );
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uPhoto: { value: sourceTexture },
        uDepth: { value: depthTexture },
        uTime: { value: 0 },
        uAudio: { value: 0 },
        uDepthStrength: { value: SETTINGS.depthStrength },
        uOpacity: { value: 0 }
      },
      vertexShader: `
        uniform sampler2D uDepth;
        uniform float uTime;
        uniform float uAudio;
        uniform float uDepthStrength;
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
          displaced.z += wave * (1.0 + uAudio * 3.0) * edgeMask;
          displaced.x += sin(uv.y * 6.0 + uTime * 0.18) * 0.008;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uPhoto;
        uniform float uTime;
        uniform float uAudio;
        uniform float uOpacity;
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
          float alpha = organicEdge * veil * voiceFade * uOpacity;
          if (alpha < 0.01) discard;
          gl_FragColor = vec4(color, alpha);
        }
      `
    });
    portalSurface = new THREE.Mesh(geometry, material);
    portalSurface.renderOrder = 1;
    fieldGroup.add(portalSurface);
  }

  function makeParticles(data) {
    const requestedCount = particleBudget(window.innerWidth, reducedMotion.matches);
    const memoryScale = Number.isFinite(navigator.deviceMemory) && navigator.deviceMemory <= 4 ? .72 : 1;
    const columns = Math.max(72, Math.round(Math.sqrt(requestedCount * memoryScale * imageAspect)));
    const rows = Math.max(72, Math.ceil(requestedCount * memoryScale / columns));
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
    const voiceTargets = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const color = new THREE.Color();
    const white = new THREE.Color(1, 1, 1);

    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const index = row * columns + column;
        const jitterX = ((index * 37) % 101) / 101 - .5;
        const jitterY = ((index * 61) % 97) / 97 - .5;
        const u = clamp((column + .5 + jitterX * .82) / columns, .001, .999);
        const v = clamp((row + .5 + jitterY * .82) / rows, .001, .999);
        const photoIndex = sampleIndex(u, v, data.width, data.height);
        const pixelOffset = photoIndex * 4;
        const depth = data.depth[photoIndex];
        const localEdge = data.edge[photoIndex];
        const seed = particleSeed(index, u, v, depth);
        const offset = index * 3;
        const seedFraction = seed.seed % 1;
        const normalizedX = (u - .5) / .52;
        const normalizedY = (v - .51) / .54;
        const radius = Math.sqrt(normalizedX ** 2 + normalizedY ** 2);
        const radialX = normalizedX / Math.max(.001, radius);
        const radialY = normalizedY / Math.max(.001, radius);
        const shell = 1 - smoothstep(.035, .19, Math.abs(radius - .86));
        const body = 1 - smoothstep(.7, 1.04, radius);
        const halo = smoothstep(.82, .9, radius) * (1 - smoothstep(.9, 1.25, radius));
        const outward = shell * .035 + halo * (.035 + seedFraction * .22);

        targets[offset] = (u - .5) * planeWidth + radialX * outward;
        targets[offset + 1] = (.5 - v) * planeHeight - radialY * outward * .78;
        targets[offset + 2] = (depth - .48) * SETTINGS.depthStrength
          + Math.sqrt(Math.max(0, 1 - Math.min(1, radius) ** 2)) * .12;
        voiceTargets[offset] = Math.sin((v - .5) * 5.6 + .8) * .16 + (seedFraction - .5) * .065;
        voiceTargets[offset + 1] = (.5 - v) * planeHeight * 1.72 + (seedFraction - .5) * .08;
        voiceTargets[offset + 2] = Math.sin(seed.seed * 13) * .18;
        positions[offset] = targets[offset] + seed.startX;
        positions[offset + 1] = targets[offset + 1] + seed.startY;
        positions[offset + 2] = targets[offset + 2] + seed.startZ;
        velocities[offset] = -seed.startX * .002;
        velocities[offset + 1] = -seed.startY * .002;
        velocities[offset + 2] = -seed.startZ * .002;
        depths[index] = depth;
        edges[index] = clamp(shell * .92 + halo * .52 + localEdge * 1.28);
        seeds[index] = seed.seed;
        delays[index] = seed.delay;
        sizes[index] = seed.size * (.78 + localEdge * .75);
        masks[index] = clamp(body * .76 + shell * .72 + halo * .34, 0, 1);

        color.setRGB(
          data.pixels[pixelOffset] / 255,
          data.pixels[pixelOffset + 1] / 255,
          data.pixels[pixelOffset + 2] / 255,
          THREE.SRGBColorSpace
        );
        const lift = .18 + (1 - data.luminance[photoIndex]) * .12 + localEdge * .18 + shell * .52 + halo * .7;
        color.lerp(white, clamp(lift, .18, .9));
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

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexColors: true,
      blending: THREE.NormalBlending,
      uniforms: {
        uOpacity: { value: 1 },
        uPointScale: { value: SETTINGS.particleSize },
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 1.7) },
        uAudio: { value: 0 }
      },
      vertexShader: `
        attribute float aSize;
        attribute float aEdge;
        attribute float aMask;
        uniform float uOpacity;
        uniform float uPointScale;
        uniform float uPixelRatio;
        uniform float uAudio;
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
          vAlpha = uOpacity * (0.5 + aEdge * 0.42) * aMask;
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
    canvas.dataset.particleCount = String(count);
  }

  function fitPortal() {
    if (!renderer || !camera) return false;
    const bounds = host.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width));
    const height = Math.max(1, Math.round(bounds.height || width / imageAspect));
    if (width <= 1 || height <= 1) return false;
    camera.aspect = width / height;
    const halfFov = THREE.MathUtils.degToRad(camera.fov * .5);
    const heightDistance = planeHeight / (2 * Math.tan(halfFov));
    const widthDistance = planeWidth / (2 * Math.tan(halfFov) * camera.aspect);
    camera.position.z = Math.max(heightDistance, widthDistance) * 1.08;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.7));
    particles.material.uniforms.uPixelRatio.value = Math.min(window.devicePixelRatio || 1, 1.7);
    return true;
  }

  function resetParticlePositions() {
    if (!particleState || !particles) return;
    const { count, positions, velocities, targets, seeds, depths } = particleState;
    for (let index = 0; index < count; index += 1) {
      const offset = index * 3;
      const u = targets[offset] / planeWidth + .5;
      const v = .5 - targets[offset + 1] / planeHeight;
      const seed = particleSeed(index, u, v, depths[index]);
      positions[offset] = targets[offset] + seed.startX + Math.sin(seeds[index] * TAU) * .24;
      positions[offset + 1] = targets[offset + 1] + seed.startY;
      positions[offset + 2] = targets[offset + 2] + seed.startZ;
      velocities[offset] = -seed.startX * .002;
      velocities[offset + 1] = -seed.startY * .002;
      velocities[offset + 2] = -seed.startZ * .002;
    }
    particles.geometry.attributes.position.needsUpdate = true;
  }

  function updateParticles(deltaScale) {
    if (!particleState || !particles) return 0;
    const { count, positions, velocities, targets, voiceTargets, depths, edges, seeds, delays } = particleState;
    const pointerX = pointerCurrent.x * planeWidth * .5;
    const pointerY = pointerCurrent.y * planeHeight * .5;
    const pointerRadius = Math.max(.36, Math.min(.72, planeHeight * .25));
    const pointerRadiusSq = pointerRadius ** 2;
    const damping = Math.pow(.905, deltaScale);
    const baseAmplitude = SETTINGS.flowAmplitude * currentTimeline.fieldStrength;
    const voice = audioLevel * SETTINGS.audioGain;
    const voiceMorph = smoothstep(.035, .48, voice);
    let sampledMotion = 0;

    for (let index = 0; index < count; index += 1) {
      const offset = index * 3;
      const previousX = positions[offset];
      const previousY = positions[offset + 1];
      const seed = seeds[index];
      const edge = edges[index];
      const localSettle = smoothstep(delays[index], 1, currentTimeline.settle);
      const baseX = targets[offset];
      const baseY = targets[offset + 1];
      const flow = flowVector(baseX * .72, baseY * .86, fieldTime, seed);
      const edgeMotion = .34 + edge * 1.42;
      const breath = Math.sin(fieldTime * .94 + seed * TAU) * (.006 + voice * .022);
      const restingX = baseX + flow.x * baseAmplitude * .14 * edgeMotion;
      const restingY = baseY + flow.y * baseAmplitude * .12 * edgeMotion;
      const restingZ = (depths[index] - .48) * SETTINGS.depthStrength
        + flow.z * baseAmplitude * .2 * edgeMotion
        + breath * (.55 + edge);
      const ribbonX = voiceTargets[offset]
        + Math.sin(voiceTargets[offset + 1] * 2.4 + fieldTime * 2.3 + seed * .6) * (.025 + voice * .075);
      const ribbonY = voiceTargets[offset + 1] + Math.cos(fieldTime * 1.45 + seed * 19) * voice * .055;
      const ribbonZ = voiceTargets[offset + 2] + Math.sin(fieldTime * 2 + seed * 11) * voice * .12;
      const desiredX = restingX + (ribbonX - restingX) * voiceMorph;
      const desiredY = restingY + (ribbonY - restingY) * voiceMorph;
      const desiredZ = restingZ + (ribbonZ - restingZ) * voiceMorph;
      const spring = SETTINGS.attraction * (.16 + localSettle * .84) * (1 + voiceMorph * 1.8) * deltaScale;

      velocities[offset] += (desiredX - positions[offset]) * spring;
      velocities[offset + 1] += (desiredY - positions[offset + 1]) * spring;
      velocities[offset + 2] += (desiredZ - positions[offset + 2]) * spring;

      if (pointerCurrent.active && currentTimeline.interaction > .02) {
        const dx = positions[offset] - pointerX;
        const dy = positions[offset + 1] - pointerY;
        const distanceSq = dx * dx + dy * dy;
        if (distanceSq < pointerRadiusSq) {
          const distance = Math.sqrt(distanceSq) || .0001;
          const force = (1 - distance / pointerRadius) ** 2 * .026 * currentTimeline.interaction * deltaScale;
          velocities[offset] += dx / distance * force;
          velocities[offset + 1] += dy / distance * force;
          velocities[offset + 2] += force * .7;
        }
      }

      if (voice > .01) {
        const pulse = Math.sin(seed * 41 + fieldTime * 2.3) * voice * .0038 * (.35 + edge) * deltaScale;
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
      if (index < 96) sampledMotion += Math.hypot(positions[offset] - previousX, positions[offset + 1] - previousY);
    }
    particles.geometry.attributes.position.needsUpdate = true;
    return sampledMotion / 96;
  }

  function renderFrame(now = performance.now()) {
    if (!renderer || !scene || !camera || !particles || !portalSurface) return;
    const deltaSeconds = lastFrameAt ? clamp((now - lastFrameAt) / 1000, .001, .05) : 1 / 60;
    const deltaScale = deltaSeconds * 60;
    lastFrameAt = now;
    introProgress = reducedMotion.matches ? 1 : clamp((now - introStartedAt) / INTRO_MS);
    currentTimeline = timelineState(introProgress);
    fieldTime += deltaSeconds * SETTINGS.flowSpeed;
    audioLevel = audioEnvelope(audioLevel, listening ? audioTarget : 0);
    pointerCurrent.x += (pointerTarget.x - pointerCurrent.x) * .12;
    pointerCurrent.y += (pointerTarget.y - pointerCurrent.y) * .12;
    pointerCurrent.active = pointerTarget.active;

    const motionEnergy = reducedMotion.matches ? 0 : updateParticles(deltaScale);
    particles.material.uniforms.uOpacity.value = currentTimeline.particleOpacity;
    particles.material.uniforms.uPointScale.value = SETTINGS.particleSize;
    particles.material.uniforms.uAudio.value = audioLevel * SETTINGS.audioGain;
    portalSurface.material.uniforms.uTime.value = fieldTime;
    portalSurface.material.uniforms.uAudio.value = audioLevel * SETTINGS.audioGain;
    portalSurface.material.uniforms.uOpacity.value = currentTimeline.surfaceOpacity
      * (1 - smoothstep(.04, .55, audioLevel * SETTINGS.audioGain) * .96);

    const interaction = currentTimeline.interaction;
    fieldGroup.rotation.y += (pointerCurrent.x * .075 * interaction - fieldGroup.rotation.y) * .09;
    fieldGroup.rotation.x += (pointerCurrent.y * -.052 * interaction - fieldGroup.rotation.x) * .09;
    fieldGroup.position.x += (pointerCurrent.x * -.035 * interaction - fieldGroup.position.x) * .08;
    fieldGroup.position.y += (pointerCurrent.y * -.024 * interaction - fieldGroup.position.y) * .08;
    renderer.render(scene, camera);

    frameCount += 1;
    canvas.dataset.renderFrame = String(frameCount);
    canvas.dataset.motionEnergy = motionEnergy.toFixed(6);
    canvas.dataset.engineState = "running";
    if (!settledSent && introProgress >= .98) {
      settledSent = true;
      onSettled();
    }
  }

  function animate(now) {
    if (!active) return;
    renderFrame(now);
    animationFrame = requestAnimationFrame(animate);
  }

  function startAnimation() {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    lastFrameAt = 0;
    active = true;
    canvas.hidden = false;
    if (reducedMotion.matches) {
      renderFrame();
      return;
    }
    animationFrame = requestAnimationFrame(animate);
  }

  async function rebuild(revision) {
    try {
      THREE = await loadThree();
      if (revision !== rebuildRevision || !wanted) return;
      initRenderer();
      const source = sourceKey();
      if (!source) return;
      const sourceImage = image.complete && image.naturalWidth ? image : await loadImageSource(source);
      if (revision !== rebuildRevision || !wanted) return;
      const photoData = buildPhotoData(sourceImage);
      imageAspect = photoData.aspect;
      planeWidth = imageAspect >= 1 ? 3.8 : 3.05 * imageAspect;
      planeHeight = planeWidth / imageAspect;

      disposeRenderable(portalSurface, fieldGroup);
      disposeRenderable(particles, fieldGroup);
      sourceTexture?.dispose();
      depthTexture?.dispose();
      sourceTexture = new THREE.CanvasTexture(photoData.source);
      sourceTexture.colorSpace = THREE.SRGBColorSpace;
      sourceTexture.minFilter = THREE.LinearFilter;
      sourceTexture.magFilter = THREE.LinearFilter;
      depthTexture = new THREE.CanvasTexture(photoData.depthCanvas);
      depthTexture.colorSpace = THREE.NoColorSpace;
      depthTexture.minFilter = THREE.LinearFilter;
      depthTexture.magFilter = THREE.LinearFilter;
      makePortalSurface();
      makeParticles(photoData);
      if (!fitPortal()) throw new Error("empty_photo_bounds");
      introStartedAt = performance.now();
      introProgress = reducedMotion.matches ? 1 : 0;
      settledSent = false;
      startAnimation();
      onSupportChange(true);
    } catch (error) {
      if (revision === rebuildRevision) markUnavailable(error);
    }
  }

  function start({ forceRebuild = false } = {}) {
    wanted = true;
    if (!supported() || reducedMotion.matches) {
      canvas.hidden = true;
      return false;
    }
    if (renderer && particleState && !forceRebuild) {
      fitPortal();
      startAnimation();
      return true;
    }
    rebuildRevision += 1;
    rebuild(rebuildRevision);
    return true;
  }

  function stop({ keepWanted = false } = {}) {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    active = false;
    wanted = keepWanted;
    canvas.hidden = true;
    canvas.dataset.engineState = keepWanted ? "paused" : "stopped";
  }

  function reset() {
    stop();
    rebuildRevision += 1;
    disposeRenderable(portalSurface, fieldGroup);
    disposeRenderable(particles, fieldGroup);
    portalSurface = null;
    particles = null;
    particleState = null;
    sourceTexture?.dispose();
    depthTexture?.dispose();
    sourceTexture = null;
    depthTexture = null;
    audioTarget = 0;
    audioLevel = 0;
    pointerTarget = { x: 0, y: 0, active: false };
    pointerCurrent = { x: 0, y: 0, active: false };
  }

  const handleContextLost = (event) => {
    event.preventDefault();
    stop({ keepWanted: true });
    unavailable = true;
    onSupportChange(false);
  };
  const handleContextRestored = () => {
    unavailable = false;
    renderer = null;
    scene = null;
    camera = null;
    fieldGroup = null;
    portalSurface = null;
    particles = null;
    particleState = null;
    if (wanted) start({ forceRebuild: true });
  };
  canvas?.addEventListener?.("webglcontextlost", handleContextLost);
  canvas?.addEventListener?.("webglcontextrestored", handleContextRestored);

  return {
    start,
    replay() {
      if (!wanted) wanted = true;
      if (!particleState) return start({ forceRebuild: true });
      resetParticlePositions();
      introStartedAt = performance.now();
      introProgress = 0;
      settledSent = false;
      startAnimation();
      return true;
    },
    resize() {
      if (!wanted || reducedMotion.matches) return false;
      if (!renderer || !particleState) return start();
      const resized = fitPortal();
      if (resized && !active) startAnimation();
      return resized;
    },
    stop,
    reset,
    setPointer(clientX, clientY, pointerActive = true) {
      const bounds = host.getBoundingClientRect();
      pointerTarget = {
        x: clamp((clientX - bounds.left) / Math.max(1, bounds.width) * 2 - 1, -1, 1),
        y: clamp(1 - (clientY - bounds.top) / Math.max(1, bounds.height) * 2, -1, 1),
        active: pointerActive
      };
    },
    clearPointer() {
      pointerTarget = { x: 0, y: 0, active: false };
    },
    setListening(next) {
      listening = Boolean(next);
      if (!listening) audioTarget = 0;
    },
    setAudioLevel(level) {
      audioTarget = clamp(Number(level) || 0);
    },
    isSupported: supported,
    destroy() {
      reset();
      canvas?.removeEventListener?.("webglcontextlost", handleContextLost);
      canvas?.removeEventListener?.("webglcontextrestored", handleContextRestored);
      renderer?.dispose();
      renderer = null;
    }
  };
}

export { SETTINGS, THREE_MODULE_URL };
