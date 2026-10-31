// 回见：把一张照片递给阿见，聊几句，留成一页。
import {
  appendTranscript,
  createVoiceInput,
  mergeTranscriptIntoEditableText
} from "/voice-input.js";
import { createSpatialPhoto, createSpatialResultField } from "/spatial-photo.js";
import { downloadBlob, renderMemoryPng, renderPosterPng } from "/export-memory.js";
import { createMemoryRecord, normalizeStyleId } from "/memory-product.js";
import { openMemoryStore } from "/memory-store.js";
import {
  limitPhotoFiles,
  photoId,
  selectionSummary,
  validatePhotoFile
} from "/photo-selection.js";
import {
  createZineBook,
  mountZinePreview,
  renderZinePagePngFiles,
  renderZineSharePng
} from "/zine-book.js";

const $ = (id) => document.getElementById(id);
const AGENT_STATES = ["entering", "seeing", "thinking", "asking", "closing"];
const DEGRADED_OBSERVATION = "阿见没有看清这张照片，所以不会猜。";
const DEGRADED_QUESTION = "你最想从哪里说起？";

const state = {
  photo: null,
  photos: [],
  pairs: [],
  facts: [],
  pending: null,
  initialObservation: "",
  degraded: false,
  requestId: 0,
  waitTimers: [],
  historyExpanded: false,
  editing: false,
  hasExported: false,
  resultShape: "memory-page",
  styleId: "evening-paper",
  zineBook: null,
  zineMount: null,
  activeMemoryId: null,
  targetCollectionId: null,
  uploadGeneration: 0
};

let effectStatusTimer = 0;
let voiceBaseText = "";
let voiceOutcome = "";
let exportObjectUrl = "";
let zineExportUrls = [];
const memoryStorePromise = openMemoryStore();

function clearExportDownload() {
  if (exportObjectUrl) URL.revokeObjectURL(exportObjectUrl);
  exportObjectUrl = "";
  for (const url of zineExportUrls) URL.revokeObjectURL(url);
  zineExportUrls = [];
  const fallback = $("download-fallback");
  fallback.hidden = true;
  fallback.removeAttribute("href");
  fallback.removeAttribute("download");
  $("export-status").textContent = "";
  $("export-status").hidden = true;
  $("zine-page-downloads")?.replaceChildren();
  if ($("zine-page-downloads")) $("zine-page-downloads").hidden = true;
}

function destroyZine() {
  state.zineMount?.destroy();
  state.zineMount = null;
  state.zineBook = null;
  $("zine-stage-slot")?.replaceChildren();
}

function setVoiceStatus(message, tone = "") {
  $("voice-status").textContent = message;
  $("voice-status").dataset.tone = tone;
}

function updateVoiceButton(active) {
  $("voice-toggle").setAttribute("aria-pressed", String(active));
  $("voice-toggle").classList.toggle("is-listening", active);
  $("voice-label").textContent = active ? "停" : "说";
  $("composer").classList.toggle("is-listening", active);
}

let spatialPhoto = null;
const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
const voiceInput = createVoiceInput({
  Recognition,
  onTranscript: ({ final, interim }) => {
    const transcript = appendTranscript(final, interim);
    $("answer").value = mergeTranscriptIntoEditableText(voiceBaseText, transcript);
    $("answer").dispatchEvent(new Event("input", { bubbles: true }));
    if (transcript) {
      voiceOutcome = "transcribed";
      setVoiceStatus(
        interim ? "正在听，也正在转成文字……" : "已经听到这句；说完后点“停”。",
        interim ? "listening" : "success"
      );
    }
  },
  onAudioLevel: (level) => {
    spatialPhoto?.setAudioLevel(level);
  },
  onState: (name) => {
    spatialPhoto?.setListening(name === "listening" || name === "processing");
    if (name === "listening") {
      voiceOutcome = "";
      updateVoiceButton(true);
      $("voice-toggle").disabled = false;
      $("answer").disabled = true;
      setVoiceStatus("正在听。说完后点“停”。", "listening");
      return;
    }
    if (name === "processing") {
      updateVoiceButton(false);
      $("voice-toggle").disabled = true;
      $("answer").disabled = true;
      setVoiceStatus("正在整理刚才的话……", "listening");
      return;
    }
    if (name === "complete") {
      updateVoiceButton(false);
      setVoiceStatus("已转成文字，改好后再点“说好了”。", "success");
      return;
    }
    updateVoiceButton(false);
    if (!$("composer").hidden && state.pending) {
      $("answer").disabled = false;
      $("voice-toggle").disabled = !voiceInput.isSupported();
    }
    if (voiceOutcome === "transcribed") {
      setVoiceStatus("已转成文字，改好后再点“说好了”。", "success");
      $("answer").focus({ preventScroll: true });
    } else if (!voiceOutcome) {
      setVoiceStatus(voiceInput.isSupported()
        ? "可以说，也可以打字；转写后还能改。"
        : "这个浏览器暂不支持语音转文字，可以继续打字。"
      );
    }
  },
  onError: (code) => {
    spatialPhoto?.setListening(false);
    voiceOutcome = "error";
    updateVoiceButton(false);
    const messages = {
      unsupported: "这个浏览器暂不支持语音转文字，可以继续打字。",
      "not-allowed": "没有麦克风权限，仍可以继续打字。",
      "service-not-allowed": "浏览器没有开放语音服务，仍可以继续打字。",
      "audio-capture": "没有找到可用的麦克风，仍可以继续打字。",
      "no-speech": "刚才没听清。可以再试一次，或直接打字。",
      network: "语音服务暂时连不上，仍可以继续打字。",
      aborted: "已停止语音输入，刚才转出的文字还在。",
      "start-failed": "语音输入暂时无法启动，仍可以继续打字。",
      unknown: "语音输入暂时不可用，仍可以继续打字。"
    };
    setVoiceStatus(messages[code] ?? messages.unknown, "error");
  }
});

