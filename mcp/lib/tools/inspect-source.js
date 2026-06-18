"use strict";

const { ERROR_CODES, ToolError } = require("../envelope.js");
const {
  assertSafeProjectId,
  inspectAudioPath,
  inspectSummaryPath,
  inspectThumbsDir,
  inspectTranscriptPath,
  segmentsPath,
  statePath,
} = require("../paths.js");
const { readJsonFile, withSessionLock, writeFileAtomic } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");
const { runInspect, DEFAULT_THUMB_INTERVAL_SECONDS } = require("../inspect.js");

function nowIso() {
  return new Date().toISOString();
}

async function inspectSource(args) {
  const id = assertSafeProjectId(args && args.project_id);
  const rawInterval = args && args.thumb_interval_seconds;
  // null = let runInspect scale the default by source duration; an explicit
  // value is honored verbatim.
  const intervalSeconds = rawInterval == null ? null : Number(rawInterval);
  if (intervalSeconds != null && (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0)) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      "thumb_interval_seconds must be a positive number",
    );
  }
  const skipTranscription = args && args.skip_transcription === true;
  const skipSceneDetection = args && args.skip_scene_detection === true;
  const skipThumbnails = args && args.skip_thumbnails === true;

  // Read state outside the lock since this is a long-running operation
  // (transcription can take minutes). Hold the lock only for the final state
  // write to keep concurrent reads responsive.
  const state = readSessionStateStrict(id);
  if (state.phase !== "INSPECT") {
    throw new ToolError(
      ERROR_CODES.STATE_CONFLICT,
      `vob_inspect_source requires phase INSPECT, current phase is ${state.phase}. Call vob_transition_phase { to_phase: "INSPECT" } first.`,
    );
  }
  if (!state.manifest || typeof state.manifest.path !== "string") {
    throw new ToolError(
      ERROR_CODES.NOT_FOUND,
      "no manifest recorded in state — INGEST must complete before INSPECT",
    );
  }
  let manifest;
  try {
    manifest = readJsonFile(state.manifest.path);
  } catch (error) {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `manifest.json could not be read: ${error.message || String(error)}`,
    );
  }

  const summary = await runInspect({
    projectId: id,
    manifest,
    options: {
      thumb_interval_seconds: intervalSeconds,
      skip_transcription: skipTranscription,
      skip_scene_detection: skipSceneDetection,
      skip_thumbnails: skipThumbnails,
    },
  });

  return withSessionLock(id, () => {
    const stateNow = readSessionStateStrict(id);
    const ts = nowIso();
    const next = {
      ...stateNow,
      inspect: {
        summary_path: inspectSummaryPath(id),
        thumbs_dir: inspectThumbsDir(id),
        thumb_count: summary.thumb_count,
        thumb_failed_count: summary.thumb_failed_count || 0,
        thumbnails_skipped: summary.thumbnails_skipped === true,
        thumb_seek_modes: summary.thumb_seek_modes || [],
        thumb_interval_seconds: summary.thumb_interval_seconds,
        sample_thumb_paths: summary.sample_thumb_paths || [],
        contact_sheet_paths: summary.contact_sheet_paths || [],
        warnings: Array.isArray(summary.warnings) ? summary.warnings : [],
        audio_present: summary.audio_present,
        audio_path: summary.audio_present ? inspectAudioPath(id) : null,
        speech_detected: summary.speech_detected,
        asr_backend: summary.asr_backend || null,
        transcript_aligned: summary.transcript_aligned === true,
        audio_analysis_path: summary.audio_analysis_path || null,
        audio: summary.audio || null,
        scene_detection_skipped: summary.scene_detection_skipped === true,
        transcript_path: summary.transcript_path ? inspectTranscriptPath(id) : null,
        transcript_summary_path: summary.transcript_summary_path || null,
        transcript_paragraphs_path: summary.transcript_paragraphs_path || null,
        paragraph_count: summary.paragraph_count || 0,
        word_count: summary.word_count,
        segments_path: summary.segment_count > 0 ? segmentsPath(id) : null,
        segment_count: summary.segment_count || 0,
        segment_keyframe_count: summary.segment_keyframe_count || 0,
        skipped_reason: summary.skipped_reason,
        clean_speech_path: summary.clean_speech_path || null,
        digest_path: summary.digest_path || null,
        strips_legend_path: summary.strips_legend_path || null,
        strip_count: summary.strip_count || 0,
        transcripts: summary.transcripts || [],
        hook_candidate_count: summary.hook_candidate_count || 0,
        take_quality: summary.take_quality || null,
        completed_at: ts,
        user_acknowledged: false,
        acknowledged_at: null,
      },
      last_updated: ts,
      history: [
        ...(Array.isArray(stateNow.history) ? stateNow.history : []),
        {
          kind: "inspect_completed",
          at: ts,
          thumb_count: summary.thumb_count,
          warning_count: Array.isArray(summary.warnings) ? summary.warnings.length : 0,
          audio_present: summary.audio_present,
          speech_detected: summary.speech_detected,
          word_count: summary.word_count,
          skipped_reason: summary.skipped_reason,
          digest_built: Boolean(summary.digest_path),
          transcript_cache_hits: summary.transcript_cache_hits || 0,
        },
      ],
    };
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);

    return {
      summary_path: next.inspect.summary_path,
      thumbs_dir: next.inspect.thumbs_dir,
      thumb_count: summary.thumb_count,
      thumb_failed_count: next.inspect.thumb_failed_count,
      thumbnails_skipped: next.inspect.thumbnails_skipped,
      thumb_seek_modes: next.inspect.thumb_seek_modes,
      thumb_interval_seconds: summary.thumb_interval_seconds,
      sample_thumb_paths: next.inspect.sample_thumb_paths,
      contact_sheet_paths: next.inspect.contact_sheet_paths,
      warnings: next.inspect.warnings,
      audio_present: summary.audio_present,
      audio_path: next.inspect.audio_path,
      speech_detected: summary.speech_detected,
      asr_backend: summary.asr_backend || null,
      asr_attempts: summary.asr_attempts || null,
      transcript_aligned: summary.transcript_aligned === true,
      audio_analysis_path: next.inspect.audio_analysis_path,
      audio: next.inspect.audio,
      scene_detection_skipped: summary.scene_detection_skipped === true,
      transcript_path: next.inspect.transcript_path,
      transcript_summary_path: next.inspect.transcript_summary_path,
      transcript_paragraphs_path: next.inspect.transcript_paragraphs_path,
      paragraph_count: next.inspect.paragraph_count,
      word_count: summary.word_count,
      segments_path: next.inspect.segments_path,
      segment_count: next.inspect.segment_count,
      segment_keyframe_count: next.inspect.segment_keyframe_count,
      skipped_reason: summary.skipped_reason,
      digest_path: next.inspect.digest_path,
      clean_speech_path: next.inspect.clean_speech_path,
      clean_speech_stats: summary.clean_speech_stats || null,
      strips_legend_path: next.inspect.strips_legend_path,
      strip_count: next.inspect.strip_count,
      transcripts: next.inspect.transcripts,
      transcript_cache_hits: summary.transcript_cache_hits || 0,
      hook_candidate_count: next.inspect.hook_candidate_count,
      hook_candidates_top: (summary.hook_candidates || []).slice(0, 3)
        .map(({ rank, start_seconds, end_seconds, text }) => ({ rank, start_seconds, end_seconds, text })),
      take_quality: next.inspect.take_quality,
      completed_at: ts,
      user_acknowledged: false,
    };
  });
}

