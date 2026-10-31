#!/usr/bin/env node
// Isolated local release rehearsal. Never edits a service, reverse proxy, database or production path.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile, readdir, lstat, rename, symlink, readlink, unlink, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
const execute = promisify(execFile);
const MARKER = ".unseen-local-releases.json";
const MANIFEST = "release-manifest.json";
// Dependency lock is owned by the monorepo root; app snapshots need not contain a second lock.
const REQUIRED = ["server.mjs", "package.json", "public/index.html", "public/spatial-lab.html", "public/unseen-demo.html", "public/unseen-app.html", "public/app-v2.html"];
const ROUTES = ["/", "/index.html", "/unseen-demo", "/app", "/app-v2", "/app-v2.html"];
const allowedRoots = new Set(["server.mjs", "package.json", "package-lock.json", "lib", "public", "photos", "README.md"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function files(directory, prefix = "") {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error(`unsupported_release_entry:${name}`);
    if (entry.isDirectory()) found.push(...await files(join(directory, entry.name), name));
    else if (name !== MANIFEST) found.push(name);
  }
  return found.sort();
}
async function initializeRoot(root) {
  // Explicitly restricted to a temp directory or a project .task directory. This tool cannot be
  // repurposed into an accidental /opt switch while the coordinator is reviewing the candidate.
  const inTemporary = root.startsWith(`${resolve(tmpdir())}${sep}`) || root.startsWith(`/tmp/`);
  if (!inTemporary && !root.split(sep).includes(".task")) throw new Error("local_rehearsal_root_required");
  if (await exists(root)) {
    if ((await lstat(root)).isSymbolicLink()) throw new Error("release_root_must_not_be_symlink");
    if (!(await exists(join(root, MARKER))) && (await readdir(root)).length) throw new Error("refusing_unmanaged_nonempty_directory");
  }
  await mkdir(root, { recursive: true });
  if (!(await exists(join(root, MARKER)))) await writeFile(join(root, MARKER), '{"kind":"unseen-local-release-rehearsal","version":1}\n', { flag: "wx" });
  const marker = JSON.parse(await readFile(join(root, MARKER), "utf8"));
  if (marker.kind !== "unseen-local-release-rehearsal") throw new Error("release_root_marker_invalid");
  await mkdir(join(root, "releases"), { recursive: true });
}
async function locked(root, run) {
  await initializeRoot(root);
  const lock = join(root, ".release-lock");
  try { await mkdir(lock); } catch (error) { if (error.code === "EEXIST") throw new Error("release_rehearsal_already_running"); throw error; }
  try {
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await run();
  } finally { await rm(lock, { recursive: true, force: true }); }
}
async function target(root, name) {
  const path = join(root, name);
  if (!(await exists(path))) return null;
  if (!(await lstat(path)).isSymbolicLink()) throw new Error(`${name}_must_be_managed_symlink`);
  const value = await readlink(path);
  if (!/^releases\/[a-f0-9]{40}$/u.test(value)) throw new Error(`${name}_target_invalid`);
  return value;
}
async function switchLink(root, name, value) {
  if (!value) { await unlink(join(root, name)).catch((error) => { if (error.code !== "ENOENT") throw error; }); return; }
  const temporary = join(root, `.${name}-${randomUUID()}`);
  try { await symlink(value, temporary); await rename(temporary, join(root, name)); }
  finally { await unlink(temporary).catch(() => {}); }
}

export async function verifyCandidate(directory, expectedRevision) {
  const manifest = JSON.parse(await readFile(join(directory, MANIFEST), "utf8"));
  if (manifest.version !== 1 || !/^[a-f0-9]{40}$/u.test(manifest.revision) || (expectedRevision && manifest.revision !== expectedRevision)) throw new Error("release_revision_mismatch");
  const actualFiles = await files(directory);
  if (JSON.stringify(actualFiles) !== JSON.stringify(Object.keys(manifest.files).sort())) throw new Error("release_file_inventory_mismatch");
  for (const name of actualFiles) if (await digest(join(directory, name)) !== manifest.files[name]) throw new Error(`release_hash_mismatch:${name}`);
  for (const name of REQUIRED) if (!manifest.files[name]) throw new Error(`required_release_file_missing:${name}`);
  return manifest;
}
async function prepare({ source, revision, root }) {
  // git archive intentionally excludes every uncommitted source edit and local secret/state file.
  const sha = (await execute("git", ["-C", source, "rev-parse", "--verify", `${revision}^{commit}`])).stdout.trim();
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error("invalid_candidate_revision");
  const destination = join(root, "releases", sha);
  if (await exists(destination)) { await verifyCandidate(destination, sha); return { directory: destination, revision: sha }; }
  const tree = (await execute("git", ["-C", source, "ls-tree", "-r", "-z", sha], { maxBuffer: 16 * 1024 * 1024 })).stdout.split("\0").filter(Boolean);
  const paths = new Set();
  for (const item of tree) {
    const [metadata, name] = item.split("\t");
    if (!allowedRoots.has(name.split("/")[0])) continue;
    if (!/^(100644|100755) blob /u.test(metadata)) throw new Error(`unsupported_git_entry:${name}`);
    paths.add(name.split("/")[0]);
  }
  const staging = join(root, `.staging-${randomUUID()}`);
  const archive = `${staging}.tar`;
  await mkdir(staging);
  try {
    await execute("git", ["-C", source, "archive", "--format=tar", `--output=${archive}`, sha, "--", ...paths]);
    await execute("tar", ["-xf", archive, "-C", staging]);
    const hashes = {};
    for (const name of await files(staging)) hashes[name] = await digest(join(staging, name));
    const manifest = { version: 1, revision: sha, createdAt: new Date().toISOString(), files: hashes };
    await writeFile(join(staging, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { flush: true });
    await verifyCandidate(staging, sha);
    await rename(staging, destination);
    return { directory: destination, revision: sha };
  } finally {
    await rm(staging, { recursive: true, force: true });
    await unlink(archive).catch(() => {});
  }
}

export async function smokeCandidate(directory, revision, { timeoutMs = 8000 } = {}) {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const state = await mkdtemp(join(tmpdir(), "unseen-release-smoke-"));
  const child = spawn(process.execPath, [join(directory, "server.mjs")], {
    cwd: directory, stdio: ["ignore", "ignore", "pipe"],
    // Explicit fake keys and unreachable loopback endpoints prevent paid calls or secret-store reads.
    env: { PATH: process.env.PATH, PORT: String(port), BUILD_ID: revision, STATE_DIRECTORY: state,
      MINIMAX_API_KEY: "not-a-real-local-release-smoke", WORLDLABS_API_KEY: "not-a-real-local-release-smoke",
      MINIMAX_BASE_URL: "http://127.0.0.1:1", MINIMAX_TTS_BASE_URL: "http://127.0.0.1:1", WORLDLABS_BASE_URL: "http://127.0.0.1:1" }
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2048); });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  try {
    let health;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`candidate_process_exited:${child.exitCode}`);
      try { const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(500) }); if (response.ok) { health = await response.json(); break; } } catch { /* wait for listen */ }
      await sleep(25);
    }
    if (!health?.ok || health.buildId !== revision) throw new Error("candidate_health_or_build_id_failed");
    const routes = [];
    for (const path of ROUTES) {
      const response = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(1500) });
      if (!response.ok || !(await response.text()).trim()) throw new Error(`candidate_route_failed:${path}:${response.status}`);
      routes.push({ path, status: response.status });
    }
    // Check served bytes against the frozen manifest, not merely HTTP 200 or attractive HTML.
    const manifest = await verifyCandidate(directory, revision);
    const servedAssets = new Map([
      ["/unseen-demo.html", "public/unseen-demo.html"], ["/unseen-app.html", "public/unseen-app.html"],
      ["/app-v2.html", "public/app-v2.html"]
    ]);
    const assetName = pathname => {
      if (pathname.startsWith("/photos/")) return pathname.slice(1);
      if (pathname.startsWith("/")) return `public${pathname}`;
      return null;
    };
    for (const htmlPath of REQUIRED.filter((name) => name.endsWith(".html"))) {
      const html = await readFile(join(directory, htmlPath), "utf8");
      for (const match of html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)=["']([^"']+)["'][^>]*>/giu)) {
        const asset = new URL(match[1], `${url}/${htmlPath.slice(7)}`);
        if (asset.origin !== url) continue;
        const name = assetName(asset.pathname);
        if (!manifest.files[name]) throw new Error(`candidate_linked_asset_missing:${name}`);
        servedAssets.set(`${asset.pathname}${asset.search}`, name);
      }
    }
    // Follow same-origin JS/CSS references as well as HTML tags. This catches dynamically
    // imported split chunks (including a future family-frame chunk) instead of proving only
    // that the entry HTML and its first-level tags return 200.
    const pendingAssets = [...servedAssets];
    for (let index = 0; index < pendingAssets.length; index += 1) {
      const [assetPath, file] = pendingAssets[index];
      const response = await fetch(`${url}${assetPath}`, { signal: AbortSignal.timeout(1500) });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!response.ok || createHash("sha256").update(bytes).digest("hex") !== manifest.files[file]) throw new Error(`candidate_served_hash_failed:${file}`);
      if (/\.(?:js|mjs|css)$/iu.test(file)) {
        const text = bytes.toString("utf8");
        const references = /\.(?:js|mjs)$/iu.test(file)
          ? [...text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/giu)].map(match => match[1])
          : [...text.matchAll(/\burl\(\s*["']?([^"')]+)["']?\s*\)/giu)].map(match => match[1]);
        for (const reference of references) {
          // Template-generated URLs (for example `./chunks/${name}.js`) cannot be
          // resolved from static bytes; the concrete URL is still covered when it is
          // emitted as an HTML preload or an explicit static import.
          if (/\$\{|%7b/iu.test(reference)) continue;
          const linked = new URL(reference, `${url}${assetPath.split("?")[0]}`);
          if (linked.origin !== url) continue;
          const linkedName = assetName(linked.pathname);
          if (!linkedName) continue;
          if (!manifest.files[linkedName]) throw new Error(`candidate_split_asset_missing:${linkedName}`);
          const key = `${linked.pathname}${linked.search}`;
          if (!servedAssets.has(key)) { servedAssets.set(key, linkedName); pendingAssets.push([key, linkedName]); }
        }
      }
    }
    return { buildId: health.buildId, routes, servedHashesVerified: true, servedAssets: servedAssets.size };
  } catch (cause) {
    // Diagnostics contain only this local test process's startup output; no keys are inherited.
    throw Object.assign(new Error(cause.message, { cause }), { stderr });
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
    await rm(state, { recursive: true, force: true });
  }
}

