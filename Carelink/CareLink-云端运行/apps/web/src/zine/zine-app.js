// Browser-only workbench for the zine route. Visitor photos stay in File/object-URL/canvas APIs;
// the bundled demo sources are locally generated SVG data URIs. No dependency or upload path is used.

import { esc } from "../ui/templates.js";
import {
  buildZinePages,
  classifyZineOrientation,
  defaultZineTitle,
  getZineBookTemplate,
  getZineFormat,
  orderZineIndexes,
  recommendZineFormat,
  ZINE_BOOK_TEMPLATES,
  ZINE_FORMATS,
  ZINE_ORIENTATIONS,
  ZINE_SORT_MODES,
  ZINE_TEMPLATES,
  zineCropRiskCount
} from "./layout.js";

const MAX_SOURCE_EDGE = 1600;
const MAX_FILES = 20;

function syntheticDemoSvg(index, [sky, glow, ground, ink]) {
  const shift = index * 37;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200" viewBox="0 0 1600 1200">
    <defs><linearGradient id="sky" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${sky}"/><stop offset="1" stop-color="${glow}"/></linearGradient></defs>
    <rect width="1600" height="1200" fill="url(#sky)"/><circle cx="${1180 - shift}" cy="${260 + shift / 2}" r="190" fill="#fff9ef" opacity=".62"/>
    <path d="M0 780 Q360 ${570 + shift} 710 790 T1600 700 V1200 H0Z" fill="${ground}" opacity=".9"/>
    <path d="M0 920 Q420 ${760 - shift / 2} 880 930 T1600 850 V1200 H0Z" fill="${ink}" opacity=".26"/>
    <g fill="${ink}"><circle cx="${520 + shift}" cy="650" r="66"/><rect x="${474 + shift}" y="714" width="92" height="210" rx="44"/><circle cx="${760 + shift / 2}" cy="610" r="52"/><rect x="${724 + shift / 2}" y="664" width="72" height="174" rx="36"/></g>
    <path d="M${570 + shift} 792 Q${650 + shift} ${710 - shift / 3} ${724 + shift / 2} 748" fill="none" stroke="#fff9ef" stroke-width="18" stroke-linecap="round" opacity=".82"/>
    <g fill="#fff9ef" opacity=".72"><circle cx="220" cy="210" r="16"/><circle cx="280" cy="170" r="8"/><circle cx="330" cy="235" r="11"/></g>
  </svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const SYNTHETIC_DEMO_PALETTES = Object.freeze([
  Object.freeze(["#6f5972", "#e9a6a6", "#8d5561", "#461528"]),
  Object.freeze(["#425f76", "#efbc91", "#776b55", "#253847"]),
  Object.freeze(["#7a5368", "#f3c79f", "#9a6955", "#4a2939"]),
  Object.freeze(["#4e6970", "#d9b6a0", "#68715d", "#283e42"]),
  Object.freeze(["#7b5b4f", "#f4c18f", "#9c6a57", "#4c2b28"]),
  Object.freeze(["#584c75", "#e7a8b9", "#7b5870", "#342747"])
]);

// Rights-clean structural fixtures: generated locally from our own SVG shapes, with no person, photo, or
// third-party asset embedded. They test rhythm and cropping without pretending to test emotional photo quality.
export const ZINE_DEMO_SOURCES = Object.freeze(SYNTHETIC_DEMO_PALETTES.map((palette, index) => Object.freeze({
  kind: "synthetic-demo",
  name: `合成现场-${index + 1}.svg`,
  type: "image/svg+xml",
  src: syntheticDemoSvg(index, palette),
  width: 1600,
  height: 1200,
  lastModified: Date.UTC(2026, 4, 3, 17, 30 + index * 19)
})));

const CANVAS_THEMES = Object.freeze({
  story: Object.freeze({ paper: "#fff9f7", ink: "#461528", muted: "#725f66", frame: "rgba(70, 21, 40, 0.14)", panel: "rgba(255, 248, 245, 0.9)" }),
  gallery: Object.freeze({ paper: "#fffdf8", ink: "#3e2430", muted: "#806d73", frame: "rgba(62, 36, 48, 0.18)", panel: "rgba(255, 253, 248, 0.94)" }),
  collage: Object.freeze({ paper: "#ffefe5", ink: "#461528", muted: "#7a3f45", frame: "rgba(70, 21, 40, 0.2)", panel: "rgba(255, 233, 227, 0.92)" })
});

export function mountZineApp(container) {
  const state = {
    files: [],
    thumbUrls: [],
    sourceOrientations: [],
    pageArtifacts: [],
    currentIndex: 0,
    title: defaultZineTitle(),
    templateId: ZINE_BOOK_TEMPLATES.STORY.id,
    formatId: ZINE_FORMATS.PORTRAIT.id,
    formatTouched: false,
    sortMode: ZINE_SORT_MODES.SELECTION,
    destroyed: false,
    onKeydown: null
  };

  renderPicker();

  function renderPicker(error = "") {
    unbindKeydown();
    container.innerHTML = pickerMarkup(state, error);
    container.querySelector("[data-zine-file-input]")?.addEventListener("change", onFilesChosen);
    container.querySelector("[data-zine-demo]")?.addEventListener("click", useDemoPhotos);
    container.querySelector("[data-zine-generate]")?.addEventListener("click", () => { void onGenerate(); });
    container.querySelector("[data-zine-title]")?.addEventListener("input", (event) => { state.title = event.target.value; });
    container.querySelectorAll("[data-zine-template]").forEach((input) => {
      input.addEventListener("change", () => { state.templateId = input.value; });
    });
    container.querySelectorAll("[data-zine-format]").forEach((input) => {
      input.addEventListener("change", () => {
        state.formatId = input.value;
        state.formatTouched = true;
        renderPicker();
      });
    });
    container.querySelectorAll("[data-zine-sort]").forEach((input) => {
      input.addEventListener("change", () => { state.sortMode = input.value; renderPicker(); });
    });
    container.querySelectorAll("[data-zine-remove]").forEach((button) => {
      button.addEventListener("click", () => removeFile(Number(button.dataset.zineRemove)));
    });
    container.querySelector("[data-zine-clear]")?.addEventListener("click", resetAll);
  }

  async function onFilesChosen(event) {
    const picked = Array.from(event.target.files || []);
    event.target.value = "";
    if (!picked.length) return;
    const room = Math.max(0, MAX_FILES - state.files.length);
    const images = picked.filter((file) => file.type.startsWith("image/"));
    const accepted = images.slice(0, room);
    const added = accepted.map((file) => {
      const url = URL.createObjectURL(file);
      state.files.push(file);
      state.thumbUrls.push(url);
      state.sourceOrientations.push(ZINE_ORIENTATIONS.UNKNOWN);
      return { file, url };
    });
    const notices = [];
    if (picked.length > images.length) notices.push("已跳过不是图片的文件。");
    if (images.length > accepted.length) notices.push(`一次最多 ${MAX_FILES} 张，已保留前面选中的照片。`);
    const notice = notices.join(" ");
    renderPicker(notice);
    await Promise.all(added.map(async ({ url }) => {
      let orientation = ZINE_ORIENTATIONS.UNKNOWN;
      try {
        const image = await loadImage(url);
        orientation = classifyZineOrientation(image.naturalWidth, image.naturalHeight);
      } catch {
        // The renderer will show the existing visible decode error if this source is used.
      }
      const currentIndex = state.thumbUrls.indexOf(url);
      if (currentIndex >= 0) state.sourceOrientations[currentIndex] = orientation;
    }));
    applyRecommendedFormat();
    if (!state.destroyed) renderPicker(notice);
  }

  function useDemoPhotos() {
    if (state.files.length) return;
    state.files = [...ZINE_DEMO_SOURCES];
    state.thumbUrls = ZINE_DEMO_SOURCES.map((source) => source.src);
    state.sourceOrientations = ZINE_DEMO_SOURCES.map((source) => classifyZineOrientation(source.width, source.height));
    applyRecommendedFormat();
    renderPicker();
  }

  function removeFile(index) {
    if (index < 0 || index >= state.files.length) return;
    revokeThumbUrl(state.thumbUrls[index]);
    state.files.splice(index, 1);
    state.thumbUrls.splice(index, 1);
    state.sourceOrientations.splice(index, 1);
    applyRecommendedFormat();
    renderPicker();
  }

  function applyRecommendedFormat() {
    if (state.formatTouched) return;
    const recommendation = recommendZineFormat(state.sourceOrientations);
    if (recommendation.formatId) state.formatId = recommendation.formatId;
  }

  function resetAll() {
    unbindKeydown();
    state.thumbUrls.forEach(revokeThumbUrl);
    state.thumbUrls = [];
    state.files = [];
    state.sourceOrientations = [];
    state.formatTouched = false;
    releasePageArtifacts();
    state.currentIndex = 0;
    state.title = defaultZineTitle();
    renderPicker();
  }

  async function onGenerate() {
    if (!state.files.length || state.destroyed) return;
    const titleInput = container.querySelector("[data-zine-title]");
    if (titleInput) state.title = titleInput.value.trim() || defaultZineTitle();
    const orderedFiles = orderZineIndexes(state.files, state.sortMode).map((index) => state.files[index]);
    const pages = buildZinePages(orderedFiles.length, state.templateId);
    const format = getZineFormat(state.formatId);
    container.innerHTML = progressMarkup(state, pages.length);
    const label = container.querySelector("[data-zine-progress-label]");
    const renderedPages = [];
    const releaseRenderedPages = () => renderedPages.forEach((page) => URL.revokeObjectURL(page.url));
    try {
      for (let index = 0; index < pages.length; index += 1) {
        if (state.destroyed) { releaseRenderedPages(); return; }
        if (label) label.textContent = `正在排版第 ${index + 1} / ${pages.length} 页…`;
        const canvas = await renderPageCanvas(pages[index], orderedFiles, state.title, format, state.templateId);
        const blob = await canvasToBlob(canvas);
        renderedPages.push({ url: URL.createObjectURL(blob), width: canvas.width, height: canvas.height });
        canvas.width = 1;
        canvas.height = 1;
        await nextFrame();
      }
    } catch (error) {
      releaseRenderedPages();
      if (!state.destroyed) renderPicker(error instanceof Error ? error.message : "排版没有完成，请重试一次。");
      return;
    }
    if (state.destroyed) { releaseRenderedPages(); return; }
    state.pageArtifacts = renderedPages;
    state.currentIndex = 0;
    renderFlipbook();
  }

  function renderFlipbook() {
    unbindKeydown();
    container.innerHTML = flipbookMarkup(state);
    const stack = container.querySelector("[data-zine-stack]");
    state.pageArtifacts.forEach((page, index) => {
      const pageElement = document.createElement("div");
      pageElement.className = "zine-page";
      pageElement.dataset.zinePage = String(index);
      pageElement.style.zIndex = String(state.pageArtifacts.length - index);
      const image = document.createElement("img");
      image.className = "zine-canvas";
      image.src = page.url;
      image.alt = `纪念册第 ${index + 1} 页`;
      pageElement.appendChild(image);
      stack?.appendChild(pageElement);
    });
    applyFlipState();
    updateCounter();
    bindFlipbookEvents();
  }

  function applyFlipState() {
    container.querySelectorAll(".zine-page").forEach((pageElement) => {
      pageElement.classList.toggle("is-flipped", Number(pageElement.dataset.zinePage) < state.currentIndex);
    });
  }

  function updateCounter() {
    const counter = container.querySelector("[data-zine-counter]");
    if (counter) counter.textContent = `第 ${Math.min(state.currentIndex + 1, state.pageArtifacts.length)} / ${state.pageArtifacts.length} 页`;
    const previous = container.querySelector("[data-zine-prev]");
    const next = container.querySelector("[data-zine-next]");
    if (previous) previous.disabled = state.currentIndex <= 0;
    if (next) next.disabled = state.currentIndex >= state.pageArtifacts.length - 1;
  }

  function goNext() {
    if (state.currentIndex >= state.pageArtifacts.length - 1) return;
    state.currentIndex += 1;
    applyFlipState();
    updateCounter();
  }

  function goPrev() {
    if (state.currentIndex <= 0) return;
    state.currentIndex -= 1;
    applyFlipState();
    updateCounter();
  }

  function bindFlipbookEvents() {
    const book = container.querySelector("[data-zine-book]");
    container.querySelector("[data-zine-prev]")?.addEventListener("click", goPrev);
    container.querySelector("[data-zine-next]")?.addEventListener("click", goNext);
    container.querySelector("[data-zine-save-page]")?.addEventListener("click", saveCurrentPage);
    container.querySelector("[data-zine-share]")?.addEventListener("click", () => { void downloadShareSheet(); });
    container.querySelector("[data-zine-print]")?.addEventListener("click", () => { void onPrint(); });
    container.querySelector("[data-zine-restart]")?.addEventListener("click", resetAll);
    if (!book) return;

    book.addEventListener("click", (event) => {
      const rect = book.getBoundingClientRect();
      if (event.clientX - rect.left < rect.width / 2) goPrev(); else goNext();
    });

    let touchStartX = null;
    book.addEventListener("touchstart", (event) => { touchStartX = event.touches[0]?.clientX ?? null; }, { passive: true });
    book.addEventListener("touchend", (event) => {
      if (touchStartX == null) return;
      const delta = (event.changedTouches[0]?.clientX ?? touchStartX) - touchStartX;
      touchStartX = null;
      if (Math.abs(delta) < 40) return;
      if (delta < 0) goNext(); else goPrev();
    }, { passive: true });

    state.onKeydown = (event) => {
      if (event.target instanceof HTMLElement && ["INPUT", "TEXTAREA"].includes(event.target.tagName)) return;
      if (event.key === "ArrowRight" || event.key === " ") { event.preventDefault(); goNext(); }
      else if (event.key === "ArrowLeft") { event.preventDefault(); goPrev(); }
    };
    document.addEventListener("keydown", state.onKeydown);
  }

  function unbindKeydown() {
    if (!state.onKeydown) return;
    document.removeEventListener("keydown", state.onKeydown);
    state.onKeydown = null;
  }

  function saveCurrentPage() {
    const page = state.pageArtifacts[state.currentIndex];
    if (page) downloadUrl(page.url, `纪念册-第${state.currentIndex + 1}页.png`);
  }

  async function downloadShareSheet() {
    if (!state.pageArtifacts.length) return;
    const reference = state.pageArtifacts[0];
    const contentWidth = 540;
    const pageHeight = Math.round((contentWidth * reference.height) / reference.width);
    const gap = 16;
    const pad = 24;
    const sheet = document.createElement("canvas");
    sheet.width = pad * 2 + contentWidth;
    sheet.height = pad * 2 + state.pageArtifacts.length * pageHeight + (state.pageArtifacts.length - 1) * gap;
    const context = sheet.getContext("2d");
    context.fillStyle = "#fff9f7";
    context.fillRect(0, 0, sheet.width, sheet.height);
    for (let index = 0; index < state.pageArtifacts.length; index += 1) {
      const image = await loadImage(state.pageArtifacts[index].url);
      context.drawImage(image, pad, pad + index * (pageHeight + gap), contentWidth, pageHeight);
    }
    downloadCanvas(sheet, "纪念册-分享图.png");
  }

  async function onPrint() {
    const sheet = container.querySelector("[data-zine-print-sheet]");
    if (!sheet) return;
    sheet.innerHTML = "";
    sheet.dataset.zineFormat = state.formatId;
    const images = state.pageArtifacts.map((page) => {
      const image = document.createElement("img");
      image.src = page.url;
      image.className = "zine-print-page";
      image.alt = "";
      sheet.appendChild(image);
      return image;
    });
    await Promise.all(images.map((image) => image.decode?.().catch(() => undefined)));
    setTimeout(() => window.print(), 0);
  }

  function releasePageArtifacts() {
    state.pageArtifacts.forEach((page) => URL.revokeObjectURL(page.url));
    state.pageArtifacts = [];
  }

  return {
    destroy() {
      if (state.destroyed) return;
      state.destroyed = true;
      unbindKeydown();
      state.thumbUrls.forEach(revokeThumbUrl);
      state.thumbUrls = [];
      state.sourceOrientations = [];
      releasePageArtifacts();
    }
  };
}

function nextFrame() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function revokeThumbUrl(url) {
  if (String(url).startsWith("blob:")) URL.revokeObjectURL(url);
}

function downloadCanvas(canvas, filename) {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, "image/png");
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("zine_page_encode_failed"));
    }, "image/png");
  });
}

