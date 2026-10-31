import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BookLabIntegratedController, resolveIntegratedRoute } from "../src/integrated-controller.mjs";
import { BookLabTransportError } from "../src/integrated-transport.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function fakeTransport() {
  const calls = [];
  return {
    calls,
    async requestAction(actionId, options) {
      calls.push({ kind: "action", actionId, options });
      return { ok: true, status: 200, body: { actionId }, etag: "\"v2\"", unseenHeaders: {} };
    },
    async readMemory(memoryId) {
      calls.push({ kind: "memory-detail", memoryId });
      return { ok: true, status: 200, body: { memoryId }, etag: "\"m2\"", unseenHeaders: {} };
    }
  };
}

function isCode(code) {
  return (error) => error instanceof BookLabTransportError && error.code === code;
}

test("BL01-BL06 route reads use only canonical actions or the frozen subordinate memory read", async () => {
  const transport = fakeTransport();
  const controller = new BookLabIntegratedController({ transport });
  const cases = [
    ["/labs/memories/photos/photo%2001", "BL01", { kind: "action", actionId: "MEMORY.OPEN", options: { parameters: { photoId: "photo 01" } } }],
    ["/labs/memories/memory-01", "BL02", { kind: "memory-detail", memoryId: "memory-01" }],
    ["/labs/books/book-01/contributions/memory-02", "BL03", { kind: "memory-detail", memoryId: "memory-02" }],
    ["/manage/space-01/book-lab", "BL04", { kind: "action", actionId: "BOOK.OPEN_LAB", options: { parameters: { spaceId: "space-01" } } }],
    ["/manage/space-01/book-lab/book-01/draft", "BL05", { kind: "action", actionId: "BOOK.OPEN_DRAFT", options: { parameters: { spaceId: "space-01", bookId: "book-01" } } }],
    ["/s/space-01/books/book-01/versions/version-01", "BL06", { kind: "action", actionId: "BOOK.OPEN_PREVIEW", options: { parameters: { spaceId: "space-01", bookId: "book-01", versionId: "version-01" } } }]
  ];

  for (const [pathname, entry, expectedCall] of cases) {
    const read = await controller.readRoute(pathname);
    assert.equal(read.entry, entry);
    assert.deepEqual(transport.calls.at(-1), expectedCall);
  }
  const beforeReread = transport.calls.length;
  const reread = await controller.rereadRoute();
  assert.equal(reread.entry, "BL06");
  assert.equal(transport.calls.length, beforeReread + 1);
  assert.deepEqual(transport.calls.at(-1), cases.at(-1)[2]);
});

test("BL06 consumes the authenticated canonical preview payload without constructing another HTML request", async () => {
  const canonicalPayload = Object.freeze({ versionId: "version-01", pages: [{ pageId: "page-01" }] });
  const calls = [];
  const controller = new BookLabIntegratedController({
    transport: {
      async requestAction(actionId, options) {
        calls.push({ actionId, options });
        return { ok: true, status: 200, body: canonicalPayload, etag: "\"preview-1\"", unseenHeaders: {} };
      },
      async readMemory() { throw new Error("not expected"); }
    }
  });
  const read = await controller.readRoute("/s/space-01/books/book-01/versions/version-01");
  assert.equal(read.response.body, canonicalPayload);
  assert.deepEqual(calls, [{
    actionId: "BOOK.OPEN_PREVIEW",
    options: { parameters: { spaceId: "space-01", bookId: "book-01", versionId: "version-01" } }
  }]);
});

test("mutate forwards the DTO, idempotency key, and ETag unchanged", async () => {
  const transport = fakeTransport();
  const controller = new BookLabIntegratedController({ transport });
  const dto = { title: "共光以后" };
  const response = await controller.mutate("BOOK.EDIT_TITLE", {
    parameters: { spaceId: "space-01", bookId: "book-01" },
    dto,
    idempotencyKey: "edit-title-01",
    etag: "\"book-3,draft-7\""
  });
  assert.equal(response.etag, "\"v2\"");
  assert.deepEqual(transport.calls, [{
    kind: "action",
    actionId: "BOOK.EDIT_TITLE",
    options: {
      parameters: { spaceId: "space-01", bookId: "book-01" },
      body: dto,
      idempotencyKey: "edit-title-01",
      ifMatch: "\"book-3,draft-7\"",
      ifNoneMatch: undefined
    }
  }]);
});

test("integrated mode fails closed on route errors and has no fixture/artifact fallback", async () => {
  const controller = new BookLabIntegratedController({ transport: fakeTransport() });
  await assert.rejects(controller.rereadRoute(), isCode("route_not_read"));
  assert.throws(() => resolveIntegratedRoute("/__fixture"), isCode("unknown_ui_route"));
  assert.throws(() => resolveIntegratedRoute("/manage/space/book-lab?token=secret"), isCode("unknown_ui_route"));
  assert.throws(() => resolveIntegratedRoute("/labs/memories/%2F"), isCode("invalid_ui_route"));
  await assert.rejects(controller.readAction("BOOK.EDIT_TITLE"), isCode("mutation_requires_dto"));
  await assert.rejects(controller.mutate("BOOK.OPEN_LAB", { dto: {} }), isCode("read_requires_read_action"));

  const source = `${await readFile(resolve(here, "../src/integrated-controller.mjs"), "utf8")}\n${await readFile(resolve(here, "../src/integrated-transport.mjs"), "utf8")}`;
  assert.doesNotMatch(source, /\/__fixture|\/__artifacts\/render/u);
});
