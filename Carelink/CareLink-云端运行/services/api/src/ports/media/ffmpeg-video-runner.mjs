import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assert } from "../../errors.mjs";

// Video decoding needs real seeking (an mp4/mov's moov atom is very often at the *end* of the
// file for anything a phone camera wrote directly -- "faststart" is a post-process step most
// capture apps never run), so unlike FfmpegDecoderRunner (services/api/src/ports/media/
// ffmpeg-decoder-runner.mjs) this port does NOT pipe bytes over stdin. It writes the upload to a
// private temp file per invocation and passes ffprobe/ffmpeg a real file path instead. That also
// means container/demuxer selection is done by ffmpeg's own content sniff against the real file,
// never by a piped-input heuristic -- so this port cannot reintroduce the jpeg_pipe-style
// demuxer-guessing bug that services/api/src/media.mjs's decode() comment documents for images.
// Video/image dispatch itself happens one layer up, in services/api/src/video.mjs's structural
// ISO-BMFF ftyp sniff (mirroring media.mjs's png()/jpeg()/webp()/heif() sniffs) *before* this
// runner is ever invoked -- ffmpeg here is only ever asked to handle bytes we already know are a
// video container.
//
// Concurrency is a single shared counter across probe/poster/transcode: the production box is a
// 2-core/2GB machine and the brief calls for transcode concurrency of exactly 1, so the simplest
// safe thing is to serialize *all* video ffmpeg work (probe included) through one runner instance
// rather than partially parallelizing probe against a concurrent transcode.
//
// Timeouts (see the video-v0 report for the full derivation): a synthetic, highly-compressible
// 10s 1080p veryfast encode took 7.05s on the target 2-core box (~0.7s of encode time per second
// of source, and that is a *floor* -- real camera footage carries far more entropy per frame).
// Assuming real footage is 2-4x slower per the brief's own caveat, a worst-case 60s source could
// take roughly 84-170s to transcode; transcodeTimeoutMs below adds real headroom on top of that
// pessimistic estimate rather than cutting it close. probe/poster only need to decode a handful
// of frames regardless of the video's duration, so they get much shorter budgets.
export const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
export const DEFAULT_POSTER_TIMEOUT_MS = 20_000;
export const DEFAULT_TRANSCODE_TIMEOUT_MS = 240_000;
const DEFAULT_MAX_OUTPUT_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_INPUT_BYTES = 100 * 1024 * 1024;

// Audio bitrate hard cap for transcode()'s AAC track. 128 kbps stereo AAC-LC is the standard
// "good enough for any consumer recording" ceiling used by YouTube/Instagram/TikTok uploads --
// this pipeline's inputs are phone-mic camera audio (voices, ambient room sound), never studio
// music, so there is no case where more headroom buys an audible improvement. Kept as an
// explicit constant (not left to the encoder's default, which is unbounded) because an
// uncapped VBR/ABR request would let a pathological multichannel or high-samplerate source
// balloon the audio bitstream for no perceptual gain.
const TRANSCODE_AUDIO_BITRATE = "128k";

export function assertVideoRunnerPort(runner) {
  assert(runner && typeof runner.probe === "function" && typeof runner.poster === "function" &&
    typeof runner.transcode === "function", "media_decoder_unavailable", 503);
  return runner;
}

// Optional env-var overrides for the three timeouts and the concurrency limit, read only as
// constructor defaults (an explicit constructor option always wins) -- same shape as
// UNSEEN_HEALTHZ_CACHE_TTL_MS and friends in services/api/src/index.mjs. Lets the transcode
// timeout in particular be tuned from real production measurements post-deploy without a code
// change, without adding any *new* required configuration (every one of these has a reasoned
// default -- see the class header comment).
const envInt = (name) => (process.env[name] === undefined ? undefined : Number(process.env[name]));

