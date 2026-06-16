"use strict";

const fs = require("fs");
const path = require("path");

const { ERROR_CODES, ToolError } = require("../envelope.js");
const {
  assertSafeProjectId,
  composeDir,
  renderStderrLogPath,
  rendersDir,
  segmentRenderLogPath,
  segmentRenderPath,
  segmentRendersDir,
  statePath,
  storyboardPath,
} = require("../paths.js");
const { withSessionLock, writeFileAtomic } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");
const { runHyperframesWithRetry, buildRenderArgv, renderTimeoutMs, defaultRenderQuality } = require("../hyperframes-runner.js");
const { stderrTail } = require("../spawn-with-shutdown.js");
const { verifyRenderedMp4 } = require("../render-verify.js");
const { expectedTimelineDurationSeconds, findTimeline } = require("../storyboard-schema.js");
const { planSegmentById } = require("../render-segments.js");

function nowIso() {
  return new Date().toISOString();
}

function filenameSafeTimestamp() {
  return nowIso().replace(/[:.]/g, "-");
}

function fileSizeBytes(absPath) {
  try {
    return fs.statSync(absPath).size;
  } catch {
    return null;
  }
}

const RENDER_QUALITIES = new Set(["standard", "high"]);

async function renderFull(args) {
  const id = assertSafeProjectId(args && args.project_id);
  // Quality: explicit arg wins; else defaultRenderQuality() (high on >=10GB hosts). Docker is never an option.
  const quality = args && args.quality != null ? String(args.quality) : defaultRenderQuality();
  if (quality !== null && !RENDER_QUALITIES.has(quality)) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      `quality must be one of: ${[...RENDER_QUALITIES].join(", ")} (preview uses draft; unset defers to the host default)`,
    );
  }
  const composeRoot = composeDir(id);
  const indexPath = path.join(composeRoot, "index.html");
  if (!fs.existsSync(indexPath)) {
    throw new ToolError(
      ERROR_CODES.NOT_FOUND,
      `composition files missing from disk (expected ${indexPath}) — re-save the composition`,
    );
  }

  const state = readSessionStateStrict(id);
  const composition = state.composition && typeof state.composition === "object" && !Array.isArray(state.composition)
    ? state.composition
    : null;
  if (!composition || !Array.isArray(composition.files) || composition.files.length === 0) {
    throw new ToolError(
      ERROR_CODES.NOT_FOUND,
      "no composition saved — invoke the composer subagent and call vob_save_composition before rendering",
    );
  }
  // Revision binding (D2): capture which composition revision the renderer is
  // actually consuming, at the PRE-render read. A save that lands mid-render
  // bumps composition.revision_count past this value, so the stale-render gate
  // detects the mismatch instead of false-passing a render of old files.
  const compositionRevisionRendered = Number.isInteger(composition.revision_count)
    ? composition.revision_count
    : null;
  const preview = state.preview && typeof state.preview === "object" && !Array.isArray(state.preview)
    ? state.preview
    : null;
  if (!preview || preview.confirmed !== true) {
    throw new ToolError(
      ERROR_CODES.STATE_CONFLICT,
      "preview has not been confirmed — call vob_confirm_preview before vob_render_full",
    );
  }

  // Segmented render: the composition implements ONE render segment (stamped
  // at save). Its partial lands in <session>/segment_renders/ — outside
  // renders/, so the per-segment RENDER→COMPOSE back-edge's auto-archival
  // can't sweep completed partials mid-cycle — and is recorded in the
  // state.segment_renders registry for vob_assemble_video.
  const segmentId = typeof composition.segment_id === "string" && composition.segment_id !== ""
    ? composition.segment_id
    : null;
  const planSegment = segmentId ? planSegmentById(state, segmentId) : null;
  if (segmentId && !planSegment) {
    throw new ToolError(
      ERROR_CODES.STATE_CONFLICT,
      `composition implements segment "${segmentId}" but the render plan no longer defines it — re-enter COMPOSE to re-derive the plan, then re-save the composition`,
    );
  }

  const rendersRoot = rendersDir(id);
  fs.mkdirSync(rendersRoot, { recursive: true });
  if (planSegment) fs.mkdirSync(segmentRendersDir(id), { recursive: true });

  // Timeout scales with the ACTIVE scope's total (the render segment in a
  // segmented plan, the composition's short in fan-out, the document total
  // otherwise), floored at the fixed 30-min cap. Drift verification only gets
  // an expectation when the active scope actually RESOLVED — a timeout
  // fallback must never become a false silent-truncation flag.
  let sbTotal = null;
  let expectedDurationSeconds = null;
  if (planSegment) {
    sbTotal = Number.isFinite(planSegment.target_duration_seconds) ? planSegment.target_duration_seconds : null;
    expectedDurationSeconds = sbTotal;
  } else {
    try {
      const sb = JSON.parse(fs.readFileSync(storyboardPath(id), "utf8"));
      const shortId = typeof composition.short_id === "string" && composition.short_id !== ""
        ? composition.short_id
        : null;
      sbTotal = expectedTimelineDurationSeconds(sb, shortId);
      const timeline = findTimeline(sb, shortId);
      expectedDurationSeconds = timeline
        && Number.isFinite(timeline.total_target_duration_seconds) && timeline.total_target_duration_seconds > 0
        ? timeline.total_target_duration_seconds
        : null;
    } catch {}
  }
  const timeoutMs = renderTimeoutMs("full", sbTotal);

  const ts = filenameSafeTimestamp();
  const outPath = planSegment
    ? segmentRenderPath(id, planSegment.segment_id, ts)
    : path.join(rendersRoot, `final-${ts}.mp4`);
  const stderrLogPath = planSegment
    ? segmentRenderLogPath(id, planSegment.segment_id, ts)
    : renderStderrLogPath(id, "render", ts);

  // Audit the start of the render before the (potentially long) spawn so
  // failed/aborted attempts leave a trace in history.
  const startTs = nowIso();
  await withSessionLock(id, async () => {
    const stateNow = readSessionStateStrict(id);
    const prevRender = stateNow.render && typeof stateNow.render === "object" && !Array.isArray(stateNow.render)
      ? stateNow.render
      : null;
    const prevRevisionCount = prevRender && Number.isInteger(prevRender.revision_count)
      ? prevRender.revision_count
      : 0;
    const next = {
      ...stateNow,
      last_updated: startTs,
      history: [
        ...(Array.isArray(stateNow.history) ? stateNow.history : []),
        {
          kind: "render_started",
          at: startTs,
          expected_quality: quality !== null ? quality : "standard(default)",
          out_path: outPath,
          stderr_log_path: stderrLogPath,
          next_revision_count: prevRevisionCount + 1,
          ...(planSegment ? { segment_id: planSegment.segment_id } : {}),
        },
      ],
    };
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);
  });

  const start = Date.now();
  const result = await runHyperframesWithRetry(
    buildRenderArgv({ composeRoot, outPath, quality }),
    { timeoutMs, stderrLogPath, maxAttempts: 2 },
  );

  if (result.timed_out) {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `hyperframes render timed out after ${Math.round(timeoutMs / 1000)}s — partial log at ${stderrLogPath}`,
      { stderr_log_path: stderrLogPath, stderr_preview: stderrTail(result.stderr, 1000) },
    );
  }
  if (result.exit_code !== 0) {
    const stderrPreview = stderrTail(result.stderr, 2000);
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `hyperframes render failed (exit ${result.exit_code}) — see ${stderrLogPath} for full output: ${stderrPreview || "no stderr"}`,
      { exit_code: result.exit_code, signal: result.signal, stderr_log_path: stderrLogPath, stderr_preview: stderrPreview },
    );
  }
  if (!fs.existsSync(outPath)) {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `hyperframes render reported success but no output file at ${outPath}`,
      { stderr_log_path: stderrLogPath, stderr_preview: stderrTail(result.stderr, 1000) },
    );
  }

  const renderDurationSeconds = (Date.now() - start) / 1000;
  const sizeBytes = fileSizeBytes(outPath);
  // Silent-truncation detector: ffprobe the MP4 vs the storyboard expectation.
  const verification = verifyRenderedMp4({ mp4Path: outPath, expectedDurationSeconds });
  const completedTs = nowIso();

  return withSessionLock(id, () => {
    const stateNow = readSessionStateStrict(id);
    const prevRender = stateNow.render && typeof stateNow.render === "object" && !Array.isArray(stateNow.render)
      ? stateNow.render
      : null;
    const prevRevisionCount = prevRender && Number.isInteger(prevRender.revision_count)
      ? prevRender.revision_count
      : 0;
    const revisionCount = prevRevisionCount + 1;

    // composition_revision_rendered was captured at the PRE-render read (see
    // above) — stamping the commit-time value would bind a render of OLD files
    // to a NEW revision saved mid-render, false-passing the stale gate.

    const next = {
      ...stateNow,
      render: {
        mp4_path: outPath,
        rendered_at: completedTs,
        render_duration_seconds: renderDurationSeconds,
        file_size_bytes: sizeBytes,
        stderr_log_path: stderrLogPath,
        confirmed: false,
        confirmed_at: null,
        revision_count: revisionCount,
        quality,
        composition_revision_rendered: compositionRevisionRendered,
        ...(planSegment ? { segment_id: planSegment.segment_id } : {}),
        verification,
      },
      last_updated: completedTs,
      history: [
        ...(Array.isArray(stateNow.history) ? stateNow.history : []),
        {
          kind: "render_completed",
          at: completedTs,
          revision_count: revisionCount,
          mp4_path: outPath,
          render_duration_seconds: renderDurationSeconds,
          file_size_bytes: sizeBytes,
          duration_drift_seconds: verification.duration_drift_seconds,
          ...(planSegment ? { segment_id: planSegment.segment_id } : {}),
        },
      ],
    };
    if (planSegment) {
      // Segment registry entry — what vob_assemble_video consumes. Bound to
      // the CURRENT storyboard revision + the plan segment's scene set, so a
      // re-saved storyboard invalidates the partial instead of concatenating a
      // stale cut. A fresh partial also invalidates any prior assembled final.
      const sbRevision = stateNow.storyboard && Number.isInteger(stateNow.storyboard.revision_count)
        ? stateNow.storyboard.revision_count
        : null;
      const prevRegistry = stateNow.segment_renders && typeof stateNow.segment_renders === "object" && !Array.isArray(stateNow.segment_renders)
        ? stateNow.segment_renders
        : {};
      next.segment_renders = {
        ...prevRegistry,
        [planSegment.segment_id]: {
          segment_id: planSegment.segment_id,
          mp4_path: outPath,
          rendered_at: completedTs,
          render_duration_seconds: renderDurationSeconds,
          file_size_bytes: sizeBytes,
          stderr_log_path: stderrLogPath,
          quality,
          composition_revision_rendered: compositionRevisionRendered,
          storyboard_revision: sbRevision,
          scene_ids: planSegment.scene_ids.slice(),
          target_duration_seconds: planSegment.target_duration_seconds,
          transition_out: planSegment.transition_out || "cut",
          verification,
          confirmed: false,
          confirmed_at: null,
        },
      };
      delete next.assembly;
    }
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);

    return {
      mp4_path: outPath,
      rendered_at: completedTs,
      render_duration_seconds: renderDurationSeconds,
      file_size_bytes: sizeBytes,
      stderr_log_path: stderrLogPath,
      revision_count: revisionCount,
      quality,
      composition_revision_rendered: compositionRevisionRendered,
      ...(planSegment ? { segment_id: planSegment.segment_id } : {}),
      verification,
      exit_code: 0,
    };
  });
}

