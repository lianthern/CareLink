import test from "node:test";
import assert from "node:assert/strict";
import { createMomentVoice, createSpeechGate, compactWaveform } from "../public/moment-voice.js";

const flush = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };

function clock() {
  let time = 0;
  let id = 0;
  const pending = new Map();
  return {
    now: () => time,
    setTimeout(fn, wait) { const nextId = ++id; pending.set(nextId, { fn, at: time + wait }); return nextId; },
    clearTimeout(timer) { pending.delete(timer); },
    async advance(duration) {
      const end = time + duration;
      for (;;) {
        const next = [...pending].sort((left, right) => left[1].at - right[1].at)[0];
        if (!next || next[1].at > end) break;
        time = next[1].at;
        pending.delete(next[0]);
        next[1].fn();
        await flush();
      }
      time = end;
      await flush();
    },
    pending
  };
}

function events() {
  const listeners = new Map();
  return {
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name, callback) { if (listeners.get(name) === callback) listeners.delete(name); },
    fire(name) { listeners.get(name)?.(); },
    listeners
  };
}

function harness(options = {}) {
  const timers = clock();
  const page = { hidden: false, ...events() };
  const window = events();
  const tracks = [];
  const contexts = [];
  const recorders = [];
  const recognitions = [];
  const completions = [];
  const errors = [];
  const states = [];
  const levels = [];
  let amplitude = 0;
  const permissionRequests = [];
  class Context {
    constructor() { this.state = "running"; contexts.push(this); }
    resume() { this.state = "running"; return Promise.resolve(); }
    close() { this.state = "closed"; return Promise.resolve(); }
    createAnalyser() { return { fftSize: 1024, getByteTimeDomainData(samples) { samples.fill(128 + amplitude); } }; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  }
  class Recorder {
    static isTypeSupported(type) { return type === "audio/webm;codecs=opus"; }
    constructor(stream, config) { this.stream = stream; this.mimeType = config.mimeType; this.state = "inactive"; this.stops = 0; recorders.push(this); }
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      this.stops += 1;
      timers.setTimeout(() => {
        this.ondataavailable?.({ data: new Blob(["actual-audio-chunk"], { type: this.mimeType }) });
        this.onstop?.();
      }, options.recorderDelay ?? 100);
    }
  }
  class Recognition {
    constructor() { recognitions.push(this); }
    start() {}
    result(text, final = false) {
      const result = [{ transcript: text }];
      result.isFinal = final;
      this.onresult?.({ resultIndex: 0, results: [result] });
    }
    stop() {
      timers.setTimeout(() => {
        if (options.finalTranscript) this.result(options.finalTranscript, true);
        this.onend?.();
      }, options.recognitionDelay ?? 350);
    }
    abort() { this.aborted = true; }
  }
  const stream = () => {
    const track = { ...events(), stopped: false, stop() { this.stopped = true; } };
    tracks.push(track);
    return { getTracks: () => [track] };
  };
  const voice = createMomentVoice({
    ...timers, document: page, window, AudioContext: Context, MediaRecorder: Recorder,
    Recognition: options.noRecognition ? undefined : Recognition,
    mediaDevices: { getUserMedia() {
      if (options.permissionFailure) return Promise.reject({ name: "NotAllowedError" });
      if (options.deferPermission) return new Promise((resolve, reject) => { permissionRequests.push({ permit: () => resolve(stream()), reject }); });
      return Promise.resolve(stream());
    } },
    onComplete: (value) => completions.push(value), onError: (value) => errors.push(value),
    onState: (value) => states.push(value), onLevel: (value) => levels.push(value),
    ...options.config
  });
  return { timers, voice, page, window, tracks, contexts, recorders, recognitions, completions, errors, states, levels,
    speech(value = true) { amplitude = value ? 12 : 0; },
    permit(index = 0) { permissionRequests[index].permit(); },
    deny(index = 0) { permissionRequests[index].reject({ name: "NotAllowedError" }); }
  };
}

test("silence gate waits for sustained real audio, then allows a natural pause", () => {
  const gate = createSpeechGate();
  for (let time = 0; time < 4000; time += 50) assert.equal(gate.sample(0, time).shouldFinish, false);
  gate.sample(.1, 4000);
  assert.equal(gate.sample(0, 4050).hasSpeech, false, "a click is not a speech turn");
  for (let time = 4100; time <= 4400; time += 50) gate.sample(.1, time);
  assert.equal(gate.sample(0, 6100).shouldFinish, false);
  assert.equal(gate.sample(0, 6200).shouldFinish, true);
});

