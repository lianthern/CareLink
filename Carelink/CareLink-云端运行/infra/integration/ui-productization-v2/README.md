# UI productization v2

Loopback-only copy and navigation refinement of the accepted product slice. It composes the existing Web fixture and frozen Book fixture without changing either business contract.

```sh
node infra/integration/ui-productization-v2/server.mjs
# http://127.0.0.1:4286/
```

Port 4286 is used because the accepted v1 service on 4283 owns 4284 and 4285 as child listeners. Every fixture screen stays visibly marked `本地确定性样本 / 非真实 AI / 不代表正式发布`. The Core `向晚婚礼` sample and Book `AdventureX 2026` sample are explicitly independent and are never presented as continuous data. The process never binds a non-loopback interface, uses a provider, writes cloud state, or represents production readiness.
