# 比赛公开源码包

内部生成器 `scripts/package-public.mjs` 从指定 Git 提交的跟踪对象读取资料，不读取工作目录、私有配置或忽略文件。公开仓库扁平为 `server/`、`test/`、`scripts/`；不包含旧 Git 历史、完整 UNSEEN 参考、账号交接、线上验收 URL、真实家庭数据或原始 JPG。新的公开文档模板位于 `public-release/`。

完成 presence 前后端集成后，在总控集成目录运行：

```sh
node memory-frame-demo/scripts/package-public.mjs --source . --output ../NEW_PUBLIC_DIRECTORY --ref HEAD
```

输出必须是不存在、位于源仓库之外的新目录。生成器固定解析一次 Git 提交，按 allowlist 导出；新出现的源码与顶层测试会纳入，未经审阅的文档和脚本默认不纳入。presence 技术指南应放入 `public-release/docs/`，不能直接复制对接方含公网地址和私人路径的原始文件。

每份输出生成 `SANITIZATION-REPORT.json` 和 `SHA256SUMS`。敏感扫描命中时返回失败，只记录相对路径、类别，不回显内容。检测覆盖历史测试登录、旧部署环境、私有路径、常见供应商密钥/JWT/签名 URL 等；模式检测不是秘密不存在的证明，仍需人工审查文件清单和公开变更。生成器本身保留历史 fixture 识别规则，只放内部源码，不复制到公开仓库。

公开包必须重新安装两个锁文件的依赖并运行测试；默认未配置浏览器时的 skip 数量必须如实记录。总控最终启用 Playwright/Chrome 全量运行，并分别记录 API/浏览器替身/硬件边界。校验原始发布清单后可以初始化全新的 Git 仓库，由用户明确授权的 GitHub 公开仓库接收；不能将内部仓库远端改成公开或推送旧历史。

TRTC 官方 npm 版本元数据声明 ISC，但发布包没有独立 LICENSE。公开包保留接口和获取脚本，不附 SDK 字节；PlayCanvas MIT 和 Adobe OFL 保留许可。所有演示图由几何绘图脚本产生 PNG，能被现有上传接口接受，不依赖来源不明的照片。
