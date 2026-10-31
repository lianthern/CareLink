# 4060 H3 复用与 private Bridge 接单

安装技术验收已通过。本文件是总控下一阶段的交接说明，未执行下列命令、未派发正式制作任务。

## 已验证入口与 GPU 边界

现有环境 `D:/H3-runtime/.venv`、模型 `D:/H3-runtime/models`、源码 `D:/H3-runtime/ComfyUI`；服务只监听 `127.0.0.1:8193`。无需重新安装或下载。复用执行端会话 `01a098ec-6a73-7070-a239-b0d73104c896`。

最终报告称旧 3DGS worker 当时已不存在，H3 未停止/重启它。已审阅 `guard_service.py`：非阻塞取得 `/home/max/unseen-local-product/state/gpu-worker.lock` 独占 flock，SQLite 以只读模式检查 queued/leased/running/uploading 均为零后输出 LOCKED。`run_service.py` 只有收到 LOCKED 才启动 H3，正常服务退出后关闭管道释放锁。因此代码与成功运行记录支持本次按既有锁约定进入 GPU，不需要以终止旧 worker 取得窗口。

这不是永久 GPU 所有权。当前服务停止/锁已释放为执行端报告，最终 `service-exit.json`、进程/锁快照未上传；下一次必须重新检查端口并经过同一共享锁。

**长流程复用前的一处实际缺口：**队列只在启动前检查一次，`run_service.py` 等待 H3 子进程时没有监测 guard 意外退出。若 guard 提前消失，锁可能已释放而 H3 仍运行。正式无人值守制作合同应要求执行端补上 guard 存活监督，失锁即停止本次已核身份的 H3 进程树，并验证失锁分支。本轮只验收，没有修改远端脚本；不能声称已有该保护。

## 启动命令

以下是已用入口的 PowerShell 复用形式。先完成上面的长流程失锁保护，再用于正式无人值守制作；不要直接绕过 runner 启动 main.py。

```powershell
$ErrorActionPreference = 'Stop'
$H3Listen = @(Get-NetTCPConnection -LocalPort 8193 -State Listen -ErrorAction SilentlyContinue)
if ($H3Listen.Count) { throw 'Port 8193 is occupied; inspect the existing owner, do not start another service' }
$H3Runner = Start-Process -FilePath 'D:\H3-runtime\.venv\Scripts\python.exe' -ArgumentList '-X','utf8','D:\H3-runtime\run_service.py' -WorkingDirectory 'D:\H3-runtime' -WindowStyle Hidden -PassThru
$H3Runner | Select-Object Id, StartTime
```

启动结果须看当次 `logs/service-guard.json`、`logs/guard.stderr.log`、`logs/comfy-service.log` 与实际 `http://127.0.0.1:8193/object_info`，不能把 Start-Process 返回当服务可用。实际 main 参数为 `--listen 127.0.0.1 --port 8193 --disable-auto-launch --extra-model-paths-config D:\H3-runtime\extra_model_paths.yaml --output-directory D:\H3-runtime\output --cache-none --disable-pinned-memory --fast-disk`。

## 只停止本次 H3 的命令

先确认该制作任务已经结束、没有需保留的本次推理。以下防误停片段使用当次 service-guard 元数据，核命令和创建时间；如存在同 main.py 参数的 H3 子进程，先停这些子进程，再停记录的服务进程，避免只停外层启动器。判断不符或记录缺失就退出，不按进程名批量杀、不停止 WSL/3DGS。此片段为交接建议，未在 Windows 运行。

```powershell
$H3StopCode = @'
import json, pathlib, datetime, psutil
root = pathlib.Path('D:/H3-runtime')
record = json.loads((root/'logs/service-guard.json').read_text())
owner = psutil.Process(int(record['pid']))
expected = record['command']
started = datetime.datetime.fromisoformat(record['startedAt']).timestamp()
if owner.cmdline() != expected or abs(owner.create_time() - started) > 10:
    raise RuntimeError('H3 process identity/start time mismatch; stop not attempted')
parent = owner.parent()
if parent is None or not any(x.replace('\\','/').lower() == 'd:/h3-runtime/run_service.py' for x in parent.cmdline()):
    raise RuntimeError('Expected H3 runner parent missing; inspect before stopping')
main = 'd:/h3-runtime/comfyui/main.py'
def matches_main(p):
    return any(x.replace('\\','/').lower() == main for x in p.cmdline())
if not matches_main(owner):
    raise RuntimeError('Expected H3 main.py missing')
children = [p for p in owner.children(recursive=True) if matches_main(p)]
for p in children:
    if p.create_time() < owner.create_time():
        raise RuntimeError('Child identity/time mismatch')
print('Stopping verified H3 targets:', [p.pid for p in children] + [owner.pid])
for p in reversed(children):
    try:
        p.terminate()
        p.wait(timeout=30)
    except psutil.NoSuchProcess:
        pass
try:
    owner.terminate()
    owner.wait(timeout=30)
except psutil.NoSuchProcess:
    pass
'@
$H3StopCode | & 'D:\H3-runtime\.venv\Scripts\python.exe' -X utf8 -
if ($LASTEXITCODE -ne 0) { throw 'H3 stop needs identity review; do not fall back to blanket kill' }
Get-NetTCPConnection -LocalPort 8193 -State Listen -ErrorAction SilentlyContinue
Get-Content -Raw 'D:\H3-runtime\logs\service-exit.json'
```

