const cancelled = () => Object.assign(new Error('Camera detection cancelled'), { name: 'AbortError' });

// Creating a detector loads a local model, never a camera. The caller owns consent.
export async function createLocalFaceDetector({
  signal,
  createWorker = () => new Worker('/camera-face-worker.js?v=0.5.2'),
  createBitmap = input => createImageBitmap(input),
  schedule = setTimeout, cancel = clearTimeout,
  startupTimeoutMs = 45000, detectionTimeoutMs = 2500,
} = {}) {
  if (signal?.aborted) throw cancelled();
  const worker = createWorker();
  let closed = false, sequence = 0, pending = null, lastVideoTime = null;
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const startupTimer = schedule(() => fail(), startupTimeoutMs);
  const close = () => {
    if (closed) return;
    closed = true; cancel(startupTimer); signal?.removeEventListener('abort', close);
    worker.terminate(); rejectReady(cancelled());
    if (pending) { cancel(pending.timer); pending.reject(cancelled()); pending = null; }
  };
  const fail = () => {
    rejectReady(new Error('Local face detector is unavailable'));
    if (pending) { cancel(pending.timer); pending.reject(new Error('Local face detector stopped')); pending = null; }
    close();
  };
  signal?.addEventListener('abort', close, { once: true });
  worker.onerror = event => { event.preventDefault?.(); fail(); };
  worker.onmessage = ({ data }) => {
    if (closed) return;
    if (data?.type === 'ready') { cancel(startupTimer); resolveReady(); }
    else if (data?.type === 'failed') fail();
    else if (data?.type === 'result' && pending?.id === data.id) {
      const current = pending; pending = null; cancel(current.timer);
      if (data.error || !['present', 'absent', 'unknown'].includes(data.presence)) current.reject(new Error('Detection unavailable'));
      else current.resolve({ presence: data.presence, attention: 'unknown' });
    }
  };
  try { await ready; } catch (error) { close(); throw error; }
  return Object.freeze({
    capabilities: Object.freeze({ presence: true, gaze: false, evidence: 'mediapipe-local-face-detection' }),
    async detect(video, { signal: readSignal } = {}) {
      if (closed || readSignal?.aborted) throw cancelled();
      if (pending || video.readyState < 2 || !video.videoWidth || !video.videoHeight
          || !Number.isFinite(video.currentTime) || video.currentTime === lastVideoTime) {
        return { presence: 'unknown', attention: 'unknown' };
      }
      lastVideoTime = video.currentTime;
      const image = await createBitmap(video);
      if (closed || readSignal?.aborted) { image.close(); throw cancelled(); }
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const aborted = () => {
          if (pending?.id !== id) return;
          const current = pending; pending = null; cancel(current.timer); current.reject(cancelled());
        };
        const finish = callback => value => { readSignal?.removeEventListener('abort', aborted); callback(value); };
        pending = { id, resolve: finish(resolve), reject: finish(reject), timer: schedule(() => {
          if (pending?.id !== id) return;
          const current = pending; pending = null; current.reject(new Error('Detection timed out')); close();
        }, detectionTimeoutMs) };
        readSignal?.addEventListener('abort', aborted, { once: true });
        try { worker.postMessage({ type: 'detect', id, image, timestamp: performance.now() }, [image]); }
        catch (error) { image.close(); cancel(pending.timer); pending = null; readSignal?.removeEventListener('abort', aborted); reject(error); }
      });
    },
    close,
  });
}
