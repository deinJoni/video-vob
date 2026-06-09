"use strict";

const fs = require("fs");
const path = require("path");

// Read the raw YAML frontmatter block from a markdown agent file, or null.
function readFrontmatter(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  if (!raw.startsWith("---")) return null;
  const closingIdx = raw.indexOf("\n---", 3);
  if (closingIdx === -1) return null;
  return raw.slice(3, closingIdx);
}

// Pull a single scalar `field:` value out of a frontmatter block. Lightweight
// scanner — avoids pulling a YAML dep for one field.
function frontmatterField(fm, field) {
  if (!fm) return null;
  const re = new RegExp(`^\\s*${field}\\s*:\\s*(\\S.*?)\\s*$`);
  for (const line of fm.split("\n")) {
    const m = line.match(re);
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

// The agent's role-bundle name. Claude Code agent files declare it as a `name:`
// frontmatter field; OpenCode agent files have no `name:` (the agent name is the
// FILENAME), so we fall back to the file stem. Both adapters resolve to the same
// bundle identifier (e.g. "storyboarder").
function parseAgentName(filePath) {
  const name = frontmatterField(readFrontmatter(filePath), "name");
  if (name) return name;
  return path.basename(filePath, ".md");
}

// The agent's mode (OpenCode: primary | subagent | all). Claude Code agent files
// omit it — they are all subagents; the orchestrator is a skill with no file.
function parseAgentMode(filePath) {
  return frontmatterField(readFrontmatter(filePath), "mode");
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
  for (const file of files) {
    // Primary agents are orchestrators, not subagents: they hold the
    // conversation and call subagents, so they are not role-bundle workers and
    // need no bundle. Claude Code has no orchestrator file (it's a skill);
    // OpenCode's orchestrator is a `mode: primary` agent file. Skip both.
    if (parseAgentMode(file) === "primary") continue;
    const name = parseAgentName(file);
    if (name === "orchestrator") continue;
    if (!validRoleBundles.includes(name)) {
      missingRegistrations.push({ file, name });
    }
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
