# UNSEEN CloudBase 上传后端

这是一个无第三方运行时依赖的 Node.js 20 **事件云函数**。同一个 `index.main`
既接受 CloudBase HTTP 访问服务事件，也接受定时触发器事件。它只管理由本服务新建、
以 `u` 加 24 位十六进制字符命名的空间；不会接管或维护 `s4`、`stressexp1` 等旧空间。

## 安全模型

- 客户端永远拿不到 OSS AccessKey Secret，也拿不到可写前缀。每次上传仅获得 15 分钟、
  精确到一个私有 object key 的 PostObject policy。
- `createSpace` 的 `clientCreateId` 和 `photoTicket` 的 `clientUploadId` 必须由客户端使用
  CSPRNG 生成并持久化；重试同一 ID 会得到同一空间/照片键。
- 创建者媒体和宾客照片先进入 `unseen-backend/v1/` 私有区。服务端读取真实字节，按
  magic bytes 识别 JPEG/PNG/WebP、读取尺寸、核对大小，并使用源 ETag 条件复制。
- 全景图必须为 1600×800 或以上、宽高比 1.90–2.10、最大 8192×4096、最大 50 MB；
  普通照片最大 20 MB，任一边最大 8192。动态 WebP 拒绝。
- `hostKey` 只建议放在 `X-Unseen-Host-Key` 请求头；函数日志从不记录请求体、token、
  host key、policy 或 AccessKey。
- CORS 不设置 credentials。浏览器 origin 必须在 `CORS_ORIGINS` 中；微信请求没有
  `Origin` 时仍使用 commit token/host key 授权，而不是 cookie。
- 每张照片先用禁止覆盖的 slot object 原子预留 0–89 槽，再生成不可变 commit record。
  `space.json` 是这些 commit record 的原子物化快照；并发提交和定时维护都会重建，
  因而重试不会重复照片，也不会丢失已成功的 commit。

## 单一 JSON API

HTTP 访问服务应把一个 HTTPS 路径（例如 `/unseen-api`）绑定到本事件函数。除了健康
检查外只接受 `POST application/json`。

```json
{"action":"health"}
```

```json
{
  "action":"createSpace",
  "clientCreateId":"由 CSPRNG 生成并本地持久化的至少 16 位 ID",
  "title":"空间名称",
  "date":"2026-08-02",
  "place":"Brisbane",
  "media":{"cover":true,"panorama":true}
}
```

响应包含 `spaceId`、只显示一次并须本地安全保存的 `hostKey`，以及按需生成的
`uploads.cover`/`uploads.panorama`。上传时把 `fields` 原样放入 multipart 表单，
最后一个字段必须是 `file`，POST 到 `host`。

```json
{"action":"finalizeSpace","spaceId":"u...","useCover":true,"usePanorama":true}
```

`finalizeSpace` 应带 `X-Unseen-Host-Key`。如果创建时申请了某媒体，默认会使用它；
显式传 `false` 可以放弃该可选媒体。发布成功后得到公开、无长期 policy 的
`spaces/<sid>/space.json`，其中 `upload.mode` 为 `ticket-v1`。

```json
{
  "action":"photoTicket",
  "spaceId":"u...",
  "clientUploadId":"每张照片持久化一个随机 ID",
  "contributor":"Max",
  "caption":"可选说明"
}
```

客户端按响应中的精确 policy 上传普通照片，再提交：

```json
{"action":"commitPhoto","commitToken":"..."}
```

只有 `commitPhoto` 成功后照片才会进入公开清单。重复 ticket 或 commit 是幂等的。

## 部署

仓库根目录的 `cloudbaserc.json` 只包含 `{{env.*}}` 动态变量，不含真实密钥；
`tools/deploy_cloudbase_backend.py` 在内存中注入配置。正式部署必须显式传入 HTTP
访问服务最终 URL，不能使用默认 `.invalid` 占位：

```sh
python3 tools/deploy_cloudbase_backend.py \
  --api-url https://your-api.example.com/unseen-api \
  --cors-origin https://your-web.example.com
```

生产部署假设与必做项：

1. CloudBase 运行时为 `Nodejs20.19`；因单次会校验最多 50 MB 图片，建议 512 MB 内存、
   60–120 秒超时。
2. 给同一事件函数绑定 HTTP 访问服务，并绑定备案 HTTPS 自定义域名；把最终 URL 写进
   `PUBLIC_API_URL` 后重新部署。
3. 配置一个小时一次的 timer trigger：`0 0 * * * * *`。函数会重建 managed manifest、
   清理过期 draft、未提交 ticket/slot/upload 和旧限流 marker。
4. 使用独立 RAM 身份，最小权限参考 `ram-policy.template.json`。不要使用主账号 AK。
5. OSS bucket 必须允许该 RAM 身份读取、列举、写入、复制、删除 managed objects，且
   允许给发布对象设置 `public-read` ACL。若 bucket 强制禁止公开 ACL，需要先改成 CDN/
   签名读取方案，不能直接部署本实现。
6. OSS CORS 仅放行正式 Web origin 的 `POST/GET/HEAD`；微信公众平台同时把 bucket HTTPS
   域名加入 `request` 与 `uploadFile` 合法域名。
7. CloudBase 与 OSS 时钟必须同步。policy/token 依赖 UTC 到期时间。

根 `cloudbaserc.json` 中 `envVariables` 会覆盖线上环境变量；不要手工把真实密钥写回
仓库。首次上线前在控制台确认 HTTP 路由和 timer 均绑定到了 `unseenBackend`。

## 验收

```sh
cd backend
npm run check
npm test
```

测试使用内存 Fake OSS，不会访问或修改线上 bucket。另有签名层测试确认 ListObjects V1
的 `prefix`/`marker`/`max-keys` 只进入 URL，而 V1 `StringToSign` 使用 bucket canonical
resource；OSS 对象操作适配器仍应在部署前用只读 AK 对目标 bucket 做 `head/get/list` 冒烟。

## 运行边界

- 维护单轮最多扫描 `MAINTENANCE_MAX_OBJECTS`（默认 500、最大 1000）。结果若返回
  `truncated: true`，后续小时触发会继续清除排在前面的旧对象；高于该规模时应提高
  触发频率或拆分维护游标。
- 对象存储是 commit record 的事实来源，公开 `space.json` 是可重建投影。不要绕过 API
  直接编辑 managed 空间清单。
- OSS V1 仍按需求实现，但阿里云已建议新系统使用 V4；迁移 V4 时必须同时替换 Header
  签名与 PostObject policy，不能混用算法。
