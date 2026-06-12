# INGEST — probe the source into the manifest
Spine rules 1, 4, 11 apply.

## Read sites
| step | source | fields |
|---|---|---|
| 2 | `vob_ingest_file` result | `files[]` (`duration_seconds`, `primary_video.width/height/codec`, `audio_streams`), `file_count` |
| 3 | `vob_ingest_file` result | `dependency_failures[]` (`name`, `error`, `hint`), `rotation_warning` |

1. Call `vob_vob_ingest_file { project_id, source_path }`.

2. Report what was found in plain language, e.g. "ingested 1 file: 12.3s of 1920x1080 h264 + 1
   audio track". Pull the numbers from the result's `files[]` summaries.

3. The result no longer echoes the full toolchain preflight — it carries dependency FAILURES
   only (`dependency_failures[]`, each with an install `hint`). If an `asr` failure is present,
   warn now (`pip install faster-whisper`, or plan `skip_transcription:true` at INSPECT) rather
   than after INSPECT. If `rotation_warning` is non-null, mention the DJI autorotate gotcha
   (`VOB_DISABLE_AUTOROTATE=1` if outputs come out sideways).

4. If the tool errors with `ffprobe not found on PATH`, surface the install hint to the user and
   stop. They need to install ffmpeg before continuing.

5. Call `vob_vob_transition_phase { project_id, to_phase: "INSPECT" }`, then read
   `.opencode/vob/phases/INSPECT.md` per the spine's phase-file protocol.
