# 回忆时刻 media modules

## Voice contract

```js
import { createMomentVoice } from '/moment-voice.js';

const voice = createMomentVoice({
  onState: ({ phase, elapsedMs, reason }) => {},
  onLevel: (level) => {}, // actual microphone envelope, normalized 0–1
  onError: ({ code, message, recoverable }) => {},
  onComplete: ({ blob, mimeType, duration, waveform, transcript, reason }) => {}
});
await voice.start();
await voice.finish(); // optional manual send; shares the in-flight stop promise
voice.cancel();
voice.destroy();
```

`phase` is `idle`, `requesting`, `recording`, or `processing`. `duration` is seconds, `elapsedMs` milliseconds. The returned waveform has 48 normalized samples derived from input. `reason` is `manual`, `silence`, `limit`, or `interrupted` on completion. Keep an `interrupted` completion as a recoverable draft; do not auto-submit it on a hidden page. Backgrounding without detected speech results in no submission. `onError.recoverable` means browser transcription failed while the original recording continues and can still be sent to backend ASR. The browser transcript is optional and never writes to a text field.

The first start belongs in a user gesture. After permission and audio unlocking, `start()` can run again after AI playback, when continuous mode is armed and the page is visible. The originally unlocked AudioContext is reused. The microphone stream is stopped when recording ends and reacquired under the browser's existing permission grant for each turn. If the browser blocks it, `start()` returns false; expose a microphone button to resume. Destroy the module on logout or when leaving the conversation to close the audio context and detach listeners. Stop AI playback before capture to avoid recording it.

The module stops after 1.8 seconds of silence following sustained input or recognized speech, and is bounded to 120 seconds per utterance and 15 seconds without speech. These are configurable product defaults. It waits for the recorder's final chunk and up to 1.6 seconds for final browser recognition. Audio is never replaced by its transcript. A caller can send `blob` to any later ASR or audio-native model without changing the capture UI. Retain failed network submissions as Blobs/durable drafts and use an application-level message ID for retries.

## Photo field contract

```js
import { mountMomentParticles } from '/moment-particles.js';

const field = mountMomentParticles({ canvas, src: photoUrl, mode: 'reveal', progress: 0 });
if (!await field.ready) { /* retain the ordinary image fallback */ }
field.setProgress(.5); // 0–1, visual transition only
field.setMode('clear'); // fully legible photo, particles remain
field.setLevel(.6); // connect to the recording's onLevel
field.destroy();
```

Give the canvas a CSS width and height or aspect ratio; the module draws an object-cover image. It preserves `src` without altering the image sent to the backend. When switching photo source, destroy the previous field and mount a new one. The field samples the image's actual colors, caps DPR at two, uses 100–420 particles and 20–30 fps, pauses when hidden/offscreen, and renders statically for reduced-motion users. It uses no network library dependency. If cross-origin pixel sampling is disallowed, the photo remains visible with a neutral particle overlay.

## Verification boundary

Node tests exercise real state transitions with fake clocks, recorder chunks, analyser samples and delayed recognition, including no-speech, late permissions, duplicate finish, cancel during processing, restart, limits, and interrupted drafts. Canvas tests check loading, geometry, photo-color sampling, clear/reveal visibility, hidden-page cleanup and reduced motion. They do not establish actual microphone, Safari/iOS, mobile permission behavior, acoustic recognition accuracy, or final integrated UI appearance. Those require browser/device acceptance checks with the composed app.
