# Adapters

Each subdirectory of `adapters/` is a binding to one agentic CLI. An adapter MUST provide whatever files that CLI requires to (1) register the `mcp/server.js` MCP server, (2) define a `/vob` slash command or equivalent entry point, and (3) wire any necessary policy hooks. An adapter MUST NOT modify or duplicate logic from `mcp/` — the MCP server is the single source of truth for the FSM and tools.

Currently shipped: `claude-code` (Claude Code). Planned: `kimi` (Kimi-CLI), `codex` (OpenAI Codex CLI), `cursor` (Cursor). To add a new adapter, create `adapters/<name>/` with the CLI's required config layout, then update `install.sh`'s adapter discovery to recognize it.
