// vNext 产品壳：负责渐进式多图、成品选择与本机合集界面；存储和 zine 由独立模块接线。
const $ = (id) => document.getElementById(id);

const MAX_PHOTOS = 24;
const MAX_BYTES = 30 * 1024 * 1024;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const SHAPE_LABELS = {
  "memory-page": "一页回忆",
  poster: "记忆海报",
  zine: "一本 zine",
  spatial: "立体记忆"
};
const STYLE_LABELS = {
  "evening-paper": "傍晚相纸",
  "black-fragments": "黑色碎片",
  "quiet-white": "极简留白"
};

let selectedFiles = [];
let selectedPreviews = [];
let appendSelection = false;
let productChosen = false;
let currentShape = "memory-page";
let currentStyle = "evening-paper";
let previousScreen = "start";
let libraryCollections = [];
let activeCollection = null;

function setTheme() {
  document.querySelector('meta[name="theme-color"]').content = "#050505";
}

function showShellScreen(screen, { focus = true } = {}) {
  for (const section of document.querySelectorAll(".screen")) {
    section.hidden = section.id !== `screen-${screen}`;
  }
  document.body.dataset.screen = screen;
  setTheme(screen);
  window.scrollTo({ top: 0, behavior: "auto" });
  if (focus) $(`screen-${screen}`)?.focus({ preventScroll: true });
}

function revokePreviews() {
  for (const preview of selectedPreviews) {
    if (preview.owned) URL.revokeObjectURL(preview.src);
  }
  selectedPreviews = [];
}

function notifySelectionCancel() {
  window.dispatchEvent(new CustomEvent("huijian:photo-selection-cancel"));
}

function fileKey(file) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function validateFiles(files) {
  const accepted = [];
  let rejectedType = 0;
  let rejectedSize = 0;
  let rejectedEmpty = 0;
  for (const file of files) {
    if (!PHOTO_TYPES.has(file.type)) {
      rejectedType += 1;
      continue;
    }
    if (!Number.isFinite(file.size) || file.size <= 0) {
      rejectedEmpty += 1;
      continue;
    }
    if (file.size > MAX_BYTES) {
      rejectedSize += 1;
      continue;
    }
    accepted.push(file);
  }
  return { accepted, rejectedType, rejectedSize, rejectedEmpty };
}

function selectionMessage({ rejectedType = 0, rejectedSize = 0, rejectedEmpty = 0, omittedCount = 0 } = {}) {
  const parts = [`已选择 ${selectedFiles.length} 张，第一张是主照片。`];
  if (rejectedType) parts.push(`${rejectedType} 张格式不支持，已跳过。`);
  if (rejectedSize) parts.push(`${rejectedSize} 张超过 30 MB，已跳过。`);
  if (rejectedEmpty) parts.push(`${rejectedEmpty} 张照片文件为空，已跳过。`);
  if (omittedCount) parts.push(`最多处理 24 张，另有 ${omittedCount} 张未加入。`);
  if (selectedFiles.length >= MAX_PHOTOS) parts.push("已到 24 张上限。");
  return parts.join(" ");
}

function setInputFiles(files) {
  try {
    const transfer = new DataTransfer();
    files.forEach((file) => transfer.items.add(file));
    $("photo-input").files = transfer.files;
    return true;
  } catch {
    return false;
  }
}

function updatePreviewOrder() {
  selectedPreviews = selectedFiles.map((file) => ({
    file,
    src: URL.createObjectURL(file),
    owned: true
  }));
}

function makeIconButton(label, action, index, disabled = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "selection-icon-action";
  button.textContent = label;
  button.dataset.action = action;
  button.dataset.index = String(index);
  button.disabled = disabled;
  return button;
}

function renderSelection(messageOptions) {
  const list = $("photo-selection-list");
  const fragment = document.createDocumentFragment();
  selectedPreviews.forEach((preview, index) => {
    const item = document.createElement("li");
    item.className = "photo-selection-item";
    item.dataset.primary = String(index === 0);

    const thumb = document.createElement("img");
    thumb.src = preview.src;
    thumb.alt = index === 0 ? `主照片：${preview.file.name}` : preview.file.name;

    const copy = document.createElement("span");
    copy.className = "photo-selection-copy";
    const name = document.createElement("strong");
    name.textContent = index === 0 ? "主照片" : `第 ${index + 1} 张`;
    const filename = document.createElement("small");
    filename.textContent = preview.file.name;
    copy.append(name, filename);

    const actions = document.createElement("span");
    actions.className = "selection-item-actions";
    actions.append(
      makeIconButton("上移", "up", index, index === 0),
      makeIconButton("下移", "down", index, index === selectedFiles.length - 1),
      makeIconButton("移除", "remove", index)
    );
    item.append(thumb, copy, actions);
    fragment.append(item);
  });
  list.replaceChildren(fragment);
  $("selection-status").textContent = selectionMessage(messageOptions);
  $("selection-confirm").disabled = selectedFiles.length === 0;
  $("selection-add").disabled = selectedFiles.length >= MAX_PHOTOS;
}

