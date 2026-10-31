import { ApiError, assert } from "../../errors.mjs";

export const MEDIA_STORE_METHODS = Object.freeze(["putIfAbsent", "head", "get", "delete"]);

export function assertMediaStorePort(store) {
  assert(store && MEDIA_STORE_METHODS.every((method) => typeof store[method] === "function"),
    "media_store_unavailable", 503);
  return store;
}

export class UnavailableMediaStore {
  async putIfAbsent() { throw new ApiError("media_store_unavailable", 503); }
  async head() { throw new ApiError("media_store_unavailable", 503); }
  async get() { throw new ApiError("media_store_unavailable", 503); }
  async delete() { throw new ApiError("media_store_unavailable", 503); }
}
