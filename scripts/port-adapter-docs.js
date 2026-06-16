#!/usr/bin/env node
"use strict";

// One-way doc port: regenerate the OpenCode adapter's phase files, lint-rules
// reference, and subagent bodies from the claude-code sources, applying the
// known dialect mapping (tool-name prefixes, read-tool casing, path roots,
// spawn-wrapper phrasing) plus the OpenCode-specific blocks that have no
// claude-code counterpart (the long-render MCP-timeout note, the out-of-band
// escape-hatch clause). Keeps the two adapters in lockstep without hand-editing
// every file twice — run after changing the claude-code docs:
//   node scripts/port-adapter-docs.js

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CC = path.join(ROOT, "adapters", "claude-code", ".claude");
const OC = path.join(ROOT, "adapters", "opencode", ".opencode");

function read(p) {
  return fs.readFileSync(p, "utf8");
}

// Shared dialect mapping (claude-code -> opencode).
function baseTransform(text) {
  let t = text;
  t = t.replace(/mcp__vob__vob_/g, "vob_vob_");
  t = t.replace(/\.claude\/skills\/vob\//g, ".opencode/vob/");
  t = t.replace(/`phases\/([A-Z]+)\.md`/g, "`.opencode/vob/phases/$1.md`");
  // read-tool casing/prose (OpenCode's tool is lowercase `read`).
  t = t.replace(/Read paths with `Read`:/g, "Read paths with the read tool:");
  t = t.replace(/Read the prior storyboard with `Read`\./g, "Read the prior storyboard with the read tool.");
  t = t.replace(/Read every prior file/g, "Read every prior file"); // explicit no-op guard (sentence-initial stays)
  t = t.replace(/\(`Read` it when/g, "(read it when");
  t = t.replace(/`Read` `\.opencode\/vob\/references\//g, "read `.opencode/vob/references/");
  t = t.replace(/\| `Read` `references\//g, "| read of `.opencode/vob/references/");
  t = t.replace(/`Read` of `/g, "read of `");
  t = t.replace(/and `Read` its brief/g, "and read its brief");
  t = t.replace(/- `Read` `transcript_paragraphs_path`/g, "- Read `transcript_paragraphs_path`");
  t = t.replace(/only then Read `manifest\.json`/g, "only then read `manifest.json`");
  t = t.replace(/faded, Read the contact/g, "faded, read the contact");
  t = t.replace(/\(Read the\n {3}digest/g, "(read the\n   digest");
  t = t.replace(/and `Read`\n {3}`storyboard\.markdown_path`/g, "and read\n   `storyboard.markdown_path`");
  t = t.replace(/ALWAYS Read two stills/g, "ALWAYS read two stills");
  t = t.replace(/speaking: Read `digest_path`/g, "speaking: read `digest_path`");
  t = t.replace(/then Read each/g, "then read each");
  t = t.replace(/; Read them all/g, "; read them all");
  t = t.replace(/then Read\n {3}`/g, "then read\n   `");
  t = t.replace(/Instead: `Read`\n/g, "Instead: read\n");
  t = t.replace(/`Read`\n {3}`broll_gaps_path`/g, "read\n   `broll_gaps_path`");
  t = t.replace(/Optionally `Read` the README/g, "Optionally read the README");
  t = t.replace(/no `Write`, no `Edit`, no `Bash`/g, "no `write`, no `edit`, no `patch`, no `bash`");
  t = t.replace(/\bother vob_\* tools\b/g, "other vob_vob_* tools");
  t = t.replace(/any other `vob_\*` tool\b/g, "any other `vob_vob_*` tool");
  // Spawn wrapper: Task(...) -> the `task` tool phrasing with a bare DATA block.
  t = t.replace(
    /(\n)( {3}```\n) {3}Task\(subagent_type: "([a-z]+)",\n {8}description: "[^"]*",\n {8}prompt: "DATA\n/g,
    (_, nl, fence, agent) => `${nl}   Invoke the \`${agent}\` subagent with the \`task\` tool, passing:\n${fence}   DATA\n`,
  );
  t = t.replace(/Follow your agent instructions\."\)/g, "Follow your agent instructions.");
  return t;
}

function splitFrontmatter(text) {
  if (!text.startsWith("---")) return { fm: null, body: text };
  const close = text.indexOf("\n---", 3);
  if (close === -1) return { fm: null, body: text };
  const fmEnd = close + "\n---".length;
  // include the trailing newline after the closing fence
  const after = text.indexOf("\n", fmEnd);
  return { fm: text.slice(0, after + 1), body: text.slice(after + 1) };
}

let wrote = 0;
function writeOut(p, content) {
  fs.writeFileSync(p, content);
  wrote += 1;
  console.log(`ported ${path.relative(ROOT, p)}`);
}

// --- phase files + references ---------------------------------------------
const PHASES = ["INGEST", "INSPECT", "INTENT", "PLAN", "COMPOSE", "PREVIEW", "RENDER", "PACKAGE", "ITERATE"];

// OpenCode-only block: the long-render MCP-timeout note appended to RENDER.md.
const OC_RENDER_NOTE = `
> **OpenCode note on long renders.** OpenCode bounds how long a single MCP tool call may run, and
> that ceiling can be shorter than a full render (≤30 min) or a long INSPECT. If
> \`vob_vob_render_full\` / \`vob_vob_render_preview\` is killed by OpenCode (not by hyperframes)
> before completing, the render is still progressing in the log; tell the user, point them at the
> \`stderr_log_path\`, and either retry or — for a render you've run out-of-band to completion —
> record the finished file with \`vob_vob_import_deliverable\` (see the escape hatch in
> \`.opencode/vob/phases/PACKAGE.md\`). Raise OpenCode's MCP timeout if your version honors it
> (\`mcp.vob.timeout\` is set high in \`opencode.json\`, but some versions cap execution separately).
> The same hatch applies when repeated attempts die in the BROWSER (\`Target closed\`, \`Protocol
> error\`, BeginFrame/ready timeouts) rather than in the composition — offer the overlay-over-base
> path from that section and ask the user first: it leaves the single-timeline FSM.
`;

for (const phase of PHASES) {
  let t = baseTransform(read(path.join(CC, "skills", "vob", "phases", `${phase}.md`)));
  if (phase === "RENDER") {
    // The browser-death fallback paragraph lives in the OpenCode-only note below.
    t = t.replace(
      / {3}If repeated attempts die in the BROWSER \(`Target closed`, `Protocol error`, BeginFrame\/ready\n {3}timeouts\) rather than in the composition, offer the overlay-over-base escape hatch —\n {3}`\.opencode\/vob\/phases\/PACKAGE\.md` §Escape hatch \(`vob_import_deliverable`\) — and ask the user first: it\n {3}leaves the single-timeline FSM\.\n/,
      "",
    );
    t = `${t.trimEnd()}\n${OC_RENDER_NOTE}`;
  }
  if (phase === "PACKAGE") {
    t = t.replace(
      "path was too fragile on this host), or shorts produced by a bespoke pipeline. For those, do not\nlet `state.json` lie that the project is stuck at INGEST/INSPECT while finished clips exist on\ndisk. Record reality:",
      "path was too fragile on this host), shorts produced by a bespoke pipeline, or a render that ran\nto completion out-of-band after OpenCode timed out the in-FSM render call. For those, do not let\n`state.json` lie that the project is stuck at INGEST/INSPECT while finished clips exist on disk.\nRecord reality:",
    );
    t = t.replace(/write-guard allows exactly that subtree/g, "session-guard plugin allows exactly that subtree");
  }
  writeOut(path.join(OC, "vob", "phases", `${phase}.md`), t);
}

for (const ref of ["lint-rules.md", "brief-design.md"]) {
  writeOut(path.join(OC, "vob", "references", ref), baseTransform(read(path.join(CC, "skills", "vob", "references", ref))));
}

// --- subagents: keep the OpenCode frontmatter, port the body ----------------
for (const agent of ["inspector", "storyboarder", "composer"]) {
  const ccBody = splitFrontmatter(read(path.join(CC, "agents", `${agent}.md`))).body;
  const ocPath = path.join(OC, "agents", `${agent}.md`);
  const ocFm = splitFrontmatter(read(ocPath)).fm;
  if (!ocFm) throw new Error(`no frontmatter in ${ocPath}`);
  writeOut(ocPath, ocFm + baseTransform(ccBody));
}

console.log(`done — ${wrote} files.`);
