import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BookLabIntegratedController } from "../src/integrated-controller.mjs";
import {
  ACTION_REQUESTS,
  BookLabIntegratedTransport,
  BookLabTransportError,
  fillEndpoint
} from "../src/integrated-transport.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const coverageDocument = JSON.parse(await readFile(resolve(repoRoot, "packages/contracts/generated/book-lab/action-api-coverage.json"), "utf8"));
const coverage = coverageDocument.actions;
const parameters = Object.freeze({
  photoId: "photo 01",
  memoryId: "memory-01",
  personalMemoryId: "memory-01",
  bookId: "book-01",
  spaceId: "space-01",
  versionId: "version-01",
  pageId: "page-01"
});
const PRECONDITIONS = Object.freeze({
  "MEMORY.START_QUESTION": "exclusive_either",
  "MEMORY.SKIP": "exclusive_either",
  "MEMORY.SAVE_ANSWER_DRAFT": "if-match",
  "MEMORY.REQUEST_FOLLOWUP": "if-match",
  "MEMORY.CONFIRM": "if-match",
  "MEMORY.WITHDRAW": "if-match",
  "BOOK_MEMORY.AUTHORIZE": "both",
  "BOOK_MEMORY.WITHDRAW": "if-match",
  "BOOK.CREATE": "if-none-match",
  "BOOK.GENERATE_PREVIEW": "both",
  "BOOK.EDIT_TITLE": "if-match",
  "BOOK.REMOVE_PAGE": "if-match",
  "BOOK.REPLACE_PAGE_PHOTO": "if-match",
  "BOOK.FREEZE": "if-match",
  "BOOK.START_NEW_VERSION": "both"
});
const PDF_BYTES = Buffer.from("%PDF-1.7\nmock-pdf\n");