export class FfmpegVideoRunner {
  constructor({
    ffprobePath = process.env.UNSEEN_FFPROBE_PATH ?? "ffprobe",
    ffmpegPath = process.env.UNSEEN_FFMPEG_PATH ?? "ffmpeg",
    probeTimeoutMs = envInt("UNSEEN_VIDEO_PROBE_TIMEOUT_MS") ?? DEFAULT_PROBE_TIMEOUT_MS,
    posterTimeoutMs = envInt("UNSEEN_VIDEO_POSTER_TIMEOUT_MS") ?? DEFAULT_POSTER_TIMEOUT_MS,
    transcodeTimeoutMs = envInt("UNSEEN_VIDEO_TRANSCODE_TIMEOUT_MS") ?? DEFAULT_TRANSCODE_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    maxInputBytes = DEFAULT_MAX_INPUT_BYTES,
    maxConcurrent = envInt("UNSEEN_VIDEO_MAX_CONCURRENT") ?? 1,
    tmpDir = process.env.UNSEEN_VIDEO_TMP_DIR ?? os.tmpdir(),
    spawnImpl = spawn
  } = {}) {
    assert(typeof ffprobePath === "string" && ffprobePath.length > 0 && typeof ffmpegPath === "string" && ffmpegPath.length > 0,
      "media_decoder_unavailable", 503);
    assert([probeTimeoutMs, posterTimeoutMs, transcodeTimeoutMs, maxOutputBytes, maxInputBytes, maxConcurrent]
      .every((value) => Number.isSafeInteger(value) && value > 0), "media_decoder_unavailable", 503);
    this.ffprobePath = ffprobePath;
    this.ffmpegPath = ffmpegPath;
    this.probeTimeoutMs = probeTimeoutMs;
    this.posterTimeoutMs = posterTimeoutMs;
    this.transcodeTimeoutMs = transcodeTimeoutMs;
    this.maxOutputBytes = maxOutputBytes;
    this.maxInputBytes = maxInputBytes;
    this.maxConcurrent = maxConcurrent;
    this.active = 0;
    this.tmpDir = tmpDir;
    this.spawnImpl = spawnImpl;
  }