function downloadUrl(url, filename) {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("zine_image_decode_failed"));
    image.src = url;
  });
}

function checked(actual, expected) {
  return actual === expected ? " checked" : "";
}

function templateOptions(selectedId) {
  return Object.values(ZINE_BOOK_TEMPLATES).map((template) => `
    <label class="zine-proof-option">
      <input class="sr-only" type="radio" name="zine-template" value="${template.id}" data-zine-template${checked(selectedId, template.id)}>
      <span class="zine-proof-card" data-zine-proof="${template.id}">
        <span class="zine-proof-strip" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
        <strong>${template.label}</strong>
        <small>${template.description}</small>
      </span>
    </label>`).join("");
}

function formatOptions(selectedId, recommendedId = "") {
  return Object.values(ZINE_FORMATS).map((format) => `
    <label class="zine-format-option">
      <input class="sr-only" type="radio" name="zine-format" value="${format.id}" data-zine-format${checked(selectedId, format.id)}>
      <span><i class="zine-format-shape" data-zine-format-shape="${format.id}" aria-hidden="true"></i><strong>${format.label}</strong><small>${format.ratio}${recommendedId === format.id ? `<mark class="zine-format-recommended">推荐</mark>` : ""}</small></span>
    </label>`).join("");
}

function materialFitMarkup(state, summary) {
  if (!state.files.length) return "";
  if (!summary.knownCount) {
    return `<div class="zine-material-fit is-measuring" role="status"><strong>正在看这组照片更适合什么比例…</strong><span>照片仍只在当前浏览器里读取。</span></div>`;
  }
  const recommended = summary.formatId ? getZineFormat(summary.formatId) : null;
  const selected = getZineFormat(state.formatId);
  const riskCount = zineCropRiskCount(summary, selected.id);
  const counts = [
    ["landscape", "横图", summary.counts.landscape],
    ["portrait", "竖图", summary.counts.portrait],
    ["square", "方图", summary.counts.square]
  ].filter(([, , count]) => count > 0);
  const unknownCopy = summary.counts.unknown ? ` · ${summary.counts.unknown} 张未读出比例` : "";
  const headline = recommended ? `这组照片更适合${recommended.label}` : "这组照片横竖比较平均";
  let decision = `当前保留${selected.label}，你可以按想要的翻阅感觉来选。`;
  if (recommended && selected.id === recommended.id) {
    decision = `${state.formatTouched ? "你选的比例正合适" : "已替你选好"}。${riskCount ? `仍有 ${riskCount} 张不同方向的照片可能被裁切。` : "这组照片的方向很统一。"}`;
  } else if (recommended) {
    decision = `你现在选的是${selected.label}；${riskCount} 张不同方向的照片可能被明显裁切。`;
  }
  return `<div class="zine-material-fit" role="status">
    <div class="zine-material-contact" aria-label="${counts.map(([, label, count]) => `${label} ${count} 张`).join("，")}">
      ${counts.map(([orientation, label, count]) => `<span><i data-zine-orientation="${orientation}" aria-hidden="true"></i>${label} ${count}</span>`).join("")}
    </div>
    <p><strong>${headline}</strong><span>${decision}${unknownCopy}</span></p>
  </div>`;
}

