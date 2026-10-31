// Bridges the already-shipped Book Lab backend (services/api/src/extensions/book-lab.mjs, mounted at
// /v2-labs/* when UNSEEN_BOOK_LAB_ENABLED=true) and the already-built same-origin UI client
// (packages/book-lab-web/src/integrated-*.mjs) into the customer SPA. This module is only ever imported by
// apps/web/src/extensions/index.js, and only after that host has already confirmed featureFlags.bookLab
// === true — see the "featureFlags.bookLab !== true" guard ahead of the dynamic import there. Nothing here
// needs to repeat that check for inertness, but individual renderers still no-op on missing context so a
// stale/partial context never throws mid-render.
//
// Design: the BL01-BL06 pages are rendered by packages/book-lab-web's BookLabIntegratedVisualShell, which
// owns its own fetch/paint/poll lifecycle against /v2-labs/* (see integrated-shell.mjs). This host's
// registerRoute() contract only supports returning a synchronous HTML string (it becomes app.innerHTML
// directly, with no post-render hook), so renderBookLabRoute() returns a small loading shell immediately
// and mounts the real shell once that container actually lands in the DOM (detected via MutationObserver,
// not timing assumptions about app.js's render pipeline). BOOK.SKIP is never disabled by the integrated
// shell (see bl01QuestionState() in integrated-shell.mjs), so a contributor can always skip the AI question
// step even while the question provider is unconfigured or the private-AI worker is offline/queued.

import { esc, shell } from "../ui/templates.js";

const ROUTE_MATCHERS = Object.freeze([
  /^\/labs\/memories\/photos\/[^/]+\/?$/u,
  /^\/labs\/memories\/[^/]+\/?$/u,
  /^\/labs\/books\/[^/]+\/contributions\/[^/]+\/?$/u,
  /^\/manage\/[^/]+\/book-lab\/?$/u,
  /^\/manage\/[^/]+\/book-lab\/[^/]+\/draft\/?$/u,
  /^\/s\/[^/]+\/books\/[^/]+\/versions\/[^/]+\/?$/u
]);

function matchesBookLabRoute(path) {
  return ROUTE_MATCHERS.some((pattern) => pattern.test(path));
}

const CATALOG_URL = "/__book_lab_web__/catalog.json";
const STYLESHEET_HREF = "/__book_lab_web__/src/styles.css";

let catalogPromise = null;
function loadCatalog() {
  catalogPromise ??= fetch(CATALOG_URL, { credentials: "same-origin" }).then((response) => {
    if (!response.ok) throw new Error("book_lab_catalog_unavailable");
    return response.json();
  }).catch((error) => { catalogPromise = null; throw error; });
  return catalogPromise;
}

function ensureStylesheet() {
  if (document.querySelector("link[data-book-lab-styles]")) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = STYLESHEET_HREF;
  link.dataset.bookLabStyles = "true";
  document.head.append(link);
}

function removeStylesheet() {
  document.querySelector("link[data-book-lab-styles]")?.remove();
}

let mountGeneration = 0;
let activeShell = null;
let unmountObserver = null;

function teardownActiveShell() {
  activeShell?.destroy();
  activeShell = null;
  unmountObserver?.disconnect();
  unmountObserver = null;
  removeStylesheet();
}

function watchForRemoval(container) {
  unmountObserver?.disconnect();
  unmountObserver = new MutationObserver(() => {
    if (!document.body.contains(container)) teardownActiveShell();
  });
  unmountObserver.observe(document.body, { childList: true, subtree: true });
}

// Waits for a specific element id to appear anywhere under document.body, without assuming anything about
// when or how app.js applies the HTML this module returned (a synchronous `app.innerHTML = html` today,
// but this must keep working even if that pipeline changes). Gives up after 10s so a discarded render
// (e.g. an error thrown elsewhere in app.js's route() before the returned HTML was ever applied) can't
// leak an observer forever.
function waitForMountElement(id, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    const existing = document.getElementById(id);
    if (existing) { resolve(existing); return; }
    let settled = false;
    const observer = new MutationObserver(() => {
      const found = document.getElementById(id);
      if (found && !settled) { settled = true; observer.disconnect(); clearTimeout(timer); resolve(found); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => {
      if (!settled) { settled = true; observer.disconnect(); resolve(null); }
    }, timeoutMs);
    // Browser setTimeout ids are plain numbers with no unref(); this only ever matters under
    // node --test, where an un-refed safety timer must not hold the process open.
    if (typeof timer?.unref === "function") timer.unref();
  });
}

function unavailableMarkup() {
  return '<section class="card card-body" role="alert"><p class="muted">纪念册实验暂时无法打开，请稍后重试。</p></section>';
}

