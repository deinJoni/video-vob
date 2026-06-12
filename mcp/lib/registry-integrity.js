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

// The three subagent single-write tools. The orchestrator must never hold
// them (claude-code: absent from SKILL.md allowed-tools; OpenCode: denied with
// `vob_vob_<name>: false` in vob.md frontmatter) while settings.json must
// still allow them so the SUBAGENTS can call them without a prompt.
const SUBAGENT_WRITE_TOOLS = Object.freeze([
  "vob_save_classification",
  "vob_save_storyboard",
  "vob_save_composition",
]);

function readFileIfPresent(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

// Boot-time allow-list drift guard (D9). Cross-checks every tool name an
// adapter references — claude-code SKILL.md allowed-tools + settings.json
// permissions.allow, OpenCode agent frontmatter tool keys + opencode.json MCP
// registration — against the registry, plus the reverse role-bundle check.
// Pure and throw-free: returns { files_checked, problems[] }; the caller
// decides exit semantics. Each file is SKIPPED silently when absent (installed
// projects copy only what their adapter ships; the template repo has all).
function verifyAdapterToolReferences({ repoRoot, toolNames, validRoleBundles }) {
  const problems = [];
  let filesChecked = 0;
  const known = new Set(Array.isArray(toolNames) ? toolNames : []);
  const root = typeof repoRoot === "string" && repoRoot ? repoRoot : process.cwd();

  // 1. claude-code SKILL.md allowed-tools (template + installed layouts).
  const skillRelPaths = [
    path.join("adapters", "claude-code", ".claude", "skills", "vob", "SKILL.md"),
    path.join(".claude", "skills", "vob", "SKILL.md"),
  ];
  for (const rel of skillRelPaths) {
    const fm = readFrontmatter(path.join(root, rel));
    if (fm === null) continue;
    filesChecked += 1;
    const seen = new Set();
    const entryRe = /^\s*-\s*(mcp__vob__(vob_[a-z_]+))\s*$/gm;
    let m;
    while ((m = entryRe.exec(fm)) !== null) {
      seen.add(m[2]);
      if (!known.has(m[2])) {
        problems.push(`unknown tool in SKILL.md allowed-tools: ${m[1]} (${rel})`);
      }
    }
    for (const tool of SUBAGENT_WRITE_TOOLS) {
      if (seen.has(tool)) {
        problems.push(`subagent write tool must not be orchestrator-callable: ${tool} found in SKILL.md allowed-tools (${rel})`);
      }
    }
  }

  // 2. claude-code settings.json permissions.allow.
  const settingsRelPaths = [
    path.join("adapters", "claude-code", ".claude", "settings.json"),
    path.join(".claude", "settings.json"),
  ];
  for (const rel of settingsRelPaths) {
    const raw = readFileIfPresent(path.join(root, rel));
    if (raw === null) continue;
    filesChecked += 1;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      problems.push(`settings.json is not valid JSON: ${error.message || String(error)} (${rel})`);
      continue;
    }
    const allow = parsed && parsed.permissions && Array.isArray(parsed.permissions.allow)
      ? parsed.permissions.allow
      : [];
    const seen = new Set();
    for (const entry of allow) {
      if (typeof entry !== "string") continue;
      const m = entry.match(/^mcp__vob__(vob_[a-z_]+)$/);
      if (!m) continue;
      seen.add(m[1]);
      if (!known.has(m[1])) {
        problems.push(`unknown tool in settings.json permissions.allow: ${entry} (${rel})`);
      }
    }
    for (const tool of SUBAGENT_WRITE_TOOLS) {
      if (!seen.has(tool)) {
        problems.push(`subagent write tool missing from settings.json permissions.allow: ${tool} (${rel})`);
      }
    }
  }

  // 3. OpenCode agent frontmatter tool keys (`vob_vob_*: true|false`). The
  //    `vob_*: false` wildcard deliberately does not match the key pattern.
  const opencodeAgentDirs = [
    path.join("adapters", "opencode", ".opencode", "agents"),
    path.join(".opencode", "agents"),
  ];
  for (const relDir of opencodeAgentDirs) {
    for (const file of listAgentFiles(path.join(root, relDir))) {
      const fm = readFrontmatter(file);
      if (fm === null) continue;
      filesChecked += 1;
      const relFile = path.join(relDir, path.basename(file));
      const values = new Map();
      const keyRe = /^\s*(vob_vob_[a-z_]+)\s*:\s*(\S+)\s*$/gm;
      let m;
      while ((m = keyRe.exec(fm)) !== null) {
        values.set(m[1], m[2]);
        const engineName = m[1].replace(/^vob_/, "");
        if (!known.has(engineName)) {
          problems.push(`unknown tool in ${relFile} frontmatter: ${m[1]}`);
        }
      }
      if (frontmatterField(fm, "mode") === "primary") {
        for (const tool of SUBAGENT_WRITE_TOOLS) {
          const key = `vob_${tool}`;
          if (values.get(key) !== "false") {
            problems.push(`orchestrator must deny subagent write tool: ${key} (${relFile})`);
          }
        }
      }
    }
  }

  // 4. opencode.json MCP registration sanity (no tool names live here).
  const opencodeJsonRelPaths = [
    path.join("adapters", "opencode", "opencode.json"),
    "opencode.json",
  ];
  for (const rel of opencodeJsonRelPaths) {
    const raw = readFileIfPresent(path.join(root, rel));
    if (raw === null) continue;
    filesChecked += 1;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      problems.push(`opencode.json is not valid JSON: ${error.message || String(error)} (${rel})`);
      continue;
    }
    const command = parsed && parsed.mcp && parsed.mcp.vob ? parsed.mcp.vob.command : null;
    const last = Array.isArray(command) && command.length > 0 ? command[command.length - 1] : null;
    if (typeof last !== "string" || !last.endsWith("mcp/server.js")) {
      problems.push(`opencode.json mcp.vob.command does not point at mcp/server.js (${rel})`);
    }
  }

  // 5. Reverse role-bundle check: every registered subagent bundle must have an
  //    agent file in SOME adapter. Skipped entirely when no agent dir exists
  //    (installed project with no adapter agents — same tolerance as
  //    verifyAgentRegistrations' missing-dir no-op).
  const allAgentDirs = [
    path.join(root, "adapters", "claude-code", ".claude", "agents"),
    path.join(root, ".claude", "agents"),
    path.join(root, "adapters", "opencode", ".opencode", "agents"),
    path.join(root, ".opencode", "agents"),
  ];
  const presentDirs = allAgentDirs.filter((dir) => fs.existsSync(dir));
  if (Array.isArray(validRoleBundles) && presentDirs.length > 0) {
    const agentNames = new Set();
    for (const dir of presentDirs) {
      for (const file of listAgentFiles(dir)) agentNames.add(parseAgentName(file));
    }
    for (const bundle of validRoleBundles) {
      if (bundle === "orchestrator") continue;
      if (!agentNames.has(bundle)) {
        problems.push(`role bundle ${bundle} has no agent file in any adapter`);
      }
    }
  }

  return { files_checked: filesChecked, problems };
}

module.exports = {
  parseAgentName,
  verifyAdapterToolReferences,
  verifyAgentRegistrations,
};