async function bodyBytes(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function withServer(handler, run) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

function assertTransportError(code) {
  return (error) => error instanceof BookLabTransportError && error.code === code;
}

test("the request table is the byte-addressable shape of all 20 frozen actions", () => {
  assert.equal(Object.keys(ACTION_REQUESTS).length, 20);
  assert.deepEqual(Object.keys(ACTION_REQUESTS).sort(), coverage.map(({ actionId }) => actionId).sort());
  for (const item of coverage) {
    assert.equal(ACTION_REQUESTS[item.actionId].method, item.method);
    assert.equal(ACTION_REQUESTS[item.actionId].endpoint, item.endpoint);
    assert.equal(ACTION_REQUESTS[item.actionId].precondition, item.method === "GET" ? "none" : PRECONDITIONS[item.actionId]);
  }
  assert.deepEqual(Object.keys(PRECONDITIONS).sort(), coverage.filter(({ method }) => method !== "GET").map(({ actionId }) => actionId).sort());
  assert.deepEqual([...new Set(Object.values(ACTION_REQUESTS).map(({ method }) => method))].sort(), ["GET", "PATCH", "POST", "PUT"]);
});

test("local HTTP mock receives exact methods, canonical paths, JSON bytes, conditionals, and same-origin fetch policy", async () => {
  const received = [];
  await withServer(async (request, response) => {
    const bytes = await bodyBytes(request);
    received.push({ method: request.method, url: request.url, headers: request.headers, bytes });
    const index = received.length;
    response.statusCode = 200;
    response.setHeader("ETag", `\"response-${index}\"`);
    response.setHeader("X-Unseen-Trace-Id", `trace-${index}`);
    response.setHeader("X-Not-Unseen", "ignored");
    if (request.url.endsWith("/pdf")) {
      response.setHeader("Content-Type", "application/pdf");
      response.setHeader("Content-Disposition", "attachment; filename=unseen-book-version-01.pdf");
      response.setHeader("Content-Length", String(PDF_BYTES.length));
      response.end(PDF_BYTES);
    } else {
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ index }));
    }
  }, async (origin) => {
    const fetchCalls = [];
    const transport = new BookLabIntegratedTransport({
      origin,
      fetchImpl(url, init) {
        fetchCalls.push({ url, init });
        return fetch(url, init);
      }
    });
    const controller = new BookLabIntegratedController({ transport });
    const actionIds = coverage.map(({ actionId }) => actionId);
    const results = [];
    for (const [index, actionId] of actionIds.entries()) {
      const request = ACTION_REQUESTS[actionId];
      const precondition = PRECONDITIONS[actionId];
      results.push(request.mutation
        ? await controller.mutate(actionId, {
            parameters,
            dto: { actionId, ordinal: index + 1 },
            idempotencyKey: `idem-${index + 1}`,
            etag: ["if-match", "exclusive_either", "both"].includes(precondition) ? `\"etag-${index + 1}\"` : undefined,
            ifNoneMatch: ["if-none-match", "both"].includes(precondition) ? "*" : undefined
          })
        : await controller.readAction(actionId, { parameters }));
    }

    assert.equal(received.length, 20);
    assert.equal(fetchCalls.length, 20);
    for (const [index, item] of coverage.entries()) {
      const request = received[index];
      const policy = fetchCalls[index].init;
      const expectedPath = fillEndpoint(item.endpoint, parameters);
      assert.equal(request.method, item.method);
      assert.equal(request.url, expectedPath);
      assert.equal(fetchCalls[index].url, `${origin}${expectedPath}`);
      assert.equal(policy.credentials, "same-origin");
      assert.equal(policy.redirect, "error");
      assert.equal(request.headers.accept, item.actionId === "BOOK.DOWNLOAD_PDF" ? "application/pdf" : "application/json");
      assert.equal(results[index].status, 200);
      assert.equal(results[index].etag, `\"response-${index + 1}\"`);
      assert.deepEqual(results[index].unseenHeaders, { "x-unseen-trace-id": `trace-${index + 1}` });
      if (item.method === "GET") {
        assert.equal(request.bytes.length, 0);
        assert.equal(request.headers["content-type"], undefined);
        assert.equal(request.headers["idempotency-key"], undefined);
      } else {
        assert.equal(request.headers["content-type"], "application/json");
        assert.equal(request.headers["idempotency-key"], `idem-${index + 1}`);
        assert.deepEqual(request.bytes, Buffer.from(JSON.stringify({ actionId: item.actionId, ordinal: index + 1 })));
        const precondition = PRECONDITIONS[item.actionId];
        assert.equal(request.headers["if-match"], ["if-match", "exclusive_either", "both"].includes(precondition) ? `\"etag-${index + 1}\"` : undefined);
        assert.equal(request.headers["if-none-match"], ["if-none-match", "both"].includes(precondition) ? "*" : undefined);
      }
    }
    const pdf = results[actionIds.indexOf("BOOK.DOWNLOAD_PDF")].body;
    assert.ok(pdf instanceof Uint8Array);
    assert.deepEqual(Buffer.from(pdf), PDF_BYTES);
    assert.equal(results[actionIds.indexOf("BOOK.DOWNLOAD_PDF")].contentDisposition, "attachment; filename=unseen-book-version-01.pdf");
    assert.equal(results[actionIds.indexOf("BOOK.DOWNLOAD_PDF")].contentLength, PDF_BYTES.length);
  });
});

test("HTTP error DTOs retain status, body, ETag, and x-unseen response headers", async () => {
  await withServer((_request, response) => {
    response.statusCode = 409;
    response.setHeader("Content-Type", "application/json");
    response.setHeader("ETag", "\"current-7\"");
    response.setHeader("X-Unseen-Error-Class", "version-conflict");
    response.end(JSON.stringify({ error: { code: "version_conflict" } }));
  }, async (origin) => {
    const transport = new BookLabIntegratedTransport({ origin });
    const result = await transport.requestAction("MEMORY.OPEN", { parameters: { photoId: "photo-error" } });
    assert.deepEqual(result, {
      ok: false,
      status: 409,
      body: { error: { code: "version_conflict" } },
      etag: "\"current-7\"",
      unseenHeaders: { "x-unseen-error-class": "version-conflict" }
    });
  });
});

