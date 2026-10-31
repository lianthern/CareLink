"use strict";
globalThis.MemoryFamilyMedia = /* @__PURE__ */ (() => {
  function create({
    connection,
    stream,
    current,
    localView,
    remoteView,
    onConnected,
    onFailure,
    onPlayback,
    onCamera,
    loadSDK = () => globalThis.UnseenNativeRtc && globalThis.UnseenNativeRtc.available() ? globalThis.UnseenNativeRtc.loadSDK() : window.UnseenCompat.importModule("/vendor/trtc-5.19.2.mjs?v=0.5.2").then((m) => m.default),
    acquireCamera = () => navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } } })
  }) {
    let rtc, entering, publishing, stopping, exiting, entrySettled = false, entrySucceeded = false, publishSettled = false, exitSucceeded = false, mediaClosed = false, disposed = false, published = false, remote = false, playback = null, camera = null, cameraEpoch = 0, cameraPending = false, cameraWork = null;
    const live = () => !disposed && current();
    const ready = () => {
      if (live() && published && remote && !playback) onConnected();
    };
    const ignore = (task) => {
      try {
        Promise.resolve(task()).catch(() => {
        });
      } catch (e) {
      }
    };
    function stopCamera() {
      cameraEpoch++;
      cameraPending = false;
      camera == null ? void 0 : camera.getTracks().forEach((track) => {
        track.onended = null;
        track.stop();
      });
      camera = null;
      ignore(() => rtc == null ? void 0 : rtc.stopLocalVideo());
      onCamera(false, false);
    }
    async function settleWithin(task) {
      let timer;
      try {
        return await Promise.race([Promise.resolve(task).then(() => true, () => false), new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), 4e3);
        })]);
      } finally {
        clearTimeout(timer);
      }
    }
    function stop() {
      disposed = true;
      stopCamera();
      playback = null;
      stream.getTracks().forEach((track) => {
        track.onended = null;
        track.stop();
      });
      ignore(() => rtc == null ? void 0 : rtc.muteRemoteAudio("*", true));
      ignore(() => rtc == null ? void 0 : rtc.stopLocalAudio());
      if (mediaClosed) return Promise.resolve(true);
      if (stopping) return stopping;
      const closing = rtc;
      const cleanup = (async () => {
        if (!closing) {
          if (stream.nativeAudio) {
            try {
              await stream.release();
            } catch (_) {
              return false;
            }
          }
          mediaClosed = true;
          return true;
        }
        if (entering && !entrySettled && !await settleWithin(entering)) return false;
        if (publishing && !publishSettled && !await settleWithin(publishing)) return false;
        if (entrySucceeded) {
          if (!exiting) {
            try {
              exiting = Promise.resolve(closing.exitRoom()).then(() => {
                exitSucceeded = true;
              }, () => {
                exiting = null;
              });
            } catch (_) {
              return false;
            }
          }
          if (!exitSucceeded && !await settleWithin(exiting)) return false;
          if (!exitSucceeded) return false;
        }
        try {
          closing.destroy();
          mediaClosed = true;
          return true;
        } catch (_) {
          return false;
        }
      })();
      stopping = cleanup;
      cleanup.then(() => {
        if (stopping === cleanup) stopping = null;
      });
      return cleanup;
    }
    async function stoppedAfterEntry() {
      return stop();
    }
    async function start() {
      var _a;
      const SDK = await loadSDK();
      if (!live()) return stop();
      (_a = SDK.setLogLevel) == null ? void 0 : _a.call(SDK, 5, false);
      rtc = SDK.create();
      const failed = () => {
        if (live()) onFailure("\u5BB6\u4EBA\u901A\u8BDD\u8FDE\u63A5\u4E2D\u65AD\uFF0C\u9EA6\u514B\u98CE\u4E0E\u6444\u50CF\u5934\u5DF2\u5173\u95ED\u3002");
      };
      rtc.on(SDK.EVENT.ERROR, failed);
      rtc.on(SDK.EVENT.KICKED_OUT, failed);
      rtc.on(SDK.EVENT.CONNECTION_STATE_CHANGED, (event) => {
        if (event.state === "DISCONNECTED") failed();
      });
      rtc.on(SDK.EVENT.REMOTE_USER_EXIT, (event) => {
        if (event.userId === connection.peerId) failed();
      });
      rtc.on(SDK.EVENT.AUTOPLAY_FAILED, (event) => {
        if (!live() || event.userId !== connection.peerId) return;
        playback = event.resume;
        onPlayback(true);
      });
      rtc.on(SDK.EVENT.REMOTE_AUDIO_AVAILABLE, (event) => {
        if (!live() || event.userId !== connection.peerId) return;
        Promise.resolve(rtc.muteRemoteAudio(connection.peerId, false)).then(() => {
          if (live()) {
            remote = true;
            ready();
          }
        }).catch(failed);
      });
      rtc.on(SDK.EVENT.REMOTE_VIDEO_AVAILABLE, (event) => {
        if (!live() || !connection.video || event.userId !== connection.peerId || event.streamType !== SDK.TYPE.STREAM_TYPE_MAIN) return;
        remoteView.hidden = false;
        Promise.resolve(rtc.startRemoteVideo({ userId: connection.peerId, streamType: event.streamType, view: remoteView })).catch(() => {
          if (live()) {
            remoteView.hidden = true;
            onCamera(Boolean(camera), cameraPending, "\u5BF9\u65B9\u89C6\u9891\u6682\u65F6\u65E0\u6CD5\u663E\u793A\uFF0C\u8BED\u97F3\u4ECD\u53EF\u7EE7\u7EED\u3002");
          }
        });
      });
      rtc.on(SDK.EVENT.REMOTE_VIDEO_UNAVAILABLE, (event) => {
        if (live() && event.userId === connection.peerId) remoteView.hidden = true;
      });
      const { sdkAppId, userId, userSig, privateMapKey, strRoomId } = connection;
      entering = Promise.resolve(rtc.enterRoom({ sdkAppId, userId, userSig, privateMapKey, strRoomId, nativePeerId: connection.peerId, scene: "rtc", autoReceiveAudio: false, autoReceiveVideo: false, enableAutoPlayDialog: false })).then((value) => {
        entrySettled = entrySucceeded = true;
        return value;
      }, (error) => {
        entrySettled = true;
        throw error;
      });
      await entering;
      if (!live()) return stoppedAfterEntry();
      publishing = Promise.resolve(rtc.startLocalAudio({ option: { audioTrack: stream.getAudioTracks()[0], profile: "standard" } })).then((value) => {
        publishSettled = true;
        return value;
      }, (error) => {
        publishSettled = true;
        throw error;
      });
      await publishing;
      if (!live()) return stop();
      published = true;
      ready();
    }
    async function resume() {
      if (!live() || !playback) return;
      const attempt = playback;
      try {
        await attempt();
        if (live() && playback === attempt) {
          playback = null;
          onPlayback(false);
          ready();
        }
      } catch (e) {
        if (live()) onPlayback(true);
      }
    }
    async function toggleCamera() {
      var _a;
      const blocked = (_a = globalThis.FrameCameraPolicy) == null ? void 0 : _a.reason();
      if (blocked) {
        onCamera(false, false, blocked);
        return;
      }
      if (!live() || !published || !connection.video) return;
      if (camera || cameraPending) {
        stopCamera();
        return;
      }
      if (cameraWork) return;
      cameraWork = {};
      const work = cameraWork;
      const generation = ++cameraEpoch;
      cameraPending = true;
      onCamera(false, true);
      let acquired;
      try {
        acquired = await acquireCamera();
        if (!live() || generation !== cameraEpoch) {
          acquired.getTracks().forEach((track) => track.stop());
          return;
        }
        camera = acquired;
        camera.getTracks().forEach((track) => {
          track.onended = () => {
            if (live()) stopCamera();
          };
        });
        await rtc.startLocalVideo({ view: localView, option: { videoTrack: acquired.getVideoTracks()[0], profile: "480p" } });
        if (!live()) return stop();
        if (generation !== cameraEpoch) {
          acquired.getTracks().forEach((track) => track.stop());
          ignore(() => rtc.stopLocalVideo());
          return;
        }
        cameraPending = false;
        onCamera(true, false);
      } catch (e) {
        acquired == null ? void 0 : acquired.getTracks().forEach((track) => track.stop());
        if (live() && generation === cameraEpoch) {
          stopCamera();
          onCamera(false, false, "\u6444\u50CF\u5934\u672A\u5F00\u542F\uFF0C\u8BF7\u68C0\u67E5\u6743\u9650\uFF1B\u8BED\u97F3\u53EF\u4EE5\u7EE7\u7EED\u3002");
        }
      } finally {
        if (cameraWork === work) cameraWork = null;
      }
    }
    return { start, stop, resume, toggleCamera, pending: () => disposed && !mediaClosed, localAudioStopped: () => !stream.nativeAudio || stream.getAudioTracks().every((track) => track.readyState === "ended") };
  }
  return { create };
})();