function sortOptions(selectedMode) {
  return `
    <label><input type="radio" name="zine-sort" value="${ZINE_SORT_MODES.SELECTION}" data-zine-sort${checked(selectedMode, ZINE_SORT_MODES.SELECTION)}>选择顺序</label>
    <label><input type="radio" name="zine-sort" value="${ZINE_SORT_MODES.FILE_TIME}" data-zine-sort${checked(selectedMode, ZINE_SORT_MODES.FILE_TIME)}>文件时间（早 → 晚）</label>`;
}

export function pickerMarkup(state, error = "") {
  const hasFiles = state.files.length > 0;
  const orientationSummary = recommendZineFormat(state.sourceOrientations || []);
  const orderedIndexes = orderZineIndexes(state.files, state.sortMode);
  const thumbs = orderedIndexes.map((sourceIndex, displayIndex) => `
    <li class="zine-thumb">
      <img src="${esc(state.thumbUrls[sourceIndex] || "")}" alt="排版顺序第 ${displayIndex + 1} 张：${esc(state.files[sourceIndex]?.name || "照片")}" loading="lazy">
      <span class="zine-thumb-order" aria-hidden="true">${displayIndex + 1}</span>
      <button type="button" class="zine-thumb-remove" data-zine-remove="${sourceIndex}" aria-label="移除排版顺序第 ${displayIndex + 1} 张">✕</button>
    </li>`).join("");
  return `
    <div class="card card-body zine-picker stack">
      <div class="zine-picker-heading">
        <p class="eyebrow">快速成册工作台</p>
        <h2>${hasFiles ? "挑一种翻阅节奏" : "先放进一组照片"}</h2>
        <p class="fine muted">照片只在当前浏览器里排版。适合屏幕分享或家用打印 / 存 PDF，不是商业印刷文件。</p>
      </div>
      <div class="zine-source-actions">
        <label class="button ${hasFiles ? "" : "button-primary"} zine-file-button">
          ${hasFiles ? "继续加照片" : "选择照片"}
          <input type="file" accept="image/*" multiple data-zine-file-input class="sr-only">
        </label>
        ${hasFiles ? "" : `<button type="button" class="button button-quiet" data-zine-demo>先用 6 张合成示例试排</button>`}
      </div>
      ${error ? `<p class="field-error" role="alert">${esc(error)}</p>` : ""}
      ${hasFiles ? `
        <div class="zine-selection-row">
          <p class="fine">已选 ${state.files.length} 张 · 缩略图编号就是成册顺序</p>
          <button type="button" class="button button-quiet" data-zine-clear>清空</button>
        </div>
        <ul class="zine-thumb-grid">${thumbs}</ul>
        <fieldset class="zine-control-group zine-proof-fieldset">
          <legend><span>版式试纸</span><small>三种固定节奏，点一条试纸选择</small></legend>
          <div class="zine-proof-grid">${templateOptions(state.templateId)}</div>
        </fieldset>
        <div class="zine-control-columns">
          <fieldset class="zine-control-group">
            <legend><span>成品比例</span><small>画布与翻页会一起变化</small></legend>
            <div class="zine-format-grid">${formatOptions(state.formatId, orientationSummary.formatId)}</div>
            ${materialFitMarkup(state, orientationSummary)}
          </fieldset>
          <fieldset class="zine-control-group">
            <legend><span>照片顺序</span><small>文件时间取设备提供的修改时间</small></legend>
            <div class="zine-sort-options">${sortOptions(state.sortMode)}</div>
          </fieldset>
        </div>
        <div class="field"><label for="zine-title-input">书名</label><input id="zine-title-input" type="text" maxlength="40" value="${esc(state.title)}" data-zine-title></div>
        <p class="zine-safe-note"><strong>安全边距：</strong>排版会为适配比例裁切照片边缘，请让人物脸部和重要文字离四周约 5%。</p>
        <div class="zine-final-action"><button type="button" class="button button-primary" data-zine-generate>生成可翻的小书 →</button></div>
      ` : `<p class="fine muted zine-empty-hint">合成示例只验证版式结构，不代表真实照片效果；不会复制或上传任何二进制。</p>`}
    </div>`;
}

