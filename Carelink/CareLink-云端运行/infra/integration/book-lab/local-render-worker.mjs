// Opt-in local renderer loop. All validation, leases and artifacts remain in the canonical renderer.
export function createLocalBookRenderWorker({ api, bookRuntime, pollMs = 1000, onError = () => {} }) {
  if (!api?.dispatchInternalJob || !bookRuntime?.pendingRenderRequests) throw new Error("book_render_worker_unavailable");
  let timer = null, inFlight = null, closed = false;
  const drain = () => {
    if (closed) return Promise.resolve([]);
    if (inFlight) return inFlight;
    inFlight = (async () => {
      await bookRuntime.processPendingGrantCleanup?.();
      const results = [];
      for (const request of bookRuntime.pendingRenderRequests()) {
        if (closed) break;
        results.push(await api.dispatchInternalJob("internal:book-lab-render-processor", request));
      }
      return results;
    })().finally(() => { inFlight = null; });
    return inFlight;
  };
  return { drain, start() {
    if (closed || timer) throw new Error("book_render_worker_unavailable");
    timer = setInterval(() => { void drain().catch(onError); }, pollMs); timer.unref?.();
    void drain().catch(onError);
  }, async close() { closed = true; clearInterval(timer); timer = null; await inFlight; } };
}
