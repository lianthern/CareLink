import { ACTION_REQUESTS, BookLabTransportError } from "./integrated-transport.mjs";

const ROUTE_READS = Object.freeze([
  Object.freeze({ entry: "BL01", matcher: /^\/labs\/memories\/photos\/([^/]+)\/?$/u, names: ["photoId"], actionId: "MEMORY.OPEN" }),
  Object.freeze({ entry: "BL02", matcher: /^\/labs\/memories\/([^/]+)\/?$/u, names: ["memoryId"], subordinate: "memory-detail" }),
  Object.freeze({ entry: "BL03", matcher: /^\/labs\/books\/([^/]+)\/contributions\/([^/]+)\/?$/u, names: ["bookId", "memoryId"], subordinate: "memory-detail" }),
  Object.freeze({ entry: "BL04", matcher: /^\/manage\/([^/]+)\/book-lab\/?$/u, names: ["spaceId"], actionId: "BOOK.OPEN_LAB" }),
  Object.freeze({ entry: "BL05", matcher: /^\/manage\/([^/]+)\/book-lab\/([^/]+)\/draft\/?$/u, names: ["spaceId", "bookId"], actionId: "BOOK.OPEN_DRAFT" }),
  Object.freeze({ entry: "BL06", matcher: /^\/s\/([^/]+)\/books\/([^/]+)\/versions\/([^/]+)\/?$/u, names: ["spaceId", "bookId", "versionId"], actionId: "BOOK.OPEN_PREVIEW" })
]);

function fail(code, message, cause) {
  throw new BookLabTransportError(code, message, cause);
}

function decodeIdentifier(value) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch (error) {
    fail("invalid_ui_route", "UI route contains invalid percent encoding.", error);
  }
  if (!decoded || /[/\\?#]/u.test(decoded)) fail("invalid_ui_route", "UI route identifier is not canonical.");
  return decoded;
}

export function resolveIntegratedRoute(pathname) {
  if (typeof pathname !== "string" || !pathname.startsWith("/") || pathname.startsWith("//") || pathname.includes("?") || pathname.includes("#")) {
    fail("unknown_ui_route", "Integrated route reads require a query-free BL01-BL06 pathname.");
  }
  for (const route of ROUTE_READS) {
    const match = pathname.match(route.matcher);
    if (!match) continue;
    const parameters = Object.fromEntries(route.names.map((name, index) => [name, decodeIdentifier(match[index + 1])]));
    return Object.freeze({
      entry: route.entry,
      pathname,
      parameters: Object.freeze(parameters),
      actionId: route.actionId ?? null,
      subordinate: route.subordinate ?? null
    });
  }
  fail("unknown_ui_route", `Unknown integrated Book Lab route: ${pathname}`);
}

export class BookLabIntegratedController {
  #lastRoute = null;

  constructor({ transport } = {}) {
    if (!transport || typeof transport.requestAction !== "function" || typeof transport.readMemory !== "function") {
      fail("invalid_transport", "Integrated controller requires a Book Lab transport.");
    }
    this.transport = transport;
  }

  async readRoute(pathname) {
    const route = resolveIntegratedRoute(pathname);
    this.#lastRoute = route;
    return this.#performRouteRead(route);
  }

  async rereadRoute() {
    if (!this.#lastRoute) fail("route_not_read", "No integrated route is available to re-read.");
    return this.#performRouteRead(this.#lastRoute);
  }

  async readAction(actionId, { parameters = {} } = {}) {
    const request = ACTION_REQUESTS[actionId];
    if (!request) fail("unknown_action", `Unknown Book Lab action: ${actionId}`);
    if (request.mutation) fail("mutation_requires_dto", `${actionId} must use mutate().`);
    return this.transport.requestAction(actionId, { parameters });
  }

  async mutate(actionId, { parameters = {}, dto, idempotencyKey, etag, ifNoneMatch } = {}) {
    const request = ACTION_REQUESTS[actionId];
    if (!request) fail("unknown_action", `Unknown Book Lab action: ${actionId}`);
    if (!request.mutation) fail("read_requires_read_action", `${actionId} is read-only.`);
    return this.transport.requestAction(actionId, {
      parameters,
      body: dto,
      idempotencyKey,
      ifMatch: etag,
      ifNoneMatch
    });
  }

  async #performRouteRead(route) {
    const response = route.subordinate === "memory-detail"
      ? await this.transport.readMemory(route.parameters.memoryId)
      : await this.transport.requestAction(route.actionId, { parameters: route.parameters });
    return Object.freeze({ entry: route.entry, route, response });
  }
}
