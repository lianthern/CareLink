#!/usr/bin/env node
// Ops CLI: seed a demo space (one panorama + several photos) from local files, entirely through
// services/api/src/*'s real service layer -- SpaceService, PanoramaService, UploadService,
// IdentityService, CampaignService -- driven the exact same way services/api/tests/fixture-factory.mjs
// drives them in tests: through LocalApi#handle()'s real HTTP-shaped route dispatch, just invoked
// in-process instead of over a socket. Same "no admin HTTP surface, a trusted operator touches the
// same sqlite the running local-operable process uses" precedent as tools/public-space-listings.mjs
// and services/api/scripts/attach-depth-artifact.mjs -- see their file headers for the background.
//
// Every space/photo invariant (space_lifecycle, collection_state, sharing_state,
// current_panorama_revision_id, photo_content_state/placement_state/confirmation_mode, CAS
// version numbers, placement-revision history, idempotency records, audit events, ...) is produced
// by calling the exact same service methods a real signed-in browser session would call, over the
// exact same media-validation path (inspectMedia, real ffmpeg/ffprobe decode) a real upload uses.
//
// The one thing this script does that a browser session never would: mint an account session for
// --owner directly via IdentityService#issueAccountSession() instead of completing a real
// email-OTP round trip. That is the *same* function verifyOtp() calls as its last step once a real
// OTP has verified -- it carries no different invariants, it does not touch identifiers/equivalences,
// and a trusted operator obviously cannot receive the owner's actual email OTP. This script never
// creates an account; --owner must already exist (see seedDemoSpace() below), matching "email OTP
// login never creates state a signed-in browser session couldn't already reach on its own."
//
// This script never dispatches queued jobs itself. panorama_validation / photo_validation /
// photo_placement are drained by infra/integration/local-operable.mjs's already-running worker
// against the same sqlite file -- see that file's `worker.start()`. The panorama step here polls
// panorama-candidate status for a bounded window waiting for that worker to flip it to 'ready'
// before switching the scene onto it; if nothing answers within the window the script fails loudly
// instead of silently leaving the scene unset. Uploading photos with auto_approve_uploads=1 hands
// them to that same running worker for CLIP placement -- this script's job ends at commit+finalize.
//
// Direct-SQL reads (not writes) of spaces/scenes/panorama_revisions/contribution_batch_items are
// used in a few places purely to read CAS version numbers and validation results between service
// calls -- exactly the same pattern attach-depth-artifact.mjs and public-space-listings.mjs already
// use for their own reads. No table is ever written to directly; every state transition goes
// through a service method.
//
// Usage:
//   node tools/seed-demo-space.mjs --owner <accountId> --name "AdventureX 2026 现场" \
//     [--description "..."] --panorama <path> --photos <dir-or-glob> [--photos <dir-or-glob> ...] \
//     [--data-dir <dir>] [--dry-run] [--share [--share-task-mode view|upload|combo] \
//     [--share-expires-days <n>] [--share-max-uses <n>] [--public-origin <url>]]
//
//   node tools/seed-demo-space.mjs --owner <accountId> --share-existing <spaceId> \
//     [--share-task-mode view|upload|combo] [--share-expires-days <n>] [--share-max-uses <n>] \
//     [--public-origin <url>] [--data-dir <dir>] [--dry-run]
//
// --photos may be repeated, and each value may be a directory (non-recursive, image files only),
// a glob pattern, a literal file path, or a comma-separated list of any of those -- resolved and
// deduplicated, then sorted by absolute path for a deterministic upload order.
//
// --description has nowhere to live: the `spaces` table (migration 0001) has no description
// column, and the only "public description" concept in this codebase is
// public_space_listings.description_override, which is squarely tools/public-space-listings.mjs
// approve's job (see its header -- "listing" is explicitly out of scope here). So --description is
// accepted, echoed back in this script's own output for the operator's own bookkeeping, and
// otherwise not persisted anywhere. Pass it again to `public-space-listings.mjs approve
// --description` at listing time if you want it public-facing.
//
// PRE-FLIGHT VALIDATION (validateInputFiles() below): every panorama/photo file is read AND run
// through the exact same real inspectMedia() decode path a real upload uses -- BEFORE any write
// happens, including before the space itself is created. A first production run of this script hit
// exactly the failure mode this guards against: the panorama file was owned by a different unix
// user than the script ran as, so reading it threw EACCES -- but only *after* the space had already
// been created, leaving a real orphan (see report). Now existence, readability, extension/mime, and
// (for the panorama) the 2:1-equirectangular + size-bound policy are all checked for every file
// up front; the space is never created unless every input file already passed real decode. Because
// the real commit path re-runs inspectMedia() itself (services/api never trusts a pre-check), every
// file is decoded twice on a real run -- an acceptable, deliberate cost for "nothing gets created on
// a bad input" over "decode once, maybe leave a mess."
//
// If a failure happens *after* the space is created (e.g. the job worker rejects the panorama at
// validation time, or a later step 4xxs), this script still does NOT delete the space -- that would
// be an unreviewed production data deletion this script has no business doing on its own. Instead
// every such error is re-thrown with the created spaceId (and sceneId) spelled out so the operator
// can hide/archive it by hand (tools/public-space-listings.mjs, or the owner's normal space
// settings) once they've looked at it.
//
// --share flips sharing_state to 'shared' and creates one view-only external invitation campaign
// (CampaignService#create(), services/api/src/campaign-service.mjs) via the exact same
// POST /v1/spaces/{sid}/external-invitation-campaigns route the owner's own "创建活动邀请" dialog
// uses (apps/web/src/app.js). CampaignService#shareRow() builds the visitor-facing link as
// `${publicOrigin}/open/${campaign.public_campaign_id}` -- apps/web/src/app.js's router treats any
// `/open/<token>` path as a campaign-admission link (see its `path.startsWith("/open/")` branch).
// That is the literal form already-listed template spaces use, confirmed by reading
// campaign-service.mjs + app.js rather than guessing. publicOrigin comes from --public-origin, else
// UNSEEN_LOCAL_PUBLIC_ORIGIN (the same env var infra/integration/local-operable.mjs itself reads
// for its own public origin), else a localhost placeholder -- get this wrong and the printed link is
// well-formed but points nowhere real, so this script also runs the printed URL through
// tools/public-space-listings.mjs's own isAllowedOpenUrl() (the exact same gate
// `approve --open-url` enforces) and prints a loud warning if it would be rejected there. Without
// --share, sharing_state stays 'private' exactly as before this patch -- listing on the public
// plaza remains entirely tools/public-space-listings.mjs approve's job.
//
// --share-existing <spaceId> runs the same two steps (sharing-transitions + campaign create)
// against a space that already exists, instead of seeding a brand new one -- for exactly the case
// where a space was seeded first and only needs opening up for listing afterward, without paying
// for a second full re-seed just to reach --share. Mutually exclusive with --name/--panorama/
// --photos/--description (those only make sense when creating a new space); --owner is still
// required and is checked strictly (spaceId must exist and be owned by that exact account, not
// just any member with canPublish) before anything is touched.
//
// This path is written to be safe to re-run: if the space is already 'shared', the
// sharing-transition is skipped instead of attempted (transitionSharing() 409s on a same-state
// transition, so calling it blindly on a rerun would be a spurious failure, not a no-op); if a
// live (active, unexpired, unrevoked) campaign with the requested --share-task-mode already exists
// for this space, it is reused (its existing publicCampaignUrl is reported) instead of minting a
// second, different /open/<token> link that would silently split which link is "the" link for this
// space. When both are already true, nothing is written at all -- not even a fresh account session
// for --owner. See shareExistingSpace() below.
import { existsSync, readdirSync, readFileSync, statSync, globSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../services/api/src/database.mjs";
import { loadLocalKeyring } from "../services/api/src/crypto.mjs";
import { LocalApi } from "../services/api/src/api.mjs";
import { FilesystemMediaStore } from "../services/api/src/ports/media/filesystem-media-store.mjs";
import { FfmpegDecoderRunner } from "../services/api/src/ports/media/ffmpeg-decoder-runner.mjs";
import { inspectMedia } from "../services/api/src/media.mjs";
import { sha256, stableJson } from "../services/api/src/util.mjs";
import { isAllowedOpenUrl } from "./public-space-listings.mjs";

const EXTENSION_MIME = Object.freeze({
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".heic": "image/heic", ".heif": "image/heif"
});
const SHARE_TASK_MODES = new Set(["view", "upload", "combo"]);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
  return chunks;
}

