import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "../..");
const roots = [
  "scripts",
  "packages/contracts",
  "provenance"
];
const explicitFiles = [
  ".gitignore",
  "README.md",
  "THIRD-PARTY-LICENSES.md",
  "package.json",
  "package-lock.json",
  "archive/c4-bootstrap/FREEZE-MANIFEST.json",
  "archive/c4-bootstrap/C4-PROGRESS.md",
  "archive/c4-bootstrap/C4-BLOCKED.md",
  "archive/c4-bootstrap/C4-EVIDENCE.md"
];

async function walk(relative) {
  const absolute = path.join(repoRoot, relative);
  const entries = await readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(child));
    } else if (entry.isFile()) {
      files.push(child);
    } else {
      throw new Error(`unsupported owned entry: ${child}`);
    }
  }
  return files;
}

const files = [...explicitFiles];
for (const root of roots) {
  files.push(...await walk(root));
}
let parsedJson = 0;
let syntaxChecked = 0;
for (const relative of [...new Set(files)].sort()) {
  const bytes = await readFile(path.join(repoRoot, relative));
  if (bytes.includes(13)) {
    throw new Error(`CR byte in owned file: ${relative}`);
  }
  const text = bytes.toString("utf8");
  if (text && !text.endsWith("\n")) {
    throw new Error(`missing final newline: ${relative}`);
  }
  if (text.split("\n").some((line) => /[ \t]+$/.test(line))) {
    throw new Error(`trailing whitespace: ${relative}`);
  }
  if (relative.endsWith(".json")) {
    JSON.parse(text);
    parsedJson += 1;
  }
  if (relative.endsWith(".mjs") || relative.endsWith(".cjs")) {
    const checked = spawnSync(process.execPath, ["--check", path.join(repoRoot, relative)], { encoding: "utf8" });
    if (checked.status !== 0) {
      process.stderr.write(checked.stderr);
      throw new Error(`Node syntax check failed: ${relative}`);
    }
    syntaxChecked += 1;
  }
}
process.stdout.write(`${JSON.stringify({ status: "FORMAT_OK", files: new Set(files).size, parsedJson, syntaxChecked })}\n`);

