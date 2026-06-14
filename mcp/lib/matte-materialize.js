"use strict";

// Subject-matte materialization (v3.3 subject compositing) — a near-clone of
// clip-materialize.js. For every render_mode:"subject" placement, lift the
// subject off its filmed background with hyperframes remove-background, writing
// an alpha .webm under transcoded/mattes/ keyed by a content-hash sidecar so a
// back-edge COMPOSE re-entry is a no-op (byte-for-byte the clip-materialize
// discipline).
//
// INPUT = the ALREADY-PRE-CUT clip (transcodedClipPath) the subject references,
// so the matte is trimmed/sped exactly like the spine and we never re-trim. This
// runs RIGHT AFTER materializeSceneClips at COMPOSE entry, so that pre-cut clip
// already exists on disk.
//
// DEGRADES, never throws on a matte failure: a missing/uncached model, an
// unavailable backend, or a failed inference is recorded per-matte (status
// "failed"/"unavailable"/"skipped") and COMPOSE STILL PROCEEDS — a subject
// placement is an enhancement, not the spine, and a hard failure here would
// strand the user mid-pipeline (the PRD's "a mid-pipeline failure must not
// strand COMPOSE"). The composer treats a missing matte as "subject mode
// unavailable for this clip" and falls back to a rectangular pip. (Programmer
// errors — a malformed storyboard — still throw via loadStoryboardOrThrow,
// mirroring clip-materialize.)

const fs = require("fs");
const crypto = require("crypto");

const { writeFileAtomic } = require("./storage.js");
const { recommendedHeavyEncodeConcurrency, mapWithConcurrency } = require("./concurrency.js");
const { stderrTail } = require("./spawn-with-shutdown.js");
const { collectSubjectPlacements } = require("./storyboard-schema.js");
const { loadStoryboardOrThrow } = require("./clip-materialize.js");
const {
  buildRemoveBackgroundArgv,
  runRemoveBackground,
  removeBackgroundTimeoutMs,
  resolveRemoveBgDevice,
  removeBackgroundDisabled,
  checkRemoveBackgroundAvailable,
} = require("./hyperframes-runner.js");
const hostProfile = require("./host-profile.js");
const {
  assertSafeProjectId,
  mattePath,
  matteSidecarPath,
  mattesDir,
  transcodedClipPath,
} = require("./paths.js");

const MATTE_SIDECAR_SCHEMA_VERSION = "1.0";
const MATTE_QUALITY = "balanced";

function nowIso() {
  return new Date().toISOString();
}

function hashArgv(argv) {
  return crypto.createHash("sha256").update(argv.join(" ")).digest("hex").slice(0, 16);
}

function sourceMtimeMs(srcPath) {
  try {
    return fs.statSync(srcPath).mtimeMs;
  } catch {
    return null;
  }
}