test("auto-send retains real audio and waits for the late final transcript exactly once", async () => {
  const h = harness({ finalTranscript: "这是最终识别", recognitionDelay: 700 });
  assert.equal(await h.voice.start(), true);
  h.speech();
  await h.timers.advance(500);
  h.recognitions[0].result("这是最");
  h.speech(false);
  await h.timers.advance(1800);
  assert.equal(h.voice.getState().phase, "processing");
  assert.equal(h.completions.length, 0);
  assert.ok(h.tracks.every((track) => track.stopped), "microphone released before transcription drain");
  const duplicate = h.voice.finish();
  await h.timers.advance(699);
  assert.equal(h.completions.length, 0);
  await h.timers.advance(1);
  assert.equal(await duplicate, true);
  assert.equal(h.completions.length, 1);
  assert.equal(h.completions[0].transcript, "这是最终识别");
  assert.equal(h.completions[0].reason, "silence");
  assert.equal(await h.completions[0].blob.text(), "actual-audio-chunk");
  assert.equal(h.completions[0].mimeType, "audio/webm;codecs=opus");
  assert.equal(h.completions[0].waveform.length, 48);
  assert.ok(Math.max(...h.completions[0].waveform) > .3);
  assert.equal(h.recorders[0].stops, 1);
  assert.equal(h.voice.getState().phase, "idle");
  h.voice.destroy();
});

test("no-speech timeout never submits an empty recording", async () => {
  const h = harness({ config: { noSpeechMs: 2000 } });
  await h.voice.start();
  await h.timers.advance(4000);
  assert.equal(h.completions.length, 0);
  assert.equal(h.errors.at(-1).code, "no-speech");
  assert.equal(h.voice.getState().phase, "idle");
  assert.ok(h.tracks[0].stopped);
  h.voice.destroy();
});

test("cancel while permission is pending stops the late stream and cannot start recording", async () => {
  const h = harness({ deferPermission: true });
  const started = h.voice.start();
  assert.equal(h.voice.getState().phase, "requesting");
  h.voice.cancel();
  h.permit();
  assert.equal(await started, false);
  assert.equal(h.recorders.length, 0);
  assert.ok(h.tracks[0].stopped);
  assert.equal(h.completions.length, 0);
  h.voice.destroy();
  assert.equal(h.contexts[0].state, "closed");
});

test("cancel settles start without waiting for a permission prompt that may never finish", async () => {
  const h = harness({ deferPermission: true });
  let result = "pending";
  h.voice.start().then(value => { result = value; });
  assert.equal(h.voice.cancel(), true);
  assert.equal(h.voice.getState().phase, "idle");
  await flush();
  assert.equal(result, false);
  assert.equal(h.timers.pending.size, 0);
  h.deny(); // A native rejection arriving after cancellation is already handled.
  await flush();
  assert.equal(h.errors.length, 0);
  h.voice.destroy();
});

test("finish, page hide and destroy all settle an ignored permission request immediately", async () => {
  for (const action of ["finish", "visibility", "pagehide", "destroy"]) {
    const h = harness({ deferPermission: true });
    let result = "pending";
    h.voice.start().then(value => { result = value; });
    if (action === "finish") assert.equal(await h.voice.finish(), false);
    else if (action === "visibility") { h.page.hidden = true; h.page.fire("visibilitychange"); }
    else if (action === "pagehide") h.window.fire("pagehide");
    else h.voice.destroy();
    await flush();
    assert.equal(result, false, action);
    assert.equal(h.voice.getState().phase, "idle", action);
    h.permit();
    await flush();
    assert.ok(h.tracks[0].stopped, `${action}: late microphone stream is closed`);
    assert.equal(h.recorders.length, 0);
    h.voice.destroy();
  }
});

test("permission wait is bounded and a late old stream cannot stop the next recording", async () => {
  const h = harness({ deferPermission: true, config: { permissionWaitMs: 2000 } });
  let first = "pending";
  h.voice.start().then(value => { first = value; });
  await h.timers.advance(1999);
  assert.equal(h.voice.getState().phase, "requesting");
  await h.timers.advance(1);
  assert.equal(first, false);
  assert.equal(h.voice.getState().phase, "idle");
  assert.equal(h.errors.at(-1).code, "permission-timeout");
  const second = h.voice.start();
  h.permit(1);
  assert.equal(await second, true);
  h.permit(0);
  await flush();
  assert.equal(h.voice.getState().phase, "recording");
  assert.equal(h.tracks[0].stopped, false, "the new microphone remains live");
  assert.equal(h.tracks[1].stopped, true, "the timed-out microphone is closed");
  assert.equal(h.recorders.length, 1);
  h.voice.destroy();
});

