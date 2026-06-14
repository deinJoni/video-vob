# video-vob v3.2 — PRD: Deep Inspect

**Status:** ALL THREE PILLARS SHIPPED (2026-06-14, `.vob/VERSION` → 3.2.0). v3.2 complete.
**Target version:** `.vob/VERSION` → **3.2.0** — the Deep Inspect increment ships as part of the 3.2 release (additive, fully back-compatible — no FSM edges change, all new state/artifact fields are optional with read-time defaults)

> **Implementation note (P1+P2+P3, 2026-06-14).** All three pillars built and walker-verified
> (`general`/`fanout`/`overlays`/`gaps` green). P2 audio analysis verified numerically on a live
> ingest→INSPECT; the digest both-branch rendering unit-tested. P3 classification schema (1.0→1.1)
> verified pure (back-compat 1.0 payloads pass; every new-field negative rejects) + live (counts +
> `file_roles[]` surfaced through `read_state_summary`). New files: `mcp/lib/asr/whisperx_transcribe.py`,
> `mcp/lib/audio-analysis.js`. **One live gap:** whisperx is NOT installed on this host, so P1's
> aligned path was verified via the degrade path (`transcript_aligned:false`) + driver AST parse +
> a digest unit test — the aligned end-to-end run + P3's actual tagging *quality* (vision is canned
> in the walker) both need a live `/vob` run (multi-file drop, `pip install whisperx`).
**One-line vision:** Make INSPECT *understand* the footage — every spoken word captured and timed frame-accurately (karaoke-ready), all sound inspected properly (channels, balance, loudness for later normalization), and richer multi-file visual tagging (b-roll vs main, shot type, what is shown).

---

## 1. Background

INSPECT today turns raw files into editorial primitives: a thumbnail grid, a word-level
transcript, clean-speech keep-spans, and an authoritative **segment model**
(`inspect/segments.json`) with per-segment energy/speech-rate + keyframes, then an
**inspector** subagent classifies segments into A-roll / B-roll / review pools. It is solid,
but three things are deliberately shallow:

| # | Area | What's shallow today | Where |
|---|------|----------------------|-------|
| 1 | Transcript timing | Native Whisper word timestamps — the code itself flags them "unreliable across pauses" (Whisper timestamps one word across a 2.5 s gap). Fine for cut-snapping, **not** for word-by-word karaoke. | `mcp/lib/asr-backend.js`, `mcp/lib/asr/*.py`, `mcp/lib/inspect.js` |
| 2 | Audio analysis | Audio is extracted as **mono 16 kHz** for ASR (L/R discarded). Only **per-file** LUFS/LRA/true-peak captured; no channel/balance/correlation, no per-segment loudness, no normalization advisory. | `mcp/lib/inspect.js`, `mcp/lib/silence-detector.js`, `mcp/lib/ffprobe.js` |
| 3 | Visual tagging | `shot_type` / `subject_position` / `framing_ok_for_vertical` + a B-roll `description`. No "what is shown" content fields, no on-screen text, no camera-movement, no explicit per-file roles for the multi-file case. | `mcp/lib/classification-schema.js`, `adapters/claude-code/.claude/agents/inspector.md` |

v3.2 deepens INSPECT along those three axes **without** new engine npm deps (ASR stays a
pluggable Python subprocess; audio analysis is ffmpeg; tagging is the vision-capable
inspector), without new FSM phases, and without breaking pre-v3.2 sessions.

---

## 2. Decisions locked (from review)

1. **No speaker diarization.** Two speakers may share one track; we do **not** separate or
   label them. The audio keystone is: capture **all** spoken audio robustly, and time every
   word frame-accurately so it can be **highlighted when said** (karaoke). → no pyannote, no
   HF token, no `speakers.json`, no torch-for-diarization.
2. **Forced alignment for word timing.** Whisper's native timestamps are not karaoke-grade;
   add a forced-alignment step (recommended: WhisperX's wav2vec2 alignment — alignment models
   are public, **no** HF token). Kept pluggable + degrading, exactly like the current ASR stack.
3. **Vision-LLM only for "what is shown."** No OCR/tesseract dependency. The inspector already
   reads keyframes; it reports content tags + on-screen text it sees.
4. **Full spec, all three; implement P1 → P2 → P3.**

---

## 3. Principles (inherited from v3, unchanged)

- **No new engine npm deps.** Engine stays zero-dep Node stdlib. New audio work is ffmpeg;
  alignment is a Python ASR driver (same sanctioned "external Python ASR" pattern as
  `faster_whisper_transcribe.py`); tagging is the existing vision-capable subagent.