module.exports = Object.freeze({
  name: "vob_inspect_source",
  description: "Analyze ingested sources: thumbnails (480w grid + contact sheet per file), per-file word-level transcripts (pluggable ASR, content-hash cached in transcript_cache/; whisperx adds wav2vec2 forced alignment → karaoke-grade word timing, surfaced as transcript_aligned), clean-speech keep-spans, per-channel audio analysis (LUFS/balance/phase + a −14 LUFS normalization advisory → inspect/audio_analysis.json, surfaced as `audio`), per-file segments (scene cuts + silence + per-segment energy/speech-rate/loudness-proxy) with 512w keyframes tiled into contact strips (strips/legend.json maps cells to segments), hook candidates, and inspect/digest.md — the compact INSPECT handoff. Re-running overwrites artifacts and resets user_acknowledged. Requires phase INSPECT. Long-running; timeouts scale with duration. skip_scene_detection:true skips the slowest pass; skip_transcription:true skips ASR; skip_thumbnails:true skips the grid + contact sheets (segment keyframes/strips still extract); VOB_DISABLE_AUDIO_ANALYSIS=1 skips the channel-analysis pass. Long-GOP sources auto-switch single-frame extracts to keyframe-aligned fast seeks (one decoded frame per extract; result carries thumb_seek_modes + a thumbnails_keyframe_mode warning marking frame_K timestamps approximate).",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
      thumb_interval_seconds: {
        type: "number",
        minimum: 0.5,
        description: `Interval between thumbnail extractions, in seconds. Default ${DEFAULT_THUMB_INTERVAL_SECONDS}s, scaled up on long sources (caps thumbs at ~120/file); explicit values are honored verbatim (grid hard-capped at 400 thumbs/file). Extraction is seek-based — cost scales with thumb count, not source length (sparse-keyframe sources auto-degrade to keyframe-aligned seeks, reported in thumb_seek_modes); thumbnail failures degrade to result warnings instead of aborting the run.`,
      },
      skip_transcription: {
        type: "boolean",
        description: "Skip transcription entirely (records skipped_reason: 'user_opt_out'). Default false.",
      },
      skip_scene_detection: {
        type: "boolean",
        description: "Skip whole-stream scene-cut detection (the slowest pass; recommended for 30+ min single-shot sources). Never poisons the cache for a later full run.",
      },
      skip_thumbnails: {
        type: "boolean",
        description: "Skip the per-interval thumbnail grid and contact sheets entirely (thumb_count:0, thumbnails_skipped:true). Segment keyframes + contact strips — the classification basis — still extract. Escape valve for sources where even fast thumbnailing is unwanted; usually unnecessary now that long-GOP sources auto-switch to keyframe-aligned seeks. Default false.",
      },
    },
    required: ["project_id"],
  },
  handler: inspectSource,
  role_bundles: ["orchestrator"],
  mutating: true,
  global_preapproval: false,
  network_access: false,
  browser_access: false,
  scope_required: false,
  sensitive_output: false,
  session_artifacts_written: [
    "inspect/thumbs/file_*/frame_*.jpg",
    "inspect/contact_sheet_file_*.jpg",
    "inspect/audio.wav",
    "inspect/transcript.json",
    "inspect/transcripts/file_*.json",
    "inspect/transcript_summary.md",
    "inspect/transcript_paragraphs.json",
    "inspect/clean_speech.json",
    "inspect/audio_analysis.json",
    "inspect/inspect.json",
    "inspect/segments.json",
    "inspect/segment_keyframes/file_*/seg_*.jpg",
    "inspect/strips/*",
    "inspect/audio_features/*",
    "inspect/digest.md",
    "segment_cache/*.json",
    "transcript_cache/*.json",
    "state.json",
  ],
  hook_required: false,
});