export async function releaseCandidate({ source, revision = "HEAD", root, smoke = smokeCandidate }) {
  root = resolve(root); source = resolve(source);
  return locked(root, async () => {
    const before = await target(root, "current");
    const beforePrevious = await target(root, "previous");
    const candidate = await prepare({ source, revision, root });
    const candidateTarget = `releases/${candidate.revision}`;
    await verifyCandidate(candidate.directory, candidate.revision);
    if (before === candidateTarget) return { ...candidate, root, changed: false, smoke: await smoke(candidate.directory, candidate.revision) };
    // Pre-switch start/HTTP/build/asset checks leave current untouched on a bad candidate.
    await smoke(candidate.directory, candidate.revision);
    if (before) await switchLink(root, "previous", before);
    try {
      await switchLink(root, "current", candidateTarget);
      const result = await smoke(join(root, "current"), candidate.revision);
      const receipt = { ...candidate, root, changed: true, previous: before, smoke: result, verifiedAt: new Date().toISOString() };
      await writeFile(join(root, "last-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
      return receipt;
    } catch (error) {
      await switchLink(root, "current", before);
      await switchLink(root, "previous", beforePrevious);
      if (before) await smoke(join(root, "current"), before.split("/")[1]);
      throw Object.assign(new Error("candidate_activation_failed_restored", { cause: error }), { restored: before });
    }
  });
}

export async function rollbackCandidate({ root, smoke = smokeCandidate }) {
  root = resolve(root);
  return locked(root, async () => {
    const current = await target(root, "current");
    const previous = await target(root, "previous");
    if (!current || !previous) throw new Error("previous_release_required");
    await verifyCandidate(join(root, previous), previous.split("/")[1]);
    await smoke(join(root, previous), previous.split("/")[1]);
    await switchLink(root, "current", previous);
    try {
      const result = await smoke(join(root, "current"), previous.split("/")[1]);
      await switchLink(root, "previous", current);
      return { root, current: previous, previous: current, smoke: result };
    } catch (error) { await switchLink(root, "current", current); throw new Error("rollback_activation_failed_restored", { cause: error }); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const command = args.shift();
    const options = {};
    while (args.length) {
      const key = args.shift();
      if (!["--source", "--revision", "--root"].includes(key) || !args.length) throw new Error("usage: release-candidate.mjs stage|rollback --root <local .task or temporary directory> [--source repo --revision sha]");
      options[key.slice(2)] = args.shift();
    }
    if (!options.root || (command === "stage" && !options.source)) throw new Error("explicit_root_and_source_required");
    const result = command === "stage" ? await releaseCandidate(options) : command === "rollback" ? await rollbackCandidate(options) : (() => { throw new Error("stage_or_rollback_required"); })();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