export function mimeFromExtension(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = EXTENSION_MIME[ext];
  if (!mime) throw new Error(`unsupported file extension "${ext}" for ${filePath} -- expected one of ${Object.keys(EXTENSION_MIME).join(", ")}`);
  return mime;
}

function expandPhotoEntry(entry) {
  const resolved = path.resolve(entry);
  if (existsSync(resolved) && statSync(resolved).isDirectory()) {
    return readdirSync(resolved)
      .filter((name) => EXTENSION_MIME[path.extname(name).toLowerCase()])
      .map((name) => path.join(resolved, name));
  }
  if (/[*?[\]]/.test(entry)) {
    return globSync(entry, { cwd: process.cwd() })
      .filter((name) => EXTENSION_MIME[path.extname(name).toLowerCase()])
      .map((name) => path.resolve(name));
  }
  if (!existsSync(resolved)) throw new Error(`photo path not found: ${entry}`);
  if (!statSync(resolved).isFile()) throw new Error(`photo path is not a file: ${entry}`);
  if (!EXTENSION_MIME[path.extname(resolved).toLowerCase()]) {
    throw new Error(`unsupported photo extension for ${entry} -- expected one of ${Object.keys(EXTENSION_MIME).join(", ")}`);
  }
  return [resolved];
}

// Exported for tests. Accepts the raw --photos values (each already possibly comma-separated),
// expands directories/globs/literal paths, dedupes, and returns absolute paths sorted for a
// deterministic upload order.
export function resolvePhotoPaths(rawEntries) {
  const seen = new Set();
  for (const rawEntry of rawEntries) {
    for (const entry of rawEntry.split(",").map((value) => value.trim()).filter(Boolean)) {
      for (const candidate of expandPhotoEntry(entry)) seen.add(path.resolve(candidate));
    }
  }
  return [...seen].sort();
}

export function parseArgs(argv) {
  const flags = { photos: [] };
  const valuedFlags = new Set(["--owner", "--name", "--description", "--panorama", "--data-dir",
    "--share-existing", "--share-task-mode", "--share-expires-days", "--share-max-uses", "--public-origin"]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") { flags.dryRun = true; continue; }
    if (arg === "--share") { flags.share = true; continue; }
    if (arg === "--photos") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--photos requires a value");
      flags.photos.push(value);
      i += 1;
      continue;
    }
    if (valuedFlags.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      flags[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
      i += 1;
      continue;
    }
    throw new Error(`unrecognized argument: ${arg}`);
  }
  return flags;
}