spatialPhoto = createSpatialPhoto({
  stage: $("photo-stage"),
  image: $("chat-photo"),
  canvas: $("memory-particles"),
  onStatus: (message, options = {}) => {
    clearTimeout(effectStatusTimer);
    $("effect-note").textContent = message;
    $("effect-note").hidden = !message;
    if (message && options.transient) {
      effectStatusTimer = setTimeout(() => {
        $("effect-note").hidden = true;
      }, 4_500);
    }
  },
  onAvailabilityChange: (available) => {
    syncEffectControls(available);
  }
});

const spatialResultField = createSpatialResultField({
  stage: $("memory-page"),
  image: $("result-photo"),
  canvas: $("result-memory-particles")
});

const spatialScreenObserver = new MutationObserver(() => {
  if (document.body.dataset.screen !== "chat" && spatialPhoto.isEnabled()) setEffectMode("flat");
});
spatialScreenObserver.observe(document.body, { attributes: true, attributeFilter: ["data-screen"] });

function syncEffectControls(available = spatialPhoto.isAvailable()) {
  const enabled = available && spatialPhoto.isEnabled();
  $("effect-flat").setAttribute("aria-pressed", String(!enabled));
  $("effect-spatial").setAttribute("aria-pressed", String(enabled));
  $("effect-spatial").textContent = enabled ? "再看一次" : "记忆成型";
  $("effect-spatial").disabled = !available;
  $("effect-spatial").title = available
    ? (enabled ? "让这张照片重新成型" : "让照片成为一段记忆")
    : "当前设备暂不支持照片层次";
  $("spatial-badge").hidden = !enabled;
}

function setEffectMode(mode) {
  if (mode === "spatial") spatialPhoto.setEnabled(true);
  if (mode !== "spatial") spatialPhoto.setEnabled(false);
  syncEffectControls();
}

function show(screen) {
  if (screen !== "chat") voiceInput.cancel();
  for (const section of document.querySelectorAll(".screen")) {
    section.hidden = section.id !== `screen-${screen}`;
  }
  document.body.dataset.screen = screen;
  document.querySelector('meta[name="theme-color"]').content = "#050505";
  window.scrollTo({ top: 0, behavior: "auto" });
}

function clearWaitTimers() {
  for (const timer of state.waitTimers) clearTimeout(timer);
  state.waitTimers = [];
  $("speak-first").hidden = true;
}

function setAgentState(name, message = "") {
  const agent = $("chat-agent");
  for (const value of AGENT_STATES) agent.classList.remove(value);
  agent.classList.add(name);
  $("photo-frame").dataset.agentState = name;
  $("screen-chat").setAttribute("aria-busy", String(name === "seeing" || name === "thinking"));
  const labels = {
    seeing: "阿见正在看这张照片……",
    thinking: "阿见正在想下一句……",
    asking: "阿见正在问一个问题……",
    closing: "阿见正在把照片和原话放成一页……"
  };
  agent.setAttribute("aria-label", labels[name] ?? "阿见");
  $("status-text").textContent = message;
  $("status-text").hidden = !message;
  $("observation").textContent = state.initialObservation;
  $("observation").classList.toggle("is-degraded", state.degraded);
  $("observation").hidden = name !== "asking" || !state.initialObservation;
}

