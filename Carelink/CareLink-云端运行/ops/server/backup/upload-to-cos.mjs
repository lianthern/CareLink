#!/usr/bin/env node
// Upload every file in a backup.sh output directory to Tencent Cloud COS (Cloud Object Storage),
// RECURSIVELY — backup.sh's media/ is a real directory tree (hard-linked against the live media
// dir, not a tar — see the comment above sync_media() in backup.sh), so this walks subdirectories
// too and preserves each file's path relative to the run directory as its object key (e.g. a file
// at "<run_dir>/media/<x>.media" uploads as "<prefix>/<run_label>/media/<x>.media"), so the COS
// layout mirrors the backup directory and a restore can reconstruct it as-is. Uses COS's own
// object-API request signature ("签名方法 v5": HMAC-SHA1, described at
// https://cloud.tencent.com/document/product/436/7778) implemented directly against node:crypto
// and the global fetch — no cos-nodejs-sdk-v5, no coscmd, no new dependency at all, since Node is
// already this server's mandatory runtime.
//
// This is a DIFFERENT algorithm from the TC3-HMAC-SHA256 signer already in this repo
// (services/api/src/ports/otp/tencent-ses-api-otp-delivery-port.mjs) — that one talks to the
// unified "tencentcloudapi.com" control-plane API (used for SES), while COS's own data-plane
// object API (PUT/GET on <bucket>.cos.<region>.myqcloud.com) still uses the older v5 scheme.
// Both are genuine, currently-documented Tencent Cloud signing methods; this file only
// implements the one COS's object API actually requires.
//
// Credentials are read from environment variables (never from argv, so they never appear in
// `ps`): UNSEEN_BACKUP_COS_SECRET_ID, UNSEEN_BACKUP_COS_SECRET_KEY, UNSEEN_BACKUP_COS_BUCKET
// (the full bucket name INCLUDING the trailing -<APPID> that the Tencent console appends),
// UNSEEN_BACKUP_COS_REGION (e.g. ap-hongkong), UNSEEN_BACKUP_COS_PREFIX (optional key prefix,
// default "unseen"). The upload-to-cos.sh wrapper is what actually loads these from the
// root-only env file — this script just reads process.env.
//
// Usage:
//   node upload-to-cos.mjs <backup_dir>          # upload every file in <backup_dir>
//   node upload-to-cos.mjs --selftest            # print the signing algorithm's intermediate
//                                                 # values for a fixed synthetic key, so the
//                                                 # implementation can be read/reviewed without
//                                                 # needing real COS credentials or network
//                                                 # access. Does not touch the network.
//
// KNOWN LIMITATION (see the report handed back alongside this script): this signer has been
// exercised against the documented algorithm shape and cross-checked for internal determinism,
// but NOT against a live COS bucket — nobody building it had COS credentials or server access.
// Before wiring this into the daily timer, run it once by hand against a real (even empty test)
// bucket and confirm the upload succeeds; a signature mismatch surfaces as an HTTP 403 with a
// `<Code>SignatureDoesNotMatch</Code>` (or similar) XML body, which this script prints verbatim
// on failure so it's diagnosable rather than a bare "failed".
import { createHash, createHmac } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

const ALGORITHM = "sha1";

function sha1Hex(value) {
  return createHash("sha1").update(value).digest("hex");
}

function hmacSha1Hex(key, value) {
  return createHmac("sha1", key).update(value).digest("hex");
}

