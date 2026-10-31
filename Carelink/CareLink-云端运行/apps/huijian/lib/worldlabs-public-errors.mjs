// Keep provider diagnostics in stored jobs; only this application code crosses the public boundary.
export const WORLD_CREDIT_ERROR = 'WL-204';
export const WORLD_CREDIT_MESSAGE = '生成暂时不可用（错误码：WL-204）。请稍后再试。';

export function isWorldCreditError(error) {
  return error === 'provider_credits_low' || error === WORLD_CREDIT_ERROR ||
    error?.code === 'provider_credits_low' || error?.code === WORLD_CREDIT_ERROR ||
    error?.status === 402 || error?.code === 402 ||
    /\b(?:insufficient credits?|not enough credits?|out of credits?|credits? (?:balance )?(?:is |are )?(?:insufficient|exhausted))\b/i.test(error?.message || '');
}

export function publicWorldErrorCode(code) {
  return isWorldCreditError(code) ? WORLD_CREDIT_ERROR : code;
}

export function publicWorldFailure(code, status) {
  return isWorldCreditError({code, status})
    ? {status: 503, body: {error: WORLD_CREDIT_ERROR, message: WORLD_CREDIT_MESSAGE}}
    : {status, body: {error: code}};
}

export function publicWorldOperation(operation) {
  return operation && isWorldCreditError(operation.error)
    ? {...operation, error: {code: WORLD_CREDIT_ERROR, message: WORLD_CREDIT_MESSAGE}}
    : operation;
}
