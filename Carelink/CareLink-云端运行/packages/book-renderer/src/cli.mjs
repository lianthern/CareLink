import { chmod, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildRenderReceipt, renderCanonicalHtml } from "./render.mjs";
import { printExactHtmlToPdf } from "./pdf.mjs";
import { fixtureBundle, fixtureHash, resolveFixtureAsset } from "../fixtures/frozen-book-fixture.mjs";

process.umask(0o077);

const configuredOutputDirectory = process.argv[2] ?? process.env.UNSEEN_BOOK_OUTPUT_DIR;
if (configuredOutputDirectory !== undefined && !configuredOutputDirectory.trim()) throw new Error("book_output_directory_invalid");
const outputDirectory = resolve(configuredOutputDirectory ?? "/tmp/unseen-book-preview");
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
await chmod(outputDirectory, 0o700);
const htmlPath = resolve(outputDirectory, "book.html");
const pdfPath = resolve(outputDirectory, "book.pdf");
const htmlResult = renderCanonicalHtml(fixtureBundle.manifest, resolveFixtureAsset, "fixture");
const pdf = await printExactHtmlToPdf({ html: htmlResult.html, htmlPath, pdfPath, orderedPageIds: htmlResult.equality.orderedPageIds, canonicalTimestamp: fixtureBundle.manifest.frozenAt });
const receipt = { ...buildRenderReceipt(fixtureBundle.manifest, htmlResult, pdf, "fixture"), fixtureHash };
const receiptPath = resolve(outputDirectory, "render-receipt.json");
await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
await chmod(receiptPath, 0o600);
console.log(JSON.stringify({ status: "BOOK_FIXTURE_RENDER_OK", outputDirectory, fixtureHash, ...receipt.html, pdf: receipt.pdf }, null, 2));