function replaceSelection(files, options = {}) {
  notifySelectionCancel();
  revokePreviews();
  selectedFiles = files.slice(0, MAX_PHOTOS);
  updatePreviewOrder();
  renderSelection({
    ...options,
    omittedCount: Number(options.omittedCount ?? 0) + Math.max(0, files.length - MAX_PHOTOS)
  });
  productChosen = false;
  currentShape = "memory-page";
  currentStyle = "evening-paper";
  document.querySelector('input[name="result-shape"][value="memory-page"]').checked = true;
  document.querySelector('input[name="result-style"][value="evening-paper"]').checked = true;
  showShellScreen("selection");
}

function mergeSelection(files, options) {
  const seen = new Set(selectedFiles.map(fileKey));
  const merged = [...selectedFiles];
  let omittedCount = Number(options?.omittedCount ?? 0);
  for (const file of files) {
    const key = fileKey(file);
    if (seen.has(key)) continue;
    seen.add(key);
    if (merged.length < MAX_PHOTOS) merged.push(file);
    else omittedCount += 1;
  }
  replaceSelection(merged, { ...options, omittedCount });
}

function movePhoto(from, to) {
  if (to < 0 || to >= selectedFiles.length) return;
  const next = [...selectedFiles];
  const [file] = next.splice(from, 1);
  next.splice(to, 0, file);
  replaceSelection(next);
}

function removePhoto(index) {
  const next = selectedFiles.filter((_, candidate) => candidate !== index);
  if (!next.length) {
    notifySelectionCancel();
    revokePreviews();
    selectedFiles = [];
    $("photo-input").value = "";
    showShellScreen("start");
    return;
  }
  replaceSelection(next);
}

function renderPhotoRail(target) {
  const fragment = document.createDocumentFragment();
  const previews = selectedPreviews.length
    ? selectedPreviews
    : [{ src: $("result-photo").src || "/photos/photo1_cheers.jpg", owned: false }];
  previews.forEach((preview, index) => {
    const figure = document.createElement("figure");
    figure.className = "rail-photo";
    figure.dataset.primary = String(index === 0);
    const image = document.createElement("img");
    image.src = preview.src;
    image.alt = index === 0 ? "主照片" : `第 ${index + 1} 张照片`;
    const caption = document.createElement("figcaption");
    caption.textContent = index === 0 ? "主照片" : String(index + 1).padStart(2, "0");
    figure.append(image, caption);
    fragment.append(figure);
  });
  target.replaceChildren(fragment);
  target.dataset.photoCount = String(previews.length);
  const resultRail = target.closest(".result-photo-rail");
  if (resultRail) {
    if (previews.length <= 1) target.replaceChildren();
    resultRail.hidden = previews.length <= 1;
    $("screen-result").dataset.photoCount = String(previews.length);
  }
}

function syncProductPreview() {
  const shape = document.querySelector('input[name="result-shape"]:checked')?.value || currentShape;
  const style = document.querySelector('input[name="result-style"]:checked')?.value || currentStyle;
  const photoSrc = selectedPreviews[0]?.src || $("result-photo").src || "/photos/photo1_cheers.jpg";
  for (const image of document.querySelectorAll("[data-product-preview-photo]")) {
    if (image.getAttribute("src") !== photoSrc) image.setAttribute("src", photoSrc);
  }
  const preview = $("shape-preview");
  if (preview) {
    preview.dataset.shape = shape;
    preview.dataset.style = style;
  }
  const label = $("shape-preview-label");
  if (label) label.textContent = SHAPE_LABELS[shape] || "成品预览";
}

