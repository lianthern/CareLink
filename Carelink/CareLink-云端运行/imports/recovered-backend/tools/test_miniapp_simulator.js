"use strict";

const automator = require("/opt/homebrew/lib/node_modules/miniprogram-automator");

const CLI_PATH = process.env.WECHAT_DEVTOOLS_CLI ||
  "/Applications/wechatwebdevtools.app/Contents/MacOS/cli";
const PROJECT_PATH = process.env.UNSEEN_MINIAPP_PROJECT ||
  "/Users/max/Documents/ADVX/work/unseen-panorama-rebuild/miniapp";
const AUTOMATION_PORT = Math.max(
  1024,
  Number(process.env.WECHAT_AUTOMATION_PORT) || 9420
);
const runs = Math.max(1, Number(process.argv[2]) || 10);
const frames = Math.max(1, Math.min(28, Number(process.argv[3]) || 28));

function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

async function waitForResult(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await page.data();
    if (latest.testStatus === "passed" || latest.testStatus === "failed") {
      return latest;
    }
    await delay(250);
  }
  const error = new Error("小程序隐藏模拟器等待超时");
  error.latest = latest;
  throw error;
}

async function main() {
  let miniProgram = null;
  const exceptions = [];
  const results = [];
  try {
    miniProgram = await automator.launch({
      cliPath: CLI_PATH,
      projectPath: PROJECT_PATH,
      port: AUTOMATION_PORT,
      timeout: 60000,
      trustProject: true
    });
    miniProgram.on("exception", function (entry) {
      exceptions.push(entry);
    });
    miniProgram.on("console", function (entry) {
      if (entry && /(?:error|failed|exception)/i.test(String(entry.message || ""))) {
        exceptions.push(entry);
      }
    });

    for (let index = 1; index <= runs; index += 1) {
      const page = await miniProgram.reLaunch(
        "/pages/capture/capture?__pano_test=1&frames=" + frames + "&run=" + index
      );
      const data = await waitForResult(page, 60000);
      const result = {
        run: index,
        status: data.testStatus,
        frames: frames,
        coverage: data.testCoverage,
        viewerNonBlack: data.testViewerNonBlack,
        phase: data.phase,
        detail: data.processText
      };
      results.push(result);
      process.stdout.write(JSON.stringify(result) + "\n");
      if (data.testStatus !== "passed") {
        throw new Error("第 " + index + " 轮失败：" + String(data.processText || "未知原因"));
      }
      if (frames >= 28 && Number(data.testCoverage) < 0.99) {
        throw new Error("第 " + index + " 轮覆盖率不足：" + data.testCoverage);
      }
    }

    process.stdout.write(JSON.stringify({
      ok: true,
      passed: results.length,
      requested: runs,
      frames: frames,
      exceptions: exceptions.length
    }, null, 2) + "\n");
  } finally {
    if (miniProgram) await miniProgram.close();
  }
}

main().catch(function (error) {
  process.stderr.write(String(error && error.stack || error) + "\n");
  if (error && error.latest) {
    process.stderr.write(JSON.stringify(error.latest, null, 2) + "\n");
  }
  process.exitCode = 1;
});
