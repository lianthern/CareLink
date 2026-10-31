import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const env = { ...process.env, UNSEEN_PROVIDER_KEYS_ENV_ONLY: "true" };
for (const key of Object.keys(env)) if (/^(MINIMAX_|WORLDLABS_|WLT_API_KEY$|MOMENT_)/u.test(key)) delete env[key];
const child = spawn(process.execPath, ["--test"], {
  cwd: fileURLToPath(new URL("../../apps/huijian/", import.meta.url)), env, stdio: "inherit"
});
child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
