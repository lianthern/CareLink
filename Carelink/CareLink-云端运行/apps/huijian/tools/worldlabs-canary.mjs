#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createWorldLabsClient } from "../lib/worldlabs-client.mjs";

function fail(message) {
  throw new Error(`worldlabs_canary_invalid:${message}`);
}

function parseArgs(argv) {
  const options = { mode: null, outputDir: null, displayName: null, prompt: null, images: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--mode") options.mode = argv[++index];
    else if (value === "--out") options.outputDir = path.resolve(argv[++index]);
    else if (value === "--name") options.displayName = argv[++index];
    else if (value === "--prompt") options.prompt = argv[++index];
    else if (value === "--image") options.images.push(path.resolve(argv[++index]));
    else fail(`unknown_argument:${value}`);
  }
  if (!["single", "multi"].includes(options.mode)) fail("mode");
  if (!options.outputDir || !options.displayName) fail("out_or_name");
  if (options.mode === "single" && options.images.length !== 1) fail("single_image_count");
  if (options.mode === "multi" && (options.images.length < 2 || options.images.length > 8)) fail("multi_image_count");
  return options;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function saveJson(filename, value) {
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function download(url, filename) {
  if (!url) return null;
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`asset_download_failed:${response.status}:${path.basename(filename)}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(filename, bytes, { mode: 0o600 });
  return { path: filename, bytes: bytes.length, sha256: sha256(bytes), contentType: response.headers.get("content-type") };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const apiKey = process.env.WORLDLABS_API_KEY;
  if (!apiKey) fail("api_key_missing");
  await mkdir(options.outputDir, { recursive: true, mode: 0o700 });

  const inputRecords = [];
  const imagesBase64 = [];
  for (const imagePath of options.images) {
    const bytes = await readFile(imagePath);
    imagesBase64.push(bytes.toString("base64"));
    inputRecords.push({ path: imagePath, bytes: bytes.length, sha256: sha256(bytes) });
  }

  const client = createWorldLabsClient({ apiKey });
  const startedAt = new Date().toISOString();
  const operation = options.mode === "multi"
    ? await client.generateMultiImageWorld({
        imagesBase64,
        textPrompt: options.prompt,
        displayName: options.displayName
      })
    : await client.generateImageWorld({
        imageBase64: imagesBase64[0],
        textPrompt: options.prompt,
        displayName: options.displayName
      });

  const receiptPath = path.join(options.outputDir, "receipt.json");
  const receipt = {
    schemaVersion: "huijian.worldlabs-canary/1",
    mode: options.mode,
    displayName: options.displayName,
    prompt: options.prompt,
    startedAt,
    completedAt: null,
    inputs: inputRecords,
    operation,
    downloads: {}
  };
  await saveJson(receiptPath, receipt);
  process.stdout.write(`${options.mode}: accepted operation ${operation.id}\n`);

  const deadline = Date.now() + 20 * 60_000;
  let current = operation;
  while (!current.done && Date.now() < deadline) {
    await pause(15_000);
    current = await client.getOperation(operation.id);
    receipt.operation = current;
    await saveJson(receiptPath, receipt);
    process.stdout.write(`${options.mode}: ${current.progress.status ?? "IN_PROGRESS"}` +
      `${current.progress.description ? ` — ${current.progress.description}` : ""}\n`);
  }
  if (!current.done) throw new Error("worldlabs_canary_timeout");
  if (current.error) throw new Error(`worldlabs_generation_failed:${current.error.code ?? "unknown"}:${current.error.message}`);
  if (!current.world) throw new Error("worldlabs_generation_missing_world");

  const downloads = {
    thumbnail: await download(current.world.thumbnailUrl, path.join(options.outputDir, "thumbnail.jpg")),
    panorama: await download(current.world.panoramaUrl, path.join(options.outputDir, "panorama.png")),
    collider: await download(current.world.colliderUrl, path.join(options.outputDir, "collider.glb")),
    splatPreview: await download(current.world.splats.preview, path.join(options.outputDir, "world-100k.spz")),
    splatStandard: await download(current.world.splats.standard, path.join(options.outputDir, "world-500k.spz"))
  };
  receipt.operation = current;
  receipt.completedAt = new Date().toISOString();
  receipt.downloads = downloads;
  await saveJson(receiptPath, receipt);
  process.stdout.write(`${options.mode}: completed world ${current.world.id}; receipt ${receiptPath}\n`);
}

await main();