test("policy rejects unknown/mismatched/query routes and incomplete mutations before fetch", async () => {
  const calls = [];
  const transport = new BookLabIntegratedTransport({
    origin: "https://book.test",
    fetchImpl(...args) {
      calls.push(args);
      throw new Error("must not fetch");
    }
  });
  await assert.rejects(transport.request({ method: "DELETE", path: "/v2-labs/memories/m-1" }), assertTransportError("method_not_allowed"));
  await assert.rejects(transport.request({ method: "GET", path: "/__fixture" }), assertTransportError("unknown_route"));
  await assert.rejects(transport.request({ method: "POST", path: "/__artifacts/render", body: {} }), assertTransportError("unknown_route"));
  await assert.rejects(transport.request({ method: "GET", path: "/v2-labs/memories/m-1?token=secret" }), assertTransportError("unknown_route"));
  await assert.rejects(transport.request({ method: "GET", path: "/v2-labs/memories/.." }), assertTransportError("cross_origin_request"));
  await assert.rejects(transport.request({ method: "POST", path: "/v2-labs/memories/m-1/confirmations", body: {}, ifMatch: "\"1\"" }), assertTransportError("invalid_header"));
  await assert.rejects(transport.request({ method: "POST", path: "/v2-labs/memories/m-1/confirmations", body: {}, idempotencyKey: "key" }), assertTransportError("invalid_precondition_shape"));
  await assert.rejects(transport.request({ method: "GET", path: "/v2-labs/memories/m-1", body: {} }), assertTransportError("read_has_mutation_fields"));
  await assert.rejects(transport.requestAction("NOT.AN.ACTION"), assertTransportError("unknown_action"));
  const credentialedOrigin = ["https://user", "secret@book.test"].join(":");
  assert.throws(() => new BookLabIntegratedTransport({ origin: credentialedOrigin }), assertTransportError("invalid_origin"));
  assert.throws(() => new BookLabIntegratedTransport({ origin: "https://book.test/?token=secret" }), assertTransportError("invalid_origin"));
  assert.equal(calls.length, 0);
});

test("every action rejects the wrong conditional shape before fetch", async () => {
  const calls = [];
  const transport = new BookLabIntegratedTransport({
    origin: "https://book.test",
    fetchImpl(...args) {
      calls.push(args);
      throw new Error("must not fetch");
    }
  });
  const wrongShapes = Object.freeze({
    "if-match": [
      {},
      { ifNoneMatch: "*" },
      { ifMatch: "\"etag\"", ifNoneMatch: "*" }
    ],
    "if-none-match": [
      {},
      { ifMatch: "\"etag\"" },
      { ifMatch: "\"etag\"", ifNoneMatch: "*" },
      { ifNoneMatch: "\"not-star\"" }
    ],
    exclusive_either: [
      {},
      { ifMatch: "\"etag\"", ifNoneMatch: "*" },
      { ifNoneMatch: "\"not-star\"" }
    ],
    both: [
      {},
      { ifMatch: "\"etag\"" },
      { ifNoneMatch: "*" },
      { ifMatch: "\"etag\"", ifNoneMatch: "\"not-star\"" }
    ]
  });
  for (const [actionId, request] of Object.entries(ACTION_REQUESTS)) {
    if (!request.mutation) {
      await assert.rejects(transport.requestAction(actionId, { parameters, ifMatch: "\"etag\"" }), assertTransportError("read_has_mutation_fields"));
      continue;
    }
    for (const shape of wrongShapes[request.precondition]) {
      await assert.rejects(transport.requestAction(actionId, {
        parameters,
        body: {},
        idempotencyKey: `wrong-${actionId}`,
        ...shape
      }), assertTransportError("invalid_precondition_shape"));
    }
  }
  assert.equal(calls.length, 0);
});

test("start and skip accept both exclusive interview branches", async () => {
  const calls = [];
  const transport = new BookLabIntegratedTransport({
    origin: "https://book.test",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const response = new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      Object.defineProperty(response, "url", { value: url });
      return response;
    }
  });
  for (const actionId of ["MEMORY.START_QUESTION", "MEMORY.SKIP"]) {
    await transport.requestAction(actionId, { parameters, body: {}, idempotencyKey: `${actionId}-absent`, ifNoneMatch: "*" });
    await transport.requestAction(actionId, { parameters, body: {}, idempotencyKey: `${actionId}-present`, ifMatch: "\"interview-etag\"" });
  }
  assert.equal(calls.length, 4);
  for (const [index, { init }] of calls.entries()) {
    assert.equal(init.headers.get("If-Match"), index % 2 === 1 ? "\"interview-etag\"" : null);
    assert.equal(init.headers.get("If-None-Match"), index % 2 === 0 ? "*" : null);
  }
});

