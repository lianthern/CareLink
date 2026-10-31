import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "../..");
const denyNetwork = path.join(repoRoot, "scripts/gates/deny-network.cjs");
const tests = [
  path.join(repoRoot, "imports/recovered-backend/backend/test/oss-v1.test.js"),
  path.join(repoRoot, "imports/recovered-backend/backend/test/service.test.js")
];

const childEnvironment = {
  PATH: process.env.PATH,
  TMPDIR: process.env.TMPDIR,
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  NO_PROXY: "*"
};

const result = spawnSync(
  process.execPath,
  ["--require", denyNetwork, "--test", "--test-reporter=spec", ...tests],
  {
    cwd: repoRoot,
    encoding: "utf8",
    env: Object.fromEntries(Object.entries(childEnvironment).filter(([, value]) => value !== undefined))
  }
);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
if (result.status !== 0) {
  throw new Error(`Fake OSS baseline failed with status ${result.status}`);
}
process.stdout.write(`${JSON.stringify({ status: "BACKEND_FAKE_OSS_BASELINE_OK", testFiles: 2, networkGuard: true })}\n`);

