import { blocked, validateCollision, moveWithCollision } from "./collision.mjs";
const PLAYCANVAS_URL = "./vendor/playcanvas.min.mjs";
const DEFAULT_MANIFEST_URL = "";

const ui = {
  shell: document.querySelector(".shell"),
  viewport: document.querySelector(".viewport"),
  canvas: document.querySelector("#sceneCanvas"),
  sceneName: document.querySelector("#sceneName"),
  anchorTitle: document.querySelector("#anchorTitle"),
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
  worldPhotos: [],
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
  closePhotoComparison();
  if (!state.camera) return;
  const [minimum, maximum] = fovRange();
  state.camera.camera.fov = clamp(value, minimum, maximum);
  syncFovUI();
}

function adjustFov(deltaDegrees) {
  if (!state.camera || state.transition) return;
  closePhotoComparison();
  setFov(state.camera.camera.fov + deltaDegrees);
}

function syncModeUI() {
  const walking = state.navigationMode === "walk";
  ui.navigationMode.textContent = walking ? "自由行走" : state.navigationMode === "inspection" ? "检查机位" : "照片机位";
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
  if (!Array.isArray(manifest?.photoAnchors)) {
    errors.push("photoAnchors must be an array (empty when no photos are visible)");
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
  errors.push(...validateCollision(manifest?.navigation?.collision,manifest?.sceneRevisionId));
  if (!errors.length && manifest.navigation.collision?.enabled) {
    for (const pose of [start]) if (blocked(pose.position,manifest.navigation.collision)) errors.push("起点或照片机位位于碰撞体内，请在碰撞设置中修正。");
  }
  if (errors.length) throw new Error(`Invalid scene manifest: ${errors.join("; ")}`);
}

async function loadManifest() {
  const query = new URLSearchParams(window.location.search);
  const requested = query.get("scene") || DEFAULT_MANIFEST_URL;
  if (!/^\/(?:scene-results\/result_[a-f0-9]{32}|space-scene-media\/(?:account|invitation)\/[A-Za-z0-9_-]{1,128}\/result_[a-f0-9]{32})\/scene\.json$/.test(requested)) throw new Error("请从场景管理页打开已保存的版本。");
  const url = new URL(requested, window.location.href);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Scene manifest returned HTTP ${response.status}`);
  const manifest = await response.json();
  manifest.sceneAsset.required = true;
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
  ui.anchorAction.disabled = false;
  ui.mapAnchor.hidden = false;
  ui.mapAnchor.style.display = "";
  ui.anchorRevision.textContent = anchor.sceneRevisionId;
  ui.anchorRevision.title = anchor.sceneRevisionId;
  ui.anchorPosition.textContent = anchor.position.map((value) => value.toFixed(2)).join(" / ");
  ui.anchorPosition.title = `[${anchor.position.join(", ")}]`;
  let viewOriginal = document.querySelector("#viewOriginalPhoto");
  if (!viewOriginal) {
    viewOriginal = document.createElement("button");
    viewOriginal.id = "viewOriginalPhoto";
    viewOriginal.type = "button";
    viewOriginal.textContent = "查看原图";
    ui.photoAnchorList.after(viewOriginal);
    viewOriginal.addEventListener("click", () => {
      const anchor = state.anchor;
      if (!anchor?.originalUrl) return;
      openOriginalPhoto(anchor, viewOriginal);
    });
  }
  viewOriginal.hidden = !anchor.originalUrl;
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

function openOriginalPhoto(anchor, returnFocus) {
  state.keys.clear();
  const dialog = document.createElement("dialog");
  dialog.className = "photo-original-dialog";
  dialog.setAttribute("aria-label", "查看原图与缩放");
  const toolbar = document.createElement("div");
  toolbar.className = "photo-image-toolbar";
  const stage = document.createElement("div");
  stage.className = "photo-image-stage";
  stage.setAttribute("aria-label", "滚轮或双指缩放，拖动查看细节");
  const image = document.createElement("img");
  image.alt = anchor.label;
  image.draggable = false;
  const readout = document.createElement("output");
  readout.textContent = "加载中…";
  readout.setAttribute("aria-live", "polite");
  let scale = 1, fit = 1, x = 0, y = 0;
  const pointers = new Map();
  const render = () => {
    const limitX = Math.max(0, (image.naturalWidth * scale - stage.clientWidth) / 2);
    const limitY = Math.max(0, (image.naturalHeight * scale - stage.clientHeight) / 2);
    x = clamp(x, -limitX, limitX); y = clamp(y, -limitY, limitY);
    image.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${scale})`;
    readout.textContent = `${Math.round(scale * 100)}%`;
    dialog.dataset.imageScale = String(scale);
    dialog.dataset.imageOffset = `${x},${y}`;
  };
  const zoom = (value, clientX, clientY) => {
    if (!image.naturalWidth) return;
    const rect = stage.getBoundingClientRect();
    const px = clientX === undefined ? 0 : clientX - rect.left - rect.width / 2;
    const py = clientY === undefined ? 0 : clientY - rect.top - rect.height / 2;
    const next = clamp(value, fit, Math.max(8, fit));
    x = px - (px-x)*next/scale; y = py - (py-y)*next/scale;
    scale = next; render();
  };
  const reset = () => {
    if (!image.naturalWidth) return;
    fit = Math.min(1, stage.clientWidth/image.naturalWidth, stage.clientHeight/image.naturalHeight);
    scale = fit; x = 0; y = 0; render();
  };
  const button = (label, action) => {
    const control = document.createElement("button");
    control.type = "button"; control.textContent = label;
    control.addEventListener("click", action); toolbar.append(control);
    return control;
  };
  button("缩小", () => zoom(scale/1.4));
  button("放大", () => zoom(scale*1.4));
  button("适应窗口", reset);
  button("100% 原尺寸", () => zoom(1));
  toolbar.append(readout);
  const original = document.createElement("a");
  original.textContent = "新窗口打开原图";
  original.href = relativeAssetUrl(anchor.originalUrl);
  original.target = "_blank"; original.rel = "noopener noreferrer";
  toolbar.append(original);
  const close = button("关闭原图，继续漫游", () => dialog.close());
  stage.append(image); dialog.append(toolbar, stage);
  stage.addEventListener("wheel", event => {
    event.preventDefault(); zoom(scale*Math.exp(-event.deltaY*0.002), event.clientX, event.clientY);
  }, {passive:false});
  stage.addEventListener("dblclick", event => {
    if (scale > fit*1.05) reset(); else zoom(Math.max(1,fit*2),event.clientX,event.clientY);
  });
  stage.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    event.preventDefault(); stage.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, {x:event.clientX,y:event.clientY});
  });
  stage.addEventListener("pointermove", event => {
    if (!pointers.has(event.pointerId)) return;
    const previous = [...pointers.values()];
    const old = pointers.get(event.pointerId);
    pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
    const current = [...pointers.values()];
    if (current.length === 2) {
      const distance = p => Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y);
      const before = distance(previous), after = distance(current);
      if (before > 0) zoom(scale*after/before,(current[0].x+current[1].x)/2,(current[0].y+current[1].y)/2);
    } else if (current.length === 1) {
      x += event.clientX-old.x; y += event.clientY-old.y; render();
    }
  });
  for (const name of ["pointerup","pointercancel","lostpointercapture"]) stage.addEventListener(name,event => pointers.delete(event.pointerId));
  dialog.addEventListener("keydown", event => {
    if (["+","=","-","0"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      if (event.key === "0") reset(); else zoom(scale*(event.key === "-" ? 1/1.4 : 1.4));
    }
  });
  image.addEventListener("load",reset);
  image.addEventListener("error",()=>{readout.textContent="原图加载失败，请重新打开";});
  const resize = new ResizeObserver(reset); resize.observe(stage);
  dialog.addEventListener("close",()=>{resize.disconnect();dialog.remove();returnFocus?.focus();});
  document.body.append(dialog); dialog.showModal(); close.focus();
  image.src = relativeAssetUrl(anchor.originalUrl);
}

