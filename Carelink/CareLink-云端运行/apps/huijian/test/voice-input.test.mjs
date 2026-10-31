import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  appendTranscript,
  createVoiceInput,
  createVoiceStrengthMeter,
  mergeTranscriptIntoEditableText
} from "../public/voice-input.js";

const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const voiceSource = await readFile(new URL("../public/voice-input.js", import.meta.url), "utf8");

function speechResult(text, isFinal = false) {
  const result = [{ transcript: text }];
  result.isFinal = isFinal;
  return result;
}

class FakeRecognition {
  static instances = [];

  constructor() {
    this.started = false;
    this.stopped = false;
    this.aborted = false;
    FakeRecognition.instances.push(this);
  }

  start() {
    this.started = true;
  }

  stop() {
    this.stopped = true;
  }

  abort() {
    this.aborted = true;
  }

  result(results, resultIndex = 0) {
    this.onresult?.({ results, resultIndex });
  }

  error(error) {
    this.onerror?.({ error });
  }

  end() {
    this.onend?.();
  }
}

function setup(options = {}) {
  FakeRecognition.instances = [];
  const states = [];
  const transcripts = [];
  const errors = [];
  const completions = [];
  const voice = createVoiceInput({
    Recognition: FakeRecognition,
    ...options,
    onState: (state) => states.push(state),
    onTranscript: (transcript) => transcripts.push(transcript),
    onComplete: (transcript) => completions.push(transcript),
    onError: (error) => errors.push(error)
  });
  return { voice, states, transcripts, errors, completions };
}

test("starts a configured recognition session and stops through processing", () => {
  const { voice, states, completions } = setup();

  assert.equal(voice.start(), true);
  const [recognition] = FakeRecognition.instances;
  assert.equal(recognition.started, true);
  assert.equal(recognition.lang, "zh-CN");
  assert.equal(recognition.continuous, false);
  assert.equal(recognition.interimResults, true);
  assert.equal(recognition.maxAlternatives, 1);
  assert.equal(voice.isActive(), true);
  assert.equal(voice.isBusy(), true);

  recognition.result([speechResult("这一句", true)]);
  assert.deepEqual(completions, [], "recognition text is editable but is not a completed turn before stop");
  assert.equal(voice.stop(), true);
  assert.equal(recognition.stopped, true);
  assert.equal(voice.isActive(), false);
  assert.equal(voice.isBusy(), true);
  assert.deepEqual(states, ["listening", "processing"]);
  assert.deepEqual(completions, [], "clicking stop waits for the browser's final onend event");

  recognition.end();
  assert.equal(voice.isBusy(), false);
  assert.deepEqual(completions, ["这一句"]);
  assert.deepEqual(states, ["listening", "processing", "complete", "idle"]);
});

test("an explicit turn opts into continuous recognition and completes only after stop and end", () => {
  const { voice, states, completions } = setup({ continuous: true });
  voice.start();
  const [recognition] = FakeRecognition.instances;
  assert.equal(recognition.continuous, true);
  recognition.result([speechResult("这句要留到按停", true)]);
  assert.deepEqual(completions, []);
  assert.equal(voice.stop(), true);
  assert.deepEqual(states, ["listening", "processing"]);
  assert.deepEqual(completions, []);
  recognition.end();
  assert.deepEqual(completions, ["这句要留到按停"]);
  assert.deepEqual(states, ["listening", "processing", "complete", "idle"]);
});

test("publishes interim text, accumulated final text, and one explicit completion", () => {
  const { voice, states, transcripts, errors, completions } = setup();
  voice.start();
  const [recognition] = FakeRecognition.instances;

  recognition.result([speechResult("那天阳光很好")]);
  recognition.result([speechResult("那天阳光很好", true)]);
  recognition.result([
    speechResult("那天阳光很好", true),
    speechResult("我们刚下火车")
  ], 1);

  assert.deepEqual(transcripts, [
    { final: "", interim: "那天阳光很好" },
    { final: "那天阳光很好", interim: "" },
    { final: "那天阳光很好", interim: "我们刚下火车" }
  ]);
  recognition.end();
  assert.deepEqual(errors, []);
  assert.deepEqual(completions, ["那天阳光很好"]);
  assert.deepEqual(states, ["listening", "complete", "idle"]);
});

