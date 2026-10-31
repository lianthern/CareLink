import { assert } from "./errors.mjs";
import { PersonalMemoryService } from "./personal-memory-service.mjs";
import { inspectMedia, createViewerSafeDerivative } from "./media.mjs";
import { sha256 } from "./util.mjs";

export const MOMENT_MEDIA_LIMIT = 12 * 1024 * 1024;
const DOCUMENT_LIMIT = 8 * 1024 * 1024;
export const validMomentId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,96}$/.test(value);
const recordId = id => `moment:${id}`;
const mediaRecordId = id => `moment-media:${id}`;
const urlFor = id => `/v1/moment-media/${id}`;
const object = value => value && typeof value === "object" && !Array.isArray(value);
const validDate = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const audioTypes = new Set(["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-wav"]);
const photoTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "image/gif", "image/avif"]);
export function plausibleMedia(bytes, mimeType) {
  const ascii = bytes.subarray(0, 40).toString("latin1");
  if (mimeType === "image/jpeg") return bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mimeType === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (mimeType === "image/webp") return ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP";
  if (mimeType === "image/gif") return /^GIF8[79]a/.test(ascii);
  if (["image/heic", "image/heif", "image/avif"].includes(mimeType)) return ascii.slice(4, 8) === "ftyp" &&
    (mimeType === "image/avif" ? /avif|avis/.test(ascii.slice(8)) : /heic|heix|hevc|hevx|mif1|msf1/.test(ascii.slice(8)));
  if (mimeType === "audio/webm") return bytes.subarray(0, 4).equals(Buffer.from([26,69,223,163]));
  if (mimeType === "audio/ogg") return ascii.startsWith("OggS");
  if (mimeType === "audio/mp4") return ascii.slice(4, 8) === "ftyp";
  if (mimeType === "audio/mpeg") return ascii.startsWith("ID3") || bytes[0] === 255 && (bytes[1] & 224) === 224;
  return ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WAVE";
}

