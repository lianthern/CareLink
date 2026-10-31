import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { chmod, readFile, mkdir, stat } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureBundle, fixtureHash, freezeFixtureDraft, resolveFixtureAsset } from "../../book-renderer/fixtures/frozen-book-fixture.mjs";
import { buildRenderReceipt, renderCanonicalHtml } from "../../book-renderer/src/render.mjs";
import { printExactHtmlToPdf } from "../../book-renderer/src/pdf.mjs";

process.umask(0o077);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const appHtml = resolve(repoRoot, "packages/book-lab-web/index.html");
const catalogPath = resolve(repoRoot, "packages/contracts/generated/book-lab/string-catalog.zh-CN.json");
const configuredOutputRoot = process.env.UNSEEN_BOOK_OUTPUT_DIR;
if (configuredOutputRoot !== undefined && !configuredOutputRoot.trim()) throw new Error("book_output_directory_invalid");
const outputRoot = resolve(configuredOutputRoot ?? "/tmp/unseen-book-lab-web-preview");
const port = Number(process.env.UNSEEN_BOOK_LAB_PORT ?? 4328);
const artifactPromises = new Map();
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error("book_commit_invalid");
await mkdir(outputRoot, { recursive: true, mode: 0o700 });
await chmod(outputRoot, 0o700);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf"
};

function send(response, status, type, body, headers = {}) {
  response.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...headers
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 1_000_000) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function artifactUrls(manifestHash) {
  const root = `/__artifacts/${manifestHash}`;
  return { html: `${root}/book.html`, pdf: `${root}/book.pdf`, receipt: `${root}/render-receipt.json` };
}

function renderArtifacts(manifest) {
  if (!artifactPromises.has(manifest.manifestHash)) artifactPromises.set(manifest.manifestHash, (async () => {
    const directory = resolve(outputRoot, manifest.manifestHash);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const htmlPath = resolve(directory, "book.html");
    const pdfPath = resolve(directory, "book.pdf");
    const htmlResult = renderCanonicalHtml(manifest, resolveFixtureAsset, "fixture");
    const pdf = await printExactHtmlToPdf({ html: htmlResult.html, htmlPath, pdfPath, orderedPageIds: htmlResult.equality.orderedPageIds, canonicalTimestamp: manifest.frozenAt });
    const receipt = { ...buildRenderReceipt(manifest, htmlResult, pdf, "fixture"), fixtureBaselineHash: fixtureHash };
    return { htmlPath, pdfPath, receipt };
  })());
  return artifactPromises.get(manifest.manifestHash);
}

async function sendArtifact(response, manifestHash, filename) {
  let pending = artifactPromises.get(manifestHash);
  if (!pending && manifestHash === fixtureBundle.manifest.manifestHash) pending = renderArtifacts(fixtureBundle.manifest);
  if (!pending) return send(response, 404, "text/plain; charset=utf-8", "not found");
  const artifacts = await pending;
  if (filename === "book.html") return send(response, 200, mime[".html"], await readFile(artifacts.htmlPath), { "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'" });
  if (filename === "book.pdf") return send(response, 200, mime[".pdf"], await readFile(artifacts.pdfPath), { "Content-Disposition": `attachment; filename=unseen-book-${manifestHash.slice(0, 12)}.pdf` });
  if (filename === "render-receipt.json") return send(response, 200, mime[".json"], JSON.stringify(artifacts.receipt, null, 2));
  return send(response, 404, "text/plain; charset=utf-8", "not found");
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host ?? "127.0.0.1"}`);
    if (request.method === "GET" && url.pathname === "/healthz") return send(response, 200, mime[".json"], JSON.stringify({
      schema: "unseen-book-lab-health/1",
      status: "ok",
      ready: true,
      fixtureOnly: true,
      commit,
      input: { fixtureHash, manifestHash: fixtureBundle.manifest.manifestHash }
    }));
    if (url.pathname === "/__fixture") return send(response, 200, mime[".json"], JSON.stringify({ ...fixtureBundle, fixtureHash }));
    if (url.pathname === "/__catalog") return send(response, 200, mime[".json"], await readFile(catalogPath));
    if (request.method === "POST" && url.pathname === "/__artifacts/render") {
      const manifest = freezeFixtureDraft(await readJson(request));
      const artifacts = await renderArtifacts(manifest);
      return send(response, 200, mime[".json"], JSON.stringify({ manifest, receipt: artifacts.receipt, urls: artifactUrls(manifest.manifestHash) }));
    }
    const artifact = url.pathname.match(/^\/__artifacts\/([a-f0-9]{64})\/(book\.html|book\.pdf|render-receipt\.json)$/u);
    if (artifact) return sendArtifact(response, artifact[1], artifact[2]);
    if (url.pathname === "/__artifacts/book.html") return sendArtifact(response, fixtureBundle.manifest.manifestHash, "book.html");
    if (url.pathname === "/__artifacts/book.pdf") return sendArtifact(response, fixtureBundle.manifest.manifestHash, "book.pdf");
    if (url.pathname === "/__artifacts/render-receipt.json") return sendArtifact(response, fixtureBundle.manifest.manifestHash, "render-receipt.json");
    if (url.pathname.startsWith("/packages/book-lab-web/")) {
      const candidate = resolve(repoRoot, `.${url.pathname}`);
      if (!candidate.startsWith(`${resolve(repoRoot, "packages/book-lab-web")}${sep}`)) return send(response, 403, "text/plain; charset=utf-8", "forbidden");
      await stat(candidate);
      return send(response, 200, mime[extname(candidate)] ?? "application/octet-stream", await readFile(candidate));
    }
    return send(response, 200, mime[".html"], await readFile(appHtml), {
      "Content-Security-Policy": "default-src 'self'; img-src data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"
    });
  } catch (error) {
    send(response, 500, "text/plain; charset=utf-8", `local fixture error: ${error.message}`);
  }
});

server.listen(port, "127.0.0.1", () => console.log(`BOOK_LAB_FIXTURE_READY http://127.0.0.1:${port}/labs/memories/photos/photo-01`));
