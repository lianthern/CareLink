// 回见：把一张照片递给阿见，聊几句，留成一页。
const $ = (id) => document.getElementById(id);
const AGENT_STATES = ["entering", "seeing", "thinking", "asking", "closing"];
const MAX_QUESTIONS = 3;
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
const DEGRADED_OBSERVATION = "这张我没看清，所以我不猜。";
const DEGRADED_QUESTION = "你最想从哪里说起？";

const state = {
  photo: null,
  pairs: [],
  pending: null,
  initialObservation: "",
  degraded: false,
  requestId: 0,
  waitTimers: [],
  historyExpanded: false,
  editing: false
};

function show(screen) {
  for (const section of document.querySelectorAll(".screen")) {
    section.hidden = section.id !== `screen-${screen}`;
  }
  document.body.dataset.screen = screen;
  document.querySelector('meta[name="theme-color"]').content = screen === "result" ? "#e7e0d2" : "#142536";
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
    seeing: "阿见正在看照片",
    thinking: "阿见正在想下一句",
    asking: "阿见正在问一个问题",
    closing: "阿见正在把照片和原话放成一页"
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

function reset({ focus = true } = {}) {
  clearWaitTimers();
  state.photo = null;
  state.pairs = [];
  state.pending = null;
  state.initialObservation = "";
  state.degraded = false;
  state.historyExpanded = false;
  state.editing = false;
  state.requestId += 1;
  $("photo-input").value = "";
  $("thread").replaceChildren();
  $("answer").value = "";
  $("finish-memory").hidden = true;
  $("history-summary").hidden = true;
  $("decision-panel").hidden = true;
  $("recovery-panel").hidden = true;
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
  if (!/^image\/(?:jpeg|png|webp)$/u.test(file.type)) throw new Error("unsupported_type");
  if (file.size > MAX_UPLOAD_BYTES) throw new Error("photo_too_large");
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
  return canvas.toDataURL("image/jpeg", 0.84);
}

async function startWithUpload(file) {
  clearPhotoError();
  try {
    const src = await compactImage(file);
    startConversation({ src, payload: { dataUrl: src } });
  } catch (error) {
    $("photo-input").value = "";
    if (error.message === "unsupported_type") {
      showPhotoError("请选择 JPG、PNG 或 WebP 照片。");
    } else if (error.message === "photo_too_large") {
      showPhotoError("这张照片太大了，请重新选一张。");
    } else {
      showPhotoError("这张照片暂时打不开，请重新选一张。");
    }
  }
}

function startConversation(photo) {
  state.requestId += 1;
  state.photo = photo;
  state.pairs = [];
  state.pending = null;
  state.initialObservation = "";
  state.degraded = false;
  state.historyExpanded = false;
  state.editing = false;
  $("chat-photo").src = photo.src;
  $("thread").replaceChildren();
  $("answer").value = "";
  $("history-summary").hidden = true;
  clearPhotoError();
  show("chat");
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
  return clean.length ? `我看到了：${clean.join("，")}。` : "";
}

function setQuestionControls(waiting) {
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
}

function startSeeingTimers(requestId) {
  clearWaitTimers();
  state.waitTimers.push(setTimeout(() => {
    if (requestId === state.requestId && $("chat-agent").classList.contains("seeing")) {
      setAgentState("seeing", "我还在看，不急。");
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
    followup ? "我想想，下一句问什么好……" : "我在看画面里确定的东西……"
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
  state.pairs.push({ question: state.pending.question, answer });
  state.pending = null;
  renderThread();
  if (state.pairs.length === 1) return requestQuestion();
  if (state.pairs.length === 2) return showDecision();
  finishMemory();
}

function showDecision({ editing = false } = {}) {
  clearWaitTimers();
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
    : "这张照片已经有故事了。再补一句，还是就这样留下？";
  $("add-one").hidden = editing;
  $("decision-finish").textContent = editing ? "重新排成一页" : "就这样留下";
}

function finishMemory() {
  const unfinished = $("answer").value.trim();
  if (state.pending && unfinished) {
    state.pairs.push({ question: state.pending.question, answer: unfinished });
    renderThread();
  }
  if (state.pairs.length === 0) return;
  clearWaitTimers();
  state.requestId += 1;
  state.pending = null;
  setAgentState("closing", "好。照片留原样，你的话也留原样。一起放成这一页。");
  $("current-turn").hidden = true;
  $("composer").hidden = true;
  $("commit-answer").hidden = true;
  $("quiet-actions").hidden = true;
  $("decision-panel").hidden = true;
  $("recovery-panel").hidden = true;
  renderMemoryPage();
  setTimeout(() => {
    show("result");
    $("memory-title").focus({ preventScroll: true });
  }, 650);
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

function editMemory() {
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

$("photo-input").addEventListener("change", (event) => {
  const [file] = event.target.files;
  if (file) startWithUpload(file);
});

$("upload-start").addEventListener("click", () => $("photo-input").click());
$("demo-start").addEventListener("click", () => {
  startConversation({ src: "/photos/demo-celebration.jpg", payload: { file: "demo-celebration.jpg" } });
});

$("answer").addEventListener("input", (event) => {
  $("commit-answer").disabled = event.target.value.trim().length === 0;
});
$("answer").addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") commitAnswer();
});

$("history-summary").addEventListener("click", () => {
  state.historyExpanded = !state.historyExpanded;
  renderThread();
});
$("speak-first").addEventListener("click", () => {
  state.requestId += 1;
  clearWaitTimers();
  state.degraded = true;
  state.initialObservation = "这张我还没看清。";
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
$("edit-memory").addEventListener("click", editMemory);
$("restart").addEventListener("click", () => {
  if (window.confirm("要开始新的一张吗？当前这一页刷新后就找不回来了。")) reset();
});
$("print-memory").addEventListener("click", () => window.print());

reset({ focus: false });
