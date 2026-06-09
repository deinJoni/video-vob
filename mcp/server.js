#!/usr/bin/env node
"use strict";

const path = require("path");

const { startStdioServer } = require("./lib/transport.js");
const { TOOLS, VALID_ROLE_BUNDLES } = require("./lib/tool-registry.js");
const { executeTool } = require("./lib/dispatch.js");
const { verifyAgentRegistrations } = require("./lib/registry-integrity.js");

const SERVER_INFO = Object.freeze({ name: "vob", version: "1.0.0" });

// Boot-time integrity check: every SUBAGENT definition shipped by ANY adapter
// must have a matching entry in VALID_ROLE_BUNDLES. Encodes the M3 lesson — a
// missing role-bundle registration silently fails to expose the subagent. Fail
// loud at startup instead of mysteriously at runtime. The check is adapter-aware:
// each adapter stores its subagent files in its own layout (Claude Code:
// .claude/agents with a `name:` frontmatter field; OpenCode: .opencode/agents
// with the agent name derived from the filename). `verifyAgentRegistrations`
// resolves the name either way and skips `mode: primary` orchestrators.
// Missing directories are a no-op (this repo is the template; an installed
// project copies only `mcp/`, not `adapters/`).
const ADAPTER_AGENT_DIRS = [
  ["adapters", "claude-code", ".claude", "agents"],
  ["adapters", "opencode", ".opencode", "agents"],
];

function runIntegrityChecks() {
  for (const segments of ADAPTER_AGENT_DIRS) {
    const agentsDir = path.resolve(__dirname, "..", ...segments);
    verifyAgentRegistrations({ agentsDir, validRoleBundles: VALID_ROLE_BUNDLES });
  }
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
