import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rasterMetadata } from "../../src/viewer.js";

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures");

function fixture(name) {
  const bytes = fs.readFileSync(path.join(fixtureRoot, name));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function expectFailure(buffer, code) {
  assert.throws(() => rasterMetadata(buffer), (error) => {
    assert.equal(error.code, code);
    assert.equal(error.retryable, false);
    return true;
  });
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(new Uint8Array(buffer)).digest("hex");
}

test("real static PNG and WebP bytes pass the pre-decoder container policy", () => {
  assert.deepEqual(rasterMetadata(fixture("panorama.png")), {
    format: "png",
    mime: "image/png",
    width: 1024,
    height: 512,
  });
  assert.deepEqual(rasterMetadata(fixture("static-panorama.webp")), {
    format: "webp",
    mime: "image/webp",
    width: 1024,
    height: 512,
  });
});

test("real two-frame APNG and animated WebP bytes fail closed", () => {
  const apng = fixture("animated.apng");
  const webp = fixture("animated.webp");
  assert.equal(sha256(apng), "a8822535065b9dadbd395cfdac588aeeb9f70fca9dc9310a1c9cfb1ea39dcae3");
  assert.equal(sha256(webp), "a969cc63f3904971f882728e4266ab30180638e1f284e034d9fe409b8477c6fd");
  const apngBytes = Buffer.from(apng);
  const animationControlOffset = apngBytes.indexOf("acTL", 8, "ascii");
  assert.ok(animationControlOffset >= 12);
  assert.equal(apngBytes.readUInt32BE(animationControlOffset + 4), 2);
  const webpBytes = Buffer.from(webp);
  assert.equal(webpBytes[20] & 0x02, 0x02);
  assert.equal(webpBytes.toString("ascii").match(/ANMF/g)?.length, 2);
  expectFailure(apng, "asset_animation_unsupported");
  expectFailure(webp, "asset_animation_unsupported");
});

test("WebP rejects animation chunks even if the VP8X animation flag is cleared", () => {
  const withAnimChunk = new Uint8Array(fixture("animated.webp"));
  withAnimChunk[20] &= ~0x02;
  expectFailure(withAnimChunk.buffer, "asset_animation_unsupported");

  const withAnmfOnly = new Uint8Array(withAnimChunk);
  const animOffset = Buffer.from(withAnmfOnly).indexOf("ANIM", 12, "ascii");
  assert.ok(animOffset >= 12);
  withAnmfOnly.set(Buffer.from("JUNK"), animOffset);
  expectFailure(withAnmfOnly.buffer, "asset_animation_unsupported");
});

test("WebP RIFF and chunk boundaries fail closed before decode", () => {
  const wrongRiffSize = new Uint8Array(fixture("static-panorama.webp"));
  const riffView = new DataView(wrongRiffSize.buffer);
  riffView.setUint32(4, wrongRiffSize.byteLength - 9, true);
  expectFailure(wrongRiffSize.buffer, "asset_metadata_invalid");

  const overflowingChunk = new Uint8Array(fixture("static-panorama.webp"));
  new DataView(overflowingChunk.buffer).setUint32(16, 0xffffffff, true);
  expectFailure(overflowingChunk.buffer, "asset_metadata_invalid");
});
