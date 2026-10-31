import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PAGE_ACTIONS, ROUTES, concreteRoute, resolveEntry } from "../src/routes.mjs";
import { resolvePagePresentation } from "../src/page-model.mjs";
import { fixtureBundle, fixtureHash } from "../../book-renderer/fixtures/frozen-book-fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const catalog = JSON.parse(await readFile(resolve(repoRoot, "packages/contracts/generated/book-lab/string-catalog.zh-CN.json"), "utf8"));
const registry = JSON.parse(await readFile(resolve(repoRoot, "packages/contracts/generated/book-lab/action-registry.json"), "utf8"));
const html = await readFile(resolve(here, "../index.html"), "utf8");
const app = await readFile(resolve(here, "../src/app.mjs"), "utf8");
const css = await readFile(resolve(here, "../src/styles.css"), "utf8");
const packageJson = JSON.parse(await readFile(resolve(here, "../package.json"), "utf8"));

test("BL01-BL06 routes and 20 applicable actions are the frozen exact sets", () => {
  assert.deepEqual(ROUTES, registry.routeEntries);
  const mapped = Object.values(PAGE_ACTIONS).flat();
  assert.equal(mapped.length, 20);
  assert.equal(new Set(mapped).size, 20);
  assert.deepEqual([...mapped].sort(), registry.actions.map((action) => action.id).sort());
  for (const entry of Object.keys(ROUTES)) {
    const concrete = concreteRoute(entry, fixtureBundle);
    assert.equal(resolveEntry(concrete), entry);
    assert.ok(PAGE_ACTIONS[entry].every((action) => registry.actions.find((item) => item.id === action)?.entry === entry));
  }
});

test("all 20 actions expose the nine frozen non-empty phases without a second string source", () => {
  assert.equal(Object.keys(catalog.actions).length, 20);
  assert.equal(catalog.phaseOrder.length, 9);
  assert.equal(Object.entries(catalog.actions).flatMap(([, value]) => catalog.phaseOrder.map((phase) => value[phase])).length, 180);
  for (const actionId of Object.values(PAGE_ACTIONS).flat()) {
    assert.deepEqual(Object.keys(catalog.actions[actionId]), catalog.phaseOrder);
    assert.ok(catalog.phaseOrder.every((phase) => catalog.actions[actionId][phase].trim().length > 0));
  }
  assert.match(app, /fetch\("\/__catalog"\)/u);
  assert.doesNotMatch(app, /const\s+catalog\s*=\s*\{/u);
});

test("fixture boundaries are explicit and match the Book Lab acceptance shape", () => {
  assert.equal(fixtureBundle.fixtureNotice, "确定性本地样本 / 非真实 AI 问题质量");
  assert.match(fixtureHash, /^[a-f0-9]{64}$/u);
  assert.equal(fixtureBundle.photos.length, 14);
  assert.equal(fixtureBundle.contributors.length, 4);
  assert.equal(fixtureBundle.manifest.pages.length, 16);
  assert.ok(fixtureBundle.photos.every((photo) => photo.mainQuestionCount === 1 && photo.status === "confirmed_current"));
  assert.equal(fixtureBundle.book.previousVersion.status, "withdrawal_affected");
  assert.match(fixtureBundle.conflict.rule, /不合并成唯一真相/u);
  assert.doesNotMatch(JSON.stringify(fixtureBundle), /SceneNote|phone|email|receiptSecret/iu);
});

test("static shell includes accessibility basics, deterministic labels and no remote resources", () => {
  assert.match(html, /class="skip-link"/u);
  assert.match(html, /<main id="main" tabindex="-1"><\/main>/u);
  assert.match(html, /role="status" aria-live="polite"/u);
  assert.match(html, /确定性本地样本/u);
  assert.doesNotMatch(`${html}\n${css}\n${app}`, /https?:\/\//iu);
  assert.match(css, /:focus-visible/u);
  assert.match(css, /prefers-reduced-motion/u);
  assert.match(app, /aria-label=/u);
  assert.match(app, /<label/u);
});

test("responsive contract has one mobile layout and a fixed 1184px desktop canvas at 1248", () => {
  assert.match(css, /@media \(min-width: 720px\) and \(max-width: 1247px\)/u);
  assert.match(css, /@media \(min-width: 1248px\)/u);
  assert.match(css, /width: 1184px/u);
  assert.doesNotMatch(css, /@media[^\{]*(?:960|1024|1280|1440)/u);
  assert.match(css, /min-width: 320px/u);
});

test("packages remain private, dependency-free and do not request a root lockfile change", () => {
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.devDependencies, undefined);
});

test("replacing display photo cannot change source provenance, original text, grant or credit", () => {
  const page = structuredClone(fixtureBundle.manifest.pages.find((item) => item.kind === "memory"));
  const before = resolvePagePresentation(fixtureBundle, page);
  page.displayPhotoId = fixtureBundle.photos.find((photo) => photo.photoId !== page.sourcePhotoId).photoId;
  const after = resolvePagePresentation(fixtureBundle, page);
  assert.notEqual(after.displayPhoto.photoId, before.displayPhoto.photoId);
  assert.equal(after.sourcePhoto.photoId, before.sourcePhoto.photoId);
  assert.equal(after.text.originalUserText, before.text.originalUserText);
  assert.equal(after.text.grantId, before.text.grantId);
  assert.equal(after.text.authorCredit, before.text.authorCredit);
  assert.equal(after.text.sourceProvenance.placementRevisionId, before.text.sourceProvenance.placementRevisionId);
});
