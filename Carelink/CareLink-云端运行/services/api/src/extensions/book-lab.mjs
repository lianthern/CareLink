import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { BookLabError, BookLabMemoryApi, createMiniMaxQuestionProvider, sha256 } from
  "../../../book-lab/src/index.mjs";
import { renderBookLabJob, resolveBookRendererNetworkSandbox } from
  "../../../../infra/integration/book-lab/render-worker-adapter.mjs";
import { createDedicatedRendererClient } from
  "../../../../infra/integration/book-lab/renderer-client.mjs";
import { BOOK_RENDER_LEASE_MS, RENDERER_PROTOCOL, RENDERER_WHOLE_TIMEOUT_MS } from
  "../../../../infra/integration/book-lab/renderer-ipc-protocol.mjs";
import { assert } from "../errors.mjs";

const require = createRequire(import.meta.url);
const coverage = require("../../../../packages/contracts/generated/book-lab/action-api-coverage.json");
const SHA256 = /^[a-f0-9]{64}$/u;

function required(value) {
  assert(typeof value === "string" && value.length > 0, "book_lab_extension_unavailable", 503);
  return value;
}

function secret(value) {
  assert(typeof value === "string" && value.length >= 32, "book_lab_extension_unavailable", 503);
  return value;
}

function hash(value) {
  assert(typeof value === "string" && SHA256.test(value), "book_lab_extension_unavailable", 503);
  return value;
}

// The MiniMax key is read only from an env var or an absolute, non-empty local secret file — never from options
// supplied by anything other than the process launcher — and it is returned as an opaque string that this module
// never logs, echoes into a config snapshot, or otherwise persists beyond passing it to the provider factory.
function minimaxApiKeyFromEnv(env) {
  if (typeof env.UNSEEN_MINIMAX_API_KEY === "string" && env.UNSEEN_MINIMAX_API_KEY.length > 0) {
    return env.UNSEEN_MINIMAX_API_KEY;
  }
  if (typeof env.UNSEEN_MINIMAX_KEY_FILE === "string" && env.UNSEEN_MINIMAX_KEY_FILE.length > 0) {
    assert(path.isAbsolute(env.UNSEEN_MINIMAX_KEY_FILE), "book_lab_extension_unavailable", 503);
    let raw;
    try {
      raw = readFileSync(env.UNSEEN_MINIMAX_KEY_FILE, "utf8");
    } catch {
      assert(false, "book_lab_extension_unavailable", 503);
    }
    const trimmed = raw.trim();
    assert(trimmed.length > 0, "book_lab_extension_unavailable", 503);
    return trimmed;
  }
  return null;
}

