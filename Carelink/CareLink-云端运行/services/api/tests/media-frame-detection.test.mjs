import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { inspectMedia } from "../src/media.mjs";
import { png } from "./fixture-factory.mjs";

// P0 regression coverage: iPhone photos (and most real camera JPEGs) carry an
// embedded EXIF/MPF thumbnail -- itself a complete, independently-decodable
// JPEG -- alongside the primary image. When decode() fed raw bytes to ffmpeg
// over stdin, ffmpeg selected the jpeg_pipe demuxer, which does not respect
// JPEG marker-segment framing and instead splits the byte stream on every
// SOI marker it finds, including the embedded thumbnail's. That counted as
// "2 frames" and every such photo was rejected as media_decode_rejected /
// animated_or_sequence -- silently failing 100% of iPhone uploads in
// production. The fix (see media.mjs) makes frame/sequence detection purely
// structural (parsed at the container level) instead of trusting ffmpeg's
// own frame count. These tests exercise the real FfmpegDecoderRunner (no
// mocked decoder) so a regression in the pipe-decoding path would be caught
// here again.

function jpeg(width, height, color) {
  const result = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
    `color=c=${color}:s=${width}x${height}:d=0.04`, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"],
  { maxBuffer: 60 * 1024 * 1024, timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
}

// A primary JPEG with a second, independently-valid JPEG (an embedded
// thumbnail, as real cameras/phones attach) appended after the primary's own
// EOI marker -- exactly the shape that fooled ffmpeg's pipe-mode jpeg_pipe
// demuxer into reporting 2 frames.
function jpegWithEmbeddedThumbnail() {
  const primary = jpeg(64, 32, "#335577");
  const thumbnail = jpeg(8, 8, "#ff00aa");
  return Buffer.concat([primary, thumbnail]);
}

function apngBytes() {
  const base = png();
  const before = base.subarray(0, 33); // 8-byte signature + 25-byte IHDR chunk
  const after = base.subarray(33);
  const acTLData = Buffer.alloc(8);
  acTLData.writeUInt32BE(2, 0); // num_frames = 2
  acTLData.writeUInt32BE(0, 4); // num_plays = infinite
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(8, 0);
  const acTLChunk = Buffer.concat([lenBuf, Buffer.from("acTL", "ascii"), acTLData, Buffer.alloc(4)]);
  return Buffer.concat([before, acTLChunk, after]);
}

function animatedWebpBytes() {
  const flags = Buffer.from([0x02, 0, 0, 0]); // ANIM bit set
  const canvas = Buffer.from([63, 0, 0, 31, 0, 0]); // width-1=63, height-1=31, 24-bit LE
  const vp8xPayload = Buffer.concat([flags, canvas]);
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32LE(vp8xPayload.length, 0);
  const vp8xChunk = Buffer.concat([Buffer.from("VP8X", "ascii"), sizeBuf, vp8xPayload]);
  const riffPayload = Buffer.concat([Buffer.from("WEBP", "ascii"), vp8xChunk]);
  const riffSize = Buffer.alloc(4);
  riffSize.writeUInt32LE(riffPayload.length, 0);
  return Buffer.concat([Buffer.from("RIFF", "ascii"), riffSize, riffPayload]);
}

function heifBytes(majorBrand, compatibleBrands = []) {
  const payload = Buffer.concat([Buffer.from(majorBrand, "ascii"), Buffer.alloc(4),
    ...compatibleBrands.map((brand) => Buffer.from(brand, "ascii"))]);
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32BE(8 + payload.length, 0);
  return Buffer.concat([sizeBuf, Buffer.from("ftyp", "ascii"), payload]);
}

function stubDecoder(width, height) {
  return {
    probe: async () => ({ status: 0, signal: null, error: null,
      stdout: Buffer.from(JSON.stringify({ streams: [{ width, height }] })), stderr: Buffer.alloc(0) }),
    decode: async () => ({ status: 0, signal: null, error: null,
      stdout: Buffer.from("0, 0, 0, 1, 1, 1, 0, 0123456789abcdef0123456789abcdef\n"), stderr: Buffer.alloc(0) }),
    deriveViewerSafe: async () => ({ status: 0, signal: null, error: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })
  };
}

test("a single JPEG carrying an embedded thumbnail (real iPhone photo shape) is accepted via the real ffmpeg pipe decoder", async () => {
  const bytes = jpegWithEmbeddedThumbnail();
  const result = await inspectMedia(bytes, { declaredMime: "image/jpeg" });
  assert.equal(result.frames, 1);
  assert.equal(result.mime, "image/jpeg");
  // Dimensions must come from the primary image, not the trailing thumbnail.
  assert.equal(result.width, 64);
  assert.equal(result.height, 32);
});

test("a plain single-frame JPEG (no embedded thumbnail) is still accepted", async () => {
  const bytes = jpeg(48, 24, "#112233");
  const result = await inspectMedia(bytes, { declaredMime: "image/jpeg" });
  assert.equal(result.frames, 1);
  assert.equal(result.width, 48);
  assert.equal(result.height, 24);
});

test("an animated PNG (acTL frame count > 1) is still rejected as animated_or_sequence", async () => {
  await assert.rejects(inspectMedia(apngBytes(), { declaredMime: "image/png" }),
    (error) => error.code === "media_decode_rejected" && error.status === 422 &&
      error.details?.reason === "animated_or_sequence");
});

test("an animated WebP (VP8X ANIM flag set) is still rejected as animated_or_sequence", async () => {
  await assert.rejects(inspectMedia(animatedWebpBytes(), { declaredMime: "image/webp" }),
    (error) => error.code === "media_decode_rejected" && error.status === 422 &&
      error.details?.reason === "animated_or_sequence");
});

test("a HEIF image-sequence brand (hevc/hevx/msf1) is rejected as animated_or_sequence without decoding", async () => {
  const sequenceBrands = [["hevc", ["mif1", "heic"]], ["hevx", ["mif1", "heic"]], ["heic", ["msf1", "mif1"]]];
  for (const [majorBrand, compatibleBrands] of sequenceBrands) {
    await assert.rejects(inspectMedia(heifBytes(majorBrand, compatibleBrands), { declaredMime: "image/heic" }),
      (error) => error.code === "media_decode_rejected" && error.status === 422 &&
        error.details?.reason === "animated_or_sequence",
      `expected rejection for major brand ${majorBrand}`);
  }
});

test("a still-image HEIF brand (heic/heix/mif1, no sequence brand) passes the frame gate", async () => {
  const result = await inspectMedia(heifBytes("heic", ["mif1", "heic"]),
    { declaredMime: "image/heic", decoderRunner: stubDecoder(32, 16) });
  assert.equal(result.frames, 1);
  assert.equal(result.mime, "image/heic");
});

test("GIF bytes are rejected outright -- GIF is not one of the recognized still-image containers", async () => {
  const bytes = Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.alloc(64)]);
  await assert.rejects(inspectMedia(bytes, { declaredMime: "image/gif" }),
    (error) => error.code === "media_decode_rejected" && error.status === 422 && error.details === undefined);
});
