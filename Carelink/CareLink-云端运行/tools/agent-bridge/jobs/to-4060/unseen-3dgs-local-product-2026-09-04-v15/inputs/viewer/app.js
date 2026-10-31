const PLAYCANVAS_URL = "./vendor/playcanvas.min.mjs";
const DEFAULT_MANIFEST_URL = "./scene.json";

const ui = {
  shell: document.querySelector(".shell"),
  viewport: document.querySelector(".viewport"),
  canvas: document.querySelector("#sceneCanvas"),
  sceneName: document.querySelector("#sceneName"),
  sceneState: document.querySelector("#sceneState"),
  fps: document.querySelector("#fpsValue"),
  loading: document.querySelector("#loadingPanel"),
  loadingText: document.querySelector("#loadingText"),
  modeNote: document.querySelector("#modeNote"),
  modeNoteText: document.querySelector("#modeNoteText"),
  navigationMode: document.querySelector("#navigationMode"),
  speedMode: document.querySelector("#speedMode"),
  fovValue: document.querySelector("#fovValue"),
  zoomValue: document.querySelector("#zoomValue"),
  zoomInAction: document.querySelector("#zoomInAction"),
  zoomOutAction: document.querySelector("#zoomOutAction"),
  eyeHeight: document.querySelector("#eyeHeight"),
  helpEyeHeight: document.querySelector("#helpEyeHeight"),
  coordinate: document.querySelector("#coordinateReadout"),
  navBoundary: document.querySelector("#navBoundary"),
  navTrail: document.querySelector("#navTrail"),
  mapCamera: document.querySelector("#mapCamera"),
  mapAnchor: document.querySelector("#mapAnchor"),
  anchorRevision: document.querySelector("#anchorRevision"),
  anchorPosition: document.querySelector("#anchorPosition"),
  anchorFov: document.querySelector("#anchorFov"),
  photoAnchorList: document.querySelector("#photoAnchorList"),
  anchorAction: document.querySelector("#anchorAction"),
  worldAnchor: document.querySelector("#worldAnchor"),
  freeWalkAction: document.querySelector("#freeWalkAction"),
  homeAction: document.querySelector("#homeAction"),
  helpAction: document.querySelector("#helpAction"),
  helpSheet: document.querySelector("#helpSheet"),
  closeHelp: document.querySelector("#closeHelp"),
  joystick: document.querySelector("#joystick"),
  joystickKnob: document.querySelector("#joystickKnob")
};

const state = {
  pc: null,
  app: null,
  camera: null,
  manifest: null,
  manifestUrl: null,
  anchor: null,
  yaw: 0,
  pitch: 0,
  keys: new Set(),
  joystick: { x: 0, y: 0, pointerId: null },
  lookPointerId: null,
  lastLook: null,
  transition: null,
  navigationMode: "photo-anchor",
  walkY: null,
  mapMarkerScale: 1,
  path: [],
  lastPathPosition: null,
  fpsFrames: 0,
  fpsElapsed: 0
};

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function fovRange() {
  const configured = state.manifest?.navigation?.fovRangeDegrees;
  if (
    Array.isArray(configured) &&
    configured.length === 2 &&
    configured.every(Number.isFinite) &&
    configured[0] < configured[1]
  ) {
    return configured;
  }
  return [30, 90];
}

function defaultFov() {
  const configured = state.manifest?.navigation?.defaultFov;
  return Number.isFinite(configured) ? configured : state.manifest.navigation.startPose.fov;
}

function syncFovUI() {
  if (!state.camera) return;
  const fov = state.camera.camera.fov;
  const base = defaultFov();
  const zoom = Math.tan((base * Math.PI) / 360) / Math.tan((fov * Math.PI) / 360);
  ui.fovValue.textContent = fov.toFixed(1).replace(/\.0$/, "");
  ui.zoomValue.textContent = `${zoom.toFixed(2)}×`;
  ui.canvas.dataset.cameraFov = fov.toString();
}

function setFov(value) {
  if (!state.camera) return;
  const [minimum, maximum] = fovRange();
  state.camera.camera.fov = clamp(value, minimum, maximum);
  syncFovUI();
}

