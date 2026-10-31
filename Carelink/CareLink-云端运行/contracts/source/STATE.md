# UNSEEN 产品重构总控状态

更新时间：2026-08-13（Australia/Brisbane）  
状态：历史C2/C3/C4与Track 4已PASS；本次 `runtime erratum + L3 Book Lab` revision 已完成 Codex C2 与桌面 Claude Code C3，均为 P0=0/P1=0。当前只剩 controller 生成派生物、原子 re-freeze 与独立读回；C4读回前业务Track继续停笔。

## 完成后世界

UNSEEN 成为一套可公开交付、可继续适配小程序与原生端的响应式 Web/H5 产品：外部用户通过邀请查看空间或上传照片；成员登录后从“我的空间”管理；普通照片经可信自动定位或人工兜底回到正确360现场；之后可选地由AI围绕每张照片问一个问题，用户确认原话并逐书授权，最终形成有空间来源、多人署名视角、可撤回版本的HTML/PDF记忆书。权限、审计、隐私、可访问性、真机、监控与发布门禁均有当前证据。视觉从2026-07-25六张美术参考图出发，不回到V11拼皮。

## 权威真相

1. Max 当前目标：推到可上架最终版；逐页文案跑通；Codex 验收后交桌面 Claude Code 独立验收；双方同意后拆给多个隔离施工任务；施工回传后由总控统一验收。
2. 产品决策：`product-ui/**` 整改后的冻结合同。
3. 技术决策：`technical/**` 整改后的冻结合同。
4. Durable 决策：MaxNotes `UNSEEN-项目总纲-2026-07-30.md` 的 2026-08-13 覆盖层。
5. 视觉证据：`product-ui/evidence/ref-1.webp` 至 `ref-6.webp` 与 `SOURCE-OF-TRUTH.md`。

## 已冻结的用户决定

- 未登录首页只有“打开空间”和登录；不选角色，不做无 Space 上下文的通用上传。
- owner / reviewer 登录后从“我的空间”进入；外部 invitation 只授予 view / upload 或两者组合。
- 当前 Web 完全移除多照片生成 / 拼接全景；只接收成品 2:1 全景。
- 高可信自动定位直接落位；uncertain / OOD / ambiguous / abstained 才进入待确认。任务失败 / 超时进入失败态，可重试或人工调整，但不得伪造定位建议。上传者只改本人照片；owner 全部；reviewer 按 scope；修改可审计、可撤回。
- DAP 只是有限视差；video / scan → 可走 3D 是独立研发，不冒充当前产品能力。
- 照片语义注脚是定位后的异步可关闭实验，不进 v1.0 gate，不替代空间定位，不做人脸识别或情绪猜测。
- L3 Book Lab已由Max纳入本轮完整施工与最终E2E：AI只提问，回答可编辑确认；SceneNote不能直接入书；每条内容对指定Book另行授权，冲突保留署名视角；先做HTML/PDF，不做印刷、支付、订单或物流。
- UI 全局采用“共光”方向；电脑管理页只借“合流轨”的三栏密度与真实关系线。六张早期美术图是视觉母版，V11 仅作历史回归证据。
- fast 始终关闭。主合同、架构、P0/P1与终验使用 gpt-5.6-sol / xhigh；边界清楚的证据任务可用 gpt-5.6-terra / xhigh，必须由主 Sol 复核。

## 当前阶段与门禁

| Gate | 状态 | 证据 / 下一步 |
|---|---|---|
| C0 两份第一版合同 | 完成但红队 FAIL | 三路独立红队发现 canonical 状态、全景换版、receipt/member invitation、文案与发布门禁冲突 |
| C1 合同整改 | 完成 | 产品真源 89 actions / 801 phases 与 technical coverage 89/89 已同步 |
| 历史 C2 Codex 交叉验收（本revision前） | PASS · historical only | 独立产品/UI/文案、技术/API安全、施工编排三路均 P0=0、P1=0、P2=0；该结论不覆盖当前runtime+Book revision |
| 历史 C3-contract 桌面 Claude Code 反审（本revision前） | **PASS · historical only（P0=0、P1=0、P2=0）** | 桌面会话 `local_bfee6f1c-72ad-44d9-b26c-7e102960e31e`；该结论不覆盖当前runtime+Book revision |
| 历史 C4 冻结合同 + 0L bootstrap（本revision前） | PASS · historical only | bootstrap `a790b3a2d152701e75171cb4dfdeeda52e7bfbd5`；provenance/source/visual/worktree matrix与freeze gate已独立通过 |
| Module 4 Viewer | PASS | `5e068e3d04263adc2f480ac9db5a3bc1f18157d7`；P0/P1/P2=0，30分钟soak与真实WebGL/yaw/depth/a11y/cleanup通过；保持只读 |
| Module 1A API | FAIL，停笔 | candidate `5bcf9cd373211a73b6a1be3b93a957a6203698ec`；需修identity整表迁移、support、deletion-status credential及其余P1；dirty WIP保留不得丢弃 |
| Module 2 Web | own-scope P0/P1=0，跨owner NO-GO，停笔 | candidate `32154dcaa191ef0f0732fb7904fd0dc94976f1ed`；等待1A提供session-auth non-bearer media URL与photo identity后跑1A→2→4真链 |
| Contract revision C2/C3/C4 | **C2 PASS / desktop C3 PASS / C4 re-freeze中** | 固定候选 `cd01736a0f7e319bc973a2d93d99026189d8695d`；C2 P0=0/P1=0；桌面C3窄复验P0=0/P1=0、三个普通P2登记post-local；只剩32-entry provenance、11 generated、FREEZE v2与controller读回 |
| Core Local Operable | C4读回后立即推进 | 不等待sandbox/真实定位数据；1A+2+4在Track5 Stage L形成可由Max操作的本地真链，定位fixture醒目标记；不等于Integration/R0 |
| Track 8 Book Lab | C4读回后按fixture分波开工 | 8A API/jobs与8B Web/HTML/PDF先按冻结fixture施工；只有精确Core seam、8C单写集成与对外启用等待fixed Core RC，Core R0前不对外启用 |
| R0 上架总验收 | 待开始 | 真实外层 E2E、双端视觉、文案、权限、真机、隐私、安全、监控、回滚与发行材料全部通过 |

