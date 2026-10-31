// Decides, per route, how render() in app.js should treat account hydration
// (the GET /v1/me + mySpaces + ownerTransfers round trip behind api.read("state",
// { hydrateAccount: true })):
//
// - "required": the route is meaningless without a signed-in account (e.g. /account,
//   /manage/:id). A hydration failure (401/403 — session expired or was never there)
//   must surface as the existing session_or_permission_loss panel, so app.js's
//   safeReadState() rethrows and render()'s catch handles it. This is the pre-F3
//   behavior and stays byte-for-byte the same for every route already in this set.
// - "optional": the route renders fine for both signed-in and anonymous visitors
//   (its content just branches on state.account), so a hydration failure must never
//   fail the whole render — safeReadState() swallows the error and falls back to the
//   anonymous projection, letting the page render its logged-out variant instead of
//   an error panel. /start-upload is the first case (F3): it must keep working for an
//   anonymous visitor's "我有邀请" path even when GET /v1/me 401s.
// - false: no hydration attempted; state.account stays whatever it already was
//   (usually null on a hard navigation).
//
// "/" (the home page) deliberately does NOT get "optional" here even though it has
// the same "show a logged-in shortcut if we know the account" shape as /start-upload:
// it's the single highest-traffic entry point, hit by every anonymous first-time
// visitor, and the extra GET /v1/me + mySpaces + ownerTransfers round trip would sit
// on that hot path for everyone just to reveal one convenience text-link
// ("继续：我的空间") to a visitor who is already one click away from it via /spaces
// once signed in. /start-upload's whole primary CTA (which card renders) depends on
// account state, so the same round trip is load-bearing there, not a nice-to-have.
export function needsAccountHydration(path) {
  if (path === "/spaces" || path.startsWith("/account") || path.startsWith("/manage/") || path === "/spaces/new") return "required";
  if (path === "/start-upload") return "optional";
  return false;
}
