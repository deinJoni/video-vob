"use strict";

// Multi-cell layout materialization (v3.4 split-screen / multi-crop) — a sibling
// of clip-materialize.js / matte-materialize.js. For every scene carrying a
// usable scene.layout, composite its cells' ALREADY-PRE-CUT clips into ONE clip
// at the output dimensions, written under transcoded/layouts/<scene_id>.mp4 and
// keyed by a content-hash sidecar so a back-edge COMPOSE re-entry is a no-op.
//
// INPUT = the pre-cut cell clips (transcodedClipPath), so each cell is already
// trimmed/sped exactly like the spine. This runs RIGHT AFTER materializeSceneClips
// at COMPOSE entry (those clips already exist on disk) and BEFORE the render plan.
//
// WHY pre-composite (vs CSS-positioning two <video> elements): a split-screen
// scene would otherwise add N concurrent <video> elements, which both eats the
// host <video> budget and is exactly the multi-<video> capture path that's
// fragile on a low-RAM / few-CPU host (the reason this footage went off-rails).
// Baking the composite into ONE clip makes the scene a single <video>.
//
// DEGRADES, never throws on a composite failure (mirrors matte-materialize): a
// missing cell clip, a malformed layout, or a failed ffmpeg run is recorded
// per-layout (status "skipped"/"failed") and COMPOSE STILL PROCEEDS — the
// composer treats a missing layout clip as "render the cells yourself" and falls
// back to CSS-positioned <video> cells. (Programmer errors — a malformed
// storyboard — still throw via loadStoryboardOrThrow, mirroring clip-materialize.)

const fs = require("fs");
const crypto = require("crypto");

const { writeFileAtomic } = require("./storage.js");
const { recommendedHeavyEncodeConcurrency, mapWithConcurrency } = require("./concurrency.js");
const { stderrTail } = require("./spawn-with-shutdown.js");
const { collectSceneLayouts } = require("./storyboard-schema.js");
const { loadStoryboardOrThrow } = require("./clip-materialize.js");
const { buildLayoutCompositeArgv, compositeLayout } = require("./ffmpeg-runner.js");
const { resolvePlatform } = require("./platform-profiles.js");
const {
  assertSafeProjectId,
  layoutsDir,
  layoutPath,
  layoutSidecarPath,
  transcodedClipPath,
} = require("./paths.js");

const LAYOUT_SIDECAR_SCHEMA_VERSION = "1.0";
const DEFAULT_DIMS = Object.freeze({ width: 1080, height: 1920 }); // generic 9:16 fallback

function nowIso() {
  return new Date().toISOString();
}

function hashArgv(argv) {
  return crypto.createHash("sha256").update(argv.join(" ")).digest("hex").slice(0, 16);
}

