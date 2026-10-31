import { MomentApi } from "./moment-data.js";
import {
  escapeHtml as esc,
  photoRows,
  sources,
  versionStatus,
} from "./app-v2-core.js";
import { mountCorridor } from "./app-v2-corridor.js";
import { SharedUpload } from "./moment-shared-upload.js";

const root = document.querySelector("#v2"),
  sheet = document.querySelector("#sheet"),
  api = new MomentApi();
let user = null,
  epoch = 0,
  control = new AbortController(),
  cleanup = () => {},
  activeSpace = null,
  upload = null,
  createDraft = null,
  dialogEpoch = 0;
const enc = encodeURIComponent,
  go = (route) => {
    location.hash = route;
  },
  link = (route, text, primary = false) =>
    /* HTML */ `<a
      class="${primary ? "primary" : "secondary"}"
      href="#${esc(route)}"
      >${text}</a
    >`;
const tell = (text) => {
  document.querySelector("#notice").textContent = text;
};
const back = (title, route = "spaces") =>
  /* HTML */ `<div class="page-head">
    ${link(route, "← 返回")}<span>${title}</span><span>UNSEEN</span>
  </div>`;
function errorText(e) {
  return (
    {
      session_unavailable: "请登录后继续。",
      account_changed: "账号已变化，请重新登录后打开。",
      authentication_failed: "账号或密码不正确。",
      upload_unavailable: "照片收集已暂停，或没有上传权限。",
      resource_unavailable: "你暂时无法查看这个空间。",
      version_conflict: "空间刚刚有更新，请刷新后重试。",
      upload_original_file_required: "请选择原文件，再重试这一张。",
      upload_original_file_mismatch: "请选择原来那张照片。",
      upload_photo_policy: "文件格式或大小不符合当前要求。",
      upload_selection_invalid: "请选择页面限制内的照片。",
    }[e?.code] || "暂时未完成，请检查连接后重试。"
  );
}
async function request(path, options = {}) {
  const n = epoch;
  try {
    const data = await api.request(path, {
      ...options,
      signal: AbortSignal.any([control.signal, AbortSignal.timeout(120000)]),
      accountId: user?.id || null,
    });
    if (n !== epoch) throw new DOMException("页面已变化", "AbortError");
    return data;
  } catch (e) {
    if (["account_changed", "session_unavailable"].includes(e.code) && user) {
      user = null;
      createDraft = null;
      api.setAccount(null);
      cleanup();
      root.innerHTML =
        '<h1>登录状态已变化</h1><p>请刷新并登录后继续，私人内容已经关闭。</p><button data-action="refresh">重新打开</button>';
      closeSheet();
    }
    throw e;
  }
}
function paint(html) {
  root.innerHTML = html;
  root.focus({ preventScroll: true });
}
function closeSheet() {
  dialogEpoch++;
  sheet.querySelectorAll("audio").forEach((a) => {
    a.pause();
    a.removeAttribute("src");
    a.load();
  });
  sheet.close();
  sheet.innerHTML = "";
}
function openSheet(title, html) {
  closeSheet();
  sheet.innerHTML = /* HTML */ `<header>
      <h2 id="sheet-title">${esc(title)}</h2>
      <button data-close aria-label="关闭">×</button>
    </header>
    ${html}`;
  sheet.showModal();
}
sheet.addEventListener("click", (e) => {
  if (e.target.closest("[data-close]")) closeSheet();
});
sheet.addEventListener("cancel", (e) => {
  e.preventDefault();
  closeSheet();
});
document.querySelector("#add").onclick = () =>
  openSheet(
    "留下新的回忆",
    /* HTML */ `<div class="choices">
      ${link("spaces", "添加照片 · 选择已有空间")}${link(
        "new",
        "创建空间",
        true,
      )}
    </div>`,
  );
