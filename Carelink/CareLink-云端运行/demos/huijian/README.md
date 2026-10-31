> 此目录是 2026-09-20 导入的来源快照。统一安装、当前用途、素材与部署边界请先读仓库根目录 README 和 `docs/team/HANDOFF.md`；下文保留原项目说明。

# 回见

从一张照片开始，把没被拍下来的话留成一页。

一个人把一张照片递给阿见 → MiniMax 看图，阿见先说出它确定看见的一两条客观事实，再问照片没有拍下来的事 → 默认聊两句，用户想再补一句才进入第三轮，也可以在第一句后提前结束 → 照片和原话排成一张可打印、可存 PDF 的回忆页。模型只负责看和问，回答不会被改写、润色或代笔。

角色、状态和美术改造入口见 [DESIGN.md](DESIGN.md)。

## 本地运行

需要 Node.js 22+ 和一枚由你自己管理的 MiniMax API key。项目没有 npm 运行时依赖，不需要执行 `npm install`。

```sh
cp env.example .env
# 编辑 .env，填入自己的 MINIMAX_API_KEY
node --env-file=.env server.mjs
```

然后打开 <http://127.0.0.1:4610>。也可以直接通过进程环境传入配置：

```sh
MINIMAX_API_KEY='not-a-real-provider-key' PORT=8080 npm start
```

可选环境变量：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PORT` | `4610` | 本地监听端口 |
| `MINIMAX_BASE_URL` | `https://api.minimaxi.com` | MiniMax API origin |
| `MINIMAX_VISION_MODEL` | `MiniMax-M3` | 看图模型 |
| `MINIMAX_TEXT_MODEL` | `MiniMax-Text-01` | 已知事实组句模型 |

健康检查：

```sh
curl http://127.0.0.1:4610/healthz
```

## 数据与费用边界

- 上传的照片，以及追问所需的最近回答，会经本服务发送给 MiniMax API；它们不是只在浏览器本地处理。
- 运行中的 Node 服务不把照片、回答或 API key 写入数据库或文件（示例部署脚本会把 key 单独写入 root 管理的 `/etc/huijian/env`），但反向代理、主机和模型供应商仍可能按各自配置产生日志。
- `/api/question` 会产生模型调用和费用。服务默认只监听 loopback；把它接到公网前必须另加身份验证、配额和限流。`noindex` 不是访问控制。

## 探针

下面两个命令会真实调用 MiniMax API、发送仓库内的示例照片并产生费用：

```sh
node --env-file=.env tools/probe.mjs
node --env-file=.env tools/probe-provider.mjs
```

## 结构

```text
server.mjs                         node:http 静态文件与 API
lib/minimax-question-provider.mjs MiniMax 提问 provider
lib/provider-keys.mjs                    从进程环境读取 key
public/                            原生前端
photos/                            demo 照片
tools/                             手动探针
deploy/                            单机 systemd/Caddy 示例，不是生产就绪方案
```

## 发布状态与许可

项目代码采用 [MIT License](LICENSE)。

仓库只保留一张为本项目新生成、无人脸的演示照片 `photos/demo-celebration.jpg`；它用于“先试一张”流程。你上传的照片不会写入仓库或服务器文件。