function eligiblePhotoAnchor(anchor) {
  return (state.manifest.browseOnly || anchor.id !== "start") && anchor.sceneRevisionId === state.manifest.sceneRevisionId && !anchor.revoked && anchor.visible !== false && (!anchor.status || anchor.status === "ready");
}

function configurePhotoAnchorButtons() {
  ui.photoAnchorList.replaceChildren();
  ui.worldAnchor.hidden = true;
  state.worldPhotos.forEach(({button}) => button.remove());
  state.worldPhotos = [];
  for (const anchor of state.manifest.photoAnchors) {
    if (!eligiblePhotoAnchor(anchor)) continue;
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
    hint.textContent = state.manifest.browseOnly ? "回到浏览起点 · 无定位地图" : "回到照片机位";
    caption.append(label, hint);
    button.append(caption);
    button.addEventListener("click", () => {
      selectPhotoAnchor(anchor);
      if (state.camera) {
        beginPoseTransition(anchor, "photo-anchor", `已回到 ${anchor.label} 的拍摄视角`);
      }
    });
    ui.photoAnchorList.append(button);
    if (anchor.thumbnail && !state.manifest.browseOnly) {
      const hotspot = button.cloneNode(true);
      hotspot.className = "world-photo";
      hotspot.hidden = true;
      hotspot.setAttribute("aria-label", `回到照片：${anchor.label}`);
      let down = null;
      hotspot.addEventListener("pointerdown", event => { down = [event.clientX, event.clientY]; event.stopPropagation(); });
      hotspot.addEventListener("click", event => {
        if (event.detail && down && Math.hypot(event.clientX-down[0], event.clientY-down[1]) > 8) return;
        if (hotspot.cluster?.length > 1) {
          event.stopPropagation();
          openScenePhotoPicker(hotspot.cluster.map(item => item.anchor), "选择重叠位置的照片");
          return;
        }
        event.stopPropagation();
        if (event.detail && down && Math.hypot(event.clientX-down[0], event.clientY-down[1]) > 8) return;
        selectPhotoAnchor(anchor);
        beginPoseTransition(anchor, "photo-anchor", "已回到拍摄视角，可查看原图");
      });
      ui.viewport.append(hotspot);
      state.worldPhotos.push({anchor, button: hotspot});
    }
  }
}

