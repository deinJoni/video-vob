"use strict";

const fs = require("fs");
const path = require("path");

const { ERROR_CODES, ToolError } = require("../envelope.js");
const {
  assertSafeProjectId,
  deliverablesDir,
  rendersDir,
  sessionDir,
  statePath,
  storyboardPath,
} = require("../paths.js");
const { withSessionLock, writeFileAtomic } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");
const { probeFile, summarizeProbe } = require("../ffprobe.js");
const { compositeOverlayOverBase } = require("../overlay-compositor.js");
const { normalizeLoudnessInPlace } = require("../loudnorm.js");
const { buildCaptionSidecar } = require("../caption-sidecar.js");
const { buildTranscriptResolver, distributionFromStoryboard, findTimeline, loadTranscript, storyboardHasShorts, storyboardTimelines } = require("../storyboard-schema.js");

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

function readStoryboardSafe(projectId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(storyboardPath(projectId), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizedShortId(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

// Deliverable identity: short_id when the record carries one (the on-rails
// fan-out — a re-import REPLACES that short's record regardless of title),
// filename-stem id otherwise (the free-form escape hatch, today's semantics).
function deliverableKey(record) {
  return normalizedShortId(record && record.short_id) !== null
    ? `short:${record.short_id}`
    : `id:${record && record.id}`;
}

async function importDeliverable(args) {
  const id = assertSafeProjectId(args && args.project_id);
  // Confirm the project exists before doing any work; keep the state for the
  // pre-lock dedup checks (re-read inside the lock before writing).
  const statePre = readSessionStateStrict(id);

  const rawDeliverables = Array.isArray(args && args.deliverables) ? args.deliverables : [];
  const composite = args && typeof args.composite === "object" && !Array.isArray(args.composite) ? args.composite : null;
  if (rawDeliverables.length === 0 && !composite) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      "nothing to import — provide `deliverables` (array of {path,title?,notes?,short_id?}) and/or `composite` ({base,overlay,...})",
    );
  }
  const setPhase = args && args.set_phase === false ? false : true;
  const normalize = args && args.normalize === true;

  // Fan-out guard: a shorts[] storyboard makes short_id the deliverable
  // identity — require it on every entry and validate against the plan, so a
  // typo can't orphan a short or duplicate its record.
  const storyboard = readStoryboardSafe(id);
  // (v3.4) Word-anchor caption cues to the forced-aligned per-word times (the
  // same the burn-in uses) when INSPECT aligned the transcript — built once,
  // reused per deliverable below.
  const inspectSlot = statePre.inspect && typeof statePre.inspect === "object" && !Array.isArray(statePre.inspect) ? statePre.inspect : null;
  const captionTranscriptResolver = buildTranscriptResolver(statePre, loadTranscript(inspectSlot && inspectSlot.transcript_path));
  const captionTranscriptAligned = inspectSlot ? inspectSlot.transcript_aligned === true : false;
  const fanOut = storyboard !== null && storyboardHasShorts(storyboard);
  const validShortIds = fanOut
    ? new Set(storyboardTimelines(storyboard).map((t) => t.short_id).filter(Boolean))
    : null;
  const assertValidShortId = (shortId, label, required) => {
    if (shortId === null) {
      if (required) {
        throw new ToolError(
          ERROR_CODES.INVALID_ARGUMENTS,
          `${label}.short_id is required — the storyboard is a multi-short fan-out (shorts: ${[...validShortIds].join(", ")})`,
          { valid_short_ids: [...validShortIds] },
        );
      }
      return;
    }
    if (fanOut && !validShortIds.has(shortId)) {
      throw new ToolError(
        ERROR_CODES.INVALID_ARGUMENTS,
        `${label}.short_id "${shortId}" does not match any storyboard short (valid: ${[...validShortIds].join(", ")})`,
        { valid_short_ids: [...validShortIds] },
      );
    }
  };
  const seenCallShortIds = new Set();
  const assertUniqueInCall = (shortId, label) => {
    if (shortId === null) return;
    if (seenCallShortIds.has(shortId)) {
      throw new ToolError(
        ERROR_CODES.INVALID_ARGUMENTS,
        `${label}.short_id "${shortId}" appears twice in this call — one deliverable per short per call`,
      );
    }
    seenCallShortIds.add(shortId);
  };

  const destDir = deliverablesDir(id);
  fs.mkdirSync(destDir, { recursive: true });

  const priorDeliverables = Array.isArray(statePre.deliverables) ? statePre.deliverables : [];
  const priorByRelPath = new Map(
    priorDeliverables
      .filter((d) => d && typeof d.path === "string" && d.path !== "")
      .map((d) => [d.path, d]),
  );

  // Dest-path resolver: same identity may overwrite its own file (a revision);
  // anything else suffixes -n instead of clobbering — across THIS call, prior
  // records, and stray files on disk. NB: this dedup runs against the PRE-lock
  // state (heavy compositing/loudnorm sits between here and the locked merge),
  // so it is best-effort against a concurrent import — the orchestrator drives
  // one import at a time.
  const claimedAbs = new Set();
  const resolveDestAbs = (stem, ext, shortId) => {
    let candidate = path.join(destDir, `${stem}${ext}`);
    let n = 1;
    for (;;) {
      const rel = sessionRelative(id, candidate);
      const prior = priorByRelPath.get(rel);
      const sameIdentity = prior
        ? (shortId !== null
          ? normalizedShortId(prior.short_id) === shortId
          : normalizedShortId(prior.short_id) === null)
        : false;
      const collides = claimedAbs.has(candidate)
        || (prior && !sameIdentity)
        || (!prior && fs.existsSync(candidate));
      if (!collides) {
        claimedAbs.add(candidate);
        return candidate;
      }
      candidate = path.join(destDir, `${stem}-${n}${ext}`);
      n += 1;
    }
  };

  // Build the list of (absolute source, meta) to record. Heavy work
  // (compositing, loudnorm) happens here, OUTSIDE the session lock; only the
  // final state write is locked.
  const toRecord = [];

  if (composite) {
    const base = resolveExisting(composite.base, "composite.base");
    const overlay = resolveExisting(composite.overlay, "composite.overlay");
    let audio = "base";
    if (typeof composite.audio === "string" && composite.audio.trim()) {
      const a = composite.audio.trim();
      audio = (a === "base" || a === "none") ? a : resolveExisting(a, "composite.audio");
    }
    const compositeShortId = normalizedShortId(composite.short_id);
    assertValidShortId(compositeShortId, "composite", fanOut);
    assertUniqueInCall(compositeShortId, "composite");
    const stem = safeStem(composite.title || "composite", 0);
    const outAbs = resolveDestAbs(stem, ".mp4", compositeShortId);
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
      short_id: compositeShortId,
    });
  }

  const rendersRoot = rendersDir(id);
  const activeCompositionShortId = statePre.composition && typeof statePre.composition === "object" && !Array.isArray(statePre.composition)
    ? normalizedShortId(statePre.composition.short_id)
    : null;
  const currentRenderPath = statePre.render && typeof statePre.render === "object" && !Array.isArray(statePre.render)
    && typeof statePre.render.mp4_path === "string"
    ? statePre.render.mp4_path
    : null;
  rawDeliverables.forEach((entry, index) => {
    const src = resolveExisting(entry && entry.path, `deliverables[${index}].path`);
    const entryShortId = normalizedShortId(entry && entry.short_id);
    assertValidShortId(entryShortId, `deliverables[${index}]`, fanOut);
    assertUniqueInCall(entryShortId, `deliverables[${index}]`);
    // Off-by-one guard for the on-rails loop: recording the CURRENT render
    // under a short other than the one the composition implements ships the
    // wrong video under the right id — and the completeness gate can't see it.
    if (
      entryShortId !== null
      && activeCompositionShortId !== null
      && currentRenderPath !== null
      && path.resolve(src) === path.resolve(currentRenderPath)
      && entryShortId !== activeCompositionShortId
    ) {
      throw new ToolError(
        ERROR_CODES.INVALID_ARGUMENTS,
        `deliverables[${index}].short_id "${entryShortId}" does not match the short the current render implements (composition.short_id "${activeCompositionShortId}") — the render at ${src} was produced from that short's composition`,
        { composition_short_id: activeCompositionShortId },
      );
    }
    const stem = safeStem((entry && entry.title) || path.basename(src), index);
    // Honest origin: a file from this session's renders/ was produced ON the
    // rails (the fan-out record-then-back-edge loop), not externally.
    const fromRenders = src.startsWith(rendersRoot + path.sep);
    toRecord.push({
      absPath: src,
      copyInPlace: false,
      destStem: stem,
      title: (entry && entry.title) || stem,
      notes: (entry && entry.notes) || null,
      origin: fromRenders ? "render" : "external",
      source_path: src,
      short_id: entryShortId,
    });
  });

  // Materialize each deliverable into the session deliverables/ dir (copy
  // external finals in; composite outputs already live there), optionally
  // loudness-normalize in place, probe, and build records.
  const records = [];
  for (let index = 0; index < toRecord.length; index += 1) {
    const item = toRecord[index];
    let finalAbs = item.absPath;
    if (!item.copyInPlace) {
      const ext = path.extname(item.absPath) || ".mp4";
      const destAbs = resolveDestAbs(item.destStem, ext, item.short_id);
      try {
        fs.copyFileSync(item.absPath, destAbs);
      } catch (error) {
        throw new ToolError(ERROR_CODES.INTERNAL_ERROR, `failed to copy deliverable into deliverables/: ${error.message || String(error)}`);
      }
      finalAbs = destAbs;
    }
    let loudnorm = null;
    if (normalize) {
      let summaryPre = null;
      try {
        summaryPre = summarizeProbe(finalAbs, probeFile(finalAbs));
      } catch {
        summaryPre = null;
      }
      loudnorm = summaryPre
        ? await normalizeLoudnessInPlace({ mp4Path: finalAbs, summaryPre })
        : { applied: false, skipped_reason: "probe_failed", error: null, measured_input_i: null, measured_input_tp: null };
    }
    // Derive the id from the ACTUAL materialized filename (post-dedup), not the
    // un-deduped stem — the `-n` suffix must reach the id or stem-keyed records
    // silently collapse.
    const finalExt = path.extname(finalAbs);
    const meta = describeVideo(finalAbs);
    // Chunk-level caption sidecars per deliverable (the package mirror): same
    // buildCaptionSidecar, fan-out-aware. Fan-out resolves this short's timeline
    // by short_id; a single-deliverable / escape-hatch import uses the
    // storyboard's top-level scenes[] (null storyboard -> no sidecar). The cue
    // ends clamp to the probed deliverable duration; skip when that is unknown.
    const stem = path.basename(finalAbs, finalExt) || safeStem(item.title, index);
    const captionScenes = item.short_id !== null && item.short_id !== undefined
      ? (() => { const t = findTimeline(storyboard, item.short_id); return t ? { scenes: t.scenes } : null; })()
      : storyboard;
    const captionSidecar = meta.duration_seconds !== null
      ? buildCaptionSidecar(captionScenes, {
        durationSeconds: meta.duration_seconds,
        transcriptForFileIndex: captionTranscriptResolver,
        transcriptAligned: captionTranscriptAligned,
      })
      : null;
    let captionsRel = null;
    if (captionSidecar) {
      const srtAbs = path.join(destDir, `${stem}.srt`);
      const vttAbs = path.join(destDir, `${stem}.vtt`);
      writeFileAtomic(srtAbs, captionSidecar.srt);
      writeFileAtomic(vttAbs, captionSidecar.vtt);
      captionsRel = { srt: sessionRelative(id, srtAbs), vtt: sessionRelative(id, vttAbs) };
    }
    records.push({
      id: stem,
      title: item.title,
      notes: item.notes,
      origin: item.origin,
      source_path: item.source_path,
      path: sessionRelative(id, finalAbs),
      ...(item.short_id !== null && item.short_id !== undefined ? { short_id: item.short_id } : {}),
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
      ...(captionSidecar
        ? {
          captions: {
            srt_path: captionsRel.srt,
            vtt_path: captionsRel.vtt,
            segment_count: captionSidecar.segment_count,
            level: "chunk",
            source: "caption_segments",
            // (v3.4) "forced_aligned" when cues were word-anchored to the aligned
            // transcript (matches the burn-in); "storyboard_target" otherwise.
            timing_basis: captionSidecar.timing_basis || "storyboard_target",
          },
        }
        : {}),
      ...meta,
      imported_at: nowIso(),
    });
  }

  const importedAt = nowIso();
  return withSessionLock(id, () => {
    const stateNow = readSessionStateStrict(id);
    const fromPhase = stateNow.phase;
    const priorNow = Array.isArray(stateNow.deliverables) ? stateNow.deliverables : [];
    // Merge by identity: short_id when present (fan-out — revision replaces the
    // short's record), filename-stem id otherwise (free-form escape hatch).
    const byKey = new Map(priorNow.map((d) => [deliverableKey(d), d]));
    const supersededRelPaths = [];
    for (const r of records) {
      const key = deliverableKey(r);
      const prior = byKey.get(key);
      if (prior && typeof prior.path === "string" && prior.path !== "" && prior.path !== r.path) {
        supersededRelPaths.push(prior.path);
      }
      byKey.set(key, r);
    }
    const merged = Array.from(byKey.values());
    // A replaced short's old file (different stem) is superseded — remove it so
    // deliverables/ holds exactly the current set, along with its old caption
    // sidecars (siblings of the superseded .mp4). Best-effort.
    for (const rel of supersededRelPaths) {
      const abs = path.resolve(sessionDir(id), rel);
      try { fs.rmSync(abs, { force: true }); } catch {}
      const oldStem = abs.slice(0, abs.length - path.extname(abs).length);
      try { fs.rmSync(`${oldStem}.srt`, { force: true }); } catch {}
      try { fs.rmSync(`${oldStem}.vtt`, { force: true }); } catch {}
    }

    // deliverables/manifest.json — the fan-out set's presentable manifest (the
    // analog of package/manifest.json for multi-deliverable projects). The
    // post-copy block mirrors the single-timeline package manifest — multi-short
    // fan-out is precisely the multi-platform-distribution case. Chapters-free
    // here (fan-out has no document-level segments).
    const distribution = distributionFromStoryboard(storyboard);
    const deliverablesManifestAbs = path.join(destDir, "manifest.json");
    writeFileAtomic(deliverablesManifestAbs, `${JSON.stringify({
      manifest_version: "1.0",
      project_id: id,
      generated_at: importedAt,
      derived_from: stateNow.style && stateNow.style.derived_from ? stateNow.style.derived_from : null,
      ...(distribution ? { distribution } : {}),
      deliverable_count: merged.length,
      deliverables: merged,
    }, null, 2)}\n`);

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
          normalize,
          count: records.length,
          ids: records.map((r) => r.id),
          short_ids: records.map((r) => r.short_id || null),
          caption_segment_counts: records.map((r) => (r.captions ? r.captions.segment_count : 0)),
          superseded_files: supersededRelPaths.length,
          note: "deliverables recorded outside the single-timeline package (fan-out shorts / overlay escape hatch)",
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
      deliverables_manifest_path: deliverablesManifestAbs,
      deliverables: records,
    };
  });
}

