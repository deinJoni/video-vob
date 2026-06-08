# video-vob

An open-source, agent-driven video pipeline. Users drop raw video plus a rough idea of what they want, and an interactive FSM walks them through ingest → inspect → intent → plan → composition → preview → render → package → iterate, producing a finished short-form video. The render engine is [hyperframes](https://github.com/heygen-com/hyperframes) (Apache 2.0). The orchestrator runs inside an agentic CLI (Claude Code today; Kimi-CLI, Codex CLI, and Cursor planned) via a thin CLI-specific adapter on top of a shared MCP server.

**Version 1.0.** The full pipeline is implemented end-to-end:

- **INGEST** — ffprobe-driven manifest of source footage.
- **INSPECT** — thumbnail grid (every 3s via ffmpeg), mono audio extract, and word-level transcript via `npx hyperframes transcribe`. Forces the orchestrator to surface real content before INTENT begins.
- **INTENT** — adaptive intent: the orchestrator proposes the five required answers from the INSPECT classification and asks only the genuine gaps.
- **PLAN** — the single planning gate (merged former BRIEF + STORYBOARD): the orchestrator drafts a markdown brief and the `storyboarder` subagent produces a structured scene plan; both are presented together for one explicit user sign-off.
- **COMPOSE** — `composer` subagent authors hyperframes HTML/CSS/JS; orchestrator lints.
- **PREVIEW** — draft-quality render via `npx hyperframes render --quality draft`; user reviews.
- **RENDER** — full-quality render; stderr teed to a log file the user can `tail -f` for progress.
- **PACKAGE** — final MP4, ffmpeg-extracted thumbnail, manifest, README — all in `package/`.
- **ITERATE** — terminal phase. Back-edges from RENDER/PACKAGE/ITERATE auto-archive the current iteration into `archive/v<N>/` so v1 is preserved when the user iterates to v2.

## Requirements

- Node.js ≥ 22.
- **ffmpeg + ffprobe** on `PATH`. Used for source probing (INGEST) and thumbnail extraction (PACKAGE).
  - macOS: `brew install ffmpeg`
  - Debian/Ubuntu: `apt-get install ffmpeg`
  - Other: https://ffmpeg.org/download.html
- **hyperframes** (resolved via `npx hyperframes`, so `npx` must reach the package). If your environment can't reach npm, install explicitly: `npm i -g hyperframes`.

If either dependency is missing when relevant, the MCP tools fail with a clear install hint pointing back here.

## Quickstart (Claude Code adapter)

1. Clone this repo.
2. In Claude Code, invoke `/vob` (see **Invoking** below). The skill walks you through the pipeline.
3. When ITERATE completes, your output is at `~/video-vob-sessions/<project_id>/package/`.

### Invoking

`/vob` goes from raw footage to a packaged short. Launch it two ways — both land in the same flow.

**With arguments (positional):**

```
/vob <project_id> <source_path>
```

- `/vob leon-talk ~/footage/leon.mov` — names the project `leon-talk`, ingests one file.
- `/vob promo ~/footage/shoot/` — a **folder**: every media file in it is ingested into one timeline (A-roll + B-roll). Re-running `/vob` later with another path adds to the same project.

**Conversationally (args optional):**

Drop the project id, the path, or both — the skill derives what it can and asks for the rest. You can also tack on a rough idea of what you want; it's carried into the INTENT step so you aren't re-interrogated.

- `/vob ~/footage/leon.mov` — project id derived from the filename (→ `leon`).
- `/vob ~/footage/leon.mov punchy 30s TikTok, open on the bbq reveal` — path + rough idea.
- `/vob` — no args: the skill asks what footage to start from, then proceeds.

A single `source_path` may be a **file or a directory**. Supported media: `.mp4 .mov .mkv .webm .m4v .avi` (video) and `.m4a .mp3 .wav .aac .flac .ogg .opus .wma` (audio — a bare voiceover is ingested as a narration spine).

## Architecture

- **`mcp/`** — shared MCP server. FSM state, gates, transitions, tool registry, runners for hyperframes and ffmpeg. Adapter-agnostic.
- **`adapters/claude-code/`** — Claude Code-specific skill, subagents, and settings. Other CLIs will get their own adapter directory.

Session state lives at `~/video-vob-sessions/<project_id>/`. The MCP server owns `state.json` and all derived artifacts; never edit them by hand.

Licensed under [Apache 2.0](./LICENSE).
