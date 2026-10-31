import { createHash } from "node:crypto";
import { ApiError, assert } from "./errors.mjs";
import { assertVideoRunnerPort, FfmpegVideoRunner } from "./ports/media/ffmpeg-video-runner.mjs";
import { capturedAtFromProbe } from "./media.mjs";

// Video upload v0. This module is the video-side counterpart of media.mjs's inspectMedia(), and
// it deliberately mirrors that module's shape: a cheap, ffmpeg-free structural container sniff
// first (mp4Container() below, parallel to media.mjs's png()/jpeg()/webp()/heif()), then real
// ffmpeg-family decode-backed validation. It does NOT import or modify anything in media.mjs
// beyond the one genuinely shared, format-agnostic helper (capturedAtFromProbe) -- image and
// video validation are two fully separate code paths that both happen to reject a bad file with
// an ApiError.
//
// Container sniff (why this can't collide with media.mjs's "no frame-count check" rule):
// mp4/mov (ISO-BMFF) and HEIF/HEIC share the exact same box-container syntax -- a HEIC file *is*
// an ISO-BMFF file, just with an image-only ftyp brand. media.mjs's heif() sniff already parses
// the same ftyp box and only accepts image brands (heic/heix/mif1/hevc/hevx/msf1); mp4Container()
// below parses the identical box header but only accepts general-purpose video/movie brands
// (isom/mp4x/avc1/qt.../3gpx/...) and explicitly does not recognize any HEIF brand. Routing which
// sniff runs at all is decided one layer up in upload-service.mjs, purely from the caller's
// declared MIME (image/* -> media.mjs's inspectMedia(), video/* -> inspectVideo() here) -- so an
// actual video's bytes are never handed to media.mjs, and an actual image's bytes are never
// handed here. If a caller lies about the MIME, the *wrong* structural sniff runs against the
// real bytes and fails closed (mp4Container() returns null for real image bytes, image sniffs
// return null for real video bytes) -- same fail-closed shape media.mjs already relies on for a
// declaredMime/actual-bytes mismatch.
//
// Multi-frame handling: media.mjs's decode() comment forbids reintroducing a frame-count check
// there because ffmpeg's piped jpeg_pipe demuxer miscounts an embedded EXIF thumbnail as a second
// frame. That whole failure mode is specific to *piped* input selecting jpeg_pipe. This module
// never pipes bytes to ffmpeg at all (see ffmpeg-video-runner.mjs's header comment) -- every
// ffprobe/ffmpeg invocation here reads a real temp file, so demuxer selection is ffmpeg's normal
// content-sniffed choice, not a piped-input guess. Videos are *supposed* to be multi-frame; this
// module never asks "how many frames" as a rejection signal in the first place, so there is no
// tension with media.mjs's rule to begin with -- the two modules are answering different
// questions (image: "is this secretly animated" vs video: "is this within our duration/
// resolution budget"), not the same question via two different mechanisms.

const MAX_INPUT_BYTES = 100 * 1024 * 1024;
const MAX_DURATION_MS = 60_000;
// Small grace window absorbing container/ffprobe duration rounding jitter (e.g. a genuinely
// 60.00s recording landing at 60.016s after mux rounding). The enforced ceiling is still ~60s,
// not a loophole to allow materially longer videos.
const DURATION_GRACE_MS = 250;
const MAX_DISPLAY_LONG_EDGE = 1920;
const MAX_DISPLAY_SHORT_EDGE = 1080;
const MAX_POSTER_BYTES = 20 * 1024 * 1024;
const MAX_TRANSCODE_BYTES = 100 * 1024 * 1024;

// ISO-BMFF "movie" structural brands -- ordinary mp4/mov/3gp video files, as opposed to the
// still-image/image-sequence HEIF brands media.mjs's heif() already owns (heic/heix/mif1/hevc/
// hevx/msf1). Deliberately does not include any HEIF brand, even defensively: this module never
// wants to treat an image-sequence HEIC as a video no matter what a caller declares.
const VIDEO_BRANDS = new Set(["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "mp71",
  "avc1", "M4V ", "M4VH", "M4VP", "3gp4", "3gp5", "3gp6", "3g2a", "3g2b", "qt  ", "mmp4", "MSNV", "NDAS", "dash"]);