function syncShapeAvailability() {
  const count = selectedPreviews.length || selectedFiles.length || 1;
  const enabled = count >= 2;
  $("shape-zine").disabled = !enabled;
  $("zine-shape-option").setAttribute("aria-disabled", String(!enabled));
  $("zine-shape-note").textContent = enabled
    ? `用 ${count} 张照片确定性排成一本`
    : "至少需要 2 张照片";
  if (!enabled && $("shape-zine").checked) {
    document.querySelector('input[name="result-shape"][value="memory-page"]').checked = true;
  }
}

function openShapePicker() {
  renderPhotoRail($("shape-photo-list"));
  syncShapeAvailability();
  syncProductPreview();
  $("product-status").textContent = "形态和风格可以分开选择，之后也能回来更换。";
  showShellScreen("shape");
}

function applyProductChoice(shape, style) {
  currentShape = shape;
  currentStyle = style;
  productChosen = true;
  const shapeOption = document.querySelector(`input[name="result-shape"][value="${shape}"]`);
  const styleOption = document.querySelector(`input[name="result-style"][value="${style}"]`);
  if (shapeOption) shapeOption.checked = true;
  if (styleOption) styleOption.checked = true;
  $("memory-page").dataset.shape = shape;
  $("memory-page").dataset.style = style;
  $("screen-result").dataset.shape = shape;
  $("screen-result").dataset.style = style;
  $("result-shape-label").textContent = SHAPE_LABELS[shape];
  $("result-style-label").textContent = STYLE_LABELS[style];
  renderPhotoRail($("result-photo-list"));
}

function showResult({ shape = currentShape, style = currentStyle, zineReady = false } = {}) {
  applyProductChoice(shape, style);
  const isZine = shape === "zine";
  $("memory-page").hidden = isZine;
  $("zine-stage-slot").hidden = !isZine;
  if (isZine && !zineReady && !$("zine-stage-slot").children.length) {
    const note = document.createElement("p");
    note.className = "zine-waiting-note";
    note.textContent = "正在排成一本 zine……";
    $("zine-stage-slot").replaceChildren(note);
  }
  showShellScreen("result", { focus: false });
  (isZine ? $("zine-stage-slot") : $("memory-title")).focus?.({ preventScroll: true });
}

function productSelection() {
  return {
    shape: currentShape,
    style: currentStyle,
    files: [...selectedFiles]
  };
}

function openDialog(dialog) {
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function collectionMeta(collection) {
  const count = Number(collection.memoryCount ?? collection.memories?.length ?? 0);
  const date = collection.updatedAt
    ? new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(collection.updatedAt))
    : "刚刚更新";
  return `${count} 份记忆 · ${date}`;
}

function showCollection(collection) {
  activeCollection = collection;
  $("library-list").hidden = true;
  $("library-empty").hidden = true;
  $("library-detail").hidden = false;
  $("library-detail-name").textContent = collection.name || "未命名合集";
  $("library-detail-meta").textContent = collectionMeta(collection);
  $("library-detail-style").textContent = `默认风格：${STYLE_LABELS[collection.style] || "傍晚相纸"}`;
  $("library-detail-cover").src = collection.coverSrc || "/photos/photo1_cheers.jpg";
  $("library-detail-cover").alt = `${collection.name || "未命名合集"}的封面`;
  $("library-detail-name").focus?.({ preventScroll: true });
}

function renderLibrary({ collections = [] } = {}) {
  libraryCollections = Array.isArray(collections) ? collections : [];
  activeCollection = null;
  $("library-detail").hidden = true;
  $("library-empty").hidden = libraryCollections.length > 0;
  $("library-list").hidden = libraryCollections.length === 0;
  const fragment = document.createDocumentFragment();
  libraryCollections.forEach((collection) => {
    const card = $("library-card-template").content.firstElementChild.cloneNode(true);
    card.querySelector("[data-field=name]").textContent = collection.name || "未命名合集";
    card.querySelector("[data-field=meta]").textContent = collectionMeta(collection);
    const image = card.querySelector("img");
    image.src = collection.coverSrc || "/photos/photo1_cheers.jpg";
    image.alt = "";
    card.addEventListener("click", () => showCollection(collection));
    fragment.append(card);
  });
  $("library-list").replaceChildren(fragment);
}

function requestLibrary() {
  notifySelectionCancel();
  const screen = document.body.dataset.screen;
  if (screen !== "library") previousScreen = screen || "start";
  showShellScreen("library");
  window.dispatchEvent(new CustomEvent("huijian:library-request", {
    detail: { render: renderLibrary }
  }));
}