function configuration(options = {}) {
  const env = options.env ?? process.env;
  const database = required(options.database ?? env.UNSEEN_BOOK_LAB_DB);
  assert(database !== ":memory:" && path.isAbsolute(database), "book_lab_extension_unavailable", 503);
  const privateAiEnabled = options.privateAiEnabled ?? env.UNSEEN_PRIVATE_AI_WORKER_ENABLED === "true";
  const privateAi = privateAiEnabled ? Object.freeze({
    model: required(options.privateAiModel ?? env.UNSEEN_PRIVATE_AI_MODEL),
    modelVersion: required(options.privateAiModelVersion ?? env.UNSEEN_PRIVATE_AI_MODEL_VERSION),
    promptHash: hash(options.privateAiPromptHash ?? env.UNSEEN_PRIVATE_AI_PROMPT_HASH),
    policyHash: hash(options.privateAiPolicyHash ?? env.UNSEEN_PRIVATE_AI_POLICY_HASH)
  }) : null;
  // Direct in-process questionProvider selection. Unset (the default) preserves today's exact behavior: the
  // synchronous provider always throws `provider_unconfigured`, so any admitted question job can only complete
  // through the separate async private-ai-composition worker seam (`ingestPrivateQuestionResult`). Opting into
  // "minimax" is the only way this changes; every other value, or leaving the switch off, must be byte-for-byte
  // identical to before this provider existed.
  const questionProviderKind = options.questionProviderKind ?? env.UNSEEN_BOOK_QUESTION_PROVIDER ?? null;
  assert(questionProviderKind === null || questionProviderKind === "minimax", "book_lab_extension_unavailable", 503);
  assert(questionProviderKind !== "minimax" || privateAi !== null, "book_lab_extension_unavailable", 503);
  const minimax = questionProviderKind === "minimax" ? Object.freeze({
    apiKey: required(options.minimaxApiKey ?? minimaxApiKeyFromEnv(env)),
    baseUrl: options.minimaxBaseUrl ?? env.UNSEEN_MINIMAX_BASE_URL ?? undefined,
    textModel: options.minimaxTextModel ?? env.UNSEEN_MINIMAX_TEXT_MODEL ?? undefined,
    visionModel: options.minimaxVisionModel ?? env.UNSEEN_MINIMAX_VISION_MODEL ?? undefined,
    requestTimeoutMs: env.UNSEEN_MINIMAX_REQUEST_TIMEOUT_MS !== undefined || options.minimaxRequestTimeoutMs !== undefined
      ? Number(options.minimaxRequestTimeoutMs ?? env.UNSEEN_MINIMAX_REQUEST_TIMEOUT_MS) : undefined
  }) : null;
  const rendererTransport = options.rendererTransport ?? env.UNSEEN_BOOK_RENDERER_TRANSPORT ?? "inline";
  assert(new Set(["inline", RENDERER_PROTOCOL]).has(rendererTransport),
    "book_lab_extension_unavailable", 503);
  const config = {
    database,
    renderGenerationEnabled: env.UNSEEN_BOOK_RENDER_GENERATION_ENABLED !== "false",
    renderTemporaryRoot: path.resolve(options.renderTemporaryRoot ?? env.UNSEEN_BOOK_LAB_RENDER_TMP ??
      path.join(path.dirname(database), "book-render-tmp")),
    renderTimeoutMs: Number(options.renderTimeoutMs ?? env.UNSEEN_BOOK_LAB_RENDER_TIMEOUT_MS ?? 90_000),
    chromiumPath: options.chromiumPath ?? env.UNSEEN_CHROMIUM_PATH ?? null,
    egressWrapper: options.egressWrapper ?? env.UNSEEN_BOOK_LAB_EGRESS_WRAPPER,
    egressAttestation: options.egressAttestation ?? env.UNSEEN_BOOK_LAB_EGRESS_ATTESTATION,
    rendererTransport,
    rendererSocketPath: options.rendererSocketPath ?? env.UNSEEN_BOOK_RENDERER_SOCKET,
    rendererSpoolRoot: options.rendererSpoolRoot ?? env.UNSEEN_BOOK_RENDERER_SPOOL,
    rendererAcceptancePath: options.rendererAcceptancePath ?? env.UNSEEN_BOOK_RENDERER_ACCEPTANCE_FILE,
    rendererAcceptanceHash: options.rendererAcceptanceHash ?? env.UNSEEN_BOOK_RENDERER_ACCEPTANCE_SHA256,
    rendererAcceptanceUid: Number(options.rendererAcceptanceUid ?? 0),
    etagSecret: secret(options.etagSecret ?? env.UNSEEN_BOOK_LAB_ETAG_SECRET),
    workerSecret: secret(options.workerSecret ?? env.UNSEEN_BOOK_LAB_WORKER_SECRET),
    cleanupSecret: secret(options.cleanupSecret ?? env.UNSEEN_BOOK_LAB_CLEANUP_SECRET),
    renderWorkerSecret: secret(options.renderWorkerSecret ?? env.UNSEEN_BOOK_LAB_RENDER_WORKER_SECRET),
    currentNotice: Object.freeze({
      version: required(options.collectionNoticeVersion ?? env.UNSEEN_BOOK_LAB_COLLECTION_NOTICE_VERSION),
      hash: hash(options.collectionNoticeHash ?? env.UNSEEN_BOOK_LAB_COLLECTION_NOTICE_HASH),
      plainLanguageCopy: required(options.collectionNoticeCopy ?? env.UNSEEN_BOOK_LAB_COLLECTION_NOTICE_COPY)
    }),
    currentBookNotice: Object.freeze({
      version: required(options.grantNoticeVersion ?? env.UNSEEN_BOOK_LAB_GRANT_NOTICE_VERSION),
      hash: hash(options.grantNoticeHash ?? env.UNSEEN_BOOK_LAB_GRANT_NOTICE_HASH)
    }),
    privateAi,
    questionProviderKind,
    minimax
  };
  assert(new Set([config.etagSecret, config.workerSecret, config.cleanupSecret,
    config.renderWorkerSecret]).size === 4 && config.currentNotice.plainLanguageCopy.length <= 2_000,
  "book_lab_extension_unavailable", 503);
  assert(Number.isSafeInteger(config.renderTimeoutMs) && config.renderTimeoutMs >= 1_000 &&
    config.renderTimeoutMs <= 300_000 && path.isAbsolute(config.renderTemporaryRoot) &&
    (config.chromiumPath === null || typeof config.chromiumPath === "string" && path.isAbsolute(config.chromiumPath)),
  "book_lab_extension_unavailable", 503);
  if (config.renderGenerationEnabled && config.rendererTransport === RENDERER_PROTOCOL) {
    assert(config.renderTimeoutMs === RENDERER_WHOLE_TIMEOUT_MS &&
      [config.rendererSocketPath, config.rendererSpoolRoot, config.rendererAcceptancePath]
        .every((entry) => typeof entry === "string" && path.isAbsolute(entry)) &&
      SHA256.test(config.rendererAcceptanceHash) && Number.isSafeInteger(config.rendererAcceptanceUid) &&
      config.rendererAcceptanceUid >= 0, "book_lab_extension_unavailable", 503);
  }
  return Object.freeze(config);
}

