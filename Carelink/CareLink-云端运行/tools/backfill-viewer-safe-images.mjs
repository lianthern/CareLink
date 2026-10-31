#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, transaction } from "../services/api/src/database.mjs";
import { createViewerSafeDerivative } from "../services/api/src/media.mjs";
import { FilesystemMediaStore } from "../services/api/src/ports/media/filesystem-media-store.mjs";
import { FfmpegDecoderRunner } from "../services/api/src/ports/media/ffmpeg-decoder-runner.mjs";
import { id } from "../services/api/src/util.mjs";

export async function backfillViewerSafeImages({ db, mediaStore, decoderRunner, spaceId }) {
  const rows = db.prepare(`SELECT p.id photo_id,p.viewer_safe_asset_id,a.* FROM photos p
    JOIN assets a ON a.id=p.viewer_safe_asset_id AND a.space_id=p.space_id
    WHERE p.space_id=? AND p.media_type='photo' AND p.deleted_at IS NULL
    ORDER BY p.id`).all(spaceId);
  const result = { spaceId, inspected: rows.length, replaced: 0, skipped: 0, bytesBefore: 0, bytesAfter: 0 };
  for (const row of rows) {
    if (row.observed_mime === "image/jpeg" && row.width <= 1920 && row.height <= 1920) {
      result.skipped += 1;
      continue;
    }
    const source = await mediaStore.get(row.private_object_key, { maxBytes: 20 * 1024 * 1024 });
    const derivative = await createViewerSafeDerivative(source.body, decoderRunner);
    const assetId = id("asset");
    const objectKey = `private/${row.space_id}/viewer-safe/${assetId}`;
    const stored = await mediaStore.putIfAbsent(objectKey, derivative.body,
      { contentType: derivative.mime, maxBytes: 4 * 1024 * 1024 });
    if (!stored.created || stored.bytes !== derivative.bytes || stored.etag !== derivative.sha256) {
      throw new Error(`failed to store replacement for ${row.photo_id}`);
    }
    try {
      transaction(db, () => {
        db.prepare(`INSERT INTO assets(
          id,space_id,kind,private_object_key,raw_sha256,observed_bytes,observed_mime,width,height,frame_count,
          orientation,color_profile,metadata_policy_result,validation_state,validation_code,version,duration_ms
        ) VALUES(?,?,?,?,?,?,?,?,?,1,0,'unspecified','exif_gps_stripped','valid',NULL,1,NULL)`)
          .run(assetId, row.space_id, "photo_viewer_safe", objectKey, derivative.sha256, derivative.bytes,
            derivative.mime, derivative.width, derivative.height);
        const updated = db.prepare(`UPDATE photos SET viewer_safe_asset_id=?,version=version+1
          WHERE id=? AND viewer_safe_asset_id=?`).run(assetId, row.photo_id, row.viewer_safe_asset_id);
        if (updated.changes !== 1) throw new Error(`photo changed during backfill: ${row.photo_id}`);
      });
    } catch (error) {
      await mediaStore.delete(objectKey).catch(() => {});
      throw error;
    }
    result.replaced += 1;
    result.bytesBefore += row.observed_bytes;
    result.bytesAfter += derivative.bytes;
  }
  return result;
}

function flagValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? "" : args[index + 1] || "";
}

async function runCli() {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(moduleDir, "..");
  const dataDir = path.resolve(flagValue(process.argv, "--data-dir") ||
    process.env.UNSEEN_LOCAL_DATA_DIR || path.join(repoRoot, ".unseen-local-operable"));
  const spaceId = flagValue(process.argv, "--space-id");
  if (!spaceId) throw new Error("usage: node tools/backfill-viewer-safe-images.mjs --space-id <id> [--data-dir <dir>]");
  const databasePath = path.join(dataDir, "unseen.sqlite");
  if (!existsSync(databasePath)) throw new Error(`database not found: ${databasePath}`);
  const db = openDatabase(databasePath);
  try {
    const result = await backfillViewerSafeImages({ db, spaceId,
      mediaStore: new FilesystemMediaStore(path.join(dataDir, "media")),
      decoderRunner: new FfmpegDecoderRunner() });
    console.log(JSON.stringify(result, null, 2));
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  runCli().catch((error) => { console.error(`backfill-viewer-safe-images: ${error.message}`); process.exit(1); });
}
