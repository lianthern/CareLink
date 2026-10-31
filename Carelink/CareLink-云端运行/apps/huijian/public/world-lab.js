const $ = (id) => document.getElementById(id);
const stage = $("world-stage");
const input = $("world-photo");
const drop = $("photo-drop");
const preview = $("photo-preview");
const sourceGrid = $("source-grid");
const replacePhoto = $("replace-photo");
const sourceSize = $("source-size");
const sourceKicker = $("source-kicker");
const coverageNote = $("coverage-note");
const modeMulti = $("mode-multi");
const modeSingle = $("mode-single");
const form = $("world-form");
const consent = $("public-consent");
const generateButton = $("generate-world");
const generateLabel = $("generate-label");
const formStatus = $("form-status");
const providerState = $("provider-state");
const generationState = $("generation-state");
const stateStep = $("state-step");
const stateTitle = $("state-title");
const stateCopy = $("state-copy");
const stateMeter = $("state-meter-fill");
const stateTime = $("state-time");
const result = $("world-result");
const viewerStatus = $("viewer-status");
const marbleLink = $("marble-link");
const fallbackMarbleLink = $("fallback-marble-link");
const viewerFallback = $("viewer-fallback");
const photoPortals = $("photo-portals");
const sourceOverlay = $("source-overlay");
const sourceOverlayImage = $("source-overlay-image");
const sourceOverlayLabel = $("source-overlay-label");
const closeSourceOverlay = $("close-source-overlay");
const worldBack = $("world-back");
const releaseMode = $("release-mode");
const worldEyebrow = $("world-eyebrow");
const worldTitle = $("world-title");
const worldIntroCopy = $("world-intro-copy");

const RESUME_KEY = "huijian.worldlabs.operation.v2";
const SOURCE_DB = "huijian-world-lab";
const SOURCE_STORE = "source-sets";
const SOURCE_RECORD = "latest";
const UNSEEN_HANDOFF_RECORD = "unseen-handoff";
const OPERATION_ID = /^[A-Za-z0-9_-]{8,128}$/u;
const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

let config = null;
let currentMode = "multi";
let preparedImages = [];
let pollTimer = null;
let elapsedTimer = null;
let generationStartedAt = 0;
let activeOperationId = null;
let isWorking = false;
let destroyViewer = null;

function showOnly(name) {
  drop.hidden = name !== "empty";
  preview.hidden = name !== "ready";
  generationState.hidden = name !== "generating";
  result.hidden = name !== "result";
  stage.dataset.state = name;
}

function setFormStatus(message, error = false) {
  formStatus.textContent = message;
  formStatus.classList.toggle("is-error", error);
}

function requiredCount() {
  return currentMode === "multi" ? Number(config?.minImages || 2) : 1;
}

function maximumCount() {
  return currentMode === "multi" ? Number(config?.maxImages || 8) : 1;
}

function hasEnoughPhotos() {
  return preparedImages.length >= requiredCount() && preparedImages.length <= maximumCount();
}

function syncGenerateButton() {
  const quotaAvailable = Number(config?.quota?.remainingToday) > 0;
  const ready = Boolean(config?.enabled && quotaAvailable && hasEnoughPhotos() && consent.checked && !isWorking);
  generateButton.disabled = !ready;
  modeMulti.disabled = isWorking;
  modeSingle.disabled = isWorking;
  $("world-model").disabled = isWorking;
  if (!config?.enabled) return setFormStatus("World Labs 密钥尚未启用；接线页可以查看，但现在不能发起生成。", true);
  if (!quotaAvailable) return setFormStatus("今天的公共体验名额已用完，明天会重新开放。", true);
  if (isWorking) return setFormStatus("世界正在生成，完成后会自动回到这里。");
  if (!hasEnoughPhotos()) {
    const missing = Math.max(0, requiredCount() - preparedImages.length);
    return setFormStatus(currentMode === "multi" ? `还需要 ${missing} 张同一场景照片。` : "先选一张有空间感的照片。");
  }
  if (!consent.checked) return setFormStatus("确认照片使用权与公开生成方式后即可开始。");
  setFormStatus(`准备就绪 · 今日公共体验还可生成 ${config.quota.remainingToday} 次`);
}

