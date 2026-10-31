# UNSEEN Web（Track 2）

冻结合同驱动的 Web 产品端。Track 2 只实现 `apps/web/**`：浏览器默认走 canonical HTTP boundary 与 ProductionViewerAdapter，不包含服务端授权、生产存储，也不在 Web 内重写现场 renderer。

## 本地运行

要求 Node.js 22+；无需安装新依赖，不使用外网 CDN。

```sh
cd /Users/max/code/unseen-worktrees/2-web
UNSEEN_VIEWER_ROOT=/Users/max/code/unseen-worktrees/4-viewer/packages/viewer \
  npm run dev --workspace @unseen/web
```

默认地址为 `http://127.0.0.1:4173`。如端口被占用，可增加 `UNSEEN_WEB_PORT=4282`。默认页面使用 `HttpApiAdapter`、同源本地 canonical API 和 `ProductionViewerAdapter`；localhost/127.0.0.1 不会自动开启 fixture。独立 Track 2 工作树没有 Track 4 包时，未配置 `UNSEEN_VIEWER_ROOT` 仍可运行其他页面，现场会诚实显示不可用；合入完整仓库后默认公共入口为 `packages/viewer/src/public/index.js`。

本地 canonical API 的验证码为 `246810`，但正式投影的输入始终为空，页面不会显示“验收验证码”。登录、上传回执绑定和敏感操作再次验证均为 challenge→verify 两阶段，challengeId/purpose 由 adapter 内存保存并精确关联。

仅在显式 URL 使用 fixture：

- `?fixture=1`：production-look fixture 数据，不显示调试工具。
- `?fixture=1&debug=1`：显示本地调试 chrome、数据重置和调试填充。

这两种模式都不是默认本地运行方式，也不参与 production 浏览器验收。

## 验证

从仓库根运行完整检查：

```sh
npm run check --workspace @unseen/web
```

单独检查：

```sh
npm test --workspace @unseen/web
npm run browser:test --workspace @unseen/web
```

完整检查会重新同步冻结合同、生成 action coverage、执行全部 Node 测试，并用隔离 Chrome 跑 production HttpApiAdapter + ProductionViewerAdapter 主链。浏览器覆盖 320/390/430/768/959/960/1247/1248/1280/1440、200% zoom、reduced motion、AX tree、焦点/滚动恢复、真实 File bytes 上传、OTP/reauth、异常重试与媒体 checksum。runner 有阶段/全局 timeout、`finally` 进程组清理和 orphan=0 门槛。

## 边界

- `src/api/action-request-registry.js`：冻结 server action 的显式 path/body/CAS/Idempotency-Key/notice/reauth request builder；未知字段不会透传，缺少 placeholder/CAS/grant 时 fetch 前 fail-closed。
- `src/api/http-adapter.js`：canonical read boundary；照片、批次、回执、位置、管理、账号绑定和各状态页按 route 直接读取 DTO，动作后重新读取当前 route。
- `src/api/upload-workflow.js`：照片与全景的 create→ticket→PUT bytes→commit→status 工作流；失败重试要求重新选择真实 File。
- `src/adapters/viewer/index.js`：只消费 Track 4 公共 `createViewer()`→`mount()`/EventTarget/`updateScene()`/`focusPose()`/`dispose()`；fixture renderer 仅供显式 debug。
- 照片展示与 `focusPose` 前校验真实 bytes 的 SHA-256 和完整 identity；全景 bytes 校验由 Viewer 负责。
- 活动二维码只编码同源 `/open/{publicCampaignId}` locator；成员邀请与上传回执 secret 只走最早同步清除后的内存 POST body。
- `/privacy`、`/terms` 不在默认产品导航；在政策正文交付前只显示冻结 catalog 的“暂时无法加载”状态，不输出未审批政策或施工说明。

完整证据与仍需 Track 5/发布侧关闭的门槛见 [evidence/README.md](./evidence/README.md)。
