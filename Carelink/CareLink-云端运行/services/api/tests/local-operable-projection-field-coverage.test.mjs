import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/database.mjs";

// Structural regression guard, added at the coordinator's request after the third instance of
// the same bug class in infra/integration/local-operable.mjs's hand-rolled DB-row-to-DTO
// projections:
//   1. photoProjection(): `media_type` was added to the `photos` table (migration 0017) but never
//      read inside photoProjection() at all -- see local-operable-video-media-type-projection.test.mjs.
//   2. managementProjection(): `memberships`/`memberInvitations` were once hardcoded to `[]`
//      instead of querying real rows -- see member-invitation-membership-management-projection.test.mjs.
//   3. (Suspected, checked, NOT a bug this time) confirmedPlacementCount/missingDirections --
//      see local-operable-management-fields-projection.test.mjs. managementProjection()'s *own*
//      return object spreads `...raw` first, so new top-level SpaceService#management() fields
//      pass through automatically unless a later key shadows them; the sibling test above pins
//      that down directly with a real HTTP round-trip.
//
// This test targets a narrower, more mechanical failure mode than #3: a DB column that exists but
// is never even *read* inside one of this file's five hand-rolled row -> DTO mappers (they all
// build a fresh object field-by-field from a raw SQLite row, none of them spread the row itself --
// spreading a raw snake_case DB row into a client-facing DTO would leak internal columns, so this
// is the deliberate, correct shape; the risk is a column silently never being carried over into
// ANY key at all). That's exactly incidents #1 and #2's shape: a column exists, nothing in the
// mapper's body ever reads it, so it never reaches the client under any name.
//
// Method: statically extract each mapper's source body from local-operable.mjs, find every
// `<rowVar>.<column>` reference inside it (regardless of what key that value ends up under -- the
// point is only "was this raw column touched at all"), and diff that set against the live table's
// PRAGMA table_info() columns (which automatically picks up every migration, present and future).
// Anything left over must be justified in an explicit, commented allow-list below, or the test
// fails with the exact missing column name(s) -- the same failure message shape this bug class
// keeps producing, now caught before it ships instead of after a production report.
//
// Deliberately NOT extended to check that every allow-listed field is *correctly* wired end to
// end (that's what the targeted regression tests above are for) -- this test only answers "was
// the column touched at all", which is cheap, low-maintenance, and was sufficient to have caught
// all three real incidents above.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const source = readFileSync(path.join(repoRoot, "infra/integration/local-operable.mjs"), "utf8");
const db = openDatabase(":memory:");
const columnsOf = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);

// Extracts the brace-matched body of a top-level `function <name>(...) { ... }` declaration.
// Only needs to work for the two top-level functions this file checks (photoProjection,
// managementProjection) -- the four other mappers below are arrow-function closures *inside*
// managementProjection's body, found by scanning within that already-extracted text instead of
// needing their own span (their parameter names -- membership/invitation/campaign/candidate --
// are unique within the file, so a plain regex scan across the whole managementProjection body
// cannot cross-contaminate between mappers).
function extractFunctionBody(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `expected to find "${marker}" in infra/integration/local-operable.mjs -- has it been renamed or moved?`);
  // Walk past the parameter list first, matching parens (not braces) -- this file's projection
  // functions take destructured-default-value params like `{ privateMedia = false } = {}`, whose
  // own braces would otherwise fool a brace-only counter into stopping right after them, before
  // ever reaching the real function-body brace. Only once the parameter list's parens balance back
  // to zero do we look for the `{` that opens the actual body.
  let parenDepth = 0, index = start + marker.length - 1; // start on the marker's own "("
  for (; index < source.length; index += 1) {
    if (source[index] === "(") parenDepth += 1;
    else if (source[index] === ")") { parenDepth -= 1; if (parenDepth === 0) break; }
  }
  assert.ok(parenDepth === 0, `unbalanced parens in ${name}()'s parameter list -- extractor bug, not a source bug`);
  const braceStart = source.indexOf("{", index);
  let depth = 0;
  index = braceStart;
  for (; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") { depth -= 1; if (depth === 0) break; }
  }
  assert.ok(depth === 0, `unbalanced braces while extracting ${name}() -- extractor bug, not a source bug`);
  return source.slice(braceStart, index + 1);
}

