// Runs only in a fresh, isolated test page. Reuses the deployed lifecycle client
// and TRTC SDK; the sole replacement is an explicit synthetic microphone track.
export async function installRealtimeProbe({ token, requestId, wavBase64, stopAt }) {
  let client, audioContext, source, stream, recorder, analyser, monitor, sent = false, agentId = '';
  const chunks = [];
  const result = { phases: [], sdkEnteredRoom: false, localAudioPublished: false, syntheticAudioPlayed: false,
    remoteAudioTrack: false, remoteAudioNonzero: false, maxRemoteRms: 0, startAttempts: 0, stopConfirmed: false,
    physicalDeviceAttempts: 0, error: false, requests: [], sdkErrorCodes: [], cspViolations: [] };
  document.addEventListener('securitypolicyviolation', event => {
    if (result.cspViolations.length >= 10) return;
    let blockedOrigin = 'non-url';
    try { blockedOrigin = new URL(event.blockedURI).origin; } catch {}
    result.cspViolations.push({ directive: event.effectiveDirective, blockedOrigin });
  });
  const denyDevice = async () => { result.physicalDeviceAttempts++; throw new DOMException('Synthetic test only', 'NotAllowedError'); };
  navigator.mediaDevices.getUserMedia = denyDevice;
  navigator.mediaDevices.getDisplayMedia = denyDevice;
  const request = async (action, data, options = {}) => {
    if (!['aiRealtimeStart', 'aiRealtimeStatus', 'aiRealtimeStop'].includes(action)) throw Error('Action denied');
    if (action === 'aiRealtimeStart') {
      if (++result.startAttempts !== 1 || Date.now() >= stopAt) throw Error('Only one bounded call is allowed');
    }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), action === 'aiRealtimeStart' ? 30000 : 10000);
    const stop = () => abort.abort(); options.signal?.addEventListener('abort', stop, { once: true });
    if (options.signal?.aborted) abort.abort();
    try {
      const response = await fetch('/api', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ action, data: { ...data, requestId } }), signal: abort.signal, keepalive: action === 'aiRealtimeStop' });
      if (result.requests.length < 20) result.requests.push({ action, status: response.status });
      if (!response.ok) throw Object.assign(Error('Probe API failure'), { status: response.status });
      const value = await response.json();
      if (action === 'aiRealtimeStart') agentId = value.connection?.agentId || '';
      if (action === 'aiRealtimeStop' && value.status === 'ended') result.stopConfirmed = true;
      return value;
    } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', stop); }
  };
  async function acquire() {
    audioContext = new AudioContext(); await audioContext.resume();
    const bytes = Uint8Array.from(atob(wavBase64), value => value.charCodeAt(0));
    const decoded = await audioContext.decodeAudioData(bytes.buffer);
    if (decoded.duration > 15 || decoded.duration < 1) throw Error('Use a synthetic prompt of 1 to 15 seconds');
    const destination = audioContext.createMediaStreamDestination(); stream = destination.stream;
    source = audioContext.createBufferSource(); source.buffer = decoded; source.connect(destination);
    return stream;
  }
  async function loadSDK() {
    const TRTC = (await import('/vendor/trtc-5.19.2.mjs?v=0.5.2')).default;
    return { EVENT: TRTC.EVENT, setLogLevel: (...args) => TRTC.setLogLevel(...args), create() {
      const rtc = TRTC.create();
      rtc.on(TRTC.EVENT.ERROR, event => {
        result.error = true;
        if (result.sdkErrorCodes.length < 10 && (Number.isInteger(event.code) || /^[A-Z_]{1,60}$/.test(event.code || ''))) result.sdkErrorCodes.push(event.code);
      });
      const enter = rtc.enterRoom.bind(rtc), publish = rtc.startLocalAudio.bind(rtc);
      rtc.enterRoom = async options => { const value = await enter(options); result.sdkEnteredRoom = true; return value; };
      rtc.startLocalAudio = async options => { const value = await publish(options); result.localAudioPublished = true; return value; };
      rtc.on(TRTC.EVENT.TRACK, event => {
        if (event.userId !== agentId || event.track?.kind !== 'audio' || result.remoteAudioTrack) return;
        result.remoteAudioTrack = true;
        const remote = new MediaStream([event.track]);
        const input = audioContext.createMediaStreamSource(remote); analyser = audioContext.createAnalyser(); analyser.fftSize = 2048; input.connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        monitor = setInterval(() => {
          analyser.getFloatTimeDomainData(samples);
          const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
          result.maxRemoteRms = Math.max(result.maxRemoteRms, rms);
          if (rms > 0.001) result.remoteAudioNonzero = true;
        }, 100);
        if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
          recorder = new MediaRecorder(remote, { mimeType: 'audio/webm;codecs=opus' });
          recorder.ondataavailable = event => { if (event.data.size && chunks.length < 70) chunks.push(event.data); };
          recorder.start(1000);
        }
      });
      return rtc;
    } };
  }
  let hardTimer, started = false;
  async function stop() {
    clearTimeout(hardTimer); clearInterval(monitor);
    try { source?.stop(); } catch {}
    // Capture only this test's bot audio. No microphone, camera, family media,
    // packet identifiers, credentials, or SDK logs enter the report.
    if (recorder?.state === 'recording') await new Promise(resolve => { recorder.addEventListener('stop', resolve, { once: true }); recorder.stop(); });
    await client?.stop(); stream?.getTracks().forEach(track => track.stop());
    try { await audioContext?.close(); } catch {}
  }
  client = MemoryRealtime.createClient({ request, acquire, loadSDK, permitted: () => !document.hidden && Date.now() < stopAt,
    onState: ({ phase, message }) => {
      if (result.phases.at(-1) !== phase) result.phases.push(phase);
      result.lastMessage = message;
      if (phase === 'waiting' && !sent) {
        sent = true; source.start(audioContext.currentTime + 0.6); result.syntheticAudioPlayed = true;
      }
    } });
  window.realtimeProbe = { result, start: () => { if (started) return; started = true; hardTimer = setTimeout(() => void stop(), Math.max(1, stopAt - Date.now())); return client.start(); }, stop,
    async recording() {
      if (!chunks.length) return '';
      const bytes = new Uint8Array(await new Blob(chunks, { type: 'audio/webm' }).arrayBuffer());
      if (bytes.length > 2000000) throw Error('Probe recording exceeds limit');
      let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary);
    } };
  return result;
}
