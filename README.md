# video-vob

An open-source, agent-driven video pipeline. Users drop raw video plus a rough idea of what they want, and an interactive FSM walks them through ingest → intent → brief → storyboard → composition → preview → render → package → iterate, producing a finished short-form video. The render engine is [hyperframes](https://github.com/heygen-com/hyperframes) (Apache 2.0). The orchestrator runs inside an agentic CLI (Claude Code today; Kimi-CLI, Codex CLI, and Cursor planned) via a thin CLI-specific adapter on top of a shared MCP server.

This repo is at **milestone 1**: a runnable chassis (MCP server + 9-state FSM + 4 starter tools) that proves the layering works end-to-end. No video work yet.

Licensed under [Apache 2.0](./LICENSE).
