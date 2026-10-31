import { routes } from "./routes.js";
import { mountWorldViewer, preferQuality } from "./viewer.js";
import { mountPanoViewer } from "./pano.js";

const main = document.getElementById("main");
const stage = document.getElementById("stage");
const viewport = document.getElementById("viewport");
const title = document.getElementById("stage-title");
const meta = document.getElementById("stage-meta");
const status = document.getElementById("stage-status");
const extra = document.getElementById("stage-extra");
const closeBtn = document.getElementById("close-stage");

const examples = routes.flatMap((route) => route.examples.map((example) => ({ ...example, section: route.id })));
let destroy = null;
let current = null;

function coverOf(example) {
  return example.cover || example.world?.thumbnailUrl || example.world?.panoramaUrl || "";
}

function card(example) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "card";
  button.dataset.id = example.id;
  button.innerHTML = `
    <span class="shot">${coverOf(example) ? `<img alt="" src="${coverOf(example)}" loading="lazy">` : ""}</span>
    <span class="copy">
      <small>${example.route}</small>
      <strong>${example.name}</strong>
      <em>${example.place} · ${example.date}</em>
    </span>
  `;
  button.addEventListener("click", () => openExample(example.id));
  return button;
}

function render() {
  main.replaceChildren();
  for (const route of routes) {
    const section = document.createElement("section");
    section.className = "route";
    section.id = route.id;
    section.innerHTML = `<header><p>${route.kicker}</p><h2>${route.title}</h2><p class="lead">${route.copy}</p></header>`;
    const grid = document.createElement("div");
    grid.className = "grid";
    route.examples.forEach((example) => grid.append(card(example)));
    section.append(grid);
    main.append(section);
  }
}

function setExtra(example) {
  extra.replaceChildren();
  if (example.marbleUrl || example.world?.marbleUrl) {
    const a = document.createElement("a");
    a.href = example.world?.marbleUrl || example.marbleUrl;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.textContent = "在 Marble 打开";
    extra.append(a);
  }
  if (example.href) {
    const a = document.createElement("a");
    a.href = example.href;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.textContent = "单独打开这一页";
    extra.append(a);
  }
}

async function openExample(id) {
  const example = examples.find((item) => item.id === id);
  if (!example) return;
  destroy?.();
  destroy = null;
  current = example;
  viewport.replaceChildren();
  title.textContent = example.name;
  meta.textContent = `${example.route} · ${example.place} · ${example.date}`;
  status.textContent = "正在打开…";
  setExtra(example);
  stage.hidden = false;
  stage.classList.add("open");
  document.body.style.overflow = "hidden";
  history.replaceState(null, "", `#${id}`);
  try {
    if (example.viewer === "world") {
      destroy = await mountWorldViewer({
        container: viewport,
        world: example.world,
        quality: preferQuality(),
        onStatus: (text) => { status.textContent = text; }
      });
    } else if (example.viewer === "pano") {
      destroy = await mountPanoViewer({
        container: viewport,
        panorama: example.panorama,
        onStatus: (text) => { status.textContent = text; }
      });
    } else {
      const frame = document.createElement("iframe");
      frame.title = example.name;
      frame.src = example.href;
      frame.allow = "fullscreen";
      viewport.append(frame);
      status.textContent = "里面可以走动；不行就用右下角单独打开。";
    }
  } catch (error) {
    console.error(error);
    status.textContent = "这一份暂时打不开，用右下角的单独打开。";
  }
}

function closeStage() {
  destroy?.();
  destroy = null;
  current = null;
  viewport.replaceChildren();
  stage.classList.remove("open");
  stage.hidden = true;
  document.body.style.overflow = "";
  if (location.hash) history.replaceState(null, "", location.pathname);
}

render();
closeBtn.addEventListener("click", closeStage);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && current) closeStage();
});
const fromHash = location.hash.replace("#", "");
if (fromHash && examples.some((item) => item.id === fromHash)) openExample(fromHash);
