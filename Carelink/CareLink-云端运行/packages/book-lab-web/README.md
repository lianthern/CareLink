# @unseen/book-lab-web

Track 8B contains two deliberately separate checkpoints:

- The existing BL01–BL06 fixture UI remains deterministic and standalone. It consumes the frozen Book Lab action/string catalog and the same frozen manifest used by `@unseen/book-renderer`.
- `src/integrated-transport.mjs`, `src/integrated-controller.mjs`, and `src/integrated-shell.mjs` provide a dependency-free, same-origin API and visual-shell checkpoint for later Core mounting. They are not wired into the fixture dev server or the host Web extension.

```bash
node packages/book-lab-web/scripts/dev-server.mjs
# open http://127.0.0.1:4328/labs/memories/photos/photo-01
node --test packages/book-lab-web/tests/*.test.mjs
```

The fixture server still uses `/__fixture` and `/__artifacts/render`; all of its mutations remain browser-memory fixture interactions and reset on reload. Integrated mode never calls those endpoints and has no fixture fallback.

## Integrated checkpoint

```js
import { BookLabIntegratedController } from "./src/integrated-controller.mjs";
import { createIntegratedBookLabVisualShell } from "./src/integrated-shell.mjs";
import { BookLabIntegratedTransport } from "./src/integrated-transport.mjs";

const transport = new BookLabIntegratedTransport({ origin: location.origin });
const controller = new BookLabIntegratedController({ transport });
const page = await controller.readRoute(location.pathname);
const updated = await controller.mutate("BOOK.EDIT_TITLE", {
  parameters: { spaceId, bookId },
  dto: { title },
  idempotencyKey,
  etag: page.response.etag
});
await controller.rereadRoute();

const shell = createIntegratedBookLabVisualShell({ controller, catalog });
await shell.mount(document.querySelector("main"), location.pathname);
```

The transport allowlists the frozen 20 `/v2-labs` actions plus the contract-declared subordinate memory-detail read. It sends cookies only through `fetch(..., { credentials: "same-origin" })`, rejects redirects, cross-origin or query-bearing URLs, unknown method/path pairs, and unexpected response types. Every mutation requires an `Idempotency-Key` and its action's exact conditional shape; question start/skip accept exactly one of present-branch `If-Match` or absent-branch `If-None-Match: *`. Results retain `status`, parsed JSON or PDF bytes in `body`, `etag`, and lower-case `x-unseen-*` response headers; successful PDF downloads also retain validated `contentDisposition` and numeric `contentLength`. HTTP error DTOs are returned with `ok: false`; transport-policy and parse failures throw `BookLabTransportError`.

BL06 reads only the authenticated canonical `BOOK.OPEN_PREVIEW` JSON payload and downloads PDF only through `BOOK.DOWNLOAD_PDF`. This checkpoint does not invent an unauthenticated HTML/artifact URL, adapt a renderer manifest, mount Core routes, enable a feature, contact an AI/cloud service, or claim server E2E/Book MVE completeness.

The visual shell renders BL01–BL06 from authenticated DTOs, dispatches all 20 frozen actions through the integrated controller, escapes untrusted text, and re-reads the current route after mutation. Owner freeze/new-version actions consume only the exact, current `x-unseen-book-owner-preconditions` response header and stay disabled when it is missing or incomplete. Contribution authorization similarly stays disabled until the server returns its target-book projection and authorization ETag. BL06 deliberately renders only authenticated metadata plus the canonical PDF action; the host extension must mount the server-guarded canonical HTML document rather than reconstructing it here.
