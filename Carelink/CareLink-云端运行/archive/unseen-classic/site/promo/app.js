(() => {
  let wakeLock = null;

  async function requestWakeLock() {
    if (!("wakeLock" in navigator) || document.visibilityState !== "visible") {
      return;
    }

    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => {
        wakeLock = null;
      });
    } catch {
      // The display still loops normally when Wake Lock is unavailable.
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !wakeLock) {
      void requestWakeLock();
    }
  });

  window.addEventListener("pageshow", () => {
    void requestWakeLock();
  });

  void requestWakeLock();
})();
