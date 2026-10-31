# UI productization v1

Loopback-only product slice that composes the existing Web fixture and frozen Book fixture without changing either business contract.

```sh
node infra/integration/ui-productization/server.mjs
# http://127.0.0.1:4283/
```

Every fixture screen is visibly marked `本地确定性样本 / 非真实 AI / 不代表正式发布`. The process never binds a non-loopback interface, uses a provider, writes cloud state, or represents production readiness.