- **Pluggable + degrade-don't-die.** Every new capability has a clean fallback: no
  alignment backend → native-timestamp transcript with `aligned:false`; no ffmpeg filter →
  current per-file LUFS only; classification fields stay optional.
- **Disk is truth; additive state.** New fields are optional with read-time defaults;
  `summarize*` helpers tolerate their absence. Pre-v3.2 `state.json` / `inspect.json` /
  `segments.json` load unchanged.
- **No FSM changes.** `INGEST→INSPECT` and `INSPECT→INTENT` gates are untouched (they check
  summary existence + acknowledgement, not these fields). No edges added.
- **Walker is the test.** Each phase extends `scripts/m5-walker.js` (the `inspect`/`general`
  paths) with positive + degraded assertions.

---

## 4. The three pillars

### P1 — Karaoke-accurate transcription (the keystone)

**Goal.** Every spoken word captured, each with a **frame-accurate** `start`/`end` and a
confidence `p`, so a later caption/karaoke renderer can highlight word-by-word.

**Approach.**

1. **New alignment-capable ASR backend** — add `whisperx` to the pluggable stack.
   - New driver `mcp/lib/asr/whisperx_transcribe.py`: transcribe (faster-whisper engine under
     the hood) **+ wav2vec2 forced alignment**, **diarization disabled**. Same CLI contract as
     the other drivers (`<audio.wav> <out.json> [model] [language]`), same single-line JSON
     envelope (`{ ok, wordCount, transcriptPath, model, language, backend, aligned }`).
   - Emits the **canonical** `[{text,start,end,p}]` — now with alignment-grade timing and a
     real per-word `p` (alignment score). No `speaker` field (locked decision 1).
   - `RUNNABLE_BACKENDS` order becomes `["whisperx", "faster-whisper", "openai-whisper",
     "hyperframes"]` (whisperx preferred when present; everything else unchanged). Detection in
     `detectAsrBackends()` probes `import whisperx` the same cheap way it probes
     `faster_whisper`.
   - Knobs (extend, don't rename): `VOB_ASR_BACKEND=whisperx|…` already exists; add
     `VOB_ALIGN` (`1` default when whisperx present / `0` to force transcribe-only) and reuse
     `VOB_ASR_DEVICE`/`VOB_ASR_COMPUTE_TYPE`/`VOB_ASR_MODEL`/`VOB_ASR_LANGUAGE`.

2. **Transcript schema — additive `aligned` marker.** Words stay `[{text,start,end,p}]`. Add a
   **document-level** marker so consumers/digest know whether timing is karaoke-grade:
   write a sidecar field via `inspect.json` (`transcript_aligned: true|false`, `asr_backend`)
   and into `transcripts[]` per-file (`aligned`). The flat word array remains the karaoke
   source of truth (no separate `karaoke.json` needed — words-with-timing *is* the karaoke
   track). `clean-cut.js` and the storyboarder consume the same array, now with better timing.

3. **Robustness ("all speak audio is clear").** Keep transcribing **every** audio file
   (already do) and keep the most-worded winner. Preserve quiet/low-confidence words rather
   than dropping them; keep feeding `collectLowConfidenceWords` (caption-risk). Document the
   recommended model bump for accuracy (`small.en` → configurable; alignment makes timing
   model-independent). Overlapping two-speaker speech is captured as best the ASR allows — we
   do not attempt to split it.

4. **Cache.** `resolvedAsrParams()` already keys the transcript cache on `{backend, model,
   language}`; adding `whisperx` as the backend naturally invalidates stale unaligned caches.
   Add `aligned` to the cached `params` so a transcribe-only cache is never served as aligned.

5. **Preflight surfacing.** Extend `checkAsrAvailable()` + `vob_doctor` + the INGEST preflight
   to report whether an **alignment-capable** backend is present, so the orchestrator can warn
   "word timing will be approximate (no alignment backend) — `pip install whisperx`" before
   INSPECT runs.

6. **Degrade.** whisperx/torch absent → fall through to faster-whisper (native timestamps,
   `aligned:false`); digest + result mark timing approximate. Karaoke still possible, just
   less precise. Nothing breaks.

**Files.** `asr-backend.js` (backend list, detection, dispatch, `resolvedAsrParams`),
new `mcp/lib/asr/whisperx_transcribe.py`, `inspect.js` (thread `aligned` into
`transcript_summary`/`inspect.json`/result), `inspect-digest.js` (timing-accuracy note),
`inspect-source.js` (surface `transcript_aligned` in result + `state.inspect`),
`doctor.js` (alignment availability), `INSPECT.md` (knob + karaoke note + re-port to OpenCode),
`scripts/m5-walker.js`.

**Acceptance.** With an alignment backend installed: `inspect.json.transcript_aligned === true`,
word `start`/`end` monotonic with no >1 s single-word spans across pauses, every word carries a
numeric `p`. Without it: `transcript_aligned === false`, run still green, digest notes
approximate timing.

---

### P2 — Audio analysis: channels + loudness for normalization

**Goal.** "All sound related inspected properly" — channel layout, L/R balance, and loudness
captured at INSPECT so later normalization/clean-up is a lookup, not a re-analysis. (No
per-speaker — diarization is out.)

**Approach.**

1. **ffprobe audio-stream enrichment** (`ffprobe.js::summarizeProbe`, carried through INGEST's
   manifest, additive). Per audio stream capture `channels`, `channel_layout`, `sample_rate`,
   `bit_depth`, `language` tag → `audio_streams_detail[]` on the manifest entry. Keep the
   scalar `audio_streams` count for back-compat. (Small INGEST touch — still "audio inspected
   properly.")

2. **New channel-analysis pass** `mcp/lib/audio-analysis.js`, run per audio file in INSPECT on
   the **original** stream (not the mono downmix):
   - per-channel `ebur128`/`astats` via `channelsplit`: integrated LUFS, RMS, peak, **silent?**
     per channel.
   - stereo metrics: **L/R balance** (dB delta), **phase correlation** (`aphasemeter` →
     mono-compat / out-of-phase risk), **dual-mono** detection (L≈R), **dead-channel**
     detection (one side silent — extremely common, one lav on L only).
   - per-stream/file classification: `layout` (`mono`/`stereo`/`dual_mono`/`multi`),
     `balance` (`left`/`right`/`center`), and a **clean-voice-vs-ambient** heuristic
     (loudness + LRA + speech overlap) — sharpens both winner selection and a future mix
     decision.
   - → `inspect/audio_analysis.json` + `state.inspect.audio`.

3. **Loudness / normalization model.** Extend the existing feature chain + add aggregation:
   - keep per-file integrated LUFS / LRA / true-peak.
   - add **per-segment loudness** to `segments.json` (today only `energy_rms_db`): cheap path
     is an LUFS-proxy derived from the 0.5 s energy windows we already compute; document the
     option of a true per-segment ebur128 if proxy proves insufficient.
   - add a **`normalization` advisory**: target **−14 LUFS** (matching the existing PACKAGE
     `loudnorm.js` so they're consistent), per-file gain delta, **true-peak clip risk**
     (`true_peak > −1 dBTP`), and a **quiet/loud flag** per file ("guest too quiet" surfaced
     even without per-speaker split). → `state.inspect.audio.normalization`.

4. **`clean_audio_source` hint.** Recommend which file/stream is the clean voice track (vs
   camera scratch) from the channel + loudness signals — consumed later by the
   storyboarder/composer audio choice.

5. **Knobs.** `VOB_DISABLE_AUDIO_ANALYSIS` (degrade to current per-file LUFS only), reuse
   `durationAwareTimeout` for the pass; exotic-build fallback (`MISSING_FILTER_RE` pattern from
   `silence-detector.js`) so a build lacking `aphasemeter`/`channelsplit` degrades, never aborts.

6. **Digest.** New "Audio" section: per-file LUFS, channel layout, balance, clip risk,
   recommended clean track.

**Files.** `ffprobe.js`, `ingest-file.js` (carry `audio_streams_detail`), new
`mcp/lib/audio-analysis.js`, `inspect.js` (run pass, write artifact, stamp state, per-segment
loudness), `segment-signals.js` (per-segment loudness field), `paths.js`
(`inspectAudioAnalysisPath`), `inspect-digest.js` (Audio section), `inspect-source.js`
(surface `audio` summary), `INSPECT.md` (+ re-port), `scripts/m5-walker.js`.

**Acceptance.** `inspect/audio_analysis.json` exists with per-channel LUFS + balance +
correlation; a synthetic L-only / dual-mono / out-of-phase clip is correctly flagged;
`state.inspect.audio.normalization` carries a −14-referenced gain delta + clip-risk; digest
Audio section renders. `VOB_DISABLE_AUDIO_ANALYSIS=1` degrades cleanly.

---

### P3 — Visual tagging overhaul (multi-file, what-is-shown)

**Goal.** Richer, more structured visual understanding — distinguish b-roll vs main shots
across files, capture shot type, camera movement, setting, on-screen text, and **what is
shown** — with the multi-file case first-class.

**Approach.**

1. **Richer classification schema** (`classification-schema.js`, all **optional**,
   validated only-when-present so pre-v3.2 payloads pass; bump `SCHEMA_VERSION` 1.0 → 1.1):
   - shared/ref add: `camera_movement` enum (`static`/`pan`/`tilt`/`handheld`/`zoom`/`drone`/
     `other`), `setting` enum (`indoor`/`outdoor`/`studio`/`screen`/`graphic`/`other`),
     `content_tags[]` (free strings — subjects/objects), `on_screen_text` (string, vision-read),
     `action` (string). Keep `shot_type`/`subject_position`/`framing_ok_for_vertical`.
   - A-roll add: `content_description` (what's shown beyond the words), `eyes_to_camera` (bool).
   - B-roll add: `b_roll_role` enum (`establishing`/`detail`/`illustrative`/`action`/
     `transition`), keep required `description`, gain `content_tags`/`camera_movement`/
     `setting`/`on_screen_text`.
   - **New top-level `file_roles[]`**: `{file_index, role: primary_aroll|broll|narration|mixed,
     summary}` — the explicit multi-file map. Optional; validated when present.

2. **`save-classification.js`.** Validate the new fields + `file_roles[]`; add derived counts
   to `state.inspect.classification` (`content_tagged_count`, `on_screen_text_count`,
   `file_role_count`) and to `read-state-summary.js`. Counts are **quality notes, never
   gates** (consistent with today's `visual_coverage`).

3. **`inspector.md` upgrade.** Read keyframes/strips and report the richer fields including
   **on-screen text it sees** (vision-LLM, no OCR), assign **per-file roles**, and **group
   cross-file b-roll** ("3 angles of the same action"). Emphasize the multi-file workflow.
   Stays read-only-upstream + single `vob_save_classification` write.

4. **Engine help (light).** Keep the existing per-file `stream_layout_prior`
   (narration/broll/null) as the role seed; ensure strips/keyframes give the inspector enough
   coverage for B-roll judgment. No OCR pass, no new deps.

5. **Re-port + drift guard.** After editing `inspector.md` / `INSPECT.md`, run
   `node scripts/port-adapter-docs.js` (OpenCode mirror). New schema fields don't change the
   allow-lists, so the boot drift guard is unaffected.

**Files.** `classification-schema.js`, `save-classification.js`, `read-state-summary.js`,
`adapters/claude-code/.claude/agents/inspector.md`, `INSPECT.md`, OpenCode mirror via
`port-adapter-docs.js`, `scripts/m5-walker.js` (classification positive/negative paths for new
fields).

**Acceptance.** A multi-file fixture classifies with `file_roles[]` populated, B-roll clips
carry `b_roll_role` + `content_tags`, on-screen-text fields populate where present; pre-v3.2
classification payloads (no new fields) still validate; `state.inspect.classification` carries
the new counts; walker green on both paths.

---

## 5. Cross-cutting

- **Schema versions:** classification 1.0 → 1.1; `segments.json` stays 1.1 doc-version but
  gains an optional per-segment loudness field (additive, no cache invalidation — the
  detection cache keys on `SEGMENT_SCHEMA_VERSION`, untouched). Transcript gains a doc-level
  `aligned` marker (not a per-word breaking change).
- **`.vob/VERSION`:** 3.2.0 on completion (folded into the 3.2 release).
- **Gates:** none change. `INSPECT→INTENT` still checks summary existence + acknowledgement.
- **State:** all additions optional with read-time defaults; `summarizeInspect` extended for
  the new `audio` / alignment / classification-count fields.
- **No Docker, latest versions** (standing feedback): alignment/whisperx installed natively;
  pin nothing.

## 6. Open items to confirm at P1 start (quick preflight, not a blocker to the spec)

- **Exact alignment package.** Recommended: WhisperX alignment (wav2vec2, public models, no HF
  token). Lighter alternative if torch is unwanted on a host: `stable-ts` (refines
  faster-whisper timestamps, no wav2vec2). A one-shot probe on the target host at P1 start
  picks between them; the backend abstraction makes the choice swappable. Either way
  faster-whisper native remains the always-available degrade.
- **Per-segment loudness:** energy-window proxy first; escalate to true per-segment ebur128
  only if the proxy is too coarse for the normalization advisory.

## 7. Out of scope (explicitly)

- Speaker diarization / labels / separation (locked out).
- OCR dependency (vision-LLM only).
- Applying normalization at INSPECT (INSPECT *captures*; leveling lands at COMPOSE/PACKAGE).
- New FSM phases, new external npm deps, stock/AI b-roll.
