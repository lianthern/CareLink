import { assert } from "./errors.mjs";
import { exactFields } from "./util.mjs";

export const TASKS = new Set(["view", "upload"]);
export const SCOPES = new Set(["canReview", "canEditPlacement", "canManageScene", "canInvite", "canPublish"]);
export const REAUTH_PURPOSES = new Map([
  ["AUTH.LOGOUT_ALL", "logout_all"],
  ["SPACE.ARCHIVE", "space_archive"],
  ["SPACE.RESTORE", "space_restore"],
  ["SPACE.DELETE_REQUEST", "space_delete"],
  ["ACCOUNT.DELETE_REQUEST", "account_delete"],
  ["OWNER_TRANSFER.CREATE", "owner_transfer_create"],
  ["OWNER_TRANSFER.ACCEPT", "owner_transfer_accept"],
  ["BATCH.DELETE_ITEM", "photo_delete"]
]);

export function object(body, allowed, required = allowed) {
  const result = exactFields(body, allowed, required);
  assert(result.ok, "validation_failed", 400, { field: result.field });
  return result.value;
}

export function string(value, { min = 1, max = 2000, code = "validation_failed" } = {}) {
  assert(typeof value === "string", code);
  const text = value.trim();
  const length = Array.from(text).length;
  assert(length >= min && length <= max, code);
  return text;
}

export function enumValue(value, allowed, code = "validation_failed") {
  assert(allowed.includes(value), code);
  return value;
}

export function setValues(values, allowed, code = "validation_failed") {
  assert(Array.isArray(values) && values.every((value) => allowed.has(value)) && new Set(values).size === values.length, code);
  return [...values].sort();
}