function dispatchCollectionAction(action, collection = activeCollection, callbacks = {}) {
  const actionEvent = new CustomEvent("huijian:collection-action", {
    cancelable: true,
    detail: { action, collection, render: renderLibrary, ...callbacks }
  });
  window.dispatchEvent(actionEvent);
  return actionEvent.defaultPrevented;
}

$("photo-input").addEventListener("change", (event) => {
  if ($("photo-input").dataset.shellCommit === "true") return;
  event.stopImmediatePropagation();
  const incoming = [...event.target.files];
  const result = validateFiles(incoming);
  if (!result.accepted.length) {
    $("photo-input").value = "";
    if (result.rejectedSize) {
      $("photo-error").textContent = "照片不能超过 30 MB。请选择更小的 JPG、PNG 或 WebP。";
    } else if (result.rejectedEmpty) {
      $("photo-error").textContent = "这张照片文件是空的或没有读完整，请重新导出后再选。";
    } else {
      $("photo-error").textContent = "请选择 JPG、PNG 或 WebP 照片。iPhone 的 HEIC 可先在照片 App 中导出为 JPEG。";
    }
    $("photo-error").hidden = false;
    return;
  }
  const options = {
    rejectedType: result.rejectedType,
    rejectedSize: result.rejectedSize,
    rejectedEmpty: result.rejectedEmpty
  };
  if (appendSelection) mergeSelection(result.accepted, options);
  else replaceSelection(result.accepted, options);
  appendSelection = false;
  window.dispatchEvent(new CustomEvent("huijian:photos-selected", {
    detail: { files: [...selectedFiles] }
  }));
}, { capture: true });

$("photo-selection-list").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const index = Number(button.dataset.index);
  if (button.dataset.action === "up") movePhoto(index, index - 1);
  if (button.dataset.action === "down") movePhoto(index, index + 1);
  if (button.dataset.action === "remove") removePhoto(index);
});

$("upload-start").addEventListener("click", () => { appendSelection = false; });
$("selection-add").addEventListener("click", () => {
  notifySelectionCancel();
  appendSelection = true;
  $("photo-input").click();
});
$("selection-back").addEventListener("click", () => {
  notifySelectionCancel();
  revokePreviews();
  selectedFiles = [];
  $("photo-input").value = "";
  showShellScreen("start");
});
$("selection-confirm").addEventListener("click", () => {
  if (!selectedFiles.length) return;
  $("selection-confirm").disabled = true;
  $("selection-status").textContent = "正在整理主照片……";
  const confirmation = new CustomEvent("huijian:selection-confirmed", {
    cancelable: true,
    detail: { files: [...selectedFiles] }
  });
  window.dispatchEvent(confirmation);
  if (confirmation.defaultPrevented) return;
  const ordered = setInputFiles(selectedFiles);
  if (!ordered) {
    $("selection-status").textContent = "这个浏览器暂时不能按调整后的顺序读取照片，请重新选择。";
    $("selection-confirm").disabled = false;
    return;
  }
  $("photo-input").dataset.shellCommit = "true";
  $("photo-input").dispatchEvent(new Event("change", { bubbles: true }));
  queueMicrotask(() => { delete $("photo-input").dataset.shellCommit; });
});

window.addEventListener("huijian:photo-session-ready", (event) => {
  const photos = Array.isArray(event.detail?.photos)
    ? event.detail.photos.filter((photo) => typeof photo?.src === "string" && photo.src)
    : [];
  revokePreviews();
  selectedFiles = [];
  selectedPreviews = photos.map((photo) => ({
    file: { name: "已整理的照片" },
    src: photo.src,
    owned: false
  }));
  if (!productChosen) {
    currentShape = photos.length >= 2 ? "zine" : "memory-page";
    const option = document.querySelector(`input[name="result-shape"][value="${currentShape}"]`);
    if (option) option.checked = true;
  }
});

$("demo-start").addEventListener("click", () => {
  revokePreviews();
  selectedFiles = [];
  selectedPreviews = [{ src: "/photos/photo1_cheers.jpg", owned: false }];
  productChosen = false;
});

$("product-controls").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const shape = String(data.get("result-shape"));
  const style = String(data.get("result-style"));
  currentShape = shape;
  currentStyle = style;
  const productEvent = new CustomEvent("huijian:product-confirm", {
    cancelable: true,
    detail: {
      shape,
      style,
      files: [...selectedFiles],
      showResult
    }
  });
  window.dispatchEvent(productEvent);
  if (!productEvent.defaultPrevented) showResult({ shape, style });
});

