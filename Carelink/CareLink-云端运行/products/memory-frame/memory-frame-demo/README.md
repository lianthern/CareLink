# unseen 记忆相框

手机网页家人端与电脑/平板相框端共享同一家庭的照片、原声和空间记忆。沿用最早 Demo 的粉蓝手帐风格与“首页 → 中央＋ → 我的”顺序，参考与功能边界见 [PRODUCT-REFERENCE.md](docs/PRODUCT-REFERENCE.md)。

- [家人端](https://memory-frame-demo-d7djiee0702b6c.service.tcloudbase.com/family)
- [相框端](https://memory-frame-demo-d7djiee0702b6c.service.tcloudbase.com/frame)

首次访问可能需通过腾讯云测试域名提示页。当前公网版本支持账号登录；不用安装软件或自行配置腾讯云。

## 使用

1. 家人端已有账号直接登录。新建家庭需开通码；加入家庭使用家人邀请注册自己的账号，旧免账号邀请仍兼容。
2. 首页查看家庭记忆、人物、年份与相框实际状态；首页与人物/时间轴可点“加载更早记忆”浏览完整历史。中央“＋”添加照片、文字、录音或影石空间链接。录音需 HTTPS 浏览器允许麦克风。
3. “我的”查看成员、设备、统计，邀请家人或生成相框配对链接。在另一台电脑/平板打开配对链接，相框无需账号密码。
4. 相框看照片、听原声并录音回复；家人端查看回执、听回复、修订人物与年份。AI 整理需家人确认。
5. 空间页保存支持的影石链接，点“导入空间”，准备好后“打开空间”；支持旋转、缩放、平移、复位并保留来源。导入已有模型，不训练或重建。云端导入和三个身份的完整模型传输已验证。

测试账号 `fixture01`（创建者）与 `fixture02`（家人）同属“unseen 双账号测试家庭”。密码由交付消息单独提供，不写入源码。像素图片、静音 WAV、文字和影石样例明确用于验收，不是用户真实家庭资料。

## 开发与验收

本地在 `server/` 安装锁定依赖，回本目录运行 `node server/server.js`，默认地址 `127.0.0.1:8787`。数据与开通码位于忽略目录 `.data/`、`.data/setup-code`。详见 [START-HERE.md](../START-HERE.md)。

当前公网版本 `0.4.2`；本轮 `node --test test/*.test.js` 共 129 项通过。完整历史分页已部署，复用既有两账号验证各 4 页读完原有 8 条记忆、权限与退出失效，9 个静态资源与本地一致。超过 150 条的完整遍历由隔离本地 HTTP 测试覆盖，详见 [本轮验收](docs/HISTORY-ACCEPTANCE.md)。前次照片/WAV、相框回执/回复和真云 3D 分段摘要证据保留，本轮没有全部重做。新版浏览器操作、手机真人录音和触控仍未验证，不以接口或窄视口测试代替。

既有上海 CloudBase 环境为 `memory-frame-demo-d7djiee0702b6c`。私有配置 `cloudbaserc.local.json` 被 Git 忽略；`node scripts/deploy.mjs --update` 只更新该环境。旧 UNSEEN 服务和 DNS 不变。

这仍是可体验的 Demo：没有密码找回/改密码、多家庭切换、后台系统推送、原生安装包、专用硬件或完整生产运维。测试域名有平台提示与限制；正式服务仍需域名备案、备份导出/彻底删除、监控与容量验证。

[账号](docs/ACCOUNTS.md) · [部署与真实验收](DEPLOYMENT.md) · [Windows 接手](docs/WINDOWS-ACCEPTANCE.md) · [总控交接](HANDOFF.md)
