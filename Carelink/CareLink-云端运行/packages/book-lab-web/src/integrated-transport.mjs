const JSON_MIME = "application/json";
const PDF_MIME = "application/pdf";

function query(endpoint, responseType = "json") {
  return Object.freeze({ method: "GET", endpoint, responseType, mutation: false, precondition: "none" });
}

function mutation(method, endpoint, precondition) {
  return Object.freeze({ method, endpoint, responseType: "json", mutation: true, precondition });
}

export const ACTION_REQUESTS = Object.freeze({
  "MEMORY.OPEN": query("/v2-labs/memories/photos/{photoId}"),
  "MEMORY.START_QUESTION": mutation("POST", "/v2-labs/memories/photos/{photoId}/question-jobs", "exclusive_either"),
  "MEMORY.SKIP": mutation("POST", "/v2-labs/memories/photos/{photoId}/skip", "exclusive_either"),
  "MEMORY.SAVE_ANSWER_DRAFT": mutation("PUT", "/v2-labs/memories/{memoryId}/answer-submissions", "if-match"),
  "MEMORY.REQUEST_FOLLOWUP": mutation("POST", "/v2-labs/memories/{memoryId}/followup-jobs", "if-match"),
  "MEMORY.CONFIRM": mutation("POST", "/v2-labs/memories/{memoryId}/confirmations", "if-match"),
  "MEMORY.WITHDRAW": mutation("POST", "/v2-labs/memories/{memoryId}/withdrawals", "if-match"),
  "BOOK_MEMORY.AUTHORIZE": mutation("POST", "/v2-labs/books/{bookId}/contribution-grants/{personalMemoryId}", "both"),
  "BOOK_MEMORY.WITHDRAW": mutation("POST", "/v2-labs/books/{bookId}/contribution-grants/{personalMemoryId}/withdrawals", "if-match"),
  "BOOK.OPEN_LAB": query("/v2-labs/owner/spaces/{spaceId}/book-lab"),
  "BOOK.CREATE": mutation("POST", "/v2-labs/owner/spaces/{spaceId}/books", "if-none-match"),
  "BOOK.OPEN_DRAFT": query("/v2-labs/owner/spaces/{spaceId}/books/{bookId}/draft"),
  "BOOK.GENERATE_PREVIEW": mutation("POST", "/v2-labs/owner/spaces/{spaceId}/books/{bookId}/render-jobs", "both"),
  "BOOK.EDIT_TITLE": mutation("PATCH", "/v2-labs/owner/spaces/{spaceId}/books/{bookId}/title", "if-match"),
  "BOOK.REMOVE_PAGE": mutation("POST", "/v2-labs/owner/spaces/{spaceId}/books/{bookId}/draft/pages/{pageId}/removals", "if-match"),
  "BOOK.REPLACE_PAGE_PHOTO": mutation("PUT", "/v2-labs/owner/spaces/{spaceId}/books/{bookId}/draft/pages/{pageId}/photo", "if-match"),
  "BOOK.FREEZE": mutation("POST", "/v2-labs/owner/spaces/{spaceId}/books/{bookId}/versions", "if-match"),
  "BOOK.START_NEW_VERSION": mutation("POST", "/v2-labs/owner/spaces/{spaceId}/books/{bookId}/draft-versions", "both"),
  "BOOK.OPEN_PREVIEW": query("/v2-labs/live/spaces/{spaceId}/books/{bookId}/versions/{versionId}"),
  "BOOK.DOWNLOAD_PDF": query("/v2-labs/live/spaces/{spaceId}/books/{bookId}/versions/{versionId}/pdf", "pdf")
});

const MEMORY_DETAIL_READ = query("/v2-labs/memories/{memoryId}");
const ALLOWED_REQUESTS = Object.freeze([...Object.values(ACTION_REQUESTS), MEMORY_DETAIL_READ]);

export class BookLabTransportError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BookLabTransportError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new BookLabTransportError(code, message, cause);
}

function normalizeOrigin(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch (error) {
    fail("invalid_origin", "Integrated transport requires an absolute HTTP(S) origin.", error);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    fail("invalid_origin", "Integrated transport origin cannot contain credentials, a path, a query, or a fragment.");
  }
  return url.origin;
}

