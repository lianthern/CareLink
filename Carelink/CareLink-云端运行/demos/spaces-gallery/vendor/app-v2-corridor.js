import { escapeHtml as esc, frameWindow, positionKey } from "./app-v2-core.js";
// Seven reusable frames, no WebGL, no perpetual animation loop.
export function mountCorridor(
  root,
  { photos, accountId, spaceId, onPhoto, storage = globalThis.sessionStorage, immersive = false, onEnd },
) {
  const key = positionKey(accountId, spaceId),
    motion = matchMedia("(prefers-reduced-motion: reduce)");
  let position = 0;
  try {
    position = frameWindow(photos.length, storage.getItem(key)).current;
  } catch {}
  let timer,
    drag = null,
    suppress = false;
  root.innerHTML = /* HTML */ `<div
      class="corridor ${immersive ? "v2-corridor" : ""}"
      tabindex="0"
      role="region"
      aria-label="照片走廊，方向键浏览，Enter 打开故事"
    >
      ${immersive ? `<div class="v2-hall" aria-hidden="true">${Array.from({length:9},(_,i)=>`<div class="ring" style="transform:translateZ(${-i*250}px)"></div>`).join('')}</div><div class="floor"></div><div class="fog"></div>` : '<div class="hall-lines" aria-hidden="true"></div>'}
      <div class="frames"></div>
    </div>
    <div class="corridor-controls">
      <button data-prev aria-label="上一张照片">←</button
      ><span data-count role="status"></span
      ><button data-next aria-label="下一张照片">→</button
      ><button data-open>照片与故事</button>
    </div>
    <p class="hint">上下轻扫或拖动前进 · 滚轮与方向键也可浏览</p>
    <p data-end hidden>
      这一段回忆，已经走到这里。${onEnd ? '<button data-add-more>继续添加照片</button>' : '回到空间，可以继续添加照片或邀请同行者。'}
    </p>`;
  const hall = root.querySelector(".corridor"),
    frames = root.querySelector(".frames");
  const nodes = new Map();
  function paint() {
    const { current, indices } = frameWindow(photos.length, position);
    hall.classList.toggle("reduced", motion.matches);
    for (const [i, node] of nodes)
      if (!indices.includes(i)) {
        node.remove();
        nodes.delete(i);
      }
    for (const i of indices) {
      let node = nodes.get(i);
      if (!node) {
        node = document.createElement("button");
        node.className = "photo-frame";
        node.dataset.index = i;
        node.innerHTML = /* HTML */ `<img
            src="${esc(photos[i].url)}"
            alt="照片 ${i + 1}"
            loading="lazy"
            draggable="false"
            decoding="async"
          /><span>照片 ${i + 1}</span>`;
        node.querySelector("img").onerror = () => {
          node.classList.add("broken");
          node.setAttribute("aria-label", `重试照片 ${i + 1}`);
          node.querySelector("span").textContent =
            `照片 ${i + 1} 暂时无法读取 · 点击重试`;
        };
        node.querySelector("img").onload = () => {
          node.classList.remove("broken");
          node.querySelector("span").textContent = `照片 ${i + 1}`;
          node.setAttribute("aria-label", `照片 ${i + 1}，打开照片与故事`);
        };
        nodes.set(i, node);
        frames.append(node);
      }
      const delta = i - position;
      node.style.setProperty("--delta", delta);
      node.style.setProperty("--side", i % 2 ? 1 : -1);
      if(immersive){node.style.setProperty("--depth", `${-140-delta*160}px`);node.classList.toggle("passed",delta < -1.2);}
      node.style.zIndex = String(20 - Math.abs(i - current));
      node.classList.toggle("current", i === current);
      node.hidden = motion.matches && i !== current;
      node.tabIndex = i === current ? 0 : -1;
      node.setAttribute(
        "aria-label",
        node.classList.contains("broken")
          ? `重试照片 ${i + 1}`
          : `照片 ${i + 1}，打开照片与故事`,
      );
      node.setAttribute("aria-current", i === current ? "true" : "false");
    }
    root.querySelector("[data-count]").textContent =
      `${current + 1} / ${photos.length}`;
    root.querySelector("[data-prev]").disabled = current === 0;
    root.querySelector("[data-next]").disabled = current === photos.length - 1;
    root.querySelector("[data-end]").hidden = current !== photos.length - 1;
  }
  function save() {
    try {
      storage.setItem(key, String(Math.round(position)));
    } catch {}
  }
  function set(next, snap = true) {
    position = Math.max(0, Math.min(photos.length - 1, next));
    paint();
    clearTimeout(timer);
    if (snap)
      timer = setTimeout(() => {
        position = Math.round(position);
        paint();
        save();
      }, 120);
  }
  const wheel = (e) => {
    e.preventDefault();
    set(position + Math.max(-0.75, Math.min(0.75, e.deltaY / 180)));
  };
  const down = (e) => {
    if (e.button !== 0) return;
    drag = { y: e.clientY, start: position, moved: 0 };
    suppress = false;
  };
  const move = (e) => {
    if (!drag) return;
    drag.moved = Math.max(drag.moved, Math.abs(e.clientY - drag.y));
    if (drag.moved > 8 && !hall.hasPointerCapture(e.pointerId))
      hall.setPointerCapture(e.pointerId);
    set(drag.start + (drag.y - e.clientY) / 160, false);
  };
  const up = () => {
    if (!drag) return;
    suppress = drag.moved > 8;
    drag = null;
    set(Math.round(position));
  };
  const keyboard = (e) => {
    if (
      [
        "ArrowDown",
        "ArrowRight",
        "ArrowUp",
        "ArrowLeft",
        "Home",
        "End",
      ].includes(e.key)
    ) {
      e.preventDefault();
      set(
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? photos.length - 1
            : Math.round(position) +
              (["ArrowDown", "ArrowRight"].includes(e.key) ? 1 : -1),
      );
    } else if (e.key === "Enter" && e.target === hall) {
      e.preventDefault();
      onPhoto(photos[Math.round(position)]);
    }
  };
  const click = (e) => {
    const node = e.target.closest("[data-index]");
    if (node && !suppress) {
      set(Number(node.dataset.index));
      if (node.classList.contains("broken")) {
        const img = node.querySelector("img");
        node.querySelector("span").textContent =
          `照片 ${Number(node.dataset.index) + 1} 正在重试…`;
        img.removeAttribute("src");
        img.src = photos[Number(node.dataset.index)].url;
      } else onPhoto(photos[Number(node.dataset.index)]);
    }
    suppress = false;
    if (e.target.closest("[data-prev]")) set(Math.round(position) - 1);
    if (e.target.closest("[data-next]")) set(Math.round(position) + 1);
    if (e.target.closest("[data-open]")) onPhoto(photos[Math.round(position)]);
    if (e.target.closest("[data-add-more]")) onEnd?.();
  };
  hall.addEventListener("wheel", wheel, { passive: false });
  hall.addEventListener("pointerdown", down);
  hall.addEventListener("pointermove", move);
  hall.addEventListener("pointerup", up);
  hall.addEventListener("pointercancel", up);
  hall.addEventListener("keydown", keyboard);
  root.addEventListener("click", click);
  motion.addEventListener("change", paint);
  paint();
  return () => {
    clearTimeout(timer);
    save();
    motion.removeEventListener("change", paint);
    hall.removeEventListener("wheel", wheel);
    hall.removeEventListener("pointerdown", down);
    hall.removeEventListener("pointermove", move);
    hall.removeEventListener("pointerup", up);
    hall.removeEventListener("pointercancel", up);
    hall.removeEventListener("keydown", keyboard);
    root.removeEventListener("click", click);
  };
}