// Structural-only ISO-BMFF ftyp sniff -- no ffmpeg involved. Returns the parsed major/compatible
// brands when the file is recognizably an mp4/mov/3gp *movie* container, or null otherwise (not
// this container family at all, or an HEIF file that happens to share the box syntax).
export function mp4Container(bytes) {
  if (bytes.length < 16) return null;
  const size = bytes.readUInt32BE(0);
  if (bytes.toString("ascii", 4, 8) !== "ftyp") return null;
  let headerLength = 8;
  let boxSize = size;
  if (size === 1) {
    assert(bytes.length >= 16, "media_decode_rejected", 422);
    const high = bytes.readUInt32BE(8);
    const low = bytes.readUInt32BE(12);
    assert(high === 0, "media_decode_rejected", 422); // reject unrepresentable (>4GiB) box sizes
    boxSize = low;
    headerLength = 16;
  }
  assert(boxSize >= headerLength + 8 && boxSize <= bytes.length, "media_decode_rejected", 422);
  const majorBrand = bytes.toString("ascii", headerLength, headerLength + 4);
  const compatible = [];
  for (let offset = headerLength + 8; offset + 4 <= boxSize; offset += 4) {
    compatible.push(bytes.toString("ascii", offset, offset + 4));
  }
  const brands = [majorBrand, ...compatible];
  if (!brands.some((brand) => VIDEO_BRANDS.has(brand))) return null;
  return { majorBrand, compatibleBrands: compatible };
}

function assertDecoded(result, rejectCode) {
  if (["ENOENT", "EBUSY"].includes(result.error?.code)) {
    throw new ApiError("media_decoder_unavailable", 503, { decoder: "ffmpeg_family" });
  }
  const reason = result.error?.code === "ETIMEDOUT" ? "decoder_timeout" :
    result.error?.code === "EFBIG" ? "video_too_large" :
      result.signal ? "decoder_crash" : "decoder_failure";
  assert(!result.error && result.status === 0, rejectCode, 422, { reason });
}

function rotationSwap(stream) {
  const rotation = Number(stream.tags?.rotate ?? stream.side_data_list?.find((entry) => entry.rotation != null)?.rotation ?? 0);
  return Math.abs(rotation) % 180 === 90;
}