test("replaces revised interim segments and does not duplicate repeated final results", () => {
  const { voice, transcripts } = setup();
  voice.start();
  const [recognition] = FakeRecognition.instances;

  recognition.result([speechResult("那天阳光")]);
  recognition.result([speechResult("那天阳光很好")]);
  recognition.result([speechResult("那天阳光很好", true)]);
  recognition.result([
    speechResult("那天阳光很好", true),
    speechResult("我们刚下火车", true)
  ], 0);

  assert.deepEqual(transcripts, [
    { final: "", interim: "那天阳光" },
    { final: "", interim: "那天阳光很好" },
    { final: "那天阳光很好", interim: "" },
    { final: "那天阳光很好，我们刚下火车", interim: "" }
  ]);
});

test("maps permission, microphone, no-speech, and network failures to text fallbacks", () => {
  for (const code of [
    "not-allowed",
    "service-not-allowed",
    "audio-capture",
    "no-speech",
    "network"
  ]) {
    const { voice, states, errors } = setup();
    voice.start();
    FakeRecognition.instances[0].error(code);

    assert.deepEqual(errors, [code]);
    assert.deepEqual(states, ["listening", "idle"]);
    assert.equal(voice.isBusy(), false);
  }
});

test("reports an unsupported browser without creating a session", () => {
  const errors = [];
  const voice = createVoiceInput({ onError: (error) => errors.push(error) });

  assert.equal(voice.isSupported(), false);
  assert.equal(voice.start(), false);
  assert.deepEqual(errors, ["unsupported"]);
});

test("falls back when the browser cannot construct its recognition service", () => {
  class ThrowingRecognition {
    constructor() {
      throw new Error("service unavailable");
    }
  }
  const errors = [];
  const voice = createVoiceInput({
    Recognition: ThrowingRecognition,
    onError: (error) => errors.push(error)
  });

  assert.equal(voice.start(), false);
  assert.equal(voice.isBusy(), false);
  assert.deepEqual(errors, ["start-failed"]);
});

test("falls back when the browser constructs but cannot start recognition", () => {
  class StartThrowingRecognition extends FakeRecognition {
    start() {
      throw new Error("permission service failed before start");
    }
  }
  const states = [];
  const errors = [];
  const voice = createVoiceInput({
    Recognition: StartThrowingRecognition,
    onState: (state) => states.push(state),
    onError: (error) => errors.push(error)
  });

  assert.equal(voice.start(), false);
  assert.equal(voice.isBusy(), false);
  assert.deepEqual(states, ["listening", "idle"]);
  assert.deepEqual(errors, ["start-failed"]);
});

test("returns to editable idle state if stopping recognition throws", () => {
  class StopThrowingRecognition extends FakeRecognition {
    stop() {
      throw new Error("service disappeared");
    }
  }
  const states = [];
  const errors = [];
  const voice = createVoiceInput({
    Recognition: StopThrowingRecognition,
    onState: (state) => states.push(state),
    onError: (error) => errors.push(error)
  });

  voice.start();
  assert.equal(voice.stop(), false);
  assert.equal(voice.isBusy(), false);
  assert.deepEqual(states, ["listening", "processing", "idle"]);
  assert.deepEqual(errors, ["unknown"]);
});

test("reports no speech when recognition ends silently", () => {
  const { voice, errors } = setup();
  voice.start();
  FakeRecognition.instances[0].end();
  assert.deepEqual(errors, ["no-speech"]);
});

test("stopping an empty session reports no speech and returns to idle", () => {
  const { voice, states, errors } = setup();
  voice.start();
  const [recognition] = FakeRecognition.instances;
  voice.stop();
  recognition.end();

  assert.deepEqual(errors, ["no-speech"]);
  assert.deepEqual(states, ["listening", "processing", "idle"]);
  assert.equal(voice.isBusy(), false);
});

test("cancel aborts silently and isolates a late event from the next session", () => {
  const { voice, states, transcripts, errors } = setup();
  voice.start();
  const first = FakeRecognition.instances[0];
  const lateResult = first.onresult;
  const lateError = first.onerror;
  const lateEnd = first.onend;

  assert.equal(voice.cancel(), true);
  assert.equal(first.aborted, true);
  assert.deepEqual(states, ["listening", "idle"]);
  assert.deepEqual(errors, []);

  voice.start();
  const second = FakeRecognition.instances[1];
  lateResult({ results: [speechResult("不该出现", true)], resultIndex: 0 });
  lateError({ error: "network" });
  lateEnd();
  assert.deepEqual(transcripts, []);
  assert.equal(voice.isBusy(), true);

  second.result([speechResult("新的这句", true)]);
  second.end();
  assert.deepEqual(transcripts, [{ final: "新的这句", interim: "" }]);
  assert.equal(voice.isBusy(), false);
});

