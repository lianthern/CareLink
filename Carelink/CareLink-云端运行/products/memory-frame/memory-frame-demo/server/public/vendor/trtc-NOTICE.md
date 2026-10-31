# Tencent TRTC Web SDK

`trtc-5.19.2.mjs` is a self-contained browser ESM bundle of the official `trtc-sdk-v5@5.19.2` npm package and its dependencies. The published `trtc.esm.js` contains a bare `webrtc-adapter` import and cannot be served directly to a browser without a bundler or import map. Original Tencent package metadata is preserved in `trtc-5.19.2-package.json`.

- Author: Tencent Cloud Client R&D Center
- Declared package license: ISC
- Source package: https://registry.npmjs.org/trtc-sdk-v5/-/trtc-sdk-v5-5.19.2.tgz
- Official repository: https://github.com/LiteAVSDK/TRTC_Web
- Documentation: https://web.sdk.qcloud.com/trtc/webrtc/v5/doc/zh-cn/index.html

The published Tencent package does not include a separate LICENSE file; its declared license is ISC and upstream legal comments are retained by the build. No Tencent license text or copyright holder has been invented.

Included runtime dependencies:

- `webrtc-adapter@9.0.4`, BSD-3-Clause. Copyright 2014 The WebRTC project authors; copyright 2018 The adapter.js project authors. Complete notice: `webrtc-adapter-9.0.4-LICENSE.txt`. Source: https://github.com/webrtchacks/adapter
- `sdp@3.2.2`, MIT. Copyright 2017 Philipp Hancke. Complete notice: `sdp-3.2.2-LICENSE.txt`. Source: https://github.com/fippo/sdp

`esbuild@0.25.9` is a build-only tool and is not shipped to the browser. The build does not add optional plugin packages, codec/denoiser assets, external scripts, or import maps. Upstream built-in functionality remains intact. The product loads the SDK only after an authenticated user explicitly starts an enabled realtime session.

From `memory-frame-demo`, run `node scripts/build-trtc-vendor.mjs` to rebuild, or append `--check` to verify byte-for-byte reproducibility. Exact npm versions and integrity hashes are committed in `scripts/vendor/trtc-sdk/package-lock.json`; installation is confined to ignored `.tools/trtc-sdk-build`. `trtc-5.19.2-build.json` records the emitted hash and zero external imports. Production CSP is unchanged.

The separate real-browser smoke test imports this exact file, calls `setLogLevel(5, false)`, creates and destroys an SDK instance under the existing CSP, and blocks all non-local requests. It never enters a room or acquires physical media. Run with explicit isolated browser paths:

```sh
AI_UX_PLAYWRIGHT=/absolute/path/to/playwright AI_UX_CHROME=/absolute/path/to/Chrome node --test test/trtc-vendor-browser.test.js
```