module.exports = Object.freeze({
  name: "vob_render_full",
  description: "Render the final MP4 to renders/final-<ts>.mp4, teeing stderr to renders/render-<ts>.log (tail -f for progress). Requires preview.confirmed:true. quality: explicit 'standard'|'high', else defaults to 'high' on ≥10GB-RAM hosts (VOB_RENDER_QUALITY overrides). BLOCKING; timeout scales with the active scope's duration (≥30 min; VOB_FULL_RENDER_TIMEOUT_MS overrides). Segmented render (composition saved with segment_id): the output is a PARTIAL at segment_renders/<segment_id>-<ts>.mp4, recorded in the state.segment_renders registry (revision-bound; invalidates any prior assembly) — render every segment, then vob_assemble_video joins them into renders/final-<ts>.mp4. Success returns mp4_path, file_size_bytes, stderr_log_path + ffprobe `verification` (drift vs the segment/timeline target), and resets render confirmation. Failure leaves only the render_started audit entry.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
      quality: { type: "string", enum: ["standard", "high"] },
    },
    required: ["project_id"],
  },
  handler: renderFull,
  role_bundles: ["orchestrator"],
  mutating: true,
  global_preapproval: false,
  network_access: true,
  browser_access: false,
  scope_required: false,
  sensitive_output: false,
  session_artifacts_written: ["renders/final-*.mp4", "renders/render-*.log", "segment_renders/*", "state.json"],
  hook_required: false,
});