function progressMarkup(state, pageCount) {
  const template = getZineBookTemplate(state.templateId);
  const format = getZineFormat(state.formatId);
  return `<div class="card card-body stack zine-progress" aria-busy="true">
    <p class="eyebrow">${template.label} · ${format.label}</p>
    <p data-zine-progress-label>正在排版 1 / ${pageCount} 页…</p>
    <div class="loading-line" aria-hidden="true"></div>
  </div>`;
}

export function flipbookMarkup(state) {
  const format = getZineFormat(state.formatId);
  const template = getZineBookTemplate(state.templateId);
  return `
    <div class="zine-flipbook" data-zine-format="${format.id}" style="--zine-page-ratio: ${format.width} / ${format.height}">
      <div class="zine-finish-heading">
        <p class="eyebrow">${template.label} · ${format.label} ${format.ratio}</p>
        <h2>${esc(state.title)}</h2>
      </div>
      <div class="zine-book-wrap">
        <button type="button" class="zine-flip-nav" data-zine-prev aria-label="上一页">‹</button>
        <div class="zine-book" data-zine-book><div class="zine-stack" data-zine-stack></div></div>
        <button type="button" class="zine-flip-nav" data-zine-next aria-label="下一页">›</button>
      </div>
      <p class="fine zine-counter" data-zine-counter aria-live="polite"></p>
      <div class="cluster zine-toolbar">
        <button type="button" class="button button-primary" data-zine-print>打印 / 存为 PDF</button>
        <button type="button" class="button" data-zine-share>下载分享长图</button>
        <button type="button" class="button" data-zine-save-page>保存本页 PNG</button>
        <button type="button" class="button button-quiet" data-zine-restart>重新选择照片</button>
      </div>
      <p class="zine-safe-note"><strong>家用打印提示：</strong>打印面板里选择与成品相同的横 / 竖方向，并保留默认页边距。这里提供的是分享与家用 PDF，不是含出血线的商业印刷稿。</p>
      <p class="fine muted">桌面点击书页左右两侧、或用键盘方向键翻页；手机左右滑动翻页。</p>
    </div>
    <div class="zine-print-sheet" data-zine-print-sheet data-zine-format="${format.id}" aria-hidden="true"></div>`;
}