function clearPhotoSelection() {
  state.transition = null;
  state.anchor = null;
  ui.anchorAction.disabled = true;
  const original = document.querySelector("#viewOriginalPhoto");
  if (original) original.hidden = true;
  ui.anchorPosition.textContent = "—";
  ui.anchorFov.textContent = "—";
  ui.mapAnchor.hidden = true;
  ui.mapAnchor.style.display = "none";
  closePhotoComparison();
  document.querySelectorAll(".photo-original-dialog,.photo-cluster-dialog").forEach(d => d.close());
}

function invalidatePhotos(message) {
  state.manifest.photoAnchors = [];
  delete state.manifest.defaultPhotoAnchorId;
  clearPhotoSelection();
  configurePhotoAnchorButtons();
  showDemoNote(message);
}

let refreshingPhotos = false;
async function refreshPhotoAnchors() {
  if (refreshingPhotos || document.hidden || !state.manifestUrl || !state.camera) return;
  refreshingPhotos = true;
  try {
    const response = await fetch(state.manifestUrl, {cache: "no-store"});
    if (response.status === 401 || response.status === 403) {
      invalidatePhotos("照片访问权限已失效，请重新打开空间。");
      return;
    }
    if (!response.ok) return;
    const latest = await response.json();
    validateManifest(latest);
    if (latest.sceneRevisionId !== state.manifest.sceneRevisionId) {
      invalidatePhotos("空间版本已更新，请重新打开空间。");
      return;
    }
    if (JSON.stringify(latest.photoAnchors) === JSON.stringify(state.manifest.photoAnchors)) return;
    const selectedId = state.anchor?.id;
    clearPhotoSelection();
    state.manifest.photoAnchors = latest.photoAnchors;
    if (latest.defaultPhotoAnchorId) state.manifest.defaultPhotoAnchorId = latest.defaultPhotoAnchorId;
    else delete state.manifest.defaultPhotoAnchorId;
    configurePhotoAnchorButtons();
    const selected = latest.photoAnchors.find(a => a.id === selectedId && eligiblePhotoAnchor(a));
    const fallback = latest.photoAnchors.find(eligiblePhotoAnchor);
    if (selected || fallback) selectPhotoAnchor(selected || fallback);
    else showDemoNote("当前没有可见照片，可以继续漫游。");
  } catch { /* Transient network loss leaves the current scene usable. */ }
  finally { refreshingPhotos = false; }
}
window.setInterval(refreshPhotoAnchors, 5000);
document.addEventListener("visibilitychange", refreshPhotoAnchors);

