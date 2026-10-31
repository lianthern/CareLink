// Self-contained landing page for the static demo-book mount (see tools/demo-book/README.md for the
// full mounting steps). Separate from book.html on purpose: book.html is the exact canonical,
// hash-verified artifact printed to PDF (packages/book-renderer's CSP there is
// deliberately `default-src 'none'`), so it is not the right place to add navigation chrome. This
// landing page just introduces the demo and links out to the two frozen files sitting next to it.
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function renderLandingPage({ title, pageCount, generatedAt }) {
  const safeTitle = escapeHtml(title);
  const safeDate = escapeHtml(generatedAt.slice(0, 10));
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; font-src 'none'; base-uri 'none'; form-action 'none'"/>
<meta name="robots" content="noindex, nofollow"/>
<title>${safeTitle} · 纪念册演示</title>
<style>
:root{color-scheme:light dark;--bg:#f7f1ef;--fg:#321722;--muted:#725f66;--accent:#a43e4a;--card:#fff9f7;--ring:#e9ddda}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--bg);color:var(--fg);font-family:"PingFang SC","Songti SC",system-ui,sans-serif}
body{display:flex;justify-content:center;padding:32px 16px 64px}
main{width:100%;max-width:640px}
.banner{background:#fff0bf;border:1px solid var(--accent);border-radius:12px;padding:14px 18px;font-size:14px;line-height:1.6;margin-bottom:28px;color:#461528}
.banner b{color:var(--accent)}
h1{font-size:28px;margin:0 0 6px}
.meta{color:var(--muted);font-size:14px;margin-bottom:28px}
.card{background:var(--card);border:1px solid var(--ring);border-radius:16px;padding:22px;margin-bottom:16px;box-shadow:0 8px 28px rgba(70,21,40,.06)}
.card p{margin:0 0 14px;line-height:1.7;color:var(--muted);font-size:14px}
.actions{display:flex;gap:12px;flex-wrap:wrap}
a.button{display:inline-block;text-decoration:none;padding:10px 18px;border-radius:999px;font-size:14px;font-weight:600}
a.button.primary{background:var(--accent);color:#fff}
a.button.secondary{background:transparent;color:var(--accent);border:1px solid var(--accent)}
footer{margin-top:24px;color:var(--muted);font-size:12px;line-height:1.7}
@media(prefers-color-scheme:dark){:root{--bg:#1b1214;--fg:#f4e9e6;--muted:#c9b6bb;--accent:#ff9fb0;--card:#241a1d;--ring:#3a2b2f}.banner{background:#3a2b12;color:#ffe9b0;border-color:var(--accent)}}
</style></head>
<body><main>
  <div class="banner"><b>演示内容 · 内容为虚构示例</b> —— 本页展示的照片来自 AI 生成的模板素材，问答文字为产品演示手写虚构内容，不代表任何真实用户、真实活动或真实数据。</div>
  <h1>${safeTitle}</h1>
  <p class="meta">纪念册演示 · 共 ${pageCount} 页 · 生成于 ${safeDate}</p>
  <div class="card">
    <p>这是「夏日聚会」AI 模板空间的纪念册演示：六张模板照片，配上围绕照片可见细节手写的固定问答，走一遍从照片到成书的排版效果。渲染管线与真实功能一致，但本书本身没有经过真实的访谈、授权或冻结流程。</p>
    <div class="actions">
      <a class="button primary" href="./book.html">在线翻阅（HTML）</a>
      <a class="button secondary" href="./book.pdf">下载 PDF</a>
    </div>
  </div>
  <footer>演示内容 · 内容为虚构示例 · 与任何真实活动或个人无关。</footer>
</main></body></html>`;
}