function currentNotice(db, purpose) {
  const row = db.prepare(`SELECT * FROM consent_notices
    WHERE purpose=? AND locale='zh-CN' AND retired_at IS NULL ORDER BY version DESC LIMIT 1`).get(purpose);
  if (!row) throw new Error(`no active consent notice for purpose=${purpose} -- has a LocalApi ever booted against this data dir?`);
  return { purpose, version: row.version, contentHash: row.content_hash };
}

function currentMediaNotice(db) {
  const row = db.prepare("SELECT * FROM media_notices WHERE locale='zh-CN' ORDER BY version DESC LIMIT 1").get();
  if (!row) throw new Error("no media_notices row found -- has a LocalApi ever booted against this data dir?");
  return row;
}

function makeCaller(api, accountSessionSecret) {
  let sequence = 0;
  async function call(method, urlPath, body = {}, headers = {}) {
    const finalHeaders = { authorization: `Bearer ${accountSessionSecret}`, ...headers };
    if (method !== "GET") {
      sequence += 1;
      finalHeaders["idempotency-key"] = `seed-demo-space-${Date.now()}-${sequence}-${crypto.randomUUID()}`;
    }
    return api.handle({ method, path: urlPath, body, headers: finalHeaders });
  }
  async function ok(method, urlPath, body = {}, headers = {}) {
    const result = await call(method, urlPath, body, headers);
    if (!(result.status >= 200 && result.status < 300)) {
      throw new Error(`${method} ${urlPath} failed: ${result.status} ${JSON.stringify(result.body)}`);
    }
    return result.body;
  }
  return { call, ok };
}

// Reads and *really* decodes every input file (real inspectMedia(), same as a real upload) before
// anything is created. Returns the already-read bytes + inspection results so the real upload
// steps never have to re-read from disk (they still re-run inspectMedia() themselves server-side --
// that duplication is unavoidable and deliberate, see the file header).
async function validateInputFiles({ panoramaPath, photoPaths, decoderRunner }) {
  if (!existsSync(panoramaPath) || !statSync(panoramaPath).isFile()) {
    throw new Error(`panorama file not found: ${panoramaPath}`);
  }
  const panoramaMime = mimeFromExtension(panoramaPath);
  let panoramaBytes;
  try {
    panoramaBytes = readFileSync(panoramaPath);
  } catch (error) {
    throw new Error(`panorama file is not readable: ${panoramaPath} (${error.code ?? error.message})`);
  }
  let panoramaInspection;
  try {
    panoramaInspection = await inspectMedia(panoramaBytes,
      { kind: "panorama", declaredMime: panoramaMime, declaredBytes: panoramaBytes.length, decoderRunner });
  } catch (error) {
    throw new Error(`panorama failed media validation: ${panoramaPath} (${error.code ?? error.message})`);
  }

  const photoFiles = [];
  for (const filePath of photoPaths) {
    if (!existsSync(filePath) || !statSync(filePath).isFile()) throw new Error(`photo file not found: ${filePath}`);
    const mime = mimeFromExtension(filePath);
    let bytes;
    try {
      bytes = readFileSync(filePath);
    } catch (error) {
      throw new Error(`photo file is not readable: ${filePath} (${error.code ?? error.message})`);
    }
    let inspection;
    try {
      inspection = await inspectMedia(bytes, { kind: "photo", declaredMime: mime, declaredBytes: bytes.length, decoderRunner });
    } catch (error) {
      throw new Error(`photo failed media validation: ${filePath} (${error.code ?? error.message})`);
    }
    photoFiles.push({ path: filePath, mime, bytes, inspection });
  }

  return { panoramaBytes, panoramaMime, panoramaInspection, photoFiles };
}

async function uploadPanorama(api, ok, { spaceId, spaceVersion, bytes, declaredMime, pollIntervalMs, timeoutMs }) {
  const candidate = await ok("POST", `/v1/spaces/${spaceId}/panorama-candidates`, {
    declaredMime, declaredBytes: bytes.length, clientAssetId: "demo-panorama"
  }, { "if-match": String(spaceVersion), "notice-acknowledgement": JSON.stringify(currentNotice(api.db, "panorama_upload")) });

  const put = await api.putMedia({ ticket: candidate.exactPrivateUploadTicketOnce, bytes, contentType: declaredMime, kind: "panorama" });
  if (put.status !== 200) throw new Error(`panorama media write failed: ${JSON.stringify(put.body)}`);

  let status = await ok("POST", `/v1/panorama-upload-sessions/${candidate.uploadSessionId}/commits`,
    { clientRequestId: "demo-panorama-commit" }, { "if-match": String(put.body.uploadSessionVersion) });

  const deadline = Date.now() + timeoutMs;
  while (status.status !== "ready") {
    if (status.status === "failed") throw new Error(`panorama candidate failed validation: ${status.validationCode ?? "unknown"}`);
    if (Date.now() > deadline) {
      throw new Error(`panorama candidate ${candidate.candidateId} did not become ready within ${timeoutMs}ms -- ` +
        "is infra/integration/local-operable.mjs's job worker running against this data dir? " +
        `(candidateId=${candidate.candidateId}, spaceId=${spaceId})`);
    }
    await delay(pollIntervalMs);
    status = await ok("GET", `/v1/spaces/${spaceId}/panorama-candidates/${candidate.candidateId}`);
  }

  const scene = api.db.prepare("SELECT * FROM scenes WHERE space_id=?").get(spaceId);
  const currentSpace = api.db.prepare("SELECT * FROM spaces WHERE id=?").get(spaceId);
  const switched = await ok("POST", `/v1/spaces/${spaceId}/panorama-switches`, {
    mode: "switch", candidateRevisionId: status.panoramaRevisionId, sceneIfMatchVersion: scene.version
  }, { "if-match": String(currentSpace.version) });

  const revision = api.db.prepare("SELECT * FROM panorama_revisions WHERE id=?").get(status.panoramaRevisionId);
  const report = JSON.parse(revision?.validation_report_json ?? "{}");
  return { candidateId: candidate.candidateId, assetId: candidate.assetId, panoramaRevisionId: status.panoramaRevisionId,
    width: report.width ?? null, height: report.height ?? null,
    spaceVersion: switched.spaceVersion, sceneVersion: switched.sceneVersion };
}