最后应确认属于本次 H3 的进程已退出、端口无监听、runner/guard 退出并释放共享锁。若仍有占用，按已记录的归属排查，不能操作其他 owner。不要复用历史 PID 18112。

旧 `run_smoke.py` 遇 `logs/smoke-submit.json` 会拒绝第二次提交。保留这一历史记录；正式分段制作使用新任务目录、每段独立 submission/history/output 和去重键，不能删旧 guard 让它重跑。已验证 API/workflow 在最终证据 `smoke-api.json`/`smoke-workflow.json`，作为起点，不是人物/首末帧一致性已验收证明。

## 完整素材包如何发送与接单

总控拥有完整制作合同与派发职责；本安装任务不创建新任务或新执行端。下一步在同一个 **private** 仓库 `maxi-max-dev/max-agent-bridge` 中由总控选定新的制作 job ID/Issue/tag，复用现有 Windows 执行端和登录态。安装 Issue22、原 ZIP/tag/历史回执保持原样。

1. 将逐段制作合同、目录索引、输入用途、每段验收规则、媒体资产精确 bytes/SHA、恢复/去重规则放入新任务的文本控制包。`TASK.json`、`START-HERE.md`、逐文件 `MANIFEST.json`、独立的 `PRIVATE-INPUTS.json` 固定到同一合同 commit/tag；控制包可由现有接收器核验。通用接收器限制单成员 32MiB、展开总量 128MiB；发布校验器禁止常见媒体进入任务树/控制包，别直接把照片塞进原安装包或更改通用规则。
2. 用户已明确“把东西都发给他”用于完整制作。新制作合同应写明这次具体私人输入和输出允许在本 private Release 传递；不能套用旧安装合同仅允许中性 smoke 的例外。将**此次合同指定的参考素材**作为该新 Release 的独立媒体资产/专用素材 ZIP，素材不入 Git，不公开。文本控制包只包含匿名资产 ID、用途、资产名、bytes/SHA 和必要授权范围，不带凭据或签名下载 URL。
3. Mac 上传后私有重下载核对资产大小和 SHA，冻结素材 ZIP 内每个文件的清单。Windows 先通过现有 `Receive-BridgeJob.ps1` 核验新文本控制包，再按已验证的 `PRIVATE-INPUTS.json` 用 `gh release download <新tag> --repo maxi-max-dev/max-agent-bridge --pattern <精确素材资产名> --dir <该任务新目录>` 取素材。普通 gh 下载不会核素材清单：执行端要另核下载字节数/SHA、ZIP 路径/展开界限、每文件哈希。只在全通过后进入逐段生成；损坏包保留隔离，已正确素材和模型复用。
4. 沿既有接单入口，复用 `$env:USERPROFILE\AgentBridge-H3\control\scripts\windows\Receive-BridgeJob.ps1 -JobId <总控创建的新job> -BridgeRoot (Join-Path $env:USERPROFILE 'AgentBridge-H3')`。接收器会更新干净 control checkout 并核 private/tag/TASK/控制 ZIP/manifest，产生 `RECEIVED_VERIFIED`。这证明控制包已收到；素材另存 `INPUTS-VERIFIED.json` 实测清单，随后追加合法 `RUNNING` 回执。未收到回执前不能把“已发布”当“已接单”。
5. 现有 h3 定时任务据完成评论已暂停，GitHub 发 Issue 本身不保证唤醒该会话。总控通过既有 4060 接单渠道交付一次新工单入口，复用此执行端；只有确需恢复推进时让执行端恢复现有机制，不在 Mac 再建同用途执行监控。分段结果以新 job 回执/报告和有哈希的 private Release 资产回传，前段完成可验收后继续，最终统一全解码/拼接验收。

这条路径沿用已经验证的私有运输、完整性校验和回执协议；新的私人媒体授权、逐段合同和素材清单由总控在下一任务落实，本轮尚未发送素材或开始创作。
