// services/locator/tools/verify-against-ai-template-space.mjs
//
// 手动验证脚本（不属于 npm test，需要真实 CLIP 权重 + sidecar venv，不在 CI 里跑）：
// 起一个临时的 local-operable(UNSEEN_LOCATOR_MODE=clip)，走真实 HTTP 流程建空间、传全景、
// 传"夏日聚会"场内照片 + 若干外来照片，最后直接读 sqlite 落地的 yaw/confidence/margin，
// 打一张验证小表。不依赖 headless Chrome —— cookie 手动管理，HTTP 调用序列照抄
// tests/e2e/local-operable.e2e.mjs 的 browserRequest 那一套（含 origin/sec-fetch-site
// 头，和 local-operable.mjs 里 adaptIncomingRequest 的 If-Match token 约定）。
//
// 跑法（先确保 services/locator/sidecar/.venv 已装好、模型已下载到
// ~/code/unseen-assets/models）：
//   node services/locator/tools/verify-against-ai-template-space.mjs
//
// 素材目录可以用 --assets-dir 覆盖，默认指向本次移植用的"夏日聚会"AI 模板素材
// (全景 panorama-2x1.jpg + photo1_cheers.jpg..photo6_dancing.jpg)。外来/无关照片固定用
// apps/web/assets/photos/photo-{1,2,3}.jpg（仓库自带的 fixture 占位图，风格和这个空间无关，
// 免得脚本还要再依赖一份额外素材）。
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const argvFlag = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const assetsDir = argvFlag("--assets-dir", path.join(homedir(), "code/unseen-assets/ai-template-space"));
const sha256 = (v) => createHash("sha256").update(v).digest("hex");

