// Spawned as an isolated child process by remote-pull.test.mjs to prove runPullLoop's idle-sleep timer keeps
// the event loop alive across real sleeps when the caller does not supply its own `sleep` option — the exact
// branch mac-codex-private-worker/daemon.mjs (and any other bare caller of runPullLoop) exercises in
// production. This process deliberately has NO other ref'd handle: no HTTP server, no injected `sleep`, no
// extra timer of its own. If the idle setTimeout in remote-pull.mjs were ever unref'd again, Node would see an
// empty event loop the instant that timer is created and exit near-instantly with code 0 — before this script
// ever gets to print a second "lease" line. That silent, near-0ms exit is exactly the production incident this
// guards against (2026-08-17, minimax-private-worker/worker.mjs's sleepUntilStop() had the same bug).
import { PrivateAiPullProtocol, PRIVATE_AI_PROTOCOL, RemotePrivateAiPullWorker, runPullLoop } from
  "../../../infra/integration/mac-codex-private-worker/remote-pull.mjs";

const HASH = "a".repeat(64);
let leaseCalls = 0;

const client = {
  async request(requestPath) {
    if (requestPath !== "/__internal/private-ai/v1/jobs/lease") throw new Error(`unexpected path ${requestPath}`);
    leaseCalls += 1;
    process.stdout.write(`lease ${leaseCalls} at ${Date.now()}\n`);
    // Exiting here (inside a call the loop only reaches AFTER a real idle sleep resolved) rather than via an
    // abort signal keeps this process free of any competing ref'd handle for the whole run.
    if (leaseCalls >= 3) process.exit(0);
    const body = JSON.stringify({ schema: "unseen-private-ai-lease-response/1", job: null, retryAfterMs: 1_000 });
    return {
      headers: { "x-unseen-protocol": PRIVATE_AI_PROTOCOL, "cache-control": "no-store, private",
        "content-type": "application/json" },
      bytes: Buffer.from(body, "utf8")
    };
  },
  async requestJson() { throw new Error("requestJson should not be called by the idle-lease path"); }
};

const protocol = new PrivateAiPullProtocol({ client, promptHash: HASH, policyHash: HASH, model: "idle-timer-probe",
  modelVersion: "idle-timer-probe/1" });
const worker = new RemotePrivateAiPullWorker({ protocol, preflight: async () => {}, analyze: async () => {
  throw new Error("analyze should not be called on an idle (job-less) lease");
}, minimumLeaseRemainingMs: 10_000, cleanupBudgetMs: 1_000 });

// No `sleep` option: this is the branch under test (raw setTimeout, previously unref'd). No `signal` either —
// default AbortController is never aborted, so the only thing that can end this process is the exit above.
await runPullLoop(worker, { random: () => 0 });
// Unreachable in the success case (the loop only ends via process.exit above); if we ever get here it means
// runPullLoop returned on its own, which is itself a bug worth surfacing loudly.
process.stdout.write("runPullLoop returned without an abort — unexpected\n");
process.exit(1);
