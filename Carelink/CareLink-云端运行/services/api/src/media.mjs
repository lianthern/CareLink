import { createHash } from "node:crypto";
import { ApiError, assert } from "./errors.mjs";
import { assertDecoderRunnerPort, FfmpegDecoderRunner } from "./ports/media/ffmpeg-decoder-runner.mjs";

const jpegSof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function png(bytes) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(signature)) return null;
  assert(bytes.readUInt32BE(8) === 13 && bytes.toString("ascii", 12, 16) === "IHDR", "media_decode_rejected", 422);
  let offset = 8;
  let frames = 1;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    assert(offset + 12 + length <= bytes.length, "media_decode_rejected", 422);
    if (type === "acTL") frames = Math.max(2, bytes.readUInt32BE(offset + 8));
    offset += 12 + length;
    if (type === "IEND") break;
  }
  return { mime: "image/png", format: "png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), frames };
}

function jpeg(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    assert(offset + 2 <= bytes.length, "media_decode_rejected", 422);
    const length = bytes.readUInt16BE(offset);
    assert(length >= 2 && offset + length <= bytes.length, "media_decode_rejected", 422);
    if (jpegSof.has(marker)) {
      assert(length >= 7, "media_decode_rejected", 422);
      return {
        mime: "image/jpeg",
        format: "jpeg",
        width: bytes.readUInt16BE(offset + 5),
        height: bytes.readUInt16BE(offset + 3),
        frames: 1
      };
    }
    offset += length;
  }
  assert(false, "media_decode_rejected", 422);
}

