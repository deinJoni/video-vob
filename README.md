# video-vob

An open-source, agent-driven video pipeline. Users drop raw video plus a rough idea of what they want, and an interactive FSM walks them through ingest → intent → brief → storyboard → composition → preview → render → package → iterate, producing a finished short-form video. The render engine is [hyperframes](https://github.com/heygen-com/hyperframes) (Apache 2.0). The orchestrator runs inside an agentic CLI (Claude Code today; Kimi-CLI, Codex CLI, and Cursor planned) via a thin CLI-specific adapter on top of a shared MCP server.

This repo is at **milestone 2**: real INGEST (ffprobe-driven manifest), real INTENT (interactive five-question Q&A), and real BRIEF (synthesized markdown artifact with explicit user confirmation). STORYBOARD onward is still a scaffold walk — hyperframes integration lands in milestone 3.

## Requirements

- Node.js ≥ 20.
- **ffprobe** on `PATH` (ships with ffmpeg). The `vob_ingest_file` tool uses ffprobe to extract codec, resolution, duration, and stream info. Install:
  - macOS: `brew install ffmpeg`
  - Debian/Ubuntu: `apt-get install ffmpeg`
  - Other: https://ffmpeg.org/download.html

  If ffprobe is missing, `vob_ingest_file` fails with a clear error pointing here.

Licensed under [Apache 2.0](./LICENSE).
