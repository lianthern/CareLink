'use strict';
// Opt-in capture on this frame only. No preference silently reopens a camera.
globalThis.MemoryCamera = (() => {
  let mounted = '', dialog = null, controller = null, detector = null, startup = null;
  let generation = 0, guardTimer = null, selectedDevice = '', speak = true, readErrors = 0;
  let status = '摄像头未开启', phase = 'off';
  const node = id => document.getElementById(id);
  const valid = () => frame && session?.role === 'frame' && session?.token === mounted && !sessionExpired && !authScreenActive;
  const night = () => document.documentElement.classList.contains('night-view');
  function update() {
    if (node('frameCameraEntry')) node('frameCameraEntry').textContent = phase === 'on' ? '摄像头驻足邀请 · 已开启' : phase === 'starting' ? '摄像头驻足邀请 · 正在开启' : '摄像头驻足邀请';
    if (node('frameCameraStatus')) node('frameCameraStatus').textContent = status;
    if (node('frameCameraStart')) node('frameCameraStart').disabled = phase !== 'off';
    if (node('frameCameraStop')) node('frameCameraStop').disabled = phase === 'off';
    if (node('frameCameraDevice')) node('frameCameraDevice').disabled = phase !== 'off';
    if (node('frameCameraRefresh')) node('frameCameraRefresh').disabled = phase !== 'off';
    if (node('frameCameraSpeak')) node('frameCameraSpeak').disabled = phase !== 'off';
  }
  function closeSettings() { const previous = dialog; dialog = null; previous?.close(); previous?.remove(); }
  function stop(message = '摄像头已关闭；再次开启需您点击。') {
    generation++; startup?.abort(); startup = null;
    const previous = controller; controller = null;
    void previous?.dispose(); detector?.close(); detector = null;
    clearInterval(guardTimer); guardTimer = null;
    globalThis.MemoryPresence?.closeLocal?.('camera-stopped');
    phase = 'off'; status = message; update();
  }
  function activityBusy() {
    return recording || recordingStarting || sending || !!draft.audio
      || (frameAudio && !frameAudio.paused && !frameAudio.ended)
      || [...document.querySelectorAll('audio')].some(audio => !audio.paused && !audio.ended)
      || globalThis.MemoryAI?.busy() || globalThis.MemoryRealtime?.busy() || globalThis.MemoryCall?.busy?.()
      || (globalThis.speechSynthesis?.speaking && !globalThis.MemoryPresence?.speaking?.())
      || [...document.querySelectorAll('dialog[open]')].some(element => !['presenceInvitation', 'frameCameraSettings'].includes(element.id));
  }
  function refresh() {
    if (!valid()) { if (phase !== 'off') stop('配对已结束，摄像头已关闭。'); return; }
    if (document.hidden || night()) { if (phase !== 'off') stop('相框已进入后台或夜间模式，摄像头已关闭；回来后请手动开启。'); return; }
    if (phase !== 'on' || !controller) return;
    const busy = !!activityBusy();
    void controller.setContext({ visible: true, privacyAllowed: true, busy });
    status = busy ? '正在录音、播放或聊天，摄像头暂停；结束后继续。' : readErrors ? '暂时读不到摄像头画面，正在重试…' : !current()?.imageURL ? '摄像头已开启；等家人寄来照片后再邀请聊天。' : '摄像头已开启 · 正脸停留约 3 秒后邀请；每次驻足只问一次。';
    update();
  }
  function cameraError(error) {
    if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') return '摄像头未获允许。请在浏览器的网站权限中允许摄像头后重试。';
    if (error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError') return '没有找到所选摄像头。请接好 USB 摄像头，刷新列表后重试。';
    if (error?.name === 'NotReadableError') return '摄像头正被其他程序占用或无法读取。请关闭其他摄像头程序后重试。';
    return '摄像头或本地检测未能启动。请使用新版 Chrome / Safari，检查设备后重试；也可继续用 Windows Link 2。';
  }
  async function start() {
    if (!valid() || phase !== 'off') return;
    if (document.hidden || night()) { status = '请回到相框页面，并先关闭夜间模式。'; update(); return; }
    if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia) { status = '此浏览器不能接摄像头。请在 HTTPS 页面使用新版 Chrome / Safari。'; update(); return; }
    selectedDevice = node('frameCameraDevice')?.value || '';
    speak = node('frameCameraSpeak')?.checked !== false;
    const epoch = ++generation, abort = new AbortController(); startup = abort;
    const active = () => generation === epoch && valid() && !abort.signal.aborted && !document.hidden && !night();
    phase = 'starting'; status = '正在加载本地人脸检测，首次开启可能需要片刻…'; update();
    clearInterval(guardTimer); guardTimer = setInterval(refresh, 250);
    let startError;
    try {
      const [{ createBrowserCameraAdapter }, { createCameraPresenceController }, { createLocalFaceDetector }] = await Promise.all([
        import('/camera-adapters.mjs?v=0.5.2'), import('/camera-presence.mjs?v=0.5.2'), import('/camera-face-detector.mjs?v=0.5.2'),
      ]);
      if (!active()) return;
      const createdDetector = await createLocalFaceDetector({ signal: abort.signal });
      if (!active()) { createdDetector.close(); return; }
      detector = createdDetector;
      status = '请允许此相框使用摄像头（不申请麦克风）…'; update();
      const localDetector = detector;
      const adapter = createBrowserCameraAdapter({ deviceId: selectedDevice,
        detector: { capabilities: localDetector.capabilities, async detect(video, options) {
          const result = await localDetector.detect(video, options);
          if (active() && result.presence !== 'unknown') readErrors = 0;
          return result;
        } },
        getUserMedia: async constraints => {
          try { return await navigator.mediaDevices.getUserMedia(constraints); }
          catch (error) { startError = error; throw error; }
        },
      });
      const createdController = createCameraPresenceController({ adapter, dwellMs: 3000, cooldownMs: 60000,
        onGreet: event => { if (active()) globalThis.MemoryPresence?.receiveLocal?.(event, { speak }); },
        onError: error => {
          if (!active()) return;
          if (error.code === 'observation-unavailable' && ++readErrors < 3) { refresh(); return; }
          const message = error.code === 'adapter-stopped' ? '摄像头连接已断开。请重新接好，再点击开启。' : cameraError(startError);
          stop(message); toast(message);
        },
      });
      controller = createdController;
      await createdController.setContext({ visible: true, privacyAllowed: true, busy: false });
      await createdController.enable({ consent: true });
      if (!active()) return;
      phase = 'on'; readErrors = 0;
      closeSettings(); refresh();
      toast('摄像头已开启；面对相框停留约 3 秒，确认邀请后再聊天。');
    } catch (error) { if (active()) stop(cameraError(error)); }
  }
  async function listCameras() {
    const currentDialog = dialog;
    try {
      const devices = await navigator.mediaDevices?.enumerateDevices();
      if (!dialog || dialog !== currentDialog || phase !== 'off') return;
      const select = node('frameCameraDevice'); select.replaceChildren(new Option('默认 / 前置摄像头', ''));
      let index = 0;
      for (const device of devices || []) if (device.kind === 'videoinput' && device.deviceId) select.append(new Option(device.label || '摄像头 ' + (++index), device.deviceId));
      if ([...select.options].some(option => option.value === selectedDevice)) select.value = selectedDevice;
    } catch { if (dialog === currentDialog && node('frameCameraStatus')) node('frameCameraStatus').textContent = '暂时读不到摄像头列表，可先使用默认摄像头。'; }
  }
  function open() {
    if (!valid()) return;
    if (dialog?.open) return;
    if (node('frameMenu')) node('frameMenu').open = false;
    node('modal')?.close();
    dialog = document.createElement('dialog'); dialog.id = 'frameCameraSettings'; dialog.className = 'presence-settings'; dialog.setAttribute('aria-labelledby', 'frameCameraTitle');
    dialog.innerHTML = '<div class="row between"><h2 id="frameCameraTitle">摄像头驻足邀请</h2><button id="frameCameraClose" type="button">返回相框 ×</button></div><p>接入这台相框的内置或 USB 摄像头，正脸停留约 3 秒后会邀请您聊聊。确认邀请后才进入 AI 聊天，不会自动打开麦克风。</p><p class="muted">画面只在这台设备检测，不上传、不保存，不识别身份或注视。建议面朝摄像头、距离约 0.5–2 米；背对、遮挡或光线暗时可能检测不到。</p><label>选择摄像头<select id="frameCameraDevice"><option value="">默认 / 前置摄像头</option></select></label><button id="frameCameraRefresh" type="button">刷新摄像头列表</button><label><input id="frameCameraSpeak" type="checkbox" checked> 驻足时语音问候（浏览器允许时朗读邀请）</label><div class="row"><button id="frameCameraStart" class="primary" type="button">开启摄像头与驻足邀请</button><button id="frameCameraStop" type="button">关闭摄像头</button></div><p id="frameCameraStatus" role="status"></p><p class="muted">切到后台、夜间模式或退出配对会关闭摄像头；返回后需手动开启。Windows Link 2 云端传感器仍使用原绑定，无需重新签发。</p>';
    document.body.append(dialog);
    node('frameCameraSpeak').checked = speak;
    node('frameCameraClose').onclick = closeSettings;
    dialog.addEventListener('cancel', event => { event.preventDefault(); closeSettings(); });
    node('frameCameraStart').onclick = () => void start();
    node('frameCameraStop').onclick = () => stop();
    node('frameCameraRefresh').onclick = () => void listCameras();
    dialog.showModal(); update(); void listCameras();
  }
  function mount() {
    if (!frame || !session || session.role !== 'frame' || sessionExpired) return;
    mounted = session.token;
    if (!node('frameCameraEntry')) {
      const button = document.createElement('button'); button.id = 'frameCameraEntry'; button.type = 'button'; button.onclick = open;
      node('frameMenu')?.querySelector('.frame-menu-items')?.append(button);
    }
    update();
  }
  function mountSettings() {
    if (!valid() || node('frameCameraSettingsEntry')) return;
    const button = document.createElement('button'); button.id = 'frameCameraSettingsEntry'; button.type = 'button'; button.textContent = '摄像头驻足邀请'; button.onclick = open;
    node('logout')?.before(button);
  }
  function dispose() { stop('摄像头未开启'); mounted = ''; closeSettings(); node('frameCameraEntry')?.remove(); }
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop('相框已进入后台，摄像头已关闭；返回后请手动开启。'); });
  document.addEventListener('play', refresh, true);
  globalThis.addEventListener('pagehide', dispose);
  return { mount, mountSettings, open, stop, refresh, dispose };
})();