  // Runs `executable <args from buildArgs(inputFile[, outputFile])>` against a real temp input
  // file (never stdin -- ffmpeg reads the file directly, see the header comment for why). With
  // outputToFile:false (the default -- probe/poster), the process writes its result to stdout,
  // captured up to maxOutputBytes as it streams. With outputToFile:true (transcode), buildArgs
  // gets a *second* temp file path and must write there instead of pipe:1: `-movflags +faststart`
  // rewrites the moov atom after encoding, which requires a seekable output, and a pipe is not
  // seekable ("muxer does not support non seekable output" is ffmpeg's actual failure here). The
  // output file is read back (size-checked against maxOutputBytes first) into the same `stdout`
  // field so every caller downstream sees one consistent shape regardless of which path was used.
  // The whole scratch directory (input + optional output temp file) is always removed, success or
  // not.
  async runOnFile(executable, buildArgs, bytes, { timeoutMs, maxOutputBytes = this.maxOutputBytes, outputToFile = false } = {}) {
    const body = Buffer.from(bytes);
    if (body.length > this.maxInputBytes) return { status: null, signal: null, stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0), error: Object.assign(new Error("video input exceeded limit"), { code: "EFBIG" }) };
    if (this.active >= this.maxConcurrent) return { status: null, signal: null, stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0), error: Object.assign(new Error("video concurrency exhausted"), { code: "EBUSY" }) };
    this.active += 1;
    let scratchDir;
    try {
      scratchDir = await mkdtemp(path.join(this.tmpDir, "unseen-video-"));
      const inputFile = path.join(scratchDir, `src-${randomBytes(8).toString("hex")}`);
      const outputFile = outputToFile ? path.join(scratchDir, `out-${randomBytes(8).toString("hex")}.mp4`) : null;
      await writeFile(inputFile, body, { mode: 0o600 });
      const result = await new Promise((resolve) => {
        const startedAt = Date.now();
        let child;
        try {
          child = this.spawnImpl(executable, buildArgs(inputFile, outputFile), {
            shell: false, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
          });
        } catch (error) {
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
            failure = Object.assign(new Error("video output exceeded limit"), { code: "ENOBUFS" });
            killGroup();
            return current;
          }
          return Buffer.concat([current, chunk]);
        };
        if (!outputToFile) child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
        child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
        child.once("error", (error) => { failure = error; });
        const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
        child.once("close", (status, signal) => {
          clearTimeout(timer);
          if (timedOut) failure = Object.assign(new Error("video decoder timed out"), { code: "ETIMEDOUT" });
          resolve({ status, signal, stdout, stderr, error: failure, pid: child.pid,
            durationMs: Date.now() - startedAt, terminated: Boolean(signal || failure) });
        });
      });
      if (outputToFile && !result.error && result.status === 0) {
        try {
          const info = await stat(outputFile);
          if (info.size > maxOutputBytes) {
            result.error = Object.assign(new Error("video output exceeded limit"), { code: "ENOBUFS" });
          } else {
            result.stdout = await readFile(outputFile);
          }
        } catch (error) {
          result.error = Object.assign(new Error("video output file missing"), { code: error?.code ?? "ENOENT" });
        }
      }
      return result;
    } finally {
      this.active -= 1;
      if (scratchDir) await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // Metadata only -- duration/width/height/rotation/codec -- no pixel decoding. Cheap and fast
  // regardless of the video's length, so it gets the shortest timeout and runs first: rejecting
  // an obviously-too-long or too-large video here means we never spend transcodeTimeoutMs budget
  // on something that was always going to be rejected.
  probe(bytes) {
    return this.runOnFile(this.ffprobePath, (inputFile) => [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", [
        "stream=width,height,codec_type,codec_name,r_frame_rate,duration,nb_frames",
        "stream_tags=rotate,creation_time,DateTimeOriginal,OffsetTimeOriginal,0x9011",
        "stream_side_data=rotation",
        "format=duration,size",
        "format_tags=creation_time,DateTimeOriginal,OffsetTimeOriginal,0x9011"
      ].join(":"),
      "-of", "json", inputFile
    ], bytes, { timeoutMs: this.probeTimeoutMs });
  }

  // Decodes exactly the first video frame to a PNG. This is deliberately the *only* pixel-level
  // decode this port performs before commit(): it doubles as (a) the corruption/exploit defense
  // that media.mjs's decode() gets from its framemd5 call for images, and (b) the actual poster
  // asset stored as the photo's viewer-safe derivative. No separate throwaway decode step, one
  // ffmpeg invocation does both jobs.
  poster(bytes) {
    return this.runOnFile(this.ffmpegPath, (inputFile) => [
      "-v", "error", "-i", inputFile, "-map", "0:v:0", "-map_metadata", "-1", "-frames:v", "1",
      "-an", "-sn", "-dn", "-pix_fmt", "rgb24", "-f", "image2pipe", "-vcodec", "png", "pipe:1"
    ], bytes, { timeoutMs: this.posterTimeoutMs, maxOutputBytes: 20 * 1024 * 1024 });
  }

  // Full transcode to a browser-playable, metadata-stripped H.264/AAC mp4. -movflags +faststart
  // moves the moov atom to the front of the *output* so apps/web's <video> element doesn't need
  // a second round trip to start playing. -vf scale=...:force_original_aspect_ratio is defense
  // in depth (inspectVideo() already rejects anything above 1080p before this ever runs) rather
  // than a real resize path.
  //
  // Audio (post-video-v0 follow-up -- the audio-drop was a deliberate v0 punt, not permanent;
  // see the video-v0 report for the original reasoning and the erratum that reopened it):
  //   - "-map 0:a:0?" is the *first* audio stream, and the trailing "?" makes the map optional
  //     -- ffmpeg documents this exact syntax ("Trailing question mark ... makes the map
  //     optional") so a source with zero audio streams (very common -- plenty of real camera
  //     footage is silent) still exits 0 with a video-only mp4, and a source with several audio
  //     tracks only ever keeps the first, never all of them. Verified against the real ffmpeg
  //     6.1.1-3ubuntu5 binary (Ubuntu 24.04's package, matching production exactly): a
  //     zero-audio input, a single-audio input, and a two-audio-track input all transcode
  //     successfully with this flag, and the two-track case keeps only stream a:0.
  //   - "-c:a aac" is FFmpeg's native, built-in AAC-LC encoder (not "aac_at", which is a
  //     macOS-only AudioToolbox wrapper this dev machine also has but Linux prod does not, and
  //     not "libfdk_aac", which needs an external nonfree library). The native encoder ships as
  //     part of libavcodec itself -- no --enable-libfdk-aac/--enable-nonfree flags, no extra
  //     package -- so it is present in essentially every ffmpeg build, distro-packaged or not.
  //     Confirmed directly (not assumed): `docker run ubuntu:24.04` + `apt-get install ffmpeg`
  //     installs exactly `6.1.1-3ubuntu5` (matching prod's reported 6.1.1 down to the patch),
  //     its `-encoders` output lists only "aac" for AAC (no libfdk_aac, no dpkg package for it
  //     either), and a real transcode through that exact binary with these args produced a
  //     44.1kHz/stereo AAC track that plays back cleanly.
  //   - "-b:a 128k -ac 2" is the bitrate/channel hard cap (see TRANSCODE_AUDIO_BITRATE above) --
  //     forcing stereo also bounds worst-case encoder work for an oddball multichannel source,
  //     since this pipeline builds a fixed argv without a pre-probe of the channel layout.
  //   - Everything metadata-related is untouched and still applies to audio too: -map_metadata
  //     -1 / -map_chapters -1 strip container-level tags (verified GPS/device tags injected
  //     into a test file do not survive), and -sn -dn continue to drop subtitle/data streams.
  //     No new metadata surface is introduced by keeping the audio stream itself.
  //   - Cost: measured on a worst-case 60s/1080p high-entropy source (~2 CPU/2GB, matching the
  //     production box's shape) that adding AAC encoding leaves wall-clock time unchanged
  //     within measurement noise and adds only a few percent to peak RSS -- audio encode work
  //     is negligible next to 1080p H.264. See the video-audio-track report for the full numbers.
  transcode(bytes) {
    return this.runOnFile(this.ffmpegPath, (inputFile, outputFile) => [
      "-v", "error", "-i", inputFile, "-map", "0:v:0", "-map", "0:a:0?",
      "-map_metadata", "-1", "-map_chapters", "-1",
      "-sn", "-dn", "-vf", "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", TRANSCODE_AUDIO_BITRATE, "-ac", "2",
      "-movflags", "+faststart", "-f", "mp4", "-y", outputFile
    ], bytes, { timeoutMs: this.transcodeTimeoutMs, outputToFile: true });
  }

  async diagnostics() {
    // Sequential, not Promise.all: with the default maxConcurrent of 1 (see the class header
    // comment for why), running these two calls concurrently would make the second one observe
    // the first still holding the slot and fail closed with EBUSY.
    const probe = await this.runOnFile(this.ffprobePath, () => ["-version"], Buffer.alloc(0), { timeoutMs: this.probeTimeoutMs });
    const decoder = await this.runOnFile(this.ffmpegPath, () => ["-version"], Buffer.alloc(0), { timeoutMs: this.probeTimeoutMs });
    return { probe, decoder, probeTimeoutMs: this.probeTimeoutMs, posterTimeoutMs: this.posterTimeoutMs,
      transcodeTimeoutMs: this.transcodeTimeoutMs, maxInputBytes: this.maxInputBytes,
      maxOutputBytes: this.maxOutputBytes, maxConcurrent: this.maxConcurrent, shell: false };
  }
}
