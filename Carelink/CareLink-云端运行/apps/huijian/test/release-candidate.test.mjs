import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readlink, writeFile, rm, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { releaseCandidate, rollbackCandidate, verifyCandidate, smokeCandidate } from "../deploy/release-candidate.mjs";
const execute = promisify(execFile);
const server = `import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
createServer(async(req,res)=>{
  if(req.url==='/api/health'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({ok:true,buildId:process.env.BUILD_ID}));}
  const files={'/':'index.html','/app':'unseen-app.html','/app-v2':'app-v2.html','/unseen-demo':'unseen-demo.html'};
  try{res.end(await readFile(new URL('./public/'+(files[req.url]||req.url.slice(1)),import.meta.url)));}
  catch{res.statusCode=404;res.end('missing');}
}).listen(Number(process.env.PORT),'127.0.0.1');`;
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "unseen-release-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "repo");
  const root = join(directory, "rehearsal");
  await mkdir(join(source, "public"), { recursive: true });
  await mkdir(join(source, "public", "app-assets"), { recursive: true });
  await execute("git", ["init", "-q", source]);
  await execute("git", ["-C", source, "config", "user.email", "local-test@example.invalid"]);
  await execute("git", ["-C", source, "config", "user.name", "Local Release Test"]);
  await writeFile(join(source, "server.mjs"), server);
  await writeFile(join(source, "package.json"), '{"type":"module"}');
  await writeFile(join(source, "package-lock.json"), '{"name":"fixture","lockfileVersion":3,"requires":true,"packages":{}}\n');
  for (const name of ["index", "spatial-lab", "unseen-demo", "unseen-app", "app-v2"]) await writeFile(join(source, "public", `${name}.html`), `<!doctype html><title>${name}</title>old`);
  await writeFile(join(source, "public", "app-v2.html"), '<!doctype html><script type="module" src="/app-assets/family-frame-entry.js"></script>');
  await writeFile(join(source, "public", "app-assets", "family-frame-entry.js"), 'import("./family-frame-split.js");');
  await writeFile(join(source, "public", "app-assets", "family-frame-split.js"), 'export const familyFrameSplit = true;');
  async function commit(message) {
    await execute("git", ["-C", source, "add", "."]);
    await execute("git", ["-C", source, "commit", "-qm", message]);
    return (await execute("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
  }
  return { source, root, commit, old: await commit("old release") };
}

test("exact committed release stages with hashes, real HTTP smoke, atomic current and previous rollback", async (t) => {
  const f = await fixture(t);
  const first = await releaseCandidate({ ...f, revision: f.old });
  assert.equal(first.smoke.servedHashesVerified, true);
  assert.equal(first.smoke.buildId, f.old);
  await writeFile(join(f.source, "public", "unseen-app.html"), "<!doctype html>new app");
  const next = await f.commit("new app");
  await writeFile(join(f.source, "public", "unseen-app.html"), "UNCOMMITTED MUST NOT DEPLOY");
  const second = await releaseCandidate({ ...f, revision: next });
  assert.equal(second.previous, `releases/${f.old}`);
  assert.equal(await readlink(join(f.root, "current")), `releases/${next}`);
  assert.equal(await readFile(join(second.directory, "public", "unseen-app.html"), "utf8"), "<!doctype html>new app");
  const rolledBack = await rollbackCandidate({ root: f.root });
  assert.equal(rolledBack.current, `releases/${f.old}`);
  assert.equal(await readlink(join(f.root, "previous")), `releases/${next}`);
  assert.deepEqual((await readdir(join(f.root, "releases"))).sort(), [f.old, next].sort());
});

test("post-switch failure restores exact previous current and previous links, then verifies restored HTTP", async (t) => {
  const f = await fixture(t);
  await releaseCandidate({ ...f, revision: f.old });
  await writeFile(join(f.source, "public", "unseen-app.html"), "<!doctype html>candidate");
  const revision = await f.commit("candidate");
  let injected = false;
  const smoke = async (directory, sha) => {
    if (directory.endsWith("/current") && sha === revision) { injected = true; throw new Error("local activation fault injection"); }
    return smokeCandidate(directory, sha);
  };
  await assert.rejects(releaseCandidate({ ...f, revision, smoke }), { message: "candidate_activation_failed_restored", restored: `releases/${f.old}` });
  assert.equal(injected, true);
  assert.equal(await readlink(join(f.root, "current")), `releases/${f.old}`);
  await assert.rejects(readlink(join(f.root, "previous")), { code: "ENOENT" });
  assert.equal((await smokeCandidate(join(f.root, "current"), f.old)).buildId, f.old);
});

test("tampered asset hash prevents rollback and leaves current untouched", async (t) => {
  const f = await fixture(t);
  const old = await releaseCandidate({ ...f, revision: f.old });
  await writeFile(join(f.source, "public", "unseen-app.html"), "<!doctype html>second");
  const revision = await f.commit("second");
  await releaseCandidate({ ...f, revision });
  await writeFile(join(old.directory, "public", "unseen-app.html"), "tampered");
  await assert.rejects(verifyCandidate(old.directory, f.old), /release_hash_mismatch/);
  await assert.rejects(rollbackCandidate({ root: f.root }), /release_hash_mismatch/);
  assert.equal(await readlink(join(f.root, "current")), `releases/${revision}`);
});

test("bad candidate process cannot replace a healthy release", async (t) => {
  const f = await fixture(t);
  await releaseCandidate({ ...f, revision: f.old });
  await writeFile(join(f.source, "server.mjs"), "process.exit(17);\n");
  const revision = await f.commit("intentionally broken process");
  await assert.rejects(releaseCandidate({ ...f, revision }), /candidate_process_exited:17/);
  assert.equal(await readlink(join(f.root, "current")), `releases/${f.old}`);
});

test("managed release tool refuses production paths, unmanaged data and tracked symlinks", async (t) => {
  const f = await fixture(t);
  await assert.rejects(releaseCandidate({ ...f, root: "/opt/huijian", revision: f.old }), /local_rehearsal_root_required/);
  await mkdir(f.root);
  await writeFile(join(f.root, "keep-user-file"), "untouched");
  await assert.rejects(releaseCandidate({ ...f, revision: f.old }), /refusing_unmanaged_nonempty_directory/);
  assert.equal(await readFile(join(f.root, "keep-user-file"), "utf8"), "untouched");
  await symlink("/etc/passwd", join(f.source, "public", "unsafe"));
  const revision = await f.commit("unsafe tracked symlink fixture");
  await assert.rejects(releaseCandidate({ ...f, root: join(f.root, "separate"), revision }), /unsupported_git_entry/);
});