function fileMtimeMs(p) {
  try {
    return fs.statSync(p).mtimeMs;
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

// Invalidated when any cell clip changes (path/mtime — a re-cut bumps mtime) or
// the composite argv (type/dims/cells/audio/background) changes.
function sidecarMatches(sidecar, { inputs, inputMtimes, argvHash }) {
  if (!sidecar) return false;
  if (sidecar.schema_version !== LAYOUT_SIDECAR_SCHEMA_VERSION) return false;
  if (sidecar.composite_argv_hash !== argvHash) return false;
  const prevInputs = Array.isArray(sidecar.inputs) ? sidecar.inputs : null;
  if (!prevInputs || prevInputs.length !== inputs.length) return false;
  for (let i = 0; i < inputs.length; i += 1) {
    if (prevInputs[i] !== inputs[i]) return false;
    if ((Array.isArray(sidecar.input_mtimes_ms) ? sidecar.input_mtimes_ms[i] : null) !== inputMtimes[i]) return false;
  }
  return true;
}

// Output dims for the composite: the storyboard target's explicit width/height
// if present, else the canonical platform profile, else a 9:16 fallback. A
// layout clip is dropped full-frame by the composer, so it must match the
// composition master dimensions.
// libx264 + yuv420p require EVEN dimensions — an odd width/height aborts the
// encode ("width not divisible by 2"), which would silently fail EVERY layout
// composite. Author-supplied target.width/height are not shape-validated, so
// floor both to even here (the platform profiles are already even; this is
// defense in depth + a guard for a hand-authored odd target).
function evenFloor(n) {
  return Math.floor(n / 2) * 2;
}

function resolveOutputDims(storyboard) {
  const target = storyboard && typeof storyboard.target === "object" && !Array.isArray(storyboard.target)
    ? storyboard.target
    : null;
  if (target && Number.isFinite(target.width) && Number.isFinite(target.height)
    && target.width > 1 && target.height > 1) {
    return { width: evenFloor(target.width), height: evenFloor(target.height) };
  }
  const platform = target && typeof target.platform === "string" ? target.platform : null;
  if (platform) {
    try {
      const { profile } = resolvePlatform(platform);
      if (profile && Number.isFinite(profile.width) && Number.isFinite(profile.height)) {
        return { width: evenFloor(profile.width), height: evenFloor(profile.height) };
      }
    } catch { /* fall through to default */ }
  }
  return { ...DEFAULT_DIMS };
}

async function materializeSceneLayouts({ projectId, storyboard = null } = {}) {
  const id = assertSafeProjectId(projectId);
  const sb = storyboard || loadStoryboardOrThrow(id);
  const layouts = collectSceneLayouts(sb);

  const dims = resolveOutputDims(sb);
  const summary = {
    schema_version: LAYOUT_SIDECAR_SCHEMA_VERSION,
    project_id: id,
    generated_at: nowIso(),
    width: dims.width,
    height: dims.height,
    layouts: [],
    summary: { total: 0, composited: 0, cached: 0, skipped: 0, failed: 0 },
  };

  if (layouts.length === 0) return summary;

  // Dedup by scene_id (one composite per layout scene; scene_ids are document-
  // globally unique). A scene only declares ONE layout, but the union across
  // shorts can list the same scene once — defensive de-dup mirrors the matte path.
  const byScene = new Map();
  for (const l of layouts) {
    if (typeof l.scene_id !== "string" || !l.scene_id) continue;
    if (!byScene.has(l.scene_id)) byScene.set(l.scene_id, l);
  }
  summary.summary.total = byScene.size;
  if (byScene.size === 0) return summary;

  fs.mkdirSync(layoutsDir(id), { recursive: true });

  // Pass 1 (serial, cheap): resolve cell clips + cache checks. Misses → pass-2 tasks.
  const tasks = [];
  for (const l of byScene.values()) {
    const outPath = layoutPath(id, l.scene_id);
    const sidecarPath = layoutSidecarPath(id, l.scene_id);
    const cellCount = Array.isArray(l.cells) ? l.cells.length : null;
    if (!l.resolved) {
      summary.layouts.push({
        scene_id: l.scene_id, layout_path: outPath, type: l.type, cells: cellCount,
        status: "skipped", reason: "cell_clip_index_out_of_range",
      });
      summary.summary.skipped += 1;
      continue;
    }
    const inputs = l.cells.map((c) => transcodedClipPath(id, l.scene_id, c.clip_index));
    const missing = inputs.find((p) => !fs.existsSync(p));
    if (missing) {
      // A cell's pre-cut clip isn't on disk — materializeSceneClips runs first and
      // should have produced it. Warn-by-status, don't throw (degrade).
      summary.layouts.push({
        scene_id: l.scene_id, layout_path: outPath, type: l.type, cells: cellCount,
        status: "skipped", reason: "cell_clip_not_materialized", missing_input: missing,
      });
      summary.summary.skipped += 1;
      continue;
    }
    const argv = buildLayoutCompositeArgv({
      inputs, type: l.type, outPath, width: dims.width, height: dims.height,
      cells: l.cells, audioCell: l.audio_cell, background: l.background || "black",
    });
    const argvHash = hashArgv(argv);
    const inputMtimes = inputs.map(fileMtimeMs);
    const sidecar = readSidecarSafe(sidecarPath);
    if (fs.existsSync(outPath) && sidecarMatches(sidecar, { inputs, inputMtimes, argvHash })) {
      summary.layouts.push({
        scene_id: l.scene_id, layout_path: outPath, type: l.type, status: "cached", cells: l.cells.length,
      });
      summary.summary.cached += 1;
      continue;
    }
    tasks.push({ scene_id: l.scene_id, type: l.type, inputs, inputMtimes, outPath, sidecarPath, argvHash, cells: l.cells, audioCell: l.audio_cell, background: l.background || "black" });
  }

  // Pass 2: bounded-parallel composites. A failure DEGRADES (status "failed") —
  // it NEVER aborts COMPOSE (unlike clip-materialize, whose missing spine clip is
  // fatal). The composite re-encodes N inputs, so the heavy-encode ceiling caps it.
  const limit = recommendedHeavyEncodeConcurrency();
  await mapWithConcurrency(tasks, limit, async (task) => {
    const startedAt = Date.now();
    let result;
    try {
      result = await compositeLayout({
        inputs: task.inputs, type: task.type, outPath: task.outPath,
        width: dims.width, height: dims.height, cells: task.cells,
        audioCell: task.audioCell, background: task.background,
      });
    } catch (error) {
      summary.layouts.push({
        scene_id: task.scene_id, layout_path: task.outPath, type: task.type,
        cells: Array.isArray(task.cells) ? task.cells.length : null,
        status: "failed", error: `layout composite threw: ${error.message || error}`,
      });
      summary.summary.failed += 1;
      return;
    }
    if (result.timed_out || result.exit_code !== 0 || !fs.existsSync(task.outPath)) {
      summary.layouts.push({
        scene_id: task.scene_id, layout_path: task.outPath, type: task.type,
        cells: Array.isArray(task.cells) ? task.cells.length : null,
        status: "failed",
        error: result.timed_out
          ? "layout composite timed out"
          : `ffmpeg layout composite exit ${result.exit_code}: ${stderrTail(result.stderr, 800) || "no stderr"}`,
      });
      summary.summary.failed += 1;
      return;
    }
    const compositeSeconds = (Date.now() - startedAt) / 1000;
    writeFileAtomic(task.sidecarPath, `${JSON.stringify({
      schema_version: LAYOUT_SIDECAR_SCHEMA_VERSION,
      scene_id: task.scene_id,
      type: task.type,
      inputs: task.inputs,
      input_mtimes_ms: task.inputMtimes,
      width: dims.width,
      height: dims.height,
      composite_argv_hash: task.argvHash,
      composite_duration_seconds: compositeSeconds,
      generated_at: nowIso(),
    }, null, 2)}\n`);
    summary.layouts.push({
      scene_id: task.scene_id, layout_path: task.outPath, type: task.type,
      status: "composited", cells: task.cells.length, composite_duration_seconds: compositeSeconds,
    });
    summary.summary.composited += 1;
  });

  summary.concurrency = limit;
  return summary;
}

module.exports = {
  LAYOUT_SIDECAR_SCHEMA_VERSION,
  materializeSceneLayouts,
};