function webp(bytes) {
  if (bytes.length < 20 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") return null;
  const declared = bytes.readUInt32LE(4) + 8;
  assert(declared <= bytes.length && declared >= 20, "media_decode_rejected", 422);
  let offset = 12;
  while (offset + 8 <= declared) {
    const type = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const data = offset + 8;
    assert(data + size <= declared, "media_decode_rejected", 422);
    if (type === "VP8X") {
      assert(size >= 10, "media_decode_rejected", 422);
      const flags = bytes[data];
      return {
        mime: "image/webp",
        format: "webp",
        width: 1 + bytes[data + 4] + (bytes[data + 5] << 8) + (bytes[data + 6] << 16),
        height: 1 + bytes[data + 7] + (bytes[data + 8] << 8) + (bytes[data + 9] << 16),
        frames: flags & 0x02 ? 2 : 1
      };
    }
    if (type === "VP8 ") {
      assert(size >= 10, "media_decode_rejected", 422);
      return { mime: "image/webp", format: "webp", width: bytes.readUInt16LE(data + 6) & 0x3fff, height: bytes.readUInt16LE(data + 8) & 0x3fff, frames: 1 };
    }
    if (type === "VP8L") {
      assert(size >= 5 && bytes[data] === 0x2f, "media_decode_rejected", 422);
      const b1 = bytes[data + 1], b2 = bytes[data + 2], b3 = bytes[data + 3], b4 = bytes[data + 4];
      return { mime: "image/webp", format: "webp", width: 1 + b1 + ((b2 & 0x3f) << 8), height: 1 + (b2 >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10), frames: 1 };
    }
    offset = data + size + (size % 2);
  }
  assert(false, "media_decode_rejected", 422);
}

function heif(bytes) {
  if (bytes.length < 24 || bytes.toString("ascii", 4, 8) !== "ftyp") return null;
  const brands = bytes.subarray(8, Math.min(bytes.length, bytes.readUInt32BE(0))).toString("ascii");
  if (!/(heic|heix|hevc|hevx|mif1|msf1)/.test(brands)) return null;
  // heic/heix/mif1 are the HEIF "still image" structural brands; hevc/hevx/msf1
  // are the "image sequence" structural brands (burst captures, animated HEIC).
  // A conforming file always advertises one of these among its ftyp compatible
  // brands (ISO/IEC 23008-12), so this is a reliable multi-frame signal without
  // walking the full box tree.
  const sequence = /(hevc|hevx|msf1)/.test(brands);
  return { mime: /^hei[ctx]/.test(brands) ? "image/heic" : "image/heif", format: "heic_heif", frames: sequence ? 2 : 1 };
}

function assertDecoded(result, rejectCode) {
  if (["ENOENT", "EBUSY"].includes(result.error?.code)) throw new ApiError("media_decoder_unavailable", 503,
    { decoder: "ffmpeg_family" });
  const reason = result.error?.code === "ETIMEDOUT" ? "decoder_timeout" :
    result.signal ? "decoder_crash" : "decoder_failure";
  assert(!result.error && result.status === 0, rejectCode, 422, { reason });
}

function probeTags(probe) {
  return [...(probe.streams ?? []), ...(probe.frames ?? []), probe.format]
    .filter(Boolean).flatMap((entry) => Object.entries(entry.tags ?? {}));
}

function calendarDate(parts) {
  const [year, month, day, hour, minute, second] = parts.map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function zonedRfc3339(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !calendarDate(match.slice(1, 7))) return null;
  if (match[8] !== "Z") {
    const [, hours, minutes] = /^([+-])(\d{2}):(\d{2})$/.exec(match[8]);
    if (Number(hours) > 23 || Number(minutes) > 59) return null;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

export function capturedAtFromProbe(probe) {
  const tags = probeTags(probe);
  // ffprobe key names vary across versions/namespaces (e.g. "DateTimeOriginal" on
  // 6.1.1 vs "ExifIFD/DateTimeOriginal" on 9.x). Match on the last "/"-segment of
  // the key so a namespace prefix can't silently break tag lookup.
  const values = (names) => tags.filter(([key]) =>
    names.has(key.split("/").pop().replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase()))
    .map(([, value]) => String(value));
  const originals = values(new Set(["datetimeoriginal"]));
  if (originals.length > 0) {
    const offsets = values(new Set(["offsettimeoriginal", "0x9011"]));
    if (offsets.length === 0) return null;
    const candidates = [];
    for (const original of originals) {
      const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(original);
      if (!match || !calendarDate(match.slice(1, 7))) return null;
      for (const offset of offsets) {
        if (!/^[+-]\d{2}:\d{2}$/.test(offset)) return null;
        const normalized = zonedRfc3339(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${match[7] ? `.${match[7]}` : ""}${offset}`);
        if (!normalized) return null;
        candidates.push(normalized);
      }
    }
    return new Set(candidates).size === 1 ? candidates[0] : null;
  }
  const creationTimes = values(new Set(["creationtime"]));
  if (creationTimes.length === 0) return null;
  const candidates = creationTimes.map(zonedRfc3339);
  return candidates.every(Boolean) && new Set(candidates).size === 1 ? candidates[0] : null;
}

async function decode(bytes, runner, rejectCode) {
  const probe = await runner.probe(bytes);
  assertDecoded(probe, rejectCode);
  let probeData;
  try { probeData = JSON.parse(probe.stdout.toString("utf8")); } catch { /* rejected below */ }
  const stream = probeData?.streams?.[0];
  assert(stream && Number.isSafeInteger(Number(stream.width)) && Number.isSafeInteger(Number(stream.height)),
    rejectCode, 422);

  // framemd5 forces actual pixel decoding, which is our defense against bytes
  // that pass the structural container parse above but are corrupt or hostile
  // at the codec level. We only need one decoded frame for that: "is this an
  // animated image / multi-image sequence" is decided purely from container
  // structure before decode() is ever called (APNG acTL frame count, animated
  // WebP's VP8X ANIM flag, HEIF sequence brand) -- NOT from ffmpeg's own frame
  // count. ffmpeg picks the jpeg_pipe demuxer for piped JPEG input, and that
  // demuxer naively splits the byte stream on every embedded SOI marker. An
  // ordinary photo carrying an embedded EXIF thumbnail (itself a nested,
  // complete JPEG) gets miscounted as 2 frames as a result -- the same bytes
  // read from a file instead of a pipe don't have this problem. That miscount
  // used to be exactly what this function asserted on, silently rejecting
  // virtually every iPhone photo. Do not reintroduce a frame-count check here;
  // it must stay structural.
  const decoded = await runner.decode(bytes);
  assertDecoded(decoded, rejectCode);
  const rotation = Number(stream.tags?.rotate ?? stream.side_data_list?.find((entry) => entry.rotation != null)?.rotation ?? 0);
  const sideways = Math.abs(rotation) % 180 === 90;
  return { width: sideways ? Number(stream.height) : Number(stream.width),
    height: sideways ? Number(stream.width) : Number(stream.height), orientation: rotation,
    colorProfile: stream.color_primaries ?? stream.color_space ?? "unspecified",
    capturedAt: capturedAtFromProbe(probeData) };
}

export async function inspectMedia(input, { kind = "photo", declaredMime, declaredBytes,
  decoderRunner = new FfmpegDecoderRunner() } = {}) {
  const bytes = Buffer.from(input);
  const rejectCode = kind === "panorama" ? "panorama_decode_rejected" : "media_decode_rejected";
  const maxBytes = kind === "panorama" ? 32 * 1024 * 1024 : 20 * 1024 * 1024;
  assert(bytes.length > 0 && bytes.length <= maxBytes, "media_policy_invalid", 422);
  assert(declaredBytes === undefined || Number(declaredBytes) === bytes.length, "object_mismatch", 409);
  const parsed = png(bytes) ?? jpeg(bytes) ?? webp(bytes) ?? heif(bytes);
  assert(parsed, "media_decode_rejected", 422);
  // Animation/sequence rejection is decided here, structurally, before ffmpeg
  // ever sees the bytes -- see decode()'s comment for why ffmpeg's own frame
  // count can't be trusted for this.
  assert(parsed.frames === 1, rejectCode, 422, { reason: "animated_or_sequence" });
  const decoded = await decode(bytes, assertDecoderRunnerPort(decoderRunner), rejectCode);
  assert(parsed.width == null || parsed.width === decoded.width, rejectCode, 422);
  assert(parsed.height == null || parsed.height === decoded.height, rejectCode, 422);
  parsed.width = decoded.width;
  parsed.height = decoded.height;
  parsed.orientation = decoded.orientation;
  parsed.colorProfile = decoded.colorProfile;
  parsed.capturedAt = decoded.capturedAt;
  parsed.metadataPolicyResult = "private_original_not_projected";
  assert(parsed.width > 0 && parsed.height > 0 && parsed.width <= 8192 && parsed.height <= 8192, rejectCode, 422);
  assert(!declaredMime || declaredMime === parsed.mime, "object_mismatch", 409);
  if (kind === "panorama") {
    assert(parsed.width >= 1600 && parsed.height >= 800 && parsed.width === parsed.height * 2, "panorama_decode_rejected", 422);
  }
  return {
    ...parsed,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

export async function createViewerSafeDerivative(input, decoderRunner) {
  const runner = assertDecoderRunnerPort(decoderRunner);
  const result = await runner.deriveViewerSafe(Buffer.from(input));
  assertDecoded(result, "media_decode_rejected");
  const body = Buffer.from(result.stdout);
  const parsed = jpeg(body);
  assert(body.length > 0 && body.length <= 4 * 1024 * 1024 && parsed &&
    parsed.width <= 1920 && parsed.height <= 1920,
    "media_decode_rejected", 422);
  return { body, mime: "image/jpeg", bytes: body.length, width: parsed.width, height: parsed.height,
    sha256: createHash("sha256").update(body).digest("hex"), metadataPolicyResult: "exif_gps_stripped" };
}
