const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, Number(value) || 0));
const MIME_TYPES = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"];

function joinSpeech(parts) {
  return parts.filter(Boolean).reduce((text, next) => `${text}${/[a-z\d]$/iu.test(text) && /^[a-z\d]/iu.test(next) ? " " : ""}${next}`, "");
}

/** A real input envelope, also used as a conservative silence gate (not ASR). */
export function createSpeechGate({ silenceMs = 1800, minSpeechMs = 220 } = {}) {
  let noise = .005;
  let previousTime = null;
  let voicedMs = 0;
  let lastVoiceAt = 0;
  let hasSpeech = false;
  return {
    sample(rms, now) {
      const delta = previousTime === null ? 0 : clamp(now - previousTime, 0, 100);
      previousTime = now;
      const threshold = Math.max(.015, Math.min(.065, noise * 2.8));
      const audible = rms >= threshold;
      if (audible) {
        voicedMs += delta;
        lastVoiceAt = now;
        if (voicedMs >= minSpeechMs) hasSpeech = true;
      } else {
        if (!hasSpeech) voicedMs = 0;
        if (rms < threshold * .8) noise += (rms - noise) * .035;
      }
      return { hasSpeech, audible, shouldFinish: hasSpeech && now - lastVoiceAt >= silenceMs };
    },
    recognize(now) { hasSpeech = true; lastVoiceAt = now; },
    hasSpeech: () => hasSpeech
  };
}

export function compactWaveform(levels, count = 48) {
  if (!levels.length) return Array(count).fill(0);
  return Array.from({ length: count }, (_, index) => {
    const start = Math.floor(index * levels.length / count);
    const end = Math.max(start + 1, Math.floor((index + 1) * levels.length / count));
    let peak = 0;
    for (let sample = start; sample < end; sample += 1) peak = Math.max(peak, levels[sample] ?? 0);
    return Math.round(clamp(peak) * 1000) / 1000;
  });
}

/**
 * Audio is the primary result; browser recognition is an optional transcript.
 * `onComplete` owns the returned Blob (create/revoke playback URLs in the view).
 * `interrupted` completions should be kept as a draft, not silently submitted.
 */
