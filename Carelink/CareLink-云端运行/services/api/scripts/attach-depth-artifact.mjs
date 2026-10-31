#!/usr/bin/env node
// Attach a locally generated depth artifact (see tools/depth-gen/generate_depth_artifact.py)
// to a space's *current* panorama revision. Local/dev only — not a production admin surface.
//
// Why a script instead of an HTTP admin endpoint: depth maps are a one-time, offline, Mac-side
// batch product (see the task report), not something an untrusted client ever uploads — there is
// no capability-ticket / decoder-sandbox surface to defend the way panorama-service.mjs's upload
// flow does for real user-submitted media. A trusted operator (Max, or a local-operable smoke
// test) runs this directly against the same sqlite file + media directory the running
// local-operable server uses. A real multi-tenant admin upload endpoint is future work, gated on
// resolving the DAP model's CC BY-NC licensing (see report) — this script deliberately does not
// pretend to be that.
//
// Usage:
//   node services/api/scripts/attach-depth-artifact.mjs <spaceId> <depth.png> <artifact.json> [--data-dir <dir>]
//
// <depth.png> and <artifact.json> are generate_depth_artifact.py's two output files. <spaceId>
// must already have an activated (ready/activated/not-retired) panorama revision — i.e. the
// space has gone through the normal panorama upload + switch flow at least once.
//
// attachDepthArtifact() below is exported so services/api/tests can exercise the DB/media-store
// logic directly against an in-memory fixture, without shelling out to this file as a subprocess.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/database.mjs";
import { FilesystemMediaStore } from "../src/ports/media/filesystem-media-store.mjs";
import { id, nowIso } from "../src/util.mjs";

export function pngDimensions(bytes) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature) || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("depth_png_invalid: not a PNG with a leading IHDR chunk");
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

export function validateDepthPrecursor(meta, pngDims) {
  if (meta.schemaVersion !== "unseen-depth-artifact-precursor/1") throw new Error("artifact_schema_unsupported");
  if (pngDims.width !== meta.width || pngDims.height !== meta.height) throw new Error("depth_png_dimensions_mismatch");
  if (!Number.isFinite(meta.nearMeters) || !Number.isFinite(meta.farMeters) ||
    meta.nearMeters < 0.1 || meta.farMeters <= meta.nearMeters || meta.farMeters > 100) {
    throw new Error("depth_calibration_invalid: nearMeters/farMeters out of the range depth.js's validateDepthArtifact accepts");
  }
  if (!meta.safetyEnvelope || meta.safetyEnvelope.schemaVersion !== "unseen-polar-safety-envelope/1" ||
    !Array.isArray(meta.safetyEnvelope.directions) || meta.safetyEnvelope.directions.length < 8) {
    throw new Error("safety_envelope_invalid");
  }
  const validFraction = Number(meta.quality?.validFraction);
  if (!Number.isFinite(validFraction) || validFraction < 0.98 || validFraction > 1) {
    throw new Error(`quality_valid_fraction_below_threshold: ${meta.quality?.validFraction} (need >= 0.98)`);
  }
}

/**
 * Given an already-open db (services/api/src/database.mjs's openDatabase()) and mediaStore
 * (FilesystemMediaStore), attach pngBytes+meta (generate_depth_artifact.py's two outputs,
 * already parsed/read) to spaceId's current panorama revision. Idempotent per
 * (spaceId, current revision) — re-running replaces the prior depth artifact for that revision.
 */
