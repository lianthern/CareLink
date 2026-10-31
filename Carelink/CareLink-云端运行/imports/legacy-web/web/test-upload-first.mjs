import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_OSS_BASE,
  MAX_BATCH_ITEMS,
  MAX_PANORAMA_PIXELS,
  UNSEEN_API_URL,
  buildOssObjectKey,
  exactUploadPolicyStatus,
  looksLikeHeic,
  parseSpaceTarget,
  uploadPolicyStatus,
  validatePanoramaDescriptor,
  validatePhotoDescriptor,
} from "./unseen-core.mjs";

function bmff(major, compatibles = []) {
  const bytes = new Uint8Array(16 + compatibles.length * 4);
  ["f", "t", "y", "p"].forEach((char, index) => { bytes[4 + index] = char.charCodeAt(0); });
  [...major].forEach((char, index) => { bytes[8 + index] = char.charCodeAt(0); });
  compatibles.forEach((brand, brandIndex) => [...brand].forEach((char, index) => {
    bytes[16 + brandIndex * 4 + index] = char.charCodeAt(0);
  }));
  return bytes;
}

const cases = [];
function test(name, callback) { cases.push([name, callback]); }

test("HEIC extension, MIME, major brand and compatible brand are blocked", () => {
  assert.equal(looksLikeHeic({ name: "a.HEIC" }), true);
  assert.equal(looksLikeHeic({ name: "a.bin", type: "image/heif" }), true);
  assert.equal(looksLikeHeic({ name: "a.bin", bytes: bmff("heic") }), true);
  assert.equal(looksLikeHeic({ name: "a.bin", bytes: bmff("mif1", ["heix"]) }), true);
  assert.equal(looksLikeHeic({ name: "a.jpg", type: "image/jpeg", bytes: bmff("isom") }), false);
});

test("ordinary photos enforce format and 20 MB limit", () => {
  assert.equal(validatePhotoDescriptor({ name: "a.jpg", type: "image/jpeg", size: 1024 }).ok, true);
  assert.equal(validatePhotoDescriptor({ name: "a.heic", size: 1024 }).code, "heic");
  assert.equal(validatePhotoDescriptor({ name: "a.jpg", type: "image/jpeg", size: 21 * 1024 * 1024 }).code, "too_large");
  assert.equal(validatePhotoDescriptor({ name: "a.gif", type: "image/gif", size: 1024 }).code, "unsupported");
});

test("panorama accepts 20–50 MB originals and enforces 2:1 geometry", () => {
  assert.equal(validatePanoramaDescriptor({ name: "pano.jpg", type: "image/jpeg", size: 35 * 1024 * 1024, width: 4000, height: 2000 }).ok, true);
  assert.equal(validatePanoramaDescriptor({ name: "pano.jpg", type: "image/jpeg", size: 1024, width: 1600, height: 800 }).ok, true);
  assert.equal(validatePanoramaDescriptor({ name: "pano.jpg", type: "image/jpeg", size: 1024, width: 1700, height: 1000 }).code, "ratio");
  assert.equal(validatePanoramaDescriptor({ name: "pano.jpg", type: "image/jpeg", size: 1024, width: 1500, height: 750 }).code, "too_small");
  assert.equal(validatePanoramaDescriptor({ name: "pano.jpg", type: "image/jpeg", size: 51 * 1024 * 1024, width: 4000, height: 2000 }).code, "too_large");
  assert.equal(validatePanoramaDescriptor({ name: "pano.jpg", type: "image/jpeg", size: 10 * 1024 * 1024, width: 10000, height: 5000 }).code, "too_many_pixels");
  assert.equal(MAX_PANORAMA_PIXELS, 8192 * 4096);
});

test("space target parser accepts IDs and invite links but rejects insecure remotes", () => {
  assert.deepEqual(parseSpaceTarget("s4"), { ok: true, sid: "s4", base: DEFAULT_OSS_BASE });
  const fromLink = parseSpaceTarget(`https://example.com/index.html?s=s4&b=${encodeURIComponent(DEFAULT_OSS_BASE)}`);
  assert.equal(fromLink.ok, true);
  assert.equal(fromLink.sid, "s4");
  assert.equal(parseSpaceTarget("https://example.com/?s=s4&b=http://evil.example").ok, false);
  assert.equal(parseSpaceTarget("https://example.com/?s=s4&b=https://evil.example").ok, false);
});

test("expired upload policy fails immediately while a future complete policy passes", () => {
  const base = { id: "s4", collection: { status: "open" }, upload: { enabled: true, host: DEFAULT_OSS_BASE, OSSAccessKeyId: "key", policy: "policy", signature: "sig", keyPrefix: "spaces/s4/inbox/" } };
  assert.equal(uploadPolicyStatus({ ...base, upload: { ...base.upload, expiresAt: 100 } }, 101000).code, "expired");
  assert.equal(uploadPolicyStatus({ ...base, capacity: { full: true }, upload: { ...base.upload, expiresAt: 200 } }, 101000).code, "capacity_full");
  assert.equal(uploadPolicyStatus({ ...base, capacity: { remaining: 0 }, upload: { ...base.upload, expiresAt: 200 } }, 101000).code, "capacity_full");
  assert.equal(uploadPolicyStatus({ ...base, capacity: { remaining: "0" }, upload: { ...base.upload, expiresAt: 200 } }, 101000).code, "capacity_full");
  assert.equal(uploadPolicyStatus({ ...base, capacity: { remaining: null }, upload: { ...base.upload, expiresAt: 200 } }, 101000).ok, true);
  const open = uploadPolicyStatus({ ...base, upload: { ...base.upload, expiresAt: 200 } }, 101000);
  assert.equal(open.ok, true);
  assert.equal(uploadPolicyStatus({ ...base, upload: { ...base.upload, host: "https://evil.example", expiresAt: 200 } }, 101000).code, "untrusted_host");
  assert.equal(uploadPolicyStatus({ ...base, upload: { ...base.upload, keyPrefix: "spaces/other/inbox/", expiresAt: 200 } }, 101000).code, "untrusted_prefix");
  const item = { clientUploadId: "stable123", selectedAt: 123456 };
  assert.equal(buildOssObjectKey(open.policy, item, "小林"), buildOssObjectKey(open.policy, item, "小林"));
});