function fill(template, params) {
  return template.replace(/\{([^}]+)\}/gu, (_match, name) => {
    const value = params?.[name];
    assert((typeof value === "string" || typeof value === "number") && String(value).length > 0,
      "book_lab_extension_unavailable", 503);
    return encodeURIComponent(String(value));
  });
}

function corePort(input, contexts) {
  const participantCapabilities = new WeakMap();
  return Object.freeze({
    authenticate() {
      const ctx = contexts.getStore();
      if (!ctx) return null;
      const capability = input.authenticateBookLabParticipant(ctx);
      if (!capability) return null;
      const principal = Object.freeze({ ...capability,
        allowedPhotoIds: capability.allowedPhotoIds === null ? null : new Set(capability.allowedPhotoIds) });
      participantCapabilities.set(principal, capability);
      return principal;
    },
    readOwnedPhoto(principal, photoId) {
      const capability = participantCapabilities.get(principal);
      return capability ? input.readBookLabParticipantPhoto(capability, photoId) : null;
    },
    listEligibleBooks(principal, spaceId) {
      const capability = participantCapabilities.get(principal);
      return capability ? input.listBookLabEligibleBooks(capability, spaceId) : [];
    },
    readCurrentOwner(_headers, spaceId) {
      const ctx = contexts.getStore();
      return ctx ? input.readCurrentBookLabOwner(ctx, spaceId) : null;
    },
    revalidateCurrentOwner: (owner) => input.revalidateCurrentBookLabOwner(owner),
    readCurrentBookViewer(_headers, spaceId) {
      const ctx = contexts.getStore();
      return ctx ? input.readCurrentBookLabViewer(ctx, spaceId) : null;
    },
    revalidateCurrentBookViewer: (viewer) => input.revalidateCurrentBookLabViewer(viewer),
    readOwnerSnapshot: (spaceId) => input.readBookLabOwnerSnapshot(spaceId),
    readEventForOwner: (owner, eventId) => input.readBookLabEventForOwner(owner, eventId),
    readDisplayPhotoForOwner: (actor, photoId) => input.readBookLabDisplayPhoto(actor, photoId),
    readQuestionSourceForWorker: (query) => input.readQuestionSourceForWorker(query)
  });
}

async function failClosedRender(api, request, config) {
  let frozen = false;
  let claimed;
  try {
    claimed = await api.processPreview(request, config.renderWorkerSecret);
  } catch (error) {
    if (!(error instanceof BookLabError) || error.code !== "render_job_unavailable") throw error;
    frozen = true;
    claimed = await api.processFrozenRender(request, config.renderWorkerSecret);
  }
  if (claimed.status !== "claimed") return claimed;
  const completion = { renderJobId: request.renderJobId, jobVersion: claimed.version,
    inputHash: request.inputHash, attempt: request.attempt };
  let output;
  try {
    output = config.rendererClient ? await config.rendererClient.render({ kind: frozen ? "frozen" : "preview",
      processorRequest: request, input: claimed.input }) :
      await renderBookLabJob({ kind: frozen ? "frozen" : "preview", input: claimed.input }, {
        temporaryRoot: config.renderTemporaryRoot, timeoutMs: config.renderTimeoutMs,
        egressWrapper: config.egressWrapper, egressAttestation: config.egressAttestation,
        ...(config.chromiumPath ? { browserPath: config.chromiumPath } : {})
      });
    if (frozen) {
      const { receipt: _validatedReceipt, ...completionOutput } = output;
      output = completionOutput;
    }
  } catch {
    output = { status: "failed", stableError: "render_failed" };
  }
  return frozen ? api.completeFrozenRender(completion, output, config.renderWorkerSecret) :
    api.completePreview(completion, output, config.renderWorkerSecret);
}

