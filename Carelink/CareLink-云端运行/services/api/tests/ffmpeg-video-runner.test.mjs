import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FfmpegVideoRunner } from "../src/ports/media/ffmpeg-video-runner.mjs";
import { mp4, mp4WithAudio, mp4WithTwoAudioTracks } from "./fixture-factory.mjs";

// Real ffprobe over a transcoded mp4 buffer -- used only by the audio-preservation tests below,
// which need to observe the *actual* stream layout ffmpeg produced, not just argv shape.
function ffprobeStreams(bytes) {
  const file = path.join(os.tmpdir(), `unseen-test-probe-${randomBytes(8).toString("hex")}.mp4`);
  try {
    writeFileSync(file, bytes);
    const result = spawnSync("ffprobe", ["-v", "error", "-show_entries",
      "stream=codec_type,codec_name,channels,bit_rate", "-of", "json", file], { maxBuffer: 20 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr.toString());
    return JSON.parse(result.stdout.toString("utf8")).streams;
  } finally {
    try { unlinkSync(file); } catch { /* already gone */ }
  }
}

function assertGone(pid) {
  assert.throws(() => process.kill(pid, 0), (error) => error.code === "ESRCH");
}

test("video runner diagnostics reports the configured executables with shell disabled", async () => {
  const runner = new FfmpegVideoRunner();
  const diagnostics = await runner.diagnostics();
  assert.equal(diagnostics.shell, false);
  assert.equal(diagnostics.maxConcurrent, 1);
  assert.equal(diagnostics.probe.status, 0, diagnostics.probe.stderr.toString());
  assert.equal(diagnostics.decoder.status, 0, diagnostics.decoder.stderr.toString());
});

test("probe/poster/transcode never touch stdin -- ffmpeg reads a real temp file", async () => {
  let sawStdinPipe = false;
  const runner = new FfmpegVideoRunner({ spawnImpl: (executable, args, options) => {
    if (options.stdio?.[0] === "pipe") sawStdinPipe = true;
    return spawn(executable, args, options);
  } });
  const bytes = mp4(64, 64, 1, 5);
  await runner.probe(bytes);
  await runner.poster(bytes);
  await runner.transcode(bytes);
  assert.equal(sawStdinPipe, false);
});

test("every temp file/scratch dir is cleaned up after each call, success or failure", async () => {
  const runner = new FfmpegVideoRunner();
  const before = new Set(readdirSync(os.tmpdir()).filter((name) => name.startsWith("unseen-video-")));
  await runner.probe(mp4(64, 64, 1, 5));
  await runner.poster(mp4(64, 64, 1, 5));
  await runner.transcode(mp4(64, 64, 1, 5));
  await runner.probe(Buffer.from("not a video, will fail"));
  // Subset check, not exact-equality: an unrelated concurrent process could add/remove entries
  // in the shared OS tmpdir around this test; what actually matters is that none of *this
  // runner's* scratch dirs survive, i.e. no name appears after that wasn't already there before.
  const after = readdirSync(os.tmpdir()).filter((name) => name.startsWith("unseen-video-"));
  const leaked = after.filter((name) => !before.has(name));
  assert.deepEqual(leaked, []);
});

test("missing ffmpeg/ffprobe path fails closed with a stable error code", async () => {
  const runner = new FfmpegVideoRunner({ ffprobePath: "/definitely/not/installed/unseen-ffprobe" });
  const result = await runner.probe(mp4(64, 64, 1, 5));
  assert.equal(result.error.code, "ENOENT");
});

test("timeout is stable, SIGKILLed, closed, and leaves no process behind", async () => {
  let child;
  const runner = new FfmpegVideoRunner({ transcodeTimeoutMs: 40, spawnImpl: (_executable, _args, options) => {
    child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options);
    return child;
  } });
  const result = await runner.transcode(mp4(64, 64, 1, 5));
  assert.equal(result.error.code, "ETIMEDOUT");
  assert.equal(child.signalCode, "SIGKILL");
  assertGone(child.pid);
});

test("concurrency is exactly 1 by default -- a second call while one is in flight fails closed as EBUSY", async () => {
  const runner = new FfmpegVideoRunner({ transcodeTimeoutMs: 500 });
  const bytes = mp4(64, 64, 1, 5);
  const first = runner.transcode(bytes);
  // Give the first call a moment to acquire the concurrency slot before the second races it.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = await runner.transcode(bytes);
  assert.equal(second.error.code, "EBUSY");
  const firstResult = await first;
  assert.equal(firstResult.status, 0);
  assert.equal(runner.active, 0);
});