test("a browser runtime origin cannot be overridden by an injected cross-origin base", () => {
  const priorLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "https://book.test" } });
  try {
    for (const origin of ["https://other.test", "http://book.test", "https://book.test:444"]) {
      assert.throws(() => new BookLabIntegratedTransport({ origin }), assertTransportError("cross_origin_request"));
    }
    const credentialedOrigin = ["https://user", "secret@book.test"].join(":");
    assert.throws(() => new BookLabIntegratedTransport({ origin: credentialedOrigin }), assertTransportError("invalid_origin"));
    assert.doesNotThrow(() => new BookLabIntegratedTransport({ origin: "https://book.test", fetchImpl: async () => {} }));
  } finally {
    if (priorLocation) Object.defineProperty(globalThis, "location", priorLocation);
    else delete globalThis.location;
  }
});

test("redirects, cross-origin responses, invalid JSON/PDF, and unexpected content types fail closed", async () => {
  await withServer((request, response) => {
    if (request.url.includes("redirect")) {
      response.statusCode = 302;
      response.setHeader("Location", "/v2-labs/memories/photos/final");
      response.end();
      return;
    }
    if (request.url.includes("plain")) {
      response.setHeader("Content-Type", "text/plain");
      response.end("not json");
      return;
    }
    if (request.url.includes("bad-json")) {
      response.setHeader("Content-Type", "application/json");
      response.end("{");
      return;
    }
    response.setHeader("Content-Type", "application/pdf");
    response.end("not-a-pdf");
  }, async (origin) => {
    const transport = new BookLabIntegratedTransport({ origin });
    await assert.rejects(transport.requestAction("MEMORY.OPEN", { parameters: { photoId: "redirect" } }), assertTransportError("fetch_failed"));
    await assert.rejects(transport.requestAction("MEMORY.OPEN", { parameters: { photoId: "plain" } }), assertTransportError("unexpected_content_type"));
    await assert.rejects(transport.requestAction("MEMORY.OPEN", { parameters: { photoId: "bad-json" } }), assertTransportError("invalid_json_response"));
    await assert.rejects(transport.requestAction("BOOK.DOWNLOAD_PDF", { parameters }), assertTransportError("invalid_pdf_response"));

    const crossOrigin = new BookLabIntegratedTransport({ origin, fetchImpl: () => fetch("data:application/json,%7B%7D") });
    await assert.rejects(crossOrigin.requestAction("MEMORY.OPEN", { parameters: { photoId: "cross" } }), assertTransportError("cross_origin_response"));
    const missingFinalUrl = new BookLabIntegratedTransport({
      origin,
      fetchImpl: async () => new Response("{}", { headers: { "Content-Type": "application/json" } })
    });
    await assert.rejects(missingFinalUrl.requestAction("MEMORY.OPEN", { parameters: { photoId: "empty-url" } }), assertTransportError("invalid_response"));
  });
});

test("PDF download metadata rejects missing, unsafe, malformed, or mismatched headers", async () => {
  const path = fillEndpoint(ACTION_REQUESTS["BOOK.DOWNLOAD_PDF"].endpoint, parameters);
  const url = `https://book.test${path}`;
  function response(headers) {
    const value = new Response(PDF_BYTES, { status: 200, headers: { "Content-Type": "application/pdf", ...headers } });
    Object.defineProperty(value, "url", { value: url });
    return value;
  }
  const cases = [
    [{ "Content-Length": String(PDF_BYTES.length) }, "invalid_pdf_content_disposition"],
    [{ "Content-Disposition": "inline; filename=book.pdf", "Content-Length": String(PDF_BYTES.length) }, "invalid_pdf_content_disposition"],
    [{ "Content-Disposition": "attachment; filename=../book.pdf", "Content-Length": String(PDF_BYTES.length) }, "invalid_pdf_content_disposition"],
    [{ "Content-Disposition": "attachment; filename=book.pdf" }, "invalid_pdf_content_length"],
    [{ "Content-Disposition": "attachment; filename=book.pdf", "Content-Length": "many" }, "invalid_pdf_content_length"],
    [{ "Content-Disposition": "attachment; filename=book.pdf", "Content-Length": String(PDF_BYTES.length + 1) }, "invalid_pdf_content_length"]
  ];
  for (const [headers, code] of cases) {
    const transport = new BookLabIntegratedTransport({ origin: "https://book.test", fetchImpl: async () => response(headers) });
    await assert.rejects(transport.requestAction("BOOK.DOWNLOAD_PDF", { parameters }), assertTransportError(code));
  }
});