async function renderPageCanvas(page, sources, title, format, templateId) {
  const canvas = document.createElement("canvas");
  canvas.width = format.width;
  canvas.height = format.height;
  const context = canvas.getContext("2d");
  const theme = CANVAS_THEMES[templateId] || CANVAS_THEMES.story;
  context.fillStyle = theme.paper;
  context.fillRect(0, 0, canvas.width, canvas.height);
  if (page.type === ZINE_TEMPLATES.CLOSING) {
    drawClosing(context, title, sources.length, theme);
    return canvas;
  }

  const bitmaps = [];
  try {
    for (const sourceIndex of page.images) bitmaps.push(await loadZineBitmap(sources[sourceIndex]));
    if (page.type === ZINE_TEMPLATES.COVER) drawCover(context, bitmaps[0], title, theme, templateId);
    else if (page.type === ZINE_TEMPLATES.FULL) drawFull(context, bitmaps[0], theme, templateId);
    else if (page.type === ZINE_TEMPLATES.DUO) drawDuo(context, bitmaps, theme, templateId);
    else if (page.type === ZINE_TEMPLATES.GRID) drawGrid(context, bitmaps, theme, templateId);
    else if (page.type === ZINE_TEMPLATES.ACCENT) drawAccent(context, bitmaps[0], page.caption || "", theme, templateId);
  } finally {
    bitmaps.forEach((bitmap) => bitmap?.close?.());
  }
  return canvas;
}