async function uploadPhotos(api, ok, { spaceId, spaceVersion, photoFiles }) {
  const mediaNotice = currentMediaNotice(api.db);
  const consent = await ok("POST", "/v1/consent-events",
    { purpose: "photo_upload", noticeVersion: mediaNotice.version, noticeHash: mediaNotice.content_hash });

  const photoIds = [];
  const batches = [];
  let committedCount = 0;
  let failedCount = 0;

  for (const [chunkIndex, files] of chunk(photoFiles, 50).entries()) {
    const batch = await ok("POST", `/v1/spaces/${spaceId}/contribution-batches`, {
      clientBatchId: `demo-batch-${chunkIndex}-${Date.now()}`, consentEventId: consent.consentEventId,
      declaredItemCount: files.length
    });
    let batchVersion = batch.version;
    const items = [];

    for (const [i, file] of files.entries()) {
      const { path: filePath, mime: declaredMime, bytes } = file;
      const item = await ok("POST", `/v1/contribution-batches/${batch.batchId}/items`, {
        clientItemId: `demo-item-${chunkIndex}-${i}`, declaredMime, declaredBytes: bytes.length,
        fileNameHash: sha256(path.basename(filePath))
      }, { "if-match": String(batchVersion), "x-space-version": String(spaceVersion) });
      batchVersion = item.batchVersion;

      const upload = await ok("POST", `/v1/contribution-batches/${batch.batchId}/items/${item.itemId}/upload-sessions`,
        { declaredMime, declaredBytes: bytes.length, clientUploadId: `demo-upload-${chunkIndex}-${i}` },
        { "if-match": String(item.version) });

      const put = await api.putMedia({ ticket: upload.oneTimeUploadTicket, bytes, contentType: declaredMime });
      if (put.status !== 200) throw new Error(`photo media write failed (${filePath}): ${JSON.stringify(put.body)}`);

      const committed = await ok("POST", `/v1/upload-sessions/${upload.uploadSessionId}/commits`,
        { clientCommitId: `demo-commit-${chunkIndex}-${i}` },
        { "if-match": String(put.body.uploadSessionVersion), "x-item-version": String(upload.itemVersion) });

      items.push({ path: filePath, itemId: item.itemId, photoId: committed.photoId ?? null, status: committed.status });
      if (committed.photoId) photoIds.push(committed.photoId);
    }

    const rows = api.db.prepare(`SELECT id,status,version,failure_code FROM contribution_batch_items
      WHERE batch_id=? ORDER BY rowid`).all(batch.batchId);
    const itemsDigest = sha256(stableJson(rows.map((row) => (
      { itemId: row.id, status: row.status, version: row.version, failureCode: row.failure_code }))));
    const finalized = await ok("POST", `/v1/contribution-batches/${batch.batchId}/finalizations`,
      { itemsDigest, clientRequestId: `demo-finalize-${chunkIndex}` }, { "if-match": String(batchVersion) });

    committedCount += finalized.batchResult.committedCount;
    failedCount += finalized.batchResult.failedCount;
    batches.push({ batchId: batch.batchId, receiptId: finalized.receiptId, items });
  }

  return { photoIds, committedCount, failedCount, batches };
}

// sharing-transitions (to 'shared') then one CampaignService#create() -- see the file header for
// why this specific pair produces the same `/open/<token>` link a normal owner-driven "创建活动邀请"
// would. taskMode defaults to "view": this is a showcase link for plaza listing, not an invitation
// to open up unmoderated public uploads as a side effect of --share -- an operator who wants a
// combo/upload campaign can pass --share-task-mode explicitly.
async function shareSpace(api, ok, { spaceId, spaceVersion, taskMode, expiresDays, maxSuccessfulUses }) {
  const shared = await ok("POST", `/v1/spaces/${spaceId}/sharing-transitions`,
    { to: "shared" }, { "if-match": String(spaceVersion) });
  const expiresAt = new Date(Date.now() + expiresDays * 24 * 60 * 60 * 1000).toISOString();
  const campaign = await ok("POST", `/v1/spaces/${spaceId}/external-invitation-campaigns`,
    { taskMode, expiresAt, maxSuccessfulUses }, { "if-match": String(shared.version) });
  // campaign creation never touches the spaces table -- shared.version (not campaign.version, which
  // is the campaign row's own CAS counter) is the space's true current version after this step.
  return { sharingState: shared.sharingState, spaceVersion: shared.version,
    campaignId: campaign.campaignId, publicCampaignUrl: campaign.publicCampaignUrl, qrPayload: campaign.qrPayload,
    taskMode: campaign.taskMode, entryTask: campaign.entryTask, expiresAt: campaign.expiresAt,
    maxSuccessfulUses: campaign.maxSuccessfulUses };
}