export function registerBookLabExtension(input, options = {}) {
  assert(input?.featureFlags?.bookLab === true, "book_lab_extension_unavailable", 503);
  const configured = configuration(options);
  assert(input.featureFlags.privateAiWorker === Boolean(configured.privateAi),
    "book_lab_extension_unavailable", 503);
  const rendererClient = configured.renderGenerationEnabled && configured.rendererTransport === RENDERER_PROTOCOL ? createDedicatedRendererClient({
    socketPath: configured.rendererSocketPath, spoolRoot: configured.rendererSpoolRoot,
    acceptanceReceiptPath: configured.rendererAcceptancePath,
    acceptanceReceiptHash: configured.rendererAcceptanceHash,
    expectedReceiptUid: configured.rendererAcceptanceUid
  }) : null;
  if (configured.renderGenerationEnabled && !rendererClient) resolveBookRendererNetworkSandbox(configured);
  const config = Object.freeze({ ...configured, rendererClient });
  const contexts = new AsyncLocalStorage();
  let api;

  // Memory detail is a supporting read, not an action-registry mutation. The integrated UI needs it after question creation.
  for (const action of [...coverage.actions, { method: "GET", endpoint: "/v2-labs/memories/{memoryId}" },
    { method: "GET", endpoint: "/v2-labs/live/spaces/{spaceId}/books/{bookId}/versions/{versionId}/html" },
    { method: "GET", endpoint: "/v2-labs/owner/spaces/{spaceId}/books/{bookId}/draft/sources" },
    { method: "POST", endpoint: "/v2-labs/owner/spaces/{spaceId}/books/{bookId}/draft/assembly" },]) input.registerRoutes({ method: action.method, template: action.endpoint,
    handler: (ctx, params) => {
      assert(config.renderGenerationEnabled || !["BOOK.GENERATE_PREVIEW", "BOOK.FREEZE"].includes(action.actionId),
        "book_render_generation_paused", 503);
      return contexts.run(ctx, () => api.handle({ method: action.method,
        path: fill(action.endpoint, params), headers: ctx.headers, body: ctx.body }));
    } });
  input.registerInternalJobs({ endpoint: "internal:book-lab-question-processor",
    handler: (request) => api.processQuestion(request, config.workerSecret) });
  input.registerInternalJobs({ endpoint: "internal:book-lab-render-processor",
    handler: (request) => {
      assert(config.renderGenerationEnabled, "book_render_generation_paused", 503);
      return failClosedRender(api, request, config);
    } });

  // `config.minimax` is only ever non-null when `UNSEEN_BOOK_QUESTION_PROVIDER=minimax` was explicitly set (and the
  // `configuration()` gate above already required `config.privateAi` to be configured too). Any other value, or
  // leaving the switch unset, keeps the exact prior stub: the synchronous provider always throws, so an admitted
  // question job can only complete through the separate async private-ai-composition worker seam.
  const questionProvider = config.minimax
    ? createMiniMaxQuestionProvider({ apiKey: config.minimax.apiKey, baseUrl: config.minimax.baseUrl,
      textModel: config.minimax.textModel, visionModel: config.minimax.visionModel,
      requestTimeoutMs: config.minimax.requestTimeoutMs })
    : () => { throw new Error("provider_unconfigured"); };

  api = new BookLabMemoryApi({ core: corePort(input, contexts), ...config, previewLeaseMs: BOOK_RENDER_LEASE_MS,
    providerModel: config.privateAi?.model ?? "provider-unconfigured",
    modelVersion: config.privateAi?.modelVersion ?? "provider-unconfigured",
    promptHash: config.privateAi?.promptHash ?? sha256("book-lab-provider-unconfigured"),
    policyHash: config.privateAi?.policyHash ?? sha256("book-lab-provider-unconfigured"),
    questionProviderConfigured: Boolean(config.privateAi),
    questionProvider });

  return Object.freeze({
    enabled: true,
    processPendingGrantCleanup: () => api.pendingGrantCleanup(config.cleanupSecret).map(({ withdrawalId }) =>
      api.processGrantCleanup(withdrawalId, config.cleanupSecret)),
    pendingRenderRequests: () => config.renderGenerationEnabled ? [...api.pendingPreviewJobs(config.renderWorkerSecret),
      ...api.pendingFrozenRenderJobs(config.renderWorkerSecret)] : [],
    close() { rendererClient?.close(); return api.close(); },
    privateAiCompositionIntents: () => api.privateAiCompositionIntents(config.workerSecret),
    reconcilePrivateQuestionSources: () => api.reconcilePrivateQuestionSources(config.workerSecret),
    revokePrivateQuestionSources: (revocations) => api.revokePrivateQuestionSources(revocations,
      config.workerSecret),
    ingestPrivateQuestionResult: (request, dto) => api.ingestPrivateQuestionResult(request, dto,
      config.workerSecret),
    recordQuestionProviderUnavailable: (request) => api.recordQuestionProviderUnavailable(request,
      config.workerSecret),
    readCanonicalHtmlForUi: (ctx, { spaceId, bookId, versionId }) => contexts.run(ctx,
      () => api.readCanonicalHtmlForUi({ headers: ctx.headers }, spaceId, bookId, versionId))
  });
}
