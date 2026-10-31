# Local decoder runtime evidence — 2026-08-13

Track 1A has no npm decoder package, but it is **not zero-runtime-dependency**.
Real pixel validation currently requires system `ffprobe` and `ffmpeg` binaries.

Probe commands used on the audited local machine:

```sh
command -v ffprobe
command -v ffmpeg
ffprobe -version
ffmpeg -version
```

Observed executable family: Homebrew FFmpeg `8.1.2` (`8.1.2_1` prefix), built
with Apple clang 17. The observed configuration includes:

```text
/opt/homebrew/bin/ffprobe
/opt/homebrew/bin/ffmpeg
```

```text
--enable-shared --enable-pthreads --enable-version3 --enable-ffplay
--enable-gpl --enable-libsvtav1 --enable-libopus --enable-libx264
--enable-libmp3lame --enable-libdav1d --enable-libvmaf --enable-libvpx
--enable-libx265 --enable-openssl --enable-videotoolbox
--enable-audiotoolbox --enable-neon
```

The machine test runs `FfmpegDecoderRunner.diagnostics()` and asserts the
version plus representative build flags. Decoder execution uses `spawn()`
with `shell:false`, constant argv, media through stdin, a default 8,000 ms
timeout, a 2 MiB output cap, and `SIGKILL` on timeout/overflow. It resolves only
after the child `close` event. Tests cover literal argv/no shell, ENOENT,
timeout, crash, signal, and post-close `ESRCH` process absence.

This is local implementation evidence only. FFmpeg transitive codec licensing,
the GPL-enabled build, redistribution policy, vulnerability inventory, and
complete SBOM remain explicit Track 6A / Release gates. Until those gates pass,
this backend is not production-, distribution-, or app-store-ready.