function clearPhotoError() {
  $("photo-error").textContent = "";
  $("photo-error").hidden = true;
}

function showPhotoError(message) {
  $("photo-error").textContent = message;
  $("photo-error").hidden = false;
}

function reset({ focus = true, keepCollection = false } = {}) {
  state.uploadGeneration += 1;
  clearWaitTimers();
  voiceInput.cancel();
  clearExportDownload();
  destroyZine();
  spatialPhoto.reset();
  spatialResultField.resetSession();
  setEffectMode("flat");
  state.photo = null;
  state.photos = [];
  state.pairs = [];
  state.facts = [];
  state.pending = null;
  state.initialObservation = "";
  state.degraded = false;
  state.historyExpanded = false;
  state.editing = false;
  state.hasExported = false;
  state.resultShape = "memory-page";
  state.styleId = "evening-paper";
  state.activeMemoryId = null;
  if (!keepCollection) {
    state.targetCollectionId = null;
    $("save-collection-name").value = "这一年";
  }
  state.requestId += 1;
  window.dispatchEvent(new CustomEvent("huijian:photo-session-ready", {
    detail: { photos: [] }
  }));
  $("photo-input").value = "";
  $("thread").replaceChildren();
  $("answer").value = "";
  $("finish-memory").hidden = true;
  $("history-summary").hidden = true;
  $("decision-panel").hidden = true;
  $("recovery-panel").hidden = true;
  $("export-status").hidden = true;
  $("download-zine-pages").hidden = true;
  clearPhotoError();
  show("start");
  if (focus) $("upload-start").focus({ preventScroll: true });
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("file_read_failed"));
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("image_decode_failed"));
    image.src = src;
  });
}

async function compactImage(file) {
  const validation = validatePhotoFile(file);
  if (validation) throw new Error(validation);
  const original = await readFile(file);
  const image = await loadImage(original);
  if (!image.naturalWidth || !image.naturalHeight) throw new Error("image_decode_failed");
  const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("image_decode_failed");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return {
    src: canvas.toDataURL("image/jpeg", .84),
    width: canvas.width,
    height: canvas.height
  };
}

async function startWithUpload(files) {
  const uploadGeneration = ++state.uploadGeneration;
  clearPhotoError();
  const { accepted, omittedCount } = limitPhotoFiles(files);
  const photos = [];
  let failedCount = 0;
  for (const [index, file] of accepted.entries()) {
    try {
      const compacted = await compactImage(file);
      if (uploadGeneration !== state.uploadGeneration) return;
      photos.push({
        id: photoId(file, index),
        ...compacted,
        capturedAt: file.lastModified || Date.now(),
        payload: { dataUrl: compacted.src }
      });
    } catch {
      if (uploadGeneration !== state.uploadGeneration) return;
      failedCount += 1;
    }
  }
  if (uploadGeneration !== state.uploadGeneration) return;
  if (!photos.length) {
    $("photo-input").value = "";
    showPhotoError("这些照片暂时打不开。请选择 JPG、PNG 或 WebP；HEIC 可先导出为 JPEG。");
    return;
  }
  $("photo-input").value = "";
  startConversation(photos[0], photos);
  if (failedCount || omittedCount) {
    $("effect-note").textContent = selectionSummary(photos, failedCount, omittedCount);
    $("effect-note").hidden = false;
  }
}

function startConversation(photo, photos = [photo]) {
  voiceInput.cancel();
  state.uploadGeneration += 1;
  state.requestId += 1;
  state.photo = photo;
  state.photos = photos;
  state.pairs = [];
  state.facts = [];
  state.pending = null;
  state.initialObservation = "";
  state.degraded = false;
  state.historyExpanded = false;
  state.editing = false;
  state.hasExported = false;
  state.resultShape = "memory-page";
  state.styleId = "evening-paper";
  state.activeMemoryId = null;
  clearExportDownload();
  destroyZine();
  spatialPhoto.reset();
  spatialResultField.resetSession();
  setEffectMode("flat");
  $("chat-photo").src = photo.src;
  window.dispatchEvent(new CustomEvent("huijian:photo-session-ready", {
    detail: {
      photos: photos.map(({ id, src }) => ({ id, src }))
    }
  }));
  $("thread").replaceChildren();
  $("answer").value = "";
  $("history-summary").hidden = true;
  clearPhotoError();
  show("chat");
  setEffectMode("spatial");
  $("screen-chat").focus({ preventScroll: true });
  requestQuestion();
}

