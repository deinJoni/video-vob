"use strict";

const {
  ERROR_CODES,
  classifyException,
  errorEnvelope,
  normalizeHandlerResult,
  okEnvelope,
} = require("./envelope.js");
const { getRegisteredTool, TOOL_HANDLERS } = require("./tool-registry.js");
const { validateToolArguments } = require("./tool-validation.js");

async function executeTool(name, args) {
  const safeArgs = args || {};
  const tool = getRegisteredTool(name);

  if (!tool) {
    return errorEnvelope(name, ERROR_CODES.UNKNOWN_TOOL, `Unknown tool: ${name}`);
  }

  try {
    validateToolArguments(name, safeArgs);
  } catch (error) {
    return errorEnvelope(name, ERROR_CODES.INVALID_ARGUMENTS, error.message || String(error));
  }

  try {
    const data = normalizeHandlerResult(await tool.handler(safeArgs));
    return okEnvelope(name, data);
  } catch (error) {
    return errorEnvelope(name, classifyException(error), error.message || String(error), error.details);
  }
}

module.exports = {
  TOOL_HANDLERS,
  executeTool,
};
