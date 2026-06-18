"use strict";

const fs = require("fs");
const path = require("path");

const { ERROR_CODES, ToolError } = require("../envelope.js");
const { assertSafeProjectId, rendersDir, statePath } = require("../paths.js");
const { withSessionLock, writeFileAtomic } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");
const { assembleSegments, DEFAULT_MUSIC_GAIN_DB } = require("../assemble.js");
const { renderPlanOf, validSegmentRenders } = require("../render-segments.js");
const { verifyRenderedMp4 } = require("../render-verify.js");
const { normalizeLoudnessInPlace } = require("../loudnorm.js");
const { resolveLoudnessTarget } = require("../video-types.js");
const { probeFile, summarizeProbe } = require("../ffprobe.js");

function nowIso() {
  return new Date().toISOString();
}

function filenameSafeTimestamp() {
  return nowIso().replace(/[:.]/g, "-");
}

async function assembleVideo(args) {
  const id = assertSafeProjectId(args && args.project_id);
  const state = readSessionStateStrict(id);

  const plan = renderPlanOf(state);
  if (!plan) {
    throw new ToolError(
      ERROR_CODES.STATE_CONFLICT,
      "this project has no segmented render plan — a single continuous render needs no assembly (vob_render_full already produced renders/final-*.mp4)",
    );
  }
  const { byId, missing, stale, unconfirmed } = validSegmentRenders(state);
  if (missing.length > 0) {
    const staleNote = stale.length > 0 ? ` ${stale.join(", ")} are STALE (the storyboard changed since they rendered; re-render them).` : "";
    const unconfirmedNote = unconfirmed.length > 0 ? ` ${unconfirmed.join(", ")} rendered but are UNCONFIRMED (confirm_render each before assembling).` : "";
    throw new ToolError(
      ERROR_CODES.STATE_CONFLICT,
      `cannot assemble: ${missing.length} segment(s) are not assembly-ready (${missing.join(", ")}).${staleNote}${unconfirmedNote} Cycle COMPOSE→PREVIEW→RENDER→confirm_render for each, then re-run vob_assemble_video.`,
      { missing_segment_ids: missing, stale_segment_ids: stale, unconfirmed_segment_ids: unconfirmed },
    );
  }

  // Optional master audio bed.
  let musicPath = null;
  if (args && args.music_path != null && String(args.music_path).trim() !== "") {
    musicPath = path.resolve(String(args.music_path).trim());
    if (!fs.existsSync(musicPath)) {
      throw new ToolError(ERROR_CODES.NOT_FOUND, `music_path not found on disk: ${musicPath}`);
    }
  }
  const musicGainDb = args && Number.isFinite(args.music_gain_db) ? args.music_gain_db : null;
  const normalize = args && args.normalize === true;

  const ordered = plan.segments.map((segment) => {
    const entry = byId.get(segment.segment_id);
    return {
      segment_id: segment.segment_id,
      mp4_path: entry.mp4_path,
      transition_out: segment.transition_out || "cut",
    };
  });
  const expectedDurationSeconds = plan.segments.reduce(
    (acc, s) => acc + (Number.isFinite(s.target_duration_seconds) ? s.target_duration_seconds : 0),
    0,
  ) || null;

  const rendersRoot = rendersDir(id);
  fs.mkdirSync(rendersRoot, { recursive: true });
  const ts = filenameSafeTimestamp();
  const outPath = path.join(rendersRoot, `final-${ts}.mp4`);
  const stderrLogPath = path.join(rendersRoot, `assemble-${ts}.log`);

  const start = Date.now();
  const joined = await assembleSegments({
    segments: ordered,
    outPath,
    musicPath,
    musicGainDb,
    stderrLogPath,
  });

  // Optional in-place −14 LUFS pass (the same one PACKAGE applies; running it
  // here too is harmless — within-tolerance inputs are skipped).
  let loudnorm = null;
  if (normalize) {
    let summaryPre = null;
    try {
      summaryPre = summarizeProbe(outPath, probeFile(outPath));
    } catch {
      summaryPre = null;
    }
    loudnorm = summaryPre
      ? await normalizeLoudnessInPlace({ mp4Path: outPath, summaryPre, target: resolveLoudnessTarget(state) })
      : { applied: false, skipped_reason: "probe_failed", error: null, measured_input_i: null, measured_input_tp: null };
  }

  const assembleDurationSeconds = (Date.now() - start) / 1000;
  // Silent-truncation detector across the JOIN: ffprobe vs the document total
  // (= sum of plan segment targets; dip-to-black fades preserve durations).
  const verification = verifyRenderedMp4({ mp4Path: outPath, expectedDurationSeconds });
  const sizeBytes = (() => {
    try { return fs.statSync(outPath).size; } catch { return null; }
  })();
  const completedTs = nowIso();

  return withSessionLock(id, () => {
    const stateNow = readSessionStateStrict(id);
    // The registry must still describe exactly the partials we joined — a
    // segment re-rendered mid-assembly would silently ship the wrong cut.
    const registryNow = stateNow.segment_renders && typeof stateNow.segment_renders === "object" && !Array.isArray(stateNow.segment_renders)
      ? stateNow.segment_renders
      : {};
    for (const seg of ordered) {
      const entry = registryNow[seg.segment_id];
      if (!entry || entry.mp4_path !== seg.mp4_path) {
        throw new ToolError(
          ERROR_CODES.STATE_CONFLICT,
          `segment "${seg.segment_id}" was re-rendered while assembly ran — re-run vob_assemble_video`,
          { segment_id: seg.segment_id },
        );
      }
    }
    const prevRender = stateNow.render && typeof stateNow.render === "object" && !Array.isArray(stateNow.render)
      ? stateNow.render
      : null;
    const renderRevision = (prevRender && Number.isInteger(prevRender.revision_count) ? prevRender.revision_count : 0) + 1;
    const compositionRevision = stateNow.composition && Number.isInteger(stateNow.composition.revision_count)
      ? stateNow.composition.revision_count
      : null;

    const assembly = {
      final_path: outPath,
      assembled_at: completedTs,
      assemble_duration_seconds: assembleDurationSeconds,
      concat_path: joined.path, // "copy" (lossless) | "filter" | "filter_no_duck"
      segment_ids: ordered.map((s) => s.segment_id),
      transitions: ordered.slice(0, -1).map((s) => s.transition_out),
      music: joined.music,
      ...(loudnorm
        ? {
          loudnorm: {
            applied: loudnorm.applied,
            skipped_reason: loudnorm.skipped_reason,
            measured_input_i: loudnorm.measured_input_i,
            measured_input_tp: loudnorm.measured_input_tp,
          },
        }
        : {}),
      verification,
      stderr_log_path: stderrLogPath,
    };

    const next = {
      ...stateNow,
      assembly,
      // The assembled final BECOMES the project's render: the existing
      // confirm-render / RENDER→PACKAGE / package machinery applies unchanged.
      // composition_revision_rendered = the current revision, so a later
      // recompose of any segment trips the standard stale-render gate.
      render: {
        mp4_path: outPath,
        rendered_at: completedTs,
        render_duration_seconds: assembleDurationSeconds,
        file_size_bytes: sizeBytes,
        stderr_log_path: stderrLogPath,
        confirmed: false,
        confirmed_at: null,
        revision_count: renderRevision,
        quality: "assembled",
        composition_revision_rendered: compositionRevision,
        verification,
      },
      last_updated: completedTs,
      history: [
        ...(Array.isArray(stateNow.history) ? stateNow.history : []),
        {
          kind: "video_assembled",
          at: completedTs,
          final_path: outPath,
          segment_count: ordered.length,
          segment_ids: ordered.map((s) => s.segment_id),
          concat_path: joined.path,
          music: joined.music ? path.basename(joined.music.path) : null,
          music_ducked: joined.music ? joined.music.ducked === true : null,
          duration_drift_seconds: verification.duration_drift_seconds,
          render_revision_count: renderRevision,
        },
      ],
    };
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);

    // Surface a flat-mix fallback prominently: a music bed that couldn't be
    // sidechain-ducked is mixed at fixed gain and may mask dialogue — the
    // orchestrator should tell the human (it was silent in state.assembly before).
    const warnings = [];
    if (joined.music && joined.music.ducked === false) {
      warnings.push("music bed could NOT be sidechain-ducked under the program audio (the duck filter failed) — it was mixed at fixed gain, so narration/dialogue may be masked. Lower music_gain_db, or supply a pre-ducked bed.");
    }
    if (verification && verification.silent_audio === true) {
      warnings.push("the assembled video measured as SILENT (no audible program) — check the segment audio and the music mix.");
    }

    return {
      final_path: outPath,
      assembled_at: completedTs,
      assemble_duration_seconds: assembleDurationSeconds,
      concat_path: joined.path,
      segment_ids: ordered.map((s) => s.segment_id),
      transitions: assembly.transitions,
      music: joined.music,
      ...(loudnorm ? { loudnorm: assembly.loudnorm } : {}),
      file_size_bytes: sizeBytes,
      stderr_log_path: stderrLogPath,
      render_revision_count: renderRevision,
      verification,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  });
}

