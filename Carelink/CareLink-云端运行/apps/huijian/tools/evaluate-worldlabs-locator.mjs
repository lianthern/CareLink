#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function fail(message) {
  throw new Error(`worldlabs_locator_eval_invalid:${message}`);
}

function parseNamedPath(value, kind) {
  const separator = value.indexOf(":");
  if (separator < 1) fail(`${kind}_format`);
  return { label: value.slice(0, separator), path: path.resolve(value.slice(separator + 1)) };
}

function parseArgs(argv) {
  const options = {
    unseenRoot: "/Users/max/code/unseen",
    sidecarUrl: "http://127.0.0.1:8791",
    outputPath: null,
    panoramas: [],
    queries: []
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--unseen-root") options.unseenRoot = path.resolve(argv[++index]);
    else if (value === "--sidecar-url") options.sidecarUrl = argv[++index];
    else if (value === "--out") options.outputPath = path.resolve(argv[++index]);
    else if (value === "--pano") options.panoramas.push(parseNamedPath(argv[++index], "pano"));
    else if (value === "--input") options.queries.push({ ...parseNamedPath(argv[++index], "input"), role: "input" });
    else if (value === "--holdout") options.queries.push({ ...parseNamedPath(argv[++index], "holdout"), role: "holdout" });
    else fail(`unknown_argument:${value}`);
  }
  if (!options.outputPath || options.panoramas.length === 0 || options.queries.length === 0) fail("required_arguments");
  return options;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const round = (value) => Number(value.toFixed(6));

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const locatorRoot = path.join(options.unseenRoot, "services/locator");
  const { ClipSidecarClient } = await import(pathToFileURL(path.join(locatorRoot, "src/clip-sidecar-client.mjs")));
  const { matchAgainstBank } = await import(pathToFileURL(path.join(locatorRoot, "src/match.mjs")));
  const client = new ClipSidecarClient({ baseUrl: options.sidecarUrl, timeoutMs: 300_000 });
  const health = await client.healthz();
  if (health.modelId !== "clip-ViT-B-32") fail(`unexpected_model:${health.modelId}`);

  const projection = {
    yaws: Array.from({ length: 12 }, (_, index) => index * 30),
    fov: 70,
    pitch: 0,
    cropWidth: 800,
    cropHeight: 600
  };
  const panoRecords = [];
  const banks = new Map();
  for (const panorama of options.panoramas) {
    const bytes = await readFile(panorama.path);
    process.stderr.write(`embed panorama ${panorama.label}\n`);
    banks.set(panorama.label, await client.embedPanoCrops(bytes, projection));
    panoRecords.push({ ...panorama, bytes: bytes.length, sha256: sha256(bytes) });
  }

  const results = [];
  for (const query of options.queries) {
    const bytes = await readFile(query.path);
    process.stderr.write(`embed query ${query.label}\n`);
    const { embedding } = await client.embedPhoto(bytes);
    const matches = options.panoramas.map((panorama) => {
      const match = matchAgainstBank(embedding, banks.get(panorama.label));
      return {
        world: panorama.label,
        yaw: match.yaw,
        confidence: round(match.confidence),
        margin: round(match.margin),
        candidates: match.candidates.map((candidate) => ({
          yaw: candidate.yaw,
          confidence: round(candidate.confidence)
        }))
      };
    });
    results.push({
      label: query.label,
      role: query.role,
      path: query.path,
      bytes: bytes.length,
      sha256: sha256(bytes),
      matches
    });
  }

  const report = {
    schemaVersion: "huijian.worldlabs-locator-eval/1",
    createdAt: new Date().toISOString(),
    interpretation: "diagnostic_candidate_direction_only",
    releaseEligible: false,
    autoConfirmPolicy: "blocked_fail_closed",
    model: { id: health.modelId, device: health.device, projection },
    panoramas: panoRecords,
    queries: results
  };
  await mkdir(path.dirname(options.outputPath), { recursive: true, mode: 0o700 });
  await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    status: "COMPLETE",
    output: options.outputPath,
    model: report.model,
    queryCount: results.length,
    results: results.map(({ label, role, matches }) => ({ label, role, matches }))
  }, null, 2)}\n`);
}

await main();
