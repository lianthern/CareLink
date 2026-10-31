import { randomUUID } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync,
  writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LocalApi } from "../../../services/api/src/api.mjs";
import { loadLocalKeyring } from "../../../services/api/src/crypto.mjs";
import { createLocalHttpServer, listenLocalHttpServer } from "../../../services/api/src/http-server.mjs";
import { DEFAULT_OTP_DELIVERY_LEASE_MS } from "../../../services/api/src/otp-delivery-outbox.mjs";
import { FilesystemMediaStore } from "../../../services/api/src/ports/media/filesystem-media-store.mjs";
import { SMTP_DELIVERY_LEASE_GRACE_MS, smtpOtpDeliveryFromEnv } from
  "../../../services/api/src/ports/otp/smtp-otp-delivery-port.mjs";
import { createBookLabSameOriginServer, listenBookLabSameOriginServer } from "./same-origin-server.mjs";
import { createPrivateAiComposition } from "./private-ai-composition.mjs";

function absolute(value, code) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(code);
  return path.normalize(value);
}

function configuration(env) {
  const host = env.UNSEEN_API_HOST ?? "127.0.0.1";
  const port = Number(env.UNSEEN_API_PORT ?? 8787);
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host) || host.split(".").some((part) => Number(part) > 255) ||
    !Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("book_lab_deployment_listener_invalid");
  }
  let publicOrigin = null;
  try { if (env.UNSEEN_PUBLIC_ORIGIN !== undefined) publicOrigin = new URL(env.UNSEEN_PUBLIC_ORIGIN); }
  catch { throw new Error("book_lab_public_origin_invalid"); }
  if (publicOrigin && (!new Set(["http:", "https:"]).has(publicOrigin.protocol) || publicOrigin.username ||
    publicOrigin.password || publicOrigin.pathname !== "/" || publicOrigin.search || publicOrigin.hash)) {
    throw new Error("book_lab_public_origin_invalid");
  }
  if (!publicOrigin && host !== "127.0.0.1") throw new Error("book_lab_public_origin_required");
  const enabled = env.UNSEEN_BOOK_LAB_ENABLED === "true";
  const privateAiEnabled = env.UNSEEN_PRIVATE_AI_WORKER_ENABLED === "true";
  if (privateAiEnabled && !enabled) throw new Error("private_ai_book_lab_required");
  const config = {
    host, port, enabled, privateAiEnabled, publicOrigin: publicOrigin?.origin ?? null,
    database: absolute(env.UNSEEN_API_DB, "book_lab_core_database_invalid"),
    keyset: absolute(env.UNSEEN_API_KEYSET, "book_lab_core_keyset_invalid"),
    mediaRoot: absolute(env.UNSEEN_API_MEDIA_ROOT, "book_lab_core_media_root_invalid"),
    lock: absolute(env.UNSEEN_BOOK_LAB_LOCK, "book_lab_operation_lock_invalid"),
    privateAi: privateAiEnabled ? Object.freeze({
      tokenHashFile: absolute(env.UNSEEN_PRIVATE_AI_WORKER_TOKEN_HASH_FILE,
        "private_ai_worker_token_hash_file_invalid"),
      promptHash: env.UNSEEN_PRIVATE_AI_PROMPT_HASH,
      policyHash: env.UNSEEN_PRIVATE_AI_POLICY_HASH,
      model: env.UNSEEN_PRIVATE_AI_MODEL,
      modelVersion: env.UNSEEN_PRIVATE_AI_MODEL_VERSION
    }) : undefined
  };
  if (enabled) {
    const bookDatabase = absolute(env.UNSEEN_BOOK_LAB_DB, "book_lab_database_invalid");
    const renderTemporaryRoot = absolute(env.UNSEEN_BOOK_LAB_RENDER_TMP, "book_lab_render_tmp_invalid");
    const chromiumPath = absolute(env.UNSEEN_CHROMIUM_PATH, "book_lab_chromium_path_invalid");
    try { accessSync(chromiumPath, constants.X_OK); }
    catch { throw new Error("book_lab_chromium_unavailable"); }
    if (new Set([config.database, config.keyset, config.mediaRoot, config.lock, bookDatabase,
      renderTemporaryRoot, chromiumPath]).size !== 7) throw new Error("book_lab_deployment_paths_overlap");
  }
  return Object.freeze(config);
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}

