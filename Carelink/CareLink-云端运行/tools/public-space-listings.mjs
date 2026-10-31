#!/usr/bin/env node
// Ops CLI for the v3.1 public plaza (逛逛空间) white-list review: list requested/listed/hidden
// spaces, approve one with a curated open_url + title/description, or hide one that's already
// listed. No admin HTTP surface — this mirrors services/api/scripts/attach-depth-artifact.mjs's
// precedent: a trusted operator (Max, or CC on the server) runs this directly against the same
// sqlite file the running local-operable / production process uses. Owners can only ever move a
// listing to 'requested' (see POST /v1/spaces/{sid}/public-listing-requests); only this script can
// move a row to 'listed' or 'hidden'.
//
// Usage:
//   node tools/public-space-listings.mjs list [--status requested|listed|hidden|all] [--data-dir <dir>]
//   node tools/public-space-listings.mjs approve <spaceId> --open-url <url> [--title <t>] [--description <d>] [--data-dir <dir>]
//   node tools/public-space-listings.mjs hide <spaceId> [--data-dir <dir>]
//
// approve/hide are exported as pure(-ish) functions taking an already-open db, so
// services/api/tests can exercise them directly against an in-memory fixture without shelling out.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../services/api/src/database.mjs";
import { id, nowIso } from "../services/api/src/util.mjs";

// Kept in sync with apps/web/src/ui/templates.js's isAllowedFeaturedSpaceUrl: only a same-origin
// relative path or the production UNSEEN origin may ever render on /discover. Checking it here too
// means a bad --open-url fails loudly at approval time instead of silently vanishing from the page.
export function isAllowedOpenUrl(url) {
  if (typeof url !== "string" || url === "") return false;
  if (url.startsWith("/") && !url.startsWith("//")) return true;
  try { return new URL(url).origin === "https://unseen.maxxam.xyz"; }
  catch { return false; }
}

export function listListings(db, { status = "all" } = {}) {
  if (status !== "all" && !["requested", "listed", "hidden"].includes(status)) {
    throw new Error(`invalid status filter: ${status}`);
  }
  const rows = status === "all"
    ? db.prepare("SELECT * FROM public_space_listings ORDER BY updated_at DESC").all()
    : db.prepare("SELECT * FROM public_space_listings WHERE status=? ORDER BY updated_at DESC").all(status);
  return rows.map((row) => ({
    spaceId: row.space_id, status: row.status, title: row.title_override, description: row.description_override,
    openUrl: row.open_url, requestedAt: row.requested_at, listedAt: row.listed_at, hiddenAt: row.hidden_at,
    version: row.version
  }));
}

export function approveListing(db, spaceId, { openUrl, title, description } = {}) {
  const space = db.prepare("SELECT * FROM spaces WHERE id=?").get(spaceId);
  if (!space) throw new Error(`space not found: ${spaceId}`);
  if (!isAllowedOpenUrl(openUrl)) {
    throw new Error(`open-url is not allowed by isAllowedFeaturedSpaceUrl: must be a relative path ` +
      `("/open/...") or same-origin as https://unseen.maxxam.xyz — got ${JSON.stringify(openUrl)}`);
  }
  const existing = db.prepare("SELECT * FROM public_space_listings WHERE space_id=?").get(spaceId);
  const now = nowIso();
  const resolvedTitle = title ?? existing?.title_override ?? space.name;
  const resolvedDescription = description ?? existing?.description_override ?? "";
  if (!existing) {
    const rowId = id("psl");
    db.prepare(`INSERT INTO public_space_listings(
      id,space_id,status,title_override,description_override,open_url,requested_at,listed_at,created_at,updated_at,version
    ) VALUES(?,?,'listed',?,?,?,?,?,?,?,1)`).run(rowId, spaceId, resolvedTitle, resolvedDescription, openUrl, now, now, now, now);
  } else {
    db.prepare(`UPDATE public_space_listings SET status='listed',title_override=?,description_override=?,
      open_url=?,listed_at=?,updated_at=?,version=version+1 WHERE id=? AND version=?`)
      .run(resolvedTitle, resolvedDescription, openUrl, now, now, existing.id, existing.version);
  }
  return listListings(db).find((row) => row.spaceId === spaceId);
}

export function hideListing(db, spaceId) {
  const existing = db.prepare("SELECT * FROM public_space_listings WHERE space_id=?").get(spaceId);
  if (!existing) throw new Error(`space has no listing to hide: ${spaceId}`);
  const now = nowIso();
  db.prepare(`UPDATE public_space_listings SET status='hidden',hidden_at=?,updated_at=?,version=version+1
    WHERE id=? AND version=?`).run(now, now, existing.id, existing.version);
  return listListings(db).find((row) => row.spaceId === spaceId);
}

function parseFlags(args) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith("--")) { flags[arg.slice(2)] = args[i + 1]; i += 1; }
    else positionals.push(arg);
  }
  return { flags, positionals };
}

async function runCli() {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(moduleDir, "..");
  const fail = (message) => { console.error(`public-space-listings: ${message}`); process.exit(1); };
  const usage = "usage:\n" +
    "  node tools/public-space-listings.mjs list [--status requested|listed|hidden|all] [--data-dir <dir>]\n" +
    "  node tools/public-space-listings.mjs approve <spaceId> --open-url <url> [--title <t>] [--description <d>] [--data-dir <dir>]\n" +
    "  node tools/public-space-listings.mjs hide <spaceId> [--data-dir <dir>]";

  const [, , command, ...rest] = process.argv;
  if (!["list", "approve", "hide"].includes(command)) fail(usage);
  const { flags, positionals } = parseFlags(rest);
  const dataDir = flags["data-dir"] ? path.resolve(flags["data-dir"])
    : path.resolve(process.env.UNSEEN_LOCAL_DATA_DIR ?? path.join(repoRoot, ".unseen-local-operable"));
  const databasePath = path.join(dataDir, "unseen.sqlite");
  if (!existsSync(databasePath)) {
    fail(`no database at ${databasePath} — start local-operable (or point --data-dir at the production data directory) first`);
  }

  const db = openDatabase(databasePath);
  try {
    if (command === "list") {
      console.log(JSON.stringify(listListings(db, { status: flags.status ?? "all" }), null, 2));
      return;
    }
    const [spaceId] = positionals;
    if (!spaceId) fail(usage);
    if (command === "approve") {
      if (!flags["open-url"]) fail("approve requires --open-url <url>");
      const result = approveListing(db, spaceId, { openUrl: flags["open-url"], title: flags.title, description: flags.description });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(JSON.stringify(hideListing(db, spaceId), null, 2));
  } catch (error) {
    fail(error.message);
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  runCli();
}
