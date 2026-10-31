import { assert } from "../errors.mjs";

const exactKeys = ["appendAudit", "authenticateBookLabParticipant", "authorizeCorePhotoParticipant", "featureFlags",
  "listBookLabEligibleBooks", "readBookLabDisplayPhoto", "readBookLabEventForOwner", "readBookLabOwnerSnapshot",
  "readBookLabParticipantPhoto", "readBookLabRenderDerivative", "readCorePhotoContext", "readCurrentBookLabOwner",
  "readCurrentBookLabViewer", "readQuestionSourceForWorker", "registerInternalJobs", "registerRoutes", "revalidateCurrentBookLabOwner",
  "revalidateCurrentBookLabViewer"];

export function registerBookLabExtension(input, { moduleLoader = () => import("./book-lab.mjs") } = {}) {
  assert(input && typeof input === "object" && !Array.isArray(input) &&
    Object.keys(input).sort().join("\0") === exactKeys.join("\0"), "book_lab_extension_unavailable", 503);
  for (const name of exactKeys.filter((name) => name !== "featureFlags")) {
    assert(typeof input[name] === "function", "book_lab_extension_unavailable", 503);
  }
  assert(input.featureFlags && typeof input.featureFlags === "object", "book_lab_extension_unavailable", 503);
  if (input.featureFlags.bookLab !== true) return Object.freeze({ enabled: false, mountedRoutes: 0,
    registeredJobs: 0, businessWrites: 0, businessBundleImported: false });
  assert(typeof moduleLoader === "function", "book_lab_extension_unavailable", 503);
  return Promise.resolve().then(() => moduleLoader()).then((module) => {
    assert(typeof module.registerBookLabExtension === "function", "book_lab_extension_unavailable", 503);
    return Promise.resolve(module.registerBookLabExtension(input)).then((result) => {
      assert(result && typeof result === "object" && result.enabled === true,
        "book_lab_extension_unavailable", 503);
      return result;
    });
  });
}