async function loadZineBitmap(source) {
  try {
    return await loadScaledBitmap(source);
  } catch {
    const name = source?.name || "这张照片";
    throw new Error(`无法读取「${name}」。请移除它，或先转成 JPG / PNG 后再试。`);
  }
}

async function loadScaledBitmap(source, maxEdge = MAX_SOURCE_EDGE) {
  if (source?.src || typeof createImageBitmap !== "function") return loadScaledBitmapFallback(source, maxEdge);
  let original = null;
  try {
    original = await createImageBitmap(source);
    const scale = Math.min(1, maxEdge / Math.max(original.width, original.height));
    if (scale >= 1) return original;
    const width = Math.max(1, Math.round(original.width * scale));
    const height = Math.max(1, Math.round(original.height * scale));
    const scaled = await createImageBitmap(original, { resizeWidth: width, resizeHeight: height, resizeQuality: "medium" });
    original.close();
    return scaled;
  } catch {
    original?.close?.();
    return loadScaledBitmapFallback(source, maxEdge);
  }
}

function loadScaledBitmapFallback(source, maxEdge) {
  return new Promise((resolve, reject) => {
    const ownsUrl = !source?.src;
    const url = source?.src || URL.createObjectURL(source);
    const image = new Image();
    const cleanup = () => { if (ownsUrl) URL.revokeObjectURL(url); };
    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight) { cleanup(); reject(new Error("zine_image_decode_failed")); return; }
      const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
      const scaledCanvas = document.createElement("canvas");
      scaledCanvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      scaledCanvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      scaledCanvas.getContext("2d").drawImage(image, 0, 0, scaledCanvas.width, scaledCanvas.height);
      cleanup();
      resolve(scaledCanvas);
    };
    image.onerror = () => { cleanup(); reject(new Error("zine_image_decode_failed")); };
    image.src = url;
  });
}

