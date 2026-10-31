import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { concreteRoute } from "../src/routes.mjs";
import { fixtureBundle } from "../../book-renderer/fixtures/frozen-book-fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const output = resolve(process.argv[2] ?? "/tmp/unseen-book-lab-viewports");
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 4342;
const debugPort = 9342;
const origin = `http://127.0.0.1:${port}`;
const profile = await mkdtemp(resolve(tmpdir(), "unseen-book-capture-chrome-"));
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const server = spawn(process.execPath, ["packages/book-lab-web/scripts/dev-server.mjs"], {
  cwd: repoRoot,
  env: { ...process.env, UNSEEN_BOOK_LAB_PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"]
});
const browser = spawn(chrome, [
  "--headless=new", "--hide-scrollbars", "--disable-background-networking", "--disable-component-update", "--disable-default-apps", "--disable-sync", "--no-first-run",
  `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "about:blank"
], { stdio: ["ignore", "pipe", "pipe"] });

async function waitFor(url) {
  for (let count = 0; count < 100; count += 1) {
    try { const response = await fetch(url); if (response.ok) return response; } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  }
  throw new Error(`wait_timeout:${url}`);
}

function cdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  let nextId = 1;
  const pending = new Map();
  const eventWaiters = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const callback = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) callback.reject(new Error(message.error.message)); else callback.resolve(message.result);
      return;
    }
    const waiters = eventWaiters.get(message.method) ?? [];
    eventWaiters.delete(message.method);
    for (const resolveEvent of waiters) resolveEvent(message.params);
  });
  return {
    ready: new Promise((resolveReady, rejectReady) => {
      socket.addEventListener("open", resolveReady, { once: true });
      socket.addEventListener("error", rejectReady, { once: true });
    }),
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolveCommand, rejectCommand) => {
        pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    once(method) {
      return new Promise((resolveEvent) => eventWaiters.set(method, [...(eventWaiters.get(method) ?? []), resolveEvent]));
    },
    close() { socket.close(); }
  };
}

try {
  await waitFor(`${origin}/__fixture`);
  await waitFor(`http://127.0.0.1:${debugPort}/json/version`);
  const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const page = pages.find((target) => target.type === "page");
  if (!page) throw new Error("page_target_not_found");
  const client = cdp(page.webSocketDebuggerUrl);
  await client.ready;
  await client.send("Page.enable");
  const cases = [
    ...["BL01", "BL02", "BL03", "BL04", "BL05", "BL06"].flatMap((entry) => [320, 390].map((width) => ({ entry, width, height: 1000 }))),
    ...[1247, 1248, 1440].map((width) => ({ entry: "BL05", width, height: 1100 })),
    ...["BL01", "BL03", "BL06"].map((entry) => ({ entry, width: 1440, height: 1100 }))
  ];
  for (const item of cases) {
    const file = resolve(output, `${item.entry}-${item.width}.png`);
    await client.send("Emulation.setDeviceMetricsOverride", { width: item.width, height: item.height, deviceScaleFactor: 1, mobile: item.width < 700 });
    const loaded = client.once("Page.loadEventFired");
    await client.send("Page.navigate", { url: `${origin}${concreteRoute(item.entry, fixtureBundle)}` });
    await loaded;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const ready = await client.send("Runtime.evaluate", { expression: `document.body.dataset.entry === ${JSON.stringify(item.entry)} && (document.querySelector('main')?.innerText.length ?? 0) >= 100`, returnByValue: true });
      if (ready.result.value) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    const screenshot = await client.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
    await writeFile(file, Buffer.from(screenshot.data, "base64"));
  }
  client.close();
  console.log(JSON.stringify({ status: "BOOK_UI_VIEWPORTS_OK", output, screenshots: cases.length, exactCssViewports: true, widths: [320, 390, 1247, 1248, 1440], routes: ["BL01", "BL02", "BL03", "BL04", "BL05", "BL06"] }, null, 2));
} finally {
  server.kill("SIGTERM");
  browser.kill("SIGTERM");
  await Promise.all([
    Promise.race([once(server, "exit"), new Promise((resolveWait) => setTimeout(resolveWait, 1_000))]),
    Promise.race([once(browser, "exit"), new Promise((resolveWait) => setTimeout(resolveWait, 1_000))])
  ]);
}