function adjustFov(deltaDegrees) {
  if (!state.camera || state.transition) return;
  setFov(state.camera.camera.fov + deltaDegrees);
}

function syncModeUI() {
  const walking = state.navigationMode === "walk";
  ui.navigationMode.textContent = walking ? "自由行走" : "照片机位";
  ui.shell.dataset.navigationMode = state.navigationMode;
}

function sprintMultiplier() {
  const configured = state.manifest?.navigation?.sprintMultiplier;
  return Number.isFinite(configured) && configured >= 1 ? configured : 3;
}

function syncSpeedUI() {
  const sprinting = state.keys.has("shift");
  const multiplier = sprinting ? sprintMultiplier() : 1;
  ui.speedMode.textContent = sprinting ? `冲刺 ${multiplier.toFixed(0)}×` : "正常 1×";
  ui.speedMode.dataset.tier = sprinting ? "sprint" : "normal";
  ui.canvas.dataset.speedTier = sprinting ? "sprint" : "normal";
}

function setLoading(message) {
  ui.loadingText.textContent = message;
}

function finishLoading() {
  ui.loading.classList.add("is-complete");
  window.setTimeout(() => {
    ui.loading.hidden = true;
  }, 220);
}

function setSceneState(kind, text) {
  ui.shell.dataset.sceneState = kind;
  ui.sceneState.textContent = text;
}

function showDemoNote(message) {
  ui.modeNoteText.textContent = message;
  ui.modeNote.hidden = false;
}

function validateManifest(manifest) {
  const errors = [];
  const isNumbers = (value, length) =>
    Array.isArray(value) && value.length === length && value.every(Number.isFinite);

  if (!manifest || typeof manifest !== "object") errors.push("manifest must be an object");
  if (!manifest?.sceneRevisionId) errors.push("sceneRevisionId is required");
  if (!manifest?.name) errors.push("name is required");
  if (!manifest?.navigation || !Number.isFinite(manifest.navigation.eyeHeight)) {
    errors.push("navigation.eyeHeight must be a number");
  }
  if (
    manifest?.navigation?.fovRangeDegrees !== undefined &&
    (!isNumbers(manifest.navigation.fovRangeDegrees, 2) ||
      manifest.navigation.fovRangeDegrees[0] >= manifest.navigation.fovRangeDegrees[1])
  ) {
    errors.push("navigation.fovRangeDegrees must be [minimum, maximum]");
  }
  if (
    manifest?.navigation?.sprintMultiplier !== undefined &&
    (!Number.isFinite(manifest.navigation.sprintMultiplier) || manifest.navigation.sprintMultiplier < 1)
  ) {
    errors.push("navigation.sprintMultiplier must be at least 1");
  }
  if (!Array.isArray(manifest?.navigation?.boundaryXZ) || manifest.navigation.boundaryXZ.length < 3) {
    errors.push("navigation.boundaryXZ needs at least three vertices");
  } else if (!manifest.navigation.boundaryXZ.every((point) => isNumbers(point, 2))) {
    errors.push("each boundary vertex must be [x, z]");
  }
  const start = manifest?.navigation?.startPose;
  if (!isNumbers(start?.position, 3) || !isNumbers(start?.quaternion, 4) || !Number.isFinite(start?.fov)) {
    errors.push("navigation.startPose requires position, quaternion and fov");
  }
  if (!Array.isArray(manifest?.photoAnchors) || manifest.photoAnchors.length < 1) {
    errors.push("at least one photo anchor is required");
  } else {
    for (const anchor of manifest.photoAnchors) {
      if (!anchor.sceneRevisionId || !isNumbers(anchor.position, 3) || !isNumbers(anchor.quaternion, 4) || !Number.isFinite(anchor.fov)) {
        errors.push("every photo anchor requires sceneRevisionId, position, quaternion and fov");
        break;
      }
    }
    if (
      manifest.defaultPhotoAnchorId &&
      !manifest.photoAnchors.some((anchor) => anchor.id === manifest.defaultPhotoAnchorId)
    ) {
      errors.push("defaultPhotoAnchorId must name an existing photo anchor");
    }
  }
  if (errors.length) throw new Error(`Invalid scene manifest: ${errors.join("; ")}`);
}