// Uses the same encrypted record table, quotas, key rotation and account lifecycle
// as private snapshots. Media is a separate immutable record; raw conversations
// never enter public spaces, provider logs, or idempotency response caches.
export class MomentService {
  constructor(core, decoderRunner) {
    this.core = core; this.decoderRunner = decoderRunner;
    this.records = new PersonalMemoryService(core, { recordKind: "moment" });
    this.media = new PersonalMemoryService(core, { recordKind: "moment-media" });
  }
  mediaDocument(account, id) {
    assert(validMomentId(id), "moment_media_invalid");
    const row = this.media.row(account, mediaRecordId(id));
    assert(row && !row.deleted_at, "moment_media_unavailable", 404);
    return this.media.get(account, row.id).document;
  }
  mediaDto(document) {
    return { id: document.id, mediaId: document.id, url: urlFor(document.id), kind: document.kind,
      mimeType: document.mimeType, name: document.name, byteLength: document.byteLength,
      ...(document.preview ? { previewUrl: `${urlFor(document.id)}/preview`,
        width: document.preview.width, height: document.preview.height } : {}) };
  }
  async uploadMedia(ctx, account, id) {
    this.media.requireExpectedAccount(ctx, account);
    assert(validMomentId(id), "moment_media_invalid");
    const b = ctx.body;
    assert(object(b) && ["photo", "audio"].includes(b.kind), "moment_media_invalid");
    assert(typeof b.mimeType === "string" && b.mimeType.length < 100, "moment_media_invalid");
    const mimeType = b.mimeType.split(";")[0].trim().toLowerCase();
    assert((b.kind === "photo" ? photoTypes : audioTypes).has(mimeType), "moment_media_type_unsupported", 415);
    assert(typeof b.name === "string" && b.name.length <= 240, "moment_media_invalid");
    assert(typeof b.dataBase64 === "string" && b.dataBase64.length <= Math.ceil(MOMENT_MEDIA_LIMIT / 3) * 4,
      "moment_media_too_large", 413);
    const bytes = Buffer.from(b.dataBase64, "base64");
    assert(bytes.length > 0 && bytes.length <= MOMENT_MEDIA_LIMIT && bytes.toString("base64") === b.dataBase64,
      "moment_media_invalid");
    assert(plausibleMedia(bytes, mimeType), "moment_media_type_mismatch", 415);
    const digest = sha256(bytes);
    const old = this.media.row(account, mediaRecordId(id));
    if (old) {
      const existing = this.mediaDocument(account, id);
      assert(existing.sha256 === digest && existing.mimeType === mimeType && existing.kind === b.kind &&
        existing.name === b.name && Boolean(existing.preview) === Boolean(b.createPreview), "moment_media_conflict", 409);
      // A network retry can reuse the same media ID even if the browser lost its
      // previous idempotency key. The bytes are immutable and never duplicated.
      this.core.mutation({ ...ctx, ifMatch: "0", body: { consent: true, document: existing } },
        { endpoint: urlFor(id), method: "PUT", scope: account.accountId }, () => ({ id }));
      return { media: this.mediaDto(existing) };
    }
    const document = { id, kind: b.kind, name: b.name, mimeType, byteLength: bytes.length,
      dataBase64: b.dataBase64, sha256: digest };
    if (b.createPreview === true) {
      assert(b.kind === "photo", "moment_media_invalid");
      await inspectMedia(bytes, { decoderRunner: this.decoderRunner });
      const preview = await createViewerSafeDerivative(bytes, this.decoderRunner);
      document.preview = { dataBase64: preview.body.toString("base64"), mimeType: preview.mime,
        width: preview.width, height: preview.height };
    }
    // Decode happens outside a SQLite transaction. Re-check the session before
    // committing in case logout/password change happened during the decode.
    this.core.account(ctx.accountSession);
    this.media.save({ ...ctx, ifMatch: "0", body: { consent: true, document } }, account, mediaRecordId(id),
      { endpoint: urlFor(id), method: "PUT" });
    return { media: this.mediaDto(document) };
  }
  getMedia(account, id, preview = false, range) {
    const document = this.mediaDocument(account, id);
    const selected = preview ? document.preview : document;
    assert(selected, "moment_media_unavailable", 404);
    let body = Buffer.from(selected.dataBase64, "base64");
    const size = body.length, headers = { "accept-ranges": "bytes" };
    if (range) {
      const match = typeof range === "string" && range.match(/^bytes=(\d*)-(\d*)$/);
      assert(match && (match[1] || match[2]), "media_range_invalid", 416);
      const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      assert(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end && start < size,
        "media_range_invalid", 416);
      headers["content-range"] = `bytes ${start}-${end}/${size}`;
      body = body.subarray(start, end + 1);
    }
    return { _raw: body, status: range ? 206 : 200, headers: { ...headers, "content-type": selected.mimeType, "content-length": String(body.length),
      "cache-control": "no-store, private", "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin", "content-security-policy": "default-src 'none'; sandbox" } };
  }
  validateMoment(account, id, input) {
    assert(validMomentId(id) && object(input) && input.id === id, "moment_invalid");
    assert(Buffer.byteLength(JSON.stringify(input)) <= DOCUMENT_LIMIT, "moment_too_large", 413);
    const moment = structuredClone(input);
    assert(typeof moment.title === "string" && moment.title.length <= 500 && ["active", "complete"].includes(moment.status), "moment_invalid");
    assert(validDate(moment.createdAt) && validDate(moment.updatedAt), "moment_invalid");
    assert(moment.archivedAt === undefined || moment.archivedAt === null ||
      typeof moment.archivedAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(moment.archivedAt) && validDate(moment.archivedAt), "moment_archive_invalid");
    assert(Array.isArray(moment.photos) && Array.isArray(moment.messages), "moment_invalid");
    const media = new Map();
    const owned = (mediaId, kind) => {
      if (!media.has(mediaId)) media.set(mediaId, this.mediaDocument(account, mediaId));
      const document = media.get(mediaId);
      assert(document.kind === kind, "moment_media_invalid");
      return document;
    };
    const photoIds = new Set();
    for (const photo of moment.photos) {
      assert(object(photo) && validMomentId(photo.id) && !photoIds.has(photo.id), "moment_photo_invalid");
      photoIds.add(photo.id);
      const document = owned(photo.mediaId, "photo");
      photo.url = photo.url === `${urlFor(photo.mediaId)}/preview` && document.preview ? photo.url : urlFor(photo.mediaId);
      if (photo.originalMediaId) { owned(photo.originalMediaId, "photo"); photo.originalUrl = urlFor(photo.originalMediaId); }
      assert(photo.name === undefined || typeof photo.name === "string" && photo.name.length <= 240, "moment_photo_invalid");
    }
    const messageIds = new Set();
    for (const message of moment.messages) {
      assert(object(message) && validMomentId(message.id) && !messageIds.has(message.id) &&
        ["user", "assistant"].includes(message.role), "moment_message_invalid");
      messageIds.add(message.id);
      assert(typeof message.text === "string" && validDate(message.createdAt), "moment_message_invalid");
      assert(!message.photoId || photoIds.has(message.photoId), "moment_photo_invalid");
      if (message.audio) {
        const audio = message.audio;
        assert(object(audio), "moment_audio_invalid");
        owned(audio.mediaId, "audio"); audio.url = urlFor(audio.mediaId);
        assert(Number.isFinite(audio.duration) && audio.duration >= 0 && audio.duration <= 3600,
          "moment_audio_invalid");
        assert(Array.isArray(audio.waveform) && audio.waveform.length <= 4096 &&
          audio.waveform.every(value => Number.isFinite(value) && value >= 0 && value <= 1), "moment_audio_invalid");
      }
    }
    assert(!moment.preferences || object(moment.preferences) && ["reveal", "clear"].includes(moment.preferences.photoMode) &&
      ["readReplies", "continuous"].every(key => moment.preferences[key] === undefined || typeof moment.preferences[key] === "boolean"),
      "moment_preferences_invalid");
    assert(moment.context === undefined || object(moment.context), "moment_context_invalid");
    return moment;
  }
  get(account, id) {
    assert(validMomentId(id), "moment_invalid");
    const row = this.records.row(account, recordId(id));
    assert(row && !row.deleted_at, "moment_unavailable", 404);
    const result = this.records.get(account, recordId(id));
    return { moment: result.document, version: result.version, accountId: account.accountId };
  }
  list(account) {
    const moments = [];
    for (const row of this.core.db.prepare(`SELECT id FROM personal_memories
      WHERE account_id=? AND record_kind='moment' AND deleted_at IS NULL ORDER BY updated_at DESC,id`).iterate(account.accountId)) {
      const result = this.records.get(account, row.id), moment = result.document;
      moments.push({ id: moment.id, title: moment.title, createdAt: moment.createdAt, updatedAt: moment.updatedAt,
        status: moment.status, archivedAt: moment.archivedAt ?? null, version: result.version, photoCount: moment.photos.length, messageCount: moment.messages.length,
        coverPhotoUrl: moment.photos[0]?.url ?? null });
    }
    return { moments, accountId: account.accountId };
  }
  save(ctx, account, id) {
    this.records.requireExpectedAccount(ctx, account);
    assert(Number.isSafeInteger(ctx.body?.expectedVersion) && ctx.body.expectedVersion >= 0, "version_conflict", 409);
    const moment = this.validateMoment(account, id, ctx.body.moment);
    const result = this.records.save({ ...ctx, ifMatch: String(ctx.body.expectedVersion),
      body: { consent: true, document: moment } }, account, recordId(id), { endpoint: `/v1/moments/${id}`, method: "PUT" });
    return { ...this.get(account, id), ...(result.replayed ? { replayed: true } : {}) };
  }
}