// Mirrors CampaignService#shareRow()'s one-line URL formula (services/api/src/campaign-service.mjs)
// for shareExistingSpace()'s dry-run preview and its fully-idempotent-no-op path, neither of which
// can call the real api.campaigns.shareRow() (dry-run's `api` is a bare `{ db }` with no
// CampaignService instance -- see runCli() below). The real write paths always call
// api.campaigns.shareRow() itself instead of this, so this formula only ever has to agree with
// campaign-service.mjs's, never override it.
function campaignOpenUrl(publicOrigin, publicCampaignId) {
  return `${publicOrigin.replace(/\/$/, "")}/open/${publicCampaignId}`;
}

function validateShareOptions(shareTaskMode, shareExpiresDays, shareMaxUses) {
  if (!SHARE_TASK_MODES.has(shareTaskMode)) throw new Error(`--share-task-mode must be one of ${[...SHARE_TASK_MODES].join(", ")}`);
  if (!Number.isSafeInteger(shareExpiresDays) || shareExpiresDays <= 0) throw new Error("--share-expires-days must be a positive integer");
  if (!Number.isSafeInteger(shareMaxUses) || shareMaxUses <= 0 || shareMaxUses > 100_000) {
    throw new Error("--share-max-uses must be a positive integer <= 100000");
  }
}

// Core logic for --share-existing. Exported so tests can drive it directly against a
// fixture()-built LocalApi (real mode) or a bare `{ db }` (dry-run mode -- see runCli() below).
// Only ever touches sharing_state and external_invitation_campaigns for spaceId -- collection
// state, auto_approve_uploads, the panorama, and photos are never read or written here.
export async function shareExistingSpace(api, options) {
  const { spaceId, ownerAccountId, dryRun = false, publicOrigin = "http://localhost:4173",
    shareTaskMode = "view", shareExpiresDays = 180, shareMaxUses = 100_000 } = options;

  if (!spaceId) throw new Error("--share-existing requires a spaceId");
  if (!ownerAccountId) throw new Error("--owner is required");
  validateShareOptions(shareTaskMode, shareExpiresDays, shareMaxUses);

  const owner = api.db.prepare("SELECT * FROM accounts WHERE id=?").get(ownerAccountId);
  if (!owner) throw new Error(`owner account not found: ${ownerAccountId} -- this script never creates accounts; sign up normally first`);
  if (owner.status !== "active") throw new Error(`owner account ${ownerAccountId} is not active (status=${owner.status})`);

  const space = api.db.prepare("SELECT * FROM spaces WHERE id=?").get(spaceId);
  if (!space) throw new Error(`space not found: ${spaceId}`);
  if (space.owner_account_id !== ownerAccountId) {
    throw new Error(`space ${spaceId} is not owned by ${ownerAccountId} (owner is ${space.owner_account_id})`);
  }
  if (space.space_lifecycle !== "active") {
    throw new Error(`space ${spaceId} is not active (space_lifecycle=${space.space_lifecycle}) -- cannot share`);
  }

  const willTransitionSharing = space.sharing_state !== "shared";
  // Idempotent-reuse lookup: a campaign only counts as reusable if it's still genuinely live
  // (mirrors CampaignService#assertCampaignSpace()'s own liveness check) and matches the requested
  // taskMode -- a 'view' campaign is not a substitute for an 'upload' one or vice versa.
  // external_invitation_campaigns (migration 0001) has no created_at column, so "most recent" is
  // `rowid DESC` -- the table has an ordinary implicit rowid (not WITHOUT ROWID), which tracks
  // insertion order.
  const nowIso = new Date().toISOString();
  const existingCampaign = api.db.prepare(`SELECT * FROM external_invitation_campaigns
    WHERE space_id=? AND task_mode=? AND campaign_status='active' AND revoked_at IS NULL AND expires_at>?
    ORDER BY rowid DESC LIMIT 1`).get(spaceId, shareTaskMode, nowIso);

  // CampaignService#create() itself 409s (space_state_conflict) if an 'upload'/'combo' campaign is
  // requested while collection_state isn't 'open' -- checked here too, with a clearer message,
  // since --share-existing deliberately never touches collection_state (see file header) and would
  // otherwise surface only as a raw 409 from deep inside the write path.
  if (!existingCampaign && shareTaskMode !== "view" && space.collection_state !== "open") {
    throw new Error(`cannot create a '${shareTaskMode}' campaign for ${spaceId}: collection_state is ` +
      `'${space.collection_state}', not 'open'. --share-existing never changes collection_state (only ` +
      "sharing_state and the campaign) -- open collection via the owner's normal space settings first, " +
      "or use --share-task-mode view.");
  }

  if (dryRun) {
    return {
      dryRun: true,
      spaceId,
      ownerAccountId,
      space: { name: space.name, sharingState: space.sharing_state },
      willTransitionSharing,
      share: existingCampaign
        ? { willReuseExistingCampaign: true, campaignId: existingCampaign.id,
            publicCampaignUrl: campaignOpenUrl(publicOrigin, existingCampaign.public_campaign_id),
            taskMode: existingCampaign.task_mode, expiresAt: existingCampaign.expires_at }
        : { willReuseExistingCampaign: false, taskMode: shareTaskMode, expiresDays: shareExpiresDays, maxSuccessfulUses: shareMaxUses,
            note: "no live matching campaign found to reuse -- a new one will be created; its /open/<token> is only known after a real run" }
    };
  }

  let sharingState = space.sharing_state;
  let spaceVersion = space.version;
  let campaign;
  let reusedExistingCampaign = false;

  // Fully idempotent no-op: already shared, and a live matching campaign already exists -- don't
  // even mint an account session for --owner, since nothing needs writing.
  if (!willTransitionSharing && existingCampaign) {
    campaign = api.campaigns.shareRow(existingCampaign);
    reusedExistingCampaign = true;
  } else {
    const session = api.identity.issueAccountSession(owner);
    const { ok } = makeCaller(api, session.accountSessionSecret);

    if (willTransitionSharing) {
      const shared = await ok("POST", `/v1/spaces/${spaceId}/sharing-transitions`,
        { to: "shared" }, { "if-match": String(spaceVersion) });
      sharingState = shared.sharingState;
      spaceVersion = shared.version;
    }

    if (existingCampaign) {
      campaign = api.campaigns.shareRow(existingCampaign);
      reusedExistingCampaign = true;
    } else {
      const expiresAt = new Date(Date.now() + shareExpiresDays * 24 * 60 * 60 * 1000).toISOString();
      campaign = await ok("POST", `/v1/spaces/${spaceId}/external-invitation-campaigns`,
        { taskMode: shareTaskMode, expiresAt, maxSuccessfulUses: shareMaxUses }, { "if-match": String(spaceVersion) });
    }
  }

  return {
    dryRun: false,
    spaceId,
    ownerAccountId,
    sharingState,
    spaceVersion,
    reusedExistingCampaign,
    share: { campaignId: campaign.campaignId, publicCampaignUrl: campaign.publicCampaignUrl, qrPayload: campaign.qrPayload,
      taskMode: campaign.taskMode, entryTask: campaign.entryTask, expiresAt: campaign.expiresAt,
      maxSuccessfulUses: campaign.maxSuccessfulUses }
  };
}

