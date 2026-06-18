"use strict";

const fs = require("fs");
const { PHASE_VALUES, LEGACY_PHASE_ALIASES } = require("./constants.js");
const { ERROR_CODES, ToolError } = require("./envelope.js");
const { sessionDir, statePath, assertSafeProjectId, inspectSummaryPath, storyboardPath, transcodedClipsDir } = require("./paths.js");
const { withSessionLock, writeFileAtomic, readJsonFile } = require("./storage.js");
const { getGate } = require("./phase-gates.js");
const { archiveForIteration, currentIterationVersion, isArchivalTransition } = require("./archival.js");
const { missingIntentKeys } = require("./intent-schema.js");
const { materializeSceneClips } = require("./clip-materialize.js");
const { materializeSubjectMattes } = require("./matte-materialize.js");
const { materializeSceneLayouts } = require("./layout-materialize.js");
const { summarizeActiveVideoType } = require("./video-types.js");
const hostProfile = require("./host-profile.js");
const { deriveRenderPlan, validSegmentRenders } = require("./render-segments.js");

// INTENT -> PLAN -> COMPOSE: the former BRIEF and STORYBOARD phases are merged
// into a single PLAN phase (one human gate that presents intent summary +
// A-roll order + chosen takes + B-roll placements together). Back-edges that
// used to target STORYBOARD now target PLAN. PLAN -> INGEST (v3) is the b-roll
// gap-resolution back-edge: the user drops MORE footage, INGEST/INSPECT re-run
// (content-hash caches make old files cheap), and PLAN re-derives with the
// extended B-roll index — the sanctioned path for plan/broll_gaps.json.
const ALLOWED_TRANSITIONS = Object.freeze({
  INGEST:   ["INSPECT"],
  INSPECT:  ["INTENT"],
  INTENT:   ["PLAN"],
  PLAN:     ["COMPOSE", "INTENT", "INGEST"],
  COMPOSE:  ["PREVIEW", "PLAN"],
  PREVIEW:  ["RENDER", "COMPOSE", "PLAN"],
  RENDER:   ["PACKAGE", "COMPOSE", "PLAN"],
  PACKAGE:  ["ITERATE", "COMPOSE", "PLAN"],
  ITERATE:  ["COMPOSE", "PLAN"],
});

function nowIso() {
  return new Date().toISOString();
}

function buildInitialSessionState({ project_id, target, derived_from }) {
  const id = assertSafeProjectId(project_id);
  const ts = nowIso();
  const state = {
    project_id: id,
    target: target == null ? null : target,
    phase: "INGEST",
    created_at: ts,
    last_updated: ts,
    history: [],
  };
  // Optional style lineage: when a project is started "--like" a prior one
  // (vob_init_project { derived_from }), stamp the source project_id so the
  // orchestrator can inherit its design — the source's intent answers, brief
  // tone, and composition look. Advisory only: no gate reads it, and it rides
  // through every transition because all state writes spread ...state. Omitted
  // entirely when not deriving, to keep a baseline state.json lean.
  if (derived_from != null) {
    state.style = { derived_from, applied_at: ts };
  }
  return state;
}

function initProject(args) {
  const id = assertSafeProjectId(args && args.project_id);
  const target = args && args.target != null ? args.target : null;
  if (target !== null && (typeof target !== "object" || Array.isArray(target))) {
    throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, "target must be an object if provided");
  }

  // Optional "--like <project>" style inheritance. Validate the source project
  // BEFORE creating the new one, so we never leave a new project pointing at a
  // source that doesn't exist. We only check the source's state.json existence
  // (a read); we never take the source's session lock.
  const derivedFrom = args && args.derived_from != null ? String(args.derived_from).trim() : null;
  if (derivedFrom) {
    const sourceId = assertSafeProjectId(derivedFrom);
    if (!fs.existsSync(statePath(sourceId))) {
      throw new ToolError(
        ERROR_CODES.NOT_FOUND,
        `cannot derive from '${sourceId}': no such project (state.json not found). Use an existing project_id to inherit its style.`,
      );
    }
  }

  return withSessionLock(id, () => {
    const dir = sessionDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const file = statePath(id);
    if (fs.existsSync(file)) {
      throw new ToolError(
        ERROR_CODES.STATE_CONFLICT,
        `state.json already exists for project ${id} (already initialized)`,
      );
    }
    const state = buildInitialSessionState({ project_id: id, target, derived_from: derivedFrom });
    writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
    return {
      created: true,
      project_id: id,
      session_dir: dir,
      phase: state.phase,
      style: state.style ? { derived_from: state.style.derived_from } : null,
    };
  });
}

