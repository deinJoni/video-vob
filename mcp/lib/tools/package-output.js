"use strict";

const fs = require("fs");
const path = require("path");

const { ERROR_CODES, ToolError } = require("../envelope.js");
const {
  assertSafeProjectId,
  manifestPath: ingestManifestPath,
  packageCaptionsSrtPath,
  packageCaptionsVttPath,
  packageDir,
  packageFinalMp4Path,
  packageManifestPath,
  packagePostersDir,
  packageReadmePath,
  packageThumbnailPath,
  packageVariantsDir,
  rendersDir,
  sessionDir,
  statePath,
  storyboardPath,
} = require("../paths.js");
const { readJsonFile, withSessionLock, writeFileAtomic } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");
const { probeFile, summarizeProbe } = require("../ffprobe.js");
const {
  runFfmpegBlocking,
  checkFfmpegAvailable,
  LOUDNORM_TARGET,
} = require("../ffmpeg-runner.js");
const { normalizeLoudnessInPlace } = require("../loudnorm.js");
const { buildCaptionSidecar } = require("../caption-sidecar.js");
const { buildTranscriptResolver, distributionFromStoryboard, loadTranscript, storyboardHasSegments, storyboardHasShorts, storyboardSegments, storyboardTimelines } = require("../storyboard-schema.js");
const { renderPlanOf } = require("../render-segments.js");
const { stderrTail } = require("../spawn-with-shutdown.js");
const { thumbnailTimestampPercent, canonicalizePlatform, getPlatformProfile } = require("../platform-profiles.js");
const { resolveActiveVideoType } = require("../video-types.js");
const { renderPackageReadme } = require("../package-readme.js");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const VERSION_FILE_PATH = path.join(PROJECT_ROOT, ".vob", "VERSION");

function nowIso() {
  return new Date().toISOString();
}

function readVideoVobVersion() {
  try {
    return fs.readFileSync(VERSION_FILE_PATH, "utf8").trim() || null;
  } catch {
    return null;
  }
}

// Platform for the thumbnail percent: canonical intent answer first (v2 object
// {raw,canonical,profile} or legacy string), falling back to the init-time
// state.target.format hint, else "" -> vertical profile (percent 10).
function thumbnailPercentForIntent(state) {
  const answers = state && state.intent && state.intent.answers ? state.intent.answers : {};
  const tp = answers.target_platform;
  const platformRaw = ((tp && typeof tp === "object" && !Array.isArray(tp))
    ? (tp.canonical || tp.raw || "")
    : (typeof tp === "string" ? tp : null))
    || (state && state.target && typeof state.target.format === "string" ? state.target.format : "");
  return thumbnailTimestampPercent(canonicalizePlatform(platformRaw || "").canonical);
}

// Pick the thumbnail moment: midpoint of the storyboard hook scene in OUTPUT
// time (scene starts are cumulative target durations), clamped to the probed
// duration; fall back to the configured percent (default 10%).
function resolveThumbnailMoment({ projectId, durationSeconds, state }) {
  let sb = null;
  try {
    sb = JSON.parse(fs.readFileSync(storyboardPath(projectId), "utf8"));
  } catch {}
  if (sb && Array.isArray(sb.scenes)) {
    let cursor = 0;
    for (const scene of sb.scenes) {
      const d = Number(scene && scene.target_duration_seconds);
      if (!Number.isFinite(d) || d <= 0) { cursor = NaN; break; }
      if (scene.purpose === "hook") {
        const at = Math.max(0, Math.min(cursor + d / 2, Math.max(0, durationSeconds - 0.01)));
        return { seconds: at, strategy: "hook_scene_midpoint", hook_scene_id: scene.scene_id || null };
      }
      cursor += d;
    }
  }
  const percent = thumbnailPercentForIntent(state);
  const at = Math.max(0, Math.min(durationSeconds * (percent / 100), Math.max(0, durationSeconds - 0.01)));
  return { seconds: at, strategy: "percent", hook_scene_id: null, percent };
}

// How many posters to extract (poster_0 = the canonical thumbnail included).
// VOB_POSTER_COUNT (a finite integer ≥1, clamped ≤12 to bound ffmpeg calls)
// overrides; otherwise default to one-per-chapter-plus-hook capped at 5 when
// chapters exist, else 3 (hook + two percent stops).
function resolvePosterCount(chapters) {
  const env = parseInt(process.env.VOB_POSTER_COUNT, 10);
  if (Number.isFinite(env) && env >= 1) return Math.min(env, 12);
  return chapters && chapters.length > 0 ? Math.min(chapters.length + 1, 5) : 3;
}

