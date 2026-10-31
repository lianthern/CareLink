export const TEMPORARY_ACCESS_MODE = "temporary-basic-auth-invite";

export async function hasTemporaryAccess(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") return false;
  try {
    const response = await fetchImpl("/healthz", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error"
    });
    return [200, 503].includes(response?.status) &&
      response.headers?.get?.("x-unseen-access-mode") === TEMPORARY_ACCESS_MODE;
  } catch {
    return false;
  }
}
