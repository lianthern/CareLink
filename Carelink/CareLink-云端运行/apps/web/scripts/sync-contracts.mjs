import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const readJson = async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"));
const actionRegistry = await readJson("contracts/source/product-ui/ACTION-REGISTRY.json");
const strings = await readJson("contracts/source/product-ui/STRING-CATALOG.zh-CN.json");
const tokens = await readJson("contracts/source/product-ui/DESIGN-TOKENS.json");
const coverage = await readJson("contracts/source/technical/ACTION-API-COVERAGE.json");
const actionApi = Object.fromEntries(coverage.actions.map((item) => [item.actionId, {
  endpoint: item.endpoint,
  method: item.method,
  releaseLane: item.releaseLane,
  stableErrors: item.stableErrors
}]));
const target = resolve(here, "../src/generated/contracts.js");
await mkdir(dirname(target), { recursive: true });
await writeFile(target, [
  "// Generated from frozen contracts. Do not edit by hand.",
  `export const actionRegistry = ${JSON.stringify(actionRegistry, null, 2)};`,
  `export const strings = ${JSON.stringify(strings, null, 2)};`,
  `export const tokens = ${JSON.stringify(tokens, null, 2)};`,
  `export const actionApi = ${JSON.stringify(actionApi, null, 2)};`,
  ""
].join("\n"));
