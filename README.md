# video-vob

An open-source, agent-driven video pipeline. Users drop raw video plus a rough idea of what they want, and an interactive FSM walks them through ingest → inspect → intent → plan → composition → preview → render → package → iterate, producing a finished short-form video. The render engine is [hyperframes](https://github.com/heygen-com/hyperframes) (Apache 2.0). The orchestrator runs inside an agentic CLI (Claude Code and OpenCode today; Kimi-CLI, Codex CLI, and Cursor planned) via a thin CLI-specific adapter on top of a shared MCP server.

**Version 2.1.** The pipeline is implemented end-to-end, enforces quality engine-side at every gate, and produces **one short or many from a single source**.

## How it works

`/vob` runs a state machine. Each phase has a precondition gate that checks the artifacts on disk (not just a status flag), so you can't skip a step or advance on stale work. Phases that need your sign-off follow **save → confirm → transition**; the human approval at INSPECT, PREVIEW, and RENDER cannot be overridden by the agent. All durable state lives in `~/video-vob-sessions/<project_id>/` and is written *only* by MCP tools — the markdown and JSON artifacts you see (brief, storyboard, composition) are derived from it.

The nine phases:

- **INGEST** — `ffprobe` builds a manifest of every source file (codec, dimensions, fps, duration, display rotation). A folder ingests every media file into one timeline; re-running `/vob` with another path appends to the same project. A dependency preflight (ASR / ffmpeg / hyperframes) is recorded here so a dead transcription path surfaces *before* INSPECT spends minutes on it.
- **INSPECT** — the "look at the footage" pass, and the one that forces the agent to see real content before planning. It extracts a downscaled thumbnail grid + per-file contact strips, a mono audio track, per-file loudness (LUFS) and per-segment energy/speech-rate, splits the source into segments (scene detection — skippable on long single-shots), and transcribes via a **pluggable local ASR backend** (faster-whisper → openai-whisper → hyperframes, falling through on failure). A **clean-cut** analysis turns the transcript + a silence map into filler- and dead-air-free keep-spans. It writes `inspect/digest.md` with ranked **hook candidates**, then the `inspector` subagent classifies segments into an A-roll pool / B-roll index / review bucket. You acknowledge the findings to proceed (non-overridable).
- **INTENT** — adaptive, *infer-then-confirm* rather than an interrogation. The orchestrator proposes the five required answers from your rough idea + the digest + the classification, pre-records the confident ones, and asks only the genuine gaps. The five keys are `target_platform`, `target_duration`, `tone`, `key_moments`, `music_vo`; platform and duration are **canonicalized server-side** (e.g. `tiktok` → dimensions/fps/safe-bands/caption defaults; `"20–35s"` → a parsed range). Conditional follow-ups (`audio_treatment`, `captions_style`) appear only when the audio makes them relevant. **This is where multi-short fan-out is detected** (see *Modes* below).
- **PLAN** — the single planning gate (merged former BRIEF + STORYBOARD). The orchestrator drafts a markdown brief with a binding *Design language* section, and the `storyboarder` subagent turns brief + manifest into a structured `storyboard.json` validated by a **save-time plan lint** (out-of-range clips, captions on silent footage, and narration-span violations *reject* the save; hook placement/length, duration drift, B-roll holds, and key-moment coverage ride along as *warnings*). Brief and storyboard are presented together for **one** human sign-off.
- **COMPOSE** — entering COMPOSE pre-cuts every storyboard clip into its own H.264 file (cached, so back-edge re-entry is free). The `composer` subagent then authors hyperframes HTML/CSS/JS against the shipped **font kit** (23 families incl. Simplified-Chinese 中文). The save runs a static **QC scan** *and* the full merged lint engine-side and returns the verdict, so the composer self-corrects to a clean save before handoff. The orchestrator then renders **still frames and self-QCs** them (captions in safe bands, legibility, empty frames, overlay collisions, the hook frame) before you ever see a draft. Lint errors block the next phase; warnings are yours to accept or fix.
- **PREVIEW** — a draft render via hyperframes. The result is ffprobe-verified against the storyboard — a duration drift over 0.5s is flagged as silent truncation rather than presented as done. stderr is teed to a log file you can `tail -f`. You confirm (non-overridable) or back-edge to fix.
- **RENDER** — the full-quality render, with the same drift verification. It stamps the composition revision it rendered, so the preview→render and render→package gates refuse a stale cut. You confirm (non-overridable) to advance.
- **PACKAGE** — the final MP4 is two-pass loudness-normalized to **−14 LUFS / −1 dBTP** (platform standard; opt out with `VOB_NO_LOUDNORM=1`), with a hook-aware thumbnail, a manifest, and a README — all in `package/`. (Fan-out projects package the *deliverables set* instead — see *Modes*.)
- **ITERATE** — terminal. Back-edges from RENDER / PACKAGE / ITERATE **auto-archive** the current cut into `archive/v<N>/` and bump the iteration version, so a prior version is never lost when you iterate to the next one.

Back-edges are explicit (e.g. `PREVIEW → PLAN` when the cut plan is wrong, `ITERATE → COMPOSE` for a post-package tweak); the FSM never patches forward.

## Requirements

- Node.js ≥ 22. The MCP server has **zero npm dependencies** (pure Node stdlib).
- **ffmpeg + ffprobe** on `PATH`. Used for probing, thumbnails, clip pre-cutting, and packaging.
  - macOS: `brew install ffmpeg`
  - Debian/Ubuntu: `apt-get install ffmpeg`
  - Other: https://ffmpeg.org/download.html
- **hyperframes** — install globally (`npm i -g hyperframes`); the engine resolves the installed binary once per process and pins it for the whole run (no npx, no auto-update mid-pipeline).
- **A local ASR backend** for transcription — `pip install faster-whisper` is the recommended one. Optional but strongly recommended: without it, narration can't become burned captions. (hyperframes' embedded whisper-cpp is the last-resort fallback.)