function cookieJar() {
  const jar = new Map();
  return {
    capture(response) {
      for (const raw of response.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(";");
        const eq = pair.indexOf("=");
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
    header() { return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; "); }
  };
}

function client(baseUrl) {
  const jar = cookieJar();
  return async function request(method, pathname, body, headers = {}) {
    const mutation = !["GET", "HEAD"].includes(method);
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: { accept: "application/json", cookie: jar.header(),
        ...(mutation ? { "content-type": "application/json", "idempotency-key": randomUUID(), origin: baseUrl,
          "sec-fetch-site": "same-origin" } : {}), ...headers },
      body: mutation ? JSON.stringify(body ?? {}) : undefined
    });
    jar.capture(response);
    const text = await response.text();
    const value = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(`request_failed:${method}:${pathname}:${response.status}:${JSON.stringify(value)}`);
    return { value, etag: response.headers.get("etag") };
  };
}

async function uploadAsset(baseUrl, ticket, bytes) {
  const url = new URL(ticket.url, baseUrl);
  const response = await fetch(url, { method: "PUT", headers: ticket.headers, body: bytes });
  if (!response.ok) throw new Error(`asset_upload_failed:${response.status}:${await response.text()}`);
}

async function waitOtp(mailboxPath, challengeId, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const value = JSON.parse(await readFile(mailboxPath, "utf8"));
      if (value.challengeId === challengeId && /^\d{6}$/.test(value.code)) return value.code;
    } catch { /* mailbox not written yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("otp_timeout");
}

async function poll(run, timeoutMs = 30_000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await run();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`poll_timeout:${JSON.stringify(last)}`);
}

async function main() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "unseen-clip-verify-"));
  const port = 4199;
  const baseUrl = `http://127.0.0.1:${port}`;

  const child = spawn(process.execPath, ["infra/integration/local-operable.mjs"], {
    cwd: repositoryRoot,
    env: { ...process.env, UNSEEN_LOCATOR_MODE: "clip", UNSEEN_LOCAL_DATA_DIR: dataDir,
      UNSEEN_LOCAL_EVIDENCE_DIR: path.join(dataDir, "evidence"), UNSEEN_LOCAL_PORT: String(port),
      UNSEEN_LOCAL_PUBLIC_ORIGIN: baseUrl, UNSEEN_CLIP_SIDECAR_PORT: "8793" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let ready = false;
  let bootLog = "";
  child.stdout.on("data", (chunk) => { bootLog += chunk.toString(); if (chunk.toString().includes("LOCAL_OPERABLE_READY")) ready = true; });
  let errLog = "";
  child.stderr.on("data", (chunk) => { errLog += chunk.toString(); process.stderr.write(chunk); });

  try {
    const started = Date.now();
    while (!ready && Date.now() - started < 60_000) await new Promise((r) => setTimeout(r, 200));
    if (!ready) throw new Error(`local_operable_boot_timeout. stdout=${bootLog} stderr=${errLog}`);
    console.log(`== local-operable ready in ${Date.now() - started}ms (UNSEEN_LOCATOR_MODE=clip) ==`);

    const owner = client(baseUrl);
    const otpMailboxPath = path.join(dataDir, ".otp-mailbox.json");
    const challenge = (await owner("POST", "/v1/auth/email-otp-challenges",
      { email: "clip-verify-owner@example.test", purpose: "login", locale: "zh-CN" })).value;
    const code = await waitOtp(otpMailboxPath, challenge.challengeId);
    const session = (await owner("POST", "/v1/auth/email-otp-verifications",
      { challengeId: challenge.challengeId, otp: code, purpose: "login" })).value;
    console.log("owner login ok:", session.accountId);

    const space = (await owner("POST", "/v1/spaces", { name: "夏日聚会验证" })).value;
    await owner("POST", `/v1/spaces/${space.spaceId}/collection-transitions`, { to: "open" }, { "if-match": '"space:1"' });
    await owner("POST", `/v1/spaces/${space.spaceId}/sharing-transitions`, { to: "shared" }, { "if-match": '"space:2"' });

    const panoramaBytes = await readFile(path.join(assetsDir, "panorama-2x1.jpg"));
    const panorama = (await owner("POST", `/v1/spaces/${space.spaceId}/panorama-candidates`, {
      declaredMime: "image/jpeg", declaredBytes: panoramaBytes.length, clientAssetId: "verify-panorama",
      noticeAcknowledgement: { purpose: "panorama_upload", version: 1, contentHash: "local-panorama_upload-v1" }
    }, { "if-match": '"space:3"' })).value;
    await uploadAsset(baseUrl, panorama.exactPrivateUploadTicketOnce, panoramaBytes);
    await owner("POST", `/v1/panorama-upload-sessions/${panorama.uploadSessionId}/commits`,
      { clientRequestId: "verify-panorama-commit" }, { "if-match": panorama.uploadSessionIfMatch });
    const readyPanorama = await poll(async () => {
      const v = (await owner("GET", `/v1/spaces/${space.spaceId}/panorama-candidates/${panorama.candidateId}`)).value;
      return v.status === "ready" ? v : null;
    });
    await owner("POST", `/v1/spaces/${space.spaceId}/panorama-switches`,
      { mode: "switch", candidateRevisionId: readyPanorama.panoramaRevisionId, sceneIfMatchVersion: 1 },
      { "if-match": '"space:3"' });
    console.log("panorama ready + switched:", readyPanorama.panoramaRevisionId);

    const campaign = (await owner("POST", `/v1/spaces/${space.spaceId}/external-invitation-campaigns`, {
      taskMode: "combo", entryTask: "view", expiresAt: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
      maxSuccessfulUses: 100
    }, { "if-match": '"space:4"' })).value;

    const participant = client(baseUrl);
    const publicCampaignId = campaign.publicCampaignUrl.split("/").at(-1);
    const nonce = `verify-${randomUUID()}`;
    await participant("POST", "/v1/external-campaign-admission-challenges", { publicCampaignId, clientNonce: nonce });
    const admission = (await participant("POST", "/v1/external-campaign-admissions", { publicCampaignId, clientNonce: nonce })).value;
    const inviteSecret = new URL(admission.bootstrapUrl, baseUrl).hash.replace(/^#invite=/, "");
    await participant("POST", "/v1/external-invitation-exchanges",
      { secretFromClearedInviteBootstrap: inviteSecret, clientNonce: nonce });
    const uploadContext = (await participant("GET", `/v1/spaces/${space.spaceId}/upload-context`)).value;
    const consent = (await participant("POST", "/v1/consent-events", {
      purpose: "photo_upload", noticeVersion: uploadContext.mediaNotice.version, noticeHash: uploadContext.mediaNotice.hash
    })).value;

    // 场内：夏日聚会全景 + 6 张同场景照片。外来：仓库自带的 fixture 占位图，风格/场景与这个空间无关。
    const inSceneFiles = ["photo1_cheers.jpg", "photo2_cake.jpg", "photo3_group_back.jpg",
      "photo4_table_detail.jpg", "photo5_laughing.jpg", "photo6_dancing.jpg"].map((name) => ({ name, dir: assetsDir, kind: "in_scene" }));
    const foreignFiles = ["photo-1.jpg", "photo-2.jpg", "photo-3.jpg"].map((name) => ({
      name, dir: path.join(repositoryRoot, "apps/web/assets/photos"), kind: "foreign"
    }));
    const allFiles = [...inSceneFiles, ...foreignFiles];

    const batch = (await participant("POST", `/v1/spaces/${space.spaceId}/contribution-batches`, {
      clientBatchId: `verify-${randomUUID()}`, consentEventId: consent.consentEventId, declaredItemCount: allFiles.length
    }, { "if-match": uploadContext.ifMatch })).value;

    const uploaded = [];
    for (const file of allFiles) {
      const bytes = await readFile(path.join(file.dir, file.name));
      const item = (await participant("POST", `/v1/contribution-batches/${batch.batchId}/items`, {
        clientItemId: `verify-${file.name}-${randomUUID()}`, declaredMime: "image/jpeg",
        declaredBytes: bytes.length, fileNameHash: sha256(file.name)
      }, { "if-match": batch.ifMatch })).value; // 这个端点忽略 supplied 版本，服务端自己重查最新的 batch/space version
      const authorization = (await participant("POST",
        `/v1/contribution-batches/${batch.batchId}/items/${item.itemId}/upload-sessions`, {
          declaredMime: "image/jpeg", declaredBytes: bytes.length, clientUploadId: `verify-up-${randomUUID()}`
        }, { "if-match": item.ifMatch })).value;
      await uploadAsset(baseUrl, authorization.oneTimeUploadTicket, bytes);
      const committed = (await participant("POST", `/v1/upload-sessions/${authorization.uploadSessionId}/commits`,
        { clientCommitId: `verify-commit-${randomUUID()}` }, { "if-match": authorization.commitIfMatch })).value;
      uploaded.push({ ...file, itemId: item.itemId, photoId: committed.photoId });
      console.log(`uploaded ${file.name} (${file.kind}) -> photoId=${committed.photoId}`);
    }

    const batchResult = await poll(async () => {
      const v = (await participant("GET", `/v1/contribution-batches/${batch.batchId}/result`)).value;
      return v.items.length === allFiles.length &&
        v.items.every((i) => ["confirmed", "needs_confirmation", "failed"].includes(i.placementState)) ? v : null;
    }, 60_000);

    console.log("\n== 批次定位结果 ==");
    for (const item of batchResult.items) console.log(`  ${item.photoId}: placementState=${item.placementState}`);

    const db = new DatabaseSync(path.join(dataDir, "unseen.sqlite"), { readOnly: true });
    console.log("\n== 详细分数表（yaw / confidence / margin，来自 locatorProvenance）==");
    const rows = [];
    for (const file of uploaded) {
      const revision = db.prepare(`SELECT yaw, placement_state FROM placement_revisions
        WHERE photo_id=? ORDER BY seq DESC LIMIT 1`).get(file.photoId);
      const jobRow = db.prepare(`SELECT result_json FROM jobs WHERE type='photo_placement'
        AND json_extract(input_refs_json,'$.photoId')=? ORDER BY rowid DESC LIMIT 1`).get(file.photoId);
      const result = jobRow ? JSON.parse(jobRow.result_json) : null;
      const provenance = result?.locatorProvenance ?? {};
      rows.push({ name: file.name, kind: file.kind, placementState: revision?.placement_state ?? result?.placementState ?? "(none)",
        yaw: revision?.yaw ?? null, confidence: provenance.confidence ?? null, margin: provenance.margin ?? null });
    }
    for (const row of rows) {
      console.log(`  ${row.kind.padEnd(9)} ${row.name.padEnd(24)} state=${String(row.placementState).padEnd(18)} ` +
        `yaw=${row.yaw === null ? "  -  " : String(row.yaw).padStart(5)} conf=${row.confidence ?? "-"} margin=${row.margin ?? "-"}`);
    }
    db.close();
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => { child.once("exit", resolve); setTimeout(resolve, 5000); });
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