$("product-controls").addEventListener("change", (event) => {
  if (!event.target.matches('input[name="result-shape"], input[name="result-style"]')) return;
  syncProductPreview();
});

$("shape-back").addEventListener("click", () => $("edit-memory").click());
$("change-product").addEventListener("click", () => {
  productChosen = false;
  openShapePicker();
});

$("save-local-memory").addEventListener("click", () => {
  $("save-dialog-status").textContent = "";
  openDialog($("save-memory-dialog"));
  $("save-collection-name").focus();
});
$("save-dialog-confirm").addEventListener("click", (event) => {
  event.preventDefault();
  const collectionName = $("save-collection-name").value.trim();
  if (!collectionName) {
    $("save-dialog-status").textContent = "请先给合集起一个名字。";
    return;
  }
  const button = event.currentTarget;
  button.disabled = true;
  $("save-dialog-status").textContent = "正在保存到这个浏览器……";
  const saveEvent = new CustomEvent("huijian:memory-save", {
    cancelable: true,
    detail: {
      collectionName,
      ...productSelection(),
      complete(message = "已保存到本机合集。") {
        button.disabled = false;
        $("save-memory-dialog").close();
        $("export-status").textContent = message;
        $("export-status").hidden = false;
        $("save-local-memory").textContent = "已保存到本机合集";
      },
      fail(message = "这次没有保存成功，请再试一次。") {
        button.disabled = false;
        $("save-dialog-status").textContent = message;
      }
    }
  });
  window.dispatchEvent(saveEvent);
  if (!saveEvent.defaultPrevented) {
    saveEvent.detail.fail("本机存储还没有准备好，可以先保存为图片。");
  }
});

$("my-memories-entry").addEventListener("click", requestLibrary);
$("library-back").addEventListener("click", () => {
  const target = document.getElementById(`screen-${previousScreen}`) ? previousScreen : "start";
  showShellScreen(target, { focus: target !== "result" });
});
for (const id of ["library-new-memory", "library-empty-start"]) {
  $(id).addEventListener("click", () => {
    showShellScreen("start");
    $("upload-start").focus({ preventScroll: true });
  });
}
$("library-detail-back").addEventListener("click", () => renderLibrary({ collections: libraryCollections }));
$("library-open-collection").addEventListener("click", () => dispatchCollectionAction("open"));
$("library-add-to-collection").addEventListener("click", () => dispatchCollectionAction("add"));
$("library-export-collection").addEventListener("click", () => dispatchCollectionAction("export"));
$("library-rename-collection").addEventListener("click", () => dispatchCollectionAction("rename"));
$("library-delete-collection").addEventListener("click", () => {
  if (!activeCollection) return;
  $("delete-collection-name").textContent = activeCollection.name || "未命名合集";
  $("delete-dialog-status").textContent = "";
  openDialog($("delete-collection-dialog"));
});
$("delete-dialog-confirm").addEventListener("click", (event) => {
  event.preventDefault();
  const button = event.currentTarget;
  button.disabled = true;
  $("delete-dialog-status").textContent = "正在从这个浏览器删除……";
  const handled = dispatchCollectionAction("delete", activeCollection, {
    complete() {
      button.disabled = false;
      $("delete-collection-dialog").close();
    },
    fail(message = "这次没有删除成功，合集仍然保留。") {
      button.disabled = false;
      $("delete-dialog-status").textContent = message;
    }
  });
  if (!handled) {
    button.disabled = false;
    $("delete-dialog-status").textContent = "本机存储还没有准备好，合集没有被删除。";
  }
});

const screenObserver = new MutationObserver(() => {
  const screen = document.body.dataset.screen;
  if (screen === "start") productChosen = false;
  if (screen === "result" && !productChosen) openShapePicker();
});
screenObserver.observe(document.body, { attributes: true, attributeFilter: ["data-screen"] });

const photoErrorObserver = new MutationObserver(() => {
  if (document.body.dataset.screen !== "selection" || $("photo-error").hidden) return;
  $("selection-status").textContent = $("photo-error").textContent;
  $("selection-confirm").disabled = false;
});
photoErrorObserver.observe($("photo-error"), { attributes: true, childList: true, subtree: true });

window.huijianProductShell = {
  openShapePicker,
  productSelection,
  renderLibrary,
  showResult
};