function readSessionStateStrict(projectId) {
  const id = assertSafeProjectId(projectId);
  const file = statePath(id);
  if (!fs.existsSync(file)) {
    throw new ToolError(ERROR_CODES.NOT_FOUND, `state.json not found for project ${id}`);
  }
  let parsed;
  try {
    parsed = readJsonFile(file);
  } catch (error) {
    throw new ToolError(ERROR_CODES.INTERNAL_ERROR, `malformed state.json for ${id}: ${error.message || error}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ToolError(ERROR_CODES.INTERNAL_ERROR, `malformed state.json for ${id}: expected object`);
  }
  // Normalize legacy phase names (BRIEF/STORYBOARD -> PLAN) from sessions
  // created before the PLAN-gate merge. Read-time only; the next mutating tool
  // persists the normalized phase. Done before the validity check so an old
  // session never trips the "invalid phase" guard.
  if (Object.prototype.hasOwnProperty.call(LEGACY_PHASE_ALIASES, parsed.phase)) {
    parsed.phase = LEGACY_PHASE_ALIASES[parsed.phase];
  }
  if (!PHASE_VALUES.includes(parsed.phase)) {
    throw new ToolError(ERROR_CODES.INTERNAL_ERROR, `state.json for ${id} has invalid phase: ${parsed.phase}`);
  }
  return parsed;
}

// ---- read-time projections (disk untouched; every digest tolerates a legacy
// document: non-object slot -> null, missing inner field -> typed default) ----

function asSlot(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function strOrNull(value) {
  return typeof value === "string" && value ? value : null;
}

function intOr(value, fallback) {
  return Number.isInteger(value) ? value : fallback;
}

function numOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function arrOr(value) {
  return Array.isArray(value) ? value : [];
}

function readInspectSummaryIfPresent(projectId) {
  const file = inspectSummaryPath(projectId);
  if (!fs.existsSync(file)) return null;
  try {
    return readJsonFile(file);
  } catch {
    return null;
  }
}

// Count digest of the transcoded_clips materialization document. The full
// document (per-clip detail) persists in state.transcoded_clips on disk.
function clipsDigest(projectId, transcodedClips) {
  const s = transcodedClips && transcodedClips.summary ? transcodedClips.summary : {};
  return {
    clip_count: (Number(s.cut) || 0) + (Number(s.cached) || 0),
    cached_count: Number(s.cached) || 0,
    scene_count: Number(s.total) || 0,
    skipped_scene_count: Number(s.skipped) || 0,
    audio_treatment: transcodedClips.audio_treatment || null,
    clips_dir: transcodedClipsDir(projectId),
  };
}

// Lean digest of the subject-matte materialization (v3.3 subject compositing).
// The full per-matte document persists in state.subject_mattes on disk; the
// orchestrator reads this to know whether mattes are ready / over budget / on a
// host without the backend, and falls back the composer accordingly.
function summarizeSubjectMattes(slot) {
  const m = asSlot(slot);
  if (!m) return null;
  const s = asSlot(m.summary) || {};
  return {
    count: Number(s.total) || 0,
    matted: Number(s.matted) || 0,
    cached: Number(s.cached) || 0,
    failed: Number(s.failed) || 0,
    skipped: Number(s.skipped) || 0,
    unavailable: Number(s.unavailable) || 0,
    over_budget: m.over_budget === true,
    backend_available: typeof m.backend_available === "boolean" ? m.backend_available : null,
  };
}

// Lean digest of the multi-cell layout materialization (v3.4 split-screen). The
// orchestrator reads this to tell the composer which layout scenes have a
// composited clip ready (reference ./source/<scene_id>-layout.mp4) vs which
// degraded (fall back to CSS-positioned cells).
function summarizeSceneLayouts(slot) {
  const m = asSlot(slot);
  if (!m) return null;
  const s = asSlot(m.summary) || {};
  const composited = [];
  const fell_back = [];
  for (const l of (Array.isArray(m.layouts) ? m.layouts : [])) {
    if (!asSlot(l) || typeof l.scene_id !== "string") continue;
    if (l.status === "composited" || l.status === "cached") composited.push(l.scene_id);
    else fell_back.push(l.scene_id);
  }
  return {
    count: Number(s.total) || 0,
    composited: Number(s.composited) || 0,
    cached: Number(s.cached) || 0,
    skipped: Number(s.skipped) || 0,
    failed: Number(s.failed) || 0,
    composited_scenes: composited,
    fell_back_scenes: fell_back,
  };
}

// One entry per dependency preflight with ok === false. The full preflight
// blobs stay on disk for the renderToPackage gate and vob_doctor.
function dependencyFailuresDigest(dependencies) {
  const deps = asSlot(dependencies);
  if (!deps) return [];
  return Object.entries(deps)
    .filter(([, info]) => info && typeof info === "object" && info.ok === false)
    .map(([name, info]) => ({ name, error: typeof info.error === "string" ? info.error : null }));
}

function summarizeManifest(slot) {
  const m = asSlot(slot);
  if (!m) return null;
  return {
    path: strOrNull(m.path),
    source_path: strOrNull(m.source_path),
    file_count: intOr(m.file_count, 0),
    video_stream_count: intOr(m.video_stream_count, 0),
    total_duration_seconds: numOr(m.total_duration_seconds, null),
  };
}

function summarizeClassification(slot) {
  const c = asSlot(slot);
  if (!c) return null;
  return {
    aroll_count: intOr(c.aroll_count, 0),
    broll_count: intOr(c.broll_count, 0),
    review_count: intOr(c.review_count, 0),
    take_group_count: intOr(c.take_group_count, 0),
    best_take_count: intOr(c.best_take_count, 0),
    aroll_pool_path: strOrNull(c.aroll_pool_path),
    broll_index_path: strOrNull(c.broll_index_path),
    review_pool_path: strOrNull(c.review_pool_path != null ? c.review_pool_path : c.review_path),
    visual_coverage: asSlot(c.visual_coverage),
    hook_tagged_count: intOr(c.hook_tagged_count, null),
    // v3.2 P3 richer-tagging coverage notes + the multi-file role map.
    content_tagged_count: intOr(c.content_tagged_count, 0),
    on_screen_text_count: intOr(c.on_screen_text_count, 0),
    file_role_count: intOr(c.file_role_count, 0),
    file_roles: arrOr(c.file_roles),
  };
}

function summarizeInspect(slot) {
  const i = asSlot(slot);
  if (!i) return null;
  return {
    summary_path: strOrNull(i.summary_path),
    thumbs_dir: strOrNull(i.thumbs_dir),
    thumb_count: intOr(i.thumb_count, 0),
    thumb_failed_count: intOr(i.thumb_failed_count, 0),
    warnings: arrOr(i.warnings),
    thumb_interval_seconds: numOr(i.thumb_interval_seconds, 0),
    sample_thumb_paths: arrOr(i.sample_thumb_paths),
    contact_sheet_paths: arrOr(i.contact_sheet_paths),
    audio_present: i.audio_present === true,
    speech_detected: i.speech_detected === true,
    // v3.2 P1/P2 — karaoke-grade word timing marker + the audio-analysis summary.
    transcript_aligned: i.transcript_aligned === true,
    audio: asSlot(i.audio),
    audio_analysis_path: strOrNull(i.audio_analysis_path),
    word_count: intOr(i.word_count, 0),
    paragraph_count: intOr(i.paragraph_count, 0),
    transcript_path: strOrNull(i.transcript_path),
    transcript_summary_path: strOrNull(i.transcript_summary_path),
    transcript_paragraphs_path: strOrNull(i.transcript_paragraphs_path),
    segments_path: strOrNull(i.segments_path),
    segment_count: intOr(i.segment_count, 0),
    clean_speech_path: strOrNull(i.clean_speech_path),
    digest_path: strOrNull(i.digest_path),
    strips_legend_path: strOrNull(i.strips_legend_path),
    strip_count: intOr(i.strip_count, 0),
    transcripts: arrOr(i.transcripts),
    hook_candidate_count: intOr(i.hook_candidate_count, 0),
    // v3.9 — per-segment take-quality aggregate (full per-segment `strength` lives
    // in segments.json; here it's counts + the strongest takes, trimmed lean).
    take_quality: summarizeTakeQuality(i.take_quality),
    classification: summarizeClassification(i.classification),
    user_acknowledged: i.user_acknowledged === true,
    skipped_reason: strOrNull(i.skipped_reason),
  };
}

function summarizeTakeQuality(slot) {
  const t = asSlot(slot);
  if (!t) return null;
  return {
    scored_segments: intOr(t.scored_segments, 0),
    strong: intOr(t.strong, 0),
    usable: intOr(t.usable, 0),
    weak: intOr(t.weak, 0),
    median_score: numOr(t.median_score, null),
    visual_backend: strOrNull(t.visual_backend),
    strongest: arrOr(t.strongest).slice(0, 5),
  };
}

// Intent answers ride through verbatim with TWO projections: object-shaped
// (canonicalized) target_platform / video_type lose their stored snapshot
// blobs — {raw, canonical} is what the orchestrator displays; the summary's
// `platform` / `video_type` fields carry the resolved geometry/preset.
function summarizeIntentAnswers(answers) {
  const a = asSlot(answers);
  if (!a) return {};
  const out = { ...a };
  const platform = asSlot(a.target_platform);
  if (platform && typeof platform.raw === "string") {
    out.target_platform = { raw: platform.raw, canonical: strOrNull(platform.canonical) };
  }
  const videoType = asSlot(a.video_type);
  if (videoType && typeof videoType.raw === "string") {
    out.video_type = { raw: videoType.raw, canonical: strOrNull(videoType.canonical) };
  }
  return out;
}

function summarizePlatform(answers) {
  const a = asSlot(answers);
  const platform = a ? asSlot(a.target_platform) : null;
  const profile = platform ? asSlot(platform.profile) : null;
  if (!profile) return null;
  return {
    canonical: strOrNull(platform.canonical),
    width: intOr(profile.width, 0),
    height: intOr(profile.height, 0),
    fps: intOr(profile.fps, 0),
    safe_top_px: intOr(profile.safe_top_px, 0),
    safe_bottom_px: intOr(profile.safe_bottom_px, 0),
    ideal_duration_s: asSlot(profile.ideal_duration_s),
    max_duration_s: numOr(profile.max_duration_s, null),
    caption_defaults: asSlot(profile.caption_defaults),
  };
}

function summarizeTargetDurationSeconds(answers) {
  const a = asSlot(answers);
  const duration = a ? asSlot(a.target_duration) : null;
  return duration && Number.isFinite(duration.seconds) ? duration.seconds : null;
}

// Range/per-deliverable form of the target duration: "20-35s per short" ->
// {min,max,per_deliverable:true}; "30s each" (no range) still surfaces
// {per_deliverable:true} with null bounds — the adapters' fan-out trigger keys
// on this field, so the flag must survive rangeless qualifiers. null for plain
// durations and legacy sessions.
function summarizeTargetDurationRange(answers) {
  const a = asSlot(answers);
  const duration = a ? asSlot(a.target_duration) : null;
  if (!duration) return null;
  const range = asSlot(duration.range);
  const hasRange = range && Number.isFinite(range.min_seconds) && Number.isFinite(range.max_seconds);
  const perDeliverable = duration.per_deliverable === true;
  if (!hasRange && !perDeliverable) return null;
  return {
    min_seconds: hasRange ? range.min_seconds : null,
    max_seconds: hasRange ? range.max_seconds : null,
    per_deliverable: perDeliverable,
  };
}

// Lean deliverables digest: enough for the orchestrator to compute the
// remaining fan-out shorts on resume (full records live in state.deliverables
// and deliverables/manifest.json).
function summarizeDeliverables(deliverables) {
  const list = arrOr(deliverables);
  if (list.length === 0) return [];
  return list.map((d) => {
    const x = asSlot(d) || {};
    return {
      id: strOrNull(x.id),
      short_id: strOrNull(x.short_id),
      title: strOrNull(x.title),
      origin: strOrNull(x.origin),
    };
  });
}

function summarizeBrief(slot) {
  const b = asSlot(slot);
  if (!b) return null;
  return {
    path: strOrNull(b.path),
    saved_at: strOrNull(b.saved_at),
    confirmed: b.confirmed === true,
    confirmed_at: strOrNull(b.confirmed_at),
  };
}

function summarizeStoryboard(slot) {
  const s = asSlot(slot);
  if (!s) return null;
  const planLint = asSlot(s.plan_lint);
  return {
    artifact_path: strOrNull(s.artifact_path),
    markdown_path: strOrNull(s.markdown_path),
    saved_at: strOrNull(s.saved_at),
    confirmed: s.confirmed === true,
    confirmed_at: strOrNull(s.confirmed_at),
    revision_count: intOr(s.revision_count, 0),
    scene_count: intOr(s.scene_count, null),
    total_duration_seconds: numOr(s.total_duration_seconds, null),
    // Fan-out (shorts[] storyboards): the per-short digest the orchestrator
    // needs to drive the active-short loop on resume.
    ...(Number.isInteger(s.short_count) && s.short_count > 0
      ? {
        short_count: s.short_count,
        shorts: arrOr(s.shorts).map((sh) => {
          const x = asSlot(sh) || {};
          return {
            short_id: strOrNull(x.short_id),
            title: strOrNull(x.title),
            total_target_duration_seconds: numOr(x.total_target_duration_seconds, null),
            scene_count: intOr(x.scene_count, null),
          };
        }),
      }
      : {}),
    // B-roll gap shopping list (v3): >0 means the plan wants coverage the
    // ingested footage can't supply — surface the list at the plan gate.
    broll_gap_count: intOr(s.broll_gap_count, 0),
    ...(intOr(s.broll_gap_count, 0) > 0 && strOrNull(s.broll_gaps_path)
      ? { broll_gaps_path: s.broll_gaps_path }
      : {}),
    plan_lint: planLint
      ? { error_count: intOr(planLint.error_count, 0), warning_count: intOr(planLint.warning_count, 0) }
      : null,
  };
}

function summarizeComposition(slot) {
  const c = asSlot(slot);
  if (!c) return null;
  return {
    files: arrOr(c.files),
    saved_at: strOrNull(c.saved_at),
    lint_status: strOrNull(c.lint_status),
    lint_report_path: strOrNull(c.lint_report_path),
    lint_ran_at: strOrNull(c.lint_ran_at),
    revision_count: intOr(c.revision_count, 0),
    // Fan-out: which short the current composition implements.
    short_id: strOrNull(c.short_id),
    // Segmented render: which render segment it implements.
    segment_id: strOrNull(c.segment_id),
  };
}

// Segmented-render plan digest: per-segment rendered/confirmed/stale flags so
// the orchestrator computes the active segment on resume without re-deriving.
function summarizeRenderPlan(state) {
  const plan = asSlot(state.render_plan);
  if (!plan || plan.mode !== "segmented") return null;
  const { byId, missing, stale, unconfirmed } = validSegmentRenders(state);
  // A fresh partial that exists but hasn't been confirmed is excluded from byId,
  // so the digest must distinguish it (rendered, just needs confirm) from a truly
  // stale/missing one — else resume-after-render-before-confirm would tell the
  // orchestrator to re-render a segment that only needs confirmation.
  const staleSet = new Set(Array.isArray(stale) ? stale : []);
  const unconfirmedSet = new Set(Array.isArray(unconfirmed) ? unconfirmed : []);
  return {
    mode: "segmented",
    segmentation: strOrNull(plan.segmentation),
    video_budget: intOr(plan.video_budget, null),
    segment_count: arrOr(plan.segments).length,
    segments: arrOr(plan.segments).map((s) => {
      const seg = asSlot(s) || {};
      const sid = typeof seg.segment_id === "string" ? seg.segment_id : null;
      const valid = sid ? byId.get(sid) || null : null;
      const isUnconfirmed = sid !== null && unconfirmedSet.has(sid);
      return {
        segment_id: strOrNull(seg.segment_id),
        title: strOrNull(seg.title),
        scene_count: arrOr(seg.scene_ids).length,
        target_duration_seconds: numOr(seg.target_duration_seconds, null),
        video_count: intOr(seg.video_count, null),
        transition_out: strOrNull(seg.transition_out) || "cut",
        // rendered = a FRESH partial exists (confirmed or merely unconfirmed);
        // confirmed = it passed the per-segment confirm; stale = ONLY the real
        // revision/scene-mismatch set (a merely-unconfirmed partial is NOT stale).
        rendered: Boolean(valid) || isUnconfirmed,
        confirmed: Boolean(valid),
        unconfirmed: isUnconfirmed,
        stale: sid !== null && staleSet.has(sid),
      };
    }),
    missing_segment_ids: missing,
  };
}

function summarizeAssembly(state) {
  const a = asSlot(state.assembly);
  if (!a) return null;
  const render = asSlot(state.render);
  return {
    final_path: strOrNull(a.final_path),
    assembled_at: strOrNull(a.assembled_at),
    segment_count: arrOr(a.segment_ids).length,
    // The RENDER->PACKAGE gate requires the assembled final to BE the current
    // render — false here means a segment was re-rendered since assembly.
    is_current_render: Boolean(render && strOrNull(render.mp4_path) && a.final_path === render.mp4_path),
    verification: asSlot(a.verification),
  };
}

function summarizePreview(slot) {
  const p = asSlot(slot);
  if (!p) return null;
  return {
    render_path: strOrNull(p.render_path),
    rendered_at: strOrNull(p.rendered_at),
    render_duration_seconds: numOr(p.render_duration_seconds, 0),
    confirmed: p.confirmed === true,
    confirmed_at: strOrNull(p.confirmed_at),
    revision_count: intOr(p.revision_count, 0),
    composition_revision_rendered: intOr(p.composition_revision_rendered, null),
    // WHICH short/segment this singleton slot belongs to (the per-short/-segment
    // cycle overwrites it) — so resume mid-fan-out can't read a confirmed preview
    // for short A while the active composition is short B.
    short_id: strOrNull(p.short_id),
    segment_id: strOrNull(p.segment_id),
  };
}

function summarizeRender(slot) {
  const r = asSlot(slot);
  if (!r) return null;
  return {
    mp4_path: strOrNull(r.mp4_path),
    rendered_at: strOrNull(r.rendered_at),
    render_duration_seconds: numOr(r.render_duration_seconds, 0),
    file_size_bytes: intOr(r.file_size_bytes, null),
    stderr_log_path: strOrNull(r.stderr_log_path),
    confirmed: r.confirmed === true,
    confirmed_at: strOrNull(r.confirmed_at),
    revision_count: intOr(r.revision_count, 0),
    composition_revision_rendered: intOr(r.composition_revision_rendered, null),
    short_id: strOrNull(r.short_id),
    segment_id: strOrNull(r.segment_id),
  };
}

function summarizePackage(slot) {
  const p = asSlot(slot);
  if (!p) return null;
  return {
    directory_path: strOrNull(p.directory_path),
    final_mp4_path: strOrNull(p.final_mp4_path),
    thumbnail_path: strOrNull(p.thumbnail_path),
    manifest_path: strOrNull(p.manifest_path),
    readme_path: strOrNull(p.readme_path),
    packaged_at: strOrNull(p.packaged_at),
    iteration_version: intOr(p.iteration_version, 0),
    captions_srt_path: strOrNull(p.captions_srt_path),
    captions_vtt_path: strOrNull(p.captions_vtt_path),
    posters_dir: strOrNull(p.posters_dir),
    posters_count: intOr(p.posters_count, 0),
    variants: arrOr(p.variants).filter((v) => typeof v === "string"),
  };
}

// The orchestrator's working view (D1): a per-slot digest (~1 KB) covering
// every routine phase decision without a full state read.
function buildStateSummary(state, projectId) {
  const iteration = asSlot(state.iteration);
  const intentSlot = asSlot(state.intent);
  const answers = intentSlot ? intentSlot.answers : null;
  const transcoded = asSlot(state.transcoded_clips);
  const style = asSlot(state.style);
  return {
    project_id: state.project_id,
    phase: state.phase,
    target: state.target == null ? null : state.target,
    last_updated: state.last_updated,
    iteration_version: currentIterationVersion(state),
    archived_version_count: iteration ? arrOr(iteration.archive).length : 0,
    finalized_version: iteration ? intOr(iteration.finalized_version, null) : null,
    style: style && style.derived_from != null ? { derived_from: style.derived_from } : null,
    external_import: state.external_import === true,
    deliverable_count: arrOr(state.deliverables).length,
    deliverables: summarizeDeliverables(state.deliverables),
    history_count: arrOr(state.history).length,
    dependency_failures: dependencyFailuresDigest(state.dependencies),
    manifest: summarizeManifest(state.manifest),
    inspect: summarizeInspect(state.inspect),
    intent: intentSlot
      ? {
          answers: summarizeIntentAnswers(answers),
          missing_required_keys: missingIntentKeys(asSlot(answers) || {}, readInspectSummaryIfPresent(projectId)),
        }
      : null,
    platform: summarizePlatform(answers),
    // Resolved video-type preset (env > intent > derived > default) — the
    // orchestrator reads this instead of re-deriving; `source` says which
    // precedence level won.
    // ...+ shader_transitions_allowed: the host-capability gate for shader scene
    // transitions, surfaced here so the composer spawn carries it (v3.3 §7.8).
    video_type: { ...summarizeActiveVideoType(state), shader_transitions_allowed: hostProfile.shaderTransitionsAllowed() },
    target_duration_seconds: summarizeTargetDurationSeconds(answers),
    target_duration_range: summarizeTargetDurationRange(answers),
    brief: summarizeBrief(state.brief),
    storyboard: summarizeStoryboard(state.storyboard),
    clips: transcoded
      ? { generated_at: strOrNull(transcoded.generated_at), ...clipsDigest(projectId, transcoded) }
      : null,
    subject_mattes: summarizeSubjectMattes(state.subject_mattes),
    scene_layouts: summarizeSceneLayouts(state.scene_layouts),
    composition: summarizeComposition(state.composition),
    render_plan: summarizeRenderPlan(state),
    assembly: summarizeAssembly(state),
    preview: summarizePreview(state.preview),
    render: summarizeRender(state.render),
    package: summarizePackage(state.package),
  };
}

// Default projection drops the heavy sections (history, per-clip detail, full
// dependency blobs); `include` opts back in. Read-time only — disk untouched.
function readState(args) {
  const id = assertSafeProjectId(args && args.project_id);
  const state = readSessionStateStrict(id);
  const include = new Set(Array.isArray(args && args.include) ? args.include : []);
  const out = { ...state };
  if (!include.has("history")) {
    delete out.history;
    out.history_count = Array.isArray(state.history) ? state.history.length : 0;
    out.last_history_event = Array.isArray(state.history) && state.history.length
      ? { kind: state.history[state.history.length - 1].kind, at: state.history[state.history.length - 1].at }
      : null;
  }
  if (!include.has("clips") && out.transcoded_clips && typeof out.transcoded_clips === "object") {
    out.transcoded_clips = clipsDigest(id, state.transcoded_clips);
  }
  if (!include.has("dependencies") && out.dependencies && typeof out.dependencies === "object") {
    out.dependencies = dependencyFailuresDigest(state.dependencies);
  }
  return out;
}

function readStateSummary(args) {
  const id = assertSafeProjectId(args && args.project_id);
  return buildStateSummary(readSessionStateStrict(id), id);
}

function readAudioTreatment(state) {
  const intent = state && state.intent;
  const answers = intent && typeof intent === "object" && !Array.isArray(intent) ? intent.answers : null;
  const value = answers && typeof answers === "object" ? answers.audio_treatment : null;
  return typeof value === "string" && value.trim() ? value : "keep_audio";
}

async function transitionPhase(args) {
  const id = assertSafeProjectId(args && args.project_id);
  const toPhase = args && args.to_phase;
  const overrideReason = args && args.override_reason != null ? String(args.override_reason) : null;

  if (!PHASE_VALUES.includes(toPhase)) {
    throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, `unknown to_phase: ${toPhase}`);
  }

  // Hold the lock across validation, scene-clip materialization (when entering
  // COMPOSE), and the state commit. The session lock is exclusive and uncontended
  // during phase transitions — the orchestrator drives one transition at a time —
  // so blocking on ffmpeg work inside the lock is the simplest way to keep the
  // transition atomic. withSessionLock is async-aware: the lock is held until
  // the returned promise settles.
  return withSessionLock(id, async () => {
    const state = readSessionStateStrict(id);
    const from = state.phase;
    const allowed = ALLOWED_TRANSITIONS[from] || [];
    if (!allowed.includes(toPhase)) {
      throw new ToolError(
        ERROR_CODES.STATE_CONFLICT,
        `invalid phase transition ${from} -> ${toPhase}. allowed from ${from}: ${allowed.join(", ") || "(none)"}`,
      );
    }
    const gate = getGate(from, toPhase);
    if (!gate) {
      throw new ToolError(ERROR_CODES.INTERNAL_ERROR, `no gate registered for ${from} -> ${toPhase}`);
    }
    const verdict = gate(state) || {};
    const blockers = Array.isArray(verdict.blockers) ? verdict.blockers : [];
    if (verdict.allowed === false) {
      // Non-overridable blockers (human sign-off gates) refuse the transition
      // even WITH a reason, and even when overridable blockers coexist. The
      // throw precedes the state write, so a refused attempt leaves no trace
      // in history.
      const nonOverridable = blockers.filter((b) => b && b.overridable === false);
      if (nonOverridable.length > 0) {
        const codes = nonOverridable.map((b) => b.code).join(", ");
        throw new ToolError(
          ERROR_CODES.STATE_CONFLICT,
          `gate blocked ${from} -> ${toPhase}: ${codes} cannot be bypassed with override_reason — ${nonOverridable.map((b) => b.message).join("; ")}`,
          { blockers, non_overridable: nonOverridable.map((b) => b.code), refused_override_reason: overrideReason },
        );
      }
      if (!overrideReason) {
        throw new ToolError(
          ERROR_CODES.STATE_CONFLICT,
          `gate blocked ${from} -> ${toPhase}: ${blockers.map((b) => b.message || b.code || String(b)).join("; ") || "no detail"}`,
          { blockers },
        );
      }
    }

    // Pre-cut every storyboard scene to its own H.264 clip when entering COMPOSE
    // (forward edge from PLAN, or any back-edge from a downstream phase).
    // Sidecar caching makes back-edge re-entry a no-op when the storyboard hasn't
    // changed. Cutting before the state write means the user is never advanced
    // into COMPOSE with a half-prepared compose/source/ tree.
    let transcodedClips = null;
    let subjectMattes = null;
    let sceneLayouts = null;
    let renderPlan = null;
    if (toPhase === "COMPOSE") {
      transcodedClips = await materializeSceneClips({
        projectId: id,
        audioTreatment: readAudioTreatment(state),
      });
      // Read the storyboard ONCE for the subject-matte + render-plan steps.
      let sbDoc = null;
      try {
        sbDoc = readJsonFile(storyboardPath(id));
      } catch {
        sbDoc = null;
      }
      // Matte every render_mode:"subject" placement (alpha .webm per subject
      // clip) right AFTER the scene clips — the matte INPUT is the already-pre-cut
      // clip — and BEFORE the render plan. Content-hash cached, so a back-edge
      // COMPOSE re-entry is a no-op; DEGRADES (never throws) on a matte failure so
      // a missing/uncached model can't strand the user mid-COMPOSE.
      subjectMattes = await materializeSubjectMattes({ projectId: id, storyboard: sbDoc });
      // Composite every scene.layout (split-screen / multi-crop) into ONE clip per
      // scene — its inputs are the already-pre-cut cell clips, so this runs AFTER
      // materializeSceneClips. Content-hash cached (back-edge re-entry is a no-op)
      // and DEGRADES (never throws) on a malformed/failed composite so a layout
      // can't strand COMPOSE — the composer then falls back to CSS-positioned cells.
      sceneLayouts = await materializeSceneLayouts({ projectId: id, storyboard: sbDoc });
      // Derive the render plan (v3 segmented render) from the storyboard on
      // disk + the active preset. Recomputed on EVERY COMPOSE entry: same
      // storyboard + same budget => same plan; a changed storyboard re-chunks
      // and the registry's revision binding invalidates stale partials. A layout
      // scene whose composite DEGRADED this entry is budgeted at its fallback
      // cell count (the composer will render N <video> cells, not 1 composite).
      const fellBackLayoutScenes = new Set(
        (sceneLayouts && Array.isArray(sceneLayouts.layouts) ? sceneLayouts.layouts : [])
          .filter((l) => l && typeof l.scene_id === "string" && l.status !== "composited" && l.status !== "cached")
          .map((l) => l.scene_id),
      );
      renderPlan = deriveRenderPlan({ storyboard: sbDoc, state, fellBackLayoutScenes });
    }

    const ts = nowIso();
    // Versioned archival on back-edges out of {RENDER, PACKAGE, ITERATE} into
    // {COMPOSE, PLAN}. The user never loses prior iterations: the
    // current renders/ and package/ are moved into archive/v<N>/ before the
    // transition state is committed. Archival is a no-op (returns null) if
    // there's nothing to move.
    let archive = null;
    if (isArchivalTransition(from, toPhase)) {
      archive = archiveForIteration(state, { from, to: toPhase });
    }

    let next = {
      ...state,
      phase: toPhase,
      last_updated: ts,
    };
    if (archive) {
      next = archive.apply(next);
    }
    if (transcodedClips) {
      next.transcoded_clips = transcodedClips;
    }
    if (toPhase === "COMPOSE") {
      // Stamp the matte materialization only when this entry actually mattes
      // something; with no subject placements, DROP any stale slot from a prior
      // COMPOSE entry (the matte set is recomputed fresh on every COMPOSE entry,
      // and a non-COMPOSE transition never reaches here, so the COMPOSE value
      // persists across the cycle).
      if (subjectMattes && subjectMattes.summary && subjectMattes.summary.total > 0) {
        next.subject_mattes = subjectMattes;
      } else {
        delete next.subject_mattes;
      }
      // Same discipline for multi-cell layouts: stamp only when this entry
      // composited something; otherwise DROP any stale slot from a prior entry.
      if (sceneLayouts && sceneLayouts.summary && sceneLayouts.summary.total > 0) {
        next.scene_layouts = sceneLayouts;
      } else {
        delete next.scene_layouts;
      }
      if (renderPlan && renderPlan.mode === "segmented") {
        const sbRevision = state.storyboard && Number.isInteger(state.storyboard.revision_count)
          ? state.storyboard.revision_count
          : null;
        next.render_plan = { ...renderPlan, derived_at: ts, storyboard_revision: sbRevision };
      } else {
        // The plan resolved to a single continuous render — drop any stale
        // segmented machinery from a prior storyboard shape so gates and the
        // summary never reason from a dead plan.
        delete next.render_plan;
        delete next.segment_renders;
        delete next.assembly;
      }
    }
    const archiveEvents = archive
      ? [{
          kind: "iteration_archived",
          at: ts,
          archive_version: archive.record.version,
          paths: archive.record.paths,
        }]
      : [];
    const clipEvents = transcodedClips
      ? [{
          kind: "scene_clips_materialized",
          at: ts,
          audio_treatment: transcodedClips.audio_treatment,
          summary: transcodedClips.summary,
        }]
      : [];
    const matteEvents = subjectMattes && subjectMattes.summary && subjectMattes.summary.total > 0
      ? [{
          kind: "subject_mattes_materialized",
          at: ts,
          device: subjectMattes.device,
          backend_available: subjectMattes.backend_available,
          over_budget: subjectMattes.over_budget,
          summary: subjectMattes.summary,
        }]
      : [];
    const layoutEvents = sceneLayouts && sceneLayouts.summary && sceneLayouts.summary.total > 0
      ? [{
          kind: "scene_layouts_materialized",
          at: ts,
          summary: sceneLayouts.summary,
        }]
      : [];
    const renderPlanEvents = renderPlan && renderPlan.mode === "segmented"
      ? [{
          kind: "render_plan_derived",
          at: ts,
          segmentation: renderPlan.segmentation,
          segment_count: renderPlan.segments.length,
          segment_ids: renderPlan.segments.map((s) => s.segment_id),
        }]
      : [];
    next.history = [
      ...(Array.isArray(state.history) ? state.history : []),
      ...archiveEvents,
      ...clipEvents,
      ...matteEvents,
      ...layoutEvents,
      ...renderPlanEvents,
      {
        kind: "transition",
        from,
        to: toPhase,
        at: ts,
        override_reason: overrideReason,
        gate_blockers: blockers.length ? blockers : null,
      },
    ];
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);
    // Lean return (D1): no full state echo, no duplicated transcoded_clips —
    // the full materialization document persists in next.transcoded_clips.
    return {
      project_id: id,
      from,
      to: toPhase,
      override_reason: overrideReason,
      archived: archive ? archive.record : null,
      clips: transcodedClips ? clipsDigest(id, transcodedClips) : null,
      phase_summary: buildStateSummary(next, id),
    };
  });
}

module.exports = {
  ALLOWED_TRANSITIONS,
  buildInitialSessionState,
  buildStateSummary,
  initProject,
  readInspectSummaryIfPresent,
  readSessionStateStrict,
  readState,
  readStateSummary,
  transitionPhase,
};