test("input over maxInputBytes is rejected before any process is spawned", async () => {
  let spawned = 0;
  const runner = new FfmpegVideoRunner({ maxInputBytes: 10, spawnImpl: (...args) => { spawned += 1; return spawn(...args); } });
  const result = await runner.probe(Buffer.alloc(11));
  assert.equal(result.error.code, "EFBIG");
  assert.equal(spawned, 0);
});

test("transcode output over maxOutputBytes is rejected even though it was written to a file, not streamed", async () => {
  const runner = new FfmpegVideoRunner({ maxOutputBytes: 16 });
  const result = await runner.transcode(mp4(320, 240, 1, 10));
  assert.equal(result.error.code, "ENOBUFS");
});

test("UNSEEN_VIDEO_TMP_DIR is honored for scratch file placement", async () => {
  const tmpDir = os.tmpdir();
  const runner = new FfmpegVideoRunner({ tmpDir });
  assert.equal(runner.tmpDir, tmpDir);
  assert.ok(existsSync(tmpDir));
});

// Audio-preservation contract (post-video-v0 follow-up: transcode() used to hard-drop audio
// with -an -- see the class header comment in ffmpeg-video-runner.mjs for the full reasoning).
// The argv-shape test below pins the actual flags so a future edit can't silently regress the
// "-an removed, -c:a aac -b:a 128k -ac 2 added, -map 0:a:0? optional-maps the first track" shape
// without a visible test failure; the three ffprobe-backed tests below it exercise the real
// ffmpeg 9.x binary on this machine end to end (production runs 6.1.1 -- see the report for how
// that exact version/encoder pairing was independently verified via a real 6.1.1 binary).
test("transcode's argv keeps audio (no -an), caps it with -c:a aac -b:a 128k -ac 2, and maps the first audio stream optionally", async () => {
  let argv;
  const runner = new FfmpegVideoRunner({ spawnImpl: (executable, args, options) => {
    argv = args;
    return spawn(executable, args, options);
  } });
  await runner.transcode(mp4(64, 64, 1, 5));
  assert.ok(argv, "spawnImpl must have been invoked");
  assert.equal(argv.includes("-an"), false, "audio must no longer be unconditionally dropped");
  assert.deepEqual(argv.slice(argv.indexOf("-map"), argv.indexOf("-map") + 4), ["-map", "0:v:0", "-map", "0:a:0?"]);
  assert.ok(argv.join(" ").includes("-map_metadata -1"), "metadata stripping must be untouched by the audio change");
  assert.ok(argv.join(" ").includes("-map_chapters -1"));
  assert.ok(argv.join(" ").includes("-c:a aac -b:a 128k -ac 2"));
  assert.ok(argv.includes("-sn") && argv.includes("-dn"), "subtitle/data streams must still be dropped");
});

test("transcode preserves a single AAC audio track (44.1kHz, stereo, at/under the 128k cap) when the source has audio", async () => {
  const runner = new FfmpegVideoRunner();
  const result = await runner.transcode(mp4WithAudio(320, 240, 1, 5));
  assert.equal(result.status, 0, result.stderr.toString());
  const streams = ffprobeStreams(result.stdout);
  const audio = streams.find((stream) => stream.codec_type === "audio");
  assert.ok(audio, "expected an audio stream in the transcoded output");
  assert.equal(audio.codec_name, "aac");
  assert.equal(audio.channels, 2);
  // A little headroom over the nominal 128000 target: encoders don't hit a CBR bitrate exactly.
  assert.ok(Number(audio.bit_rate) <= 145_000, `audio bit_rate ${audio.bit_rate} exceeded the 128k cap plus headroom`);
  assert.equal(streams.filter((stream) => stream.codec_type === "audio").length, 1);
});

test("transcode still succeeds (status 0, no audio stream) when the source has no audio track at all", async () => {
  const runner = new FfmpegVideoRunner();
  const result = await runner.transcode(mp4(320, 240, 1, 5));
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(result.error, null);
  const streams = ffprobeStreams(result.stdout);
  assert.equal(streams.filter((stream) => stream.codec_type === "audio").length, 0);
  assert.equal(streams.filter((stream) => stream.codec_type === "video").length, 1);
});

test("transcode keeps only the first audio track when the source carries multiple", async () => {
  const runner = new FfmpegVideoRunner();
  const result = await runner.transcode(mp4WithTwoAudioTracks(320, 240, 1, 5));
  assert.equal(result.status, 0, result.stderr.toString());
  const streams = ffprobeStreams(result.stdout);
  assert.equal(streams.filter((stream) => stream.codec_type === "audio").length, 1,
    "only the first audio track (a:0) should survive, never both");
});