// Generalize resolveThumbnailMoment into an ordered, deduped poster-moment list
// (poster_0 == the canonical thumbnail moment exactly). Pure beyond the one
// storyboard read chaptersFromStoryboard needs (chapters are passed in here).
// Each moment is clamped to [0, duration-0.01] (mirrors resolveThumbnailMoment)
// and deduped within ~0.5s (first-wins) so a chapter start coinciding with the
// hook midpoint doesn't double-extract. poster_0 is always retained.
function resolvePosterMoments({ projectId, durationSeconds, state, count, chapters }) {
  const cap = Math.max(0, durationSeconds - 0.01);
  const clamp = (s) => Math.max(0, Math.min(s, cap));
  const moments = [];
  // 1. Seed with the canonical thumbnail moment (poster_0).
  const canonical = resolveThumbnailMoment({ projectId, durationSeconds, state });
  moments.push({ seconds: canonical.seconds, strategy: canonical.strategy, label: null });
  // 2. Chapter starts, in order.
  if (Array.isArray(chapters)) {
    for (const ch of chapters) {
      const s = Number(ch && ch.start_seconds);
      if (!Number.isFinite(s)) continue;
      moments.push({ seconds: clamp(s), strategy: "chapter_start", label: ch.title || null });
    }
  }
  // 3. Evenly-spaced percent stops (25/50/75%) so the count is reachable when
  //    there are few/no chapters.
  for (const pct of [25, 50, 75]) {
    moments.push({ seconds: clamp(durationSeconds * (pct / 100)), strategy: "percent_stop", label: null });
  }
  // 4. Dedupe within ~0.5s, first-wins, order-preserving; poster_0 stays.
  const deduped = [];
  for (const m of moments) {
    if (deduped.some((kept) => Math.abs(kept.seconds - m.seconds) <= 0.5)) continue;
    deduped.push(m);
  }
  // 5. Cap at count (poster_0 at index 0 is never dropped).
  return deduped.slice(0, Math.max(1, count));
}

function sessionRelative(projectId, absPath) {
  return path.relative(sessionDir(projectId), absPath);
}

// YouTube chapter stamp: M:SS under an hour, H:MM:SS above.
function youtubeStamp(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

// Chapter markers from the storyboard's NARRATIVE segments (acts/chapters) —
// start times are cumulative scene durations at each segment boundary. null
// when the storyboard declares no segments (or is unreadable/malformed).
function chaptersFromStoryboard(sb) {
  if (!sb || !storyboardHasSegments(sb)) return null;
  const segments = storyboardSegments(sb);
  if (segments.length === 0) return null;
  const chapters = [];
  let cursor = 0;
  for (const segment of segments) {
    if (segment.target_duration_seconds === null) return null; // malformed scene durations
    chapters.push({
      segment_id: segment.segment_id,
      title: segment.title || segment.segment_id,
      start_seconds: Math.round(cursor * 1000) / 1000,
      youtube_stamp: youtubeStamp(cursor),
      duration_seconds: segment.target_duration_seconds,
    });
    cursor += segment.target_duration_seconds;
  }
  return chapters;
}

// PACKAGE distribution block: the chapters-agnostic field normalizer
// (distributionFromStoryboard, shared with the import path) plus a
// chapters_paste_block layered on top — a single newline-joined string of
// "youtube_stamp title" lines, ONLY when chapters is a non-empty array (a
// non-chaptered short never emits a half-satisfied "≥3 entries / first at 0:00"
// block). Returns null only when distribution is entirely absent.
function distributionForPackage(sb, chapters) {
  const block = distributionFromStoryboard(sb);
  if (block === null) return null;
  if (Array.isArray(chapters) && chapters.length > 0) {
    return {
      ...block,
      chapters_paste_block: chapters.map((c) => `${c.youtube_stamp} ${c.title}`).join("\n"),
    };
  }
  return block;
}

function cleanupOnFailure(pkgRoot) {
  try {
    fs.rmSync(pkgRoot, { recursive: true, force: true });
  } catch {}
}

// Accepted aspect-variant tokens: the standard aspect labels plus the canonical
// platform names that map to them. canonicalizePlatform NEVER throws (it coerces
// an unknown token to vertical/recognized:false), so a tight allowlist is what
// keeps the dumb-crop hatch from silently producing a vertical variant for
// "banana". "4:5" is deliberately absent — no profile exists for it today, so it
// rejects until one is added via render-profiles.json (the intended override).
const ASPECT_VARIANT_ALLOWLIST = Object.freeze(new Set([
  "1:1", "16:9", "9:16",
  "square", "landscape", "vertical",
]));

// Colon-safe filename slug: "1:1" -> "1x1", "16:9" -> "16x9". Never a colon in a
// path. Non-aspect tokens (canonical platform names) pass through lowercased.
function aspectSlug(aspect) {
  return String(aspect).toLowerCase().replace(/:/g, "x").replace(/[^a-z0-9x._-]+/g, "-");
}

// Best-effort "W:H" label for the source video (the `source_aspect` field) —
// the reduced ratio, e.g. 1080×1920 -> "9:16". null when dims are unusable.
function aspectLabelOf(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
  const g = gcd(Math.round(width), Math.round(height)) || 1;
  return `${Math.round(width) / g}:${Math.round(height) / g}`;
}

// Validate + canonicalize the opt-in aspect_variants arg, BEFORE any package
// work (refusal-before-wipe). Returns an ordered, deduped list of resolved
// targets [{ aspect, canonical, width, height, slug }]; an empty/absent arg
// returns []. Throws INVALID_ARGUMENTS on a bad shape or an unrecognized /
// non-allowlisted token — relying on canonicalizePlatform's `recognized` flag,
// since that function coerces rather than throwing on an unknown token.
function resolveAspectVariants(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, "aspect_variants must be an array of aspect-label strings (e.g. [\"1:1\",\"16:9\"])");
  }
  const resolved = [];
  const seen = new Set();
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, `aspect_variants entries must be non-empty strings, got ${JSON.stringify(entry)}`);
    }
    const token = entry.trim().toLowerCase();
    if (!ASPECT_VARIANT_ALLOWLIST.has(token)) {
      throw new ToolError(
        ERROR_CODES.INVALID_ARGUMENTS,
        `unknown aspect_variant "${entry}" — accepted: ${[...ASPECT_VARIANT_ALLOWLIST].join(", ")} (add a profile to render-profiles.json for others)`,
        { aspect: entry },
      );
    }
    const { canonical, recognized } = canonicalizePlatform(token);
    if (!recognized) {
      // Defense in depth: the allowlist tokens all resolve, but a coerced
      // fallback (recognized:false -> vertical) must never silently crop.
      throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, `unrecognized aspect_variant "${entry}"`, { aspect: entry });
    }
    const profile = getPlatformProfile(canonical);
    const width = Number(profile && profile.width);
    const height = Number(profile && profile.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, `aspect_variant "${entry}" resolves to a profile without usable dimensions`, { aspect: entry });
    }
    // De-dupe on the canonical geometry so "1:1" and "square" don't both run.
    const key = `${width}x${height}`;
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push({ aspect: entry, canonical, width, height, slug: aspectSlug(entry) });
  }
  return resolved;
}

