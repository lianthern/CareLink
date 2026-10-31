# UNSEEN Android WebView test harness

Minimal debug-only Android wrapper for exercising the real Web capture page
through Android System WebView, `getUserMedia`, the emulator camera, and device
orientation sensors. It is not part of the product or public deployment.

The harness deliberately grants only the requested video-capture resource after
the Android CAMERA runtime permission has been granted. Web contents debugging
is enabled so automated tests can inspect `__PANO_DIAGNOSTICS__` and the capture
counter through the Android WebView DevTools socket.