Run **`vob_doctor`** at the start of a session (the orchestrator does this automatically) to preflight all of the above plus host RAM and the derived render-worker / encode-concurrency ceilings. It only fails hard on a missing ffmpeg/ffprobe; a missing ASR engine is a warning. Missing dependencies surface as MCP tool errors with a clear install hint.

## Install

video-vob is a *template* you install into a target project with `install.sh`. It copies the shared `mcp/` engine plus your chosen adapter's CLI config into the target:

```bash
./install.sh <target_dir> [adapter]   # adapter defaults to claude-code
```

- `./install.sh ~/my-video-project` — Claude Code adapter (drops `.claude/` + `.mcp.json`).
- `./install.sh ~/my-video-project opencode` — OpenCode adapter (drops `.opencode/` + `opencode.json`).

Run `./install.sh` with no arguments to list the available adapters. Then `cd <target_dir>` and launch your CLI. Existing `opencode.json` / `.mcp.json` / `.claude/settings.json` in the target are backed up to `*.pre-vob.bak` before being overwritten.

## Quickstart

1. Install into a target directory (above), or work directly in this repo.
2. Launch your CLI and invoke `/vob` (see **Invoking** below). The orchestrator walks you through the pipeline, pausing for your sign-off at INSPECT, PLAN, PREVIEW, and RENDER.
3. When ITERATE completes, your output is at `~/video-vob-sessions/<project_id>/package/` (one short) or `~/video-vob-sessions/<project_id>/deliverables/` (multiple shorts).

**Claude Code:** `/vob` is a skill. **OpenCode:** `/vob` is a command that runs the `vob` primary agent — you can also just select the `vob` agent (Tab) and describe your footage. Both share the identical pipeline and the same MCP engine.

## Invoking

`/vob` goes from raw footage to a packaged short. Launch it two ways — both land in the same flow.

**With arguments (positional):**

```
/vob <project_id> <source_path>
```

- `/vob leon-talk ~/footage/leon.mov` — names the project `leon-talk`, ingests one file.
- `/vob promo ~/footage/shoot/` — a **folder**: every media file in it is ingested into one timeline (A-roll + B-roll). Re-running `/vob` later with another path adds to the same project.

**Conversationally (args optional):**

Drop the project id, the path, or both — the orchestrator derives what it can and asks for the rest. You can also tack on a rough idea of what you want; it's carried into the INTENT step so you aren't re-interrogated.

