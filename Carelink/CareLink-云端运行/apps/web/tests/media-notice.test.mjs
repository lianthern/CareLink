import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { strings } from "../src/generated/contracts.js";
import { buildActionBody } from "../src/api/action-request-registry.js";
import { mediaNotice, mediaNoticePage, requireCurrentMediaNotice, statePanel } from "../src/ui/templates.js";

const current = {
  spaceId: "space-gongguang",
  effectiveCanUpload: true,
  limits: { batchItems: 50, photoBytes: 20 * 1024 * 1024 },
  formats: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"],
  mediaNotice: { id: "media_photo_upload_v2", version: 2, hash: "fe33ba9d5e927dffa281706d6e826d4dd06b26d3ccfca19b3eaba97f340287b0", policy: structuredClone(mediaNotice.policy) },
  currentConsent: null,
  canCreateBatch: false
};
const state = { account: null, capabilities: {}, spaces: [], currentSpaceId: "stale-space", debug: false };

const canonicalize = (value) => Array.isArray(value) ? value.map(canonicalize) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])) : value;

test("current media notice v2 is byte-bound to the Track 6A candidate", async () => {
  assert.equal(mediaNotice.candidateVersion, "photo_upload.zh-CN.2");
  assert.equal(createHash("sha256").update(JSON.stringify(canonicalize(mediaNotice.copy))).digest("hex"), current.mediaNotice.hash);
  assert.equal(createHash("sha256").update(JSON.stringify(canonicalize(current.mediaNotice.policy))).digest("hex"), mediaNotice.policyHash);
  const projection = await requireCurrentMediaNotice(current, "space-gongguang");
  assert.deepEqual(projection, { noticeVersion: 2, noticeHash: current.mediaNotice.hash, mediaPolicyVersion: "2", choices: { display: true, placement: true }, consentEventId: "" });
  assert.deepEqual(buildActionBody("UPLOAD.ACCEPT_NOTICE", projection), { purpose: "photo_upload", noticeVersion: 2, noticeHash: current.mediaNotice.hash, mediaPolicyVersion: "2", choices: { display: true, placement: true } });
  const priorDocument = globalThis.document;
  globalThis.document = { title: "" };
  try {
    const html = mediaNoticePage(state, "space-gongguang");
    for (const copy of [mediaNotice.copy.title, mediaNotice.copy.summary, ...mediaNotice.copy.bullets, mediaNotice.copy.acknowledgement]) assert.ok(html.includes(copy));
    assert.match(html, /href="\/s\/space-gongguang\/upload"/);
    assert.doesNotMatch(html, /第 1 版|approved|releaseBlocker|legal_approval/);
  } finally {
    globalThis.document = priorDocument;
  }
});

test("wrong nested identity/currentConsent and top-level mock shape fail closed", async () => {
  const cases = [
    { ...current, mediaNotice: { ...current.mediaNotice, version: 1 } },
    { ...current, mediaNotice: { ...current.mediaNotice, version: "2" } },
    { ...current, mediaNotice: { ...current.mediaNotice, hash: "80c532299ff366d3f79d8a418249080afd157aa5c1418a40be9ebdee760d0ef1" } },
    { ...current, mediaNotice: { ...current.mediaNotice, hash: "0".repeat(64) } },
    { ...current, mediaNotice: { ...current.mediaNotice, policy: { ...current.mediaNotice.policy, metadataPolicy: "keep-all" } } },
    { ...current, mediaNotice: { ...current.mediaNotice, policy: '2"><script>bad()</script>' } },
    { ...current, currentConsent: { consentEventId: "", acceptedAt: "not-a-time" }, canCreateBatch: true },
    { ...current, currentConsent: { consentEventId: "consent-1", acceptedAt: "2026-08-13" }, canCreateBatch: true },
    { ...current, currentConsent: null, canCreateBatch: true },
    { ...current, spaceId: "other-space" },
    { spaceId: current.spaceId, noticeVersion: 2, noticeHash: current.mediaNotice.hash, mediaPolicyVersion: "2", consentEventId: "consent-fake" }
  ];
  for (const value of cases) await assert.rejects(() => requireCurrentMediaNotice(value, "space-gongguang"), /media_notice_unavailable/);
  await assert.rejects(() => requireCurrentMediaNotice(current, "space-gongguang", { ...mediaNotice.copy, title: `${mediaNotice.copy.title}。` }), /media_notice_unavailable/);
});

test("exact currentConsent projects only its server consentEventId into the upload chain", async () => {
  const accepted = { ...current, currentConsent: { consentEventId: "consent-real-1", acceptedAt: "2026-08-13T10:00:00+10:00" }, canCreateBatch: true };
  assert.equal((await requireCurrentMediaNotice(accepted, "space-gongguang")).consentEventId, "consent-real-1");
});

test("media notice route and four visible states use the frozen action catalog", async () => {
  const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(appSource, /if \(path === "\/notices\/media"\) return "MEDIA_NOTICE\.OPEN";/);
  assert.doesNotMatch(appSource, /LEGAL\.OPEN_MEDIA_NOTICE/);
  const priorDocument = globalThis.document;
  globalThis.document = { title: "" };
  try {
    for (const phase of ["loading", "stable_error", "session_or_permission_loss", "empty"]) {
      const expected = strings.actions["MEDIA_NOTICE.OPEN"][phase] || strings.actions["MEDIA_NOTICE.OPEN"].initial;
      assert.ok(expected);
      assert.ok(statePanel("MEDIA_NOTICE.OPEN", phase).includes(expected));
    }
  } finally {
    globalThis.document = priorDocument;
  }
});