async function mountBookLab(container, generation) {
  teardownActiveShell();
  ensureStylesheet();
  let shellModule;
  let catalog;
  try {
    [shellModule, catalog] = await Promise.all([
      import("@unseen/book-lab-web/integrated-shell.mjs"),
      loadCatalog()
    ]);
  } catch {
    if (generation === mountGeneration && document.body.contains(container)) container.innerHTML = unavailableMarkup();
    return;
  }
  if (generation !== mountGeneration || !document.body.contains(container)) return;
  const shell = shellModule.createIntegratedBookLabVisualShell({ catalog,
    navigate: (pathname) => globalThis.location.assign(pathname) });
  activeShell = shell;
  watchForRemoval(container);
  try {
    await shell.mount(container, location.pathname);
  } catch {
    if (generation === mountGeneration && document.body.contains(container)) container.innerHTML = unavailableMarkup();
  }
}

function renderBookLabRoute(context) {
  mountGeneration += 1;
  const generation = mountGeneration;
  const containerId = `book-lab-mount-${generation}`;
  waitForMountElement(containerId).then((container) => {
    if (container && generation === mountGeneration) void mountBookLab(container, generation);
  });
  return shell(`<div class="page book-lab-route">
    <p class="eyebrow">纪念册 <span class="status-pill">实验</span></p>
    <div id="${esc(containerId)}" class="book-lab-mount" aria-busy="true">
      <section class="card card-body"><p class="muted">正在打开纪念册实验…</p></section>
    </div>
  </div>`, { state: context?.state ?? {}, path: location.pathname, title: "纪念册 · UNSEEN" });
}

// photoDetail.afterPlacementSecondary: the contributor-facing entry point (BL01, answering the photo's
// question). Only shown once the photo has an id to link to. Copy/CTA per the photo-chat brief: an inviting
// "聊聊这张" button rather than a chore-sounding "回答问题" link — this is the one place a contributor can
// start the photo → question → answer → follow-up chain, so it needs to read as an invitation, not a task.
//
// Informed-consent gap (security audit P1-4, 2026-08-17): this teaser is the first thing a contributor sees
// about "AI" touching their photo, and the original copy ("AI 看了这张照片，想问你一句") never said the photo
// itself leaves the server for a third-party vision model — only the full collection notice on the BL01 page
// (rendered by packages/book-lab-web's renderBL01(), immediately above the actual trigger button) said
// anything at all, and even that notice text is server-injected (UNSEEN_BOOK_LAB_COLLECTION_NOTICE_COPY) and
// historically only covered the contributor's own written answer, not the photo. This line is a short,
// non-alarming heads-up read before the user even navigates to BL01; the full disclosure + explicit decline
// path (MEMORY.SKIP, already a first-class button next to MEMORY.START_QUESTION on BL01, see PAGE_ACTIONS in
// routes.mjs) lives on that page. See the production notice-copy recommendation and rollout steps in this
// change's delivery notes for the env-side half of this fix.
function renderPhotoSecondary(context) {
  const photoId = context?.photo?.id;
  if (!photoId) return "";
  return `<section class="card card-body stack-tight" aria-label="纪念册实验">
    <p class="eyebrow">纪念册 <span class="status-pill">实验</span></p>
    <p class="fine">AI 看了这张照片，想问你一句——这一步会把照片发给第三方 AI 服务识别画面；随时可以跳过，不影响这张照片。</p>
    <a class="button button-primary" href="/labs/memories/photos/${esc(photoId)}" data-nav>聊聊这张</a>
  </section>`;
}

// manageOverview.secondary: the owner-facing entry point (BL04, the book overview/create page for the
// current space).
function renderManageSecondary(context) {
  const spaceId = context?.state?.currentSpaceId;
  if (!spaceId) return "";
  return `<article class="card card-body stack-tight" aria-label="纪念册实验">
    <div><p class="eyebrow">纪念册 <span class="status-pill">实验</span></p><h2>把这段回忆做成纪念册</h2>
    <p class="fine">汇总已经单独授权入书的回忆，生成可下载的 PDF。</p></div>
    <a class="button" href="/manage/${esc(spaceId)}/book-lab" data-nav>查看纪念册</a>
  </article>`;
}

export async function registerBookLabWebExtension({ registerRoute, registerSecondarySlot, featureFlags } = {}) {
  if (featureFlags?.bookLab !== true) return;
  registerRoute(matchesBookLabRoute, renderBookLabRoute);
  registerSecondarySlot("photoDetail.afterPlacementSecondary", renderPhotoSecondary);
  registerSecondarySlot("manageOverview.secondary", renderManageSecondary);
}
