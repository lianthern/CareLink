"use strict";

class AppError extends Error {
  constructor(code, message, statusCode = 400, details = undefined) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function invariant(condition, code, message, statusCode = 400, details = undefined) {
  if (!condition) throw new AppError(code, message, statusCode, details);
}

module.exports = { AppError, invariant };
