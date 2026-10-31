# UNSEEN

照片、原声与共同记忆。

这里是 UNSEEN 的团队代码与文档入口，包含回见 App、AI 记忆相框、核心服务、设备工具、独立 Demo 和历史档案。**直接使用默认 `main` 分支，无需先寻找某个整理分支。**

## 从这里开始

- **了解项目与版本**：[项目地图](docs/team/PROJECT-MAP.md) · [飞书资料中心](https://my.feishu.cn/docx/XCsldUNJvo2NMYxU8j7c4hoOn3m)
- **参与开发**：[安装、运行与协作](docs/team/HANDOFF.md)
- **了解 AI 相框**：[产品概述与演进](docs/products/memory-frame/OVERVIEW.md) · [功能说明](docs/products/memory-frame/GUIDE.md) · [版本记录](docs/products/memory-frame/CHANGELOG.md)
- **查找早期实现、原稿和素材**：[历史总档案](ARCHIVE.md)

## 产品与代码

| 项目 | 内容 | 代码入口 |
| --- | --- | --- |
| UNSEEN App / 回见 | 照片、回忆时刻、空间与家庭相框页面 | [apps/huijian](apps/huijian) |
| AI 记忆相框 | 影石黑客松项目；家人手机端、老人相框端、AI 对话与驻足邀请；0.5.6 | [products/memory-frame](products/memory-frame) |
| 核心服务与共享模块 | 账号、照片、存储、任务、定位与成书 | [services](services) · [packages](packages) |
| 设备与空间处理 | RTX 4060 / WSL 工具、任务与回执 | [tools/agent-bridge](tools/agent-bridge) |
| 交互与展示 Demo | 早期回见、亲亲相框、空间展厅、照片交互、影片页 | [演示目录](docs/team/PROJECT-MAP.md#演示与历史) |

UNSEEN App 内的家庭相框页面与独立 AI 记忆相框保留各自的运行环境。3D 显示屏实验属于独立设备方向，不是 AI 相框的硬件前提。

## 在本地运行

需要 Git、Node.js 22.23.1 或兼容的 Node.js 22 版本。AI 相框安装使用 pnpm。

```sh
git clone https://github.com/maxi-max-dev/unseen.git
cd unseen
npm ci
npm run dev
```

上述命令启动 UNSEEN App 与本地核心服务，通常打开 `http://127.0.0.1:4610/app-v2`。外部模型默认关闭，本地数据保存在 `.local/team/`。

AI 相框独立启动：

```sh
pnpm --dir products/memory-frame/memory-frame-demo/server install --frozen-lockfile
npm run frame:dev
```

打开 `http://127.0.0.1:8787/family` 和 `/frame`。使用新的本地家庭及配对，不使用线上演示账号。具体初始化、AI 配置和摄像头条件见 [相框开发说明](products/memory-frame/README.md)。

## 当前整合范围

2026 年 9 月 24 日整理：保留 9 月 20 日统一仓库及历史档案，补入回见 9 月 21 日增量、AI 相框 0.5.6、亲亲相框 Demo，以及设备通道的新任务与回执。

[来源版本与变换](docs/team/CONSOLIDATION-20260924.md)记录各模块来源。[验证记录](docs/team/VALIDATION-20260924.md)记录本次检查结果。源码整合没有迁移线上服务，公开演示仓库与原仓库继续保留。

## 协作

队友接受本私有仓库邀请后，从 `main` 建立自己的分支，通过 Pull Request 合并。项目说明与日常使用文档在飞书中阅读，代码、测试和可复现说明在本仓库维护。

较大视频、模型、历史 Git 包和原稿通过 [总档案](ARCHIVE.md) 按需获取，不随普通克隆下载。运行凭据和生产用户数据不放入代码仓库。
