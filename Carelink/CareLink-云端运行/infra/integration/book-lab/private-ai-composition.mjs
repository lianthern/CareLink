import { BookLabError } from "../../../services/book-lab/src/index.mjs";

const SOURCE_STALE = new Set(["private_ai_source_stale", "private_ai_image_type_unsupported",
  "private_ai_image_too_large"]);

function assertPort(target, methods, code) {
  if (!target || methods.some((method) => typeof target[method] !== "function")) throw new Error(code);
}

function consumerFailure(error) {
  if (error?.status === 404 || error?.status === 409) return "consumer_conflict";
  if (error?.status === 503) return "consumer_unavailable";
  return "consumer_internal_failure";
}

function committedProviderUnavailable(error) {
  return error instanceof BookLabError && error.code === "model_unavailable" && error.status === 503;
}

export function createPrivateAiComposition({ api, bookRuntime, intervalMs = 1_000,
  compositionLeaseMs = 60_000 } = {}) {
  assertPort(api, ["reconcilePrivateAiPhotoAuthorizations", "revokePrivateAiPhotoAuthorization",
    "authorizePrivateAiPhoto", "enqueuePrivateAiPhoto", "claimPrivateAiCompositionEvent",
    "markPrivateAiCompositionEventDelivered", "retryPrivateAiCompositionEvent"],
  "private_ai_composition_api_unavailable");
  assertPort(bookRuntime, ["reconcilePrivateQuestionSources", "revokePrivateQuestionSources",
    "privateAiCompositionIntents", "ingestPrivateQuestionResult", "recordQuestionProviderUnavailable"],
  "private_ai_composition_book_unavailable");
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 60_000 ||
    !Number.isSafeInteger(compositionLeaseMs) || compositionLeaseMs < 5_000 || compositionLeaseMs > 300_000) {
    throw new Error("private_ai_composition_configuration_invalid");
  }

  let timer = null;
  let inFlight = null;
  let closed = false;

  const cycle = async () => {
    const coreReconciliation = api.reconcilePrivateAiPhotoAuthorizations();
    await bookRuntime.revokePrivateQuestionSources(coreReconciliation.revocations);
    const bookReconciliation = await bookRuntime.reconcilePrivateQuestionSources();
    for (const revoked of bookReconciliation.revocations) api.revokePrivateAiPhotoAuthorization(revoked);

    const intents = await bookRuntime.privateAiCompositionIntents();
    for (const revoked of intents.revoke) api.revokePrivateAiPhotoAuthorization(revoked);
    let enqueuedCount = 0;
    let staleCount = 0;
    for (const intent of intents.authorize) {
      const { questionProcessorRequest, questionContext, ...authorization } = intent;
      try {
        api.authorizePrivateAiPhoto(authorization);
        api.enqueuePrivateAiPhoto({ ...authorization, questionProcessorRequest,
          ...(questionContext === undefined ? {} : { questionContext }) });
        enqueuedCount += 1;
      } catch (error) {
        if (!SOURCE_STALE.has(error?.code)) throw error;
        api.revokePrivateAiPhotoAuthorization(authorization);
        await bookRuntime.revokePrivateQuestionSources([authorization]);
        staleCount += 1;
      }
    }

    const event = api.claimPrivateAiCompositionEvent({ leaseMs: compositionLeaseMs });
    let deliveredCount = 0;
    let retriedCount = 0;
    if (event) {
      let delivered = false;
      try {
        if (event.eventType === "completed") {
          await bookRuntime.ingestPrivateQuestionResult(event.questionProcessorRequest, event.completionDto);
        } else if (event.eventType === "provider_unavailable") {
          await bookRuntime.recordQuestionProviderUnavailable(event.questionProcessorRequest);
        } else throw new Error("private_ai_composition_event_invalid");
        delivered = true;
      } catch (error) {
        if (event.eventType === "provider_unavailable" && committedProviderUnavailable(error)) delivered = true;
        else {
          api.retryPrivateAiCompositionEvent({ eventId: event.eventId,
            deliveryLeaseId: event.deliveryLeaseId, failureCode: consumerFailure(error) });
          retriedCount += 1;
        }
      }
      if (delivered) {
        api.markPrivateAiCompositionEventDelivered({ eventId: event.eventId,
          deliveryLeaseId: event.deliveryLeaseId });
        deliveredCount += 1;
      }
    }
    return Object.freeze({ reconciledCoreCount: coreReconciliation.revokedCount,
      reconciledBookCount: bookReconciliation.revokedCount, revokedIntentCount: intents.revoke.length,
      enqueuedCount, staleCount, deliveredCount, retriedCount });
  };

  const runOnce = () => {
    if (closed) return Promise.reject(new Error("private_ai_composition_closed"));
    if (inFlight) return inFlight;
    inFlight = Promise.resolve().then(cycle).finally(() => { inFlight = null; });
    return inFlight;
  };
  const start = () => {
    if (closed || timer) throw new Error("private_ai_composition_unavailable");
    timer = setInterval(() => { void runOnce().catch(() => {}); }, intervalMs);
    timer.unref();
  };
  const close = async () => {
    closed = true;
    if (timer) clearInterval(timer);
    timer = null;
    await inFlight;
  };
  return Object.freeze({ runOnce, start, close });
}