export function createMomentVoice({
  onState = () => {}, onLevel = () => {}, onComplete = () => {}, onError = () => {},
  lang = "zh-CN", silenceMs = 1800, maxDurationMs = 120_000, noSpeechMs = 15_000,
  transcriptDrainMs = 1600, recorderDrainMs = 2500, permissionWaitMs = 20_000,
  getMaxDurationMs = () => maxDurationMs,
  mediaDevices = globalThis.navigator?.mediaDevices,
  MediaRecorder: Recorder = globalThis.MediaRecorder,
  AudioContext: Context = globalThis.AudioContext ?? globalThis.webkitAudioContext,
  Recognition = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition,
  document: page = globalThis.document,
  window: windowTarget = globalThis.window,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  setTimeout: schedule = globalThis.setTimeout?.bind(globalThis),
  clearTimeout: unschedule = globalThis.clearTimeout?.bind(globalThis)
} = {}) {
  let current = null;
  let sharedContext = null;
  let destroyed = false;
  let phase = "idle";
  const supported = () => Boolean(mediaDevices?.getUserMedia && typeof Recorder === "function" && typeof Context === "function");
  const elapsed = (session) => session?.startedAt == null ? 0 : Math.max(0, (session.endedAt ?? now()) - session.startedAt);
  const state = () => ({ phase, elapsedMs: elapsed(current) });
  const active = (session) => current === session && !session.cancelled;

  function emit(nextPhase, session = current, reason) {
    phase = nextPhase;
    onState({ phase, elapsedMs: elapsed(session), ...(reason ? { reason } : {}) });
  }

  function report(code, recoverable = false) {
    const messages = {
      unsupported: "这个浏览器暂时不能录音，请换一个浏览器或使用文字。",
      permission: "需要允许使用麦克风，才能开始说话。",
      "permission-timeout": "还没获得麦克风权限。可以重试，或先用文字继续。",
      "microphone-unavailable": "麦克风暂时无法使用，请检查后重试。",
      "no-speech": "还没有听到声音，再说一次吧。",
      "recording-failed": "这段录音没有录好，请再试一次。",
      "transcription-unavailable": "原声会保留，暂时无法识别文字。"
    };
    onError({ code, message: messages[code] ?? messages["recording-failed"], recoverable });
  }

  function clearTimer(session, name) {
    if (session[name] != null) unschedule(session[name]);
    session[name] = null;
  }

  function releaseInput(session) {
    clearTimer(session, "sampleTimer");
    for (const track of session.stream?.getTracks?.() ?? []) {
      track.removeEventListener?.("ended", session.trackEnded);
      track.stop();
    }
    session.stream = null;
    session.source?.disconnect?.();
    session.source = null;
    if (session.context) {
      session.context.onstatechange = null;
      // Retain the context unlocked by the first tap for subsequent voice turns.
      // The stream itself is stopped above, so the idle microphone is released.
    }
    session.context = null;
    session.analyser = null;
    onLevel(0);
  }

  function detachRecognition(session, abort = false) {
    clearTimer(session, "recognitionRestart");
    const recognition = session.recognition;
    session.recognition = null;
    if (!recognition) return;
    recognition.onresult = recognition.onerror = recognition.onend = null;
    if (abort) { try { recognition.abort(); } catch { /* already ended */ } }
  }

  function transcript(session) {
    return joinSpeech([...session.transcriptParts, ...[...session.segments.values()].map((part) => part.text)]).trim();
  }

  function startRecognition(session) {
    if (!active(session) || phase !== "recording" || typeof Recognition !== "function" || session.recognitionUnavailable) return;
    let recognition;
    try {
      recognition = new Recognition();
      recognition.lang = lang;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      session.recognition = recognition;
      session.segments.clear();
      recognition.onresult = (event) => {
        if (!active(session) || session.recognition !== recognition) return;
        const results = event?.results;
        if (!results) return;
        const start = Math.max(0, Number(event.resultIndex) || 0);
        for (const index of [...session.segments.keys()]) if (index >= start) session.segments.delete(index);
        for (let index = start; index < results.length; index += 1) {
          const text = results[index]?.[0]?.transcript?.trim();
          if (text) session.segments.set(index, { text, final: Boolean(results[index].isFinal) });
        }
        if (session.segments.size) session.gate.recognize(now());
      };
      recognition.onerror = (event) => {
        if (!active(session) || session.recognition !== recognition) return;
        if (event?.error === "no-speech" || event?.error === "aborted") return;
        session.recognitionUnavailable = true;
        if (!session.recognitionWarning) {
          session.recognitionWarning = true;
          report("transcription-unavailable", true);
        }
      };
      recognition.onend = () => {
        if (!active(session) || session.recognition !== recognition) return;
        const part = joinSpeech([...session.segments.values()].map((segment) => segment.text));
        if (part) session.transcriptParts.push(part);
        session.segments.clear();
        detachRecognition(session);
        session.resolveRecognition?.();
        if (phase === "recording" && !session.recognitionUnavailable) {
          session.recognitionRestart = schedule(() => startRecognition(session), 160);
        }
      };
      recognition.start();
    } catch {
      detachRecognition(session, true);
      session.recognitionUnavailable = true;
      // A browser transcript is optional: the Blob can be sent to any ASR API.
    }
  }

  function sample(session) {
    if (!active(session) || phase !== "recording" || !session.analyser) return;
    try { session.analyser.getByteTimeDomainData(session.samples); }
    catch { report("recording-failed"); cancel("error"); return; }
    let energy = 0;
    for (const value of session.samples) energy += ((value - 128) / 128) ** 2;
    const rms = Math.sqrt(energy / session.samples.length);
    const level = clamp((rms - .005) * 8);
    session.envelope += (level - session.envelope) * (level > session.envelope ? .6 : .24);
    session.levels.push(level);
    onLevel(clamp(session.envelope));
    const time = now();
    const gate = session.gate.sample(rms, time);
    if (gate.shouldFinish) { void finish("silence"); return; }
    if (elapsed(session) >= session.durationLimitMs) { void finish("limit"); return; }
    if (!gate.hasSpeech && elapsed(session) >= noSpeechMs) { report("no-speech"); cancel("no-speech"); return; }
    onState({ phase: "recording", elapsedMs: elapsed(session) });
    session.sampleTimer = schedule(() => sample(session), 50);
  }

  async function start() {
    if (destroyed || current) return false;
    if (!supported()) { report("unsupported"); return false; }
    const session = {
      startedAt: null, endedAt: null, cancelled: false, chunks: [], levels: [], envelope: 0,
      segments: new Map(), transcriptParts: [], gate: createSpeechGate({ silenceMs }),
      recorderStopped: false, recorderError: false
    };
    current = session;
    emit("requesting", session);
    try {
      // Construct/resume during the initiating tap, before the permission await.
      sharedContext = sharedContext?.state !== "closed" && sharedContext ? sharedContext : new Context();
      session.context = sharedContext;
      const resumed = Promise.resolve(session.context.resume?.()).catch(() => {});
      const permission = Promise.resolve(mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false
      })).then(stream => {
        // getUserMedia has no browser-independent abort API. Keep observing the
        // native request after our caller has cancelled, solely to close it.
        if (!active(session)) { for (const track of stream.getTracks?.() ?? []) track.stop(); return null; }
        return stream;
      });
      const cancelled = new Promise(resolve => { session.resolvePermission = () => resolve(null); });
      session.permissionTimer = schedule(() => {
        if (!active(session) || phase !== "requesting") return;
        report("permission-timeout");
        cancel("permission-timeout");
      }, clamp(permissionWaitMs, 1000, 60_000));
      const stream = await Promise.race([permission, cancelled]);
      clearTimer(session, "permissionTimer");
      session.resolvePermission = null;
      if (!stream) return false;
      if (!active(session)) { for (const track of stream.getTracks?.() ?? []) track.stop(); return false; }
      session.stream = stream;
      await Promise.race([resumed, new Promise((resolve) => { session.resolveResume = resolve; session.resumeTimer = schedule(resolve, 1500); })]);
      clearTimer(session, "resumeTimer");
      if (!active(session)) return false;
      if (session.context.state === "suspended") throw new Error("microphone_context_suspended");
      session.analyser = session.context.createAnalyser();
      session.analyser.fftSize = 1024;
      session.samples = new Uint8Array(session.analyser.fftSize);
      session.source = session.context.createMediaStreamSource(stream);
      session.source.connect(session.analyser);
      const mimeType = MIME_TYPES.find((type) => Recorder.isTypeSupported?.(type));
      session.recorder = new Recorder(stream, mimeType ? { mimeType } : undefined);
      session.recorder.ondataavailable = (event) => {
        if (active(session) && event.data?.size) session.chunks.push(event.data);
      };
      session.recorder.onstop = () => {
        if (!active(session)) return;
        session.recorderStopped = true;
        session.resolveRecorder?.();
        if (phase === "recording") void finish("interrupted");
      };
      session.recorder.onerror = () => {
        if (!active(session)) return;
        session.recorderError = true;
        session.resolveRecorder?.();
        report("recording-failed");
        cancel("error");
      };
      session.trackEnded = () => { if (active(session) && phase === "recording") void finish("interrupted"); };
      for (const track of stream.getTracks?.() ?? []) track.addEventListener?.("ended", session.trackEnded);
      session.context.onstatechange = () => {
        if (active(session) && phase === "recording" && ["interrupted", "suspended", "closed"].includes(session.context?.state)) void finish("interrupted");
      };
      const configuredDuration = Number(getMaxDurationMs());
      session.durationLimitMs = clamp(Number.isFinite(configuredDuration) && configuredDuration > 0 ? configuredDuration : maxDurationMs, 1000, 180_000);
      session.recorder.start(250);
      session.startedAt = now();
      emit("recording", session);
      startRecognition(session);
      sample(session);
      return true;
    } catch (error) {
      if (!active(session)) return false;
      report(["NotAllowedError", "SecurityError"].includes(error?.name) ? "permission" : "microphone-unavailable");
      cancel("error");
      return false;
    }
  }

  function finish(reason = "manual") {
    const session = current;
    if (!session || destroyed) return Promise.resolve(false);
    if (session.finishPromise) return session.finishPromise;
    if (phase === "requesting") { cancel(); return Promise.resolve(false); }
    session.endedAt = now();
    emit("processing", session, reason);
    clearTimer(session, "sampleTimer");
    clearTimer(session, "recognitionRestart");
    session.finishPromise = (async () => {
      const recordingDone = new Promise((resolve) => {
        session.resolveRecorder = resolve;
        if (session.recorderStopped) { resolve(); return; }
        session.recorderDrain = schedule(resolve, recorderDrainMs);
        try {
          if (session.recorder?.state !== "inactive") session.recorder.stop();
          else if (!session.recorder) resolve();
        } catch { session.recorderError = true; resolve(); }
      });
      const recognitionDone = new Promise((resolve) => {
        session.resolveRecognition = resolve;
        if (!session.recognition) { resolve(); return; }
        session.recognitionDrain = schedule(resolve, transcriptDrainMs);
        try { session.recognition.stop(); } catch { resolve(); }
      });
      releaseInput(session);
      await Promise.all([recordingDone, recognitionDone]);
      clearTimer(session, "recorderDrain");
      clearTimer(session, "recognitionDrain");
      if (!active(session)) return false;
      const text = transcript(session);
      detachRecognition(session, true);
      const mimeType = session.recorder?.mimeType || session.chunks[0]?.type || "audio/webm";
      const blob = new Blob(session.chunks, { type: mimeType });
      session.recorder.ondataavailable = session.recorder.onstop = session.recorder.onerror = null;
      const valid = session.gate.hasSpeech() && blob.size > 0 && !session.recorderError && session.recorderStopped;
      current = null;
      emit("idle", session, reason);
      if (!valid) {
        report(!session.gate.hasSpeech() ? "no-speech" : "recording-failed");
        return false;
      }
      onComplete({ blob, mimeType, duration: elapsed(session) / 1000, waveform: compactWaveform(session.levels), transcript: text, reason });
      return true;
    })();
    return session.finishPromise;
  }

  function cancel(reason = "cancelled") {
    const session = current;
    if (!session) return false;
    session.cancelled = true;
    current = null;
    clearTimer(session, "recorderDrain");
    clearTimer(session, "recognitionDrain");
    clearTimer(session, "resumeTimer");
    clearTimer(session, "permissionTimer");
    session.resolvePermission?.();
    session.resolveResume?.();
    session.resolveRecorder?.();
    session.resolveRecognition?.();
    detachRecognition(session, true);
    if (session.recorder) {
      session.recorder.ondataavailable = session.recorder.onstop = session.recorder.onerror = null;
      try { if (session.recorder.state !== "inactive") session.recorder.stop(); } catch { /* already stopped */ }
    }
    releaseInput(session);
    emit("idle", session, reason);
    return true;
  }

  const interrupt = () => {
    if (phase === "requesting") cancel("interrupted");
    else if (phase === "recording") void finish("interrupted");
  };
  const visibility = () => { if (page?.hidden) interrupt(); };
  page?.addEventListener?.("visibilitychange", visibility);
  windowTarget?.addEventListener?.("pagehide", interrupt);
  return {
    start, finish, cancel, isSupported: supported, getState: state,
    destroy() {
      if (destroyed) return;
      cancel("destroyed");
      destroyed = true;
      if (sharedContext?.state !== "closed") Promise.resolve(sharedContext?.close?.()).catch(() => {});
      sharedContext = null;
      page?.removeEventListener?.("visibilitychange", visibility);
      windowTarget?.removeEventListener?.("pagehide", interrupt);
    }
  };
}