test("provider segment duration is captured per utterance without truncating prior audio", async () => {
  let recommended = 1000;
  const h = harness({ config: { getMaxDurationMs: () => recommended } });
  await h.voice.start();h.speech();
  recommended = 2000;
  await h.timers.advance(1400);
  assert.equal(h.completions.length, 1);
  assert.equal(h.completions[0].duration, 1, "in-flight recording keeps its initial limit");
  assert.equal(h.completions[0].reason, "limit");
  assert.equal(await h.completions[0].blob.text(), "actual-audio-chunk");
  await h.voice.start();
  await h.timers.advance(1400);
  assert.equal(h.completions.length, 1, "next recording reads the new segment limit");
  await h.timers.advance(1000);
  assert.equal(h.completions.length, 2);
  assert.equal(h.completions[1].duration, 2);
  h.voice.destroy();
});

test("cancel during stop and transcript drain suppresses late results and permits another turn", async () => {
  const h = harness({ finalTranscript: "不该发送" });
  await h.voice.start();
  h.speech();
  await h.timers.advance(400);
  const finishing = h.voice.finish();
  assert.equal(h.voice.cancel(), true);
  h.speech(false);
  await h.voice.start();
  await h.timers.advance(500);
  assert.equal(await finishing, false);
  assert.equal(h.completions.length, 0);
  assert.equal(h.voice.getState().phase, "recording");
  assert.equal(h.contexts.length, 1, "reuse context initially unlocked by the user");
  assert.equal(h.levels.at(-1), 0);
  h.voice.destroy();
});

test("hidden page preserves voiced audio as interrupted draft and detaches lifecycle listeners", async () => {
  const h = harness();
  await h.voice.start();
  h.speech();
  await h.timers.advance(500);
  h.page.hidden = true;
  h.page.fire("visibilitychange");
  await h.timers.advance(400);
  assert.equal(h.completions.length, 1);
  assert.equal(h.completions[0].reason, "interrupted");
  assert.ok(h.tracks[0].stopped);
  h.voice.destroy();
  assert.equal(h.page.listeners.size, 0);
  assert.equal(h.window.listeners.size, 0);
});

test("recognition network failure keeps the original recording available for API ASR", async () => {
  const h = harness();
  await h.voice.start();
  h.speech();
  await h.timers.advance(500);
  h.recognitions[0].onerror({ error: "network" });
  h.recognitions[0].onend();
  assert.equal(h.errors[0].recoverable, true);
  assert.equal(h.voice.getState().phase, "recording");
  const finishing = h.voice.finish();
  await h.timers.advance(200);
  assert.equal(await finishing, true);
  assert.equal(h.completions[0].transcript, "");
  assert.ok(h.completions[0].blob.size);
  h.voice.destroy();
});

test("browser recognition restarts between native speech sessions without losing prior phrases", async () => {
  const h = harness({ finalTranscript: "第二段" });
  await h.voice.start();
  h.recognitions[0].result("第一段", true);
  h.recognitions[0].onend();
  await h.timers.advance(200);
  assert.equal(h.recognitions.length, 2);
  h.recognitions[1].result("第");
  const finishing = h.voice.finish();
  await h.timers.advance(400);
  assert.equal(await finishing, true);
  assert.equal(h.completions[0].transcript, "第一段第二段");
  h.voice.destroy();
});

test("recording limit bounds a continuously voiced utterance", async () => {
  const h = harness({ config: { maxDurationMs: 1000 } });
  await h.voice.start();
  h.speech();
  await h.timers.advance(1500);
  assert.equal(h.completions.length, 1);
  assert.equal(h.completions[0].reason, "limit");
  assert.equal(h.completions[0].duration, 1);
  h.voice.destroy();
});

test("permission rejection is actionable and leaves no live capture", async () => {
  const h = harness({ permissionFailure: true });
  assert.equal(await h.voice.start(), false);
  assert.equal(h.errors[0].code, "permission");
  assert.equal(h.voice.getState().phase, "idle");
  assert.equal(h.completions.length, 0);
  h.voice.destroy();
});

test("waveform compaction preserves audio peaks and clamps invalid levels", () => {
  assert.deepEqual(compactWaveform([0, .8, .1, .2], 2), [.8, .2]);
  assert.deepEqual(compactWaveform([], 3), [0, 0, 0]);
  assert.deepEqual(compactWaveform([9, -.2], 2), [1, 0]);
});