- `/vob ~/footage/leon.mov` — project id derived from the filename (→ `leon`).
- `/vob ~/footage/leon.mov punchy 30s TikTok, open on the bbq reveal` — path + rough idea.
- `/vob` — no args: the orchestrator asks what footage to start from, then proceeds.

**Resume** by passing just the existing `project_id` (no path needed): the orchestrator reads the saved state and picks up at the first incomplete step of whatever phase you left off in.

A single `source_path` may be a **file or a directory**. Supported media: `.mp4 .mov .mkv .webm .m4v .avi` (video) and `.m4a .mp3 .wav .aac .flac .ogg .opus .wma` (audio — a bare voiceover is ingested as a narration spine).

## Modes

The same rails produce different outputs depending on what you ask for. None of these are separate commands — they're inferred from how you invoke `/vob` and what you say at INTENT.

### One short → many shorts (multi-short fan-out)

Ask for **multiple** shorts from one source and the pipeline fans out. It's detected at INTENT — say *"3 shorts"*, or give a per-deliverable duration like *"20–35s per short"* (or *"each"*) — and from there:

1. **PLAN once for the whole set.** The storyboarder emits a `shorts[]` storyboard (one timeline per short, globally unique scene ids, per-short plan lint with `[short_id]`-tagged findings). **One** sign-off covers all N.
2. **COMPOSE → PREVIEW → RENDER cycles per short.** Saving a composition with a `short_id` scopes QC, render timeouts, and drift checks to the active short; the orchestrator tells you "short *k* of N".
3. **Each finished short is recorded and loudness-normalized**, then the run back-edges to COMPOSE for the next one (archival keeps everything; the recorded copy is already safe).
4. **PACKAGE is the deliverables set.** Finished shorts land in a session-level `deliverables/` directory with a `deliverables/manifest.json`; the single-timeline packager is refused so it can't wipe them. Completeness gates block reaching ITERATE until every short has a record.
5. **Revise one short later** via an `ITERATE → COMPOSE` back-edge: recompose/render exactly that `short_id` and its record (and file) is replaced — the others stand untouched.

### Inherit a past project's style (`--like`)

Add `--like <past_project>` (or just say "same style as <past_project>") to start a new project from a previous one's design. Its tone, platform, duration, and caption/visual treatment carry over; the new footage's content (key moments, cuts) is derived fresh. Handy for a recurring series or a consistent brand look — instead of re-describing the style each time, point at the project you liked.

- `/vob promo ~/footage/new.mov --like bbq-talk` — new project `promo`, styled after the existing `bbq-talk`.

The named project must already exist; the new project records the lineage (you'll see `Styled after: bbq-talk` in its package manifest/README). `--like` only applies when creating a **new** project — resuming an existing project keeps its original lineage (you can't change the inherited style retroactively).

### Off-rails builds (escape hatch)

When hyperframes' continuous `<video>` capture is too fragile for a given cut, the pipeline supports rendering graphics as a **transparent overlay** and compositing them over an ffmpeg-cut base, plus any other bespoke ffmpeg/hyperframes build, inside a sanctioned `<session>/work/` scratch dir. The finished file is recorded with `vob_import_deliverable` (optionally loudness-normalized with the same −14 LUFS pass), so `state.json` never lies about finished work even when it came off the rails. This is an advanced path the orchestrator reaches for only when the standard render is the wrong tool.

## Architecture

- **`mcp/`** — shared MCP server. FSM state, gates, transitions, tool registry, runners for hyperframes and ffmpeg, plus engine-side quality enforcement: a save-time plan lint on storyboards and a static QC scan on compositions. Adapter-agnostic and the single source of truth for the FSM.
- **`adapters/claude-code/`** — Claude Code adapter: a `/vob` skill (orchestrator), three subagents, settings, and hooks.
- **`adapters/opencode/`** — OpenCode adapter: a `vob` primary agent (orchestrator), three `mode: subagent` workers, a `/vob` command, `opencode.json` (MCP registration + permissions), and a session write-guard plugin.

Both adapters bind the *same* engine; the MCP server is the single source of truth for the FSM. Adapters never duplicate engine logic — see [`adapters/README.md`](./adapters/README.md). The orchestrator prompt is a slim spine plus per-phase procedure files read on phase entry (`.claude/skills/vob/phases/` on Claude Code, `.opencode/vob/phases/` on OpenCode). Three subagents do the narrow, write-scoped work — `inspector` (classify INSPECT segments), `storyboarder` (write the storyboard), `composer` (write the hyperframes composition) — each with a single write tool and read-only access upstream.

