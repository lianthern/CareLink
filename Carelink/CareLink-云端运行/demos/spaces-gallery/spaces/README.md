# UNSEEN 空间分享版：服务器接手入口

## 2026-09-12 独立服务器构建

独立试用入口：<https://spaces.maxxam.xyz/spaces/>。备用直连入口：<https://maxxam.xyz/spaces-preview/>（同一份服务器文件，适合新域名的 DNS 缓存尚未刷新时试用）。原 GitHub Pages 版本保留。

服务器现为国内慢网优化 v2：独立域名接入 EdgeOne 境外 CDN；14 个模型先加载约 0.92–0.97 MB 的可漫游预览，然后自动替换为原始完整 SOG。原模型、照片及机位不变。2 Mbps/150 ms/无缓存的同条件测试，15.4 MB 案例首次可操作由 64.9 秒降至 6.9 秒；完整画质仍需约 68.6 秒。模拟限速不是国内家庭宽带实测。部署、故障恢复、复现和限制见 [国内慢网优化记录](deploy/MAINLAND-20260912.md)。

```bash
node spaces/deploy/verify.mjs
node spaces/deploy/build-server.mjs .deploy/my-new-release
```

`build-server.mjs` 需要全新的输出目录，先校验原有 32 个模型/照片文件和已提交的轻量预览清单，再生成独立静态包：模型、预览、查看器和脚本使用内容哈希文件名；HTML 提前加载查看器、机位清单与当前预览；文本提供 Brotli/gzip 预压缩副本。原模型与照片的 SHA256 保持一致；预览临时降低细节，最终恢复原模型画质。`release-manifest.json` 可用于上传后的逐文件验收。加 `?quality=full` 可直接加载原模型。

服务器使用现有 Caddy，无需新增数据库、应用进程或 Docker。参考 `deploy/Caddyfile.spaces`，把构建目录放在 `/var/www/unseen-spaces/releases/<release>/`，`current` 软链接指向当前版本。先验证完整 Caddy 配置、备份旧配置，再增加独立域名并 reload；后续用新的不可变目录和原子软链接切换，保留旧版本。不要覆盖其他站点配置。原始 `/spaces/` 源文件仍可以直接部署到 GitHub Pages。

模型和脚本的一年缓存只用于含内容哈希的文件名；页面/清单重新验证，图片缓存一小时。浏览器以 `sceneState=ready`、真实 FPS 和资源计时验收；首页不下载任何模型。具体速度由访问网络、服务器带宽和浏览器缓存共同决定，本机测试不能替代另一台电脑的结果。

此目录包含完整的静态网站、14 个已完成版本的 SOG 模型、查看器依赖，以及照片测试案例的原图、缩略图、真实已验证机位。无需运行训练、数据库、本机 8780 服务或照片定位 API。所有资源使用相对路径，推荐统一挂载到 `/spaces/`。

## 照片测试案例

- 港科大 360Roam Base：`view/scene-3aafc6cc274a/?photos=1`，3 张定位测试照片。
- PanDORA 室内咖啡间：`view/scene-8af1691afe40/?photos=1`，3 张未参与建模的独立照片。
- OmniPhotos 教堂：`view/scene-aaff992ddb8c/?photos=1`，3 张预先留出的视频帧，不冒充独立实拍照片。

点击空间照片恢复 XYZ、朝向和 FOV。照片作为不透明平面固定在世界坐标中，拖动转头时不跟随视屏；可放大原图或收起继续漫游。这是经定位的照片展示，平面的显示距离不是测量得到的真实表面深度。

## 从 GitHub 获取完整文件

仓库：`https://github.com/maxi-max-dev/unseen-ui-preview`，分支 `main`，目录 `spaces/`。模型已经是 GitHub 中的真实二进制文件，不是 LFS 指针或指向本机的链接。

```bash
git clone --filter=blob:none --sparse https://github.com/maxi-max-dev/unseen-ui-preview.git
cd unseen-ui-preview
git sparse-checkout set spaces
node spaces/deploy/verify.mjs
cd spaces
```

在新目录克隆即可，不必改动服务器原有应用。此版本仅需静态文件服务。

## 方案 A：现有 Nginx / Caddy 静态目录

把整个 `spaces/` 文件夹复制到网站文档根目录下，保留层级。访问 `https://你的域名/spaces/`。Nginx 需要把 `.mjs` 以 JavaScript MIME 返回、`.json` 以 JSON 返回，二进制模型保持原样；不得将 404 资源改写为 SPA 的 index.html。

模型响应应有正确 Content-Length，支持 Range，允许缓存；HTML、JS、JSON 建议 `Cache-Control: no-cache`，模型与图片建议 `public, max-age=3600` 并保留 ETag/Last-Modified。模型已压缩，不必额外 gzip SOG；JS/CSS/JSON 可启用 gzip。完整示例见 `deploy/nginx.conf`。

## 方案 B：独立 Docker 容器，接现有反向代理

在 `spaces/` 目录运行：

```bash
docker build -f deploy/Dockerfile -t unseen-spaces:photos .
docker run -d --restart unless-stopped --name unseen-spaces-preview \
  -p 127.0.0.1:8098:8080 unseen-spaces:photos
curl -I http://127.0.0.1:8098/spaces/
```

现有域名的 Nginx server 中可添加以下独立路径；`proxy_pass` 末尾不要加斜杠，保留 `/spaces/` 前缀。先运行 `nginx -t`，通过后按服务器现有运维流程 reload。不要覆盖已有 server 配置。

```nginx
location /spaces/ {
    proxy_pass http://127.0.0.1:8098;
    proxy_set_header Host $host;
}
```

容器名、端口如已占用，应另选空闲名称/端口。HTTPS 沿用服务器现有配置。此交付不自动安装 Docker/Nginx、不改 DNS、不覆盖任何在线服务。

## 上线验证

交付前已用 Chrome 本地验证全部 14 个模型加载，以及电脑/手机的照片回位、固定平面、原图显示和下载进度。当前电脑的 Docker 引擎未运行，因此容器与目标服务器 Nginx 的启动检查由接手电脑完成；以下步骤是该部分的验收清单。

1. `node spaces/deploy/verify.mjs` 校验模型和图片字节数、SHA256。
2. 打开 `/spaces/`，8 个空间都有入口，筛选、搜索与版本切换正常。
3. 打开上述 3 个照片入口，逐张点击；检查真实画面、照片回位、转头后照片固定、原图放大、收起继续漫游。
4. 用手机检查港科大或咖啡间，确认图片与模型返回 200，模型下载提示显示字节进度。
5. 网络面板确认模型不访问 GitHub、127.0.0.1 或本机 8780；所有运行资源从你们的域名加载。

## 加载慢的本机实测（2026-09-12）

同一台电脑、港科大模型，GitHub Pages 首次就绪约 31.6 秒，本机服务约 1.75 秒（均包含测试中 1 秒的画面稳定等待）。Pages 模型请求约 22.0 秒，其中传输约 21.0 秒；查看器 JS 请求约 6.25 秒。模型约 15.4 MB。说明文件已上服务器，当前主要等待在下载链路；不能据此保证任何一台新服务器的速度。

本次已增加模型 MB / 百分比 / 已用秒数，区分连接、下载、解码阶段；静态快照不再每 5 秒重复请求照片机位。换服务器后，需从队友常用网络重新实测。仅照片原图和模型已经上传，训练源视频、checkpoint 和账号数据库不属于本静态站的运行依赖。
