const KNOWN_ERRORS = new Set([
  "aborted",
  "audio-capture",
  "network",
  "no-speech",
  "not-allowed",
  "service-not-allowed"
]);

function appendTranscript(existing, addition) {
  const left = existing.trim();
  const right = addition.trim();
  if (!left) return right;
  if (!right) return left;
  return `${left}${/[，。！？；：,.!?;:]$/u.test(left) ? "" : "，"}${right}`;
}

function mergeTranscriptIntoEditableText(existing, transcript) {
  const original = typeof existing === "string" ? existing : "";
  const spoken = typeof transcript === "string" ? transcript.trim() : "";
  if (!spoken) return original;
  if (!original) return spoken;
  if (/\s$/u.test(original) || /[，。！？；：,.!?;:]$/u.test(original)) {
    return `${original}${spoken}`;
  }
  return `${original}，${spoken}`;
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Reads a short-lived microphone stream as an RMS envelope. Audio samples never
 * leave memory: there is no recorder, blob, upload, or persistent storage.
 */
export function createVoiceStrengthMeter({
  onLevel = () => {},
  mediaDevices = globalThis.navigator?.mediaDevices,
  AudioContext = globalThis.AudioContext ?? globalThis.webkitAudioContext,
  requestFrame = globalThis.requestAnimationFrame?.bind(globalThis),
  cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis)
} = {}) {
  let active = false;
  let stream = null;
  let context = null;
  let analyser = null;
  let samples = null;
  let frame = 0;
  let envelope = 0;

  const schedule = (callback) => requestFrame
    ? requestFrame(callback)
    : globalThis.setTimeout?.(callback, 32);
  const cancel = (handle) => {
    if (!handle) return;
    if (cancelFrame) cancelFrame(handle);
    else globalThis.clearTimeout?.(handle);
  };

  function tick() {
    if (!active || !analyser || !samples) return;
    analyser.getByteTimeDomainData(samples);
    let energy = 0;
    for (const value of samples) {
      const normalized = (value - 128) / 128;
      energy += normalized * normalized;
    }
    const rms = Math.sqrt(energy / Math.max(1, samples.length));
    const target = clamp((rms - .014) * 9.5);
    const rate = target > envelope ? .34 : .075;
    envelope += (target - envelope) * rate;
    onLevel(clamp(envelope));
    frame = schedule(tick);
  }

  async function start() {
    if (active || !mediaDevices?.getUserMedia || typeof AudioContext !== "function") return false;
    active = true;
    try {
      const nextStream = await mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
      if (!active) {
        for (const track of nextStream.getTracks?.() ?? []) track.stop();
        return false;
      }
      stream = nextStream;
      context = new AudioContext();
      if (context.state === "suspended") await context.resume?.();
      analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = .58;
      samples = new Uint8Array(analyser.fftSize);
      context.createMediaStreamSource(stream).connect(analyser);
      tick();
      return true;
    } catch {
      stop();
      return false;
    }
  }

  function stop() {
    active = false;
    cancel(frame);
    frame = 0;
    for (const track of stream?.getTracks?.() ?? []) track.stop();
    stream = null;
    analyser = null;
    samples = null;
    envelope = 0;
    if (context?.state !== "closed") context?.close?.().catch?.(() => {});
    context = null;
    onLevel(0);
  }

  return { start, stop, isActive: () => active };
}

/**
 * A small, injectable wrapper around the browser SpeechRecognition API.
 * It exposes text plus a transient volume envelope; no audio blobs are created
 * or retained by 回见.
 */
export function createVoiceInput({
  Recognition,
  lang = "zh-CN",
  continuous = false,
  onTranscript = () => {},
  onComplete = () => {},
  onState = () => {},
  onError = () => {},
  onAudioLevel = () => {},
  createMeter = createVoiceStrengthMeter
} = {}) {
  let recognition = null;
  let meter = null;
  let phase = "idle";

  function emitState(name) {
    phase = name;
    onState(name);
  }

  function detach(instance) {
    instance.onresult = null;
    instance.onerror = null;
    instance.onend = null;
  }

  function stopMeter() {
    meter?.stop?.();
    meter = null;
    onAudioLevel(0);
  }

  function finish(instance, completed = false) {
    if (recognition !== instance) return;
    detach(instance);
    recognition = null;
    stopMeter();
    if (completed) emitState("complete");
    emitState("idle");
  }

  function start() {
    if (recognition) return false;
    if (typeof Recognition !== "function") {
      onError("unsupported");
      return false;
    }

    let receivedSpeech = false;
    let sawError = false;
    let completedTranscript = "";
    const segments = new Map();
    let instance;
    try {
      instance = new Recognition();
      instance.lang = lang;
      instance.continuous = Boolean(continuous);
      instance.interimResults = true;
      instance.maxAlternatives = 1;
    } catch {
      onError("start-failed");
      return false;
    }
    recognition = instance;

    instance.onresult = (event) => {
      if (recognition !== instance) return;
      const results = event?.results;
      if (!results || typeof results.length !== "number") return;
      const resultIndex = Math.max(0, Math.trunc(Number(event.resultIndex) || 0));
      for (const index of [...segments.keys()]) {
        if (index >= resultIndex) segments.delete(index);
      }
      for (let index = resultIndex; index < results.length; index += 1) {
        const result = results[index];
        const text = result?.[0]?.transcript?.trim() ?? "";
        if (!text) continue;
        receivedSpeech = true;
        segments.set(index, { text, isFinal: Boolean(result.isFinal) });
      }
      let finalTranscript = "";
      let interimTranscript = "";
      for (const segment of segments.values()) {
        if (segment.isFinal) finalTranscript = appendTranscript(finalTranscript, segment.text);
        else interimTranscript = appendTranscript(interimTranscript, segment.text);
      }
      completedTranscript = finalTranscript;
      onTranscript({ final: finalTranscript, interim: interimTranscript });
    };

    instance.onerror = (event) => {
      if (recognition !== instance) return;
      sawError = true;
      const code = KNOWN_ERRORS.has(event?.error) ? event.error : "unknown";
      onError(code);
      finish(instance);
    };

    instance.onend = () => {
      if (recognition !== instance) return;
      if ((!receivedSpeech || !completedTranscript) && !sawError) {
        onError("no-speech");
        finish(instance);
        return;
      }
      if (!sawError) onComplete(completedTranscript);
      finish(instance, Boolean(completedTranscript) && !sawError);
    };

    try {
      emitState("listening");
      instance.start();
      try {
        meter = createMeter?.({ onLevel: onAudioLevel }) ?? null;
        Promise.resolve(meter?.start?.()).catch(() => stopMeter());
      } catch {
        stopMeter();
      }
      return true;
    } catch {
      onError("start-failed");
      finish(instance);
      return false;
    }
  }

  function stop() {
    if (phase !== "listening" || !recognition) return false;
    const instance = recognition;
    emitState("processing");
    try {
      instance.stop();
      stopMeter();
      return true;
    } catch {
      onError("unknown");
      finish(instance);
      return false;
    }
  }

  function cancel() {
    if (!recognition) return false;
    const instance = recognition;
    recognition = null;
    detach(instance);
    stopMeter();
    try {
      instance.abort();
    } catch {
      // Some engines throw when abort races with their own onend event.
    }
    emitState("idle");
    return true;
  }

  return {
    start,
    stop,
    cancel,
    isActive: () => phase === "listening",
    isBusy: () => phase !== "idle",
    isSupported: () => typeof Recognition === "function"
  };
}

export { appendTranscript, mergeTranscriptIntoEditableText };
