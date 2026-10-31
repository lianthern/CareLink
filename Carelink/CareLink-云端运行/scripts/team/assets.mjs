#!/usr/bin/env node
// Optional assets are pinned to a source commit and verified before becoming visible.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, link, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("../../", import.meta.url));
const manifest = JSON.parse(await readFile(resolve(root, "provenance/optional-assets.json"), "utf8"));
const [command = "list", module] = process.argv.slice(2);
if (!['list', 'fetch'].includes(command)) throw new Error("Usage: npm run assets -- list | fetch <module>");
const selected = manifest.assets.filter((asset) => !module || asset.module === module);
if (!selected.length) throw new Error(`Unknown asset module: ${module}`);
if (command === "list") {
  for (const name of [...new Set(selected.map((asset) => asset.module))]) {
    const assets = selected.filter((asset) => asset.module === name);
    console.log(`${name}: ${assets.length} files, ${(assets.reduce((sum, asset) => sum + asset.bytes, 0) / 1048576).toFixed(1)} MiB${assets.some((asset) => !asset.repository) ? ' (owner must supply local source files)' : ''}`);
  }
} else {
  if (!module) throw new Error("Choose one module, for example: npm run assets -- fetch spaces-gallery");
  async function verify(file, expected) {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.size !== expected.bytes) return false;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest("hex") === expected.sha256;
  }
  for (const asset of selected) {
    const destination = resolve(root, asset.path);
    if (!destination.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error("Asset path escapes repository");
    let existing = false;
    try { await access(destination); existing = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing) {
      if (!await verify(destination, asset)) throw new Error(`Existing file differs; preserve it and resolve manually: ${asset.path}`);
      console.log(`Verified: ${asset.path}`);
      continue;
    }
    if (!asset.repository) throw new Error(`Owner must supply ${asset.localSource}; match SHA256 ${asset.sha256}`);
    // Reject directory symlinks too: writing into another checkout is never intended.
    let parent = dirname(destination);
    while (parent !== resolve(root)) {
      try { if ((await lstat(parent)).isSymbolicLink()) throw new Error(`Symlink parent: ${parent}`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      parent = dirname(parent);
    }
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.download-${randomUUID()}`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      const encoded = asset.sourcePath.split('/').map(encodeURIComponent).join('/');
      const endpoint = `repos/${asset.repository}/contents/${encoded}?ref=${asset.commit}`;
      // The Contents API supplies a short-lived URL for private assets. Keep it out of logs.
      let downloadUrl;
      try {
        const { stdout } = await promisify(execFile)("gh", ["api", "--hostname", "github.com", endpoint, "--jq", ".download_url"], { maxBuffer: 1048576 });
        downloadUrl = new URL(stdout.trim());
      } catch { throw new Error(`Cannot resolve ${asset.path}; sign into GitHub CLI and check source-repository access`); }
      if (downloadUrl.origin !== "https://raw.githubusercontent.com" || downloadUrl.username || downloadUrl.password) throw new Error("Unexpected GitHub download host");
      const response = await fetch(downloadUrl, { signal: AbortSignal.timeout(120000), redirect: "error" });
      if (!response.ok) throw new Error(`Asset HTTP ${response.status}: ${asset.path}`);
      let received = 0;
      for await (const chunk of response.body) {
        received += chunk.length;
        if (received > asset.bytes) throw new Error(`Asset exceeds pinned size: ${asset.path}`);
        await handle.writeFile(chunk);
      }
      await handle.close();
      if (!await verify(temporary, asset)) throw new Error(`Asset checksum or size mismatch: ${asset.path}`);
      // Do not overwrite a file another process supplied while the download ran.
      try { await access(destination); throw new Error(`Destination appeared during download: ${asset.path}`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await link(temporary, destination);
      console.log(`Downloaded and verified: ${asset.path}`);
    } finally {
      await handle.close().catch(() => {});
      await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}