## 当前未满足的关键事实

- 尚无任何平台完成当前生产“全景→照片上传→可信自动定位→人工修正→审核→照片回360→跨设备”的完整 NOW 链。
- 尚未冻结可审计 CloudBase live source / deployment identity，也未执行允许云写的隔离生产 E2E。
- 自动定位标注集、模型、置信门槛与 OOD 仍未通过发布 gate。
- 账号供应商、正式法律文本、UGC/举报/删除策略、目标设备矩阵与打包资产许可仍需在施工/发布阶段关闭。
- DAP 当前许可证不可直接用于商业发布；true 3D 当前为 ABSENT。
- 正式QuestionProvider模型/供应商和真实问答质量尚未选择/验证；合同先冻结port、provenance与失败隔离，确定性fixture不能冒充真实质量。

## 下一动作

总控只生成本次revision的验收收据、32-entry provenance、11 generated 与 FREEZE v2，原子amend后独立读回。C4 Complete后首波恢复1A/2并创建fixture-only 8B；1A/2/4停笔后以Track5 Stage L+8A+3A交付Max本地可操作版并继续Book fixture施工→再按三写者上限轮换6A，且只在获授权时纳入1B/3B证据→Track5 Stage RC固定Core RC→6B与8A/8B精确seam分波→8C→独立Core R0与Book MVE终审。不得用历史C2/C3 PASS覆盖本次新增语义，也不得让普通post-local P2阻塞Local Operable。

### 历史 pre-revision C3 桌面运行记录（2026-08-13，不覆盖本revision）

- `node_repl/@oai/sky` 桌面控制通道已恢复；此前的运行环境阻塞已解除。
- 已在 Claude Code 桌面端新建本地会话 `C3-contract 独立反审`，挂载本合同根目录并发送完整只读任务书；会话 ID 为 `local_bfee6f1c-72ad-44d9-b26c-7e102960e31e`。
- Claude 已开始读取任务书并先验证 8 个锁定 SHA-256；当前未授权修改文件、创建母仓/worktree、施工、部署、发布、云写、账号或凭证操作。
- Claude 已完成约 18 分钟独立只读审查并判定 `C3-contract: FAIL`；完整报告仍停在桌面会话，且已复制到系统剪贴板。8 个合同 hash 审前审后逐字节一致，六张美术母版校验 7/7 OK。
- Round 2 对整改后快照独立判定 `PASS（P0=0、P1=0、P2=2）`；两项 P2 是过期状态说明与瞬时不可用文案，均在冻结前完成最小修正。
- 技术 coverage 仅重锁新 STRING hash；gate 实跑 `ACTIONS=90 / SOURCE_CHECKS=360 / PHASES=810 / MUTATIONS=59↔59 / TECHNICAL_OPS=6 / INTERNAL_OPS=1 / REFERENCE_DRIFT=0 / ERRORS=0`。retry reference 九字段逐值相等，隔离副本 drift 负测正确拒绝。
- 桌面 Claude 对最终差异做两次定点只读复验；最后确认八个冻结真源 hash 不变、线框与 catalog 文案 byte-exact，最终结论为 `C3-contract: PASS · P0=0 · P1=0 · P2=0`。
- 禁止改用 `claude` CLI、AppleScript 或后台写会话文件冒充桌面流程；也禁止绕过 C3 提前进入 C4/I0。

## 授权与安全边界

- 当前允许：controller-only root-maintenance修改合同、生成物、门禁与freeze/provenance；所有业务worktree停笔，现有dirty WIP不得清理或覆盖。
- 本revision C4 re-freeze后已获授权：按编排恢复隔离业务Track并创建fixture-only 8A/8B；只有fixed Core RC后才可写精确extension seam，并由8C单写集成。
- 未自动包含：生产部署、正式发布、删除历史工程/数据、付费模型采购、扩大云权限、向外部联系人发信。到对应 gate 时须核对目标与影响后再执行。