function operationLock(file) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const record = `${JSON.stringify({ schema: "unseen-book-deployment-lock/1", pid: process.pid, token })}\n`;
  let descriptor;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let stale;
      try { stale = JSON.parse(readFileSync(file, "utf8")); } catch { throw new Error("book_lab_operation_locked"); }
      if (stale?.schema !== "unseen-book-deployment-lock/1" || !Number.isSafeInteger(stale.pid) ||
        typeof stale.token !== "string" || processAlive(stale.pid)) throw new Error("book_lab_operation_locked");
      unlinkSync(file);
    }
  }
  if (descriptor === undefined) throw new Error("book_lab_operation_locked");
  try {
    writeFileSync(descriptor, record);
    fsyncSync(descriptor);
  } catch (error) {
    closeSync(descriptor);
    try { unlinkSync(file); } catch {}
    throw error;
  }
  closeSync(descriptor);
  return () => {
    try {
      if (readFileSync(file, "utf8") === record) unlinkSync(file);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  };
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

export async function createBookLabDeployment({ env = process.env, smtpOptions = {} } = {}) {
  const config = configuration(env);
  const releaseLock = operationLock(config.lock);
  const closeOrder = [];
  let api;
  let bookRuntime;
  let publicServer;
  let coreServer;
  let otpTimer;
  let privateAiComposition;
  let closePromise;
  const close = () => closePromise ??= (async () => {
    const failures = [];
    for (const [name, action] of [
      ["public-listener", () => closeServer(publicServer)],
      ["core-listener", () => closeServer(coreServer)],
      ["otp-timer", () => { if (otpTimer) clearInterval(otpTimer); }],
      ...(privateAiComposition ? [["private-ai-composition", () => privateAiComposition.close()]] : []),
      ["book-runtime", () => bookRuntime?.close()],
      ["core-runtime", () => api?.close()],
      ["operation-lock", releaseLock]
    ]) {
      try { await action(); closeOrder.push(name); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "book_lab_deployment_close_failed");
  })();
  try {
    for (const directory of [path.dirname(config.database), path.dirname(config.keyset), config.mediaRoot]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    const keyring = loadLocalKeyring(config.keyset, { allowCreate: !existsSync(config.database) });
    const mediaStore = new FilesystemMediaStore(config.mediaRoot);
    const otpDelivery = smtpOtpDeliveryFromEnv(env, smtpOptions);
    if (otpDelivery && otpDelivery.deliveryTimeoutMs + SMTP_DELIVERY_LEASE_GRACE_MS >=
      DEFAULT_OTP_DELIVERY_LEASE_MS) throw new Error("smtp_delivery_lease_invariant_invalid");
    const extensionModuleLoader = config.enabled ? async () => {
      const module = await import("../../../services/api/src/extensions/book-lab.mjs");
      return { registerBookLabExtension(input) {
        bookRuntime = module.registerBookLabExtension(input, { env });
        return bookRuntime;
      } };
    } : undefined;
    api = new LocalApi({ database: config.database, keyring, mediaStore, otpDelivery,
      worldResults: { signingKey: env.WORLD_RESULT_SIGNING_KEY },
      publicOrigin: config.publicOrigin ?? "http://127.0.0.1:1", featureFlags: { bookLab: config.enabled,
        privateAiWorker: config.privateAiEnabled }, privateAi: config.privateAi,
      // /healthz's CLIP sidecar probe (see services/api/src/health-checks.mjs): off unless this
      // production process is actually configured to talk to one via UNSEEN_LOCATOR_MODE=clip --
      // same opt-in flag infra/integration/local-operable.mjs already uses. dataDir is left to its
      // default (the directory holding config.database, i.e. the real production data disk).
      health: { cacheTtlMs: env.UNSEEN_HEALTHZ_CACHE_TTL_MS === undefined ?
          undefined : Number(env.UNSEEN_HEALTHZ_CACHE_TTL_MS),
        clipSidecar: { enabled: env.UNSEEN_LOCATOR_MODE === "clip",
          baseUrl: env.UNSEEN_CLIP_SIDECAR_URL ?? "http://127.0.0.1:8791",
          timeoutMs: Number(env.UNSEEN_CLIP_SIDECAR_HEALTHZ_TIMEOUT_MS ?? 1500) } },
      extensionModuleLoader });
    await api.ready;
    if (config.enabled && (!bookRuntime || typeof bookRuntime.close !== "function")) {
      throw new Error("book_lab_runtime_capture_failed");
    }
    await api.dispatchOtpDeliveries();
    otpTimer = setInterval(() => { void api.dispatchOtpDeliveries().catch(() => {}); }, 5_000);
    otpTimer.unref();
    if (config.privateAiEnabled) {
      privateAiComposition = createPrivateAiComposition({ api, bookRuntime });
      await privateAiComposition.runOnce();
      privateAiComposition.start();
    }

    let listening;
    if (config.enabled) {
      coreServer = createLocalHttpServer({ api });
      const core = await listenLocalHttpServer(coreServer, { host: "127.0.0.1", port: 0 });
      publicServer = createBookLabSameOriginServer({ api, runtime: bookRuntime,
        publicOrigin: config.publicOrigin, coreOrigin: core.origin });
      listening = await listenBookLabSameOriginServer(publicServer, { host: config.host, port: config.port });
    } else {
      publicServer = createLocalHttpServer({ api });
      listening = await listenLocalHttpServer(publicServer, { host: config.host, port: config.port });
    }
    const origin = config.publicOrigin ?? listening.origin;
    api.campaigns.publicOrigin = origin;
    return Object.freeze({ api, bookRuntime, server: publicServer, origin, close, closeOrder,
      status: Object.freeze({ enabled: config.enabled, coreStore: true, bookStore: config.enabled,
        runtimeCaptured: Boolean(bookRuntime), operationLock: true,
        privateAiWorker: config.privateAiEnabled }) });
  } catch (error) {
    try { await close(); } catch (closeError) { throw new AggregateError([error, closeError], "book_lab_start_failed"); }
    throw error;
  }
}

async function main() {
  const deployment = await createBookLabDeployment();
  process.stdout.write(`${JSON.stringify({ status: "UNSEEN_BOOK_DEPLOYMENT_READY", origin: deployment.origin,
    bookLab: deployment.status })}\n`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
    void deployment.close().then(() => { process.exitCode = 0; }, (error) => {
      process.stderr.write(`${error?.message ?? "book_lab_deployment_close_failed"}\n`);
      process.exitCode = 1;
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.message ?? "book_lab_deployment_failed"}\n`);
    process.exitCode = 1;
  });
}
