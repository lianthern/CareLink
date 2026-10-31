# UNSEEN 独立 Web（upload-first MVP）

正式入口是 `index.html`。这是纯静态应用，不依赖构建工具；本地用任意 HTTP 静态服务器启动即可。不要用 `file://` 打开，因为浏览器会阻止 ES module。

## 已接通的能力

- 默认通过正式 managed API 创建可分享空间：`createSpace → 精确 OSS policy 上传封面/全景 → finalizeSpace`；创建者凭证只保存在本机 IndexedDB，不进入 URL 或分享链接。
- 明确提供“仅保存在本机”次要动作，媒体 Blob 持久化在 IndexedDB；云端失败不会静默降级为本机草稿。
- 创建或打开过的共享空间会保存本机历史，可从首页和“我的空间”重新打开。
- 普通照片一批最多 9 张；阻断 HEIC/HEIF 和 20 MB 超限；本机压缩至最大边 2560px、JPEG 质量 0.82。
- 选择外部制作完成的 2:1 全景原图；校验 JPEG/PNG/WebP、50 MB、1600×800、1.90–2.10；默认 2D 查看。
- 通过 `?s=<空间编号>` 或页面输入加入现有 UNSEEN 官方 OSS 空间；正式版拒绝邀请链接覆盖存储地址。
- managed 空间按 `photoTicket → 精确 OSS policy POST → commitPhoto` 投稿，稳定 `clientUploadId` 支持幂等重试；既有 `s4` 等空间继续兼容 legacy policy 直传。
- policy 过期、关闭、缺失或不完整时立即阻断并明确提示，不无限转圈。

## 正式 API

正式地址只定义在 `unseen-core.mjs` 的 `UNSEEN_API_URL`，不要在页面逻辑或测试里另写一份。API 返回统一 `{ok,data,error}`，创建者操作使用 `X-Unseen-Host-Key` 请求头。

客户端只接受 UNSEEN 正式 API 与官方 OSS；所有 managed policy 必须是服务端返回的精确对象键、私有 ACL 和限时签名。API/OSS 超时与失败会保留当前页面并给出中文错误，重试沿用同一幂等标识。

## 本地验收

```sh
node web/test-upload-first.mjs
python3 -m http.server 4173
# 另一个终端（本机已安装 Playwright 时）
PLAYWRIGHT_MODULE=/opt/homebrew/lib/node_modules/playwright/index.mjs \
CHROME_EXECUTABLE="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
node web/test-browser.mjs
```

浏览器测试包含 mocked managed API/OSS 全链路，不会向生产写入；另检查 `http://127.0.0.1:4173/portal.html?s=s4` 的 legacy 读取路径。
