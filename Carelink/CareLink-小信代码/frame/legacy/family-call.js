"use strict";
var __defProp = Object.defineProperty;
var __defProps = Object.defineProperties;
var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
var __getOwnPropSymbols = Object.getOwnPropertySymbols;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __propIsEnum = Object.prototype.propertyIsEnumerable;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __spreadValues = (a, b) => {
  for (var prop in b || (b = {}))
    if (__hasOwnProp.call(b, prop))
      __defNormalProp(a, prop, b[prop]);
  if (__getOwnPropSymbols)
    for (var prop of __getOwnPropSymbols(b)) {
      if (__propIsEnum.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    }
  return a;
};
var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));
globalThis.MemoryCall = (() => {
  const LIVE = /* @__PURE__ */ new Set(["ringing", "accepted", "connecting"]);
  const TERMINAL = /* @__PURE__ */ new Set(["ended", "declined", "failed", "expired"]);
  const labels = { ended: "\u901A\u8BDD\u5DF2\u7ED3\u675F\u3002", declined: "\u5BF9\u65B9\u6682\u65F6\u4E0D\u65B9\u4FBF\u63A5\u542C\u3002", failed: "\u901A\u8BDD\u8FDE\u63A5\u5DF2\u4E2D\u65AD\u3002", expired: "\u547C\u53EB\u6216\u901A\u8BDD\u5DF2\u5230\u671F\u3002" };
  let dialog, notice, audio, identity = "", epoch = 0, capabilities, members = [], calls = [], call = null, run = null;
  let ringContext, ringTimer, minimized = false;
  let pollTimer, deadlineTimer, checking = false, busy = false, lastCheck = 0, selected = "", retryStart = null, stopReason = "";
  const mediaClosures = /* @__PURE__ */ new Set();
  const controllers = /* @__PURE__ */ new Set(), dismissed = /* @__PURE__ */ new Set(), mediaIntent = /* @__PURE__ */ new Set(), terminations = /* @__PURE__ */ new Map();
  const auth = () => typeof session !== "undefined" && !sessionExpired ? (session == null ? void 0 : session.token) || "" : "";
  const current = (token, generation) => token && token === auth() && token === identity && generation === epoch;
  const liveRun = (r) => run === r && current(r.token, r.generation) && ((dialog == null ? void 0 : dialog.open) || minimized) && !document.hidden && mediaIntent.has(r.id) && (call == null ? void 0 : call.id) === r.id && LIVE.has(call.status);
  const el = (id) => dialog == null ? void 0 : dialog.querySelector("#" + id);
  function transportState(pc) {
    if (typeof pc.connectionState === "string") return pc.connectionState;
    return { completed: "connected", checking: "connecting" }[pc.iceConnectionState] || pc.iceConnectionState || "new";
  }
  function addRemoteCandidate(pc, candidate) {
    if (candidate === null && pc.addIceCandidate.length !== 0) return Promise.resolve();
    return pc.addIceCandidate(candidate);
  }
  function reportStage(stage) {
    try {
      if (globalThis.UnseenNative && typeof globalThis.UnseenNative.aiDiagnostic === "function") globalThis.UnseenNative.aiDiagnostic(stage);
    } catch (_) {
    }
  }
  function audioCounterState(previous, report) {
    const next = /* @__PURE__ */ new Map(), result = { tx: null, rx: null };
    let count = 0, invalid = false;
    if (!report || typeof report.forEach !== "function") return { next, state: "unknown" };
    report.forEach((row) => {
      if (++count > 256) {
        invalid = true;
        return;
      }
      if (!row || row.isRemote || (row.kind || row.mediaType) !== "audio") return;
      const direction = row.type === "outbound-rtp" ? "tx" : row.type === "inbound-rtp" ? "rx" : null;
      if (!direction || typeof row.id !== "string" || row.id.length > 256) return;
      const bytes = row[direction === "tx" ? "bytesSent" : "bytesReceived"];
      const packets = row[direction === "tx" ? "packetsSent" : "packetsReceived"];
      const valid = (value) => Number.isSafeInteger(value) && value >= 0;
      if (!valid(bytes) && !valid(packets)) return;
      const key = direction + ":" + row.id, current2 = { bytes: valid(bytes) ? bytes : null, packets: valid(packets) ? packets : null };
      next.set(key, current2);
      const old = previous && previous.get(key);
      if (!old) {
        invalid = true;
        return;
      }
      let compared = false, growing = false;
      for (const field of ["bytes", "packets"]) {
        if (current2[field] === null || old[field] === null) continue;
        compared = true;
        if (current2[field] < old[field]) {
          invalid = true;
          return;
        }
        growing = growing || current2[field] > old[field];
      }
      if (compared) result[direction] = result[direction] === true || growing;
    });
    const state = invalid || result.tx === null || result.rx === null ? "unknown" : result.tx && result.rx ? "bidir" : result.tx ? "tx" : result.rx ? "rx" : "idle";
    return { next: invalid && count > 256 ? /* @__PURE__ */ new Map() : next, state };
  }
  function observeAudioCounters(r) {
    if (!liveRun(r) || r.statsPending) return;
    if (!r.pc || typeof r.pc.getStats !== "function") {
      reportStage("family-rtp-unknown");
      return;
    }
    r.statsPending = true;
    let expired = false;
    const timeout = setTimeout(() => {
      expired = true;
      r.statsPrevious = null;
      if (liveRun(r)) reportStage("family-rtp-unknown");
    }, 4e3);
    Promise.resolve().then(() => liveRun(r) ? r.pc.getStats() : null).then((report) => {
      if (!liveRun(r) || expired) return;
      const sample = audioCounterState(r.statsPrevious, report);
      r.statsPrevious = sample.next;
      reportStage("family-rtp-" + sample.state);
    }, () => {
      if (liveRun(r) && !expired) {
        r.statsPrevious = null;
        reportStage("family-rtp-unknown");
      }
    }).then(() => {
      clearTimeout(timeout);
      r.statsPending = false;
      if (liveRun(r)) r.statsTimer = setTimeout(() => observeAudioCounters(r), 1e4);
    }).catch(() => {
      clearTimeout(timeout);
      r.statsPending = false;
    });
  }
  let diagnostic = { stage: "idle", code: "", transport: "", ice: "" };
  function diagnose(stage, error, pc) {
    const names = ["NotAllowedError", "NotFoundError", "NotReadableError", "OverconstrainedError", "AbortError", "TimeoutError", "SecurityError", "InvalidStateError", "OperationError", "TypeError"];
    const code = names.includes(error == null ? void 0 : error.name) ? error.name : [400, 401, 403, 404, 409, 429, 500, 502, 503, 504].includes(error == null ? void 0 : error.status) ? "HTTP_" + error.status : error ? "ERROR" : "";
    diagnostic = { stage, code, transport: pc ? transportState(pc) : "", ice: (pc == null ? void 0 : pc.iceConnectionState) || "" };
    if (["sdk", "relay-config", "microphone", "offer", "answer", "signaling", "connected", "transport", "relay-candidate", "media"].includes(stage)) reportStage("family-" + stage + (error ? "-failed" : ""));
    else if (error && stage.startsWith("request-")) reportStage("family-request-failed");
  }
  function mediaFailure(stage, error) {
    if ((error == null ? void 0 : error.name) === "NotAllowedError") return "\u9EA6\u514B\u98CE\u672A\u83B7\u5141\u8BB8\uFF0C\u901A\u8BDD\u5DF2\u7ED3\u675F\u3002\u8BF7\u5141\u8BB8\u6743\u9650\u540E\u91CD\u65B0\u547C\u53EB\u3002";
    if ((error == null ? void 0 : error.name) === "NotFoundError") return "\u672A\u627E\u5230\u53EF\u7528\u9EA6\u514B\u98CE\uFF0C\u901A\u8BDD\u5DF2\u7ED3\u675F\u3002";
    if ((error == null ? void 0 : error.name) === "NotReadableError") return "\u9EA6\u514B\u98CE\u88AB\u5176\u4ED6\u5E94\u7528\u5360\u7528\u6216\u65E0\u6CD5\u8BFB\u53D6\uFF0C\u901A\u8BDD\u5DF2\u7ED3\u675F\u3002";
    if (stage === "relay-config") return "\u672A\u53D6\u5F97\u901A\u8BDD\u4E2D\u7EE7\u914D\u7F6E\uFF0C\u901A\u8BDD\u5DF2\u7ED3\u675F\u3002\u8BF7\u68C0\u67E5\u7F51\u7EDC\u6216\u767B\u5F55\u72B6\u6001\u3002";
    if (stage === "offer" || stage === "answer" || stage === "signaling") return "\u901A\u8BDD\u7F51\u7EDC\u534F\u5546\u5931\u8D25\uFF0C\u9EA6\u514B\u98CE\u5DF2\u5173\u95ED\u3002";
    if (stage === "sdk") return "\u5B9E\u65F6\u97F3\u89C6\u9891\u670D\u52A1\u672A\u80FD\u8FDE\u63A5\uFF0C\u9EA6\u514B\u98CE\u5DF2\u5173\u95ED\u3002";
    return "\u65E0\u6CD5\u5F00\u542F\u901A\u8BDD\u97F3\u9891\uFF0C\u9EA6\u514B\u98CE\u5DF2\u5173\u95ED\u3002";
  }
  function status(text) {
    if (el("callStatus")) el("callStatus").textContent = text;
  }
  function unsupported() {
    var _a;
    if (!globalThis.isSecureContext) return "\u8BED\u97F3\u901A\u8BDD\u9700\u8981 HTTPS \u5B89\u5168\u9875\u9762\u3002";
    if (globalThis.UnseenNativeRtc && globalThis.UnseenNativeRtc.available()) return "";
    if (!globalThis.RTCPeerConnection || !((_a = navigator.mediaDevices) == null ? void 0 : _a.getUserMedia)) return "\u6B64\u6D4F\u89C8\u5668\u4E0D\u652F\u6301\u5F53\u524D\u8BED\u97F3\u901A\u8BDD\uFF0C\u8BF7\u6362\u7528\u652F\u6301 WebRTC \u7684\u6D4F\u89C8\u5668\u3002";
    return "";
  }
  function stopRing() {
    if (globalThis.UnseenNativeRtc && globalThis.UnseenNativeRtc.available()) globalThis.UnseenNativeRtc.ring(false);
    clearTimeout(ringTimer);
    ringTimer = null;
    const context = ringContext;
    ringContext = null;
    try {
      context == null ? void 0 : context.close().catch(() => {
      });
    } catch (e) {
    }
  }
  function ring() {
    if (document.hidden || !call || call.direction !== "incoming" || call.status !== "ringing") {
      stopRing();
      return;
    }
    if (ringTimer) return;
    if (globalThis.UnseenNativeRtc && globalThis.UnseenNativeRtc.available()) {
      globalThis.UnseenNativeRtc.ring(true);
      ringTimer = setTimeout(() => {
        ringTimer = null;
        ring();
      }, 2500);
      return;
    }
    try {
      const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Context) return;
      ringContext || (ringContext = new Context());
      if (ringContext.state === "running") {
        for (const offset of [0, 0.3]) {
          const tone = ringContext.createOscillator(), volume = ringContext.createGain(), start2 = ringContext.currentTime + offset;
          tone.frequency.value = 660;
          volume.gain.value = 0;
          tone.connect(volume);
          volume.connect(ringContext.destination);
          volume.gain.setValueAtTime(0, start2);
          volume.gain.linearRampToValueAtTime(0.06, start2 + 0.02);
          volume.gain.linearRampToValueAtTime(0, start2 + 0.18);
          tone.start(start2);
          tone.stop(start2 + 0.2);
          tone.onended = () => {
            tone.disconnect();
            volume.disconnect();
          };
        }
      }
      ringTimer = setTimeout(() => {
        ringTimer = null;
        ring();
      }, 2500);
    } catch (e) {
      stopRing();
    }
  }
  function mediaBlocked() {
    var _a, _b, _c;
    if (mediaClosures.size) return "\u4E0A\u6B21\u901A\u8BDD\u7684\u97F3\u9891\u9000\u51FA\u5C1A\u672A\u786E\u8BA4\uFF0C\u8BF7\u5148\u786E\u8BA4\u505C\u6B62\u3002";
    if (((_a = globalThis.UnseenCaptureBusy) == null ? void 0 : _a.call(globalThis)) || ((_b = globalThis.UnseenAssistantVoice) == null ? void 0 : _b.busy())) return "\u8BF7\u5148\u7ED3\u675F\u5F55\u97F3\u3001\u7B49\u5F85\u4E2D\u7684\u9EA6\u514B\u98CE\u6388\u6743\u6216\u8F6C\u5199\uFF0C\u518D\u7EE7\u7EED\u901A\u8BDD\u3002";
    if (navigator.onLine === false) return "\u7F51\u7EDC\u5DF2\u65AD\u5F00\uFF0C\u8BF7\u6062\u590D\u8FDE\u63A5\u540E\u518D\u547C\u53EB\u3002";
    if (typeof recording !== "undefined" && recording || typeof recordingStarting !== "undefined" && recordingStarting) return "\u8BF7\u5148\u7ED3\u675F\u6B63\u5728\u5F55\u7ED9\u5BB6\u4EBA\u7684\u539F\u58F0\u6216\u7B49\u5F85\u4E2D\u7684\u5F55\u97F3\u6388\u6743\uFF0C\u518D\u7EE7\u7EED\u901A\u8BDD\u3002";
    if ((_c = globalThis.MemoryRealtime) == null ? void 0 : _c.busy()) return "\u8BF7\u5148\u6302\u65AD AI \u5B9E\u65F6\u5BF9\u8BDD\u5E76\u786E\u8BA4\u7ED3\u675F\uFF0C\u518D\u4E0E\u5BB6\u4EBA\u901A\u8BDD\u3002";
    return "";
  }
  function ensure() {
    if (dialog) return;
    dialog = document.createElement("dialog");
    dialog.id = "familyCallDialog";
    dialog.className = "family-call-dialog";
    dialog.setAttribute("aria-labelledby", "callTitle");
    dialog.innerHTML = '<div class="call-heading"><h2 id="callTitle">\u548C\u5BB6\u4EBA\u8BED\u97F3\u901A\u8BDD</h2><button id="callBack" type="button">\u8FD4\u56DE\u9875\u9762</button><button id="callClose" type="button">\u5173\u95ED</button></div><p class="call-description">\u53CC\u65B9\u9700\u6253\u5F00\u9875\u9762\u3002\u63A5\u542C\u540E\u624D\u7533\u8BF7\u9EA6\u514B\u98CE\u6743\u9650\u3002\u5173\u95ED\u7A97\u53E3\u3001\u5207\u5230\u540E\u53F0\u6216\u9000\u51FA\u767B\u5F55\u4F1A\u7ED3\u675F\u901A\u8BDD\uFF1B\u8FD9\u91CC\u4E0D\u4F1A\u62E8\u6253\u7535\u8BDD\u53F7\u7801\u3002</p><p id="callCapability"></p><div id="callContent"></div><p id="callStatus" role="status" aria-live="polite"></p><button id="callListen" type="button" hidden>\u70B9\u51FB\u6536\u542C\u5BF9\u65B9\u58F0\u97F3</button><button id="callReminder" type="button">\u6539\u7528\u7AD9\u5185\u8054\u7CFB\u63D0\u9192</button><div id="callMediaControls" hidden><button id="callMute" type="button">\u9759\u97F3\u9EA6\u514B\u98CE</button><button id="callCamera" type="button" hidden>\u5F00\u542F\u6211\u7684\u6444\u50CF\u5934</button><p id="callMediaStatus" role="status"></p><div class="call-video-grid"><div id="callRemoteVideo" aria-label="\u5BB6\u4EBA\u753B\u9762" hidden></div><div id="callLocalVideo" aria-label="\u6211\u7684\u753B\u9762" hidden></div></div></div><div id="callAudio"></div>';
    document.body.append(dialog);
    audio = document.createElement("audio");
    audio.autoplay = false;
    audio.controls = false;
    audio.setAttribute("playsinline", "");
    el("callAudio").append(audio);
    el("callBack").onclick = back;
    el("callClose").onclick = () => {
      end("hangup", "\u7A97\u53E3\u5DF2\u5173\u95ED\uFF0C\u901A\u8BDD\u5DF2\u7ED3\u675F\u3002");
      dialog == null ? void 0 : dialog.close();
    };
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      end("hangup", "\u7A97\u53E3\u5DF2\u5173\u95ED\uFF0C\u901A\u8BDD\u5DF2\u7ED3\u675F\u3002");
      dialog == null ? void 0 : dialog.close();
    });
    dialog.addEventListener("close", () => {
      if (dialog && !dialog.open && !minimized && (call || retryStart)) end("hangup", "\u7A97\u53E3\u5DF2\u5173\u95ED\uFF0C\u901A\u8BDD\u5DF2\u7ED3\u675F\u3002");
    });
    el("callListen").onclick = () => run && (run.media ? run.media.resume() : play(run));
    el("callMute").onclick = () => {
      try {
        mute();
      } catch (error) {
        status(error.message);
      }
    };
    el("callCamera").onclick = () => (run == null ? void 0 : run.media) ? run.media.toggleCamera() : toggleWebCamera(run);
    el("callReminder").onclick = () => {
      var _a;
      if (call) return;
      end("cancelled", "");
      dialog.close();
      (_a = globalThis.MemoryContact) == null ? void 0 : _a.open();
    };
    notice = document.createElement("button");
    notice.id = "familyCallNotice";
    notice.type = "button";
    notice.hidden = true;
    notice.setAttribute("aria-live", "polite");
    notice.onclick = () => open();
    document.body.append(notice);
  }
  async function request(action, data, token = identity, observe) {
    const monotonic = () => {
      var _a, _b, _c;
      return (_c = (_b = (_a = globalThis.performance) == null ? void 0 : _a.now) == null ? void 0 : _b.call(_a)) != null ? _c : Date.now();
    }, started = monotonic();
    const controller = new AbortController();
    controllers.add(controller);
    let timer, onAbort;
    const stopped = new Promise((resolve, reject) => {
      onAbort = () => reject(Object.assign(new Error("\u901A\u8BDD\u8BF7\u6C42\u5DF2\u505C\u6B62\u6216\u8D85\u65F6\u3002"), { name: "AbortError" }));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => controller.abort(), 12e3);
    });
    try {
      return await Promise.race([Promise.resolve(api(action, data, token, { signal: controller.signal })).then((result) => {
        observe == null ? void 0 : observe(result);
        return Number.isFinite(result == null ? void 0 : result.serverTime) ? __spreadProps(__spreadValues({}, result), { serverTime: result.serverTime + Math.max(0, monotonic() - started) }) : result;
      }), stopped]);
    } catch (error) {
      diagnose("request-" + (["callState", "callStart", "callAccept", "callReject", "callEnd", "callIce", "callSignal", "callConnection", "callCancelStart"].includes(action) ? action : "unknown"), error);
      throw error;
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      controllers.delete(controller);
    }
  }
  const pendingMessage = "\u672C\u673A\u901A\u8BDD\u4E0E\u9EA6\u514B\u98CE\u5DF2\u5173\u95ED\uFF0C\u670D\u52A1\u5668\u5C1A\u672A\u786E\u8BA4\u7ED3\u675F\uFF1B\u6062\u590D\u8FDE\u63A5\u540E\u5C06\u91CD\u8BD5\u3002";
  const terminationMessage = (pending) => mediaClosures.size ? [...mediaClosures].every((media) => media.localAudioStopped()) ? "\u9EA6\u514B\u98CE\u5DF2\u5173\u95ED\uFF1B\u672C\u5730\u97F3\u9891\u7EC4\u4EF6\u9000\u51FA\u5C1A\u672A\u786E\u8BA4\uFF0C\u8BF7\u786E\u8BA4\u505C\u6B62\u3002" : "\u505C\u6B62\u6536\u97F3\u5C1A\u672A\u786E\u8BA4\uFF0C\u8BF7\u786E\u8BA4\u505C\u6B62\u3002" : [stopReason, pending ? pendingMessage : "\u670D\u52A1\u5668\u5DF2\u786E\u8BA4\u547C\u53EB\u7ED3\u675F\uFF0C\u672C\u673A\u9EA6\u514B\u98CE\u5DF2\u5173\u95ED\u3002"].filter(Boolean).join(" ");
  async function closeMedia(media) {
    mediaClosures.add(media);
    reportStage("family-stop-pending");
    try {
      if (await media.stop()) mediaClosures.delete(media);
    } catch (_) {
    }
    reportStage(mediaClosures.size ? "family-stop-pending" : "family-local-released");
    if (dialog) {
      render();
      if (!call) status(terminationMessage(hasPendingCancellations(identity)));
    }
  }
  function pruneTerminations() {
    for (const [key, entry] of terminations) if (!entry.inFlight && Date.now() - entry.createdAt > 864e5) terminations.delete(key);
  }
  function hasPendingCancellations(token = auth()) {
    pruneTerminations();
    return [...terminations.values()].some((entry) => entry.token === token);
  }
  function canStart(token = auth()) {
    pruneTerminations();
    return Boolean(token) && !mediaClosures.size && terminations.size < 20 && !hasPendingCancellations(token);
  }
  async function terminateEntry(key, entry) {
    var _a, _b, _c;
    const controller = new AbortController();
    let timer;
    try {
      const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(Error("termination timeout"));
        }, 4e3);
      });
      let result, otherDevice = false;
      try {
        result = await Promise.race([api(entry.action, entry.data, entry.token, { signal: controller.signal }), timeout]);
      } catch (error) {
        if (entry.action !== "callReject" || ![403, 409].includes(error.status) || controller.signal.aborted) throw error;
        result = await Promise.race([api("callState", { id: entry.data.id }, entry.token, { signal: controller.signal }), timeout]);
        otherDevice = ((_a = result == null ? void 0 : result.call) == null ? void 0 : _a.id) === entry.data.id && result.call.direction === "incoming" && result.call.canControl === false && ["accepted", "connecting"].includes(result.call.status);
      }
      const confirmed = otherDevice || (entry.action === "callCancelStart" ? (result == null ? void 0 : result.cancelled) === true : ((_b = result == null ? void 0 : result.call) == null ? void 0 : _b.id) === entry.data.id && TERMINAL.has(result.call.status));
      if (!confirmed) throw Error("termination unconfirmed");
      if ((result == null ? void 0 : result.callId) || ((_c = result == null ? void 0 : result.call) == null ? void 0 : _c.id)) dismissed.add(result.callId || result.call.id);
      terminations.delete(key);
      if (!otherDevice) reportStage("family-server-ended");
      if (identity === entry.token && !call && !busy && !hasPendingCancellations(entry.token)) status(otherDevice ? "\u5DF2\u7531\u53E6\u4E00\u8BBE\u5907\u63A5\u542C\uFF0C\u672C\u673A\u4E0D\u518D\u53C2\u4E0E\u3002" : terminationMessage(false));
    } catch (e) {
      reportStage("family-server-end-pending");
      if (identity === entry.token && !call) status(terminationMessage(true));
    } finally {
      clearTimeout(timer);
      entry.inFlight = false;
      entry.promise = null;
    }
  }
  async function flushTerminations(token) {
    pruneTerminations();
    const pending = [];
    for (const [key, entry] of terminations) {
      if (entry.token !== token) continue;
      if (!entry.inFlight) {
        entry.inFlight = true;
        entry.promise = terminateEntry(key, entry);
      }
      pending.push(entry.promise);
      if (pending.length >= 2) break;
    }
    await Promise.all(pending);
  }
  function queueTermination(action, data, token) {
    if (!token) return false;
    pruneTerminations();
    const key = token + ":" + action + ":" + (data.id || data.requestId);
    if (!terminations.has(key)) {
      if (terminations.size >= 20) {
        if (identity === token) status("\u5F85\u786E\u8BA4\u7684\u7ED3\u675F\u8BF7\u6C42\u8F83\u591A\uFF0C\u8BF7\u6062\u590D\u8FDE\u63A5\u540E\u91CD\u8BD5\u3002");
        return false;
      }
      terminations.set(key, { action, data, token, createdAt: Date.now(), inFlight: false, promise: null });
    }
    if (data.id) dismissed.add(data.id);
    flushTerminations(token);
    return true;
  }
  function bestEffortEnd(id, token, reason, action = "callEnd") {
    if (!id) return false;
    return queueTermination(action, action === "callReject" ? { id } : { id, reason }, token);
  }
  function cancelStart(requestId, token = auth()) {
    if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) return false;
    return queueTermination("callCancelStart", { requestId }, token);
  }
  function cancelPendingStart(token) {
    if (!retryStart || !token) return;
    cancelStart(retryStart.requestId, token);
  }
  function release() {
    var _a, _b;
    stopRing();
    epoch++;
    clearTimeout(pollTimer);
    clearTimeout(deadlineTimer);
    pollTimer = null;
    deadlineTimer = null;
    for (const controller of controllers) controller.abort();
    controllers.clear();
    checking = false;
    busy = false;
    const old = run;
    run = null;
    if (old) reportStage("family-stop-request");
    if (old) {
      if (old.mediaController) old.mediaController.abort();
      clearTimeout(old.statsTimer);
      old.statsPrevious = null;
      clearTimeout(old.connectTimer);
      clearTimeout(old.iceTimer);
      clearTimeout(old.disconnectTimer);
      if (old.media) void closeMedia(old.media);
      else if ((_a = old.local) == null ? void 0 : _a.nativeAudio) {
        const local = old.local, pending = { stop: () => local.release().then(() => true, () => false), localAudioStopped: () => local.getAudioTracks().every((t) => t.readyState === "ended") };
        void closeMedia(pending);
      }
      if (old.pc) {
        old.pc.ontrack = null;
        old.pc.onicecandidate = null;
        old.pc.onconnectionstatechange = null;
        old.pc.oniceconnectionstatechange = null;
        old.pc.onicecandidateerror = null;
        old.pc.close();
      }
      for (const stream of [old.local, old.remote, old.camera, old.remoteVideo]) stream == null ? void 0 : stream.getTracks().forEach((track) => {
        track.onended = null;
        track.stop();
      });
      old.pendingIce = [];
      old.seen.clear();
      if (!old.media && !((_b = old.local) == null ? void 0 : _b.nativeAudio)) reportStage("family-local-released");
    }
    for (const id of ["callLocalVideo", "callRemoteVideo"]) {
      const view = el(id);
      if (view) {
        for (const video of view.querySelectorAll("video")) {
          video.pause();
          video.srcObject = null;
        }
        view.replaceChildren();
      }
    }
    if (audio) {
      audio.pause();
      audio.srcObject = null;
    }
    if (el("callListen")) el("callListen").hidden = true;
    for (const id of ["callMediaControls", "callCamera", "callLocalVideo", "callRemoteVideo"]) if (el(id)) el(id).hidden = true;
    if (el("callMediaStatus")) el("callMediaStatus").textContent = "";
    if (el("callMute")) el("callMute").textContent = "\u9759\u97F3\u9EA6\u514B\u98CE";
  }
  function end(reason = "hangup", message = "\u901A\u8BDD\u5DF2\u7ED3\u675F\u3002", notify = true) {
    if (reason === "failed") reportStage("family-media-failed");
    const old = call, token = identity;
    stopReason = message.replace(/通话已结束/g, "\u672C\u673A\u901A\u8BDD\u5DF2\u505C\u6B62");
    if (old) dismissed.add(old.id);
    if (notify) cancelPendingStart(token);
    mediaIntent.clear();
    release();
    minimized = false;
    call = null;
    retryStart = null;
    render();
    status(message);
    if (notify && old && LIVE.has(old.status)) {
      if (old.canControl) bestEffortEnd(old.id, token, reason);
      else if (old.direction === "incoming" && old.status === "ringing") bestEffortEnd(old.id, token, reason, "callReject");
    }
    if (hasPendingCancellations(token) || mediaClosures.size) status(terminationMessage(hasPendingCancellations(token)));
  }
  function dispose() {
    end("hangup", "", true);
    dialog == null ? void 0 : dialog.close();
    dialog == null ? void 0 : dialog.remove();
    notice == null ? void 0 : notice.remove();
    dialog = null;
    notice = null;
    audio = null;
    identity = "";
    capabilities = null;
    members = [];
    calls = [];
    selected = "";
    lastCheck = 0;
    dismissed.clear();
  }
  function button(text, handler, disabled = false) {
    const result = document.createElement("button");
    result.type = "button";
    result.textContent = text;
    result.disabled = disabled;
    result.onclick = handler;
    return result;
  }
  function render() {
    if (!dialog) return;
    const reason = unsupported() || (!(capabilities == null ? void 0 : capabilities.enabled) ? (capabilities == null ? void 0 : capabilities.reason) || "\u6B63\u5728\u68C0\u67E5\u901A\u8BDD\u914D\u7F6E\u2026" : "\u8BED\u97F3\u901A\u8BDD\u5DF2\u914D\u7F6E\uFF1B\u5B9E\u9645\u8FDE\u63A5\u53D6\u51B3\u4E8E\u53CC\u65B9\u7F51\u7EDC\u4E0E\u9EA6\u514B\u98CE\u6743\u9650\u3002");
    el("callCapability").textContent = reason;
    el("callClose").textContent = call ? "\u6302\u65AD\u5E76\u5173\u95ED" : "\u5173\u95ED";
    el("callReminder").disabled = Boolean(call);
    el("callReminder").hidden = Boolean(call);
    el("callCapability").hidden = Boolean(run == null ? void 0 : run.connected);
    const description = dialog.querySelector(".call-description");
    if (description) description.hidden = Boolean(run == null ? void 0 : run.connected);
    const box = el("callContent");
    box.replaceChildren();
    if (mediaClosures.size) {
      const retry = button("\u786E\u8BA4\u901A\u8BDD\u5DF2\u505C\u6B62", async () => {
        await Promise.all([...mediaClosures].map(closeMedia));
        status(terminationMessage(hasPendingCancellations(identity)));
      });
      retry.id = "callConfirmStopped";
      box.append(retry);
    }
    if (call && LIVE.has(call.status)) {
      const name = call.direction === "incoming" ? call.from.name : call.to.name;
      const title = document.createElement("p");
      title.textContent = `${call.direction === "incoming" ? "\u6765\u81EA" : "\u547C\u53EB"} ${name}`;
      box.append(title);
      if (call.status === "ringing") {
        const text = document.createElement("p");
        text.textContent = call.direction === "incoming" ? "\u5BB6\u4EBA\u6B63\u5728\u547C\u53EB\u4F60\u3002\u70B9\u51FB\u63A5\u542C\u540E\u4F1A\u7533\u8BF7\u9EA6\u514B\u98CE\u6743\u9650\u3002" : "\u6B63\u5728\u547C\u53EB\uFF0C\u7B49\u5F85\u5BB6\u4EBA\u4E3B\u52A8\u63A5\u542C\u3002\u9EA6\u514B\u98CE\u5C1A\u672A\u5F00\u542F\u3002";
        box.append(text);
        if (call.direction === "incoming") {
          const accept = button("\u63A5\u542C\u8BED\u97F3\u901A\u8BDD", () => respond("callAccept"), busy || !(capabilities == null ? void 0 : capabilities.enabled) || Boolean(unsupported()));
          accept.id = "callAccept";
          const reject = button("\u6682\u4E0D\u65B9\u4FBF", () => respond("callReject"), busy);
          reject.id = "callReject";
          box.append(accept, reject);
        }
      } else if (!call.canControl) {
        const other = document.createElement("p");
        other.textContent = "\u6B64\u901A\u8BDD\u5DF2\u5728\u53E6\u4E00\u53F0\u8BBE\u5907\u63A5\u542C\u3002";
        box.append(other);
      }
      if (call.canControl && !mediaIntent.has(call.id) && (call.direction === "outgoing" || call.status !== "ringing")) {
        const resume = button("\u786E\u8BA4\u7EE7\u7EED\u8FD9\u6B21\u8BED\u97F3\u901A\u8BDD", () => {
          if (!(dialog == null ? void 0 : dialog.open) || !call) return;
          if (!canStart(identity)) return status("\u4E0A\u6B21\u547C\u53EB\u7684\u7ED3\u675F\u6216\u53D6\u6D88\u4ECD\u5F85\u670D\u52A1\u5668\u786E\u8BA4\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002");
          const blocked = mediaBlocked();
          if (blocked) return status(blocked);
          mediaIntent.add(call.id);
          render();
          if (call.status !== "ringing") begin(call);
        }, busy || !(capabilities == null ? void 0 : capabilities.enabled) || Boolean(unsupported()));
        resume.id = "callResume";
        box.append(resume);
      }
      if (call.canControl || call.direction === "outgoing") {
        const hangup = button(call.status === "ringing" ? "\u53D6\u6D88\u547C\u53EB" : "\u6302\u65AD", () => end("hangup"), false);
        hangup.id = "callHangup";
        box.append(hangup);
      }
    } else {
      const label = document.createElement("label");
      label.textContent = "\u9009\u62E9\u5BB6\u5EAD\u6210\u5458";
      const select = document.createElement("select");
      select.id = "callRecipient";
      select.setAttribute("aria-label", "\u901A\u8BDD\u5BF9\u8C61");
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "\u8BF7\u9009\u62E9\u771F\u5B9E\u5BB6\u5EAD\u6210\u5458";
      select.append(empty);
      for (const member of members) {
        const option = document.createElement("option");
        option.value = member.id;
        option.textContent = `${member.name} \xB7 ${member.role === "frame" ? "\u76F8\u6846" : "\u5BB6\u4EBA"} \xB7 ${member.id.slice(-6)}`;
        select.append(option);
      }
      select.value = members.some((member) => member.id === selected) ? selected : "";
      select.disabled = busy;
      select.onchange = () => {
        cancelPendingStart(identity);
        selected = select.value;
        retryStart = null;
        render();
      };
      label.append(select);
      box.append(label);
      const chosen = members.find((member) => member.id === selected), summary = document.createElement("p");
      summary.textContent = chosen ? `\u786E\u8BA4\u547C\u53EB ${chosen.name}\uFF08${chosen.id.slice(-6)}\uFF09\u8FDB\u884C\u5B9E\u65F6\u8BED\u97F3\u901A\u8BDD\u3002\u5BF9\u65B9\u63A5\u542C\u540E\uFF0C\u53CC\u65B9\u624D\u4F1A\u5F00\u542F\u9EA6\u514B\u98CE\u3002` : "\u8BF7\u9009\u62E9\u901A\u8BDD\u5BF9\u8C61\uFF0C\u518D\u786E\u8BA4\u53D1\u8D77\u547C\u53EB\u3002";
      box.append(summary);
      const start2 = button("\u786E\u8BA4\u547C\u53EB\u8FD9\u4F4D\u5BB6\u4EBA", initiate, busy || mediaClosures.size > 0 || !chosen || !(capabilities == null ? void 0 : capabilities.enabled) || Boolean(unsupported()));
      start2.id = "callStart";
      box.append(start2);
    }
    if (!call) {
      const history = calls.filter((item) => TERMINAL.has(item.status)).slice(0, 5);
      if (history.length) {
        const title = document.createElement("h3");
        title.textContent = "\u6700\u8FD1\u901A\u8BDD";
        box.append(title);
        for (const item of history) {
          const row = document.createElement("p"), peer = item.direction === "incoming" ? item.from.name : item.to.name;
          row.textContent = peer + " \xB7 " + (item.status === "expired" ? "\u672A\u63A5\u901A" : labels[item.status]);
          box.append(row);
        }
      }
    }
    const incoming = calls.find((item) => item.direction === "incoming" && item.status === "ringing" && !dismissed.has(item.id));
    notice.hidden = dialog.open || !incoming && !minimized;
    notice.textContent = minimized ? "\u901A\u8BDD\u9762\u677F\u5DF2\u6536\u8D77 \xB7 \u70B9\u51FB\u8FD4\u56DE\u901A\u8BDD" : incoming ? `${incoming.from.name} \u6B63\u5728\u547C\u53EB\u4F60 \xB7 \u70B9\u51FB\u63A5\u542C` : "";
  }
  function schedule() {
    clearTimeout(pollTimer);
    pollTimer = null;
    if (!auth() || document.hidden || !call && !(dialog == null ? void 0 : dialog.open) && !minimized) return;
    pollTimer = setTimeout(() => refresh(true), call ? Math.max(1e3, Math.min(5e3, (capabilities == null ? void 0 : capabilities.pollIntervalMs) || 1500)) : 5e3);
  }
  function setDeadline(value, serverTime) {
    clearTimeout(deadlineTimer);
    const expires = value.status === "ringing" ? value.ringExpiresAt : value.expiresAt;
    if (!Number.isFinite(expires)) return;
    const id = value.id, generation = epoch, remaining = Math.max(0, expires - (Number.isFinite(serverTime) ? serverTime : Date.now()));
    deadlineTimer = setTimeout(() => {
      if ((call == null ? void 0 : call.id) === id && generation === epoch) end("hangup", "\u547C\u53EB\u6216\u901A\u8BDD\u5DF2\u5230\u671F\u3002");
    }, remaining);
  }
  async function apply(result, token, generation) {
    if (!current(token, generation)) return;
    if (result.capabilities) capabilities = result.capabilities;
    if (result.members) members = result.members;
    if (result.calls) {
      calls = result.calls;
      if (globalThis.UnseenFamilyNotifications) UnseenFamilyNotifications.updateCalls(calls);
    }
    if (!(capabilities == null ? void 0 : capabilities.enabled) || unsupported()) {
      if (call) end("failed", unsupported() || (capabilities == null ? void 0 : capabilities.reason) || "\u8BED\u97F3\u901A\u8BDD\u5DF2\u505C\u7528\u3002");
      render();
      return;
    }
    const next = result.call || call && calls.find((item) => item.id === call.id) || !call && calls.find((item) => LIVE.has(item.status) && !dismissed.has(item.id));
    if (next && !dismissed.has(next.id)) {
      if (!call && !(dialog == null ? void 0 : dialog.open) && !minimized && (next.direction === "outgoing" || next.status !== "ringing")) {
        render();
        return;
      }
      if (call && call.id !== next.id) return;
      if ((call == null ? void 0 : call.revision) > next.revision) return;
      call = next;
      ring();
      const expires = next.status === "ringing" ? next.ringExpiresAt : next.expiresAt;
      if (LIVE.has(next.status) && Number.isFinite(expires) && expires <= (Number.isFinite(result.serverTime) ? result.serverTime : Date.now())) return end("hangup", "\u547C\u53EB\u6216\u901A\u8BDD\u5DF2\u5230\u671F\u3002");
      setDeadline(next, result.serverTime);
      if (!LIVE.has(next.status)) {
        end("hangup", labels[next.status] || "\u901A\u8BDD\u5DF2\u7ED3\u675F\u3002", false);
        return;
      }
      render();
      if (next.status !== "ringing" && next.canControl && ((dialog == null ? void 0 : dialog.open) || minimized) && !document.hidden && mediaIntent.has(next.id)) {
        if (!run) begin(next);
        else await negotiate(run, next.peer);
      }
    } else render();
  }
  async function refresh(force = false) {
    const token = auth();
    if (!token) {
      dispose();
      return;
    }
    if (identity && identity !== token) dispose();
    identity = token;
    ensure();
    if (checking || busy || document.hidden || !force && Date.now() - lastCheck < 1400) return;
    checking = true;
    lastCheck = Date.now();
    const generation = epoch;
    try {
      await flushTerminations(token);
      if (!current(token, generation)) return;
      const result = await request("callState", call ? { id: call.id } : {}, token);
      await apply(result, token, generation);
    } catch (error) {
      if (current(token, generation)) {
        if (call) end("failed", "\u901A\u8BDD\u72B6\u6001\u540C\u6B65\u5931\u8D25\uFF0C\u9EA6\u514B\u98CE\u5DF2\u5173\u95ED\uFF0C\u8BF7\u91CD\u65B0\u547C\u53EB\u3002");
        else status(error.name === "AbortError" ? "\u8BFB\u53D6\u901A\u8BDD\u72B6\u6001\u8D85\u65F6\uFF0C\u8BF7\u91CD\u8BD5\u3002" : error.message);
      }
    } finally {
      if (current(token, generation)) {
        checking = false;
        schedule();
      }
    }
  }
  async function initiate() {
    var _a, _b;
    if (busy || call || !(capabilities == null ? void 0 : capabilities.enabled) || unsupported()) return;
    if (!canStart(identity)) return status("\u4E0A\u6B21\u547C\u53EB\u7684\u7ED3\u675F\u6216\u53D6\u6D88\u4ECD\u5F85\u670D\u52A1\u5668\u786E\u8BA4\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002");
    const blocked = mediaBlocked();
    if (blocked) return status(blocked);
    stopReason = "";
    const targetId = (_a = el("callRecipient")) == null ? void 0 : _a.value;
    if (!members.some((member) => member.id === targetId)) return status("\u8BF7\u9009\u62E9\u771F\u5B9E\u5BB6\u5EAD\u6210\u5458\u3002");
    if (!retryStart || retryStart.targetId !== targetId) retryStart = { targetId, requestId: crypto.randomUUID() };
    const token = identity, generation = epoch;
    busy = true;
    render();
    status("\u6B63\u5728\u547C\u53EB\u5BB6\u4EBA\u2026");
    try {
      const result = await request("callStart", retryStart, token, (result2) => {
        var _a2;
        if (!current(token, generation)) bestEffortEnd(result2.callId || ((_a2 = result2.call) == null ? void 0 : _a2.id), token, "cancelled");
      });
      if (current(token, generation) && ((dialog == null ? void 0 : dialog.open) || minimized)) mediaIntent.add(result.callId || ((_b = result.call) == null ? void 0 : _b.id));
      await apply(result, token, generation);
      if (current(token, generation)) retryStart = null;
    } catch (error) {
      if (current(token, generation)) status(error.name === "AbortError" ? "\u5C1A\u672A\u786E\u8BA4\u547C\u53EB\u7ED3\u679C\uFF0C\u53EF\u91CD\u8BD5\u540C\u4E00\u6B21\u547C\u53EB\u3002" : error.message);
    } finally {
      if (current(token, generation)) {
        busy = false;
        render();
        schedule();
      }
    }
  }
  async function respond(action, expectedId) {
    if (expectedId && expectedId !== (call == null ? void 0 : call.id)) throw Error("\u5F53\u524D\u6765\u7535\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u786E\u8BA4");
    if (busy || !call || call.direction !== "incoming" || call.status !== "ringing") {
      if (expectedId) throw Error("\u5F53\u524D\u6CA1\u6709\u53EF\u5904\u7406\u7684\u6765\u7535");
      return;
    }
    if (action === "callAccept" && !canStart(identity)) {
      const message = "\u4E0A\u6B21\u547C\u53EB\u7684\u7ED3\u675F\u6216\u53D6\u6D88\u4ECD\u5F85\u670D\u52A1\u5668\u786E\u8BA4\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002";
      if (expectedId) throw Error(message);
      return status(message);
    }
    const blocked = action === "callAccept" && mediaBlocked();
    if (blocked) {
      if (expectedId) throw Error(blocked);
      return status(blocked);
    }
    if (action === "callAccept") {
      stopRing();
      mediaIntent.add(call.id);
    }
    const token = identity, generation = epoch, id = call.id;
    busy = true;
    render();
    try {
      const result = await request(action, { id }, token, (result2) => {
        var _a;
        if (action === "callAccept" && !current(token, generation)) bestEffortEnd(result2.callId || ((_a = result2.call) == null ? void 0 : _a.id), token, "cancelled");
      });
      await apply(result, token, generation);
    } catch (error) {
      if (current(token, generation)) {
        status(error.message);
        refresh(true);
      }
      if (expectedId) throw error;
    } finally {
      if (current(token, generation)) {
        busy = false;
        render();
        schedule();
      }
    }
  }
  async function play(r) {
    var _a;
    if (!liveRun(r) || !((_a = r.remote) == null ? void 0 : _a.getAudioTracks().some((track) => track.readyState === "live"))) return;
    try {
      await audio.play();
      if (!liveRun(r)) return;
      r.playing = true;
      reportStage("family-play-ready");
      el("callListen").hidden = true;
      connected(r);
    } catch (e) {
      if (liveRun(r)) {
        r.playing = false;
        reportStage("family-play-blocked");
        el("callListen").hidden = false;
        status("\u5DF2\u6536\u5230\u5BF9\u65B9\u97F3\u8F68\uFF0C\u6D4F\u89C8\u5668\u5C1A\u672A\u64AD\u653E\u58F0\u97F3\u3002\u8BF7\u70B9\u51FB\u201C\u6536\u542C\u5BF9\u65B9\u58F0\u97F3\u201D\u3002");
      }
    }
  }
  function connected(r) {
    var _a;
    if (!liveRun(r)) return;
    if (transportState(r.pc) === "connected" && r.playing && ((_a = r.remote) == null ? void 0 : _a.getAudioTracks().some((track) => track.readyState === "live"))) {
      diagnose("connected", null, r.pc);
      r.connected = true;
      render();
      clearTimeout(r.connectTimer);
      el("callMediaControls").hidden = false;
      el("callCamera").hidden = !r.videoSender;
      status("\u8BED\u97F3\u5DF2\u8FDE\u63A5\uFF0C\u6B63\u5728\u4E0E\u5BB6\u4EBA\u901A\u8BDD\u3002");
    } else status("\u5BF9\u65B9\u5DF2\u63A5\u542C\uFF0C\u6B63\u5728\u5EFA\u7ACB\u97F3\u9891\u8FDE\u63A5\u2026");
  }
  function videoView(id, stream) {
    const view = el(id);
    let video = view.querySelector("video");
    if (!video) {
      video = document.createElement("video");
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.style.width = "100%";
      view.appendChild(video);
    }
    video.srcObject = stream;
    view.hidden = !stream;
    if (stream) video.play().catch(() => {
      if (run) el("callMediaStatus").textContent = "\u89C6\u9891\u672A\u81EA\u52A8\u64AD\u653E\uFF0C\u8BF7\u91CD\u65B0\u6253\u5F00\u901A\u8BDD\u9875\u9762\u3002";
    });
  }
  function replaceCameraTrack(r, track, generation) {
    const previous = r.cameraReplace || Promise.resolve();
    const next = previous.catch(() => {
    }).then(async () => {
      if (!liveRun(r) || r.cameraGeneration !== generation) return;
      await r.videoSender.replaceTrack(track);
    });
    r.cameraReplace = next;
    return next;
  }
  async function toggleWebCamera(r) {
    var _a, _b, _c;
    if (!r || !liveRun(r) || !r.connected || !r.videoSender) return;
    const generation = (r.cameraGeneration || 0) + 1;
    r.cameraGeneration = generation;
    if (r.cameraPending || r.camera) {
      r.cameraPending = false;
      (_a = r.camera) == null ? void 0 : _a.getTracks().forEach((track) => track.stop());
      r.camera = null;
      videoView("callLocalVideo", null);
      el("callCamera").textContent = "\u5F00\u542F\u6211\u7684\u6444\u50CF\u5934";
      el("callMediaStatus").textContent = "\u4F60\u7684\u6444\u50CF\u5934\u5DF2\u5173\u95ED\u3002";
      try {
        await replaceCameraTrack(r, null, generation);
      } catch (e) {
      }
      return;
    }
    const blocked = ((_b = globalThis.FrameCameraPolicy) == null ? void 0 : _b.reason()) || mediaBlocked();
    if (blocked) {
      el("callMediaStatus").textContent = blocked;
      return;
    }
    r.cameraPending = true;
    el("callCamera").textContent = "\u53D6\u6D88\u5F00\u542F\u6444\u50CF\u5934";
    el("callMediaStatus").textContent = "\u6B63\u5728\u7B49\u5F85\u6444\u50CF\u5934\u6743\u9650\u2026";
    let stream;
    const valid = () => liveRun(r) && r.cameraGeneration === generation && !document.hidden;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 24 }, facingMode: "user" } });
      if (!valid()) {
        stream.getTracks().forEach((track2) => track2.stop());
        return;
      }
      const denied = ((_c = globalThis.FrameCameraPolicy) == null ? void 0 : _c.reason()) || mediaBlocked();
      if (denied) throw Error(denied);
      const track = stream.getVideoTracks()[0];
      if (!track) throw Error("\u672A\u53D6\u5F97\u6444\u50CF\u5934\u753B\u9762");
      r.camera = stream;
      await replaceCameraTrack(r, track, generation);
      if (!valid()) {
        stream.getTracks().forEach((track2) => track2.stop());
        return;
      }
      track.onended = () => {
        if (valid()) toggleWebCamera(r);
      };
      videoView("callLocalVideo", stream);
      el("callCamera").textContent = "\u5173\u95ED\u6211\u7684\u6444\u50CF\u5934";
      el("callMediaStatus").textContent = "\u4F60\u7684\u753B\u9762\u6B63\u5728\u53D1\u9001\u7ED9\u5BB6\u4EBA\u3002";
    } catch (error) {
      stream == null ? void 0 : stream.getTracks().forEach((track) => track.stop());
      if (valid()) {
        r.camera = null;
        el("callCamera").textContent = "\u5F00\u542F\u6211\u7684\u6444\u50CF\u5934";
        el("callMediaStatus").textContent = "\u6444\u50CF\u5934\u672A\u5F00\u542F\uFF0C\u8BED\u97F3\u7EE7\u7EED\u3002" + (error.message || "");
      }
    } finally {
      if (valid()) r.cameraPending = false;
    }
  }
  async function sendIce(r) {
    if (!liveRun(r) || !r.localDescriptionSent || r.sendingIce) return;
    r.sendingIce = true;
    try {
      while (liveRun(r) && (r.pendingIce.length || r.iceComplete && !r.completeSent)) {
        const batch = r.pendingIce.slice(0, 8), complete = r.iceComplete && r.pendingIce.length <= 8;
        await request("callSignal", __spreadValues(__spreadValues({ id: r.id }, batch.length ? { candidates: batch } : {}), complete ? { iceComplete: true } : {}), r.token);
        if (!liveRun(r)) return;
        r.pendingIce.splice(0, batch.length);
        if (complete) r.completeSent = true;
      }
    } catch (error) {
      if (liveRun(r)) {
        diagnose("signaling", error, r.pc);
        end("failed", mediaFailure("signaling", error));
      }
    } finally {
      if (liveRun(r)) r.sendingIce = false;
    }
  }
  async function negotiate(r, peer) {
    var _a, _b;
    if (!liveRun(r) || !r.pc || !r.local || r.negotiating) return;
    r.negotiating = true;
    try {
      if ((peer == null ? void 0 : peer.description) && !r.pc.remoteDescription) {
        const expected = call.direction === "outgoing" ? "answer" : "offer";
        if (peer.description.type !== expected) throw Error("\u901A\u8BDD\u4FE1\u4EE4\u7C7B\u578B\u65E0\u6548");
        await r.pc.setRemoteDescription(peer.description);
        if (!liveRun(r)) return;
        if (capabilities.videoCall && call.direction === "incoming") {
          const video = (_b = (_a = r.pc).getTransceivers) == null ? void 0 : _b.call(_a).find((item) => item.receiver.track.kind === "video");
          if (video) {
            video.direction = "sendrecv";
            r.videoSender = video.sender;
          }
        }
      }
      if (call.direction === "incoming" && r.pc.remoteDescription && !r.localDescriptionSent) {
        const description = await r.pc.createAnswer();
        if (!liveRun(r)) return;
        await r.pc.setLocalDescription(description);
        if (!liveRun(r)) return;
        await request("callSignal", { id: r.id, description: { type: "answer", sdp: r.pc.localDescription.sdp } }, r.token);
        if (!liveRun(r)) return;
        r.localDescriptionSent = true;
        sendIce(r);
      }
      if (r.pc.remoteDescription) {
        for (const item of (peer == null ? void 0 : peer.candidates) || []) {
          if (r.seen.has(item.seq)) continue;
          if (r.seen.size >= 48) throw Error("\u901A\u8BDD\u5019\u9009\u6570\u91CF\u8D85\u9650");
          await addRemoteCandidate(r.pc, item.candidate);
          if (!liveRun(r)) return;
          r.seen.add(item.seq);
        }
        if ((peer == null ? void 0 : peer.iceComplete) && !r.remoteComplete) {
          await addRemoteCandidate(r.pc, null);
          if (!liveRun(r)) return;
          r.remoteComplete = true;
        }
      }
    } catch (error) {
      if (liveRun(r)) {
        diagnose("answer", error, r.pc);
        end("failed", mediaFailure("answer", error));
      }
    } finally {
      if (liveRun(r)) r.negotiating = false;
    }
  }
  async function begin(value) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    if (!(dialog == null ? void 0 : dialog.open) && !minimized || document.hidden || !mediaIntent.has(value.id)) return;
    const blocked = mediaBlocked();
    if (blocked) return end("failed", blocked);
    (_a = globalThis.UnseenStopPlayback) == null ? void 0 : _a.call(globalThis);
    (_c = globalThis.parent) == null ? void 0 : _c.postMessage({ type: "assistant-media-busy" }, (_b = globalThis.location) == null ? void 0 : _b.origin);
    (_d = globalThis.MemoryCamera) == null ? void 0 : _d.stop();
    (_e = globalThis.MemoryPresence) == null ? void 0 : _e.close("call");
    (_f = globalThis.MemoryAI) == null ? void 0 : _f.pauseForCall();
    document.querySelectorAll("audio").forEach((item) => item.pause());
    if (typeof frameAudio !== "undefined") frameAudio == null ? void 0 : frameAudio.pause();
    stopReason = "";
    const r = { id: value.id, token: identity, generation: epoch, pc: null, local: null, remote: null, playing: false, seen: /* @__PURE__ */ new Set(), pendingIce: [], localCount: 0, mediaController: new AbortController() };
    run = r;
    status("\u5BF9\u65B9\u5DF2\u63A5\u542C\uFF0C\u8BF7\u5141\u8BB8\u9EA6\u514B\u98CE\u3002\u6B63\u5728\u5EFA\u7ACB\u97F3\u9891\u8FDE\u63A5\u2026");
    r.connectTimer = setTimeout(() => {
      if (liveRun(r)) end("failed", "\u97F3\u9891\u8FDE\u63A5\u8D85\u65F6\uFF0C\u9EA6\u514B\u98CE\u5DF2\u5173\u95ED\uFF0C\u8BF7\u91CD\u8BD5\u3002");
    }, 45e3);
    try {
      if (capabilities.mode === "trtc-audio") {
        reportStage("family-route-trtc");
        r.stage = "sdk";
        diagnose(r.stage);
        await beginTRTC(r);
        return;
      }
      reportStage("family-route-webrtc");
      r.stage = "relay-config";
      diagnose(r.stage);
      const ice = await request("callIce", { id: r.id }, r.token);
      if (!liveRun(r)) return;
      const blocked2 = mediaBlocked();
      if (blocked2) return end("failed", blocked2);
      if (ice.iceTransportPolicy !== "relay" || !Array.isArray(ice.iceServers) || !ice.iceServers.length || !Number.isFinite(ice.expiresAt) || ice.expiresAt <= (Number.isFinite(ice.serverTime) ? ice.serverTime : Date.now())) throw Error("\u901A\u8BDD\u4E2D\u7EE7\u914D\u7F6E\u4E0D\u53EF\u7528");
      (_h = globalThis.parent) == null ? void 0 : _h.postMessage({ type: "assistant-media-busy" }, (_g = globalThis.location) == null ? void 0 : _g.origin);
      r.stage = "microphone";
      diagnose(r.stage);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      if (!liveRun(r)) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const afterPermission = mediaBlocked();
      if (afterPermission) {
        stream.getTracks().forEach((track) => track.stop());
        return end("failed", afterPermission);
      }
      r.local = stream;
      const pc = new RTCPeerConnection({ iceServers: ice.iceServers, iceTransportPolicy: "relay" });
      r.pc = pc;
      observeAudioCounters(r);
      pc.onicecandidate = (event) => {
        var _a2;
        if (!liveRun(r)) return;
        const raw = ((_a2 = event.candidate) == null ? void 0 : _a2.toJSON) ? event.candidate.toJSON() : event.candidate;
        if (!raw || raw.candidate === "") r.iceComplete = true;
        else {
          if (r.localCount >= Math.min(48, capabilities.maxCandidates || 48)) return end("failed", "\u901A\u8BDD\u7F51\u7EDC\u5019\u9009\u8FC7\u591A\uFF0C\u8BF7\u91CD\u65B0\u547C\u53EB\u3002");
          r.pendingIce.push(__spreadValues({ candidate: raw.candidate, sdpMid: raw.sdpMid, sdpMLineIndex: raw.sdpMLineIndex }, raw.usernameFragment ? { usernameFragment: raw.usernameFragment } : {}));
          r.localCount++;
        }
        clearTimeout(r.iceTimer);
        r.iceTimer = setTimeout(() => sendIce(r), 50);
      };
      pc.ontrack = (event) => {
        if (!liveRun(r)) {
          event.track.stop();
          return;
        }
        if (event.track.kind === "video" && capabilities.videoCall) {
          if (!r.remoteVideo) r.remoteVideo = new MediaStream();
          r.remoteVideo.addTrack(event.track);
          const show = () => {
            if (liveRun(r)) videoView("callRemoteVideo", r.remoteVideo);
          };
          event.track.onunmute = show;
          event.track.onmute = event.track.onended = () => {
            if (liveRun(r)) videoView("callRemoteVideo", null);
          };
          if (!event.track.muted) show();
          return;
        }
        if (event.track.kind !== "audio") {
          event.track.stop();
          return;
        }
        reportStage("family-remote-track");
        if (!r.remote) r.remote = new MediaStream();
        if (!r.remote.getTracks().includes(event.track)) r.remote.addTrack(event.track);
        event.track.onended = () => {
          if (liveRun(r)) end("failed", "\u5BF9\u65B9\u97F3\u8F68\u5DF2\u7ED3\u675F\u3002");
        };
        audio.srcObject = r.remote;
        play(r);
      };
      const stateChanged = () => {
        if (!liveRun(r)) return;
        const state = transportState(pc);
        diagnose("transport", null, pc);
        if (state === "failed" || state === "closed") return end("failed", "\u901A\u8BDD\u7F51\u7EDC\u5DF2\u65AD\u5F00\uFF0C\u9EA6\u514B\u98CE\u5DF2\u5173\u95ED\u3002");
        if (state === "disconnected") {
          if (!r.disconnectTimer) r.disconnectTimer = setTimeout(() => {
            r.disconnectTimer = null;
            if (liveRun(r) && transportState(pc) !== "connected") end("failed", "\u901A\u8BDD\u7F51\u7EDC\u672A\u80FD\u6062\u590D\uFF0C\u9EA6\u514B\u98CE\u5DF2\u5173\u95ED\u3002");
          }, 1e4);
          return status("\u901A\u8BDD\u7F51\u7EDC\u6682\u65F6\u4E2D\u65AD\uFF0C\u6B63\u5728\u7B49\u5F85\u6062\u590D\uFF1B\u53EF\u968F\u65F6\u6302\u65AD\u3002");
        }
        clearTimeout(r.disconnectTimer);
        r.disconnectTimer = null;
        connected(r);
      };
      pc.onconnectionstatechange = stateChanged;
      pc.oniceconnectionstatechange = stateChanged;
      pc.onicecandidateerror = () => {
        if (liveRun(r)) diagnose("relay-candidate", { name: "OperationError" }, pc);
      };
      stream.getTracks().forEach((track) => {
        track.onended = () => {
          if (liveRun(r)) end("failed", "\u9EA6\u514B\u98CE\u5DF2\u65AD\u5F00\uFF0C\u901A\u8BDD\u5DF2\u7ED3\u675F\u3002");
        };
        pc.addTrack(track, stream);
      });
      if (value.direction === "outgoing" && capabilities.videoCall && typeof pc.addTransceiver === "function") r.videoSender = pc.addTransceiver("video", { direction: "sendrecv" }).sender;
      if (value.direction === "outgoing") {
        r.stage = "offer";
        diagnose(r.stage);
        const description = await pc.createOffer();
        if (!liveRun(r)) return;
        await pc.setLocalDescription(description);
        if (!liveRun(r)) return;
        await request("callSignal", { id: r.id, description: { type: "offer", sdp: pc.localDescription.sdp } }, r.token);
        if (!liveRun(r)) return;
        r.localDescriptionSent = true;
        sendIce(r);
      }
      await negotiate(r, call == null ? void 0 : call.peer);
      if (liveRun(r)) connected(r);
    } catch (error) {
      if (liveRun(r)) {
        diagnose(r.stage || "media", error, r.pc);
        end("failed", mediaFailure(r.stage, error));
      }
    }
  }
  async function beginTRTC(r) {
    var _a, _b;
    const result = await request("callConnection", { id: r.id }, r.token);
    if (!liveRun(r)) return;
    const blockedBeforePermission = mediaBlocked();
    if (blockedBeforePermission) return end("failed", blockedBeforePermission);
    if (result.provider !== "tencent-trtc" || !result.connection || !Number.isFinite(result.connection.credentialExpiresAt) || result.connection.credentialExpiresAt <= (Number.isFinite(result.serverTime) ? result.serverTime : Date.now())) throw Error("\u901A\u8BDD\u8FDE\u63A5\u914D\u7F6E\u65E0\u6548");
    (_b = globalThis.parent) == null ? void 0 : _b.postMessage({ type: "assistant-media-busy" }, (_a = globalThis.location) == null ? void 0 : _a.origin);
    const nativeAudio = globalThis.UnseenNativeRtc && globalThis.UnseenNativeRtc.available();
    const stream = await (nativeAudio ? globalThis.UnseenNativeRtc.acquire({ signal: r.mediaController.signal, onReservation: (stream2) => {
      r.local = stream2;
    } }) : navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }));
    if (nativeAudio) result.connection.video = false;
    if (!liveRun(r)) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    r.local = stream;
    const blocked = mediaBlocked();
    if (blocked) return end("failed", blocked);
    stream.getTracks().forEach((track) => {
      track.onended = () => {
        if (liveRun(r)) end("failed", "\u9EA6\u514B\u98CE\u5DF2\u65AD\u5F00\uFF0C\u901A\u8BDD\u5DF2\u7ED3\u675F\u3002");
      };
    });
    r.media = MemoryFamilyMedia.create({
      connection: result.connection,
      stream,
      current: () => liveRun(r),
      localView: el("callLocalVideo"),
      remoteView: el("callRemoteVideo"),
      onConnected: () => {
        var _a2;
        if (!liveRun(r)) return;
        diagnose("connected");
        r.connected = true;
        render();
        clearTimeout(r.connectTimer);
        el("callMediaControls").hidden = false;
        el("callCamera").hidden = !result.connection.video;
        const cameraBlocked = (_a2 = globalThis.FrameCameraPolicy) == null ? void 0 : _a2.reason();
        el("callCamera").disabled = !!cameraBlocked;
        if (cameraBlocked) el("callMediaStatus").textContent = cameraBlocked;
        status("\u8BED\u97F3\u5DF2\u8FDE\u63A5\uFF0C\u6B63\u5728\u4E0E\u5BB6\u4EBA\u901A\u8BDD\u3002");
      },
      onFailure: (message) => {
        if (liveRun(r)) end("failed", message);
      },
      onPlayback: (blocked2) => {
        if (!liveRun(r)) return;
        reportStage(blocked2 ? "family-play-blocked" : "family-play-ready");
        el("callListen").hidden = !blocked2;
        if (blocked2) status("\u5DF2\u6536\u5230\u5BF9\u65B9\u97F3\u8F68\uFF0C\u8BF7\u70B9\u51FB\u201C\u6536\u542C\u5BF9\u65B9\u58F0\u97F3\u201D\u3002");
      },
      onCamera: (enabled, pending, message) => {
        if (!liveRun(r)) return;
        el("callCamera").textContent = pending ? "\u53D6\u6D88\u5F00\u542F\u6444\u50CF\u5934" : enabled ? "\u5173\u95ED\u6211\u7684\u6444\u50CF\u5934" : "\u5F00\u542F\u6211\u7684\u6444\u50CF\u5934";
        el("callLocalVideo").hidden = !enabled;
        el("callMediaStatus").textContent = message || (pending ? "\u6B63\u5728\u7B49\u5F85\u6444\u50CF\u5934\u6743\u9650\u2026" : enabled ? "\u4F60\u7684\u753B\u9762\u6B63\u5728\u53D1\u9001\u7ED9\u5BB6\u4EBA\u3002" : "\u4F60\u7684\u6444\u50CF\u5934\u5DF2\u5173\u95ED\u3002");
      }
    });
    await r.media.start();
  }
  function mute() {
    if (!(run == null ? void 0 : run.local)) throw Error("\u76EE\u524D\u6CA1\u6709\u63A5\u901A\u7684\u5BB6\u4EBA\u901A\u8BDD");
    const muted = run.local.getAudioTracks().some((track) => track.enabled);
    run.local.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
    el("callMute").textContent = muted ? "\u6062\u590D\u9EA6\u514B\u98CE" : "\u9759\u97F3\u9EA6\u514B\u98CE";
    el("callMediaStatus").textContent = muted ? "\u9EA6\u514B\u98CE\u5DF2\u9759\u97F3\uFF0C\u4F60\u4ECD\u53EF\u4EE5\u542C\u5230\u5BB6\u4EBA\u3002" : "\u9EA6\u514B\u98CE\u5DF2\u6062\u590D\u3002";
    return muted;
  }
  function hasKeyAction() {
    return Boolean(call && LIVE.has(call.status));
  }
  async function voiceKey() {
    if (!hasKeyAction()) return;
    if (call.direction === "incoming" && call.status === "ringing") {
      const id = call.id;
      await open();
      await respond("callAccept", id);
    } else end("hangup", "\u5DF2\u901A\u8FC7\u5B9E\u4F53\u952E\u6302\u65AD\uFF0C\u672C\u673A\u9EA6\u514B\u98CE\u4E0E\u6444\u50CF\u5934\u5DF2\u5173\u95ED\u3002");
  }
  function back() {
    if (!(dialog == null ? void 0 : dialog.open)) return false;
    minimized = Boolean(call || retryStart || busy);
    dialog.close();
    render();
    return true;
  }
  async function open(targetId = "") {
    if (!auth() || document.hidden) return;
    if (identity && identity !== auth()) dispose();
    identity = auth();
    ensure();
    minimized = false;
    if (targetId) selected = targetId;
    if (!dialog.open) dialog.showModal();
    render();
    await refresh(true);
  }
  async function start(targetId, { callId } = {}) {
    if (document.hidden) {
      if (callId) bestEffortEnd(callId, auth(), "cancelled");
      return;
    }
    if (callId && unsupported()) {
      const token2 = auth();
      await open(targetId);
      status(unsupported());
      bestEffortEnd(callId, token2, "failed");
      return;
    }
    const opening = open(targetId), openingToken = identity, openingEpoch = epoch;
    await opening;
    if (!callId) return;
    if (!current(openingToken, openingEpoch) || document.hidden || !(dialog == null ? void 0 : dialog.open) && !minimized || call && call.id !== callId) {
      bestEffortEnd(callId, openingToken, "cancelled");
      return;
    }
    mediaIntent.add(callId);
    const token = identity, generation = epoch;
    try {
      const result = await request("callState", { id: callId }, token);
      if (!current(token, generation) || document.hidden || !(dialog == null ? void 0 : dialog.open) && !minimized) {
        bestEffortEnd(callId, token, "cancelled");
        return;
      }
      await apply(result, token, generation);
      schedule();
    } catch (error) {
      bestEffortEnd(callId, token, "cancelled");
      if (current(token, generation)) status(pendingMessage);
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      end("hangup", "\u9875\u9762\u5DF2\u5207\u5230\u540E\u53F0\uFF0C\u901A\u8BDD\u4E0E\u9EA6\u514B\u98CE\u5DF2\u5173\u95ED\u3002");
      dialog == null ? void 0 : dialog.close();
    }
  });
  globalThis.addEventListener("unseen-background", () => {
    end("hangup", "\u5E94\u7528\u5DF2\u5207\u5230\u540E\u53F0\uFF0C\u9EA6\u514B\u98CE\u4E0E\u6444\u50CF\u5934\u5DF2\u5173\u95ED\u3002");
    dialog == null ? void 0 : dialog.close();
  });
  globalThis.addEventListener("offline", () => {
    if (call || retryStart || run) end("failed", "\u7F51\u7EDC\u5DF2\u65AD\u5F00\uFF0C\u672C\u673A\u901A\u8BDD\u4E0E\u9EA6\u514B\u98CE\u5DF2\u5173\u95ED\u3002");
  });
  globalThis.addEventListener("pagehide", dispose);
  return { diagnostics: () => __spreadValues({}, diagnostic), back, respond, mute, hasKeyAction, voiceKey, busy: () => Boolean(mediaClosures.size || (dialog == null ? void 0 : dialog.open) || busy || run || call && LIVE.has(call.status)), open, dispose, refresh, start, cancelStart, hasPendingCancellations, canStart, supported: () => !unsupported() };
})();
