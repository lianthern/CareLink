import { createIntegratedBookLabVisualShell } from "/packages/book-lab-web/src/integrated-shell.mjs";

const root = document.querySelector("main");
const status = document.querySelector("#book-lab-status");

try {
  const response = await fetch("/__book-lab/catalog.json", { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) throw new Error("book_lab_catalog_unavailable");
  const catalog = await response.json();
  const shell = createIntegratedBookLabVisualShell({ origin: location.origin, catalog });
  await shell.mount(root, location.pathname);
  status.textContent = "Book Lab 已连接真实 Core 接缝。";
} catch (error) {
  root.innerHTML = '<section class="task-card" role="alert"><h1>暂时无法打开</h1><p>book_lab_unavailable</p></section>';
  status.textContent = error?.message === "book_lab_catalog_unavailable" ? error.message : "book_lab_unavailable";
}