// Pure-ffmpeg dumb-crop: scale to COVER the target then center-crop to the exact
// target dimensions; audio is `-c:a copy` (the source final.mp4 is already the
// −14 LUFS normalized track — never a second loudnorm pass). Returns
// { ok, record?, error? }; NEVER throws on an ffmpeg failure and NEVER calls
// cleanupOnFailure — a failed variant must not destroy the package.
async function buildAspectVariant({ finalMp4, variantPath, target, sourceVideo, pkgRoot }) {
  let result;
  try {
    result = await runFfmpegBlocking(
      [
        "-y",
        "-i", finalMp4,
        "-vf", `scale=${target.width}:${target.height}:force_original_aspect_ratio=increase,crop=${target.width}:${target.height}`,
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-c:a", "copy",
        variantPath,
      ],
      { cwd: pkgRoot },
    );
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
  if (result.timed_out) {
    return { ok: false, error: "ffmpeg aspect-variant crop timed out" };
  }
  if (result.exit_code !== 0 || !fs.existsSync(variantPath)) {
    return { ok: false, error: `ffmpeg exit ${result.exit_code}: ${stderrTail(result.stderr, 300) || "no stderr"}` };
  }
  // Probe the survivor for the recorded dims/size; a probe failure degrades to a
  // warning (do not throw).
  let probedWidth = target.width;
  let probedHeight = target.height;
  let durationSeconds = null;
  try {
    const probed = summarizeProbe(variantPath, probeFile(variantPath));
    if (probed.primary_video) {
      if (Number.isFinite(probed.primary_video.width)) probedWidth = probed.primary_video.width;
      if (Number.isFinite(probed.primary_video.height)) probedHeight = probed.primary_video.height;
    }
    if (Number.isFinite(probed.duration_seconds)) durationSeconds = probed.duration_seconds;
  } catch {}
  const fileSize = (() => { try { return fs.statSync(variantPath).size; } catch { return null; } })();
  return {
    ok: true,
    record: {
      aspect: target.aspect,
      canonical_platform: target.canonical,
      path: `variants/${target.slug}.mp4`,
      width: probedWidth,
      height: probedHeight,
      duration_seconds: durationSeconds,
      file_size_bytes: fileSize,
      quality: "naive_crop",
      source_aspect: sourceVideo ? sourceVideo.aspect : null,
      source_dimensions: sourceVideo ? { width: sourceVideo.width, height: sourceVideo.height } : null,
    },
  };
}

async function packageOutput(args) {
  const id = assertSafeProjectId(args && args.project_id);

  const state = readSessionStateStrict(id);

  // Opt-in aspect-variant validation FIRST — before the fan-out/segmented
  // refusals AND before the package/ wipe — so a bad arg throws
  // INVALID_ARGUMENTS while every prior package on disk is still intact
  // (refusal-before-wipe). The actual crop work runs far below, after the wipe
  // + loudnorm. Single-timeline only: the fan-out guard below still refuses a
  // shorts[] storyboard even when aspect_variants is passed.
  const aspectVariantTargets = resolveAspectVariants(args && args.aspect_variants);

  // Fan-out guard — FIRST, before any precondition check and strictly before
  // the package/ wipe: a shorts[] storyboard means the deliverables set is the
  // output; packaging only the last-rendered short would be a misleading
  // single-timeline package. The composition short_id stamp proves fan-out
  // even when storyboard.json is unreadable.
  let sbForGuard = null;
  try {
    sbForGuard = JSON.parse(fs.readFileSync(storyboardPath(id), "utf8"));
  } catch {
    sbForGuard = null;
  }
  const compositionShortId = state.composition && typeof state.composition === "object" && !Array.isArray(state.composition)
    && typeof state.composition.short_id === "string" && state.composition.short_id !== ""
    ? state.composition.short_id
    : null;
  if ((sbForGuard && storyboardHasShorts(sbForGuard)) || (sbForGuard === null && compositionShortId !== null)) {
    const shortIds = sbForGuard ? storyboardTimelines(sbForGuard).map((t) => t.short_id).filter(Boolean) : [];
    throw new ToolError(
      ERROR_CODES.STATE_CONFLICT,
      `this is a multi-short fan-out project${shortIds.length > 0 ? ` (shorts: ${shortIds.join(", ")})` : ""} — the deliverables set is the output, not a single-timeline package. Record each rendered short via vob_import_deliverable { deliverables:[{path, title, short_id}], normalize:true, set_phase:false }; deliverables/manifest.json is the package manifest.`,
      { fan_out: true, short_ids: shortIds },
    );
  }

  // Segmented-render guard — also BEFORE any wipe: packaging a segment PARTIAL
  // as the final would silently ship a fraction of the video. The package is
  // legal only once the assembled final IS the current render.
  const segmentedPlan = renderPlanOf(state);
  if (segmentedPlan) {
    const assembly = state.assembly && typeof state.assembly === "object" && !Array.isArray(state.assembly)
      ? state.assembly
      : null;
    const renderSlot = state.render && typeof state.render === "object" && !Array.isArray(state.render)
      ? state.render
      : null;
    const assembledIsCurrent = assembly && renderSlot
      && typeof assembly.final_path === "string" && assembly.final_path
      && assembly.final_path === renderSlot.mp4_path
      && fs.existsSync(assembly.final_path);
    if (!assembledIsCurrent) {
      throw new ToolError(
        ERROR_CODES.STATE_CONFLICT,
        "this is a segmented-render project and the segments have not been assembled into a final (or a segment was re-rendered since the last assembly) — render every segment, run vob_assemble_video, confirm the assembled final, then package.",
        { segmented: true, assembly_final_path: assembly ? assembly.final_path || null : null },
      );
    }
  }

  const render = state.render && typeof state.render === "object" && !Array.isArray(state.render)
    ? state.render
    : null;
  if (!render || typeof render.mp4_path !== "string" || !render.mp4_path) {
    throw new ToolError(
      ERROR_CODES.NOT_FOUND,
      "no full render recorded in state — call vob_render_full before vob_package_output",
    );
  }
  if (!fs.existsSync(render.mp4_path)) {
    throw new ToolError(
      ERROR_CODES.NOT_FOUND,
      `render file referenced by state is not on disk: ${render.mp4_path}`,
    );
  }
  if (render.confirmed !== true) {
    throw new ToolError(
      ERROR_CODES.STATE_CONFLICT,
      "full render has not been confirmed — call vob_confirm_render before vob_package_output",
    );
  }

  const dependencies = state.dependencies && typeof state.dependencies === "object" ? state.dependencies : {};
  const ffmpegInfo = dependencies.ffmpeg && typeof dependencies.ffmpeg === "object" ? dependencies.ffmpeg : null;
  if (ffmpegInfo && ffmpegInfo.ok === false) {
    // The INGEST preflight is a stale snapshot — re-check ffmpeg live before
    // blocking, so a transient flake at INGEST (an npx/launch hiccup) doesn't
    // wedge PACKAGE when ffmpeg is actually present. Only block if STILL missing.
    const live = checkFfmpegAvailable();
    if (live.ok !== true) {
      throw new ToolError(
        ERROR_CODES.INTERNAL_ERROR,
        `ffmpeg is required to package the output but is not available: ${live.error || ffmpegInfo.error || "unknown error"}. Install ffmpeg and retry.`,
      );
    }
  }

  const pkgRoot = packageDir(id);
  if (fs.existsSync(pkgRoot)) {
    fs.rmSync(pkgRoot, { recursive: true, force: true });
  }
  fs.mkdirSync(pkgRoot, { recursive: true });

  const finalMp4 = packageFinalMp4Path(id);
  const thumbnail = packageThumbnailPath(id);
  const manifestFile = packageManifestPath(id);
  const readmeFile = packageReadmePath(id);

  try {
    fs.copyFileSync(render.mp4_path, finalMp4);
  } catch (error) {
    cleanupOnFailure(pkgRoot);
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `failed to copy render into package/: ${error.message || String(error)}`,
    );
  }

  let probe;
  try {
    probe = probeFile(finalMp4);
  } catch (error) {
    cleanupOnFailure(pkgRoot);
    throw error;
  }
  const summaryPre = summarizeProbe(finalMp4, probe);

  // Loudness normalization BEFORE the thumbnail/manifest probe: the post-
  // normalization re-probe is the authoritative summary for everything below.
  const loudnorm = await normalizeLoudnessInPlace({ mp4Path: finalMp4, summaryPre });
  let summary = summaryPre;
  if (loudnorm.applied) {
    try {
      summary = summarizeProbe(finalMp4, probeFile(finalMp4));
    } catch (error) {
      cleanupOnFailure(pkgRoot);
      throw error;
    }
  }

  const durationSeconds = Number.isFinite(summary.duration_seconds) ? summary.duration_seconds : 0;
  const thumbnailMoment = resolveThumbnailMoment({ projectId: id, durationSeconds, state });
  const thumbnailAtSeconds = thumbnailMoment.seconds;

  const ffmpegResult = await runFfmpegBlocking(
    [
      "-y",
      "-ss", thumbnailAtSeconds.toFixed(3),
      "-i", finalMp4,
      "-vframes", "1",
      "-q:v", "2",
      thumbnail,
    ],
    { cwd: pkgRoot },
  );
  if (ffmpegResult.timed_out) {
    cleanupOnFailure(pkgRoot);
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      "ffmpeg thumbnail extraction timed out",
      { stderr_preview: stderrTail(ffmpegResult.stderr, 1000) },
    );
  }
  if (ffmpegResult.exit_code !== 0 || !fs.existsSync(thumbnail)) {
    cleanupOnFailure(pkgRoot);
    const stderrPreview = stderrTail(ffmpegResult.stderr, 2000);
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `ffmpeg thumbnail extraction failed (exit ${ffmpegResult.exit_code}): ${stderrPreview || "no stderr"}`,
      { exit_code: ffmpegResult.exit_code, signal: ffmpegResult.signal, stderr_preview: stderrPreview },
    );
  }

  const ingestManifestAbs = ingestManifestPath(id);
  let ingestManifest = null;
  try {
    ingestManifest = readJsonFile(ingestManifestAbs);
  } catch {
    ingestManifest = null;
  }
  const primarySource = ingestManifest && Array.isArray(ingestManifest.files) && ingestManifest.files[0]
    ? ingestManifest.files[0].path || null
    : null;

  const packagedAt = nowIso();
  const iterationVersion = state.iteration && Number.isInteger(state.iteration.current_version) && state.iteration.current_version > 0
    ? state.iteration.current_version
    : 1;

  const composition = state.composition && typeof state.composition === "object" ? state.composition : null;
  const preview = state.preview && typeof state.preview === "object" ? state.preview : null;
  const storyboard = state.storyboard && typeof state.storyboard === "object" ? state.storyboard : null;
  const hyperframesInfo = dependencies.hyperframes && typeof dependencies.hyperframes === "object" ? dependencies.hyperframes : null;

  const renderFileSize = (() => {
    try { return fs.statSync(finalMp4).size; } catch { return null; }
  })();
  const thumbnailFileSize = (() => {
    try { return fs.statSync(thumbnail).size; } catch { return null; }
  })();

  // Expected duration from the storyboard total — drives the drift field.
  let expectedDurationSeconds = null;
  try {
    const sbTotal = Number(JSON.parse(fs.readFileSync(storyboardPath(id), "utf8")).total_target_duration_seconds);
    expectedDurationSeconds = Number.isFinite(sbTotal) && sbTotal > 0 ? sbTotal : null;
  } catch {}
  const durationDriftSeconds = Number.isFinite(summary.duration_seconds) && expectedDurationSeconds !== null
    ? Math.round((summary.duration_seconds - expectedDurationSeconds) * 1000) / 1000
    : null;

  // v3 lineage: the resolved video-type preset + chapter markers from the
  // storyboard's narrative segments + the assembly record when segmented.
  const videoType = resolveActiveVideoType(state);
  const chapters = chaptersFromStoryboard(sbForGuard);
  // Post-copy metadata (title/description/hashtags/cta) from the on-disk
  // storyboard, with the chapter stamps folded in as a paste block when this is
  // a chaptered video. null when the storyboard declares no target.distribution.
  const distribution = distributionForPackage(sbForGuard, chapters);
  const assemblySlot = state.assembly && typeof state.assembly === "object" && !Array.isArray(state.assembly)
    ? state.assembly
    : null;

  // Chunk-level caption sidecars (.srt + .vtt) from the planned
  // scene.caption_segments[], timed off the storyboard scene targets (same
  // cursor + clip-in-point re-time the composer uses). Written into pkgRoot
  // (wiped/recreated every run) so they rebuild like every package file; null
  // when the storyboard declares no caption segments. sbForGuard is the parsed
  // single-timeline storyboard already in scope (fan-out refuses far above).
  // (v3.4) When INSPECT forced-aligned the transcript, the cue windows are
  // word-anchored to the same per-word times the burn-in uses (no drift).
  const inspectSlot = state.inspect && typeof state.inspect === "object" && !Array.isArray(state.inspect) ? state.inspect : null;
  const captionSidecar = buildCaptionSidecar(sbForGuard, {
    durationSeconds,
    transcriptForFileIndex: buildTranscriptResolver(state, loadTranscript(inspectSlot && inspectSlot.transcript_path)),
    transcriptAligned: inspectSlot ? inspectSlot.transcript_aligned === true : false,
  });
  const captionsSrtAbs = packageCaptionsSrtPath(id);
  const captionsVttAbs = packageCaptionsVttPath(id);
  if (captionSidecar) {
    writeFileAtomic(captionsSrtAbs, captionSidecar.srt);
    writeFileAtomic(captionsVttAbs, captionSidecar.vtt);
  }

  // Poster set: poster_0 IS the canonical thumbnail.jpg (already extracted,
  // fatal-on-failure above). poster_1..n are a curated, ordered, deduped set of
  // output-time moments (hook midpoint + chapter starts + percent stops) into
  // package/posters/poster_<k>.jpg — each extracted on a STRICTLY NON-FATAL
  // path: any failure appends to postersWarnings[] and continues; it never
  // calls cleanupOnFailure, so an optional extra poster can't sink the package.
  const posterCount = resolvePosterCount(chapters);
  const posterMoments = resolvePosterMoments({ projectId: id, durationSeconds, state, count: posterCount, chapters });
  const postersDir = packagePostersDir(id);
  const postersItems = [];
  const postersWarnings = [];
  const pctOf = (seconds) => (durationSeconds > 0
    ? Math.round((seconds / durationSeconds) * 1000) / 10
    : null);
  // poster_0 record — synthesized from the already-extracted thumbnail.jpg so
  // posters[] is a complete ordered set including the canonical still.
  postersItems.push({
    path: "thumbnail.jpg",
    index: 0,
    extracted_at_seconds: thumbnailAtSeconds,
    extracted_at_percent: pctOf(thumbnailAtSeconds),
    strategy: thumbnailMoment.strategy,
    label: null,
    file_size_bytes: thumbnailFileSize,
  });
  if (posterMoments.length > 1) {
    fs.mkdirSync(postersDir, { recursive: true });
    for (let k = 1; k < posterMoments.length; k += 1) {
      const moment = posterMoments[k];
      const posterPath = path.join(postersDir, `poster_${k}.jpg`);
      try {
        const posterResult = await runFfmpegBlocking(
          [
            "-y",
            "-ss", moment.seconds.toFixed(3),
            "-i", finalMp4,
            "-vframes", "1",
            "-q:v", "2",
            posterPath,
          ],
          { cwd: pkgRoot },
        );
        if (posterResult.timed_out) {
          postersWarnings.push({ index: k, at_seconds: moment.seconds, strategy: moment.strategy, label: moment.label || null, reason: "ffmpeg poster extraction timed out" });
          continue;
        }
        if (posterResult.exit_code !== 0 || !fs.existsSync(posterPath)) {
          postersWarnings.push({ index: k, at_seconds: moment.seconds, strategy: moment.strategy, label: moment.label || null, reason: `ffmpeg exit ${posterResult.exit_code}: ${stderrTail(posterResult.stderr, 300) || "no stderr"}` });
          continue;
        }
        const posterSize = (() => { try { return fs.statSync(posterPath).size; } catch { return null; } })();
        postersItems.push({
          path: `posters/poster_${k}.jpg`,
          index: k,
          extracted_at_seconds: moment.seconds,
          extracted_at_percent: pctOf(moment.seconds),
          strategy: moment.strategy,
          label: moment.label || null,
          file_size_bytes: posterSize,
        });
      } catch (error) {
        postersWarnings.push({ index: k, at_seconds: moment.seconds, strategy: moment.strategy, label: moment.label || null, reason: error && error.message ? error.message : String(error) });
      }
    }
  }

  // Multi-aspect dumb-crop variants (opt-in, labeled-lossy). Source = the
  // already-loudnorm'd final.mp4; each requested aspect is a pure-ffmpeg
  // scale+center-crop with `-c:a copy` (no second loudnorm pass) into
  // package/variants/<slug>.mp4. STRICTLY NON-FATAL: each variant runs in its
  // own try/catch (mirrors the poster loop) — a failure pushes a warning and
  // continues, NEVER cleanupOnFailure. A target whose geometry already equals
  // the source is recorded as `skipped` rather than re-encoded.
  const sourceVideo = summary.primary_video
    ? { width: summary.primary_video.width, height: summary.primary_video.height, aspect: aspectLabelOf(summary.primary_video.width, summary.primary_video.height) }
    : { width: null, height: null, aspect: null };
  const aspectVariantRecords = [];
  const variantWarnings = [];
  if (aspectVariantTargets.length > 0) {
    const variantsDir = packageVariantsDir(id);
    let variantsDirMade = false;
    for (const target of aspectVariantTargets) {
      if (Number.isFinite(sourceVideo.width) && Number.isFinite(sourceVideo.height)
        && target.width === sourceVideo.width && target.height === sourceVideo.height) {
        variantWarnings.push({ aspect: target.aspect, error: "skipped — target geometry equals the source (no-op crop)" });
        continue;
      }
      if (!variantsDirMade) {
        fs.mkdirSync(variantsDir, { recursive: true });
        variantsDirMade = true;
      }
      const variantPath = path.join(variantsDir, `${target.slug}.mp4`);
      try {
        const built = await buildAspectVariant({ finalMp4, variantPath, target, sourceVideo, pkgRoot });
        if (built.ok) {
          aspectVariantRecords.push(built.record);
        } else {
          variantWarnings.push({ aspect: target.aspect, error: built.error });
        }
      } catch (error) {
        variantWarnings.push({ aspect: target.aspect, error: error && error.message ? error.message : String(error) });
      }
    }
  }

  const manifest = {
    manifest_version: "1.2",
    video_vob_version: readVideoVobVersion(),
    project_id: id,
    title: id,
    iteration_version: iterationVersion,
    packaged_at: packagedAt,
    target: state.target == null ? null : state.target,
    video_type: { canonical: videoType.canonical, source: videoType.source },
    ...(chapters ? { chapters } : {}),
    ...(captionSidecar
      ? {
        captions: {
          srt_path: "captions.srt",
          vtt_path: "captions.vtt",
          segment_count: captionSidecar.segment_count,
          level: "chunk",
          source: "caption_segments",
          // (v3.4) "forced_aligned" when cues were word-anchored to the aligned
          // transcript (matches the burn-in); "storyboard_target" otherwise.
          timing_basis: captionSidecar.timing_basis || "storyboard_target",
        },
      }
      : {}),
    ...(distribution ? { distribution } : {}),
    ...(assemblySlot
      ? {
        assembly: {
          segment_count: Array.isArray(assemblySlot.segment_ids) ? assemblySlot.segment_ids.length : null,
          segment_ids: Array.isArray(assemblySlot.segment_ids) ? assemblySlot.segment_ids : [],
          concat_path: assemblySlot.concat_path || null,
          assembled_at: assemblySlot.assembled_at || null,
          music: assemblySlot.music
            ? {
              file: typeof assemblySlot.music.path === "string" ? path.basename(assemblySlot.music.path) : null,
              gain_db: Number.isFinite(assemblySlot.music.gain_db) ? assemblySlot.music.gain_db : null,
              // ducked:false = the sidechain duck failed and music was mixed flat
              // (dialogue may be masked) — surfaced so a reviewer can hear-check it.
              ducked: assemblySlot.music.ducked === true,
            }
            : null,
        },
      }
      : {}),
    ...(postersItems.length > 0
      ? {
        posters: {
          count: postersItems.length,
          dir: "posters",
          items: postersItems,
          ...(postersWarnings.length > 0 ? { warnings: postersWarnings } : {}),
        },
      }
      : {}),
    video: {
      path: "final.mp4",
      duration_seconds: Number.isFinite(summary.duration_seconds) ? summary.duration_seconds : null,
      width: summary.primary_video ? summary.primary_video.width : null,
      height: summary.primary_video ? summary.primary_video.height : null,
      file_size_bytes: renderFileSize,
      codec: summary.primary_video ? summary.primary_video.codec : null,
      frame_rate: summary.primary_video ? summary.primary_video.frame_rate : null,
      expected_duration_seconds: expectedDurationSeconds,
      duration_drift_seconds: durationDriftSeconds,
    },
    ...(aspectVariantRecords.length ? { aspect_variants: aspectVariantRecords } : {}),
    ...(variantWarnings.length ? { aspect_variant_warnings: variantWarnings } : {}),
    thumbnail: {
      path: "thumbnail.jpg",
      extracted_at_seconds: thumbnailAtSeconds,
      extracted_at_percent: durationSeconds > 0
        ? Math.round((thumbnailAtSeconds / durationSeconds) * 1000) / 10
        : null,
      strategy: thumbnailMoment.strategy,
      hook_scene_id: thumbnailMoment.hook_scene_id,
      file_size_bytes: thumbnailFileSize,
    },
    audio: {
      loudnorm_applied: loudnorm.applied,
      loudnorm_target: { i: LOUDNORM_TARGET.i, tp: LOUDNORM_TARGET.tp, lra: LOUDNORM_TARGET.lra },
      measured_input_i: loudnorm.measured_input_i,
      measured_input_tp: loudnorm.measured_input_tp,
      skipped_reason: loudnorm.skipped_reason,
    },
    source: {
      ingest_manifest_path: ingestManifestAbs ? sessionRelative(id, ingestManifestAbs) : null,
      primary_source_path: primarySource,
      file_count: ingestManifest && Number.isInteger(ingestManifest.file_count) ? ingestManifest.file_count : null,
    },
    lineage: {
      storyboard_revision: storyboard && Number.isInteger(storyboard.revision_count) ? storyboard.revision_count : null,
      composition_revision: composition && Number.isInteger(composition.revision_count) ? composition.revision_count : null,
      preview_revision: preview && Number.isInteger(preview.revision_count) ? preview.revision_count : null,
      render_revision: Number.isInteger(render.revision_count) ? render.revision_count : null,
      derived_from: state.style && state.style.derived_from ? state.style.derived_from : null,
    },
    render: {
      rendered_at: render.rendered_at || null,
      render_duration_seconds: Number.isFinite(render.render_duration_seconds) ? render.render_duration_seconds : null,
      engine: "hyperframes",
      engine_version: hyperframesInfo && hyperframesInfo.version ? hyperframesInfo.version : null,
      quality: render.quality ?? null,
    },
  };

  writeFileAtomic(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileAtomic(readmeFile, renderPackageReadme(manifest));

  return withSessionLock(id, () => {
    const stateNow = readSessionStateStrict(id);
    const next = {
      ...stateNow,
      package: {
        directory_path: sessionRelative(id, pkgRoot),
        final_mp4_path: sessionRelative(id, finalMp4),
        thumbnail_path: sessionRelative(id, thumbnail),
        manifest_path: sessionRelative(id, manifestFile),
        readme_path: sessionRelative(id, readmeFile),
        packaged_at: packagedAt,
        iteration_version: iterationVersion,
        ...(captionSidecar
          ? {
            captions_srt_path: sessionRelative(id, captionsSrtAbs),
            captions_vtt_path: sessionRelative(id, captionsVttAbs),
          }
          : {}),
        posters_dir: sessionRelative(id, postersDir),
        posters_count: postersItems.length,
        variants: aspectVariantRecords.map((v) => sessionRelative(id, path.join(pkgRoot, v.path))),
      },
      last_updated: packagedAt,
      history: [
        ...(Array.isArray(stateNow.history) ? stateNow.history : []),
        {
          kind: "package_built",
          at: packagedAt,
          iteration_version: iterationVersion,
          // base 4 (final/thumbnail/manifest/README) + extra posters (poster_0
          // IS thumbnail.jpg, already counted in the base) + the 2 caption
          // sidecars (captions.srt + captions.vtt) when emitted + each
          // surviving aspect variant.
          files: 4 + (postersItems.length - 1) + (captionSidecar ? 2 : 0) + aspectVariantRecords.length,
          posters_count: postersItems.length,
          caption_segment_count: captionSidecar ? captionSidecar.segment_count : 0,
          variant_count: aspectVariantRecords.length,
          loudnorm_applied: loudnorm.applied,
          thumbnail_strategy: thumbnailMoment.strategy,
        },
      ],
    };
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);

    return {
      directory_path: pkgRoot,
      final_mp4_path: finalMp4,
      thumbnail_path: thumbnail,
      manifest_path: manifestFile,
      readme_path: readmeFile,
      packaged_at: packagedAt,
      iteration_version: iterationVersion,
      posters_dir: postersDir,
      posters_count: postersItems.length,
      variants: aspectVariantRecords.map((v) => path.join(pkgRoot, v.path)),
    };
  });
}