function encodeParameter(name, value) {
  if ((typeof value !== "string" && typeof value !== "number") || String(value).length === 0) {
    fail("missing_path_parameter", `Missing path parameter: ${name}`);
  }
  return encodeURIComponent(String(value));
}

export function fillEndpoint(endpoint, parameters = {}) {
  return endpoint.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (_, name) => encodeParameter(name, parameters[name]));
}

function endpointMatcher(endpoint) {
  const escaped = endpoint
    .split(/(\{[A-Za-z][A-Za-z0-9]*\})/u)
    .map((part) => /^\{/u.test(part) ? "[^/?#]+" : part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("");
  return new RegExp(`^${escaped}$`, "u");
}

const ALLOWLIST = ALLOWED_REQUESTS.map((request) => Object.freeze({ ...request, matcher: endpointMatcher(request.endpoint) }));

function matchAllowedRequest(method, path) {
  return ALLOWLIST.find((request) => request.method === method && request.matcher.test(path));
}

function validateHeaderValue(name, value) {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/u.test(value)) {
    fail("invalid_header", `${name} must be an explicit non-empty header value.`);
  }
  return value;
}

function setMutationPreconditions(headers, policy, ifMatch, ifNoneMatch) {
  const hasIfMatch = ifMatch !== undefined;
  const hasIfNoneMatch = ifNoneMatch !== undefined;
  const validShape = policy === "if-match" && hasIfMatch && !hasIfNoneMatch ||
    policy === "if-none-match" && !hasIfMatch && ifNoneMatch === "*" ||
    policy === "exclusive_either" && (hasIfMatch && !hasIfNoneMatch || !hasIfMatch && ifNoneMatch === "*") ||
    policy === "both" && hasIfMatch && ifNoneMatch === "*";
  if (!validShape) fail("invalid_precondition_shape", `Mutation requires the exact ${policy} precondition shape.`);
  if (hasIfMatch) headers.set("If-Match", validateHeaderValue("If-Match", ifMatch));
  if (hasIfNoneMatch) headers.set("If-None-Match", ifNoneMatch);
}

function validatePath(path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("?") || path.includes("#")) {
    fail("unknown_route", "Only query-free canonical /v2-labs paths are accepted.");
  }
}

function jsonBytes(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    fail("invalid_json_body", "Mutation DTO must be a JSON object.");
  }
  let encoded;
  try {
    encoded = JSON.stringify(body);
  } catch (error) {
    fail("invalid_json_body", "Mutation DTO is not JSON-serializable.", error);
  }
  if (encoded === undefined) fail("invalid_json_body", "Mutation DTO is not JSON-serializable.");
  return encoded;
}