function transcript() {
  return state.pairs.map((pair) => `问：${pair.question}\n答：${pair.answer}`).join("\n").slice(-500);
}

function observationFrom(facts) {
  const clean = facts
    .map((fact) => fact.trim().replace(/[。.!！]+$/u, ""))
    .filter(Boolean);
  return clean.length ? `阿见看到了：${clean.join("，")}。` : "";
}

function resetVoicePrompt() {
  voiceOutcome = "";
  updateVoiceButton(false);
  $("voice-toggle").disabled = !voiceInput.isSupported() || $("answer").disabled;
  setVoiceStatus(voiceInput.isSupported()
    ? "可以说，也可以打字；转写后还能改。"
    : "这个浏览器暂不支持语音转文字，可以继续打字。"
  );
}

function setQuestionControls(waiting) {
  voiceInput.cancel();
  $("current-turn").hidden = waiting;
  $("composer").hidden = waiting;
  $("commit-answer").hidden = waiting;
  $("quiet-actions").hidden = waiting && state.pairs.length === 0;
  $("quiet-actions").classList.toggle("is-single", waiting);
  $("answer").disabled = waiting;
  $("new-question").disabled = waiting;
  $("new-question").hidden = waiting;
  $("commit-answer").disabled = waiting || $("answer").value.trim().length === 0;
  $("finish-memory").hidden = state.pairs.length === 0;
  $("decision-panel").hidden = true;
  $("recovery-panel").hidden = true;
  resetVoicePrompt();
}

function startSeeingTimers(requestId) {
  clearWaitTimers();
  state.waitTimers.push(setTimeout(() => {
    if (requestId === state.requestId && $("chat-agent").classList.contains("seeing")) {
      setAgentState("seeing", "阿见还在看这张照片，不急。");
    }
  }, 6_000));
  state.waitTimers.push(setTimeout(() => {
    if (requestId === state.requestId && $("chat-agent").classList.contains("seeing")) {
      $("speak-first").hidden = false;
    }
  }, 20_000));
}

async function requestQuestion() {
  const requestId = ++state.requestId;
  const followup = state.pairs.length > 0;
  $("answer").value = "";
  $("question").hidden = true;
  $("degraded-note").hidden = true;
  setQuestionControls(true);
  setAgentState(
    followup ? "thinking" : "seeing",
    followup ? "阿见正在想下一句……" : "阿见正在看这张照片……"
  );
  if (!followup) startSeeingTimers(requestId);

  let result;
  try {
    const response = await fetch("/api/question", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        photo: state.photo.payload,
        kind: followup ? "followup_question" : "initial_question",
        userText: followup ? transcript() : undefined
      }),
      signal: AbortSignal.timeout(125_000)
    });
    if (!response.ok) throw new Error("question_failed");
    result = await response.json();
  } catch {
    result = { degraded: true };
  }

  if (requestId !== state.requestId) return;
  clearWaitTimers();
  const question = typeof result.question === "string" ? result.question.trim() : "";
  const degraded = Boolean(result.degraded) || !question;
  if (followup && degraded) return showRecovery();

  const facts = Array.isArray(result.facts)
    ? result.facts.filter((fact) => typeof fact === "string" && fact.trim()).slice(0, 2)
    : [];
  if (!followup) {
    state.degraded = degraded;
    state.facts = degraded ? [] : facts;
    state.initialObservation = degraded ? DEGRADED_OBSERVATION : observationFrom(facts);
  }
  state.pending = {
    question: degraded ? DEGRADED_QUESTION : question,
    degraded
  };
  showQuestion();
}

function showQuestion() {
  setQuestionControls(false);
  setAgentState("asking");
  $("question").textContent = state.pending.question;
  $("question").hidden = false;
  $("degraded-note").hidden = true;
  $("answer").focus();
}

function showRecovery() {
  clearWaitTimers();
  voiceInput.cancel();
  state.pending = null;
  setAgentState("asking");
  $("current-turn").hidden = true;
  $("composer").hidden = true;
  $("commit-answer").hidden = true;
  $("quiet-actions").hidden = true;
  $("decision-panel").hidden = true;
  $("recovery-panel").hidden = false;
}