// COS's own flavor of URI-encoding: percent-encode everything encodeURIComponent would, plus the
// handful of characters it deliberately leaves alone that COS still wants escaped, and uppercase
// hex digits per the spec's convention. Callers are expected to pass one path SEGMENT at a time
// so '/' is never in scope here (see objectKeyPath below).
function cosUriEncode(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function objectKeyPath(key) {
  // key must not start with '/'; the wire path always does.
  return "/" + key.split("/").map(cosUriEncode).join("/");
}

// Builds the COS v5 Authorization header for one request. `headersToSign` is a plain object of
// lowercase header-name -> raw value; only 'host' is used by this script (the minimal, widely
// documented working recipe — see the README pointer in the report for why more isn't needed for
// a plain PUT with no query parameters).
export function signRequest({ secretId, secretKey, method, path, headersToSign, now = Date.now() }) {
  const nowSec = Math.floor(now / 1000);
  // Small negative skew tolerance + a generous validity window: this is a signature for one
  // specific upload attempt, not a long-lived credential, so a wide window just avoids spurious
  // clock-skew failures rather than weakening anything meaningful.
  const keyTimeStart = nowSec - 60;
  const keyTimeEnd = nowSec + 1800;
  const signTime = `${keyTimeStart};${keyTimeEnd}`;
  const keyTime = signTime;

  const signKey = hmacSha1Hex(secretKey, keyTime);

  const sortedHeaderNames = Object.keys(headersToSign).sort();
  const headerString = sortedHeaderNames
    .map((name) => `${name.toLowerCase()}=${cosUriEncode(String(headersToSign[name]))}`)
    .join("&");
  const headerList = sortedHeaderNames.join(";");

  const httpString = `${method.toLowerCase()}\n${path}\n\n${headerString}\n`;
  const httpStringSha1 = sha1Hex(httpString);
  const stringToSign = `${ALGORITHM}\n${signTime}\n${httpStringSha1}\n`;
  const signature = hmacSha1Hex(signKey, stringToSign);

  const authorization = [
    `q-sign-algorithm=${ALGORITHM}`,
    `q-ak=${secretId}`,
    `q-sign-time=${signTime}`,
    `q-key-time=${keyTime}`,
    `q-header-list=${headerList}`,
    `q-url-param-list=`,
    `q-signature=${signature}`
  ].join("&");

  return { authorization, signTime, keyTime, httpString, httpStringSha1, stringToSign, signature };
}

// Recursively lists every regular file under `root`, returning paths relative to `root` using
// forward slashes (COS object keys are always "/"-separated regardless of host OS — this script
// only ever runs on Linux in production, but keep the join explicit rather than relying on
// node:path's OS-dependent separator). Sorted for deterministic upload order and stable logs.
//
// Symlinks and other non-regular entries are not something backup.sh ever produces under a run
// directory, but if one shows up anyway this does not silently drop it: it's reported as a
// warning and counted as a failure (see main()) rather than just vanishing from the upload set —
// the whole point of this change is "no more silent gaps".
async function listFilesRecursive(root, relDir = "") {
  const absDir = relDir ? join(root, relDir) : root;
  const dirents = await readdir(absDir, { withFileTypes: true });
  dirents.sort((a, b) => a.name.localeCompare(b.name));

  const files = [];
  const skipped = [];
  for (const d of dirents) {
    const rel = relDir ? `${relDir}/${d.name}` : d.name;
    if (d.isDirectory()) {
      const nested = await listFilesRecursive(root, rel);
      files.push(...nested.files);
      skipped.push(...nested.skipped);
    } else if (d.isFile()) {
      files.push(rel);
    } else {
      skipped.push(rel);
    }
  }
  return { files, skipped };
}

function configFromEnv(env = process.env) {
  const secretId = env.UNSEEN_BACKUP_COS_SECRET_ID;
  const secretKey = env.UNSEEN_BACKUP_COS_SECRET_KEY;
  const bucket = env.UNSEEN_BACKUP_COS_BUCKET;
  const region = env.UNSEEN_BACKUP_COS_REGION;
  const prefix = env.UNSEEN_BACKUP_COS_PREFIX ?? "unseen";
  const missing = [];
  if (!secretId) missing.push("UNSEEN_BACKUP_COS_SECRET_ID");
  if (!secretKey) missing.push("UNSEEN_BACKUP_COS_SECRET_KEY");
  if (!bucket) missing.push("UNSEEN_BACKUP_COS_BUCKET");
  if (!region) missing.push("UNSEEN_BACKUP_COS_REGION");
  if (missing.length > 0) {
    throw new Error(`missing required environment variable(s): ${missing.join(", ")}`);
  }
  const host = `${bucket}.cos.${region}.myqcloud.com`;
  return { secretId, secretKey, bucket, region, prefix, host };
}

async function uploadFile({ config, localPath, key }) {
  const body = await readFile(localPath);
  const path = objectKeyPath(key);
  const { authorization } = signRequest({
    secretId: config.secretId,
    secretKey: config.secretKey,
    method: "PUT",
    path,
    headersToSign: { host: config.host }
  });
  const url = `https://${config.host}${path}`;
  const localMd5 = createHash("md5").update(body).digest("hex");

  let response;
  try {
    response = await fetch(url, {
      method: "PUT",
      headers: { host: config.host, authorization, "content-length": String(body.length) },
      body
    });
  } catch (error) {
    throw new Error(`network error uploading ${key}: ${error?.message ?? error}`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "(could not read response body)");
    throw new Error(`COS rejected upload of ${key}: HTTP ${response.status}\n${text}`);
  }

  const etag = (response.headers.get("etag") ?? "").replace(/"/g, "");
  if (etag && etag.toLowerCase() !== localMd5.toLowerCase()) {
    // COS returns the MD5 of the object body as its ETag for a plain (non-multipart) PUT. A
    // mismatch here means the bytes that landed in the bucket are not the bytes we sent, even
    // though the HTTP call itself reported success — worth failing loudly on.
    throw new Error(
      `${key}: uploaded but ETag ${etag} does not match local MD5 ${localMd5} — possible corruption in transit`
    );
  }
  return { key, bytes: body.length, etag };
}

async function main(argv) {
  if (argv.includes("--selftest")) {
    const result = signRequest({
      secretId: "AKIDexampleexampleexampleexample",
      secretKey: "exampleexampleexampleexamplekey",
      method: "PUT",
      path: "/unseen/20260817T031500Z/unseen.sqlite",
      headersToSign: { host: "example-1250000000.cos.ap-hongkong.myqcloud.com" },
      now: Date.parse("2026-08-17T03:15:00Z")
    });
    console.log("upload-to-cos.mjs --selftest: signing algorithm intermediate values");
    console.log("(fixed synthetic key/time, no network — for manual review against the COS v5 spec)");
    for (const [k, v] of Object.entries(result)) console.log(`  ${k}: ${v}`);
    // Determinism check: same inputs must produce the same signature every time.
    const again = signRequest({
      secretId: "AKIDexampleexampleexampleexample",
      secretKey: "exampleexampleexampleexamplekey",
      method: "PUT",
      path: "/unseen/20260817T031500Z/unseen.sqlite",
      headersToSign: { host: "example-1250000000.cos.ap-hongkong.myqcloud.com" },
      now: Date.parse("2026-08-17T03:15:00Z")
    });
    if (again.signature !== result.signature) {
      console.error("SELFTEST FAILED: signature is not deterministic for identical inputs");
      process.exitCode = 1;
      return;
    }
    console.log("selftest OK: signature is deterministic for identical inputs");
    return;
  }

  const backupDir = argv.find((a) => !a.startsWith("-"));
  if (!backupDir) {
    console.error("usage: upload-to-cos.mjs <backup_dir> | --selftest");
    process.exitCode = 1;
    return;
  }

  const config = configFromEnv();
  const runLabel = basename(backupDir);
  const { files: entries, skipped } = await listFilesRecursive(backupDir);

  if (entries.length === 0) {
    console.error(`upload-to-cos.mjs: no files found in ${backupDir}`);
    process.exitCode = 1;
    return;
  }

  console.log(`upload-to-cos.mjs: uploading ${entries.length} file(s) (recursively, including ` +
    `subdirectories like media/) from ${backupDir} to https://${config.host}/${config.prefix}/${runLabel}/`);

  let okCount = 0;
  let failCount = 0;
  let totalBytes = 0;
  const started = Date.now();
  for (const rel of entries) {
    const localPath = join(backupDir, rel);
    const st = await stat(localPath);
    const key = `${config.prefix}/${runLabel}/${rel}`;
    try {
      const result = await uploadFile({ config, localPath, key });
      okCount += 1;
      totalBytes += st.size;
      console.log(`  OK   ${rel} (${result.bytes} bytes, etag ${result.etag})`);
    } catch (error) {
      failCount += 1;
      console.error(`  FAIL ${rel}: ${error?.message ?? error}`);
    }
  }

  for (const rel of skipped) {
    failCount += 1;
    console.error(`  FAIL ${rel}: not a regular file or directory (symlink/device/socket/etc) — ` +
      `refusing to silently drop it from the backup upload`);
  }

  const elapsedMs = Date.now() - started;
  console.log(
    `upload-to-cos.mjs: done in ${elapsedMs}ms — ${okCount} uploaded, ${failCount} failed, ` +
    `${totalBytes} bytes`
  );
  if (failCount > 0) process.exitCode = 1;
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`upload-to-cos.mjs: fatal: ${error?.message ?? error}`);
  process.exitCode = 1;
});
