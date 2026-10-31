# 安全与数据边界

## 允许进入 GitHub

- 任务合同、schema、脚本和文档
- 状态回执、脱敏错误摘要
- benchmark 数字和 Markdown 报告
- 已审查且不含私密素材的交接 ZIP（仅 Private Release）

## 禁止进入 GitHub

- 原始视频、拆帧、任何用户/客户隐私素材
- `.sog`、`.ply`、checkpoint、训练缓存和 `work/`
- `.env`、GitHub/生产 token、Cookie、SSH 私钥、vault 内容
- 包含上述内容的压缩包

`.gitignore` 只是最后一道护栏，不是上传许可。4060 Agent 在提交前仍须检查 `git status --short`。

## 权限

- 仓库保持 private；若可见性不是 private，接收脚本失败关闭。
- 两台机器各自通过 `gh auth login` 使用系统凭据存储；不在仓库共享 token。
- 4060 不开放端口，只使用出站 HTTPS。
- 本仓库没有生产凭据，也不授权调用 UNSEEN 生产 API/数据库。
