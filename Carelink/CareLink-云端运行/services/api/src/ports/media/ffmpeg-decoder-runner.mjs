import { spawn } from "node:child_process";
import { assert } from "../../errors.mjs";

export const DEFAULT_DECODER_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_INPUT_BYTES = 32 * 1024 * 1024;

export function assertDecoderRunnerPort(runner) {
  assert(runner && typeof runner.probe === "function" && typeof runner.decode === "function" &&
    typeof runner.deriveViewerSafe === "function",
    "media_decoder_unavailable", 503);
  return runner;
}

export class FfmpegDecoderRunner {
  constructor({
    ffprobePath = process.env.UNSEEN_FFPROBE_PATH ?? "ffprobe",
    ffmpegPath = process.env.UNSEEN_FFMPEG_PATH ?? "ffmpeg",
    timeoutMs = DEFAULT_DECODER_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    maxInputBytes = DEFAULT_MAX_INPUT_BYTES,
    maxConcurrent = 2,
    spawnImpl = spawn
  } = {}) {
    assert(typeof ffprobePath === "string" && ffprobePath.length > 0 && typeof ffmpegPath === "string" && ffmpegPath.length > 0,
      "media_decoder_unavailable", 503);
    assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && Number.isSafeInteger(maxOutputBytes) && maxOutputBytes > 0 &&
      Number.isSafeInteger(maxInputBytes) && maxInputBytes > 0 && Number.isSafeInteger(maxConcurrent) && maxConcurrent > 0,
      "media_decoder_unavailable", 503);
    this.ffprobePath = ffprobePath;
    this.ffmpegPath = ffmpegPath;
    this.timeoutMs = timeoutMs;
    this.maxOutputBytes = maxOutputBytes;
    this.maxInputBytes = maxInputBytes;
    this.maxConcurrent = maxConcurrent;
    this.active = 0;
    this.spawnImpl = spawnImpl;
  }

  run(executable, args, input = Buffer.alloc(0), { maxOutputBytes = this.maxOutputBytes } = {}) {
    if (Buffer.byteLength(input) > this.maxInputBytes) return Promise.resolve({ status: null, signal: null,
      stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: Object.assign(new Error("decoder input exceeded limit"), { code: "EFBIG" }) });
    if (this.active >= this.maxConcurrent) return Promise.resolve({ status: null, signal: null,
      stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: Object.assign(new Error("decoder concurrency exhausted"), { code: "EBUSY" }) });
    this.active += 1;
    return new Promise((resolve) => {
      const startedAt = Date.now();
      let child;
      try {
        child = this.spawnImpl(executable, args, {
          shell: false,
          detached: process.platform !== "win32",
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"]
        });
      } catch (error) {
        this.active -= 1;
        resolve({ status: null, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error });
        return;
      }
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let failure = null;
      let timedOut = false;
      const killGroup = () => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch { child.kill("SIGKILL"); }
      };
      const append = (current, chunk) => {
        if (current.length + chunk.length > maxOutputBytes) {
          failure = Object.assign(new Error("decoder output exceeded limit"), { code: "ENOBUFS" });
          killGroup();
          return current;
        }
        return Buffer.concat([current, chunk]);
      };
      child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
      child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
      child.stdin.on("error", () => {});
      child.once("error", (error) => { failure = error; });
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup();
      }, this.timeoutMs);
      child.once("close", (status, signal) => {
        clearTimeout(timer);
        this.active -= 1;
        if (timedOut) failure = Object.assign(new Error("decoder timed out"), { code: "ETIMEDOUT" });
        resolve({ status, signal, stdout, stderr, error: failure, pid: child.pid,
          durationMs: Date.now() - startedAt, terminated: Boolean(signal || failure) });
      });
      child.stdin.end(Buffer.from(input));
    });
  }

  probe(bytes) {
    return this.run(this.ffprobePath, [
      "-v", "error", "-select_streams", "v:0", "-read_intervals", "%+#1",
      "-show_entries", [
        "stream=width,height,color_primaries,color_space",
        "stream_tags=rotate,creation_time,DateTimeOriginal,OffsetTimeOriginal,0x9011",
        "stream_side_data=rotation",
        "frame_tags=creation_time,DateTimeOriginal,OffsetTimeOriginal,0x9011",
        "format_tags=creation_time,DateTimeOriginal,OffsetTimeOriginal,0x9011"
      ].join(":"), "-show_streams", "-show_frames", "-show_format", "-of", "json", "pipe:0"
    ], bytes);
  }

  decode(bytes) {
    // Only the first frame is decoded: this call exists purely to force real
    // pixel decoding as a corruption/exploit check. Frame-count / animation
    // detection is done structurally in media.mjs before this runs -- see the
    // comment on decode() there. Piped JPEG input is demuxed by ffmpeg's
    // jpeg_pipe, which naively treats every embedded SOI marker (e.g. an EXIF
    // thumbnail) as a new frame, so asking for more than 1 frame here would
    // reintroduce that false-positive.
    return this.run(this.ffmpegPath, [
      "-v", "error", "-threads", "1", "-i", "pipe:0", "-map", "0:v:0",
      "-frames:v", "1", "-f", "framemd5", "pipe:1"
    ], bytes);
  }

  deriveViewerSafe(bytes) {
    return this.run(this.ffmpegPath, [
      "-v", "error", "-threads", "1", "-i", "pipe:0", "-map", "0:v:0",
      "-map_metadata", "-1", "-map_chapters", "-1", "-frames:v", "1", "-an", "-sn", "-dn",
      "-vf", "scale=w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
      "-pix_fmt", "yuvj420p", "-q:v", "4", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"
    ], bytes, { maxOutputBytes: 4 * 1024 * 1024 });
  }

  async diagnostics() {
    const [probe, decoder] = await Promise.all([
      this.run(this.ffprobePath, ["-version"]),
      this.run(this.ffmpegPath, ["-version"])
    ]);
    return { probe, decoder, timeoutMs: this.timeoutMs, maxInputBytes: this.maxInputBytes,
      maxOutputBytes: this.maxOutputBytes, maxConcurrent: this.maxConcurrent, shell: false };
  }
}