module.exports = Object.freeze({
  name: "vob_import_deliverable",
  description: "Record finished deliverables into the session-level deliverables/ dir + state.deliverables[] — the multi-deliverable path. Two uses: (1) the ON-RAILS fan-out loop — after vob_confirm_render, record the rendered short with deliverables:[{path: <render mp4>, title, short_id}] (short_id REQUIRED when the storyboard has shorts[]; the record's identity — a re-import with the same short_id REPLACES that short's record); (2) the escape hatch for externally-produced finals, optionally compositing first via `composite` ({base,overlay,audio?,scale_to_base?}: transparent overlay over an ffmpeg-cut base). Pass normalize:true to two-pass loudness-normalize each file to −14 LUFS/−1 dBTP in place (same pass as vob_package_output; skip reasons recorded per file). Files from this session's renders/ get origin:'render'. Regenerates deliverables/manifest.json (the fan-out package manifest) on every call. Files are kept OUT of package/ so vob_package_output can't delete them; by default advances phase to PACKAGE (PACKAGE→ITERATE is unlocked by the deliverables set) — pass set_phase:false while still cycling shorts in RENDER. Appends 'external_deliverables_imported' to history. Does NOT touch the single-timeline composition/render/preview slots.",
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
            short_id: { type: "string", minLength: 1, description: "Fan-out: the storyboard short this deliverable implements. Required when the storyboard has shorts[]; the record's merge identity." },
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
          short_id: { type: "string", minLength: 1 },
        },
        required: ["base", "overlay"],
        additionalProperties: false,
      },
      normalize: { type: "boolean", description: "Two-pass loudness-normalize each imported file to −14 LUFS/−1 dBTP in place (default false). Non-applied passes record a skipped_reason and the import continues." },
      set_phase: { type: "boolean", description: "Advance phase to PACKAGE (default true). Pass false to record without changing phase — e.g. mid-fan-out while still in RENDER." },
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