function renderSourceGrid() {
  sourceGrid.replaceChildren();
  preparedImages.forEach((photo, index) => {
    const card = document.createElement("div");
    card.className = `source-card${currentMode === "single" ? " is-single" : ""}`;
    const image = document.createElement("img");
    image.src = photo.dataUrl;
    image.alt = `源照片 ${index + 1}`;
    const label = document.createElement("span");
    label.textContent = `VIEW ${String(index + 1).padStart(2, "0")}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", `移除第 ${index + 1} 张照片`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      preparedImages.splice(index, 1);
      if (!preparedImages.length) showOnly("empty");
      renderSourceGrid();
      syncGenerateButton();
    });
    card.append(image, label, remove);
    sourceGrid.append(card);
  });

  const totalMegabytes = preparedImages.reduce((sum, photo) => sum + photo.bytes, 0) / 1024 / 1024;
  sourceSize.textContent = currentMode === "multi"
    ? `${preparedImages.length} / ${maximumCount()} · ${totalMegabytes.toFixed(1)} MB`
    : preparedImages[0] ? `${preparedImages[0].width} × ${preparedImages[0].height} · ${totalMegabytes.toFixed(1)} MB` : "0 / 1";
  replacePhoto.textContent = currentMode === "multi" && preparedImages.length < maximumCount() ? "继续添加" : "重新选择";
  coverageNote.textContent = currentMode === "multi"
    ? preparedImages.length < requiredCount() ? "至少需要 2 张；相邻画面有重叠，重建会更稳定。" : "这些照片会共同参与 Auto Layout 重建。"
    : "单图会补全画面外内容，更像有依据的再想象。";
}

function applyMode(mode, { clear = true } = {}) {
  if (mode !== "multi" && mode !== "single") return;
  currentMode = mode;
  if (clear) preparedImages = [];
  modeMulti.setAttribute("aria-pressed", String(mode === "multi"));
  modeSingle.setAttribute("aria-pressed", String(mode === "single"));
  input.multiple = mode === "multi";
  $("drop-index").textContent = mode === "multi" ? "01 / SAME-SCENE INPUT" : "01 / SINGLE IMAGE INPUT";
  $("drop-title").textContent = mode === "multi" ? "选择 2–8 张同一处地方" : "选择一张有空间感的照片";
  $("drop-help").textContent = mode === "multi"
    ? "围着空间移动拍摄，让相邻照片保留重叠 · JPG / PNG / WebP"
    : "房间、街道、展厅或风景 · JPG / PNG / WebP";
  sourceKicker.textContent = mode === "multi" ? "SAME PLACE · SOURCE VIEWS" : "2D SOURCE · IMAGINED WORLD";
  generateLabel.textContent = mode === "multi" ? "生成共同的 3D 场景" : "生成单图 3D 世界";
  releaseMode.textContent = mode === "multi" ? "01 · 同场景重建" : "01 · 单图补全";
  worldEyebrow.textContent = mode === "multi" ? "SAME PLACE · MANY VIEWS → ONE WORLD" : "ONE PHOTO · IMAGINED BEYOND THE FRAME";
  worldTitle.innerHTML = mode === "multi" ? "把几张照片，<br><span>放回同一个地方。</span>" : "从一张照片，<br><span>走到画面之外。</span>";
  worldIntroCopy.textContent = mode === "multi"
    ? "World Labs 会寻找照片之间的重叠并重建共同空间；原照片会保留为可随时打开的“照片入口”。"
    : "World Labs 会以这张照片为依据补全画面外空间；结果包含模型想象，不等同于真实现场复原。";
  if (clear) showOnly("empty");
  renderSourceGrid();
  syncGenerateButton();
}

function readAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("file_read_failed"));
    reader.readAsDataURL(blob);
  });
}

async function preparePhoto(file, mode) {
  if (!ACCEPTED_TYPES.has(file.type)) throw new Error("只支持 JPG、PNG 或 WebP。");
  if (file.size > 20 * 1024 * 1024) throw new Error("单张原照片不能超过 20 MB。");
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  if (Math.max(width, height) < 640) {
    bitmap.close();
    throw new Error("照片太小；请选择长边至少 640 像素的清晰照片。");
  }
  const maxEdge = mode === "multi" ? 1400 : 1600;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d", { alpha: false });
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const quality = mode === "multi" ? .82 : .88;
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  if (!blob) throw new Error("这张照片无法转换，请换一张。");
  if (blob.size > (config?.maxImageBytes || 6 * 1024 * 1024)) throw new Error("处理后的照片仍然太大，请换一张。");
  return {
    dataUrl: await readAsDataUrl(blob),
    width: canvas.width,
    height: canvas.height,
    bytes: blob.size
  };
}

async function selectPhotos(fileList) {
  const mode = currentMode;
  const files = [...fileList];
  if (!files.length) return;
  const slots = mode === "multi" ? Math.max(0, maximumCount() - preparedImages.length) : 1;
  const candidates = files.slice(0, slots);
  if (mode === "single") preparedImages = [];
  setFormStatus(`正在读取 ${candidates.length} 张照片…`);
  generateButton.disabled = true;
  const failures = [];
  for (const file of candidates) {
    try {
      preparedImages.push(await preparePhoto(file, mode));
    } catch (error) {
      failures.push(error?.message || "有一张照片无法读取。");
    }
  }
  input.value = "";
  if (currentMode !== mode) return;
  showOnly(preparedImages.length ? "ready" : "empty");
  renderSourceGrid();
  syncGenerateButton();
  if (files.length > candidates.length) setFormStatus(`最多选择 ${maximumCount()} 张，超出的照片没有加入。`, true);
  else if (failures.length) setFormStatus(failures[0], true);
}

function providerErrorMessage(code) {
  const messages = {
    worldlabs_not_configured: "World Labs 密钥尚未启用。",
    "WL-204": "生成暂时不可用（错误码：WL-204）。请稍后再试。",
    provider_auth_failed: "World Labs 密钥已经失效，需要重新配置。",
    provider_rate_limited: "World Labs 当前请求较多，请稍后再试。",
    visitor_daily_limit: "这台设备今天已经生成过一次，明天可以再来。",
    daily_limit: "今天的公共体验名额已用完，明天会重新开放。",
    public_consent_required: "请先确认照片使用权与公开生成方式。",
    input_mode_invalid: "生成模式不正确，请刷新后重试。",
    image_count_invalid: "同一场景模式需要 2–8 张照片。",
    image_size_invalid: "有一张照片数据太大，请换一张。",
    image_total_size_invalid: "这些照片合计太大，请减少照片或换更小的图片。"
  };
  return messages[code] || "生成没有开始，请稍后再试。";
}

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(providerErrorMessage(body.error));
    error.code = body.error;
    throw error;
  }
  return body;
}

function openSourceDb() {
  if (!globalThis.indexedDB) return Promise.reject(new Error("indexeddb_unavailable"));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SOURCE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(SOURCE_STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("indexeddb_open_failed"));
  });
}

async function saveSourceSet(operationId) {
  const db = await openSourceDb();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(SOURCE_STORE, "readwrite");
      transaction.objectStore(SOURCE_STORE).put({
        id: SOURCE_RECORD,
        operationId,
        mode: currentMode,
        model: $("world-model").value,
        images: preparedImages,
        savedAt: Date.now()
      });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("indexeddb_write_failed"));
    });
  } finally {
    db.close();
  }
}

async function loadSourceSet(operationId) {
  const db = await openSourceDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(SOURCE_STORE, "readonly").objectStore(SOURCE_STORE).get(SOURCE_RECORD);
      request.onsuccess = () => resolve(request.result?.operationId === operationId ? request.result : null);
      request.onerror = () => reject(request.error || new Error("indexeddb_read_failed"));
    });
  } finally {
    db.close();
  }
}

async function loadUnseenHandoff() {
  const db = await openSourceDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(SOURCE_STORE, "readwrite");
      const store = transaction.objectStore(SOURCE_STORE);
      const request = store.get(UNSEEN_HANDOFF_RECORD);
      request.onsuccess = () => {
        const record = request.result;
        if (record) store.delete(UNSEEN_HANDOFF_RECORD);
        resolve(record || null);
      };
      request.onerror = () => reject(request.error || new Error("indexeddb_read_failed"));
    });
  } finally {
    db.close();
  }
}

function updateElapsed() {
  const seconds = Math.max(0, Math.floor((Date.now() - generationStartedAt) / 1000));
  stateTime.textContent = `已等待 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const estimate = Math.min(92, 7 + (seconds / 300) * 78);
  stateMeter.style.width = `${estimate}%`;
}

function beginWaiting(operationId, startedAt = Date.now()) {
  clearTimeout(pollTimer);
  clearInterval(elapsedTimer);
  activeOperationId = operationId;
  isWorking = true;
  generationStartedAt = startedAt;
  showOnly("generating");
  stateStep.textContent = currentMode === "multi" ? "MULTI-IMAGE RECONSTRUCTION · IN PROGRESS" : "WORLD GENERATION · IN PROGRESS";
  stateTitle.textContent = currentMode === "multi" ? "几张照片正在对齐成一个地方" : "空间正在照片背后展开";
  stateCopy.textContent = "World Labs 通常需要约 5 分钟。你可以留在这里，也可以稍后用同一台设备回来。";
  stateMeter.style.width = "7%";
  updateElapsed();
  elapsedTimer = setInterval(updateElapsed, 1000);
  localStorage.setItem(RESUME_KEY, JSON.stringify({ operationId, startedAt, mode: currentMode }));
  const shareUrl = new URL(globalThis.location.href);
  shareUrl.searchParams.set("operation", operationId);
  shareUrl.searchParams.set("mode", currentMode);
  globalThis.history.replaceState(null, "", shareUrl);
  syncGenerateButton();
  void pollOperation(operationId);
}

async function pollOperation(operationId) {
  pollTimer = null;
  try {
    const { operation } = await api(`/api/worldlabs/operations/${encodeURIComponent(operationId)}`);
    if (operation.error) {
      localStorage.removeItem(RESUME_KEY);
      throw new Error(operation.error.message || "World Labs 没有完成这次生成。");
    }
    if (operation.done && operation.world) return showWorld(operation.world);
    if (operation.progress.description) stateCopy.textContent = operation.progress.description;
    pollTimer = setTimeout(() => void pollOperation(operationId), 8000);
  } catch (error) {
    clearInterval(elapsedTimer);
    isWorking = false;
    stateStep.textContent = "GENERATION · PAUSED";
    stateTitle.textContent = "这次生成暂时没接回来";
    stateCopy.textContent = error?.message || "稍后刷新页面，我们会继续检查同一次生成。";
    stateMeter.style.width = "100%";
    syncGenerateButton();
    setFormStatus(stateCopy.textContent, true);
  }
}

function openSourcePhoto(index) {
  const photo = preparedImages[index];
  if (!photo) return;
  sourceOverlayImage.src = photo.dataUrl;
  sourceOverlayLabel.textContent = `SOURCE PHOTO · ${String(index + 1).padStart(2, "0")} / ${String(preparedImages.length).padStart(2, "0")}`;
  sourceOverlay.hidden = false;
  closeSourceOverlay.focus();
}

function renderPhotoPortals() {
  photoPortals.replaceChildren();
  preparedImages.forEach((photo, index) => {
    const portal = document.createElement("button");
    portal.type = "button";
    portal.className = "photo-portal";
    portal.title = `打开源照片 ${index + 1}（非精确空间锚点）`;
    const image = document.createElement("img");
    image.src = photo.dataUrl;
    image.alt = "";
    const label = document.createElement("span");
    label.textContent = String(index + 1).padStart(2, "0");
    portal.append(image, label);
    portal.addEventListener("click", () => openSourcePhoto(index));
    photoPortals.append(portal);
  });
  photoPortals.hidden = preparedImages.length === 0;
}

async function showWorld(world) {
  clearTimeout(pollTimer);
  clearInterval(elapsedTimer);
  pollTimer = null;
  isWorking = false;
  showOnly("result");
  modeMulti.disabled = false;
  modeSingle.disabled = false;
  generateButton.disabled = true;
  setFormStatus("世界已经生成。场景边缘的照片入口可以随时打开原图，再回到 3D 空间。");
  renderPhotoPortals();
  const marbleUrl = world.marbleUrl || "https://marble.worldlabs.ai/";
  marbleLink.href = marbleUrl;
  fallbackMarbleLink.href = marbleUrl;
  viewerFallback.hidden = true;
  destroyViewer?.();
  try {
    const { mountWorldViewer } = await import("/world-viewer.js?v=20260903k");
    destroyViewer = await mountWorldViewer({
      container: $("world-viewer"),
      world,
      onStatus: (message) => { viewerStatus.textContent = message; }
    });
  } catch {
    viewerStatus.textContent = "站内查看器未载入";
    viewerFallback.hidden = false;
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (generateButton.disabled || !hasEnoughPhotos()) return;
  isWorking = true;
  syncGenerateButton();
  setFormStatus(currentMode === "multi" ? "正在把同一场景照片交给 World Labs…" : "正在把照片交给 World Labs…");
  showOnly("generating");
  try {
    await api("/api/worldlabs/jobs");
    const { operation } = await api("/api/worldlabs/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: currentMode,
        model: $("world-model").value,
        images: preparedImages.map((photo) => photo.dataUrl),
        displayName: $("world-name").value,
        prompt: $("world-prompt").value,
        publicConsent: consent.checked
      })
    });
    if (config?.quota) config.quota.remainingToday = Math.max(0, Number(config.quota.remainingToday) - 1);
    await saveSourceSet(operation.id).catch(() => {});
    beginWaiting(operation.id);
  } catch (error) {
    isWorking = false;
    showOnly("ready");
    setFormStatus(error?.message || "生成没有开始，请稍后再试。", true);
    syncGenerateButton();
  }
});

