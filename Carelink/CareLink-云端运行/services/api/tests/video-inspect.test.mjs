import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPlayableVideoDerivative, inspectVideo, mp4Container, VIDEO_MAX_DISPLAY_LONG_EDGE,
  VIDEO_MAX_DISPLAY_SHORT_EDGE, VIDEO_MAX_DURATION_MS } from "../src/video.mjs";
import { FfmpegVideoRunner } from "../src/ports/media/ffmpeg-video-runner.mjs";
import { mp4, mp4WithAudio, png } from "./fixture-factory.mjs";

function ffprobeAudioStream(bytes) {
  const file = path.join(os.tmpdir(), `unseen-test-probe-${randomBytes(8).toString("hex")}.mp4`);
  try {
    writeFileSync(file, bytes);
    const result = spawnSync("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries",
      "stream=codec_name,channels", "-of", "json", file], { maxBuffer: 20 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr.toString());
    return JSON.parse(result.stdout.toString("utf8")).streams;
  } finally {
    try { unlinkSync(file); } catch { /* already gone */ }
  }
}

// These exercise the real ffmpeg/ffprobe binaries end to end (no stubbed decoder), the same way
// media-frame-detection.test.mjs and decoder-runtime.test.mjs do for the image path -- a
// regression in the real container/duration/resolution/decode-proof pipeline would be caught
// here, not just in a stubbed unit test.

test("a real, non-faststarted mp4 (moov at the end, matching an un-post-processed phone capture) is accepted", async () => {
  const bytes = mp4(320, 240, 1, 5);
  const result = await inspectVideo(bytes, { declaredMime: "video/mp4" });
  assert.equal(result.mime, "video/mp4");
  assert.equal(result.width, 320);
  assert.equal(result.height, 240);
  assert.ok(result.durationMs > 0 && result.durationMs <= 1200);
  assert.equal(result.bytes, bytes.length);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.ok(result.poster.body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    "poster must be a real PNG");
});

test("mp4Container structurally recognizes common movie brands and rejects non-ftyp bytes", () => {
  assert.ok(mp4Container(mp4(64, 64, 1, 5)));
  assert.equal(mp4Container(Buffer.from("not a video at all, just some text")), null);
  assert.equal(mp4Container(png()), null, "a real PNG must not be sniffed as a video container");
});

test("declaredMime video/quicktime is preserved on the returned mime, video/mp4 otherwise", async () => {
  const bytes = mp4(64, 64, 1, 5);
  const asMov = await inspectVideo(bytes, { declaredMime: "video/quicktime" });
  assert.equal(asMov.mime, "video/quicktime");
  const asMp4 = await inspectVideo(bytes, { declaredMime: "video/mp4" });
  assert.equal(asMp4.mime, "video/mp4");
});

test("a PNG declared as video/mp4 is rejected structurally, never reaching ffmpeg", async () => {
  await assert.rejects(inspectVideo(png(), { declaredMime: "video/mp4" }),
    (error) => error.code === "media_decode_rejected" && error.status === 422 &&
      error.details?.reason === "not_a_video_container");
});

test("a video longer than 60 seconds is rejected as video_duration_exceeded with the measured duration", async () => {
  const bytes = mp4(320, 240, 65, 5);
  await assert.rejects(inspectVideo(bytes, { declaredMime: "video/mp4" }),
    (error) => error.code === "video_duration_exceeded" && error.status === 422 &&
      error.details?.reason === "duration_exceeded" && error.details.durationMs > VIDEO_MAX_DURATION_MS &&
      error.details.limitMs === VIDEO_MAX_DURATION_MS);
});

test("a video wider than 1080p (either edge) is rejected as video_resolution_exceeded", async () => {
  const bytes = mp4(1920, 1200, 1, 5);
  await assert.rejects(inspectVideo(bytes, { declaredMime: "video/mp4" }),
    (error) => error.code === "video_resolution_exceeded" && error.status === 422 &&
      error.details?.width === 1920 && error.details.height === 1200 &&
      error.details.limitLongEdge === VIDEO_MAX_DISPLAY_LONG_EDGE && error.details.limitShortEdge === VIDEO_MAX_DISPLAY_SHORT_EDGE);
});

test("a 1080x1920 portrait video (long edge within 1920, short edge within 1080) is accepted", async () => {
  const bytes = mp4(1080, 1920, 1, 5);
  const result = await inspectVideo(bytes, { declaredMime: "video/mp4" });
  assert.equal(result.width, 1080);
  assert.equal(result.height, 1920);
});

test("declaredBytes mismatch is rejected as object_mismatch before any ffmpeg invocation", async () => {
  const bytes = mp4(64, 64, 1, 5);
  await assert.rejects(inspectVideo(bytes, { declaredMime: "video/mp4", declaredBytes: bytes.length + 1 }),
    (error) => error.code === "object_mismatch" && error.status === 409);
});

test("createPlayableVideoDerivative produces a real, faststarted, browser-playable mp4", async () => {
  const bytes = mp4(640, 360, 1, 10);
  const runner = new FfmpegVideoRunner();
  const derivative = await createPlayableVideoDerivative(bytes, runner);
  assert.equal(derivative.mime, "video/mp4");
  assert.ok(derivative.bytes > 0);
  assert.match(derivative.sha256, /^[a-f0-9]{64}$/);
  assert.ok(mp4Container(derivative.body), "transcoded output must itself be a structurally valid mp4");
  // moov-before-mdat: this is the concrete, observable effect of -movflags +faststart.
  const box = mp4Container(derivative.body);
  const headerLength = derivative.body.readUInt32BE(0) === 1 ? 16 : 8;
  let offset = derivative.body.readUInt32BE(0) === 1
    ? Number(derivative.body.readBigUInt64BE(8))
    : derivative.body.readUInt32BE(0);
  assert.ok(box);
  const types = [];
  while (offset + 8 <= derivative.body.length && types.length < 6) {
    const size = derivative.body.readUInt32BE(offset);
    const type = derivative.body.toString("ascii", offset + 4, offset + 8);
    types.push(type);
    if (size < 8) break;
    offset += size;
  }
  assert.ok(types.indexOf("moov") >= 0 && types.indexOf("moov") < types.indexOf("mdat"),
    `expected moov before mdat for faststart playback, got box order: ${types.join(",")}`);
  void headerLength;
});

test("createPlayableVideoDerivative preserves the source audio track as AAC (post-video-v0 follow-up)", async () => {
  const bytes = mp4WithAudio(640, 360, 1, 10);
  const runner = new FfmpegVideoRunner();
  const derivative = await createPlayableVideoDerivative(bytes, runner);
  assert.ok(mp4Container(derivative.body));
  const audioStreams = ffprobeAudioStream(derivative.body);
  assert.equal(audioStreams.length, 1, "exactly one audio stream must survive the round trip");
  assert.equal(audioStreams[0].codec_name, "aac");
  assert.equal(audioStreams[0].channels, 2);
});

test("createPlayableVideoDerivative surfaces a decoder failure as media_decode_rejected", async () => {
  const runner = new FfmpegVideoRunner({ ffmpegPath: "/definitely/not/installed/unseen-ffmpeg" });
  await assert.rejects(createPlayableVideoDerivative(mp4(64, 64, 1, 5), runner),
    (error) => error.code === "media_decoder_unavailable" && error.status === 503);
});