export async function attachDepthArtifact(db, mediaStore, { spaceId, pngBytes, meta }) {
  const pngDims = pngDimensions(pngBytes);
  validateDepthPrecursor(meta, pngDims);

  const space = db.prepare("SELECT * FROM spaces WHERE id=?").get(spaceId);
  if (!space) throw new Error(`space not found: ${spaceId}`);
  const revisionId = space.current_panorama_revision_id;
  if (!revisionId) throw new Error("space has no active panorama revision yet");
  const revision = db.prepare(`SELECT * FROM panorama_revisions WHERE id=? AND space_id=?
    AND ready_at IS NOT NULL AND activated_at IS NOT NULL AND retired_at IS NULL`).get(revisionId, spaceId);
  if (!revision) throw new Error("active panorama revision is not ready");
  const scene = db.prepare("SELECT * FROM scenes WHERE space_id=?").get(spaceId);
  if (!scene) throw new Error("scene not found for space");

  const assetId = id("asset");
  const objectKey = `private/${spaceId}/depth/${revisionId}/${assetId}`;
  const digest = createHash("sha256").update(pngBytes).digest("hex");
  await mediaStore.putIfAbsent(objectKey, pngBytes, { contentType: "image/png" });

  const now = nowIso();
  const artifactId = id("depth_artifact");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT INTO assets(
        id,space_id,kind,private_object_key,raw_sha256,observed_bytes,observed_mime,width,height,validation_state,version
      ) VALUES(?,?,'depth_map',?,?,?,?,?,?,'valid',1)`)
      .run(assetId, spaceId, objectKey, digest, pngBytes.length, "image/png", pngDims.width, pngDims.height);
    db.prepare(`INSERT INTO scene_depth_artifacts(
        id,space_id,scene_id,panorama_revision_id,depth_asset_id,artifact_id,
        near_meters,far_meters,valid_fraction,safety_envelope_json,created_at,updated_at,version
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1)
      ON CONFLICT(space_id,panorama_revision_id) DO UPDATE SET
        depth_asset_id=excluded.depth_asset_id, artifact_id=excluded.artifact_id,
        near_meters=excluded.near_meters, far_meters=excluded.far_meters, valid_fraction=excluded.valid_fraction,
        safety_envelope_json=excluded.safety_envelope_json, updated_at=excluded.updated_at, version=version+1`)
      .run(id("scene_depth"), spaceId, scene.id, revisionId, assetId, artifactId,
        meta.nearMeters, meta.farMeters, meta.quality?.validFraction ?? 1, JSON.stringify(meta.safetyEnvelope), now, now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return { status: "attached", spaceId, panoramaRevisionId: revisionId,
    depthAssetId: assetId, artifactId, sha256: digest, width: pngDims.width, height: pngDims.height };
}

async function runCli() {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(moduleDir, "../../..");
  const fail = (message) => { console.error(`attach-depth-artifact: ${message}`); process.exit(1); };

  const [, , spaceId, pngPath, artifactJsonPath, ...rest] = process.argv;
  if (!spaceId || !pngPath || !artifactJsonPath) {
    fail("usage: attach-depth-artifact.mjs <spaceId> <depth.png> <artifact.json> [--data-dir <dir>]");
  }
  const dataDirFlagIndex = rest.indexOf("--data-dir");
  const dataDir = dataDirFlagIndex !== -1 && rest[dataDirFlagIndex + 1]
    ? path.resolve(rest[dataDirFlagIndex + 1])
    : path.resolve(process.env.UNSEEN_LOCAL_DATA_DIR ?? path.join(repoRoot, ".unseen-local-operable"));

  if (!existsSync(pngPath)) fail(`depth PNG not found: ${pngPath}`);
  if (!existsSync(artifactJsonPath)) fail(`artifact JSON not found: ${artifactJsonPath}`);
  const pngBytes = readFileSync(pngPath);
  const meta = JSON.parse(readFileSync(artifactJsonPath, "utf8"));

  const databasePath = path.join(dataDir, "unseen.sqlite");
  if (!existsSync(databasePath)) {
    fail(`no local-operable database at ${databasePath} — start local-operable at least once first ` +
      "(it creates the space's scene/panorama rows this script attaches to)");
  }
  const db = openDatabase(databasePath);
  const mediaStore = new FilesystemMediaStore(path.join(dataDir, "media"));
  try {
    const result = await attachDepthArtifact(db, mediaStore, { spaceId, pngBytes, meta });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    fail(error.message);
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  runCli();
}