function mimeType(response) {
  return (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
}

function responseMetadata(response, body, downloadMetadata) {
  const unseenHeaders = {};
  for (const [name, value] of response.headers) {
    if (name.toLowerCase().startsWith("x-unseen-")) unseenHeaders[name.toLowerCase()] = value;
  }
  return Object.freeze({
    ok: response.ok,
    status: response.status,
    body,
    etag: response.headers.get("etag"),
    unseenHeaders: Object.freeze(unseenHeaders),
    ...downloadMetadata
  });
}

async function readJson(response) {
  if (mimeType(response) !== JSON_MIME) {
    fail("unexpected_content_type", `Expected ${JSON_MIME}; received ${mimeType(response) || "no content type"}.`);
  }
  try {
    return await response.json();
  } catch (error) {
    fail("invalid_json_response", "Response body is not valid JSON.", error);
  }
}

async function readPdf(response) {
  if (mimeType(response) !== PDF_MIME) {
    fail("unexpected_content_type", `Expected ${PDF_MIME}; received ${mimeType(response) || "no content type"}.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < 5 || String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-") {
    fail("invalid_pdf_response", "PDF response does not start with the PDF signature.");
  }
  const contentDisposition = response.headers.get("content-disposition");
  const disposition = contentDisposition?.match(/^attachment;\s*filename=(?:"([A-Za-z0-9][A-Za-z0-9 ._()-]*\.pdf)"|([A-Za-z0-9][A-Za-z0-9._()-]*\.pdf))$/iu);
  if (!disposition || (disposition[1] ?? disposition[2]).length > 200) {
    fail("invalid_pdf_content_disposition", "PDF requires an attachment Content-Disposition with a sanitized .pdf filename.");
  }
  const contentLengthHeader = response.headers.get("content-length");
  if (!/^\d+$/u.test(contentLengthHeader ?? "")) {
    fail("invalid_pdf_content_length", "PDF requires a decimal Content-Length.");
  }
  const contentLength = Number(contentLengthHeader);
  if (!Number.isSafeInteger(contentLength) || contentLength !== bytes.byteLength) {
    fail("invalid_pdf_content_length", "PDF Content-Length must equal the response body byte length.");
  }
  return Object.freeze({ bytes, contentDisposition, contentLength });
}

export class BookLabIntegratedTransport {
  constructor({ origin = globalThis.location?.origin, fetchImpl = globalThis.fetch } = {}) {
    this.origin = normalizeOrigin(origin);
    if (globalThis.location?.origin !== undefined && this.origin !== normalizeOrigin(globalThis.location.origin)) {
      fail("cross_origin_request", "Integrated transport origin must match the current page origin.");
    }
    if (typeof fetchImpl !== "function") fail("fetch_unavailable", "Integrated transport requires fetch.");
    this.fetchImpl = fetchImpl;
  }

  async requestAction(actionId, options = {}) {
    const request = ACTION_REQUESTS[actionId];
    if (!request) fail("unknown_action", `Unknown Book Lab action: ${actionId}`);
    return this.request({ ...options, method: request.method, path: fillEndpoint(request.endpoint, options.parameters) });
  }

  async readMemory(memoryId) {
    return this.request({ method: "GET", path: fillEndpoint(MEMORY_DETAIL_READ.endpoint, { memoryId }) });
  }

  async request({ method, path, body, idempotencyKey, ifMatch, ifNoneMatch } = {}) {
    const normalizedMethod = typeof method === "string" ? method.toUpperCase() : "";
    if (!["GET", "POST", "PUT", "PATCH"].includes(normalizedMethod)) {
      fail("method_not_allowed", "Integrated transport only supports GET, POST, PUT, and PATCH.");
    }
    validatePath(path);
    const allowed = matchAllowedRequest(normalizedMethod, path);
    if (!allowed) fail("unknown_route", `${normalizedMethod} ${path} is not a canonical Book Lab route.`);

    const headers = new Headers({ Accept: allowed.responseType === "pdf" ? PDF_MIME : JSON_MIME });
    let encodedBody;
    if (allowed.mutation) {
      headers.set("Content-Type", JSON_MIME);
      headers.set("Idempotency-Key", validateHeaderValue("Idempotency-Key", idempotencyKey));
      setMutationPreconditions(headers, allowed.precondition, ifMatch, ifNoneMatch);
      encodedBody = jsonBytes(body);
    } else if (body !== undefined || idempotencyKey !== undefined || ifMatch !== undefined || ifNoneMatch !== undefined) {
      fail("read_has_mutation_fields", "GET requests cannot carry mutation DTOs or mutation headers.");
    }

    const url = new URL(path, `${this.origin}/`);
    if (url.origin !== this.origin || url.pathname !== path || url.username || url.password || url.search || url.hash) {
      fail("cross_origin_request", "Integrated transport only sends same-origin, query-free requests.");
    }

    let response;
    try {
      response = await this.fetchImpl(url.href, {
        method: normalizedMethod,
        headers,
        body: encodedBody,
        credentials: "same-origin",
        redirect: "error"
      });
    } catch (error) {
      fail("fetch_failed", "Book Lab request failed before a response was accepted.", error);
    }
    if (!(response instanceof Response)) fail("invalid_response", "fetch did not return a Response.");
    if (response.redirected) fail("redirect_rejected", "Redirected Book Lab responses are rejected.");
    let finalUrl;
    try {
      finalUrl = new URL(response.url);
    } catch (error) {
      fail("invalid_response", "Book Lab response has no valid final URL.", error);
    }
    if (finalUrl.origin !== this.origin || finalUrl.pathname !== path || finalUrl.search || finalUrl.hash || finalUrl.username || finalUrl.password) {
      fail("cross_origin_response", "Book Lab response URL does not match the same-origin request.");
    }

    if (allowed.responseType === "pdf" && response.ok) {
      const pdf = await readPdf(response);
      return responseMetadata(response, pdf.bytes, {
        contentDisposition: pdf.contentDisposition,
        contentLength: pdf.contentLength
      });
    }
    return responseMetadata(response, await readJson(response));
  }
}
