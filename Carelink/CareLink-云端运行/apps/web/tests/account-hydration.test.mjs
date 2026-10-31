import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { needsAccountHydration } from "../src/account-hydration.js";

// F3: an already-signed-in visitor who hard-navigates straight to /start-upload was
// bounced back to /login even though their session cookie was still live, because
// app.js only hydrated state.account on a fixed whitelist of routes and /start-upload
// wasn't on it. The fix can't just add /start-upload to the old boolean whitelist:
// that whitelist rethrows on a hydration failure (see safeReadState in app.js), and
// /start-upload must stay usable for an anonymous visitor's "我有邀请" path even when
// GET /v1/me 401s for them. So needsAccountHydration() now returns one of three
// hydration modes instead of a boolean.

test("required routes are unchanged from the pre-F3 whitelist and still fail closed", () => {
  for (const path of ["/spaces", "/spaces/new", "/account", "/account/uploads", "/manage/space-1", "/manage/space-1/book-lab"]) {
    assert.equal(needsAccountHydration(path), "required", path);
  }
});

test("/start-upload hydrates optionally so an expired/missing session degrades instead of failing", () => {
  assert.equal(needsAccountHydration("/start-upload"), "optional");
});

test("routes outside the whitelist, including / itself, attempt no hydration", () => {
  // "/" deliberately stays out of "optional": it is the highest-traffic entry point
  // (every anonymous first-time visitor lands there), and the extra GET /v1/me +
  // mySpaces + ownerTransfers round trip would tax that hot path for everyone just to
  // reveal one convenience link to an already-signed-in visitor who is one click from
  // it anyway via /spaces. See account-hydration.js for the full reasoning.
  for (const path of ["/", "/discover", "/login", "/open", "/s/space-1/album", "/s/space-1/upload", "/book-preview", "/support", "/privacy"]) {
    assert.equal(needsAccountHydration(path), false, path);
  }
});

test("app.js only rethrows a hydration failure for \"required\" routes, and /start-upload wires into needsAccountHydration", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(source, /import \{ needsAccountHydration \} from "\.\/account-hydration\.js";/);
  assert.match(source, /state = await safeReadState\(needsAccountHydration\(path\)\);/);
  // Only the "required" mode rethrows; "optional" and false both fall back silently
  // inside safeReadState, so an optional route's 401 never reaches render()'s catch
  // and therefore never renders the session_or_permission_loss error panel.
  assert.match(source, /if \(hydrationMode === "required"\) throw error;/);
  assert.doesNotMatch(source, /function needsAccountHydration\(/, "the old in-file boolean whitelist must be gone, not duplicated");
});