// Strips `//` and `/* */` comments while copying string/template literals through verbatim (not
// entering them looking for nested comment markers) -- required because this file's own comments
// narrate exactly the column names being checked here (e.g. photoProjection's header comment
// literally contains the text "photo.media_type"), which would otherwise fool referencedColumns()
// below into treating prose as a real reference. Verified this was a real gap, not a hypothetical
// one: the first draft of this test kept passing even with `mediaType: photo.media_type,` deleted
// from the actual return object, purely because of that comment's prose -- see the report for the
// two before/after runs proving this version (with comment-stripping) actually catches it.
function stripComments(text) {
  let result = "", i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === "\\" ? 2 : 1;
      j = Math.min(j + 1, text.length);
      result += text.slice(i, j);
      i = j;
      continue;
    }
    if (text[i] === "/" && text[i + 1] === "/") { const nl = text.indexOf("\n", i); i = nl === -1 ? text.length : nl; continue; }
    if (text[i] === "/" && text[i + 1] === "*") { const end = text.indexOf("*/", i + 2); i = end === -1 ? text.length : end + 2; continue; }
    result += ch;
    i += 1;
  }
  return result;
}

function referencedColumns(body, receiverName) {
  const code = stripComments(body);
  const pattern = new RegExp(`\\b${receiverName}\\??\\.(\\w+)`, "g");
  const found = new Set();
  let match;
  while ((match = pattern.exec(code))) found.add(match[1]);
  return found;
}

function assertEveryColumnTouched(label, table, body, receiverName, allowList) {
  const referenced = referencedColumns(body, receiverName);
  const missing = columnsOf(table).filter((column) => !referenced.has(column) && !allowList.has(column));
  assert.deepEqual(missing, [],
    `${label}: ${table} column(s) never read inside the mapper and not on the allow list: ${missing.join(", ")} -- ` +
    `this is the exact shape that dropped photos.media_type before (see local-operable-video-media-type-projection.test.mjs): ` +
    `either project the column under some key, or add it to the allow list with a one-line reason.`);
}

const photoProjectionBody = extractFunctionBody("photoProjection");
const managementProjectionBody = extractFunctionBody("managementProjection");

test("photoProjection() touches every `photos` column, or the column is on an explicit allow list", () => {
  assertEveryColumnTouched("photoProjection", "photos", photoProjectionBody, "photo", new Set([
    "batch_id", // superseded by item.batch_id (the contribution_batch_items join) -- same value, different route in
    "deleted_at", // soft-delete marker; every caller already filters `WHERE deleted_at IS NULL` before this row arrives
    "captured_at", // no apps/web consumer today (grep-verified) -- used only by book-lab provenance hashing server-side
    "video_asset_id" // client never needs the raw asset id: video playback is the fixed /photos/{pid}/video URL, gated by mediaType==='video'
  ]));
});

test("managementProjection()'s campaigns mapper touches every `external_invitation_campaigns` column, or is allow-listed", () => {
  assertEveryColumnTouched("managementProjection.campaigns", "external_invitation_campaigns", managementProjectionBody, "campaign", new Set([
    "space_id", // scoping only -- the whole response is already scoped to one space
    "tasks_json", // superseded by task_mode for this UI (invitationsTab only branches on taskMode, see templates.js)
    "expired_at", // audit-only timestamp; campaign_status already has an 'expired' state the UI reads
    "max_pending_admissions", // internal rate-limit ceiling, not surfaced to any current UI
    "rate_policy_version", "abuse_policy_version", // internal policy version markers, never client-facing
    "created_by", // internal actor id
    "revoked_at" // audit-only timestamp; campaign_status already has a 'revoked' state the UI reads
  ]));
});

test("managementProjection()'s memberships mapper touches every `space_memberships` column, or is allow-listed", () => {
  assertEveryColumnTouched("managementProjection.memberships", "space_memberships", managementProjectionBody, "membership", new Set([
    "space_id", // scoping only
    "created_by", // internal actor id
    "accepted_at", // no current UI consumer (membersTab shows status, not join date)
    "revoked_at" // audit-only timestamp; status already has a 'revoked' state the UI reads
  ]));
});

test("managementProjection()'s memberInvitations mapper touches every `member_invitations` column, or is allow-listed", () => {
  assertEveryColumnTouched("managementProjection.memberInvitations", "member_invitations", managementProjectionBody, "invitation", new Set([
    "space_id", // scoping only
    "credential_mac", "credential_key_id", // the invitation secret's MAC/key -- must never reach the client, by design
    "created_by" // internal actor id
  ]));
});

test("managementProjection()'s panoramaCandidates mapper touches every `panorama_candidates` column, or is allow-listed", () => {
  assertEveryColumnTouched("managementProjection.panoramaCandidates", "panorama_candidates", managementProjectionBody, "candidate", new Set([
    "space_id", // scoping only
    "asset_id", // no thumbnail/preview is rendered for a candidate (sceneManagementContent shows only fileName+status), so the raw asset id has no current consumer
    "validation_job_id", // internal job tracking
    "created_by", // internal actor id
    "expires_at", "committed_at", "ready_at", "failed_at", // internal audit timestamps, no current UI consumer
    "current_upload_session_id" // internal upload-session correlation id
  ]));
});