input.addEventListener("change", () => void selectPhotos(input.files || []));
replacePhoto.addEventListener("click", () => {
  if (currentMode === "single" || preparedImages.length >= maximumCount()) {
    preparedImages = [];
    renderSourceGrid();
  }
  input.click();
});
modeMulti.addEventListener("click", () => applyMode("multi"));
modeSingle.addEventListener("click", () => applyMode("single"));
consent.addEventListener("change", syncGenerateButton);
closeSourceOverlay.addEventListener("click", () => { sourceOverlay.hidden = true; });
sourceOverlay.addEventListener("click", (event) => {
  if (event.target === sourceOverlay) sourceOverlay.hidden = true;
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !sourceOverlay.hidden) sourceOverlay.hidden = true;
});
worldBack.addEventListener("click", (event) => {
  try {
    const referrer = new URL(document.referrer);
    if (referrer.origin === globalThis.location.origin && referrer.pathname.startsWith("/unseen-demo")) {
      event.preventDefault();
      globalThis.history.back();
    }
  } catch {}
});

async function start() {
  try {
    config = await api("/api/worldlabs/config");
    $("world-model").value = config.recommendedModel || config.model;
    providerState.textContent = config.enabled ? `已连接 · World Labs` : "等待密钥";
    providerState.classList.toggle("is-live", config.enabled);
    providerState.classList.toggle("is-error", !config.enabled);
  } catch {
    config = { enabled: false };
    providerState.textContent = "接线不可用";
    providerState.classList.add("is-error");
  }

  const search = new URLSearchParams(globalThis.location.search);
  const fromUnseen = search.get("source") === "unseen-demo";
  const linkedOperationId = search.get("operation");
  const linkedMode = search.get("mode") === "single" ? "single" : "multi";
  let pending;
  try { pending = JSON.parse(localStorage.getItem(RESUME_KEY)); } catch { pending = null; }
  if (fromUnseen && linkedMode === "single") {
    const handoff = await loadUnseenHandoff().catch(() => null);
    const fresh = handoff && Date.now() - Number(handoff.savedAt) < 15 * 60 * 1000;
    if (fresh && handoff.images?.length === 1) {
      preparedImages = handoff.images;
      applyMode("single", { clear: false });
      showOnly("ready");
      renderSourceGrid();
      syncGenerateButton();
      if (config.enabled) setFormStatus("已从回忆时刻带入当前照片；确认说明后即可生成。", false);
      return;
    }
  }
  if (config.enabled && OPERATION_ID.test(linkedOperationId || "")) {
    const stored = await loadSourceSet(linkedOperationId).catch(() => null);
    if (stored?.images?.length) preparedImages = stored.images;
    applyMode(stored?.mode === "single" ? "single" : linkedMode, { clear: false });
    return beginWaiting(linkedOperationId, Number(pending?.startedAt) || Date.now());
  }
  const resumable = pending?.operationId && Date.now() - Number(pending.startedAt) < 24 * 60 * 60 * 1000;
  if (config.enabled && resumable) {
    const stored = await loadSourceSet(pending.operationId).catch(() => null);
    if (stored?.images?.length) {
      preparedImages = stored.images;
      applyMode(stored.mode === "single" ? "single" : "multi", { clear: false });
    } else {
      applyMode(pending.mode === "single" ? "single" : "multi", { clear: false });
    }
    return beginWaiting(pending.operationId, Number(pending.startedAt));
  }
  if (pending && !resumable) localStorage.removeItem(RESUME_KEY);
  applyMode(linkedMode, { clear: false });
}

void start();
