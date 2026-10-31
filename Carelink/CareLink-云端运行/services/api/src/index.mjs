import { existsSync } from "node:fs";
import path from "node:path";
import { LocalApi } from "./api.mjs";
import { LocalKeyring, loadLocalKeyring } from "./crypto.mjs";
import { createLocalHttpServer, listenLocalHttpServer } from "./http-server.mjs";
import { FilesystemMediaStore } from "./ports/media/filesystem-media-store.mjs";

const port = Number(process.env.UNSEEN_API_PORT ?? 8787);
const host = process.env.UNSEEN_API_HOST ?? "127.0.0.1";
const database = process.env.UNSEEN_API_DB ?? "./services/api/local.sqlite";
const keysetPath = path.resolve(process.env.UNSEEN_API_KEYSET ?? "./services/api/local.keyset.json");
const keyring = database === ":memory:" ? new LocalKeyring() :
  loadLocalKeyring(keysetPath, { allowCreate: !existsSync(path.resolve(database)) });
const mediaStore = database === ":memory:" ? undefined :
  new FilesystemMediaStore(path.resolve(process.env.UNSEEN_API_MEDIA_ROOT ?? `${path.resolve(database)}.media`));
// Defaults to "pow" here (unlike bare LocalApi construction, which defaults to "disabled" so
// existing test fixtures that never mint/solve a challenge keep working -- see
// ports/captcha/disabled-captcha-port.mjs) because any real server boot should protect OTP
// issuance unless an operator explicitly opts out.
const otpCaptchaProvider = process.env.UNSEEN_OTP_CAPTCHA_PROVIDER ?? "pow";
const api = new LocalApi({ database, keyring, mediaStore, worldResults: { signingKey: process.env.WORLD_RESULT_SIGNING_KEY }, publicOrigin: `http://${host}:${port}`,
  featureFlags: { bookLab: process.env.UNSEEN_BOOK_LAB_ENABLED === "true",
    privateAiWorker: process.env.UNSEEN_PRIVATE_AI_WORKER_ENABLED === "true" },
  privateAi: {
    tokenHashFile: process.env.UNSEEN_PRIVATE_AI_WORKER_TOKEN_HASH_FILE,
    promptHash: process.env.UNSEEN_PRIVATE_AI_PROMPT_HASH,
    policyHash: process.env.UNSEEN_PRIVATE_AI_POLICY_HASH,
    model: process.env.UNSEEN_PRIVATE_AI_MODEL,
    modelVersion: process.env.UNSEEN_PRIVATE_AI_MODEL_VERSION
  },
  otpCaptcha: { provider: otpCaptchaProvider,
    difficultyBits: process.env.UNSEEN_OTP_CAPTCHA_DIFFICULTY_BITS === undefined ?
      undefined : Number(process.env.UNSEEN_OTP_CAPTCHA_DIFFICULTY_BITS),
    challengeTtlMs: process.env.UNSEEN_OTP_CAPTCHA_CHALLENGE_TTL_MS === undefined ?
      undefined : Number(process.env.UNSEEN_OTP_CAPTCHA_CHALLENGE_TTL_MS),
    tencent: otpCaptchaProvider === "tencent_captcha" ? {
      secretId: process.env.UNSEEN_TENCENT_SES_SECRET_ID, secretKey: process.env.UNSEEN_TENCENT_SES_SECRET_KEY,
      captchaAppId: Number(process.env.UNSEEN_TENCENT_CAPTCHA_APP_ID),
      appSecretKey: process.env.UNSEEN_TENCENT_CAPTCHA_APP_SECRET_KEY,
      timeoutMs: Number(process.env.UNSEEN_TENCENT_CAPTCHA_TIMEOUT_MS ?? 5000)
    } : undefined },
  otpRateLimits: {
    ipHourlyLimit: process.env.UNSEEN_OTP_RATE_IP_HOURLY_LIMIT === undefined ?
      undefined : Number(process.env.UNSEEN_OTP_RATE_IP_HOURLY_LIMIT),
    ipDailyLimit: process.env.UNSEEN_OTP_RATE_IP_DAILY_LIMIT === undefined ?
      undefined : Number(process.env.UNSEEN_OTP_RATE_IP_DAILY_LIMIT),
    dailyBudget: process.env.UNSEEN_OTP_DAILY_SEND_BUDGET === undefined ?
      undefined : Number(process.env.UNSEEN_OTP_DAILY_SEND_BUDGET)
  },
  // See infra/integration/local-operable.mjs's own UNSEEN_LOCATOR_MODE handling for the "opt-in,
  // off by default" rationale -- this entrypoint mirrors it so `/healthz` probes the real CLIP
  // sidecar whenever this process is actually the one configured to talk to one.
  health: { cacheTtlMs: process.env.UNSEEN_HEALTHZ_CACHE_TTL_MS === undefined ?
      undefined : Number(process.env.UNSEEN_HEALTHZ_CACHE_TTL_MS),
    clipSidecar: { enabled: process.env.UNSEEN_LOCATOR_MODE === "clip",
      baseUrl: process.env.UNSEEN_CLIP_SIDECAR_URL ?? "http://127.0.0.1:8791",
      timeoutMs: Number(process.env.UNSEEN_CLIP_SIDECAR_HEALTHZ_TIMEOUT_MS ?? 1500) } } });
await api.ready;
await api.dispatchOtpDeliveries();
const otpTimer = setInterval(() => { void api.dispatchOtpDeliveries().catch(() => {}); }, 5_000);
otpTimer.unref();
const server = createLocalHttpServer({ api });
const listening = await listenLocalHttpServer(server, { host, port });
api.campaigns.publicOrigin = listening.origin;
const health = await api.health();
process.stdout.write(`${JSON.stringify({ status: health.status === "ok" ? "UNSEEN_LOCAL_API_READY" :
  "UNSEEN_LOCAL_API_DEGRADED", origin: listening.origin, keyId: keyring.keyId,
otpDelivery: health.otpDelivery })}\n`);

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => {
  clearInterval(otpTimer);
  api.close();
  process.exit(0);
}));