function drawImageCover(context, bitmap, x, y, width, height) {
  const scale = Math.max(width / bitmap.width, height / bitmap.height);
  const cropWidth = width / scale;
  const cropHeight = height / scale;
  context.drawImage(bitmap, (bitmap.width - cropWidth) / 2, (bitmap.height - cropHeight) / 2, cropWidth, cropHeight, x, y, width, height);
}

function strokeFrame(context, x, y, width, height, theme) {
  context.strokeStyle = theme.frame;
  context.lineWidth = Math.max(2, Math.round(Math.min(context.canvas.width, context.canvas.height) * 0.002));
  context.strokeRect(x + 1, y + 1, width - 2, height - 2);
}

function wrapText(context, text, x, y, maxWidth, lineHeight, maxLines = 2) {
  const lines = [];
  let line = "";
  for (const character of String(text)) {
    const next = line + character;
    if (line && context.measureText(next).width > maxWidth) { lines.push(line); line = character; }
    else line = next;
  }
  lines.push(line);
  const clipped = lines.slice(0, maxLines);
  if (lines.length > maxLines) clipped[maxLines - 1] = `${clipped[maxLines - 1].slice(0, -1)}…`;
  const startY = y - (clipped.length - 1) * lineHeight;
  clipped.forEach((value, index) => context.fillText(value, x, startY + index * lineHeight));
}

function drawCover(context, bitmap, title, theme, templateId) {
  const { width, height } = context.canvas;
  const unit = Math.min(width, height);
  if (templateId === ZINE_BOOK_TEMPLATES.GALLERY.id) {
    const margin = unit * 0.09;
    const titleRoom = Math.max(unit * 0.2, height * 0.2);
    drawImageCover(context, bitmap, margin, margin, width - margin * 2, height - margin * 2 - titleRoom);
    strokeFrame(context, margin, margin, width - margin * 2, height - margin * 2 - titleRoom, theme);
    context.fillStyle = theme.ink;
    context.font = `600 ${Math.round(unit * 0.052)}px 'Songti SC', 'Iowan Old Style', serif`;
    wrapText(context, title, margin, height - margin * 0.72, width - margin * 2, unit * 0.06);
    return;
  }

  drawImageCover(context, bitmap, 0, 0, width, height);
  if (templateId === ZINE_BOOK_TEMPLATES.COLLAGE.id) {
    const panelX = unit * 0.06;
    const panelY = unit * 0.07;
    const panelWidth = Math.min(width - panelX * 2, unit * 0.9);
    const panelHeight = unit * 0.24;
    context.fillStyle = theme.panel;
    context.fillRect(panelX, panelY, panelWidth, panelHeight);
    context.fillStyle = theme.ink;
    context.font = `700 ${Math.round(unit * 0.05)}px 'Songti SC', 'Iowan Old Style', serif`;
    wrapText(context, title, panelX + unit * 0.035, panelY + panelHeight * 0.54, panelWidth - unit * 0.07, unit * 0.062);
    return;
  }

  const gradient = context.createLinearGradient(0, height * 0.5, 0, height);
  gradient.addColorStop(0, "rgba(70, 21, 40, 0)");
  gradient.addColorStop(1, "rgba(70, 21, 40, 0.88)");
  context.fillStyle = gradient;
  context.fillRect(0, height * 0.5, width, height * 0.5);
  context.fillStyle = "#fff8f5";
  context.font = `600 ${Math.round(unit * 0.06)}px 'Songti SC', 'Iowan Old Style', serif`;
  wrapText(context, title, unit * 0.06, height - unit * 0.1, width - unit * 0.12, unit * 0.068);
}

function drawFull(context, bitmap, theme, templateId) {
  const { width, height } = context.canvas;
  const unit = Math.min(width, height);
  const marginRatio = templateId === ZINE_BOOK_TEMPLATES.GALLERY.id ? 0.12 : templateId === ZINE_BOOK_TEMPLATES.COLLAGE.id ? 0.015 : 0.04;
  const margin = unit * marginRatio;
  drawImageCover(context, bitmap, margin, margin, width - margin * 2, height - margin * 2);
  strokeFrame(context, margin, margin, width - margin * 2, height - margin * 2, theme);
}

function drawDuo(context, bitmaps, theme, templateId) {
  const { width, height } = context.canvas;
  const unit = Math.min(width, height);
  const margin = unit * (templateId === ZINE_BOOK_TEMPLATES.GALLERY.id ? 0.09 : templateId === ZINE_BOOK_TEMPLATES.COLLAGE.id ? 0.015 : 0.035);
  const gap = unit * (templateId === ZINE_BOOK_TEMPLATES.GALLERY.id ? 0.055 : templateId === ZINE_BOOK_TEMPLATES.COLLAGE.id ? 0.012 : 0.022);
  const stacked = height > width * 1.12;
  bitmaps.forEach((bitmap, index) => {
    const itemWidth = stacked ? width - margin * 2 : (width - margin * 2 - gap) / 2;
    const itemHeight = stacked ? (height - margin * 2 - gap) / 2 : height - margin * 2;
    const x = stacked ? margin : margin + index * (itemWidth + gap);
    const y = stacked ? margin + index * (itemHeight + gap) : margin;
    drawImageCover(context, bitmap, x, y, itemWidth, itemHeight);
    strokeFrame(context, x, y, itemWidth, itemHeight, theme);
  });
}