module.exports = Object.freeze({
  name: "vob_package_output",
  description: "Assemble package/: copy the confirmed render to final.mp4, two-pass loudness-normalize the audio to −14 LUFS/−1 dBTP (audio-only re-encode, video stream copied; VOB_NO_LOUDNORM=1 skips), extract the thumbnail at the storyboard hook-scene midpoint (fallback: 10%) plus a poster set (poster_0 == thumbnail.jpg; poster_1..n at chapter starts/percent stops into package/posters/, best-effort and non-fatal; count from VOB_POSTER_COUNT), write manifest.json (v1.2) + README.md. Wipes package/ first. Requires render.confirmed:true. SINGLE-TIMELINE ONLY: refuses (STATE_CONFLICT) on a multi-short fan-out storyboard — there the deliverables set recorded via vob_import_deliverable {normalize:true} is the output and deliverables/manifest.json is the package manifest. Also emits a distribution block (title/description/hashtags/cta + chapters paste-block) when the storyboard declares target.distribution, plus chunk-level caption sidecars (captions.srt + captions.vtt, timed off the storyboard scene targets) when the storyboard plans scene.caption_segments. Optional aspect_variants (e.g. [\"1:1\",\"16:9\"]) produces labeled-lossy center-crop MP4s under package/variants/ (quality:\"naive_crop\", audio copied — never a faithful reframe); single-timeline only.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
      aspect_variants: { type: "array", items: { type: "string" } },
    },
    required: ["project_id"],
  },
  handler: packageOutput,
  role_bundles: ["orchestrator"],
  mutating: true,
  global_preapproval: false,
  network_access: false,
  browser_access: false,
  scope_required: false,
  sensitive_output: false,
  session_artifacts_written: ["package/final.mp4", "package/thumbnail.jpg", "package/posters/", "package/variants/", "package/captions.srt", "package/captions.vtt", "package/manifest.json", "package/README.md", "state.json"],
  hook_required: false,
});
