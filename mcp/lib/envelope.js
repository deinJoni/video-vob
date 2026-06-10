"use strict";

const ERROR_CODES = Object.freeze({
  UNKNOWN_TOOL: "UNKNOWN_TOOL",
  INVALID_ARGUMENTS: "INVALID_ARGUMENTS",
  STATE_CONFLICT: "STATE_CONFLICT",
  NOT_FOUND: "NOT_FOUND",
  INTERNAL_ERROR: "INTERNAL_ERROR",
});

class ToolError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.details = details;
  }
}

function metaForTool(toolName) {
  return { tool: toolName, version: 1 };
}

function okEnvelope(toolName, data) {
  return {
    ok: true,
    data: data == null ? {} : data,
    meta: metaForTool(toolName),
  };
}

function errorEnvelope(toolName, code, message, details = undefined) {
  const error = {
    code,
    message: message || code,
  };
  if (details !== undefined) {
    error.details = details;
  }
  return {
    ok: false,
    error,
    meta: metaForTool(toolName),
  };
}

function normalizeHandlerResult(rawResult) {
  return rawResult == null ? {} : rawResult;
}

// Handlers signal intentional failures by throwing ToolError with a code from
// ERROR_CODES. Anything else is an unexpected internal error — no message
// sniffing (the BOB2-inherited regexes misclassified real errors).
function classifyException(error) {
  if (error && Object.values(ERROR_CODES).includes(error.code)) {
    return error.code;
  }
  return ERROR_CODES.INTERNAL_ERROR;
}

module.exports = {
  ERROR_CODES,
  ToolError,
  classifyException,
  errorEnvelope,
  normalizeHandlerResult,
  okEnvelope,
};