function renderThread() {
  const fragment = document.createDocumentFragment();
  state.pairs.forEach((pair, index) => {
    const item = document.createElement("section");
    item.className = "history-item";
    const prompt = document.createElement("p");
    prompt.className = "history-question";
    prompt.textContent = pair.question;
    const label = document.createElement("label");
    label.className = "history-answer-label";
    label.textContent = "你的原话";
    const answer = document.createElement("textarea");
    answer.className = "history-answer";
    answer.rows = 2;
    answer.value = pair.answer;
    answer.setAttribute("aria-label", `第 ${index + 1} 段原话`);
    answer.addEventListener("input", (event) => {
      pair.answer = event.target.value;
      state.hasExported = false;
      clearExportDownload();
    });
    label.append(answer);
    item.append(prompt, label);
    fragment.append(item);
  });
  $("thread").replaceChildren(fragment);
  $("history-count").textContent = `已经写下 ${state.pairs.length} 段`;
  $("history-summary").hidden = state.pairs.length === 0;
  $("history-summary").setAttribute("aria-expanded", String(state.historyExpanded));
  $("history-toggle").textContent = state.historyExpanded ? "收起" : "展开";
  $("thread").hidden = !state.historyExpanded;
}

function commitAnswer() {
  const answer = $("answer").value.trim();
  if (!state.pending || !answer) return;
  voiceInput.cancel();
  state.pairs.push({ question: state.pending.question, answer });
  state.pending = null;
  state.hasExported = false;
  renderThread();
  if (state.pairs.length === 1) return showDecision();
  if (state.pairs.length === 2) return showDecision();
  finishMemory();
}

function showDecision({ editing = false } = {}) {
  clearWaitTimers();
  voiceInput.cancel();
  state.editing = editing;
  setAgentState("asking");
  $("current-turn").hidden = true;
  $("composer").hidden = true;
  $("commit-answer").hidden = true;
  $("quiet-actions").hidden = true;
  $("recovery-panel").hidden = true;
  $("decision-panel").hidden = false;
  $("decision-copy").textContent = editing
    ? "改好后，再把照片和原话放回这一页。"
    : "这张照片已经有故事了。再聊一句，还是开始做成品？";
  $("add-one").hidden = editing;
  $("decision-finish").textContent = editing ? "重新选择成品" : "开始做成品";
}

function finishMemory() {
  const unfinished = $("answer").value.trim();
  if (state.pending && unfinished) {
    state.pairs.push({ question: state.pending.question, answer: unfinished });
    renderThread();
  }
  if (state.pairs.length === 0) return;
  clearWaitTimers();
  voiceInput.cancel();
  state.requestId += 1;
  state.pending = null;
  setAgentState("closing", "阿见正在把照片和原话放成一页……照片和原话都会保持原样。");
  $("current-turn").hidden = true;
  $("composer").hidden = true;
  $("commit-answer").hidden = true;
  $("quiet-actions").hidden = true;
  $("decision-panel").hidden = true;
  $("recovery-panel").hidden = true;
  renderMemoryPage();
  const delay = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 650;
  setTimeout(() => {
    if (window.huijianProductShell?.openShapePicker) {
      window.huijianProductShell.openShapePicker();
    } else {
      show("result");
      $("memory-title").focus({ preventScroll: true });
    }
  }, delay);
}

function renderMemoryPage() {
  $("result-photo").src = state.photo.src;
  $("memory-date").textContent = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric"
  }).format(new Date());

  const fragment = document.createDocumentFragment();
  state.pairs.forEach((pair) => {
    const block = document.createElement("section");
    block.className = "memory-paragraph";
    const prompt = document.createElement("p");
    prompt.className = "memory-prompt";
    prompt.textContent = pair.question;
    const answer = document.createElement("p");
    answer.textContent = pair.answer;
    block.append(prompt, answer);
    fragment.append(block);
  });
  $("memory-writing").replaceChildren(fragment);
}

function zinePhotoInput(photo, index) {
  return {
    id: photo.id,
    src: photo.src,
    alt: index === 0 ? "主照片" : `第 ${index + 1} 张照片`,
    pairs: index === 0 ? state.pairs : []
  };
}

function mountCurrentZine() {
  destroyZine();
  state.zineBook = createZineBook({
    photos: state.photos.map(zinePhotoInput),
    shapeId: "zine",
    styleId: state.styleId,
    title: "回见",
    date: new Date().toISOString().slice(0, 10)
  });

  const slot = $("zine-stage-slot");
  const preview = document.createElement("div");
  preview.className = "zine-preview-frame";
  const pager = document.createElement("nav");
  pager.className = "zine-pager";
  pager.setAttribute("aria-label", "zine 翻页");
  const previous = document.createElement("button");
  previous.type = "button";
  previous.className = "secondary-action";
  previous.textContent = "← 上一页";
  const indicator = document.createElement("span");
  indicator.className = "zine-page-indicator";
  const next = document.createElement("button");
  next.type = "button";
  next.className = "secondary-action";
  next.textContent = "下一页 →";
  pager.append(previous, indicator, next);
  slot.replaceChildren(preview, pager);

  const syncPager = ({ pageNumber, pageCount, canPrevious, canNext }) => {
    indicator.textContent = `${pageNumber} / ${pageCount}`;
    previous.disabled = !canPrevious;
    next.disabled = !canNext;
  };
  state.zineMount = mountZinePreview({
    container: preview,
    book: state.zineBook,
    onPageChange: syncPager
  });
  syncPager(state.zineMount.controller.getState());
  previous.addEventListener("click", state.zineMount.controller.previous);
  next.addEventListener("click", state.zineMount.controller.next);
}

