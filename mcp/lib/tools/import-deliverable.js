"use strict";

const fs = require("fs");
const path = require("path");

const { ERROR_CODES, ToolError } = require("../envelope.js");
const {
  assertSafeProjectId,
  deliverablesDir,
  sessionDir,
  statePath,
} = require("../paths.js");
const { withSessionLock, writeFileAtomic } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");
const { probeFile, summarizeProbe } = require("../ffprobe.js");
const { compositeOverlayOverBase } = require("../overlay-compositor.js");

function nowIso() {
  return new Date().toISOString();
}

function sessionRelative(projectId, absPath) {
  return path.relative(sessionDir(projectId), absPath);
}

// kebab-safe stem from a title/filename so deliverables land at stable,
// path-safe names under the session deliverables/ dir.
function safeStem(label, index) {
  const base = (typeof label === "string" ? label : "").trim().toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base || `deliverable-${index + 1}`;
}

function resolveExisting(rawPath, label) {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, `${label} must be a non-empty path`);
  }
  const resolved = path.resolve(rawPath.trim());
  if (!fs.existsSync(resolved)) {
    throw new ToolError(ERROR_CODES.NOT_FOUND, `${label} not found on disk: ${resolved}`);
  }
  return resolved;
}

function describeVideo(absPath) {
  let summary = null;
  try {
    summary = summarizeProbe(absPath, probeFile(absPath));
  } catch {
    summary = null;
  }
  let sizeBytes = null;
  try { sizeBytes = fs.statSync(absPath).size; } catch { sizeBytes = null; }
  return {
    duration_seconds: summary && Number.isFinite(summary.duration_seconds) ? summary.duration_seconds : null,
    width: summary && summary.primary_video ? summary.primary_video.width : null,
    height: summary && summary.primary_video ? summary.primary_video.height : null,
    codec: summary && summary.primary_video ? summary.primary_video.codec : null,
    file_size_bytes: sizeBytes,
  };
}

async function importDeliverable(args) {
  const id = assertSafeProjectId(args && args.project_id);
  // Confirm the project exists before doing any work.
  readSessionStateStrict(id);

  const rawDeliverables = Array.isArray(args && args.deliverables) ? args.deliverables : [];
  const composite = args && typeof args.composite === "object" && !Array.isArray(args.composite) ? args.composite : null;
  if (rawDeliverables.length === 0 && !composite) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      "nothing to import — provide `deliverables` (array of {path,title?,notes?}) and/or `composite` ({base,overlay,...})",
    );
  }
  const setPhase = args && args.set_phase === false ? false : true;

  const destDir = deliverablesDir(id);
  fs.mkdirSync(destDir, { recursive: true });

  // Build the list of (absolute source, meta) to record. Compositing (long
  // ffmpeg work) happens here, OUTSIDE the session lock; only the final state
  // write is locked.
  const toRecord = [];

  if (composite) {
    const base = resolveExisting(composite.base, "composite.base");
    const overlay = resolveExisting(composite.overlay, "composite.overlay");
    let audio = "base";
    if (typeof composite.audio === "string" && composite.audio.trim()) {
      const a = composite.audio.trim();
      audio = (a === "base" || a === "none") ? a : resolveExisting(a, "composite.audio");
    }
    const stem = safeStem(composite.title || "composite", 0);
    const outAbs = path.join(destDir, `${stem}.mp4`);
    await compositeOverlayOverBase({
      basePath: base,
      overlayPath: overlay,
      outPath: outAbs,
      audio,
      scaleToBase: composite.scale_to_base === true,
    });
    toRecord.push({
      absPath: outAbs,
      copyInPlace: true, // already written into destDir
      title: composite.title || stem,
      notes: composite.notes || null,
      origin: "composite",
      source_path: `${base} + ${overlay}`,
    });
  }

  rawDeliverables.forEach((entry, index) => {
    const src = resolveExisting(entry && entry.path, `deliverables[${index}].path`);
    const stem = safeStem((entry && entry.title) || path.basename(src), index);
    toRecord.push({
      absPath: src,
      copyInPlace: false,
      destStem: stem,
      title: (entry && entry.title) || stem,
      notes: (entry && entry.notes) || null,
      origin: "external",
      source_path: src,
    });
  });

  // Materialize each deliverable into the session deliverables/ dir (copy external
  // finals in; composite outputs already live there), probe, and build records.
  const records = [];
  toRecord.forEach((item, index) => {
    let finalAbs = item.absPath;
    if (!item.copyInPlace) {
      const ext = path.extname(item.absPath) || ".mp4";
      let destAbs = path.join(destDir, `${item.destStem}${ext}`);
      // Avoid clobbering a same-named earlier import within this call.
      let n = 1;
      while (records.some((r) => path.resolve(sessionDir(id), r.path) === destAbs)) {
        destAbs = path.join(destDir, `${item.destStem}-${n}${ext}`);
        n += 1;
      }
      try {
        fs.copyFileSync(item.absPath, destAbs);
      } catch (error) {
        throw new ToolError(ERROR_CODES.INTERNAL_ERROR, `failed to copy deliverable into deliverables/: ${error.message || String(error)}`);
      }
      finalAbs = destAbs;
    }
    // Derive the id from the ACTUAL materialized filename (post-dedup), not the
    // un-deduped stem: two distinct deliverables whose titles/basenames collide
    // to the same stem get files foo.mp4 / foo-1.mp4 (the dedup loop above), and
    // the id must inherit that `-n` suffix too — otherwise both records share
    // id "foo" and merge-by-id silently collapses two deliverables into one.
    const finalExt = path.extname(finalAbs);
    const meta = describeVideo(finalAbs);
    records.push({
      id: path.basename(finalAbs, finalExt) || safeStem(item.title, index),
      title: item.title,
      notes: item.notes,
      origin: item.origin,
      source_path: item.source_path,
      path: sessionRelative(id, finalAbs),
      ...meta,
      imported_at: nowIso(),
    });
  });

  const importedAt = nowIso();
  return withSessionLock(id, () => {
    const stateNow = readSessionStateStrict(id);
    const fromPhase = stateNow.phase;
    const priorDeliverables = Array.isArray(stateNow.deliverables) ? stateNow.deliverables : [];
    // Merge by id: a re-import with the same id replaces the prior record.
    const byId = new Map(priorDeliverables.map((d) => [d && d.id, d]));
    for (const r of records) byId.set(r.id, r);
    const merged = Array.from(byId.values());

    const next = {
      ...stateNow,
      deliverables: merged,
      external_import: true,
      last_updated: importedAt,
      history: [
        ...(Array.isArray(stateNow.history) ? stateNow.history : []),
        {
          kind: "external_deliverables_imported",
          at: importedAt,
          from_phase: fromPhase,
          set_phase: setPhase,
          count: records.length,
          ids: records.map((r) => r.id),
          note: "deliverables produced outside the single-timeline FSM (multi-deliverable / overlay escape hatch)",
        },
      ],
    };
    // Advance to PACKAGE to signal "delivered" — but never REGRESS a project
    // that already finished (ITERATE) back to PACKAGE just because an extra
    // deliverable was recorded.
    if (setPhase && fromPhase !== "ITERATE") next.phase = "PACKAGE";
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);

    return {
      project_id: id,
      imported_count: records.length,
      total_deliverables: merged.length,
      phase: next.phase,
      phase_changed: next.phase !== fromPhase,
      deliverables_dir: destDir,
      deliverables: records,
    };
  });
}

