const PLAYBACK_PRIMER_URL = "data:audio/wav;base64,UklGRsQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function defaultAudio(url) {
  return new Audio(url);
}

function responseError(status) {
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate-limited";
  if (status === 503) return "unavailable";
  return "failed";
}

export function createTurnVoicePlayer({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  createAudio = defaultAudio,
  createObjectURL = globalThis.URL?.createObjectURL?.bind(globalThis.URL),
  revokeObjectURL = globalThis.URL?.revokeObjectURL?.bind(globalThis.URL),
  timeoutMs = 30_000,
  maximumAudioBytes = 5 * 1024 * 1024,
  onState = () => {}
} = {}) {
  let generation = 0;
  let controller = null;
  let audio = null;
  let preparedAudio = null;
  let objectUrl = null;
  let replayBlob = null;
  let phase = "idle";
  let code = null;

  function emit(nextPhase, nextCode = null) {
    phase = nextPhase;
    code = nextCode;
    onState({ phase, code, canReplay: Boolean(replayBlob) });
  }

  function releaseAudio() {
    const current = audio;
    audio = null;
    if (current) {
      current.onended = null;
      current.onerror = null;
      try {
        current.pause();
        current.currentTime = 0;
        current.removeAttribute?.("src");
        current.load?.();
      } catch { /* the readable text remains available */ }
    }
    if (objectUrl) revokeObjectURL?.(objectUrl);
    objectUrl = null;
  }

  function releasePreparedAudio() {
    const current = preparedAudio;
    preparedAudio = null;
    if (!current) return;
    try {
      current.pause();
      current.currentTime = 0;
      current.removeAttribute?.("src");
      current.load?.();
    } catch { /* preparation is optional */ }
  }

  function cancelCurrent({ releasePrepared = true } = {}) {
    generation += 1;
    controller?.abort?.();
    controller = null;
    releaseAudio();
    if (releasePrepared) releasePreparedAudio();
  }

  function stop({ keepReplay = true, announce = true } = {}) {
    const active = Boolean(controller || audio || phase === "loading" || phase === "speaking");
    cancelCurrent();
    if (!keepReplay) replayBlob = null;
    if (announce) emit("idle", active ? "stopped" : null);
    return active;
  }

  function prepare() {
    if (preparedAudio) return false;
    cancelCurrent();
    try {
      const candidate = createAudio(PLAYBACK_PRIMER_URL);
      if (!candidate || typeof candidate.play !== "function") return false;
      preparedAudio = candidate;
      Promise.resolve(candidate.play()).then(() => {
        if (preparedAudio !== candidate) return;
        candidate.pause();
        candidate.currentTime = 0;
      }).catch(() => releasePreparedAudio());
      return true;
    } catch {
      releasePreparedAudio();
      return false;
    }
  }

  async function playBlob(blob, currentGeneration) {
    objectUrl = createObjectURL?.(blob) ?? null;
    if (!objectUrl) {
      releasePreparedAudio();
      emit("error", "unsupported");
      return false;
    }
    try {
      audio = preparedAudio ?? createAudio(objectUrl);
      preparedAudio = null;
      if (!audio || typeof audio.play !== "function") throw new Error("audio_unsupported");
      audio.src = objectUrl;
      audio.onended = () => {
        if (currentGeneration !== generation) return;
        releaseAudio();
        emit("idle");
      };
      audio.onerror = () => {
        if (currentGeneration !== generation) return;
        releaseAudio();
        emit("error", "decode-failed");
      };
      await audio.play();
      if (currentGeneration !== generation) return false;
      emit("speaking");
      return true;
    } catch (error) {
      if (currentGeneration !== generation) return false;
      releaseAudio();
      emit("error", error?.name === "NotAllowedError" ? "playback-blocked" : "decode-failed");
      return false;
    }
  }

  async function speak(text) {
    cancelCurrent({ releasePrepared: false });
    replayBlob = null;
    if (typeof text !== "string" || !text.trim() || typeof fetchImpl !== "function") {
      releasePreparedAudio();
      emit("error", "unsupported");
      return false;
    }
    const currentGeneration = generation;
    const nextController = new AbortController();
    controller = nextController;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      nextController.abort();
    }, timeoutMs);
    emit("loading");
    try {
      const response = await fetchImpl("/api/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: text.trim() }),
        signal: nextController.signal
      });
      if (currentGeneration !== generation) return false;
      if (!response.ok) {
        releasePreparedAudio();
        emit("error", responseError(response.status));
        return false;
      }
      const mimeType = response.headers.get("content-type")?.split(";", 1)[0].trim() ?? "";
      if (!mimeType.startsWith("audio/")) {
        releasePreparedAudio();
        emit("error", "invalid-audio");
        return false;
      }
      const blob = await response.blob();
      if (currentGeneration !== generation) return false;
      if (!blob.size || blob.size > maximumAudioBytes) {
        releasePreparedAudio();
        emit("error", "invalid-audio");
        return false;
      }
      replayBlob = blob;
      controller = null;
      return playBlob(blob, currentGeneration);
    } catch {
      if (currentGeneration !== generation) return false;
      releasePreparedAudio();
      emit("error", timedOut ? "timeout" : "failed");
      return false;
    } finally {
      clearTimeout(timer);
      if (controller === nextController) controller = null;
    }
  }

  return {
    speak,
    prepare,
    stop,
    clear() { stop({ keepReplay: false, announce: false }); emit("idle"); },
    replay() {
      cancelCurrent();
      if (!replayBlob) { emit("error", "nothing-to-replay"); return Promise.resolve(false); }
      return playBlob(replayBlob, generation);
    },
    getState: () => ({ phase, code, canReplay: Boolean(replayBlob) })
  };
}