function applyProduct(shape, style) {
  state.resultShape = shape;
  state.styleId = normalizeStyleId(style);
  clearExportDownload();
  $("download-zine-pages").hidden = shape !== "zine";
  $("download-memory").textContent = shape === "zine" ? "保存平铺分享图" : "保存为图片";
  if (shape === "zine") mountCurrentZine();
  else destroyZine();
}

function editMemory() {
  clearExportDownload();
  state.hasExported = false;
  state.historyExpanded = true;
  renderThread();
  show("chat");
  showDecision({ editing: true });
  $("history-summary").focus({ preventScroll: true });
}

function startOverFromChat() {
  const hasDraft = state.pairs.length > 0 || $("answer").value.trim().length > 0;
  if (hasDraft && !window.confirm("这张照片还没留成一页。要放弃并重新选吗？")) return;
  reset();
}

async function downloadMemory() {
  const button = $("download-memory");
  button.disabled = true;
  clearExportDownload();
  $("export-status").textContent = "正在当前浏览器里生成图片……";
  $("export-status").hidden = false;
  try {
    let blob;
    if (state.resultShape === "zine" && state.zineBook) {
      blob = await renderZineSharePng(state.zineBook);
    } else if (state.resultShape === "poster") {
      blob = await renderPosterPng({
        photoSrc: state.photo.src,
        date: $("memory-date").textContent,
        pairs: state.pairs,
        styleId: state.styleId
      });
    } else {
      blob = await renderMemoryPng({
        photoSrc: state.photo.src,
        date: $("memory-date").textContent,
        title: $("memory-title").textContent,
        pairs: state.pairs,
        styleId: state.styleId
      });
    }
    const day = new Date().toISOString().slice(0, 10);
    const filename = state.resultShape === "zine" ? `回见-zine-${day}.png` : `回见-${day}.png`;
    exportObjectUrl = downloadBlob(blob, filename, $("download-fallback"));
    state.hasExported = true;
    $("export-status").textContent = "图片已在当前浏览器生成；如果没有自动下载，可以点“再次下载”。";
  } catch {
    $("export-status").textContent = "这次图片没有生成成功，可以先用“打印 / PDF”保存。";
  } finally {
    button.disabled = false;
  }
}

async function prepareZinePageDownloads() {
  if (!state.zineBook) return;
  const button = $("download-zine-pages");
  button.disabled = true;
  clearExportDownload();
  $("export-status").textContent = "正在当前浏览器里逐页生成图片……";
  $("export-status").hidden = false;
  try {
    const files = await renderZinePagePngFiles(state.zineBook);
    const fragment = document.createDocumentFragment();
    for (const file of files) {
      const url = URL.createObjectURL(file.blob);
      zineExportUrls.push(url);
      const link = document.createElement("a");
      link.href = url;
      link.download = file.filename;
      link.textContent = `下载第 ${file.pageIndex + 1} 页 · ${file.filename}`;
      link.addEventListener("click", () => { state.hasExported = true; }, { once: true });
      fragment.append(link);
    }
    $("zine-page-downloads").replaceChildren(fragment);
    $("zine-page-downloads").hidden = false;
    $("export-status").textContent = `已生成 ${files.length} 张逐页图片，点下面的页码分别保存。`;
  } catch {
    $("export-status").textContent = "逐页图片没有生成成功，可以先保存平铺分享图或打印 / PDF。";
  } finally {
    button.disabled = false;
  }
}

