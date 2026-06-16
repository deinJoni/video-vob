# Adapters

Each subdirectory of `adapters/` is a binding to one agentic CLI. An adapter MUST provide whatever files that CLI requires to (1) register the `mcp/server.js` MCP server, (2) define a `/vob` slash command or equivalent entry point, and (3) wire any necessary policy hooks. An adapter MUST NOT modify or duplicate logic from `mcp/` — the MCP server is the single source of truth for the FSM and tools.

Currently shipped: `claude-code` (Claude Code), `opencode` ([OpenCode](https://opencode.ai)). Planned: `kimi` (Kimi-CLI), `codex` (OpenAI Codex CLI), `cursor` (Cursor).

## How the two shipped adapters map to the same contract

| Concern | claude-code | opencode |
|---|---|---|
| MCP registration | `.mcp.json` | `opencode.json` → `mcp.vob` (`type:"local"`, `command:["node","./mcp/server.js"]`) |
| Orchestrator entry point | `/vob` skill (`.claude/skills/vob/SKILL.md`) | `/vob` command (`.opencode/commands/vob.md`) → `vob` primary agent (`.opencode/agents/vob.md`) |
| Phase detail files | `.claude/skills/vob/phases/*.md` | `.opencode/vob/phases/*.md` |
| Lint/QC fix reference | `.claude/skills/vob/references/lint-rules.md` | `.opencode/vob/references/lint-rules.md` |
| Subagents (inspector, storyboarder, composer) | `.claude/agents/*.md` (scoped `tools:` list) | `.opencode/agents/*.md` (`mode: subagent`; `tools:`/`permission:` scoped to read-only + one `vob_vob_save_*`) |
| "only MCP tools mutate state" | orchestrator has no Write/Edit of session paths; PreToolUse write-guard hook blocks Write/Edit under `~/video-vob-sessions/` (real in v2) | all vob agents have `write`/`edit`/`patch` disabled; `.opencode/plugins/vob-session-guard.js` blocks any agent from writing under `~/video-vob-sessions/` |
| Role-bundle gating | `role_bundles` + boot integrity check | `permission.task` on the orchestrator (deny `*`, allow the three subagents) + the same boot integrity check |
| Tool-list drift guard | SKILL.md `allowed-tools` + settings.json `permissions.allow` verified at MCP boot | agent frontmatter tool keys verified at MCP boot |
| Project rules | `.claude/rules/editing.md` | `.opencode/rules/vob-editing.md` via `opencode.json` `instructions` |
| Phase status display | `.claude/hooks/vob-statusline.js` (statusline) | — (OpenCode has no statusline feature; the orchestrator surfaces the current phase in-conversation) |
| Network access | not granted (allowlist omits WebFetch/WebSearch) | `webfetch`/`websearch` disabled on every vob agent (tools + permission) |

**Sync rule:** the orchestrator spine, nine phase files, three agent files, and the references are synced twins across adapters (transforms: tool prefix, task-invocation phrasing, read-tool naming, plus a few OpenCode-only blocks like the long-render MCP-timeout note). Since v3 the claude-code docs are the SOURCE: edit them, then run `node scripts/port-adapter-docs.js` to regenerate the OpenCode phase files, references, and subagent bodies (the orchestrator spine `vob.md` diverges structurally and stays hand-synced). Any edit to one side lands in the other in the same commit; the boot drift guard catches tool-name drift.

**OpenCode MCP tool naming:** tools are exposed as `<server>_<tool>`, so with server key `vob` the engine's `vob_init_project` becomes `vob_vob_init_project`; the wildcard `vob_*` matches them all. The two on-disk dir names that OpenCode's loader accepts are plural (`.opencode/agents/`, `.opencode/commands/`, `.opencode/plugins/`) — the documented form, used here; singular variants are also scanned by current versions if you need a fallback.

To add a new adapter, create `adapters/<name>/` containing exactly the files that CLI expects (in its own layout); `install.sh` copies the adapter directory's contents wholesale (`cp -R adapters/<name>/. <target>/`), so no installer change is needed for the copy. If the adapter ships **subagents**, point the boot integrity check at its agents directory in `mcp/server.js` (`ADAPTER_AGENT_DIRS`) so a misregistered subagent fails loud at startup — and mirror the phase/reference files in a layout that CLI can Read.