module.exports = Object.freeze({
  name: "vob_import_deliverable",
  description: "Escape hatch + multi-deliverable recorder: register one or more externally-produced final videos into a project so state.json reflects reality when heavy work ran outside the FSM (the clip fan-out case: one long source -> N independent shorts). Pass `deliverables` (array of {path,title?,notes?}) to record finished files, and/or `composite` ({base,overlay,audio?,scale_to_base?}) to first build a deliverable by compositing a transparent OVERLAY over an ffmpeg-cut BASE (the first-class overlay-over-base render mode, for when hyperframes <video> capture is too fragile) before recording it. Files are copied into the session-level deliverables/ dir (kept OUT of package/ so the single-timeline vob_package_output can't delete them), ffprobed for duration/dimensions, and recorded in state.deliverables[]; by default advances phase to PACKAGE — which then becomes a valid terminal state for an import-only project (PACKAGE -> ITERATE is unlocked by the presence of external deliverables). Pass set_phase:false to record without changing phase. Appends 'external_deliverables_imported' to history for audit. Does NOT touch the single-timeline composition/render/preview slots.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
      deliverables: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string", minLength: 1 },
            title: { type: "string" },
            notes: { type: "string" },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
      composite: {
        type: "object",
        properties: {
          base: { type: "string", minLength: 1 },
          overlay: { type: "string", minLength: 1 },
          audio: { type: "string", description: "'base' (default, mux base audio) | 'none' | a path to an audio/video file to take audio from" },
          scale_to_base: { type: "boolean" },
          title: { type: "string" },
          notes: { type: "string" },
        },
        required: ["base", "overlay"],
        additionalProperties: false,
      },
      set_phase: { type: "boolean", description: "Advance phase to PACKAGE (default true). Pass false to record deliverables without changing phase." },
    },
    required: ["project_id"],
  },
  handler: importDeliverable,
  role_bundles: ["orchestrator"],
  mutating: true,
  global_preapproval: false,
  network_access: false,
  browser_access: false,
  scope_required: false,
  sensitive_output: false,
  session_artifacts_written: ["deliverables/*", "state.json"],
  hook_required: false,
});