function configureManifestUI() {
  const { manifest } = state;
  const nav = manifest.navigation;
  const initialAnchor =
    manifest.photoAnchors.find((anchor) => eligiblePhotoAnchor(anchor) && anchor.id === manifest.defaultPhotoAnchorId) ||
    manifest.photoAnchors.find(eligiblePhotoAnchor) || {...nav.startPose, id: "browse-entry", label: "浏览起点", sceneRevisionId: manifest.sceneRevisionId};
  state.walkY = nav.eyeHeight;
  ui.sceneName.textContent = manifest.name;
  if (manifest.browseOnly) {
    ui.anchorTitle.textContent = "浏览起点（无照片定位地图）";
    ui.anchorAction.textContent = "回到浏览起点";
    ui.anchorAction.setAttribute("aria-label", "回到浏览起点（非照片定位）");
    ui.worldAnchor.setAttribute("aria-label", "回到浏览起点（非照片定位）");
  }
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
  if (!manifest.photoAnchors.some(eligiblePhotoAnchor) && !manifest.browseOnly) clearPhotoSelection();
  if (state.worldPhotos.length) showDemoNote("点击空间里的照片缩略图，回到拍摄视角并查看原图；重叠照片可展开选择。视角复位可回到入口。");
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
  if (!sceneAsset?.url) throw new Error("场景模型缺失，请回到场景管理重新上传。");

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

// The photo is a world-space plane; only its controls are screen-space UI.
let photoComparison = null;
function closePhotoComparison() {
  if (!photoComparison) return;
  const comparison = photoComparison;
  photoComparison = null;
  comparison.image.onload = comparison.image.onerror = null;
  comparison.entity?.destroy();
  comparison.material?.destroy();
  comparison.texture?.destroy();
  if (comparison.layer) {
    state.app.scene.layers.remove(comparison.layer);
    state.camera.camera.layers = state.camera.camera.layers.filter(id => id !== comparison.layer.id);
  }
  delete ui.canvas.dataset.worldPhoto;
  delete ui.canvas.dataset.worldPhotoProjection;
  comparison.root.remove();
  ui.viewport.classList.remove("comparing-photo");
}

function openScenePhotoPicker(anchors, title = "选择同一空间的其他视角") {
  const dialog = document.createElement("dialog");
  dialog.className = "photo-cluster-dialog";
  dialog.setAttribute("aria-label", title);
  const heading = document.createElement("h2");
  heading.textContent = title;
  dialog.append(heading);
  anchors.filter(eligiblePhotoAnchor).forEach((anchor, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "photo-anchor-button";
    button.dataset.photoAnchorId = anchor.id;
    button.setAttribute("aria-label", `选择照片 ${index + 1}`);
    const image = document.createElement("img");
    image.src = relativeAssetUrl(anchor.thumbnail || anchor.originalUrl);
    image.alt = "";
    const caption = document.createElement("strong");
    caption.textContent = `照片 ${index + 1}`;
    button.append(image, caption);
    button.addEventListener("click", () => {
      dialog.close();
      selectPhotoAnchor(anchor);
      beginPoseTransition(anchor, "photo-anchor", "已回到这张照片的拍摄位置");
    });
    dialog.append(button);
  });
  const close = document.createElement("button");
  close.textContent = "关闭选择";
  close.addEventListener("click", () => dialog.close());
  dialog.append(close);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  state.keys.clear();
  dialog.showModal();
}

function openPhotoComparison(anchor) {
  closePhotoComparison();
  if (!anchor.originalUrl || !eligiblePhotoAnchor(anchor)) return;
  const root = document.createElement("section");
  root.className = "photo-comparison";
  root.setAttribute("aria-label", "场景中的照片");

  const img = document.createElement("img");
  img.alt = anchor.label || "拍摄原图";
  img.draggable = false;
  img.style.opacity = "1";

  const toolbar = document.createElement("div");
  toolbar.className = "photo-comparison-toolbar";
  const photos = state.manifest.photoAnchors.filter(a => eligiblePhotoAnchor(a) && a.originalUrl);
  const index = photos.findIndex(a => a.id === anchor.id);
  const label = document.createElement("strong");
  label.textContent = `照片 ${index + 1} / ${photos.length} · 空间照片`;
  const otherViews = document.createElement("button");
  otherViews.type = "button";
  otherViews.textContent = "选择其他视角";
  otherViews.hidden = photos.length < 2;
  otherViews.onclick = () => openScenePhotoPicker(photos);
  const original = document.createElement("button");
  original.type = "button"; original.textContent = "放大查看原图";
  original.onclick = () => openOriginalPhoto(anchor, original);
  const close = document.createElement("button");
  close.type = "button"; close.textContent = "收起照片，继续漫游";
  close.onclick = () => { closePhotoComparison(); resumePhotoWalk(); };
  toolbar.append(label, otherViews, original, close);
  root.append(toolbar);
  const comparison = {root, image: img};
  photoComparison = comparison;
  ui.viewport.append(root);
  ui.viewport.classList.add("comparing-photo");
  img.onload = () => {
    if (photoComparison !== comparison) return;
    const pc = state.pc;
    // A final opaque pass keeps the photo readable over transparent splats.
    // It remains a perspective-projected world plane, not measured scene depth.
    const layer = new pc.Layer({name: "World photo", clearDepthBuffer: true});
    comparison.layer = layer;
    state.app.scene.layers.pushOpaque(layer);
    state.camera.camera.layers = [...state.camera.camera.layers, layer.id];
    const texture = new pc.Texture(state.app.graphicsDevice, {mipmaps: true});
    comparison.texture = texture;
    texture.setSource(img);
    const material = new pc.StandardMaterial();
    comparison.material = material;
    material.useLighting = false;
    material.useTonemap = false;
    material.emissive = new pc.Color(1, 1, 1);
    material.emissiveMap = texture;
    material.diffuse = new pc.Color(0, 0, 0);
    material.blendType = pc.BLEND_NONE;
    material.opacity = 1;
    material.cull = pc.CULLFACE_NONE;
    material.depthTest = false;
    material.depthWrite = false;
    material.update();
    const entity = new pc.Entity("Anchored photo " + anchor.id);
    comparison.entity = entity;
    entity.addComponent("render", {type: "plane", material, layers: [layer.id], castShadows: false, receiveShadows: false});
    const rotation = new pc.Quat(...anchor.quaternion);
    const forward = rotation.transformVector(new pc.Vec3(0, 0, -1));
    const bounds = state.manifest.navigation.boundaryXZ;
    const span = Math.min(Math.max(...bounds.map(p => p[0])) - Math.min(...bounds.map(p => p[0])), Math.max(...bounds.map(p => p[1])) - Math.min(...bounds.map(p => p[1])));
    const distance = Math.max(state.camera.camera.nearClip * 4, span * 0.12);
    const height = 2 * distance * Math.tan(anchor.fov * Math.PI / 360);
    entity.setPosition(...anchor.position.map((v, i) => v + [forward.x, forward.y, forward.z][i] * distance));
    // PlayCanvas plane is XZ; rotate its +Y normal to camera-local +Z.
    entity.setRotation(rotation.mul(new pc.Quat().setFromEulerAngles(90, 0, 0)));
    entity.setLocalScale(height * img.naturalWidth / img.naturalHeight, 1, height);
    state.app.root.addChild(entity);
    ui.canvas.dataset.worldPhoto = JSON.stringify({id: anchor.id, position: entity.getPosition().toArray(), rotation: entity.getRotation().toArray(), scale: entity.getLocalScale().toArray(), width: img.naturalWidth, height: img.naturalHeight, distance});
    root.dataset.loaded = "true";
  };
  img.onerror = () => {
    if (photoComparison !== comparison) return;
    closePhotoComparison();
    showDemoNote("原图暂时无法加载，可重试打开照片。");
  };
  img.src = relativeAssetUrl(anchor.originalUrl);
}

function setCameraPose(pose, mode = "photo-anchor") {
  const { pc, camera } = state;
  if (blocked(pose.position,state.manifest.navigation.collision)) {
    announcePhotoReturn("这个机位位于碰撞体内，请先修正碰撞设置。"); return;
  }
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
  closePhotoComparison();
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
  const collision=state.manifest.navigation.collision;
  state.walkY = collision?.enabled ? collision.floorY+collision.eyeOffset : state.manifest.navigation.eyeHeight;
  state.navigationMode = "walk";
  state.pitch = 0;
  state.yaw = yaw;
  const target=[position[0],state.walkY,position[2]];
  if(blocked(target,state.manifest.navigation.collision)) {
    const safe=state.manifest.navigation.startPose.position;target[0]=safe[0];target[2]=safe[2];
  }
  state.camera.setPosition(...target);
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
  if (!state.camera || !pose) return;
  if(blocked(pose.position,state.manifest.navigation.collision)) {
    announcePhotoReturn("照片机位与碰撞设置冲突，请先修正后回位。");return;
  }
  closePhotoComparison();
  const currentPosition = state.camera.getPosition();
  const collision=state.manifest.navigation.collision;
  if(collision?.enabled) {
    const reached=moveWithCollision([currentPosition.x,currentPosition.y,currentPosition.z],[pose.position[0]-currentPosition.x,pose.position[2]-currentPosition.z],collision);
    if(Math.hypot(reached[0]-pose.position[0],reached[2]-pose.position[2])>1e-5) {
      state.transition=null;setCameraPose(pose,mode);announcePhotoReturn("已直接回到安全的照片机位");
      if(mode==="photo-anchor")openPhotoComparison(pose);return;
    }
  }
  const currentRotation = state.camera.getRotation();
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion) {
    state.transition = null;
    setCameraPose(pose, mode);
    announcePhotoReturn(completionMessage);
    if (mode === "photo-anchor") openPhotoComparison(pose);
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
    if (transition.finalMode === "photo-anchor") openPhotoComparison(transition.finalPose);
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

function resumePhotoWalk() {
  if (!state.camera) return;
  state.transition = null;
  const collision=state.manifest.navigation.collision;
  state.walkY = collision?.enabled ? collision.floorY+collision.eyeOffset : state.camera.getPosition().y;
  if(blocked([state.camera.getPosition().x,state.walkY,state.camera.getPosition().z],collision)){enterFreeWalk(state.manifest.navigation.startPose);return;}
  state.navigationMode = "walk";
  state.yaw = levelYawDegrees();
  state.pitch = Math.asin(clamp(state.camera.forward.y, -1, 1)) * 180 / Math.PI;
  syncModeUI();
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
    if (photoComparison) resumePhotoWalk(); else enterFreeWalk();
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
  const next=moveWithCollision([position.x,state.walkY,position.z],[dx,dz],state.manifest.navigation.collision,boundary);
  if(pointInPolygon(next[0],next[2],boundary))state.camera.setPosition(...next);
}

function updateCameraLook(dx, dy) {
  if (!state.camera || state.transition) return;
  if (state.navigationMode !== "walk") {
    if (photoComparison) resumePhotoWalk(); else enterFreeWalk();
  }
  const sensitivity = state.manifest.navigation.lookSensitivity || 0.11;
  state.yaw -= dx * sensitivity;
  state.pitch = clamp(state.pitch - dy * sensitivity, -75, 75);
  state.camera.setEulerAngles(state.pitch, state.yaw, 0);
}

function updateReadouts(dt) {
  if (!state.camera) return;
  const position = state.camera.getPosition();
  const rotation = state.camera.getRotation();
  if (photoComparison?.entity) {
    const entity = photoComparison.entity;
    const screen = state.camera.camera.worldToScreen(entity.getPosition());
    ui.canvas.dataset.worldPhotoProjection = JSON.stringify({matrix: Array.from(entity.getWorldTransform().data), screen: [screen.x, screen.y, screen.z]});
  }
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
  ui.worldAnchor.hidden = true;
  if (!state.camera || !state.app) return;
  const bounds = ui.canvas.getBoundingClientRect();
  const occupied = [];
  for (const {anchor, button} of state.worldPhotos) { button.cluster = null; button.querySelector("strong").textContent = anchor.label; button.setAttribute("aria-label", `回到照片：${anchor.label}`); }
  for (const {anchor, button} of state.worldPhotos) {
    const position = new state.pc.Vec3(...anchor.position);
    const direction = position.clone().sub(state.camera.getPosition());
    button.hidden = true;
    if (direction.dot(state.camera.forward) <= 0 || direction.length() < 0.03) continue;
    const screen = state.camera.camera.worldToScreen(position);
    let x = screen.x / state.app.graphicsDevice.width * bounds.width;
    let y = screen.y / state.app.graphicsDevice.height * bounds.height;
    if (x < 0 || x > bounds.width || y < 0 || y > bounds.height) continue;
    x = clamp(x, 48, bounds.width - 48);
    y = clamp(y, 48, bounds.height - 48);
    const group = occupied.find(p => Math.abs(p[0]-x) < 92 && Math.abs(p[1]-y) < 90);
    if (group) {
      group[2].cluster ||= [state.worldPhotos.find(item => item.button === group[2])];
      group[2].cluster.push({anchor,button});
      group[2].querySelector("strong").textContent = `${group[2].cluster.length} 张照片 · 展开`;
      group[2].setAttribute("aria-label", `展开 ${group[2].cluster.length} 张照片`);
      continue;
    }
    occupied.push([x,y,button]);
    button.style.left = `${x}px`;
    button.style.top = `${y}px`;
    button.hidden = false;
  }
}

function bindControls() {
  const movementKeys = new Set(["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"]);
  window.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    if (document.querySelector("dialog[open]") || event.target.closest?.("input, button, a, select, textarea")) return;
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
    beginPoseTransition(state.anchor, "photo-anchor", state.manifest.browseOnly ? "已回到浏览起点（非照片定位）" : "已回到这张照片的拍摄视角");
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
    if (state.manifest.navigation.startMode === "walk") {enterFreeWalk(state.manifest.navigation.startPose);setFov(defaultFov());}
    configureInspection();

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
    if (state.manifest.navigation.startMode === "photo-anchor" && state.anchor?.originalUrl) openPhotoComparison(state.anchor);
    ui.canvas.focus({ preventScroll: true });
  } catch (error) {
    console.error(error);
    setSceneState("error", "Viewer unavailable");
    setLoading(error.message || "Viewer failed to start");
    showDemoNote("The viewer could not start. Serve this folder over HTTP and check the browser console.");
  }
}

function configureInspection() {
  const nav=state.manifest.navigation,c=nav.collision;
  document.querySelector('#qualityStatus').textContent=state.manifest.qualityReview?.message||'预览级 · 画质尚待实际走动检查。';
  document.querySelector('#collisionStatus').textContent=c?.enabled?'碰撞已启用：已检查的墙体和家具；坐标未标定米制。':'未设置实体碰撞；地图边界仅限制行走范围。';
  const svg=document.querySelector('#navCollisions');
  if(c?.enabled)for(const p of c.proxies){
    const el=document.createElementNS('http://www.w3.org/2000/svg',p.kind==='wall'?'line':'rect');
    if(p.kind==='wall'){el.setAttribute('x1',p.a[0]);el.setAttribute('y1',p.a[1]);el.setAttribute('x2',p.b[0]);el.setAttribute('y2',p.b[1]);el.setAttribute('stroke-width',Math.max(p.thickness,c.radius*.25));el.setAttribute('stroke','#b75535');}
    else{el.setAttribute('x',p.min[0]);el.setAttribute('y',p.min[1]);el.setAttribute('width',p.max[0]-p.min[0]);el.setAttribute('height',p.max[1]-p.min[1]);el.setAttribute('fill','#b75535');el.setAttribute('fill-opacity','.45');}svg.append(el);
  }
  const group=document.querySelector('#inspectionViews');
  for(const pose of state.manifest.inspectionViews||[]) {
    const button=document.createElement('button');button.className='quiet-action';button.textContent=pose.label;
    button.onclick=()=>{closePhotoComparison();state.transition=null;setCameraPose(pose,'inspection');};group.append(button);
  }
  for(const angle of [-90,90,180]) {
    const button=document.createElement('button');button.className='quiet-action';button.textContent=`原地转向 ${angle}°`;
    button.onclick=()=>{closePhotoComparison();state.transition=null;state.yaw=levelYawDegrees()+angle;state.pitch=0;state.camera.setEulerAngles(0,state.yaw,0);state.navigationMode='inspection';syncModeUI();};group.append(button);
  }
  const path=location.pathname.split('/'),scene=path[1]==='view'?path[2]:null;
  const link=document.querySelector('#collisionSettings');if(scene){link.href='/navigation/'+encodeURIComponent(scene)+'/';link.hidden=false;}
}

initializeViewer();