function drawGrid(context, bitmaps, theme, templateId) {
  const { width, height } = context.canvas;
  const unit = Math.min(width, height);
  const margin = unit * (templateId === ZINE_BOOK_TEMPLATES.GALLERY.id ? 0.075 : templateId === ZINE_BOOK_TEMPLATES.COLLAGE.id ? 0.012 : 0.03);
  const gap = unit * (templateId === ZINE_BOOK_TEMPLATES.GALLERY.id ? 0.04 : templateId === ZINE_BOOK_TEMPLATES.COLLAGE.id ? 0.01 : 0.018);
  if (bitmaps.length >= 4) {
    const itemWidth = (width - margin * 2 - gap) / 2;
    const itemHeight = (height - margin * 2 - gap) / 2;
    bitmaps.slice(0, 4).forEach((bitmap, index) => {
      const x = margin + (index % 2) * (itemWidth + gap);
      const y = margin + Math.floor(index / 2) * (itemHeight + gap);
      drawImageCover(context, bitmap, x, y, itemWidth, itemHeight);
      strokeFrame(context, x, y, itemWidth, itemHeight, theme);
    });
    return;
  }

  if (width >= height) {
    const leftWidth = (width - margin * 2 - gap) * 0.58;
    const rightWidth = width - margin * 2 - gap - leftWidth;
    drawImageCover(context, bitmaps[0], margin, margin, leftWidth, height - margin * 2);
    strokeFrame(context, margin, margin, leftWidth, height - margin * 2, theme);
    const rightHeight = (height - margin * 2 - gap) / 2;
    [bitmaps[1], bitmaps[2]].forEach((bitmap, index) => {
      const x = margin + leftWidth + gap;
      const y = margin + index * (rightHeight + gap);
      drawImageCover(context, bitmap, x, y, rightWidth, rightHeight);
      strokeFrame(context, x, y, rightWidth, rightHeight, theme);
    });
    return;
  }

  const topHeight = (height - margin * 2 - gap) * 0.58;
  const bottomHeight = height - margin * 2 - gap - topHeight;
  drawImageCover(context, bitmaps[0], margin, margin, width - margin * 2, topHeight);
  strokeFrame(context, margin, margin, width - margin * 2, topHeight, theme);
  const itemWidth = (width - margin * 2 - gap) / 2;
  [bitmaps[1], bitmaps[2]].forEach((bitmap, index) => {
    const x = margin + index * (itemWidth + gap);
    const y = margin + topHeight + gap;
    drawImageCover(context, bitmap, x, y, itemWidth, bottomHeight);
    strokeFrame(context, x, y, itemWidth, bottomHeight, theme);
  });
}

function drawAccent(context, bitmap, caption, theme, templateId) {
  const { width, height } = context.canvas;
  const unit = Math.min(width, height);
  const sizeRatio = templateId === ZINE_BOOK_TEMPLATES.GALLERY.id ? 0.44 : templateId === ZINE_BOOK_TEMPLATES.COLLAGE.id ? 0.66 : 0.52;
  const imageSize = unit * sizeRatio;
  const x = (width - imageSize) / 2;
  const y = (height - imageSize) / 2 - unit * 0.05;
  drawImageCover(context, bitmap, x, y, imageSize, imageSize);
  strokeFrame(context, x, y, imageSize, imageSize, theme);
  context.fillStyle = theme.muted;
  context.font = `500 ${Math.round(unit * 0.038)}px 'Songti SC', 'Iowan Old Style', serif`;
  context.textAlign = "center";
  context.fillText(caption, width / 2, y + imageSize + unit * 0.075);
  context.textAlign = "left";
}

function drawClosing(context, title, count, theme) {
  const { width, height } = context.canvas;
  const unit = Math.min(width, height);
  context.textAlign = "center";
  context.fillStyle = theme.ink;
  context.font = `600 ${Math.round(unit * 0.047)}px 'Songti SC', 'Iowan Old Style', serif`;
  wrapText(context, title, width / 2, height * 0.44, width * 0.78, unit * 0.058);
  context.fillStyle = theme.muted;
  context.font = `400 ${Math.round(unit * 0.027)}px Inter, 'PingFang SC', sans-serif`;
  context.fillText(`共 ${count} 张回忆`, width / 2, height * 0.55);
  context.font = `italic 400 ${Math.round(unit * 0.024)}px 'Iowan Old Style', 'Songti SC', serif`;
  context.fillText("· 完 ·", width / 2, height * 0.62);
  context.textAlign = "left";
}