module.exports = Object.freeze({
  name: "vob_assemble_video",
  description: "Segmented render only: concat every rendered segment partial (state.segment_renders, in render-plan order) into renders/final-<ts>.mp4. Hard-cut boundaries use the lossless concat demuxer (stream copy); 'fade' boundaries (segment transition_out) re-encode with a duration-preserving 0.25s dip-to-black. Optional master audio bed: music_path is looped to program length, pre-gained (music_gain_db, default −12 dB), and sidechain-ducked under the program audio (fixed-gain mix fallback). normalize:true additionally runs the shared −14 LUFS two-pass in place (PACKAGE will otherwise do it). ffprobe-verifies the joined duration against the plan total (silent-truncation detector). Refuses (STATE_CONFLICT, details.missing_segment_ids) while any plan segment lacks a valid partial — stale = rendered against an older storyboard revision. On success the assembled final BECOMES state.render (confirmed:false) so vob_confirm_render → RENDER→PACKAGE → vob_package_output work unchanged.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
      music_path: { type: "string", minLength: 1, description: "Optional music bed (audio file); looped/trimmed to program length and ducked under program audio." },
      music_gain_db: { type: "number", description: `Music pre-gain in dB (default ${DEFAULT_MUSIC_GAIN_DB}).` },
      normalize: { type: "boolean", description: "Run the −14 LUFS two-pass on the assembled final in place (default false — PACKAGE normalizes anyway)." },
    },
    required: ["project_id"],
  },
  handler: assembleVideo,
  role_bundles: ["orchestrator"],
  mutating: true,
  global_preapproval: false,
  network_access: false,
  browser_access: false,
  scope_required: false,
  sensitive_output: false,
  session_artifacts_written: ["renders/final-*.mp4", "renders/assemble-*.log", "state.json"],
  hook_required: false,
});
