const error = (code, message) => Object.assign(new Error(message), { code });
const esc = (value) => String(value).replace(/[&<>"']/g,
  (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

function normalizedVisual(visual) {
  if (typeof visual?.prompt !== "string" || visual.prompt.length < 1 || visual.prompt.length > 40 ||
    !Array.isArray(visual.tiles) || visual.tiles.length !== 9) return null;
  const tiles = visual.tiles.map((tile) => {
    if (typeof tile?.path !== "string" || tile.path.length > 200 || !/^#[0-9a-f]{6}$/i.test(tile.fill) ||
      !Number.isSafeInteger(tile.rotate) || tile.rotate < -20 || tile.rotate > 20 ||
      !Array.isArray(tile.dots) || tile.dots.length > 8) return null;
    const dots = tile.dots.map((dot) => Array.isArray(dot) && dot.length === 3 &&
      dot.every(Number.isSafeInteger) ? dot : null);
    return dots.includes(null) ? null : { ...tile, dots };
  });
  return tiles.includes(null) ? null : { prompt: visual.prompt, tiles };
}

export function buildLocalCaptchaMarkup(visual) {
  const safe = normalizedVisual(visual);
  if (!safe) throw error("otp_verification_unavailable", "人机验证暂时无法加载，请稍后重试。");
  const tiles = safe.tiles.map((tile, index) => `<button class="local-captcha-tile" type="button" data-local-captcha-tile="${index}" aria-pressed="false" aria-label="图形选项 ${index + 1}"><svg viewBox="0 0 100 100" aria-hidden="true"><path d="${esc(tile.path)}" fill="${tile.fill}" transform="rotate(${tile.rotate} 50 50)"/>${tile.dots.map(([x, y, radius]) => `<circle cx="${x}" cy="${y}" r="${radius}"/>`).join("")}</svg></button>`).join("");
  return `<div class="dialog-scrim" data-local-captcha><section class="dialog local-captcha-dialog" role="dialog" aria-modal="true" aria-labelledby="local-captcha-title"><header class="dialog-header"><div><p class="eyebrow">安全验证</p><h2 id="local-captcha-title">证明你不是自动程序</h2></div></header><div class="dialog-body"><p>${esc(safe.prompt)}</p><div class="local-captcha-grid">${tiles}</div><p class="fine" data-local-captcha-status aria-live="polite">选好后点击“完成验证”。</p></div><footer class="dialog-footer"><button class="button" type="button" data-local-captcha-cancel>取消</button><button class="button button-primary" type="button" data-local-captcha-confirm>完成验证</button></footer></section></div>`;
}

export function solveLocalVisualChallenge(challenge, { documentObj = document } = {}) {
  if (!challenge?.visual || !documentObj?.body) return Promise.reject(
    error("otp_verification_unavailable", "人机验证暂时无法加载，请稍后重试。"));
  let markup;
  try { markup = buildLocalCaptchaMarkup(challenge.visual); }
  catch (cause) { return Promise.reject(cause); }
  const wrapper = documentObj.createElement("div");
  wrapper.innerHTML = markup;
  const scrim = wrapper.firstElementChild;
  const host = documentObj.querySelector("[data-dialog-root]") ?? documentObj.body;
  const page = documentObj.querySelector("#app");
  const wasInert = page?.inert ?? false;
  const selected = new Set();
  page && (page.inert = true);
  host.append(scrim);
  scrim.querySelector("[data-local-captcha-tile]")?.focus();

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      documentObj.removeEventListener("keydown", onKeydown);
      scrim.remove();
      if (page) page.inert = wasInert;
    };
    const finish = (action) => { cleanup(); action(); };
    const cancel = () => finish(() => reject(
      error("otp_verification_cancelled", "已取消人机验证。")));
    const onKeydown = (event) => { if (event.key === "Escape") cancel(); };
    documentObj.addEventListener("keydown", onKeydown);
    scrim.addEventListener("click", (event) => {
      const tile = event.target.closest?.("[data-local-captcha-tile]");
      if (tile) {
        const index = Number(tile.dataset.localCaptchaTile);
        selected.has(index) ? selected.delete(index) : selected.add(index);
        tile.setAttribute("aria-pressed", String(selected.has(index)));
        scrim.querySelector("[data-local-captcha-status]").textContent = `已选择 ${selected.size} 张图片。`;
        return;
      }
      if (event.target.closest?.("[data-local-captcha-cancel]")) cancel();
      if (event.target.closest?.("[data-local-captcha-confirm]")) {
        if (!selected.size) {
          scrim.querySelector("[data-local-captcha-status]").textContent = "请至少选择一张图片。";
          return;
        }
        finish(() => resolve([...selected].sort((a, b) => a - b)));
      }
    });
  });
}