// Core logic, exported so tests can drive it directly against a fixture()-built LocalApi (real
// mode) or a bare `{ db, decoderRunner }` (dry-run mode -- see runCli() below for why dry-run never
// builds a full LocalApi).
export async function seedDemoSpace(api, options) {
  const { ownerAccountId, name, description = null, panoramaPath, photoPaths, dryRun = false,
    panoramaPollIntervalMs = 500, panoramaTimeoutMs = 30_000,
    share = false, shareTaskMode = "view", shareExpiresDays = 180, shareMaxUses = 100_000 } = options;

  if (!ownerAccountId) throw new Error("--owner is required");
  if (!name) throw new Error("--name is required");
  if (!panoramaPath) throw new Error("--panorama is required");
  if (!photoPaths || photoPaths.length === 0) throw new Error("--photos must resolve to at least one image file");
  if (share) validateShareOptions(shareTaskMode, shareExpiresDays, shareMaxUses);

  const owner = api.db.prepare("SELECT * FROM accounts WHERE id=?").get(ownerAccountId);
  if (!owner) throw new Error(`owner account not found: ${ownerAccountId} -- this script never creates accounts; sign up normally first`);
  if (owner.status !== "active") throw new Error(`owner account ${ownerAccountId} is not active (status=${owner.status})`);

  // Nothing is written above this line, and nothing below it runs until every input file has been
  // read and really decoded -- see validateInputFiles()'s header comment for the production
  // incident this closes.
  const decoderRunner = api.decoderRunner ?? new FfmpegDecoderRunner();
  const validated = await validateInputFiles({ panoramaPath, photoPaths, decoderRunner });

  if (dryRun) {
    // keysetOk/keysetError are intentionally not set here: this function only ever receives
    // `{ db, decoderRunner }` (no keyring) in dry-run mode -- see runCli() below, which does its
    // own read-only loadLocalKeyring() probe and merges the result into this object before
    // printing it.
    return {
      dryRun: true,
      owner: { accountId: owner.id, status: owner.status },
      space: { name, description },
      settings: {
        collectionState: "will be transitioned paused -> open (required for the owner account to upload)",
        autoApproveUploads: "already defaults on for new spaces (space-service.mjs); verified, not re-set unless off"
      },
      panorama: { path: panoramaPath, bytes: validated.panoramaBytes.length, declaredMime: validated.panoramaMime,
        width: validated.panoramaInspection.width, height: validated.panoramaInspection.height },
      photos: { count: validated.photoFiles.length,
        totalBytes: validated.photoFiles.reduce((sum, file) => sum + file.bytes.length, 0),
        files: validated.photoFiles.map((file) => ({ path: file.path, mime: file.mime, bytes: file.bytes.length,
          width: file.inspection.width, height: file.inspection.height })) },
      notices: {
        space_create: Boolean(api.db.prepare(`SELECT 1 FROM consent_notices WHERE purpose='space_create'
          AND locale='zh-CN' AND retired_at IS NULL`).get()),
        panorama_upload: Boolean(api.db.prepare(`SELECT 1 FROM consent_notices WHERE purpose='panorama_upload'
          AND locale='zh-CN' AND retired_at IS NULL`).get()),
        media_photo_upload: Boolean(api.db.prepare("SELECT 1 FROM media_notices WHERE locale='zh-CN'").get())
      },
      share: share ? { willShare: true, taskMode: shareTaskMode, expiresDays: shareExpiresDays, maxSuccessfulUses: shareMaxUses,
        note: "the actual /open/<token> URL is only known after a real run -- the token is generated at campaign-creation time" }
        : { willShare: false }
    };
  }

  const session = api.identity.issueAccountSession(owner);
  const { ok } = makeCaller(api, session.accountSessionSecret);

  const created = await ok("POST", "/v1/spaces", { name },
    { "notice-acknowledgement": JSON.stringify(currentNotice(api.db, "space_create")) });

  // From here on the space exists. Any failure below must not be swallowed into a generic message
  // -- the operator needs the spaceId to hand-inspect/hide/archive it, since this script will never
  // delete it automatically (see file header).
  try {
    let spaceVersion = created.version;

    const openedCollection = await ok("POST", `/v1/spaces/${created.spaceId}/collection-transitions`,
      { to: "open" }, { "if-match": String(spaceVersion) });
    spaceVersion = openedCollection.version;

    // New spaces default auto_approve_uploads=1 already (see space-service.mjs's #insertSpaceRow
    // comment); transitionAutoApproveUploads() rejects a same-state transition with
    // transition_not_allowed, so only call it if this space somehow doesn't already have it on.
    const autoApproveRow = api.db.prepare("SELECT auto_approve_uploads FROM spaces WHERE id=?").get(created.spaceId);
    if (!autoApproveRow.auto_approve_uploads) {
      const flipped = await ok("POST", `/v1/spaces/${created.spaceId}/auto-approve-uploads-transitions`,
        { to: "on" }, { "if-match": String(spaceVersion) });
      spaceVersion = flipped.version;
    }

    const panorama = await uploadPanorama(api, ok, {
      spaceId: created.spaceId, spaceVersion, bytes: validated.panoramaBytes, declaredMime: validated.panoramaMime,
      pollIntervalMs: panoramaPollIntervalMs, timeoutMs: panoramaTimeoutMs
    });
    spaceVersion = panorama.spaceVersion;

    const photos = await uploadPhotos(api, ok, { spaceId: created.spaceId, spaceVersion, photoFiles: validated.photoFiles });

    let shareResult = null;
    if (share) {
      shareResult = await shareSpace(api, ok, { spaceId: created.spaceId, spaceVersion,
        taskMode: shareTaskMode, expiresDays: shareExpiresDays, maxSuccessfulUses: shareMaxUses });
      spaceVersion = shareResult.spaceVersion;
    }

    return {
      dryRun: false,
      ownerAccountId,
      spaceId: created.spaceId,
      sceneId: created.sceneId,
      spaceVersion,
      space: { name, description },
      panorama,
      photos: { requested: photoPaths.length, committed: photos.committedCount, failed: photos.failedCount,
        photoIds: photos.photoIds, batches: photos.batches },
      share: shareResult
    };
  } catch (error) {
    error.message = `${error.message}\n-- space ${created.spaceId} (scene ${created.sceneId}) was already created ` +
      "before this failure and needs manual follow-up (hide/archive it via the owner's normal space settings, or " +
      "list it with tools/public-space-listings.mjs once fixed). This script never auto-deletes spaces.";
    error.spaceId = created.spaceId;
    error.sceneId = created.sceneId;
    throw error;
  }
}

