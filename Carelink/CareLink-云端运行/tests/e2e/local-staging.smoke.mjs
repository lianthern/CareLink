import http from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const origin = String(process.env.UNSEEN_STAGING_ORIGIN ?? process.argv[2] ?? "http://127.0.0.1:4180").replace(/\/$/u, "");
const routes = [
  ["/__staging/", "supervisor"], ["/__staging/healthz", "supervisor"], ["/healthz", "core"], ["/", "core"],
  ["/__fixture", "book-fixture"], ["/__catalog", "book-fixture"],
  ["/labs/memories/photos/photo-01", "book-fixture"],
  ["/manage/space-adventurex-2026/book-lab", "book-fixture"],
  ["/s/space-adventurex-2026/books/book-adventurex-night/versions/book-version-02", "book-fixture"],
  ["/packages/book-lab-web/src/app.mjs", "book-fixture"]
];

const results = [];
for (const [route, surface] of routes) {
  const response = await fetch(`${origin}${route}`, { cache: "no-store" });
  const bytes = Buffer.byteLength(await response.text());
  if (!response.ok || response.headers.get("x-unseen-staging") !== "true" ||
    response.headers.get("x-unseen-staging-surface") !== surface || bytes === 0) {
    throw new Error(`local_staging_smoke_failed:${route}:${response.status}`);
  }
  results.push({ route, status: response.status, surface, bytes });
}

const fixture = await (await fetch(`${origin}/__fixture`)).json();
if (fixture.fixtureNotice !== "确定性本地样本 / 非真实 AI 问题质量" ||
  !/^[a-f0-9]{64}$/u.test(fixture.fixtureHash)) throw new Error("local_staging_fixture_invalid");
const meta = await (await fetch(`${origin}/__staging/meta`)).json();
if (meta.inputs.coreLocal !== "2cfb25f7da1cbdab901a1f731326c8dfaad6a765" ||
  meta.inputs.bookWeb !== "7d3590d3329252f4226adb2a751ffe9a2384d390" ||
  meta.externalExposure !== false || meta.cloudWrites !== 0) throw new Error("local_staging_meta_invalid");
const runtimeEvidenceRoot = path.resolve(process.env.UNSEEN_STAGING_RUNTIME_EVIDENCE_DIR ??
  path.join(homedir(), "Library/Application Support/UNSEEN/local-staging/runtime-evidence"));
const running = JSON.parse(await readFile(path.join(runtimeEvidenceRoot, "RUNNING.json"), "utf8"));
if (running.schema !== "unseen-local-staging-running/1" || running.origin !== origin ||
  !Number.isSafeInteger(running.pid) || running.pid <= 0) throw new Error("local_staging_running_marker_invalid");
try {
  process.kill(running.pid, 0);
} catch {
  throw new Error("local_staging_running_process_missing");
}
const url = new URL(origin);
const invalidHost = await new Promise((resolve, reject) => {
  const request = http.get({ hostname: url.hostname, port: url.port, path: "/__staging/meta",
    headers: { host: "invalid.example" } }, (response) => {
    response.resume();
    response.on("end", () => resolve(response.statusCode));
  });
  request.on("error", reject);
});
if (invalidHost !== 400) throw new Error(`local_staging_host_guard_failed:${invalidHost}`);

process.stdout.write(`${JSON.stringify({ schema: "unseen-local-staging-smoke/1", status: "PASS", origin,
  results, fixtureHash: fixture.fixtureHash, runningPid: running.pid,
  invalidHostStatus: invalidHost, cloudWrites: 0 }, null, 2)}\n`);
