import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateOffline, prepareDataset, sha256 } from "../../services/locator/src/offline-pipeline.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const defaults = {
  manifest: "datasets/manifests/offline/synthetic-tooling-v0.json",
  predictions: "eval/offline/predictions.synthetic-tooling-v0.json",
  preregistration: "eval/offline/preregistration.v1.json",
  release: "services/locator/releases/synthetic-tooling-v0.json",
  out: null
};

function argumentsFrom(argv) {
  const result = { ...defaults };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, "");
    if (!(key in result) || argv[index + 1] === undefined) throw new Error("usage_invalid");
    result[key] = argv[index + 1];
  }
  return result;
}

async function readJson(relative) {
  const absolute = path.resolve(repoRoot, relative);
  const bytes = await readFile(absolute);
  return { value: JSON.parse(bytes), bytes };
}

export async function run(argv = process.argv.slice(2)) {
  const options = argumentsFrom(argv);
  const [manifest, predictions, preregistration, release, pipelineCode, workerCode] = await Promise.all([
    readJson(options.manifest),
    readJson(options.predictions),
    readJson(options.preregistration),
    readJson(options.release),
    readFile(path.join(repoRoot, "services/locator/src/offline-pipeline.mjs")),
    readFile(path.join(repoRoot, "services/locator/src/worker-contract.mjs"))
  ]);
  const prepared = prepareDataset(manifest.value, { manifestBytesSha256: sha256(manifest.bytes) });
  const report = evaluateOffline({
    prepared,
    predictionsDocument: predictions.value,
    preregistration: preregistration.value,
    releaseMetadata: release.value,
    hashes: {
      pipelineCodeSha256: sha256(pipelineCode),
      workerContractSha256: sha256(workerCode)
    }
  });
  if (options.out) {
    const output = path.resolve(repoRoot, options.out);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  process.stdout.write(`${JSON.stringify({ status: report.status, decision: report.decision,
    jointGatePassed: report.jointGatePassed, output: options.out })}\n`);
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: "EVAL_FAILED", code: error.code ?? error.message })}\n`);
    process.exitCode = 1;
  });
}