function readSidecarSafe(sidecarPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// The matte is invalidated when its INPUT clip changes (path/mtime — a re-cut
// bumps mtime) or the matte argv (device/quality/format) changes. Same content-
// hash discipline as the clip sidecar, keyed on the pre-cut clip rather than the
// raw source.
function sidecarMatches(sidecar, { clipPath, clipMtimeMs, argvHash }) {
  if (!sidecar) return false;
  return (
    sidecar.schema_version === MATTE_SIDECAR_SCHEMA_VERSION
    && sidecar.source_clip_path === clipPath
    && sidecar.source_clip_mtime_ms === clipMtimeMs
    && sidecar.remove_bg_argv_hash === argvHash
  );
}

async function materializeSubjectMattes({ projectId, storyboard = null } = {}) {
  const id = assertSafeProjectId(projectId);
  const sb = storyboard || loadStoryboardOrThrow(id);
  const placements = collectSubjectPlacements(sb);

  const device = resolveRemoveBgDevice();
  const subjectSecondsMax = hostProfile.subjectBudget().subjectSecondsMax;
  const summary = {
    schema_version: MATTE_SIDECAR_SCHEMA_VERSION,
    project_id: id,
    generated_at: nowIso(),
    device,
    quality: MATTE_QUALITY,
    backend_available: null,
    subject_seconds_total: 0,
    subject_seconds_max: subjectSecondsMax,
    over_budget: false,
    mattes: [],
    summary: { total: 0, matted: 0, cached: 0, skipped: 0, failed: 0, unavailable: 0 },
  };

  if (placements.length === 0) return summary; // nothing to matte; don't probe

  // Dedup by (scene_id, clip_index): multiple placements can reference the same
  // clip → one matte. scene_ids are document-globally unique, so the key is
  // unambiguous across shorts.
  const byKey = new Map();
  let subjectSecondsTotal = 0;
  for (const p of placements) {
    if (typeof p.scene_id !== "string" || !Number.isInteger(p.clip_index) || p.clip_index < 0) {
      continue; // shape validation rejects this; defensive skip
    }
    const key = `${p.scene_id}:${p.clip_index}`;
    if (byKey.has(key)) continue; // one matte per unique clip — don't double-count cost
    byKey.set(key, p);
    if (Number.isFinite(p.clip_seconds) && p.clip_seconds > 0) subjectSecondsTotal += p.clip_seconds;
  }
  summary.subject_seconds_total = Math.round(subjectSecondsTotal * 10) / 10;
  summary.over_budget = subjectSecondsTotal > subjectSecondsMax; // runtime echo of the plan-lint warning
  summary.summary.total = byKey.size;

  if (byKey.size === 0) return summary;

  // Kill-switch: skip ALL matting (record each subject "skipped") so the run
  // never downloads the model / spends matte time — the composer falls back to a
  // rectangular pip. backend_available:false signals "not produced".
  if (removeBackgroundDisabled()) {
    for (const p of byKey.values()) {
      summary.mattes.push({
        scene_id: p.scene_id,
        clip_index: p.clip_index,
        matte_path: mattePath(id, p.scene_id, p.clip_index),
        status: "skipped",
        reason: "disabled_via_env",
      });
      summary.summary.skipped += 1;
    }
    summary.backend_available = false;
    return summary;
  }

  // Preflight ONCE: a missing binary/provider degrades the whole batch to
  // "unavailable" (no crash) — the human was already warned at INGEST/doctor.
  const avail = checkRemoveBackgroundAvailable();
  summary.backend_available = avail.ok === true;
  if (!avail.ok) {
    for (const p of byKey.values()) {
      summary.mattes.push({
        scene_id: p.scene_id,
        clip_index: p.clip_index,
        matte_path: mattePath(id, p.scene_id, p.clip_index),
        status: "unavailable",
        error: avail.error || "remove-background backend unavailable",
      });
      summary.summary.unavailable += 1;
    }
    return summary;
  }

  fs.mkdirSync(mattesDir(id), { recursive: true });

  // Pass 1 (serial, cheap): cache checks. Misses become pass-2 tasks.
  const tasks = [];
  for (const p of byKey.values()) {
    const clipPath = transcodedClipPath(id, p.scene_id, p.clip_index);
    const outPath = mattePath(id, p.scene_id, p.clip_index);
    const sidecarPath = matteSidecarPath(id, p.scene_id, p.clip_index);
    if (!fs.existsSync(clipPath)) {
      // The subject's pre-cut clip isn't on disk — materializeSceneClips runs
      // first and should have produced it (the placement references a real scene
      // source_clip). Warn-by-status, don't throw (degrade).
      summary.mattes.push({
        scene_id: p.scene_id,
        clip_index: p.clip_index,
        matte_path: outPath,
        status: "skipped",
        reason: "source_clip_not_materialized",
        source_clip_path: clipPath,
      });
      summary.summary.skipped += 1;
      continue;
    }
    const argv = buildRemoveBackgroundArgv({ inPath: clipPath, outPath, quality: MATTE_QUALITY, device });
    const argvHash = hashArgv(argv);
    const clipMtimeMs = sourceMtimeMs(clipPath);
    const sidecar = readSidecarSafe(sidecarPath);
    if (fs.existsSync(outPath) && sidecarMatches(sidecar, { clipPath, clipMtimeMs, argvHash })) {
      summary.mattes.push({
        scene_id: p.scene_id,
        clip_index: p.clip_index,
        matte_path: outPath,
        status: "cached",
        source_clip_path: clipPath,
      });
      summary.summary.cached += 1;
      continue;
    }
    tasks.push({
      sceneId: p.scene_id, clipIndex: p.clip_index,
      clipPath, outPath, sidecarPath, argv, argvHash, clipMtimeMs, clipSeconds: p.clip_seconds,
    });
  }

  // Pass 2: bounded-parallel mattes. A failure DEGRADES (status "failed") — it
  // NEVER aborts COMPOSE (unlike clip-materialize, whose missing spine clip is
  // fatal). remove-background is RAM-heavy (~1.5 GB peak per the --info probe),
  // so the same heavy-encode concurrency ceiling caps the fan-out.
  const limit = recommendedHeavyEncodeConcurrency();
  await mapWithConcurrency(tasks, limit, async (task) => {
    const startedAt = Date.now();
    let result;
    try {
      result = await runRemoveBackground(task.argv, { timeoutMs: removeBackgroundTimeoutMs(task.clipSeconds) });
    } catch (error) {
      summary.mattes.push({
        scene_id: task.sceneId, clip_index: task.clipIndex, matte_path: task.outPath,
        status: "failed", error: `remove-background threw: ${error.message || error}`,
      });
      summary.summary.failed += 1;
      return;
    }
    if (!result.ok || result.timed_out || !fs.existsSync(task.outPath)) {
      summary.mattes.push({
        scene_id: task.sceneId, clip_index: task.clipIndex, matte_path: task.outPath,
        status: "failed",
        error: result.timed_out
          ? "remove-background timed out"
          : `remove-background exit ${result.exit_code}: ${stderrTail(result.stderr, 800) || "no stderr"}`,
      });
      summary.summary.failed += 1;
      return;
    }
    const matteSeconds = (Date.now() - startedAt) / 1000;
    writeFileAtomic(task.sidecarPath, `${JSON.stringify({
      schema_version: MATTE_SIDECAR_SCHEMA_VERSION,
      scene_id: task.sceneId,
      clip_index: task.clipIndex,
      source_clip_path: task.clipPath,
      source_clip_mtime_ms: task.clipMtimeMs,
      remove_bg_argv_hash: task.argvHash,
      device,
      quality: MATTE_QUALITY,
      matte_duration_seconds: matteSeconds,
      generated_at: nowIso(),
    }, null, 2)}\n`);
    summary.mattes.push({
      scene_id: task.sceneId, clip_index: task.clipIndex, matte_path: task.outPath,
      status: "matted", source_clip_path: task.clipPath, matte_duration_seconds: matteSeconds,
    });
    summary.summary.matted += 1;
  });

  summary.concurrency = limit;
  return summary;
}

module.exports = {
  MATTE_SIDECAR_SCHEMA_VERSION,
  materializeSubjectMattes,
};