test("managed ticket mode and exact OSS policies fail closed", () => {
  const managed = uploadPolicyStatus({
    id: "u1234567890abcdef12345678",
    collection: { status: "open" },
    capacity: { remaining: 90, full: false },
    upload: { enabled: true, mode: "ticket-v1", endpoint: UNSEEN_API_URL, maxSize: 20 * 1024 * 1024 },
  });
  assert.equal(managed.ok, true);
  assert.equal(managed.mode, "ticket-v1");
  assert.equal(uploadPolicyStatus({ id: "u123", upload: { enabled: true, mode: "ticket-v1", endpoint: "https://evil.example" } }).code, "untrusted_api");

  const exact = {
    host: DEFAULT_OSS_BASE,
    expiresAt: 200,
    maxSize: 20 * 1024 * 1024,
    fields: {
      key: "unseen-backend/v1/uploads/u123/p_abc.bin",
      policy: "policy",
      OSSAccessKeyId: "key",
      Signature: "signature",
      "x-oss-object-acl": "private",
      success_action_status: "200",
    },
  };
  assert.equal(exactUploadPolicyStatus(exact, { expectedPrefix: "unseen-backend/v1/uploads/u123/", nowMs: 100000 }).ok, true);
  assert.equal(exactUploadPolicyStatus({ ...exact, host: "https://evil.example" }, { nowMs: 100000 }).code, "untrusted_host");
  assert.equal(exactUploadPolicyStatus(exact, { expectedKey: "unseen-backend/v1/staging/u123/cover.bin", nowMs: 100000 }).code, "unexpected_key");
  assert.equal(
    exactUploadPolicyStatus({ ...exact, fields: { ...exact.fields, "x-oss-object-acl": "public-read" } }, { nowMs: 100000 }).code,
    "untrusted_fields"
  );
  assert.equal(
    exactUploadPolicyStatus({ ...exact, fields: { ...exact.fields, success_action_status: "201" } }, { nowMs: 100000 }).code,
    "untrusted_fields"
  );
});

test("formal entry and public manifest contain only the upload-first route bundle", async () => {
  assert.equal(MAX_BATCH_ITEMS, 9);
  const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
  const js = await readFile(new URL("./unseen.js", import.meta.url), "utf8");
  const portal = await readFile(new URL("../portal.html", import.meta.url), "utf8");
  const manifest = await readFile(new URL("../deploy/upload-first-public-files.txt", import.meta.url), "utf8");
  const publicFiles = manifest.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  assert.match(html, /unseen\.js/);
  for (const forbidden of ["pano-capture", "pano-sweep", "studio-login", "DAP", "伪登录"]) {
    assert.equal(html.includes(forbidden), false, `index.html exposed ${forbidden}`);
    assert.equal(js.includes(forbidden), false, `unseen.js exposed ${forbidden}`);
    assert.equal(publicFiles.some((file) => file.includes(forbidden)), false, `public manifest exposed ${forbidden}`);
  }
  assert.deepEqual(publicFiles, ["portal.html", "web/index.html", "web/unseen.css", "web/unseen.js", "web/unseen-core.mjs"]);
  assert.match(portal, /web\/index\.html/);
  assert.match(html, /unseen\.css\?v=20260802b/);
  assert.match(html, /unseen\.js\?v=20260802b/);
  assert.match(portal, /searchParams\.set\("v", "20260802b"\)/);
  assert.match(js, /上传通道已经过期|uploadPolicyStatus/);
});

function luminance(hex) {
  const rgb = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function contrast(foreground, background) {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("secondary text remains readable on every formal surface", async () => {
  const css = await readFile(new URL("./unseen.css", import.meta.url), "utf8");
  const muted = css.match(/--muted:\s*(#[0-9a-f]{6})/i)?.[1];
  assert.ok(muted, "missing --muted token");
  for (const background of ["#fff9f7", "#fffcfb", "#f4eef0"]) {
    assert.ok(contrast(muted, background) >= 4.5, `${muted} is below 4.5:1 on ${background}`);
  }
  const undersized = [...css.matchAll(/font-size:\s*(0\.[0-9]+)rem/g)]
    .map((match) => Number(match[1]))
    .filter((size) => size < 0.75);
  assert.deepEqual(undersized, [], "formal UI contains rem text smaller than 12px");
});

let passed = 0;
for (const [name, callback] of cases) {
  await callback();
  passed += 1;
  console.log(`✓ ${name}`);
}
console.log(`\n${passed}/${cases.length} upload-first checks passed`);