test("does not accept a second start while a session is processing", () => {
  const { voice } = setup();
  voice.start();
  voice.stop();
  assert.equal(voice.start(), false);
  assert.equal(FakeRecognition.instances.length, 1);
});

test("appendTranscript keeps punctuation natural", () => {
  assert.equal(appendTranscript("第一句", "第二句"), "第一句，第二句");
  assert.equal(appendTranscript("第一句。", "第二句"), "第一句。第二句");
  assert.equal(appendTranscript("", "只有一句"), "只有一句");
});

test("editable transcript merge preserves every character the user already typed", () => {
  assert.equal(
    mergeTranscriptIntoEditableText("  我先写的原话  ", "后来风停了"),
    "  我先写的原话  后来风停了"
  );
  assert.equal(
    mergeTranscriptIntoEditableText("第一句。", "第二句"),
    "第一句。第二句"
  );
  assert.equal(mergeTranscriptIntoEditableText("原话", ""), "原话");
});

test("app cancels recognition before changing or reopening photo sessions", () => {
  assert.match(appSource, /function startConversation\([^)]*\) \{\s*voiceInput\.cancel\(\);/u);
  assert.match(appSource, /function reset\([^]*?voiceInput\.cancel\(\);/u);
  assert.match(appSource, /function restoreStoredMemory\([^]*?voiceInput\.cancel\(\);/u);
  assert.match(appSource, /if \(screen !== "chat"\) voiceInput\.cancel\(\);/u);
  assert.match(
    appSource,
    /addEventListener\("huijian:photo-selection-cancel", \(\) => \{[^}]*voiceInput\.cancel\(\);/u
  );
});

test("voice strength is read transiently without creating, uploading, or saving recordings", () => {
  assert.match(voiceSource, /getUserMedia/u);
  assert.match(voiceSource, /AudioContext/u);
  assert.match(voiceSource, /getTracks\?\.\(\).*track\.stop/u);
  assert.doesNotMatch(voiceSource, /MediaRecorder|new Blob|fetch\(|indexedDB|localStorage/u);
});

test("voice meter emits an RMS envelope and releases its microphone and audio context", async () => {
  let nextFrame = null;
  let trackStopped = false;
  let contextClosed = false;
  const levels = [];
  const analyser = {
    fftSize: 0,
    smoothingTimeConstant: 0,
    getByteTimeDomainData(buffer) { buffer.fill(160); }
  };
  class FakeAudioContext {
    constructor() { this.state = "running"; }
    createAnalyser() { return analyser; }
    createMediaStreamSource() { return { connect() {} }; }
    close() { this.state = "closed"; contextClosed = true; return Promise.resolve(); }
  }
  const meter = createVoiceStrengthMeter({
    onLevel: (level) => levels.push(level),
    mediaDevices: {
      async getUserMedia() {
        return { getTracks: () => [{ stop() { trackStopped = true; } }] };
      }
    },
    AudioContext: FakeAudioContext,
    requestFrame(callback) { nextFrame = callback; return 1; },
    cancelFrame() { nextFrame = null; }
  });

  assert.equal(await meter.start(), true);
  assert.ok(levels.some((level) => level > 0));
  assert.equal(typeof nextFrame, "function");
  meter.stop();
  assert.equal(trackStopped, true);
  assert.equal(contextClosed, true);
  assert.equal(levels.at(-1), 0);
});

test("app uses pure-text A-Jian observation states without generating a graphic", () => {
  assert.match(appSource, /阿见正在看这张照片……/u);
  assert.match(appSource, /阿见看到了：/u);
  assert.doesNotMatch(appSource, /agent-eye|agent-fold|agent-paper/u);
});

test("app keeps the browser chrome black on every screen", () => {
  assert.match(
    appSource,
    /document\.querySelector\('meta\[name="theme-color"\]'\)\.content = "#050505";/u
  );
  assert.doesNotMatch(appSource, /screen === "result" \? "#e7e0d2"/u);
});