function localRecordId(prefix) {
  return `${prefix}:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function currentMemoryRecord(collectionId) {
  return createMemoryRecord({
    id: state.activeMemoryId ?? localRecordId("memory"),
    collectionId,
    photos: state.photos,
    facts: state.facts,
    pairs: state.pairs,
    resultShape: state.resultShape,
    styleId: state.styleId,
    createdAt: new Date().toISOString()
  });
}

async function resolveSaveCollection(store, name) {
  const collections = await store.listCollections();
  const target = state.targetCollectionId
    ? collections.find((collection) => collection.id === state.targetCollectionId)
    : null;
  if (target && target.name === name) return target;
  const existing = collections.find((collection) => collection.name === name);
  if (existing) return existing;
  return store.createCollection({ name, styleId: state.styleId });
}

function collectionForShell(collection) {
  return {
    ...collection,
    style: collection.styleId,
    coverSrc: collection.coverPhoto?.src ?? ""
  };
}

async function renderStoredLibrary(render) {
  const store = await memoryStorePromise;
  if (!store.available) {
    render({ collections: [] });
    const empty = $("library-empty")?.querySelector("h2");
    if (empty) empty.textContent = "这台浏览器暂时不能保存本机合集";
    return;
  }
  const collections = await store.listCollections();
  render({
    collections: collections
      .filter((collection) => Number(collection.memoryCount) > 0)
      .map(collectionForShell)
  });
}

function restoreStoredMemory(memory, collection) {
  state.uploadGeneration += 1;
  clearWaitTimers();
  voiceInput.cancel();
  clearExportDownload();
  destroyZine();
  spatialResultField.resetSession();
  state.photos = memory.photos.map((photo) => ({
    ...photo,
    payload: photo.src.startsWith("data:") ? { dataUrl: photo.src } : { file: photo.id }
  }));
  state.photo = state.photos[0];
  state.pairs = memory.pairs ?? [];
  state.facts = memory.facts ?? [];
  state.initialObservation = observationFrom(state.facts);
  state.degraded = false;
  state.pending = null;
  state.historyExpanded = false;
  state.editing = false;
  state.hasExported = true;
  state.activeMemoryId = memory.id;
  state.targetCollectionId = memory.collectionId;
  state.resultShape = memory.resultShape ?? "memory-page";
  state.styleId = normalizeStyleId(memory.styleId);
  $("save-collection-name").value = collection?.name || "这一年";
  $("chat-photo").src = state.photo.src;
  window.dispatchEvent(new CustomEvent("huijian:photo-session-ready", {
    detail: {
      photos: state.photos.map(({ id, src }) => ({ id, src }))
    }
  }));
  renderThread();
  renderMemoryPage();
  applyProduct(state.resultShape, state.styleId);
  window.huijianProductShell.showResult({
    shape: state.resultShape,
    style: state.styleId,
    zineReady: state.resultShape === "zine"
  });
}

async function handleCollectionAction(event) {
  event.preventDefault();
  const { action, collection, render } = event.detail;
  const store = await memoryStorePromise;
  if (!store.available || !collection?.id) {
    event.detail.fail?.("这台浏览器暂时不能修改本机合集。");
    return renderStoredLibrary(render);
  }
  if (action === "delete") {
    await store.deleteCollection(collection.id);
    await renderStoredLibrary(render);
    event.detail.complete?.();
    return;
  }
  if (action === "rename") {
    const name = window.prompt("给这个合集换个名字", collection.name ?? "");
    if (name?.trim()) await store.renameCollection(collection.id, name);
    return renderStoredLibrary(render);
  }
  if (action === "add") {
    const style = await store.resolveStyleForCollection(collection.id);
    reset({ keepCollection: true });
    state.targetCollectionId = collection.id;
    state.styleId = style;
    $("save-collection-name").value = collection.name;
    const option = document.querySelector(`input[name="result-style"][value="${style}"]`);
    if (option) option.checked = true;
    return;
  }
  const memories = await store.listMemories(collection.id);
  const memory = memories[0];
  if (!memory) return;
  restoreStoredMemory(memory, collection);
  if (action === "export") await downloadMemory();
}

window.addEventListener("huijian:product-confirm", (event) => {
  event.preventDefault();
  try {
    applyProduct(event.detail.shape, event.detail.style);
    event.detail.showResult({
      shape: state.resultShape,
      style: state.styleId,
      zineReady: state.resultShape === "zine"
    });
  } catch {
    $("product-status").textContent = "这个成品暂时没有排好，请换一种形态再试。";
  }
});

window.addEventListener("huijian:memory-save", async (event) => {
  event.preventDefault();
  try {
    const store = await memoryStorePromise;
    if (!store.available) return event.detail.fail("这台浏览器暂时不能保存本机合集，可以先下载图片。");
    const collection = await resolveSaveCollection(store, event.detail.collectionName);
    const saved = await store.saveMemory(currentMemoryRecord(collection.id), { collectionId: collection.id });
    state.activeMemoryId = saved.id;
    state.targetCollectionId = collection.id;
    state.hasExported = true;
    event.detail.complete(`已保存到本机合集“${collection.name}”。`);
  } catch {
    event.detail.fail("这次没有保存成功；你的当前成品还在，可以先下载图片。");
  }
});

window.addEventListener("huijian:library-request", (event) => {
  renderStoredLibrary(event.detail.render).catch(() => event.detail.render({ collections: [] }));
});

window.addEventListener("huijian:collection-action", (event) => {
  handleCollectionAction(event).catch(() => {
    event.detail.fail?.("这个本机合集刚才没有处理成功，请再试一次。");
    $("export-status").textContent = "这个本机合集刚才没有处理成功，请再试一次。";
    $("export-status").hidden = false;
  });
});

window.addEventListener("huijian:photos-selected", () => {
  state.uploadGeneration += 1;
  if (!state.targetCollectionId) return;
  const option = document.querySelector(`input[name="result-style"][value="${state.styleId}"]`);
  if (option) option.checked = true;
});

window.addEventListener("huijian:photo-selection-cancel", () => {
  state.uploadGeneration += 1;
  voiceInput.cancel();
});

window.addEventListener("huijian:selection-confirmed", (event) => {
  const files = Array.isArray(event.detail?.files) ? event.detail.files : [];
  if (!files.length) return;
  event.preventDefault();
  startWithUpload(files);
});

$("photo-input").addEventListener("change", (event) => {
  const files = [...event.target.files];
  if (files.length) startWithUpload(files);
});

$("upload-start").addEventListener("click", () => $("photo-input").click());
$("demo-start").addEventListener("click", () => {
  const photo = {
    id: "photo1_cheers.jpg",
    src: "/photos/photo1_cheers.jpg",
    capturedAt: Date.now(),
    payload: { file: "photo1_cheers.jpg" }
  };
  startConversation(photo, [photo]);
});

$("answer").addEventListener("input", (event) => {
  $("commit-answer").disabled = event.target.value.trim().length === 0;
  state.hasExported = false;
});
$("answer").addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") commitAnswer();
});

$("voice-toggle").addEventListener("click", () => {
  if (voiceInput.isActive()) {
    voiceInput.stop();
    return;
  }
  voiceBaseText = $("answer").value;
  voiceOutcome = "";
  voiceInput.start();
});
$("effect-flat").addEventListener("click", () => setEffectMode("flat"));
$("effect-spatial").addEventListener("click", () => {
  if (spatialPhoto.isEnabled()) spatialPhoto.replay();
  else {
    setEffectMode("spatial");
    spatialPhoto.replay();
  }
  syncEffectControls();
});
$("history-summary").addEventListener("click", () => {
  state.historyExpanded = !state.historyExpanded;
  renderThread();
});
$("speak-first").addEventListener("click", () => {
  state.requestId += 1;
  clearWaitTimers();
  state.degraded = true;
  state.initialObservation = "阿见还没看清这张照片。";
  state.pending = { question: DEGRADED_QUESTION, degraded: true };
  showQuestion();
});
$("commit-answer").addEventListener("click", commitAnswer);
$("new-question").addEventListener("click", requestQuestion);
$("finish-memory").addEventListener("click", finishMemory);
$("add-one").addEventListener("click", requestQuestion);
$("decision-finish").addEventListener("click", finishMemory);
$("retry-question").addEventListener("click", requestQuestion);
$("recovery-finish").addEventListener("click", finishMemory);
$("back-start").addEventListener("click", startOverFromChat);
$("download-memory").addEventListener("click", downloadMemory);
$("download-zine-pages").addEventListener("click", prepareZinePageDownloads);
$("edit-memory").addEventListener("click", editMemory);
$("restart").addEventListener("click", () => {
  const message = state.hasExported
    ? "要开始新的一张吗？"
    : "这一页还没保存。要放弃并开始新的一张吗？";
  if (window.confirm(message)) reset();
});
$("print-memory").addEventListener("click", () => {
  window.print();
});
for (const id of ["library-new-memory", "library-empty-start"]) {
  $(id).addEventListener("click", () => reset());
}
window.addEventListener("beforeunload", (event) => {
  if (!state.photo || state.hasExported) return;
  event.preventDefault();
  event.returnValue = "";
});

syncEffectControls();
reset({ focus: false });
memoryStorePromise.then((store) => {
  if (store.available) return;
  $("save-local-memory").disabled = true;
  $("save-local-memory").textContent = "本机存储不可用";
  $("save-local-memory").title = "仍可以把成品下载为图片或打印 / PDF";
});
