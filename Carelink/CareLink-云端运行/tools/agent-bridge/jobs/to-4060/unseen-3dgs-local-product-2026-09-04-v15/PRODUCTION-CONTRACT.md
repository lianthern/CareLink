# 生产租约适配缺口（只读结论）

已只读检查两个真实存在的生产工作树 `/Users/max/code/unseen` 与
`/Users/max/code/unseen-cc/huijian`，没有修改、提交或部署。现有
`unseen-private-ai-pull/1` 确实提供 HTTPS 出站 pull、单 active lease、约
180 秒 lease、poll/retry 和幂等完成/失败；但它只接受
`photo_visible_facts_question_v1` 这类小型 private image analysis。现有发布证据还把
queue 标为默认关闭、未部署/NO_GO，heartbeat 也只随 authenticated lease poll
持久化。两个工作树里都没有已获授权的 SceneWorker 长任务 route、分片 artifact API
或可直接复用的生产凭据。

真实接入至少还缺服务器端明确授权与以下合同：

- multi-hour renewable lease 和允许的 heartbeat 频率；
- `jobId + sceneRevisionId + input/artifact SHA256` 的不可变绑定；
- 分片/断点 artifact upload（不能把 SOG/PLY 塞进 JSON complete）；
- `uploading` 状态、upload session 幂等、commit/abort；
- 服务器离线/worker 离线后的 lease 回收语义；
- preview 成功后才可发 quality 30k 的服务端门；
- 租户/隐私保留、删除、审计和 worker capability 授权。

因此 `inputs/product/production_adapter.py` 只声明 contract 并在构造时 fail closed。
当前真实接入还需要生产端 owner 明确授权、服务端协议/数据库迁移、Caddy internal
route、worker token/hash file 的安全配置和部署验收。本包没有生产 URL、token、
数据库写入、真实 job 或部署；不能把本机 canary 的成功写成生产已接通。
