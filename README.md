# video-vob

An open-source, agent-driven video pipeline. Users drop raw video plus a rough idea of what they want, and an interactive FSM walks them through ingest → inspect → intent → plan → composition → preview → render → package → iterate, producing a finished short-form video. The render engine is [hyperframes](https://github.com/heygen-com/hyperframes) (Apache 2.0). The orchestrator runs inside an agentic CLI (Claude Code and OpenCode today; Kimi-CLI, Codex CLI, and Cursor planned) via a thin CLI-specific adapter on top of a shared MCP server.

**Version 2.0.** The full pipeline is implemented end-to-end:

- **INGEST** — ffprobe-driven manifest of source footage.
- **INSPECT** — thumbnail grid, mono audio extract, word-level transcript via a pluggable local ASR backend (faster-whisper → openai-whisper → hyperframes), segment split, clean-cut analysis, contact strips, and a digest with ranked hook candidates. Forces the orchestrator to surface real content before INTENT begins.
- **INTENT** — adaptive intent: the orchestrator proposes the five required answers from the INSPECT classification and asks only the genuine gaps; platform and duration are canonicalized server-side.
- **PLAN** — the single planning gate (merged former BRIEF + STORYBOARD): the orchestrator drafts a markdown brief (with a binding Design language section) and the `storyboarder` subagent produces a structured scene plan validated by a save-time plan lint; both are presented together for one explicit user sign-off.
- **COMPOSE** — `composer` subagent authors hyperframes HTML/CSS/JS against a shipped font kit; engine QC + lint + an orchestrator snapshot self-QC catch visual mistakes before you see a draft.
- **PREVIEW** — draft render with duration-drift verification; user reviews.
- **RENDER** — full-quality render; stderr teed to a log file the user can `tail -f` for progress.
- **PACKAGE** — final MP4 loudness-normalized to −14 LUFS, hook-aware thumbnail, manifest, README — all in `package/`.
- **ITERATE** — terminal phase. Back-edges from RENDER/PACKAGE/ITERATE auto-archive the current iteration into `archive/v<N>/` so v1 is preserved when the user iterates to v2.

## Requirements

- Node.js ≥ 22.
- **ffmpeg + ffprobe** on `PATH`. Used for source probing (INGEST) and thumbnail extraction (PACKAGE).
  - macOS: `brew install ffmpeg`
  - Debian/Ubuntu: `apt-get install ffmpeg`
  - Other: https://ffmpeg.org/download.html
- **hyperframes** — install globally (`npm i -g hyperframes`); the engine resolves the installed binary once per process and pins it for the whole run (no npx, no auto-update mid-pipeline).
- Optional but recommended: `pip install faster-whisper` for transcription.

If either dependency is missing when relevant, the MCP tools fail with a clear install hint pointing back here.

## Install

video-vob is a *template* you install into a target project with `install.sh`. It copies the shared `mcp/` engine plus your chosen adapter's CLI config into the target:

```bash
./install.sh <target_dir> [adapter]   # adapter defaults to claude-code
```

- `./install.sh ~/my-video-project` — Claude Code adapter (drops `.claude/` + `.mcp.json`).
- `./install.sh ~/my-video-project opencode` — OpenCode adapter (drops `.opencode/` + `opencode.json`).

Run `./install.sh` with no arguments to list the available adapters. Then `cd <target_dir>` and launch your CLI. Existing `opencode.json`/`.mcp.json`/`.claude/settings.json` in the target are backed up to `*.pre-vob.bak` before being overwritten.

## Quickstart

1. Install into a target directory (above), or work directly in this repo.
2. Launch your CLI and invoke `/vob` (see **Invoking** below). The orchestrator walks you through the pipeline.
3. When ITERATE completes, your output is at `~/video-vob-sessions/<project_id>/package/`.

**Claude Code:** `/vob` is a skill. **OpenCode:** `/vob` is a command that runs the `vob` primary agent — you can also just select the `vob` agent (Tab) and describe your footage. Both share the identical pipeline and the same MCP engine.

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

**Inherit a past project's style:**

Add `--like <past_project>` (or just say "same style as <past_project>") to start a new project from a previous one's design. Its tone, platform, duration, and caption/visual treatment carry over; the new footage's content (key moments, cuts) is derived fresh. Handy for a recurring series or a consistent brand look — instead of re-describing the style each time, point at the project you liked.

- `/vob promo ~/footage/new.mov --like bbq-talk` — new project `promo`, styled after the existing `bbq-talk`.

The named project must already exist; the new project records the lineage (you'll see `Styled after: bbq-talk` in its package manifest/README). `--like` only applies when creating a **new** project — resuming an existing project keeps its original lineage (you can't change the inherited style retroactively).

A single `source_path` may be a **file or a directory**. Supported media: `.mp4 .mov .mkv .webm .m4v .avi` (video) and `.m4a .mp3 .wav .aac .flac .ogg .opus .wma` (audio — a bare voiceover is ingested as a narration spine).

## Architecture

- **`mcp/`** — shared MCP server. FSM state, gates, transitions, tool registry, runners for hyperframes and ffmpeg, plus engine-side quality enforcement: a save-time plan lint on storyboards and a static QC scan on compositions. Adapter-agnostic.
- **`adapters/claude-code/`** — Claude Code adapter: a `/vob` skill (orchestrator), three subagents, settings, and hooks.
- **`adapters/opencode/`** — OpenCode adapter: a `vob` primary agent (orchestrator), three `mode: subagent` workers, a `/vob` command, `opencode.json` (MCP registration + permissions), and a session write-guard plugin.

Both adapters bind the *same* engine; the MCP server is the single source of truth for the FSM. Adapters never duplicate engine logic — see [`adapters/README.md`](./adapters/README.md). The orchestrator prompt is a slim spine plus per-phase procedure files read on phase entry (`.claude/skills/vob/phases/` on Claude Code, `.opencode/vob/phases/` on OpenCode).

Session state lives at `~/video-vob-sessions/<project_id>/`. The MCP server owns `state.json` and all derived artifacts; never edit them by hand.

> **OpenCode + long renders:** OpenCode caps how long a single MCP tool call may run, and that ceiling can be shorter than a full render (≤30 min). If a render is killed by OpenCode (not by hyperframes) before finishing, it's still progressing in the log — point at the `stderr_log_path`, retry, or record an out-of-band-completed render with `vob_import_deliverable`. `opencode.json` sets a high `mcp.vob.timeout`, but some OpenCode versions cap tool execution separately.

## What the pipeline checks for you

- **Plan lint** — every storyboard save is content-validated: out-of-range clips, captions on silent footage, and narration-span violations reject the save; hook placement/length, duration drift, B-roll holds, and key-moment coverage surface as warnings at the plan sign-off.
- **Composition QC** — a static scan of the composed HTML at save and lint time: broken `./source/` references, absolute paths, missing timing attributes, and too many `<video>` elements for the render host are caught before any render starts.
- **Snapshot self-QC** — before showing you a draft, the orchestrator renders still frames of the composition and checks captions against safe bands, legibility, empty frames, overlay collisions, and the hook frame — and re-revises the composition itself for glaring failures.
- **Render verification** — every preview/full render is ffprobe-verified against the storyboard; a duration drift over 0.5s is flagged as silent truncation instead of being presented as done.
- **Loudness normalization** — the packaged final is two-pass loudness-normalized to −14 LUFS / −1 dBTP (platform standard); opt out with `VOB_NO_LOUDNORM=1`.

Licensed under [Apache 2.0](./LICENSE).
