"use strict";

const fs = require("fs");
const path = require("path");

// Parse the YAML frontmatter `name:` field from an agent definition file.
// Lightweight scanner — avoids pulling a YAML dep for one field. Returns
// the name string or null if not found.
function parseAgentName(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  if (!raw.startsWith("---")) return null;
  const closingIdx = raw.indexOf("\n---", 3);
  if (closingIdx === -1) return null;
  const fm = raw.slice(3, closingIdx);
  for (const line of fm.split("\n")) {
    const m = line.match(/^\s*name\s*:\s*(\S.*?)\s*$/);
    if (m) {
      let value = m[1];
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      return value;
    }
  }
  return null;
}

function listAgentFiles(agentsDir) {
  let entries;
  try {
    entries = fs.readdirSync(agentsDir);
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((name) => name.endsWith(".md") && !name.startsWith("."))
    .map((name) => path.join(agentsDir, name))
    .sort();
}

// Boot-time integrity check. For every agent definition file under
// `agentsDir`, verify the declared `name:` is present in `validRoleBundles`.
// Throws Error with a clear message if any registration is missing. This
// encodes the M3 lesson: a subagent file without a matching role-bundle
// registration silently fails to be invoked, which we never want again.
function verifyAgentRegistrations({ agentsDir, validRoleBundles }) {
  if (!agentsDir || typeof agentsDir !== "string") {
    throw new Error("verifyAgentRegistrations: agentsDir required");
  }
  if (!Array.isArray(validRoleBundles)) {
    throw new Error("verifyAgentRegistrations: validRoleBundles must be an array");
  }
  const files = listAgentFiles(agentsDir);
  const missingRegistrations = [];
  const unnamedFiles = [];
  for (const file of files) {
    const name = parseAgentName(file);
    if (!name) {
      unnamedFiles.push(file);
      continue;
    }
    // The orchestrator does not need a file; only subagents do. Skip the
    // "orchestrator" entry — there's no orchestrator.md file by design.
    if (!validRoleBundles.includes(name)) {
      missingRegistrations.push({ file, name });
    }
  }
  if (unnamedFiles.length > 0) {
    throw new Error(
      `agent definition file(s) missing a 'name:' frontmatter field: ${unnamedFiles.join(", ")}`,
    );
  }
  if (missingRegistrations.length > 0) {
    const lines = missingRegistrations.map(
      (m) => `  - agent ${m.name} (defined in ${m.file}) is not registered in VALID_ROLE_BUNDLES`,
    );
    throw new Error(
      `registry integrity check failed — every agent definition must have a matching role bundle:\n${lines.join("\n")}`,
    );
  }
  return { checked: files.length, agents: files.map((file) => parseAgentName(file)) };
}

module.exports = {
  parseAgentName,
  verifyAgentRegistrations,
};
