// 相册：照片进来 → 读拍摄时间 → 按日子归成一本本。全部只存本机 IndexedDB。
import { exifTimestamp } from "/exif.js";

const $ = (id) => document.getElementById(id);

const DB_NAME = "huijian";
const STORE = "photos";
const MAX_EDGE = 1600;

let db = null;
let photos = [];          // {id, dataUrl, ts, day}  按 ts 升序
let openDay = null;       // 当前打开的相册（day 字符串）
let lightboxAt = -1;      // 灯箱里正在看的照片在 currentAlbum() 里的下标
let onMakeBook = null;    // 「做成纪念册」回调，由 app.js 注入

// ── 存储 ─────────────────────────────────────────────

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx(mode, run) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const outcome = run(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(outcome?.result);
    transaction.onerror = () => reject(transaction.error);
  });
}

// ── 导入 ─────────────────────────────────────────────

function dayOf(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

async function shrink(file) {
  const bitmapUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("decode_failed"));
      image.src = bitmapUrl;
    });
    const scale = Math.min(1, MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(image.naturalWidth * scale);
    canvas.height = Math.round(image.naturalHeight * scale);
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.82);
  } finally {
    URL.revokeObjectURL(bitmapUrl);
  }
}

async function importFiles(files) {
  if (!files.length) return;
  $("album-sorting").hidden = false;
  for (const file of files) {
    try {
      const bytes = await file.arrayBuffer();
      const ts = exifTimestamp(bytes) ?? file.lastModified ?? Date.now();
      const dataUrl = await shrink(file);
      const record = { id: `${ts}-${Math.random().toString(36).slice(2, 8)}`, dataUrl, ts, day: dayOf(ts) };
      await tx("readwrite", (store) => store.put(record));
      photos.push(record);
    } catch { /* 单张失败不拦整批 */ }
  }
  photos.sort((left, right) => left.ts - right.ts);
  $("album-sorting").hidden = true;
  renderShelf();
}

// ── 展示 ─────────────────────────────────────────────

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function dayTitle(day) {
  const [year, month, date] = day.split("-").map(Number);
  const when = new Date(year, month - 1, date);
  const base = `${month}月${date}日 · 周${WEEKDAYS[when.getDay()]}`;
  return year === new Date().getFullYear() ? base : `${year}年${base}`;
}

function groups() {
  const byDay = new Map();
  for (const photo of photos) {
    if (!byDay.has(photo.day)) byDay.set(photo.day, []);
    byDay.get(photo.day).push(photo);
  }
  return [...byDay.entries()].sort((left, right) => right[0].localeCompare(left[0]));
}

function currentAlbum() {
  return photos.filter((photo) => photo.day === openDay);
}

function renderShelf() {
  const shelf = $("album-shelf");
  shelf.innerHTML = "";
  const albums = groups();
  $("album-empty").hidden = albums.length > 0;
  $("me-count").textContent = String(photos.length);

  for (const [day, batch] of albums) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "album-card";
    card.innerHTML = `
      <span class="album-cover"><img src="${batch[0].dataUrl}" alt=""></span>
      <span class="album-name">${dayTitle(day)}</span>
      <span class="album-count">${batch.length} 张</span>`;
    card.addEventListener("click", () => openAlbum(day));
    shelf.append(card);
  }
}

function openAlbum(day) {
  openDay = day;
  const batch = currentAlbum();
  $("album-title").textContent = dayTitle(day);
  $("album-sub").textContent = `${batch.length} 张`;
  const grid = $("album-grid");
  grid.innerHTML = "";
  batch.forEach((photo, index) => {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "album-cell";
    cell.innerHTML = `<img src="${photo.dataUrl}" alt="">`;
    cell.addEventListener("click", () => showLightbox(index));
    grid.append(cell);
  });
  location.hash = "#album-detail";
}

// ── 灯箱 ─────────────────────────────────────────────

function showLightbox(index) {
  const batch = currentAlbum();
  if (!batch.length) { hideLightbox(); return; }
  lightboxAt = Math.max(0, Math.min(index, batch.length - 1));
  const photo = batch[lightboxAt];
  $("lightbox-img").src = photo.dataUrl;
  $("lightbox-meta").textContent = new Date(photo.ts).toLocaleString("zh-CN", {
    year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit"
  });
  $("lightbox").hidden = false;
  document.body.classList.add("lightbox-open");
}

function hideLightbox() {
  $("lightbox").hidden = true;
  document.body.classList.remove("lightbox-open");
}

async function deleteCurrent() {
  const batch = currentAlbum();
  const photo = batch[lightboxAt];
  if (!photo) return;
  await tx("readwrite", (store) => store.delete(photo.id));
  photos = photos.filter((candidate) => candidate.id !== photo.id);
  renderShelf();
  if (!currentAlbum().length) { hideLightbox(); location.hash = "#albums"; return; }
  openAlbum(openDay);
  showLightbox(Math.min(lightboxAt, currentAlbum().length - 1));
}

// ── 对外 ─────────────────────────────────────────────

export async function clearAll() {
  await tx("readwrite", (store) => store.clear());
  photos = [];
  renderShelf();
}

export function photoCount() {
  return photos.length;
}

export async function initAlbums({ makeBook }) {
  onMakeBook = makeBook;
  db = await openDb();
  photos = (await tx("readonly", (store) => store.getAll())) ?? [];
  photos.sort((left, right) => left.ts - right.ts);
  renderShelf();

  $("album-input").addEventListener("change", (event) => {
    importFiles([...event.target.files]);
    event.target.value = "";
  });

  const drop = $("album-drop");
  drop.addEventListener("dragover", (event) => { event.preventDefault(); drop.classList.add("dropping"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("dropping"));
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("dropping");
    importFiles([...event.dataTransfer.files].filter((file) => file.type.startsWith("image/")));
  });

  $("album-back").addEventListener("click", () => { location.hash = "#albums"; });
  $("album-to-book").addEventListener("click", () => {
    const batch = currentAlbum();
    if (batch.length && onMakeBook) onMakeBook(batch.map((photo) => ({ key: photo.id, src: photo.dataUrl, caption: "相册" })));
  });

  $("lightbox-close").addEventListener("click", hideLightbox);
  $("lightbox-prev").addEventListener("click", () => showLightbox(lightboxAt - 1));
  $("lightbox-next").addEventListener("click", () => showLightbox(lightboxAt + 1));
  $("lightbox-del").addEventListener("click", deleteCurrent);
  $("lightbox").addEventListener("click", (event) => { if (event.target === $("lightbox")) hideLightbox(); });
  document.addEventListener("keydown", (event) => {
    if ($("lightbox").hidden) return;
    if (event.key === "Escape") hideLightbox();
    if (event.key === "ArrowLeft") showLightbox(lightboxAt - 1);
    if (event.key === "ArrowRight") showLightbox(lightboxAt + 1);
  });
}
