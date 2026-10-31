import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PAGE_ACTIONS, concreteRoute } from "../src/routes.mjs";
import { fixtureBundle, fixtureHash } from "../../book-renderer/fixtures/frozen-book-fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

async function waitForServer(child, url) {
  const timeout = Date.now() + 10_000;
  while (Date.now() < timeout) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  }
  child.kill();
  throw new Error("server_start_timeout");
}

test("local-only server opens all six routes and same-manifest artifacts", { timeout: 90_000 }, async () => {
  const port = 4341;
  const origin = `http://127.0.0.1:${port}`;
  const privateRoot = await mkdtemp(join(tmpdir(), "unseen-book-server-"));
  const outputRoot = resolve(privateRoot, "artifacts");
  const expectedCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  const child = spawn(process.execPath, ["packages/book-lab-web/scripts/dev-server.mjs"], {
    cwd: repoRoot,
    env: { ...process.env, UNSEEN_BOOK_LAB_PORT: String(port), UNSEEN_BOOK_OUTPUT_DIR: outputRoot },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    await waitForServer(child, `${origin}/healthz`);
    const healthResponse = await fetch(`${origin}/healthz`);
    const health = await healthResponse.json();
    assert.equal(healthResponse.headers.get("cache-control"), "no-store");
    assert.deepEqual(health, {
      schema: "unseen-book-lab-health/1",
      status: "ok",
      ready: true,
      fixtureOnly: true,
      commit: expectedCommit,
      input: { fixtureHash, manifestHash: fixtureBundle.manifest.manifestHash }
    });
    for (const entry of Object.keys(PAGE_ACTIONS)) {
      const response = await fetch(`${origin}${concreteRoute(entry, fixtureBundle)}`);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /<main id="main"/u);
    }
    const fixture = await (await fetch(`${origin}/__fixture`)).json();
    const catalog = await (await fetch(`${origin}/__catalog`)).json();
    assert.equal(fixture.manifest.manifestHash, fixtureBundle.manifest.manifestHash);
    assert.equal(Object.keys(catalog.actions).length, 20);

    const receipt = await (await fetch(`${origin}/__artifacts/render-receipt.json`)).json();
    assert.equal(receipt.equality.manifestHash, fixtureBundle.manifest.manifestHash);
    assert.equal(receipt.html.pageCount, 16);
    assert.equal(receipt.pdf.pageCount, 16);
    const pdf = Buffer.from(await (await fetch(`${origin}/__artifacts/book.pdf`)).arrayBuffer());
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    const fixtureOutput = resolve(outputRoot, fixtureBundle.manifest.manifestHash);
    assert.equal((await stat(outputRoot)).mode & 0o777, 0o700);
    assert.equal((await stat(fixtureOutput)).mode & 0o777, 0o700);
    assert.equal((await stat(resolve(fixtureOutput, "book.html"))).mode & 0o777, 0o600);
    assert.equal((await stat(resolve(fixtureOutput, "book.pdf"))).mode & 0o777, 0o600);

    const editedPages = structuredClone(fixtureBundle.manifest.pages).filter((page) => page.pageId !== "page-memory-14");
    editedPages.find((page) => page.pageId === "page-memory-01").displayPhotoId = "photo-02";
    const editedResponse = await fetch(`${origin}/__artifacts/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "灯熄以后，我们还在", pages: editedPages })
    });
    assert.equal(editedResponse.status, 200);
    const edited = await editedResponse.json();
    assert.equal(edited.manifest.title, "灯熄以后，我们还在");
    assert.equal(edited.manifest.pages.length, 15);
    assert.notEqual(edited.manifest.manifestHash, fixtureBundle.manifest.manifestHash);
    assert.equal(edited.receipt.equality.title, edited.manifest.title);
    assert.equal(edited.receipt.equality.manifestHash, edited.manifest.manifestHash);
    assert.equal(edited.receipt.equality.pageCount, 15);
    assert.equal(edited.receipt.equality.orderedDisplayPhotoIds[1], "photo-02");

    const editedHtml = await (await fetch(`${origin}${edited.urls.html}`)).text();
    assert.match(editedHtml, /<title>灯熄以后，我们还在 · 确定性本地样本<\/title>/u);
    assert.match(editedHtml, /<h1>灯熄以后，我们还在<\/h1>/u);
    assert.doesNotMatch(editedHtml, /<h1>共光以后<\/h1>/u);
    assert.equal((editedHtml.match(/class="book-page/g) ?? []).length, 15);
    const editedReceipt = await (await fetch(`${origin}${edited.urls.receipt}`)).json();
    assert.deepEqual(editedReceipt, edited.receipt);
    const editedPdf = Buffer.from(await (await fetch(`${origin}${edited.urls.pdf}`)).arrayBuffer());
    assert.equal(editedPdf.subarray(0, 5).toString(), "%PDF-");
    assert.equal((await (await fetch(`${origin}/healthz`)).json()).ready, true);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), new Promise((resolveWait) => setTimeout(resolveWait, 1_000))]);
    await rm(privateRoot, { recursive: true, force: true });
  }
});
