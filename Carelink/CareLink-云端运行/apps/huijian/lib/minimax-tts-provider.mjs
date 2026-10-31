import { readBoundedJson } from "./bounded-response.mjs";

const T2A_PATH = "/v1/t2a_v2";

export const MINIMAX_TTS_DEFAULTS = Object.freeze({
  baseUrl: "https://api.minimax.cn",
  model: "speech-2.8-hd",
  voiceId: "Chinese (Mandarin)_Gentle_Youth",
  format: "mp3",
  sampleRate: 32_000,
  bitrate: 128_000,
  channel: 1,
  maximumTextCharacters: 500,
  maximumAudioBytes: 5 * 1024 * 1024,
  requestTimeoutMs: 25_000
});

export class MiniMaxTtsError extends Error {
  constructor(code, { cause, status } = {}) {
    super(code);
    this.name = "MiniMaxTtsError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
    if (status !== undefined) this.status = status;
  }
}

function fail(code, options) {
  throw new MiniMaxTtsError(code, options);
}

function validatedText(value, maximum) {
  if (typeof value !== "string") fail("tts_text_invalid");
  const text = value.trim();
  if (!text) fail("tts_text_invalid");
  if (text.length > maximum) fail("tts_text_too_long");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) fail("tts_text_invalid");
  return text;
}

function upstreamErrorCode(statusCode) {
  if ([1001].includes(statusCode)) return "tts_timeout";
  if ([1002, 1039, 2045].includes(statusCode)) return "tts_rate_limited";
  if ([1004, 2049].includes(statusCode)) return "tts_auth_failed";
  return "tts_upstream_rejected";
}

function httpErrorCode(status) {
  if (status === 408 || status === 504) return "tts_timeout";
  if (status === 429) return "tts_rate_limited";
  if (status === 401 || status === 403) return "tts_auth_failed";
  return "tts_upstream_http";
}

export function createMiniMaxTtsProvider({
  apiKey,
  fetchImpl = globalThis.fetch,
  baseUrl = MINIMAX_TTS_DEFAULTS.baseUrl,
  model = MINIMAX_TTS_DEFAULTS.model,
  voiceId = MINIMAX_TTS_DEFAULTS.voiceId,
  maximumTextCharacters = MINIMAX_TTS_DEFAULTS.maximumTextCharacters,
  maximumAudioBytes = MINIMAX_TTS_DEFAULTS.maximumAudioBytes,
  requestTimeoutMs = MINIMAX_TTS_DEFAULTS.requestTimeoutMs
} = {}) {
  const endpoint = `${String(baseUrl).replace(/\/$/u, "")}${T2A_PATH}`;

  return async function synthesize({ text: rawText, signal } = {}) {
    if (typeof apiKey !== "string" || !apiKey.trim()) fail("tts_not_configured");
    if (typeof fetchImpl !== "function") fail("tts_provider_unavailable");
    const text = validatedText(rawText, maximumTextCharacters);
    if (signal?.aborted) fail("tts_aborted");

    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(signal.reason);
    signal?.addEventListener?.("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("tts_timeout"));
    }, requestTimeoutMs);

    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          text,
          stream: false,
          voice_setting: { voice_id: voiceId, speed: 1, vol: 1, pitch: 0 },
          audio_setting: {
            sample_rate: MINIMAX_TTS_DEFAULTS.sampleRate,
            bitrate: MINIMAX_TTS_DEFAULTS.bitrate,
            format: MINIMAX_TTS_DEFAULTS.format,
            channel: MINIMAX_TTS_DEFAULTS.channel
          },
          language_boost: "Chinese",
          subtitle_enable: false
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        fail(httpErrorCode(response.status), { status: response.status });
      }
      let payload;
      try {
        // Audio arrives hex encoded; allow a bounded envelope in addition to the maximum audio.
        payload = await readBoundedJson(response, maximumAudioBytes * 2 + 64 * 1024, {
          signal: controller.signal,
          onTooLarge: () => controller.abort()
        });
      } catch (cause) {
        if (cause?.code === "response_too_large") fail("tts_audio_too_large", { cause });
        if (timedOut || signal?.aborted || controller.signal.aborted) throw cause;
        fail("tts_invalid_response", { cause });
      }
      const providerStatus = Number(payload?.base_resp?.status_code);
      if (!Number.isFinite(providerStatus)) fail("tts_invalid_response");
      if (providerStatus !== 0) fail(upstreamErrorCode(providerStatus));
      if (payload?.data?.status !== 2) fail("tts_invalid_response");
      const audioHex = payload?.data?.audio;
      if (typeof audioHex !== "string" || !audioHex || audioHex.length % 2 !== 0 || !/^[0-9a-f]+$/iu.test(audioHex)) {
        fail("tts_invalid_response");
      }
      if (audioHex.length / 2 > maximumAudioBytes) fail("tts_audio_too_large");
      return {
        audio: Buffer.from(audioHex, "hex"),
        mimeType: "audio/mpeg",
        model,
        voiceId
      };
    } catch (cause) {
      if (cause instanceof MiniMaxTtsError) throw cause;
      if (timedOut) fail("tts_timeout", { cause });
      if (signal?.aborted || controller.signal.aborted) fail("tts_aborted", { cause });
      fail("tts_provider_unavailable", { cause });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    }
  };
}