Session state lives at `~/video-vob-sessions/<project_id>/`. The MCP server owns `state.json` and all derived artifacts; never edit them by hand (a write-guard enforces this).

> **OpenCode + long renders:** OpenCode caps how long a single MCP tool call may run, and that ceiling can be shorter than a full render (≤30 min). If a render is killed by OpenCode (not by hyperframes) before finishing, it's still progressing in the log — point at the `stderr_log_path`, retry, or record an out-of-band-completed render with `vob_import_deliverable`. `opencode.json` sets a high `mcp.vob.timeout`, but some OpenCode versions cap tool execution separately.

## What the pipeline checks for you

- **Plan lint** — every storyboard save is content-validated: out-of-range clips, captions on silent footage, and narration-span violations reject the save; hook placement/length, duration drift, B-roll holds, and key-moment coverage surface as warnings at the plan sign-off. On a fan-out plan, lint runs per short.
- **Composition QC** — a static scan of the composed HTML at save and lint time: broken `./source/` references, absolute paths, missing timing attributes, and too many `<video>` elements for the render host are caught before any render starts. It mirrors hyperframes' own clip-class rule exactly and dedupes against the linter's findings.
- **Snapshot self-QC** — before showing you a draft, the orchestrator renders still frames of the composition and checks captions against safe bands, legibility, empty frames, overlay collisions, and the hook frame — and re-revises the composition itself for glaring failures.
- **Render verification** — every preview/full render is ffprobe-verified against the storyboard; a duration drift over 0.5s is flagged as silent truncation instead of being presented as done.
- **Loudness normalization** — the packaged final (and every fan-out deliverable) is two-pass loudness-normalized to −14 LUFS / −1 dBTP; opt out with `VOB_NO_LOUDNORM=1`.

## Tuning for your machine

The performance constraints are RAM-derived by default (a render is pinned to one worker and the `<video>` budget is conservative on an 8 GB laptop). On a bigger server you can lift them — **per install dir, no source edits, two interchangeable ways**:

**1. A committed `.vob-config/host.json`** (copy `.vob-config/host.example.json`). A single `capacity` shortcut expands to a bundle; per-key fields override individual values:

```jsonc
{ "capacity": "high" }                      // low | medium | high — one knob, whole bundle
// …or pick individual values:
{ "render_workers": 6, "encode_concurrency": 4, "video_budget": 12, "video_hard_cap": 16 }
```

**2. `VOB_*` env vars** in the MCP launch config's `env` block — handy for ephemeral / per-host overrides without committing a file:

```jsonc
// .mcp.json (Claude Code) — or the equivalent env block in opencode.json
{ "mcpServers": { "vob": { "command": "node", "args": ["./mcp/server.js"],
  "env": { "VOB_RENDER_WORKERS": "4", "VOB_ENCODE_CONCURRENCY": "4", "VOB_VIDEO_BUDGET": "12", "VOB_VIDEO_HARD_CAP": "16" } } } }
```

Tunable settings: `render_workers` / `VOB_RENDER_WORKERS` (a positive int skips hyperframes' slow worker calibration; `"auto"` defers to it), `encode_concurrency` / `VOB_ENCODE_CONCURRENCY` (simultaneous heavy H.264 encodes), `render_quality` / `VOB_RENDER_QUALITY`, `video_budget` / `VOB_VIDEO_BUDGET` and `video_hard_cap` / `VOB_VIDEO_HARD_CAP` (the composition-QC `<video>`-element warn/error thresholds — raise these to allow richer multi-clip edits on a host that can take it), and `browser_gpu` / `VOB_BROWSER_GPU` (GL backend; `software`/`hardware`/`auto`).

**Precedence per setting:** explicit env var → `host.json` per-key → `host.json` `capacity` tier → RAM-derived default. With no `host.json` and no env, behavior is unchanged. Run `vob_doctor` to see the **resolved effective value and where each came from** (`report.tuning`).

Licensed under [Apache 2.0](./LICENSE).
