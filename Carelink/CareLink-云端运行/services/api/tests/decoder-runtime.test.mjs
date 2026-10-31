import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createViewerSafeDerivative, inspectMedia } from "../src/media.mjs";
import { FfmpegDecoderRunner } from "../src/ports/media/ffmpeg-decoder-runner.mjs";
import { png } from "./fixture-factory.mjs";

function assertGone(pid) {
  assert.throws(() => process.kill(pid, 0), (error) => error.code === "ESRCH");
}

test("decoder runtime probe records executable version and build flags", async () => {
  const diagnostics = await new FfmpegDecoderRunner().diagnostics();
  assert.equal(diagnostics.shell, false);
  assert.equal(diagnostics.timeoutMs, 8_000);
  for (const result of [diagnostics.probe, diagnostics.decoder]) {
    assert.equal(result.status, 0, result.stderr.toString());
    const output = result.stdout.toString();
    // Major version only, deliberately not an exact build. What this gate actually protects is
    // "a modern ffmpeg/ffprobe is present and its decode report is trustworthy" — not "this host
    // ships the same package as the dev laptop". Production Ubuntu and a Homebrew Mac never carry
    // the same patch release, so an exact pin is guaranteed to go red on some machine and teaches
    // everyone to ignore this test. The actual banner is echoed on failure so a genuine
    // too-old-toolchain shows up as a readable diagnosis instead of a bare regex mismatch.
    const version = /ff(?:probe|mpeg) version (\d+)\./.exec(output);
    assert.ok(version, `unparseable ffmpeg/ffprobe version banner: ${output.split("\n")[0]}`);
    assert.ok(Number(version[1]) >= 8, `ffmpeg/ffprobe major version must be >= 8, got: ${version[0]}`);
    assert.match(output, /configuration: .*--enable-gpl.*--enable-openssl/);
  }
});

test("decoder invocation passes literal executable and argv with shell disabled", async () => {
  let invocation;
  const runner = new FfmpegDecoderRunner({ spawnImpl: (executable, args, options) => {
    invocation = { executable, args, options };
    return spawn(process.execPath, ["-e", "process.exit(0)"], options);
  } });
  const result = await runner.run("literal;not-a-shell-command", ["argument with spaces"]);
  assert.equal(result.status, 0);
  assert.equal(invocation.executable, "literal;not-a-shell-command");
  assert.deepEqual(invocation.args, ["argument with spaces"]);
  assert.equal(invocation.options.shell, false);
});

test("viewer-safe derivative is a bounded screen-size JPEG", async () => {
  const derivative = await createViewerSafeDerivative(png(2400, 1200), new FfmpegDecoderRunner());
  assert.equal(derivative.mime, "image/jpeg");
  assert.equal(derivative.width, 1920);
  assert.equal(derivative.height, 960);
  assert.deepEqual([...derivative.body.subarray(0, 2)], [0xff, 0xd8]);
  assert.ok(derivative.bytes < 4 * 1024 * 1024);
});

test("missing decoder path fails closed as media_decoder_unavailable", async () => {
  const runner = new FfmpegDecoderRunner({
    ffprobePath: "/definitely/not-installed/unseen-ffprobe",
    ffmpegPath: "/definitely/not-installed/unseen-ffmpeg",
    timeoutMs: 200
  });
  await assert.rejects(inspectMedia(png(), { declaredMime: "image/png", decoderRunner: runner }),
    (error) => error.code === "media_decoder_unavailable" && error.status === 503);
});

test("decoder timeout is stable, SIGKILLed, closed, and leaves no process", async () => {
  let child;
  const runner = new FfmpegDecoderRunner({ timeoutMs: 40, spawnImpl: (_executable, _args, options) => {
    child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options);
    return child;
  } });
  await assert.rejects(inspectMedia(png(), { declaredMime: "image/png", decoderRunner: runner }),
    (error) => error.code === "media_decode_rejected" && error.details?.reason === "decoder_timeout");
  assert.equal(child.signalCode, "SIGKILL");
  assertGone(child.pid);
});

test("decoder crash is stable, closed, and leaves no process", async () => {
  let child;
  const runner = new FfmpegDecoderRunner({ timeoutMs: 1_000, spawnImpl: (_executable, _args, options) => {
    child = spawn(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"], options);
    return child;
  } });
  await assert.rejects(inspectMedia(png(), { declaredMime: "image/png", decoderRunner: runner }),
    (error) => error.code === "media_decode_rejected" && error.details?.reason === "decoder_crash");
  assert.equal(child.signalCode, "SIGKILL");
  assertGone(child.pid);
});

test("decoder semaphore, input cap, and output cap fail closed with observable stable causes", async () => {
  let spawned = 0;
  const inputLimited = new FfmpegDecoderRunner({ maxInputBytes: 10,
    spawnImpl: (...args) => { spawned += 1; return spawn(...args); } });
  const inputFailure = await inputLimited.run(process.execPath, ["-e", "process.exit(0)"], Buffer.alloc(11));
  assert.equal(inputFailure.error.code, "EFBIG");
  assert.equal(spawned, 0);

  const concurrent = new FfmpegDecoderRunner({ maxConcurrent: 1, timeoutMs: 50 });
  const first = concurrent.run(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  const rejected = await concurrent.run(process.execPath, ["-e", "process.exit(0)"]);
  assert.equal(rejected.error.code, "EBUSY");
  const timedOut = await first;
  assert.equal(timedOut.error.code, "ETIMEDOUT");
  assert.equal(timedOut.terminated, true);
  assert.equal(concurrent.active, 0);

  const outputLimited = new FfmpegDecoderRunner({ maxOutputBytes: 16, timeoutMs: 1_000 });
  const overflow = await outputLimited.run(process.execPath,
    ["-e", "process.stdout.write('x'.repeat(1024))"]);
  assert.equal(overflow.error.code, "ENOBUFS");
  assert.equal(overflow.terminated, true);
  assert.ok(Number.isSafeInteger(overflow.durationMs));
});
