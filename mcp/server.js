#!/usr/bin/env node
"use strict";

const path = require("path");

const { startStdioServer } = require("./lib/transport.js");
const { TOOLS, VALID_ROLE_BUNDLES } = require("./lib/tool-registry.js");
const { executeTool } = require("./lib/dispatch.js");
const { verifyAgentRegistrations } = require("./lib/registry-integrity.js");

const SERVER_INFO = Object.freeze({ name: "vob", version: "1.0.0" });

// Boot-time integrity check: every agent definition under the claude-code
// adapter must have a matching entry in VALID_ROLE_BUNDLES. Encodes the M3
// lesson — a missing role-bundle registration silently fails to expose the
// subagent. Fail loud at startup instead of mysteriously at runtime.
function runIntegrityChecks() {
  const agentsDir = path.resolve(
    __dirname,
    "..",
    "adapters",
    "claude-code",
    ".claude",
    "agents",
  );
  verifyAgentRegistrations({ agentsDir, validRoleBundles: VALID_ROLE_BUNDLES });
}

if (require.main === module) {
  try {
    runIntegrityChecks();
  } catch (error) {
    process.stderr.write(`[vob] startup integrity check failed: ${error.message || String(error)}\n`);
    process.exit(1);
  }
  startStdioServer({
    serverInfo: SERVER_INFO,
    tools: TOOLS,
    executeTool,
  });
}

module.exports = { TOOLS, executeTool, SERVER_INFO, runIntegrityChecks };