window.addEventListener("hashchange", () => render());
window.addEventListener("pageshow", (e) => {
  if (e.persisted) location.reload();
});
document.addEventListener("visibilitychange", async () => {
  if (document.hidden || !user) return;
  try {
    await request("/v1/profile");
  } catch (e) {
    if (e.name !== "AbortError") tell(errorText(e));
  }
});
function login() {
  paint(
    /* HTML */ `${back("回到你的回忆")}
      <section class="editor">
        <p class="eyebrow">你的照片，只在你的空间</p>
        <h1>登录后，继续留下。</h1>
        <form data-form="login">
          <label
            >账号<input
              name="username"
              autocomplete="username"
              required /></label
          ><label
            >密码<input
              name="password"
              type="password"
              autocomplete="current-password"
              required /></label
          ><button class="primary">登录并继续</button>
        </form>
        <p>使用现有 UNSEEN 账号。空间默认私密。</p>
        <a href="/app#me">注册或找回账号 →</a>
      </section>`,
  );
}
async function list() {
  if (!user) return login();
  const data = await request("/v1/me/spaces");
  const spaces = data.spaces.filter(
    (s) =>
      s.spaceLifecycle === "active" &&
      (s.owner || s.effectiveCanView || s.effectiveCanUpload),
  );
  paint(
    /* HTML */ `<section class="intro">
        <p class="eyebrow">回忆空间 · 我的</p>
        <h1>让照片，<br />有一个可以回去的地方。</h1>
        <p>先留下照片，再慢慢补齐那一天的现场。</p>
        ${link("new", "创建空间", true)}
      </section>
      <section class="space-grid">
        ${spaces
          .map(
            (s) =>
              /* HTML */ `<a class="space-card" href="#space/${enc(s.spaceId)}"
                ><span class="space-mark" aria-hidden="true">▧</span>
                <div>
                  <p>${s.owner ? "我创建的" : "共同参与"}</p>
                  <h2>${esc(s.name)}</h2>
                  <p>
                    ${s.sharingState === "private"
                      ? "私密空间"
                      : "仅按授权范围分享"}
                    · 打开 →
                  </p>
                </div></a
              >`,
          )
          .join("") ||
        '<div class="empty"><h2>第一段回忆，从一个名字开始。</h2><p>没有照片也可以创建，稍后再邀请同行者一起留下。</p></div>'}
      </section>`,
  );
}
function createView() {
  try {
    createDraft ||= JSON.parse(
      sessionStorage.getItem("unseen.v2.create:" + user.id) || "null",
    );
  } catch {}
  createDraft ||= { name: "", key: crypto.randomUUID() };
  paint(
    /* HTML */ `${back("创建空间")}
      <section class="editor">
        <p class="eyebrow">给这段回忆一个名字</p>
        <h1>这段回忆是什么？</h1>
        <p>一次旅行，一场相聚，或平常却想记住的一天。</p>
        <form data-form="create">
          <label
            >空间名称<input
              name="name"
              maxlength="120"
              required
              placeholder="例如：那年夏天的海边"
              value="${esc(createDraft.name)}"
          /></label>
          <div class="private-note">
            <span aria-hidden="true">○</span>
            <div>
              <strong>默认私密</strong>
              <p>创建后再决定邀请谁。没有素材，也可以先留下空间。</p>
            </div>
          </div>
          <label class="consent"
            ><input
              name="consent"
              type="checkbox"
              required
            />我有权建立这个空间，分享前会确认内容的使用范围。</label
          ><button class="primary">创建空间</button>
        </form>
        <p class="hint">封面随照片出现。时间与地点不影响创建。</p>
      </section>`,
  );
}
function sourceView(s) {
  paint(
    /* HTML */ `${back("选择素材", "space/" + enc(s.spaceId))}
      <section class="editor wide">
        <p class="eyebrow">${esc(s.name)} · 已创建</p>
        <h1>你现在有什么？</h1>
        <p>照片先留下，现场可以慢慢补齐。</p>
        <div class="source-grid">
          ${sources
            .map(
              ([key, title, description], i) =>
                /* HTML */ `<a
                  class="source-card"
                  href="#space/${enc(s.spaceId)}/${key === "empty"
                    ? ""
                    : key === "photos"
                      ? "upload"
                      : key}"
                  ><span aria-hidden="true"
                    >${["▧", "◉", "▷", "◎", "＋"][i]}</span
                  >
                  <div>
                    <h2>${title}</h2>
                    <p>${description}</p>
                  </div>
                  <b aria-hidden="true">↗</b></a
                >`,
            )
            .join("")}
        </div>
      </section>`,
  );
}
async function photoSheet(p, spaceId) {
  openSheet("照片与故事", '<p role="status">正在读取已授权的照片与故事…</p>');
  const d = dialogEpoch;
  try {
    const [detail, stories] = await Promise.all([
      request(`/v1/viewer/spaces/${enc(spaceId)}/photos/${enc(p.id)}`),
      request(`/v1/viewer/spaces/${enc(spaceId)}/stories`),
    ]);
    if (d !== dialogEpoch || !sheet.open) return;
    const safe = (url) =>
      typeof url === "string" &&
      /^\/v1\/(viewer|photos)\//.test(url) &&
      !url.includes("..")
        ? url
        : "";
    sheet.innerHTML = /* HTML */ `<header>
        <h2 id="sheet-title">照片与故事</h2>
        <button data-close aria-label="关闭">×</button>
      </header>
      <img
        class="story-photo"
        src="${esc(safe(detail.photoMedia?.url) || p.url)}"
        alt="照片完整画面"
      />
      <div class="story-copy">
        ${stories.stories
          .filter((s) => s.photoId === p.id)
          .map(
            (s) =>
              /* HTML */ `<article>
                <p>${esc(s.authorCredit)}</p>
                ${s.pieces
                  .map(
                    (piece) =>
                      `${piece.text ? /* HTML */ `<blockquote>${esc(piece.text)}</blockquote>` : ""}${piece.audio && safe(piece.audio.url) ? /* HTML */ `<audio controls preload="none" src="${esc(safe(piece.audio.url))}"></audio>` : ""}`,
                  )
                  .join("")}
              </article>`,
          )
          .join("") ||
        "<h3>这张照片，还没有分享的故事。</h3><p>原话与原声只有经讲述者确认分享后，才会出现在这里。</p>"}
      </div>`;
    sheet.querySelector("[data-close]").focus();
  } catch (e) {
    if (d === dialogEpoch && sheet.open)
      sheet.innerHTML = /* HTML */ `<header>
          <h2 id="sheet-title">暂时无法读取</h2>
          <button data-close aria-label="关闭">×</button>
        </header>
        <p>${esc(errorText(e))}</p>
        <button id="retry-photo">重试照片与故事</button>`;
    sheet
      .querySelector("#retry-photo")
      ?.addEventListener("click", () => photoSheet(p, spaceId));
  }
}
async function detail(s, mode) {
  const generation = epoch;
  const sid = enc(s.spaceId),
    canView = s.owner || s.effectiveCanView;
  const viewer = canView
    ? await request("/v1/viewer/spaces/" + sid)
    : { photos: [] };
  const photos = photoRows(s.spaceId, viewer.photos);
  let scene = null;
  if (viewer.sceneContext) {
    const { sharedSceneOptions } = await import("./moment-shared-spaces.js");
    scene = sharedSceneOptions(viewer.sceneContext);
    if (generation !== epoch) return;
  }
  paint(
    /* HTML */ `${back("回忆空间")}
      <header class="space-heading">
        <div>
          <p class="eyebrow">
            ${s.sharingState === "private" ? "私密回忆空间" : "按授权范围分享"}
            · ${photos.length} 张可展示照片
          </p>
          <h1>${esc(s.name)}</h1>
        </div>
        ${s.owner ? link("space/" + sid + "/invite", "邀请同行者") : ""}
      </header>
      <nav class="view-tabs" aria-label="现场版本">
        ${photos.length
          ? `${link("space/" + sid, "照片")}${link("space/" + sid + "/corridor", "照片走廊")}`
          : ""}${scene ? link("space/" + sid + "/scene", "回到现场") : ""}
      </nav>
      <section id="space-content"></section>
      <div class="space-next">
        ${s.owner || s.effectiveCanUpload
          ? link("space/" + sid + "/upload", "添加照片", true)
          : ""}${s.owner
          ? link("space/" + sid + "/sources", "补充现场素材")
          : ""}<button data-action="refresh">更新空间</button>
      </div>
      <div id="version-status" aria-live="polite"></div>
      <details class="version-note">
        <summary>现场版本与 AI 建议</summary>
        <p>
          照片走廊是照片展陈，不代表真实三维重建或拍摄机位。${scene
            ? "已有现场版本可单独查看，照片仍留在同一个空间。"
            : "还没有可查看的现场版本。"}
        </p>
        <p>
          AI
          分组与视频重建尚未在此入口开放；不会根据照片数量承诺可重建。已有处理中的现场可稍后更新查看，照片浏览不需要等待。
        </p>
      </details>`,
  );
  const content = root.querySelector("#space-content");
  if (s.owner)
    request("/api/world/jobs")
      .then((result) => {
        if (generation !== epoch) return;
        const rows = (result.jobs || []).filter((j) => j.spaceId === s.spaceId);
        root.querySelector("#version-status").innerHTML = rows
          .map(
            (j) =>
              /* HTML */ `<aside class="version-state">
                <strong>${esc(versionStatus(j))}</strong>
                <p>
                  AI 补全现场 ·
                  ${["failed", "rejected"].includes(j.status)
                    ? "原照片仍在这里，可以继续浏览或补充。"
                    : "照片走廊不受现场处理影响。"}${j.status === "complete" &&
                  !j.importedSpaceId
                    ? " 完成品仍需在现有 App 中确认加入。"
                    : ""}
                </p>
              </aside>`,
          )
          .join("");
      })
      .catch((e) => {
        if (generation === epoch && e.name !== "AbortError") {
          const panel = root.querySelector("#version-status");
          if (panel)
            panel.textContent =
              "现场处理状态暂时无法核对。照片仍可浏览，可稍后更新空间。";
        }
      });

  if (!photos.length && mode !== "scene") {
    content.innerHTML = /* HTML */ `<div class="empty empty-space">
      <span aria-hidden="true">＋</span>
      <h2>空间留下了，等第一张照片。</h2>
      <p>
        ${canView
          ? "添加照片后，走廊会从真实照片中展开。已保存但尚未通过展示检查的照片，暂时不会出现。"
          : "当前授权允许贡献照片，但不允许浏览其他人的照片。"}
      </p>
      ${s.owner ? link("space/" + sid + "/invite", "邀请同行者补上视角") : ""}
    </div>`;
    return;
  }
  if (mode === "corridor") {
    cleanup = mountCorridor(content, {
      photos,
      spaceId: s.spaceId,
      accountId: user.id,
      onPhoto: (p) => photoSheet(p, s.spaceId),
    });
    return;
  }
  if (mode === "scene" && scene) {
    content.innerHTML = /* HTML */ `<div class="scene-stage"></div>
      <p>${esc(scene.authenticity || "AI 补全空间，可能与真实现场不同。")}</p>`;
    const { mountAppSpatial } = await import("./unseen-app-spatial.js");
    if (generation !== epoch) return;
    cleanup = mountAppSpatial({
      container: content.querySelector(".scene-stage"),
      ...scene,
      signal: control.signal,
      onError: () => tell("现场暂时无法读取，请更新重试。照片仍可查看。"),
    });
    return;
  }
  content.innerHTML = `${
    photos.length
      ? /* HTML */ `<a class="photo-hero" href="#space/${sid}/corridor"
            ><img
              src="${esc(photos[0].url)}"
              alt="空间的第一张照片"
              decoding="async"
            /><span
              ><small>照片展陈</small><strong>走进照片走廊</strong
              ><b>打开 →</b></span
            ></a
          >
          <div class="photo-grid">
            ${photos
              .map(
                (p, i) =>
                  /* HTML */ `<button
                    data-photo="${i}"
                    aria-label="打开照片 ${i + 1} 与故事"
                  >
                    <img
                      src="${esc(p.url)}"
                      alt="照片 ${i + 1}"
                      loading="lazy"
                      decoding="async"
                    />
                  </button>`,
              )
              .join("")}
          </div>`
      : ""
  }`;
  content
    .querySelectorAll("[data-photo]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          photoSheet(photos[Number(b.dataset.photo)], s.spaceId)),
    );
  content.querySelectorAll("img").forEach(
    (img) =>
      (img.onerror = () => {
        img.alt = "照片暂时无法读取，请更新重试";
        img.classList.add("broken");
      }),
  );
}
async function uploadView(s) {
  const sid = enc(s.spaceId);
  paint(
    /* HTML */ `${back("添加照片", "space/" + sid)}
      <section class="editor">
        <p class="eyebrow">${esc(s.name)}</p>
        <h1>把你的视角留下。</h1>
        <p>每张照片独立保存。现场处理不会挡住照片浏览。</p>
        <div id="upload-panel" role="region" aria-label="照片上传"></div>
        ${link("space/" + sid, "查看空间与照片走廊")}
      </section>`,
  );
  let context;
  try {
    context = await request(`/v1/spaces/${sid}/upload-context`);
  } catch (e) {
    root.querySelector("#upload-panel").innerHTML = /* HTML */ `<p>
        ${esc(errorText(e))}
      </p>
      ${s.owner && s.collectionState !== "open"
        ? '<button data-action="open-collection" class="primary">开启照片收集</button>'
        : '<button data-action="refresh">重新检查</button>'}`;
    return;
  }
  const current = epoch;
  const paintUpload = () => {
    if (current !== epoch) return;
    const panel = root.querySelector("#upload-panel");
    if (!panel) return;
    if (!upload.state) {
      panel.innerHTML = /* HTML */ `<form data-form="upload">
        <label
          >选择照片<input
            name="photos"
            type="file"
            accept="${esc(context.photoFormats.join(","))}"
            multiple
            required
        /></label>
        <p>
          每批最多 ${context.limits.batchItems} 张，每张不超过
          ${Math.floor(context.limits.photoBytes / 1048576)} MB。
        </p>
        <label class="consent"
          ><input
            type="checkbox"
            name="consent"
            required
          />我有权上传这些照片，同意在此空间展示并按空间权限审核。私人聊天与原声不会自动加入。</label
        >
        <details>
          <summary>照片处理说明</summary>
          <p>
            展示副本会移除 EXIF /
            GPS；拍摄时间可能用于排序，缺失时不补造。原件按现有账号与邀请权限保护。
          </p>
        </details>
        <button class="primary">保存选中的照片</button>
      </form>`;
      let starting = false;
      panel.querySelector("form").onsubmit = async (e) => {
        e.preventDefault();
        if (upload.busy || starting) return;
        starting = true;
        e.submitter.disabled = true;
        try {
          await upload.start([...e.target.elements.photos.files], context);
          if (upload.complete()) await upload.finalize();
        } catch (err) {
          tell(errorText(err));
        } finally {
          starting = false;
        }
        paintUpload();
      };
      return;
    }
    panel.innerHTML = /* HTML */ `<div class="upload-results">
        ${upload.state.files
          .map((f, i) => {
            const item = upload.result?.items?.find(
                (x) => (x.itemId || x.id) === f.itemId,
              ),
              done = item?.status === "committed" || !!upload.state.completed;
            return /* HTML */ `<article>
              <strong>${esc(f.name)}</strong>
              <p>
                ${done
                  ? "已保存 · 展示以空间审核结果为准"
                  : f.error
                    ? esc(errorText({ code: f.error }))
                    : esc(f.phase || "等待保存")}
              </p>
              ${!done && !upload.busy
                ? /* HTML */ `<label
                      >重选原件<input
                        type="file"
                        data-file="${i}"
                        accept="${esc(
                          context.photoFormats.join(","),
                        )}" /></label
                    ><button data-retry="${i}">重试这一张</button>`
                : ""}
            </article>`;
          })
          .join("")}
      </div>
      ${upload.state.completed
        ? "<p>已核对本批回执。</p><button data-more>再添加一批</button>"
        : /* HTML */ `<button data-finish ${upload.busy ? "disabled" : ""}>
            更新状态并核对回执
          </button>`}`;
    panel.querySelectorAll("[data-retry]").forEach(
      (b) =>
        (b.onclick = async () => {
          const i = Number(b.dataset.retry),
            file = panel.querySelector(`[data-file="${i}"]`).files[0];
          try {
            await upload.resume(i, file);
            if (upload.complete()) await upload.finalize();
          } catch (e) {
            tell(errorText(e));
          }
          paintUpload();
        }),
    );
    panel
      .querySelector("[data-finish]")
      ?.addEventListener("click", async () => {
        try {
          await upload.refresh();
          await upload.finalize();
        } catch (e) {
          tell(errorText(e));
        }
        paintUpload();
      });
    panel.querySelector("[data-more]")?.addEventListener("click", () => {
      upload.clearCompleted();
      paintUpload();
    });
  };
  upload = new SharedUpload({
    request,
    spaceId: s.spaceId,
    identityKey: user.id,
    signal: control.signal,
    isCurrent: () => current === epoch,
    onChange: paintUpload,
  });
  if (upload.state?.batchId) await upload.refresh();
  paintUpload();
}
async function panoramaView(s) {
  paint(
    /* HTML */ `${back("全景照片", "space/" + enc(s.spaceId) + "/sources")}
      <section class="editor">
        <p class="eyebrow">${esc(s.name)} · 增加现场版本</p>
        <h1>再次环顾那一天。</h1>
        <p>
          一张完整全景可环顾现场，不能走到照片未拍到的位置。保存后仍是同一个回忆空间。
        </p>
        <form data-form="panorama">
          <label
            >完整全景照片<input
              name="panorama"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              required
          /></label>
          <p>JPEG / PNG / WebP · 2:1 · 1600×800 至 8192×4096 · 最多 12 MB</p>
          <label class="consent"
            ><input
              name="consent"
              type="checkbox"
              required
            />我有权将这张全景私有保存到此空间。</label
          ><button class="primary">保存全景现场</button>
        </form>
      </section>`,
  );
}
async function render() {
  epoch++;
  control.abort();
  control = new AbortController();
  cleanup();
  cleanup = () => {};
  closeSheet();
  upload = null;
  tell("");
  const n = epoch;
  const route = location.hash.slice(1) || "spaces";
  document
    .querySelectorAll(".dock a")
    .forEach((a) =>
      a.setAttribute(
        "aria-current",
        route === "spaces" && a.hash === "#spaces" ? "page" : "false",
      ),
    );
  root.classList.toggle("corridor-page", route.endsWith("/corridor"));
  window.scrollTo(0, 0);
  root.setAttribute("aria-busy", "true");
  paint('<p role="status">正在打开回忆空间…</p>');
  try {
    if (!user) {
      const p = await request("/v1/profile");
      user = p.user;
      api.setAccount(user.id);
    }
    if (route === "new") createView();
    else if (route.startsWith("space/")) {
      const [, sid, mode = ""] = route.split("/");
      const spaces = await request("/v1/me/spaces");
      const s = spaces.spaces.find(
        (s) => s.spaceId === sid && s.spaceLifecycle === "active",
      );
      if (!s) throw { code: "resource_unavailable" };
      activeSpace = s;
      if (mode === "sources") sourceView(s);
      else if (mode === "upload") await uploadView(s);
      else if (mode === "panorama") await panoramaView(s);
      else if (["phone", "panoramic"].includes(mode))
        paint(
          /* HTML */ `${back("现场素材", "space/" + enc(sid) + "/sources")}
            <section class="editor">
              <p class="eyebrow">${esc(s.name)} · 空间已保存</p>
              <h1>
                ${mode === "phone" ? "手机视频" : "全景采集"}，先留在设备里。
              </h1>
              <p>
                这条现场处理路线尚未开放，当前不会上传原片，也没有排队或生成任务。
              </p>
              <p>可以先添加照片浏览走廊，或者邀请同行者补充素材。</p>
              ${link("space/" + enc(sid) + "/upload", "先添加照片", true)}
              ${link("space/" + enc(sid), "回到空间")}
            </section>`,
        );
      else if (mode === "invite") {
        paint(
          /* HTML */ `${back("邀请同行者", "space/" + enc(sid))}
            <div id="invite"></div>`,
        );
        const { createMomentSharedSpaces } = await import(
          "./moment-shared-spaces.js"
        );
        if (n !== epoch) return;
        const shared = createMomentSharedSpaces({
          api,
          user: () => user,
          navigate: (r) => {
            if (r === "spaces") go("spaces");
            else if (r.startsWith("shared-space/")) {
              const tab = new URLSearchParams(r.split("?")[1]).get("tab");
              go(
                "space/" +
                  sid +
                  (tab === "share"
                    ? "/invite"
                    : tab === "upload"
                      ? "/upload"
                      : ""),
              );
            } else location.href = "/app#" + r;
          },
          onError: (e) => tell(errorText(e)),
        });
        cleanup = () => shared.destroy();
        await shared.mount(
          root.querySelector("#invite"),
          "shared-space/" + sid + "?tab=share",
        );
      } else await detail(s, mode);
    } else await list();
  } catch (e) {
    if (n !== epoch || e.name === "AbortError") return;
    if (!user && e.code === "session_unavailable") login();
    else
      paint(
        /* HTML */ `${back("重新打开")}
          <section class="empty">
            <h1>暂时没能打开。</h1>
            <p>${esc(errorText(e))}</p>
            <button data-action="refresh">重试</button>
          </section>`,
      );
  } finally {
    if (n === epoch) root.removeAttribute("aria-busy");
  }
}
root.addEventListener("input", (e) => {
  if (e.target.name === "name" && createDraft) {
    createDraft.name = e.target.value;
    try {
      sessionStorage.setItem(
        "unseen.v2.create:" + user.id,
        JSON.stringify(createDraft),
      );
    } catch {}
  }
});
root.addEventListener("click", async (e) => {
  const action = e.target.closest("[data-action]")?.dataset.action;
  if (action === "refresh") render();
  if (action === "open-collection") {
    try {
      await request(
        `/v1/spaces/${enc(activeSpace.spaceId)}/collection-transitions`,
        { method: "POST", body: { to: "open" }, version: activeSpace.version },
      );
      render();
    } catch (err) {
      tell(errorText(err));
    }
  }
});
root.addEventListener("submit", async (e) => {
  const form = e.target,
    type = form.dataset.form;
  if (!type || type === "upload") return;
  e.preventDefault();
  const b = e.submitter;
  if (b.disabled) return;
  b.disabled = true;
  const data = new FormData(form);
  try {
    if (type === "login") {
      const r = await request("/v1/auth/password-login", {
        method: "POST",
        body: {
          username: String(data.get("username")).trim(),
          password: String(data.get("password")),
        },
      });
      const p = await request("/v1/profile");
      if (p.user.id !== r.accountId) throw { code: "account_changed" };
      user = p.user;
      api.setAccount(user.id);
      render();
    }
    if (type === "create") {
      const notice = await request("/v1/notices/current?purpose=space_create");
      const result = await request("/v1/spaces", {
        method: "POST",
        body: { name: String(data.get("name")).trim() },
        key: createDraft.key,
        notice,
      });
      try {
        sessionStorage.removeItem("unseen.v2.create:" + user.id);
      } catch {}
      createDraft = null;
      go("space/" + enc(result.spaceId) + "/sources");
    }
    if (type === "panorama") {
      const target = { ...activeSpace };
      const file = data.get("panorama");
      if (
        !file.size ||
        file.size > 12 * 1048576 ||
        !["image/jpeg", "image/png", "image/webp"].includes(file.type)
      )
        throw { code: "upload_photo_policy" };
      const bitmap = await createImageBitmap(file);
      const valid =
        bitmap.width === bitmap.height * 2 &&
        bitmap.width >= 1600 &&
        bitmap.width <= 8192;
      bitmap.close();
      if (!valid) throw { code: "upload_photo_policy" };
      const manager = await request(
        `/v1/spaces/${enc(target.spaceId)}/management`,
      );
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      form.dataset.key ||= crypto.randomUUID();
      await request("/v1/app-spaces/" + form.dataset.key, {
        method: "PUT",
        key: form.dataset.key,
        version: manager.version,
        body: {
          title: target.name,
          spaceId: target.spaceId,
          sceneIfMatchVersion: manager.sceneVersion,
          consent: true,
          panorama: {
            name: file.name,
            mimeType: file.type,
            dataBase64: base64,
          },
        },
      });
      go("space/" + enc(target.spaceId) + "/scene");
    }
  } catch (err) {
    if (err.name !== "AbortError") tell(errorText(err));
  } finally {
    if (b.isConnected) b.disabled = false;
  }
});
render();
