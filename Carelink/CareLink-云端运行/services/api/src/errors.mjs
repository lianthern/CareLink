export class ApiError extends Error {
  constructor(code, status = 400, details = undefined) {
    super(code);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function assert(condition, code, status = 400, details = undefined) {
  if (!condition) throw new ApiError(code, status, details);
}

export function unavailable(code) {
  throw new ApiError(code, 404);
}

export function errorBody(error, requestId) {
  const known = error instanceof ApiError;
  return {
    status: known ? error.status : 500,
    body: {
      error: {
        code: known ? error.code : "internal_error",
        requestId,
        ...(known && error.details ? { details: error.details } : {})
      }
    }
  };
}
