# unseen 记忆相框

当前整合软件版本：**0.5.6**。手机家人端发送照片和原声，平板相框端展示、收听和回复；AI 提供照片对话、实时语音与驻足邀请。

[产品概述](../../docs/products/memory-frame/OVERVIEW.md) · [使用说明](../../docs/products/memory-frame/GUIDE.md) · [版本记录](../../docs/products/memory-frame/CHANGELOG.md)

## 目录

- `memory-frame-demo/`：Node 服务、浏览器前端、测试和技术记录。
- `devices/link2-windows/`：外置 Link 2 的 Windows 采集与上报源码，不包含专有 SDK 或可执行交付包。
- `docs/`：早期项目计划，按原日期阅读。
- `AGENT-HANDOFF.md`、`START-HERE.md`：原开发历史交接记录，其中的旧版本、原机器路径和部署状态不代表当前统一仓库操作入口。

原稿中的照片素材没有复制为家庭内容；本地示例使用中性生成图。原始设计稿仍在原项目与历史交付资料中。

## 本地启动

```sh
# 从统一仓库根目录执行
pnpm --dir products/memory-frame/memory-frame-demo/server install --frozen-lockfile
npm run frame:dev
```

在浏览器打开 `http://127.0.0.1:8787/family`。首次启动后，从 `products/memory-frame/memory-frame-demo/.data/setup-code` 文件读取本地开通码，在“注册账号 → 创建新家庭”中填写。创建家庭后，从“我的”生成配对链接，在另一浏览器打开 `/frame`。本地账号与线上账号不通用。

启动前不要设置线上 CloudBase 环境。运行数据保存在应用的 `.data/`，已忽略，不共享账号密码或家庭内容。AI 需要独立配置模型与语音服务；克隆源码不会获得现有云环境权限。HTTPS 或 localhost 是浏览器麦克风和摄像头的使用前提。

## 检查

```sh
cd products/memory-frame/memory-frame-demo
node --test --test-concurrency=2 test/*.test.js
cd ..
node --test devices/link2-windows/test/*.test.cjs
```

部分浏览器测试要求 `AI_UX_PLAYWRIGHT` 指向 Playwright 模块、`AI_UX_CHROME` 指向 Chrome 可执行文件。未提供时会跳过对应检查，不能称为完整浏览器验收。Windows 设备构建需另外获取厂商 SDK，见设备目录说明。

前端所需字体、MediaPipe 摄像头模型与 WASM、TRTC 和空间查看器资源保留，许可与版本清单随目录提供。

## 发布与历史工具

此次整合没有部署服务。已有部署、导出及私有打包脚本为原独立仓库工具，部分依赖原仓库目录、原远端或现场配置。不要将其作为统一仓库一键发布命令；迁移到新发布流程前应先审查路径和部署目标。

原 `package-public.mjs` 是历史公开版导出器，白名单不包含当前所有摄像头和实时语音资源，不应直接用它发布 0.5.6。版本判断以运行服务的版本及发布记录为准，部分旧 package.json 仍保留原工程版本号。

最新技术记录：[0.5.5 接手与语音验证](memory-frame-demo/docs/TAKEOVER-20260924.md) · [0.5.6 现场上传](memory-frame-demo/docs/ONSITE-UPLOAD-20260924.md)。
