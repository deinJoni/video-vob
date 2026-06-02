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
  const intervalSeconds = rawInterval == null
    ? DEFAULT_THUMB_INTERVAL_SECONDS
    : Number(rawInterval);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      "thumb_interval_seconds must be a positive number",
    );
  }
  const skipTranscription = args && args.skip_transcription === true;

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
        thumb_interval_seconds: summary.thumb_interval_seconds,
        sample_thumb_paths: summary.sample_thumb_paths || [],
        contact_sheet_paths: summary.contact_sheet_paths || [],
        audio_present: summary.audio_present,
        audio_path: summary.audio_present ? inspectAudioPath(id) : null,
        speech_detected: summary.speech_detected,
        transcript_path: summary.transcript_path ? inspectTranscriptPath(id) : null,
        transcript_summary_path: summary.transcript_summary_path || null,
        transcript_paragraphs_path: summary.transcript_paragraphs_path || null,
        paragraph_count: summary.paragraph_count || 0,
        word_count: summary.word_count,
        segments_path: summary.segment_count > 0 ? segmentsPath(id) : null,
        segment_count: summary.segment_count || 0,
        segment_keyframe_count: summary.segment_keyframe_count || 0,
        skipped_reason: summary.skipped_reason,
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
          audio_present: summary.audio_present,
          speech_detected: summary.speech_detected,
          word_count: summary.word_count,
          skipped_reason: summary.skipped_reason,
        },
      ],
    };
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);

    return {
      summary_path: next.inspect.summary_path,
      thumbs_dir: next.inspect.thumbs_dir,
      thumb_count: summary.thumb_count,
      thumb_interval_seconds: summary.thumb_interval_seconds,
      sample_thumb_paths: next.inspect.sample_thumb_paths,
      contact_sheet_paths: next.inspect.contact_sheet_paths,
      audio_present: summary.audio_present,
      audio_path: next.inspect.audio_path,
      speech_detected: summary.speech_detected,
      transcript_path: next.inspect.transcript_path,
      transcript_summary_path: next.inspect.transcript_summary_path,
      transcript_paragraphs_path: next.inspect.transcript_paragraphs_path,
      paragraph_count: next.inspect.paragraph_count,
      word_count: summary.word_count,
      segments_path: next.inspect.segments_path,
      segment_count: next.inspect.segment_count,
      segment_keyframe_count: next.inspect.segment_keyframe_count,
      skipped_reason: summary.skipped_reason,
      completed_at: ts,
      user_acknowledged: false,
    };
  });
}

module.exports = Object.freeze({
  name: "vob_inspect_source",
  description: "Extract thumbnail grid (every N seconds via ffmpeg), audio (mono 16kHz wav if manifest has audio streams), word-level transcript (via hyperframes transcribe), AND per-file segments (scene-cut + silence detection -> inspect/segments.json, with a representative keyframe per non-silence segment). Segments are the unit downstream classification/storyboard consume. Writes inspect/{thumbs/, audio.wav, transcript.json, inspect.json, segments.json, segment_keyframes/} and sets state.inspect (incl. segments_path, segment_count) with user_acknowledged:false. Detection is cached by file content hash at segment_cache/ so re-runs are cheap. Re-running overwrites artifacts and resets the acknowledgement flag. Requires phase INSPECT. Long-running (up to ~12+ minutes including transcription + scene detection); transcription can be skipped with skip_transcription:true.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
      thumb_interval_seconds: {
        type: "number",
        minimum: 0.5,
        description: `Interval between thumbnail extractions, in seconds. Default ${DEFAULT_THUMB_INTERVAL_SECONDS}.`,
      },
      skip_transcription: {
        type: "boolean",
        description: "Skip the hyperframes transcribe step (records skipped_reason: 'user_opt_out'). Default false.",
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
    "inspect/transcript_summary.md",
    "inspect/transcript_paragraphs.json",
    "inspect/inspect.json",
    "inspect/segments.json",
    "inspect/segment_keyframes/file_*/seg_*.jpg",
    "segment_cache/*.json",
    "state.json",
  ],
  hook_required: false,
});
