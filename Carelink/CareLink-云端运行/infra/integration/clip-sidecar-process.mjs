// infra/integration/clip-sidecar-process.mjs
//
// 把 services/locator/sidecar/server.py 当子进程拉起来/收掉。只在 UNSEEN_LOCATOR_MODE=clip
// 时才会被调用 —— 默认的 deterministic_local_fixture 模式完全不碰这个文件。
//
// 进程边界：sidecar 只监听 127.0.0.1，端口不对外；venv 解释器路径由调用方传入(不依赖 PATH
// 里的系统 python)；stdout 第一行 UNSEEN_CLIP_SIDECAR_READY 是就绪信号，但仍然用 /healthz
// 轮询兜底确认(子进程把那行打印出来不代表 HTTP server 已经能接请求，留一点时间余量更稳)。

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export function resolveSidecarPaths(repositoryRoot) {
  const sidecarDir = path.join(repositoryRoot, "services/locator/sidecar");
  const pythonBin = path.join(sidecarDir, ".venv/bin/python");
  const serverScript = path.join(sidecarDir, "server.py");
  return { sidecarDir, pythonBin, serverScript };
}

export function spawnClipSidecar({
  repositoryRoot, host = "127.0.0.1", port = 8791, modelsDir, spawnImpl = spawn, preload = true
}) {
  const { sidecarDir, pythonBin, serverScript } = resolveSidecarPaths(repositoryRoot);
  if (!existsSync(pythonBin)) {
    throw new Error(`clip_sidecar_venv_missing: ${pythonBin} 不存在，先跑` +
      ` "python3.11 -m venv services/locator/sidecar/.venv && .venv/bin/pip install -r requirements.txt"`);
  }
  const args = [serverScript, "--host", host, "--port", String(port)];
  if (preload) args.push("--preload");
  const child = spawnImpl(pythonBin, args, {
    cwd: sidecarDir,
    env: { ...process.env, HF_HOME: modelsDir, SENTENCE_TRANSFORMERS_HOME: modelsDir,
      // sidecar 自己不需要继承一屋子 Node 环境变量里的密钥，但目前保留 process.env 简单省事；
      // 这条留白：如果以后要收紧，在这里换成一个白名单 env 对象即可，调用方不用改。
      PYTHONUNBUFFERED: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const lines = [];
  child.stdout.on("data", (chunk) => { lines.push(chunk.toString("utf8")); });
  const stderrLines = [];
  child.stderr.on("data", (chunk) => { stderrLines.push(chunk.toString("utf8")); });
  return {
    child,
    baseUrl: `http://${host}:${port}`,
    recentStdout: () => lines.join(""),
    recentStderr: () => stderrLines.join(""),
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } resolve(); }, 3000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
  };
}
