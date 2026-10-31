import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "../..");
const checkedIn = path.join(repoRoot, "packages/contracts/generated");
const { generate } = await import("./generate.mjs");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function hashes(root, prefix = "") {
  const result = {};
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      Object.assign(result, await hashes(absolute, relative));
    } else if (entry.isFile()) {
      result[relative] = sha256(await readFile(absolute));
    } else {
      throw new Error(`unexpected generated entry: ${relative}`);
    }
  }
  return result;
}

export function compareGenerated(actual, expected) {
  if (Object.keys(expected).length !== 11 || Object.keys(actual).length !== 11) {
    throw new Error(`generated contract count drift: expected=${Object.keys(expected).length} actual=${Object.keys(actual).length}`);
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`generated contract drift: expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  }
  return { status: "CONTRACT_GENERATION_CLEAN", files: 11 };
}

export async function checkGenerated() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "unseen-contract-check-"));
  try {
    await generate(temporary);
    return compareGenerated(await hashes(checkedIn), await hashes(temporary));
  } finally {
    if (temporary.startsWith(`${os.tmpdir()}${path.sep}unseen-contract-check-`)) {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.stdout.write(`${JSON.stringify(await checkGenerated())}\n`);
}