async function loadManifest() {
  const query = new URLSearchParams(window.location.search);
  const requested = query.get("scene") || DEFAULT_MANIFEST_URL;
  const url = new URL(requested, window.location.href);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Scene manifest returned HTTP ${response.status}`);
  const manifest = await response.json();
  validateManifest(manifest);
  state.manifestUrl = url;
  return manifest;
}

function relativeAssetUrl(path) {
  return new URL(path, state.manifestUrl).href;
}

function syncWalkHeightUI() {
  const walkY = Number.isFinite(state.walkY)
    ? state.walkY
    : state.manifest.navigation.eyeHeight;
  ui.eyeHeight.textContent = walkY.toFixed(2);
  ui.helpEyeHeight.textContent = walkY.toFixed(2);
}

function selectPhotoAnchor(anchor) {
  state.anchor = anchor;
  ui.anchorRevision.textContent = anchor.sceneRevisionId;
  ui.anchorRevision.title = anchor.sceneRevisionId;
  ui.anchorPosition.textContent = anchor.position.map((value) => value.toFixed(2)).join(" / ");
  ui.anchorPosition.title = `[${anchor.position.join(", ")}]`;
  ui.anchorFov.textContent = `${anchor.fov.toFixed(0)}°`;
  ui.mapAnchor.setAttribute(
    "transform",
    `translate(${anchor.position[0]} ${anchor.position[2]}) scale(${state.mapMarkerScale})`
  );
  for (const button of ui.photoAnchorList.querySelectorAll("[data-photo-anchor-id]")) {
    const active = button.dataset.photoAnchorId === anchor.id;
    button.setAttribute("aria-pressed", active ? "true" : "false");
    button.dataset.active = active ? "true" : "false";
  }
}

function configurePhotoAnchorButtons() {
  ui.photoAnchorList.replaceChildren();
  for (const anchor of state.manifest.photoAnchors) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "photo-anchor-button";
    button.dataset.photoAnchorId = anchor.id;
    button.setAttribute("aria-label", `Return to ${anchor.label}`);
    button.setAttribute("aria-pressed", "false");
    if (anchor.thumbnail) {
      const image = document.createElement("img");
      image.src = relativeAssetUrl(anchor.thumbnail);
      image.alt = "";
      image.loading = "eager";
      button.append(image);
    }
    const caption = document.createElement("span");
    const label = document.createElement("strong");
    label.textContent = anchor.label;
    const hint = document.createElement("small");
    hint.textContent = "回到照片机位";
    caption.append(label, hint);
    button.append(caption);
    button.addEventListener("click", () => {
      selectPhotoAnchor(anchor);
      if (state.camera) {
        beginPoseTransition(anchor, "photo-anchor", `已回到 ${anchor.label} 的拍摄视角`);
      }
    });
    ui.photoAnchorList.append(button);
  }
}

function configureManifestUI() {
  const { manifest } = state;
  const nav = manifest.navigation;
  const initialAnchor =
    manifest.photoAnchors.find((anchor) => anchor.id === manifest.defaultPhotoAnchorId) ||
    manifest.photoAnchors[0];
  state.walkY = nav.eyeHeight;
  ui.sceneName.textContent = manifest.name;
  syncWalkHeightUI();
  ui.navBoundary.setAttribute(
    "points",
    nav.boundaryXZ.map(([x, z]) => `${x},${z}`).join(" ")
  );
  const xs = nav.boundaryXZ.map(([x]) => x);
  const zs = nav.boundaryXZ.map(([, z]) => z);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...zs) - Math.min(...zs);
  const longestSpan = Math.max(width, height);
  const padding = longestSpan * 0.12 || 0.25;
  state.mapMarkerScale = Math.max(longestSpan / 8, 0.03);
  ui.navBoundary.ownerSVGElement.setAttribute(
    "viewBox",
    `${Math.min(...xs) - padding} ${Math.min(...zs) - padding} ${width + padding * 2} ${height + padding * 2}`
  );
  configurePhotoAnchorButtons();
  selectPhotoAnchor(initialAnchor);
}

function makeMaterial(pc, color) {
  const material = new pc.StandardMaterial();
  material.diffuse = new pc.Color(...color);
  material.emissive = new pc.Color(...color.map((value) => value * 0.72));
  material.metalness = 0;
  material.gloss = 0.18;
  material.update();
  return material;
}

function addBox(pc, app, name, position, scale, material) {
  const entity = new pc.Entity(name);
  entity.addComponent("render", { type: "box", material });
  entity.setPosition(...position);
  entity.setLocalScale(...scale);
  app.root.addChild(entity);
  return entity;
}

function buildPlaceholderRoom(pc, app) {
  const floor = makeMaterial(pc, [0.27, 0.36, 0.38]);
  const wall = makeMaterial(pc, [0.42, 0.51, 0.51]);
  const recess = makeMaterial(pc, [0.15, 0.23, 0.25]);
  const warm = makeMaterial(pc, [0.78, 0.54, 0.3]);

  addBox(pc, app, "Measured floor", [0, -0.04, 0.8], [6.7, 0.08, 6.8], floor);
  addBox(pc, app, "Back wall", [0, 1.45, -2.42], [6.7, 2.9, 0.08], wall);
  addBox(pc, app, "Left wall", [-3.22, 1.45, 0.8], [0.08, 2.9, 6.5], wall);
  addBox(pc, app, "Right return", [3.27, 1.45, -0.4], [0.08, 2.9, 4.1], wall);
  addBox(pc, app, "Sofa mass", [-1.25, 0.38, -1.35], [2.25, 0.72, 0.78], recess);
  addBox(pc, app, "Sofa back", [-1.25, 0.78, -1.67], [2.25, 0.82, 0.15], recess);
  addBox(pc, app, "Island", [1.7, 0.47, 0.15], [1.7, 0.94, 0.75], recess);
  addBox(pc, app, "Source frame plane", [1.44, 1.15, -2.35], [0.95, 0.72, 0.04], warm);

  for (let x = -3; x <= 3; x += 0.5) {
    addBox(pc, app, `Grid X ${x}`, [x, 0.012, 0.8], [0.009, 0.012, 6.6], wall);
  }
  for (let z = -2.3; z <= 4; z += 0.5) {
    addBox(pc, app, `Grid Z ${z}`, [0, 0.013, z], [6.55, 0.014, 0.009], wall);
  }
}

async function loadSceneAsset(pc, app) {
  const sceneAsset = state.manifest.sceneAsset;
  const query = new URLSearchParams(window.location.search);
  if (query.get("demo") === "1" || !sceneAsset?.url) {
    buildPlaceholderRoom(pc, app);
    setSceneState("demo", "DEMO / no splat");
    showDemoNote("Demo mode is active. Add assets/scene.sog, then reload without ?demo=1.");
    return false;
  }

  const assetUrl = relativeAssetUrl(sceneAsset.url);
  setLoading("Loading Gaussian Splat");
  const asset = new pc.Asset("UNSEEN scene", "gsplat", { url: assetUrl });
  app.assets.add(asset);

  try {
    await new Promise((resolve, reject) => {
      asset.once("load", resolve);
      asset.once("error", (error) => reject(error instanceof Error ? error : new Error(String(error))));
      app.assets.load(asset);
    });
    const splat = new pc.Entity("Scene Gaussian Splat");
    splat.setPosition(...(sceneAsset.position || [0, 0, 0]));
    splat.setEulerAngles(...(sceneAsset.rotationEuler || [0, 0, 0]));
    const scale = Number.isFinite(sceneAsset.scale) ? sceneAsset.scale : 1;
    splat.setLocalScale(scale, scale, scale);
    splat.addComponent("gsplat", { asset });
    app.root.addChild(splat);
    setSceneState("ready", "SOG ready");
    return true;
  } catch (error) {
    console.warn("Scene asset did not load; entering explicit navigation-shell mode.", error);
    if (sceneAsset.required) throw new Error(`Required scene asset failed: ${error.message}`);
    buildPlaceholderRoom(pc, app);
    setSceneState("demo", "DEMO / asset pending");
    showDemoNote(`No valid SOG was found at ${sceneAsset.url}. Navigation and anchor controls remain testable.`);
    return false;
  }
}

function pointInPolygon(x, z, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i];
    const [xj, zj] = polygon[j];
    const intersects = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function setCameraPose(pose, mode = "photo-anchor") {
  const { pc, camera } = state;
  camera.setPosition(...pose.position);
  camera.setRotation(new pc.Quat(...pose.quaternion));
  setFov(pose.fov);
  state.navigationMode = mode;
  if (mode === "walk") {
    state.walkY = pose.position[1];
    syncWalkHeightUI();
  }
  const euler = camera.getEulerAngles();
  state.pitch = euler.x;
  state.yaw = euler.y;
  syncModeUI();
}

function levelYawDegrees() {
  const forward = state.camera.forward;
  const horizontalLength = Math.hypot(forward.x, forward.z);
  if (horizontalLength > 1e-6) {
    return Math.atan2(-forward.x, -forward.z) * (180 / Math.PI);
  }
  return state.camera.getEulerAngles().y;
}

function enterFreeWalk(pose = null) {
  if (!state.camera) return;
  const position = pose?.position || (() => {
    const current = state.camera.getPosition();
    return [current.x, current.y, current.z];
  })();
  let yaw = levelYawDegrees();
  if (pose?.quaternion) {
    const rotation = new state.pc.Quat(...pose.quaternion);
    state.camera.setRotation(rotation);
    yaw = levelYawDegrees();
  }
  state.transition = null;
  state.walkY = state.manifest.navigation.eyeHeight;
  state.navigationMode = "walk";
  state.pitch = 0;
  state.yaw = yaw;
  state.camera.setPosition(position[0], state.walkY, position[2]);
  state.camera.setEulerAngles(0, state.yaw, 0);
  ui.modeNote.hidden = true;
  syncWalkHeightUI();
  syncModeUI();
}

function normalizedQuaternion(values) {
  const length = Math.hypot(...values) || 1;
  return values.map((value) => value / length);
}

function announcePhotoReturn(message) {
  if (!message) return;
  ui.modeNoteText.textContent = message;
  ui.modeNote.hidden = false;
}

function beginPoseTransition(pose, mode = "photo-anchor", completionMessage = null) {
  if (!state.camera) return;
  const currentPosition = state.camera.getPosition();
  const currentRotation = state.camera.getRotation();
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion) {
    state.transition = null;
    setCameraPose(pose, mode);
    announcePhotoReturn(completionMessage);
    return;
  }
  state.transition = {
    elapsed: 0,
    duration: 0.48,
    fromPosition: [currentPosition.x, currentPosition.y, currentPosition.z],
    toPosition: [...pose.position],
    fromQuaternion: [currentRotation.x, currentRotation.y, currentRotation.z, currentRotation.w],
    toQuaternion: pose.quaternion,
    fromFov: state.camera.camera.fov,
    toFov: pose.fov,
    finalPose: pose,
    finalMode: mode,
    completionMessage
  };
}

function updateTransition(dt) {
  const transition = state.transition;
  if (!transition) return false;
  transition.elapsed += dt;
  const linear = Math.min(1, transition.elapsed / transition.duration);
  const t = linear * linear * (3 - 2 * linear);
  const position = transition.fromPosition.map((value, index) =>
    value + (transition.toPosition[index] - value) * t
  );
  let toQuaternion = transition.toQuaternion;
  const dot = transition.fromQuaternion.reduce((sum, value, index) => sum + value * toQuaternion[index], 0);
  if (dot < 0) toQuaternion = toQuaternion.map((value) => -value);
  const rotation = normalizedQuaternion(
    transition.fromQuaternion.map((value, index) => value + (toQuaternion[index] - value) * t)
  );
  state.camera.setPosition(...position);
  state.camera.setRotation(new state.pc.Quat(...rotation));
  state.camera.camera.fov = transition.fromFov + (transition.toFov - transition.fromFov) * t;
  syncFovUI();
  if (linear >= 1) {
    setCameraPose(transition.finalPose, transition.finalMode);
    announcePhotoReturn(transition.completionMessage);
    state.transition = null;
  }
  return true;
}

function keyboardVector() {
  const isDown = (...keys) => keys.some((key) => state.keys.has(key));
  return {
    x: (isDown("d", "arrowright") ? 1 : 0) - (isDown("a", "arrowleft") ? 1 : 0),
    y: (isDown("s", "arrowdown") ? 1 : 0) - (isDown("w", "arrowup") ? 1 : 0)
  };
}

function normalMoveSpeed() {
  const nav = state.manifest.navigation;
  const xs = nav.boundaryXZ.map(([x]) => x);
  const zs = nav.boundaryXZ.map(([, z]) => z);
  const shortSpan = Math.min(
    Math.max(...xs) - Math.min(...xs),
    Math.max(...zs) - Math.min(...zs)
  );
  const configured = Number.isFinite(nav.moveSpeed) ? nav.moveSpeed : 0;
  return Math.max(configured, shortSpan * 0.5);
}

function updateMovement(dt) {
  if (!state.camera || updateTransition(dt)) return;
  const keyboard = keyboardVector();
  let inputX = keyboard.x + state.joystick.x;
  let inputY = keyboard.y + state.joystick.y;
  const inputLength = Math.hypot(inputX, inputY);
  if (inputLength > 1) {
    inputX /= inputLength;
    inputY /= inputLength;
  }
  if (Math.abs(inputX) < 0.001 && Math.abs(inputY) < 0.001) return;

  if (state.navigationMode !== "walk") {
    enterFreeWalk();
  }
  const position = state.camera.getPosition();
  const forward = state.camera.forward.clone();
  const right = state.camera.right.clone();
  forward.y = 0;
  right.y = 0;
  forward.normalize();
  right.normalize();
  const speed = normalMoveSpeed() * (state.keys.has("shift") ? sprintMultiplier() : 1);
  const dx = (forward.x * -inputY + right.x * inputX) * speed * dt;
  const dz = (forward.z * -inputY + right.z * inputX) * speed * dt;
  const boundary = state.manifest.navigation.boundaryXZ;
  let nextX = position.x;
  let nextZ = position.z;

  if (pointInPolygon(position.x + dx, position.z, boundary)) nextX = position.x + dx;
  if (pointInPolygon(nextX, position.z + dz, boundary)) nextZ = position.z + dz;
  state.camera.setPosition(nextX, state.walkY, nextZ);
}

function updateCameraLook(dx, dy) {
  if (!state.camera || state.transition) return;
  if (state.navigationMode !== "walk") enterFreeWalk();
  const sensitivity = state.manifest.navigation.lookSensitivity || 0.11;
  state.yaw -= dx * sensitivity;
  state.pitch = clamp(state.pitch - dy * sensitivity, -75, 75);
  state.camera.setEulerAngles(state.pitch, state.yaw, 0);
}

function updateReadouts(dt) {
  if (!state.camera) return;
  const position = state.camera.getPosition();
  const rotation = state.camera.getRotation();
  ui.canvas.dataset.navigationMode = state.navigationMode;
  ui.canvas.dataset.walkY = state.walkY.toString();
  ui.canvas.dataset.cameraPosition = [position.x, position.y, position.z].join(",");
  ui.canvas.dataset.cameraQuaternion = [rotation.x, rotation.y, rotation.z, rotation.w].join(",");
  const euler = state.camera.getEulerAngles();
  ui.canvas.dataset.cameraEuler = [euler.x, euler.y, euler.z].join(",");
  ui.canvas.dataset.moveSpeed = normalMoveSpeed().toString();
  syncFovUI();
  syncSpeedUI();
  ui.coordinate.textContent = `X ${position.x.toFixed(2)} · Z ${position.z.toFixed(2)}`;
  ui.mapCamera.setAttribute(
    "transform",
    `translate(${position.x} ${position.z}) rotate(${-state.yaw}) scale(${state.mapMarkerScale})`
  );

  const last = state.lastPathPosition;
  if (!last || Math.hypot(last[0] - position.x, last[1] - position.z) > 0.07) {
    state.path.push([position.x, position.z]);
    state.path = state.path.slice(-90);
    state.lastPathPosition = [position.x, position.z];
    ui.navTrail.setAttribute("points", state.path.map(([x, z]) => `${x},${z}`).join(" "));
  }

  state.fpsFrames += 1;
  state.fpsElapsed += dt;
  if (state.fpsElapsed >= 0.5) {
    ui.fps.textContent = Math.round(state.fpsFrames / state.fpsElapsed).toString();
    state.fpsFrames = 0;
    state.fpsElapsed = 0;
  }
}

function updateWorldAnchor() {
  if (!state.camera || !state.anchor || !state.app) return;
  const { pc } = state;
  const anchorPosition = new pc.Vec3(...state.anchor.position);
  const cameraPosition = state.camera.getPosition();
  const direction = anchorPosition.clone().sub(cameraPosition);
  const inFront = direction.dot(state.camera.forward) > 0 && direction.length() > 0.3;
  if (!inFront) {
    ui.worldAnchor.hidden = true;
    return;
  }
  const screen = state.camera.camera.worldToScreen(anchorPosition);
  const device = state.app.graphicsDevice;
  const x = (screen.x / device.width) * 100;
  const y = (screen.y / device.height) * 100;
  const visible = x > 4 && x < 96 && y > 5 && y < 95;
  ui.worldAnchor.hidden = !visible;
  if (visible) {
    ui.worldAnchor.style.left = `${x}%`;
    ui.worldAnchor.style.top = `${y}%`;
  }
}

function bindControls() {
  const movementKeys = new Set(["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"]);
  window.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    if (movementKeys.has(key)) {
      event.preventDefault();
      state.keys.add(key);
    }
    if (key === "shift") state.keys.add("shift");
    if (key === "0") {
      event.preventDefault();
      setFov(defaultFov());
    }
    if (key === "+" || key === "=") {
      event.preventDefault();
      adjustFov(-5);
    }
    if (key === "-" || key === "_") {
      event.preventDefault();
      adjustFov(5);
    }
    if (event.key === "Escape" && !ui.helpSheet.hidden) closeHelp();
  });
  window.addEventListener("keyup", (event) => state.keys.delete(event.key.toLowerCase()));
  window.addEventListener("blur", () => state.keys.clear());

  ui.canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    state.lookPointerId = event.pointerId;
    state.lastLook = [event.clientX, event.clientY];
    ui.canvas.setPointerCapture(event.pointerId);
    ui.canvas.focus({ preventScroll: true });
  });
  ui.canvas.addEventListener("pointermove", (event) => {
    if (event.pointerId !== state.lookPointerId || !state.lastLook) return;
    const dx = event.clientX - state.lastLook[0];
    const dy = event.clientY - state.lastLook[1];
    state.lastLook = [event.clientX, event.clientY];
    updateCameraLook(dx, dy);
  });
  const releaseLook = (event) => {
    if (event.pointerId === state.lookPointerId) {
      state.lookPointerId = null;
      state.lastLook = null;
    }
  };
  ui.canvas.addEventListener("pointerup", releaseLook);
  ui.canvas.addEventListener("pointercancel", releaseLook);
  ui.canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      if (event.deltaY !== 0) adjustFov(event.deltaY > 0 ? 5 : -5);
    },
    { passive: false }
  );
  ui.zoomInAction.addEventListener("click", () => adjustFov(-5));
  ui.zoomOutAction.addEventListener("click", () => adjustFov(5));

  const updateJoystick = (event) => {
    const rect = ui.joystick.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + 3.1 * 16;
    const maxRadius = 34;
    let dx = event.clientX - centerX;
    let dy = event.clientY - centerY;
    const distance = Math.hypot(dx, dy);
    if (distance > maxRadius) {
      dx = (dx / distance) * maxRadius;
      dy = (dy / distance) * maxRadius;
    }
    state.joystick.x = dx / maxRadius;
    state.joystick.y = dy / maxRadius;
    ui.joystickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
  };
  ui.joystick.addEventListener("pointerdown", (event) => {
    state.joystick.pointerId = event.pointerId;
    ui.joystick.setPointerCapture(event.pointerId);
    updateJoystick(event);
  });
  ui.joystick.addEventListener("pointermove", (event) => {
    if (event.pointerId === state.joystick.pointerId) updateJoystick(event);
  });
  const releaseJoystick = (event) => {
    if (event.pointerId !== state.joystick.pointerId) return;
    state.joystick = { x: 0, y: 0, pointerId: null };
    ui.joystickKnob.style.transform = "translate(0, 0)";
  };
  ui.joystick.addEventListener("pointerup", releaseJoystick);
  ui.joystick.addEventListener("pointercancel", releaseJoystick);

  const goToAnchor = () =>
    beginPoseTransition(state.anchor, "photo-anchor", "已回到这张照片的拍摄视角");
  ui.anchorAction.addEventListener("click", goToAnchor);
  ui.worldAnchor.addEventListener("click", goToAnchor);
  const resetFreeWalk = () => {
    enterFreeWalk(state.manifest.navigation.startPose);
    setFov(defaultFov());
  };
  ui.freeWalkAction.addEventListener("click", resetFreeWalk);
  ui.homeAction.addEventListener("click", resetFreeWalk);

  const openHelp = () => {
    ui.helpSheet.hidden = false;
    ui.helpAction.setAttribute("aria-expanded", "true");
    ui.closeHelp.focus();
  };
  window.closeHelp = closeHelp;
  function closeHelp() {
    ui.helpSheet.hidden = true;
    ui.helpAction.setAttribute("aria-expanded", "false");
    ui.helpAction.focus();
  }
  ui.helpAction.addEventListener("click", () => (ui.helpSheet.hidden ? openHelp() : closeHelp()));
  ui.closeHelp.addEventListener("click", closeHelp);
}

async function initializeViewer() {
  try {
    setLoading("Reading scene contract");
    state.manifest = await loadManifest();
    configureManifestUI();
    bindControls();

    setLoading("Starting PlayCanvas renderer");
    const pc = await import(PLAYCANVAS_URL);
    state.pc = pc;
    const app = new pc.Application(ui.canvas, {
      graphicsDeviceOptions: {
        antialias: false,
        alpha: false,
        powerPreference: "high-performance"
      }
    });
    state.app = app;
    // The viewer lives beside the control deck, not at document size. FILLMODE_NONE
    // lets CSS own the canvas box while resizeCanvas tracks that box's resolution.
    app.setCanvasFillMode(pc.FILLMODE_NONE);
    app.setCanvasResolution(pc.RESOLUTION_AUTO);
    app.scene.ambientLight = new pc.Color(0.42, 0.46, 0.46);
    const background = state.manifest.backgroundColor || [0.105, 0.15, 0.16];
    app.scene.exposure = 1;

    const camera = new pc.Entity("Walk camera");
    camera.addComponent("camera", {
      clearColor: new pc.Color(...background),
      nearClip: 0.03,
      farClip: 1000,
      fov: state.manifest.navigation.startPose.fov
    });
    app.root.addChild(camera);
    state.camera = camera;
    setCameraPose(state.manifest.navigation.startPose, "photo-anchor");
    if (state.manifest.navigation.startMode === "walk") enterFreeWalk(state.manifest.navigation.startPose);

    app.start();
    await loadSceneAsset(pc, app);
    app.on("update", (dt) => {
      updateMovement(Math.min(dt, 0.05));
      updateReadouts(dt);
      updateWorldAnchor();
    });

    const resize = () => app.resizeCanvas();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(ui.viewport);
    window.addEventListener("resize", resize);
    resize();
    finishLoading();
    ui.canvas.focus({ preventScroll: true });
  } catch (error) {
    console.error(error);
    setSceneState("error", "Viewer unavailable");
    setLoading(error.message || "Viewer failed to start");
    showDemoNote("The viewer could not start. Serve this folder over HTTP and check the browser console.");
  }
}

initializeViewer();