async function runCli() {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(moduleDir, "..");
  const fail = (message) => { console.error(`seed-demo-space: ${message}`); process.exitCode = 1; };
  const usage = "usage:\n  node tools/seed-demo-space.mjs --owner <accountId> --name <name> " +
    "[--description <text>] --panorama <path> --photos <dir-or-glob> [--photos <dir-or-glob> ...] " +
    "[--data-dir <dir>] [--dry-run] [--share [--share-task-mode view|upload|combo] " +
    "[--share-expires-days <n>] [--share-max-uses <n>] [--public-origin <url>]]\n" +
    "  node tools/seed-demo-space.mjs --owner <accountId> --share-existing <spaceId> " +
    "[--share-task-mode view|upload|combo] [--share-expires-days <n>] [--share-max-uses <n>] " +
    "[--public-origin <url>] [--data-dir <dir>] [--dry-run]";

  let flags;
  try {
    flags = parseArgs(process.argv.slice(2));
  } catch (error) { fail(`${error.message}\n${usage}`); return; }

  const shareExistingMode = Boolean(flags.shareExisting);
  if (shareExistingMode) {
    if (flags.panorama || flags.photos.length > 0 || flags.name || flags.description) {
      fail(`--share-existing cannot be combined with --name/--panorama/--photos/--description ` +
        `(those only apply when seeding a brand new space)\n${usage}`);
      return;
    }
    if (!flags.owner) { fail(usage); return; }
  } else if (!flags.owner || !flags.name || !flags.panorama || flags.photos.length === 0) {
    fail(usage);
    return;
  }

  let photoPaths = [];
  if (!shareExistingMode) {
    try {
      photoPaths = resolvePhotoPaths(flags.photos);
    } catch (error) { fail(error.message); return; }
    if (photoPaths.length === 0) { fail("--photos resolved to zero image files"); return; }
  }

  const dataDir = flags.dataDir ? path.resolve(flags.dataDir)
    : path.resolve(process.env.UNSEEN_LOCAL_DATA_DIR ?? path.join(repoRoot, ".unseen-local-operable"));
  const databasePath = path.join(dataDir, "unseen.sqlite");
  const mediaRoot = path.join(dataDir, "media");
  const keysetPath = path.join(dataDir, "local.keyset.json");
  if (!existsSync(databasePath)) {
    fail(`no database at ${databasePath} -- start local-operable (or point --data-dir at the production data directory) first`);
    return;
  }

  // Same precedence local-operable.mjs itself uses for its own public origin. Only matters when a
  // link will actually be printed (--share or --share-existing); resolved unconditionally here so
  // dry-run's preview can show it too.
  const wantsShareLink = shareExistingMode || Boolean(flags.share);
  const publicOrigin = flags.publicOrigin ?? process.env.UNSEEN_LOCAL_PUBLIC_ORIGIN ?? "http://localhost:4173";
  if (wantsShareLink && !flags.publicOrigin && !process.env.UNSEEN_LOCAL_PUBLIC_ORIGIN) {
    console.error(`seed-demo-space: WARNING -- neither --public-origin nor UNSEEN_LOCAL_PUBLIC_ORIGIN is set; the ` +
      `printed /open/ link will be built against the placeholder origin "${publicOrigin}" and almost certainly needs ` +
      "manual correction to the real public domain before it's usable.");
  }
  if (wantsShareLink && !isAllowedOpenUrl(`${publicOrigin}/open/placeholder-token`)) {
    console.error(`seed-demo-space: WARNING -- origin "${publicOrigin}" will NOT pass ` +
      "tools/public-space-listings.mjs's isAllowedOpenUrl() (approve --open-url enforces the exact same check) -- " +
      "only a relative path or https://unseen.maxxam.xyz is allowed today. Fix --public-origin before listing this space.");
  }

  if (shareExistingMode) {
    const shareOptions = { spaceId: flags.shareExisting, ownerAccountId: flags.owner, dryRun: Boolean(flags.dryRun),
      publicOrigin, shareTaskMode: flags.shareTaskMode ?? "view",
      shareExpiresDays: flags.shareExpiresDays !== undefined ? Number(flags.shareExpiresDays) : 180,
      shareMaxUses: flags.shareMaxUses !== undefined ? Number(flags.shareMaxUses) : 100_000 };

    // Same "never even construct a LocalApi for dry-run" reasoning as the create-new-space path
    // below -- plain openDatabase() plus a read-only keyset probe is all a dry-run needs here too.
    if (flags.dryRun) {
      let db;
      try {
        db = openDatabase(databasePath);
        const result = await shareExistingSpace({ db }, shareOptions);
        try {
          loadLocalKeyring(keysetPath, { allowCreate: false });
          result.keysetOk = true;
        } catch (error) {
          result.keysetOk = false;
          result.keysetError = error.message;
        }
        console.log(JSON.stringify(result, null, 2));
      } catch (error) {
        fail(error.message);
      } finally {
        db?.close();
      }
      return;
    }

    let api;
    try {
      const keyring = loadLocalKeyring(keysetPath, { allowCreate: false });
      const mediaStore = new FilesystemMediaStore(mediaRoot);
      api = new LocalApi({ database: databasePath, keyring, mediaStore, publicOrigin });
      await api.ready;

      const result = await shareExistingSpace(api, shareOptions);
      console.log(JSON.stringify(result, null, 2));
      console.error(`seed-demo-space: space ${result.spaceId} sharing_state=${result.sharingState} ` +
        `(${result.reusedExistingCampaign ? "reused an existing live campaign" : "created a new campaign"}) -- ` +
        `link: ${result.share.publicCampaignUrl}. This space's listing status is unchanged -- list it with ` +
        `node tools/public-space-listings.mjs approve ${result.spaceId} --open-url ${result.share.publicCampaignUrl} ` +
        "[--title <t>] [--description <d>] if you haven't already.");
    } catch (error) {
      fail(error.message);
    } finally {
      api?.close();
    }
    return;
  }

  const seedOptions = { ownerAccountId: flags.owner, name: flags.name, description: flags.description ?? null,
    panoramaPath: path.resolve(flags.panorama), photoPaths, dryRun: Boolean(flags.dryRun),
    share: Boolean(flags.share), shareTaskMode: flags.shareTaskMode ?? "view",
    shareExpiresDays: flags.shareExpiresDays !== undefined ? Number(flags.shareExpiresDays) : 180,
    shareMaxUses: flags.shareMaxUses !== undefined ? Number(flags.shareMaxUses) : 100_000 };

  // dry-run deliberately never constructs a LocalApi: even though LocalApi's own idempotent
  // notice-seeding (INSERT OR IGNORE, same rows every boot) is harmless, mountExtensions() and
  // future construction-time side effects are not something a "--dry-run must write nothing"
  // contract should have to reason about. Plain openDatabase() (the same helper
  // public-space-listings.mjs / attach-depth-artifact.mjs already use for reads) plus a bare,
  // side-effect-free FfmpegDecoderRunner (so pre-flight media validation still runs for real) is
  // all seedDemoSpace()'s dryRun branch ever touches.
  if (flags.dryRun) {
    let db;
    try {
      db = openDatabase(databasePath);
      const result = await seedDemoSpace({ db, decoderRunner: new FfmpegDecoderRunner() }, seedOptions);
      try {
        loadLocalKeyring(keysetPath, { allowCreate: false });
        result.keysetOk = true;
      } catch (error) {
        result.keysetOk = false;
        result.keysetError = error.message;
      }
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      fail(error.message);
    } finally {
      db?.close();
    }
    return;
  }

  let api;
  try {
    const keyring = loadLocalKeyring(keysetPath, { allowCreate: false });
    const mediaStore = new FilesystemMediaStore(mediaRoot);
    api = new LocalApi({ database: databasePath, keyring, mediaStore, publicOrigin });
    await api.ready;

    const result = await seedDemoSpace(api, seedOptions);
    console.log(JSON.stringify(result, null, 2));
    console.error(`seed-demo-space: created space ${result.spaceId} (scene ${result.sceneId}) with ` +
      `${result.photos.committed}/${result.photos.requested} photo(s) committed (${result.photos.failed} failed).` +
      (result.share ? ` Shareable link: ${result.share.publicCampaignUrl}` : "") +
      " This space is not on the public plaza -- list it with " +
      `node tools/public-space-listings.mjs approve ${result.spaceId} --open-url ` +
      `${result.share ? result.share.publicCampaignUrl : "<url>"} [--title <t>] [--description <d>], ` +
      `or hide/archive it later the same way if you need to take it down. spaceId=${result.spaceId}`);
  } catch (error) {
    fail(error.message);
  } finally {
    api?.close();
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await runCli();
}
