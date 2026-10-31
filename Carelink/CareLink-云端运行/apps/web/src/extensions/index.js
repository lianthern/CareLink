const SECONDARY_SLOTS = new Set([
  "photoDetail.afterPlacementSecondary",
  "manageOverview.secondary"
]);

export function createWebExtensionHost({ apiClient, featureFlags = {} } = {}) {
  const routes = [];
  const slots = new Map([...SECONDARY_SLOTS].map((name) => [name, []]));
  const registerRoute = (matcher, render) => {
    if ((typeof matcher !== "string" && typeof matcher !== "function") || typeof render !== "function") throw new Error("web_extension_route_invalid");
    routes.push({ matcher, render });
  };
  const registerSecondarySlot = (name, render) => {
    if (!SECONDARY_SLOTS.has(name) || typeof render !== "function") throw new Error("web_extension_slot_invalid");
    slots.get(name).push(render);
  };
  return Object.freeze({
    async load() {
      if (featureFlags.bookLab !== true) return;
      const extension = await import("./book-lab.js");
      if (typeof extension.registerBookLabWebExtension !== "function") throw new Error("book_lab_web_extension_invalid");
      await extension.registerBookLabWebExtension({ registerRoute, registerSecondarySlot, apiClient, featureFlags });
    },
    async route(path, context) {
      const entry = routes.find(({ matcher }) => typeof matcher === "string" ? matcher === path : matcher(path));
      return entry ? entry.render(context) : null;
    },
    renderSecondarySlot(name, context) {
      if (!SECONDARY_SLOTS.has(name)) throw new Error("web_extension_slot_invalid");
      return slots.get(name).map((render) => render(context)).filter(Boolean).join("");
    }
  });
}

function defaultExtensionLoadErrorHandler(error) {
  // app.js's own module evaluation is a single top-level `await` chain (see index.html's sole
  // `<script type="module">`): an uncaught rejection here previously aborted that chain outright, so a 404 or a
  // throw from a single optional extension (book-lab.js) took down routing, render(), and every event listener
  // with it — the entire SPA went white with nothing in the console to say why. host.load() itself is left
  // free to throw (callers that want strict behavior, e.g. tests, can call it directly) — this wrapper is the
  // one used at the real app boot boundary, where "degrade, don't crash" is the only acceptable outcome.
  console.error("[unseen] extension host failed to load; continuing without extensions", error?.message || error);
}

// Boots a web-extension host without ever letting a failure escape: on success the extension's routes/slots are
// registered as normal; on failure (network 404, a throw inside the extension's own register function, a
// malformed module) it reports the error and returns false so the rest of app.js keeps rendering with
// extensions simply unavailable, instead of the whole page going white.
export async function loadWebExtensionHost(host, { onError = defaultExtensionLoadErrorHandler } = {}) {
  try {
    await host.load();
    return true;
  } catch (error) {
    onError(error);
    return false;
  }
}