export async function inspectVideo(input, { declaredMime, declaredBytes, decoderRunner = new FfmpegVideoRunner() } = {}) {
  const bytes = Buffer.from(input);
  const runner = assertVideoRunnerPort(decoderRunner);
  assert(bytes.length > 0 && bytes.length <= MAX_INPUT_BYTES, "media_policy_invalid", 422);
  assert(declaredBytes === undefined || Number(declaredBytes) === bytes.length, "object_mismatch", 409);
  const container = mp4Container(bytes);
  assert(container, "media_decode_rejected", 422, { reason: "not_a_video_container" });

  const probe = await runner.probe(bytes);
  assertDecoded(probe, "media_decode_rejected");
  let probeData;
  try { probeData = JSON.parse(probe.stdout.toString("utf8")); } catch { /* rejected below */ }
  const stream = probeData?.streams?.[0];
  assert(stream && stream.codec_type === "video" && Number.isSafeInteger(Number(stream.width)) &&
    Number.isSafeInteger(Number(stream.height)), "media_decode_rejected", 422);
  const durationSeconds = Number(probeData?.format?.duration ?? stream.duration);
  assert(Number.isFinite(durationSeconds) && durationSeconds > 0, "media_decode_rejected", 422, { reason: "duration_unavailable" });
  const durationMs = Math.round(durationSeconds * 1000);
  assert(durationMs <= MAX_DURATION_MS + DURATION_GRACE_MS, "video_duration_exceeded", 422,
    { reason: "duration_exceeded", durationMs, limitMs: MAX_DURATION_MS });

  const sideways = rotationSwap(stream);
  const displayWidth = sideways ? Number(stream.height) : Number(stream.width);
  const displayHeight = sideways ? Number(stream.width) : Number(stream.height);
  assert(displayWidth > 0 && displayHeight > 0, "media_decode_rejected", 422);
  const longEdge = Math.max(displayWidth, displayHeight);
  const shortEdge = Math.min(displayWidth, displayHeight);
  assert(longEdge <= MAX_DISPLAY_LONG_EDGE && shortEdge <= MAX_DISPLAY_SHORT_EDGE, "video_resolution_exceeded", 422,
    { reason: "resolution_exceeded", width: displayWidth, height: displayHeight,
      limitLongEdge: MAX_DISPLAY_LONG_EDGE, limitShortEdge: MAX_DISPLAY_SHORT_EDGE });

  // Real pixel decode of the first frame -- corruption/exploit defense (mirrors media.mjs's
  // framemd5 call for images) and the source of the poster derivative, in one ffmpeg invocation.
  const posterResult = await runner.poster(bytes);
  assertDecoded(posterResult, "media_decode_rejected");
  const posterBody = Buffer.from(posterResult.stdout);
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert(posterBody.length > 0 && posterBody.length <= MAX_POSTER_BYTES && posterBody.subarray(0, 8).equals(pngSignature),
    "media_decode_rejected", 422);

  return {
    mime: declaredMime === "video/quicktime" ? "video/quicktime" : "video/mp4",
    format: "mp4",
    width: displayWidth,
    height: displayHeight,
    orientation: Number(stream.tags?.rotate ?? stream.side_data_list?.find((entry) => entry.rotation != null)?.rotation ?? 0),
    // frames/colorProfile mirror inspectMedia()'s output shape (always 1 / "unspecified" isn't
    // meaningful for a video track the same way it is for a still image) purely so
    // upload-service.mjs's assets UPDATE can stay a single unbranched statement shared with the
    // photo path -- these two fields aren't used for any video-specific decision.
    frames: null,
    colorProfile: "unspecified",
    // Mirrors inspectMedia()'s parsed.metadataPolicyResult for the *raw* asset row (never the
    // derivative's own "exif_gps_stripped"): the original video bytes stay private and are never
    // served to any viewer, same as an original photo -- see upload-service.mjs's commit().
    metadataPolicyResult: "private_original_not_projected",
    durationMs,
    capturedAt: capturedAtFromProbe(probeData ?? {}),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    poster: { body: posterBody, mime: "image/png", bytes: posterBody.length,
      sha256: createHash("sha256").update(posterBody).digest("hex"), metadataPolicyResult: "exif_gps_stripped" }
  };
}

export async function createPlayableVideoDerivative(input, decoderRunner) {
  const runner = assertVideoRunnerPort(decoderRunner);
  const result = await runner.transcode(Buffer.from(input));
  assertDecoded(result, "media_decode_rejected");
  const body = Buffer.from(result.stdout);
  assert(body.length > 0 && body.length <= MAX_TRANSCODE_BYTES && mp4Container(body),
    "media_decode_rejected", 422);
  return { body, mime: "video/mp4", bytes: body.length,
    sha256: createHash("sha256").update(body).digest("hex"), metadataPolicyResult: "exif_gps_stripped" };
}

export const VIDEO_MIME_TYPES = Object.freeze(["video/mp4", "video/quicktime"]);
export const VIDEO_HARD_LIMIT_BYTES = MAX_INPUT_BYTES;
export const VIDEO_MAX_DURATION_MS = MAX_DURATION_MS;
export const VIDEO_MAX_DISPLAY_LONG_EDGE = MAX_DISPLAY_LONG_EDGE;
export const VIDEO_MAX_DISPLAY_SHORT_EDGE = MAX_DISPLAY_SHORT_EDGE;
